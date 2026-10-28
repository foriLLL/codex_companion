import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CompanionConfig } from "../src/companion-config.mjs";
import { CodexCompanionService } from "../src/codex-companion-service.mjs";
import { CompanionPluginBackend } from "../src/plugin/backend.mjs";
import { createCompanionMcpServer } from "../src/plugin/server.mjs";
import { PluginLauncher } from "../src/plugin/launcher.mjs";
import { HongguoService } from "../src/hongguo-service.mjs";
import { createGameEngine } from "../src/games.mjs";
import { CdpConnection } from "../src/cdp-connection.mjs";
import { reserveLoopbackPort } from "../src/launcher.mjs";
import { listCdpTargets } from "../src/targets.mjs";
import { createPluginMediaFixture } from "../test/fixtures/plugin-media.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const exec = promisify(execFile);
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const html = await readFile(join(root, "dist", "plugin", "ui.html"), "utf8");
const temp = await mkdtemp(join(tmpdir(), "companion-plugin-browser-"));
let media, backend, mcpServer, client, host, chrome, connection;
try {
  const evidence = join(root, "dist", "plugin-evidence");
  media = await createPluginMediaFixture();
  assert.ok(media, "插件媒体冒烟需要用户已安装的系统 FFmpeg");
  const logger = { warn() {}, info() {}, error() {} };
  const configStore = new CompanionConfig({ path: join(temp, "config-v2.json") });
  const initial = await configStore.loadV2();
  await configStore.patch({ enabled: true, cards: Object.fromEntries(["proxy", "games", "hongguo", "emby"].map(id => [id, { enabled: true }])) }, { expectedRevision: initial.revision });
  const drama = { id: "7503745441910017049", name: "插件测试短剧", totalEpisodes: 3, accessibleEpisodeCount: 3, fullEpisodeCount: 3, posterUrl: "https://fixture.invalid/poster.png" };
  let list = [];
  const hongguoService = new HongguoService({
    client: {
      home: async () => ({ data: { featured: [drama], items: [drama] }, cacheStatus: "fresh" }),
      featured: async () => [drama], search: async () => [drama], detail: async () => drama,
      episodeSource: async () => ({ mp4Url: "https://fixture.invalid/episode.mp4", durationSeconds: 6 }),
      loadImage: async url => ({ bytes: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jrVsAAAAASUVORK5CYII=", "base64"), contentType: "image/png", url }),
      loadRange: async (_url, { start, end }) => ({ bytes: media.mp4.subarray(start, Math.min(end + 1, media.mp4.length)), start, end: Math.min(end, media.mp4.length - 1), total: media.mp4.length })
    },
    listStorage: { load: async () => list, add: async entry => { list = [entry, ...list.filter(item => item.id !== entry.id)]; return list; }, remove: async id => { list = list.filter(item => item.id !== id); return list; } }
  });
  const service = new CodexCompanionService({ configStore, embyService: media.service, hongguoService,
    inspectCodexProxy: async () => ({ running: true, proxyPort: null }), logger });
  let launcherSpawns = 0;
  const launcher = new PluginLauncher({ configPath: configStore.path,
    execFileImpl: async () => { throw Error("测试不读取用户的启动器设置"); },
    inspectImpl: async () => [],
    spawnImpl: () => { launcherSpawns++; throw Error("浏览器冒烟不得启动或退出真实 Codex"); }
  });
  backend = new CompanionPluginBackend({ configStore, service, logger, launcher });
  const engine = createGameEngine(() => .25);
  await backend.stateStore.set("codex-companion-games-v1", JSON.stringify({ version: 1, selected: "2048", games: {
    "2048": { board: [2, 2, ...Array(14).fill(0)], score: 0 }, mines: engine.newMines(), solitaire: engine.newSolitaire()
  } }));
  ({ server: mcpServer } = createCompanionMcpServer({ backend, readUi: async () => html }));
  client = new Client({ name: "companion-browser-smoke", version: "1.0.0" });
  const [clientWire, serverWire] = InMemoryTransport.createLinkedPair();
  await backend.start({ watchConfig: false });
  await mcpServer.connect(serverWire);
  await client.connect(clientWire);
  await exec(join(root, "node_modules", "bun", "bin", "bun.exe"), ["build", join(root, "scripts", "fixtures", "plugin-host.mjs"), "--target=browser", "--format=esm", "--outfile", join(temp, "host.js")], { cwd: root });
  const hostScript = await readFile(join(temp, "host.js"));
  const packets = [];
  const errors = [];
  host = createServer(async (request, response) => {
    try {
      if (request.url === "/") {
        response.setHeader("content-type", "text/html");
        return response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{display:block;border:0;width:100%;height:100%}</style></head><body><iframe title="Companion" sandbox="allow-scripts allow-same-origin allow-forms allow-popups" allow="fullscreen; autoplay"></iframe><script type="module" src="/host.js"></script></body></html>');
      }
      if (request.url === "/host.js") { response.setHeader("content-type", "text/javascript"); return response.end(hostScript); }
      if (request.url === "/ui") {
        response.setHeader("content-type", "text/html");
        response.setHeader("content-security-policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src blob: data:; media-src blob: data:; worker-src blob:; connect-src 'none'; frame-src 'none'; font-src data:; base-uri 'none'");
        const instrumentation = "<script>globalThis.__smokeErrors=[];globalThis.__smokeCsp=[];addEventListener('unhandledrejection',e=>__smokeErrors.push(String(e.reason?.stack||e.reason)));addEventListener('error',e=>__smokeErrors.push(String(e.message)));addEventListener('securitypolicyviolation',e=>__smokeCsp.push({directive:e.violatedDirective,blocked:e.blockedURI}));</script>";
        return response.end(html.replace(/<head(?:\s[^>]*)?>/i, match => `${match}${instrumentation}`));
      }
      if (request.url === "/tool" && request.method === "POST") {
        const chunks = []; let length = 0;
        for await (const chunk of request) { length += chunk.length; if (length > 1024 * 1024) throw Error("tool request too large"); chunks.push(chunk); }
        const args = JSON.parse(Buffer.concat(chunks));
        const result = await client.callTool(args);
        const bytes = Buffer.byteLength(JSON.stringify(result));
        packets.push({ name: args.name, method: args.arguments?.method, bytes });
        if (result.isError) errors.push(result.structuredContent?.error?.code || "MCP_TOOL_ERROR");
        response.setHeader("content-type", "application/json");
        return response.end(JSON.stringify(result));
      }
      response.writeHead(404); response.end();
    } catch (error) { response.writeHead(500); response.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(resolve => host.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${host.address().port}`;
  const port = await reserveLoopbackPort();
  chrome = spawn(process.env.CODEX_COMPANION_TEST_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
    "--headless=new", "--no-first-run", "--no-default-browser-check", "--autoplay-policy=no-user-gesture-required", "--window-size=1100,850",
    "--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${port}`, `--user-data-dir=${join(temp, "profile")}`, url
  ], { stdio: "ignore" });
  let spawnError;
  chrome.once("error", error => { spawnError = error; });
  const results = [];
  let target;
  for (let index = 0; index < 100 && !target; index++) {
    if (spawnError) throw spawnError;
    try { target = (await listCdpTargets(port)).find(entry => entry.type === "page"); } catch {}
    if (!target) await pause(100);
  }
  assert.ok(target?.webSocketDebuggerUrl, "隔离 Chromium 未启动");
  connection = new CdpConnection(target.webSocketDebuggerUrl, { timeoutMs: 35_000 });
  await connection.connect();
  const browserRequests = [];
  connection.on("Network.requestWillBeSent", event => browserRequests.push(event.request.url));
  await connection.send("Network.enable");
  await connection.send("Page.enable");
  await connection.send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 850, deviceScaleFactor: 2, mobile: false });
  const run = async expression => {
    const result = await connection.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const wait = async (expression, label, timeout = 12_000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (await run(expression)) return; await pause(70); }
    throw Error(`等待超时：${label}; ${await run("fixture.frame.contentDocument.body.innerText.slice(-1200)")}`);
  };
  const doc = "fixture.document()";
  const card = id => `fixture.root(${JSON.stringify(id)})`;
  const clickTab = async id => {
    await run(`${doc}.querySelector('#tab-${id}').click()`);
    await wait(`${doc}.querySelector('#tab-${id}').getAttribute('aria-selected')==='true' && !!${card(id)}`, `切换 ${id}`);
  };
  await connection.send("Page.navigate", { url });
  await wait("!!globalThis.fixture?.initialized && fixture.document()?.querySelector('.connection')?.dataset.state==='ready'", "官方 MCP Apps 握手与页面初始化");
  assert.equal(await run(`${doc}.querySelectorAll('.nav-tab').length`), 4);
  const screenshot = async name => {
    await mkdir(evidence, { recursive: true });
    const capture = await connection.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await writeFile(join(evidence, `${name}.png`), Buffer.from(capture.data, "base64"));
  };
  for (const theme of ["light", "dark"]) {
    await run(`fixture.setTheme(${JSON.stringify(theme)})`);
    for (const width of [320, 420, 1100]) {
      await connection.send("Emulation.setDeviceMetricsOverride", { width, height: 850, deviceScaleFactor: 2, mobile: false });
      await run("fixture.dimensions()");
      for (const id of ["proxy", "games", "hongguo", "emby"]) {
        await clickTab(id);
        await pause(80);
        const dimensions = await run(`({width:${doc}.documentElement.clientWidth,scroll:${doc}.documentElement.scrollWidth,cardError:!!${doc}.querySelector('#panel-${id} .card-error:not([hidden])')})`);
        assert.ok(dimensions.scroll <= dimensions.width + 1, `${theme} ${width}px ${id} 横向溢出: ${JSON.stringify(dimensions)}`);
        assert.equal(dimensions.cardError, false, `${id} 卡片挂载失败`);
      }
      await screenshot(`${theme}-${width}`);
    }
  }
  results.push({ name: "theme-layout", cases: 30, screenshots: 6 });

  await clickTab("games");
  await wait(`!!${card("games")}.querySelector('.game-grid')`, "小游戏挂载");
  await run(`${card("games")}.querySelector('[aria-label="向左移动"]').click()`);
  await wait(`${card("games")}.querySelector('.game-status').textContent.includes('4')`, "2048 合并计分");
  await run(`${card("games")}.querySelectorAll('.game-tabs button')[1].click();${card("games")}.querySelectorAll('.game-mines button')[40].click()`);
  assert.ok(await run(`${card("games")}.querySelectorAll('.game-mines button').length===81`));
  await run(`${card("games")}.querySelectorAll('.game-tabs button')[2].click();${card("games")}.querySelector('.sol-top button').click()`);
  await pause(600);
  const saved = await backend.stateStore.get();
  assert.ok(Object.keys(saved.entries).some(key => key.includes("solitaire")), "接龙进度未通过 MCP 存档");
  const solitaireKey = Object.keys(saved.entries).find(key => key.includes("solitaire"));
  const beforeConfirmation = saved.entries[solitaireKey];
  await run(`${card("games")}.querySelector('.game-actions button').click()`);
  await wait(`!!${doc}.querySelector('.confirmation-dialog[open]')`, "插件内确认对话框");
  await run(`${doc}.querySelector('.cancel-confirmation').click()`);
  await pause(350);
  assert.equal((await backend.stateStore.get()).entries[solitaireKey], beforeConfirmation, "取消新一局不得改变存档");
  await run(`${card("games")}.querySelector('.game-actions button').click()`);
  await wait(`!!${doc}.querySelector('.confirmation-dialog[open]')`, "再次打开确认对话框");
  await run(`${doc}.querySelector('.accept-confirmation').click()`);
  await pause(600);
  assert.notEqual((await backend.stateStore.get()).entries[solitaireKey], beforeConfirmation, "确认新一局应持久化新状态");
  results.push({ name: "games", savedKeys: Object.keys(saved.entries).length });

  await run(`${doc}.querySelector('.settings-button').click()`);
  await run(`${doc}.querySelector('.settings-row[data-card="proxy"] input').click()`);
  await wait(`!${doc}.querySelector('#tab-proxy') && !${doc}.querySelector('.settings-row[data-card="proxy"] input').disabled`, "保存卡片开关");
  await run(`${doc}.querySelector('.settings-row[data-card="proxy"] input').click()`);
  await wait(`!!${doc}.querySelector('#tab-proxy') && !${doc}.querySelector('.settings-row[data-card="emby"] [data-action="up"]').disabled`, "重新启用卡片");
  const orderBefore = (await configStore.loadV2()).order;
  await run(`${doc}.querySelector('.settings-row[data-card="emby"] [data-action="up"]').click()`);
  await wait(`!${doc}.querySelector('.settings-row[data-card="emby"] [data-action="up"]').disabled`, "保存卡片排序");
  const orderAfter = (await configStore.loadV2()).order;
  assert.notDeepEqual(orderAfter, orderBefore);
  await wait(`!${doc}.querySelector('.launcher-status').textContent.includes('读取')`, "读取启动偏好");
  await run(`${doc}.querySelector('.launcher-enabled').checked=true;${doc}.querySelector('.launcher-port').value='17890';${doc}.querySelector('.save-launcher').click()`);
  await wait(`${doc}.querySelector('.launcher-status').textContent.includes('已保存')`, "仅保存启动偏好");
  assert.deepEqual((await launcher.readPreferences()).preferences, { launchThroughProxy: true, proxyPort: 17890 });
  await run(`${doc}.querySelector('.exit-codex').click()`);
  await wait(`!!${doc}.querySelector('.confirmation-dialog[open]')`, "退出 Codex 的插件内确认");
  await screenshot("confirm-exit-codex");
  await run(`${doc}.querySelector('.cancel-confirmation').click()`);
  assert.equal(launcherSpawns, 0);
  assert.equal(launcher.pending, false);
  await run(`${doc}.querySelector('.done-settings').click()`);
  results.push({ name: "settings", orderAfter, launcherSaved: true, launcherExitCancelled: true });

  await clickTab("emby");
  await wait(`!!${card("emby")}.querySelector('.emby-poster-button[title="直放测试"]')`, "Emby 媒体库");
  for (const title of ["直放测试", "HLS 测试", "重封装测试"]) {
    await run(`${card("emby")}.querySelector(${JSON.stringify(`.emby-poster-button[title="${title}"]`)}).click()`);
    await wait(`!!${card("emby")}.querySelector('video.emby-video')`, `${title} 真实播放器`);
    await run(`${card("emby")}.querySelector('video.emby-video').muted=true`);
    await wait(`${card("emby")}.querySelector('video.emby-video').currentTime>.35`, `${title} 视频解码与播放`, 25_000);
    const first = await run(`({time:${card("emby")}.querySelector('video').currentTime,width:${card("emby")}.querySelector('video').videoWidth,height:${card("emby")}.querySelector('video').videoHeight})`);
    assert.equal(first.width, 320);
    await run(`${card("emby")}.querySelector('video').currentTime=3`);
    await wait(`${card("emby")}.querySelector('video').currentTime>3.15`, `${title} seek后续播`);
    await run(`${card("emby")}.querySelector('.emby-subtitle-button').click();[...${card("emby")}.querySelectorAll('.emby-subtitle-option')].find(e=>e.textContent.includes('中文测试字幕')).click()`);
    await wait(`${card("emby")}.querySelector('video').textTracks.length>0`, `${title} VTT字幕`);
    const hover = await run(`(()=>{const bounds=${card("emby")}.querySelector('.emby-playback-chrome').getBoundingClientRect();return {x:bounds.left+bounds.width/2,y:bounds.top+bounds.height/2}})()`);
    await connection.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...hover });
    await wait(`getComputedStyle(${card("emby")}.querySelector('.emby-playback-chrome')).opacity==='1'`, `${title} hover 显示播放控制`);
    const chromeStyle = await run(`(()=>{const root=${card("emby")};const get=s=>{const e=root.querySelector(s),c=getComputedStyle(e);return {color:c.color,opacity:c.opacity,display:c.display,hidden:e.hidden}};return {chrome:get('.emby-playback-chrome'),title:get('.emby-playback-title'),back:get('.emby-playback-back'),episodes:get('.emby-playback-episode-nav')}})()`);
    assert.equal(chromeStyle.chrome.color, "rgb(255, 255, 255)");
    assert.notEqual(chromeStyle.title.display, "none", "标题应显示在视频下方的信息区");
    assert.equal(chromeStyle.back.color, "rgb(255, 255, 255)");
    assert.equal(chromeStyle.episodes.hidden, true);
    assert.equal(chromeStyle.episodes.display, "none", "电影不应显示剧集导航");
    await screenshot(`playback-${title === "直放测试" ? "direct" : title === "HLS 测试" ? "hls" : "ffmpeg"}`);
    await clickTab("games");
    await wait(`${card("emby")}.querySelector('video')?.paused===true`, "隐藏Emby暂停");
    await clickTab("emby");
    await run(`${card("emby")}.querySelector('.emby-playback-back').click()`);
    await wait(`!!${card("emby")}.querySelector('.emby-poster-button[title="直放测试"]')`, "返回媒体库");
    const deadline = Date.now() + 5000;
    while (media.service.playbacks.size && Date.now() < deadline) await pause(50);
    assert.equal(media.service.playbacks.size, 0, "返回后媒体会话未停止");
    results.push({ name: title, ...first, chromeStyle });
  }
  await clickTab("hongguo");
  await wait(`${card("hongguo")}.textContent.includes('插件测试短剧')`, "红果推荐内容");
  await run(`${card("hongguo")}.querySelector('.hg-feature').click()`);
  await wait(`${card("hongguo")}.querySelectorAll('.hg-episode').length===3`, "红果选集");
  await run(`${card("hongguo")}.querySelector('.hg-episode').click()`);
  await wait(`!!${card("hongguo")}.querySelector('video')`, "红果真实播放器");
  await run(`${card("hongguo")}.querySelector('video').muted=true`);
  await wait(`${card("hongguo")}.querySelector('video').currentTime>.35`, "红果 MSE 解码播放", 25_000);
  await run(`${card("hongguo")}.querySelector('video').currentTime=3`);
  await wait(`${card("hongguo")}.querySelector('video').currentTime>3.15`, "红果 seek 后续播");
  await clickTab("games");
  await wait(`${card("hongguo")}.querySelector('video').paused`, "隐藏红果暂停");
  await clickTab("hongguo");
  await run(`${card("hongguo")}.querySelector('.hg-playback-back').click()`);
  await wait(`${card("hongguo")}.querySelectorAll('.hg-episode').length===3`, "红果返回选集");
  await run(`${card("hongguo")}.querySelector('[aria-label="返回"]').click()`);
  await wait(`!!${card("hongguo")}.querySelector('.hg-list-remove')`, "红果片单收藏");
  await run(`${card("hongguo")}.querySelector('.hg-list-remove').click()`);
  await wait(`!${card("hongguo")}.querySelector('.hg-list-remove')`, "红果片单移除");
  assert.equal(list.length, 0);
  results.push({ name: "hongguo", playback: true, seek: true, collection: true });
  assert.equal(media.proxyStarts, 0);
  assert.ok(packets.every(packet => packet.bytes < 256 * 1024), "MCP 消息超过 256 KiB");
  assert.deepEqual(await run("fixture.errors"), []);
  assert.deepEqual(await run("fixture.frame.contentWindow.__smokeErrors"), []);
  assert.deepEqual(await run("fixture.frame.contentWindow.__smokeCsp"), [], "插件触发了被 CSP 拒绝的资源请求");
  assert.equal(browserRequests.some(request => request.includes(`/Videos/`) || request.includes("fixture.invalid")), false, "插件页面直接请求了媒体上游");
  await run("fixture.teardown()");
  assert.equal(media.service.playbacks.size, 0);
  assert.equal(backend.transfers.bytes, 0);
  const report = { passed: true, sdk: "official AppBridge + MCP SDK Client", desktopVerified: false, strictCsp: true, results, toolCalls: packets.length,
    maxToolResponseBytes: Math.max(...packets.map(packet => packet.bytes)), expectedLifecycleErrors: [...new Set(errors)], screenshots: evidence };
  await writeFile(join(evidence, "browser.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} finally {
  connection?.close();
  chrome?.kill("SIGTERM");
  host?.closeAllConnections();
  if (host) await new Promise(resolve => host.close(resolve));
  await client?.close();
  await mcpServer?.close();
  await backend?.dispose();
  await media?.close();
  if (chrome && chrome.exitCode === null && chrome.signalCode === null) await Promise.race([new Promise(resolve => chrome.once("exit", resolve)), pause(1500)]);
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
