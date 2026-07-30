import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { CdpConnection } from "../src/cdp-connection.mjs";
import { BRIDGE_KEY, HOST_ID, INJECTION_VERSION, RAIL_ID, buildInjectionSource } from "../src/injection.mjs";
import { reserveLoopbackPort } from "../src/launcher.mjs";
import { listCdpTargets } from "../src/targets.mjs";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = await reserveLoopbackPort();
const profileDir = await mkdtemp(path.join(os.tmpdir(), "codex-companion-smoke-"));
const smokePage = `data:text/html,${encodeURIComponent(`
  <html>
    <head><style>html,body{margin:0;height:100%;overflow:hidden}</style></head>
    <body>
      <div class="app-shell-main-content-frame" style="height:100%">
        <div id="layout" style="display:flex;height:100%">
          <main id="content" style="position:relative;min-width:0;flex:1">
            Codex Companion smoke
            <button id="pinned-toggle" aria-label="Toggle pinned summary" aria-pressed="true"></button>
            <div class="pointer-events-none absolute top-(--thread-floating-content-top-inset) right-0 bottom-(--thread-floating-content-bottom-inset) z-40"
                 style="position:absolute;top:12px;right:0;bottom:12px;width:316px">
              <div class="relative flex max-h-full" style="position:relative;display:flex;height:100%;max-height:100%">
                <div class="pointer-events-none pe-4 max-h-full min-h-0 origin-top-right"
                     style="width:316px;max-height:100%;padding-right:16px;box-sizing:border-box;opacity:1;visibility:visible;transform:none;transform-origin:top right">
                  <div id="native-panel" class="rounded-3xl bg-token-dropdown-background" style="width:300px;height:251px;font-weight:445">Outputs / Sources</div>
                </div>
              </div>
            </div>
          </main>
        </div>
      </div>
    </body>
  </html>
