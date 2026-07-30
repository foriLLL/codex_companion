import assert from "node:assert/strict";
import { get as httpGet } from "node:http";
import test from "node:test";
import { HlsProxy } from "../src/hls-proxy.mjs";

const BASE_URL = "https://emby.example/emby";
const PATH_PREFIX = "/emby/Videos/movie/";

function textResponse(text, { status = 200, contentType = "application/vnd.apple.mpegurl", headers = {} } = {}) {
  return new Response(text, {
    status,
    headers: { "content-type": contentType, ...headers }
  });
}

async function startProxy({ upstream, randomUUIDImpl, ...options } = {}) {
  const calls = [];
  let counter = 0;
  const proxy = new HlsProxy({
    upstream: upstream ?? (async (args) => {
      calls.push(args);
      return textResponse("#EXTM3U\n");
    }),
    randomUUIDImpl: randomUUIDImpl ?? (() => `secret-${counter += 1}`),
    ...options
  });
  const origin = await proxy.start();
  return { proxy, origin, calls };
}

// 原始路径请求（绕过 undici fetch 的 URL 归一化），用于 %2e%2e 之类的点段注入用例。
function rawGet(origin, path) {
  return new Promise((resolve, reject) => {
    const { port } = new URL(origin);
    const request = httpGet({ hostname: "127.0.0.1", port: Number(port), path }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks)
      }));
    });
    request.on("error", reject);
  });
}

test("秘密路径收口：未注册 secret / 错误路径 404，非 GET/HEAD 405", async (t) => {
  const { proxy, origin, calls } = await startProxy();
  t.after(() => proxy.close());
  proxy.register({ token: "token-1", baseUrl: BASE_URL, pathPrefix: PATH_PREFIX });

  for (const path of [
    "/",
    "/hls/",
    "/hls/wrong-secret/emby/Videos/movie/master.m3u8",
    "/hls/secret-1",
    "/media/whatever"
  ]) {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, 404, path);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    await response.body?.cancel();
  }

  const posted = await fetch(`${origin}/hls/secret-1/emby/Videos/movie/master.m3u8`, { method: "POST" });
  assert.equal(posted.status, 405);
  await posted.body?.cancel();
  assert.equal(calls.length, 0);
});

test("路径前缀收口与 .. 拒绝：越界路径 403 且不触达上游", async (t) => {
  const { proxy, origin, calls } = await startProxy();
  t.after(() => proxy.close());
  proxy.register({ token: "token-1", baseUrl: BASE_URL, pathPrefix: PATH_PREFIX });

  const allowed = await fetch(`${origin}/hls/secret-1/emby/Videos/movie/master.m3u8?MediaSourceId=1`);
  assert.equal(allowed.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).pathname, "/emby/Videos/movie/master.m3u8");
  assert.equal(new URL(calls[0].url).searchParams.get("MediaSourceId"), "1");

  for (const path of [
    "/hls/secret-1/emby/Videos/other/master.m3u8",
    "/hls/secret-1/emby/System/Info",
    "/hls/secret-1/emby/Videos/movie",
    "/hls/secret-1//emby.example.evil/Videos/movie/x.ts"
  ]) {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, 403, path);
    await response.body?.cancel();
  }
  // 原始路径里的点段（含 %2e 变体）：显式 403，不依赖 URL 归一化兜底。
  for (const path of [
    "/hls/secret-1/emby/Videos/movie/%2e%2e/System/Info",
    "/hls/secret-1/emby/Videos/movie/%2E%2e/%2e%2E/System/Info"
  ]) {
    const response = await rawGet(origin, path);
    assert.equal(response.status, 403, path);
  }
  assert.equal(calls.length, 1, "越界请求不得触达上游");
});

test("同源请求注入 X-Emby-Token，且 token 绝不出现在 URL", async (t) => {
  const { proxy, origin, calls } = await startProxy({
    upstream: async (args) => {
      calls.push(args);
      return new Response("segment-bytes", {
        status: 200,
        headers: { "content-type": "video/mp2t" }
      });
    }
  });
  t.after(() => proxy.close());
  const session = proxy.register({ token: "super-secret-token", baseUrl: BASE_URL, pathPrefix: PATH_PREFIX });
  const proxied = session.urlFor(`${BASE_URL}/Videos/movie/segment-1.ts?MediaSourceId=1`);

  assert.equal(proxied.startsWith(`${origin}/hls/secret-1/emby/Videos/movie/segment-1.ts`), true);
  assert.doesNotMatch(proxied, /super-secret-token/);

  const response = await fetch(proxied);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "segment-bytes");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers["X-Emby-Token"], "super-secret-token");
  assert.doesNotMatch(calls[0].url, /super-secret-token/);
  for (const key of new URL(calls[0].url).searchParams.keys()) {
    assert.equal(["api_key", "apikey", "access_token", "token", "x-emby-token"].includes(key.toLowerCase()), false);
  }
});

