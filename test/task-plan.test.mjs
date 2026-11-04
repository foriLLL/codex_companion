import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPlanEvents, createPlanState, currentPlan, parseLiteral, parsePlanEvents, planSummary, plansFromItem } from "../src/codex-plan.mjs";
import { PLAN_HINT_END, PLAN_HINT_START, createPlanHint, hasHint, withHint, withoutHint } from "../src/codex-plan-hint.mjs";
import { CodexSessions, threadCreatedAt } from "../src/codex-sessions.mjs";
import { createService } from "../src/cards/tasks/service.mjs";
import { ServiceRegistry } from "../src/platform/services/registry.mjs";
import { TaskBoardStorage } from "../src/task-board-storage.mjs";
import { uninstallAgent } from "../src/agent/launch-agent.mjs";
import { assertMode } from "./helpers/permissions.mjs";

const ID = "01a18216-3b02-7db0-b394-9543cce4d535";
const context = { signal: new AbortController().signal };

async function withDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "companion-task-plan-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const event = (timestamp, type, extra = {}) => JSON.stringify({ timestamp, type: "event_msg", payload: { type, ...extra } });
const item = (timestamp, payload) => JSON.stringify({ timestamp, type: "response_item", payload });
// 现在的桌面端：exec 工具的 JS 代码里调用 tools.update_plan。
const execPlan = (timestamp, steps, explanation) => item(timestamp, {
  type: "custom_tool_call", name: "exec", call_id: `c-${timestamp}`,
  input: `const u = await tools.update_plan({\n${explanation ? `  explanation: ${JSON.stringify(explanation)},\n` : ""}  plan: [\n${steps.map(([step, status]) => `    { step: ${JSON.stringify(step)}, status: "${status}" },`).join("\n")}\n  ]\n}); text(u);\n`
});

async function writeRollout(codexHome, id, lines) {
  const created = new Date(threadCreatedAt(id));
  const pad = (value) => String(value).padStart(2, "0");
  const directory = join(codexHome, "sessions", String(created.getFullYear()), pad(created.getMonth() + 1), pad(created.getDate()));
  await mkdir(directory, { recursive: true });
  const path = join(directory, `rollout-2026-10-28T18-37-37-${id}.jsonl`);
  await writeFile(path, lines.length ? `${lines.join("\n")}\n` : "");
  return path;
}

test("JS 字面量：单双引号、模板字符串、未加引号的键、尾逗号与注释；变量和插值放弃", () => {
  assert.deepEqual(parseLiteral(`{ plan: [ { step: '它\\'s "ok"', status: \`pending\` }, ], // 注释\n explanation: "a\\nb\\u4e2d\\u{1F600}" }`),
    { plan: [{ step: "它's \"ok\"", status: "pending" }], explanation: "a\nb中😀" });
  assert.equal(parseLiteral("{ plan: steps }"), null);
  assert.equal(parseLiteral("{ plan: [{ step: `第 ${n} 步`, status: \"pending\" }] }"), null);
  assert.equal(parseLiteral("{ ...base }"), null);
});

test("计划快照：exec 代码与 JSON function_call 两种写法；补丁和变量参数不算", () => {
  const code = "await tools.update_plan({ explanation: '先确认', plan: [{ step: '检查  工作区', status: 'completed' }, { status: 'in_progress', step: '改名' }, { step: '测试', status: 'weird' }] });\nawait tools.update_plan({ plan: [{ step: '只剩一步', status: 'pending' }] });";
  assert.deepEqual(plansFromItem({ type: "custom_tool_call", name: "exec", input: code }), [
    { explanation: "先确认", steps: [{ text: "检查 工作区", status: "completed" }, { text: "改名", status: "in_progress" }, { text: "测试", status: "pending" }] },
    { explanation: null, steps: [{ text: "只剩一步", status: "pending" }] }
  ]);
  assert.deepEqual(plansFromItem({ type: "function_call", name: "update_plan", arguments: JSON.stringify({ plan: [{ step: "旧版", status: "in_progress" }] }) }),
    [{ explanation: null, steps: [{ text: "旧版", status: "in_progress" }] }]);
  assert.deepEqual(plansFromItem({ type: "function_call", name: "exec", arguments: JSON.stringify({ code: "tools.update_plan({ plan: [{ step: '包在 JSON 里', status: 'pending' }] })" }) }),
    [{ explanation: null, steps: [{ text: "包在 JSON 里", status: "pending" }] }]);
  assert.deepEqual(plansFromItem({ type: "custom_tool_call", name: "apply_patch", input: "+tools.update_plan({ plan: [{ step: 'x', status: 'pending' }] })" }), []);
  assert.deepEqual(plansFromItem({ type: "custom_tool_call", name: "exec", input: "await tools.update_plan(plan)" }), []);
  assert.deepEqual(plansFromItem({ type: "custom_tool_call", name: "exec", input: "await tools.update_plan({ plan: [] })" }), []);
});

