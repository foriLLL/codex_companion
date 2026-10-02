import { chmod, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { CARD_MANIFESTS } from "./card-registry.mjs";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

/**
 * v2 是唯一写入格式。旧 config.json 仅作迁移输入，load()/save() 暂保留旧调用形状。
 * 新消费者使用 loadV2()/patch()；Swift 与其他写入者均通过 revision + 文件锁提交。
 */
export const COMPANION_CONFIG_VERSION = 2;

export const DEFAULT_CARDS = Object.freeze(Object.fromEntries(CARD_MANIFESTS.map(card => [card.id, card.defaultEnabled])));

// 卡片 ID 全集与默认顺序（缺失项总是补到末尾，保证顺序数组完整）。
export const CARD_IDS = Object.freeze(CARD_MANIFESTS.map(card => card.id));
export const DEFAULT_CARD_ORDER = Object.freeze([...CARD_IDS]);

// standalone-button：独立 Shadow DOM 入口与浮层，不依赖原生 Summary（默认）。
// inline-in-summary：卡片排在原生 summary 下方，一起滚动与开合。
export const PLACEMENTS = Object.freeze(["standalone-button", "inline-in-summary"]);
export const DEFAULT_PLACEMENT = "standalone-button";

export function defaultCompanionConfigPath(home = homedir()) {
  return join(home, "Library", "Application Support", "codex-companion", "config-v2.json");
}

function normalizeCards(value) {
  const cards = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    games: typeof cards.games === "boolean" ? cards.games : DEFAULT_CARDS.games,
    hongguo: typeof cards.hongguo === "boolean" ? cards.hongguo : DEFAULT_CARDS.hongguo,
    riverclub: typeof cards.riverclub === "boolean" ? cards.riverclub : DEFAULT_CARDS.riverclub,
    emby: typeof cards.emby === "boolean" ? cards.emby : DEFAULT_CARDS.emby
  };
}

function normalizePlacement(value) {
  return PLACEMENTS.includes(value) ? value : DEFAULT_PLACEMENT;
}

// 卡片顺序：白名单过滤 + 去重 + 缺失项补末尾。旧配置没有 cardOrder 字段、
// 或未来新增卡片时，都能归一化成完整顺序。
export function normalizeCardOrder(value) {
  const order = [];
  if (Array.isArray(value)) {
    for (const id of value) {
      if (CARD_IDS.includes(id) && !order.includes(id)) order.push(id);
    }
  }
  for (const id of ["hongguo", "emby"]) {
    if (!order.includes(id)) order.push(id);
  }
  if (!order.includes("riverclub")) order.splice(order.indexOf("hongguo") + 1, 0, "riverclub");
  if (!order.includes("games")) order.unshift("games");
  return order;
}

// 邀请链接仅存本机配置；网页入口 RPC 不接受任意 URL 或 shell 参数。
export function normalizeRiverclubUrl(value) {
  try {
    const url = new URL(value);
    if (url.origin === "https://riverclub.booocai.com" && !url.username && !url.password) return url.href;
  } catch {}
  return "https://riverclub.booocai.com/";
}

export function normalizeCompanionConfig(value) {
  if (value?.version === 2) return toLegacyCompanionConfig(value);
  const config = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    version: 1,
    enabled: typeof config.enabled === "boolean" ? config.enabled : true,
    placement: normalizePlacement(config.placement),
    cards: normalizeCards(config.cards),
    cardOrder: normalizeCardOrder(config.cardOrder),
    riverclubUrl: normalizeRiverclubUrl(config.riverclubUrl)
  };
}

// v1 的卡片名单、邀请链接和插入顺序只保留在兼容转换中。
const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
const safeId = id => /^[a-z][a-z0-9-]*$/.test(id) && !["constructor", "prototype", "__proto__"].includes(id);
const clone = value => JSON.parse(JSON.stringify(value));

export class ConfigError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    Object.assign(this, details);
  }
}

export function normalizeCompanionConfigV2(value, manifests = CARD_MANIFESTS) {
  const input = isRecord(value) ? value : {};
  const legacy = input.version !== 2 ? normalizeCompanionConfig(input) : null;
  const cards = {};
  for (const [id, card] of Object.entries(input.cards ?? {})) {
    if (!safeId(id)) continue;
    if (typeof card === "boolean") cards[id] = { enabled: card, settings: {} };
    else if (isRecord(card)) cards[id] = {
      ...clone(card), enabled: typeof card.enabled === "boolean" ? card.enabled : false,
      settings: isRecord(card.settings) ? clone(card.settings) : {}
    };
  }
  for (const manifest of manifests) {
    cards[manifest.id] ??= { enabled: legacy?.cards[manifest.id] ?? manifest.defaultEnabled, settings: {} };
  }
  if (legacy && cards.riverclub && (Object.hasOwn(input, "riverclubUrl") || !Object.hasOwn(cards.riverclub.settings, "url"))) {
    cards.riverclub.settings.url = legacy.riverclubUrl;
  }
  const requested = legacy ? legacy.cardOrder : input.order;
  const order = [...new Set((Array.isArray(requested) ? requested : []).filter(id => typeof id === "string" && safeId(id)))];
  for (const id of [...manifests.map(card => card.id), ...Object.keys(cards)]) if (!order.includes(id)) order.push(id);
  return {
    version: 2,
    revision: Number.isSafeInteger(input.revision) && input.revision >= 0 ? input.revision : 0,
    enabled: typeof input.enabled === "boolean" ? input.enabled : true,
    placement: normalizePlacement(input.placement), order, cards
  };
}

