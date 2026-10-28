import assert from "node:assert/strict";
import test from "node:test";
import { EmbyError } from "../src/emby-client.mjs";
import { embyServerKey } from "../src/emby-storage.mjs";
import { resolveMediaInterceptUrl } from "../src/media-intercept.mjs";
import {
  EmbyService,
  computeSourceKey,
  defaultSubtitleIndex,
  mapEmbyItem,
  mapMediaSourceOption,
  mapMediaSourceOptions,
  mapSubtitleStreams,
  mediaSourceSupportsRendererFmp4,
  pickMediaSource,
  secondsToTicks
} from "../src/emby-service.mjs";

// 遥测超时计时器在生产中 unref，避免拖住进程退出；部分用例的假客户端永不完成，
// 若宿主上恰好没有其它活动句柄，事件循环会在超时触发前结束。这里显式保活。
const keepAlive = setInterval(() => {}, 60_000);
test.after(() => clearInterval(keepAlive));

class FakeStorage {
  constructor(config = null, token = null, homeCache = null) {
    this.config = config;
    this.token = token;
    this.homeCache = homeCache;
    this.savedTokens = [];
    this.deletedTokens = [];
    this.savedHomeCaches = [];
  }

  async loadConfig() { return this.config; }
  async saveConfig(config) { this.config = { ...config }; return this.config; }
  createDeviceId(config) { return config?.deviceId ?? "stable-device"; }
  async readToken() { return this.token; }
  async saveToken(serverId, userId, token) {
    this.savedTokens.push({ serverId, userId, token });
    this.token = token;
  }
  async deleteToken(serverId, userId) {
    this.deletedTokens.push({ serverId, userId });
    this.token = null;
    return true;
  }
  async loadHomeCache() { return this.homeCache; }
  async saveHomeCache(serverId, userId, snapshot) {
    this.savedHomeCaches.push({ serverId, userId, snapshot });
    this.homeCache = snapshot;
  }
  async clearHomeCache() {
    this.homeCacheCleared = (this.homeCacheCleared ?? 0) + 1;
    this.homeCache = null;
  }
}

function makeClient(settings, calls) {
  return {
    settings,
    baseUrl: settings.baseUrl,
    async authenticate(username, password, { signal } = {}) {
      calls.push({ method: "authenticate", username, password, signal });
      return { ServerId: "server", AccessToken: "token", User: { Id: "user", Name: username } };
    },
    imageUrl(id, options) { return `${settings.baseUrl}/Items/${id}/Images/${options.type}`; },
    async getViews() { return { Items: [{ Id: "view", Name: "影视", Type: "CollectionFolder" }] }; },
    async getResume() {
      return { Items: [{
        Id: "episode",
        Name: "第二集",
        Type: "Episode",
        SeriesId: "series",
        SeriesName: "示例剧集",
        SeasonId: "season",
        IndexNumber: 2,
        ParentIndexNumber: 1,
        RunTimeTicks: 1_000,
        ImageTags: { Primary: "tag" },
        UserData: { PlaybackPositionTicks: 250 }
      }] };
    },
    async getLatest() { return [{ Id: "movie", Name: "电影", Type: "Movie", ProductionYear: 2026 }]; },
    async getLibraryItems(_userId, parentId, options) {
      calls.push({ method: "library", parentId, options });
      return {
        TotalRecordCount: 2,
        Items: [
          { Id: "nested", Name: "动画电影", Type: "Folder", ChildCount: 8 },
          { Id: "library-movie", Name: "电影 A", Type: "Movie", ProductionYear: 2025 }
        ]
      };
    },
    async search(_userId, query) {
      calls.push({ method: "search", query });
      return { Items: [{ Id: "series", Name: "剧集", Type: "Series" }] };
    },
    async getSeasons() { return { Items: [{ Id: "season", Name: "第一季", Type: "Season", IndexNumber: 1 }] }; },
    async getEpisodes() { return { Items: [{ Id: "episode", Name: "第一集", Type: "Episode", IndexNumber: 1 }] }; },
    async getPlaybackInfo(itemId, userId, options) {
      calls.push({ method: "playbackInfo", itemId, userId, options });
      return { PlaySessionId: "play-session", MediaSources: [{ Id: "media-source", SupportsTranscoding: true }] };
    },
    hlsUrl(itemId, session) {
      const url = new URL(
        `${settings.baseUrl}/Videos/${itemId}/master.m3u8?MediaSourceId=${encodeURIComponent(session?.mediaSourceId ?? "media-source")}`
      );
      if (session?.subtitleMode === "burn-in") {
        url.searchParams.set("SubtitleStreamIndex", session.subtitleStreamIndex);
        url.searchParams.set("SubtitleMethod", "Encode");
      }
      return url.href;
    },
    subtitleUrl(itemId, mediaSourceId, index, options) {
      return `${settings.baseUrl}/Videos/${itemId}/${mediaSourceId}/Subtitles/${index}/Stream.${options.format}`;
    },
    async reportPlaybackStarted(session) { calls.push({ method: "started", session: { ...session } }); },
    async reportPlaybackProgress(session) { calls.push({ method: "progress", session: { ...session } }); },
    async reportPlaybackStopped(session) { calls.push({ method: "stopped", session: { ...session } }); },
    async stopActiveEncoding(playSessionId) { calls.push({ method: "stopEncoding", playSessionId }); },
    async loadResource(url, options) {
      calls.push({ method: "resource", url, options });
      if (String(url).includes("/Subtitles/")) {
        const text = String(url).includes("Stream.vtt")
          ? "WEBVTT\n\n00:00.000 --> 00:01.000\n字幕"
          : `[Script Info]
ScriptType: v4.00+

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,ASS 字幕`;
        return options.responseType === "text"
          ? { text, contentType: "text/vtt", url }
          : { bytes: new TextEncoder().encode(text), contentType: "text/vtt", url };
      }
      return options.responseType === "text"
        ? {
            text: "#EXTM3U",
            contentType: "application/vnd.apple.mpegurl",
            url
          }
        : { bytes: Uint8Array.of(1, 2, 3), contentType: "image/jpeg", url };
    }
  };
}

test("字幕流映射把文字字幕统一交给 WebVTT，并仅烧录图形字幕", () => {
  const source = {
    DefaultSubtitleStreamIndex: 3,
    MediaStreams: [
      { Type: "Video", Index: 0, Codec: "h264" },
      {
        Type: "Subtitle", Index: 2, Codec: "subrip", Language: "chi",
        DisplayTitle: "中文 SRT", IsTextSubtitleStream: true, IsExternal: true
      },
      {
        Type: "Subtitle", Index: 3, Codec: "ass", Language: "jpn",
        Title: "日文 ASS", IsTextSubtitleStream: true, IsDefault: true
      },
      {
        Type: "Subtitle", Index: 4, Codec: "hdmv_pgs_subtitle", Language: "eng",
        IsTextSubtitleStream: false, IsForced: true, IsHearingImpaired: true
      }
    ]
  };
  const subtitles = mapSubtitleStreams(source);
  assert.deepEqual(subtitles.map(({ index, mode, isExternal }) => ({ index, mode, isExternal })), [
    { index: 2, mode: "external-vtt", isExternal: true },
    { index: 3, mode: "external-vtt", isExternal: false },
    { index: 4, mode: "burn-in", isExternal: false }
  ]);
  assert.equal(defaultSubtitleIndex(source, subtitles), 3);
  assert.equal(defaultSubtitleIndex({ ...source, DefaultSubtitleStreamIndex: null }, subtitles), 4);
});

test("登录、首页、搜索和选集输出 renderer 可直接消费的 camelCase DTO", async () => {
  const storage = new FakeStorage();
  const calls = [];
  const service = new EmbyService({
    storage,
    clientFactory: (settings) => makeClient(settings, calls),
    loginHostGuard: async () => {},
    randomUUIDImpl: () => "playback-id"
  });

  const status = await service.handleRpc("auth.login", {
    baseUrl: "https://emby.example/emby/",
    username: "alice",
    password: "secret"
  }, { signal: new AbortController().signal });
  assert.deepEqual(status, {
    connected: true,
    baseUrl: "https://emby.example/emby",
    username: "alice",
    serverId: "server",
    userId: "user"
  });
  assert.equal(storage.config.deviceId, "stable-device");
  assert.deepEqual(storage.savedTokens, [{ serverId: "server", userId: "user", token: "token" }]);

  const home = await service.handleRpc("home.get");
  assert.equal(home.views[0].id, "view");
  assert.deepEqual(home.resume[0], {
    id: "episode",
    name: "第二集",
    type: "Episode",
    seriesId: "series",
    seriesName: "示例剧集",
    seasonId: "season",
    indexNumber: 2,
    parentIndexNumber: 1,
    runtimeTicks: 1000,
    imageUrl: "https://emby.example/emby/Items/episode/Images/Primary",
    progressPercent: 25,
    positionTicks: 250,
    played: false
  });
  assert.equal(home.latest[0].productionYear, 2026);
  assert.equal(home.views[0].isFolder, true);
  const library = await service.handleRpc("library.get", { parentId: "view", startIndex: 0, limit: 60 });
  assert.equal(library.totalRecordCount, 2);
  assert.equal(library.items[0].isFolder, true);
  assert.equal(library.items[0].childCount, 8);
  assert.equal(library.items[1].type, "Movie");
  assert.equal(calls.find((call) => call.method === "library").parentId, "view");
  const resumed = await service.handleRpc("playback.open", { itemId: "episode" });
  assert.equal(resumed.startPositionTicks, 250);
  await service.handleRpc("playback.stop", { playbackId: resumed.playbackId });
  assert.deepEqual(await service.handleRpc("search", { query: "x" }), { items: [] });
  assert.equal((await service.handleRpc("search", { query: "剧集" })).items[0].type, "Series");

  const series = await service.handleRpc("series.get", { seriesId: "series" });
  assert.equal(series.selectedSeasonId, "season");
  assert.deepEqual(series.seasons[0], { id: "season", name: "第一季", indexNumber: 1, imageUrl: undefined });
  assert.equal(series.episodes[0].indexNumber, 1);
});

class MultiServerStorage {
  constructor(servers, activeServerKey, tokens) {
    this.state = { version: 2, servers: servers.map((server) => ({ ...server })), activeServerKey };
    this.tokens = new Map(tokens);
    this.deletedTokens = [];
  }

  async loadState() { return structuredClone(this.state); }
  async saveState(state) {
    this.state = structuredClone({ version: 2, ...state });
    return structuredClone(this.state);
  }
  createDeviceId(config) { return config?.deviceId ?? "stable-device"; }
  async readToken(serverId, userId) { return this.tokens.get(`${serverId}:${userId}`) ?? null; }
  async saveToken(serverId, userId, token) { this.tokens.set(`${serverId}:${userId}`, token); }
  async deleteToken(serverId, userId) {
    const key = `${serverId}:${userId}`;
    this.deletedTokens.push({ serverId, userId });
    return this.tokens.delete(key);
  }
}

