import { createFile } from "mp4box";
import { EmbyError } from "./emby-client.mjs";

// 2MB 与两侧 Range 上限（Emby DEFAULT_DIRECT_RANGE_LIMIT、红果 HONGGUO_RESOURCE_LIMIT）
// 对齐；普通分片每次 RPC 仍最多 8MB。异常媒体仍可能产生更大的完整分片，允许
// 单片最多 48MB，并在 RPC 边界上拆成连续字节块传输。
export const DIRECT_MP4_CHUNK_BYTES = 2 * 1024 * 1024;
// 单个完整 moof+mdat 控制在约 1 MiB：Chromium 的 SourceBuffer 在高码率长视频
// 接近配额时，能释放出的空间可能小于 4 MiB；大分片会在旧数据已清理后仍被
// QuotaExceeded 拒绝。RPC 仍可把多个小分片合成 8 MiB 批次，不增加网络往返。
export const DIRECT_MP4_SEGMENT_BYTES = 1024 * 1024;
export const DIRECT_MP4_MAX_BATCH_BYTES = 8 * 1024 * 1024;
export const DIRECT_MP4_MAX_SEGMENT_BYTES = 48 * 1024 * 1024;
export const DIRECT_MP4_MAX_QUEUE_BYTES = 96 * 1024 * 1024;
const DEFAULT_SEGMENT_SECONDS = 2;
const MAX_METADATA_READS = 16;
const MAX_PULL_READS = 4;
const MAX_STREAM_RETRIES_WITHOUT_PROGRESS = 2;

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

function keyframeMetadata(file, track) {
  const timescale = Number(track?.timescale);
  const duration = Number(track?.duration);
  const samples = file?.getTrackById?.(track?.id)?.samples;
  if (!Number.isFinite(timescale) || timescale <= 0 || !Array.isArray(samples) || samples.length === 0) {
    return { maximumIntervalSeconds: null, timesSeconds: [] };
  }
  const syncTimes = samples
    .filter((sample) => sample?.is_sync)
    .map((sample) => Number(sample.cts ?? sample.dts) / timescale)
    .filter((time) => Number.isFinite(time) && time >= 0)
    .sort((left, right) => left - right);
  if (syncTimes.length === 0) return { maximumIntervalSeconds: null, timesSeconds: [] };
  const durationSeconds = duration / timescale;
  let maximum = syncTimes[0];
  for (let index = 1; index < syncTimes.length; index += 1) {
    maximum = Math.max(maximum, syncTimes[index] - syncTimes[index - 1]);
  }
  if (Number.isFinite(durationSeconds) && durationSeconds > syncTimes.at(-1)) {
    maximum = Math.max(maximum, durationSeconds - syncTimes.at(-1));
  }
  return {
    maximumIntervalSeconds: Number.isFinite(maximum) && maximum > 0 ? maximum : null,
    timesSeconds: syncTimes
  };
}

function cancelled(cause) {
  return new EmbyError("CANCELLED", "直连媒体读取已取消", { cause });
}

export class DirectMp4Session {
  #readRange;
  #openRangeStream;
  #createFile;
  #chunkSize;
  #segmentSizeBytes;
  #maxBatchBytes;
  #maxSegmentBytes;
  #maxQueueBytes;
  #resumeQueueBytes;
  #segmentSeconds;
  #file = null;
  #info = null;
  #tracks = [];
  #keyframeIntervalSeconds = null;
  #keyframeTimesSeconds = [];
  #segments = [];
  #queueBytes = 0;
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
  #streamController = null;
  #activeStream = null;
  #pumpPromise = null;
  #pumpGeneration = -1;
  #pumpFailure = null;
  #longStreamDisabled = false;
  #dataWaiters = new Set();
  #spaceWaiters = new Set();

