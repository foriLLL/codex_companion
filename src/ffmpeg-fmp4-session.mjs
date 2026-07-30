import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveFfmpegPath } from "./ffmpeg-path.mjs";
import { EmbyError } from "./emby-client.mjs";

const RANGE_CHUNK_BYTES = 1024 * 1024;
const MAX_QUEUE_BYTES = 24 * 1024 * 1024;
const RESUME_QUEUE_BYTES = 12 * 1024 * 1024;
// 每次 next() 最多打包这么多字节的分片一起返回，减少 CDP 往返次数。
// 单个分片(frag_duration≈2s)可能几百 KB~数 MB，逐个往返会导致“播一下卡一下”。
const NEXT_BATCH_BYTES = 6 * 1024 * 1024;
const START_TIMEOUT_MS = 40_000;
const MAX_STDERR_BYTES = 8 * 1024;

function cancelled(cause) {
  return new EmbyError("CANCELLED", "FFmpeg 媒体处理已取消", { cause });
}

function asBase64(bytes) {
  return Buffer.from(bytes).toString("base64");
}

function parseRangeHeader(value) {
  if (!value) return { start: 0, end: null, partial: false };
  const match = /^bytes=(\d+)-(\d*)$/i.exec(String(value).trim());
  if (!match) throw new EmbyError("INVALID_RANGE", "FFmpeg 请求了无效的媒体 Range");
  const start = Number(match[1]);
  const end = match[2] === "" ? null : Number(match[2]);
  if (!Number.isSafeInteger(start) || start < 0 || (end !== null && (!Number.isSafeInteger(end) || end < start))) {
    throw new EmbyError("INVALID_RANGE", "FFmpeg 请求了无效的媒体 Range");
  }
  return { start, end, partial: true };
}

function readableStreamFrom(iterable) {
  const iterator = iterable[Symbol.asyncIterator]();
  return new ReadableStream({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await iterator.return?.(reason);
    }
  });
}

function boxSize(buffer) {
  if (buffer.length < 8) return null;
  const small = buffer.readUInt32BE(0);
  if (small === 0) return null;
  if (small !== 1) return small;
  if (buffer.length < 16) return null;
  const large = buffer.readBigUInt64BE(8);
  if (large > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new EmbyError("FFMPEG_OUTPUT_INVALID", "FFmpeg 输出了过大的 MP4 box");
  }
  return Number(large);
}

function codecFromInitialization(initialization, hasAudio) {
  const marker = Buffer.from("avcC");
  const offset = initialization.indexOf(marker);
  let video = "avc1.640028";
  if (offset >= 4 && offset + 8 <= initialization.length && initialization[offset + 4] === 1) {
    const profile = initialization[offset + 5].toString(16).padStart(2, "0");
    const compatibility = initialization[offset + 6].toString(16).padStart(2, "0");
    const level = initialization[offset + 7].toString(16).padStart(2, "0");
    video = `avc1.${profile}${compatibility}${level}`;
  }
  return hasAudio ? `${video},mp4a.40.2` : video;
}

class FragmentParser {
  constructor({ onInitialization, onSegment }) {
    this.buffer = Buffer.alloc(0);
    this.initialization = [];
    this.fragment = [];
    this.ready = false;
    this.onInitialization = onInitialization;
    this.onSegment = onSegment;
  }

  push(chunk) {
    if (!chunk?.length) return;
    this.buffer = this.buffer.length === 0
      ? Buffer.from(chunk)
      : Buffer.concat([this.buffer, chunk], this.buffer.length + chunk.length);
    while (this.buffer.length >= 8) {
      const size = boxSize(this.buffer);
      if (size === null || this.buffer.length < size) return;
      if (size < 8) throw new EmbyError("FFMPEG_OUTPUT_INVALID", "FFmpeg 输出了无效的 MP4 box");
      const box = Buffer.from(this.buffer.subarray(0, size));
      this.buffer = this.buffer.subarray(size);
      const type = box.toString("ascii", 4, 8);
      if (!this.ready) {
        this.initialization.push(box);
        if (type === "moov") {
          this.ready = true;
          const initialization = Buffer.concat(this.initialization);
          this.initialization.length = 0;
          this.onInitialization(initialization);
        }
        continue;
      }
      this.fragment.push(box);
      if (type === "mdat") {
        const fragment = Buffer.concat(this.fragment);
        this.fragment.length = 0;
        this.onSegment(fragment);
      }
    }
  }
}

