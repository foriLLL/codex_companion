import { createFile } from "mp4box";
import { EmbyError } from "./emby-client.mjs";

// 2MB 与两侧 Range 上限（Emby DEFAULT_DIRECT_RANGE_LIMIT、红果 HONGGUO_RESOURCE_LIMIT）
// 对齐：高延迟链路填充速率翻倍（原 1MB/RTT 追不上高码率播放，周期性 waiting），
// MAX_PULL_READS=4 × 2MB = 8MB 正好对齐 DIRECT_MP4_MAX_BATCH_BYTES。
export const DIRECT_MP4_CHUNK_BYTES = 2 * 1024 * 1024;
export const DIRECT_MP4_SEGMENT_BYTES = 4 * 1024 * 1024;
export const DIRECT_MP4_MAX_BATCH_BYTES = 8 * 1024 * 1024;
const DEFAULT_SEGMENT_SECONDS = 2;
const MAX_METADATA_READS = 16;
const MAX_PULL_READS = 4;

function asMp4Buffer(bytes, fileStart) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const buffer = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
  buffer.fileStart = fileStart;
  return buffer;
}

function asBase64(buffer) {
  return Buffer.from(buffer).toString("base64");
}

function samplesPerSegment(track, seconds) {
  const durationSeconds = Number(track.duration) / Number(track.timescale);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 1;
  const samplesPerSecond = Number(track.nb_samples) / durationSeconds;
  return Math.max(1, Math.round(samplesPerSecond * seconds));
}

function cancelled(cause) {
  return new EmbyError("CANCELLED", "直连媒体读取已取消", { cause });
}

export class DirectMp4Session {
  #readRange;
  #createFile;
  #chunkSize;
  #segmentSizeBytes;
  #maxBatchBytes;
  #segmentSeconds;
  #file = null;
  #info = null;
  #tracks = [];
  #segments = [];
  #nextOffset = 0;
  #total = null;
  #resolvedUrl = null;
  #ready = false;
  #ended = false;
  #flushed = false;
  #destroyed = false;
  #generation = 0;
  #pulling = false;
  #readController = null;

