import { completeCardOrder } from "../../platform/config/runtime-config.mjs";

// agent 拒绝重启时返回机器原因码，这里只展示对用户有意义的说明。
const RESTART_REFUSALS = {
  busy: "后台正在处理其他操作，请稍后再试",
  "rate-limited": "操作过于频繁，请稍后再试",
  "not-running": "Codex 未运行",
  "multiple-instances": "检测到多个 Codex 实例",
  "foreign-debug": "当前 Codex 由其他工具以调试模式启动",
  unknown: "无法确认当前 Codex 进程",
  stopped: "后台服务正在停止",
  error: "后台服务出错",
  "native-helper-missing": "缺少原生助手，请手动退出并重新打开 Codex"
};

// 图标沿用 Codex 顶栏的 16px 线框规格，颜色全部继承 currentColor。
const ICONS = {
  close: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 4.5 7 7m0-7-7 7"/></svg>',
  grip: '<svg viewBox="0 0 16 16" aria-hidden="true"><g class="dots"><circle cx="6" cy="4" r="1.05"/><circle cx="10" cy="4" r="1.05"/><circle cx="6" cy="8" r="1.05"/><circle cx="10" cy="8" r="1.05"/><circle cx="6" cy="12" r="1.05"/><circle cx="10" cy="12" r="1.05"/></g></svg>',
  refresh: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.46-3.54M13 3v2.5h-2.5"/></svg>'
};

