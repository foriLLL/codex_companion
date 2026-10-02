// 使用已登录 Emby 的实际片源验证本机 HDR/DV 色彩链路；不向服务端上报观看进度。
// node scripts/probe-color.mjs <itemId> <sourceOrdinal> [startSeconds] [output.mp4]
import { writeFile } from "node:fs/promises";
import { EmbyStorage } from "../src/emby-storage.mjs";
import { EmbyClient, sanitizeDirectStreamUrl } from "../src/emby-client.mjs";
import { FfmpegFmp4Session } from "../src/ffmpeg-fmp4-session.mjs";
import { videoColorInfo } from "../src/video-color.mjs";

const [itemId, ordinalArg, startArg = "60", output = "/tmp/codex-companion-color-probe.mp4"] = process.argv.slice(2);
if (!itemId || !/^\d+$/.test(ordinalArg ?? "")) throw new Error("用法：node scripts/probe-color.mjs <itemId> <sourceOrdinal> [startSeconds] [output.mp4]");
const storage = new EmbyStorage();
const config = await storage.loadConfig();
if (!config) throw new Error("请先登录 Emby");
const token = await storage.readToken(config.serverId, config.userId);
const client = new EmbyClient({ ...config, token });
let session;
try {
  const signal = AbortSignal.timeout(90_000);
  const info = await client.getPlaybackInfo(itemId, config.userId, { signal });
  const mediaSource = info.MediaSources?.[Number(ordinalArg)];
  if (!mediaSource?.DirectStreamUrl) throw new Error("该片源没有本机处理所需的直连地址");
  const directUrl = sanitizeDirectStreamUrl(client.baseUrl, mediaSource.DirectStreamUrl);
  let resolvedUrl = null;
  const readRange = async (options) => {
    const result = await client.loadDirectRange(directUrl, { ...options, resolvedUrl });
    if (result.resolvedUrl) resolvedUrl = result.resolvedUrl;
    return result;
  };
  const openRangeStream = async (options) => {
    const result = await client.openDirectRangeStream(directUrl, { ...options, resolvedUrl });
    if (result.resolvedUrl) resolvedUrl = result.resolvedUrl;
    return result;
  };
  session = new FfmpegFmp4Session({ mediaSource, readRange, openRangeStream });
  const started = Date.now();
  const initialization = await session.initialize({ startTimeSeconds: Number(startArg), signal });
  const chunks = [Buffer.from(initialization.tracks[0].initData, "base64")];
  let batches = 0;
  let totalBytes = chunks[0].length;
  while (batches < 3 && totalBytes < 24 * 1024 * 1024) {
    const next = await session.next({ signal });
    for (const segment of next.segments) {
      const chunk = Buffer.from(segment.data, "base64");
      chunks.push(chunk);
      totalBytes += chunk.length;
    }
    if (next.segments.length > 0) batches++;
    if (next.end) break;
  }
  if (!batches) throw new Error("未生成可播放分片");
  await writeFile(output, Buffer.concat(chunks), { mode: 0o600 });
  const beforeSeek = Date.now();
  await session.seek(Number(startArg) + 30, { signal });
  const seekOutput = await session.next({ signal });
  if (!seekOutput.segments.length) throw new Error("seek 后没有媒体分片");
  console.log(JSON.stringify({ color: videoColorInfo(mediaSource), output, bytes: totalBytes, firstBatchesMs: beforeSeek - started, seekMs: Date.now() - beforeSeek, codec: initialization.tracks[0].codec }));
} finally {
  session?.destroy();
  client.close();
}
