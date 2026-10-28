import { mount as mountEmby } from "/emby.js";
import { mount as mountHongguo } from "/hongguo.js";
import { createEffects } from "/effects.js";

const errors = [];
window.addEventListener("error", (event) => errors.push(event.message));
window.addEventListener("unhandledrejection", (event) => errors.push(String(event.reason)));
const calls = [];
const checks = [];
const assert = (value, label) => { if (!value) throw new Error(label); checks.push(label); };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const wait = async (predicate, label) => {
  const until = Date.now() + 10000;
  while (Date.now() < until) { if (predicate()) return; await delay(30); }
  throw new Error(`等待超时：${label}`);
};
const movie = { id: "movie", name: "媒体夹具", type: "Movie" };
const drama = { id: "123", name: "短剧夹具", totalEpisodes: 2 };
const fixture = await fetch("/fixture.json").then((response) => response.json());
let mode = "hls";
let id = 0;
const requested = new Map();
const base = location.origin;
async function handle(method, params) {
  if (method === "emby.connection.status") return { connected: true, baseUrl: "https://fixture.invalid", username: "fixture" };
  if (method === "emby.servers.list") return { servers: [{ key: "fixture", name: "夹具" }] };
  if (method === "emby.home.get") return { views: [], resume: [], latest: [movie] };
  if (method === "emby.search") return { items: [movie] };
  if (method === "emby.playback.open") return { playbackId: "emby-play", itemId: params.itemId, streamMode: mode.startsWith("native") ? "direct-mp4" : mode, directMediaUrl: mode.startsWith("native") ? `https://codex-companion.invalid/${location.port}/hls/11111111-1111-4111-8111-111111111111/${mode === "native" ? "clip.mp4" : "missing.mp4"}` : undefined, hlsUrl: `${base}/stream.m3u8`, subtitles: [{ index: 0, language: "chi", label: "中文", isExternal: true }], selectedSubtitleIndex: 0, subtitleMode: "external-vtt", initialBufferSeconds: 0.5 };
  if (method === "emby.playback.subtitle.load") return { data: "WEBVTT\n\n00:00:00.000 --> 00:00:10.000\n字幕夹具\n" };
  if (method === "emby.playback.subtitle.select") return { selectedSubtitleIndex: params.subtitleStreamIndex, subtitleMode: params.subtitleStreamIndex === null ? "off" : "external-vtt" };
  if (method === "emby.resource.load") {
    const response = await fetch(params.url);
    if (params.responseType === "text") return { data: await response.text(), url: params.url };
    return { data: await response.arrayBuffer(), url: params.url };
  }
  if (method === "hongguo.home") return { items: [drama], hasMore: false };
  if (method === "hongguo.list.get") return { items: [] };
  if (method === "hongguo.list.add") return { items: [drama] };
  if (method === "hongguo.detail") return { ...drama, accessibleEpisodeCount: 2, fullEpisodeCount: 2 };
  if (method === "hongguo.playback.open") return { playbackId: "hg-play", episode: params.episode, streamMode: "direct-mp4" };
  if (method.endsWith("playback.direct.init")) return { tracks: [{ id: 1, mime: 'video/mp4; codecs="avc1.42c01e"', codec: "avc1.42c01e", initData: fixture.init }], durationSeconds: 8, keyframeTimesSeconds: [0, 1, 2, 3, 4, 5, 6, 7], keyframeIntervalSeconds: 1 };
  if (method.endsWith("playback.direct.next")) return { segments: [{ trackId: 1, data: fixture.media }], end: true };
  if (method.endsWith("playback.direct.seek")) return { timestampOffsetSeconds: 0 };
  if (method.endsWith("playback.progress") || method.endsWith("playback.stop")) return {};
  throw new Error(`未实现夹具方法 ${method}`);
}
function context(card) {
  const controller = new AbortController();
  const effects = createEffects({ signal: controller.signal, onError: (error) => errors.push(error.message) });
  const host = document.createElement("div");
  host.style.cssText = "width:360px;height:520px;margin:8px;display:inline-block;vertical-align:top";
  document.body.append(host);
  const root = host.attachShadow({ mode: "open" });
  const rpc = (method, params, options) => rpc.request(method, params, options).promise;
  rpc.request = (method, params = {}, options = {}) => {
    const fullMethod = method.startsWith(`${card}.`) ? method : `${card}.${method}`;
    calls.push({ method: fullMethod, params });
    const requestId = String(++id);
    let cancel;
    const promise = new Promise((resolve, reject) => {
      const abort = () => reject(Object.assign(new Error("aborted"), { code: "ABORTED" }));
      cancel = abort;
      options.signal?.addEventListener("abort", abort, { once: true });
      Promise.resolve().then(() => handle(fullMethod, params)).then(resolve, reject).finally(() => options.signal?.removeEventListener("abort", abort));
    });
    requested.set(requestId, cancel);
    promise.then(() => requested.delete(requestId), () => requested.delete(requestId));
    return { id: requestId, promise, cancel };
  };
  rpc.cancel = (requestId) => requested.get(requestId)?.();
  return { root, signal: controller.signal, effects, rpc, settings: {}, reportError: (error) => errors.push(error.message), isVisible: () => !host.hidden, requestOpen: () => { host.hidden = false; }, controller, host };
}

