import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { pipeline } from "node:stream/promises";
import { EmbyError, SECRET_QUERY_KEYS, validateExternalMediaUrl } from "./emby-client.mjs";

// playlist 很小（几十 KB），重写时需要整体缓冲；超过上限说明上游在冒充清单，直接报错。
const MAX_PLAYLIST_BYTES = 2 * 1024 * 1024;
const PLAYLIST_PREFIX = Buffer.from("#EXTM3U", "latin1");
// 只透传对 hls.js 有意义的响应头，避免把上游 hop-by-hop / 安全策略头带给渲染页面。
const FORWARD_HEADERS = new Map([
  ["content-type", "Content-Type"],
  ["content-length", "Content-Length"],
  ["content-range", "Content-Range"],
  ["accept-ranges", "Accept-Ranges"]
]);

function cancelled(cause) {
  return new EmbyError("CANCELLED", "HLS 代理请求已取消", { cause });
}

function stripSecretQuery(url) {
  for (const key of [...url.searchParams.keys()]) {
    if (SECRET_QUERY_KEYS.has(key.toLowerCase())) url.searchParams.delete(key);
  }
  return url;
}

// 相对 URI 保持相对形态，仅剥离可能回显在查询串里的访问令牌（与 sanitizeHlsManifest 对齐）。
function stripRelativeSecretQuery(value) {
  const queryIndex = value.indexOf("?");
  if (queryIndex === -1) return value;
  const path = value.slice(0, queryIndex);
  let rest = value.slice(queryIndex + 1);
  let hash = "";
  const hashIndex = rest.indexOf("#");
  if (hashIndex !== -1) {
    hash = rest.slice(hashIndex);
    rest = rest.slice(0, hashIndex);
  }
  const params = new URLSearchParams(rest);
  let changed = false;
  for (const key of [...params.keys()]) {
    if (SECRET_QUERY_KEYS.has(key.toLowerCase())) {
      params.delete(key);
      changed = true;
    }
  }
  if (!changed) return value;
  const query = params.toString();
  return `${path}${query ? `?${query}` : ""}${hash}`;
}

// Emby 媒体的本地回路代理：既可代发 HLS manifest / 分片 / key，也可透传原生
// MP4 的持续 Range。后者替代「RPC + Base64 过 CDP」的高开销通道。
// 安全模型与 RangeProxy 一致：只绑 loopback + 随机端口 + randomUUID 秘密路径；
// token 只出现在发往 Emby 的 header 里，绝不出现在 URL。
export class HlsProxy {
  constructor({ upstream, randomUUIDImpl = randomUUID, dnsLookup = undefined } = {}) {
    if (typeof upstream !== "function") {
      throw new TypeError("upstream 回调是必须的");
    }
    this.upstream = upstream;
    this.randomUUIDImpl = randomUUIDImpl;
    this.dnsLookup = dnsLookup;
    this.server = null;
    this.port = null;
    this.starting = null;
    this.sessions = new Map();
    this.controllers = new Set();
  }

