import { spawn, execFile } from "node:child_process";
import { mkdir, open, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import packageInfo from "../../package.json" with { type: "json" };
import { CompanionConfig, defaultCompanionConfigPath } from "../companion-config.mjs";
import { DEFAULT_CODEX_EXECUTABLE, defaultCodexExecutable } from "../launcher.mjs";
import { RuntimeState, defaultRuntimeStatePath, pidIsAlive } from "../runtime-state.mjs";
import { watchCompanionConfig } from "../platform/config/watcher.mjs";
import { AgentController } from "./controller.mjs";
import { isCompanionDebugInstance, parseCodexDebugArgs } from "./codex-args.mjs";
import { createNativeBridge, resolveNativeHelperPath } from "./native-bridge.mjs";
import { createAgentAdapter } from "./adapter.mjs";
import { createAgentFileLogger } from "./logger.mjs";
import { companionDataDir } from "../platform/paths.mjs";
import { findLinuxCodexProcesses } from "../platform/processes.mjs";

const execFileAsync = promisify(execFile);
export const AGENT_VERSION = packageInfo.version;
export const defaultAgentLockPath = (home = homedir()) => join(companionDataDir(home), "agent.lock");

export function resolveCodexAppPath({ env = process.env } = {}) {
  return resolve(env.CODEX_COMPANION_CODEX_APP || defaultCodexExecutable("darwin").replace(/\/Contents\/MacOS\/[^/]+$/, ""));
}

// lockf/flock 锁随父进程 FD 的关闭自动释放。文件不删除，避免并发打开不同 inode。
// PID 检查兼容已有锁记录；只有明确死亡的持有者可被覆盖。
export async function acquireAgentLock({
  path = defaultAgentLockPath(), pid = process.pid, now = Date.now,
  isAlive = pidIsAlive, spawnImpl = spawn, platform = process.platform
} = {}) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const file = await open(path, "a+", 0o600);
  let acquired = false;
  try {
    await file.chmod(0o600);
    acquired = await new Promise((resolveLock, reject) => {
      const child = spawnImpl(platform === "darwin" ? "/usr/bin/lockf" : "/usr/bin/flock",
        platform === "darwin" ? ["-s", "-t", "0", "3"] : ["-n", "3"],
        { stdio: ["ignore", "ignore", "ignore", file.fd] });
      child.once("error", reject);
      child.once("close", code => {
        if (code === 0 || code === (platform === "darwin" ? 75 : 1)) resolveLock(code === 0);
        else reject(Object.assign(new Error(`无法获取 agent 文件锁（${code}）`), { code: "AGENT_LOCK_FAILED" }));
      });
    });
    if (!acquired) { await file.close(); return null; }
    const raw = await file.readFile("utf8");
    if (raw.trim()) {
      let owner;
      try { owner = JSON.parse(raw); } catch { throw new Error("agent 锁文件损坏；未覆盖未知持有者"); }
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || owner.pid > 0x7fffffff) throw new Error("agent 锁持有者无效");
      if (isAlive(owner.pid)) { await file.close(); return null; }
    }
    const owner = { pid, startedAt: now() };
    await file.truncate(0);
    await file.writeFile(`${JSON.stringify(owner)}\n`);
    await file.sync();
    let released = false;
    return { ...owner, path, async release() {
      if (released) return;
      released = true;
      try { await file.truncate(0); await file.sync(); }
      finally { await file.close(); }
    } };
  } catch (error) { await file.close().catch(() => {}); throw error; }
}

