import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { promisify } from "node:util";
import { EmbyError } from "../src/emby-client.mjs";
import { resolveFfmpegPath } from "../src/ffmpeg-path.mjs";
import {
  FfmpegFmp4Session,
  RangeProxy,
  buildFfmpegArguments,
  ffmpegStrategy,
  mediaSourceExceedsDirectBitrate,
  videoBitrateFor
} from "../src/ffmpeg-fmp4-session.mjs";

const execFileAsync = promisify(execFile);
const ffmpegPath = resolveFfmpegPath();

function mp4Box(type, payload = Buffer.alloc(0)) {
  const box = Buffer.alloc(8 + payload.length);
  box.writeUInt32BE(box.length, 0);
  box.write(type, 4, 4, "ascii");
  payload.copy(box, 8);
  return box;
}

async function ffmpegHasFilter(name) {
  if (!ffmpegPath) return false;
  const { stdout = "" } = await execFileAsync(ffmpegPath, ["-hide_banner", "-filters"])
    .catch(() => ({ stdout: "" }));
  return stdout.split(/\r?\n/).some((line) => line.trim().split(/\s+/)[1] === name);
}

test("Bun 发布运行时使用原生 loopback Range 服务并保持字节精确", async () => {
  const bunPath = join(process.cwd(), "node_modules", ".bin", "bun");
  const moduleUrl = new URL("../src/ffmpeg-fmp4-session.mjs", import.meta.url).href;
  const script = `
    import { RangeProxy } from ${JSON.stringify(moduleUrl)};
    const nativeServe = Bun.serve;
    const timeoutCalls = [];
    Bun.serve = (options) => nativeServe({
      ...options,
      fetch: (request, server) => options.fetch(request, {
        timeout(target, seconds) {
          timeoutCalls.push(seconds);
          return server.timeout(target, seconds);
        }
      })
    });
    const source = Uint8Array.from({ length: 32 }, (_, index) => index);
    const proxy = new RangeProxy({
      openRangeStream: async ({ start, end }) => ({
        start,
        end: end ?? source.length - 1,
        total: source.length,
        contentType: "application/octet-stream",
        body: (async function* () {
          yield source.subarray(start, (end ?? source.length - 1) + 1);
        })()
      })
    });
    const url = await proxy.start();
    const runtime = proxy.serverRuntime;
    const response = await fetch(url, { headers: { Range: "bytes=3-8" } });
    const bytes = [...new Uint8Array(await response.arrayBuffer())];
    await proxy.close();
    Bun.serve = nativeServe;
    console.log(JSON.stringify({ runtime, status: response.status, bytes, timeoutCalls }));
  `;
  const { stdout } = await execFileAsync(bunPath, ["--eval", script], { timeout: 10_000 });
  assert.deepEqual(JSON.parse(stdout.trim()), {
    runtime: "bun",
    status: 206,
    bytes: [3, 4, 5, 6, 7, 8],
    timeoutCalls: [0]
  });
});

