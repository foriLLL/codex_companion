import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { THREAD_ID_PATTERN } from "./codex-sessions.mjs";
import { companionDataDir } from "./platform/paths.mjs";
import { replaceFile } from "./platform/replace-file.mjs";

const FILE_LIMIT = 1024 * 1024;
export const MAX_TASKS = 100;
export const NAME_LIMIT = 120;
export const COLOR_COUNT = 8;

export function defaultTaskBoardPath(home = homedir()) {
  return join(companionDataDir(home), "task-board.json");
}

export function normalizeName(value) {
  if (typeof value !== "string") return null;
  const name = value.replace(/\s+/g, " ").trim().slice(0, NAME_LIMIT);
  return name || null;
}

/** 只保留白名单字段；无效项返回 null。 */
export function normalizeTask(value) {
  if (!value || typeof value !== "object") return null;
  const threadId = String(value.threadId ?? "");
  if (!THREAD_ID_PATTERN.test(threadId)) return null;
  const color = Number.isInteger(value.color) && value.color >= 0 && value.color < COLOR_COUNT ? value.color : 0;
  const projectId = typeof value.projectId === "string" && value.projectId.length <= 1024 ? value.projectId : null;
  const addedAt = Number.isSafeInteger(value.addedAt) && value.addedAt > 0 ? value.addedAt : Date.now();
  // 用户最后一次在 Codex 里看过这个会话的时间；加入时用户正看着它，缺省取加入时间。
  const seenAt = Number.isSafeInteger(value.seenAt) && value.seenAt > 0 ? value.seenAt : addedAt;
  return { threadId, suggestedName: normalizeName(value.suggestedName), customName: normalizeName(value.customName), color, projectId, addedAt, seenAt };
}

function normalizeTasks(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const tasks = [];
  for (const raw of value) {
    const task = normalizeTask(raw);
    if (!task || seen.has(task.threadId)) continue;
    seen.add(task.threadId);
    tasks.push(task);
    if (tasks.length >= MAX_TASKS) break;
  }
  return tasks;
}

/** 新任务取当前最少使用的颜色，颜色相同时取下标小的，避免相邻任务撞色。 */
export function pickColor(tasks) {
  const used = new Array(COLOR_COUNT).fill(0);
  for (const task of tasks) used[task.color] += 1;
  return used.indexOf(Math.min(...used));
}

/**
 * 任务看板：数据目录下 0600 原子写。任务只由用户加入和移除，不按时间或状态自动清理。
 * 同一进程内的修改串行执行；文件缺失或损坏时回退为空看板。
 */
export class TaskBoardStorage {
  constructor({ path = defaultTaskBoardPath(), randomUUIDImpl = randomUUID } = {}) {
    this.path = path;
    this.randomUUIDImpl = randomUUIDImpl;
    this.queue = Promise.resolve();
  }

  async load() {
    let contents;
    try { contents = await readFile(this.path, "utf8"); } catch { return { revision: 0, tasks: [] }; }
    if (Buffer.byteLength(contents) > FILE_LIMIT) return { revision: 0, tasks: [] };
    try {
      const data = JSON.parse(contents);
      return { revision: Number.isSafeInteger(data?.revision) && data.revision >= 0 ? data.revision : 0, tasks: normalizeTasks(data?.tasks) };
    } catch { return { revision: 0, tasks: [] }; }
  }

  async save(board) {
    const serialized = `${JSON.stringify({ version: 1, revision: board.revision, tasks: board.tasks }, null, 2)}\n`;
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `.task-board-${process.pid}-${this.randomUUIDImpl()}.tmp`);
    try {
      await writeFile(temporary, serialized, { mode: 0o600, flag: "wx" });
      await replaceFile(temporary, this.path);
      await chmod(this.path, 0o600);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }

  /** update(tasks) 返回新数组，或返回 null 表示无改动（不写盘、不增加 revision）。 */
  mutate(update) {
    const run = this.queue.then(async () => {
      const board = await this.load();
      const next = update(board.tasks.map((task) => ({ ...task })));
      if (!next) return board;
      const saved = { revision: board.revision + 1, tasks: normalizeTasks(next) };
      await this.save(saved);
      return saved;
    });
    this.queue = run.catch(() => {});
    return run;
  }
}
