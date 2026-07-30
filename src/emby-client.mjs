import { spawn } from "node:child_process";
import { lookup as defaultDnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  Agent,
  buildConnector,
  fetch as undiciFetch
} from "undici";

const DEFAULT_JSON_LIMIT = 4 * 1024 * 1024;
export const DEFAULT_RESOURCE_LIMIT = 8 * 1024 * 1024;
export const DEFAULT_DIRECT_RANGE_LIMIT = 2 * 1024 * 1024;
export const DEFAULT_SUBTITLE_LIMIT = 4 * 1024 * 1024;
export const EMBY_CLIENT_NAME = "Codex Companion";
export const EMBY_CLIENT_VERSION = "0.0.1";
export const EMBY_USER_AGENT = `Emby/${EMBY_CLIENT_VERSION}`;

export const SECRET_QUERY_KEYS = new Set([
  "api_key",
  "apikey",
  "access_token",
  "token",
  "x-emby-token"
]);

export class EmbyError extends Error {
  constructor(code, message, { status = null, retryable = false, cause } = {}) {
    super(message, { cause });
    this.name = "EmbyError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

export function normalizeServerUrl(input) {
  if (typeof input !== "string" || input.trim() === "") {
    throw new EmbyError("INVALID_SERVER_URL", "请输入 Emby 服务器地址");
  }

  let url;
  try {
    url = new URL(input.trim());
  } catch (cause) {
    throw new EmbyError("INVALID_SERVER_URL", "Emby 服务器地址无效", { cause });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new EmbyError("INVALID_SERVER_URL", "Emby 服务器仅支持 HTTP 或 HTTPS");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new EmbyError("INVALID_SERVER_URL", "服务器地址不能包含凭证、查询参数或片段");
  }
  url.pathname = url.pathname.replace(/\/{2,}/g, "/").replace(/\/+$/, "");
  return `${url.origin}${url.pathname === "/" ? "" : url.pathname}`;
}

export function embyAuthorizationHeader(deviceId) {
  const escape = (value) => String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return [
    `MediaBrowser Client="${escape(EMBY_CLIENT_NAME)}"`,
    'Device="Codex Desktop"',
    `DeviceId="${escape(deviceId)}"`,
    `Version="${EMBY_CLIENT_VERSION}"`
  ].join(", ");
}

export function redactSensitive(value, secrets = []) {
  let output = typeof value === "string" ? value : String(value ?? "");
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length > 0) output = output.replaceAll(secret, "[REDACTED]");
  }
  output = output
    .replace(/([?&](?:api_key|apikey|access_token|token|x-emby-token)=)[^&#\s]+/gi, "$1[REDACTED]")
    .replace(/(X-Emby-Token\s*[:=]\s*)[^,\s]+/gi, "$1[REDACTED]")
    .replace(/("(?:Pw|Password|AccessToken)"\s*:\s*")[^"]*(")/gi, "$1[REDACTED]$2");
  return output;
}

function endpointUrl(baseUrl, path, query) {
  const url = new URL(`${baseUrl}/${String(path).replace(/^\/+/, "")}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === "") continue;
      url.searchParams.set(key, Array.isArray(value) ? value.join(",") : String(value));
    }
  }
  return url;
}

export function validateSameOriginResource(baseUrl, input) {
  let resource;
  try {
    resource = new URL(input, `${baseUrl}/`);
  } catch (cause) {
    throw new EmbyError("UNSAFE_RESOURCE_URL", "媒体资源地址无效", { cause });
  }
  const base = new URL(baseUrl);
  if (resource.protocol !== base.protocol || resource.origin !== base.origin) {
    throw new EmbyError("UNSAFE_RESOURCE_URL", "拒绝访问 Emby 服务器之外的资源");
  }
  if (resource.username || resource.password) {
    throw new EmbyError("UNSAFE_RESOURCE_URL", "媒体资源地址不能包含凭证");
  }
  for (const key of resource.searchParams.keys()) {
    if (SECRET_QUERY_KEYS.has(key.toLowerCase())) {
      throw new EmbyError("UNSAFE_RESOURCE_URL", "媒体资源地址不能包含访问令牌");
    }
  }
  return resource;
}

function stripSecretQuery(url) {
  for (const key of [...url.searchParams.keys()]) {
    if (SECRET_QUERY_KEYS.has(key.toLowerCase())) url.searchParams.delete(key);
  }
  return url;
}

export function sanitizeDirectStreamUrl(baseUrl, input) {
  let resource;
  try {
    resource = new URL(input, `${baseUrl}/`);
  } catch (cause) {
    throw new EmbyError("UNSAFE_RESOURCE_URL", "直连媒体地址无效", { cause });
  }
  const base = new URL(baseUrl);
  if (resource.protocol !== base.protocol || resource.origin !== base.origin) {
    throw new EmbyError("UNSAFE_RESOURCE_URL", "Emby 直连地址必须由当前服务器签发");
  }
  if (resource.username || resource.password) {
    throw new EmbyError("UNSAFE_RESOURCE_URL", "直连媒体地址不能包含用户名或密码");
  }
  return stripSecretQuery(resource).href;
}

function isPrivateAddress(address) {
  const normalized = String(address).toLowerCase().split("%")[0];
  if (normalized === "::1" || normalized === "::" || normalized.startsWith("fc") || normalized.startsWith("fd")) {
    return true;
  }
  if (normalized.startsWith("fe") || normalized.startsWith("ff")) return true;
  if (normalized.startsWith("::ffff:")) return isPrivateAddress(normalized.slice(7));
  if (isIP(normalized) !== 4) return false;
  const [a, b] = normalized.split(".").map(Number);
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || a >= 224;
}

// 登录目标的 SSRF 收口：自建 Emby 常驻 LAN（10./172.16./192.168.），因此不能像媒体
// 重定向那样一律拒绝私网；但必须拦住回环、link-local（含云元数据 169.254.169.254）、
// 通配与组播/保留地址——这些是 SSRF 探测内网/元数据端点的高价值目标，Emby 绝不会在此。
function isBlockedLoginAddress(address) {
  const normalized = String(address).toLowerCase().split("%")[0];
  if (normalized === "::1" || normalized === "::") return true;
  if (normalized.startsWith("fe80") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) {
    return true; // IPv6 link-local
  }
  if (normalized.startsWith("ff")) return true; // IPv6 multicast
  if (normalized.startsWith("::ffff:")) return isBlockedLoginAddress(normalized.slice(7));
  if (isIP(normalized) !== 4) return false;
  const [a, b] = normalized.split(".").map(Number);
  return a === 0                        // "this" network / 0.0.0.0
    || a === 127                        // loopback
    || (a === 169 && b === 254)         // link-local + cloud metadata
    || a >= 224;                        // multicast / reserved
}

export async function assertLoginHostAllowed(baseUrl, { dnsLookup = defaultDnsLookup } = {}) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch (cause) {
    throw new EmbyError("INVALID_SERVER_URL", "Emby 服务器地址无效", { cause });
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new EmbyError("UNSAFE_SERVER_URL", "拒绝把 Emby 登录指向本机地址");
  }
  if (isIP(hostname)) {
    if (isBlockedLoginAddress(hostname)) {
      throw new EmbyError("UNSAFE_SERVER_URL", "拒绝把 Emby 登录指向回环 / 链路本地 / 元数据地址");
    }
    return;
  }
  let addresses;
  try {
    addresses = await dnsLookup(hostname, { all: true, verbatim: true });
  } catch (cause) {
    throw new EmbyError("SERVER_DNS_ERROR", "无法解析 Emby 服务器地址", { retryable: true, cause });
  }
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new EmbyError("SERVER_DNS_ERROR", "无法解析 Emby 服务器地址", { retryable: true });
  }
  if (addresses.some(({ address }) => isBlockedLoginAddress(address))) {
    throw new EmbyError("UNSAFE_SERVER_URL", "Emby 服务器地址解析到了回环 / 链路本地 / 元数据地址");
  }
}

export async function resolveExternalMediaAddress(hostname, { dnsLookup = defaultDnsLookup } = {}) {
  const normalized = String(hostname).toLowerCase().replace(/^\[|\]$/g, "");
  if (isIP(normalized)) {
    if (isPrivateAddress(normalized)) {
      throw new EmbyError("UNSAFE_MEDIA_REDIRECT", "媒体重定向不能指向内网地址");
    }
    return { address: normalized, family: isIP(normalized) };
  }

  let addresses;
  try {
    addresses = await dnsLookup(normalized, { all: true, verbatim: true });
  } catch (cause) {
    throw new EmbyError("MEDIA_REDIRECT_DNS_ERROR", "无法解析媒体 CDN 地址", {
      retryable: true,
      cause
    });
  }
  if (!Array.isArray(addresses) || addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new EmbyError("UNSAFE_MEDIA_REDIRECT", "媒体 CDN 解析到了本机或内网地址");
  }
  const selected = addresses.find(({ family }) => Number(family) === 4) ?? addresses[0];
  return { address: selected.address, family: Number(selected.family) || isIP(selected.address) };
}

export async function validateExternalMediaUrl(input, { dnsLookup = defaultDnsLookup } = {}) {
  let url;
  try {
    url = new URL(input);
  } catch (cause) {
    throw new EmbyError("UNSAFE_MEDIA_REDIRECT", "媒体重定向地址无效", { cause });
  }
  if (url.protocol !== "https:") {
    throw new EmbyError("UNSAFE_MEDIA_REDIRECT", "跨源媒体重定向只允许 HTTPS");
  }
  if (url.username || url.password) {
    throw new EmbyError("UNSAFE_MEDIA_REDIRECT", "媒体重定向不能包含用户名或密码");
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new EmbyError("UNSAFE_MEDIA_REDIRECT", "媒体重定向不能指向本机");
  }
  await resolveExternalMediaAddress(hostname, { dnsLookup });
  return url;
}

function createExternalStreamTransport(dnsLookup) {
  const connector = buildConnector({
    timeout: 10_000,
    keepAlive: true,
    keepAliveInitialDelay: 10_000
  });
  const agent = new Agent({
    connections: 4,
    pipelining: 1,
    headersTimeout: 10_000,
    bodyTimeout: 30_000,
    connect(options, callback) {
      if (options.protocol !== "https:") {
        callback(new EmbyError("UNSAFE_MEDIA_REDIRECT", "跨源媒体重定向只允许 HTTPS"), null);
        return;
      }
      const originalHostname = String(options.hostname).replace(/^\[|\]$/g, "");
      void resolveExternalMediaAddress(originalHostname, { dnsLookup }).then(
        ({ address }) => connector({
          ...options,
          hostname: address,
          servername: options.servername || originalHostname
        }, callback),
        (error) => callback(error, null)
      );
    }
  });
  return {
    async request(url, { method = "GET", headers = {}, signal } = {}) {
      const response = await undiciFetch(url, {
        method,
        headers,
        signal,
        dispatcher: agent,
        redirect: "follow"
      });
      await validateExternalMediaUrl(response.url, { dnsLookup });
      return response;
    },
    close: () => agent.close()
  };
}

// 同源（Emby origin）Range 流默认走 globalThis.fetch，没有任何 body/idle 超时：
// 一旦 Emby 套接字半开或中途卡死，视频会永久转圈且不报错。这里提供一个带 bodyTimeout
// 的 undici dispatcher，让卡死的同源流在超时后抛出可重试错误，由上层重连或提示用户。
function createSameOriginStreamDispatcher() {
  return new Agent({
    connections: 6,
    pipelining: 1,
    headersTimeout: 15_000,
    bodyTimeout: 30_000
  });
}

function parseContentRange(value) {
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(String(value ?? "").trim());
  if (!match) return null;
  return {
    start: Number(match[1]),
    end: Number(match[2]),
    total: match[3] === "*" ? null : Number(match[3])
  };
}

function curlConfigValue(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/[\r\n]/g, "");
}

function parseIncludedCurlResponse(output) {
  let offset = 0;
  while (offset < output.length) {
    const separator = output.indexOf("\r\n\r\n", offset, "latin1");
    if (separator < 0) break;
    const headerText = output.subarray(offset, separator).toString("latin1");
    const lines = headerText.split("\r\n");
    const statusMatch = /^HTTP\/\S+\s+(\d{3})/.exec(lines.shift() ?? "");
    if (!statusMatch) break;
    const status = Number(statusMatch[1]);
    offset = separator + 4;
    if ((status >= 100 && status < 200) || (status >= 300 && status < 400)) continue;
    const headers = new Headers();
    for (const line of lines) {
      const colon = line.indexOf(":");
      if (colon > 0) headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
    }
    return { status, headers, bytes: output.subarray(offset) };
  }
  throw new EmbyError("MEDIA_CDN_INVALID_RESPONSE", "媒体 CDN 返回了无效的 HTTP 响应", { retryable: true });
}

function directCurlRequest(url, { method = "GET", headers = {}, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/curl", ["--config", "-"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    const chunks = [];
    let length = 0;
    let stderr = "";
    let settled = false;
    const finish = (operation) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      operation();
    };
    const abort = () => {
      child.kill("SIGTERM");
      finish(() => reject(signal?.reason ?? new DOMException("Aborted", "AbortError")));
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    child.once("error", (error) => finish(() => reject(error)));
    child.stdout.on("data", (chunk) => {
      length += chunk.length;
      if (length > DEFAULT_DIRECT_RANGE_LIMIT + 64 * 1024) {
        child.kill("SIGTERM");
        finish(() => reject(new EmbyError("RESPONSE_TOO_LARGE", "媒体 CDN 响应超过 Range 大小限制")));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-2048);
    });
    child.once("close", (code) => finish(() => {
      if (code !== 0) {
        reject(new EmbyError("MEDIA_CDN_NETWORK_ERROR", `媒体 CDN 请求失败（curl ${code}）`, {
          retryable: true,
          cause: new Error(stderr.trim())
        }));
        return;
      }
      try {
        const parsed = parseIncludedCurlResponse(Buffer.concat(chunks, length));
        resolve(new Response(parsed.bytes, { status: parsed.status, headers: parsed.headers }));
      } catch (error) {
        reject(error);
      }
    }));

    const config = [
      "silent",
      "show-error",
      "include",
      "location",
      "max-redirs = 4",
      "connect-timeout = 10",
      "max-time = 30",
      "proto = \"=https\"",
      "proto-redir = \"=https\"",
      `request = \"${curlConfigValue(method)}\"`,
      `url = \"${curlConfigValue(url.href)}\"`,
      ...Object.entries(headers).map(([name, value]) => `header = \"${curlConfigValue(name)}: ${curlConfigValue(value)}\"`)
    ].join("\n");
    child.stdin.end(`${config}\n`);
  });
}

async function preflightExternalRedirects(input, { dnsLookup, signal } = {}) {
  let current = await validateExternalMediaUrl(input, { dnsLookup });
  for (let redirects = 0; redirects <= 4; redirects += 1) {
    let response;
    try {
      response = await fetch(current, {
        method: "HEAD",
        redirect: "manual",
        signal,
        headers: { Accept: "*/*" }
      });
    } catch (cause) {
      if (signal?.aborted || cause?.name === "AbortError") throw cause;
      throw new EmbyError("MEDIA_REDIRECT_PREFLIGHT_FAILED", "无法验证媒体 CDN 重定向", {
        retryable: true,
        cause
      });
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      return current;
    }
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location || redirects === 4) {
      throw new EmbyError("UNSAFE_MEDIA_REDIRECT", "媒体 CDN 重定向无效或次数过多");
    }
    current = await validateExternalMediaUrl(new URL(location, current), { dnsLookup });
  }
  throw new EmbyError("UNSAFE_MEDIA_REDIRECT", "媒体 CDN 重定向次数过多");
}

export function sanitizeHlsManifest(manifest, manifestUrl, baseUrl) {
  const cleanUri = (raw) => {
    const resolved = stripSecretQuery(new URL(raw, manifestUrl));
    const base = new URL(baseUrl);
    if (resolved.origin !== base.origin || resolved.protocol !== base.protocol) {
      throw new EmbyError("UNSAFE_RESOURCE_URL", "HLS 清单包含跨源资源");
    }
    return resolved.href;
  };

  return String(manifest)
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) return cleanUri(trimmed);
      return line.replace(/URI="([^"]+)"/g, (_match, uri) => `URI="${cleanUri(uri)}"`);
    })
    .join("\n");
}

