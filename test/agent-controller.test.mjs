import assert from "node:assert/strict";
import test from "node:test";
import { AgentController } from "../src/agent/controller.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// 全部时间由测试推进，不使用真实计时器，也不接触进程或应用。
function fakeClock(at = 1000000) {
  let time = at;
  const waits = [];
  return {
    now: () => time,
    sleep: (ms) => new Promise((resolve) => { waits.push({ at: time + ms, ms, resolve }); }),
    waits,
    advance(ms) {
      time += ms;
      for (const wait of [...waits]) {
        if (wait.at <= time) {
          waits.splice(waits.indexOf(wait), 1);
          wait.resolve();
        }
      }
    }
  };
}

async function flush() {
  for (let index = 0; index < 60; index += 1) await Promise.resolve();
}

function harness(options = {}) {
  const clock = fakeClock();
  const calls = [];
  let current;
  const app = (overrides = {}) => ({
    pid: 11, key: "11:999000", launchedAt: clock.now() - 1000,
    finishedLaunching: true, arguments: [], ...overrides
  });
  const ours = (overrides = {}) => app({
    arguments: ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=51234"], ...overrides
  });
  const snapshot = (apps = [], overrides = {}) => ({
    apps, frontmostPid: apps[0]?.pid ?? 99, inputStamp: "1:2:3:4:5", inputIdleMs: 10000,
    now: clock.now(), ...overrides
  });
  current = snapshot();
  const impl = {
    snapshot: async () => current,
    quit: async () => ({ accepted: true }),
    launch: async () => ({ launched: true, pid: 22, key: "22:1000500" }),
    show: async () => ({ shown: true }),
    attach: async () => {},
    detach: async () => {},
    record: async () => {},
    notify: async () => {}
  };
  const adapter = Object.fromEntries(Object.keys(impl).map((method) => [method, async (...args) => {
    calls.push({ method, args });
    return impl[method](...args);
  }]));
  const controller = new AgentController({ adapter, now: clock.now, sleep: clock.sleep, ...options });
  return {
    clock, calls, impl, controller, app, ours, snapshot,
    set(snapshot) { current = snapshot; },
    feed(snapshot) { current = snapshot; return controller.handleSnapshot(snapshot); },
    async tick(ms) { clock.advance(ms); await flush(); },
    count(method) { return calls.filter((call) => call.method === method).length; },
    args(method) { return calls.filter((call) => call.method === method).map((call) => call.args); },
    events() { return calls.filter((call) => call.method === "record").map((call) => call.args[0]); }
  };
}

async function startFresh(h, app = h.app()) {
  await h.feed(h.snapshot());
  const done = h.feed(h.snapshot([app]));
  await flush();
  return { app, done };
}

async function exitFresh(h, overrides = {}) {
  h.set(h.snapshot([], overrides));
  await h.tick(200);
  h.set(h.snapshot([], overrides));
  await h.tick(250);
}

test("C2.1/2：识别 ours，重复快照只 attach 一次，key 消失时 detach", async () => {
  const h = harness();
  const app = h.ours();
  await h.feed(h.snapshot([app]));
  await h.feed(h.snapshot([app]));
  assert.deepEqual(h.args("attach"), [[{ pid: 11, key: app.key, port: 51234 }]]);
  assert.deepEqual(h.controller.status(), { attachedKey: app.key, attachedPort: 51234, lastEvent: null, lastAttemptAt: 0 });
  await h.feed(h.snapshot());
  assert.deepEqual(h.args("detach"), [[{ key: app.key, reason: "exited" }]]);
  assert.equal(h.controller.status().attachedKey, null);
  assert.equal(h.controller.status().attachedPort, null);
});

test("C2.2/4：多个 ours 最多 attach 一个，先 detach 才切换且不退出或启动", async () => {
  const h = harness();
  const first = h.ours();
  const second = h.ours({ pid: 22, key: "22:1" });
  await h.feed(h.snapshot([first, second]));
  await h.feed(h.snapshot([second, first]));
  assert.equal(h.count("attach"), 1);
  await h.feed(h.snapshot([second]));
  assert.deepEqual(h.calls.filter((call) => ["attach", "detach"].includes(call.method)).map((call) => call.method), ["attach", "detach", "attach"]);
  assert.equal(h.controller.status().attachedKey, second.key);
  assert.equal(h.count("quit"), 0);
  assert.equal(h.count("launch"), 0);
  assert.ok(h.events().includes("multiple-instances"));
});

test("C2.1/3：foreign-debug 与 unknown 按 key 去重，非法端口也绝不退出", async () => {
  for (const args of [null, ["--remote-debugging-port=51234"], ["--remote-debugging-port=0"],
    ["--remote-debugging-port"], ["--remote-debugging-address=0.0.0.0", "--remote-debugging-port=51234"],
    ["--remote-debugging-port=51234", "--remote-debugging-port=51235", "--remote-debugging-address=127.0.0.1"]]) {
    const h = harness();
    const app = h.app({ arguments: args });
    await h.feed(h.snapshot([app]));
    await h.feed(h.snapshot([app]));
    assert.deepEqual(h.events(), [args === null ? "unknown" : "foreign-debug"]);
    assert.equal(h.count("attach") + h.count("quit") + h.count("launch") + h.count("show"), 0);
    await h.feed(h.snapshot([h.app({ key: app.key, arguments: [] })]));
    assert.equal(h.count("quit"), 0, "同一 key 的参数读取恢复也不能自动退出");
  }
});