export class RangeProxy {
  constructor({ readRange = null, openRangeStream = null, onError, randomUUIDImpl = randomUUID }) {
    if (typeof readRange !== "function" && typeof openRangeStream !== "function") {
      throw new TypeError("readRange 或 openRangeStream 必须至少提供一个");
    }
    this.readRange = readRange;
    this.openRangeStream = openRangeStream;
    this.onError = onError;
    this.secretPath = `/media/${randomUUIDImpl()}`;
    this.server = null;
    this.serverRuntime = null;
    this.url = null;
    this.controllers = new Set();
  }

  async start() {
    if (this.server) return this.url;
    // Bun 对 node:http ServerResponse 的大文件持续写入存在字节偏移：同一 MKV
    // 在 Node 下 FFmpeg 从 4372 继续解析，在 Bun 下会从 4369 继续，导致 Cues
    // 失效并顺序扫描整部文件。发布二进制运行在 Bun，必须使用原生 Bun.serve。
    if (process.versions?.bun && typeof globalThis.Bun?.serve === "function") {
      const server = globalThis.Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        idleTimeout: 60,
        fetch: (request, activeServer) => this.#handleBun(request, activeServer),
        error: (error) => {
          this.onError?.(error);
          return new Response(null, { status: 502 });
        }
      });
      this.server = server;
      this.serverRuntime = "bun";
      this.url = `http://127.0.0.1:${server.port}${this.secretPath}`;
      return this.url;
    }
    const server = createServer((request, response) => {
      void this.#handle(request, response);
    });
    server.on("clientError", (_error, socket) => socket.destroy());
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new EmbyError("FFMPEG_PROXY_FAILED", "无法启动 FFmpeg 本机媒体桥");
    }
    this.server = server;
    this.serverRuntime = "node";
    this.url = `http://127.0.0.1:${address.port}${this.secretPath}`;
    return this.url;
  }

  async close() {
    for (const controller of this.controllers) controller.abort(cancelled());
    this.controllers.clear();
    const server = this.server;
    this.server = null;
    this.serverRuntime = null;
    this.url = null;
    if (!server) return;
    if (typeof server.stop === "function") {
      server.stop(true);
      return;
    }
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections?.();
    });
  }

  async #handle(request, response) {
    const controller = new AbortController();
    this.controllers.add(controller);
    const abort = () => controller.abort(cancelled());
    request.once("aborted", abort);
    response.once("close", () => {
      if (!response.writableEnded) abort();
    });
    try {
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      if (requestUrl.pathname !== this.secretPath || !["GET", "HEAD"].includes(request.method ?? "")) {
        response.writeHead(404).end();
        return;
      }
      const requested = parseRangeHeader(request.headers.range);
      if (this.openRangeStream) {
        await this.#pipeRangeStream(request, response, requested, controller.signal);
        return;
      }
      const firstEnd = requested.end === null
        ? requested.start + RANGE_CHUNK_BYTES - 1
        : Math.min(requested.end, requested.start + RANGE_CHUNK_BYTES - 1);
      const first = await this.readRange({
        start: requested.start,
        end: firstEnd,
        signal: controller.signal
      });
      const total = Number.isSafeInteger(first.total) ? first.total : null;
      const finalEnd = requested.end === null
        ? (total === null ? null : total - 1)
        : (total === null ? requested.end : Math.min(requested.end, total - 1));
      const headers = {
        "Accept-Ranges": "bytes",
        "Content-Type": first.contentType || "application/octet-stream",
        "Cache-Control": "no-store"
      };
      if (requested.partial && total !== null && finalEnd !== null) {
        headers["Content-Range"] = `bytes ${requested.start}-${finalEnd}/${total}`;
        headers["Content-Length"] = String(Math.max(0, finalEnd - requested.start + 1));
      } else if (!requested.partial && total !== null) {
        headers["Content-Length"] = String(total);
      }
      response.writeHead(requested.partial ? 206 : 200, headers);
      if (request.method === "HEAD") {
        response.end();
        return;
      }

      let result = first;
      let offset = requested.start;
      while (!controller.signal.aborted) {
        const bytes = result.bytes;
        if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) break;
        if (!response.write(Buffer.from(bytes))) await once(response, "drain");
        offset = result.end + 1;
        if (finalEnd !== null && offset > finalEnd) break;
        const nextEnd = finalEnd === null
          ? offset + RANGE_CHUNK_BYTES - 1
          : Math.min(finalEnd, offset + RANGE_CHUNK_BYTES - 1);
        result = await this.readRange({ start: offset, end: nextEnd, signal: controller.signal });
      }
      response.end();
    } catch (error) {
      if (!["CANCELLED", "ABORTED"].includes(error?.code)) this.onError?.(error);
      if (!response.headersSent) {
        response.writeHead(error?.code === "INVALID_RANGE" ? 416 : 502);
        response.end();
      } else {
        response.destroy(error instanceof Error ? error : undefined);
      }
    } finally {
      request.off("aborted", abort);
      this.controllers.delete(controller);
    }
  }

  async #handleBun(request, server) {
    const controller = new AbortController();
    this.controllers.add(controller);
    // Bun 的 Request.signal.reason 是 code=20 的 DOMException；统一包装成业务层
    // CANCELLED，FFmpeg 主动关闭旧 Range 以 seek 时不能把它升级成播放失败。
    const abort = () => controller.abort(cancelled(request.signal.reason));
    request.signal.addEventListener("abort", abort, { once: true });
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      request.signal.removeEventListener("abort", abort);
      this.controllers.delete(controller);
    };
    try {
      const requestUrl = new URL(request.url);
      if (requestUrl.pathname !== this.secretPath || !["GET", "HEAD"].includes(request.method)) {
        cleanup();
        return new Response(null, { status: 404 });
      }
      const requested = parseRangeHeader(request.headers.get("range"));
      // 播放器暂停或前端缓冲充足时，FFmpeg 会因 stdout 背压暂时停止读取输入。
      // Bun 的服务级 idleTimeout 也作用于流式响应；合法媒体请求必须允许长期静默，
      // 否则恢复播放时输入连接已经被关闭，FFmpeg 会把媒体误判为提前结束。
      server.timeout(request, 0);
      return this.openRangeStream
        ? await this.#bunStreamResponse(request, requested, controller.signal, cleanup)
        : await this.#bunChunkedResponse(request, requested, controller.signal, cleanup);
    } catch (error) {
      cleanup();
      if (!["CANCELLED", "ABORTED"].includes(error?.code)) this.onError?.(error);
      return new Response(null, { status: error?.code === "INVALID_RANGE" ? 416 : 502 });
    }
  }

  async #bunStreamResponse(request, requested, signal, cleanup) {
    const first = await this.openRangeStream({
      start: requested.start,
      end: request.method === "HEAD" ? requested.start : requested.end,
      signal
    });
    const total = Number.isSafeInteger(first.total) ? first.total : null;
    const finalEnd = requested.end === null
      ? (total === null ? null : total - 1)
      : (total === null ? requested.end : Math.min(requested.end, total - 1));
    const headers = {
      "Accept-Ranges": "bytes",
      "Content-Type": first.contentType || "application/octet-stream",
      "Cache-Control": "no-store"
    };
    if (requested.partial) {
      const responseEnd = finalEnd ?? first.end;
      headers["Content-Range"] = `bytes ${requested.start}-${responseEnd}/${total ?? "*"}`;
      if (Number.isSafeInteger(responseEnd)) {
        headers["Content-Length"] = String(Math.max(0, responseEnd - requested.start + 1));
      }
    } else if (total !== null) {
      headers["Content-Length"] = String(total);
    }
    if (request.method === "HEAD") {
      await first.cancel?.();
      cleanup();
      return new Response(null, { status: requested.partial ? 206 : 200, headers });
    }

    const owner = this;
    const body = readableStreamFrom((async function* () {
      let active = first;
      let offset = requested.start;
      let retries = 0;
      const cancelActive = async (reason) => {
        const current = active;
        active = null;
        await current?.cancel?.(reason);
      };
      try {
        while (!signal.aborted) {
          let received = 0;
          try {
            for await (const chunkValue of active.body) {
              if (signal.aborted) throw signal.reason ?? cancelled();
              let chunk = Buffer.from(chunkValue);
              if (finalEnd !== null) {
                const remaining = finalEnd - offset + 1;
                if (remaining <= 0) break;
                if (chunk.length > remaining) chunk = chunk.subarray(0, remaining);
              }
              if (chunk.length === 0) continue;
              offset += chunk.length;
              received += chunk.length;
              yield chunk;
              if (finalEnd !== null && offset > finalEnd) break;
            }
          } catch (error) {
            if (signal.aborted) throw cancelled(error);
            await cancelActive(error);
            if (received > 0) retries = 0;
            else if (++retries > 2) throw error;
            active = await owner.openRangeStream({ start: offset, end: finalEnd, signal });
            continue;
          }
          await cancelActive();
          if (finalEnd !== null && offset > finalEnd) return;
          if (received === 0) {
            throw new EmbyError("MEDIA_STREAM_TRUNCATED", "媒体 CDN 流提前结束", { retryable: true });
          }
          retries = 0;
          active = await owner.openRangeStream({ start: offset, end: finalEnd, signal });
        }
        throw signal.reason ?? cancelled();
      } catch (error) {
        if (!["CANCELLED", "ABORTED"].includes(error?.code)) owner.onError?.(error);
        throw error;
      } finally {
        await cancelActive();
        cleanup();
      }
    })());
    return new Response(body, { status: requested.partial ? 206 : 200, headers });
  }

  async #bunChunkedResponse(request, requested, signal, cleanup) {
    const firstEnd = requested.end === null
      ? requested.start + RANGE_CHUNK_BYTES - 1
      : Math.min(requested.end, requested.start + RANGE_CHUNK_BYTES - 1);
    const first = await this.readRange({ start: requested.start, end: firstEnd, signal });
    const total = Number.isSafeInteger(first.total) ? first.total : null;
    const finalEnd = requested.end === null
      ? (total === null ? null : total - 1)
      : (total === null ? requested.end : Math.min(requested.end, total - 1));
    const headers = {
      "Accept-Ranges": "bytes",
      "Content-Type": first.contentType || "application/octet-stream",
      "Cache-Control": "no-store"
    };
    if (requested.partial && total !== null && finalEnd !== null) {
      headers["Content-Range"] = `bytes ${requested.start}-${finalEnd}/${total}`;
      headers["Content-Length"] = String(Math.max(0, finalEnd - requested.start + 1));
    } else if (!requested.partial && total !== null) {
      headers["Content-Length"] = String(total);
    }
    if (request.method === "HEAD") {
      cleanup();
      return new Response(null, { status: requested.partial ? 206 : 200, headers });
    }

    const owner = this;
    const body = readableStreamFrom((async function* () {
      let result = first;
      let offset = requested.start;
      try {
        while (!signal.aborted) {
          const bytes = result.bytes;
          if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) return;
          yield Buffer.from(bytes);
          offset = result.end + 1;
          if (finalEnd !== null && offset > finalEnd) return;
          const nextEnd = finalEnd === null
            ? offset + RANGE_CHUNK_BYTES - 1
            : Math.min(finalEnd, offset + RANGE_CHUNK_BYTES - 1);
          result = await owner.readRange({ start: offset, end: nextEnd, signal });
        }
        throw signal.reason ?? cancelled();
      } catch (error) {
        if (!["CANCELLED", "ABORTED"].includes(error?.code)) owner.onError?.(error);
        throw error;
      } finally {
        cleanup();
      }
    })());
    return new Response(body, { status: requested.partial ? 206 : 200, headers });
  }

  async #pipeRangeStream(request, response, requested, signal) {
    let offset = requested.start;
    let finalEnd = requested.end;
    let total = null;
    let headersSent = false;
    let retries = 0;
    let active = null;

    const cancelActive = async (reason) => {
      if (!active) return;
      const current = active;
      active = null;
      await current.cancel?.(reason);
    };
    const writeHeaders = (stream) => {
      total = Number.isSafeInteger(stream.total) ? stream.total : null;
      if (finalEnd === null && total !== null) finalEnd = total - 1;
      const headers = {
        "Accept-Ranges": "bytes",
        "Content-Type": stream.contentType || "application/octet-stream",
        "Cache-Control": "no-store"
      };
      if (requested.partial) {
        const responseEnd = finalEnd ?? stream.end;
        headers["Content-Range"] = `bytes ${requested.start}-${responseEnd}/${total ?? "*"}`;
        if (Number.isSafeInteger(responseEnd)) {
          headers["Content-Length"] = String(Math.max(0, responseEnd - requested.start + 1));
        }
      } else if (total !== null) {
        headers["Content-Length"] = String(total);
      }
      response.writeHead(requested.partial ? 206 : 200, headers);
      headersSent = true;
    };

    try {
      while (!signal.aborted) {
        const streamEnd = request.method === "HEAD" ? offset : finalEnd;
        active = await this.openRangeStream({
          start: offset,
          end: streamEnd,
          signal
        });
        if (!headersSent) writeHeaders(active);
        if (request.method === "HEAD") {
          await cancelActive();
          response.end();
          return;
        }

        let received = 0;
        try {
          for await (const chunkValue of active.body) {
            if (signal.aborted) throw signal.reason ?? cancelled();
            let chunk = Buffer.from(chunkValue);
            if (finalEnd !== null) {
              const remaining = finalEnd - offset + 1;
              if (remaining <= 0) break;
              if (chunk.length > remaining) chunk = chunk.subarray(0, remaining);
            }
            if (chunk.length === 0) continue;
            if (!response.write(chunk)) await once(response, "drain");
            offset += chunk.length;
            received += chunk.length;
            if (finalEnd !== null && offset > finalEnd) break;
          }
        } catch (error) {
          if (signal.aborted) throw signal.reason ?? cancelled(error);
          await cancelActive(error);
          // 只有“毫无进展”的重连才消耗重试预算；只要本次断流前收到过数据，
          // 就说明链路仍在推进，重置预算，避免长视频在偶发抖动后被误判为耗尽重试而放弃。
          if (received > 0) {
            retries = 0;
          } else {
            retries += 1;
            if (retries > 2) throw error;
          }
          continue;
        }
        await cancelActive();

        if (finalEnd !== null && offset > finalEnd) {
          response.end();
          return;
        }
        if (received === 0) {
          throw new EmbyError("MEDIA_STREAM_TRUNCATED", "媒体 CDN 流提前结束", { retryable: true });
        }
        retries = 0;
      }
      throw signal.reason ?? cancelled();
    } finally {
      await cancelActive();
    }
  }
}

