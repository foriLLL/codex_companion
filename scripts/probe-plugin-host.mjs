import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import { findCodexCli, installPlugin, PLUGIN_ID } from "./install-plugin.mjs";
import { CARD_MANIFESTS } from "../src/card-registry.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// 使用正式插件包和真正的 Codex app-server；只建空的临时线程，不运行模型回合。
export async function probePluginHost({ pluginDir = join(root, "dist", "plugin"), cliPath } = {}) {
  const temporary = await mkdtemp(join(tmpdir(), "companion-production-host-"));
  const profile = join(temporary, "profile");
  const isolatedPlugin = join(temporary, "plugin");
  const workspace = join(profile, "workspace");
  await mkdir(workspace, { recursive: true });
  const cli = await findCodexCli(cliPath);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CODEX_|OPENAI_|CHATGPT_)/.test(key)));
  env.CODEX_HOME = profile;
  env.CODEX_COMPANION_CONFIG_PATH = join(temporary, "companion", "config-v2.json");
  const result = { modelTurnsStarted: 0, userConfigModified: false, desktopUiRendered: false };
  const pending = new Map();
  let child;
  let sequence = 0;
  function request(method, params) {
    if (method === "turn/start" || method === "thread/resume") throw Error("禁止探针运行或接管会话");
    const id = ++sequence;
    return new Promise((resolveRequest, reject) => {
      const timeout = setTimeout(() => { pending.delete(id); reject(Error(`${method} 超时`)); }, 20_000);
      pending.set(id, { resolve: resolveRequest, reject, timeout });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }
  try {
    // MCP 子进程有环境变量白名单；测试路径写入临时包的明确 env，
    // 防止宿主过滤父进程环境后，后台意外回退到用户的真实配置。
    await cp(pluginDir, isolatedPlugin, { recursive: true });
    const mcpPath = join(isolatedPlugin, ".mcp.json");
    const mcp = JSON.parse(await readFile(mcpPath, "utf8"));
    for (const server of Object.values(mcp.mcpServers)) server.env = { ...server.env, CODEX_COMPANION_CONFIG_PATH: env.CODEX_COMPANION_CONFIG_PATH };
    await writeFile(mcpPath, `${JSON.stringify(mcp, null, 2)}\n`);
    const installed = await installPlugin({ pluginDir: isolatedPlugin, codexHome: profile, cliPath: cli });
    assert.equal(installed.installed, true);
    result.pluginRegistered = true;
    child = spawn(cli, ["app-server", "--stdio"], { cwd: workspace, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    // 不把宿主日志、路径或认证输出写到证据；只排空 stderr，防止管道阻塞。
    child.stderr.resume();
    const rejectPending = error => {
      for (const entry of pending.values()) { clearTimeout(entry.timeout); entry.reject(error); }
      pending.clear();
    };
    child.once("error", rejectPending);
    child.once("exit", code => rejectPending(Error(`app-server 已退出（${code}）`)));
    createInterface({ input: child.stdout }).on("line", line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timeout);
      if (message.error) entry.reject(Error(message.error.message));
      else entry.resolve(message.result);
    });
    await request("initialize", { clientInfo: { name: "companion_production_host_probe", version: "0.1.0" }, capabilities: { experimentalApi: true } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized" })}\n`);
    const thread = await request("thread/start", { cwd: workspace, ephemeral: true, approvalPolicy: "never", sandbox: "read-only" });
    assert.equal(thread.thread.ephemeral, true);
    assert.equal(thread.thread.turns.length, 0);
    const threadId = thread.thread.id;
    let companion;
    const until = Date.now() + 35_000;
    while (Date.now() < until) {
      const status = await request("mcpServerStatus/list", { threadId, detail: "full" });
      companion = status.data.find(server => server.pluginId === PLUGIN_ID);
      if (companion?.runtimeStatus === "connected") break;
      if (companion?.runtimeStatus === "failed") throw Error("正式插件的 MCP 后端启动失败");
      await new Promise(resolveWait => setTimeout(resolveWait, 250));
    }
    assert.equal(companion?.runtimeStatus, "connected", "宿主未连接正式插件");
    const tools = Object.values(companion.tools);
    const panel = tools.find(tool => tool.name === "companion.panel");
    assert.ok(panel);
    assert.deepEqual(panel._meta["openai/ui"].entrypoints, [{ type: "thread" }]);
    const resource = await request("mcpServer/resource/read", { threadId, server: companion.name, uri: panel._meta.ui.resourceUri });
    const html = resource.contents.find(item => item.uri === panel._meta.ui.resourceUri);
    assert.equal(html.mimeType, "text/html;profile=mcp-app");
    assert.ok(html.text.includes('<script type="module">'));
    const call = async (tool, args) => {
      const response = await request("mcpServer/tool/call", { threadId, server: companion.name, tool, arguments: args });
      assert.notEqual(response.isError, true, `${tool} 调用失败`);
      return response.structuredContent;
    };
    const config = await call("companion.config", { operation: "get" });
    const ids = CARD_MANIFESTS.map(card => card.id);
    assert.deepEqual(config.manifests.map(card => card.id), ids);
    const launcher = await call("companion.launcher", { operation: "get" });
    assert.equal(typeof launcher.preferences.launchThroughProxy, "boolean");
    assert.equal(launcher.relaunchPending, false);
    const viewId = randomUUID();
    const proxy = await call("companion.rpc", { viewId, id: "host-proxy", method: "proxy.status", cardId: "proxy", generation: 1, params: {} });
    assert.equal(proxy.ok, true);
    await call("companion.view", { operation: "dispose", viewId });
    Object.assign(result, { passed: true, runtimeStatus: companion.runtimeStatus, cards: ids,
      tools: tools.map(tool => tool.name), uiResourceRead: true, htmlBytes: Buffer.byteLength(html.text),
      cardRpcPassed: true, launcherPreferencesRead: true, codexRestarted: false, viewDisposed: true });
  } finally {
    if (child?.pid) {
      try { process.kill(-child.pid, "SIGTERM"); } catch {}
      await new Promise(resolveWait => { if (child.exitCode !== null) resolveWait(); else { child.once("exit", resolveWait); setTimeout(resolveWait, 1000).unref(); } });
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
    }
    for (const entry of pending.values()) clearTimeout(entry.timeout);
    pending.clear();
    await rm(temporary, { recursive: true, force: true });
    result.temporaryProfileRemoved = true;
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await probePluginHost();
    const folder = join(root, "dist", "plugin-evidence");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "host-probe.json"), `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
