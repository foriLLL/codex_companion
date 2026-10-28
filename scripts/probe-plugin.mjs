import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CARD_MANIFESTS } from "../src/card-registry.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const exec = promisify(execFile);

// 验证真正发布的可执行文件，而不是仅测试 Node 源码或包的注册记录。
export async function probePlugin({ pluginDir = join(root, "dist", "plugin") } = {}) {
  const profile = await mkdtemp(join(tmpdir(), "companion-plugin-protocol-"));
  const transport = new StdioClientTransport({
    command: join(pluginDir, "companion-backend"), args: [], cwd: pluginDir,
    env: { ...process.env, CODEX_COMPANION_CONFIG_PATH: join(profile, "config-v2.json") }, stderr: "pipe"
  });
  const client = new Client({ name: "companion-production-probe", version: "0.1.0" });
  const viewId = randomUUID();
  let sequence = 0;
  const call = async (name, args) => {
    const response = await client.callTool({ name, arguments: args });
    assert.notEqual(response.isError, true, `${name} 返回错误`);
    return response.structuredContent;
  };
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name).sort(), ["companion.panel", "companion.rpc", "companion.config", "companion.state", "companion.view", "companion.launcher"].sort());
    const panel = tools.find(tool => tool.name === "companion.panel");
    assert.ok(panel);
    assert.deepEqual(panel._meta["openai/ui"].entrypoints, [{ type: "thread" }]);
    for (const tool of tools.filter(tool => tool.name !== "companion.panel")) assert.deepEqual(tool._meta.ui.visibility, ["app"]);
    const resource = await client.readResource({ uri: panel._meta.ui.resourceUri });
    const html = resource.contents.find(item => item.uri === panel._meta.ui.resourceUri);
    assert.equal(html.mimeType, "text/html;profile=mcp-app");
    assert.ok(html.text.includes('<script type="module">'));
    assert.ok(!html.text.includes("<!-- SCRIPT -->"));
    assert.deepEqual(html._meta.ui.csp, { connectDomains: [], resourceDomains: [], frameDomains: [] });
    const opened = await call("companion.panel", {});
    assert.equal(opened.ready, true);
    const initial = await call("companion.config", { operation: "get" });
    const ids = CARD_MANIFESTS.map(card => card.id);
    assert.deepEqual(initial.manifests.map(card => card.id), ids);
    assert.ok(ids.every(id => initial.config.cards[id]));
    const updated = await call("companion.config", { operation: "update", expectedRevision: initial.config.revision, patch: { order: [...ids].reverse(), cards: { emby: { enabled: false } } } });
    assert.deepEqual(updated.config.order, [...ids].reverse());
    const disabled = await client.callTool({ name: "companion.rpc", arguments: { viewId, id: ++sequence, method: "emby.connection.status", cardId: "emby", generation: 1, params: {} } });
    assert.equal(disabled.structuredContent.error.code, "CARD_DISABLED");
    const proxy = await call("companion.rpc", { viewId, id: ++sequence, method: "proxy.status", cardId: "proxy", generation: 1, params: {} });
    assert.equal(proxy.ok, true);
    assert.equal(typeof proxy.result.running, "boolean");
    const key = "codex-companion.card.games.probe";
    const value = JSON.stringify({ version: 1, revision: 1, value: { score: 42 } });
    await call("companion.state", { operation: "set", key, value, expectedRevision: null });
    const saved = await call("companion.state", { operation: "get", key });
    assert.equal(saved.value, value);
    const launcher = await call("companion.launcher", { operation: "get" });
    const preferences = { launchThroughProxy: false, proxyPort: 17890 };
    const launchSaved = await call("companion.launcher", { operation: "save", preferences, expectedRevision: launcher.revision });
    assert.deepEqual(launchSaved.preferences, preferences);
    assert.equal(launchSaved.revision, launcher.revision + 1);
    await call("companion.view", { operation: "dispose", viewId });
    const closed = await client.callTool({ name: "companion.rpc", arguments: { viewId, id: ++sequence, method: "proxy.status", cardId: "proxy", generation: 1, params: {} } });
    assert.equal(closed.structuredContent.error.code, "RPC_VIEW_CLOSED");
    const { stdout: memory } = await exec("/bin/ps", ["-p", String(transport.pid), "-o", "rss="], { timeout: 3000 });
    const backendRssMiB = Math.round(Number(memory.trim()) / 1024 * 10) / 10;
    assert.ok(Number.isFinite(backendRssMiB) && backendRssMiB > 0);
    return {
      passed: true, compiledBackend: true, cards: ids, tools: tools.map(tool => tool.name),
      uiMimeType: html.mimeType, htmlBytes: Buffer.byteLength(html.text), configRevisionChecked: true,
      statePersisted: true, launcherPreferencesPersisted: true, codexRestarted: false,
      viewDisposed: true, modelTurnsStarted: 0, userConfigModified: false,
      desktopUiRendered: false, backendRssMiB, memoryScope: "只含空闲插件后端，不含 Codex、页面或播放中的 FFmpeg"
    };
  } finally { await client.close(); await rm(profile, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  probePlugin().then(async result => {
    const folder = join(root, "dist", "plugin-evidence");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "protocol-probe.json"), `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify(result, null, 2));
  }).catch(error => { console.error(error); process.exitCode = 1; });
}
