import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CompanionConfig } from "../src/companion-config.mjs";
import { CodexCompanionService } from "../src/codex-companion-service.mjs";
import { EMBY_OPERATIONS } from "../src/cards/emby/service.mjs";
import { HONGGUO_OPERATIONS } from "../src/cards/hongguo/service.mjs";
import { CompanionPluginBackend, PLUGIN_UI_URI } from "../src/plugin/backend.mjs";
import { createCompanionMcpServer } from "../src/plugin/server.mjs";
import { assertMode } from "./helpers/permissions.mjs";

const silentLogger = { warn() {} };
const rpc = (viewId, method = "emby.connection.status", options = {}) => ({
  viewId, id: randomUUID(), method, cardId: method.split(".")[0], generation: 1, params: {}, ...options
});

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "companion-plugin-backend-"));
  const configStore = new CompanionConfig({ path: join(directory, "config-v2.json"), execFileImpl: async () => ({ stdout: "" }) });
  const calls = [];
  const disposed = [];
  const engine = options.engine ?? {
    async handleRpc(method, params, context) { calls.push({ method, params, context }); return { method }; },
    async disposeTarget(targetId) { disposed.push(targetId); },
    async dispose() {}
  };
  const service = new CodexCompanionService({
    configStore, embyService: engine, hongguoService: engine,
    inspectCodexProxy: async () => ({ running: false, proxyPort: null }),
    logger: silentLogger
  });
  const backend = new CompanionPluginBackend({ configStore, service, logger: silentLogger, ...options });
  await backend.start({ watchConfig: false });
  t.after(async () => { await backend.dispose(); await rm(directory, { recursive: true, force: true }); });
  return { backend, configStore, directory, calls, disposed, engine };
}

test("插件后端复用全部注册卡片方法，拒绝别名、跨卡片和任意字段", async t => {
  const { backend, calls } = await fixture(t);
  const viewId = randomUUID();
  for (const operation of EMBY_OPERATIONS) {
    const response = await backend.rpc(rpc(viewId, `emby.${operation}`));
    assert.equal(response.ok, true, operation);
  }
  for (const operation of HONGGUO_OPERATIONS) {
    const response = await backend.rpc(rpc(viewId, `hongguo.${operation}`));
    assert.equal(response.ok, true, operation);
  }
  assert.equal(calls.length, EMBY_OPERATIONS.length + HONGGUO_OPERATIONS.length);
  assert.equal(calls[0].context.transport, "mcp");
  assert.equal(calls[0].context.mediaTransport, "rpc");
  assert.ok(calls[0].context.targetId.includes(viewId));
  assert.equal((await backend.rpc(rpc(viewId, "proxy.status"))).ok, true);
  assert.equal((await backend.rpc(rpc(viewId, "games.lifecycle.dispose"))).ok, true);
  for (const request of [
    rpc(viewId, "auth.login", { cardId: "emby" }),
    rpc(viewId, "emby.connection.status", { cardId: "hongguo" }),
    rpc(viewId, "emby.execute"), rpc(viewId, "unknown.run"),
    rpc(viewId, "emby.connection.status", { threadId: "untrusted" }),
    rpc("not-a-view"), rpc(viewId, "emby.connection.status", { generation: -1 }),
    rpc(viewId, "emby.connection.status", { params: JSON.parse('{"__proto__":{"polluted":true}}') })
  ]) assert.equal((await backend.rpc(request)).ok, false);
  assert.equal({}.polluted, undefined);
});

test("取消、重复 id 与 generation 只影响当前页面卡片", async t => {
  const started = [];
  let onStarted;
  let starting = new Promise(resolve => { onStarted = resolve; });
  const engine = {
    async handleRpc(method, _params, context) {
      if (method !== "search") return { method };
      return new Promise((resolve, reject) => {
        started.push(context);
        onStarted();
        context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true });
      });
    }, async disposeTarget() {}, async dispose() {}
  };
  const { backend } = await fixture(t, { engine });
  const viewId = randomUUID();
  const pending = backend.rpc(rpc(viewId, "emby.search", { id: "slow" }));
  await starting;
  assert.equal(started.length, 1);
  const duplicate = await backend.rpc(rpc(viewId, "emby.search", { id: "slow" }));
  assert.equal(duplicate.error.code, "RPC_DUPLICATE_REQUEST");
  const cancel = (view, cardId = "emby", generation = 1) => backend.rpc(rpc(view, "rpc.cancel", { cardId, generation, params: { requestId: "slow" } }));
  assert.equal((await cancel(randomUUID())).result.cancelled, false);
  assert.equal((await cancel(viewId, "hongguo")).result.cancelled, false);
  assert.equal(started[0].signal.aborted, false);
  assert.equal((await cancel(viewId)).result.cancelled, true);
  assert.equal((await pending).error.code, "RPC_CANCELLED");
  starting = new Promise(resolve => { onStarted = resolve; });
  const older = backend.rpc(rpc(viewId, "emby.search", { id: "older" }));
  await starting;
  assert.equal((await backend.rpc(rpc(viewId, "emby.connection.status", { generation: 2 }))).ok, true);
  assert.equal((await older).error.code, "RPC_CANCELLED");
  assert.equal((await backend.rpc(rpc(viewId))).error.code, "RPC_STALE_GENERATION");
  assert.equal((await backend.rpc(rpc(viewId, "emby.lifecycle.dispose", { generation: 2 }))).ok, true);
  assert.equal((await backend.rpc(rpc(viewId, "emby.connection.status", { generation: 2 }))).error.code, "RPC_STALE_GENERATION");
});

