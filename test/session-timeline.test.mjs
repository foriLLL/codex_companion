import test from "node:test";
import assert from "node:assert/strict";
import { SessionTimeline } from "../scripts/probe-codex-session-timeline.mjs";

const T0 = Date.parse("2026-10-28T10:00:00.000Z");
const at = (ms) => new Date(T0 + ms).toISOString();
const event = (ms, payload) => ({ timestamp: at(ms), type: "event_msg", payload });
const item = (ms, startMs, value) => event(ms, { type: "item_completed", turn_id: "t1",
  started_at_ms: T0 + startMs, completed_at_ms: T0 + ms, item: value });
const usage = (ms, output, reasoning, total) => ({ timestamp: at(ms), type: "token_usage_record",
  payload: { turn_id: "t1", usage: { output_tokens: output, reasoning_output_tokens: reasoning },
    thread_token_usage: { total_tokens: total } } });
const response = (ms, payload) => ({ timestamp: at(ms), type: "response_item", payload });

test("按模型调用与工具阻塞区间切分回合，并归并代码模式内部工具", () => {
  const timeline = new SessionTimeline();
  for (const record of [
    event(0, { type: "task_started", turn_id: "t1" }),
    item(3000, 2000, { type: "Reasoning" }),
    response(3500, { type: "custom_tool_call", call_id: "c1", name: "exec" }),
    usage(4000, 100, 40, 1000),
    item(5500, 4200, { type: "CommandExecution" }),
    item(5600, 5000, { type: "FileChange" }),
    response(6000, { type: "custom_tool_call_output", call_id: "c1" }),
    item(7000, 6500, { type: "AgentMessage" }),
    usage(9000, 50, 0, 1200),
    event(9000, { type: "task_complete", turn_id: "t1", time_to_first_token_ms: 2000 })
  ]) timeline.add(record);

  const { summary, turns } = timeline.snapshot();
  assert.equal(summary.turns, 1);
  assert.equal(summary.modelCalls, 2);
  assert.equal(summary.toolCalls, 1);
  assert.equal(summary.modelS, 7);
  // 工具从响应完成（4s）起算，而非流式写入调用记录的 3.5s。
  assert.equal(summary.toolS, 2);
  assert.equal(summary.avgTtftMs, 2000);
  assert.equal(summary.tokens.total_tokens, 1200);
  // (100 + 50) tokens / ((4000-2000) + (9000-6500)) ms
  assert.equal(summary.approxDecodeTps, 150 / 4.5);
  assert.deepEqual(turns[0].tools, { shell: 1, apply_patch: 1 });
  assert.equal(turns[0].otherS, 0);
});

test("重放的父会话回合与无结束事件的回合不会被当作进行中", () => {
  const timeline = new SessionTimeline();
  for (const record of [
    event(0, { type: "task_started", turn_id: "old" }),
    event(0, { type: "task_complete", turn_id: "old", duration_ms: 90000 }),
    event(1, { type: "task_started", turn_id: "parent" }),
    event(60, { type: "task_started", turn_id: "t1" }),
    usage(2000, 10, 0, 10),
    event(2000, { type: "task_complete", turn_id: "t1" })
  ]) timeline.add(record);

  const { turns } = timeline.snapshot();
  assert.deepEqual(turns.map((turn) => turn.status), ["completed"]);
});