  constructor({
    readRange,
    openRangeStream = null,
    createFileImpl = createFile,
    chunkSize = DIRECT_MP4_CHUNK_BYTES,
    segmentSizeBytes = DIRECT_MP4_SEGMENT_BYTES,
    maxBatchBytes = DIRECT_MP4_MAX_BATCH_BYTES,
    maxSegmentBytes = DIRECT_MP4_MAX_SEGMENT_BYTES,
    maxQueueBytes = DIRECT_MP4_MAX_QUEUE_BYTES,
    resumeQueueBytes = Math.floor(maxQueueBytes / 2),
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
    if (!Number.isSafeInteger(maxSegmentBytes) || maxSegmentBytes < maxBatchBytes) {
      throw new TypeError("maxSegmentBytes 必须是不小于 maxBatchBytes 的正整数");
    }
    if (openRangeStream !== null && typeof openRangeStream !== "function") {
      throw new TypeError("openRangeStream 必须是函数或 null");
    }
    if (!Number.isSafeInteger(maxQueueBytes) || maxQueueBytes < maxBatchBytes) {
      throw new TypeError("maxQueueBytes 必须是不小于 maxBatchBytes 的正整数");
    }
    if (!Number.isSafeInteger(resumeQueueBytes) || resumeQueueBytes < 0 || resumeQueueBytes >= maxQueueBytes) {
      throw new TypeError("resumeQueueBytes 必须是小于 maxQueueBytes 的非负整数");
    }
    this.#readRange = readRange;
    this.#openRangeStream = openRangeStream;
    this.#createFile = createFileImpl;
    this.#chunkSize = chunkSize;
    this.#segmentSizeBytes = segmentSizeBytes;
    this.#maxBatchBytes = maxBatchBytes;
    this.#maxSegmentBytes = maxSegmentBytes;
    this.#maxQueueBytes = maxQueueBytes;
    this.#resumeQueueBytes = resumeQueueBytes;
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
      this.#pumpFailure = new EmbyError("MP4_PARSE_ERROR", message);
      this.#streamController?.abort(this.#pumpFailure);
      this.#notifyData();
    };
    file.onSegment = (trackId, _user, buffer, sampleNumber, last) => {
      if (this.#destroyed) return;
      const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
      const completeBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      this.#segments.push({
        trackId: 0,
        sourceTrackId: trackId,
        buffer: completeBuffer,
        offset: 0,
        sampleNumber,
        last: Boolean(last)
      });
      this.#queueBytes += completeBuffer.byteLength;
      this.#notifyData();
    };