export function toLegacyCompanionConfig(value) {
  const config = value?.version === 2 ? value : normalizeCompanionConfigV2(value);
  return {
    version: 1, enabled: config.enabled, placement: config.placement,
    cards: Object.fromEntries(Object.entries(config.cards).map(([id, card]) => [id, card.enabled])),
    cardOrder: [...config.order], riverclubUrl: normalizeRiverclubUrl(config.cards.riverclub?.settings?.url)
  };
}

// 迁移只接受字段缺省，不把已提供但类型损坏的值当作「启用」默认值。
function validateLegacyConfig(value) {
  if (!isRecord(value) || (Object.hasOwn(value, "version") && value.version !== 1)
    || (Object.hasOwn(value, "enabled") && typeof value.enabled !== "boolean")
    || (Object.hasOwn(value, "placement") && !PLACEMENTS.includes(value.placement))
    || (Object.hasOwn(value, "riverclubUrl") && typeof value.riverclubUrl !== "string")
    || (Object.hasOwn(value, "cardOrder") && (!Array.isArray(value.cardOrder)
      || value.cardOrder.some(id => typeof id !== "string" || !safeId(id))))
    || (Object.hasOwn(value, "cards") && (!isRecord(value.cards)
      || Object.entries(value.cards).some(([id, card]) => !safeId(id) || (typeof card !== "boolean"
        && (!isRecord(card) || (Object.hasOwn(card, "enabled") && typeof card.enabled !== "boolean")
          || (Object.hasOwn(card, "settings") && !isRecord(card.settings)))))))) {
    throw new ConfigError("CONFIG_MIGRATION_INVALID", "旧配置字段类型无效；保留原文件，请修复后重试。");
  }
}

function validateV2(value) {
  if (!isRecord(value) || value.version !== 2 || !Number.isSafeInteger(value.revision) || value.revision < 0
    || typeof value.enabled !== "boolean" || !PLACEMENTS.includes(value.placement)
    || !Array.isArray(value.order) || value.order.some(id => typeof id !== "string" || !safeId(id))
    || !isRecord(value.cards) || Object.entries(value.cards).some(([id, card]) => !safeId(id)
      || !isRecord(card) || typeof card.enabled !== "boolean" || !isRecord(card.settings))) {
    throw new ConfigError("CONFIG_INVALID", "配置 v2 格式无效；保留文件，请修复后重试。");
  }
}

function applyPatch(current, patch, manifests) {
  if (!isRecord(patch) || Object.keys(patch).some(key => !["enabled", "placement", "order", "cards"].includes(key))) {
    throw new ConfigError("CONFIG_PATCH_INVALID", "补丁只能包含 enabled、placement、order、cards。");
  }
  const next = clone(current);
  for (const key of ["enabled", "placement", "order"]) if (Object.hasOwn(patch, key)) next[key] = patch[key];
  if (Object.hasOwn(patch, "cards")) {
    if (!isRecord(patch.cards)) throw new ConfigError("CONFIG_PATCH_INVALID", "cards 必须是对象。");
    for (const [id, card] of Object.entries(patch.cards)) {
      if (!safeId(id) || !isRecord(card) || Object.keys(card).some(key => !["enabled", "settings"].includes(key))
        || (Object.hasOwn(card, "settings") && !isRecord(card.settings))) {
        throw new ConfigError("CONFIG_PATCH_INVALID", "卡片补丁格式无效。");
      }
      const previous = next.cards[id] ?? { enabled: false, settings: {} };
      next.cards[id] = { ...previous, ...card, settings: { ...previous.settings, ...card.settings } };
    }
  }
  validateV2(next);
  if (next.cards.riverclub?.settings.url !== undefined) {
    next.cards.riverclub.settings.url = normalizeRiverclubUrl(next.cards.riverclub.settings.url);
  }
  return normalizeCompanionConfigV2(next, manifests);
}