test("保存多个服务器并快速切换，切换前停止当前播放且各 Token 相互独立", async () => {
  const serverA = {
    baseUrl: "https://a.example",
    serverId: "server-a",
    userId: "user-a",
    username: "alice",
    deviceId: "stable-device"
  };
  const serverB = {
    baseUrl: "https://b.example/emby",
    serverId: "server-b",
    userId: "user-b",
    username: "bob",
    deviceId: "stable-device"
  };
  const calls = [];
  const storage = new MultiServerStorage(
    [serverA, serverB],
    embyServerKey(serverA),
    [[embyServerKey(serverA), "token-a"], [embyServerKey(serverB), "token-b"]]
  );
  const service = new EmbyService({
    storage,
    clientFactory: (settings) => makeClient(settings, calls),
    randomUUIDImpl: () => "switch-playback"
  });

  const before = await service.handleRpc("servers.list");
  assert.deepEqual(before.servers.map(({ key, active, connected }) => ({ key, active, connected })), [
    { key: embyServerKey(serverA), active: true, connected: true },
    { key: embyServerKey(serverB), active: false, connected: true }
  ]);
  await service.handleRpc("playback.open", { itemId: "movie" });
  const switched = await service.handleRpc("servers.switch", { serverKey: embyServerKey(serverB) });
  assert.equal(switched.baseUrl, serverB.baseUrl);
  assert.equal(switched.connected, true);
  assert.ok(calls.some((call) => call.method === "stopped"));
  assert.equal(storage.tokens.get(embyServerKey(serverA)), "token-a");
  assert.equal(storage.tokens.get(embyServerKey(serverB)), "token-b");
  const after = await service.handleRpc("servers.list");
  assert.equal(after.servers.find((server) => server.key === embyServerKey(serverB)).active, true);
  const removed = await service.handleRpc("servers.remove", { serverKey: embyServerKey(serverB) });
  assert.equal(removed.baseUrl, serverA.baseUrl);
  assert.equal(removed.connected, true);
  assert.equal((await service.handleRpc("servers.list")).servers.length, 1);
  assert.equal(storage.tokens.has(embyServerKey(serverB)), false);
});

test("切换服务器时旧服务器停止上报失败不阻塞切换（不再卡在坏服务器）", async () => {
  const serverA = { baseUrl: "https://a.example", serverId: "server-a", userId: "user-a", username: "alice", deviceId: "stable-device" };
  const serverB = { baseUrl: "https://b.example", serverId: "server-b", userId: "user-b", username: "bob", deviceId: "stable-device" };
  const storage = new MultiServerStorage(
    [serverA, serverB],
    embyServerKey(serverA),
    [[embyServerKey(serverA), "token-a"], [embyServerKey(serverB), "token-b"]]
  );
  const service = new EmbyService({
    storage,
    clientFactory: (settings) => ({
      ...makeClient(settings, []),
      // 旧服务器离线：停止上报永远失败。
      async reportPlaybackStopped() { throw new EmbyError("NETWORK_ERROR", "服务器离线", { retryable: true }); }
    }),
    randomUUIDImpl: () => "switch-playback"
  });
  await service.handleRpc("playback.open", { itemId: "movie" });
  const switched = await service.handleRpc("servers.switch", { serverKey: embyServerKey(serverB) });
  assert.equal(switched.connected, true);
  assert.equal(switched.baseUrl, serverB.baseUrl);
});

test("旧服务器迟到的 401 不会删除切换后新服务器的 Token", async () => {
  const serverA = { baseUrl: "https://a.example", serverId: "server-a", userId: "user-a", username: "alice", deviceId: "stable-device" };
  const serverB = { baseUrl: "https://b.example", serverId: "server-b", userId: "user-b", username: "bob", deviceId: "stable-device" };
  const storage = new MultiServerStorage(
    [serverA, serverB],
    embyServerKey(serverA),
    [[embyServerKey(serverA), "token-a"], [embyServerKey(serverB), "token-b"]]
  );
  let releaseA;
  const service = new EmbyService({
    storage,
    clientFactory: (settings) => ({
      ...makeClient(settings, []),
      // 服务器 A 的 getViews 挂起，直到我们在切换到 B 之后才以 401 拒绝。
      getViews: () => settings.baseUrl.includes("a.example")
        ? new Promise((_resolve, reject) => { releaseA = () => reject(new EmbyError("UNAUTHORIZED", "过期", { status: 401 })); })
        : Promise.resolve({ Items: [] })
    }),
    randomUUIDImpl: () => "race-playback"
  });
  const slowHome = service.handleRpc("home.get").catch((error) => error);
  await service.handleRpc("servers.switch", { serverKey: embyServerKey(serverB) });
  releaseA();
  await slowHome;
  // 迟到的 401 属于服务器 A；服务器 B 的 Token 必须完好，且不在删除列表里。
  assert.equal(storage.tokens.get(embyServerKey(serverB)), "token-b");
  assert.ok(!storage.deletedTokens.some((entry) => entry.serverId === "server-b"));
});

test("停止播放期间并发的进度上报被短路，不会排在 Stopped 之后", async () => {
  const config = { baseUrl: "https://emby.example", serverId: "server", userId: "user", username: "alice", deviceId: "device" };
  const storage = new FakeStorage(config, "token");
  const calls = [];
  let releaseStop;
  const service = new EmbyService({
    storage,
    clientFactory: (settings) => ({
      ...makeClient(settings, calls),
      // 让 Stopped 上报挂起，制造 stop 尚未完成时 progress 抵达的竞态窗口。
      reportPlaybackStopped(session) {
        calls.push({ method: "stopped", session: { ...session } });
        return new Promise((resolve) => { releaseStop = resolve; });
      }
    }),
    randomUUIDImpl: () => "stop-race"
  });
  const opened = await service.handleRpc("playback.open", { itemId: "movie" });
  const stopping = service.handleRpc("playback.stop", { playbackId: opened.playbackId, positionTicks: 5000 });
  // stop 进行中（session.stopped 已置位）到达的 progress 必须被短路。
  const progressResult = await service.handleRpc("playback.progress", { playbackId: opened.playbackId, positionTicks: 9999 });
  assert.equal(progressResult.stopped, true);
  releaseStop();
  await stopping;
  // 全程只有 Stopped 上报，没有任何 progress 上报排在其后（或存在）。
  assert.equal(calls.some((call) => call.method === "stopped"), true);
  assert.equal(calls.some((call) => call.method === "progress"), false);
});

test("同一目标重新打开播放会先停掉旧会话，不留僵尸会话/未停转码", async () => {
  const config = { baseUrl: "https://emby.example", serverId: "server", userId: "user", username: "alice", deviceId: "device" };
  const storage = new FakeStorage(config, "token");
  const calls = [];
  let nextId = 0;
  const service = new EmbyService({
    storage,
    clientFactory: (settings) => makeClient(settings, calls),
    randomUUIDImpl: () => `playback-${++nextId}`
  });
  const first = await service.handleRpc("playback.open", { itemId: "movie" }, { targetId: "renderer-1" });
  // 不发 stop 直接对同一目标再开一个：旧会话必须被服务端停止（reportPlaybackStopped）。
  const second = await service.handleRpc("playback.open", { itemId: "movie" }, { targetId: "renderer-1" });
  assert.notEqual(first.playbackId, second.playbackId);
  assert.ok(calls.some((call) => call.method === "stopped"), "旧会话应已上报 Stopped");
  // 旧会话已从进度上报中消失（PLAYBACK_NOT_FOUND），新会话可正常上报。
  await assert.rejects(
    service.handleRpc("playback.progress", { playbackId: first.playbackId, positionTicks: 1000 }),
    { code: "PLAYBACK_NOT_FOUND" }
  );
  assert.equal(
    (await service.handleRpc("playback.progress", { playbackId: second.playbackId, positionTicks: 1000 })).positionTicks,
    1000
  );
});

test("Started 遥测挂起不会阻断实际起播", async () => {
  const config = { baseUrl: "https://emby.example", serverId: "server", userId: "user", username: "alice", deviceId: "device" };
  const service = new EmbyService({
    storage: new FakeStorage(config, "token"),
    clientFactory: (settings) => ({
      ...makeClient(settings, []),
      reportPlaybackStarted() { return new Promise(() => {}); }
    }),
    playbackEventTimeoutMs: 5,
    randomUUIDImpl: () => "started-timeout"
  });

  const opened = await service.handleRpc("playback.open", { itemId: "movie" });
  assert.equal(opened.playbackId, "started-timeout");
  assert.equal(opened.streamMode, "hls");
});

test("旧会话 Stopped 遥测挂起不会阻断同目标下一次起播", async () => {
  const config = { baseUrl: "https://emby.example", serverId: "server", userId: "user", username: "alice", deviceId: "device" };
  let nextId = 0;
  const service = new EmbyService({
    storage: new FakeStorage(config, "token"),
    clientFactory: (settings) => ({
      ...makeClient(settings, []),
      reportPlaybackStopped() { return new Promise(() => {}); }
    }),
    hlsProxyFactory: null,
    playbackEventTimeoutMs: 5,
    randomUUIDImpl: () => `replacement-${++nextId}`
  });

  const first = await service.handleRpc("playback.open", { itemId: "movie" }, { targetId: "renderer-1" });
  const second = await service.handleRpc("playback.open", { itemId: "movie" }, { targetId: "renderer-1" });
  assert.notEqual(second.playbackId, first.playbackId);
  await assert.rejects(
    service.handleRpc("playback.progress", { playbackId: first.playbackId, positionTicks: 1000 }),
    { code: "PLAYBACK_NOT_FOUND" }
  );
  assert.equal(
    (await service.handleRpc("playback.progress", { playbackId: second.playbackId, positionTicks: 1000 })).positionTicks,
    1000
  );
});

test("不同目标的播放会话互不影响：重新打开只停自己目标的旧会话", async () => {
  const config = { baseUrl: "https://emby.example", serverId: "server", userId: "user", username: "alice", deviceId: "device" };
  const storage = new FakeStorage(config, "token");
  const calls = [];
  let nextId = 0;
  const service = new EmbyService({
    storage,
    clientFactory: (settings) => makeClient(settings, calls),
    randomUUIDImpl: () => `playback-${++nextId}`
  });
  const a = await service.handleRpc("playback.open", { itemId: "movie" }, { targetId: "renderer-a" });
  const b = await service.handleRpc("playback.open", { itemId: "movie" }, { targetId: "renderer-b" });
  // 目标 a 重新打开，只应停掉 a 的旧会话，b 不受影响。
  await service.handleRpc("playback.open", { itemId: "movie" }, { targetId: "renderer-a" });
  await assert.rejects(
    service.handleRpc("playback.progress", { playbackId: a.playbackId, positionTicks: 500 }),
    { code: "PLAYBACK_NOT_FOUND" }
  );
  assert.equal(
    (await service.handleRpc("playback.progress", { playbackId: b.playbackId, positionTicks: 500 })).positionTicks,
    500
  );
});

test("disposeTarget 停止上报重试失败后本地回收会话，不再接受进度上报", async () => {
  const config = { baseUrl: "https://emby.example", serverId: "server", userId: "user", username: "alice", deviceId: "device" };
  const storage = new FakeStorage(config, "token");
  const service = new EmbyService({
    storage,
    clientFactory: (settings) => ({
      ...makeClient(settings, []),
      // 服务器离线：停止上报重试也失败。
      async reportPlaybackStopped() { throw new EmbyError("NETWORK_ERROR", "离线", { retryable: true }); }
    }),
    randomUUIDImpl: () => "dispose-playback"
  });
  const opened = await service.handleRpc("playback.open", { itemId: "movie" }, { targetId: "renderer-gone" });
  await service.disposeTarget("renderer-gone");
  // 僵尸会话已本地回收：迟到的进度上报不再命中（此前会命中 directSession 已销毁
  // 的残留会话，继续向服务端上报成僵尸 Playing）。
  await assert.rejects(
    service.handleRpc("playback.progress", { playbackId: opened.playbackId, positionTicks: 1000 }),
    { code: "PLAYBACK_NOT_FOUND" }
  );
});

test("登出清空磁盘首页缓存与内存态，且停止上报失败也能完成登出", async () => {
  const config = { baseUrl: "https://emby.example", serverId: "server", userId: "user", username: "alice", deviceId: "device" };
  const storage = new FakeStorage(config, "token", { at: 123, data: { views: [], resume: [], latest: [] } });
  const calls = [];
  const service = new EmbyService({
    storage,
    clientFactory: (settings) => ({
      ...makeClient(settings, calls),
      // 服务器离线：登出前的停止上报失败，不能阻断登出。
      async reportPlaybackStopped() { throw new EmbyError("NETWORK_ERROR", "离线", { retryable: true }); }
    }),
    randomUUIDImpl: () => "logout-playback"
  });
  await service.handleRpc("playback.open", { itemId: "movie" }, { targetId: "renderer-1" });
  const status = await service.handleRpc("auth.logout", {});
  assert.equal(status.connected, false);
  assert.ok(storage.homeCacheCleared >= 1, "登出应清空磁盘首页缓存");
  assert.ok(storage.deletedTokens.some((entry) => entry.serverId === "server"), "登出应删除 Token");
  // 登出后不应还能上报旧会话进度。
  await assert.rejects(
    service.handleRpc("playback.progress", { playbackId: "logout-playback", positionTicks: 1 }),
    (error) => error.code === "PLAYBACK_NOT_FOUND" || error.code === "NOT_CONNECTED"
  );
});

