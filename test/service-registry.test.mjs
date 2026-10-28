import assert from "node:assert/strict";
import test from "node:test";
import { CodexCompanionService } from "../src/codex-companion-service.mjs";
import { ServiceRegistry } from "../src/platform/services/registry.mjs";
import { EMBY_OPERATIONS } from "../src/cards/emby/service.mjs";
import { SERVICE_REGISTRY } from "../src/cards/service-registry.generated.mjs";

const ctx = (cardId, generation = 1, targetId = "target-a", executionContextId = 7) => ({ cardId, generation, targetId, executionContextId });
function fixture() {
  let config = { version: 2, enabled: true, cards: {} };
  const calls = [];
  let sequence = 0;
  const engine = name => ({
    async handleRpc(method, params, context) {
      calls.push({ name, method, params, context });
      if (method.endsWith("playback.open")) return { playbackId: `${name}-${++sequence}` };
      if (method.endsWith("playback.stop")) return { stopped: true };
      return { method };
    },
    disposeTarget(targetId) { calls.push({ name, disposedTarget: targetId }); },
    dispose() { calls.push({ name, disposed: true }); }
  });
  const service = new CodexCompanionService({
    embyService: engine("emby"), hongguoService: engine("hongguo"),
    configStore: { loadV2: async () => config }
  });
  return { service, calls, setConfig: next => { config = next; } };
}

test("生成服务目录用于真实路由；Emby 仅接受有限全名和旧别名", async () => {
  assert.deepEqual(Object.keys(SERVICE_REGISTRY), ["proxy", "hongguo", "emby"]);
  const { service, calls } = fixture();
  for (const method of EMBY_OPERATIONS.filter(value => !value.startsWith("playback."))) {
    await service.handleRpc(method, {}, { targetId: "legacy" });
    await service.handleRpc(`emby.${method}`, {}, ctx("emby"));
  }
  const before = calls.length;
  for (const method of ["totally.unknown", "emby.admin.delete", "hongguo.unknown", "games.fetch", "constructor"]) {
    await assert.rejects(service.handleRpc(method), { code: "RPC_METHOD_NOT_FOUND" });
  }
  assert.equal(calls.length, before);
  await assert.rejects(service.handleRpc("emby.home.get", {}, ctx("hongguo")), { code: "RPC_INVALID_REQUEST" });
  await assert.rejects(service.handleRpc("connection.status", {}, ctx("emby")), { code: "RPC_INVALID_REQUEST" });
});

test("第五张卡仅注册 manifest + service 模块即可路由和清理", async () => {
  const calls = [];
  const registry = new ServiceRegistry({
    manifests: [{ id: "fifth", defaultEnabled: false }],
    modules: { fifth: { createService: () => ({ methods: { ping: () => "pong" }, disposeTarget: key => calls.push(key) }) } },
    loadConfig: async () => ({ enabled: true, cards: { fifth: { enabled: true } } })
  });
  assert.equal(await registry.handleRpc("fifth.ping", {}, ctx("fifth")), "pong");
  assert.deepEqual(await registry.handleRpc("fifth.lifecycle.dispose", {}, ctx("fifth")), { disposed: true });
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0]), ["companion", "target-a", 7, "fifth", 1]);
});

test("禁用卡拒绝新工作但允许停止/清理，applyConfig 主动清理该卡而保留其他卡", async () => {
  const { service, calls, setConfig } = fixture();
  const opened = await service.handleRpc("emby.playback.open", {}, ctx("emby"));
  await service.handleRpc("hongguo.home", {}, ctx("hongguo"));
  const config = { enabled: true, cards: { emby: { enabled: false }, hongguo: { enabled: true } } };
  setConfig(config);
  assert.deepEqual(await service.handleRpc("emby.playback.stop", { playbackId: opened.playbackId }, ctx("emby")), { stopped: true });
  await service.applyConfig(config);
  assert.equal(calls.filter(call => call.name === "hongguo" && call.disposedTarget).length, 0);
  await assert.rejects(service.handleRpc("emby.home.get", {}, ctx("emby", 2)), { code: "CARD_DISABLED" });
  assert.deepEqual(await service.handleRpc("emby.lifecycle.dispose", {}, ctx("emby", 2)), { disposed: true });
  await service.handleRpc("hongguo.home", {}, ctx("hongguo"));
  setConfig({ enabled: false, cards: {} });
  await assert.rejects(service.handleRpc("hongguo.home", {}, ctx("hongguo", 2)), { code: "CARD_DISABLED" });
});

