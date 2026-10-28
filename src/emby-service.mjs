import { videoColorInfo } from "./video-color.mjs";
import { SubtitleLoader, extractSubtitleWindow, SUBTITLE_WINDOW_SECONDS } from "./subtitle-loader.mjs";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { assToWebVtt } from "./ass-to-vtt.mjs";
import {
  DEFAULT_RESOURCE_LIMIT,
  DEFAULT_SUBTITLE_LIMIT,
  EMBY_USER_AGENT,
  EmbyClient,
  EmbyError,
  assertLoginHostAllowed,
  embyAuthorizationHeader,
  normalizeServerUrl,
  redactSensitive,
  sanitizeDirectStreamUrl,
  validateExternalMediaUrl,
  validateSameOriginResource
} from "./emby-client.mjs";
import { DirectMp4Session } from "./direct-mp4-session.mjs";
import { EmbyStorage, embyServerKey } from "./emby-storage.mjs";
import {
  FfmpegFmp4Session,
  ffmpegStrategy,
  mediaSourceExceedsDirectBitrate,
  videoBitrateFor
} from "./ffmpeg-fmp4-session.mjs";
import { resolveFfmpegPath } from "./ffmpeg-path.mjs";
import { HlsProxy } from "./hls-proxy.mjs";
import { toMediaInterceptUrl } from "./media-intercept.mjs";

const DEFAULT_METADATA_TIMEOUT_MS = 12_000;
const DEFAULT_METADATA_ATTEMPTS = 2;
const DEFAULT_PLAYBACK_EVENT_TIMEOUT_MS = 3_000;
const HOME_CACHE_FRESH_MS = 5 * 60 * 1000;
const HOME_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BURN_IN_SUBTITLE_BYTES = 32 * 1024 * 1024;
const MAX_HLS_MANIFEST_BYTES = 1024 * 1024;

function asItems(response) {
  if (Array.isArray(response)) return response;
  return Array.isArray(response?.Items) ? response.Items : [];
}

function numberOrUndefined(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

export function secondsToTicks(seconds) {
  const number = Number(seconds);
  return Number.isFinite(number) && number >= 0 ? Math.round(number * 10_000_000) : 0;
}

export function mapEmbyItem(item, client) {
  const userData = item?.UserData ?? {};
  const imageOwnerId = item?.ImageTags?.Primary
    ? item.Id
    : (item?.SeriesPrimaryImageTag && item?.SeriesId ? item.SeriesId : null);
  const imageTag = item?.ImageTags?.Primary ?? item?.SeriesPrimaryImageTag;
  const backdropOwnerId = item?.BackdropImageTags?.length > 0
    ? item.Id
    : (item?.ParentBackdropImageTags?.length > 0 ? item.ParentBackdropItemId : null);
  const backdropTag = item?.BackdropImageTags?.[0] ?? item?.ParentBackdropImageTags?.[0];
  const runtimeTicks = numberOrUndefined(item?.RunTimeTicks);
  const positionTicks = numberOrUndefined(userData.PlaybackPositionTicks) ?? 0;
  const computedProgress = runtimeTicks > 0 ? (positionTicks / runtimeTicks) * 100 : 0;
  const reportedProgress = numberOrUndefined(userData.PlayedPercentage);

  const dto = {
    id: String(item?.Id ?? ""),
    name: String(item?.Name ?? "未命名"),
    type: String(item?.Type ?? "Video"),
    collectionType: item?.CollectionType ? String(item.CollectionType) : undefined,
    seriesId: item?.SeriesId ? String(item.SeriesId) : undefined,
    seriesName: item?.SeriesName ? String(item.SeriesName) : undefined,
    seasonId: item?.SeasonId ? String(item.SeasonId) : undefined,
    indexNumber: numberOrUndefined(item?.IndexNumber),
    parentIndexNumber: numberOrUndefined(item?.ParentIndexNumber),
    productionYear: numberOrUndefined(item?.ProductionYear),
    runtimeTicks,
    imageUrl: imageOwnerId
      ? client.imageUrl(imageOwnerId, { type: "Primary", maxWidth: 300, maxHeight: 450, tag: imageTag })
      : undefined,
    backdropUrl: backdropOwnerId
      ? client.imageUrl(backdropOwnerId, { type: "Backdrop", maxWidth: 600, maxHeight: 338, tag: backdropTag })
      : undefined,
    progressPercent: Math.max(0, Math.min(100, reportedProgress ?? computedProgress)),
    positionTicks,
    played: Boolean(userData.Played)
  };
  if (["CollectionFolder", "Folder", "UserView", "BoxSet", "Playlist"].includes(dto.type)) {
    dto.isFolder = true;
  }
  const childCount = numberOrUndefined(item?.ChildCount);
  if (childCount !== undefined) dto.childCount = childCount;
  return Object.fromEntries(Object.entries(dto).filter(([, value]) => value !== undefined));
}

function mapSeason(item, client) {
  const mapped = mapEmbyItem(item, client);
  return {
    id: mapped.id,
    name: mapped.name,
    indexNumber: mapped.indexNumber,
    imageUrl: mapped.imageUrl
  };
}

const STYLED_SUBTITLE_CODECS = new Set(["ass", "ssa"]);

function needsLocalSubtitleFile(subtitle) {
  return subtitle?.mode === "burn-in"
    && (subtitle.isExternal || STYLED_SUBTITLE_CODECS.has(subtitle.codec));
}

export function mapSubtitleStreams(mediaSource) {
  const streams = Array.isArray(mediaSource?.MediaStreams) ? mediaSource.MediaStreams : [];
  return streams
    .filter((stream) => String(stream?.Type ?? "").toLowerCase() === "subtitle")
    .map((stream) => {
      const index = Number(stream?.Index);
      if (!Number.isSafeInteger(index) || index < 0) return null;
      const codec = String(stream?.Codec ?? "").toLowerCase();
      const language = String(stream?.DisplayLanguage ?? stream?.Language ?? "").trim();
      const label = String(stream?.DisplayTitle ?? stream?.Title ?? language ?? "").trim()
        || `字幕 ${index}`;
      // 部分 Emby 版本会把内嵌 ASS 错标为非文字字幕。编码本身比该布尔字段可靠：
      // ASS/SSA 在 Node 侧转为 WebVTT，避免仅为字幕重编码整段 4K 视频。
      const isText = stream?.IsTextSubtitleStream === true || STYLED_SUBTITLE_CODECS.has(codec);
      return {
        index,
        label,
        language: language || "und",
        codec: codec || "unknown",
        isDefault: stream?.IsDefault === true,
        isForced: stream?.IsForced === true,
        isHearingImpaired: stream?.IsHearingImpaired === true,
        isExternal: stream?.IsExternal === true,
        mode: isText ? "external-vtt" : "burn-in"
      };
    })
    .filter(Boolean);
}

export function defaultSubtitleIndex(mediaSource, subtitles) {
  const rawConfigured = mediaSource?.DefaultSubtitleStreamIndex;
  if (rawConfigured !== null && rawConfigured !== undefined) {
    const configured = Number(rawConfigured);
    if (Number.isSafeInteger(configured) && subtitles.some((subtitle) => subtitle.index === configured)) {
      return configured;
    }
  }
  return subtitles.find((subtitle) => subtitle.isForced)?.index ?? null;
}

// 渲染层随 playback.open 传入的字幕偏好：与 injection.mjs preferredSubtitleIndex 同
// 规则——精确匹配 language+forced+hearingImpaired，退化为仅 language；{off:true} 表示
// 关字幕。open 时一次选好，避免 renderer 拿到默认选择后再串行 select 一次
// （burn-in 偏好会让转码/ffmpeg 会话开了废、废了开，首帧翻倍）。
export function preferredSubtitleIndexFromPreference(subtitles, preference) {
  if (!preference || typeof preference !== "object") return undefined;
  if (preference.off === true) return null;
  const language = typeof preference.language === "string" && preference.language
    ? preference.language
    : null;
  if (!language) return undefined;
  const exact = subtitles.find((subtitle) => (
    subtitle.language === language
    && Boolean(subtitle.isForced) === Boolean(preference.isForced)
    && Boolean(subtitle.isHearingImpaired) === Boolean(preference.isHearingImpaired)
  ));
  return (exact ?? subtitles.find((subtitle) => subtitle.language === language))?.index;
}

function mediaSourceContainer(mediaSource) {
  return String(mediaSource?.Container ?? "").toLowerCase();
}

function mediaSourceVideoStream(mediaSource) {
  const streams = Array.isArray(mediaSource?.MediaStreams) ? mediaSource.MediaStreams : [];
  return streams.find((stream) => String(stream?.Type ?? "").toLowerCase() === "video") ?? null;
}

// DirectMp4Session 会把媒体源内的全部音视频轨道写入同一个 MSE MIME。
// Renderer 稳定支持的直连交集只有单路 H.264 + 至多单路 AAC；HEVC、EC-3、
// 多音轨以及超过本机 MSE/CDP 安全吞吐的超高码率源，必须先交给 FFmpeg
// 规整/降码率，否则会在浏览器端失败或持续缓冲，且来不及自动降级。
export function mediaSourceSupportsRendererFmp4(mediaSource) {
  const streams = Array.isArray(mediaSource?.MediaStreams) ? mediaSource.MediaStreams : [];
  const videos = streams.filter((stream) => String(stream?.Type ?? "").toLowerCase() === "video");
  const audios = streams.filter((stream) => String(stream?.Type ?? "").toLowerCase() === "audio");
  if (videos.length !== 1 || audios.length > 1) return false;
  const videoCodec = String(videos[0]?.Codec ?? "").toLowerCase();
  const videoBitDepth = Number(videos[0]?.BitDepth);
  const audioCodec = String(audios[0]?.Codec ?? "").toLowerCase();
  return !videoColorInfo(mediaSource).requiresToneMapping
    && ["h264", "avc", "avc1"].includes(videoCodec)
    && (!Number.isFinite(videoBitDepth) || videoBitDepth <= 8)
    && (audios.length === 0 || ["aac", "mp4a"].includes(audioCodec))
    && !mediaSourceExceedsDirectBitrate(mediaSource);
}

function mediaSourceHasSubtitles(mediaSource) {
  const streams = Array.isArray(mediaSource?.MediaStreams) ? mediaSource.MediaStreams : [];
  return streams.some((stream) => String(stream?.Type ?? "").toLowerCase() === "subtitle");
}

// 源的画质高度：优先取视频流分辨率，回退到版本 Name 里的分辨率档，再回退码率。
function mediaSourceHeight(mediaSource) {
  const video = mediaSourceVideoStream(mediaSource);
  const height = Number(video?.Height);
  if (Number.isSafeInteger(height) && height > 0) return height;
  const name = String(mediaSource?.Name ?? "");
  if (/\b(4k|2160p?)\b/i.test(name)) return 2160;
  const match = /\b(\d{3,4})p\b/i.exec(name);
  if (match) return Number(match[1]);
  return 0;
}

function mediaSourceBitrate(mediaSource) {
  const video = mediaSourceVideoStream(mediaSource);
  const bitrate = Number(video?.BitRate ?? mediaSource?.Bitrate);
  return Number.isFinite(bitrate) && bitrate > 0 ? bitrate : 0;
}

function mediaSourceResolutionRank(mediaSource) {
  const height = mediaSourceHeight(mediaSource);
  if (Number(mediaSourceVideoStream(mediaSource)?.Width) >= 3800) return 2160;
  // 同一画质档里的轻微裁边（2160 / 2232）不应压过播放成本；用户看到的都是 4K。
  if (height >= 2000) return 2160;
  return height;
}

function mediaSourcePlaybackMode(mediaSource) {
  if (
    mediaSource?.SupportsTranscoding === true
    || (typeof mediaSource?.TranscodingUrl === "string" && mediaSource.TranscodingUrl.length > 0)
  ) return "hls";
  const supportsDirect = mediaSource?.SupportsDirectPlay === true || mediaSource?.SupportsDirectStream === true;
  const hasDirectUrl = typeof mediaSource?.DirectStreamUrl === "string" && mediaSource.DirectStreamUrl.length > 0;
  if (!supportsDirect || !hasDirectUrl) return null;
  const container = mediaSourceContainer(mediaSource);
  return ["mp4", "m4v", "mov"].includes(container) && mediaSourceSupportsRendererFmp4(mediaSource)
    ? "direct-mp4"
    : "ffmpeg-fmp4";
}

function estimatedPlaybackCost(mediaSource, { localFfmpegAvailable = true } = {}) {
  const mode = mediaSourcePlaybackMode(mediaSource);
  if (!mode) return Number.POSITIVE_INFINITY;
  // EmbyClient 的 HLS 请求上限固定为 8 Mbps；服务端转码不占本机输入 + 输出两条链路。
  if (mode === "hls") return 8_000_000;

  const inputBitrate = mediaSourceBitrate(mediaSource);
  const knownInputBitrate = inputBitrate > 0 ? inputBitrate : 40_000_000;
  if (mode === "direct-mp4") return knownInputBitrate;
  if (!localFfmpegAvailable) return Number.MAX_SAFE_INTEGER;

  // 本机 FFmpeg 路径同时搬运“服务器→FFmpeg”的输入和“FFmpeg→Renderer”的输出。
  // copy 时二者近似同码率；重编码时输出按实际 VideoToolbox 档位估算。按总数据成本
  // 排序能避开“35 Mbps 直放卡顿，却把同一 35 Mbps 再转一次而更慢”的错误决策。
  const strategy = ffmpegStrategy(mediaSource);
  const outputBitrate = strategy.copyVideo
    ? knownInputBitrate
    : Number(videoBitrateFor(mediaSource));
  return knownInputBitrate + (Number.isFinite(outputBitrate) ? outputBitrate : knownInputBitrate);
}

function mseBitrateFor(mediaSource, streamMode, subtitle = null) {
  const sourceBitrate = mediaSourceBitrate(mediaSource);
  if (streamMode !== "ffmpeg-fmp4") return sourceBitrate || undefined;
  const strategy = ffmpegStrategy(mediaSource, subtitle);
  if (strategy.copyVideo) return sourceBitrate || undefined;
  const encodedBitrate = Number(videoBitrateFor(mediaSource));
  return Number.isFinite(encodedBitrate) && encodedBitrate > 0 ? encodedBitrate : undefined;
}

// 归一化的分辨率档（跨集稳定；码率数字会微调，这里丢弃）。
function resolutionLabel(mediaSource) {
  const height = mediaSourceResolutionRank(mediaSource);
  if (height >= 2000) return "4K";
  if (height > 0) return `${height}p`;
  return "SD";
}

// 跨集稳定键：源 Id 每集不同，用「分辨率档|容器|序号」组合。
// 序号兜底同档同容器的重名（如两个 1080p mkv）。
export function computeSourceKey(mediaSource, ordinal = 0) {
  const resolution = resolutionLabel(mediaSource).toLowerCase();
  const container = mediaSourceContainer(mediaSource) || "unknown";
  return `${resolution}|${container}#${ordinal}`;
}

// 枚举给前端展示的源选项。
export function mapMediaSourceOption(mediaSource, ordinal = 0) {
  const resolution = resolutionLabel(mediaSource);
  const container = mediaSourceContainer(mediaSource) || "unknown";
  const video = mediaSourceVideoStream(mediaSource);
  const codec = String(video?.Codec ?? "").toUpperCase();
  const hasSubtitles = mediaSourceHasSubtitles(mediaSource);
  const labelParts = [resolution, container.toUpperCase()];
  if (codec) labelParts.push(codec);
  const color = videoColorInfo(mediaSource);
  if (color.requiresToneMapping) labelParts.push(color.label);
  return {
    sourceKey: computeSourceKey(mediaSource, ordinal),
    label: labelParts.filter(Boolean).join(" "),
    container,
    resolution,
    hasSubtitles
  };
}

export function mapMediaSourceOptions(mediaSources, { localFfmpegAvailable = true } = {}) {
  const list = Array.isArray(mediaSources) ? mediaSources : [];
  const recommendedOrdinal = pickMediaSource(list, { localFfmpegAvailable }).ordinal;
  return list.map((source, ordinal) => ({
    ...mapMediaSourceOption(source, ordinal),
    recommended: ordinal === recommendedOrdinal
  }));
}

// 选源优先级：
// 1. 传入的 preferredSourceKey 命中（跨集稳定键）→ 强制用它。
// 2. 有字幕源时仍只在有字幕源中选，避免默认字幕消失。
// 3. 先保留最高分辨率档；同档优先逐行源，再按端到端播放成本选择。
//    这会在 35 Mbps H.264 直放与 11 Mbps HEVC 硬件转码之间选择后者，
//    但在没有 FFmpeg 时回退可直放源；不再依赖 Emby 返回顺序或盲选最高码率。
// 返回 { mediaSource, ordinal }。
export function pickMediaSource(mediaSources, {
  preferredSourceKey = null,
  localFfmpegAvailable = true
} = {}) {
  const list = Array.isArray(mediaSources) ? mediaSources : [];
  if (list.length === 0) return { mediaSource: undefined, ordinal: -1 };

  if (preferredSourceKey) {
    const ordinal = list.findIndex((source, index) => computeSourceKey(source, index) === preferredSourceKey);
    if (ordinal >= 0) return { mediaSource: list[ordinal], ordinal };
  }

  const playable = list
    .map((source, ordinal) => ({ source, ordinal }))
    .filter(({ source }) => {
      const mode = mediaSourcePlaybackMode(source);
      return mode && (mode !== "ffmpeg-fmp4" || localFfmpegAvailable);
    });
  if (playable.length === 0) return { mediaSource: undefined, ordinal: -1 };

  const subtitled = playable.filter(({ source }) => mediaSourceHasSubtitles(source));
  const candidates = subtitled.length > 0 ? subtitled : playable;
  const highestResolution = Math.max(...candidates.map(({ source }) => mediaSourceResolutionRank(source)));
  const highestQuality = candidates.filter(({ source }) => (
    mediaSourceResolutionRank(source) === highestResolution
  ));
  highestQuality.sort((a, b) => {
    const aInterlaced = mediaSourceVideoStream(a.source)?.IsInterlaced === true ? 1 : 0;
    const bInterlaced = mediaSourceVideoStream(b.source)?.IsInterlaced === true ? 1 : 0;
    if (aInterlaced !== bInterlaced) return aInterlaced - bInterlaced;
    const byCost = estimatedPlaybackCost(a.source, { localFfmpegAvailable })
      - estimatedPlaybackCost(b.source, { localFfmpegAvailable });
    if (byCost !== 0) return byCost;
    const byBitrate = mediaSourceBitrate(a.source) - mediaSourceBitrate(b.source);
    return byBitrate || a.ordinal - b.ordinal;
  });
  return { mediaSource: highestQuality[0].source, ordinal: highestQuality[0].ordinal };
}


function requiredString(params, key, message) {
  const value = params?.[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new EmbyError("INVALID_PARAMS", message ?? `缺少参数 ${key}`);
  }
  return value.trim();
}

function playbackEventName(value, isPaused) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "pause") return isPaused ? "Pause" : "Unpause";
  if (normalized === "play" || normalized === "unpause") return "Unpause";
  if (normalized === "volume" || normalized === "volumechange") return "VolumeChange";
  return "TimeUpdate";
}

