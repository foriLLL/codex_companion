export function mount({ root, rpc, effects, signal }) {
  root.innerHTML = `<style>
    :host{display:block}*{box-sizing:border-box}.body{min-height:220px;padding:24px 18px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;text-align:center}
    .symbol{font-size:32px;color:#459779}h2{font-size:16px;margin:0}p{font-size:12px;opacity:.7;margin:0}
    button{font:inherit;border:0;border-radius:12px;padding:10px 14px;cursor:pointer;color:inherit;background:rgba(128,128,128,.1)}[role=status]{font-size:12px;min-height:16px}
  </style><div class="body"><div class="symbol">♠</div><h2>River Club · 河牌俱乐部</h2><p>和朋友开一桌。使用原站的飞书登录。</p><button type="button">在浏览器打开 ↗</button><div role="status"></div></div>`;
  const button = root.querySelector("button");
  const status = root.querySelector("[role=status]");
  effects.listen(button, "click", async () => {
    button.disabled = true;
    status.textContent = "正在打开…";
    try {
      await rpc("open");
      if (!signal.aborted) status.textContent = "已在浏览器打开";
    } catch (error) {
      if (!signal.aborted) status.textContent = error.message || "打开失败，请重试";
    } finally { if (!signal.aborted) button.disabled = false; }
  });
  return { dispose() { root.replaceChildren(); } };
}
