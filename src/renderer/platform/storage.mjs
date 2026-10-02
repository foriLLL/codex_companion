export const STATE_CONFLICT = "STATE_CONFLICT";
export const STORAGE_QUOTA = "STORAGE_QUOTA";
export const STORAGE_CORRUPT = "STORAGE_CORRUPT";
export const STORAGE_INVALID = "STORAGE_INVALID";

export class StorageError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "StorageError";
    this.code = code;
    Object.assign(this, details);
  }
}

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
function storageError(cause, message) {
  if (cause instanceof StorageError) return cause;
  const quota = ["QuotaExceededError", "NS_ERROR_DOM_QUOTA_REACHED"].includes(cause?.name);
  return new StorageError(message, quota ? STORAGE_QUOTA : STORAGE_INVALID, { cause });
}

export function resolveScopeId(sessionStorage, { randomUUID = () => globalThis.crypto.randomUUID() } = {}) {
  try {
    const key = "companion.platform.scopeId";
    const existing = sessionStorage.getItem(key);
    if (typeof existing === "string" && existing) return existing;
    const id = randomUUID();
    if (typeof id !== "string" || !id) throw new Error("窗口标识无效");
    sessionStorage.setItem(key, id);
    return id;
  } catch (error) { throw storageError(error, "无法保存窗口标识"); }
}

// revision 防止同一 JS 上下文中的陈旧写入；跨窗口可变状态必须隔离 scope 或使用后端单一写入者。
export function createStore({ storage, namespace, version, scopeId, validate, migrate, onError } = {}) {
  if (!storage?.getItem || !storage?.setItem || typeof namespace !== "string" || !namespace
    || !Number.isSafeInteger(version) || version < 1) {
    throw new StorageError("存储参数无效", STORAGE_INVALID);
  }
  const key = scopeId ? `${namespace}::${scopeId}` : namespace;
  const status = { namespace, scopeId: scopeId || null, key, version, revision: null, lastError: null };
  function note(error) {
    status.lastError = { code: error.code, message: error.message };
    try { Promise.resolve(onError?.(error)).catch(() => {}); } catch {}
    return error;
  }
  function rawRecord(recordKey) {
    const raw = storage.getItem(recordKey);
    if (raw === null || raw === undefined) return null;
    let record;
    try { record = JSON.parse(raw); } catch (cause) {
      throw new StorageError("存档 JSON 损坏", STORAGE_CORRUPT, { cause, key: recordKey });
    }
    if (!isRecord(record) || !Number.isSafeInteger(record.version) || record.version < 1
      || !Number.isSafeInteger(record.revision) || record.revision < 1 || !own(record, "value")) {
      throw new StorageError("存档格式损坏", STORAGE_CORRUPT, { key: recordKey });
    }
    return record;
  }
  function validateValue(value) {
    if (validate && validate(value) !== true) throw new StorageError("存档校验失败", STORAGE_INVALID);
  }
  function compatible(record) {
    if (!record) return null;
    if (record.version > version) throw new StorageError("存档来自较新版本，已保留原数据", STORAGE_INVALID);
    let next = record;
    if (record.version !== version) {
      next = migrate?.(record, { from: record.version, to: version, key });
      if (!isRecord(next) || next.version !== version || !own(next, "value")) {
        throw new StorageError("存档迁移失败，已保留原数据", STORAGE_INVALID);
      }
    }
    validateValue(next.value);
    return { version, revision: record.revision, value: next.value };
  }
  function success(record) {
    status.revision = record?.revision ?? null;
    status.lastError = null;
  }
  function read(defaultValue) {
    try {
      const record = compatible(rawRecord(key));
      success(record);
      return { ok: true, value: record ? record.value : defaultValue, revision: record?.revision ?? null, error: null };
    } catch (cause) {
      const error = note(storageError(cause, "读取存档失败"));
      return { ok: false, value: defaultValue, revision: null, error };
    }
  }
  function persist(record) {
    const raw = JSON.stringify(record);
    // undefined / function / toJSON 等不能让表面成功的写入变成缺少 value 的损坏存档。
    if (!own(JSON.parse(raw), "value")) throw new StorageError("存档内容不可序列化", STORAGE_INVALID);
    storage.setItem(key, raw);
    success(record);
    return { ok: true, revision: record.revision, value: record.value };
  }
  function write(value, options = {}) {
    try {
      const current = compatible(rawRecord(key));
      const revision = current?.revision ?? null;
      if (own(options, "expectedRevision") && options.expectedRevision !== revision) {
        throw new StorageError("存档已由其他实例更新", STATE_CONFLICT, {
          expectedRevision: options.expectedRevision, actualRevision: revision
        });
      }
      validateValue(value);
      if (revision === Number.MAX_SAFE_INTEGER) throw new StorageError("存档版本号已达上限", STORAGE_INVALID);
      return persist({ version, revision: (revision ?? 0) + 1, value });
    } catch (cause) { throw note(storageError(cause, "写入存档失败")); }
  }
  function update(updater) {
    const current = read(undefined);
    if (!current.ok) throw current.error;
    return write(updater(current.value, { revision: current.revision }), { expectedRevision: current.revision });
  }
  function copyLegacy(sourceKey) {
    try {
      const current = rawRecord(key);
      if (current) return { ok: true, copied: false, revision: current.revision };
      const source = compatible(rawRecord(sourceKey));
      if (!source) return { ok: false, copied: false };
      persist(source);
      return { ok: true, copied: true, revision: source.revision };
    } catch (cause) {
      const error = note(storageError(cause, "复制旧存档失败"));
      if (error.code === STORAGE_QUOTA) throw error;
      return { ok: false, copied: false, error };
    }
  }
  return { key, read, write, update, copyLegacy, diagnostics: () => ({ ...status }) };
}
