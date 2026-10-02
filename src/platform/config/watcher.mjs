import { watch } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { CompanionConfig } from "../../companion-config.mjs";

// 监听目录兼容原子 rename；轮询兜底文件事件丢失。读取和异步应用串行，失败后重试。
export async function watchCompanionConfig({ config = new CompanionConfig(), onChange, onError = () => {}, intervalMs = 1000, debounceMs = 30, watchImpl = watch }) {
  let closed = false;
  let running = null;
  let timer;
  let applied = null;
  // 错误上报也是不可信回调；同步抛错与异步拒绝都不得逃逸到事件循环。
  const reportError = error => Promise.resolve()
    .then(() => { if (!closed) return onError(error); })
    .catch(() => {});
  const check = () => {
    if (closed) return Promise.resolve();
    if (running) return running;
    running = (async () => {
      try {
        const next = await config.loadV2({ strict: true });
        const serialized = JSON.stringify(next);
        if (!closed && serialized !== applied) {
          await onChange(next);
          applied = serialized;
        }
      } catch (error) { await reportError(error); }
    })().finally(() => { running = null; });
    return running;
  };
  await mkdir(dirname(config.path), { recursive: true, mode: 0o700 });
  const watcher = watchImpl(dirname(config.path), (_event, filename) => {
    if (filename && String(filename) !== basename(config.path)) return;
    clearTimeout(timer);
    timer = setTimeout(check, debounceMs);
    timer.unref?.();
  });
  watcher.on("error", error => { void reportError(error); });
  watcher.unref?.();
  const poll = setInterval(check, intervalMs);
  poll.unref?.();
  await check();
  return {
    check,
    close() { closed = true; watcher.close(); clearInterval(poll); clearTimeout(timer); return running ?? Promise.resolve(); }
  };
}
