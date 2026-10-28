import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  EmbyStorage,
  KEYCHAIN_SERVICE,
  LEGACY_KEYCHAIN_SERVICE,
  embyServerKey
} from "../src/emby-storage.mjs";
import { assertMode } from "./helpers/permissions.mjs";

test("配置只保存非敏感字段、权限为 0600 且 DeviceId 稳定", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-companion-emby-storage-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, "nested", "emby.json");
  const storage = new EmbyStorage({
    configPath,
    randomUUIDImpl: () => "stable-device",
    execFileImpl: async () => ({ stdout: "" })
  });
  const deviceId = storage.createDeviceId(null);
  await storage.saveConfig({
    baseUrl: "https://emby.example/emby",
    serverId: "server",
    userId: "user",
    username: "alice",
    deviceId,
    password: "must-not-persist",
    accessToken: "must-not-persist"
  });

  const raw = await readFile(configPath, "utf8");
  assert.doesNotMatch(raw, /must-not-persist|password|accessToken/i);
  assertMode(await stat(configPath), 0o600);
  const loaded = await storage.loadConfig();
  assert.equal(loaded.deviceId, "stable-device");
  assert.equal(storage.createDeviceId(loaded), "stable-device");
  const persisted = JSON.parse(raw);
  assert.equal(persisted.version, 2);
  assert.equal(persisted.servers.length, 1);
});

test("旧单服务器配置自动迁移，并在新增连接时保留全部服务器", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-companion-emby-migration-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, "emby.json");
  const first = {
    baseUrl: "https://a.example",
    serverId: "server-a",
    userId: "user-a",
    username: "alice",
    deviceId: "stable-device"
  };
  await writeFile(configPath, `${JSON.stringify(first)}\n`, { mode: 0o600 });
  const storage = new EmbyStorage({ configPath, randomUUIDImpl: () => "uuid" });

  const migrated = await storage.loadState();
  assert.equal(migrated.version, 2);
  assert.equal(migrated.activeServerKey, embyServerKey(first));
  assert.deepEqual(migrated.servers, [first]);

  const second = {
    baseUrl: "https://b.example/emby",
    serverId: "server-b",
    userId: "user-b",
    username: "bob",
    deviceId: "stable-device"
  };
  await storage.saveConfig(second);
  const saved = await storage.loadState();
  assert.equal(saved.activeServerKey, embyServerKey(second));
  assert.deepEqual(saved.servers, [first, second]);
  assert.deepEqual(await storage.loadConfig(), second);
});

test("codex-hg 配置自动复制到 codex-companion 路径", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-companion-name-migration-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, "codex-companion", "emby.json");
  const legacyConfigPath = join(directory, "codex-hg", "emby.json");
  await mkdir(join(directory, "codex-hg"), { recursive: true });
  await writeFile(legacyConfigPath, `${JSON.stringify({
    baseUrl: "https://emby.example",
    serverId: "server",
    userId: "user",
    username: "alice",
    deviceId: "stable-device"
  })}\n`, { mode: 0o600 });

  const storage = new EmbyStorage({ configPath, legacyConfigPath });
  assert.equal((await storage.loadConfig()).deviceId, "stable-device");
  assert.equal(JSON.parse(await readFile(configPath, "utf8")).version, 2);
});

test("首页缓存原子保存、权限为 0600 且与账号绑定", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-companion-emby-home-cache-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const homeCachePath = join(directory, "nested", "emby-home.json");
  const storage = new EmbyStorage({
    homeCachePath,
    randomUUIDImpl: () => "cache-write",
    execFileImpl: async () => ({ stdout: "" })
  });
  await storage.saveHomeCache("server", "user", {
    at: 1234,
    data: { views: [], resume: [{ id: "one" }], latest: [] }
  });

  assertMode(await stat(homeCachePath), 0o600);
  assert.equal((await storage.loadHomeCache("server", "user")).data.resume[0].id, "one");
  assert.equal(await storage.loadHomeCache("server", "another-user"), null);
});

