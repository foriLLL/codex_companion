import { existsSync } from "node:fs";
import path from "node:path";
import { searchPathCandidates } from "./platform/paths.mjs";

/**
 * 解析 FFmpeg 可执行文件路径。
 *
 * 项目不分发 FFmpeg 二进制，避免把许可状态不明确的第三方构建塞进安装包。
 * 运行时按优先级解析：
 *   1. 环境变量 CODEX_COMPANION_FFMPEG（显式覆盖）；
 *   2. 相对可执行文件的 sidecar（兼容用户自行放置的旧安装）；
 *   3. PATH 与各平台常见包管理器目录中的 ffmpeg：
 *      macOS Homebrew/MacPorts，Linux 发行版/Snap/Linuxbrew，
 *      Windows winget/Scoop/Chocolatey。
 *
 * 全部依赖注入以便测试。
 */
function platformCandidates(platform, env, { join }) {
  if (platform === "win32") {
    return [
      env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Microsoft", "WinGet", "Links", "ffmpeg.exe"),
      env.USERPROFILE && join(env.USERPROFILE, "scoop", "shims", "ffmpeg.exe"),
      env.ProgramData && join(env.ProgramData, "chocolatey", "bin", "ffmpeg.exe"),
      "C:\\ffmpeg\\bin\\ffmpeg.exe"
    ].filter(Boolean);
  }
  if (platform === "darwin") return ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/opt/local/bin/ffmpeg"];
  return ["/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/snap/bin/ffmpeg", "/home/linuxbrew/.linuxbrew/bin/ffmpeg"];
}

export function resolveFfmpegPath({
  env = process.env,
  execPath = process.execPath,
  fileExists = existsSync,
  preferFull = false,
  platform = process.platform
} = {}) {
  const override = env.CODEX_COMPANION_FFMPEG;
  if (typeof override === "string" && override.trim() !== "" && fileExists(override)) {
    return override;
  }

  const paths = platform === "win32" ? path.win32 : path.posix;
  const binary = platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const execDir = paths.dirname(execPath);
  const candidates = [
    // 与二进制同级，以及 .app/Contents/MacOS/<bin> → .app/Contents/Resources/ffmpeg。
    paths.join(execDir, binary),
    ...(platform === "darwin" ? [paths.join(execDir, "..", "Resources", "ffmpeg")] : []),
    ...(preferFull && platform === "darwin" ? ["/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg", "/usr/local/opt/ffmpeg-full/bin/ffmpeg"] : []),
    ...searchPathCandidates([binary], { platform, env }),
    ...platformCandidates(platform, env, paths)
  ];
  for (const candidate of new Set(candidates)) {
    if (fileExists(candidate)) return candidate;
  }

  // 找不到时返回 null，让调用方抛出 FFMPEG_UNAVAILABLE。
  return null;
}
