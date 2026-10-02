import assert from "node:assert/strict";
import { test } from "node:test";
import { createCardLifecycle } from "../src/renderer/platform/lifecycle.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const turn = () => new Promise((resolve) => setImmediate(resolve));

test("挂载期间停用后可立即启用，迟到 handle 只清理一次", async () => {
  const first = deferred();
  const contexts = [];
  const disposed = [];
  const updated = [];
  const lifecycle = createCardLifecycle({
    mount(ctx) {
      contexts.push(ctx);
      if (ctx.generation === 1) return first.promise;
      return { updateSettings: (settings) => updated.push(settings), dispose: (reason) => disposed.push([2, reason]) };
    },
  });
  const oldStart = lifecycle.start({ value: 1 });
  await turn();
  assert.equal(lifecycle.diagnostics().pendingMounts, 1);
  const stopped = lifecycle.dispose("disabled");
  assert.equal(contexts[0].signal.aborted, true);
  assert.equal(lifecycle.diagnostics().active, false);
  assert.equal(lifecycle.dispose("again"), stopped);
  await stopped;
  await lifecycle.start({ value: 2 });
  assert.equal(contexts[1].generation, 2);
  assert.equal(contexts[1].signal.aborted, false);
  first.resolve({
    updateSettings: () => assert.fail("旧代不能收到设置"),
    visibilityChanged: () => assert.fail("旧代不能收到显隐"),
    dispose: (reason) => disposed.push([1, reason]),
  });
  await oldStart;
  assert.deepEqual(disposed, [[1, { reason: "disabled" }]]);
  assert.deepEqual(updated, [{ value: 2 }]);
  assert.equal(lifecycle.diagnostics().state, "active");
  assert.equal(lifecycle.diagnostics().pendingMounts, 0);
  await lifecycle.dispose("done");
  await lifecycle.dispose("again");
  assert.deepEqual(disposed, [[1, { reason: "disabled" }], [2, { reason: "done" }]]);
});

test("活动 start 幂等且上下文保留注入字段与生命周期字段", async () => {
  let count = 0;
  let received;
  const root = {};
  const lifecycle = createCardLifecycle({
    createContext(ctx) {
      assert.equal(ctx.generation, 1);
      return { root, generation: -1, signal: null, effects: null, settings: null };
    },
    mount(ctx) { received = ctx; count += 1; return {}; },
  });
  const ready = lifecycle.start({ initial: true });
  assert.equal(lifecycle.start({ ignored: true }), ready);
  await ready;
  assert.equal(lifecycle.start(), ready);
  assert.equal(count, 1);
  assert.equal(received.root, root);
  assert.equal(received.generation, 1);
  assert.equal(received.signal.aborted, false);
  assert.deepEqual(received.settings, { initial: true });
  assert.equal(typeof received.effects.add, "function");
  await lifecycle.dispose();
});

test("挂载期间仅应用最新设置和显隐", async () => {
  const mounted = deferred();
  const calls = [];
  const lifecycle = createCardLifecycle({ mount: () => mounted.promise });
  lifecycle.visibilityChanged({ visible: true });
  const ready = lifecycle.start("initial");
  await turn();
  lifecycle.update("middle");
  const update = lifecycle.update("latest");
  lifecycle.visibilityChanged({ visible: false, reason: "collapsed" });
  const visible = lifecycle.visibilityChanged({ visible: true, reason: "expanded" });
  mounted.resolve({
    updateSettings: (settings) => calls.push(["settings", settings]),
    visibilityChanged: (state) => calls.push(["visibility", state]),
  });
  await Promise.all([ready, update, visible]);
  assert.deepEqual(calls, [["settings", "latest"], ["visibility", { visible: true, reason: "expanded" }]]);
  await lifecycle.dispose();
});

