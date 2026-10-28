import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginLauncher, runCodexHandoff, CODEX_RELAUNCH_DELAY_MS } from "../src/plugin/launcher.mjs";
import { DEFAULT_CODEX_EXECUTABLE } from "../src/launcher.mjs";
import { CompanionConfig, normalizeCompanionConfigV2 } from "../src/companion-config.mjs";
import { assertMode } from "./helpers/permissions.mjs";

function fakeChild(calls) {
  const child = new EventEmitter();
  child.unref = () => calls.push({ unref: true });
  queueMicrotask(() => child.emit("spawn"));
  return child;
}

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "companion-launcher-test-"));
  const defaultsCalls = [];
  const spawns = [];
  const launcher = new PluginLauncher({
    configPath: join(directory, "custom-config.json"), helperCommand: "/test/companion-backend", helperPrefix: [],
    execFileImpl: async (command, args) => {
      defaultsCalls.push({ command, args });
      return { stdout: args[2] === "launchThroughProxy" ? "1\n" : "10809\n" };
    },
    inspectImpl: async executable => { assert.equal(executable, DEFAULT_CODEX_EXECUTABLE); return [{ pid: 123, proxyPort: null }]; },
    spawnImpl: (command, args, options) => { spawns.push({ command, args, options }); return fakeChild(spawns); },
    platform: "darwin",
    ...options
  });
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { launcher, directory, defaultsCalls, spawns };
}

test("启动偏好首次导入旧 Swift 域，存入 config-v2，保存端口不启动或停止任何进程", async t => {
  const { launcher, directory, defaultsCalls, spawns } = await fixture(t);
  const initial = await launcher.status();
  assert.deepEqual(initial.preferences, { launchThroughProxy: true, proxyPort: 10809 });
  assert.equal(defaultsCalls.length, 2);
  assert.deepEqual(await launcher.load(), { version: 1, revision: 0, preferences: initial.preferences });
  for (const call of defaultsCalls) {
    assert.equal(call.command, "/usr/bin/defaults");
    assert.equal(call.args[0], "read");
    assert.equal(call.args[1], "com.codexcompanion.launcher");
  }
  const saved = await launcher.save({ launchThroughProxy: false, proxyPort: 7890 }, { expectedRevision: 0 });
  assert.equal(saved.revision, 1);
  assert.deepEqual(saved.preferences, { launchThroughProxy: false, proxyPort: 7890 });
  assert.equal(spawns.length, 0);
  assert.equal(defaultsCalls.length, 2);
  assertMode(await stat(launcher.path), 0o600);
  const config = JSON.parse(await readFile(launcher.configPath, "utf8"));
  assert.equal(config.revision, 1);
  assert.equal(config.version, 2);
  assert.deepEqual(config.launch, { proxy: { enabled: false, port: 7890 } });
  await assert.rejects(stat(join(directory, "plugin-launcher.json")), { code: "ENOENT" });
  await assert.rejects(launcher.save({ launchThroughProxy: true, proxyPort: 7890 }, { expectedRevision: 0 }), { code: "CONFIG_CONFLICT" });
  for (const preferences of [
    { launchThroughProxy: true, proxyPort: 0 }, { launchThroughProxy: true, proxyPort: 65536 },
    { launchThroughProxy: true, proxyPort: 1.5 }, { launchThroughProxy: "yes", proxyPort: 7890 },
    { launchThroughProxy: true, proxyPort: 7890, host: "0.0.0.0" }
  ]) await assert.rejects(launcher.save(preferences), { code: "LAUNCHER_INVALID" });
});

