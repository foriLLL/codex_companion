import assert from "node:assert/strict";
import test from "node:test";
import { BRIDGE_KEY, HOST_ID, INJECTION_VERSION, RAIL_ID, buildInjectionSource } from "../src/injection.mjs";

test("mount 和 unmount 注入脚本都是合法 JavaScript", () => {
  const mountSource = buildInjectionSource("mount");
  assert.doesNotThrow(() => new Function(mountSource));
  assert.doesNotThrow(() => new Function(buildInjectionSource("unmount")));
  assert.match(mountSource, /codex-hg-root/);
  assert.match(mountSource, /__CODEX_HG__/);
});

test("mount 脚本保留完整红果体验并包含独立 Emby 微型应用", () => {
  const source = buildInjectionSource("mount");
  assert.match(source, new RegExp(HOST_ID));
  assert.match(source, new RegExp(RAIL_ID));
  assert.match(source, new RegExp(BRIDGE_KEY));
  assert.match(source, new RegExp(INJECTION_VERSION.replaceAll(".", "\\.")));
  assert.match(source, /attachShadow/);
  assert.match(source, /makeElement\("video", "hg-video"\)/);
  assert.match(source, /dataset\.view = "home"/);
  assert.match(source, /dataset\.view = "detail"/);
  assert.match(source, /dataset\.view = "playback"/);
  assert.match(source, /hg-search-input/);
  assert.match(source, /输入剧集 ID 打开/);
  assert.match(source, /我的片单/);
  assert.match(source, /hongguo\.list\.get/);
  assert.match(source, /hongguo\.list\.add/);
  assert.match(source, /hongguo\.list\.remove/);
  assert.doesNotMatch(source, /hongguo\.search/);
  assert.match(source, /hg-episode-grid/);
  assert.doesNotMatch(source, /class HongguoHlsLoader/);
  assert.match(source, /configureHongguoDirectMp4/);
  assert.match(source, /configureDirectMp4Stream/);
  assert.match(source, /playback\?\.streamMode === "ffmpeg-fmp4" \? 6 : 4/);
  assert.match(source, /bufferAhead\(\) >= initialBufferTarget/);
  assert.match(source, /40 \* 1024 \* 1024 \* 8/);
  assert.match(source, /bufferBudgetSeconds - backBufferSeconds/);
  assert.match(source, /const isQuotaExceeded/);
  assert.match(source, /tuneBufferForKeyframes\(initialization\?\.keyframeIntervalSeconds\)/);
  assert.match(source, /start - bufferEdgeToleranceSeconds/);
  assert.match(source, /await evictBackBuffer\(\)/);
  assert.match(source, /player\.parserComplete\.get\(trackId\) === true/);
  assert.match(source, /sourceBuffer\.abort\(\)/);
  assert.match(source, /sourceBuffer\.remove\(0, end\)/);
  assert.match(source, /flushDecoderReferences/);
  assert.match(source, /embyVideo\.currentTime = target/);
  assert.match(source, /onQuotaExceeded/);
  assert.match(source, /正在释放媒体缓存并恢复播放/);
  assert.match(source, /player\.initialSeekTarget = startTime/);
  assert.match(source, /Math\.abs\(time - initialSeekTarget\) <= bufferEdgeToleranceSeconds/);
  assert.match(source, /player\.pendingSeekTime = target/);
  assert.match(source, /player\.seekInFlight = true/);
  assert.match(source, /player\.pointerActive/);
  assert.match(source, /if \(pointerSawSeek\) seek\(Number\(embyVideo\.currentTime\) \|\| 0\)/);
  assert.match(source, /addEventListener\("pointerdown", onPointerDown\)/);
  assert.match(source, /addEventListener\("pointerup", onPointerFinished\)/);
  assert.match(source, /window\.addEventListener\("pointerup", onPointerFinished, true\)/);
  assert.match(source, /window\.removeEventListener\("pointerup", onPointerFinished, true\)/);
  assert.match(source, /if \(Number\.isFinite\(player\.pendingSeekTime\)\) return/);
  assert.match(source, /!player\.controller && !player\.seekInFlight/);
  assert.ok(
    source.indexOf("player.initialSeekTarget = startTime")
      < source.indexOf("embyVideo.currentTime = startTime"),
    "初始化关键帧对齐必须先标记内部 seek，避免 seeking 取消新媒体请求"
  );
  assert.match(source, /recoverQuotaAtKeyframe/);
  assert.match(source, /initialization\?\.keyframeTimesSeconds/);
  assert.match(source, /hongguo\.home/);
  assert.match(source, /hongguo\.detail/);
  assert.match(source, /hongguo\.playback\.open/);
  assert.match(source, /rpcPrefix: "hongguo\.playback\.direct"/);
  assert.match(source, /`\$\{rpcPrefix\}\.init`/);
  assert.match(source, /`\$\{rpcPrefix\}\.next`/);
  assert.match(source, /`\$\{rpcPrefix\}\.seek`/);
  assert.match(source, /hongguo\.playback\.stop/);
  assert.match(source, /video\.addEventListener\("ended", beginAutoplayCountdown\)/);
  assert.match(source, /即将为你播放下一集/);
  assert.match(source, /第 \$\{nextEpisode\} 集 · \$\{remainingSeconds\} 秒后自动播放/);
  assert.match(source, /makeAutoplayButton\("立即播放"/);
  assert.match(source, /makeAutoplayButton\("取消"/);
  assert.match(source, /clearHongguoAutoplay\(\)/);
  assert.match(source, /dataset\.hgImageReference/);
  assert.match(source, /refreshHongguoImages/);
  assert.match(source, /hongguoHomeRetryAttempt/);
  assert.match(source, /\[1_500, 4_000, 10_000, 30_000\]/);
  assert.match(source, /loadHongguoHome\(\{ automatic: true \}\)/);
  assert.match(source, /for \(const target of entry\.targets\) target\.src = url/);
  const hongguoImageBindingStart = source.indexOf("const bindHongguoImage");
  const hongguoImageBinding = source.slice(
    hongguoImageBindingStart,
    source.indexOf("refreshHongguoImages =", hongguoImageBindingStart)
  );
  assert.ok(
    hongguoImageBinding.indexOf("for (const target of entry.targets) target.src = url")
      < hongguoImageBinding.indexOf("trimHongguoImages()"),
    "红果 Blob URL 必须先绑定到 img，再参与缓存回收"
  );
  assert.match(source, /scheduleHongguoImageRetry\(reference, entry\.targets\)/);
  assert.match(source, /handleHongguoImageError\(img, item\.posterUrl\)/);
  assert.doesNotMatch(source, /img\.addEventListener\("error", \(\) => img\.remove\(\)\)/);
  assert.doesNotMatch(source, /globalThis\.XMLHttpRequest\s*=/);
  assert.match(source, /data-card="hongguo"/);
  assert.match(source, /data-card="emby"/);
  assert.match(source, /height: min\(400px, 48vh\)/);
  assert.match(source, /\.panel \+ \.panel \{ margin-top: 24px; \}/);
  assert.match(source, /setVideoFile/);
  assert.match(source, /setVideoSource/);
  assert.doesNotMatch(source, /dataset\.mode = "owned"/);
  assert.match(source, /placementMode = "hidden"/);
  assert.match(source, /handlePanelHidden\(\)/);
  assert.match(source, /findFloatingSummary/);
  assert.match(source, /findSummaryPopover/);
  assert.match(source, /getAttribute\("aria-controls"\)/);
  assert.match(source, /summary-popover/);
  assert.match(source, /preservePopoverPanel/);
  assert.match(source, /restorePopoverPanel/);
  assert.match(source, /style\.visibility !== "hidden"/);
  assert.match(source, /animated-summary/);
  assert.match(source, /positionAnimatedRail/);
  assert.match(source, /summary\.mountParent\.append\(rail\)/);
  assert.match(source, /"aria-expanded", "aria-controls", "data-state"/);
  assert.match(source, /document\.getElementById\(railId\)\?\.remove\(\)/);
  assert.match(source, /--color-token-dropdown-background/);
  assert.match(source, /--color-token-text-tertiary/);
  assert.match(source, /--hg-panel-shadow/);
  assert.match(source, /getComputedStyle\(nativeSection, "::after"\)/);
  assert.match(source, /\.hg-toolbar,\s*\.emby-toolbar/);
  assert.match(source, /padding: 10px 10px 2px 14px/);
  assert.match(source, /\.hg-toolbar::after,\s*\.emby-toolbar::after/);
  assert.match(source, /right: 14px;\s*bottom: 0;\s*left: 14px/);
  assert.match(source, /font-weight: var\(--hg-font-weight, 445\)/);
  assert.match(source, /toolbarIconPaths/);
  assert.match(source, /makeIconButton\("搜索媒体", "search"/);
  assert.match(source, /makeIconButton\("退出 Emby", "logout"/);
  assert.match(source, /"切换 Emby 服务器", "servers"/);
  assert.match(source, /rpc\("servers\.switch"/);
  assert.match(source, /rpc\("servers\.list"/);
  assert.match(source, /rpc\("servers\.remove"/);
  assert.match(source, /rpc\("library\.get"/);
  assert.match(source, /"媒体库"/);
  assert.doesNotMatch(source, /[⌕↪]/);
  assert.match(source, /configureOuterScroller/);
  assert.match(source, /setProperty\("overflow-y", "auto", "important"\)/);
  assert.match(source, /data-codex-companion-scroll-root/);
  assert.match(source, /restoreOuterScroller/);
  assert.match(source, /video\.disablePictureInPicture = true/);
  assert.doesNotMatch(source, /requestPictureInPicture|enterHongguoMiniPlayer|画中画播放/);
  assert.match(source, /configureAnimationColumn/);
  assert.match(source, /data-codex-companion-animation-column/);
  assert.match(source, /hongguoState\.playback !== playback \|\| hongguoState\.view !== "playback"/);
  assert.match(source, /embyState\.playback !== playback \|\| embyState\.view !== "playback"/);
  assert.match(source, /"padding:12px 16px 16px"/);
  assert.match(source, /cleanupHongguo\(\)/);
  assert.match(source, /"position:static"/);
  // host 用 position:static（不 fixed）。position:fixed 只出现在工具栏注入失败时的悬浮兜底按钮。
});

test("Emby 注入脚本包含完整状态、RPC 契约和受控媒体通道", () => {
  const source = buildInjectionSource("mount");

  for (const view of ["disconnected", "loading", "home", "search", "series", "playback", "error"]) {
    assert.match(source, new RegExp(`dataset\\.view = "${view}"`));
  }

  assert.match(source, /__CODEX_COMPANION_RPC__/);
  assert.match(source, /receiveRpc/);
  assert.match(source, /\{ id, method, params \}/);
  assert.match(source, /connection\.status/);
  assert.match(source, /auth\.login/);
  assert.match(source, /home\.get/);
  assert.match(source, /series\.get/);
  assert.match(source, /playback\.open/);
  assert.match(source, /playback\.progress/);
  assert.match(source, /playback\.stop/);
  assert.match(source, /playback\.subtitle\.load/);
  assert.match(source, /playback\.subtitle\.select/);
  assert.equal(
    source.match(/playback\.subtitle\.select"[\s\S]*?\{ timeoutMs: 65_000 \}/g)?.length,
    2
  );
  assert.match(source, /emby-subtitle-button/);
  assert.match(source, /\.emby-subtitle-status \{[\s\S]*?top: 88px;[\s\S]*?bottom: auto;/);
  assert.match(source, /emby-playback-episode-nav/);
  assert.match(source, /emby-episode-picker-button/);
  assert.match(source, /emby-episode-picker-grid/);
  assert.match(source, /播放上一集/);
  assert.match(source, /播放下一集/);
  assert.match(source, /fetchPlaybackEpisodeContext/);
  assert.match(source, /playAdjacentEpisode/);
  assert.match(source, /role", "menuitemradio"/);
  assert.match(source, /track\.kind = "subtitles"/);
  assert.match(source, /text\/vtt;charset=utf-8/);
  assert.match(source, /restorePlaybackState/);
  assert.match(source, /pendingSubtitleSelection/);
  assert.match(source, /视频准备完成后切换字幕/);
  assert.match(source, /isStopping: \(\) => playbackStopping \|\| subtitleSwitching/);
  // HLS 致命错误优先原地恢复（网络→startLoad，媒体→recoverMediaError），耗尽预算才全屏报错。
  assert.match(source, /!data\?\.fatal \|\| playbackStopping \|\| subtitleSwitching/);
  assert.match(source, /hls\.startLoad\(\)/);
  assert.match(source, /hls\.recoverMediaError\(\)/);
  assert.match(source, /HLS_FATAL/);
  assert.match(source, /rpcPrefix: "playback\.direct"/);
  assert.match(source, /"ffmpeg-fmp4"/);
  assert.match(source, /`\$\{rpcPrefix\}\.init`/);
  assert.match(source, /`\$\{rpcPrefix\}\.next`/);
  assert.match(source, /`\$\{rpcPrefix\}\.seek`/);
  assert.match(source, /timestampOffsetSeconds/);
  assert.match(source, /resource\.load/);
  assert.match(source, /rpc\.cancel/);

  // 选源功能：源 chips、按 seriesId 的偏好、beginPlayback 透传 preferredSourceKey
  assert.match(source, /emby-source-chips/);
  assert.match(source, /emby-source-chip/);
  assert.match(source, /rememberSourcePreference/);
  assert.match(source, /preferredSourceKey/);
  assert.match(source, /sourceOptions\.length > 1/);
  assert.match(source, /option\.recommended/);

  // 兼容 MP4 优先通过 blob 子文档中的原生 video 读取 loopback 持续 Range；
  // 主文档 MSE 仍作为代理不可用时的后备路径。
  assert.match(source, /playback\.directProxyUrl/);
  assert.match(source, /configureLoopbackVideoFrame/);
  assert.match(source, /emby-video-frame/);
  assert.match(source, /currentEmbyVideo/);
  assert.match(source, /URL\.createObjectURL\(new Blob/);

  assert.match(source, /class EmbyHlsLoader/);
  // Codex app:// 下直接使用受控 RPC loader；其他宿主可尝试 loopback，并在首个
  // playlist 网络错误时一次性降级。
  assert.match(source, /playback\.hlsProxyUrl/);
  assert.match(source, /url\.hostname !== "127\.0\.0\.1"/);
  assert.match(source, /location\.protocol === "app:"/);
  assert.match(source, /hlsOptions\.loader = EmbyHlsLoader/);
  assert.match(source, /playback\.hlsProxyFallback = true/);
  assert.match(source, /useHlsProxy[\s\S]*?!playback\.hlsProxyFallback[\s\S]*?data\?\.type === ErrorTypes\.NETWORK_ERROR/);
  assert.match(source, /useHlsProxy \? hlsProxyUrl : playback\.hlsUrl/);
  assert.match(source, /maxBufferLength: 30/);
  assert.match(source, /backBufferLength: 15/);
  assert.match(source, /maxBufferSize: 24 \* 1024 \* 1024/);
  assert.match(source, /capLevelToPlayerSize: true/);
  assert.match(source, /Number\(level\?\.height \|\| 0\) <= 720/);
  assert.match(source, /new MediaSource\(\)/);
  assert.match(source, /MediaSource\.isTypeSupported/);
  assert.match(source, /bufferAhead\(\) >= maxForwardBufferSeconds/);
  assert.match(source, /currentTime\) \|\| 0\) - retainedSeconds/);
  assert.match(source, /object-fit: contain/);
  assert.match(source, /resourceType: "hls"/);
  assert.doesNotMatch(source, /\bfetch\s*\(/);
});

test("Emby 清理路径覆盖计时器、HLS、RPC 和对象 URL", () => {
  const source = buildInjectionSource("mount");
  assert.match(source, /clearInterval\(progressTimer\)/);
  assert.match(source, /activeHls\?\.destroy\?\.\(\)/);
  assert.match(source, /activeDirectPlayer\?\.destroy\?\.\(\)/);
  assert.match(source, /cancelRpc\(requestId, true\)/);
  assert.match(source, /releaseSubtitleTrack/);
  assert.match(source, /cancelRpc\(subtitleRequestId, true\)/);
  assert.match(source, /URL\.revokeObjectURL/);
  assert.match(source, /cleanupEmby\(\)/);
});

test("拒绝未知注入动作", () => {
  assert.throws(() => buildInjectionSource("replace"), /不支持的注入动作/);
});

test("卡片开关：默认全开，可独立关闭并写入注入 config", () => {
  const defaultSource = buildInjectionSource("mount");
  assert.match(defaultSource, /"cards":\{"hongguo":true,"emby":true\}/);

  const hongguoOff = buildInjectionSource("mount", { cards: { hongguo: false } });
  assert.match(hongguoOff, /"cards":\{"hongguo":false,"emby":true\}/);

  const embyOff = buildInjectionSource("mount", { cards: { emby: false } });
  assert.match(embyOff, /"cards":\{"hongguo":true,"emby":false\}/);

  // 非布尔值一律视为开启（白名单语义），脚本仍是合法 JS
  const junk = buildInjectionSource("mount", { cards: { hongguo: "no", emby: 0 } });
  assert.match(junk, /"cards":\{"hongguo":true,"emby":true\}/);
  assert.doesNotThrow(() => new Function(hongguoOff));
});

test("卡片开关：bootstrap 按开关隐藏 section、跳过初始化，双关时装 stub", () => {
  const source = buildInjectionSource("mount");
  // 注意：断言只用在 Node 与 Bun 转译器下都稳定的子串（转译器会改写布尔字面量与空白）。
  assert.match(source, /cards\.hongguo \? "" : " hidden"/);
  assert.match(source, /cards\.emby \? "" : " hidden"/);
  assert.match(source, /cards\.hongguo[\s\S]{0,40}loadHongguoHome\(\)/);
  assert.match(source, /cards\.emby[\s\S]{0,40}initializeEmby\(\)/);
  assert.match(source, /\.panel\[hidden\]/);
  assert.match(source, /cards-disabled/);
  assert.match(source, /cardsKey/);
});

test("placement：standalone 模式输出并排按钮与三态互斥逻辑", () => {
  const source = buildInjectionSource("mount", { placement: "standalone-button" });
  // 断言 ASCII token（bun 的 .toString() 会把非 ASCII 转义、压缩内部标识符）。
  assert.match(source, /"placement":"standalone-button"/);
  assert.match(source, /aria-pressed/);
  // 互斥：面板开着但用户没要卡片时不占用面板 → 记为 native-summary
  assert.match(source, /native-summary/);
  // 卡片显示时点原生 Toggle Summary 应原地切到摘要（捕获阶段拦截），而不是关成空白。
  assert.match(source, /onNativeTriggerCapture/);
  assert.match(source, /stopImmediatePropagation/);
  // 原生工具栏结构不匹配时挂悬浮兜底按钮，保证卡片始终可唤出。
  assert.match(source, /ensureFallbackButton/);
  assert.doesNotThrow(() => new Function(source));
});

test("placement：inline 模式不插按钮，走旧行为", () => {
  const source = buildInjectionSource("mount", { placement: "inline-in-summary" });
  assert.match(source, /"placement":"inline-in-summary"/);
  assert.doesNotThrow(() => new Function(source));
});

test("placement：默认 standalone；非法值回退 standalone", () => {
  assert.match(buildInjectionSource("mount"), /"placement":"standalone-button"/);
  assert.match(buildInjectionSource("mount", { placement: "bogus" }), /"placement":"standalone-button"/);
});

test("findSummaryToggle：多语言与结构信号（不依赖英文字面量）", () => {
  const source = buildInjectionSource("mount");
  // 断言 ASCII 多语言文案与结构信号（bun 的 .toString() 会转义非 ASCII，故用拉丁文案与 dialog）。
  assert.match(source, /zusammenfassung/); // de：验证多语言词表存在
  assert.match(source, /resumen/);         // es
  assert.match(source, /"dialog"/);        // aria-controls→dialog 结构信号
});
