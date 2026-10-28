const REFRESH_MS = 30_000;
// 取消、实例替换和卡片关闭都不是需要提示用户的失败。
const SILENT_CODES = new Set(["ABORTED", "RPC_CANCELLED", "RPC_STALE_GENERATION", "CARD_DISABLED"]);

export function mount({ root, rpc, effects, signal }) {
  root.innerHTML = `<style>
    :host{display:block}*{box-sizing:border-box}
    .row{display:flex;align-items:center;gap:10px;padding:12px 14px 12px 18px;font-size:13px;line-height:1.35}
    .dot{flex:none;width:8px;height:8px;border-radius:50%;background:rgba(128,128,128,.55)}
    .dot[data-tone=ok]{background:#2f9e6e}.dot[data-tone=warn]{background:#d9822b}
    .text{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
    strong{font-weight:600;overflow-wrap:anywhere}.detail{font-size:12px;opacity:.65;overflow-wrap:anywhere}
    .detail:empty{display:none}
    button{flex:none;font:inherit;font-size:12px;border:0;border-radius:8px;padding:5px 10px;cursor:pointer;color:inherit;background:rgba(128,128,128,.12)}
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
