import test from "node:test";
import assert from "node:assert/strict";
import { createPluginStorage, createPluginTransport, readToolResult } from "../src/plugin/transport.mjs";

const response = (result) => ({ structuredContent: { id: "fixture", ok: true, result } });

test("插件 RPC 跨 MCP 保留卡片 scope、错误与分片内容，完成后释放传输", async () => {
  const value = { title: "多字节字幕", data: "内容".repeat(200) };
  const bytes = Buffer.from(JSON.stringify(value));
  const calls = [];
  const app = { async callServerTool({ name, arguments: args }) {
    calls.push({ name, ...args });
    if (name === "companion.view") return { structuredContent: { ok: true } };
    if (args.method === "emby.fail") return { isError: true, structuredContent: { id: args.id, ok: false, error: { code: "FIXTURE_FAILURE", message: "暂时不可用", retryable: true } } };
    if (args.method === "emby.load") return response({ __companionTransfer: { version: 1, encoding: "base64-json", id: "transfer-1", totalBytes: bytes.length, chunkBytes: 101 } });
    if (args.method === "transfer.read") {
      const offset = args.params.offset;
      const nextOffset = Math.min(bytes.length, offset + 101);
      return response({ encoding: "base64", offset, nextOffset, totalBytes: bytes.length, data: bytes.subarray(offset, nextOffset).toString("base64"), end: nextOffset === bytes.length });
    }
    return response({ ok: true });
  } };
  const transport = createPluginTransport(app, { viewId: "view-fixture" });
  const rpc = transport.rpcClient.scoped("emby", 7);
  assert.deepEqual(await rpc("load"), value);
  assert.ok(calls.filter((call) => call.method === "transfer.read").length > 2);
  assert.equal(calls.filter((call) => call.method === "transfer.close").length, 1);
  assert.ok(calls.every((call) => call.viewId === "view-fixture" && call.cardId === "emby" && call.generation === 7));
  await assert.rejects(rpc("fail"), { code: "FIXTURE_FAILURE", message: "暂时不可用", retryable: true });
  await transport.dispose();
});

test("插件拒绝超量与错序分片，取消在途分片不遗留 pending 或 unhandled rejection", async () => {
  let mode = "oversized";
  const calls = [];
  let notifyRead;
  const readStarted = new Promise((resolve) => { notifyRead = resolve; });
  const app = { async callServerTool({ name, arguments: args }, options) {
    calls.push(args);
    if (name === "companion.view") return { structuredContent: { ok: true } };
    if (args.method === "rpc.cancel") throw new Error("连接关闭后的取消通知允许失败");
    if (args.method === "transfer.close") return response({ ok: true });
    if (args.method === "transfer.read") {
      if (mode === "order") return response({ encoding: "base64", offset: 4, nextOffset: 3, totalBytes: 8, data: "" });
      notifyRead();
      return new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }));
    }
    return response({ __companionTransfer: { version: 1, encoding: "base64-json", id: "fixture-transfer", totalBytes: mode === "oversized" ? 20 * 1024 * 1024 : 8 } });
  } };
  const transport = createPluginTransport(app, { viewId: "view-fixture" });
  const rpc = transport.rpcClient.scoped("emby", 1);
  await assert.rejects(rpc("load"), /过大|格式/);
  mode = "order";
  await assert.rejects(rpc("load"), /传输中断/);
  mode = "cancel";
  const request = rpc.request("load");
  const rejected = assert.rejects(request.promise, { code: "ABORTED" });
  await readStarted;
  request.cancel();
  await rejected;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(transport.rpcClient.diagnostics().pending, 0);
  assert.ok(calls.some((args) => args.method === "rpc.cancel" && args.params.requestId === request.id));
  assert.equal(calls.filter((args) => args.method === "transfer.close").length, 3);
  await transport.dispose();
});

function stateFixture() {
  const values = new Map();
  const revisions = new Map();
  const writes = [];
  return {
    writes,
    replace(key, value) { values.set(key, value); revisions.set(key, (revisions.get(key) ?? 0) + 1); },
    async state(args) {
      const { key } = args;
      if (args.operation === "get" && !key) return { entries: Object.fromEntries(values), revisions: Object.fromEntries(revisions) };
      if (args.operation === "get") return { key, value: values.get(key) ?? null, revision: revisions.get(key) ?? null };
      if (args.expectedRevision !== (revisions.get(key) ?? null)) throw Object.assign(new Error("存档已更新"), { code: "STATE_CONFLICT" });
      writes.push(args);
      if (args.value === null) { values.delete(key); revisions.delete(key); }
      else { values.set(key, args.value); revisions.set(key, (revisions.get(key) ?? 0) + 1); }
      return { key, value: args.value, revision: revisions.get(key) ?? null };
    }
  };
}

test("插件存档合并频繁更新、跨页面恢复稳定 scope，清理时写回最终进度", async () => {
  const fixture = stateFixture();
  const storage = await createPluginStorage(fixture, { debounceMs: 10_000 });
  storage.local.setItem("game", "first");
  storage.local.setItem("game", "second");
  storage.local.setItem("game", "final");
  assert.equal(storage.local.getItem("game"), "final");
  assert.equal(fixture.writes.length, 0);
  await storage.dispose();
  assert.equal(fixture.writes.length, 1);
  const next = await createPluginStorage(fixture);
  assert.equal(next.local.getItem("game"), "final");
  assert.equal(next.session.getItem("companion.platform.scopeId"), storage.session.getItem("companion.platform.scopeId"));
  assert.throws(() => storage.local.setItem("game", "late"), { code: "STATE_DISPOSED" });
  await next.dispose();
});

