import { posixOnlyTest as test } from "./helpers/platform.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { agentProgramArguments, AGENT_PATH, installAgent, uninstallAgent, restartCodex } from "../src/agent/launch-agent.mjs";
import { runCli, parseArgs } from "../src/cli.mjs";
import { defaultAgentLockPath } from "../src/agent/main.mjs";
import { app, clock, configStore, nativeBridge, ours, snapshot, stateStore, temporary } from "./helpers/agent.mjs";
import { assertMode } from "./helpers/permissions.mjs";

// 本文件测试 launchd 分支；Linux 的 systemd 分支见 agent-linux.test.mjs。
const installMac = options => installAgent({ hostPlatform: "darwin", ...options });
const uninstallMac = options => uninstallAgent({ hostPlatform: "darwin", ...options });
const validatePlist = promisify(execFile);
// LaunchAgent 只存在于 macOS；plist 校验依赖系统自带的 plutil。
const macOnly = { skip: process.platform !== "darwin" && "LaunchAgent 仅适用于 macOS" };

test("ProgramArguments 区分 Bun 编译产物、Node、Bun 解释器", () => {
  for (const execPath of ["/test/node", "/test/bun", "/test/nodejs"]) {
    assert.deepEqual(agentProgramArguments({ execPath, cliPath: "/repo/cli.mjs", isBun: true }), [execPath, "/repo/cli.mjs", "agent"]);
  }
  assert.deepEqual(agentProgramArguments({ execPath: "/test/companion", cliPath: "/repo/cli.mjs", isBun: true }), ["/test/companion", "agent"]);
  assert.deepEqual(agentProgramArguments({ execPath: "/test/node", cliPath: "/repo/cli.mjs", isBun: false }), ["/test/node", "/repo/cli.mjs", "agent"]);
});

test("install 在临时目录生成有效 plist，绝对助手路径/PATH，无代理变量；只调用假 launchctl", macOnly, async t => {
  const home = await temporary(t);
  const calls = [];
  const helper = join(home, "helper");
  await writeFile(helper, "fake native helper");
  const result = await installMac({ home, plistDir: join(home, "LaunchAgents & test"), uid: 501, label: "local.test.agent",
    execPath: "/fake/node", cliPath: "/repo/CLI & test.mjs", isBun: false, cwd: home,
    env: { CODEX_COMPANION_NATIVE_HELPER: "helper", CODEX_COMPANION_CODEX_APP: "/test/Dummy.app", HTTP_PROXY: "secret", ALL_PROXY: "secret" },
    configPath: join(home, "config.json"), execFileImpl: async (...args) => { calls.push(args); return { stdout: "" }; }
  });
  assertMode(await stat(result.plistPath), 0o600);
  const text = await readFile(result.plistPath, "utf8");
  assert.ok(text.includes("CLI &amp; test.mjs"));
  assert.ok(!text.includes("secret"));
  // plutil 只解析临时文件，系统调用 launchctl 全部由上面的假执行器拦截。
  const { stdout } = await validatePlist("/usr/bin/plutil", ["-convert", "json", "-o", "-", result.plistPath]);
  const plist = JSON.parse(stdout);
  assert.deepEqual(plist.ProgramArguments, ["/fake/node", "/repo/CLI & test.mjs", "agent"]);
  assert.equal(plist.Label, "local.test.agent");
  assert.equal(plist.RunAtLoad, true);
  assert.deepEqual(plist.KeepAlive, { SuccessfulExit: false });
  assert.equal(plist.ThrottleInterval, 10);
  assert.equal(plist.StandardOutPath, join(home, "Library/Logs/codex-companion/agent.out.log"));
  assert.equal(plist.StandardErrorPath, join(home, "Library/Logs/codex-companion/agent.err.log"));
  assert.deepEqual(plist.EnvironmentVariables, { PATH: AGENT_PATH, CODEX_COMPANION_NATIVE_HELPER: helper,
    CODEX_COMPANION_CODEX_APP: "/test/Dummy.app", CODEX_COMPANION_CONFIG_PATH: join(home, "config.json") });
  assert.deepEqual(calls, [["/bin/launchctl", ["bootout", "gui/501/local.test.agent"]],
    ["/bin/launchctl", ["bootstrap", "gui/501", result.plistPath]]]);
});