test("步骤计时：进行中从首次标记算起，直接跳到完成的从前一步完成算起；改措辞按位置对上", () => {
  const state = applyPlanEvents(createPlanState(), parsePlanEvents([
    event("2026-10-28T10:00:00Z", "task_started"),
    execPlan("2026-10-28T10:00:10Z", [["检查", "in_progress"], ["改名", "pending"], ["测试", "pending"]]),
    execPlan("2026-10-28T10:01:10Z", [["检查", "completed"], ["改名", "in_progress"], ["测试", "pending"]], "条件已确认"),
    // 改名完成并顺手做完了「跑测试」（措辞也改了）。
    execPlan("2026-10-28T10:05:10Z", [["检查", "completed"], ["改名", "completed"], ["跑测试", "completed"]]),
    "{坏行"
  ].join("\n")));
  const at = (iso) => Date.parse(iso);
  const plan = currentPlan(state);
  assert.equal(plan.createdAt, at("2026-10-28T10:00:10Z"));
  assert.deepEqual(plan.steps, [
    { text: "检查", status: "completed", start: at("2026-10-28T10:00:10Z"), end: at("2026-10-28T10:01:10Z"), inferred: false },
    { text: "改名", status: "completed", start: at("2026-10-28T10:01:10Z"), end: at("2026-10-28T10:05:10Z"), inferred: false },
    { text: "跑测试", status: "completed", start: at("2026-10-28T10:05:10Z"), end: at("2026-10-28T10:05:10Z"), inferred: true }
  ]);
  assert.equal(plan.explanation, null, "说明取最新一份快照");
  assert.deepEqual(planSummary(plan), { total: 3, done: 3, active: null, steps: plan.steps.map(({ text, status }) => ({ text, status })) });
});

test("计划是否过期：本回合的有效；上个回合没做完的还算；全部完成或更早的过期；大半步骤换了算新计划", () => {
  const state = applyPlanEvents(createPlanState(), parsePlanEvents([
    event("2026-10-28T10:00:00Z", "task_started"),
    execPlan("2026-10-28T10:00:10Z", [["a", "completed"], ["b", "in_progress"]])
  ].join("\n")));
  assert.equal(currentPlan(state).steps[1].status, "in_progress");
  applyPlanEvents(state, [{ type: "turn", at: Date.parse("2026-10-28T10:10:00Z") }]);
  assert.ok(currentPlan(state), "用户中途回复后，上个回合没做完的计划还在");
  applyPlanEvents(state, [{ type: "turn", at: Date.parse("2026-10-28T10:20:00Z") }]);
  assert.equal(currentPlan(state), null, "隔了两个回合就过期");
  applyPlanEvents(state, parsePlanEvents(execPlan("2026-10-28T10:21:00Z", [["a", "pending"], ["x", "pending"], ["y", "pending"]])));
  assert.equal(currentPlan(state).createdAt, Date.parse("2026-10-28T10:21:00Z"), "过期的计划不再接续");
  applyPlanEvents(state, parsePlanEvents(execPlan("2026-10-28T10:21:30Z", [["x", "in_progress"], ["p", "pending"], ["q", "pending"], ["r", "pending"]])));
  assert.equal(currentPlan(state).createdAt, Date.parse("2026-10-28T10:21:30Z"), "相同的步骤不到一半，算新计划");
  applyPlanEvents(state, parsePlanEvents(execPlan("2026-10-28T10:21:40Z", [["x", "in_progress"], ["p", "pending"], ["q2", "pending"]])));
  assert.equal(currentPlan(state).createdAt, Date.parse("2026-10-28T10:21:30Z"), "删改个别步骤仍是同一份计划");
  applyPlanEvents(state, parsePlanEvents(execPlan("2026-10-28T10:22:00Z", [["x", "completed"], ["p", "completed"], ["q2", "completed"]])));
  applyPlanEvents(state, [{ type: "turn", at: Date.parse("2026-10-28T10:30:00Z") }]);
  assert.equal(currentPlan(state), null, "上个回合已经全部完成");
});

