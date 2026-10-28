import assert from "node:assert/strict";
import test from "node:test";
import {
  inspectRunningCodex, findRunningCodex, DEFAULT_CODEX_EXECUTABLE, launchCodex, buildCodexLaunchEnvironment,
  buildCodexLaunchArgs, parseCodexProxyPort, detectCodexProxy
} from "../src/launcher.mjs";

function fakePs(lines) {
  return async () => ({ stdout: lines.join("\n") });
}

test("inspectRunningCodex 识别带 CDP flag 的进程", async () => {
  const exe = DEFAULT_CODEX_EXECUTABLE;
  const processes = await inspectRunningCodex(exe, {
    execFileImpl: fakePs([
      `  100 ${exe} --remote-debugging-address=127.0.0.1 --remote-debugging-port=51234`,
      `  200 ${exe}`,
      "  300 /usr/bin/other"
    ])
  });
  assert.equal(processes.length, 2);
  assert.deepEqual(processes[0], {
    pid: 100,
    command: `${exe} --remote-debugging-address=127.0.0.1 --remote-debugging-port=51234`,
    hasCdpFlag: true,
    cdpPort: 51234,
    proxyPort: null
  });
  assert.equal(processes[1].pid, 200);
  assert.equal(processes[1].hasCdpFlag, false);
});

test("findRunningCodex 保持只返回 pid 数组的旧行为", async () => {
  const exe = DEFAULT_CODEX_EXECUTABLE;
  const pids = await findRunningCodex(exe, {
    execFileImpl: fakePs([`  100 ${exe}`, `  200 ${exe} --remote-debugging-port=6000`])
  });
  assert.deepEqual(pids, [100, 200]);
});

test("无匹配进程返回空", async () => {
  const processes = await inspectRunningCodex(DEFAULT_CODEX_EXECUTABLE, {
    execFileImpl: fakePs(["  300 /usr/bin/other", ""])
  });
  assert.deepEqual(processes, []);
});

test("Codex 启动仅给子进程设置勾选的本机代理并保留 CDP loopback", () => {
  let captured;
  let unrefCount = 0;
  const spawnImpl = (executable, args, options) => {
    captured = { executable, args, options };
    return { pid: 42, unref() { unrefCount += 1; } };
  };
  const before = [process.env.HTTP_PROXY, process.env.HTTPS_PROXY, process.env.ALL_PROXY];
  const pid = launchCodex({ executable: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT", port: 53421,
    proxyPort: 7890, spawnImpl });
  assert.equal(pid, 42);
  assert.equal(unrefCount, 1);
  assert.deepEqual(captured.args, [
    "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=53421",
    "--proxy-server=http://127.0.0.1:7890", "--proxy-bypass-list=<local>;10.0.0.0/8;172.16.0.0/12;192.168.0.0/16"
  ]);
  assert.equal(captured.options.env.HTTP_PROXY, "http://127.0.0.1:7890");
  assert.equal(captured.options.env.HTTPS_PROXY, "http://127.0.0.1:7890");
  assert.deepEqual([process.env.HTTP_PROXY, process.env.HTTPS_PROXY, process.env.ALL_PROXY], before,
    "Companion 本身的代理环境不得被修改");
});

test("未勾选代理时清理从父进程继承的代理值", () => {
  const environment = buildCodexLaunchEnvironment(null, {
    HTTP_PROXY: "http://old:1", https_proxy: "http://old:2", ALL_PROXY: "socks5://old:3", OTHER: "keep"
  });
  assert.deepEqual(environment, { OTHER: "keep" });
  assert.throws(() => buildCodexLaunchEnvironment(0), RangeError);
  assert.throws(() => buildCodexLaunchEnvironment(65536), RangeError);
});

test("未勾选代理时启动参数只含 loopback CDP，不带 Chromium 代理", () => {
  assert.deepEqual(buildCodexLaunchArgs(6000), ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=6000"]);
  assert.throws(() => buildCodexLaunchArgs(6000, 70000), RangeError);
});

test("只从 Companion 写入的 loopback --proxy-server 读出代理端口", () => {
  const exe = DEFAULT_CODEX_EXECUTABLE;
  assert.equal(parseCodexProxyPort(`${exe} --remote-debugging-port=1 --proxy-server=http://127.0.0.1:7890 --proxy-bypass-list=<local>`), 7890);
  assert.equal(parseCodexProxyPort(`${exe} --proxy-server=127.0.0.1:1080`), 1080);
  assert.equal(parseCodexProxyPort(`${exe} --remote-debugging-port=1`), null);
  assert.equal(parseCodexProxyPort(`${exe} --proxy-server=http://10.0.0.2:7890`), null);
  assert.equal(parseCodexProxyPort(`${exe} --proxy-server=http://127.0.0.1:99999`), null);
});

test("detectCodexProxy 优先选择本 Companion CDP 端口对应的 Codex", async () => {
  const exe = DEFAULT_CODEX_EXECUTABLE;
  const inspectImpl = (executable) => inspectRunningCodex(executable, {
    execFileImpl: fakePs([
      `  100 ${exe} --remote-debugging-port=5000`,
      `  200 ${exe} --remote-debugging-port=6000 --proxy-server=http://127.0.0.1:7890`
    ])
  });
  assert.deepEqual(await detectCodexProxy({ executable: exe, cdpPort: 6000, inspectImpl, platform: "darwin" }), { running: true, proxyPort: 7890 });
  assert.deepEqual(await detectCodexProxy({ executable: exe, cdpPort: 5000, inspectImpl, platform: "darwin" }), { running: true, proxyPort: null });
  assert.deepEqual(await detectCodexProxy({ executable: exe, inspectImpl: async () => [], platform: "darwin" }), { running: false, proxyPort: null });
  for (const platform of ["linux", "win32"]) {
    assert.deepEqual(await detectCodexProxy({ executable: exe, platform, inspectImpl: async () => { throw new Error("不应检查进程"); } }),
      { supported: false, running: null, proxyPort: null });
  }
});