export function ffmpegStrategy(mediaSource, subtitleTrack = null) {
  const streams = Array.isArray(mediaSource?.MediaStreams) ? mediaSource.MediaStreams : [];
  const video = streams.find((stream) => String(stream?.Type).toLowerCase() === "video");
  const audio = streams.find((stream) => String(stream?.Type).toLowerCase() === "audio");
  const videoCodec = String(video?.Codec ?? "").toLowerCase();
  const audioCodec = String(audio?.Codec ?? "").toLowerCase();
  return {
    videoCodec,
    audioCodec,
    hasAudio: Boolean(audio),
    copyVideo: !subtitleTrack && (videoCodec === "h264" || videoCodec === "avc"),
    copyAudio: !audio || audioCodec === "aac"
  };
}

function videoStreamOf(mediaSource) {
  const streams = Array.isArray(mediaSource?.MediaStreams) ? mediaSource.MediaStreams : [];
  return streams.find((stream) => String(stream?.Type).toLowerCase() === "video") ?? null;
}

// 硬件编码器 h264_videotoolbox 不支持 libx264 的 CRF 恒定质量，必须给目标码率。
// 按分辨率分档，匹配源视频码率并钳制到 [floor, cap]；源码率未知时用档位 fallback。
// 单位 bits/sec（Emby MediaStream.BitRate 即 bps，-b:v 接受纯数字）。
const VIDEO_BITRATE_TIERS = [
  { maxHeight: 576,      floor: 1_500_000,  fallback: 2_500_000,  cap: 4_000_000 },
  { maxHeight: 720,      floor: 2_500_000,  fallback: 4_000_000,  cap: 6_000_000 },
  { maxHeight: 1080,     floor: 4_000_000,  fallback: 8_000_000,  cap: 12_000_000 },
  { maxHeight: 1440,     floor: 6_000_000,  fallback: 12_000_000, cap: 20_000_000 },
  { maxHeight: Infinity, floor: 10_000_000, fallback: 20_000_000, cap: 40_000_000 }
];

