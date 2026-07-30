import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import {
  EMBY_USER_AGENT,
  EmbyClient,
  assertLoginHostAllowed,
  normalizeServerUrl,
  redactSensitive,
  resolveExternalMediaAddress,
  sanitizeDirectStreamUrl,
  sanitizeHlsManifest,
  validateExternalMediaUrl,
  validateSameOriginResource
} from "../src/emby-client.mjs";

async function listen(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

function json(response, value, status = 200) {
  const body = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  response.end(body);
}

test("normalizeServerUrl 保留 /emby 基础路径并拒绝凭证", () => {
  assert.equal(normalizeServerUrl(" HTTPS://Example.COM:443//emby/// "), "https://example.com/emby");
  assert.throws(() => normalizeServerUrl("ftp://example.com"), { code: "INVALID_SERVER_URL" });
  assert.throws(() => normalizeServerUrl("https://user:pass@example.com"), { code: "INVALID_SERVER_URL" });
  assert.throws(() => normalizeServerUrl("https://example.com?api_key=secret"), { code: "INVALID_SERVER_URL" });
});

test("assertLoginHostAllowed 拦截回环/链路本地/元数据，但放行 LAN 私网与公网", async () => {
  const never = async () => { throw new Error("公网/IP 主机不应触发 DNS 解析"); };
  // 字面 IP：回环、云元数据、通配、组播、IPv6 回环 → 拒绝。
  for (const host of [
    "http://127.0.0.1",
    "http://127.0.0.1:8096",
    "http://169.254.169.254",
    "http://0.0.0.0",
    "http://[::1]",
    "https://224.0.0.1"
  ]) {
    await assert.rejects(assertLoginHostAllowed(host, { dnsLookup: never }), { code: "UNSAFE_SERVER_URL" }, host);
  }
  // localhost 主机名同样拒绝。
  await assert.rejects(assertLoginHostAllowed("http://localhost:8096", { dnsLookup: never }), { code: "UNSAFE_SERVER_URL" });
  await assert.rejects(assertLoginHostAllowed("http://app.localhost", { dnsLookup: never }), { code: "UNSAFE_SERVER_URL" });
  // 自建 Emby 常驻的 LAN 私网 IP → 放行（不做 DNS）。
  for (const host of ["http://192.168.1.10:8096", "http://10.0.0.5", "http://172.16.9.9"]) {
    await assert.doesNotReject(assertLoginHostAllowed(host, { dnsLookup: never }), host);
  }
  // 主机名解析到内网 LAN → 放行；解析到回环/元数据 → 拒绝。
  await assert.doesNotReject(assertLoginHostAllowed("https://emby.example", {
    dnsLookup: async () => [{ address: "192.168.1.20", family: 4 }]
  }));
  await assert.rejects(assertLoginHostAllowed("https://rebind.example", {
    dnsLookup: async () => [{ address: "127.0.0.1", family: 4 }]
  }), { code: "UNSAFE_SERVER_URL" });
  await assert.rejects(assertLoginHostAllowed("https://meta.example", {
    dnsLookup: async () => [{ address: "169.254.169.254", family: 4 }]
  }), { code: "UNSAFE_SERVER_URL" });
});

test("REST client 使用认证 Header，保留基础路径并映射核心目录接口", async (t) => {
  const calls = [];
  const mock = await listen(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    calls.push({ method: request.method, url: request.url, headers: request.headers, body });
    if (request.url === "/emby/Users/AuthenticateByName") {
      return json(response, { ServerId: "server", AccessToken: "token", User: { Id: "user" } });
    }
    if (request.url.startsWith("/emby/Users/user/Views")) return json(response, { Items: [{ Id: "view" }] });
    if (request.url.startsWith("/emby/Users/user/Items/Resume")) return json(response, { Items: [] });
    if (request.url.startsWith("/emby/Users/user/Items/Latest")) return json(response, []);
    if (request.url.startsWith("/emby/Users/user/Items?")) return json(response, { Items: [] });
    if (request.url.startsWith("/emby/Shows/series/Seasons")) return json(response, { Items: [] });
    if (request.url.startsWith("/emby/Shows/series/Episodes")) return json(response, { Items: [] });
    response.writeHead(404).end();
  });
  t.after(mock.close);

  const anonymous = new EmbyClient({ baseUrl: `${mock.baseUrl}/emby/`, deviceId: "device" });
  await anonymous.authenticate("alice", "password");
  const client = new EmbyClient({ baseUrl: `${mock.baseUrl}/emby`, deviceId: "device", token: "token" });
  await Promise.all([
    client.getViews("user"),
    client.getResume("user"),
    client.getLatest("user"),
    client.getLibraryItems("user", "view", { startIndex: 60, limit: 25 }),
    client.search("user", "剧集"),
    client.getSeasons("series", "user"),
    client.getEpisodes("series", "user", { seasonId: "season" })
  ]);

  assert.equal(JSON.parse(calls[0].body).Pw, "password");
  assert.equal(calls[0].headers["x-emby-token"], undefined);
  assert.equal(calls[0].headers["user-agent"], EMBY_USER_AGENT);
  assert.match(calls[0].headers["x-emby-authorization"], /DeviceId="device"/);
  for (const call of calls.slice(1)) {
    assert.equal(call.headers["x-emby-token"], "token");
    assert.equal(call.headers["user-agent"], EMBY_USER_AGENT);
  }
  const searchCall = calls.find((call) => call.url.includes("SearchTerm=%E5%89%A7%E9%9B%86"));
  assert.ok(searchCall);
  assert.match(searchCall.url, /EnableTotalRecordCount=false/);
  assert.match(searchCall.url, /ImageTypeLimit=1/);
  assert.match(searchCall.url, /GroupProgramsBySeries=true/);
  assert.doesNotMatch(searchCall.url, /IncludeItemTypes=/);
  assert.ok(calls.some((call) => call.url.includes("SeasonId=season")));
  const libraryCall = calls.find((call) => call.url.includes("ParentId=view"));
  assert.ok(libraryCall);
  assert.match(libraryCall.url, /StartIndex=60/);
  assert.match(libraryCall.url, /Limit=25/);
  assert.match(libraryCall.url, /Recursive=false/);
});

