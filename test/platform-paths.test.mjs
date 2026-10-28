import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { companionDataDir, isPathInside, searchPathCandidates } from "../src/platform/paths.mjs";
import { cliInvocation, codexCliCandidates } from "../scripts/install-plugin.mjs";

test("数据目录遵循各平台约定，且只接受绝对路径的环境变量", () => {
  assert.equal(companionDataDir("/Users/a", { platform: "darwin" }), "/Users/a/Library/Application Support/codex-companion");
  assert.equal(companionDataDir("/home/a", { platform: "linux", env: {} }), "/home/a/.config/codex-companion");
  assert.equal(companionDataDir("/home/a", { platform: "linux", env: { XDG_CONFIG_HOME: "/xdg" } }), "/xdg/codex-companion");
  assert.equal(companionDataDir("/home/a", { platform: "linux", env: { XDG_CONFIG_HOME: "relative" } }), "/home/a/.config/codex-companion");
});

test("isPathInside 只认严格子路径，不被同前缀目录或 .. 开头的名字误导", () => {
  assert.equal(isPathInside("/a/b/c", "/a/b", { platform: "linux" }), true);
  assert.equal(isPathInside("/a/b", "/a/b", { platform: "linux" }), false);
  assert.equal(isPathInside("/a/bc", "/a/b", { platform: "linux" }), false);
  assert.equal(isPathInside("/a", "/a/b", { platform: "linux" }), false);
  assert.equal(isPathInside("/a/b/..cache", "/a/b", { platform: "linux" }), true);
  assert.equal(isPathInside("C:\\Users\\a\\dist\\plugin", "C:\\Users\\a\\dist", { platform: "win32" }), true);
  assert.equal(isPathInside("D:\\dist\\plugin", "C:\\Users\\a\\dist", { platform: "win32" }), false);
});

test("PATH 查找兼容 Windows 的变量名大小写与带引号条目", () => {
  assert.deepEqual(searchPathCandidates(["codex"], { platform: "linux", env: { PATH: "/usr/bin::/opt/bin" } }), ["/usr/bin/codex", "/opt/bin/codex"]);
  assert.deepEqual(
    searchPathCandidates(["codex.exe", "codex.cmd"], { platform: "win32", env: { Path: "\"C:\\Program Files\\nodejs\";C:\\bin" } }),
    ["C:\\Program Files\\nodejs\\codex.exe", "C:\\Program Files\\nodejs\\codex.cmd", "C:\\bin\\codex.exe", "C:\\bin\\codex.cmd"]
  );
});

test("Codex CLI 候选：macOS 先用桌面端附带的 CLI，其它平台走 PATH", () => {
  const mac = codexCliCandidates({ platform: "darwin", env: { PATH: "/usr/local/bin" } });
  assert.match(mac[0], /^\/Applications\/ChatGPT\.app\//);
  assert.equal(mac.at(-1), "/usr/local/bin/codex");
  assert.deepEqual(codexCliCandidates({ platform: "linux", env: { PATH: "/usr/bin" } }), ["/usr/bin/codex"]);
  assert.deepEqual(codexCliCandidates({ platform: "win32", env: { PATH: "C:\\bin", APPDATA: "C:\\Users\\a\\AppData\\Roaming" } }),
    ["C:\\bin\\codex.exe", "C:\\bin\\codex.cmd", "C:\\Users\\a\\AppData\\Roaming\\npm\\codex.cmd"]);
});

test("Windows 的 .cmd CLI 经 cmd.exe 执行并整体加引号，拒绝会被 cmd 解释的参数", () => {
  assert.deepEqual(cliInvocation("/usr/bin/codex", ["plugin", "list"], { platform: "linux" }), { file: "/usr/bin/codex", args: ["plugin", "list"], options: {} });
  assert.deepEqual(cliInvocation("C:\\bin\\codex.exe", ["plugin"], { platform: "win32", env: {} }).file, "C:\\bin\\codex.exe");
  const invocation = cliInvocation("C:\\npm\\codex.cmd", ["plugin", "marketplace", "add", "C:\\My Plugins\\dist"], { platform: "win32", env: { ComSpec: "C:\\Windows\\system32\\cmd.exe" } });
  assert.deepEqual(invocation, {
    file: "C:\\Windows\\system32\\cmd.exe",
    args: ["/d", "/s", "/c", "\"\"C:\\npm\\codex.cmd\" \"plugin\" \"marketplace\" \"add\" \"C:\\My Plugins\\dist\"\""],
    options: { windowsVerbatimArguments: true }
  });
  assert.throws(() => cliInvocation("C:\\npm\\codex.cmd", ["add", "C:\\100%\\dist"], { platform: "win32", env: {} }), /cmd\.exe/);
});

test("package.json 与插件清单版本一致", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const manifest = JSON.parse(await readFile(new URL("../plugin/.codex-plugin/plugin.json", import.meta.url), "utf8"));
  assert.equal(pkg.version, manifest.version);
});

test("Windows 数据目录使用 APPDATA，未设置时回退到用户目录", () => {
  assert.equal(companionDataDir("C:\\Users\\a", { platform: "win32", env: { APPDATA: "D:\\Roaming" } }), "D:\\Roaming\\codex-companion");
  assert.equal(companionDataDir("C:\\Users\\a", { platform: "win32", env: {} }), "C:\\Users\\a\\AppData\\Roaming\\codex-companion");
});
