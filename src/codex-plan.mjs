// Codex 自带计划工具 update_plan 的解析。每次调用都是一份完整快照：步骤、各步状态和一句说明。
// 现在的桌面端把它写在 exec 工具的 JS 代码里（tools.update_plan({...})），旧版本是参数为 JSON 的
// function_call。这里把快照串起来，推算每一步什么时候开始、什么时候完成。只读，不落盘。

export const PLAN_STATUSES = Object.freeze(["pending", "in_progress", "completed"]);
const MAX_STEPS = 50;
const TEXT_LIMIT = 200;
const EXPLANATION_LIMIT = 300;
const ESCAPES = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", 0: "\0" };

function clean(value, limit) {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/**
 * JS 对象字面量 → 值。只认 update_plan 参数里会出现的写法：单双引号与无插值的模板字符串、
 * 未加引号的键、尾逗号、注释。遇到变量、函数调用、展开或插值就放弃，返回 null。
 */
export function parseLiteral(source) {
  if (typeof source !== "string") return null;
  let out = "";
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === "\"" || char === "'" || char === "`") {
      let value = "";
      let cursor = index + 1;
      while (cursor < source.length && source[cursor] !== char) {
        const current = source[cursor];
        if (char === "`" && current === "$" && source[cursor + 1] === "{") return null;
        if (current !== "\\") { value += current; cursor += 1; continue; }
        const next = source[cursor + 1];
        if (next === "u") {
          const braced = source.slice(cursor + 2).match(/^\{([0-9a-fA-F]{1,6})\}/);
          const plain = source.slice(cursor + 2, cursor + 6);
          if (braced) { value += String.fromCodePoint(Number.parseInt(braced[1], 16)); cursor += 3 + braced[1].length + 1; continue; }
          if (!/^[0-9a-fA-F]{4}$/.test(plain)) return null;
          value += String.fromCharCode(Number.parseInt(plain, 16));
          cursor += 6;
          continue;
        }
        if (next === "x") {
          const hex = source.slice(cursor + 2, cursor + 4);
          if (!/^[0-9a-fA-F]{2}$/.test(hex)) return null;
          value += String.fromCharCode(Number.parseInt(hex, 16));
          cursor += 4;
          continue;
        }
        // 反斜杠加换行是续行，不产生字符。
        if (next !== "\n") value += ESCAPES[next] ?? next ?? "";
        cursor += 2;
      }
      if (cursor >= source.length) return null;
      out += JSON.stringify(value);
      index = cursor + 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(char)) {
      let cursor = index;
      while (cursor < source.length && /[\w$]/.test(source[cursor])) cursor += 1;
      const word = source.slice(index, cursor);
      let after = cursor;
      while (after < source.length && /\s/.test(source[after])) after += 1;
      if (source[after] === ":") out += JSON.stringify(word);
      else if (word === "true" || word === "false" || word === "null") out += word;
      else return null;
      index = cursor;
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      const end = source.indexOf("\n", index);
      index = end < 0 ? source.length : end;
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      if (end < 0) return null;
      index = end + 2;
      continue;
    }
    if (char === ",") {
      let after = index + 1;
      while (after < source.length && /\s/.test(source[after])) after += 1;
      if (source[after] === "}" || source[after] === "]") { index += 1; continue; }
    }
    out += char;
    index += 1;
  }
  try { return JSON.parse(out); } catch { return null; }
}

