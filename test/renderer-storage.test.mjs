import assert from "node:assert/strict";
import test from "node:test";
import { createStore, resolveScopeId, STATE_CONFLICT, STORAGE_CORRUPT, STORAGE_INVALID, STORAGE_QUOTA } from "../src/renderer/platform/storage.mjs";

function memory(initial = {}) {
  const data = new Map(Object.entries(initial));
  return { data, getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, String(value)) };
}
const record = (value, revision = 1, version = 1) => JSON.stringify({ version, revision, value });

test("同 scope 的旧 revision 和显式 null 均不能覆盖并发新状态", () => {
  const storage = memory();
  const a = createStore({ storage, namespace: "games", version: 1, scopeId: "window" });
  const b = createStore({ storage, namespace: "games", version: 1, scopeId: "window" });
  const absent = b.read(null);
  assert.equal(absent.revision, null);
  a.write({ score: 1 }, { expectedRevision: null });
  assert.throws(() => b.write({ score: 2 }, { expectedRevision: absent.revision }), error => error.code === STATE_CONFLICT && error.actualRevision === 1);
  const old = a.read(null);
  b.write({ score: 4 }, { expectedRevision: 1 });
  assert.throws(() => a.write({ score: 3 }, { expectedRevision: old.revision }), error => error.code === STATE_CONFLICT && error.actualRevision === 2);
  assert.deepEqual(a.read(null).value, { score: 4 });
});

test("不同 scope 和不同游戏 namespace 隔离", () => {
  const storage = memory();
  const options = [ ["2048", "a"], ["2048", "b"], ["mines", "a"] ];
  const stores = options.map(([namespace, scopeId]) => createStore({ storage, namespace, scopeId, version: 1 }));
  stores.forEach((store, index) => store.write(index));
  assert.deepEqual(stores.map(store => store.read(null).value), [0, 1, 2]);
  assert.equal(storage.data.size, 3);
});

test("损坏读取明确失败，update 与 legacy copy 不覆盖坏目标", () => {
  const storage = memory({ games: "{broken", legacy: record({ score: 7 }) });
  const errors = [];
  const store = createStore({ storage, namespace: "games", version: 1, onError: error => errors.push(error.code) });
  const read = store.read({ score: 0 });
  assert.equal(read.ok, false);
  assert.equal(read.error.code, STORAGE_CORRUPT);
  assert.deepEqual(read.value, { score: 0 });
  assert.equal(read.revision, null);
  assert.throws(() => store.update(() => ({ score: 9 })), error => error.code === STORAGE_CORRUPT);
  assert.equal(store.copyLegacy("legacy").ok, false);
  assert.equal(storage.getItem("games"), "{broken");
  assert.ok(errors.every(code => code === STORAGE_CORRUPT));
});

test("旧版本迁移复制保留源 key 及 revision", () => {
  const source = record({ score: 7 }, 4);
  const storage = memory({ legacy: source });
  const store = createStore({ storage, namespace: "games", version: 2, migrate: record => ({ version: 2, value: { ...record.value, migrated: true } }) });
  assert.deepEqual(store.copyLegacy("legacy"), { ok: true, copied: true, revision: 4 });
  assert.deepEqual(store.read(null).value, { score: 7, migrated: true });
  assert.equal(storage.getItem("legacy"), source);
});

test("未来版本不可降级，字段缺失与 schema 错误均不写成成功", () => {
  const future = record({ score: 10 }, 5, 3);
  const storage = memory({ games: future });
  let migrations = 0;
  const store = createStore({ storage, namespace: "games", version: 1, migrate: () => { migrations++; return { version: 1, value: 0 }; } });
  assert.equal(store.read(null).ok, false);
  assert.throws(() => store.write({ score: 3 }), error => error.code === STORAGE_INVALID);
  assert.equal(migrations, 0);
  assert.equal(storage.getItem("games"), future);
  const invalid = createStore({ storage, namespace: "other", version: 1, validate: value => Number.isInteger(value?.score) });
  assert.throws(() => invalid.write({ score: "bad" }), error => error.code === STORAGE_INVALID);
  assert.equal(storage.getItem("other"), null);
  storage.setItem("other", JSON.stringify({ version: 1, revision: 1 }));
  assert.equal(invalid.read(null).error.code, STORAGE_CORRUPT);
});

test("quota 返回类型化错误，错误回调的同步和异步失败被隔离", async () => {
  const storage = memory();
  storage.setItem = () => { throw Object.assign(new Error("quota"), { name: "QuotaExceededError" }); };
  for (const onError of [() => { throw Error("callback"); }, () => Promise.reject(Error("callback"))]) {
    const store = createStore({ storage, namespace: "games", version: 1, onError });
    assert.throws(() => store.write(1), error => error.code === STORAGE_QUOTA);
    assert.equal(store.diagnostics().revision, null);
    assert.equal(store.diagnostics().lastError.code, STORAGE_QUOTA);
  }
  await new Promise(resolve => setImmediate(resolve));
});

test("session scope 稳定，写入失败不会返回虚假的持久 scope", () => {
  const session = memory();
  assert.equal(resolveScopeId(session, { randomUUID: () => "fixed" }), "fixed");
  assert.equal(resolveScopeId(session, { randomUUID: () => "other" }), "fixed");
  const broken = memory();
  broken.setItem = () => { throw Object.assign(Error("denied"), { name: "SecurityError" }); };
  assert.throws(() => resolveScopeId(broken, { randomUUID: () => "new" }), error => error.code === STORAGE_INVALID);
});