export class CompanionConfig {
  constructor(options = {}) {
    this.path = options.path ?? process.env.CODEX_COMPANION_CONFIG_PATH ?? defaultCompanionConfigPath();
    this.legacyPath = options.legacyPath ?? join(dirname(this.path), "config.json");
    this.manifests = options.manifests ?? CARD_MANIFESTS;
    this.randomUUIDImpl = options.randomUUIDImpl ?? randomUUID;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 3000;
    this.lastGood = null;
    this.lastError = null;
  }

  async withLock(operation) {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const lockPath = `${this.path}.lock`;
    const started = Date.now();
    let lock;
    while (!lock) {
      try { lock = await open(lockPath, "wx", 0o600); }
      catch (error) {
        if (error.code !== "EEXIST") throw error;
        if (Date.now() - started >= this.lockTimeoutMs) throw new ConfigError("CONFIG_LOCKED", "配置正被其他进程写入；若写入进程已退出，请移除遗留 lock 文件。" );
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid }));
      return await operation();
    } finally {
      await lock.close();
      await unlink(lockPath);
    }
  }

  async atomicWrite(path, value) {
    const temporary = join(dirname(path), `.config-${process.pid}-${this.randomUUIDImpl()}.tmp`);
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(value); await file.sync(); } finally { await file.close(); }
      await rename(temporary, path);
      await chmod(path, 0o600);
    } finally { await unlink(temporary).catch(() => {}); }
  }

  async readV2() {
    let parsed;
    try { parsed = JSON.parse(await readFile(this.path, "utf8")); }
    catch (error) {
      if (error.code === "ENOENT") throw error;
      throw new ConfigError("CONFIG_INVALID", "无法读取有效配置；保留原文件。", { cause: error });
    }
    validateV2(parsed);
    return normalizeCompanionConfigV2(parsed, this.manifests);
  }

  async readOrMigrate() {
    try { return await this.readV2(); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (this.lastGood) throw new ConfigError("CONFIG_MISSING", "配置文件已消失；保留上次有效配置，等待恢复。");
    let legacy = null;
    let original;
    if (this.legacyPath !== this.path) {
      try {
        original = await readFile(this.legacyPath, "utf8");
        legacy = JSON.parse(original);
        validateLegacyConfig(legacy);
      } catch (error) {
        if (error.code !== "ENOENT") throw new ConfigError("CONFIG_MIGRATION_INVALID", "旧配置损坏；未覆盖旧文件或创建新配置。", { cause: error });
      }
    }
    if (original !== undefined) {
      try { await writeFile(`${this.legacyPath}.v1.bak`, original, { mode: 0o600, flag: "wx" }); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
    }
    const config = normalizeCompanionConfigV2(legacy, this.manifests);
    await this.atomicWrite(this.path, `${JSON.stringify(config, null, 2)}\n`);
    return config;
  }

  async loadV2({ strict = false } = {}) {
    try {
      let next;
      try { next = await this.readV2(); }
      catch (error) {
        if (error.code !== "ENOENT") throw error;
        next = await this.withLock(() => this.readOrMigrate());
      }
      this.lastGood = clone(next);
      this.lastError = null;
      return next;
    } catch (error) {
      this.lastError = error;
      if (!strict && this.lastGood) return clone(this.lastGood);
      throw error;
    }
  }

  async load() { return toLegacyCompanionConfig(await this.loadV2()); }

  async patch(patch, { expectedRevision } = {}) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new ConfigError("CONFIG_REVISION_REQUIRED", "必须提供 expectedRevision。");
    return this.withLock(async () => {
      const current = await this.readOrMigrate();
      if (current.revision !== expectedRevision) throw new ConfigError("CONFIG_CONFLICT", "配置已变化，请刷新后重试。", { revision: current.revision });
      const next = applyPatch(current, patch, this.manifests);
      next.revision = current.revision + 1;
      await this.atomicWrite(this.path, `${JSON.stringify(next, null, 2)}\n`);
      this.lastGood = clone(next);
      return next;
    });
  }

  // 旧调用点临时兼容；只更新调用者明确提交的字段，不覆盖未知卡片设置。
  async save(value) {
    const current = await this.loadV2({ strict: true });
    const patch = {};
    for (const key of ["enabled", "placement"]) if (Object.hasOwn(value, key)) patch[key] = value[key];
    if (value.cardOrder || value.order) patch.order = value.order ?? normalizeCardOrder(value.cardOrder);
    if (value.cards) patch.cards = Object.fromEntries(Object.entries(value.cards).map(([id, card]) => [id, typeof card === "boolean" ? { enabled: card } : card]));
    if (value.riverclubUrl !== undefined) {
      patch.cards ??= {};
      patch.cards.riverclub = { ...patch.cards.riverclub, settings: { ...patch.cards.riverclub?.settings, url: normalizeRiverclubUrl(value.riverclubUrl) } };
    }
    const next = await this.patch(patch, { expectedRevision: value.revision ?? current.revision });
    return value.version === 2 ? next : toLegacyCompanionConfig(next);
  }
}
