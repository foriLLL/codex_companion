import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { EmbyService } from "../src/emby-service.mjs";

const ACCESS_TOKEN = "integration-access-token";

class MemoryEmbyStorage {
  constructor() {
    this.config = null;
    this.token = null;
    this.deletedAccounts = [];
  }

  async loadConfig() {
    return this.config ? { ...this.config } : null;
  }

  async saveConfig(config) {
    this.config = { ...config };
    return { ...this.config };
  }

  createDeviceId(existingConfig) {
    return existingConfig?.deviceId ?? "integration-device";
  }

  async readToken(serverId, userId) {
    return this.config?.serverId === serverId && this.config?.userId === userId
      ? this.token
      : null;
  }

  async saveToken(serverId, userId, token) {
    this.token = token;
    this.savedAccount = `${serverId}:${userId}`;
  }

  async deleteToken(serverId, userId) {
    this.deletedAccounts.push(`${serverId}:${userId}`);
    const existed = this.token !== null;
    this.token = null;
    return existed;
  }
}

function sendJson(response, value) {
  const body = JSON.stringify(value);
  response.writeHead(200, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body)
  });
  response.end(body);
}

function sendText(response, body, contentType) {
  response.writeHead(200, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(body)
  });
  response.end(body);
}

async function startMockEmby() {
  const calls = [];
  const firstSegment = Buffer.from([0x47, 0x40, 0x00, 0x10, 0xde, 0xad, 0xbe, 0xef]);
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const rawBody = Buffer.concat(chunks).toString("utf8");
    const origin = `http://${request.headers.host}`;
    const url = new URL(request.url, origin);
    const call = {
      method: request.method,
      url: request.url,
      pathname: url.pathname,
      query: Object.fromEntries(url.searchParams),
      token: request.headers["x-emby-token"],
      authorization: request.headers["x-emby-authorization"],
      body: rawBody ? JSON.parse(rawBody) : null
    };
    calls.push(call);

    if (request.method === "POST" && url.pathname === "/emby/Users/AuthenticateByName") {
      return sendJson(response, {
        ServerId: "server-1",
        AccessToken: ACCESS_TOKEN,
        User: { Id: "user-1" }
      });
    }
    if (request.method === "GET" && url.pathname === "/emby/Users/user-1/Views") {
      return sendJson(response, {
        Items: [{ Id: "view-1", Name: "影视库", Type: "CollectionFolder" }]
      });
    }
    if (request.method === "GET" && url.pathname === "/emby/Users/user-1/Items/Resume") {
      return sendJson(response, {
        Items: [{
          Id: "episode-1",
          Name: "第一集",
          Type: "Episode",
          SeriesId: "series-1",
          SeasonId: "season-1",
          IndexNumber: 1,
          ParentIndexNumber: 1,
          RunTimeTicks: 18_000_000_000,
          ImageTags: { Primary: "episode-image" },
          UserData: { PlaybackPositionTicks: 3_000_000_000, PlayedPercentage: 16.67 }
        }]
      });
    }
    if (request.method === "GET" && url.pathname === "/emby/Users/user-1/Items/Latest") {
      return sendJson(response, [{
        Id: "movie-1",
        Name: "集成测试电影",
        Type: "Movie",
        ProductionYear: 2026,
        RunTimeTicks: 36_000_000_000,
        ImageTags: { Primary: "movie-image" },
        BackdropImageTags: ["movie-backdrop"],
        UserData: { PlaybackPositionTicks: 0, Played: false }
      }]);
    }
    if (request.method === "GET" && url.pathname === "/emby/Users/user-1/Items") {
      return sendJson(response, {
        Items: [{
          Id: "series-1",
          Name: "集成测试剧集",
          Type: "Series",
          ProductionYear: 2025,
          ImageTags: { Primary: "series-image" }
        }]
      });
    }
    if (request.method === "GET" && url.pathname === "/emby/Shows/series-1/Seasons") {
      return sendJson(response, {
        Items: [{ Id: "season-1", Name: "第 1 季", Type: "Season", IndexNumber: 1 }]
      });
    }
    if (request.method === "GET" && url.pathname === "/emby/Shows/series-1/Episodes") {
      return sendJson(response, {
        Items: [{
          Id: "episode-1",
          Name: "第一集",
          Type: "Episode",
          SeriesId: "series-1",
          SeasonId: "season-1",
          IndexNumber: 1,
          ParentIndexNumber: 1,
          RunTimeTicks: 18_000_000_000,
          UserData: { PlaybackPositionTicks: 3_000_000_000 }
        }]
      });
    }
    if (request.method === "POST" && url.pathname === "/emby/Items/movie-1/PlaybackInfo") {
      return sendJson(response, {
        PlaySessionId: "play-session-1",
        MediaSources: [{ Id: "media-source-1", SupportsTranscoding: true }]
      });
    }
    if (request.method === "POST" && [
      "/emby/Sessions/Playing",
      "/emby/Sessions/Playing/Progress",
      "/emby/Sessions/Playing/Stopped"
    ].includes(url.pathname)) {
      response.writeHead(204);
      return response.end();
    }
    if (request.method === "DELETE" && url.pathname === "/emby/Videos/ActiveEncodings") {
      response.writeHead(204);
      return response.end();
    }
    if (request.method === "GET" && url.pathname === "/emby/Videos/movie-1/master.m3u8") {
      return sendText(
        response,
        "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720\n720p.m3u8?api_key=must-be-stripped\n",
        "application/vnd.apple.mpegurl"
      );
    }
    if (request.method === "GET" && url.pathname === "/emby/Videos/movie-1/720p.m3u8") {
      return sendText(
        response,
        "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\nsegment-0001.ts?Token=must-be-stripped\n#EXT-X-ENDLIST\n",
        "application/vnd.apple.mpegurl"
      );
    }
    if (request.method === "GET" && url.pathname === "/emby/Videos/movie-1/segment-0001.ts") {
      response.writeHead(200, {
        "content-type": "video/mp2t",
        "content-length": firstSegment.byteLength
      });
      return response.end(firstSegment);
    }

    sendJson(response, { error: `unexpected ${request.method} ${request.url}` });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}/emby`,
    calls,
    firstSegment,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })
  };
}

function firstMediaUrl(manifest) {
  return manifest.split(/\r?\n/).find((line) => line && !line.startsWith("#"));
}

test("真实 EmbyService/EmbyClient 完成认证、目录、HLS、播放上报与登出链路", async (t) => {
  const mock = await startMockEmby();
  t.after(mock.close);
  const storage = new MemoryEmbyStorage();
  const service = new EmbyService({
    storage,
    // 集成测试对着 127.0.0.1 mock 登录；放行回环主机（登录 SSRF 守卫另有单测覆盖）。
    loginHostGuard: async () => {},
    randomUUIDImpl: () => "playback-1"
  });
  t.after(() => service.dispose());

  const login = await service.handleRpc("auth.login", {
    baseUrl: `${mock.baseUrl}/`,
    username: "alice",
    password: "correct-password"
  }, { targetId: "renderer-1" });
  assert.deepEqual(login, {
    connected: true,
    baseUrl: mock.baseUrl,
    username: "alice",
    serverId: "server-1",
    userId: "user-1"
  });
  assert.equal(storage.savedAccount, "server-1:user-1");
  assert.equal(storage.token, ACCESS_TOKEN);
  assert.equal(storage.config.password, undefined);
  assert.equal(storage.config.accessToken, undefined);

  const home = await service.handleRpc("home.get");
  assert.deepEqual(home.views.map((item) => [item.id, item.name]), [["view-1", "影视库"]]);
  assert.deepEqual(home.resume.map((item) => [item.id, item.type, item.progressPercent]), [
    ["episode-1", "Episode", 16.67]
  ]);
  assert.deepEqual(home.latest.map((item) => [item.id, item.type, item.productionYear]), [
    ["movie-1", "Movie", 2026]
  ]);
  assert.match(home.latest[0].imageUrl, /\/emby\/Items\/movie-1\/Images\/Primary/);

  const search = await service.handleRpc("search", { query: "测试" });
  assert.deepEqual(search.items.map((item) => [item.id, item.name, item.type]), [
    ["series-1", "集成测试剧集", "Series"]
  ]);

  const series = await service.handleRpc("series.get", { seriesId: "series-1" });
  assert.equal(series.seriesId, "series-1");
  assert.equal(series.selectedSeasonId, "season-1");
  assert.deepEqual(series.seasons.map((season) => [season.id, season.indexNumber]), [["season-1", 1]]);
  assert.deepEqual(series.episodes.map((episode) => [episode.id, episode.indexNumber]), [["episode-1", 1]]);

  const playback = await service.handleRpc("playback.open", {
    itemId: "movie-1",
    startPositionSeconds: 6
  }, { targetId: "renderer-1" });
  assert.deepEqual({
    playbackId: playback.playbackId,
    itemId: playback.itemId,
    mediaSourceId: playback.mediaSourceId,
    playSessionId: playback.playSessionId,
    startPositionTicks: playback.startPositionTicks
  }, {
    playbackId: "playback-1",
    itemId: "movie-1",
    mediaSourceId: "media-source-1",
    playSessionId: "play-session-1",
    startPositionTicks: 60_000_000
  });
  assert.equal(new URL(playback.hlsUrl).pathname, "/emby/Videos/movie-1/master.m3u8");
  assert.equal(new URL(playback.hlsUrl).searchParams.has("api_key"), false);
  assert.equal(new URL(playback.hlsUrl).searchParams.has("token"), false);

  // HLS 本地代理端到端：hls.js 可直连 127.0.0.1 代理，manifest 相对路径自然落回
  // 代理路径，令牌被剥离且只通过 header 鉴权。
  assert.ok(playback.hlsProxyUrl, "open 必须返回 hlsProxyUrl");
  assert.equal(new URL(playback.hlsProxyUrl).hostname, "127.0.0.1");
  const proxyMasterResponse = await fetch(playback.hlsProxyUrl);
  assert.equal(proxyMasterResponse.status, 200);
  assert.equal(proxyMasterResponse.headers.get("access-control-allow-origin"), "*");
  assert.match(proxyMasterResponse.headers.get("content-type"), /mpegurl/);
  const proxyMaster = await proxyMasterResponse.text();
  assert.doesNotMatch(proxyMaster, /must-be-stripped|api_key/i);
  const proxyVariantUrl = new URL(firstMediaUrl(proxyMaster), playback.hlsProxyUrl).href;
  assert.equal(new URL(proxyVariantUrl).pathname, "/hls/playback-1/emby/Videos/movie-1/720p.m3u8");

  const proxyVariantResponse = await fetch(proxyVariantUrl);
  assert.equal(proxyVariantResponse.status, 200);
  const proxyVariant = await proxyVariantResponse.text();
  assert.doesNotMatch(proxyVariant, /must-be-stripped|Token=/i);
  const proxySegmentUrl = new URL(firstMediaUrl(proxyVariant), proxyVariantUrl).href;
  const proxySegment = await fetch(proxySegmentUrl);
  assert.equal(proxySegment.status, 200);
  assert.equal(proxySegment.headers.get("content-type"), "video/mp2t");
  assert.deepEqual(Buffer.from(await proxySegment.arrayBuffer()), mock.firstSegment);

  // Codex app:// CSP 禁止 renderer 直接访问 loopback；受控 HLS loader 通过 RPC
  // 读取同源 manifest/分片，回包由 callFunctionOn 参数投递。
  const master = await service.handleRpc("resource.load", {
    url: playback.hlsUrl,
    responseType: "text",
    resourceType: "hls"
  });
  assert.equal(master.encoding, "utf8");
  assert.equal(master.contentType, "application/vnd.apple.mpegurl");
  assert.doesNotMatch(master.data, /must-be-stripped|api_key/i);
  const variantUrl = firstMediaUrl(master.data);
  assert.equal(new URL(variantUrl).pathname, "/emby/Videos/movie-1/720p.m3u8");

  const variant = await service.handleRpc("resource.load", {
    url: variantUrl,
    responseType: "text",
    resourceType: "hls"
  });
  assert.doesNotMatch(variant.data, /must-be-stripped|Token=/i);
  const segmentUrl = firstMediaUrl(variant.data);
  assert.equal(new URL(segmentUrl).pathname, "/emby/Videos/movie-1/segment-0001.ts");

  const segment = await service.handleRpc("resource.load", {
    url: segmentUrl,
    resourceType: "hls"
  });
  assert.equal(segment.encoding, "base64");
  assert.equal(segment.contentType, "video/mp2t");
  assert.deepEqual(Buffer.from(segment.data, "base64"), mock.firstSegment);

  const progress = await service.handleRpc("playback.progress", {
    playbackId: playback.playbackId,
    positionSeconds: 65,
    isPaused: true,
    event: "pause"
  });
  assert.deepEqual(progress, { playbackId: "playback-1", positionTicks: 650_000_000 });
  const progressCall = mock.calls.find((call) => call.pathname === "/emby/Sessions/Playing/Progress");
  assert.equal(progressCall.body.EventName, "Pause");
  assert.equal(progressCall.body.IsPaused, true);
  assert.equal(progressCall.body.PositionTicks, 650_000_000);

  const stopped = await service.handleRpc("playback.stop", {
    playbackId: playback.playbackId,
    positionSeconds: 66
  });
  assert.deepEqual(stopped, { playbackId: "playback-1", stopped: true });
  const stoppedCall = mock.calls.find((call) => call.pathname === "/emby/Sessions/Playing/Stopped");
  assert.equal(stoppedCall.body.PositionTicks, 660_000_000);
  const encodingCall = mock.calls.find((call) => call.pathname === "/emby/Videos/ActiveEncodings");
  assert.equal(encodingCall.method, "DELETE");
  assert.deepEqual(encodingCall.query, {
    DeviceId: "integration-device",
    PlaySessionId: "play-session-1"
  });

  const logout = await service.handleRpc("auth.logout");
  assert.equal(logout.connected, false);
  assert.equal(logout.baseUrl, mock.baseUrl);
  assert.equal(storage.token, null);
  assert.deepEqual(storage.deletedAccounts, ["server-1:user-1"]);

  const authCall = mock.calls.find((call) => call.pathname === "/emby/Users/AuthenticateByName");
  assert.deepEqual(authCall.body, { Username: "alice", Pw: "correct-password" });
  assert.equal(authCall.token, undefined);
  assert.match(authCall.authorization, /DeviceId="integration-device"/);
  for (const call of mock.calls) {
    assert.doesNotMatch(call.url, new RegExp(ACCESS_TOKEN));
    for (const key of Object.keys(call.query)) {
      assert.equal(["api_key", "apikey", "access_token", "token", "x-emby-token"].includes(key.toLowerCase()), false);
    }
    if (call !== authCall) assert.equal(call.token, ACCESS_TOKEN, `${call.method} ${call.url} 缺少认证 Header`);
  }
});
