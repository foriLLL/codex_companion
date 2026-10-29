import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CompanionConfig, DEFAULT_AGENT, DEFAULT_LAUNCH, normalizeCompanionConfigV2 } from "../src/companion-config.mjs";
import { CARD_MANIFESTS } from "../src/card-registry.mjs";
import { normalizeRuntimeConfig } from "../src/platform/config/runtime-config.mjs";
import { assertMode } from "./helpers/permissions.mjs";

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "companion-launch-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "config-v2.json");
  const defaultsCalls = [];
  const reads = [];
  const store = new CompanionConfig({
    path,
    platform: "darwin",
    readFileImpl: async (...args) => { reads.push(args); return readFile(...args); },
    execFileImpl: async (...args) => { defaultsCalls.push(args); return { stdout: "" }; },
    ...options
  });
  return { dir, path, store, reads, defaultsCalls };
}

function oldV2(revision = 7) {
  const config = normalizeCompanionConfigV2({ version: 2, revision });
  delete config.launch;
  delete config.agent;
  return config;
}

test("launch/agent normalize 补默认值，导出常量深冻结且每份配置相互独立", () => {
  assert.deepEqual(DEFAULT_LAUNCH, { proxy: { enabled: false, port: 7890 } });
  assert.deepEqual(DEFAULT_AGENT, { autoRelaunch: true });
  assert.ok(Object.isFrozen(DEFAULT_LAUNCH) && Object.isFrozen(DEFAULT_LAUNCH.proxy) && Object.isFrozen(DEFAULT_AGENT));
  for (const input of [null, {}, { version: 2 }, { version: 2, launch: {}, agent: {} }]) {
    const config = normalizeCompanionConfigV2(input);
    assert.deepEqual(config.launch, DEFAULT_LAUNCH);
    assert.deepEqual(config.agent, DEFAULT_AGENT);
    config.launch.proxy.port = 1080;
    config.agent.autoRelaunch = false;
  }
  const partial = normalizeCompanionConfigV2({ version: 2, launch: { proxy: { port: 7891 } }, agent: { autoRelaunch: false } });
  assert.deepEqual(partial.launch, { proxy: { enabled: false, port: 7891 } });
  assert.deepEqual(partial.agent, { autoRelaunch: false });
  const invalid = normalizeCompanionConfigV2({ version: 2, launch: { proxy: { enabled: "true", port: 0 } }, agent: { autoRelaunch: "false" } });
  assert.deepEqual(invalid.launch, DEFAULT_LAUNCH);
  assert.deepEqual(invalid.agent, DEFAULT_AGENT);
});

test("launch/agent 部分 patch 深度合并，端口边界合法，旧 save 不覆盖新字段", async t => {
  const { store, path, dir } = await fixture(t);
  const initial = await store.loadV2();
  assert.deepEqual(initial.launch, DEFAULT_LAUNCH);
  assert.deepEqual(initial.agent, DEFAULT_AGENT);
  let next = await store.patch({ launch: { proxy: { port: 1 } } }, { expectedRevision: 0 });
  next = await store.patch({ launch: { proxy: { enabled: true } }, agent: { autoRelaunch: false } }, { expectedRevision: next.revision });
  next = await store.patch({ launch: { proxy: { port: 65535 } } }, { expectedRevision: next.revision });
  next = await store.patch({ launch: {}, agent: {} }, { expectedRevision: next.revision });
  next = await store.patch({ launch: { proxy: {} } }, { expectedRevision: next.revision });
  assert.deepEqual(next.launch, { proxy: { enabled: true, port: 65535 } });
  assert.deepEqual(next.agent, { autoRelaunch: false });
  assert.deepEqual(next.cards, initial.cards);
  assert.deepEqual(next.order, initial.order);
  assert.equal(next.revision, 5);
  await store.save({ cards: { games: false } });
  const saved = await store.loadV2();
  assert.deepEqual(saved.launch, next.launch);
  assert.deepEqual(saved.agent, next.agent);
  assert.equal(saved.revision, 6);
  assert.equal(saved.cards.games.enabled, false);
  assertMode(await stat(path), 0o600);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), saved);
  assert.deepEqual((await readdir(dir)).filter(name => name.endsWith(".tmp") || name.endsWith(".lock")), []);
});

