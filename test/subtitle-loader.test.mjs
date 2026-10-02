import assert from "node:assert/strict";
import test from "node:test";
import { SubtitleLoader, offsetWebVtt } from "../src/subtitle-loader.mjs";
import { extractSubtitleWindow } from "../src/subtitle-loader.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveFfmpegPath } from "../src/ffmpeg-path.mjs";

test("字幕窗口恢复绝对时间，保留 cue 设置及正文中的时间", () => {
  assert.equal(offsetWebVtt("WEBVTT\n\n00:11.405 --> 00:17.661 align:start\n00:00.000 是正文\n", 60),
    "WEBVTT\n\n00:01:11.405 --> 00:01:17.661 align:start\n00:00.000 是正文\n");
});

test("同一字幕窗口并发只提取一次，切回缓存不再提取", async () => {
  const loader = new SubtitleLoader();
  let calls = 0;
  const operation = async () => { calls++; return { data: "WEBVTT" }; };
  await Promise.all([loader.load("2:60", operation), loader.load("2:60", operation)]);
  await loader.load("2:60", operation);
  assert.equal(calls, 1);
  loader.dispose();
});

test("真实 MKV 分段提取保留绝对时间，跳转后得到下一段 cue", async (t) => {
  const ffmpegPath = resolveFfmpegPath();
  if (!ffmpegPath) return t.skip("未安装系统 FFmpeg");
  const dir = await mkdtemp(join(tmpdir(), "companion-subtitles-"));
  try {
    const subtitle = join(dir, "text.srt"), media = join(dir, "media.mkv");
    await writeFile(subtitle, "1\n00:01:11,000 --> 00:01:16,000\nfirst\n\n2\n00:02:41,000 --> 00:02:46,000\nsecond\n");
    await promisify(execFile)(ffmpegPath, ["-v", "error", "-f", "lavfi", "-i", "color=size=32x32:rate=1:duration=200", "-i", subtitle, "-c:v", "libx264", "-g", "1", "-c:s", "srt", media]);
    const bytes = await readFile(media);
    const readRange = async ({ start, end }) => ({ bytes: bytes.subarray(start, Math.min((end ?? bytes.length - 1) + 1, bytes.length)), start, end: Math.min(end ?? bytes.length - 1, bytes.length - 1), total: bytes.length });
    const first = await extractSubtitleWindow({ readRange, index: 1, positionSeconds: 90, ffmpegPath });
    assert.deepEqual(first.window, { from: 60, until: 120 });
    assert.match(first.data, /00:01:11.000 --> 00:01:16.000/);
    assert.match(first.data, /first/);
    const next = await extractSubtitleWindow({ readRange, index: 1, positionSeconds: 160, ffmpegPath });
    assert.match(next.data, /00:02:41.000 --> 00:02:46.000/);
    assert.match(next.data, /second/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("切换字幕取消旧任务，失败不缓存，关闭播放取消提取并清缓存", async () => {
  const loader = new SubtitleLoader();
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const pending = loader.load("old", (signal) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    started();
  }));
  const rejected = assert.rejects(pending, { code: "CANCELLED" });
  await ready;
  await loader.load("new", async () => ({ data: "WEBVTT" }));
  await rejected;
  assert.equal(loader.cache.has("old"), false);
  await assert.rejects(loader.load("failed", async () => { throw new Error("offline"); }), /offline/);
  assert.equal(loader.cache.has("failed"), false);
  await loader.load("failed", async () => ({ data: "WEBVTT" }));
  loader.dispose();
  assert.equal(loader.cache.size, 0);
  await assert.rejects(loader.load("new", async () => ({})), { code: "CANCELLED" });
});
