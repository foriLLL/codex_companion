import assert from "node:assert/strict";
import { test } from "node:test";
import { createEffects } from "../src/renderer/platform/effects.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("释放幂等，注销也只执行一次", async () => {
  const fx = createEffects();
  let ran = 0;
  const unregister = fx.add(() => {
    ran += 1;
  });
  unregister();
  unregister();
  assert.equal(ran, 1);
  assert.equal(fx.diagnostics().cleanups, 0);
  await fx.dispose();
  await fx.dispose();
  assert.equal(ran, 1);
  assert.equal(fx.diagnostics().disposed, true);
});

test("监听、超时和间隔都会调用回调", async () => {
  const fx = createEffects();
  const target = new EventTarget();
  let clicks = 0;
  let ticks = 0;
  let alarms = 0;
  const stopListen = fx.listen(target, "ping", () => {
    clicks += 1;
  });
  target.dispatchEvent(new Event("ping"));
  fx.timeout(() => {
    alarms += 1;
  }, 20);
  const stopInterval = fx.interval(() => {
    ticks += 1;
  }, 20);
  await delay(70);
  assert.equal(clicks, 1);
  assert.equal(alarms, 1);
  assert.ok(ticks >= 2);
  stopListen();
  target.dispatchEvent(new Event("ping"));
  assert.equal(clicks, 1);
  const frozen = ticks;
  stopInterval();
  await delay(50);
  assert.equal(ticks, frozen);
  await fx.dispose();
});

test("事件和定时器的同步错误与拒绝都会交给 onError", async () => {
  const errors = [];
  const fx = createEffects({
    onError(error) {
      errors.push(error);
    },
  });
  const target = new EventTarget();
  fx.listen(target, "sync", () => {
    throw new Error("监听同步");
  });
  fx.listen(target, "reject", async () => {
    throw new Error("监听拒绝");
  });
  target.dispatchEvent(new Event("sync"));
  target.dispatchEvent(new Event("reject"));
  fx.timeout(() => {
    throw new Error("定时同步");
  }, 15);
  fx.interval(async () => {
    throw new Error("间隔拒绝");
  }, 15);
  await delay(40);
  const messages = errors.map((error) => error.message);
  assert.ok(messages.includes("监听同步"));
  assert.ok(messages.includes("监听拒绝"));
  assert.ok(messages.includes("定时同步"));
  assert.ok(messages.includes("间隔拒绝"));
  await fx.dispose();
});

test("到点的定时器会从活动计数中移除", async () => {
  const fx = createEffects();
  fx.timeout(() => {
    throw new Error("忽略");
  }, 20);
  fx.interval(() => {}, 1000);
  assert.equal(fx.diagnostics().timeouts, 1);
  assert.equal(fx.diagnostics().intervals, 1);
  assert.equal(fx.diagnostics().active, 2);
  await delay(50);
  assert.equal(fx.diagnostics().timeouts, 0);
  assert.equal(fx.diagnostics().intervals, 1);
  assert.equal(fx.diagnostics().active, 1);
  await fx.dispose();
  assert.equal(fx.diagnostics().active, 0);
});

test("中止信号会释放，一开始已中止也同样安全", async () => {
  const ac = new AbortController();
  const fx = createEffects({ signal: ac.signal });
  const target = new EventTarget();
  let ran = 0;
  let clicks = 0;
  fx.add(() => {
    ran += 1;
  });
  fx.listen(target, "ping", () => {
    clicks += 1;
  });
  ac.abort();
  await fx.dispose();
  assert.equal(ran, 1);
  assert.equal(fx.diagnostics().disposed, true);
  target.dispatchEvent(new Event("ping"));
  assert.equal(clicks, 0);

  const early = new AbortController();
  early.abort();
  let late = 0;
  const aborted = createEffects({ signal: early.signal });
  assert.equal(aborted.diagnostics().disposed, true);
  aborted.add(() => {
    late += 1;
  });
  aborted.listen(target, "ping", () => {
    late += 10;
  });
  target.dispatchEvent(new Event("ping"));
  assert.equal(late, 1);
  await aborted.dispose();
  assert.equal(late, 1);
});

