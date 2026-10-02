import { CARD_MANIFESTS } from "../card-registry.mjs";
import { RENDERER_REGISTRY } from "../cards/renderer-registry.generated.mjs";
import { createCardRuntime } from "./runtime/card-runtime.mjs";

const BRIDGE_KEY = "__CODEX_COMPANION__";
let pending = null;

function cleanupLegacy() {
  try { globalThis.__CODEX_HG__?.unmount?.(); } catch {}
  delete globalThis.__CODEX_HG__;
  for (const id of ["codex-hg-root", "codex-hg-rail"]) document.getElementById(id)?.remove();
}

function bootstrap({ action = "mount", config = {}, artifactHash, version } = {}) {
  const previous = globalThis[BRIDGE_KEY];
  if (action === "unmount") {
    pending?.();
    pending = null;
    previous?.unmount?.();
    delete globalThis[BRIDGE_KEY];
    cleanupLegacy();
    return { status: "unmounted", version };
  }
  if (!document.body) {
    pending?.();
    const ready = () => { pending = null; bootstrap({ action, config, artifactHash, version }); };
    document.addEventListener("DOMContentLoaded", ready, { once: true });
    pending = () => document.removeEventListener("DOMContentLoaded", ready);
    return { status: "scheduled", version };
  }
  cleanupLegacy();
  if (previous?.artifactHash === artifactHash && previous?.runtime?.isMounted()) {
    void previous.runtime.applyConfig(config);
    return { status: "already-mounted", version };
  }
  try { previous?.unmount?.(); } catch {}
  // 只清理本平台旧宿主，不访问原生 Summary。
  for (const id of ["codex-companion-root", "codex-companion-rail"]) document.getElementById(id)?.remove();
  const runtime = createCardRuntime({ manifests: CARD_MANIFESTS, renderers: RENDERER_REGISTRY, config, artifactHash });
  const bridge = {
    version, artifactHash, cardsKey: artifactHash, runtime,
    hostId: "codex-companion-root", railId: "codex-companion-rail",
    isMounted: runtime.isMounted, isPlaced: runtime.isPlaced, getPlacement: runtime.getPlacement,
    receiveRpc: runtime.receiveRpc,
    setOpen: runtime.setOpen,
    unmount() {
      if (globalThis[BRIDGE_KEY] === bridge) delete globalThis[BRIDGE_KEY];
      return runtime.dispose();
    },
    // 旧调试脚本的窄兼容入口；RPC 投递与运行时不再依赖具体业务卡。
    get emby() { return { receiveRpc: runtime.receiveRpc, ...runtime.getCardApi("emby") }; },
    get hongguo() { return runtime.getCardApi("hongguo"); },
    setVideoSource: (...args) => runtime.getCardApi("hongguo")?.setVideoSource?.(...args),
    setVideoFile: (...args) => runtime.getCardApi("hongguo")?.setVideoFile?.(...args),
    clearVideo: (...args) => runtime.getCardApi("hongguo")?.clearVideo?.(...args)
  };
  globalThis[BRIDGE_KEY] = bridge;
  return { status: config.enabled === false || runtime.getDiagnostics().shell.count === 0 ? "cards-disabled" : "mounted", placement: runtime.getPlacement(), version };
}

globalThis.__CODEX_COMPANION_RENDERER__?.cancelPending?.();
globalThis.__CODEX_COMPANION_RENDERER__ = {
  bootstrap,
  cancelPending() { pending?.(); pending = null; }
};