test("FFmpeg 策略优先重封装 H.264/AAC，仅为不兼容编码转码", () => {
  assert.deepEqual(ffmpegStrategy({
    MediaStreams: [
      { Type: "Video", Codec: "h264" },
      { Type: "Audio", Codec: "aac" }
    ]
  }), {
    videoCodec: "h264",
    audioCodec: "aac",
    hasAudio: true,
    copyVideo: true,
    copyAudio: true
  });
  assert.deepEqual(ffmpegStrategy({
    MediaStreams: [
      { Type: "Video", Codec: "hevc" },
      { Type: "Audio", Codec: "ac3" }
    ]
  }), {
    videoCodec: "hevc",
    audioCodec: "ac3",
    hasAudio: true,
    copyVideo: false,
    copyAudio: false
  });
  const highBitrate = {
    Bitrate: 95_400_000,
    MediaStreams: [
      { Type: "Video", Codec: "h264", Height: 2160, BitRate: 94_998_420 },
      { Type: "Audio", Codec: "aac" }
    ]
  };
  assert.equal(mediaSourceExceedsDirectBitrate(highBitrate), true);
  assert.equal(ffmpegStrategy(highBitrate).copyVideo, false);
  assert.equal(mediaSourceExceedsDirectBitrate({
    MediaStreams: [{ Type: "Video", Codec: "h264", BitRate: 19_000_000 }]
  }), false);
  const remuxOnly = {
    MediaStreams: [{ Type: "Video", Codec: "h264", BitRate: 21_000_000 }]
  };
  assert.equal(mediaSourceExceedsDirectBitrate(remuxOnly), false);
  assert.equal(ffmpegStrategy(remuxOnly).copyVideo, true);
  const transcoded = {
    MediaStreams: [{ Type: "Video", Codec: "h264", BitRate: 41_000_000 }]
  };
  assert.equal(mediaSourceExceedsDirectBitrate(transcoded), true);
  assert.equal(ffmpegStrategy(transcoded).copyVideo, false);
});

test("FFmpeg 参数分别覆盖 ASS、PGS、VobSub 和 DVB 烧录", () => {
  const mediaSource = {
    MediaStreams: [
      { Type: "Video", Index: 0, Codec: "h264" },
      { Type: "Audio", Index: 1, Codec: "aac" },
      { Type: "Subtitle", Index: 2, Codec: "ass" },
      { Type: "Subtitle", Index: 3, Codec: "hdmv_pgs_subtitle" }
    ]
  };
  const strategy = ffmpegStrategy(mediaSource, { codec: "ass" });
  const embeddedAss = buildFfmpegArguments({
    inputUrl: "http://127.0.0.1:1234/media/source",
    mediaSource,
    strategy,
    subtitleTrack: { index: 2, codec: "ass", isExternal: false },
    startTimeSeconds: 12.5,
    hardwareVideo: false
  });
  assert.match(
    embeddedAss[embeddedAss.indexOf("-filter_complex") + 1],
    /setpts=PTS\+12\.500\/TB,subtitles=filename='http\\:\/\/127\.0\.0\.1\\:1234\/media\/source':si=0,setpts=PTS-12\.500\/TB/
  );
  assert.equal(embeddedAss.includes("libx264"), true);

  const embeddedPgs = buildFfmpegArguments({
    inputUrl: "http://127.0.0.1:1234/media/source",
    mediaSource,
    strategy,
    subtitleTrack: { index: 3, codec: "hdmv_pgs_subtitle", isExternal: false }
  });
  assert.equal(
    embeddedPgs[embeddedPgs.indexOf("-filter_complex") + 1],
    "[0:v:0][0:3]overlay=eof_action=pass:shortest=0[v]"
  );

  const externalVobSub = buildFfmpegArguments({
    inputUrl: "http://127.0.0.1:1234/media/source",
    mediaSource,
    strategy,
    subtitleTrack: { index: 4, codec: "dvd_subtitle", isExternal: true },
    subtitleFile: "/private/tmp/codex-companion-subtitle/subtitle.sub"
  });
  assert.equal(
    externalVobSub[externalVobSub.indexOf("-filter_complex") + 1],
    "[0:v:0][1:s:0]overlay=eof_action=pass:shortest=0[v]"
  );
  assert.equal(externalVobSub.includes("/private/tmp/codex-companion-subtitle/subtitle.sub"), true);

  const externalDvb = buildFfmpegArguments({
    inputUrl: "http://127.0.0.1:1234/media/source",
    mediaSource,
    strategy,
    subtitleTrack: { index: 5, codec: "dvb_subtitle", isExternal: true },
    subtitleFile: "/private/tmp/codex-companion-subtitle/subtitle.sub"
  });
  assert.equal(externalDvb.filter((argument) => argument === "-fix_sub_duration").length, 1);
});

