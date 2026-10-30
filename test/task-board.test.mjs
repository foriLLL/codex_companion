import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CodexSessions, parseTrace, STALLED_AFTER_MS, defaultCodexHome, endsWithQuestion, lastLifecycle, threadCreatedAt } from "../src/codex-sessions.mjs";
import { TaskBoardStorage, pickColor } from "../src/task-board-storage.mjs";
import { createService } from "../src/cards/tasks/service.mjs";
import { assertMode } from "./helpers/permissions.mjs";

// 01a18216-3b02 → 2026-10-28T10:37:37.410Z
const ID = "01a18216-3b02-7db0-b394-9543cce4d535";
const OTHER = "01a16ee9-4db8-79e2-87a3-af994b758350";
const context = { signal: new AbortController().signal };

async function withDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "companion-task-board-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const event = (timestamp, type, extra = {}) => JSON.stringify({ timestamp, type: "event_msg", payload: { type, ...extra } });
const pick = ({ status, at }) => ({ status, at });
const item = (timestamp, payload) => JSON.stringify({ timestamp, type: "response_item", payload });

async function writeRollout(codexHome, id, lines, { day } = {}) {
  const created = new Date(threadCreatedAt(id));
  const pad = (value) => String(value).padStart(2, "0");
  const directory = join(codexHome, "sessions", String(created.getFullYear()), pad(created.getMonth() + 1), day ?? pad(created.getDate()));
  await mkdir(directory, { recursive: true });
  const path = join(directory, `rollout-2026-10-28T18-37-37-${id}.jsonl`);
  await writeFile(path, `${lines.join("\n")}\n`);
  return path;
}

test("UUIDv7 会话 id 解析出创建时间；CODEX_HOME 只接受绝对路径", () => {
  assert.equal(new Date(threadCreatedAt(ID)).toISOString(), "2026-10-28T10:37:37.410Z");
  assert.equal(threadCreatedAt("not-a-uuid"), null);
  assert.equal(defaultCodexHome({ env: { CODEX_HOME: "/x/codex" }, home: "/h" }), "/x/codex");
  assert.equal(defaultCodexHome({ env: { CODEX_HOME: "relative" }, home: "/h" }), join("/h", ".codex"));
});

test("只取最后一个回合事件，截断行和其它记录被忽略", () => {
  const text = [
    "ated\":true}}",
    event("2026-10-28T10:00:00Z", "task_started"),
    JSON.stringify({ timestamp: "2026-10-28T10:00:01Z", type: "response_item", payload: { type: "message", content: "task_complete" } }),
    event("2026-10-28T10:05:00Z", "task_complete"),
    event("2026-10-28T10:06:00Z", "task_started"),
    event("2026-10-28T10:07:00Z", "token_count")
  ].join("\n");
  assert.deepEqual(pick(lastLifecycle(text)), { status: "running", at: Date.parse("2026-10-28T10:06:00Z") });
  assert.equal(lastLifecycle("{}\n"), null);
});

