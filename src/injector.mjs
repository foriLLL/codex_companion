import { CdpConnection } from "./cdp-connection.mjs";
import { buildInjectionSource, INJECTION_VERSION } from "./injection.mjs";
import { normalizeCardOrder } from "./companion-config.mjs";
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
    this.#config = this.#normalizeConfig({ cards, placement, cardOrder, enabled });
  }

  #normalizeConfig({ cards, placement, cardOrder, enabled } = {}) {
    return {
      enabled: enabled !== false,
      cards: {
        hongguo: cards?.hongguo !== false,
        emby: cards?.emby !== false
      },
      placement: placement === "inline-in-summary" ? "inline-in-summary" : "standalone-button",
      cardOrder: normalizeCardOrder(cardOrder)
    };
  }

  get enabled() {
    return this.#config.enabled;
  }

  get cards() {
    return { ...this.#config.cards };
  }

  get placement() {
    return this.#config.placement;
  }

  get cardOrder() {
    return [...this.#config.cardOrder];
  }

  /**
   * 运行时更新配置（总开关 / 卡片开关 / placement / 顺序）。下一轮扫描会发现
   * cardsKey 不匹配（或总开关已关闭）并自动重注入/卸载，因此这里只需更新期望值。
   */
  setConfig({ cards, placement, cardOrder, enabled } = {}) {
    this.#config = this.#normalizeConfig({
      cards: cards ?? this.#config.cards,
      placement: placement ?? this.#config.placement,
      cardOrder: cardOrder ?? this.#config.cardOrder,
      enabled: enabled ?? this.#config.enabled
    });
  }

  // 挂载身份：注入版本 + placement + 卡片开关 + 卡片顺序。renderer 侧 bridge 暴露
  // 同样的 cardsKey，健康检查据此判断是否需要以新配置重注入。
  #expectedCardsKey() {
    const { cards, placement, cardOrder } = this.#config;
    return `${INJECTION_VERSION}:${placement}:${cards.hongguo ? "1" : "0"}${cards.emby ? "1" : "0"}:${cardOrder.join(",")}`;
  }

  #buildMountSource() {
    return buildInjectionSource("mount", this.#config);
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
        this.#newDocumentScripts.delete(targetId);
        continue;
      }
      // 确保绑定总是已注册（页面重载后绑定会丢失）；cardsKey 变化（配置更新）也会触发重注入
      try {
        const check = await session.connection.send("Runtime.evaluate", {
          expression: `window.__CODEX_COMPANION__?.cardsKey ?? null`,
          returnByValue: true
        });
        if (!this.#config.enabled) {
          // 注入总开关关闭：对已挂载的页面执行 unmount（含 rail/host/bridge），
          // 会话保留——重新打开时经下方 cardsKey 健康检查自动重挂载，无需重启 Codex。
          if (check.result?.value !== null && check.result?.value !== undefined) {
            this.#logger.info(`[codex-companion] 总开关关闭，卸载页面卡片：${targetId}`);
            await this.#apply(session.connection, session.target, "unmount", false);
          }
          continue;
        }
        if (check.result?.value !== this.#expectedCardsKey()) {
          this.#logger.info(`[codex-companion] 重新注入页面：${targetId}`);
          const mountSource = this.#buildMountSource();
          const expression = this.#runtimePrelude
            ? `${this.#runtimePrelude}\n;${mountSource}`
            : mountSource;
          const evaluation = await session.connection.send("Runtime.evaluate", {
            expression,
            awaitPromise: true,
            returnByValue: true,
            userGesture: false
          });
          if (evaluation.exceptionDetails) {
            throw new Error(evaluation.exceptionDetails.exception?.description ?? evaluation.exceptionDetails.text);
          }
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
    const injectionSource = action === "mount"
      ? this.#buildMountSource()
      : buildInjectionSource(action);
    const expression = action === "mount" && this.#runtimePrelude
      ? `${this.#runtimePrelude}\n;${injectionSource}`
      : injectionSource;
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
        // 同一 target 重连/重挂时先撤掉旧注册：否则每次重连都新注册一份，
        // 导航后 mount 脚本会执行 N 遍（脚本本身幂等，但纯浪费）。
        const previousScriptId = this.#newDocumentScripts.get(target.id);
        if (previousScriptId) {
          await connection.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: previousScriptId }).catch(() => {});
          this.#newDocumentScripts.delete(target.id);
        }
        const registered = await connection.send("Page.addScriptToEvaluateOnNewDocument", { source: expression });
        if (registered?.identifier) this.#newDocumentScripts.set(target.id, registered.identifier);
      }

      const evaluation = await connection.send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: false
      });

      if (evaluation.exceptionDetails) {
        const description = evaluation.exceptionDetails.exception?.description
          ?? evaluation.exceptionDetails.text
          ?? "未知 JavaScript 异常";
        throw new Error(description);
      }

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
