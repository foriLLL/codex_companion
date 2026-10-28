import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { companionDataDir, legacyCompanionDataDir } from "./platform/paths.mjs";

const CACHE_FILE_LIMIT = 4 * 1024 * 1024;

export function defaultHongguoCachePath(home = homedir()) {
  return join(companionDataDir(home), "hongguo-home.json");
}

export function legacyHongguoCachePath(home = homedir()) {
  return join(legacyCompanionDataDir(home), "hongguo-home.json");
}

function validCatalog(catalog) {
  return catalog
    && typeof catalog === "object"
    && Array.isArray(catalog.featured)
    && Array.isArray(catalog.items)
    ? catalog
    : null;
}

export class HongguoCatalogStorage {
  constructor(options = {}) {
    this.cachePath = options.cachePath ?? defaultHongguoCachePath();
    this.legacyCachePath = options.legacyCachePath
      ?? (options.cachePath === undefined ? legacyHongguoCachePath() : null);
    this.randomUUIDImpl = options.randomUUIDImpl ?? randomUUID;
  }

  async load() {
    let contents;
    let loadedPath = this.cachePath;
    try {
      contents = await readFile(this.cachePath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT" && this.legacyCachePath) {
        loadedPath = this.legacyCachePath;
        try {
          contents = await readFile(loadedPath, "utf8");
        } catch (legacyError) {
          if (legacyError.code === "ENOENT") return null;
          throw legacyError;
        }
      } else if (error.code === "ENOENT") {
        return null;
      } else {
        throw error;
      }
    }
    if (Buffer.byteLength(contents) > CACHE_FILE_LIMIT) return null;
    let parsed;
    try {
      parsed = JSON.parse(contents);
    } catch {
      return null;
    }
    const at = Number(parsed?.at);
    const data = validCatalog(parsed?.data);
    if (!Number.isFinite(at) || at <= 0 || !data) return null;
    const snapshot = { at, data };
    if (loadedPath !== this.cachePath) await this.save(snapshot);
    return snapshot;
  }

  async save(snapshot) {
    const at = Number(snapshot?.at);
    const data = validCatalog(snapshot?.data);
    if (!Number.isFinite(at) || at <= 0 || !data) return;
    const serialized = `${JSON.stringify({ at, data })}\n`;
    if (Buffer.byteLength(serialized) > CACHE_FILE_LIMIT) return;

    const directory = dirname(this.cachePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `.hongguo-${process.pid}-${this.randomUUIDImpl()}.tmp`);
    try {
      await writeFile(temporary, serialized, { mode: 0o600, flag: "wx" });
      await rename(temporary, this.cachePath);
      await chmod(this.cachePath, 0o600);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }
}
