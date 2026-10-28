import test from "node:test";
import assert from "node:assert/strict";
import { createAgentAdapter, AGENT_NOTIFICATIONS } from "../src/agent/adapter.mjs";
import { normalizeCompanionConfigV2 } from "../src/companion-config.mjs";
import { clock, deferred, flush, logger, nativeBridge, stateStore } from "./helpers/agent.mjs";

function adapter(options = {}) {
  return createAgentAdapter({ nativeBridge: nativeBridge(), initialConfig: normalizeCompanionConfigV2({}),
    runtimeState: stateStore(), pid: 7, logger, notifyImpl: async () => {}, ...options });
}

test("adapter launch 使用随机 loopback 端口，正确覆盖/删除全部代理环境键", async () => {
  const bridge = nativeBridge();
  let port = 51230;
  const instance = adapter({ nativeBridge: bridge, reservePort: async () => ++port });
  await instance.applyConfig(normalizeCompanionConfigV2({ launch: { proxy: { enabled: true, port: 7891 } } }));
  const result = await instance.launch({ hidden: true, inputStamp: "1:0:0:0:0", frontmostPid: 88 });
  assert.equal(result.finishedLaunching, false);
  assert.equal(result.hidden, false);
  const first = bridge.calls.at(-1)[1];
  assert.deepEqual(first.env, { HTTP_PROXY: "http://127.0.0.1:7891", HTTPS_PROXY: "http://127.0.0.1:7891", http_proxy: "http://127.0.0.1:7891", https_proxy: "http://127.0.0.1:7891" });
  assert.deepEqual(first.unsetEnv, ["ALL_PROXY", "all_proxy"]);
  assert.deepEqual(first.args.slice(0, 3), ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=51231", "--proxy-server=http://127.0.0.1:7891"]);
  assert.equal(first.inputStamp, "1:0:0:0:0");
  await instance.applyConfig(normalizeCompanionConfigV2({}));
  await instance.launch({ hidden: false });
  assert.deepEqual(bridge.calls.at(-1)[1], { hidden: false,
    args: ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=51232"], env: {},
    unsetEnv: ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"] });
  await instance.close();
});

test("attach 立即返回，后台按退避重试，配置变化传入 session，detach 停止", async () => {
  const timer = clock();
  const state = stateStore();
  const calls = [];
  let attempts = 0;
  const instance = adapter({ runtimeState: state, ...timer,
    waitForTargets: async () => { attempts += 1; if (attempts < 3) throw new Error("CDP not ready"); },
    sessionFactory: options => { calls.push(["create", options]); return {
      start: async () => calls.push("start"), stop: async () => calls.push("stop"), applyConfig: async next => calls.push(["config", next])
    }; }
  });
  await instance.initialize();
  await instance.attach({ pid: 42, key: "42:1", port: 51234 });
  assert.equal(instance.attachment, null);
  await flush();
  assert.equal(attempts, 1);
  const next = normalizeCompanionConfigV2({ agent: { autoRelaunch: false } });
  await instance.applyConfig(next);
  await timer.advance(300);
  assert.equal(attempts, 2);
  await timer.advance(600);
  assert.equal(attempts, 3);
  assert.deepEqual(instance.attachment, { pid: 42, key: "42:1", port: 51234 });
  assert.equal(calls[0][1].initialConfig, next);
  await instance.applyConfig({ ...next, revision: 1 });
  assert.equal(calls.at(-1)[0], "config");
  await instance.detach({ key: "42:1", reason: "exited" });
  assert.equal(calls.at(-1), "stop");
  assert.equal(state.value.port, null);
  assert.equal(state.value.agentPid, 7);
  await instance.close();
});

test("detach 取消尚未完成的 CDP 查询；过期结果不能创建会话", async () => {
  const pending = deferred();
  let signal, creates = 0;
  const instance = adapter({ waitForTargets: (_port, options) => { signal = options.signal; return pending.promise; },
    sessionFactory: () => { creates += 1; throw new Error("must not create"); } });
  await instance.attach({ pid: 42, key: "42:1", port: 51234 });
  await flush();
  await instance.detach({ key: "42:1" });
  assert.equal(signal.aborted, true);
  pending.resolve([]);
  await flush();
  assert.equal(creates, 0);
  await instance.close();
});

test("detach 取消退避等待，替换实例时旧 session 先停止，同一时刻至多一个", async () => {
  const timer = clock();
  let fail = true, live = 0, peak = 0, attempts = 0;
  const events = [];
  const instance = adapter({ ...timer, waitForTargets: async () => { attempts += 1; if (fail) throw new Error("not ready"); },
    sessionFactory: ({ port }) => { live += 1; peak = Math.max(peak, live); let stopped = false;
      events.push(["create", port]); return { start: async () => {}, applyConfig: async () => {}, stop: async () => {
        if (!stopped) { stopped = true; live -= 1; events.push(["stop", port]); }
      } };
    }
  });
  await instance.attach({ pid: 41, key: "41:1", port: 51231 });
  await flush();
  await instance.detach({ key: "41:1" });
  await timer.advance(10_000);
  assert.equal(attempts, 1);
  fail = false;
  await instance.attach({ pid: 42, key: "42:1", port: 51232 });
  await flush();
  await instance.attach({ pid: 43, key: "43:1", port: 51233 });
  await flush();
  assert.equal(peak, 1);
  assert.deepEqual(events, [["create", 51232], ["stop", 51232], ["create", 51233]]);
  await instance.close();
  assert.equal(live, 0);
});

test("record 原子状态保存失败必须向控制器传播，冷却信息可持久化", async () => {
  const state = stateStore();
  const instance = adapter({ runtimeState: state, now: () => 1234 });
  await instance.initialize();
  await instance.record("attempt", { lastAttemptAt: 1234, processKey: "1:2" });
  assert.deepEqual(state.value.lastEvent, { event: "attempt", at: 1234 });
  assert.equal(state.value.lastAttemptAt, 1234);
  state.save = async () => { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); };
  await assert.rejects(instance.record("attempt", { lastAttemptAt: 2345 }), { code: "ENOSPC" });
  assert.equal(instance.state.lastAttemptAt, 1234);
});

test("三种中文通知各自限频十分钟，失败也限频，不调用真实 osascript", async () => {
  let now = 0;
  const calls = [];
  const instance = adapter({ now: () => now, notifyImpl: async (...args) => { calls.push(args); throw new Error("fake failure"); } });
  for (const kind of Object.keys(AGENT_NOTIFICATIONS)) await Promise.all([instance.notify(kind), instance.notify(kind)]);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(call => call[1]), Object.values(AGENT_NOTIFICATIONS));
  now = 599_999;
  await instance.notify("needs-restart");
  assert.equal(calls.length, 3);
  now = 600_000;
  await instance.notify("needs-restart");
  assert.equal(calls.length, 4);
  await instance.close();
});

test("adapter 默认通知器透传假 execFile，osascript 无独立真实调用", async () => {
  const calls = [];
  const instance = adapter({ notifyImpl: undefined, execFileImpl: async (...args) => { calls.push(args); } });
  await instance.notify("needs-restart");
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "/usr/bin/osascript");
  assert.equal(calls[0][1][2], AGENT_NOTIFICATIONS["needs-restart"]);
  await instance.close();
});