test("C2.4：多实例期间不退出，减少到一个后也不把已观察实例当成新启动", async () => {
  const h = harness();
  await h.feed(h.snapshot());
  const first = h.app();
  const second = h.app({ pid: 22, key: "22:1" });
  await h.feed(h.snapshot([first, second]));
  await h.feed(h.snapshot([first]));
  assert.deepEqual(h.events(), ["multiple-instances"]);
  assert.equal(h.count("quit") + h.count("launch"), 0);
  assert.equal(h.controller.pendingLaunch, false);
});

test("C2.4：同一组多实例忽略顺序与属性变化，集合变化后才再次记录", async () => {
  const h = harness();
  const first = h.app();
  const second = h.app({ pid: 22, key: "22:1" });
  const replacement = h.app({ pid: 22, key: "22:2" });
  await h.feed(h.snapshot([second, first]));
  await h.feed(h.snapshot([first, second]));
  await h.feed(h.snapshot([{ ...first, finishedLaunching: false }, second], { frontmostPid: 99 }));
  assert.deepEqual(h.args("record"), [["multiple-instances", { processKeys: [first.key, second.key] }]]);

  await h.feed(h.snapshot([first, replacement]));
  await h.feed(h.snapshot([first, second]));
  await h.feed(h.snapshot([first]));
  await h.feed(h.snapshot([second, first]));
  await h.feed(h.snapshot());
  await h.feed(h.snapshot([first, second]));
  assert.deepEqual(h.args("record").map(([, details]) => details.processKeys), [
    [first.key, second.key], [first.key, replacement.key], [first.key, second.key],
    [first.key, second.key], [first.key, second.key]
  ]);
  assert.equal(h.count("quit") + h.count("launch"), 0);
});

test("C2.5：基线已有 plain 仅通知一次，之后守卫变好也永不自动退出", async () => {
  for (const change of [
    { app: { launchedAt: 900000 } },
    { app: { launchedAt: 1000001 } },
    { app: { finishedLaunching: false }, snapshot: { inputIdleMs: 0 } },
    { snapshot: { frontmostPid: 99, inputIdleMs: 0 } },
    { snapshot: { inputIdleMs: 0 } }
  ]) {
    const h = harness();
    const app = h.app(change.app);
    await h.feed(h.snapshot([app], change.snapshot));
    await h.feed(h.snapshot([h.app({ key: app.key })]));
    await h.feed(h.snapshot());
    await h.feed(h.snapshot([h.app({ key: app.key })]));
    assert.deepEqual(h.args("notify"), [["needs-restart", { processKey: app.key }]]);
    assert.equal(h.count("quit") + h.count("launch"), 0);
  }
});

test("C2.5：基线登录竞态已经就绪时允许 fresh 退出", async () => {
  const h = harness();
  const app = h.app({ launchedAt: h.clock.now() - 8000 });
  h.impl.quit = async () => ({ accepted: false, reason: "native-check" });
  await h.feed(h.snapshot([app], { inputIdleMs: 8000 }));
  assert.deepEqual(h.events(), ["attempt", "quit-refused"]);
  assert.equal(h.count("quit"), 1);
  assert.equal(h.count("notify"), 0);
  await h.feed(h.snapshot([app]));
  assert.equal(h.count("quit"), 1);
});

test("C2.5：基线登录竞态尚未启动完成或尚未前台时先 pending，就绪后处理一次", async () => {
  for (const change of [
    { app: { finishedLaunching: false } },
    { snapshot: { frontmostPid: 99 } },
    { app: { finishedLaunching: false }, snapshot: { frontmostPid: 99 } }
  ]) {
    const h = harness();
    const app = h.app(change.app);
    await h.feed(h.snapshot([app], change.snapshot));
    await h.feed(h.snapshot([app], change.snapshot));
    assert.equal(h.controller.pendingLaunch, true);
    assert.equal(h.count("quit"), 0);
    assert.equal(h.count("notify"), 0);
    assert.deepEqual(h.events(), []);

    h.clock.advance(300);
    h.impl.quit = async () => ({ accepted: false, reason: "native-check" });
    const ready = { ...app, finishedLaunching: true };
    await h.feed(h.snapshot([ready]));
    await h.feed(h.snapshot([ready]));
    assert.equal(h.controller.pendingLaunch, false);
    assert.equal(h.count("quit"), 1);
    assert.equal(h.count("notify"), 0);
    assert.deepEqual(h.events(), ["attempt", "quit-refused"]);
  }
});

test("C2.5：多实例基线的 plain 都被保护并分别通知", async () => {
  const h = harness();
  const first = h.app();
  const second = h.app({ pid: 22, key: "22:2" });
  await h.feed(h.snapshot([first, second]));
  await h.feed(h.snapshot([first]));
  assert.equal(h.count("notify"), 2);
  assert.equal(h.count("quit"), 0);
});

