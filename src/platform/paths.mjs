import { homedir } from "node:os";
import path from "node:path";

// 按目标平台选择路径语义，便于在任意宿主上测试其它平台的规则。
const pathsFor = (platform) => (platform === "win32" ? path.win32 : path.posix);

// Companion 本机数据目录：配置、缓存、存档与运行时状态都放在这里。
// - macOS：~/Library/Application Support/codex-companion（与早期版本一致）
// - Windows：%APPDATA%\codex-companion
// - Linux 等：$XDG_CONFIG_HOME/codex-companion，未设置时 ~/.config/codex-companion
// 未显式传 env 时，只有真实用户目录才读取 APPDATA / XDG_CONFIG_HOME：测试或隔离用的
// home 不能被当前进程的环境变量带回真实数据目录。
export function companionDataDir(home = homedir(), { platform = process.platform, env, name = "codex-companion" } = {}) {
  const { isAbsolute, join } = pathsFor(platform);
  env ??= home === homedir() ? process.env : {};
  if (platform === "darwin") return join(home, "Library", "Application Support", name);
  if (platform === "win32") {
    const appData = env.APPDATA && isAbsolute(env.APPDATA) ? env.APPDATA : join(home, "AppData", "Roaming");
    return join(appData, name);
  }
  const configHome = env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(home, ".config");
  return join(configHome, name);
}

// 旧版本（codex-hg）只发布过 macOS；其它平台返回同规则下的目录，迁移时自然不存在。
export function legacyCompanionDataDir(home = homedir(), options = {}) {
  return companionDataDir(home, { ...options, name: "codex-hg" });
}

// child 是否严格位于 parent 之内（不含 parent 本身）；只做词法判断，调用方按需先 realpath。
export function isPathInside(child, parent, { platform = process.platform } = {}) {
  const paths = pathsFor(platform);
  const relativePath = paths.relative(parent, child);
  return Boolean(relativePath) && relativePath !== ".." && !relativePath.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relativePath);
}

// 按 PATH 顺序列出可执行文件候选路径（不检查是否存在）。Windows 的变量名大小写
// 不固定（Path / PATH），条目可能带引号。
export function searchPathCandidates(names, { platform = process.platform, env = process.env } = {}) {
  const paths = pathsFor(platform);
  const value = platform === "win32"
    ? Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1]
    : env.PATH;
  return String(value ?? "")
    .split(paths.delimiter)
    .map((directory) => directory.replace(/^"(.*)"$/, "$1"))
    .filter(Boolean)
    .flatMap((directory) => names.map((name) => paths.join(directory, name)));
}