test("以问句收尾或有未回答的提问时为 asking", () => {
  assert.equal(endsWithQuestion("改好了。\n\n要我顺手提交吗？"), true);
  assert.equal(endsWithQuestion("Should I push it?**"), true);
  assert.equal(endsWithQuestion("为什么会这样？我查了一下，已经修好。"), false);
  assert.equal(endsWithQuestion(null), false);
  const asked = [event("2026-10-28T10:00:00Z", "task_started"), event("2026-10-28T10:01:00Z", "task_complete", { last_agent_message: "选 A 还是 B？" })];
  assert.deepEqual(pick(lastLifecycle(asked.join("\n"))), { status: "asking", at: Date.parse("2026-10-28T10:01:00Z") });
  const started = event("2026-10-28T10:00:00Z", "task_started");
  // 同步提问：工具输出就是回答。
  const sync = item("2026-10-28T10:00:30Z", { type: "function_call", name: "request_user_input", call_id: "s1" });
  assert.equal(lastLifecycle([started, sync].join("\n")).status, "asking");
  const syncAnswer = item("2026-10-28T10:00:40Z", { type: "function_call_output", call_id: "s1", output: "A" });
  assert.equal(lastLifecycle([started, sync, syncAnswer].join("\n")).status, "running");
  // 异步提问：输出立即返回 accepted，用户回答以 question_reply 消息回来才算答完。
  const call = item("2026-10-28T10:00:30Z", { type: "function_call", name: "request_user_input_async", call_id: "c1" });
  const accepted = item("2026-10-28T10:00:31Z", { type: "function_call_output", call_id: "c1", output: "{\"accepted\":true}" });
  const working = item("2026-10-28T10:00:35Z", { type: "reasoning" });
  assert.deepEqual([lastLifecycle([started, call, accepted, working].join("\n"))].map(({ status, activity }) => [status, activity]), [["asking", "在等你回答"]]);
  const reply = item("2026-10-28T10:01:00Z", { type: "message", role: "user", content: [{ type: "input_text", text: "<send_user_message_question_reply>\n[{\"questionItemId\":\"[\\\"request_user_input_async\\\",\\\"c1\\\",0]\",\"answer\":\"A\"}]" }] });
  assert.equal(lastLifecycle([started, call, accepted, working, reply].join("\n")).status, "running");
  assert.equal(lastLifecycle([call, event("2026-10-28T10:02:00Z", "task_started")].join("\n")).status, "running", "新回合清掉旧提问");
  // 异步提问后又补一句并结束回合：问题卡仍挂着，摘要取问题标题而不是补的那句。
  const titled = item("2026-10-28T10:00:30Z", { type: "function_call", name: "request_user_input_async", call_id: "c1", arguments: JSON.stringify({ questions: [{ title: "哪种时刻最让你觉得值？", options: ["A", "B"] }] }) });
  const done = event("2026-10-28T10:00:40Z", "task_complete", { last_agent_message: "挑最让你有成就感的那个。" });
  assert.deepEqual([lastLifecycle([started, titled, accepted, done].join("\n"))].map(({ status, summary }) => [status, summary]), [["asking", "哪种时刻最让你觉得值？"]]);
  assert.equal(lastLifecycle([started, titled, accepted, reply, done].join("\n")).status, "idle", "答完后回合结束就是普通回复");
  assert.equal(lastLifecycle([started, titled, accepted, event("2026-10-28T10:00:40Z", "turn_aborted")].join("\n")).status, "interrupted");
  // 尾部窗口里只有回合内条目：回合开始在窗口之前，仍在进行；异步提问照样识别。
  assert.equal(lastLifecycle([working].join("\n")), null, "不确定是窗口时不猜");
  assert.equal(lastLifecycle([working].join("\n"), { inTurn: true }).status, "running");
  assert.equal(lastLifecycle([call, accepted].join("\n"), { inTurn: true }).status, "asking");
});

test("按创建日期定位 rollout，并区分进行中、等你回复、中断与无响应", async (t) => {
  const codexHome = await withDir(t);
  let now = Date.now();
  const sessions = new CodexSessions({ codexHome, now: () => now });
  const path = await writeRollout(codexHome, ID, [event("2026-10-28T10:00:00Z", "task_started")]);
  assert.equal((await sessions.status(ID)).status, "running");
  await writeFile(path, `${event("2026-10-28T10:00:00Z", "task_started")}\n${event("2026-10-28T10:01:00Z", "task_complete")}\n`);
  assert.equal((await sessions.status(ID)).status, "idle");
  await writeFile(path, `${event("2026-10-28T10:00:00Z", "task_started")}\n${event("2026-10-28T10:01:00Z", "turn_aborted")}\n`);
  assert.equal((await sessions.status(ID)).status, "interrupted");
  await writeFile(path, `${event("2026-10-28T10:00:00Z", "task_started")}\n`);
  const old = new Date(now - STALLED_AFTER_MS - 60_000);
  await utimes(path, old, old);
  const stalled = await sessions.status(ID);
  assert.equal(stalled.status, "stalled");
  assert.equal(stalled.updatedAt, Math.round((await stat(path)).mtimeMs));
  now += 1;
  assert.equal(await sessions.locate(ID), path, "命中缓存路径");
});

test("日期目录对不上时回退遍历；找不到时区分已归档与缺失", async (t) => {
  const codexHome = await withDir(t);
  const sessions = new CodexSessions({ codexHome });
  const path = await writeRollout(codexHome, ID, [event("2026-10-28T10:00:00Z", "task_complete")], { day: "01" });
  assert.equal(await sessions.locate(ID), path);
  assert.deepEqual(await sessions.status(OTHER), { status: "missing", updatedAt: null, turnAt: null, activity: null, summary: null });
  await mkdir(join(codexHome, "archived_sessions"), { recursive: true });
  await writeFile(join(codexHome, "archived_sessions", `rollout-2026-10-25T01-15-48-${OTHER}.jsonl.zst`), "");
  assert.equal((await new CodexSessions({ codexHome }).status(OTHER)).status, "archived");
});