test("旧 generation 不能清理或操作新 generation；卡片、target 和 context 会话隔离", async () => {
  const { service, calls } = fixture();
  const old = await service.handleRpc("emby.playback.open", {}, ctx("emby", 1));
  const newest = await service.handleRpc("emby.playback.open", {}, ctx("emby", 2));
  const other = await service.handleRpc("emby.playback.open", {}, ctx("emby", 1, "target-a", 8));
  await service.handleRpc("hongguo.home", {}, ctx("hongguo"));
  const before = calls.length;
  await assert.rejects(service.handleRpc("emby.lifecycle.dispose", {}, ctx("emby", 1)), { code: "RPC_STALE_GENERATION" });
  await assert.rejects(service.handleRpc("emby.playback.stop", { playbackId: newest.playbackId }, ctx("emby", 1)), { code: "RPC_STALE_GENERATION" });
  assert.equal(calls.length, before);
  await assert.rejects(service.handleRpc("emby.playback.direct.next", { playbackId: newest.playbackId }, ctx("emby", 1, "target-a", 8)), { code: "PLAYBACK_NOT_FOUND" });
  await assert.rejects(service.handleRpc("emby.playback.direct.next", { playbackId: newest.playbackId }, ctx("emby", 1, "target-b", 7)), { code: "PLAYBACK_NOT_FOUND" });
  await service.handleRpc("emby.playback.direct.next", { playbackId: newest.playbackId }, ctx("emby", 2));
  await service.handleRpc("emby.lifecycle.dispose", {}, ctx("emby", 1, "target-a", 8));
  await service.handleRpc("emby.playback.direct.next", { playbackId: newest.playbackId }, ctx("emby", 2));
  assert.ok(old.playbackId && other.playbackId);
  assert.equal(calls.filter(call => call.name === "hongguo" && call.disposedTarget).length, 0);
});

test("卡片清理中一个同步抛错不阻止其他卡的 target/global 清理", async () => {
  const events = [];
  const service = new CodexCompanionService({
    configStore: { loadV2: async () => ({ enabled: true, cards: {} }) },
    hongguoService: { disposeTarget() { events.push("hongguo-target"); throw new Error("target failure"); }, dispose() { events.push("hongguo-global"); throw new Error("global failure"); } },
    embyService: { disposeTarget() { events.push("emby-target"); }, dispose() { events.push("emby-global"); } }
  });
  await assert.rejects(service.disposeTarget("a"), /target failure/);
  await assert.rejects(service.dispose(), /global failure/);
  assert.deepEqual(events, ["hongguo-target", "emby-target", "hongguo-global", "emby-global"]);
});

test("迟到打开会话在旧 scope 再次清理；新 generation 与其他卡不受影响", async () => {
  let finish;
  let oldContext;
  const disposed = [];
  const service = new CodexCompanionService({
    configStore: { loadV2: async () => ({ enabled: true, cards: {} }) },
    embyService: {
      handleRpc(_method, _params, context) {
        if (!oldContext) { oldContext = context; return new Promise(resolve => { finish = resolve; }); }
        return { playbackId: "new-playback" };
      }, disposeTarget(key) { disposed.push(key); }
    }, hongguoService: {}
  });
  const pending = service.handleRpc("emby.playback.open", {}, ctx("emby", 1));
  await new Promise(resolve => setImmediate(resolve));
  await service.handleRpc("emby.playback.open", {}, ctx("emby", 2));
  assert.equal(oldContext.signal.aborted, true);
  const rejected = assert.rejects(pending, { code: "RPC_CANCELLED" });
  finish({ playbackId: "late-old-playback" });
  await rejected;
  assert.ok(disposed.length >= 2);
  assert.ok(disposed.every(key => JSON.parse(key).at(-1) === 1));
  await service.handleRpc("emby.playback.direct.next", { playbackId: "new-playback" }, ctx("emby", 2));
});



