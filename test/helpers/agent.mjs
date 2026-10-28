import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeCompanionConfigV2 } from "../../src/companion-config.mjs";

export const logger = { info() {}, warn() {}, error() {}, debug() {} };
export const flush = () => new Promise(resolve => setImmediate(resolve));
export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export async function temporary(t) {
  const home = await mkdtemp(join(tmpdir(), "companion-agent-test-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}
export function clock(start = 1_000_000) {
  let time = start;
  let id = 0;
  const timers = new Map();
  const setTimeoutImpl = (fn, ms) => { const key = ++id; timers.set(key, { fn, at: time + ms, ms }); return key; };
  const clearTimeoutImpl = key => timers.delete(key);
  return {
    now: () => time, setTimeoutImpl, clearTimeoutImpl,
    sleepImpl: ms => new Promise(resolve => setTimeoutImpl(resolve, ms)),
    delays: () => [...timers.values()].map(timer => timer.at - time),
    async advance(ms) {
      const deadline = time + ms;
      for (let count = 0; count < 200; count += 1) {
        await flush();
        const next = [...timers.entries()].filter(([, value]) => value.at <= deadline).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) { time = deadline; await flush(); return; }
        const [key, timer] = next;
        time = timer.at;
        timers.delete(key);
        void timer.fn();
      }
      throw new Error("假时钟疑似无限循环");
    }
  };
}
export function fakeLockSpawn(calls = [], code = 0) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("close", code));
    return child;
  };
}
export function configStore(value = normalizeCompanionConfigV2({})) {
  return { value, async loadV2() { return this.value; } };
}
export function stateStore(value = null) {
  return { value, saves: [], async load() { return this.value; }, async save(next) {
    this.value = structuredClone(next); this.saves.push(this.value); return this.value;
  } };
}
export function app(pid = 42, launchedAt = 999_000, args = []) {
  return { pid, key: `${pid}:${launchedAt}`, launchedAt, finishedLaunching: true, arguments: args };
}
export function ours(pid = 42, port = 51234, launchedAt = 999_000) {
  return app(pid, launchedAt, ["--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${port}`, "--proxy-server=http://127.0.0.1:7890"]);
}
export function snapshot(apps = [], now = 1_000_000) {
  return { apps, now, frontmostPid: apps[0]?.pid ?? 0, inputStamp: "0:0:0:0:0", inputIdleMs: 100_000 };
}
export function nativeBridge(value = snapshot()) {
  const calls = [];
  const watches = [];
  return {
    value, calls, watches,
    async snapshot() { calls.push(["snapshot"]); return this.value; },
    async quit(options) { calls.push(["quit", options]); return { accepted: false, reason: "fake-refused" }; },
    async launch(options) { calls.push(["launch", options]); return { launched: true, pid: 43, key: "43:1000000", finishedLaunching: false, hidden: false }; },
    async show(options) { calls.push(["show", options]); return { shown: true }; },
    watch(options) { const handle = { ...options, closed: false, close() { this.closed = true; } }; watches.push(handle); return handle; }
  };
}