test("session_index 同一会话取最后一次的名字，并按文件变化缓存", async (t) => {
  const codexHome = await withDir(t);
  const sessions = new CodexSessions({ codexHome });
  assert.equal((await sessions.titles()).size, 0);
  const index = join(codexHome, "session_index.jsonl");
  await writeFile(index, [
    JSON.stringify({ id: ID, thread_name: "Respond to greeting" }),
    "{broken",
    JSON.stringify({ id: ID, thread_name: "  排查 Chrome 无痕模式差异 " }),
    JSON.stringify({ id: OTHER, thread_name: "" })
  ].join("\n"));
  const titles = await sessions.titles();
  assert.equal(titles.get(ID), "排查 Chrome 无痕模式差异");
  assert.equal(titles.has(OTHER), false);
  assert.equal(await sessions.titles(), titles);
});

test("看板 0600 原子写；无改动不增加 revision；颜色取最少使用的", async (t) => {
  const dir = await withDir(t);
  const storage = new TaskBoardStorage({ path: join(dir, "nested", "task-board.json") });
  assert.deepEqual(await storage.load(), { revision: 0, tasks: [] });
  const saved = await storage.mutate(() => [{ threadId: ID, suggestedName: " a  b ", customName: "", color: 3, projectId: "/p", addedAt: 1 }, { threadId: "bad id" }]);
  assert.equal(saved.revision, 1);
  assert.deepEqual(saved.tasks, [{ threadId: ID, suggestedName: "a b", customName: null, color: 3, projectId: "/p", addedAt: 1, seenAt: 1 }]);
  assertMode(await stat(storage.path), 0o600);
  assert.equal((await storage.mutate(() => null)).revision, 1);
  await writeFile(storage.path, "{broken");
  assert.deepEqual(await storage.load(), { revision: 0, tasks: [] });
  assert.equal(pickColor([]), 0);
  assert.equal(pickColor([{ color: 0 }, { color: 1 }, { color: 0 }]), 2);
});

async function serviceFixture(t, options = {}) {
  const dir = await withDir(t);
  const codexHome = join(dir, "codex");
  await mkdir(codexHome);
  const rolloutPath = await writeRollout(codexHome, ID, [event("2026-10-28T10:00:00Z", "task_started"), event("2026-10-28T10:01:00Z", "task_complete")]);
  await writeFile(join(codexHome, "session_index.jsonl"), `${JSON.stringify({ id: ID, thread_name: "Codex 起的名字" })}\n`);
  const opened = [];
  const taskBoard = new TaskBoardStorage({ path: join(dir, "task-board.json") });
  const service = createService({
    taskBoard, codexSessions: new CodexSessions({ codexHome }), openThread: async (id) => { opened.push(id); }, ...options
  });
  return { service, taskBoard, opened, rolloutPath, call: (method, params = {}) => service.methods[method](params, context) };
}

test("加入看板默认用推荐名，可改名，留空回到推荐名；重复加入不改动", async (t) => {
  const { call, taskBoard } = await serviceFixture(t);
  const empty = await call("list");
  assert.deepEqual([empty.revision, empty.tasks], [0, []]);
  let board = await call("add", { threadId: ID, title: "侧栏标题", projectId: "/repo" });
  assert.equal(board.revision, 1);
  assert.equal(board.tasks[0].name, "Codex 起的名字", "session_index 的最新名字优先于加入时的侧栏标题");
  assert.equal(board.tasks[0].status, "idle");
  assert.equal(board.tasks[0].projectId, "/repo");
  assert.equal((await call("add", { threadId: ID, title: "again" })).revision, 1);
  board = await call("rename", { threadId: ID, name: "  重构播放器  " });
  assert.equal(board.tasks[0].name, "重构播放器");
  assert.equal(board.tasks[0].customName, "重构播放器");
  board = await call("rename", { threadId: ID, name: null });
  assert.equal(board.tasks[0].name, "Codex 起的名字");
  assert.equal(board.tasks[0].customName, null);
  board = await call("add", { threadId: OTHER, title: "第二个任务" });
  assert.deepEqual(board.tasks.map((task) => [task.threadId, task.name, task.status, task.color]), [
    [OTHER, "第二个任务", "missing", 1], [ID, "Codex 起的名字", "idle", 0]
  ]);
  assert.equal((await taskBoard.load()).tasks.length, 2, "任务长期保留在数据文件里");
});

