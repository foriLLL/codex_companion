import { createGameEngine, createGamesPersistence, mountGames } from "../../games.mjs";

// Shell 已提供每卡独立的内部 ShadowRoot，业务仅渲染其中的内容。
export function mount(ctx) {
  if (ctx.signal.aborted) return { dispose() {} };
  const wrapper = ctx.root.ownerDocument.createElement("section");
  wrapper.className = "games-card";
  wrapper.setAttribute("aria-label", "摸鱼小游戏");
  ctx.root.append(wrapper);
  // 即使后面的初始化抛错，平台 effects 仍能清理已插入的 DOM。
  ctx.effects.add(() => wrapper.remove());
  const engine = createGameEngine();
  const persistence = createGamesPersistence({ storage: ctx.storage, engine, signal: ctx.signal, reportError: ctx.reportError });
  const cleanup = mountGames(wrapper, engine, { persistence, signal: ctx.signal, effects: ctx.effects,
    confirmReset: ctx.confirmAction ? () => ctx.confirmAction({ title: "开始新一局？", message: "这款游戏的当前进度将被替换，其他游戏的进度会保留。", confirmLabel: "开始新一局" }) : undefined
  });
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    cleanup();
    wrapper.remove();
  };
  ctx.effects.add(dispose);
  return {
    updateSettings() {},
    // retained 游戏状态不因侧栏收起而重置或写回。
    visibilityChanged() {},
    dispose
  };
}