export function toRpcError(error, secrets = []) {
  const normalized = error instanceof EmbyError
    ? error
    : new EmbyError("INTERNAL_ERROR", "Emby 操作失败", { cause: error });
  return {
    code: normalized.code,
    message: redactSensitive(normalized.message, secrets),
    retryable: Boolean(normalized.retryable)
  };
}

export class EmbyService {
  constructor({
    storage = new EmbyStorage(),
    fetchImpl = globalThis.fetch,
    clientFactory,
    directSessionFactory,
    ffmpegSessionFactory,
    subtitleWindowImpl = extractSubtitleWindow,
    hlsProxyFactory,
    randomUUIDImpl = randomUUID,
    logger = null,
    resourceLimit = DEFAULT_RESOURCE_LIMIT,
    metadataTimeoutMs = DEFAULT_METADATA_TIMEOUT_MS,
    metadataAttempts = DEFAULT_METADATA_ATTEMPTS,
    playbackEventTimeoutMs = DEFAULT_PLAYBACK_EVENT_TIMEOUT_MS,
    ffmpegAvailable,
    loginHostGuard = assertLoginHostAllowed,
    now = Date.now
  } = {}) {
    if (!Number.isFinite(metadataTimeoutMs) || metadataTimeoutMs <= 0) {
      throw new TypeError("metadataTimeoutMs 必须是正数");
    }
    if (!Number.isSafeInteger(metadataAttempts) || metadataAttempts < 1) {
      throw new TypeError("metadataAttempts 必须是正整数");
    }
    if (!Number.isFinite(playbackEventTimeoutMs) || playbackEventTimeoutMs <= 0) {
      throw new TypeError("playbackEventTimeoutMs 必须是正数");
    }
    this.storage = storage;
    this.fetchImpl = fetchImpl;
    this.clientFactory = clientFactory ?? ((options) => new EmbyClient({ ...options, fetchImpl: this.fetchImpl, resourceLimit }));
    this.directSessionFactory = directSessionFactory ?? ((options) => new DirectMp4Session(options));
    this.ffmpegSessionFactory = ffmpegSessionFactory ?? ((options) => new FfmpegFmp4Session(options));
    this.subtitleWindowImpl = subtitleWindowImpl;
    this.ffmpegAvailable = typeof ffmpegAvailable === "boolean"
      ? ffmpegAvailable
      : (typeof ffmpegSessionFactory === "function" || Boolean(resolveFfmpegPath()));
    // Emby 本地媒体代理：HLS 在 CSP 允许的宿主可走 loopback；原生 MP4 经 CDP
    // 媒体拦截持续 Range 播放，避开主文档 CSP 与 RPC + Base64 分片通道。
    // lazy start（首次代理播放时启动）；
    // 传 hlsProxyFactory: null 可整体关闭（测试用）。
    this.hlsProxy = hlsProxyFactory === null
      ? null
      : (hlsProxyFactory ?? ((options) => new HlsProxy(options)))({
          upstream: (args) => this.#mediaUpstream(args),
          randomUUIDImpl
        });
    this.randomUUIDImpl = randomUUIDImpl;
    this.logger = logger;
    this.config = null;
    this.serverState = null;
    this.token = null;
    this.client = null;
    this.loaded = false;
    this.loading = null;
    this.playbacks = new Map();
    this.stoppingPlaybacks = new Map();
    this.itemPositions = new Map();
    this.metadataTimeoutMs = metadataTimeoutMs;
    this.metadataAttempts = metadataAttempts;
    this.playbackEventTimeoutMs = playbackEventTimeoutMs;
    this.loginHostGuard = loginHostGuard;
    this.now = now;
    this.homeCache = null;
    this.homeCacheKey = null;
  }

