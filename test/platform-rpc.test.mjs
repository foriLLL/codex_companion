import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import vm from "node:vm";
import { CARD_MANIFESTS } from "../src/card-registry.mjs";
import { ConfigError } from "../src/companion-config.mjs";
import { CodexCompanionService } from "../src/codex-companion-service.mjs";
import { validateCatalog, validateManifest } from "../src/platform/registry/manifest.mjs";
import { ServiceRegistry } from "../src/platform/services/registry.mjs";
import { createRpcClient } from "../src/renderer/platform/rpc-client.mjs";
import { CdpRpcBridge, RPC_BINDING_NAME, sanitizeRpcError } from "../src/rpc-bridge.mjs";

const METHODS = ["companion.settings.get", "companion.settings.patch", "companion.codex.restart", "companion.agent.status"];
const CONFIG = {
  version: 2, revision: 7, enabled: false, placement: "standalone-button",
  order: ["proxy"], cards: { proxy: { enabled: false, settings: {} } },
  launch: { proxy: { enabled: true, port: 7891 } }, agent: { autoRelaunch: false }
};
const AGENT = {
  available: true, version: "test", pid: 123, autoRelaunch: false,
  codex: { running: true, pid: 456, attached: true, port: 54321, proxyPort: 7891 },
  lastEvent: { event: "attached", at: 1000 }, nativeHelper: "ok", extraStatus: { preserved: true }
};

function createService(t, options = {}) {
  const service = new CodexCompanionService({
    configStore: { loadV2: async () => CONFIG }, modules: {}, ...options
  });
  t.after(() => service.dispose());
  return service;
}

// 只模拟 CDP 传输；路由、错误序列化、页面收包都走生产实现。
class FakeConnection extends EventEmitter {
  responses = [];
  receiveRpc = () => false;

  async send(method, params = {}) {
    if (method !== "Runtime.callFunctionOn") return {};
    const wire = JSON.parse(JSON.stringify(params));
    const deliver = vm.runInNewContext(`(${wire.functionDeclaration})`, {
      __CODEX_COMPANION__: { runtime: { receiveRpc: response => {
        this.responses.push({ executionContextId: wire.executionContextId, response });
        return this.receiveRpc(response);
      } } }
    });
    return { result: { value: deliver(wire.arguments[0].value) } };
  }
}

async function connect(t, service, { mapRequest = request => request } = {}) {
  const connection = new FakeConnection();
  const requests = [];
  const client = createRpcClient({ timeoutMs: 2000, binding: () => payload => {
    const request = mapRequest(JSON.parse(payload));
    requests.push(request);
    connection.emit("Runtime.bindingCalled", { name: RPC_BINDING_NAME, payload: JSON.stringify(request), executionContextId: 17 });
  } });
  connection.receiveRpc = client.receiveRpc;
  const bridge = new CdpRpcBridge(connection, { handler: service, targetId: "fake-target", timeoutMs: 2000 });
  await bridge.attach();
  t.after(() => { client.dispose(); bridge.detach(); });
  return { client, connection, requests, call: client.scoped("companion", 1) };
}

test("scoped companion settings.get 返回完整 v2、默认 catalog 和 agent，总开关关闭仍可访问", async t => {
  let loads = 0;
  const service = createService(t, {
    configStore: {
      loadV2: async () => { loads += 1; return CONFIG; },
      load: () => assert.fail("设置页必须优先读取完整 v2")
    },
    platform: { getAgentStatus: async () => AGENT }
  });
  service.registry.handleRpc = () => assert.fail("平台 RPC 不能进入卡片注册表");
  const { call, requests, connection } = await connect(t, service);
  assert.deepEqual(await call("companion.settings.get", {}), {
    config: CONFIG,
    catalog: CARD_MANIFESTS.map(({ id, title, defaultEnabled, defaultOrder }) => ({ id, title, defaultEnabled, defaultOrder })),
    agent: AGENT
  });
  assert.equal(loads, 1);
  assert.equal(requests[0].method, "companion.settings.get");
  assert.equal(requests[0].cardId, "companion");
  assert.equal(requests[0].generation, 1);
  assert.equal(connection.responses[0].executionContextId, 17);
});

