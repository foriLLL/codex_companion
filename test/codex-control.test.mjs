import assert from "node:assert/strict";
import test from "node:test";
import { collectStatus, stopCodex } from "../src/codex-control.mjs";

test("stopCodex：无进程时返回 not-running，不发信号", async () => {
  const killed = [];
  const result = await stopCodex({
    inspectImpl: async () => [],
    killImpl: (pid) => killed.push(pid)
  });
  assert.deepEqual(result, { stopped: false, reason: "not-running", pids: [] });
  assert.deepEqual(killed, []);
});

test("stopCodex：只对 ps 验证过的 pid 发 SIGTERM", async () => {
  const killed = [];
  const result = await stopCodex({
    inspectImpl: async () => [
      { pid: 100, command: "codex", hasCdpFlag: true },
      { pid: 101, command: "codex", hasCdpFlag: false }
    ],
    killImpl: (pid, signal) => killed.push({ pid, signal })
  });
  assert.deepEqual(result, { stopped: true, reason: "terminated", pids: [100, 101] });
  assert.deepEqual(killed, [
    { pid: 100, signal: "SIGTERM" },
    { pid: 101, signal: "SIGTERM" }
  ]);
});

test("stopCodex：ESRCH 幂等忽略，EPERM 上报失败", async () => {
  const gone = await stopCodex({
    inspectImpl: async () => [{ pid: 5, command: "codex", hasCdpFlag: true }],
    killImpl: () => { const e = new Error("gone"); e.code = "ESRCH"; throw e; }
  });
  assert.equal(gone.stopped, true);
  assert.deepEqual(gone.pids, []);

  const denied = await stopCodex({
    inspectImpl: async () => [{ pid: 5, command: "codex", hasCdpFlag: true }],
    killImpl: () => { const e = new Error("denied"); e.code = "EPERM"; throw e; }
  });
  assert.equal(denied.stopped, false);
  assert.equal(denied.reason, "kill-failed");
});

test("collectStatus：汇总进程、运行时状态与配置，异常一律降级", async () => {
  const status = await collectStatus({
    inspectImpl: async () => [{ pid: 7, command: "codex --remote-debugging-port=5000", hasCdpFlag: true }],
    loadRuntimeState: () => ({ port: 5000, codexPid: 7, daemonPid: 8, startedAt: 1 }),
    loadConfig: () => ({ version: 1, cards: { hongguo: false, emby: true } })
  });
  assert.deepEqual(status, {
    statusError: false,
    codexRunning: true,
    hasCdpFlag: true,
    codexPids: [7],
    port: 5000,
    daemonPid: 8,
    cards: { hongguo: false, emby: true }
  });

  const degraded = await collectStatus({
    inspectImpl: async () => { throw new Error("ps failed"); },
    loadRuntimeState: () => { throw new Error("bad state"); },
    loadConfig: () => { throw new Error("bad config"); }
  });
  assert.deepEqual(degraded, {
    statusError: true,
    codexRunning: false,
    hasCdpFlag: false,
    codexPids: [],
    port: null,
    daemonPid: null,
    cards: null
  });
});
