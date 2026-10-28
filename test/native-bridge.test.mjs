import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { posixOnlyTest as test } from "./helpers/platform.mjs";
import { createNativeBridge, resolveNativeHelperPath } from "../src/agent/native-bridge.mjs";
import { buildNative } from "../scripts/build-native.mjs";
import { assertSafeSmokeApp } from "../scripts/smoke-native.mjs";

const app = { pid: 42, key: "42:1000", launchedAt: 1000, finishedLaunching: true, arguments: ["two words", "中文"] };
const snapshot = { apps: [app], frontmostPid: 42, inputStamp: "1:2:3:4:5", inputIdleMs: 2000, now: 2000 };
const paths = { helperPath: "/test/companion-native", appPath: "/test/Dummy app.app" };

async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), "native-bridge-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function file(path) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "fixture");
  return path;
}

function fakeExec(response, calls = []) {
  return async (command, args, options) => {
    calls.push({ command, args, options });
    if (response instanceof Error) throw response;
    return { stdout: typeof response === "string" ? response : `${JSON.stringify(response)}\n`, stderr: "" };
  };
}

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  signals = [];
  kill(signal) { this.signals.push(signal); return true; }
  line(value) { this.stdout.write(`${JSON.stringify(value)}\n`); }
}

function watchFixture(t, options = {}) {
  const child = new FakeChild();
  const calls = [];
  const snapshots = [];
  const exits = [];
  const bridge = createNativeBridge({ ...paths, ...options, spawnImpl: (...args) => { calls.push(args); return child; } });
  const watcher = bridge.watch({ onSnapshot: (value) => snapshots.push(value), onExit: (error) => exits.push(error) });
  t.after(() => watcher.close());
  return { child, calls, snapshots, exits, watcher };
}

test("native helper 解析顺序：环境覆盖 → app Helpers → 当前仓库架构产物", async (t) => {
  const root = await temporary(t);
  const override = await file(join(root, "override"));
  const packaged = await file(join(root, "Companion.app/Contents/Helpers/companion-native"));
  const built = await file(join(root, "dist/native/darwin-arm64/companion-native"));
  const options = { env: { CODEX_COMPANION_NATIVE_HELPER: "override" }, cwd: root,
    execPath: join(root, "Companion.app/Contents/Resources/companion"), arch: "arm64" };
  assert.equal(resolveNativeHelperPath(options), override);
  await rm(override);
  assert.equal(resolveNativeHelperPath(options), packaged);
  await rm(packaged);
  assert.equal(resolveNativeHelperPath(options), built);
  await rm(built);
  assert.equal(resolveNativeHelperPath(options), null);
});

test("helper 路径跳过目录、未知架构，并支持 x64", async (t) => {
  const root = await temporary(t);
  const built = await file(join(root, "dist/native/darwin-x64/companion-native"));
  const options = { env: { CODEX_COMPANION_NATIVE_HELPER: root }, cwd: root, execPath: join(root, "bin/node"), arch: "x64" };
  assert.equal(resolveNativeHelperPath(options), built);
  assert.equal(resolveNativeHelperPath({ ...options, arch: "other" }), null);
});

test("snapshot 成功与未知 argv 都按契约返回", async () => {
  const calls = [];
  const bridge = createNativeBridge({ ...paths, execFileImpl: fakeExec(snapshot, calls) });
  assert.deepEqual(await bridge.snapshot(), snapshot);
  assert.deepEqual(calls[0], { command: paths.helperPath, args: ["snapshot", "--app", paths.appPath],
    options: { encoding: "utf8", timeout: 35_000, killSignal: "SIGTERM", maxBuffer: 1024 * 1024 } });
  const unknown = { ...snapshot, apps: [{ ...app, arguments: null }] };
  assert.deepEqual(await createNativeBridge({ ...paths, execFileImpl: fakeExec(unknown) }).snapshot(), unknown);
});

test("quit fresh/user 成功或拒绝都 resolve，保持原生理由", async () => {
  const calls = [];
  const bridge = createNativeBridge({ ...paths, execFileImpl: fakeExec({ accepted: true }, calls) });
  assert.deepEqual(await bridge.quit({ pid: 42, key: app.key, mode: "fresh", inputStamp: snapshot.inputStamp, maxAgeMs: 0 }), { accepted: true });
  assert.deepEqual(calls[0].args, ["quit", "--app", paths.appPath, "--pid", "42", "--key", app.key,
    "--mode", "fresh", "--input-stamp", snapshot.inputStamp, "--max-age-ms", "0"]);
  const refusal = { accepted: false, reason: "key-mismatch" };
  assert.deepEqual(await createNativeBridge({ ...paths, execFileImpl: fakeExec(refusal, calls) })
    .quit({ pid: 42, key: app.key, mode: "user" }), refusal);
  assert.deepEqual(calls[1].args.slice(3), ["--pid", "42", "--key", app.key, "--mode", "user"]);
});

