import { execFile } from "node:child_process";
import { chmod, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CodexInjector } from "../injector.mjs";
import { createAgentAdapter } from "./adapter.mjs";
import { createAgentDependencies, readAgentStatus, runAgent } from "./main.mjs";
import { isCompanionDebugInstance, parseCodexDebugArgs } from "./codex-args.mjs";
import { resolveNativeHelperPath } from "./native-bridge.mjs";

const execFileAsync = promisify(execFile);
export const AGENT_LABEL = "com.codexcompanion.agent";
export const AGENT_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";

export function agentProgramArguments({ execPath = process.execPath,
  cliPath = fileURLToPath(new URL("../cli.mjs", import.meta.url)), isBun = typeof Bun !== "undefined" } = {}) {
  const compiled = isBun && !/^(?:node|nodejs|bun)(?:\.exe)?$/.test(basename(execPath));
  return compiled ? [resolve(execPath), "agent"] : [resolve(execPath), resolve(cliPath), "agent"];
}

function location({ home = homedir(), plistDir = join(home, "Library", "LaunchAgents"), label = AGENT_LABEL,
  uid = process.getuid?.() ?? 0, logDir = join(home, "Library", "Logs", "codex-companion") } = {}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(label)) throw new Error("LaunchAgent label 无效");
  if (!Number.isSafeInteger(uid) || uid < 0) throw new Error("LaunchAgent uid 无效");
  return { plistDir: resolve(plistDir), label, uid, logDir: resolve(logDir), plistPath: resolve(plistDir, `${label}.plist`) };
}

const xml = text => String(text).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[char]));

