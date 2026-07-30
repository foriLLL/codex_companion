import { randomUUID } from "node:crypto";
import { DirectMp4Session } from "./direct-mp4-session.mjs";
import { HongguoClient, HongguoError } from "./hongguo.mjs";
import { HongguoCatalogStorage } from "./hongguo-storage.mjs";
import { HongguoListStorage, normalizeListEntry } from "./hongguo-list-storage.mjs";

function stringParam(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new HongguoError("INVALID_ARGUMENT", `${name} 不能为空`);
  }
  return value.trim();
}

function encodeBytes(bytes, contentType, url) {
  return {
    url,
    contentType,
    encoding: "base64",
    data: Buffer.from(bytes).toString("base64")
  };
}

const DEFAULT_FEED_PAGE_SIZE = 20;
const MAX_FEED_PAGE_SIZE = 40;
// 封面白名单容量：feed 滚动 + 片单会累积大量 posterUrl；600 太小，长会话滚动
// 超过后老封面再请求会被 UNSAFE_IMAGE_URL 永久拒掉（渲染侧对非 retryable 不重试，
// 位置永久空白）。4096 条约几百 KB 字符串，可接受；FIFO 逐出保留作内存兜底。
const KNOWN_IMAGES_LIMIT = 4096;

function feedPageSize(value) {
  return Math.min(MAX_FEED_PAGE_SIZE, Math.max(1, Math.round(Number(value) || DEFAULT_FEED_PAGE_SIZE)));
}

function uniqueCatalog(data) {
  const result = [];
  const seen = new Set();
  for (const item of [...(data?.featured ?? []), ...(data?.items ?? [])]) {
    const id = String(item?.id ?? "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(item);
  }
  return result;
}

function shuffled(items, random) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const sampled = Number(random());
    const ratio = Number.isFinite(sampled) ? Math.max(0, Math.min(0.999999999, sampled)) : 0;
    const target = Math.min(index, Math.floor(ratio * (index + 1)));
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}

class Semaphore {
  #available;
  #queue = [];

