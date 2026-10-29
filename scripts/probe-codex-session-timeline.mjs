#!/usr/bin/env node
// 只读显式指定的一份 rollout，输出泳道所需的时间线与指标摘要。
// 不输出聊天内容、命令文本、工具参数或结果；工具只保留类别和名称。
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

// 工具段以 response_item 的调用与输出配对（call_id），即模型真正被阻塞等待的区间；
// item_completed 的进程生命周期可能跨越多次模型调用（后台 shell），只用来补充代码模式内部实际用了哪些工具。
const TOOL_CALLS = new Set(["function_call", "custom_tool_call"]);
const TOOL_OUTPUTS = new Set(["function_call_output", "custom_tool_call_output"]);
const OUTPUT_ITEMS = new Set(["Reasoning", "AgentMessage"]);
const INNER_TOOLS = {
  CommandExecution: () => "shell",
  McpToolCall: (item) => [item.server, item.tool].filter(Boolean).join(".") || "mcp",
  FileChange: () => "apply_patch",
  CollabAgentToolCall: (item) => item.tool || "agent"
};

function finite(value) {
  return Number.isFinite(value) ? value : null;
}

// 区间并集长度，用于并行工具调用不被重复计时。
function unionMs(segments) {
  let total = 0;
  let end = -Infinity;
  for (const s of [...segments].sort((a, b) => a.startMs - b.startMs)) {
    if (s.endMs <= end) continue;
    total += s.endMs - Math.max(s.startMs, end);
    end = s.endMs;
  }
  return total;
}

export class SessionTimeline {
  constructor() {
    this.turns = [];
    this.turn = null;
    this.threadUsage = null;
  }

  add(record) {
    const payload = record?.payload;
    if (!payload || typeof payload !== "object") return;
    const at = Date.parse(record.timestamp);
    if (!Number.isFinite(at)) return;
    if (record.type === "event_msg") this.#event(payload, at);
    else if (record.type === "response_item") this.#responseItem(payload, at);
    else if (record.type === "token_usage_record") this.#usage(payload, at);
  }