test("launch 用独立 argv 传 JSON 和可选守卫，不经过 shell", async () => {
  const calls = [];
  const response = { launched: true, pid: app.pid, key: app.key };
  const bridge = createNativeBridge({ ...paths, execFileImpl: fakeExec(response, calls) });
  const args = ["two words", "$(echo never)", "\"quoted\"", ""];
  const env = { DUMMY: "中文\n = value" };
  assert.deepEqual(await bridge.launch({ args, env, hidden: true, inputStamp: snapshot.inputStamp, frontmostPid: 0 }), response);
  assert.deepEqual(calls[0].args, ["launch", "--app", paths.appPath, "--args-json", JSON.stringify(args), "--hidden",
    "--env-json", JSON.stringify(env), "--input-stamp", snapshot.inputStamp, "--frontmost-pid", "0"]);
  assert.equal(calls[0].options.shell, undefined);
  await bridge.launch({ args: [] });
  assert.deepEqual(calls[1].args, ["launch", "--app", paths.appPath, "--args-json", "[]"]);
});

test("launch 拒绝及 errorCode 原样返回", async () => {
  const refusal = { launched: false, reason: "open-failed", errorCode: -10810 };
  assert.deepEqual(await createNativeBridge({ ...paths, execFileImpl: fakeExec(refusal) }).launch({ args: [] }), refusal);
});

test("launch 编码 unsetEnv，区分省略和空数组且不修改调用方参数", async () => {
  const calls = [];
  const bridge = createNativeBridge({ ...paths, execFileImpl: fakeExec({ launched: true, pid: app.pid, key: app.key }, calls) });
  const unsetEnv = ["HTTP_PROXY", "https_proxy"];
  const env = { KEEP: "value" };
  await bridge.launch({ args: [], env, unsetEnv, hidden: true });
  assert.deepEqual(calls[0].args, ["launch", "--app", paths.appPath, "--args-json", "[]", "--hidden",
    "--env-json", JSON.stringify(env), "--unset-env-json", JSON.stringify(unsetEnv)]);
  assert.deepEqual(unsetEnv, ["HTTP_PROXY", "https_proxy"]);
  assert.deepEqual(env, { KEEP: "value" });
  await bridge.launch({ unsetEnv: [] });
  assert.deepEqual(calls[1].args, ["launch", "--app", paths.appPath, "--args-json", "[]", "--unset-env-json", "[]"]);
  await bridge.launch();
  assert.equal(calls[2].args.includes("--unset-env-json"), false);
});

test("launch 透传可选状态，未完成启动或未隐藏也可成功", async () => {
  for (const status of [{}, { finishedLaunching: false }, { hidden: false },
    { finishedLaunching: false, hidden: false }, { finishedLaunching: false, hidden: true },
    { finishedLaunching: true, hidden: false }, { finishedLaunching: true, hidden: true }]) {
    const response = { launched: true, pid: app.pid, key: app.key, ...status };
    const bridge = createNativeBridge({ ...paths, execFileImpl: fakeExec(response) });
    assert.deepEqual(await bridge.launch({ hidden: true }), response);
  }
});

test("launch 拒绝非布尔类型的可选状态字段", async () => {
  for (const key of ["finishedLaunching", "hidden"]) {
    for (const value of [null, 0, 1, "false", {}, []]) {
      const response = { launched: true, pid: app.pid, key: app.key, [key]: value };
      await assert.rejects(createNativeBridge({ ...paths, execFileImpl: fakeExec(response) }).launch(), { code: "NATIVE_PROTOCOL" });
    }
  }
});

test("show 成功/拒绝与可选守卫编码", async () => {
  for (const shown of [true, false]) {
    const calls = [];
    const bridge = createNativeBridge({ ...paths, execFileImpl: fakeExec({ shown }, calls) });
    assert.deepEqual(await bridge.show({ ...app, inputStamp: snapshot.inputStamp, frontmostPid: 42 }), { shown });
    assert.deepEqual(calls[0].args, ["show", "--app", paths.appPath, "--pid", "42", "--key", app.key,
      "--input-stamp", snapshot.inputStamp, "--frontmost-pid", "42"]);
  }
});

for (const output of ["not-json", "", "null", "[]", "{}", `${JSON.stringify(snapshot)}\n${JSON.stringify(snapshot)}\n`,
  JSON.stringify({ ...snapshot, apps: [{ ...app, key: "wrong" }] }),
  JSON.stringify({ ...snapshot, inputStamp: "invalid" }), JSON.stringify({ ...snapshot, inputIdleMs: -1 })]) {
  test(`snapshot 拒绝坏 JSON/协议：${output.slice(0, 48) || "empty"}`, async () => {
    await assert.rejects(createNativeBridge({ ...paths, execFileImpl: fakeExec(output) }).snapshot(), { code: "NATIVE_PROTOCOL" });
  });
}

