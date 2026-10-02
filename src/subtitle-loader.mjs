import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { RangeProxy } from "./ffmpeg-fmp4-session.mjs";
import { resolveFfmpegPath } from "./ffmpeg-path.mjs";
import { EmbyError, DEFAULT_SUBTITLE_LIMIT } from "./emby-client.mjs";

const execFileAsync = promisify(execFile);
export const SUBTITLE_WINDOW_SECONDS = 60;

function timestamp(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  return `${String(Math.floor(ms / 3600000)).padStart(2, "0")}:${String(Math.floor(ms / 60000) % 60).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
}

// FFmpeg 在 -ss 后输出相对时间；只改 cue 时间行，正文中的时间字符串保持原样。
export function offsetWebVtt(text, offset) {
  const time = "(?:\\d{2,}:)?\\d{2}:\\d{2}\\.\\d{3}";
  const seconds = (value) => value.split(":").reduce((total, part) => total * 60 + Number(part), 0);
  return text.replace(new RegExp(`^(${time}) --> (${time})([^\\r\\n]*)$`, "gm"),
    (_line, start, end, settings) => `${timestamp(seconds(start) + offset)} --> ${timestamp(seconds(end) + offset)}${settings}`);
}

export async function extractSubtitleWindow({ readRange, openRangeStream, index, positionSeconds, signal, ffmpegPath = resolveFfmpegPath() }) {
  const from = Math.floor(Math.max(0, Number(positionSeconds) || 0) / SUBTITLE_WINDOW_SECONDS) * SUBTITLE_WINDOW_SECONDS;
  // 向前重叠 30s 保留跨边界 cue，向后多取 30s，为下一段加载留余量。
  const start = Math.max(0, from - 30);
  const until = from + SUBTITLE_WINDOW_SECONDS;
  let upstreamError;
  // 视频已有持续长流；字幕使用有界 Range，避免同一 CDN 对第二条长流的限制。
  const proxy = new RangeProxy({ readRange, openRangeStream: readRange ? null : openRangeStream,
    onError: (error) => { upstreamError = error; } });
  try {
    const url = await proxy.start();
    signal?.throwIfAborted();
    const { stdout } = await execFileAsync(ffmpegPath, [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-ss", String(start), "-i", url,
      "-t", String(until + 30 - start), "-map", `0:${index}`, "-vn", "-an",
      "-c:s", "webvtt", "-f", "webvtt", "pipe:1"
    ], { signal, timeout: 20_000, maxBuffer: DEFAULT_SUBTITLE_LIMIT });
    if (upstreamError) throw upstreamError;
    if (!stdout.startsWith("WEBVTT")) throw new Error("missing WebVTT header");
    return { data: offsetWebVtt(stdout, start), window: { from, until } };
  } catch (cause) {
    if (signal?.aborted) throw signal.reason;
    throw new EmbyError("SUBTITLE_EXTRACTION_FAILED", "当前片段字幕提取失败，可重试或切换字幕轨", { retryable: true, cause });
  } finally {
    await proxy.close();
  }
}

// 每个播放会话只处理一个字幕任务。同键合并，切轨/跳转取消旧任务；成功结果有界缓存。
export class SubtitleLoader {
  cache = new Map();
  active = null;
  disposed = false;

  load(key, operation) {
    if (this.disposed) return Promise.reject(new EmbyError("CANCELLED", "播放已结束"));
    if (this.active?.key !== key) this.active?.controller.abort(new EmbyError("CANCELLED", "字幕位置已改变"));
    if (this.cache.has(key)) return Promise.resolve(this.cache.get(key));
    if (this.active?.key === key && !this.active.controller.signal.aborted) return this.active.promise;
    const controller = new AbortController();
    const entry = { key, controller };
    const timeout = setTimeout(() => controller.abort(new EmbyError("SUBTITLE_TIMEOUT", "字幕服务响应较慢，请重试或换一条字幕", { retryable: true })), 55_000);
    entry.promise = Promise.resolve().then(() => operation(controller.signal)).then((result) => {
      controller.signal.throwIfAborted();
      if (this.cache.size >= 6) this.cache.delete(this.cache.keys().next().value);
      this.cache.set(key, result);
      return result;
    }).finally(() => {
      clearTimeout(timeout);
      if (this.active === entry) this.active = null;
    });
    this.active = entry;
    return entry.promise;
  }

  dispose() {
    this.disposed = true;
    this.cancel();
    this.cache.clear();
  }

  cancel() {
    this.active?.controller.abort(new EmbyError("CANCELLED", "字幕任务已取消"));
  }
}
