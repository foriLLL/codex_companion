import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const SYSTEMD_UNIT = "codex-companion-agent.service";
export const LINUX_AGENT_PATH = "/usr/local/bin:/usr/bin:/bin";
export const DESKTOP_ENTRY = "chatgpt.desktop";
export const DESKTOP_MARKER = "X-Codex-Companion-Override=true";

// 与 companionDataDir 一致：只有真实用户目录才读 XDG 变量，隔离的 home 不被带回真实目录。
export function linuxLocations({ home = homedir(), env } = {}) {
  env ??= home === homedir() ? process.env : {};
  const dir = (name, fallback) => (env[name] && isAbsolute(env[name]) ? env[name] : fallback);
  const configHome = dir("XDG_CONFIG_HOME", join(home, ".config"));
  const dataHome = dir("XDG_DATA_HOME", join(home, ".local", "share"));
  const dataDirs = String(env.XDG_DATA_DIRS || "/usr/local/share:/usr/share").split(":").filter(isAbsolute);
  return {
    unitPath: join(configHome, "systemd", "user", SYSTEMD_UNIT),
    applicationsDir: join(dataHome, "applications"),
    desktopPath: join(dataHome, "applications", DESKTOP_ENTRY),
    systemDesktopPaths: dataDirs.map((directory) => join(directory, "applications", DESKTOP_ENTRY))
  };
}

// systemd 单元文件：参数一律加双引号；% 是说明符，$ 会被展开，都要转义。
const systemdQuote = (value) => `"${String(value).replace(/[\\"]/g, "\\$&").replace(/%/g, "%%").replace(/\$/g, "$$$$")}"`;

export function buildSystemdUnit({ programArguments, environment = {} }) {
  return `[Unit]
Description=Codex Companion agent
Documentation=https://github.com/foriLLL/codex_companion

[Service]
Type=simple
ExecStart=${programArguments.map(systemdQuote).join(" ")}
${Object.entries(environment).map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`).join("\n")}
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`;
}

// Desktop Entry 规范：含保留字符的参数加双引号并转义 " ` $ \；整个值再按字符串规则把 \ 写成 \\；% 写成 %%。
function desktopQuote(arg) {
  const text = String(arg);
  const quoted = /[\s"'\\><~|&;$*?#()`]/.test(text) ? `"${text.replace(/["`$\\]/g, "\\$&")}"` : text;
  return quoted.replace(/\\/g, "\\\\").replace(/%/g, "%%");
}

// Exec 值的第一个参数（程序）结束的位置；带引号时跳过转义字符。
function programEnd(value) {
  if (!value.startsWith("\"")) {
    const space = value.search(/\s/);
    return space === -1 ? value.length : space;
  }
  for (let index = 1; index < value.length; index += 1) {
    if (value[index] === "\\") index += 1;
    else if (value[index] === "\"") return index + 1;
  }
  return value.length;
}

/**
 * 由系统的 chatgpt.desktop 生成用户级覆盖：只把每个 Exec 的程序换成 Companion 启动入口，
 * 其余参数（%U）、MimeType（codex:// 等协议）与动作原样保留。DBusActivatable 会绕过 Exec，去掉。
 */
export function buildDesktopOverride(source, launcherArguments) {
  const launcher = launcherArguments.map(desktopQuote).join(" ");
  const lines = [];
  for (const line of String(source).split("\n")) {
    if (/^DBusActivatable\s*=/.test(line) || line === DESKTOP_MARKER) continue;
    const exec = line.match(/^Exec\s*=\s*(.*)$/);
    if (exec) {
      lines.push(`Exec=${launcher}${exec[1].slice(programEnd(exec[1]))}`);
      continue;
    }
    lines.push(line);
    if (line.trim() === "[Desktop Entry]") lines.push(DESKTOP_MARKER);
  }
  if (!lines.includes(DESKTOP_MARKER)) throw new Error("ChatGPT 桌面入口缺少 [Desktop Entry]");
  return lines.join("\n");
}

async function readOptional(path) {
  try { return await readFile(path, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function replaceFile(path, text, mode) {
  await mkdir(dirname(path), { recursive: true, mode: 0o755 });
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, text, { mode, flag: "wx" });
    await chmod(temporary, mode);
    await rename(temporary, path);
  } finally { await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; }); }
}

const ownsDesktopEntry = (text) => text !== null && text.split("\n").includes(DESKTOP_MARKER);

async function refreshDesktopDatabase(directory, run) {
  // 只影响 MimeType 关联缓存；缺少 update-desktop-database 时菜单仍按文件生效。
  await run("update-desktop-database", [directory]).catch(() => {});
}

export async function installLinuxAgent({
  home, env, programArguments, launcherArguments, environment = {}, execFileImpl = execFileAsync
}) {
  const locations = linuxLocations({ home, env });
  const run = (file, args) => execFileImpl(file, args);
  // 先确认能接管菜单入口，再改动系统服务，失败时不留下半套安装。
  const current = await readOptional(locations.desktopPath);
  if (current !== null && !ownsDesktopEntry(current)) {
    throw Object.assign(new Error(`${locations.desktopPath} 已存在且不是 Companion 生成的，未覆盖；如不再需要请手动删除后重试`), { code: "DESKTOP_ENTRY_CONFLICT" });
  }
  let source = null;
  for (const candidate of locations.systemDesktopPaths) {
    source = await readOptional(candidate);
    if (source !== null) break;
  }
  if (source === null) {
    throw Object.assign(new Error("未找到 ChatGPT 的桌面入口（chatgpt.desktop），请先安装 ChatGPT 桌面版"), { code: "CODEX_NOT_INSTALLED" });
  }
  await replaceFile(locations.desktopPath, buildDesktopOverride(source, launcherArguments), 0o644);
  await refreshDesktopDatabase(locations.applicationsDir, run);
  await replaceFile(locations.unitPath, buildSystemdUnit({ programArguments, environment: { PATH: LINUX_AGENT_PATH, ...environment } }), 0o644);
  await run("systemctl", ["--user", "daemon-reload"]);
  await run("systemctl", ["--user", "enable", SYSTEMD_UNIT]);
  // restart 在未运行时等同 start，升级后也能换上新版本。
  await run("systemctl", ["--user", "restart", SYSTEMD_UNIT]);
  return { installed: true, unit: SYSTEMD_UNIT, unitPath: locations.unitPath, desktopPath: locations.desktopPath };
}

export async function uninstallLinuxAgent({ home, env, execFileImpl = execFileAsync }) {
  const locations = linuxLocations({ home, env });
  const run = (file, args) => execFileImpl(file, args);
  if (await readOptional(locations.unitPath) !== null) {
    await run("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT]);
    await unlink(locations.unitPath).catch((error) => { if (error.code !== "ENOENT") throw error; });
    await run("systemctl", ["--user", "daemon-reload"]);
  }
  let desktopRemoved = false;
  if (ownsDesktopEntry(await readOptional(locations.desktopPath))) {
    await unlink(locations.desktopPath);
    await refreshDesktopDatabase(locations.applicationsDir, run);
    desktopRemoved = true;
  }
  return { unit: SYSTEMD_UNIT, desktopRemoved };
}
