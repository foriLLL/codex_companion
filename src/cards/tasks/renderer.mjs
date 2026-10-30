import { TRACE_STYLE, createTraceView } from "./trace.mjs";

// 长轮询：服务端在会话记录变化时立即返回，没变化最多挂 20 秒；出错后隔一会儿再连。
const WATCH_WAIT_MS = 20_000;
const WATCH_RETRY_MS = 3000;
const UNDO_MS = 6000;
// 悬停多久打开 Trace 浮层、离开多久关闭；离开后的宽限让鼠标能移进浮层里滚动和缩放。
const PEEK_OPEN_MS = 350;
const PEEK_CLOSE_MS = 220;
const PEEK_MAX_WIDTH = 720;
const PEEK_MIN_WIDTH = 420;
const SILENT_CODES = new Set(["ABORTED", "RPC_CANCELLED", "RPC_STALE_GENERATION", "CARD_DISABLED", "STATE_DISPOSED"]);
// 左侧状态图标。需要人处理的（提问、中断、无响应）排最前，没看过的会跳动提醒；
// 其次是没看过的新回复（图标摇晃提醒），进行中的放后面。
const STATUS = {
  asking: { label: "在等你回答", icon: "ask", human: true },
  interrupted: { label: "已中断，需要你处理", icon: "alert", human: true },
  stalled: { label: "长时间无响应，需要你看看", icon: "alert", human: true },
  running: { label: "进行中", icon: "spin" },
  idle: { label: "已回复", icon: "reply" },
  archived: { label: "已归档", icon: "gone" },
  missing: { label: "找不到记录", icon: "gone" }
};
function rankOf(task) {
  const status = STATUS[task.status];
  if (!status) return 5;
  if (status.human) return task.unread ? 0 : 2;
  if (task.status === "idle") return task.unread ? 1 : 4;
  if (task.status === "running") return 3;
  return 5;
}
function statusLabel(task) {
  if (task.status === "idle" && task.unread) return "有新回复，还没看";
  return STATUS[task.status]?.label ?? task.status;
}
// 看板颜色名，与 threads.colors 下标一一对应。
const COLOR_NAMES = ["薄荷", "天空蓝", "杏橙", "樱粉", "薰衣草", "湖青", "柠檬黄", "深靛"];
const ICONS = {
  plus: '<path d="M8 3.5v9M3.5 8h9"/>',
  edit: '<path d="M10.6 3.2l2.2 2.2-7 7H3.6v-2.2z"/>',
  done: '<path d="M3.5 8.4l2.9 2.9 6.1-6.6"/>',
  color: '<path d="M8 2.6s4 4.2 4 6.9a4 4 0 0 1-8 0c0-2.7 4-6.9 4-6.9z"/>'
};
// 状态图标 20×20，彩色渐变实心：状态色与任务色分开，图标底块表示是哪个任务，图标表示它在干什么。
// 渐变 id 带 cc-task- 前缀，渲染时替换成每个图标唯一的 id。
const gradient = (id, from, to) => `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs>`;
const BUBBLE = '<path d="M3 6.2A3.2 3.2 0 0 1 6.2 3h7.6A3.2 3.2 0 0 1 17 6.2v4.6a3.2 3.2 0 0 1-3.2 3.2H9.6l-3.4 2.7c-.4.3-.9 0-.9-.5V14h-.1A2.2 2.2 0 0 1 3 11.8z" fill="url(#cc-task-reply)" stroke="none"/><path d="M7 7.6h6M7 10.2h3.8" stroke="#fff" stroke-width="1.5"/>';
const disc = (id) => `<circle cx="10" cy="10" r="7.6" fill="url(#${id})" stroke="none"/>`;
const STATUS_ICONS = {
  ask: `${gradient("cc-task-ask", "#ffb347", "#f07c1e")}${disc("cc-task-ask")}<path d="M8 8a2.1 2.1 0 1 1 2.9 1.9c-.6.3-.9.7-.9 1.3v.2" stroke="#fff" stroke-width="1.7"/><circle cx="10" cy="13.7" r="1" fill="#fff" stroke="none"/>`,
  alert: `${gradient("cc-task-alert", "#ff7b72", "#e2443a")}${disc("cc-task-alert")}<path d="M10 6.2v4.6" stroke="#fff" stroke-width="1.9"/><circle cx="10" cy="13.6" r="1.05" fill="#fff" stroke="none"/>`,
  // 一段渐变弧线旋转，比实心图标轻，进行中的条目不抢眼。
  spin: `${gradient("cc-task-spin", "#6aa8ff", "#3b6ff0")}<circle cx="10" cy="10" r="6.8" stroke="color-mix(in srgb,#3b82f6 16%,transparent)" stroke-width="2.2"/><path class="arc" d="M10 3.2a6.8 6.8 0 0 1 6.8 6.8" stroke="url(#cc-task-spin)" stroke-width="2.2"/>`,
  reply: `${gradient("cc-task-reply", "#8fb4ff", "#5b7cf0")}${BUBBLE}`,
  unread: `${gradient("cc-task-reply", "#8fb4ff", "#5b7cf0")}${BUBBLE}<circle cx="16" cy="4.4" r="3" fill="#ff4d4f" stroke="var(--cc-card-bg,#fff)" stroke-width="1.4"/>`,
  gone: '<circle cx="10" cy="10" r="6.8" stroke-dasharray="2.2 2.6" opacity=".45"/>'
};
const SPARKLE = '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M7 1.5c.3 2.9 1.6 4.2 4.5 4.5-2.9.3-4.2 1.6-4.5 4.5C6.7 7.6 5.4 6.3 2.5 6c2.9-.3 4.2-1.6 4.5-4.5Z"/><circle cx="12.3" cy="12.3" r="1.3" fill="currentColor" opacity=".7"/></svg>';
let gradientSeq = 0;
const icon = (name) => `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

function ago(ms, now = Date.now()) {
  if (!Number.isFinite(ms)) return "";
  const minutes = Math.floor((now - ms) / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}


// 看板只列用户主动加入的会话；颜色与左侧会话条目呼应，点击后由平台定位、动画并打开。
export function mount({ root, rpc, effects, signal, threads, isVisible }) {
  const doc = root.ownerDocument;
  root.innerHTML = `<style>
    :host{display:block;--text:color-mix(in srgb,currentColor 64%,transparent);--muted:color-mix(in srgb,currentColor 46%,transparent);
      --line:color-mix(in srgb,currentColor 10%,transparent);--hover:color-mix(in srgb,currentColor 5%,transparent);
      --attention:#d9661b;--danger:#d4483e;--running:#3b82f6;--ease:cubic-bezier(.22,1,.36,1);
      font-family:"Inter",ui-sans-serif,system-ui,-apple-system,"PingFang SC",sans-serif;letter-spacing:-.006em;-webkit-font-smoothing:antialiased}
    *{box-sizing:border-box}
    .board{padding:14px 8px 8px;font-size:13.5px;line-height:1.4}
    header{display:flex;align-items:center;gap:10px;padding:0 6px 10px 8px;min-height:22px}
    h2{flex:none;display:flex;align-items:center;gap:7px;margin:0;font-size:14px;font-weight:600;white-space:nowrap}
    h2 svg{color:#5b8def}
    .chips{min-width:0;display:flex;gap:9px;overflow:hidden;font-size:12px;color:var(--text);font-variant-numeric:tabular-nums}
    .chip{display:inline-flex;align-items:center;gap:5px;white-space:nowrap}
    .chip::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--dot)}
    .chip[data-kind=running]{--dot:var(--running)}
    .chip[data-kind=human]{--dot:var(--attention);color:var(--attention)}
    button{font:inherit;color:inherit;border:0;background:none;padding:0;cursor:pointer;letter-spacing:inherit}
    .add{display:flex;align-items:center;gap:9px;width:100%;padding:9px 8px;border-radius:10px;color:var(--muted);text-align:left;transition:background-color .16s ease,color .16s ease}
    .add:hover{background:var(--hover);color:var(--text)}
    .add svg{flex:none}
    .add .title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .add b{font-weight:500;color:currentColor}
    ul{list-style:none;margin:0;padding:0;display:grid}
    /* 条目紧挨着排列，不铺底色；任务色只铺在状态图标底下的浅色圆角块上，和左侧侧栏条目的标记呼应。
       悬停时整行浅浅地铺一层任务色。 */
    .task{--task:#8b8d98;position:relative;display:flex;align-items:center;border-radius:10px;
      transition:background-color .16s ease;transform-origin:50% 60%}
    .task:hover,.task:focus-within,.task[data-peek]{background:color-mix(in srgb,var(--task) 12%,transparent)}
    .main{flex:1;min-width:0;display:grid;grid-template-columns:28px 1fr;column-gap:10px;align-items:center;padding:8px;text-align:left;border-radius:10px}
    .main:focus-visible{outline:2px solid color-mix(in srgb,var(--task) 55%,transparent);outline-offset:-2px}
    .status{position:relative;z-index:2;display:grid;place-items:center;width:28px;height:28px;border-radius:8px;
      background:color-mix(in srgb,var(--task) 16%,transparent);transform-origin:50% 100%;color:var(--muted)}
    .status svg{display:block;overflow:visible;width:18px;height:18px;filter:drop-shadow(0 1px 1px rgba(0,0,0,.08))}
    .status[data-icon=spin] svg{filter:none}
    .status[data-icon=spin] .arc{transform-origin:10px 10px;animation:turn .9s linear infinite}
    .text{min-width:0}
    .title{display:flex;align-items:center;gap:6px;min-width:0}
    .name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
    .tag{flex:none;display:inline-flex;align-items:center;gap:3px;padding:1px 6px;border-radius:6px;font-size:11px;font-weight:500;
      color:var(--attention);background:color-mix(in srgb,var(--attention) 13%,transparent)}
    .tag[data-tone=danger]{color:var(--danger);background:color-mix(in srgb,var(--danger) 12%,transparent)}
    .meta{position:relative;display:block;height:1.4em;margin-top:2px;overflow:hidden;font-size:12px}
    .meta:empty{display:none}
    .label{position:absolute;inset:0 auto 0 0;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text)}
    /* 进行中：文字整体压暗，一道亮带（文字本色）从左扫到右；用遮罩实现，深浅色主题都成立。
       内容变化时新文字从下方模糊浮入，旧文字向上淡出。 */
    .label.live{color:inherit;-webkit-mask-image:linear-gradient(90deg,rgba(0,0,0,.42) 40%,#000 50%,rgba(0,0,0,.42) 60%);
      mask-image:linear-gradient(90deg,rgba(0,0,0,.42) 40%,#000 50%,rgba(0,0,0,.42) 60%);-webkit-mask-size:300% 100%;mask-size:300% 100%;
      animation:sweep 1.8s linear infinite}
    .label.live.in{animation:roll-in .46s var(--ease) both,sweep 1.8s linear infinite}
    .label.in{animation:roll-in .46s var(--ease) both}
    .label.out{animation:roll-out .32s var(--ease) both}
    /* 需要人处理且还没看过：图标跳出条目，落下时砸得条目轻晃一下。常驻动画只动 transform，交给合成器。 */
    .task[data-hop]{animation:knock 3.2s infinite;will-change:transform}
    .task[data-hop] .status{animation:hop 3.2s infinite;will-change:transform}
    /* 有新回复还没看：图标像来消息的手机一样隔一会儿摇一下。 */
    .task[data-shake] .status{transform-origin:50% 50%;animation:shake 2.6s infinite;will-change:transform}
    .actions{position:absolute;right:6px;top:50%;display:flex;gap:2px;transform:translateY(-50%);opacity:0;pointer-events:none;transition:opacity .16s ease}
    .task:hover .actions,.task:focus-within .actions{opacity:1;pointer-events:auto}
    .task:hover .text,.task:focus-within .text{padding-right:86px}
    .icon{display:grid;place-items:center;width:26px;height:26px;border-radius:7px;color:var(--text);
      background:var(--cc-card-bg,transparent);box-shadow:inset 0 0 0 1px var(--line),0 1px 2px rgba(0,0,0,.05)}
    .icon:hover{color:currentColor;background:color-mix(in srgb,currentColor 9%,transparent)}
    .palette{flex:1;display:flex;align-items:center;justify-content:space-between;gap:4px;padding:12px 8px;min-height:60px}
    .palette button{width:22px;height:22px;border-radius:50%;background:var(--swatch);box-shadow:inset 0 0 0 1px rgba(0,0,0,.08);transition:transform .2s var(--ease)}
    .palette button:hover{transform:scale(1.15)}
    .palette button[aria-checked=true]{box-shadow:0 0 0 2px currentColor}
    .editor{flex:1;display:grid;grid-template-columns:28px 1fr;column-gap:10px;align-items:center;padding:8px}
    input{width:100%;font:inherit;font-weight:500;color:inherit;background:transparent;border:0;border-radius:6px;padding:2px 6px;margin:-2px -6px;
      outline:none;box-shadow:inset 0 0 0 1px color-mix(in srgb,currentColor 30%,transparent)}
    .empty{margin:6px 8px 6px;font-size:12.5px;line-height:1.55;color:var(--muted)}
    .note{margin:6px 8px 2px;font-size:12.5px;color:var(--danger)}
    .toast{display:flex;align-items:center;gap:10px;margin:8px 0 0;padding:7px 8px 7px 12px;border-radius:12px;font-size:12.5px;
      background:color-mix(in srgb,currentColor 90%,transparent);color:var(--cc-card-bg,Canvas);box-shadow:0 6px 20px rgba(0,0,0,.14)}
    .toast span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .toast button{font-weight:600;padding:3px 8px;border-radius:7px}
    .toast button:hover{background:color-mix(in srgb,var(--cc-card-bg,Canvas) 18%,transparent)}
    [hidden]{display:none!important}
    /* Trace 浮层放在顶层（popover），不受卡片宽度和裁剪限制，贴在看板左侧展开。 */
    .peek{position:fixed;inset:auto;margin:0;padding:14px 12px 12px;border:0;border-radius:14px;overflow:auto;max-height:calc(100vh - 24px);
      color:inherit;background:var(--cc-card-bg,Canvas);font:inherit;font-size:13.5px;line-height:1.4;
      box-shadow:0 0 0 .5px rgba(0,0,0,.14),0 12px 32px rgba(0,0,0,.16),0 2px 6px rgba(0,0,0,.06);
      opacity:0;transform:translateX(6px);transition:opacity .16s ease,transform .2s var(--ease),overlay .2s allow-discrete,display .2s allow-discrete}
    .peek:popover-open{opacity:1;transform:none}
    @starting-style{.peek:popover-open{opacity:0;transform:translateX(6px)}}
${TRACE_STYLE}
    @keyframes ray{0%{opacity:1}100%{opacity:.18}}
    @keyframes turn{to{transform:rotate(360deg)}}
    @keyframes sweep{from{-webkit-mask-position:100% 0;mask-position:100% 0}to{-webkit-mask-position:0 0;mask-position:0 0}}
    @keyframes roll-in{from{opacity:0;transform:translateY(70%);filter:blur(3px)}to{opacity:1;transform:none;filter:none}}
    @keyframes roll-out{from{opacity:1;transform:none;filter:none}to{opacity:0;transform:translateY(-70%);filter:blur(3px)}}
    @keyframes hop{
      0%{transform:none;animation-timing-function:ease-out}
      6%{transform:scale(1.14,.82);animation-timing-function:cubic-bezier(.2,.7,.3,1)}
      22%{transform:translateY(-26px) scale(.94,1.08);animation-timing-function:cubic-bezier(.6,0,.9,.5)}
      34%{transform:translateY(0) scale(.92,1.1)}
      38%{transform:scale(1.22,.78);animation-timing-function:ease-out}
      45%{transform:translateY(-4px) scale(.97,1.04);animation-timing-function:ease-in}
      51%,100%{transform:none}}
    @keyframes shake{
      0%,30%,100%{transform:none}
      4%{transform:rotate(-14deg)}
      8%{transform:rotate(12deg)}
      12%{transform:rotate(-10deg)}
      16%{transform:rotate(7deg)}
      20%{transform:rotate(-4deg)}
      24%{transform:rotate(2deg)}}
    @keyframes knock{
      0%,33.5%,60%,100%{transform:none}
      36%{transform:translateY(1.6px) rotate(-.7deg)}
      42%{transform:translateY(-.4px) rotate(.55deg)}
      48%{transform:rotate(-.3deg)}
      54%{transform:rotate(.12deg)}}
    @media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
  </style><section class="board" aria-label="任务看板">
    <header><h2>${SPARKLE}任务看板</h2><span class="chips"></span></header>
    <button type="button" class="add" hidden>${icon("plus")}<span class="title">加入当前会话 · <b></b></span></button>
    <ul></ul>
    <div class="peek" popover="manual" aria-label="会话 Trace"></div>
    <p class="empty" hidden></p>
    <p class="note" hidden></p>
    <div class="toast" role="status" hidden><span></span><button type="button">撤销</button></div>
  </section>`;
  const chips = root.querySelector(".chips");
  const addButton = root.querySelector(".add");
  const addTitle = addButton.querySelector("b");
  const list = root.querySelector("ul");
  const peek = root.querySelector(".peek");
  let trace = null;
  let peekTimer = null;
  let peekItem = null;
  const empty = root.querySelector(".empty");
  const note = root.querySelector(".note");
  const toast = root.querySelector(".toast");
  const toastText = toast.querySelector("span");
  const undoButton = toast.querySelector("button");
  const colors = threads?.colors ?? [];
  let board = null;
  let editing = null;
  let picking = null;
  const seeing = new Set();
  let undo = null;
  let cancelUndo = () => {};
  let loading = null;

  function showNote(message) {
    note.textContent = message || "";
    note.hidden = !message;
  }
  function fail(error) {
    if (signal.aborted || SILENT_CODES.has(error?.code)) return;
    showNote(error?.message || "操作失败，请稍后重试");
  }

  // 新建会话在本次运行中，侧栏条目用客户端临时 id；服务端给出别名，两个都认。
  const idsOf = (task) => [task.threadId, ...(task.aliases ?? [])];
  const taskFor = (id) => board?.tasks.find((task) => idsOf(task).includes(id));
  // 未自定义名字时，优先用左侧条目上的实时标题（Codex 起名或 rename 后会立即更新）。
  const displayName = (task) => task.customName ?? idsOf(task).map((id) => threads?.title(id)).find(Boolean) ?? task.name;

  function renderHeader() {
    const current = threads?.current();
    const added = current && taskFor(current.id);
    addButton.hidden = !board || !current || added;
    addTitle.textContent = current?.title ?? "未命名会话";
    addButton.title = current?.title ?? "";
    const running = board?.tasks.filter((task) => task.status === "running").length ?? 0;
    const human = board?.tasks.filter((task) => STATUS[task.status]?.human).length ?? 0;
    const nextChips = [running ? ["running", `${running} 进行中`] : null, human ? ["human", `${human} 需要你`] : null].filter(Boolean);
    if (chips.dataset.value !== JSON.stringify(nextChips)) {
      chips.dataset.value = JSON.stringify(nextChips);
      chips.replaceChildren(...nextChips.map(([kind, text]) => {
        const chip = element("span", "chip", text);
        chip.dataset.kind = kind;
        return chip;
      }));
    }
    if (!threads) empty.textContent = "任务看板需要在 Codex 注入模式下使用。";
    else if (!current) empty.textContent = "还没有任务。打开一个会话，就能把它加入看板。";
    else empty.textContent = "加入后会一直留在这里，做完点 ✓ 移出。";
    empty.hidden = Boolean(board?.tasks.length) && Boolean(threads);
  }

  function element(tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function colorToggle(button) {
    button.dataset.colorToggle = "";
    return button;
  }
  function iconButton(name, label, onClick) {
    const button = element("button", "icon");
    button.type = "button";
    button.title = label;
    button.setAttribute("aria-label", label);
    button.innerHTML = icon(name);
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", onClick);
    return button;
  }

  function renderEditor(task, item) {
    const editor = element("div", "editor");
    const input = doc.createElement("input");
    input.value = task.customName ?? "";
    input.placeholder = task.suggestedName ?? displayName(task);
    input.maxLength = 120;
    input.setAttribute("aria-label", "任务名，留空则使用推荐名");
    let settled = false;
    const finish = (save) => {
      if (settled) return;
      settled = true;
      editing = null;
      if (save && input.value.trim() !== (task.customName ?? "")) void mutate("rename", { threadId: task.threadId, name: input.value.trim() || null });
      else render();
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); finish(true); }
      else if (event.key === "Escape") { event.preventDefault(); finish(false); }
    });
    input.addEventListener("blur", () => finish(true));
    editor.append(statusIcon(task), input);
    item.append(editor);
    queueMicrotask(() => { input.focus(); input.select(); });
  }

  // 项目在侧栏上的名字；拿不到时，路径形式的 id 取最后一段，不透明 id 不展示。
  function projectName(projectId) {
    if (!projectId) return "";
    return threads?.projectLabel?.(projectId) ?? (/[\\/]/.test(projectId) ? projectId.split(/[\\/]/).filter(Boolean).at(-1) ?? "" : "");
  }
  // 第二行：进行中显示 Codex 此刻在做什么；其余显示时间和最后一句回复（提问时是问题本身）。
  function metaOf(task) {
    if (task.status === "running") return { live: true, text: task.activity || "思考中" };
    const when = ago(task.turnAt ?? task.updatedAt);
    if (task.status === "interrupted") return { text: ["已中断", when].filter(Boolean).join(" · ") };
    if (task.status === "stalled") return { text: ["长时间没有动静", when].filter(Boolean).join(" · ") };
    if (task.status === "archived" || task.status === "missing") return { text: STATUS[task.status].label };
    return { text: [when, task.summary || projectName(task.projectId)].filter(Boolean).join(" · ") };
  }
  function tagOf(task) {
    if (!STATUS[task.status]?.human) return null;
    return task.status === "asking" ? { text: "需要你" } : { text: task.status === "stalled" ? "没动静" : "已中断", tone: "danger" };
  }
  const iconOf = (task) => (task.status === "idle" && task.unread ? "unread" : STATUS[task.status]?.icon ?? "gone");

  function statusIcon(task) {
    const node = element("span", "status");
    node.dataset.icon = iconOf(task);
    node.title = statusLabel(task);
    node.setAttribute("role", "img");
    node.setAttribute("aria-label", statusLabel(task));
    // 渐变 id 每个图标唯一：同名 id 只认第一个，所在节点隐藏后其它图标会丢失填色。
    const glyph = STATUS_ICONS[node.dataset.icon].replaceAll("cc-task-", `cc-task-${++gradientSeq}-`);
    node.innerHTML = `<svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${glyph}</svg>`;
    return node;
  }

  function renderPalette(task) {
    const palette = element("div", "palette");
    palette.setAttribute("role", "radiogroup");
    palette.setAttribute("aria-label", "任务颜色");
    colors.forEach((color, index) => {
      const swatch = element("button");
      swatch.type = "button";
      swatch.title = COLOR_NAMES[index] ?? "";
      swatch.setAttribute("role", "radio");
      swatch.setAttribute("aria-checked", String(task.color === index));
      swatch.style.setProperty("--swatch", color);
      swatch.addEventListener("click", () => {
        picking = null;
        if (task.color === index) render();
        else void mutate("recolor", { threadId: task.threadId, color: index });
      });
      palette.append(swatch);
    });
    return palette;
  }

  // 第二行的文字换了就从下方浮入，旧文字向上淡出；没换就原样保留，扫光动画不被打断。
  function setLabel(meta, { text, live }) {
    const current = meta.querySelector(".label:not(.out)");
    if (current?.textContent === text && current.classList.contains("live") === Boolean(live)) return;
    const label = element("span", `label${live ? " live" : ""}`, text);
    if (current) {
      current.classList.remove("in");
      current.classList.add("out");
      current.addEventListener("animationend", () => current.remove(), { once: true });
      label.classList.add("in");
    }
    for (const stale of meta.querySelectorAll(".label.out")) if (stale !== current) stale.remove();
    meta.append(label);
  }

  function renderTask(task) {
    const item = element("li", "task");
    item.dataset.status = task.status;
    item.dataset.id = task.threadId;
    if (colors[task.color]) item.style.setProperty("--task", colors[task.color]);
    if (STATUS[task.status]?.human && task.unread) item.dataset.hop = "";
    else if (task.status === "idle" && task.unread) item.dataset.shake = "";
    if (editing === task.threadId) {
      renderEditor(task, item);
      return item;
    }
    if (picking === task.threadId) {
      item.append(renderPalette(task));
      return item;
    }
    const main = element("button", "main");
    main.type = "button";
    main.title = "在左侧定位并打开这个会话";
    const text = element("span", "text");
    const title = element("span", "title");
    title.append(element("span", "name", displayName(task)));
    const tag = tagOf(task);
    if (tag) {
      const badge = element("span", "tag", tag.text);
      if (tag.tone) badge.dataset.tone = tag.tone;
      title.append(badge);
    }
    const meta = element("span", "meta");
    setLabel(meta, metaOf(task));
    text.append(title, meta);
    main.append(statusIcon(task), text);
    main.addEventListener("click", () => { closePeek(); void reveal(task, item); });
    item.addEventListener("pointerenter", () => hoverPeek(task, item));
    item.addEventListener("pointerleave", schedulePeekClose);
    const actions = element("span", "actions");
    actions.append(
      colorToggle(iconButton("color", "换颜色", () => { picking = picking === task.threadId ? null : task.threadId; render(); })),
      iconButton("edit", "改名", () => { picking = null; editing = task.threadId; render(); }),
      iconButton("done", "完成，移出看板", () => { void complete(task); })
    );
    item.append(main, actions);
    return item;
  }

  // 用户正停在某个任务的会话里，就当作已经看过这次结果。
  function markSeen() {
    const current = threads?.current();
    const task = current && taskFor(current.id);
    if (!task?.unread || !Number.isSafeInteger(task.turnAt) || seeing.has(task.threadId)) return;
    seeing.add(task.threadId);
    void mutate("seen", { threadId: task.threadId, at: task.turnAt }).finally(() => seeing.delete(task.threadId));
  }

  function render() {
    renderHeader();
    markSeen();
    if (!board || editing && root.activeElement?.tagName === "INPUT") return;
    const ordered = board.tasks.map((task, index) => ({ task, index }))
      .sort((a, b) => rankOf(a.task) - rankOf(b.task) || a.index - b.index).map(({ task }) => task);
    // 按条目复用节点：只有第二行变了就原地换文字，不重建条目，跳动、扫光和悬停状态都不被打断。
    const existing = new Map([...list.children].map((node) => [node.dataset.id, node]));
    const nodes = ordered.map((task) => {
      const key = JSON.stringify([editing === task.threadId, picking === task.threadId, task.color, task.status, task.unread, displayName(task), tagOf(task)]);
      const previous = existing.get(task.threadId);
      if (previous?.dataset.key === key) {
        const meta = previous.querySelector(".meta");
        if (meta) setLabel(meta, metaOf(task));
        return previous;
      }
      const node = renderTask(task);
      node.dataset.key = key;
      return node;
    });
    if (nodes.length !== list.children.length || nodes.some((node, index) => list.children[index] !== node)) list.replaceChildren(...nodes);
    // 条目重建后把浮层的锚点换到新节点上；任务已移出就关掉浮层。
    if (peekItem && !peekItem.isConnected) {
      const next = nodes.find((node) => node.dataset.id === peekItem.dataset.id);
      if (!next || editing || picking) closePeek();
      else { peekItem = next; next.setAttribute("data-peek", ""); }
    }
  }

  function accept(next) {
    if (signal.aborted || !next) return;
    board = next;
    threads?.setMarks(board.tasks.flatMap((task) => idsOf(task).map((id) => ({ id, color: task.color }))));
    render();
  }

  async function mutate(method, params) {
    try {
      const next = await rpc(method, params);
      showNote("");
      accept(next);
      return next;
    } catch (error) { fail(error); render(); return null; }
  }

  function refresh() {
    loading ??= rpc("list").then(accept, fail).finally(() => { loading = null; });
    return loading;
  }

  // 卡片可见时保持一个长轮询；收起时断开，展开时重新连上。
  let watching = null;
  function startWatch() {
    if (watching || signal.aborted) return;
    const controller = new AbortController();
    watching = controller;
    void (async () => {
      while (!controller.signal.aborted && !signal.aborted) {
        try {
          const since = board?.sig ?? null;
          const next = await rpc("watch", { since, waitMs: WATCH_WAIT_MS }, { signal: controller.signal, timeoutMs: WATCH_WAIT_MS + 15_000 });
          accept(next);
          // 服务端只在超时后才返回未变化的结果；万一立即返回，也歇一下再连，避免空转。
          if (since !== null && next?.sig === since) await new Promise((resolve) => effects.timeout(resolve, WATCH_RETRY_MS));
        } catch (error) {
          if (controller.signal.aborted || signal.aborted) break;
          fail(error);
          await new Promise((resolve) => effects.timeout(resolve, WATCH_RETRY_MS));
        }
      }
    })();
  }
  function stopWatch() {
    watching?.abort();
    watching = null;
  }

  // 悬停在任务上一会儿，在看板左侧弹出这个会话的 Trace；鼠标移进浮层不关，离开后稍等再关。
  function cancelPeek() { peekTimer?.(); peekTimer = null; }
  function closePeek() {
    cancelPeek();
    peekItem?.removeAttribute("data-peek");
    peekItem = null;
    if (peek.matches(":popover-open")) peek.hidePopover();
    trace?.setActive(false);
  }
  function schedulePeekClose() {
    cancelPeek();
    if (peekItem) peekTimer = effects.timeout(closePeek, PEEK_CLOSE_MS);
  }
  function placePeek(item) {
    const view = doc.defaultView;
    const card = root.host?.getBoundingClientRect?.() ?? item.getBoundingClientRect();
    const row = item.getBoundingClientRect();
    const room = card.left - 20;
    // 左侧放得下就贴在看板左边；放不下（窗口很窄）就盖在看板上方，宽度取窗口宽。
    const width = room >= PEEK_MIN_WIDTH ? Math.min(PEEK_MAX_WIDTH, room) : Math.min(PEEK_MAX_WIDTH, view.innerWidth - 24);
    const left = room >= PEEK_MIN_WIDTH ? card.left - 8 - width : Math.max(12, view.innerWidth - 12 - width);
    peek.style.width = `${width}px`;
    peek.style.left = `${left}px`;
    const height = peek.offsetHeight;
    peek.style.top = `${Math.max(12, Math.min(row.top - 14, view.innerHeight - 12 - height))}px`;
  }
  function openPeek(task, item) {
    if (!item.isConnected || editing || picking) return;
    peekItem?.removeAttribute("data-peek");
    peekItem = item;
    item.setAttribute("data-peek", "");
    // 先定宽再画：Trace 按可视宽度挑时间比例。
    if (!peek.matches(":popover-open")) peek.showPopover();
    placePeek(item);
    trace.show(task.threadId, displayName(task));
    trace.setActive(true);
  }
  function hoverPeek(task, item) {
    cancelPeek();
    // 浮层已经开着时，在条目间移动直接切换，不再等待。
    if (peekItem && peekItem !== item) { openPeek(task, item); return; }
    if (peekItem === item) return;
    peekTimer = effects.timeout(() => { peekTimer = null; openPeek(task, item); }, PEEK_OPEN_MS);
  }

  async function reveal(task, item) {
    if (!threads) return;
    const id = idsOf(task).find((item) => threads.has(item)) ?? task.threadId;
    const result = await threads.reveal(id, { source: item.querySelector(".status") ?? item, projectId: task.projectId });
    if (signal.aborted || result.ok) return;
    // 侧栏里找不到（例如会话不在当前列表中）时，交给 Codex 深链打开。
    try { await rpc("open", { threadId: task.threadId }); } catch (error) { fail(error); }
  }

  async function complete(task) {
    const next = await mutate("remove", { threadId: task.threadId });
    if (!next?.removed) return;
    cancelUndo();
    undo = next.removed;
    toastText.textContent = `已完成「${displayName(task)}」`;
    toast.hidden = false;
    cancelUndo = effects.timeout(() => { undo = null; toast.hidden = true; }, UNDO_MS);
  }

  effects.listen(undoButton, "click", () => {
    if (!undo) return;
    const restored = undo;
    undo = null;
    cancelUndo();
    toast.hidden = true;
    void mutate("restore", restored);
  });
  effects.listen(addButton, "click", () => {
    const current = threads?.current();
    if (!current) return;
    addButton.hidden = true;
    void mutate("add", { threadId: current.id, title: current.title, projectId: current.projectId });
  });
  // 点在色板外面或按 Esc 关闭色板。
  effects.listen(doc, "pointerdown", (event) => {
    if (!picking || event.composedPath().some((node) => node?.classList?.contains("palette") || node?.dataset?.colorToggle !== undefined)) return;
    picking = null;
    render();
  });
  effects.listen(doc, "keydown", (event) => {
    if (event.key !== "Escape" || !picking) return;
    picking = null;
    render();
  });
  effects.listen(doc, "keydown", (event) => { if (event.key === "Escape") closePeek(); });
  effects.listen(peek, "pointerenter", () => cancelPeek());
  effects.listen(peek, "pointerleave", () => schedulePeekClose());
  if (threads) effects.add(threads.subscribe(render));
  // 卡片收起时不必刷新状态；颜色标记由平台在侧栏重绘时自行补回。
  effects.add(stopWatch);
  effects.add(() => threads?.setMarks([]));
  trace = createTraceView({ rpc, effects, signal, threads, element, fail, isVisible });
  peek.append(trace.root);
  effects.add(closePeek);
  // Trace 读到数据后浮层会变高，重新贴位置，避免超出窗口底部。
  const peekResize = new doc.defaultView.ResizeObserver(() => { if (peekItem?.isConnected) placePeek(peekItem); });
  peekResize.observe(peek);
  effects.add(() => peekResize.disconnect());
  render();
  void refresh();
  if (isVisible()) startWatch();
  return {
    visibilityChanged({ visible }) {
      if (visible) { void refresh(); startWatch(); } else stopWatch();
      if (!visible) closePeek();
      trace.visibilityChanged(visible);
    },
    dispose() { root.replaceChildren(); }
  };
}
