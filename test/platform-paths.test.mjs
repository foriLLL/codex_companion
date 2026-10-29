import assert from "node:assert/strict";
import test from "node:test";
import { companionDataDir, isPathInside, searchPathCandidates } from "../src/platform/paths.mjs";

test("数据目录遵循各平台约定，且只接受绝对路径的环境变量", () => {
  assert.equal(companionDataDir("/Users/a", { platform: "darwin" }), "/Users/a/Library/Application Support/codex-companion");
  assert.equal(companionDataDir("/home/a", { platform: "linux", env: {} }), "/home/a/.config/codex-companion");
  assert.equal(companionDataDir("/home/a", { platform: "linux", env: { XDG_CONFIG_HOME: "/xdg" } }), "/xdg/codex-companion");
  assert.equal(companionDataDir("/home/a", { platform: "linux", env: { XDG_CONFIG_HOME: "relative" } }), "/home/a/.config/codex-companion");
  // 未传 env 时，隔离 home 不受当前进程 XDG_CONFIG_HOME 影响
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = "/real-xdg";
  try { assert.equal(companionDataDir("/isolated/home", { platform: "linux" }), "/isolated/home/.config/codex-companion"); }
  finally { if (previous === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous; }
});

test("isPathInside 只认严格子路径，不被同前缀目录或 .. 开头的名字误导", () => {
  assert.equal(isPathInside("/a/b/c", "/a/b", { platform: "linux" }), true);
  assert.equal(isPathInside("/a/b", "/a/b", { platform: "linux" }), false);
  assert.equal(isPathInside("/a/bc", "/a/b", { platform: "linux" }), false);
  assert.equal(isPathInside("/a", "/a/b", { platform: "linux" }), false);
  assert.equal(isPathInside("/a/b/..cache", "/a/b", { platform: "linux" }), true);
  assert.equal(isPathInside("C:\\Users\\a\\dist\\app", "C:\\Users\\a\\dist", { platform: "win32" }), true);
  assert.equal(isPathInside("D:\\dist\\app", "C:\\Users\\a\\dist", { platform: "win32" }), false);
});

test("PATH 查找兼容 Windows 的变量名大小写与带引号条目", () => {
  assert.deepEqual(searchPathCandidates(["codex"], { platform: "linux", env: { PATH: "/usr/bin::/opt/bin" } }), ["/usr/bin/codex", "/opt/bin/codex"]);
  assert.deepEqual(
    searchPathCandidates(["codex.exe", "codex.cmd"], { platform: "win32", env: { Path: "\"C:\\Program Files\\nodejs\";C:\\bin" } }),
    ["C:\\Program Files\\nodejs\\codex.exe", "C:\\Program Files\\nodejs\\codex.cmd", "C:\\bin\\codex.exe", "C:\\bin\\codex.cmd"]
  );
});

test("Windows 数据目录使用 APPDATA，未设置时回退到用户目录", () => {
  assert.equal(companionDataDir("C:\\Users\\a", { platform: "win32", env: { APPDATA: "D:\\Roaming" } }), "D:\\Roaming\\codex-companion");
  assert.equal(companionDataDir("C:\\Users\\a", { platform: "win32", env: {} }), "C:\\Users\\a\\AppData\\Roaming\\codex-companion");
});
