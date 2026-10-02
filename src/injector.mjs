import { CdpConnection } from "./cdp-connection.mjs";
import { buildInjectionSource, buildConfigUpdateSource, ARTIFACT_HASH, BRIDGE_KEY } from "./injection.mjs";
import { CARD_MANIFESTS } from "./card-registry.mjs";
import { normalizeRuntimeConfig } from "./platform/config/runtime-config.mjs";
import { CdpRpcBridge, DEFAULT_RPC_TIMEOUT_MS } from "./rpc-bridge.mjs";
import { filterCodexTargets, isCodexAppTarget, listCdpTargets, waitForCodexTargets } from "./targets.mjs";

export class CodexInjector {
  #port;
  #sessions = new Map();
  #scanTimer = null;
  #cleanedAuxiliaryTargets = new Set();
  #newDocumentScripts = new Map();
  #logger;
  #rpcHandler;
  #rpcTimeoutMs;
  #runtimePrelude;
  #scanning = null;
  #stopped = false;
  #config;

  constructor(port, {
    logger = console,
    rpcHandler,
    embyService,
    rpcTimeoutMs = DEFAULT_RPC_TIMEOUT_MS,
    runtimePrelude = "",
    cards,
    placement,
    cardOrder,
    order,
    revision,
    config,
    enabled
  } = {}) {
    if (rpcHandler !== undefined && embyService !== undefined && rpcHandler !== embyService) {
      throw new TypeError("rpcHandler 和 embyService 不能同时配置");
    }
    this.#port = port;
    this.#logger = logger;
    this.#rpcHandler = rpcHandler ?? embyService;
    this.#rpcTimeoutMs = rpcTimeoutMs;
    if (typeof runtimePrelude !== "string") {
      throw new TypeError("runtimePrelude 必须是字符串");
    }
    this.#runtimePrelude = runtimePrelude;
    this.#config = normalizeRuntimeConfig(config ?? { cards, placement, cardOrder, order, revision, enabled }, CARD_MANIFESTS);
  }

  get enabled() {
    return this.#config.enabled;
  }