test("PluginLauncher load 使用配置 revision，迁移不删除旧文件，save 只更新 launch.proxy", async t => {
  const { launcher, directory, defaultsCalls } = await fixture(t);
  const config = normalizeCompanionConfigV2({ version: 2, revision: 12, agent: { autoRelaunch: false } });
  config.cards.games.settings = { sound: false };
  delete config.launch;
  const original = JSON.stringify(config);
  await writeFile(launcher.configPath, original);
  const oldPath = join(directory, "plugin-launcher.json");
  const oldPreferences = JSON.stringify({ version: 1, revision: 99, preferences: { launchThroughProxy: true, proxyPort: 1080 } });
  await writeFile(oldPath, oldPreferences);
  const loaded = await launcher.load();
  assert.deepEqual(loaded, { version: 1, revision: 12, preferences: { launchThroughProxy: true, proxyPort: 1080 } });
  assert.equal(await readFile(launcher.configPath, "utf8"), original);
  assert.equal(defaultsCalls.length, 0);
  const saved = await launcher.save({ launchThroughProxy: false, proxyPort: 7891 }, { expectedRevision: loaded.revision });
  assert.equal(saved.revision, 13);
  const stored = JSON.parse(await readFile(launcher.configPath, "utf8"));
  assert.deepEqual(stored, { ...config, revision: 13, launch: { proxy: { enabled: false, port: 7891 } } });
  assert.equal(await readFile(oldPath, "utf8"), oldPreferences);
  assert.deepEqual(await launcher.load(), { version: 1, revision: 13, preferences: saved.preferences });
});

test("PluginLauncher 与配置写入者共享 revision，旧卡片或启动设置提交均冲突且可刷新重试", async t => {
  const { launcher } = await fixture(t);
  const store = new CompanionConfig({ path: launcher.configPath, execFileImpl: async () => ({ stdout: "" }) });
  const initial = await launcher.load();
  const config = await store.patch({ cards: { games: { enabled: false } }, agent: { autoRelaunch: false } }, { expectedRevision: initial.revision });
  await assert.rejects(launcher.save({ launchThroughProxy: false, proxyPort: 7891 }, { expectedRevision: initial.revision }), { code: "CONFIG_CONFLICT", revision: config.revision });
  assert.deepEqual(await store.loadV2(), config);
  const refreshed = await launcher.load();
  const saved = await launcher.save({ launchThroughProxy: false, proxyPort: 7891 }, { expectedRevision: refreshed.revision });
  await assert.rejects(store.patch({ enabled: false }, { expectedRevision: config.revision }), { code: "CONFIG_CONFLICT", revision: saved.revision });
  const latest = await store.loadV2();
  assert.equal(latest.cards.games.enabled, false);
  assert.equal(latest.agent.autoRelaunch, false);
  assert.deepEqual(latest.launch, { proxy: { enabled: false, port: 7891 } });
  assert.equal(latest.revision, 2);
  const optionalRevision = await launcher.save({ launchThroughProxy: true, proxyPort: 7891 });
  assert.equal(optionalRevision.revision, 3);
});