export function buildAgentPlist({ label = AGENT_LABEL, programArguments, logDir, environment = {} }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key><array>${programArguments.map(arg => `<string>${xml(arg)}</string>`).join("")}</array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(join(logDir, "agent.out.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(join(logDir, "agent.err.log"))}</string>
  <key>EnvironmentVariables</key><dict>${Object.entries(environment).map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`).join("")}</dict>
</dict></plist>
`;
}

async function bootoutAgent(options, { uid, label }) {
  try {
    await (options.execFileImpl ?? execFileAsync)(options.launchctlPath ?? "/bin/launchctl", ["bootout", `gui/${uid}/${label}`]);
  } catch (error) {
    // launchctl 的 ESRCH 表示该 job 已不在域中；其他错误保留 plist 供重试。
    if (Number(error.code) !== 3 && error.code !== "ESRCH") throw error;
  }
}

export async function installAgent(options = {}) {
  const { plistDir, label, uid, logDir, plistPath } = location(options);
  const env = options.env ?? process.env;
  const helperPath = options.helperPath === undefined ? resolveNativeHelperPath({
    env, execPath: options.execPath, cwd: options.cwd, arch: options.arch
  }) : options.helperPath;
  const environment = { PATH: AGENT_PATH };
  if (helperPath) environment.CODEX_COMPANION_NATIVE_HELPER = resolve(helperPath);
  if (env.CODEX_COMPANION_CODEX_APP) environment.CODEX_COMPANION_CODEX_APP = resolve(env.CODEX_COMPANION_CODEX_APP);
  if (options.configPath ?? env.CODEX_COMPANION_CONFIG_PATH) environment.CODEX_COMPANION_CONFIG_PATH = resolve(options.configPath ?? env.CODEX_COMPANION_CONFIG_PATH);
  const plist = buildAgentPlist({ label, logDir, environment, programArguments: agentProgramArguments(options) });
  // 升级时先卸载旧 job，再替换声明；不能把 bootstrap 的任意失败当作重复安装。
  await bootoutAgent(options, { uid, label });
  await mkdir(plistDir, { recursive: true, mode: 0o700 });
  await mkdir(logDir, { recursive: true, mode: 0o700 });
  const temporary = join(plistDir, `.${label}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, plist, { mode: 0o600, flag: "wx" });
    await rename(temporary, plistPath);
    await chmod(plistPath, 0o600);
  } finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
  await (options.execFileImpl ?? execFileAsync)(options.launchctlPath ?? "/bin/launchctl", ["bootstrap", `gui/${uid}`, plistPath]);
  return { installed: true, label, plistPath };
}

export async function uninstallAgent(options = {}) {
  const { label, uid, plistPath } = location(options);
  const deps = createAgentDependencies(options);
  // bootout 会触发 agent 清空 attachment，因此提前保留端口，并在卸载前重新核对实例。
  const state = await deps.runtimeState.load();
  await bootoutAgent(options, { uid, label });
  await unlink(plistPath).catch(error => { if (error.code !== "ENOENT") throw error; });
  let unmounted = false;
  let unmountError;
  if (state?.port) {
    let injector;
    try {
      const snapshot = await (deps.nativeBridge ? deps.nativeBridge.snapshot() : deps.fallbackSnapshot());
      const app = snapshot.apps.find(app => state.codexKey ? app.key === state.codexKey : app.pid === state.codexPid);
      const parsed = parseCodexDebugArgs(app?.arguments);
      if (app && isCompanionDebugInstance(parsed) && parsed.debugPort === state.port) {
        injector = (options.injectorFactory ?? (port => new CodexInjector(port)))(state.port);
        await injector.injectOnce("unmount");
        unmounted = true;
      }
    } catch (error) { unmountError = String(error.message ?? error); }
    finally { injector?.stop(); }
  }
  return { uninstalled: true, label, unmounted, ...(unmountError ? { unmountError } : {}) };
}

export async function restartCodex(options = {}) {
  const deps = createAgentDependencies(options);
  if (!deps.nativeBridge) return { stopped: false, launched: false, reason: "native-helper-missing" };
  const config = await deps.configStore.loadV2({ strict: true });
  const adapter = createAgentAdapter({ ...options, ...deps, initialConfig: config });
  const now = options.now ?? Date.now;
  const setTimer = options.setTimeoutImpl ?? setTimeout;
  const clearTimer = options.clearTimeoutImpl ?? clearTimeout;
  const sleep = options.sleepImpl ?? (ms => new Promise(resolveSleep => setTimer(resolveSleep, ms)));
  let stopped = false;
  let timer;
  try {
    const snapshot = await adapter.snapshot();
    if (snapshot.apps.length > 1) return { stopped, launched: false, reason: "multiple-instances" };
    const app = snapshot.apps[0];
    if (app) {
      const quit = await adapter.quit({ pid: app.pid, key: app.key, mode: "user" });
      if (!quit.accepted) return { stopped, launched: false, reason: quit.reason ?? "quit-refused" };
      const timeoutMs = Math.min(options.quitTimeoutMs ?? 10_000, 10_000);
      const deadline = now() + timeoutMs;
      const timeout = new Promise((_, reject) => {
        timer = setTimer(() => reject(Object.assign(new Error("等待 Codex 退出超时"), { code: "quit-timeout" })), timeoutMs);
      });
      while (true) {
        if (now() >= deadline) return { stopped, launched: false, reason: "quit-timeout" };
        await Promise.race([sleep(Math.min(200, deadline - now())), timeout]);
        const next = await Promise.race([adapter.snapshot(), timeout]);
        if (now() >= deadline) return { stopped, launched: false, reason: "quit-timeout" };
        if (next.apps.some(entry => entry.key !== app.key)) return { stopped, launched: false, reason: "another-instance" };
        if (!next.apps.length) { stopped = true; break; }
      }
      clearTimer(timer);
    }
    return { stopped, ...await adapter.launch({ hidden: false }) };
  } catch (error) { return { stopped, launched: false, reason: error.code ?? "restart-failed", message: error.message }; }
  finally { clearTimer(timer); }
}

export async function runAgentCommand(subcommand, options = {}) {
  if (!subcommand) return runAgent(options);
  const commands = { install: installAgent, uninstall: uninstallAgent, status: readAgentStatus, "restart-codex": restartCodex };
  if (!commands[subcommand]) throw new Error(`未知 agent 命令：${subcommand}`);
  const result = await commands[subcommand](options);
  (options.output ?? console.log)(JSON.stringify(result));
  return result;
}