test("Emby 元数据请求超时会取消并自动重试一次", async () => {
  const config = {
    baseUrl: "https://emby.example",
    serverId: "server",
    userId: "user",
    username: "alice",
    deviceId: "device"
  };
  let viewAttempts = 0;
  let firstSignalAborted = false;
  const client = {
    imageUrl: () => "unused",
    getViews(_userId, { signal }) {
      viewAttempts += 1;
      if (viewAttempts > 1) return Promise.resolve({ Items: [] });
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => {
          firstSignalAborted = true;
          reject(signal.reason);
        }, { once: true });
      });
    },
    getResume() { return Promise.resolve({ Items: [] }); },
    getLatest() { return Promise.resolve([]); }
  };
  const service = new EmbyService({
    storage: new FakeStorage(config, "token"),
    clientFactory: () => client,
    metadataTimeoutMs: 10,
    metadataAttempts: 2
  });

  const home = await service.handleRpc("home.get");
  assert.deepEqual(home, { views: [], resume: [], latest: [] });
  assert.equal(viewAttempts, 2);
  assert.equal(firstSignalAborted, true);
});

test("Emby 首页单个接口失败时保留其他可用区域", async () => {
  const config = {
    baseUrl: "https://emby.example",
    serverId: "server",
    userId: "user",
    username: "alice",
    deviceId: "device"
  };
  const failed = new EmbyError("SOURCE_UNAVAILABLE", "section failed");
  const service = new EmbyService({
    storage: new FakeStorage(config, "token"),
    clientFactory: () => ({
      imageUrl: () => "unused",
      async getViews() { throw failed; },
      async getResume() { throw failed; },
      async getLatest() { return [{ Id: "movie", Name: "仍可显示的电影", Type: "Movie" }]; }
    })
  });

  const home = await service.handleRpc("home.get");
  assert.deepEqual(home.views, []);
  assert.deepEqual(home.resume, []);
  assert.equal(home.latest[0].name, "仍可显示的电影");
});

test("Emby 冷启动先返回持久首页缓存，再静默刷新并更新快照", async () => {
  const now = 50_000_000;
  const config = {
    baseUrl: "https://emby.example",
    serverId: "server",
    userId: "user",
    username: "alice",
    deviceId: "device"
  };
  const storage = new FakeStorage(config, "token", {
    at: now - 6 * 60 * 1000,
    data: {
      views: [],
      resume: [{ id: "cached", name: "上次看到这里", type: "Episode", progressPercent: 20, positionTicks: 200, played: false }],
      latest: []
    }
  });
  let networkCalls = 0;
  const service = new EmbyService({
    storage,
    now: () => now,
    clientFactory: () => ({
      imageUrl: () => "unused",
      async getViews() { networkCalls += 1; return { Items: [] }; },
      async getResume() { networkCalls += 1; return { Items: [] }; },
      async getLatest() {
        networkCalls += 1;
        return [{ Id: "fresh", Name: "刚刚添加", Type: "Movie" }];
      }
    })
  });

  const cached = await service.handleRpc("home.get");
  assert.equal(cached.cacheStatus, "stale");
  assert.equal(cached.resume[0].name, "上次看到这里");
  assert.equal(networkCalls, 0);

  const refreshed = await service.handleRpc("home.get", { refresh: true });
  assert.equal(refreshed.latest[0].name, "刚刚添加");
  assert.equal(networkCalls, 3);
  assert.equal(storage.savedHomeCaches.length, 1);
});

test("播放会话依次上报 started/progress/stopped 并清理 ActiveEncoding", async () => {
  const config = {
    baseUrl: "https://emby.example/emby",
    serverId: "server",
    userId: "user",
    username: "alice",
    deviceId: "device"
  };
  const calls = [];
  const service = new EmbyService({
    storage: new FakeStorage(config, "token"),
    clientFactory: (settings) => makeClient(settings, calls),
    randomUUIDImpl: () => "playback-id"
  });

  const opened = await service.handleRpc("playback.open", {
    itemId: "movie",
    startPositionSeconds: 2.5
  }, { targetId: "target-1" });
  const { hlsProxyUrl, ...openedDto } = opened;
  assert.deepEqual(openedDto, {
    playbackId: "playback-id",
    itemId: "movie",
    mediaSourceId: "media-source",
    playSessionId: "play-session",
    streamMode: "hls",
    hlsUrl: "https://emby.example/emby/Videos/movie/master.m3u8?MediaSourceId=media-source",
    startPositionTicks: 25_000_000,
    subtitles: [],
    selectedSubtitleIndex: null,
    subtitleMode: "off",
    qualityLabel: "SD UNKNOWN",
    sourceKey: "sd|unknown#0"
  });
  // HLS 本地代理入口：随机端口 + randomUUID 秘密路径（randomUUIDImpl 已固定），
  // 目标 path+query 原样嵌入，token 不进 URL。
  const proxyUrl = new URL(hlsProxyUrl);
  assert.equal(proxyUrl.hostname, "127.0.0.1");
  assert.equal(proxyUrl.pathname, "/hls/playback-id/emby/Videos/movie/master.m3u8");
  assert.equal(proxyUrl.searchParams.get("MediaSourceId"), "media-source");
  assert.equal(proxyUrl.searchParams.has("token"), false);

  await service.handleRpc("playback.progress", {
    playbackId: "playback-id",
    positionSeconds: 12.5,
    isPaused: true,
    volumeLevel: 35,
    event: "pause"
  });
  const progress = calls.find((call) => call.method === "progress");
  assert.equal(progress.session.positionTicks, 125_000_000);
  assert.equal(progress.session.isPaused, true);
  assert.equal(progress.session.volumeLevel, 35);
  assert.equal(progress.session.eventName, "Pause");

  await service.handleRpc("playback.progress", {
    playbackId: "playback-id",
    positionSeconds: 12.75,
    isPaused: false,
    event: "play"
  });
  assert.equal(calls.filter((call) => call.method === "progress").at(-1).session.eventName, "Unpause");

  await service.handleRpc("playback.stop", { playbackId: "playback-id", positionSeconds: 13 });
  assert.deepEqual(calls.filter((call) => ["started", "progress", "stopped", "stopEncoding"].includes(call.method)).map((call) => call.method), [
    "started", "progress", "progress", "stopped", "stopEncoding"
  ]);
  assert.deepEqual(await service.handleRpc("playback.stop", { playbackId: "playback-id" }), {
    playbackId: "playback-id",
    stopped: false
  });
});

function makeFakeHlsProxy({ failStart = false } = {}) {
  return {
    started: false,
    closed: false,
    registrations: [],
    unregistered: [],
    async start() {
      if (failStart) throw new Error("listen EADDRINUSE");
      this.started = true;
    },
    register(info) {
      this.registrations.push(info);
      const secret = `proxy-secret-${this.registrations.length}`;
      return {
        secret,
        urlFor: (target) => {
          const url = new URL(target);
          return `http://127.0.0.1:43210/hls/${secret}${url.pathname}${url.search}`;
        }
      };
    },
    unregister(secret) { this.unregistered.push(secret); },
    async close() { this.closed = true; }
  };
}

test("HLS 本地代理：open 注册会话返回 hlsProxyUrl，stop 后 unregister，dispose 关闭代理", async () => {
  const config = {
    baseUrl: "https://emby.example/emby",
    serverId: "server",
    userId: "user",
    username: "alice",
    deviceId: "device"
  };
  const calls = [];
  const fakeProxy = makeFakeHlsProxy();
  const service = new EmbyService({
    storage: new FakeStorage(config, "token"),
    clientFactory: (settings) => makeClient(settings, calls),
    hlsProxyFactory: () => fakeProxy,
    randomUUIDImpl: () => "playback-id"
  });

  const opened = await service.handleRpc("playback.open", { itemId: "movie" }, { targetId: "target-1" });
  assert.equal(fakeProxy.started, true);
  // pathPrefix 收口到该视频自己的 HLS 目录，且拼上了 baseUrl 的 /emby 子路径。
  assert.deepEqual(fakeProxy.registrations, [{
    token: "token",
    baseUrl: "https://emby.example/emby",
    pathPrefix: "/emby/Videos/movie/"
  }]);
  assert.equal(
    opened.hlsProxyUrl,
    "http://127.0.0.1:43210/hls/proxy-secret-1/emby/Videos/movie/master.m3u8?MediaSourceId=media-source"
  );
  // 降级通道保留：hlsUrl 照旧返回
  assert.equal(opened.hlsUrl, "https://emby.example/emby/Videos/movie/master.m3u8?MediaSourceId=media-source");

  await service.handleRpc("playback.stop", { playbackId: opened.playbackId });
  assert.deepEqual(fakeProxy.unregistered, ["proxy-secret-1"]);

  await service.dispose();
  assert.equal(fakeProxy.closed, true);
});

test("HLS 本地代理启动失败时降级为纯 hlsUrl 并记 warn，播放生命周期不受影响", async () => {
  const config = {
    baseUrl: "https://emby.example/emby",
    serverId: "server",
    userId: "user",
    username: "alice",
    deviceId: "device"
  };
  const calls = [];
  const warnings = [];
  const service = new EmbyService({
    storage: new FakeStorage(config, "token"),
    clientFactory: (settings) => makeClient(settings, calls),
    hlsProxyFactory: () => makeFakeHlsProxy({ failStart: true }),
    logger: { warn: (message, detail) => warnings.push({ message, detail }) },
    randomUUIDImpl: () => "playback-id"
  });

  const opened = await service.handleRpc("playback.open", { itemId: "movie" }, { targetId: "target-1" });
  assert.equal(opened.streamMode, "hls");
  assert.equal(opened.hlsUrl, "https://emby.example/emby/Videos/movie/master.m3u8?MediaSourceId=media-source");
  assert.equal(opened.hlsProxyUrl, undefined);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /本地媒体代理不可用/);
  assert.match(warnings[0].detail.message, /EADDRINUSE/);

  await service.handleRpc("playback.stop", { playbackId: opened.playbackId });
  assert.equal(calls.some((call) => call.method === "stopped"), true);
});

test("HLS 图形字幕切换重建 hlsUrl 时 hlsProxyUrl 同步更新且不重新注册", async () => {
  const config = {
    baseUrl: "https://emby.example/emby",
    serverId: "server",
    userId: "user",
    username: "alice",
    deviceId: "device"
  };
  const calls = [];
  let playbackInfoCalls = 0;
  const fakeProxy = makeFakeHlsProxy();
  const service = new EmbyService({
    storage: new FakeStorage(config, "token"),
    clientFactory: (settings) => {
      const client = makeClient(settings, calls);
      client.getPlaybackInfo = async () => {
        playbackInfoCalls += 1;
        return {
          PlaySessionId: `ass-session-${playbackInfoCalls}`,
          MediaSources: [{
            Id: "media-source",
            SupportsTranscoding: true,
            DefaultSubtitleStreamIndex: 5,
            MediaStreams: [{
              Type: "Subtitle", Index: 5, Codec: "hdmv_pgs_subtitle", Language: "chi",
              IsTextSubtitleStream: false, IsDefault: true
            }]
          }]
        };
      };
      return client;
    },
    hlsProxyFactory: () => fakeProxy,
    randomUUIDImpl: () => "ass-playback"
  });

  const opened = await service.handleRpc("playback.open", { itemId: "movie" });
  assert.equal(opened.subtitleMode, "burn-in");
  assert.match(opened.hlsProxyUrl, /SubtitleStreamIndex=5/);

  const switched = await service.handleRpc("playback.subtitle.select", {
    playbackId: opened.playbackId,
    subtitleStreamIndex: null,
    positionTicks: 42_000_000
  });
  assert.equal(switched.restartRequired, true);
  assert.doesNotMatch(switched.hlsUrl, /SubtitleStreamIndex/);
  assert.ok(switched.hlsProxyUrl, "字幕切换后必须同步返回 hlsProxyUrl");
  assert.doesNotMatch(switched.hlsProxyUrl, /SubtitleStreamIndex/);
  assert.equal(
    switched.hlsProxyUrl,
    "http://127.0.0.1:43210/hls/proxy-secret-1/emby/Videos/movie/master.m3u8?MediaSourceId=media-source"
  );
  assert.equal(fakeProxy.registrations.length, 1, "字幕切换不重新注册代理会话");
  await service.handleRpc("playback.stop", { playbackId: opened.playbackId });
  assert.deepEqual(fakeProxy.unregistered, ["proxy-secret-1"]);
});

