/**
 * Codex 原生布局适配器。只拥有挂载轨道、入口和原生布局补偿，不拥有卡片生命周期。
 * DOM 发现逻辑提取自 injection.mjs；Shell 提供稳定的 host 和内部 ShadowRoot。
 */
export function createCodexAdapter({ host, placement = "standalone-button", onVisibilityChange, onError, hasCards = true } = {}) {
  if (!host?.shadowRoot) throw new TypeError("Codex adapter requires a host with an open ShadowRoot");
  const document = host.ownerDocument;
  const window = document.defaultView;
  const { MutationObserver, ResizeObserver, HTMLButtonElement, DOMMatrixReadOnly } = window;
  const getComputedStyle = window.getComputedStyle.bind(window);
  const matchMedia = window.matchMedia.bind(window);
  const hostId = "codex-companion-root";
  const railId = "codex-companion-rail";
  const hostStyles = new Map();
  const nativeAttributes = new Map();
  const markNative = (node, name, value) => {
    let originals = nativeAttributes.get(node);
    if (!originals) nativeAttributes.set(node, originals = new Map());
    if (!originals.has(name)) originals.set(name, node.getAttribute(name));
    node.setAttribute(name, value);
  };
  const restoreNativeAttribute = (node, name) => {
    const originals = nativeAttributes.get(node);
    if (!originals?.has(name)) return;
    const value = originals.get(name);
    if (value === null) node.removeAttribute(name);
    else node.setAttribute(name, value);
    originals.delete(name);
    if (!originals.size) nativeAttributes.delete(node);
  };
  let moveFallbacks = 0;
  let fallbackActive = false;
  let lastVisibility = null;
  const reportError = (error) => { try { onError?.(error); } catch {} };
  const notifyVisibility = (visible, reason) => {
    if (lastVisibility?.visible === visible && lastVisibility?.placement === placement) return;
    lastVisibility = { visible, reason, placement };
    try { onVisibilityChange?.({ ...lastVisibility }); } catch (error) { reportError(error); }
  };
  const validatePlacement = (value) => {
    if (!["standalone-button", "inline-in-summary"].includes(value)) throw new TypeError(`Unknown placement: ${value}`);
    return value;
  };
  validatePlacement(placement);
  let disposed = false;
  let placementMode = "pending";
  let placementQueued = false;
  let managedPopoverPanel = null;
  let managedPopoverPanelHeight = 0;
  let managedPopoverPanelStyles = null;
  let managedAnimationColumn = null;
  let managedAnimationColumnPosition = null;
  let managedScrollRoot = null;
  let managedScrollRootStyles = null;
  let managedScrollRootTop = 0;

  const popoverPanelStyleProperties = ["height", "flex-basis", "flex-shrink"];
  const scrollRootStyleProperties = [
    "width", "min-width", "max-width", "height", "min-height", "max-height",
    "margin-left", "padding-left", "box-sizing", "overflow-x", "overflow-y",
    "overscroll-behavior", "pointer-events"
  ];

  const restorePopoverPanel = () => {
    if (managedPopoverPanel && managedPopoverPanelStyles) {
      for (const { property, value, priority } of managedPopoverPanelStyles) {
        if (value) managedPopoverPanel.style.setProperty(property, value, priority);
        else managedPopoverPanel.style.removeProperty(property);
      }
    }
    managedPopoverPanel = null;
    managedPopoverPanelHeight = 0;
    managedPopoverPanelStyles = null;
  };

  const preservePopoverPanel = (nativePanel) => {
    if (nativePanel === managedPopoverPanel) return managedPopoverPanelHeight;
    restorePopoverPanel();
    const height = Math.max(1, Math.round(nativePanel.getBoundingClientRect().height));
    managedPopoverPanel = nativePanel;
    managedPopoverPanelHeight = height;
    managedPopoverPanelStyles = popoverPanelStyleProperties.map((property) => ({
      property,
      value: nativePanel.style.getPropertyValue(property),
      priority: nativePanel.style.getPropertyPriority(property)
    }));
    nativePanel.style.setProperty("height", `${height}px`, "important");
    nativePanel.style.setProperty("flex-basis", `${height}px`, "important");
    nativePanel.style.setProperty("flex-shrink", "0", "important");
    return height;
  };

  const restoreAnimationColumn = () => {
    if (managedAnimationColumn && managedAnimationColumnPosition) {
      const { value, priority } = managedAnimationColumnPosition;
      if (value) managedAnimationColumn.style.setProperty("position", value, priority);
      else managedAnimationColumn.style.removeProperty("position");
      restoreNativeAttribute(managedAnimationColumn, "data-codex-companion-animation-column");
    }
    managedAnimationColumn = null;
    managedAnimationColumnPosition = null;
  };

  const configureAnimationColumn = (column) => {
    if (managedAnimationColumn !== column) {
      restoreAnimationColumn();
      managedAnimationColumn = column;
      managedAnimationColumnPosition = {
        value: column.style.getPropertyValue("position"),
        priority: column.style.getPropertyPriority("position")
      };
    }
    markNative(column, "data-codex-companion-animation-column", "true");
    // transform 动画本身也会建立 containing block。显式固定 position 后，
    // 动画结束移除 transform 时 rail 不会改用外层 containing block 而横跳 16px。
    column.style.setProperty("position", "relative", "important");
  };

  const restoreOuterScroller = () => {
    if (managedScrollRoot && managedScrollRootStyles) {
      for (const { property, value, priority } of managedScrollRootStyles) {
        if (value) managedScrollRoot.style.setProperty(property, value, priority);
        else managedScrollRoot.style.removeProperty(property);
      }
      managedScrollRoot.scrollTop = managedScrollRootTop;
      restoreNativeAttribute(managedScrollRoot, "data-codex-companion-scroll-root");
    }
    managedScrollRoot = null;
    managedScrollRootStyles = null;
    managedScrollRootTop = 0;
  };

  const configureOuterScroller = (summary) => {
    const scrollRoot = summary.mode === "animated-summary"
      ? summary.mountParent.parentElement
      : summary.mountParent;
    if (!scrollRoot) return null;
    if (managedScrollRoot !== scrollRoot) {
      restoreOuterScroller();
      managedScrollRoot = scrollRoot;
      managedScrollRootTop = scrollRoot.scrollTop;
      managedScrollRootStyles = scrollRootStyleProperties.map((property) => ({
        property,
        value: scrollRoot.style.getPropertyValue(property),
        priority: scrollRoot.style.getPropertyPriority(property)
      }));
    }
    markNative(scrollRoot, "data-codex-companion-scroll-root", summary.mode);
    scrollRoot.style.setProperty("width", "332px", "important");
    scrollRoot.style.setProperty("min-width", "332px", "important");
    scrollRoot.style.setProperty("max-width", "332px", "important");
    scrollRoot.style.setProperty("margin-left", "-16px", "important");
    scrollRoot.style.setProperty("padding-left", "16px", "important");
    scrollRoot.style.setProperty("box-sizing", "border-box", "important");
    scrollRoot.style.setProperty("overflow-x", "hidden", "important");
    scrollRoot.style.setProperty("overflow-y", "auto", "important");
    scrollRoot.style.setProperty("overscroll-behavior", "contain", "important");
    scrollRoot.style.setProperty("pointer-events", "auto", "important");
    if (summary.mode === "animated-summary") {
      const bounds = summary.floatingRoot.getBoundingClientRect();
      const availableHeight = Math.min(bounds.bottom, window.innerHeight) - Math.max(0, bounds.top);
      scrollRoot.style.setProperty("height", `${Math.max(1, Math.floor(availableHeight))}px`, "important");
      scrollRoot.style.setProperty("min-height", "0", "important");
      scrollRoot.style.setProperty("max-height", "none", "important");
    }
    return scrollRoot;
  };

  // 定位原生 summary 触发按钮。不再单靠英文 aria-label 字面量（界面切换语言会失效），
  // 而是多信号打分：多语言文案 + aria-controls 指向 dialog + 右上角工具栏内的图标按钮。
  // kind: "popover"（Side Panel 态，带 aria-controls→dialog）| "pinned"（浮层态，用 aria-pressed）。
  const SUMMARY_LABEL_HINTS = [
    "summary",          // en
    "摘要", "总结",      // zh-Hans
    "摘要面板",
    "サマリー", "要約",  // ja
    "요약",             // ko
    "resumen",          // es
    "résumé", "resume", // fr
    "zusammenfassung"   // de
  ];
  const labelText = (element) =>
    `${element.getAttribute("aria-label") || ""} ${element.getAttribute("title") || ""}`.toLowerCase();
  const matchesSummaryLabel = (element) => {
    const label = labelText(element);
    return SUMMARY_LABEL_HINTS.some((hint) => label.includes(hint));
  };
  const isPinnedLabel = (element) => labelText(element).includes("pinned")
    || labelText(element).includes("固定");

  const findSummaryToggle = (kind) => {
    const buttons = Array.from(document.querySelectorAll("button"));
    let best = null;
    let bestScore = 0;
    for (const button of buttons) {
      const controlledId = button.getAttribute("aria-controls");
      const controlled = controlledId ? document.getElementById(controlledId) : null;
      const controlsDialog = controlled?.getAttribute("role") === "dialog";
      const labelMatch = matchesSummaryLabel(button);
      // 位于顶部工具栏、只含一个 svg 的图标按钮（结构信号，语言无关）。
      const inHeader = !!button.closest("header");
      const iconOnly = button.querySelector("svg") && button.textContent.trim() === "";

      let score = 0;
      if (labelMatch) score += 4;
      if (kind === "popover" && controlsDialog) score += 4;
      if (inHeader) score += 1;
      if (iconOnly) score += 1;
      // pinned 态用 aria-pressed 反映开合；popover 态用 aria-controls。
      if (kind === "pinned" && button.hasAttribute("aria-pressed")) score += 2;
      if (kind === "popover" && controlsDialog && button.getAttribute("data-state") === "open") score += 2;
      // pinned 与 popover 的文案互斥：pinned 含 "pinned/固定"，popover 不含。
      if (kind === "pinned" && labelMatch && isPinnedLabel(button)) score += 2;
      if (kind === "popover" && labelMatch && isPinnedLabel(button)) score -= 2;

      // 至少要有一个强信号（文案或 dialog 结构），否则不认。
      const hasStrongSignal = labelMatch;
      if (hasStrongSignal && score > bestScore) {
        bestScore = score;
        best = button;
      }
    }
    return best;
  };

  // 背景 token 会随 Codex 主题系统改版；卡片边界由已确认的 Summary 容器内
  // 的视觉表面确定。旧版类名仅用作兼容信号，不要求具体背景类名。
  const findSummarySurface = (container) => Array.from(container.querySelectorAll("div")).find((element) => {
    if (element.id === railId || element.id === hostId || element.closest(`#${railId}`)) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const rounded = Number.parseFloat(style.borderTopLeftRadius) >= 12 || element.classList.contains("rounded-3xl");
    const background = style.backgroundColor;
    return rounded && rect.width > 0 && rect.height > 0
      && ((background && background !== "transparent" && background !== "rgba(0, 0, 0, 0)")
        || element.classList.contains("bg-token-dropdown-background"));
  }) ?? null;

  const findSummaryPopover = () => {
    // Side Panel 打开时，Summary 会迁移到 aria-controls 指向的 Radix dialog。
    const trigger = findSummaryToggle("popover");
    if (!trigger || trigger.getAttribute("data-state") !== "open") return null;
    const controlledId = trigger.getAttribute("aria-controls");
    const popover = controlledId ? document.getElementById(controlledId) : null;
    if (!popover || popover.getAttribute("role") !== "dialog" || popover.getAttribute("data-state") !== "open") return null;
    const nativePanel = findSummarySurface(popover);
    const mountParent = nativePanel?.parentElement ?? null;
    if (!nativePanel || !mountParent) return null;
    return {
      mode: "summary-popover",
      mountParent,
      nativePanel,
      styleRoot: popover,
      trigger
    };
  };

  const findFloatingSummary = () => {
    const pinnedToggle = findSummaryToggle("pinned");
    const floatingRoot = Array.from(document.querySelectorAll("div")).find((element) => {
      const className = typeof element.className === "string" ? element.className : "";
      return className.includes("thread-floating-content-top-inset") && className.includes("right-0");
    });
    if (!floatingRoot) return null;
    const summaryIsOpen = pinnedToggle?.getAttribute("aria-pressed") === "true";
    const nativeColumn = Array.from(floatingRoot.querySelectorAll("div")).find((element) => {
      const className = typeof element.className === "string" ? element.className : "";
      const style = getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      return className.includes("origin-top-right")
        && style.display !== "none"
        && style.visibility !== "hidden"
        && (summaryIsOpen || Number.parseFloat(style.opacity) > 0)
        && bounds.width > 0
        && bounds.height > 0;
    }) ?? null;
    if (!nativeColumn) return null;
    const nativePanel = findSummarySurface(nativeColumn);
    return nativePanel ? {
      mode: "animated-summary",
      mountParent: nativeColumn,
      floatingRoot,
      nativePanel,
      styleRoot: nativeColumn,
      trigger: pinnedToggle
    } : null;
  };

  const setHostVariable = (name, value) => {
    if (!value || host.style.getPropertyValue(name) === value) return;
    if (!hostStyles.has(name)) hostStyles.set(name, { value: host.style.getPropertyValue(name), priority: host.style.getPropertyPriority(name) });
    host.style.setProperty(name, value);
  };

  const syncNativeStyles = (nativeColumn) => {
    const rootStyle = getComputedStyle(document.documentElement);
    const dark = matchMedia("(prefers-color-scheme: dark)").matches;
    const nativePanel = nativeColumn ? findSummarySurface(nativeColumn) : null;
    const nativeHeader = nativePanel?.querySelector("header");
    const nativeSection = nativePanel?.querySelector("section");
    const panelStyle = nativePanel ? getComputedStyle(nativePanel) : null;
    const headerStyle = nativeHeader ? getComputedStyle(nativeHeader) : null;
    const dividerStyle = nativeSection ? getComputedStyle(nativeSection, "::after") : null;

    setHostVariable("--hg-panel-bg", panelStyle?.backgroundColor || rootStyle.getPropertyValue("--color-token-dropdown-background").trim() || (dark ? "#252525" : "#fff"));
    setHostVariable("--hg-panel-color", panelStyle?.color || rootStyle.getPropertyValue("--color-token-text-primary").trim() || (dark ? "#ececec" : "#1a1c1f"));
    setHostVariable("--hg-panel-radius", panelStyle?.borderRadius || "25px");
    setHostVariable("--hg-panel-shadow",
      panelStyle?.boxShadow && panelStyle.boxShadow !== "none"
        ? panelStyle.boxShadow
        : "0 0 0 .5px var(--color-token-border-heavy, rgba(26, 28, 31, .117)), 0 3px 7.5px rgba(0, 0, 0, .04), 0 0 20px rgba(0, 0, 0, .05)");
    setHostVariable("--hg-header-bg", headerStyle?.backgroundColor || rootStyle.getPropertyValue("--color-token-dropdown-background").trim() || (dark ? "#252525" : "#fff"));
    setHostVariable("--hg-header-color", headerStyle?.color || rootStyle.getPropertyValue("--color-token-text-tertiary").trim() || (dark ? "#aaa" : "#666"));
    setHostVariable("--hg-divider", dividerStyle?.backgroundColor || rootStyle.getPropertyValue("--color-token-border-default").trim());
    setHostVariable("--hg-font-family", panelStyle?.fontFamily || "-apple-system, system-ui, \"Segoe UI\", sans-serif");
    setHostVariable("--hg-font-weight", panelStyle?.fontWeight || "445");
    // 通用 Shell token 与迁移期媒体 token 共用同一原生视觉来源。
    setHostVariable("--cc-card-bg", host.style.getPropertyValue("--hg-panel-bg"));
    setHostVariable("--cc-card-fg", host.style.getPropertyValue("--hg-panel-color"));
    setHostVariable("--cc-card-border", rootStyle.getPropertyValue("--color-token-border-default").trim()
      || (dark ? "rgba(255,255,255,.12)" : "rgba(26,28,31,.117)"));
  };

  const createRail = (summary) => {
    const rail = document.createElement("div");
    rail.id = railId;
    rail.dataset.mode = summary.mode;
    rail.setAttribute("aria-label", "Companion 卡片侧栏");
    const sharedStyles = [
      "display:block", "width:332px", "min-width:332px", "max-width:332px",
      "padding:12px 16px 16px", "overflow:visible", "pointer-events:auto",
      "box-sizing:border-box"
    ];
    rail.style.cssText = summary.mode === "summary-popover"
      ? [...sharedStyles, "position:relative", "flex:none", "margin-top:12px", "margin-left:-16px"].join(";")
      : ["position:absolute", "left:-16px", ...sharedStyles, "z-index:1"].join(";");
    summary.mountParent.append(rail);
    return rail;
  };

  const positionAnimatedRail = (rail, nativeColumn, nativePanel) => {
    const columnBounds = nativeColumn.getBoundingClientRect();
    const panelBounds = nativePanel.getBoundingClientRect();
    const transform = getComputedStyle(nativeColumn).transform;
    const matrix = transform && transform !== "none" ? new DOMMatrixReadOnly(transform) : null;
    const scale = matrix ? Math.max(0.01, Math.hypot(matrix.a, matrix.b)) : 1;
    // getBoundingClientRect 包含 Summary 的 scale 动画；反算后才能保证首帧也是 24px 布局间距。
    const topValue = Math.round((panelBounds.bottom - columnBounds.top) / scale + 12);
    const top = `${topValue}px`;
    if (rail.style.top !== top) rail.style.top = top;
    rail.style.removeProperty("height");
    rail.style.removeProperty("flex-basis");
  };

  // 播放器独立挂载；入口优先占用顶栏位置，找不到可靠锚点时回退悬浮按钮。
  // 随 Summary 模式只复用原生卡片的下方空间，不切换到独立浮层。
  let standalone = placement === "standalone-button";
  const shell = document.createElement("div");
  shell.id = `${hostId}-shell`;
  shell.style.cssText = "all:initial !important;position:fixed !important;inset:0 !important;z-index:2147483646 !important;pointer-events:none !important;-webkit-app-region:no-drag !important";
  const shellShadow = shell.attachShadow({ mode: "open" });
  shellShadow.innerHTML = `
    <style>
      :host { color-scheme: light dark; }
      * { box-sizing: border-box; }
      button {
        position:absolute; top:48px; right:12px; height:32px; padding:0 10px;
        display:flex; align-items:center; gap:6px; border:1px solid rgba(127,127,127,.3);
        border-radius:10px; cursor:pointer; pointer-events:auto; -webkit-app-region:no-drag;
        font:12px -apple-system,system-ui,sans-serif;
        color:var(--color-token-text-primary, #1a1c1f);
        background:var(--color-token-dropdown-background, #fff);
        box-shadow:0 2px 8px #0002;
      }
      button[hidden] { display:none; }
      button[aria-expanded="true"] { outline:2px solid #8888; }
      button:focus-visible { outline:2px solid #4b91e2; outline-offset:2px; }
      .drawer {
        position:absolute; top:88px; right:0; bottom:0;
        width:min(348px, 100%); padding:12px 16px 16px;
        overflow:auto; overscroll-behavior:contain; pointer-events:auto;
        -webkit-app-region:no-drag; transform-origin:top right;
      }
      .drawer[hidden] { display:none; }
      @media (prefers-color-scheme:dark) {
        button { color:var(--color-token-text-primary, #ececec); background:var(--color-token-dropdown-background, #252525); }
      }
    </style>
    <button type="button" aria-label="Companion 卡片" aria-expanded="false" aria-controls="companion-drawer" title="打开或关闭播放器（Esc 关闭）">播放器</button>
    <div id="companion-drawer" class="drawer" role="region" aria-label="Companion 卡片" hidden></div>
  `;
  const companionButton = shellShadow.querySelector("button");
  const ownedRail = shellShadow.querySelector(".drawer");
  ownedRail.dataset.mode = "standalone";
  let drawerOpen = false;
  let drawerAnimation = null;
  const drawerMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const setDrawerVisible = (open) => {
    if (drawerOpen === open) return;
    drawerOpen = open;
    const previous = getComputedStyle(ownedRail);
    const from = ownedRail.hidden
      ? { opacity: "0", transform: "translateX(12px) scale(0.98)" }
      : { opacity: previous.opacity, transform: previous.transform };
    drawerAnimation?.cancel();
    drawerAnimation = null;
    ownedRail.hidden = false;
    ownedRail.inert = !open;
    ownedRail.dataset.state = open ? "opening" : "closing";
    const to = { opacity: open ? "1" : "0", transform: open ? "translateX(0) scale(1)" : "translateX(12px) scale(0.98)" };
    ownedRail.style.opacity = to.opacity;
    ownedRail.style.transform = to.transform;
    const finish = () => {
      ownedRail.hidden = !open;
      ownedRail.dataset.state = open ? "open" : "closed";

      schedulePlacement();
    };
    if (drawerMotion.matches || typeof ownedRail.animate !== "function") { finish(); return; }
    const animation = ownedRail.animate([from, to], {
      duration: open ? 180 : 140,
      easing: open ? "cubic-bezier(0.2, 0.8, 0.2, 1)" : "ease-in"
    });
    drawerAnimation = animation;
    // 快速反向点击沿当前帧继续；旧动画不能隐藏重开的面板或停止新播放。
    animation.finished.then(() => {
      if (disposed || drawerAnimation !== animation) return;
      drawerAnimation = null;
      finish();
    }).catch(() => {});
  };

  const toolbarHost = document.createElement("span");
  toolbarHost.id = `${hostId}-toolbar`;
  toolbarHost.style.cssText = "all:initial !important;display:inline-flex !important;flex:0 0 28px !important;width:28px !important;height:28px !important;pointer-events:auto !important;-webkit-app-region:no-drag !important";
  const toolbarShadow = toolbarHost.attachShadow({ mode: "open" });
  toolbarShadow.innerHTML = `
    <style>
      button { display:flex;align-items:center;justify-content:center;width:28px;height:28px;
        padding:0;border:0;border-radius:8px;background:transparent;cursor:pointer;
        color:var(--color-token-text-tertiary, #888);pointer-events:auto;-webkit-app-region:no-drag; }
      button:hover, button[aria-expanded="true"] { background:rgba(127,127,127,.14); }
      button:focus-visible { outline:2px solid #4b91e2;outline-offset:1px; }
      svg { width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.5; }
    </style>
    <button type="button" aria-label="Companion 卡片" title="播放器" aria-expanded="false">
      <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="2.5" y="4" width="15" height="12" rx="2"/><path d="m8 7 5 3-5 3Z"/></svg>
    </button>
  `;
  const toolbarButton = toolbarShadow.querySelector("button");
  const placeToolbarEntry = () => {
    // Summary 优先；按钮改名或移走时仍可放在 Share 后面。只借位置，不驱动原生按钮。
    // 容器由实际 flex 布局确定，不依赖类名、固定祖先层数或一定存在 header 标签。
    const candidates = Array.from(document.querySelectorAll('header button, [role="toolbar"] button'));
    const shareLabel = /^(?:share|分享|共享|共有|공유|compartir|partager|teilen)$/i;
    const isShare = (button) => [button.getAttribute("aria-label"), button.getAttribute("title"), button.textContent]
      .some((text) => shareLabel.test((text ?? "").trim()));
    const anchors = [
      ...candidates.filter(matchesSummaryLabel).map((trigger) => ({ trigger, after: false })),
      ...candidates.filter(isShare).map((trigger) => ({ trigger, after: true }))
    ];
    for (const { trigger, after } of anchors) {
      const rect = trigger.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0 || rect.top < 0 || rect.bottom > 64 || rect.left < window.innerWidth / 2) continue;
      const header = trigger.closest('header, [role="toolbar"]');
      let anchor = trigger;
      let group = anchor.parentElement;
      while (group) {
        const style = getComputedStyle(group);
        if ((style.display === "flex" || style.display === "inline-flex")
          && style.flexDirection === "row" && group.querySelectorAll("button").length >= 2) break;
        if (group === header) { group = null; break; }
        anchor = group;
        group = group.parentElement;
      }
      if (!group) continue;
      if (after) {
        if (toolbarHost.parentElement !== group || toolbarHost.previousSibling !== anchor) group.insertBefore(toolbarHost, anchor.nextSibling);
      } else if (toolbarHost.parentElement !== group || toolbarHost.nextSibling !== anchor) group.insertBefore(toolbarHost, anchor);
      const bounds = toolbarHost.getBoundingClientRect();
      const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      if (bounds.width > 0 && bounds.height > 0 && bounds.left >= 0 && bounds.right <= window.innerWidth && hit === toolbarHost) {
        syncResizeObservation(header, group);
        return true;
      }
    }
    toolbarHost.remove();
    syncResizeObservation();
    return false;
  };
  let panelIntent = null;
  let returnFocus = null;

  let closingSummary = null;
  let summaryCloseTimer = null;
  let drivingSummary = false;
  const summaryIsOpen = (trigger) => {
    if (!trigger?.isConnected) return false;
    // 明确的关闭状态优先于残留的退场动画，避免刚打开播放器又被旧面板关掉。
    for (const attribute of ["aria-pressed", "aria-expanded"]) {
      const value = trigger.getAttribute(attribute);
      if (value === "true" || value === "false") return value === "true";
    }
    const state = trigger.getAttribute("data-state");
    if (state === "open" || state === "closed") return state === "open";
    return (findSummaryPopover() ?? findFloatingSummary())?.trigger === trigger;
  };
  const openSummaryTrigger = () => [findSummaryToggle("pinned"), findSummaryToggle("popover")]
    .find(summaryIsOpen) ?? null;
  const clearSummaryClose = () => {
    clearTimeout(summaryCloseTimer);
    summaryCloseTimer = null;
    closingSummary = null;
  };

  const setCompanionOpen = (open) => {
    clearSummaryClose();
    if (!hasCards || disposed) return;
    if (!standalone && !fallbackActive) {
      const trigger = findSummaryToggle("pinned") ?? findSummaryToggle("popover");
      if (trigger && summaryIsOpen(trigger) !== open) trigger.click();
      schedulePlacement();
      return;
    }
    if (open) returnFocus = document.activeElement;
    panelIntent = open ? "cards" : null;
    if (open && (standalone || fallbackActive)) {
      const trigger = openSummaryTrigger();
      if (trigger) {
        closingSummary = trigger;
        // 使用原生开关更新真实状态，不只隐藏 DOM；只响应这次播放器打开操作。
        drivingSummary = true;
        try { trigger.click(); } finally { drivingSummary = false; }
        // 原生更新可异步提交；确认关闭前不展示播放器，也不重复点击原生开关。
        summaryCloseTimer = setTimeout(() => {
          const stillOpen = openSummaryTrigger();
          clearSummaryClose();
          if (stillOpen) setCompanionOpen(false);
          else schedulePlacement();
        }, 1200);
      }
    }
    if (!open) {
      // 只在焦点仍属于播放器时还原，避免抢走用户已经移到 Codex 的焦点。
      if (document.activeElement === shell || document.activeElement === toolbarHost) {
        if (returnFocus?.isConnected && returnFocus !== shell) returnFocus.focus({ preventScroll: true });
        else (companionButton.hidden ? toolbarButton : companionButton).focus({ preventScroll: true });
      }
    }
    schedulePlacement();
  };
  const onNativeSummaryClick = (event) => {
    if ((!standalone && !fallbackActive) || drivingSummary || panelIntent !== "cards") return;
    const trigger = event.composedPath().find((node) => node instanceof HTMLButtonElement && matchesSummaryLabel(node));
    if (trigger) setCompanionOpen(false);
  };
  // 捕获阶段先撤下播放器，原生点击/键盘激活照常传播，不劫持 Toggle Summary。
  document.addEventListener("click", onNativeSummaryClick, true);
  const onEntryClick = () => setCompanionOpen(panelIntent !== "cards");
  companionButton.addEventListener("click", onEntryClick);
  toolbarButton.addEventListener("click", onEntryClick);
  const onCompanionKeyDown = (event) => {
    if (event.key !== "Escape" || event.defaultPrevented || panelIntent !== "cards") return;
    // 只处理播放器自己的 Escape，避免抢占 Codex 的菜单和编辑器快捷键。
    if (!event.composedPath().includes(shell) && !event.composedPath().includes(toolbarHost)) return;
    event.preventDefault();
    event.stopPropagation();
    setCompanionOpen(false);
  };
  shell.addEventListener("keydown", onCompanionKeyDown);
  toolbarHost.addEventListener("keydown", onCompanionKeyDown);

  // 只接管会话与输入框的可用宽度，不改应用根节点、导航栏或 React 状态。
  // 原生 Summary 用 transform 平移这两个区域；停靠期间取消该平移，避免重复挤压。
  // 样式表覆盖而非改写原生 inline style，关闭时恢复的是原生当前状态。
  const dockStyle = document.createElement("style");
  dockStyle.id = `${hostId}-dock-style`;
  const dockNodes = new Set();
  const clearConversationDock = () => {
    dockStyle.remove();
    for (const node of dockNodes) restoreNativeAttribute(node, "data-companion-dock");
    dockNodes.clear();
  };
  const dockConversation = (open) => {
    clearConversationDock();
    ownedRail.style.removeProperty("width");
    if (!open) return;
    // 稳定的语义标记优先，类名仅用于找到承载滚动/容器查询的布局区域。
    const content = Array.from(document.querySelectorAll("[data-thread-user-message-navigation-content]"))
      .find((node) => node.getBoundingClientRect().width > 0);
    const scroller = content?.closest(".thread-scroll-container");
    if (!scroller) return;
    const bounds = scroller.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    const drawerWidth = Math.min(348, bounds.width * 0.45);
    ownedRail.style.width = `${drawerWidth}px`;
    ownedRail.style.right = `${Math.max(0, window.innerWidth - bounds.right)}px`;
    const mark = (node, value) => {
      markNative(node, "data-companion-dock", value);
      dockNodes.add(node);
    };
    mark(scroller, "scroll");
    let frame = content;
    while (frame.parentElement && frame.parentElement !== scroller) frame = frame.parentElement;
    if (frame !== scroller) mark(frame, "content");
    const footer = scroller.querySelector("[data-thread-scroll-footer]")
      ?? scroller.parentElement?.querySelector("[data-thread-scroll-footer]");
    if (footer) mark(footer, "footer");
    const width = Math.max(1, bounds.width - drawerWidth);
    dockStyle.textContent = `
      [data-companion-dock="scroll"], [data-companion-dock="footer"] {
        box-sizing:border-box !important; width:${width}px !important; max-width:${width}px !important;
      }
      [data-companion-dock="content"], [data-companion-dock="footer"] {
        transform:none !important; translate:none !important; --thread-wide-block-inline-shift:0px !important;
      }
    `;
    document.documentElement.append(dockStyle);
  };

  // 同一棵文档中的 moveBefore 保留焦点、iframe 与媒体的连接状态。
  // 老 Chromium 或原生已卸载的祖先只能 append；不重建 host/子树。
  const moveHost = (parent) => {
    if (host.parentElement === parent) return;
    if (host.isConnected && parent.isConnected && typeof parent.moveBefore === "function") {
      try { parent.moveBefore(host, null); return; } catch (error) {
        moveFallbacks += 1;
        reportError(error);
      }
    } else if (host.parentNode) moveFallbacks += 1;
    parent.append(host);
  };
  let inlineRail = null;
  const clearInlineRail = () => {
    inlineRail?.remove();
    inlineRail = null;
  };
  const ensureStandalonePlacement = () => {
    // 先迁移 host 再移除旧 rail；顺序反过来会断开正在播放的媒体。
    if (!shell.isConnected) document.documentElement.append(shell);
    moveHost(ownedRail);
    clearInlineRail();
    restorePopoverPanel();
    restoreAnimationColumn();
    restoreOuterScroller();
    const inToolbar = placeToolbarEntry();
    companionButton.hidden = inToolbar;
    ownedRail.style.top = inToolbar ? "48px" : "88px";
    ownedRail.style.right = "0px";
    const nativeOpen = openSummaryTrigger();
    if (closingSummary && !nativeOpen) clearSummaryClose();
    if (panelIntent === "cards" && nativeOpen && !closingSummary) setCompanionOpen(false);
    const open = panelIntent === "cards" && !nativeOpen;
    toolbarButton.setAttribute("aria-expanded", String(open));
    setDrawerVisible(open);
    dockConversation(open || (!nativeOpen && !ownedRail.hidden));
    companionButton.setAttribute("aria-expanded", String(open));
    syncNativeStyles(null);
    placementMode = open ? "standalone" : "hidden";
    notifyVisibility(open, "standalone");
    return open;
  };

  const ensurePlacement = () => {
    if (disposed) return false;
    if (!hasCards) {
      resetLayout(true);
      notifyVisibility(false, "no-cards");
      return false;
    }
    if (standalone || fallbackActive) return ensureStandalonePlacement();
    clearConversationDock();
    toolbarHost.remove();
    companionButton.hidden = true;
    // 隐藏时保留同一个已连接的 rail；只有原生自己删除父节点才迁移到停车区。
    const summary = findSummaryPopover() ?? findFloatingSummary();
    if (!summary) {
      restorePopoverPanel();
      restoreAnimationColumn();
      restoreOuterScroller();
      syncResizeObservation();
      if (!host.isConnected) {
        if (!shell.isConnected) document.documentElement.append(shell);
        moveHost(ownedRail);
        clearInlineRail();
      }
      if (inlineRail) { inlineRail.hidden = true; inlineRail.style.display = "none"; inlineRail.inert = true; }
      ownedRail.hidden = true;
      placementMode = "hidden";
      notifyVisibility(false, "summary-hidden");
      return false;
    }
    const { mountParent, nativePanel, styleRoot } = summary;
    if (summary.mode === "summary-popover") {
      preservePopoverPanel(nativePanel);
      restoreAnimationColumn();
    } else {
      restorePopoverPanel();
      configureAnimationColumn(mountParent);
    }
    configureOuterScroller(summary);
    if (!inlineRail || inlineRail.parentElement !== mountParent || inlineRail.dataset.mode !== summary.mode) {
      const previous = inlineRail;
      inlineRail = createRail(summary);
      moveHost(inlineRail);
      previous?.remove();
    }
    inlineRail.hidden = false;
    inlineRail.style.display = "block";
    inlineRail.inert = false;
    if (summary.mode === "animated-summary") positionAnimatedRail(inlineRail, mountParent, nativePanel);
    moveHost(inlineRail);
    ownedRail.hidden = true;
    syncNativeStyles(styleRoot);
    syncResizeObservation(mountParent, nativePanel);
    placementMode = summary.mode;
    notifyVisibility(true, "summary-visible");
    return true;
  };

  const schedulePlacement = () => {
    if (disposed || placementQueued) return;
    placementQueued = true;
    queueMicrotask(() => {
      placementQueued = false;
      runPlacement();
    });
  };

  const observer = new MutationObserver(schedulePlacement);

  // MutationObserver 只看 DOM/属性变化：纯窗口 resize、原生面板因内容换行改高度
  // （无 mutation）时 rail 的 top/宽度会陈旧 → 卡片与原生面板之间重叠或空档。
  // ResizeObserver 盯挂载列与原生面板的尺寸变化，window resize 盯位置变化
  // （bounds 移动但尺寸不变时 RO 不触发），两者都复用 schedulePlacement 去抖。
  const resizeObserver = new ResizeObserver(schedulePlacement);
  let resizeObserved = [];
  const syncResizeObservation = (...elements) => {
    const next = elements.filter(Boolean);
    if (
      next.length === resizeObserved.length
      && next.every((element, index) => element === resizeObserved[index])
    ) return;
    for (const element of resizeObserved) resizeObserver.unobserve(element);
    resizeObserved = next;
    for (const element of resizeObserved) resizeObserver.observe(element);
  };
  window.addEventListener("resize", schedulePlacement);

  // 关键：ensurePlacement 自身会改 DOM（隐藏原生面板、写 rail 定位、同步样式等），
  // 这些改动又会被 observer 捕获并再次触发 schedulePlacement，形成微任务风暴（渲染冻结）。
  // 因此运行放置逻辑时先断开 observer，跑完再重连并清空期间自产生的 records。
  const runPlacement = () => {
    observer.disconnect();
    try {
      return ensurePlacement();
    } catch (error) {
      reportError(error);
      restorePopoverPanel();
      restoreAnimationColumn();
      restoreOuterScroller();
      clearConversationDock();
      fallbackActive = true;
      try { return ensureStandalonePlacement(); } catch (fallbackError) {
        reportError(fallbackError);
        resetLayout(false);
        notifyVisibility(false, "placement-error");
        return false;
      }
    } finally {
      if (!disposed) {
        observer.takeRecords();
        observer.observe(document.documentElement, {
          childList: true, subtree: true, attributes: true,
          attributeFilter: ["style", "class", "aria-pressed", "aria-expanded", "aria-controls", "data-state"]
        });
      }
    }
  };

  const resetLayout = (detach) => {
    clearSummaryClose();
    drawerAnimation?.cancel();
    drawerAnimation = null;
    drawerOpen = false;
    ownedRail.hidden = true;
    ownedRail.inert = true;
    restorePopoverPanel();
    restoreAnimationColumn();
    restoreOuterScroller();
    clearConversationDock();
    syncResizeObservation();
    toolbarHost.remove();
    if (detach) {
      host.remove();
      clearInlineRail();
      shell.remove();
    } else {
      if (!shell.isConnected) document.documentElement.append(shell);
      moveHost(ownedRail);
      clearInlineRail();
      companionButton.hidden = false;
    }
    placementMode = "hidden";
  };
  const api = Object.freeze({
    setPlacement(value) {
      validatePlacement(value);
      if (disposed || placement === value) return;
      clearSummaryClose();
      drawerAnimation?.cancel();
      drawerAnimation = null;
      drawerOpen = false;
      ownedRail.hidden = true;
      panelIntent = null;
      placement = value;
      standalone = value === "standalone-button";
      fallbackActive = false;
      runPlacement();
    },
    setHasCards(value) {
      if (disposed || hasCards === Boolean(value)) return;
      hasCards = Boolean(value);
      if (!hasCards) panelIntent = null;
      runPlacement();
    },
    setOpen(value) { setCompanionOpen(Boolean(value)); },
    isOpen: () => !disposed && Boolean(lastVisibility?.visible),
    isPlaced: () => !disposed && hasCards && host.isConnected && placementMode !== "hidden",
    getDiagnostics: () => ({ placement, mode: placementMode, visible: !disposed && Boolean(lastVisibility?.visible), hasCards, disposed, fallbackActive, moveFallbacks }),
    dispose() {
      if (disposed) return;
      disposed = true;
      observer.disconnect();
      resizeObserver.disconnect();
      window.removeEventListener("resize", schedulePlacement);
      document.removeEventListener("click", onNativeSummaryClick, true);
      shell.removeEventListener("keydown", onCompanionKeyDown);
      toolbarHost.removeEventListener("keydown", onCompanionKeyDown);
      companionButton.removeEventListener("click", onEntryClick);
      toolbarButton.removeEventListener("click", onEntryClick);
      resetLayout(true);
      for (const [property, { value, priority }] of hostStyles) {
        if (value) host.style.setProperty(property, value, priority);
        else host.style.removeProperty(property);
      }
      hostStyles.clear();
      notifyVisibility(false, "disposed");
    }
  });
  runPlacement();
  return api;
}
