import { execFile, spawn } from "node:child_process";
import net from "node:net";
import { promisify } from "node:util";
import { findLinuxCodexProcesses } from "./platform/processes.mjs";

const execFileAsync = promisify(execFile);

// Codex 桌面端主程序：macOS 为 ChatGPT.app，Linux 为官方 deb/rpm 的安装位置
// （/usr/bin/chatgpt 只是 exec 到这里的脚本）。
export function defaultCodexExecutable(platform = process.platform) {
  return platform === "linux" ? "/usr/lib/chatgpt/ChatGPT" : "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT";
}
export const DEFAULT_CODEX_EXECUTABLE = defaultCodexExecutable();

// 能从命令行识别 Codex 进程及其启动参数的平台。Windows 的打包应用进程模型不同，降级为不可用。
export function codexProcessSupported(platform = process.platform) {
  return platform === "darwin" || platform === "linux";
}

export async function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => {
        if (error) reject(error);
        else if (!port) reject(new Error("无法分配本机随机端口"));
        else resolve(port);
      });
    });
  });
}

const CDP_PORT_FLAG = "--remote-debugging-port";
// Chromium 在 macOS 上不读 HTTP(S)_PROXY，只认系统代理或 --proxy-server；
// 环境变量留给内置 codex CLI，命令行参数让界面层网络请求也走同一代理。
const PROXY_SERVER_FLAG = "--proxy-server";
// 局域网 Emby 等私网地址不经代理；loopback 由 Chromium 默认直连。
const PROXY_BYPASS_LIST = "<local>;10.0.0.0/8;172.16.0.0/12;192.168.0.0/16";

function sanitizeFlagPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : null;
}

function parseCdpPort(command) {
  const match = command.match(/(?:^|\s)--remote-debugging-port[= ](\d{1,5})(?=\s|$)/);
  return match ? sanitizeFlagPort(match[1]) : null;
}

/**
 * 从 Codex 命令行读出本机代理端口；只认 Companion 自己写入的 loopback 形式，
 * 其他代理地址不当作「通过 Companion 代理启动」。
 */
export function parseCodexProxyPort(command) {
  const match = command.match(/(?:^|\s)--proxy-server=(?:http:\/\/)?127\.0\.0\.1:(\d{1,5})(?=\s|$)/);
  return match ? sanitizeFlagPort(match[1]) : null;
}

/**
 * 扫描正在运行的 Codex 进程，返回每个进程的 pid、完整命令行，以及是否带 CDP 调试端口 flag。
 * execFileImpl 可注入以便测试。
 */
export async function inspectRunningCodex(executable = DEFAULT_CODEX_EXECUTABLE, {
  execFileImpl = execFileAsync, platform = process.platform, findLinuxImpl = findLinuxCodexProcesses
} = {}) {
  if (platform === "linux") {
    // Chromium 子进程与主进程同一可执行文件，靠 /proc 的 cmdline 排除 --type= 子进程。
    return (await findLinuxImpl(executable)).map(({ pid, command }) => ({
      pid, command, hasCdpFlag: command.includes(`${CDP_PORT_FLAG}=`) || command.includes(`${CDP_PORT_FLAG} `),
      cdpPort: parseCdpPort(command), proxyPort: parseCodexProxyPort(command)
    }));
  }
  const { stdout } = await execFileImpl("/bin/ps", ["ax", "-o", "pid=,command="]);
  const matches = [];

  for (const line of stdout.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!match) continue;
    const [, pid, command] = match;
    if (command === executable || command.startsWith(`${executable} `)) {
      matches.push({
        pid: Number(pid),
        command,
        hasCdpFlag: command.includes(`${CDP_PORT_FLAG}=`) || command.includes(`${CDP_PORT_FLAG} `),
        cdpPort: parseCdpPort(command),
        proxyPort: parseCodexProxyPort(command)
      });
    }
  }
  return matches;
}

export async function findRunningCodex(executable = DEFAULT_CODEX_EXECUTABLE, options = {}) {
  const processes = await inspectRunningCodex(executable, options);
  return processes.map((entry) => entry.pid);
}

/**
 * 找到本 Companion 维护的 Codex 主进程并返回其代理端口。
 * 代理只能在启动时设定，命令行即事实来源；复用或 attach 已运行的 Codex 时同样准确。
 */
export async function detectCodexProxy({
  executable = DEFAULT_CODEX_EXECUTABLE,
  cdpPort = null,
  inspectImpl = inspectRunningCodex,
  platform = process.platform
} = {}) {
  if (!codexProcessSupported(platform)) return { supported: false, running: null, proxyPort: null };
  const processes = await inspectImpl(executable);
  const codex = processes.find((entry) => cdpPort !== null && entry.cdpPort === cdpPort)
    ?? processes.find((entry) => entry.hasCdpFlag)
    ?? processes[0];
  return { running: Boolean(codex), proxyPort: codex?.proxyPort ?? null };
}

function hasProxyPort(proxyPort) {
  if (proxyPort === null || proxyPort === undefined) return false;
  if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65_535) {
    throw new RangeError("代理端口必须是 1–65535 的整数");
  }
  return true;
}

export function buildCodexLaunchEnvironment(proxyPort, baseEnvironment = process.env) {
  const environment = { ...baseEnvironment };
  // 代理是本次 Codex 启动的显式选择，避免继承 Companion 进程的旧代理值。
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) {
    delete environment[name];
  }
  if (hasProxyPort(proxyPort)) {
    const proxy = `http://127.0.0.1:${proxyPort}`;
    environment.HTTP_PROXY = proxy;
    environment.HTTPS_PROXY = proxy;
  }
  return environment;
}

export function buildCodexLaunchArgs(port, proxyPort = null) {
  const args = ["--remote-debugging-address=127.0.0.1", `${CDP_PORT_FLAG}=${port}`];
  if (hasProxyPort(proxyPort)) {
    args.push(`${PROXY_SERVER_FLAG}=http://127.0.0.1:${proxyPort}`, `--proxy-bypass-list=${PROXY_BYPASS_LIST}`);
  }
  return args;
}

export function launchCodex({ executable = DEFAULT_CODEX_EXECUTABLE, port, proxyPort = null, spawnImpl = spawn }) {
  const environment = buildCodexLaunchEnvironment(proxyPort);
  const child = spawnImpl(executable, buildCodexLaunchArgs(port, proxyPort), {
    detached: true,
    stdio: "ignore",
    env: environment
  });
  child.unref();
  return child.pid;
}