test("认证 401 映射为可操作的用户名或密码错误", async (t) => {
  const mock = await listen((_request, response) => response.writeHead(401).end());
  t.after(mock.close);
  const client = new EmbyClient({ baseUrl: mock.baseUrl, deviceId: "device" });

  await assert.rejects(client.authenticate("alice", "wrong-password"), {
    code: "INVALID_CREDENTIALS",
    message: /用户名或密码/
  });
});

test("跨源重定向在第二个 origin 收到请求前被拒绝，Token 不泄漏", async (t) => {
  let evilRequests = 0;
  const evil = await listen((_request, response) => {
    evilRequests += 1;
    response.end("should not happen");
  });
  const source = await listen((_request, response) => {
    response.writeHead(302, { location: `${evil.baseUrl}/stolen` });
    response.end();
  });
  t.after(source.close);
  t.after(evil.close);

  const client = new EmbyClient({ baseUrl: source.baseUrl, deviceId: "device", token: "top-secret" });
  await assert.rejects(client.request("redirect", { responseType: "text" }), { code: "UNSAFE_RESOURCE_URL" });
  assert.equal(evilRequests, 0);
});

test("同源重定向有限跟随且保留认证", async (t) => {
  let finalToken;
  const mock = await listen((request, response) => {
    if (request.url === "/first") {
      response.writeHead(307, { location: "/final" });
      return response.end();
    }
    finalToken = request.headers["x-emby-token"];
    response.end("ok");
  });
  t.after(mock.close);
  const client = new EmbyClient({ baseUrl: mock.baseUrl, deviceId: "device", token: "token" });
  const result = await client.request("first", { responseType: "text" });
  assert.equal(result.text, "ok");
  assert.equal(finalToken, "token");
});

