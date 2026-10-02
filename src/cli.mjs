#!/usr/bin/env node

import { access } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { CodexCompanionService } from "./codex-companion-service.mjs";
import { CodexInjector } from "./injector.mjs";
import {
  DEFAULT_CODEX_EXECUTABLE,
  findRunningCodex,
  launchCodex,
  reserveLoopbackPort
} from "./launcher.mjs";
import { listCdpTargets } from "./targets.mjs";
import { RuntimeState, pidIsAlive } from "./runtime-state.mjs";
import { CARD_MANIFESTS } from "./card-registry.mjs";
import { watchCompanionConfig } from "./platform/config/watcher.mjs";
import { CompanionConfig } from "./companion-config.mjs";
import { startCodexWatchdog } from "./daemon.mjs";

function printHelp() {
  console.log(`
Codex Companion — CDP DOM 注入器

用法：
  node src/cli.mjs launch [--port <CDP端口>] [--proxy-port <代理端口>] [--app <可执行文件>] [--once]
  node src/cli.mjs attach [--port <端口>]
  node src/cli.mjs inject --port <端口>
  node src/cli.mjs unmount --port <端口>
  node src/cli.mjs status
  node src/cli.mjs stop-codex
  node src/cli.mjs cards list
  node src/cli.mjs config get [--config-path <路径>]
  node src/cli.mjs config patch [--config-path <路径>]  # stdin: {expectedRevision,patch}

命令：
  launch      启动带本机随机 CDP 端口的 Codex，并常驻维护注入（默认）；可选本机 HTTP/HTTPS 代理
  attach      连接已以 CDP 模式启动的 Codex 并常驻维护；未传 --port 时从运行时状态文件读取
  inject      单次注入后退出
  unmount     移除注入卡片后退出
  status      输出单行 JSON 状态（Codex 是否运行、CDP 端口、卡片配置），供配置界面调用
  stop-codex  温和退出 Codex（SIGTERM，绝不强杀），输出单行 JSON 结果
`);
}

export function parseArgs(argv) {
  const options = {
    command: "launch",
    port: null,
    proxyPort: null,
    executable: process.env.CODEX_COMPANION_CODEX_EXECUTABLE
      || process.env.CODEX_HG_CODEX_EXECUTABLE
      || DEFAULT_CODEX_EXECUTABLE,
    once: false,
    help: false,
    configPath: process.env.CODEX_COMPANION_CONFIG_PATH,
    subcommand: null
  };

  const args = [...argv];
  if (args[0] && !args[0].startsWith("-")) options.command = args.shift();

  if (["cards", "config"].includes(options.command)) options.subcommand = args.shift();

  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--once") options.once = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--port") options.port = Number(args.shift());
    else if (arg === "--proxy-port") {
      const value = args.shift();
      if (!value || !/^[0-9]{1,5}$/.test(value)) throw new Error("代理端口必须是 1–65535 的整数");
      options.proxyPort = Number(value);
    }
    else if (arg === "--config-path") {
      options.configPath = args.shift();
      if (!options.configPath || options.configPath.startsWith("--")) throw new Error("--config-path 必须提供路径");
    }
    else if (arg === "--app") options.executable = args.shift();
    else throw new Error(`未知参数：${arg}`);
  }

  if (!["launch", "attach", "inject", "unmount", "status", "stop-codex", "cards", "config"].includes(options.command)) {
    throw new Error(`未知命令：${options.command}`);
  }
  if (options.port !== null && (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535)) {
    throw new Error(`无效端口：${options.port}`);
  }
  if (options.proxyPort !== null && (options.proxyPort < 1 || options.proxyPort > 65_535)) {
    throw new Error("代理端口必须是 1–65535 的整数");
  }
  if (options.proxyPort !== null && options.command !== "launch") {
    throw new Error("--proxy-port 只能用于 launch");
  }
  if (["inject", "unmount"].includes(options.command) && options.port === null) {
    throw new Error(`${options.command} 命令必须提供 --port`);
  }
  if (options.command === "cards" && options.subcommand !== "list") throw new Error("cards 仅支持 list");
  if (options.command === "config" && !["get", "patch"].includes(options.subcommand)) throw new Error("config 仅支持 get / patch");
  return options;
}

async function endpointIsAvailable(port) {
  try {
    await listCdpTargets(port);
    return true;
  } catch {
    return false;
  }
}

