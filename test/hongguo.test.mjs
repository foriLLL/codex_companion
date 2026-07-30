import assert from "node:assert/strict";
import test from "node:test";
import {
  HONGGUO_SOURCE,
  HongguoClient,
  HongguoError,
  fetchOfficialPage,
  parseDetailData,
  parseHomeData,
  parsePlayerData,
  parseRouterData
} from "../src/hongguo.mjs";

const seriesId = "7503745441910017049";
const videoIds = ["7503780574541122622", "7503780577347128382", "7503780574608231486"];

function routerHtml(loaderData) {
  return `<html><script>window._ROUTER_DATA = ${JSON.stringify({ loaderData })};</script></html>`;
}

function response(body, init = {}, url = "") {
  const value = new Response(body, init);
  Object.defineProperty(value, "url", { value: url });
  return value;
}

function detailHtml({ accessible = 3 } = {}) {
  return routerHtml({
    detail_page: {
      seriesDetail: {
        series_id: seriesId,
        series_name: "宴律，你的白月光回国了",
        series_cover: "https://p6-novel.byteimg.com/cover.jpg",
        series_intro: "官网剧情简介",
        episode_cnt: 76,
        accessible_episode_cnt: accessible,
        vid_list: videoIds
      }
    }
  });
}

function playerHtml(videoId = videoIds[0], routeKey = "player_(series_id)/page") {
  return routerHtml({
    [routeKey]: {
      series_id: seriesId,
      vid: videoId,
      video_player_info: {
        main_url: "https://v26-hgweb.qznovelvod.com/video.mp4?x-expires=1",
        duration: 211.834,
        width: "720",
        height: "1280"
      }
    }
  });
}

test("只解析官网 _ROUTER_DATA，不执行页面脚本", () => {
  const html = routerHtml({
    page: {
      mBannerList: [{ series_id: seriesId, series_name: "推荐短剧", background_cover: "https://lf-dy-sourcecdn-tos.bytegecko.com/banner.png" }],
      videoList: [
        { series_id: seriesId, series_name: "推荐短剧", series_cover: "https://p6-novel.byteimg.com/a.jpg", episode_right_text: "全76集" },
        { series_id: "7470352464487648318", series_name: "抱歉我拿的是女主剧本", episode_right_text: "全64集" }
      ]
    }
  });
  assert.equal(parseRouterData(html).loaderData.page.videoList.length, 2);
  const home = parseHomeData(html);
  assert.equal(home.featured[0].name, "推荐短剧");
  assert.equal(home.featured[0].posterUrl, "https://p6-novel.byteimg.com/a.jpg");
  assert.equal(home.featured.length, 2);
  assert.equal(home.items[1].totalEpisodes, 64);
  assert.throws(() => parseRouterData("<script>globalThis.pwned=true</script>"), /没有返回可识别的数据/);
});

test("官网 banner 没有竖版封面时回退 background_cover", () => {
  const home = parseHomeData(routerHtml({
    page: {
      mBannerList: [{
        series_id: seriesId,
        series_name: "新上架短剧",
        background_cover: "https://lf-dy-sourcecdn-tos.bytegecko.com/banner.png"
      }],
      videoList: []
    }
  }));
  assert.equal(home.featured[0].posterUrl, "https://lf-dy-sourcecdn-tos.bytegecko.com/banner.png");
});

test("官网 apex 连接失败时回退到官方 www 传输入口", async () => {
  const calls = [];
  const ipv6Error = new Error("apex ipv6 reset");
  const ipv4Error = new Error("apex ipv4 reset");
  const result = await fetchOfficialPage(`${HONGGUO_SOURCE}/detail?series_id=${seriesId}`, {
    headers: { Referer: `${HONGGUO_SOURCE}/` }
  }, {
    ipv6FetchImpl: async () => {
      calls.push("ipv6");
      throw ipv6Error;
    },
    defaultFetchImpl: async () => {
      calls.push("ipv4");
      throw ipv4Error;
    },
    fallbackFetchImpl: async (url, options) => {
      calls.push({ url: String(url), referer: options.headers.Referer });
      return response("official fallback", { status: 200 }, String(url));
    }
  });
  assert.deepEqual(calls, [
    "ipv6",
    "ipv4",
    { url: `${HONGGUO_SOURCE}/detail?series_id=${seriesId}`, referer: `${HONGGUO_SOURCE}/` }
  ]);
  assert.equal(await result.text(), "official fallback");
});