    let offset = 0;
    for (let reads = 0; reads < MAX_METADATA_READS && !this.#info; reads += 1) {
      const result = await this.#read(offset, signal);
      this.#rememberRange(result);
      if (result.bytes.byteLength === 0) break;
      const suggested = file.appendBuffer(asMp4Buffer(result.bytes, result.start));
      if (this.#pumpFailure) throw this.#pumpFailure;
      offset = this.#nextRangeOffset(suggested, result);
      if (this.#total !== null && offset >= this.#total && !this.#info) break;
    }
    if (!this.#info) {
      if (this.#pumpFailure) throw this.#pumpFailure;
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
    const keyframes = keyframeMetadata(file, referenceTrack);
    this.#keyframeIntervalSeconds = keyframes.maximumIntervalSeconds;
    this.#keyframeTimesSeconds = keyframes.timesSeconds;
    const sharedSegmentSamples = samplesPerSegment(referenceTrack, this.#segmentSeconds);
    for (const track of playableTracks) {
      file.setSegmentOptions(track.id, track.id, {
        nbSamples: sharedSegmentSamples,
        sizePerSegment: this.#segmentSizeBytes,
        // 关键帧可能相隔 6 秒以上，高码率源按 RAP 强制对齐会产生 30MB+ 单片，
        // 超过当前 Renderer 的 MSE 瞬时配额。保持小分片；初始化 DTO 同时返回真实
        // 最大 GOP 间隔，Renderer 清理时保留完整依赖链，避免删到当前 GOP。
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
      if (this.#usesLongStream()) {
        this.#ensureLongStreamPump(generation);
        while (
          generation === this.#generation
          && this.#usesLongStream()
          && this.#segments.length === 0
          && !this.#ended
          && !this.#pumpFailure
        ) {
          await this.#waitForData(signal);
        }
      }
      if (generation !== this.#generation) throw cancelled();
      if (!this.#usesLongStream() && this.#segments.length === 0 && !this.#ended) {
        await this.#pullChunked(generation, signal);
      }
      if (this.#segments.length === 0 && this.#pumpFailure) throw this.#pumpFailure;
      const segments = this.#takeSegments();
      return { segments, end: this.#ended && this.#segments.length === 0 };
    } finally {
      this.#pulling = false;
    }
  }

  async seek(seconds) {
    this.#assertReady();
    const requested = Math.max(0, Number(seconds) || 0);
    this.#generation += 1;
    this.#readController?.abort(cancelled());
    // 部分 CDN 同一签名 URL 不允许旧、新两个持续 Range 短暂并存。abort 只发出
    // 取消信号；必须等 body/cancel 真正收尾后再打开 seek 后的新流，否则新请求会
    // 被上游连带取消，Renderer 看到“请求已取消”。
    const stopped = this.#stopLongStream();
    this.#discardSegments();
    await stopped;
    this.#assertAlive();
    this.#ended = false;
    this.#flushed = false;
    this.#pumpFailure = null;
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
    void this.#stopLongStream();
    this.#discardSegments();
    this.#notifyData();
    this.#notifySpace();
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

  #usesLongStream() {
    return typeof this.#openRangeStream === "function" && !this.#longStreamDisabled;
  }

  #ensureLongStreamPump(generation) {
    if (!this.#usesLongStream()) return;
    if (this.#pumpPromise && this.#pumpGeneration === generation) return;
    this.#pumpGeneration = generation;
    const pump = this.#pumpLongStream(generation).catch((error) => {
      if (this.#destroyed || generation !== this.#generation || ["CANCELLED", "ABORTED"].includes(error?.code)) {
        return;
      }
      // 少数服务器声称支持 Range，却拒绝开放式 bytes=N-。保留原有有限 Range
      // 通道作为兼容回退，不能因为体验优化让原本能播的媒体失效。
      if (error?.code === "RANGE_UNSUPPORTED") {
        this.#longStreamDisabled = true;
      } else {
        this.#pumpFailure = error instanceof Error
          ? error
          : new EmbyError("MEDIA_STREAM_FAILED", "持续媒体流读取失败", { cause: error });
      }
      this.#notifyData();
    }).finally(() => {
      if (this.#pumpPromise === pump) this.#pumpPromise = null;
    });
    this.#pumpPromise = pump;
  }

  async #pumpLongStream(generation) {
    let retriesWithoutProgress = 0;
    while (!this.#destroyed && generation === this.#generation && !this.#ended && !this.#pumpFailure) {
      if (this.#total !== null && this.#nextOffset >= this.#total) {
        this.#flush();
        return;
      }
      await this.#waitForQueueSpace(generation);
      if (this.#destroyed || generation !== this.#generation) throw cancelled();

      const controller = new AbortController();
      this.#streamController = controller;
      let stream = null;
      let received = 0;
      let reopenAtSuggestedOffset = false;
      let streamError = null;
      try {
        stream = await this.#openRangeStream({
          start: this.#nextOffset,
          end: null,
          resolvedUrl: this.#resolvedUrl,
          signal: controller.signal
        });
        if (this.#destroyed || generation !== this.#generation) throw cancelled();
        if (
          !stream
          || stream.start !== this.#nextOffset
          || !Number.isSafeInteger(stream.end)
          || stream.end < stream.start
          || !stream.body
          || typeof stream.body[Symbol.asyncIterator] !== "function"
        ) {
          throw new EmbyError("INVALID_RANGE_RESPONSE", "持续媒体流返回了无效的 Range");
        }
        this.#activeStream = stream;
        this.#rememberStream(stream);

        for await (const chunkValue of stream.body) {
          if (controller.signal.aborted || this.#destroyed || generation !== this.#generation) {
            throw controller.signal.reason ?? cancelled();
          }
          const chunk = chunkValue instanceof Uint8Array ? chunkValue : new Uint8Array(chunkValue);
          if (chunk.byteLength === 0) continue;
          const start = this.#nextOffset;
          const end = start + chunk.byteLength - 1;
          if (end > stream.end || (this.#total !== null && end >= this.#total)) {
            throw new EmbyError("INVALID_RANGE_RESPONSE", "持续媒体流返回了超出声明范围的数据");
          }
          const result = { start, end };
          const suggested = this.#file.appendBuffer(
            asMp4Buffer(chunk, start),
            this.#total !== null && end + 1 >= this.#total
          );
          received += chunk.byteLength;
          const sequentialOffset = end + 1;
          const nextOffset = this.#nextRangeOffset(suggested, result);
          this.#nextOffset = nextOffset;
          if (this.#total !== null && nextOffset >= this.#total) {
            this.#flush();
            return;
          }
          if (nextOffset !== sequentialOffset) {
            reopenAtSuggestedOffset = true;
            break;
          }
          if (this.#queueBytes >= this.#maxQueueBytes) {
            await this.#waitForQueueSpace(generation);
          }
        }
      } catch (error) {
        streamError = error;
      } finally {
        if (this.#streamController === controller) this.#streamController = null;
        if (this.#activeStream === stream) this.#activeStream = null;
        await stream?.cancel?.(streamError ?? cancelled()).catch(() => {});
      }

      if (this.#destroyed || generation !== this.#generation) throw cancelled(streamError);
      if (streamError) {
        if (this.#pumpFailure) throw this.#pumpFailure;
        if (streamError?.code === "RANGE_UNSUPPORTED") throw streamError;
        if (received > 0) retriesWithoutProgress = 0;
        else if (++retriesWithoutProgress > MAX_STREAM_RETRIES_WITHOUT_PROGRESS) throw streamError;
        continue;
      }
      if (reopenAtSuggestedOffset) {
        retriesWithoutProgress = 0;
        continue;
      }
      if (this.#nextOffset > stream.end) {
        if (this.#total === null || this.#nextOffset >= this.#total) {
          this.#flush();
          return;
        }
        retriesWithoutProgress = 0;
        continue;
      }
      // 上游在 Content-Range 声明的末尾之前结束；从实际收到的位置续接。
      if (received > 0) retriesWithoutProgress = 0;
      else if (++retriesWithoutProgress > MAX_STREAM_RETRIES_WITHOUT_PROGRESS) {
        throw new EmbyError("MEDIA_STREAM_TRUNCATED", "媒体 CDN 流提前结束", { retryable: true });
      }
    }
  }

  async #pullChunked(generation, signal) {
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
      if (this.#pumpFailure) throw this.#pumpFailure;
      this.#nextOffset = this.#nextRangeOffset(suggested, result);
      if (this.#total !== null && this.#nextOffset >= this.#total) this.#flush();
    }
  }

  #takeSegments() {
    const pending = [];
    let batchBytes = 0;
    while (this.#segments.length > 0) {
      const segment = this.#segments[0];
      const completeBytes = Number(segment.buffer?.byteLength) || 0;
      if (completeBytes > this.#maxSegmentBytes) {
        throw new EmbyError("DIRECT_SEGMENT_TOO_LARGE", "完整媒体分片超过安全传输大小");
      }
      const offset = Number(segment.offset) || 0;
      const remaining = completeBytes - offset;
      const available = this.#maxBatchBytes - batchBytes;
      if (remaining <= 0) {
        this.#segments.shift();
        this.#file.releaseUsedSamples(segment.sourceTrackId, segment.sampleNumber);
        continue;
      }
      if (available <= 0) break;
      const chunkBytes = Math.min(remaining, available);
      const finalChunk = offset + chunkBytes >= completeBytes;
      const view = new Uint8Array(segment.buffer, offset, chunkBytes);
      pending.push({
        trackId: segment.trackId,
        data: asBase64(view),
        sampleNumber: segment.sampleNumber,
        segmentStart: offset === 0,
        segmentEnd: finalChunk,
        last: finalChunk && segment.last
      });
      segment.offset = offset + chunkBytes;
      this.#queueBytes -= chunkBytes;
      batchBytes += chunkBytes;
      if (finalChunk) {
        this.#segments.shift();
        this.#file.releaseUsedSamples(segment.sourceTrackId, segment.sampleNumber);
      }
    }
    if (this.#queueBytes <= this.#resumeQueueBytes) this.#notifySpace();
    return pending;
  }

  #discardSegments() {
    for (const segment of this.#segments) {
      try { this.#file?.releaseUsedSamples(segment.sourceTrackId, segment.sampleNumber); } catch {}
    }
    this.#segments.length = 0;
    this.#queueBytes = 0;
    this.#notifySpace();
  }

  #stopLongStream() {
    const reason = cancelled();
    const controller = this.#streamController;
    this.#streamController = null;
    controller?.abort(reason);
    const stream = this.#activeStream;
    this.#activeStream = null;
    this.#notifyData();
    this.#notifySpace();
    return Promise.resolve(stream?.cancel?.(reason)).catch(() => {});
  }

  #waitForData(signal) {
    if (this.#segments.length > 0 || this.#ended || this.#pumpFailure || !this.#usesLongStream()) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        this.#dataWaiters.delete(wake);
        signal?.removeEventListener("abort", abort);
      };
      const wake = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const abort = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(signal?.reason ?? cancelled());
      };
      this.#dataWaiters.add(wake);
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });
  }

  async #waitForQueueSpace(generation) {
    while (
      !this.#destroyed
      && generation === this.#generation
      && this.#queueBytes > this.#resumeQueueBytes
      && this.#queueBytes >= this.#maxQueueBytes
    ) {
      await new Promise((resolve) => this.#spaceWaiters.add(resolve));
    }
  }

  #notifyData() {
    const waiters = [...this.#dataWaiters];
    this.#dataWaiters.clear();
    for (const wake of waiters) wake();
  }

  #notifySpace() {
    const waiters = [...this.#spaceWaiters];
    this.#spaceWaiters.clear();
    for (const wake of waiters) wake();
  }

  #rememberRange(result) {
    if (!(result?.bytes instanceof Uint8Array)) {
      throw new EmbyError("INVALID_RANGE_RESPONSE", "媒体 Range 没有返回二进制数据");
    }
    if (Number.isSafeInteger(result.total) && result.total >= 0) this.#total = result.total;
    if (typeof result.resolvedUrl === "string" && result.resolvedUrl) this.#resolvedUrl = result.resolvedUrl;
  }

  #rememberStream(stream) {
    if (Number.isSafeInteger(stream.total) && stream.total >= 0) this.#total = stream.total;
    if (typeof stream.resolvedUrl === "string" && stream.resolvedUrl) this.#resolvedUrl = stream.resolvedUrl;
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
    this.#notifyData();
  }

  #initializationDto(startTimeSeconds) {
    const durationSeconds = Number(this.#info?.duration) / Number(this.#info?.timescale);
    const result = {
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
    if (Number.isFinite(this.#keyframeIntervalSeconds)) {
      result.keyframeIntervalSeconds = this.#keyframeIntervalSeconds;
    }
    if (this.#keyframeTimesSeconds.length > 0) {
      result.keyframeTimesSeconds = this.#keyframeTimesSeconds;
    }
    return result;
  }

  #assertAlive() {
    if (this.#destroyed) throw new EmbyError("PLAYBACK_NOT_FOUND", "直连播放会话已经结束");
  }

  #assertReady() {
    this.#assertAlive();
    if (!this.#ready) throw new EmbyError("DIRECT_NOT_INITIALIZED", "直连播放器尚未初始化");
  }
}
