// 插件只管理自己的文档；可见性由宿主 iframe 的生命周期与页面导航共同决定。
export function createPluginAdapter({ host, onVisibilityChange = () => {} } = {}) {
  const doc = host.ownerDocument;
  let hasCards = false;
  let open = false;
  let disposed = false;
  let previous;
  function notify(reason) {
    const visible = !disposed && open && hasCards && doc.visibilityState !== "hidden";
    if (visible === previous) return;
    previous = visible;
    onVisibilityChange({ visible, reason, placement: "plugin" });
  }
  const changed = () => notify("document");
  doc.addEventListener("visibilitychange", changed);
  notify("initial");
  return {
    setPlacement() {},
    setHasCards(value) { hasCards = Boolean(value); notify("cards"); },
    setOpen(value) { open = Boolean(value); notify("navigation"); },
    isPlaced: () => !disposed && host.isConnected,
    getDiagnostics: () => ({ mode: "plugin", hasCards, visible: previous, disposed }),
    dispose() {
      if (disposed) return;
      disposed = true;
      doc.removeEventListener("visibilitychange", changed);
      notify("disposed");
    }
  };
}
