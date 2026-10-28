import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { CompanionConfig, ConfigError, defaultCompanionConfigPath } from "../companion-config.mjs";
import { DEFAULT_CODEX_EXECUTABLE, codexLaunchSupported, inspectRunningCodex, buildCodexLaunchEnvironment, buildCodexLaunchArgs, reserveLoopbackPort } from "../launcher.mjs";

const execFileAsync = promisify(execFile);
const fail = (code, message) => Object.assign(new Error(message), { code });
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
export const CODEX_RELAUNCH_DELAY_MS = 750;

function validatePreferences(preferences) {
  if (!isRecord(preferences) || Object.keys(preferences).some(key => !["launchThroughProxy", "proxyPort"].includes(key))
    || typeof preferences.launchThroughProxy !== "boolean" || !Number.isInteger(preferences.proxyPort)
    || preferences.proxyPort < 1 || preferences.proxyPort > 65535) throw fail("LAUNCHER_INVALID", "代理设置必须是开关和 1–65535 的本机端口");
  return { launchThroughProxy: preferences.launchThroughProxy, proxyPort: preferences.proxyPort };
}

export class PluginLauncher {
  constructor({
    configPath = process.env.CODEX_COMPANION_CONFIG_PATH ?? defaultCompanionConfigPath(),
    execFileImpl = execFileAsync, readFileImpl = readFile, inspectImpl = inspectRunningCodex, spawnImpl = spawn,
    helperCommand = process.execPath,
    helperPrefix = typeof globalThis.Bun === "undefined" ? [fileURLToPath(new URL("./server.mjs", import.meta.url))] : [],
    platform = process.platform
  } = {}) {
    this.supported = codexLaunchSupported(platform);
    this.path = configPath;
    this.configPath = configPath;
    this.file = new CompanionConfig({ path: configPath, execFileImpl, readFileImpl, platform });
    this.execFileImpl = execFileImpl;
    this.inspectImpl = inspectImpl;
    this.spawnImpl = spawnImpl;
    this.helperCommand = helperCommand;
    this.helperPrefix = helperPrefix;
    this.pending = false;
  }

  async readPreferences() {
    const config = await this.file.loadV2({ strict: true });
    return { version: 1, revision: config.revision,
      preferences: { launchThroughProxy: config.launch.proxy.enabled, proxyPort: config.launch.proxy.port } };
  }

  async legacyPreferences() {
    const { proxy } = await this.file.readLegacyLaunchDefaults();
    return { launchThroughProxy: proxy.enabled, proxyPort: proxy.port };
  }

  async load() {
    return this.readPreferences();
  }

  async status() {
    const state = await this.load();
    if (!this.supported) {
      return { supported: false, preferences: state.preferences, revision: state.revision, running: null,
        runningProxyPort: null, relaunchPending: false };
    }
    const processes = await this.inspectImpl(DEFAULT_CODEX_EXECUTABLE);
    return { supported: true, preferences: state.preferences, revision: state.revision, running: processes.length > 0,
      runningProxyPort: processes[0]?.proxyPort ?? null, relaunchPending: this.pending };
  }

  async save(preferences, options = {}) {
    preferences = validatePreferences(preferences);
    const state = await this.load();
    if (own(options, "expectedRevision") && options.expectedRevision !== state.revision) {
      throw new ConfigError("CONFIG_CONFLICT", "启动偏好已变化，请刷新后重试", { revision: state.revision });
    }
    if (state.revision === Number.MAX_SAFE_INTEGER) throw fail("LAUNCHER_INVALID", "启动偏好版本号已达上限");
    await this.file.patch({ launch: { proxy: { enabled: preferences.launchThroughProxy, port: preferences.proxyPort } } },
      { expectedRevision: state.revision });
    return this.status();
  }

