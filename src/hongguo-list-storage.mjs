import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const LIST_FILE_LIMIT = 1 * 1024 * 1024;
const MAX_ENTRIES = 200;
const ID_PATTERN = /^[0-9]{1,32}$/;

export function defaultHongguoListPath(home = homedir()) {
  return join(home, "Library", "Application Support", "codex-companion", "hongguo-list.json");
}

/** 只保留白名单字段，并做基本校验；无效项返回 null。 */
export function normalizeListEntry(value) {
  if (!value || typeof value !== "object") return null;
  const id = String(value.id ?? "").trim();
  if (!ID_PATTERN.test(id)) return null;
  const name = typeof value.name === "string" ? value.name.slice(0, 200) : "";
  const posterUrl = typeof value.posterUrl === "string" ? value.posterUrl.slice(0, 2048) : "";
  return { id, name, posterUrl };
}

function normalizeList(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const result = [];
  for (const raw of value) {
    const entry = normalizeListEntry(raw);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    result.push(entry);
    if (result.length >= MAX_ENTRIES) break;
  }
  return result;
}

/**
 * 「我的片单」持久化：本地 0600 原子写，存 {id,name,posterUrl} 数组（最新在前）。
 * 参照 HongguoCatalogStorage 的写法。文件缺失/损坏一律回退空列表，绝不抛给调用方。
 */
export class HongguoListStorage {
  constructor(options = {}) {
    this.path = options.path ?? defaultHongguoListPath();
    this.randomUUIDImpl = options.randomUUIDImpl ?? randomUUID;
  }

  async load() {
    let contents;
    try {
      contents = await readFile(this.path, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return [];
      return [];
    }
    if (Buffer.byteLength(contents) > LIST_FILE_LIMIT) return [];
    try {
      return normalizeList(JSON.parse(contents)?.items);
    } catch {
      return [];
    }
  }

  async save(items) {
    const normalized = normalizeList(items);
    const serialized = `${JSON.stringify({ version: 1, items: normalized }, null, 2)}\n`;
    if (Buffer.byteLength(serialized) > LIST_FILE_LIMIT) return normalized;

    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `.hongguo-list-${process.pid}-${this.randomUUIDImpl()}.tmp`);
    try {
      await writeFile(temporary, serialized, { mode: 0o600, flag: "wx" });
      await rename(temporary, this.path);
      await chmod(this.path, 0o600);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
    return normalized;
  }

  /** 加入片单（去重，置顶为最新）。返回更新后的列表。 */
  async add(entry) {
    const normalized = normalizeListEntry(entry);
    if (!normalized) return this.load();
    const current = await this.load();
    const filtered = current.filter((item) => item.id !== normalized.id);
    return this.save([normalized, ...filtered]);
  }

  /** 从片单移除。返回更新后的列表。 */
  async remove(id) {
    const target = String(id ?? "").trim();
    const current = await this.load();
    return this.save(current.filter((item) => item.id !== target));
  }
}
