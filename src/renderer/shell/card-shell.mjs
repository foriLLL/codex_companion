import { createSettingsPanel } from "./settings-panel.mjs";

// 外框属于平台；业务只能在内层 ShadowRoot 内渲染。
export function createCardShell({ document: doc = document, hostId = "codex-companion-root" } = {}) {
  const host = doc.createElement("div");
  host.id = hostId;
  host.setAttribute("aria-label", "播放器卡片");
  host.style.cssText = "display:block;width:100%;min-width:0;flex:none;color-scheme:light dark;pointer-events:auto";
  const root = host.attachShadow({ mode: "open" });
  const style = doc.createElement("style");
  style.textContent = `
    :host { font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    .stack { display:flex;flex-direction:column;gap:24px;min-width:0;reading-flow:flex-visual; }
    .slot { display:block;flex:none;min-width:0;width:100%;box-sizing:border-box;
      border:0;border-radius:var(--hg-panel-radius,20px);
      background:var(--cc-card-bg,Canvas);color:var(--cc-card-fg,CanvasText);
      box-shadow:var(--hg-panel-shadow,var(--elevation-prominent,0 0 0 .5px rgba(26,28,31,.117),0 3px 7.5px #0000000a,0 0 20px #0000000d));
      overflow:clip;contain:layout style; }
    .slot[hidden] { display:none; }
    .content { display:block;min-width:0; }
    .error { padding:28px 18px;min-height:160px;box-sizing:border-box; }
    .error[hidden],.content[hidden] { display:none; }
    .error p { font-size:13px;line-height:1.6;overflow-wrap:anywhere; }
    .error button { font:inherit;cursor:pointer;padding:8px 14px;border:0;border-radius:10px; }
    .platform-bar { display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-bottom:8px;
      min-width:0;color:var(--cc-card-fg,CanvasText); }
    .platform-bar[hidden], .platform-bar [hidden] { display:none; }
    .platform-bar p { margin:0 auto 0 0;font-size:12px;opacity:.7; }
    .settings-entry { display:flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;
      border:0;border-radius:12.5px;cursor:pointer;background:transparent;
      color:var(--color-token-text-tertiary,color-mix(in srgb,currentColor 50%,transparent));transition:background-color .15s,color .15s; }
    .settings-entry:hover, .settings-entry[aria-expanded="true"] {
      background:var(--color-token-list-hover-background,color-mix(in srgb,currentColor 7%,transparent));
      color:var(--color-token-text-primary,currentColor); }
    .settings-entry:focus-visible { outline:2px solid var(--color-token-focus-border,#3a83f7);outline-offset:2px; }
    .settings-entry svg { width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.1;stroke-linecap:round; }
  `;
  const platformBar = doc.createElement("div");
  platformBar.className = "platform-bar";
  platformBar.hidden = true;
  const empty = doc.createElement("p");
  empty.hidden = true;
  const settingsButton = doc.createElement("button");
  settingsButton.className = "settings-entry";
  settingsButton.type = "button";
  settingsButton.setAttribute("aria-label", "Companion 设置");
  settingsButton.setAttribute("aria-expanded", "false");
  settingsButton.setAttribute("aria-controls", "companion-settings");
  settingsButton.title = "Companion 设置";
  settingsButton.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 5h5.25m3.5 0h2.25M2.5 11h2.25m3.5 0h5.25"/><circle cx="9.5" cy="5" r="1.75"/><circle cx="6.5" cy="11" r="1.75"/></svg>';
  platformBar.append(empty, settingsButton);
  const stack = doc.createElement("div");
  stack.className = "stack";
  root.append(style, platformBar, stack);
  const slots = new Map();
  let settings;
  const toggleSettings = () => {
    if (!settings) return;
    if (!settings.element.hidden) settings.close();
    else {
      settingsButton.setAttribute("aria-expanded", "true");
      void settings.open();
    }
  };
  settingsButton.addEventListener("click", toggleSettings);

  function add(manifest, retry) {
    const outer = doc.createElement("section");
    outer.className = "slot";
    outer.dataset.card = manifest.id;
    outer.setAttribute("aria-label", manifest.title);
    const content = doc.createElement("div");
    content.className = "content";
    content.style.minHeight = `${manifest.layout.minHeight}px`;
    content.style.overflowY = manifest.layout.scroll === "inner" ? "auto" : "visible";
    if (manifest.layout.height === "viewport") {
      content.style.height = "var(--cc-card-height, min(640px, 70vh))";
    }
    const cardRoot = content.attachShadow({ mode: "open" });
    const errorBox = doc.createElement("div");
    errorBox.className = "error";
    errorBox.hidden = true;
    errorBox.setAttribute("role", "alert");
    const title = doc.createElement("strong");
    title.textContent = `${manifest.title} 暂时不可用`;
    const message = doc.createElement("p");
    const button = doc.createElement("button");
    button.type = "button";
    button.textContent = "重试";
    button.addEventListener("click", retry);
    errorBox.append(title, message, button);
    outer.append(content, errorBox);
    stack.append(outer);
    const slot = {
      outer, root: cardRoot,
      showError(error) {
        content.hidden = true;
        errorBox.hidden = false;
        message.textContent = error?.message || "卡片加载失败，请重试";
      },
      clearError() { content.hidden = false; errorBox.hidden = true; },
      remove() { button.removeEventListener("click", retry); outer.remove(); slots.delete(manifest.id); }
    };
    slots.set(manifest.id, slot);
    return slot;
  }

  function reorder(order) {
    // moveBefore 在保留 iframe/视频状态的同时同步辅助技术阅读顺序。
    // 旧 Chromium 使用视觉顺序兜底，不采用会重置 iframe 的 appendChild。
    let anchor = null;
    for (let index = order.length - 1; index >= 0; index--) {
      const slot = slots.get(order[index]);
      if (!slot) continue;
      slot.outer.style.order = String(index);
      if (typeof stack.moveBefore === "function" && slot.outer.nextSibling !== anchor) {
        try { stack.moveBefore(slot.outer, anchor); } catch { /* 断开状态采用 CSS 顺序。 */ }
      }
      anchor = slot.outer;
    }
  }

  return {
    host, root, add, reorder,
    configureSettings({ call }) {
      if (settings) return;
      settings = createSettingsPanel({ document: doc, call, onClose() {
        settingsButton.setAttribute("aria-expanded", "false");
        settingsButton.focus({ preventScroll: true });
      } });
      settings.element.id = "companion-settings";
      root.insertBefore(settings.element, stack);
      platformBar.hidden = false;
    },
    setEmptyState({ enabled, count }) {
      empty.hidden = count > 0;
      empty.textContent = enabled ? "暂无启用的卡片" : "卡片已关闭";
    },
    isSettingsOpen: () => Boolean(settings && !settings.element.hidden),
    get: (id) => slots.get(id),
    diagnostics: () => ({ count: slots.size, ids: [...slots.keys()] }),
    dispose() {
      settingsButton.removeEventListener("click", toggleSettings);
      settings?.destroy();
      for (const slot of [...slots.values()]) slot.remove();
      host.remove();
    }
  };
}