test("codex-hg 首页缓存自动复制到 codex-companion 路径", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-companion-cache-migration-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const homeCachePath = join(directory, "codex-companion", "emby-home.json");
  const legacyHomeCachePath = join(directory, "codex-hg", "emby-home.json");
  await mkdir(join(directory, "codex-hg"), { recursive: true });
  await writeFile(legacyHomeCachePath, `${JSON.stringify({
    serverId: "server",
    userId: "user",
    at: 1234,
    data: { views: [], resume: [], latest: [] }
  })}\n`, { mode: 0o600 });

  const storage = new EmbyStorage({ homeCachePath, legacyHomeCachePath });
  assert.equal((await storage.loadHomeCache("server", "user")).at, 1234);
  assert.equal(JSON.parse(await readFile(homeCachePath, "utf8")).serverId, "server");
});

test("Keychain 始终通过 /usr/bin/security execFile 调用并使用 ServerId:UserId account", async () => {
  const calls = [];
  const storage = new EmbyStorage({
    platform: "darwin",
    execFileImpl: async (file, args) => {
      calls.push({ file, args });
      if (args[0] === "find-generic-password") return { stdout: "secret-token\n" };
      return { stdout: "" };
    }
  });
  await storage.saveToken("server", "user", "secret-token");
  assert.equal(await storage.readToken("server", "user"), "secret-token");
  assert.equal(await storage.deleteToken("server", "user"), true);

  assert.equal(calls.length, 4);
  assert.ok(calls.every((call) => call.file === "/usr/bin/security"));
  assert.ok(calls.slice(0, 3).every((call) => call.args.includes(KEYCHAIN_SERVICE)));
  assert.ok(calls[3].args.includes(LEGACY_KEYCHAIN_SERVICE));
  assert.ok(calls.every((call) => call.args.includes("server:user")));
  assert.deepEqual(calls[0].args.slice(-2), ["-w", "secret-token"]);
});

test("旧 Keychain Token 首次读取时迁移到 codex-companion service", async () => {
  const missing = Object.assign(new Error("missing"), { code: 44 });
  const calls = [];
  const storage = new EmbyStorage({
    platform: "darwin",
    execFileImpl: async (file, args) => {
      calls.push({ file, args });
      if (args[0] === "find-generic-password" && args.includes(KEYCHAIN_SERVICE)) throw missing;
      if (args[0] === "find-generic-password" && args.includes(LEGACY_KEYCHAIN_SERVICE)) {
        return { stdout: "legacy-token\n" };
      }
      return { stdout: "" };
    }
  });

  assert.equal(await storage.readToken("server", "user"), "legacy-token");
  assert.deepEqual(calls.map(({ args }) => [args[0], args[args.indexOf("-s") + 1]]), [
    ["find-generic-password", KEYCHAIN_SERVICE],
    ["find-generic-password", LEGACY_KEYCHAIN_SERVICE],
    ["add-generic-password", KEYCHAIN_SERVICE]
  ]);
});

test("Keychain 中没有 Token 时返回 null，读取失败给出平台化错误", async () => {
  const missing = Object.assign(new Error("missing"), { code: 44 });
  const storage = new EmbyStorage({ platform: "darwin", execFileImpl: async () => { throw missing; } });
  assert.equal(await storage.readToken("server", "user"), null);
  assert.equal(await storage.deleteToken("server", "user"), false);

  const broken = new EmbyStorage({ platform: "darwin", execFileImpl: async () => { throw Object.assign(new Error("denied"), { code: 51 }); } });
  await assert.rejects(broken.readToken("server", "user"), { code: "CREDENTIAL_READ_FAILED", message: /macOS 钥匙串/ });
});

test("Linux 没有密钥环时 Token 存入配置目录下 0600 的凭证文件", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "emby-linux-secret-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const storage = new EmbyStorage({
    platform: "linux",
    configPath: join(dir, "emby.json"),
    homeCachePath: join(dir, "emby-home.json"),
    secretRunImpl: async () => { throw Object.assign(new Error("spawn secret-tool ENOENT"), { code: "ENOENT" }); }
  });
  await storage.saveToken("server", "user", "linux-token");
  assert.equal(await storage.readToken("server", "user"), "linux-token");
  const file = join(dir, "credentials.json");
  assertMode(await stat(file), 0o600);
  assert.doesNotMatch(await readFile(file, "utf8"), /server:user/, "文件内只保存条目哈希，不暴露服务器与用户");
  assert.equal(await storage.deleteToken("server", "user"), true);
  assert.equal(await storage.readToken("server", "user"), null);
});
