import { execFile, spawn } from "node:child_process";
import net from "node:net";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const DEFAULT_CODEX_EXECUTABLE = "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT";

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

/**
 * 扫描正在运行的 Codex 进程，返回每个进程的 pid、完整命令行，以及是否带 CDP 调试端口 flag。
 * execFileImpl 可注入以便测试。
 */
export async function inspectRunningCodex(executable = DEFAULT_CODEX_EXECUTABLE, {
  execFileImpl = execFileAsync
} = {}) {
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
        hasCdpFlag: command.includes(`${CDP_PORT_FLAG}=`) || command.includes(`${CDP_PORT_FLAG} `)
      });
    }
  }
  return matches;
}

export async function findRunningCodex(executable = DEFAULT_CODEX_EXECUTABLE, options = {}) {
  const processes = await inspectRunningCodex(executable, options);
  return processes.map((entry) => entry.pid);
}

export function buildCodexLaunchEnvironment(proxyPort, baseEnvironment = process.env) {
  const environment = { ...baseEnvironment };
  // 代理是本次 Codex 启动的显式选择，避免继承 Companion 进程的旧代理值。
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) {
    delete environment[name];
  }
  if (proxyPort !== null && proxyPort !== undefined) {
    if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65_535) {
      throw new RangeError("代理端口必须是 1–65535 的整数");
    }
    const proxy = `http://127.0.0.1:${proxyPort}`;
    environment.HTTP_PROXY = proxy;
    environment.HTTPS_PROXY = proxy;
  }
  return environment;
}

export function launchCodex({ executable = DEFAULT_CODEX_EXECUTABLE, port, proxyPort = null, spawnImpl = spawn }) {
  const environment = buildCodexLaunchEnvironment(proxyPort);
  const child = spawnImpl(executable, [
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${port}`
  ], {
    detached: true,
    stdio: "ignore",
    env: environment
  });
  child.unref();
  return child.pid;
}