  constructor(limit) { this.#available = limit; }

  async use(signal, operation) {
    await this.#acquire(signal);
    try { return await operation(); } finally { this.#release(); }
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

export class HongguoService {
  #client;
  #directSessionFactory;
  #sessions = new Map();
  #feeds = new Map();
  #knownImages = new Set();
  #imageSemaphore = new Semaphore(4);
  #random;
  #listStorage;

  constructor({
    client = new HongguoClient({ catalogCache: new HongguoCatalogStorage() }),
    directSessionFactory = (options) => new DirectMp4Session(options),
    listStorage = new HongguoListStorage(),
    randomImpl = Math.random
  } = {}) {
    if (typeof randomImpl !== "function") throw new TypeError("randomImpl 必须是函数");
    this.#client = client;
    this.#directSessionFactory = directSessionFactory;
    this.#listStorage = listStorage;
    this.#random = randomImpl;
  }

  #rememberImages(items) {
    for (const item of items) {
      if (item?.posterUrl) this.#knownImages.add(item.posterUrl);
    }
    while (this.#knownImages.size > KNOWN_IMAGES_LIMIT) this.#knownImages.delete(this.#knownImages.values().next().value);
    return items;
  }

  #clearTargetFeeds(targetId) {
    for (const [cursor, feed] of this.#feeds) {
      if (feed.targetId === targetId) this.#feeds.delete(cursor);
    }
  }

  #startFeed(data, targetId, limit) {
    this.#clearTargetFeeds(targetId);
    const catalog = shuffled(uniqueCatalog(data), this.#random);
    const pageSize = feedPageSize(limit);
    const items = this.#rememberImages(catalog.slice(0, pageSize));
    const hasMore = items.length < catalog.length;
    const cursor = hasMore ? randomUUID() : null;
    if (cursor) this.#feeds.set(cursor, { targetId, catalog, offset: items.length });
    return { items, featured: items, cursor, hasMore, total: catalog.length };
  }

  #nextFeed(cursorValue, targetId, limit) {
    const cursor = stringParam(cursorValue, "推荐流游标");
    const feed = this.#feeds.get(cursor);
    if (!feed || feed.targetId !== targetId) {
      throw new HongguoError("FEED_EXPIRED", "推荐流已更新，请重新加载", { retryable: true });
    }
    const pageSize = feedPageSize(limit);
    const items = this.#rememberImages(feed.catalog.slice(feed.offset, feed.offset + pageSize));
    feed.offset += items.length;
    const hasMore = feed.offset < feed.catalog.length;
    if (!hasMore) this.#feeds.delete(cursor);
    return { items, cursor: hasMore ? cursor : null, hasMore, total: feed.catalog.length };
  }

  #session(playbackId, context) {
    const session = this.#sessions.get(playbackId);
    if (!session || session.targetId !== context.targetId) {
      throw new HongguoError("PLAYBACK_NOT_FOUND", "短剧播放会话已失效，请重新选择剧集", { retryable: true });
    }
    return session;
  }

  async handleRpc(method, params = {}, context = {}) {
    if (method === "hongguo.home") {
      if (typeof this.#client.home === "function") {
        const result = await this.#client.home({ signal: context.signal, refresh: params.refresh === true });
        return {
          ...this.#startFeed(result.data, context.targetId, params.limit),
          cacheStatus: result.cacheStatus
        };
      }
      const featured = await this.#client.featured({ signal: context.signal });
      return this.#startFeed({ featured, items: featured }, context.targetId, params.limit);
    }
    if (method === "hongguo.feed.next") {
      return this.#nextFeed(params.cursor, context.targetId, params.limit);
    }
    if (method === "hongguo.list.get") {
      return { items: this.#rememberImages(await this.#listStorage.load()) };
    }
    if (method === "hongguo.list.add") {
      const entry = normalizeListEntry(params.entry ?? params);
      if (!entry) throw new HongguoError("INVALID_ARGUMENT", "片单条目无效");
      return { items: this.#rememberImages(await this.#listStorage.add(entry)) };
    }
    if (method === "hongguo.list.remove") {
      const id = stringParam(params.id, "短剧 ID");
      return { items: this.#rememberImages(await this.#listStorage.remove(id)) };
    }
    if (method === "hongguo.detail") {
      const item = await this.#client.detail(params.dramaId, { signal: context.signal });
      this.#rememberImages([item]);
      return item;
    }
    if (method === "hongguo.image.load") {
      const url = stringParam(params.url, "封面地址");
      if (!this.#knownImages.has(url)) throw new HongguoError("UNSAFE_IMAGE_URL", "拒绝加载未知的短剧封面地址");
      const loaded = await this.#imageSemaphore.use(context.signal, async () => {
        let lastError;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            return await this.#client.loadImage(url, { signal: context.signal });
          } catch (error) {
            lastError = error;
            if (context.signal?.aborted || error?.name === "AbortError" || !error?.retryable) throw error;
          }
        }
        throw lastError;
      });
      return encodeBytes(loaded.bytes, loaded.contentType, loaded.url);
    }
    if (method === "hongguo.playback.open") {
      const dramaId = stringParam(params.dramaId, "短剧 ID");
      const episode = Number(params.episode);
      const source = await this.#client.episodeSource(dramaId, episode, { signal: context.signal });
      const playbackId = randomUUID();
      const session = {
        targetId: context.targetId,
        dramaId,
        episode,
        source,
        resolvedUrl: null,
        refreshedForExpiry: false,
        directSession: null
      };
      session.directSession = this.#directSessionFactory({
        readRange: async ({ start, end, resolvedUrl, signal }) => {
          const attempt = (useResolved) => this.#client.loadRange(session.source.mp4Url, {
            start,
            end,
            resolvedUrl: useResolved ? (resolvedUrl ?? session.resolvedUrl) : undefined,
            referer: session.source.referer,
            signal
          });
          try {
            const result = await attempt(true);
            if (result.resolvedUrl) session.resolvedUrl = result.resolvedUrl;
            // 成功从当前入口取到数据即认为链路健康；重置一次性刷新预算，
            // 让后续（长视频里再次发生的）CDN 过期还能再刷新，而不是刷一次就永久失败。
            session.refreshedForExpiry = false;
            return result;
          } catch (error) {
            if (error?.code !== "DIRECT_URL_EXPIRED" || session.refreshedForExpiry) throw error;
            // 整体过期：重新取源换新的签名地址，再从新地址读一次。
            session.refreshedForExpiry = true;
            session.resolvedUrl = null;
            session.source = await this.#client.episodeSource(dramaId, episode, { signal });
            const result = await attempt(false);
            if (result.resolvedUrl) session.resolvedUrl = result.resolvedUrl;
            // 刷新后的成功读取同样重置预算，保证下一次过期仍可刷新（多次过期不再永久失败）。
            session.refreshedForExpiry = false;
            return result;
          }
        }
      });
      // 同一目标每次只保留一个短剧会话：快速切集 / 漏发 stop 时销毁旧会话，避免僵尸读取流。
      for (const [oldId, oldSession] of this.#sessions) {
        if (oldSession.targetId !== context.targetId) continue;
        oldSession.directSession?.destroy();
        this.#sessions.delete(oldId);
      }
      this.#sessions.set(playbackId, session);
      return {
        playbackId,
        streamMode: "direct-mp4",
        dramaId,
        episode,
        durationSeconds: source.durationSeconds
      };
    }
    if (method === "hongguo.playback.direct.init") {
      const playbackId = stringParam(params.playbackId, "播放会话");
      return this.#session(playbackId, context).directSession.initialize({ signal: context.signal });
    }
    if (method === "hongguo.playback.direct.next") {
      const playbackId = stringParam(params.playbackId, "播放会话");
      return this.#session(playbackId, context).directSession.next({ signal: context.signal });
    }
    if (method === "hongguo.playback.direct.seek") {
      const playbackId = stringParam(params.playbackId, "播放会话");
      return this.#session(playbackId, context).directSession.seek(Number(params.timeSeconds) || 0);
    }
    if (method === "hongguo.playback.stop") {
      const playbackId = stringParam(params.playbackId, "播放会话");
      const session = this.#sessions.get(playbackId);
      if (session?.targetId === context.targetId) {
        session.directSession?.destroy();
        this.#sessions.delete(playbackId);
      }
      return { stopped: true };
    }
    throw new HongguoError("RPC_METHOD_NOT_FOUND", `未知短剧方法：${method}`);
  }

  disposeTarget(targetId) {
    this.#clearTargetFeeds(targetId);
    for (const [playbackId, session] of this.#sessions) {
      if (session.targetId !== targetId) continue;
      session.directSession?.destroy();
      this.#sessions.delete(playbackId);
    }
  }

  dispose() {
    for (const session of this.#sessions.values()) session.directSession?.destroy();
    this.#sessions.clear();
    this.#feeds.clear();
    this.#knownImages.clear();
  }
}