  async schedule(action = "relaunch") {
    if (!["relaunch", "stop"].includes(action)) throw fail("LAUNCHER_INVALID", "启动操作无效");
    if (!this.supported) throw fail("LAUNCHER_UNSUPPORTED", "当前系统暂不支持由 Companion 退出或重启 Codex");
    if (this.pending) throw fail("LAUNCHER_BUSY", "已安排 Codex 退出或重启");
    this.pending = true;
    try {
      const { preferences } = await this.load();
      const processes = await this.inspectImpl(DEFAULT_CODEX_EXECUTABLE);
      if (processes.length > 1) throw fail("LAUNCHER_AMBIGUOUS", "存在多个 Codex 主进程，请先关闭多余实例");
      if (processes.length === 0 && action === "stop") { this.pending = false; return { scheduled: false, reason: "not-running" }; }
      const expectedPid = processes[0]?.pid ?? 0;
      if (!Number.isSafeInteger(expectedPid) || expectedPid < 0) throw fail("LAUNCHER_INVALID", "Codex 进程标识无效");
      const port = preferences.launchThroughProxy ? preferences.proxyPort : 0;
      const child = this.spawnImpl(this.helperCommand, [...this.helperPrefix, action === "relaunch" ? "--relaunch-codex" : "--stop-codex", String(expectedPid), String(port)], {
        detached: true, stdio: "ignore", env: { ...process.env, CODEX_COMPANION_CONFIG_PATH: this.configPath }
      });
      await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
      child.unref();
      return { scheduled: true, delayMs: CODEX_RELAUNCH_DELAY_MS };
    } catch (error) {
      this.pending = false;
      if (String(error.code).startsWith("LAUNCHER_")) throw error;
      throw fail("LAUNCHER_START_FAILED", "无法安排 Codex 启动操作，请稍后重试");
    }
  }
}

export function buildPluginCodexLaunchArgs(preferences, { debugPort = null } = {}) {
  validatePreferences(preferences);
  if (debugPort !== null) {
    if (!Number.isInteger(debugPort) || debugPort < 1 || debugPort > 65535) throw fail("LAUNCHER_INVALID", "调试端口无效");
    return buildCodexLaunchArgs(debugPort, preferences.launchThroughProxy ? preferences.proxyPort : null);
  }
  return preferences.launchThroughProxy ? [
    `--proxy-server=http://127.0.0.1:${preferences.proxyPort}`,
    "--proxy-bypass-list=<local>;10.0.0.0/8;172.16.0.0/12;192.168.0.0/16"
  ] : [];
}

// handoff 在宿主退出时继续运行，只允许固定 app、经 ps 再确认的 PID 和 SIGTERM。
export async function runCodexHandoff({
  action = "relaunch", expectedPid, preferences: savedPreferences, launcher = new PluginLauncher(),
  inspectImpl = inspectRunningCodex, killImpl = process.kill.bind(process), spawnImpl = spawn,
  sleepImpl = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now,
  loadAgentConfig = () => launcher.file.loadV2({ strict: true }), reservePort = reserveLoopbackPort,
  environment = process.env, delayMs = CODEX_RELAUNCH_DELAY_MS, timeoutMs = 20_000
} = {}) {
  if (!["relaunch", "stop"].includes(action) || !Number.isSafeInteger(expectedPid) || expectedPid < 0) throw fail("LAUNCHER_INVALID", "启动交接参数无效");
  const preferences = validatePreferences(savedPreferences ?? (await launcher.load()).preferences);
  // 在退出宿主前完成配置读取与端口分配；自动加载开启时直接启动可接入的实例，避免 agent 再重开一次。
  const debugPort = action === "relaunch" && (await loadAgentConfig()).agent?.autoRelaunch === true ? await reservePort() : null;
  const args = buildPluginCodexLaunchArgs(preferences, { debugPort });
  await sleepImpl(delayMs);
  let processes = await inspectImpl(DEFAULT_CODEX_EXECUTABLE);
  if (processes.some(process => process.pid !== expectedPid)) throw fail("LAUNCHER_PROCESS_CHANGED", "Codex 进程已变化，未执行退出或重启");
  const current = processes.find(process => process.pid === expectedPid);
  if (current) {
    try { killImpl(current.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw fail("LAUNCHER_STOP_FAILED", "无法正常退出 Codex"); }
  }
  const deadline = now() + timeoutMs;
  while (processes.length) {
    if (now() >= deadline) throw fail("LAUNCHER_STOP_TIMEOUT", "Codex 尚未退出，未启动新实例");
    await sleepImpl(100);
    processes = await inspectImpl(DEFAULT_CODEX_EXECUTABLE);
    if (processes.some(process => process.pid !== expectedPid)) throw fail("LAUNCHER_PROCESS_CHANGED", "检测到新的 Codex 实例，未重复启动");
  }
  if (action === "stop") return { stopped: Boolean(current), launched: false };
  const env = buildCodexLaunchEnvironment(preferences.launchThroughProxy ? preferences.proxyPort : null, environment);
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawnImpl(DEFAULT_CODEX_EXECUTABLE, args, { detached: true, stdio: "ignore", env });
  await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  child.unref();
  return { stopped: Boolean(current), launched: true };
}
