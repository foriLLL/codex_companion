import assert from "node:assert/strict";
import { test } from "node:test";
import { createEffects } from "../src/renderer/platform/effects.mjs";
import { createMediaScope } from "../src/renderer/media/scope.mjs";

function setup(implementation = async () => ({})) {
  const controller = new AbortController();
  const errors = [];
  const effects = createEffects({ signal: controller.signal });
  const calls = [];
  const cancellations = [];
  const rpc = () => {};
  rpc.request = (method, params, options) => {
    calls.push({ method, params, options });
    return { id: String(calls.length), promise: implementation(method, params, options) };
  };
  rpc.cancel = (id) => cancellations.push(id);
  const ctx = { signal: controller.signal, effects, rpc, reportError: (error) => errors.push(error.message) };
  return { ...ctx, controller, errors, calls, cancellations, scope: createMediaScope(ctx) };
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("媒体 RPC 保留参数/取消委托并合并实例与调用信号", async () => {
  const instance = setup(async () => ({ value: true }));
  const requestController = new AbortController();
  const request = instance.scope.requestRpc("resource.load", { url: "fixture" }, { signal: requestController.signal, timeoutMs: 123 });
  assert.equal(instance.scope.pendingRpcCount(), 1);
  assert.deepEqual(await request.promise, { value: true });
  assert.equal(instance.scope.pendingRpcCount(), 0);
  assert.equal(instance.calls[0].options.timeoutMs, 123);
  requestController.abort();
  assert.equal(instance.calls[0].options.signal.aborted, true);
  instance.scope.cancelRpc(request.id);
  assert.deepEqual(instance.cancellations, ["1"]);
  await instance.scope.dispose();
});

test("卸载后迟到 RPC 结果拒绝，后续请求不能到达平台", async () => {
  let resolve;
  const instance = setup(() => new Promise((yes) => { resolve = yes; }));
  const pending = instance.scope.rpc("home.get");
  instance.controller.abort();
  resolve({ late: true });
  await assert.rejects(pending, { code: "ABORTED" });
  await assert.rejects(instance.scope.rpc("home.get"), { code: "ABORTED" });
  assert.equal(instance.calls.length, 1);
  assert.equal(instance.calls[0].options.signal.aborted, true);
});

test("所有事件、定时器及 Blob URL 在卸载时释放，旧 API 失效", async () => {
  const instance = setup();
  const target = new EventTarget();
  let ran = 0;
  instance.scope.listen(target, "ping", () => { ran += 1; });
  const guarded = instance.scope.guard(() => { ran += 100; });
  target.dispatchEvent(new Event("ping"));
  const url = instance.scope.createObjectURL(new Blob(["fixture"]));
  assert.equal(await (await fetch(url)).text(), "fixture");
  // Blob 的异步读取可能超过计时器期限；从这里开始验证卸载同步清理。
  instance.scope.setTimeout(() => { ran += 100; }, 5);
  instance.scope.setInterval(() => { ran += 100; }, 5);
  const done = instance.scope.dispose();
  assert.equal(instance.scope.dispose(), done);
  target.dispatchEvent(new Event("ping"));
  guarded();
  await done;
  await delay(20);
  assert.equal(ran, 1);
  await assert.rejects(fetch(url));
  assert.equal(instance.scope.effects.diagnostics().active, 0);
  assert.equal(instance.effects.diagnostics().active, 0);
});

test("手动移除监听器与取消定时器保持原语义", async () => {
  const instance = setup();
  const target = new EventTarget();
  let calls = 0;
  const listener = () => { calls += 1; };
  instance.scope.listen(target, "ping", listener);
  instance.scope.unlisten(target, "ping", listener);
  const timer = instance.scope.setTimeout(listener, 5);
  instance.scope.clearTimeout(timer);
  target.dispatchEvent(new Event("ping"));
  await delay(20);
  assert.equal(calls, 0);
  await instance.scope.dispose();
});

test("事件异步拒绝和同步错误通过 reportError 隔离", async () => {
  const instance = setup();
  const target = new EventTarget();
  instance.scope.listen(target, "sync", () => { throw new Error("同步"); });
  instance.scope.listen(target, "async", async () => { throw new Error("异步"); });
  target.dispatchEvent(new Event("sync"));
  target.dispatchEvent(new Event("async"));
  await delay(0);
  assert.deepEqual(instance.errors, ["同步", "异步"]);
  await instance.scope.dispose();
});

test("媒体清理重入仍返回同一承诺并继续清理", async () => {
  const instance = setup();
  let nested;
  let cleaned = 0;
  instance.scope.effects.add(() => { nested = instance.scope.dispose(); });
  instance.scope.effects.add(() => { cleaned += 1; throw new Error("清理失败"); });
  instance.scope.effects.add(() => { cleaned += 1; });
  const done = instance.scope.dispose();
  assert.equal(done, nested);
  await done;
  assert.equal(cleaned, 2);
  assert.deepEqual(instance.errors, ["清理失败"]);
});
