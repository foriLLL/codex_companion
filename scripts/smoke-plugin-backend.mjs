// 插件后端冒烟：完全按插件包里的 .mcp.json（command/args/cwd）启动后端，
// 与 Codex 的启动方式一致；完成 MCP 握手、读取页面资源并调用只读工具。
// 用临时 HOME/APPDATA/XDG_CONFIG_HOME 隔离，不读写用户真实配置。
// node scripts/smoke-plugin-backend.mjs [--plugin-dir dist/plugin]
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const pluginDir = resolve(args[0] === "--plugin-dir" ? args[1] : join(root, "dist", "plugin"));
const { mcpServers: { companion: launch } } = JSON.parse(await readFile(join(pluginDir, ".mcp.json"), "utf8"));
const home = await mkdtemp(join(tmpdir(), "companion-backend-smoke-"));
const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  APPDATA: join(home, "AppData", "Roaming"),
  LOCALAPPDATA: join(home, "AppData", "Local"),
  XDG_CONFIG_HOME: join(home, ".config")
};
const child = spawn(launch.command, launch.args ?? [], { cwd: resolve(pluginDir, launch.cwd ?? "."), env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
let stderr = "";
child.stderr.on("data", (chunk) => { stderr += chunk; });
const pending = new Map();
createInterface({ input: child.stdout }).on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.error) waiter.reject(new Error(`${message.error.code} ${message.error.message}`));
  else waiter.resolve(message.result);
});
let nextId = 0;
const request = (method, params = {}) => new Promise((resolveRequest, reject) => {
  const id = ++nextId;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} 超时；stderr：${stderr.slice(-800)}`)); }, 20_000);
  pending.set(id, {
    resolve: (value) => { clearTimeout(timer); resolveRequest(value); },
    reject: (error) => { clearTimeout(timer); reject(error); }
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
});
const exited = new Promise((resolveExit) => child.once("exit", (code, signal) => resolveExit({ code, signal })));
child.once("error", (error) => { console.error(`无法启动后端：${error.message}`); process.exitCode = 1; });

try {
  const init = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } },
    clientInfo: { name: "companion-backend-smoke", version: "1.0.0" }
  });
  assert.equal(init.serverInfo.name, "codex-companion");
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const { tools } = await request("tools/list");
  const names = tools.map((tool) => tool.name).sort();
  for (const name of ["companion.config", "companion.launcher", "companion.panel", "companion.rpc", "companion.state", "companion.view"]) {
    assert.ok(names.includes(name), `缺少工具 ${name}`);
  }
  const panel = tools.find((tool) => tool.name === "companion.panel");
  const uri = panel._meta?.ui?.resourceUri;
  const resource = await request("resources/read", { uri });
  assert.match(resource.contents[0].text, /<html|<!doctype/i, "页面资源应为完整 HTML");
  const call = async (name, argumentsValue) => {
    const result = await request("tools/call", { name, arguments: argumentsValue });
    assert.notEqual(result.isError, true, `${name} 失败：${JSON.stringify(result.structuredContent)}`);
    return result.structuredContent;
  };
  const config = await call("companion.config", { operation: "get" });
  assert.ok(config.config ?? config.revision !== undefined, "应返回配置");
  await call("companion.state", { operation: "get" });
  const launcher = await call("companion.launcher", { operation: "get" });
  // 走一次真实卡片 RPC：Emby 连接状态会读取数据目录与系统凭证库。
  const rpc = async (method) => {
    const result = await call("companion.rpc", { viewId: randomUUID(), id: randomUUID(), method, cardId: method.split(".")[0], generation: 1, params: {} });
    assert.equal(result.ok, true, `${method} 失败：${JSON.stringify(result.error ?? result)}`);
    return result.result;
  };
  const emby = await rpc("emby.connection.status");
  console.log(JSON.stringify({
    ok: true,
    platform: `${process.platform}-${process.arch}`,
    server: init.serverInfo,
    tools: names,
    uiBytes: resource.contents[0].text.length,
    launcherSupported: launcher.supported ?? null,
    embyConnected: emby?.connected ?? null
  }, null, 2));
} finally {
  child.stdin.end();
  child.kill();
  await exited;
  await rm(home, { recursive: true, force: true });
}