test("会话计划：增量读取新增内容，半行留到下次，并发读取不重复计入回合", async (t) => {
  const codexHome = await withDir(t);
  const path = await writeRollout(codexHome, ID, [
    event("2026-10-28T10:00:00Z", "task_started"),
    execPlan("2026-10-28T10:00:10Z", [["检查", "in_progress"], ["改名", "pending"]])
  ]);
  const sessions = new CodexSessions({ codexHome });
  assert.deepEqual((await sessions.plan(ID)).steps.map((step) => step.status), ["in_progress", "pending"]);
  const next = execPlan("2026-10-28T10:02:00Z", [["检查", "completed"], ["改名", "in_progress"]]);
  await appendFile(path, next.slice(0, 40));
  assert.deepEqual((await sessions.plan(ID)).steps.map((step) => step.status), ["in_progress", "pending"], "没写完的一行先不读");
  await appendFile(path, `${next.slice(40)}\n`);
  const [first, second] = await Promise.all([sessions.plan(ID), sessions.plan(ID)]);
  assert.deepEqual(first.steps.map((step) => step.status), ["completed", "in_progress"]);
  assert.deepEqual(second, first);
  await appendFile(path, `${event("2026-10-28T10:03:00Z", "task_complete")}\n${event("2026-10-28T10:04:00Z", "task_started")}\n${event("2026-10-28T10:05:00Z", "task_started")}\n`);
  assert.equal(await sessions.plan(ID), null, "两个回合以前的计划过期");
  assert.equal(await sessions.plan("01a18216-3b02-7db0-b394-000000000000"), null);
});

test("会话计划：长回合开头在 2MB 窗口之外时扩大到 16MB 找回合开头", async (t) => {
  const codexHome = await withDir(t);
  const filler = item("2026-10-28T10:00:20Z", { type: "function_call_output", call_id: "x", output: "x".repeat(4000) });
  await writeRollout(codexHome, ID, [
    event("2026-10-28T10:00:00Z", "task_started"),
    execPlan("2026-10-28T10:00:10Z", [["很早列的计划", "in_progress"]]),
    ...Array.from({ length: 700 }, () => filler)
  ]);
  const plan = await new CodexSessions({ codexHome }).plan(ID);
  assert.equal(plan.steps[0].text, "很早列的计划");
});

test("看板与 Trace 带上计划：条目给摘要，Trace 给每步起止时间", async (t) => {
  const dir = await withDir(t);
  const codexHome = join(dir, "codex");
  await writeRollout(codexHome, ID, [
    event("2026-10-28T10:00:00Z", "task_started"),
    item("2026-10-28T10:00:05Z", { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "我先看看工作区" }] }),
    execPlan("2026-10-28T10:00:10Z", [["检查", "completed"], ["改名", "in_progress"], ["测试", "pending"]])
  ]);
  const service = createService({ taskBoard: new TaskBoardStorage({ path: join(dir, "board.json") }), codexSessions: new CodexSessions({ codexHome, now: () => Date.parse("2026-10-28T10:01:00Z") }) });
  const board = await service.methods.add({ threadId: ID, title: "改名" }, context);
  assert.deepEqual(board.tasks[0].plan, { total: 3, done: 1, active: 1, steps: [{ text: "检查", status: "completed" }, { text: "改名", status: "in_progress" }, { text: "测试", status: "pending" }] });
  const trace = await service.methods.trace({ threadId: ID }, context);
  assert.equal(trace.plan.steps[1].start, Date.parse("2026-10-28T10:00:10Z"));
  assert.deepEqual(trace.turns.at(-1).notes, [{ at: Date.parse("2026-10-28T10:00:05Z"), text: "我先看看工作区" }]);
});

test("提示块：加上与删除都保留原有文字，重复加入不叠加，旧版说明文字也能认出", () => {
  const original = "# 我的习惯\n\n- 用中文回答\n";
  const added = withHint(original);
  assert.ok(added.startsWith(original) && hasHint(added));
  assert.equal(withHint(added), added);
  assert.equal(withoutHint(added), original);
  assert.equal(withoutHint(original), original);
  assert.equal(withoutHint(withHint("")), "");
  const middle = `前面\n\n${PLAN_HINT_START}\n旧内容\n${PLAN_HINT_END}\n后面\n`;
  assert.equal(withoutHint(middle), "前面\n\n后面\n");
  const older = "前面\n\n<!-- codex-companion:plan-hint 旧说明 -->\n旧内容\n<!-- /codex-companion:plan-hint -->\n";
  assert.equal(withoutHint(older), "前面\n");
});

