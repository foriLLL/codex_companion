import test from "node:test";
import assert from "node:assert/strict";
import { createCodexSession, createEmbyRuntime } from "../src/agent/session.mjs";
import { waitForCodexTargets } from "../src/targets.mjs";
import { deferred, flush, logger } from "./helpers/agent.mjs";

test("session 把 platform/config/executable 交给运行时，配置先服务后 renderer，stop 幂等", async () => {
  const calls = [];
  const platform = { getAgentStatus: () => ({ available: true }) };
  const configStore = {};
  let received;
  const session = createCodexSession({ port: 51234, configStore, executable: "/fake/app", platform, logger,
    runtimeFactory: async (port, options) => {
      received = { port, ...options };
      return { service: { applyConfig: async config => calls.push(["service", config]), dispose: async () => calls.push("dispose") },
        injector: { start: async () => calls.push("start"), setConfig: options => calls.push(["injector", options.config]), stop: () => calls.push("stop") } };
    }
  });
  await session.applyConfig({ revision: 1 });
  await session.start();
  assert.equal(received.platform, platform);
  assert.equal(received.configStore, configStore);
  assert.equal(received.executable, "/fake/app");
  assert.equal(received.port, 51234);
  assert.deepEqual(await received.loadConfig(), { revision: 1 });
  await session.applyConfig({ revision: 2 });
  await Promise.all([session.stop(), session.stop()]);
  assert.deepEqual(calls, [["service", { revision: 1 }], ["injector", { revision: 1 }], "start",
    ["service", { revision: 2 }], ["injector", { revision: 2 }], "dispose", "stop"]);
  await session.applyConfig({ revision: 3 });
  assert.equal(calls.length, 7);
});

test("session 取消正在启动的 injector，关闭媒体资源，不遗留迟到的启动", async () => {
  const calls = [];
  const waiting = deferred();
  let signal;
  const session = createCodexSession({ port: 51234, logger, runtimeFactory: async () => ({
    service: { dispose: async () => calls.push("dispose") },
    injector: {
      start: ({ signal: value }) => { signal = value; signal.addEventListener("abort", () => waiting.reject(signal.reason), { once: true }); return waiting.promise; },
      stop: () => calls.push("stop")
    }
  }) });
  const starting = session.start();
  const rejected = assert.rejects(starting, { name: "AbortError" });
  await flush();
  await session.stop();
  await rejected;
  assert.equal(signal.aborted, true);
  assert.equal(calls.filter(call => call === "dispose").length, 1);
  assert.equal(calls.at(-1), "stop");
});

test("session 在配置读取中停止，不会继续启动 injector", async () => {
  const loading = deferred();
  let starts = 0, disposes = 0;
  const session = createCodexSession({ port: 51234, logger, runtimeFactory: () => loading.promise });
  const rejected = assert.rejects(session.start(), { name: "AbortError" });
  const stopping = session.stop();
  loading.resolve({ service: { dispose: async () => { disposes += 1; } }, injector: { start: async () => { starts += 1; }, stop() {} } });
  await stopping;
  await rejected;
  assert.equal(starts, 0);
  assert.equal(disposes, 1);
});

test("createEmbyRuntime 生产服务接收到 platform，旧导出仍可用", async () => {
  const platform = { getAgentStatus: () => ({ available: true, pid: 8 }) };
  const runtime = await createEmbyRuntime(51234, {
    platform, configStore: { loadV2: async () => ({ version: 2, cards: {}, order: [] }) },
    InjectorClass: class {}, logger
  });
  assert.deepEqual(await runtime.service.handleRpc("companion.agent.status"), { available: true, pid: 8 });
  await runtime.service.dispose();
});

test("waitForCodexTargets 取消后不会再查询 CDP，等待定时器也能取消", async () => {
  for (const whileQuerying of [false, true]) {
    const abort = new AbortController();
    let calls = 0;
    const waiting = deferred();
    const promise = waitForCodexTargets(51234, { signal: abort.signal, intervalMs: 60_000,
      listTargets: async (_port, { signal }) => {
        calls += 1;
        assert.equal(signal, abort.signal);
        if (whileQuerying) await waiting.promise;
        return [];
      }
    });
    const rejected = assert.rejects(promise, { name: "AbortError" });
    await flush();
    abort.abort();
    waiting.resolve();
    await rejected;
    assert.equal(calls, 1);
  }
});