test("HLS 清单移除令牌并把后续地址约束在 Emby origin", async () => {
  const clean = sanitizeHlsManifest(
    "#EXTM3U\nvariant.m3u8?api_key=secret&x=1\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin?Token=secret\"",
    "https://emby.example/emby/Videos/1/master.m3u8",
    "https://emby.example/emby"
  );
  assert.doesNotMatch(clean, /secret|api_key|Token=/i);
  assert.match(clean, /https:\/\/emby\.example\/emby\/Videos\/1\/variant\.m3u8\?x=1/);
  assert.throws(
    () => sanitizeHlsManifest("#EXTM3U\nhttps://evil.example/segment.ts", "https://emby.example/master.m3u8", "https://emby.example"),
    { code: "UNSAFE_RESOURCE_URL" }
  );
  assert.throws(() => validateSameOriginResource("https://emby.example", "https://emby.example/file?api_key=x"), {
    code: "UNSAFE_RESOURCE_URL"
  });
});

test("直连媒体 Range 只在 Emby origin 携带 Token，CDN 重定向不泄漏凭证", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const requestUrl = new URL(url);
    const headers = Object.fromEntries(new Headers(options.headers));
    calls.push({ url: requestUrl.href, headers, redirect: options.redirect });
    if (requestUrl.hostname === "emby.example") {
      assert.equal(requestUrl.searchParams.has("api_key"), false);
      return new Response(null, {
        status: 302,
        headers: { location: "https://cdn-a.example/video.mp4?auth_key=signed" }
      });
    }
    if (requestUrl.hostname === "cdn-a.example") {
      return new Response(null, {
        status: 307,
        headers: { location: "https://cdn-b.example/video.mp4?auth_key=signed-again" }
      });
    }
    return new Response(Uint8Array.from([1, 2, 3, 4]), {
      status: 206,
      headers: {
        "content-range": "bytes 0-3/100",
        "content-length": "4",
        "content-type": "video/mp4"
      }
    });
  };
  const client = new EmbyClient({
    baseUrl: "https://emby.example/emby",
    deviceId: "device",
    token: "top-secret",
    fetchImpl,
    dnsLookup: async () => [{ address: "203.0.113.10", family: 4 }]
  });

  const result = await client.loadDirectRange(
    "https://emby.example/emby/Videos/1/stream.mp4?api_key=leak-me",
    { start: 0, end: 3 }
  );

  assert.deepEqual([...result.bytes], [1, 2, 3, 4]);
  assert.equal(result.total, 100);
  assert.match(result.resolvedUrl, /^https:\/\/cdn-b\.example\//);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].headers["x-emby-token"], "top-secret");
  assert.equal(calls[0].headers.range, "bytes=0-3");
  assert.equal(calls[0].headers["user-agent"], EMBY_USER_AGENT);
  for (const call of calls.slice(1)) {
    assert.equal(call.headers["x-emby-token"], undefined);
    assert.equal(call.headers["x-emby-authorization"], undefined);
    assert.equal(call.headers["user-agent"], EMBY_USER_AGENT);
    assert.equal(call.headers.range, "bytes=0-3");
    assert.equal(call.redirect, "manual");
  }
});

