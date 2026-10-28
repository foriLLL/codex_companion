export const CARD_PRESENTATION = Object.freeze({
  proxy: { label: "代理状态", description: "连接与代理，一目了然", tone: "slate", icon: "<path d='M4 8h16M4 16h16'/><rect x='3' y='4' width='18' height='16' rx='4'/><path d='M7 12h.01M11 12h6'/>" },
  games: { label: "摸鱼", description: "2048、扫雷和纸牌，随时接着玩", tone: "amber", icon: "<path d='m8 7-3 1c-2 1-3 10 0 11 2 1 4-3 5-3h4c1 0 3 4 5 3 3-1 2-10 0-11l-3-1H8Z'/><path d='M8 10v5M5.5 12.5h5M16 11h.01M18 14h.01'/>" },
  hongguo: { label: "红果短剧", description: "发现短剧，收藏喜欢的故事", tone: "rose", icon: "<rect x='4' y='3' width='16' height='18' rx='4'/><path d='m10 8 6 4-6 4V8Z'/>" },
  emby: { label: "Emby", description: "你的媒体库，接着上次的故事", tone: "violet", icon: "<rect x='3' y='4' width='18' height='14' rx='3'/><path d='m10 8 5 3-5 3V8ZM8 21h8M12 18v3'/>" }
});

