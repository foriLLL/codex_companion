import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { companionDataDir } from "./platform/paths.mjs";

/**
 * 运行时状态文件：记录本次 launch 分配的随机 CDP 端口与相关 PID，
 * 使 attach / 守护进程无需人肉传 --port。权限 0600，参照 emby.json 约定。
 */
export function defaultRuntimeStatePath(home = homedir()) {
  return join(companionDataDir(home), "runtime.json");
}

function sanitizePort(value) {
  return Number.isInteger(value) && value >= 1 && value <= 65_535 ? value : null;
}

function sanitizePid(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

export function normalizeRuntimeState(value) {
  if (!value || typeof value !== "object") return null;
  const port = sanitizePort(value.port);
  // agent 在 Codex 未启动时也要保存冷却时间，不能再要求始终有 CDP 端口。
  if (port === null && !Object.hasOwn(value, "agentPid")) return null;
  return {
    port,
    codexPid: sanitizePid(value.codexPid),
    daemonPid: sanitizePid(value.daemonPid),
    startedAt: Number.isFinite(Number(value.startedAt)) ? Number(value.startedAt) : null,
    agentPid: sanitizePid(value.agentPid),
    lastAttemptAt: Number.isFinite(value.lastAttemptAt) && value.lastAttemptAt >= 0 ? value.lastAttemptAt : 0,
    lastEvent: typeof value.lastEvent?.event === "string" && Number.isFinite(value.lastEvent.at)
      ? { event: value.lastEvent.event, at: value.lastEvent.at } : null,
    codexKey: typeof value.codexKey === "string" ? value.codexKey : null
  };
}

/**
 * 判断一个 pid 是否仍存活（signal 0 不真正发信号，只做存在性/权限探测）。
 * 注意：受 pid 复用影响，仅作启发式使用。
 */
export function pidIsAlive(pid, killImpl = process.kill.bind(process)) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    killImpl(pid, 0);
    return true;
  } catch (error) {
    // EPERM：进程存在但无权限（仍算存活）；ESRCH：不存在。
    return error?.code === "EPERM";
  }
}

export class RuntimeState {
  constructor(options = {}) {
    this.path = options.path ?? defaultRuntimeStatePath();
    this.randomUUIDImpl = options.randomUUIDImpl ?? randomUUID;
  }

  async load() {
    let raw;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
    try {
      return normalizeRuntimeState(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  async save(state) {
    const normalized = normalizeRuntimeState(state);
    if (!normalized) throw new Error("无效运行时状态：缺少有效端口");
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true });
    const temporary = join(directory, `.runtime-${process.pid}-${this.randomUUIDImpl()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      await rename(temporary, this.path);
      await chmod(this.path, 0o600);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
    return normalized;
  }

  async clear() {
    await unlink(this.path).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}