test("C2.6：关闭自动重开时仅记录且不通知，不会在重新开启后补退出", async () => {
  let enabled = false;
  const h = harness({ autoRelaunch: () => enabled });
  await h.feed(h.snapshot());
  const app = h.app();
  await h.feed(h.snapshot([app]));
  enabled = true;
  await h.feed(h.snapshot([app]));
  assert.deepEqual(h.events(), ["skipped-disabled"]);
  assert.equal(h.count("notify"), 0);
  assert.equal(h.count("quit"), 0);
});

test("C2.5/6：关闭自动重开时基线实例也只记录 skipped-disabled，不通知或 pending", async () => {
  for (const change of [
    {},
    { app: { finishedLaunching: false } },
    { snapshot: { frontmostPid: 99 } },
    { app: { launchedAt: 1 } },
    { snapshot: { inputIdleMs: 0 } }
  ]) {
    const h = harness({ autoRelaunch: () => false });
    const app = h.app(change.app);
    await h.feed(h.snapshot([app], change.snapshot));
    await h.feed(h.snapshot([app], change.snapshot));
    assert.deepEqual(h.args("record"), [["skipped-disabled", { processKey: app.key }]]);
    assert.equal(h.count("notify") + h.count("quit") + h.count("launch"), 0);
    assert.equal(h.controller.pendingLaunch, false);
  }
});

test("C2.6：age、输入空闲时间和输入戳守卫逐项拒绝且不重试", async () => {
  for (const change of [
    { app: { launchedAt: 1000001 } },
    { app: { launchedAt: 991999 } },
    { snapshot: { inputIdleMs: 999 } },
    { snapshot: { inputIdleMs: NaN } },
    { snapshot: { inputStamp: null } },
    { app: { launchedAt: NaN } }
  ]) {
    const h = harness();
    await h.feed(h.snapshot());
    const app = h.app(change.app);
    await h.feed(h.snapshot([app], change.snapshot));
    await h.feed(h.snapshot([h.app({ key: app.key })]));
    assert.deepEqual(h.events(), ["skipped-active"]);
    assert.deepEqual(h.args("notify"), [["skipped", { processKey: app.key }]]);
    assert.equal(h.count("quit"), 0);
    assert.equal(h.controller.pendingLaunch, false);
  }
});

test("C2.6：未完成启动或尚未前台先等待，满足守卫后仅处理一次", async () => {
  for (const change of [{ app: { finishedLaunching: false } }, { snapshot: { frontmostPid: 99 } }]) {
    const h = harness();
    await h.feed(h.snapshot());
    const app = h.app(change.app);
    await h.feed(h.snapshot([app], change.snapshot));
    assert.equal(h.controller.pendingLaunch, true);
    assert.equal(h.count("quit"), 0);
    h.impl.quit = async () => ({ accepted: false, reason: "guard" });
    await h.feed(h.snapshot([h.app({ key: app.key })]));
    assert.equal(h.controller.pendingLaunch, false);
    assert.equal(h.count("quit"), 1);
  }
});

test("C2.6：等待前台或启动完成期间超龄、发生输入或退出即结束等待", async () => {
  for (const change of ["expired", "input", "exited"]) {
    const h = harness();
    await h.feed(h.snapshot());
    const app = h.app({ finishedLaunching: false });
    await h.feed(h.snapshot([app], { frontmostPid: 99 }));
    if (change === "expired") h.clock.advance(8000);
    await h.feed(h.snapshot(change === "exited" ? [] : [app], {
      frontmostPid: 99, inputIdleMs: change === "input" ? 0 : 10000
    }));
    assert.equal(h.controller.pendingLaunch, false);
    assert.equal(h.count("quit"), 0);
    assert.deepEqual(h.events(), change === "exited" ? [] : ["skipped-active"]);
  }
});

test("C2.6：冷却期内只记录一次，边界时刻允许尝试", async () => {
  for (const elapsed of [119999, 120000]) {
    const h = harness({ lastAttemptAt: 1000000 - elapsed });
    await h.feed(h.snapshot());
    h.impl.quit = async () => ({ accepted: false, reason: "guard" });
    const app = h.app();
    await h.feed(h.snapshot([app]));
    await h.feed(h.snapshot([app]));
    assert.equal(h.count("quit"), elapsed === 120000 ? 1 : 0);
    assert.deepEqual(h.events(), elapsed === 120000 ? ["attempt", "quit-refused"] : ["skipped-cooldown"]);
  }
});

test("C2.6/8：attempt 必须先成功落盘；写失败不 quit 且候选不重试", async () => {
  const h = harness();
  await h.feed(h.snapshot());
  const write = deferred();
  h.impl.record = (event) => event === "attempt" ? write.promise : Promise.resolve();
  const app = h.app();
  const done = h.feed(h.snapshot([app]));
  await flush();
  assert.equal(h.count("quit"), 0);
  write.reject(new Error("disk full"));
  await done;
  assert.deepEqual(h.events(), ["attempt", "error"]);
  assert.deepEqual(h.args("record").at(-1), ["error", { message: "disk full" }]);
  assert.equal(h.controller.status().lastAttemptAt, 0);
  h.impl.record = async () => {};
  await h.feed(h.snapshot([app]));
  assert.equal(h.count("quit"), 0);
});

