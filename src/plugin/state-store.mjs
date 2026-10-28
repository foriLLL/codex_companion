import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CompanionConfig, defaultCompanionConfigPath } from "../companion-config.mjs";

const MAX_VALUE_BYTES = 128 * 1024;
const MAX_STORE_BYTES = 192 * 1024;
const fail = (code, message) => Object.assign(new Error(message), { code });
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function validateKey(key) {
  if (typeof key !== "string" || key.length === 0 || key.length > 256
    || /[\u0000-\u001f\u007f]/.test(key) || ["__proto__", "prototype", "constructor"].includes(key)) {
    throw fail("STORAGE_INVALID", "存档名称无效");
  }
}

// 游戏和卡片状态保存在插件自己的文件，不依赖宿主 iframe 的 localStorage 生命周期。
// 使用配置存储相同的文件锁和原子写入，多个宿主进程不会覆盖彼此的增量更新。
export class PluginStateStore {
  constructor({ path = join(dirname(defaultCompanionConfigPath()), "plugin-state.json") } = {}) {
    this.path = path;
    this.file = new CompanionConfig({ path });
  }

  async read() {
    let raw;
    try { raw = await readFile(this.path, "utf8"); }
    catch (error) { if (error.code === "ENOENT") return { version: 1, revision: 0, entries: {} }; throw error; }
    try {
      if (Buffer.byteLength(raw) > MAX_STORE_BYTES) throw new Error();
      const value = JSON.parse(raw);
      if (value?.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0
        || !value.entries || typeof value.entries !== "object" || Array.isArray(value.entries)) throw new Error();
      for (const [key, entry] of Object.entries(value.entries)) {
        validateKey(key);
        if (!entry || typeof entry.value !== "string" || !Number.isSafeInteger(entry.revision) || entry.revision < 1) throw new Error();
      }
      return value;
    } catch { throw fail("STORAGE_CORRUPT", "插件存档格式损坏，已保留原文件"); }
  }

  async get(key) {
    if (key !== undefined) validateKey(key);
    const state = await this.read();
    if (key !== undefined) return { key, value: state.entries[key]?.value ?? null, revision: state.entries[key]?.revision ?? null, storeRevision: state.revision };
    return {
      entries: Object.fromEntries(Object.entries(state.entries).map(([name, entry]) => [name, entry.value])),
      revisions: Object.fromEntries(Object.entries(state.entries).map(([name, entry]) => [name, entry.revision])),
      revision: state.revision
    };
  }

  async set(key, value, options = {}) {
    validateKey(key);
    if (value !== null && (typeof value !== "string" || Buffer.byteLength(value) > MAX_VALUE_BYTES)) throw fail("STORAGE_QUOTA", "单项存档超过大小限制");
    if (own(options, "expectedRevision") && options.expectedRevision !== null
      && (!Number.isSafeInteger(options.expectedRevision) || options.expectedRevision < 1)) throw fail("STORAGE_INVALID", "存档版本无效");
    return this.file.withLock(async () => {
      const state = await this.read();
      const previous = state.entries[key]?.revision ?? null;
      if (own(options, "expectedRevision") && options.expectedRevision !== previous) throw fail("STATE_CONFLICT", "存档已由其他页面更新，请刷新后重试");
      if (state.revision === Number.MAX_SAFE_INTEGER) throw fail("STORAGE_INVALID", "存档版本号已达上限");
      state.revision += 1;
      if (value === null) delete state.entries[key];
      else state.entries[key] = { value, revision: state.revision };
      const serialized = `${JSON.stringify(state)}\n`;
      if (Buffer.byteLength(serialized) > MAX_STORE_BYTES) throw fail("STORAGE_QUOTA", "插件存档空间已满");
      await this.file.atomicWrite(this.path, serialized);
      return { key, value, revision: state.entries[key]?.revision ?? null, storeRevision: state.revision };
    });
  }
}
