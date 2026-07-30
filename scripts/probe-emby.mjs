#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import {
  EmbyClient,
  EmbyError,
  normalizeServerUrl,
  redactSensitive,
  sanitizeDirectStreamUrl
} from "../src/emby-client.mjs";
import { DirectMp4Session } from "../src/direct-mp4-session.mjs";
import { mapSubtitleStreams } from "../src/emby-service.mjs";
import { FfmpegFmp4Session } from "../src/ffmpeg-fmp4-session.mjs";

export function parseProbeArgs(argv) {
  const options = { server: "", username: "", search: "", itemId: "", help: false };
  const args = [...argv];
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--server" || arg === "-s") options.server = args.shift() ?? "";
    else if (arg === "--username" || arg === "-u") options.username = args.shift() ?? "";
    else if (arg === "--search") options.search = args.shift() ?? "";
    else if (arg === "--item") options.itemId = args.shift() ?? "";
    else if (arg === "--password") throw new EmbyError("UNSAFE_ARGUMENT", "密码不能通过命令行参数传入");
    else throw new EmbyError("INVALID_ARGUMENT", `未知参数：${arg}`);
  }
  return options;
}

export async function promptSecret(prompt, { input = process.stdin, output = process.stdout } = {}) {
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    throw new EmbyError("TTY_REQUIRED", "密码必须在交互式终端中无回显输入");
  }
  output.write(prompt);
  const wasRaw = Boolean(input.isRaw);
  input.setRawMode(true);
  input.resume();

  return new Promise((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      input.off("data", onData);
      input.setRawMode(wasRaw);
      if (!wasRaw) input.pause();
    };
    const onData = (chunk) => {
      const text = chunk.toString("utf8");
      for (const character of text) {
        if (character === "\r" || character === "\n") {
          cleanup();
          output.write("\n");
          resolve(value);
          return;
        }
        if (character === "\u0003") {
          cleanup();
          output.write("\n");
          reject(new EmbyError("CANCELLED", "探针已取消"));
          return;
        }
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else if (character >= " ") value += character;
      }
    };
    input.on("data", onData);
  });
}

function unwrapItems(response) {
  return Array.isArray(response) ? response : (response?.Items ?? []);
}

function firstPlaylistUri(manifest) {
  return String(manifest).split(/\r?\n/).map((line) => line.trim()).find((line) => line && !line.startsWith("#")) ?? null;
}

async function promptText(label, { input, output }) {
  if (!input.isTTY) throw new EmbyError("TTY_REQUIRED", `${label}必须通过参数提供，或在交互式终端输入`);
  const readline = createInterface({ input, output });
  try {
    return (await readline.question(`${label}：`)).trim();
  } finally {
    readline.close();
  }
}

