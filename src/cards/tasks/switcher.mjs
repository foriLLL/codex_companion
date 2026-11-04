// Option+Tab 在任务看板的会话之间切换，手感照 macOS ⌘Tab：按住 Option 连按 Tab 选择，松开 Option 切过去；
// 快速点按不弹面板，直接回到上一个会话。Shift+Tab 与方向键反向，Esc 取消。
// 顺序按最近在 Codex 里打开的先后；面板放在平台的顶层浮层里，卡片抽屉收起时也能弹出。
// 只在 macOS 上启用：Linux 桌面环境自己占用 Alt+Tab 切窗口，按键到不了 Codex。

// 按住超过这么久才弹出面板，快速点按时不闪一下。
export const SHOW_DELAY_MS = 150;
const MAX_RECENT = 100;

export const isMac = (platform) => /mac|darwin/i.test(String(platform ?? ""));

/** 记一次打开：移到最前，去重并限长。没变化时返回原数组。 */
export function touchRecent(recent, id) {
  if (!id || recent[0] === id) return recent;
  return [id, ...recent.filter((item) => item !== id)].slice(0, MAX_RECENT);
}

/** 最近打开过的在前（越近越前），没打开过的按传入的看板顺序排在后面。 */
export function orderByRecent(tasks, recent) {
  const rank = new Map(recent.map((id, index) => [id, index]));
  return tasks.map((task, index) => ({ task, index, rank: rank.get(task.threadId) ?? Infinity }))
    .sort((a, b) => (a.rank === b.rank ? a.index - b.index : a.rank - b.rank))
    .map(({ task }) => task);
}

// Option+Tab（可带 Shift）；带 ⌘ / Ctrl 的组合与输入法组字中的按键都不算。
function isTrigger(event) {
  return (event.key === "Tab" || event.code === "Tab") && event.altKey && !event.metaKey && !event.ctrlKey && !event.isComposing;
}

/**
 * 按键状态机，不碰 DOM。phase：idle（没按）→ held（按住 Option、面板还没弹出）→ open（面板已弹出）。
 * keydown / keyup 返回 true 表示这次按键归切换器处理，调用方要拦下，不再交给 Codex。
 * items() 给出按最近使用排好的任务；current() 给出当前会话对应的任务 id（不在看板里为 null）。
 */
export function createSwitchController({ items, current = () => null, pick, prepare = () => {}, schedule, onChange = () => {}, enabled = () => true, platform }) {
  const mac = isMac(platform);
  let phase = "idle";
  let list = [];
  let selected = null;
  let cancelShow = null;
  const wrap = (index) => ((index % list.length) + list.length) % list.length;
  const indexOf = (id = selected) => list.findIndex((task) => task.threadId === id);

  function reset() {
    cancelShow?.();
    cancelShow = null;
    const was = phase;
    phase = "idle";
    list = [];
    selected = null;
    if (was !== "idle") onChange();
  }
  function show() {
    if (phase !== "held") return;
    cancelShow?.();
    cancelShow = null;
    phase = "open";
  }
  function start(direction) {
    const next = items();
    if (!next.length) return false;
    list = next;
    // 当前会话在看板里就从它的后一个（反向为前一个）开始；不在看板里，正向从最近的一个、反向从最后一个开始。
    const here = indexOf(current());
    selected = list[wrap((here >= 0 ? here : direction > 0 ? -1 : 0) + direction)].threadId;
    phase = "held";
    cancelShow = schedule(() => { cancelShow = null; show(); onChange(); }, SHOW_DELAY_MS);
    // 抽屉收起时看板不实时同步，先用已有数据显示，同时请卡片刷新一次。
    prepare();
    onChange();
    return true;
  }
  function commit() {
    const task = list[indexOf()];
    reset();
    if (task) pick(task);
  }

  return {
    get phase() { return phase; },
    get list() { return list; },
    get selected() { return selected; },
    keydown(event) {
      if (phase === "idle") return mac && isTrigger(event) && enabled() ? start(event.shiftKey ? -1 : 1) : false;
      // 松开 Option 时漏了 keyup（例如焦点短暂离开），下一次按键补上。
      if (!event.altKey) { commit(); return true; }
      const delta = event.key === "Tab" ? (event.shiftKey ? -1 : 1)
        : event.key === "ArrowDown" || event.key === "ArrowRight" ? 1
          : event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 0;
      if (delta) {
        selected = list[wrap(indexOf() + delta)].threadId;
        show();
        onChange();
      } else if (event.key === "Enter") commit();
      else if (event.key === "Escape") reset();
      // 其余按键也一律拦下：按住 Option 时敲字母会在输入框里打出特殊字符。
      return true;
    },
    keyup(event) {
      if (phase === "idle") return false;
      if (!event.altKey) commit();
      return true;
    },
    cancel: reset,
    hover(id) {
      if (phase !== "open" || id === selected || indexOf(id) < 0) return;
      selected = id;
      onChange();
    },
    choose(id) {
      if (phase === "idle" || indexOf(id) < 0) return;
      selected = id;
      commit();
    },
    // 面板开着时看板数据更新：顺序保持不动，只换条目内容；新加入的排到最后，被移出的去掉。
    refresh() {
      if (phase === "idle") return;
      const fresh = items();
      const byId = new Map(fresh.map((task) => [task.threadId, task]));
      const at = Math.max(0, indexOf());
      const next = list.map((task) => byId.get(task.threadId)).filter(Boolean);
      const kept = new Set(next.map((task) => task.threadId));
      for (const task of fresh) if (!kept.has(task.threadId)) next.push(task);
      if (!next.length) { reset(); return; }
      list = next;
      if (indexOf() < 0) selected = list[Math.min(at, list.length - 1)].threadId;
      onChange();
    }
  };
}