test("C2.6：attempt 写成功之后才 quit，时间戳作为下次冷却依据", async () => {
  const h = harness();
  await h.feed(h.snapshot());
  const write = deferred();
  h.impl.record = (event) => event === "attempt" ? write.promise : Promise.resolve();
  h.impl.quit = async () => ({ accepted: false, reason: "native-guard" });
  const app = h.app();
  const done = h.feed(h.snapshot([app]));
  await flush();
  assert.equal(h.count("quit"), 0);
  write.resolve();
  await done;
  assert.deepEqual(h.args("record")[0], ["attempt", { lastAttemptAt: 1000000, processKey: app.key }]);
  assert.deepEqual(h.args("quit"), [[{ pid: app.pid, key: app.key, mode: "fresh", inputStamp: "1:2:3:4:5" }]]);
  assert.equal(h.controller.status().lastAttemptAt, 1000000);
  await h.feed(h.snapshot([h.app({ pid: 33, key: "33:1" })]));
  assert.equal(h.count("quit"), 1);
  assert.equal(h.events().at(-1), "skipped-cooldown");
});

test("C2.4/6：attempt 落盘期间新快照使守卫失效时不能再 quit", async () => {
  for (const cause of ["multiple", "exited", "input", "foreign", "unknown", "frontmost", "launching", "age"]) {
    const h = harness();
    await h.feed(h.snapshot());
    const gate = deferred();
    h.impl.record = (event) => event === "attempt" ? gate.promise : Promise.resolve();
    const app = h.app();
    const done = h.feed(h.snapshot([app]));
    await flush();
    const changed = cause === "foreign" ? { arguments: ["--remote-debugging-port=0"] }
      : cause === "unknown" ? { arguments: null } : cause === "launching" ? { finishedLaunching: false } : {};
    const apps = cause === "exited" ? [] : cause === "multiple" ? [app, h.app({ pid: 22, key: "22:1" })]
      : [{ ...app, ...changed }];
    const snapshot = h.snapshot(apps, cause === "input" ? { inputStamp: "changed", inputIdleMs: 0 }
      : cause === "frontmost" ? { frontmostPid: 99 } : cause === "age" ? { now: h.clock.now() + 8001 } : {});
    const queued = h.controller.handleSnapshot(snapshot);
    gate.resolve();
    await Promise.all([done, queued]);
    assert.equal(h.count("quit"), 0, cause);
    assert.equal(h.count("launch"), 0, cause);
    assert.ok(h.events().includes("quit-refused"), cause);
  }
});

test("C2.6：退出期间有输入即取消重开，并通知 skipped", async () => {
  const h = harness();
  const { app, done } = await startFresh(h);
  h.set(h.snapshot([], { inputStamp: "2:2:3:4:5" }));
  await h.tick(200);
  await done;
  assert.deepEqual(h.events(), ["attempt", "canceled-by-input"]);
  assert.deepEqual(h.args("notify"), [["skipped", { processKey: app.key }]]);
  assert.equal(h.count("launch"), 0);
});

test("C2.6：退出期间出现另一个实例即终止，包括 PID 重用但 key 改变", async () => {
  for (const keepOld of [false, true]) {
    const h = harness();
    const { app, done } = await startFresh(h);
    const other = h.app({ key: "11:1000200" });
    h.set(h.snapshot(keepOld ? [app, other] : [other]));
    await h.tick(200);
    await done;
    assert.ok(h.events().includes("another-instance"));
    assert.equal(h.count("launch"), 0);
    await h.feed(h.snapshot([other]));
    assert.equal(h.count("quit"), 1);
  }
});

test("C2.6：退出轮询每 200ms，超时不再启动也不再次处理候选", async () => {
  const h = harness({ quitTimeoutMs: 500 });
  const { app, done } = await startFresh(h);
  assert.deepEqual(h.clock.waits.map((wait) => wait.ms), [500, 200]);
  await h.tick(200);
  assert.deepEqual(h.clock.waits.map((wait) => wait.ms), [500, 200]);
  await h.tick(200);
  assert.deepEqual(h.clock.waits.map((wait) => wait.ms), [500, 100]);
  await h.tick(100);
  await done;
  assert.equal(h.count("snapshot"), 2);
  assert.deepEqual(h.events(), ["attempt", "quit-timeout"]);
  await h.feed(h.snapshot([app]));
  assert.equal(h.count("quit"), 1);
  assert.equal(h.count("launch"), 0);
});

test("C2.6：sleep 或 snapshot 返回时已超时，不能因为看到退出而继续重开", async () => {
  for (const cause of ["sleep", "snapshot"]) {
    const h = harness({ quitTimeoutMs: 500 });
    const { done } = await startFresh(h);
    if (cause === "snapshot") h.impl.snapshot = async () => {
      h.clock.advance(400);
      return h.snapshot();
    };
    else h.set(h.snapshot());
    await h.tick(cause === "sleep" ? 501 : 200);
    await done;
    assert.deepEqual(h.events(), ["attempt", "quit-timeout"]);
    assert.equal(h.count("launch"), 0);
  }
});

