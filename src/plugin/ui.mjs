import "./schema-policy.mjs";
import { App } from "@modelcontextprotocol/ext-apps";
import { CARD_MANIFESTS as ALL_MANIFESTS } from "../card-registry.mjs";
import { RENDERER_REGISTRY } from "../cards/renderer-registry.generated.mjs";
import { createCardRuntime, normalizeRuntimeConfig } from "../renderer/runtime/card-runtime.mjs";
import { createPluginShell } from "./shell.mjs";
import { createPluginAdapter } from "./adapter.mjs";
import { createPluginTransport, createPluginStorage } from "./transport.mjs";
import { PLUGIN_VERSION } from "./metadata.mjs";

// 插件 iframe 访问不到宿主左侧会话列表，依赖它的卡片（任务看板）只在注入模式提供。
const CARD_MANIFESTS = ALL_MANIFESTS.filter((card) => !card.capabilities.includes("threads"));
const app = new App({ name: "Companion", version: PLUGIN_VERSION }, {}, { autoResize: true });
let runtime;
let transport;
let storage;
let selected;
let config;
let pollTimer;
let heartbeatTimer;
let disposed = false;
let disposal;
let applying = Promise.resolve();
let changing = false;
let polling = false;
let launcherRevision;
const navigationKey = "plugin.navigation.selected";
const silentErrors = new Set(["ABORTED", "RPC_CANCELLED", "RPC_STALE_GENERATION", "CARD_DISABLED", "STATE_DISPOSED"]);

const shell = createPluginShell({
  manifests: CARD_MANIFESTS,
  onSelect: selectCard,
  async onUpdateConfig(patch) {
    changing = true;
    try {
      const expectedRevision = config.revision;
      const response = await transport.config({ operation: "update", expectedRevision, patch });
      // 启动偏好与卡片设置同存于 config-v2，共用一个 revision。本窗口自己的卡片写入
      // 没有改动启动偏好；若启动表单读取的正是写入前的版本，就跟进到新版本，
      // 避免随后保存启动偏好时误报「已在其他窗口更新」。
      if (launcherRevision === expectedRevision) launcherRevision = response.config.revision;
      await acceptConfig(response.config);
    } catch (error) {
      if (error.code === "CONFIG_CONFLICT") {
        const latest = await transport.config({ operation: "get" });
        await acceptConfig(latest.config);
        throw new Error("设置已在其他窗口更新，请再试一次");
      }
      throw error;
    } finally { changing = false; }
  },
  async onLoadLauncher() {
    const response = await transport.launcher({ operation: "get" });
    launcherRevision = response.revision;
    return response;
  },
  async onSaveLauncher(preferences, relaunch) {
    const response = await transport.launcher({ operation: "save", preferences, expectedRevision: launcherRevision });
    launcherRevision = response.revision;
    // 同理，卡片设置随即跟进到保存后的版本；失败时留给轮询刷新。
    await transport.config({ operation: "get" }).then((latest) => acceptConfig(latest.config), () => {});
    if (relaunch) {
      await storage.flush();
      await transport.launcher({ operation: "relaunch" });
    }
  },
  async onStopLauncher() {
    await storage.flush();
    return transport.launcher({ operation: "stop" });
  }
});

function report(error) {
  if (disposed || silentErrors.has(error?.code)) return;
  shell.toast(error?.message || "暂时无法完成，请稍后重试");
}

function chooseCard(next) {
  const enabled = next.order.filter((id) => next.cards[id]?.enabled && CARD_MANIFESTS.some((card) => card.id === id));
  if (enabled.includes(selected)) return selected;
  const remembered = storage?.local.getItem(navigationKey);
  if (enabled.includes(remembered)) return remembered;
  return enabled.includes("hongguo") ? "hongguo" : enabled[0];
}

function selectCard(id) {
  if (!runtime || !config.enabled || !config.cards[id]?.enabled || disposed) return;
  selected = id;
  shell.setActive(id);
  for (const card of CARD_MANIFESTS) void runtime.setCardVisibility(card.id, card.id === id);
  storage.local.setItem(navigationKey, id);
}