export async function createEmbyRuntime(port, {
  InjectorClass = CodexInjector,
  loadRuntimeSource = async () => "",
  configStore = new CompanionConfig(),
  serviceFactory = ({ logger, configStore }) => new CodexCompanionService({ logger, configStore }),
  loadConfig = () => configStore.loadV2(),
  logger = console
} = {}) {
  const [runtimePrelude, config] = await Promise.all([loadRuntimeSource(), loadConfig()]);
  const service = serviceFactory({ logger, configStore });
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

export async function runCli(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return;
  }

  const companionConfig = new CompanionConfig({ path: options.configPath });
  if (options.command === "cards") {
    console.log(JSON.stringify(CARD_MANIFESTS));
    return;
  }
  if (options.command === "config") {
    if (options.subcommand === "get") console.log(JSON.stringify(await companionConfig.loadV2({ strict: true })));
    else {
      let input = "";
      process.stdin.setEncoding("utf8");
      for await (const chunk of process.stdin) {
        input += chunk;
        if (Buffer.byteLength(input) > 1024 * 1024) throw new Error("配置补丁超过 1 MiB");
      }
      const request = JSON.parse(input);
      console.log(JSON.stringify(await companionConfig.patch(request.patch, { expectedRevision: request.expectedRevision })));
    }
    return;
  }

  let port = options.port;
  const runtimeState = new RuntimeState();
  let launchedCodexPid = null;

  if (options.command === "status") {
    const { collectStatus } = await import("./codex-control.mjs");
    const status = await collectStatus({
      executable: options.executable,
      loadRuntimeState: () => runtimeState.load(),
      loadConfig: () => companionConfig.load()
    });
    console.log(JSON.stringify(status));
    return;
  }

  if (options.command === "stop-codex") {
    const { stopCodex } = await import("./codex-control.mjs");
    const result = await stopCodex({ executable: options.executable });
    if (result.stopped) await runtimeState.clear().catch(() => {});
    console.log(JSON.stringify(result));
    if (result.reason === "kill-failed") process.exitCode = 1;
    return;
  }

  if (options.command === "launch") {
    await access(options.executable);

    // 单实例守护：若已有存活的守护进程且其 CDP 端口可用，则本次 launch 直接退出，
    // 避免重复点击 App 时起多个守护同时对同一 renderer 扫描注入。
    if (options.port === null) {
      const saved = await runtimeState.load();
      if (saved?.daemonPid
        && saved.daemonPid !== process.pid
        && pidIsAlive(saved.daemonPid)
        && saved.port
        && (await endpointIsAvailable(saved.port))) {
        if (options.proxyPort !== null) {
          throw new Error("Codex 已在运行；代理只在启动新进程时生效。请先退出 Codex 和旧维护进程，再重新启动。");
        }
        console.log(`[codex-companion] 已有守护实例在运行（PID ${saved.daemonPid}，CDP 端口 ${saved.port}），本次不重复启动。`);
        return;
      }
    }

    // 幂等：.app 被重复点击时，若已有带 flag 的 Codex + 可用 CDP 端口，直接复用而非报错。
    if (options.port === null) {
      const saved = await runtimeState.load();
      if (saved?.port && (await endpointIsAvailable(saved.port))) {
        if (options.proxyPort !== null) {
          throw new Error("Codex 已在运行；代理只在启动新进程时生效。请先退出 Codex，再重新启动。");
        }
        port = saved.port;
        console.log(`[codex-companion] 复用已在运行的 Codex（CDP 端口 ${port}）`);
      }
    }

    if (port === null) {
      port = await reserveLoopbackPort();
    }

    const portAvailable = await endpointIsAvailable(port);
    if (portAvailable && options.proxyPort !== null) {
      throw new Error("Codex 已在运行；代理只在启动新进程时生效。请先退出 Codex，再重新启动。");
    }
    if (!portAvailable) {
      const running = await findRunningCodex(options.executable);
      if (running.length > 0) {
        throw new Error(
          `Codex 已在运行（PID ${running.join(", ")}），但端口 ${port} 不可用。\n` +
          "请先从菜单完全退出 Codex，再重新启动 Codex Companion；当前任务和终端不会被强制关闭。"
        );
      }

      const pid = launchCodex({ executable: options.executable, port, proxyPort: options.proxyPort });
      launchedCodexPid = pid;
      console.log(`[codex-companion] 已启动 Codex（PID ${pid}，CDP 127.0.0.1:${port}）`);
    }
  }

  if (options.command === "attach" && port === null) {
    const saved = await runtimeState.load();
    if (!saved?.port) {
      throw new Error(
        "attach 未提供 --port，且未找到运行时状态文件。\n" +
        "请改用 launch，或显式传入启动日志中的端口。"
      );
    }
    port = saved.port;
    console.log(`[codex-companion] 从运行时状态解析到 CDP 端口 ${port}`);
  }

  if (options.command === "unmount") {
    const injector = new CodexInjector(port);
    const results = await injector.injectOnce("unmount");
    console.log(`[codex-companion] 已移除 ${results.length} 个 renderer 中的注入卡片`);
    return;
  }

  const { injector, embyService } = await createEmbyRuntime(port, { configStore: companionConfig });

  if (options.command === "inject" || options.once) {
    try {
      const results = await injector.injectOnce("mount");
      console.log(`[codex-companion] 已向 ${results.length} 个 renderer 注入卡片`);
    } finally {
      await embyService.dispose();
    }
    return;
  }

  const shutdown = createRuntimeShutdown({ injector, embyService });
  try {
    await injector.start();
  } catch (error) {
    await shutdown("启动失败");
    throw error;
  }
  console.log(`[codex-companion] 常驻维护中，CDP 端口 ${port}；按 Ctrl-C 停止维护（不会关闭 Codex）`);

  // 进入常驻后写运行时状态：记录本守护进程 pid，供后续 launch 的单实例检查与 stop/status 使用。
  // codexPid 仅在本次亲自启动 Codex 时可靠；复用既有 Codex 时保留上次记录的值。
  const previousState = await runtimeState.load();
  await runtimeState.save({
    port,
    codexPid: launchedCodexPid ?? previousState?.codexPid ?? null,
    daemonPid: process.pid,
    startedAt: Date.now()
  }).catch((error) => {
    console.error(`[codex-companion] 运行时状态写入失败：${error.message}`);
  });

  // 服务先关停被禁用卡片的后台会话，再让 renderer 应用同一 revision。
  const configWatcher = await watchCompanionConfig({
    config: companionConfig,
    onChange: async (next) => {
      try { await embyService.applyConfig(next); }
      finally { injector.setConfig({ config: next }); }
      console.log(`[codex-companion] 配置已更新，revision=${next.revision}`);
    },
    onError: error => console.error(`[codex-companion] 保留上次有效配置：${error.message}`)
  });

  // 守护：Codex 退出则清状态并停止维护；Codex 无 flag 运行则发通知引导重启（不 kill）。
  const watchdog = startCodexWatchdog({
    executable: options.executable,
    onGone: async () => {
      console.log("[codex-companion] Codex 已退出，停止维护。");
      await shutdownAll("codex-gone");
    }
  });

  const shutdownAll = async (signal) => {
    watchdog.stop();
    await configWatcher.close();
    await runtimeState.clear().catch(() => {});
    await shutdown(signal);
  };

  process.once("SIGINT", () => void shutdownAll("SIGINT"));
  process.once("SIGTERM", () => void shutdownAll("SIGTERM"));
  process.once("SIGHUP", () => void shutdownAll("SIGHUP"));
  // 常驻进程不应因为某个未捕获的异步错误就直接崩溃并留下未清理的注入/播放会话。
  process.on("unhandledRejection", (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    console.error(`[codex-companion] 未处理的 Promise 拒绝：${message}`);
  });
  process.on("uncaughtException", (error) => {
    console.error(`[codex-companion] 未捕获异常，正在停止维护：${error?.message ?? error}`);
    // 完整清理（含 watchdog/watcher/状态文件）后退出，避免残留陈旧 runtime.json 误导下次启动。
    void shutdownAll("uncaughtException").finally(() => process.exit(1));
  });
}

// Bun 编译时多个模块共用入口 URL；import.meta.main 才能区分被导入与直接执行。
if (import.meta.main ?? (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)) {
  runCli().catch((error) => {
    console.error(JSON.stringify({ error: { code: error.code ?? "CLI_ERROR", message: error.message, ...(error.revision === undefined ? {} : { revision: error.revision }) } }));
    process.exitCode = 1;
  });
}