`)}`;
const chrome = spawn(CHROME, [
  "--headless=new",
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
  "--remote-debugging-address=127.0.0.1",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profileDir}`,
  smokePage
], { stdio: "ignore" });

const waitForPage = async () => {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const target = (await listCdpTargets(port)).find((item) => item.type === "page" && item.webSocketDebuggerUrl);
      if (target) return target;
    } catch {
      // Chrome 仍在启动。
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("等待测试 Chromium target 超时");
};

let connection;
try {
  const target = await waitForPage();
  connection = new CdpConnection(target.webSocketDebuggerUrl);
  await connection.connect();
  await connection.send("Page.enable");
  await connection.send("Runtime.enable");
  const evaluate = async (params) => {
    const evaluation = await connection.send("Runtime.evaluate", params);
    if (evaluation.exceptionDetails) {
      const description = evaluation.exceptionDetails.exception?.description
        ?? evaluation.exceptionDetails.text
        ?? "未知 Renderer 异常";
      throw new Error(description);
    }
    return evaluation;
  };
  await connection.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false
  });

  await evaluate({
    expression: `(() => {
      globalThis.__mockEmbyConnected = false;
      globalThis.__embyRpcLog = [];
      globalThis.__hlsProbe = { created: 0, destroyed: 0, manifests: 0 };

      class FakeHls {
        static Events = { MANIFEST_PARSED: "manifest", ERROR: "error" };
        static isSupported() { return true; }
        constructor(options) {
          this.options = options;
          this.handlers = new Map();
          this.levels = [{ height: 360 }, { height: 720 }, { height: 1080 }];
          this.autoLevelCapping = -1;
          globalThis.__hlsProbe.created += 1;
          globalThis.__hlsProbe.options = {
            maxBufferLength: options.maxBufferLength,
            backBufferLength: options.backBufferLength,
            maxBufferSize: options.maxBufferSize,
            capLevelToPlayerSize: options.capLevelToPlayerSize,
            enableWorker: options.enableWorker
          };
        }
        on(event, handler) { this.handlers.set(event, handler); }
        attachMedia(media) { this.media = media; }
        loadSource(url) {
          globalThis.__hlsProbe.source = url;
          this.loader = new this.options.loader();
          this.loader.load(
            { url, responseType: "text", type: "manifest" },
            { timeout: 1_000 },
            {
              onSuccess: () => {
                this.loader.destroy();
                globalThis.__hlsProbe.manifests += 1;
                this.handlers.get(FakeHls.Events.MANIFEST_PARSED)?.();
                globalThis.__hlsProbe.autoLevelCapping = this.autoLevelCapping;
              },
              onError: (error) => { globalThis.__hlsProbe.error = error.text; },
              onAbort: () => { globalThis.__hlsProbe.aborted = true; }
            }
          );
        }
        destroy() {
          this.loader?.destroy();
          globalThis.__hlsProbe.destroyed += 1;
        }
      }
      globalThis.Hls = FakeHls;

      const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL7WQAAAABJRU5ErkJggg==";
      const home = {
        views: [{
          id: "movies", name: "华语电影", type: "CollectionFolder", isFolder: true,
          imageUrl: "emby://image/library"
        }],
        resume: [{
          id: "episode-6", name: "第 6 集", type: "Episode",
          seriesId: "series-1", seriesName: "示例剧集", seasonId: "season-1",
          indexNumber: 6, parentIndexNumber: 1,
          imageUrl: "emby://image/resume", backdropUrl: "emby://backdrop/resume",
          progressPercent: 42, positionTicks: 420000000
        }],
        latest: [
          { id: "series-1", name: "示例剧集", type: "Series", imageUrl: "emby://image/series" },
          { id: "movie-1", name: "示例电影", type: "Movie", imageUrl: "emby://image/movie" }
        ]
      };
      const episodes = Array.from({ length: 12 }, (_, index) => ({
        id: "episode-" + (index + 1),
        name: "第 " + (index + 1) + " 集",
        type: "Episode",
        seriesId: "series-1",
        seriesName: "示例剧集",
        seasonId: "season-1",
        indexNumber: index + 1,
        parentIndexNumber: 1,
        runtimeTicks: 15000000000,
        positionTicks: index === 11 ? 120000000 : 0,
        progressPercent: index === 11 ? 8 : 0
      }));
      const secondSeasonEpisodes = Array.from({ length: 4 }, (_, index) => ({
        id: "season-2-episode-" + (index + 1),
        name: "第 2 季第 " + (index + 1) + " 集",
        type: "Episode",
        seriesId: "series-1",
        seriesName: "示例剧集",
        seasonId: "season-2",
        indexNumber: index + 1,
        parentIndexNumber: 2,
        runtimeTicks: 15000000000,
        positionTicks: 0,
        progressPercent: 0
      }));
      const hongguoItem = {
        id: "7503745441910017049",
        name: "红果合并样片",
        totalEpisodes: 3,
        accessibleEpisodeCount: 3,
        fullEpisodeCount: 76,
        posterUrl: "https://hongguo.test/poster.jpg",
        description: "用于验证搜索、选集、播放和返回清理。"
      };
      const hongguoFeedItems = Array.from({ length: 44 }, (_, index) => ({
        ...hongguoItem,
        id: String(7503745441910017049n + BigInt(index)),
        name: index === 0 ? hongguoItem.name : "红果信息流样片 " + (index + 1),
        posterUrl: "https://hongguo.test/poster-" + (index + 1) + ".jpg"
      }));
      let hongguoListStore = [];

      globalThis.__mockEmbyServers = [];
      globalThis.__mockHongguoImageAttempts = {};
      globalThis.__mockImageAttempts = {};      globalThis.__CODEX_COMPANION_RPC__ = (rawRequest) => {
        const request = JSON.parse(rawRequest);
        globalThis.__embyRpcLog.push(request);
        let result;
        if (request.method === "hongguo.home") {
          result = {
            featured: hongguoFeedItems.slice(0, 20),
            items: hongguoFeedItems.slice(0, 20),
            cursor: "hongguo-feed-cursor",
            hasMore: true,
            total: hongguoFeedItems.length
          };
        } else if (request.method === "hongguo.feed.next") {
          result = { items: hongguoFeedItems.slice(20), cursor: null, hasMore: false, total: hongguoFeedItems.length };
        } else if (request.method === "hongguo.list.get") {
          result = { items: [...hongguoListStore] };
        } else if (request.method === "hongguo.list.add") {
          const p = request.params || {};
          hongguoListStore = [{ id: String(p.id), name: p.name || "", posterUrl: p.posterUrl || "" },
            ...hongguoListStore.filter((x) => x.id !== String(p.id))];
          result = { items: [...hongguoListStore] };
        } else if (request.method === "hongguo.list.remove") {
          hongguoListStore = hongguoListStore.filter((x) => x.id !== String(request.params?.id));
          result = { items: [...hongguoListStore] };
        } else if (request.method === "hongguo.detail") {
          result = hongguoItem;
        } else if (request.method === "hongguo.image.load") {
          const imageUrl = request.params.url;
          globalThis.__mockHongguoImageAttempts[imageUrl] = (globalThis.__mockHongguoImageAttempts[imageUrl] || 0) + 1;
          if (imageUrl.endsWith("poster-1.jpg") && globalThis.__mockHongguoImageAttempts[imageUrl] === 1) {
            queueMicrotask(() => globalThis[${JSON.stringify(BRIDGE_KEY)}]?.emby.receiveRpc({
              id: request.id,
              ok: false,
              error: { code: "NETWORK_ERROR", message: "模拟红果封面瞬时失败", retryable: true }
            }));
            return;
          }
          result = { data: pixel, encoding: "base64", contentType: "image/png", url: request.params.url };
        } else if (request.method === "hongguo.playback.open") {
          if (request.params.episode === 3) {
            const error = new Error("模拟上游线路不可用");
            error.code = "VIDEO_SOURCE_UNAVAILABLE";
            error.retryable = true;
            throw error;
          }
          result = {
            playbackId: "hongguo-playback-1",
            dramaId: request.params.dramaId,
            episode: request.params.episode,
            streamMode: "direct-mp4",
            externalSource: "data:video/mp4;base64,AAAA"
          };
        } else if (request.method === "connection.status") {
          result = {
            connected: globalThis.__mockEmbyConnected,
            baseUrl: "https://emby.test",
            username: "smoke-user"
          };
        } else if (request.method === "auth.login") {
          globalThis.__mockEmbyConnected = true;
          globalThis.__mockEmbyServers = [{
            key: "server-1:user-1",
            baseUrl: request.params.baseUrl,
            username: request.params.username,
            serverId: "server-1",
            userId: "user-1",
            active: true,
            connected: true
          }, {
            key: "server-2:user-2",
            baseUrl: "https://emby-backup.test",
            username: "backup-user",
            serverId: "server-2",
            userId: "user-2",
            active: false,
            connected: true
          }];
          result = {
            connected: true,
            baseUrl: request.params.baseUrl,
            username: request.params.username,
            serverId: "server-1",
            userId: "user-1"
          };
        } else if (request.method === "auth.logout") {
          globalThis.__mockEmbyConnected = false;
          globalThis.__mockEmbyServers = globalThis.__mockEmbyServers.map((server) => ({ ...server, connected: false }));
          result = { connected: false };
        } else if (request.method === "servers.list") {
          result = { servers: globalThis.__mockEmbyServers };
        } else if (request.method === "servers.switch") {
          const selected = globalThis.__mockEmbyServers.find((server) => server.key === request.params.serverKey);
          globalThis.__mockEmbyServers = globalThis.__mockEmbyServers.map((server) => ({
            ...server,
            active: server.key === request.params.serverKey
          }));
          result = {
            connected: true,
            baseUrl: selected.baseUrl,
            username: selected.username,
            serverId: selected.serverId,
            userId: selected.userId
          };
        } else if (request.method === "home.get") {
          result = home;
        } else if (request.method === "library.get") {
          result = {
            parentId: request.params.parentId,
            startIndex: request.params.startIndex || 0,
            totalRecordCount: 2,
            items: [home.latest[1], home.latest[0]]
          };
        } else if (request.method === "search") {
          result = { items: [home.latest[0], home.latest[1]] };
        } else if (request.method === "series.get") {
          result = {
            seriesId: "series-1",
            seasons: [
              { id: "season-1", name: "第 1 季", indexNumber: 1 },
              { id: "season-2", name: "第 2 季", indexNumber: 2 }
            ],
            selectedSeasonId: request.params.seasonId || "season-1",
            episodes: request.params.seasonId === "season-2" ? secondSeasonEpisodes : episodes
          };
        } else if (request.method === "playback.open") {
          globalThis.__mockSubtitleMode = "external-vtt";
          globalThis.__mockSubtitleIndex = 2;
          result = {
            playbackId: "playback-1",
            itemId: request.params.itemId,
            mediaSourceId: "media-1",
            playSessionId: "session-1",
            streamMode: "hls",
            hlsUrl: "https://emby.test/Videos/test/master.m3u8",
            startPositionTicks: request.params.startPositionTicks || 0,
            subtitles: [
              {
                index: 2, label: "简体中文", language: "chi", codec: "subrip",
                isDefault: true, isForced: false, isHearingImpaired: false,
                isExternal: true, mode: "external-vtt"
              },
              {
                index: 3, label: "日文 ASS", language: "jpn", codec: "ass",
                isDefault: false, isForced: false, isHearingImpaired: false,
                isExternal: false, mode: "burn-in"
              }
            ],
            selectedSubtitleIndex: 2,
            subtitleMode: "external-vtt"
          };
        } else if (request.method === "playback.subtitle.load") {
          result = {
            data: "WEBVTT\\n\\n00:00.000 --> 00:10.000\\n字幕冒烟测试",
            encoding: "utf8",
            contentType: "text/vtt",
            subtitleStreamIndex: request.params.subtitleStreamIndex
          };
        } else if (request.method === "playback.subtitle.select") {
          const previousMode = globalThis.__mockSubtitleMode;
          const selected = request.params.subtitleStreamIndex;
          const mode = selected === 3 ? "burn-in" : (selected === 2 ? "external-vtt" : "off");
          const restartRequired = previousMode === "burn-in" || mode === "burn-in";
          globalThis.__mockSubtitleMode = mode;
          globalThis.__mockSubtitleIndex = selected;
          result = {
            playbackId: "playback-1",
            mediaSourceId: "media-1",
            playSessionId: restartRequired ? "session-2" : "session-1",
            selectedSubtitleIndex: selected,
            subtitleMode: mode,
            restartRequired,
            streamMode: "hls",
            startPositionTicks: request.params.positionTicks || 0,
            hlsUrl: mode === "burn-in"
              ? "https://emby.test/Videos/test/master-ass.m3u8"
              : "https://emby.test/Videos/test/master.m3u8"
          };
        } else if (request.method === "resource.load") {
          const imageUrl = request.params.resourceType === "image" ? request.params.url : null;
          if (imageUrl) {
            globalThis.__mockImageAttempts[imageUrl] = (globalThis.__mockImageAttempts[imageUrl] || 0) + 1;
            if (imageUrl === "emby://image/library" && globalThis.__mockImageAttempts[imageUrl] === 1) {
              queueMicrotask(() => globalThis[${JSON.stringify(BRIDGE_KEY)}]?.emby.receiveRpc({
                id: request.id,
                ok: false,
                error: { code: "NETWORK_ERROR", message: "模拟图片瞬时失败", retryable: true }
              }));
              return;
            }
          }
          result = request.params.responseType === "text"
            ? { data: "#EXTM3U\\n#EXT-X-VERSION:3", encoding: "utf8", contentType: "application/vnd.apple.mpegurl", url: request.params.url }
            : { data: pixel, encoding: "base64", contentType: "image/png", url: request.params.url };
        } else {
          result = { ok: true };
        }
        queueMicrotask(() => globalThis[${JSON.stringify(BRIDGE_KEY)}]?.emby.receiveRpc({
          id: request.id,
          ok: true,
          result
        }));
      };
    })()`
  });

  const first = await evaluate({
    expression: buildInjectionSource("mount", { placement: "inline-in-summary" }),
    returnByValue: true
  });
  assert.equal(first.result.value.status, "mounted");

  await evaluate({
    expression: `new Promise((resolve, reject) => {
      const deadline = Date.now() + 3_000;
      const poll = () => {
        const state = globalThis[${JSON.stringify(BRIDGE_KEY)}]?.hongguo.getState();
        if (state?.view === 'home' && state.featuredCount === 20 && state.feedHasMore === true) resolve(true);
        else if (Date.now() > deadline) reject(new Error('Hongguo home state timeout'));
        else setTimeout(poll, 20);
      };
      poll();
    })`,
    awaitPromise: true,
    returnByValue: true
  });

  await evaluate({
    expression: `(() => {
      const scroll = document.getElementById(${JSON.stringify(HOST_ID)}).shadowRoot.querySelector('.hg-scroll');
      scroll.scrollTop = scroll.scrollHeight;
      scroll.dispatchEvent(new Event('scroll'));
    })()`
  });
  await evaluate({
    expression: `new Promise((resolve, reject) => {
      const deadline = Date.now() + 3_000;
      const poll = () => {
        const state = globalThis[${JSON.stringify(BRIDGE_KEY)}]?.hongguo.getState();
        if (state?.view === 'home' && state.featuredCount === 44 && state.feedHasMore === false) resolve(true);
        else if (Date.now() > deadline) reject(new Error('Hongguo feed pagination timeout'));
        else setTimeout(poll, 20);
      };
      poll();
    })`,
    awaitPromise: true,
    returnByValue: true
  });

  // 回归：瀑布流加载 44 张封面（超过 30 张缓存上限）后，先前加载的封面不应被 revoke 变空白。
  // 等封面陆续加载，再校验每个在场 <img> 的 blob src 仍可解码（fetch 成功即未被 revoke）。
  const posterCheck = await evaluate({
    expression: `(async () => {
      const root = document.getElementById(${JSON.stringify(HOST_ID)}).shadowRoot;
      const deadline = Date.now() + 5_000;
      const imgs = () => Array.from(root.querySelectorAll('img[data-hg-image-reference]'));
      while (Date.now() < deadline) {
        const list = imgs();
        if (list.length === 44 && list.every((img) => img.src && img.src.startsWith('blob:'))) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      const list = imgs();
      const withSrc = list.filter((img) => img.src && img.src.startsWith('blob:'));
      // 逐个 fetch blob URL：被 revoke 的会抛错 → 判定失败。
      let alive = 0, dead = 0;
      await Promise.all(withSrc.map(async (img) => {
        try { const r = await fetch(img.src); await r.blob(); alive++; }
        catch { dead++; }
      }));
      return {
        total: list.length,
        withSrc: withSrc.length,
        alive,
        dead,
        retried: globalThis.__mockHongguoImageAttempts['https://hongguo.test/poster-1.jpg']
      };
    })()`,
    awaitPromise: true,
    returnByValue: true
  });
  assert.equal(posterCheck.result.value.total, 44, "超过缓存上限后也不能删除封面 img 节点");
  assert.equal(posterCheck.result.value.withSrc, 44, "44 张封面都应绑定有效 blob URL");
  assert.equal(posterCheck.result.value.retried, 2, "红果封面瞬时失败后应自动重试一次并恢复");
  assert.equal(posterCheck.result.value.dead, 0, "在场封面的 blob URL 不应被 revoke（刷到后面上面图消失的回归）");

  // ID 直达：在输入框填剧集 ID → 提交 → 进入详情页
  await evaluate({
    expression: `(() => {
      const root = document.getElementById(${JSON.stringify(HOST_ID)}).shadowRoot;
      const input = root.querySelector('.hg-search-input');
      input.value = '7503745441910017049';
      root.querySelector('.hg-search-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    })()`,
    returnByValue: false
  });

  await evaluate({
    expression: `new Promise((resolve, reject) => {
      const deadline = Date.now() + 3_000;
      const poll = () => {
        const state = globalThis[${JSON.stringify(BRIDGE_KEY)}].hongguo.getState();
        if (state.view === 'detail' && state.selectedDramaId === '7503745441910017049') resolve(true);
        else if (Date.now() > deadline) reject(new Error('Hongguo ID direct-open detail timeout'));
        else setTimeout(poll, 20);
      };
      poll();
    })`,
    awaitPromise: true,
    returnByValue: true
  });

  // 打开成功应自动加入「我的片单」；回首页应能看到该项，点它可再次进详情
  await evaluate({
    expression: `new Promise((resolve, reject) => {
      const deadline = Date.now() + 3_000;
      const poll = () => {
        const state = globalThis[${JSON.stringify(BRIDGE_KEY)}].hongguo.getState();
        if (state.listCount >= 1) resolve(true);
        else if (Date.now() > deadline) reject(new Error('Hongguo playlist auto-add timeout'));
        else setTimeout(poll, 20);
      };
      poll();
    })`,
    awaitPromise: true,
    returnByValue: true
  });
  const hongguoDetail = await evaluate({
    expression: `(() => {
      const root = document.getElementById(${JSON.stringify(HOST_ID)}).shadowRoot;
      const result = {
        cards: Array.from(root.querySelectorAll('[data-card]')).map((card) => card.dataset.card),
        episodeCount: root.querySelectorAll('.hg-episode').length
      };
      root.querySelectorAll('.hg-episode')[0].click();
      return result;
    })()`,
    returnByValue: true
  });
  assert.deepEqual(hongguoDetail.result.value, { cards: ["hongguo", "emby"], episodeCount: 3 });

  await evaluate({
    expression: `new Promise((resolve, reject) => {
      const deadline = Date.now() + 3_000;
      const poll = () => {
        const state = globalThis[${JSON.stringify(BRIDGE_KEY)}].hongguo.getState();
        if (state.view === 'playback') resolve(true);
        else if (Date.now() > deadline) reject(new Error('Hongguo playback state timeout'));
        else setTimeout(poll, 20);
      };
      poll();
    })`,
    awaitPromise: true,
    returnByValue: true
  });
  const hongguoPlayback = await evaluate({
    expression: `(() => {
      const root = document.getElementById(${JSON.stringify(HOST_ID)}).shadowRoot;
      const result = {
        controls: root.querySelector('.hg-video').controls,
        objectFit: getComputedStyle(root.querySelector('.hg-video')).objectFit,
        pictureInPictureDisabled: root.querySelector('.hg-video').disablePictureInPicture,
        customPictureInPictureEntry: Boolean(root.querySelector('[aria-label*="画中画"]'))
      };
      return result;
    })()`,
    returnByValue: true
  });
  assert.deepEqual(hongguoPlayback.result.value, {
    controls: true,
    objectFit: "contain",
    pictureInPictureDisabled: true,
    customPictureInPictureEntry: false
  });

  const hongguoAutoplayPrompt = await evaluate({
    expression: `(() => {
      const root = document.getElementById(${JSON.stringify(HOST_ID)}).shadowRoot;
      root.querySelector('.hg-video').dispatchEvent(new Event('ended'));
      return {
        hidden: root.querySelector('.hg-autoplay').hidden,
        title: root.querySelector('.hg-autoplay-title').textContent,
        detail: root.querySelector('.hg-autoplay-detail').textContent,
        actions: Array.from(root.querySelectorAll('.hg-autoplay-actions button')).map((button) => button.textContent)
      };
    })()`,
    returnByValue: true
  });
  assert.deepEqual(hongguoAutoplayPrompt.result.value, {
    hidden: false,
    title: "即将为你播放下一集",
    detail: "第 2 集 · 5 秒后自动播放",
    actions: ["立即播放", "取消"]
  });
  await evaluate({
    expression: `new Promise((resolve, reject) => {
      const deadline = Date.now() + 7_000;
      const poll = () => {
        const openedNext = globalThis.__embyRpcLog.some(
          (entry) => entry.method === 'hongguo.playback.open' && entry.params?.episode === 2
        );
        const state = globalThis[${JSON.stringify(BRIDGE_KEY)}].hongguo.getState();
        if (openedNext && state.view === 'playback') resolve(true);
        else if (Date.now() > deadline) reject(new Error('Hongguo autoplay timeout'));
        else setTimeout(poll, 20);
      };
      poll();
    })`,
    awaitPromise: true,
    returnByValue: true
  });
  const hongguoAutoplayResult = await evaluate({
    expression: `(() => {
      const root = document.getElementById(${JSON.stringify(HOST_ID)}).shadowRoot;
      const title = root.querySelector('.hg-playback-title').textContent;
      root.querySelector('.hg-video').dispatchEvent(new Event('ended'));
      root.querySelectorAll('.hg-autoplay-actions button')[1].click();
      const cancelled = {
        title: root.querySelector('.hg-autoplay-title').textContent,
        detail: root.querySelector('.hg-autoplay-detail').textContent,
        actions: Array.from(root.querySelectorAll('.hg-autoplay-actions button')).map((button) => button.textContent)
      };
      root.querySelector('.hg-playback').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return {
        title,
        cancelled,
        stoppedSessions: globalThis.__embyRpcLog.filter((entry) => entry.method === 'hongguo.playback.stop').length
      };
    })()`,
    returnByValue: true
  });
  assert.deepEqual(hongguoAutoplayResult.result.value, {
    title: "红果合并样片 · 第 2 集",
    cancelled: {
      title: "已取消自动连播",
      detail: "第 3 集等待播放",
      actions: ["播放下一集", "重播"]
    },
    stoppedSessions: 2
  });
  await evaluate({
    expression: `new Promise((resolve, reject) => {
      const deadline = Date.now() + 3_000;
      const poll = () => {
        if (globalThis[${JSON.stringify(BRIDGE_KEY)}].hongguo.getState().view === 'detail') resolve(true);
        else if (Date.now() > deadline) reject(new Error('Hongguo cleanup timeout'));
        else setTimeout(poll, 20);
      };
      poll();
    })`,
    awaitPromise: true,
    returnByValue: true
  });
  await evaluate({ expression: `globalThis.__hlsProbe = { created: 0, destroyed: 0, manifests: 0 }` });

  await evaluate({
    expression: `document.getElementById(${JSON.stringify(HOST_ID)}).shadowRoot.querySelectorAll('.hg-episode')[2].click()`
  });
  await evaluate({
    expression: `new Promise((resolve, reject) => {
      const deadline = Date.now() + 3_000;
      const poll = () => {
        const state = globalThis[${JSON.stringify(BRIDGE_KEY)}].hongguo.getState();
        if (state.view === 'error') resolve(true);
        else if (Date.now() > deadline) reject(new Error('Hongguo source error state timeout'));
        else setTimeout(poll, 20);
      };
      poll();
    })`,
    awaitPromise: true,
    returnByValue: true
  });
  const hongguoErrorReturn = await evaluate({
    expression: `(() => {
      const root = document.getElementById(${JSON.stringify(HOST_ID)}).shadowRoot;
      root.querySelector('[data-view="error"] .hg-button:not(.primary)').click();
      root.querySelector('[data-view="detail"] .hg-toolbar .hg-icon-button').click();
      return globalThis[${JSON.stringify(BRIDGE_KEY)}].hongguo.getState().view;
    })()`,
    returnByValue: true
  });
  // 错误页返回 → 详情页返回 → 现在统一回首页（不再有 search 视图）
  assert.equal(hongguoErrorReturn.result.value, "home");
  // 首页「我的片单」里点回该剧（自动收藏的项），应重新进入详情
  await evaluate({
    expression: `document.getElementById(${JSON.stringify(HOST_ID)}).shadowRoot.querySelector('.hg-list-row .hg-result').click()`
  });
  await evaluate({
    expression: `new Promise((resolve, reject) => {
      const deadline = Date.now() + 3_000;
      const poll = () => {
        if (globalThis[${JSON.stringify(BRIDGE_KEY)}].hongguo.getState().view === 'detail') resolve(true);
        else if (Date.now() > deadline) reject(new Error('Hongguo detail restore timeout'));
        else setTimeout(poll, 20);
      };
      poll();
    })`,
    awaitPromise: true,
    returnByValue: true
  });

  await evaluate({
    expression: `new Promise((resolve, reject) => {
      const deadline = Date.now() + 3_000;
      const poll = () => {
        const view = document.getElementById(${JSON.stringify(HOST_ID)})?.shadowRoot
          ?.querySelector('.emby-view')?.dataset.view;
        if (view === 'disconnected') resolve(true);
        else if (Date.now() > deadline) reject(new Error('Emby disconnected state timeout'));
        else setTimeout(poll, 20);
      };
      poll();
    })`,
    awaitPromise: true,
    returnByValue: true
  });

  const submitEvaluation = await evaluate({
    expression: `(() => {
      const root = document.getElementById(${JSON.stringify(HOST_ID)}).shadowRoot;
      const form = root.querySelector('.emby-login');
      const [server, username, password] = form.querySelectorAll('input');
      server.value = 'https://emby.test';
      username.value = 'smoke-user';
      password.value = 'secret-not-persisted';
      const dispatched = form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      return { dispatched, valid: form.checkValidity() };
    })()`,
    returnByValue: true
  });
  assert.equal(submitEvaluation.exceptionDetails, undefined);
  assert.deepEqual(submitEvaluation.result.value, { dispatched: false, valid: true });

  await evaluate({
    expression: `new Promise((resolve, reject) => {
      const deadline = Date.now() + 3_000;
      const poll = () => {
        const view = globalThis[${JSON.stringify(BRIDGE_KEY)}]?.emby.getState().view;
        if (view === 'home') resolve(true);
        else if (Date.now() > deadline) reject(new Error('Emby home state timeout'));
        else setTimeout(poll, 20);
      };
      poll();
    })`,
    awaitPromise: true,
    returnByValue: true
  });

  const imageRecovery = await evaluate({
    expression: `new Promise((resolve, reject) => {
      const deadline = Date.now() + 3_000;
      const poll = () => {
        const root = document.getElementById(${JSON.stringify(HOST_ID)}).shadowRoot;
        const image = root.querySelector('.emby-section .emby-poster img');
        if (image?.dataset.imageState === 'loaded') {
          resolve({
            attempts: globalThis.__mockImageAttempts['emby://image/library'],
            width: image.naturalWidth,
            height: image.naturalHeight
          });
        } else if (Date.now() > deadline) reject(new Error('Emby image retry timeout'));
        else setTimeout(poll, 20);
      };
      poll();
    })`,
    awaitPromise: true,
    returnByValue: true
  });
  assert.deepEqual(imageRecovery.result.value, { attempts: 2, width: 144, height: 208 });

  const libraryEvaluation = await evaluate({
    expression: `(() => {
      const root = document.getElementById(${JSON.stringify(HOST_ID)}).shadowRoot;
      const library = root.querySelector('.emby-section .emby-poster-button');
      library.click();
      return library.title;
    })()`,
    returnByValue: true
  });
  assert.equal(libraryEvaluation.exceptionDetails, undefined);
  assert.equal(libraryEvaluation.result.value, "华语电影");
  await evaluate({
    expression: `new Promise((resolve, reject) => {
      const deadline = Date.now() + 3_000;
      const poll = () => {
        const root = document.getElementById(${JSON.stringify(HOST_ID)}).shadowRoot;
        const state = globalThis[${JSON.stringify(BRIDGE_KEY)}]?.emby.getState();
        if (state?.view === 'library' && state.libraryItemCount === 2) {
          root.querySelector('.emby-toolbar .emby-icon-button').click();
          resolve(true);
        } else if (Date.now() > deadline) reject(new Error('Emby library browsing timeout'));
        else setTimeout(poll, 20);
      };
      poll();
    })`,
    awaitPromise: true,
    returnByValue: true
  });

  const serverSwitchEvaluation = await evaluate({
    expression: `new Promise((resolve, reject) => {
      const root = document.getElementById(${JSON.stringify(HOST_ID)}).shadowRoot;
      root.querySelector('[aria-label="切换 Emby 服务器"]').click();
      const deadline = Date.now() + 3_000;
      const poll = () => {
        const state = globalThis[${JSON.stringify(BRIDGE_KEY)}]?.emby.getState();
        const buttons = root.querySelectorAll('.emby-server-list .emby-list-button');
        if (state?.view === 'servers' && buttons.length === 2) {
          buttons[1].click();
          resolve(buttons.length);
        } else if (Date.now() > deadline) reject(new Error('Emby server switcher timeout'));
        else setTimeout(poll, 20);
      };
      poll();
    })`,
    awaitPromise: true,
    returnByValue: true
  });
  assert.equal(serverSwitchEvaluation.result.value, 2);
  await evaluate({
    expression: `new Promise((resolve, reject) => {
      const deadline = Date.now() + 3_000;
      const poll = () => {
        const state = globalThis[${JSON.stringify(BRIDGE_KEY)}]?.emby.getState();
        if (state?.view === 'home' && state.baseUrl === 'https://emby-backup.test') resolve(true);
        else if (Date.now() > deadline) reject(new Error('Emby server switch timeout'));
        else setTimeout(poll, 20);
      };
      poll();
    })`,
    awaitPromise: true,
    returnByValue: true
  });

  const state = await evaluate({
    expression: `(() => {
      const host = document.getElementById(${JSON.stringify(HOST_ID)});
      const rail = document.getElementById(${JSON.stringify(RAIL_ID)});
      const scrollRoot = document.querySelector('[data-codex-companion-scroll-root]');
      const hgToolbar = host?.shadowRoot?.querySelector('.hg-toolbar');
      const embyToolbar = host?.shadowRoot?.querySelector('.emby-toolbar');
      const hgToolbarStyle = hgToolbar ? getComputedStyle(hgToolbar) : null;
      const embyToolbarStyle = embyToolbar ? getComputedStyle(embyToolbar) : null;
      const hgTitleStyle = host?.shadowRoot?.querySelector('.hg-toolbar-title')
        ? getComputedStyle(host.shadowRoot.querySelector('.hg-toolbar-title'))
        : null;
      const embyTitleStyle = host?.shadowRoot?.querySelector('.emby-toolbar-title')
        ? getComputedStyle(host.shadowRoot.querySelector('.emby-toolbar-title'))
        : null;
      return {
        host: Boolean(host),
        rail: Boolean(rail),
        shadow: Boolean(host?.shadowRoot),
        hongguoView: globalThis[${JSON.stringify(BRIDGE_KEY)}]?.hongguo.getState().view,
        bridge: typeof globalThis[${JSON.stringify(BRIDGE_KEY)}]?.setVideoFile === "function",
        embyBridge: typeof globalThis[${JSON.stringify(BRIDGE_KEY)}]?.emby.receiveRpc === "function",
        cards: Array.from(host?.shadowRoot?.querySelectorAll("[data-card]") ?? []).map((card) => card.dataset.card),
        embyView: host?.shadowRoot?.querySelector(".emby-view")?.dataset.view,
        embyLogicalHeight: getComputedStyle(host?.shadowRoot?.querySelector('[data-card="emby"]')).height,
        embyRenderedHeight: Math.round(host?.shadowRoot?.querySelector('[data-card="emby"]')?.getBoundingClientRect().height ?? 0),
        hongguoLogicalHeight: getComputedStyle(host?.shadowRoot?.querySelector('[data-card="hongguo"]')).height,
        hongguoRenderedHeight: Math.round(host?.shadowRoot?.querySelector('[data-card="hongguo"]')?.getBoundingClientRect().height ?? 0),
        cardGap: Math.round(
          (host?.shadowRoot?.querySelector('[data-card="emby"]')?.getBoundingClientRect().top ?? 0)
          - (host?.shadowRoot?.querySelector('[data-card="hongguo"]')?.getBoundingClientRect().bottom ?? 0)
        ),
        width: Math.round(host?.shadowRoot?.querySelector(".panel")?.getBoundingClientRect().width ?? 0),
        hostX: Math.round(host?.getBoundingClientRect().x ?? 0),
        hostY: Math.round(host?.getBoundingClientRect().y ?? 0),
        position: host ? getComputedStyle(host).position : null,
        placement: globalThis[${JSON.stringify(BRIDGE_KEY)}]?.getPlacement(),
        overflowY: scrollRoot ? getComputedStyle(scrollRoot).overflowY : null,
        leftShadowGutter: Math.round(
          (host?.getBoundingClientRect().x ?? 0)
          - (rail?.getBoundingClientRect().x ?? 0)
        ),
        rightShadowGutter: Math.round(
          (rail?.getBoundingClientRect().right ?? 0)
          - (host?.getBoundingClientRect().right ?? 0)
        ),
        topShadowGutter: Math.round(
          (host?.getBoundingClientRect().top ?? 0)
          - (rail?.getBoundingClientRect().top ?? 0)
        ),
        bottomShadowGutter: Math.round(
          (rail?.getBoundingClientRect().bottom ?? 0)
          - (host?.getBoundingClientRect().bottom ?? 0)
        ),
        railWidth: Math.round(rail?.getBoundingClientRect().width ?? 0),
        contentWidth: Math.round(document.getElementById("content")?.getBoundingClientRect().width ?? 0),
        toolbarStyle: {
          hongguo: [hgToolbarStyle?.height, hgToolbarStyle?.paddingTop, hgToolbarStyle?.paddingRight, hgToolbarStyle?.paddingBottom, hgToolbarStyle?.paddingLeft],
          emby: [embyToolbarStyle?.height, embyToolbarStyle?.paddingTop, embyToolbarStyle?.paddingRight, embyToolbarStyle?.paddingBottom, embyToolbarStyle?.paddingLeft],
          hongguoTitle: [hgTitleStyle?.fontSize, hgTitleStyle?.lineHeight, hgTitleStyle?.fontWeight],
          embyTitle: [embyTitleStyle?.fontSize, embyTitleStyle?.lineHeight, embyTitleStyle?.fontWeight],
          dividerInsets: [getComputedStyle(hgToolbar, '::after').left, getComputedStyle(hgToolbar, '::after').right]
        },
        embySearchInput: (() => {
          const input = host?.shadowRoot?.querySelector('.emby-toolbar .emby-search-input');
          return input ? { type: input.type, placeholder: input.placeholder } : null;
        })(),
        embyToolbarIcons: Array.from(host?.shadowRoot?.querySelectorAll('.emby-toolbar .emby-icon-button') ?? []).map((button) => ({
          label: button.getAttribute('aria-label'),
          svg: button.firstElementChild?.tagName?.toLowerCase(),
          paths: button.querySelectorAll('path').length,
          text: button.textContent
        }))
      };
    })()`,
    returnByValue: true
  });
  assert.deepEqual(
    {
      host: state.result.value.host,
      rail: state.result.value.rail,
      shadow: state.result.value.shadow,
      hongguoView: state.result.value.hongguoView,
      bridge: state.result.value.bridge,
      embyBridge: state.result.value.embyBridge,
      cards: state.result.value.cards,
      embyView: state.result.value.embyView,
      embyLogicalHeight: state.result.value.embyLogicalHeight,
      embyRenderedHeight: state.result.value.embyRenderedHeight,
      hongguoLogicalHeight: state.result.value.hongguoLogicalHeight,
      hongguoRenderedHeight: state.result.value.hongguoRenderedHeight,
      cardGap: state.result.value.cardGap,
      width: state.result.value.width,
      hostX: state.result.value.hostX,
      hostY: state.result.value.hostY,
      position: state.result.value.position,
      placement: state.result.value.placement,
      overflowY: state.result.value.overflowY,
      leftShadowGutter: state.result.value.leftShadowGutter,
      rightShadowGutter: state.result.value.rightShadowGutter,
      topShadowGutter: state.result.value.topShadowGutter,
      railWidth: state.result.value.railWidth,
      contentWidth: state.result.value.contentWidth
    },
    {
      host: true,
      rail: true,
      shadow: true,
      hongguoView: "detail",
      bridge: true,
      embyBridge: true,
      cards: ["hongguo", "emby"],
      embyView: "home",
      embyLogicalHeight: "400px",
      embyRenderedHeight: 400,
      hongguoLogicalHeight: "520px",
      hongguoRenderedHeight: 520,
      cardGap: 24,
      width: 300,
      hostX: 1124,
      hostY: 287,
      position: "static",
      placement: "animated-summary",
      overflowY: "auto",
      leftShadowGutter: 16,
      rightShadowGutter: 16,
      topShadowGutter: 12,
      railWidth: 332,
      contentWidth: 1440
    }
  );
  assert.ok(state.result.value.bottomShadowGutter >= 9, "rail 必须保留底部阴影缓冲，滚动交给外层容器");
  assert.deepEqual(state.result.value.toolbarStyle, {
    hongguo: ["38px", "10px", "10px", "2px", "14px"],
    emby: ["38px", "10px", "10px", "2px", "14px"],
    hongguoTitle: ["14px", "21px", "445"],
    embyTitle: [null, null, null],
    dividerInsets: ["14px", "14px"]
  });
  assert.deepEqual(state.result.value.embySearchInput, {
    type: "search",
    placeholder: "搜索电影、剧集或单集"
  });
  assert.deepEqual(state.result.value.embyToolbarIcons, [
    { label: "搜索媒体", svg: "svg", paths: 2, text: "" },
    { label: "切换 Emby 服务器", svg: "svg", paths: 3, text: "" }
  ]);

  const scrollProbe = await evaluate({
    expression: `(() => {
      const host = document.getElementById(${JSON.stringify(HOST_ID)});
      const outer = document.querySelector('[data-codex-companion-scroll-root]');
      const inner = host.shadowRoot.querySelector('.hg-scroll');
      const spacer = document.createElement('div');
      spacer.id = 'hg-scroll-chain-probe';
      spacer.style.cssText = 'height:1000px;flex:0 0 1000px';
      inner.append(spacer);
      inner.scrollTop = inner.scrollHeight;
      outer.scrollTop = 0;
      globalThis.__nativePanelTopBeforeOuterScroll = document.getElementById('native-panel').getBoundingClientRect().top;
      const rect = inner.getBoundingClientRect();
      return {
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + Math.min(rect.height / 2, 80)),
        innerTop: inner.scrollTop,
        innerMax: inner.scrollHeight - inner.clientHeight,
        outerMax: outer.scrollHeight - outer.clientHeight,
        overscrollY: getComputedStyle(inner).overscrollBehaviorY
      };
    })()`,
    returnByValue: true
  });
  assert.equal(scrollProbe.result.value.overscrollY, "contain");
  assert.equal(scrollProbe.result.value.innerTop, scrollProbe.result.value.innerMax);
  assert.ok(scrollProbe.result.value.outerMax > 0);
  for (let index = 0; index < 4; index += 1) {
    await connection.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: scrollProbe.result.value.x,
      y: scrollProbe.result.value.y,
      deltaX: 0,
      deltaY: 250
    });
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  const chainedScrollTop = await evaluate({
    expression: `(() => {
      const host = document.getElementById(${JSON.stringify(HOST_ID)});
      const outer = document.querySelector('[data-codex-companion-scroll-root]');
      host.shadowRoot.getElementById('hg-scroll-chain-probe')?.remove();
      const scrollTop = outer.scrollTop;
      const summaryDelta = Math.round(
        globalThis.__nativePanelTopBeforeOuterScroll
        - document.getElementById('native-panel').getBoundingClientRect().top
      );
      outer.scrollTop = 0;
      return { scrollTop, summaryDelta };
    })()`,
    returnByValue: true
  });
  assert.equal(chainedScrollTop.result.value.scrollTop, 0, "卡片内部滚到底后，不应带动外层右栏滚动");
  assert.equal(
    chainedScrollTop.result.value.summaryDelta,
    0,
    "内层滚动不应移动官方 Summary"
  );

  const layoutScreenshotPath = process.env.CODEX_COMPANION_SMOKE_SCREENSHOT
    || process.env.CODEX_HG_SMOKE_SCREENSHOT;
  if (layoutScreenshotPath) {
    const screenshot = await connection.send("Page.captureScreenshot", { format: "png" });
    await writeFile(layoutScreenshotPath, Buffer.from(screenshot.data, "base64"));
  }

  await evaluate({
    expression: `document.getElementById(${JSON.stringify(HOST_ID)}).shadowRoot
      .querySelector('.emby-hero').click()`
  });
  await evaluate({
    expression: `new Promise((resolve, reject) => {
      const deadline = Date.now() + 3_000;
      const poll = () => {
        const root = document.getElementById(${JSON.stringify(HOST_ID)}).shadowRoot;
        const state = globalThis[${JSON.stringify(BRIDGE_KEY)}].emby.getState();
        const contextLoaded = globalThis.__embyRpcLog.some(
          (request) => request.method === 'series.get' && request.params?.seriesId === 'series-1'
        );
        if (
          state.view === 'playback'
          && state.episodeCount === 12
          && contextLoaded
          && root.querySelector('.emby-episode-picker-button')?.textContent === 'S1 · E6'
        ) resolve(true);
        else if (Date.now() > deadline) reject(new Error('Emby resume episode context timeout'));
        else setTimeout(poll, 20);
      };
      poll();
    })`,
    awaitPromise: true,
    returnByValue: true
  });
  const resumeNavigationState = await evaluate({
    expression: `(() => {
      const root = document.getElementById(${JSON.stringify(HOST_ID)}).shadowRoot;
      const result = {
        previousDisabled: root.querySelector('[data-episode-direction="-1"]').disabled,
        nextDisabled: root.querySelector('[data-episode-direction="1"]').disabled
      };
      root.querySelector('.emby-playback').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
      );
      return result;
    })()`,
    returnByValue: true
  });
  assert.deepEqual(resumeNavigationState.result.value, {
    previousDisabled: false,
    nextDisabled: false
  });
  await evaluate({
    expression: `new Promise((resolve, reject) => {
      const deadline = Date.now() + 3_000;
      const poll = () => {
        if (globalThis[${JSON.stringify(BRIDGE_KEY)}].emby.getState().view === 'home') resolve(true);
        else if (Date.now() > deadline) reject(new Error('Emby resume playback cleanup timeout'));
        else setTimeout(poll, 20);
      };
      poll();
    })`,
    awaitPromise: true,
    returnByValue: true
  });
  await evaluate({ expression: `globalThis.__hlsProbe = { created: 0, destroyed: 0, manifests: 0 }` });

  await evaluate({
    expression: `(() => {
      const root = document.getElementById(${JSON.stringify(HOST_ID)}).shadowRoot;
      const input = root.querySelector('.emby-search-input');
      input.value = '示例';
      root.querySelector('[aria-label="搜索媒体"]').click();
    })()`
  });

  await evaluate({
    expression: `new Promise((resolve, reject) => {
      const deadline = Date.now() + 3_000;
      const poll = () => {
        const state = globalThis[${JSON.stringify(BRIDGE_KEY)}].emby.getState();
        if (state.view === 'search' && state.searchCount === 2) resolve(true);
        else if (Date.now() > deadline) reject(new Error('Emby search state timeout'));
        else setTimeout(poll, 20);
      };
      poll();
    })`,
    awaitPromise: true,
    returnByValue: true
  });

  await evaluate({
    expression: `document.getElementById(${JSON.stringify(HOST_ID)}).shadowRoot
      .querySelector('.emby-results .emby-list-button').click()`
  });
  await evaluate({
    expression: `new Promise((resolve, reject) => {
      const deadline = Date.now() + 3_000;
      const poll = () => {
        const state = globalThis[${JSON.stringify(BRIDGE_KEY)}].emby.getState();
        if (state.view === 'series' && state.episodeCount === 12) resolve(true);
        else if (Date.now() > deadline) reject(new Error('Emby series state timeout'));
        else setTimeout(poll, 20);
      };
      poll();
    })`,
    awaitPromise: true,
    returnByValue: true
  });

  const seriesState = await evaluate({
    expression: `(() => {
      const root = document.getElementById(${JSON.stringify(HOST_ID)}).shadowRoot;
      const list = root.querySelector('.emby-episodes');
      list.scrollTop = 160;
      globalThis.__seriesScrollTop = list.scrollTop;
      const result = {
        seasonChips: root.querySelectorAll('.emby-chip').length,
        episodeRows: root.querySelectorAll('.emby-episode-button').length,
        scrollTop: globalThis.__seriesScrollTop
      };
      root.querySelectorAll('.emby-episode-button')[11].click();
      return result;
    })()`,
    returnByValue: true
  });
  assert.deepEqual(seriesState.result.value, { seasonChips: 2, episodeRows: 12, scrollTop: 160 });

  await evaluate({
    expression: `new Promise((resolve, reject) => {
      const deadline = Date.now() + 3_000;
      const poll = () => {
        const state = globalThis[${JSON.stringify(BRIDGE_KEY)}].emby.getState();
        const track = document.getElementById(${JSON.stringify(HOST_ID)})?.shadowRoot
          ?.querySelector('track[data-emby-subtitle]');
        if (state.view === 'playback' && globalThis.__hlsProbe.manifests === 1 && track) resolve(true);
        else if (Date.now() > deadline) reject(new Error('Emby playback state timeout'));
        else setTimeout(poll, 20);
      };
      poll();
    })`,
    awaitPromise: true,
    returnByValue: true
  });

  const playbackState = await evaluate({
    expression: `(() => {
      const root = document.getElementById(${JSON.stringify(HOST_ID)}).shadowRoot;
      const card = root.querySelector('[data-card="emby"]');
      const playback = root.querySelector('.emby-playback');
      const video = root.querySelector('.emby-video');
      const back = root.querySelector('.emby-playback-back');
      const open = globalThis.__embyRpcLog.findLast((request) => request.method === 'playback.open');
      return {
        view: globalThis[${JSON.stringify(BRIDGE_KEY)}].emby.getState().view,
        cardHeight: getComputedStyle(card).height,
        playbackWidth: Math.round(playback.getBoundingClientRect().width),
        playbackHeight: Math.round(playback.getBoundingClientRect().height),
        videoFit: getComputedStyle(video).objectFit,
        videoControls: video.controls,
        backOpacity: getComputedStyle(back).opacity,
        startPositionTicks: open.params.startPositionTicks,
        subtitleButton: root.querySelector('.emby-subtitle-button')?.getAttribute('aria-label'),
        subtitleButtonText: root.querySelector('.emby-subtitle-button')?.textContent,
        subtitleButtonTop: Math.round(root.querySelector('.emby-subtitle-button')?.getBoundingClientRect().top ?? 0),
        backButtonTop: Math.round(back.getBoundingClientRect().top),
        subtitleTrackUrl: root.querySelector('track[data-emby-subtitle]')?.src,
        subtitleLoadCalled: globalThis.__embyRpcLog.some((request) => request.method === 'playback.subtitle.load'),
        hls: globalThis.__hlsProbe
      };
    })()`,
    returnByValue: true
  });
  assert.equal(playbackState.result.value.view, "playback");
  assert.equal(playbackState.result.value.cardHeight, "400px");
  assert.equal(playbackState.result.value.playbackWidth, 300);
  assert.equal(playbackState.result.value.playbackHeight, 400);
  assert.equal(playbackState.result.value.videoFit, "contain");
  assert.equal(playbackState.result.value.videoControls, true);
  assert.equal(playbackState.result.value.backOpacity, "1");
  assert.equal(playbackState.result.value.startPositionTicks, 120_000_000);
  assert.equal(playbackState.result.value.subtitleButton, "字幕：简体中文");
  assert.equal(playbackState.result.value.subtitleButtonText, "");
  assert.equal(playbackState.result.value.subtitleButtonTop, playbackState.result.value.backButtonTop);
  assert.match(playbackState.result.value.subtitleTrackUrl, /^blob:/);
  assert.equal(playbackState.result.value.subtitleLoadCalled, true);
  assert.deepEqual(playbackState.result.value.hls.options, {
    maxBufferLength: 30,
    backBufferLength: 15,
    maxBufferSize: 24 * 1024 * 1024,
    capLevelToPlayerSize: true,
    enableWorker: true
  });
  assert.equal(playbackState.result.value.hls.autoLevelCapping, 1);
  assert.equal(playbackState.result.value.hls.source, "https://emby.test/Videos/test/master.m3u8");

  const episodeNavigationState = await evaluate({
    expression: `(() => {
      const root = document.getElementById(${JSON.stringify(HOST_ID)}).shadowRoot;
      const pickerButton = root.querySelector('.emby-episode-picker-button');
      pickerButton.click();
      const current = root.querySelector('.emby-episode-picker-item[aria-current="true"]');
      const result = {
        previousDisabled: root.querySelector('[data-episode-direction="-1"]').disabled,
        currentLabel: pickerButton.textContent,
        nextDisabled: root.querySelector('[data-episode-direction="1"]').disabled,
        pickerOpen: !root.querySelector('.emby-episode-picker').hidden,
        seasonCount: root.querySelectorAll('.emby-episode-season').length,
        episodeCount: root.querySelectorAll('.emby-episode-picker-item').length,
        currentEpisode: current?.textContent
      };
      return result;
    })()`,
    returnByValue: true
  });
  assert.deepEqual(episodeNavigationState.result.value, {
    previousDisabled: false,
    currentLabel: "S1 · E12",
    nextDisabled: false,
    pickerOpen: true,
    seasonCount: 2,
    episodeCount: 12,
    currentEpisode: "第 12 集"
  });
  const playbackScreenshotPath = process.env.CODEX_COMPANION_SMOKE_PLAYBACK_SCREENSHOT
    || process.env.CODEX_HG_SMOKE_PLAYBACK_SCREENSHOT;
  if (playbackScreenshotPath) {
    const clipResult = await evaluate({
      expression: `new Promise((resolve) => {
        const outer = document.querySelector('[data-codex-companion-scroll-root]');
        const card = document.getElementById(${JSON.stringify(HOST_ID)}).shadowRoot
          .querySelector('[data-card="emby"]');
        const previousScrollTop = outer.scrollTop;
        card.scrollIntoView({ block: 'center' });
        requestAnimationFrame(() => {
          const rect = card.getBoundingClientRect();
          resolve({
            clip: {
              x: rect.x + window.scrollX,
              y: rect.y + window.scrollY,
              width: rect.width,
              height: rect.height,
              scale: 1
            },
            previousScrollTop
          });
        });
      })`,
      awaitPromise: true,
      returnByValue: true
    });
    const screenshot = await connection.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      clip: clipResult.result.value.clip
    });
    await writeFile(playbackScreenshotPath, Buffer.from(screenshot.data, "base64"));
    await evaluate({
      expression: `document.querySelector('[data-codex-companion-scroll-root]').scrollTop = ${JSON.stringify(
        clipResult.result.value.previousScrollTop
      )}`
    });
  }
  await evaluate({
    expression: `document.getElementById(${JSON.stringify(HOST_ID)}).shadowRoot
      .querySelector('.emby-episode-picker-button').click()`
  });

  const subtitleMenuState = await evaluate({
    expression: `(() => {
      const root = document.getElementById(${JSON.stringify(HOST_ID)}).shadowRoot;
      root.querySelector('.emby-subtitle-button').click();
      const options = Array.from(root.querySelectorAll('.emby-subtitle-option'));
      const selected = options.find((option) => option.getAttribute('aria-checked') === 'true');
      selected.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      const result = {
        labels: options.map((option) => option.textContent.trim()),
        selected: selected?.dataset.subtitleIndex,
        arrowFocus: root.activeElement?.dataset.subtitleIndex,
        menuBorderWidth: getComputedStyle(root.querySelector('.emby-subtitle-menu')).borderTopWidth,
        optionBorderWidth: getComputedStyle(options[0]).borderTopWidth
      };
      return result;
    })()`,
    returnByValue: true
  });
  assert.deepEqual(subtitleMenuState.result.value, {
    labels: ["关闭字幕", "简体中文外挂", "日文 ASS"],
    selected: "2",
    arrowFocus: "3",
    menuBorderWidth: "0px",
    optionBorderWidth: "0px"
  });

  const subtitleScreenshotPath = process.env.CODEX_COMPANION_SMOKE_SUBTITLE_SCREENSHOT;
  if (subtitleScreenshotPath) {
    const clipResult = await evaluate({
      expression: `(() => {
        const card = document.getElementById(${JSON.stringify(HOST_ID)}).shadowRoot.querySelector('[data-card="emby"]');
        const rect = card.getBoundingClientRect();
        return { x: rect.x + scrollX, y: rect.y + scrollY, width: rect.width, height: rect.height, scale: 1 };
      })()`,
      returnByValue: true
    });
    const screenshot = await connection.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      clip: clipResult.result.value
    });
    await writeFile(subtitleScreenshotPath, Buffer.from(screenshot.data, "base64"));
  }

  await evaluate({
    expression: `document.getElementById(${JSON.stringify(HOST_ID)}).shadowRoot
      .querySelector('.emby-subtitle-option[data-subtitle-index="off"]').click()`
  });

  await evaluate({
    expression: `new Promise((resolve, reject) => {
      const deadline = Date.now() + 3_000;
      const poll = () => {
        const root = document.getElementById(${JSON.stringify(HOST_ID)}).shadowRoot;
        const state = globalThis[${JSON.stringify(BRIDGE_KEY)}].emby.getState();
        if (state.selectedSubtitleIndex === null && !root.querySelector('track[data-emby-subtitle]')) resolve(true);
        else if (Date.now() > deadline) reject(new Error('Emby subtitle off timeout'));
        else setTimeout(poll, 20);
      };
      poll();
    })`,
    awaitPromise: true,
    returnByValue: true
  });

  await evaluate({
    expression: `(() => {
      const root = document.getElementById(${JSON.stringify(HOST_ID)}).shadowRoot;
      const video = root.querySelector('.emby-video');
      video.volume = 0.35;
      video.muted = true;
      root.querySelector('.emby-subtitle-button').click();
      root.querySelector('.emby-subtitle-option[data-subtitle-index="3"]').click();
    })()`
  });
  await evaluate({
    expression: `new Promise((resolve, reject) => {
      const deadline = Date.now() + 3_000;
      const poll = () => {
        const state = globalThis[${JSON.stringify(BRIDGE_KEY)}].emby.getState();
        if (state.subtitleMode === 'burn-in' && globalThis.__hlsProbe.manifests === 2) resolve(true);
        else if (Date.now() > deadline) reject(new Error('Emby burn-in subtitle restart timeout'));
        else setTimeout(poll, 20);
      };
      poll();
    })`,
    awaitPromise: true,
    returnByValue: true
  });
  const burnInState = await evaluate({
    expression: `(() => {
      const root = document.getElementById(${JSON.stringify(HOST_ID)}).shadowRoot;
      const video = root.querySelector('.emby-video');
      const selection = globalThis.__embyRpcLog.findLast((request) => request.method === 'playback.subtitle.select');
      return {
        selectedSubtitleIndex: globalThis[${JSON.stringify(BRIDGE_KEY)}].emby.getState().selectedSubtitleIndex,
        subtitleMode: globalThis[${JSON.stringify(BRIDGE_KEY)}].emby.getState().subtitleMode,
        source: globalThis.__hlsProbe.source,
        destroyed: globalThis.__hlsProbe.destroyed,
        volume: video.volume,
        muted: video.muted,
        paused: video.paused,
        requestedIndex: selection.params.subtitleStreamIndex
      };
    })()`,
    returnByValue: true
  });
  assert.deepEqual(burnInState.result.value, {
    selectedSubtitleIndex: 3,
    subtitleMode: "burn-in",
    source: "https://emby.test/Videos/test/master-ass.m3u8",
    destroyed: 1,
    volume: 0.35,
    muted: true,
    paused: true,
    requestedIndex: 3
  });

  await evaluate({
    expression: `document.getElementById(${JSON.stringify(HOST_ID)}).shadowRoot
      .querySelector('[data-episode-direction="-1"]').click()`
  });
  await evaluate({
    expression: `new Promise((resolve, reject) => {
      const deadline = Date.now() + 3_000;
      const poll = () => {
        const root = document.getElementById(${JSON.stringify(HOST_ID)}).shadowRoot;
        const state = globalThis[${JSON.stringify(BRIDGE_KEY)}].emby.getState();
        const opened = globalThis.__embyRpcLog.findLast((request) => request.method === 'playback.open');
        if (
          state.view === 'playback'
          && opened?.params?.itemId === 'episode-11'
          && root.querySelector('.emby-episode-picker-button')?.textContent === 'S1 · E11'
        ) resolve(true);
        else if (Date.now() > deadline) reject(new Error('Emby previous episode timeout'));
        else setTimeout(poll, 20);
      };
      poll();
    })`,
    awaitPromise: true,
    returnByValue: true
  });

  await evaluate({
    expression: `document.getElementById(${JSON.stringify(HOST_ID)}).shadowRoot
      .querySelector('[data-episode-direction="1"]').click()`
  });
  await evaluate({
    expression: `new Promise((resolve, reject) => {
      const deadline = Date.now() + 3_000;
      const poll = () => {
        const root = document.getElementById(${JSON.stringify(HOST_ID)}).shadowRoot;
        const state = globalThis[${JSON.stringify(BRIDGE_KEY)}].emby.getState();
        const opened = globalThis.__embyRpcLog.findLast((request) => request.method === 'playback.open');
        if (
          state.view === 'playback'
          && opened?.params?.itemId === 'episode-12'
          && root.querySelector('.emby-episode-picker-button')?.textContent === 'S1 · E12'
        ) resolve(true);
        else if (Date.now() > deadline) reject(new Error('Emby next episode timeout'));
        else setTimeout(poll, 20);
      };
      poll();
    })`,
    awaitPromise: true,
    returnByValue: true
  });

  await evaluate({
    expression: `document.getElementById(${JSON.stringify(HOST_ID)}).shadowRoot
      .querySelector('.emby-playback')
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`
  });
  await evaluate({
    expression: `new Promise((resolve, reject) => {
      const deadline = Date.now() + 3_000;
      const poll = () => {
        const state = globalThis[${JSON.stringify(BRIDGE_KEY)}].emby.getState();
        if (state.view === 'series' && globalThis.__hlsProbe.destroyed === 4) {
          requestAnimationFrame(() => resolve(true));
        } else if (Date.now() > deadline) reject(new Error('Emby playback cleanup timeout'));
        else setTimeout(poll, 20);
      };
      poll();
    })`,
    awaitPromise: true,
    returnByValue: true
  });

  const restoredPlayback = await evaluate({
    expression: `(() => {
      const root = document.getElementById(${JSON.stringify(HOST_ID)}).shadowRoot;
      const methods = globalThis.__embyRpcLog.map((request) => request.method);
      return {
        view: globalThis[${JSON.stringify(BRIDGE_KEY)}].emby.getState().view,
        scrollTop: root.querySelector('.emby-episodes').scrollTop,
        videoRemoved: !root.querySelector('.emby-video'),
        stopped: methods.includes('playback.stop'),
        cancelled: methods.includes('rpc.cancel'),
        resourceLoaded: methods.includes('resource.load')
      };
    })()`,
    returnByValue: true
  });
  assert.deepEqual(restoredPlayback.result.value, {
    view: "series",
    scrollTop: 160,
    videoRemoved: true,
    stopped: true,
    cancelled: false,
    resourceLoaded: true
  });

  const second = await evaluate({
    expression: buildInjectionSource("mount", { placement: "inline-in-summary" }),
    returnByValue: true
  });
  assert.equal(second.result.value.status, "already-mounted");

  const overflowState = await evaluate({
    expression: `(() => {
      const host = document.getElementById(${JSON.stringify(HOST_ID)});
      const scrollRoot = document.querySelector('[data-codex-companion-scroll-root]');
      scrollRoot.scrollTop = scrollRoot.scrollHeight;
      const scrollRootRect = scrollRoot.getBoundingClientRect();
      const hostRect = host.getBoundingClientRect();
      const result = {
        clientHeight: scrollRoot.clientHeight,
        scrollHeight: scrollRoot.scrollHeight,
        scrollTop: scrollRoot.scrollTop,
        bottomShadowGutter: scrollRootRect.bottom - hostRect.bottom
      };
      scrollRoot.scrollTop = 0;
      return result;
    })()`,
    returnByValue: true
  });
  assert.ok(overflowState.result.value.scrollHeight > overflowState.result.value.clientHeight);
  assert.ok(overflowState.result.value.scrollTop > 0);
  assert.ok(overflowState.result.value.bottomShadowGutter >= 9);

  await evaluate({
    expression: `(() => {
      document.getElementById('pinned-toggle').setAttribute('aria-pressed', 'false');
      const column = document.querySelector('.origin-top-right');
      column.style.visibility = 'hidden';
      column.style.opacity = '0';
      column.style.transform = 'translateX(100%) scale(.8)';
    })()`
  });
  await evaluate({
    expression: `new Promise((resolve, reject) => {
      const deadline = Date.now() + 3_000;
      const poll = () => {
        const bridge = globalThis[${JSON.stringify(BRIDGE_KEY)}];
        if (bridge.getPlacement() === 'hidden'
          && !document.getElementById(${JSON.stringify(HOST_ID)})
          && !document.getElementById(${JSON.stringify(RAIL_ID)})) resolve(true);
        else if (Date.now() > deadline) reject(new Error('Pinned summary close timeout'));
        else setTimeout(poll, 20);
      };
      poll();
    })`,
    awaitPromise: true,
    returnByValue: true
  });
  const closedPinnedSummary = await evaluate({
    expression: `(() => {
      const bridge = globalThis[${JSON.stringify(BRIDGE_KEY)}];
      const nativeColumn = document.querySelector('.origin-top-right');
      const formerScrollRoot = nativeColumn.parentElement;
      return {
        placement: bridge.getPlacement(),
        mounted: bridge.isMounted(),
        placed: bridge.isPlaced(),
        hostRemoved: !document.getElementById(${JSON.stringify(HOST_ID)}),
        railRemoved: !document.getElementById(${JSON.stringify(RAIL_ID)}),
        overflowYRestored: !formerScrollRoot.style.getPropertyValue('overflow-y'),
        scrollMarkerRemoved: !formerScrollRoot.hasAttribute('data-codex-companion-scroll-root')
      };
    })()`,
    returnByValue: true
  });
  assert.deepEqual(closedPinnedSummary.result.value, {
    placement: "hidden",
    mounted: true,
    placed: false,
    hostRemoved: true,
    railRemoved: true,
    overflowYRestored: true,
    scrollMarkerRemoved: true
  });

  await evaluate({
    expression: `(() => {
      document.getElementById('pinned-toggle').setAttribute('aria-pressed', 'true');
      const column = document.querySelector('.origin-top-right');
      column.style.visibility = 'visible';
      column.style.opacity = '1';
      column.style.transform = 'none';
    })()`
  });
  await evaluate({
    expression: `new Promise((resolve, reject) => {
      const deadline = Date.now() + 3_000;
      const poll = () => {
        const bridge = globalThis[${JSON.stringify(BRIDGE_KEY)}];
        if (bridge.getPlacement() === 'animated-summary' && bridge.isPlaced()) resolve(true);
        else if (Date.now() > deadline) reject(new Error('Pinned summary reopen timeout'));
        else setTimeout(poll, 20);
      };
      poll();
    })`,
    awaitPromise: true,
    returnByValue: true
  });
  const reopenedPinnedSummary = await evaluate({
    expression: `(() => {
      const host = document.getElementById(${JSON.stringify(HOST_ID)});
      const rail = document.getElementById(${JSON.stringify(RAIL_ID)});
      return {
        placement: globalThis[${JSON.stringify(BRIDGE_KEY)}].getPlacement(),
        cards: host.shadowRoot.querySelectorAll('[data-card]').length,
        railMode: rail.dataset.mode,
        railParentIsAnimationColumn: rail.parentElement.className.includes('origin-top-right')
      };
    })()`,
    returnByValue: true
  });
  assert.deepEqual(reopenedPinnedSummary.result.value, {
    placement: "animated-summary",
    cards: 2,
    railMode: "animated-summary",
    railParentIsAnimationColumn: true
  });

  await evaluate({
    expression: buildInjectionSource("unmount"),
    returnByValue: true
  });
  const removed = await evaluate({
    expression: `({
      removed: !document.getElementById(${JSON.stringify(HOST_ID)}) && !document.getElementById(${JSON.stringify(RAIL_ID)}),
      nativeOverflowY: getComputedStyle(document.querySelector(".origin-top-right")).overflowY
    })`,
    returnByValue: true
  });
  assert.deepEqual(removed.result.value, { removed: true, nativeOverflowY: "visible" });

  await evaluate({
    expression: `(() => {
      document.getElementById('pinned-toggle').setAttribute('aria-pressed', 'false');
      const column = document.querySelector('.origin-top-right');
      column.style.visibility = 'hidden';
      column.style.opacity = '0';
      column.style.transform = 'translateX(100%) scale(.8)';
    })()`
  });
  const hiddenMount = await evaluate({
    expression: buildInjectionSource("mount", { placement: "inline-in-summary" }),
    returnByValue: true
  });
  assert.deepEqual(hiddenMount.result.value, {
    status: "waiting-for-layout",
    placement: "hidden",
    version: INJECTION_VERSION
  });

  const hiddenMountState = await evaluate({
    expression: `(() => {
      const bridge = globalThis[${JSON.stringify(BRIDGE_KEY)}];
      return {
        placement: bridge.getPlacement(),
        mounted: bridge.isMounted(),
        placed: bridge.isPlaced(),
        hostRemoved: !document.getElementById(${JSON.stringify(HOST_ID)}),
        railRemoved: !document.getElementById(${JSON.stringify(RAIL_ID)})
      };
    })()`,
    returnByValue: true
  });
  assert.deepEqual(hiddenMountState.result.value, {
    placement: "hidden",
    mounted: true,
    placed: false,
    hostRemoved: true,
    railRemoved: true
  });

  await evaluate({
    expression: buildInjectionSource("unmount"),
    returnByValue: true
  });

  // ===== standalone-button 模式：并排按钮 + 与原生 Toggle Summary 互斥 =====
  // 构造一个带 header/工具栏组的真实结构：原生按钮点击会切换自身 aria-pressed 与面板显隐，
  // 模拟 Codex 的开合行为，供我们的三态机协调。
  await evaluate({
    expression: `(() => {
      // 清掉前面场景的 pinned 结构，避免页面上同时存在两套 summary 触发器/面板。
      // 原始浮层的类名是 top-(--thread-floating-content-top-inset)（含该子串，会被真实 finder 命中），
      // 因此按 includes 语义匹配删除，而非精确类名。
      document.getElementById('pinned-toggle')?.remove();
      document.getElementById('native-panel')?.closest('div[class*="thread-floating-content-top-inset"]')?.remove();
      Array.from(document.querySelectorAll('div')).forEach((el) => {
        const cls = typeof el.className === 'string' ? el.className : '';
        if (cls.includes('thread-floating-content-top-inset')) el.remove();
      });
      document.getElementById('sa-header')?.remove();
      const header = document.createElement('header');
      header.id = 'sa-header';
      header.className = 'app-header-tint';
      header.style.cssText = 'position:fixed;top:0;left:0;right:0;height:46px';
      const group = document.createElement('div');
      group.className = 'ms-auto flex shrink-0 items-center gap-1.5';
      const span = document.createElement('span');
      span.className = 'contents';
      const btn = document.createElement('button');
      btn.id = 'sa-summary-toggle';
      btn.setAttribute('aria-label', '切换摘要'); // 中文文案，验证多语言定位
      btn.setAttribute('aria-pressed', 'false');
      btn.className = 'border-token-border rounded-lg';
      btn.innerHTML = '<svg viewBox="0 0 20 20"><path d="M4 4h12v12H4z"/></svg>';
      const panel = document.createElement('div');
      panel.id = 'sa-native-panel';
      panel.className = 'rounded-3xl bg-token-dropdown-background';
      panel.style.cssText = 'width:300px;height:200px;display:none';
      panel.textContent = 'Native summary';
      // 原生按钮：点击切换 aria-pressed 并显隐面板（模拟 Codex）
      btn.addEventListener('click', () => {
        const open = btn.getAttribute('aria-pressed') === 'true';
        btn.setAttribute('aria-pressed', open ? 'false' : 'true');
        panel.style.display = open ? 'none' : 'block';
      });
      span.append(btn);
      group.append(span);
      header.append(group);
      // 面板挂在按钮的祖先链上，findFloatingSummary 用 origin-top-right 容器定位
      const floating = document.createElement('div');
      floating.className = 'thread-floating-content-top-inset right-0';
      floating.style.cssText = 'position:absolute;top:0;right:0;width:316px;height:400px';
      const col = document.createElement('div');
      col.className = 'origin-top-right';
      col.style.setProperty('opacity', '1', 'important');
      col.style.setProperty('visibility', 'visible', 'important');
      col.style.setProperty('width', '316px', 'important');
      col.style.setProperty('height', '100%', 'important');
      col.append(panel);
      floating.append(col);
      document.body.append(header, floating);
      return true;
    })()`,
    returnByValue: true
  });

  await evaluate({
    expression: buildInjectionSource("mount", { placement: "standalone-button" }),
    returnByValue: true
  });

  // 注入后应出现我们的按钮，排在原生按钮之前（左侧）；面板初始关闭。
  // 顶栏 header 是 pointer-events:none 的拖拽区，按钮必须显式恢复 pointer-events:auto，
  // 否则点击会穿透到背后内容层（真机上表现为“按钮点不动”）。
  const saInitial = await evaluate({
    expression: `(() => {
      const ours = document.getElementById(${JSON.stringify(HOST_ID)} + '-toggle');
      const native = document.getElementById('sa-summary-toggle');
      return {
        buttonExists: !!ours,
        leftOfNative: !!(ours && native && (ours.compareDocumentPosition(native) & Node.DOCUMENT_POSITION_FOLLOWING)),
        pointerEvents: ours ? getComputedStyle(ours).pointerEvents : null,
        ourPressed: ours?.getAttribute('aria-pressed'),
        nativePressed: native?.getAttribute('aria-pressed')
      };
    })()`,
    returnByValue: true
  });
  assert.deepEqual(saInitial.result.value, {
    buttonExists: true,
    leftOfNative: true,
    pointerEvents: "auto",
    ourPressed: "false",
    nativePressed: "false"
  });

  // 点我们的按钮 → 面板打开、卡片显示、原生内容隐藏、原生按钮被按下（借它开合）。
  await evaluate({
    expression: `document.getElementById(${JSON.stringify(HOST_ID)} + '-toggle').click()`
  });
  await evaluate({
    expression: `new Promise((resolve, reject) => {
      const deadline = Date.now() + 3_000;
      const poll = () => {
        const bridge = globalThis[${JSON.stringify(BRIDGE_KEY)}];
        const panel = document.getElementById('sa-native-panel');
        if (bridge?.isPlaced() && panel && panel.style.display === 'none') resolve(true);
        else if (Date.now() > deadline) reject(new Error('standalone cards open timeout'));
        else setTimeout(poll, 20);
      };
      poll();
    })`,
    awaitPromise: true,
    returnByValue: true
  });
  const saCardsOpen = await evaluate({
    expression: `(() => {
      const ours = document.getElementById(${JSON.stringify(HOST_ID)} + '-toggle');
      return {
        ourPressed: ours?.getAttribute('aria-pressed'),
        nativePanelHidden: document.getElementById('sa-native-panel').style.display === 'none',
        railPresent: !!document.getElementById(${JSON.stringify(RAIL_ID)}),
        // cards 占用期间原生按钮的激活底色应被压掉（标记属性存在）
        nativeHighlightSuppressed: document.getElementById('sa-summary-toggle')?.hasAttribute('data-codex-companion-suppress-highlight')
      };
    })()`,
    returnByValue: true
  });
  assert.deepEqual(saCardsOpen.result.value, {
    ourPressed: "true",
    nativePanelHidden: true,
    railPresent: true,
    nativeHighlightSuppressed: true
  });

  // 互斥：卡片正显示时，用户单击原生 Toggle Summary → 捕获阶段拦截这次点击，
  // 让卡片让位给摘要（清 cards 意图、恢复原生内容、面板保持打开），无需点两次。
  await evaluate({
    expression: `document.getElementById('sa-summary-toggle').click()`
  });
  await evaluate({
    expression: `new Promise((resolve, reject) => {
      const deadline = Date.now() + 3_000;
      const poll = () => {
        const ours = document.getElementById(${JSON.stringify(HOST_ID)} + '-toggle');
        const native = document.getElementById('sa-summary-toggle');
        // 卡片让出：rail 移除、我们的按钮非按下、原生高亮压制已解除
        if (!document.getElementById(${JSON.stringify(RAIL_ID)})
          && ours?.getAttribute('aria-pressed') === 'false'
          && !native?.hasAttribute('data-codex-companion-suppress-highlight')) resolve(true);
        else if (Date.now() > deadline) reject(new Error('standalone mutual-exclusion timeout'));
        else setTimeout(poll, 20);
      };
      poll();
    })`,
    awaitPromise: true,
    returnByValue: true
  });

  await evaluate({
    expression: buildInjectionSource("unmount"),
    returnByValue: true
  });
  // 卸载后我们的按钮应被移除，原生按钮保留。
  const saAfterUnmount = await evaluate({
    expression: `({
      ourButton: !!document.getElementById(${JSON.stringify(HOST_ID)} + '-toggle'),
      nativeButton: !!document.getElementById('sa-summary-toggle')
    })`,
    returnByValue: true
  });
  assert.deepEqual(saAfterUnmount.result.value, { ourButton: false, nativeButton: true });

  console.log("Chromium smoke passed: animated Summary → pinned close/open sync → hidden mount → unmount → standalone button mutual-exclusion");
} finally {
  connection?.close();
  chrome.kill("SIGTERM");
  await new Promise((resolve) => {
    chrome.once("exit", resolve);
    setTimeout(resolve, 2_000).unref();
  });
  await rm(profileDir, { recursive: true, force: true });
}