test("Range 请求透传上游 206 与关键响应头", async (t) => {
  const payload = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const { proxy, origin, calls } = await startProxy({
    upstream: async (args) => {
      calls.push(args);
      return new Response(payload.subarray(2, 6), {
        status: 206,
        headers: {
          "content-type": "video/mp2t",
          "content-range": "bytes 2-5/10",
          "accept-ranges": "bytes",
          "content-length": "4"
        }
      });
    }
  });
  t.after(() => proxy.close());
  const session = proxy.register({ token: "token-1", baseUrl: BASE_URL, pathPrefix: PATH_PREFIX });

  const response = await fetch(session.urlFor(`${BASE_URL}/Videos/movie/segment-1.ts`), {
    headers: { Range: "bytes=2-5" }
  });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), "bytes 2-5/10");
  assert.equal(response.headers.get("accept-ranges"), "bytes");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), payload.subarray(2, 6));
  assert.equal(calls[0].headers.Range, "bytes=2-5");
});

test("m3u8 重写：相对路径保持不变、同源绝对路径改代理形式、跨源改 @ext", async (t) => {
  const manifest = [
    "#EXTM3U",
    '#EXT-X-KEY:METHOD=AES-128,URI="https://emby.example/emby/Videos/movie/key.bin?api_key=abc",IV=0x1',
    "#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720",
    "720p.m3u8?api_key=must-strip&foo=1",
    "#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=5,URI=\"../movie/trick.m3u8\"",
    "https://emby.example/emby/Videos/movie/abs.m3u8?MediaSourceId=1&token=xyz",
    "https://cdn.example.com/seg/v.m3u8?sig=1"
  ].join("\n");
  const { proxy, origin } = await startProxy({
    upstream: async () => textResponse(manifest)
  });
  t.after(() => proxy.close());
  const session = proxy.register({ token: "token-1", baseUrl: BASE_URL, pathPrefix: PATH_PREFIX });

  const response = await fetch(session.urlFor(`${BASE_URL}/Videos/movie/master.m3u8`));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /mpegurl/);
  const rewritten = await response.text();
  assert.equal(response.headers.get("content-length"), String(Buffer.byteLength(rewritten)));
  const lines = rewritten.split("\n");

  // 相对路径保持相对形态，仅剥离令牌查询参数
  assert.ok(lines.includes("720p.m3u8?foo=1"), rewritten);
  // 同源绝对 URL（含 #EXT-X-KEY 的 URI）改写为代理路径形式并剥离令牌
  assert.ok(lines.some((line) => line.includes('URI="/hls/secret-1/emby/Videos/movie/key.bin"')), rewritten);
  assert.ok(lines.includes("/hls/secret-1/emby/Videos/movie/abs.m3u8?MediaSourceId=1"), rewritten);
  // 注释里的相对 URI 同样保持相对（../ 由 URL 解析自然落回代理路径）
  assert.ok(lines.some((line) => line.includes('URI="../movie/trick.m3u8"')), rewritten);
  // 跨源绝对 URL 改写为 @ext 形式
  const extLine = lines.find((line) => line.startsWith("/hls/secret-1/@ext/"));
  assert.ok(extLine, rewritten);
  const absolute = Buffer.from(extLine.slice("/hls/secret-1/@ext/".length), "base64url").toString("utf8");
  assert.equal(absolute, "https://cdn.example.com/seg/v.m3u8?sig=1");
  assert.doesNotMatch(rewritten, /api_key=must-strip|token=xyz|api_key=abc/);
});

test("content-type 不含 mpegurl 但 body 以 #EXTM3U 开头时也按清单重写", async (t) => {
  const { proxy, origin } = await startProxy({
    upstream: async () => textResponse("#EXTM3U\nabs.ts\n", { contentType: "application/octet-stream" })
  });
  t.after(() => proxy.close());
  const session = proxy.register({ token: "token-1", baseUrl: BASE_URL, pathPrefix: PATH_PREFIX });
  const response = await fetch(session.urlFor(`${BASE_URL}/Videos/movie/master.m3u8`));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "#EXTM3U\nabs.ts\n");
});

test("@ext 跨源：非 HTTPS / 本机 / 私网一律 403 且不触达上游", async (t) => {
  const { proxy, calls } = await startProxy();
  t.after(() => proxy.close());
  const session = proxy.register({ token: "token-1", baseUrl: BASE_URL, pathPrefix: PATH_PREFIX });
  const origin = `http://127.0.0.1:${proxy.port}`;

  for (const target of [
    "http://cdn.example.com/segment.ts",
    "https://127.0.0.1/segment.ts",
    "https://10.0.0.8/segment.ts",
    "https://localhost/segment.ts",
    "https://user:pass@cdn.example.com/segment.ts"
  ]) {
    const response = await fetch(session.urlFor(target));
    assert.equal(response.status, 403, target);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    await response.body?.cancel();
  }
  assert.equal(calls.length, 0);
});

