import { chmod, link, mkdir, open, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { CARD_MANIFESTS } from "./card-registry.mjs";
import { completeCardOrder } from "./platform/config/runtime-config.mjs";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { companionDataDir } from "./platform/paths.mjs";
import { replaceFile } from "./platform/replace-file.mjs";

const execFileAsync = promisify(execFile);

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
export const DEFAULT_LAUNCH = Object.freeze({ proxy: Object.freeze({ enabled: false, port: 7890 }) });
export const DEFAULT_AGENT = Object.freeze({ autoRelaunch: true });

export function defaultCompanionConfigPath(home = homedir()) {
  return join(companionDataDir(home), "config-v2.json");
}

function normalizeCards(value) {
  const cards = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    games: typeof cards.games === "boolean" ? cards.games : DEFAULT_CARDS.games,
    hongguo: typeof cards.hongguo === "boolean" ? cards.hongguo : DEFAULT_CARDS.hongguo,
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
  if (!order.includes("games")) order.unshift("games");
  return order;
}

export function normalizeCompanionConfig(value) {
  if (value?.version === 2) return toLegacyCompanionConfig(value);
  const config = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    version: 1,
    enabled: typeof config.enabled === "boolean" ? config.enabled : true,
    placement: normalizePlacement(config.placement),
    cards: normalizeCards(config.cards),
    cardOrder: normalizeCardOrder(config.cardOrder)
  };
}

// v1 的卡片名单与插入顺序只保留在兼容转换中；已下线卡片的旧字段直接忽略。
const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
const safeId = id => /^[a-z][a-z0-9-]*$/.test(id) && !["constructor", "prototype", "__proto__"].includes(id);
const clone = value => JSON.parse(JSON.stringify(value));
const validPort = value => Number.isInteger(value) && value >= 1 && value <= 65535;

// 新字段允许缺省，但显式提供的错误值不能经 normalize 悄悄恢复成默认值。
function validLaunch(value) {
  return isRecord(value) && Object.keys(value).every(key => key === "proxy")
    && (!Object.hasOwn(value, "proxy") || (isRecord(value.proxy)
      && Object.keys(value.proxy).every(key => ["enabled", "port"].includes(key))
      && (!Object.hasOwn(value.proxy, "enabled") || typeof value.proxy.enabled === "boolean")
      && (!Object.hasOwn(value.proxy, "port") || validPort(value.proxy.port))));
}

function validAgent(value) {
  return isRecord(value) && Object.keys(value).every(key => key === "autoRelaunch")
    && (!Object.hasOwn(value, "autoRelaunch") || typeof value.autoRelaunch === "boolean");
}

async function hasDeadLockOwner(path) {
  let file;
  try {
    file = await open(path, "r");
    if ((await file.stat()).size > 128) return false;
    const { pid } = JSON.parse(await file.readFile("utf8"));
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 0x7fffffff) return false;
    try { process.kill(pid, 0); }
    catch (error) { return error.code === "ESRCH"; }
    return false;
  } catch { return false; }
  finally { await file?.close(); }
}

const EMPTY_GUARD_STALE_MS = 10_000;

async function removeIfDeadOwner(path) {
  if (await hasDeadLockOwner(path)) await unlink(path).catch(error => { if (error.code !== "ENOENT") throw error; });
}