test("完成即移出，可按原位置撤销；参数严格校验", async (t) => {
  const { call } = await serviceFixture(t);
  await call("add", { threadId: ID, title: "一" });
  await call("add", { threadId: OTHER, title: "二" });
  await call("rename", { threadId: ID, name: "自定义" });
  const removed = await call("remove", { threadId: ID });
  assert.deepEqual(removed.tasks.map((task) => task.threadId), [OTHER]);
  assert.equal(removed.removed.index, 1);
  const restored = await call("restore", removed.removed);
  assert.deepEqual(restored.tasks.map((task) => [task.threadId, task.name, task.color]), [[OTHER, "二", 1], [ID, "自定义", 0]]);
  assert.equal((await call("remove", { threadId: "01a10000-0000-7000-8000-000000000000" })).removed, null);
  await assert.rejects(call("add", { threadId: "../etc" }), { code: "RPC_INVALID_PARAMS" });
  await assert.rejects(call("add", { threadId: ID, extra: 1 }), { code: "RPC_INVALID_PARAMS" });
  await assert.rejects(call("rename", { threadId: ID, name: 1 }), { code: "RPC_INVALID_PARAMS" });
  await assert.rejects(call("restore", { task: { threadId: ID }, index: -1 }), { code: "RPC_INVALID_PARAMS" });
});

test("换颜色；回合结束后未读，看过之后已读且已读时间只往后推", async (t) => {
  const { call } = await serviceFixture(t);
  let board = await call("add", { threadId: ID, title: "一" });
  // 回合在 2026-10-28 结束，早于加入时间，加入即视为已看过。
  assert.equal(board.tasks[0].unread, false);
  assert.equal(board.tasks[0].turnAt, Date.parse("2026-10-28T10:01:00Z"));
  board = await call("recolor", { threadId: ID, color: 7 });
  assert.equal(board.tasks[0].color, 7);
  await assert.rejects(call("recolor", { threadId: ID, color: 8 }), { code: "RPC_INVALID_PARAMS" });
  board = await call("restore", { task: { ...(await call("remove", { threadId: ID })).removed.task, seenAt: 5 }, index: 0 });
  assert.equal(board.tasks[0].unread, true, "已读时间早于回合结束");
  board = await call("seen", { threadId: ID, at: board.tasks[0].turnAt });
  assert.equal(board.tasks[0].unread, false);
  assert.equal((await call("seen", { threadId: ID, at: 10 })).revision, board.revision, "更早的已读时间不覆盖");
  await assert.rejects(call("seen", { threadId: ID, at: Date.now() + 3_600_000 }), { code: "RPC_INVALID_PARAMS" });
});

test("长轮询：内容没变时挂起，会话记录追加后立即返回新的进度", async (t) => {
  const { call, rolloutPath } = await serviceFixture(t);
  const first = await call("add", { threadId: ID, title: "一" });
  assert.equal(first.tasks[0].summary, null);
  const quiet = Date.now();
  assert.equal((await call("watch", { since: first.sig, waitMs: 400 })).sig, first.sig);
  assert.ok(Date.now() - quiet >= 350, "没变化时等满 waitMs");
  const immediate = Date.now();
  assert.equal((await call("watch", { since: "stale", waitMs: 5000 })).sig, first.sig, "since 不同立即返回");
  assert.ok(Date.now() - immediate < 300);
  const waiting = call("watch", { since: first.sig, waitMs: 5000 });
  await new Promise((resolve) => setTimeout(resolve, 100));
  await appendFile(rolloutPath, `${event("2026-10-28T10:05:00Z", "task_started")}\n${item("2026-10-28T10:05:01Z", { type: "custom_tool_call", name: "exec", call_id: "c", input: "await tools.exec_command({cmd:\"npm test\"})" })}\n`);
  const started = Date.now();
  const next = await waiting;
  assert.ok(Date.now() - started < 1500, "变化后很快返回");
  assert.equal(next.tasks[0].status, "running");
  assert.equal(next.tasks[0].activity, "运行 npm test");
  await assert.rejects(call("watch", { since: 1 }), { code: "RPC_INVALID_PARAMS" });
});