test("launch/agent 非法 patch 返回 CONFIG_PATCH_INVALID，文件与 revision 不变", async t => {
  const { store, path, dir } = await fixture(t);
  await store.loadV2();
  const original = await readFile(path, "utf8");
  const patches = [
    ...[null, [], true, "proxy", 1, undefined].map(launch => ({ launch })),
    ...[null, [], false, "proxy", 1, undefined].map(proxy => ({ launch: { proxy } })),
    ...[null, [], true, "agent", 1, undefined].map(agent => ({ agent })),
    ...[null, "true", 0, 1, undefined].map(enabled => ({ launch: { proxy: { enabled } } })),
    ...[null, "false", 0, 1, undefined].map(autoRelaunch => ({ agent: { autoRelaunch } })),
    ...[0, 65536, -1, 1.5, "7890", true, null, NaN, Infinity, undefined].map(port => ({ launch: { proxy: { port } } })),
    { launch: { enabled: true } }, { launch: { proxy: { host: "127.0.0.1" } } },
    { agent: { other: true } }, { launch: { proxy: { enabled: false } }, agent: { typo: false } },
    JSON.parse('{"launch":{"proxy":{"__proto__":{"enabled":true}}}}')
  ];
  for (const patch of patches) {
    await assert.rejects(store.patch(patch, { expectedRevision: 0 }), { code: "CONFIG_PATCH_INVALID" });
    assert.equal(await readFile(path, "utf8"), original);
  }
  assert.equal((await store.loadV2()).revision, 0);
  assert.deepEqual((await readdir(dir)).filter(name => name.endsWith(".tmp") || name.endsWith(".lock")), []);
});

test("validateV2 拒绝显式损坏的新字段，保留 last-good，不尝试旧偏好覆盖", async t => {
  const { store, path, defaultsCalls, reads } = await fixture(t);
  const initial = await store.loadV2();
  defaultsCalls.length = 0;
  reads.length = 0;
  for (const fields of [
    { launch: null }, { launch: [] }, { launch: { proxy: false } },
    { launch: { proxy: { enabled: 1 } } }, { launch: { proxy: { port: "7890" } } },
    { launch: { proxy: { port: 65536 } } }, { launch: { proxy: { port: 0 } } },
    { agent: null }, { agent: [] }, { agent: { autoRelaunch: "false" } }
  ]) {
    const original = JSON.stringify({ ...initial, ...fields });
    await writeFile(path, original);
    await assert.rejects(store.loadV2({ strict: true }), { code: "CONFIG_INVALID" });
    assert.deepEqual(await store.loadV2(), initial);
    await assert.rejects(store.patch({ enabled: false }, { expectedRevision: 0 }), { code: "CONFIG_INVALID" });
    assert.equal(await readFile(path, "utf8"), original);
  }
  assert.equal(defaultsCalls.length, 0);
  assert.ok(reads.every(([file]) => file === path));
});

test("已有 launch（包括空对象）优先于旧 defaults", async t => {
  const { store, path, reads, defaultsCalls } = await fixture(t);
  for (const [launch, expected] of [
    [{}, DEFAULT_LAUNCH], [{ proxy: {} }, DEFAULT_LAUNCH],
    [{ proxy: { port: 4321 } }, { proxy: { enabled: false, port: 4321 } }],
    [{ proxy: { enabled: true, port: 6789 } }, { proxy: { enabled: true, port: 6789 } }]
  ]) {
    reads.length = 0;
    const value = { ...oldV2(), launch, agent: {} };
    await writeFile(path, JSON.stringify(value));
    const config = await store.loadV2({ strict: true });
    assert.deepEqual(config.launch, expected);
    assert.deepEqual(config.agent, DEFAULT_AGENT);
    assert.deepEqual(reads, [[path, "utf8"]]);
  }
  assert.equal(defaultsCalls.length, 0);
});

