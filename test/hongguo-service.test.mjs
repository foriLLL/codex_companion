import assert from "node:assert/strict";
import test from "node:test";
import { HongguoService } from "../src/hongguo-service.mjs";

const seriesId = "7503745441910017049";
const posterUrl = "https://p6-novel.byteimg.com/cover.jpg";

function createClient() {
  return {
    async featured() { return [{ id: seriesId, name: "官网短剧", posterUrl }]; },
    async search() { return [{ id: seriesId, name: "官网短剧", posterUrl }]; },
    async detail() {
      return {
        id: seriesId,
        name: "官网短剧",
        totalEpisodes: 5,
        accessibleEpisodeCount: 5,
        fullEpisodeCount: 76,
        posterUrl
      };
    },
    async episodeSource() {
      return {
        mp4Url: "https://v26-hgweb.qznovelvod.com/video.mp4?signature=one",
        durationSeconds: 211.8
      };
    },
    async loadRange(_url, { start, end }) {
      return {
        bytes: new Uint8Array([1, 2, 3]),
        start,
        end: Math.min(end, start + 2),
        total: 1000,
        resolvedUrl: "https://v26-hgweb.qznovelvod.com/video.mp4?signature=one"
      };
    },
    async loadImage(url) { return { url, contentType: "image/jpeg", bytes: new Uint8Array([9, 8]) }; }
  };
}

function createDirectFactory(state) {
  return ({ readRange }) => {
    state.readRange = readRange;
    return {
      async initialize() {
        state.initialized += 1;
        return {
          durationSeconds: 211.8,
          startTimeSeconds: 0,
          tracks: [{ id: 0, mime: 'video/mp4; codecs="avc1.64001f,mp4a.40.2"', initData: "AQI=" }]
        };
      },
      async next() { state.next += 1; return { segments: [], end: false }; },
      seek(timeSeconds) { state.seek = timeSeconds; return { timeSeconds, offset: 10 }; },
      destroy() { state.destroyed += 1; }
    };
  };
}

test("短剧 RPC 使用官网 MP4 和独立 MSE 会话", async () => {
  const state = { initialized: 0, next: 0, seek: null, destroyed: 0, readRange: null };
  const service = new HongguoService({ client: createClient(), directSessionFactory: createDirectFactory(state) });
  const context = { targetId: "renderer-a", signal: new AbortController().signal };
  assert.equal((await service.handleRpc("hongguo.home", {}, context)).featured.length, 1);
  const detail = await service.handleRpc("hongguo.detail", { dramaId: seriesId }, context);
  assert.equal(detail.fullEpisodeCount, 76);
  const image = await service.handleRpc("hongguo.image.load", { url: posterUrl }, context);
  assert.equal(image.data, Buffer.from([9, 8]).toString("base64"));

  const playback = await service.handleRpc("hongguo.playback.open", { dramaId: seriesId, episode: 1 }, context);
  assert.equal(playback.streamMode, "direct-mp4");
  assert.equal("mp4Url" in playback, false);
  assert.equal((await service.handleRpc("hongguo.playback.direct.init", { playbackId: playback.playbackId }, context)).durationSeconds, 211.8);
  assert.deepEqual(await service.handleRpc("hongguo.playback.direct.next", { playbackId: playback.playbackId }, context), { segments: [], end: false });
  assert.equal((await service.handleRpc("hongguo.playback.direct.seek", { playbackId: playback.playbackId, timeSeconds: 60 }, context)).timeSeconds, 60);
  const range = await state.readRange({ start: 0, end: 2, signal: context.signal });
  assert.deepEqual([...range.bytes], [1, 2, 3]);
  assert.deepEqual(await service.handleRpc("hongguo.playback.stop", { playbackId: playback.playbackId }, context), { stopped: true });
  assert.equal(state.destroyed, 1);
});

test("短剧 CDN 地址多次过期都能刷新（刷新预算不是一次性）", async () => {
  const state = { initialized: 0, next: 0, seek: null, destroyed: 0, readRange: null };
  const client = createClient();
  let sourceCalls = 0;
  // 每个签发的 URL 只允许成功一次，第二次访问即视为过期；模拟长视频里 CDN 反复过期。
  const usedOnce = new Set();
  client.episodeSource = async () => {
    sourceCalls += 1;
    return { mp4Url: `https://cdn.example/video-${sourceCalls}.mp4`, durationSeconds: 100, referer: "https://ref" };
  };
  client.loadRange = async (url, { start, end }) => {
    if (usedOnce.has(url)) {
      const error = new Error("expired");
      error.code = "DIRECT_URL_EXPIRED";
      throw error;
    }
    usedOnce.add(url);
    return { bytes: new Uint8Array([1]), start, end: start, total: 100, resolvedUrl: url };
  };
  const service = new HongguoService({ client, directSessionFactory: createDirectFactory(state) });
  const context = { targetId: "renderer-a", signal: new AbortController().signal };
  await service.handleRpc("hongguo.playback.open", { dramaId: seriesId, episode: 1 }, context);
  const read = () => state.readRange({ start: 0, end: 0, signal: context.signal });
  // 第 1 次读取用初始 URL 成功。第 2 次：初始 URL 已用过→过期→刷新→新 URL 成功（预算随成功重置）。
  // 第 3 次：上一个 URL 又过期→再次刷新→成功。若刷新是一次性的，第 3 次会抛出。
  await assert.doesNotReject(read());
  await assert.doesNotReject(read());
  await assert.doesNotReject(read());
  assert.ok(sourceCalls >= 2, `应发生多次刷新取源，实际 ${sourceCalls} 次`);
});