function bitrateTierFor(height) {
  const normalized = Number.isSafeInteger(height) && height > 0 ? height : 1080;
  return VIDEO_BITRATE_TIERS.find((tier) => normalized <= tier.maxHeight);
}

export function videoBitrateFor(mediaSource) {
  const video = videoStreamOf(mediaSource);
  const tier = bitrateTierFor(Number(video?.Height));
  const source = Number(video?.BitRate);
  if (!Number.isFinite(source) || source <= 0) return String(tier.fallback);
  return String(Math.min(tier.cap, Math.max(tier.floor, source)));
}

function subtitleExtension(codec) {
  const normalized = String(codec ?? "").toLowerCase();
  if (["ass", "ssa"].includes(normalized)) return "ass";
  if (["hdmv_pgs_subtitle", "pgs", "pgssub"].includes(normalized)) return "sup";
  if (["dvd_subtitle", "dvdsub", "vobsub"].includes(normalized)) return "sub";
  if (["dvb_subtitle", "dvbsub"].includes(normalized)) return "sub";
  return "sub";
}

function filterPath(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll(":", "\\:").replaceAll("'", "\\'");
}

export function buildFfmpegArguments({
  inputUrl,
  mediaSource,
  strategy,
  subtitleTrack = null,
  subtitleFile = null,
  startTimeSeconds = 0,
  hardwareVideo = false
}) {
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin"];
  const hardwareEncode = hardwareVideo && !strategy.copyVideo;
  const subtitleCodec = String(subtitleTrack?.codec ?? "").toLowerCase();
  const styledText = ["ass", "ssa"].includes(subtitleCodec);
  const needsDurationFix = ["dvb_subtitle", "dvbsub"].includes(subtitleCodec);
  const subtitleFromFile = Boolean(subtitleTrack && subtitleFile);
  const externalGraphicSubtitle = subtitleFromFile && !styledText;
  // -hwaccel 是输入 0 的输入选项，必须在第一个 -i 之前；只 push 一次 → 不作用于外挂字幕的第二个 -i。
  // 刻意不加 -hwaccel_output_format：让解码帧下载回系统内存，subtitles/overlay filter 与
  // -pix_fmt yuv420p（含 10-bit→8-bit）才能继续工作。
  if (hardwareEncode) args.push("-hwaccel", "videotoolbox");
  if (startTimeSeconds > 0) args.push("-ss", startTimeSeconds.toFixed(3));
  if (subtitleTrack && !subtitleTrack.isExternal && needsDurationFix) args.push("-fix_sub_duration");
  args.push("-i", inputUrl);
  if (externalGraphicSubtitle) {
    if (startTimeSeconds > 0) args.push("-ss", startTimeSeconds.toFixed(3));
    if (needsDurationFix) args.push("-fix_sub_duration");
    args.push("-i", subtitleFile);
  }

  if (subtitleTrack) {
    if (styledText) {
      const subtitleInput = subtitleFromFile ? subtitleFile : inputUrl;
      if (!subtitleInput) {
        throw new EmbyError("SUBTITLE_SOURCE_MISSING", "外挂字幕缺少可供 FFmpeg 使用的数据");
      }
      const subtitleStreams = (mediaSource?.MediaStreams ?? [])
        .filter((stream) => String(stream?.Type ?? "").toLowerCase() === "subtitle");
      const subtitleOrdinal = Math.max(
        0,
        subtitleStreams.findIndex((stream) => Number(stream?.Index) === subtitleTrack.index)
      );
      const streamOption = subtitleFromFile ? "" : `:si=${subtitleOrdinal}`;
      const shift = startTimeSeconds > 0 ? `setpts=PTS+${startTimeSeconds.toFixed(3)}/TB,` : "";
      const unshift = startTimeSeconds > 0 ? `,setpts=PTS-${startTimeSeconds.toFixed(3)}/TB` : "";
      args.push(
        "-filter_complex",
        `[0:v:0]${shift}subtitles=filename='${filterPath(subtitleInput)}'${streamOption}${unshift}[v]`,
        "-map", "[v]"
      );
    } else {
      const subtitleInput = externalGraphicSubtitle ? "1:s:0" : `0:${subtitleTrack.index}`;
      args.push(
        "-filter_complex",
        `[0:v:0][${subtitleInput}]overlay=eof_action=pass:shortest=0[v]`,
        "-map", "[v]"
      );
    }
  } else {
    args.push("-map", "0:v:0");
  }
  if (strategy.hasAudio) args.push("-map", "0:a:0");
  args.push("-sn", "-dn");
  if (strategy.copyVideo) {
    args.push("-c:v", "copy");
  } else if (hardwareEncode) {
    // 硬件 H.264 编码：CPU 占用比 libx264 低约 24×，避免转码跑不满实时导致缓冲 underrun。
    // -allow_sw true：无硬件编码器时 VideoToolbox 自带软件兜底，仍产出合法 fMP4。
    args.push(
      "-c:v", "h264_videotoolbox",
      "-b:v", videoBitrateFor(mediaSource),
      "-realtime", "true",
      "-allow_sw", "true",
      "-pix_fmt", "yuv420p"
    );
  } else {
    args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p");
  }
  if (!strategy.hasAudio) args.push("-an");
  else if (strategy.copyAudio) args.push("-c:a", "copy");
  else args.push("-c:a", "aac", "-b:a", "128k", "-ac", "2");
  args.push(
    "-movflags", "frag_keyframe+empty_moov+default_base_moof",
    "-frag_duration", "2000000",
    "-f", "mp4",
    "pipe:1"
  );
  return args;
}