test("动作输出必须包含正确布尔状态和实例信息", async () => {
  for (const [action, response] of [["quit", { accepted: "false" }], ["quit", { accepted: false }],
    ["launch", { launched: true }], ["launch", { launched: true, pid: 42, key: "43:1" }], ["show", { shown: 0 }]]) {
    const bridge = createNativeBridge({ ...paths, execFileImpl: fakeExec(response) });
    await assert.rejects(bridge[action]({ args: [], pid: 42, key: app.key, mode: "user" }), { code: "NATIVE_PROTOCOL" });
  }
});

for (const properties of [{ code: 2 }, { code: "ENOENT" }, { signal: "SIGABRT", killed: false }]) {
  test(`非零退出或执行失败：${JSON.stringify(properties)}`, async () => {
    const cause = Object.assign(new Error("failed"), properties, { stdout: JSON.stringify(snapshot) });
    await assert.rejects(createNativeBridge({ ...paths, execFileImpl: fakeExec(cause) }).snapshot(), (error) => {
      assert.equal(error.code, "NATIVE_FAILED");
      assert.equal(error.cause, cause);
      return true;
    });
  });
}

test("execFile 的超时错误归一化为 NATIVE_TIMEOUT", async () => {
  for (const properties of [{ code: "ETIMEDOUT" }, { killed: true, signal: "SIGTERM" }]) {
    await assert.rejects(createNativeBridge({ ...paths, execFileImpl: fakeExec(Object.assign(new Error("timeout"), properties)) }).snapshot(),
      { code: "NATIVE_TIMEOUT" });
  }
});

test("永不完成的 execFile 仍按期限 reject，并只终止助手子进程", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const child = new FakeChild();
  const bridge = createNativeBridge({ ...paths, timeoutMs: 20,
    execFileImpl: () => Object.assign(new Promise(() => {}), { child }) });
  const pending = assert.rejects(bridge.snapshot(), { code: "NATIVE_TIMEOUT" });
  t.mock.timers.tick(20);
  await pending;
  assert.deepEqual(child.signals, ["SIGTERM"]);
});

test("同步 execFile 异常、缺少路径与非法超时", async () => {
  await assert.rejects(createNativeBridge({ ...paths, execFileImpl() { throw new Error("sync"); } }).snapshot(), { code: "NATIVE_FAILED" });
  await assert.rejects(createNativeBridge({ appPath: paths.appPath }).snapshot(), { code: "NATIVE_FAILED" });
  assert.throws(() => createNativeBridge({ ...paths, timeoutMs: 0 }), TypeError);
});

test("watch 解析同一 chunk 多行、CRLF、跨 chunk 与拆开的 UTF-8", (t) => {
  const { child, calls, snapshots, exits } = watchFixture(t);
  const line = Buffer.from(`${JSON.stringify(snapshot)}\r\n`);
  const split = line.indexOf(Buffer.from("中")) + 1;
  child.stdout.write(line.subarray(0, split));
  assert.equal(snapshots.length, 0);
  child.stdout.write(Buffer.concat([line.subarray(split), line, line.subarray(0, 10)]));
  assert.deepEqual(snapshots, [snapshot, snapshot]);
  child.stdout.write(line.subarray(10));
  assert.deepEqual(snapshots, [snapshot, snapshot, snapshot]);
  assert.deepEqual(exits, []);
  assert.deepEqual(calls, [[paths.helperPath, ["watch", "--app", paths.appPath], { stdio: ["pipe", "pipe", "pipe"] }]]);
  assert.equal(child.stdin.writableEnded, false, "保持 stdin 打开以免原生 watch 收到 EOF");
});

for (const line of ["broken", "", "null", "{}", JSON.stringify({ ...snapshot, apps: "wrong" })]) {
  test(`watch 坏行触发一次 onExit 并关闭：${line || "empty"}`, (t) => {
    const { child, snapshots, exits } = watchFixture(t);
    child.line(snapshot);
    child.stdout.write(`${line}\n${JSON.stringify(snapshot)}\n`);
    child.emit("close", 1, null);
    child.emit("error", new Error("late"));
    assert.deepEqual(snapshots, [snapshot]);
    assert.equal(exits.length, 1);
    assert.equal(exits[0].code, "NATIVE_PROTOCOL");
    assert.equal(child.stdin.writableEnded, true);
    assert.deepEqual(child.signals, ["SIGTERM"]);
  });
}

test("watch 限制未结束行的内存", (t) => {
  const { child, exits } = watchFixture(t);
  child.stdout.write("x".repeat(1024 * 1024 + 1));
  assert.equal(exits[0].code, "NATIVE_PROTOCOL");
  assert.deepEqual(child.signals, ["SIGTERM"]);
});