test("install Bun 编译产物不携带脚本路径，缺少助手也可安装", macOnly, async t => {
  const home = await temporary(t);
  const result = await installMac({ home, helperPath: null, env: {}, execPath: "/test/companion", isBun: true, uid: 505,
    execFileImpl: async () => ({ stdout: "" }) });
  const { stdout } = await validatePlist("/usr/bin/plutil", ["-convert", "json", "-o", "-", result.plistPath]);
  const plist = JSON.parse(stdout);
  assert.deepEqual(plist.ProgramArguments, ["/test/companion", "agent"]);
  assert.deepEqual(plist.EnvironmentVariables, { PATH: AGENT_PATH });
});

test("uninstall 先 bootout 再删除 plist，并验证同一实例端口后执行一次 unmount", async t => {
  const home = await temporary(t);
  const plistPath = join(home, "Library/LaunchAgents/local.test.agent.plist");
  await mkdir(dirname(plistPath), { recursive: true });
  await writeFile(plistPath, "test");
  const target = ours();
  const runtimeState = stateStore({ port: 51234, codexPid: target.pid, codexKey: target.key, agentPid: 700 });
  const calls = [];
  const result = await uninstallMac({ home, label: "local.test.agent", uid: 501, helperPath: null,
    runtimeState, nativeBridge: nativeBridge(snapshot([target])),
    execFileImpl: async (...args) => { await access(plistPath); calls.push(args); runtimeState.value = null; },
    injectorFactory: port => { assert.equal(port, 51234); return { injectOnce: async action => calls.push([action]), stop: () => calls.push(["stop"]) }; }
  });
  assert.equal(result.unmounted, true);
  await assert.rejects(access(plistPath), { code: "ENOENT" });
  assert.deepEqual(calls, [["/bin/launchctl", ["bootout", "gui/501/local.test.agent"]], ["unmount"], ["stop"]]);
});

test("uninstall 过期端口不连接；未注册可幂等删除，bootout 权限错误保留 plist", async t => {
  const home = await temporary(t);
  const plistPath = join(home, "Library/LaunchAgents/com.codexcompanion.agent.plist");
  await mkdir(dirname(plistPath), { recursive: true });
  await writeFile(plistPath, "test");
  const options = { home, helperPath: null, uid: 501, runtimeState: stateStore({ port: 51234, codexKey: "stale" }),
    nativeBridge: nativeBridge(snapshot([ours()])), injectorFactory: () => { throw new Error("must not connect"); } };
  await assert.rejects(uninstallMac({ ...options, execFileImpl: async () => { throw Object.assign(new Error("denied"), { code: 1 }); } }), /denied/);
  assert.equal(await readFile(plistPath, "utf8"), "test");
  const result = await uninstallMac({ ...options, execFileImpl: async () => { throw Object.assign(new Error("not loaded"), { code: 3 }); } });
  assert.equal(result.unmounted, false);
  await assert.rejects(access(plistPath), { code: "ENOENT" });
});

function restartOptions(bridge) {
  const timer = clock();
  return { helperPath: "/fake/native", nativeBridge: bridge, configStore: configStore(), runtimeState: stateStore(),
    reservePort: async () => 54321, now: timer.now, setTimeoutImpl: timer.setTimeoutImpl, clearTimeoutImpl: timer.clearTimeoutImpl,
    sleepImpl: async ms => timer.advance(ms) };
}