test("提示开关：写进 Codex 实际读取的文件，跟随符号链接、保留权限；关掉后删掉自己新建的文件", async (t) => {
  const codexHome = await withDir(t);
  const hint = createPlanHint({ codexHome });
  assert.equal(await hint.set(false), false, "没有文件时关闭什么也不做");
  await assert.rejects(stat(join(codexHome, "AGENTS.md")), { code: "ENOENT" });
  assert.equal(await hint.set(true), true);
  assert.deepEqual(await hint.status(), { enabled: true, path: join(codexHome, "AGENTS.md") });
  assert.equal(await hint.set(true), false, "已经有了不再改写");
  assert.equal(await hint.set(false), true);
  await assert.rejects(stat(join(codexHome, "AGENTS.md")), { code: "ENOENT" }, "文件是开关新建的，关掉后删除");

  // 用户的 AGENTS.md 是指向 dotfiles 的链接，权限 0600。
  const real = join(codexHome, "dotfiles.md");
  await writeFile(real, "我的规则\n", { mode: 0o600 });
  await symlink(real, join(codexHome, "AGENTS.md"));
  await hint.set(true);
  assert.ok(hasHint(await readFile(real, "utf8")));
  assertMode(await stat(real), 0o600);
  await hint.set(false);
  assert.equal(await readFile(real, "utf8"), "我的规则\n");

  // AGENTS.override.md 非空时 Codex 只读它。
  await writeFile(join(codexHome, "AGENTS.override.md"), "覆盖\n");
  await hint.set(true);
  assert.ok(hasHint(await readFile(join(codexHome, "AGENTS.override.md"), "utf8")));
  assert.equal(await readFile(real, "utf8"), "我的规则\n");
  await hint.set(false);
  assert.equal(await readFile(join(codexHome, "AGENTS.override.md"), "utf8"), "覆盖\n");
});

test("任务看板服务：只在配置明确给出开关时动文件，看板或 Companion 停用时删除；平台把配置转给卡片服务", async () => {
  const calls = [];
  const service = createService({ planHint: { set: async (value) => { calls.push(value); return true; } } });
  await service.applyConfig({ enabled: true, cards: { tasks: { enabled: true, settings: {} } } });
  assert.deepEqual(calls, [], "没碰过开关不读不写");
  await service.applyConfig({ enabled: true, cards: { tasks: { enabled: true, settings: { planHint: true } } } });
  await service.applyConfig({ enabled: true, cards: { tasks: { enabled: true, settings: { planHint: true, switcher: false } } } });
  await service.applyConfig({ enabled: true, cards: { tasks: { enabled: false, settings: { planHint: true } } } });
  await service.applyConfig({ enabled: false, cards: { tasks: { enabled: true, settings: { planHint: true } } } });
  await service.applyConfig({ enabled: true, cards: { tasks: { enabled: true, settings: { planHint: true } } } });
  assert.deepEqual(calls, [true, false, true], "期望值不变时不重复改写");

  const seen = [];
  const warnings = [];
  const registry = new ServiceRegistry({
    manifests: [{ id: "broken", defaultEnabled: true }, { id: "fine", defaultEnabled: true }],
    modules: {
      broken: { createService: () => ({ applyConfig: async () => { throw Object.assign(new Error("x"), { code: "EACCES" }); } }) },
      fine: { createService: () => ({ applyConfig: async (config) => seen.push(config.revision) }) }
    },
    loadConfig: async () => ({}), logger: { warn: (message) => warnings.push(message) }
  });
  await registry.applyConfig({ revision: 7, enabled: true, cards: {} });
  assert.deepEqual(seen, [7], "一张卡失败不影响其它卡");
  assert.match(warnings[0], /broken.*EACCES/);
});

test("卸载时删掉提示，只动带标记的那一段", async (t) => {
  const home = await withDir(t);
  await mkdir(join(home, ".codex"), { recursive: true });
  await writeFile(join(home, ".codex", "AGENTS.md"), withHint("我的规则\n"));
  const result = await uninstallAgent({ hostPlatform: "darwin", home, env: {}, helperPath: null, uid: 501, label: "local.test.agent",
    runtimeState: { load: async () => null }, execFileImpl: async () => {} });
  assert.equal(result.planHintRemoved, true);
  assert.equal(await readFile(join(home, ".codex", "AGENTS.md"), "utf8"), "我的规则\n");
});