test("文字字幕通过 VTT RPC 即时切换，字幕索引随播放状态上报", async () => {
  const config = {
    baseUrl: "https://emby.example/emby",
    serverId: "server",
    userId: "user",
    username: "alice",
    deviceId: "device"
  };
  const calls = [];
  let subtitleClient = null;
  const service = new EmbyService({
    storage: new FakeStorage(config, "token"),
    clientFactory: (settings) => {
      const client = makeClient(settings, calls);
      client.getPlaybackInfo = async () => ({
        PlaySessionId: "subtitle-session",
        MediaSources: [{
          Id: "media-source",
          SupportsTranscoding: true,
          DefaultSubtitleStreamIndex: 2,
          MediaStreams: [{
            Type: "Subtitle",
            Index: 2,
            Codec: "subrip",
            DisplayTitle: "简体中文",
            Language: "chi",
            IsTextSubtitleStream: true,
            IsDefault: true,
            IsExternal: true
          }]
        }]
      });
      subtitleClient = client;
      return client;
    },
    randomUUIDImpl: () => "subtitle-playback"
  });

  const opened = await service.handleRpc("playback.open", { itemId: "movie" });
  assert.equal(opened.subtitleMode, "external-vtt");
  assert.equal(opened.selectedSubtitleIndex, 2);
  assert.equal(opened.subtitles[0].label, "简体中文");
  assert.doesNotMatch(opened.hlsUrl, /SubtitleStreamIndex/);

  const loaded = await service.handleRpc("playback.subtitle.load", {
    playbackId: opened.playbackId,
    subtitleStreamIndex: 2
  });
  assert.match(loaded.data, /^WEBVTT/);
  const originalLoadResource = subtitleClient.loadResource;
  subtitleClient.loadResource = async () => ({ bytes: Uint8Array.of(0xff, 0xfe) });
  assert.equal((await service.handleRpc("playback.subtitle.load", {
    playbackId: opened.playbackId, subtitleStreamIndex: 2
  })).data, loaded.data, "同一播放会话重复选择应直接命中字幕缓存");
  service.playbacks.get(opened.playbackId).subtitleLoader.cache.clear();
  service.playbacks.get(opened.playbackId).subtitleFullLoader.cache.clear();
  await assert.rejects(
    service.handleRpc("playback.subtitle.load", {
      playbackId: opened.playbackId,
      subtitleStreamIndex: 2
    }),
    { code: "INVALID_SUBTITLE_ENCODING" }
  );
  subtitleClient.loadResource = originalLoadResource;

  const selected = await service.handleRpc("playback.subtitle.select", {
    playbackId: opened.playbackId,
    subtitleStreamIndex: null,
    positionTicks: 30_000_000
  });
  assert.equal(selected.restartRequired, false);
  assert.equal(selected.subtitleMode, "off");
  await service.handleRpc("playback.progress", {
    playbackId: opened.playbackId,
    positionTicks: 31_000_000
  });
  assert.equal(calls.filter((call) => call.method === "progress").at(-1).session.subtitleStreamIndex, null);
});

test("playback.open 随带字幕偏好时一次选好，不再依赖默认选择", async () => {
  const config = {
    baseUrl: "https://emby.example",
    serverId: "server",
    userId: "user",
    username: "name",
    deviceId: "device"
  };
  const service = new EmbyService({
    storage: new FakeStorage(config, "token"),
    clientFactory: (settings) => {
      const client = makeClient(settings, []);
      client.getPlaybackInfo = async () => ({
        PlaySessionId: "pref-session",
        MediaSources: [{
          Id: "media-source",
          SupportsTranscoding: true,
          DefaultSubtitleStreamIndex: 2,
          MediaStreams: [
            {
              Type: "Subtitle",
              Index: 2,
              Codec: "subrip",
              DisplayTitle: "简体中文",
              Language: "chi",
              IsTextSubtitleStream: true,
              IsDefault: true
            },
            {
              Type: "Subtitle",
              Index: 5,
              Codec: "subrip",
              DisplayTitle: "English (Forced)",
              Language: "eng",
              IsTextSubtitleStream: true,
              IsForced: true
            },
            {
              Type: "Subtitle",
              Index: 7,
              Codec: "subrip",
              DisplayTitle: "English",
              Language: "eng",
              IsTextSubtitleStream: true
            }
          ]
        }]
      });
      return client;
    },
    randomUUIDImpl: () => "pref-playback"
  });

  // 精确匹配（language+forced+hearingImpaired）优先于仅 language，且压过服务端
  // DefaultSubtitleStreamIndex（=2）。
  const forced = await service.handleRpc("playback.open", {
    itemId: "movie",
    subtitlePreference: { off: false, language: "eng", isForced: true, isHearingImpaired: false }
  });
  assert.equal(forced.selectedSubtitleIndex, 5);

  // 无旗标的 eng 精确命中 index 7（forced/hI 均为 false）。
  const plain = await service.handleRpc("playback.open", {
    itemId: "movie",
    subtitlePreference: { off: false, language: "eng" }
  });
  assert.equal(plain.selectedSubtitleIndex, 7);

  // 精确匹配不到时退化为仅 language 的第一条（chi 只有 index 2）。
  const fallback = await service.handleRpc("playback.open", {
    itemId: "movie",
    subtitlePreference: { off: false, language: "chi", isForced: true }
  });
  assert.equal(fallback.selectedSubtitleIndex, 2);

  // off 表示关字幕。
  const off = await service.handleRpc("playback.open", {
    itemId: "movie",
    subtitlePreference: { off: true }
  });
  assert.equal(off.selectedSubtitleIndex, null);
});

test("HLS 的图形字幕由 Emby Encode，关闭时停止旧转码并原位重启", async () => {
  const config = {
    baseUrl: "https://emby.example/emby",
    serverId: "server",
    userId: "user",
    username: "alice",
    deviceId: "device"
  };
  const calls = [];
  let playbackInfoCalls = 0;
  const service = new EmbyService({
    storage: new FakeStorage(config, "token"),
    clientFactory: (settings) => {
      const client = makeClient(settings, calls);
      client.getPlaybackInfo = async (_itemId, _userId, options) => {
        playbackInfoCalls += 1;
        calls.push({ method: "playbackInfo", options });
        return {
          PlaySessionId: `ass-session-${playbackInfoCalls}`,
          MediaSources: [{
            Id: "media-source",
            SupportsTranscoding: true,
            DefaultSubtitleStreamIndex: 5,
            MediaStreams: [{
              Type: "Subtitle", Index: 5, Codec: "hdmv_pgs_subtitle", Language: "chi",
              IsTextSubtitleStream: false, IsDefault: true
            }]
          }]
        };
      };
      return client;
    },
    randomUUIDImpl: () => "ass-playback"
  });

  const opened = await service.handleRpc("playback.open", { itemId: "movie" });
  assert.equal(opened.streamMode, "hls");
  assert.equal(opened.subtitleMode, "burn-in");
  assert.match(opened.hlsUrl, /SubtitleStreamIndex=5/);
  assert.match(opened.hlsUrl, /SubtitleMethod=Encode/);

  const switched = await service.handleRpc("playback.subtitle.select", {
    playbackId: opened.playbackId,
    subtitleStreamIndex: null,
    positionTicks: 42_000_000
  });
  assert.equal(switched.restartRequired, true);
  assert.equal(switched.subtitleMode, "off");
  assert.equal(switched.startPositionTicks, 42_000_000);
  assert.equal(switched.playSessionId, "ass-session-2");
  assert.doesNotMatch(switched.hlsUrl, /SubtitleStreamIndex/);
  assert.deepEqual(calls.filter((call) => call.method === "playbackInfo").at(-1).options, {
    startTimeTicks: 42_000_000,
    subtitleStreamIndex: null,
    signal: undefined
  });
  const switchCalls = calls.slice(calls.findLastIndex((call) => call.method === "playbackInfo"));
  assert.deepEqual(switchCalls.map((call) => call.method), [
    "playbackInfo",
    "resource",
    "started",
    "stopped",
    "stopEncoding"
  ]);
  assert.equal(switchCalls.find((call) => call.method === "started").session.playSessionId, "ass-session-2");
  assert.equal(switchCalls.find((call) => call.method === "stopped").session.playSessionId, "ass-session-1");
});

test("HLS 图形字幕新会话预检失败时保留旧字幕和旧 PlaySession", async () => {
  const config = {
    baseUrl: "https://emby.example/emby",
    serverId: "server",
    userId: "user",
    username: "alice",
    deviceId: "device"
  };
  const calls = [];
  let playbackInfoCalls = 0;
  const service = new EmbyService({
    storage: new FakeStorage(config, "token"),
    clientFactory: (settings) => {
      const client = makeClient(settings, calls);
      client.getPlaybackInfo = async () => {
        playbackInfoCalls += 1;
        return {
          PlaySessionId: `session-${playbackInfoCalls}`,
          MediaSources: [{
            Id: "source",
            SupportsTranscoding: true,
            DefaultSubtitleStreamIndex: 4,
            MediaStreams: [{
              Type: "Subtitle", Index: 4, Codec: "hdmv_pgs_subtitle",
              IsTextSubtitleStream: false, IsDefault: true
            }]
          }]
        };
      };
      client.loadResource = async (_url, options) => {
        calls.push({ method: "resource", options });
        throw new EmbyError("NETWORK_ERROR", "新字幕流预检失败", { retryable: true });
      };
      return client;
    },
    randomUUIDImpl: () => "transaction-playback"
  });

  const opened = await service.handleRpc("playback.open", { itemId: "movie" });
  await assert.rejects(
    service.handleRpc("playback.subtitle.select", {
      playbackId: opened.playbackId,
      subtitleStreamIndex: null,
      positionTicks: 20_000_000
    }),
    { code: "NETWORK_ERROR" }
  );
  await service.handleRpc("playback.progress", {
    playbackId: opened.playbackId,
    positionTicks: 21_000_000
  });
  const progress = calls.findLast((call) => call.method === "progress");
  assert.equal(progress.session.playSessionId, "session-1");
  assert.equal(progress.session.subtitleStreamIndex, 4);
  assert.equal(calls.findLast((call) => call.method === "stopEncoding").playSessionId, "session-2");
});

