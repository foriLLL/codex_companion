import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { createService, probeLoopbackPort } from "../src/cards/proxy/service.mjs";
import { CodexCompanionService } from "../src/codex-companion-service.mjs";

const context = { signal: new AbortController().signal };

test("代理状态：未带代理启动时不探测端口", async () => {
  let probed = false;
  const service = createService({
    inspectCodexProxy: async () => ({ running: true, proxyPort: null }),
    probePortImpl: async () => { probed = true; return true; }
  });
  assert.deepEqual(await service.methods.status({}, context), { running: true, proxyPort: null, reachable: null });
  assert.equal(probed, false);
});

test("代理状态：带代理启动时报告端口可连通性", async () => {
  const ports = [];
  const service = createService({
    inspectCodexProxy: async () => ({ running: true, proxyPort: 7890 }),
    probePortImpl: async (port) => { ports.push(port); return false; }
  });
  assert.deepEqual(await service.methods.status({}, context), { running: true, proxyPort: 7890, reachable: false });
  assert.deepEqual(ports, [7890]);
});

test("代理状态：不支持检测的系统直接返回 unsupported，不探测端口", async () => {
  const service = createService({
    inspectCodexProxy: async () => ({ supported: false, running: null, proxyPort: null }),
    probePortImpl: async () => { throw new Error("不应探测"); }
  });
  assert.deepEqual(await service.methods.status({}, context), { supported: false, running: null, proxyPort: null, reachable: null });
});

test("代理状态：已取消的请求不返回结果", async () => {
  const controller = new AbortController();
  const service = createService({
    inspectCodexProxy: async () => { controller.abort(new Error("cancelled")); return { running: true, proxyPort: 7890 }; },
    probePortImpl: async () => true
  });
  await assert.rejects(service.methods.status({}, { signal: controller.signal }), /cancelled/);
});

test("probeLoopbackPort 区分监听中与已关闭的本机端口", async () => {
  const server = net.createServer((socket) => socket.destroy());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    assert.equal(await probeLoopbackPort(port), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  assert.equal(await probeLoopbackPort(port), false);
});

test("代理卡通过平台 RPC 路由，并使用注入的 Codex 检测", async () => {
  const service = new CodexCompanionService({
    configStore: { loadV2: async () => ({ enabled: true, cards: { proxy: { enabled: true, settings: {} } } }) },
    inspectCodexProxy: async () => ({ running: false, proxyPort: null })
  });
  try {
    assert.deepEqual(await service.handleRpc("proxy.status", {}, { cardId: "proxy", generation: 1, targetId: "t", executionContextId: 1 }),
      { running: false, proxyPort: null, reachable: null });
  } finally {
    await service.dispose();
  }
});