test("单条官网传输线路卡死时按时切换下一条线路", async () => {
  const calls = [];
  const result = await fetchOfficialPage(`${HONGGUO_SOURCE}/`, {}, {
    transportTimeoutMs: 5,
    ipv6FetchImpl: async () => {
      calls.push("ipv6");
      return new Promise(() => {});
    },
    defaultFetchImpl: async () => {
      calls.push("default");
      return response("ok", { status: 200 }, `${HONGGUO_SOURCE}/`);
    }
  });
  assert.deepEqual(calls, ["ipv6", "default"]);
  assert.equal(await result.text(), "ok");
});

test("详情严格区分总集数和官网开放集数", () => {
  const detail = parseDetailData(detailHtml());
  assert.equal(detail.id, seriesId);
  assert.equal(detail.fullEpisodeCount, 76);
  assert.equal(detail.accessibleEpisodeCount, 3);
  assert.equal(detail.totalEpisodes, 3);
  assert.deepEqual(detail.episodeIds, videoIds);

  const player = parsePlayerData(playerHtml());
  assert.equal(player.videoId, videoIds[0]);
  assert.equal(player.durationSeconds, 211.834);
  assert.match(player.mp4Url, /^https:\/\/v26-hgweb\.qznovelvod\.com\//);
  assert.equal(
    parsePlayerData(playerHtml(videoIds[1], "player_(series_id)/(vid)/page")).videoId,
    videoIds[1]
  );
});

test("剧集 ID 直达取详情，详情和播放器只访问 hongguoduanju.com", async () => {
  const calls = [];
  const homeHtml = routerHtml({
    page: {
      mBannerList: [],
      videoList: [
        {
          series_id: seriesId,
          series_name: "宴律，你的白月光回国了",
          series_intro: "一段久别重逢的剧情词",
          tags: ["都市甜宠"],
          episode_right_text: "全76集"
        },
        { series_id: "7470352464487648318", series_name: "抱歉我拿的是女主剧本", episode_right_text: "全64集" }
      ]
    }
  });
  const client = new HongguoClient({
    validateMediaUrl: async (url) => new URL(url),
    fetchImpl: async (url) => {
      calls.push(url.href);
      if (url.pathname === "/") return response(homeHtml, { status: 200 }, url.href);
      if (url.pathname === "/detail") return response(detailHtml(), { status: 200 }, url.href);
      if (url.pathname.startsWith("/player/")) return response(playerHtml(videoIds[1]), { status: 200 }, url.href);
      return response("missing", { status: 404 }, url.href);
    }
  });

  assert.equal((await client.featured()).length, 2);
  // ID 直达：detail 只请求 /detail，返回目标剧
  const drama = await client.detail(seriesId);
  assert.equal(drama.id, seriesId);
  assert.equal(calls.filter((url) => new URL(url).pathname === "/detail").length, 1);
  const source = await client.episodeSource(seriesId, 2);
  assert.equal(source.videoId, videoIds[1]);
  assert.match(calls.at(-1), new RegExp(`/player/${seriesId}/${videoIds[1]}$`));
  assert.equal(calls.every((url) => new URL(url).origin === HONGGUO_SOURCE), true);
});

test("官网旧快照立即展示，并在后台刷新为最新目录", async () => {
  const now = 10_000_000;
  const cached = parseHomeData(routerHtml({
    page: {
      mBannerList: [],
      videoList: [{ series_id: seriesId, series_name: "离线可见短剧", episode_right_text: "全76集" }]
    }
  }));
  let networkAttempts = 0;
  let finishNetwork;
  const freshHtml = routerHtml({
    page: {
      mBannerList: [],
      videoList: [{ series_id: seriesId, series_name: "在线最新短剧", episode_right_text: "全76集" }]
    }
  });
  const client = new HongguoClient({
    catalogCache: {
      async load() { return { at: now - 60 * 60 * 1000, data: cached }; },
      async save() { throw new Error("不应覆盖快照"); }
    },
    fetchImpl: async (url) => {
      networkAttempts += 1;
      return new Promise((resolve) => {
        finishNetwork = () => resolve(response(freshHtml, { status: 200 }, url.href));
      });
    },
    pageRetryDelays: [0],
    now: () => now
  });

  const featured = await client.featured();
  assert.equal(featured[0].name, "离线可见短剧");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(networkAttempts, 1);
  finishNetwork();
  const refreshed = await client.home({ refresh: true });
  assert.equal(refreshed.data.featured[0].name, "在线最新短剧");
});

test("官网成功目录持久化，空目录不会覆盖上次有效内容", async () => {
  const saved = [];
  let now = 20_000_000;
  const validHtml = routerHtml({
    page: {
      mBannerList: [],
      videoList: [{ series_id: seriesId, series_name: "有效短剧", episode_right_text: "全76集" }]
    }
  });
  let html = validHtml;
  const client = new HongguoClient({
    catalogCache: {
      async load() { return null; },
      async save(snapshot) { saved.push(snapshot); }
    },
    fetchImpl: async (url) => response(html, { status: 200 }, url.href),
    pageRetryDelays: [0],
    now: () => now
  });

  assert.equal((await client.featured())[0].name, "有效短剧");
  assert.equal(saved.length, 1);
  now += 6 * 60 * 1000;
  html = routerHtml({ page: { mBannerList: [], videoList: [] } });
  assert.equal((await client.featured())[0].name, "有效短剧");
  assert.equal(saved.length, 1);
});

test("拒绝播放官网未开放的集数", async () => {
  const client = new HongguoClient({
    validateMediaUrl: async (url) => new URL(url),
    fetchImpl: async (url) => response(detailHtml({ accessible: 2 }), { status: 200 }, url.href)
  });
  await assert.rejects(
    client.episodeSource(seriesId, 3),
    (error) => error instanceof HongguoError
      && error.code === "EPISODE_NOT_ACCESSIBLE"
      && /只开放前 2 集/.test(error.message)
  );
});

test("签名 MP4 使用 HTTP Range 按需读取，不下载整部视频", async () => {
  const calls = [];
  const client = new HongguoClient({
    validateMediaUrl: async (url) => new URL(url),
    fetchImpl: async (url, options) => {
      calls.push({ url: url.href, options });
      return response(new Uint8Array([1, 2, 3, 4]), {
        status: 206,
        headers: {
          "content-type": "video/mp4",
          "content-range": "bytes 1024-1027/36200109",
          "content-length": "4"
        }
      }, url.href);
    }
  });
  const result = await client.loadRange("https://v26-hgweb.qznovelvod.com/video.mp4", { start: 1024, end: 2047 });
  assert.equal(calls[0].options.headers.Range, "bytes=1024-2047");
  assert.equal(calls[0].options.headers.Referer, `${HONGGUO_SOURCE}/`);
  assert.equal(result.total, 36200109);
  assert.deepEqual([...result.bytes], [1, 2, 3, 4]);
});

test("Range 失效和签名过期返回可操作错误", async () => {
  const expired = new HongguoClient({
    validateMediaUrl: async (url) => new URL(url),
    fetchImpl: async (url) => response("expired", { status: 403 }, url.href)
  });
  await assert.rejects(
    expired.loadRange("https://v26-hgweb.qznovelvod.com/video.mp4", { start: 0, end: 1023 }),
    (error) => error.code === "DIRECT_URL_EXPIRED" && error.retryable
  );

  assert.throws(
    () => new HongguoClient({ source: "https://www.hongguostudio.com" }),
    /必须是 hongguoduanju\.com/
  );
});
