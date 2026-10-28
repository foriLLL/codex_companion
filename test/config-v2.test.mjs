import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, stat, rm, readdir, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { watch } from "node:fs";
import test from "node:test";
import { CompanionConfig, normalizeCompanionConfigV2, toLegacyCompanionConfig } from "../src/companion-config.mjs";
import { CARD_MANIFESTS } from "../src/card-registry.mjs";
import { watchCompanionConfig } from "../src/platform/config/watcher.mjs";
import { assertMode } from "./helpers/permissions.mjs";

const createConfig = options => new CompanionConfig({ execFileImpl: async () => ({ stdout: "" }), ...options });

async function temporary(t) {
  const dir = await mkdtemp(join(tmpdir(), "companion-v2-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, path: join(dir, "config-v2.json") };
}

function command(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["src/cli.mjs", ...args], { cwd: new URL("..", import.meta.url) });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => resolve({ code, stdout, stderr }));
    child.stdin.end(input ? JSON.stringify(input) : "");
  });
}

async function eventually(predicate) {
  const until = Date.now() + 2500;
  while (!predicate()) {
    if (Date.now() > until) assert.fail("watcher 未在时限内应用配置");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test("v1 迁移保留原文件与精确备份，v2 0600，旧窗口写入不再影响新配置", async t => {
  const { dir, path } = await temporary(t);
  const oldPath = join(dir, "config.json");
  const original = JSON.stringify({ version: 1, enabled: false, cards: { games: false, hongguo: true, emby: false }, cardOrder: ["emby", "hongguo"], retiredUrl: "https://example.com/?invite=test" });
  await writeFile(oldPath, original);
  const store = createConfig({ path });
  const config = await store.loadV2();
  assert.equal(config.version, 2);
  assert.equal(config.revision, 0);
  assert.equal(config.cards.games.enabled, false);
  assert.equal(config.cards.emby.enabled, false);
  // v1 的未知顶层字段不迁移。
  assert.equal(Object.hasOwn(config, "retiredUrl"), false);
  assert.deepEqual(config.order, ["proxy", "games", "emby", "hongguo"]);
  assert.equal(await readFile(oldPath, "utf8"), original);
  assert.equal(await readFile(`${oldPath}.v1.bak`, "utf8"), original);
  assertMode(await stat(path), 0o600);
  assertMode(await stat(`${oldPath}.v1.bak`), 0o600);
  await writeFile(oldPath, JSON.stringify({ version: 1, enabled: true }));
  assert.equal((await store.loadV2()).enabled, false);
});

test("未知卡片、未知 settings 保留；默认从 manifest 产生；补丁仅更新指定字段", async t => {
  const { path } = await temporary(t);
  const manifests = [...CARD_MANIFESTS, { id: "fifth", defaultEnabled: false }];
  const store = createConfig({ path, manifests });
  let config = await store.loadV2();
  assert.equal(config.cards.fifth.enabled, false);
  config = await store.patch({ cards: { future: { enabled: false, settings: { a: 1, nested: { preserve: true } } }, games: { settings: { sound: false } } } }, { expectedRevision: config.revision });
  config = await store.patch({ cards: { future: { settings: { b: 2 } }, games: { enabled: false } } }, { expectedRevision: config.revision });
  assert.deepEqual(config.cards.future.settings, { a: 1, nested: { preserve: true }, b: 2 });
  assert.equal(config.cards.games.settings.sound, false);
  assert.equal(toLegacyCompanionConfig(config).cards.fifth, false);
  const oldBinary = createConfig({ path });
  assert.deepEqual((await oldBinary.loadV2()).cards.fifth, config.cards.fifth);
});

test("两个写入者同 revision 仅一个成功；冲突重读后保留前一写入", async t => {
  const { path, dir } = await temporary(t);
  const a = createConfig({ path });
  const b = createConfig({ path });
  const initial = await a.loadV2();
  const results = await Promise.allSettled([
    a.patch({ enabled: false }, { expectedRevision: initial.revision }),
    b.patch({ placement: "inline-in-summary" }, { expectedRevision: initial.revision })
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.find(result => result.status === "rejected").reason.code, "CONFIG_CONFLICT");
  let config = await a.loadV2();
  const failedPatch = config.enabled === false ? { placement: "inline-in-summary" } : { enabled: false };
  config = await b.patch(failedPatch, { expectedRevision: config.revision });
  assert.equal(config.enabled, false);
  assert.equal(config.placement, "inline-in-summary");
  assert.equal(config.revision, 2);
  assert.deepEqual((await readdir(dir)).filter(file => file.endsWith(".tmp") || file.endsWith(".lock")), []);
});

test("初次损坏明确失败，运行中损坏保留 last-good，补丁不能覆盖损坏文件", async t => {
  const { path } = await temporary(t);
  await writeFile(path, "{broken");
  const fresh = createConfig({ path });
  await assert.rejects(fresh.loadV2(), { code: "CONFIG_INVALID" });
  await rm(path);
  const good = await fresh.loadV2();
  await writeFile(path, "{broken again");
  assert.deepEqual(await fresh.loadV2(), good);
  await assert.rejects(fresh.loadV2({ strict: true }), { code: "CONFIG_INVALID" });
  await assert.rejects(fresh.patch({ enabled: false }, { expectedRevision: good.revision }), { code: "CONFIG_INVALID" });
  assert.equal(await readFile(path, "utf8"), "{broken again");
});

test("旧配置损坏不迁移，不生成默认配置覆盖用户意图", async t => {
  const { path, dir } = await temporary(t);
  await writeFile(join(dir, "config.json"), "broken");
  await assert.rejects(createConfig({ path }).loadV2(), { code: "CONFIG_MIGRATION_INVALID" });
  await assert.rejects(stat(path), { code: "ENOENT" });
});

test("实际目录 watcher 覆盖四卡与第五卡的 enabled/settings、顺序、placement、损坏恢复", async t => {
  const { path } = await temporary(t);
  const store = createConfig({ path, manifests: [...CARD_MANIFESTS, { id: "fifth", defaultEnabled: false }] });
  let latest;
  const seen = [];
  const errors = [];
  const watcher = await watchCompanionConfig({ config: store, intervalMs: 40, debounceMs: 5, onChange: async config => { latest = config; seen.push(config); }, onError: error => errors.push(error.code) });
  t.after(() => watcher.close());
  for (const id of [...CARD_MANIFESTS.map(card => card.id), "fifth"]) {
    const next = await store.patch({ cards: { [id]: { enabled: !latest.cards[id].enabled, settings: { marker: id } } } }, { expectedRevision: latest.revision });
    await eventually(() => latest.revision === next.revision);
    assert.deepEqual(latest.cards[id], next.cards[id]);
  }
  const next = await store.patch({ order: [...latest.order].reverse(), placement: "inline-in-summary", enabled: false }, { expectedRevision: latest.revision });
  await eventually(() => latest.revision === next.revision);
  const count = seen.length;
  await writeFile(path, "broken");
  await eventually(() => errors.length > 0);
  assert.equal(seen.length, count);
  const restored = { ...next, enabled: true, revision: next.revision + 1 };
  await writeFile(`${path}.replacement`, JSON.stringify(restored));
  await rename(`${path}.replacement`, path);
  await eventually(() => latest.revision === restored.revision);
  assert.equal(latest.enabled, true);
  await watcher.close();
  await writeFile(path, JSON.stringify({ ...restored, revision: restored.revision + 1 }));
  await watcher.check();
  assert.equal(latest.revision, restored.revision);
});

test("CLI 真实子进程目录、配置和 stdin 补丁；冲突机器可读且不写配置", async t => {
  const { path } = await temporary(t);
  // 子进程读取已含 launch 的隔离配置，不触发真实 defaults 迁移。
  await createConfig({ path }).loadV2();
  const catalog = await command(["cards", "list"]);
  assert.equal(catalog.code, 0, catalog.stderr);
  assert.deepEqual(JSON.parse(catalog.stdout).map(card => card.id), CARD_MANIFESTS.map(card => card.id));
  const initial = await command(["config", "get", "--config-path", path]);
  assert.equal(initial.code, 0, initial.stderr);
  const config = JSON.parse(initial.stdout);
  const patched = await command(["config", "patch", "--config-path", path], { expectedRevision: config.revision, patch: {
    cards: { games: { enabled: false }, future: { enabled: true, settings: { test: 1 } } },
    launch: { proxy: { port: 7891 } }, agent: { autoRelaunch: false }
  } });
  assert.equal(patched.code, 0, patched.stderr);
  const result = JSON.parse(patched.stdout);
  assert.equal(result.cards.games.enabled, false);
  assert.deepEqual(result.launch, { proxy: { enabled: false, port: 7891 } });
  assert.deepEqual(result.agent, { autoRelaunch: false });
  const readBack = await command(["config", "get", "--config-path", path]);
  assert.equal(readBack.code, 0, readBack.stderr);
  assert.deepEqual(JSON.parse(readBack.stdout), result);
  const invalid = await command(["config", "patch", "--config-path", path], {
    expectedRevision: result.revision, patch: { launch: { proxy: { port: 65536 } } }
  });
  assert.equal(invalid.code, 1);
  assert.equal(JSON.parse(invalid.stderr).error.code, "CONFIG_PATCH_INVALID");
  const conflict = await command(["config", "patch", "--config-path", path], { expectedRevision: config.revision, patch: { enabled: false } });
  assert.equal(conflict.code, 1);
  assert.equal(JSON.parse(conflict.stderr).error.code, "CONFIG_CONFLICT");
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), result);
});

test("非法补丁、缺 revision、锁超时均失败关闭", async t => {
  const { path } = await temporary(t);
  const store = createConfig({ path, lockTimeoutMs: 30 });
  const config = await store.loadV2();
  await assert.rejects(store.patch({ enabled: false }), { code: "CONFIG_REVISION_REQUIRED" });
  for (const patch of [{ revision: 42 }, { enabled: "false" }, { cards: { games: { settings: null } } }]) {
    await assert.rejects(store.patch(patch, { expectedRevision: 0 }));
  }
  await writeFile(`${path}.lock`, "occupied");
  await assert.rejects(store.patch({ enabled: false }, { expectedRevision: 0 }), { code: "CONFIG_LOCKED" });
  assert.deepEqual(await store.loadV2(), config);
});


test("运行中删除配置不重新迁移旧文件，异步应用失败可重试且不并发", async t => {
  const { path } = await temporary(t);
  const store = createConfig({ path });
  const initial = await store.loadV2();
  await rm(path);
  assert.deepEqual(await store.loadV2(), initial);
  await assert.rejects(store.loadV2({ strict: true }), { code: "CONFIG_MISSING" });
  await assert.rejects(stat(path), { code: "ENOENT" });
  await writeFile(path, JSON.stringify(initial));
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  const errors = [];
  const watcher = await watchCompanionConfig({ config: store, intervalMs: 10000, onError: error => errors.push(error), onChange: async () => {
    calls += 1;
    active += 1;
    maxActive = Math.max(active, maxActive);
    await new Promise(resolve => setTimeout(resolve, 20));
    active -= 1;
    if (calls === 1) throw new Error("temporary application failure");
  } });
  t.after(() => watcher.close());
  assert.equal(errors.length, 1);
  await Promise.all([watcher.check(), watcher.check(), watcher.check()]);
  assert.equal(calls, 2);
  assert.equal(maxActive, 1);
});


test("已知 revision 0 的写入者遇到文件消失时拒绝重新迁移", async t => {
  const { path, dir } = await temporary(t);
  const oldPath = join(dir, "config.json");
  await writeFile(oldPath, JSON.stringify({ cards: { hongguo: false, future: { enabled: false, settings: { preserve: 1 } } } }));
  const store = createConfig({ path });
  const initial = await store.loadV2();
  assert.equal(initial.revision, 0);
  await rm(path);
  await writeFile(oldPath, JSON.stringify({ cards: { hongguo: true } }));
  await assert.rejects(store.patch({ enabled: false }, { expectedRevision: 0 }), { code: "CONFIG_MISSING" });
  await assert.rejects(stat(path), { code: "ENOENT" });
  assert.deepEqual(await store.loadV2(), initial);
});

test("watcher 隔离同步抛错和异步拒绝的 reporter，包括原生 watcher error", async t => {
  for (const asynchronous of [false, true]) {
    const { path } = await temporary(t);
    const store = createConfig({ path });
    const initial = await store.loadV2();
    await writeFile(path, "broken");
    let nativeWatcher;
    let reported = 0;
    let applied = 0;
    const watcher = await watchCompanionConfig({
      config: store, intervalMs: 10000,
      watchImpl: (...args) => { nativeWatcher = watch(...args); return nativeWatcher; },
      onChange: () => { applied += 1; },
      onError: () => {
        reported += 1;
        if (asynchronous) return Promise.reject(new Error("reporter rejection"));
        throw new Error("reporter throw");
      }
    });
    t.after(() => watcher.close());
    assert.equal(reported, 1);
    await watcher.check();
    assert.equal(reported, 2);
    nativeWatcher.emit("error", new Error("native watch failure"));
    await eventually(() => reported === 3);
    await writeFile(path, JSON.stringify(initial));
    await watcher.check();
    assert.equal(applied, 1);
    await watcher.close();
  }
});

test("迁移拒绝有效 JSON 中的类型损坏，不写 v2 或备份", async t => {
  const invalid = [
    { enabled: "false" }, { enabled: null }, { placement: "other" },
    { cards: [] }, { cards: null }, { cards: { hongguo: "false" } },
    { cards: { hongguo: { enabled: "false" } } },
    { cards: { future: { enabled: false, settings: [] } } },
    { cardOrder: "hongguo" }, { cardOrder: [false] }
  ];
  for (const value of invalid) {
    const { path, dir } = await temporary(t);
    const oldPath = join(dir, "config.json");
    const original = JSON.stringify(value);
    await writeFile(oldPath, original);
    await assert.rejects(createConfig({ path }).loadV2(), { code: "CONFIG_MIGRATION_INVALID" });
    assert.equal(await readFile(oldPath, "utf8"), original);
    await assert.rejects(stat(path), { code: "ENOENT" });
    await assert.rejects(stat(`${oldPath}.v1.bak`), { code: "ENOENT" });
  }
});

test("迁移保留缺省字段与未知卡片数据，兼容对象设置不会启用关闭的卡片", async t => {
  const { path, dir } = await temporary(t);
  const unknown = { enabled: false, settings: { nested: { keep: true } }, futureData: [1, 2] };
  await writeFile(join(dir, "config.json"), JSON.stringify({ cards: {
    hongguo: false, future: unknown, futurebool: false,
    retired: { enabled: false, settings: { url: "https://example.com/?invite=keep" } }
  } }));
  const config = await createConfig({ path }).loadV2();
  assert.equal(config.enabled, true);
  assert.equal(config.placement, "standalone-button");
  assert.equal(config.cards.hongguo.enabled, false);
  assert.deepEqual(config.cards.future, unknown);
  assert.equal(config.cards.futurebool.enabled, false);
  assert.equal(config.cards.retired.enabled, false);
  assert.equal(config.cards.retired.settings.url, "https://example.com/?invite=keep");
});

test("升级新增的内置卡按 defaultOrder 插入，已有卡片相对顺序不变", () => {
  const manifests = [
    { id: "proxy", defaultEnabled: true, defaultOrder: 0 },
    { id: "games", defaultEnabled: true, defaultOrder: 10 },
    { id: "middle", defaultEnabled: false, defaultOrder: 25 },
    { id: "emby", defaultEnabled: true, defaultOrder: 40 }
  ];
  const config = normalizeCompanionConfigV2({ version: 2, order: ["emby", "games", "orphan"], cards: { orphan: { enabled: true } } }, manifests);
  assert.deepEqual(config.order, ["proxy", "middle", "emby", "games", "orphan"]);
  assert.deepEqual(normalizeCompanionConfigV2({ version: 2 }, manifests).order, ["proxy", "games", "middle", "emby"]);
});
