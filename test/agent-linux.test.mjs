import { posixOnlyTest as test } from "./helpers/platform.mjs";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { findLinuxCodexProcesses, parseLinuxStartTicks } from "../src/platform/processes.mjs";
import { buildDesktopOverride, buildSystemdUnit, DESKTOP_MARKER, linuxLocations, SYSTEMD_UNIT } from "../src/agent/linux-service.mjs";
import { installAgent, launcherProgramArguments, uninstallAgent } from "../src/agent/launch-agent.mjs";
import { createPollingSnapshot, getAgentStatus } from "../src/agent/main.mjs";
import { openCodex } from "../src/agent/open-codex.mjs";
import { parseArgs } from "../src/cli.mjs";
import { notifyDesktop } from "../src/daemon.mjs";
import { normalizeCompanionConfigV2 } from "../src/companion-config.mjs";
import { configStore, stateStore, temporary } from "./helpers/agent.mjs";
import { assertMode } from "./helpers/permissions.mjs";

const EXE = "/usr/lib/chatgpt/ChatGPT";
const SYSTEM_DESKTOP = `[Desktop Entry]
Name=ChatGPT
Exec=chatgpt %U
Icon=chatgpt
Type=Application
DBusActivatable=true
MimeType=x-scheme-handler/codex;x-scheme-handler/https;

[Desktop Action new-window]
Name=New Window
Exec="/usr/bin/chatgpt" --new-window
`;

function fakeProc(processes, btime = 1_700_000_000) {
  const files = new Map([["/proc/stat", `cpu  1 2 3\nbtime ${btime}\nprocesses 9\n`]]);
  for (const { pid, argv, title, ticks, comm = "ChatGPT" } of processes) {
    // title 模拟 Chromium setproctitle 改写后的 cmdline：参数以空格拼成一个字符串。
    files.set(`/proc/${pid}/cmdline`, title === undefined ? `${argv.join("\0")}\0` : `${title}\0`);
    files.set(`/proc/${pid}/stat`, `${pid} (${comm}) S 1 ${pid} ${pid} 0 -1 4194560 1 0 0 0 0 0 0 0 20 0 30 0 ${ticks} 123 456`);
  }
  return {
    readdirImpl: async () => ["self", "stat", ...processes.map(({ pid }) => String(pid)), "999"],
    readFileImpl: async (path) => {
      if (!files.has(path)) throw Object.assign(new Error("gone"), { code: "ENOENT" });
      return files.get(path);
    }
  };
}