async function recoverDeadLock(path) {
  // 只回收可证明已经退出的 PID。空文件、损坏内容、权限不足和 PID 重用均保守等待。
  if (!await hasDeadLockOwner(path)) return;
  // 多个回收者必须串行并重新读取；否则第二个回收者可能误删第一个回收后新写入者
  // 刚建立的锁。guard 用独占创建 + owner PID 实现（Windows/Linux/macOS 通用），
  // 回收者自身崩溃留下的 guard 同样按「owner 已退出」回收，下一轮重试。
  const guardPath = `${path}.recovery`;
  let guard;
  try {
    guard = await open(guardPath, "wx", 0o600);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    await removeIfDeadOwner(guardPath);
    // 创建后、写入 PID 前崩溃会留下空 guard：超过宽限期仍为空才视为遗留。
    const info = await stat(guardPath).catch(() => null);
    if (info?.size === 0 && Date.now() - info.mtimeMs > EMPTY_GUARD_STALE_MS) await unlink(guardPath).catch(() => {});
    return;
  }
  try {
    await guard.writeFile(JSON.stringify({ pid: process.pid }));
    await guard.sync();
    await removeIfDeadOwner(path);
  } finally {
    await guard.close();
    await unlink(guardPath).catch(() => {});
  }
}

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
  const order = completeCardOrder(legacy ? legacy.cardOrder : input.order, manifests, Object.keys(cards));
  return {
    version: 2,
    revision: Number.isSafeInteger(input.revision) && input.revision >= 0 ? input.revision : 0,
    enabled: typeof input.enabled === "boolean" ? input.enabled : true,
    placement: normalizePlacement(input.placement), order, cards,
    launch: { proxy: {
      enabled: typeof input.launch?.proxy?.enabled === "boolean" ? input.launch.proxy.enabled : DEFAULT_LAUNCH.proxy.enabled,
      port: validPort(input.launch?.proxy?.port) ? input.launch.proxy.port : DEFAULT_LAUNCH.proxy.port
    } },
    agent: { autoRelaunch: typeof input.agent?.autoRelaunch === "boolean" ? input.agent.autoRelaunch : DEFAULT_AGENT.autoRelaunch }
  };
}

export function toLegacyCompanionConfig(value) {
  const config = value?.version === 2 ? value : normalizeCompanionConfigV2(value);
  return {
    version: 1, enabled: config.enabled, placement: config.placement,
    cards: Object.fromEntries(Object.entries(config.cards).map(([id, card]) => [id, card.enabled])),
    cardOrder: [...config.order]
  };
}

// 迁移只接受字段缺省，不把已提供但类型损坏的值当作「启用」默认值。
function validateLegacyConfig(value) {
  if (!isRecord(value) || (Object.hasOwn(value, "version") && value.version !== 1)
    || (Object.hasOwn(value, "enabled") && typeof value.enabled !== "boolean")
    || (Object.hasOwn(value, "placement") && !PLACEMENTS.includes(value.placement))
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
      || !isRecord(card) || typeof card.enabled !== "boolean" || !isRecord(card.settings))
    || (Object.hasOwn(value, "launch") && !validLaunch(value.launch))
    || (Object.hasOwn(value, "agent") && !validAgent(value.agent))) {
    throw new ConfigError("CONFIG_INVALID", "配置 v2 格式无效；保留文件，请修复后重试。");
  }
}

function applyPatch(current, patch, manifests) {
  if (!isRecord(patch) || Object.keys(patch).some(key => !["enabled", "placement", "order", "cards", "launch", "agent"].includes(key))) {
    throw new ConfigError("CONFIG_PATCH_INVALID", "补丁只能包含 enabled、placement、order、cards、launch、agent。");
  }
  const next = clone(current);
  for (const key of ["enabled", "placement", "order"]) if (Object.hasOwn(patch, key)) next[key] = patch[key];
  if (Object.hasOwn(patch, "launch")) {
    if (!validLaunch(patch.launch)) throw new ConfigError("CONFIG_PATCH_INVALID", "launch.proxy 只允许布尔 enabled 和 1–65535 的整数 port。");
    next.launch.proxy = { ...next.launch.proxy, ...patch.launch.proxy };
  }
  if (Object.hasOwn(patch, "agent")) {
    if (!validAgent(patch.agent)) throw new ConfigError("CONFIG_PATCH_INVALID", "agent 只允许布尔 autoRelaunch。");
    next.agent = { ...next.agent, ...patch.agent };
  }
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
  return normalizeCompanionConfigV2(next, manifests);
}

export class CompanionConfig {
  constructor(options = {}) {
    this.path = options.path ?? process.env.CODEX_COMPANION_CONFIG_PATH ?? defaultCompanionConfigPath();
    this.legacyPath = options.legacyPath ?? join(dirname(this.path), "config.json");
    this.manifests = options.manifests ?? CARD_MANIFESTS;
    this.platform = options.platform ?? process.platform;
    this.readFileImpl = options.readFileImpl ?? readFile;
    this.execFileImpl = options.execFileImpl ?? execFileAsync;
    this.randomUUIDImpl = options.randomUUIDImpl ?? randomUUID;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 3000;
    this.lastGood = null;
    this.lastError = null;
    this.legacyLaunchPromise = null;
  }