test("持续 Range 在首批字节到达后立即返回，并且 CDN 请求不携带 Emby Token", async () => {
  const calls = [];
  let releaseTail;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(Uint8Array.of(1, 2));
      releaseTail = () => {
        controller.enqueue(Uint8Array.of(3, 4));
        controller.close();
      };
    }
  });
  const fetchImpl = async (url, options) => {
    const requestUrl = new URL(url);
    const headers = Object.fromEntries(new Headers(options.headers));
    calls.push({ url: requestUrl.href, headers });
    if (requestUrl.hostname === "emby.example") {
      return new Response(null, {
        status: 302,
        headers: { location: "https://cdn.example/video.mkv?signed=yes" }
      });
    }
    return new Response(body, {
      status: 206,
      headers: {
        "content-range": "bytes 0-3/4",
        "content-length": "4",
        "content-type": "video/x-matroska"
      }
    });
  };
  const client = new EmbyClient({
    baseUrl: "https://emby.example/emby",
    deviceId: "device",
    token: "top-secret",
    fetchImpl,
    dnsLookup: async () => [{ address: "203.0.113.10", family: 4 }]
  });

  const stream = await client.openDirectRangeStream("/Videos/1/stream.mkv", { start: 0 });
  const reader = stream.body.getReader();
  assert.deepEqual([...((await reader.read()).value)], [1, 2]);
  assert.equal(stream.total, 4);
  assert.equal(stream.resolvedUrl, "https://cdn.example/video.mkv?signed=yes");
  assert.equal(calls[0].headers["x-emby-token"], "top-secret");
  assert.equal(calls[0].headers["user-agent"], EMBY_USER_AGENT);
  assert.equal(calls[1].headers["x-emby-token"], undefined);
  assert.equal(calls[1].headers["user-agent"], EMBY_USER_AGENT);
  assert.equal(calls[1].headers.range, "bytes=0-");

  releaseTail();
  assert.deepEqual([...((await reader.read()).value)], [3, 4]);
  assert.equal((await reader.read()).done, true);
});

test("同源媒体流附带带 bodyTimeout 的 dispatcher，自定义 fetchImpl 不受影响", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), dispatcher: options.dispatcher });
    return new Response(Uint8Array.from([1, 2, 3, 4]), {
      status: 206,
      headers: {
        "content-range": "bytes 0-3/4",
        "content-length": "4",
        "content-type": "video/mp4"
      }
    });
  };
  // 注入自定义 fetchImpl 时不应附加 dispatcher（保持测试可控）。
  const custom = new EmbyClient({
    baseUrl: "https://emby.example/emby",
    deviceId: "device",
    token: "token",
    fetchImpl
  });
  assert.equal(custom.sameOriginStreamDispatcher, null);
  const stream = await custom.openDirectRangeStream("/Videos/1/stream.mp4", { start: 0 });
  await stream.body.getReader().read();
  assert.equal(calls[0].dispatcher, undefined, "自定义 fetchImpl 不应收到 dispatcher");

  // 使用默认全局 fetch 时应创建一个带超时的同源 dispatcher，并在 withToken 时复用同一实例。
  const client = new EmbyClient({ baseUrl: "https://emby.example/emby", deviceId: "device" });
  assert.notEqual(client.sameOriginStreamDispatcher, null, "默认 fetch 应启用同源超时 dispatcher");
  const retokened = client.withToken("new-token");
  assert.equal(retokened.sameOriginStreamDispatcher, client.sameOriginStreamDispatcher);
  await client.sameOriginStreamDispatcher.close();
});

test("直连媒体拒绝不安全 CDN、内网 DNS 和超大 Range", async () => {
  assert.equal(
    sanitizeDirectStreamUrl(
      "https://emby.example/emby",
      "/emby/Videos/1/stream.mp4?api_key=secret&MediaSourceId=source"
    ),
    "https://emby.example/emby/Videos/1/stream.mp4?MediaSourceId=source"
  );
  assert.throws(
    () => sanitizeDirectStreamUrl("https://emby.example", "https://evil.example/video.mp4"),
    { code: "UNSAFE_RESOURCE_URL" }
  );
  await assert.rejects(validateExternalMediaUrl("http://cdn.example/video.mp4"), {
    code: "UNSAFE_MEDIA_REDIRECT"
  });
  await assert.rejects(validateExternalMediaUrl("https://cdn.example/video.mp4", {
    dnsLookup: async () => [{ address: "192.168.1.5", family: 4 }]
  }), { code: "UNSAFE_MEDIA_REDIRECT" });
  await assert.rejects(validateExternalMediaUrl("https://[ff02::1]/video.mp4"), {
    code: "UNSAFE_MEDIA_REDIRECT"
  });
  assert.deepEqual(await resolveExternalMediaAddress("cdn.example", {
    dnsLookup: async () => [
      { address: "2001:db8::10", family: 6 },
      { address: "203.0.113.10", family: 4 }
    ]
  }), { address: "203.0.113.10", family: 4 });
  await assert.rejects(resolveExternalMediaAddress("cdn.example", {
    dnsLookup: async () => [
      { address: "203.0.113.10", family: 4 },
      { address: "127.0.0.1", family: 4 }
    ]
  }), { code: "UNSAFE_MEDIA_REDIRECT" });

  const client = new EmbyClient({ baseUrl: "https://emby.example", deviceId: "device" });
  await assert.rejects(client.loadDirectRange("/Videos/1/stream.mp4", {
    start: 0,
    end: 2 * 1024 * 1024
  }), { code: "RANGE_TOO_LARGE" });
});

