// 单个会话的 Trace：模型（思考、回复、组织调用）与各类工具按泳道排在时间轴上。
// 进行中的最后一段随时间向右生长；回合之间的空闲时间折叠成固定宽度的间隔。
const TRACE_WAIT_MS = 20_000;
const TRACE_RETRY_MS = 3000;
const LIVE_TICK_MS = 250;
// 用户滚动/拖动后这么久内不重建 Trace，避免打断手势与惯性滚动。
const SCROLL_SETTLE_MS = 400;
const GAP_PX = 34;
// 段宽分档：太窄只留色块，稍窄只放图标，再宽放文字，足够宽再加秒数（进行中的段优先显示秒数）。
const ICON_MIN_PX = 22;
const LABEL_MIN_PX = 64;
const DURATION_MIN_PX = 120;
const MIN_SCALE = 6;
const MAX_SCALE = 40;
const ZOOM = 1.6;
// 刻度间隔候选（秒），按当前比例挑一个让刻度相距约 70px 的。
const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800];

const LANES = [
  { id: "plan", name: "计划", icon: '<path d="M7 4.5h6M7 8h6M7 11.5h6"/><path d="M2.8 4.6l.9.9 1.6-1.8M2.8 8.1l.9.9 1.6-1.8"/><circle cx="3.9" cy="11.5" r=".8"/>' },
  { id: "model", name: "模型", icon: '<path d="M8 1.8c.35 3 1.7 4.35 4.7 4.7-3 .35-4.35 1.7-4.7 4.7-.35-3-1.7-4.35-4.7-4.7 3-.35 4.35-1.7 4.7-4.7z"/>' },
  { id: "shell", name: "命令", icon: '<path d="M3 4.5l3 3-3 3M7.5 11.5h5"/>' },
  { id: "edit", name: "文件", icon: '<path d="M10.6 3.2l2.2 2.2-7 7H3.6v-2.2z"/>' },
  { id: "agent", name: "子代理", icon: '<circle cx="5.5" cy="6" r="2"/><circle cx="11" cy="6" r="2"/><path d="M2.5 13c.4-2 1.6-3 3-3s2.6 1 3 3M8 13c.4-2 1.6-3 3-3s2.6 1 3 3"/>' },
  { id: "you", name: "你", icon: '<circle cx="8" cy="5.5" r="2.5"/><path d="M3.5 13.5c.6-2.5 2.3-3.8 4.5-3.8s3.9 1.3 4.5 3.8"/>' },
  { id: "other", name: "其它", icon: '<circle cx="4" cy="8" r="1"/><circle cx="8" cy="8" r="1"/><circle cx="12" cy="8" r="1"/>' }
];
const KIND_LABEL = { think: "思考", reply: "回复", call: "组织调用", tool: "工具", step: "计划步骤" };
// 计划区最多显示的进度说明条数（没列计划时的推断）。
const MAX_NOTES = 8;
const glyph = (body, size = 14) => `<svg viewBox="0 0 16 16" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const SEGMENT_ICONS = {
  think: '<path d="M8 2.5c.3 2.6 1.5 3.7 4 4-2.5.3-3.7 1.4-4 4-.3-2.6-1.5-3.7-4-4 2.5-.3 3.7-1.4 4-4z"/>',
  reply: '<path d="M3 4.5A1.5 1.5 0 0 1 4.5 3h7A1.5 1.5 0 0 1 13 4.5v5A1.5 1.5 0 0 1 11.5 11H7l-3 2.5V11h.5"/>',
  call: '<path d="M6 4L2.5 8 6 12M10 4l3.5 4-3.5 4"/>',
  failed: '<path d="M5 5l6 6M11 5l-6 6"/>',
  done: '<path d="M3.5 8.4l2.9 2.9 6.1-6.6"/>',
  pending: '<circle cx="8" cy="8" r="4.4"/>',
  // 进行中但回合已经停下（在等你回答、被中断）：半实心圆，不转。
  paused: '<circle cx="8" cy="8" r="4.4"/><path d="M8 3.6a4.4 4.4 0 0 1 0 8.8z" fill="currentColor" stroke="none"/>',
  note: '<circle cx="8" cy="8" r="1.8" fill="currentColor" stroke="none"/>'
};
// 八道光芒依次点亮，与看板列表里进行中的图标一致。
const SPINNER = Array.from({ length: 8 }, (_, index) => {
  const angle = (index * Math.PI) / 4;
  const point = (radius) => `${(8 + Math.sin(angle) * radius).toFixed(2)} ${(8 - Math.cos(angle) * radius).toFixed(2)}`;
  return `<path class="ray" d="M${point(2.6)}L${point(5.8)}" style="animation-delay:${index * 100 - 800}ms"/>`;
}).join("");

export const TRACE_STYLE = `
  .trace{display:grid;gap:10px}
  .trace-head{display:flex;align-items:center;gap:8px;min-width:0;padding:0 4px}
  .trace-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;font-size:13.5px}
  .trace-live{flex:none;margin-left:auto;display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:999px;font-size:11.5px;font-weight:500;
    font-variant-numeric:tabular-nums;color:var(--running);background:color-mix(in srgb,var(--running) 11%,transparent)}
  .trace-live[data-tone=human]{color:var(--attention);background:color-mix(in srgb,var(--attention) 12%,transparent)}
  .trace-live[data-tone=idle]{color:var(--muted);background:color-mix(in srgb,currentColor 5%,transparent)}
  .trace-live svg .ray,.seg-bar svg .ray,.plan-mark svg .ray{opacity:.18;animation:ray .8s linear infinite}
  .stats{display:grid;grid-template-columns:repeat(4,1fr);border-radius:12px;box-shadow:inset 0 0 0 1px var(--line),0 1px 2px rgba(0,0,0,.04);overflow:hidden}
  .stat{min-width:0;padding:7px 10px 8px;box-shadow:-1px 0 0 var(--line)}
  .stat:first-child{box-shadow:none}
  .stat b{display:block;font-size:13.5px;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .stat span{display:block;font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .tl{display:grid;grid-template-columns:auto 1fr;border-radius:12px;box-shadow:inset 0 0 0 1px var(--line),0 1px 2px rgba(0,0,0,.04);overflow:hidden}
  .tl-labels{display:grid;grid-auto-rows:36px;grid-template-rows:26px;padding:0 8px 4px 7px;box-shadow:1px 0 0 var(--line);z-index:1}
  .trace-model{flex:none;font-size:11.5px;color:var(--muted)}
  .tl-zoom{align-self:center;justify-self:start;display:flex;border-radius:7px;box-shadow:inset 0 0 0 1px var(--line);overflow:hidden}
  .tl-zoom button{width:20px;height:18px;font-size:12px;line-height:1;color:var(--muted)}
  .tl-zoom button:hover{color:inherit;background:var(--hover)}
  .tl-zoom button+button{box-shadow:-1px 0 0 var(--line)}
  .tl-lane{display:flex;align-items:center;gap:7px;min-width:0}
  .tl-tile{flex:none;display:grid;place-items:center;width:24px;height:24px;border-radius:7px;color:var(--text);
    background:color-mix(in srgb,currentColor 4%,transparent);box-shadow:inset 0 0 0 1px var(--line),0 1px 2px rgba(0,0,0,.05)}
  .tl-lane[data-lane=you] .tl-tile{color:var(--attention)}
  .tl-name{display:flex;flex-direction:column;min-width:0;line-height:1.2}
  .tl-name b{font-size:12.5px;font-weight:500;white-space:nowrap}
  .tl-name span{font-size:10.5px;color:var(--muted);white-space:nowrap}
  .tl-scroll{position:relative;overflow-x:auto;overflow-y:hidden;scrollbar-width:thin;padding-bottom:4px}
  .tl-track{position:relative;display:grid;grid-auto-rows:36px;grid-template-rows:26px;min-width:100%}
  .tl-axis{position:relative;font-size:10.5px;color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap}
  .tl-axis span{position:absolute;top:7px;transform:translateX(-50%)}
  .tl-axis .gap-label{transform:translateX(-50%);color:color-mix(in srgb,currentColor 38%,transparent)}
  .tl-axis .now{top:4px;transform:translateX(-100%);padding:1px 7px;border-radius:999px;color:var(--running);background:color-mix(in srgb,var(--running) 12%,transparent)}
  .tl-row{position:relative}
  .tl-grid{position:absolute;top:26px;bottom:0;border-left:1px dashed color-mix(in srgb,currentColor 10%,transparent);pointer-events:none}
  .tl-gap{position:absolute;top:26px;bottom:0;background:repeating-linear-gradient(135deg,color-mix(in srgb,currentColor 4%,transparent) 0 4px,transparent 4px 8px);pointer-events:none}
  .tl-link{position:absolute;border-left:1px dashed color-mix(in srgb,currentColor 30%,transparent);pointer-events:none}
  .seg-bar{--tone:#8b8d98;position:absolute;top:7px;height:22px;min-width:2px;display:flex;align-items:center;gap:4px;padding:0 6px;overflow:hidden;
    border-radius:6px;font-size:11px;font-weight:500;white-space:nowrap;color:color-mix(in srgb,var(--tone) 80%,currentColor);
    background:color-mix(in srgb,var(--tone) 14%,transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--tone) 28%,transparent)}
  .seg-bar[data-narrow]{padding:0}
  .seg-bar[data-icon-only]{justify-content:center;padding:0}
  .seg-bar[data-icon-only] .seg-text{display:none}
  .seg-bar[data-compact] .seg-dur{display:none}
  .seg-bar[data-narrow]>*{display:none}
  .seg-bar svg{flex:none}
  .seg-bar .seg-text{min-width:0;overflow:hidden;text-overflow:ellipsis}
  .seg-bar .seg-dur{flex:none;opacity:.7;font-variant-numeric:tabular-nums}
  .seg-bar[data-kind=think]{--tone:#8b5cf6}
  .seg-bar[data-kind=reply]{--tone:#3b82f6}
  .seg-bar[data-kind=call]{--tone:#0ea5e9}
  .seg-bar[data-kind=tool]{--tone:#7c8190;color:var(--text)}
  .seg-bar[data-lane=you]{--tone:var(--attention);color:var(--attention)}
  .seg-bar[data-failed]{--tone:var(--danger);color:var(--danger)}
  .seg-bar[data-live]{box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--tone) 34%,transparent),inset -2.5px 0 0 var(--tone)}
  .needs{position:absolute;top:8px;display:inline-flex;align-items:center;gap:3px;padding:2px 7px;border-radius:6px;font-size:11px;font-weight:600;white-space:nowrap;
    color:#fff;background:var(--attention);box-shadow:0 1px 3px color-mix(in srgb,var(--attention) 45%,transparent)}
  .turn-end{position:absolute;top:9px;display:grid;place-items:center;width:18px;height:18px;border-radius:50%;color:var(--muted);
    background:color-mix(in srgb,currentColor 6%,transparent);box-shadow:inset 0 0 0 1px var(--line)}
  .turn-end[data-status=interrupted],.turn-end[data-status=stalled]{color:var(--danger);background:color-mix(in srgb,var(--danger) 10%,transparent)}
  .trace-empty{margin:4px 6px;font-size:12.5px;line-height:1.55;color:var(--muted)}
  .plan{display:grid;gap:3px;padding:8px 10px 8px;border-radius:12px;box-shadow:inset 0 0 0 1px var(--line),0 1px 2px rgba(0,0,0,.04)}
  .plan-head{display:flex;align-items:baseline;gap:8px;min-width:0;font-variant-numeric:tabular-nums}
  .plan-head b{flex:none;font-size:12.5px;font-weight:600}
  .plan-head span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11.5px;color:var(--muted)}
  .plan-head .plan-elapsed{flex:none;margin-left:auto}
  .plan-list{list-style:none;margin:0;padding:0;display:grid;max-height:216px;overflow:auto;scrollbar-width:thin}
  .plan-step{display:grid;grid-template-columns:16px minmax(0,1fr) auto;column-gap:7px;align-items:center;min-height:24px;font-size:12.5px}
  .plan-mark{display:grid;place-items:center;color:var(--muted)}
  .plan-step[data-status=completed] .plan-mark{color:#10b981}
  .plan-step[data-status=in_progress] .plan-mark{color:var(--running)}
  .plan-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .plan-step[data-status=completed] .plan-text{color:var(--text)}
  .plan-step[data-status=pending] .plan-text{color:var(--muted)}
  .plan-step[data-status=in_progress] .plan-text{font-weight:500}
  .plan-dur{font-size:11px;color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap}
  .plan-note{margin:1px 0 0;font-size:11.5px;line-height:1.5;color:var(--muted)}
  .seg-bar[data-kind=step]{--tone:#10b981}
  .seg-bar[data-kind=step][data-live]{--tone:var(--running)}
  .seg-bar[data-kind=step][data-paused]{--tone:var(--attention)}
  .tl-lane[data-lane=plan] .tl-tile{color:#10b981}
`;

function seconds(ms) {
  if (!Number.isFinite(ms)) return "";
  const total = ms / 1000;
  if (total < 10) return `${total.toFixed(1)}s`;
  if (total < 60) return `${Math.round(total)}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${String(Math.round(total % 60)).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
const compact = (value) => (value >= 10_000 ? `${Math.round(value / 1000)}k` : value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value));
const clock = (ms) => new Date(ms).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
const clockSec = (ms) => new Date(ms).toLocaleTimeString("zh-CN", { hour12: false });

export function createTraceView({ rpc, effects, signal, threads, element, fail, isVisible }) {
  const root = element("div", "trace");
  let threadId = null;
  let threadTitle = null;
  let data = null;
  let receivedAt = 0;
  let scale = null;
  let loop = null;
  let active = false;
  let live = [];
  let liveTimer = null;
  let layout = null;
  let interactedAt = -Infinity;
  let redrawTimer = null;

  function stopLoop() {
    loop?.abort();
    loop = null;
  }
  // 当前会话的长轮询：会话记录一变就返回新的 Trace。
  function startLoop() {
    if (loop || !threadId || !active || signal.aborted) return;
    const controller = new AbortController();
    const id = threadId;
    loop = controller;
    void (async () => {
      let since = null;
      while (!controller.signal.aborted && !signal.aborted) {
        try {
          const next = await rpc("trace", { threadId: id, since, waitMs: since ? TRACE_WAIT_MS : 0 }, { signal: controller.signal, timeoutMs: TRACE_WAIT_MS + 15_000 });
          if (controller.signal.aborted) break;
          // 服务端只在超时后才返回未变化的结果；万一立即返回，也歇一下再连，避免空转。
          const unchanged = since !== null && next.sig === since;
          since = next.sig;
          if (next.sig !== data?.sig || next.threadId !== data?.threadId) accept(next);
          if (unchanged) await new Promise((resolve) => effects.timeout(resolve, TRACE_RETRY_MS));
        } catch (error) {
          if (controller.signal.aborted || signal.aborted) break;
          fail(error);
          await new Promise((resolve) => effects.timeout(resolve, TRACE_RETRY_MS));
        }
      }
    })();
  }

  function accept(next) {
    if (next.threadId !== data?.threadId) scale = null;
    data = next;
    // 用服务端时钟与本地时钟的差来推算「现在」，避免两边时钟不一致时进行中的段抖动。
    receivedAt = Date.now() - next.now;
    drawWhenSettled();
  }
  // 新数据会整体重建时间轴；用户正在滚动时先攒着，停下后再画最新的一份。
  function drawWhenSettled() {
    const wait = interactedAt + SCROLL_SETTLE_MS - performance.now();
    if (wait <= 0) { draw(); return; }
    redrawTimer?.();
    redrawTimer = effects.timeout(() => { redrawTimer = null; drawWhenSettled(); }, wait);
  }
  const now = () => Date.now() - receivedAt;

  // 时间 → 横坐标：每个回合按比例展开，回合之间折叠成固定间隔。
  function computeLayout(turns, current) {
    const blocks = [];
    let x = 10;
    for (const turn of turns) {
      const end = turn.end ?? current;
      blocks.push({ turn, start: turn.start, end, x });
      x += Math.max((end - turn.start) / 1000 * scale, 4) + GAP_PX;
    }
    const width = x - GAP_PX + 64;
    const toX = (ms) => {
      const block = blocks.findLast((item) => ms >= item.start) ?? blocks[0];
      return block.x + Math.max(0, Math.min(ms, block.end) - block.start) / 1000 * scale;
    };
    return { blocks, width, toX };
  }

  function chooseScale(turns, viewport) {
    const last = turns.at(-1);
    const span = Math.max(((last.end ?? now()) - last.start) / 1000, 45);
    // 让最近一个回合正好铺满可视宽度；之后进行中的段按这个比例继续向右长。
    // 但至少 6px/秒，保证十来秒的段能写下文字和秒数；放不下就横向滚动，默认跟着最新的一段。
    return Math.min(Math.max((viewport - 56) / span, MIN_SCALE), MAX_SCALE);
  }

  function lanesOf(turns, withPlan) {
    const used = new Set(withPlan ? ["plan", "model"] : ["model"]);
    for (const turn of turns) for (const segment of turn.segments) used.add(segment.lane);
    if (turns.some((turn) => turn.asking)) used.add("you");
    return LANES.filter((lane) => used.has(lane.id));
  }

  function statOf(turn) {
    const tokens = turn.tokens ?? { output: 0, reasoning: 0 };
    const busy = turn.segments.filter((segment) => segment.lane === "model" && segment.end !== null).reduce((sum, segment) => sum + segment.end - segment.start, 0);
    const toolMs = turn.segments.filter((segment) => segment.kind === "tool" && segment.end !== null).reduce((sum, segment) => sum + segment.end - segment.start, 0);
    return [
      [seconds((turn.end ?? now()) - turn.start), "回合用时", "elapsed", turn.end === null ? "本回合到现在的用时" : "本回合从开始到结束的用时"],
      Number.isFinite(turn.ttftMs) ? [seconds(turn.ttftMs), "首字", null, "从开始到模型输出第一个 token"] : [seconds(busy), "模型", null, "模型思考与输出的总用时"],
      [compact(tokens.output), "输出 token", null, `输出 ${tokens.output} token，其中推理 ${tokens.reasoning}；工具用时 ${seconds(toolMs)}`],
      busy > 0 && tokens.output ? [`${Math.round(tokens.output * 1000 / busy)}/s`, "token 速度", null, "输出 token ÷ 模型用时"] : [seconds(toolMs), "工具", null, "工具调用的总用时"]
    ];
  }

  function segmentTitle(segment, current) {
    const duration = (segment.end ?? current) - segment.start;
    const parts = [segment.kind === "tool" ? segment.label : KIND_LABEL[segment.kind], seconds(duration)];
    if (segment.kind !== "tool" && segment.label && segment.label !== KIND_LABEL[segment.kind]) parts.push(segment.label);
    if (segment.tokens) parts.push(`输出 ${segment.tokens.output} token`, segment.tokens.reasoning ? `推理 ${segment.tokens.reasoning}` : "", segment.tokens.perSecond ? `${segment.tokens.perSecond} token/s` : "");
    if (segment.failed) parts.push("失败");
    return parts.filter(Boolean).join(" · ");
  }

  function segmentText(segment) {
    if (segment.kind === "step") return segment.label;
    if (segment.end === null) return segment.lane === "you" ? "等你回答" : segment.label;
    if (segment.kind === "tool") return segment.label;
    if (segment.kind === "reply") return segment.label;
    if (segment.kind === "call") return segment.tokens ? `${compact(segment.tokens.output)} tok` : "组织调用";
    return segment.tokens ? `思考 · ${compact(segment.tokens.output)} tok` : "思考";
  }

  function paintSegment(bar, segment, current) {
    const left = layout.toX(segment.start);
    const width = Math.max(layout.toX(segment.end ?? current) - left, 2);
    bar.style.left = `${left}px`;
    bar.style.width = `${width}px`;
    const live = segment.end === null;
    bar.toggleAttribute("data-narrow", width < ICON_MIN_PX);
    bar.toggleAttribute("data-icon-only", width < (live ? 40 : LABEL_MIN_PX));
    bar.toggleAttribute("data-compact", width < (live ? 40 : DURATION_MIN_PX));
    bar.title = segmentTitle(segment, current);
    const duration = bar.querySelector(".seg-dur");
    if (duration) duration.textContent = seconds((segment.end ?? current) - segment.start);
  }

  // 计划泳道：有起点的步骤画成段。进行中的步骤在回合进行时随时间生长，回合停下后止于回合结束。
  function planSegments(plan, lastTurn) {
    if (!plan?.steps?.length) return [];
    const running = lastTurn.end === null;
    return plan.steps.flatMap((step, index) => {
      if (!Number.isFinite(step.start)) return [];
      const open = step.status === "in_progress";
      const end = open ? (running ? null : Math.max(step.start, lastTurn.end)) : step.end;
      if (end !== null && !Number.isFinite(end)) return [];
      // 和别的步骤一起被标成完成、用时不详的，不画零长度的段。
      if (step.inferred && end !== null && end - step.start < 1000) return [];
      return [{ kind: "step", lane: "plan", start: step.start, end, label: `${index + 1}. ${step.text}`, paused: open && !running }];
    });
  }

  // 计划区：Codex 用 update_plan 列的步骤、状态与每步用时；没列计划时，退回本回合的进度说明（推断）。
  function planSection(plan, lastTurn, current) {
    const running = lastTurn.end === null;
    const box = element("div", "plan");
    const list = element("ol", "plan-list");
    const row = (status, icon, text, duration) => {
      const item = element("li", "plan-step");
      item.dataset.status = status;
      const mark = element("span", "plan-mark");
      mark.innerHTML = glyph(icon, 12);
      const label = element("span", "plan-text", text);
      label.title = text;
      const time = element("span", "plan-dur", duration);
      item.append(mark, label, time);
      list.append(item);
      return time;
    };
    if (plan?.steps?.length) {
      const done = plan.steps.filter((step) => step.status === "completed").length;
      const stopAt = running ? current : lastTurn.end;
      const finished = done === plan.steps.length;
      const lastEnd = Math.max(...plan.steps.map((step) => step.end ?? -Infinity));
      const head = element("div", "plan-head");
      const elapsed = element("span", "plan-elapsed", `${finished ? "共" : "已"}用 ${seconds((finished ? lastEnd : stopAt) - plan.createdAt)}`);
      head.append(element("b", "", "计划"), element("span", "", finished ? `${done} 步全部完成` : `第 ${Math.min(done + 1, plan.steps.length)}/${plan.steps.length} 步`), elapsed);
      if (running && !finished) live.push({ kind: "since", node: elapsed, start: plan.createdAt, prefix: "已用 " });
      plan.steps.forEach((step, index) => {
        const open = step.status === "in_progress";
        const icon = step.status === "completed" ? SEGMENT_ICONS.done : open ? (running ? SPINNER : SEGMENT_ICONS.paused) : SEGMENT_ICONS.pending;
        const end = open ? stopAt : step.end;
        const span = Number.isFinite(step.start) && Number.isFinite(end) ? Math.max(0, end - step.start) : null;
        // 推断出的起点：不足 1 秒说明是和别的步骤一起标成完成的，单步用时不详，不显示；否则写「约」。
        const duration = span === null || (step.inferred && span < 1000) ? "" : `${step.inferred ? "约 " : ""}${seconds(span)}`;
        const time = row(step.status, icon, `${index + 1}. ${step.text}`, duration);
        if (step.inferred) time.title = "Codex 没有单独标记这一步开始，用时按前一步完成时刻推断";
        if (open && running && Number.isFinite(step.start)) live.push({ kind: "since", node: time, start: step.start, prefix: "" });
      });
      box.append(head, list);
      if (plan.explanation) box.append(element("p", "plan-note", plan.explanation));
      return box;
    }
    const notes = (lastTurn.notes ?? []).slice(-MAX_NOTES);
    if (!notes.length) return null;
    const head = element("div", "plan-head");
    head.append(element("b", "", "进展"), element("span", "", "没有列计划，按 Codex 的进度说明推断"));
    box.dataset.inferred = "";
    notes.forEach((note, index) => {
      const next = notes[index + 1]?.at ?? (running ? null : lastTurn.end);
      const last = index === notes.length - 1;
      const status = last && running ? "in_progress" : "completed";
      const time = row(status, last && running ? SPINNER : SEGMENT_ICONS.note, note.text, next === null ? seconds(current - note.at) : seconds(Math.max(0, next - note.at)));
      if (next === null) live.push({ kind: "since", node: time, start: note.at, prefix: "" });
    });
    box.append(head, list);
    return box;
  }

  function draw() {
    if (!active) return;
    live = [];
    if (!threadId) {
      root.replaceChildren(element("p", "trace-empty", "把鼠标停在看板的任务上，这里会显示它的 Trace：思考、回复、工具调用各用了多久、输出了多少 token。"));
      return;
    }
    if (!data || data.threadId !== threadId) {
      root.replaceChildren(element("p", "trace-empty", "正在读取会话记录…"));
      return;
    }
    const turns = data.turns ?? [];
    const title = threadTitle ?? threads?.title(threadId) ?? "会话";
    if (!turns.length) {
      root.replaceChildren(element("p", "trace-empty", `「${title}」最近没有可展示的回合。`));
      return;
    }
    const scroller = root.querySelector(".tl-scroll");
    const pinned = !scroller || scroller.scrollLeft + scroller.clientWidth >= scroller.scrollWidth - 24;
    // 旧容器替换后脱离文档，scrollLeft 会读成 0，必须在替换前记下。
    const previousLeft = scroller?.scrollLeft ?? 0;
    // 可视宽度 = 卡片宽减去左侧泳道名一栏。
    const viewport = Math.max(root.getBoundingClientRect().width - 84, 160);
    scale ??= chooseScale(turns, viewport);
    const current = now();
    layout = computeLayout(turns, current);
    const lastTurn = turns.at(-1);
    const steps = planSegments(data.plan, lastTurn);
    const lanes = lanesOf(turns, steps.length > 0);

    const head = element("div", "trace-head");
    head.append(element("span", "trace-title", title));
    if (data.model) head.append(element("span", "trace-model", data.model));
    head.title = `最近 ${turns.length} 个回合`;
    const status = element("span", "trace-live");
    if (lastTurn.end === null) {
      const open = lastTurn.segments.findLast((segment) => segment.end === null);
      if (lastTurn.asking) { status.dataset.tone = "human"; status.textContent = "▲ 需要你"; }
      else {
        status.innerHTML = glyph(SPINNER, 12);
        const text = element("span", "", "");
        status.append(text);
        live.push({ kind: "status", node: text, segment: open, label: open?.kind === "tool" ? "工具运行" : open ? KIND_LABEL[open.kind] ?? "进行中" : "进行中" });
      }
    } else if (lastTurn.asking) { status.dataset.tone = "human"; status.textContent = "▲ 需要你"; }
    else { status.dataset.tone = "idle"; status.textContent = lastTurn.status === "done" ? `已完成 · ${clock(lastTurn.end)}` : "已中断"; }
    head.append(status);

    const stats = element("div", "stats");
    for (const [value, label, key, hint] of statOf(lastTurn)) {
      const cell = element("div", "stat");
      cell.title = hint;
      const strong = element("b", "", value);
      cell.append(strong, element("span", "", label));
      if (key === "elapsed" && lastTurn.end === null) live.push({ kind: "elapsed", node: strong, turn: lastTurn });
      stats.append(cell);
    }

    const labels = element("div", "tl-labels");
    const zoom = element("span", "tl-zoom");
    for (const [text, factor, label] of [["−", 1 / ZOOM, "缩小"], ["+", ZOOM, "放大"]]) {
      const button = element("button", "", text);
      button.type = "button";
      button.title = label;
      button.setAttribute("aria-label", label);
      button.addEventListener("click", () => {
        scale = Math.min(Math.max(scale * factor, 0.3), MAX_SCALE * 2);
        draw();
      });
      zoom.append(button);
    }
    labels.append(zoom);
    for (const lane of lanes) {
      const row = element("div", "tl-lane");
      row.dataset.lane = lane.id;
      const tile = element("span", "tl-tile");
      tile.innerHTML = glyph(lane.icon, 13);
      const name = element("span", "tl-name");
      const count = turns.reduce((sum, turn) => sum + turn.segments.filter((segment) => segment.lane === lane.id && segment.kind === "tool").length, 0);
      name.append(element("b", "", lane.name));
      if (lane.id === "plan") name.append(element("span", "", `${data.plan.steps.filter((step) => step.status === "completed").length}/${data.plan.steps.length} 步`));
      else if (lane.id !== "model" && lane.id !== "you") name.append(element("span", "", `${count} 次`));
      if (lane.id === "model" && data.model) row.title = data.model;
      row.append(tile, name);
      labels.append(row);
    }

    const scrollBox = element("div", "tl-scroll");
    // 只记用户输入（滚轮/触控板、拖滚动条）；跟随最新进度时的程序滚动不算。
    const markInteraction = (event) => {
      if (event.type !== "pointermove" || event.buttons) interactedAt = performance.now();
    };
    for (const type of ["wheel", "pointerdown", "pointermove"]) scrollBox.addEventListener(type, markInteraction, { passive: true });
    const track = element("div", "tl-track");
    track.style.width = `${layout.width}px`;
    const axis = element("div", "tl-axis");
    track.append(axis);
    const rowOf = new Map(lanes.map((lane) => {
      const row = element("div", "tl-row");
      track.append(row);
      return [lane.id, row];
    }));
    const rowIndex = new Map(lanes.map((lane, index) => [lane.id, index]));
    // 刻度：按比例挑间隔，每个回合内从开头起算；回合开头标时钟时间。
    const step = TICK_STEPS.find((value) => value * scale >= 70) ?? TICK_STEPS.at(-1);
    layout.blocks.forEach((block, index) => {
      const start = element("span", "", clock(block.start));
      start.style.left = `${block.x}px`;
      start.style.transform = "none";
      axis.append(start);
      for (let offset = step; block.start + offset * 1000 < block.end - step * 300; offset += step) {
        const x = block.x + offset * scale;
        if (x - block.x < 46) continue;
        const tick = element("span", "", `+${seconds(offset * 1000)}`);
        tick.style.left = `${x}px`;
        axis.append(tick);
        const line = element("span", "tl-grid");
        line.style.left = `${x}px`;
        track.append(line);
      }
      const next = layout.blocks[index + 1];
      if (next) {
        const gapX = layout.toX(block.end) + 4;
        const gap = element("span", "tl-gap");
        gap.style.left = `${gapX}px`;
        gap.style.width = `${GAP_PX - 8}px`;
        track.append(gap);
        const idle = element("span", "gap-label", "⋯");
        idle.style.left = `${gapX + (GAP_PX - 8) / 2}px`;
        idle.title = `空闲 ${seconds(next.start - block.end)}`;
        axis.append(idle);
      }
    });
    if (lastTurn.end === null) {
      const pill = element("span", "now", "现在");
      pill.style.left = `${layout.toX(current) + 2}px`;
      axis.append(pill);
      live.push({ kind: "now", node: pill });
    }

    const modelIndex = rowIndex.get("model");
    const addBar = (segment) => {
      const row = rowOf.get(segment.lane) ?? rowOf.get("model");
      const bar = element("span", "seg-bar");
      bar.dataset.kind = segment.kind;
      bar.dataset.lane = segment.lane;
      if (segment.failed) bar.dataset.failed = "";
      if (segment.paused) bar.dataset.paused = "";
      if (segment.end === null) bar.dataset.live = "";
      const icon = segment.end === null ? SPINNER : segment.failed ? SEGMENT_ICONS.failed : segment.paused ? SEGMENT_ICONS.paused
        : SEGMENT_ICONS[segment.kind === "step" ? "done" : segment.kind] ?? SEGMENT_ICONS.call;
      bar.innerHTML = glyph(segment.kind === "tool" && !segment.failed && segment.end !== null ? (LANES.find((lane) => lane.id === segment.lane)?.icon ?? icon) : icon, 11);
      bar.append(element("span", "seg-text", segmentText(segment)), element("span", "seg-dur", ""));
      paintSegment(bar, segment, current);
      row.append(bar);
      if (segment.end === null) live.push({ kind: "bar", node: bar, segment });
      // 模型把活交给工具：从模型泳道到工具泳道画一道虚线。
      if (segment.kind === "tool" && rowIndex.has(segment.lane)) {
        const link = element("span", "tl-link");
        link.style.left = `${layout.toX(segment.start)}px`;
        link.style.top = `${26 + modelIndex * 36 + 29}px`;
        link.style.height = `${(rowIndex.get(segment.lane) - modelIndex) * 36 - 22}px`;
        track.append(link);
      }
    };
    for (const segment of steps) addBar(segment);
    for (const turn of turns) {
      for (const segment of turn.segments) addBar(segment);
      const endX = layout.toX(turn.end ?? current);
      if (turn.asking) {
        // 右边缘对齐回合结束，不越过回合间隔压到下一回合上。
        const needs = element("span", "needs", "▲ 需要你");
        needs.style.left = `${endX}px`;
        needs.style.transform = "translateX(-100%)";
        needs.title = turn.end === null ? "Codex 在等你回答" : `回合以提问结束 · ${clockSec(turn.end)}`;
        rowOf.get("you").append(needs);
      } else if (turn.end !== null) {
        const end = element("span", "turn-end");
        end.dataset.status = turn.status;
        end.title = `${turn.status === "done" ? "完成" : "中断"} · ${clockSec(turn.end)}`;
        end.innerHTML = glyph(turn.status === "done" ? SEGMENT_ICONS.done : SEGMENT_ICONS.failed, 10);
        end.style.left = `${endX + 3}px`;
        rowOf.get("model").append(end);
      }
    }
    scrollBox.append(track);
    const timeline = element("div", "tl");
    timeline.append(labels, scrollBox);
    const plan = planSection(data.plan, lastTurn, current);
    root.replaceChildren(...[head, stats, plan, timeline].filter(Boolean));
    // 停在最右边时跟随最新进度；用户往回翻看时不打扰。
    if (pinned) scrollBox.scrollLeft = scrollBox.scrollWidth;
    else scrollBox.scrollLeft = previousLeft;
    syncTicker();
  }

  // 进行中：每 250ms 只更新正在生长的那一段、「现在」标记和计时，不重建 DOM。
  function tick() {
    if (!live.length || !layout || !data) return;
    const current = now();
    const lastTurn = data.turns.at(-1);
    const scroller = root.querySelector(".tl-scroll");
    const pinned = scroller && scroller.scrollLeft + scroller.clientWidth >= scroller.scrollWidth - 24;
    layout = computeLayout(data.turns, current);
    const track = root.querySelector(".tl-track");
    if (track) track.style.width = `${layout.width}px`;
    for (const item of live) {
      if (item.kind === "bar") paintSegment(item.node, item.segment, current);
      else if (item.kind === "now") item.node.style.left = `${layout.toX(current) + 2}px`;
      else if (item.kind === "elapsed") item.node.textContent = seconds(current - item.turn.start);
      else if (item.kind === "status") item.node.textContent = `${item.label} ${seconds(current - (item.segment?.start ?? lastTurn.start))}`;
      else if (item.kind === "since") item.node.textContent = `${item.prefix}${seconds(current - item.start)}`;
    }
    if (pinned) scroller.scrollLeft = scroller.scrollWidth;
  }
  function syncTicker() {
    const want = active && live.length > 0 && isVisible();
    if (want && !liveTimer) liveTimer = effects.interval(tick, LIVE_TICK_MS);
    else if (!want && liveTimer) { liveTimer(); liveTimer = null; }
    if (want) tick();
  }

  // 切换到看板上指向的会话；同一会话只更新标题，不重连。
  function show(id, title = null) {
    threadTitle = title;
    if (id === threadId) return;
    threadId = id;
    stopLoop();
    draw();
    startLoop();
  }

  effects.add(() => { stopLoop(); liveTimer?.(); redrawTimer?.(); });
  return {
    root,
    show,
    setActive(next) {
      if (active === next) return;
      active = next;
      if (active) { draw(); startLoop(); } else { stopLoop(); syncTicker(); }
    },
    visibilityChanged(visible) {
      if (!active) return;
      if (visible) startLoop(); else stopLoop();
      syncTicker();
    }
  };
}