const icons = {
  settings: "<path d='m9 3-.5 2-2 1L4.5 5 2 9l2 1v3l-2 1 2.5 4 2-1 2 1 .5 2h5l.5-2 2-1 2 1 2.5-4-2-1v-3l2-1-2.5-4-2 1-2-1L14 3H9Z'/><circle cx='11.5' cy='11.5' r='3' transform='translate(.5 .5)'/>",
  close: "<path d='m6 6 12 12M6 18 18 6'/>",
  up: "<path d='m6 14 6-6 6 6'/>",
  down: "<path d='m6 10 6 6 6-6'/>",
  check: "<path d='m5 12 4 4L19 6'/>",
  cards: "<rect x='3' y='3' width='7' height='7' rx='2'/><rect x='14' y='3' width='7' height='7' rx='2'/><rect x='3' y='14' width='7' height='7' rx='2'/><rect x='14' y='14' width='7' height='7' rx='2'/>"
};
export const svgIcon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${icons[name] || CARD_PRESENTATION[name]?.icon || icons.cards}</svg>`;

export function createPluginShell({ document: doc = document, mount = doc.body, manifests,
  onSelect = () => {}, onUpdateConfig = async () => {}, onLoadLauncher = async () => {}, onSaveLauncher = async () => {}, onStopLauncher = async () => {} } = {}) {
  const host = doc.createElement("div");
  host.className = "app-shell";
  host.innerHTML = `
    <header class="app-header">
      <a class="brand" href="#" aria-label="Companion 主页"><span class="brand-mark">${svgIcon("cards")}</span><span>Companion<span class="brand-caption">你的休闲小角落</span></span></a>
      <div class="header-actions"><span class="connection" role="status"><i></i><span>正在连接</span></span>
        <button class="icon-button settings-button" type="button" aria-label="管理卡片" title="管理卡片" disabled>${svgIcon("settings")}</button>
      </div>
    </header>
    <aside class="sidebar"><p class="nav-caption">我的空间</p><nav class="card-nav" role="tablist" aria-label="功能卡片"></nav><div class="sidebar-footer"><span class="soft-dot"></span>留一点时间给自己</div></aside>
    <main class="workspace" id="main-content"><div class="page-intro"><div><p class="eyebrow">随时回来，接着喜欢的事</p><h1>欢迎回来</h1><p class="page-description">正在准备你的空间</p></div><span class="page-emblem" aria-hidden="true">${svgIcon("cards")}</span></div>
      <div class="startup" role="status"><span class="spinner"></span><h2>正在准备你的空间</h2><p>马上就好</p><button class="button primary retry-connection" type="button" hidden>重新连接</button></div>
      <div class="card-stack" hidden></div>
      <div class="empty-state" hidden><span class="empty-symbol">${svgIcon("cards")}</span><h2>把喜欢的卡片放在这里</h2><p>选择想用的功能，按自己的习惯排列。</p><button type="button" class="button primary add-cards">管理卡片</button></div>
    </main>
    <div class="toast" role="status" aria-live="polite" hidden></div>
    <dialog class="settings-dialog" aria-labelledby="settings-title"><div class="dialog-head"><div><span class="eyebrow">按你的习惯</span><h2 id="settings-title">管理卡片</h2></div><button type="button" class="icon-button close-settings" aria-label="关闭管理卡片">${svgIcon("close")}</button></div>
      <p class="dialog-description">打开需要的卡片，用箭头调整排列顺序。</p>
      <label class="master-toggle"><span><strong>启用 Companion</strong><small>保留你的设置和进度</small></span><input type="checkbox" role="switch" aria-label="启用 Companion" checked></label>
      <div class="settings-list"></div><p class="settings-status" role="status" aria-live="polite"></p>
      <section class="launcher-settings" aria-labelledby="launcher-title"><h3 id="launcher-title">Codex 启动代理</h3>
        <label class="launcher-toggle"><span>通过本机代理启动</span><input type="checkbox" class="launcher-enabled" role="switch" aria-label="通过本机代理启动 Codex" disabled></label>
        <label class="port-field"><span>代理端口</span><span class="port-input"><span>127.0.0.1 :</span><input class="launcher-port" type="number" min="1" max="65535" step="1" inputmode="numeric" aria-label="代理端口" value="7890" required disabled></span></label>
        <p class="launcher-note">保存启动偏好，点击「保存并重启」以应用代理。重启会关闭当前 Codex 窗口，请先完成手头的工作。</p>
        <div class="launcher-actions"><button type="button" class="button retry-launcher" hidden>重试读取</button><button type="button" class="button save-launcher" disabled>保存</button><button type="button" class="button relaunch-codex" disabled>保存并重启 Codex</button></div>
        <button type="button" class="button exit-codex">退出 Codex</button>
        <p class="launcher-status" role="status" aria-live="polite"></p>
      </section>
      <div class="dialog-footer"><span>设置会自动保存</span><button type="button" class="button done-settings">完成</button></div>
    </dialog>
    <dialog class="confirmation-dialog" aria-labelledby="confirmation-title" aria-describedby="confirmation-message"><span class="confirmation-symbol">${svgIcon("cards")}</span><h2 id="confirmation-title"></h2><p id="confirmation-message"></p><div class="confirmation-actions"><button type="button" class="button cancel-confirmation" autofocus>取消</button><button type="button" class="button primary accept-confirmation">确定</button></div></dialog>`;
  mount.append(host);
  const $ = (selector) => host.querySelector(selector);
  const stack = $(".card-stack");
  const nav = $(".card-nav");
  const dialog = $("dialog");
  const confirmation = $(".confirmation-dialog");
  const slots = new Map();
  const listeners = [];
  const byId = new Map(manifests.map((manifest) => [manifest.id, manifest]));
  let config;
  let active;
  let closed = false;
  let toastTimer;
  let settingsBusy = false;
  let settingsFocus;
  let launcherBusy = false;
  let launcherLoaded = false;
  let launcherLoading;
  let pendingConfirmation;
  function listen(target, name, handler) { target.addEventListener(name, handler); listeners.push(() => target.removeEventListener(name, handler)); }
  function openSettings() {
    if (!dialog.open) dialog.showModal();
    void loadLauncher();
  }
  function renderLauncherControls() {
    if (closed) return;
    for (const element of $(".launcher-settings").querySelectorAll(".launcher-enabled,.launcher-port,.save-launcher,.relaunch-codex")) {
      element.disabled = !launcherLoaded || launcherBusy || Boolean(launcherLoading);
    }
    $(".retry-launcher").disabled = launcherBusy || Boolean(launcherLoading);
    $(".exit-codex").disabled = launcherBusy;
  }
  function loadLauncher() {
    if (closed || launcherLoaded) return Promise.resolve();
    if (launcherLoading) return launcherLoading;
    $(".launcher-status").textContent = "正在读取设置…";
    $(".retry-launcher").hidden = true;
    // 一次读取同时供重复打开和失败重试使用，避免迟到响应覆盖已编辑的设置。
    launcherLoading = Promise.resolve().then(onLoadLauncher).then((result) => {
      if (closed) return;
      const preferences = result?.preferences;
      if (typeof preferences?.launchThroughProxy !== "boolean" || !Number.isInteger(preferences.proxyPort)
        || preferences.proxyPort < 1 || preferences.proxyPort > 65535) throw new Error("启动设置不完整，请重试读取");
      setLauncher(result);
      launcherLoaded = true;
    }).catch((error) => {
      if (closed) return;
      $(".launcher-status").textContent = error?.message || "读取失败，请稍后重试";
      $(".retry-launcher").hidden = false;
    }).finally(() => {
      launcherLoading = undefined;
      renderLauncherControls();
    });
    renderLauncherControls();
    return launcherLoading;
  }
  function setLauncher(result) {
    // 不支持由 Companion 重启 Codex 的系统上，只保留说明，隐藏所有无法生效的操作。
    const unsupported = result.supported === false;
    $(".launcher-settings").dataset.unsupported = String(unsupported);
    for (const element of $(".launcher-settings").querySelectorAll(".launcher-toggle,.port-field,.launcher-actions,.exit-codex")) element.hidden = unsupported;
    $(".launcher-note").textContent = unsupported
      ? "当前系统暂不支持由 Companion 通过代理重启 Codex；请在系统或 Codex 设置中配置网络代理。"
      : "保存启动偏好，点击「保存并重启」以应用代理。重启会关闭当前 Codex 窗口，请先完成手头的工作。";
    $(".launcher-enabled").checked = result.preferences.launchThroughProxy;
    $(".launcher-port").value = result.preferences.proxyPort;
    $(".launcher-status").textContent = result.relaunchPending ? "Codex 正在重新启动…" : "";
  }
  async function saveLauncher(relaunch) {
    if (closed || launcherBusy || !launcherLoaded || launcherLoading) return;
    const port = $(".launcher-port");
    if (!port.reportValidity()) return;
    launcherBusy = true;
    renderLauncherControls();
    $(".launcher-status").textContent = relaunch ? "正在保存并准备重启…" : "正在保存…";
    try {
      await onSaveLauncher({ launchThroughProxy: $(".launcher-enabled").checked, proxyPort: Number(port.value) }, relaunch);
      if (!closed) $(".launcher-status").textContent = relaunch ? "已保存，Codex 即将重新启动" : "已保存，重启后应用";
    } catch (error) {
      if (!closed && error?.code === "CONFIG_CONFLICT") {
        launcherLoaded = false;
        await loadLauncher();
        if (!closed && launcherLoaded) $(".launcher-status").textContent = "启动设置已在其他窗口更新，已载入最新设置，请重新保存";
      } else if (!closed) $(".launcher-status").textContent = error?.message || "保存失败，请重试";
    } finally {
      launcherBusy = false;
      renderLauncherControls();
    }
  }
  listen($(".settings-button"), "click", openSettings);
  listen($(".add-cards"), "click", openSettings);
  listen($(".close-settings"), "click", () => dialog.close());
  listen($(".done-settings"), "click", () => dialog.close());
  listen($(".brand"), "click", (event) => { event.preventDefault(); if (active) onSelect(active); });
  listen(dialog, "click", (event) => { if (event.target === dialog && (event.clientX < dialog.getBoundingClientRect().left || event.clientX > dialog.getBoundingClientRect().right || event.clientY < dialog.getBoundingClientRect().top || event.clientY > dialog.getBoundingClientRect().bottom)) dialog.close(); });
  listen($(".master-toggle input"), "change", (event) => { void update({ enabled: event.target.checked }); });
  listen($(".save-launcher"), "click", () => { void saveLauncher(false); });
  listen($(".relaunch-codex"), "click", () => { void saveLauncher(true); });
  listen($(".retry-launcher"), "click", () => { void loadLauncher(); });
  listen($(".exit-codex"), "click", async () => {
    if (launcherBusy) return;
    const accepted = await confirmAction({ title: "退出 Codex？", message: "将关闭当前 Codex 窗口，未保存的代理设置不会自动保存。", confirmLabel: "退出 Codex", destructive: true });
    if (!accepted || closed) return;
    launcherBusy = true;
    renderLauncherControls();
    try {
      const result = await onStopLauncher();
      if (!closed) $(".launcher-status").textContent = result?.scheduled === false ? "Codex 当前未在运行" : "Codex 即将退出";
    } catch (error) { if (!closed) $(".launcher-status").textContent = error?.message || "退出失败，请重试"; }
    finally {
      launcherBusy = false;
      renderLauncherControls();
    }
  });
  listen($(".accept-confirmation"), "click", () => pendingConfirmation?.(true));
  listen($(".cancel-confirmation"), "click", () => pendingConfirmation?.(false));
  listen(confirmation, "cancel", () => pendingConfirmation?.(false));
  listen(confirmation, "close", () => { if (!confirmation.open) pendingConfirmation?.(false); });
  listen(nav, "click", (event) => { const tab = event.target.closest("[data-card]"); if (tab) onSelect(tab.dataset.card); });
  listen(nav, "keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    const tabs = [...nav.querySelectorAll("button")];
    if (!tabs.length) return;
    event.preventDefault();
    const current = Math.max(0, tabs.indexOf(doc.activeElement));
    const index = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
      : (current + (["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : 1) + tabs.length) % tabs.length;
    onSelect(tabs[index].dataset.card);
    tabs[index].focus();
  });
  async function update(patch) {
    if (settingsBusy) return;
    settingsBusy = true;
    renderSettings();
    $(".settings-status").textContent = "正在保存…";
    try { await onUpdateConfig(patch); $(".settings-status").textContent = "已保存"; }
    catch (error) { $(".settings-status").textContent = error?.message || "保存失败，请重试"; }
    finally { settingsBusy = false; if (!closed) renderSettings(); }
  }
  function renderSettings() {
    if (!config || closed) return;
    $(".master-toggle input").checked = config.enabled;
    $(".master-toggle input").disabled = settingsBusy;
    const list = $(".settings-list");
    // 保存时保留聚焦控件，完成后恢复到同一张卡片，方便连续键盘调整。
    const focusAction = doc.activeElement?.dataset?.action;
    const focusCard = doc.activeElement?.closest("[data-card]")?.dataset.card;
    if (focusCard && focusAction) settingsFocus = { card: focusCard, action: focusAction };
    list.replaceChildren();
    const ordered = config.order.filter((id) => byId.has(id));
    for (const [index, id] of ordered.entries()) {
      const item = doc.createElement("div");
      const info = CARD_PRESENTATION[id] || { label: byId.get(id).title, tone: "slate" };
      item.className = "settings-row";
      item.dataset.card = id;
      item.innerHTML = `<span class="settings-card-icon" data-tone="${info.tone}">${svgIcon(id)}</span><span class="settings-card-label"></span><div class="order-actions"><button type="button" class="icon-button" data-action="up">${svgIcon("up")}</button><button type="button" class="icon-button" data-action="down">${svgIcon("down")}</button></div><input type="checkbox" role="switch" data-action="toggle">`;
      item.querySelector(".settings-card-label").textContent = info.label;
      const up = item.querySelector("[data-action=up]");
      const down = item.querySelector("[data-action=down]");
      up.disabled = settingsBusy || index === 0;
      down.disabled = settingsBusy || index === ordered.length - 1;
      up.setAttribute("aria-label", `上移${info.label}`);
      down.setAttribute("aria-label", `下移${info.label}`);
      const move = (delta) => {
        const order = [...config.order];
        const at = order.indexOf(id);
        const other = order.indexOf(ordered[index + delta]);
        [order[at], order[other]] = [order[other], order[at]];
        void update({ order });
      };
      up.onclick = () => move(-1);
      down.onclick = () => move(1);
      const toggle = item.querySelector("input");
      toggle.checked = config.cards[id].enabled;
      toggle.disabled = settingsBusy;
      toggle.setAttribute("aria-label", `启用${info.label}`);
      toggle.onchange = () => { void update({ cards: { [id]: { enabled: toggle.checked } } }); };
      list.append(item);
    }
    if (!settingsBusy && settingsFocus) {
      const element = list.querySelector(`[data-card="${settingsFocus.card}"] [data-action="${settingsFocus.action}"]`);
      if (element && !element.disabled) element.focus({ preventScroll: true });
      settingsFocus = undefined;
    }
  }
  function confirmAction({ title = "确认操作", message = "", confirmLabel = "确定", destructive = false, signal } = {}) {
    if (closed || signal?.aborted) return Promise.resolve(false);
    if (pendingConfirmation) return Promise.resolve(false);
    $("#confirmation-title").textContent = title;
    $("#confirmation-message").textContent = message;
    $(".accept-confirmation").textContent = confirmLabel;
    $(".accept-confirmation").classList.toggle("danger", destructive);
    return new Promise((resolve) => {
      const finish = (accepted) => {
        if (pendingConfirmation !== finish) return;
        pendingConfirmation = undefined;
        signal?.removeEventListener("abort", aborted);
        if (confirmation.open) confirmation.close();
        resolve(accepted);
      };
      const aborted = () => finish(false);
      pendingConfirmation = finish;
      signal?.addEventListener("abort", aborted, { once: true });
      try { confirmation.showModal(); } catch { finish(false); }
    });
  }
  function setActive(id) {
    active = id;
    const info = CARD_PRESENTATION[id];
    if (info) {
      $("h1").textContent = info.label;
      $(".page-description").textContent = info.description;
      $(".page-emblem").innerHTML = svgIcon(id);
      $(".page-emblem").dataset.tone = info.tone;
    }
    for (const [cardId, slot] of slots) {
      slot.outer.hidden = cardId !== id;
      slot.outer.inert = cardId !== id;
    }
    for (const button of nav.querySelectorAll("[data-card]")) {
      const selected = button.dataset.card === id;
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
    }
    const selected = nav.querySelector(`[data-card="${id}"]`);
    selected?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
  }
  function setConfig(next, selected) {
    config = next;
    const previousFocus = doc.activeElement?.closest(".nav-tab")?.dataset.card;
    nav.replaceChildren();
    const enabled = config.order.filter((id) => byId.has(id) && config.cards[id]?.enabled);
    for (const id of enabled) {
      const info = CARD_PRESENTATION[id] || { label: byId.get(id).title, tone: "slate" };
      const button = doc.createElement("button");
      button.type = "button";
      button.id = `tab-${id}`;
      button.className = "nav-tab";
      button.dataset.card = id;
      button.dataset.tone = info.tone;
      button.setAttribute("role", "tab");
      button.setAttribute("aria-controls", `panel-${id}`);
      button.disabled = !config.enabled;
      button.innerHTML = `<span class="nav-icon">${svgIcon(id)}</span><span></span><span class="active-marker" aria-hidden="true"></span>`;
      button.children[1].textContent = info.label;
      nav.append(button);
    }
    const anyCards = config.enabled && enabled.length > 0;
    stack.hidden = !anyCards;
    $(".empty-state").hidden = anyCards;
    $(".page-intro").hidden = !anyCards;
    if (!anyCards) {
      $(".empty-state h2").textContent = config.enabled ? "把喜欢的卡片放在这里" : "你的空间，随时回来";
      $(".empty-state p").textContent = config.enabled ? "选择想用的功能，按自己的习惯排列。" : "在管理卡片中重新启用，设置和进度都会保留。";
    }
    setActive(selected);
    if (previousFocus) nav.querySelector(`[data-card="${previousFocus}"]`)?.focus({ preventScroll: true });
    renderSettings();
  }
  return {
    host, root: host,
    add(manifest, retry) {
      const outer = doc.createElement("section");
      outer.className = `plugin-card ${manifest.layout.height === "viewport" ? "viewport-card" : "content-card"}`;
      outer.id = `panel-${manifest.id}`;
      outer.dataset.card = manifest.id;
      outer.setAttribute("role", "tabpanel");
      outer.setAttribute("aria-labelledby", `tab-${manifest.id}`);
      outer.tabIndex = 0;
      const content = doc.createElement("div");
      content.className = "card-content";
      const root = content.attachShadow({ mode: "open" });
      const errorBox = doc.createElement("div");
      errorBox.className = "card-error";
      errorBox.hidden = true;
      errorBox.setAttribute("role", "alert");
      const heading = doc.createElement("h2");
      heading.textContent = `${manifest.title} 暂时不可用`;
      const message = doc.createElement("p");
      const button = doc.createElement("button");
      button.type = "button";
      button.className = "button primary";
      button.textContent = "再试一次";
      button.onclick = retry;
      errorBox.append(heading, message, button);
      outer.append(content, errorBox);
      outer.hidden = manifest.id !== active;
      outer.inert = manifest.id !== active;
      stack.append(outer);
      const slot = {
        outer, root,
        showError(error) { content.hidden = true; errorBox.hidden = false; message.textContent = error?.message || "稍后再试，进度仍会保留。"; },
        clearError() { content.hidden = false; errorBox.hidden = true; },
        remove() { button.onclick = null; outer.remove(); slots.delete(manifest.id); }
      };
      slots.set(manifest.id, slot);
      return slot;
    },
    reorder(order) { for (const [index, id] of order.entries()) if (slots.has(id)) slots.get(id).outer.style.order = String(index); },
    get: (id) => slots.get(id),
    diagnostics: () => ({ count: slots.size, ids: [...slots.keys()], active }),
    setConfig, setActive, openSettings,
    confirmAction,
    setConnection(state) {
      $(".connection").dataset.state = state;
      $(".connection span").textContent = state === "ready" ? "已就绪" : state === "error" ? "连接中断" : "正在连接";
    },
    ready() { $(".startup").hidden = true; $(".settings-button").disabled = false; host.classList.add("is-ready"); host.dataset.companionState = "ready"; },
    startupError(error, retry) {
      $(".spinner").hidden = true;
      $(".startup h2").textContent = "暂时没有连接上";
      $(".startup p").textContent = error?.message || "请稍后再试";
      const button = $(".retry-connection");
      button.hidden = false;
      button.onclick = retry;
      this.setConnection("error");
    },
    toast(message) {
      const toast = $(".toast");
      toast.textContent = message;
      toast.hidden = false;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { toast.hidden = true; }, 4500);
    },
    dispose() {
      closed = true;
      pendingConfirmation?.(false);
      clearTimeout(toastTimer);
      for (const unlisten of listeners) unlisten();
      if (dialog.open) dialog.close();
      for (const slot of [...slots.values()]) slot.remove();
      host.remove();
    }
  };
}