  get cards() {
    return Object.fromEntries(Object.entries(this.#config.cards).map(([id, value]) => [id, value.enabled]));
  }

  get placement() {
    return this.#config.placement;
  }

  get cardOrder() {
    return [...this.#config.order];
  }

  get config() {
    return normalizeRuntimeConfig(this.#config, CARD_MANIFESTS);
  }

  // 配置身份与构建身份独立：下一次扫描仅对当前 runtime 调用 applyConfig。
  setConfig({ config, cards, placement, cardOrder, order, revision, enabled } = {}) {
    const mergedCards = Object.assign(Object.create(null), this.#config.cards);
    if (cards && typeof cards === "object" && !Array.isArray(cards)) {
      for (const [id, value] of Object.entries(cards)) {
        mergedCards[id] = typeof value === "boolean"
          ? { ...mergedCards[id], enabled: value }
          : { ...mergedCards[id], ...value };
      }
    }
    const next = normalizeRuntimeConfig(config ?? {
      cards: mergedCards,
      placement: placement ?? this.#config.placement,
      order: order ?? cardOrder ?? this.#config.order,
      revision: revision ?? this.#config.revision,
      enabled: enabled ?? this.#config.enabled,
    }, CARD_MANIFESTS);
    if (next.revision !== null && this.#config.revision !== null && next.revision < this.#config.revision) return false;
    this.#config = next;
    return true;
  }

  #buildMountSource(config = this.#config) {
    const source = buildInjectionSource("mount", { config });
    return this.#runtimePrelude ? `${this.#runtimePrelude}\n;${source}` : source;
  }

  async #registerNewDocument(connection, target, config, force = false) {
    const configKey = JSON.stringify(config);
    const previous = this.#newDocumentScripts.get(target.id);
    if (!force && previous?.configKey === configKey) return;
    if (previous?.identifier) {
      // CDP 重连后旧注册可能已被浏览器撤销，允许此时重新登记。
      await connection.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: previous.identifier }).catch(() => {});
      this.#newDocumentScripts.delete(target.id);
    }
    // 仅替换导航脚本注册；当前文档不会执行 bundle。
    const registered = await connection.send("Page.addScriptToEvaluateOnNewDocument", { source: this.#buildMountSource(config) });
    if (registered?.identifier) this.#newDocumentScripts.set(target.id, { identifier: registered.identifier, configKey });
  }

  async #evaluate(connection, expression) {
    const evaluation = await connection.send("Runtime.evaluate", {
      expression, awaitPromise: true, returnByValue: true, userGesture: false,
    });
    if (evaluation.exceptionDetails) {
      throw new Error(evaluation.exceptionDetails.exception?.description ?? evaluation.exceptionDetails.text ?? "未知 JavaScript 异常");
    }
    return evaluation;
  }

  async injectOnce(action = "mount") {
    const targets = await waitForCodexTargets(this.#port);
    await this.#cleanupAuxiliaryTargets(await listCdpTargets(this.#port));
    const results = [];

    for (const target of targets) {
      const connection = new CdpConnection(target.webSocketDebuggerUrl);
      let rpcBridge;
      try {
        await connection.connect();
        const applied = await this.#apply(connection, target, action, false);
        rpcBridge = applied.rpcBridge;
        results.push(applied.result);
      } finally {
        rpcBridge?.detach();
        connection.close();
      }
    }
    return results;
  }

  async start() {
    this.#stopped = false;
    await waitForCodexTargets(this.#port);
    await this.#runScan();
    // 注意：不要 unref 这个定时器——它是常驻进程保持事件循环存活的关键。
    this.#scanTimer = setInterval(() => {
      this.#runScan().catch((error) => this.#logger.warn(`[codex-companion] 扫描失败：${error.message}`));
    }, 1_500);
  }

  stop() {
    this.#stopped = true;
    if (this.#scanTimer) clearInterval(this.#scanTimer);
    this.#scanTimer = null;
    for (const { connection, rpcBridge } of this.#sessions.values()) {
      rpcBridge?.detach();
      connection.close();
    }
    this.#sessions.clear();
    this.#cleanedAuxiliaryTargets.clear();
    this.#newDocumentScripts.clear();
  }

  // 串行化扫描：单次扫描可能因为多次 CDP 往返而超过 1.5s 的间隔，
  // 若不加锁，重叠扫描会重复注入并泄漏 WebSocket 连接与 RPC bridge。
  #runScan() {
    if (this.#scanning) return this.#scanning;
    this.#scanning = (async () => {
      if (this.#stopped) return;
      await this.#scan();
    })().finally(() => {
      this.#scanning = null;
    });
    return this.#scanning;
  }

  // 立即触发一次（串行化的）扫描，主要用于测试与手动强制刷新。
  scanNow() {
    return this.#runScan();
  }

  async #scan() {
    const allTargets = await listCdpTargets(this.#port);
    await this.#cleanupAuxiliaryTargets(allTargets);
    const targets = filterCodexTargets(allTargets);
    const liveIds = new Set(targets.map((target) => target.id));

    for (const [targetId, session] of this.#sessions) {
      if (!liveIds.has(targetId) || !session.connection.isOpen) {
        session.rpcBridge?.detach();
        session.connection.close();
        this.#sessions.delete(targetId);
        if (!liveIds.has(targetId)) this.#newDocumentScripts.delete(targetId);
        continue;
      }
      try {
        const config = this.#config;
        const check = await this.#evaluate(session.connection, `(() => {
          const bridge = globalThis[${JSON.stringify(BRIDGE_KEY)}];
          return { artifactHash: bridge?.artifactHash ?? null,
            mounted: bridge?.runtime?.isMounted?.() === true,
            config: bridge?.runtime?.getConfig?.() ?? null };
        })()`);
        if (this.#stopped) return;
        await this.#registerNewDocument(session.connection, session.target, config);
        if (this.#stopped) return;
        const health = check.result?.value;
        if (health?.artifactHash === ARTIFACT_HASH && health?.mounted === true) {
          // 页面可能刚执行了旧导航脚本；不能仅相信 Node 侧上次推送的配置。
          if (JSON.stringify(health.config) !== JSON.stringify(config)) {
            await this.#evaluate(session.connection, buildConfigUpdateSource(config));
          }
        } else {
          this.#logger.info(`[codex-companion] 重新注入页面：${targetId}`);
          await this.#evaluate(session.connection, this.#buildMountSource(config));
        }
      } catch (error) {
        // 健康检查失败通常意味着这条连接已经不可用；记录下来便于诊断“卡片在但按钮无响应”，
        // 下一轮扫描会通过 isOpen 检查回收并重建会话。
        this.#logger.debug?.(`[codex-companion] 会话健康检查失败 ${targetId}：${error.message}`);
      }
    }

    for (const target of targets) {
      // 总开关关闭时不挂载新页面（已有页面的卸载在上面的会话循环里处理）。
      if (!this.#config.enabled) break;
      if (this.#sessions.has(target.id)) continue;

      const connection = new CdpConnection(target.webSocketDebuggerUrl);
      try {
        await connection.connect();
        // stop() 可能在本次 connect() 期间被调用；此时不要把新会话登记进来，
        // 否则会泄漏一个永不关闭的 WebSocket 并让进程无法退出。
        if (this.#stopped || this.#sessions.has(target.id)) {
          connection.close();
          continue;
        }
        const { result, rpcBridge } = await this.#apply(connection, target, "mount", true);
        if (this.#stopped) {
          rpcBridge?.detach();
          connection.close();
          return;
        }
        this.#sessions.set(target.id, { connection, target, rpcBridge });
        this.#logger.info(`[codex-companion] 已注入 ${target.title || target.url}：${result.status}`);
      } catch (error) {
        connection.close();
        this.#logger.warn(`[codex-companion] 注入 target ${target.id} 失败：${error.message}`);
      }
    }
  }

  async #cleanupAuxiliaryTargets(allTargets) {
    const mainIds = new Set(filterCodexTargets(allTargets).map((target) => target.id));
    const liveIds = new Set(allTargets.map((target) => target.id));
    for (const targetId of this.#cleanedAuxiliaryTargets) {
      if (!liveIds.has(targetId)) this.#cleanedAuxiliaryTargets.delete(targetId);
    }

    const auxiliaryTargets = allTargets.filter((target) => {
      return isCodexAppTarget(target)
        && !mainIds.has(target.id)
        && !this.#cleanedAuxiliaryTargets.has(target.id);
    });

    for (const target of auxiliaryTargets) {
      const connection = new CdpConnection(target.webSocketDebuggerUrl);
      try {
        await connection.connect();
        await connection.send("Runtime.evaluate", {
          expression: buildInjectionSource("unmount"),
          returnByValue: false
        });
        this.#cleanedAuxiliaryTargets.add(target.id);
      } catch (error) {
        this.#logger.warn(`[codex-companion] 清理辅助 renderer ${target.id} 失败：${error.message}`);
      } finally {
        connection.close();
      }
    }
  }

  async #apply(connection, target, action, installOnNewDocument) {
    const config = this.#config;
    const expression = action === "mount" ? this.#buildMountSource(config) : buildInjectionSource(action);
    await connection.send("Page.enable");
    await connection.send("Runtime.enable");

    let rpcBridge;
    if (action === "mount") {
      rpcBridge = new CdpRpcBridge(connection, {
        handler: this.#rpcHandler,
        targetId: target.id,
        logger: this.#logger,
        timeoutMs: this.#rpcTimeoutMs
      });
      await rpcBridge.attach();
    }

    try {
      if (installOnNewDocument && action === "mount") {
        await this.#registerNewDocument(connection, target, config, true);
      }
      const evaluation = await this.#evaluate(connection, expression);

      return {
        rpcBridge,
        result: {
          targetId: target.id,
          title: target.title,
          url: target.url,
          ...(evaluation.result?.value ?? { status: action })
        }
      };
    } catch (error) {
      rpcBridge?.detach();
      throw error;
    }
  }

}
