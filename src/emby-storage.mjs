import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { EmbyError } from "./emby-client.mjs";

const execFileAsync = promisify(execFile);
export const KEYCHAIN_SERVICE = "codex-companion.emby";
export const LEGACY_KEYCHAIN_SERVICE = "codex-hg.emby";
const HOME_CACHE_FILE_LIMIT = 4 * 1024 * 1024;

export function defaultEmbyConfigPath(home = homedir()) {
  return join(home, "Library", "Application Support", "codex-companion", "emby.json");
}

export function defaultEmbyHomeCachePath(home = homedir()) {
  return join(home, "Library", "Application Support", "codex-companion", "emby-home.json");
}

export function legacyEmbyConfigPath(home = homedir()) {
  return join(home, "Library", "Application Support", "codex-hg", "emby.json");
}

export function legacyEmbyHomeCachePath(home = homedir()) {
  return join(home, "Library", "Application Support", "codex-hg", "emby-home.json");
}

export function keychainAccount(serverId, userId) {
  if (!serverId || !userId) throw new EmbyError("INVALID_ACCOUNT", "缺少 Emby ServerId 或 UserId");
  return `${serverId}:${userId}`;
}

export function embyServerKey(configOrServerId, userId) {
  const serverId = typeof configOrServerId === "object" ? configOrServerId?.serverId : configOrServerId;
  const resolvedUserId = typeof configOrServerId === "object" ? configOrServerId?.userId : userId;
  if (!serverId || !resolvedUserId) throw new EmbyError("INVALID_ACCOUNT", "缺少 Emby ServerId 或 UserId");
  return `${serverId}:${resolvedUserId}`;
}

function publicConfig(config) {
  if (!config || typeof config !== "object") return null;
  return {
    baseUrl: String(config.baseUrl ?? ""),
    serverId: String(config.serverId ?? ""),
    userId: String(config.userId ?? ""),
    username: String(config.username ?? ""),
    deviceId: String(config.deviceId ?? "")
  };
}

function homeData(value) {
  return value
    && typeof value === "object"
    && Array.isArray(value.views)
    && Array.isArray(value.resume)
    && Array.isArray(value.latest)
    ? { views: value.views, resume: value.resume, latest: value.latest }
    : null;
}

function publicState(state) {
  const servers = Array.isArray(state?.servers)
    ? state.servers.map(publicConfig).filter((config) => (
      config?.baseUrl && config.serverId && config.userId && config.username && config.deviceId
    ))
    : [];
  const keys = new Set(servers.map((config) => embyServerKey(config)));
  const requestedActiveKey = String(state?.activeServerKey ?? "");
  return {
    version: 2,
    activeServerKey: keys.has(requestedActiveKey) ? requestedActiveKey : (servers[0] ? embyServerKey(servers[0]) : null),
    servers
  };
}

export class EmbyStorage {
  constructor(options = {}) {
    this.configPath = options.configPath ?? defaultEmbyConfigPath();
    this.homeCachePath = options.homeCachePath ?? defaultEmbyHomeCachePath();
    this.legacyConfigPath = options.legacyConfigPath
      ?? (options.configPath === undefined ? legacyEmbyConfigPath() : null);
    this.legacyHomeCachePath = options.legacyHomeCachePath
      ?? (options.homeCachePath === undefined ? legacyEmbyHomeCachePath() : null);
    this.execFileImpl = options.execFileImpl ?? execFileAsync;
    this.platform = options.platform ?? process.platform;
    this.randomUUIDImpl = options.randomUUIDImpl ?? randomUUID;
  }

  async loadConfig() {
    const state = await this.loadState();
    if (!state?.activeServerKey) return null;
    return state.servers.find((config) => embyServerKey(config) === state.activeServerKey) ?? null;
  }