test("插件存档遇到其他窗口写入时保护已保存内容，并载入最新记录", async () => {
  const fixture = stateFixture();
  fixture.replace("game", "original");
  const storage = await createPluginStorage(fixture, { debounceMs: 10_000 });
  fixture.replace("game", "other-window");
  storage.local.setItem("game", "stale");
  await assert.rejects(storage.flush(), { code: "STATE_CONFLICT" });
  assert.equal(fixture.writes.length, 0);
  assert.equal(storage.local.getItem("game"), "other-window");
  await storage.dispose();
});

test("显式保存失败会阻止退出，保留待保存进度并允许恢复后重试", async () => {
  const fixture = stateFixture();
  const state = fixture.state.bind(fixture);
  let unavailable = true;
  fixture.state = async (args) => {
    if (args.operation === "set" && unavailable) throw Object.assign(new Error("磁盘空间不足，进度尚未保存"), { code: "ENOSPC" });
    return state(args);
  };
  const storage = await createPluginStorage(fixture, { debounceMs: 10_000 });
  storage.local.setItem("game", "final");
  let stopped = false;
  const stop = async () => { await storage.flush(); stopped = true; };
  await assert.rejects(stop(), { code: "ENOSPC" });
  assert.equal(stopped, false);
  assert.equal(storage.local.getItem("game"), "final");
  assert.equal(fixture.writes.length, 0);
  unavailable = false;
  await stop();
  assert.equal(stopped, true);
  assert.equal((await state({ operation: "get", key: "game" })).value, "final");
  await storage.dispose();
});

test("自动保存失败只报告一次，不产生未处理异常，关闭时仍能保存最终进度", async () => {
  const fixture = stateFixture();
  const state = fixture.state.bind(fixture);
  let unavailable = true;
  fixture.state = async (args) => {
    if (args.operation === "set" && unavailable) throw Object.assign(new Error("连接中断"), { code: "RPC_UNAVAILABLE" });
    return state(args);
  };
  const errors = [];
  let reported;
  const failed = new Promise(resolve => { reported = resolve; });
  const storage = await createPluginStorage(fixture, { debounceMs: 1, onError: error => { errors.push(error); reported(); } });
  storage.local.setItem("game", "final");
  await failed;
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "RPC_UNAVAILABLE");
  unavailable = false;
  await storage.dispose();
  assert.equal((await state({ operation: "get", key: "game" })).value, "final");
});

test("清理时写入失败如实返回，后续重试不会丢失最后进度", async () => {
  const fixture = stateFixture();
  const state = fixture.state.bind(fixture);
  let unavailable = true;
  fixture.state = async (args) => {
    if (args.operation === "set" && unavailable) throw Object.assign(new Error("写入失败"), { code: "EACCES" });
    return state(args);
  };
  const storage = await createPluginStorage(fixture, { debounceMs: 10_000 });
  storage.local.setItem("game", "final");
  await assert.rejects(storage.dispose(), { code: "EACCES" });
  unavailable = false;
  await storage.dispose();
  assert.equal((await state({ operation: "get", key: "game" })).value, "final");
});

test("关闭时等待正在保存的请求，并继续写回保存期间产生的最终修改", async () => {
  const fixture = stateFixture();
  const baseState = fixture.state.bind(fixture);
  let finish;
  let started;
  const requestStarted = new Promise((resolve) => { started = resolve; });
  fixture.state = async (args) => {
    if (args.operation === "set" && args.value === "first") {
      started();
      await new Promise((resolve) => { finish = resolve; });
    }
    return baseState(args);
  };
  const storage = await createPluginStorage(fixture, { debounceMs: 10_000 });
  storage.local.setItem("game", "first");
  const saving = storage.flush();
  await requestStarted;
  storage.local.setItem("game", "final");
  const closing = storage.dispose();
  finish();
  await Promise.all([saving, closing]);
  assert.deepEqual(fixture.writes.map(({ value }) => value), ["first", "final"]);
  assert.equal((await fixture.state({ operation: "get", key: "game" })).value, "final");
});

test("重启前的显式保存等待已有请求和后续最终修改全部完成", async () => {
  const fixture = stateFixture();
  const state = fixture.state.bind(fixture);
  let finishFirst, finishFinal, notifyFirst, notifyFinal;
  const firstStarted = new Promise(resolve => { notifyFirst = resolve; });
  const finalStarted = new Promise(resolve => { notifyFinal = resolve; });
  fixture.state = async args => {
    if (args.operation === "set") {
      if (args.value === "first") { notifyFirst(); await new Promise(resolve => { finishFirst = resolve; }); }
      if (args.value === "final") { notifyFinal(); await new Promise(resolve => { finishFinal = resolve; }); }
    }
    return state(args);
  };
  const storage = await createPluginStorage(fixture, { debounceMs: 10_000 });
  storage.local.setItem("game", "first");
  const saving = storage.flush();
  await firstStarted;
  storage.local.setItem("game", "final");
  let stopped = false;
  const stopping = storage.flush().then(() => { stopped = true; });
  finishFirst();
  await finalStarted;
  assert.equal(stopped, false, "首个保存返回时最终进度仍未落盘，不得关闭宿主");
  finishFinal();
  await Promise.all([saving, stopping]);
  assert.equal(stopped, true);
  assert.deepEqual(fixture.writes.map(({ value }) => value), ["first", "final"]);
  await storage.dispose();
});

test("MCP 业务错误通过 structuredContent 或文本回传均不会被当成成功", () => {
  assert.throws(() => readToolResult({ isError: true, content: [{ type: "text", text: '{"error":{"code":"DENIED","message":"不可用"}}' }] }), { code: "DENIED", message: "不可用" });
  assert.throws(() => readToolResult({ content: [] }), /不完整/);
});
