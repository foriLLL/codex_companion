/**
 * Codex 左侧会话列表的定位、标记与指向动画。只依赖 Codex 自带的 data-app-action-*
 * 自动化属性；原生节点上只增删自有的 data-codex-companion-task 属性，不改 style/class。
 * 属性缺失（Codex 改版）时一律降级为「找不到」，由调用方回退到深链打开。
 * 工厂函数保持自包含，冒烟脚本以 toString() 注入独立浏览器验证。
 */
export function createCodexThreads({ document, onError } = {}) {
  const window = document.defaultView;
  const ATTR = {
    row: "data-app-action-sidebar-thread-row",
    id: "data-app-action-sidebar-thread-id",
    kind: "data-app-action-sidebar-thread-kind",
    active: "data-app-action-sidebar-thread-active",
    title: "data-app-action-sidebar-thread-title",
    scroll: "data-app-action-sidebar-scroll",
    projectList: "data-app-action-sidebar-project-list-id",
    projectRow: "data-app-action-sidebar-project-row",
    projectId: "data-app-action-sidebar-project-id",
    projectCollapsed: "data-app-action-sidebar-project-collapsed",
    projectLabel: "data-app-action-sidebar-project-label",
    showAll: "data-app-action-sidebar-project-show-all",
    showAllToggle: "data-app-action-sidebar-project-show-all-toggle",
    section: "data-app-action-sidebar-section",
    sectionCollapsed: "data-app-action-sidebar-section-collapsed",
    sectionToggle: "data-app-action-sidebar-section-toggle"
  };
  const MARK = "data-codex-companion-task";
  const LANDING = "data-codex-companion-task-landing";
  const STYLE_ID = "codex-companion-thread-marks";
  const FLOW_CLASS = "codex-companion-thread-flow";
  const SIDEBAR_ID = "app-shell-sidebar";
  // 薄荷、天空蓝、杏橙、樱粉、薰衣草、湖青、柠檬黄、深靛；顺序即看板分配颜色的顺序。
  const COLORS = Object.freeze(["#3fb37f", "#3b8ff0", "#f08a36", "#ee6b8f", "#a07ae8", "#1fb0bc", "#e6b422", "#3f3ca8"]);
  const THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,127}$/;
  const EXPAND_ATTEMPTS = 8;
  const marks = new Map();
  const listeners = new Set();
  let observer = null;
  let frame = 0;
  let signature = "";
  let disposed = false;

  const report = (error) => { try { onError?.(error); } catch {} };
  const css = (value) => (window.CSS?.escape ? window.CSS.escape(value) : String(value).replace(/["\\]/g, "\\$&"));
  const nextFrame = () => new Promise((resolve) => window.requestAnimationFrame(() => resolve()));

  // 侧栏 id 形如 local:<会话 id> 或 local:<hostId>:<会话 id>；只认本机会话。
  function parseId(value) {
    if (typeof value !== "string" || !value.startsWith("local:")) return null;
    const id = value.slice(value.lastIndexOf(":") + 1);
    return THREAD_ID.test(id) ? id : null;
  }
  function rowId(row) {
    if (row.getAttribute(ATTR.kind) === "remote") return null;
    return parseId(row.getAttribute(ATTR.id));
  }
  function rows() { return Array.from(document.querySelectorAll(`[${ATTR.row}]`)); }
  function rowFor(id) { return rows().find((row) => rowId(row) === id) ?? null; }
  function titleOf(row) {
    const title = row.getAttribute(ATTR.title) || row.querySelector("[data-thread-title]")?.textContent || "";
    return title.trim().slice(0, 200) || null;
  }
  function describe(row) {
    const id = rowId(row);
    if (!id) return null;
    return { id, title: titleOf(row), projectId: row.closest(`[${ATTR.projectList}]`)?.getAttribute(ATTR.projectList) || null };
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = [
      // 注册为颜色类型，落点高亮才能平滑过渡回常态底色。
      "@property --codex-companion-tint{syntax:'<color>';inherits:false;initial-value:transparent}",
      ...COLORS.map((color, index) => `[${MARK}="${index}"]{--codex-companion-task:${color}}`),
      // background-image 叠在原生 hover/active 背景之上，不覆盖它们。
      `[${MARK}]{--codex-companion-tint:color-mix(in srgb,var(--codex-companion-task) 13%,transparent);background-image:linear-gradient(var(--codex-companion-tint),var(--codex-companion-tint))!important;box-shadow:inset 2px 0 0 color-mix(in srgb,var(--codex-companion-task) 85%,transparent)}`,
      `[${MARK}][${LANDING}]{animation:codex-companion-task-land .7s ease-out}`,
      "@keyframes codex-companion-task-land{0%{--codex-companion-tint:color-mix(in srgb,var(--codex-companion-task) 34%,transparent)}100%{--codex-companion-tint:color-mix(in srgb,var(--codex-companion-task) 13%,transparent)}}",
      `.${FLOW_CLASS}{position:fixed;inset:0;pointer-events:none;z-index:2147483646}`,
      `@media (prefers-reduced-motion:reduce){[${MARK}][${LANDING}]{animation:none}}`
    ].join("\n");
    (document.head ?? document.documentElement).append(style);
  }

  // 一次扫描侧栏，标记和快照共用；侧栏条目数 × 标记数的重复查询放在每帧里不划算。
  function applyMarks(all) {
    for (const row of all) {
      const color = marks.get(rowId(row));
      const value = color === undefined ? null : String(color);
      if (row.getAttribute(MARK) === value) continue;
      if (value === null) row.removeAttribute(MARK);
      else row.setAttribute(MARK, value);
    }
  }

  function snapshot(all) {
    const current = all.find((row) => row.getAttribute(ATTR.active) === "true");
    const byId = new Map();
    for (const row of all) {
      const id = rowId(row);
      if (id && marks.has(id) && !byId.has(id)) byId.set(id, row);
    }
    const parts = [current ? `${rowId(current)}\u0000${titleOf(current)}` : ""];
    for (const id of marks.keys()) {
      const row = byId.get(id);
      parts.push(`${id}\u0000${row ? titleOf(row) : ""}`);
    }
    return parts.join("\u0001");
  }

  function flush() {
    frame = 0;
    if (disposed) return;
    try {
      const all = rows();
      applyMarks(all);
      const next = snapshot(all);
      if (next === signature) return;
      signature = next;
      for (const listener of listeners) {
        try { listener(); } catch (error) { report(error); }
      }
    } catch (error) { report(error); }
  }
  const schedule = () => { if (!frame && !disposed) frame = window.requestAnimationFrame(flush); };
  // Codex 输出回复时正文区会持续变动；有侧栏容器时只处理落在侧栏里（或替换了侧栏）的变化。
  function onMutations(records) {
    const sidebar = document.getElementById(SIDEBAR_ID);
    if (sidebar && !records.some((record) => sidebar.contains(record.target) || record.target.contains(sidebar))) return;
    schedule();
  }

  // 只在有订阅或标记时观察侧栏；React 重绘会替换节点，标记在下一帧补回。
  function syncObserver() {
    const needed = !disposed && (listeners.size > 0 || marks.size > 0);
    if (needed && !observer) {
      observer = new window.MutationObserver(onMutations);
      observer.observe(document.documentElement, {
        childList: true, subtree: true, attributes: true, attributeFilter: [ATTR.id, ATTR.active, ATTR.title]
      });
      schedule();
    } else if (!needed && observer) {
      observer.disconnect();
      observer = null;
    }
  }

  async function waitFor(find, timeoutMs) {
    const deadline = window.performance.now() + timeoutMs;
    for (;;) {
      const found = find();
      if (found || disposed || window.performance.now() >= deadline) return found ?? null;
      await nextFrame();
    }
  }

  // 依次展开可能藏着该会话的项目、「显示全部」与折叠分区；每步之后重新查找。
  function nextExpansion(projectId) {
    if (projectId) {
      const project = document.querySelector(`[${ATTR.projectRow}][${ATTR.projectId}="${css(projectId)}"][${ATTR.projectCollapsed}="true"]`);
      if (project) return project;
      const list = document.querySelector(`[${ATTR.projectList}="${css(projectId)}"][${ATTR.showAll}="false"]`);
      const toggle = list?.querySelector(`[${ATTR.showAllToggle}]`);
      if (toggle) return toggle;
    }
    const section = document.querySelector(`[${ATTR.section}][${ATTR.sectionCollapsed}="true"]`);
    if (section) return section.querySelector(`[${ATTR.sectionToggle}]`) ?? section;
    if (!projectId) {
      const project = document.querySelector(`[${ATTR.projectRow}][${ATTR.projectCollapsed}="true"]`);
      if (project) return project;
    }
    return document.querySelector(`[${ATTR.showAll}="false"] [${ATTR.showAllToggle}]`);
  }

  async function locate(id, projectId) {
    let row = rowFor(id);
    const tried = new Set();
    for (let attempt = 0; !row && attempt < EXPAND_ATTEMPTS; attempt += 1) {
      const expansion = nextExpansion(projectId);
      if (!expansion || tried.has(expansion)) break;
      tried.add(expansion);
      expansion.click();
      row = await waitFor(() => rowFor(id), 600);
    }
    return row;
  }

  function isVisible(row) {
    const rect = row.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    const container = row.closest(`[${ATTR.scroll}]`)?.getBoundingClientRect()
      ?? { top: 0, bottom: window.innerHeight, left: 0, right: window.innerWidth };
    return rect.top >= container.top - 1 && rect.bottom <= container.bottom + 1 && rect.left < container.right && rect.right > container.left;
  }

  // 平滑滚动结束（连续两帧位置不变且完整可见）后才开始动画。
  async function scrollIntoView(row) {
    if (!isVisible(row)) row.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
    let last = null;
    let stable = 0;
    await waitFor(() => {
      const top = row.getBoundingClientRect().top;
      stable = last !== null && Math.abs(top - last) < 0.5 ? stable + 1 : 0;
      last = top;
      return row.isConnected && isVisible(row) && stable >= 2;
    }, 1200);
  }

  function reducedMotion() {
    try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; }
  }

  // 一股液流沿弧线从看板流向侧栏条目：头粗尾细的形状每帧按贝塞尔曲线算成一个多边形，
  // 不用模糊滤镜（铺满窗口的滤镜每帧都要整屏重算，会明显掉帧）。
  // 液流头部到达条目时返回，调用方此时就打开会话。打开会话时 Codex 主线程会忙上一阵，
  // 所以到达之后的铺开与淡出只用 transform/opacity，交给合成器播放，不随主线程卡住。
  async function flow(from, row, color) {
    const to = row.getBoundingClientRect();
    if (!from?.width || !to.width) return;
    const SVG = "http://www.w3.org/2000/svg";
    const start = { x: from.left + from.width / 2, y: from.top + from.height / 2 };
    const end = { x: to.left + Math.min(28, to.width / 2), y: to.top + to.height / 2 };
    const control = { x: (start.x + end.x) / 2, y: Math.max(16, Math.min(start.y, end.y) - Math.min(140, Math.abs(start.x - end.x) * 0.22)) };
    const radius = Number.parseFloat(window.getComputedStyle(row).borderTopLeftRadius) || 8;
    const DURATION = 200;
    const TAIL = 0.5;
    const HEAD = 15;
    const SAMPLES = 16;
    const at = (t) => {
      const u = 1 - t;
      return { x: u * u * start.x + 2 * u * t * control.x + t * t * end.x, y: u * u * start.y + 2 * u * t * control.y + t * t * end.y };
    };
    const normal = (t) => {
      const dx = 2 * (1 - t) * (control.x - start.x) + 2 * t * (end.x - control.x);
      const dy = 2 * (1 - t) * (control.y - start.y) + 2 * t * (end.y - control.y);
      const length = Math.hypot(dx, dy) || 1;
      return { x: -dy / length, y: dx / length };
    };
    const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
    const layer = document.createElement("div");
    layer.className = FLOW_CLASS;
    layer.setAttribute("aria-hidden", "true");
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
    svg.style.cssText = "position:absolute;inset:0;overflow:visible";
    const body = document.createElementNS(SVG, "path");
    const head = document.createElementNS(SVG, "circle");
    for (const node of [body, head]) node.setAttribute("fill", color);
    svg.append(body, head);
    svg.style.willChange = "opacity";
    // 落点：直接按条目大小铺好，从落点处一个水滴大小缩放展开。
    const pool = document.createElement("div");
    pool.style.cssText = `position:absolute;left:${to.left}px;top:${to.top}px;width:${to.width}px;height:${to.height}px;border-radius:${radius}px;`
      + `background:${color};transform-origin:${end.x - to.left}px ${end.y - to.top}px;transform:scale(0);will-change:transform`;
    layer.append(svg, pool);
    layer.style.opacity = "0.82";
    document.documentElement.append(layer);

    // 尾端从 0 宽渐变到头部宽度，尾长为曲线的一半；到终点后整体淡出、落点铺开。
    function draw(progress) {
      const front = Math.min(1, progress);
      const back = Math.max(0, progress - TAIL);
      const left = [];
      const right = [];
      for (let index = 0; index <= SAMPLES; index += 1) {
        const ratio = index / SAMPLES;
        const t = back + (front - back) * ratio;
        const point = at(t);
        const offset = normal(t);
        const half = (HEAD / 2) * (0.1 + 0.9 * ratio ** 1.5);
        left.push(`${(point.x + offset.x * half).toFixed(1)} ${(point.y + offset.y * half).toFixed(1)}`);
        right.push(`${(point.x - offset.x * half).toFixed(1)} ${(point.y - offset.y * half).toFixed(1)}`);
      }
      body.setAttribute("d", `M ${left.join(" L ")} L ${right.reverse().join(" L ")} Z`);
      const tip = at(front);
      head.setAttribute("cx", tip.x.toFixed(1));
      head.setAttribute("cy", tip.y.toFixed(1));
      head.setAttribute("r", String(HEAD / 2));
    }

    let arrive;
    const arrived = new Promise((resolve) => { arrive = resolve; });
    const began = window.performance.now();
    function land() {
      const drop = Math.min(1, 22 / to.width);
      pool.animate([{ transform: `scale(${drop},${Math.min(1, 22 / to.height)})` }, { transform: "scale(1)" }],
        { duration: 220, easing: "cubic-bezier(.3,0,.2,1)", fill: "both" });
      svg.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, easing: "ease-out", fill: "both" });
      layer.animate([{ opacity: 0.82 }, { opacity: 0.82, offset: 0.3 }, { opacity: 0 }], { duration: 360, easing: "ease-out", fill: "both" })
        .finished.catch(() => {}).finally(() => layer.remove());
      // 等两帧让合成器接手这些动画，再交还调用方去打开会话。
      window.requestAnimationFrame(() => window.requestAnimationFrame(arrive));
    }
    const step = (now) => {
      if (disposed || !layer.isConnected) { arrive(); return; }
      const elapsed = Math.min(1, (now - began) / DURATION);
      const progress = ease(elapsed);
      draw(progress);
      if (progress >= 1) land();
      else window.requestAnimationFrame(step);
    };
    draw(0);
    window.requestAnimationFrame(step);
    await arrived;
  }

  function land(row) {
    row.removeAttribute(LANDING);
    // 强制回流后再加属性，连续点击同一条目时动画能重新播放。
    void row.offsetWidth;
    row.setAttribute(LANDING, "");
    window.setTimeout(() => row.removeAttribute(LANDING), 800);
  }

  function activate(row) {
    if (row.getAttribute(ATTR.active) === "true") return;
    (row.querySelector("a[href], [data-interactive-row-link]") ?? row).click();
  }

  return Object.freeze({
    colors: COLORS,
    current() {
      const row = rows().find((item) => item.getAttribute(ATTR.active) === "true");
      return row ? describe(row) : null;
    },
    has(id) { return Boolean(rowFor(id)); },
    title(id) {
      const row = rowFor(id);
      return row ? titleOf(row) : null;
    },
    // 项目在侧栏上显示的名字；projectId 在 Codex 里是不透明 id，不适合直接展示。
    projectLabel(projectId) {
      if (!projectId) return null;
      const row = document.querySelector(`[${ATTR.projectRow}][${ATTR.projectId}="${css(projectId)}"]`);
      return row?.getAttribute(ATTR.projectLabel)?.trim() || null;
    },
    subscribe(listener) {
      if (disposed || typeof listener !== "function") return () => {};
      listeners.add(listener);
      syncObserver();
      return () => { listeners.delete(listener); syncObserver(); };
    },
    // entries: [{ id, color }]，color 为 COLORS 下标；整体替换上一次的标记。
    setMarks(entries = []) {
      if (disposed) return;
      marks.clear();
      for (const { id, color } of entries) {
        if (THREAD_ID.test(id ?? "") && Number.isInteger(color) && color >= 0 && color < COLORS.length) marks.set(id, color);
      }
      if (marks.size) ensureStyle();
      applyMarks(rows());
      syncObserver();
    },
    async reveal(id, { source, projectId } = {}) {
      if (disposed || !THREAD_ID.test(id ?? "")) return { ok: false, reason: "invalid" };
      // 展开项目会改动侧栏，看板可能随之重绘、替换掉起点节点；先记下起点位置备用。
      const origin = source?.getBoundingClientRect();
      try {
        let row = await locate(id, projectId);
        if (!row || disposed) return { ok: false, reason: "not-found" };
        await scrollIntoView(row);
        // 展开后 React 可能再重绘一次条目，换成当前节点。
        if (!row.isConnected) row = rowFor(id);
        if (!row || disposed) return { ok: false, reason: "detached" };
        const color = COLORS[marks.get(id)];
        const from = source?.isConnected ? source.getBoundingClientRect() : origin;
        if (from && color && !reducedMotion()) await flow(from, row, color);
        if (!row.isConnected || disposed) return { ok: false, reason: "detached" };
        land(row);
        activate(row);
        return { ok: true };
      } catch (error) {
        report(error);
        return { ok: false, reason: "error" };
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (frame) window.cancelAnimationFrame(frame);
      observer?.disconnect();
      observer = null;
      listeners.clear();
      marks.clear();
      for (const row of document.querySelectorAll(`[${MARK}], [${LANDING}]`)) { row.removeAttribute(MARK); row.removeAttribute(LANDING); }
      for (const node of document.querySelectorAll(`.${FLOW_CLASS}`)) node.remove();
      document.getElementById(STYLE_ID)?.remove();
    }
  });
}
