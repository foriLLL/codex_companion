import assert from "node:assert/strict";
import test from "node:test";
import { classifyCodexState, startCodexWatchdog, notifyMacos } from "../src/daemon.mjs";

test("classifyCodexState 覆盖三种状态", () => {
  assert.equal(classifyCodexState([]), "gone");
  assert.equal(classifyCodexState(null), "gone");
  assert.equal(classifyCodexState([{ pid: 1, hasCdpFlag: false }]), "needs-restart");
  assert.equal(classifyCodexState([{ pid: 1, hasCdpFlag: false }, { pid: 2, hasCdpFlag: true }]), "healthy");
});

function manualScheduler() {
  let fn = null;
  return {
    setIntervalImpl: (callback) => { fn = callback; return 1; },
    clearIntervalImpl: () => { fn = null; },
    run: () => fn?.()
  };
}

test("Codex 消失时触发 onGone 并停止", async () => {
  const scheduler = manualScheduler();
  let goneCalls = 0;
  startCodexWatchdog({
    inspectImpl: async () => [],
    notifyImpl: async () => true,
    onGone: async () => { goneCalls += 1; },
    setIntervalImpl: scheduler.setIntervalImpl,
    clearIntervalImpl: scheduler.clearIntervalImpl,
    logger: { error() {} }
  });
  await scheduler.run();
  assert.equal(goneCalls, 1);
});

test("无 flag 时只发一次通知（去抖），恢复后可再次通知", async () => {
  const scheduler = manualScheduler();
  const notes = [];
  let processes = [{ pid: 1, hasCdpFlag: false }];
  startCodexWatchdog({
    inspectImpl: async () => processes,
    notifyImpl: async (title, message) => { notes.push(message); return true; },
    onGone: async () => {},
    setIntervalImpl: scheduler.setIntervalImpl,
    clearIntervalImpl: scheduler.clearIntervalImpl,
    logger: { error() {} }
  });

  await scheduler.run();
  await scheduler.run();
  assert.equal(notes.length, 1, "重复的 needs-restart 不应重复通知");

  processes = [{ pid: 1, hasCdpFlag: true }];
  await scheduler.run(); // healthy → 重置去抖

  processes = [{ pid: 2, hasCdpFlag: false }];
  await scheduler.run();
  assert.equal(notes.length, 2, "恢复健康后再次退化应重新通知");
});

test("healthy 时不通知、不 onGone", async () => {
  const scheduler = manualScheduler();
  let notified = false;
  let gone = false;
  startCodexWatchdog({
    inspectImpl: async () => [{ pid: 1, hasCdpFlag: true }],
    notifyImpl: async () => { notified = true; return true; },
    onGone: async () => { gone = true; },
    setIntervalImpl: scheduler.setIntervalImpl,
    clearIntervalImpl: scheduler.clearIntervalImpl,
    logger: { error() {} }
  });
  await scheduler.run();
  assert.equal(notified, false);
  assert.equal(gone, false);
});

test("notifyMacos 用 argv 传参调用 osascript，失败返回 false", async () => {
  const calls = [];
  const ok = await notifyMacos("标题", 'a"b\\c\n换行', {
    execFileImpl: async (bin, args) => { calls.push({ bin, args }); }
  });
  assert.equal(ok, true);
  assert.equal(calls[0].bin, "/usr/bin/osascript");
  assert.equal(calls[0].args[0], "-e");
  assert.match(calls[0].args[1], /on run argv/);
  assert.match(calls[0].args[1], /display notification/);
  // message/title 作为独立 argv 传入，不做字符串转义拼接，特殊字符原样保留
  assert.equal(calls[0].args[2], 'a"b\\c\n换行');
  assert.equal(calls[0].args[3], "标题");

  const failed = await notifyMacos("t", "m", {
    execFileImpl: async () => { throw new Error("boom"); }
  });
  assert.equal(failed, false);
});
