import { appendFile, chmod, mkdir, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { format } from "node:util";

export const AGENT_LOG_MAX_BYTES = 5 * 1024 * 1024;

export async function createAgentFileLogger({ logDir, home = homedir(), now = Date.now, fallbackLogger = console } = {}) {
  const directory = logDir.startsWith("~/") ? resolve(home, logDir.slice(2)) : resolve(logDir);
  const path = join(directory, "agent.log");
  const backupPath = `${path}.1`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const ensureFile = async () => {
    await appendFile(path, "", { mode: 0o600 });
    await chmod(path, 0o600);
  };
  const rotate = async () => {
    // rename 原子替换上一份备份，只保留 .1；新文件重新设置私有权限。
    await rename(path, backupPath);
    await ensureFile();
  };
  await ensureFile();
  await chmod(backupPath, 0o600).catch(error => { if (error.code !== "ENOENT") throw error; });
  if ((await stat(path)).size > AGENT_LOG_MAX_BYTES) await rotate();

  let writes = Promise.resolve();
  let closed = false;
  function write(level, args) {
    if (closed) return writes;
    const timestamp = new Date(now()).toISOString();
    const text = format(...args).split(/\r\n|\r|\n/).map(line => `${timestamp} [${level}] ${line}\n`).join("");
    const bytes = Buffer.byteLength(text);
    // logger 调用方无需 await；排队保证同一文件上的追加和轮转不会交错。
    writes = writes.then(async () => {
      const size = await stat(path).then(info => info.size, error => { if (error.code === "ENOENT") return 0; throw error; });
      if (size > 0 && size + bytes > AGENT_LOG_MAX_BYTES) await rotate();
      await appendFile(path, text, { mode: 0o600 });
      await chmod(path, 0o600);
      // 超大的单条日志完整保留在备份中，活动日志重新从空文件开始。
      if (bytes > AGENT_LOG_MAX_BYTES) await rotate();
    }).catch(error => {
      // 日志磁盘故障不改变状态机行为，也不能产生未处理的 Promise 拒绝。
      try { fallbackLogger.error?.(`[codex-companion] 写入 agent 日志失败：${error.message}`); } catch {}
    });
    return writes;
  }
  return {
    info: (...args) => write("INFO", args),
    warn: (...args) => write("WARN", args),
    error: (...args) => write("ERROR", args),
    flush: () => writes,
    close() { closed = true; return writes; }
  };
}