test("迟到资源在慢清理期间产生时必须再清理一轮，旧 generation 墓碑不复活", async () => {
  let finishRequest;
  let finishCleanup;
  let cleanupCount = 0;
  const resources = new Set();
  const registry = new ServiceRegistry({
    manifests: [{ id: "fifth", defaultEnabled: true }],
    modules: { fifth: { createService: () => ({
      methods: { open: async () => { await new Promise(resolve => { finishRequest = resolve; }); resources.add("late"); return true; } },
      async disposeTarget() {
        cleanupCount += 1;
        resources.clear();
        if (cleanupCount === 1) await new Promise(resolve => { finishCleanup = resolve; });
      }
    }) } }, loadConfig: async () => ({ enabled: true })
  });
  const pending = registry.handleRpc("fifth.open", {}, ctx("fifth", 1));
  await new Promise(resolve => setImmediate(resolve));
  const cleanup = registry.handleRpc("fifth.lifecycle.dispose", {}, ctx("fifth", 1));
  await new Promise(resolve => setImmediate(resolve));
  const rejected = assert.rejects(pending, { code: "RPC_CANCELLED" });
  finishRequest();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(resources.has("late"), true);
  finishCleanup();
  await Promise.all([cleanup, rejected]);
  assert.equal(cleanupCount, 2);
  assert.equal(resources.size, 0);
  await assert.rejects(registry.handleRpc("fifth.open", {}, ctx("fifth", 1)), { code: "RPC_STALE_GENERATION" });
  await assert.rejects(registry.handleRpc("fifth.open", {}, { targetId: "target-a", executionContextId: 7 }), { code: "RPC_STALE_GENERATION" });
});

test("禁用后的 cleanup 仍受播放归属保护，不能借 stop 操作其他 target 的会话", async () => {
  const { service, calls, setConfig } = fixture();
  const playback = await service.handleRpc("emby.playback.open", {}, ctx("emby", 1, "owner"));
  setConfig({ enabled: true, cards: { emby: { enabled: false } } });
  const count = calls.length;
  await assert.rejects(service.handleRpc("emby.playback.stop", { playbackId: playback.playbackId }, ctx("emby", 1, "other")), { code: "PLAYBACK_NOT_FOUND" });
  assert.equal(calls.length, count);
  assert.deepEqual(await service.handleRpc("emby.playback.stop", { playbackId: playback.playbackId }, ctx("emby", 1, "owner")), { stopped: true });
});

test("一张卡服务初始化抛错不会阻止其他卡的路由和释放", async () => {
  let disposed = 0;
  const registry = new ServiceRegistry({
    manifests: [{ id: "broken", defaultEnabled: true }, { id: "healthy", defaultEnabled: true }],
    modules: {
      broken: { createService() { throw new Error("private-initialization-detail"); } },
      healthy: { createService: () => ({ methods: { ping: () => "pong" }, dispose() { disposed += 1; } }) }
    },
    logger: { warn() { throw new Error("logger is also broken"); } },
    loadConfig: async () => ({ enabled: true, cards: {} })
  });
  assert.equal(await registry.handleRpc("healthy.ping", {}, ctx("healthy")), "pong");
  await assert.rejects(registry.handleRpc("broken.ping", {}, ctx("broken")), error => {
    assert.equal(error.code, "CARD_SERVICE_UNAVAILABLE");
    assert.doesNotMatch(error.message, /private-initialization-detail/);
    return true;
  });
  await registry.dispose();
  assert.equal(disposed, 1);
});
