import { CodexCompanionService } from "../codex-companion-service.mjs";
import { CodexInjector } from "../injector.mjs";
import { CompanionConfig } from "../companion-config.mjs";
import { DEFAULT_CODEX_EXECUTABLE, detectCodexProxy } from "../launcher.mjs";

export async function createEmbyRuntime(port, {
  InjectorClass = CodexInjector,
  loadRuntimeSource = async () => "",
  configStore = new CompanionConfig(),
  executable = DEFAULT_CODEX_EXECUTABLE,
  platform,
  serviceFactory = ({ logger, configStore, platform }) => new CodexCompanionService({
    logger, configStore, platform,
    inspectCodexProxy: () => detectCodexProxy({ executable, cdpPort: port })
  }),
  loadConfig = () => configStore.loadV2(),
  logger = console
} = {}) {
  const [runtimePrelude, config] = await Promise.all([loadRuntimeSource(), loadConfig()]);
  const service = serviceFactory({ logger, configStore, platform });
  const injector = new InjectorClass(port, {
    rpcHandler: service,
    runtimePrelude,
    config,
    cards: config.cards,
    placement: config.placement,
    cardOrder: config.cardOrder,
    enabled: config.enabled,
    logger
  });
  return { injector, service, embyService: service, runtimePrelude, config };
}

export function createRuntimeShutdown({
  injector,
  embyService,
  logger = console,
  processRef = process
}) {
  let shutdownPromise = null;
  return function shutdown(signal = "shutdown") {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      let failure = null;
      try {
        await embyService.dispose();
      } catch (error) {
        failure = error;
      }

      try {
        injector.stop();
      } catch (error) {
        failure ??= error;
      }

      if (failure) {
        const code = typeof failure.code === "string" && /^[A-Z][A-Z0-9_]*$/.test(failure.code)
          ? `（${failure.code}）`
          : "";
        logger.error(`[codex-companion] 停止媒体会话失败${code}`);
        processRef.exitCode = 1;
      } else if (signal) {
        logger.info(`[codex-companion] 已停止维护（${signal}）`);
      }
    })();
    return shutdownPromise;
  };
}

// 会话拥有 injector / service 的生命周期；配置监听与进程退出由调用方管理。
export function createCodexSession({
  port, configStore = new CompanionConfig(), executable = DEFAULT_CODEX_EXECUTABLE,
  logger = console, platform, initialConfig, runtimeFactory = createEmbyRuntime,
  processRef = process, ...runtimeOptions
} = {}) {
  const abort = new AbortController();
  let runtime;
  let latestConfig = initialConfig;
  let starting;
  let stopping;
  let stopped = false;
  let started = false;
  let applying = Promise.resolve();
  const shutdown = () => runtime && (runtime.shutdown ??= createRuntimeShutdown({
    injector: runtime.injector, embyService: runtime.embyService ?? runtime.service, logger, processRef
  }));

  function applyConfig(next) {
    latestConfig = next;
    if (!runtime || stopped) return Promise.resolve();
    const operation = applying.then(async () => {
      if (stopped) return;
      try { await (runtime.service ?? runtime.embyService).applyConfig(next); }
      finally { if (!stopped) runtime.injector.setConfig({ config: next }); }
    });
    applying = operation.catch(() => {});
    return operation;
  }

  function start() {
    if (starting) return starting;
    if (stopped) return Promise.reject(new Error("会话已停止"));
    starting = (async () => {
      try {
        runtime = await runtimeFactory(port, {
          ...runtimeOptions, configStore, executable, logger, platform,
          ...(latestConfig ? { loadConfig: async () => latestConfig } : {})
        });
        abort.signal.throwIfAborted();
        if (latestConfig) await applyConfig(latestConfig);
        abort.signal.throwIfAborted();
        await runtime.injector.start({ signal: abort.signal });
        abort.signal.throwIfAborted();
        started = true;
      } catch (error) {
        await applying;
        await shutdown()?.(null);
        throw error;
      }
    })();
    return starting;
  }

  function stop(reason = "detach") {
    if (stopping) return stopping;
    stopped = true;
    abort.abort();
    // 启动中立刻关闭连接；start 的取消检查防止稍后恢复扫描定时器。
    if (runtime && !started) runtime.injector.stop();
    stopping = (async () => {
      await starting?.catch(() => {});
      await applying;
      await shutdown()?.(reason);
    })();
    return stopping;
  }

  return { start, stop, applyConfig };
}
