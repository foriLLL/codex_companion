import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { CodexSessions, THREAD_ID_PATTERN } from "../../codex-sessions.mjs";
import { rpcError } from "../../platform/services/errors.mjs";
import { COLOR_COUNT, MAX_TASKS, TaskBoardStorage, normalizeName, normalizeTask, pickColor } from "../../task-board-storage.mjs";

const execFileAsync = promisify(execFile);
// 长轮询：每 300ms 只比较文件指纹，有变化才重新解析；最多挂起 25 秒后照常返回。
const WATCH_POLL_MS = 300;
const WATCH_MAX_MS = 25_000;

function params(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) {
    throw rpcError("RPC_INVALID_PARAMS", "参数无效");
  }
  return value;
}

function threadId(value) {
  if (typeof value !== "string" || !THREAD_ID_PATTERN.test(value)) throw rpcError("RPC_INVALID_PARAMS", "会话 id 无效");
  return value;
}

// 深链由 ChatGPT.app 注册；只在侧栏里找不到条目时作为兜底。
async function openThreadLink(id, { platform = process.platform } = {}) {
  if (platform !== "darwin") throw rpcError("UNSUPPORTED", "此系统暂不支持从看板打开会话");
  await execFileAsync("/usr/bin/open", [`codex://threads/${id}`], { timeout: 5000 });
}