// 平台设置只读写 RPC；运行时配置仍由 watcher 推送，不能在这里直接改卡片。
export function createSettingsPanel({ document: doc, call, onClose = () => {} }) {
  const element = doc.createElement("section");
  element.className = "cc-settings";
  element.hidden = true;
  element.setAttribute("role", "region");
  element.setAttribute("aria-label", "Companion 设置");
  let config = null;
  let catalog = [];
  let busy = false;
  let destroyed = false;
  let confirming = false;
  // Linux 由应用菜单入口加载卡片，不能自动重开或重启 Codex。
  let menuReopen = false;
  let busyFocus = null;
  const listeners = [];
  const controls = [];
  const rows = new Map();

  function node(tag, text, className) {
    const value = doc.createElement(tag);
    if (text) value.textContent = text;
    if (className) value.className = className;
    return value;
  }
  function listen(target, type, callback) {
    target.addEventListener(type, callback);
    listeners.push(() => target.removeEventListener(type, callback));
  }
  function control(value, disabled = () => false) {
    controls.push({ value, disabled });
    return value;
  }
  function button(text, callback, label, className) {
    const value = node("button", text, className);
    value.type = "button";
    if (label) value.setAttribute("aria-label", label);
    listen(value, "click", callback);
    return value;
  }
  function section(title) {
    const value = node("fieldset");
    const group = node("div", null, "cc-group");
    value.append(node("legend", title), group);
    element.append(value);
    return group;
  }
  // 原生 checkbox 保留键盘与表单语义，外观按 Codex 开关绘制。
  function checkbox(parent, title, key, patch, hint) {
    const label = node("label", null, "cc-settings-row");
    const input = control(node("input"));
    input.type = "checkbox";
    input.className = "cc-switch";
    input.setAttribute("role", "switch");
    input.dataset.setting = key;
    const text = node("span", title);
    if (hint) text.append(node("small", hint));
    label.append(text, input);
    parent.append(label);
    listen(input, "change", () => { void save(patch(input.checked)); });
    return input;
  }

  const style = node("style");
  // 颜色优先取 Codex 设计变量（随宿主明暗切换），缺失时回退到 currentColor 混色。
  style.textContent = `
    .cc-settings { --fg:var(--color-token-text-primary,currentColor);
      --fg2:var(--color-token-text-secondary,color-mix(in srgb,currentColor 65%,transparent));
      --fg3:var(--color-token-text-tertiary,color-mix(in srgb,currentColor 50%,transparent));
      --line:var(--color-token-border,color-mix(in srgb,currentColor 9%,transparent));
      --line2:var(--color-token-border-heavy,color-mix(in srgb,currentColor 14%,transparent));
      --hover:var(--color-token-list-hover-background,color-mix(in srgb,currentColor 6%,transparent));
      --surface:var(--color-token-main-surface-primary,Canvas);
      --accent:var(--switch-track-color-checked,#3a83f7);
      --focus:var(--color-token-focus-border,#3a83f7);
      --ease:var(--cubic-move,cubic-bezier(.65,0,.35,1));
      box-sizing:border-box;min-width:0;width:100%;margin:0 0 12px;padding:14px 14px 12px;
      border:0;border-radius:var(--hg-panel-radius,20px);
      background:var(--cc-card-bg,var(--surface));color:var(--cc-card-fg,var(--fg));
      font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow-wrap:anywhere;
      box-shadow:var(--hg-panel-shadow,var(--elevation-prominent,0 0 0 .5px var(--line2),0 3px 7.5px #0000000a,0 0 20px #0000000d)); }
    .cc-settings *, .cc-settings *::before, .cc-settings *::after { box-sizing:border-box; }
    .cc-settings [hidden], .cc-settings[hidden] { display:none !important; }
    .cc-settings svg { width:16px;height:16px;flex:none;fill:none;stroke:currentColor;stroke-width:1.15;
      stroke-linecap:round;stroke-linejoin:round; }
    .cc-settings svg .dots { fill:currentColor;stroke:none; }
    .cc-settings header { display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 0 2px 2px; }
    .cc-settings h2 { margin:0;font-size:14px;font-weight:600;letter-spacing:-.01em; }
    .cc-settings fieldset { min-width:0;margin:14px 0 0;padding:0;border:0; }
    .cc-settings legend { float:left;width:100%;padding:0 2px;margin:0 0 6px;font-size:12px;font-weight:500;color:var(--fg3); }
    .cc-settings legend + * { clear:both; }
    .cc-group { border:1px solid var(--line);border-radius:12px;background:var(--surface);overflow:hidden; }
    .cc-group > * + *, .cc-list > * + * { border-top:1px solid var(--line); }
    .cc-settings-row { display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:40px;
      padding:8px 12px;min-width:0; }
    .cc-settings-row > span { flex:1;min-width:0; }
    .cc-settings-row small { display:block;margin-top:1px;font-size:12px;color:var(--fg3); }
    .cc-switch { appearance:none;-webkit-appearance:none;position:relative;flex:none;margin:0;cursor:pointer;
      width:var(--switch-track-width,32px);height:var(--switch-track-height,19px);border-radius:999px;
      background:var(--switch-track-color,color-mix(in oklab,currentColor 12%,transparent));
      transition:background-color .175s linear 50ms; }
    .cc-switch::before { content:"";position:absolute;top:3px;left:3px;width:13px;height:13px;border-radius:50%;
      background:var(--switch-thumb-color,#fff);box-shadow:var(--switch-thumb-shadow,0 1px 2px #0003);
      transition:transform .25s var(--ease); }
    .cc-switch:checked { background:var(--accent); }
    .cc-switch:checked::before { transform:translateX(13px); }
    .cc-list[data-off] .cc-settings-card { opacity:.45; }
    .cc-settings-card { position:relative;display:flex;align-items:center;min-width:0;background:var(--surface);
      transition:transform .2s var(--ease),opacity .15s linear; }
    .cc-settings-card .cc-settings-row { flex:1;padding-left:2px; }
    .cc-settings-card[data-dragging] { z-index:1;transition:none;border-radius:10px;
      box-shadow:0 8px 24px rgba(0,0,0,.14),0 0 0 1px var(--line2); }
    .cc-list[data-sorting] .cc-settings-card { border-top-color:transparent; }
    .cc-list[data-settling] .cc-settings-card { transition:none; }
    .cc-list[data-sorting] { user-select:none; }
    .cc-handle { display:flex;align-items:center;justify-content:center;flex:none;width:28px;height:40px;margin-left:4px;
      padding:0;border:0;border-radius:8px;background:transparent;color:var(--fg3);cursor:grab;touch-action:none; }
    .cc-handle:hover:not(:disabled) { color:var(--fg2);background:transparent; }
    .cc-list[data-sorting] .cc-handle { cursor:grabbing; }
    .cc-seg { display:grid;grid-template-columns:1fr 1fr;gap:2px;padding:2px;margin:0;border-radius:10px;
      background:var(--color-background-segmented-form-track,color-mix(in srgb,currentColor 7%,transparent)); }
    .cc-fieldset-seg .cc-group { border:0;background:transparent;border-radius:0; }
    .cc-seg label { position:relative;display:flex;align-items:center;justify-content:center;min-height:28px;
      padding:4px 8px;border-radius:8px;color:var(--fg2);cursor:pointer;transition:background-color .15s,color .15s; }
    .cc-seg label:hover { color:var(--fg); }
    .cc-seg label:has(input:checked) { color:var(--fg);font-weight:500;
      background:var(--color-background-segmented-form-selected,var(--surface));
      box-shadow:var(--shadow-mode-toggle-selected,0 2px 4px -1px #00000014),0 0 0 .5px var(--line); }
    .cc-seg label:has(input:focus-visible) { outline:2px solid var(--focus);outline-offset:1px; }
    .cc-seg input { position:absolute;inset:0;margin:0;opacity:0;cursor:pointer; }
    .cc-settings input[type="text"] { width:72px;height:28px;padding:0 8px;border:1px solid var(--color-token-input-border,var(--line2));
      border-radius:8px;color:inherit;background:transparent;font:inherit;text-align:center;font-variant-numeric:tabular-nums; }
    .cc-settings input[type="text"]:focus { outline:none;border-color:var(--focus);box-shadow:0 0 0 3px color-mix(in srgb,var(--focus) 22%,transparent); }
    .cc-settings input[aria-invalid="true"] { border-color:#e5484d; }
    .cc-settings button { display:inline-flex;align-items:center;justify-content:center;gap:6px;flex:none;height:28px;
      padding:0 10px;border:1px solid var(--line2);border-radius:8px;background:var(--surface);color:inherit;
      font:inherit;font-size:12px;font-weight:500;cursor:pointer;transition:background-color .15s; }
    .cc-settings button:hover:not(:disabled) { background:var(--hover); }
    .cc-settings button.cc-ghost { width:28px;padding:0;border-color:transparent;background:transparent;color:var(--fg3); }
    .cc-settings button.cc-ghost:hover:not(:disabled) { color:var(--fg); }
    .cc-settings button.cc-primary { border-color:transparent;background:var(--fg);color:var(--surface); }
    .cc-settings button.cc-primary:hover:not(:disabled) { background:var(--fg);opacity:.86; }
    .cc-settings button.cc-handle { width:28px;height:40px;padding:0;border:0;background:transparent;color:var(--fg3); }
    .cc-settings button.cc-handle:hover:not(:disabled) { background:transparent;color:var(--fg2); }
    .cc-settings :disabled { opacity:.5;cursor:default; }
    .cc-settings .cc-switch:disabled { opacity:.6; }
    .cc-settings :focus-visible { outline:2px solid var(--focus);outline-offset:2px; }
    .cc-settings p { margin:0;font-size:12px;color:var(--fg2); }
    .cc-settings-inline { display:flex;align-items:center;gap:6px; }
    .cc-settings .cc-settings-note { padding:8px 12px;color:var(--fg3); }
    .cc-settings-actions { display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:6px;padding:8px 12px; }
    .cc-settings-actions p { margin-right:auto; }
    .cc-settings-error { padding:0 12px 8px;color:#e5484d !important; }
    .cc-settings-message { min-height:18px;margin:10px 2px 0 !important;color:var(--fg3) !important; }
    .cc-settings-message[role="alert"] { color:#e5484d !important; }
    .cc-retry { margin:6px 2px 0; }
    .cc-settings-confirm { margin:0 12px 10px;padding:10px 12px;border-radius:10px;
      background:color-mix(in srgb,#f5a623 10%,transparent);border:1px solid color-mix(in srgb,#f5a623 30%,transparent); }
    .cc-settings-confirm p { color:var(--fg); }
    .cc-settings-confirm .cc-settings-actions { padding:8px 0 0; }
    .cc-status { display:flex;align-items:center;gap:8px;padding:8px 8px 8px 12px;min-height:40px; }
    .cc-status p { flex:1;color:var(--fg);font-size:13px; }
    .cc-status p::before { content:"";display:inline-block;width:7px;height:7px;margin:0 8px 1px 0;border-radius:50%;
      background:var(--fg3);vertical-align:middle; }
    .cc-status[data-state="ok"] p::before { background:#30a46c;box-shadow:0 0 0 3px color-mix(in srgb,#30a46c 18%,transparent); }
    .cc-status[data-state="bad"] p::before { background:#e5484d; }
    .cc-settings dl { display:grid;grid-template-columns:auto minmax(0,1fr);gap:6px 12px;margin:0;padding:10px 12px;font-size:12px; }
    .cc-settings dl:empty { display:none; }
    .cc-settings dt { color:var(--fg3); } .cc-settings dd { margin:0;text-align:right;overflow-wrap:anywhere;font-variant-numeric:tabular-nums; }
    @media (prefers-reduced-motion:reduce) { .cc-settings * { transition:none !important; } }
  `;
  const header = node("header");
  const closeButton = button("", close, "关闭 Companion 设置", "cc-ghost");
  closeButton.innerHTML = ICONS.close;
  closeButton.title = "关闭";
  header.append(node("h2", "Companion 设置"), closeButton);
  element.append(style, header);

  const general = section("卡片");
  const enabled = checkbox(general, "启用卡片", "enabled", value => ({ enabled: value }));
  const cardList = node("div", null, "cc-list");
  general.append(cardList);
  const placementSection = section("显示方式");
  placementSection.parentNode.className = "cc-fieldset-seg";
  placementSection.className = "cc-seg";
  const placements = new Map();
  for (const [value, title] of [["standalone-button", "独立按钮"], ["inline-in-summary", "摘要下方"]]) {
    const label = node("label");
    const input = control(node("input"));
    input.type = "radio";
    input.name = "companion-placement";
    input.value = value;
    input.dataset.setting = "placement";
    label.append(input, node("span", title));
    placementSection.append(label);
    placements.set(value, input);
    listen(input, "change", () => { if (input.checked) void save({ placement: value }); });
  }
  const proxySection = section("启动");
  const proxyEnabled = checkbox(proxySection, "通过代理启动", "proxy-enabled", value => ({ launch: { proxy: { enabled: value } } }));
  const portForm = node("form", null, "cc-settings-row");
  const portLabel = node("label", null, "cc-settings-inline");
  const portInput = control(node("input"));
  // 文本输入保留原始内容，避免 number 输入把小数/指数悄悄规范化为合法端口。
  portInput.type = "text";
  portInput.inputMode = "numeric";
  portInput.dataset.setting = "proxy-port";
  portInput.setAttribute("aria-describedby", "companion-port-error");
  portLabel.append(portInput);
  const savePort = control(node("button", "保存端口"));
  savePort.type = "submit";
  portForm.append(node("span", "代理端口"), portLabel, savePort);
  const portError = node("p", null, "cc-settings-error");
  portError.id = "companion-port-error";
  portError.setAttribute("role", "alert");
  portError.hidden = true;
  listen(portInput, "input", () => {
    portError.hidden = true;
    portInput.removeAttribute("aria-invalid");
  });
  listen(portForm, "submit", event => {
    event.preventDefault();
    if (busy || !config || destroyed) return;
    const raw = portInput.value.trim();
    const port = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isInteger(port) || port < 1 || port > 65535) {
      portError.textContent = "端口须为 1–65535 的整数";
      portError.hidden = false;
      portInput.setAttribute("aria-invalid", "true");
      portInput.focus();
      return;
    }
    void save({ launch: { proxy: { port } } });
  });
  const restartButton = control(button("立即重启 Codex", () => {
    if (busy || !config || destroyed) return;
    if (menuReopen) {
      showMessage("请退出 ChatGPT 后从应用菜单重新打开，新的代理设置即可生效");
      return;
    }
    confirming = true;
    confirmation.hidden = false;
    cancelRestart.focus();
  }));
  const confirmation = node("div", null, "cc-settings-confirm");
  confirmation.hidden = true;
  confirmation.setAttribute("role", "group");
  confirmation.setAttribute("aria-label", "确认重启 Codex");
  const confirmRestart = control(button("确认重启", () => { void restart(); }, null, "cc-primary"));
  const cancelRestart = control(button("取消", cancelConfirmation));
  const restartActions = node("div", null, "cc-settings-actions");
  restartActions.append(cancelRestart, confirmRestart);
  confirmation.append(node("p", "将正常退出并重新打开 Codex，未保存的输入可能丢失"), restartActions);
  const restartRow = node("div", null, "cc-settings-actions");
  restartRow.append(node("p", "修改代理后需重启 Codex 生效"), restartButton);
  proxySection.append(portForm, portError, restartRow, confirmation);
  const autoSection = section("自动加载");
  const autoRelaunch = checkbox(autoSection, "打开 Codex 时自动加载", "auto-relaunch", value => ({ agent: { autoRelaunch: value } }),
    "刚打开的 Codex 会自动重开一次以加载卡片");
  const statusSection = section("状态");
  const statusRow = node("div", null, "cc-status");
  const statusText = node("p");
  const statusDetails = node("dl");
  const refresh = control(button("", () => { void refreshStatus(); }, "刷新状态", "cc-ghost"));
  refresh.innerHTML = ICONS.refresh;
  refresh.title = "刷新状态";
  statusRow.append(statusText, refresh);
  statusSection.append(statusRow, statusDetails);
  const message = node("p", null, "cc-settings-message");
  message.setAttribute("role", "status");
  message.setAttribute("aria-live", "polite");
  const retry = button("重试", () => { void load(); }, null, "cc-retry");
  retry.hidden = true;
  element.append(message, retry);

  function showMessage(text = "", error = false) {
    message.textContent = text;
    message.setAttribute("role", error ? "alert" : "status");
    retry.hidden = !error;
  }
  function setBusy(value) {
    if (value && !busy) {
      const focused = element.getRootNode().activeElement;
      busyFocus = element.contains(focused) ? focused : null;
    }
    busy = value;
    element.setAttribute("aria-busy", String(value));
    for (const item of controls) item.value.disabled = value || !config || item.disabled();
    retry.disabled = value;
    if (!value) {
      const focused = element.getRootNode().activeElement;
      // 禁用原生输入会让浏览器失焦；仅当用户未移到其他控件时恢复。
      if (!element.hidden && busyFocus?.isConnected && (!focused || focused === doc.body || focused === busyFocus)) {
        busyFocus.focus({ preventScroll: true });
      }
      busyFocus = null;
    }
  }
  function knownOrder() {
    return completeCardOrder(config.order, catalog, Object.keys(config.cards ?? {}));
  }
  // 只重排可见卡片，未知卡片保留原槽位，避免旧版本配置被打乱。
  function moveCardTo(id, target) {
    if (busy || !config || destroyed) return;
    const order = knownOrder();
    const visible = order.filter(key => rows.has(key));
    const from = visible.indexOf(id);
    if (from < 0 || target < 0 || target >= visible.length || target === from) return;
    visible.splice(from, 1);
    visible.splice(target, 0, id);
    let next = 0;
    void save({ order: order.map(key => rows.has(key) ? visible[next++] : key) });
  }
  let drag = null;
  function endDrag(commit) {
    if (!drag) return;
    const { id, row, list, rects, from, dy } = drag;
    const target = commit ? drag.target : from;
    drag = null;
    // 先无动画地落到新 DOM 位置，再让被拖行从松手处滑入槽位，避免等待保存时闪回原位。
    cardList.setAttribute("data-settling", "");
    if (target !== from) cardList.insertBefore(row.element, list[target + (target > from ? 1 : 0)]?.element ?? null);
    for (const item of list) item.element.style.transform = "";
    row.element.removeAttribute("data-dragging");
    cardList.removeAttribute("data-sorting");
    const residual = rects[from].top + dy - row.element.getBoundingClientRect().top;
    row.element.style.transform = `translateY(${residual}px)`;
    void row.element.offsetHeight;
    cardList.removeAttribute("data-settling");
    row.element.style.transform = "";
    if (target !== from) moveCardTo(id, target);
  }
  // 指针拖动只做视觉位移；松手后一次性保存，失败时由 renderConfig 还原顺序。
  function startDrag(id, event) {
    if (busy || !config || destroyed || drag || event.button !== 0) return;
    const row = rows.get(id);
    const list = [...rows.values()].sort((a, b) => a.index - b.index);
    const rects = list.map(item => item.element.getBoundingClientRect());
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag = { id, row, list, rects, from: row.index, target: row.index, startY: event.clientY, dy: 0 };
    row.element.setAttribute("data-dragging", "");
    cardList.setAttribute("data-sorting", "");
  }
  function moveDrag(event) {
    if (!drag) return;
    const { row, list, rects, from } = drag;
    const top = rects[0].top, bottom = rects.at(-1).bottom, own = rects[from];
    const dy = Math.max(top - own.top, Math.min(bottom - own.bottom, event.clientY - drag.startY));
    const center = own.top + own.height / 2 + dy;
    let target = from;
    while (target < list.length - 1 && center > rects[target + 1].top + rects[target + 1].height / 2) target++;
    while (target > 0 && center < rects[target - 1].top + rects[target - 1].height / 2) target--;
    drag.target = target;
    drag.dy = dy;
    row.element.style.transform = `translateY(${dy}px)`;
    for (const [index, item] of list.entries()) {
      if (item === row) continue;
      const shift = index > from && index <= target ? -own.height : index < from && index >= target ? own.height : 0;
      item.element.style.transform = shift ? `translateY(${shift}px)` : "";
    }
  }
  function renderConfig(resetPort = true) {
    enabled.checked = config.enabled;
    if (config.enabled) cardList.removeAttribute("data-off");
    else cardList.setAttribute("data-off", "");
    for (const [value, input] of placements) input.checked = value === config.placement;
    proxyEnabled.checked = config.launch?.proxy?.enabled ?? false;
    autoRelaunch.checked = config.agent?.autoRelaunch ?? true;
    if (resetPort) {
      portInput.value = String(config.launch?.proxy?.port ?? 7890);
      portError.hidden = true;
      portInput.removeAttribute("aria-invalid");
    }
    // 更新复用行节点，避免每次保存后丢失键盘焦点；catalog 标题只作为文本插入。
    endDrag(false);
    for (const [id, row] of rows) {
      if (catalog.some(card => card.id === id)) continue;
      row.element.remove();
      rows.delete(id);
      for (const input of row.controls) controls.splice(controls.findIndex(item => item.value === input), 1);
    }
    const order = knownOrder().filter(id => catalog.some(card => card.id === id));
    for (const [index, id] of order.entries()) {
      const card = catalog.find(item => item.id === id);
      let row = rows.get(id);
      if (!row) {
        const outer = node("div", null, "cc-settings-card");
        outer.dataset.cardSetting = id;
        const handle = control(button("", () => {}, null, "cc-handle"));
        handle.innerHTML = ICONS.grip;
        handle.title = "拖动调整顺序（也可用 ↑ ↓ 键）";
        listen(handle, "pointerdown", event => startDrag(id, event));
        listen(handle, "pointermove", moveDrag);
        listen(handle, "pointerup", () => endDrag(true));
        listen(handle, "pointercancel", () => endDrag(false));
        listen(handle, "keydown", event => {
          const delta = { ArrowUp: -1, ArrowDown: 1 }[event.key];
          if (!delta) return;
          event.preventDefault();
          moveCardTo(id, rows.get(id).index + delta);
        });
        outer.append(handle);
        const input = checkbox(outer, card.title, `card-${id}`, value => ({ cards: { [id]: { enabled: value } } }));
        row = { element: outer, input, handle, title: input.parentNode.children[0], controls: [handle, input] };
        rows.set(id, row);
      }
      row.index = index;
      row.input.checked = config.cards?.[id]?.enabled ?? card.defaultEnabled;
      row.title.textContent = card.title;
      row.handle.setAttribute("aria-label", `调整 ${card.title} 的顺序`);
      if (cardList.children[index] !== row.element) {
        const focused = element.getRootNode().activeElement;
        cardList.insertBefore(row.element, cardList.children[index] ?? null);
        if (!element.hidden && row.element.contains(focused)) focused.focus({ preventScroll: true });
      }
    }
  }
  function renderStatus(agent) {
    statusDetails.replaceChildren();
    menuReopen = agent?.reopen === "menu";
    autoSection.parentElement.hidden = menuReopen;
    if (agent?.available !== true) {
      statusText.textContent = "后台服务未运行";
      statusRow.dataset.state = "bad";
      return;
    }
    statusText.textContent = "后台服务运行中";
    statusRow.dataset.state = "ok";
    const codex = agent.codex ?? {};
    const details = [
      ["版本", agent.version],
      ["Codex", codex.attached ? "已连接" : codex.running ? "等待连接" : "未运行"],
      ["调试端口", codex.port],
      ["代理端口", codex.proxyPort],
      ["原生助手", menuReopen ? null : agent.nativeHelper === "ok" ? "正常" : "缺失"],
      ["最近事件", agent.lastEvent ? `${agent.lastEvent.event} · ${new Date(agent.lastEvent.at).toLocaleTimeString()}` : "无"]
    ];
    for (const [label, value] of details) {
      if (value === null || value === undefined) continue;
      statusDetails.append(node("dt", label), node("dd", String(value)));
    }
  }
  function acceptConfig(value) {
    if (!Number.isSafeInteger(value?.revision) || value.revision < 0) throw new Error("设置响应缺少有效版本，请重试");
    config = value;
  }
  function errorMessage(error) {
    if (error?.code === "BRIDGE_UNAVAILABLE") return "后台连接不可用，请重试";
    if (["RPC_TIMEOUT", "TIMEOUT"].includes(error?.code)) return "请求超时，请重试";
    return error?.message || "请求失败，请重试";
  }
  async function readSettings(notice = "") {
    const [settings, status] = await Promise.allSettled([
      call("companion.settings.get", {}), call("companion.agent.status", {})
    ]);
    if (destroyed) return;
    if (settings.status === "fulfilled") {
      acceptConfig(settings.value.config);
      catalog = settings.value.catalog;
      renderConfig();
    } else config = null;
    if (status.status === "fulfilled") renderStatus(status.value);
    else { statusText.textContent = "状态读取失败"; statusRow.dataset.state = "bad"; statusDetails.replaceChildren(); }
    if (settings.status === "rejected") throw settings.reason;
    if (status.status === "rejected") {
      showMessage([notice, errorMessage(status.reason)].filter(Boolean).join("；"), true);
      return;
    }
    showMessage(notice);
  }
  async function load() {
    if (busy || destroyed) return;
    setBusy(true);
    showMessage("正在读取…");
    try { await readSettings(); }
    catch (error) { if (!destroyed) showMessage(errorMessage(error), true); }
    finally { if (!destroyed) setBusy(false); }
  }
  async function refreshStatus() {
    if (busy || destroyed) return;
    setBusy(true);
    showMessage("正在读取…");
    try {
      const status = await call("companion.agent.status", {});
      if (!destroyed) { renderStatus(status); showMessage(); }
    } catch (error) {
      if (!destroyed) {
        statusText.textContent = "状态读取失败";
        statusRow.dataset.state = "bad";
        statusDetails.replaceChildren();
        showMessage(errorMessage(error), true);
      }
    } finally { if (!destroyed) setBusy(false); }
  }
  async function save(patch) {
    if (busy || !config || destroyed) return;
    setBusy(true);
    showMessage("正在保存…");
    try {
      const result = await call("companion.settings.patch", { expectedRevision: config.revision, patch });
      if (destroyed) return;
      acceptConfig(result.config);
      renderConfig(patch.launch?.proxy?.port !== undefined);
      showMessage("已保存");
    } catch (error) {
      if (destroyed) return;
      if (error?.code === "CONFIG_CONFLICT") {
        config = null;
        try { await readSettings("配置已在别处修改，已刷新"); }
        catch (refreshError) { if (!destroyed) showMessage(errorMessage(refreshError), true); }
      } else {
        renderConfig(false);
        // 超时可能已写成功；重试先读取，不重放修改。
        config = null;
        showMessage(errorMessage(error), true);
      }
    } finally { if (!destroyed) setBusy(false); }
  }
  function cancelConfirmation() {
    confirming = false;
    confirmation.hidden = true;
    if (!element.hidden && !destroyed) restartButton.focus();
  }
  async function restart() {
    if (!confirming || busy || !config || destroyed) return;
    setBusy(true);
    showMessage("正在请求重启…");
    try {
      const result = await call("companion.codex.restart", { reason: "settings" });
      if (destroyed) return;
      if (!result.accepted) throw new Error(`无法重启 Codex：${RESTART_REFUSALS[result.reason] ?? "请求未接受"}`);
      showMessage("已请求重启 Codex");
    } catch (error) { if (!destroyed) showMessage(errorMessage(error), true); }
    finally {
      if (!destroyed) {
        setBusy(false);
        cancelConfirmation();
      }
    }
  }
  function close() {
    if (destroyed || element.hidden) return;
    element.hidden = true;
    confirming = false;
    confirmation.hidden = true;
    onClose();
  }
  listen(element, "keydown", event => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    if (drag) endDrag(false);
    else if (confirming && !busy) cancelConfirmation();
    else close();
  });
  setBusy(false);
  return {
    element,
    open() {
      if (destroyed || !element.hidden) return;
      element.hidden = false;
      closeButton.focus({ preventScroll: true });
      return load();
    },
    close,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const cleanup of listeners) cleanup();
      element.remove();
    }
  };
}