test("C2.6/7：snapshot 不返回也会按时结束等待，迟到结果不能继续重开", async () => {
  for (const mode of ["fresh", "user"]) {
    const h = harness({ quitTimeoutMs: 500 });
    let done;
    if (mode === "fresh") ({ done } = await startFresh(h));
    else {
      h.set(h.snapshot([h.app()]));
      await h.controller.requestUserRestart({});
      await h.tick(300);
    }
    const gate = deferred();
    h.impl.snapshot = () => gate.promise;
    await h.tick(200);
    await h.tick(300);
    if (done) await done;
    assert.equal(h.events().at(-1), "quit-timeout");
    assert.equal(h.count("launch"), 0);
    const before = h.calls.length;
    gate.resolve(h.snapshot());
    await flush();
    assert.equal(h.calls.length, before, "超时后丢弃迟到的空快照");
    await h.feed(h.snapshot([h.ours({ key: "33:1", pid: 33 })]));
    assert.equal(h.controller.status().attachedKey, "33:1", "超时后队列仍可正常处理");
  }
});

test("C2.6：退出后的 250ms 窗口再次检查输入和新实例", async () => {
  for (const cause of ["input", "instance"]) {
    const h = harness();
    const { done } = await startFresh(h);
    h.set(h.snapshot());
    await h.tick(200);
    assert.deepEqual(h.clock.waits.map((wait) => wait.ms), [10000, 250]);
    h.set(cause === "input" ? h.snapshot([], { inputStamp: "changed" }) : h.snapshot([h.app({ pid: 33, key: "33:1" })]));
    await h.tick(250);
    await done;
    assert.deepEqual(h.events(), ["attempt", "reopen-canceled"]);
    assert.equal(h.count("launch"), 0);
  }
});

test("C2.6/8：launch 返回失败或抛异常都会记录并通知", async () => {
  for (const throws of [false, true]) {
    const h = harness();
    h.impl.launch = async () => {
      if (throws) throw new Error("launch broke");
      return { launched: false, reason: "already-running" };
    };
    const { done } = await startFresh(h);
    await exitFresh(h);
    await done;
    assert.ok(h.events().includes("launch-failed"));
    assert.equal(h.events().includes("error"), throws);
    assert.equal(h.args("notify").at(-1)[0], "relaunch-failed");
    assert.equal(h.count("show"), 0);
  }
});

test("C2.6：launch 缺少有效实例信息时按失败处理，不调用 show", async () => {
  for (const result of [null, { launched: true }, { launched: true, pid: 22, key: 1 }, { launched: true, pid: 0, key: "0:1" }]) {
    const h = harness();
    h.impl.launch = async () => result;
    const { done } = await startFresh(h);
    await exitFresh(h);
    await done;
    assert.deepEqual(h.events(), ["attempt", "launch-failed"]);
    assert.equal(h.args("notify").at(-1)[0], "relaunch-failed");
    assert.equal(h.count("show"), 0);
  }
});

test("C2.2/6：重开传递守卫，记录 shown，新 key 随后 attach 并在退出时 detach", async () => {
  for (const shown of [false, true]) {
    const h = harness();
    h.impl.show = async () => ({ shown });
    const { app, done } = await startFresh(h);
    await exitFresh(h);
    await done;
    assert.deepEqual(h.args("launch"), [[{ hidden: true, inputStamp: "1:2:3:4:5", frontmostPid: 99 }]]);
    assert.deepEqual(h.args("show"), [[{ pid: 22, key: "22:1000500", inputStamp: "1:2:3:4:5", frontmostPid: 99 }]]);
    assert.deepEqual(h.args("record").at(-1), ["reopened", { processKey: app.key, key: "22:1000500", shown }]);
    assert.deepEqual(h.controller.status().lastEvent, { event: "reopened", at: 1000450 });
    await h.feed(h.snapshot([h.ours({ pid: 22, key: "22:1000500" })]));
    assert.equal(h.controller.status().attachedKey, "22:1000500");
    await h.feed(h.snapshot());
    assert.deepEqual(h.args("detach"), [[{ key: "22:1000500", reason: "exited" }]]);
    assert.equal(h.count("quit"), 1);
  }
});

test("C2.6：重开成功的新 key 即使随后读到 plain 也不会被再次自动退出", async () => {
  const h = harness({ cooldownMs: 0 });
  const { done } = await startFresh(h);
  await exitFresh(h);
  await done;
  await h.feed(h.snapshot([h.app({ pid: 22, key: "22:1000500" })]));
  assert.equal(h.count("quit"), 1);
});

