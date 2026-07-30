import assert from "node:assert/strict";
import test from "node:test";
import { inspectRunningCodex, findRunningCodex, DEFAULT_CODEX_EXECUTABLE } from "../src/launcher.mjs";

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
