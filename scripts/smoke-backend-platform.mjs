import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const rootArgument = process.argv.indexOf("--repo-root");
const repoRoot = rootArgument >= 0 ? path.resolve(process.argv[rootArgument + 1]) : path.dirname(scriptRoot);
const { CompanionConfig } = await import(pathToFileURL(path.join(repoRoot, "src/companion-config.mjs")));
const { CARD_MANIFESTS } = await import(pathToFileURL(path.join(repoRoot, "src/card-registry.mjs")));
const { CdpConnection } = await import(pathToFileURL(path.join(repoRoot, "src/cdp-connection.mjs")));
const { reserveLoopbackPort } = await import(pathToFileURL(path.join(repoRoot, "src/launcher.mjs")));
const { listCdpTargets } = await import(pathToFileURL(path.join(repoRoot, "src/targets.mjs")));
const temporary = await mkdtemp(path.join(tmpdir(), "companion-backend-platform-"));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const checks = [];
const verify = (value, label) => { assert.ok(value, label); checks.push(label); };
const wait = async (operation, label, timeout = 10000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const value = await operation();
    if (value) return value;
    await pause(75);
  }
  throw new Error(`等待超时：${label}`);
};
const page = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%;overflow:hidden}button{font:inherit}</style>
<div class="app-shell-main-content-frame" style="height:100%"><div style="display:flex;height:100%"><main style="position:relative;min-width:0;flex:1">
<header><button id="pinned-toggle" aria-label="Toggle pinned summary" aria-pressed="true">Summary</button></header>
<div class="pointer-events-none absolute top-(--thread-floating-content-top-inset) right-0 bottom-(--thread-floating-content-bottom-inset) z-40" style="position:absolute;top:40px;right:0;bottom:12px;width:316px">
<div class="relative flex max-h-full" style="position:relative;display:flex;height:100%;max-height:100%"><div id="native-column" class="pointer-events-none pe-4 max-h-full min-h-0 origin-top-right" style="width:316px;max-height:100%;padding-right:16px;box-sizing:border-box;opacity:1;visibility:visible;transform:none;transform-origin:top right">
<div id="native-panel" class="rounded-3xl bg-token-dropdown-background" style="width:300px;height:160px;font-weight:445">Native fixture</div></div></div></div></main></div></div>
<script>globalThis.__find = function find(selector, root = document) {
const found = root.querySelector(selector); if (found) return found;
for (const element of root.querySelectorAll("*")) { if (element.shadowRoot) { const nested = find(selector, element.shadowRoot); if (nested) return nested; } }
return null;
};
document.getElementById("pinned-toggle").addEventListener("click", function () {
const open = this.getAttribute("aria-pressed") !== "true";
this.setAttribute("aria-pressed", String(open));
document.getElementById("native-column").style.visibility = open ? "visible" : "hidden";
});</script>`;
let chrome;
let backend;
let backendExited;
let inspector;
let pageServer;
let targetServer;
let stderr = "";
let lines;
let debugPage;
try {
  // 用最新源码的临时快照重新生成 renderer，不覆盖开发目录的生成物。
  const snapshot = path.join(temporary, "source");
  await cp(path.join(repoRoot, "src"), path.join(snapshot, "src"), { recursive: true });
  await symlink(path.join(repoRoot, "node_modules"), path.join(snapshot, "node_modules"));
  const bun = path.join(repoRoot, "node_modules/.bin/bun");
  const rendererPath = path.join(temporary, "renderer.js");
  await exec(bun, ["build", path.join(snapshot, "src/renderer/entry.mjs"), "--target=browser", "--format=iife", "--outfile", rendererPath]);
  const renderer = await readFile(rendererPath, "utf8");
  const artifactHash = createHash("sha256").update(renderer).digest("hex");
  await writeFile(path.join(snapshot, "src/renderer-embedded.generated.mjs"), `export const RENDERER_ARTIFACT_HASH = ${JSON.stringify(artifactHash)};\nexport const RENDERER_SOURCE = ${JSON.stringify(renderer)};\n`);
  const fixtureSource = (await readFile(path.join(scriptRoot, "fixtures/compiled-platform-backend.mjs"), "utf8")).replaceAll("__SOURCE_ROOT__", snapshot);
  const fixturePath = path.join(temporary, "backend-fixture.mjs");
  const executable = path.join(temporary, "backend-fixture");
  await writeFile(fixturePath, fixtureSource);
  await exec(bun, ["build", "--compile", fixturePath, "--outfile", executable], { maxBuffer: 8 * 1024 * 1024 });
  checks.push("Bun --compile 导入真实 CLI/runtime/config/watcher 成功");

  const configPath = path.join(temporary, "config-v2.json");
  const store = new CompanionConfig({ path: configPath });
  let config = await store.loadV2({ strict: true });
  config = await store.patch({ enabled: true, cards: Object.fromEntries(CARD_MANIFESTS.map((manifest) => [manifest.id, { enabled: manifest.id === "games", settings: {} }])) }, { expectedRevision: config.revision });
  pageServer = createServer((_request, response) => { response.setHeader("Content-Type", "text/html;charset=utf-8"); response.end(page); });
  await new Promise((resolve) => pageServer.listen(0, "127.0.0.1", resolve));
  const chromePort = await reserveLoopbackPort();
  const pageUrl = `http://127.0.0.1:${pageServer.address().port}/`;
  chrome = spawn(process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--window-size=1400,1100",
    "--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${chromePort}`, `--user-data-dir=${path.join(temporary, "chrome-profile")}`, pageUrl,
  ], { stdio: "ignore" });
  const target = await wait(async () => {
    try { return (await listCdpTargets(chromePort)).find((entry) => entry.type === "page" && entry.url === pageUrl); } catch { return false; }
  }, "隔离 Chrome page");
  // 只改夹具元数据；产品 targets 过滤器、CDP WebSocket 与浏览器均为真实实现。
  targetServer = createServer((request, response) => {
    if (request.url !== "/json/list") { response.writeHead(404).end(); return; }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify([{ ...target, url: "app://-/index.html", title: "Compiled backend fixture" }]));
  });
  await new Promise((resolve) => targetServer.listen(0, "127.0.0.1", resolve));
  inspector = new CdpConnection(target.webSocketDebuggerUrl);
  await inspector.connect();
  const evaluate = async (expression) => {
    const result = await inspector.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  };
  debugPage = evaluate;
  await inspector.send("Page.enable");
  backend = spawn(executable, [String(targetServer.address().port), configPath], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, CODEX_COMPANION_CONFIG_PATH: configPath } });
  backendExited = new Promise((resolve) => backend.once("exit", (code, signal) => resolve({ code, signal })));
  backend.stderr.on("data", (chunk) => { stderr += chunk; });
  const pending = new Map();
  let ready;
  let nextId = 0;
  lines = createInterface({ input: backend.stdout });
  lines.on("line", (line) => {
    const result = JSON.parse(line);
    if (result.event === "ready") ready = result;
    else { pending.get(result.id)?.(result); pending.delete(result.id); }
  });
  const command = (name) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`compiled fixture ${name} 超时：${stderr}`)); }, 5000);
    pending.set(id, (result) => { clearTimeout(timer); resolve(result); });
    backend.stdin.write(`${JSON.stringify({ id, command: name })}\n`);
  });
  await wait(() => ready || (backend.exitCode !== null ? Promise.reject(new Error(stderr || `backend exit ${backend.exitCode}`)) : false), "compiled backend ready", 15000);
  verify(ready.compiled && ready.counters.socketsOpen === 1 && ready.counters.bindings === 1, "编译后端建立真实 CDP session 与 RPC binding");
  verify(ready.serviceScopes === 0, "仅启用 games，媒体服务没有请求 scope");
  await evaluate("globalThis.__CODEX_COMPANION__.setOpen(true)");
  await wait(() => evaluate('Boolean(__find("#codex-companion-root")?.shadowRoot.querySelector("[data-card=games] .content")?.shadowRoot.querySelector(".game-board"))'), "games mount");
  await evaluate(`globalThis.__backendNodes = {
    native: document.getElementById("native-panel"),
    runtime: globalThis.__CODEX_COMPANION__.runtime,
    slot: __find("#codex-companion-root").shadowRoot.querySelector("[data-card=games]"),
    game: __find("#codex-companion-root").shadowRoot.querySelector("[data-card=games] .content").shadowRoot.querySelector(".games-card")
  }`);
  const state = () => evaluate("globalThis.__CODEX_COMPANION__?.runtime?.getConfig() ?? null");
  const patch = async (change) => {
    config = await store.patch(change, { expectedRevision: config.revision });
    await wait(async () => (await state())?.revision === config.revision, `watch revision ${config.revision}`);
  };
  const sameNodes = () => evaluate('globalThis.__CODEX_COMPANION__.runtime === __backendNodes.runtime && document.getElementById("native-panel") === __backendNodes.native && __find("#codex-companion-root").shadowRoot.querySelector("[data-card=games] .content").shadowRoot.querySelector(".games-card") === __backendNodes.game');
  await patch({ cards: { games: { settings: { fixtureTheme: "amber" } }, "future-card": { enabled: false, settings: { retained: true } } } });
  verify((await state()).cards.games.settings.fixtureTheme === "amber" && await sameNodes(), "外部配置 patch→watcher→injector→settings，游戏/原生节点不重建");
  const nextOrder = ["future-card", ...CARD_MANIFESTS.map((manifest) => manifest.id).reverse()];
  await patch({ order: nextOrder });
  verify(JSON.stringify((await state()).order) === JSON.stringify(nextOrder) && await sameNodes(), "排序透传且保留现有游戏节点");
  verify(await evaluate(`Number(__backendNodes.slot.style.order) === ${nextOrder.indexOf("games")}`), "排序实际更新 CardSlot order");
  await patch({ placement: "inline-in-summary" });
  await evaluate("globalThis.__CODEX_COMPANION__.setOpen(true)");
  await wait(() => evaluate('__CODEX_COMPANION__.runtime.getDiagnostics().adapter.mode === "animated-summary"'), "inline native layout");
  verify(await sameNodes(), "placement 改为 inline 后保留游戏实例与原生面板");
  await patch({ cards: { games: { enabled: false } } });
  verify(await evaluate('!__backendNodes.game.isConnected && __CODEX_COMPANION__.runtime.getDiagnostics().shell.count === 0'), "禁用回收游戏并保持 runtime");
  await patch({ cards: { games: { enabled: true } } });
  await wait(() => evaluate('Boolean(__find("#codex-companion-root")?.shadowRoot.querySelector("[data-card=games] .content")?.shadowRoot.querySelector(".game-board"))'), "games re-enable");
  verify(await evaluate('__find("#codex-companion-root").shadowRoot.querySelector("[data-card=games] .content").shadowRoot.querySelector(".games-card") !== __backendNodes.game && __CODEX_COMPANION__.runtime === __backendNodes.runtime'), "重新启用创建新游戏，runtime 保持原实例");
  let status = await command("status");
  verify(status.counters.mounts === 1 && status.counters.configUpdates === 5 && status.counters.watchUpdates >= 6, "五次配置变化只 applyConfig，不重跑 bundle");
  verify(status.serviceScopes === 0 && status.errors.length === 0, "配置链路未触发媒体请求或后端错误");

  await inspector.send("Page.reload", { ignoreCache: true });
  await wait(async () => {
    try { return (await state())?.revision === config.revision; } catch { return false; }
  }, "reload latest config");
  verify((await state()).cards.games.settings.fixtureTheme === "amber" && (await state()).placement === "inline-in-summary", "页面 reload 从最新导航脚本恢复 settings 与 placement");
  status = await command("status");
  verify(status.counters.mounts === 1, "reload 无需后端重新执行 bundle");

  await evaluate("globalThis.__CODEX_COMPANION__.setOpen(true)");
  await wait(() => evaluate('Boolean(__find(".games-card"))'), "reload games mount");
  // 原始 binding 发起请求，接收端只观察真实 CDP 响应并继续转发到产品客户端。
  // games 无业务 RPC；独立 generation 不影响 renderer 的游戏实例。
  const rpc = await evaluate(`(async () => {
    const runtime = __CODEX_COMPANION__.runtime;
    const original = runtime.receiveRpc;
    const game = __find(".games-card");
    const pending = new Map();
    runtime.receiveRpc = function(response) {
      try { return original.call(this, response); }
      finally { pending.get(response.id)?.(response); }
    };
    const request = (id, method, generation) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("RPC response timeout: " + method)); }, 5000);
      pending.set(id, response => { clearTimeout(timer); pending.delete(id); resolve(response); });
      try { __CODEX_COMPANION_RPC__(JSON.stringify({ id, method, params: {}, cardId: "games", generation })); }
      catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    });
    try {
      const success = await request("backend-rpc-dispose", "games.lifecycle.dispose", 900001);
      const failure = await request("backend-rpc-unknown", "games.fixtureUnknown", 900002);
      return { success, failure, gameRetained: game.isConnected && __find(".games-card") === game && __CODEX_COMPANION__.runtime === runtime };
    } finally { runtime.receiveRpc = original; }
  })()`);
  verify(rpc.success.ok === true && rpc.success.result?.disposed === true, "浏览器 binding→编译 Bun RPC bridge→Registry 清理→真实 CDP 成功响应");
  verify(rpc.failure.ok === false && rpc.failure.error?.code === "RPC_METHOD_NOT_FOUND", "未知方法经过真实跨 CDP 链路返回 RPC_METHOD_NOT_FOUND");
  status = await command("status");
  verify(status.counters.rpcSuccessResponses === 1 && status.counters.rpcErrorResponses === 1
    && status.scopes.length === 1 && status.scopes[0].cardId === "games"
    && status.scopes[0].generation === 900001 && status.scopes[0].disposed && status.errors.length === 0,
  "后端发送一成功一错误响应，仅创建并清理 games 独立 scope，无媒体 scope");
  verify(rpc.gameRetained, "后端独立 generation 清理与未知请求均不重建游戏或 runtime");
  const stopped = await command("stop");
  verify(stopped.stopped && stopped.serviceClosed && stopped.counters.socketsOpen === 0, "stop 关闭 watcher、真实 CDP session 与服务 registry");
  const exited = await Promise.race([backendExited, pause(3000).then(() => ({ timeout: true }))]);
  verify(exited.code === 0 && !exited.timeout, "编译进程自然退出，无残留连接或定时器");
  const configAfterStop = await state();
  config = await store.patch({ cards: { games: { settings: { fixtureTheme: "after-stop" } } } }, { expectedRevision: config.revision });
  await pause(1700);
  verify((await state()).revision === configAfterStop.revision, "stop 后外部 patch 不再更新页面");
  console.log(JSON.stringify({ ok: true, checks, artifactHash, counters: stopped.counters, errors: stopped.errors }, null, 2));
} catch (error) {
  if (stderr) console.error(stderr);
  if (debugPage) console.error(JSON.stringify(await debugPage("globalThis.__CODEX_COMPANION__?.runtime?.getDiagnostics() ?? null").catch(() => null)));
  console.error(JSON.stringify({ ok: false, checks, error: error.stack }, null, 2));
  process.exitCode = 1;
} finally {
  lines?.close();
  inspector?.close();
  if (backend && backend.exitCode === null) { backend.kill("SIGTERM"); await Promise.race([backendExited, pause(1000)]); if (backend.exitCode === null) backend.kill("SIGKILL"); }
  if (chrome) {
    const ended = new Promise((resolve) => chrome.once("exit", resolve));
    chrome.kill("SIGTERM");
    await Promise.race([ended, pause(1000)]);
    if (chrome.exitCode === null) chrome.kill("SIGKILL");
  }
  if (targetServer) await new Promise((resolve) => targetServer.close(resolve));
  if (pageServer) await new Promise((resolve) => pageServer.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