test("restart-codex 恰好一个实例时 quit(user) → 等待退出 → launch(hidden:false)", async () => {
  const bridge = nativeBridge(snapshot([app()]));
  bridge.quit = async options => { bridge.calls.push(["quit", options]); bridge.value = snapshot(); return { accepted: true }; };
  const result = await restartCodex(restartOptions(bridge));
  assert.equal(result.launched, true);
  assert.equal(result.stopped, true);
  assert.deepEqual(bridge.calls.map(call => call[0]), ["snapshot", "quit", "snapshot", "launch"]);
  assert.equal(bridge.calls[1][1].mode, "user");
  assert.equal(bridge.calls.at(-1)[1].hidden, false);
  assert.ok(bridge.calls.at(-1)[1].args.includes("--remote-debugging-port=54321"));
});

test("restart-codex 未运行直接启动，多实例/quit 拒绝/助手缺失不启动", async () => {
  const empty = nativeBridge(snapshot());
  assert.equal((await restartCodex(restartOptions(empty))).launched, true);
  assert.deepEqual(empty.calls.map(call => call[0]), ["snapshot", "launch"]);
  const multiple = nativeBridge(snapshot([app(), app(43)]));
  assert.equal((await restartCodex(restartOptions(multiple))).reason, "multiple-instances");
  assert.deepEqual(multiple.calls.map(call => call[0]), ["snapshot"]);
  const refused = nativeBridge(snapshot([app()]));
  assert.equal((await restartCodex(restartOptions(refused))).reason, "fake-refused");
  assert.deepEqual(refused.calls.map(call => call[0]), ["snapshot", "quit"]);
  assert.equal((await restartCodex({ helperPath: null, env: {} })).reason, "native-helper-missing");
});

test("restart-codex 等待退出不超过十秒，新实例出现即取消", async () => {
  for (const replacement of [false, true]) {
    const bridge = nativeBridge(snapshot([app()]));
    bridge.quit = async () => { if (replacement) bridge.value = snapshot([app(43)]); return { accepted: true }; };
    const options = restartOptions(bridge);
    const started = options.now();
    const result = await restartCodex({ ...options, quitTimeoutMs: 30_000 });
    assert.equal(result.reason, replacement ? "another-instance" : "quit-timeout");
    assert.ok(options.now() - started <= 10_000);
    assert.equal(bridge.calls.some(call => call[0] === "launch"), false);
  }
});

test("restart-codex 卡住的 snapshot 也受十秒超时约束", async () => {
  const bridge = nativeBridge(snapshot([app()]));
  const timer = clock();
  bridge.quit = async () => { bridge.snapshot = () => new Promise(() => {}); return { accepted: true }; };
  const operation = restartCodex({ ...restartOptions(bridge), now: timer.now, setTimeoutImpl: timer.setTimeoutImpl,
    clearTimeoutImpl: timer.clearTimeoutImpl, sleepImpl: async () => {} });
  await timer.advance(10_000);
  assert.equal((await operation).reason, "quit-timeout");
});

test("CLI agent 子命令解析，status/restart-codex 仅输出一行 JSON，可注入全部依赖", async t => {
  assert.equal(parseArgs(["agent"]).subcommand, null);
  assert.equal(parseArgs(["agent", "install", "--plist-dir", "/fake", "--label", "test.agent"]).plistDir, "/fake");
  assert.throws(() => parseArgs(["agent", "unknown"]), /子命令/);
  assert.throws(() => parseArgs(["agent", "--label", "bad"]), /只能用于/);
  const home = await temporary(t);
  const lockPath = defaultAgentLockPath(home);
  await mkdir(dirname(lockPath), { recursive: true });
  await writeFile(lockPath, JSON.stringify({ pid: 700, startedAt: 1 }));
  const output = [];
  await runCli(["agent", "status"], { ...restartOptions(nativeBridge(snapshot())), home,
    runtimeState: stateStore({ agentPid: 700, startedAt: 1 }), isAlive: () => true, output: value => output.push(value) });
  assert.equal(output.length, 1);
  assert.equal(output[0].includes("\n"), false);
  assert.equal(JSON.parse(output[0]).available, true);
  output.length = 0;
  await runCli(["agent", "restart-codex"], { ...restartOptions(nativeBridge(snapshot())), output: value => output.push(value) });
  assert.equal(output.length, 1);
  assert.equal(JSON.parse(output[0]).launched, true);
});