test("进度：工具调用、改文件、进度说明与回复摘要", () => {
  const turn = (...lines) => [event("2026-10-28T10:00:00Z", "task_started"), ...lines].join("\n");
  const say = (text) => item("2026-10-28T10:00:01Z", { type: "message", role: "assistant", content: [{ type: "output_text", text }] });
  const tool = (input) => item("2026-10-28T10:00:02Z", { type: "custom_tool_call", name: "exec", call_id: "x", input });
  const output = item("2026-10-28T10:00:03Z", { type: "custom_tool_call_output", call_id: "x", output: "很长的输出" });
  const reasoning = item("2026-10-28T10:00:04Z", { type: "reasoning" });
  assert.equal(lastLifecycle(turn()).activity, "思考中");
  assert.equal(lastLifecycle(turn(tool("const patch = \"*** Begin Patch\\n*** Update File: /repo/src/a.mjs\\n@@\""))).activity, "修改 a.mjs");
  assert.equal(lastLifecycle(turn(say("**先确认**当前分支。\n细节"), tool("x"), output, reasoning)).activity, "先确认当前分支。", "思考间隙显示最近的进度说明");
  const done = lastLifecycle([turn(), event("2026-10-28T10:01:00Z", "task_complete", { last_agent_message: "已完成：[报告](/a/b.md)\n- 第二行" })].join("\n"));
  assert.deepEqual([done.status, done.summary, done.activity], ["idle", "已完成：报告", undefined]);
  const asked = lastLifecycle([turn(), event("2026-10-28T10:01:00Z", "task_complete", { last_agent_message: "改好了。\n\n要我顺手提交吗？" })].join("\n"));
  assert.deepEqual([asked.status, asked.summary], ["asking", "要我顺手提交吗？"]);
});

test("Trace：思考、回复、工具首尾相接，token 挂在响应最后一段，进行中留开放段", () => {
  const say = (at, text) => item(at, { type: "message", role: "assistant", content: [{ type: "output_text", text }] });
  const tokens = (at, output, reasoning) => JSON.stringify({ timestamp: at, type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 900, output_tokens: output, reasoning_output_tokens: reasoning }, model_context_window: 1000 } } });
  const output = (at, callId, text) => JSON.stringify({ timestamp: at, type: "response_item", payload: { type: "custom_tool_call_output", call_id: callId, output: [{ type: "input_text", text }] } });
  const { model, contextWindow, turns } = parseTrace([
    JSON.stringify({ timestamp: "2026-10-28T10:00:00Z", type: "turn_context", payload: { model: "gpt-x" } }),
    event("2026-10-28T10:00:00Z", "task_started"),
    item("2026-10-28T10:00:04Z", { type: "reasoning" }),
    item("2026-10-28T10:00:06Z", { type: "reasoning" }),
    say("2026-10-28T10:00:08Z", "先跑测试。"),
    item("2026-10-28T10:00:09Z", { type: "custom_tool_call", name: "exec", call_id: "a", input: "tools.exec_command({cmd:\"npm test\"})" }),
    tokens("2026-10-28T10:00:10Z", 90, 30),
    output("2026-10-28T10:00:15Z", "a", "Script failed\nOutput:"),
    item("2026-10-28T10:00:18Z", { type: "custom_tool_call", name: "exec", call_id: "b", input: "\"*** Update File: /r/a.mjs\"" }),
    tokens("2026-10-28T10:00:18Z", 40, 0),
    output("2026-10-28T10:00:19Z", "b", "Script completed"),
    event("2026-10-28T10:00:25Z", "task_complete", { last_agent_message: "要提交吗？", time_to_first_token_ms: 1200 }),
    event("2026-10-28T10:01:00Z", "task_started"),
    item("2026-10-28T10:01:02Z", { type: "reasoning" })
  ].join("\n"));
  assert.deepEqual([model, contextWindow, turns.length], ["gpt-x", 1000, 2]);
  const [done, live] = turns;
  const sec = (ms) => ms === null ? null : (ms - Date.parse("2026-10-28T10:00:00Z")) / 1000;
  assert.deepEqual(done.segments.map(({ lane, kind, start, end, failed }) => [lane, kind, sec(start), sec(end), failed ?? null]), [
    ["model", "think", 0, 6, null], ["model", "reply", 6, 8, null], ["model", "call", 8, 9, null],
    ["shell", "tool", 10, 15, true], ["model", "call", 15, 18, null], ["edit", "tool", 18, 19, false]
  ], "连续思考合并；工具在响应结束后才开始");
  assert.deepEqual(done.segments[2].tokens, { output: 90, reasoning: 30, perSecond: 10 });
  assert.equal(done.segments[2].label, "准备运行 npm test");
  assert.deepEqual([done.status, done.asking, done.ttftMs, done.tokens.output], ["done", true, 1200, 130]);
  assert.deepEqual(live.segments.map(({ kind, end }) => [kind, end === null]), [["think", false], ["think", true]].slice(0, live.segments.length));
  assert.equal(live.segments.at(-1).end, null, "进行中的回合留一段开放的思考");
  assert.equal(live.status, "running");
});

