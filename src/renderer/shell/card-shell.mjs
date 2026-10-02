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
      border:1px solid var(--cc-card-border,rgba(128,128,128,.22));border-radius:24px;
      background:var(--cc-card-bg,Canvas);color:var(--cc-card-fg,CanvasText);
      box-shadow:0 3px 18px rgba(0,0,0,.06);overflow:clip;contain:layout style; }
    .slot[hidden] { display:none; }
    .content { display:block;min-width:0; }
    .error { padding:28px 18px;min-height:160px;box-sizing:border-box; }
    .error[hidden],.content[hidden] { display:none; }
    .error p { font-size:13px;line-height:1.6;overflow-wrap:anywhere; }
    .error button { font:inherit;cursor:pointer;padding:8px 14px;border:0;border-radius:10px; }
  `;
  const stack = doc.createElement("div");
  stack.className = "stack";
  root.append(style, stack);
  const slots = new Map();

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
    get: (id) => slots.get(id),
    diagnostics: () => ({ count: slots.size, ids: [...slots.keys()] }),
    dispose() { for (const slot of [...slots.values()]) slot.remove(); host.remove(); }
  };
}
