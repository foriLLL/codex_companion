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
  shadow.innerHTML = `<style>${mediaStyles}</style><section class="panel hg-panel" data-card="hongguo" aria-label="红果短剧播放器"><div class="hg-app" aria-live="polite"></div></section>`;
  const hongguoApp = shadow.querySelector(".hg-app");
  let refreshHongguoImages = () => {};
  let objectUrl = null;
  const releaseObjectUrl = () => {
    if (objectUrl) revokeObjectURL(objectUrl);
    objectUrl = null;
  };
  const hongguoState = {
    view: "loading",
    loadingLabel: "正在加载短剧内容…",
    featured: [],
    feedCursor: null,
    feedHasMore: false,
    feedTotal: 0,
    feedLoading: false,
    feedError: null,
    listItems: [],
    selectedDrama: null,
    playback: null,
    error: null,
    retryAction: null,
    detailReturnView: "home",
    errorReturnView: "home",
    scrollPositions: new Map()
  };
  let hongguoDirectPlayer = null;
  let hongguoPlaybackStopping = false;
  let hongguoAutoplayTimer = null;
  let hongguoFeedRequestId = null;
  let hongguoHomeRetryTimer = null;
  let hongguoHomeRetryAttempt = 0;
  const hongguoImageCache = new Map();
  const hongguoImageRequests = new Map();
  const hongguoImageRetries = new Map();
  let hongguoImageBytes = 0;
  const hongguoImageRetryDelays = [1_500, 5_000];

  const rememberHongguoScroll = () => {
    const scroller = hongguoApp.querySelector(".hg-scroll[data-scroll-key]");
    if (scroller) hongguoState.scrollPositions.set(scroller.dataset.scrollKey, scroller.scrollTop);
  };

  const clearHongguoAutoplay = () => {
    if (hongguoAutoplayTimer !== null) clearInterval(hongguoAutoplayTimer);
    hongguoAutoplayTimer = null;
  };

  const restoreHongguoScroll = () => {
    const scroller = hongguoApp.querySelector(".hg-scroll[data-scroll-key]");
    if (!scroller) return;
    const top = hongguoState.scrollPositions.get(scroller.dataset.scrollKey) || 0;
    requestAnimationFrame(() => {
      if (scroller.isConnected) scroller.scrollTop = top;
    });
  };

  const releaseHongguoImages = () => {
    for (const entry of hongguoImageCache.values()) revokeObjectURL(entry.url);
    hongguoImageCache.clear();
    hongguoImageBytes = 0;
  };

  const trimHongguoImages = () => {
    if (hongguoImageCache.size <= 30 && hongguoImageBytes <= 12 * 1024 * 1024) return;
    // 只回收「已不被任何在场 <img> 引用」的 Blob URL。瀑布流里向上滚出的封面仍在 DOM 中，
    // 若按纯 LRU 直接 revoke 会让这些图变空白（用户所见「刷着刷着上面图没了」）。
    const inUse = new Set();
    for (const img of hongguoApp.querySelectorAll("img[data-hg-image-reference]")) {
      if (img.src) inUse.add(img.src);
    }
    let guard = hongguoImageCache.size;
    while ((hongguoImageCache.size > 30 || hongguoImageBytes > 12 * 1024 * 1024) && guard-- > 0) {
      const oldestKey = hongguoImageCache.keys().next().value;
      const oldest = hongguoImageCache.get(oldestKey);
      hongguoImageCache.delete(oldestKey);
      if (inUse.has(oldest.url)) {
        // 仍在使用：重新放回队尾（保活），不 revoke。等它滚出/被替换后再回收。
        hongguoImageCache.set(oldestKey, oldest);
      } else {
        hongguoImageBytes -= oldest.size;
        revokeObjectURL(oldest.url);
      }
    }
  };

  const clearHongguoImageRetry = (reference) => {
    const retry = hongguoImageRetries.get(reference);
    if (retry?.timer != null) clearTimeout(retry.timer);
    hongguoImageRetries.delete(reference);
  };

  const scheduleHongguoImageRetry = (reference, targets) => {
    if (isDisposed() || !reference) return;
    let retry = hongguoImageRetries.get(reference);
    if (!retry) {
      retry = { attempt: 0, timer: null, targets: new Set() };
      hongguoImageRetries.set(reference, retry);
    }
    for (const target of targets) retry.targets.add(target);
    if (retry.timer !== null) return;
    if (retry.attempt >= hongguoImageRetryDelays.length) {
      // 本轮退避预算耗尽后释放 DOM 引用；下次重挂载仍可开启一轮新重试。
      hongguoImageRetries.delete(reference);
      return;
    }
    const delay = hongguoImageRetryDelays[retry.attempt++];
    retry.timer = setTimeout(() => {
      retry.timer = null;
      const retryTargets = [...retry.targets].filter((target) => (
        target.isConnected && !target.getAttribute("src")
      ));
      retry.targets.clear();
      if (retryTargets.length === 0) {
        clearHongguoImageRetry(reference);
        return;
      }
      for (const target of retryTargets) {
        bindHongguoImage(target, { posterUrl: reference });
      }
    }, delay);
  };

  const handleHongguoImageError = (img, reference) => {
    const failedUrl = img.src;
    img.removeAttribute("src");
    const cached = hongguoImageCache.get(reference);
    if (cached?.url === failedUrl) {
      hongguoImageCache.delete(reference);
      hongguoImageBytes -= cached.size;
      revokeObjectURL(cached.url);
    }
    scheduleHongguoImageRetry(reference, [img]);
  };

  const bindHongguoImage = (img, item) => {
    const reference = item?.posterUrl;
    if (!reference) return;
    img.dataset.hgImageReference = reference;
    const cached = hongguoImageCache.get(reference);
    if (cached) {
      hongguoImageCache.delete(reference);
      hongguoImageCache.set(reference, cached);
      img.src = cached.url;
      return;
    }
    const pending = hongguoImageRequests.get(reference);
    if (pending) {
      pending.targets.add(img);
      return;
    }
    const request = requestRpc("hongguo.image.load", { url: reference }, { timeoutMs: 20_000 });
    const entry = { id: request.id, targets: new Set([img]) };
    hongguoImageRequests.set(reference, entry);
    request.promise.then((result) => {
      if (isDisposed()) return;
      const bytes = responseBytes(result);
      if (!bytes.byteLength) return;
      const blob = new Blob([bytes], { type: result?.contentType || "image/jpeg" });
      const url = createObjectURL(blob);
      hongguoImageCache.set(reference, { url, size: blob.size });
      hongguoImageBytes += blob.size;
      // Summary 关闭时 host 会暂时脱离 DOM。即使此刻 disconnected，
      // 也必须把 Blob URL 写回原节点，否则重新打开后会永久停在占位图。
      for (const target of entry.targets) target.src = url;
      // 必须先绑定再回收：新 URL 在赋给 img 前不属于 inUse，先 trim 会把
      // 第 31 张起的新封面立即 revoke，随后触发 error 并永久留下占位图。
      clearHongguoImageRetry(reference);
      trimHongguoImages();
    }).catch(() => {
      // 瞬时网络失败不进入缓存；保留 img，并做有限退避重试。
      scheduleHongguoImageRetry(reference, entry.targets);
    }).finally(() => {
      if (hongguoImageRequests.get(reference) === entry) {
        hongguoImageRequests.delete(reference);
      }
    });
  };

  refreshHongguoImages = () => {
    for (const img of hongguoApp.querySelectorAll("img[data-hg-image-reference]")) {
      if (img.getAttribute("src")) continue;
      bindHongguoImage(img, { posterUrl: img.dataset.hgImageReference });
    }
  };

  const makeHongguoToolbar = (title, { back = null } = {}) => {
    const toolbar = makeElement("header", "hg-toolbar");
    if (back) {
      const button = makeElement("button", "hg-icon-button");
      button.type = "button";
      button.title = "返回";
      button.setAttribute("aria-label", "返回");
      button.append(makeToolbarIcon("back"));
      listen(button, "click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        back();
      });
      toolbar.append(button);
    }
    toolbar.append(makeElement("h2", "hg-toolbar-title", title));
    return toolbar;
  };

  const makeHongguoIdForm = () => {
    const form = makeElement("form", "hg-search-form");
    const input = makeElement("input", "hg-search-input");
    input.type = "text";
    input.placeholder = "输入剧集 ID 打开";
    input.autocomplete = "off";
    input.inputMode = "numeric";
    input.setAttribute("aria-label", "输入剧集 ID");
    const submit = makeElement("button", "hg-button primary", "打开");
    submit.type = "submit";
    form.append(input, submit);
    listen(form, "submit", (event) => {
      event.preventDefault();
      const id = input.value.trim();
      if (id) void openHongguoById(id);
    });
    listen(input, "keydown", (event) => event.stopPropagation());
    return form;
  };

  const makeHongguoPoster = (item, className) => {
    const poster = makeElement("span", className, "短剧");
    if (item?.posterUrl) {
      const img = document.createElement("img");
      img.alt = "";
      // 图片字节由 hongguo.image.load RPC 立即拉取（blob 赋值），loading="lazy"
      // 不影响请求时机，只误导读者，故不设。
      listen(img, "error", () => handleHongguoImageError(img, item.posterUrl));
      poster.append(img);
      bindHongguoImage(img, item);
    }
    return poster;
  };

  const makeHongguoResult = (item, { removable = false } = {}) => {
    const button = makeElement("button", "hg-result");
    button.type = "button";
    const copy = makeElement("span", "hg-result-copy");
    copy.append(
      makeElement("span", "hg-result-name", item.name || `短剧 ${item.id}`),
      makeElement("span", "hg-muted", item.totalEpisodes ? `${item.totalEpisodes} 集 · ID ${item.id}` : `点击加载选集 · ID ${item.id}`)
    );
    button.append(makeHongguoPoster(item, "hg-result-poster"), copy);
    listen(button, "click", () => void openHongguoDetail(item));
    if (!removable) return button;
    // 片单项：包一层，带一个移除按钮
    const row = makeElement("div", "hg-list-row");
    const remove = makeElement("button", "hg-icon-button hg-list-remove");
    remove.type = "button";
    remove.title = "从片单移除";
    remove.setAttribute("aria-label", "从片单移除");
    remove.append(makeToolbarIcon("close"));
    listen(remove, "click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void removeFromHongguoList(item.id);
    });
    row.append(button, remove);
    return row;
  };

  const renderHongguoLoading = () => {
    const view = makeElement("div", "hg-view hg-center");
    view.dataset.view = "loading";
    view.append(makeElement("div", "hg-spinner"), makeElement("span", "hg-muted", hongguoState.loadingLabel));
    return view;
  };

  const renderHongguoHome = () => {
    const view = makeElement("div", "hg-view");
    view.dataset.view = "home";
    view.append(makeHongguoToolbar("红果短剧"));
    const scroll = makeElement("div", "hg-scroll hg-content");
    scroll.dataset.scrollKey = "home";
    scroll.append(
      makeHongguoIdForm()
    );
    // 我的片单：ID 直达打开过的剧留在这里，点一下直接进选集，无需重输
    if (hongguoState.listItems.length > 0) {
      scroll.append(makeElement("h3", "hg-section-title", "我的片单"));
      for (const item of hongguoState.listItems) {
        scroll.append(makeHongguoResult(item, { removable: true }));
      }
    }
    if (hongguoState.featured.length === 0) {
      scroll.append(makeElement("div", "hg-empty", "暂无推荐内容，可输入剧集 ID 打开"));
    } else {
      scroll.append(makeElement("h3", "hg-section-title", "为你推荐"));
      const grid = makeElement("div", "hg-feature-grid");
      for (const item of hongguoState.featured) {
        const button = makeElement("button", "hg-feature");
        button.type = "button";
        button.append(makeHongguoPoster(item, "hg-feature-poster"), makeElement("span", "hg-feature-name", item.name));
        listen(button, "click", () => void openHongguoDetail(item));
        grid.append(button);
      }
      scroll.append(grid);
      const feedStatus = makeElement("div", "hg-feed-status");
      feedStatus.dataset.feedStatus = "true";
      if (hongguoState.feedLoading) {
        const status = makeElement("div", "hg-inline-status");
        status.append(makeElement("span", "hg-mini-spinner"), makeElement("span", "", "正在加载更多…"));
        feedStatus.append(status);
      } else if (hongguoState.feedError) {
        const retry = makeElement("button", "hg-button", "加载失败，点击重试");
        retry.type = "button";
        listen(retry, "click", () => void loadMoreHongguo());
        feedStatus.append(retry);
      } else if (hongguoState.feedHasMore) {
        feedStatus.textContent = "继续下滑加载更多";
      } else {
        feedStatus.textContent = hongguoState.feedTotal > 0
          ? `已加载本次推荐的 ${hongguoState.feedTotal} 部短剧`
          : "已经到底了";
      }
      scroll.append(feedStatus);
      listen(scroll, "scroll", () => {
        if (scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 180) void loadMoreHongguo();
      }, { passive: true });
    }
    view.append(scroll);
    return view;
  };

  const renderHongguoDetail = () => {
    const drama = hongguoState.selectedDrama || {};
    const view = makeElement("div", "hg-view");
    view.dataset.view = "detail";
    view.append(makeHongguoToolbar(drama.name || "选择集数", {
      back: () => {
        hongguoState.view = hongguoState.detailReturnView || "home";
        renderHongguo();
      }
    }));
    const scroll = makeElement("div", "hg-scroll");
    scroll.dataset.scrollKey = `detail:${drama.id || "unknown"}`;
    const hero = makeElement("div", "hg-detail-hero");
    const copy = makeElement("div", "hg-detail-copy");
    copy.append(
      makeElement("h3", "hg-detail-title", drama.name || `短剧 ${drama.id || ""}`),
      makeElement(
        "div",
        "hg-muted",
        drama.fullEpisodeCount > drama.accessibleEpisodeCount
          ? `官网开放前 ${drama.accessibleEpisodeCount || 0} 集 · 全 ${drama.fullEpisodeCount} 集`
          : `${drama.totalEpisodes || 0} 集 · ID ${drama.id || "-"}`
      )
    );
    if (drama.description) copy.append(makeElement("div", "hg-muted hg-detail-description", drama.description));
    hero.append(makeHongguoPoster(drama, "hg-detail-poster"), copy);
    scroll.append(hero);
    const grid = makeElement("div", "hg-episode-grid");
    const total = Math.max(0, Number(drama.totalEpisodes || 0));
    if (total === 0) grid.append(makeElement("div", "hg-empty", "红果官网当前没有开放可播放剧集"));
    else {
      for (let episode = 1; episode <= total; episode += 1) {
        const button = makeElement("button", "hg-episode", String(episode));
        button.type = "button";
        button.setAttribute("aria-label", `播放第 ${episode} 集`);
        listen(button, "click", () => void beginHongguoPlayback(drama, episode));
        grid.append(button);
      }
    }
    scroll.append(grid);
    view.append(scroll);
    return view;
  };

  const stopHongguoPlayback = (reportStop = true) => {
    const playbackId = hongguoState.playback?.playbackId;
    clearHongguoAutoplay();
    hongguoPlaybackStopping = true;
    scope.release(() => hongguoDirectPlayer?.destroy?.());
    hongguoDirectPlayer = null;
    const video = hongguoApp.querySelector(".hg-video");
    if (video) {
      scope.release(() => video.pause());
      video.removeAttribute("src");
      scope.release(() => video.load());
    }
    if (reportStop && playbackId) {
      rpc("hongguo.playback.stop", { playbackId }, { timeoutMs: 5_000 }).catch(() => {});
    }
    hongguoState.playback = null;
    releaseObjectUrl();
    hongguoPlaybackStopping = false;
  };

  const showHongguoError = (errorValue, returnView = "home", retryAction = null) => {
    if (isDisposed()) return;
    const error = toRpcError(errorValue);
    stopHongguoPlayback(true);
    hongguoState.error = { code: error.code, message: error.message, retryable: error.retryable };
    hongguoState.retryAction = typeof retryAction === "function" ? retryAction : null;
    hongguoState.errorReturnView = returnView;
    hongguoState.view = "error";
    renderHongguo();
  };

  const configureHongguoDirectMp4 = async (video, playback, status) => {
    listen(video, "canplay", () => { status.hidden = true; }, { once: true });
    await configureDirectMp4Stream(video, playback, {
      rpcPrefix: "hongguo.playback.direct",
      setActivePlayer: (player) => { hongguoDirectPlayer = player; },
      clearActivePlayer: (player) => { if (hongguoDirectPlayer === player) hongguoDirectPlayer = null; },
      isStopping: () => hongguoPlaybackStopping,
      onFailure: (errorObject) => {
        if (hongguoState.playback) hongguoState.playback.lastError = errorObject.message;
        const drama = hongguoState.selectedDrama;
        const episode = Number(hongguoState.playback?.episode);
        showHongguoError(
          errorObject,
          "detail",
          drama?.id && episode > 0 ? () => beginHongguoPlayback(drama, episode) : null
        );
      }
    });
  };

  const renderHongguoPlayback = () => {
    const playback = hongguoState.playback || {};
    const view = makeElement("div", "hg-view hg-playback");
    view.dataset.view = "playback";
    view.tabIndex = 0;
    const video = makeElement("video", "hg-video");
    video.controls = true;
    video.playsInline = true;
    video.preload = "metadata";
    video.disablePictureInPicture = true;
    const chrome = makeElement("div", "hg-playback-chrome");
    const back = makeElement("button", "hg-icon-button hg-playback-back");
    back.type = "button";
    back.title = "返回选集";
    back.setAttribute("aria-label", "返回选集");
    back.append(makeToolbarIcon("back"));
    listen(back, "click", () => {
      stopHongguoPlayback(true);
      hongguoState.view = hongguoState.selectedDrama ? "detail" : "home";
      renderHongguo();
    });
    chrome.append(back, makeElement("span", "hg-playback-title", playback.title || "正在播放"));
    chrome.append(makeFullscreenButton(view, "hg-icon-button hg-playback-fullscreen"));
    const status = makeElement("div", "hg-playback-status");
    status.append(makeElement("div", "hg-spinner"), makeElement("span", "", "正在连接视频源…"));
    const autoplay = makeElement("div", "hg-autoplay");
    autoplay.hidden = true;
    autoplay.setAttribute("role", "dialog");
    autoplay.setAttribute("aria-label", "自动连播");
    const autoplayCard = makeElement("div", "hg-autoplay-card");
    const autoplayTitle = makeElement("div", "hg-autoplay-title");
    const autoplayDetail = makeElement("div", "hg-autoplay-detail");
    autoplayDetail.setAttribute("aria-live", "polite");
    const autoplayActions = makeElement("div", "hg-autoplay-actions");
    autoplayCard.append(autoplayTitle, autoplayDetail, autoplayActions);
    autoplay.append(autoplayCard);
    const drama = hongguoState.selectedDrama;
    const currentEpisode = Number(playback.episode);
    const totalEpisodes = Math.max(0, Number(drama?.totalEpisodes || 0));
    const knownTotal = totalEpisodes > 0;
    // totalEpisodes 缺失（未加载到集数元数据）时不能断定已到最后一集，否则会在剧集中途
    // 错误显示「已经是最后一集」而无法连播。此时把下一集当作「可能存在」：提供手动按钮，
    // 但不自动倒计时跳转（避免真到结尾时自动跳进不存在的集导致报错）。
    const nextEpisode =
      drama?.id && currentEpisode > 0 && (!knownTotal || currentEpisode < totalEpisodes)
        ? currentEpisode + 1
        : null;
    const autoAdvance = knownTotal && Boolean(nextEpisode);
    let playbackTransitionStarted = false;

    const hideAutoplay = () => {
      clearHongguoAutoplay();
      autoplay.hidden = true;
    };
    const restartCurrentEpisode = () => {
      if (playbackTransitionStarted) return;
      hideAutoplay();
      if (drama?.id && currentEpisode > 0) {
        playbackTransitionStarted = true;
        void beginHongguoPlayback(drama, currentEpisode);
        return;
      }
      video.currentTime = 0;
      void video.play().catch(() => {});
    };
    const playNextEpisode = () => {
      if (playbackTransitionStarted || !nextEpisode || !drama?.id) return;
      playbackTransitionStarted = true;
      hideAutoplay();
      void beginHongguoPlayback(drama, nextEpisode);
    };
    const makeAutoplayButton = (label, primary, onClick) => {
      const button = makeElement("button", `hg-button${primary ? " primary" : ""}`, label);
      button.type = "button";
      listen(button, "click", onClick);
      return button;
    };
    const showEndedActions = (title, detail, includeNext = false) => {
      clearHongguoAutoplay();
      autoplayTitle.textContent = title;
      autoplayDetail.textContent = detail;
      const replay = makeAutoplayButton("重播", false, restartCurrentEpisode);
      if (includeNext) {
        autoplayActions.replaceChildren(
          makeAutoplayButton("播放下一集", true, playNextEpisode),
          replay
        );
      } else {
        autoplayActions.replaceChildren(replay);
      }
      autoplay.hidden = false;
    };
    const beginAutoplayCountdown = () => {
      if (!nextEpisode) {
        showEndedActions("本集已播放完毕", knownTotal ? "已经是最后一集" : "没有更多可播放的选集");
        return;
      }
      if (!autoAdvance) {
        // 集数未知：不自动跳转，改为提供手动续播入口（下一集可能不存在，交由用户决定）。
        showEndedActions("本集已播放完毕", `可尝试播放第 ${nextEpisode} 集`, true);
        return;
      }
      let remainingSeconds = 5;
      const updateCountdown = () => {
        autoplayDetail.textContent = `第 ${nextEpisode} 集 · ${remainingSeconds} 秒后自动播放`;
      };
      autoplayTitle.textContent = "即将为你播放下一集";
      updateCountdown();
      autoplayActions.replaceChildren(
        makeAutoplayButton("立即播放", true, playNextEpisode),
        makeAutoplayButton("取消", false, () => {
          showEndedActions("已取消自动连播", `第 ${nextEpisode} 集等待播放`, true);
        })
      );
      autoplay.hidden = false;
      clearHongguoAutoplay();
      hongguoAutoplayTimer = setInterval(() => {
        if (
          playbackTransitionStarted ||
          hongguoState.playback !== playback ||
          hongguoState.view !== "playback"
        ) {
          clearHongguoAutoplay();
          return;
        }
        remainingSeconds -= 1;
        if (remainingSeconds <= 0) {
          playNextEpisode();
          return;
        }
        updateCountdown();
      }, 1_000);
      autoplayActions.querySelector(".primary")?.focus({ preventScroll: true });
    };
    listen(video, "ended", beginAutoplayCountdown);
    listen(video, "play", () => {
      if (!playbackTransitionStarted && !autoplay.hidden) hideAutoplay();
    });
    // 暂停状态同步到 view.dataset.paused：CSS 据此常显 chrome（与 Emby 侧一致）。
    const syncPausedState = () => { view.dataset.paused = String(video.paused); };
    listen(video, "play", syncPausedState);
    listen(video, "playing", syncPausedState);
    listen(video, "pause", syncPausedState);
    syncPausedState();
    listen(view, "keydown", (event) => {
      // 空格/左右方向键转发给 video：仅当焦点在容器本身（与 Emby 播放视图一致）。
      if (event.target === view && (event.key === " " || event.key === "ArrowLeft" || event.key === "ArrowRight")) {
        event.preventDefault();
        event.stopPropagation();
        if (event.key === " ") {
          if (video.paused) video.play().catch(() => {});
          else video.pause();
        } else {
          const delta = event.key === "ArrowRight" ? 5 : -5;
          const duration = Number(video.duration);
          video.currentTime = Math.max(
            0,
            Math.min(Number.isFinite(duration) ? duration : Infinity, Number(video.currentTime || 0) + delta)
          );
        }
        return;
      }
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      back.click();
    });
    view.append(video, chrome, status, autoplay);
    setTimeout(async () => {
      if (!view.isConnected) return;
      view.focus({ preventScroll: true });
      try {
        if (playback.externalSource) {
          video.src = playback.externalSource;
          status.hidden = true;
          video.load();
        } else await configureHongguoDirectMp4(video, playback, status);
        // 自动起播：此前红果播放视图从头到尾没有 play() 调用——首次打开和自动
        // 连播都停在首帧等用户手点（Emby 侧有 activatePlaybackState 自动起播）。
        // 若浏览器按自动播放策略拒绝则静默兜底，用户仍可手动点播。
        if (isDisposed() || hongguoState.playback !== playback) return;
        void video.play().catch(() => {});
      } catch (errorValue) {
        if (hongguoState.playback !== playback || hongguoState.view !== "playback") return;
        const drama = hongguoState.selectedDrama;
        const episode = Number(playback?.episode);
        showHongguoError(
          errorValue,
          drama ? "detail" : "home",
          drama?.id && episode > 0 ? () => beginHongguoPlayback(drama, episode) : null
        );
      }
    }, 0);
    return view;
  };

  const renderHongguoError = () => {
    const view = makeElement("div", "hg-view hg-center");
    view.dataset.view = "error";
    const sourceUnavailable = hongguoState.error?.code === "VIDEO_SOURCE_UNAVAILABLE";
    view.append(
      makeElement("div", "hg-error-title", sourceUnavailable ? "该短剧线路暂不可用" : "短剧内容暂时不可用"),
      makeElement("div", "hg-muted", hongguoState.error?.message || "请稍后重试")
    );
    const actions = makeElement("div", "hg-error-actions");
    const retry = makeElement("button", "hg-button primary", "重试");
    retry.type = "button";
    listen(retry, "click", () => {
      const action = hongguoState.retryAction;
      hongguoState.retryAction = null;
      if (action) void action();
    });
    retry.hidden = !hongguoState.error?.retryable || !hongguoState.retryAction;
    const back = makeElement("button", "hg-button", "返回");
    back.type = "button";
    listen(back, "click", () => {
      hongguoState.view = hongguoState.errorReturnView === "detail" && hongguoState.selectedDrama ? "detail" : "home";
      renderHongguo();
    });
    actions.append(retry, back);
    view.append(actions);
    return view;
  };

  const renderHongguo = () => {
    if (isDisposed()) return;
    let view;
    if (hongguoState.view === "home") view = renderHongguoHome();
    else if (hongguoState.view === "detail") view = renderHongguoDetail();
    else if (hongguoState.view === "playback") view = renderHongguoPlayback();
    else if (hongguoState.view === "error") view = renderHongguoError();
    else view = renderHongguoLoading();
    hongguoApp.replaceChildren(view);
    restoreHongguoScroll();
  };

  const loadMoreHongguo = async () => {
    if (
      isDisposed()
      || hongguoState.view !== "home"
      || hongguoState.feedLoading
      || !hongguoState.feedHasMore
      || !hongguoState.feedCursor
    ) return;
    hongguoState.feedLoading = true;
    hongguoState.feedError = null;
    const status = hongguoApp.querySelector('[data-feed-status="true"]');
    if (status) status.textContent = "正在加载更多…";
    const cursor = hongguoState.feedCursor;
    const request = requestRpc("hongguo.feed.next", { cursor, limit: 20 }, { timeoutMs: 15_000 });
    hongguoFeedRequestId = request.id;
    try {
      const result = await request.promise;
      if (isDisposed() || hongguoFeedRequestId !== request.id || hongguoState.feedCursor !== cursor) return;
      hongguoFeedRequestId = null;
      const existing = new Set(hongguoState.featured.map((item) => item.id));
      const incoming = Array.isArray(result?.items) ? result.items.filter((item) => !existing.has(item?.id)) : [];
      rememberHongguoScroll();
      hongguoState.featured.push(...incoming);
      hongguoState.feedCursor = result?.cursor || null;
      hongguoState.feedHasMore = result?.hasMore === true && Boolean(result?.cursor);
      hongguoState.feedTotal = Math.max(hongguoState.feedTotal, Number(result?.total) || 0);
      hongguoState.feedLoading = false;
      hongguoState.feedError = null;
      renderHongguo();
    } catch (errorValue) {
      if (hongguoFeedRequestId !== request.id) return;
      hongguoFeedRequestId = null;
      hongguoState.feedLoading = false;
      const error = toRpcError(errorValue);
      if (error.code === "FEED_EXPIRED") {
        void loadHongguoHome();
        return;
      }
      hongguoState.feedError = error.message;
      if (hongguoState.view === "home") renderHongguo();
    }
  };

  const loadHongguoHome = async ({ automatic = false } = {}) => {
    if (!automatic) {
      if (hongguoHomeRetryTimer !== null) clearTimeout(hongguoHomeRetryTimer);
      hongguoHomeRetryTimer = null;
      hongguoHomeRetryAttempt = 0;
    }
    hongguoState.loadingLabel = "正在加载短剧内容…";
    hongguoState.view = "loading";
    renderHongguo();
    const applyHomeResult = (result) => {
      hongguoState.featured = Array.isArray(result?.items)
        ? result.items
        : Array.isArray(result?.featured) ? result.featured : [];
      hongguoState.feedCursor = result?.cursor || null;
      hongguoState.feedHasMore = result?.hasMore === true && Boolean(result?.cursor);
      hongguoState.feedTotal = Number(result?.total) || hongguoState.featured.length;
      hongguoState.feedLoading = false;
      hongguoState.feedError = null;
      hongguoState.error = null;
      hongguoState.retryAction = null;
      hongguoState.view = "home";
      if (hongguoHomeRetryTimer !== null) clearTimeout(hongguoHomeRetryTimer);
      hongguoHomeRetryTimer = null;
      hongguoHomeRetryAttempt = 0;
      renderHongguo();
    };
    try {
      const result = await rpc("hongguo.home", { limit: 20 }, { timeoutMs: 30_000 });
      if (isDisposed()) return;
      applyHomeResult(result);
      if (result?.cacheStatus === "stale") {
        // stale 数据先上屏，后台刷新完成后替换并重渲染 —— 此前完全忽略 cacheStatus，
        // 刷新结果要等下次挂载才生效（旧封面/已下架内容会一直挂着）。对齐 Emby 侧
        // loadHome 的 stale→refresh→二次渲染 模式。
        void rpc("hongguo.home", { limit: 20, refresh: true }, { timeoutMs: 30_000 }).then((refreshed) => {
          if (isDisposed()) return;
          if (Array.isArray(refreshed?.items)) {
            hongguoState.featured = refreshed.items;
            hongguoState.feedCursor = refreshed?.cursor || hongguoState.feedCursor;
            hongguoState.feedHasMore = refreshed?.hasMore === true && Boolean(refreshed?.cursor);
            hongguoState.feedTotal = Number(refreshed?.total) || hongguoState.feedTotal;
          }
          // 用户已离开首页（详情/播放）时只更新数据，不重渲染抢视图。
          if (hongguoState.view === "home") renderHongguo();
        }).catch(() => {});
      }
    } catch (errorValue) {
      showHongguoError(errorValue, "home", loadHongguoHome);
      const error = toRpcError(errorValue);
      const delays = [1_500, 4_000, 10_000, 30_000];
      if (!isDisposed() && error.retryable && hongguoHomeRetryAttempt < delays.length) {
        const delay = delays[hongguoHomeRetryAttempt++];
        if (hongguoHomeRetryTimer !== null) clearTimeout(hongguoHomeRetryTimer);
        hongguoHomeRetryTimer = setTimeout(() => {
          hongguoHomeRetryTimer = null;
          void loadHongguoHome({ automatic: true });
        }, delay);
      }
    }
  };

  const loadHongguoList = async () => {
    try {
      const result = await rpc("hongguo.list.get", {}, { timeoutMs: 15_000 });
      if (isDisposed()) return;
      hongguoState.listItems = Array.isArray(result?.items) ? result.items : [];
      if (hongguoState.view === "home") renderHongguo();
    } catch {
      // 片单加载失败不影响首页其余内容
    }
  };

  const addToHongguoList = async (item) => {
    if (!item?.id) return;
    try {
      const result = await rpc("hongguo.list.add", {
        id: String(item.id),
        name: item.name || "",
        posterUrl: item.posterUrl || ""
      }, { timeoutMs: 15_000 });
      if (isDisposed()) return;
      hongguoState.listItems = Array.isArray(result?.items) ? result.items : hongguoState.listItems;
    } catch {
      // 加入片单失败静默：不打断播放/浏览
    }
  };

  const removeFromHongguoList = async (id) => {
    try {
      const result = await rpc("hongguo.list.remove", { id: String(id) }, { timeoutMs: 15_000 });
      if (isDisposed()) return;
      hongguoState.listItems = Array.isArray(result?.items) ? result.items : hongguoState.listItems;
      if (hongguoState.view === "home") renderHongguo();
    } catch {
      // 忽略
    }
  };

  // 通过剧集 ID 直达：拉详情，成功则进入详情页并自动加入片单。
  const openHongguoById = (id) => {
    const dramaId = String(id ?? "").trim();
    if (!/^[0-9]{1,32}$/.test(dramaId)) {
      showHongguoError(rpcError("INVALID_DRAMA_ID", "请输入有效的剧集 ID（纯数字）"), "home");
      return Promise.resolve();
    }
    return openHongguoDetail({ id: dramaId });
  };

  const openHongguoDetail = async (item) => {
    if (!item?.id) return;
    rememberHongguoScroll();
    const originView = "home";
    hongguoState.loadingLabel = "正在读取选集…";
    hongguoState.view = "loading";
    renderHongguo();
    try {
      const drama = await rpc("hongguo.detail", { dramaId: item.id }, { timeoutMs: 25_000 });
      if (isDisposed()) return;
      hongguoState.selectedDrama = { ...item, ...drama };
      hongguoState.detailReturnView = originView;
      hongguoState.error = null;
      hongguoState.view = "detail";
      renderHongguo();
      // 打开成功即收藏进片单（下次首页直接可点，无需重输 ID）
      void addToHongguoList(hongguoState.selectedDrama);
    } catch (errorValue) {
      showHongguoError(errorValue, originView, () => openHongguoDetail(item));
    }
  };

  const beginHongguoPlayback = async (drama, episode) => {
    if (!drama?.id) {
      showHongguoError(rpcError("DRAMA_NOT_SELECTED", "请先选择一部短剧"), "home");
      return;
    }
    stopHongguoPlayback(true);
    hongguoState.loadingLabel = `正在准备第 ${episode} 集…`;
    hongguoState.view = "loading";
    renderHongguo();
    try {
      const playback = await rpc("hongguo.playback.open", {
        dramaId: drama.id,
        episode
      }, { timeoutMs: 30_000 });
      if (isDisposed()) return;
      hongguoState.playback = {
        ...playback,
        title: `${drama.name} · 第 ${episode} 集`
      };
      hongguoState.error = null;
      hongguoState.view = "playback";
      renderHongguo();
    } catch (errorValue) {
      showHongguoError(errorValue, "detail", () => beginHongguoPlayback(drama, episode));
    }
  };

  const setVideoSource = (source) => {
    if (typeof source !== "string" || source.length === 0) throw new TypeError("source 必须是非空字符串");
    stopHongguoPlayback(true);
    hongguoState.playback = { externalSource: source, title: "外部视频" };
    hongguoState.view = "playback";
    renderHongguo();
  };

  const setVideoFile = (file) => {
    if (!(file instanceof Blob)) throw new TypeError("file 必须是 File 或 Blob");
    stopHongguoPlayback(true);
    objectUrl = createObjectURL(file);
    hongguoState.playback = { externalSource: objectUrl, title: file.name || "本地视频" };
    hongguoState.view = "playback";
    renderHongguo();
  };

  const clearVideo = () => {
    stopHongguoPlayback(true);
    hongguoState.view = hongguoState.selectedDrama ? "detail" : "home";
    renderHongguo();
  };

  const cleanupHongguo = () => {
    if (hongguoHomeRetryTimer !== null) clearTimeout(hongguoHomeRetryTimer);
    hongguoHomeRetryTimer = null;
    if (hongguoFeedRequestId) cancelRpc(hongguoFeedRequestId, true);
    hongguoFeedRequestId = null;
    stopHongguoPlayback(true);
    for (const request of hongguoImageRequests.values()) cancelRpc(request.id, true);
    hongguoImageRequests.clear();
    for (const retry of hongguoImageRetries.values()) {
      if (retry.timer !== null) clearTimeout(retry.timer);
    }
    hongguoImageRetries.clear();
    releaseHongguoImages();
  };
  const api = Object.freeze({
    getState: () => ({
      view: hongguoState.view,
      featuredCount: hongguoState.featured.length,
      feedHasMore: hongguoState.feedHasMore,
      feedTotal: hongguoState.feedTotal,
      listCount: hongguoState.listItems.length,
      selectedDramaId: hongguoState.selectedDrama?.id || null,
      playing: Boolean(hongguoState.playback),
      error: hongguoState.error?.message || null,
      diagnostics: hongguoState.playback ? {
        streamMode: hongguoState.playback.streamMode || (hongguoState.playback.externalSource ? "external" : null),
        lastError: hongguoState.playback.lastError || null
      } : null
    }),
    setVideoSource: scope.guard(setVideoSource),
    setVideoFile: scope.guard(setVideoFile),
    clearVideo: scope.guard(clearVideo),
    openById: scope.guard(openHongguoById),
    openDrama: scope.guard(openHongguoDetail),
    playEpisode: scope.guard((episode) => beginHongguoPlayback(hongguoState.selectedDrama, Number(episode)))
  });

  scope.effects.add(cleanupHongguo);
  scope.effects.add(() => shadow.replaceChildren());
  queueMicrotask(() => { void loadHongguoHome(); void loadHongguoList(); });
  return {
    api,
    updateSettings() {},
    visibilityChanged(state) {
      if (isDisposed()) return;
      if (state?.visible) refreshHongguoImages();
    },
    dispose: scope.dispose,
  };
}