export class FfmpegFmp4Session {
  constructor({
    readRange,
    openRangeStream = null,
    mediaSource,
    durationSeconds = null,
    subtitleTrack = null,
    subtitleData = null,
    ffmpegPathImpl = resolveFfmpegPath(),
    spawnImpl = spawn,
    randomUUIDImpl = randomUUID,
    platform = process.platform,
    env = process.env
  } = {}) {
    if (typeof readRange !== "function" && typeof openRangeStream !== "function") {
      throw new TypeError("readRange 或 openRangeStream 必须至少提供一个");
    }
    if (!ffmpegPathImpl) {
      throw new EmbyError(
        "FFMPEG_UNAVAILABLE",
        "未找到系统 FFmpeg；请运行 brew install ffmpeg，或设置 CODEX_COMPANION_FFMPEG"
      );
    }
    this.ffmpegPath = ffmpegPathImpl;
    this.spawnImpl = spawnImpl;
    this.mediaSource = mediaSource;
    this.subtitleTrack = subtitleTrack;
    this.subtitleData = subtitleData;
    this.strategy = ffmpegStrategy(mediaSource, subtitleTrack);
    // macOS 用 VideoToolbox 硬件编解码转码；CODEX_COMPANION_FORCE_SW_ENCODE 可强制回退软件。
    const forceSoftware = ["1", "true", "yes", "on"]
      .includes(String(env?.CODEX_COMPANION_FORCE_SW_ENCODE ?? "").trim().toLowerCase());
    this.hardwareVideo = platform === "darwin" && !forceSoftware;
    this.durationSeconds = Number.isFinite(Number(durationSeconds)) ? Number(durationSeconds) : null;
    this.proxy = new RangeProxy({
      readRange,
      openRangeStream,
      randomUUIDImpl,
      onError: (error) => {
        if (this.destroyed) return;
        this.#fail(error);
      }
    });
    this.child = null;
    this.queue = [];
    this.queueBytes = 0;
    this.waiters = [];
    this.ready = false;
    this.ended = false;
    this.destroyed = false;
    this.generation = 0;
    this.initialization = null;
    this.stderr = "";
    this.failure = null;
    this.subtitleDirectory = null;
    this.subtitleFile = null;
  }