  async handleRpc(method, params = {}, context = {}) {
    const signal = context.signal;
    switch (method) {
      case "connection.status": return this.connectionStatus();
      case "auth.login": return this.login(params, { signal });
      case "auth.logout": return this.logout({ signal });
      case "servers.list": return this.listServers();
      case "servers.switch": return this.switchServer(params, { signal });
      case "servers.remove": return this.removeServer(params, { signal });
      case "home.get": return this.home({ signal, refresh: params?.refresh === true });
      case "library.get": return this.library(params, { signal });
      case "search": return this.search(params, { signal });
      case "series.get": return this.series(params, { signal });
      case "playback.open": return this.openPlayback(params, { signal, targetId: context.targetId, mediaTransport: context.mediaTransport });
      case "playback.progress": return this.progressPlayback(params, { signal });
      case "playback.stop": return this.stopPlayback(params, { signal });
      case "playback.direct.init": return this.initializeDirectPlayback(params, { signal });
      case "playback.direct.next": return this.nextDirectPlayback(params, { signal });
      case "playback.direct.seek": return this.seekDirectPlayback(params, { signal });
      case "playback.subtitle.load": return this.loadSubtitle(params, { signal });
      case "playback.subtitle.select": return this.selectSubtitle(params, { signal });
      case "resource.load": return this.loadResource(params, { signal });
      default: throw new EmbyError("METHOD_NOT_FOUND", `不支持的 Emby RPC 方法：${method}`);
    }
  }

  async connectionStatus() {
    await this.#loadStoredSession();
    return this.#statusDto();
  }

  async login(params, { signal } = {}) {
    const baseUrl = normalizeServerUrl(requiredString(params, "baseUrl", "请输入 Emby 服务器地址"));
    const username = requiredString(params, "username", "请输入 Emby 用户名");
    const password = requiredString(params, "password", "请输入 Emby 密码");
    // SSRF 收口：这是唯一由渲染层直接决定 baseUrl 的网络入口，登录前先确认主机不是
    // 回环 / 链路本地 / 云元数据地址（仍允许自建 Emby 常驻的 LAN 私网）。
    await this.loginHostGuard(baseUrl);
    await this.#loadStoredSession();
    const deviceId = this.storage.createDeviceId(this.config ?? this.serverState?.servers?.[0]);
    const anonymousClient = this.clientFactory({ baseUrl, deviceId, token: null });
    let authenticated;
    try {
      authenticated = await anonymousClient.authenticate(username, password, { signal });
    } finally {
      // 匿名 client 的 keep-alive 连接池登录后即无用，立即释放（无论成败）。
      anonymousClient.close?.();
    }
    const accessToken = authenticated?.AccessToken;
    const serverId = authenticated?.ServerId;
    const userId = authenticated?.User?.Id;
    if (!accessToken || !serverId || !userId) {
      throw new EmbyError("INVALID_RESPONSE", "Emby 登录响应缺少 ServerId、UserId 或 AccessToken");
    }

    const config = { baseUrl, serverId, userId, username, deviceId };
    const key = embyServerKey(config);
    if (this.serverState?.activeServerKey && this.serverState.activeServerKey !== key) {
      await this.#stopAllBestEffort({ signal });
    }
    const previousToken = await this.storage.readToken(serverId, userId);
    await this.storage.saveToken(serverId, userId, accessToken);
    try {
      const servers = [...(this.serverState?.servers ?? [])];
      const existingIndex = servers.findIndex((entry) => embyServerKey(entry) === key);
      if (existingIndex >= 0) servers[existingIndex] = config;
      else servers.push(config);
      this.serverState = await this.#saveServerState({ activeServerKey: key, servers });
    } catch (error) {
      if (previousToken) await this.storage.saveToken(serverId, userId, previousToken).catch(() => {});
      else await this.storage.deleteToken(serverId, userId).catch(() => {});
      throw error;
    }
    this.config = config;
    this.token = accessToken;
    this.client?.close?.();
    this.client = this.clientFactory({ baseUrl, deviceId, token: accessToken });
    this.itemPositions.clear();
    this.homeCache = null;
    this.homeCacheKey = null;
    this.loaded = true;
    this.#log("info", "Emby 登录成功", { baseUrl, username });
    return this.#statusDto();
  }

  async logout({ signal } = {}) {
    await this.#loadStoredSession();
    await this.#stopAllBestEffort({ signal });
    const config = this.config;
    if (config) {
      await this.storage.deleteToken(config.serverId, config.userId);
      // 内存态与磁盘缓存都清空：登出后不应在盘上残留私有库标题/缩略图。
      await this.storage.clearHomeCache?.(config.serverId, config.userId).catch(() => {});
    }
    this.token = null;
    this.client?.close?.();
    this.client = null;
    this.itemPositions.clear();
    this.homeCache = null;
    this.homeCacheKey = null;
    return this.#statusDto();
  }

  async listServers() {
    await this.#loadStoredSession();
    const servers = await Promise.all((this.serverState?.servers ?? []).map(async (config) => {
      const key = embyServerKey(config);
      const hasToken = key === this.serverState?.activeServerKey
        ? Boolean(this.token)
        : Boolean(await this.storage.readToken(config.serverId, config.userId));
      return {
        key,
        baseUrl: config.baseUrl,
        username: config.username,
        serverId: config.serverId,
        userId: config.userId,
        active: key === this.serverState?.activeServerKey,
        connected: hasToken
      };
    }));
    return { servers };
  }

  async switchServer(params, { signal } = {}) {
    const key = requiredString(params, "serverKey", "缺少要切换的 Emby 服务器");
    await this.#loadStoredSession();
    const config = this.serverState?.servers?.find((entry) => embyServerKey(entry) === key);
    if (!config) throw new EmbyError("SERVER_NOT_FOUND", "保存的 Emby 服务器不存在");
    if (key !== this.serverState.activeServerKey) {
      await this.#stopAllBestEffort({ signal });
      this.serverState = await this.#saveServerState({ ...this.serverState, activeServerKey: key });
      this.config = config;
      this.token = await this.storage.readToken(config.serverId, config.userId);
      this.client?.close?.();
      this.client = this.token
        ? this.clientFactory({ baseUrl: config.baseUrl, deviceId: config.deviceId, token: this.token })
        : null;
      this.itemPositions.clear();
    }
    return this.#statusDto();
  }

  async removeServer(params, { signal } = {}) {
    const key = requiredString(params, "serverKey", "缺少要移除的 Emby 服务器");
    await this.#loadStoredSession();
    const removed = this.serverState?.servers?.find((entry) => embyServerKey(entry) === key);
    if (!removed) throw new EmbyError("SERVER_NOT_FOUND", "保存的 Emby 服务器不存在");
    if (key === this.serverState.activeServerKey) await this.#stopAllBestEffort({ signal });
    const servers = this.serverState.servers.filter((entry) => embyServerKey(entry) !== key);
    const activeServerKey = key === this.serverState.activeServerKey
      ? (servers[0] ? embyServerKey(servers[0]) : null)
      : this.serverState.activeServerKey;
    this.serverState = await this.#saveServerState({ activeServerKey, servers });
    this.config = activeServerKey
      ? servers.find((entry) => embyServerKey(entry) === activeServerKey) ?? null
      : null;
    this.token = this.config ? await this.storage.readToken(this.config.serverId, this.config.userId) : null;
    this.client?.close?.();
    this.client = this.config && this.token
      ? this.clientFactory({ baseUrl: this.config.baseUrl, deviceId: this.config.deviceId, token: this.token })
      : null;
    this.itemPositions.clear();
    await this.storage.deleteToken(removed.serverId, removed.userId);
    return this.#statusDto();
  }

