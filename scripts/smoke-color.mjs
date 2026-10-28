// 实际 Emby 片源 → 后台 RPC → 注入的播放器 → Chromium 解码/seek/关闭。
// 测试使用独立浏览器，禁止上报观看进度。用 Bun 运行可验证发布运行时。
// node scripts/smoke-color.mjs <itemId> <sourceOrdinal>
// 可追加字幕索引；CODEX_COMPANION_SUBTITLE_WINDOW_ONLY=1 模拟完整字幕端点阻塞，验证真实媒体分段路径。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EmbyService, mapEmbyItem, mapMediaSourceOptions, mapSubtitleStreams } from "../src/emby-service.mjs";
import { EmbyClient } from "../src/emby-client.mjs";
import { EmbyStorage } from "../src/emby-storage.mjs";
import { CdpConnection } from "../src/cdp-connection.mjs";
import { CdpRpcBridge } from "../src/rpc-bridge.mjs";
import { buildInjectionSource } from "../src/injection.mjs";
import { reserveLoopbackPort } from "../src/launcher.mjs";
import { listCdpTargets } from "../src/targets.mjs";
import { extractSubtitleWindow } from "../src/subtitle-loader.mjs";

const [itemId, ordinalArg = "0", subtitleIndexArg] = process.argv.slice(2);
if (subtitleIndexArg !== undefined && !/^\d+$/.test(subtitleIndexArg)) throw new Error("字幕索引必须是非负整数");
if (!itemId || !/^\d+$/.test(ordinalArg)) throw new Error("用法：node scripts/smoke-color.mjs <itemId> <sourceOrdinal>");
const storage = new EmbyStorage();
const config = await storage.loadConfig();
const token = await storage.readToken(config.serverId, config.userId);
const client = new EmbyClient({ ...config, token });
const item = await client.request(`Users/${encodeURIComponent(config.userId)}/Items/${encodeURIComponent(itemId)}`);
const info = await client.getPlaybackInfo(itemId, config.userId);
client.close();
const sourceOptions = mapMediaSourceOptions(info.MediaSources);
assert.ok(sourceOptions[Number(ordinalArg)], "不存在指定片源");
const subtitleExtractions = [];
const service = new EmbyService({
  storage,
  subtitleWindowImpl: async (options) => {
    const started = Date.now();
    const result = await extractSubtitleWindow(options);
    subtitleExtractions.push({ window: result.window, ms: Date.now() - started, index: options.index, cues: (result.data.match(/ --> /g) ?? []).length });
    return result;
  },
  clientFactory: (options) => {
    const client = new EmbyClient(options);
    client.reportPlaybackStarted = client.reportPlaybackProgress = client.reportPlaybackStopped = async () => ({});
    if (process.env.CODEX_COMPANION_SUBTITLE_WINDOW_ONLY === "1") {
      const loadResource = client.loadResource.bind(client);
      client.loadResource = (url, options) => options?.resourceType === "subtitle"
        ? new Promise((_resolve, reject) => {
          if (options.signal.aborted) reject(options.signal.reason);
          else options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
        }) : loadResource(url, options);
    }
    return client;
  }
});
const subtitleResponses = [];
const originalLoadSubtitle = service.loadSubtitle.bind(service);
service.loadSubtitle = async (...args) => {
  const start = Date.now();
  const result = await originalLoadSubtitle(...args);
  subtitleResponses.push({ index: result.subtitleStreamIndex, window: result.window ?? null, ms: Date.now() - start });
  return result;
};
const profile = await mkdtemp(join(tmpdir(), "companion-color-browser-"));
const port = await reserveLoopbackPort();
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
  "--headless=new", "--mute-audio", "--autoplay-policy=no-user-gesture-required", "--no-first-run",
  "--no-default-browser-check", "--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, "--window-size=900,760", "about:blank"
], { stdio: "ignore" });
let connection;
let bridge;
try {
  const deadline = Date.now() + 15_000;
  let target;
  while (!target && Date.now() < deadline) {
    target = await listCdpTargets(port).then((targets) => targets.find((target) => target.type === "page")).catch(() => null);
    if (!target) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(target, "浏览器未启动");
  connection = new CdpConnection(target.webSocketDebuggerUrl);
  await connection.connect();
  bridge = new CdpRpcBridge(connection, { handler: service, targetId: "color-smoke" });
  await bridge.attach();
  const read = async (expression) => {
    const result = await connection.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  const waitFor = async (expression, timeout = 60_000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await read(expression)) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const diagnostics = await read(`(() => { const root=document.getElementById('codex-companion-root-shell')?.shadowRoot?.querySelector('#codex-companion-root')?.shadowRoot;const v=root?.querySelector('video');return {status:root?.querySelector('.emby-subtitle-status')?.textContent,subtitle:root?.querySelector('.emby-subtitle-button')?.title,tracks:[...(v?.textTracks??[])].map(t=>({mode:t.mode,cues:t.cues?.length})),elements:[...(v?.querySelectorAll('track')??[])].map(t=>({ready:t.readyState})),time:v?.currentTime}})()`);
    throw new Error(`等待失败：${expression}; ${JSON.stringify({ diagnostics, subtitleExtractions })}`);
  };
  const root = "document.getElementById('codex-companion-root-shell').shadowRoot";
  const app = `${root}.querySelector('#codex-companion-root').shadowRoot`;
  await read(buildInjectionSource("mount", { placement: "standalone-button", cards: { hongguo: false, emby: true } }));
  await waitFor("window.__CODEX_COMPANION__.emby.getState().view === 'home'");
  await read(`${root}.querySelector('button').click()`);
  const mapped = { ...mapEmbyItem(item, client), positionTicks: 900_000_000 };
  await read(`window.__CODEX_COMPANION__.emby.dispatch('showSeries', ${JSON.stringify({ series: { id: item.SeriesId ?? "color-smoke", name: item.SeriesName ?? item.Name }, episodes: [mapped], sourceOptions })})`);
  await read(`${app}.querySelectorAll('.emby-source-chip')[${Number(ordinalArg)}]?.click()`);
  await read(`${app}.querySelector('.emby-episode-button').click()`);
  await waitFor(`${app}.querySelector('video')?.currentTime > 92`);
  const playing = await read(`(() => {const v=${app}.querySelector('video');return {width:v.videoWidth,height:v.videoHeight,time:v.currentTime,error:v.error?.message??null,quality:${app}.querySelector('.emby-playback-quality')?.textContent}})()`);
  assert.ok(playing.width > 0);
  assert.equal(playing.error, null);
  assert.match(playing.quality, /→ SDR/);
  let subtitles = null;
  if (subtitleIndexArg !== undefined) {
    await read(`${app}.querySelector('.emby-subtitle-option[data-subtitle-index="${subtitleIndexArg}"]').click()`);
    const subtitleLabel = mapSubtitleStreams(info.MediaSources[Number(ordinalArg)]).find(s => s.index === Number(subtitleIndexArg)).label;
    await waitFor(`[...${app}.querySelector('video').textTracks].some(t => t.mode === 'showing' && t.label === ${JSON.stringify(subtitleLabel)} && t.cues?.length > 0)`);
    subtitles = await read(`(() => {const t=[...${app}.querySelector('video').textTracks].find(t=>t.mode==='showing');return {cues:t.cues.length,firstStart:t.cues[0].startTime}})()`);
    const response = subtitleResponses.findLast(r => r.index === Number(subtitleIndexArg));
    if (response.window) assert.ok(subtitles.firstStart >= response.window.from - 30, "窗口字幕必须使用绝对播放时间，而非从零开始");
  }
  await read(`${app}.querySelector('video').currentTime = 120`);
  await waitFor(`${app}.querySelector('video')?.currentTime > 122`);
  const afterSeek = await read(`${app}.querySelector('video').currentTime`);
  if (subtitles) {
    await waitFor(`[...${app}.querySelector('video').textTracks].some(t => t.mode === 'showing' && [...(t.cues??[])].some(c=>c.startTime>150))`);
    const before = subtitleExtractions.length;
    await read(`${app}.querySelector('video').currentTime = 91`);
    await waitFor(`${app}.querySelector('video').currentTime > 93`);
    assert.equal(subtitleExtractions.length, before, "跳回已缓存字幕窗口不应再次提取");
    subtitles.extractions = subtitleExtractions;
    subtitles.responses = subtitleResponses;
    const cueTime = await read(`(() => { const v=${app}.querySelector('video'),t=[...v.textTracks].find(t=>t.mode==='showing');const cue=[...t.cues].find(c=>c.startTime>v.currentTime && c.startTime<v.currentTime+30);return cue?cue.startTime+0.3:null; })()`);
    assert.ok(cueTime !== null, "该验证片段应包含后续对白");
    await read(`${app}.querySelector('video').currentTime = ${cueTime}`);
    await waitFor(`[...${app}.querySelector('video').textTracks].some(t=>t.mode==='showing' && t.activeCues?.length>0)`);
    subtitles.activeCueCount = await read(`[...${app}.querySelector('video').textTracks].find(t=>t.mode==='showing').activeCues.length`);
  }
  const screenshot = await connection.send("Page.captureScreenshot", { format: "png" });
  const output = `/tmp/companion-color-browser-${ordinalArg}.png`;
  await writeFile(output, Buffer.from(screenshot.data, "base64"), { mode: 0o600 });
  const beforeHide = await read(`${app}.querySelector('video').currentTime`);
  await read(`window.__backgroundVideo = ${app}.querySelector('video'); ${root}.querySelector('button').click()`);
  await waitFor(`${root}.querySelector('.drawer').hidden`);
  await waitFor(`window.__backgroundVideo.currentTime > ${beforeHide + 3}`);
  const background = await read(`({time:__backgroundVideo.currentTime,paused:__backgroundVideo.paused,muted:__backgroundVideo.muted,volume:__backgroundVideo.volume,playing:__CODEX_COMPANION__.emby.getState().playing})`);
  assert.equal(background.playing,true); assert.equal(background.paused,false); assert.equal(background.muted,false); assert.ok(background.volume>0);
  assert.equal(service.playbacks.size,1);
  await read(`${root}.querySelector('button').click()`);
  await waitFor(`__CODEX_COMPANION__.isPlaced()`);
  assert.equal(await read(`${app}.querySelector('video') === __backgroundVideo`),true);
  await read(`${app}.querySelector('.emby-playback-back').click()`);
  await waitFor("!window.__CODEX_COMPANION__.emby.getState().playing");
  const cleanupDeadline = Date.now() + 5000;
  while (service.playbacks.size && Date.now() < cleanupDeadline) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(service.playbacks.size, 0);
  console.log(JSON.stringify({ playing, afterSeek, subtitles, background, closed: true, output }));
} finally {
  bridge?.detach();
  connection?.close();
  await service.dispose();
  chrome.kill("SIGTERM");
  await new Promise((resolve) => { chrome.once("exit", resolve); setTimeout(resolve, 2000).unref(); });
  await rm(profile, { recursive: true, force: true });
}