test("watch 正常退出、非零退出、信号退出、尾部残行", (t) => {
  for (const [code, signal, suffix, expected] of [[0, null, "", null], [2, null, "", "NATIVE_FAILED"],
    [null, "SIGABRT", "", "NATIVE_FAILED"], [0, null, "{\"apps\":", "NATIVE_PROTOCOL"]]) {
    const { child, exits } = watchFixture(t);
    child.line(snapshot);
    child.stdout.write(suffix);
    child.emit("close", code, signal);
    assert.equal(exits.length, 1);
    assert.equal(exits[0]?.code ?? null, expected);
  }
});

test("watch error 事件与同步 spawn 失败", async (t) => {
  const { child, exits } = watchFixture(t);
  child.emit("error", new Error("ENOENT"));
  child.emit("close", -2, null);
  assert.equal(exits.length, 1);
  assert.equal(exits[0].code, "NATIVE_FAILED");
  const failed = [];
  const watcher = createNativeBridge({ ...paths, spawnImpl() { throw new Error("spawn failed"); } })
    .watch({ onExit: (error) => failed.push(error) });
  await Promise.resolve();
  assert.equal(failed[0].code, "NATIVE_FAILED");
  watcher.close();
});

test("watch 管道错误关闭助手，后续进程退出不重复通知", (t) => {
  for (const stream of ["stdin", "stdout", "stderr"]) {
    const { child, exits } = watchFixture(t);
    child[stream].emit("error", new Error("pipe failed"));
    child.emit("close", 1, null);
    assert.equal(exits.length, 1);
    assert.equal(exits[0].code, "NATIVE_FAILED");
    assert.deepEqual(child.signals, ["SIGTERM"]);
  }
});

test("watch 心跳续期，启动/心跳超时均关闭", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { child, exits } = watchFixture(t, { timeoutMs: 35_000 });
  t.mock.timers.tick(30_000);
  child.line(snapshot);
  t.mock.timers.tick(34_999);
  assert.equal(exits.length, 0);
  t.mock.timers.tick(1);
  assert.equal(exits[0].code, "NATIVE_TIMEOUT");
  assert.deepEqual(child.signals, ["SIGTERM"]);
  const initial = watchFixture(t, { timeoutMs: 100 });
  t.mock.timers.tick(100);
  assert.equal(initial.exits[0].code, "NATIVE_TIMEOUT");
});

test("watch close 幂等且不触发调用方的异常退出回调", (t) => {
  const { child, watcher, snapshots, exits } = watchFixture(t);
  watcher.close();
  watcher.close();
  child.line(snapshot);
  child.emit("close", 0, null);
  assert.deepEqual(exits, []);
  assert.deepEqual(snapshots, []);
  assert.deepEqual(child.signals, ["SIGTERM"]);
  assert.equal(child.stdin.writableEnded, true);
});

test("buildNative 为两个 target 传正确 swiftc 参数，可注入执行器和输出路径", async (t) => {
  const root = await temporary(t);
  for (const [target, triple] of [["darwin-arm64", "arm64-apple-macos13"], ["darwin-x64", "x86_64-apple-macos13"]]) {
    const calls = [];
    const outputPath = join(root, target, "companion-native");
    assert.equal(await buildNative({ target, outputPath, execFileImpl(command, args, options, callback) {
      calls.push({ command, args, options });
      callback(null, "", "");
    } }), outputPath);
    assert.equal(calls[0].command, "swiftc");
    assert.deepEqual(calls[0].args.slice(0, 7), ["-O", "-target", triple, "-framework", "AppKit", "-framework", "ApplicationServices"]);
    assert.deepEqual(calls[0].args.slice(-2), ["-o", outputPath]);
  }
  await assert.rejects(buildNative({ target: "linux-x64" }), /不支持/);
});

test("冒烟禁止真实 Codex 路径，拒绝发生在读取 bundle 前", async () => {
  let reads = 0;
  for (const path of ["/Applications/ChatGPT.app", "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT"]) {
    await assert.rejects(assertSafeSmokeApp(path, { readBundleId: async () => { reads += 1; } }), /禁止/);
  }
  assert.equal(reads, 0);
});

test("冒烟解析规范化路径，只接受 dummy bundle id", async (t) => {
  const root = await temporary(t);
  const appPath = join(root, "dummy.app");
  await mkdir(appPath);
  const alias = join(root, "alias.app");
  await symlink(appPath, alias);
  const result = await assertSafeSmokeApp(alias, { readBundleId: async () => "local.codexcompanion.dummy" });
  assert.ok(result.endsWith("/dummy.app"));
  for (const bundleId of ["com.openai.codex", "com.other.app"]) {
    await assert.rejects(assertSafeSmokeApp(alias, { readBundleId: async () => bundleId }), /禁止|仅允许/);
  }
});