  async initialize({ startTimeSeconds = 0, signal } = {}) {
    this.#assertAlive();
    await this.#prepareSubtitleFile();
    if (!this.ready) await this.#restart(Math.max(0, Number(startTimeSeconds) || 0), signal);
    return this.#initializationDto(Math.max(0, Number(startTimeSeconds) || 0));
  }

  async next({ signal } = {}) {
    this.#assertReady();
    if (this.queue.length === 0 && this.failure) throw this.failure;
    if (this.queue.length === 0 && !this.ended) await this.#waitForSegment(signal);
    if (this.queue.length === 0 && this.failure) throw this.failure;

    // 打包已就绪的多个分片一起返回（受 NEXT_BATCH_BYTES 约束），减少 CDP 往返，
    // 避免每 2s 一个分片单独往返导致的卡顿。至少返回一个（若有）。
    const segments = [];
    let batchBytes = 0;
    while (this.queue.length > 0) {
      if (segments.length > 0 && batchBytes + this.queue[0].byteLength > NEXT_BATCH_BYTES) break;
      const segment = this.queue.shift();
      this.queueBytes -= segment.byteLength;
      batchBytes += segment.byteLength;
      segments.push({ trackId: 0, data: asBase64(segment), sampleNumber: 0, last: false });
    }
    if (this.queueBytes <= RESUME_QUEUE_BYTES) this.child?.stdout?.resume();
    if (segments.length > 0) return { segments, end: false };
    if (this.ended) return { segments: [], end: true };
    return { segments: [], end: false };
  }