test("/proc：只认主进程，argv 原样保留，启动时间来自 btime + starttime", async () => {
  const fs = fakeProc([
    { pid: 20, argv: [EXE, "--type=zygote", "--no-zygote-sandbox"], ticks: 600 },
    { pid: 10, argv: [EXE, "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=4321", "codex://a b"], ticks: 500, comm: "Chat GPT) x" },
    { pid: 30, argv: [`${EXE}-helper`], ticks: 700 },
    { pid: 40, argv: ["/usr/bin/node", EXE], ticks: 800 }
  ]);
  const apps = await findLinuxCodexProcesses(EXE, fs);
  assert.deepEqual(apps, [{ pid: 10, key: "10:1700000005000", launchedAt: 1_700_000_005_000,
    command: `${EXE} --remote-debugging-address=127.0.0.1 --remote-debugging-port=4321 codex://a b`,
    arguments: ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=4321", "codex://a b"] }]);

  const rewritten = await findLinuxCodexProcesses(EXE, fakeProc([
    { pid: 11, title: `${EXE} --remote-debugging-address=127.0.0.1 --remote-debugging-port=35665`, ticks: 100 },
    { pid: 12, title: `${EXE} --type=renderer --lang=en-US`, ticks: 100 },
    { pid: 13, title: `${EXE} --title='a b'`, ticks: 100 },
    { pid: 14, title: `${EXE}-other --x`, ticks: 100 }
  ]));
  assert.deepEqual(rewritten.map(({ pid, arguments: args }) => [pid, args]), [
    [11, ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=35665"]],
    [13, null]
  ]);
  assert.equal(parseLinuxStartTicks("1 (a) b) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 77 x"), 77);

  const poll = createPollingSnapshot({ executable: EXE, platform: "linux", now: () => 5, findLinuxImpl: (executable) => findLinuxCodexProcesses(executable, fs) });
  const result = await poll();
  assert.equal(result.apps[0].finishedLaunching, true);
  assert.equal(result.now, 5);
});

test("桌面入口覆盖：只替换每个 Exec 的程序，保留 %U、协议与动作参数，去掉 DBusActivatable", () => {
  const text = buildDesktopOverride(SYSTEM_DESKTOP, ["/opt/node 22/bin/node", "/repo/src/cli.mjs", "open-codex"]);
  const lines = text.split("\n");
  assert.equal(lines[1], DESKTOP_MARKER);
  assert.ok(lines.includes("Exec=\"/opt/node 22/bin/node\" /repo/src/cli.mjs open-codex %U"));
  assert.ok(lines.includes("Exec=\"/opt/node 22/bin/node\" /repo/src/cli.mjs open-codex --new-window"));
  assert.ok(lines.includes("MimeType=x-scheme-handler/codex;x-scheme-handler/https;"));
  assert.ok(!text.includes("DBusActivatable"));
  // 特殊字符按规范转义。
  assert.match(buildDesktopOverride("[Desktop Entry]\nExec=x", ["/a\\b$c%d"]), /^Exec="\/a\\\\\\\\b\\\\\$c%%d"$/m);
  assert.throws(() => buildDesktopOverride("Exec=x", ["/a"]), /Desktop Entry/);
});

test("systemd 单元：参数加引号，转义 % 与 $，失败才重启", () => {
  const unit = buildSystemdUnit({ programArguments: ["/opt/my node/node", "/repo/100%/cli.mjs", "agent"], environment: { PATH: "/usr/bin", X: "a$b\"c" } });
  assert.ok(unit.includes('ExecStart="/opt/my node/node" "/repo/100%%/cli.mjs" "agent"'));
  assert.ok(unit.includes('Environment="PATH=/usr/bin"'));
  assert.ok(unit.includes('Environment="X=a$$b\\"c"'));
  assert.ok(unit.includes("Restart=on-failure"));
  assert.ok(unit.includes("WantedBy=default.target"));
});

test("Linux install/uninstall 只写隔离目录、只调用假 systemctl；不覆盖用户自己的同名入口", async (t) => {
  const home = await temporary(t);
  const env = { XDG_DATA_DIRS: join(home, "system") };
  await mkdir(join(home, "system", "applications"), { recursive: true });
  await writeFile(join(home, "system", "applications", "chatgpt.desktop"), SYSTEM_DESKTOP);
  const calls = [];
  const execFileImpl = async (file, args) => { calls.push([file, ...args]); return { stdout: "" }; };
  const options = { hostPlatform: "linux", home, env, execFileImpl, execPath: "/fake/node", cliPath: "/repo/cli.mjs", isBun: false,
    configStore: configStore(), runtimeState: stateStore(), fallbackSnapshot: async () => ({ apps: [] }) };
  const locations = linuxLocations({ home, env });

  const result = await installAgent(options);
  assert.equal(result.unitPath, join(home, ".config/systemd/user", SYSTEMD_UNIT));
  assertMode(await stat(result.unitPath), 0o644);
  assert.ok((await readFile(result.unitPath, "utf8")).includes('ExecStart="/fake/node" "/repo/cli.mjs" "agent"'));
  const desktop = await readFile(locations.desktopPath, "utf8");
  assert.ok(desktop.includes("Exec=/fake/node /repo/cli.mjs open-codex %U"));
  assert.deepEqual(calls, [
    ["update-desktop-database", locations.applicationsDir],
    ["systemctl", "--user", "daemon-reload"],
    ["systemctl", "--user", "enable", SYSTEMD_UNIT],
    ["systemctl", "--user", "restart", SYSTEMD_UNIT]
  ]);

  // 升级：覆盖自己生成的入口。
  await installAgent({ ...options, env: { ...env, CODEX_COMPANION_CONFIG_PATH: "/cfg/c.json" } });
  assert.ok((await readFile(locations.desktopPath, "utf8")).includes("Exec=/usr/bin/env CODEX_COMPANION_CONFIG_PATH=/cfg/c.json /fake/node /repo/cli.mjs open-codex %U"));

  calls.length = 0;
  const removed = await uninstallAgent(options);
  assert.equal(removed.desktopRemoved, true);
  assert.deepEqual(calls.slice(0, 2), [["systemctl", "--user", "disable", "--now", SYSTEMD_UNIT], ["systemctl", "--user", "daemon-reload"]]);
  await assert.rejects(stat(locations.desktopPath), { code: "ENOENT" });
  await assert.rejects(stat(result.unitPath), { code: "ENOENT" });

  await writeFile(locations.desktopPath, "[Desktop Entry]\nExec=my-own-chatgpt\n");
  calls.length = 0;
  await assert.rejects(installAgent(options), { code: "DESKTOP_ENTRY_CONFLICT" });
  assert.deepEqual(calls, []);
  assert.equal((await uninstallAgent(options)).desktopRemoved, false);
  assert.equal(await readFile(locations.desktopPath, "utf8"), "[Desktop Entry]\nExec=my-own-chatgpt\n");
});

test("未安装 ChatGPT 时 Linux install 失败且不注册服务", async (t) => {
  const home = await temporary(t);
  const calls = [];
  await assert.rejects(installAgent({ hostPlatform: "linux", home, env: { XDG_DATA_DIRS: join(home, "none") },
    execFileImpl: async (...args) => { calls.push(args); }, execPath: "/fake/node", cliPath: "/repo/cli.mjs", isBun: false }),
  { code: "CODEX_NOT_INSTALLED" });
  assert.deepEqual(calls, []);
});

test("菜单入口与 agent 同一程序，子命令为 open-codex；参数原样透传不解析", () => {
  assert.deepEqual(launcherProgramArguments({ execPath: "/n", cliPath: "/c.mjs", isBun: false }), ["/n", "/c.mjs", "open-codex"]);
  assert.deepEqual(launcherProgramArguments({ execPath: "/opt/companion", isBun: true }), ["/opt/companion", "open-codex"]);
  assert.deepEqual(parseArgs(["open-codex", "--new-window", "codex://x", "--port"]).passthrough, ["--new-window", "codex://x", "--port"]);
});

function fakeSpawn(calls, error) {
  return (file, args, options) => {
    const child = new EventEmitter();
    child.pid = 77;
    child.unref = () => calls.push("unref");
    calls.push({ file, args, options });
    queueMicrotask(() => (error ? child.emit("error", error) : child.emit("spawn")));
    return child;
  };
}

test("open-codex 以 loopback 随机端口启动，带上勾选的代理，菜单参数放在最后", async () => {
  const calls = [];
  const config = normalizeCompanionConfigV2({ launch: { proxy: { enabled: true, port: 7890 } } });
  const result = await openCodex({ executable: EXE, args: ["codex://open"], configStore: configStore(config),
    reservePort: async () => 4321, spawnImpl: fakeSpawn(calls), env: { ALL_PROXY: "socks://x", HOME: "/h" } });
  assert.deepEqual(result, { launched: true, pid: 77, port: 4321, proxyPort: 7890 });
  assert.equal(calls[0].file, EXE);
  assert.deepEqual(calls[0].args.slice(0, 3), ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=4321", "--proxy-server=http://127.0.0.1:7890"]);
  assert.equal(calls[0].args.at(-1), "codex://open");
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.env.HTTPS_PROXY, "http://127.0.0.1:7890");
  assert.equal(calls[0].options.env.ALL_PROXY, undefined);
  assert.equal(calls.at(-1), "unref");
});

test("open-codex 配置损坏时仍打开 Codex（不带代理）；可执行文件缺失时报错", async () => {
  const calls = [];
  const warnings = [];
  const broken = { async loadV2() { throw new Error("坏配置"); } };
  const result = await openCodex({ executable: EXE, configStore: broken, reservePort: async () => 1234,
    spawnImpl: fakeSpawn(calls), env: {}, logger: { warn: (message) => warnings.push(message) } });
  assert.equal(result.proxyPort, null);
  assert.deepEqual(calls[0].args, ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=1234"]);
  assert.equal(warnings.length, 1);
  await assert.rejects(openCodex({ executable: EXE, configStore: configStore(), reservePort: async () => 1,
    spawnImpl: fakeSpawn([], Object.assign(new Error("missing"), { code: "ENOENT" })), env: {} }), { code: "ENOENT" });
});

test("桌面通知：Linux 用 notify-send，参数分开传；其它平台不支持", async () => {
  const calls = [];
  assert.equal(await notifyDesktop("标题", "-消息", { platform: "linux", execFileImpl: async (...args) => { calls.push(args); } }), true);
  assert.deepEqual(calls, [["notify-send", ["--app-name=Codex Companion", "--", "标题", "-消息"]]]);
  assert.equal(await notifyDesktop("t", "m", { platform: "linux", execFileImpl: async () => { throw new Error("ENOENT"); } }), false);
  assert.equal(await notifyDesktop("t", "m", { platform: "win32", execFileImpl: async () => { throw new Error("不应调用"); } }), false);
});

test("Linux 状态：不报告自动重开，标明需经应用菜单打开", () => {
  const config = { agent: { autoRelaunch: true } };
  const linux = getAgentStatus({ hostPlatform: "linux", config });
  assert.equal(linux.autoRelaunch, false);
  assert.equal(linux.reopen, "menu");
  const mac = getAgentStatus({ hostPlatform: "darwin", config });
  assert.equal(mac.autoRelaunch, true);
  assert.equal("reopen" in mac, false);
});
