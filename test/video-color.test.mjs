import assert from "node:assert/strict";
import test from "node:test";
import { videoColorInfo, SDR_TONE_MAP_FILTER } from "../src/video-color.mjs";
import { buildFfmpegArguments, ffmpegStrategy, requireToneMappingSupport } from "../src/ffmpeg-fmp4-session.mjs";
import { mapMediaSourceOption, mediaSourceSupportsRendererFmp4, pickMediaSource } from "../src/emby-service.mjs";
import { resolveFfmpegPath } from "../src/ffmpeg-path.mjs";

const source = (video) => ({ Container: "mkv", MediaStreams: [{ Type: "Video", Codec: "hevc", ...video }] });

test("识别 Emby 的 Dolby Vision P5/P7/P8、HDR10、HLG；10 位 SDR 不误判", () => {
  for (const [subtype, profile] of [["DoviProfile50", 5], ["DoviProfile76", 7], ["DoviProfile81", 8], ["DoviProfile84", 8]]) {
    assert.deepEqual(videoColorInfo(source({ ExtendedVideoSubType: subtype })), {
      kind: "dolby-vision", profile, label: `Dolby Vision P${profile}`, requiresToneMapping: true
    });
  }
  assert.equal(videoColorInfo(source({ DvProfile: 5 })).profile, 5);
  assert.equal(videoColorInfo(source({ VideoRange: "DolbyVision" })).kind, "dolby-vision");
  assert.equal(videoColorInfo(source({ ColorTransfer: "smpte2084" })).kind, "hdr10");
  assert.equal(videoColorInfo(source({ VideoRange: "HDR 10" })).kind, "hdr10");
  assert.equal(videoColorInfo(source({ ColorTransfer: "arib-std-b67" })).kind, "hlg");
  assert.equal(videoColorInfo(source({ BitDepth: 10, ColorTransfer: "bt709" })).requiresToneMapping, false);
});

test("HDR 不能旁路色调映射；P5 解码帧先处理元数据再烧字幕，最后明确标记 BT.709", () => {
  const mediaSource = source({ ExtendedVideoSubType: "DoviProfile50", Codec: "h264", Width: 3840, Height: 1920 });
  assert.equal(ffmpegStrategy(mediaSource).copyVideo, false);
  assert.equal(mediaSourceSupportsRendererFmp4(mediaSource), false);
  const args = buildFfmpegArguments({ inputUrl: "http://127.0.0.1/media", mediaSource, strategy: ffmpegStrategy(mediaSource), hardwareVideo: true });
  assert.equal(args[args.indexOf("-hwaccel") + 1], "videotoolbox");
  assert.ok(args.indexOf("-hwaccel") < args.indexOf("-i"));
  assert.equal(args.includes("-hwaccel_output_format"), false, "下载帧供 libplacebo 使用，保留 RPU");
  assert.equal(args[args.indexOf("-vf") + 1], SDR_TONE_MAP_FILTER);
  assert.equal(args[args.indexOf("-c:v") + 1], "h264_videotoolbox");
  assert.equal(args[args.indexOf("-color_trc") + 1], "bt709");
  const subtitleTrack = { codec: "ass", index: 1 };
  const subtitled = buildFfmpegArguments({ inputUrl: "http://127.0.0.1/media", mediaSource, strategy: ffmpegStrategy(mediaSource, subtitleTrack), subtitleTrack });
  const filter = subtitled[subtitled.indexOf("-filter_complex") + 1];
  assert.ok(filter.indexOf("libplacebo=") < filter.indexOf("subtitles="));
  const pgs = buildFfmpegArguments({ inputUrl: "http://127.0.0.1/media", mediaSource, strategy: ffmpegStrategy(mediaSource), subtitleTrack: { codec: "pgs", index: 2 } });
  const overlay = pgs[pgs.indexOf("-filter_complex") + 1];
  assert.ok(overlay.indexOf("libplacebo=") < overlay.indexOf("overlay="));
});

test("裁边 3840×1920 仍是 4K，选源标签必须区分 P5/P8", () => {
  const p5 = mapMediaSourceOption(source({ ExtendedVideoSubType: "DoviProfile50", Width: 3840, Height: 1920 }));
  const p8 = mapMediaSourceOption(source({ ExtendedVideoSubType: "DoviProfile81", Width: 3840, Height: 1920 }));
  assert.equal(p5.resolution, "4K");
  assert.match(p5.label, /Dolby Vision P5/);
  assert.match(p8.label, /Dolby Vision P8/);
});

test("没有 FFmpeg 时跳过高分辨率但无法播放的源", () => {
  const hevc = { ...source({ Width: 3840, Height: 2160 }), SupportsDirectStream: true, DirectStreamUrl: "/high.mkv" };
  const avc = { ...source({ Codec: "h264", Height: 1080 }), Container: "mp4", SupportsDirectStream: true, DirectStreamUrl: "/low.mp4" };
  assert.equal(pickMediaSource([hevc, avc], { localFfmpegAvailable: false }).mediaSource, avc);
});

test("只有 HDR 处理优先使用独立安装的 ffmpeg-full；显式覆盖始终优先", () => {
  const fileExists = (path) => ["/custom/ffmpeg", "/opt/homebrew/bin/ffmpeg", "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg"].includes(path);
  assert.equal(resolveFfmpegPath({ env: {}, execPath: "/app/backend", fileExists, preferFull: true, platform: "darwin" }), "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg");
  assert.equal(resolveFfmpegPath({ env: { CODEX_COMPANION_FFMPEG: "/custom/ffmpeg" }, execPath: "/app/backend", fileExists, preferFull: true, platform: "darwin" }), "/custom/ffmpeg");
});

test("实际执行滤镜探测（包含 GPU 驱动），失败时不继续输出错误色彩", async () => {
  await assert.rejects(requireToneMappingSupport("/mock/no-vulkan", { execFileImpl: async () => { throw new Error("No Vulkan device"); } }), { code: "HDR_TONEMAPPING_UNAVAILABLE" });
  let calls = 0;
  const options = { execFileImpl: async (_path, args) => { calls++; assert.ok(args.includes(SDR_TONE_MAP_FILTER)); } };
  await requireToneMappingSupport("/mock/with-color", options);
  await requireToneMappingSupport("/mock/with-color", options);
  assert.equal(calls, 1);
});