class Semaphore {
  #available;
  #queue = [];

  constructor(limit) {
    this.#available = limit;
  }

  async use(signal, operation) {
    await this.#acquire(signal);
    try {
      return await operation();
    } finally {
      this.#release();
    }
  }

  #acquire(signal) {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    if (this.#available > 0) {
      this.#available -= 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, onAbort: null };
      waiter.onAbort = () => {
        const index = this.#queue.indexOf(waiter);
        if (index >= 0) this.#queue.splice(index, 1);
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      };
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      this.#queue.push(waiter);
    });
  }

  #release() {
    while (this.#queue.length > 0) {
      const waiter = this.#queue.shift();
      waiter.signal?.removeEventListener("abort", waiter.onAbort);
      if (waiter.signal?.aborted) continue;
      waiter.resolve();
      return;
    }
    this.#available += 1;
  }
}

async function readLimited(response, limit) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    await response.body?.cancel();
    throw new EmbyError("RESPONSE_TOO_LARGE", `Emby 响应超过 ${limit} 字节限制`);
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw new EmbyError("RESPONSE_TOO_LARGE", `Emby 响应超过 ${limit} 字节限制`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function httpError(status) {
  if (status === 401) return new EmbyError("UNAUTHORIZED", "Emby 登录已失效，请重新连接", { status });
  if (status === 403) return new EmbyError("FORBIDDEN", "当前 Emby 用户无权访问该内容", { status });
  if (status === 404) return new EmbyError("NOT_FOUND", "Emby 内容不存在", { status });
  return new EmbyError("EMBY_HTTP_ERROR", `Emby 请求失败（HTTP ${status}）`, {
    status,
    retryable: status === 408 || status === 429 || status >= 500
  });
}

function ticks(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : 0;
}

export class EmbyClient {
  constructor({
    baseUrl,
    deviceId,
    token = null,
    fetchImpl = globalThis.fetch,
    resourceConcurrency = 4,
    resourceLimit = DEFAULT_RESOURCE_LIMIT,
    dnsLookup = defaultDnsLookup,
    directFetchImpl = null,
    directStreamFetchImpl = null,
    directFollowsRedirects = null,
    externalStreamTransport = null,
    sameOriginStreamDispatcher = null
  }) {
    this.baseUrl = normalizeServerUrl(baseUrl);
    this.deviceId = deviceId;
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.resourceLimit = resourceLimit;
    this.dnsLookup = dnsLookup;
    this.directFetchImpl = directFetchImpl ?? (fetchImpl === globalThis.fetch ? directCurlRequest : fetchImpl);
    // 仅当外部未传入（即自己创建）时才拥有传输层：withToken 共享传输层给子 client 时，
    // 拥有权一并移交，避免父 client close() 误关子 client 正在用的连接池。
    const ownsExternalStreamTransport = externalStreamTransport === null
      && directStreamFetchImpl === null
      && fetchImpl === globalThis.fetch;
    this.externalStreamTransport = ownsExternalStreamTransport
      ? createExternalStreamTransport(dnsLookup)
      : externalStreamTransport;
    this.directStreamFetchImpl = directStreamFetchImpl
      ?? this.externalStreamTransport?.request
      ?? this.directFetchImpl;
    this.directStreamFollowsRedirects = Boolean(this.externalStreamTransport);
    this.directFollowsRedirects = directFollowsRedirects ?? (directFetchImpl === null && fetchImpl === globalThis.fetch);
    // 仅在使用默认全局 fetch 时启用同源流超时 dispatcher；注入自定义 fetchImpl 的测试不受影响。
    // withToken() 会把已有 dispatcher 传下来，避免每次重新签发 token 都泄漏一个新的连接池。
    const ownsSameOriginDispatcher = sameOriginStreamDispatcher === null
      && fetchImpl === globalThis.fetch;
    this.sameOriginStreamDispatcher = ownsSameOriginDispatcher
      ? createSameOriginStreamDispatcher()
      : sameOriginStreamDispatcher;
    this.ownsStreamResources = ownsExternalStreamTransport || ownsSameOriginDispatcher;
    this.resourceSemaphore = new Semaphore(resourceConcurrency);
    // 外部媒体 URL 校验（DNS 解析）按 href 短 TTL 缓存：direct-mp4 每 1MB 一个 Range，
    // 每个 Range 都重新解析一次 CDN 域名是纯浪费。安全性不受影响——真正发连接时
    // externalStreamTransport 的 connect() 仍会逐连接做 resolveExternalMediaAddress。
    this.externalValidationCache = new Map();
  }

  // 外部媒体 URL 校验的缓存入口（TTL 5 分钟，容量 128，FIFO 逐出）。接受 string 或 URL。
  async validateExternalUrlOnce(url) {
    const key = typeof url === "string" ? url : url.href;
    const cached = this.externalValidationCache.get(key);
    if (cached && Date.now() - cached.at < 5 * 60_000) return cached.url;
    const validated = await validateExternalMediaUrl(url, { dnsLookup: this.dnsLookup });
    if (this.externalValidationCache.size >= 128) {
      this.externalValidationCache.delete(this.externalValidationCache.keys().next().value);
    }
    this.externalValidationCache.set(key, { url: validated, at: Date.now() });
    return validated;
  }

  // 释放本 client 拥有的 keep-alive 连接池。非拥有者（withToken 共享传输层的父 client）
  // 调用是 no-op；幂等。EmbyService 替换/丢弃 client 时应对旧 client 调用，否则每登录/
  // 切服务器一次就泄漏一个 undici Agent（旧服务器的 keep-alive socket 挂到进程退出）。
  close() {
    if (!this.ownsStreamResources) return;
    this.ownsStreamResources = false;
    try { this.externalStreamTransport?.close?.()?.catch?.(() => {}); } catch {}
    try { this.sameOriginStreamDispatcher?.close?.()?.catch?.(() => {}); } catch {}
  }

  withToken(token) {
    const child = new EmbyClient({
      baseUrl: this.baseUrl,
      deviceId: this.deviceId,
      token,
      fetchImpl: this.fetchImpl,
      resourceLimit: this.resourceLimit,
      dnsLookup: this.dnsLookup,
      directFetchImpl: this.directFetchImpl,
      directStreamFetchImpl: this.directStreamFetchImpl,
      directFollowsRedirects: this.directFollowsRedirects,
      externalStreamTransport: this.externalStreamTransport,
      sameOriginStreamDispatcher: this.sameOriginStreamDispatcher
    });
    // 传输层已共享给子 client：拥有权一并移交，父 client 之后 close() 不会误关
    // 子 client 正在使用的连接池。
    if (this.ownsStreamResources) {
      this.ownsStreamResources = false;
      child.ownsStreamResources = true;
    }
    return child;
  }

  buildUrl(path, query) {
    return endpointUrl(this.baseUrl, path, query).href;
  }

  imageUrl(itemId, { type = "Primary", maxWidth = 300, maxHeight = 450, tag } = {}) {
    return this.buildUrl(`Items/${encodeURIComponent(itemId)}/Images/${encodeURIComponent(type)}`, {
      MaxWidth: maxWidth,
      MaxHeight: maxHeight,
      Tag: tag
    });
  }

  hlsUrl(itemId, playback) {
    return this.buildUrl(`Videos/${encodeURIComponent(itemId)}/master.m3u8`, {
      UserId: playback.userId,
      DeviceId: this.deviceId,
      MediaSourceId: playback.mediaSourceId,
      PlaySessionId: playback.playSessionId,
      StartTimeTicks: ticks(playback.startTimeTicks),
      MaxWidth: 1280,
      MaxHeight: 720,
      VideoCodec: "h264",
      AudioCodec: "aac",
      SegmentContainer: "ts",
      MinSegments: 1,
      BreakOnNonKeyFrames: true,
      SubtitleStreamIndex: playback.subtitleMode === "burn-in" ? playback.subtitleStreamIndex : undefined,
      SubtitleMethod: playback.subtitleMode === "burn-in" ? "Encode" : undefined
    });
  }

  subtitleUrl(itemId, mediaSourceId, subtitleStreamIndex, {
    format = "vtt",
    startPositionTicks = 0
  } = {}) {
    if (!Number.isSafeInteger(Number(subtitleStreamIndex)) || Number(subtitleStreamIndex) < 0) {
      throw new EmbyError("INVALID_SUBTITLE_INDEX", "字幕轨道索引无效");
    }
    if (!/^[a-z0-9]+$/i.test(String(format))) {
      throw new EmbyError("INVALID_SUBTITLE_FORMAT", "字幕格式无效");
    }
    return this.buildUrl(
      `Videos/${encodeURIComponent(itemId)}/${encodeURIComponent(mediaSourceId)}/Subtitles/${Number(subtitleStreamIndex)}/Stream.${String(format).toLowerCase()}`,
      { StartPositionTicks: ticks(startPositionTicks) }
    );
  }

  async request(path, {
    method = "GET",
    query,
    body,
    signal,
    token = this.token,
    responseType = "json",
    maxBytes = DEFAULT_JSON_LIMIT
  } = {}) {
    const url = path instanceof URL ? path : endpointUrl(this.baseUrl, path, query);
    validateSameOriginResource(this.baseUrl, url);
    const headers = {
      Accept: responseType === "json" ? "application/json" : "*/*",
      "User-Agent": EMBY_USER_AGENT,
      "X-Emby-Authorization": embyAuthorizationHeader(this.deviceId)
    };
    if (token) headers["X-Emby-Token"] = token;
    if (body !== undefined) headers["Content-Type"] = "application/json";

    let response;
    let requestUrl = url;
    let requestMethod = method;
    let requestBody = body === undefined ? undefined : JSON.stringify(body);
    try {
      for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
        response = await this.fetchImpl(requestUrl, {
          method: requestMethod,
          headers,
          body: requestBody,
          signal,
          redirect: "manual"
        });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location || redirectCount === 3) {
          throw new EmbyError("UNSAFE_REDIRECT", "Emby 返回了无效或过多的重定向");
        }
        requestUrl = validateSameOriginResource(this.baseUrl, new URL(location, requestUrl));
        if (response.status === 303 || ((response.status === 301 || response.status === 302) && requestMethod === "POST")) {
          requestMethod = "GET";
          requestBody = undefined;
          delete headers["Content-Type"];
        }
      }
    } catch (cause) {
      if (cause instanceof EmbyError) throw cause;
      if (signal?.aborted || cause?.name === "AbortError") {
        throw new EmbyError("CANCELLED", "Emby 请求已取消", { cause });
      }
      const networkCode = String(cause?.code ?? cause?.cause?.code ?? "");
      const networkMessage = `${cause?.message ?? ""} ${cause?.cause?.message ?? ""}`;
      const code = /CERT|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(networkCode)
        || /certificate|self[- ]signed/i.test(networkMessage)
        ? "TLS_ERROR"
        : "NETWORK_ERROR";
      const message = code === "TLS_ERROR"
        ? "Emby HTTPS 证书校验失败；第一版不支持自签名证书"
        : "无法连接 Emby 服务器";
      throw new EmbyError(code, message, { retryable: code === "NETWORK_ERROR", cause });
    }

    if (response.url) validateSameOriginResource(this.baseUrl, response.url);
    if (!response.ok) {
      await response.body?.cancel();
      throw httpError(response.status);
    }
    if (responseType === "none" || response.status === 204) {
      await response.body?.cancel();
      return null;
    }

    let bytes;
    try {
      bytes = await readLimited(response, maxBytes);
    } catch (cause) {
      if (cause instanceof EmbyError) throw cause;
      if (signal?.aborted || cause?.name === "AbortError") {
        throw new EmbyError("CANCELLED", "Emby 请求已取消", { cause });
      }
      throw new EmbyError("NETWORK_ERROR", "读取 Emby 响应失败", { retryable: true, cause });
    }
    if (responseType === "bytes") {
      return { bytes, contentType: response.headers.get("content-type") ?? "application/octet-stream", url: response.url || requestUrl.href };
    }
    const text = new TextDecoder().decode(bytes);
    if (responseType === "text") {
      return { text, contentType: response.headers.get("content-type") ?? "text/plain", url: response.url || requestUrl.href };
    }
    if (text === "") return null;
    try {
      return JSON.parse(text);
    } catch (cause) {
      throw new EmbyError("INVALID_RESPONSE", "Emby 返回了无效 JSON", { cause });
    }
  }

  async authenticate(username, password, { signal } = {}) {
    if (!username || !password) throw new EmbyError("INVALID_CREDENTIALS", "请输入 Emby 用户名和密码");
    try {
      return await this.request("Users/AuthenticateByName", {
        method: "POST",
        body: { Username: username, Pw: password },
        token: null,
        signal
      });
    } catch (error) {
      if (error?.code === "UNAUTHORIZED" || error?.status === 400) {
        throw new EmbyError("INVALID_CREDENTIALS", "Emby 用户名或密码不正确", { status: error.status, cause: error });
      }
      throw error;
    }
  }

  getViews(userId, { signal } = {}) {
    return this.request(`Users/${encodeURIComponent(userId)}/Views`, { signal });
  }

  getResume(userId, { limit = 5, signal } = {}) {
    return this.request(`Users/${encodeURIComponent(userId)}/Items/Resume`, {
      query: {
        Limit: limit,
        Recursive: true,
        IncludeItemTypes: ["Movie", "Series", "Episode", "Video"],
        Fields: ["Overview", "PrimaryImageAspectRatio", "RunTimeTicks"]
      },
      signal
    });
  }

  getLatest(userId, { limit = 12, signal } = {}) {
    return this.request(`Users/${encodeURIComponent(userId)}/Items/Latest`, {
      query: {
        Limit: limit,
        IncludeItemTypes: ["Movie", "Series", "Episode", "Video"],
        Fields: ["Overview", "PrimaryImageAspectRatio", "RunTimeTicks"]
      },
      signal
    });
  }

  getLibraryItems(userId, parentId, { startIndex = 0, limit = 60, signal } = {}) {
    return this.request(`Users/${encodeURIComponent(userId)}/Items`, {
      query: {
        ParentId: parentId,
        StartIndex: Math.max(0, Math.round(Number(startIndex) || 0)),
        Limit: Math.min(100, Math.max(1, Math.round(Number(limit) || 60))),
        Recursive: false,
        SortBy: ["SortName"],
        SortOrder: "Ascending",
        EnableTotalRecordCount: true,
        ImageTypeLimit: 1,
        Fields: ["Overview", "PrimaryImageAspectRatio", "RunTimeTicks", "ProductionYear", "ChildCount"]
      },
      signal
    });
  }

  search(userId, term, { limit = 30, signal } = {}) {
    return this.request(`Users/${encodeURIComponent(userId)}/Items`, {
      query: {
        SearchTerm: term,
        Limit: Math.min(30, Math.max(1, limit)),
        Recursive: true,
        EnableTotalRecordCount: false,
        ImageTypeLimit: 1,
        GroupProgramsBySeries: true,
        Fields: ["Overview", "PrimaryImageAspectRatio", "RunTimeTicks", "ProductionYear", "Status", "EndDate"]
      },
      signal
    });
  }

  getSeasons(seriesId, userId, { signal } = {}) {
    return this.request(`Shows/${encodeURIComponent(seriesId)}/Seasons`, {
      query: { UserId: userId, Fields: ["Overview", "PrimaryImageAspectRatio"] },
      signal
    });
  }

  getEpisodes(seriesId, userId, { seasonId, signal } = {}) {
    return this.request(`Shows/${encodeURIComponent(seriesId)}/Episodes`, {
      query: {
        UserId: userId,
        SeasonId: seasonId,
        Fields: ["Overview", "PrimaryImageAspectRatio", "RunTimeTicks"]
      },
      signal
    });
  }

  getPlaybackInfo(itemId, userId, { startTimeTicks = 0, subtitleStreamIndex = null, signal } = {}) {
    const body = {
      UserId: userId,
      StartTimeTicks: ticks(startTimeTicks),
      MaxStreamingBitrate: 8_000_000,
      EnableDirectPlay: false,
      EnableDirectStream: false,
      EnableTranscoding: true,
      IsPlayback: true,
      AutoOpenLiveStream: false
    };
    if (Number.isSafeInteger(Number(subtitleStreamIndex)) && Number(subtitleStreamIndex) >= 0) {
      body.SubtitleStreamIndex = Number(subtitleStreamIndex);
    }
    return this.request(`Items/${encodeURIComponent(itemId)}/PlaybackInfo`, {
      method: "POST",
      query: { UserId: userId },
      body,
      signal
    });
  }

  reportPlaybackStarted(session, { signal } = {}) {
    return this.request("Sessions/Playing", {
      method: "POST",
      body: this.#playbackPayload(session),
      responseType: "none",
      signal
    });
  }

  reportPlaybackProgress(session, { signal } = {}) {
    return this.request("Sessions/Playing/Progress", {
      method: "POST",
      body: this.#playbackPayload(session, { includeEventName: true }),
      responseType: "none",
      signal
    });
  }

  reportPlaybackStopped(session, { signal } = {}) {
    return this.request("Sessions/Playing/Stopped", {
      method: "POST",
      body: this.#playbackPayload(session),
      responseType: "none",
      signal
    });
  }

  stopActiveEncoding(playSessionId, { signal } = {}) {
    if (!playSessionId) return Promise.resolve(null);
    return this.request("Videos/ActiveEncodings", {
      method: "DELETE",
      query: { DeviceId: this.deviceId, PlaySessionId: playSessionId },
      responseType: "none",
      signal
    });
  }

  async loadResource(input, { signal, responseType = "bytes", maxBytes = this.resourceLimit } = {}) {
    const url = validateSameOriginResource(this.baseUrl, input);
    try {
      return await this.resourceSemaphore.use(signal, async () => {
        const result = await this.request(url, { responseType, maxBytes, signal });
        if (responseType === "text" && (/mpegurl/i.test(result.contentType) || /\.m3u8(?:$|\?)/i.test(result.url))) {
          result.text = sanitizeHlsManifest(result.text, result.url, this.baseUrl);
        }
        return result;
      });
    } catch (cause) {
      if (cause instanceof EmbyError) throw cause;
      if (signal?.aborted || cause?.name === "AbortError") {
        throw new EmbyError("CANCELLED", "Emby 请求已取消", { cause });
      }
      throw cause;
    }
  }

  async loadDirectRange(input, {
    start,
    end,
    signal,
    resolvedUrl = null,
    maxBytes = DEFAULT_DIRECT_RANGE_LIMIT
  } = {}) {
    if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(end) || end < start) {
      throw new EmbyError("INVALID_RANGE", "媒体 Range 参数无效");
    }
    const requestedBytes = end - start + 1;
    const limit = Math.min(DEFAULT_DIRECT_RANGE_LIMIT, Math.max(1, Number(maxBytes) || DEFAULT_DIRECT_RANGE_LIMIT));
    if (requestedBytes > limit) {
      throw new EmbyError("RANGE_TOO_LARGE", `单次媒体 Range 不能超过 ${limit} 字节`);
    }

    const baseOrigin = new URL(this.baseUrl).origin;
    let requestUrl = resolvedUrl
      ? await this.validateExternalUrlOnce(resolvedUrl)
      : new URL(sanitizeDirectStreamUrl(this.baseUrl, input));
    let external = requestUrl.origin !== baseOrigin;

    for (let redirectCount = 0; redirectCount <= 4; redirectCount += 1) {
      const headers = {
        Accept: "video/mp4,application/octet-stream;q=0.9,*/*;q=0.1",
        Range: `bytes=${start}-${end}`,
        "User-Agent": EMBY_USER_AGENT
      };
      if (!external) {
        headers["X-Emby-Authorization"] = embyAuthorizationHeader(this.deviceId);
        if (this.token) headers["X-Emby-Token"] = this.token;
      }

      let response;
      try {
        if (external && this.externalStreamTransport) {
          // 生产默认路径：走带 DNS 钉扎的 keep-alive 流传输。它的 connect() 逐连接做
          // resolveExternalMediaAddress、响应落地后校验 response.url，SSRF 防线完整，
          // 因此省掉原来每 Range 一次的 HEAD 预检和 /usr/bin/curl 子进程
          // （一部 2GB 电影 ≈ 2000 次进程创建 + 2000 次 HEAD）。
          response = await this.externalStreamTransport.request(requestUrl, { method: "GET", headers, signal });
        } else {
          const requestImpl = external ? this.directFetchImpl : this.fetchImpl;
          if (external && this.directFollowsRedirects) {
            await preflightExternalRedirects(requestUrl, { dnsLookup: this.dnsLookup, signal });
          }
          response = await requestImpl(requestUrl, { method: "GET", headers, signal, redirect: "manual" });
        }
      } catch (cause) {
        if (cause instanceof EmbyError) throw cause;
        if (signal?.aborted || cause?.name === "AbortError") {
          throw new EmbyError("CANCELLED", "媒体 Range 请求已取消", { cause });
        }
        throw new EmbyError("NETWORK_ERROR", "读取直连媒体失败", { retryable: true, cause });
      }

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location || redirectCount === 4) {
          throw new EmbyError("UNSAFE_MEDIA_REDIRECT", "媒体重定向无效或次数过多");
        }
        const next = new URL(location, requestUrl);
        if (next.origin === baseOrigin) {
          requestUrl = new URL(sanitizeDirectStreamUrl(this.baseUrl, next));
          external = false;
        } else {
          requestUrl = await validateExternalMediaUrl(next, { dnsLookup: this.dnsLookup });
          external = true;
        }
        continue;
      }

      if (!response.ok) {
        await response.body?.cancel();
        if (external && [401, 403, 404].includes(response.status)) {
          throw new EmbyError("DIRECT_URL_EXPIRED", "媒体 CDN 地址已失效", {
            status: response.status,
            retryable: true
          });
        }
        if (external) {
          throw new EmbyError("MEDIA_CDN_ERROR", `媒体 CDN 请求失败（HTTP ${response.status}）`, {
            status: response.status,
            retryable: response.status === 408 || response.status === 429 || response.status >= 500
          });
        }
        throw httpError(response.status);
      }

      const declaredLength = Number(response.headers.get("content-length"));
      const contentRange = parseContentRange(response.headers.get("content-range"));
      if (response.status !== 206 && (!Number.isFinite(declaredLength) || declaredLength > limit)) {
        await response.body?.cancel();
        throw new EmbyError("RANGE_UNSUPPORTED", "媒体服务器没有按 Range 返回分块数据");
      }
      const bytes = await readLimited(response, limit);
      if (bytes.byteLength > requestedBytes) {
        throw new EmbyError("INVALID_RANGE_RESPONSE", "媒体服务器返回了超出请求范围的数据");
      }
      return {
        bytes,
        start: contentRange?.start ?? start,
        end: contentRange?.end ?? (start + bytes.byteLength - 1),
        total: contentRange?.total ?? (response.status === 200 ? bytes.byteLength : null),
        contentType: response.headers.get("content-type") ?? "application/octet-stream",
        resolvedUrl: external ? requestUrl.href : null
      };
    }
    throw new EmbyError("UNSAFE_MEDIA_REDIRECT", "媒体重定向次数过多");
  }

  async openDirectRangeStream(input, {
    start,
    end = null,
    signal,
    resolvedUrl = null
  } = {}) {
    if (
      !Number.isSafeInteger(start)
      || start < 0
      || (end !== null && (!Number.isSafeInteger(end) || end < start))
    ) {
      throw new EmbyError("INVALID_RANGE", "媒体流 Range 参数无效");
    }

    const baseOrigin = new URL(this.baseUrl).origin;
    let requestUrl = resolvedUrl
      ? await validateExternalMediaUrl(resolvedUrl, { dnsLookup: this.dnsLookup })
      : new URL(sanitizeDirectStreamUrl(this.baseUrl, input));
    let external = requestUrl.origin !== baseOrigin;

    for (let redirectCount = 0; redirectCount <= 4; redirectCount += 1) {
      const headers = {
        Accept: "video/mp4,video/x-matroska,application/octet-stream;q=0.9,*/*;q=0.1",
        Range: `bytes=${start}-${end === null ? "" : end}`,
        "User-Agent": EMBY_USER_AGENT
      };
      if (!external) {
        headers["X-Emby-Authorization"] = embyAuthorizationHeader(this.deviceId);
        if (this.token) headers["X-Emby-Token"] = this.token;
      }

      let response;
      try {
        const requestImpl = external ? this.directStreamFetchImpl : this.fetchImpl;
        const requestOptions = {
          method: "GET",
          headers,
          signal,
          redirect: external && this.directStreamFollowsRedirects ? "follow" : "manual"
        };
        // 同源流附带带 bodyTimeout 的 dispatcher，避免半开的 Emby 套接字让播放永久卡死。
        if (!external && this.sameOriginStreamDispatcher && requestImpl === globalThis.fetch) {
          requestOptions.dispatcher = this.sameOriginStreamDispatcher;
        }
        response = await requestImpl(requestUrl, requestOptions);
      } catch (cause) {
        if (cause instanceof EmbyError) throw cause;
        if (signal?.aborted || cause?.name === "AbortError") {
          throw new EmbyError("CANCELLED", "媒体流请求已取消", { cause });
        }
        throw new EmbyError("NETWORK_ERROR", "读取直连媒体流失败", { retryable: true, cause });
      }

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (typeof response.body?.cancel === "function") await response.body.cancel().catch(() => {});
        else response.body?.destroy?.();
        if (!location || redirectCount === 4) {
          throw new EmbyError("UNSAFE_MEDIA_REDIRECT", "媒体流重定向无效或次数过多");
        }
        const next = new URL(location, requestUrl);
        if (next.origin === baseOrigin) {
          requestUrl = new URL(sanitizeDirectStreamUrl(this.baseUrl, next));
          external = false;
        } else {
          requestUrl = await validateExternalMediaUrl(next, { dnsLookup: this.dnsLookup });
          external = true;
        }
        continue;
      }

      if (!response.ok) {
        if (typeof response.body?.cancel === "function") await response.body.cancel().catch(() => {});
        else response.body?.destroy?.();
        if (external && [401, 403, 404].includes(response.status)) {
          throw new EmbyError("DIRECT_URL_EXPIRED", "媒体 CDN 地址已失效", {
            status: response.status,
            retryable: true
          });
        }
        if (external) {
          throw new EmbyError("MEDIA_CDN_ERROR", `媒体 CDN 流请求失败（HTTP ${response.status}）`, {
            status: response.status,
            retryable: response.status === 408 || response.status === 429 || response.status >= 500
          });
        }
        throw httpError(response.status);
      }

      const contentRange = parseContentRange(response.headers.get("content-range"));
      if (response.status !== 206 || !contentRange || contentRange.start !== start) {
        if (typeof response.body?.cancel === "function") await response.body.cancel().catch(() => {});
        else response.body?.destroy?.();
        throw new EmbyError("RANGE_UNSUPPORTED", "媒体服务器不支持持续 Range 流");
      }
      if (!response.body || typeof response.body[Symbol.asyncIterator] !== "function") {
        if (typeof response.body?.cancel === "function") await response.body.cancel().catch(() => {});
        else response.body?.destroy?.();
        throw new EmbyError("MEDIA_STREAM_UNAVAILABLE", "媒体服务器没有返回可读取的数据流");
      }

      return {
        body: response.body,
        start: contentRange.start,
        end: contentRange.end,
        total: contentRange.total,
        contentType: response.headers.get("content-type") ?? "application/octet-stream",
        resolvedUrl: external ? requestUrl.href : null,
        cancel: async (reason) => {
          if (typeof response.body?.cancel === "function") {
            await response.body.cancel(reason).catch(() => {});
          } else {
            response.body?.destroy?.();
          }
        }
      };
    }
    throw new EmbyError("UNSAFE_MEDIA_REDIRECT", "媒体流重定向次数过多");
  }

  #playbackPayload(session, { includeEventName = false } = {}) {
    const payload = {
      ItemId: session.itemId,
      MediaSourceId: session.mediaSourceId,
      PlaySessionId: session.playSessionId,
      PositionTicks: ticks(session.positionTicks),
      IsPaused: Boolean(session.isPaused),
      IsMuted: Boolean(session.isMuted),
      VolumeLevel: Math.max(0, Math.min(100, Number(session.volumeLevel ?? 100))),
      PlayMethod: session.playMethod ?? "Transcode",
      CanSeek: true
    };
    if (includeEventName) payload.EventName = session.eventName ?? "TimeUpdate";
    if (Number.isSafeInteger(session.subtitleStreamIndex) && session.subtitleStreamIndex >= 0) {
      payload.SubtitleStreamIndex = session.subtitleStreamIndex;
    }
    return payload;
  }
}
