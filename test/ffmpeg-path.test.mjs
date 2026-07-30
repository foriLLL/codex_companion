import assert from "node:assert/strict";
import test from "node:test";
import { resolveFfmpegPath } from "../src/ffmpeg-path.mjs";

test("环境变量覆盖优先且必须存在", () => {
  const path = resolveFfmpegPath({
    env: { CODEX_COMPANION_FFMPEG: "/custom/ffmpeg" },
    execPath: "/anything/bin",
    fileExists: (p) => p === "/custom/ffmpeg"
  });
  assert.equal(path, "/custom/ffmpeg");
});

test("环境变量指向不存在文件时跳过", () => {
  const path = resolveFfmpegPath({
    env: { CODEX_COMPANION_FFMPEG: "/missing" },
    execPath: "/app/Contents/MacOS/launcher",
    fileExists: (p) => p === "/app/Contents/Resources/ffmpeg"
  });
  assert.equal(path, "/app/Contents/Resources/ffmpeg");
});

test("解析与二进制同级的 sidecar", () => {
  const path = resolveFfmpegPath({
    env: {},
    execPath: "/opt/tool/codex-companion",
    fileExists: (p) => p === "/opt/tool/ffmpeg"
  });
  assert.equal(path, "/opt/tool/ffmpeg");
});

test("解析 .app Resources 下的 sidecar", () => {
  const path = resolveFfmpegPath({
    env: {},
    execPath: "/Applications/Codex Companion.app/Contents/MacOS/launcher",
    fileExists: (p) => p === "/Applications/Codex Companion.app/Contents/Resources/ffmpeg"
  });
  assert.equal(path, "/Applications/Codex Companion.app/Contents/Resources/ffmpeg");
});

test("从 PATH 解析系统 FFmpeg", () => {
  const path = resolveFfmpegPath({
    env: { PATH: "/usr/bin:/opt/tools/bin" },
    execPath: "/usr/local/bin/node",
    fileExists: (p) => p === "/opt/tools/bin/ffmpeg"
  });
  assert.equal(path, "/opt/tools/bin/ffmpeg");
});

test("GUI 的精简 PATH 下仍能发现 Homebrew FFmpeg", () => {
  const path = resolveFfmpegPath({
    env: { PATH: "/usr/bin:/bin" },
    execPath: "/Applications/Codex Companion.app/Contents/Resources/codex-companion",
    fileExists: (p) => p === "/opt/homebrew/bin/ffmpeg"
  });
  assert.equal(path, "/opt/homebrew/bin/ffmpeg");
});

test("全部缺失时返回 null", () => {
  const path = resolveFfmpegPath({
    env: {},
    execPath: "/usr/local/bin/node",
    fileExists: () => false
  });
  assert.equal(path, null);
});