test("C2.7：用户重启先返回 accepted，延迟 300ms 后忽略 fresh、输入与冷却限制重开", async () => {
  const h = harness({ lastAttemptAt: 1000000, autoRelaunch: () => false });
  const app = h.ours({ launchedAt: 1 });
  await h.feed(h.snapshot([app], { frontmostPid: 99, inputIdleMs: 0 }));
  assert.deepEqual(await h.controller.requestUserRestart({ reason: "proxy" }), { accepted: true });
  assert.equal(h.count("quit") + h.count("launch"), 0);
  assert.deepEqual(h.clock.waits.map((wait) => wait.ms), [300]);
  await h.tick(299);
  assert.equal(h.count("quit"), 0);
  await h.tick(1);
  assert.deepEqual(h.args("quit"), [[{ pid: app.pid, key: app.key, mode: "user" }]]);
  h.set(h.snapshot([], { inputStamp: "changed" }));
  await h.tick(200);
  assert.deepEqual(h.args("launch"), [[{ hidden: false }]]);
  assert.equal(h.count("show"), 0);
  assert.equal(h.events().at(-1), "user-restarted");
  assert.deepEqual(h.args("detach"), [[{ key: app.key, reason: "exited" }]]);
  await h.feed(h.snapshot([h.ours({ pid: 22, key: "22:1000500" })]));
  assert.equal(h.controller.status().attachedKey, "22:1000500");
});

test("C2.7：用户重启正在校验或执行时 busy，完成后 rate-limited，到边界可再请求", async () => {
  const h = harness();
  const app = h.app();
  h.set(h.snapshot([app]));
  const request = h.controller.requestUserRestart({ reason: "first" });
  assert.deepEqual(await h.controller.requestUserRestart({}), { accepted: false, reason: "busy" });
  assert.deepEqual(await request, { accepted: true });
  assert.deepEqual(await h.controller.requestUserRestart({}), { accepted: false, reason: "busy" });
  h.impl.quit = async () => ({ accepted: false, reason: "refused" });
  await h.tick(300);
  assert.deepEqual(await h.controller.requestUserRestart({}), { accepted: false, reason: "rate-limited" });
  await h.tick(9699);
  assert.deepEqual(await h.controller.requestUserRestart({}), { accepted: false, reason: "rate-limited" });
  await h.tick(1);
  assert.deepEqual(await h.controller.requestUserRestart({}), { accepted: true });
  h.controller.stop();
  await h.tick(300);
});

test("C2.7：自动重开忙时用户请求返回 busy", async () => {
  const h = harness();
  const { done } = await startFresh(h);
  assert.deepEqual(await h.controller.requestUserRestart({}), { accepted: false, reason: "busy" });
  h.controller.stop();
  await h.tick(200);
  await done;
});

test("C2.7：用户 quit 被拒要记录，不 launch，拒绝不会导致自动退出同一 key", async () => {
  const h = harness();
  const app = h.app();
  await h.feed(h.snapshot());
  h.set(h.snapshot([app]));
  h.impl.quit = async () => ({ accepted: false, reason: "native-refused" });
  assert.deepEqual(await h.controller.requestUserRestart({}), { accepted: true });
  await h.tick(300);
  assert.deepEqual(h.args("record").at(-1), ["user-restart-refused", { processKey: app.key, reason: "native-refused" }]);
  await h.feed(h.snapshot([app]));
  assert.equal(h.count("quit"), 1);
  assert.equal(h.count("launch"), 0);
});

test("C2.3/4/7：用户重启拒绝零个、多个、foreign-debug 与 unknown 实例", async () => {
  for (const kind of ["not-running", "multiple-instances", "foreign-debug", "unknown"]) {
    const h = harness();
    const apps = kind === "not-running" ? [] : kind === "multiple-instances" ? [h.app(), h.app({ key: "22:1", pid: 22 })]
      : [h.app({ arguments: kind === "unknown" ? null : ["--remote-debugging-port=51234"] })];
    h.set(h.snapshot(apps));
    assert.deepEqual(await h.controller.requestUserRestart({}), { accepted: false, reason: kind });
    await flush();
    assert.equal(h.count("quit") + h.count("launch"), 0);
    assert.equal(h.events().at(-1), "user-restart-refused");
  }
});

test("C2.7：延迟期间实例改变或增加时取消用户 quit", async () => {
  for (const keepOld of [false, true]) {
    const h = harness();
    const app = h.app();
    h.set(h.snapshot([app]));
    assert.deepEqual(await h.controller.requestUserRestart({}), { accepted: true });
    const other = h.app({ pid: 22, key: "22:1" });
    h.set(h.snapshot(keepOld ? [app, other] : [other]));
    await h.tick(300);
    assert.equal(h.count("quit") + h.count("launch"), 0);
    assert.equal(h.events().at(-1), "user-restart-refused");
  }
});

test("C2.4/7：用户重启复核期间排队的多实例快照阻止 quit", async () => {
  const h = harness();
  const app = h.app();
  h.set(h.snapshot([app]));
  await h.controller.requestUserRestart({});
  const gate = deferred();
  h.impl.snapshot = () => gate.promise;
  await h.tick(300);
  const queued = h.controller.handleSnapshot(h.snapshot([app, h.app({ pid: 22, key: "22:1" })]));
  gate.resolve(h.snapshot([app]));
  await queued;
  assert.equal(h.count("quit") + h.count("launch"), 0);
  assert.ok(h.events().includes("user-restart-refused"));
});

test("C2.4/7：等待退出时更新的排队快照出现另一个实例会阻止 launch", async () => {
  const h = harness();
  const app = h.app();
  h.set(h.snapshot([app]));
  await h.controller.requestUserRestart({});
  await h.tick(300);
  const gate = deferred();
  h.impl.snapshot = () => gate.promise;
  await h.tick(200);
  const queued = h.controller.handleSnapshot(h.snapshot([h.app({ pid: 22, key: "22:1" })]));
  gate.resolve(h.snapshot());
  await queued;
  assert.equal(h.count("launch"), 0);
  assert.ok(h.events().includes("another-instance"));
});

