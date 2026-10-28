import { DEFAULT_CODEX_EXECUTABLE, inspectRunningCodex } from "./launcher.mjs";

/**
 * Codex 进程生命周期控制（供 CLI 子命令与配置界面调用）。
 *
 * 安全约定：
 *   - 只对 `ps` 交叉验证过“确实是 Codex 可执行文件”的 pid 发信号；
 *   - 只发 SIGTERM（等价于正常退出），绝不 SIGKILL；
 *   - pid 失效（进程已退出）视为成功的幂等结果。
 */
export async function stopCodex({
  executable = DEFAULT_CODEX_EXECUTABLE,
  inspectImpl = inspectRunningCodex,
  killImpl = process.kill.bind(process)
} = {}) {
  const processes = await inspectImpl(executable);
  if (processes.length === 0) {
    return { stopped: false, reason: "not-running", pids: [] };
  }

  const pids = [];
  for (const entry of processes) {
    try {
      killImpl(entry.pid, "SIGTERM");
      pids.push(entry.pid);
    } catch (error) {
      // ESRCH：进程在 ps 与 kill 之间退出了，幂等忽略；其余（如 EPERM）如实上报。
      if (error?.code !== "ESRCH") {
        return { stopped: false, reason: "kill-failed", error: error.message, pids };
      }
    }
  }
  return { stopped: true, reason: "terminated", pids };
}

/**
 * 汇总当前状态：Codex 是否运行、是否带 CDP flag、代理端口、运行时状态文件内容与配置。
 * 输出为可被 Swift 侧 JSONDecoder 直接解析的扁平结构。
 *
 * 注意：ps 扫描失败与「确认没有进程」必须区分——前者 statusError=true，
 * 界面应显示「状态未知」而非「未运行」，避免用户在 Codex 实际运行时重复启动。
 */
export async function collectStatus({
  executable = DEFAULT_CODEX_EXECUTABLE,
  inspectImpl = inspectRunningCodex,
  loadRuntimeState,
  loadConfig
} = {}) {
  let processes = [];
  let statusError = false;
  try {
    processes = await inspectImpl(executable);
  } catch {
    statusError = true;
  }

  const [runtime, config] = await Promise.all([
    Promise.resolve().then(loadRuntimeState ?? (() => null)).catch(() => null),
    Promise.resolve().then(loadConfig ?? (() => null)).catch(() => null)
  ]);

  // 代理端口取自 Companion 维护的那个 Codex 的命令行；未带 --proxy-server 时为 null。
  const maintained = processes.find((entry) => runtime?.port && entry.cdpPort === runtime.port)
    ?? processes.find((entry) => entry.hasCdpFlag);
  return {
    statusError,
    codexRunning: processes.length > 0,
    hasCdpFlag: processes.some((entry) => entry.hasCdpFlag),
    codexPids: processes.map((entry) => entry.pid),
    proxyPort: maintained?.proxyPort ?? null,
    port: runtime?.port ?? null,
    daemonPid: runtime?.daemonPid ?? null,
    cards: config?.cards ?? null
  };
}
