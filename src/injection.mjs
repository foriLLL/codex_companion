// 独立于发行版本：同一个 v0.0.1 开发周期内注入源码变化也必须触发已打开页面重挂载。
export const INJECTION_VERSION = "0.0.1-r4";
export const HOST_ID = "codex-companion-root";
export const RAIL_ID = "codex-companion-rail";
export const BRIDGE_KEY = "__CODEX_COMPANION__";
const LEGACY_HOST_IDS = ["codex-hg-root"];
const LEGACY_RAIL_IDS = ["codex-hg-rail"];
const LEGACY_BRIDGE_KEYS = ["__CODEX_HG__"];

function codexCompanionBootstrap(config) {
  const {
    action,
    bridgeKey,
    cards = { hongguo: true, emby: true },
    placement = "standalone-button",
    cardOrder: rawCardOrder,
    hostId,
    legacyBridgeKeys,
    legacyHostIds,
    legacyRailIds,
    railId,
    version
  } = config;
  // 卡片顺序归一化（白名单 + 去重 + 缺失补末尾）；参与挂载身份，顺序变化即重挂载。
  const cardOrder = [];
  if (Array.isArray(rawCardOrder)) {
    for (const id of rawCardOrder) {
      if (["hongguo", "emby"].includes(id) && !cardOrder.includes(id)) cardOrder.push(id);
    }
  }
  for (const id of ["hongguo", "emby"]) {
    if (!cardOrder.includes(id)) cardOrder.push(id);
  }
  const rpcBinding = "__CODEX_COMPANION_RPC__";
  // 卡片开关、placement 与顺序参与挂载身份：配置变更后即使 version 相同也会触发重挂载。
  const cardsKey = `${version}:${placement}:${cards.hongguo ? "1" : "0"}${cards.emby ? "1" : "0"}:${cardOrder.join(",")}`;
  const previous = globalThis[bridgeKey];
  const cleanupLegacy = () => {
    for (const legacyBridgeKey of legacyBridgeKeys) {
      try { globalThis[legacyBridgeKey]?.unmount?.(); } catch {}
      delete globalThis[legacyBridgeKey];
    }
    for (const legacyHostId of legacyHostIds) {
      document.querySelectorAll(`#${legacyHostId}`).forEach((el) => {
        try { el.__hgCleanup?.(); } catch {}
        el.remove();
      });
    }
    for (const legacyRailId of legacyRailIds) {
      document.querySelectorAll(`#${legacyRailId}`).forEach((el) => el.remove());
    }
  };

  if (action === "unmount") {
    previous?.unmount?.();
    delete globalThis[bridgeKey];
    cleanupLegacy();
    document.querySelectorAll(`#${hostId}`).forEach((el) => {
      try { el.__hgCleanup?.(); } catch {}
      el.remove();
    });
    document.querySelectorAll(`#${railId}`).forEach((el) => el.remove());
    return { status: "unmounted", version };
  }

  cleanupLegacy();
  if (previous?.cardsKey === cardsKey && previous.isMounted?.()) {
    return { status: "already-mounted", version };
  }

  // 两张卡片都被关闭时等价于卸载：移除现有实例，安装一个 stub 桥。
  // stub 保留 version/cardsKey，让注入器的健康检查与重复注入短路，避免每轮扫描都重挂载。
  if (!cards.hongguo && !cards.emby) {
    previous?.unmount?.();
    document.querySelectorAll(`#${hostId}`).forEach((el) => {
      try { el.__hgCleanup?.(); } catch {}
      el.remove();
    });
    document.querySelectorAll(`#${railId}`).forEach((el) => el.remove());
    globalThis[bridgeKey] = Object.freeze({
      version,
      cardsKey,
      isMounted: () => true,
      isPlaced: () => false,
      unmount: () => { delete globalThis[bridgeKey]; }
    });
    return { status: "cards-disabled", version };
  }

  previous?.unmount?.();
  // 先调用 cleanup 断开 observer，再移除元素，防止被重新注入
  document.querySelectorAll(`#${hostId}`).forEach((el) => {
    try { el.__hgCleanup?.(); } catch {}
    el.remove();
  });
  document.querySelectorAll(`#${railId}`).forEach((el) => el.remove());

  const mount = () => {
    const mounted = globalThis[bridgeKey];
    if (mounted?.cardsKey === cardsKey && mounted.isMounted?.()) {
      return { status: "already-mounted", version };
    }

    // 彻底清理所有旧实例：调用它们的 cleanup 断开 observer，防止重新注入
    document.querySelectorAll(`#${hostId}`).forEach((oldHost) => {
      try { oldHost.__hgCleanup?.(); } catch {}
      oldHost.remove();
    });
    document.querySelectorAll(`#${railId}`).forEach((oldRail) => oldRail.remove());

    const host = document.createElement("div");
    host.id = hostId;
    host.dataset.version = version;
    host.setAttribute("aria-label", "红果短剧与 Emby");
    host.style.cssText = [
      "position:static",
      "display:block",
      "flex:0 0 auto",
      "width:100%",
      "min-width:0",
      "font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif",
      "color-scheme:light dark",
      "pointer-events:auto"
    ].join(";");

    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host { display: block; }
        /* 卡片间距用相邻兄弟选择器而非 flex gap：Codex renderer 的 Chromium 偏旧
           （:has()/flex gap 均不可用），.panel+.panel 与卡片顺序无关，两种顺序都适用；
           前一张隐藏（display:none）时后一张不留间距。 */
        .panel + .panel { margin-top: 24px; }
        .panel[hidden] + .panel { margin-top: 0; }
        /* 语义色：错误/危险统一一个红（#c84848；深底上 #c33f3f 对比度仅约 3:1 偏弱） */
        :host { --cc-danger: #c84848; }
        * { box-sizing: border-box; }
        button, input { font: inherit; }
        button { color: inherit; }

        /* .panel 的 display:flex 会覆盖 UA 的 [hidden]；显式声明保证卡片开关生效 */
        .panel[hidden] { display: none; }

        .panel {
          width: 100%;
          /* 高度随窗口弹性收缩：矮窗口下两卡合计 944px 必须滚整栏才能摸到 Emby 卡 */
          height: min(520px, 60vh);
          display: flex;
          flex-direction: column;
          overflow: hidden;
          border: 0;
          border-radius: var(--hg-panel-radius, 25px);
          color: var(--hg-panel-color, var(--color-token-text-primary, #1a1c1f));
          background: var(--hg-panel-bg, var(--color-token-dropdown-background, #fff));
          box-shadow: var(
            --hg-panel-shadow,
            0 0 0 .5px var(--color-token-border-heavy, rgba(26, 28, 31, .117)),
            0 3px 7.5px rgba(0, 0, 0, .04),
            0 0 20px rgba(0, 0, 0, .05)
          );
          font-family: var(--hg-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
          font-size: 14px;
          font-weight: var(--hg-font-weight, 445);
          line-height: 21px;
        }

        .hg-panel { position: relative; height: min(520px, 60vh); min-height: 320px; padding: 0; }
        .hg-app, .hg-view { width: 100%; height: 100%; min-height: 0; }
        .hg-view { display: flex; flex-direction: column; animation: hg-fade-in 150ms ease-out; }
        @keyframes hg-fade-in { from { opacity: 0; } to { opacity: 1; } }
        .hg-toolbar,
        .emby-toolbar {
          position: relative;
          z-index: 3;
          height: 38px;
          min-height: 38px;
          display: flex;
          align-items: center;
          gap: 7px;
          padding: 10px 10px 2px 14px;
          background: var(--hg-header-bg, var(--color-token-dropdown-background, #fff));
          color: var(--hg-header-color, var(--color-token-text-tertiary, rgba(26,28,31,.55)));
        }
        .hg-toolbar::after,
        .emby-toolbar::after {
          content: "";
          position: absolute;
          right: 14px;
          bottom: 0;
          left: 14px;
          height: .5px;
          background: var(--hg-divider, var(--color-token-border-default, rgba(26,28,31,.078)));
          pointer-events: none;
        }
        .hg-toolbar-title,
        .emby-toolbar-title {
          min-width: 0;
          flex: 1;
          overflow: hidden;
          margin: 0;
          font-size: 14px;
          font-weight: var(--hg-font-weight, 445);
          line-height: 21px;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .hg-icon-button, .hg-button, .hg-result, .hg-feature, .hg-episode {
          border: 0;
          color: inherit;
          background: transparent;
          cursor: pointer;
          -webkit-tap-highlight-color: transparent;
        }
        .hg-icon-button {
          /* toolbar 内容盒 26px（38 - 10 - 2），27px 会溢出 1px */
          width: 26px;
          height: 26px;
          display: grid;
          flex: 0 0 auto;
          place-items: center;
          padding: 0;
          border-radius: 9px;
          color: var(--hg-header-color, var(--color-token-text-tertiary, rgba(26,28,31,.58)));
        }
        .hg-icon-button svg,
        .emby-icon-button svg {
          width: 16px;
          height: 16px;
          display: block;
          fill: none;
          stroke: currentColor;
          stroke-linecap: round;
          stroke-linejoin: round;
          stroke-width: 1.5;
        }
        .hg-icon-button:hover, .hg-icon-button:focus-visible, .hg-button:hover, .hg-button:focus-visible,
        .hg-result:hover, .hg-result:focus-visible, .hg-feature:hover, .hg-feature:focus-visible,
        .hg-episode:hover, .hg-episode:focus-visible {
          outline: none;
          background: var(--hg-hover-bg, rgba(127,127,127,.10));
        }
        .hg-scroll {
          min-height: 0;
          flex: 1;
          overflow-x: hidden;
          overflow-y: auto;
          /* 内层滚到底不再链式带动外层 rail（此前 y:auto 会把 Emby 卡顶走） */
          overscroll-behavior: contain;
          /* 纵向长列表保留 4px 细滚动条作位置提示（横向行不在此列，太吵） */
          scrollbar-width: thin;
          scrollbar-color: rgba(127,127,127,.38) transparent;
        }
        .hg-scroll::-webkit-scrollbar { width: 4px; }
        .hg-scroll::-webkit-scrollbar-thumb { background: rgba(127,127,127,.38); border-radius: 2px; }
        .hg-scroll::-webkit-scrollbar-track { background: transparent; }
        .hg-content { padding: 12px 14px 16px; }
        .hg-search-form { display: flex; gap: 7px; }
        .hg-search-input {
          min-width: 0;
          height: 34px;
          flex: 1;
          padding: 0 10px;
          border: .5px solid var(--hg-divider, var(--color-token-border-default, rgba(26,28,31,.16)));
          border-radius: 10px;
          outline: none;
          color: inherit;
          background: var(--hg-input-bg, rgba(127,127,127,.055));
          font-size: 12px;
        }
        .hg-search-input:focus { border-color: rgba(208,76,76,.72); box-shadow: 0 0 0 2px rgba(208,76,76,.10); }
        .hg-button {
          min-height: 34px;
          padding: 6px 11px;
          border-radius: 10px;
          background: var(--hg-hover-bg, rgba(127,127,127,.10));
          font-size: 12px;
          font-weight: 600;
        }
        .hg-button.primary { color: #fff; background: #bb3e48; }
        .hg-caption, .hg-muted {
          color: var(--hg-header-color, var(--color-token-text-tertiary, rgba(26,28,31,.55)));
          font-size: 10px;
          line-height: 15px;
        }
        .hg-caption { margin: 7px 1px 13px; }
        .hg-section-title { margin: 0 0 8px; font-size: 12px; font-weight: 650; line-height: 17px; }
        .hg-feature-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px; }
        .hg-feature { min-width: 0; padding: 0; border-radius: 11px; text-align: left; }
        .hg-feature-poster {
          position: relative;
          width: 100%;
          aspect-ratio: 3 / 4;
          display: grid;
          place-items: center;
          overflow: hidden;
          border-radius: 10px;
          color: rgba(255,255,255,.72);
          background: linear-gradient(145deg, #a84c4d, #4c2028);
          font-size: 11px;
        }
        .hg-feature-poster img, .hg-result-poster img, .hg-detail-poster img { position: absolute; inset: 0; display: block; width: 100%; height: 100%; object-fit: cover; }
        .hg-feature-name { display: block; overflow: hidden; margin: 5px 2px 2px; font-size: 11px; line-height: 15px; text-overflow: ellipsis; white-space: nowrap; }
        .hg-feed-status { min-height: 42px; display: grid; place-items: center; padding: 10px 0 2px; color: var(--hg-header-color, rgba(26,28,31,.55)); font-size: 10px; text-align: center; }
        .hg-feed-status .hg-button { min-height: 29px; }
        .hg-inline-status { display: flex; align-items: center; justify-content: center; gap: 7px; min-height: 34px; margin-top: 8px; color: var(--hg-header-color, rgba(26,28,31,.55)); font-size: 10px; }
        .hg-mini-spinner { width: 14px; height: 14px; border: 1.5px solid rgba(127,127,127,.2); border-top-color: #bb3e48; border-radius: 50%; animation: hg-spin .8s linear infinite; }
        .hg-results { display: flex; flex-direction: column; gap: 2px; margin-top: 10px; }
        .hg-result { width: 100%; min-height: 74px; display: flex; align-items: center; gap: 9px; padding: 6px; border-radius: 11px; text-align: left; }
        .hg-result-poster { position: relative; width: 44px; height: 62px; display: grid; flex: 0 0 auto; place-items: center; overflow: hidden; border-radius: 7px; color: #fff; background: linear-gradient(145deg, #a84c4d, #4c2028); font-size: 9px; }
        .hg-result-copy { min-width: 0; flex: 1; }
        .hg-result-name { display: block; overflow: hidden; font-size: 12px; line-height: 17px; text-overflow: ellipsis; white-space: nowrap; }
        .hg-list-row { display: flex; align-items: center; gap: 2px; }
        .hg-list-row .hg-result { flex: 1; min-width: 0; }
        .hg-list-remove { flex: 0 0 auto; opacity: .55; }
        .hg-list-remove:hover, .hg-list-remove:focus-visible { opacity: 1; }
        .hg-empty, .hg-center { display: grid; place-items: center; text-align: center; color: var(--hg-header-color, rgba(26,28,31,.55)); }
        .hg-empty { min-height: 110px; padding: 18px; border: .5px dashed var(--hg-divider, rgba(26,28,31,.12)); border-radius: 13px; font-size: 11px; }
        .hg-center { min-height: 100%; align-content: center; gap: 10px; padding: 24px; }
        .hg-spinner { width: 27px; height: 27px; border: 2px solid rgba(127,127,127,.2); border-top-color: #bb3e48; border-radius: 50%; animation: hg-spin .8s linear infinite; }
        @keyframes hg-spin { to { transform: rotate(360deg); } }
        .hg-error-title { color: var(--hg-panel-color, currentColor); font-size: 13px; font-weight: 650; }
        .hg-error-actions { display: flex; gap: 8px; }
        .hg-detail-hero { position: relative; display: flex; gap: 11px; padding: 12px 14px; }
        .hg-detail-hero::after { content: ""; position: absolute; right: 14px; bottom: 0; left: 14px; height: .5px; background: var(--hg-divider, rgba(26,28,31,.078)); }
        .hg-detail-poster { position: relative; width: 62px; height: 86px; display: grid; flex: 0 0 auto; place-items: center; overflow: hidden; border-radius: 9px; color: #fff; background: linear-gradient(145deg, #a84c4d, #4c2028); font-size: 10px; }
        .hg-detail-copy { min-width: 0; flex: 1; }
        .hg-detail-title { margin: 2px 0 4px; font-size: 14px; font-weight: 650; line-height: 19px; }
        .hg-detail-description { display: -webkit-box; overflow: hidden; margin-top: 6px; -webkit-box-orient: vertical; -webkit-line-clamp: 3; }
        .hg-episode-grid { display: grid; grid-template-columns: repeat(5, minmax(0,1fr)); gap: 7px; padding: 11px 14px 14px; }
        .hg-episode { height: 32px; padding: 0; border-radius: 9px; background: var(--hg-hover-bg, rgba(127,127,127,.075)); font-size: 11px; }
        .hg-playback { position: relative; width: 100%; height: 100%; overflow: hidden; outline: none; background: #000; }
        .hg-video { display: block; width: 100%; height: 100%; object-fit: contain; background: #000; }
        .hg-playback-chrome { position: absolute; z-index: 3; top: 0; right: 0; left: 0; display: flex; align-items: center; gap: 8px; padding: 9px; color: #fff; background: linear-gradient(rgba(0,0,0,.72), transparent); opacity: 0; pointer-events: none; transition: opacity 120ms ease-out; }
        .hg-playback:hover .hg-playback-chrome, .hg-playback:focus .hg-playback-chrome, .hg-playback:focus-within .hg-playback-chrome { opacity: 1; pointer-events: auto; }
        /* 暂停时常显：JS 同步的 data-paused（不用 :has()/:paused，见 emby 侧注释） */
        .hg-playback[data-paused="true"] .hg-playback-chrome { opacity: 1; pointer-events: auto; }
        .hg-playback-back { color: #fff; background: rgba(0,0,0,.46); backdrop-filter: blur(8px); }
        .hg-playback-title { min-width: 0; overflow: hidden; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
        .hg-playback-status { position: absolute; z-index: 2; inset: 0; display: grid; place-items: center; align-content: center; gap: 10px; padding: 24px; color: rgba(255,255,255,.82); background: rgba(0,0,0,.32); font-size: 11px; text-align: center; }
        .hg-playback-status[hidden] { display: none; }
        .hg-autoplay {
          position: absolute;
          z-index: 4;
          inset: 0;
          display: grid;
          place-items: center;
          padding: 24px;
          color: #fff;
          background: rgba(0,0,0,.72);
          text-align: center;
          backdrop-filter: blur(8px);
        }
        .hg-autoplay[hidden] { display: none; }
        .hg-autoplay-card { display: grid; justify-items: center; gap: 7px; width: 100%; max-width: 250px; }
        .hg-autoplay-title { font-size: 15px; font-weight: 650; line-height: 21px; }
        .hg-autoplay-detail { min-height: 16px; color: rgba(255,255,255,.68); font-size: 11px; line-height: 16px; }
        .hg-autoplay-actions { display: flex; justify-content: center; gap: 8px; margin-top: 7px; }
        .hg-autoplay .hg-button { color: #fff; background: rgba(255,255,255,.16); }
        .hg-autoplay .hg-button.primary { background: #bb3e48; }
        .emby-card {
          position: relative;
          height: min(400px, 48vh);
          min-height: 280px;
          padding: 0;
          contain: layout paint;
        }
        .emby-app,
        .emby-view {
          width: 100%;
          height: 100%;
          min-height: 0;
        }
        .emby-view {
          display: flex;
          flex-direction: column;
          animation: emby-fade-in 150ms ease-out;
        }
        @keyframes emby-fade-in {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @media (prefers-reduced-motion: reduce) {
          .hg-view, .emby-view { animation: none; }
          .hg-spinner, .emby-spinner { animation: none !important; }
        }
        .emby-icon-button,
        .emby-button,
        .emby-chip,
        .emby-media-button,
        .emby-list-button,
        .emby-poster-button,
        .emby-episode-nav-button,
        .emby-episode-season,
        .emby-episode-picker-item {
          border: 0;
          cursor: pointer;
          -webkit-tap-highlight-color: transparent;
        }
        .emby-icon-button {
          /* 与 .hg-icon-button 一致：toolbar 内容盒 26px，27px 会溢出 1px */
          width: 26px;
          height: 26px;
          display: inline-grid;
          flex: 0 0 auto;
          place-items: center;
          padding: 0;
          border-radius: 9px;
          color: var(--hg-header-color, var(--color-token-text-tertiary, rgba(26,28,31,.55)));
          background: transparent;
        }
        .emby-icon-button:hover,
        .emby-icon-button:focus-visible,
        .emby-button:hover,
        .emby-button:focus-visible,
        .emby-chip:hover,
        .emby-chip:focus-visible,
        .emby-media-button:hover,
        .emby-media-button:focus-visible,
        .emby-list-button:hover,
        .emby-list-button:focus-visible,
        .emby-poster-button:hover,
        .emby-poster-button:focus-visible {
          outline: none;
          background: var(--hg-hover-bg, rgba(127,127,127,.10));
        }
        .emby-scroll {
          min-height: 0;
          flex: 1;
          overflow-x: hidden;
          overflow-y: auto;
          /* 内层滚到底不再链式带动外层 rail */
          overscroll-behavior: contain;
          scrollbar-width: thin;
          scrollbar-color: rgba(127,127,127,.38) transparent;
        }
        .emby-scroll::-webkit-scrollbar { width: 4px; }
        .emby-scroll::-webkit-scrollbar-thumb { background: rgba(127,127,127,.38); border-radius: 2px; }
        .emby-scroll::-webkit-scrollbar-track { background: transparent; }
        .emby-row::-webkit-scrollbar,
        .emby-chips::-webkit-scrollbar { display: none; }
        .emby-content { padding: 12px 14px 16px; }
        .emby-section + .emby-section { margin-top: 15px; }
        .emby-active-server {
          display: flex;
          align-items: center;
          gap: 6px;
          width: 100%;
          margin: 0 0 12px;
          padding: 5px 8px;
          border: 0;
          border-radius: 8px;
          color: var(--hg-header-color, var(--color-token-text-tertiary, rgba(26,28,31,.6)));
          background: var(--hg-hover-bg, rgba(127,127,127,.10));
          cursor: pointer;
          font-size: 11px;
          line-height: 15px;
        }
        .emby-active-server svg { width: 14px; height: 14px; flex: 0 0 auto; fill: none; stroke: currentColor; stroke-width: 1.5; }
        .emby-active-server-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .emby-active-server:hover, .emby-active-server:focus-visible { outline: none; background: var(--hg-hover-bg, rgba(127,127,127,.16)); }
        .emby-section-title {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin: 0 0 7px;
          font-size: 12px;
          font-weight: 650;
          line-height: 16px;
        }
        .emby-muted {
          color: var(--hg-header-color, var(--color-token-text-tertiary, rgba(26,28,31,.55)));
        }
        .emby-empty {
          display: grid;
          min-height: 76px;
          place-items: center;
          padding: 14px;
          border: .5px dashed var(--hg-divider, var(--color-token-border-default, rgba(26,28,31,.12)));
          border-radius: 13px;
          color: var(--hg-header-color, var(--color-token-text-tertiary, rgba(26,28,31,.55)));
          font-size: 12px;
          text-align: center;
        }
        .emby-hero {
          position: relative;
          width: 100%;
          height: 116px;
          overflow: hidden;
          padding: 0;
          border-radius: 14px;
          color: #fff;
          background: linear-gradient(135deg, #2c3440, #101318);
          text-align: left;
        }
        .emby-hero img,
        .emby-series-visual img {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          object-fit: cover;
        }
        .emby-hero::after,
        .emby-series-visual::after {
          content: "";
          position: absolute;
          inset: 0;
          background: linear-gradient(0deg, rgba(3,5,8,.88), rgba(3,5,8,.08) 75%);
        }
        .emby-hero-copy {
          position: absolute;
          z-index: 1;
          right: 10px;
          bottom: 9px;
          left: 10px;
        }
        .emby-hero-name {
          display: block;
          overflow: hidden;
          font-size: 13px;
          font-weight: 650;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .emby-progress {
          height: 3px;
          overflow: hidden;
          margin-top: 6px;
          border-radius: 999px;
          background: rgba(255,255,255,.28);
        }
        .emby-progress > span {
          display: block;
          height: 100%;
          border-radius: inherit;
          background: #52b7ff;
        }
        .emby-row,
        .emby-chips {
          display: flex;
          gap: 8px;
          overflow-x: auto;
          overflow-y: hidden;
          padding-bottom: 2px;
          scrollbar-width: none;
        }
        .emby-library-grid {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 12px 8px;
          padding: 12px 14px 16px;
          align-content: start;
        }
        .emby-library-grid .emby-poster-button,
        .emby-library-grid .emby-poster {
          width: 100%;
          min-width: 0;
        }
        .emby-library-grid .emby-poster { aspect-ratio: 2 / 3; height: auto; }
        .emby-library-grid .emby-empty { grid-column: 1 / -1; }
        .emby-load-more { grid-column: 1 / -1; width: 100%; }
        .emby-server-list { padding: 10px 12px 14px; }
        .emby-server-list .emby-list-button[aria-current="true"] {
          background: var(--hg-hover-bg, rgba(127,127,127,.10));
        }
        .emby-server-dot {
          width: 9px;
          height: 9px;
          flex: 0 0 auto;
          border-radius: 50%;
          background: rgba(127,127,127,.35);
        }
        .emby-server-dot.connected { background: #36a269; }
        .emby-server-actions { display: grid; gap: 8px; padding: 0 12px 14px; }
        .emby-poster-button {
          width: 72px;
          min-width: 72px;
          padding: 0;
          border-radius: 10px;
          background: transparent;
          text-align: left;
        }
        .emby-poster {
          position: relative;
          width: 72px;
          height: 104px;
          overflow: hidden;
          border-radius: 9px;
          background: linear-gradient(145deg, #445263, #20252d);
        }
        /* 无封面条目（文件夹/合集）的兜底图标，叠在渐变底上 */
        .emby-poster-fallback {
          position: absolute;
          inset: 0;
          display: grid;
          place-items: center;
          color: rgba(255,255,255,.62);
        }
        .emby-poster-fallback svg {
          width: 26px;
          height: 26px;
          fill: none;
          stroke: currentColor;
          stroke-linecap: round;
          stroke-linejoin: round;
          stroke-width: 1.5;
        }
        .emby-poster img,
        .emby-list-poster img {
          display: block;
          width: 100%;
          height: 100%;
          object-fit: cover;
          opacity: 0;
          transition: opacity 120ms ease-out;
        }
        .emby-poster img[data-image-state="loaded"],
        .emby-list-poster img[data-image-state="loaded"] { opacity: 1; }
        .emby-poster-name {
          display: block;
          overflow: hidden;
          margin-top: 4px;
          font-size: 11px;
          line-height: 15px;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .emby-badge {
          position: absolute;
          right: 4px;
          bottom: 4px;
          padding: 0 4px;
          border-radius: 5px;
          color: #fff;
          background: rgba(0,0,0,.7);
          font-size: 9px;
          line-height: 14px;
        }
        .emby-login,
        .emby-center {
          min-height: 100%;
          display: flex;
          flex-direction: column;
          /* safe center：内容超过固定 400px 卡片高度时改为顶部对齐并可滚动，避免上下裁切 */
          justify-content: safe center;
          overflow-y: auto;
          padding: 20px;
        }
        .emby-brand {
          display: flex;
          align-items: center;
          gap: 9px;
          margin-bottom: 16px;
        }
        .emby-mark {
          width: 31px;
          height: 31px;
          display: grid;
          place-items: center;
          border-radius: 10px;
          color: #fff;
          background: linear-gradient(145deg, #52b54b, #347a38);
          font-size: 13px;
          font-weight: 750;
          letter-spacing: -.04em;
        }
        .emby-brand strong { display: block; font-size: 16px; line-height: 19px; }
        .emby-brand span { display: block; font-size: 11px; line-height: 15px; }
        .emby-field {
          display: block;
          margin-top: 9px;
          color: var(--hg-header-color, var(--color-token-text-tertiary, rgba(26,28,31,.55)));
          font-size: 11px;
          line-height: 15px;
        }
        .emby-input {
          width: 100%;
          height: 34px;
          margin-top: 3px;
          padding: 0 10px;
          border: .5px solid var(--hg-divider, var(--color-token-border-default, rgba(26,28,31,.16)));
          border-radius: 10px;
          outline: none;
          color: var(--hg-panel-color, var(--color-token-text-primary, #1a1c1f));
          background: var(--hg-input-bg, rgba(127,127,127,.055));
          /* 与 .hg-search-input 统一（此前继承 14px，两处输入框字号不一致） */
          font-size: 12px;
        }
        .emby-input:focus {
          border-color: rgba(49,142,211,.72);
          box-shadow: 0 0 0 2px rgba(49,142,211,.12);
        }
        .emby-button {
          min-height: 34px;
          padding: 6px 12px;
          border-radius: 10px;
          background: var(--hg-hover-bg, rgba(127,127,127,.10));
          font-weight: 600;
        }
        .emby-button.primary {
          width: 100%;
          margin-top: 13px;
          color: #fff;
          background: #357f3a;
        }
        .emby-button.danger { color: var(--cc-danger); }
        .emby-button:disabled { cursor: default; opacity: .55; }
        .emby-inline-error {
          min-height: 16px;
          margin: 7px 0 0;
          color: var(--cc-danger);
          font-size: 11px;
          line-height: 16px;
        }
        .emby-center {
          align-items: center;
          gap: 10px;
          color: var(--hg-header-color, var(--color-token-text-tertiary, rgba(26,28,31,.55)));
          text-align: center;
        }
        .emby-spinner {
          width: 25px;
          height: 25px;
          border: 2px solid rgba(127,127,127,.2);
          border-top-color: #4ea548;
          border-radius: 50%;
          animation: emby-spin .8s linear infinite;
        }
        @keyframes emby-spin { to { transform: rotate(360deg); } }
        .emby-search-wrap {
          height: 27px;
          display: flex;
          flex: 1;
          min-width: 0;
          align-items: center;
          overflow: hidden;
          border: .5px solid var(--hg-divider, var(--color-token-border-default, rgba(26,28,31,.15)));
          border-radius: 9px;
          background: var(--hg-input-bg, rgba(127,127,127,.07));
        }
        .emby-search-wrap:focus-within {
          border-color: rgba(78,165,72,.72);
          box-shadow: 0 0 0 2px rgba(78,165,72,.10);
        }
        .emby-search-input {
          min-width: 0;
          height: 100%;
          flex: 1;
          padding: 0 9px;
          border: 0;
          outline: none;
          color: inherit;
          background: transparent;
          font-size: 12px;
        }
        .emby-search-submit {
          width: 31px;
          height: 100%;
          border-radius: 0;
        }
        .emby-search-status {
          min-height: 29px;
          padding: 7px 12px 4px;
          font-size: 11px;
        }
        .emby-results,
        .emby-episodes {
          display: flex;
          flex-direction: column;
          gap: 2px;
          padding: 0 7px 12px;
        }
        .emby-list-button {
          width: 100%;
          min-height: 84px;
          display: flex;
          align-items: center;
          gap: 9px;
          padding: 6px;
          border-radius: 11px;
          background: transparent;
          text-align: left;
        }
        .emby-list-poster {
          width: 48px;
          height: 72px;
          display: grid;
          flex: 0 0 auto;
          place-items: center;
          overflow: hidden;
          border-radius: 7px;
          color: rgba(255,255,255,.72);
          background: linear-gradient(145deg, #445263, #20252d);
          font-size: 10px;
        }
        .emby-list-copy { min-width: 0; flex: 1; }
        .emby-list-name {
          display: block;
          overflow: hidden;
          font-size: 12px;
          line-height: 17px;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .emby-list-meta {
          display: block;
          overflow: hidden;
          margin-top: 2px;
          color: var(--hg-header-color, var(--color-token-text-tertiary, rgba(26,28,31,.55)));
          font-size: 10px;
          line-height: 15px;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .emby-series-visual {
          position: relative;
          /* 300×78 ≈ 3.85:1 对 16:9 backdrop 裁到只剩中间一条色带；加高到 104
             并上移取景（backdrop 主体多在 center 偏上） */
          height: 104px;
          min-height: 104px;
          overflow: hidden;
          color: #fff;
          background: linear-gradient(145deg, #334151, #11161d);
        }
        .emby-series-visual img { object-position: center 30%; }
        .emby-series-title {
          position: absolute;
          z-index: 1;
          right: 14px;
          bottom: 8px;
          left: 14px;
          overflow: hidden;
          font-size: 14px;
          font-weight: 650;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .emby-chips { padding: 8px 14px 6px; }
        .emby-chip {
          min-width: max-content;
          padding: 3px 9px;
          border-radius: 999px;
          color: var(--hg-header-color, var(--color-token-text-tertiary, rgba(26,28,31,.65)));
          background: var(--hg-hover-bg, rgba(127,127,127,.08));
          font-size: 10px;
          line-height: 18px;
        }
        .emby-chip[aria-selected="true"] {
          color: #fff;
          background: #357f3a;
        }
        .emby-source-chips { padding-top: 2px; }
        .emby-source-chip[aria-selected="true"] { background: #2f6fb0; }
        .emby-episode-button { min-height: 51px; }
        .emby-episode-index {
          width: 25px;
          flex: 0 0 auto;
          color: var(--hg-header-color, var(--color-token-text-tertiary, rgba(26,28,31,.55)));
          font-size: 10px;
          text-align: center;
        }
        .emby-episode-progress {
          width: 54px;
          height: 3px;
          overflow: hidden;
          margin-top: 5px;
          border-radius: 999px;
          background: rgba(127,127,127,.16);
        }
        .emby-episode-progress span {
          display: block;
          height: 100%;
          background: #52a94b;
        }
        .emby-playback {
          position: relative;
          width: 100%;
          height: 100%;
          overflow: hidden;
          outline: none;
          background: #000;
        }
        .emby-video,
        .emby-video-frame {
          display: block;
          width: 100%;
          height: 100%;
          background: #000;
        }
        .emby-video { object-fit: contain; }
        .emby-video-frame { border: 0; }
        .emby-video::cue {
          color: #fff;
          background: rgba(0,0,0,.72);
          font-family: var(--hg-font-family, -apple-system, system-ui, sans-serif);
          font-size: 16px;
          text-shadow: 0 1px 2px #000, 0 0 2px #000;
        }
        .emby-video::-webkit-media-controls-toggle-closed-captions-button {
          display: none;
        }
        /* 原生全屏只会带上 <video>，自定义 chrome（返回/标题/字幕/选集）会丢失；
           统一藏掉原生全屏按钮，走 chrome 里的容器全屏（makeFullscreenButton）。 */
        .hg-video::-webkit-media-controls-fullscreen-button,
        .emby-video::-webkit-media-controls-fullscreen-button {
          display: none;
        }
        /* 全屏后 cue 字号随视口放大；卡片内保持 16px（见 .emby-video::cue）。 */
        .emby-playback:fullscreen .emby-video::cue {
          font-size: min(4.5vh, 44px);
        }
        /* 全屏下鼠标静止 2.5s 后隐藏自定义 chrome 与光标（对齐原生 controls 行为）。 */
        .hg-playback:fullscreen[data-mouse-idle="true"],
        .emby-playback:fullscreen[data-mouse-idle="true"] {
          cursor: none;
        }
        .hg-playback:fullscreen[data-mouse-idle="true"] .hg-playback-chrome,
        .emby-playback:fullscreen[data-mouse-idle="true"] .emby-playback-chrome,
        .emby-playback:fullscreen[data-mouse-idle="true"] .emby-playback-episode-nav {
          opacity: 0;
          pointer-events: none;
        }
        .emby-playback-chrome {
          position: absolute;
          z-index: 3;
          top: 0;
          right: 0;
          left: 0;
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 9px;
          color: #fff;
          background: linear-gradient(rgba(0,0,0,.68), transparent);
          opacity: 0;
          pointer-events: none;
          transition: opacity 120ms ease-out;
        }
        .emby-playback:hover .emby-playback-chrome,
        .emby-playback:focus .emby-playback-chrome,
        .emby-playback:focus-within .emby-playback-chrome,
        .emby-playback[data-episode-picker-open="true"] .emby-playback-chrome {
          opacity: 1;
          pointer-events: auto;
        }
        /* 暂停时常显：用 JS 同步的 data-paused（play/pause 事件），不用 :has()/:paused ——
           若 renderer 不支持其中任一伪类，拼进上面的选择器列表会让整条规则作废，
           hover 也救不回来（线上实测如此：导航条在、chrome 消失）。独立规则保证
           即使将来某伪类失效也只影响这一条。 */
        .emby-playback[data-paused="true"] .emby-playback-chrome {
          opacity: 1;
          pointer-events: auto;
        }
        .emby-playback-back {
          color: #fff;
          background: rgba(0,0,0,.45);
          backdrop-filter: blur(8px);
        }
        .emby-playback-title {
          min-width: 0;
          flex: 1;
          overflow: hidden;
          font-size: 12px;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .emby-playback-quality {
          flex: 0 0 auto;
          padding: 1px 6px;
          border-radius: 5px;
          color: rgba(255,255,255,.85);
          background: rgba(255,255,255,.16);
          font-size: 10px;
          line-height: 15px;
          white-space: nowrap;
        }
        .emby-playback-episode-nav {
          position: absolute;
          z-index: 3;
          top: 48px;
          right: 9px;
          left: 9px;
          display: grid;
          grid-template-columns: 72px minmax(0, 1fr) 72px;
          gap: 6px;
          opacity: 0;
          pointer-events: none;
          transition: opacity 120ms ease-out;
        }
        .emby-playback:hover .emby-playback-episode-nav,
        .emby-playback:focus .emby-playback-episode-nav,
        .emby-playback:focus-within .emby-playback-episode-nav,
        .emby-playback[data-episode-picker-open="true"] .emby-playback-episode-nav {
          opacity: 1;
          pointer-events: auto;
        }
        .emby-episode-nav-button {
          height: 30px;
          min-width: 0;
          padding: 0 8px;
          overflow: hidden;
          border: .5px solid rgba(255,255,255,.14);
          border-radius: 9px;
          color: #fff;
          background: rgba(0,0,0,.54);
          font-size: 10px;
          line-height: 29px;
          text-overflow: ellipsis;
          white-space: nowrap;
          backdrop-filter: blur(10px);
        }
        .emby-episode-nav-button:hover,
        .emby-episode-nav-button:focus-visible,
        .emby-episode-nav-button[aria-expanded="true"] {
          background: rgba(255,255,255,.18);
        }
        .emby-episode-nav-button:disabled {
          cursor: default;
          opacity: .42;
        }
        .emby-episode-picker {
          position: absolute;
          z-index: 6;
          top: 84px;
          right: 9px;
          bottom: 48px;
          left: 9px;
          display: flex;
          min-height: 0;
          flex-direction: column;
          overflow: hidden;
          border: .5px solid rgba(255,255,255,.18);
          border-radius: 13px;
          color: #fff;
          background: rgba(20,20,22,.95);
          box-shadow: 0 12px 34px rgba(0,0,0,.34);
          backdrop-filter: blur(20px);
        }
        .emby-episode-picker[hidden] { display: none; }
        .emby-episode-picker-header {
          display: flex;
          align-items: center;
          gap: 5px;
          min-height: 41px;
          padding: 7px 8px;
          overflow-x: auto;
          border-bottom: .5px solid rgba(255,255,255,.12);
          scrollbar-width: none;
        }
        .emby-episode-picker-header::-webkit-scrollbar { display: none; }
        .emby-episode-season {
          flex: 0 0 auto;
          min-height: 26px;
          padding: 3px 9px;
          border-radius: 999px;
          color: rgba(255,255,255,.7);
          background: rgba(255,255,255,.08);
          font-size: 10px;
        }
        .emby-episode-season[aria-selected="true"] {
          color: #fff;
          background: #357f3a;
        }
        .emby-episode-picker-grid {
          display: grid;
          min-height: 0;
          flex: 1;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          align-content: start;
          gap: 6px;
          overflow-y: auto;
          padding: 8px;
        }
        .emby-episode-picker-item {
          min-width: 0;
          min-height: 36px;
          padding: 5px 4px;
          overflow: hidden;
          border-radius: 9px;
          color: rgba(255,255,255,.82);
          background: rgba(255,255,255,.08);
          font-size: 10px;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .emby-episode-picker-item:hover,
        .emby-episode-picker-item:focus-visible { background: rgba(255,255,255,.15); }
        .emby-episode-picker-item[aria-current="true"] {
          color: #fff;
          background: #357f3a;
        }
        .emby-episode-picker-empty {
          grid-column: 1 / -1;
          padding: 28px 8px;
          color: rgba(255,255,255,.58);
          font-size: 11px;
          text-align: center;
        }
        .emby-subtitle-button {
          min-width: 27px;
          width: 27px;
          padding: 0;
          border-radius: 9px;
          color: #fff;
          background: rgba(0,0,0,.45);
          backdrop-filter: blur(8px);
        }
        .emby-subtitle-button svg { width: 15px; height: 15px; }
        .emby-subtitle-menu {
          position: absolute;
          z-index: 5;
          top: 40px;
          right: 9px;
          width: min(190px, calc(100% - 18px));
          max-height: 248px;
          overflow-y: auto;
          padding: 4px;
          border: 0;
          border-radius: 9px;
          color: #fff;
          background: rgba(24,24,26,.92);
          box-shadow: 0 8px 24px rgba(0,0,0,.24);
          backdrop-filter: blur(14px);
        }
        .emby-subtitle-menu[hidden] { display: none; }
        .emby-subtitle-option {
          width: 100%;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          min-height: 32px;
          padding: 7px 9px;
          border: 0;
          border-radius: 6px;
          color: inherit;
          background: transparent;
          font-size: 11px;
          line-height: 15px;
          text-align: left;
        }
        .emby-subtitle-option:hover,
        .emby-subtitle-option:focus-visible {
          outline: none;
          background: rgba(255,255,255,.08);
        }
        .emby-subtitle-option[aria-checked="true"] { background: rgba(255,255,255,.11); }
        /* 长字幕名（如 "Chinese Simplified · 外挂 · 听障"）在 190px 菜单里截断，
           不换行挤压 meta */
        .emby-subtitle-option > span:first-child {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .emby-subtitle-meta {
          flex: 0 0 auto;
          color: rgba(255,255,255,.58);
          font-size: 10px;
        }
        .emby-subtitle-status {
          position: absolute;
          z-index: 4;
          top: 88px;
          right: 12px;
          bottom: auto;
          left: 12px;
          padding: 8px 10px;
          border-radius: 9px;
          color: #fff;
          background: rgba(0,0,0,.72);
          font-size: 10px;
          line-height: 15px;
          text-align: center;
          backdrop-filter: blur(10px);
        }
        .emby-subtitle-status[hidden] { display: none; }
        .emby-ended {
          position: absolute;
          z-index: 2;
          inset: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          padding: 20px;
          background: rgba(0,0,0,.72);
        }
        .emby-ended[hidden] { display: none; }
        .emby-ended .emby-button { color: #fff; background: rgba(255,255,255,.17); }
        .emby-error-title { color: var(--hg-panel-color, currentColor); font-weight: 650; }
        .emby-error-actions { display: flex; gap: 8px; }
      </style>

      <section class="panel hg-panel" data-card="hongguo" aria-label="红果短剧播放器"${cards.hongguo ? "" : " hidden"}>
        <div class="hg-app" aria-live="polite"></div>
      </section>

      <section class="panel emby-card" data-card="emby" aria-label="Emby 媒体库"${cards.emby ? "" : " hidden"}>
        <div class="emby-app" aria-live="polite"></div>
      </section>
    `;

    // 按配置顺序重排两张卡片（append 同名元素即移动到末尾，依次 append 得到目标顺序）。
    for (const cardId of cardOrder) {
      const section = shadow.querySelector(`[data-card="${cardId}"]`);
      if (section) shadow.append(section);
    }

    // ===== DOM references and shared state =====
    const hongguoApp = shadow.querySelector(".hg-app");
    const embyApp = shadow.querySelector(".emby-app");
    // ===== Shared layout logic =====
    let objectUrl = null;
    let disposed = false;
    let placementMode = "pending";
    let placementQueued = false;
    let panelHiddenTimer = null;
    let handlePanelHidden = () => {};
    let refreshHongguoImages = () => {};
    let refreshEmbyImages = () => {};
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
        managedAnimationColumn.removeAttribute("data-codex-companion-animation-column");
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
      column.dataset.codexCompanionAnimationColumn = "true";
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
        managedScrollRoot.removeAttribute("data-codex-companion-scroll-root");
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
      scrollRoot.dataset.codexCompanionScrollRoot = summary.mode;
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
        scrollRoot.style.setProperty("height", "100%", "important");
        scrollRoot.style.setProperty("min-height", "0", "important");
        scrollRoot.style.setProperty("max-height", "100%", "important");
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
        const hasStrongSignal = labelMatch || (kind === "popover" && controlsDialog);
        if (hasStrongSignal && score > bestScore) {
          bestScore = score;
          best = button;
        }
      }
      return best;
    };

    const findSummaryPopover = () => {
      // Side Panel 打开时，Summary 会迁移到 aria-controls 指向的 Radix dialog。
      const trigger = findSummaryToggle("popover");
      if (!trigger || trigger.getAttribute("data-state") !== "open") return null;
      const controlledId = trigger.getAttribute("aria-controls");
      const popover = controlledId ? document.getElementById(controlledId) : null;
      if (!popover || popover.getAttribute("role") !== "dialog" || popover.getAttribute("data-state") !== "open") return null;
      const nativePanel = Array.from(popover.querySelectorAll("div")).find((element) => {
        const className = typeof element.className === "string" ? element.className : "";
        return className.includes("rounded-3xl") && className.includes("bg-token-dropdown-background");
      }) ?? null;
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
      const nativePanel = Array.from(nativeColumn.querySelectorAll("div")).find((element) => {
        const className = typeof element.className === "string" ? element.className : "";
        return className.includes("rounded-3xl") && className.includes("bg-token-dropdown-background");
      });
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
      host.style.setProperty(name, value);
    };

    const syncNativeStyles = (nativeColumn) => {
      const rootStyle = getComputedStyle(document.documentElement);
      const nativePanel = nativeColumn
        ? Array.from(nativeColumn.querySelectorAll("div")).find((element) => {
            const className = typeof element.className === "string" ? element.className : "";
            return className.includes("rounded-3xl") && className.includes("bg-token-dropdown-background");
          })
        : null;
      const nativeHeader = nativePanel?.querySelector("header");
      const nativeSection = nativePanel?.querySelector("section");
      const panelStyle = nativePanel ? getComputedStyle(nativePanel) : null;
      const headerStyle = nativeHeader ? getComputedStyle(nativeHeader) : null;
      const dividerStyle = nativeSection ? getComputedStyle(nativeSection, "::after") : null;

      setHostVariable("--hg-panel-bg", panelStyle?.backgroundColor || rootStyle.getPropertyValue("--color-token-dropdown-background").trim());
      setHostVariable("--hg-panel-color", panelStyle?.color || rootStyle.getPropertyValue("--color-token-text-primary").trim());
      setHostVariable("--hg-panel-radius", panelStyle?.borderRadius || "25px");
      setHostVariable("--hg-panel-shadow",
        panelStyle?.boxShadow && panelStyle.boxShadow !== "none"
          ? panelStyle.boxShadow
          : "0 0 0 .5px var(--color-token-border-heavy, rgba(26, 28, 31, .117)), 0 3px 7.5px rgba(0, 0, 0, .04), 0 0 20px rgba(0, 0, 0, .05)");
      setHostVariable("--hg-header-bg", headerStyle?.backgroundColor || rootStyle.getPropertyValue("--color-token-dropdown-background").trim());
      setHostVariable("--hg-header-color", headerStyle?.color || rootStyle.getPropertyValue("--color-token-text-tertiary").trim());
      setHostVariable("--hg-divider", dividerStyle?.backgroundColor || rootStyle.getPropertyValue("--color-token-border-default").trim());
      setHostVariable("--hg-font-family", panelStyle?.fontFamily || "-apple-system, system-ui, \"Segoe UI\", sans-serif");
      setHostVariable("--hg-font-weight", panelStyle?.fontWeight || "445");
    };

    const createRail = (summary) => {
      const rail = document.createElement("div");
      rail.id = railId;
      rail.dataset.mode = summary.mode;
      rail.setAttribute("aria-label", "红果短剧与 Emby 侧栏");
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

    // ===== standalone 模式：并排「卡片按钮」+ 与原生 Toggle Summary 互斥 =====
    // panelIntent="cards" 表示用户希望右栏显示我们的卡片；此时隐藏原生 summary 内容。
    // 我们只驱动原生按钮的 click（可靠）来复用原生开合动画，从不拦截它的 React 行为。
    const standalone = placement === "standalone-button";
    const buttonId = `${hostId}-toggle`;
    const fallbackButtonId = `${hostId}-toggle-fallback`;
    const COMPANION_BUTTON_FALLBACK_AFTER = 3;
    let companionButtonMisses = 0;       // 连续找不到原生工具栏锚点的次数，达到阈值挂悬浮兜底按钮
    let panelIntent = null;              // null | "cards"
    let drivingNativeTrigger = false;    // 我们正在程序化点击原生 trigger 借面板开合
    let lastNativeOpen = false;          // 上一轮观察到的原生面板开合态，用于检测 open→closed 跳变
    let managedNativeContent = null;     // 被我们临时隐藏的原生面板内容元素
    let managedNativeContentDisplay = "";

    const hideNativeContent = (nativePanel) => {
      // 隐藏原生 summary 面板的直接内容（保留面板容器本身以复用其尺寸/动画）。
      if (!nativePanel) return;
      if (managedNativeContent && managedNativeContent !== nativePanel) showNativeContent();
      if (managedNativeContent === nativePanel) return;
      managedNativeContent = nativePanel;
      managedNativeContentDisplay = nativePanel.style.getPropertyValue("display");
      nativePanel.style.setProperty("display", "none", "important");
    };
    const showNativeContent = () => {
      if (!managedNativeContent) return;
      if (managedNativeContentDisplay) managedNativeContent.style.setProperty("display", managedNativeContentDisplay);
      else managedNativeContent.style.removeProperty("display");
      managedNativeContent = null;
      managedNativeContentDisplay = "";
    };

    // cards 模式下卡片占用了原生面板，原生 trigger 会因面板 open 而显示激活底色。
    // 用一个标记属性 + 文档级 <style> 把它的背景压成透明，只在 cards 占用期间生效；
    // 用户自己打开 summary 时不加标记，原生高亮照常。
    const triggerHighlightStyleId = `${hostId}-trigger-style`;
    const triggerHighlightAttr = "data-codex-companion-suppress-highlight";
    let managedHighlightTrigger = null;
    const ensureTriggerHighlightStyle = () => {
      if (document.getElementById(triggerHighlightStyleId)) return;
      const style = document.createElement("style");
      style.id = triggerHighlightStyleId;
      style.textContent = `button[${triggerHighlightAttr}]{background-color:transparent !important;color:var(--color-token-text-tertiary, rgba(255,255,255,.5)) !important;}`;
      document.head.appendChild(style);
    };
    const suppressTriggerHighlight = (trigger) => {
      if (!trigger) return;
      ensureTriggerHighlightStyle();
      if (managedHighlightTrigger && managedHighlightTrigger !== trigger) restoreTriggerHighlight();
      if (managedHighlightTrigger === trigger) return;
      managedHighlightTrigger = trigger;
      trigger.setAttribute(triggerHighlightAttr, "");
    };
    const restoreTriggerHighlight = () => {
      managedHighlightTrigger?.removeAttribute(triggerHighlightAttr);
      managedHighlightTrigger = null;
    };

    const nativePanelTrigger = () =>
      (findSummaryPopover() ?? findFloatingSummary())?.trigger
        ?? findSummaryToggle("pinned") ?? findSummaryToggle("popover");

    // 页级按钮（不在 shadow 内）的兜底色：Codex token 失效时必须跟随主题，否则浅色
    // 主题下得到"浅灰底 + 近白图标"的不可读按钮。优先实测原生按钮的计算颜色
    // （与 syncNativeStyles 同源），测不到再按 prefers-color-scheme 取浅/深色对。
    const measureNativeButtonColor = () => {
      const trigger = nativePanelTrigger();
      if (!trigger) return null;
      const color = getComputedStyle(trigger).color;
      return color && color !== "rgba(0, 0, 0, 0)" && color !== "transparent" ? color : null;
    };
    const themeFallbackColor = (role) => {
      const dark = typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
      if (role === "primary") return dark ? "#ececec" : "#1a1c1f";
      return dark ? "rgba(255,255,255,.5)" : "rgba(26,28,31,.58)";
    };

    // 我们的按钮视觉：idle 与原生按钮未激活态一致（透明底 + tertiary 图标色），
    // 仅当卡片打开（panelIntent==="cards"）时高亮（primary 图标色 + 轻底色）。
    const applyCompanionButtonVisual = (button) => {
      const active = panelIntent === "cards";
      const measured = measureNativeButtonColor();
      const color = active
        ? `var(--color-token-text-primary, ${measured ?? themeFallbackColor("primary")})`
        : `var(--color-token-text-tertiary, ${measured ?? themeFallbackColor("tertiary")})`;
      const bg = active
        ? "var(--color-token-foreground-5, rgba(127,127,127,.16))"
        : "transparent";
      button.style.setProperty("color", color, "important");
      button.style.setProperty("background-color", bg, "important");
    };

    const updateCompanionButtonState = () => {
      const button = document.getElementById(buttonId);
      if (!button) return;
      // 只在值变化时写属性：aria-pressed 在 observer 的 attributeFilter 里，
      // 无条件 setAttribute 会触发 mutation → schedulePlacement → 无限循环。
      const next = panelIntent === "cards" ? "true" : "false";
      if (button.getAttribute("aria-pressed") !== next) button.setAttribute("aria-pressed", next);
      applyCompanionButtonVisual(button);
    };

    const onCompanionButtonClick = () => {
      const trigger = nativePanelTrigger();
      const triggerOpen = () => trigger?.getAttribute("aria-pressed") === "true"
        || trigger?.getAttribute("data-state") === "open";
      // 我们程序化点击原生 trigger 来"借"它开合面板；标记这段窗口，让 onNativeTriggerCapture
      // 不要把这次自发的点击误当成"用户想看摘要"而拦截（否则 panelIntent 刚被设成 cards 又被清空）。
      const driveTrigger = () => {
        drivingNativeTrigger = true;
        try { trigger.click(); } finally { drivingNativeTrigger = false; }
      };
      if (panelIntent === "cards") {
        // 关闭：收起面板（点原生按钮），回到都关闭状态。
        panelIntent = null;
        showNativeContent();
        if (trigger && triggerOpen()) driveTrigger();
      } else {
        // 打开卡片：确保原生面板开着（借它的动画），再把内容切成我们的。
        panelIntent = "cards";
        if (trigger && !triggerOpen()) driveTrigger();
      }
      updateCompanionButtonState();
      schedulePlacement();
    };

    // 卡片占用原生面板时，面板对 React 而言是"打开"的。此时用户点原生 Toggle Summary，
    // 本意是"看摘要"，但一次点击只会把面板关掉 → 卡片消失、摘要也没出现，得再点一次。
    // 在捕获阶段拦截这一次点击：让位给摘要（清 cards 意图、恢复原生内容），并阻止面板被关，
    // 于是单击即可原地切到摘要。仅在 standalone + 卡片正在显示时介入，其它情况一律放行。
    const onNativeTriggerCapture = (event) => {
      if (drivingNativeTrigger) return; // 我们自己驱动的 trigger.click()，放行（借面板开合）
      if (!standalone || panelIntent !== "cards") return;
      const trigger = nativePanelTrigger();
      if (!trigger || !(event.target instanceof Node) || !trigger.contains(event.target)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      panelIntent = null;
      showNativeContent();
      restoreTriggerHighlight();
      updateCompanionButtonState();
      schedulePlacement();
    };
    if (standalone) document.addEventListener("click", onNativeTriggerCapture, true);

    const ensureCompanionButton = () => {
      if (!standalone) return;
      if (document.getElementById(buttonId)) { removeFallbackButton(); return; }
      const trigger = findSummaryToggle("pinned") ?? findSummaryToggle("popover");
      // 插入点：原生按钮所在的工具栏组（span.contents → 其上 flex 容器）。
      const wrapper = trigger?.closest("span")?.parentElement ?? trigger?.parentElement;
      const group = wrapper?.parentElement;
      if (!trigger || !wrapper || !group) {
        // Codex 顶栏结构不符合预期（改版/未渲染完）。累计多次找不到后挂一个悬浮兜底按钮，
        // 保证卡片始终可唤出，而不是静默地完全不可达。
        companionButtonMisses += 1;
        if (companionButtonMisses >= COMPANION_BUTTON_FALLBACK_AFTER) ensureFallbackButton();
        return;
      }
      companionButtonMisses = 0;
      removeFallbackButton();

      const button = document.createElement("button");
      button.id = buttonId;
      button.type = "button";
      // 克隆原生按钮 class 以继承尺寸/圆角/hover/focus ring；但颜色与背景由我们按 panelIntent
      // 自己控制（不能直接继承克隆到的激活态 class，否则按钮会永久显示高亮底色+白色图标）。
      button.className = typeof trigger.className === "string" ? trigger.className : "";
      button.setAttribute("aria-label", "红果短剧与 Emby 卡片");
      button.setAttribute("title", "红果短剧与 Emby 卡片");
      // 顶栏 header 默认 pointer-events:none 且是窗口拖拽区；必须显式把按钮恢复成可点击、
      // 非拖拽，否则点击会穿透到背后的内容层（克隆 class 不保证带回这两项）。
      button.style.setProperty("pointer-events", "auto", "important");
      button.style.setProperty("-webkit-app-region", "no-drag", "important");
      const icon = makeToolbarIcon("subtitles");
      icon.setAttribute("width", "20");
      icon.setAttribute("height", "20");
      icon.setAttribute("fill", "none");
      icon.setAttribute("stroke", "currentColor");
      icon.setAttribute("stroke-width", "1.5");
      button.append(icon);
      button.addEventListener("click", (event) => {
        event.preventDefault();
        onCompanionButtonClick();
      });
      // 放在原生按钮包裹节点之前 → 视觉上位于其左侧。
      group.insertBefore(button, wrapper);
      applyCompanionButtonVisual(button);
    };

    // 悬浮兜底按钮：仅当无法把按钮注入原生工具栏时出现，固定在右上角，点击行为与工具栏按钮一致。
    const ensureFallbackButton = () => {
      if (!standalone || document.getElementById(fallbackButtonId)) return;
      const button = document.createElement("button");
      button.id = fallbackButtonId;
      button.type = "button";
      button.setAttribute("aria-label", "红果短剧与 Emby 卡片");
      button.setAttribute("title", "红果短剧与 Emby 卡片");
      button.style.cssText = [
        // top:48px 避开 Codex 原生顶栏（此前 top:10px 会盖住右上角原生按钮）；
        // z-index 高于页面内容即可，不再取近 int 上限。
        "position:fixed", "top:48px", "right:12px", "z-index:999999",
        "width:32px", "height:32px", "display:flex", "align-items:center", "justify-content:center",
        "border:0", "border-radius:8px", "cursor:pointer",
        "background:var(--color-token-foreground-5, rgba(120,120,120,.22))",
        `color:var(--color-token-text-primary, ${measureNativeButtonColor() ?? themeFallbackColor("primary")})`
      ].join(";");
      button.style.setProperty("-webkit-app-region", "no-drag", "important");
      const icon = makeToolbarIcon("subtitles");
      icon.setAttribute("width", "20");
      icon.setAttribute("height", "20");
      icon.setAttribute("fill", "none");
      icon.setAttribute("stroke", "currentColor");
      icon.setAttribute("stroke-width", "1.5");
      button.append(icon);
      button.addEventListener("click", (event) => {
        event.preventDefault();
        onCompanionButtonClick();
      });
      document.body.appendChild(button);
    };

    const removeFallbackButton = () => {
      document.getElementById(fallbackButtonId)?.remove();
    };

    const removeCompanionButton = () => {
      document.getElementById(buttonId)?.remove();
      removeFallbackButton();
    };

    const ensurePlacement = () => {
      if (disposed) return false;
      if (standalone) ensureCompanionButton();
      // 原生面板是否处于打开态：以原生 trigger 的 aria-pressed/data-state 为准（比 finder 更稳）。
      const triggerOpen = () => {
        const t = nativePanelTrigger();
        return t?.getAttribute("aria-pressed") === "true" || t?.getAttribute("data-state") === "open";
      };
      // 观察原生面板的开合跳变：一旦发生 open→closed（无论是用户点原生按钮还是我们关的），
      // 就清掉 cards 意图——这样用户"关掉再打开"原生 summary 时，卡片会正确让位。
      if (standalone) {
        const openNow = triggerOpen();
        if (lastNativeOpen && !openNow && panelIntent === "cards") {
          panelIntent = null;
          updateCompanionButtonState();
        }
        lastNativeOpen = openNow;
      }
      const summary = findSummaryPopover() ?? findFloatingSummary();
      if (!summary) {
        restorePopoverPanel();
        restoreAnimationColumn();
        restoreOuterScroller();
        showNativeContent();
        restoreTriggerHighlight();
        // SPA 路由切换时原生面板可能短暂从 DOM 消失（React 重渲染的瞬态窗口），
        // 立即停播会误杀正在播的视频。面板持续消失超过宽限期才真正停播；
        // 宽限期内面板重新出现（下方成功路径）会取消这个定时器。
        clearTimeout(panelHiddenTimer);
        panelHiddenTimer = setTimeout(() => {
          panelHiddenTimer = null;
          if (!disposed) handlePanelHidden();
        }, 800);
        syncResizeObservation();
        document.getElementById(railId)?.remove();
        placementMode = "hidden";
        return false;
      }
      clearTimeout(panelHiddenTimer);
      panelHiddenTimer = null;

      // standalone 模式：面板开着但用户没要卡片（点的是原生 summary）→ 不占用面板，恢复原生内容。
      if (standalone && panelIntent !== "cards") {
        restorePopoverPanel();
        restoreAnimationColumn();
        restoreOuterScroller();
        showNativeContent();
        restoreTriggerHighlight();
        syncResizeObservation();
        document.getElementById(railId)?.remove();
        placementMode = "native-summary";
        updateCompanionButtonState();
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
      let rail = document.getElementById(railId);
      if (rail && (rail.parentElement !== mountParent || rail.dataset.mode !== summary.mode)) {
        rail.remove();
        rail = null;
      }
      rail ??= createRail(summary);
      // standalone+cards：卡片独占面板，先隐藏原生内容再定位，避免依赖被隐藏面板的坍缩尺寸。
      if (standalone) {
        hideNativeContent(nativePanel);
        suppressTriggerHighlight(summary.trigger); // 卡片占用期间压掉原生按钮的激活底色
      } else {
        showNativeContent();
      }
      if (summary.mode === "animated-summary") {
        if (standalone) {
          // 卡片独占：原生面板已隐藏，rail 直接贴列顶（top:0），不随隐藏面板 bounds 抖动。
          if (rail.style.top !== "0px") rail.style.top = "0px";
          rail.style.removeProperty("height");
          rail.style.removeProperty("flex-basis");
        } else {
          positionAnimatedRail(rail, mountParent, nativePanel);
        }
      } else {
        rail.style.removeProperty("height");
        rail.style.removeProperty("flex-basis");
      }
      const hostWasDetached = host.parentElement !== rail;
      if (hostWasDetached) rail.append(host);
      if (hostWasDetached) refreshHongguoImages();
      if (hostWasDetached) refreshEmbyImages();
      syncNativeStyles(styleRoot);
      syncResizeObservation(mountParent, nativePanel);
      placementMode = summary.mode;
      if (standalone) updateCompanionButtonState();
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

    const releaseObjectUrl = () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    };

    const makeElement = (tag, className, text) => {
      const element = document.createElement(tag);
      if (className) element.className = className;
      if (text !== undefined && text !== null) element.textContent = String(text);
      return element;
    };

    const toolbarIconPaths = {
      back: ["M11.75 4.75 6.5 10l5.25 5.25", "M7 10h7"],
      search: ["M8.75 13a4.25 4.25 0 1 0 0-8.5 4.25 4.25 0 0 0 0 8.5Z", "m12 12 3.5 3.5"],
      servers: ["M4 5.5c0-1 2.69-1.75 6-1.75s6 .75 6 1.75-2.69 1.75-6 1.75S4 6.5 4 5.5Z", "M4 5.5v4c0 1 2.69 1.75 6 1.75s6-.75 6-1.75v-4", "M4 9.5v4c0 1 2.69 1.75 6 1.75s6-.75 6-1.75v-4"],
      logout: ["M8.25 4.5h-2.5A1.75 1.75 0 0 0 4 6.25v7.5c0 .97.78 1.75 1.75 1.75h2.5", "M10.5 6.5 14 10l-3.5 3.5", "M14 10H7.5"],
      subtitles: ["M3.75 5.25h12.5v9.5H3.75z", "M6 10.25h3", "M11 10.25h3", "M6 12.5h2", "M10 12.5h4"],
      folder: ["M4 6.5v7A1.5 1.5 0 0 0 5.5 15h9a1.5 1.5 0 0 0 1.5-1.5v-5A1.5 1.5 0 0 0 14.5 7H9.5L8 5H5.5A1.5 1.5 0 0 0 4 6.5Z"],
      film: ["M4 4.75h12v10.5H4z", "M4 8h12", "M4 12h12", "M8 4.75v10.5", "M12 4.75v10.5"],
      fullscreen: ["M8 4.5H5.75A1.25 1.25 0 0 0 4.5 5.75V8", "M12 4.5h2.25c.69 0 1.25.56 1.25 1.25V8", "M8 15.5H5.75A1.25 1.25 0 0 1 4.5 14.25V12", "M12 15.5h2.25c.69 0 1.25-.56 1.25-1.25V12"],
      fullscreenExit: ["M4.5 8h2.25c.69 0 1.25-.56 1.25-1.25V4.5", "M15.5 8h-2.25a1.25 1.25 0 0 1-1.25-1.25V4.5", "M4.5 12h2.25c.69 0 1.25.56 1.25 1.25v2.25", "M15.5 12h-2.25a1.25 1.25 0 0 0-1.25 1.25v2.25"],
      close: ["M5.5 5.5l9 9", "M14.5 5.5l-9 9"]
    };

    const makeToolbarIcon = (name) => {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 20 20");
      svg.setAttribute("aria-hidden", "true");
      svg.setAttribute("focusable", "false");
      for (const pathData of toolbarIconPaths[name] || []) {
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", pathData);
        svg.append(path);
      }
      return svg;
    };

    // 自定义全屏：对播放容器（而不是 <video> 本身）requestFullscreen，返回键/标题/
    // 字幕菜单/选集导航这些 chrome 是 video 的兄弟节点，原生全屏只会带上 video，
    // 全屏后它们全部消失。原生 controls 的全屏按钮已在 CSS 隐藏，统一走这里。
    const makeFullscreenButton = (view, className) => {
      const button = makeElement("button", className);
      button.type = "button";
      const sync = () => {
        const isFullscreen = view.matches(":fullscreen");
        button.replaceChildren(makeToolbarIcon(isFullscreen ? "fullscreenExit" : "fullscreen"));
        const label = isFullscreen ? "退出全屏" : "全屏";
        button.title = label;
        button.setAttribute("aria-label", label);
        button.setAttribute("aria-pressed", String(isFullscreen));
        if (!isFullscreen) delete view.dataset.mouseIdle;
      };
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (view.matches(":fullscreen")) {
          Promise.resolve(document.exitFullscreen()).catch(() => {});
        } else {
          Promise.resolve(view.requestFullscreen()).catch(() => {});
        }
      });
      // 全屏下鼠标静止时隐藏 chrome 与光标（原生 controls 本来就会自动隐藏，
      // 自定义 chrome 不跟着藏的话看电影时顶栏常驻）。mousemove 在非全屏下无视觉影响。
      let idleTimer = null;
      view.addEventListener("mousemove", () => {
        delete view.dataset.mouseIdle;
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => { view.dataset.mouseIdle = "true"; }, 2_500);
      });
      // fullscreenchange 以 view 为目标派发，监听器随 view 回收，无需手动清理。
      view.addEventListener("fullscreenchange", sync);
      sync();
      return button;
    };

    // 工具栏图标辅助（makeToolbarIcon）已定义，现在才安全启动放置逻辑：
    // ensurePlacement → ensureCompanionButton 会用到 makeToolbarIcon，必须在其之后调用。
    // runPlacement 会在结束时自行 observe，因此这里不需要预先 observe。
    runPlacement();

    const embyState = {
      view: "loading",
      connected: false,
      config: { baseUrl: "", username: "", serverId: "", userId: "" },
      loadingLabel: "正在检查 Emby 连接…",
      inlineError: "",
      home: { views: [], resume: [], latest: [] },
      servers: [],
      addingServer: false,
      pendingServerInput: "",
      pendingUsernameInput: "",
      libraryStack: [],
      libraryItems: [],
      libraryTotal: 0,
      libraryLoadingMore: false,
      searchQuery: "",
      searchItems: [],
      searching: false,
      searchReturnView: "home",
      seriesItem: null,
      seriesReturnView: "home",
      seasons: [],
      selectedSeasonId: null,
      episodes: [],
      sourceOptions: [],
      playback: null,
      previousRoute: null,
      error: null,
      retry: null,
      scrollPositions: new Map()
    };
    let nextRpcId = 1;
    const pendingRpc = new Map();
    let searchTimer = null;
    let searchGeneration = 0;
    let searchRequestId = null;
    let progressTimer = null;
    let volumeReportTimer = null;
    let activeHls = null;
    let activeDirectPlayer = null;
    let lastMseDiagnostics = null;
    let playbackStopping = false;
    let workerFallbackReported = false;
    let subtitleRequestId = null;
    let subtitleObjectUrl = null;
    let subtitlePreference = null;
    let subtitleSwitching = false;
    // 按 seriesId 记住用户选中的源（sourceKey），会话级，退出 Codex 不保留（与字幕偏好一致）。
    const sourcePreferences = new Map();
    let episodeContextRequestId = null;
    const imageCache = new Map();
    const imageLoads = new Map();
    const imageRequests = new Set();
    const imageLoadQueue = [];
    let imageCacheBytes = 0;
    let activeImageLoads = 0;
    let imageLoadGeneration = 0;
    const MAX_IMAGE_COUNT = 50;
    const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
    const MAX_CONCURRENT_IMAGE_LOADS = 4;

    const rpcError = (code, message, retryable = false) => {
      const error = new Error(message || "Emby 请求失败");
      error.code = code || "RPC_ERROR";
      error.retryable = Boolean(retryable);
      return error;
    };

    const toRpcError = (value) => {
      if (value instanceof Error) return value;
      if (value && typeof value === "object") {
        return rpcError(value.code, value.message, value.retryable);
      }
      return rpcError("RPC_ERROR", String(value || "Emby 请求失败"));
    };

    const receiveRpc = (rawResponse) => {
      let response = rawResponse;
      if (typeof response === "string") {
        try {
          response = JSON.parse(response);
        } catch {
          return false;
        }
      }
      if (!response || typeof response !== "object" || typeof response.id !== "string") return false;
      const pending = pendingRpc.get(response.id);
      if (!pending) return false;
      pendingRpc.delete(response.id);
      clearTimeout(pending.timeout);
      pending.signal?.removeEventListener("abort", pending.onAbort);
      if (response.ok === false) pending.reject(toRpcError(response.error));
      else pending.resolve(response.result);
      return true;
    };

    const notifyRpcCancellation = (requestId) => {
      const binding = globalThis[rpcBinding];
      if (typeof binding !== "function") return false;
      try {
        const id = `emby-cancel-${Date.now().toString(36)}-${nextRpcId++}`;
        binding(JSON.stringify({ id, method: "rpc.cancel", params: { requestId } }));
        return true;
      } catch {
        return false;
      }
    };

    const requestRpc = (method, params = {}, options = {}) => {
      const id = `codex-companion-${Date.now().toString(36)}-${nextRpcId++}`;
      let settled = false;
      const promise = new Promise((resolve, reject) => {
        let timeout = null;
        const finishReject = (error) => {
          if (settled) return;
          settled = true;
          pendingRpc.delete(id);
          if (timeout) clearTimeout(timeout);
          options.signal?.removeEventListener("abort", onAbort);
          reject(error);
        };
        const onAbort = () => {
          notifyRpcCancellation(id);
          finishReject(rpcError("ABORTED", "请求已取消", true));
        };
        timeout = setTimeout(() => {
          notifyRpcCancellation(id);
          finishReject(rpcError("RPC_TIMEOUT", `${method} 请求超时`, true));
        }, options.timeoutMs ?? 15_000);
        pendingRpc.set(id, {
          method,
          signal: options.signal,
          onAbort,
          timeout,
          resolve: (result) => {
            if (settled) return;
            settled = true;
            resolve(result);
          },
          reject: finishReject
        });
        if (options.signal?.aborted) {
          clearTimeout(timeout);
          onAbort();
          return;
        }
        options.signal?.addEventListener("abort", onAbort, { once: true });

        const binding = globalThis[rpcBinding];
        if (typeof binding !== "function") {
          clearTimeout(timeout);
          finishReject(rpcError("BRIDGE_UNAVAILABLE", "codex-companion 后端尚未连接", true));
          return;
        }
        try {
          const directResult = binding(JSON.stringify({ id, method, params }));
          if (directResult && typeof directResult.then === "function") {
            directResult.then(
              (result) => receiveRpc({ id, ok: true, result }),
              (error) => receiveRpc({
                id,
                ok: false,
                error: { code: error?.code, message: error?.message || String(error), retryable: error?.retryable }
              })
            );
          } else if (directResult !== undefined) {
            receiveRpc({ id, ok: true, result: directResult });
          }
        } catch (error) {
          clearTimeout(timeout);
          finishReject(toRpcError(error));
        }
      });
      return { id, promise };
    };

    const rpc = (method, params = {}, options = {}) => requestRpc(method, params, options).promise;

    const cancelRpc = (requestId, notifyBackend = true) => {
      const pending = pendingRpc.get(requestId);
      if (pending) pending.reject(rpcError("ABORTED", "请求已取消", true));
      if (notifyBackend) notifyRpcCancellation(requestId);
    };

    // 优先用原生 Uint8Array.fromBase64（Baseline 2025，新 Chromium 有）：ffmpeg 路径
    // 每批最多 6MB，atob 后逐字符 charCodeAt 在主线程要跑几十万次循环；原生实现
    // 快一个数量级。旧 Renderer 回退到 atob + 逐字符拷贝。
    const decodeBase64 = typeof Uint8Array.fromBase64 === "function"
      ? (data) => Uint8Array.fromBase64(String(data || ""))
      : (data) => {
          const binary = atob(String(data || ""));
          const bytes = new Uint8Array(binary.length);
          for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
          return bytes;
        };

    const responseBytes = (result) => {
      if (!result) return new Uint8Array();
      if (result.data instanceof ArrayBuffer) return new Uint8Array(result.data);
      if (ArrayBuffer.isView(result.data)) {
        return new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength);
      }
      if (result.encoding === "base64") return decodeBase64(result.data);
      return new TextEncoder().encode(String(result.data ?? ""));
    };

    // ===== Hongguo micro app =====
    const hongguoState = {
      view: "loading",
      loadingLabel: "正在加载短剧内容…",
      featured: [],
      feedCursor: null,
      feedHasMore: false,
      feedTotal: 0,
      feedLoading: false,
      feedError: null,
      listItems: [],
      selectedDrama: null,
      playback: null,
      error: null,
      retryAction: null,
      detailReturnView: "home",
      errorReturnView: "home",
      scrollPositions: new Map()
    };
    let hongguoDirectPlayer = null;
    let hongguoPlaybackStopping = false;
    let hongguoAutoplayTimer = null;
    let hongguoFeedRequestId = null;
    let hongguoHomeRetryTimer = null;
    let hongguoHomeRetryAttempt = 0;
    const hongguoImageCache = new Map();
    const hongguoImageRequests = new Map();
    const hongguoImageRetries = new Map();
    let hongguoImageBytes = 0;
    const hongguoImageRetryDelays = [1_500, 5_000];

    const rememberHongguoScroll = () => {
      const scroller = hongguoApp.querySelector(".hg-scroll[data-scroll-key]");
      if (scroller) hongguoState.scrollPositions.set(scroller.dataset.scrollKey, scroller.scrollTop);
    };

    const clearHongguoAutoplay = () => {
      if (hongguoAutoplayTimer !== null) clearInterval(hongguoAutoplayTimer);
      hongguoAutoplayTimer = null;
    };

    const restoreHongguoScroll = () => {
      const scroller = hongguoApp.querySelector(".hg-scroll[data-scroll-key]");
      if (!scroller) return;
      const top = hongguoState.scrollPositions.get(scroller.dataset.scrollKey) || 0;
      requestAnimationFrame(() => {
        if (scroller.isConnected) scroller.scrollTop = top;
      });
    };

    const releaseHongguoImages = () => {
      for (const entry of hongguoImageCache.values()) URL.revokeObjectURL(entry.url);
      hongguoImageCache.clear();
      hongguoImageBytes = 0;
    };

    const trimHongguoImages = () => {
      if (hongguoImageCache.size <= 30 && hongguoImageBytes <= 12 * 1024 * 1024) return;
      // 只回收「已不被任何在场 <img> 引用」的 Blob URL。瀑布流里向上滚出的封面仍在 DOM 中，
      // 若按纯 LRU 直接 revoke 会让这些图变空白（用户所见「刷着刷着上面图没了」）。
      const inUse = new Set();
      for (const img of hongguoApp.querySelectorAll("img[data-hg-image-reference]")) {
        if (img.src) inUse.add(img.src);
      }
      let guard = hongguoImageCache.size;
      while ((hongguoImageCache.size > 30 || hongguoImageBytes > 12 * 1024 * 1024) && guard-- > 0) {
        const oldestKey = hongguoImageCache.keys().next().value;
        const oldest = hongguoImageCache.get(oldestKey);
        hongguoImageCache.delete(oldestKey);
        if (inUse.has(oldest.url)) {
          // 仍在使用：重新放回队尾（保活），不 revoke。等它滚出/被替换后再回收。
          hongguoImageCache.set(oldestKey, oldest);
        } else {
          hongguoImageBytes -= oldest.size;
          URL.revokeObjectURL(oldest.url);
        }
      }
    };

    const clearHongguoImageRetry = (reference) => {
      const retry = hongguoImageRetries.get(reference);
      if (retry?.timer != null) clearTimeout(retry.timer);
      hongguoImageRetries.delete(reference);
    };

    const scheduleHongguoImageRetry = (reference, targets) => {
      if (disposed || !reference) return;
      let retry = hongguoImageRetries.get(reference);
      if (!retry) {
        retry = { attempt: 0, timer: null, targets: new Set() };
        hongguoImageRetries.set(reference, retry);
      }
      for (const target of targets) retry.targets.add(target);
      if (retry.timer !== null) return;
      if (retry.attempt >= hongguoImageRetryDelays.length) {
        // 本轮退避预算耗尽后释放 DOM 引用；下次重挂载仍可开启一轮新重试。
        hongguoImageRetries.delete(reference);
        return;
      }
      const delay = hongguoImageRetryDelays[retry.attempt++];
      retry.timer = setTimeout(() => {
        retry.timer = null;
        const retryTargets = [...retry.targets].filter((target) => (
          target.isConnected && !target.getAttribute("src")
        ));
        retry.targets.clear();
        if (retryTargets.length === 0) {
          clearHongguoImageRetry(reference);
          return;
        }
        for (const target of retryTargets) {
          bindHongguoImage(target, { posterUrl: reference });
        }
      }, delay);
    };

    const handleHongguoImageError = (img, reference) => {
      const failedUrl = img.src;
      img.removeAttribute("src");
      const cached = hongguoImageCache.get(reference);
      if (cached?.url === failedUrl) {
        hongguoImageCache.delete(reference);
        hongguoImageBytes -= cached.size;
        URL.revokeObjectURL(cached.url);
      }
      scheduleHongguoImageRetry(reference, [img]);
    };

    const bindHongguoImage = (img, item) => {
      const reference = item?.posterUrl;
      if (!reference) return;
      img.dataset.hgImageReference = reference;
      const cached = hongguoImageCache.get(reference);
      if (cached) {
        hongguoImageCache.delete(reference);
        hongguoImageCache.set(reference, cached);
        img.src = cached.url;
        return;
      }
      const pending = hongguoImageRequests.get(reference);
      if (pending) {
        pending.targets.add(img);
        return;
      }
      const request = requestRpc("hongguo.image.load", { url: reference }, { timeoutMs: 20_000 });
      const entry = { id: request.id, targets: new Set([img]) };
      hongguoImageRequests.set(reference, entry);
      request.promise.then((result) => {
        if (disposed) return;
        const bytes = responseBytes(result);
        if (!bytes.byteLength) return;
        const blob = new Blob([bytes], { type: result?.contentType || "image/jpeg" });
        const url = URL.createObjectURL(blob);
        hongguoImageCache.set(reference, { url, size: blob.size });
        hongguoImageBytes += blob.size;
        // Summary 关闭时 host 会暂时脱离 DOM。即使此刻 disconnected，
        // 也必须把 Blob URL 写回原节点，否则重新打开后会永久停在占位图。
        for (const target of entry.targets) target.src = url;
        // 必须先绑定再回收：新 URL 在赋给 img 前不属于 inUse，先 trim 会把
        // 第 31 张起的新封面立即 revoke，随后触发 error 并永久留下占位图。
        clearHongguoImageRetry(reference);
        trimHongguoImages();
      }).catch(() => {
        // 瞬时网络失败不进入缓存；保留 img，并做有限退避重试。
        scheduleHongguoImageRetry(reference, entry.targets);
      }).finally(() => {
        if (hongguoImageRequests.get(reference) === entry) {
          hongguoImageRequests.delete(reference);
        }
      });
    };

    refreshHongguoImages = () => {
      for (const img of hongguoApp.querySelectorAll("img[data-hg-image-reference]")) {
        if (img.getAttribute("src")) continue;
        bindHongguoImage(img, { posterUrl: img.dataset.hgImageReference });
      }
    };

    const makeHongguoToolbar = (title, { back = null } = {}) => {
      const toolbar = makeElement("header", "hg-toolbar");
      if (back) {
        const button = makeElement("button", "hg-icon-button");
        button.type = "button";
        button.title = "返回";
        button.setAttribute("aria-label", "返回");
        button.append(makeToolbarIcon("back"));
        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          back();
        });
        toolbar.append(button);
      }
      toolbar.append(makeElement("h2", "hg-toolbar-title", title));
      return toolbar;
    };

    const makeHongguoIdForm = () => {
      const form = makeElement("form", "hg-search-form");
      const input = makeElement("input", "hg-search-input");
      input.type = "text";
      input.placeholder = "输入剧集 ID 打开";
      input.autocomplete = "off";
      input.inputMode = "numeric";
      input.setAttribute("aria-label", "输入剧集 ID");
      const submit = makeElement("button", "hg-button primary", "打开");
      submit.type = "submit";
      form.append(input, submit);
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const id = input.value.trim();
        if (id) void openHongguoById(id);
      });
      input.addEventListener("keydown", (event) => event.stopPropagation());
      return form;
    };

    const makeHongguoPoster = (item, className) => {
      const poster = makeElement("span", className, "短剧");
      if (item?.posterUrl) {
        const img = document.createElement("img");
        img.alt = "";
        // 图片字节由 hongguo.image.load RPC 立即拉取（blob 赋值），loading="lazy"
        // 不影响请求时机，只误导读者，故不设。
        img.addEventListener("error", () => handleHongguoImageError(img, item.posterUrl));
        poster.append(img);
        bindHongguoImage(img, item);
      }
      return poster;
    };

    const makeHongguoResult = (item, { removable = false } = {}) => {
      const button = makeElement("button", "hg-result");
      button.type = "button";
      const copy = makeElement("span", "hg-result-copy");
      copy.append(
        makeElement("span", "hg-result-name", item.name || `短剧 ${item.id}`),
        makeElement("span", "hg-muted", item.totalEpisodes ? `${item.totalEpisodes} 集 · ID ${item.id}` : `点击加载选集 · ID ${item.id}`)
      );
      button.append(makeHongguoPoster(item, "hg-result-poster"), copy);
      button.addEventListener("click", () => void openHongguoDetail(item));
      if (!removable) return button;
      // 片单项：包一层，带一个移除按钮
      const row = makeElement("div", "hg-list-row");
      const remove = makeElement("button", "hg-icon-button hg-list-remove");
      remove.type = "button";
      remove.title = "从片单移除";
      remove.setAttribute("aria-label", "从片单移除");
      remove.append(makeToolbarIcon("close"));
      remove.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void removeFromHongguoList(item.id);
      });
      row.append(button, remove);
      return row;
    };

    const renderHongguoLoading = () => {
      const view = makeElement("div", "hg-view hg-center");
      view.dataset.view = "loading";
      view.append(makeElement("div", "hg-spinner"), makeElement("span", "hg-muted", hongguoState.loadingLabel));
      return view;
    };

    const renderHongguoHome = () => {
      const view = makeElement("div", "hg-view");
      view.dataset.view = "home";
      view.append(makeHongguoToolbar("红果短剧"));
      const scroll = makeElement("div", "hg-scroll hg-content");
      scroll.dataset.scrollKey = "home";
      scroll.append(
        makeHongguoIdForm()
      );
      // 我的片单：ID 直达打开过的剧留在这里，点一下直接进选集，无需重输
      if (hongguoState.listItems.length > 0) {
        scroll.append(makeElement("h3", "hg-section-title", "我的片单"));
        for (const item of hongguoState.listItems) {
          scroll.append(makeHongguoResult(item, { removable: true }));
        }
      }
      if (hongguoState.featured.length === 0) {
        scroll.append(makeElement("div", "hg-empty", "暂无推荐内容，可输入剧集 ID 打开"));
      } else {
        scroll.append(makeElement("h3", "hg-section-title", "为你推荐"));
        const grid = makeElement("div", "hg-feature-grid");
        for (const item of hongguoState.featured) {
          const button = makeElement("button", "hg-feature");
          button.type = "button";
          button.append(makeHongguoPoster(item, "hg-feature-poster"), makeElement("span", "hg-feature-name", item.name));
          button.addEventListener("click", () => void openHongguoDetail(item));
          grid.append(button);
        }
        scroll.append(grid);
        const feedStatus = makeElement("div", "hg-feed-status");
        feedStatus.dataset.feedStatus = "true";
        if (hongguoState.feedLoading) {
          const status = makeElement("div", "hg-inline-status");
          status.append(makeElement("span", "hg-mini-spinner"), makeElement("span", "", "正在加载更多…"));
          feedStatus.append(status);
        } else if (hongguoState.feedError) {
          const retry = makeElement("button", "hg-button", "加载失败，点击重试");
          retry.type = "button";
          retry.addEventListener("click", () => void loadMoreHongguo());
          feedStatus.append(retry);
        } else if (hongguoState.feedHasMore) {
          feedStatus.textContent = "继续下滑加载更多";
        } else {
          feedStatus.textContent = hongguoState.feedTotal > 0
            ? `已加载本次推荐的 ${hongguoState.feedTotal} 部短剧`
            : "已经到底了";
        }
        scroll.append(feedStatus);
        scroll.addEventListener("scroll", () => {
          if (scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 180) void loadMoreHongguo();
        }, { passive: true });
      }
      view.append(scroll);
      return view;
    };

    const renderHongguoDetail = () => {
      const drama = hongguoState.selectedDrama || {};
      const view = makeElement("div", "hg-view");
      view.dataset.view = "detail";
      view.append(makeHongguoToolbar(drama.name || "选择集数", {
        back: () => {
          hongguoState.view = hongguoState.detailReturnView || "home";
          renderHongguo();
        }
      }));
      const scroll = makeElement("div", "hg-scroll");
      scroll.dataset.scrollKey = `detail:${drama.id || "unknown"}`;
      const hero = makeElement("div", "hg-detail-hero");
      const copy = makeElement("div", "hg-detail-copy");
      copy.append(
        makeElement("h3", "hg-detail-title", drama.name || `短剧 ${drama.id || ""}`),
        makeElement(
          "div",
          "hg-muted",
          drama.fullEpisodeCount > drama.accessibleEpisodeCount
            ? `官网开放前 ${drama.accessibleEpisodeCount || 0} 集 · 全 ${drama.fullEpisodeCount} 集`
            : `${drama.totalEpisodes || 0} 集 · ID ${drama.id || "-"}`
        )
      );
      if (drama.description) copy.append(makeElement("div", "hg-muted hg-detail-description", drama.description));
      hero.append(makeHongguoPoster(drama, "hg-detail-poster"), copy);
      scroll.append(hero);
      const grid = makeElement("div", "hg-episode-grid");
      const total = Math.max(0, Number(drama.totalEpisodes || 0));
      if (total === 0) grid.append(makeElement("div", "hg-empty", "红果官网当前没有开放可播放剧集"));
      else {
        for (let episode = 1; episode <= total; episode += 1) {
          const button = makeElement("button", "hg-episode", String(episode));
          button.type = "button";
          button.setAttribute("aria-label", `播放第 ${episode} 集`);
          button.addEventListener("click", () => void beginHongguoPlayback(drama, episode));
          grid.append(button);
        }
      }
      scroll.append(grid);
      view.append(scroll);
      return view;
    };

    const stopHongguoPlayback = (reportStop = true) => {
      const playbackId = hongguoState.playback?.playbackId;
      clearHongguoAutoplay();
      hongguoPlaybackStopping = true;
      hongguoDirectPlayer?.destroy?.();
      hongguoDirectPlayer = null;
      const video = hongguoApp.querySelector(".hg-video");
      if (video) {
        video.pause();
        video.removeAttribute("src");
        video.load();
      }
      if (reportStop && playbackId) {
        rpc("hongguo.playback.stop", { playbackId }, { timeoutMs: 5_000 }).catch(() => {});
      }
      hongguoState.playback = null;
      releaseObjectUrl();
      hongguoPlaybackStopping = false;
    };

    const showHongguoError = (errorValue, returnView = "home", retryAction = null) => {
      const error = toRpcError(errorValue);
      stopHongguoPlayback(true);
      hongguoState.error = { code: error.code, message: error.message, retryable: error.retryable };
      hongguoState.retryAction = typeof retryAction === "function" ? retryAction : null;
      hongguoState.errorReturnView = returnView;
      hongguoState.view = "error";
      renderHongguo();
    };

    const configureHongguoDirectMp4 = async (video, playback, status) => {
      video.addEventListener("canplay", () => { status.hidden = true; }, { once: true });
      await configureDirectMp4Stream(video, playback, {
        rpcPrefix: "hongguo.playback.direct",
        setActivePlayer: (player) => { hongguoDirectPlayer = player; },
        clearActivePlayer: (player) => { if (hongguoDirectPlayer === player) hongguoDirectPlayer = null; },
        isStopping: () => hongguoPlaybackStopping,
        onFailure: (errorObject) => {
          if (hongguoState.playback) hongguoState.playback.lastError = errorObject.message;
          const drama = hongguoState.selectedDrama;
          const episode = Number(hongguoState.playback?.episode);
          showHongguoError(
            errorObject,
            "detail",
            drama?.id && episode > 0 ? () => beginHongguoPlayback(drama, episode) : null
          );
        }
      });
    };

    const renderHongguoPlayback = () => {
      const playback = hongguoState.playback || {};
      const view = makeElement("div", "hg-view hg-playback");
      view.dataset.view = "playback";
      view.tabIndex = 0;
      const video = makeElement("video", "hg-video");
      video.controls = true;
      video.playsInline = true;
      video.preload = "metadata";
      video.disablePictureInPicture = true;
      const chrome = makeElement("div", "hg-playback-chrome");
      const back = makeElement("button", "hg-icon-button hg-playback-back");
      back.type = "button";
      back.title = "返回选集";
      back.setAttribute("aria-label", "返回选集");
      back.append(makeToolbarIcon("back"));
      back.addEventListener("click", () => {
        stopHongguoPlayback(true);
        hongguoState.view = hongguoState.selectedDrama ? "detail" : "home";
        renderHongguo();
      });
      chrome.append(back, makeElement("span", "hg-playback-title", playback.title || "正在播放"));
      chrome.append(makeFullscreenButton(view, "hg-icon-button hg-playback-fullscreen"));
      const status = makeElement("div", "hg-playback-status");
      status.append(makeElement("div", "hg-spinner"), makeElement("span", "", "正在连接视频源…"));
      const autoplay = makeElement("div", "hg-autoplay");
      autoplay.hidden = true;
      autoplay.setAttribute("role", "dialog");
      autoplay.setAttribute("aria-label", "自动连播");
      const autoplayCard = makeElement("div", "hg-autoplay-card");
      const autoplayTitle = makeElement("div", "hg-autoplay-title");
      const autoplayDetail = makeElement("div", "hg-autoplay-detail");
      autoplayDetail.setAttribute("aria-live", "polite");
      const autoplayActions = makeElement("div", "hg-autoplay-actions");
      autoplayCard.append(autoplayTitle, autoplayDetail, autoplayActions);
      autoplay.append(autoplayCard);
      const drama = hongguoState.selectedDrama;
      const currentEpisode = Number(playback.episode);
      const totalEpisodes = Math.max(0, Number(drama?.totalEpisodes || 0));
      const knownTotal = totalEpisodes > 0;
      // totalEpisodes 缺失（未加载到集数元数据）时不能断定已到最后一集，否则会在剧集中途
      // 错误显示「已经是最后一集」而无法连播。此时把下一集当作「可能存在」：提供手动按钮，
      // 但不自动倒计时跳转（避免真到结尾时自动跳进不存在的集导致报错）。
      const nextEpisode =
        drama?.id && currentEpisode > 0 && (!knownTotal || currentEpisode < totalEpisodes)
          ? currentEpisode + 1
          : null;
      const autoAdvance = knownTotal && Boolean(nextEpisode);
      let playbackTransitionStarted = false;

      const hideAutoplay = () => {
        clearHongguoAutoplay();
        autoplay.hidden = true;
      };
      const restartCurrentEpisode = () => {
        if (playbackTransitionStarted) return;
        hideAutoplay();
        if (drama?.id && currentEpisode > 0) {
          playbackTransitionStarted = true;
          void beginHongguoPlayback(drama, currentEpisode);
          return;
        }
        video.currentTime = 0;
        void video.play().catch(() => {});
      };
      const playNextEpisode = () => {
        if (playbackTransitionStarted || !nextEpisode || !drama?.id) return;
        playbackTransitionStarted = true;
        hideAutoplay();
        void beginHongguoPlayback(drama, nextEpisode);
      };
      const makeAutoplayButton = (label, primary, onClick) => {
        const button = makeElement("button", `hg-button${primary ? " primary" : ""}`, label);
        button.type = "button";
        button.addEventListener("click", onClick);
        return button;
      };
      const showEndedActions = (title, detail, includeNext = false) => {
        clearHongguoAutoplay();
        autoplayTitle.textContent = title;
        autoplayDetail.textContent = detail;
        const replay = makeAutoplayButton("重播", false, restartCurrentEpisode);
        if (includeNext) {
          autoplayActions.replaceChildren(
            makeAutoplayButton("播放下一集", true, playNextEpisode),
            replay
          );
        } else {
          autoplayActions.replaceChildren(replay);
        }
        autoplay.hidden = false;
      };
      const beginAutoplayCountdown = () => {
        if (!nextEpisode) {
          showEndedActions("本集已播放完毕", knownTotal ? "已经是最后一集" : "没有更多可播放的选集");
          return;
        }
        if (!autoAdvance) {
          // 集数未知：不自动跳转，改为提供手动续播入口（下一集可能不存在，交由用户决定）。
          showEndedActions("本集已播放完毕", `可尝试播放第 ${nextEpisode} 集`, true);
          return;
        }
        let remainingSeconds = 5;
        const updateCountdown = () => {
          autoplayDetail.textContent = `第 ${nextEpisode} 集 · ${remainingSeconds} 秒后自动播放`;
        };
        autoplayTitle.textContent = "即将为你播放下一集";
        updateCountdown();
        autoplayActions.replaceChildren(
          makeAutoplayButton("立即播放", true, playNextEpisode),
          makeAutoplayButton("取消", false, () => {
            showEndedActions("已取消自动连播", `第 ${nextEpisode} 集等待播放`, true);
          })
        );
        autoplay.hidden = false;
        clearHongguoAutoplay();
        hongguoAutoplayTimer = setInterval(() => {
          if (
            playbackTransitionStarted ||
            hongguoState.playback !== playback ||
            hongguoState.view !== "playback"
          ) {
            clearHongguoAutoplay();
            return;
          }
          remainingSeconds -= 1;
          if (remainingSeconds <= 0) {
            playNextEpisode();
            return;
          }
          updateCountdown();
        }, 1_000);
        autoplayActions.querySelector(".primary")?.focus({ preventScroll: true });
      };
      video.addEventListener("ended", beginAutoplayCountdown);
      video.addEventListener("play", () => {
        if (!playbackTransitionStarted && !autoplay.hidden) hideAutoplay();
      });
      // 暂停状态同步到 view.dataset.paused：CSS 据此常显 chrome（与 Emby 侧一致）。
      const syncPausedState = () => { view.dataset.paused = String(video.paused); };
      video.addEventListener("play", syncPausedState);
      video.addEventListener("playing", syncPausedState);
      video.addEventListener("pause", syncPausedState);
      syncPausedState();
      view.addEventListener("keydown", (event) => {
        // 空格/左右方向键转发给 video：仅当焦点在容器本身（与 Emby 播放视图一致）。
        if (event.target === view && (event.key === " " || event.key === "ArrowLeft" || event.key === "ArrowRight")) {
          event.preventDefault();
          event.stopPropagation();
          if (event.key === " ") {
            if (video.paused) video.play().catch(() => {});
            else video.pause();
          } else {
            const delta = event.key === "ArrowRight" ? 5 : -5;
            const duration = Number(video.duration);
            video.currentTime = Math.max(
              0,
              Math.min(Number.isFinite(duration) ? duration : Infinity, Number(video.currentTime || 0) + delta)
            );
          }
          return;
        }
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        back.click();
      });
      view.append(video, chrome, status, autoplay);
      setTimeout(async () => {
        if (!view.isConnected) return;
        view.focus({ preventScroll: true });
        try {
          if (playback.externalSource) {
            video.src = playback.externalSource;
            status.hidden = true;
            video.load();
          } else await configureHongguoDirectMp4(video, playback, status);
          // 自动起播：此前红果播放视图从头到尾没有 play() 调用——首次打开和自动
          // 连播都停在首帧等用户手点（Emby 侧有 activatePlaybackState 自动起播）。
          // 若浏览器按自动播放策略拒绝则静默兜底，用户仍可手动点播。
          void video.play().catch(() => {});
        } catch (errorValue) {
          if (hongguoState.playback !== playback || hongguoState.view !== "playback") return;
          const drama = hongguoState.selectedDrama;
          const episode = Number(playback?.episode);
          showHongguoError(
            errorValue,
            drama ? "detail" : "home",
            drama?.id && episode > 0 ? () => beginHongguoPlayback(drama, episode) : null
          );
        }
      }, 0);
      return view;
    };

    const renderHongguoError = () => {
      const view = makeElement("div", "hg-view hg-center");
      view.dataset.view = "error";
      const sourceUnavailable = hongguoState.error?.code === "VIDEO_SOURCE_UNAVAILABLE";
      view.append(
        makeElement("div", "hg-error-title", sourceUnavailable ? "该短剧线路暂不可用" : "短剧内容暂时不可用"),
        makeElement("div", "hg-muted", hongguoState.error?.message || "请稍后重试")
      );
      const actions = makeElement("div", "hg-error-actions");
      const retry = makeElement("button", "hg-button primary", "重试");
      retry.type = "button";
      retry.addEventListener("click", () => {
        const action = hongguoState.retryAction;
        hongguoState.retryAction = null;
        if (action) void action();
      });
      retry.hidden = !hongguoState.error?.retryable || !hongguoState.retryAction;
      const back = makeElement("button", "hg-button", "返回");
      back.type = "button";
      back.addEventListener("click", () => {
        hongguoState.view = hongguoState.errorReturnView === "detail" && hongguoState.selectedDrama ? "detail" : "home";
        renderHongguo();
      });
      actions.append(retry, back);
      view.append(actions);
      return view;
    };

    const renderHongguo = () => {
      if (disposed) return;
      let view;
      if (hongguoState.view === "home") view = renderHongguoHome();
      else if (hongguoState.view === "detail") view = renderHongguoDetail();
      else if (hongguoState.view === "playback") view = renderHongguoPlayback();
      else if (hongguoState.view === "error") view = renderHongguoError();
      else view = renderHongguoLoading();
      hongguoApp.replaceChildren(view);
      restoreHongguoScroll();
    };

    const loadMoreHongguo = async () => {
      if (
        disposed
        || hongguoState.view !== "home"
        || hongguoState.feedLoading
        || !hongguoState.feedHasMore
        || !hongguoState.feedCursor
      ) return;
      hongguoState.feedLoading = true;
      hongguoState.feedError = null;
      const status = hongguoApp.querySelector('[data-feed-status="true"]');
      if (status) status.textContent = "正在加载更多…";
      const cursor = hongguoState.feedCursor;
      const request = requestRpc("hongguo.feed.next", { cursor, limit: 20 }, { timeoutMs: 15_000 });
      hongguoFeedRequestId = request.id;
      try {
        const result = await request.promise;
        if (disposed || hongguoFeedRequestId !== request.id || hongguoState.feedCursor !== cursor) return;
        hongguoFeedRequestId = null;
        const existing = new Set(hongguoState.featured.map((item) => item.id));
        const incoming = Array.isArray(result?.items) ? result.items.filter((item) => !existing.has(item?.id)) : [];
        rememberHongguoScroll();
        hongguoState.featured.push(...incoming);
        hongguoState.feedCursor = result?.cursor || null;
        hongguoState.feedHasMore = result?.hasMore === true && Boolean(result?.cursor);
        hongguoState.feedTotal = Math.max(hongguoState.feedTotal, Number(result?.total) || 0);
        hongguoState.feedLoading = false;
        hongguoState.feedError = null;
        renderHongguo();
      } catch (errorValue) {
        if (hongguoFeedRequestId !== request.id) return;
        hongguoFeedRequestId = null;
        hongguoState.feedLoading = false;
        const error = toRpcError(errorValue);
        if (error.code === "FEED_EXPIRED") {
          void loadHongguoHome();
          return;
        }
        hongguoState.feedError = error.message;
        if (hongguoState.view === "home") renderHongguo();
      }
    };

    const loadHongguoHome = async ({ automatic = false } = {}) => {
      if (!automatic) {
        if (hongguoHomeRetryTimer !== null) clearTimeout(hongguoHomeRetryTimer);
        hongguoHomeRetryTimer = null;
        hongguoHomeRetryAttempt = 0;
      }
      hongguoState.loadingLabel = "正在加载短剧内容…";
      hongguoState.view = "loading";
      renderHongguo();
      const applyHomeResult = (result) => {
        hongguoState.featured = Array.isArray(result?.items)
          ? result.items
          : Array.isArray(result?.featured) ? result.featured : [];
        hongguoState.feedCursor = result?.cursor || null;
        hongguoState.feedHasMore = result?.hasMore === true && Boolean(result?.cursor);
        hongguoState.feedTotal = Number(result?.total) || hongguoState.featured.length;
        hongguoState.feedLoading = false;
        hongguoState.feedError = null;
        hongguoState.error = null;
        hongguoState.retryAction = null;
        hongguoState.view = "home";
        if (hongguoHomeRetryTimer !== null) clearTimeout(hongguoHomeRetryTimer);
        hongguoHomeRetryTimer = null;
        hongguoHomeRetryAttempt = 0;
        renderHongguo();
      };
      try {
        const result = await rpc("hongguo.home", { limit: 20 }, { timeoutMs: 30_000 });
        if (disposed) return;
        applyHomeResult(result);
        if (result?.cacheStatus === "stale") {
          // stale 数据先上屏，后台刷新完成后替换并重渲染 —— 此前完全忽略 cacheStatus，
          // 刷新结果要等下次挂载才生效（旧封面/已下架内容会一直挂着）。对齐 Emby 侧
          // loadHome 的 stale→refresh→二次渲染 模式。
          void rpc("hongguo.home", { limit: 20, refresh: true }, { timeoutMs: 30_000 }).then((refreshed) => {
            if (disposed) return;
            if (Array.isArray(refreshed?.items)) {
              hongguoState.featured = refreshed.items;
              hongguoState.feedCursor = refreshed?.cursor || hongguoState.feedCursor;
              hongguoState.feedHasMore = refreshed?.hasMore === true && Boolean(refreshed?.cursor);
              hongguoState.feedTotal = Number(refreshed?.total) || hongguoState.feedTotal;
            }
            // 用户已离开首页（详情/播放）时只更新数据，不重渲染抢视图。
            if (hongguoState.view === "home") renderHongguo();
          }).catch(() => {});
        }
      } catch (errorValue) {
        showHongguoError(errorValue, "home", loadHongguoHome);
        const error = toRpcError(errorValue);
        const delays = [1_500, 4_000, 10_000, 30_000];
        if (!disposed && error.retryable && hongguoHomeRetryAttempt < delays.length) {
          const delay = delays[hongguoHomeRetryAttempt++];
          if (hongguoHomeRetryTimer !== null) clearTimeout(hongguoHomeRetryTimer);
          hongguoHomeRetryTimer = setTimeout(() => {
            hongguoHomeRetryTimer = null;
            void loadHongguoHome({ automatic: true });
          }, delay);
        }
      }
    };

    const loadHongguoList = async () => {
      try {
        const result = await rpc("hongguo.list.get", {}, { timeoutMs: 15_000 });
        if (disposed) return;
        hongguoState.listItems = Array.isArray(result?.items) ? result.items : [];
        if (hongguoState.view === "home") renderHongguo();
      } catch {
        // 片单加载失败不影响首页其余内容
      }
    };

    const addToHongguoList = async (item) => {
      if (!item?.id) return;
      try {
        const result = await rpc("hongguo.list.add", {
          id: String(item.id),
          name: item.name || "",
          posterUrl: item.posterUrl || ""
        }, { timeoutMs: 15_000 });
        if (disposed) return;
        hongguoState.listItems = Array.isArray(result?.items) ? result.items : hongguoState.listItems;
      } catch {
        // 加入片单失败静默：不打断播放/浏览
      }
    };

    const removeFromHongguoList = async (id) => {
      try {
        const result = await rpc("hongguo.list.remove", { id: String(id) }, { timeoutMs: 15_000 });
        if (disposed) return;
        hongguoState.listItems = Array.isArray(result?.items) ? result.items : hongguoState.listItems;
        if (hongguoState.view === "home") renderHongguo();
      } catch {
        // 忽略
      }
    };

    // 通过剧集 ID 直达：拉详情，成功则进入详情页并自动加入片单。
    const openHongguoById = (id) => {
      const dramaId = String(id ?? "").trim();
      if (!/^[0-9]{1,32}$/.test(dramaId)) {
        showHongguoError(rpcError("INVALID_DRAMA_ID", "请输入有效的剧集 ID（纯数字）"), "home");
        return Promise.resolve();
      }
      return openHongguoDetail({ id: dramaId });
    };

    const openHongguoDetail = async (item) => {
      if (!item?.id) return;
      rememberHongguoScroll();
      const originView = "home";
      hongguoState.loadingLabel = "正在读取选集…";
      hongguoState.view = "loading";
      renderHongguo();
      try {
        const drama = await rpc("hongguo.detail", { dramaId: item.id }, { timeoutMs: 25_000 });
        if (disposed) return;
        hongguoState.selectedDrama = { ...item, ...drama };
        hongguoState.detailReturnView = originView;
        hongguoState.error = null;
        hongguoState.view = "detail";
        renderHongguo();
        // 打开成功即收藏进片单（下次首页直接可点，无需重输 ID）
        void addToHongguoList(hongguoState.selectedDrama);
      } catch (errorValue) {
        showHongguoError(errorValue, originView, () => openHongguoDetail(item));
      }
    };

    const beginHongguoPlayback = async (drama, episode) => {
      if (!drama?.id) {
        showHongguoError(rpcError("DRAMA_NOT_SELECTED", "请先选择一部短剧"), "home");
        return;
      }
      stopHongguoPlayback(true);
      hongguoState.loadingLabel = `正在准备第 ${episode} 集…`;
      hongguoState.view = "loading";
      renderHongguo();
      try {
        const playback = await rpc("hongguo.playback.open", {
          dramaId: drama.id,
          episode
        }, { timeoutMs: 30_000 });
        if (disposed) return;
        hongguoState.playback = {
          ...playback,
          title: `${drama.name} · 第 ${episode} 集`
        };
        hongguoState.error = null;
        hongguoState.view = "playback";
        renderHongguo();
      } catch (errorValue) {
        showHongguoError(errorValue, "detail", () => beginHongguoPlayback(drama, episode));
      }
    };

    const setVideoSource = (source) => {
      if (typeof source !== "string" || source.length === 0) throw new TypeError("source 必须是非空字符串");
      stopHongguoPlayback(true);
      hongguoState.playback = { externalSource: source, title: "外部视频" };
      hongguoState.view = "playback";
      renderHongguo();
    };

    const setVideoFile = (file) => {
      if (!(file instanceof Blob)) throw new TypeError("file 必须是 File 或 Blob");
      stopHongguoPlayback(true);
      objectUrl = URL.createObjectURL(file);
      hongguoState.playback = { externalSource: objectUrl, title: file.name || "本地视频" };
      hongguoState.view = "playback";
      renderHongguo();
    };

    const clearVideo = () => {
      stopHongguoPlayback(true);
      hongguoState.view = hongguoState.selectedDrama ? "detail" : "home";
      renderHongguo();
    };

    const cleanupHongguo = () => {
      if (hongguoHomeRetryTimer !== null) clearTimeout(hongguoHomeRetryTimer);
      hongguoHomeRetryTimer = null;
      if (hongguoFeedRequestId) cancelRpc(hongguoFeedRequestId, true);
      hongguoFeedRequestId = null;
      stopHongguoPlayback(true);
      for (const request of hongguoImageRequests.values()) cancelRpc(request.id, true);
      hongguoImageRequests.clear();
      for (const retry of hongguoImageRetries.values()) {
        if (retry.timer !== null) clearTimeout(retry.timer);
      }
      hongguoImageRetries.clear();
      releaseHongguoImages();
    };

    const releaseImageCache = () => {
      for (const entry of imageCache.values()) URL.revokeObjectURL(entry.url);
      imageCache.clear();
      imageCacheBytes = 0;
    };

    const trimImageCache = () => {
      // 未超限时直接返回：否则每张图加载完都全扫一次 DOM 建 Set
      // （60+ 海报的媒体库页就是 60 次全扫，O(n²)）。
      if (imageCache.size <= MAX_IMAGE_COUNT && imageCacheBytes <= MAX_IMAGE_BYTES) return;
      const activeUrls = new Set(
        [...embyApp.querySelectorAll("img[src]")].map((image) => image.src).filter(Boolean)
      );
      let protectedCount = 0;
      while (
        (imageCache.size > MAX_IMAGE_COUNT || imageCacheBytes > MAX_IMAGE_BYTES)
        && protectedCount < imageCache.size
      ) {
        const oldestKey = imageCache.keys().next().value;
        const oldest = imageCache.get(oldestKey);
        if (activeUrls.has(oldest.url)) {
          imageCache.delete(oldestKey);
          imageCache.set(oldestKey, oldest);
          protectedCount += 1;
          continue;
        }
        imageCache.delete(oldestKey);
        imageCacheBytes -= oldest.size;
        URL.revokeObjectURL(oldest.url);
        protectedCount = 0;
      }
    };

    const drainImageLoadQueue = () => {
      while (activeImageLoads < MAX_CONCURRENT_IMAGE_LOADS && imageLoadQueue.length > 0) {
        const task = imageLoadQueue.shift();
        if (task.generation !== imageLoadGeneration) {
          task.reject(rpcError("ABORTED", "图片加载已取消", true));
          continue;
        }
        activeImageLoads += 1;
        Promise.resolve()
          .then(task.operation)
          .then(task.resolve, task.reject)
          .finally(() => {
            activeImageLoads -= 1;
            drainImageLoadQueue();
          });
      }
    };

    const scheduleImageLoad = (operation, generation) => new Promise((resolve, reject) => {
      imageLoadQueue.push({ operation, generation, resolve, reject });
      drainImageLoadQueue();
    });

    const cancelImageLoads = () => {
      imageLoadGeneration += 1;
      const error = rpcError("ABORTED", "图片加载已取消", true);
      for (const task of imageLoadQueue.splice(0)) task.reject(error);
      imageLoads.clear();
    };

    const imageRetryDelay = (milliseconds, generation) => new Promise((resolve, reject) => {
      setTimeout(() => {
        if (generation === imageLoadGeneration) resolve();
        else reject(rpcError("ABORTED", "图片加载已取消", true));
      }, milliseconds);
    });

    const requestImageResource = async (reference, generation) => {
      let lastError = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (generation !== imageLoadGeneration) throw rpcError("ABORTED", "图片加载已取消", true);
        try {
          return await scheduleImageLoad(async () => {
            const request = requestRpc("resource.load", {
              url: reference,
              responseType: "arraybuffer",
              resourceType: "image"
            }, { timeoutMs: 30_000 });
            imageRequests.add(request.id);
            try {
              return await request.promise;
            } finally {
              imageRequests.delete(request.id);
            }
          }, generation);
        } catch (errorValue) {
          lastError = toRpcError(errorValue);
          if (attempt === 2 || lastError.retryable !== true || generation !== imageLoadGeneration) throw lastError;
          await imageRetryDelay(250 * (attempt + 1), generation);
        }
      }
      throw lastError;
    };

    const canvasToBlob = (canvas) => {
      if (typeof canvas.convertToBlob === "function") {
        return canvas.convertToBlob({ type: "image/webp", quality: .82 });
      }
      return new Promise((resolve) => canvas.toBlob(resolve, "image/webp", .82));
    };

    const optimizeImageBlob = async (sourceBlob, item, kind) => {
      let bitmap;
      let fallbackUrl = null;
      try {
        if (typeof createImageBitmap === "function") {
          try {
            bitmap = await createImageBitmap(sourceBlob);
          } catch {
            // 部分合法图片可由 <img> 解码，但 createImageBitmap 会拒绝；继续走兼容解码。
          }
        }
        if (!bitmap) {
          fallbackUrl = URL.createObjectURL(sourceBlob);
          bitmap = new Image();
          bitmap.src = fallbackUrl;
          await bitmap.decode();
        }
        const targetWidth = kind === "backdrop" ? 600 : 144;
        const targetHeight = kind === "backdrop" ? 338 : 208;
        const isLibraryTemplate = kind !== "backdrop"
          && item?.type === "CollectionFolder"
          && bitmap.width / Math.max(1, bitmap.height) > 1.4;
        const region = isLibraryTemplate
          ? { x: 0, y: bitmap.height * .25, width: bitmap.width, height: bitmap.height * .60 }
          : { x: 0, y: 0, width: bitmap.width, height: bitmap.height };
        const targetRatio = targetWidth / targetHeight;
        const regionRatio = region.width / region.height;
        let sourceX = region.x;
        let sourceY = region.y;
        let sourceWidth = region.width;
        let sourceHeight = region.height;
        if (regionRatio > targetRatio) {
          sourceWidth = region.height * targetRatio;
          sourceX += (region.width - sourceWidth) / 2;
        } else {
          sourceHeight = region.width / targetRatio;
          sourceY += (region.height - sourceHeight) / 2;
        }
        const canvas = typeof OffscreenCanvas === "function"
          ? new OffscreenCanvas(targetWidth, targetHeight)
          : Object.assign(document.createElement("canvas"), { width: targetWidth, height: targetHeight });
        const context = canvas.getContext("2d", { alpha: false });
        if (!context) return sourceBlob;
        context.drawImage(
          bitmap,
          sourceX,
          sourceY,
          sourceWidth,
          sourceHeight,
          0,
          0,
          targetWidth,
          targetHeight
        );
        return await canvasToBlob(canvas) || sourceBlob;
      } catch {
        return sourceBlob;
      } finally {
        bitmap?.close?.();
        if (fallbackUrl) URL.revokeObjectURL(fallbackUrl);
      }
    };

    const imageReference = (item, kind = "primary") => {
      if (!item || typeof item !== "object") return null;
      return kind === "backdrop"
        ? item.backdropUrl || item.imageUrl || null
        : item.imageUrl || item.backdropUrl || null;
    };

    const applyImageEntry = (img, entry) => {
      img.addEventListener("load", () => {
        img.dataset.imageState = "loaded";
      }, { once: true });
      img.addEventListener("error", () => {
        img.dataset.imageState = "failed";
      }, { once: true });
      img.src = entry.url;
    };

    const bindImage = (img, item, kind = "primary") => {
      const reference = imageReference(item, kind);
      if (!reference) return;
      // 记录绑定信息：host 重挂回 DOM 时 refreshEmbyImages 用它补绑/重试缺 src 的图。
      img.embyImageBinding = { item, kind };
      const profile = kind === "backdrop" ? "backdrop" : item?.type === "CollectionFolder" ? "library" : "primary";
      const key = `${profile}:${typeof reference === "string" ? reference : JSON.stringify(reference)}`;
      img.dataset.imageState = "loading";
      const cached = imageCache.get(key);
      if (cached) {
        imageCache.delete(key);
        imageCache.set(key, cached);
        applyImageEntry(img, cached);
        // 缓存命中说明字节就在内存（blob URL）：直接置 loaded，不等 load 事件淡入。
        // 否则每次视图重建（加载更多 / 切 tab / stale 刷新）所有已显示的海报都会
        // 从 opacity:0 重播一遍 120ms 渐显，肉眼可见地齐闪。
        img.dataset.imageState = "loaded";
        return;
      }
      const generation = imageLoadGeneration;
      let loading = imageLoads.get(key);
      if (!loading) {
        const pending = (async () => {
          const result = await requestImageResource(reference, generation);
          if (disposed || generation !== imageLoadGeneration) throw rpcError("ABORTED", "图片加载已取消", true);
          const bytes = responseBytes(result);
          if (!bytes.byteLength) throw rpcError("EMPTY_IMAGE", "Emby 返回了空图片");
          const sourceBlob = new Blob([bytes], { type: result.contentType || "image/jpeg" });
          const blob = await optimizeImageBlob(sourceBlob, item, kind);
          const entry = { url: URL.createObjectURL(blob), size: blob.size };
          imageCache.set(key, entry);
          imageCacheBytes += entry.size;
          return entry;
        })();
        loading = pending.finally(() => {
          if (imageLoads.get(key) === loading) imageLoads.delete(key);
        });
        imageLoads.set(key, loading);
      }
      loading.then((entry) => {
        if (disposed || generation !== imageLoadGeneration) return;
        // Summary 折叠 / 切会话时 host 会暂时脱离 DOM。即使此刻 disconnected 也必须
        // 把 Blob URL 写回原节点（entry 已在缓存，写 src 无副作用），否则重新挂载后
        // 这些位置会永久停在占位图 —— 红果侧同款问题已在 bindHongguoImage 修过。
        applyImageEntry(img, entry);
        queueMicrotask(trimImageCache);
      }).catch((errorValue) => {
        if (img.isConnected && generation === imageLoadGeneration) {
          img.dataset.imageState = "failed";
          console.warn("[codex-companion] Emby 图片加载失败", {
            item: item?.name || item?.id || "unknown",
            code: toRpcError(errorValue).code
          });
        }
      });
    };

    // host 重挂回 DOM 时补绑没有 src 的图：覆盖加载途中 detach 被跳过的（现在 then
    // 已无条件写回，主要是加载失败/被取消且未进缓存的）——按绑定时记录的 item 重试。
    refreshEmbyImages = () => {
      for (const img of embyApp.querySelectorAll("img")) {
        if (img.getAttribute("src") || !img.embyImageBinding) continue;
        bindImage(img, img.embyImageBinding.item, img.embyImageBinding.kind);
      }
    };

    const rememberScroll = () => {
      const scroller = embyApp.querySelector(".emby-scroll[data-scroll-key]");
      if (scroller) embyState.scrollPositions.set(scroller.dataset.scrollKey, scroller.scrollTop);
    };

    const restoreScroll = () => {
      const scroller = embyApp.querySelector(".emby-scroll[data-scroll-key]");
      if (!scroller) return;
      const top = embyState.scrollPositions.get(scroller.dataset.scrollKey) ?? 0;
      requestAnimationFrame(() => {
        if (scroller.isConnected) scroller.scrollTop = top;
      });
    };

    const formatDuration = (ticks) => {
      const seconds = Math.max(0, Math.round(Number(ticks || 0) / 10_000_000));
      if (!seconds) return "";
      const minutes = Math.floor(seconds / 60);
      const remainder = seconds % 60;
      return `${minutes}:${String(remainder).padStart(2, "0")}`;
    };

    const itemMeta = (item) => {
      const parts = [];
      if (item.type) parts.push(item.type === "Series" ? "剧集" : item.type === "Movie" ? "电影" : item.type === "Episode" ? "单集" : "视频");
      if (item.productionYear) parts.push(String(item.productionYear));
      const duration = formatDuration(item.runtimeTicks);
      if (duration) parts.push(duration);
      return parts.join(" · ");
    };

    const safePercent = (value) => Math.max(0, Math.min(100, Number(value || 0)));

    const makeIconButton = (label, icon, onClick) => {
      const button = makeElement("button", "emby-icon-button");
      button.type = "button";
      button.setAttribute("aria-label", label);
      button.title = label;
      button.append(makeToolbarIcon(icon));
      button.addEventListener("click", onClick);
      return button;
    };

    const makeSearchField = (options = {}) => {
      const form = makeElement("form", "emby-search-wrap");
      form.setAttribute("role", "search");
      const input = makeElement("input", "emby-search-input");
      input.type = "search";
      input.placeholder = options.placeholder || "搜索电影、剧集或单集";
      input.setAttribute("aria-label", "搜索 Emby 媒体");
      input.value = options.value || "";
      const submit = makeIconButton("搜索媒体", "search", () => {});
      submit.type = "submit";
      submit.classList.add("emby-search-submit");
      form.append(input, submit);
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        options.onSubmit?.(input.value);
      });
      // IME 组词期间不触发搜索：中文/日文等输入法在 compositionstart..compositionend
      // 之间会连续 fire input 事件，此时查询是半成品。等 compositionend 再回调一次，
      // 避免用未完成的拼音发请求、以及后续重渲染打断组词。
      let composing = false;
      input.addEventListener("compositionstart", () => { composing = true; });
      input.addEventListener("compositionend", () => {
        composing = false;
        options.onInput?.(input.value);
      });
      input.addEventListener("input", () => {
        if (composing) return;
        options.onInput?.(input.value);
      });
      input.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && options.onEscape) {
          event.preventDefault();
          options.onEscape();
        }
        event.stopPropagation();
      });
      return { form, input };
    };

    const makeToolbar = (title, options = {}) => {
      const toolbar = makeElement("header", "emby-toolbar");
      if (options.back) toolbar.append(makeIconButton("返回", "back", options.back));
      if (options.searchField) toolbar.append(makeSearchField(options.searchField).form);
      else {
        toolbar.append(makeElement("h2", "emby-toolbar-title", title));
        if (options.search) toolbar.append(makeIconButton("搜索媒体", "search", options.search));
      }
      if (options.servers) toolbar.append(makeIconButton("切换 Emby 服务器", "servers", options.servers));
      if (options.logout) toolbar.append(makeIconButton("退出 Emby", "logout", options.logout));
      return toolbar;
    };

    const makeEmpty = (text) => makeElement("div", "emby-empty", text);

    const renderLoading = () => {
      const view = makeElement("div", "emby-view emby-center");
      view.dataset.view = "loading";
      view.append(makeElement("div", "emby-spinner"), makeElement("span", "", embyState.loadingLabel));
      return view;
    };

    const renderDisconnected = () => {
      const view = makeElement("div", "emby-view");
      view.dataset.view = "disconnected";
      const form = makeElement("form", "emby-login");
      const brand = makeElement("div", "emby-brand");
      const brandCopy = makeElement("div");
      brandCopy.append(makeElement("strong", "", "Emby"), makeElement("span", "emby-muted", "连接你的个人媒体库"));
      brand.append(makeElement("div", "emby-mark", "E"), brandCopy);

      const serverLabel = makeElement("label", "emby-field", "服务器地址");
      const serverInput = makeElement("input", "emby-input");
      serverInput.name = "server";
      serverInput.type = "url";
      serverInput.required = true;
      // autocomplete="url" 不是合法 token（spec 无此值，浏览器直接忽略），不设即可。
      serverInput.placeholder = "https://emby.example.com";
      serverInput.value = embyState.addingServer
        ? (embyState.pendingServerInput || "")
        : (embyState.config.baseUrl || "");
      serverLabel.append(serverInput);

      const usernameLabel = makeElement("label", "emby-field", "用户名");
      const usernameInput = makeElement("input", "emby-input");
      usernameInput.name = "username";
      usernameInput.required = true;
      usernameInput.autocomplete = "username";
      usernameInput.value = embyState.addingServer
        ? (embyState.pendingUsernameInput || "")
        : (embyState.config.username || "");
      usernameLabel.append(usernameInput);

      const passwordLabel = makeElement("label", "emby-field", "密码");
      const passwordInput = makeElement("input", "emby-input");
      passwordInput.name = "password";
      passwordInput.type = "password";
      passwordInput.autocomplete = "current-password";
      passwordLabel.append(passwordInput);

      const error = makeElement("p", "emby-inline-error", embyState.inlineError || "");
      const submit = makeElement("button", "emby-button primary", "连接");
      submit.type = "submit";
      form.append(brand, serverLabel, usernameLabel, passwordLabel, error, submit);
      if (embyState.servers.length > 0) {
        const cancel = makeElement("button", "emby-button", embyState.connected ? "取消" : "查看已保存服务器");
        cancel.type = "button";
        cancel.addEventListener("click", () => {
          embyState.addingServer = false;
          embyState.pendingServerInput = "";
          embyState.pendingUsernameInput = "";
          embyState.inlineError = "";
          embyState.view = "servers";
          renderEmby();
        });
        form.append(cancel);
      }
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        embyState.inlineError = "";
        const baseUrl = serverInput.value.trim();
        const username = usernameInput.value.trim();
        submit.disabled = true;
        submit.textContent = "连接中…";
        try {
          const result = await rpc("auth.login", {
            baseUrl,
            username,
            password: passwordInput.value
          }, { timeoutMs: 20_000 });
          passwordInput.value = "";
          Object.assign(embyState.config, result || {});
          embyState.addingServer = false;
          embyState.pendingServerInput = "";
          embyState.pendingUsernameInput = "";
          embyState.connected = Boolean(result?.connected);
          if (!embyState.connected) throw rpcError("AUTH_FAILED", "服务器未确认登录状态");
          await loadServers();
          await loadHome(true);
        } catch (errorValue) {
          const errorObject = toRpcError(errorValue);
          passwordInput.value = "";
          // 保留用户已填的地址/用户名，登录失败后不必从头再输（新增服务器时尤其重要）。
          if (embyState.addingServer) {
            embyState.pendingServerInput = baseUrl;
            embyState.pendingUsernameInput = username;
          }
          embyState.connected = false;
          embyState.inlineError = errorObject.message || "连接失败，请检查地址和账号";
          if (!disposed) renderEmby();
        }
      });
      view.append(form);
      return view;
    };

    const makePosterButton = (item) => {
      const button = makeElement("button", "emby-poster-button");
      button.type = "button";
      button.title = item.name || "打开媒体";
      const poster = makeElement("div", "emby-poster");
      if (imageReference(item, "primary")) {
        const image = makeElement("img");
        image.alt = "";
        bindImage(image, item);
        poster.append(image);
      } else {
        // 无封面的条目（文件夹/合集最常见）给兜底图标，不再只显示灰色渐变块。
        const folderish = ["CollectionFolder", "Folder", "BoxSet", "Season", "Series"].includes(item?.type);
        const fallback = makeElement("span", "emby-poster-fallback");
        fallback.append(makeToolbarIcon(folderish ? "folder" : "film"));
        poster.append(fallback);
      }
      if (item.played) poster.append(makeElement("span", "emby-badge", "已看"));
      button.append(poster, makeElement("span", "emby-poster-name", item.name || "未命名"));
      button.addEventListener("click", () => openItem(item));
      return button;
    };

    const renderHome = () => {
      const view = makeElement("div", "emby-view");
      view.dataset.view = "home";
      const activeServer = embyState.servers.find((entry) => entry.active);
      const activeServerText = activeServer
        ? `${serverTitle(activeServer)}${activeServer.username ? ` · ${activeServer.username}` : ""}`
        : "";
      view.append(makeToolbar("Emby", {
        searchField: {
          value: embyState.searchQuery,
          onSubmit: (query) => {
            if (!query.trim()) return;
            embyState.searchQuery = query;
            rememberScroll();
            embyState.searchReturnView = "home";
            embyState.view = "search";
            renderEmby({ focusSearch: true });
            runSearch(query);
          }
        },
        servers: () => {
          rememberScroll();
          embyState.view = "servers";
          renderEmby();
        }
      }));
      const scroll = makeElement("div", "emby-scroll emby-content");
      scroll.dataset.scrollKey = "home";

      // 顶部显示当前所在服务器，多服务器时一眼可辨（点击进入服务器切换）。
      if (activeServer) {
        const serverLine = makeElement("button", "emby-active-server");
        serverLine.type = "button";
        serverLine.setAttribute("aria-label", `当前 Emby 服务器：${activeServerText}，点击切换`);
        serverLine.append(
          makeToolbarIcon("servers"),
          makeElement("span", "emby-active-server-name", activeServerText)
        );
        serverLine.addEventListener("click", () => {
          rememberScroll();
          embyState.view = "servers";
          renderEmby();
        });
        scroll.append(serverLine);
      }

      const librariesSection = makeElement("section", "emby-section");
      librariesSection.append(makeElement("h3", "emby-section-title", "媒体库"));
      if (embyState.home.views.length) {
        const row = makeElement("div", "emby-row");
        for (const item of embyState.home.views) row.append(makePosterButton(item));
        librariesSection.append(row);
      } else {
        librariesSection.append(makeEmpty("服务器没有可浏览的媒体库"));
      }

      const resumeSection = makeElement("section", "emby-section");
      resumeSection.append(makeElement("h3", "emby-section-title", "继续观看"));
      const resumeItem = embyState.home.resume[0];
      if (resumeItem) {
        const hero = makeElement("button", "emby-media-button emby-hero");
        hero.type = "button";
        const image = makeElement("img");
        image.alt = "";
        bindImage(image, resumeItem, "backdrop");
        const copy = makeElement("span", "emby-hero-copy");
        copy.append(makeElement("span", "emby-hero-name", resumeItem.name || "继续播放"));
        const progress = makeElement("span", "emby-progress");
        const progressFill = makeElement("span");
        progressFill.style.width = `${safePercent(resumeItem.progressPercent)}%`;
        progress.append(progressFill);
        copy.append(progress);
        hero.append(image, copy);
        hero.addEventListener("click", () => openItem(resumeItem));
        resumeSection.append(hero);
      } else {
        resumeSection.append(makeEmpty("还没有可继续观看的内容"));
      }

      const recentSection = makeElement("section", "emby-section");
      recentSection.append(makeElement("h3", "emby-section-title", "最近添加"));
      if (embyState.home.latest.length) {
        const row = makeElement("div", "emby-row");
        for (const item of embyState.home.latest) row.append(makePosterButton(item));
        recentSection.append(row);
      } else {
        recentSection.append(makeEmpty("媒体库暂无视频内容"));
      }
      scroll.append(librariesSection, resumeSection, recentSection);
      view.append(scroll);
      return view;
    };

    const serverTitle = (server) => {
      try {
        return new URL(server?.baseUrl).host || server?.baseUrl || "Emby 服务器";
      } catch {
        return server?.baseUrl || "Emby 服务器";
      }
    };

    // 切换/移除服务器时清空上一台服务器的浏览态，避免把 A 的搜索/剧集/媒体库数据
    // 带进 B 的视图（点进去会用 A 的 item id 去打 B 而报错）。
    const resetEmbyBrowseState = () => {
      embyState.home = { views: [], resume: [], latest: [] };
      embyState.libraryStack = [];
      embyState.libraryItems = [];
      embyState.libraryTotal = 0;
      embyState.libraryLoadingMore = false;
      embyState.searchQuery = "";
      embyState.searchItems = [];
      embyState.searching = false;
      embyState.searchReturnView = "home";
      embyState.seriesItem = null;
      embyState.seriesReturnView = "home";
      embyState.seasons = [];
      embyState.selectedSeasonId = null;
      embyState.episodes = [];
      embyState.sourceOptions = [];
      embyState.previousRoute = null;
      embyState.scrollPositions.clear();
    };

    const switchEmbyServer = async (server) => {
      if (!server?.key) return;
      embyState.loadingLabel = `正在切换到 ${serverTitle(server)}…`;
      resetEmbyBrowseState();
      embyState.view = "loading";
      renderEmby();
      try {
        const result = await rpc("servers.switch", { serverKey: server.key }, { timeoutMs: 20_000 });
        Object.assign(embyState.config, result || {});
        embyState.connected = Boolean(result?.connected);
        await loadServers();
        if (embyState.connected) await loadHome(false);
        else {
          embyState.addingServer = false;
          embyState.inlineError = "这个服务器的登录已失效，请重新输入密码";
          embyState.view = "disconnected";
          renderEmby();
        }
      } catch (errorValue) {
        showError(errorValue, () => switchEmbyServer(server), "servers");
      }
    };

    const removeCurrentEmbyServer = async () => {
      const server = embyState.servers.find((entry) => entry.active);
      if (!server?.key) return;
      if (!confirm(`移除 ${serverTitle(server)}（${server.username || "未知用户"}）？`)) return;
      embyState.loadingLabel = `正在移除 ${serverTitle(server)}…`;
      resetEmbyBrowseState();
      embyState.view = "loading";
      renderEmby();
      try {
        const result = await rpc("servers.remove", { serverKey: server.key }, { timeoutMs: 20_000 });
        Object.assign(embyState.config, result || {});
        embyState.connected = Boolean(result?.connected);
        await loadServers();
        if (embyState.connected) await loadHome(false);
        else {
          embyState.view = embyState.servers.length > 0 ? "servers" : "disconnected";
          renderEmby();
        }
      } catch (errorValue) {
        showError(errorValue, removeCurrentEmbyServer, "servers");
      }
    };

    const renderServers = () => {
      const view = makeElement("div", "emby-view");
      view.dataset.view = "servers";
      view.append(makeToolbar("Emby 服务器", {
        back: () => {
          embyState.view = embyState.connected ? "home" : "disconnected";
          renderEmby();
        }
      }));
      const scroll = makeElement("div", "emby-scroll emby-server-list");
      for (const server of embyState.servers) {
        const button = makeElement("button", "emby-list-button");
        button.type = "button";
        button.setAttribute("aria-current", String(Boolean(server.active)));
        const dot = makeElement("span", `emby-server-dot${server.connected ? " connected" : ""}`);
        const copy = makeElement("span", "emby-list-copy");
        copy.append(
          makeElement("span", "emby-list-name", serverTitle(server)),
          makeElement("span", "emby-list-meta", `${server.username || "未知用户"}${server.active ? " · 当前" : ""}${server.connected ? "" : " · 需登录"}`)
        );
        button.append(dot, copy);
        button.addEventListener("click", () => switchEmbyServer(server));
        scroll.append(button);
      }
      if (!embyState.servers.length) scroll.append(makeEmpty("还没有保存的 Emby 服务器"));
      const actions = makeElement("div", "emby-server-actions");
      const add = makeElement("button", "emby-button primary", "添加 Emby 服务器");
      add.type = "button";
      add.addEventListener("click", () => {
        embyState.addingServer = true;
        embyState.pendingServerInput = "";
        embyState.pendingUsernameInput = "";
        embyState.inlineError = "";
        embyState.view = "disconnected";
        renderEmby();
      });
      actions.append(add);
      if (embyState.connected) {
        const disconnect = makeElement("button", "emby-button", "退出当前服务器");
        disconnect.type = "button";
        disconnect.addEventListener("click", logoutEmby);
        actions.append(disconnect);
      }
      if (embyState.servers.some((server) => server.active)) {
        const remove = makeElement("button", "emby-button danger", "移除当前服务器");
        remove.type = "button";
        remove.addEventListener("click", removeCurrentEmbyServer);
        actions.append(remove);
      }
      view.append(scroll, actions);
      return view;
    };

    const loadLibrary = async (folder, { append = false, stack = null } = {}) => {
      if (!folder?.id) return;
      const previousView = embyState.view;
      const startIndex = append ? embyState.libraryItems.length : 0;
      if (append) {
        embyState.libraryLoadingMore = true;
        renderEmby();
      } else {
        embyState.loadingLabel = `正在加载 ${folder.name || "媒体库"}…`;
        embyState.view = "loading";
        renderEmby();
      }
      try {
        const result = await rpc("library.get", { parentId: folder.id, startIndex, limit: 60 });
        if (disposed) return;
        if (stack) embyState.libraryStack = stack;
        const items = Array.isArray(result?.items) ? result.items : [];
        embyState.libraryItems = append ? [...embyState.libraryItems, ...items] : items;
        embyState.libraryTotal = Math.max(embyState.libraryItems.length, Number(result?.totalRecordCount) || 0);
        embyState.libraryLoadingMore = false;
        embyState.view = "library";
        renderEmby();
      } catch (errorValue) {
        embyState.libraryLoadingMore = false;
        showError(errorValue, () => loadLibrary(folder, { append, stack }), previousView);
      }
    };

    const renderLibrary = () => {
      const view = makeElement("div", "emby-view");
      view.dataset.view = "library";
      const folder = embyState.libraryStack.at(-1);
      view.append(makeToolbar(folder?.name || "媒体库", {
        back: () => {
          rememberScroll();
          if (embyState.libraryStack.length <= 1) {
            embyState.libraryStack = [];
            embyState.view = "home";
            renderEmby();
            return;
          }
          const stack = embyState.libraryStack.slice(0, -1);
          loadLibrary(stack.at(-1), { stack });
        },
        search: () => {
          rememberScroll();
          embyState.searchReturnView = "library";
          embyState.view = "search";
          renderEmby({ focusSearch: true });
        }
      }));
      const grid = makeElement("div", "emby-scroll emby-library-grid");
      grid.dataset.scrollKey = `library:${folder?.id || "unknown"}`;
      for (const item of embyState.libraryItems) grid.append(makePosterButton(item));
      if (!embyState.libraryItems.length) grid.append(makeEmpty("这个媒体库暂无内容"));
      if (embyState.libraryItems.length < embyState.libraryTotal) {
        const more = makeElement("button", "emby-button emby-load-more", embyState.libraryLoadingMore ? "加载中…" : "加载更多");
        more.type = "button";
        more.disabled = embyState.libraryLoadingMore;
        more.addEventListener("click", () => loadLibrary(folder, { append: true }));
        grid.append(more);
      }
      view.append(grid);
      return view;
    };

    const makeResultButton = (item) => {
      const button = makeElement("button", "emby-list-button");
      button.type = "button";
      const poster = makeElement("span", "emby-list-poster", "Emby");
      const image = makeElement("img");
      image.alt = "";
      bindImage(image, item);
      poster.append(image);
      const copy = makeElement("span", "emby-list-copy");
      copy.append(
        makeElement("span", "emby-list-name", item.name || "未命名"),
        makeElement("span", "emby-list-meta", itemMeta(item))
      );
      button.append(poster, copy);
      button.addEventListener("click", () => openItem(item));
      return button;
    };

    // 原地刷新搜索结果与状态行，不重建整个视图 —— 关键是不销毁正在输入的 <input>，
    // 否则会打断 IME 组词并把光标跳到末尾。仅当搜索视图已挂载时用它；否则退回整渲染。
    const updateSearchResults = () => {
      if (embyState.view !== "search") {
        renderEmby({ focusSearch: true });
        return;
      }
      const results = embyApp.querySelector(".emby-results");
      const status = embyApp.querySelector(".emby-search-status");
      if (!results) {
        renderEmby({ focusSearch: true });
        return;
      }
      if (status) {
        status.textContent = embyState.searching
          ? "搜索中…"
          : embyState.searchQuery.trim().length < 2
            ? "输入至少 2 个字符"
            : `${embyState.searchItems.length} 条结果`;
      }
      results.dataset.scrollKey = `search:${embyState.searchQuery}`;
      const children = embyState.searchItems.map((item) => makeResultButton(item));
      if (embyState.searchQuery.trim().length >= 2 && !embyState.searching && !embyState.searchItems.length) {
        children.push(makeEmpty("没有找到匹配内容"));
      }
      results.replaceChildren(...children);
    };

    const runSearch = async (query) => {
      const generation = ++searchGeneration;
      if (searchRequestId) {
        cancelRpc(searchRequestId, true);
        searchRequestId = null;
      }
      if (query.trim().length < 2) {
        embyState.searchItems = [];
        embyState.searching = false;
        updateSearchResults();
        return;
      }
      embyState.searching = true;
      const status = embyApp.querySelector(".emby-search-status");
      if (status) status.textContent = "搜索中…";
      const request = requestRpc("search", { query: query.trim(), limit: 30 });
      searchRequestId = request.id;
      try {
        const result = await request.promise;
        if (disposed || generation !== searchGeneration || embyState.view !== "search") return;
        embyState.searchItems = Array.isArray(result?.items) ? result.items.slice(0, 30) : [];
        embyState.searching = false;
        updateSearchResults();
      } catch (errorValue) {
        if (generation !== searchGeneration || disposed) return;
        embyState.searching = false;
        showError(errorValue, () => runSearch(embyState.searchQuery), "search");
      } finally {
        if (searchRequestId === request.id) searchRequestId = null;
      }
    };

    const renderSearch = () => {
      const view = makeElement("div", "emby-view");
      view.dataset.view = "search";
      const toolbar = makeElement("header", "emby-toolbar");
      const goBack = () => {
        if (searchTimer) clearTimeout(searchTimer);
        if (searchRequestId) {
          cancelRpc(searchRequestId, true);
          searchRequestId = null;
        }
        searchGeneration += 1;
        rememberScroll();
        embyState.view = embyState.searchReturnView === "library" ? "library" : "home";
        renderEmby();
      };
      const handleInput = (query) => {
        embyState.searchQuery = query;
        if (searchTimer) clearTimeout(searchTimer);
        searchGeneration += 1;
        if (searchRequestId) {
          cancelRpc(searchRequestId, true);
          searchRequestId = null;
        }
        embyState.searching = false;
        const status = embyApp.querySelector(".emby-search-status");
        if (query.trim().length < 2) {
          embyState.searchItems = [];
          if (status) status.textContent = "输入至少 2 个字符";
          const results = embyApp.querySelector(".emby-results");
          results?.replaceChildren();
          return;
        }
        if (status) status.textContent = "等待输入完成…";
        searchTimer = setTimeout(() => runSearch(embyState.searchQuery), 300);
      };
      const { form } = makeSearchField({
        value: embyState.searchQuery,
        onInput: handleInput,
        onSubmit: (query) => {
          embyState.searchQuery = query;
          if (searchTimer) clearTimeout(searchTimer);
          runSearch(query);
        },
        onEscape: goBack
      });
      toolbar.append(makeIconButton("返回首页", "back", goBack), form);
      view.append(toolbar);
      const status = makeElement(
        "div",
        "emby-search-status emby-muted",
        embyState.searching
          ? "搜索中…"
          : embyState.searchQuery.trim().length < 2
            ? "输入至少 2 个字符"
            : `${embyState.searchItems.length} 条结果`
      );
      view.append(status);
      const scroll = makeElement("div", "emby-scroll emby-results");
      scroll.dataset.scrollKey = `search:${embyState.searchQuery}`;
      for (const item of embyState.searchItems) scroll.append(makeResultButton(item));
      if (embyState.searchQuery.trim().length >= 2 && !embyState.searching && !embyState.searchItems.length) {
        scroll.append(makeEmpty("没有找到匹配内容"));
      }
      view.append(scroll);
      return view;
    };

    const loadSeries = async (item, seasonId = null) => {
      rememberScroll();
      const previousView = embyState.view;
      if (!seasonId && ["home", "search", "library"].includes(previousView)) {
        embyState.seriesReturnView = previousView;
      }
      embyState.loadingLabel = seasonId ? "正在加载选集…" : "正在加载剧集…";
      embyState.view = "loading";
      renderEmby();
      try {
        const result = await rpc("series.get", { seriesId: item.id, seasonId });
        if (disposed) return;
        embyState.seriesItem = item;
        embyState.seasons = Array.isArray(result?.seasons) ? result.seasons : [];
        embyState.selectedSeasonId = result?.selectedSeasonId || seasonId || embyState.seasons[0]?.id || null;
        embyState.episodes = Array.isArray(result?.episodes) ? result.episodes : [];
        embyState.sourceOptions = Array.isArray(result?.sourceOptions) ? result.sourceOptions : [];
        embyState.view = "series";
        renderEmby();
      } catch (errorValue) {
        showError(errorValue, () => loadSeries(item, seasonId), previousView);
      }
    };

    const renderSeries = () => {
      const view = makeElement("div", "emby-view");
      view.dataset.view = "series";
      view.append(makeToolbar("剧集与选集", {
        back: () => {
          rememberScroll();
          embyState.view = ["search", "library"].includes(embyState.seriesReturnView)
            ? embyState.seriesReturnView
            : "home";
          renderEmby();
        }
      }));
      const visual = makeElement("div", "emby-series-visual");
      const image = makeElement("img");
      image.alt = "";
      bindImage(image, embyState.seriesItem, "backdrop");
      visual.append(image, makeElement("div", "emby-series-title", embyState.seriesItem?.name || "剧集"));
      view.append(visual);
      const chips = makeElement("div", "emby-chips");
      for (const season of embyState.seasons) {
        const chip = makeElement("button", "emby-chip", season.name || `第 ${season.indexNumber || "?"} 季`);
        chip.type = "button";
        chip.setAttribute("aria-selected", String(season.id === embyState.selectedSeasonId));
        chip.addEventListener("click", () => {
          if (season.id !== embyState.selectedSeasonId) loadSeries(embyState.seriesItem, season.id);
        });
        chips.append(chip);
      }
      view.append(chips);
      // 选源 chips：仅当该剧有多个可选源时显示。推荐项由后端按最高画质档、
      // 字幕可用性与端到端播放成本统一计算；用户点选后记入按 seriesId 的会话偏好。
      if (embyState.sourceOptions.length > 1) {
        const seriesId = embyState.seriesItem?.id;
        const recommended = embyState.sourceOptions.find((option) => option.recommended)
          ?? embyState.sourceOptions.find((option) => option.hasSubtitles)
          ?? embyState.sourceOptions[0];
        const activeKey = preferredSourceKey(seriesId) ?? recommended?.sourceKey;
        const sourceChips = makeElement("div", "emby-chips emby-source-chips");
        for (const option of embyState.sourceOptions) {
          const chip = makeElement("button", "emby-chip emby-source-chip", option.label || option.sourceKey);
          chip.type = "button";
          chip.dataset.sourceKey = option.sourceKey;
          chip.setAttribute("aria-selected", String(option.sourceKey === activeKey));
          if (!option.hasSubtitles) chip.title = "该源没有字幕";
          chip.addEventListener("click", () => {
            if (preferredSourceKey(seriesId) === option.sourceKey) return;
            rememberSourcePreference(seriesId, option.sourceKey);
            renderEmby();
          });
          sourceChips.append(chip);
        }
        view.append(sourceChips);
      }
      const scroll = makeElement("div", "emby-scroll emby-episodes");
      scroll.dataset.scrollKey = `series:${embyState.seriesItem?.id || "unknown"}:${embyState.selectedSeasonId || "all"}`;
      if (!embyState.episodes.length) scroll.append(makeEmpty("这一季暂无可播放单集"));
      for (const episode of embyState.episodes) {
        const button = makeElement("button", "emby-list-button emby-episode-button");
        button.type = "button";
        button.append(makeElement("span", "emby-episode-index", episode.indexNumber ? `E${episode.indexNumber}` : "▶"));
        const copy = makeElement("span", "emby-list-copy");
        copy.append(
          makeElement("span", "emby-list-name", episode.name || `第 ${episode.indexNumber || "?"} 集`),
          makeElement("span", "emby-list-meta", [formatDuration(episode.runtimeTicks), episode.played ? "已看" : ""].filter(Boolean).join(" · "))
        );
        if (safePercent(episode.progressPercent) > 0) {
          const progress = makeElement("span", "emby-episode-progress");
          const fill = makeElement("span");
          fill.style.width = `${safePercent(episode.progressPercent)}%`;
          progress.append(fill);
          copy.append(progress);
        }
        button.append(copy);
        button.addEventListener("click", () => beginPlayback(episode));
        scroll.append(button);
      }
      view.append(scroll);
      return view;
    };

    // Codex 的 app:// 主页面通过 CSP 禁止连接 127.0.0.1。HLS 数据因此由
    // Companion 代拉，再以 Runtime.callFunctionOn arguments 返回；Base64 不会
    // 被编译成匿名脚本，避免旧 Runtime.evaluate 路径的 ScriptStore 泄漏。
    class EmbyHlsLoader {
      constructor() {
        this.context = null;
        this.callbacks = null;
        this.requestId = null;
        this.aborted = false;
        this.stats = {
          aborted: false,
          loaded: 0,
          total: 0,
          retry: 0,
          chunkCount: 0,
          bwEstimate: 0,
          loading: { start: 0, first: 0, end: 0 },
          parsing: { start: 0, end: 0 },
          buffering: { start: 0, first: 0, end: 0 }
        };
        this.settled = false;
      }

      load(context, loaderConfig, callbacks) {
        this.context = context;
        this.callbacks = callbacks;
        this.aborted = false;
        this.settled = false;
        const now = performance.now();
        Object.assign(this.stats, {
          aborted: false,
          loaded: 0,
          total: 0,
          retry: 0,
          chunkCount: 0,
          bwEstimate: 0,
          loading: { start: now, first: 0, end: 0 },
          parsing: { start: 0, end: 0 },
          buffering: { start: 0, first: 0, end: 0 }
        });
        const request = requestRpc("resource.load", {
          url: context.url,
          responseType: context.responseType === "arraybuffer" ? "arraybuffer" : "text",
          resourceType: "hls"
        }, { timeoutMs: Math.max(30_000, Number(loaderConfig?.timeout || 0)) });
        this.requestId = request.id;
        request.promise.then((result) => {
          if (this.aborted) return;
          const bytes = responseBytes(result);
          const isArrayBuffer = context.responseType === "arraybuffer";
          const data = isArrayBuffer
            ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
            : result?.encoding === "base64"
              ? new TextDecoder().decode(bytes)
              : String(result?.data ?? "");
          const end = performance.now();
          this.stats.loaded = isArrayBuffer ? bytes.byteLength : new TextEncoder().encode(data).byteLength;
          this.stats.total = this.stats.loaded;
          this.stats.chunkCount = 1;
          this.stats.loading.first = end;
          this.stats.loading.end = end;
          this.settled = true;
          this.requestId = null;
          callbacks.onSuccess(
            { url: result?.url || context.url, data },
            this.stats,
            context,
            { code: 200, text: "OK" }
          );
        }).catch((errorValue) => {
          if (this.aborted) return;
          this.settled = true;
          this.requestId = null;
          callbacks.onError(
            { code: 0, text: toRpcError(errorValue).message },
            context,
            null,
            this.stats
          );
        });
      }

      abort() {
        if (this.aborted || this.settled) return;
        this.aborted = true;
        this.settled = true;
        this.stats.aborted = true;
        if (this.requestId) cancelRpc(this.requestId, true);
        this.callbacks?.onAbort?.(this.stats, this.context, null);
      }

      destroy() {
        this.abort();
        this.context = null;
        this.callbacks = null;
      }

      getCacheAge() {
        return null;
      }
    }

    const currentEmbyVideo = () => {
      const local = embyApp.querySelector(".emby-video");
      if (local) return local;
      const frame = embyApp.querySelector(".emby-video-frame");
      try {
        return frame?.contentDocument?.querySelector("video") ?? null;
      } catch {
        return null;
      }
    };

    const playbackPayload = (eventName) => {
      const playback = embyState.playback;
      const embyVideo = currentEmbyVideo();
      if (!playback) return null;
      return {
        playbackId: playback.playbackId,
        itemId: playback.itemId,
        mediaSourceId: playback.mediaSourceId,
        playSessionId: playback.playSessionId,
        positionTicks: Math.max(0, Math.round(Number(embyVideo?.currentTime || 0) * 10_000_000)),
        isPaused: Boolean(embyVideo?.paused),
        isMuted: Boolean(embyVideo?.muted),
        volumeLevel: Math.max(0, Math.min(100, Math.round(Number(embyVideo?.volume ?? 1) * 100))),
        event: eventName
      };
    };

    const reportProgress = (eventName) => {
      if (disposed || playbackStopping || !embyState.playback) return;
      const payload = playbackPayload(eventName);
      if (payload) rpc("playback.progress", payload, { timeoutMs: 5_000 }).catch(() => {});
    };

    const setSubtitleStatus = (message = "") => {
      const status = embyApp.querySelector(".emby-subtitle-status");
      if (!status) return;
      status.textContent = message;
      status.hidden = !message;
    };

    const releaseSubtitleTrack = (video = currentEmbyVideo()) => {
      if (subtitleRequestId) cancelRpc(subtitleRequestId, true);
      subtitleRequestId = null;
      if (video) {
        for (const textTrack of video.textTracks || []) textTrack.mode = "disabled";
        for (const track of video.querySelectorAll("track[data-emby-subtitle]")) track.remove();
      }
      if (subtitleObjectUrl) URL.revokeObjectURL(subtitleObjectUrl);
      subtitleObjectUrl = null;
    };

    const subtitleDescription = (subtitle) => {
      const flags = [];
      if (subtitle?.isForced) flags.push("强制");
      if (subtitle?.isHearingImpaired) flags.push("听障");
      if (subtitle?.isExternal) flags.push("外挂");
      return flags.join(" · ");
    };

    const rememberSubtitlePreference = (subtitle) => {
      subtitlePreference = subtitle
        ? {
            off: false,
            language: subtitle.language || "und",
            isForced: Boolean(subtitle.isForced),
            isHearingImpaired: Boolean(subtitle.isHearingImpaired)
          }
        : { off: true };
    };

    const preferredSubtitleIndex = (subtitles) => {
      if (!subtitlePreference) return undefined;
      if (subtitlePreference.off) return null;
      const exact = subtitles.find((subtitle) => (
        subtitle.language === subtitlePreference.language
        && Boolean(subtitle.isForced) === subtitlePreference.isForced
        && Boolean(subtitle.isHearingImpaired) === subtitlePreference.isHearingImpaired
      ));
      return (exact ?? subtitles.find((subtitle) => subtitle.language === subtitlePreference.language))?.index;
    };

    const rememberSourcePreference = (seriesId, sourceKey) => {
      if (!seriesId || !sourceKey) return;
      sourcePreferences.set(String(seriesId), String(sourceKey));
    };

    const preferredSourceKey = (seriesId) => {
      if (!seriesId) return undefined;
      return sourcePreferences.get(String(seriesId));
    };

    const syncSubtitleControls = (playback) => {
      const selected = playback?.selectedSubtitleIndex;
      const button = embyApp.querySelector(".emby-subtitle-button");
      const track = playback?.subtitles?.find((subtitle) => subtitle.index === selected);
      if (button) {
        button.title = track ? `字幕：${track.label}` : "字幕：关闭";
        button.setAttribute("aria-label", button.title);
      }
      for (const option of embyApp.querySelectorAll(".emby-subtitle-option")) {
        const value = option.dataset.subtitleIndex === "off"
          ? null
          : Number(option.dataset.subtitleIndex);
        option.setAttribute("aria-checked", String(value === selected));
      }
    };

    const applyExternalSubtitle = async (video, playback) => {
      releaseSubtitleTrack(video);
      if (playback.subtitleMode !== "external-vtt" || !Number.isSafeInteger(playback.selectedSubtitleIndex)) {
        syncSubtitleControls(playback);
        return;
      }
      const subtitle = playback.subtitles?.find((candidate) => candidate.index === playback.selectedSubtitleIndex);
      if (!subtitle) return;
      setSubtitleStatus("正在加载字幕…");
      const request = requestRpc("playback.subtitle.load", {
        playbackId: playback.playbackId,
        subtitleStreamIndex: subtitle.index
      }, { timeoutMs: 20_000 });
      subtitleRequestId = request.id;
      try {
        const result = await request.promise;
        if (disposed || embyState.playback !== playback || subtitleRequestId !== request.id) return;
        subtitleRequestId = null;
        const blob = new Blob([String(result?.data ?? "")], { type: "text/vtt;charset=utf-8" });
        subtitleObjectUrl = URL.createObjectURL(blob);
        const track = document.createElement("track");
        track.dataset.embySubtitle = "true";
        track.kind = "subtitles";
        track.label = subtitle.label;
        track.srclang = subtitle.language || "und";
        track.src = subtitleObjectUrl;
        track.default = true;
        video.append(track);
        track.track.mode = "showing";
        setSubtitleStatus("");
        syncSubtitleControls(playback);
      } catch (errorValue) {
        if (subtitleRequestId === request.id) subtitleRequestId = null;
        if (disposed || embyState.playback !== playback) return;
        playback.selectedSubtitleIndex = null;
        playback.subtitleMode = "off";
        rememberSubtitlePreference(null);
        rpc("playback.subtitle.select", {
          playbackId: playback.playbackId,
          subtitleStreamIndex: null,
          positionTicks: Math.max(0, Math.round(Number(video.currentTime || 0) * 10_000_000))
        }, { timeoutMs: 10_000 }).catch(() => {});
        setSubtitleStatus(`字幕加载失败：${toRpcError(errorValue).message}`);
        syncSubtitleControls(playback);
      }
    };

    const teardownPlaybackMedia = () => {
      activeHls?.destroy?.();
      activeHls = null;
      activeDirectPlayer?.destroy?.();
      activeDirectPlayer = null;
      const video = currentEmbyVideo();
      releaseSubtitleTrack(video);
      if (video) {
        video.pause();
        video.removeAttribute("src");
        video.load();
      }
      const frame = embyApp.querySelector(".emby-video-frame");
      if (frame) frame.src = "about:blank";
    };

    const switchEmbySubtitle = async (subtitleStreamIndex) => {
      if (subtitleSwitching || !embyState.playback) return;
      const playback = embyState.playback;
      const video = currentEmbyVideo();
      if (!video) return;
      const subtitle = subtitleStreamIndex === null
        ? null
        : playback.subtitles?.find((candidate) => candidate.index === subtitleStreamIndex);
      if (subtitleStreamIndex !== null && !subtitle) return;
      if (playback.mediaReady !== true) {
        playback.pendingSubtitleSelection = subtitleStreamIndex;
        playback.pendingSubtitlePaused = playback.restorePlaybackState?.paused ?? false;
        setSubtitleStatus("视频准备完成后切换字幕…");
        return;
      }
      const previous = {
        index: playback.selectedSubtitleIndex,
        mode: playback.subtitleMode
      };
      const restorePlaybackState = {
        paused: Object.prototype.hasOwnProperty.call(playback, "pendingSubtitlePaused")
          ? playback.pendingSubtitlePaused
          : video.paused,
        volume: video.volume,
        muted: video.muted,
        currentTime: Number(video.currentTime || 0)
      };
      delete playback.pendingSubtitlePaused;
      subtitleSwitching = true;
      setSubtitleStatus(subtitle?.mode === "burn-in" || previous.mode === "burn-in"
        ? "正在切换字幕并恢复播放…"
        : "正在切换字幕…");
      try {
        const result = await rpc("playback.subtitle.select", {
          playbackId: playback.playbackId,
          subtitleStreamIndex,
          positionTicks: Math.max(0, Math.round(restorePlaybackState.currentTime * 10_000_000))
        }, { timeoutMs: 65_000 });
        if (disposed || embyState.playback !== playback) return;
        Object.assign(playback, result);
        rememberSubtitlePreference(subtitle);
        if (result.restartRequired) {
          playback.restorePlaybackState = restorePlaybackState;
          playback.mediaReady = false;
          if (progressTimer) clearInterval(progressTimer);
          progressTimer = null;
          teardownPlaybackMedia();
          renderEmby();
        } else if (playback.subtitleMode === "external-vtt") {
          await applyExternalSubtitle(video, playback);
        } else {
          releaseSubtitleTrack(video);
          setSubtitleStatus("");
          syncSubtitleControls(playback);
        }
      } catch (errorValue) {
        playback.selectedSubtitleIndex = previous.index;
        playback.subtitleMode = previous.mode;
        setSubtitleStatus(`字幕切换失败：${toRpcError(errorValue).message}`);
        syncSubtitleControls(playback);
      } finally {
        subtitleSwitching = false;
      }
    };

    const canCreateBlobWorker = () => {
      if (typeof Worker !== "function") return false;
      let workerUrl = null;
      let worker = null;
      try {
        workerUrl = URL.createObjectURL(new Blob(["self.close();"], { type: "text/javascript" }));
        worker = new Worker(workerUrl);
        return true;
      } catch {
        return false;
      } finally {
        worker?.terminate?.();
        if (workerUrl) URL.revokeObjectURL(workerUrl);
      }
    };

    const reportWorkerFallback = () => {
      if (workerFallbackReported) return;
      workerFallbackReported = true;
      console.warn("[codex-companion] HLS Blob Worker 不可用，已降级到主线程解码");
    };

    const activatePlaybackState = (video, playback) => {
      const restore = playback.restorePlaybackState;
      if (restore) {
        video.volume = Math.max(0, Math.min(1, Number(restore.volume ?? 1)));
        video.muted = Boolean(restore.muted);
        const currentTime = Number(restore.currentTime);
        if (Number.isFinite(currentTime) && currentTime > 0) video.currentTime = currentTime;
      }
      delete playback.restorePlaybackState;
      playback.mediaReady = true;
      if (!restore?.paused) video.play().catch(() => {});
      if (Object.prototype.hasOwnProperty.call(playback, "pendingSubtitleSelection")) {
        const pendingSubtitleSelection = playback.pendingSubtitleSelection;
        delete playback.pendingSubtitleSelection;
        queueMicrotask(() => {
          if (!disposed && embyState.playback === playback) {
            void switchEmbySubtitle(pendingSubtitleSelection);
          }
        });
        return;
      }
      if (playback.subtitleMode === "external-vtt") {
        void applyExternalSubtitle(video, playback);
      } else {
        releaseSubtitleTrack(video);
        syncSubtitleControls(playback);
        setSubtitleStatus("");
      }
    };

    const requireLoopbackMediaUrl = (value) => {
      try {
        const url = new URL(String(value ?? ""));
        const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
        const safePath = new RegExp(`^/hls/${uuid}/.+`, "i").test(url.pathname);
        if (
          url.protocol !== "http:"
          || url.hostname !== "127.0.0.1"
          || !url.port
          || url.username
          || url.password
          || url.hash
          || !safePath
        ) throw new Error("unsafe loopback URL");
        return url.href;
      } catch {
        return null;
      }
    };

    const configureLoopbackVideoFrame = async (frame, playback, proxyUrl) => {
      // app:// 主文档的 CSP 禁止 media-src 127.0.0.1；同源 blob 子文档不会继承
      // 这条主文档策略。把原生 <video> 放进无脚本 blob iframe 后，媒体 Range
      // 直接流经 loopback HTTP，不再把 Base64 分片塞进 CDP/Renderer 堆。
      const frameSource = [
        "<!doctype html><meta charset=\"utf-8\">",
        "<style>",
        "html,body{width:100%;height:100%;margin:0;overflow:hidden;background:#000}",
        "video{display:block;width:100%;height:100%;object-fit:contain;background:#000}",
        "video::cue{color:#fff;background:rgba(0,0,0,.72);font-family:-apple-system,system-ui,sans-serif;font-size:min(4.5vh,44px);text-shadow:0 1px 2px #000,0 0 2px #000}",
        "video::-webkit-media-controls-toggle-closed-captions-button,video::-webkit-media-controls-fullscreen-button{display:none}",
        "</style><video controls playsinline preload=\"metadata\"></video>"
      ].join("");
      const frameUrl = URL.createObjectURL(new Blob([frameSource], { type: "text/html;charset=utf-8" }));
      try {
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => finish(reject, rpcError("MEDIA_FRAME_TIMEOUT", "原生媒体容器启动超时", true)), 10_000);
          const finish = (callback, value) => {
            clearTimeout(timeout);
            frame.removeEventListener("load", onLoad);
            frame.removeEventListener("error", onError);
            callback(value);
          };
          const onLoad = () => finish(resolve);
          const onError = () => finish(reject, rpcError("MEDIA_FRAME_FAILED", "原生媒体容器启动失败", true));
          frame.addEventListener("load", onLoad, { once: true });
          frame.addEventListener("error", onError, { once: true });
          frame.src = frameUrl;
        });
      } finally {
        URL.revokeObjectURL(frameUrl);
      }
      if (disposed || !frame.isConnected || embyState.playback !== playback) {
        throw rpcError("ABORTED", "播放器已经关闭");
      }
      let video = null;
      try {
        video = frame.contentDocument?.querySelector("video") ?? null;
      } catch {}
      if (!video) throw rpcError("MEDIA_FRAME_FAILED", "原生媒体容器中没有视频元素", true);
      video.disablePictureInPicture = true;
      video.src = proxyUrl;
      video.load();
      await new Promise((resolve, reject) => {
        if (video.readyState >= 1) {
          resolve();
          return;
        }
        const timeout = setTimeout(() => finish(reject, rpcError("MEDIA_METADATA_TIMEOUT", "视频元数据加载超时", true)), 30_000);
        const finish = (callback, value) => {
          clearTimeout(timeout);
          video.removeEventListener("loadedmetadata", onMetadata);
          video.removeEventListener("error", onError);
          callback(value);
        };
        const onMetadata = () => finish(resolve);
        const onError = () => finish(
          reject,
          rpcError("MEDIA_LOAD_FAILED", video.error?.message || "原生视频加载失败", true)
        );
        video.addEventListener("loadedmetadata", onMetadata, { once: true });
        video.addEventListener("error", onError, { once: true });
      });
      const startTime = Number(playback.startPositionTicks || 0) / 10_000_000;
      if (Number.isFinite(startTime) && startTime > 0) video.currentTime = startTime;
      return video;
    };

    const configureHls = (embyVideo, playback) => {
      const Hls = globalThis.Hls;
      if (typeof Hls !== "function" || (typeof Hls.isSupported === "function" && !Hls.isSupported())) {
        throw rpcError("HLS_UNAVAILABLE", "当前 Renderer 无法启动 HLS 播放器");
      }
      const startSeconds = Number(playback.startPositionTicks || 0) / 10_000_000;
      const enableWorker = canCreateBlobWorker();
      if (!enableWorker) reportWorkerFallback();
      // app:// 页面 CSP 明确禁止 connect-src 127.0.0.1；在 Codex 内直接走有界 RPC
      // loader。其他宿主若允许 loopback，可继续使用本地代理并保留一次降级能力。
      const hlsProxyUrl = location.protocol === "app:"
        ? null
        : requireLoopbackMediaUrl(playback.hlsProxyUrl);
      const useHlsProxy = Boolean(hlsProxyUrl) && playback.hlsProxyFallback !== true;
      const hlsOptions = {
        enableWorker,
        maxBufferLength: 30,
        maxMaxBufferLength: 30,
        backBufferLength: 15,
        maxBufferSize: 24 * 1024 * 1024,
        capLevelToPlayerSize: true,
        startPosition: startSeconds > 0 && Number.isFinite(startSeconds) ? startSeconds : -1
      };
      if (!useHlsProxy) {
        hlsOptions.loader = EmbyHlsLoader;
        hlsOptions.pLoader = EmbyHlsLoader;
        hlsOptions.fLoader = EmbyHlsLoader;
      }
      try {
        activeHls = new Hls(hlsOptions);
      } catch {
        reportWorkerFallback();
        activeHls = new Hls({ ...hlsOptions, enableWorker: false });
      }
      if (typeof activeHls.on === "function" && Hls.Events?.MANIFEST_PARSED) {
        activeHls.on(Hls.Events.MANIFEST_PARSED, () => {
          const cappedIndex = Array.isArray(activeHls.levels)
            ? activeHls.levels.reduce((best, level, index) => Number(level?.height || 0) <= 720 ? index : best, -1)
            : -1;
          if (cappedIndex >= 0) activeHls.autoLevelCapping = cappedIndex;
          if (startSeconds > 0 && Number.isFinite(startSeconds)) embyVideo.currentTime = startSeconds;
          activatePlaybackState(embyVideo, playback);
        });
      }
      if (typeof activeHls.on === "function" && Hls.Events?.ERROR) {
        // 致命错误优先尝试 hls.js 的原地恢复，而不是直接拆毁播放器：瞬时 CDN/分片抖动
        // 用 startLoad() 续流、解码卡顿用 recoverMediaError() 通常能无缝恢复。每种恢复
        // 各有次数预算，耗尽或遇到不可恢复错误才回退到全屏错误 + 手动重试。
        let networkRecoveries = 0;
        let mediaRecoveries = 0;
        const MAX_NETWORK_RECOVERIES = 4;
        const MAX_MEDIA_RECOVERIES = 2;
        const hls = activeHls;
        activeHls.on(Hls.Events.ERROR, (_event, data) => {
          if (data?.event === "demuxerWorker") reportWorkerFallback();
          const ErrorTypes = Hls.ErrorTypes || {};
          if (
            useHlsProxy
            && !playback.hlsProxyFallback
            && data?.type === ErrorTypes.NETWORK_ERROR
            && !data?.frag
            && !playbackStopping
            && !subtitleSwitching
            && activeHls === hls
          ) {
            playback.hlsProxyFallback = true;
            const resumeSeconds = Number(embyVideo.currentTime || 0);
            if (Number.isFinite(resumeSeconds) && resumeSeconds > 0) {
              playback.startPositionTicks = Math.round(resumeSeconds * 10_000_000);
            }
            try { hls.destroy(); } catch { /* 忽略销毁异常 */ }
            if (activeHls === hls) activeHls = null;
            configureHls(embyVideo, playback);
            return;
          }
          if (!data?.fatal || playbackStopping || subtitleSwitching || activeHls !== hls) return;
          if (data.type === ErrorTypes.NETWORK_ERROR && networkRecoveries < MAX_NETWORK_RECOVERIES) {
            networkRecoveries += 1;
            try { hls.startLoad(); return; } catch { /* 落到下方全屏错误 */ }
          } else if (data.type === ErrorTypes.MEDIA_ERROR && mediaRecoveries < MAX_MEDIA_RECOVERIES) {
            mediaRecoveries += 1;
            try { hls.recoverMediaError(); return; } catch { /* 落到下方全屏错误 */ }
          }
          showError(
            rpcError("HLS_FATAL", "视频流播放失败，请返回后重试", true),
            () => beginPlayback(playback.item, true),
            embyState.previousRoute?.view || "home"
          );
        });
      }
      activeHls.attachMedia(embyVideo);
      activeHls.loadSource(useHlsProxy ? hlsProxyUrl : playback.hlsUrl);
    };

    const configureDirectMp4Stream = async (embyVideo, playback, {
      rpcPrefix,
      setActivePlayer,
      clearActivePlayer,
      isStopping,
      onFailure,
      onQuotaExceeded
    }) => {
      if (typeof MediaSource !== "function" || typeof MediaSource.isTypeSupported !== "function") {
        throw rpcError("MSE_UNAVAILABLE", "当前 Renderer 不支持 MediaSource 播放");
      }
      const mediaSource = new MediaSource();
      const objectUrl = URL.createObjectURL(mediaSource);
      let resolveInitialBuffer;
      const initialBufferReady = new Promise((resolve) => { resolveInitialBuffer = resolve; });
      const requestedInitialBuffer = Number(playback?.initialBufferSeconds);
      const defaultInitialBuffer = rpcPrefix === "playback.direct"
        ? (playback?.streamMode === "ffmpeg-fmp4" ? 6 : 4)
        : 0.5;
      const initialBufferTarget = Number.isFinite(requestedInitialBuffer) && requestedInitialBuffer > 0.5
        ? Math.min(12, requestedInitialBuffer)
        : defaultInitialBuffer;
      // SourceBuffer 的配额按字节而不是按秒计算。以 40 MiB 编码数据为常驻预算，
      // 再给正在传输/解码的分片留出余量：低码率仍保留 12s + 5s，高码率则自动
      // 缩短（40 Mbps 约为 6.7s + 1.7s），避免“时间不长但字节已满”。
      const mediaBitrate = Number(playback?.mediaBitrate);
      const bufferBudgetSeconds = Number.isFinite(mediaBitrate) && mediaBitrate > 0
        ? (40 * 1024 * 1024 * 8) / mediaBitrate
        : Infinity;
      let backBufferSeconds = Number.isFinite(bufferBudgetSeconds)
        ? Math.max(1, Math.min(5, bufferBudgetSeconds * 0.2))
        : 5;
      let maxForwardBufferSeconds = Number.isFinite(bufferBudgetSeconds)
        ? Math.max(initialBufferTarget, Math.min(12, bufferBudgetSeconds - backBufferSeconds))
        : 12;
      // MSE remove 会连带删除直到下一关键帧的依赖帧。直连 MP4 初始化后用真实最大
      // GOP 间隔保留完整当前 GOP；0.5s 边缘容差则避免播放头落在被取整后的微小空洞
      // 前时误判为“完全没缓冲”，继而高速预取直至 SourceBuffer 配额耗尽。
      let bufferEdgeToleranceSeconds = 0.5;
      const tuneBufferForKeyframes = (keyframeIntervalValue) => {
        if (rpcPrefix !== "playback.direct" || playback?.streamMode !== "direct-mp4") return;
        const keyframeInterval = Number(keyframeIntervalValue);
        if (!Number.isFinite(keyframeInterval) || keyframeInterval <= 0) return;
        const retainedGop = Math.min(12, keyframeInterval + 0.5);
        backBufferSeconds = Math.max(backBufferSeconds, retainedGop);
        maxForwardBufferSeconds = Number.isFinite(bufferBudgetSeconds)
          ? Math.max(initialBufferTarget, Math.min(12, bufferBudgetSeconds - backBufferSeconds))
          : 12;
        bufferEdgeToleranceSeconds = Math.max(0.5, Math.min(1, keyframeInterval * 0.1));
      };
      const player = {
        destroyed: false,
        generation: 0,
        controller: null,
        seekTimer: null,
        seekController: null,
        seekInFlight: false,
        pendingSeekTime: null,
        pointerActive: false,
        pointerSawSeek: false,
        sourceBuffers: new Map(),
        parserComplete: new Map(),
        keyframeTimes: [],
        quotaRetries: 0,
        quotaKeyframeRecoveries: 0,
        quotaRestarts: Math.max(0, Number(playback?.mseQuotaRestarts) || 0),
        lastQuotaRecovery: null,
        recoveringQuota: false,
        initialSeekTarget: null,
        mediaSource,
        objectUrl,
        started: false,
        initialBufferFailure: null,
        initialBufferTimer: null,
        destroy: null
      };
      setActivePlayer(player);
      embyVideo.src = objectUrl;

      const waitForSourceOpen = () => new Promise((resolve, reject) => {
        if (mediaSource.readyState === "open") {
          resolve();
          return;
        }
        const timeout = setTimeout(() => finish(reject, rpcError("MSE_OPEN_TIMEOUT", "MediaSource 启动超时", true)), 10_000);
        const finish = (callback, value) => {
          clearTimeout(timeout);
          mediaSource.removeEventListener("sourceopen", onOpen);
          mediaSource.removeEventListener("sourceclose", onClose);
          callback(value);
        };
        const onOpen = () => finish(resolve);
        const onClose = () => finish(reject, rpcError("MSE_CLOSED", "MediaSource 已关闭", true));
        mediaSource.addEventListener("sourceopen", onOpen, { once: true });
        mediaSource.addEventListener("sourceclose", onClose, { once: true });
      });

      const waitForUpdateEnd = (sourceBuffer, operation) => new Promise((resolve, reject) => {
        if (player.destroyed) {
          reject(rpcError("ABORTED", "播放器已经关闭"));
          return;
        }
        const cleanup = () => {
          sourceBuffer.removeEventListener("updateend", onUpdateEnd);
          sourceBuffer.removeEventListener("error", onError);
          sourceBuffer.removeEventListener("abort", onAbort);
        };
        const onUpdateEnd = () => { cleanup(); resolve(); };
        const onError = () => { cleanup(); reject(rpcError("MSE_APPEND_ERROR", "视频分片写入失败", true)); };
        const onAbort = () => { cleanup(); reject(rpcError("ABORTED", "视频分片写入已取消", true)); };
        sourceBuffer.addEventListener("updateend", onUpdateEnd, { once: true });
        sourceBuffer.addEventListener("error", onError, { once: true });
        sourceBuffer.addEventListener("abort", onAbort, { once: true });
        try {
          operation();
        } catch (errorValue) {
          cleanup();
          reject(errorValue);
        }
      });

      const isQuotaExceeded = (errorValue) => (
        errorValue?.name === "QuotaExceededError"
        || /SourceBuffer is full|QuotaExceededError/i.test(String(errorValue?.message || errorValue || ""))
      );

      const appendOnce = async (sourceBuffer, bytes) => {
        if (sourceBuffer.updating) await waitForUpdateEnd(sourceBuffer, () => {});
        await waitForUpdateEnd(sourceBuffer, () => sourceBuffer.appendBuffer(bytes));
      };

      const bufferAhead = () => {
        const time = Number(embyVideo.currentTime) || 0;
        for (let index = 0; index < embyVideo.buffered.length; index += 1) {
          const start = embyVideo.buffered.start(index);
          const end = embyVideo.buffered.end(index);
          if (time >= start - bufferEdgeToleranceSeconds && time <= end) return Math.max(0, end - time);
        }
        return 0;
      };

      const isBuffered = (time) => {
        for (let index = 0; index < embyVideo.buffered.length; index += 1) {
          if (
            time >= embyVideo.buffered.start(index) - bufferEdgeToleranceSeconds
            && time <= embyVideo.buffered.end(index) - 0.1
          ) return true;
        }
        return false;
      };

      const waitForDemand = (forwardLimit = maxForwardBufferSeconds) => new Promise((resolve) => {
        if (player.destroyed || bufferAhead() < forwardLimit) {
          resolve();
          return;
        }
        let timeout = null;
        const finish = () => {
          clearTimeout(timeout);
          embyVideo.removeEventListener("timeupdate", finish);
          embyVideo.removeEventListener("seeking", finish);
          embyVideo.removeEventListener("play", finish);
          resolve();
        };
        // 暂停时 timeupdate 不再触发：等 play/seeking 事件，超时兜底拉长到 30s，
        // 避免整个暂停期间 pump 每秒空醒两次重建监听器。超时只是防垂死，destroy
        // 后 promise 也会经这条路径 resolve、循环随即因 player.destroyed 退出。
        timeout = setTimeout(finish, embyVideo.paused ? 30_000 : 500);
        embyVideo.addEventListener("timeupdate", finish, { once: true });
        embyVideo.addEventListener("seeking", finish, { once: true });
        embyVideo.addEventListener("play", finish, { once: true });
      });

      const evictBefore = async (removeEnd) => {
        if (removeEnd <= 0) return;
        await Promise.all([...player.sourceBuffers.entries()].map(async ([trackId, sourceBuffer]) => {
          if (sourceBuffer.updating) return;
          const duration = Number(mediaSource.duration);
          const end = Number.isFinite(duration) && duration > 0
            ? Math.min(removeEnd, duration)
            : removeEnd;
          if (end <= 0.25) return;
          // 一个 SourceBuffer 内含音频+视频时，buffered 是各 track 可播区间的交集。
          // 从 buffered.start 开始删会漏掉交集之前仍驻留的单轨 coded frames；必须
          // 从时间轴 0 删除，才会同时回收两条 track 的隐藏数据和真实媒体配额。
          await waitForUpdateEnd(sourceBuffer, () => sourceBuffer.remove(0, end));
          // remove 只删除 coded frames，不一定释放 ISO-BMFF byte-stream parser 的
          // 输入缓存。仅在一个完整 moof+mdat 边界上 abort，重置 parser 后让 Chromium
          // 真正回收已删数据；分片被拆成多次 RPC 时绝不能在中途 abort。
          if (
            player.parserComplete.get(trackId) === true
            && !sourceBuffer.updating
            && mediaSource.readyState === "open"
          ) {
            try { sourceBuffer.abort(); } catch {}
          }
        }));
      };

      const evictBackBuffer = async (retainedSeconds = backBufferSeconds) => {
        await evictBefore((Number(embyVideo.currentTime) || 0) - retainedSeconds);
      };

      const flushDecoderReferences = async () => {
        const current = Number(embyVideo.currentTime) || 0;
        let start = null;
        let end = null;
        for (let index = 0; index < embyVideo.buffered.length; index += 1) {
          const rangeStart = embyVideo.buffered.start(index);
          const rangeEnd = embyVideo.buffered.end(index);
          if (current >= rangeStart - bufferEdgeToleranceSeconds && current <= rangeEnd) {
            start = rangeStart;
            end = rangeEnd;
            break;
          }
        }
        if (start === null || end - start < 0.08) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          return false;
        }
        // remove/updateend 只保证 coded frames 已从 SourceBuffer 时间轴删除，不保证
        // 解码器同步放开旧帧引用。同一可播区间内轻推 10ms 会刷新 decoder 而不触发
        // 网络 seek；等 seeked 后再 append，避免“时间轴只剩 0.4s 仍报 full”。
        const target = Math.min(end - 0.03, Math.max(start + 0.03, current + 0.01));
        if (!Number.isFinite(target) || Math.abs(target - current) < 0.001) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          return false;
        }
        await new Promise((resolve) => {
          let timeout = null;
          const finish = () => {
            clearTimeout(timeout);
            embyVideo.removeEventListener("seeked", finish);
            resolve();
          };
          timeout = setTimeout(finish, 300);
          embyVideo.addEventListener("seeked", finish, { once: true });
          embyVideo.currentTime = target;
        });
        return true;
      };

      const recoverQuotaAtKeyframe = async () => {
        if (player.keyframeTimes.length === 0) {
          player.lastQuotaRecovery = "no-keyframes";
          return false;
        }
        if (embyVideo.buffered.length === 0) {
          player.lastQuotaRecovery = "no-buffer";
          return false;
        }
        const current = Number(embyVideo.currentTime) || 0;
        let rangeStart = null;
        let rangeEnd = null;
        for (let index = 0; index < embyVideo.buffered.length; index += 1) {
          const start = embyVideo.buffered.start(index);
          const end = embyVideo.buffered.end(index);
          if (current >= start - bufferEdgeToleranceSeconds && current <= end) {
            rangeStart = start;
            rangeEnd = end;
            break;
          }
        }
        if (rangeStart === null) {
          player.lastQuotaRecovery = "outside-buffer";
          return false;
        }
        const candidates = player.keyframeTimes.filter((time) => (
          time > rangeStart + 0.05 && time < rangeEnd - 0.05
        ));
        if (candidates.length === 0) {
          player.lastQuotaRecovery = `no-boundary:${rangeStart.toFixed(2)}-${rangeEnd.toFixed(2)}`;
          return false;
        }
        // 边界附近不能留 ±0.05s 的“无人区”：重试常恰好发生在 54.05s，若同时
        // 要求 past<=54.00、future>54.10，会错过正好 54.00 的关键帧。
        const passed = candidates.filter((time) => time <= current).at(-1);
        const cutoff = passed ?? candidates.find((time) => time > current);
        if (!Number.isFinite(cutoff)) {
          player.lastQuotaRecovery = "no-cutoff";
          return false;
        }

        // 若安全边界还在播放头前方，让现有缓冲继续播放到该关键帧；到达后精确
        // 删除它之前的 coded frames。比“再等固定 N 秒”可靠，也不会删进当前 GOP。
        while (!player.destroyed && (Number(embyVideo.currentTime) || 0) < cutoff + 0.05) {
          if (bufferAhead() <= 0.1) {
            player.lastQuotaRecovery = `buffer-ended-before:${cutoff.toFixed(2)}`;
            return false;
          }
          await waitForDemand(-1);
        }
        if (player.destroyed) throw rpcError("ABORTED", "播放器已经关闭");
        await evictBefore(Math.max(0, cutoff - 0.001));
        const decoderFlushed = await flushDecoderReferences();
        player.quotaKeyframeRecoveries += 1;
        player.lastQuotaRecovery = `evicted-before:${cutoff.toFixed(2)}${decoderFlushed ? ":decoder-flushed" : ""}`;
        return true;
      };

      const append = async (trackId, sourceBuffer, bytes, segmentEnd = true) => {
        try {
          await appendOnce(sourceBuffer, bytes);
          player.parserComplete.set(trackId, segmentEnd);
          return;
        } catch (errorValue) {
          if (!isQuotaExceeded(errorValue) || player.destroyed) throw errorValue;
          player.quotaRetries += 1;
        }

        // 配额命中不是媒体损坏：当前分片尚未写入，可以让已缓冲内容继续播放，
        // 收缩到约 4 秒后清掉旧数据并原样重试。清理仍保留完整当前 GOP，避免
        // SourceBuffer 把依赖帧一并删到下一关键帧、制造微小空洞后再次错误预取。
        // 这样不需要
        // 重启 FFmpeg/Range 流；暂停状态则等用户继续播放后自然恢复。
        const retryAheadSeconds = Math.max(2, Math.min(4, initialBufferTarget));
        while (!player.destroyed && bufferAhead() >= retryAheadSeconds) {
          await waitForDemand(retryAheadSeconds);
        }
        if (player.destroyed) throw rpcError("ABORTED", "播放器已经关闭");
        await evictBackBuffer();
        try {
          await appendOnce(sourceBuffer, bytes);
        } catch (retryError) {
          if (!isQuotaExceeded(retryError) || !await recoverQuotaAtKeyframe()) throw retryError;
          await appendOnce(sourceBuffer, bytes);
        }
        player.parserComplete.set(trackId, segmentEnd);
      };

      const fail = (errorValue) => {
        const errorObject = toRpcError(errorValue);
        if (player.destroyed || isStopping() || ["ABORTED", "CANCELLED"].includes(errorObject.code)) return;
        lastMseDiagnostics = {
          keyframeCount: player.keyframeTimes.length,
          quotaRetries: player.quotaRetries,
          quotaKeyframeRecoveries: player.quotaKeyframeRecoveries,
          quotaRestarts: player.quotaRestarts,
          lastQuotaRecovery: player.lastQuotaRecovery
        };
        if (isQuotaExceeded(errorValue) && typeof onQuotaExceeded === "function" && !player.recoveringQuota) {
          player.recoveringQuota = true;
          const recoveryState = {
            currentTime: Math.max(0, Number(embyVideo.currentTime) || 0),
            paused: embyVideo.paused,
            volume: embyVideo.volume,
            muted: embyVideo.muted
          };
          player.destroy();
          clearActivePlayer(player);
          void Promise.resolve(onQuotaExceeded(recoveryState)).catch((recoveryError) => {
            onFailure(toRpcError(recoveryError));
          });
          return;
        }
        onFailure(errorObject);
      };

      const pump = async (generation) => {
        while (!player.destroyed && generation === player.generation) {
          if (bufferAhead() >= maxForwardBufferSeconds) {
            await waitForDemand();
            continue;
          }
          const controller = new AbortController();
          player.controller = controller;
          let result;
          try {
            result = await rpc(`${rpcPrefix}.next`, {
              playbackId: playback.playbackId
            }, { timeoutMs: 45_000, signal: controller.signal });
          } finally {
            if (player.controller === controller) player.controller = null;
          }
          if (player.destroyed || generation !== player.generation) return;
          await evictBackBuffer();
          const grouped = new Map();
          for (const segment of result?.segments || []) {
            const list = grouped.get(segment.trackId) || [];
            list.push({
              bytes: decodeBase64(segment.data),
              // 兼容旧 daemon：旧响应没有字段时，每个响应项本来就是完整分片。
              segmentEnd: segment.segmentEnd !== false
            });
            grouped.set(segment.trackId, list);
          }
          await Promise.all([...grouped.entries()].map(async ([trackId, segments]) => {
            const sourceBuffer = player.sourceBuffers.get(trackId);
            if (!sourceBuffer) throw rpcError("MSE_TRACK_MISSING", `找不到媒体轨道 ${trackId}`);
            for (const segment of segments) {
              if (player.destroyed || generation !== player.generation) return;
              await append(trackId, sourceBuffer, segment.bytes, segment.segmentEnd);
            }
          }));
          if (player.destroyed || generation !== player.generation) return;
          await evictBackBuffer();
          if (!player.started && (bufferAhead() >= initialBufferTarget || result?.end)) {
            player.started = true;
            resolveInitialBuffer();
          }
          if (result?.end) {
            if (mediaSource.readyState === "open" && [...player.sourceBuffers.values()].every((buffer) => !buffer.updating)) {
              try { mediaSource.endOfStream(); } catch {}
            }
            return;
          }
          if (!result?.segments?.length) await new Promise((resolve) => setTimeout(resolve, 50));
        }
      };

      const schedulePendingSeek = (delay = 120) => {
        clearTimeout(player.seekTimer);
        if (
          player.destroyed
          || player.pointerActive
          || player.seekInFlight
          || !Number.isFinite(player.pendingSeekTime)
        ) return;
        player.seekTimer = setTimeout(() => {
          player.seekTimer = null;
          if (player.destroyed || player.seekInFlight || !Number.isFinite(player.pendingSeekTime)) return;
          const time = player.pendingSeekTime;
          player.pendingSeekTime = null;
          player.seekInFlight = true;
          player.generation += 1;
          const generation = player.generation;
          player.controller?.abort();
          const controller = new AbortController();
          player.seekController = controller;
          void (async () => {
            try {
              const result = await rpc(`${rpcPrefix}.seek`, {
                playbackId: playback.playbackId,
                timeSeconds: time
              }, { timeoutMs: 45_000, signal: controller.signal });
              if (player.destroyed || generation !== player.generation) return;
              // 拖动期间目标又变化了：后端已恢复 ready，但不要为过时位置启动 pump。
              // finally 会在指针松开/防抖结束后串行提交最后一个目标。
              if (Number.isFinite(player.pendingSeekTime)) return;
              const timestampOffset = Number(result?.timestampOffsetSeconds);
              if (Number.isFinite(timestampOffset)) {
                for (const sourceBuffer of player.sourceBuffers.values()) {
                  if (sourceBuffer.updating) await waitForUpdateEnd(sourceBuffer, () => {});
                  sourceBuffer.timestampOffset = timestampOffset;
                }
              }
              if (player.destroyed || generation !== player.generation || Number.isFinite(player.pendingSeekTime)) return;
              void pump(generation).catch((errorValue) => {
                if (player.destroyed || generation !== player.generation) return;
                fail(errorValue);
              });
            } catch (errorValue) {
              const errorObject = toRpcError(errorValue);
              if (
                !player.destroyed
                && generation === player.generation
                && !isStopping()
                && !["ABORTED", "CANCELLED"].includes(errorObject.code)
              ) fail(errorObject);
            } finally {
              if (player.seekController === controller) player.seekController = null;
              player.seekInFlight = false;
              if (Number.isFinite(player.pendingSeekTime) && !player.pointerActive) schedulePendingSeek();
            }
          })();
        }, delay);
      };

      const seek = (time) => {
        if (player.destroyed) return;
        const target = Math.max(0, Number(time) || 0);
        clearTimeout(player.seekTimer);
        player.seekTimer = null;
        // 还没有后端 seek 时，落在已有缓冲里的原生跳转无需重启流；但若已有
        // seek 在途，最终目标即使碰巧落在旧缓冲中也必须排队，以重新同步后端位置。
        if (!player.seekInFlight && isBuffered(target)) {
          player.pendingSeekTime = null;
          return;
        }
        player.pendingSeekTime = target;
        // 原生 controls 会在按住滑块期间持续触发 seeking。pointerup 前只记最新位置，
        // 不启动 FFmpeg；键盘跳播没有 pointer 序列，仍由尾沿防抖提交。
        if (!player.pointerActive && !player.seekInFlight) schedulePendingSeek();
      };

      const onPointerDown = () => {
        player.pointerActive = true;
        player.pointerSawSeek = false;
        clearTimeout(player.seekTimer);
        player.seekTimer = null;
      };
      const onPointerFinished = () => {
        if (!player.pointerActive) return;
        const pointerSawSeek = player.pointerSawSeek;
        player.pointerActive = false;
        player.pointerSawSeek = false;
        // 浏览器在一次未完成的 seeking 状态中不保证为每次滑块位移都再次派发
        // seeking；松手时直接读取 currentTime，确保提交的是最终位置而非第一次位置。
        if (pointerSawSeek) seek(Number(embyVideo.currentTime) || 0);
        else if (Number.isFinite(player.pendingSeekTime)) schedulePendingSeek(0);
      };

      const onSeeking = () => {
        const time = Number(embyVideo.currentTime) || 0;
        if (player.pointerActive) player.pointerSawSeek = true;
        const initialSeekTarget = Number(player.initialSeekTarget);
        if (
          Number.isFinite(initialSeekTarget)
          && Math.abs(time - initialSeekTarget) <= bufferEdgeToleranceSeconds
        ) {
          // initialize/配额重建已经让后端 MP4Box seek 到这个关键帧。给 video 对齐
          // currentTime 会异步触发 seeking；若再次进入 RPC seek，就会 abort 刚启动的
          // .next 请求，表现成新 MediaSource 写完 init 后立刻“请求已取消”。
          player.initialSeekTarget = null;
          return;
        }
        player.initialSeekTarget = null;
        seek(time);
      };
      const onVideoError = () => fail(rpcError("MEDIA_DECODE_ERROR", "视频解码失败，当前编码可能不受支持"));
      // 卡顿看护：直连 MP4 走自研 MSE 管线，没有 hls.js 那样的内建 gap/nudge。
      // 当 <video> 触发 waiting/stalled 时，若播放头正好卡在一个已缓冲区间「之前」的极小空洞，
      // 就把 currentTime 微推过去（目标区间已缓冲，不会触发重连）；否则通过 seeking→seek
      // 让上层从当前位置重新拉流，避免画面永久冻结却无任何提示。
      let stallTimer = null;
      const onWaiting = () => {
        if (player.destroyed) return;
        const time = Number(embyVideo.currentTime) || 0;
        // 找到播放头右侧最近的缓冲区间；若与当前位置只差一个极小空洞，直接跳过去。
        for (let index = 0; index < embyVideo.buffered.length; index += 1) {
          const start = embyVideo.buffered.start(index);
          const end = embyVideo.buffered.end(index);
          if (start > time && start - time <= 0.5 && end - start > 0.1) {
            embyVideo.currentTime = start + 0.01;
            return;
          }
        }
        // 没有可跳的小空洞：给管线一点时间续上；持续卡住则从当前位置重连。
        clearTimeout(stallTimer);
        stallTimer = setTimeout(() => {
          if (player.destroyed || embyVideo.paused) return;
          if (bufferAhead() < 0.5 && !player.controller && !player.seekInFlight) {
            seek(Number(embyVideo.currentTime) || 0);
          }
        }, 3_000);
      };
      const onPlaying = () => { clearTimeout(stallTimer); };
      player.destroy = () => {
        if (player.destroyed) return;
        player.destroyed = true;
        player.generation += 1;
        clearTimeout(player.seekTimer);
        clearTimeout(stallTimer);
        clearTimeout(player.initialBufferTimer);
        resolveInitialBuffer();
        player.controller?.abort();
        player.seekController?.abort();
        embyVideo.removeEventListener("seeking", onSeeking);
        embyVideo.removeEventListener("pointerdown", onPointerDown);
        embyVideo.removeEventListener("pointerup", onPointerFinished);
        embyVideo.removeEventListener("pointercancel", onPointerFinished);
        embyVideo.removeEventListener("lostpointercapture", onPointerFinished);
        window.removeEventListener("pointerup", onPointerFinished, true);
        window.removeEventListener("pointercancel", onPointerFinished, true);
        embyVideo.removeEventListener("error", onVideoError);
        embyVideo.removeEventListener("waiting", onWaiting);
        embyVideo.removeEventListener("stalled", onWaiting);
        embyVideo.removeEventListener("playing", onPlaying);
        for (const sourceBuffer of player.sourceBuffers.values()) {
          try { if (sourceBuffer.updating) sourceBuffer.abort(); } catch {}
        }
        if (mediaSource.readyState === "open") {
          try { mediaSource.endOfStream(); } catch {}
        }
        if (embyVideo.src === objectUrl) embyVideo.removeAttribute("src");
        URL.revokeObjectURL(objectUrl);
      };

      try {
        await waitForSourceOpen();
        // init RPC 挂到 player.controller：destroy 时统一 abort，
        // 避免 45s 长请求在播放器销毁后仍然悬着、迟到失败又触发上面的 catch。
        const initController = new AbortController();
        player.controller = initController;
        const initialization = await rpc(`${rpcPrefix}.init`, {
          playbackId: playback.playbackId
        }, { timeoutMs: 45_000, signal: initController.signal });
        if (player.controller === initController) player.controller = null;
        if (player.destroyed) return;
        player.keyframeTimes = Array.isArray(initialization?.keyframeTimesSeconds)
          ? initialization.keyframeTimesSeconds
            .map(Number)
            .filter((time) => Number.isFinite(time) && time >= 0)
            .sort((left, right) => left - right)
          : [];
        tuneBufferForKeyframes(initialization?.keyframeIntervalSeconds);
        for (const track of initialization?.tracks || []) {
          if (!MediaSource.isTypeSupported(track.mime)) {
            throw rpcError("MEDIA_CODEC_UNSUPPORTED", `当前 Renderer 不支持 ${track.codec || track.mime} 编码`);
          }
          const sourceBuffer = mediaSource.addSourceBuffer(track.mime);
          player.sourceBuffers.set(track.id, sourceBuffer);
          await append(track.id, sourceBuffer, decodeBase64(track.initData), true);
          const timestampOffset = Number(initialization?.timestampOffsetSeconds);
          if (Number.isFinite(timestampOffset)) sourceBuffer.timestampOffset = timestampOffset;
        }
        if (player.sourceBuffers.size === 0) throw rpcError("MSE_TRACK_MISSING", "媒体没有可播放的音视频轨道");
        const duration = Number(initialization?.durationSeconds);
        if (Number.isFinite(duration) && duration > 0) mediaSource.duration = duration;
        const initializedStartTime = Number(initialization?.startTimeSeconds);
        const requestedStartTime = Number(playback.startPositionTicks || 0) / 10_000_000;
        // MP4Box seek 会返回真实关键帧时间；优先采用它，不能把 video 强设回请求值
        // 落在首个可解码帧之前，否则同样会形成“当前时间略早于 buffered.start”的假空洞。
        const startTime = Number.isFinite(initializedStartTime) && initializedStartTime >= 0
          ? initializedStartTime
          : requestedStartTime;
        if (Number.isFinite(startTime) && startTime > 0) {
          player.initialSeekTarget = startTime;
          embyVideo.currentTime = startTime;
        }
        embyVideo.addEventListener("seeking", onSeeking);
        embyVideo.addEventListener("pointerdown", onPointerDown);
        embyVideo.addEventListener("pointerup", onPointerFinished);
        embyVideo.addEventListener("pointercancel", onPointerFinished);
        embyVideo.addEventListener("lostpointercapture", onPointerFinished);
        // UA 原生进度条通常会捕获指针；全局捕获监听作为滑块拖出 video 边界后的
        // 兜底，确保 pointerActive 不会卡死，播放器销毁时成对移除。
        window.addEventListener("pointerup", onPointerFinished, true);
        window.addEventListener("pointercancel", onPointerFinished, true);
        embyVideo.addEventListener("error", onVideoError);
        embyVideo.addEventListener("waiting", onWaiting);
        embyVideo.addEventListener("stalled", onWaiting);
        embyVideo.addEventListener("playing", onPlaying);
        let configurationComplete = false;
        void pump(player.generation).catch((errorValue) => {
          player.initialBufferFailure = errorValue;
          resolveInitialBuffer();
          if (configurationComplete) fail(errorValue);
        });
        if (initialBufferTarget > 0.5) {
          player.initialBufferTimer = setTimeout(resolveInitialBuffer, 20_000);
          await initialBufferReady;
          clearTimeout(player.initialBufferTimer);
          player.initialBufferTimer = null;
          if (player.destroyed) return;
          if (player.initialBufferFailure) throw player.initialBufferFailure;
          // 超时只表示链路暂时较慢，已有数据仍可播放；后续 pump 继续受动态
          // 字节预算约束，不会因等待首播而无限积累。
          player.started = true;
        }
        configurationComplete = true;
      } catch (errorValue) {
        player.destroy();
        // 只有自己仍是活动播放器时才清空：快速切换视频时新播放器已经挂上，
        // 旧播放器迟到的失败若无条件清空，会把新播放器从活动槽里抹掉，
        // 之后 teardown 销毁不到它（pump 泄漏、持续发 .next RPC）。
        clearActivePlayer(player);
        throw errorValue;
      }
    };

    const configureDirectMp4 = (embyVideo, playback) => configureDirectMp4Stream(embyVideo, playback, {
      rpcPrefix: "playback.direct",
      setActivePlayer: (player) => {
        lastMseDiagnostics = null;
        activeDirectPlayer = player;
      },
      clearActivePlayer: (player) => { if (activeDirectPlayer === player) activeDirectPlayer = null; },
      isStopping: () => playbackStopping || subtitleSwitching,
      onFailure: (errorObject) => showError(
        errorObject,
        () => beginPlayback(playback.item, true),
        embyState.previousRoute?.view || "home"
      ),
      onQuotaExceeded: async (recoveryState) => {
        if (disposed || playbackStopping || embyState.playback !== playback || embyState.view !== "playback") return;
        playback.mseQuotaRestarts = Math.max(0, Number(playback.mseQuotaRestarts) || 0) + 1;
        playback.mediaReady = false;
        setSubtitleStatus("正在释放媒体缓存并恢复播放…");
        const seekResult = await rpc("playback.direct.seek", {
          playbackId: playback.playbackId,
          timeSeconds: recoveryState.currentTime
        }, { timeoutMs: 45_000 });
        if (disposed || playbackStopping || embyState.playback !== playback || embyState.view !== "playback") return;
        const actualStart = Number(seekResult?.timeSeconds);
        if (Number.isFinite(actualStart) && actualStart >= 0) {
          playback.startPositionTicks = Math.round(actualStart * 10_000_000);
        }
        playback.restorePlaybackState = recoveryState;
        await configureDirectMp4(embyVideo, playback);
        if (disposed || playbackStopping || embyState.playback !== playback || embyState.view !== "playback") return;
        activatePlaybackState(embyVideo, playback);
        setSubtitleStatus("");
      }
    });

    const episodeContextMatches = (item) => (
      item?.type === "Episode"
      && embyState.seriesItem?.id === item.seriesId
      && embyState.selectedSeasonId === item.seasonId
      && embyState.episodes.some((episode) => episode.id === item.id)
    );

    const applyPlaybackEpisodeContext = (item, result) => {
      if (!item?.seriesId || !result) return;
      embyState.seriesItem = embyState.seriesItem?.id === item.seriesId
        ? embyState.seriesItem
        : {
            id: item.seriesId,
            name: item.seriesName || "剧集",
            type: "Series"
          };
      embyState.seasons = Array.isArray(result.seasons) ? result.seasons : [];
      embyState.selectedSeasonId = result.selectedSeasonId || item.seasonId || embyState.seasons[0]?.id || null;
      embyState.episodes = Array.isArray(result.episodes) ? result.episodes : [];
    };

    const fetchPlaybackEpisodeContext = (item, seasonId = item?.seasonId) => {
      if (item?.type !== "Episode" || !item.seriesId) return Promise.resolve(null);
      if (episodeContextRequestId) cancelRpc(episodeContextRequestId, true);
      const request = requestRpc("series.get", {
        seriesId: item.seriesId,
        seasonId: seasonId || undefined
      }, { timeoutMs: 30_000 });
      episodeContextRequestId = request.id;
      return request.promise.finally(() => {
        if (episodeContextRequestId === request.id) episodeContextRequestId = null;
      });
    };

    const currentEpisodeIndex = (itemId) => embyState.episodes.findIndex((episode) => episode.id === itemId);

    const adjacentEpisodeInSeason = (itemId, direction) => {
      const index = currentEpisodeIndex(itemId);
      return index >= 0 ? embyState.episodes[index + direction] || null : null;
    };

    const adjacentSeason = (direction) => {
      const index = embyState.seasons.findIndex((season) => season.id === embyState.selectedSeasonId);
      return index >= 0 ? embyState.seasons[index + direction] || null : null;
    };

    const hasAdjacentEpisode = (itemId, direction) => (
      Boolean(adjacentEpisodeInSeason(itemId, direction))
      || Boolean(adjacentSeason(direction))
    );

    const playbackEpisodeLabel = (item) => {
      const seasonNumber = Number(item?.parentIndexNumber);
      const episodeNumber = Number(item?.indexNumber);
      if (seasonNumber > 0 && episodeNumber > 0) return `S${seasonNumber} · E${episodeNumber}`;
      if (episodeNumber > 0) return `第 ${episodeNumber} 集`;
      return item?.name || "选集";
    };

    const closePlaybackEpisodePicker = (
      view = embyApp.querySelector(".emby-playback"),
      { restoreCurrentSeason = true } = {}
    ) => {
      if (!view) return;
      const picker = view.querySelector(".emby-episode-picker");
      const button = view.querySelector(".emby-episode-picker-button");
      if (picker) picker.hidden = true;
      if (button) button.setAttribute("aria-expanded", "false");
      view.dataset.episodePickerOpen = "false";
      const playback = embyState.playback;
      if (
        restoreCurrentSeason
        && playback?.item?.seasonId
        && embyState.selectedSeasonId !== playback.item.seasonId
      ) {
        void loadPlaybackSeason(playback.item.seasonId, playback);
      }
    };

    const syncPlaybackEpisodeNavigation = (view = embyApp.querySelector(".emby-playback")) => {
      const playback = embyState.playback;
      if (!view || !playback) return;
      const item = playback.item;
      const nav = view.querySelector(".emby-playback-episode-nav");
      const previous = view.querySelector('[data-episode-direction="-1"]');
      const next = view.querySelector('[data-episode-direction="1"]');
      const pickerButton = view.querySelector(".emby-episode-picker-button");
      const pickerHeader = view.querySelector(".emby-episode-picker-header");
      const pickerGrid = view.querySelector(".emby-episode-picker-grid");
      const endedNext = view.querySelector(".emby-ended-next");
      const isEpisode = item?.type === "Episode";
      const hasContext = isEpisode && episodeContextMatches(item);
      // 整部剧只有一集可播时，选集/上一集/下一集都没有意义：整条导航隐藏。
      // （加载上下文期间 hasContext=false，先保持现状避免闪烁；hasContext 为真
      // 即表示当前集在 episodes 里，此时 episodes.length<=1 就是整部只有一集。）
      const singleEpisodeOnly = hasContext
        && (Array.isArray(embyState.seasons) ? embyState.seasons.length : 0) <= 1
        && (Array.isArray(embyState.episodes) ? embyState.episodes.length : 0) <= 1;
      if (nav) nav.hidden = !isEpisode || singleEpisodeOnly;
      if (endedNext) endedNext.hidden = !isEpisode;
      if (!isEpisode) return;
      if (singleEpisodeOnly) closePlaybackEpisodePicker(view);

      const sameSeries = embyState.seriesItem?.id === item.seriesId;
      if (previous) previous.disabled = !hasContext || !hasAdjacentEpisode(item.id, -1);
      if (next) next.disabled = !hasContext || !hasAdjacentEpisode(item.id, 1);
      if (endedNext) endedNext.disabled = !hasContext || !hasAdjacentEpisode(item.id, 1);
      if (pickerButton) {
        pickerButton.textContent = playbackEpisodeLabel(item);
        pickerButton.disabled = !item.seriesId;
        pickerButton.title = item.name || pickerButton.textContent;
      }
      if (!pickerHeader || !pickerGrid) return;

      pickerHeader.replaceChildren();
      for (const season of sameSeries ? embyState.seasons : []) {
        const chip = makeElement("button", "emby-episode-season", season.name || `第 ${season.indexNumber || "?"} 季`);
        chip.type = "button";
        chip.setAttribute("aria-selected", String(season.id === embyState.selectedSeasonId));
        chip.addEventListener("click", () => {
          if (season.id !== embyState.selectedSeasonId) void loadPlaybackSeason(season.id, playback);
        });
        pickerHeader.append(chip);
      }

      pickerGrid.replaceChildren();
      if (!sameSeries || !embyState.episodes.length) {
        pickerGrid.append(makeElement(
          "div",
          "emby-episode-picker-empty",
          episodeContextRequestId ? "正在加载选集…" : "暂无可播放单集"
        ));
        return;
      }
      for (const episode of embyState.episodes) {
        const button = makeElement(
          "button",
          "emby-episode-picker-item",
          episode.indexNumber ? `第 ${episode.indexNumber} 集` : episode.name || "播放"
        );
        button.type = "button";
        button.title = episode.name || button.textContent;
        button.setAttribute("aria-current", String(episode.id === playback.itemId));
        button.addEventListener("click", () => {
          closePlaybackEpisodePicker(view, { restoreCurrentSeason: false });
          if (episode.id !== playback.itemId) void beginPlayback(episode, true);
        });
        pickerGrid.append(button);
      }
      pickerGrid.querySelector('[aria-current="true"]')?.scrollIntoView({ block: "nearest" });
    };

    const loadPlaybackSeason = async (seasonId, playback = embyState.playback) => {
      if (!playback?.item?.seriesId || embyState.playback !== playback) return null;
      const pickerButton = embyApp.querySelector(".emby-episode-picker-button");
      if (pickerButton) {
        pickerButton.textContent = "正在加载…";
        pickerButton.disabled = true;
      }
      try {
        const result = await fetchPlaybackEpisodeContext(playback.item, seasonId);
        if (disposed || embyState.playback !== playback) return null;
        applyPlaybackEpisodeContext({ ...playback.item, seasonId }, result);
        syncPlaybackEpisodeNavigation();
        return result;
      } catch (errorValue) {
        if (!disposed && embyState.playback === playback) {
          setSubtitleStatus(toRpcError(errorValue).message || "加载选集失败");
          setTimeout(() => {
            if (embyState.playback === playback) setSubtitleStatus("");
          }, 2_500);
          syncPlaybackEpisodeNavigation();
        }
        return null;
      }
    };

    const playAdjacentEpisode = async (direction) => {
      const playback = embyState.playback;
      if (!playback?.item || playback.item.type !== "Episode") return;
      let episode = adjacentEpisodeInSeason(playback.itemId, direction);
      if (episode) {
        await beginPlayback(episode, true);
        return;
      }
      const season = adjacentSeason(direction);
      if (!season) return;
      const result = await loadPlaybackSeason(season.id, playback);
      if (!result || embyState.playback !== playback) return;
      episode = direction > 0 ? embyState.episodes[0] : embyState.episodes.at(-1);
      if (episode) {
        await beginPlayback(episode, true);
        return;
      }
      // 相邻季存在但没有可播放的单集：给出明确反馈而不是静默失败（否则按钮看似可点却无反应）。
      if (!disposed && embyState.playback === playback) {
        setSubtitleStatus(direction > 0 ? "下一季暂无可播放的单集" : "上一季暂无可播放的单集");
        setTimeout(() => {
          if (embyState.playback === playback) setSubtitleStatus("");
        }, 2_500);
        syncPlaybackEpisodeNavigation();
      }
    };

    const renderPlayback = () => {
      const view = makeElement("div", "emby-view emby-playback");
      view.dataset.view = "playback";
      view.tabIndex = 0;
      const playback = embyState.playback;
      const directProxyUrl = playback?.streamMode === "direct-mp4"
        ? requireLoopbackMediaUrl(playback.directProxyUrl)
        : null;
      let embyVideo = directProxyUrl ? null : makeElement("video", "emby-video");
      let mediaElement = embyVideo;
      if (embyVideo) {
        embyVideo.controls = true;
        embyVideo.playsInline = true;
        embyVideo.preload = "metadata";
        // 与红果播放视图一致禁用画中画（Electron 下 PiP 行为未验证，两卡统一）。
        embyVideo.disablePictureInPicture = true;
      } else {
        const frame = makeElement("iframe", "emby-video-frame");
        frame.title = "Emby 原生视频播放器";
        frame.setAttribute("allow", "autoplay; fullscreen");
        mediaElement = frame;
      }
      const chrome = makeElement("div", "emby-playback-chrome");
      const back = makeIconButton("返回媒体列表", "back", () => stopPlayback(true));
      back.classList.add("emby-playback-back");
      chrome.append(back, makeElement("span", "emby-playback-title", embyState.playback?.item?.name || "正在播放"));
      // 画质透出：与选源 chips 同源的标签（如 "4K MKV H264"、"1080p MP4"），没有时不占位。
      if (embyState.playback?.qualityLabel) {
        chrome.append(makeElement("span", "emby-playback-quality", embyState.playback.qualityLabel));
      }
      const subtitles = Array.isArray(embyState.playback?.subtitles) ? embyState.playback.subtitles : [];
      let subtitleMenu = null;
      const episodeNav = makeElement("div", "emby-playback-episode-nav");
      episodeNav.hidden = true;
      const previousEpisode = makeElement("button", "emby-episode-nav-button", "上一集");
      previousEpisode.type = "button";
      previousEpisode.dataset.episodeDirection = "-1";
      previousEpisode.setAttribute("aria-label", "播放上一集");
      previousEpisode.addEventListener("click", () => void playAdjacentEpisode(-1));
      const episodePickerButton = makeElement("button", "emby-episode-nav-button emby-episode-picker-button", "选集");
      episodePickerButton.type = "button";
      episodePickerButton.setAttribute("aria-label", "打开选集");
      episodePickerButton.setAttribute("aria-haspopup", "dialog");
      episodePickerButton.setAttribute("aria-expanded", "false");
      const nextEpisodeButton = makeElement("button", "emby-episode-nav-button", "下一集");
      nextEpisodeButton.type = "button";
      nextEpisodeButton.dataset.episodeDirection = "1";
      nextEpisodeButton.setAttribute("aria-label", "播放下一集");
      nextEpisodeButton.addEventListener("click", () => void playAdjacentEpisode(1));
      episodeNav.append(previousEpisode, episodePickerButton, nextEpisodeButton);
      const episodePicker = makeElement("div", "emby-episode-picker");
      episodePicker.hidden = true;
      episodePicker.setAttribute("role", "dialog");
      episodePicker.setAttribute("aria-label", "剧集与选集");
      episodePicker.append(
        makeElement("div", "emby-episode-picker-header"),
        makeElement("div", "emby-episode-picker-grid")
      );
      episodePickerButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const willOpen = episodePicker.hidden;
        if (willOpen && subtitleMenu && !subtitleMenu.hidden) {
          subtitleMenu.hidden = true;
          chrome.querySelector(".emby-subtitle-button")?.setAttribute("aria-expanded", "false");
        }
        episodePicker.hidden = !willOpen;
        episodePickerButton.setAttribute("aria-expanded", String(willOpen));
        view.dataset.episodePickerOpen = String(willOpen);
        if (!willOpen) return;
        syncPlaybackEpisodeNavigation(view);
        const playback = embyState.playback;
        if (playback?.item?.seriesId && !episodeContextMatches(playback.item)) {
          void loadPlaybackSeason(playback.item.seasonId, playback);
        } else {
          episodePicker.querySelector('[aria-current="true"]')?.focus({ preventScroll: true });
        }
      });
      if (subtitles.length > 0) {
        const subtitleButton = makeElement("button", "emby-icon-button emby-subtitle-button");
        subtitleButton.type = "button";
        subtitleButton.append(makeToolbarIcon("subtitles"));
        subtitleButton.setAttribute("aria-haspopup", "menu");
        subtitleButton.setAttribute("aria-expanded", "false");
        subtitleMenu = makeElement("div", "emby-subtitle-menu");
        subtitleMenu.hidden = true;
        subtitleMenu.setAttribute("role", "menu");
        const makeOption = (subtitle) => {
          const option = makeElement("button", "emby-subtitle-option");
          option.type = "button";
          option.setAttribute("role", "menuitemradio");
          option.dataset.subtitleIndex = subtitle ? String(subtitle.index) : "off";
          option.append(
            makeElement("span", "", subtitle?.label || "关闭字幕"),
            makeElement("span", "emby-subtitle-meta", subtitleDescription(subtitle))
          );
          option.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            subtitleMenu.hidden = true;
            subtitleButton.setAttribute("aria-expanded", "false");
            void switchEmbySubtitle(subtitle?.index ?? null);
          });
          return option;
        };
        subtitleMenu.append(makeOption(null), ...subtitles.map(makeOption));
        subtitleButton.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          closePlaybackEpisodePicker(view);
          subtitleMenu.hidden = !subtitleMenu.hidden;
          subtitleButton.setAttribute("aria-expanded", String(!subtitleMenu.hidden));
          if (!subtitleMenu.hidden) subtitleMenu.querySelector('[aria-checked="true"]')?.focus();
        });
        subtitleMenu.addEventListener("keydown", (event) => {
          const options = [...subtitleMenu.querySelectorAll(".emby-subtitle-option")];
          const current = Math.max(0, options.indexOf(shadow.activeElement));
          let next = null;
          if (event.key === "ArrowDown") next = options[(current + 1) % options.length];
          else if (event.key === "ArrowUp") next = options[(current - 1 + options.length) % options.length];
          else if (event.key === "Home") next = options[0];
          else if (event.key === "End") next = options.at(-1);
          if (next) {
            event.preventDefault();
            event.stopPropagation();
            next.focus();
          }
        });
        chrome.append(subtitleButton);
      }
      chrome.append(makeFullscreenButton(view, "emby-icon-button emby-playback-fullscreen"));
      const subtitleStatus = makeElement("div", "emby-subtitle-status");
      subtitleStatus.hidden = true;
      const ended = makeElement("div", "emby-ended");
      ended.hidden = true;
      const replay = makeElement("button", "emby-button", "重播");
      replay.type = "button";
      replay.addEventListener("click", () => {
        if (!embyVideo) return;
        ended.hidden = true;
        embyVideo.currentTime = 0;
        embyVideo.play().catch(() => {});
      });
      ended.append(replay);
      const endedNext = makeElement("button", "emby-button emby-ended-next", "下一集");
      endedNext.type = "button";
      endedNext.hidden = true;
      endedNext.addEventListener("click", () => void playAdjacentEpisode(1));
      ended.append(endedNext);
      const wirePlaybackVideo = () => {
        if (!embyVideo) return;
        // 暂停状态同步到 view.dataset.paused：CSS 据此常显 chrome（初始 paused 时
        // 加载中也显示返回键/标题）。play/pause 覆盖全部状态翻转点。
        const syncPausedState = () => { view.dataset.paused = String(embyVideo.paused); };
        embyVideo.addEventListener("play", syncPausedState);
        embyVideo.addEventListener("playing", syncPausedState);
        embyVideo.addEventListener("pause", syncPausedState);
        syncPausedState();
        embyVideo.addEventListener("pause", () => reportProgress("pause"));
        embyVideo.addEventListener("play", () => {
          reportProgress("play");
          // ended 时停掉了定时上报；重播（ended 界面按钮或拖回进度条）时恢复。
          if (!progressTimer && !embyState.playback?.preview) {
            progressTimer = setInterval(() => reportProgress("progress"), 10_000);
          }
        });
        embyVideo.addEventListener("seeked", () => reportProgress("seek"));
        embyVideo.addEventListener("volumechange", () => {
          // 拖原生音量条时每帧都触发：500ms 尾沿节流，避免每帧一个 playback.progress RPC。
          if (volumeReportTimer) return;
          volumeReportTimer = setTimeout(() => {
            volumeReportTimer = null;
            reportProgress("volumechange");
          }, 500);
        });
        embyVideo.addEventListener("ended", () => {
          // 播完即停表：否则用户停在重播界面时，每 10s 的 progress 会让服务端
          // 转码会话无限期保活。不发 playback.stop —— 重播复用同一 playSessionId，
          // stop 会让服务端会话（含 HLS 转码）失效；离开播放页时 cleanupPlayback 统一 stop。
          clearInterval(progressTimer);
          progressTimer = null;
          reportProgress("ended");
          ended.hidden = false;
        });
      };
      wirePlaybackVideo();
      view.addEventListener("keydown", (event) => {
        // 空格/左右方向键转发给 video：仅当焦点在容器本身，避免劫持内部按钮的
        // 空格激活与字幕菜单/选集内的方向键导航。
        if (event.target === view && (event.key === " " || event.key === "ArrowLeft" || event.key === "ArrowRight")) {
          event.preventDefault();
          event.stopPropagation();
          if (!embyVideo) return;
          if (event.key === " ") {
            if (embyVideo.paused) embyVideo.play().catch(() => {});
            else embyVideo.pause();
          } else {
            const delta = event.key === "ArrowRight" ? 5 : -5;
            const duration = Number(embyVideo.duration);
            embyVideo.currentTime = Math.max(
              0,
              Math.min(Number.isFinite(duration) ? duration : Infinity, Number(embyVideo.currentTime || 0) + delta)
            );
          }
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          if (subtitleMenu && !subtitleMenu.hidden) {
            subtitleMenu.hidden = true;
            const subtitleButton = chrome.querySelector(".emby-subtitle-button");
            subtitleButton?.setAttribute("aria-expanded", "false");
            subtitleButton?.focus();
          } else if (!episodePicker.hidden) {
            closePlaybackEpisodePicker(view);
            episodePickerButton.focus();
          } else {
            stopPlayback(true);
          }
        }
      });
      view.addEventListener("click", (event) => {
        if (subtitleMenu && !subtitleMenu.hidden) {
          if (!subtitleMenu.contains(event.target) && !chrome.querySelector(".emby-subtitle-button")?.contains(event.target)) {
            subtitleMenu.hidden = true;
            chrome.querySelector(".emby-subtitle-button")?.setAttribute("aria-expanded", "false");
          }
        }
        if (!episodePicker.hidden && !episodePicker.contains(event.target) && !episodePickerButton.contains(event.target)) {
          closePlaybackEpisodePicker(view);
        }
      });
      view.append(mediaElement, chrome, episodeNav);
      if (subtitleMenu) view.append(subtitleMenu);
      view.append(episodePicker, subtitleStatus, ended);
      setTimeout(() => {
        if (!view.isConnected) return;
        view.focus({ preventScroll: true });
        syncSubtitleControls(embyState.playback);
        syncPlaybackEpisodeNavigation(view);
        if (!embyState.playback?.preview) {
          const playback = embyState.playback;
          const start = async () => {
            if (directProxyUrl && mediaElement instanceof HTMLIFrameElement) {
              embyVideo = await configureLoopbackVideoFrame(mediaElement, playback, directProxyUrl);
              wirePlaybackVideo();
              activatePlaybackState(embyVideo, playback);
            } else if (["direct-mp4", "ffmpeg-fmp4"].includes(playback.streamMode)) {
              await configureDirectMp4(embyVideo, playback);
              // await 期间用户可能已退出或另开了新视频：迟到完成不能激活旧 playback，
              // 更不能覆盖新播放的 progressTimer 句柄（旧 interval 会永远清不掉，
              // 变成双重上报）。与下方 catch 用同一代际判断。
              if (embyState.playback !== playback || embyState.view !== "playback") return;
              activatePlaybackState(embyVideo, playback);
            } else {
              configureHls(embyVideo, playback);
            }
            clearInterval(progressTimer);
            progressTimer = setInterval(() => reportProgress("progress"), 10_000);
          };
          start().catch((errorValue) => {
            if (embyState.playback !== playback || embyState.view !== "playback") return;
            const playbackItem = playback.item;
            showError(
              errorValue,
              () => beginPlayback(playbackItem, true),
              embyState.previousRoute?.view || "home"
            );
          });
        }
      }, 0);
      return view;
    };

    const cleanupPlayback = (reportStop = true) => {
      const payload = playbackPayload("stop");
      playbackStopping = true;
      // 上一个播放的字幕切换 RPC（最长 65s）可能还没落地：播放既已销毁，
      // 必须复位切换标志，否则新播放的字幕切换与失败上报会被旧 flag 阻塞。
      // 进行中的旧 RPC 由 switchEmbySubtitle 内的 playback 代际判断兜底。
      subtitleSwitching = false;
      if (episodeContextRequestId) cancelRpc(episodeContextRequestId, true);
      episodeContextRequestId = null;
      if (progressTimer) clearInterval(progressTimer);
      progressTimer = null;
      if (volumeReportTimer) clearTimeout(volumeReportTimer);
      volumeReportTimer = null;
      teardownPlaybackMedia();
      if (reportStop && payload && !embyState.playback?.preview) {
        rpc("playback.stop", payload, { timeoutMs: 5_000 }).catch(() => {});
      }
      embyState.playback = null;
      playbackStopping = false;
    };

    const stopPlayback = (restoreRoute) => {
      const route = embyState.previousRoute;
      cleanupPlayback(true);
      if (!restoreRoute || disposed) return;
      embyState.view = route?.view && route.view !== "playback" ? route.view : "home";
      if (route?.scrollKey) embyState.scrollPositions.set(route.scrollKey, route.scrollTop || 0);
      embyState.previousRoute = null;
      renderEmby();
    };

    const beginPlayback = async (item, preserveRoute = false) => {
      if (!item?.id) return;
      const currentScroller = embyApp.querySelector(".emby-scroll[data-scroll-key]");
      if (!preserveRoute) {
        embyState.previousRoute = {
          view: embyState.view,
          scrollKey: currentScroller?.dataset.scrollKey || null,
          scrollTop: currentScroller?.scrollTop || 0
        };
      }
      if (embyState.playback) cleanupPlayback(true);
      const episodeContextPromise = item.type === "Episode" && item.seriesId && !episodeContextMatches(item)
        ? fetchPlaybackEpisodeContext(item).catch(() => null)
        : Promise.resolve(null);
      embyState.loadingLabel = `正在准备 ${item.name || "视频"}…`;
      embyState.view = "loading";
      renderEmby();
      try {
        const result = await rpc("playback.open", {
          itemId: item.id,
          startPositionTicks: Number(item.positionTicks || 0),
          ...(item.seriesId && preferredSourceKey(item.seriesId)
            ? { preferredSourceKey: preferredSourceKey(item.seriesId) }
            : {}),
          // 字幕偏好随 open 一次选好，避免默认选择不合时再串行 select 一次
          // （burn-in 偏好会让转码/ffmpeg 会话开两次）。service 返回已匹配偏好时，
          // 下方的 preferredIndex 比较自然相等，不会再发 select。
          ...(subtitlePreference ? { subtitlePreference } : {})
        }, { timeoutMs: 30_000 });
        if (disposed) return;
        const streamMode = result?.streamMode || (result?.hlsUrl ? "hls" : null);
        if (streamMode === "hls" && !result.hlsUrl) {
          throw rpcError("PLAYBACK_SOURCE_MISSING", "服务器没有返回可播放的 HLS 视频流");
        }
        if (!["hls", "direct-mp4", "ffmpeg-fmp4"].includes(streamMode)) {
          throw rpcError("PLAYBACK_SOURCE_MISSING", "服务器没有返回受支持的视频流");
        }
        const playback = {
          ...result,
          streamMode,
          item,
          itemId: result.itemId || item.id,
          mediaReady: false
        };
        const preferredIndex = preferredSubtitleIndex(playback.subtitles || []);
        if (preferredIndex !== undefined && preferredIndex !== playback.selectedSubtitleIndex) {
          const selection = await rpc("playback.subtitle.select", {
            playbackId: playback.playbackId,
            subtitleStreamIndex: preferredIndex,
            positionTicks: Number(playback.startPositionTicks || 0)
          }, { timeoutMs: 65_000 });
          Object.assign(playback, selection);
        }
        embyState.playback = playback;
        embyState.view = "playback";
        renderEmby();
        void episodeContextPromise.then((context) => {
          if (!context || disposed || embyState.playback !== playback) return;
          applyPlaybackEpisodeContext(item, context);
          syncPlaybackEpisodeNavigation();
        });
      } catch (errorValue) {
        if (episodeContextRequestId) cancelRpc(episodeContextRequestId, true);
        episodeContextRequestId = null;
        showError(errorValue, () => beginPlayback(item, true), embyState.previousRoute?.view || "home");
      }
    };

    const openItem = (item) => {
      // 离开当前列表前记住滚动位置，返回时可回到原处（此前打开媒体库文件夹会丢失首页滚动）。
      rememberScroll();
      if (item?.isFolder) {
        const stack = embyState.view === "library"
          ? [...embyState.libraryStack, item]
          : [item];
        loadLibrary(item, { stack });
      } else if (item?.type === "Series") loadSeries(item);
      else beginPlayback(item);
    };

    const renderError = () => {
      const view = makeElement("div", "emby-view emby-center");
      view.dataset.view = "error";
      view.append(
        makeElement("div", "emby-error-title", "Emby 暂时不可用"),
        makeElement("div", "emby-muted", embyState.error?.message || "请求失败，请稍后重试")
      );
      const actions = makeElement("div", "emby-error-actions");
      if (embyState.retry) {
        const retry = makeElement("button", "emby-button", "重试");
        retry.type = "button";
        retry.addEventListener("click", embyState.retry);
        actions.append(retry);
      }
      const back = makeElement("button", "emby-button", "返回");
      back.type = "button";
      back.addEventListener("click", () => {
        embyState.view = embyState.error?.returnView === "playback"
          ? embyState.previousRoute?.view || "home"
          : embyState.error?.returnView || (embyState.connected ? "home" : "disconnected");
        embyState.error = null;
        embyState.retry = null;
        renderEmby();
      });
      actions.append(back);
      view.append(actions);
      return view;
    };

    const showError = (errorValue, retry, returnView) => {
      if (embyState.playback) cleanupPlayback(true);
      const errorObject = toRpcError(errorValue);
      if (errorObject.code === "UNAUTHORIZED" || errorObject.code === "AUTH_EXPIRED" || errorObject.code === "HTTP_401") {
        cleanupPlayback(false);
        embyState.connected = false;
        embyState.inlineError = "登录已失效，请重新连接";
        embyState.view = "disconnected";
        renderEmby();
        return;
      }
      embyState.error = { message: errorObject.message, code: errorObject.code, returnView };
      embyState.retry = typeof retry === "function" ? retry : null;
      embyState.view = "error";
      renderEmby();
    };

    const loadHome = async (showLoading = true) => {
      if (showLoading) {
        embyState.loadingLabel = "正在加载媒体库…";
        embyState.view = "loading";
        renderEmby();
      }
      const applyHomeResult = (result) => {
        embyState.home = {
          views: Array.isArray(result?.views) ? result.views : [],
          resume: Array.isArray(result?.resume) ? result.resume.slice(0, 5) : [],
          latest: Array.isArray(result?.latest) ? result.latest.slice(0, 12) : []
        };
        embyState.connected = true;
        embyState.view = "home";
        renderEmby();
      };
      try {
        const result = await rpc("home.get", {}, { timeoutMs: 30_000 });
        if (disposed) return;
        applyHomeResult(result);
        if (result?.cacheStatus === "stale") {
          void rpc("home.get", { refresh: true }, { timeoutMs: 30_000 }).then((refreshed) => {
            if (disposed) return;
            embyState.home = {
              views: Array.isArray(refreshed?.views) ? refreshed.views : embyState.home.views,
              resume: Array.isArray(refreshed?.resume) ? refreshed.resume.slice(0, 5) : embyState.home.resume,
              latest: Array.isArray(refreshed?.latest) ? refreshed.latest.slice(0, 12) : embyState.home.latest
            };
            if (embyState.view === "home") renderEmby();
          }).catch(() => {});
        }
      } catch (errorValue) {
        showError(errorValue, () => loadHome(true), "home");
      }
    };

    const loadServers = async () => {
      const result = await rpc("servers.list");
      if (disposed) return;
      embyState.servers = Array.isArray(result?.servers) ? result.servers : [];
    };

    const logoutEmby = async () => {
      cleanupPlayback(true);
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = null;
      searchGeneration += 1;
      if (searchRequestId) cancelRpc(searchRequestId, true);
      searchRequestId = null;
      cancelImageLoads();
      for (const requestId of imageRequests) cancelRpc(requestId, true);
      imageRequests.clear();
      releaseImageCache();
      embyState.connected = false;
      embyState.home = { views: [], resume: [], latest: [] };
      embyState.libraryStack = [];
      embyState.libraryItems = [];
      embyState.libraryTotal = 0;
      embyState.searchQuery = "";
      embyState.searchItems = [];
      embyState.seriesItem = null;
      embyState.seasons = [];
      embyState.episodes = [];
      embyState.sourceOptions = [];
      embyState.scrollPositions.clear();
      embyState.inlineError = "";
      embyState.view = "disconnected";
      renderEmby();
      try {
        const result = await rpc("auth.logout", {});
        Object.assign(embyState.config, result || {});
        await loadServers();
        if (!disposed) renderEmby();
      } catch {
        // 本地已退出；后端清理失败不把敏感状态带回 UI。
      }
    };

    const renderEmby = (options = {}) => {
      if (disposed) return;
      let view;
      if (embyState.view === "disconnected") view = renderDisconnected();
      else if (embyState.view === "home") view = renderHome();
      else if (embyState.view === "servers") view = renderServers();
      else if (embyState.view === "library") view = renderLibrary();
      else if (embyState.view === "search") view = renderSearch();
      else if (embyState.view === "series") view = renderSeries();
      else if (embyState.view === "playback") view = renderPlayback();
      else if (embyState.view === "error") view = renderError();
      else view = renderLoading();
      embyApp.replaceChildren(view);
      restoreScroll();
      if (options.focusSearch) {
        requestAnimationFrame(() => {
          const input = embyApp.querySelector(".emby-search-input");
          if (!input) return;
          input.focus({ preventScroll: true });
          input.setSelectionRange(input.value.length, input.value.length);
        });
      }
    };

    const getEmbyState = () => ({
      view: embyState.view,
      connected: embyState.connected,
      baseUrl: embyState.config.baseUrl,
      username: embyState.config.username,
      resumeCount: embyState.home.resume.length,
      latestCount: embyState.home.latest.length,
      libraryCount: embyState.home.views.length,
      libraryItemCount: embyState.libraryItems.length,
      serverCount: embyState.servers.length,
      query: embyState.searchQuery,
      searchCount: embyState.searchItems.length,
      seasonCount: embyState.seasons.length,
      selectedSeasonId: embyState.selectedSeasonId,
      episodeCount: embyState.episodes.length,
      playing: Boolean(embyState.playback),
      subtitleCount: embyState.playback?.subtitles?.length || 0,
      selectedSubtitleIndex: embyState.playback?.selectedSubtitleIndex ?? null,
      subtitleMode: embyState.playback?.subtitleMode || "off",
      pendingRpcCount: pendingRpc.size,
      imageCacheCount: imageCache.size,
      imageCacheBytes,
      activeImageLoads,
      queuedImageLoads: imageLoadQueue.length,
      mseDiagnostics: activeDirectPlayer ? {
        keyframeCount: activeDirectPlayer.keyframeTimes.length,
        quotaRetries: activeDirectPlayer.quotaRetries,
        quotaKeyframeRecoveries: activeDirectPlayer.quotaKeyframeRecoveries,
        quotaRestarts: activeDirectPlayer.quotaRestarts,
        lastQuotaRecovery: activeDirectPlayer.lastQuotaRecovery,
        seekInFlight: activeDirectPlayer.seekInFlight,
        pendingSeekTime: activeDirectPlayer.pendingSeekTime,
        pointerActive: activeDirectPlayer.pointerActive,
        pointerSawSeek: activeDirectPlayer.pointerSawSeek
      } : lastMseDiagnostics
    });

    const dispatchEmby = (actionValue, payload = {}) => {
      const actionName = typeof actionValue === "string" ? actionValue : actionValue?.type;
      const actionPayload = typeof actionValue === "object" && actionValue !== null
        ? actionValue.payload ?? payload
        : payload;
      rememberScroll();
      if (actionName === "showDisconnected") {
        cleanupPlayback(false);
        embyState.connected = false;
        embyState.view = "disconnected";
      } else if (actionName === "showHome") {
        cleanupPlayback(false);
        embyState.connected = true;
        embyState.home = {
          views: actionPayload.views || [],
          resume: actionPayload.resume || [],
          latest: actionPayload.latest || []
        };
        embyState.libraryStack = [];
        embyState.libraryItems = [];
        embyState.view = "home";
      } else if (actionName === "showSearch") {
        embyState.searchQuery = actionPayload.query || "";
        embyState.searchItems = actionPayload.items || [];
        embyState.view = "search";
      } else if (actionName === "showSeries") {
        embyState.seriesReturnView = embyState.view === "search" ? "search" : "home";
        embyState.seriesItem = actionPayload.series || actionPayload.item || { id: "preview", name: "剧集", type: "Series" };
        embyState.seasons = actionPayload.seasons || [];
        embyState.selectedSeasonId = actionPayload.selectedSeasonId || embyState.seasons[0]?.id || null;
        embyState.episodes = actionPayload.episodes || [];
        embyState.sourceOptions = actionPayload.sourceOptions || [];
        embyState.view = "series";
      } else if (actionName === "previewPlayback") {
        embyState.previousRoute = { view: embyState.view, scrollKey: null, scrollTop: 0 };
        embyState.playback = {
          preview: true,
          itemId: actionPayload.item?.id || "preview",
          item: actionPayload.item || { id: "preview", name: "播放预览", type: "Video" }
        };
        embyState.view = "playback";
      } else if (actionName === "back") {
        if (embyState.view === "playback") {
          stopPlayback(true);
          return getEmbyState();
        }
        embyState.view = embyState.connected ? "home" : "disconnected";
      } else {
        throw new TypeError(`未知 Emby 动作：${actionName}`);
      }
      renderEmby({ focusSearch: embyState.view === "search" });
      return getEmbyState();
    };

    const initializeEmby = async () => {
      renderEmby();
      if (typeof globalThis[rpcBinding] !== "function") {
        embyState.view = "disconnected";
        renderEmby();
        return;
      }
      try {
        const result = await rpc("connection.status");
        if (disposed) return;
        Object.assign(embyState.config, result || {});
        embyState.connected = Boolean(result?.connected);
        await loadServers();
        if (embyState.connected) await loadHome(false);
        else if (embyState.servers.length > 1) {
          embyState.view = "servers";
          renderEmby();
        } else {
          embyState.view = "disconnected";
          renderEmby();
        }
      } catch (errorValue) {
        if (disposed) return;
        embyState.connected = false;
        embyState.inlineError = toRpcError(errorValue).message;
        embyState.view = "disconnected";
        renderEmby();
      }
    };

    const cleanupEmby = () => {
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = null;
      searchGeneration += 1;
      if (searchRequestId) cancelRpc(searchRequestId, true);
      searchRequestId = null;
      cleanupPlayback(true);
      cancelImageLoads();
      for (const requestId of imageRequests) cancelRpc(requestId, true);
      imageRequests.clear();
      for (const [requestId, pending] of pendingRpc) {
        clearTimeout(pending.timeout);
        pending.signal?.removeEventListener("abort", pending.onAbort);
        pending.reject(rpcError("UNMOUNTED", "Emby 卡片已卸载"));
        pendingRpc.delete(requestId);
      }
      releaseImageCache();
    };

    handlePanelHidden = () => {
      if (hongguoState.playback) {
        stopHongguoPlayback(true);
        hongguoState.view = hongguoState.selectedDrama ? "detail" : "home";
        renderHongguo();
      }
      if (embyState.playback) stopPlayback(true);
    };

    const embyApi = Object.freeze({
      receiveRpc,
      dispatch: dispatchEmby,
      getState: getEmbyState
    });

    const hongguoApi = Object.freeze({
      getState: () => ({
        view: hongguoState.view,
        featuredCount: hongguoState.featured.length,
        feedHasMore: hongguoState.feedHasMore,
        feedTotal: hongguoState.feedTotal,
        listCount: hongguoState.listItems.length,
        selectedDramaId: hongguoState.selectedDrama?.id || null,
        playing: Boolean(hongguoState.playback),
        error: hongguoState.error?.message || null,
        diagnostics: hongguoState.playback ? {
          streamMode: hongguoState.playback.streamMode || (hongguoState.playback.externalSource ? "external" : null),
          lastError: hongguoState.playback.lastError || null
        } : null
      }),
      openById: openHongguoById,
      openDrama: openHongguoDetail,
      playEpisode: (episode) => beginHongguoPlayback(hongguoState.selectedDrama, Number(episode))
    });

    const api = Object.freeze({
      version,
      cardsKey,
      hostId,
      railId,
      emby: embyApi,
      hongguo: hongguoApi,
      isMounted: () => !disposed,
      isPlaced: () => host.isConnected && !disposed,
      getPlacement: () => placementMode,
      setVideoSource,
      setVideoFile,
      clearVideo,

      unmount: () => {
        if (disposed) return;
        cleanupHongguo();
        cleanupEmby();
        disposed = true;
        clearTimeout(panelHiddenTimer);
        observer.disconnect();
        resizeObserver.disconnect();
        window.removeEventListener("resize", schedulePlacement);
        if (standalone) document.removeEventListener("click", onNativeTriggerCapture, true);
        restorePopoverPanel();
        restoreAnimationColumn();
        restoreOuterScroller();
        showNativeContent();
        restoreTriggerHighlight();
        document.getElementById(triggerHighlightStyleId)?.remove();
        removeCompanionButton();
        host.remove();
        document.getElementById(railId)?.remove();
      }
    });

    host.__hgCleanup = api.unmount;
    globalThis[bridgeKey] = api;
    queueMicrotask(() => {
      // 被关闭的卡片不启动任何加载/RPC/网络活动
      if (cards.hongguo) {
        void loadHongguoHome();
        void loadHongguoList();
      }
      if (cards.emby) void initializeEmby();
    });
    return { status: host.isConnected ? "mounted" : "waiting-for-layout", placement: placementMode, version };
  };

  if (!document.body) {
    document.addEventListener("DOMContentLoaded", mount, { once: true });
    return { status: "scheduled", version };
  }
  return mount();
}

export function buildInjectionSource(action = "mount", { cards, placement, cardOrder } = {}) {
  if (action !== "mount" && action !== "unmount") {
    throw new TypeError(`不支持的注入动作：${action}`);
  }
  const normalizedCards = {
    hongguo: cards?.hongguo !== false,
    emby: cards?.emby !== false
  };
  const normalizedPlacement = placement === "inline-in-summary" ? "inline-in-summary" : "standalone-button";
  const normalizedOrder = [];
  if (Array.isArray(cardOrder)) {
    for (const id of cardOrder) {
      if (["hongguo", "emby"].includes(id) && !normalizedOrder.includes(id)) normalizedOrder.push(id);
    }
  }
  for (const id of ["hongguo", "emby"]) {
    if (!normalizedOrder.includes(id)) normalizedOrder.push(id);
  }
  const config = JSON.stringify({
    action,
    bridgeKey: BRIDGE_KEY,
    cards: normalizedCards,
    placement: normalizedPlacement,
    cardOrder: normalizedOrder,
    hostId: HOST_ID,
    legacyBridgeKeys: LEGACY_BRIDGE_KEYS,
    legacyHostIds: LEGACY_HOST_IDS,
    legacyRailIds: LEGACY_RAIL_IDS,
    railId: RAIL_ID,
    version: INJECTION_VERSION
  });
  return `(${codexCompanionBootstrap.toString()})(${config})`;
}