test("仅直连媒体只为 PGS 启动 FFmpeg，ASS 切为 WebVTT 后恢复 MP4 媒体桥", async () => {
  const config = {
    baseUrl: "https://emby.example/emby",
    serverId: "server",
    userId: "user",
    username: "alice",
    deviceId: "device"
  };
  const calls = [];
  const created = [];
  let ffmpegDestroyed = false;
  const service = new EmbyService({
    storage: new FakeStorage(config, "token"),
    clientFactory: (settings) => {
      const client = makeClient(settings, calls);
      client.getPlaybackInfo = async () => ({
        PlaySessionId: "pgs-session",
        MediaSources: [{
          Id: "mp4-source",
          Container: "mp4",
          RunTimeTicks: 100_000_000,
          SupportsDirectPlay: true,
          SupportsDirectStream: true,
          SupportsTranscoding: false,
          DirectStreamUrl: "/Videos/movie/stream.mp4",
          DefaultSubtitleStreamIndex: 2,
          MediaStreams: [
            { Type: "Video", Index: 0, Codec: "h264" },
            { Type: "Audio", Index: 1, Codec: "aac" },
            {
              Type: "Subtitle", Index: 2, Codec: "hdmv_pgs_subtitle",
              Language: "chi", IsTextSubtitleStream: false, IsDefault: true
            },
            {
              Type: "Subtitle", Index: 3, Codec: "ass",
              Language: "jpn", IsTextSubtitleStream: true, IsExternal: false
            }
          ]
        }]
      });
      client.loadDirectRange = async (_url, options) => ({
        bytes: Uint8Array.of(1),
        start: options.start,
        end: options.start,
        total: 1,
        contentType: "video/mp4"
      });
      return client;
    },
    directSessionFactory: (options) => {
      created.push({ kind: "direct", options });
      return {
        async initialize({ startTimeSeconds }) {
          return { startTimeSeconds, tracks: [{ id: 0, mime: "video/mp4", initData: "AQ==" }] };
        },
        async next() { return { segments: [], end: true }; },
        async seek(timeSeconds) { return { timeSeconds }; },
        destroy() {}
      };
    },
    ffmpegSessionFactory: (options) => {
      created.push({ kind: "ffmpeg", options });
      return {
        async initialize({ startTimeSeconds }) {
          return { startTimeSeconds, tracks: [{ id: 0, mime: "video/mp4", initData: "AQ==" }] };
        },
        async next() { return { segments: [], end: true }; },
        async seek(timeSeconds) { return { timeSeconds }; },
        destroy() { ffmpegDestroyed = true; }
      };
    },
    randomUUIDImpl: () => "pgs-playback"
  });

  const opened = await service.handleRpc("playback.open", { itemId: "movie" });
  assert.equal(opened.streamMode, "ffmpeg-fmp4");
  assert.equal(opened.subtitleMode, "burn-in");
  assert.equal(created[0].kind, "ffmpeg");
  assert.equal(created[0].options.subtitleTrack.index, 2);

  const selectedAss = await service.handleRpc("playback.subtitle.select", {
    playbackId: opened.playbackId,
    subtitleStreamIndex: 3,
    positionTicks: 40_000_000
  });
  assert.equal(selectedAss.streamMode, "direct-mp4");
  assert.equal(selectedAss.subtitleMode, "external-vtt");
  assert.equal(selectedAss.restartRequired, true);
  assert.equal(created[1].kind, "direct");
  assert.equal(ffmpegDestroyed, true);
  const loadedAss = await service.handleRpc("playback.subtitle.load", {
    playbackId: opened.playbackId,
    subtitleStreamIndex: 3
  });
  assert.match(loadedAss.data, /^WEBVTT/);
  assert.match(loadedAss.data, /ASS 字幕/);

  const switched = await service.handleRpc("playback.subtitle.select", {
    playbackId: opened.playbackId,
    subtitleStreamIndex: null,
    positionTicks: 50_000_000
  });
  assert.equal(switched.streamMode, "direct-mp4");
  assert.equal(switched.restartRequired, false);
  assert.equal(created.length, 2);
});

test("外挂 ASS 在 Node 内转换为 WebVTT，DeliveryUrl 不暴露给 Renderer", async () => {
  const config = {
    baseUrl: "https://emby.example/emby",
    serverId: "server",
    userId: "user",
    username: "alice",
    deviceId: "device"
  };
  const resourceUrls = [];
  const service = new EmbyService({
    storage: new FakeStorage(config, "token"),
    clientFactory: (settings) => {
      const client = makeClient(settings, []);
      client.getPlaybackInfo = async () => ({
        PlaySessionId: "external-ass-session",
        MediaSources: [{
          Id: "direct-source",
          Container: "mp4",
          SupportsDirectPlay: true,
          SupportsDirectStream: true,
          SupportsTranscoding: false,
          DirectStreamUrl: "/Videos/movie/stream.mp4",
          MediaStreams: [
            { Type: "Video", Index: 0, Codec: "h264" },
            { Type: "Audio", Index: 1, Codec: "aac" },
            {
              Type: "Subtitle", Index: 2, Codec: "ass", IsTextSubtitleStream: true,
              IsExternal: true, DeliveryUrl: "/emby/private/subtitle.ass"
            }
          ]
        }]
      });
      client.loadDirectRange = async (_url, options) => ({
        bytes: Uint8Array.of(1),
        start: options.start,
        end: options.start,
        total: 1,
        contentType: "video/mp4"
      });
      client.loadResource = async (url) => {
        resourceUrls.push(String(url));
        if (String(url).includes("/Subtitles/")) {
          throw new EmbyError("NOT_FOUND", "标准字幕端点不可用");
        }
        return {
          bytes: new TextEncoder().encode(`[Script Info]
ScriptType: v4.00+

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,私有 ASS 字幕`)
        };
      };
      return client;
    },
    directSessionFactory: () => ({
      async initialize() { return { tracks: [{ id: 0, mime: "video/mp4", initData: "AQ==" }] }; },
      destroy() {}
    }),
    ffmpegSessionFactory: () => { throw new Error("ASS 不应启动 FFmpeg"); },
    randomUUIDImpl: () => "external-ass-playback"
  });

  const opened = await service.handleRpc("playback.open", { itemId: "movie" });
  assert.doesNotMatch(JSON.stringify(opened), /DeliveryUrl|private\/subtitle/);
  const selected = await service.handleRpc("playback.subtitle.select", {
    playbackId: opened.playbackId,
    subtitleStreamIndex: 2,
    positionTicks: 10_000_000
  });
  assert.equal(selected.streamMode, "direct-mp4");
  assert.equal(selected.subtitleMode, "external-vtt");
  assert.equal(selected.restartRequired, false);
  const loaded = await service.handleRpc("playback.subtitle.load", {
    playbackId: opened.playbackId,
    subtitleStreamIndex: 2
  });
  assert.deepEqual(resourceUrls, [
    "https://emby.example/emby/private/subtitle.ass"
  ]);
  assert.match(loaded.data, /^WEBVTT/);
  assert.match(loaded.data, /私有 ASS 字幕/);
});

test("仅支持直连的 MP4 优先返回本机 Range 代理并保留 MSE 会话，不调用 HLS 转码", async () => {
  const config = {
    baseUrl: "https://emby.example/emby",
    serverId: "server",
    userId: "user",
    username: "alice",
    deviceId: "device"
  };
  const calls = [];
  let destroyed = false;
  const directCalls = [];
  const proxyRequests = [];
  const service = new EmbyService({
    storage: new FakeStorage(config, "token"),
    clientFactory: (settings) => {
      const client = makeClient(settings, calls);
      client.token = settings.token;
      client.deviceId = settings.deviceId;
      client.fetchImpl = async (url, options) => {
        proxyRequests.push({ url: String(url), options });
        return new Response(Uint8Array.of(0x66, 0x74, 0x79, 0x70), {
          status: 206,
          headers: {
            "Content-Type": "video/mp4",
            "Content-Length": "4",
            "Content-Range": "bytes 0-3/100",
            "Accept-Ranges": "bytes"
          }
        });
      };
      client.getPlaybackInfo = async () => ({
        PlaySessionId: "direct-session",
        MediaSources: [{
          Id: "direct-source",
          Container: "mp4",
          SupportsDirectPlay: true,
          SupportsDirectStream: true,
          SupportsTranscoding: false,
          DirectStreamUrl: "/Videos/movie/stream.mp4?Static=true",
          MediaStreams: [
            { Type: "Video", Index: 0, Codec: "h264" },
            { Type: "Audio", Index: 1, Codec: "aac" }
          ]
        }]
      });
      client.loadDirectRange = async (_url, options) => {
        calls.push({ method: "directRange", options });
        if (calls.filter((call) => call.method === "directRange").length === 1) {
          throw new EmbyError("DIRECT_URL_EXPIRED", "首次 CDN 签名已失效", {
            status: 403,
            retryable: true
          });
        }
        return { bytes: Uint8Array.of(1), start: options.start, end: options.start, total: 1 };
      };
      client.openDirectRangeStream = async (_url, options) => {
        calls.push({ method: "directStream", options });
        return {
          body: (async function* () { yield Uint8Array.of(1); })(),
          start: options.start,
          end: options.start,
          total: 1,
          contentType: "video/mp4",
          async cancel() {}
        };
      };
      return client;
    },
    directSessionFactory: ({ readRange, openRangeStream }) => ({
      async initialize(options) {
        directCalls.push({ method: "init", options });
        await readRange({ start: 0, end: 0, signal: options.signal });
        return {
          durationSeconds: 60,
          startTimeSeconds: 0,
          tracks: [{ id: 1, type: "video", codec: "avc1.64001f", mime: "video/mp4", initData: "AQ==" }]
        };
      },
      async next(options) {
        directCalls.push({ method: "next", options });
        const stream = await openRangeStream({ start: 0, end: null, signal: options.signal });
        for await (const _chunk of stream.body) break;
        return { segments: [], end: true };
      },
      seek(timeSeconds) { directCalls.push({ method: "seek", timeSeconds }); return { timeSeconds, offset: 10 }; },
      destroy() { destroyed = true; }
    }),
    randomUUIDImpl: () => "direct-playback"
  });

  const opened = await service.handleRpc("playback.open", { itemId: "movie" }, { mediaTransport: "intercept" });
  const { directMediaUrl, ...openedDto } = opened;
  assert.deepEqual(openedDto, {
    playbackId: "direct-playback",
    itemId: "movie",
    mediaSourceId: "direct-source",
    playSessionId: "direct-session",
    streamMode: "direct-mp4",
    startPositionTicks: 0,
    subtitles: [],
    selectedSubtitleIndex: null,
    subtitleMode: "off",
    qualityLabel: "SD MP4 H264",
    sourceKey: "sd|mp4#0"
  });
  // 页面拿到的是拦截域名；CDP 拦截把它改写回已登记的 loopback 代理端口。
  assert.match(directMediaUrl, /^https:\/\/codex-companion\.invalid\/\d+\/hls\/direct-playback\/Videos\/movie\/stream\.mp4(\?Static=true)?$/);
  const directProxyUrl = resolveMediaInterceptUrl(directMediaUrl);
  const directProxy = new URL(directProxyUrl);
  assert.equal(directProxy.hostname, "127.0.0.1");
  assert.match(directProxy.pathname, /^\/hls\/direct-playback\/Videos\/movie\/stream\.mp4(\?Static=true)?$/);
  assert.equal(calls.some((call) => call.method === "started"), true);
  assert.equal(calls.some((call) => call.method === "stopEncoding"), false);

  const proxied = await fetch(directProxyUrl, { headers: { Range: "bytes=0-3" } });
  assert.equal(proxied.status, 206);
  assert.deepEqual(new Uint8Array(await proxied.arrayBuffer()), Uint8Array.of(0x66, 0x74, 0x79, 0x70));
  assert.equal(proxyRequests.length, 1);
  assert.equal(proxyRequests[0].options.headers.Range, "bytes=0-3");
  assert.equal(proxyRequests[0].options.headers["X-Emby-Token"], "token");
  assert.match(proxyRequests[0].options.headers["X-Emby-Authorization"], /DeviceId="device"/);

  const controller = new AbortController();
  const init = await service.handleRpc("playback.direct.init", { playbackId: "direct-playback" }, { signal: controller.signal });
  assert.equal(init.durationSeconds, 60);
  const rangeCalls = calls.filter((call) => call.method === "directRange");
  assert.equal(rangeCalls.length, 2);
  assert.ok(rangeCalls.every((call) => call.options.signal === controller.signal));
  assert.ok(rangeCalls.every((call) => call.options.resolvedUrl === null));
  assert.deepEqual(await service.handleRpc("playback.direct.next", {
    playbackId: "direct-playback"
  }, { signal: controller.signal }), { segments: [], end: true });
  assert.equal(calls.find((call) => call.method === "directStream").options.signal, controller.signal);
  assert.deepEqual(await service.handleRpc("playback.direct.seek", {
    playbackId: "direct-playback",
    timeSeconds: 20
  }), { timeSeconds: 20, offset: 10 });
  await service.handleRpc("playback.direct.init", { playbackId: "direct-playback" });
  assert.equal(directCalls.filter((call) => call.method === "init").at(-1).options.startTimeSeconds, 20);
  await service.handleRpc("playback.stop", { playbackId: "direct-playback" });
  assert.equal(destroyed, true);
  assert.equal(calls.some((call) => call.method === "stopEncoding"), false);
});