export function createService({ taskBoard = new TaskBoardStorage(), codexSessions = new CodexSessions(), openThread = openThreadLink } = {}) {
  async function view(board, signal) {
    const titles = await codexSessions.titles();
    const tasks = await Promise.all(board.tasks.map(async (task) => {
      const { status, updatedAt, turnAt, activity = null, summary = null } = await codexSessions.status(task.threadId)
        .catch(() => ({ status: "missing", updatedAt: null, turnAt: null }));
      const suggestedName = titles.get(await codexSessions.canonicalId(task.threadId)) ?? task.suggestedName;
      // unread：回合结束（回复、提问、中断）之后用户还没在 Codex 里看过。
      const unread = status !== "running" && Number.isFinite(turnAt) && turnAt > task.seenAt;
      // 侧栏条目可能用真实 id，也可能用新建时的客户端临时 id，看板两个都认。
      const aliases = await codexSessions.aliases(task.threadId);
      return { ...task, aliases, suggestedName, name: task.customName ?? suggestedName ?? "未命名会话", status, updatedAt, turnAt, unread, activity, summary };
    }));
    signal?.throwIfAborted();
    // sig 只覆盖界面上会变的内容；mtime 每次写入都变，不放进来，免得进行中的任务每次都触发重绘。
    const visible = tasks.map(({ updatedAt, ...task }) => task);
    const sig = createHash("sha1").update(JSON.stringify([board.revision, visible])).digest("hex").slice(0, 16);
    return { revision: board.revision, tasks, sig };
  }

  return {
    methods: {
      async list(input, { signal }) {
        params(input, []);
        return view(await taskBoard.load(), signal);
      },
      // 实时刷新：内容与 since 不同就立即返回，否则等到会话记录或看板文件变化再返回。
      async watch(input, { signal }) {
        const { since = null, waitMs = 20_000 } = params(input, ["since", "waitMs"]);
        if (since !== null && typeof since !== "string") throw rpcError("RPC_INVALID_PARAMS", "since 无效");
        const deadline = Date.now() + Math.min(Math.max(Number(waitMs) || 0, 0), WATCH_MAX_MS);
        const boardStamp = async () => { try { const info = await stat(taskBoard.path); return `${info.mtimeMs}:${info.size}`; } catch { return "-"; } };
        let boardMark = await boardStamp();
        let board = await taskBoard.load();
        const sessionsMark = () => codexSessions.fingerprint(board.tasks.map((task) => task.threadId));
        let stamp = `${boardMark}#${await sessionsMark()}`;
        let current = await view(board, signal);
        while (current.sig === since && Date.now() < deadline) {
          await delay(WATCH_POLL_MS, undefined, { signal });
          const nextBoardMark = await boardStamp();
          if (nextBoardMark !== boardMark) {
            boardMark = nextBoardMark;
            board = await taskBoard.load();
          }
          const next = `${boardMark}#${await sessionsMark()}`;
          if (next === stamp) continue;
          stamp = next;
          current = await view(board, signal);
        }
        return current;
      },
      // 单个会话的 Trace，长轮询：since 与当前内容不同立即返回，否则等会话记录变化或超时。
      async trace(input, { signal }) {
        const { threadId: rawId, since = null, waitMs = 0 } = params(input, ["threadId", "since", "waitMs"]);
        const id = threadId(rawId);
        if (since !== null && typeof since !== "string") throw rpcError("RPC_INVALID_PARAMS", "since 无效");
        const deadline = Date.now() + Math.min(Math.max(Number(waitMs) || 0, 0), WATCH_MAX_MS);
        const read = async () => {
          const trace = await codexSessions.trace(id);
          const sig = createHash("sha1").update(JSON.stringify(trace)).digest("hex").slice(0, 16);
          return { threadId: id, ...trace, sig };
        };
        let stamp = await codexSessions.stamp(id);
        let current = await read();
        while (current.sig === since && Date.now() < deadline) {
          await delay(WATCH_POLL_MS, undefined, { signal });
          const next = await codexSessions.stamp(id);
          if (next === stamp) continue;
          stamp = next;
          current = await read();
        }
        signal?.throwIfAborted();
        return { ...current, now: Date.now() };
      },
      async add(input, { signal }) {
        const { threadId: rawId, title, projectId } = params(input, ["threadId", "title", "projectId"]);
        // 新建会话的侧栏条目给的是客户端临时 id，已绑定真实 id 时存真实 id。
        const id = await codexSessions.canonicalId(threadId(rawId));
        const aliases = new Set([id, ...await codexSessions.aliases(id)]);
        const board = await taskBoard.mutate((tasks) => {
          if (tasks.some((task) => aliases.has(task.threadId))) return null;
          if (tasks.length >= MAX_TASKS) throw rpcError("TASK_BOARD_FULL", `看板最多保留 ${MAX_TASKS} 个任务，请先完成一些`);
          const task = normalizeTask({ threadId: id, suggestedName: title, customName: null, color: pickColor(tasks), projectId, addedAt: Date.now() });
          return [task, ...tasks];
        });
        return view(board, signal);
      },
      // name 为空时回到推荐名（Codex 智能起名或 rename 的名字）。只改看板，不改 Codex 会话名。
      async rename(input, { signal }) {
        const { threadId: rawId, name } = params(input, ["threadId", "name"]);
        const id = threadId(rawId);
        if (name !== null && typeof name !== "string") throw rpcError("RPC_INVALID_PARAMS", "名字无效");
        const customName = normalizeName(name);
        const board = await taskBoard.mutate((tasks) => {
          const task = tasks.find((item) => item.threadId === id);
          if (!task || task.customName === customName) return null;
          task.customName = customName;
          return tasks;
        });
        return view(board, signal);
      },
      async recolor(input, { signal }) {
        const { threadId: rawId, color } = params(input, ["threadId", "color"]);
        const id = threadId(rawId);
        if (!Number.isInteger(color) || color < 0 || color >= COLOR_COUNT) throw rpcError("RPC_INVALID_PARAMS", "颜色无效");
        const board = await taskBoard.mutate((tasks) => {
          const task = tasks.find((item) => item.threadId === id);
          if (!task || task.color === color) return null;
          task.color = color;
          return tasks;
        });
        return view(board, signal);
      },
      // 用户在 Codex 里看过这个会话；只会往后推，避免旧轮询覆盖新的已读时间。
      async seen(input, { signal }) {
        const { threadId: rawId, at } = params(input, ["threadId", "at"]);
        const id = threadId(rawId);
        if (!Number.isSafeInteger(at) || at <= 0 || at > Date.now() + 60_000) throw rpcError("RPC_INVALID_PARAMS", "时间无效");
        const board = await taskBoard.mutate((tasks) => {
          const task = tasks.find((item) => item.threadId === id);
          if (!task || task.seenAt >= at) return null;
          task.seenAt = at;
          return tasks;
        });
        return view(board, signal);
      },
      async remove(input, { signal }) {
        const id = threadId(params(input, ["threadId"]).threadId);
        let removed = null;
        const board = await taskBoard.mutate((tasks) => {
          const index = tasks.findIndex((task) => task.threadId === id);
          if (index < 0) return null;
          removed = { task: tasks[index], index };
          return tasks.toSpliced(index, 1);
        });
        return { ...(await view(board, signal)), removed };
      },
      // 撤销「完成」：按原位置放回，保留原颜色与自定义名字。
      async restore(input, { signal }) {
        const { task: raw, index } = params(input, ["task", "index"]);
        const task = normalizeTask(raw);
        if (!task || !Number.isSafeInteger(index) || index < 0) throw rpcError("RPC_INVALID_PARAMS", "任务无效");
        const board = await taskBoard.mutate((tasks) => {
          if (tasks.some((item) => item.threadId === task.threadId) || tasks.length >= MAX_TASKS) return null;
          return tasks.toSpliced(Math.min(index, tasks.length), 0, task);
        });
        return view(board, signal);
      },
      async open(input) {
        await openThread(await codexSessions.canonicalId(threadId(params(input, ["threadId"]).threadId)));
        return { opened: true };
      }
    }
  };
}