// exec 代码里每次 tools.update_plan(...) 括号内的参数文本，跳过字符串里的括号。
function callArguments(code) {
  const results = [];
  const pattern = /\btools\.update_plan\s*\(/g;
  let match;
  while ((match = pattern.exec(code))) {
    const start = match.index + match[0].length;
    let depth = 1;
    let quote = null;
    let index = start;
    for (; index < code.length && depth > 0; index += 1) {
      const char = code[index];
      if (quote) {
        if (char === "\\") index += 1;
        else if (char === quote) quote = null;
        continue;
      }
      if (char === "\"" || char === "'" || char === "`") quote = char;
      else if (char === "(" || char === "{" || char === "[") depth += 1;
      else if (char === ")" || char === "}" || char === "]") depth -= 1;
    }
    if (depth === 0) results.push(code.slice(start, index - 1));
    pattern.lastIndex = index;
  }
  return results;
}

/** update_plan 参数 → { explanation, steps: [{ text, status }] }；没有有效步骤时返回 null。 */
export function normalizePlan(input) {
  if (!input || typeof input !== "object" || !Array.isArray(input.plan)) return null;
  const steps = input.plan.slice(0, MAX_STEPS)
    .map((item) => ({ text: clean(item?.step, TEXT_LIMIT), status: PLAN_STATUSES.includes(item?.status) ? item.status : "pending" }))
    .filter((step) => step.text);
  return steps.length ? { explanation: clean(input.explanation, EXPLANATION_LIMIT), steps } : null;
}

/** 一条 response_item 里的计划快照（同一次 exec 可能调用多次，按顺序返回）。 */
export function plansFromItem(payload) {
  if (!payload || typeof payload !== "object") return [];
  if (payload.type === "function_call" && payload.name === "update_plan") {
    try { return [normalizePlan(JSON.parse(payload.arguments))].filter(Boolean); } catch { return []; }
  }
  let code = null;
  if (payload.type === "custom_tool_call" && payload.name !== "apply_patch") code = payload.input;
  else if (payload.type === "function_call" && typeof payload.arguments === "string") {
    // function_call 形式的编排工具：代码在参数 JSON 的某个字符串字段里。
    try { code = Object.values(JSON.parse(payload.arguments) ?? {}).find((value) => typeof value === "string" && value.includes("update_plan")) ?? null; } catch { code = null; }
  }
  if (typeof code !== "string" || !code.includes("update_plan")) return [];
  return callArguments(code).map((argument) => normalizePlan(parseLiteral(argument))).filter(Boolean);
}

const stampOf = (line) => Date.parse(line.match(/"timestamp":"([^"]+)"/)?.[1]);

/** rollout 文本 → 按时间排列的事件：回合开始 { type: "turn" } 与计划快照 { type: "plan" }。首行可能被截断，坏行跳过。 */
export function parsePlanEvents(text) {
  const events = [];
  for (const line of text.split("\n")) {
    if (line.includes("\"event_msg\"") && /"payload":\{"type":"task_started"/.test(line)) {
      const at = stampOf(line);
      if (Number.isFinite(at)) events.push({ type: "turn", at });
      continue;
    }
    if (!line.includes("update_plan") || !line.includes("\"response_item\"")) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    const at = Date.parse(record.timestamp);
    if (!Number.isFinite(at)) continue;
    for (const plan of plansFromItem(record.payload)) events.push({ type: "plan", at, ...plan });
  }
  return events;
}

export function createPlanState() {
  return { turn: 0, plan: null };
}

/**
 * 把事件归并进计划状态。步骤按文字对上前后两份快照；改了措辞的步骤按位置对上。
 * 进行中的步骤从第一次标成 in_progress 的时刻算起；直接从待做跳到完成的，从前一步完成时算起，并标 inferred。
 * Codex 常在最后一次快照里把剩下几步一起标成完成，这些步骤的单步用时并不知道，界面据 inferred 不显示或标「约」。
 * 新快照和上一份相同的步骤不到一半、或上一份已经过期时，当作开始了一份新计划。
 */
export function applyPlanEvents(state, events) {
  for (const event of events) {
    if (event.type === "turn") { state.turn += 1; continue; }
    if (event.type !== "plan") continue;
    const previous = state.plan;
    // 至少一半步骤相同才算同一份计划；已经过期（两个回合以前，或之前回合已全部完成）的计划不再接续。
    const overlap = previous ? event.steps.filter((step) => previous.steps.some((old) => old.text === step.text)).length : 0;
    const outdated = previous && (previous.turn < state.turn - 1
      || (previous.turn !== state.turn && previous.steps.every((step) => step.status === "completed")));
    const continues = overlap > 0 && overlap * 2 >= Math.min(previous.steps.length, event.steps.length) && !outdated;
    const createdAt = continues ? previous.createdAt : event.at;
    const oldSteps = continues ? previous.steps : [];
    const byText = new Map(oldSteps.map((step) => [step.text, step]));
    let lastEnd = createdAt;
    const steps = event.steps.map((step, index) => {
      const byIndex = oldSteps[index];
      const prior = byText.get(step.text) ?? (byIndex && !event.steps.some((item) => item.text === byIndex.text) ? byIndex : null);
      let start = prior?.start ?? null;
      let end = prior?.end ?? null;
      let inferred = prior?.inferred ?? false;
      if (step.status === "pending") { start = null; end = null; inferred = false; }
      else if (step.status === "in_progress") { if (start === null) { start = event.at; inferred = false; } end = null; }
      else {
        if (start === null) { start = lastEnd; inferred = true; }
        end ??= event.at;
      }
      if (end !== null) lastEnd = Math.max(lastEnd, end);
      return { text: step.text, status: step.status, start, end, inferred };
    });
    state.plan = { createdAt, updatedAt: event.at, turn: state.turn, explanation: event.explanation, steps };
  }
  return state;
}

/**
 * 当前还有意义的计划：本回合列的，或上一个回合列了但还没做完（用户中途回复后接着做）。
 * 更早的计划、或上个回合已经全部完成的计划视为过期，返回 null。
 */
export function currentPlan(state) {
  const plan = state?.plan;
  if (!plan) return null;
  const unfinished = plan.steps.some((step) => step.status !== "completed");
  if (plan.turn !== state.turn && !(unfinished && plan.turn === state.turn - 1)) return null;
  return { createdAt: plan.createdAt, updatedAt: plan.updatedAt, explanation: plan.explanation, steps: plan.steps.map((step) => ({ ...step })) };
}

/** 看板条目用的计划摘要：总步数、完成数、进行中的那一步。 */
export function planSummary(plan) {
  if (!plan?.steps?.length) return null;
  const active = plan.steps.findIndex((step) => step.status === "in_progress");
  return {
    total: plan.steps.length,
    done: plan.steps.filter((step) => step.status === "completed").length,
    active: active >= 0 ? active : null,
    steps: plan.steps.map(({ text, status }) => ({ text, status }))
  };
}
