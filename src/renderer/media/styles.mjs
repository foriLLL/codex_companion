// 两张媒体卡片共用视觉规则，仅注入各自 ShadowRoot。
export const mediaStyles = `
        :host { display: block; height: 100%; min-height: 0; }
        /* 语义色：错误/危险统一一个红（#c84848；深底上 #c33f3f 对比度仅约 3:1 偏弱） */
        :host { --cc-danger: #c84848; }
        * { box-sizing: border-box; }
        button, input { font: inherit; }
        button { color: inherit; }

        /* .panel 的 display:flex 会覆盖 UA 的 [hidden]；显式声明保证卡片开关生效 */
        .panel[hidden] { display: none; }


        .panel {
          width: 100%;
          /* 外框尺寸、圆角、阴影和间距由平台 CardSlot 管理。 */
          height: 100%;
          min-height: 0;
          display: flex;
          flex-direction: column;
          overflow: hidden;
          border: 0;
          border-radius: 0;
          color: var(--hg-panel-color, var(--color-token-text-primary, #1a1c1f));
          background: transparent;
          box-shadow: none;
          font-family: var(--hg-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
          font-size: 14px;
          font-weight: var(--hg-font-weight, 445);
          line-height: 21px;
        }

        .hg-panel { position: relative; padding: 0; }
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
          --emby-accent: var(--switch-track-color-checked, #3a83f7);
          --emby-focus: var(--color-token-focus-border, #3a83f7);
          --emby-ease: var(--cubic-move, cubic-bezier(.65, 0, .35, 1));
          position: relative;
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
        .emby-content { padding: 6px 14px 16px; }
        .emby-section + .emby-section { margin-top: 18px; }
        .emby-section-title {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin: 0 0 8px;
          color: var(--hg-header-color, var(--color-token-text-tertiary, rgba(26,28,31,.55)));
          font-size: 12px;
          font-weight: 500;
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
          border: 0;
          border-radius: 12px;
          background: var(--hg-hover-bg, rgba(127,127,127,.07));
          color: var(--hg-header-color, var(--color-token-text-tertiary, rgba(26,28,31,.55)));
          font-size: 12px;
          text-align: center;
        }
        .emby-series-visual img {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          object-fit: cover;
        }
        .emby-series-visual::after {
          content: "";
          position: absolute;
          inset: 0;
          background: linear-gradient(0deg, rgba(3,5,8,.88), rgba(3,5,8,.08) 75%);
        }
        .emby-progress {
          height: 3px;
          overflow: hidden;
          border-radius: 999px;
          background: rgba(255,255,255,.28);
        }
        .emby-progress > span {
          display: block;
          height: 100%;
          border-radius: inherit;
          background: var(--emby-accent);
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
        /* 横向列表贴到卡片边缘滚动，两端渐隐提示还能滑动；滚动后停在卡片起始处 */
        .emby-row {
          margin: 0 -14px;
          padding: 0 14px 2px;
          scroll-padding-inline: 14px;
          scroll-snap-type: x proximity;
          -webkit-mask-image: linear-gradient(90deg, transparent 0, #000 12px, #000 calc(100% - 20px), transparent);
          mask-image: linear-gradient(90deg, transparent 0, #000 12px, #000 calc(100% - 20px), transparent);
        }
        .emby-row > * { scroll-snap-align: start; }
        .emby-resume {
          position: relative;
          flex: 0 0 232px;
          aspect-ratio: 16 / 9;
          overflow: hidden;
          padding: 0;
          border-radius: 12px;
          color: #fff;
          background: linear-gradient(135deg, #2c3440, #101318);
          text-align: left;
          isolation: isolate;
        }
        .emby-resume:only-child { flex-basis: 100%; }
        .emby-resume img {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          object-fit: cover;
          transition: transform 300ms var(--emby-ease), opacity 120ms ease-out;
        }
        .emby-resume::after {
          content: "";
          position: absolute;
          inset: 0;
          background: linear-gradient(0deg, rgba(0,0,0,.82), rgba(0,0,0,.28) 46%, transparent 72%);
        }
        .emby-resume-copy {
          position: absolute;
          z-index: 1;
          right: 11px;
          bottom: 12px;
          left: 11px;
          display: grid;
          gap: 1px;
        }
        .emby-resume-name,
        .emby-resume-episode,
        .emby-resume-meta {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .emby-resume-name { font-size: 13px; font-weight: 600; line-height: 18px; }
        .emby-resume-episode { color: rgba(255,255,255,.88); font-size: 12px; line-height: 16px; }
        .emby-resume-meta { margin-top: 1px; color: rgba(255,255,255,.66); font-size: 11px; line-height: 15px; font-variant-numeric: tabular-nums; }
        .emby-resume .emby-progress {
          position: absolute;
          z-index: 1;
          right: 0;
          bottom: 0;
          left: 0;
          border-radius: 0;
          background: rgba(255,255,255,.22);
        }
        .emby-resume .emby-progress > span { border-radius: 0 2px 2px 0; }
        /* 悬停时浮现的播放按钮 */
        .emby-resume-play {
          position: absolute;
          z-index: 1;
          top: 50%;
          left: 50%;
          width: 38px;
          height: 38px;
          margin: -26px 0 0 -19px;
          border-radius: 50%;
          background: rgba(255,255,255,.22) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20'%3E%3Cpath d='M7.5 5.6v8.8c0 .5.55.8 1 .53l6.7-4.4a.62.62 0 0 0 0-1.06L8.5 5.07c-.45-.28-1 .03-1 .53Z' fill='white'/%3E%3C/svg%3E") center / 18px no-repeat;
          -webkit-backdrop-filter: blur(10px);
          backdrop-filter: blur(10px);
          opacity: 0;
          transform: scale(.9);
          transition: opacity 160ms ease-out, transform 200ms var(--emby-ease);
        }
        .emby-resume:hover img, .emby-library-tile:hover img { transform: scale(1.04); }
        .emby-resume:hover .emby-resume-play,
        .emby-resume:focus-visible .emby-resume-play { opacity: 1; transform: none; }
        .emby-library-tiles {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 8px;
        }
        .emby-library-tiles.emby-row {
          display: grid;
          grid-template-columns: none;
          grid-template-rows: repeat(2, auto);
          grid-auto-flow: column;
          grid-auto-columns: 124px;
        }
        .emby-library-tile {
          position: relative;
          aspect-ratio: 16 / 9;
          overflow: hidden;
          padding: 0;
          border: 0;
          border-radius: 10px;
          color: #fff;
          background: linear-gradient(145deg, #445263, #20252d);
          cursor: pointer;
          isolation: isolate;
          -webkit-tap-highlight-color: transparent;
        }
        .emby-library-tile img {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          object-fit: cover;
          opacity: 0;
          transition: transform 300ms var(--emby-ease), opacity 120ms ease-out;
        }
        .emby-library-tile img[data-image-state="loaded"] { opacity: 1; }
        .emby-library-tile::after {
          content: "";
          position: absolute;
          inset: 0;
          background: linear-gradient(0deg, rgba(0,0,0,.62), transparent 62%);
        }
        .emby-library-name {
          position: absolute;
          z-index: 1;
          right: 8px;
          bottom: 6px;
          left: 9px;
          overflow: hidden;
          font-size: 12px;
          font-weight: 600;
          line-height: 16px;
          text-align: left;
          text-overflow: ellipsis;
          white-space: nowrap;
          text-shadow: 0 1px 2px rgba(0,0,0,.35);
        }
        .emby-server-avatar {
          width: 26px;
          height: 26px;
          display: grid;
          flex: 0 0 auto;
          place-items: center;
          padding: 0;
          border: 0;
          border-radius: 50%;
          color: #fff;
          background: linear-gradient(145deg, hsl(var(--emby-avatar-hue, 210) 52% 56%), hsl(var(--emby-avatar-hue, 210) 48% 42%));
          cursor: pointer;
          font-size: 12px;
          font-weight: 600;
          line-height: 1;
          transition: box-shadow 150ms ease-out;
        }
        .emby-server-avatar:hover,
        .emby-server-avatar:focus-visible {
          outline: none;
          box-shadow: 0 0 0 2px var(--hg-panel-bg, #fff), 0 0 0 3.5px var(--hg-divider, rgba(127,127,127,.3));
        }
        .emby-resume:focus-visible,
        .emby-library-tile:focus-visible,
        .emby-poster-button:focus-visible .emby-poster {
          outline: 2px solid var(--emby-focus);
          outline-offset: 2px;
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
          width: 80px;
          min-width: 80px;
          padding: 0;
          border-radius: 10px;
          background: transparent;
          text-align: left;
        }
        .emby-poster {
          position: relative;
          width: 80px;
          height: 120px;
          overflow: hidden;
          border-radius: 10px;
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
        .emby-poster-name,
        .emby-poster-meta {
          display: block;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .emby-poster-name { margin-top: 6px; font-size: 12px; font-weight: 500; line-height: 16px; }
        .emby-poster-meta {
          color: var(--hg-header-color, var(--color-token-text-tertiary, rgba(26,28,31,.55)));
          font-size: 11px;
          line-height: 15px;
        }
        .emby-poster-button:hover,
        .emby-poster-button:focus-visible { background: transparent; }
        .emby-poster img { transition: opacity 120ms ease-out, filter 150ms ease-out; }
        .emby-poster-button:hover .emby-poster img { filter: brightness(1.08); }
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
        .emby-view[data-view="home"] > .emby-toolbar { gap: 10px; height: 46px; min-height: 46px; padding: 12px 14px 4px; }
        .emby-view[data-view="home"] > .emby-toolbar::after { display: none; }
        .emby-view[data-view="home"] .emby-search-wrap { height: 30px; border-radius: 10px; }
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
          border-color: var(--emby-focus);
          box-shadow: 0 0 0 3px color-mix(in srgb, var(--emby-focus) 18%, transparent);
        }
        .emby-search-input {
          min-width: 0;
          height: 100%;
          flex: 1;
          padding: 0 9px 0 0;
          border: 0;
          outline: none;
          color: inherit;
          background: transparent;
          font-size: 12px;
        }
        .emby-search-submit {
          order: -1;
          width: 30px;
          height: 100%;
          border-radius: 0;
        }
        .emby-search-submit:hover, .emby-search-submit:focus-visible { background: transparent; }
        .emby-search-input::placeholder { color: var(--hg-header-color, rgba(26,28,31,.5)); }
        .emby-search-input::-webkit-search-cancel-button { filter: grayscale(1); opacity: .55; }
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
        }
        /* 舞台按片源比例铺满卡片宽度；超高片源受 max-height 约束，信息区至少留 38%。 */
        .emby-stage {
          position: relative;
          flex: 0 0 auto;
          width: 100%;
          aspect-ratio: var(--emby-aspect, 16 / 9);
          max-height: 62%;
          overflow: hidden;
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
          font-size: 14px;
          text-shadow: 0 1px 2px #000, 0 0 2px #000;
        }
        .emby-video::-webkit-media-controls-toggle-closed-captions-button {
          display: none;
        }
        /* 原生全屏只会带上 <video>，自定义 chrome（返回/字幕/选集）会丢失；
           统一藏掉原生全屏按钮，走 chrome 里的容器全屏（makeFullscreenButton）。 */
        .hg-video::-webkit-media-controls-fullscreen-button,
        .emby-video::-webkit-media-controls-fullscreen-button {
          display: none;
        }
        .emby-playback:fullscreen { background: #000; }
        .emby-playback:fullscreen .emby-stage {
          flex: 1 1 auto;
          aspect-ratio: auto;
          max-height: none;
        }
        .emby-playback:fullscreen .emby-playback-info { display: none; }
        /* 全屏后 cue 字号随视口放大；卡片内保持 14px（见 .emby-video::cue）。 */
        .emby-playback:fullscreen .emby-video::cue {
          font-size: min(4.5vh, 44px);
        }
        /* 鼠标静止 2.5s 后隐藏画面上的控件；全屏下连光标一起隐藏（对齐原生 controls）。 */
        .hg-playback:fullscreen[data-mouse-idle="true"],
        .emby-playback:fullscreen[data-mouse-idle="true"] {
          cursor: none;
        }
        .hg-playback:fullscreen[data-mouse-idle="true"] .hg-playback-chrome {
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
          gap: 6px;
          padding: 8px 8px 22px;
          color: #fff;
          background: linear-gradient(rgba(0,0,0,.56), rgba(0,0,0,.18) 62%, transparent);
          opacity: 0;
          pointer-events: none;
          transition: opacity 160ms ease-out;
        }
        .emby-stage:hover .emby-playback-chrome,
        .emby-stage:focus-within .emby-playback-chrome {
          opacity: 1;
          pointer-events: auto;
        }
        /* 暂停时常显：用 JS 同步的 data-paused（play/pause 事件），不用 :has()/:paused ——
           若 renderer 不支持其中任一伪类，拼进上面的选择器列表会让整条规则作废。
           独立规则保证即使将来某伪类失效也只影响这一条。 */
        .emby-playback[data-paused="true"] .emby-playback-chrome {
          opacity: 1;
          pointer-events: auto;
        }
        .emby-playback[data-mouse-idle="true"]:not([data-paused="true"]) .emby-playback-chrome {
          opacity: 0;
          pointer-events: none;
        }
        .emby-playback-spacer { flex: 1; }
        .emby-playback-chrome .emby-icon-button {
          width: 28px;
          height: 28px;
          border-radius: 999px;
          color: #fff;
          background: rgba(0,0,0,.32);
          backdrop-filter: blur(12px);
        }
        .emby-playback-chrome .emby-icon-button:hover,
        .emby-playback-chrome .emby-icon-button:focus-visible {
          background: rgba(0,0,0,.5);
        }
        .emby-playback-info {
          position: relative;
          display: flex;
          flex-direction: column;
          gap: 12px;
          padding: 12px 14px 16px;
        }
        .emby-playback-heading {
          display: grid;
          gap: 3px;
          min-width: 0;
        }
        .emby-playback-kicker {
          overflow: hidden;
          color: var(--hg-header-color, var(--color-token-text-tertiary, rgba(26,28,31,.55)));
          font-size: 11px;
          line-height: 15px;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .emby-playback-title {
          display: -webkit-box;
          overflow: hidden;
          color: var(--hg-panel-color, currentColor);
          font-size: 14px;
          font-weight: 600;
          line-height: 19px;
          -webkit-box-orient: vertical;
          -webkit-line-clamp: 2;
        }
        .emby-playback-tags {
          display: flex;
          flex-wrap: wrap;
          gap: 4px;
          margin-top: 3px;
        }
        .emby-playback-tag {
          padding: 1px 6px;
          border-radius: 5px;
          color: var(--hg-header-color, var(--color-token-text-tertiary, rgba(26,28,31,.55)));
          background: var(--hg-hover-bg, rgba(127,127,127,.10));
          font-size: 10px;
          font-variant-numeric: tabular-nums;
          line-height: 16px;
          white-space: nowrap;
        }
        /* 上一集/下一集：Codex 分段控件样式的等宽双按钮。 */
        .emby-playback-episode-nav {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 2px;
          padding: 2px;
          border-radius: 10px;
          background: var(--color-background-segmented-form-default, rgba(127,127,127,.10));
        }
        .emby-playback-episode-nav[hidden] { display: none; }
        .emby-episode-nav-button {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 5px;
          height: 28px;
          min-width: 0;
          padding: 0 10px;
          border-radius: 8px;
          color: var(--hg-panel-color, currentColor);
          background: transparent;
          font: inherit;
          font-size: 12px;
          transition: background-color 120ms ease-out;
        }
        .emby-episode-nav-button svg {
          width: 13px;
          height: 13px;
          flex: 0 0 auto;
          fill: currentColor;
          stroke: currentColor;
          stroke-linejoin: round;
          stroke-width: 1.4;
        }
        .emby-episode-nav-button:hover:not(:disabled),
        .emby-episode-nav-button:focus-visible {
          outline: none;
          background: var(--color-background-segmented-form-selected, var(--hg-panel-bg, rgba(255,255,255,.9)));
          box-shadow: 0 0 0 .5px rgba(26,28,31,.08), 0 1px 2px rgba(0,0,0,.06);
        }
        .emby-episode-nav-button:disabled {
          cursor: default;
          opacity: .38;
        }
        .emby-playback-settings {
          overflow: visible;
          border-radius: 12px;
          background: var(--hg-hover-bg, rgba(127,127,127,.07));
        }
        .emby-playback-menu-anchor { position: relative; }
        .emby-playback-row {
          width: 100%;
          display: flex;
          align-items: center;
          gap: 8px;
          min-height: 36px;
          padding: 0 10px;
          border: 0;
          border-radius: 12px;
          color: var(--hg-panel-color, currentColor);
          background: transparent;
          font: inherit;
          font-size: 12px;
          text-align: left;
          cursor: pointer;
        }
        .emby-playback-row:hover,
        .emby-playback-row:focus-visible,
        .emby-playback-row[aria-expanded="true"] {
          outline: none;
          background: var(--hg-hover-bg, rgba(127,127,127,.10));
        }
        .emby-playback-row svg {
          width: 15px;
          height: 15px;
          flex: 0 0 auto;
          fill: none;
          stroke: currentColor;
          stroke-linecap: round;
          stroke-linejoin: round;
          stroke-width: 1.4;
        }
        .emby-playback-row svg:first-child { opacity: .72; }
        .emby-playback-row svg:last-child {
          width: 13px;
          height: 13px;
          color: var(--hg-header-color, var(--color-token-text-tertiary, rgba(26,28,31,.55)));
          transition: transform 160ms var(--emby-ease);
        }
        .emby-playback-row[aria-expanded="true"] svg:last-child { transform: rotate(90deg); }
        .emby-playback-row-label { flex: 0 0 auto; }
        .emby-playback-row-value {
          min-width: 0;
          flex: 1;
          overflow: hidden;
          color: var(--hg-header-color, var(--color-token-text-tertiary, rgba(26,28,31,.55)));
          text-align: right;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .emby-subtitle-menu {
          position: absolute;
          z-index: 5;
          top: calc(100% + 4px);
          right: 0;
          left: 0;
          max-height: 220px;
          overflow-y: auto;
          padding: 4px;
          border-radius: 12px;
          color: var(--hg-panel-color, currentColor);
          background: var(--hg-panel-bg, var(--color-token-main-surface-primary, #fff));
          border: .5px solid var(--hg-divider, rgba(127,127,127,.16));
          box-shadow: 0 3px 7.5px #0000000a, 0 6px 20px rgba(0,0,0,.08);
          animation: emby-menu-in 120ms ease-out;
        }
        @keyframes emby-menu-in {
          from { opacity: 0; transform: translateY(-3px); }
          to { opacity: 1; transform: none; }
        }
        .emby-subtitle-menu[hidden] { display: none; }
        .emby-subtitle-option {
          width: 100%;
          display: flex;
          align-items: center;
          gap: 7px;
          min-height: 30px;
          padding: 5px 8px;
          border: 0;
          border-radius: 8px;
          color: inherit;
          background: transparent;
          font: inherit;
          font-size: 12px;
          line-height: 16px;
          text-align: left;
          cursor: pointer;
        }
        .emby-subtitle-option:hover,
        .emby-subtitle-option:focus-visible {
          outline: none;
          background: var(--hg-hover-bg, rgba(127,127,127,.10));
        }
        .emby-subtitle-check {
          width: 14px;
          height: 14px;
          flex: 0 0 auto;
          fill: none;
          stroke: var(--emby-accent);
          stroke-linecap: round;
          stroke-linejoin: round;
          stroke-width: 1.7;
          visibility: hidden;
        }
        .emby-subtitle-option[aria-checked="true"] .emby-subtitle-check { visibility: visible; }
        /* 长字幕名（如 "Chinese Simplified · 外挂 · 听障"）截断，不换行挤压 meta */
        .emby-subtitle-label {
          min-width: 0;
          flex: 1;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .emby-subtitle-meta {
          flex: 0 0 auto;
          color: var(--hg-header-color, var(--color-token-text-tertiary, rgba(26,28,31,.55)));
          font-size: 10px;
        }
        .emby-episode-picker[hidden] { display: none; }
        .emby-episode-picker .emby-section-title { margin-bottom: 6px; }
        .emby-episode-picker-button {
          color: var(--hg-header-color, var(--color-token-text-tertiary, rgba(26,28,31,.55)));
          font-size: 11px;
          font-variant-numeric: tabular-nums;
          font-weight: 400;
        }
        .emby-episode-picker-header {
          display: flex;
          gap: 4px;
          margin: 0 0 8px;
          overflow-x: auto;
          scrollbar-width: none;
        }
        .emby-episode-picker-header[hidden] { display: none; }
        .emby-episode-picker-header::-webkit-scrollbar { display: none; }
        .emby-episode-season {
          flex: 0 0 auto;
          min-height: 24px;
          padding: 2px 9px;
          border-radius: 999px;
          color: var(--hg-header-color, var(--color-token-text-tertiary, rgba(26,28,31,.55)));
          background: transparent;
          font: inherit;
          font-size: 11px;
        }
        .emby-episode-season:hover { background: var(--hg-hover-bg, rgba(127,127,127,.10)); }
        .emby-episode-season[aria-selected="true"] {
          color: var(--hg-panel-color, currentColor);
          background: var(--hg-hover-bg, rgba(127,127,127,.12));
          font-weight: 500;
        }
        .emby-episode-picker-grid {
          position: relative;
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(38px, 1fr));
          gap: 6px;
          max-height: 194px;
          overflow-y: auto;
          overscroll-behavior: contain;
          scrollbar-width: none;
        }
        .emby-episode-picker-grid::-webkit-scrollbar { display: none; }
        .emby-episode-picker-item {
          position: relative;
          min-width: 0;
          height: 32px;
          padding: 0 4px;
          border-radius: 9px;
          color: var(--hg-panel-color, currentColor);
          background: var(--hg-hover-bg, rgba(127,127,127,.08));
          font: inherit;
          font-size: 12px;
          font-variant-numeric: tabular-nums;
          transition: background-color 120ms ease-out;
        }
        .emby-episode-picker-item[data-played="true"] {
          color: var(--hg-header-color, var(--color-token-text-tertiary, rgba(26,28,31,.55)));
        }
        .emby-episode-picker-item:hover,
        .emby-episode-picker-item:focus-visible {
          outline: none;
          background: var(--hg-hover-bg-strong, rgba(127,127,127,.16));
        }
        .emby-episode-picker-item[aria-current="true"] {
          color: #fff;
          background: var(--emby-accent);
          font-weight: 600;
        }
        .emby-episode-picker-empty {
          grid-column: 1 / -1;
          padding: 8px 0;
          color: var(--hg-header-color, var(--color-token-text-tertiary, rgba(26,28,31,.55)));
          font-size: 11px;
        }
        .emby-subtitle-status {
          position: absolute;
          z-index: 4;
          right: 50%;
          bottom: 44px;
          max-width: calc(100% - 24px);
          padding: 5px 10px;
          border-radius: 999px;
          color: #fff;
          background: rgba(0,0,0,.66);
          font-size: 11px;
          line-height: 15px;
          text-align: center;
          transform: translateX(50%);
          backdrop-filter: blur(12px);
        }
        .emby-subtitle-status[hidden] { display: none; }
        .emby-ended {
          position: absolute;
          z-index: 4;
          inset: 0;
          display: grid;
          place-items: center;
          padding: 12px;
          color: #fff;
          background: rgba(0,0,0,.62);
          backdrop-filter: blur(6px);
          animation: emby-fade-in 180ms ease-out;
        }
        .emby-ended[hidden] { display: none; }
        .emby-ended-card {
          display: grid;
          grid-template-columns: auto minmax(0, 1fr);
          align-items: center;
          gap: 4px 12px;
          max-width: 100%;
        }
        .emby-ended-next {
          position: relative;
          display: grid;
          width: 44px;
          height: 44px;
          grid-row: span 2;
          place-items: center;
          padding: 0;
          border: 0;
          border-radius: 999px;
          color: #fff;
          background: rgba(255,255,255,.14);
          cursor: pointer;
        }
        .emby-ended-next:hover,
        .emby-ended-next:focus-visible { outline: none; background: rgba(255,255,255,.24); }
        .emby-ended-next[hidden] { display: none; }
        .emby-ended-next:disabled { cursor: default; opacity: .4; }
        .emby-ended-ring {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
          transform: rotate(-90deg);
        }
        .emby-ended-ring circle {
          fill: none;
          stroke-width: 2.4;
        }
        .emby-ended-ring-track { stroke: rgba(255,255,255,.18); }
        .emby-ended-ring-value {
          stroke: #fff;
          stroke-dasharray: 100;
          stroke-dashoffset: 100;
          stroke-linecap: round;
        }
        .emby-ended[data-countdown="running"] .emby-ended-ring-value {
          animation: emby-countdown 8s linear forwards;
        }
        @keyframes emby-countdown {
          from { stroke-dashoffset: 100; }
          to { stroke-dashoffset: 0; }
        }
        .emby-ended-next-icon {
          width: 16px;
          height: 16px;
          fill: currentColor;
          stroke: currentColor;
          stroke-linejoin: round;
          stroke-width: 1.2;
        }
        .emby-ended-copy {
          display: grid;
          min-width: 0;
        }
        .emby-ended-label {
          color: rgba(255,255,255,.66);
          font-size: 11px;
          line-height: 15px;
        }
        .emby-ended-name {
          overflow: hidden;
          font-size: 13px;
          font-weight: 600;
          line-height: 18px;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .emby-ended-actions {
          display: flex;
          gap: 6px;
          grid-column: 2;
        }
        .emby-ended[data-has-next="false"] .emby-ended-card { grid-template-columns: auto; justify-items: center; }
        .emby-ended[data-has-next="false"] .emby-ended-copy,
        .emby-ended[data-has-next="false"] .emby-ended-next { display: none; }
        .emby-ended[data-has-next="false"] .emby-ended-actions { grid-column: 1; }
        .emby-ended-action {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          height: 26px;
          padding: 0 10px;
          border: 0;
          border-radius: 999px;
          color: #fff;
          background: rgba(255,255,255,.14);
          font: inherit;
          font-size: 11px;
          cursor: pointer;
        }
        .emby-ended-action[hidden] { display: none; }
        .emby-ended-action:hover,
        .emby-ended-action:focus-visible { outline: none; background: rgba(255,255,255,.24); }
        .emby-ended-action svg {
          width: 13px;
          height: 13px;
          fill: none;
          stroke: currentColor;
          stroke-linecap: round;
          stroke-linejoin: round;
          stroke-width: 1.5;
        }
        @media (prefers-reduced-motion: reduce) {
          .emby-ended[data-countdown="running"] .emby-ended-ring-value { animation: none; stroke-dashoffset: 0; }
          .emby-subtitle-menu { animation: none; }
        }
        .emby-error-title { color: var(--hg-panel-color, currentColor); font-weight: 650; }
        .emby-error-actions { display: flex; gap: 8px; }

`;