test("停用丢弃旧代排队的 hooks，旧 hook 不阻塞新一代", async () => {
  const slow = deferred();
  const entered = deferred();
  const calls = [];
  const lifecycle = createCardLifecycle({
    mount: ({ generation }) => ({
      updateSettings(settings) {
        calls.push([generation, settings]);
        if (settings === "slow") { entered.resolve(); return slow.promise; }
      },
      visibilityChanged: () => calls.push([generation, "visible"]),
    }),
  });
  await lifecycle.start("initial");
  const running = lifecycle.update("slow");
  await entered.promise;
  const queued = lifecycle.update("stale");
  const visible = lifecycle.visibilityChanged({ visible: false });
  await lifecycle.dispose("disabled");
  await lifecycle.start("new");
  slow.resolve();
  await Promise.all([running, queued, visible]);
  assert.deepEqual(calls, [[1, "initial"], [1, "slow"], [2, "new"], [2, "visible"]]);
  await lifecycle.dispose();
});

test("hooks 同步抛错和异步拒绝均上报，后续调用继续", async () => {
  const seen = [];
  const lifecycle = createCardLifecycle({
    onError: (error, metadata) => seen.push([error.message, metadata.phase, metadata.generation]),
    mount: () => ({
      updateSettings() { throw new Error("update"); },
      visibilityChanged() { return Promise.reject(new Error("visibility")); },
      dispose() { throw new Error("dispose"); },
    }),
  });
  await lifecycle.start({});
  await lifecycle.visibilityChanged({ visible: false });
  await lifecycle.update({});
  await lifecycle.dispose("done");
  assert.deepEqual(seen, [["update", "updateSettings", 1], ["visibility", "visibilityChanged", 1], ["update", "updateSettings", 1], ["dispose", "dispose", 1]]);
  assert.equal(lifecycle.diagnostics().errors, 4);
});

test("handle 与 effects 异步清理有独立超时，资源同步失效", async () => {
  const seen = [];
  const target = new EventTarget();
  let calls = 0;
  let context;
  const lifecycle = createCardLifecycle({
    timeoutMs: 20,
    onError: (error) => seen.push(error.message),
    mount(ctx) {
      context = ctx;
      ctx.effects.add(() => new Promise(() => {}));
      ctx.effects.listen(target, "ping", () => { calls += 1; });
      ctx.effects.interval(() => { calls += 1; }, 1000);
      return { dispose: () => new Promise(() => {}) };
    },
  });
  await lifecycle.start({});
  const began = Date.now();
  const done = lifecycle.dispose("disabled");
  assert.equal(context.signal.aborted, true);
  target.dispatchEvent(new Event("ping"));
  assert.equal(calls, 0);
  assert.equal(context.effects.diagnostics().active, 0);
  await done;
  assert.ok(Date.now() - began < 800);
  assert.deepEqual(seen.sort(), ["dispose 清理超时", "清理超时"].sort());
});

test("createContext 分配资源后失败也会清理并允许重试", async () => {
  const errors = [];
  let cleaned = 0;
  let mounted = 0;
  let context;
  const lifecycle = createCardLifecycle({
    onError: (error) => errors.push(error.message),
    createContext(ctx) {
      context = ctx;
      ctx.effects.add(() => { cleaned += 1; });
      if (ctx.generation === 1) throw new Error("context");
      return {};
    },
    mount() { mounted += 1; return {}; },
  });
  await lifecycle.start({});
  assert.equal(cleaned, 1);
  assert.equal(mounted, 0);
  assert.equal(context.signal.aborted, true);
  assert.equal(lifecycle.diagnostics().state, "disposed");
  await lifecycle.start({});
  assert.equal(mounted, 1);
  await lifecycle.dispose();
  assert.equal(cleaned, 2);
  assert.deepEqual(errors, ["context"]);
});

test("挂载拒绝回收已登记资源，迟到拒绝不影响新代", async () => {
  const old = deferred();
  const errors = [];
  let cleanups = 0;
  const lifecycle = createCardLifecycle({
    onError: (error, metadata) => errors.push([error.message, metadata.generation]),
    mount(ctx) {
      ctx.effects.add(() => { cleanups += 1; });
      return ctx.generation === 1 ? old.promise : {};
    },
  });
  const ready = lifecycle.start();
  await turn();
  await lifecycle.dispose();
  await lifecycle.start();
  old.reject(new Error("late mount"));
  await ready;
  assert.equal(cleanups, 1);
  assert.equal(lifecycle.diagnostics().active, true);
  assert.deepEqual(errors, [["late mount", 1]]);
  await lifecycle.dispose();
  assert.equal(cleanups, 2);
});