test("外部 Range 优先走 keep-alive 流传输，且外部 URL 校验按 href 缓存", async () => {
  const transportCalls = [];
  let dnsCalls = 0;
  let fetchCalls = 0;
  const client = new EmbyClient({
    baseUrl: "https://emby.example/emby",
    deviceId: "device",
    token: "top-secret",
    fetchImpl: async (url, options) => {
      fetchCalls += 1;
      return globalThis.fetch(url, options);
    },
    dnsLookup: async () => {
      dnsCalls += 1;
      return [{ address: "203.0.113.10", family: 4 }];
    },
    externalStreamTransport: {
      request: async (url, options) => {
        transportCalls.push({ url: String(url), headers: options?.headers ?? {} });
        return new Response(Uint8Array.from([1, 2, 3, 4]), {
          status: 206,
          headers: {
            "content-range": "bytes 0-3/100",
            "content-length": "4",
            "content-type": "video/mp4"
          }
        });
      }
    }
  });

  const resolvedUrl = "https://cdn-a.example/video.mp4?auth_key=signed";
  const input = "https://emby.example/emby/Videos/1/stream.mp4";
  const first = await client.loadDirectRange(input, { start: 0, end: 3, resolvedUrl });
  const second = await client.loadDirectRange(input, { start: 0, end: 3, resolvedUrl });

  assert.deepEqual([...first.bytes], [1, 2, 3, 4]);
  assert.deepEqual([...second.bytes], [1, 2, 3, 4]);
  // 两个 Range 都走流传输（不再 spawn curl / 不做 HEAD 预检），token 不外泄。
  assert.equal(transportCalls.length, 2);
  assert.equal(fetchCalls, 0);
  for (const call of transportCalls) {
    assert.equal(call.url, resolvedUrl);
    assert.equal(call.headers["X-Emby-Token"], undefined);
    assert.equal(call.headers.Range, "bytes=0-3");
  }
  // 第二次相同 resolvedUrl 命中校验缓存，DNS 只解析一次。
  assert.equal(dnsCalls, 1);
});

test("资源读取执行大小上限并支持 AbortSignal", async (t) => {
  const mock = await listen((_request, response) => {
    response.writeHead(200, { "content-length": "9", "content-type": "application/octet-stream" });
    response.end("123456789");
  });
  t.after(mock.close);
  const client = new EmbyClient({ baseUrl: mock.baseUrl, deviceId: "device", token: "token" });
  await assert.rejects(client.loadResource(`${mock.baseUrl}/large`, { maxBytes: 8 }), { code: "RESPONSE_TOO_LARGE" });

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(client.loadResource(`${mock.baseUrl}/large`, { signal: controller.signal }), { code: "CANCELLED" });
});