test("PluginLauncher 与配置并发写入同 revision，锁保证仅一方成功", async t => {
  const { launcher } = await fixture(t);
  const initial = await launcher.load();
  const store = new CompanionConfig({ path: launcher.configPath, execFileImpl: async () => ({ stdout: "" }) });
  const results = await Promise.allSettled([
    launcher.save({ launchThroughProxy: false, proxyPort: 7891 }, { expectedRevision: initial.revision }),
    store.patch({ agent: { autoRelaunch: false } }, { expectedRevision: initial.revision })
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.find(result => result.status === "rejected").reason.code, "CONFIG_CONFLICT");
  const latest = await store.loadV2();
  assert.equal(latest.revision, 1);
  if (results[0].status === "fulfilled") {
    assert.deepEqual(latest.launch, { proxy: { enabled: false, port: 7891 } });
    assert.equal(latest.agent.autoRelaunch, true);
  } else {
    assert.deepEqual(latest.launch, { proxy: { enabled: true, port: 10809 } });
    assert.equal(latest.agent.autoRelaunch, false);
  }
});

test("PluginLauncher 严格读取损坏或消失配置，禁止覆盖；revision 上限仍拒绝写入", async t => {
  const { launcher } = await fixture(t);
  await launcher.load();
  await writeFile(launcher.configPath, "{broken");
  await assert.rejects(launcher.load(), { code: "CONFIG_INVALID" });
  await assert.rejects(launcher.save({ launchThroughProxy: false, proxyPort: 7890 }), { code: "CONFIG_INVALID" });
  assert.equal(await readFile(launcher.configPath, "utf8"), "{broken");
  await rm(launcher.configPath);
  await assert.rejects(launcher.load(), { code: "CONFIG_MISSING" });
  await assert.rejects(launcher.save({ launchThroughProxy: false, proxyPort: 7890 }), { code: "CONFIG_MISSING" });
  await assert.rejects(stat(launcher.configPath), { code: "ENOENT" });
  const original = JSON.stringify(normalizeCompanionConfigV2({ version: 2, revision: Number.MAX_SAFE_INTEGER }));
  await writeFile(launcher.configPath, original);
  await assert.rejects(launcher.save({ launchThroughProxy: false, proxyPort: 7890 }), { code: "LAUNCHER_INVALID" });
  assert.equal(await readFile(launcher.configPath, "utf8"), original);
});

test("只有显式 relaunch/stop 安排固定 helper，同步并发不会产生两个退出任务", async t => {
  const { launcher, spawns } = await fixture(t);
  const scheduling = launcher.schedule("relaunch");
  await assert.rejects(launcher.schedule("stop"), { code: "LAUNCHER_BUSY" });
  assert.deepEqual(await scheduling, { scheduled: true, delayMs: CODEX_RELAUNCH_DELAY_MS });
  assert.equal(spawns[0].command, "/test/companion-backend");
  assert.deepEqual(spawns[0].args, ["--relaunch-codex", "123", "10809"]);
  assert.equal(spawns[0].options.detached, true);
  assert.equal(spawns[0].options.stdio, "ignore");
  assert.equal(spawns[0].options.env.CODEX_COMPANION_CONFIG_PATH, launcher.configPath);
  const stopped = await fixture(t);
  await stopped.launcher.schedule("stop");
  assert.equal(stopped.spawns[0].args[0], "--stop-codex");
  const absent = await fixture(t, { inspectImpl: async () => [] });
  assert.deepEqual(await absent.launcher.schedule("stop"), { scheduled: false, reason: "not-running" });
  assert.equal(absent.spawns.length, 0);
  const multiple = await fixture(t, { inspectImpl: async () => [{ pid: 1 }, { pid: 2 }] });
  await assert.rejects(multiple.launcher.schedule(), { code: "LAUNCHER_AMBIGUOUS" });
  assert.equal(multiple.spawns.length, 0);
});

test("handoff 重新确认主进程，仅发 SIGTERM，完全退出后带 loopback 代理启动且无 CDP", async () => {
  const events = [];
  let inspections = 0;
  const preferences = { launchThroughProxy: true, proxyPort: 7890 };
  const result = await runCodexHandoff({
    expectedPid: 123, preferences,
    loadAgentConfig: async () => ({ agent: { autoRelaunch: false } }),
    inspectImpl: async executable => { assert.equal(executable, DEFAULT_CODEX_EXECUTABLE); events.push("inspect"); return inspections++ === 0 ? [{ pid: 123 }] : []; },
    killImpl: (pid, signal) => events.push({ pid, signal }),
    sleepImpl: async ms => events.push({ sleep: ms }),
    spawnImpl: (command, args, options) => { events.push({ command, args, options }); return fakeChild(events); },
    environment: { HTTP_PROXY: "old", ALL_PROXY: "old", https_proxy: "old", KEEP_ME: "yes", ELECTRON_RUN_AS_NODE: "1" }
  });
  assert.deepEqual(result, { stopped: true, launched: true });
  assert.deepEqual(events[0], { sleep: 750 });
  assert.deepEqual(events[2], { pid: 123, signal: "SIGTERM" });
  const launched = events.find(event => event.command);
  assert.equal(launched.command, DEFAULT_CODEX_EXECUTABLE);
  assert.deepEqual(launched.args, ["--proxy-server=http://127.0.0.1:7890", "--proxy-bypass-list=<local>;10.0.0.0/8;172.16.0.0/12;192.168.0.0/16"]);
  assert.ok(!launched.args.some(arg => arg.includes("debugging")));
  assert.deepEqual(launched.options.env, { KEEP_ME: "yes", HTTP_PROXY: "http://127.0.0.1:7890", HTTPS_PROXY: "http://127.0.0.1:7890" });
  assert.ok(events.findIndex(event => event.command) > events.lastIndexOf("inspect"));
});

test("handoff 进程变化或拒绝退出时不重复启动、不强杀；stop 不启动", async () => {
  let now = 0;
  const killed = [];
  let launched = false;
  const common = {
    preferences: { launchThroughProxy: false, proxyPort: 7890 }, expectedPid: 123,
    loadAgentConfig: async () => ({ agent: { autoRelaunch: false } }),
    sleepImpl: async ms => { now += ms; }, now: () => now, timeoutMs: 200,
    killImpl: (pid, signal) => killed.push({ pid, signal }),
    spawnImpl: () => { launched = true; return fakeChild([]); }
  };
  await assert.rejects(runCodexHandoff({ ...common, inspectImpl: async () => [{ pid: 999 }] }), { code: "LAUNCHER_PROCESS_CHANGED" });
  assert.equal(killed.length, 0);
  await assert.rejects(runCodexHandoff({ ...common, inspectImpl: async () => [{ pid: 123 }] }), { code: "LAUNCHER_STOP_TIMEOUT" });
  assert.deepEqual(killed, [{ pid: 123, signal: "SIGTERM" }]);
  assert.equal(launched, false);
  let count = 0;
  const stopped = await runCodexHandoff({ ...common, action: "stop", inspectImpl: async () => count++ === 0 ? [{ pid: 123 }] : [] });
  assert.deepEqual(stopped, { stopped: true, launched: false });
  assert.equal(launched, false);
});

test("handoff 自动加载开启时直接携带随机 loopback CDP 参数，关闭时不分配端口", async t => {
  for (const enabled of [true, false]) {
    const { launcher } = await fixture(t);
    await launcher.load();
    const state = await launcher.file.loadV2();
    await launcher.file.patch({ agent: { autoRelaunch: enabled } }, { expectedRevision: state.revision });
    const calls = [];
    let reserved = 0;
    await runCodexHandoff({ launcher, expectedPid: 0, preferences: { launchThroughProxy: false, proxyPort: 7890 },
      inspectImpl: async () => [], killImpl: () => { throw new Error("must not quit"); }, sleepImpl: async () => {},
      reservePort: async () => { reserved += 1; return 54321; },
      spawnImpl: (command, args, options) => { calls.push({ command, args, options }); return fakeChild([]); }
    });
    assert.equal(reserved, enabled ? 1 : 0);
    assert.deepEqual(calls[0].args, enabled ? ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=54321"] : []);
  }
});

test("handoff 配置或端口分配失败发生在退出之前，代理参数与 CDP 参数共存", async () => {
  const { buildPluginCodexLaunchArgs } = await import("../src/plugin/launcher.mjs");
  const preferences = { launchThroughProxy: true, proxyPort: 7891 };
  assert.deepEqual(buildPluginCodexLaunchArgs(preferences, { debugPort: 54321 }).slice(0, 3), [
    "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=54321", "--proxy-server=http://127.0.0.1:7891"
  ]);
  assert.throws(() => buildPluginCodexLaunchArgs(preferences, { debugPort: 0 }), { code: "LAUNCHER_INVALID" });
  await assert.rejects(runCodexHandoff({ expectedPid: 123, preferences,
    loadAgentConfig: async () => { throw new Error("bad config"); },
    inspectImpl: async () => { throw new Error("must not inspect"); }, killImpl: () => { throw new Error("must not quit"); }
  }), /bad config/);
});

test("非 macOS 平台只保存偏好：不检查进程，拒绝退出或重启 Codex", async t => {
  const { launcher, spawns } = await fixture(t, {
    platform: "linux",
    inspectImpl: async () => { throw new Error("不应检查进程"); }
  });
  const status = await launcher.status();
  assert.equal(status.supported, false);
  assert.equal(status.running, null);
  await assert.rejects(launcher.schedule("relaunch"), { code: "LAUNCHER_UNSUPPORTED" });
  await assert.rejects(launcher.schedule("stop"), { code: "LAUNCHER_UNSUPPORTED" });
  assert.deepEqual(spawns, []);
});