test("install 支持首次安装和重装：bootout 完成后才替换 plist，再 bootstrap", async t => {
  const home = await temporary(t);
  const plistPath = join(home, "Library/LaunchAgents/com.codexcompanion.agent.plist");
  const calls = [];
  let loaded = false;
  let previousPlist = null;
  let expectedExecutable = "/fake/companion-v1";
  const options = { home, helperPath: null, env: {}, isBun: true, uid: 501,
    execFileImpl: async (command, args) => {
      assert.equal(command, "/bin/launchctl");
      calls.push(args[0]);
      if (args[0] === "bootout") {
        assert.deepEqual(args, ["bootout", "gui/501/com.codexcompanion.agent"]);
        if (previousPlist === null) await assert.rejects(access(plistPath), { code: "ENOENT" });
        else assert.equal(await readFile(plistPath, "utf8"), previousPlist);
        if (!loaded) throw Object.assign(new Error("not loaded"), { code: "ESRCH" });
        loaded = false;
      } else {
        assert.equal(loaded, false, "重复安装必须先卸载 job");
        const contents = await readFile(plistPath, "utf8");
        assert.ok(contents.includes(`<string>${expectedExecutable}</string>`));
        previousPlist = contents;
        loaded = true;
      }
    }
  };
  assert.equal((await installMac({ ...options, execPath: expectedExecutable })).installed, true);
  expectedExecutable = "/fake/companion-v2";
  assert.equal((await installMac({ ...options, execPath: expectedExecutable })).installed, true);
  assert.deepEqual(calls, ["bootout", "bootstrap", "bootout", "bootstrap"]);
  assert.equal(loaded, true);
});

test("install 仅容忍未加载的 bootout 错误，其他错误不覆盖旧 plist 或尝试 bootstrap", async t => {
  const home = await temporary(t);
  const plistPath = join(home, "Library/LaunchAgents/com.codexcompanion.agent.plist");
  await mkdir(dirname(plistPath), { recursive: true });
  const options = { home, helperPath: null, env: {}, isBun: true, execPath: "/fake/companion", uid: 501 };
  for (const code of [1, 5, 37, "EACCES"]) {
    await writeFile(plistPath, "previous plist");
    const error = Object.assign(new Error("bootout failed"), { code });
    const calls = [];
    await assert.rejects(installMac({ ...options, execFileImpl: async (_command, args) => { calls.push(args[0]); throw error; } }), caught => caught === error);
    assert.deepEqual(calls, ["bootout"]);
    assert.equal(await readFile(plistPath, "utf8"), "previous plist");
  }
  for (const code of [3, "3", "ESRCH"]) {
    const calls = [];
    assert.equal((await installMac({ ...options, execFileImpl: async (_command, args) => {
      calls.push(args[0]);
      if (args[0] === "bootout") throw Object.assign(new Error("not loaded"), { code });
    } })).installed, true);
    assert.deepEqual(calls, ["bootout", "bootstrap"]);
  }
});

test("install 不吞掉 bootstrap 错误，也不按错误码把失败当成已安装", async t => {
  const home = await temporary(t);
  const error = Object.assign(new Error("bootstrap failed"), { code: 37 });
  const calls = [];
  await assert.rejects(installMac({ home, helperPath: null, env: {}, isBun: true, execPath: "/fake/companion", uid: 501,
    execFileImpl: async (_command, args) => {
      calls.push(args[0]);
      if (args[0] === "bootstrap") { await access(args[2]); throw error; }
    }
  }), caught => caught === error);
  assert.deepEqual(calls, ["bootout", "bootstrap"]);
});
