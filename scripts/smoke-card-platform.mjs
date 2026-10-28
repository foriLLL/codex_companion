import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { CdpConnection } from "../src/cdp-connection.mjs";
import { reserveLoopbackPort } from "../src/launcher.mjs";
import { listCdpTargets } from "../src/targets.mjs";

// --repo 支持从独立 QA worktree 验证待集成实现，不复制或改写其模块。
const ownRepo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoArgument = process.argv.indexOf("--repo");
const repo = repoArgument < 0 ? ownRepo : resolve(process.argv[repoArgument + 1]);
const { discoverCards } = await import(pathToFileURL(join(repo, "src/platform/registry/discovery.mjs")));
const { CARD_MANIFESTS } = await import(pathToFileURL(join(repo, "src/card-registry.mjs")));
const temp = await mkdtemp(join(tmpdir(), "companion-card-platform-"));
const cardsDir = join(temp, "cards");
const probe = {
  id: "fixture-probe", title: "陌生测试卡", version: 1, defaultEnabled: false, defaultOrder: 50,
  layout: { height: "content", minHeight: 120, scroll: "outer" },
  lifecycle: { hidden: "retain", start: "first-visible" }, state: { scope: "target", version: 1 }, capabilities: ["storage", "rpc"]
};
// 陌生卡只增加目录；目录扫描、校验和 Runtime 均使用实际平台实现。
for (const manifest of [...CARD_MANIFESTS, probe]) {
  const directory = join(cardsDir, manifest.id); await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest));
  await writeFile(join(directory, "renderer.mjs"), "export function mount(ctx) { return globalThis.__fixtureMount(ctx); }\n");
}
const discovered = await discoverCards({ cardsDir, requireEntries: true });
assert.equal(discovered.cards.length, CARD_MANIFESTS.length + 1);
const catalog = discovered.cards.map(card => ({ manifest: card.manifest, rendererUrl: `/fixture-cards/${card.manifest.id}/renderer.mjs` }));
const fixturePath = join(ownRepo, "scripts/fixtures/card-platform-browser.mjs");
const server = createServer(async (req, res) => {
  try {
    if (req.url === "/") { res.setHeader("Content-Type", "text/html"); res.end('<html><head><style>html,body{margin:0;padding:0}</style></head><body data-ready="true"></body></html>'); return; }
    if (req.url === "/fixture-catalog.json") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(catalog)); return; }
    let file;
    if (req.url === "/fixture.mjs") file = fixturePath;
    else if (req.url.startsWith("/src/")) {
      file = resolve(repo, `.${req.url}`);
      if (!file.startsWith(`${repo}${sep}src${sep}`)) throw Error("invalid source path");
    } else if (req.url.startsWith("/fixture-cards/")) {
      file = resolve(cardsDir, req.url.slice("/fixture-cards/".length));
      if (!file.startsWith(`${cardsDir}${sep}`)) throw Error("invalid fixture path");
    } else { res.writeHead(404); res.end(); return; }
    res.setHeader("Content-Type", "text/javascript"); res.end(await readFile(file));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const port = await reserveLoopbackPort();
const profile = join(temp, "profile");
const url = `http://127.0.0.1:${server.address().port}`;
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--window-size=1280,900",
  "--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, url
], { stdio: "ignore" });
let connection;
try {
  let target;
  for (let attempt = 0; attempt < 100 && !target; attempt++) {
    try { target = (await listCdpTargets(port)).find(entry => entry.type === "page"); } catch {}
    if (!target) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(target?.webSocketDebuggerUrl, "隔离 Chromium 启动失败");
  // 全组合矩阵随卡片数阶乘增长，单次 evaluate 需要比默认 CDP 超时更长。
  connection = new CdpConnection(target.webSocketDebuggerUrl, { timeoutMs: 600_000 }); await connection.connect();
  const run = async expression => {
    const result = await connection.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  await connection.send("Page.navigate", { url });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await run(`location.protocol === 'http:' && document.body?.dataset.ready === 'true'`)) break;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  await run(`(async()=>{globalThis.unhandled=[];addEventListener('unhandledrejection',event=>{unhandled.push(String(event.reason?.stack||event.reason));event.preventDefault();});globalThis.fixture=await import('/fixture.mjs');})()`);
  const names = await run(`Object.keys(fixture.scenarios)`);
  const results = [];
  for (const name of names) {
    const result = await run(`(async()=>{try{return {name:${JSON.stringify(name)},ok:true,evidence:await fixture.scenarios[${JSON.stringify(name)}]()};}catch(error){return {name:${JSON.stringify(name)},ok:false,error:error.stack||error.message};}})()`);
    results.push(result);
    console.log(`${result.ok ? "PASS" : "FAIL"} ${name}: ${JSON.stringify(result.evidence ?? result.error)}`);
  }
  const unhandled = await run(`unhandled`);
  assert.deepEqual(unhandled, [], "浏览器存在未处理的 Promise 拒绝");
  const failures = results.filter(result => !result.ok);
  assert.equal(failures.length, 0, `${failures.length} 个平台浏览器场景失败: ${failures.map(result => result.name).join(", ")}`);
  const combinations = results.find(result => result.name === "matrix")?.evidence?.cases;
  console.log(`Card platform smoke passed against ${repo}: ${combinations} combinations and ${names.length - 1} lifecycle/integration scenarios`);
} finally {
  connection?.close(); chrome.kill("SIGTERM"); server.close();
  await new Promise(resolve => { chrome.once("exit", resolve); setTimeout(resolve, 1500).unref(); });
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