  #event(payload, at) {
    if (payload.type === "task_started") {
      // 前一回合没有结束事件就开始新回合（进程退出、崩溃或复制来的历史），不能一直算作进行中。
      if (this.turn?.endMs === null) Object.assign(this.turn, { status: "unfinished", endMs: at });
      this.turn = { id: payload.turn_id, startMs: at, endMs: null, status: "inProgress", ttftMs: null,
        cursorMs: at, firstOutputMs: null, pending: new Map(), segments: [] };
      this.turns.push(this.turn);
      return;
    }
    const turn = this.turn;
    if (!turn || payload.turn_id !== turn.id) return;
    if (payload.type === "task_complete") {
      turn.status = "completed";
      turn.endMs = at;
      turn.ttftMs = finite(payload.time_to_first_token_ms);
    } else if (payload.type === "turn_aborted") {
      turn.status = "interrupted";
      turn.endMs = at;
    } else if (payload.type === "item_completed" && payload.item) {
      const startMs = finite(payload.started_at_ms);
      if (startMs === null) return;
      const { item } = payload;
      if (OUTPUT_ITEMS.has(item.type) && startMs >= turn.cursorMs) turn.firstOutputMs ??= startMs;
      const label = INNER_TOOLS[item.type]?.(item);
      // 归到它开始时仍在等待输出的最近一次调用（代码模式 exec 内部的真实工具）。
      const owner = label && [...turn.pending.values()].findLast((call) => call.startMs <= startMs);
      if (owner) owner.inner[label] = (owner.inner[label] ?? 0) + 1;
    }
  }

  #responseItem(payload, at) {
    const turn = this.turn;
    if (!turn || turn.endMs !== null || typeof payload.call_id !== "string") return;
    if (TOOL_CALLS.has(payload.type)) {
      const name = [payload.namespace, payload.name].filter(Boolean).join(".") || payload.type;
      turn.pending.set(payload.call_id, { name, startMs: at, inner: {} });
    } else if (TOOL_OUTPUTS.has(payload.type)) {
      const call = turn.pending.get(payload.call_id);
      if (!call) return;
      turn.pending.delete(payload.call_id);
      turn.segments.push({ kind: "tool", name: call.name, inner: call.inner, startMs: call.startMs, endMs: at });
      turn.cursorMs = Math.max(turn.cursorMs, at);
    }
  }

  // 一条 token_usage_record 对应一次模型响应完成：从上一次工具输出（或回合开始）到此刻即模型段。
  // 段内首个 Reasoning/AgentMessage 条目的开始时间近似该次调用的首 token。
  #usage(payload, at) {
    if (payload.thread_token_usage) this.threadUsage = payload.thread_token_usage;
    const turn = this.turn;
    if (!turn || payload.turn_id !== turn.id) return;
    const usage = payload.usage ?? {};
    // 调用记录在流式输出期间写入，但工具在响应完成后才执行。
    for (const call of turn.pending.values()) call.startMs = Math.max(call.startMs, at);
    turn.segments.push({ kind: "model", startMs: turn.cursorMs, endMs: at, firstTokenMs: turn.firstOutputMs,
      outputTokens: finite(usage.output_tokens), reasoningTokens: finite(usage.reasoning_output_tokens) });
    turn.cursorMs = at;
    turn.firstOutputMs = null;
  }

  snapshot(nowMs = Date.now()) {
    // 子代理/分叉会话会在同一毫秒内重放父会话历史回合；它们不属于本会话的时间线。
    const own = this.turns.filter((turn) => turn.segments.length > 0 || turn.endMs === null
      || (turn.status !== "unfinished" && turn.endMs - turn.startMs >= 50));
    const origin = own[0]?.startMs ?? 0;
    const sum = (list, fn) => list.reduce((total, x) => total + (fn(x) ?? 0), 0);
    let decodeTokens = 0;
    let decodeMs = 0;
    const turns = own.map((turn) => {
      const model = turn.segments.filter((s) => s.kind === "model");
      const tools = turn.segments.filter((s) => s.kind === "tool");
      for (const call of model) {
        if (call.firstTokenMs !== null && call.endMs > call.firstTokenMs && call.outputTokens) {
          decodeTokens += call.outputTokens;
          decodeMs += call.endMs - call.firstTokenMs;
        }
      }
      const wallMs = (turn.endMs ?? nowMs) - turn.startMs;
      const toolCounts = {};
      for (const call of tools) {
        const names = Object.keys(call.inner).length ? call.inner : { [call.name]: 1 };
        for (const [name, count] of Object.entries(names)) toolCounts[name] = (toolCounts[name] ?? 0) + count;
      }
      return {
        status: turn.status,
        startS: (turn.startMs - origin) / 1000,
        wallS: wallMs / 1000,
        modelS: sum(model, (s) => s.endMs - s.startMs) / 1000,
        toolS: unionMs(tools) / 1000,
        // 回合内既不在模型调用也不在工具阻塞的时间：审批等待、排队、上下文压缩等。
        otherS: Math.max(0, wallMs - unionMs(turn.segments)) / 1000,
        modelCalls: model.length,
        toolCalls: tools.length,
        ttftMs: turn.ttftMs,
        outputTokens: sum(model, (s) => s.outputTokens),
        reasoningTokens: sum(model, (s) => s.reasoningTokens),
        tools: toolCounts,
        lane: turn.segments.map((s) => ({ kind: s.kind, ...(s.name ? { name: s.name } : {}),
          startS: (s.startMs - origin) / 1000, durationS: (s.endMs - s.startMs) / 1000 }))
      };
    });
    const ttfts = turns.map((t) => t.ttftMs).filter((v) => v !== null);
    return {
      source: "explicit-local-rollout",
      summary: {
        turns: turns.length,
        modelCalls: sum(turns, (t) => t.modelCalls),
        toolCalls: sum(turns, (t) => t.toolCalls),
        wallS: sum(turns, (t) => t.wallS),
        modelS: sum(turns, (t) => t.modelS),
        toolS: sum(turns, (t) => t.toolS),
        tokens: this.threadUsage,
        avgTtftMs: ttfts.length ? ttfts.reduce((a, b) => a + b, 0) / ttfts.length : null,
        // 首个输出条目到响应完成的近似生成速度；rollout 不含逐 token 时间戳，只能近似。
        approxDecodeTps: decodeMs > 0 ? decodeTokens / (decodeMs / 1000) : null
      },
      turns
    };
  }
}

export async function readSessionTimeline(filePath) {
  const timeline = new SessionTimeline();
  const lines = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  for await (const line of lines) {
    try {
      timeline.add(JSON.parse(line));
    } catch {
      // 文件尾可能正在写入半行；未知格式不应被误算成指标。
    }
  }
  return timeline.snapshot();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [flag, file, laneFlag] = process.argv.slice(2);
  if (flag !== "--session-file" || !file) {
    process.stderr.write("用法：node scripts/probe-codex-session-timeline.mjs --session-file /明确指定的/rollout.jsonl [--lanes]\n");
    process.exitCode = 2;
  } else {
    try {
      const result = await readSessionTimeline(file);
      if (laneFlag !== "--lanes") for (const turn of result.turns) delete turn.lane;
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } catch {
      process.stderr.write("无法读取指定的会话文件。\n");
      process.exitCode = 1;
    }
  }
}