  async seek(seconds, { signal } = {}) {
    this.#assertReady();
    const timeSeconds = Math.max(0, Number(seconds) || 0);
    await this.#restart(timeSeconds, signal);
    return { timeSeconds, offset: 0, timestampOffsetSeconds: timeSeconds };
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.generation += 1;
    this.#stopChild();
    this.queue.length = 0;
    this.queueBytes = 0;
    this.#rejectWaiters(new EmbyError("PLAYBACK_NOT_FOUND", "FFmpeg 播放会话已经结束"));
    void this.proxy.close();
    if (this.subtitleDirectory) void rm(this.subtitleDirectory, { recursive: true, force: true });
    this.subtitleDirectory = null;
    this.subtitleFile = null;
  }

  async #restart(startTimeSeconds, signal) {
    this.generation += 1;
    const generation = this.generation;
    this.#stopChild();
    this.queue.length = 0;
    this.queueBytes = 0;
    this.ended = false;
    this.ready = false;
    this.failure = null;
    this.stderr = "";
    this.#rejectWaiters(cancelled());
    const inputUrl = await this.proxy.start();
    this.#assertAlive();

    const args = buildFfmpegArguments({
      inputUrl,
      mediaSource: this.mediaSource,
      strategy: this.strategy,
      subtitleTrack: this.subtitleTrack,
      subtitleFile: this.subtitleFile,
      startTimeSeconds,
      hardwareVideo: this.hardwareVideo
    });