test("仅支持直连的 MKV 交给本机 FFmpeg 媒体桥，不调用 Emby 转码", async () => {
  const config = {
    baseUrl: "https://emby.example/emby",
    serverId: "server",
    userId: "user",
    username: "alice",
    deviceId: "device"
  };
  const calls = [];
  const ffmpegCalls = [];
  let destroyed = false;
  const service = new EmbyService({
    storage: new FakeStorage(config, "token"),
    clientFactory: (settings) => {
      const client = makeClient(settings, calls);
      client.getPlaybackInfo = async () => ({
        PlaySessionId: "ffmpeg-session",
        MediaSources: [{
          Id: "mkv-source",
          Container: "mkv",
          RunTimeTicks: 90_000_000,
          SupportsDirectPlay: true,
          SupportsDirectStream: true,
          SupportsTranscoding: false,
          DirectStreamUrl: "/Videos/movie/stream.mkv?api_key=must-be-removed",
          MediaStreams: [
            { Type: "Video", Codec: "h264" },
            { Type: "Audio", Codec: "aac" }
          ]
        }]
      });
      client.loadDirectRange = async (_url, options) => {
        calls.push({ method: "directRange", options });
        return {
          bytes: Uint8Array.of(1),
          start: options.start,
          end: options.start,
          total: 1,
          contentType: "video/x-matroska"
        };
      };
      client.openDirectRangeStream = async (_url, options) => {
        calls.push({ method: "directStream", options });
        return {
          body: (async function* () { yield Uint8Array.of(1); })(),
          start: options.start,
          end: options.start,
          total: 1,
          contentType: "video/x-matroska",
          resolvedUrl: "https://cdn.example/video.mkv"
        };
      };
      return client;
    },
    ffmpegSessionFactory: (options) => {
      ffmpegCalls.push({ method: "create", options });
      return {
        async initialize(initOptions) {
          ffmpegCalls.push({ method: "init", options: initOptions });
          const stream = await options.openRangeStream({
            start: 0,
            end: null,
            signal: initOptions.signal
          });
          for await (const _chunk of stream.body) break;
          return {
            durationSeconds: options.durationSeconds,
            startTimeSeconds: 0,
            timestampOffsetSeconds: 0,
            tracks: [{ id: 0, codec: "avc1.640028,mp4a.40.2", mime: "video/mp4", initData: "AQ==" }]
          };
        },
        async next() { return { segments: [], end: true }; },
        async seek(timeSeconds) {
          return { timeSeconds, offset: 0, timestampOffsetSeconds: timeSeconds };
        },
        destroy() { destroyed = true; }
      };
    },
    randomUUIDImpl: () => "ffmpeg-playback"
  });

  const opened = await service.handleRpc("playback.open", { itemId: "movie" });
  assert.deepEqual(opened, {
    playbackId: "ffmpeg-playback",
    itemId: "movie",
    mediaSourceId: "mkv-source",
    playSessionId: "ffmpeg-session",
    streamMode: "ffmpeg-fmp4",
    startPositionTicks: 0,
    subtitles: [],
    selectedSubtitleIndex: null,
    subtitleMode: "off",
    qualityLabel: "SD MKV H264",
    sourceKey: "sd|mkv#0"
  });
  assert.equal(ffmpegCalls[0].options.durationSeconds, 9);
  assert.equal(ffmpegCalls[0].options.mediaSource.Container, "mkv");
  const controller = new AbortController();
  assert.equal((await service.handleRpc(
    "playback.direct.init",
    { playbackId: opened.playbackId },
    { signal: controller.signal }
  )).durationSeconds, 9);
  assert.equal(calls.find((call) => call.method === "directStream").options.signal, controller.signal);
  assert.equal(calls.some((call) => call.method === "directRange"), false);
  assert.deepEqual(await service.handleRpc("playback.direct.seek", {
    playbackId: opened.playbackId,
    timeSeconds: 4
  }), { timeSeconds: 4, offset: 0, timestampOffsetSeconds: 4 });
  await service.handleRpc("playback.stop", { playbackId: opened.playbackId });
  assert.equal(destroyed, true);
  assert.equal(calls.some((call) => call.method === "stopEncoding"), false);
});

test("图形字幕新长流被 CDN 持续拒绝时刷新地址并降级分块 Range，保留原 PlaySession", async () => {
  const config = {
    baseUrl: "https://emby.example/emby",
    serverId: "server",
    userId: "user",
    username: "alice",
    deviceId: "device"
  };
  const calls = [];
  const created = [];
  const rangeAttempts = [];
  const streamAttempts = [];
  let failedReplacementDestroyed = 0;
  let ffmpegInitializeCalls = 0;
  const mediaStreams = [
    { Type: "Video", Index: 0, Codec: "h264" },
    { Type: "Audio", Index: 1, Codec: "aac" },
    { Type: "Subtitle", Index: 2, Codec: "hdmv_pgs_subtitle", Language: "chi", IsTextSubtitleStream: false, IsExternal: false }
  ];
  const mediaSourceFor = (tag) => ({
    Id: "mp4-source",
    Container: "mp4",
    RunTimeTicks: 100_000_000,
    SupportsDirectPlay: true,
    SupportsDirectStream: true,
    SupportsTranscoding: false,
    DirectStreamUrl: `/Videos/movie/stream.mp4?tag=${tag}`,
    MediaStreams: mediaStreams
  });
  let playbackInfoCalls = 0;
  const service = new EmbyService({
    storage: new FakeStorage(config, "token"),
    clientFactory: (settings) => {
      const client = makeClient(settings, calls);
      client.getPlaybackInfo = async (itemId, userId, options) => {
        playbackInfoCalls += 1;
        calls.push({ method: "playbackInfo", itemId, userId, options });
        return {
          PlaySessionId: playbackInfoCalls === 1 ? "session-v1" : "session-v2",
          MediaSources: [mediaSourceFor(playbackInfoCalls === 1 ? "v1" : "v2")]
        };
      };
      client.loadDirectRange = async (url, options) => {
        rangeAttempts.push({ url: String(url), resolvedUrl: options.resolvedUrl });
        return {
          bytes: Uint8Array.of(1),
          start: options.start,
          end: options.start,
          total: 1,
          contentType: "video/mp4",
          resolvedUrl: String(url).includes("tag=v1")
            ? "https://cdn.example/video-v1.mp4?expires=old"
            : "https://cdn.example/video-v2.mp4?expires=fresh"
        };
      };
      client.openDirectRangeStream = async (url, options) => {
        streamAttempts.push({ url: String(url), resolvedUrl: options.resolvedUrl });
        // 真实 CDN 会拒绝字幕新 FFmpeg 的第二条长 Range；即使 PlaybackInfo 已刷新也仍返回 403。
        throw new EmbyError("DIRECT_URL_EXPIRED", "媒体 CDN 地址已失效", { status: 403, retryable: true });
      };
      return client;
    },
    directSessionFactory: (options) => {
      created.push({ kind: "direct", options });
      return {
        async initialize({ startTimeSeconds, signal }) {
          await options.readRange({ start: 0, end: 0, signal });
          return { startTimeSeconds, tracks: [{ id: 0, mime: "video/mp4", initData: "AQ==" }] };
        },
        async next() { return { segments: [], end: true }; },
        async seek(timeSeconds) { return { timeSeconds }; },
        destroy() {}
      };
    },
    ffmpegSessionFactory: (options) => {
      created.push({ kind: "ffmpeg", options });
      return {
        async initialize(initOptions) {
          ffmpegInitializeCalls += 1;
          if (options.openRangeStream) {
            const stream = await options.openRangeStream({ start: 0, end: null, signal: initOptions.signal });
            for await (const _chunk of stream.body) break;
          } else {
            await options.readRange({ start: 0, end: 0, signal: initOptions.signal });
          }
          return { startTimeSeconds: initOptions.startTimeSeconds, tracks: [{ id: 0, mime: "video/mp4", initData: "AQ==" }] };
        },
        async next() { return { segments: [], end: true }; },
        async seek(timeSeconds) { return { timeSeconds }; },
        destroy() { failedReplacementDestroyed += 1; }
      };
    },
    randomUUIDImpl: () => "expired-playback"
  });

  const opened = await service.handleRpc("playback.open", { itemId: "movie" });
  assert.equal(opened.streamMode, "direct-mp4");
  assert.equal(opened.playSessionId, "session-v1");
  await service.handleRpc("playback.direct.init", { playbackId: opened.playbackId });
  assert.equal(rangeAttempts.length, 1);
  assert.equal(rangeAttempts[0].resolvedUrl, null);

  // 播放约 404 秒后切换图形字幕：烧录流重启时旧 CDN 地址已过期。
  const selected = await service.handleRpc("playback.subtitle.select", {
    playbackId: opened.playbackId,
    subtitleStreamIndex: 2,
    positionTicks: 4_040_000_000
  });
  assert.equal(selected.streamMode, "ffmpeg-fmp4");
  assert.equal(selected.selectedSubtitleIndex, 2);

  // 长流依次尝试缓存 CDN、旧入口和刷新后的入口；都被拒绝后才降级有限分块读取。
  assert.equal(streamAttempts.length, 3);
  assert.equal(streamAttempts[0].resolvedUrl, "https://cdn.example/video-v1.mp4?expires=old");
  assert.match(streamAttempts[1].url, /tag=v1/);
  assert.equal(streamAttempts[1].resolvedUrl, null);
  assert.match(streamAttempts[2].url, /tag=v2/);
  assert.equal(streamAttempts[2].resolvedUrl, null);
  assert.equal(rangeAttempts.length, 2);
  assert.match(rangeAttempts[1].url, /tag=v2/);
  assert.equal(rangeAttempts[1].resolvedUrl, null);
  assert.equal(playbackInfoCalls, 2);
  const refreshCall = calls.filter((call) => call.method === "playbackInfo")[1];
  assert.equal(refreshCall.options.startTimeTicks, 4_040_000_000);
  const ffmpegCreations = created.filter((entry) => entry.kind === "ffmpeg");
  assert.equal(ffmpegCreations.length, 2);
  assert.equal(typeof ffmpegCreations[0].options.openRangeStream, "function");
  assert.equal(ffmpegCreations[1].options.openRangeStream, null);
  assert.equal(failedReplacementDestroyed, 1);
  assert.equal(ffmpegInitializeCalls, 2);

  // Renderer 重建 MSE 时直接消费字幕切换阶段的初始化结果，不重复启动 FFmpeg。
  const initialization = await service.handleRpc("playback.direct.init", { playbackId: opened.playbackId });
  assert.equal(initialization.startTimeSeconds, 404);
  assert.equal(ffmpegInitializeCalls, 2);

  // 进度上报仍走开播时的 PlaySession，时间轴不因刷新而切换。
  await service.handleRpc("playback.progress", {
    playbackId: opened.playbackId,
    positionSeconds: 405
  });
  const progress = calls.filter((call) => call.method === "progress").at(-1);
  assert.equal(progress.session.playSessionId, "session-v1");
});