test("释放后登记的清理会立刻执行", async () => {
  const fx = createEffects();
  let disconnected = 0;
  const seen = [];
  const original = URL.revokeObjectURL;
  URL.revokeObjectURL = (url) => {
    seen.push(url);
  };
  try {
    await fx.dispose();
    const unregister = fx.add(() => {
      disconnected += 1;
    });
    unregister();
    fx.observe({
      disconnect() {
        disconnected += 1;
      },
    });
    fx.objectUrl("blob:late");
    assert.equal(disconnected, 2);
    assert.deepEqual(seen, ["blob:late"]);
    assert.equal(fx.diagnostics().active, 0);
  } finally {
    URL.revokeObjectURL = original;
  }
});

test("清理抛错或超时后仍继续，并限制异步等待", async () => {
  const errors = [];
  const fx = createEffects({
    cleanupTimeoutMs: 40,
    onError(error) {
      errors.push(error);
    },
  });
  const order = [];
  fx.add(() => {
    throw new Error("同步失败");
  });
  fx.add(() => Promise.reject(new Error("异步失败")));
  fx.add(() => new Promise(() => {}));
  fx.add(() => {
    order.push("done");
  });
  const started = Date.now();
  await fx.dispose();
  const elapsed = Date.now() - started;
  assert.deepEqual(order, ["done"]);
  assert.ok(elapsed >= 30);
  assert.ok(elapsed < 800);
  assert.deepEqual(
    errors.map((error) => error.message),
    ["同步失败", "异步失败", "清理超时"]
  );
  assert.equal(fx.diagnostics().active, 0);
});

test("观察者和对象 URL 的注销会断开并回收", async () => {
  const fx = createEffects();
  let disconnected = 0;
  const seen = [];
  const original = URL.revokeObjectURL;
  URL.revokeObjectURL = (url) => {
    seen.push(url);
  };
  try {
    const stopObserve = fx.observe({
      disconnect() {
        disconnected += 1;
      },
    });
    const stopUrl = fx.objectUrl("blob:one");
    assert.equal(fx.diagnostics().observers, 1);
    assert.equal(fx.diagnostics().objectUrls, 1);
    stopObserve();
    stopObserve();
    stopUrl();
    assert.equal(disconnected, 1);
    assert.deepEqual(seen, ["blob:one"]);
    assert.equal(fx.diagnostics().active, 0);
    fx.observe({
      disconnect() {
        disconnected += 1;
      },
    });
    fx.objectUrl("blob:two");
    await fx.dispose();
    assert.equal(disconnected, 2);
    assert.deepEqual(seen, ["blob:one", "blob:two"]);
  } finally {
    URL.revokeObjectURL = original;
  }
});

test("释放同步停用监听，再等待挂起的异步清理", async () => {
  const fx = createEffects({ cleanupTimeoutMs: 40 });
  const target = new EventTarget();
  let calls = 0;
  fx.add(() => new Promise(() => {}));
  fx.listen(target, "ping", () => {
    calls += 1;
  });
  const done = fx.dispose();
  target.dispatchEvent(new Event("ping"));
  assert.equal(calls, 0);
  assert.equal(fx.diagnostics().active, 0);
  await done;
  assert.equal(calls, 0);
});

test("释放过程中触发的回调不再执行，定时器也被同步清掉", async () => {
  const fx = createEffects({ cleanupTimeoutMs: 40 });
  const target = new EventTarget();
  let calls = 0;
  fx.add(() => {
    target.dispatchEvent(new Event("ping"));
    return new Promise(() => {});
  });
  fx.listen(target, "ping", () => {
    calls += 1;
  });
  fx.timeout(() => {
    calls += 10;
  }, 10);
  fx.interval(() => {
    calls += 100;
  }, 10);
  const done = fx.dispose();
  target.dispatchEvent(new Event("ping"));
  assert.equal(calls, 0);
  assert.equal(fx.diagnostics().active, 0);
  await delay(25);
  assert.equal(calls, 0);
  await done;
  assert.equal(calls, 0);
});

test("前面的异步清理不会挡住后续资源的同步停用", async () => {
  const fx = createEffects({ cleanupTimeoutMs: 200 });
  const order = [];
  fx.add(() => {
    order.push("slow");
    return delay(80);
  });
  fx.add(() => {
    order.push("later");
  });
  const done = fx.dispose();
  assert.deepEqual(order, ["slow", "later"]);
  assert.equal(fx.diagnostics().active, 0);
  await done;
});