test("defaults 迁移使用可注入执行函数，兼容旧布尔值与端口回退并延迟落盘", async t => {
  for (const [enabled, port, expected] of [
    ["1", "10809", { enabled: true, port: 10809 }],
    ["true", "1", { enabled: true, port: 1 }],
    ["YES", "65535", { enabled: true, port: 65535 }],
    ["0", "7891", { enabled: false, port: 7891 }],
    ["false", "0", { enabled: false, port: 7890 }],
    ["NO", "65536", { enabled: false, port: 7890 }],
    ["invalid", "1.5", { enabled: false, port: 7890 }],
    [null, "NaN", { enabled: false, port: 7890 }],
    ["YES", null, { enabled: true, port: 7890 }],
    [null, null, { enabled: false, port: 7890 }]
  ]) {
    const calls = [];
    const { store, path } = await fixture(t, {
      execFileImpl: async (...args) => {
        calls.push(args);
        const value = args[1][2] === "launchThroughProxy" ? enabled : port;
        if (value === null) throw Object.assign(new Error("missing defaults"), { code: "ENOENT" });
        return { stdout: ` ${value}\n` };
      }
    });
    const original = JSON.stringify(oldV2());
    await writeFile(path, original);
    const config = await store.loadV2({ strict: true });
    assert.deepEqual(config.launch.proxy, expected);
    assert.deepEqual(calls, ["launchThroughProxy", "launchProxyPort"].map(key => [
      "/usr/bin/defaults", ["read", "com.codexcompanion.launcher", key], { timeout: 3000 }
    ]));
    assert.equal(await readFile(path, "utf8"), original);
    const saved = await store.patch({ launch: { proxy: { port: 9000 } } }, { expectedRevision: config.revision });
    assert.equal(saved.launch.proxy.enabled, expected.enabled);
    assert.equal(saved.launch.proxy.port, 9000);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), saved);
  }
});

test("连续 loadV2 只迁移一次，旧来源变化和调用方修改返回值不改变同 revision 配置", async t => {
  const calls = [];
  let port = "1080";
  const { store, path } = await fixture(t, {
    execFileImpl: async (_command, args) => { calls.push(args[2]); return { stdout: args[2] === "launchThroughProxy" ? "1" : port }; }
  });
  const original = JSON.stringify(oldV2());
  await writeFile(path, original);
  const first = await store.loadV2({ strict: true });
  const expected = structuredClone(first);
  first.launch.proxy.port = 65535;
  port = "7891";
  for (let attempt = 0; attempt < 5; attempt++) assert.deepEqual(await store.loadV2({ strict: true }), expected);
  assert.deepEqual(expected.launch, { proxy: { enabled: true, port: 1080 } });
  assert.equal(expected.revision, 7);
  assert.deepEqual(calls, ["launchThroughProxy", "launchProxyPort"]);
  assert.equal(await readFile(path, "utf8"), original);
  // 缓存属于实例，新实例可以在首次读取时使用更新后的旧来源。
  const another = new CompanionConfig({ path, platform: "darwin", execFileImpl: store.execFileImpl });
  assert.deepEqual((await another.loadV2({ strict: true })).launch, { proxy: { enabled: true, port: 7891 } });
  assert.equal(calls.length, 4);
});

test("并发 loadV2 共享尚未完成的迁移，defaults 两个 key 各执行一次", async t => {
  const calls = [];
  const { promise: firstDefault, resolve: started } = Promise.withResolvers();
  const { promise: allReads, resolve: readAll } = Promise.withResolvers();
  const { promise: gate, resolve: release } = Promise.withResolvers();
  t.after(release);
  const { store, path } = await fixture(t, {
    execFileImpl: async (_command, args) => {
      calls.push(args[2]);
      started();
      await gate;
      return { stdout: args[2] === "launchThroughProxy" ? "1" : "1080" };
    }
  });
  const original = JSON.stringify(oldV2());
  await writeFile(path, original);
  let configReads = 0;
  store.readFileImpl = async (...args) => {
    const result = await readFile(...args);
    if (args[0] === path && ++configReads === 8) readAll();
    return result;
  };
  const pending = Array.from({ length: 8 }, () => store.loadV2({ strict: true }));
  await Promise.all([firstDefault, allReads]);
  release();
  const configs = await Promise.all(pending);
  for (const config of configs) {
    assert.deepEqual(config, configs[0]);
    assert.deepEqual(config.launch, { proxy: { enabled: true, port: 1080 } });
    assert.equal(config.revision, 7);
  }
  assert.deepEqual(calls, ["launchThroughProxy", "launchProxyPort"]);
  assert.equal(await readFile(path, "utf8"), original);
});

