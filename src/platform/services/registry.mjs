import { CARD_MANIFESTS } from "../../card-registry.mjs";
import { SERVICE_REGISTRY } from "../../cards/service-registry.generated.mjs";

import { rpcError } from "./errors.mjs";

// 方法只能由可信构建目录中的 service entry 声明，不能由配置或 RPC 提供模块路径。
export class ServiceRegistry {
  constructor({ modules = SERVICE_REGISTRY, manifests = CARD_MANIFESTS, dependencies = {}, loadConfig, logger = console } = {}) {
    this.services = new Map();
    this.routes = new Map();
    this.scopes = new Map();
    this.loadConfig = loadConfig;
    this.logger = logger;
    this.closed = false;
    for (const manifest of manifests) {
      const module = modules[manifest.id];
      if (module && typeof module.createService !== "function") throw new TypeError(`卡片 ${manifest.id} 缺少 createService`);
      let service = {};
      let initializationError;
      try { service = module?.createService(dependencies) ?? {}; }
      catch (error) {
        initializationError = error;
        Promise.resolve().then(() => logger.warn?.(`[codex-companion] 卡片 ${manifest.id} 服务初始化失败`)).catch(() => {});
      }
      const entry = { id: manifest.id, service, initializationError, defaultEnabled: manifest.defaultEnabled };
      this.services.set(entry.id, entry);
      for (const [operation, handler] of Object.entries(service.methods ?? {})) {
        if (typeof handler !== "function" || !/^[a-z][a-zA-Z0-9]*(?:\.[a-z][a-zA-Z0-9]*)*$/.test(operation) || operation === "lifecycle.dispose") {
          throw new TypeError(`卡片 ${entry.id} 方法声明无效：${operation}`);
        }
        this.addRoute(`${entry.id}.${operation}`, { entry, operation, handler, cleanup: service.cleanupMethods?.includes(operation) === true });
      }
      for (const [alias, operation] of Object.entries(service.aliases ?? {})) {
        const route = this.routes.get(`${entry.id}.${operation}`);
        if (!route) throw new TypeError(`卡片 ${entry.id} 别名目标不存在：${operation}`);
        this.addRoute(alias, route);
      }
      this.addRoute(`${entry.id}.lifecycle.dispose`, { entry, operation: "lifecycle.dispose", cleanup: true });
    }
  }

  addRoute(method, route) {
    if (this.routes.has(method)) throw new TypeError(`重复 RPC 方法：${method}`);
    this.routes.set(method, route);
  }

  report(error) {
    Promise.resolve().then(() => this.logger.warn?.(`[codex-companion] 卡片会话清理失败：${error?.code ?? "RPC_ERROR"}`)).catch(() => {});
  }

  scopeFor(entry, context) {
    const modern = context.cardId !== undefined || context.generation !== undefined;
    if (modern && (context.cardId !== entry.id || !Number.isSafeInteger(context.generation) || context.generation < 0)) {
      throw rpcError("RPC_INVALID_REQUEST", "卡片命名空间或 generation 无效");
    }
    const key = JSON.stringify([context.targetId ?? null, context.executionContextId ?? null, entry.id]);
    let scope = this.scopes.get(key);
    const generation = modern ? context.generation : null;
    if (scope && (generation === null ? scope.generation !== null : scope.generation !== null && generation < scope.generation)) {
      throw rpcError("RPC_STALE_GENERATION", "卡片实例已过期");
    }
    if (!scope || scope.generation !== generation) {
      if (scope) { this.retire(scope); void this.cleanupScope(scope).catch(error => this.report(error)); }
      scope = {
        key, entry, generation, targetId: context.targetId, executionContextId: context.executionContextId,
        targetKey: !modern && context.executionContextId === undefined ? context.targetId
          : JSON.stringify(["companion", context.targetId ?? null, context.executionContextId ?? null, entry.id, generation]),
        controller: new AbortController(), disposed: false, cleaning: null, cleanupRequested: false
      };
      this.scopes.set(key, scope);
    }
    return scope;
  }

  retire(scope) {
    scope.disposed = true;
    scope.controller.abort(rpcError("RPC_CANCELLED", "卡片实例已关闭"));
  }

  cleanupScope(scope) {
    scope.cleanupRequested = true;
    if (scope.cleaning) return scope.cleaning;
    scope.cleaning = (async () => {
      // 旧 RPC 可能在清理尚未结束时才创建资源；不能只复用已经取过会话快照的清理。
      while (scope.cleanupRequested) {
        scope.cleanupRequested = false;
        await Promise.resolve().then(() => scope.entry.service.disposeTarget?.(scope.targetKey));
      }
    })().finally(() => { scope.cleaning = null; });
    return scope.cleaning;
  }