test("@ext 跨源成功：SSRF 校验通过后不带 token 转发", async (t) => {
  const { proxy, origin, calls } = await startProxy({
    dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
    upstream: async (args) => {
      calls.push(args);
      return new Response("cdn-bytes", { status: 200, headers: { "content-type": "video/mp2t" } });
    }
  });
  t.after(() => proxy.close());
  const session = proxy.register({ token: "super-secret-token", baseUrl: BASE_URL, pathPrefix: PATH_PREFIX });

  const response = await fetch(session.urlFor("https://cdn.example.com/segment.ts?sig=1"));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "cdn-bytes");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://cdn.example.com/segment.ts?sig=1");
  assert.equal(calls[0].headers["X-Emby-Token"], undefined);
  assert.match(session.urlFor("https://cdn.example.com/segment.ts?sig=1"), new RegExp(`^${origin}/hls/secret-1/@ext/`));
});

test("CORS：正常/错误响应带 ACAO，OPTIONS 预检 204 并回显请求头", async (t) => {
  const { proxy, origin } = await startProxy();
  t.after(() => proxy.close());
  const session = proxy.register({ token: "token-1", baseUrl: BASE_URL, pathPrefix: PATH_PREFIX });

  const preflight = await fetch(`${origin}/hls/secret-1/emby/Videos/movie/master.m3u8`, {
    method: "OPTIONS",
    headers: {
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": "range",
      "Access-Control-Request-Private-Network": "true"
    }
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
  assert.match(preflight.headers.get("access-control-allow-methods"), /GET/);
  assert.equal(preflight.headers.get("access-control-allow-headers"), "range");
  assert.equal(preflight.headers.get("access-control-allow-private-network"), "true");
  await preflight.body?.cancel();

  const response = await fetch(session.urlFor(`${BASE_URL}/Videos/movie/master.m3u8`));
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.equal(response.headers.get("cache-control"), "no-store");
  await response.body?.cancel();
});

test("上游失败返回 502，超大清单报错", async (t) => {
  const { proxy, origin } = await startProxy({
    upstream: async (args) => {
      if (args.url.includes("boom")) throw new Error("connect ECONNREFUSED");
      return textResponse(`#EXTM3U\n#${"x".repeat(2 * 1024 * 1024)}\n`);
    }
  });
  t.after(() => proxy.close());
  const session = proxy.register({ token: "token-1", baseUrl: BASE_URL, pathPrefix: PATH_PREFIX });

  const failed = await fetch(session.urlFor(`${BASE_URL}/Videos/movie/boom.ts`));
  assert.equal(failed.status, 502);
  assert.equal(failed.headers.get("access-control-allow-origin"), "*");
  await failed.body?.cancel();

  const tooLarge = await fetch(session.urlFor(`${BASE_URL}/Videos/movie/master.m3u8`));
  assert.equal(tooLarge.status, 500);
  await tooLarge.body?.cancel();
  assert.equal(origin.startsWith("http://127.0.0.1:"), true);
});

test("close 终止在途请求并关闭 server，start/close 幂等", async () => {
  const { proxy } = await startProxy({
    upstream: async ({ signal }) => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        signal?.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true });
      }
    }), { status: 200, headers: { "content-type": "video/mp2t" } })
  });
  const again = await proxy.start();
  assert.equal(again, `http://127.0.0.1:${proxy.port}`, "start 幂等");
  const session = proxy.register({ token: "token-1", baseUrl: BASE_URL, pathPrefix: PATH_PREFIX });

  const response = await fetch(session.urlFor(`${BASE_URL}/Videos/movie/segment-1.ts`));
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.deepEqual(Buffer.from(first.value), Buffer.from([1, 2, 3]));

  await proxy.close();
  await proxy.close();
  // 在途的第二个 read 必须结束（流被 abort）或报错（连接被 closeAllConnections 销毁）。
  const second = await reader.read().then(
    (result) => (result.done ? "ended" : "unexpected-data"),
    () => "error"
  );
  assert.notEqual(second, "unexpected-data");
  await assert.rejects(fetch(session.urlFor(`${BASE_URL}/Videos/movie/segment-1.ts`)));
});

test("未 start 时 register 抛错", async () => {
  const proxy = new HlsProxy({ upstream: async () => textResponse("#EXTM3U\n") });
  assert.throws(
    () => proxy.register({ token: "t", baseUrl: BASE_URL, pathPrefix: PATH_PREFIX }),
    { code: "HLS_PROXY_NOT_STARTED" }
  );
});
