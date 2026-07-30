import { validateExternalMediaUrl } from "./emby-client.mjs";
import dns from "node:dns";
import https from "node:https";
import { Readable } from "node:stream";

export const HONGGUO_SOURCE = "https://hongguoduanju.com";
export const HONGGUO_RESOURCE_LIMIT = 2 * 1024 * 1024;

const HONGGUO_FALLBACK_HOST = "www.hongguoduanju.com";

const PAGE_LIMIT = 4 * 1024 * 1024;
const IMAGE_LIMIT = 2 * 1024 * 1024;
const HOME_CACHE_MS = 5 * 60 * 1000;
const HOME_STALE_CACHE_MS = 7 * 24 * 60 * 60 * 1000;
const PAGE_RETRY_DELAYS_MS = [0, 250, 1_000];
// 单条传输通道的超时：实测官网 TTFB ≈1.1-1.4s、整页 ≈2.5s（企业网络抖动下更慢），
// 原来的 2.5s 正好卡在分布中位——一半以上的请求被误杀成「无法连接官网」。
// 8s 覆盖慢响应；IPv6→IPv4→备用链路的级联只在硬失败时发生（多为秒拒），
// 黑洞场景最坏 3×8s=24s，仍在渲染层 30s RPC 预算内。
const PAGE_TRANSPORT_TIMEOUT_MS = 8_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36";
const IPV6_PAGE_AGENT = new https.Agent({
  lookup(hostname, options, callback) {
    dns.lookup(hostname, {
      family: 6,
      hints: options.hints,
      all: options.all === true
    }, callback);
  }
});

export class HongguoError extends Error {
  constructor(code, message, { status = null, retryable = false, cause } = {}) {
    super(message, { cause });
    this.name = "HongguoError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

function pageHeaders(cookie = "") {
  const headers = {
    Accept: "text/html,application/xhtml+xml",
    "Accept-Language": "zh-CN,zh;q=0.9",
    Referer: `${HONGGUO_SOURCE}/`,
    "User-Agent": USER_AGENT
  };
  if (cookie) headers.Cookie = cookie;
  return headers;
}

function resourceHeaders(range, referer = `${HONGGUO_SOURCE}/`) {
  const headers = {
    Accept: "*/*",
    "Accept-Language": "zh-CN,zh;q=0.9",
    Referer: referer,
    "User-Agent": USER_AGENT
  };
  if (range) headers.Range = range;
  return headers;
}

function fetchPageOverIpv6(url, { headers = {}, signal } = {}) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: "GET",
      headers,
      signal,
      agent: IPV6_PAGE_AGENT
    }, (incoming) => {
      try {
        const response = new Response(Readable.toWeb(incoming), {
          status: incoming.statusCode,
          statusText: incoming.statusMessage,
          headers: incoming.headers
        });
        Object.defineProperty(response, "url", { value: String(url) });
        resolve(response);
      } catch (error) {
        incoming.destroy();
        reject(error);
      }
    });
    request.once("error", reject);
    request.end();
  });
}

function fetchPageViaOfficialFallback(url, { headers = {}, signal } = {}) {
  const logicalUrl = new URL(url);
  if (logicalUrl.origin !== HONGGUO_SOURCE) {
    throw new HongguoError("UNSAFE_PAGE_URL", "拒绝访问红果官网以外的页面");
  }
  const transportUrl = new URL(logicalUrl);
  transportUrl.hostname = HONGGUO_FALLBACK_HOST;
  return new Promise((resolve, reject) => {
    const request = https.request(transportUrl, {
      method: "GET",
      headers: { ...headers, Host: logicalUrl.host },
      signal
    }, (incoming) => {
      try {
        const response = new Response(Readable.toWeb(incoming), {
          status: incoming.statusCode,
          statusText: incoming.statusMessage,
          headers: incoming.headers
        });
        // Keep redirect and origin validation bound to the logical official URL,
        // not to the alternate official TLS entry point used for transport.
        Object.defineProperty(response, "url", { value: logicalUrl.href });
        resolve(response);
      } catch (error) {
        incoming.destroy();
        reject(error);
      }
    });
    request.once("error", reject);
    request.end();
  });
}

