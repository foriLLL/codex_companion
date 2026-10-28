import { Console } from "node:console";
import { dirname, join } from "node:path";
import { CARD_MANIFESTS } from "../card-registry.mjs";
import { CompanionConfig } from "../companion-config.mjs";
import { CodexCompanionService } from "../codex-companion-service.mjs";
import { watchCompanionConfig } from "../platform/config/watcher.mjs";
import { PluginMediaTransferStore } from "./media-transfer.mjs";
import { PluginStateStore } from "./state-store.mjs";
import { PluginLauncher } from "./launcher.mjs";
export { PLUGIN_UI_URI } from "./metadata.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_PENDING_PER_VIEW = 64;
const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const fail = (code, message) => Object.assign(new Error(message), { code });
const requestKey = id => `${typeof id}:${String(id)}`;
const validId = id => typeof id === "string" && id.length > 0 && id.length <= 128 || typeof id === "number" && Number.isSafeInteger(id);

// stderr 是插件唯一日志通道；stdout 保留给 MCP JSON-RPC。
export function createPluginLogger() { return new Console({ stdout: process.stderr, stderr: process.stderr }); }

export function sanitizePluginError(error) {
  const code = typeof error?.code === "string" && /^[A-Z][A-Z0-9_.-]{0,63}$/.test(error.code) ? error.code : "RPC_ERROR";
  const message = String(error?.message || "请求失败")
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/((?:x-emby-token|access[_-]?token|api[_-]?key|token)\s*[=:]\s*["']?)[^\s,"'&;]+/gi, "$1[REDACTED]")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").slice(0, 500);
  return { code, message, retryable: error?.retryable === true || code === "RPC_TIMEOUT" };
}

function validateJson(value, depth = 0) {
  if (depth > 32) throw fail("RPC_INVALID_REQUEST", "请求嵌套过深");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (!isRecord(value) && !Array.isArray(value)) throw fail("RPC_INVALID_REQUEST", "请求必须是 JSON 数据");
  if (isRecord(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw fail("RPC_INVALID_REQUEST", "请求对象无效");
  for (const [key, child] of Object.entries(value)) {
    if (["__proto__", "constructor", "prototype"].includes(key)) throw fail("RPC_INVALID_REQUEST", "请求包含无效字段");
    validateJson(child, depth + 1);
  }
}

function validateObject(value, keys) {
  if (!isRecord(value) || Object.keys(value).some(key => !keys.includes(key))) throw fail("RPC_INVALID_REQUEST", "请求字段无效");
  validateJson(value);
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_REQUEST_BYTES) throw fail("RPC_INVALID_REQUEST", "请求超过大小限制");
}

function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? fail("RPC_CANCELLED", "请求已取消"));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export class CompanionPluginBackend {
  constructor({
    configStore = new CompanionConfig(), service, stateStore, launcher, transfers = new PluginMediaTransferStore(),
    manifests = CARD_MANIFESTS, logger = createPluginLogger(), viewTtlMs = 120_000,
    requestTimeoutMs = 70_000, maxViews = 128, now = Date.now
  } = {}) {
    this.configStore = configStore;
    this.service = service ?? new CodexCompanionService({ configStore, logger });
    this.stateStore = stateStore ?? new PluginStateStore({ path: join(dirname(configStore.path), "plugin-state.json") });
    this.launcherService = launcher ?? new PluginLauncher({ configPath: configStore.path });
    this.transfers = transfers;
    this.manifests = manifests;
    this.cardIds = new Set(manifests.map(card => card.id));
    this.views = new Map();
    this.logger = logger;
    this.viewTtlMs = viewTtlMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.maxViews = maxViews;
    this.now = now;
    this.closed = false;
    this.watcher = null;
    this.sweepTimer = setInterval(() => { void this.sweepViews().catch(error => this.report(error)); }, Math.min(viewTtlMs, 30_000));
    this.sweepTimer.unref?.();
  }

  report(error) { try { this.logger.warn?.(`[codex-companion-plugin] ${sanitizePluginError(error).code}`); } catch {} }

  async start({ watchConfig = true } = {}) {
    const config = await this.configStore.loadV2({ strict: true });
    await this.service.applyConfig(config);
    if (watchConfig && !this.watcher) this.watcher = await watchCompanionConfig({
      config: this.configStore, onChange: next => this.service.applyConfig(next), onError: error => this.report(error)
    });
    return this;
  }

  assertOpen() { if (this.closed) throw fail("RPC_UNAVAILABLE", "插件后台已关闭"); }

  viewFor(viewId) {
    this.assertOpen();
    if (typeof viewId !== "string" || !UUID.test(viewId)) throw fail("RPC_INVALID_REQUEST", "页面标识无效");
    let view = this.views.get(viewId);
    if (view?.closed) throw fail("RPC_VIEW_CLOSED", "页面已关闭，请重新打开");
    if (!view) {
      if (this.views.size >= this.maxViews) throw fail("RPC_BUSY", "打开的页面过多，请关闭闲置页面");
      view = { id: viewId, lastSeen: this.now(), closed: false, generations: new Map(), pending: new Map(), transferOwners: new Set(), disposing: null };
      this.views.set(viewId, view);
    }
    view.lastSeen = this.now();
    return view;
  }

  async closeView(view) {
    if (view.disposing) return view.disposing;
    view.closed = true;
    for (const pending of view.pending.values()) pending.controller.abort(fail("RPC_CANCELLED", "页面已关闭"));
    for (const owner of view.transferOwners) this.transfers.releaseOwner(owner);
    view.transferOwners.clear();
    view.disposing = Promise.resolve().then(() => this.service.disposeTarget(`plugin:${view.id}`));
    return view.disposing;
  }

  async sweepViews() {
    const stale = [...this.views.values()].filter(view => this.now() - view.lastSeen >= this.viewTtlMs);
    const results = await Promise.allSettled(stale.map(async view => {
      try { await this.closeView(view); }
      finally { if (this.views.get(view.id) === view) this.views.delete(view.id); }
    }));
    for (const result of results) if (result.status === "rejected") this.report(result.reason);
  }

  acceptGeneration(view, request) {
    const previous = view.generations.get(request.cardId);
    if (previous !== undefined && request.generation < previous) throw fail("RPC_STALE_GENERATION", "卡片实例已过期");
    if (["rpc.cancel", "transfer.read", "transfer.close"].includes(request.method)) return;
    if (previous !== undefined && request.generation > previous) {
      const owner = this.transferOwner(view, { cardId: request.cardId, generation: previous });
      this.transfers.releaseOwner(owner);
      view.transferOwners.delete(owner);
    }
    view.generations.set(request.cardId, request.generation);
    const disposing = request.method === `${request.cardId}.lifecycle.dispose`;
    if (disposing) {
      const owner = this.transferOwner(view, request);
      this.transfers.releaseOwner(owner);
      view.transferOwners.delete(owner);
    }
    for (const pending of view.pending.values()) {
      if (pending.cardId === request.cardId && (pending.generation < request.generation || disposing && pending.generation === request.generation)) {
        pending.controller.abort(fail("RPC_CANCELLED", "卡片实例已替换或关闭"));
      }
    }
  }

  transferOwner(view, request) { return JSON.stringify([view.id, request.cardId, request.generation]); }

  async rpc(request, { signal } = {}) {
    const responseId = validId(request?.id) ? request.id : null;
    try {
      validateObject(request, ["viewId", "id", "method", "params", "cardId", "generation"]);
      if (!validId(request.id) || typeof request.method !== "string" || request.method.length > 128
        || !isRecord(request.params ?? {}) || !this.cardIds.has(request.cardId)
        || !Number.isSafeInteger(request.generation) || request.generation < 0) throw fail("RPC_INVALID_REQUEST", "RPC 参数无效");
      const internal = ["rpc.cancel", "transfer.read", "transfer.close"].includes(request.method);
      if (!internal && (!request.method.startsWith(`${request.cardId}.`) || !this.service.registry.routes.has(request.method))) {
        throw fail("RPC_METHOD_NOT_FOUND", "未知或不属于当前卡片的方法");
      }
      const view = this.viewFor(request.viewId);
      this.acceptGeneration(view, request);
      const params = request.params ?? {};
      const owner = this.transferOwner(view, request);
      if (request.method === "rpc.cancel") {
        if (!validId(params.requestId) || Object.keys(params).some(key => key !== "requestId")) throw fail("RPC_INVALID_REQUEST", "取消请求参数无效");
        const pending = view.pending.get(requestKey(params.requestId));
        const cancelled = pending?.cardId === request.cardId && pending.generation === request.generation && !pending.controller.signal.aborted;
        if (cancelled) pending.controller.abort(fail("RPC_CANCELLED", "请求已取消"));
        this.transfers.releaseRequest(params.requestId, { owner });
        return { id: request.id, ok: true, result: { cancelled: Boolean(cancelled) } };
      }
      if (request.method === "transfer.read" || request.method === "transfer.close") {
        const result = request.method === "transfer.read" ? this.transfers.read(params, { owner }) : this.transfers.close(params, { owner });
        return { id: request.id, ok: true, result };
      }
      const key = requestKey(request.id);
      if (view.pending.has(key)) throw fail("RPC_DUPLICATE_REQUEST", "RPC 请求 id 重复");
      if (view.pending.size >= MAX_PENDING_PER_VIEW) throw fail("RPC_BUSY", "同时执行的请求过多");
      const controller = new AbortController();
      const entry = { controller, cardId: request.cardId, generation: request.generation };
      const combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
      const deadline = setTimeout(() => controller.abort(fail("RPC_TIMEOUT", "请求超时，请重试")), this.requestTimeoutMs);
      view.pending.set(key, entry);
      try {
        const result = await abortable(Promise.resolve().then(() => this.service.handleRpc(request.method, params, {
          signal: combined, requestId: request.id, targetId: `plugin:${view.id}`, executionContextId: "mcp-app",
          cardId: request.cardId, generation: request.generation, transport: "mcp", mediaTransport: "rpc"
        })), combined);
        if (view.closed || combined.aborted) throw combined.reason ?? fail("RPC_CANCELLED", "页面已关闭");
        view.transferOwners.add(owner);
        return { id: request.id, ok: true, result: this.transfers.pack(result ?? null, { owner, requestId: request.id }) };
      } finally {
        clearTimeout(deadline);
        if (view.pending.get(key) === entry) view.pending.delete(key);
      }
    } catch (error) { return { id: responseId, ok: false, error: sanitizePluginError(error) }; }
  }

  async config(request) {
    this.assertOpen();
    validateObject(request, ["operation", "knownRevision", "expectedRevision", "patch"]);
    if (request.operation === "get") {
      if (own(request, "patch") || own(request, "expectedRevision") || own(request, "knownRevision") && (!Number.isSafeInteger(request.knownRevision) || request.knownRevision < 0)) throw fail("RPC_INVALID_REQUEST", "配置读取参数无效");
      const config = await this.configStore.loadV2({ strict: true });
      await this.service.applyConfig(config);
      const unchanged = config.revision === request.knownRevision;
      return { config: unchanged ? null : config, unchanged, manifests: this.manifests };
    }
    if (request.operation !== "update" || own(request, "knownRevision") || !isRecord(request.patch)
      || !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0) throw fail("RPC_INVALID_REQUEST", "配置更新参数无效");
    const patch = request.patch;
    if (Object.keys(patch).some(key => !["enabled", "placement", "order", "cards"].includes(key))) throw fail("CONFIG_PATCH_INVALID", "配置字段无效");
    if (own(patch, "cards") && (!isRecord(patch.cards) || Object.keys(patch.cards).some(id => !this.cardIds.has(id)))) throw fail("CONFIG_PATCH_INVALID", "卡片名称无效");
    if (own(patch, "order") && (!Array.isArray(patch.order) || patch.order.some(id => !this.cardIds.has(id)))) throw fail("CONFIG_PATCH_INVALID", "卡片顺序无效");
    const config = await this.configStore.patch(patch, { expectedRevision: request.expectedRevision });
    await this.service.applyConfig(config);
    return { config, unchanged: false, manifests: this.manifests };
  }

  async state(request) {
    this.assertOpen();
    validateObject(request, ["operation", "key", "value", "expectedRevision"]);
    if (request.operation === "get" && !own(request, "value") && !own(request, "expectedRevision")) return this.stateStore.get(request.key);
    if (request.operation === "set" && own(request, "value")) return this.stateStore.set(request.key, request.value,
      own(request, "expectedRevision") ? { expectedRevision: request.expectedRevision } : {});
    throw fail("RPC_INVALID_REQUEST", "存档请求参数无效");
  }

  async launcher(request) {
    this.assertOpen();
    validateObject(request, ["operation", "preferences", "expectedRevision"]);
    if (request.operation === "save") {
      if (own(request, "expectedRevision") && (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0)) throw fail("LAUNCHER_INVALID", "启动偏好版本无效");
      return this.launcherService.save(request.preferences, own(request, "expectedRevision") ? { expectedRevision: request.expectedRevision } : {});
    }
    if (own(request, "preferences") || own(request, "expectedRevision")) throw fail("LAUNCHER_INVALID", "启动请求字段无效");
    if (request.operation === "get") return this.launcherService.status();
    if (["relaunch", "stop"].includes(request.operation)) return this.launcherService.schedule(request.operation);
    throw fail("LAUNCHER_INVALID", "启动操作无效");
  }

  async view(request) {
    validateObject(request, ["operation", "viewId"]);
    if (!["heartbeat", "dispose"].includes(request.operation)) throw fail("RPC_INVALID_REQUEST", "页面操作无效");
    if (request.operation === "dispose" && typeof request.viewId === "string" && UUID.test(request.viewId)) {
      const view = this.views.get(request.viewId);
      if (view) await this.closeView(view);
      return { ok: true, disposed: true };
    }
    this.viewFor(request.viewId);
    return { ok: true, expiresInMs: this.viewTtlMs };
  }

  async dispose() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.sweepTimer);
    const results = await Promise.allSettled([
      this.watcher?.close(),
      ...[...this.views.values()].map(view => this.closeView(view))
    ]);
    this.views.clear();
    this.transfers.dispose();
    await this.service.dispose();
    for (const result of results) if (result.status === "rejected") this.report(result.reason);
  }
}