  async start() {
    if (this.server) return `http://127.0.0.1:${this.port}`;
    // 并发 open 会同时触发首次 start：用启动中 promise 去重，避免绑出两个 server。
    if (!this.starting) {
      this.starting = this.#listen().then(
        (origin) => {
          this.starting = null;
          return origin;
        },
        (error) => {
          this.starting = null;
          throw error;
        }
      );
    }
    return this.starting;
  }

  async #listen() {
    const server = createServer((request, response) => {
      void this.#handle(request, response);
    });
    server.on("clientError", (_error, socket) => socket.destroy());
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new EmbyError("HLS_PROXY_FAILED", "无法启动 HLS 本地代理");
    }
    this.server = server;
    this.port = address.port;
    // 辅助服务器不允许独自撑起事件循环：忘记 close（如单元测试没有 dispose）时
    // 不能阻止进程退出；存活期由持有它的服务进程里的其它句柄保证。
    server.unref();
    return `http://127.0.0.1:${this.port}`;
  }

  async close() {
    for (const controller of this.controllers) controller.abort(cancelled());
    this.controllers.clear();
    this.sessions.clear();
    const server = this.server;
    this.server = null;
    this.port = null;
    if (!server) return;
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections?.();
    });
  }

  // 注册一个播放会话的代理入口。pathPrefix 把可访问路径收口到该视频自己的
  // 媒体目录（含 baseUrl 子路径，如 /emby/Videos/<itemId>/），防止越权访问
  // Emby 其它端点。返回的 urlFor 把同源目标 URL 映射为代理路径形式，跨源映射为 @ext 形式。
  register({ token, baseUrl, pathPrefix }) {
    if (!this.server || this.port === null) {
      throw new EmbyError("HLS_PROXY_NOT_STARTED", "HLS 本地代理尚未启动");
    }
    const parsedBase = new URL(baseUrl);
    const secret = this.randomUUIDImpl();
    const session = {
      secret,
      token: token ?? null,
      baseUrl: parsedBase.href,
      origin: parsedBase.origin,
      pathPrefix: String(pathPrefix)
    };
    this.sessions.set(secret, session);
    const urlFor = (targetUrl) => this.#mapUrl(session, targetUrl);
    return { secret, urlFor };
  }

  unregister(secret) {
    if (typeof secret === "string" && secret.length > 0) this.sessions.delete(secret);
  }

  #mapUrl(session, targetUrl) {
    const target = new URL(targetUrl, session.baseUrl);
    const origin = `http://127.0.0.1:${this.port}`;
    if (target.origin === session.origin) {
      stripSecretQuery(target);
      return `${origin}/hls/${session.secret}${target.pathname}${target.search}`;
    }
    return `${origin}/hls/${session.secret}/@ext/${Buffer.from(target.href, "utf8").toString("base64url")}`;
  }

  async #handle(request, response) {
    const controller = new AbortController();
    this.controllers.add(controller);
    const abort = () => controller.abort(cancelled());
    request.once("aborted", abort);
    response.once("close", () => {
      if (!response.writableEnded) abort();
    });
    try {
      const method = request.method ?? "GET";
      // 渲染页面（app:// origin）fetch 127.0.0.1 是跨域，必须应答 CORS 预检。
      if (method === "OPTIONS") {
        this.#sendPreflight(request, response);
        return;
      }
      if (!["GET", "HEAD"].includes(method)) {
        this.#sendError(response, 405, "method not allowed");
        return;
      }
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      const match = /^\/hls\/([^/]+)(\/.*)?$/.exec(requestUrl.pathname);
      const session = match ? this.sessions.get(match[1]) : null;
      if (!session || !match[2]) {
        this.#sendError(response, 404, "not found");
        return;
      }
      const remainder = match[2];
      // URL 解析会归并点段，单独立即拒绝原始路径里的 ..（含 %2e 变体），明确防御意图。
      const rawPath = String(request.url ?? "").split("?", 1)[0];
      const hasDotSegment = rawPath.split("/").some((segment) => {
        try {
          return decodeURIComponent(segment) === "..";
        } catch {
          return false;
        }
      });
      if (hasDotSegment) {
        this.#sendError(response, 403, "forbidden");
        return;
      }

      let target;
      let external = false;
      if (remainder.startsWith("/@ext/")) {
        // 跨源媒体（m3u8 重写产出）：只做 SSRF 校验，绝不附加 Emby token。
        external = true;
        const absolute = Buffer.from(remainder.slice("/@ext/".length), "base64url").toString("utf8");
        try {
          target = await validateExternalMediaUrl(absolute, { dnsLookup: this.dnsLookup });
        } catch (error) {
          this.#sendError(response, 403, error?.message ?? "forbidden");
          return;
        }
      } else {
        target = new URL(remainder + requestUrl.search, session.baseUrl);
        if (target.origin !== session.origin || !target.pathname.startsWith(session.pathPrefix)) {
          this.#sendError(response, 403, "forbidden");
          return;
        }
      }

      const headers = { Accept: "*/*" };
      if (typeof request.headers.range === "string") headers.Range = request.headers.range;
      if (!external && session.token) headers["X-Emby-Token"] = session.token;

      let upstream;
      try {
        upstream = await this.upstream({
          url: target.href,
          method,
          headers,
          signal: controller.signal
        });
      } catch (error) {
        if (controller.signal.aborted || response.destroyed) return;
        const code = String(error?.code ?? "");
        this.#sendError(response, code.startsWith("UNSAFE") ? 403 : 502, "bad gateway");
        return;
      }
      await this.#forward({ upstream, session, method, response });
    } catch (error) {
      if (!response.headersSent && !response.writableEnded && !response.destroyed) {
        this.#sendError(response, 500, "internal error");
      } else if (!response.destroyed) {
        response.destroy();
      }
    } finally {
      this.controllers.delete(controller);
    }
  }

  async #forward({ upstream, session, method, response }) {
    const headers = {
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store"
    };
    for (const [name, outName] of FORWARD_HEADERS) {
      const value = upstream.headers?.get?.(name);
      if (value !== null && value !== undefined) headers[outName] = value;
    }
    const status = Number(upstream.status) || 200;
    const body = upstream.body ?? null;
    if (method === "HEAD" || !body) {
      response.writeHead(status, headers);
      response.end();
      if (body) await body.cancel().catch(() => {});
      return;
    }

    const iterator = body[Symbol.asyncIterator]();
    const first = await iterator.next();
    const firstChunk = first.done ? null : Buffer.from(first.value);
    const contentType = String(upstream.headers.get("content-type") ?? "");
    const isPlaylist = status >= 200 && status < 300 && (
      /mpegurl/i.test(contentType)
      || (firstChunk !== null && firstChunk.subarray(0, PLAYLIST_PREFIX.length).equals(PLAYLIST_PREFIX))
    );
    if (isPlaylist) {
      const chunks = firstChunk ? [firstChunk] : [];
      let size = firstChunk?.length ?? 0;
      for (;;) {
        if (size > MAX_PLAYLIST_BYTES) {
          throw new EmbyError("HLS_PLAYLIST_TOO_LARGE", "HLS 清单超过本地代理的缓冲上限");
        }
        const next = await iterator.next();
        if (next.done) break;
        size += next.value.byteLength ?? next.value.length;
        chunks.push(Buffer.from(next.value));
      }
      const rewritten = this.#rewritePlaylist(Buffer.concat(chunks).toString("utf8"), session);
      response.writeHead(status, {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
        "Content-Type": contentType || "application/vnd.apple.mpegurl",
        "Content-Length": String(Buffer.byteLength(rewritten))
      });
      response.end(rewritten);
      return;
    }

    // 分片 / key：流式 pipe，不整体进内存；pipeline 负责背压与异常清理。
    response.writeHead(status, headers);
    const source = (async function* () {
      if (firstChunk) yield firstChunk;
      for (;;) {
        const next = await iterator.next();
        if (next.done) break;
        yield Buffer.from(next.value);
      }
    })();
    try {
      await pipeline(source, response);
    } catch {
      if (!response.destroyed) response.destroy();
    }
  }

  // 逐行重写 playlist：相对 URI 保持不变（相对解析天然落回代理路径）；
  // 同源绝对 URL 改写为代理路径形式并剥离令牌查询参数；跨源绝对 URL 改写为 @ext 形式。
  #rewritePlaylist(text, session) {
    const rewriteUri = (raw) => {
      const value = String(raw).trim();
      if (!value) return raw;
      const absolute = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value) || value.startsWith("//");
      if (!absolute) return stripRelativeSecretQuery(value);
      let resolved;
      try {
        resolved = new URL(value, session.baseUrl);
      } catch {
        return value;
      }
      if (resolved.origin === session.origin) {
        stripSecretQuery(resolved);
        return `/hls/${session.secret}${resolved.pathname}${resolved.search}`;
      }
      return `/hls/${session.secret}/@ext/${Buffer.from(resolved.href, "utf8").toString("base64url")}`;
    };
    return String(text)
      .split(/\r?\n/)
      .map((line) => {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("#")) return rewriteUri(trimmed);
        return line.replace(/URI="([^"]+)"/g, (_match, uri) => `URI="${rewriteUri(uri)}"`);
      })
      .join("\n");
  }

  #sendPreflight(request, response) {
    const requestedHeaders = request.headers["access-control-request-headers"];
    const headers = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": typeof requestedHeaders === "string" && requestedHeaders.length > 0
        ? requestedHeaders
        : "Range",
      "Access-Control-Max-Age": "600",
      "Cache-Control": "no-store",
      "Content-Length": "0"
    };
    // Chrome 私有网络访问（公网/应用页面 → loopback）预检需要显式放行；
    // 回路 + 秘密路径 + token 不进 URL 仍是实际防线。
    if (request.headers["access-control-request-private-network"] === "true") {
      headers["Access-Control-Allow-Private-Network"] = "true";
    }
    response.writeHead(204, headers);
    response.end();
  }

  #sendError(response, status, message) {
    if (response.writableEnded || response.destroyed) return;
    const body = String(message);
    response.writeHead(status, {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Length": String(Buffer.byteLength(body)),
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store"
    });
    response.end(body);
  }
}