test("hardwareVideo 触发 VideoToolbox 硬件编码路径（-hwaccel 前置、无 output_format）", () => {
  const mediaSource = {
    MediaStreams: [
      { Type: "Video", Index: 0, Codec: "hevc", Height: 1080, BitRate: 10_000_000 },
      { Type: "Audio", Index: 1, Codec: "aac" },
      { Type: "Subtitle", Index: 2, Codec: "ass" }
    ]
  };
  // 烧录字幕 → copyVideo:false → 走重编码路径。
  const strategy = ffmpegStrategy(mediaSource, { codec: "ass" });
  assert.equal(strategy.copyVideo, false);
  const args = buildFfmpegArguments({
    inputUrl: "http://127.0.0.1:1234/media/source",
    mediaSource,
    strategy,
    subtitleTrack: { index: 2, codec: "ass", isExternal: false },
    hardwareVideo: true
  });
  // -hwaccel 是输入 0 的输入选项，必须在第一个 -i 之前。
  assert.equal(args[args.indexOf("-hwaccel") + 1], "videotoolbox");
  assert.ok(args.indexOf("-hwaccel") >= 0 && args.indexOf("-hwaccel") < args.indexOf("-i"));
  assert.equal(args.includes("h264_videotoolbox"), true);
  assert.equal(args.includes("libx264"), false);
  assert.equal(args.includes("-allow_sw"), true);
  assert.equal(args.includes("-realtime"), true);
  // 源码率 10Mbps 在 1080p 档 [4M,12M] 内 → 原样透传。
  assert.equal(args[args.indexOf("-b:v") + 1], "10000000");
  // 刻意不加 -hwaccel_output_format，否则 subtitles filter / pix_fmt 转换会失败。
  assert.equal(args.includes("-hwaccel_output_format"), false);
});

test("hardwareVideo 对 copyVideo（H.264 无字幕）不注入 -hwaccel/编码器", () => {
  const mediaSource = { MediaStreams: [{ Type: "Video", Codec: "h264" }, { Type: "Audio", Codec: "aac" }] };
  const strategy = ffmpegStrategy(mediaSource);
  assert.equal(strategy.copyVideo, true);
  const args = buildFfmpegArguments({
    inputUrl: "http://127.0.0.1:1234/media/source",
    mediaSource,
    strategy,
    hardwareVideo: true
  });
  assert.equal(args.includes("-hwaccel"), false);
  assert.equal(args.includes("h264_videotoolbox"), false);
  assert.equal(args.includes("libx264"), false);
  assert.deepEqual(args.slice(args.indexOf("-c:v"), args.indexOf("-c:v") + 2), ["-c:v", "copy"]);
});

test("videoBitrateFor 按分辨率分档钳制源码率，未知则用档位默认", () => {
  // 档内透传
  assert.equal(videoBitrateFor({ MediaStreams: [{ Type: "Video", Height: 1080, BitRate: 10_000_000 }] }), "10000000");
  // 高于 cap → 钳到 cap
  assert.equal(videoBitrateFor({ MediaStreams: [{ Type: "Video", Height: 1080, BitRate: 50_000_000 }] }), "12000000");
  // 低于 floor → 抬到 floor
  assert.equal(videoBitrateFor({ MediaStreams: [{ Type: "Video", Height: 1080, BitRate: 1_000_000 }] }), "4000000");
  // 源码率未知 → 档位 fallback
  assert.equal(videoBitrateFor({ MediaStreams: [{ Type: "Video", Height: 1080 }] }), "8000000");
  assert.equal(videoBitrateFor({ MediaStreams: [{ Type: "Video", Height: 2160, BitRate: 0 }] }), "20000000");
  // 高度未知 → 归 1080p 档
  assert.equal(videoBitrateFor({ MediaStreams: [{ Type: "Video" }] }), "8000000");
  assert.equal(videoBitrateFor({ MediaStreams: [] }), "8000000");
  // 分辨率档边界（源码率未知取 fallback）
  assert.equal(videoBitrateFor({ MediaStreams: [{ Type: "Video", Height: 576 }] }), "2500000");
  assert.equal(videoBitrateFor({ MediaStreams: [{ Type: "Video", Height: 720 }] }), "4000000");
  assert.equal(videoBitrateFor({ MediaStreams: [{ Type: "Video", Height: 1440 }] }), "12000000");
  assert.equal(videoBitrateFor({ MediaStreams: [{ Type: "Video", Height: 2160 }] }), "20000000");
});