test("CDN 拒绝新旧媒体流共存时，停止旧流后重试图形字幕流初始化成功", async () => {
  // 与上一个用例同场景，但分块 Range 也一律 403（反盗连按“第二个读者”卡）：
  // 只有停掉旧流（第一位读者让出）之后才放行。
  const config = {
    baseUrl: "https://emby.example/emby",
    serverId: "server",
    userId: "user",
    username: "alice",
    deviceId: "device"
  };
  let oldStreamAlive = false;
  let oldDestroyed = false;
  const mediaStreams = [
    { Type: "Video", Index: 0, Codec: "h264" },
    { Type: "Audio", Index: 1, Codec: "aac" },
    { Type: "Subtitle", Index: 2, Codec: "hdmv_pgs_subtitle", Language: "chi", IsTextSubtitleStream: false, IsExternal: false }
  ];
  const service = new EmbyService({
    storage: new FakeStorage(config, "token"),
    clientFactory: (settings) => {
      const client = makeClient(settings, []);
      client.getPlaybackInfo = async () => ({
        PlaySessionId: "session-v1",
        MediaSources: [{
          Id: "mp4-source",
          Container: "mp4",
          RunTimeTicks: 100_000_000,
          SupportsDirectPlay: true,
          SupportsDirectStream: true,
          SupportsTranscoding: false,
          DirectStreamUrl: "/Videos/movie/stream.mp4?tag=v1",
          MediaStreams: mediaStreams
        }]
      });
      client.loadDirectRange = async (url, options) => {
        // 旧流还活着时，任何第二个读者（无论长流还是分块）都被 403；旧流销毁后放行。
        if (oldStreamAlive) {
          throw new EmbyError("DIRECT_URL_EXPIRED", "媒体 CDN 地址已失效", { status: 403, retryable: true });
        }
        return {
          bytes: Uint8Array.of(1),
          start: options.start,
          end: options.start,
          total: 1,
          contentType: "video/mp4",
          resolvedUrl: "https://cdn.example/video-v1.mp4?expires=fresh"
        };
      };
      client.openDirectRangeStream = async () => {
        throw new EmbyError("DIRECT_URL_EXPIRED", "媒体 CDN 地址已失效", { status: 403, retryable: true });
      };
      return client;
    },
    directSessionFactory: (options) => ({
      async initialize({ startTimeSeconds, signal }) {
        await options.readRange({ start: 0, end: 0, signal });
        return { startTimeSeconds, tracks: [{ id: 0, mime: "video/mp4", initData: "AQ==" }] };
      },
      async next() { return { segments: [], end: true }; },
      async seek(timeSeconds) { return { timeSeconds }; },
      destroy() { oldStreamAlive = false; oldDestroyed = true; }
    }),
    ffmpegSessionFactory: (options) => ({
      async initialize(initOptions) {
        if (options.openRangeStream) {
          const stream = await options.openRangeStream({ start: 0, end: null, signal: initOptions.signal });
          for await (const _chunk of stream.body) break;
        } else {
          await options.readRange({ start: 0, end: 0, signal: initOptions.signal });
        }
        return { startTimeSeconds: initOptions.startTimeSeconds, tracks: [{ id: 0, mime: "video/mp4", initData: "AQ==" }] };
      },
      async next() { return { segments: [], end: true }; },
      async seek(timeSeconds) { return { timeSeconds }; },
      destroy() {}
    }),
    randomUUIDImpl: () => "coexist-playback"
  });

  const opened = await service.handleRpc("playback.open", { itemId: "movie" });
  assert.equal(opened.streamMode, "direct-mp4");
  oldStreamAlive = true; // 旧 direct 会话已初始化，正占用第一位读者

  const selected = await service.handleRpc("playback.subtitle.select", {
    playbackId: opened.playbackId,
    subtitleStreamIndex: 2,
    positionTicks: 4_040_000_000
  });
  // 长流与分块都被拒后，第三级「停旧流再试」成功，字幕切换完成。
  assert.equal(oldDestroyed, true);
  assert.equal(selected.streamMode, "ffmpeg-fmp4");
  assert.equal(selected.selectedSubtitleIndex, 2);
});

test("停止转码失败时保留会话，登出会重试后再删除 Token", async () => {
  const config = {
    baseUrl: "https://emby.example/emby",
    serverId: "server",
    userId: "user",
    username: "alice",
    deviceId: "device"
  };
  const calls = [];
  let stopAttempts = 0;
  const storage = new FakeStorage(config, "token");
  const service = new EmbyService({
    storage,
    clientFactory: (settings) => {
      const client = makeClient(settings, calls);
      client.stopActiveEncoding = async (playSessionId) => {
        stopAttempts += 1;
        calls.push({ method: "stopEncoding", playSessionId, attempt: stopAttempts });
        if (stopAttempts === 1) throw new EmbyError("NETWORK_ERROR", "temporary", { retryable: true });
      };
      return client;
    },
    randomUUIDImpl: () => "retry-playback"
  });

  await service.handleRpc("playback.open", { itemId: "movie" }, { targetId: "target-1" });
  const status = await service.handleRpc("auth.logout");

  assert.equal(stopAttempts, 2);
  assert.equal(status.connected, false);
  assert.deepEqual(storage.deletedTokens, [{ serverId: "server", userId: "user" }]);
});

test("resource.load 只允许图片/HLS，返回 base64 且把 bridge AbortSignal 原样传给 Client", async () => {
  const config = {
    baseUrl: "https://emby.example",
    serverId: "server",
    userId: "user",
    username: "alice",
    deviceId: "device"
  };
  const calls = [];
  const service = new EmbyService({
    storage: new FakeStorage(config, "token"),
    clientFactory: (settings) => makeClient(settings, calls)
  });
  const controller = new AbortController();
  const result = await service.handleRpc("resource.load", {
    url: "https://emby.example/Items/1/Images/Primary",
    resourceType: "image"
  }, { signal: controller.signal, requestId: "resource-1" });
  assert.deepEqual(result, {
    data: "AQID",
    encoding: "base64",
    contentType: "image/jpeg",
    url: "https://emby.example/Items/1/Images/Primary"
  });
  assert.equal(calls.find((call) => call.method === "resource").options.signal, controller.signal);
  const segment = await service.handleRpc("resource.load", {
    url: "https://emby.example/Videos/1/segment.ts",
    resourceType: "hls"
  });
  assert.equal(segment.encoding, "base64");
  assert.equal(segment.data, "AQID");
  await assert.rejects(
    service.handleRpc("resource.load", {
      url: "https://emby.example/Users/1",
      resourceType: "json"
    }),
    (error) => error.code === "UNSUPPORTED_RESOURCE_TYPE"
  );
});

test("401 自动删除 Keychain Token、保留服务器和用户名用于重新登录", async () => {
  const config = {
    baseUrl: "https://emby.example",
    serverId: "server",
    userId: "user",
    username: "alice",
    deviceId: "device"
  };
  const storage = new FakeStorage(config, "expired");
  const service = new EmbyService({
    storage,
    clientFactory: () => ({
      async getViews() { throw new EmbyError("UNAUTHORIZED", "expired", { status: 401 }); },
      async getResume() { return { Items: [] }; },
      async getLatest() { return []; }
    })
  });
  await assert.rejects(service.handleRpc("home.get"), { code: "UNAUTHORIZED" });
  assert.deepEqual(await service.handleRpc("connection.status"), {
    connected: false,
    baseUrl: "https://emby.example",
    username: "alice",
    serverId: "server",
    userId: "user"
  });
  assert.deepEqual(storage.deletedTokens, [{ serverId: "server", userId: "user" }]);
});

test("DTO 与进度换算处理缺失字段和边界", () => {
  const client = { imageUrl: () => "unused" };
  assert.equal(secondsToTicks(-1), 0);
  assert.equal(secondsToTicks(1.25), 12_500_000);
  assert.deepEqual(mapEmbyItem({ Id: "1" }, client), {
    id: "1",
    name: "未命名",
    type: "Video",
    progressPercent: 0,
    positionTicks: 0,
    played: false
  });
});

test("MP4 只在单路 H.264/AAC 时直连 Renderer", () => {
  assert.equal(mediaSourceSupportsRendererFmp4({
    MediaStreams: [
      { Type: "Video", Codec: "h264" },
      { Type: "Audio", Codec: "aac" }
    ]
  }), true);
  assert.equal(mediaSourceSupportsRendererFmp4({
    MediaStreams: [
      { Type: "Video", Codec: "hevc" },
      { Type: "Audio", Codec: "aac" }
    ]
  }), false);
  assert.equal(mediaSourceSupportsRendererFmp4({
    MediaStreams: [
      { Type: "Video", Codec: "h264", BitDepth: 10 },
      { Type: "Audio", Codec: "aac" }
    ]
  }), false);
  assert.equal(mediaSourceSupportsRendererFmp4({
    MediaStreams: [
      { Type: "Video", Codec: "h264" },
      { Type: "Audio", Codec: "aac" },
      { Type: "Audio", Codec: "eac3" }
    ]
  }), false);
  assert.equal(mediaSourceSupportsRendererFmp4({
    Bitrate: 95_400_000,
    MediaStreams: [
      { Type: "Video", Codec: "h264", BitDepth: 8, BitRate: 94_998_420 },
      { Type: "Audio", Codec: "aac", BitRate: 317_000 }
    ]
  }), false);
});

test("不兼容 MP4 在进入 Renderer 前自动切换到 FFmpeg", async () => {
  const config = {
    baseUrl: "https://emby.example/emby",
    serverId: "server",
    userId: "user",
    username: "alice",
    deviceId: "device"
  };
  const calls = [];
  const service = new EmbyService({
    storage: new FakeStorage(config, "token"),
    clientFactory: (settings) => {
      const client = makeClient(settings, calls);
      client.getPlaybackInfo = async () => ({
        PlaySessionId: "hevc-session",
        MediaSources: [{
          Id: "hevc-source",
          Container: "mp4",
          RunTimeTicks: 10_000_000,
          SupportsDirectPlay: true,
          SupportsDirectStream: true,
          SupportsTranscoding: false,
          DirectStreamUrl: "/Videos/movie/stream.mp4",
          MediaStreams: [
            { Type: "Video", Index: 0, Codec: "hevc" },
            { Type: "Audio", Index: 1, Codec: "aac" },
            { Type: "Audio", Index: 2, Codec: "eac3" }
          ]
        }]
      });
      return client;
    },
    ffmpegSessionFactory: () => ({ destroy() {} }),
    randomUUIDImpl: () => "hevc-playback"
  });

  const opened = await service.handleRpc("playback.open", { itemId: "movie" });
  assert.equal(opened.streamMode, "ffmpeg-fmp4");
  await service.handleRpc("playback.stop", { playbackId: opened.playbackId });
});

test("95 Mbps H.264 MP4 自动交给本机 FFmpeg 降码率，不进入直连 MSE", async () => {
  const config = {
    baseUrl: "https://emby.example/emby",
    serverId: "server",
    userId: "user",
    username: "alice",
    deviceId: "device"
  };
  const calls = [];
  let ffmpegOptions = null;
  const service = new EmbyService({
    storage: new FakeStorage(config, "token"),
    clientFactory: (settings) => {
      const client = makeClient(settings, calls);
      client.getPlaybackInfo = async () => ({
        PlaySessionId: "concert-session",
        MediaSources: [{
          Id: "concert-4k",
          Name: "4K - 95 Mbps",
          Container: "mp4",
          Bitrate: 95_400_000,
          RunTimeTicks: 90_229_300_000,
          SupportsDirectPlay: true,
          SupportsDirectStream: true,
          SupportsTranscoding: false,
          DirectStreamUrl: "/Videos/concert/stream.mp4",
          MediaStreams: [
            { Type: "Video", Index: 0, Codec: "h264", Height: 2160, BitDepth: 8, BitRate: 94_998_420 },
            { Type: "Audio", Index: 1, Codec: "aac", BitRate: 317_000 }
          ]
        }]
      });
      client.openDirectRangeStream = async (_url, options) => ({
        body: (async function* () { yield Uint8Array.of(1); })(),
        start: options.start,
        end: options.start,
        total: 1,
        contentType: "video/mp4",
        async cancel() {}
      });
      return client;
    },
    directSessionFactory: () => { throw new Error("95 Mbps 源不应进入 DirectMp4Session"); },
    ffmpegSessionFactory: (options) => {
      ffmpegOptions = options;
      return { destroy() {} };
    },
    randomUUIDImpl: () => "concert-playback"
  });

  const opened = await service.handleRpc("playback.open", { itemId: "concert" });
  assert.equal(opened.streamMode, "ffmpeg-fmp4");
  assert.equal(opened.mediaBitrate, 40_000_000);
  assert.equal(ffmpegOptions.mediaSource.Id, "concert-4k");
  assert.equal(typeof ffmpegOptions.openRangeStream, "function");
  await service.handleRpc("playback.stop", { playbackId: opened.playbackId });
});