async function run() {
  const embyContext = context("emby");
  const hgContext = context("hongguo");
  const emby = mountEmby(embyContext);
  const hg = mountHongguo(hgContext);
  await wait(() => emby.api.getState().view === "home" && hg.api.getState().view === "home", "首页");
  assert(emby.api.getState().latestCount === 1, "Emby 首页数据通过平台 RPC 加载");
  assert(hg.api.getState().featuredCount === 1, "红果首页数据通过平台 RPC 加载");
  assert(getComputedStyle(embyContext.root.querySelector(".panel")).boxShadow === "none", "外框阴影由平台独占");

  emby.api.dispatch("showSearch", { query: "媒体", items: [] });
  embyContext.root.querySelector(".emby-search-wrap").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await wait(() => emby.api.getState().searchCount === 1, "搜索结果");
  assert(calls.some((call) => call.method === "emby.search"), "Emby 搜索走平台 RPC");
  embyContext.root.querySelector(".emby-list-button").click();
  await wait(() => embyContext.root.querySelector("video")?.readyState >= 2, "HLS 首帧");
  const video = embyContext.root.querySelector("video");
  video.pause();
  await wait(() => video.querySelector("track")?.track?.cues?.length > 0, "字幕");
  assert(video.readyState >= 2 && emby.api.getState().playing, "Emby 本地 hls.js 实际解码 RPC 媒体");
  assert(video.querySelector("track").track.cues[0].text === "字幕夹具", "外挂 VTT 字幕保持可用");
  const time = video.currentTime;
  const stopCount = calls.filter((call) => call.method.endsWith("playback.stop")).length;
  embyContext.host.hidden = true;
  emby.visibilityChanged({ visible: false, reason: "inline-collapse" });
  await delay(80);
  embyContext.host.hidden = false;
  emby.visibilityChanged({ visible: true });
  assert(embyContext.root.querySelector("video") === video && video.currentTime === time, "Emby inline 隐藏重开保留视频身份和进度");
  assert(calls.filter((call) => call.method.endsWith("playback.stop")).length === stopCount, "Emby 隐藏不发送停止请求");

  await hg.api.openById("123");
  assert(hg.api.getState().selectedDramaId === "123", "红果 ID 直达和详情 API");
  await hg.api.playEpisode(1);
  await wait(() => hgContext.root.querySelector("video")?.readyState >= 2, "红果 MSE 首帧");
  const hgVideo = hgContext.root.querySelector("video");
  hgVideo.pause();
  assert(hg.api.getState().diagnostics.streamMode === "direct-mp4", "红果 MSE 播放保留原管线");
  hgContext.host.hidden = true;
  hg.visibilityChanged({ visible: false, reason: "inline-collapse" });
  await delay(80);
  hgContext.host.hidden = false;
  hg.visibilityChanged({ visible: true });
  assert(hgContext.root.querySelector("video") === hgVideo && hg.api.getState().playing, "红果 inline 隐藏重开保留播放实例");
  hgVideo.dispatchEvent(new Event("ended"));
  assert(!hgContext.root.querySelector(".hg-autoplay").hidden, "红果自动下一集菜单仍可用");
  hgContext.root.querySelector(".hg-autoplay .primary").click();
  await wait(() => calls.some((call) => call.method === "hongguo.playback.open" && call.params.episode === 2), "红果下一集");
  assert(calls.some((call) => call.method === "hongguo.playback.open" && call.params.episode === 2), "红果连播发起下一集");

  emby.api.dispatch("back");
  mode = "direct-mp4";
  emby.api.dispatch("showSearch", { query: "媒体", items: [movie] });
  embyContext.root.querySelector(".emby-list-button").click();
  await wait(() => embyContext.root.querySelector("video")?.readyState >= 2, "Emby MSE 首帧");
  assert(calls.some((call) => call.method === "emby.playback.direct.init"), "Emby MSE 播放保留原管线");
  const secondContext = context("emby");
  const second = mountEmby(secondContext);
  await wait(() => second.api.getState().view === "home", "第二个 Emby");
  assert(second.api.getState().playing === false && emby.api.getState().playing, "同一卡片两个实例状态独立");

  embyContext.root.querySelector("video").dispatchEvent(new Event("error"));
  assert(emby.api.getState().view === "error" && emby.api.getState().mseDiagnostics !== null, "Emby MSE 失败保留诊断并显示重试界面");
  await wait(() => hgContext.root.querySelector("video")?.readyState >= 2, "红果第二集首帧");
  hgContext.root.querySelector("video").dispatchEvent(new Event("error"));
  assert(hg.api.getState().view === "error", "红果 MSE 失败不依赖 Emby 状态");

  mode = "ffmpeg-fmp4";
  emby.api.dispatch("showSearch", { query: "媒体", items: [movie] });
  embyContext.root.querySelector(".emby-list-button").click();
  await wait(() => embyContext.root.querySelector("video")?.readyState >= 2, "FFmpeg fMP4 首帧");
  assert(emby.api.getState().playing, "FFmpeg fMP4 模式仍走完整 MSE 管线");
  emby.api.dispatch("back");
  mode = "native";
  emby.api.dispatch("showSearch", { query: "媒体", items: [movie] });
  embyContext.root.querySelector(".emby-list-button").click();
  await wait(() => embyContext.root.querySelector("video")?.readyState >= 2, "CDP 拦截原生直放首帧");
  const nativeVideo = embyContext.root.querySelector("video");
  assert(nativeVideo.currentSrc.startsWith("https://codex-companion.invalid/"), "原生直放不经 MSE/RPC");
  emby.visibilityChanged({ visible: false, reason: "inline-collapse" });
  emby.visibilityChanged({ visible: true });
  assert(embyContext.root.querySelector("video") === nativeVideo, "原生直放隐藏后保留同一视频元素");
  emby.api.dispatch("back");
  mode = "native-missing";
  emby.api.dispatch("showSearch", { query: "媒体", items: [movie] });
  embyContext.root.querySelector(".emby-list-button").click();
  await wait(() => embyContext.root.querySelector("video")?.currentSrc.startsWith("blob:") && embyContext.root.querySelector("video").readyState >= 2, "原生加载失败回退 MSE");

  embyContext.controller.abort();
  hgContext.controller.abort();
  secondContext.controller.abort();
  await Promise.all([emby.dispose(), hg.dispose(), second.dispose()]);
  assert(embyContext.root.childNodes.length === 0 && hgContext.root.childNodes.length === 0, "卸载移除业务 DOM");
  assert(embyContext.effects.diagnostics().active === 0 && hgContext.effects.diagnostics().active === 0, "卸载回收平台副作用");
  const afterDispose = calls.length;
  hg.api.setVideoSource(`${base}/clip.mp4`);
  emby.api.dispatch("previewPlayback");
  await delay(100);
  assert(calls.length === afterDispose && hgContext.root.childNodes.length === 0, "旧 API 不复活已卸载实例");
  assert(errors.length === 0, `没有未隔离异常：${errors.join(", ")}`);
  return { checks, rpcCalls: calls.length, errors };
}
globalThis.__mediaResult = run().then((result) => ({ ok: true, ...result }), (error) => ({ ok: false, error: error.stack, calls: calls.slice(-12), errors, checks }));