    const child = this.spawnImpl(this.ffmpegPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    this.child = child;
    const parser = new FragmentParser({
      onInitialization: (initialization) => {
        if (generation !== this.generation || this.destroyed) return;
        this.initialization = initialization;
        this.ready = true;
        resolveStart();
      },
      onSegment: (segment) => {
        if (generation !== this.generation || this.destroyed) return;
        this.queue.push(segment);
        this.queueBytes += segment.byteLength;
        if (this.queueBytes >= MAX_QUEUE_BYTES) child.stdout.pause();
        this.#resolveWaiters();
      }
    });

    let settled = false;
    let resolveStart;
    let rejectStart;
    const started = new Promise((resolve, reject) => {
      resolveStart = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      rejectStart = (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
    });
    const timeout = setTimeout(() => {
      rejectStart(new EmbyError("FFMPEG_START_TIMEOUT", "FFmpeg 启动超时", { retryable: true }));
      this.#stopChild();
    }, START_TIMEOUT_MS);
    timeout.unref?.();
    const abort = () => {
      rejectStart(signal?.reason ?? cancelled());
      this.#stopChild();
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });

    child.stdout.on("data", (chunk) => {
      try {
        parser.push(chunk);
      } catch (error) {
        rejectStart(error);
        this.#fail(error);
      }
    });
    child.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${String(chunk)}`.slice(-MAX_STDERR_BYTES);
    });
    child.once("error", (cause) => {
      const error = new EmbyError("FFMPEG_START_FAILED", "无法启动 FFmpeg", { cause });
      rejectStart(error);
      this.#fail(error);
    });
    child.once("exit", (code, exitSignal) => {
      if (generation !== this.generation || this.destroyed) return;
      this.child = null;
      if (code === 0) {
        this.ended = true;
        this.#resolveWaiters();
        return;
      }
      const detail = this.stderr.trim().split(/\r?\n/).slice(-1)[0];
      const suffix = detail ? `：${detail}` : "";
      const error = this.failure ?? new EmbyError(
        "FFMPEG_FAILED",
        `FFmpeg 处理媒体失败${suffix}`,
        { retryable: false, cause: exitSignal ? new Error(exitSignal) : undefined }
      );
      rejectStart(error);
      this.#fail(error);
    });

    try {
      await started;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  }

  #initializationDto(startTimeSeconds) {
    const codec = codecFromInitialization(this.initialization, this.strategy.hasAudio);
    return {
      durationSeconds: this.durationSeconds,
      startTimeSeconds,
      timestampOffsetSeconds: startTimeSeconds,
      tracks: [{
        id: 0,
        type: "combined",
        codec,
        mime: `video/mp4; codecs="${codec}"`,
        initData: asBase64(this.initialization)
      }]
    };
  }

  async #prepareSubtitleFile() {
    if (!this.subtitleTrack || !this.subtitleData || this.subtitleFile) return;
    const bytes = this.subtitleData instanceof Uint8Array
      ? this.subtitleData
      : new Uint8Array(this.subtitleData);
    this.subtitleDirectory = await mkdtemp(join(tmpdir(), "codex-companion-subtitle-"));
    this.subtitleFile = join(
      this.subtitleDirectory,
      `subtitle.${subtitleExtension(this.subtitleTrack.codec)}`
    );
    await writeFile(this.subtitleFile, bytes, { mode: 0o600 });
  }

  #waitForSegment(signal) {
    if (signal?.aborted) return Promise.reject(signal.reason ?? cancelled());
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, abort: null };
      waiter.abort = () => {
        this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
        reject(signal.reason ?? cancelled());
      };
      signal?.addEventListener("abort", waiter.abort, { once: true });
      this.waiters.push(waiter);
    });
  }

  #resolveWaiters() {
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) {
      waiter.signal?.removeEventListener("abort", waiter.abort);
      waiter.resolve();
    }
  }

  #rejectWaiters(error) {
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) {
      waiter.signal?.removeEventListener("abort", waiter.abort);
      waiter.reject(error);
    }
  }

  #fail(error) {
    this.failure = error;
    this.ended = true;
    this.#stopChild();
    this.#rejectWaiters(error);
  }

  #stopChild() {
    const child = this.child;
    this.child = null;
    if (!child) return;
    child.stdout?.destroy();
    child.stderr?.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }

  #assertAlive() {
    if (this.destroyed) throw new EmbyError("PLAYBACK_NOT_FOUND", "FFmpeg 播放会话已经结束");
  }

  #assertReady() {
    this.#assertAlive();
    if (!this.ready) throw new EmbyError("FFMPEG_NOT_INITIALIZED", "FFmpeg 播放器尚未初始化");
  }
}
