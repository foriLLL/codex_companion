import { createCardLifecycle } from "../platform/lifecycle.mjs";
import { createStore, resolveScopeId } from "../platform/storage.mjs";
import { createRpcClient } from "../platform/rpc-client.mjs";
import { createCardShell } from "../shell/card-shell.mjs";
import { createCodexAdapter } from "../adapters/codex.mjs";
import { createCodexThreads } from "../adapters/codex-threads.mjs";

import { normalizeRuntimeConfig } from "../../platform/config/runtime-config.mjs";
export { normalizeRuntimeConfig };

// 注入产物升级后仍沿用同一 document 的代次，避免后台把新实例判为旧请求。
const generationKey = Symbol.for("codex-companion.card-generation");
function allocateGeneration() {
  const generation = (globalThis[generationKey] ?? 0) + 1;
  globalThis[generationKey] = generation;
  return generation;
}

function safeBackend(name, onError) {
  try { return globalThis[name]; } catch (error) {
    onError(error);
    return { getItem: () => null, setItem: () => { throw error; } };
  }
}

export function createCardRuntime({
  manifests, renderers, config: initialConfig = {}, artifactHash,
  shellFactory = createCardShell, adapterFactory = createCodexAdapter, threadsFactory = createCodexThreads,
  localStorage: localBackend, sessionStorage: sessionBackend,
  rpcClient = createRpcClient(), onError = () => {}
}) {
  const records = new Map();
  const failures = [];
  const shell = shellFactory();
  const platformController = new AbortController();
  // 设置有独立代次和 signal，关闭业务卡片不能中止平台 RPC。
  const hasSettings = typeof shell.configureSettings === "function";
  if (hasSettings) {
    const call = rpcClient.scoped("companion", allocateGeneration(), platformController.signal);
    shell.configureSettings({ call: (method, params) => call(method, params, { timeoutMs: 15_000 }) });
  }
  let disposed = false;
  let disposal;
  let visibility = { visible: false, reason: "initial", placement: initialConfig.placement };
  // 独立插件页面可以逐卡切换；旧注入入口未设置覆盖值时保持原有行为。
  const cardVisibility = new Map();
  let config = normalizeRuntimeConfig(initialConfig, manifests);
  // 会话列表属于宿主原生界面，只由平台创建；没有声明 threads 能力的卡片拿不到它。
  let threads = null;

  const effectiveVisibility = (id) => ({ ...visibility, visible: visibility.visible && cardVisibility.get(id) !== false });

  function report(error, details = {}) {
    failures.push({ message: error?.message || String(error), code: error?.code, ...details });
    if (failures.length > 50) failures.shift();
    try { Promise.resolve(onError(error, details)).catch(() => {}); } catch {}
  }
  localBackend ??= safeBackend("localStorage", (error) => report(error, { phase: "storage" }));
  sessionBackend ??= safeBackend("sessionStorage", (error) => report(error, { phase: "storage" }));
  let scopeId;
  try { scopeId = resolveScopeId(sessionBackend); } catch (error) {
    report(error, { phase: "storage" });
    scopeId = `volatile-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function makeStorage(manifest, signal) {
    const stores = new Map();
    const assertActive = () => {
      if (signal.aborted) throw Object.assign(new Error("卡片实例已卸载"), { code: "STATE_DISPOSED" });
    };
    function namespace(name = "state", options = {}) {
      const cacheKey = JSON.stringify([name, options.version ?? manifest.state.version]);
      if (stores.has(cacheKey)) {
        const existing = stores.get(cacheKey);
        for (const key of ["validate", "migrate"]) {
          if (Object.hasOwn(options, key) && options[key] !== existing.options[key]) {
            throw Object.assign(new Error("同一状态命名空间不能重复声明不同 schema"), { code: "STATE_SCHEMA_CONFLICT" });
          }
        }
        return existing.guarded;
      }
      const store = createStore({
        ...options, storage: manifest.state.scope === "session" ? sessionBackend : localBackend,
        namespace: `codex-companion.card.${manifest.id}.${encodeURIComponent(name)}`,
        scopeId: manifest.state.scope === "global" ? undefined : scopeId,
        version: options.version ?? manifest.state.version,
        onError: (error) => report(error, { cardId: manifest.id, phase: "storage" })
      });
      const guarded = { key: store.key, diagnostics: () => store.diagnostics() };
      for (const method of ["read", "write", "update", "copyLegacy"]) {
        guarded[method] = (...args) => {
          assertActive();
          // localStorage 不提供跨窗口原子 CAS；共享写入必须走后端服务。
          if (manifest.state.scope === "global" && method !== "read") {
            throw Object.assign(new Error("共享状态不能在 renderer 中写入，请通过后端服务原子更新"), { code: "STATE_SCOPE_READONLY" });
          }
          return store[method](...args);
        };
      }
      stores.set(cacheKey, { guarded, options });
      return guarded;
    }
    const facade = {
      namespace,
      readLegacy(key) { assertActive(); return localBackend.getItem(key); }
    };
    for (const method of ["read", "write", "update", "copyLegacy", "diagnostics"]) {
      facade[method] = (...args) => namespace()[method](...args);
    }
    Object.defineProperty(facade, "key", { get: () => namespace().key });
    return facade;
  }

  function start(record) {
    if (record.started || disposed) return;
    record.started = true;
    record.lifecycle.start(record.settings).catch((error) => report(error, { cardId: record.manifest.id, phase: "start" }));
  }

  function createRecord(manifest) {
    const record = { manifest, settings: config.cards[manifest.id].settings, started: false, handle: null };
    record.slot = shell.add(manifest, () => retry(manifest.id));
    record.lifecycle = createCardLifecycle({
      createContext({ signal, effects, settings }) {
        record.effects = effects;
        effects.setSuspended?.(manifest.lifecycle.hidden === "suspend" && !effectiveVisibility(manifest.id).visible);
        const generation = allocateGeneration();
        record.generation = generation;
        const rpc = rpcClient.scoped(manifest.id, generation, signal);
        return {
          root: record.slot.root, manifest, settings,
          storage: makeStorage(manifest, signal), rpc, effects,
          reportError: (error) => report(error, { cardId: manifest.id, phase: "card" }),
          isVisible: () => effectiveVisibility(manifest.id).visible,
          ...(manifest.capabilities.includes("threads") ? { threads } : {}),
          // 只有平台负责可见性；业务可以申请展开，不能操作原生 DOM。
          requestOpen: () => adapter?.setOpen(true)
        };
      },
      async mount(ctx) {
        const module = renderers[manifest.id];
        if (typeof module?.mount !== "function") throw new Error(`卡片 ${manifest.id} 缺少 mount 入口`);
        // Lifecycle 内部的局部代次用于清理；对业务暴露与 RPC 一致的 document 代次。
        const handle = await module.mount({ ...ctx, generation: record.generation });
        if (!ctx.signal.aborted) record.handle = handle;
        return handle;
      },
      onError(error, info) {
        report(error, { cardId: manifest.id, ...info });
        if (records.get(manifest.id) === record && info?.phase !== "dispose") record.slot.showError(error);
      }
    });
    records.set(manifest.id, record);
    record.lifecycle.visibilityChanged(effectiveVisibility(manifest.id));
    if (manifest.lifecycle.start === "immediate" || effectiveVisibility(manifest.id).visible) start(record);
    return record;
  }

  function visibilityChanged(state) {
    visibility = typeof state === "boolean" ? { visible: state, placement: config.placement } : state;
    for (const record of records.values()) {
      const effective = effectiveVisibility(record.manifest.id);
      record.effects?.setSuspended?.(record.manifest.lifecycle.hidden === "suspend" && !effective.visible);
      if (effective.visible) start(record);
      record.lifecycle.visibilityChanged(effective).catch((error) => report(error, { cardId: record.manifest.id }));
    }
  }

  function setCardVisibility(id, visible) {
    cardVisibility.set(id, Boolean(visible));
    const record = records.get(id);
    if (!record || disposed) return;
    const effective = effectiveVisibility(id);
    record.effects?.setSuspended?.(record.manifest.lifecycle.hidden === "suspend" && !effective.visible);
    if (effective.visible) start(record);
    return record.lifecycle.visibilityChanged(effective).catch((error) => report(error, { cardId: id }));
  }

  if (threadsFactory && manifests.some((manifest) => manifest.capabilities.includes("threads"))) {
    try { threads = threadsFactory({ document: shell.host.ownerDocument, onError: (error) => report(error, { phase: "threads" }) }); }
    catch (error) { report(error, { phase: "threads" }); }
  }
  const adapter = adapterFactory({
    host: shell.host, placement: config.placement, hasCards: false, hasSettings,
    onVisibilityChange: visibilityChanged,
    onError: (error) => report(error, { phase: "adapter" })
  });

  function remove(record, reason) {
    records.delete(record.manifest.id);
    const cleanup = record.lifecycle.dispose(reason);
    record.slot.remove();
    // 生命周期释放走独立 RPC，不能被刚刚中止的业务 signal 一起取消。
    let release = Promise.resolve();
    if (record.generation && record.manifest.capabilities.includes("rpc")) {
      release = rpcClient.scoped(record.manifest.id, record.generation).request("lifecycle.dispose", {}, { timeoutMs: 5000 }).promise.catch((error) => {
        if (error.code !== "BRIDGE_UNAVAILABLE") report(error, { cardId: record.manifest.id, phase: "release" });
      });
    }
    return Promise.allSettled([cleanup, release]);
  }

  async function applyConfig(next) {
    if (disposed) return false;
    const normalized = normalizeRuntimeConfig(next, manifests);
    if (normalized.revision !== null && config.revision !== null && normalized.revision < config.revision) return false;
    const keepSettingsOpen = normalized.placement !== config.placement && shell.isSettingsOpen?.();
    config = normalized;
    const cleanups = [];
    for (const [id, record] of records) {
      if (!config.enabled || !config.cards[id]?.enabled) cleanups.push(remove(record, "disabled"));
    }
    for (const manifest of manifests) {
      if (!config.enabled || !config.cards[manifest.id].enabled) continue;
      const record = records.get(manifest.id);
      if (!record) createRecord(manifest);
      else if (JSON.stringify(record.settings) !== JSON.stringify(config.cards[manifest.id].settings)) {
        record.settings = config.cards[manifest.id].settings;
        record.lifecycle.update(record.settings).catch((error) => report(error, { cardId: manifest.id }));
      }
    }
    shell.reorder(config.order);
    shell.setEmptyState?.({ enabled: config.enabled, count: records.size });
    adapter.setPlacement(config.placement);
    adapter.setHasCards(records.size > 0);
    if (keepSettingsOpen) adapter.setOpen(true);
    await Promise.allSettled(cleanups);
    return true;
  }

  async function retry(id) {
    const previous = records.get(id);
    if (!previous || disposed) return;
    remove(previous, "retry");
    createRecord(previous.manifest);
    shell.reorder(config.order);
  }

  function dispose() {
    if (disposal) return disposal;
    disposed = true;
    platformController.abort();
    const jobs = [...records.values()].map((record) => remove(record, "unmounted"));
    adapter.dispose();
    threads?.dispose();
    shell.dispose();
    disposal = Promise.allSettled(jobs).then(() => rpcClient.dispose());
    return disposal;
  }

  void applyConfig(initialConfig);
  return {
    artifactHash, applyConfig, receiveRpc: rpcClient.receiveRpc, retry, dispose, setCardVisibility,
    getCardApi: (id) => records.get(id)?.handle?.api,
    isMounted: () => !disposed,
    isPlaced: () => adapter.isPlaced(),
    getPlacement: () => adapter.getDiagnostics().mode,
    setOpen: (open) => adapter.setOpen(open),
    getConfig: () => config,
    getDiagnostics: () => ({ artifactHash, revision: config.revision, scopeId, disposed,
      adapter: adapter.getDiagnostics(), shell: shell.diagnostics(), rpc: rpcClient.diagnostics(),
      cards: Object.fromEntries([...records].map(([id, record]) => [id, record.lifecycle.diagnostics()])), errors: [...failures] })
  };
}