test("patch 失败保留迁移快照，成功后写入该快照且后续读取不再访问旧来源", async t => {
  const { store, path, defaultsCalls } = await fixture(t);
  const original = JSON.stringify(oldV2());
  await writeFile(path, original);
  const initial = await store.loadV2({ strict: true });
  await assert.rejects(store.patch({ enabled: false }, { expectedRevision: 6 }), { code: "CONFIG_CONFLICT" });
  await assert.rejects(store.patch({ launch: { proxy: { port: 0 } } }, { expectedRevision: 7 }), { code: "CONFIG_PATCH_INVALID" });
  const atomicWrite = store.atomicWrite;
  store.atomicWrite = async () => { throw Object.assign(new Error("write failed"), { code: "EIO" }); };
  try {
    await assert.rejects(store.patch({ enabled: false }, { expectedRevision: 7 }), { code: "EIO" });
  } finally { store.atomicWrite = atomicWrite; }
  assert.deepEqual(await store.loadV2({ strict: true }), initial);
  assert.equal(await readFile(path, "utf8"), original);
  const saved = await store.patch({ enabled: false }, { expectedRevision: 7 });
  assert.equal(saved.revision, 8);
  assert.deepEqual(saved.launch, initial.launch);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), saved);
  for (let attempt = 0; attempt < 3; attempt++) assert.deepEqual(await store.loadV2({ strict: true }), saved);
  assert.equal(defaultsCalls.length, 2);
});

test("磁盘已有 launch 时立即使用磁盘值，后续读取不再访问迁移来源", async t => {
  const { store, path, defaultsCalls } = await fixture(t);
  await writeFile(path, JSON.stringify(oldV2()));
  await store.loadV2({ strict: true });
  const stored = normalizeCompanionConfigV2({ ...oldV2(8), launch: { proxy: { enabled: true, port: 4321 } } });
  await writeFile(path, JSON.stringify(stored));
  for (let attempt = 0; attempt < 3; attempt++) assert.deepEqual(await store.loadV2({ strict: true }), stored);
  assert.equal(defaultsCalls.length, 2);
});

test("首次创建 v2 或从 v1 迁移也导入旧 defaults 偏好，沿用 revision 0", async t => {
  for (const legacy of [null, { version: 1, enabled: false, cards: { games: false } }]) {
    const defaultsCalls = [];
    const { store, path, dir } = await fixture(t, {
      execFileImpl: async (...args) => { defaultsCalls.push(args); return { stdout: args[1][2] === "launchThroughProxy" ? "YES\n" : "1080\n" }; }
    });
    if (legacy) await writeFile(join(dir, "config.json"), JSON.stringify(legacy));
    const config = await store.loadV2();
    assert.equal(config.revision, 0);
    assert.deepEqual(config.launch, { proxy: { enabled: true, port: 1080 } });
    assert.deepEqual(config.agent, DEFAULT_AGENT);
    assert.equal(config.enabled, legacy?.enabled ?? true);
    assert.equal(defaultsCalls.length, 2);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), config);
  }
});

test("normalizeRuntimeConfig 显式投影，launch/agent 不进入渲染层或旧配置形状", async t => {
  const { store } = await fixture(t);
  const config = await store.loadV2();
  const next = await store.patch({ launch: { proxy: { enabled: true, port: 1080 } }, agent: { autoRelaunch: false } }, { expectedRevision: 0 });
  const runtime = normalizeRuntimeConfig(next, CARD_MANIFESTS);
  assert.deepEqual(runtime, { ...normalizeRuntimeConfig(config, CARD_MANIFESTS), revision: 1 });
  for (const value of [runtime, await store.load()]) {
    assert.equal(Object.hasOwn(value, "launch"), false);
    assert.equal(Object.hasOwn(value, "agent"), false);
  }
});

test("非 macOS 平台不调用 defaults 导入旧偏好，直接使用默认启动设置", async t => {
  const directory = await mkdtemp(join(tmpdir(), "companion-launch-linux-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new CompanionConfig({
    path: join(directory, "config-v2.json"),
    platform: "linux",
    execFileImpl: async () => { throw new Error("不应调用 defaults"); }
  });
  assert.deepEqual(await store.readLegacyLaunchDefaults(), { proxy: { enabled: false, port: 7890 } });
});
