import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdtemp, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildNative } from "./build-native.mjs";
import { createNativeBridge } from "../src/agent/native-bridge.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const fixture = join(repoRoot, "scripts/fixtures/native-dummy-app");
const forbiddenApp = "/Applications/ChatGPT.app";
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

export async function assertSafeSmokeApp(appPath, {
  readBundleId = async (path) => (await execFileAsync("/usr/bin/plutil", [
    "-extract", "CFBundleIdentifier", "raw", "-o", "-", join(path, "Contents/Info.plist")
  ])).stdout.trim()
} = {}) {
  const rejectReal = (path) => {
    if (path === forbiddenApp || path.startsWith(`${forbiddenApp}/`)) throw new Error("禁止对真实 Codex 运行冒烟");
  };
  const absolute = resolve(appPath);
  rejectReal(absolute);
  const canonical = await realpath(absolute);
  rejectReal(canonical);
  const bundleId = await readBundleId(canonical);
  if (bundleId === "com.openai.codex") throw new Error("禁止对真实 Codex bundle id 运行冒烟");
  if (bundleId !== "local.codexcompanion.dummy") throw new Error("冒烟仅允许 local.codexcompanion.dummy");
  return canonical;
}

async function main() {
  let interactive = false;
  let suppliedApp;
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--interactive" && !interactive) interactive = true;
    else if (args[index] === "--app" && !suppliedApp && args[index + 1]) suppliedApp = args[++index];
    else throw new Error("用法：node scripts/smoke-native.mjs [--interactive]（只运行临时编译的 dummy app）");
  }
  if (suppliedApp) {
    await assertSafeSmokeApp(suppliedApp);
    throw new Error("冒烟只运行脚本在临时目录编译的 dummy app，不接管已有应用");
  }
  if (process.platform !== "darwin") throw new Error("原生冒烟需要 macOS GUI 会话");
  const root = await mkdtemp(join(tmpdir(), "companion-native-smoke-"));
  const appPath = join(root, "Companion Native Dummy.app");
  const helperPath = join(root, "companion-native");
  const recordPath = join(root, "record.json");
  const smokeEnvironment = { ...process.env };
  // 不让调用者遗留的测试变量把记录写到临时目录之外。
  for (const key of ["DUMMY_APP_RECORD", "DUMMY_OVERRIDE", "DUMMY_EMPTY", "DUMMY_PARENT_ONLY", "DUMMY_UNSET_SENTINEL"]) delete smokeEnvironment[key];
  const report = { mode: interactive ? "interactive" : "default", tests: 0, pass: 0, fail: 0, nativeGuards: null, environment: null };
  const children = new Set();
  const snapshots = [];
  const exits = [];
  let watcher;
  let bridge;
  let interrupted = false;
  const interrupt = () => { interrupted = true; };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  async function waitFor(predicate, label, timeoutMs = 10_000, cleaning = false) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (interrupted && !cleaning) throw new Error("冒烟被中断");
      const value = await predicate();
      if (value) return value;
      await delay(50);
    }
    throw new Error(`${label} 超时（需要当前用户的 macOS GUI 会话）`);
  }
  async function check(name, run) {
    report.tests += 1;
    try {
      if (interrupted) throw new Error("冒烟被中断");
      await run();
      report.pass += 1;
      console.log(`[smoke-native] PASS ${name}`);
    } catch (error) {
      report.fail += 1;
      throw new Error(`${name}: ${error.message}`, { cause: error });
    }
  }
  async function record(path = recordPath) {
    return waitFor(async () => {
      try { return JSON.parse(await readFile(path, "utf8")); }
      catch (error) { if (error.code === "ENOENT") return null; throw error; }
    }, "dummy record");
  }
  async function quitAll(cleaning = false) {
    for (const app of (await bridge.snapshot()).apps) {
      const result = await bridge.quit({ ...app, mode: "user" });
      assert.equal(result.accepted, true, JSON.stringify(result));
    }
    await waitFor(async () => (await bridge.snapshot()).apps.length === 0, "dummy terminate", 10_000, cleaning);
  }
  const managedSpawn = (...values) => {
    const child = spawn(...values);
    children.add(child);
    child.once("close", () => children.delete(child));
    return child;
  };
  try {
    console.log(`[smoke-native] 编译临时助手与 dummy（${process.arch}，${report.mode}）`);
    await buildNative({ outputPath: helperPath });
    const macos = join(appPath, "Contents/MacOS");
    await mkdir(macos, { recursive: true });
    await cp(join(fixture, "Info.plist"), join(appPath, "Contents/Info.plist"));
    const swiftOptions = ["-O", "-parse-as-library", "-target", process.arch === "arm64" ? "arm64-apple-macos13" : "x86_64-apple-macos13", "-framework", "AppKit"];
    await execFileAsync("swiftc", [...swiftOptions, join(fixture, "DummyApp.swift"), "-o", join(macos, "native-dummy")], { timeout: 120_000 });
    const probePath = join(root, "environment-probe");
    await execFileAsync("swiftc", [...swiftOptions, join(fixture, "EnvironmentProbe.swift"), "-o", probePath], { timeout: 120_000 });
    const guardPath = join(root, "guard-checks");
    await execFileAsync("swiftc", [...swiftOptions, join(repoRoot, "packaging/mac-app/Native/NativeGuards.swift"),
      join(fixture, "GuardChecks.swift"), "-o", guardPath], { timeout: 120_000 });
    await assertSafeSmokeApp(appPath);
    bridge = createNativeBridge({ helperPath, appPath, spawnImpl: managedSpawn,
      execFileImpl: (file, argv, options) => execFileAsync(file, argv, {
        ...options, env: { ...smokeEnvironment, DUMMY_PARENT_ONLY: "native-parent", DUMMY_OVERRIDE: "parent", DUMMY_UNSET_SENTINEL: "remove-me" }
      })
    });
    await check("Swift fresh/context/launch 守卫分支", async () => {
      report.nativeGuards = JSON.parse((await execFileAsync(guardPath)).stdout);
      assert.equal(report.nativeGuards.fail, 0);
    });
    await check("version", async () => {
      assert.match(JSON.parse((await execFileAsync(helperPath, ["--version"])).stdout).version, /^\d+\.\d+\.\d+$/);
    });
    await check("snapshot 无目标实例", async () => assert.deepEqual((await bridge.snapshot()).apps, []));
    await check("watch 初始快照", async () => {
      watcher = bridge.watch({ onSnapshot: (value) => snapshots.push(value), onExit: (error) => exits.push(error) });
      await waitFor(() => snapshots.length > 0, "watch initial");
      assert.deepEqual(snapshots[0].apps, []);
    });
    await check("launch 拒绝输入变化", async () => {
      const state = await bridge.snapshot();
      assert.deepEqual(await bridge.launch({ args: [], hidden: true, inputStamp: "changed", frontmostPid: state.frontmostPid }),
        { launched: false, reason: "input-changed" });
    });
    await check("launch 拒绝前台变化", async () => {
      const state = await bridge.snapshot();
      const result = await bridge.launch({ args: [], hidden: true, inputStamp: state.inputStamp, frontmostPid: state.frontmostPid === 0 ? 1 : 0 });
      assert.equal(result.launched, false);
      assert.ok(["frontmost-changed", "input-changed"].includes(result.reason));
    });
    await check("最小参数隐藏启动", async () => {
      const baselineRecord = join(root, "baseline.json");
      const result = await bridge.launch({ args: ["--record", baselineRecord], hidden: true });
      assert.equal(result.launched, true, JSON.stringify(result));
      const value = await record(baselineRecord);
      assert.equal(value.pid, result.pid);
      assert.equal(value.environment.DUMMY_UNSET_SENTINEL, "remove-me");
      await quitAll();
    });
    // Cocoa 会把裸文本参数当成待打开文档，改变隐藏状态；这里只传测试应用的选项。
    const launchArgs = ["--record", recordPath, "--smoke"];
    let launched;
    await check("launch --hidden", async () => {
      launched = await bridge.launch({ args: launchArgs, hidden: true,
        env: { DUMMY_APP_RECORD: recordPath, DUMMY_OVERRIDE: "覆盖 = value", DUMMY_EMPTY: "" }, unsetEnv: ["DUMMY_UNSET_SENTINEL"] });
      assert.equal(launched.launched, true, JSON.stringify(launched));
      assert.equal(typeof launched.finishedLaunching, "boolean");
      assert.equal(typeof launched.hidden, "boolean");
    });
    await check("dummy argv/env 透传及父环境保留", async () => {
      const value = await record();
      assert.deepEqual(value.argv.slice(1), launchArgs);
      assert.equal(value.environment.DUMMY_OVERRIDE, "覆盖 = value");
      assert.equal(value.environment.DUMMY_EMPTY, "");
      assert.equal(value.environment.DUMMY_PARENT_ONLY, "native-parent");
      assert.equal(value.pid, launched.pid);
    });
    await check("unsetEnv 删除父环境哨兵", async () => {
      const value = await record();
      assert.equal(Object.hasOwn(value.environment, "DUMMY_UNSET_SENTINEL"), false);
      report.unsetEnvironment = { parentSentinelPresentBefore: true, childSentinelPresentAfter: false };
    });
    await check("hidden 未激活 dummy", async () => {
      const value = await record();
      report.hidden = { requested: true, reported: launched.hidden, hidden: value.hidden, active: value.active, everActive: value.everActive };
      console.log(`[smoke-native] hidden ${JSON.stringify(report.hidden)}`);
      assert.equal(value.active, false);
      assert.equal(value.everActive, false);
      assert.notEqual((await bridge.snapshot()).frontmostPid, launched.pid);
    });
    await check("snapshot key/finishedLaunching/sysctl argv", async () => {
      const value = await waitFor(async () => (await bridge.snapshot()).apps.find((app) => app.finishedLaunching), "finishedLaunching");
      assert.equal(value.key, launched.key);
      assert.deepEqual(value.arguments, launchArgs);
    });
    await check("watch launch/finishedLaunching", async () => {
      await waitFor(() => snapshots.some((value) => value.apps.some((app) => app.key === launched.key && app.finishedLaunching)), "watch launch");
    });
    await check("launch 已运行时拒绝", async () => {
      assert.deepEqual(await bridge.launch({ args: [], hidden: true }), { launched: false, reason: "already-running" });
    });
    for (const mode of ["fresh", "user"]) {
      await check(`quit ${mode} key 不匹配`, async () => {
        assert.deepEqual(await bridge.quit({ ...launched, key: `${launched.pid}:0`, mode, inputStamp: "0:0:0:0:0" }),
          { accepted: false, reason: "key-mismatch" });
      });
    }
    await check("fresh age 超窗拒绝", async () => {
      const state = await bridge.snapshot();
      assert.deepEqual(await bridge.quit({ ...launched, mode: "fresh", inputStamp: state.inputStamp, maxAgeMs: 0 }),
        { accepted: false, reason: "age-out-of-range" });
    });
    await check("fresh inputStamp 不一致拒绝", async () => {
      assert.deepEqual(await bridge.quit({ ...launched, mode: "fresh", inputStamp: "changed", maxAgeMs: 60_000 }),
        { accepted: false, reason: "input-changed" });
    });
    await check("fresh 后台/已有输入拒绝", async () => {
      const state = await bridge.snapshot();
      const result = await bridge.quit({ ...launched, mode: "fresh", inputStamp: state.inputStamp, maxAgeMs: 60_000 });
      assert.equal(result.accepted, false);
      assert.ok(["not-frontmost", "input-since-launch", "input-changed"].includes(result.reason));
    });
    const beforeQuit = snapshots.length;
    await check("quit user 正常退出", () => quitAll());
    await check("watch terminate", async () => {
      await waitFor(() => snapshots.slice(beforeQuit).some((value) => value.apps.length === 0), "watch terminate");
      assert.equal(exits.length, 0);
    });
    await check("原始 NSWorkspace environment 合并/替换实测", async () => {
      const records = {};
      for (const mode of ["default", "override"]) {
        const path = join(root, `environment-${mode}.json`);
        await execFileAsync(probePath, [appPath, path, mode], {
          timeout: 20_000, env: { ...smokeEnvironment, DUMMY_PARENT_ONLY: "raw-parent" }
        });
        records[mode] = await record(path);
        assert.equal(records[mode].everActive, false);
        await quitAll();
      }
      const baseline = records.default.environment;
      const overridden = records.override.environment;
      assert.equal(overridden.DUMMY_OVERRIDE, "raw-api");
      const missing = Object.keys(baseline).filter((key) => !(key in overridden));
      report.environment = { behavior: missing.length > 0 ? "replacement" : "merge",
        defaultKeyCount: Object.keys(baseline).length, overrideKeyCount: Object.keys(overridden).length,
        missingDefaultKeys: missing.sort(), parentSentinelInDefault: baseline.DUMMY_PARENT_ONLY === "raw-parent",
        parentSentinelInOverride: overridden.DUMMY_PARENT_ONLY === "raw-parent",
        defaultHidden: records.default.hidden, overrideHidden: records.override.hidden };
      console.log(`[smoke-native] environment ${JSON.stringify(report.environment)}`);
    });
    for (const ending of ["EOF", "SIGTERM", "unexpected-input"]) {
      await check(`原生 watch ${ending} 退出`, async () => {
        const child = managedSpawn(helperPath, ["watch", "--app", appPath], { stdio: ["pipe", "pipe", "pipe"] });
        let output = "";
        child.stdout.on("data", (data) => { output += data; });
        child.stderr.resume();
        const closed = once(child, "close");
        await waitFor(() => output.includes("\n"), `watch ${ending} initial`);
        if (ending === "EOF") child.stdin.end();
        else if (ending === "SIGTERM") child.kill("SIGTERM");
        else child.stdin.write("lifecycle-channel-is-not-a-command-stream");
        await waitFor(() => child.exitCode !== null || child.signalCode !== null, `watch ${ending} close`);
        assert.deepEqual(await closed, [0, null]);
      });
    }
    await check("用法错误为 JSON + exit 2", async () => {
      for (const argv of [["unknown"], ["launch", "--args-json", "{}"], ["quit", "--pid", "1", "--key", "1:0", "--mode", "fresh"]]) {
        await assert.rejects(execFileAsync(helperPath, [...argv, "--app", appPath]), (error) => {
          assert.equal(error.code, 2);
          assert.equal(typeof JSON.parse(error.stdout).error, "string");
          return true;
        });
      }
    });
    await check("环境删除的类型、键名和重叠项校验", async () => {
      const invalid = ["{", "{}", "null", "[1]", ...["", "BAD=KEY", "BAD\0KEY"].map((key) => JSON.stringify([key]))];
      const cases = invalid.map((raw) => [["--unset-env-json", raw], "invalid-unset-env-json"]);
      for (const key of ["", "BAD=KEY", "BAD\0KEY"]) cases.push([["--env-json", JSON.stringify({ [key]: "value" })], "invalid-env-json"]);
      for (const value of ["", "override"]) cases.push([["--env-json", JSON.stringify({ DUMMY_UNSET_SENTINEL: value }),
        "--unset-env-json", JSON.stringify(["DUMMY_UNSET_SENTINEL"])], "conflicting-env-keys"]);
      for (const [options, expected] of cases) {
        await assert.rejects(execFileAsync(helperPath, ["launch", "--app", appPath, "--args-json", "[]", "--hidden", ...options]), (error) => {
          assert.equal(error.code, 2);
          assert.deepEqual(JSON.parse(error.stdout), { error: expected });
          return true;
        });
      }
      assert.deepEqual((await bridge.snapshot()).apps, []);
    });
    if (interactive) {
      await check("interactive show 与 fresh 成功", async () => {
        const before = await bridge.snapshot();
        const app = await bridge.launch({ args: ["--window"], hidden: true,
          env: { DUMMY_APP_RECORD: join(root, "interactive.json") } });
        assert.equal(app.launched, true);
        assert.deepEqual(await bridge.show({ ...app, inputStamp: before.inputStamp, frontmostPid: before.frontmostPid }), { shown: true }, "show 未成功");
        await waitFor(async () => { const value = await bridge.snapshot(); return value.frontmostPid === app.pid && value.apps[0]?.finishedLaunching; }, "show active");
        assert.deepEqual(await bridge.quit({ ...app, mode: "fresh", inputStamp: before.inputStamp }), { accepted: true });
        await waitFor(async () => (await bridge.snapshot()).apps.length === 0, "fresh terminate");
      });
    }
  } finally {
    watcher?.close();
    for (const child of children) {
      child.stdin?.end();
      child.kill("SIGTERM");
    }
    try {
      if (bridge) await quitAll(true);
      await waitFor(() => children.size === 0, "watch cleanup", 5000, true);
      report.dummyProcessesRemaining = 0;
    } finally {
      await rm(root, { recursive: true, force: true });
      report.temporaryDirectoryRemoved = true;
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", interrupt);
      console.log(`[smoke-native] ${JSON.stringify(report)}`);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[smoke-native] FAIL ${error.message}`);
    process.exitCode = 1;
  });
}