test("C2.7：用户重启的退出超时、另一个实例与 launch 失败均记录", async () => {
  for (const cause of ["timeout", "another", "launch"]) {
    const h = harness({ quitTimeoutMs: cause === "timeout" ? 200 : 400 });
    const app = h.app();
    h.set(h.snapshot([app]));
    h.impl.launch = async () => ({ launched: false, reason: "failed" });
    assert.deepEqual(await h.controller.requestUserRestart({}), { accepted: true });
    await h.tick(300);
    h.set(h.snapshot(cause === "timeout" ? [app] : cause === "another" ? [h.app({ key: "22:1", pid: 22 })] : []));
    await h.tick(200);
    assert.equal(h.events().at(-1), { timeout: "quit-timeout", another: "another-instance", launch: "launch-failed" }[cause]);
    assert.equal(h.count("launch"), cause === "launch" ? 1 : 0);
  }
});

test("C2 串行化：忙时仅处理最新快照，首个快照仍作基线", async () => {
  const h = harness();
  const attaching = deferred();
  h.impl.attach = () => attaching.promise;
  const first = h.ours();
  const middle = h.ours({ pid: 22, key: "22:1" });
  const last = h.ours({ pid: 33, key: "33:1" });
  const done = h.feed(h.snapshot([first]));
  await flush();
  const middleDone = h.feed(h.snapshot([middle]));
  const lastDone = h.feed(h.snapshot([last]));
  assert.equal(h.count("attach"), 1);
  attaching.resolve();
  await Promise.all([done, middleDone, lastDone]);
  assert.deepEqual(h.args("attach").map(([args]) => args.key), [first.key, last.key]);
  assert.deepEqual(h.args("detach"), [[{ key: first.key, reason: "exited" }]]);
  assert.equal(h.controller.status().attachedKey, last.key);
});

test("C2 串行化：同一轮同步到达的首个基线不能被后续快照覆盖", async () => {
  const h = harness();
  const app = h.app({ finishedLaunching: false });
  const first = h.feed(h.snapshot([app], { inputIdleMs: 0 }));
  const next = h.feed(h.snapshot([h.app({ key: app.key })]));
  await Promise.all([first, next]);
  assert.equal(h.count("quit"), 0);
  assert.equal(h.count("notify"), 1);
});

test("C2 串行化：用户重启占用队列，期间的快照只处理最新一份", async () => {
  const h = harness();
  const app = h.app();
  h.set(h.snapshot([app]));
  await h.controller.requestUserRestart({});
  h.impl.quit = async () => ({ accepted: false, reason: "refused" });
  const first = h.controller.handleSnapshot(h.snapshot([h.ours({ key: "22:1", pid: 22 })]));
  const last = h.controller.handleSnapshot(h.snapshot([h.ours({ key: "33:1", pid: 33 })]));
  assert.equal(h.count("attach"), 0);
  await h.tick(300);
  await Promise.all([first, last]);
  assert.deepEqual(h.args("attach").map(([args]) => args.key), ["33:1"]);
});

test("C2 串行化：退出轮询之后忽略更早的排队快照，不能重新 attach 已退出实例", async () => {
  const h = harness();
  const app = h.ours();
  h.set(h.snapshot([app]));
  await h.controller.requestUserRestart({});
  const done = h.controller.handleSnapshot(h.snapshot([app]));
  await h.tick(300);
  h.set(h.snapshot());
  await h.tick(200);
  await done;
  assert.equal(h.count("attach"), 1);
  assert.equal(h.count("detach"), 1);
  assert.equal(h.controller.status().attachedKey, null);
});

test("C2.8：adapter 及配置回调异常均记录 error，后续快照仍能处理", async () => {
  for (const method of ["attach", "detach", "notify", "quit", "snapshot", "show", "autoRelaunch"]) {
    const h = harness(method === "autoRelaunch" ? { autoRelaunch: () => { throw new Error(method); } } : {});
    if (method === "detach") await h.feed(h.snapshot([h.ours()]));
    if (method !== "autoRelaunch") h.impl[method] = async () => { throw new Error(method); };
    if (method === "attach") await h.feed(h.snapshot([h.ours()]));
    else if (method === "detach") await h.feed(h.snapshot());
    else if (method === "notify") await h.feed(h.snapshot([h.app({ launchedAt: 1 })]));
    else {
      const { done } = await startFresh(h);
      if (method === "snapshot") await h.tick(200);
      if (method === "show") await exitFresh(h);
      await done;
    }
    assert.deepEqual(h.args("record").at(-1), ["error", { message: method }]);
    h.impl.attach = async () => {};
    h.impl.detach = async () => {};
    await h.feed(h.snapshot([h.ours({ key: "99:1", pid: 99 })]));
    assert.equal(h.controller.status().attachedKey, "99:1");
  }
});

