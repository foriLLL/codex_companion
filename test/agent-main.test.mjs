import { posixOnlyTest as test } from "./helpers/platform.mjs";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { acquireAgentLock, AGENT_VERSION, createPollingSnapshot, defaultAgentLockPath, getAgentStatus, readAgentStatus, resolveCodexAppPath, runAgent } from "../src/agent/main.mjs";
import { app, clock, configStore, fakeLockSpawn, flush, logger, nativeBridge, ours, snapshot, stateStore, temporary } from "./helpers/agent.mjs";
import { assertMode } from "./helpers/permissions.mjs";

async function fixture(t, options = {}) {
  const home = await temporary(t);
  const timer = clock();
  const processRef = new EventEmitter();
  processRef.pid = 700;
  processRef.exitCode = undefined;
  const bridge = nativeBridge();
  const config = configStore();
  const runtimeState = stateStore();
  const sessions = [];
  let onChange, watcherClosed = false;
  const instance = await runAgent({ home, helperPath: "/fake/native", nativeBridge: bridge, configStore: config,
    runtimeState, logger, processRef, isAlive: () => false, lockSpawnImpl: fakeLockSpawn(),
    now: timer.now, setTimeoutImpl: timer.setTimeoutImpl, clearTimeoutImpl: timer.clearTimeoutImpl,
    waitForTargets: async () => [], notifyImpl: async () => {},
    watchConfig: async options => { onChange = options.onChange; return { close: async () => { watcherClosed = true; } }; },
    sessionFactory: options => {
      const session = { options, stopped: false, configs: [],
        start: async () => {}, stop: async () => { session.stopped = true; }, applyConfig: async next => session.configs.push(next) };
      sessions.push(session);
      return session;
    }, ...options
  });
  t.after(() => instance.stop());
  return { instance, home, timer, bridge, config, runtimeState, processRef, sessions,
    update: async next => { config.value = next; await onChange(next); }, watcherClosed: () => watcherClosed };
}

test("agent 在 Codex 退出后 detach 并继续驻留，SIGTERM 完整清理退出码 0", async t => {
  const f = await fixture(t);
  f.bridge.watches[0].onSnapshot(snapshot([ours()]));
  await flush();
  assert.equal(f.sessions.length, 1);
  assert.equal(f.instance.getAgentStatus().codex.attached, true);
  f.bridge.watches[0].onSnapshot(snapshot([], f.timer.now() + 1));
  await flush();
  assert.equal(f.sessions[0].stopped, true);
  assert.equal(f.instance.getAgentStatus().available, true);
  assert.equal(f.instance.getAgentStatus().codex.running, false);
  assert.equal(f.processRef.listenerCount("SIGTERM"), 1);
  f.processRef.emit("SIGTERM");
  await f.instance.stop();
  await flush();
  assert.equal(f.processRef.exitCode, 0);
  assert.equal(f.processRef.listenerCount("SIGTERM"), 0);
  assert.equal(f.processRef.listenerCount("SIGINT"), 0);
  assert.equal(f.bridge.watches[0].closed, true);
  assert.equal(f.watcherClosed(), true);
  assert.equal(f.runtimeState.value.agentPid, null);
  assert.equal(await readFile(defaultAgentLockPath(f.home), "utf8"), "");
  assert.deepEqual(f.timer.delays(), []);
});

test("配置热更新先应用 session，然后改变 autoRelaunch；RPC 重启接到 controller", async t => {
  const f = await fixture(t);
  f.bridge.watches[0].onSnapshot(snapshot([ours()]));
  await flush();
  const next = { ...f.config.value, revision: 1, enabled: false, agent: { autoRelaunch: false } };
  await f.update(next);
  assert.equal(f.sessions[0].configs.at(-1), next);
  assert.equal(f.sessions[0].options.platform.getAgentStatus().autoRelaunch, false);
  f.bridge.value = snapshot([app(45)], f.timer.now() + 1);
  f.bridge.watches[0].onSnapshot(f.bridge.value);
  await flush();
  assert.equal(f.bridge.calls.filter(call => call[0] === "quit").length, 0);
  assert.equal(f.runtimeState.value.lastEvent.event, "skipped-disabled");
  await f.update({ ...next, revision: 2, agent: { autoRelaunch: true } });
  f.bridge.value = snapshot([app(46)], f.timer.now() + 2);
  f.bridge.watches[0].onSnapshot(f.bridge.value);
  await flush();
  assert.equal(f.bridge.calls.filter(call => call[0] === "quit").length, 1);
  assert.equal(f.runtimeState.value.lastEvent.event, "quit-refused");
  assert.deepEqual(await f.instance.requestCodexRestart({ reason: "settings" }), { accepted: true });
  await f.timer.advance(300);
  assert.equal(f.bridge.calls.filter(call => call[0] === "quit").at(-1)[1].mode, "user");
});