test("推荐流分页返回完整目录、页间不重复且游标绑定 renderer", async () => {
  const catalog = Array.from({ length: 55 }, (_, index) => ({
    id: String(10_000 + index),
    name: `短剧 ${index + 1}`,
    posterUrl: `https://p6-novel.byteimg.com/${index + 1}.jpg`
  }));
  const client = createClient();
  client.home = async () => ({
    data: { featured: catalog.slice(0, 3), items: catalog },
    cacheStatus: "fresh"
  });
  const service = new HongguoService({ client, randomImpl: () => 0.25 });
  const owner = { targetId: "renderer-a" };

  const first = await service.handleRpc("hongguo.home", { limit: 20 }, owner);
  assert.equal(first.items.length, 20);
  assert.equal(first.total, 55);
  assert.equal(first.hasMore, true);
  assert.equal(typeof first.cursor, "string");
  await assert.rejects(
    service.handleRpc("hongguo.feed.next", { cursor: first.cursor }, { targetId: "renderer-b" }),
    (error) => error.code === "FEED_EXPIRED"
  );

  const second = await service.handleRpc("hongguo.feed.next", { cursor: first.cursor, limit: 20 }, owner);
  const third = await service.handleRpc("hongguo.feed.next", { cursor: second.cursor, limit: 20 }, owner);
  assert.deepEqual([first.items.length, second.items.length, third.items.length], [20, 20, 15]);
  assert.equal(third.hasMore, false);
  assert.equal(third.cursor, null);
  const ids = [...first.items, ...second.items, ...third.items].map((item) => item.id);
  assert.equal(new Set(ids).size, 55);
});

test("播放会话绑定 renderer，停止和 renderer 销毁都会释放 MP4 解析器", async () => {
  const state = { initialized: 0, next: 0, seek: null, destroyed: 0 };
  const service = new HongguoService({ client: createClient(), directSessionFactory: createDirectFactory(state) });
  const owner = { targetId: "renderer-a" };
  const playback = await service.handleRpc("hongguo.playback.open", { dramaId: seriesId, episode: 1 }, owner);
  await assert.rejects(
    service.handleRpc("hongguo.playback.direct.init", { playbackId: playback.playbackId }, { targetId: "renderer-b" }),
    /播放会话已失效/
  );
  service.disposeTarget("renderer-a");
  assert.equal(state.destroyed, 1);
  await assert.rejects(
    service.handleRpc("hongguo.playback.direct.next", { playbackId: playback.playbackId }, owner),
    /播放会话已失效/
  );
});

test("只允许加载目录中出现过的官网封面", async () => {
  const service = new HongguoService({ client: createClient() });
  await assert.rejects(
    service.handleRpc("hongguo.image.load", { url: "https://evil.example/cover.jpg" }, { targetId: "renderer" }),
    /拒绝加载未知/
  );
});

test("官网封面瞬时网络失败时自动重试一次", async () => {
  const client = createClient();
  let attempts = 0;
  client.loadImage = async (url) => {
    attempts += 1;
    if (attempts === 1) {
      const error = new Error("temporary image failure");
      error.retryable = true;
      throw error;
    }
    return { url, contentType: "image/png", bytes: new Uint8Array([1]) };
  };
  const service = new HongguoService({ client });
  await service.handleRpc("hongguo.home", {}, { targetId: "renderer" });
  const image = await service.handleRpc("hongguo.image.load", { url: posterUrl }, { targetId: "renderer" });
  assert.equal(image.data, Buffer.from([1]).toString("base64"));
  assert.equal(attempts, 2);
});

test("我的片单 RPC：add/get/remove，并把封面注册进白名单以便加载", async () => {
  const store = [];
  const listStorage = {
    async load() { return [...store]; },
    async add(entry) { const f = store.filter((x) => x.id !== entry.id); store.length = 0; store.push(entry, ...f); return [...store]; },
    async remove(id) { const kept = store.filter((x) => x.id !== id); store.length = 0; store.push(...kept); return [...store]; }
  };
  const service = new HongguoService({ client: createClient(), listStorage });
  const context = { targetId: "renderer-a", signal: new AbortController().signal };

  // 初始为空
  assert.deepEqual((await service.handleRpc("hongguo.list.get", {}, context)).items, []);

  // 加入：返回列表含该项
  const added = await service.handleRpc("hongguo.list.add", { id: seriesId, name: "官网短剧", posterUrl }, context);
  assert.equal(added.items.length, 1);
  assert.equal(added.items[0].id, seriesId);

  // 加入后其封面应已注册进 #knownImages —— image.load 不再被拒
  const image = await service.handleRpc("hongguo.image.load", { url: posterUrl }, context);
  assert.equal(image.url, posterUrl);

  // 非法条目被拒
  await assert.rejects(
    service.handleRpc("hongguo.list.add", { id: "not-an-id", name: "x" }, context),
    (error) => error.code === "INVALID_ARGUMENT"
  );

  // 移除
  const removed = await service.handleRpc("hongguo.list.remove", { id: seriesId }, context);
  assert.deepEqual(removed.items, []);
});