async function runPageTransport(fetchImpl, url, options, timeoutMs) {
  const signal = options?.signal;
  if (signal?.aborted) throw signal.reason ?? new DOMException("请求已取消", "AbortError");
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal.reason);
  signal?.addEventListener("abort", forwardAbort, { once: true });
  const timeoutError = new HongguoError("SOURCE_NETWORK_TIMEOUT", "连接红果官网超时", { retryable: true });
  const timeout = setTimeout(() => controller.abort(timeoutError), timeoutMs);
  const aborted = new Promise((resolve, reject) => {
    controller.signal.addEventListener("abort", () => {
      reject(controller.signal.reason ?? new DOMException("请求已取消", "AbortError"));
    }, { once: true });
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => fetchImpl(url, { ...options, signal: controller.signal })),
      aborted
    ]);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", forwardAbort);
  }
}

export async function fetchOfficialPage(url, options, {
  ipv6FetchImpl = fetchPageOverIpv6,
  defaultFetchImpl = globalThis.fetch,
  fallbackFetchImpl = fetchPageViaOfficialFallback,
  transportTimeoutMs = PAGE_TRANSPORT_TIMEOUT_MS
} = {}) {
  try {
    return await runPageTransport(ipv6FetchImpl, url, options, transportTimeoutMs);
  } catch (ipv6Error) {
    if (options?.signal?.aborted) throw options.signal.reason ?? ipv6Error;
    try {
      return await runPageTransport(defaultFetchImpl, url, options, transportTimeoutMs);
    } catch (ipv4Error) {
      if (options?.signal?.aborted) throw options.signal.reason ?? ipv4Error;
      try {
        return await runPageTransport(fallbackFetchImpl, url, options, transportTimeoutMs);
      } catch (fallbackError) {
        fallbackError.ipv6Cause = ipv6Error;
        fallbackError.ipv4Cause = ipv4Error;
        throw fallbackError;
      }
    }
  }
}