test("pendingLaunch 在 300ms 后主动 snapshot，未完成启动不退出", async t => {
  const waiting = app();
  waiting.finishedLaunching = false;
  const bridge = nativeBridge(snapshot([waiting]));
  const f = await fixture(t, { nativeBridge: bridge });
  assert.equal(f.instance.controller.pendingLaunch, true);
  assert.ok(f.timer.delays().includes(300));
  bridge.value = snapshot([app()], f.timer.now() + 300);
  await f.timer.advance(300);
  assert.equal(bridge.calls.filter(call => call[0] === "quit").length, 1);
  assert.equal(f.instance.controller.pendingLaunch, false);
});

test("助手缺失时每两秒轮询，只 attach ours，不退出/启动普通或 foreign-debug 实例", async t => {
  let current = snapshot([app()]);
  let polls = 0;
  const f = await fixture(t, { nativeBridge: null, helperPath: null,
    fallbackSnapshot: async () => { polls += 1; return current; } });
  assert.equal(f.instance.getAgentStatus().nativeHelper, "missing");
  assert.equal(f.instance.getAgentStatus().autoRelaunch, true);
  assert.equal(f.sessions.length, 0);
  assert.equal(f.runtimeState.value.lastEvent.event, "skipped-disabled");
  current = snapshot([ours()], f.timer.now() + 2000);
  await f.timer.advance(2000);
  assert.equal(polls, 2);
  assert.equal(f.sessions.length, 1);
  assert.equal(f.instance.getAgentStatus().codex.attached, true);
  current = snapshot([app(90, 999_000, ["--remote-debugging-port=51235"])], f.timer.now() + 2000);
  await f.timer.advance(2000);
  assert.equal(f.sessions[0].stopped, true);
  assert.equal(f.runtimeState.value.lastEvent.event, "foreign-debug");
  assert.deepEqual(await f.instance.requestCodexRestart({}), { accepted: false, reason: "native-helper-missing" });
  assert.equal(f.bridge.calls.length, 0);
});

test("watch 异常退出后轮询并指数退避重开，旧 watch 的迟到输出无效", async t => {
  const f = await fixture(t);
  const first = f.bridge.watches[0];
  first.onExit(new Error("watch failed"));
  assert.equal(first.closed, true);
  assert.ok(f.timer.delays().includes(1000));
  await f.timer.advance(1000);
  assert.equal(f.bridge.watches.length, 2);
  f.bridge.watches[1].onExit(null);
  assert.ok(f.timer.delays().includes(2000));
  const snapshots = f.bridge.calls.filter(call => call[0] === "snapshot").length;
  await f.timer.advance(2000);
  assert.equal(f.bridge.watches.length, 3);
  assert.ok(f.bridge.calls.filter(call => call[0] === "snapshot").length > snapshots);
  first.onSnapshot(snapshot([ours()], f.timer.now()));
  await flush();
  assert.equal(f.sessions.length, 0);
  f.bridge.watches[2].onSnapshot(snapshot([ours()], f.timer.now()));
  await flush();
  assert.equal(f.sessions.length, 1);
  f.bridge.watches[2].onExit(null);
  assert.ok(f.timer.delays().includes(4000));
  await f.timer.advance(4000);
  await f.timer.advance(30_000);
  f.bridge.watches[3].onSnapshot(snapshot([], f.timer.now()));
  f.bridge.watches[3].onExit(null);
  assert.ok(f.timer.delays().includes(1000));
});

test("单实例锁 0600，记录 pid/启动时间；存活持有者不可覆盖，死亡可回收", async t => {
  const home = await temporary(t);
  const path = join(home, "agent.lock");
  const calls = [];
  const options = { path, pid: 700, now: () => 1234, spawnImpl: fakeLockSpawn(calls), isAlive: () => true };
  const first = await acquireAgentLock(options);
  assertMode(await stat(path), 0o600);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { pid: 700, startedAt: 1234 });
  assert.equal(await acquireAgentLock({ ...options, pid: 701 }), null);
  assert.equal(calls[0].options.stdio.length, 4);
  assert.ok(Number.isInteger(calls[0].options.stdio[3]));
  await first.release();
  await first.release();
  await writeFile(path, JSON.stringify({ pid: 699, startedAt: 1 }));
  const recovered = await acquireAgentLock({ ...options, isAlive: pid => { assert.equal(pid, 699); return false; } });
  assert.equal(recovered.pid, 700);
  await recovered.release();
});