test("HLS URL 限制 720p 且播放 check-in 使用标准会话字段", async () => {
  const calls = [];
  const client = new EmbyClient({
    baseUrl: "https://emby.example/emby",
    deviceId: "device",
    token: "token",
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return new Response(null, { status: 204 });
    }
  });
  const session = {
    userId: "user",
    itemId: "item",
    mediaSourceId: "media",
    playSessionId: "play",
    positionTicks: 12_000_000,
    isPaused: true,
    subtitleMode: "burn-in",
    subtitleStreamIndex: 7
  };
  const hlsUrl = new URL(client.hlsUrl("item", session));
  assert.equal(hlsUrl.searchParams.get("MaxWidth"), "1280");
  assert.equal(hlsUrl.searchParams.get("MaxHeight"), "720");
  assert.equal(hlsUrl.searchParams.get("SubtitleStreamIndex"), "7");
  assert.equal(hlsUrl.searchParams.get("SubtitleMethod"), "Encode");
  assert.equal(hlsUrl.searchParams.has("api_key"), false);
  const subtitleUrl = new URL(client.subtitleUrl("item", "media", 7));
  assert.equal(subtitleUrl.pathname, "/emby/Videos/item/media/Subtitles/7/Stream.vtt");
  assert.equal(subtitleUrl.searchParams.get("StartPositionTicks"), "0");
  assert.throws(() => client.subtitleUrl("item", "media", -1), { code: "INVALID_SUBTITLE_INDEX" });

  await client.reportPlaybackStarted(session);
  await client.reportPlaybackProgress(session);
  await client.reportPlaybackStopped(session);
  await client.stopActiveEncoding("play");
  assert.deepEqual(calls.map((call) => [new URL(call.url).pathname, call.options.method]), [
    ["/emby/Sessions/Playing", "POST"],
    ["/emby/Sessions/Playing/Progress", "POST"],
    ["/emby/Sessions/Playing/Stopped", "POST"],
    ["/emby/Videos/ActiveEncodings", "DELETE"]
  ]);
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    ItemId: "item",
    MediaSourceId: "media",
    PlaySessionId: "play",
    PositionTicks: 12_000_000,
    IsPaused: true,
    IsMuted: false,
    VolumeLevel: 100,
    PlayMethod: "Transcode",
    CanSeek: true,
    EventName: "TimeUpdate",
    SubtitleStreamIndex: 7
  });
});

test("嵌套 TLS 证书错误被明确分类，自签名不会被静默接受", async () => {
  const failure = Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("self-signed certificate"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" })
  });
  const client = new EmbyClient({
    baseUrl: "https://emby.example",
    deviceId: "device",
    fetchImpl: async () => { throw failure; }
  });
  await assert.rejects(client.getViews("user"), {
    code: "TLS_ERROR",
    message: /不支持自签名证书/
  });
});

test("媒体桥最多并发四个资源请求", async () => {
  let active = 0;
  let maximum = 0;
  const releases = [];
  const client = new EmbyClient({
    baseUrl: "https://emby.example",
    deviceId: "device",
    token: "token",
    resourceConcurrency: 4,
    fetchImpl: async () => new Promise((resolve) => {
      active += 1;
      maximum = Math.max(maximum, active);
      releases.push(() => {
        active -= 1;
        resolve(new Response(Uint8Array.of(1), { status: 200 }));
      });
    })
  });
  const pending = Array.from({ length: 6 }, (_value, index) => client.loadResource(`https://emby.example/segment-${index}.ts`));
  while (releases.length < 4) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(active, 4);
  releases.splice(0, 4).forEach((release) => release());
  while (releases.length < 2) await new Promise((resolve) => setImmediate(resolve));
  releases.splice(0, 2).forEach((release) => release());
  await Promise.all(pending);
  assert.equal(maximum, 4);
});

test("日志脱敏覆盖 Header、URL、JSON 密码和显式秘密", () => {
  const redacted = redactSensitive(
    'X-Emby-Token: abc https://x.test/a?api_key=def {"Password":"ghi"} hidden',
    ["hidden"]
  );
  assert.doesNotMatch(redacted, /abc|def|ghi|hidden/);
  assert.match(redacted, /\[REDACTED\]/);
});
