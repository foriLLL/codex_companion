import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import ffmpegStaticPath from "ffmpeg-static";

/**
 * 解析 FFmpeg 可执行文件路径。
 *
 * `bun --compile` 单文件产物里 `ffmpeg-static` 解析出的是**构建机**的
 * node_modules 绝对路径，分发到用户机后不存在。因此运行时按优先级解析：
 *   1. 环境变量 CODEX_COMPANION_FFMPEG（显式覆盖）；
 *   2. 相对可执行文件的 sidecar（.app/Contents/Resources 或与二进制同级）；
 *   3. ffmpeg-static 的 import 结果（开发态、Node 直跑）。
 *
 * 全部依赖注入以便测试。
 */
export function resolveFfmpegPath({
  env = process.env,
  execPath = process.execPath,
  fileExists = existsSync,
  staticPath = ffmpegStaticPath
} = {}) {
  const override = env.CODEX_COMPANION_FFMPEG;
  if (typeof override === "string" && override.trim() !== "" && fileExists(override)) {
    return override;
  }

  const execDir = dirname(execPath);
  // .app/Contents/MacOS/<bin> → .app/Contents/Resources/ffmpeg；以及与二进制同级的 ffmpeg。
  const sidecarCandidates = [
    join(execDir, "ffmpeg"),
    join(execDir, "..", "Resources", "ffmpeg")
  ];
  for (const candidate of sidecarCandidates) {
    if (fileExists(candidate)) return candidate;
  }

  if (typeof staticPath === "string" && staticPath !== "" && fileExists(staticPath)) {
    return staticPath;
  }

  // 找不到时返回 null，让调用方抛出 FFMPEG_UNAVAILABLE。
  return null;
}