test("FFmpeg 会话串行处理初始化窗口内的并发 seek", async (t) => {
  let spawnCount = 0;
  const initialization = Buffer.concat([mp4Box("ftyp"), mp4Box("moov")]);
  const spawnImpl = () => {
    spawnCount += 1;
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = (signal = "SIGTERM") => {
      if (child.exitCode !== null || child.signalCode !== null) return false;
      child.signalCode = signal;
      queueMicrotask(() => child.emit("exit", null, signal));
      return true;
    };
    setTimeout(() => {
      if (!child.stdout.destroyed) child.stdout.write(initialization);
    }, 20);
    return child;
  };
  const session = new FfmpegFmp4Session({
    mediaSource: { MediaStreams: [{ Type: "Video", Codec: "h264" }] },
    readRange: async () => ({ bytes: Buffer.alloc(0), start: 0, end: 0, total: 1 }),
    ffmpegPathImpl: "/mock/ffmpeg",
    spawnImpl,
    platform: "linux"
  });
  t.after(() => session.destroy());

  await session.initialize();
  const results = await Promise.all([session.seek(10), session.seek(20)]);
  assert.deepEqual(results, [
    { timeSeconds: 10, offset: 0, timestampOffsetSeconds: 10 },
    { timeSeconds: 20, offset: 0, timestampOffsetSeconds: 20 }
  ]);
  assert.equal(spawnCount, 3);
});

test("RangeProxy 首批字节立即转发，并在上游断流后从已收偏移续接", async (t) => {
  const calls = [];
  let releaseFirst;
  const firstReleased = new Promise((resolve) => { releaseFirst = resolve; });
  const proxy = new RangeProxy({
    openRangeStream: async ({ start, end, signal }) => {
      calls.push({ start, end, signal });
      if (start === 0) {
        return {
          start: 0,
          end: 5,
          total: 6,
          contentType: "application/octet-stream",
          body: (async function* () {
            yield Buffer.from("abc");
            await firstReleased;
            throw new EmbyError("MEDIA_CDN_NETWORK_ERROR", "模拟断流", { retryable: true });
          })()
        };
      }
      return {
        start,
        end: 5,
        total: 6,
        contentType: "application/octet-stream",
        body: (async function* () {
          yield Buffer.from("def");
        })()
      };
    }
  });
  const url = await proxy.start();
  t.after(() => proxy.close());

  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-length"), "6");
  const reader = response.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), "abc");
  assert.deepEqual(calls.map(({ start }) => start), [0]);

  releaseFirst();
  assert.equal(new TextDecoder().decode((await reader.read()).value), "def");
  assert.equal((await reader.read()).done, true);
  assert.deepEqual(calls.map(({ start }) => start), [0, 3]);
});

test("RangeProxy 在播放器取消读取时终止持续上游流", async (t) => {
  let upstreamSignal = null;
  const proxy = new RangeProxy({
    openRangeStream: async ({ signal }) => {
      upstreamSignal = signal;
      return {
        start: 0,
        end: 99,
        total: 100,
        contentType: "application/octet-stream",
        body: (async function* () {
          yield Buffer.from("a");
          await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        })()
      };
    }
  });
  const url = await proxy.start();
  t.after(() => proxy.close());
  const controller = new AbortController();
  const response = await fetch(url, { signal: controller.signal });
  const reader = response.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), "a");

  controller.abort();
  await assert.rejects(reader.read(), { name: "AbortError" });
  const deadline = Date.now() + 1_000;
  while (!upstreamSignal?.aborted && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(upstreamSignal?.aborted, true);
});