test("异常关闭页面由 TTL 清理，迟到请求和超时得到明确错误", async t => {
  let now = 1_000;
  const { backend, disposed } = await fixture(t, { now: () => now, viewTtlMs: 100_000 });
  const viewId = randomUUID();
  await backend.rpc(rpc(viewId));
  now += 100_001;
  await backend.sweepViews();
  assert.ok(disposed.some(target => String(target).includes(viewId)));
  assert.equal(backend.views.size, 0);
  const second = randomUUID();
  await backend.view({ operation: "heartbeat", viewId: second });
  await backend.view({ operation: "dispose", viewId: second });
  assert.equal((await backend.rpc(rpc(second))).error.code, "RPC_VIEW_CLOSED");
  assert.deepEqual(await backend.view({ operation: "dispose", viewId: second }), { ok: true, disposed: true });
  const slow = await fixture(t, {
    requestTimeoutMs: 10,
    engine: { handleRpc: () => new Promise(() => {}), async disposeTarget() {}, async dispose() {} }
  });
  assert.equal((await slow.backend.rpc(rpc(randomUUID()))).error.code, "RPC_TIMEOUT");
});

test("大响应经真实传输分块恢复，页面、卡片和代际均隔离", async t => {
  const expected = { bytes: "视频".repeat(120_000) };
  const engine = { handleRpc: async () => expected, async disposeTarget() {}, async dispose() {} };
  const { backend } = await fixture(t, { engine });
  const viewId = randomUUID();
  const opened = await backend.rpc(rpc(viewId, "emby.resource.load", { id: "large" }));
  const transferId = opened.result.__companionTransfer.id;
  const transferRequest = (view, options = {}) => rpc(view, "transfer.read", { cardId: "emby", params: { transferId, offset: 0 }, ...options });
  assert.equal((await backend.rpc(transferRequest(randomUUID()))).error.code, "TRANSFER_NOT_FOUND");
  assert.equal((await backend.rpc(transferRequest(viewId, { cardId: "hongguo" }))).error.code, "TRANSFER_NOT_FOUND");
  const chunks = [];
  let offset = 0;
  while (true) {
    const response = await backend.rpc(transferRequest(viewId, { params: { transferId, offset } }));
    assert.equal(response.ok, true);
    assert.ok(Buffer.byteLength(JSON.stringify(response)) < 256 * 1024);
    chunks.push(Buffer.from(response.result.data, "base64"));
    offset = response.result.nextOffset;
    if (response.result.end) break;
  }
  assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString("utf8")), expected);
  await backend.rpc(rpc(viewId, "rpc.cancel", { cardId: "emby", params: { requestId: "large" } }));
  assert.equal(backend.transfers.bytes, 0);
  await backend.rpc(rpc(viewId, "emby.resource.load", { id: "second" }));
  await backend.view({ operation: "dispose", viewId });
  assert.equal(backend.transfers.bytes, 0);
});

