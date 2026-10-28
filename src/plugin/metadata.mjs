import manifest from "../../plugin/.codex-plugin/plugin.json" with { type: "json" };

// 声明、后端和页面共用版本；更新资源 URI，避免宿主继续复用旧版 UI 缓存。
export const PLUGIN_VERSION = manifest.version;
export const PLUGIN_UI_URI = `ui://codex-companion/panel/${PLUGIN_VERSION}.html`;
