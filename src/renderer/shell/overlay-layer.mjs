// 卡片抽屉之外、页面最顶层的浮层，例如快捷键唤出的面板。抽屉收起时整块 display:none + inert，
// 放在卡片自己 ShadowRoot 里的浮层（含 popover）都显示不出来，所以由平台在文档根上另开一层。
// 宿主节点第一次取 root 时才创建，被移走后下次取时重建；卡片卸载时由 effects 移除。
// 宿主本身不接收指针事件，业务在浮层里需要交互的元素自行设置 pointer-events。
export function createOverlayLayer({ document: doc, cardId, effects }) {
  let host = null;
  let root = null;
  let disposed = false;
  effects.add(() => {
    disposed = true;
    host?.remove();
    host = null;
    root = null;
  });
  return Object.freeze({
    get root() {
      if (disposed) throw Object.assign(new Error("卡片实例已卸载"), { code: "STATE_DISPOSED" });
      if (!host?.isConnected) {
        host?.remove();
        host = doc.createElement("div");
        host.id = `codex-companion-overlay-${cardId}`;
        // 高于卡片抽屉（2147483646）；color-scheme 让浮层里的系统色随宿主明暗切换。
        host.style.cssText = "all:initial !important;position:fixed !important;inset:0 !important;z-index:2147483647 !important;"
          + "pointer-events:none !important;color-scheme:light dark !important";
        root = host.attachShadow({ mode: "open" });
        doc.documentElement.append(host);
      }
      return root;
    }
  });
}