test("FFmpeg 会把 MKV 按需重封装为可追加的 fragmented MP4，并支持重启 seek", async (t) => {
  if (!ffmpegPath) {
    t.skip("未安装系统 FFmpeg");
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "codex-companion-ffmpeg-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = join(directory, "fixture.mkv");
  await execFileAsync(ffmpegPath, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "color=c=blue:s=160x90:r=12:d=3",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=3",
    "-shortest",
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    fixture
  ]);
  const contents = await readFile(fixture);
  const streamCalls = [];
  const session = new FfmpegFmp4Session({
    mediaSource: {
      MediaStreams: [
        { Type: "Video", Codec: "h264" },
        { Type: "Audio", Codec: "aac" }
      ]
    },
    durationSeconds: 3,
    openRangeStream: async ({ start, end, signal }) => {
      const finalEnd = Math.min(contents.length - 1, end ?? (contents.length - 1));
      streamCalls.push({ start, end, signal });
      return {
        start,
        end: finalEnd,
        total: contents.length,
        contentType: "video/x-matroska",
        body: (async function* () {
          for (let offset = start; offset <= finalEnd; offset += 16 * 1024) {
            yield contents.subarray(offset, Math.min(finalEnd + 1, offset + 16 * 1024));
          }
        })()
      };
    }
  });
  t.after(() => session.destroy());

  const initialization = await session.initialize({ signal: AbortSignal.timeout(10_000) });
  assert.equal(initialization.durationSeconds, 3);
  assert.equal(initialization.timestampOffsetSeconds, 0);
  assert.match(initialization.tracks[0].mime, /^video\/mp4; codecs="avc1\.[0-9a-f]{6},mp4a\.40\.2"$/);
  assert.ok(Buffer.from(initialization.tracks[0].initData, "base64").includes(Buffer.from("moov")));

  const first = await session.next({ signal: AbortSignal.timeout(10_000) });
  assert.equal(first.end, false);
  assert.ok(first.segments.length >= 1); // next() 现在可打包多个分片
  assert.ok(Buffer.from(first.segments[0].data, "base64").includes(Buffer.from("moof")));

  // 原生进度条拖动会在前一次重启未初始化完成时继续发 seek；会话必须串行处理，
  // 不能让第二次调用观察到内部 ready=false 并抛 FFMPEG_NOT_INITIALIZED。
  const seeks = await Promise.all([
    session.seek(0.5, { signal: AbortSignal.timeout(10_000) }),
    session.seek(1, { signal: AbortSignal.timeout(10_000) })
  ]);
  assert.deepEqual(seeks, [
    { timeSeconds: 0.5, offset: 0, timestampOffsetSeconds: 0.5 },
    { timeSeconds: 1, offset: 0, timestampOffsetSeconds: 1 }
  ]);
  const afterSeek = await session.next({ signal: AbortSignal.timeout(10_000) });
  assert.ok(afterSeek.segments.length >= 1);
  assert.ok(streamCalls.length >= 2);
});

test("FFmpeg 媒体桥保留上游 Range 的可操作错误", async (t) => {
  if (!ffmpegPath) {
    t.skip("未安装系统 FFmpeg");
    return;
  }
  const session = new FfmpegFmp4Session({
    mediaSource: { MediaStreams: [{ Type: "Video", Codec: "h264" }] },
    readRange: async () => {
      throw new EmbyError("MEDIA_REDIRECT_DNS_ERROR", "无法解析媒体 CDN 地址", { retryable: true });
    }
  });
  t.after(() => session.destroy());
  await assert.rejects(
    session.initialize({ signal: AbortSignal.timeout(5_000) }),
    { code: "MEDIA_REDIRECT_DNS_ERROR", message: "无法解析媒体 CDN 地址" }
  );
});

