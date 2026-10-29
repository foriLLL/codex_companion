import assert from "node:assert/strict";
import test from "node:test";
import { resolveFfmpegPath } from "../src/ffmpeg-path.mjs";

test("环境变量覆盖优先且必须存在", () => {
  const path = resolveFfmpegPath({
    platform: "darwin",
    env: { CODEX_COMPANION_FFMPEG: "/custom/ffmpeg" },
    execPath: "/anything/bin",
    fileExists: (p) => p === "/custom/ffmpeg"
  });
  assert.equal(path, "/custom/ffmpeg");
});

test("环境变量指向不存在文件时跳过", () => {
  const path = resolveFfmpegPath({
    platform: "darwin",
    env: { CODEX_COMPANION_FFMPEG: "/missing" },
    execPath: "/app/Contents/MacOS/launcher",
    fileExists: (p) => p === "/app/Contents/Resources/ffmpeg"
  });
  assert.equal(path, "/app/Contents/Resources/ffmpeg");
});

test("解析与二进制同级的 sidecar", () => {
  const path = resolveFfmpegPath({
    platform: "darwin",
    env: {},
    execPath: "/opt/tool/codex-companion",
    fileExists: (p) => p === "/opt/tool/ffmpeg"
  });
  assert.equal(path, "/opt/tool/ffmpeg");
});

test("解析 .app Resources 下的 sidecar", () => {
  const path = resolveFfmpegPath({
    platform: "darwin",
    env: {},
    execPath: "/Applications/Codex Companion.app/Contents/MacOS/launcher",
    fileExists: (p) => p === "/Applications/Codex Companion.app/Contents/Resources/ffmpeg"
  });
  assert.equal(path, "/Applications/Codex Companion.app/Contents/Resources/ffmpeg");
});

test("从 PATH 解析系统 FFmpeg", () => {
  const path = resolveFfmpegPath({
    platform: "darwin",
    env: { PATH: "/usr/bin:/opt/tools/bin" },
    execPath: "/usr/local/bin/node",
    fileExists: (p) => p === "/opt/tools/bin/ffmpeg"
  });
  assert.equal(path, "/opt/tools/bin/ffmpeg");
});

test("GUI 的精简 PATH 下仍能发现 Homebrew FFmpeg", () => {
  const path = resolveFfmpegPath({
    platform: "darwin",
    env: { PATH: "/usr/bin:/bin" },
    execPath: "/Applications/Codex Companion.app/Contents/Resources/codex-companion",
    fileExists: (p) => p === "/opt/homebrew/bin/ffmpeg"
  });
  assert.equal(path, "/opt/homebrew/bin/ffmpeg");
});

test("全部缺失时返回 null", () => {
  const path = resolveFfmpegPath({
    platform: "darwin",
    env: {},
    execPath: "/usr/local/bin/node",
    fileExists: () => false
  });
  assert.equal(path, null);
});

test("Linux 精简 PATH 下发现发行版与 Snap 安装的 FFmpeg", () => {
  assert.equal(resolveFfmpegPath({
    platform: "linux",
    env: { PATH: "/bin" },
    execPath: "/opt/companion/codex-companion",
    fileExists: (p) => p === "/snap/bin/ffmpeg"
  }), "/snap/bin/ffmpeg");
});

test("Windows 按 Path 查找 ffmpeg.exe，并识别 winget/Scoop 安装位置", () => {
  assert.equal(resolveFfmpegPath({
    platform: "win32",
    env: { Path: "C:\\Windows\\System32;\"C:\\Tools\\ffmpeg\\bin\"" },
    execPath: "C:\\Companion\\codex-companion.exe",
    fileExists: (p) => p === "C:\\Tools\\ffmpeg\\bin\\ffmpeg.exe"
  }), "C:\\Tools\\ffmpeg\\bin\\ffmpeg.exe");
  assert.equal(resolveFfmpegPath({
    platform: "win32",
    env: { Path: "C:\\Windows", LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local", USERPROFILE: "C:\\Users\\me" },
    execPath: "C:\\Companion\\codex-companion.exe",
    fileExists: (p) => p === "C:\\Users\\me\\scoop\\shims\\ffmpeg.exe"
  }), "C:\\Users\\me\\scoop\\shims\\ffmpeg.exe");
  assert.equal(resolveFfmpegPath({ platform: "win32", env: {}, execPath: "C:\\x\\a.exe", fileExists: () => false }), null);
});