  async loadState() {
    let contents;
    let loadedPath = this.configPath;
    try {
      contents = await readFile(this.configPath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT" && this.legacyConfigPath) {
        loadedPath = this.legacyConfigPath;
        try {
          contents = await readFile(loadedPath, "utf8");
        } catch (legacyError) {
          if (legacyError.code === "ENOENT") return null;
          throw new EmbyError("CONFIG_READ_FAILED", "无法读取旧版 Emby 配置", { cause: legacyError });
        }
      } else if (error.code === "ENOENT") {
        return null;
      } else {
        throw new EmbyError("CONFIG_READ_FAILED", "无法读取 Emby 配置", { cause: error });
      }
    }

    let parsed;
    try {
      parsed = JSON.parse(contents);
    } catch (cause) {
      throw new EmbyError("CONFIG_INVALID", "Emby 配置文件不是有效 JSON", { cause });
    }
    let state;
    if (parsed?.version === 2 || Array.isArray(parsed?.servers)) {
      state = publicState(parsed);
      if (parsed?.servers?.length > 0 && state.servers.length !== parsed.servers.length) {
        throw new EmbyError("CONFIG_INVALID", "Emby 服务器列表包含不完整配置");
      }
    } else {
      const config = publicConfig(parsed);
      if (!config?.deviceId) throw new EmbyError("CONFIG_INVALID", "Emby 配置缺少 DeviceId");
      state = publicState({ activeServerKey: embyServerKey(config), servers: [config] });
    }
    await chmod(loadedPath, 0o600);
    if (loadedPath !== this.configPath) await this.saveState(state);
    return state;
  }

  async saveConfig(config) {
    const safe = publicConfig(config);
    if (!safe?.baseUrl || !safe.serverId || !safe.userId || !safe.username || !safe.deviceId) {
      throw new EmbyError("CONFIG_INVALID", "Emby 连接配置不完整");
    }

    const current = await this.loadState();
    const key = embyServerKey(safe);
    const servers = current?.servers ? [...current.servers] : [];
    const existingIndex = servers.findIndex((entry) => embyServerKey(entry) === key);
    if (existingIndex >= 0) servers[existingIndex] = safe;
    else servers.push(safe);
    await this.saveState({ activeServerKey: key, servers });
    return safe;
  }

