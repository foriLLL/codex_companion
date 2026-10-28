import { rename } from "node:fs/promises";

// Windows 上目标文件被其它句柄（watcher、杀毒、索引服务、并发读取）短暂打开时，
// rename 替换会报 EPERM / EACCES / EBUSY；稍等重试即可成功。其它平台的 rename
// 原子替换不受影响，错误直接抛出。
const TRANSIENT_WINDOWS_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

export async function replaceFile(from, to, {
  platform = process.platform, renameImpl = rename, attempts = 10, delayMs = 20,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
} = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try { return await renameImpl(from, to); }
    catch (error) {
      if (platform !== "win32" || !TRANSIENT_WINDOWS_CODES.has(error.code) || attempt >= attempts) throw error;
      await sleep(delayMs * attempt);
    }
  }
}
