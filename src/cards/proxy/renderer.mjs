const REFRESH_MS = 30_000;
// 取消、实例替换和卡片关闭都不是需要提示用户的失败。
const SILENT_CODES = new Set(["ABORTED", "RPC_CANCELLED", "RPC_STALE_GENERATION", "CARD_DISABLED"]);

export function mount({ root, rpc, effects, signal }) {
  root.innerHTML = `<style>
    :host{display:block;--text:color-mix(in srgb,currentColor 64%,transparent);--line:color-mix(in srgb,currentColor 10%,transparent);
      font-family:"Inter",ui-sans-serif,system-ui,-apple-system,"PingFang SC",sans-serif;letter-spacing:-.006em;-webkit-font-smoothing:antialiased}
    *{box-sizing:border-box}
    .row{display:flex;align-items:center;gap:11px;padding:12px 12px 12px 14px;font-size:13.5px;line-height:1.4}
    /* 状态放在小方块里：浅底、细描边，中间一个状态点。 */
    .dot{--tone:#8b8d98;flex:none;display:grid;place-items:center;width:28px;height:28px;border-radius:8px;
      background:color-mix(in srgb,var(--tone) 12%,transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--tone) 26%,transparent),0 1px 2px rgba(0,0,0,.05)}
    .dot::after{content:"";width:8px;height:8px;border-radius:50%;background:var(--tone)}
    .dot[data-tone=ok]{--tone:#2f9e6e}.dot[data-tone=warn]{--tone:#d9661b}
    .dot[data-tone=ok]::after{box-shadow:0 0 0 3px color-mix(in srgb,var(--tone) 22%,transparent)}
    .text{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
    strong{font-weight:600;overflow-wrap:anywhere}.detail{font-size:12px;color:var(--text);overflow-wrap:anywhere}
    .detail:empty{display:none}
    button{flex:none;font:inherit;font-size:12px;letter-spacing:inherit;border:0;border-radius:8px;padding:4px 10px;cursor:pointer;color:inherit;
      background:color-mix(in srgb,currentColor 5%,transparent);box-shadow:inset 0 0 0 1px var(--line);transition:background-color .16s ease}
    button:hover{background:color-mix(in srgb,currentColor 9%,transparent)}
    button:disabled{opacity:.5;cursor:default}
  </style><div class="row"><span class="dot" aria-hidden="true"></span><div class="text" role="status"><strong>正在读取代理状态…</strong><span class="detail"></span></div><button type="button" aria-label="刷新代理状态">刷新</button></div>`;
  const dot = root.querySelector(".dot");
  const title = root.querySelector("strong");
  const detail = root.querySelector(".detail");
  const button = root.querySelector("button");
  let pending = null;

  function show(tone, heading, text) {
    dot.dataset.tone = tone;
    title.textContent = heading;
    detail.textContent = text;
  }

  function render({ supported = true, running, proxyPort, reachable }) {
    if (!supported) {
      show("off", "此系统暂不检测 Codex 代理", "请在系统或 Codex 设置中配置网络代理");
    } else if (proxyPort === null) {
      show("off", "未使用 Companion 代理", running ? "启动时勾选「通过代理启动」即可" : "未找到 Codex 进程");
    } else if (reachable) {
      show("ok", `已通过代理启动 · 127.0.0.1:${proxyPort}`, "对话与界面请求均走此代理");
    } else {
      show("warn", `代理无响应 · 127.0.0.1:${proxyPort}`, "请检查代理软件是否在运行");
    }
  }

  function refresh() {
    if (pending) return pending;
    button.disabled = true;
    pending = (async () => {
      try {
        const status = await rpc("status");
        if (!signal.aborted) render(status);
      } catch (error) {
        if (signal.aborted || SILENT_CODES.has(error?.code)) return;
        show("off", "代理状态未知", error?.message || "读取失败，请稍后重试");
      } finally {
        pending = null;
        if (!signal.aborted) button.disabled = false;
      }
    })();
    return pending;
  }

  effects.listen(button, "click", () => { void refresh(); });
  // hidden=suspend：收起时平台暂停这个轮询，展开时由 visibilityChanged 立即补一次。
  effects.interval(() => { void refresh(); }, REFRESH_MS);
  void refresh();
  return {
    visibilityChanged({ visible }) { if (visible) void refresh(); },
    dispose() { root.replaceChildren(); }
  };
}