  async saveState(state) {
    const safe = publicState(state);
    if ((state?.servers?.length ?? 0) !== safe.servers.length) {
      throw new EmbyError("CONFIG_INVALID", "Emby 服务器连接配置不完整");
    }
    const directory = dirname(this.configPath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `.emby-${process.pid}-${this.randomUUIDImpl()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(safe, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      await rename(temporary, this.configPath);
      await chmod(this.configPath, 0o600);
    } catch (cause) {
      await unlink(temporary).catch(() => {});
      throw new EmbyError("CONFIG_WRITE_FAILED", "无法保存 Emby 配置", { cause });
    }
    return safe;
  }

  async loadHomeCache(serverId, userId) {
    let contents;
    let loadedPath = this.homeCachePath;
    try {
      contents = await readFile(this.homeCachePath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT" && this.legacyHomeCachePath) {
        loadedPath = this.legacyHomeCachePath;
        try {
          contents = await readFile(loadedPath, "utf8");
        } catch (legacyError) {
          if (legacyError.code === "ENOENT") return null;
          throw new EmbyError("CACHE_READ_FAILED", "无法读取旧版 Emby 首页缓存", { cause: legacyError });
        }
      } else if (error.code === "ENOENT") {
        return null;
      } else {
        throw new EmbyError("CACHE_READ_FAILED", "无法读取 Emby 首页缓存", { cause: error });
      }
    }
    if (Buffer.byteLength(contents) > HOME_CACHE_FILE_LIMIT) return null;
    let parsed;
    try {
      parsed = JSON.parse(contents);
    } catch {
      return null;
    }
    const at = Number(parsed?.at);
    const data = homeData(parsed?.data);
    if (
      !Number.isFinite(at)
      || at <= 0
      || String(parsed?.serverId ?? "") !== String(serverId)
      || String(parsed?.userId ?? "") !== String(userId)
      || !data
    ) return null;
    await chmod(loadedPath, 0o600);
    const snapshot = { at, data };
    if (loadedPath !== this.homeCachePath) await this.saveHomeCache(serverId, userId, snapshot);
    return snapshot;
  }

  async saveHomeCache(serverId, userId, snapshot) {
    const at = Number(snapshot?.at);
    const data = homeData(snapshot?.data);
    if (!serverId || !userId || !Number.isFinite(at) || at <= 0 || !data) return;
    const serialized = `${JSON.stringify({ serverId, userId, at, data })}\n`;
    if (Buffer.byteLength(serialized) > HOME_CACHE_FILE_LIMIT) return;

    const directory = dirname(this.homeCachePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `.emby-home-${process.pid}-${this.randomUUIDImpl()}.tmp`);
    try {
      await writeFile(temporary, serialized, { mode: 0o600, flag: "wx" });
      await rename(temporary, this.homeCachePath);
      await chmod(this.homeCachePath, 0o600);
    } catch (cause) {
      await unlink(temporary).catch(() => {});
      throw new EmbyError("CACHE_WRITE_FAILED", "无法保存 Emby 首页缓存", { cause });
    }
  }

  // 登出时清掉磁盘上的首页缓存，避免私有库标题/缩略图在盘上残留。
  // 首页缓存文件同一时刻只存一个服务器的数据；删除是幂等的。
  async clearHomeCache() {
    for (const path of [this.homeCachePath, this.legacyHomeCachePath]) {
      if (!path) continue;
      try {
        await unlink(path);
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw new EmbyError("CACHE_DELETE_FAILED", "无法删除 Emby 首页缓存", { cause: error });
        }
      }
    }
  }

  createDeviceId(existingConfig = null) {
    return existingConfig?.deviceId || this.randomUUIDImpl();
  }

  async readToken(serverId, userId) {
    this.#assertMacOS();
    const account = keychainAccount(serverId, userId);
    for (const service of [KEYCHAIN_SERVICE, LEGACY_KEYCHAIN_SERVICE]) {
      try {
        const { stdout } = await this.execFileImpl("/usr/bin/security", [
          "find-generic-password",
          "-s", service,
          "-a", account,
          "-w"
        ]);
        const token = String(stdout ?? "").replace(/[\r\n]+$/, "");
        if (!token) return null;
        if (service === LEGACY_KEYCHAIN_SERVICE) await this.saveToken(serverId, userId, token);
        return token;
      } catch (cause) {
        if (cause?.code === 44 || /could not be found|not found/i.test(cause?.stderr ?? "")) continue;
        throw new EmbyError("KEYCHAIN_READ_FAILED", "无法从 macOS 钥匙串读取 Emby 登录信息", { cause });
      }
    }
    return null;
  }

  async saveToken(serverId, userId, token) {
    this.#assertMacOS();
    if (!token) throw new EmbyError("INVALID_TOKEN", "Emby AccessToken 为空");
    const account = keychainAccount(serverId, userId);
    try {
      await this.execFileImpl("/usr/bin/security", [
        "add-generic-password",
        "-U",
        "-s", KEYCHAIN_SERVICE,
        "-a", account,
        "-w", token
      ]);
    } catch (cause) {
      throw new EmbyError("KEYCHAIN_WRITE_FAILED", "无法写入 macOS 钥匙串", { cause });
    }
  }

  async deleteToken(serverId, userId) {
    this.#assertMacOS();
    const account = keychainAccount(serverId, userId);
    let deleted = false;
    for (const service of [KEYCHAIN_SERVICE, LEGACY_KEYCHAIN_SERVICE]) {
      try {
        await this.execFileImpl("/usr/bin/security", [
          "delete-generic-password",
          "-s", service,
          "-a", account
        ]);
        deleted = true;
      } catch (cause) {
        if (cause?.code === 44 || /could not be found|not found/i.test(cause?.stderr ?? "")) continue;
        throw new EmbyError("KEYCHAIN_DELETE_FAILED", "无法删除 macOS 钥匙串中的 Emby 登录信息", { cause });
      }
    }
    return deleted;
  }

  #assertMacOS() {
    if (this.platform !== "darwin") {
      throw new EmbyError("UNSUPPORTED_PLATFORM", "第一版 Emby 凭证存储仅支持 macOS Keychain");
    }
  }
}
