import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { compareManifests, validateManifest } from "./manifest.mjs";

/**
 * 从卡片根目录发现 manifest。只扫描一级子目录，按目录名排序读取，
 * 结果按 defaultOrder、再按 id 稳定排序。校验器本身不访问文件系统。
 */

export class CardDiscoveryError extends Error {
  constructor(message, { code, id, directory } = {}) {
    super(message);
    this.name = "CardDiscoveryError";
    this.code = code;
    this.id = id;
    this.directory = directory;
  }
}

function discoveryError(code, message, extra) {
  throw new CardDiscoveryError(message, { code, ...extra });
}

async function isFile(path) {
  try {
    const info = await stat(path);
    return info.isFile();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

/**
 * @param {{ cardsDir: string, requireEntries?: boolean }} options
 * requireEntries 为 false 时只报告 renderer.mjs / service.mjs 是否存在。
 * 为 true 时每张卡必须有 renderer.mjs；service.mjs 始终可选。
 */
export async function discoverCards({ cardsDir, requireEntries = false } = {}) {
  if (typeof cardsDir !== "string" || cardsDir.length === 0) {
    discoveryError("INVALID_ARGUMENT", "cardsDir 必须是非空字符串");
  }
  const root = resolve(cardsDir);
  let dirents;
  try {
    dirents = await readdir(root, { withFileTypes: true });
  } catch (error) {
    discoveryError("CARDS_DIR_UNREADABLE", `无法读取卡片目录 ${root}: ${error.message}`);
  }

  const directoryNames = dirents
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => dirent.name)
    .sort((left, right) => left.localeCompare(right, "en"));

  const found = [];
  for (const directoryName of directoryNames) {
    const directory = join(root, directoryName);
    const manifestPath = join(directory, "manifest.json");
    let text;
    try {
      text = await readFile(manifestPath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") {
        discoveryError("MISSING_MANIFEST", `卡片目录 ${directoryName} 缺少 manifest.json`, { directory: directoryName });
      }
      discoveryError("MANIFEST_UNREADABLE", `无法读取 ${manifestPath}: ${error.message}`, { directory: directoryName });
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch (error) {
      discoveryError("INVALID_JSON", `无法解析 ${manifestPath}: ${error.message}`, { directory: directoryName });
    }
    const manifest = validateManifest(json);
    const renderer = await isFile(join(directory, "renderer.mjs"));
    const service = await isFile(join(directory, "service.mjs"));
    found.push({ directoryName, directory, manifest, entries: { renderer, service } });
  }

  const byId = new Map();
  for (const card of found) {
    const group = byId.get(card.manifest.id);
    if (group) group.push(card.directoryName);
    else byId.set(card.manifest.id, [card.directoryName]);
  }
  for (const [id, directories] of byId) {
    if (directories.length > 1) {
      discoveryError(
        "DUPLICATE_ID",
        `重复的卡片 id "${id}"（目录: ${directories.join(", ")}）`,
        { id, directory: directories.join(", ") }
      );
    }
  }

  for (const card of found) {
    if (card.manifest.id !== card.directoryName) {
      discoveryError(
        "ID_DIRECTORY_MISMATCH",
        `卡片目录 ${card.directoryName} 与 manifest id "${card.manifest.id}" 不一致`,
        { id: card.manifest.id, directory: card.directoryName }
      );
    }
  }

  if (requireEntries) {
    for (const card of found) {
      if (!card.entries.renderer) {
        discoveryError(
          "MISSING_RENDERER",
          `卡片 ${card.directoryName} 缺少 renderer.mjs`,
          { id: card.manifest.id, directory: card.directoryName }
        );
      }
    }
  }

  found.sort((left, right) => compareManifests(left.manifest, right.manifest));
  return {
    cards: found.map((card) => ({
      directoryName: card.directoryName,
      directory: card.directory,
      manifest: card.manifest,
      entries: { renderer: card.entries.renderer, service: card.entries.service }
    }))
  };
}