test("Trace 长轮询：会话记录追加后返回新的段", async (t) => {
  const { call, rolloutPath } = await serviceFixture(t);
  const first = await call("trace", { threadId: ID });
  assert.equal(first.turns.length, 1);
  const waiting = call("trace", { threadId: ID, since: first.sig, waitMs: 5000 });
  await new Promise((resolve) => setTimeout(resolve, 100));
  await appendFile(rolloutPath, `${event("2026-10-28T10:05:00Z", "task_started")}\n`);
  const next = await waiting;
  assert.notEqual(next.sig, first.sig);
  assert.equal(next.turns.at(-1).status, "running");
  await assert.rejects(call("trace", { threadId: "nope" }), { code: "RPC_INVALID_PARAMS" });
});

test("深链兜底只接受合法会话 id", async (t) => {
  const { call, opened } = await serviceFixture(t);
  assert.deepEqual(await call("open", { threadId: ID }), { opened: true });
  assert.deepEqual(opened, [ID]);
  await assert.rejects(call("open", { threadId: "x;rm" }), { code: "RPC_INVALID_PARAMS" });
});

test("看板文件只含白名单字段", async (t) => {
  const { call, taskBoard } = await serviceFixture(t);
  await call("add", { threadId: ID, title: "一", projectId: "/repo" });
  const saved = JSON.parse(await readFile(taskBoard.path, "utf8"));
  assert.deepEqual(Object.keys(saved), ["version", "revision", "tasks"]);
  assert.deepEqual(Object.keys(saved.tasks[0]).sort(), ["addedAt", "color", "customName", "projectId", "seenAt", "suggestedName", "threadId"]);
});

test("新建会话的客户端临时 id 按 Codex 绑定换成真实 id，看板两个 id 都认", async (t) => {
  const CLIENT = "55df1b41-eb1f-4317-a606-7543ae182ba0";
  const { call, opened, taskBoard } = await serviceFixture(t);
  const codexHome = join(dirname(taskBoard.path), "codex");
  const statePath = join(codexHome, ".codex-global-state.json");
  // 还没绑定：按原 id 存，状态为缺失。
  let board = await call("add", { threadId: CLIENT, title: "新会话" });
  assert.deepEqual(board.tasks.map((task) => [task.threadId, task.status, task.aliases]), [[CLIENT, "missing", []]]);
  // 发出第一条消息后 Codex 写入绑定：存量任务按真实 id 读状态，并带上别名。
  await writeFile(statePath, JSON.stringify({ "electron-persisted-atom-state": {
    "client-thread-bindings-v1": { [`client-new-thread:${CLIENT}`]: ID, "client-new-thread:bad id": ID }
  } }));
  board = await call("list");
  assert.deepEqual(board.tasks.map((task) => [task.threadId, task.status, task.name, task.aliases]), [[CLIENT, "idle", "Codex 起的名字", [ID]]]);
  assert.equal((await call("trace", { threadId: CLIENT })).turns.length > 0, true, "Trace 也能按客户端 id 读到记录");
  await call("open", { threadId: CLIENT });
  assert.deepEqual(opened, [ID], "深链用真实 id");
  // 已绑定时加入：存真实 id；客户端 id 与真实 id 都视为同一任务。
  await call("remove", { threadId: CLIENT });
  board = await call("add", { threadId: CLIENT, title: "新会话" });
  assert.deepEqual(board.tasks.map((task) => [task.threadId, task.aliases]), [[ID, [CLIENT]]]);
  assert.equal((await call("add", { threadId: ID })).tasks.length, 1);
});