  async withLock(operation) {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const lockPath = `${this.path}.lock`;
    const candidate = join(dirname(this.path), `.lock-${process.pid}-${this.randomUUIDImpl()}.tmp`);
    const started = Date.now();
    let lock;
    let acquired = false;
    try {
      // 先完成 owner 记录，再以原子的 hard-link 发布锁；异常退出不会留下
      // 无法判断归属的空锁，同时兼容旧版本已经写好的 { pid } 锁文件。
      lock = await open(candidate, "wx", 0o600);
      await lock.writeFile(JSON.stringify({ pid: process.pid }));
      await lock.sync();
      while (!acquired) {
        try { await link(candidate, lockPath); acquired = true; }
        catch (error) {
          if (error.code !== "EEXIST") throw error;
          await recoverDeadLock(lockPath);
          if (Date.now() - started >= this.lockTimeoutMs) throw new ConfigError("CONFIG_LOCKED", "配置正被其他进程写入，或锁文件归属不明；请稍后重试。" );
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      }
      await unlink(candidate);
      return await operation();
    } finally {
      try { if (acquired) await unlink(lockPath); }
      finally { await lock?.close(); if (lock) await unlink(candidate).catch(() => {}); }
    }
  }

  async atomicWrite(path, value) {
    const temporary = join(dirname(path), `.config-${process.pid}-${this.randomUUIDImpl()}.tmp`);
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(value); await file.sync(); } finally { await file.close(); }
      await replaceFile(temporary, path);
      await chmod(path, 0o600);
    } finally { await unlink(temporary).catch(() => {}); }
  }

  async readV2() {
    let parsed;
    try { parsed = JSON.parse(await this.readFileImpl(this.path, "utf8")); }
    catch (error) {
      if (error.code === "ENOENT") throw error;
      throw new ConfigError("CONFIG_INVALID", "无法读取有效配置；保留原文件。", { cause: error });
    }
    validateV2(parsed);
    // 读取旧 v2 只补内存值，保持 revision 与磁盘内容不变；下次成功 patch 才落盘。
    if (Object.hasOwn(parsed, "launch")) this.legacyLaunchPromise = null;
    else parsed.launch = await this.readLegacyLaunch();
    return normalizeCompanionConfigV2(parsed, this.manifests);
  }

  readLegacyLaunch() {
    // watcher 与并发读取共享同一次迁移，避免重复执行 defaults 或在同 revision 下漂移。
    return this.legacyLaunchPromise ??= this.readLegacyLaunchDefaults();
  }

  async readLegacyLaunchDefaults() {
    // 旧 Swift 启动器只发布过 macOS 版本，其它平台没有可导入的偏好。
    if (this.platform !== "darwin") return clone(DEFAULT_LAUNCH);
    const read = async key => {
      try { return (await this.execFileImpl("/usr/bin/defaults", ["read", "com.codexcompanion.launcher", key], { timeout: 3000 })).stdout.trim(); }
      catch { return null; }
    };
    const enabled = await read("launchThroughProxy");
    const port = Number(await read("launchProxyPort"));
    return { proxy: { enabled: ["1", "true", "YES"].includes(enabled), port: validPort(port) ? port : DEFAULT_LAUNCH.proxy.port } };
  }

  async readOrMigrate() {
    try { return await this.readV2(); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (this.lastGood) throw new ConfigError("CONFIG_MISSING", "配置文件已消失；保留上次有效配置，等待恢复。");
    let legacy = null;
    let original;
    if (this.legacyPath !== this.path) {
      try {
        original = await this.readFileImpl(this.legacyPath, "utf8");
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
    const config = normalizeCompanionConfigV2({ ...legacy, launch: await this.readLegacyLaunch() }, this.manifests);
    await this.atomicWrite(this.path, `${JSON.stringify(config, null, 2)}\n`);
    this.legacyLaunchPromise = null;
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
      this.legacyLaunchPromise = null;
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
    const next = await this.patch(patch, { expectedRevision: value.revision ?? current.revision });
    return value.version === 2 ? next : toLegacyCompanionConfig(next);
  }
}
