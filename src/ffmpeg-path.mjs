import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

/**
 * 解析 FFmpeg 可执行文件路径。
 *
 * 项目不分发 FFmpeg 二进制，避免把许可状态不明确的第三方构建塞进安装包。
 * 运行时按优先级解析：
 *   1. 环境变量 CODEX_COMPANION_FFMPEG（显式覆盖）；
 *   2. 相对可执行文件的 sidecar（兼容用户自行放置的旧安装）；
 *   3. PATH 与 macOS 常见包管理器目录中的 ffmpeg。
 *
 * 全部依赖注入以便测试。
 */
export function resolveFfmpegPath({
  env = process.env,
  execPath = process.execPath,
  fileExists = existsSync,
  preferFull = false
} = {}) {
  const override = env.CODEX_COMPANION_FFMPEG;
  if (typeof override === "string" && override.trim() !== "" && fileExists(override)) {
    return override;
  }

  const execDir = dirname(execPath);
  // .app/Contents/MacOS/<bin> → .app/Contents/Resources/ffmpeg；以及与二进制同级的 ffmpeg。
  const pathCandidates = String(env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((directory) => join(directory, "ffmpeg"));
  const candidates = [
    join(execDir, "ffmpeg"),
    join(execDir, "..", "Resources", "ffmpeg"),
    ...(preferFull ? ["/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg", "/usr/local/opt/ffmpeg-full/bin/ffmpeg"] : []),
    ...pathCandidates,
    "/opt/homebrew/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
    "/opt/local/bin/ffmpeg"
  ];
  for (const candidate of new Set(candidates)) {
    if (fileExists(candidate)) return candidate;
  }

  // 找不到时返回 null，让调用方抛出 FFMPEG_UNAVAILABLE。
  return null;
}
