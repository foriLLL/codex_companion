import assert from "node:assert/strict";
import test from "node:test";
import { inspectRunningCodex, findRunningCodex, DEFAULT_CODEX_EXECUTABLE, launchCodex, buildCodexLaunchEnvironment } from "../src/launcher.mjs";

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
    hasCdpFlag: true
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
  assert.deepEqual(captured.args, ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=53421"]);
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