export function createPollingSnapshot({ executable = DEFAULT_CODEX_EXECUTABLE, execFileImpl = execFileAsync, now = Date.now,
  platform = process.platform, findLinuxImpl = findLinuxCodexProcesses } = {}) {
  if (platform === "linux") {
    // Linux 没有原生助手：不判断前台与输入，只用于识别与 attach，不自动重开。
    return async () => ({
      apps: (await findLinuxImpl(executable)).map(app => ({ ...app, finishedLaunching: true })),
      frontmostPid: 0, inputStamp: "0:0:0:0:0", inputIdleMs: 0, now: now()
    });
  }
  return async () => {
    const { stdout } = await execFileImpl("/bin/ps", ["-axo", "pid=,lstart=,command="], { timeout: 2000, encoding: "utf8" });
    const apps = [];
    for (const line of String(stdout).split("\n")) {
      const match = line.match(/^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/);
      if (!match) continue;
      const [, pidText, date, command] = match;
      if (command !== executable && !command.startsWith(`${executable} `)) continue;
      const pid = Number(pidText);
      const launchedAt = Date.parse(date);
      if (!Number.isFinite(launchedAt)) throw new Error("无法读取 Codex 进程启动时间");
      const suffix = command.slice(executable.length).trim();
      // ps 无法还原带引号或转义的 argv；无法确认的实例只观察，不接管。
      const args = /["'\\]/.test(suffix) ? null : suffix ? suffix.split(/\s+/) : [];
      apps.push({ pid, key: `${pid}:${launchedAt}`, launchedAt, finishedLaunching: true, arguments: args });
    }
    return { apps, frontmostPid: 0, inputStamp: "0:0:0:0:0", inputIdleMs: 0, now: now() };
  };
}

export function createAgentDependencies(options = {}) {
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  // options.platform 是给页面的 RPC 平台对象，宿主操作系统单独用 hostPlatform。
  const platform = options.hostPlatform ?? process.platform;
  const appPath = options.appPath ?? resolveCodexAppPath({ env });
  const executable = options.executable ?? (platform === "linux"
    ? resolve(env.CODEX_COMPANION_CODEX_EXECUTABLE || defaultCodexExecutable("linux"))
    : `${appPath}/Contents/MacOS/${DEFAULT_CODEX_EXECUTABLE.split("/").at(-1)}`);
  // 原生助手（NSWorkspace）只存在于 macOS，其它平台不自动查找。
  const helperPath = options.helperPath !== undefined ? options.helperPath : platform !== "darwin" ? null
    : resolveNativeHelperPath({ env, execPath: options.execPath, cwd: options.cwd, arch: options.arch });
  const nativeBridge = options.nativeBridge ?? (helperPath ? createNativeBridge({
    helperPath, appPath, execFileImpl: options.execFileImpl, spawnImpl: options.spawnImpl
  }) : null);
  return {
    home, hostPlatform: platform, executable, helperPath, nativeBridge,
    lockPath: options.lockPath ?? defaultAgentLockPath(home),
    configStore: options.configStore ?? new CompanionConfig({
      path: options.configPath ?? env.CODEX_COMPANION_CONFIG_PATH ?? defaultCompanionConfigPath(home), execFileImpl: options.execFileImpl
    }),
    runtimeState: options.runtimeState ?? new RuntimeState({ path: options.runtimePath ?? defaultRuntimeStatePath(home) }),
    fallbackSnapshot: options.fallbackSnapshot ?? createPollingSnapshot({ executable, execFileImpl: options.execFileImpl, now: options.now, platform })
  };
}

// Linux 不自动重开，卡片只在经应用菜单打开时加载：状态带 reopen: "menu" 供设置页改提示。
export function getAgentStatus({ available = true, pid = process.pid, config, snapshot, attachment, lastEvent = null, nativeHelper = "missing",
  hostPlatform = process.platform } = {}) {
  const linux = hostPlatform === "linux";
  const apps = snapshot?.apps ?? [];
  const app = apps.find(app => app.key === attachment?.key) ?? apps[0];
  const parsed = parseCodexDebugArgs(app?.arguments);
  const attached = Boolean(available && attachment && app?.key === attachment.key
    && isCompanionDebugInstance(parsed) && parsed.debugPort === attachment.port);
  return { available, version: AGENT_VERSION, pid: available ? pid : null, autoRelaunch: !linux && config?.agent?.autoRelaunch === true,
    codex: { running: apps.length > 0, pid: app?.pid ?? null, attached, port: parsed.debugPort, proxyPort: parsed.proxyPort },
    lastEvent, nativeHelper, ...(linux ? { reopen: "menu" } : {}) };
}

export async function readAgentStatus(options = {}) {
  const deps = createAgentDependencies(options);
  const [config, state, snapshot, rawLock] = await Promise.all([
    deps.configStore.loadV2(), deps.runtimeState.load(),
    deps.nativeBridge ? deps.nativeBridge.snapshot() : deps.fallbackSnapshot(),
    readFile(deps.lockPath, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; })
  ]);
  let owner;
  try { owner = JSON.parse(rawLock); } catch {}
  const available = Boolean(owner?.pid && owner.pid === state?.agentPid && owner.startedAt === state?.startedAt
    && (options.isAlive ?? pidIsAlive)(owner.pid));
  return getAgentStatus({ available, pid: owner?.pid, config, snapshot,
    attachment: state?.codexKey ? { key: state.codexKey, port: state.port } : null,
    lastEvent: state?.lastEvent ?? null, nativeHelper: deps.nativeBridge ? "ok" : "missing", hostPlatform: deps.hostPlatform });
}