test("FFmpeg 使用 libass 烧录内嵌 ASS，并在 seek 后保持可播放时间轴", async (t) => {
  if (!ffmpegPath) {
    t.skip("未安装系统 FFmpeg");
    return;
  }
  if (!await ffmpegHasFilter("subtitles")) {
    t.skip("当前 FFmpeg 未包含 libass subtitles filter");
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "codex-companion-ffmpeg-ass-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const subtitle = join(directory, "subtitle.ass");
  const fixture = join(directory, "fixture.mkv");
  await writeFile(subtitle, `[Script Info]
ScriptType: v4.00+
PlayResX: 160
PlayResY: 90

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,16,&H00FFFFFF,&H000000FF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,1,0,2,10,10,8,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.20,0:00:02.50,Default,,0,0,0,,字幕测试
`);
  await execFileAsync(ffmpegPath, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "color=c=blue:s=160x90:r=12:d=3",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=3",
    "-i", subtitle,
    "-map", "0:v:0", "-map", "1:a:0", "-map", "2:s:0",
    "-t", "3",
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-c:s", "ass",
    fixture
  ]);
  const contents = await readFile(fixture);
  const session = new FfmpegFmp4Session({
    mediaSource: {
      MediaStreams: [
        { Type: "Video", Index: 0, Codec: "h264" },
        { Type: "Audio", Index: 1, Codec: "aac" },
        { Type: "Subtitle", Index: 2, Codec: "ass", IsTextSubtitleStream: true }
      ]
    },
    subtitleTrack: { index: 2, codec: "ass", isExternal: false, mode: "burn-in" },
    durationSeconds: 3,
    // 固定软件路径：本测试跑真 ffmpeg 强制重编码，macOS release runner 上会翻到
    // h264_videotoolbox。钉死 linux 使 ubuntu CI 与 macOS 行为一致、断言稳定。
    platform: "linux",
    readRange: async ({ start, end }) => ({
      bytes: new Uint8Array(contents.subarray(start, Math.min(contents.length, end + 1))),
      start,
      end: Math.min(contents.length - 1, end),
      total: contents.length,
      contentType: "video/x-matroska"
    })
  });
  t.after(() => session.destroy());

  assert.equal(ffmpegStrategy({
    MediaStreams: [{ Type: "Video", Codec: "h264" }, { Type: "Audio", Codec: "aac" }]
  }, { codec: "ass" }).copyVideo, false);
  const initialization = await session.initialize({ signal: AbortSignal.timeout(15_000) });
  assert.match(initialization.tracks[0].mime, /^video\/mp4; codecs="avc1\./);
  assert.equal((await session.next({ signal: AbortSignal.timeout(15_000) })).segments.length, 1);
  assert.equal((await session.seek(1, { signal: AbortSignal.timeout(15_000) })).timestampOffsetSeconds, 1);
  assert.equal((await session.next({ signal: AbortSignal.timeout(15_000) })).segments.length, 1);
});

test("VideoToolbox 硬件编码在 macOS 上产出合法 fMP4（无 h264_videotoolbox 时跳过）", async (t) => {
  if (!ffmpegPath) {
    t.skip("未安装系统 FFmpeg");
    return;
  }
  if (process.platform !== "darwin") {
    t.skip("非 macOS：无 VideoToolbox");
    return;
  }
  if (!await ffmpegHasFilter("subtitles")) {
    t.skip("当前 FFmpeg 未包含 libass subtitles filter");
    return;
  }
  const encoders = await execFileAsync(ffmpegPath, ["-hide_banner", "-encoders"]).then((r) => r.stdout).catch(() => "");
  if (!encoders.includes("h264_videotoolbox")) {
    t.skip("当前 ffmpeg 无 h264_videotoolbox 编码器");
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "codex-companion-ffmpeg-vt-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const subtitle = join(directory, "subtitle.ass");
  const fixture = join(directory, "fixture.mkv");
  await writeFile(subtitle, `[Script Info]
ScriptType: v4.00+
PlayResX: 160
PlayResY: 90

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,16,&H00FFFFFF,&H000000FF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,1,0,2,10,10,8,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.20,0:00:02.50,Default,,0,0,0,,字幕测试
`);
  await execFileAsync(ffmpegPath, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "color=c=blue:s=160x90:r=12:d=3",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=3",
    "-i", subtitle,
    "-map", "0:v:0", "-map", "1:a:0", "-map", "2:s:0",
    "-t", "3",
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-c:s", "ass",
    fixture
  ]);
  const contents = await readFile(fixture);
  const session = new FfmpegFmp4Session({
    mediaSource: {
      MediaStreams: [
        { Type: "Video", Index: 0, Codec: "h264", Height: 90, BitRate: 500_000 },
        { Type: "Audio", Index: 1, Codec: "aac" },
        { Type: "Subtitle", Index: 2, Codec: "ass", IsTextSubtitleStream: true }
      ]
    },
    subtitleTrack: { index: 2, codec: "ass", isExternal: false, mode: "burn-in" },
    durationSeconds: 3,
    // 强制 darwin 硬件路径（-allow_sw true 保证无硬件编码器的 runner 也能产出有效 fMP4）。
    platform: "darwin",
    env: {},
    readRange: async ({ start, end }) => ({
      bytes: new Uint8Array(contents.subarray(start, Math.min(contents.length, end + 1))),
      start,
      end: Math.min(contents.length - 1, end),
      total: contents.length,
      contentType: "video/x-matroska"
    })
  });
  t.after(() => session.destroy());

  const initialization = await session.initialize({ signal: AbortSignal.timeout(20_000) });
  assert.match(initialization.tracks[0].mime, /^video\/mp4; codecs="avc1\./);
  const first = await session.next({ signal: AbortSignal.timeout(20_000) });
  assert.ok(first.segments.length >= 1);
  assert.ok(Buffer.from(first.segments[0].data, "base64").includes(Buffer.from("moof")));
});

test("next() 打包多个已就绪分片，减少往返（受批量字节上限约束）", async () => {
  const session = new FfmpegFmp4Session({
    readRange: async () => ({ bytes: new Uint8Array(0), start: 0, end: 0, total: 0 }),
    mediaSource: { MediaStreams: [] },
    ffmpegPathImpl: "/bin/true",
    spawnImpl: () => { throw new Error("不应真正启动 ffmpeg"); }
  });
  // 直接驱动内部队列，验证批量逻辑（不启动真实 ffmpeg）
  session.ready = true;
  session.child = { stdout: { resume() {}, pause() {} } };
  const seg = (n) => { const b = Buffer.alloc(n); return b; };
  session.queue.push(seg(1024), seg(1024), seg(1024));
  session.queueBytes = 3 * 1024;

  const result = await session.next({ signal: AbortSignal.timeout(1000) });
  assert.equal(result.end, false);
  assert.equal(result.segments.length, 3, "小分片应一次性打包返回");
  assert.equal(session.queue.length, 0);
  assert.equal(session.queueBytes, 0);
});

test("next() 批量在超过字节上限时分批", async () => {
  const session = new FfmpegFmp4Session({
    readRange: async () => ({ bytes: new Uint8Array(0), start: 0, end: 0, total: 0 }),
    mediaSource: { MediaStreams: [] },
    ffmpegPathImpl: "/bin/true",
    spawnImpl: () => { throw new Error("不应真正启动 ffmpeg"); }
  });
  session.ready = true;
  session.child = { stdout: { resume() {}, pause() {} } };
  const big = 5 * 1024 * 1024; // 每个 5MiB，上限 6MiB → 每批只能装 1 个
  session.queue.push(Buffer.alloc(big), Buffer.alloc(big));
  session.queueBytes = 2 * big;

  const first = await session.next({ signal: AbortSignal.timeout(1000) });
  assert.equal(first.segments.length, 1, "超过批量上限时不应把第二个塞进同一批");
  assert.equal(session.queue.length, 1);
});