test("重入释放返回同一个承诺且只清理一次", async () => {
  const fx = createEffects();
  let ran = 0;
  let nested;
  fx.add(() => {
    ran += 1;
    nested = fx.dispose();
  });
  fx.add(() => {
    ran += 1;
    return delay(20);
  });
  const first = fx.dispose();
  assert.equal(nested, first);
  assert.equal(ran, 2);
  await first;
  await fx.dispose();
  assert.equal(ran, 2);
  assert.equal(fx.diagnostics().disposed, true);
});

test("手动释放会卸下中止监听", async () => {
  const handlers = [];
  const signal = {
    aborted: false,
    addEventListener(_type, fn) {
      handlers.push(fn);
    },
    removeEventListener(_type, fn) {
      const index = handlers.indexOf(fn);
      if (index >= 0) handlers.splice(index, 1);
    },
  };
  const fx = createEffects({ signal });
  let ran = 0;
  fx.add(() => {
    ran += 1;
  });
  assert.equal(handlers.length, 1);
  await fx.dispose();
  assert.equal(handlers.length, 0);
  assert.equal(ran, 1);
  await fx.dispose();
  assert.equal(ran, 1);
});

test("onError 返回的拒绝不会变成未处理拒绝", async () => {
  const unhandled = [];
  const onUnhandled = (reason) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const seen = [];
    const fx = createEffects({
      onError(error) {
        seen.push(error.message);
        return Promise.reject(new Error("onError 拒绝"));
      },
    });
    const target = new EventTarget();
    fx.listen(target, "ping", () => {
      throw new Error("监听失败");
    });
    target.dispatchEvent(new Event("ping"));
    fx.add(() => {
      throw new Error("清理失败");
    });
    await fx.dispose();
    await delay(20);
    assert.deepEqual(seen, ["监听失败", "清理失败"]);
    assert.equal(unhandled.length, 0);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

// 可控单调时钟与原生 timer 队列；检查隐藏时确实没有注册的唤醒任务。
function fakeTimers(t) {
  let now = 0;
  let sequence = 0;
  const pending = new Map();
  const callbacks = [];
  const add = (fn, ms, repeating) => {
    const id = ++sequence;
    const delay = Math.max(1, Number(ms) || 0);
    pending.set(id, { id, fn, deadline: now + delay, period: repeating ? delay : null });
    callbacks.push(fn);
    return id;
  };
  t.mock.method(globalThis, "setTimeout", (fn, ms) => add(fn, ms, false));
  t.mock.method(globalThis, "clearTimeout", id => pending.delete(id));
  t.mock.method(globalThis, "setInterval", (fn, ms) => add(fn, ms, true));
  t.mock.method(globalThis, "clearInterval", id => pending.delete(id));
  t.mock.method(performance, "now", () => now);
  return {
    pending, callbacks,
    advance(ms) {
      const target = now + ms;
      while (true) {
        const next = [...pending.values()].filter(item => item.deadline <= target)
          .sort((a, b) => a.deadline - b.deadline || a.id - b.id)[0];
        if (!next) break;
        now = next.deadline;
        if (next.period === null) pending.delete(next.id);
        else next.deadline += next.period;
        next.fn();
      }
      now = target;
    }
  };
}

test("暂停 timeout 保留剩余时长，多次暂停恢复也不提前执行", async t => {
  const clock = fakeTimers(t);
  const fx = createEffects();
  let alarms = 0;
  fx.timeout(() => { alarms += 1; }, 100);
  clock.advance(30);
  fx.setSuspended(true);
  fx.setSuspended(true);
  assert.equal(clock.pending.size, 0);
  assert.equal(fx.diagnostics().suspended, true);
  assert.equal(fx.diagnostics().timeouts, 1);
  clock.advance(10000);
  assert.equal(alarms, 0);
  fx.setSuspended(false);
  fx.setSuspended(false);
  assert.equal(clock.pending.size, 1);
  clock.advance(40);
  fx.setSuspended(true);
  clock.advance(10000);
  fx.setSuspended(false);
  clock.advance(29);
  assert.equal(alarms, 0);
  clock.advance(1);
  assert.equal(alarms, 1);
  assert.equal(fx.diagnostics().active, 0);
  assert.equal(fx.diagnostics().suspended, false);
  await fx.dispose();
});

test("隐藏时 interval 不保留原生唤醒任务，恢复从完整周期开始且不补 tick", async t => {
  const clock = fakeTimers(t);
  const fx = createEffects();
  let ticks = 0;
  fx.interval(() => { ticks += 1; }, 20);
  clock.advance(25);
  assert.equal(ticks, 1);
  fx.setSuspended(true);
  assert.equal(clock.pending.size, 0);
  clock.advance(10000);
  assert.equal(ticks, 1);
  fx.setSuspended(false);
  clock.advance(19);
  assert.equal(ticks, 1);
  clock.advance(1);
  assert.equal(ticks, 2);
  clock.advance(40);
  assert.equal(ticks, 4);
  await fx.dispose();
  assert.equal(clock.pending.size, 0);
});

test("暂停期间新 timer 延迟激活，可取消；暂停资源 dispose 后恢复不会复活", async t => {
  const clock = fakeTimers(t);
  const fx = createEffects();
  let alarms = 0;
  fx.setSuspended(true);
  const cancel = fx.timeout(() => { alarms += 100; }, 10);
  fx.timeout(() => { alarms += 1; }, 30);
  fx.interval(() => { alarms += 10; }, 50);
  assert.equal(clock.pending.size, 0);
  assert.equal(fx.diagnostics().active, 3);
  cancel();
  clock.advance(1000);
  fx.setSuspended(false);
  clock.advance(29);
  assert.equal(alarms, 0);
  clock.advance(1);
  assert.equal(alarms, 1);
  fx.setSuspended(true);
  assert.equal(clock.pending.size, 0);
  await fx.dispose();
  fx.setSuspended(false);
  fx.timeout(() => { alarms += 1000; }, 1);
  fx.interval(() => { alarms += 1000; }, 1);
  clock.advance(1000);
  assert.equal(alarms, 1);
  assert.equal(clock.pending.size, 0);
  assert.equal(fx.diagnostics().active, 0);
});

test("暂停不关闭 listener/observer/URL，signal abort 仍回收全部暂停资源", async t => {
  const clock = fakeTimers(t);
  const controller = new AbortController();
  const fx = createEffects({ signal: controller.signal });
  const target = new EventTarget();
  let clicks = 0;
  let disconnected = 0;
  const revoked = [];
  t.mock.method(URL, "revokeObjectURL", value => revoked.push(value));
  fx.listen(target, "click", () => { clicks += 1; });
  fx.observe({ disconnect() { disconnected += 1; } });
  fx.objectUrl("blob:test");
  fx.timeout(() => { clicks += 100; }, 10);
  fx.interval(() => { clicks += 100; }, 10);
  fx.setSuspended(true);
  target.dispatchEvent(new Event("click"));
  assert.equal(clicks, 1);
  assert.equal(disconnected, 0);
  assert.deepEqual(revoked, []);
  controller.abort();
  await fx.dispose();
  fx.setSuspended(false);
  target.dispatchEvent(new Event("click"));
  clock.advance(1000);
  assert.equal(clicks, 1);
  assert.equal(disconnected, 1);
  assert.deepEqual(revoked, ["blob:test"]);
  assert.equal(clock.pending.size, 0);
  assert.equal(fx.diagnostics().active, 0);
});

test("恢复丢弃旧排队回调，回调内重入暂停及错误上报仍安全", async t => {
  const clock = fakeTimers(t);
  const errors = [];
  const fx = createEffects({ onError: error => { errors.push(error.message); } });
  let timeouts = 0;
  let ticks = 0;
  fx.timeout(() => { timeouts += 1; }, 100);
  fx.interval(() => { ticks += 1; fx.setSuspended(true); throw new Error("tick error"); }, 20);
  const oldCallbacks = [...clock.callbacks];
  clock.advance(10);
  fx.setSuspended(true);
  fx.setSuspended(false);
  for (const callback of oldCallbacks) callback();
  assert.equal(timeouts, 0);
  assert.equal(ticks, 0);
  clock.advance(20);
  assert.equal(ticks, 1);
  assert.deepEqual(errors, ["tick error"]);
  assert.equal(clock.pending.size, 0);
  fx.setSuspended(false);
  await fx.dispose();
  clock.advance(1000);
  assert.equal(timeouts, 0);
  assert.equal(ticks, 1);
});
