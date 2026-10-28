import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import { CompanionPluginBackend, PLUGIN_UI_URI, sanitizePluginError } from "./backend.mjs";
import { runCodexHandoff } from "./launcher.mjs";
import { PLUGIN_VERSION } from "./metadata.mjs";

const text = value => ({ content: [], structuredContent: value });
const idSchema = z.union([z.string().min(1).max(128), z.number().int().safe()]);
const appOnly = { ui: { visibility: ["app"] } };

export function createCompanionMcpServer({
  backend = new CompanionPluginBackend(),
  uiPath = process.env.CODEX_COMPANION_PLUGIN_UI || resolve(process.cwd(), "ui.html"),
  readUi = () => readFile(uiPath, "utf8")
} = {}) {
  const server = new McpServer({ name: "codex-companion", version: PLUGIN_VERSION });
  registerAppResource(server, "companion-panel", PLUGIN_UI_URI, {}, async () => ({
    contents: [{
      uri: PLUGIN_UI_URI, mimeType: RESOURCE_MIME_TYPE, text: await readUi(),
      _meta: {
        ui: { prefersBorder: false, csp: { connectDomains: [], resourceDomains: [], frameDomains: [] } },
        "openai/ui": { availableDisplayModes: ["inline", "fullscreen"], preferredDisplayMode: "fullscreen" }
      }
    }]
  }));
  registerAppTool(server, "companion.panel", {
    title: "Companion", description: "在当前聊天旁打开 Companion 侧栏：红果短剧、Emby、摸鱼与代理状态。",
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: { ui: { resourceUri: PLUGIN_UI_URI }, "openai/ui": { entrypoints: [{ type: "thread" }] } }
  }, async () => ({ content: [{ type: "text", text: "Companion 已打开。" }], structuredContent: { ready: true } }));
  registerAppTool(server, "companion.rpc", {
    title: "Companion 卡片操作", description: "只供 Companion 页面调用已注册的卡片功能。",
    inputSchema: z.object({
      viewId: z.string().uuid(), id: idSchema, method: z.string().min(1).max(128),
      params: z.record(z.string(), z.unknown()).optional(), cardId: z.string().min(1).max(64), generation: z.number().int().safe().nonnegative()
    }).strict(), _meta: appOnly
  }, async (request, extra) => {
    const result = await backend.rpc(request, { signal: extra.signal });
    return { ...text(result), ...(result.ok ? {} : { isError: true }) };
  });
  const safe = handler => async request => {
    try { return text(await handler(request)); }
    catch (error) { return { ...text({ error: sanitizePluginError(error) }), isError: true }; }
  };
  registerAppTool(server, "companion.config", {
    title: "Companion 设置", description: "读取或更新卡片开关、排序和设置；更新使用 revision 检查。",
    inputSchema: z.object({
      operation: z.enum(["get", "update"]), knownRevision: z.number().int().safe().nonnegative().optional(),
      expectedRevision: z.number().int().safe().nonnegative().optional(), patch: z.record(z.string(), z.unknown()).optional()
    }).strict(), _meta: appOnly
  }, safe(request => backend.config(request)));
  registerAppTool(server, "companion.state", {
    title: "Companion 存档", description: "读取和保存本机游戏进度与卡片个人状态。",
    inputSchema: z.object({
      operation: z.enum(["get", "set"]), key: z.string().min(1).max(256).optional(), value: z.string().nullable().optional(),
      expectedRevision: z.number().int().safe().positive().nullable().optional()
    }).strict(), _meta: appOnly
  }, safe(request => backend.state(request)));
  registerAppTool(server, "companion.view", {
    title: "Companion 页面生命周期", description: "页面心跳与关闭时的后台媒体资源回收。",
    inputSchema: z.object({ operation: z.enum(["heartbeat", "dispose"]), viewId: z.string().uuid() }).strict(), _meta: appOnly
  }, safe(request => backend.view(request)));
  registerAppTool(server, "companion.launcher", {
    title: "Codex 启动设置", description: "保存本机代理偏好，或在用户明确点击后退出和重启 Codex。",
    inputSchema: z.object({
      operation: z.enum(["get", "save", "relaunch", "stop"]),
      preferences: z.object({ launchThroughProxy: z.boolean(), proxyPort: z.number().int().min(1).max(65535) }).strict().optional(),
      expectedRevision: z.number().int().safe().nonnegative().optional()
    }).strict(), _meta: appOnly
  }, safe(request => backend.launcher(request)));
  return { server, backend };
}

export async function startPluginServer(options = {}) {
  const { server, backend } = createCompanionMcpServer(options);
  let closing;
  const close = () => closing ??= (async () => { try { await backend.dispose(); } finally { await server.close(); } })();
  const transport = options.transport ?? new StdioServerTransport();
  const transportClosed = transport.onclose;
  transport.onclose = () => { transportClosed?.(); void close().catch(error => backend.report(error)); };
  try { await backend.start(); await server.connect(transport); }
  catch (error) { await close(); throw error; }
  return { server, backend, close };
}

const isMain = import.meta.main === true || process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const args = process.argv.slice(2);
    if (["--relaunch-codex", "--stop-codex"].includes(args[0])) {
      if (args.length !== 3 || !/^(0|[1-9]\d*)$/.test(args[1]) || !/^(0|[1-9]\d*)$/.test(args[2]) || Number(args[2]) > 65535) throw new Error("启动交接参数无效");
      await runCodexHandoff({ action: args[0] === "--stop-codex" ? "stop" : "relaunch", expectedPid: Number(args[1]),
        preferences: { launchThroughProxy: Number(args[2]) !== 0, proxyPort: Number(args[2]) || 7890 } });
    } else {
      if (args.length) throw new Error("未知插件启动参数");
      const { close } = await startPluginServer();
      const shutdown = () => { void close().then(() => { process.exitCode = 0; }, error => { console.error(sanitizePluginError(error)); process.exitCode = 1; }); };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    }
  } catch (error) {
    console.error(`[codex-companion-plugin] ${sanitizePluginError(error).message}`);
    process.exitCode = 1;
  }
}