const PANEL_STYLE = `
  .backdrop{position:fixed;inset:0;pointer-events:auto}
  .backdrop[hidden]{display:none}
  .panel{position:fixed;left:50%;top:46%;width:min(440px,calc(100vw - 48px));max-height:min(560px,calc(100vh - 96px));
    display:flex;flex-direction:column;padding:6px;border-radius:16px;overflow:hidden;transform:translate(-50%,-50%);
    color:var(--color-token-text-primary,CanvasText);background:var(--color-token-dropdown-background,Canvas);
    box-shadow:0 0 0 .5px var(--color-token-border-heavy,rgba(0,0,0,.14)),0 18px 50px rgba(0,0,0,.22),0 3px 10px rgba(0,0,0,.08);
    font-family:"Inter",ui-sans-serif,system-ui,-apple-system,"PingFang SC",sans-serif;font-size:13.5px;line-height:1.4;
    letter-spacing:-.006em;-webkit-font-smoothing:antialiased;-webkit-app-region:no-drag;animation:pop .16s var(--ease) both}
  .panel *{box-sizing:border-box}
  ul{position:relative;min-height:0;list-style:none;margin:0;padding:0;display:grid;gap:2px;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin}
  .item{--task:#8b8d98;display:grid;grid-template-columns:28px 1fr;column-gap:10px;align-items:center;padding:8px;border-radius:10px;cursor:default}
  .item[aria-selected=true]{background:color-mix(in srgb,var(--task) 15%,transparent);box-shadow:inset 0 0 0 1.5px color-mix(in srgb,var(--task) 55%,transparent)}
  footer{display:flex;justify-content:center;gap:14px;padding:8px 8px 4px;font-size:11.5px;color:var(--muted);white-space:nowrap}
  kbd{font:inherit;font-weight:600;color:var(--text)}
  @keyframes pop{from{opacity:0;transform:translate(-50%,-50%) scale(.97)}}
  @media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;

/**
 * 把状态机接到页面上：窗口捕获阶段监听按键（先于 Codex 自己的快捷键），面板画在 overlay.root 里。
 * style 是条目共用的样式（含 .panel 上要用的颜色变量）；renderItem(task, item) 往 li 里填条目内容。
 */
export function createSwitcher({ doc, overlay, effects, style = "", renderItem, platform, ...options }) {
  const view = doc.defaultView;
  const nav = view?.navigator;
  let panel = null;
  let shown = null;
  const controller = createSwitchController({
    ...options, platform: platform ?? nav?.userAgentData?.platform ?? nav?.platform,
    schedule: (fn, ms) => effects.timeout(fn, ms), onChange: () => paint()
  });

  function build() {
    const root = overlay.root;
    root.innerHTML = `<style>${style}${PANEL_STYLE}</style><div class="backdrop" hidden>
      <div class="panel" role="listbox" aria-label="切换看板会话"><ul></ul>
        <footer><span><kbd>⌥</kbd> 松开切换</span><span><kbd>⇧ Tab</kbd> 反向</span><span><kbd>Esc</kbd> 取消</span></footer></div></div>`;
    const backdrop = root.querySelector(".backdrop");
    const list = root.querySelector("ul");
    // 点在面板外面取消；面板弹出时鼠标没动不改选中，真的移动了才跟着鼠标走。
    backdrop.addEventListener("pointerdown", (event) => { if (event.target === backdrop) controller.cancel(); });
    list.addEventListener("pointermove", (event) => {
      if (!event.movementX && !event.movementY) return;
      const item = event.target.closest?.(".item");
      if (item) controller.hover(item.dataset.id);
    });
    list.addEventListener("click", (event) => {
      const item = event.target.closest?.(".item");
      if (item) controller.choose(item.dataset.id);
    });
    return { backdrop, list };
  }

  function paint() {
    if (controller.phase !== "open") {
      if (panel) panel.backdrop.hidden = true;
      shown = null;
      return;
    }
    if (!panel?.backdrop.isConnected) { panel = build(); shown = null; }
    // 列表换了（刚弹出或看板数据更新）才重建条目；只换选中时原地改属性，转圈和扫光不被打断。
    if (shown !== controller.list) {
      shown = controller.list;
      panel.list.replaceChildren(...shown.map((task) => {
        const item = doc.createElement("li");
        item.className = "item";
        item.dataset.id = task.threadId;
        item.setAttribute("role", "option");
        renderItem(task, item);
        return item;
      }));
    }
    for (const item of panel.list.children) item.setAttribute("aria-selected", String(item.dataset.id === controller.selected));
    panel.backdrop.hidden = false;
    // 只滚动列表自己，不用 scrollIntoView，免得连带滚动 Codex 页面。
    const item = panel.list.querySelector('[aria-selected="true"]');
    const box = panel.list;
    if (item && item.offsetTop < box.scrollTop) box.scrollTop = item.offsetTop;
    else if (item && item.offsetTop + item.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = item.offsetTop + item.offsetHeight - box.clientHeight;
  }

  const swallow = (event) => { event.preventDefault(); event.stopImmediatePropagation(); };
  effects.listen(view, "keydown", (event) => { if (controller.keydown(event)) swallow(event); }, true);
  effects.listen(view, "keyup", (event) => { if (controller.keyup(event)) swallow(event); }, true);
  // 窗口失焦（切到别的应用、弹出系统对话框）就取消，不在用户看不见的时候切走。
  effects.listen(view, "blur", () => controller.cancel());
  effects.add(() => controller.cancel());

  return {
    refresh: () => controller.refresh(),
    cancel: () => controller.cancel(),
    get phase() { return controller.phase; }
  };
}
