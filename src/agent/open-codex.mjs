import { spawn } from "node:child_process";
import { CompanionConfig } from "../companion-config.mjs";
import { buildCodexLaunchArgs, buildCodexLaunchEnvironment, DEFAULT_CODEX_EXECUTABLE, reserveLoopbackPort } from "../launcher.mjs";

/**
 * Linux 应用菜单入口：以 loopback 随机调试端口启动 Codex，菜单传入的参数（如 codex:// 链接）原样透传。
 * Codex 已在运行时，Chromium 单实例把参数转交给已有窗口后退出，这次的调试参数不生效，也没有副作用。
 * 配置读不出来时照常打开 Codex（不带代理），不能因为 Companion 的问题让用户打不开应用。
 */
export async function openCodex({
  executable = DEFAULT_CODEX_EXECUTABLE, args = [], configStore = new CompanionConfig(),
  reservePort = reserveLoopbackPort, spawnImpl = spawn, env = process.env, logger = console
} = {}) {
  let proxyPort = null;
  try {
    const proxy = (await configStore.loadV2()).launch?.proxy;
    proxyPort = proxy?.enabled ? proxy.port : null;
  } catch (error) {
    logger.warn?.(`[codex-companion] 读取启动代理失败，本次不使用代理：${error.message}`);
  }
  const port = await reservePort();
  const child = spawnImpl(executable, [...buildCodexLaunchArgs(port, proxyPort), ...args], {
    detached: true, stdio: "ignore", env: buildCodexLaunchEnvironment(proxyPort, env)
  });
  await new Promise((resolveSpawn, reject) => {
    child.once("spawn", resolveSpawn);
    child.once("error", reject);
  });
  child.unref();
  return { launched: true, pid: child.pid, port, proxyPort };
}
