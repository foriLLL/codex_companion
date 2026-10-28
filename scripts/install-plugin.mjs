import { execFile } from "node:child_process";
import { access, mkdir, readFile, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { backendFileName, buildPlugin } from "./build-plugin.mjs";
import { isPathInside, searchPathCandidates } from "../src/platform/paths.mjs";

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const PLUGIN_ID = "codex-companion@codex-companion-local";
export const MARKETPLACE = "codex-companion-local";

// macOS 优先使用桌面端附带的 CLI；其它平台（以及 macOS 回退）在 PATH 中查找，
// 覆盖 npm 全局安装的 codex / codex.cmd 与独立发行的 codex.exe。
export function codexCliCandidates({ platform = process.platform, env = process.env } = {}) {
  if (platform === "win32") {
    return [
      ...searchPathCandidates(["codex.exe", "codex.cmd"], { platform, env }),
      ...(env.APPDATA ? [`${env.APPDATA}\\npm\\codex.cmd`] : [])
    ];
  }
  return [
    ...(platform === "darwin" ? [
      "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
      "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex"
    ] : []),
    ...searchPathCandidates(["codex"], { platform, env })
  ];
}

export async function findCodexCli(explicit, options = {}) {
  const candidates = explicit ? [resolve(explicit)] : codexCliCandidates(options);
  for (const candidate of new Set(candidates)) {
    // Windows 上 X_OK 等同于存在性检查。
    try { await access(candidate, constants.X_OK); return candidate; } catch {}
  }
  throw new Error("找不到 Codex CLI；请先安装 Codex，或用 --cli 指定可执行文件。");
}

// Node 不允许不经 shell 直接执行 Windows 的 .cmd/.bat（npm 全局安装的 codex 即为 codex.cmd）。
// 经 cmd.exe 执行时整条命令自行加引号；参数里的引号、% 与换行会被 cmd 解释，直接拒绝。
export function cliInvocation(cli, args, { platform = process.platform, env = process.env } = {}) {
  if (platform !== "win32" || !/\.(cmd|bat)$/i.test(cli)) return { file: cli, args, options: {} };
  const parts = [cli, ...args].map((part) => {
    if (/["%\r\n]/.test(part)) throw new Error(`参数含有 cmd.exe 无法安全传递的字符：${part}`);
    return `"${part}"`;
  });
  return {
    file: env.ComSpec || "cmd.exe",
    args: ["/d", "/s", "/c", `"${parts.join(" ")}"`],
    options: { windowsVerbatimArguments: true }
  };
}

// 只注册本插件；不重启 Codex、不修改安装包、不更改其他插件、MCP 服务或认证。
export async function installPlugin({ pluginDir = join(root, "dist", "plugin"), codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex"), cliPath, rebuild = false } = {}) {
  if (rebuild) await buildPlugin({ outDir: pluginDir });
  pluginDir = resolve(pluginDir);
  codexHome = resolve(codexHome);
  const assertOutside = () => {
    if (codexHome === pluginDir || isPathInside(codexHome, pluginDir)) throw new Error("Codex 配置目录不能放在待安装插件内部。");
  };
  assertOutside();
  const manifest = JSON.parse(await readFile(join(pluginDir, ".codex-plugin", "plugin.json"), "utf8"));
  if (manifest.name !== "codex-companion") throw new Error("所选目录不是 Companion 插件包。");
  const backend = backendFileName(`${process.platform}-${process.arch}`);
  await access(join(pluginDir, backend), constants.X_OK).catch(() => {
    throw new Error(`插件包缺少本机后端 ${backend}；请用对应平台的构建（npm run build:plugin）。`);
  });
  await access(join(pluginDir, "ui.html"));
  pluginDir = await realpath(pluginDir);
  assertOutside();
  const cli = await findCodexCli(cliPath);
  // CLI 不会自动创建显式 CODEX_HOME；全新本地安装与隔离验收也应能运行。
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  codexHome = await realpath(codexHome);
  assertOutside();
  const env = { ...process.env, CODEX_HOME: codexHome };
  const runCli = (args, options = {}) => {
    const invocation = cliInvocation(cli, args);
    return run(invocation.file, invocation.args, { cwd: homedir(), env, timeout: 45000, windowsHide: true, ...invocation.options, ...options });
  };
  const command = async args => {
    const { stdout } = await runCli(args, { maxBuffer: 2 * 1024 * 1024 });
    return stdout.trim() ? JSON.parse(stdout) : null;
  };
  const current = await command(["plugin", "list", "--json"]);
  const replacing = (current.installed ?? []).some(plugin => plugin.pluginId === PLUGIN_ID);
  const marketplaces = await command(["plugin", "marketplace", "list", "--json"]);
  const previous = marketplaces.marketplaces?.find(marketplace => marketplace.name === MARKETPLACE);
  const previousSource = previous?.marketplaceSource;
  const previousPath = previousSource?.sourceType === "local" ? await realpath(previousSource.source).catch(() => resolve(previousSource.source)) : null;
  const marketplaceReplaced = Boolean(previous && previousPath !== pluginDir);
  if (marketplaceReplaced) {
    if (!previousPath || (current.installed ?? []).some(plugin => plugin.marketplaceName === MARKETPLACE && plugin.pluginId !== PLUGIN_ID)) {
      throw new Error("同名 marketplace 已用于其他来源或插件；已保留其配置，请使用独立的 Companion 本地 marketplace。");
    }
    // 项目移动位置后，官方 CLI 要求先移除同名来源。只更新自己的本地
    // marketplace，添加失败时尽力恢复旧来源；不操作其他 marketplace。
    await command(["plugin", "marketplace", "remove", MARKETPLACE, "--json"]);
    try { await command(["plugin", "marketplace", "add", pluginDir, "--json"]); }
    catch (error) {
      await command(["plugin", "marketplace", "add", previousSource.source, "--json"]).catch(() => {});
      throw error;
    }
  } else await command(["plugin", "marketplace", "add", pluginDir, "--json"]);
  // 同版本本地源码也可能有更新；只移除自己的旧缓存，再由官方 CLI 重新安装。
  if (replacing) await runCli(["plugin", "remove", PLUGIN_ID]);
  await command(["plugin", "add", PLUGIN_ID, "--json"]);
  const inventory = await command(["plugin", "list", "--marketplace", MARKETPLACE, "--json"]);
  const plugin = (inventory.installed ?? []).find(plugin => plugin.pluginId === PLUGIN_ID);
  if (!plugin?.installed || !plugin.enabled) throw new Error("官方 CLI 没有确认插件安装并启用。");
  return { installed: true, enabled: true, version: plugin.version, replaced: replacing, marketplaceReplaced, pluginId: PLUGIN_ID, codexHome,
    restartRequired: true, nextStep: "保存当前工作并手动重启 Codex，然后在聊天中请求「打开 Companion」。" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = { rebuild: true };
  const args = process.argv.slice(2);
  while (args.length) {
    const flag = args.shift();
    if (flag === "--no-build") options.rebuild = false;
    else if (flag === "--codex-home") options.codexHome = args.shift();
    else if (flag === "--cli") options.cliPath = args.shift();
    else if (flag === "--plugin-dir") options.pluginDir = args.shift();
    else throw new Error(`未知参数：${flag}`);
  }
  installPlugin(options).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
    console.error(`插件安装失败：${error.message}`);
    process.exitCode = 1;
  });
}