  async handleRpc(method, params = {}, context = {}) {
    const route = this.routes.get(method);
    if (!route) {
      if (this.services.get(method.split(".")[0])?.initializationError) {
        throw rpcError("CARD_SERVICE_UNAVAILABLE", "该卡片的后台服务初始化失败，请重启 Companion 后重试");
      }
      throw rpcError("RPC_METHOD_NOT_FOUND", "未知 RPC 方法");
    }
    if (this.closed) throw rpcError("RPC_UNAVAILABLE", "卡片服务已关闭");
    if (context.cardId !== undefined && !method.startsWith(`${context.cardId}.`)) throw rpcError("RPC_INVALID_REQUEST", "RPC 方法与卡片命名空间不匹配");
    const scope = this.scopeFor(route.entry, context);
    if (route.operation === "lifecycle.dispose") {
      this.retire(scope);
      await this.cleanupScope(scope);
      return { disposed: true };
    }
    if (scope.disposed && !route.cleanup) throw rpcError("RPC_STALE_GENERATION", "卡片实例已关闭");
    const signal = route.cleanup ? (context.signal ?? new AbortController().signal)
      : context.signal ? AbortSignal.any([scope.controller.signal, context.signal]) : scope.controller.signal;
    if (signal.aborted) throw signal.reason;
    if (!route.cleanup) {
      const config = await this.loadConfig?.();
      if (signal.aborted) throw signal.reason;
      const setting = config?.cards?.[route.entry.id];
      const enabled = typeof setting === "boolean" ? setting : setting?.enabled ?? route.entry.defaultEnabled;
      if (config?.enabled === false || enabled === false) {
        await this.disposeCard(route.entry.id);
        throw rpcError("CARD_DISABLED", "卡片已关闭");
      }
    }
    try {
      const result = await route.handler(params, { ...context, cardId: route.entry.id, targetId: scope.targetKey, signal });
      if (signal.aborted) throw signal.reason;
      return result;
    } finally {
      // 不遵守 abort 的后端可能迟到创建会话；再次清理旧 scope，不影响新 generation。
      if (scope.disposed) await this.cleanupScope(scope);
    }
  }

  async cleanScopes(scopes) {
    for (const scope of scopes) this.retire(scope);
    const results = await Promise.allSettled(scopes.map(scope => Promise.resolve().then(() => this.cleanupScope(scope))));
    const failure = results.find(result => result.status === "rejected");
    if (failure) throw failure.reason;
  }

  async applyConfig(config) {
    const disabled = [...this.scopes.values()].filter(scope => config.enabled === false || config.cards?.[scope.entry.id]?.enabled === false || config.cards?.[scope.entry.id] === false);
    await this.cleanScopes(disabled);
  }

  async disposeCard(cardId) {
    await this.cleanScopes([...this.scopes.values()].filter(scope => scope.entry.id === cardId));
  }

  async disposeContext(targetId, executionContextId) {
    const scopes = [...this.scopes.values()].filter(scope => scope.targetId === targetId && scope.executionContextId === executionContextId);
    await this.cleanScopes(scopes);
    for (const scope of scopes) if (this.scopes.get(scope.key) === scope) this.scopes.delete(scope.key);
  }

  async disposeTarget(targetId) {
    const scopes = [...this.scopes.values()].filter(scope => scope.targetId === targetId);
    for (const scope of scopes) this.retire(scope);
    const operations = scopes.map(scope => () => this.cleanupScope(scope));
    // 兼容在注册表启用前创建的旧会话；不能让一个同步 throw 阻止其他卡清理。
    for (const { service } of this.services.values()) operations.push(() => service.disposeTarget?.(targetId));
    const results = await Promise.allSettled(operations.map(operation => Promise.resolve().then(operation)));
    for (const scope of scopes) if (this.scopes.get(scope.key) === scope) this.scopes.delete(scope.key);
    const failure = results.find(result => result.status === "rejected");
    if (failure) throw failure.reason;
  }

  async dispose() {
    this.closed = true;
    for (const scope of this.scopes.values()) this.retire(scope);
    const results = await Promise.allSettled([...this.services.values()].map(({ service }) => Promise.resolve().then(() => service.dispose?.())));
    const failure = results.find(result => result.status === "rejected");
    if (failure) throw failure.reason;
  }
}