// ===== 多源选择（选源）=====

function multiSourceMediaSources() {
  // 模拟《七龙珠》一集的多版本：4K/1080p mkv 带字幕，720p mp4 无字幕。
  return [
    {
      Id: "src-4k", Container: "mkv", Name: "4K - 11 Mbps",
      SupportsDirectPlay: true, SupportsDirectStream: true, SupportsTranscoding: false,
      DirectStreamUrl: "/Videos/ep/stream.mkv?src=4k",
      MediaStreams: [
        { Type: "Video", Index: 0, Codec: "hevc", Height: 2160, BitRate: 11_000_000 },
        { Type: "Audio", Index: 1, Codec: "ac3" },
        { Type: "Subtitle", Index: 2, Codec: "ass", Language: "chi", IsTextSubtitleStream: false }
      ]
    },
    {
      Id: "src-1080", Container: "mkv", Name: "1080p - 34 Mbps",
      SupportsDirectPlay: true, SupportsDirectStream: true, SupportsTranscoding: false,
      DirectStreamUrl: "/Videos/ep/stream.mkv?src=1080",
      MediaStreams: [
        { Type: "Video", Index: 0, Codec: "h264", Height: 1080, BitRate: 34_000_000 },
        { Type: "Audio", Index: 1, Codec: "dts" },
        { Type: "Subtitle", Index: 2, Codec: "ass", Language: "chi", IsTextSubtitleStream: false }
      ]
    },
    {
      Id: "src-720", Container: "mp4", Name: "720p - 6 Mbps",
      SupportsDirectPlay: true, SupportsDirectStream: true, SupportsTranscoding: false,
      DirectStreamUrl: "/Videos/ep/stream.mp4?src=720",
      MediaStreams: [
        { Type: "Video", Index: 0, Codec: "h264", Height: 720, BitRate: 6_000_000 },
        { Type: "Audio", Index: 1, Codec: "aac" }
      ]
    }
  ];
}

test("pickMediaSource：默认选有字幕的最高画质源，忽略无字幕的 mp4", () => {
  const sources = multiSourceMediaSources();
  const { mediaSource, ordinal } = pickMediaSource(sources);
  assert.equal(mediaSource.Id, "src-4k", "应选 4K 带字幕源而非 720p mp4");
  assert.equal(ordinal, 0);
});

test("pickMediaSource：preferredSourceKey 命中时强制用指定源", () => {
  const sources = multiSourceMediaSources();
  const key = computeSourceKey(sources[1], 1); // 1080p mkv
  const { mediaSource } = pickMediaSource(sources, { preferredSourceKey: key });
  assert.equal(mediaSource.Id, "src-1080");
});

test("pickMediaSource：无字幕时仍直接选出最高画质的可播放源", () => {
  const noSubs = [{ Id: "x", Container: "mp4", SupportsDirectStream: true, DirectStreamUrl: "/a.mp4", MediaStreams: [{ Type: "Video", Index: 0, Codec: "h264", Height: 720 }] }];
  const { mediaSource } = pickMediaSource(noSubs);
  assert.equal(mediaSource?.Id, "x");
});

test("pickMediaSource：同为 4K 时选择端到端成本更低的 HEVC 源", () => {
  const sources = [
    {
      Id: "h264-high", Container: "mp4", SupportsDirectStream: true,
      DirectStreamUrl: "/high.mp4", Bitrate: 35_600_000,
      MediaStreams: [
        { Type: "Video", Codec: "h264", Height: 2160, BitRate: 35_400_000, IsInterlaced: false },
        { Type: "Audio", Codec: "aac" }
      ]
    },
    {
      Id: "hevc-efficient", Container: "mp4", SupportsDirectStream: true,
      DirectStreamUrl: "/efficient.mp4", Bitrate: 10_500_000,
      MediaStreams: [
        { Type: "Video", Codec: "hevc", Height: 2232, BitRate: 10_300_000, IsInterlaced: false },
        { Type: "Audio", Codec: "aac" }
      ]
    }
  ];
  assert.equal(pickMediaSource(sources).mediaSource?.Id, "hevc-efficient");
  assert.equal(
    pickMediaSource(sources, { localFfmpegAvailable: false }).mediaSource?.Id,
    "h264-high",
    "没有 FFmpeg 时必须保留可直放版本"
  );
  assert.deepEqual(
    mapMediaSourceOptions(sources).map((option) => option.recommended),
    [false, true]
  );
});

test("pickMediaSource：同分辨率优先逐行源，避免仅按较低码率误选 1080i", () => {
  const sources = [
    {
      Id: "progressive", Container: "mkv", SupportsDirectStream: true,
      DirectStreamUrl: "/progressive.mkv", Bitrate: 31_500_000,
      MediaStreams: [{ Type: "Video", Codec: "h264", Height: 1080, BitRate: 31_500_000, IsInterlaced: false }]
    },
    {
      Id: "interlaced", Container: "mpegts", SupportsDirectStream: true,
      DirectStreamUrl: "/interlaced.ts", Bitrate: 26_600_000,
      MediaStreams: [{ Type: "Video", Codec: "h264", Height: 1080, BitRate: 26_600_000, IsInterlaced: true }]
    }
  ];
  assert.equal(pickMediaSource(sources).mediaSource?.Id, "progressive");
});

test("mapMediaSourceOption：产出稳定 key、可读 label 和是否有字幕", () => {
  const sources = multiSourceMediaSources();
  const options = mapMediaSourceOptions(sources);
  assert.equal(options.length, 3);
  assert.deepEqual(options.map((o) => o.sourceKey), ["4k|mkv#0", "1080p|mkv#1", "720p|mp4#2"]);
  assert.deepEqual(options.map((o) => o.hasSubtitles), [true, true, false]);
  assert.match(options[0].label, /4K/);
  assert.match(options[0].label, /MKV/);
});

function multiSourceService() {
  const config = {
    baseUrl: "https://emby.example/emby",
    serverId: "server", userId: "user", username: "alice", deviceId: "device"
  };
  const calls = [];
  const ffmpegCreations = [];
  const service = new EmbyService({
    storage: new FakeStorage(config, "token"),
    clientFactory: (settings) => {
      const client = makeClient(settings, calls);
      client.getPlaybackInfo = async (itemId, userId, options) => {
        calls.push({ method: "playbackInfo", itemId, options });
        return { PlaySessionId: "play-session", MediaSources: multiSourceMediaSources() };
      };
      client.getEpisodes = async () => ({ Items: [{ Id: "ep1", Name: "第一集", Type: "Episode", IndexNumber: 1 }] });
      client.getSeasons = async () => ({ Items: [{ Id: "season", Name: "第一季", Type: "Season", IndexNumber: 1 }] });
      return client;
    },
    ffmpegSessionFactory: (options) => {
      ffmpegCreations.push(options);
      return { destroy() {} };
    },
    randomUUIDImpl: () => "pb-multi"
  });
  return { service, calls, ffmpegCreations };
}

test("series.get 返回可选源列表 sourceOptions", async () => {
  const { service } = multiSourceService();
  const result = await service.handleRpc("series.get", { seriesId: "series" });
  assert.equal(Array.isArray(result.sourceOptions), true);
  assert.deepEqual(result.sourceOptions.map((o) => o.sourceKey), ["4k|mkv#0", "1080p|mkv#1", "720p|mp4#2"]);
});

test("playback.open 默认选中带字幕的 4K 源，字幕轨随之带出", async () => {
  const { service } = multiSourceService();
  const opened = await service.handleRpc("playback.open", { itemId: "ep1" });
  assert.equal(opened.mediaSourceId, "src-4k");
  assert.equal(opened.sourceKey, "4k|mkv#0");
  assert.equal(opened.subtitles.length, 1, "4K 源应带出 1 条字幕，字幕按钮才会显示");
});

test("4K HEVC + ASS 只转码音视频，文字字幕独立转换为 WebVTT", async () => {
  const { service, ffmpegCreations } = multiSourceService();
  const opened = await service.handleRpc("playback.open", {
    itemId: "ep1",
    subtitlePreference: { off: false, language: "chi" }
  });
  assert.equal(opened.streamMode, "ffmpeg-fmp4");
  assert.equal(opened.subtitleMode, "external-vtt");
  assert.equal(opened.selectedSubtitleIndex, 2);
  assert.equal(ffmpegCreations.length, 1);
  assert.equal(ffmpegCreations[0].subtitleTrack, null);
  assert.equal(ffmpegCreations[0].subtitleData, null);

  const subtitle = await service.handleRpc("playback.subtitle.load", {
    playbackId: opened.playbackId,
    subtitleStreamIndex: 2
  });
  assert.match(subtitle.data, /^WEBVTT/);
  assert.match(subtitle.data, /ASS 字幕/);
});

test("playback.open 按 preferredSourceKey 切到 1080p mkv 源", async () => {
  const { service } = multiSourceService();
  const opened = await service.handleRpc("playback.open", { itemId: "ep1", preferredSourceKey: "1080p|mkv#1" });
  assert.equal(opened.mediaSourceId, "src-1080");
  assert.equal(opened.sourceKey, "1080p|mkv#1");
  assert.equal(opened.subtitles.length, 1);
});

test("内嵌字幕先返回当前窗口，后台完整字幕完成后跳转直接复用", async () => {
  const config = { baseUrl: "https://emby.example", serverId: "server", userId: "user", deviceId: "device" };
  let finishFull;
  const full = new Promise((resolve) => { finishFull = resolve; });
  let windows = 0;
  const service = new EmbyService({
    storage: new FakeStorage(config, "token"),
    clientFactory: (settings) => {
      const client = makeClient(settings, []);
      client.getPlaybackInfo = async () => ({ PlaySessionId: "play", MediaSources: [{
        Id: "source", Container: "mkv", SupportsDirectStream: true, DirectStreamUrl: "/stream.mkv",
        MediaStreams: [{ Type: "Video", Index: 0, Codec: "hevc" },
          { Type: "Subtitle", Index: 2, Codec: "subrip", IsTextSubtitleStream: true }]
      }] });
      client.openDirectRangeStream = async () => { throw new Error("由测试窗口提取器接管"); };
      client.loadResource = () => full;
      return client;
    },
    ffmpegSessionFactory: () => ({ destroy() {} }),
    subtitleWindowImpl: async () => { windows++; return { data: "WEBVTT\n\n00:01:11.000 --> 00:01:13.000\n当前窗口\n", window: { from: 60, until: 120 } }; }
  });
  try {
    const opened = await service.openPlayback({ itemId: "item" });
    const first = await service.loadSubtitle({ playbackId: opened.playbackId, subtitleStreamIndex: 2, positionTicks: 900000000 });
    assert.deepEqual(first.window, { from: 60, until: 120 });
    assert.equal(windows, 1);
    finishFull({ bytes: new TextEncoder().encode("WEBVTT\n\n00:03:00.000 --> 00:03:03.000\n完整字幕\n") });
    await service.playbacks.get(opened.playbackId).subtitleFullLoader.active.promise;
    const next = await service.loadSubtitle({ playbackId: opened.playbackId, subtitleStreamIndex: 2, positionTicks: 1800000000 });
    assert.equal(next.window, undefined);
    assert.match(next.data, /完整字幕/);
    assert.equal(windows, 1, "完整字幕完成后不应再提取媒体窗口");
  } finally { finishFull({ bytes: new TextEncoder().encode("WEBVTT\n") }); await service.dispose(); }
});