export async function runAgent(options = {}) {
  const deps = createAgentDependencies(options);
  const processRef = options.processRef ?? process;
  const now = options.now ?? Date.now;
  let logger = options.logger ?? console;
  let fileLogger;
  const setTimer = options.setTimeoutImpl ?? setTimeout;
  const clearTimer = options.clearTimeoutImpl ?? clearTimeout;
  const lock = await acquireAgentLock({ path: deps.lockPath, pid: processRef.pid, now,
    isAlive: options.isAlive, spawnImpl: options.lockSpawnImpl ?? options.spawnImpl });
  if (!lock) return { running: false, reason: "already-running", stop: async () => {} };

  let stopped = false;
  let stopping;
  let controller;
  let adapter;
  let config;
  let watcher;
  let nativeWatch;
  let watchHealthy = false;
  let watchGeneration = 0;
  let pollTimer;
  let pendingTimer;
  let retryTimer;
  let retryMs = 1000;
  let polling;
  const waits = new Map();
  const report = error => logger.warn?.(`[codex-companion] agent：${error.message ?? error}`);
  const platform = {
    getAgentStatus: () => getAgentStatus({ available: !stopped, pid: processRef.pid, config,
      snapshot: adapter.snapshotValue, attachment: adapter.attachment, lastEvent: adapter.state.lastEvent,
      nativeHelper: deps.nativeBridge ? "ok" : "missing", hostPlatform: deps.hostPlatform }),
    requestCodexRestart: params => deps.nativeBridge ? controller.requestUserRestart(params)
      : Promise.resolve({ accepted: false, reason: "native-helper-missing" })
  };
  const pause = ms => new Promise(resolvePause => {
    if (stopped) return resolvePause();
    const timer = setTimer(() => { waits.delete(timer); resolvePause(); }, ms);
    waits.set(timer, resolvePause);
  });

  async function accept(snapshot) {
    if (stopped) return;
    if (adapter.snapshotValue && snapshot.now < adapter.snapshotValue.now) return;
    adapter.observe(snapshot);
    await controller.handleSnapshot(snapshot);
    if (!stopped && controller.pendingLaunch && !pendingTimer) {
      pendingTimer = setTimer(() => { pendingTimer = null; void poll(); }, 300);
    }
  }

  function poll() {
    if (stopped) return Promise.resolve();
    if (polling) return polling;
    polling = adapter.snapshot().then(accept).catch(report).finally(() => { polling = null; });
    return polling;
  }

  function schedulePoll() {
    if (stopped || watchHealthy || pollTimer) return;
    pollTimer = setTimer(async () => {
      pollTimer = null;
      await poll();
      schedulePoll();
    }, 2000);
  }

  function startWatch() {
    if (stopped || !deps.nativeBridge) return;
    const generation = ++watchGeneration;
    const startedAt = now();
    let ended = false;
    const onExit = error => {
      if (stopped || generation !== watchGeneration || ended) return;
      ended = true;
      nativeWatch?.close();
      nativeWatch = null;
      watchHealthy = false;
      report(error ?? new Error("native watch 已退出"));
      schedulePoll();
      retryTimer = setTimer(() => { retryTimer = null; startWatch(); }, retryMs);
      retryMs = Math.min(retryMs * 2, 30_000);
    };
    try {
      const handle = deps.nativeBridge.watch({
        onSnapshot: snapshot => {
          if (stopped || ended || generation !== watchGeneration) return;
          // 运行至少一个心跳周期才清零退避，避免「输出基线后立即崩溃」反复拉起。
          if (now() - startedAt >= 30_000) retryMs = 1000;
          watchHealthy = true;
          clearTimer(pollTimer);
          pollTimer = null;
          void accept(snapshot).catch(report);
        }, onExit
      });
      if (ended) handle.close();
      else nativeWatch = handle;
    } catch (error) { onExit(error); }
  }

  function stop() {
    if (stopping) return stopping;
    stopped = true;
    controller?.stop();
    for (const signal of ["SIGTERM", "SIGINT"]) processRef.removeListener(signal, onSignal);
    nativeWatch?.close();
    nativeWatch = null;
    for (const timer of [pollTimer, pendingTimer, retryTimer]) clearTimer(timer);
    for (const [timer, resolvePause] of waits) { clearTimer(timer); resolvePause(); }
    waits.clear();
    stopping = (async () => {
      try {
        try { await watcher?.close(); }
        finally { await adapter?.close(); }
      } catch (error) {
        fileLogger?.error(`[codex-companion] agent 停止失败：${error.message}`);
        throw error;
      } finally {
        try { await fileLogger?.close(); }
        finally { await lock.release(); }
      }
    })();
    return stopping;
  }
  function onSignal() { void stop().then(() => { processRef.exitCode = 0; }, error => { report(error); processRef.exitCode = 1; }); }

  try {
    if (options.logDir) {
      fileLogger = await createAgentFileLogger({ logDir: options.logDir, home: deps.home, now, fallbackLogger: logger });
      logger = fileLogger;
    }
    config = await deps.configStore.loadV2({ strict: true });
    const initialState = await deps.runtimeState.load();
    adapter = createAgentAdapter({ ...options, ...deps, initialConfig: config, initialState,
      platform, logger, now, pid: processRef.pid });
    await adapter.initialize(lock.startedAt);
    controller = new AgentController({ adapter, now, sleep: pause,
      lastAttemptAt: initialState?.lastAttemptAt ?? 0,
      autoRelaunch: () => Boolean(deps.nativeBridge && config.agent.autoRelaunch),
      notifyWhenManual: deps.hostPlatform === "linux" });
    for (const signal of ["SIGTERM", "SIGINT"]) processRef.once(signal, onSignal);
    watcher = await (options.watchConfig ?? watchCompanionConfig)({ config: deps.configStore,
      onChange: async next => {
        if (stopped) return;
        try { await adapter.applyConfig(next); }
        finally { if (!stopped) config = next; }
      }, onError: report });
    if (stopped) { await watcher.close(); await stopping; return { running: false, stop }; }
    startWatch();
    if (!watchHealthy) { await poll(); schedulePoll(); }
    return { running: true, stop, controller, adapter, ...platform };
  } catch (error) {
    fileLogger?.error(`[codex-companion] agent 启动失败：${error.message}`);
    await stop();
    throw error;
  }
}