test("onError 抛错和拒绝均不会逃逸", async () => {
  for (const onError of [() => { throw new Error("report"); }, () => Promise.reject(new Error("report"))]) {
    const lifecycle = createCardLifecycle({
      onError,
      mount: () => ({
        updateSettings: () => Promise.reject(new Error("update")),
        dispose: () => Promise.reject(new Error("cleanup")),
      }),
    });
    await lifecycle.start();
    await lifecycle.dispose();
    await turn();
    assert.equal(lifecycle.diagnostics().errors, 2);
  }
});

test("清理重入 dispose 保持同一承诺，重入 start 创建新一代", async () => {
  let nested;
  let restarted;
  let count = 0;
  const lifecycle = createCardLifecycle({
    mount(ctx) {
      count += 1;
      if (ctx.generation === 1) ctx.effects.add(() => {
        nested = lifecycle.dispose("nested");
        restarted = lifecycle.start("new");
      });
      return {};
    },
  });
  await lifecycle.start();
  const stopped = lifecycle.dispose("disabled");
  assert.equal(stopped, nested);
  await Promise.all([stopped, restarted]);
  assert.equal(count, 2);
  assert.equal(lifecycle.diagnostics().active, true);
  await lifecycle.dispose();
});

test("异步 createContext 在停用后完成也不能开始 mount", async () => {
  const created = deferred();
  let calls = 0;
  let context;
  let cleaned = 0;
  const lifecycle = createCardLifecycle({
    createContext(ctx) { context = ctx; return created.promise; },
    mount() { calls += 1; return {}; },
  });
  const ready = lifecycle.start();
  await turn();
  await lifecycle.dispose();
  context.effects.add(() => { cleaned += 1; });
  created.resolve({});
  await ready;
  assert.equal(calls, 0);
  assert.equal(cleaned, 1);
});

test("start 后同一轮立即 dispose 不会挂载，空闲调用保持安全", async () => {
  let calls = 0;
  const lifecycle = createCardLifecycle({ mount() { calls += 1; return {}; } });
  assert.equal(lifecycle.diagnostics().state, "idle");
  await lifecycle.update({});
  await lifecycle.dispose();
  const ready = lifecycle.start();
  await lifecycle.dispose();
  await ready;
  assert.equal(calls, 0);
  assert.equal(lifecycle.diagnostics().effects.active, 0);
});

test("当前 mount 同步抛错和异步拒绝都回收资源", async () => {
  for (const asynchronous of [false, true]) {
    let cleaned = 0;
    const errors = [];
    const lifecycle = createCardLifecycle({
      onError: (error) => errors.push(error.message),
      mount(ctx) {
        ctx.effects.add(() => { cleaned += 1; });
        if (asynchronous) return Promise.reject(new Error("mount"));
        throw new Error("mount");
      },
    });
    await lifecycle.start();
    assert.equal(cleaned, 1);
    assert.equal(lifecycle.diagnostics().active, false);
    assert.equal(lifecycle.diagnostics().pendingMounts, 0);
    assert.deepEqual(errors, ["mount"]);
    await lifecycle.dispose();
    assert.equal(cleaned, 1);
  }
});

test("迟到 handle 的清理也有超时且拒绝被接住", async () => {
  const mounted = deferred();
  const cleanup = deferred();
  const errors = [];
  let disposed = 0;
  const lifecycle = createCardLifecycle({
    timeoutMs: 10,
    onError: (error) => errors.push(error.message),
    mount: () => mounted.promise,
  });
  const ready = lifecycle.start();
  await turn();
  await lifecycle.dispose();
  mounted.resolve({ dispose() { disposed += 1; return cleanup.promise; } });
  await ready;
  assert.equal(disposed, 1);
  assert.deepEqual(errors, ["dispose 清理超时"]);
  cleanup.reject(new Error("late cleanup"));
  await turn();
  assert.deepEqual(errors, ["dispose 清理超时", "late cleanup"]);
  await lifecycle.dispose();
  assert.equal(disposed, 1);
});