test("C2.8：record 连 error 都写失败时也不向调用方抛错或退出进程", async () => {
  const h = harness();
  h.impl.record = async () => { throw new Error("storage unavailable"); };
  await h.feed(h.snapshot());
  await h.feed(h.snapshot([h.app()]));
  assert.deepEqual(h.events(), ["attempt", "error"]);
  assert.equal(h.count("quit"), 0);
  assert.deepEqual(h.controller.status().lastEvent, { event: "error", at: 1000000 });
});

test("C2.8：用户校验与执行异常都被记录，accepted 后不产生未处理拒绝", async () => {
  for (const method of ["snapshot", "quit", "launch"]) {
    const h = harness();
    h.set(h.snapshot([h.app()]));
    h.impl[method] = async () => { throw new Error(method); };
    const result = await h.controller.requestUserRestart({});
    assert.deepEqual(result, method === "snapshot" ? { accepted: false, reason: "error" } : { accepted: true });
    if (method !== "snapshot") await h.tick(300);
    if (method === "launch") {
      h.set(h.snapshot());
      await h.tick(200);
    }
    assert.deepEqual(h.args("record").at(-1), ["error", { message: method }]);
  }
});

test("C2.8：stop 之后不再 snapshot、attach、detach、quit、launch、record 或 notify", async () => {
  const h = harness();
  await h.feed(h.snapshot([h.ours()]));
  const before = h.calls.length;
  h.controller.stop();
  h.controller.stop();
  await h.feed(h.snapshot());
  assert.deepEqual(await h.controller.requestUserRestart({}), { accepted: false, reason: "stopped" });
  assert.equal(h.calls.length, before);
  assert.equal(h.controller.pendingLaunch, false);
});

test("C2.8：stop 在请求微任务启动前也会结束用户请求", async () => {
  const h = harness();
  const response = h.controller.requestUserRestart({});
  h.controller.stop();
  assert.deepEqual(await response, { accepted: false, reason: "stopped" });
  assert.equal(h.calls.length, 0);
});

test("C2.8：stop 在各异步 adapter 边界生效，丢弃排队快照", async () => {
  for (const method of ["record", "quit", "snapshot", "launch", "show", "attach", "detach", "notify"]) {
    const h = harness();
    if (method === "detach") await h.feed(h.snapshot([h.ours()]));
    else if (method !== "attach" && method !== "notify") await h.feed(h.snapshot());
    const gate = deferred();
    h.impl[method] = () => gate.promise;
    const app = method === "attach" ? h.ours() : h.app(method === "notify" ? { launchedAt: 1 } : {});
    const done = h.feed(h.snapshot(method === "detach" ? [] : [app]));
    await flush();
    if (method === "snapshot") await h.tick(200);
    if (method === "launch" || method === "show") await exitFresh(h);
    assert.ok(h.count(method) > 0, method);
    const queued = h.controller.handleSnapshot(h.snapshot([h.ours({ pid: 99, key: "99:1" })]));
    h.controller.stop();
    const before = h.calls.length;
    gate.resolve({ accepted: true, launched: true, pid: 22, key: "22:1", shown: true });
    await Promise.all([done, queued]);
    assert.equal(h.calls.length, before, method);
  }
});

test("C2.8：stop 在 200ms、250ms 或用户 300ms 等待期间不再执行动作", async () => {
  for (const delay of [200, 250, 300]) {
    const h = harness();
    let done;
    if (delay === 300) {
      h.set(h.snapshot([h.app()]));
      assert.deepEqual(await h.controller.requestUserRestart({}), { accepted: true });
    } else {
      ({ done } = await startFresh(h));
      if (delay === 250) {
        h.set(h.snapshot());
        await h.tick(200);
      }
    }
    h.controller.stop();
    const before = h.calls.length;
    await h.tick(delay);
    if (done) await done;
    assert.equal(h.calls.length, before);
  }
});

test("C2.9：已见 key 超过 256 后收缩到当前快照，当前 key 保持去重", async () => {
  const h = harness({ autoRelaunch: () => false });
  await h.feed(h.snapshot());
  const original = h.app({ key: "1:1" });
  await h.feed(h.snapshot([original]));
  for (let index = 2; index <= 256; index += 1) {
    await h.feed(h.snapshot([h.app({ key: `${index}:1` })]));
  }
  await h.feed(h.snapshot([original]));
  assert.equal(h.events().length, 256, "256 个时仍保留旧 key");
  const last = h.app({ key: "257:1" });
  await h.feed(h.snapshot([last]));
  await h.feed(h.snapshot([last]));
  assert.equal(h.events().length, 257, "当前 key 不会在收缩时丢失");
  await h.feed(h.snapshot([original]));
  assert.equal(h.events().length, 258, "被收缩掉的旧 key 可以重新观察");
});

test("C2.9：foreign/unknown 去重记录也随已见集合收缩", async () => {
  const h = harness();
  for (let index = 1; index <= 257; index += 1) {
    await h.feed(h.snapshot([h.app({ key: `${index}:1`, arguments: null })]));
  }
  await h.feed(h.snapshot([h.app({ key: "257:1", arguments: null })]));
  assert.equal(h.events().length, 257);
  await h.feed(h.snapshot([h.app({ key: "1:1", arguments: null })]));
  assert.equal(h.events().length, 258);
});