test("内核锁竞争或已有 agent 时直接返回，不读配置或启动 watch；损坏锁不覆盖", async t => {
  const home = await temporary(t);
  const path = join(home, "agent.lock");
  const result = await runAgent({ home, lockPath: path, helperPath: null, env: {},
    lockSpawnImpl: fakeLockSpawn([], process.platform === "darwin" ? 75 : 1), configStore: { loadV2() { throw new Error("must not load"); } } });
  assert.equal(result.running, false);
  assert.equal(result.reason, "already-running");
  await writeFile(path, "{bad");
  await assert.rejects(acquireAgentLock({ path, spawnImpl: fakeLockSpawn(), isAlive: () => false }), /锁文件损坏/);
  assert.equal(await readFile(path, "utf8"), "{bad");
});

test("状态返回 C4 完整形状及 package 版本；离线 status 验证锁和 attachment 身份", async t => {
  const home = await temporary(t);
  const lockPath = defaultAgentLockPath(home);
  await mkdir(dirname(lockPath), { recursive: true });
  await writeFile(lockPath, JSON.stringify({ pid: 700, startedAt: 1 }));
  const config = configStore();
  const target = ours();
  const runtimeState = stateStore({ agentPid: 700, startedAt: 1, codexKey: target.key, port: 51234, lastEvent: { event: "reopened", at: 2 } });
  const options = { home, nativeBridge: nativeBridge(snapshot([target])), helperPath: "/fake/helper", configStore: config, runtimeState, isAlive: () => true };
  const actual = await readAgentStatus(options);
  assert.deepEqual(actual, { available: true, version: AGENT_VERSION, pid: 700, autoRelaunch: true,
    codex: { running: true, pid: 42, attached: true, port: 51234, proxyPort: 7890 }, lastEvent: { event: "reopened", at: 2 }, nativeHelper: "ok" });
  assert.equal((await readAgentStatus({ ...options, isAlive: () => false })).codex.attached, false);
  assert.equal(getAgentStatus({ available: false }).pid, null);
  assert.equal((await readAgentStatus({ ...options, isAlive: () => false })).available, false);
});

test("fallback 通过假 ps 核实可执行路径/启动时间，模糊 argv 不接管；app 路径取环境优先", async () => {
  const executable = "/test/Fake Codex.app/Contents/MacOS/ChatGPT";
  const calls = [];
  const poll = createPollingSnapshot({ executable, now: () => 1000, execFileImpl: async (...args) => {
    calls.push(args);
    return { stdout: `42 Wed Oct 28 12:00:00 2026 ${executable} --remote-debugging-address=127.0.0.1 --remote-debugging-port=51234\n43 Wed Oct 28 12:00:01 2026 ${executable} --title='ambiguous value'\n44 Wed Oct 28 12:00:01 2026 ${executable}-helper\n` };
  } });
  const result = await poll();
  assert.equal(result.apps.length, 2);
  assert.equal(result.apps[0].key, `42:${Date.parse("Wed Oct 28 12:00:00 2026")}`);
  assert.equal(result.apps[1].arguments, null);
  assert.equal(result.inputIdleMs, 0);
  assert.equal(calls[0][0], "/bin/ps");
  assert.equal(resolveCodexAppPath({ env: { CODEX_COMPANION_CODEX_APP: "/test/Alternate.app" } }), "/test/Alternate.app");
  assert.equal(resolveCodexAppPath({ env: {} }), "/Applications/ChatGPT.app");
});

test("session 热更新失败也立即关闭 autoRelaunch，watch 同步失败仍轮询恢复", async t => {
  const bridge = nativeBridge();
  let watches = 0;
  const watch = bridge.watch.bind(bridge);
  bridge.watch = options => { if (++watches === 1) throw new Error("fake spawn failed"); return watch(options); };
  const f = await fixture(t, { nativeBridge: bridge });
  assert.equal(watches, 1);
  await f.timer.advance(1000);
  assert.equal(watches, 2);
  bridge.watches[0].onSnapshot(snapshot([ours()], f.timer.now()));
  await flush();
  f.sessions[0].applyConfig = async () => { throw new Error("apply failed"); };
  const next = { ...f.config.value, revision: 1, agent: { autoRelaunch: false } };
  await assert.rejects(f.update(next), /apply failed/);
  assert.equal(f.instance.getAgentStatus().autoRelaunch, false);
  bridge.watches[0].onSnapshot(snapshot([app(50, f.timer.now())], f.timer.now()));
  await flush();
  assert.equal(bridge.calls.some(call => call[0] === "quit"), false);
});

test("agent 启动配置失败会释放锁，内核锁错误不会冒充已运行", async t => {
  const home = await temporary(t);
  const options = { home, helperPath: null, env: {}, lockSpawnImpl: fakeLockSpawn(),
    configStore: { loadV2: async () => { throw new Error("bad config"); } }, isAlive: () => false };
  await assert.rejects(runAgent(options), /bad config/);
  assert.equal(await readFile(defaultAgentLockPath(home), "utf8"), "");
  await assert.rejects(acquireAgentLock({ path: defaultAgentLockPath(home), spawnImpl: fakeLockSpawn([], 64) }), { code: "AGENT_LOCK_FAILED" });
});
