import { randomBytes } from "node:crypto";
import { chmod, lstat, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { defaultCodexHome } from "./codex-sessions.mjs";

// 「长任务先列计划」：在 Codex 全局指令文件里维护一段带标记的提示，让 Codex 用自带的 update_plan
// 拆步骤、同步进度，任务看板据此显示计划。只增删标记之间的内容，文件里其它文字原样保留；
// 关闭开关或卸载 Companion 时删除。Codex 只在新会话开始时读取这个文件。

export const PLAN_HINT_START = "<!-- codex-companion:plan-hint 由 Codex Companion 维护，在 Companion 设置里关闭即可删除 -->";
export const PLAN_HINT_END = "<!-- /codex-companion:plan-hint -->";
export const PLAN_HINT_BODY = [
  "## 任务计划",
  "- 预计要 3 步以上或超过 5 分钟的任务，动手前先用 update_plan 列出步骤：每步一句话，按执行顺序排列。",
  "- 每完成一步立即用 update_plan 更新状态，同一时间只有一个 in_progress；计划有变就随时修改。",
  "- 简单问答、一两步就能完成的任务不用列计划。"
].join("\n");
// 连同前面的空行一起匹配；标记行的说明文字以后可能改，只认固定前缀。
const BLOCK = /\n*<!-- codex-companion:plan-hint\b[^\n]*-->\n[\s\S]*?<!-- \/codex-companion:plan-hint -->\n?/;
const FILE_LIMIT = 1024 * 1024;
// Codex 的全局指令：AGENTS.override.md 非空时只读它，否则读 AGENTS.md。
const OVERRIDE = "AGENTS.override.md";
const DEFAULT = "AGENTS.md";

export function hasHint(text) {
  return BLOCK.test(text);
}

export function withoutHint(text) {
  let result = text;
  for (let match = BLOCK.exec(result); match; match = BLOCK.exec(result)) {
    // 在文件中间时留一个空行隔开前后文字；在开头或末尾时直接去掉。
    const edge = match.index === 0 || match.index + match[0].length >= result.length;
    result = `${result.slice(0, match.index)}${edge ? "" : "\n\n"}${result.slice(match.index + match[0].length)}`;
  }
  if (result === text) return text;
  return result && !result.endsWith("\n") ? `${result}\n` : result;
}

export function withHint(text) {
  const base = withoutHint(text).replace(/\n+$/, "");
  return `${base ? `${base}\n\n` : ""}${PLAN_HINT_START}\n${PLAN_HINT_BODY}\n${PLAN_HINT_END}\n`;
}

async function readTarget(path) {
  let real;
  try { real = await realpath(path); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    // 断开的符号链接：不替换用户的链接。
    const link = await lstat(path).catch(() => null);
    if (link) throw Object.assign(new Error(`${path} 是指向不存在文件的链接`), { code: "PLAN_HINT_BROKEN_LINK" });
    return { real: path, text: null, mode: 0o644 };
  }
  const info = await stat(real);
  if (!info.isFile()) throw Object.assign(new Error(`${path} 不是普通文件`), { code: "PLAN_HINT_NOT_FILE" });
  if (info.size > FILE_LIMIT) throw Object.assign(new Error(`${path} 太大`), { code: "PLAN_HINT_TOO_LARGE" });
  return { real, text: await readFile(real, "utf8"), mode: info.mode & 0o777 };
}

// 改写一个文件：符号链接写到它指向的文件，同目录临时文件 + rename，保留原权限；改完为空就删掉。
async function edit(path, transform) {
  const { real, text, mode } = await readTarget(path);
  const next = transform(text ?? "");
  if (next === (text ?? "")) return false;
  if (!next) {
    await unlink(real).catch((error) => { if (error.code !== "ENOENT") throw error; });
    return true;
  }
  const temporary = join(dirname(real), `.${basename(real)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    await writeFile(temporary, next, { mode, flag: "wx" });
    await chmod(temporary, mode);
    await rename(temporary, real);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return true;
}

async function nonEmptyFile(path) {
  try { const info = await stat(path); return info.isFile() && info.size > 0; } catch { return false; }
}

export function createPlanHint({ codexHome = defaultCodexHome() } = {}) {
  const paths = { override: join(codexHome, OVERRIDE), main: join(codexHome, DEFAULT) };
  async function target() {
    return (await nonEmptyFile(paths.override)) ? paths.override : paths.main;
  }
  return {
    paths,
    /** 提示当前是否在 Codex 实际读取的那个文件里。 */
    async status() {
      const path = await target();
      const { text } = await readTarget(path).catch(() => ({ text: null }));
      return { enabled: Boolean(text && hasHint(text)), path };
    },
    /** 开启时写进 Codex 实际读取的文件并从另一个文件里去掉；关闭时两个文件都去掉。返回是否改动了文件。 */
    async set(enabled) {
      const chosen = enabled ? await target() : null;
      let changed = false;
      for (const path of [paths.main, paths.override]) {
        if (path === chosen) changed = (await edit(path, withHint)) || changed;
        else if (path !== paths.override || await nonEmptyFile(path)) changed = (await edit(path, withoutHint)) || changed;
      }
      return changed;
    }
  };
}
