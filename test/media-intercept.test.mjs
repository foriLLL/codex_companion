import assert from "node:assert/strict";
import test from "node:test";
import {
  MEDIA_INTERCEPT_ORIGIN,
  attachMediaIntercept,
  registerMediaInterceptPort,
  resolveMediaInterceptUrl,
  toMediaInterceptUrl
} from "../src/media-intercept.mjs";

const SECRET = "11111111-1111-4111-8111-111111111111";

test("只改写到已登记的 loopback 代理端口，注销后立即失效", () => {
  const unregister = registerMediaInterceptPort(41001);
  const pageUrl = toMediaInterceptUrl(`http://127.0.0.1:41001/hls/${SECRET}/Videos/1/stream.mp4?Static=true`);
  assert.equal(pageUrl, `${MEDIA_INTERCEPT_ORIGIN}/41001/hls/${SECRET}/Videos/1/stream.mp4?Static=true`);
  assert.equal(resolveMediaInterceptUrl(pageUrl), `http://127.0.0.1:41001/hls/${SECRET}/Videos/1/stream.mp4?Static=true`);
  unregister();
  unregister();
  assert.equal(resolveMediaInterceptUrl(pageUrl), null);
  assert.equal(toMediaInterceptUrl(`http://127.0.0.1:41001/hls/${SECRET}/a.mp4`), null);
});

test("同一端口多次登记按引用计数注销", () => {
  const first = registerMediaInterceptPort(41002);
  const second = registerMediaInterceptPort(41002);
  first();
  assert.ok(resolveMediaInterceptUrl(`${MEDIA_INTERCEPT_ORIGIN}/41002/hls/${SECRET}/a.mp4`));
  second();
  assert.equal(resolveMediaInterceptUrl(`${MEDIA_INTERCEPT_ORIGIN}/41002/hls/${SECRET}/a.mp4`), null);
});

test("拒绝未登记端口、非代理路径、点段与伪造来源", () => {
  const unregister = registerMediaInterceptPort(41003);
  try {
    for (const value of [
      `${MEDIA_INTERCEPT_ORIGIN}/9222/json/version`,
      `${MEDIA_INTERCEPT_ORIGIN}/41004/hls/${SECRET}/a.mp4`,
      `${MEDIA_INTERCEPT_ORIGIN}/41003/json/version`,
      `${MEDIA_INTERCEPT_ORIGIN}/41003/hls/${SECRET}`,
      `${MEDIA_INTERCEPT_ORIGIN}/41003/hls/${SECRET}/../../json`,
      `${MEDIA_INTERCEPT_ORIGIN}/41003/hls/${SECRET}/%2e%2e/json`,
      `${MEDIA_INTERCEPT_ORIGIN}/41003/hls/${SECRET}/%E0%A4%A`,
      `https://evil.invalid/41003/hls/${SECRET}/a.mp4`,
      `http://codex-companion.invalid/41003/hls/${SECRET}/a.mp4`,
      `https://user:pass@codex-companion.invalid/41003/hls/${SECRET}/a.mp4`,
      "not a url"
    ]) {
      assert.equal(resolveMediaInterceptUrl(value), null, value);
    }
    for (const value of [
      `http://localhost:41003/hls/${SECRET}/a.mp4`,
      `https://127.0.0.1:41003/hls/${SECRET}/a.mp4`,
      "http://127.0.0.1:41003/json/version",
      `http://127.0.0.1:41003/hls/${SECRET}/a.mp4#x`
    ]) {
      assert.equal(toMediaInterceptUrl(value), null, value);
    }
    assert.throws(() => registerMediaInterceptPort(0), TypeError);
    assert.throws(() => registerMediaInterceptPort(70_000), TypeError);
  } finally {
    unregister();
  }
});

function fakeConnection({ enableError = null } = {}) {
  const listeners = new Map();
  const sent = [];
  return {
    sent,
    on(method, listener) {
      listeners.set(method, listener);
      return () => listeners.delete(method);
    },
    async send(method, params) {
      sent.push({ method, params });
      if (method === "Fetch.enable" && enableError) throw enableError;
      return {};
    },
    emit(method, params) { listeners.get(method)?.(params); },
    has(method) { return listeners.has(method); }
  };
}

test("CDP 会话只拦截保留域名：合法请求改写，其余直接拒绝", async () => {
  const unregister = registerMediaInterceptPort(41005);
  try {
    const connection = fakeConnection();
    const intercept = await attachMediaIntercept(connection, { logger: { warn() {} } });
    assert.equal(intercept.active, true);
    assert.deepEqual(connection.sent[0], {
      method: "Fetch.enable",
      params: { patterns: [{ urlPattern: `${MEDIA_INTERCEPT_ORIGIN}/*`, requestStage: "Request" }] }
    });
    connection.emit("Fetch.requestPaused", { requestId: "ok", request: { url: `${MEDIA_INTERCEPT_ORIGIN}/41005/hls/${SECRET}/a.mp4` } });
    connection.emit("Fetch.requestPaused", { requestId: "bad", request: { url: `${MEDIA_INTERCEPT_ORIGIN}/9222/json/version` } });
    await Promise.resolve();
    assert.deepEqual(connection.sent.slice(1), [
      { method: "Fetch.continueRequest", params: { requestId: "ok", url: `http://127.0.0.1:41005/hls/${SECRET}/a.mp4` } },
      { method: "Fetch.failRequest", params: { requestId: "bad", errorReason: "BlockedByClient" } }
    ]);
    intercept.detach();
    assert.equal(connection.has("Fetch.requestPaused"), false);
    assert.equal(connection.sent.at(-1).method, "Fetch.disable");
  } finally {
    unregister();
  }
});

test("Fetch 域不可用时返回非激活状态并移除监听", async () => {
  const connection = fakeConnection({ enableError: new Error("Fetch.enable wasn't found") });
  const warnings = [];
  const intercept = await attachMediaIntercept(connection, { logger: { warn: (message) => warnings.push(message) } });
  assert.equal(intercept.active, false);
  assert.equal(connection.has("Fetch.requestPaused"), false);
  assert.equal(warnings.length, 1);
});
