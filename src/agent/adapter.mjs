import { setTimeout as sleep } from "node:timers/promises";
import { buildCodexLaunchArgs, DEFAULT_CODEX_EXECUTABLE, reserveLoopbackPort } from "../launcher.mjs";
import { notifyMacos } from "../daemon.mjs";
import { RuntimeState } from "../runtime-state.mjs";
import { waitForCodexTargets } from "../targets.mjs";
import { createCodexSession } from "./session.mjs";

const PROXY_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"];
export const AGENT_NOTIFICATIONS = Object.freeze({
  "needs-restart": "Companion 未加载：退出并重新打开 Codex 即可显示卡片。",
  skipped: "本次未自动加载 Companion，下次打开 Codex 时生效。",
  "relaunch-failed": "Codex 自动重开失败，请手动打开 Codex。"
});

// 即使注入的等待实现尚未响应取消，也不允许过期结果启动新的会话。
function abortable(operation, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cancel = () => reject(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
    Promise.resolve().then(operation).then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
  });
}

export function createAgentAdapter({
  nativeBridge = null, fallbackSnapshot, configStore, initialConfig, initialState = {},
  runtimeState = new RuntimeState(), executable = DEFAULT_CODEX_EXECUTABLE, platform,
  logger = console, now = Date.now, pid = process.pid,
  reservePort = reserveLoopbackPort, sessionFactory = createCodexSession,
  waitForTargets = waitForCodexTargets, execFileImpl,
  notifyImpl = (title, message) => notifyMacos(title, message, { execFileImpl }),
  sleepImpl = (ms, signal) => sleep(ms, undefined, { signal }),
  retryMs = 300, maxRetryMs = 5000
} = {}) {
  let config = initialConfig;
  let state = initialState ?? {};
  let writes = Promise.resolve();
  let current = null;
  let work = Promise.resolve();
  let latestSnapshot = null;
  let closed = false;
  const notifications = new Map();
  const log = error => logger.warn?.(`[codex-companion] 会话连接失败：${error.message ?? error}`);

  function persist(patch) {
    const operation = writes.then(async () => {
      const next = { ...state, ...patch };
      await runtimeState.save(next);
      state = next;
    });
    writes = operation.catch(() => {});
    return operation;
  }

  async function connect(entry) {
    let delay = retryMs;
    const { signal } = entry.abort;
    while (!signal.aborted && !closed) {
      try {
        await abortable(() => waitForTargets(entry.port, { timeoutMs: 2000, signal }), signal);
        signal.throwIfAborted();
        entry.session = sessionFactory({ port: entry.port, configStore, executable, logger, platform,
          initialConfig: config, processRef: {} });
        await entry.session.start();
        signal.throwIfAborted();
        await persist({ port: entry.port, codexPid: entry.pid, codexKey: entry.key });
        signal.throwIfAborted();
        entry.ready = true;
        return;
      } catch (error) {
        await entry.session?.stop("attach-retry").catch(log);
        entry.session = null;
        if (signal.aborted || closed) return;
        log(error);
        try { await abortable(() => sleepImpl(delay, signal), signal); }
        catch { return; }
        delay = Math.min(delay * 2, maxRetryMs);
      }
    }
  }

  function cancel(entry, reason) {
    entry.abort.abort();
    entry.ready = false;
    return Promise.resolve(entry.session?.stop(reason)).catch(log);
  }

  const adapter = {
    initialize: (startedAt = now()) => persist({ agentPid: pid, daemonPid: null, startedAt, port: null, codexPid: null, codexKey: null }),
    observe(snapshot) { latestSnapshot = snapshot; },
    get snapshotValue() { return latestSnapshot; },
    get attachment() { return current?.ready ? { pid: current.pid, key: current.key, port: current.port } : null; },
    get state() { return state; },
    async snapshot() {
      const snapshot = await (nativeBridge ? nativeBridge.snapshot() : fallbackSnapshot());
      if (!closed && (!latestSnapshot || snapshot.now >= latestSnapshot.now)) latestSnapshot = snapshot;
      return snapshot;
    },
    quit: options => nativeBridge ? nativeBridge.quit(options) : Promise.resolve({ accepted: false, reason: "native-helper-missing" }),
    show: options => nativeBridge ? nativeBridge.show(options) : Promise.resolve({ shown: false }),
    async launch(options = {}) {
      if (!nativeBridge || closed) return { launched: false, reason: closed ? "stopped" : "native-helper-missing" };
      const port = await reservePort();
      if (closed) return { launched: false, reason: "stopped" };
      const proxy = config?.launch?.proxy;
      const proxyPort = proxy?.enabled ? proxy.port : null;
      const env = proxyPort === null ? {} : Object.fromEntries(PROXY_KEYS.slice(0, 4).map(key => [key, `http://127.0.0.1:${proxyPort}`]));
      return nativeBridge.launch({ ...options, args: buildCodexLaunchArgs(port, proxyPort), env,
        unsetEnv: proxyPort === null ? [...PROXY_KEYS] : PROXY_KEYS.slice(4) });
    },
    async attach({ pid: codexPid, key, port }) {
      if (closed || current?.key === key) return;
      const previous = current;
      const stopping = previous ? cancel(previous, "replaced") : Promise.resolve();
      const entry = { pid: codexPid, key, port, abort: new AbortController(), session: null, ready: false };
      current = entry;
      // 不把 CDP 就绪等待交给状态机。旧会话完全停止后，后台才创建下一个。
      work = work.then(async () => {
        await stopping;
        if (!entry.abort.signal.aborted && !closed) await connect(entry);
      }).catch(log);
    },
    async detach({ key, reason } = {}) {
      if (!current || (key && current.key !== key)) return;
      const entry = current;
      current = null;
      await cancel(entry, reason);
      await work;
      await persist({ port: null, codexPid: null, codexKey: null });
    },
    async applyConfig(next) {
      config = next;
      await current?.session?.applyConfig(next);
    },
    async record(event, details = {}) {
      if (closed) return;
      await persist({ lastEvent: { event, at: now() },
        ...(event === "attempt" ? { lastAttemptAt: details.lastAttemptAt } : {}) });
      logger.info?.(`[codex-companion] ${event} ${JSON.stringify(details)}`);
    },
    async notify(kind) {
      const message = AGENT_NOTIFICATIONS[kind];
      const previous = notifications.get(kind);
      if (closed || !message || (previous !== undefined && now() - previous < 600_000)) return;
      notifications.set(kind, now());
      try { await notifyImpl("Codex Companion", message); }
      catch (error) { logger.warn?.(`[codex-companion] 通知失败：${error.message}`); }
    },
    async close() {
      if (closed) return;
      closed = true;
      await adapter.detach({ reason: "agent-stop" });
      await work;
      await persist({ agentPid: null, port: null, codexPid: null, codexKey: null });
    }
  };
  return adapter;
}