export async function runProbe({
  options,
  password,
  input = process.stdin,
  output = process.stdout,
  clientFactory = (settings) => new EmbyClient(settings),
  directSessionFactory = (settings) => new DirectMp4Session(settings),
  ffmpegSessionFactory = (settings) => new FfmpegFmp4Session(settings),
  deviceId = `codex-companion-probe-${randomUUID()}`
}) {
  const server = normalizeServerUrl(options.server || await promptText("Emby 服务器", { input, output }));
  const username = options.username || await promptText("用户名", { input, output });
  const secret = password ?? await promptSecret("密码（不会回显）：", { input, output });
  const write = (message) => output.write(`${message}\n`);
  const anonymous = clientFactory({ baseUrl: server, deviceId, token: null });

  write("[1/4] 连接与认证");
  const authentication = await anonymous.authenticate(username, secret);
  const token = authentication?.AccessToken;
  const userId = authentication?.User?.Id;
  if (!token || !userId || !authentication?.ServerId) {
    throw new EmbyError("INVALID_RESPONSE", "认证响应缺少 ServerId、UserId 或 AccessToken");
  }
  const client = clientFactory({ baseUrl: server, deviceId, token });
  write(`      成功：${authentication.User?.Name ?? username} @ ${server}`);

  write("[2/4] 目录、搜索与图片");
  const [viewsResponse, resumeResponse, latestResponse] = await Promise.all([
    client.getViews(userId),
    client.getResume(userId, { limit: 5 }),
    client.getLatest(userId, { limit: 12 })
  ]);
  const views = unwrapItems(viewsResponse);
  const resume = unwrapItems(resumeResponse);
  const latest = unwrapItems(latestResponse);
  const searchResponse = options.search ? await client.search(userId, options.search) : { Items: [] };
  const searchItems = unwrapItems(searchResponse);
  const candidates = [...resume, ...latest, ...searchItems];
  const series = candidates.find((item) => item.Type === "Series");
  if (series) {
    const seasonsResponse = await client.getSeasons(series.Id, userId);
    const season = unwrapItems(seasonsResponse)[0];
    if (season) await client.getEpisodes(series.Id, userId, { seasonId: season.Id });
  }
  const imageItem = candidates.find((item) => item?.ImageTags?.Primary);
  if (imageItem) {
    await client.loadResource(client.imageUrl(imageItem.Id, {
      tag: imageItem.ImageTags.Primary,
      maxWidth: 300,
      maxHeight: 450
    }), { maxBytes: 2 * 1024 * 1024 });
  }
  write(`      成功：${views.length} 个媒体库，续播 ${resume.length}，最近 ${latest.length}${imageItem ? "，缩略图可读" : "，无可验证缩略图"}`);

  write("[3/4] PlaybackInfo 与首批媒体分片");
  const requested = options.itemId ? { Id: options.itemId, Type: "Video" } : null;
  const playable = requested ?? candidates.find((item) => ["Movie", "Episode", "Video"].includes(item.Type));
  if (!playable) {
    throw new EmbyError(
      "PLAYABLE_ITEM_REQUIRED",
      "媒体库中没有可验证的视频；请使用 --item <项目ID> 指定可播放项目"
    );
  }
  const playback = await client.getPlaybackInfo(playable.Id, userId);
  const mediaSources = playback?.MediaSources ?? [];
  const transcodingSource = mediaSources.find((source) => source?.SupportsTranscoding === true || source?.TranscodingUrl);
  const directSource = mediaSources.find((source) => {
    return !transcodingSource
      && (source?.SupportsDirectPlay || source?.SupportsDirectStream)
      && ["mp4", "m4v", "mov"].includes(String(source?.Container ?? "").toLowerCase())
      && source?.DirectStreamUrl;
  });
  const ffmpegSource = mediaSources.find((source) => {
    return !transcodingSource
      && !directSource
      && (source?.SupportsDirectPlay || source?.SupportsDirectStream)
      && source?.DirectStreamUrl;
  });
  const mediaSource = transcodingSource ?? directSource ?? ffmpegSource;
  if (!mediaSource?.Id || !playback?.PlaySessionId) throw new EmbyError("NOT_PLAYABLE", "没有可验证的媒体源");
  const subtitles = mapSubtitleStreams(mediaSource);
  for (const subtitle of subtitles) {
    write([
      `      字幕 ${subtitle.index}：${subtitle.label}`,
      subtitle.language,
      subtitle.codec,
      subtitle.mode === "external-vtt" ? "文字/VTT" : "烧录",
      subtitle.isExternal ? "外挂" : "内嵌",
      subtitle.isDefault ? "默认" : "",
      subtitle.isForced ? "强制" : "",
      subtitle.isHearingImpaired ? "听障" : ""
    ].filter(Boolean).join(" · "));
  }
  const textSubtitle = subtitles.find((subtitle) => subtitle.mode === "external-vtt");
  const burnInSubtitle = subtitles.find((subtitle) => subtitle.mode === "burn-in");
  let checkedTextSubtitle = false;
  let checkedBurnInSubtitle = false;
  if (textSubtitle) {
    const subtitle = await client.loadResource(
      client.subtitleUrl(playable.Id, mediaSource.Id, textSubtitle.index),
      { responseType: "text", maxBytes: 4 * 1024 * 1024 }
    );
    if (!/^WEBVTT(?:[ \t][^\r\n]*)?(?:\r?\n|$)/.test(String(subtitle.text ?? "").replace(/^\uFEFF/, ""))) {
      throw new EmbyError("INVALID_SUBTITLE_RESPONSE", "字幕接口没有返回有效 WebVTT");
    }
    checkedTextSubtitle = true;
  }
  let checkedMode;
  if (transcodingSource) try {
    const masterUrl = client.hlsUrl(playable.Id, {
      userId,
      mediaSourceId: mediaSource.Id,
      playSessionId: playback.PlaySessionId,
      startTimeTicks: 0,
      subtitleMode: burnInSubtitle ? "burn-in" : "off",
      subtitleStreamIndex: burnInSubtitle?.index ?? null
    });
    const master = await client.loadResource(masterUrl, { responseType: "text" });
    let childUrl = firstPlaylistUri(master.text);
    if (!childUrl) throw new EmbyError("INVALID_HLS", "HLS 主清单没有可用条目");
    if (/\.m3u8(?:$|\?)/i.test(childUrl)) {
      const variant = await client.loadResource(childUrl, { responseType: "text" });
      childUrl = firstPlaylistUri(variant.text);
    }
    if (!childUrl) throw new EmbyError("INVALID_HLS", "HLS 媒体清单没有分片");
    await client.loadResource(childUrl, { responseType: "bytes" });
    checkedBurnInSubtitle = Boolean(burnInSubtitle);
  } finally {
    await client.stopActiveEncoding(playback.PlaySessionId).catch(() => {});
  } else {
    const localSource = directSource ?? ffmpegSource;
    const directUrl = sanitizeDirectStreamUrl(server, localSource.DirectStreamUrl);
    let resolvedUrl = null;
    const readRange = async ({ start, end, signal }) => {
      const result = await client.loadDirectRange(directUrl, { start, end, resolvedUrl, signal });
      if (result.resolvedUrl) resolvedUrl = result.resolvedUrl;
      return result;
    };
    const localBurnInSubtitle = burnInSubtitle ?? null;
    let subtitleData = null;
    if (localBurnInSubtitle && (
      localBurnInSubtitle.isExternal
      || ["ass", "ssa"].includes(localBurnInSubtitle.codec)
    )) {
      const format = ["ass", "ssa"].includes(localBurnInSubtitle.codec)
        ? "ass"
        : ["hdmv_pgs_subtitle", "pgs", "pgssub"].includes(localBurnInSubtitle.codec)
          ? "sup"
          : "sub";
      const result = await client.loadResource(
        client.subtitleUrl(playable.Id, mediaSource.Id, localBurnInSubtitle.index, { format }),
        { responseType: "bytes", maxBytes: 32 * 1024 * 1024 }
      );
      subtitleData = result.bytes;
    }
    const directSession = directSource && !localBurnInSubtitle
      ? directSessionFactory({ readRange })
      : ffmpegSessionFactory({
        readRange,
        mediaSource: localSource,
        durationSeconds: Number(localSource?.RunTimeTicks) / 10_000_000,
        subtitleTrack: localBurnInSubtitle,
        subtitleData
      });
    try {
      const initialization = await directSession.initialize();
      const first = await directSession.next();
      if (!initialization.tracks?.length || !first.segments?.length) {
        throw new EmbyError("MEDIA_BRIDGE_INVALID", "Node 媒体桥没有产生可播放分片");
      }
      checkedBurnInSubtitle = Boolean(localBurnInSubtitle);
    } finally {
      directSession.destroy();
    }
  }
  checkedMode = transcodingSource
    ? "hls"
    : (directSource && !burnInSubtitle ? "direct-mp4" : "ffmpeg-fmp4");
  write(checkedMode === "hls"
    ? "      成功：HLS 主清单、媒体清单和首分片可读"
    : (checkedMode === "direct-mp4"
      ? "      成功：MP4 Range、元数据和首批 fMP4 分片可读"
      : "      成功：FFmpeg 已按需生成首批 fMP4 分片"));
  write(`      字幕：发现 ${subtitles.length} 条${checkedTextSubtitle ? "，WebVTT 可读" : ""}${checkedBurnInSubtitle ? "，烧录首分片可读" : ""}`);

  write("[4/4] 安全约束");
  if (JSON.stringify({ server, username, views: views.length }).includes(token)) {
    throw new EmbyError("TOKEN_LEAK", "探针摘要意外包含 AccessToken");
  }
  write("      成功：探针未持久化密码或 Token，资源请求使用认证 Header");
  return {
    server,
    username,
    viewCount: views.length,
    resumeCount: resume.length,
    latestCount: latest.length,
    checkedMode,
    checkedHls: checkedMode === "hls",
    checkedDirect: checkedMode === "direct-mp4",
    checkedFfmpeg: checkedMode === "ffmpeg-fmp4",
    subtitleCount: subtitles.length,
    checkedTextSubtitle,
    checkedBurnInSubtitle
  };
}

function printHelp() {
  console.log(`
Emby 接入只读探针

用法：
  npm run probe:emby -- --server <URL> --username <用户名> [--search <关键词>] [--item <项目ID>]

密码始终通过终端无回显读取，不能作为命令行参数传入。探针不会写入配置或钥匙串。
`);
}

async function main() {
  const options = parseProbeArgs(process.argv.slice(2));
  if (options.help) return printHelp();
  await runProbe({ options });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[probe:emby] ${redactSensitive(error?.message ?? "探针失败")}`);
    process.exitCode = 1;
  });
}