function acceptConfig(next) {
  applying = applying.catch(() => {}).then(async () => {
    if (disposed) return;
    const normalized = normalizeRuntimeConfig(next, CARD_MANIFESTS);
    if (config?.revision !== null && normalized.revision !== null && normalized.revision < config?.revision) return;
    config = normalized;
    selected = chooseCard(config);
    // 先登记覆盖值；新启用的卡片不会抢在当前页面之前挂载。
    for (const card of CARD_MANIFESTS) void runtime?.setCardVisibility(card.id, card.id === selected);
    await runtime?.applyConfig(config);
    shell.setConfig(config, selected);
  });
  return applying;
}

function updateHostContext() {
  const context = app.getHostContext() ?? {};
  const theme = context.theme === "dark" || context.theme === "light" ? context.theme : undefined;
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  // 官方宿主提供的样式变量只写入本页面，业务卡片沿继承链自然跟随。
  for (const [name, value] of Object.entries(context.styles?.variables ?? {})) {
    if (name.startsWith("--") && typeof value === "string") document.documentElement.style.setProperty(name, value);
  }
}
app.onhostcontextchanged = updateHostContext;

async function pollConfig() {
  if (polling || changing || disposed || document.visibilityState === "hidden") return;
  polling = true;
  try {
    const response = await transport.config({ operation: "get", knownRevision: config.revision });
    if (!response.unchanged && response.config) await acceptConfig(response.config);
    shell.setConnection("ready");
  } catch { shell.setConnection("error"); }
  finally { polling = false; }
}

function dispose() {
  if (disposal) return disposal;
  disposed = true;
  clearInterval(pollTimer);
  clearInterval(heartbeatTimer);
  document.removeEventListener("visibilitychange", onVisibility);
  window.removeEventListener("pagehide", onPageHide);
  // 先让卡片释放播放器/写回最终进度，再flush独立持久存储，最后释放页面scope。
  disposal = (async () => {
    try { await runtime?.dispose(); }
    finally {
      try { await storage?.dispose(); }
      finally { await transport?.dispose(); }
    }
  })();
  return disposal;
}
app.onteardown = async () => { await dispose(); return {}; };
function onPageHide(event) { if (!event.persisted) void dispose().catch(() => {}); }
function onVisibility() {
  if (document.visibilityState === "hidden") void storage?.flush().catch(report);
  else { void pollConfig(); void transport?.heartbeat().catch(() => {}); }
}
window.addEventListener("pagehide", onPageHide);
document.addEventListener("visibilitychange", onVisibility);

try {
  await app.connect();
  if (!disposed) {
    updateHostContext();
    transport = createPluginTransport(app);
    const [response, state] = await Promise.all([
      transport.config({ operation: "get" }),
      createPluginStorage(transport, { onError: report })
    ]);
    storage = state;
    if (disposed) { await storage.dispose(); throw Object.assign(new Error("页面已关闭"), { code: "ABORTED" }); }
    config = normalizeRuntimeConfig(response.config, CARD_MANIFESTS);
    selected = chooseCard(config);
    shell.setConfig(config, selected);
    const renderers = Object.fromEntries(Object.entries(RENDERER_REGISTRY).map(([id, renderer]) => [id, {
      ...renderer,
      mount: (context) => renderer.mount({ ...context, plugin: true, environment: { kind: "plugin", mediaTransport: "rpc" },
        confirmAction: (options) => shell.confirmAction({ ...options, signal: context.signal }) })
    }]));
    runtime = createCardRuntime({
      manifests: CARD_MANIFESTS, renderers, config,
      artifactHash: `plugin-${PLUGIN_VERSION}`,
      shellFactory: () => shell,
      adapterFactory: createPluginAdapter,
      rpcClient: transport.rpcClient,
      localStorage: storage.local,
      sessionStorage: storage.session,
      onError: report
    });
    for (const card of CARD_MANIFESTS) void runtime.setCardVisibility(card.id, card.id === selected);
    runtime.setOpen(true);
    shell.ready();
    shell.setConnection("ready");
    pollTimer = setInterval(() => { void pollConfig(); }, 2000);
    heartbeatTimer = setInterval(() => { void transport.heartbeat().catch(() => shell.setConnection("error")); }, 30_000);
    void transport.heartbeat().catch(() => shell.setConnection("error"));
  }
} catch (error) {
  if (!disposed) shell.startupError(error, () => location.reload());
}