async function readLimited(response, limit, label) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel();
    throw new HongguoError("RESPONSE_TOO_LARGE", `${label}超过大小限制`);
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
        throw new HongguoError("RESPONSE_TOO_LARGE", `${label}超过大小限制`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function waitForRetry(delayMs, signal) {
  if (delayMs <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function assignedJson(html, assignment) {
  const source = String(html);
  const marker = source.indexOf(assignment);
  if (marker < 0) return null;
  const start = source.indexOf("{", marker + assignment.length);
  if (start < 0) return null;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  return null;
}

export function parseRouterData(html) {
  const json = assignedJson(html, "window._ROUTER_DATA");
  if (!json) throw new HongguoError("PAGE_DATA_MISSING", "红果官网页面没有返回可识别的数据", { retryable: true });
  try {
    return JSON.parse(json);
  } catch (cause) {
    throw new HongguoError("PAGE_DATA_INVALID", "红果官网页面数据解析失败", { retryable: true, cause });
  }
}

function episodeCount(item) {
  const explicit = Number(item?.episode_cnt ?? item?.series_episode_info?.episode_cnt);
  if (Number.isSafeInteger(explicit) && explicit >= 0) return explicit;
  const match = /(?:全|共)\s*(\d+)\s*集/.exec(String(item?.episode_right_text || ""));
  return Number(match?.[1] || 0);
}

function mapSeries(item) {
  if (!item?.series_id || !item?.series_name) return null;
  return {
    id: String(item.series_id),
    name: String(item.series_name),
    posterUrl: typeof item.series_cover === "string"
      ? item.series_cover
      : typeof item.background_cover === "string" ? item.background_cover : null,
    totalEpisodes: episodeCount(item),
    description: String(item.series_intro || "").trim(),
    tags: Array.isArray(item.tags) ? item.tags.map(String).slice(0, 8) : []
  };
}

function pageLoader(routerData, key) {
  const loaderData = routerData?.loaderData;
  if (!loaderData || typeof loaderData !== "object") return null;
  if (loaderData[key]) return loaderData[key];
  return Object.entries(loaderData).find(([name]) => name.startsWith(key))?.[1] ?? null;
}

export function parseHomeData(html) {
  const page = pageLoader(parseRouterData(html), "page");
  const videoList = Array.isArray(page?.videoList) ? page.videoList : [];
  const all = videoList.map(mapSeries).filter(Boolean);
  const videoById = new Map(videoList.map((item) => [String(item?.series_id || ""), item]));
  const banners = Array.isArray(page?.mBannerList) && page.mBannerList.length > 0
    ? page.mBannerList
    : Array.isArray(page?.bannerList) ? page.bannerList : [];
  const featured = [];
  const seen = new Set();
  const mappedBanners = banners.map((banner) => {
    const listed = videoById.get(String(banner?.series_id || ""));
    return mapSeries({
      ...listed,
      ...banner,
      series_cover: banner?.series_cover || listed?.series_cover || banner?.background_cover
    });
  }).filter(Boolean);
  for (const mapped of [...mappedBanners, ...all]) {
    if (!mapped || seen.has(mapped.id)) continue;
    seen.add(mapped.id);
    featured.push(mapped);
    if (featured.length >= 12) break;
  }
  return { featured, items: all };
}

export function parseDetailData(html) {
  const detailPage = pageLoader(parseRouterData(html), "detail_page");
  const detail = detailPage?.seriesDetail;
  const mapped = mapSeries(detail);
  if (!mapped) throw new HongguoError("DETAIL_MISSING", "红果官网没有返回该短剧详情", { retryable: true });
  const fullEpisodeCount = episodeCount(detail);
  const episodeIds = Array.isArray(detail?.vid_list) ? detail.vid_list.map(String).filter(Boolean) : [];
  const declaredAccessible = Number(detail?.accessible_episode_cnt);
  const accessibleEpisodeCount = Math.max(0, Math.min(
    fullEpisodeCount || episodeIds.length,
    Number.isSafeInteger(declaredAccessible) ? declaredAccessible : episodeIds.length
  ));
  return {
    ...mapped,
    totalEpisodes: accessibleEpisodeCount,
    accessibleEpisodeCount,
    fullEpisodeCount,
    episodeIds
  };
}

export function parsePlayerData(html) {
  const loaderData = parseRouterData(html)?.loaderData;
  const playerPage = loaderData && typeof loaderData === "object"
    ? Object.values(loaderData).find((value) => {
      return value?.series_id && value?.vid && typeof value?.video_player_info === "object";
    })
    : null;
  const info = playerPage?.video_player_info;
  const mp4Url = typeof info?.main_url === "string" ? info.main_url : "";
  if (!/^https:\/\//i.test(mp4Url)) {
    throw new HongguoError("VIDEO_SOURCE_MISSING", "红果官网没有返回这一集的视频地址", { retryable: true });
  }
  return {
    seriesId: String(playerPage?.series_id || ""),
    videoId: String(playerPage?.vid || ""),
    mp4Url,
    durationSeconds: Number(info?.duration) || null,
    width: Number(info?.width) || null,
    height: Number(info?.height) || null
  };
}

function parseContentRange(value) {
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(String(value || "").trim());
  if (!match) return null;
  return {
    start: Number(match[1]),
    end: Number(match[2]),
    total: match[3] === "*" ? null : Number(match[3])
  };
}

function validSeriesId(value) {
  return /^\d{1,24}$/.test(String(value ?? "").trim());
}

export class HongguoClient {
  constructor({
    source = HONGGUO_SOURCE,
    fetchImpl = globalThis.fetch,
    pageFetchImpl,
    validateMediaUrl = validateExternalMediaUrl,
    resourceLimit = HONGGUO_RESOURCE_LIMIT,
    catalogCache = null,
    pageRetryDelays = PAGE_RETRY_DELAYS_MS,
    now = Date.now
  } = {}) {
    const sourceUrl = new URL(source);
    if (sourceUrl.origin !== HONGGUO_SOURCE) throw new TypeError("红果内容源必须是 hongguoduanju.com");
    this.source = sourceUrl.origin;
    this.fetchImpl = fetchImpl;
    this.pageFetchImpl = pageFetchImpl ?? (fetchImpl === globalThis.fetch ? fetchOfficialPage : fetchImpl);
    this.validateMediaUrl = validateMediaUrl;
    this.resourceLimit = resourceLimit;
    this.catalogCache = catalogCache;
    this.pageRetryDelays = Array.isArray(pageRetryDelays) && pageRetryDelays.length > 0
      ? pageRetryDelays.map((delay) => Math.max(0, Number(delay) || 0))
      : [...PAGE_RETRY_DELAYS_MS];
    this.now = now;
    this.cookie = "";
    this.homeCache = null;
    this.homeCacheLoaded = false;
    this.homeRefresh = null;
  }

  #rememberCookie(response) {
    const values = typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie")].filter(Boolean);
    const pairs = values.map((value) => String(value).split(";", 1)[0]).filter((value) => /^[^=]+=/.test(value));
    if (pairs.length > 0) this.cookie = pairs.join("; ");
  }

  async #page(path, { signal } = {}) {
    const requested = new URL(path, `${this.source}/`);
    if (requested.origin !== this.source) throw new HongguoError("UNSAFE_PAGE_URL", "拒绝访问红果官网以外的页面");
    let lastError = null;
    for (let attempt = 0; attempt < this.pageRetryDelays.length; attempt += 1) {
      await waitForRetry(this.pageRetryDelays[attempt], signal);
      try {
        let current = requested;
        let response;
        for (let redirects = 0; redirects <= 3; redirects += 1) {
          response = await this.pageFetchImpl(current, {
            headers: pageHeaders(this.cookie),
            redirect: "manual",
            signal
          });
          this.#rememberCookie(response);
          if (!REDIRECT_STATUSES.has(response.status)) break;
          const location = response.headers.get("location");
          await response.body?.cancel();
          const next = location ? new URL(location, current) : null;
          if (!next || next.origin !== this.source || redirects === 3) {
            throw new HongguoError("SOURCE_REDIRECT_ERROR", "红果官网页面重定向无效", { retryable: true });
          }
          current = next;
        }
        if (!response?.ok) {
          const status = response?.status || 0;
          await response?.body?.cancel();
          throw new HongguoError("SOURCE_HTTP_ERROR", `红果官网暂时不可用（HTTP ${status}）`, {
            status,
            retryable: status === 408 || status === 429 || status >= 500
          });
        }
        const bytes = await readLimited(response, PAGE_LIMIT, "红果官网页面");
        return new TextDecoder().decode(bytes);
      } catch (cause) {
        if (signal?.aborted || cause?.name === "AbortError") throw cause;
        lastError = cause instanceof HongguoError
          ? cause
          : new HongguoError("SOURCE_NETWORK_ERROR", "无法连接红果短剧官网", { retryable: true, cause });
        if (!lastError.retryable || attempt === this.pageRetryDelays.length - 1) break;
      }
    }
    throw lastError;
  }

  async #loadCachedHome() {
    if (this.homeCacheLoaded) return;
    this.homeCacheLoaded = true;
    if (!this.catalogCache?.load) return;
    try {
      const snapshot = await this.catalogCache.load();
      if (
        snapshot?.data
        && Array.isArray(snapshot.data.featured)
        && Array.isArray(snapshot.data.items)
        && this.now() - Number(snapshot.at) <= HOME_STALE_CACHE_MS
      ) {
        this.homeCache = snapshot;
      }
    } catch {
      // 磁盘快照只是韧性兜底，损坏或不可读不能阻断官网请求。
    }
  }

  async #refreshHome({ signal } = {}) {
    if (this.homeRefresh) return this.homeRefresh;
    const refresh = (async () => {
      const data = parseHomeData(await this.#page("/", { signal }));
      if (data.featured.length === 0) {
        throw new HongguoError("HOME_EMPTY", "红果官网首页暂时没有返回短剧目录", { retryable: true });
      }
      this.homeCache = { at: this.now(), data };
      await this.catalogCache?.save?.(this.homeCache).catch(() => {});
      return data;
    })();
    this.homeRefresh = refresh;
    try {
      return await refresh;
    } finally {
      if (this.homeRefresh === refresh) this.homeRefresh = null;
    }
  }

  async home({ signal, refresh = false } = {}) {
    await this.#loadCachedHome();
    const cacheAge = this.homeCache ? this.now() - this.homeCache.at : Infinity;
    if (!refresh && this.homeCache && cacheAge < HOME_CACHE_MS) {
      return { data: this.homeCache.data, cacheStatus: "fresh" };
    }
    if (!refresh && this.homeCache && cacheAge <= HOME_STALE_CACHE_MS) {
      void this.#refreshHome().catch(() => {});
      return { data: this.homeCache.data, cacheStatus: "stale" };
    }
    try {
      return { data: await this.#refreshHome({ signal }), cacheStatus: "network" };
    } catch (error) {
      if (
        this.homeCache?.data?.featured?.length > 0
        && this.now() - this.homeCache.at <= HOME_STALE_CACHE_MS
      ) {
        return { data: this.homeCache.data, cacheStatus: "stale" };
      }
      throw error;
    }
  }

  async featured({ signal, refresh = false } = {}) {
    return (await this.home({ signal, refresh })).data.featured;
  }

  async detail(dramaId, { signal } = {}) {
    const id = String(dramaId ?? "").trim();
    if (!validSeriesId(id)) throw new HongguoError("INVALID_DRAMA_ID", "短剧 ID 无效");
    return parseDetailData(await this.#page(`/detail?series_id=${id}`, { signal }));
  }

  async episodeSource(dramaId, episode, { signal } = {}) {
    const id = String(dramaId ?? "").trim();
    const index = Number(episode);
    if (!validSeriesId(id) || !Number.isSafeInteger(index) || index < 1) {
      throw new HongguoError("INVALID_EPISODE", "短剧集数无效");
    }
    const detail = await this.detail(id, { signal });
    if (index > detail.accessibleEpisodeCount) {
      throw new HongguoError(
        "EPISODE_NOT_ACCESSIBLE",
        `红果官网当前只开放前 ${detail.accessibleEpisodeCount} 集，无法播放第 ${index} 集`
      );
    }
    const videoId = detail.episodeIds[index - 1];
    if (!videoId) throw new HongguoError("VIDEO_ID_MISSING", "红果官网没有返回这一集的视频 ID", { retryable: true });
    const path = index === 1 ? `/player/${id}` : `/player/${id}/${videoId}`;
    const player = parsePlayerData(await this.#page(path, { signal }));
    return { ...player, referer: new URL(path, `${this.source}/`).href };
  }

  async loadRange(urlValue, { start, end, resolvedUrl, referer, signal } = {}) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
      throw new HongguoError("INVALID_RANGE", "视频分片范围无效");
    }
    if (end - start + 1 > this.resourceLimit) {
      throw new HongguoError("RESPONSE_TOO_LARGE", "视频分片超过大小限制");
    }
    let current = await this.validateMediaUrl(resolvedUrl || urlValue);
    let response;
    for (let redirects = 0; redirects <= 4; redirects += 1) {
      try {
        response = await this.fetchImpl(current, {
          headers: resourceHeaders(`bytes=${start}-${end}`, referer),
          redirect: "manual",
          signal
        });
      } catch (cause) {
        if (signal?.aborted || cause?.name === "AbortError") throw cause;
        throw new HongguoError("MEDIA_NETWORK_ERROR", "红果视频 CDN 连接失败", { retryable: true, cause });
      }
      if (!REDIRECT_STATUSES.has(response.status)) break;
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location || redirects === 4) {
        throw new HongguoError("MEDIA_REDIRECT_ERROR", "红果视频 CDN 重定向无效", { retryable: true });
      }
      current = await this.validateMediaUrl(new URL(location, current).href);
    }
    if (response?.status !== 206) {
      const status = response?.status || 0;
      await response?.body?.cancel();
      throw new HongguoError(
        status === 403 ? "DIRECT_URL_EXPIRED" : "MEDIA_RANGE_UNSUPPORTED",
        status === 403 ? "红果视频地址已过期，请重新打开这一集" : `红果视频源不支持分段读取（HTTP ${status}）`,
        { status, retryable: status === 403 || status === 408 || status === 429 || status >= 500 }
      );
    }
    const range = parseContentRange(response.headers.get("content-range"));
    if (!range || range.start !== start || range.end > end || !Number.isSafeInteger(range.total)) {
      await response.body?.cancel();
      throw new HongguoError("INVALID_RANGE_RESPONSE", "红果视频 CDN 返回了无效的分片范围", { retryable: true });
    }
    const bytes = await readLimited(response, this.resourceLimit, "视频分片");
    return {
      bytes,
      start: range.start,
      end: range.end,
      total: range.total,
      resolvedUrl: current.href,
      contentType: response.headers.get("content-type") || "video/mp4"
    };
  }

  async loadImage(urlValue, { signal } = {}) {
    let current = await this.validateMediaUrl(urlValue);
    let response;
    for (let redirects = 0; redirects <= 4; redirects += 1) {
      try {
        response = await this.fetchImpl(current, {
          headers: resourceHeaders(),
          redirect: "manual",
          signal
        });
      } catch (cause) {
        if (signal?.aborted || cause?.name === "AbortError") throw cause;
        throw new HongguoError("IMAGE_NETWORK_ERROR", "红果短剧封面加载失败", { retryable: true, cause });
      }
      if (!REDIRECT_STATUSES.has(response.status)) break;
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location || redirects === 4) throw new HongguoError("IMAGE_REDIRECT_ERROR", "红果短剧封面重定向无效");
      current = await this.validateMediaUrl(new URL(location, current).href);
    }
    if (!response?.ok) {
      const status = response?.status || 0;
      await response?.body?.cancel();
      throw new HongguoError("IMAGE_HTTP_ERROR", `红果短剧封面加载失败（HTTP ${status}）`, {
        status,
        retryable: status === 408 || status === 429 || status >= 500
      });
    }
    const bytes = await readLimited(response, IMAGE_LIMIT, "红果短剧封面");
    return { url: current.href, contentType: response.headers.get("content-type") || "image/jpeg", bytes };
  }
}

const defaultClient = new HongguoClient();

export const getDramaDetail = (dramaId, options) => defaultClient.detail(dramaId, options);
export const getEpisodeVideo = (dramaId, episode = 1, options) => defaultClient.episodeSource(dramaId, episode, options);