  constructor({
    readRange,
    createFileImpl = createFile,
    chunkSize = DIRECT_MP4_CHUNK_BYTES,
    segmentSizeBytes = DIRECT_MP4_SEGMENT_BYTES,
    maxBatchBytes = DIRECT_MP4_MAX_BATCH_BYTES,
    segmentSeconds = DEFAULT_SEGMENT_SECONDS
  } = {}) {
    if (typeof readRange !== "function") throw new TypeError("readRange 必须是函数");
    if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) throw new TypeError("chunkSize 必须是正整数");
    if (!Number.isSafeInteger(segmentSizeBytes) || segmentSizeBytes <= 0) {
      throw new TypeError("segmentSizeBytes 必须是正整数");
    }
    if (!Number.isSafeInteger(maxBatchBytes) || maxBatchBytes <= 0) {
      throw new TypeError("maxBatchBytes 必须是正整数");
    }
    this.#readRange = readRange;
    this.#createFile = createFileImpl;
    this.#chunkSize = chunkSize;
    this.#segmentSizeBytes = segmentSizeBytes;
    this.#maxBatchBytes = maxBatchBytes;
    this.#segmentSeconds = segmentSeconds;
  }

  async initialize({ startTimeSeconds = 0, signal } = {}) {
    this.#assertAlive();
    if (this.#ready) return this.#initializationDto(Number(startTimeSeconds) || 0);

    const file = this.#createFile(false);
    this.#file = file;
    file.onReady = (info) => {
      this.#info = info;
    };
    file.onError = (...parts) => {
      const message = parts.filter(Boolean).join(": ") || "MP4 解析失败";
      throw new EmbyError("MP4_PARSE_ERROR", message);
    };
    file.onSegment = (trackId, _user, buffer, sampleNumber, last) => {
      if (this.#destroyed) return;
      const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
      const completeBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      this.#segments.push({
        trackId: 0,
        sourceTrackId: trackId,
        buffer: completeBuffer,
        sampleNumber,
        last: Boolean(last)
      });
    };

    let offset = 0;
    for (let reads = 0; reads < MAX_METADATA_READS && !this.#info; reads += 1) {
      const result = await this.#read(offset, signal);
      this.#rememberRange(result);
      if (result.bytes.byteLength === 0) break;
      const suggested = file.appendBuffer(asMp4Buffer(result.bytes, result.start));
      offset = this.#nextRangeOffset(suggested, result);
      if (this.#total !== null && offset >= this.#total && !this.#info) break;
    }
    if (!this.#info) {
      throw new EmbyError("MP4_METADATA_UNAVAILABLE", "无法读取 MP4 元数据，文件可能不完整或格式不受支持");
    }

    const playableTracks = this.#info.tracks.filter((track) => track.type === "video" || track.type === "audio");
    if (!playableTracks.some((track) => track.type === "video")) {
      throw new EmbyError("MP4_VIDEO_TRACK_MISSING", "媒体中没有可播放的视频轨道");
    }
    const codecs = playableTracks.map((track) => track.codec);
    this.#tracks = [{
      id: 0,
      type: "combined",
      codec: codecs.join(","),
      mime: `video/mp4; codecs="${codecs.join(",")}"`
    }];
    const referenceTrack = playableTracks.find((track) => track.type === "video") ?? playableTracks[0];
    const sharedSegmentSamples = samplesPerSegment(referenceTrack, this.#segmentSeconds);
    for (const track of playableTracks) {
      file.setSegmentOptions(track.id, track.id, {
        nbSamples: sharedSegmentSamples,
        sizePerSegment: this.#segmentSizeBytes,
        // seek() 已负责从关键帧开始；后续分片按样本边界切开即可，避免大 GOP 突破 RPC 上限。
        rapAlignement: false
      });
    }
    const initialization = file.initializeSegmentation();
    if (!initialization?.buffer) throw new EmbyError("MP4_INIT_ERROR", "MP4 缺少合并初始化数据");
    this.#tracks[0].initData = asBase64(initialization.buffer);

    const requestedSeconds = Math.max(0, Number(startTimeSeconds) || 0);
    const seek = file.seek(requestedSeconds, true);
    this.#nextOffset = Number.isSafeInteger(seek?.offset) ? seek.offset : offset;
    file.start();
    this.#ready = true;
    return this.#initializationDto(Number(seek?.time) || 0);
  }

  async next({ signal } = {}) {
    this.#assertReady();
    if (this.#pulling) {
      throw new EmbyError("DIRECT_PULL_BUSY", "上一个媒体分片仍在读取", { retryable: true });
    }
    this.#pulling = true;
    const generation = this.#generation;
    try {
      for (let reads = 0; this.#segments.length === 0 && !this.#ended && reads < MAX_PULL_READS; reads += 1) {
        if (this.#total !== null && this.#nextOffset >= this.#total) {
          this.#flush();
          break;
        }
        const result = await this.#read(this.#nextOffset, signal);
        if (generation !== this.#generation) throw cancelled();
        this.#rememberRange(result);
        if (result.bytes.byteLength === 0) {
          this.#flush();
          break;
        }
        const suggested = this.#file.appendBuffer(
          asMp4Buffer(result.bytes, result.start),
          this.#total !== null && result.end + 1 >= this.#total
        );
        this.#nextOffset = this.#nextRangeOffset(suggested, result);
        if (this.#total !== null && this.#nextOffset >= this.#total) this.#flush();
      }

      const pending = [];
      let batchBytes = 0;
      while (this.#segments.length > 0) {
        const segment = this.#segments[0];
        const segmentBytes = Number(segment.buffer?.byteLength) || 0;
        if (segmentBytes > this.#maxBatchBytes) {
          throw new EmbyError("DIRECT_SEGMENT_TOO_LARGE", "完整媒体分片超过安全传输大小");
        }
        if (pending.length > 0 && batchBytes + segmentBytes > this.#maxBatchBytes) break;
        pending.push(this.#segments.shift());
        batchBytes += segmentBytes;
      }
      const segments = pending.map((segment) => {
        const dto = {
          trackId: segment.trackId,
          data: asBase64(segment.buffer),
          sampleNumber: segment.sampleNumber,
          last: segment.last
        };
        this.#file.releaseUsedSamples(segment.sourceTrackId, segment.sampleNumber);
        return dto;
      });
      return { segments, end: this.#ended && this.#segments.length === 0 };
    } finally {
      this.#pulling = false;
    }
  }

  seek(seconds) {
    this.#assertReady();
    const requested = Math.max(0, Number(seconds) || 0);
    this.#generation += 1;
    this.#readController?.abort(cancelled());
    this.#segments.length = 0;
    this.#ended = false;
    this.#flushed = false;
    this.#file.stop();
    const result = this.#file.seek(requested, true);
    this.#nextOffset = Number.isSafeInteger(result?.offset) ? result.offset : 0;
    this.#file.start();
    return {
      timeSeconds: Number(result?.time) || 0,
      offset: this.#nextOffset
    };
  }

  destroy() {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#generation += 1;
    this.#readController?.abort(cancelled());
    this.#readController = null;
    this.#segments.length = 0;
    try {
      this.#file?.stop();
    } catch {}
    this.#file = null;
  }

  async #read(start, signal) {
    this.#assertAlive();
    if (!Number.isSafeInteger(start) || start < 0) {
      throw new EmbyError("MP4_INVALID_OFFSET", "MP4 解析器返回了无效的媒体偏移量");
    }
    const controller = new AbortController();
    this.#readController = controller;
    const abort = () => controller.abort(signal?.reason ?? cancelled());
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    try {
      const boundedEnd = this.#total === null
        ? start + this.#chunkSize - 1
        : Math.min(this.#total - 1, start + this.#chunkSize - 1);
      if (boundedEnd < start) return { bytes: new Uint8Array(), start, end: start - 1, total: this.#total };
      return await this.#readRange({
        start,
        end: boundedEnd,
        resolvedUrl: this.#resolvedUrl,
        signal: controller.signal
      });
    } catch (error) {
      if (controller.signal.aborted && error?.code !== "CANCELLED") throw cancelled(error);
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
      if (this.#readController === controller) this.#readController = null;
    }
  }

  #rememberRange(result) {
    if (!(result?.bytes instanceof Uint8Array)) {
      throw new EmbyError("INVALID_RANGE_RESPONSE", "媒体 Range 没有返回二进制数据");
    }
    if (Number.isSafeInteger(result.total) && result.total >= 0) this.#total = result.total;
    if (typeof result.resolvedUrl === "string" && result.resolvedUrl) this.#resolvedUrl = result.resolvedUrl;
  }

  #nextRangeOffset(suggested, result) {
    const fallback = result.end + 1;
    const next = Number.isSafeInteger(suggested) && suggested >= 0 ? suggested : fallback;
    if (next <= result.start && fallback > result.start) return fallback;
    return next;
  }

  #flush() {
    if (this.#flushed) return;
    this.#flushed = true;
    this.#file.flush();
    this.#ended = true;
  }

  #initializationDto(startTimeSeconds) {
    const durationSeconds = Number(this.#info?.duration) / Number(this.#info?.timescale);
    return {
      durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : null,
      startTimeSeconds,
      tracks: this.#tracks.map(({ id, type, codec, mime, initData }) => ({
        id,
        type,
        codec,
        mime,
        initData
      }))
    };
  }

  #assertAlive() {
    if (this.#destroyed) throw new EmbyError("PLAYBACK_NOT_FOUND", "直连播放会话已经结束");
  }

  #assertReady() {
    this.#assertAlive();
    if (!this.#ready) throw new EmbyError("DIRECT_NOT_INITIALIZED", "直连播放器尚未初始化");
  }
}