test("settings.get 使用注入的 manifests，且同步 agent 回调保持接收者与结果", async t => {
  const manifest = { ...CARD_MANIFESTS[0], id: "custom", title: "自定义", defaultEnabled: false, defaultOrder: 99 };
  const platform = { getAgentStatus() { assert.equal(this, platform); return AGENT; } };
  const service = createService(t, { manifests: [manifest], platform });
  const result = await service.handleRpc("companion.settings.get");
  assert.equal(result.config, CONFIG);
  assert.equal(result.agent, AGENT);
  assert.deepEqual(result.catalog, [{ id: "custom", title: "自定义", defaultEnabled: false, defaultOrder: 99 }]);
});

test("scoped companion settings.patch 原样调用配置存储并返回完整结果", async t => {
  const patch = { launch: { proxy: { port: 7892 } }, agent: { autoRelaunch: true } };
  const updated = { ...CONFIG, revision: 8, launch: { proxy: { enabled: true, port: 7892 } }, agent: { autoRelaunch: true } };
  const calls = [];
  const configStore = { patch(...args) { assert.equal(this, configStore); calls.push(args); return updated; } };
  const service = createService(t, { configStore });
  const { call } = await connect(t, service);
  assert.deepEqual(await call("companion.settings.patch", { expectedRevision: 7, patch }), { config: updated });
  assert.deepEqual(calls, [[patch, { expectedRevision: 7 }]]);

  // 即使字段语义无效，也应由配置存储判定，平台只检查外层形状。
  const semanticPatch = Object.freeze({ launch: { proxy: { port: "invalid", extra: true } }, agent: { autoRelaunch: null }, futureField: true });
  const result = await service.handleRpc("companion.settings.patch", { expectedRevision: 0, patch: semanticPatch });
  assert.equal(calls[1][0], semanticPatch);
  assert.deepEqual(calls[1][1], { expectedRevision: 0 });
  assert.equal(result.config, updated);
});

test("scoped companion codex.restart 透传可选 reason 及接受或拒绝结果", async t => {
  const calls = [];
  let result = { accepted: true };
  const platform = { requestCodexRestart(params) { assert.equal(this, platform); calls.push(params); return Promise.resolve(result); } };
  const { call } = await connect(t, createService(t, { platform }));
  for (const params of [{}, { reason: "" }, { reason: "设置页修改代理" }, { reason: "r".repeat(64) }]) {
    assert.deepEqual(await call("companion.codex.restart", params), result);
    assert.deepEqual(calls.at(-1), params);
  }
  result = { accepted: false, reason: "busy" };
  assert.deepEqual(await call("companion.codex.restart", {}), result);
});

test("scoped companion agent.status 同步与异步回调的状态均原样透传", async t => {
  for (const getAgentStatus of [() => AGENT, async () => AGENT]) {
    const service = createService(t, { platform: { getAgentStatus } });
    const { call } = await connect(t, service);
    assert.deepEqual(await call("companion.agent.status", {}), AGENT);
    assert.equal(await service.handleRpc("companion.agent.status", {}, { cardId: "companion" }), AGENT);
  }
});

test("平台回调缺失时设置仍可读写、状态不可用、重启返回 AGENT_UNAVAILABLE", async t => {
  const service = createService(t, { configStore: { loadV2: async () => CONFIG, patch: async () => CONFIG } });
  const { call } = await connect(t, service);
  assert.equal((await call("companion.settings.get", {})).agent, null);
  assert.deepEqual(await call("companion.settings.patch", { expectedRevision: 7, patch: {} }), { config: CONFIG });
  assert.deepEqual(await call("companion.agent.status", {}), { available: false });
  await assert.rejects(call("companion.codex.restart", {}), { code: "AGENT_UNAVAILABLE" });
  await assert.rejects(call("companion.codex.restart", { reason: 1 }), { code: "RPC_INVALID_PARAMS" });
});

test("单独提供一个平台回调时，另一个仍遵循缺省行为", async t => {
  const statusOnly = createService(t, { platform: { getAgentStatus: () => AGENT } });
  await assert.rejects(statusOnly.handleRpc("companion.codex.restart"), { code: "AGENT_UNAVAILABLE" });
  const restartOnly = createService(t, { platform: { requestCodexRestart: async () => ({ accepted: true }) } });
  assert.equal((await restartOnly.handleRpc("companion.settings.get")).agent, null);
  assert.deepEqual(await restartOnly.handleRpc("companion.agent.status"), { available: false });
});