  async home({ signal, refresh = false } = {}) {
    return this.#withSession(async (client, config) => {
      const cached = await this.#loadHomeCache(config);
      const cacheAge = cached ? this.now() - cached.at : Infinity;
      if (!refresh && cached && cacheAge <= HOME_CACHE_MAX_AGE_MS) {
        const result = {
          ...cached.data,
          cacheStatus: cacheAge < HOME_CACHE_FRESH_MS ? "fresh" : "stale"
        };
        this.#rememberPositions([...result.resume, ...result.latest]);
        return result;
      }

      const operations = [
        ["views", "加载 Emby 媒体库", (requestSignal) => client.getViews(config.userId, { signal: requestSignal })],
        ["resume", "加载 Emby 继续观看", (requestSignal) => client.getResume(config.userId, { limit: 5, signal: requestSignal })],
        ["latest", "加载 Emby 最近添加", (requestSignal) => client.getLatest(config.userId, { limit: 12, signal: requestSignal })]
      ];
      const settled = await Promise.allSettled(operations.map(([, label, operation]) => (
        this.#metadataRequest(label, operation, { signal })
      )));
      const unauthorized = settled.find((entry) => entry.status === "rejected" && entry.reason?.code === "UNAUTHORIZED");
      if (unauthorized) throw unauthorized.reason;

      const responses = Object.fromEntries(operations.map(([name], index) => [name, settled[index]]));
      const contentSucceeded = responses.resume.status === "fulfilled" || responses.latest.status === "fulfilled";
      if (!contentSucceeded && !cached) throw responses.resume.reason ?? responses.latest.reason;
      const result = {
        views: responses.views.status === "fulfilled"
          ? asItems(responses.views.value).map((item) => mapEmbyItem(item, client))
          : (cached?.data.views ?? []),
        resume: responses.resume.status === "fulfilled"
          ? asItems(responses.resume.value).map((item) => mapEmbyItem(item, client))
          : (cached?.data.resume ?? []),
        latest: responses.latest.status === "fulfilled"
          ? asItems(responses.latest.value).map((item) => mapEmbyItem(item, client))
          : (cached?.data.latest ?? [])
      };
      if (responses.resume.status === "fulfilled" && responses.latest.status === "fulfilled") {
        await this.#saveHomeCache(config, result);
      }
      this.#rememberPositions([...result.resume, ...result.latest]);
      return result;
    });
  }

  async library(params, { signal } = {}) {
    const parentId = requiredString(params, "parentId", "缺少媒体库目录 ID");
    const startIndex = Math.max(0, Math.round(Number(params?.startIndex) || 0));
    const limit = Math.min(100, Math.max(1, Math.round(Number(params?.limit) || 60)));
    return this.#withSession(async (client, config) => {
      const response = await this.#metadataRequest(
        "加载 Emby 媒体库分类",
        (requestSignal) => client.getLibraryItems(config.userId, parentId, { startIndex, limit, signal: requestSignal }),
        { signal }
      );
      const items = asItems(response).map((item) => mapEmbyItem(item, client));
      this.#rememberPositions(items);
      const totalRecordCount = Math.max(items.length + startIndex, Number(response?.TotalRecordCount) || 0);
      return { parentId, startIndex, totalRecordCount, items };
    });
  }

  async search(params, { signal } = {}) {
    const query = String(params?.query ?? params?.term ?? "").trim();
    if (query.length < 2) return { items: [] };
    return this.#withSession(async (client, config) => {
      const response = await this.#metadataRequest(
        "搜索 Emby 媒体库",
        (requestSignal) => client.search(config.userId, query, { limit: 30, signal: requestSignal }),
        { signal }
      );
      const items = asItems(response).map((item) => mapEmbyItem(item, client));
      this.#rememberPositions(items);
      return { items };
    });
  }

  async series(params, { signal } = {}) {
    const seriesId = requiredString(params, "seriesId", "缺少剧集 ID");
    return this.#withSession(async (client, config) => {
      const { seasons, selectedSeasonId, episodesResponse } = await this.#metadataRequest(
        "加载 Emby 剧集",
        async (requestSignal) => {
          const seasonsResponse = await client.getSeasons(seriesId, config.userId, { signal: requestSignal });
          const seasons = asItems(seasonsResponse).map((item) => mapSeason(item, client));
          const requestedSeason = params?.seasonId ? String(params.seasonId) : null;
          const selectedSeasonId = seasons.some((season) => season.id === requestedSeason)
            ? requestedSeason
            : (seasons[0]?.id ?? null);
          const episodesResponse = selectedSeasonId
            ? await client.getEpisodes(seriesId, config.userId, { seasonId: selectedSeasonId, signal: requestSignal })
            : { Items: [] };
          return { seasons, selectedSeasonId, episodesResponse };
        },
        { signal }
      );
      const episodes = asItems(episodesResponse).map((item) => mapEmbyItem(item, client));
      this.#rememberPositions(episodes);
      // 枚举可选源：对代表集（本季第一集）调一次 PlaybackInfo。列表接口只返回单源，
      // 只有 PlaybackInfo 才带全部版本。失败/单源时返回空数组，前端不显示选源控件。
      let sourceOptions = [];
      const representativeEpisode = episodes[0];
      if (representativeEpisode?.id) {
        try {
          const playbackInfo = await client.getPlaybackInfo(representativeEpisode.id, config.userId, { signal });
          sourceOptions = mapMediaSourceOptions(playbackInfo?.MediaSources, {
            localFfmpegAvailable: this.ffmpegAvailable
          });
        } catch (error) {
          this.#log("warn", "枚举 Emby 媒体源失败", { message: error?.message });
        }
      }
      return {
        seriesId,
        seasons,
        selectedSeasonId,
        episodes,
        sourceOptions
      };
    });
  }

  async openPlayback(params, { signal, targetId, mediaTransport } = {}) {
    const itemId = requiredString(params, "itemId", "缺少播放项目 ID");
    const startPositionTicks = params?.startPositionTicks === undefined
      ? (params?.startPositionSeconds === undefined
        ? (this.itemPositions.get(itemId) ?? 0)
        : secondsToTicks(params.startPositionSeconds))
      : Math.max(0, Math.round(Number(params.startPositionTicks) || 0));
    return this.#withSession(async (client, config) => {
      const playbackInfo = await client.getPlaybackInfo(itemId, config.userId, { startTimeTicks: startPositionTicks, signal });
      const mediaSources = Array.isArray(playbackInfo?.MediaSources) ? playbackInfo.MediaSources : [];
      const preferredSourceKey = typeof params?.preferredSourceKey === "string" && params.preferredSourceKey.length > 0
        ? params.preferredSourceKey
        : null;

      // 优先尊重用户偏好；默认在最高画质档内按真实播放成本选源。
      const { mediaSource } = pickMediaSource(mediaSources, {
        preferredSourceKey,
        localFfmpegAvailable: this.ffmpegAvailable
      });
      const selectedMode = mediaSourcePlaybackMode(mediaSource);
      if (!selectedMode) throw new EmbyError("NOT_PLAYABLE", "Emby 未返回可播放的媒体源");
      if (selectedMode === "ffmpeg-fmp4" && !this.ffmpegAvailable) {
        throw new EmbyError("FFMPEG_UNAVAILABLE", "此片源需要系统 FFmpeg；请选择兼容片源或安装 FFmpeg");
      }
      const transcodingSource = selectedMode === "hls" ? mediaSource : null;
      const directSource = selectedMode === "direct-mp4" ? mediaSource : null;
      const ffmpegSource = selectedMode === "ffmpeg-fmp4" ? mediaSource : null;
      const mediaSourceId = mediaSource?.Id;
      const playSessionId = playbackInfo?.PlaySessionId;
      if (!mediaSourceId || !playSessionId) {
        throw new EmbyError("NOT_PLAYABLE", "Emby 未返回可播放的媒体源");
      }

      const playbackId = this.randomUUIDImpl();
      const baseStreamMode = selectedMode;
      const subtitles = mapSubtitleStreams(mediaSource);
      const preferredSubtitle = preferredSubtitleIndexFromPreference(subtitles, params?.subtitlePreference);
      const selectedSubtitleStreamIndex = preferredSubtitle !== undefined
        ? preferredSubtitle
        : defaultSubtitleIndex(mediaSource, subtitles);
      const selectedSubtitle = subtitles.find((subtitle) => subtitle.index === selectedSubtitleStreamIndex) ?? null;
      const subtitleMode = selectedSubtitle?.mode ?? "off";
      const streamMode = subtitleMode === "burn-in" && baseStreamMode !== "hls"
        ? "ffmpeg-fmp4"
        : baseStreamMode;
      const session = {
        playbackId,
        targetId,
        mediaTransport,
        itemId,
        userId: config.userId,
        mediaSourceId,
        playSessionId,
        startTimeTicks: startPositionTicks,
        positionTicks: startPositionTicks,
        isPaused: false,
        isMuted: false,
        volumeLevel: 100,
        playMethod: transcodingSource ? "Transcode" : "DirectStream",
        baseStreamMode,
        streamMode,
        directSession: null,
        directInitialization: null,
        directResolvedUrl: null,
        directStreamUrl: null,
        directStreamGeneration: 0,
        directRefreshPromise: null,
        mediaSource,
        subtitles,
        subtitleSources: new Map(
          (mediaSource.MediaStreams ?? [])
            .filter((stream) => String(stream?.Type ?? "").toLowerCase() === "subtitle")
            .map((stream) => [Number(stream.Index), stream])
        ),
        subtitleStreamIndex: selectedSubtitleStreamIndex,
        subtitleMode,
        subtitleData: null,
        readRange: null,
        openRangeStream: null,
        durationSeconds: Number.isFinite(Number(mediaSource?.RunTimeTicks))
          ? Number(mediaSource.RunTimeTicks) / 10_000_000
          : null
      };
      // 同一渲染目标每次只保留一个活动会话。渲染器快速重开 / 导航 / 漏发 stop 时，
      // 旧会话的 ffmpeg 子进程会一直存活、服务端也一直显示 Playing，直到目标断开。
      // 停旧会话（至少一个网络 RTT）与下面的流搭建/烧录字幕下载互不依赖：并行启动，
      // 注册新会话前再 await，首帧少一个串行 RTT（内部 allSettled，不会 reject）。
      const stopOldSessions = this.#stopSessionsForTarget(client, targetId, { signal });
      if (directSource || ffmpegSource) {
        const localSource = directSource ?? ffmpegSource;
        session.directStreamUrl = sanitizeDirectStreamUrl(client.baseUrl, localSource.DirectStreamUrl);
        session.readRange = async ({
          start,
          end,
          resolvedUrl,
          refreshPositionTicks = session.positionTicks,
          signal: rangeSignal
        }) => {
          const load = async (cachedUrl) => {
            const generation = session.directStreamGeneration;
            const result = await client.loadDirectRange(session.directStreamUrl, {
              start,
              end,
              resolvedUrl: cachedUrl,
              signal: rangeSignal
            });
            return { generation, result };
          };
          let loaded;
          try {
            loaded = await load(resolvedUrl ?? session.directResolvedUrl);
          } catch (error) {
            if (error?.code !== "DIRECT_URL_EXPIRED") throw error;
            session.directResolvedUrl = null;
            try {
              loaded = await load(null);
            } catch (retryError) {
              if (retryError?.code !== "DIRECT_URL_EXPIRED") throw retryError;
              await this.#refreshDirectStreamUrl(client, session, refreshPositionTicks, rangeSignal);
              loaded = await load(null);
            }
          }
          if (
            loaded.result.resolvedUrl
            && loaded.generation === session.directStreamGeneration
          ) {
            session.directResolvedUrl = loaded.result.resolvedUrl;
          }
          return loaded.result;
        };
        if (typeof client.openDirectRangeStream === "function") {
          session.openRangeStream = async ({
            start,
            end = null,
            refreshPositionTicks = session.positionTicks,
            signal: rangeSignal
          }) => {
            const open = async (cachedUrl) => {
              const generation = session.directStreamGeneration;
              const result = await client.openDirectRangeStream(session.directStreamUrl, {
                start,
                end,
                resolvedUrl: cachedUrl,
                signal: rangeSignal
              });
              return { generation, result };
            };
            let opened;
            try {
              opened = await open(session.directResolvedUrl);
            } catch (error) {
              if (error?.code !== "DIRECT_URL_EXPIRED") throw error;
              session.directResolvedUrl = null;
              try {
                opened = await open(null);
              } catch (retryError) {
                if (retryError?.code !== "DIRECT_URL_EXPIRED") throw retryError;
                await this.#refreshDirectStreamUrl(client, session, refreshPositionTicks, rangeSignal);
                opened = await open(null);
              }
            }
            if (
              opened.result.resolvedUrl
              && opened.generation === session.directStreamGeneration
            ) {
              session.directResolvedUrl = opened.result.resolvedUrl;
            }
            return opened.result;
          };
        }
        if (needsLocalSubtitleFile(selectedSubtitle)) {
          session.subtitleData = await this.#loadBurnInSubtitle(client, session, selectedSubtitle, signal);
        }
        session.directSession = this.#createDirectSession(session, selectedSubtitle);
      }
      // 停旧会话在流搭建前已并行启动（见上方注释），注册新会话前确保收尾。
      await stopOldSessions;
      this.playbacks.set(playbackId, session);
      try {
        await this.#reportPlaybackStartedBestEffort(client, session, { signal });
      } catch (error) {
        this.playbacks.delete(playbackId);
        session.subtitleLoader?.dispose();
        session.subtitleFullLoader?.dispose();
        session.directSession?.destroy();
        if (transcodingSource) await client.stopActiveEncoding(playSessionId).catch(() => {});
        throw error;
      }
      const result = {
        playbackId,
        itemId,
        mediaSourceId,
        playSessionId,
        streamMode,
        startPositionTicks,
        subtitles,
        selectedSubtitleIndex: selectedSubtitleStreamIndex,
        subtitleMode,
        // 播放界面 chrome 透出的画质标签（与选源 chips 同源：分辨率档 + 容器 + 编码）
        qualityLabel: mapMediaSourceOption(mediaSource).label + (streamMode === "ffmpeg-fmp4" && videoColorInfo(mediaSource).requiresToneMapping ? " → SDR" : ""),
        sourceKey: mediaSourceId
          ? computeSourceKey(mediaSource, mediaSources.indexOf(mediaSource))
          : null
      };
      // Renderer 的 SourceBuffer 配额按字节而不是按时长计算。把实际送入 MSE
      // 的估算视频码率传给前端，让相同的内存预算在 2 Mbps 与 40 Mbps 下都成立。
      const mediaBitrate = mseBitrateFor(mediaSource, streamMode, selectedSubtitle);
      if (mediaBitrate !== undefined) result.mediaBitrate = mediaBitrate;
      // 原生直放只在 CDP 媒体拦截可用时开启：Codex 的 CSP 禁止页面（含 blob
      // 子文档）直连 loopback，其余情况由 Renderer 走 MSE + RPC 分片。
      if (mediaTransport === "intercept" && streamMode === "direct-mp4" && session.directStreamUrl) {
        const mediaProxySession = await this.#registerMediaProxySession(client, session.directStreamUrl);
        const directMediaUrl = mediaProxySession
          ? toMediaInterceptUrl(mediaProxySession.urlFor(session.directStreamUrl))
          : null;
        if (directMediaUrl) {
          session.hlsProxySession = mediaProxySession;
          result.directMediaUrl = directMediaUrl;
        } else if (mediaProxySession) {
          this.hlsProxy.unregister(mediaProxySession.secret);
        }
      }
      if (transcodingSource) {
        result.hlsUrl = client.hlsUrl(itemId, session);
        const hlsProxySession = mediaTransport === "rpc"
          ? null
          : await this.#registerMediaProxySession(client, result.hlsUrl);
        if (hlsProxySession) {
          session.hlsProxySession = hlsProxySession;
          result.hlsProxyUrl = hlsProxySession.urlFor(result.hlsUrl);
        }
      }
      return result;
    });
  }

  async loadSubtitle(params, { signal } = {}) {
    const session = this.#playback(params);
    const subtitleStreamIndex = Number(params?.subtitleStreamIndex);
    const subtitle = session.subtitles.find((candidate) => candidate.index === subtitleStreamIndex);
    if (!subtitle) throw new EmbyError("INVALID_SUBTITLE_INDEX", "字幕轨道不存在");
    if (subtitle.mode !== "external-vtt") {
      throw new EmbyError("SUBTITLE_REQUIRES_BURN_IN", "该字幕必须通过视频转码显示");
    }
    signal?.throwIfAborted();
    return this.#withSession(async (client) => {
      const positionSeconds = Math.max(0, Number(params.positionTicks ?? session.positionTicks) || 0) / 10_000_000;
      const local = !subtitle.isExternal && session.readRange && this.ffmpegAvailable
        && typeof client.openDirectRangeStream === "function" && this.subtitleWindowImpl;
      session.subtitleLoader ??= new SubtitleLoader();
      session.subtitleFullLoader ??= new SubtitleLoader();
      const fullKey = `${session.mediaSourceId}:${subtitle.index}:full`;
      const fullReady = session.subtitleFullLoader.cache.has(fullKey);
      const key = `${session.mediaSourceId}:${subtitle.index}:${local && !fullReady ? Math.floor(positionSeconds / SUBTITLE_WINDOW_SECONDS) : "full"}`;
      return session.subtitleLoader.load(key, async (loadSignal) => {
        // 当前片段先显示；同时准备完整字幕。一旦完整结果可用，之后不再逐段请求媒体。
        const full = session.subtitleFullLoader.load(fullKey, (fullSignal) => this.#fetchSubtitle(client, session, subtitle, fullSignal));
        let result;
        if (local && !fullReady) {
          const controller = new AbortController();
          const abort = () => controller.abort(loadSignal.reason);
          loadSignal.addEventListener("abort", abort, { once: true });
          if (loadSignal.aborted) abort();
          // 服务端已缓存的字幕通常瞬间返回；给它短暂先手，避免无谓启动 FFmpeg。
          const window = delay(300, undefined, { signal: controller.signal }).then(() => this.subtitleWindowImpl({
              readRange: session.readRange, openRangeStream: session.openRangeStream,
              index: subtitle.index, positionSeconds, signal: controller.signal
            }));
          try {
            result = await Promise.any([window, full]);
          } catch (error) {
            if (loadSignal.aborted) throw error;
            throw error.errors?.at(-1) ?? error;
          } finally {
            loadSignal.removeEventListener("abort", abort);
            controller.abort();
          }
        } else result = await full;
        return { ...result, encoding: "utf8", contentType: "text/vtt", subtitleStreamIndex: subtitle.index };
      });
    });
  }

  async #fetchSubtitle(client, session, subtitle, signal) {
    const styledText = STYLED_SUBTITLE_CODECS.has(subtitle.codec);
    const standardUrl = client.subtitleUrl(session.itemId, session.mediaSourceId, subtitle.index, {
      format: styledText ? "ass" : "vtt",
      startPositionTicks: 0
    });
    const source = session.subtitleSources?.get(subtitle.index);
    const urls = [];
    if (subtitle.isExternal && source?.DeliveryUrl && (styledText || /\.vtt(?:\?|$)/i.test(source.DeliveryUrl))) {
      urls.push(new URL(source.DeliveryUrl, `${client.baseUrl}/`).href);
    }
    urls.push(standardUrl);
    let result = null;
    let lastError = null;
    for (const url of [...new Set(urls)]) {
      try {
        result = await client.loadResource(url, {
          signal,
          responseType: "bytes",
          resourceType: "subtitle",
          maxBytes: DEFAULT_SUBTITLE_LIMIT
        });
        break;
      } catch (error) {
        if (signal?.aborted || error?.code === "CANCELLED") throw error;
        lastError = error;
      }
    }
    if (!result) throw lastError;
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(result.bytes).replace(/^\uFEFF/, "");
    } catch (cause) {
      throw new EmbyError("INVALID_SUBTITLE_ENCODING", "Emby 字幕不是有效 UTF-8 文本", { cause });
    }
    if (styledText) text = assToWebVtt(text);
    if (!/^WEBVTT(?:[ \t][^\r\n]*)?(?:\r?\n|$)/.test(text)) {
      throw new EmbyError("INVALID_SUBTITLE_RESPONSE", "Emby 返回的字幕不是有效 WebVTT");
    }
    return { data: text };
  }

  async selectSubtitle(params, { signal } = {}) {
    const session = this.#playback(params);
    const requested = params?.subtitleStreamIndex;
    const subtitleStreamIndex = requested === null || requested === undefined
      ? null
      : Number(requested);
    const subtitle = subtitleStreamIndex === null
      ? null
      : session.subtitles.find((candidate) => candidate.index === subtitleStreamIndex);
    if (subtitleStreamIndex !== null && !subtitle) {
      throw new EmbyError("INVALID_SUBTITLE_INDEX", "字幕轨道不存在");
    }
    const previousMode = session.subtitleMode;
    const nextMode = subtitle?.mode ?? "off";
    const restartRequired = previousMode === "burn-in" || nextMode === "burn-in";
    const positionTicks = params?.positionTicks === undefined
      ? session.positionTicks
      : Math.max(0, Math.round(Number(params.positionTicks) || 0));

    if (!restartRequired) {
      if (subtitleStreamIndex === null) {
        session.subtitleLoader?.cancel();
        session.subtitleFullLoader?.cancel();
      }
      session.subtitleStreamIndex = subtitleStreamIndex;
      session.subtitleMode = nextMode;
      session.positionTicks = positionTicks;
      return this.#subtitleSelectionDto(session, false);
    }

    return this.#withSession(async (client) => {
      const nextStreamMode = nextMode === "burn-in" && session.baseStreamMode !== "hls"
        ? "ffmpeg-fmp4"
        : session.baseStreamMode;
      let replacement = null;
      let replacementInitialization = null;
      let replacementHls = null;
      let subtitleData = null;
      if (nextStreamMode !== "hls") {
        subtitleData = needsLocalSubtitleFile(subtitle)
          ? await this.#loadBurnInSubtitle(client, session, subtitle, signal)
          : null;
        const candidate = {
          ...session,
          streamMode: nextStreamMode,
          startTimeTicks: positionTicks,
          positionTicks,
          subtitleData
        };
        const initializeReplacement = async ({ preferChunkedRange = false } = {}) => {
          const next = this.#createDirectSession(candidate, subtitle, { preferChunkedRange });
          try {
            const initialization = await next.initialize({
              startTimeSeconds: positionTicks / 10_000_000,
              signal
            });
            return { directSession: next, initialization };
          } catch (error) {
            next.destroy();
            throw error;
          }
        };
        try {
          ({ directSession: replacement, initialization: replacementInitialization } = await initializeReplacement());
        } catch (error) {
          // 切换本机烧录字幕时，旧 FFmpeg 会保留到新流就绪。少数 CDN 会拒绝两条
          // 长 Range 流重复读取 MKV 尾部，并把它误报成签名过期；有限分块 Range
          // 不依赖第二条长连接，且仍保持“新流成功后再替换旧流”的事务语义。
          if (
            error?.code !== "DIRECT_URL_EXPIRED"
            || nextStreamMode !== "ffmpeg-fmp4"
            || typeof session.openRangeStream !== "function"
            || typeof session.readRange !== "function"
          ) throw error;
          this.#log("warn", "Emby 持续媒体流被 CDN 拒绝，改用分块 Range 初始化字幕流", {
            mediaSourceId: session.mediaSourceId
          });
          try {
            ({ directSession: replacement, initialization: replacementInitialization } = await initializeReplacement({
              preferChunkedRange: true
            }));
          } catch (retryError) {
            // 分块重试仍被拒：这类 CDN 的反盗连按“同一签名地址不能有第二个读者”卡，
            // 新旧流根本无法共存（线上实测：分块请求也一律 403）。此时事务语义让位于
            // 可用性——先停掉旧流（放弃第一位读者），再试最后一次；再失败才向上抛，
            // 旧播放由渲染层走播放错误页重开。
            if (retryError?.code !== "DIRECT_URL_EXPIRED") throw retryError;
            this.#log("warn", "CDN 拒绝新旧媒体流共存，停止旧流后重试字幕流初始化", {
              mediaSourceId: session.mediaSourceId
            });
            session.directSession?.destroy();
            session.directSession = null;
            ({ directSession: replacement, initialization: replacementInitialization } = await initializeReplacement({
              preferChunkedRange: true
            }));
          }
        }
      } else {
        replacementHls = await this.#prepareHlsSubtitleSelection(
          client,
          session,
          subtitleStreamIndex,
          nextMode,
          positionTicks,
          signal
        );
      }

      const previousDirect = session.directSession;
      const previousHls = session.streamMode === "hls" ? { ...session } : null;
      session.directSession = replacement;
      session.directInitialization = replacementInitialization;
      session.streamMode = nextStreamMode;
      session.playMethod = nextStreamMode === "hls" ? "Transcode" : "DirectStream";
      if (replacementHls) {
        session.mediaSource = replacementHls.mediaSource;
        session.mediaSourceId = replacementHls.mediaSourceId;
        session.playSessionId = replacementHls.playSessionId;
        session.durationSeconds = replacementHls.durationSeconds;
        session.subtitleSources = replacementHls.subtitleSources;
      }
      session.subtitleStreamIndex = subtitleStreamIndex;
      session.subtitleMode = nextMode;
      session.subtitleData = subtitleData;
      session.positionTicks = positionTicks;
      session.startTimeTicks = positionTicks;
      previousDirect?.destroy();
      if (previousHls) {
        const cleanup = await Promise.allSettled([
          client.reportPlaybackStopped(previousHls, { signal }),
          client.stopActiveEncoding(previousHls.playSessionId, { signal })
        ]);
        const failures = cleanup.filter((result) => result.status === "rejected");
        if (failures.length > 0) {
          this.#log("warn", "切换字幕后清理旧 Emby HLS 会话失败", {
            count: failures.length,
            playSessionId: previousHls.playSessionId
          });
        }
      }
      return this.#subtitleSelectionDto(session, true, client);
    });
  }

  async initializeDirectPlayback(params, { signal } = {}) {
    const session = this.#directPlayback(params);
    if (session.directInitialization) {
      const initialization = session.directInitialization;
      session.directInitialization = null;
      return initialization;
    }
    return session.directSession.initialize({
      startTimeSeconds: session.startTimeTicks / 10_000_000,
      signal
    });
  }

  async nextDirectPlayback(params, { signal } = {}) {
    return this.#directPlayback(params).directSession.next({ signal });
  }

  async seekDirectPlayback(params, { signal } = {}) {
    const session = this.#directPlayback(params);
    const timeSeconds = Math.max(0, Number(params?.timeSeconds) || 0);
    session.positionTicks = secondsToTicks(timeSeconds);
    const result = await session.directSession.seek(timeSeconds, { signal });
    const actualTimeSeconds = Number(result?.timeSeconds);
    session.startTimeTicks = secondsToTicks(
      Number.isFinite(actualTimeSeconds) && actualTimeSeconds >= 0 ? actualTimeSeconds : timeSeconds
    );
    return result;
  }

  async progressPlayback(params, { signal } = {}) {
    const playbackId = requiredString(params, "playbackId", "缺少 Playback ID");
    const session = this.playbacks.get(playbackId);
    if (!session) throw new EmbyError("PLAYBACK_NOT_FOUND", "播放会话不存在或已经结束");
    // 已经进入停止流程的会话不再上报进度：progress 与 stop 不串行化，
    // 迟到的 progress 若在 Stopped 之后到达服务端，会把停止位置覆盖/复活。
    if (session.stopped || this.stoppingPlaybacks.has(playbackId)) {
      return { playbackId, positionTicks: session.positionTicks, stopped: true };
    }
    if (params.positionTicks !== undefined) session.positionTicks = Math.max(0, Math.round(Number(params.positionTicks) || 0));
    else if (params.positionSeconds !== undefined) session.positionTicks = secondsToTicks(params.positionSeconds);
    if (params.isPaused !== undefined) session.isPaused = Boolean(params.isPaused);
    if (params.isMuted !== undefined) session.isMuted = Boolean(params.isMuted);
    if (params.volumeLevel !== undefined) session.volumeLevel = Number(params.volumeLevel);
    session.eventName = playbackEventName(params.event, session.isPaused);
    return this.#withSession(async (client) => {
      if (session.stopped) return { playbackId, positionTicks: session.positionTicks, stopped: true };
      await client.reportPlaybackProgress(session, { signal });
      return { playbackId, positionTicks: session.positionTicks };
    });
  }

  async stopPlayback(params, { signal } = {}) {
    const playbackId = requiredString(params, "playbackId", "缺少 Playback ID");
    const session = this.playbacks.get(playbackId);
    if (!session) return { playbackId, stopped: false };
    if (params.positionTicks !== undefined) session.positionTicks = Math.max(0, Math.round(Number(params.positionTicks) || 0));
    else if (params.positionSeconds !== undefined) session.positionTicks = secondsToTicks(params.positionSeconds);
    // 标记停止：从此刻起并发的 progress 请求都会被 progressPlayback 短路，
    // 不会有进度上报排在这次 Stopped 之后。
    session.stopped = true;
    await this.#withSession((client) => this.#stopOne(client, session, { signal }));
    return { playbackId, stopped: true };
  }

  async loadResource(params, { signal } = {}) {
    const url = requiredString(params, "url", "缺少资源地址");
    const resourceType = params?.resourceType;
    if (resourceType !== "image" && resourceType !== "hls") {
      throw new EmbyError("UNSUPPORTED_RESOURCE_TYPE", "RPC 资源通道只允许加载图片或 HLS 媒体");
    }
    const wantsText = resourceType === "hls"
      && (params?.responseType === "text" || /\.m3u8(?:$|\?)/i.test(url));
    return this.#withSession(async (client) => {
      const result = await client.loadResource(url, {
        signal,
        responseType: wantsText ? "text" : "bytes",
        maxBytes: Math.min(DEFAULT_RESOURCE_LIMIT, Math.max(1, Number(params?.maxBytes) || DEFAULT_RESOURCE_LIMIT))
      });
      return wantsText
        ? { data: result.text, encoding: "utf8", contentType: result.contentType, url: result.url }
        : { data: Buffer.from(result.bytes).toString("base64"), encoding: "base64", contentType: result.contentType, url: result.url };
    });
  }

  async disposeTarget(targetId) {
    await this.#loadStoredSession();
    if (!this.client) return;
    const sessions = [...this.playbacks.values()].filter((session) => session.targetId === targetId);
    const results = await Promise.allSettled(
      sessions.map((session) => this.#stopOneWithRetry(this.client, session))
    );
    const failures = sessions.filter((_session, index) => results[index].status === "rejected");
    if (failures.length > 0) {
      this.#log("warn", "renderer 断开后仍有 Emby 播放会话未停止", { count: failures.length });
      // 重试耗尽：远端或许还显示 Playing，但本地不能留僵尸会话——#stopOne 失败路径
      // 不会从 playbacks 移除，directSession 已销毁的会话仍会被 progressPlayback
      // 命中、继续向服务端上报进度。与 #stopSessionsForTarget 语义一致：本地一定回收。
      for (const session of failures) {
        session.directSession?.destroy();
        this.#releaseHlsProxySession(session);
        this.playbacks.delete(session.playbackId);
      }
    }
  }

  async dispose() {
    await this.#loadStoredSession();
    await this.#stopAllWithRetry();
    this.client?.close?.();
    await this.hlsProxy?.close?.();
  }

  async #loadHomeCache(config) {
    const key = `${config.serverId}:${config.userId}`;
    if (this.homeCacheKey === key) return this.homeCache;
    this.homeCacheKey = key;
    this.homeCache = null;
    if (typeof this.storage.loadHomeCache !== "function") return null;
    try {
      const snapshot = await this.storage.loadHomeCache(config.serverId, config.userId);
      if (snapshot && this.now() - snapshot.at <= HOME_CACHE_MAX_AGE_MS) this.homeCache = snapshot;
    } catch (error) {
      this.#log("warn", "读取 Emby 首页缓存失败", { code: error?.code, message: error?.message });
    }
    return this.homeCache;
  }

  async #saveHomeCache(config, data) {
    const snapshot = { at: this.now(), data };
    this.homeCacheKey = `${config.serverId}:${config.userId}`;
    this.homeCache = snapshot;
    if (typeof this.storage.saveHomeCache !== "function") return;
    try {
      await this.storage.saveHomeCache(config.serverId, config.userId, snapshot);
    } catch (error) {
      this.#log("warn", "保存 Emby 首页缓存失败", { code: error?.code, message: error?.message });
    }
  }

  async #loadStoredSession() {
    if (this.loaded) return;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      this.serverState = await this.#loadServerState();
      this.config = this.serverState?.activeServerKey
        ? this.serverState.servers.find((entry) => embyServerKey(entry) === this.serverState.activeServerKey) ?? null
        : null;
      if (this.config) {
        this.token = await this.storage.readToken(this.config.serverId, this.config.userId);
        if (this.token) {
          this.client = this.clientFactory({
            baseUrl: this.config.baseUrl,
            deviceId: this.config.deviceId,
            token: this.token
          });
        }
      }
      this.loaded = true;
    })();
    try {
      await this.loading;
    } finally {
      this.loading = null;
    }
  }

  async #loadServerState() {
    if (typeof this.storage.loadState === "function") {
      return await this.storage.loadState() ?? { version: 2, activeServerKey: null, servers: [] };
    }
    const config = await this.storage.loadConfig();
    return config
      ? { version: 2, activeServerKey: embyServerKey(config), servers: [config] }
      : { version: 2, activeServerKey: null, servers: [] };
  }

  async #saveServerState(state) {
    if (typeof this.storage.saveState === "function") return this.storage.saveState(state);
    const active = state?.servers?.find((entry) => embyServerKey(entry) === state.activeServerKey) ?? null;
    if (active) await this.storage.saveConfig(active);
    return {
      version: 2,
      activeServerKey: active ? embyServerKey(active) : null,
      servers: Array.isArray(state?.servers) ? state.servers : []
    };
  }

  async #withSession(operation) {
    await this.#loadStoredSession();
    if (!this.config || !this.client || !this.token) {
      throw new EmbyError("NOT_CONNECTED", "请先连接 Emby 服务器");
    }
    // 捕获发起请求时的 client/config，401 处理只针对它自己。RPC 并发不串行化：
    // 若期间 switchServer/login 换掉了 this.client，旧服务器迟到的 401 绝不能删除
    // 新服务器的 token 或置空新 client（否则有效登录被误清、新服务器显示未连接）。
    const client = this.client;
    const config = this.config;
    try {
      return await operation(client, config);
    } catch (error) {
      if (error?.code === "UNAUTHORIZED" && this.client === client) {
        await this.storage.deleteToken(config.serverId, config.userId).catch(() => {});
        this.token = null;
        client.close?.();
        this.client = null;
        this.itemPositions.clear();
      }
      throw error;
    }
  }

  async #metadataRequest(label, operation, { signal } = {}) {
    let lastError = null;
    for (let attempt = 0; attempt < this.metadataAttempts; attempt += 1) {
      if (signal?.aborted) throw signal.reason ?? new EmbyError("CANCELLED", "Emby 请求已取消");
      const controller = new AbortController();
      let timedOut = false;
      const forwardAbort = () => controller.abort(signal.reason);
      signal?.addEventListener("abort", forwardAbort, { once: true });
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort(new EmbyError("NETWORK_TIMEOUT", `${label}响应超时，请重试`, { retryable: true }));
      }, this.metadataTimeoutMs);
      const aborted = new Promise((resolve, reject) => {
        controller.signal.addEventListener("abort", () => {
          reject(controller.signal.reason ?? new EmbyError("CANCELLED", "Emby 请求已取消"));
        }, { once: true });
      });
      try {
        return await Promise.race([
          Promise.resolve().then(() => operation(controller.signal)),
          aborted
        ]);
      } catch (error) {
        if (signal?.aborted) throw error;
        lastError = timedOut
          ? new EmbyError("NETWORK_TIMEOUT", `${label}响应超时，请重试`, { retryable: true, cause: error })
          : error;
        if (attempt + 1 >= this.metadataAttempts || lastError?.retryable !== true) throw lastError;
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", forwardAbort);
      }
    }
    throw lastError;
  }

  async #reportPlaybackStartedBestEffort(client, session, { signal } = {}) {
    if (signal?.aborted) throw signal.reason ?? new EmbyError("CANCELLED", "Emby 请求已取消");
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(signal.reason);
    signal?.addEventListener("abort", forwardAbort, { once: true });
    const timeoutError = new EmbyError(
      "PLAYBACK_EVENT_TIMEOUT",
      "Emby 播放状态上报超时",
      { retryable: true }
    );
    const timeout = setTimeout(() => controller.abort(timeoutError), this.playbackEventTimeoutMs);
    timeout.unref?.();
    const aborted = new Promise((_resolve, reject) => {
      controller.signal.addEventListener("abort", () => {
        reject(controller.signal.reason ?? timeoutError);
      }, { once: true });
    });
    try {
      await Promise.race([
        client.reportPlaybackStarted(session, { signal: controller.signal }),
        aborted
      ]);
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      // Started 只是服务端状态/续播遥测，PlaybackInfo 与媒体 URL 已经成功。
      // 服务器该端点异常时不能牺牲实际播放；后续 progress/stop 仍会继续尝试同步。
      this.#log("warn", "Emby Started 上报失败，继续本地播放", {
        code: error?.code,
        message: error?.message
      });
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", forwardAbort);
    }
  }

  async #stopOne(client, session, { signal } = {}) {
    session.subtitleLoader?.dispose();
    session.subtitleFullLoader?.dispose();
    const existing = this.stoppingPlaybacks.get(session.playbackId);
    if (existing) return existing;
    const stopping = (async () => {
      session.directSession?.destroy();
      this.#releaseHlsProxySession(session);
      const operations = [client.reportPlaybackStopped(session, { signal })];
      if (session.playMethod === "Transcode") {
        operations.push(client.stopActiveEncoding(session.playSessionId, { signal }));
      }
      const results = await Promise.allSettled(operations);
      const failure = results.find((result) => result.status === "rejected");
      if (failure) throw failure.reason;
      this.playbacks.delete(session.playbackId);
    })();
    this.stoppingPlaybacks.set(session.playbackId, stopping);
    try {
      return await stopping;
    } finally {
      if (this.stoppingPlaybacks.get(session.playbackId) === stopping) {
        this.stoppingPlaybacks.delete(session.playbackId);
      }
    }
  }

  async #stopAll({ signal } = {}) {
    if (!this.client || this.playbacks.size === 0) return;
    const sessions = [...this.playbacks.values()];
    const results = await Promise.allSettled(sessions.map((session) => this.#stopOne(this.client, session, { signal })));
    const failure = results.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
  }

  // 停掉某个渲染目标下的所有旧会话，为同目标的新播放让路。先同步回收本地媒体
  // 资源，再给服务端 Stopped / stop encoding 一个有界的 best-effort 窗口。它们只是
  // 远端状态同步，绝不能因为 Emby 端点挂起而阻断下一次实际起播。
  async #stopSessionsForTarget(client, targetId, { signal } = {}) {
    if (targetId === null || targetId === undefined) return;
    const sessions = [...this.playbacks.values()].filter((session) => session.targetId === targetId);
    await Promise.allSettled(sessions.map(async (session) => {
      session.stopped = true;
      session.directSession?.destroy();
      this.#releaseHlsProxySession(session);
      this.playbacks.delete(session.playbackId);
      if (!client) return;

      const controller = new AbortController();
      const timeoutError = new EmbyError(
        "PLAYBACK_EVENT_TIMEOUT",
        "Emby 停止状态上报超时",
        { retryable: true }
      );
      const forwardAbort = () => controller.abort(signal.reason);
      signal?.addEventListener("abort", forwardAbort, { once: true });
      const timeout = setTimeout(() => controller.abort(timeoutError), this.playbackEventTimeoutMs);
      timeout.unref?.();
      const aborted = new Promise((_resolve, reject) => {
        controller.signal.addEventListener("abort", () => {
          reject(controller.signal.reason ?? timeoutError);
        }, { once: true });
      });
      const operations = [
        Promise.resolve().then(() => client.reportPlaybackStopped(session, { signal: controller.signal }))
      ];
      if (session.playMethod === "Transcode") {
        operations.push(
          Promise.resolve().then(() => client.stopActiveEncoding(session.playSessionId, { signal: controller.signal }))
        );
      }
      try {
        const remoteStop = Promise.allSettled(operations).then((results) => {
          const failure = results.find((result) => result.status === "rejected");
          if (failure) throw failure.reason;
        });
        await Promise.race([remoteStop, aborted]);
      } catch (error) {
        if (!signal?.aborted) {
          this.#log("warn", "旧播放会话停止上报失败，继续新播放", {
            code: error?.code,
            message: error?.message
          });
        }
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", forwardAbort);
      }
    }));
  }

  async #stopOneWithRetry(client, session, { signal, attempts = 2 } = {}) {
    let lastError = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await this.#stopOne(client, session, { signal });
      } catch (error) {
        lastError = error;
        if (signal?.aborted) throw error;
      }
    }
    throw lastError;
  }

  async #stopAllWithRetry({ signal, attempts = 2 } = {}) {
    let lastError = null;
    for (let attempt = 0; attempt < attempts && this.playbacks.size > 0; attempt += 1) {
      try {
        await this.#stopAll({ signal });
        return;
      } catch (error) {
        lastError = error;
        if (signal?.aborted) throw error;
      }
    }
    if (lastError) throw lastError;
  }

  // 切换 / 移除 / 重新登录另一个服务器时，必须容忍旧服务器的停止上报失败：
  // 若旧服务器离线，reportPlaybackStopped 会失败，绝不能因此把用户卡在坏服务器上。
  // 本地资源一定回收（销毁 directSession、清空 playbacks），只把远端上报失败降级为日志。
  async #stopAllBestEffort({ signal } = {}) {
    try {
      await this.#stopAllWithRetry({ signal });
    } catch (error) {
      this.#log("warn", "切换服务器前停止播放失败，已本地清理", { code: error?.code, message: error?.message });
    } finally {
      for (const session of this.playbacks.values()) {
        session.directSession?.destroy();
        this.#releaseHlsProxySession(session);
      }
      this.playbacks.clear();
    }
  }

  #statusDto() {
    return {
      connected: Boolean(this.config && this.token && this.client),
      baseUrl: this.config?.baseUrl ?? "",
      username: this.config?.username ?? "",
      serverId: this.config?.serverId ?? null,
      userId: this.config?.userId ?? null
    };
  }

  #rememberPositions(items) {
    for (const item of items) {
      if (!item?.id) continue;
      this.itemPositions.delete(item.id);
      this.itemPositions.set(item.id, Math.max(0, Number(item.positionTicks) || 0));
      if (this.itemPositions.size > 500) this.itemPositions.delete(this.itemPositions.keys().next().value);
    }
  }

  #playback(params) {
    const playbackId = requiredString(params, "playbackId", "缺少 Playback ID");
    const session = this.playbacks.get(playbackId);
    if (!session) throw new EmbyError("PLAYBACK_NOT_FOUND", "播放会话不存在或已经结束");
    return session;
  }

  // 旧直连入口整体过期（重解析后 CDN 仍拒绝）时，重新取 PlaybackInfo 换新的 DirectStreamUrl。
  // 只换媒体地址，不采用新的 PlaySessionId：进度上报继续走开播时的同一条会话时间轴，
  // 也因此没有需要停止的新转码会话（直连路径不会触发服务端转码）。
  #refreshDirectStreamUrl(client, session, positionTicks, signal) {
    if (!session.directRefreshPromise) {
      session.directRefreshPromise = (async () => {
        const playbackInfo = await client.getPlaybackInfo(session.itemId, session.userId, {
          startTimeTicks: Math.max(0, Math.round(Number(positionTicks) || 0)),
          signal
        });
        const mediaSources = Array.isArray(playbackInfo?.MediaSources) ? playbackInfo.MediaSources : [];
        const mediaSource = mediaSources.find((source) => source?.Id === session.mediaSourceId)
          ?? mediaSources.find((source) => (
            (source?.SupportsDirectPlay === true || source?.SupportsDirectStream === true)
            && typeof source?.DirectStreamUrl === "string"
            && source.DirectStreamUrl.length > 0
          ));
        if (typeof mediaSource?.DirectStreamUrl !== "string" || mediaSource.DirectStreamUrl.length === 0) {
          throw new EmbyError("DIRECT_URL_EXPIRED", "媒体 CDN 地址已失效，且 Emby 未返回新的直连地址");
        }
        session.mediaSource = mediaSource;
        session.directStreamUrl = sanitizeDirectStreamUrl(client.baseUrl, mediaSource.DirectStreamUrl);
        session.directResolvedUrl = null;
        session.directStreamGeneration += 1;
      })().finally(() => {
        session.directRefreshPromise = null;
      });
    }
    return session.directRefreshPromise;
  }

  #createDirectSession(session, subtitle, { preferChunkedRange = false } = {}) {
    const readRange = typeof session.readRange === "function"
      ? (options) => session.readRange({ ...options, refreshPositionTicks: session.positionTicks })
      : null;
    const openRangeStream = !preferChunkedRange && typeof session.openRangeStream === "function"
      ? (options) => session.openRangeStream({ ...options, refreshPositionTicks: session.positionTicks })
      : null;
    // MCP Apps 沙箱禁止 HTTP loopback。插件按需拉取小批次并直接写入 MSE，
    // 不向页面暴露代理地址，也不为一次播放持续堆积未消费的媒体数据。
    const limits = session.mediaTransport === "rpc"
      ? { maxBatchBytes: 128 * 1024, maxQueueBytes: 8 * 1024 * 1024, resumeQueueBytes: 4 * 1024 * 1024 }
      : {};
    if (session.streamMode === "direct-mp4") {
      return this.directSessionFactory({ readRange, openRangeStream, ...limits });
    }
    return this.ffmpegSessionFactory({
      readRange,
      openRangeStream,
      mediaSource: session.mediaSource,
      durationSeconds: session.durationSeconds,
      subtitleTrack: subtitle?.mode === "burn-in" ? subtitle : null,
      subtitleData: subtitle?.mode === "burn-in" ? session.subtitleData : null,
      ...limits
    });
  }

  async #loadBurnInSubtitle(client, session, subtitle, signal) {
    const format = ["ass", "ssa"].includes(subtitle.codec)
      ? "ass"
      : ["hdmv_pgs_subtitle", "pgs", "pgssub"].includes(subtitle.codec)
        ? "sup"
        : "sub";
    const standardUrl = client.subtitleUrl(session.itemId, session.mediaSourceId, subtitle.index, {
      format,
      startPositionTicks: 0
    });
    const source = session.subtitleSources?.get(subtitle.index);
    const urls = [standardUrl];
    if (subtitle.isExternal && source?.DeliveryUrl) {
      urls.push(new URL(source.DeliveryUrl, `${client.baseUrl}/`).href);
    }
    let result = null;
    let lastError = null;
    for (const url of [...new Set(urls)]) {
      try {
        result = await client.loadResource(url, {
          signal,
          responseType: "bytes",
          maxBytes: MAX_BURN_IN_SUBTITLE_BYTES
        });
        break;
      } catch (error) {
        if (signal?.aborted || error?.code === "CANCELLED") throw error;
        lastError = error;
      }
    }
    if (!result) throw lastError;
    if (!(result.bytes instanceof Uint8Array) || result.bytes.byteLength === 0) {
      throw new EmbyError("INVALID_SUBTITLE_RESPONSE", "Emby 返回了空的字幕内容");
    }
    return result.bytes;
  }

  async #prepareHlsSubtitleSelection(
    client,
    session,
    subtitleStreamIndex,
    subtitleMode,
    positionTicks,
    signal
  ) {
    const playbackInfo = await client.getPlaybackInfo(session.itemId, session.userId, {
      startTimeTicks: positionTicks,
      subtitleStreamIndex,
      signal
    });
    const mediaSources = Array.isArray(playbackInfo?.MediaSources) ? playbackInfo.MediaSources : [];
    const mediaSource = mediaSources.find((source) => source?.Id === session.mediaSourceId)
      ?? mediaSources.find((source) => (
        source?.SupportsTranscoding === true
        || (typeof source?.TranscodingUrl === "string" && source.TranscodingUrl.length > 0)
      ));
    const playSessionId = playbackInfo?.PlaySessionId;
    if (!mediaSource?.Id || !playSessionId) {
      throw new EmbyError("NOT_PLAYABLE", "Emby 没有为所选字幕返回可转码的视频源");
    }
    const candidate = {
      ...session,
      mediaSource,
      mediaSourceId: mediaSource.Id,
      playSessionId,
      streamMode: "hls",
      playMethod: "Transcode",
      subtitleStreamIndex,
      subtitleMode,
      subtitleSources: new Map(
        (mediaSource.MediaStreams ?? [])
          .filter((stream) => String(stream?.Type ?? "").toLowerCase() === "subtitle")
          .map((stream) => [Number(stream.Index), stream])
      ),
      startTimeTicks: positionTicks,
      positionTicks
    };
    const durationSeconds = Number(mediaSource.RunTimeTicks ?? session.mediaSource?.RunTimeTicks) / 10_000_000;
    candidate.durationSeconds = Number.isFinite(durationSeconds) && durationSeconds > 0
      ? durationSeconds
      : session.durationSeconds;
    const hlsUrl = client.hlsUrl(session.itemId, candidate);
    try {
      // manifest 探测（触发服务端转码并验证 URL 可用）与 reportPlaybackStarted 互不
      // 依赖：并行发起，字幕切换少一个串行 RTT。探测保留 GET（Emby 收到 manifest
      // 请求才启动转码，改 HEAD 不会触发）；渲染侧 hls.js 经本地代理的二次拉取
      // 命中已启动的转码会话，代价很小。任一步失败都停掉编码会话再抛。
      await Promise.all([
        client.loadResource(hlsUrl, {
          signal,
          responseType: "text",
          maxBytes: MAX_HLS_MANIFEST_BYTES
        }),
        this.#reportPlaybackStartedBestEffort(client, candidate, { signal })
      ]);
    } catch (error) {
      await client.stopActiveEncoding(playSessionId).catch(() => {});
      throw error;
    }
    return candidate;
  }

  #subtitleSelectionDto(session, restartRequired, client = null) {
    const result = {
      playbackId: session.playbackId,
      mediaSourceId: session.mediaSourceId,
      playSessionId: session.playSessionId,
      selectedSubtitleIndex: session.subtitleStreamIndex,
      subtitleMode: session.subtitleMode,
      restartRequired,
      streamMode: session.streamMode,
      startPositionTicks: session.positionTicks
    };
    const mediaBitrate = mseBitrateFor(
      session.mediaSource,
      session.streamMode,
      session.subtitles.find((subtitle) => subtitle.index === session.subtitleStreamIndex) ?? null
    );
    if (mediaBitrate !== undefined) result.mediaBitrate = mediaBitrate;
    // 字幕切换可能换了媒体源（HLS 重新选源），画质标签同步更新。
    if (session.mediaSource) result.qualityLabel = mapMediaSourceOption(session.mediaSource).label;
    if (session.streamMode === "hls") {
      const activeClient = client ?? this.client;
      result.hlsUrl = activeClient.hlsUrl(session.itemId, session);
      // 字幕切换重建了 hlsUrl（PlaySessionId / 烧录参数变化），代理入口同步更新；
      // 会话 secret 不变（pathPrefix 以 itemId 为界，与本会话一致）。
      const hlsProxyUrl = session.hlsProxySession?.urlFor(result.hlsUrl);
      if (hlsProxyUrl) result.hlsProxyUrl = hlsProxyUrl;
    }
    return result;
  }

  // 为一次 HLS 或原生 MP4 播放注册本地代理会话。pathPrefix 取媒体 URL 所在目录
  // （含 baseUrl 可能携带的子路径，如 /emby/Videos/<itemId>/），把可代理的
  // 路径收口到该视频自己的媒体端点。Codex 主文档 CSP 会阻止 loopback：HLS
  // 回退到有界 RPC loader，原生 MP4 经 CDP 媒体拦截（media-intercept.mjs）访问；
  // 拦截不可用时回退 MP4Box/MSE。RPC 响应使用 callFunctionOn 参数，不生成动态脚本。
  async #registerMediaProxySession(client, mediaUrl) {
    if (!this.hlsProxy) return null;
    try {
      await this.hlsProxy.start();
      const pathname = new URL(mediaUrl).pathname;
      const pathPrefix = pathname.slice(0, pathname.lastIndexOf("/") + 1);
      return this.hlsProxy.register({
        token: client.token ?? this.token,
        baseUrl: client.baseUrl,
        pathPrefix
      });
    } catch (error) {
      this.#log("warn", "Emby 本地媒体代理不可用，回退到有界 RPC 加载通道", {
        code: error?.code,
        message: error?.message
      });
      return null;
    }
  }

  #releaseHlsProxySession(session) {
    const hlsProxySession = session.hlsProxySession;
    session.hlsProxySession = null;
    if (hlsProxySession?.secret) this.hlsProxy?.unregister(hlsProxySession.secret);
  }

  // 媒体代理的上游实现：同源走当前 client 的 fetch（附带同源流超时 dispatcher），
  // 跨源走带 DNS 校验的外网传输；重定向逐跳校验，token 绝不泄露到跨源。
  async #mediaUpstream({ url, method = "GET", headers, signal }) {
    const client = this.client;
    if (!client) throw new EmbyError("NOT_CONNECTED", "请先连接 Emby 服务器");
    const baseOrigin = new URL(client.baseUrl).origin;
    const requestHeaders = {
      ...headers,
      "User-Agent": EMBY_USER_AGENT,
      "X-Emby-Authorization": embyAuthorizationHeader(client.deviceId)
    };
    let current = new URL(url);
    for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
      const external = current.origin !== baseOrigin;
      if (external) {
        delete requestHeaders["X-Emby-Token"];
        delete requestHeaders["X-Emby-Authorization"];
      }
      const requestImpl = external ? (client.directStreamFetchImpl ?? client.fetchImpl) : client.fetchImpl;
      const options = { method, headers: requestHeaders, signal, redirect: "manual" };
      // 与 openDirectRangeStream 一致：同源流附带带 bodyTimeout 的 dispatcher，
      // 避免半开的 Emby 套接字让分片请求永久挂起。
      if (!external && client.sameOriginStreamDispatcher && client.fetchImpl === globalThis.fetch) {
        options.dispatcher = client.sameOriginStreamDispatcher;
      }
      const response = await requestImpl(current, options);
      if (![301, 302, 303, 307, 308].includes(response.status)) return response;
      const location = response.headers.get("location");
      if (typeof response.body?.cancel === "function") await response.body.cancel().catch(() => {});
      else response.body?.destroy?.();
      if (!location || redirectCount === 3) {
        throw new EmbyError("UNSAFE_MEDIA_REDIRECT", "媒体资源重定向无效或次数过多");
      }
      const next = new URL(location, current);
      current = next.origin === baseOrigin
        ? validateSameOriginResource(client.baseUrl, next)
        : await validateExternalMediaUrl(next, { dnsLookup: client.dnsLookup });
    }
    throw new EmbyError("UNSAFE_MEDIA_REDIRECT", "媒体资源重定向次数过多");
  }

  #directPlayback(params) {
    const session = this.#playback(params);
    if (!["direct-mp4", "ffmpeg-fmp4"].includes(session.streamMode) || !session.directSession) {
      throw new EmbyError("PLAYBACK_MODE_MISMATCH", "当前播放会话不是 Node 媒体桥模式");
    }
    return session;
  }

  #log(level, message, detail) {
    if (!this.logger?.[level]) return;
    const safe = JSON.parse(redactSensitive(JSON.stringify(detail ?? {}), [this.token]));
    this.logger[level](message, safe);
  }
}