test("配置更新使用白名单和 revision，并继续写入原 config-v2 文件0600", async t => {
  const { backend, configStore } = await fixture(t);
  const initial = await backend.config({ operation: "get" });
  assert.deepEqual(initial.manifests.map(card => card.id), ["proxy", "tasks", "games", "hongguo", "emby"]);
  const revision = initial.config.revision;
  assert.equal((await backend.config({ operation: "get", knownRevision: revision })).unchanged, true);
  const next = await backend.config({ operation: "update", expectedRevision: revision, patch: { cards: { emby: { enabled: false } }, order: ["emby", "games"] } });
  assert.equal(next.config.revision, revision + 1);
  assert.equal(next.config.cards.emby.enabled, false);
  assert.equal((await backend.rpc(rpc(randomUUID()))).error.code, "CARD_DISABLED");
  await assert.rejects(backend.config({ operation: "update", expectedRevision: revision, patch: { enabled: false } }), { code: "CONFIG_CONFLICT" });
  for (const patch of [{ command: "sh" }, { cards: { arbitrary: { enabled: true } } }, { order: ["../file"] }]) {
    await assert.rejects(backend.config({ operation: "update", expectedRevision: revision + 1, patch }), { code: "CONFIG_PATCH_INVALID" });
  }
  assertMode(await stat(configStore.path), 0o600);
  assert.equal(JSON.parse(await readFile(configStore.path, "utf8")).cards.emby.enabled, false);
});

test("存档跨后台实例持久化、增量更新、冲突检测与损坏保护", async t => {
  const { backend, directory } = await fixture(t);
  const empty = await backend.state({ operation: "get" });
  assert.deepEqual(empty.entries, {});
  const stored = await backend.state({ operation: "set", key: "companion.games", value: '{"score":42}', expectedRevision: null });
  assert.equal(stored.revision, 1);
  await assert.rejects(backend.state({ operation: "set", key: "companion.games", value: "stale", expectedRevision: null }), { code: "STATE_CONFLICT" });
  assert.equal((await backend.state({ operation: "get" })).entries["companion.games"], '{"score":42}');
  const { PluginStateStore } = await import("../src/plugin/state-store.mjs");
  const second = new PluginStateStore({ path: join(directory, "plugin-state.json") });
  assert.equal((await second.get("companion.games")).value, '{"score":42}');
  await Promise.all([second.set("one", "1"), backend.stateStore.set("two", "2")]);
  assert.equal((await second.get()).entries.one, "1");
  assert.equal((await second.get()).entries.two, "2");
  assertMode(await stat(second.path), 0o600);
  await assert.rejects(second.set("__proto__", "x"), { code: "STORAGE_INVALID" });
  await assert.rejects(second.set("large", "x".repeat(129 * 1024)), { code: "STORAGE_QUOTA" });
  await writeFile(second.path, "corrupt", { mode: 0o600 });
  await assert.rejects(second.set("safe", "1"), { code: "STORAGE_CORRUPT" });
  assert.equal(await readFile(second.path, "utf8"), "corrupt");
});

test("真实 MCP initialize/list/read/call 跑通且私有工具全部 app-only", async t => {
  const { backend } = await fixture(t);
  const html = "<!doctype html><html><body>Companion</body></html>";
  const { server } = createCompanionMcpServer({ backend, readUi: async () => html });
  const client = new Client({ name: "companion-backend-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  const { tools } = await client.listTools();
  assert.equal(tools.length, 6);
  for (const tool of tools.filter(tool => tool.name !== "companion.panel")) assert.deepEqual(tool._meta.ui.visibility, ["app"]);
  const panel = tools.find(tool => tool.name === "companion.panel");
  assert.equal(panel._meta.ui.resourceUri, PLUGIN_UI_URI);
  assert.deepEqual(panel._meta["openai/ui"].entrypoints, [{ type: "thread" }]);
  assert.ok(tools.every(tool => !tool._meta?.["openai/ui"]?.entrypoints?.some(entry => entry.type === "global")), "生产插件只能提供会话侧栏入口");
  const resource = await client.readResource({ uri: PLUGIN_UI_URI });
  assert.equal(resource.contents[0].text, html);
  assert.equal(resource.contents[0].mimeType, "text/html;profile=mcp-app");
  assert.deepEqual(resource.contents[0]._meta["openai/ui"], {
    availableDisplayModes: ["inline", "fullscreen"], preferredDisplayMode: "fullscreen"
  });
  const config = await client.callTool({ name: "companion.config", arguments: { operation: "get" } });
  assert.equal(config.structuredContent.manifests.length, 5);
  assert.deepEqual(config.content, []);
  const called = await client.callTool({ name: "companion.rpc", arguments: rpc(randomUUID()) });
  assert.equal(called.structuredContent.ok, true);
  assert.equal(called.structuredContent.result.method, "connection.status");
  const invalid = await client.callTool({ name: "companion.rpc", arguments: rpc(randomUUID(), "emby.run", { command: "sh" }) });
  assert.equal(invalid.isError, true);
  const conflict = await client.callTool({ name: "companion.config", arguments: { operation: "update", expectedRevision: 999, patch: {} } });
  assert.equal(conflict.isError, true);
  assert.equal(conflict.structuredContent.error.code, "CONFIG_CONFLICT");
});