test("平台严格拒绝参数类型、多余字段、缺失或非法 revision/patch/reason，不调用后端", async t => {
  const unexpected = () => assert.fail("非法参数不能调用后端");
  const service = createService(t, {
    configStore: { loadV2: unexpected, patch: unexpected },
    platform: { getAgentStatus: unexpected, requestCodexRestart: unexpected }
  });
  const invalid = METHODS.flatMap(method => [null, [], "", 1, false, new Date(), { extra: true }].map(params => [method, params]));
  for (const expectedRevision of [undefined, null, "7", true, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    invalid.push(["companion.settings.patch", { expectedRevision, patch: {} }]);
  }
  for (const patch of [undefined, null, [], "", 1, false, new Date()]) {
    invalid.push(["companion.settings.patch", { expectedRevision: 7, patch }]);
  }
  invalid.push(["companion.settings.patch", { expectedRevision: 7, patch: {}, extra: true }]);
  for (const reason of [undefined, null, [], {}, 1, false, "r".repeat(65)]) {
    invalid.push(["companion.codex.restart", { reason }]);
  }
  for (const [method, params] of invalid) {
    await assert.rejects(service.handleRpc(method, params), { code: "RPC_INVALID_PARAMS" }, `${method}: ${JSON.stringify(params)}`);
  }
});

test("页面收到的非法平台参数统一返回 RPC_INVALID_PARAMS，旧卡片封包错误码不变", async t => {
  const unexpected = () => assert.fail("非法参数不能调用后端");
  const service = createService(t, {
    configStore: { loadV2: unexpected, patch: unexpected },
    platform: { getAgentStatus: unexpected, requestCodexRestart: unexpected }
  });
  const { call, client } = await connect(t, service);
  for (const method of METHODS) {
    for (const params of [null, [], "bad", 1, false, { extra: true }]) {
      await assert.rejects(call(method, params), { code: "RPC_INVALID_PARAMS" });
    }
  }
  for (const params of [{ patch: {} }, { expectedRevision: 1, patch: null }, { expectedRevision: -1, patch: {} }]) {
    await assert.rejects(call("companion.settings.patch", params), { code: "RPC_INVALID_PARAMS" });
  }
  await assert.rejects(call("companion.codex.restart", { reason: "r".repeat(65) }), { code: "RPC_INVALID_PARAMS" });
  await assert.rejects(client.scoped("emby", 1)("emby.connection.status", []), { code: "RPC_INVALID_REQUEST" });
});

test("平台方法拒绝不匹配的 cardId，bridge 同样拒绝伪造命名空间", async t => {
  const service = createService(t);
  for (const method of METHODS) {
    for (const cardId of ["emby", "", null, 1]) {
      await assert.rejects(service.handleRpc(method, {}, { cardId }), { code: "RPC_INVALID_REQUEST" });
    }
  }
  const { call } = await connect(t, service, { mapRequest: request => ({ ...request, cardId: "emby" }) });
  for (const method of METHODS) await assert.rejects(call(method, {}), { code: "RPC_INVALID_REQUEST" });
});

test("未知 companion 方法不会落到卡片注册表", async t => {
  const service = createService(t);
  service.registry.handleRpc = () => assert.fail("未知平台方法不能进入卡片注册表");
  const { call } = await connect(t, service);
  await assert.rejects(call("companion.unknown", {}), { code: "RPC_METHOD_NOT_FOUND" });
});

test("ConfigError 原对象抛出，经 bridge 序列化及页面 receiveRpc 后保留 code/message/revision", async t => {
  for (const [code, details] of [["CONFIG_CONFLICT", { revision: 12 }], ["CONFIG_PATCH_INVALID", {}]]) {
    const failure = new ConfigError(code, "配置检查失败，请刷新后重试。", { ...details, internalState: "private" });
    const service = createService(t, { configStore: { patch: () => { throw failure; } } });
    const params = { expectedRevision: 7, patch: { launch: { proxy: { port: 70000 } } } };
    await assert.rejects(service.handleRpc("companion.settings.patch", params), error => error === failure);
    const { call, connection } = await connect(t, service);
    await assert.rejects(call("companion.settings.patch", params), error => {
      assert.equal(error.code, code);
      assert.equal(error.message, failure.message);
      assert.equal(error.revision, details.revision);
      assert.equal(Object.hasOwn(error, "internalState"), false);
      return true;
    });
    assert.deepEqual(connection.responses[0].response.error, { code, message: failure.message, retryable: false, ...details });
  }
});

test("sanitizeRpcError 只增加合法 revision，保留原有字段白名单与敏感信息脱敏", () => {
  for (const revision of [0, 12, Number.MAX_SAFE_INTEGER]) {
    assert.deepEqual(sanitizeRpcError(new ConfigError("CONFIG_CONFLICT", "配置冲突", { revision })), {
      code: "CONFIG_CONFLICT", message: "配置冲突", retryable: false, revision
    });
  }
  for (const revision of [undefined, null, -1, 1.5, "12", {}, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const sanitized = sanitizeRpcError(new ConfigError("CONFIG_CONFLICT", "Authorization: Bearer secret", { revision, internalState: "private" }));
    assert.deepEqual(sanitized, { code: "CONFIG_CONFLICT", message: "Authorization: Bearer [REDACTED]", retryable: false });
  }
});

test("companion 卡片 id 在 manifest 校验与注入注册路径均被拒绝", () => {
  const manifest = { ...CARD_MANIFESTS[0], id: "companion" };
  assert.throws(() => validateManifest(manifest), { code: "RESERVED_ID", field: "id" });
  assert.throws(() => validateCatalog([manifest]), { code: "RESERVED_ID", field: "id" });
  const options = {
    manifests: [manifest],
    modules: { companion: { createService: () => assert.fail("保留 id 不得初始化卡片服务") } }
  };
  assert.throws(() => new ServiceRegistry(options), /companion.*保留/);
  assert.throws(() => new CodexCompanionService({ ...options, configStore: {} }), /companion.*保留/);
});

test("平台 generation 升级取消旧请求并拒绝旧写入，原有卡片 RPC 与别名不受影响", async t => {
  let resolveStatus;
  let resolveCard;
  let cardContext;
  let statusCalls = 0;
  let patchCalls = 0;
  const service = createService(t, {
    modules: undefined,
    configStore: { loadV2: async () => ({ ...CONFIG, enabled: true }), patch: () => { patchCalls += 1; } },
    platform: { getAgentStatus: () => ++statusCalls === 1 ? new Promise(resolve => { resolveStatus = resolve; }) : AGENT },
    embyService: { handleRpc(method, params, context) {
      assert.equal(method, "connection.status");
      if (params.legacy) return { connected: true };
      cardContext = context;
      return new Promise(resolve => { resolveCard = resolve; });
    } }
  });
  const { client, call, connection } = await connect(t, service);
  const oldStatus = call("companion.agent.status", {});
  const rejected = assert.rejects(oldStatus, { code: "RPC_CANCELLED" });
  const card = client.scoped("emby", 1)("emby.connection.status", {});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof resolveStatus, "function");
  assert.equal(typeof resolveCard, "function");
  assert.deepEqual(await client.scoped("companion", 2)("companion.agent.status", {}), AGENT);
  await rejected;
  assert.equal(cardContext.signal.aborted, false);
  assert.equal(cardContext.cardId, "emby");
  await assert.rejects(call("companion.settings.patch", { expectedRevision: 7, patch: {} }), { code: "RPC_STALE_GENERATION" });
  assert.equal(patchCalls, 0);
  resolveCard({ connected: true });
  assert.deepEqual(await card, { connected: true });
  assert.deepEqual(await service.handleRpc("connection.status", { legacy: true }, { targetId: "legacy" }), { connected: true });
  const count = connection.responses.length;
  resolveStatus(AGENT);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(connection.responses.length, count);
  assert.equal(client.diagnostics().pending, 0);
});

test("已取消或已关闭的平台服务不执行配置写入或重启回调", async t => {
  const unexpected = () => assert.fail("已失效请求不能执行操作");
  const service = createService(t, { configStore: { patch: unexpected }, platform: { requestCodexRestart: unexpected } });
  const controller = new AbortController();
  const canceled = Object.assign(new Error("已取消"), { code: "RPC_CANCELLED" });
  controller.abort(canceled);
  await assert.rejects(service.handleRpc("companion.codex.restart", {}, { signal: controller.signal }), error => error === canceled);
  await service.dispose();
  await assert.rejects(service.handleRpc("companion.settings.patch", { expectedRevision: 7, patch: {} }), { code: "RPC_UNAVAILABLE" });
  await assert.rejects(service.handleRpc("companion.codex.restart", {}), { code: "RPC_UNAVAILABLE" });
});
