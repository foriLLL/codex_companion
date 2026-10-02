// Emby 不同版本使用 VideoRange、ExtendedVideoSubType 或 DvProfile 描述 HDR。
// 统一为播放决策与 UI 共用的模型；10-bit 本身不代表 HDR。
export function videoColorInfo(mediaSource) {
  const video = (mediaSource?.MediaStreams ?? []).find((stream) => String(stream?.Type).toLowerCase() === "video") ?? {};
  const description = [video.VideoRange, video.VideoRangeType, video.ExtendedVideoType, video.ExtendedVideoSubType].filter(Boolean).join(" ").toLowerCase();
  const subtype = /dovi(?:profile)?[ ._-]*(\d)(\d)?/i.exec(String(video.ExtendedVideoSubType ?? ""));
  const rawProfile = video.DvProfile ?? video.DolbyVisionProfile ?? video.DoviProfile;
  const numericProfile = rawProfile == null ? NaN : Number(rawProfile);
  const profile = Number.isFinite(numericProfile) && numericProfile > 0
    ? Math.floor(numericProfile)
    : subtype ? Number(subtype[1]) : null;
  const dolby = /dolby|dovi/.test(description) || profile !== null;
  const transfer = String(video.ColorTransfer ?? "").toLowerCase();
  const kind = dolby ? "dolby-vision"
    : /hlg/.test(description) || transfer === "arib-std-b67" ? "hlg"
      : /hdr/.test(description) || transfer === "smpte2084" ? "hdr10" : "sdr";
  const label = kind === "dolby-vision" ? `Dolby Vision${profile ? ` P${profile}` : ""}`
    : kind === "hlg" ? "HLG" : kind === "hdr10" ? "HDR10" : "SDR";
  return { kind, profile, label, requiresToneMapping: kind !== "sdr" };
}

// 不在颜色转换之前插入 scale/format：P5 的 IPTPQc2 数据及 RPU 必须原样交给 libplacebo。
// 显式指定 BT.709，防止 libplacebo 默认沿用 BT.2020/PQ，最终被 H.264 当成 SDR 显示。
export const SDR_TONE_MAP_FILTER = [
  "libplacebo=apply_dolbyvision=true:colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv:format=yuv420p",
  // 映射之后才移除 HDR 元数据，避免 SDR 输出仍携带 1000-nit mastering/CLL 或 RPU。
  ...["MASTERING_DISPLAY_METADATA", "CONTENT_LIGHT_LEVEL", "DOVI_RPU_BUFFER", "DOVI_METADATA"]
    .map((type) => `sidedata=mode=delete:type=${type}`)
].join(",");
