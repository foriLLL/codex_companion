import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

/**
 * 用户配置文件：由配置界面（Swift 小窗）写入、Node 侧读取。
 * 权限 0600、原子写，参照 runtime-state / emby-storage 的既有约定。
 *
 * schema（version 1）：
 *   {
 *     version: 1,
 *     enabled: boolean,
 *     placement: "standalone-button" | "inline-in-summary",
 *     cards: { hongguo: boolean, emby: boolean },
 *     cardOrder: ["hongguo", "emby"]
 *   }
 *
 * enabled 是注入总开关：false 时守护进程对运行中的页面执行 unmount 并停止
 * 重挂载（daemon 本身不退，重新打开即恢复）。
 *
 * normalizeCompanionConfig 采用白名单 + 默认值策略：未知字段丢弃、非法值
 * 回退默认，保证未来新增配置项时旧版本二进制也能安全读取。
 */
export const COMPANION_CONFIG_VERSION = 1;

export const DEFAULT_CARDS = Object.freeze({ hongguo: true, emby: true });

// 卡片 ID 全集与默认顺序（缺失项总是补到末尾，保证顺序数组完整）。
export const CARD_IDS = Object.freeze(["hongguo", "emby"]);
export const DEFAULT_CARD_ORDER = Object.freeze([...CARD_IDS]);

// standalone-button：新增独立按钮控制卡片，与原生 Toggle Summary 互斥（默认）。
// inline-in-summary：卡片随原生 summary 一起显示（旧行为）。
export const PLACEMENTS = Object.freeze(["standalone-button", "inline-in-summary"]);
export const DEFAULT_PLACEMENT = "standalone-button";

export function defaultCompanionConfigPath(home = homedir()) {
  return join(home, "Library", "Application Support", "codex-companion", "config.json");
}

function normalizeCards(value) {
  const cards = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
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
  for (const id of CARD_IDS) {
    if (!order.includes(id)) order.push(id);
  }
  return order;
}

export function normalizeCompanionConfig(value) {
  const config = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    version: COMPANION_CONFIG_VERSION,
    enabled: typeof config.enabled === "boolean" ? config.enabled : true,
    placement: normalizePlacement(config.placement),
    cards: normalizeCards(config.cards),
    cardOrder: normalizeCardOrder(config.cardOrder)
  };
}

export class CompanionConfig {
  constructor(options = {}) {
    this.path = options.path ?? defaultCompanionConfigPath();
    this.randomUUIDImpl = options.randomUUIDImpl ?? randomUUID;
  }

  /** 读取配置；文件缺失、不可读或损坏时一律回退默认——配置异常不应阻止主流程启动。 */
  async load() {
    try {
      return normalizeCompanionConfig(JSON.parse(await readFile(this.path, "utf8")));
    } catch {
      return normalizeCompanionConfig(null);
    }
  }

  async save(config) {
    const normalized = normalizeCompanionConfig(config);
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true });
    const temporary = join(directory, `.config-${process.pid}-${this.randomUUIDImpl()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      await rename(temporary, this.path);
      await chmod(this.path, 0o600);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
    return normalized;
  }
}
