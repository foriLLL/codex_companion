import Hls from "hls.js";
import { createMediaScope } from "../../renderer/media/scope.mjs";
import { createMediaUi } from "../../renderer/media/ui.mjs";
import { createDirectMp4Stream } from "../../renderer/media/direct-mp4.mjs";
import { mediaStyles } from "../../renderer/media/styles.mjs";

export function mount(ctx) {
  const scope = createMediaScope(ctx);
  const { rpc, requestRpc, cancelRpc, listen, unlisten, setTimeout, clearTimeout, setInterval, clearInterval, requestAnimationFrame, queueMicrotask, createObjectURL, revokeObjectURL, isDisposed } = scope;
  const ui = createMediaUi(scope);
  const { makeElement, makeToolbarIcon, makeFullscreenButton, rpcError, toRpcError, decodeBase64, responseBytes } = ui;
  const configureDirectMp4Stream = createDirectMp4Stream(scope, ui);
  const shadow = ctx.root;
  shadow.innerHTML = `<style>${mediaStyles}</style><section class="panel emby-card" data-card="emby" aria-label="Emby 媒体库"><div class="emby-app" aria-live="polite"></div></section>`;
  const embyApp = shadow.querySelector(".emby-app");
  let refreshEmbyImages = () => {};
  const embyState = {
    view: "loading",
    connected: false,
    config: { baseUrl: "", username: "", serverId: "", userId: "" },
    loadingLabel: "正在检查 Emby 连接…",
    inlineError: "",
    home: { views: [], resume: [], latest: [] },
    servers: [],
    addingServer: false,
    pendingServerInput: "",
    pendingUsernameInput: "",
    libraryStack: [],
    libraryItems: [],
    libraryTotal: 0,
    libraryLoadingMore: false,
    searchQuery: "",
    searchItems: [],
    searching: false,
    searchReturnView: "home",
    seriesItem: null,
    seriesReturnView: "home",
    seasons: [],
    selectedSeasonId: null,
    episodes: [],
    sourceOptions: [],
    playback: null,
    previousRoute: null,
    error: null,
    retry: null,
    scrollPositions: new Map()
  };
  let searchTimer = null;
  let searchGeneration = 0;
  let searchRequestId = null;
  let progressTimer = null;
  let volumeReportTimer = null;
  let activeHls = null;
  let activeDirectPlayer = null;
  let lastMseDiagnostics = null;
  let playbackStopping = false;
  let workerFallbackReported = false;
  let subtitleRequestId = null;
  let subtitleObjectUrl = null;
  const subtitleObjectUrls = new Set();
  let subtitlePreference = null;
  let subtitleSwitching = false;
  let cardVisible = true;
  // 按 seriesId 记住用户选中的源（sourceKey），会话级，退出 Codex 不保留（与字幕偏好一致）。
  const sourcePreferences = new Map();
  let episodeContextRequestId = null;
  const imageCache = new Map();
  const imageLoads = new Map();
  const imageRequests = new Set();
  const imageLoadQueue = [];
  let imageCacheBytes = 0;
  let activeImageLoads = 0;
  let imageLoadGeneration = 0;
  const MAX_IMAGE_COUNT = 50;
  const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
  const MAX_CONCURRENT_IMAGE_LOADS = 4;
  const releaseImageCache = () => {
    for (const entry of imageCache.values()) revokeObjectURL(entry.url);
    imageCache.clear();
    imageCacheBytes = 0;
  };

  const trimImageCache = () => {
    // 未超限时直接返回：否则每张图加载完都全扫一次 DOM 建 Set
    // （60+ 海报的媒体库页就是 60 次全扫，O(n²)）。
    if (imageCache.size <= MAX_IMAGE_COUNT && imageCacheBytes <= MAX_IMAGE_BYTES) return;
    const activeUrls = new Set(
      [...embyApp.querySelectorAll("img[src]")].map((image) => image.src).filter(Boolean)
    );
    let protectedCount = 0;
    while (
      (imageCache.size > MAX_IMAGE_COUNT || imageCacheBytes > MAX_IMAGE_BYTES)
      && protectedCount < imageCache.size
    ) {
      const oldestKey = imageCache.keys().next().value;
      const oldest = imageCache.get(oldestKey);
      if (activeUrls.has(oldest.url)) {
        imageCache.delete(oldestKey);
        imageCache.set(oldestKey, oldest);
        protectedCount += 1;
        continue;
      }
      imageCache.delete(oldestKey);
      imageCacheBytes -= oldest.size;
      revokeObjectURL(oldest.url);
      protectedCount = 0;
    }
  };

  const drainImageLoadQueue = () => {
    while (activeImageLoads < MAX_CONCURRENT_IMAGE_LOADS && imageLoadQueue.length > 0) {
      const task = imageLoadQueue.shift();
      if (task.generation !== imageLoadGeneration) {
        task.reject(rpcError("ABORTED", "图片加载已取消", true));
        continue;
      }
      activeImageLoads += 1;
      Promise.resolve()
        .then(task.operation)
        .then(task.resolve, task.reject)
        .finally(() => {
          activeImageLoads -= 1;
          drainImageLoadQueue();
        });
    }
  };

  const scheduleImageLoad = (operation, generation) => new Promise((resolve, reject) => {
    imageLoadQueue.push({ operation, generation, resolve, reject });
    drainImageLoadQueue();
  });

  const cancelImageLoads = () => {
    imageLoadGeneration += 1;
    const error = rpcError("ABORTED", "图片加载已取消", true);
    for (const task of imageLoadQueue.splice(0)) task.reject(error);
    imageLoads.clear();
  };

  const imageRetryDelay = (milliseconds, generation) => new Promise((resolve, reject) => {
    setTimeout(() => {
      if (generation === imageLoadGeneration) resolve();
      else reject(rpcError("ABORTED", "图片加载已取消", true));
    }, milliseconds);
  });

  const requestImageResource = async (reference, generation) => {
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (generation !== imageLoadGeneration) throw rpcError("ABORTED", "图片加载已取消", true);
      try {
        return await scheduleImageLoad(async () => {
          const request = requestRpc("resource.load", {
            url: reference,
            responseType: "arraybuffer",
            resourceType: "image"
          }, { timeoutMs: 30_000 });
          imageRequests.add(request.id);
          try {
            return await request.promise;
          } finally {
            imageRequests.delete(request.id);
          }
        }, generation);
      } catch (errorValue) {
        lastError = toRpcError(errorValue);
        if (attempt === 2 || lastError.retryable !== true || generation !== imageLoadGeneration) throw lastError;
        await imageRetryDelay(250 * (attempt + 1), generation);
      }
    }
    throw lastError;
  };

  const canvasToBlob = (canvas) => {
    if (typeof canvas.convertToBlob === "function") {
      return canvas.convertToBlob({ type: "image/webp", quality: .82 });
    }
    return new Promise((resolve) => canvas.toBlob(resolve, "image/webp", .82));
  };

  const optimizeImageBlob = async (sourceBlob, item, kind) => {
    let bitmap;
    let fallbackUrl = null;
    try {
      if (typeof createImageBitmap === "function") {
        try {
          bitmap = await createImageBitmap(sourceBlob);
        } catch {
          // 部分合法图片可由 <img> 解码，但 createImageBitmap 会拒绝；继续走兼容解码。
        }
      }
      if (!bitmap) {
        fallbackUrl = createObjectURL(sourceBlob);
        bitmap = new Image();
        bitmap.src = fallbackUrl;
        await bitmap.decode();
      }
      // tile 为首页媒体库 16:9 小方块；海报按 80px 宽的 2x 屏尺寸输出。
      const targetWidth = kind === "backdrop" ? 600 : kind === "tile" ? 320 : 160;
      const targetHeight = kind === "backdrop" ? 338 : kind === "tile" ? 180 : 240;
      const isLibraryTemplate = kind !== "backdrop"
        && item?.type === "CollectionFolder"
        && bitmap.width / Math.max(1, bitmap.height) > 1.4;
      const region = isLibraryTemplate
        ? { x: 0, y: bitmap.height * .25, width: bitmap.width, height: bitmap.height * .60 }
        : { x: 0, y: 0, width: bitmap.width, height: bitmap.height };
      const targetRatio = targetWidth / targetHeight;
      const regionRatio = region.width / region.height;
      let sourceX = region.x;
      let sourceY = region.y;
      let sourceWidth = region.width;
      let sourceHeight = region.height;
      if (regionRatio > targetRatio) {
        sourceWidth = region.height * targetRatio;
        sourceX += (region.width - sourceWidth) / 2;
      } else {
        sourceHeight = region.width / targetRatio;
        // 竖版封面裁成横图时偏上取景，人物面部通常位于上部。
        sourceY += (region.height - sourceHeight) * (kind === "tile" ? .22 : .5);
      }
      const canvas = typeof OffscreenCanvas === "function"
        ? new OffscreenCanvas(targetWidth, targetHeight)
        : Object.assign(document.createElement("canvas"), { width: targetWidth, height: targetHeight });
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) return sourceBlob;
      context.drawImage(
        bitmap,
        sourceX,
        sourceY,
        sourceWidth,
        sourceHeight,
        0,
        0,
        targetWidth,
        targetHeight
      );
      return await canvasToBlob(canvas) || sourceBlob;
    } catch {
      return sourceBlob;
    } finally {
      bitmap?.close?.();
      if (fallbackUrl) revokeObjectURL(fallbackUrl);
    }
  };

  const imageReference = (item, kind = "primary") => {
    if (!item || typeof item !== "object") return null;
    return kind === "backdrop"
      ? item.backdropUrl || item.imageUrl || null
      : item.imageUrl || item.backdropUrl || null;
  };

  const applyImageEntry = (img, entry) => {
    listen(img, "load", () => {
      img.dataset.imageState = "loaded";
    }, { once: true });
    listen(img, "error", () => {
      img.dataset.imageState = "failed";
    }, { once: true });
    img.src = entry.url;
  };

  const bindImage = (img, item, kind = "primary") => {
    const reference = imageReference(item, kind);
    if (!reference) return;
    // 记录绑定信息：host 重挂回 DOM 时 refreshEmbyImages 用它补绑/重试缺 src 的图。
    img.embyImageBinding = { item, kind };
    const profile = kind === "backdrop" ? "backdrop" : kind === "tile" ? "tile" : item?.type === "CollectionFolder" ? "library" : "primary";
    const key = `${profile}:${typeof reference === "string" ? reference : JSON.stringify(reference)}`;
    img.dataset.imageState = "loading";
    const cached = imageCache.get(key);
    if (cached) {
      imageCache.delete(key);
      imageCache.set(key, cached);
      applyImageEntry(img, cached);
      // 缓存命中说明字节就在内存（blob URL）：直接置 loaded，不等 load 事件淡入。
      // 否则每次视图重建（加载更多 / 切 tab / stale 刷新）所有已显示的海报都会
      // 从 opacity:0 重播一遍 120ms 渐显，肉眼可见地齐闪。
      img.dataset.imageState = "loaded";
      return;
    }
    const generation = imageLoadGeneration;
    let loading = imageLoads.get(key);
    if (!loading) {
      const pending = (async () => {
        const result = await requestImageResource(reference, generation);
        if (isDisposed() || generation !== imageLoadGeneration) throw rpcError("ABORTED", "图片加载已取消", true);
        const bytes = responseBytes(result);
        if (!bytes.byteLength) throw rpcError("EMPTY_IMAGE", "Emby 返回了空图片");
        const sourceBlob = new Blob([bytes], { type: result.contentType || "image/jpeg" });
        const blob = await optimizeImageBlob(sourceBlob, item, kind);
        const entry = { url: createObjectURL(blob), size: blob.size };
        imageCache.set(key, entry);
        imageCacheBytes += entry.size;
        return entry;
      })();
      loading = pending.finally(() => {
        if (imageLoads.get(key) === loading) imageLoads.delete(key);
      });
      imageLoads.set(key, loading);
    }
    loading.then((entry) => {
      if (isDisposed() || generation !== imageLoadGeneration) return;
      // Summary 折叠 / 切会话时 host 会暂时脱离 DOM。即使此刻 disconnected 也必须
      // 把 Blob URL 写回原节点（entry 已在缓存，写 src 无副作用），否则重新挂载后
      // 这些位置会永久停在占位图 —— 红果侧同款问题已在 bindHongguoImage 修过。
      applyImageEntry(img, entry);
      queueMicrotask(trimImageCache);
    }).catch((errorValue) => {
      if (img.isConnected && generation === imageLoadGeneration) {
        img.dataset.imageState = "failed";
        console.warn("[codex-companion] Emby 图片加载失败", {
          item: item?.name || item?.id || "unknown",
          code: toRpcError(errorValue).code
        });
      }
    });
  };

  // host 重挂回 DOM 时补绑没有 src 的图：覆盖加载途中 detach 被跳过的（现在 then
  // 已无条件写回，主要是加载失败/被取消且未进缓存的）——按绑定时记录的 item 重试。
  refreshEmbyImages = () => {
    for (const img of embyApp.querySelectorAll("img")) {
      if (img.getAttribute("src") || !img.embyImageBinding) continue;
      bindImage(img, img.embyImageBinding.item, img.embyImageBinding.kind);
    }
  };

  const rememberScroll = () => {
    const scroller = embyApp.querySelector(".emby-scroll[data-scroll-key]");
    if (scroller) embyState.scrollPositions.set(scroller.dataset.scrollKey, scroller.scrollTop);
  };

  const restoreScroll = () => {
    const scroller = embyApp.querySelector(".emby-scroll[data-scroll-key]");
    if (!scroller) return;
    const top = embyState.scrollPositions.get(scroller.dataset.scrollKey) ?? 0;
    requestAnimationFrame(() => {
      if (scroller.isConnected) scroller.scrollTop = top;
    });
  };

  const formatDuration = (ticks) => {
    const seconds = Math.max(0, Math.round(Number(ticks || 0) / 10_000_000));
    if (!seconds) return "";
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    return `${minutes}:${String(remainder).padStart(2, "0")}`;
  };

  const itemMeta = (item) => {
    const parts = [];
    if (item.type) parts.push(item.type === "Series" ? "剧集" : item.type === "Movie" ? "电影" : item.type === "Episode" ? "单集" : "视频");
    if (item.productionYear) parts.push(String(item.productionYear));
    const duration = formatDuration(item.runtimeTicks);
    if (duration) parts.push(duration);
    return parts.join(" · ");
  };

  const safePercent = (value) => Math.max(0, Math.min(100, Number(value || 0)));

  const makeIconButton = (label, icon, onClick) => {
    const button = makeElement("button", "emby-icon-button");
    button.type = "button";
    button.setAttribute("aria-label", label);
    button.title = label;
    button.append(makeToolbarIcon(icon));
    listen(button, "click", onClick);
    return button;
  };

  const makeSearchField = (options = {}) => {
    const form = makeElement("form", "emby-search-wrap");
    form.setAttribute("role", "search");
    const input = makeElement("input", "emby-search-input");
    input.type = "search";
    input.placeholder = options.placeholder || "搜索电影、剧集或单集";
    input.setAttribute("aria-label", "搜索 Emby 媒体");
    input.value = options.value || "";
    const submit = makeIconButton("搜索媒体", "search", () => {});
    submit.type = "submit";
    submit.classList.add("emby-search-submit");
    form.append(input, submit);
    listen(form, "submit", (event) => {
      event.preventDefault();
      options.onSubmit?.(input.value);
    });
    // IME 组词期间不触发搜索：中文/日文等输入法在 compositionstart..compositionend
    // 之间会连续 fire input 事件，此时查询是半成品。等 compositionend 再回调一次，
    // 避免用未完成的拼音发请求、以及后续重渲染打断组词。
    let composing = false;
    listen(input, "compositionstart", () => { composing = true; });
    listen(input, "compositionend", () => {
      composing = false;
      options.onInput?.(input.value);
    });
    listen(input, "input", () => {
      if (composing) return;
      options.onInput?.(input.value);
    });
    listen(input, "keydown", (event) => {
      if (event.key === "Escape" && options.onEscape) {
        event.preventDefault();
        options.onEscape();
      }
      event.stopPropagation();
    });
    return { form, input };
  };

  const makeToolbar = (title, options = {}) => {
    const toolbar = makeElement("header", "emby-toolbar");
    if (options.back) toolbar.append(makeIconButton("返回", "back", options.back));
    if (options.searchField) toolbar.append(makeSearchField(options.searchField).form);
    else {
      toolbar.append(makeElement("h2", "emby-toolbar-title", title));
      if (options.search) toolbar.append(makeIconButton("搜索媒体", "search", options.search));
    }
    if (options.serverAvatar) toolbar.append(makeServerAvatar(options.serverAvatar));
    if (options.servers) toolbar.append(makeIconButton("切换 Emby 服务器", "servers", options.servers));
    if (options.logout) toolbar.append(makeIconButton("退出 Emby", "logout", options.logout));
    return toolbar;
  };

  const makeEmpty = (text) => makeElement("div", "emby-empty", text);

  const renderLoading = () => {
    const view = makeElement("div", "emby-view emby-center");
    view.dataset.view = "loading";
    view.append(makeElement("div", "emby-spinner"), makeElement("span", "", embyState.loadingLabel));
    return view;
  };

  const renderDisconnected = () => {
    const view = makeElement("div", "emby-view");
    view.dataset.view = "disconnected";
    const form = makeElement("form", "emby-login");
    const brand = makeElement("div", "emby-brand");
    const brandCopy = makeElement("div");
    brandCopy.append(makeElement("strong", "", "Emby"), makeElement("span", "emby-muted", "连接你的个人媒体库"));
    brand.append(makeElement("div", "emby-mark", "E"), brandCopy);

    const serverLabel = makeElement("label", "emby-field", "服务器地址");
    const serverInput = makeElement("input", "emby-input");
    serverInput.name = "server";
    serverInput.type = "url";
    serverInput.required = true;
    // autocomplete="url" 不是合法 token（spec 无此值，浏览器直接忽略），不设即可。
    serverInput.placeholder = "https://emby.example.com";
    serverInput.value = embyState.addingServer
      ? (embyState.pendingServerInput || "")
      : (embyState.config.baseUrl || "");
    serverLabel.append(serverInput);

    const usernameLabel = makeElement("label", "emby-field", "用户名");
    const usernameInput = makeElement("input", "emby-input");
    usernameInput.name = "username";
    usernameInput.required = true;
    usernameInput.autocomplete = "username";
    usernameInput.value = embyState.addingServer
      ? (embyState.pendingUsernameInput || "")
      : (embyState.config.username || "");
    usernameLabel.append(usernameInput);

    const passwordLabel = makeElement("label", "emby-field", "密码");
    const passwordInput = makeElement("input", "emby-input");
    passwordInput.name = "password";
    passwordInput.type = "password";
    passwordInput.autocomplete = "current-password";
    passwordLabel.append(passwordInput);

    const error = makeElement("p", "emby-inline-error", embyState.inlineError || "");
    const submit = makeElement("button", "emby-button primary", "连接");
    submit.type = "submit";
    form.append(brand, serverLabel, usernameLabel, passwordLabel, error, submit);
    if (embyState.servers.length > 0) {
      const cancel = makeElement("button", "emby-button", embyState.connected ? "取消" : "查看已保存服务器");
      cancel.type = "button";
      listen(cancel, "click", () => {
        embyState.addingServer = false;
        embyState.pendingServerInput = "";
        embyState.pendingUsernameInput = "";
        embyState.inlineError = "";
        embyState.view = "servers";
        renderEmby();
      });
      form.append(cancel);
    }
    listen(form, "submit", async (event) => {
      event.preventDefault();
      embyState.inlineError = "";
      const baseUrl = serverInput.value.trim();
      const username = usernameInput.value.trim();
      submit.disabled = true;
      submit.textContent = "连接中…";
      try {
        const result = await rpc("auth.login", {
          baseUrl,
          username,
          password: passwordInput.value
        }, { timeoutMs: 20_000 });
        passwordInput.value = "";
        Object.assign(embyState.config, result || {});
        embyState.addingServer = false;
        embyState.pendingServerInput = "";
        embyState.pendingUsernameInput = "";
        embyState.connected = Boolean(result?.connected);
        if (!embyState.connected) throw rpcError("AUTH_FAILED", "服务器未确认登录状态");
        await loadServers();
        await loadHome(true);
      } catch (errorValue) {
        const errorObject = toRpcError(errorValue);
        passwordInput.value = "";
        // 保留用户已填的地址/用户名，登录失败后不必从头再输（新增服务器时尤其重要）。
        if (embyState.addingServer) {
          embyState.pendingServerInput = baseUrl;
          embyState.pendingUsernameInput = username;
        }
        embyState.connected = false;
        embyState.inlineError = errorObject.message || "连接失败，请检查地址和账号";
        if (!isDisposed()) renderEmby();
      }
    });
    view.append(form);
    return view;
  };

  // 首页右上角的服务器头像：用户名首字母 + 稳定配色，悬停可见完整的 主机 · 用户。
  const makeServerAvatar = ({ server, onClick }) => {
    const label = server ? `${serverTitle(server)}${server.username ? ` · ${server.username}` : ""}` : "Emby 服务器";
    const button = makeElement("button", "emby-server-avatar");
    button.type = "button";
    button.setAttribute("aria-label", `切换 Emby 服务器（当前：${label}）`);
    button.title = label;
    const seed = [...(server?.key || server?.baseUrl || "emby")].reduce((sum, char) => sum + char.charCodeAt(0), 0);
    // 只从饱和度适中的几种色相里取，避免算出橄榄、土黄等发灰的颜色。
    button.style.setProperty("--emby-avatar-hue", String([212, 248, 276, 328, 6, 168, 194][seed % 7]));
    button.textContent = (server?.username || serverTitle(server) || "E").trim().charAt(0).toUpperCase() || "E";
    listen(button, "click", onClick);
    return button;
  };

  const makeSection = (title, className = "") => {
    const section = makeElement("section", `emby-section${className ? ` ${className}` : ""}`);
    section.append(makeElement("h3", "emby-section-title", title));
    return section;
  };

  const episodeCode = (item) => item?.type === "Episode" && item.indexNumber
    ? `${item.parentIndexNumber ? `S${item.parentIndexNumber}` : ""}E${item.indexNumber}`
    : "";

  const remainingLabel = (item) => {
    const runtime = Number(item?.runtimeTicks || 0);
    if (!runtime) return "";
    const position = Number(item.positionTicks || 0) || runtime * safePercent(item.progressPercent) / 100;
    const minutes = Math.max(1, Math.round((runtime - position) / 600_000_000));
    return minutes >= 60 ? `剩余 ${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分` : `剩余 ${minutes} 分钟`;
  };

  // 继续观看：16:9 横滑卡片，底部渐变上叠剧名、集数与剩余时长，底边为进度条。
  const makeResumeCard = (item) => {
    const button = makeElement("button", "emby-media-button emby-resume");
    button.type = "button";
    const title = item.seriesName || item.name || "继续播放";
    button.title = item.seriesName && item.name ? `${item.seriesName} · ${item.name}` : title;
    const image = makeElement("img");
    image.alt = "";
    bindImage(image, item, "backdrop");
    const copy = makeElement("span", "emby-resume-copy");
    copy.append(makeElement("span", "emby-resume-name", title));
    // 单集名单独一行；集数与剩余时长放最后一行，避免长标题把剩余时长挤出可视区。
    if (item.seriesName && item.name) copy.append(makeElement("span", "emby-resume-episode", item.name));
    const meta = [episodeCode(item), remainingLabel(item)].filter(Boolean).join(" · ");
    if (meta) copy.append(makeElement("span", "emby-resume-meta", meta));
    const progress = makeElement("span", "emby-progress");
    const progressFill = makeElement("span");
    progressFill.style.width = `${safePercent(item.progressPercent)}%`;
    progress.append(progressFill);
    button.append(image, makeElement("span", "emby-resume-play"), copy, progress);
    listen(button, "click", () => openItem(item));
    return button;
  };

  // 媒体库只是分类入口：两列 16:9 小方块，名称压在图上，比竖版海报省约三分之二高度。
  const makeLibraryTile = (item) => {
    const button = makeElement("button", "emby-library-tile");
    button.type = "button";
    button.title = item.name || "媒体库";
    if (imageReference(item, "primary")) {
      const image = makeElement("img");
      image.alt = "";
      bindImage(image, item, "tile");
      button.append(image);
    }
    button.append(makeElement("span", "emby-library-name", item.name || "媒体库"));
    listen(button, "click", () => openItem(item));
    return button;
  };

  const posterMeta = (item) => [
    item.productionYear ? String(item.productionYear) : "",
    item.type === "Series" ? "剧集" : item.type === "Movie" ? "电影" : ""
  ].filter(Boolean).join(" · ");

  const makePosterButton = (item, options = {}) => {
    const button = makeElement("button", "emby-poster-button");
    button.type = "button";
    button.title = item.name || "打开媒体";
    const poster = makeElement("div", "emby-poster");
    if (imageReference(item, "primary")) {
      const image = makeElement("img");
      image.alt = "";
      bindImage(image, item);
      poster.append(image);
    } else {
      // 无封面的条目（文件夹/合集最常见）给兜底图标，不再只显示灰色渐变块。
      const folderish = ["CollectionFolder", "Folder", "BoxSet", "Season", "Series"].includes(item?.type);
      const fallback = makeElement("span", "emby-poster-fallback");
      fallback.append(makeToolbarIcon(folderish ? "folder" : "film"));
      poster.append(fallback);
    }
    if (item.played) poster.append(makeElement("span", "emby-badge", "已看"));
    button.append(poster, makeElement("span", "emby-poster-name", item.name || "未命名"));
    const meta = options.meta ? posterMeta(item) : "";
    if (meta) button.append(makeElement("span", "emby-poster-meta", meta));
    listen(button, "click", () => openItem(item));
    return button;
  };

  const renderHome = () => {
    const view = makeElement("div", "emby-view");
    view.dataset.view = "home";
    const activeServer = embyState.servers.find((entry) => entry.active);
    const openServers = () => {
      rememberScroll();
      embyState.view = "servers";
      renderEmby();
    };
    view.append(makeToolbar("Emby", {
      searchField: {
        value: embyState.searchQuery,
        onSubmit: (query) => {
          if (!query.trim()) return;
          embyState.searchQuery = query;
          rememberScroll();
          embyState.searchReturnView = "home";
          embyState.view = "search";
          renderEmby({ focusSearch: true });
          runSearch(query);
        }
      },
      // 当前服务器只保留一个入口；悬停/读屏可获得完整的 主机 · 用户。
      serverAvatar: { server: activeServer, onClick: openServers }
    }));
    const scroll = makeElement("div", "emby-scroll emby-content");
    scroll.dataset.scrollKey = "home";

    // 继续观看最常用，放在最上方；没有记录时整段不显示。
    if (embyState.home.resume.length) {
      const resumeSection = makeSection("继续观看");
      const row = makeElement("div", "emby-row emby-resume-row");
      for (const item of embyState.home.resume) row.append(makeResumeCard(item));
      resumeSection.append(row);
      scroll.append(resumeSection);
    }

    const librariesSection = makeSection("媒体库");
    if (embyState.home.views.length) {
      // 超过 4 个时改为两行横滑，避免媒体库多时把下方内容推出首屏。
      const tiles = makeElement("div", embyState.home.views.length > 4 ? "emby-row emby-library-tiles" : "emby-library-tiles");
      for (const item of embyState.home.views) tiles.append(makeLibraryTile(item));
      librariesSection.append(tiles);
    } else {
      librariesSection.append(makeEmpty("服务器没有可浏览的媒体库"));
    }

    const recentSection = makeSection("最近添加");
    if (embyState.home.latest.length) {
      const row = makeElement("div", "emby-row emby-poster-row");
      for (const item of embyState.home.latest) row.append(makePosterButton(item, { meta: true }));
      recentSection.append(row);
    } else {
      recentSection.append(makeEmpty("媒体库暂无视频内容"));
    }
    scroll.append(librariesSection, recentSection);
    view.append(scroll);
    return view;
  };

  const serverTitle = (server) => {
    try {
      return new URL(server?.baseUrl).host || server?.baseUrl || "Emby 服务器";
    } catch {
      return server?.baseUrl || "Emby 服务器";
    }
  };

  // 切换/移除服务器时清空上一台服务器的浏览态，避免把 A 的搜索/剧集/媒体库数据
  // 带进 B 的视图（点进去会用 A 的 item id 去打 B 而报错）。
  const resetEmbyBrowseState = () => {
    embyState.home = { views: [], resume: [], latest: [] };
    embyState.libraryStack = [];
    embyState.libraryItems = [];
    embyState.libraryTotal = 0;
    embyState.libraryLoadingMore = false;
    embyState.searchQuery = "";
    embyState.searchItems = [];
    embyState.searching = false;
    embyState.searchReturnView = "home";
    embyState.seriesItem = null;
    embyState.seriesReturnView = "home";
    embyState.seasons = [];
    embyState.selectedSeasonId = null;
    embyState.episodes = [];
    embyState.sourceOptions = [];
    embyState.previousRoute = null;
    embyState.scrollPositions.clear();
  };

  const switchEmbyServer = async (server) => {
    if (!server?.key) return;
    embyState.loadingLabel = `正在切换到 ${serverTitle(server)}…`;
    resetEmbyBrowseState();
    embyState.view = "loading";
    renderEmby();
    try {
      const result = await rpc("servers.switch", { serverKey: server.key }, { timeoutMs: 20_000 });
      Object.assign(embyState.config, result || {});
      embyState.connected = Boolean(result?.connected);
      await loadServers();
      if (embyState.connected) await loadHome(false);
      else {
        embyState.addingServer = false;
        embyState.inlineError = "这个服务器的登录已失效，请重新输入密码";
        embyState.view = "disconnected";
        renderEmby();
      }
    } catch (errorValue) {
      showError(errorValue, () => switchEmbyServer(server), "servers");
    }
  };

  const removeCurrentEmbyServer = async () => {
    const server = embyState.servers.find((entry) => entry.active);
    if (!server?.key) return;
    const message = `移除 ${serverTitle(server)}（${server.username || "未知用户"}）？`;
    const confirmed = typeof ctx.confirmAction === "function"
      ? await ctx.confirmAction({ title: "移除服务器？", message, confirmLabel: "移除", destructive: true })
      : confirm(message);
    if (!confirmed || isDisposed()) return;
    embyState.loadingLabel = `正在移除 ${serverTitle(server)}…`;
    resetEmbyBrowseState();
    embyState.view = "loading";
    renderEmby();
    try {
      const result = await rpc("servers.remove", { serverKey: server.key }, { timeoutMs: 20_000 });
      Object.assign(embyState.config, result || {});
      embyState.connected = Boolean(result?.connected);
      await loadServers();
      if (embyState.connected) await loadHome(false);
      else {
        embyState.view = embyState.servers.length > 0 ? "servers" : "disconnected";
        renderEmby();
      }
    } catch (errorValue) {
      showError(errorValue, removeCurrentEmbyServer, "servers");
    }
  };

  const renderServers = () => {
    const view = makeElement("div", "emby-view");
    view.dataset.view = "servers";
    view.append(makeToolbar("Emby 服务器", {
      back: () => {
        embyState.view = embyState.connected ? "home" : "disconnected";
        renderEmby();
      }
    }));
    const scroll = makeElement("div", "emby-scroll emby-server-list");
    for (const server of embyState.servers) {
      const button = makeElement("button", "emby-list-button");
      button.type = "button";
      button.setAttribute("aria-current", String(Boolean(server.active)));
      const dot = makeElement("span", `emby-server-dot${server.connected ? " connected" : ""}`);
      const copy = makeElement("span", "emby-list-copy");
      copy.append(
        makeElement("span", "emby-list-name", serverTitle(server)),
        makeElement("span", "emby-list-meta", `${server.username || "未知用户"}${server.active ? " · 当前" : ""}${server.connected ? "" : " · 需登录"}`)
      );
      button.append(dot, copy);
      listen(button, "click", () => switchEmbyServer(server));
      scroll.append(button);
    }
    if (!embyState.servers.length) scroll.append(makeEmpty("还没有保存的 Emby 服务器"));
    const actions = makeElement("div", "emby-server-actions");
    const add = makeElement("button", "emby-button primary", "添加 Emby 服务器");
    add.type = "button";
    listen(add, "click", () => {
      embyState.addingServer = true;
      embyState.pendingServerInput = "";
      embyState.pendingUsernameInput = "";
      embyState.inlineError = "";
      embyState.view = "disconnected";
      renderEmby();
    });
    actions.append(add);
    if (embyState.connected) {
      const disconnect = makeElement("button", "emby-button", "退出当前服务器");
      disconnect.type = "button";
      listen(disconnect, "click", logoutEmby);
      actions.append(disconnect);
    }
    if (embyState.servers.some((server) => server.active)) {
      const remove = makeElement("button", "emby-button danger", "移除当前服务器");
      remove.type = "button";
      listen(remove, "click", removeCurrentEmbyServer);
      actions.append(remove);
    }
    view.append(scroll, actions);
    return view;
  };

  const loadLibrary = async (folder, { append = false, stack = null } = {}) => {
    if (!folder?.id) return;
    const previousView = embyState.view;
    const startIndex = append ? embyState.libraryItems.length : 0;
    if (append) {
      embyState.libraryLoadingMore = true;
      renderEmby();
    } else {
      embyState.loadingLabel = `正在加载 ${folder.name || "媒体库"}…`;
      embyState.view = "loading";
      renderEmby();
    }
    try {
      const result = await rpc("library.get", { parentId: folder.id, startIndex, limit: 60 });
      if (isDisposed()) return;
      if (stack) embyState.libraryStack = stack;
      const items = Array.isArray(result?.items) ? result.items : [];
      embyState.libraryItems = append ? [...embyState.libraryItems, ...items] : items;
      embyState.libraryTotal = Math.max(embyState.libraryItems.length, Number(result?.totalRecordCount) || 0);
      embyState.libraryLoadingMore = false;
      embyState.view = "library";
      renderEmby();
    } catch (errorValue) {
      embyState.libraryLoadingMore = false;
      showError(errorValue, () => loadLibrary(folder, { append, stack }), previousView);
    }
  };

  const renderLibrary = () => {
    const view = makeElement("div", "emby-view");
    view.dataset.view = "library";
    const folder = embyState.libraryStack.at(-1);
    view.append(makeToolbar(folder?.name || "媒体库", {
      back: () => {
        rememberScroll();
        if (embyState.libraryStack.length <= 1) {
          embyState.libraryStack = [];
          embyState.view = "home";
          renderEmby();
          return;
        }
        const stack = embyState.libraryStack.slice(0, -1);
        loadLibrary(stack.at(-1), { stack });
      },
      search: () => {
        rememberScroll();
        embyState.searchReturnView = "library";
        embyState.view = "search";
        renderEmby({ focusSearch: true });
      }
    }));
    const grid = makeElement("div", "emby-scroll emby-library-grid");
    grid.dataset.scrollKey = `library:${folder?.id || "unknown"}`;
    for (const item of embyState.libraryItems) grid.append(makePosterButton(item));
    if (!embyState.libraryItems.length) grid.append(makeEmpty("这个媒体库暂无内容"));
    if (embyState.libraryItems.length < embyState.libraryTotal) {
      const more = makeElement("button", "emby-button emby-load-more", embyState.libraryLoadingMore ? "加载中…" : "加载更多");
      more.type = "button";
      more.disabled = embyState.libraryLoadingMore;
      listen(more, "click", () => loadLibrary(folder, { append: true }));
      grid.append(more);
    }
    view.append(grid);
    return view;
  };

  const makeResultButton = (item) => {
    const button = makeElement("button", "emby-list-button");
    button.type = "button";
    const poster = makeElement("span", "emby-list-poster", "Emby");
    const image = makeElement("img");
    image.alt = "";
    bindImage(image, item);
    poster.append(image);
    const copy = makeElement("span", "emby-list-copy");
    copy.append(
      makeElement("span", "emby-list-name", item.name || "未命名"),
      makeElement("span", "emby-list-meta", itemMeta(item))
    );
    button.append(poster, copy);
    listen(button, "click", () => openItem(item));
    return button;
  };

  // 原地刷新搜索结果与状态行，不重建整个视图 —— 关键是不销毁正在输入的 <input>，
  // 否则会打断 IME 组词并把光标跳到末尾。仅当搜索视图已挂载时用它；否则退回整渲染。
  const updateSearchResults = () => {
    if (embyState.view !== "search") {
      renderEmby({ focusSearch: true });
      return;
    }
    const results = embyApp.querySelector(".emby-results");
    const status = embyApp.querySelector(".emby-search-status");
    if (!results) {
      renderEmby({ focusSearch: true });
      return;
    }
    if (status) {
      status.textContent = embyState.searching
        ? "搜索中…"
        : embyState.searchQuery.trim().length < 2
          ? "输入至少 2 个字符"
          : `${embyState.searchItems.length} 条结果`;
    }
    results.dataset.scrollKey = `search:${embyState.searchQuery}`;
    const children = embyState.searchItems.map((item) => makeResultButton(item));
    if (embyState.searchQuery.trim().length >= 2 && !embyState.searching && !embyState.searchItems.length) {
      children.push(makeEmpty("没有找到匹配内容"));
    }
    results.replaceChildren(...children);
  };

  const runSearch = async (query) => {
    const generation = ++searchGeneration;
    if (searchRequestId) {
      cancelRpc(searchRequestId, true);
      searchRequestId = null;
    }
    if (query.trim().length < 2) {
      embyState.searchItems = [];
      embyState.searching = false;
      updateSearchResults();
      return;
    }
    embyState.searching = true;
    const status = embyApp.querySelector(".emby-search-status");
    if (status) status.textContent = "搜索中…";
    const request = requestRpc("search", { query: query.trim(), limit: 30 });
    searchRequestId = request.id;
    try {
      const result = await request.promise;
      if (isDisposed() || generation !== searchGeneration || embyState.view !== "search") return;
      embyState.searchItems = Array.isArray(result?.items) ? result.items.slice(0, 30) : [];
      embyState.searching = false;
      updateSearchResults();
    } catch (errorValue) {
      if (generation !== searchGeneration || isDisposed()) return;
      embyState.searching = false;
      showError(errorValue, () => runSearch(embyState.searchQuery), "search");
    } finally {
      if (searchRequestId === request.id) searchRequestId = null;
    }
  };

  const renderSearch = () => {
    const view = makeElement("div", "emby-view");
    view.dataset.view = "search";
    const toolbar = makeElement("header", "emby-toolbar");
    const goBack = () => {
      if (searchTimer) clearTimeout(searchTimer);
      if (searchRequestId) {
        cancelRpc(searchRequestId, true);
        searchRequestId = null;
      }
      searchGeneration += 1;
      rememberScroll();
      embyState.view = embyState.searchReturnView === "library" ? "library" : "home";
      renderEmby();
    };
    const handleInput = (query) => {
      embyState.searchQuery = query;
      if (searchTimer) clearTimeout(searchTimer);
      searchGeneration += 1;
      if (searchRequestId) {
        cancelRpc(searchRequestId, true);
        searchRequestId = null;
      }
      embyState.searching = false;
      const status = embyApp.querySelector(".emby-search-status");
      if (query.trim().length < 2) {
        embyState.searchItems = [];
        if (status) status.textContent = "输入至少 2 个字符";
        const results = embyApp.querySelector(".emby-results");
        results?.replaceChildren();
        return;
      }
      if (status) status.textContent = "等待输入完成…";
      searchTimer = setTimeout(() => runSearch(embyState.searchQuery), 300);
    };
    const { form } = makeSearchField({
      value: embyState.searchQuery,
      onInput: handleInput,
      onSubmit: (query) => {
        embyState.searchQuery = query;
        if (searchTimer) clearTimeout(searchTimer);
        runSearch(query);
      },
      onEscape: goBack
    });
    toolbar.append(makeIconButton("返回首页", "back", goBack), form);
    view.append(toolbar);
    const status = makeElement(
      "div",
      "emby-search-status emby-muted",
      embyState.searching
        ? "搜索中…"
        : embyState.searchQuery.trim().length < 2
          ? "输入至少 2 个字符"
          : `${embyState.searchItems.length} 条结果`
    );
    view.append(status);
    const scroll = makeElement("div", "emby-scroll emby-results");
    scroll.dataset.scrollKey = `search:${embyState.searchQuery}`;
    for (const item of embyState.searchItems) scroll.append(makeResultButton(item));
    if (embyState.searchQuery.trim().length >= 2 && !embyState.searching && !embyState.searchItems.length) {
      scroll.append(makeEmpty("没有找到匹配内容"));
    }
    view.append(scroll);
    return view;
  };

  const loadSeries = async (item, seasonId = null) => {
    rememberScroll();
    const previousView = embyState.view;
    if (!seasonId && ["home", "search", "library"].includes(previousView)) {
      embyState.seriesReturnView = previousView;
    }
    embyState.loadingLabel = seasonId ? "正在加载选集…" : "正在加载剧集…";
    embyState.view = "loading";
    renderEmby();
    try {
      const result = await rpc("series.get", { seriesId: item.id, seasonId });
      if (isDisposed()) return;
      embyState.seriesItem = item;
      embyState.seasons = Array.isArray(result?.seasons) ? result.seasons : [];
      embyState.selectedSeasonId = result?.selectedSeasonId || seasonId || embyState.seasons[0]?.id || null;
      embyState.episodes = Array.isArray(result?.episodes) ? result.episodes : [];
      embyState.sourceOptions = Array.isArray(result?.sourceOptions) ? result.sourceOptions : [];
      embyState.view = "series";
      renderEmby();
    } catch (errorValue) {
      showError(errorValue, () => loadSeries(item, seasonId), previousView);
    }
  };

  const renderSeries = () => {
    const view = makeElement("div", "emby-view");
    view.dataset.view = "series";
    view.append(makeToolbar("剧集与选集", {
      back: () => {
        rememberScroll();
        embyState.view = ["search", "library"].includes(embyState.seriesReturnView)
          ? embyState.seriesReturnView
          : "home";
        renderEmby();
      }
    }));
    const visual = makeElement("div", "emby-series-visual");
    const image = makeElement("img");
    image.alt = "";
    bindImage(image, embyState.seriesItem, "backdrop");
    visual.append(image, makeElement("div", "emby-series-title", embyState.seriesItem?.name || "剧集"));
    view.append(visual);
    const chips = makeElement("div", "emby-chips");
    for (const season of embyState.seasons) {
      const chip = makeElement("button", "emby-chip", season.name || `第 ${season.indexNumber || "?"} 季`);
      chip.type = "button";
      chip.setAttribute("aria-selected", String(season.id === embyState.selectedSeasonId));
      listen(chip, "click", () => {
        if (season.id !== embyState.selectedSeasonId) loadSeries(embyState.seriesItem, season.id);
      });
      chips.append(chip);
    }
    view.append(chips);
    // 选源 chips：仅当该剧有多个可选源时显示。推荐项由后端按最高画质档、
    // 字幕可用性与端到端播放成本统一计算；用户点选后记入按 seriesId 的会话偏好。
    if (embyState.sourceOptions.length > 1) {
      const seriesId = embyState.seriesItem?.id;
      const recommended = embyState.sourceOptions.find((option) => option.recommended)
        ?? embyState.sourceOptions.find((option) => option.hasSubtitles)
        ?? embyState.sourceOptions[0];
      const activeKey = preferredSourceKey(seriesId) ?? recommended?.sourceKey;
      const sourceChips = makeElement("div", "emby-chips emby-source-chips");
      for (const option of embyState.sourceOptions) {
        const chip = makeElement("button", "emby-chip emby-source-chip", option.label || option.sourceKey);
        chip.type = "button";
        chip.dataset.sourceKey = option.sourceKey;
        chip.setAttribute("aria-selected", String(option.sourceKey === activeKey));
        if (!option.hasSubtitles) chip.title = "该源没有字幕";
        listen(chip, "click", () => {
          if (preferredSourceKey(seriesId) === option.sourceKey) return;
          rememberSourcePreference(seriesId, option.sourceKey);
          renderEmby();
        });
        sourceChips.append(chip);
      }
      view.append(sourceChips);
    }
    const scroll = makeElement("div", "emby-scroll emby-episodes");
    scroll.dataset.scrollKey = `series:${embyState.seriesItem?.id || "unknown"}:${embyState.selectedSeasonId || "all"}`;
    if (!embyState.episodes.length) scroll.append(makeEmpty("这一季暂无可播放单集"));
    for (const episode of embyState.episodes) {
      const button = makeElement("button", "emby-list-button emby-episode-button");
      button.type = "button";
      button.append(makeElement("span", "emby-episode-index", episode.indexNumber ? `E${episode.indexNumber}` : "▶"));
      const copy = makeElement("span", "emby-list-copy");
      copy.append(
        makeElement("span", "emby-list-name", episode.name || `第 ${episode.indexNumber || "?"} 集`),
        makeElement("span", "emby-list-meta", [formatDuration(episode.runtimeTicks), episode.played ? "已看" : ""].filter(Boolean).join(" · "))
      );
      if (safePercent(episode.progressPercent) > 0) {
        const progress = makeElement("span", "emby-episode-progress");
        const fill = makeElement("span");
        fill.style.width = `${safePercent(episode.progressPercent)}%`;
        progress.append(fill);
        copy.append(progress);
      }
      button.append(copy);
      listen(button, "click", () => beginPlayback(episode));
      scroll.append(button);
    }
    view.append(scroll);
    return view;
  };

  // Codex 的 app:// 主页面通过 CSP 禁止连接 127.0.0.1。HLS 数据因此由
  // Companion 代拉，再以 Runtime.callFunctionOn arguments 返回；Base64 不会
  // 被编译成匿名脚本，避免旧 Runtime.evaluate 路径的 ScriptStore 泄漏。
  class EmbyHlsLoader {
    constructor() {
      this.context = null;
      this.callbacks = null;
      this.requestId = null;
      this.aborted = false;
      this.stats = {
        aborted: false,
        loaded: 0,
        total: 0,
        retry: 0,
        chunkCount: 0,
        bwEstimate: 0,
        loading: { start: 0, first: 0, end: 0 },
        parsing: { start: 0, end: 0 },
        buffering: { start: 0, first: 0, end: 0 }
      };
      this.settled = false;
    }

    load(context, loaderConfig, callbacks) {
      this.context = context;
      this.callbacks = callbacks;
      this.aborted = false;
      this.settled = false;
      const now = performance.now();
      Object.assign(this.stats, {
        aborted: false,
        loaded: 0,
        total: 0,
        retry: 0,
        chunkCount: 0,
        bwEstimate: 0,
        loading: { start: now, first: 0, end: 0 },
        parsing: { start: 0, end: 0 },
        buffering: { start: 0, first: 0, end: 0 }
      });
      const request = requestRpc("resource.load", {
        url: context.url,
        responseType: context.responseType === "arraybuffer" ? "arraybuffer" : "text",
        resourceType: "hls"
      }, { timeoutMs: Math.max(30_000, Number(loaderConfig?.timeout || 0)) });
      this.requestId = request.id;
      request.promise.then((result) => {
        if (this.aborted) return;
        const bytes = responseBytes(result);
        const isArrayBuffer = context.responseType === "arraybuffer";
        const data = isArrayBuffer
          ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
          : result?.encoding === "base64"
            ? new TextDecoder().decode(bytes)
            : String(result?.data ?? "");
        const end = performance.now();
        this.stats.loaded = isArrayBuffer ? bytes.byteLength : new TextEncoder().encode(data).byteLength;
        this.stats.total = this.stats.loaded;
        this.stats.chunkCount = 1;
        this.stats.loading.first = end;
        this.stats.loading.end = end;
        this.settled = true;
        this.requestId = null;
        callbacks.onSuccess(
          { url: result?.url || context.url, data },
          this.stats,
          context,
          { code: 200, text: "OK" }
        );
      }).catch((errorValue) => {
        if (this.aborted) return;
        this.settled = true;
        this.requestId = null;
        callbacks.onError(
          { code: 0, text: toRpcError(errorValue).message },
          context,
          null,
          this.stats
        );
      });
    }

    abort() {
      if (this.aborted || this.settled) return;
      this.aborted = true;
      this.settled = true;
      this.stats.aborted = true;
      if (this.requestId) cancelRpc(this.requestId, true);
      this.callbacks?.onAbort?.(this.stats, this.context, null);
    }

    destroy() {
      this.abort();
      this.context = null;
      this.callbacks = null;
    }

    getCacheAge() {
      return null;
    }
  }

  const currentEmbyVideo = () => embyApp.querySelector(".emby-video");

  const playbackPayload = (eventName) => {
    const playback = embyState.playback;
    const embyVideo = currentEmbyVideo();
    if (!playback) return null;
    return {
      playbackId: playback.playbackId,
      itemId: playback.itemId,
      mediaSourceId: playback.mediaSourceId,
      playSessionId: playback.playSessionId,
      positionTicks: Math.max(0, Math.round(Number(embyVideo?.currentTime || 0) * 10_000_000)),
      isPaused: Boolean(embyVideo?.paused),
      isMuted: Boolean(embyVideo?.muted),
      volumeLevel: Math.max(0, Math.min(100, Math.round(Number(embyVideo?.volume ?? 1) * 100))),
      event: eventName
    };
  };

  const reportProgress = (eventName) => {
    if (isDisposed() || playbackStopping || !embyState.playback) return;
    const payload = playbackPayload(eventName);
    if (payload) rpc("playback.progress", payload, { timeoutMs: 5_000 }).catch(() => {});
  };

  const setSubtitleStatus = (message = "", retry = null) => {
    const status = embyApp.querySelector(".emby-subtitle-status");
    if (!status) return;
    status.textContent = message;
    status.hidden = !message;
    if (retry) {
      const button = makeElement("button", "emby-subtitle-retry", "重试");
      button.type = "button";
      button.style.cssText = "margin-left:8px;color:inherit;text-decoration:underline;cursor:pointer";
      listen(button, "click", retry);
      status.append(button);
    }
  };

  const releaseSubtitleTrack = (video = currentEmbyVideo()) => {
    if (subtitleRequestId) cancelRpc(subtitleRequestId, true);
    subtitleRequestId = null;
    if (video) {
      for (const textTrack of video.textTracks || []) textTrack.mode = "disabled";
      for (const track of video.querySelectorAll("track[data-emby-subtitle]")) track.remove();
    }
    for (const url of subtitleObjectUrls) revokeObjectURL(url);
    subtitleObjectUrls.clear();
    subtitleObjectUrl = null;
  };

  const subtitleDescription = (subtitle) => {
    const flags = [];
    if (subtitle?.isForced) flags.push("强制");
    if (subtitle?.isHearingImpaired) flags.push("听障");
    if (subtitle?.isExternal) flags.push("外挂");
    return flags.join(" · ");
  };

  const rememberSubtitlePreference = (subtitle) => {
    subtitlePreference = subtitle
      ? {
          off: false,
          language: subtitle.language || "und",
          isForced: Boolean(subtitle.isForced),
          isHearingImpaired: Boolean(subtitle.isHearingImpaired)
        }
      : { off: true };
  };

  const preferredSubtitleIndex = (subtitles) => {
    if (!subtitlePreference) return undefined;
    if (subtitlePreference.off) return null;
    const exact = subtitles.find((subtitle) => (
      subtitle.language === subtitlePreference.language
      && Boolean(subtitle.isForced) === subtitlePreference.isForced
      && Boolean(subtitle.isHearingImpaired) === subtitlePreference.isHearingImpaired
    ));
    return (exact ?? subtitles.find((subtitle) => subtitle.language === subtitlePreference.language))?.index;
  };

  const rememberSourcePreference = (seriesId, sourceKey) => {
    if (!seriesId || !sourceKey) return;
    sourcePreferences.set(String(seriesId), String(sourceKey));
  };

  const preferredSourceKey = (seriesId) => {
    if (!seriesId) return undefined;
    return sourcePreferences.get(String(seriesId));
  };

  const syncSubtitleControls = (playback) => {
    const selected = playback?.selectedSubtitleIndex;
    const button = embyApp.querySelector(".emby-subtitle-button");
    const track = playback?.subtitles?.find((subtitle) => subtitle.index === selected);
    if (button) {
      button.title = track ? `字幕：${track.label}` : "字幕：关闭";
      button.setAttribute("aria-label", button.title);
      const value = button.querySelector(".emby-subtitle-value");
      if (value) value.textContent = track?.label || "关闭";
    }
    for (const option of embyApp.querySelectorAll(".emby-subtitle-option")) {
      const value = option.dataset.subtitleIndex === "off"
        ? null
        : Number(option.dataset.subtitleIndex);
      option.setAttribute("aria-checked", String(value === selected));
    }
  };

  const applyExternalSubtitle = async (video, playback, positionSeconds = Number(video.currentTime || 0)) => {
    if (subtitleRequestId) cancelRpc(subtitleRequestId, true);
    subtitleRequestId = null;
    if (playback.subtitleMode !== "external-vtt" || !Number.isSafeInteger(playback.selectedSubtitleIndex)) {
      releaseSubtitleTrack(video);
      syncSubtitleControls(playback);
      return;
    }
    const subtitle = playback.subtitles?.find((candidate) => candidate.index === playback.selectedSubtitleIndex);
    if (!subtitle) return;
    if (playback.subtitleLoadedIndex !== subtitle.index) {
      releaseSubtitleTrack(video);
      playback.subtitleWindows = new Map();
      playback.subtitleFull = false;
      playback.subtitleLoadedIndex = subtitle.index;
    }
    if (!video.querySelector("track[data-emby-subtitle]")) setSubtitleStatus("正在加载字幕，视频可继续播放…");
    const request = requestRpc("playback.subtitle.load", {
      playbackId: playback.playbackId,
      subtitleStreamIndex: subtitle.index,
      positionTicks: Math.round(positionSeconds * 10_000_000)
    }, { timeoutMs: 60_000 });
    subtitleRequestId = request.id;
    try {
      const result = await request.promise;
      if (isDisposed() || embyState.playback !== playback || subtitleRequestId !== request.id) return;
      subtitleRequestId = null;
      let text = String(result?.data ?? "");
      if (result.window) {
        playback.subtitleWindows.set(result.window.from, result);
        if (playback.subtitleWindows.size > 3) playback.subtitleWindows.delete(playback.subtitleWindows.keys().next().value);
        // 相邻窗口有重叠：去掉 cue ID 后按时间行与正文去重，保持跨边界字幕连续。
        const cues = new Set();
        for (const part of [...playback.subtitleWindows.values()].sort((a, b) => a.window.from - b.window.from)) {
          for (const block of part.data.replace(/\r/g, "").split(/\n\s*\n/)) {
            const at = block.search(/^(?:\d{2,}:)?\d{2}:\d{2}\.\d{3} --> /m);
            if (at >= 0) cues.add(block.slice(at).trim());
          }
        }
        text = `WEBVTT\n\n${[...cues].join("\n\n")}\n`;
      } else playback.subtitleFull = true;
      const blob = new Blob([text], { type: "text/vtt;charset=utf-8" });
      const nextUrl = createObjectURL(blob);
      subtitleObjectUrls.add(nextUrl);
      const track = document.createElement("track");
      track.dataset.embySubtitle = "true";
      track.kind = "subtitles";
      track.label = subtitle.label;
      track.srclang = subtitle.language || "und";
      track.src = nextUrl;
      track.default = true;
      // 浏览器完成解析前保留旧轨；新字幕可用后再换，后台预读不闪断当前字幕。
      const previousTracks = [...video.querySelectorAll("track[data-emby-subtitle]")];
      const previousUrl = subtitleObjectUrl;
      subtitleObjectUrl = nextUrl;
      listen(track, "load", () => {
        if (!video.contains(track)) return;
        for (const previous of previousTracks) { previous.track.mode = "disabled"; previous.remove(); }
        if (previousUrl) { revokeObjectURL(previousUrl); subtitleObjectUrls.delete(previousUrl); }
        track.track.mode = "showing";
      }, { once: true });
      video.append(track);
      track.track.mode = "hidden";
      setSubtitleStatus("");
      syncSubtitleControls(playback);
    } catch (errorValue) {
      if (isDisposed() || embyState.playback !== playback || subtitleRequestId !== request.id) return;
      subtitleRequestId = null;
      playback.subtitleRetryAfter = Date.now() + 30_000;
      setSubtitleStatus(`字幕暂未就绪：${toRpcError(errorValue).message}`, () => {
        playback.subtitleRetryAfter = 0;
        void applyExternalSubtitle(video, playback);
      });
      syncSubtitleControls(playback);
    }
  };

  const teardownPlaybackMedia = () => {
    scope.release(() => activeHls?.destroy?.());
    activeHls = null;
    scope.release(() => activeDirectPlayer?.destroy?.());
    activeDirectPlayer = null;
    const video = currentEmbyVideo();
    releaseSubtitleTrack(video);
    if (video) {
      scope.release(() => video.pause());
      video.removeAttribute("src");
      scope.release(() => video.load());
    }
  };

  const switchEmbySubtitle = async (subtitleStreamIndex) => {
    if (subtitleSwitching || !embyState.playback) return;
    const playback = embyState.playback;
    const video = currentEmbyVideo();
    if (!video) return;
    const subtitle = subtitleStreamIndex === null
      ? null
      : playback.subtitles?.find((candidate) => candidate.index === subtitleStreamIndex);
    if (subtitleStreamIndex !== null && !subtitle) return;
    if (playback.mediaReady !== true) {
      playback.pendingSubtitleSelection = subtitleStreamIndex;
      playback.pendingSubtitlePaused = playback.restorePlaybackState?.paused ?? false;
      setSubtitleStatus("视频准备完成后切换字幕…");
      return;
    }
    const previous = {
      index: playback.selectedSubtitleIndex,
      mode: playback.subtitleMode
    };
    const restorePlaybackState = {
      paused: Object.prototype.hasOwnProperty.call(playback, "pendingSubtitlePaused")
        ? playback.pendingSubtitlePaused
        : video.paused,
      volume: video.volume,
      muted: video.muted,
      currentTime: Number(video.currentTime || 0)
    };
    delete playback.pendingSubtitlePaused;
    subtitleSwitching = true;
    setSubtitleStatus(subtitle?.mode === "burn-in" || previous.mode === "burn-in"
      ? "正在切换字幕并恢复播放…"
      : "正在切换字幕…");
    try {
      const result = await rpc("playback.subtitle.select", {
        playbackId: playback.playbackId,
        subtitleStreamIndex,
        positionTicks: Math.max(0, Math.round(restorePlaybackState.currentTime * 10_000_000))
      }, { timeoutMs: 65_000 });
      if (isDisposed() || embyState.playback !== playback) return;
      Object.assign(playback, result);
      rememberSubtitlePreference(subtitle);
      if (result.restartRequired) {
        playback.restorePlaybackState = restorePlaybackState;
        playback.mediaReady = false;
        if (progressTimer) clearInterval(progressTimer);
        progressTimer = null;
        teardownPlaybackMedia();
        renderEmby();
      } else if (playback.subtitleMode === "external-vtt") {
        void applyExternalSubtitle(video, playback);
      } else {
        releaseSubtitleTrack(video);
        setSubtitleStatus("");
        syncSubtitleControls(playback);
      }
    } catch (errorValue) {
      if (isDisposed() || embyState.playback !== playback) return;
      playback.selectedSubtitleIndex = previous.index;
      playback.subtitleMode = previous.mode;
      setSubtitleStatus(`字幕切换失败：${toRpcError(errorValue).message}`);
      syncSubtitleControls(playback);
    } finally {
      if (embyState.playback === playback) subtitleSwitching = false;
    }
  };

  const canCreateBlobWorker = () => {
    if (typeof Worker !== "function") return false;
    let workerUrl = null;
    let worker = null;
    try {
      workerUrl = createObjectURL(new Blob(["self.close();"], { type: "text/javascript" }));
      worker = new Worker(workerUrl);
      return true;
    } catch {
      return false;
    } finally {
      worker?.terminate?.();
      if (workerUrl) revokeObjectURL(workerUrl);
    }
  };

  const reportWorkerFallback = () => {
    if (workerFallbackReported) return;
    workerFallbackReported = true;
    console.warn("[codex-companion] HLS Blob Worker 不可用，已降级到主线程解码");
  };

  const activatePlaybackState = (video, playback) => {
    if (isDisposed() || embyState.playback !== playback) return;
    if (!video.dataset.subtitleWindowListener) {
      video.dataset.subtitleWindowListener = "true";
      const refresh = (seeking = false) => {
        if (isDisposed() || embyState.playback !== playback || playback.subtitleMode !== "external-vtt" || playback.subtitleFull) return;
        if (!seeking && (subtitleRequestId || Date.now() < (playback.subtitleRetryAfter || 0))) return;
        const position = Number(video.currentTime || 0);
        const windows = [...(playback.subtitleWindows?.values() ?? [])];
        const current = windows.find((part) => part.window.from <= position && position < part.window.until);
        if (!current) void applyExternalSubtitle(video, playback, position);
        else if (position >= current.window.until - 15 && !windows.some((part) => part.window.from === current.window.until)) {
          void applyExternalSubtitle(video, playback, current.window.until);
        }
      };
      listen(video, "timeupdate", () => refresh());
      listen(video, "seeking", () => refresh(true));
    }
    const restore = playback.restorePlaybackState;
    if (restore) {
      video.volume = Math.max(0, Math.min(1, Number(restore.volume ?? 1)));
      video.muted = Boolean(restore.muted);
      const currentTime = Number(restore.currentTime);
      if (Number.isFinite(currentTime) && currentTime > 0) video.currentTime = currentTime;
    }
    delete playback.restorePlaybackState;
    playback.mediaReady = true;
    if (!restore?.paused && (ctx.environment?.kind !== "plugin" || cardVisible)) video.play().catch(() => {});
    if (Object.prototype.hasOwnProperty.call(playback, "pendingSubtitleSelection")) {
      const pendingSubtitleSelection = playback.pendingSubtitleSelection;
      delete playback.pendingSubtitleSelection;
      queueMicrotask(() => {
        if (!isDisposed() && embyState.playback === playback) {
          void switchEmbySubtitle(pendingSubtitleSelection);
        }
      });
      return;
    }
    if (playback.subtitleMode === "external-vtt") {
      void applyExternalSubtitle(video, playback);
    } else {
      releaseSubtitleTrack(video);
      syncSubtitleControls(playback);
      setSubtitleStatus("");
    }
  };

  const requireLoopbackMediaUrl = (value) => {
    try {
      const url = new URL(String(value ?? ""));
      const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
      const safePath = new RegExp(`^/hls/${uuid}/.+`, "i").test(url.pathname);
      if (
        url.protocol !== "http:"
        || url.hostname !== "127.0.0.1"
        || !url.port
        || url.username
        || url.password
        || url.hash
        || !safePath
      ) throw new Error("unsafe loopback URL");
      return url.href;
    } catch {
      return null;
    }
  };

  // CDP 媒体拦截地址（见 src/media-intercept.mjs）：保留域名 + 代理端口 + 秘密路径。
  const requireInterceptMediaUrl = (value) => {
    try {
      const url = new URL(String(value ?? ""));
      const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
      if (
        url.origin !== "https://codex-companion.invalid"
        || url.username
        || url.password
        || url.hash
        || !new RegExp(`^/\\d{1,5}/hls/${uuid}/.+`, "i").test(url.pathname)
      ) return null;
      return url.href;
    } catch {
      return null;
    }
  };

  // 原生直放：<video> 直接请求拦截地址，Range 数据走 Chromium 网络栈，
  // 不经 RPC/Base64，也不占 MSE SourceBuffer 配额。
  const configureNativeVideo = async (video, playback, mediaUrl) => {
    video.src = mediaUrl;
    video.load();
    await new Promise((resolve, reject) => {
      if (video.readyState >= 1) {
        resolve();
        return;
      }
      const timeout = setTimeout(() => finish(reject, rpcError("MEDIA_METADATA_TIMEOUT", "视频元数据加载超时", true)), 15_000);
      const finish = (callback, value) => {
        clearTimeout(timeout);
        unlisten(video, "loadedmetadata", onMetadata);
        unlisten(video, "error", onError);
        callback(value);
      };
      const onMetadata = () => finish(resolve);
      const onError = () => finish(
        reject,
        rpcError("MEDIA_LOAD_FAILED", video.error?.message || "原生视频加载失败", true)
      );
      listen(video, "loadedmetadata", onMetadata, { once: true });
      listen(video, "error", onError, { once: true });
    });
    if (isDisposed() || embyState.playback !== playback) throw rpcError("ABORTED", "播放器已经关闭");
    const startTime = Number(playback.startPositionTicks || 0) / 10_000_000;
    if (Number.isFinite(startTime) && startTime > 0) video.currentTime = startTime;
    return video;
  };

  const configureHls = (embyVideo, playback) => {
    if (typeof Hls !== "function" || (typeof Hls.isSupported === "function" && !Hls.isSupported())) {
      throw rpcError("HLS_UNAVAILABLE", "当前 Renderer 无法启动 HLS 播放器");
    }
    const startSeconds = Number(playback.startPositionTicks || 0) / 10_000_000;
    const enableWorker = canCreateBlobWorker();
    if (!enableWorker) reportWorkerFallback();
    // app:// 页面 CSP 明确禁止 connect-src 127.0.0.1；在 Codex 内直接走有界 RPC
    // loader。其他宿主若允许 loopback，可继续使用本地代理并保留一次降级能力。
    const hlsProxyUrl = location.protocol === "app:"
      ? null
      : requireLoopbackMediaUrl(playback.hlsProxyUrl);
    const useHlsProxy = Boolean(hlsProxyUrl) && playback.hlsProxyFallback !== true;
    const hlsOptions = {
      enableWorker,
      maxBufferLength: 30,
      maxMaxBufferLength: 30,
      backBufferLength: 15,
      maxBufferSize: 24 * 1024 * 1024,
      capLevelToPlayerSize: true,
      startPosition: startSeconds > 0 && Number.isFinite(startSeconds) ? startSeconds : -1
    };
    if (!useHlsProxy) {
      hlsOptions.loader = EmbyHlsLoader;
      hlsOptions.pLoader = EmbyHlsLoader;
      hlsOptions.fLoader = EmbyHlsLoader;
    }
    try {
      activeHls = new Hls(hlsOptions);
    } catch {
      reportWorkerFallback();
      activeHls = new Hls({ ...hlsOptions, enableWorker: false });
    }
    if (typeof activeHls.on === "function" && Hls.Events?.MANIFEST_PARSED) {
      activeHls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (isDisposed() || embyState.playback !== playback || !activeHls) return;
        const cappedIndex = Array.isArray(activeHls.levels)
          ? activeHls.levels.reduce((best, level, index) => Number(level?.height || 0) <= 720 ? index : best, -1)
          : -1;
        if (cappedIndex >= 0) activeHls.autoLevelCapping = cappedIndex;
        if (startSeconds > 0 && Number.isFinite(startSeconds)) embyVideo.currentTime = startSeconds;
        activatePlaybackState(embyVideo, playback);
      });
    }
    if (typeof activeHls.on === "function" && Hls.Events?.ERROR) {
      // 致命错误优先尝试 hls.js 的原地恢复，而不是直接拆毁播放器：瞬时 CDN/分片抖动
      // 用 startLoad() 续流、解码卡顿用 recoverMediaError() 通常能无缝恢复。每种恢复
      // 各有次数预算，耗尽或遇到不可恢复错误才回退到全屏错误 + 手动重试。
      let networkRecoveries = 0;
      let mediaRecoveries = 0;
      const MAX_NETWORK_RECOVERIES = 4;
      const MAX_MEDIA_RECOVERIES = 2;
      const hls = activeHls;
      activeHls.on(Hls.Events.ERROR, (_event, data) => {
        if (data?.event === "demuxerWorker") reportWorkerFallback();
        const ErrorTypes = Hls.ErrorTypes || {};
        if (
          useHlsProxy
          && !playback.hlsProxyFallback
          && data?.type === ErrorTypes.NETWORK_ERROR
          && !data?.frag
          && !playbackStopping
          && !subtitleSwitching
          && activeHls === hls
        ) {
          playback.hlsProxyFallback = true;
          const resumeSeconds = Number(embyVideo.currentTime || 0);
          if (Number.isFinite(resumeSeconds) && resumeSeconds > 0) {
            playback.startPositionTicks = Math.round(resumeSeconds * 10_000_000);
          }
          try { hls.destroy(); } catch { /* 忽略销毁异常 */ }
          if (activeHls === hls) activeHls = null;
          configureHls(embyVideo, playback);
          return;
        }
        if (!data?.fatal || playbackStopping || subtitleSwitching || activeHls !== hls) return;
        if (data.type === ErrorTypes.NETWORK_ERROR && networkRecoveries < MAX_NETWORK_RECOVERIES) {
          networkRecoveries += 1;
          try { hls.startLoad(); return; } catch { /* 落到下方全屏错误 */ }
        } else if (data.type === ErrorTypes.MEDIA_ERROR && mediaRecoveries < MAX_MEDIA_RECOVERIES) {
          mediaRecoveries += 1;
          try { hls.recoverMediaError(); return; } catch { /* 落到下方全屏错误 */ }
        }
        showError(
          rpcError("HLS_FATAL", "视频流播放失败，请返回后重试", true),
          () => beginPlayback(playback.item, true),
          embyState.previousRoute?.view || "home"
        );
      });
    }
    activeHls.attachMedia(embyVideo);
    activeHls.loadSource(useHlsProxy ? hlsProxyUrl : playback.hlsUrl);
  };
  const configureDirectMp4 = (embyVideo, playback) => configureDirectMp4Stream(embyVideo, playback, {
    rpcPrefix: "playback.direct",
    setActivePlayer: (player) => {
      lastMseDiagnostics = null;
      activeDirectPlayer = player;
    },
    clearActivePlayer: (player) => { if (activeDirectPlayer === player) activeDirectPlayer = null; },
    isStopping: () => playbackStopping || subtitleSwitching,
    onDiagnostics: (diagnostics) => { lastMseDiagnostics = diagnostics; },
    onFailure: (errorObject) => showError(
      errorObject,
      () => beginPlayback(playback.item, true),
      embyState.previousRoute?.view || "home"
    ),
    onQuotaExceeded: async (recoveryState) => {
      if (isDisposed() || playbackStopping || embyState.playback !== playback || embyState.view !== "playback") return;
      playback.mseQuotaRestarts = Math.max(0, Number(playback.mseQuotaRestarts) || 0) + 1;
      playback.mediaReady = false;
      setSubtitleStatus("正在释放媒体缓存并恢复播放…");
      const seekResult = await rpc("playback.direct.seek", {
        playbackId: playback.playbackId,
        timeSeconds: recoveryState.currentTime
      }, { timeoutMs: 45_000 });
      if (isDisposed() || playbackStopping || embyState.playback !== playback || embyState.view !== "playback") return;
      const actualStart = Number(seekResult?.timeSeconds);
      if (Number.isFinite(actualStart) && actualStart >= 0) {
        playback.startPositionTicks = Math.round(actualStart * 10_000_000);
      }
      playback.restorePlaybackState = recoveryState;
      await configureDirectMp4(embyVideo, playback);
      if (isDisposed() || playbackStopping || embyState.playback !== playback || embyState.view !== "playback") return;
      activatePlaybackState(embyVideo, playback);
      setSubtitleStatus("");
    }
  });

  const episodeContextMatches = (item) => (
    item?.type === "Episode"
    && embyState.seriesItem?.id === item.seriesId
    && embyState.selectedSeasonId === item.seasonId
    && embyState.episodes.some((episode) => episode.id === item.id)
  );

  const applyPlaybackEpisodeContext = (item, result) => {
    if (!item?.seriesId || !result) return;
    embyState.seriesItem = embyState.seriesItem?.id === item.seriesId
      ? embyState.seriesItem
      : {
          id: item.seriesId,
          name: item.seriesName || "剧集",
          type: "Series"
        };
    embyState.seasons = Array.isArray(result.seasons) ? result.seasons : [];
    embyState.selectedSeasonId = result.selectedSeasonId || item.seasonId || embyState.seasons[0]?.id || null;
    embyState.episodes = Array.isArray(result.episodes) ? result.episodes : [];
  };

  const fetchPlaybackEpisodeContext = (item, seasonId = item?.seasonId) => {
    if (item?.type !== "Episode" || !item.seriesId) return Promise.resolve(null);
    if (episodeContextRequestId) cancelRpc(episodeContextRequestId, true);
    const request = requestRpc("series.get", {
      seriesId: item.seriesId,
      seasonId: seasonId || undefined
    }, { timeoutMs: 30_000 });
    episodeContextRequestId = request.id;
    return request.promise.finally(() => {
      if (episodeContextRequestId === request.id) episodeContextRequestId = null;
    });
  };

  const currentEpisodeIndex = (itemId) => embyState.episodes.findIndex((episode) => episode.id === itemId);

  const adjacentEpisodeInSeason = (itemId, direction) => {
    const index = currentEpisodeIndex(itemId);
    return index >= 0 ? embyState.episodes[index + direction] || null : null;
  };

  const adjacentSeason = (direction) => {
    const index = embyState.seasons.findIndex((season) => season.id === embyState.selectedSeasonId);
    return index >= 0 ? embyState.seasons[index + direction] || null : null;
  };

  const hasAdjacentEpisode = (itemId, direction) => (
    Boolean(adjacentEpisodeInSeason(itemId, direction))
    || Boolean(adjacentSeason(direction))
  );

  const playbackEpisodeLabel = (item) => {
    const seasonNumber = Number(item?.parentIndexNumber);
    const episodeNumber = Number(item?.indexNumber);
    if (seasonNumber > 0 && episodeNumber > 0) return `S${seasonNumber} · E${episodeNumber}`;
    if (episodeNumber > 0) return `第 ${episodeNumber} 集`;
    return item?.name || "选集";
  };

  const syncPlaybackEpisodeNavigation = (view = embyApp.querySelector(".emby-playback")) => {
    const playback = embyState.playback;
    if (!view || !playback) return;
    const item = playback.item;
    const nav = view.querySelector(".emby-playback-episode-nav");
    const previous = view.querySelector('[data-episode-direction="-1"]');
    const next = view.querySelector('[data-episode-direction="1"]');
    const picker = view.querySelector(".emby-episode-picker");
    const pickerLabel = view.querySelector(".emby-episode-picker-button");
    const pickerHeader = view.querySelector(".emby-episode-picker-header");
    const pickerGrid = view.querySelector(".emby-episode-picker-grid");
    const endedNext = view.querySelector(".emby-ended-next");
    const isEpisode = item?.type === "Episode";
    const hasContext = isEpisode && episodeContextMatches(item);
    // 整部剧只有一集可播时，选集/上一集/下一集都没有意义：整条导航隐藏。
    // （加载上下文期间 hasContext=false，先保持现状避免闪烁；hasContext 为真
    // 即表示当前集在 episodes 里，此时 episodes.length<=1 就是整部只有一集。）
    const singleEpisodeOnly = hasContext
      && (Array.isArray(embyState.seasons) ? embyState.seasons.length : 0) <= 1
      && (Array.isArray(embyState.episodes) ? embyState.episodes.length : 0) <= 1;
    if (nav) nav.hidden = !isEpisode || singleEpisodeOnly;
    if (picker) picker.hidden = !isEpisode || !item.seriesId || singleEpisodeOnly;
    if (endedNext) endedNext.hidden = !isEpisode;
    if (!isEpisode) return;

    // 选集里切到别的季浏览时，episodes 不再包含当前集：上一集/下一集沿用最后一次
    // 在当前季算出的可用性（playAdjacentEpisode 会先切回当前季再跳转）。
    if (hasContext) {
      playback.adjacent = { previous: hasAdjacentEpisode(item.id, -1), next: hasAdjacentEpisode(item.id, 1) };
    }
    const adjacent = playback.adjacent || { previous: false, next: false };
    if (previous) previous.disabled = !adjacent.previous;
    if (next) next.disabled = !adjacent.next;
    if (endedNext) endedNext.disabled = !adjacent.next;
    if (pickerLabel) {
      pickerLabel.textContent = hasContext && embyState.episodes.length ? `共 ${embyState.episodes.length} 集` : "";
    }
    if (!pickerHeader || !pickerGrid) return;

    const sameSeries = embyState.seriesItem?.id === item.seriesId;
    const seasons = sameSeries ? embyState.seasons : [];
    pickerHeader.hidden = seasons.length <= 1;
    pickerHeader.replaceChildren();
    for (const season of seasons) {
      const chip = makeElement("button", "emby-episode-season", season.name || `第 ${season.indexNumber || "?"} 季`);
      chip.type = "button";
      chip.setAttribute("aria-selected", String(season.id === embyState.selectedSeasonId));
      listen(chip, "click", () => {
        if (season.id !== embyState.selectedSeasonId) void loadPlaybackSeason(season.id, playback);
      });
      pickerHeader.append(chip);
    }

    pickerGrid.replaceChildren();
    if (!sameSeries || !embyState.episodes.length) {
      pickerGrid.append(makeElement(
        "div",
        "emby-episode-picker-empty",
        episodeContextRequestId ? "正在加载选集…" : "暂无可播放单集"
      ));
      return;
    }
    let current = null;
    for (const episode of embyState.episodes) {
      const button = makeElement(
        "button",
        "emby-episode-picker-item",
        episode.indexNumber ? String(episode.indexNumber) : episode.name || "播放"
      );
      button.type = "button";
      button.title = [episode.indexNumber ? `第 ${episode.indexNumber} 集` : "", episode.name].filter(Boolean).join(" · ");
      button.setAttribute("aria-label", button.title || "播放");
      button.setAttribute("aria-current", String(episode.id === playback.itemId));
      if (episode.played) button.dataset.played = "true";
      if (episode.id === playback.itemId) current = button;
      listen(button, "click", () => {
        if (episode.id !== playback.itemId) void beginPlayback(episode, true);
      });
      pickerGrid.append(button);
    }
    // 集数多时网格自身限高滚动：只滚网格让当前集可见，不用 scrollIntoView——
    // 它会顺带滚动信息区和外层卡片列表。
    if (current) {
      requestAnimationFrame(() => {
        if (!current.isConnected || pickerGrid.scrollHeight <= pickerGrid.clientHeight) return;
        pickerGrid.scrollTop = Math.max(0, current.offsetTop - pickerGrid.offsetTop - (pickerGrid.clientHeight - current.offsetHeight) / 2);
      });
    }
  };

  const loadPlaybackSeason = async (seasonId, playback = embyState.playback) => {
    if (!playback?.item?.seriesId || embyState.playback !== playback) return null;
    const pickerLabel = embyApp.querySelector(".emby-episode-picker-button");
    if (pickerLabel) pickerLabel.textContent = "正在加载…";
    try {
      const result = await fetchPlaybackEpisodeContext(playback.item, seasonId);
      if (isDisposed() || embyState.playback !== playback) return null;
      applyPlaybackEpisodeContext({ ...playback.item, seasonId }, result);
      syncPlaybackEpisodeNavigation();
      return result;
    } catch (errorValue) {
      if (!isDisposed() && embyState.playback === playback) {
        setSubtitleStatus(toRpcError(errorValue).message || "加载选集失败");
        setTimeout(() => {
          if (embyState.playback === playback) setSubtitleStatus("");
        }, 2_500);
        syncPlaybackEpisodeNavigation();
      }
      return null;
    }
  };

  const playAdjacentEpisode = async (direction) => {
    const playback = embyState.playback;
    if (!playback?.item || playback.item.type !== "Episode") return;
    // 选集里正浏览别的季：先切回当前集所在季，相邻集按当前季计算。
    if (!episodeContextMatches(playback.item) && playback.item.seasonId) {
      await loadPlaybackSeason(playback.item.seasonId, playback);
      if (embyState.playback !== playback || !episodeContextMatches(playback.item)) return;
    }
    let episode = adjacentEpisodeInSeason(playback.itemId, direction);
    if (episode) {
      await beginPlayback(episode, true);
      return;
    }
    const season = adjacentSeason(direction);
    if (!season) return;
    const result = await loadPlaybackSeason(season.id, playback);
    if (!result || embyState.playback !== playback) return;
    episode = direction > 0 ? embyState.episodes[0] : embyState.episodes.at(-1);
    if (episode) {
      await beginPlayback(episode, true);
      return;
    }
    // 相邻季存在但没有可播放的单集：给出明确反馈而不是静默失败（否则按钮看似可点却无反应）。
    if (!isDisposed() && embyState.playback === playback) {
      setSubtitleStatus(direction > 0 ? "下一季暂无可播放的单集" : "上一季暂无可播放的单集");
      setTimeout(() => {
        if (embyState.playback === playback) setSubtitleStatus("");
      }, 2_500);
      syncPlaybackEpisodeNavigation();
    }
  };

  const AUTO_NEXT_SECONDS = 8;

  const renderPlayback = () => {
    const view = makeElement("div", "emby-view emby-playback");
    view.dataset.view = "playback";
    view.tabIndex = 0;
    const playback = embyState.playback;
    const directMediaUrl = playback?.streamMode === "direct-mp4"
      ? requireInterceptMediaUrl(playback.directMediaUrl)
      : null;
    const embyVideo = makeElement("video", "emby-video");
    embyVideo.controls = true;
    embyVideo.playsInline = true;
    embyVideo.preload = "metadata";
    // 与红果播放视图一致禁用画中画（Electron 下 PiP 行为未验证，两卡统一）。
    embyVideo.disablePictureInPicture = true;
    // 布局：视频按片源比例固定在顶部（.emby-stage），画面上只叠返回/全屏两个
    // 自动隐藏的控件；标题、集数、上一集/下一集、字幕与选集都放在下方信息区，
    // 不再遮挡画面。全屏时信息区隐藏，舞台铺满。
    const stage = makeElement("div", "emby-stage");
    const chrome = makeElement("div", "emby-playback-chrome");
    const back = makeIconButton("返回媒体列表", "back", () => stopPlayback(true));
    back.classList.add("emby-playback-back");
    chrome.append(back, makeElement("span", "emby-playback-spacer"));
    const playbackItem = embyState.playback?.item || {};
    const info = makeElement("div", "emby-playback-info emby-scroll");
    const heading = makeElement("div", "emby-playback-heading");
    if (playbackItem.type === "Episode" && playbackItem.seriesName) {
      heading.append(makeElement("div", "emby-playback-kicker", playbackItem.seriesName));
    }
    heading.append(makeElement("div", "emby-playback-title", playbackItem.name || "正在播放"));
    const tags = makeElement("div", "emby-playback-tags");
    const codeLabel = playbackItem.type === "Episode"
      ? playbackEpisodeLabel(playbackItem)
      : playbackItem.productionYear ? String(playbackItem.productionYear) : "";
    if (codeLabel) tags.append(makeElement("span", "emby-playback-tag", codeLabel));
    // 画质透出：与选源 chips 同源的标签（如 "4K MKV H264"、"1080p MP4"），没有时不占位。
    if (embyState.playback?.qualityLabel) {
      tags.append(makeElement("span", "emby-playback-tag emby-playback-quality", embyState.playback.qualityLabel));
    }
    if (tags.childElementCount) heading.append(tags);
    info.append(heading);
    const subtitles = Array.isArray(embyState.playback?.subtitles) ? embyState.playback.subtitles : [];
    let subtitleMenu = null;
    const episodeNav = makeElement("div", "emby-playback-episode-nav");
    episodeNav.hidden = true;
    episodeNav.setAttribute("role", "group");
    episodeNav.setAttribute("aria-label", "切换剧集");
    const makeEpisodeNavButton = (direction, label, icon) => {
      const button = makeElement("button", "emby-episode-nav-button");
      button.type = "button";
      button.dataset.episodeDirection = String(direction);
      button.setAttribute("aria-label", `播放${label}`);
      const text = makeElement("span", "", label);
      button.append(...(direction < 0 ? [makeToolbarIcon(icon), text] : [text, makeToolbarIcon(icon)]));
      listen(button, "click", () => void playAdjacentEpisode(direction));
      return button;
    };
    episodeNav.append(
      makeEpisodeNavButton(-1, "上一集", "previous"),
      makeEpisodeNavButton(1, "下一集", "next")
    );
    info.append(episodeNav);
    // 选集直接内嵌在信息区：季切换 + 横滑集数，不再弹出遮挡画面的对话框。
    const episodePicker = makeElement("section", "emby-episode-picker");
    episodePicker.hidden = true;
    episodePicker.setAttribute("aria-label", "剧集与选集");
    const pickerTitle = makeElement("div", "emby-section-title");
    pickerTitle.append(
      makeElement("span", "", "选集"),
      makeElement("span", "emby-episode-picker-button", "")
    );
    episodePicker.append(
      pickerTitle,
      makeElement("div", "emby-episode-picker-header"),
      makeElement("div", "emby-episode-picker-grid")
    );
    const settingsGroup = makeElement("div", "emby-playback-settings");
    if (subtitles.length > 0) {
      const subtitleButton = makeElement("button", "emby-playback-row emby-subtitle-button");
      subtitleButton.type = "button";
      subtitleButton.append(
        makeToolbarIcon("subtitles"),
        makeElement("span", "emby-playback-row-label", "字幕"),
        makeElement("span", "emby-playback-row-value emby-subtitle-value", ""),
        makeToolbarIcon("chevron")
      );
      subtitleButton.setAttribute("aria-haspopup", "menu");
      subtitleButton.setAttribute("aria-expanded", "false");
      subtitleMenu = makeElement("div", "emby-subtitle-menu");
      subtitleMenu.hidden = true;
      subtitleMenu.setAttribute("role", "menu");
      const makeOption = (subtitle) => {
        const option = makeElement("button", "emby-subtitle-option");
        option.type = "button";
        option.setAttribute("role", "menuitemradio");
        option.dataset.subtitleIndex = subtitle ? String(subtitle.index) : "off";
        const check = makeToolbarIcon("check");
        check.classList.add("emby-subtitle-check");
        option.append(
          check,
          makeElement("span", "emby-subtitle-label", subtitle?.label || "关闭字幕"),
          makeElement("span", "emby-subtitle-meta", subtitleDescription(subtitle))
        );
        listen(option, "click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          closeSubtitleMenu();
          void switchEmbySubtitle(subtitle?.index ?? null);
        });
        return option;
      };
      subtitleMenu.append(makeOption(null), ...subtitles.map(makeOption));
      listen(subtitleButton, "click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        subtitleMenu.hidden = !subtitleMenu.hidden;
        subtitleButton.setAttribute("aria-expanded", String(!subtitleMenu.hidden));
        if (!subtitleMenu.hidden) subtitleMenu.querySelector('[aria-checked="true"]')?.focus();
      });
      listen(subtitleMenu, "keydown", (event) => {
        const options = [...subtitleMenu.querySelectorAll(".emby-subtitle-option")];
        const current = Math.max(0, options.indexOf(shadow.activeElement));
        let next = null;
        if (event.key === "ArrowDown") next = options[(current + 1) % options.length];
        else if (event.key === "ArrowUp") next = options[(current - 1 + options.length) % options.length];
        else if (event.key === "Home") next = options[0];
        else if (event.key === "End") next = options.at(-1);
        if (next) {
          event.preventDefault();
          event.stopPropagation();
          next.focus();
        }
      });
      const subtitleAnchor = makeElement("div", "emby-playback-menu-anchor");
      subtitleAnchor.append(subtitleButton, subtitleMenu);
      settingsGroup.append(subtitleAnchor);
    }
    if (settingsGroup.childElementCount) info.append(settingsGroup);
    info.append(episodePicker);
    const closeSubtitleMenu = ({ focus = false } = {}) => {
      if (!subtitleMenu || subtitleMenu.hidden) return false;
      subtitleMenu.hidden = true;
      const subtitleButton = info.querySelector(".emby-subtitle-button");
      subtitleButton?.setAttribute("aria-expanded", "false");
      if (focus) subtitleButton?.focus();
      return true;
    };
    chrome.append(makeFullscreenButton(view, "emby-icon-button emby-playback-fullscreen"));
    const subtitleStatus = makeElement("div", "emby-subtitle-status");
    subtitleStatus.hidden = true;
    // 播完：有下一集时显示带倒计时圆环的「下一集」卡片，倒计时结束自动续播；
    // 用户点取消或重播后不再自动跳转。电影只保留重播。
    const ended = makeElement("div", "emby-ended");
    ended.hidden = true;
    const endedCard = makeElement("div", "emby-ended-card");
    const endedCopy = makeElement("div", "emby-ended-copy");
    endedCopy.append(
      makeElement("span", "emby-ended-label", "即将播放"),
      makeElement("span", "emby-ended-name", "")
    );
    const endedNext = makeElement("button", "emby-ended-next");
    endedNext.type = "button";
    endedNext.hidden = true;
    endedNext.setAttribute("aria-label", "立即播放下一集");
    const ring = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    ring.setAttribute("viewBox", "0 0 36 36");
    ring.setAttribute("aria-hidden", "true");
    ring.classList.add("emby-ended-ring");
    for (const className of ["emby-ended-ring-track", "emby-ended-ring-value"]) {
      const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      circle.setAttribute("cx", "18");
      circle.setAttribute("cy", "18");
      circle.setAttribute("r", "16");
      circle.setAttribute("pathLength", "100");
      circle.classList.add(className);
      ring.append(circle);
    }
    const nextIcon = makeToolbarIcon("next");
    nextIcon.classList.add("emby-ended-next-icon");
    endedNext.append(ring, nextIcon);
    const endedActions = makeElement("div", "emby-ended-actions");
    const cancelAutoNext = makeElement("button", "emby-ended-action emby-ended-cancel", "取消");
    cancelAutoNext.type = "button";
    const replay = makeElement("button", "emby-ended-action", "重播");
    replay.type = "button";
    replay.prepend(makeToolbarIcon("replay"));
    endedActions.append(cancelAutoNext, replay);
    endedCard.append(endedNext, endedCopy, endedActions);
    ended.append(endedCard);
    let autoNextTimer = null;
    const stopAutoNext = () => {
      clearTimeout(autoNextTimer);
      autoNextTimer = null;
      delete ended.dataset.countdown;
      cancelAutoNext.hidden = true;
    };
    const showEnded = () => {
      stopAutoNext();
      const playback = embyState.playback;
      const nextEpisode = playback?.item && episodeContextMatches(playback.item)
        ? adjacentEpisodeInSeason(playback.itemId, 1)
        : null;
      const canAdvance = !endedNext.hidden && !endedNext.disabled;
      ended.dataset.hasNext = String(canAdvance);
      endedCopy.querySelector(".emby-ended-name").textContent = nextEpisode
        ? [playbackEpisodeLabel(nextEpisode), /^第\s*\d+\s*集$/.test(nextEpisode.name || "") ? "" : nextEpisode.name].filter(Boolean).join(" · ")
        : adjacentSeason(1) && playback?.item && episodeContextMatches(playback.item) ? "下一季第一集" : "下一集";
      ended.hidden = false;
      if (!canAdvance) return;
      cancelAutoNext.hidden = false;
      // 圆环动画与 CSS 同步：data-countdown 触发 8s 的 stroke-dashoffset 过渡。
      ended.dataset.countdown = "running";
      autoNextTimer = setTimeout(() => {
        autoNextTimer = null;
        if (embyState.playback === playback && !ended.hidden) void playAdjacentEpisode(1);
      }, AUTO_NEXT_SECONDS * 1000);
    };
    const hideEnded = () => {
      stopAutoNext();
      ended.hidden = true;
    };
    listen(cancelAutoNext, "click", stopAutoNext);
    listen(endedNext, "click", () => {
      stopAutoNext();
      void playAdjacentEpisode(1);
    });
    listen(replay, "click", () => {
      if (!embyVideo) return;
      hideEnded();
      embyVideo.currentTime = 0;
      embyVideo.play().catch(() => {});
    });
    const wirePlaybackVideo = () => {
      if (!embyVideo) return;
      // 暂停状态同步到 view.dataset.paused：CSS 据此常显 chrome（初始 paused 时
      // 加载中也显示返回键/标题）。play/pause 覆盖全部状态翻转点。
      const syncPausedState = () => { view.dataset.paused = String(embyVideo.paused); };
      listen(embyVideo, "play", syncPausedState);
      listen(embyVideo, "playing", syncPausedState);
      listen(embyVideo, "pause", syncPausedState);
      syncPausedState();
      listen(embyVideo, "pause", () => reportProgress("pause"));
      listen(embyVideo, "play", () => {
        reportProgress("play");
        // ended 时停掉了定时上报；重播（ended 界面按钮或拖回进度条）时恢复。
        if (!progressTimer && !embyState.playback?.preview) {
          progressTimer = setInterval(() => reportProgress("progress"), 10_000);
        }
      });
      listen(embyVideo, "seeked", () => reportProgress("seek"));
      listen(embyVideo, "volumechange", () => {
        // 拖原生音量条时每帧都触发：500ms 尾沿节流，避免每帧一个 playback.progress RPC。
        if (volumeReportTimer) return;
        volumeReportTimer = setTimeout(() => {
          volumeReportTimer = null;
          reportProgress("volumechange");
        }, 500);
      });
      listen(embyVideo, "ended", () => {
        // 播完即停表：否则用户停在重播界面时，每 10s 的 progress 会让服务端
        // 转码会话无限期保活。不发 playback.stop —— 重播复用同一 playSessionId，
        // stop 会让服务端会话（含 HLS 转码）失效；离开播放页时 cleanupPlayback 统一 stop。
        clearInterval(progressTimer);
        progressTimer = null;
        reportProgress("ended");
        showEnded();
      });
      // 播完界面里直接拖进度条重新播放时，收起播完卡片并取消自动下一集。
      listen(embyVideo, "play", () => {
        if (!ended.hidden) hideEnded();
      });
      // 舞台按片源真实比例显示：竖屏/超宽片源也不留上下黑边（受 max-height 约束时
      // 才由 object-fit 留边）。
      const syncAspect = () => {
        const width = Number(embyVideo.videoWidth);
        const height = Number(embyVideo.videoHeight);
        if (width > 0 && height > 0) stage.style.setProperty("--emby-aspect", `${width} / ${height}`);
      };
      listen(embyVideo, "loadedmetadata", syncAspect);
      listen(embyVideo, "resize", syncAspect);
      syncAspect();
    };
    wirePlaybackVideo();
    listen(view, "keydown", (event) => {
      // 空格/左右方向键转发给 video：仅当焦点在容器本身，避免劫持内部按钮的
      // 空格激活与字幕菜单/选集内的方向键导航。
      if (event.target === view && (event.key === " " || event.key === "ArrowLeft" || event.key === "ArrowRight")) {
        event.preventDefault();
        event.stopPropagation();
        if (!embyVideo) return;
        if (event.key === " ") {
          if (embyVideo.paused) embyVideo.play().catch(() => {});
          else embyVideo.pause();
        } else {
          const delta = event.key === "ArrowRight" ? 5 : -5;
          const duration = Number(embyVideo.duration);
          embyVideo.currentTime = Math.max(
            0,
            Math.min(Number.isFinite(duration) ? duration : Infinity, Number(embyVideo.currentTime || 0) + delta)
          );
        }
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (closeSubtitleMenu({ focus: true })) return;
        if (autoNextTimer) {
          stopAutoNext();
          return;
        }
        stopPlayback(true);
      }
    });
    listen(view, "click", (event) => {
      if (subtitleMenu && !subtitleMenu.hidden && !subtitleMenu.parentNode.contains(event.target)) closeSubtitleMenu();
    });
    stage.append(embyVideo, chrome, subtitleStatus, ended);
    view.append(stage, info);
    setTimeout(() => {
      if (!view.isConnected) return;
      view.focus({ preventScroll: true });
      syncSubtitleControls(embyState.playback);
      syncPlaybackEpisodeNavigation(view);
      if (!embyState.playback?.preview) {
        const playback = embyState.playback;
        const start = async () => {
          let nativeReady = false;
          if (directMediaUrl && !playback.nativeFallback) {
            try {
              await configureNativeVideo(embyVideo, playback, directMediaUrl);
              nativeReady = true;
            } catch (errorValue) {
              if (toRpcError(errorValue).code === "ABORTED") throw errorValue;
              // 原生解码不了（容器/编码不支持）或拦截通道失效：同一会话改走 MSE。
              playback.nativeFallback = true;
              embyVideo.removeAttribute("src");
              embyVideo.load();
            }
          }
          if (nativeReady) {
            if (embyState.playback !== playback || embyState.view !== "playback") return;
            activatePlaybackState(embyVideo, playback);
          } else if (["direct-mp4", "ffmpeg-fmp4"].includes(playback.streamMode)) {
            await configureDirectMp4(embyVideo, playback);
            // await 期间用户可能已退出或另开了新视频：迟到完成不能激活旧 playback，
            // 更不能覆盖新播放的 progressTimer 句柄（旧 interval 会永远清不掉，
            // 变成双重上报）。与下方 catch 用同一代际判断。
            if (embyState.playback !== playback || embyState.view !== "playback") return;
            activatePlaybackState(embyVideo, playback);
          } else {
            configureHls(embyVideo, playback);
          }
          clearInterval(progressTimer);
          progressTimer = setInterval(() => reportProgress("progress"), 10_000);
        };
        start().catch((errorValue) => {
          if (embyState.playback !== playback || embyState.view !== "playback") return;
          const playbackItem = playback.item;
          showError(
            errorValue,
            () => beginPlayback(playbackItem, true),
            embyState.previousRoute?.view || "home"
          );
        });
      }
    }, 0);
    return view;
  };

  const cleanupPlayback = (reportStop = true) => {
    const payload = playbackPayload("stop");
    playbackStopping = true;
    // 上一个播放的字幕切换 RPC（最长 65s）可能还没落地：播放既已销毁，
    // 必须复位切换标志，否则新播放的字幕切换与失败上报会被旧 flag 阻塞。
    // 进行中的旧 RPC 由 switchEmbySubtitle 内的 playback 代际判断兜底。
    subtitleSwitching = false;
    if (episodeContextRequestId) cancelRpc(episodeContextRequestId, true);
    episodeContextRequestId = null;
    if (progressTimer) clearInterval(progressTimer);
    progressTimer = null;
    if (volumeReportTimer) clearTimeout(volumeReportTimer);
    volumeReportTimer = null;
    teardownPlaybackMedia();
    if (reportStop && payload && !embyState.playback?.preview) {
      rpc("playback.stop", payload, { timeoutMs: 5_000 }).catch(() => {});
    }
    embyState.playback = null;
    playbackStopping = false;
  };

  const stopPlayback = (restoreRoute) => {
    const route = embyState.previousRoute;
    cleanupPlayback(true);
    if (!restoreRoute || isDisposed()) return;
    embyState.view = route?.view && route.view !== "playback" ? route.view : "home";
    if (route?.scrollKey) embyState.scrollPositions.set(route.scrollKey, route.scrollTop || 0);
    embyState.previousRoute = null;
    renderEmby();
  };

  const beginPlayback = async (item, preserveRoute = false) => {
    if (!item?.id) return;
    const currentScroller = embyApp.querySelector(".emby-scroll[data-scroll-key]");
    if (!preserveRoute) {
      embyState.previousRoute = {
        view: embyState.view,
        scrollKey: currentScroller?.dataset.scrollKey || null,
        scrollTop: currentScroller?.scrollTop || 0
      };
    }
    if (embyState.playback) cleanupPlayback(true);
    const episodeContextPromise = item.type === "Episode" && item.seriesId && !episodeContextMatches(item)
      ? fetchPlaybackEpisodeContext(item).catch(() => null)
      : Promise.resolve(null);
    embyState.loadingLabel = `正在准备 ${item.name || "视频"}…`;
    embyState.view = "loading";
    renderEmby();
    try {
      const result = await rpc("playback.open", {
        itemId: item.id,
        startPositionTicks: Number(item.positionTicks || 0),
        ...(item.seriesId && preferredSourceKey(item.seriesId)
          ? { preferredSourceKey: preferredSourceKey(item.seriesId) }
          : {}),
        // 字幕偏好随 open 一次选好，避免默认选择不合时再串行 select 一次
        // （burn-in 偏好会让转码/ffmpeg 会话开两次）。service 返回已匹配偏好时，
        // 下方的 preferredIndex 比较自然相等，不会再发 select。
        ...(subtitlePreference ? { subtitlePreference } : {})
      }, { timeoutMs: 30_000 });
      if (isDisposed()) return;
      const streamMode = result?.streamMode || (result?.hlsUrl ? "hls" : null);
      if (streamMode === "hls" && !result.hlsUrl) {
        throw rpcError("PLAYBACK_SOURCE_MISSING", "服务器没有返回可播放的 HLS 视频流");
      }
      if (!["hls", "direct-mp4", "ffmpeg-fmp4"].includes(streamMode)) {
        throw rpcError("PLAYBACK_SOURCE_MISSING", "服务器没有返回受支持的视频流");
      }
      const playback = {
        ...result,
        streamMode,
        item,
        itemId: result.itemId || item.id,
        mediaReady: false
      };
      const preferredIndex = preferredSubtitleIndex(playback.subtitles || []);
      if (preferredIndex !== undefined && preferredIndex !== playback.selectedSubtitleIndex) {
        const selection = await rpc("playback.subtitle.select", {
          playbackId: playback.playbackId,
          subtitleStreamIndex: preferredIndex,
          positionTicks: Number(playback.startPositionTicks || 0)
        }, { timeoutMs: 65_000 });
        Object.assign(playback, selection);
      }
      if (isDisposed()) return;
      embyState.playback = playback;
      embyState.view = "playback";
      renderEmby();
      void episodeContextPromise.then((context) => {
        if (!context || isDisposed() || embyState.playback !== playback) return;
        applyPlaybackEpisodeContext(item, context);
        syncPlaybackEpisodeNavigation();
      });
    } catch (errorValue) {
      if (episodeContextRequestId) cancelRpc(episodeContextRequestId, true);
      episodeContextRequestId = null;
      showError(errorValue, () => beginPlayback(item, true), embyState.previousRoute?.view || "home");
    }
  };

  const openItem = (item) => {
    // 离开当前列表前记住滚动位置，返回时可回到原处（此前打开媒体库文件夹会丢失首页滚动）。
    rememberScroll();
    if (item?.isFolder) {
      const stack = embyState.view === "library"
        ? [...embyState.libraryStack, item]
        : [item];
      loadLibrary(item, { stack });
    } else if (item?.type === "Series") loadSeries(item);
    else beginPlayback(item);
  };

  const renderError = () => {
    const view = makeElement("div", "emby-view emby-center");
    view.dataset.view = "error";
    view.append(
      makeElement("div", "emby-error-title", "Emby 暂时不可用"),
      makeElement("div", "emby-muted", embyState.error?.message || "请求失败，请稍后重试")
    );
    const actions = makeElement("div", "emby-error-actions");
    if (embyState.retry) {
      const retry = makeElement("button", "emby-button", "重试");
      retry.type = "button";
      listen(retry, "click", embyState.retry);
      actions.append(retry);
    }
    const back = makeElement("button", "emby-button", "返回");
    back.type = "button";
    listen(back, "click", () => {
      embyState.view = embyState.error?.returnView === "playback"
        ? embyState.previousRoute?.view || "home"
        : embyState.error?.returnView || (embyState.connected ? "home" : "disconnected");
      embyState.error = null;
      embyState.retry = null;
      renderEmby();
    });
    actions.append(back);
    view.append(actions);
    return view;
  };

  const showError = (errorValue, retry, returnView) => {
    if (isDisposed()) return;
    if (embyState.playback) cleanupPlayback(true);
    const errorObject = toRpcError(errorValue);
    if (errorObject.code === "UNAUTHORIZED" || errorObject.code === "AUTH_EXPIRED" || errorObject.code === "HTTP_401") {
      cleanupPlayback(false);
      embyState.connected = false;
      embyState.inlineError = "登录已失效，请重新连接";
      embyState.view = "disconnected";
      renderEmby();
      return;
    }
    embyState.error = { message: errorObject.message, code: errorObject.code, returnView };
    embyState.retry = typeof retry === "function" ? retry : null;
    embyState.view = "error";
    renderEmby();
  };

  const loadHome = async (showLoading = true) => {
    if (showLoading) {
      embyState.loadingLabel = "正在加载媒体库…";
      embyState.view = "loading";
      renderEmby();
    }
    const applyHomeResult = (result) => {
      embyState.home = {
        views: Array.isArray(result?.views) ? result.views : [],
        resume: Array.isArray(result?.resume) ? result.resume.slice(0, 5) : [],
        latest: Array.isArray(result?.latest) ? result.latest.slice(0, 12) : []
      };
      embyState.connected = true;
      embyState.view = "home";
      renderEmby();
    };
    try {
      const result = await rpc("home.get", {}, { timeoutMs: 30_000 });
      if (isDisposed()) return;
      applyHomeResult(result);
      if (result?.cacheStatus === "stale") {
        void rpc("home.get", { refresh: true }, { timeoutMs: 30_000 }).then((refreshed) => {
          if (isDisposed()) return;
          embyState.home = {
            views: Array.isArray(refreshed?.views) ? refreshed.views : embyState.home.views,
            resume: Array.isArray(refreshed?.resume) ? refreshed.resume.slice(0, 5) : embyState.home.resume,
            latest: Array.isArray(refreshed?.latest) ? refreshed.latest.slice(0, 12) : embyState.home.latest
          };
          if (embyState.view === "home") renderEmby();
        }).catch(() => {});
      }
    } catch (errorValue) {
      showError(errorValue, () => loadHome(true), "home");
    }
  };

  const loadServers = async () => {
    const result = await rpc("servers.list");
    if (isDisposed()) return;
    embyState.servers = Array.isArray(result?.servers) ? result.servers : [];
  };

  const logoutEmby = async () => {
    cleanupPlayback(true);
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = null;
    searchGeneration += 1;
    if (searchRequestId) cancelRpc(searchRequestId, true);
    searchRequestId = null;
    cancelImageLoads();
    for (const requestId of imageRequests) cancelRpc(requestId, true);
    imageRequests.clear();
    releaseImageCache();
    embyState.connected = false;
    embyState.home = { views: [], resume: [], latest: [] };
    embyState.libraryStack = [];
    embyState.libraryItems = [];
    embyState.libraryTotal = 0;
    embyState.searchQuery = "";
    embyState.searchItems = [];
    embyState.seriesItem = null;
    embyState.seasons = [];
    embyState.episodes = [];
    embyState.sourceOptions = [];
    embyState.scrollPositions.clear();
    embyState.inlineError = "";
    embyState.view = "disconnected";
    renderEmby();
    try {
      const result = await rpc("auth.logout", {});
      Object.assign(embyState.config, result || {});
      await loadServers();
      if (!isDisposed()) renderEmby();
    } catch {
      // 本地已退出；后端清理失败不把敏感状态带回 UI。
    }
  };

  const renderEmby = (options = {}) => {
    if (isDisposed()) return;
    let view;
    if (embyState.view === "disconnected") view = renderDisconnected();
    else if (embyState.view === "home") view = renderHome();
    else if (embyState.view === "servers") view = renderServers();
    else if (embyState.view === "library") view = renderLibrary();
    else if (embyState.view === "search") view = renderSearch();
    else if (embyState.view === "series") view = renderSeries();
    else if (embyState.view === "playback") view = renderPlayback();
    else if (embyState.view === "error") view = renderError();
    else view = renderLoading();
    embyApp.replaceChildren(view);
    restoreScroll();
    if (options.focusSearch) {
      requestAnimationFrame(() => {
        const input = embyApp.querySelector(".emby-search-input");
        if (!input) return;
        input.focus({ preventScroll: true });
        input.setSelectionRange(input.value.length, input.value.length);
      });
    }
  };

  const getEmbyState = () => ({
    view: embyState.view,
    connected: embyState.connected,
    baseUrl: embyState.config.baseUrl,
    username: embyState.config.username,
    resumeCount: embyState.home.resume.length,
    latestCount: embyState.home.latest.length,
    libraryCount: embyState.home.views.length,
    libraryItemCount: embyState.libraryItems.length,
    serverCount: embyState.servers.length,
    query: embyState.searchQuery,
    searchCount: embyState.searchItems.length,
    seasonCount: embyState.seasons.length,
    selectedSeasonId: embyState.selectedSeasonId,
    episodeCount: embyState.episodes.length,
    playing: Boolean(embyState.playback),
    subtitleCount: embyState.playback?.subtitles?.length || 0,
    selectedSubtitleIndex: embyState.playback?.selectedSubtitleIndex ?? null,
    subtitleMode: embyState.playback?.subtitleMode || "off",
    pendingRpcCount: scope.pendingRpcCount(),
    imageCacheCount: imageCache.size,
    imageCacheBytes,
    activeImageLoads,
    queuedImageLoads: imageLoadQueue.length,
    mseDiagnostics: activeDirectPlayer ? {
      keyframeCount: activeDirectPlayer.keyframeTimes.length,
      quotaRetries: activeDirectPlayer.quotaRetries,
      quotaKeyframeRecoveries: activeDirectPlayer.quotaKeyframeRecoveries,
      quotaRestarts: activeDirectPlayer.quotaRestarts,
      lastQuotaRecovery: activeDirectPlayer.lastQuotaRecovery,
      seekInFlight: activeDirectPlayer.seekInFlight,
      pendingSeekTime: activeDirectPlayer.pendingSeekTime,
      pointerActive: activeDirectPlayer.pointerActive,
      pointerSawSeek: activeDirectPlayer.pointerSawSeek
    } : lastMseDiagnostics
  });

  const dispatchEmby = (actionValue, payload = {}) => {
    const actionName = typeof actionValue === "string" ? actionValue : actionValue?.type;
    const actionPayload = typeof actionValue === "object" && actionValue !== null
      ? actionValue.payload ?? payload
      : payload;
    rememberScroll();
    if (actionName === "showDisconnected") {
      cleanupPlayback(false);
      embyState.connected = false;
      embyState.view = "disconnected";
    } else if (actionName === "showHome") {
      cleanupPlayback(false);
      embyState.connected = true;
      embyState.home = {
        views: actionPayload.views || [],
        resume: actionPayload.resume || [],
        latest: actionPayload.latest || []
      };
      embyState.libraryStack = [];
      embyState.libraryItems = [];
      embyState.view = "home";
    } else if (actionName === "showSearch") {
      embyState.searchQuery = actionPayload.query || "";
      embyState.searchItems = actionPayload.items || [];
      embyState.view = "search";
    } else if (actionName === "showSeries") {
      embyState.seriesReturnView = embyState.view === "search" ? "search" : "home";
      embyState.seriesItem = actionPayload.series || actionPayload.item || { id: "preview", name: "剧集", type: "Series" };
      embyState.seasons = actionPayload.seasons || [];
      embyState.selectedSeasonId = actionPayload.selectedSeasonId || embyState.seasons[0]?.id || null;
      embyState.episodes = actionPayload.episodes || [];
      embyState.sourceOptions = actionPayload.sourceOptions || [];
      embyState.view = "series";
    } else if (actionName === "previewPlayback") {
      embyState.previousRoute = { view: embyState.view, scrollKey: null, scrollTop: 0 };
      embyState.playback = {
        preview: true,
        itemId: actionPayload.item?.id || "preview",
        item: actionPayload.item || { id: "preview", name: "播放预览", type: "Video" }
      };
      embyState.view = "playback";
    } else if (actionName === "back") {
      if (embyState.view === "playback") {
        stopPlayback(true);
        return getEmbyState();
      }
      embyState.view = embyState.connected ? "home" : "disconnected";
    } else {
      throw new TypeError(`未知 Emby 动作：${actionName}`);
    }
    renderEmby({ focusSearch: embyState.view === "search" });
    return getEmbyState();
  };

  const initializeEmby = async () => {
    renderEmby();
    try {
      const result = await rpc("connection.status");
      if (isDisposed()) return;
      Object.assign(embyState.config, result || {});
      embyState.connected = Boolean(result?.connected);
      await loadServers();
      if (embyState.connected) await loadHome(false);
      else if (embyState.servers.length > 1) {
        embyState.view = "servers";
        renderEmby();
      } else {
        embyState.view = "disconnected";
        renderEmby();
      }
    } catch (errorValue) {
      if (isDisposed()) return;
      embyState.connected = false;
      embyState.inlineError = toRpcError(errorValue).message;
      embyState.view = "disconnected";
      renderEmby();
    }
  };

  const cleanupEmby = () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = null;
    searchGeneration += 1;
    if (searchRequestId) cancelRpc(searchRequestId, true);
    searchRequestId = null;
    cleanupPlayback(true);
    cancelImageLoads();
    for (const requestId of imageRequests) cancelRpc(requestId, true);
    imageRequests.clear();
    releaseImageCache();
  };

  const api = Object.freeze({ dispatch: scope.guard(dispatchEmby), getState: getEmbyState });
  scope.effects.add(cleanupEmby);
  scope.effects.add(() => shadow.replaceChildren());
  queueMicrotask(() => { void initializeEmby(); });
  return {
    api,
    updateSettings() {},
    visibilityChanged(state) {
      if (isDisposed()) return;
      cardVisible = state?.visible === true;
      if (state?.visible) refreshEmbyImages();
      else if (ctx.environment?.kind === "plugin") currentEmbyVideo()?.pause();
    },
    dispose: scope.dispose,
  };
}
