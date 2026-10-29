import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DEFAULT_CODEX_EXECUTABLE, inspectRunningCodex } from "./launcher.mjs";

const execFileAsync = promisify(execFile);

/**
 * 通过 osascript 发原生通知（零依赖）。失败静默——通知不是关键路径。
 * 用 `on run argv` 把 title/message 作为参数传入，避免字符串拼接被引号/换行破坏。
 */
export async function notifyMacos(title, message, { execFileImpl = execFileAsync } = {}) {
  const script = 'on run argv\n'
    + '  display notification (item 1 of argv) with title (item 2 of argv)\n'
    + 'end run';
  try {
    await execFileImpl("/usr/bin/osascript", ["-e", script, String(message), String(title)]);
    return true;
  } catch {
    return false;
  }
}

/**
 * 按平台发桌面通知：macOS 用 osascript，Linux 用 notify-send（libnotify，未安装时静默失败）。
 */
export async function notifyDesktop(title, message, { platform = process.platform, execFileImpl = execFileAsync } = {}) {
  if (platform === "darwin") return notifyMacos(title, message, { execFileImpl });
  if (platform !== "linux") return false;
  try {
    await execFileImpl("notify-send", ["--app-name=Codex Companion", "--", String(title), String(message)]);
    return true;
  } catch {
    return false;
  }
}

/**
 * 单次评估 Codex 运行状态，返回应采取的动作，不产生副作用（便于测试）。
 *   - "healthy"：Codex 在跑且带 CDP flag；
 *   - "needs-restart"：Codex 在跑但无 flag（用户从 Dock 点了官方 ChatGPT）；
 *   - "gone"：没有 Codex 进程。
 */
export function classifyCodexState(processes) {
  if (!Array.isArray(processes) || processes.length === 0) return "gone";
  return processes.some((entry) => entry.hasCdpFlag) ? "healthy" : "needs-restart";
}

/**
 * 守护循环：周期性检查 Codex 状态。
 *   - gone：调用 onGone（通常清理状态并停止守护）；
 *   - needs-restart：发一次引导通知（去抖，不重复轰炸），绝不静默 kill 用户进程；
 *   - healthy：重置去抖。
 *
 * 全部依赖注入，返回一个 stop() 用于停止。
 */
export function startCodexWatchdog({
  executable = DEFAULT_CODEX_EXECUTABLE,
  intervalMs = 5_000,
  inspectImpl = inspectRunningCodex,
  notifyImpl = notifyMacos,
  onGone = () => {},
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  logger = console
} = {}) {
  let notifiedNeedsRestart = false;
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    let processes;
    try {
      processes = await inspectImpl(executable);
    } catch (error) {
      logger.error?.(`[codex-companion] 守护扫描失败：${error.message}`);
      return;
    }
    const state = classifyCodexState(processes);
    if (state === "gone") {
      stop();
      try {
        await onGone();
      } catch (error) {
        logger.error?.(`[codex-companion] 守护清理失败：${error.message}`);
      }
      return;
    }
    if (state === "needs-restart") {
      if (!notifiedNeedsRestart) {
        notifiedNeedsRestart = true;
        await notifyImpl(
          "Codex Companion",
          "检测到 Codex 未以调试模式启动，请通过 Codex Companion 重新打开以启用播放卡片。"
        );
      }
      return;
    }
    notifiedNeedsRestart = false;
  };

  const handle = setIntervalImpl(tick, intervalMs);
  handle?.unref?.();

  function stop() {
    if (stopped) return;
    stopped = true;
    clearIntervalImpl(handle);
  }

  return { stop, tick };
}
