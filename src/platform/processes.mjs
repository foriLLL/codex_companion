import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

// Linux 内核以 USER_HZ 记录进程启动时刻；主流架构固定为 100。
const USER_HZ = 100;

async function bootTimeMs({ procRoot, readFileImpl }) {
  const text = await readFileImpl(join(procRoot, "stat"), "utf8");
  const seconds = Number(text.match(/^btime\s+(\d+)$/m)?.[1]);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) throw new Error("无法读取系统启动时间");
  return seconds * 1000;
}

// /proc/<pid>/stat 的进程名可含空格和括号，字段从最后一个 ")" 之后数起；starttime 是第 22 个字段。
export function parseLinuxStartTicks(statText) {
  const fields = String(statText).slice(String(statText).lastIndexOf(")") + 2).split(" ");
  const ticks = Number(fields[19]);
  return Number.isSafeInteger(ticks) && ticks >= 0 ? ticks : null;
}

/**
 * 把 /proc/<pid>/cmdline 还原成 argv。Chromium 会用 setproctitle 改写主进程的 cmdline，
 * 参数被空格拼成一个字符串：此时按空格切分，带引号或反斜杠的无法确认原样，arguments 记为 null（只观察不接管）。
 */
export function parseLinuxCmdline(cmdline, executable) {
  const parts = String(cmdline).split("\0");
  if (parts.at(-1) === "") parts.pop();
  if (parts[0] === executable) return { command: parts.join(" "), arguments: parts.slice(1) };
  if (parts.length !== 1 || !parts[0].startsWith(`${executable} `)) return null;
  const suffix = parts[0].slice(executable.length + 1).trim();
  return { command: parts[0], arguments: /["'\\]/.test(suffix) ? null : suffix ? suffix.split(/\s+/) : [] };
}

/**
 * 从 /proc 找出 Codex 主进程：argv[0] 与可执行文件一致，且不是 Chromium 子进程（--type=）。
 * 已退出或无权读取的进程跳过。
 */
export async function findLinuxCodexProcesses(executable, {
  procRoot = "/proc", readFileImpl = readFile, readdirImpl = readdir
} = {}) {
  const bootMs = await bootTimeMs({ procRoot, readFileImpl });
  const entries = await readdirImpl(procRoot);
  const processes = [];
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    let cmdline;
    let stat;
    try {
      cmdline = await readFileImpl(join(procRoot, name, "cmdline"), "utf8");
      if (!cmdline.startsWith(`${executable}\0`) && !cmdline.startsWith(`${executable} `) && cmdline !== executable) continue;
      stat = await readFileImpl(join(procRoot, name, "stat"), "utf8");
    } catch { continue; }
    const parsed = parseLinuxCmdline(cmdline, executable);
    if (!parsed || /(?:^|\s)--type=/.test(parsed.command)) continue;
    const ticks = parseLinuxStartTicks(stat);
    if (ticks === null) continue;
    const pid = Number(name);
    const launchedAt = bootMs + Math.round((ticks * 1000) / USER_HZ);
    processes.push({ pid, key: `${pid}:${launchedAt}`, launchedAt, command: parsed.command, arguments: parsed.arguments });
  }
  return processes.sort((left, right) => left.pid - right.pid);
}
