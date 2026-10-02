import assert from "node:assert/strict";
import test from "node:test";
import { createGameEngine, createGamesPersistence, validateGameState } from "../src/games.mjs";
import { createStore, STATE_CONFLICT, STORAGE_QUOTA } from "../src/renderer/platform/storage.mjs";

const legacyKey = "codex-companion-games-v1";
const engine = () => createGameEngine(() => .42);
function fixture(initial = {}, scope = "window-a") {
  const raw = new Map(Object.entries(initial));
  let writes = 0;
  const backend = { getItem: key => raw.get(key) ?? null, setItem: (key, value) => { writes++; raw.set(key, String(value)); } };
  const storage = {
    readLegacy: key => backend.getItem(key),
    namespace: (name, options) => createStore({ ...options, storage: backend, namespace: `games.${name}`, scopeId: scope })
  };
  return { raw, backend, storage, writes: () => writes };
}
function legacy() {
  const e = engine();
  return { version: 1, selected: "mines", games: { "2048": { board: [2, 2, ...Array(14).fill(0)], score: 64 }, mines: e.newMines(), solitaire: e.newSolitaire() } };
}

test("旧共享存档逐游戏复制，坏游戏不重置有效游戏且源 key 不变", () => {
  const old = legacy(); old.games.mines.open = [999];
  const source = JSON.stringify(old);
  const f = fixture({ [legacyKey]: source });
  const session = createGamesPersistence({ storage: f.storage, engine: engine() });
  assert.deepEqual(session.data.games["2048"], old.games["2048"]);
  assert.deepEqual(session.data.games.solitaire, old.games.solitaire);
  assert.deepEqual(session.data.games.mines, engine().newMines());
  assert.equal(session.data.selected, "mines");
  assert.match(session.getNotice("mines"), /旧存档损坏/);
  assert.equal(f.raw.get(legacyKey), source);
  assert.equal(f.raw.size, 5);
  assert.deepEqual(session.diagnostics().revisions, { "2048": 1, mines: 1, solitaire: 1, selection: 1 });
});

test("非空目标不迁移，坏目标不覆盖，其他 namespaces 仍可用", () => {
  const old = legacy();
  const saved = { board: [8, ...Array(15).fill(0)], score: 120 };
  const f = fixture({ [legacyKey]: JSON.stringify(old), "games.2048::window-a": JSON.stringify({ version: 1, revision: 9, value: saved }), "games.mines::window-a": "{corrupt" });
  const session = createGamesPersistence({ storage: f.storage, engine: engine() });
  assert.deepEqual(session.data.games["2048"], saved);
  assert.deepEqual(session.data.games.solitaire, old.games.solitaire);
  session.data.games.mines.flags.push(40);
  assert.equal(session.save("mines").ok, false);
  assert.equal(f.raw.get("games.mines::window-a"), "{corrupt");
  assert.match(session.getNotice("mines"), /原数据已保留/);
});

test("两个实例旧 revision 被拒绝，仅冲突游戏刷新，不覆盖其他游戏", () => {
  const f = fixture();
  const a = createGamesPersistence({ storage: f.storage, engine: engine() });
  const errors = [];
  const b = createGamesPersistence({ storage: f.storage, engine: engine(), reportError: error => errors.push(error.code) });
  a.data.games["2048"].score = 100;
  assert.equal(a.save("2048").revision, 2);
  const bMines = b.data.games.mines;
  b.data.games["2048"].score = 8;
  assert.equal(b.save("2048").conflict, true);
  assert.equal(b.data.games["2048"].score, 100);
  assert.equal(b.data.games.mines, bMines);
  assert.match(b.getNotice("2048"), /已载入最新进度/);
  assert.equal(errors.at(-1), STATE_CONFLICT);
  b.data.games["2048"].score = 104;
  assert.equal(b.save("2048").revision, 3);
  const before = new Map(f.raw);
  a.dispose(); b.dispose();
  assert.deepEqual(f.raw, before, "dispose 不得写回陈旧整包状态");
});

test("首次迁移使用显式 null CAS，不覆盖刚创建的目标", () => {
  const f = fixture({ [legacyKey]: JSON.stringify(legacy()) });
  const namespace = f.storage.namespace;
  f.storage.namespace = (name, options) => {
    const store = namespace(name, options);
    if (name !== "2048") return store;
    const read = store.read;
    let injected = false;
    store.read = value => {
      const result = read(value);
      if (!injected && result.revision === null) {
        injected = true;
        namespace(name, options).write({ board: [16, ...Array(15).fill(0)], score: 500 });
      }
      return result;
    };
    return store;
  };
  const session = createGamesPersistence({ storage: f.storage, engine: engine() });
  assert.equal(session.data.games["2048"].score, 500);
  assert.equal(session.diagnostics().revisions["2048"], 1);
  assert.match(session.getNotice("2048"), /其他实例更新/);
});

test("quota 失败保留已存数据并提示，abort 后旧 callback 和 dispose 不写入", () => {
  const f = fixture();
  const abort = new AbortController();
  const errors = [];
  const session = createGamesPersistence({ storage: f.storage, engine: engine(), signal: abort.signal, reportError: error => errors.push(error.code) });
  const original = f.raw.get("games.2048::window-a");
  f.backend.setItem = () => { throw Object.assign(Error("quota"), { name: "QuotaExceededError" }); };
  session.data.games["2048"].score = 888;
  assert.equal(session.save("2048").error.code, STORAGE_QUOTA);
  assert.equal(f.raw.get("games.2048::window-a"), original);
  assert.match(session.getNotice("2048"), /尚未保存/);
  abort.abort();
  const count = errors.length;
  assert.equal(session.save("2048").aborted, true);
  session.dispose();
  assert.equal(errors.length, count);
  assert.equal(f.raw.get("games.2048::window-a"), original);
});

test("游戏校验拒绝无效棋盘、重复雷位和重复扑克牌", () => {
  const e = engine();
  for (const [name, value] of [["2048", e.new2048()], ["mines", e.newMines()], ["solitaire", e.newSolitaire()], ["selection", "solitaire"]]) assert.equal(validateGameState(name, value), true);
  assert.equal(validateGameState("2048", { board: [3, ...Array(15).fill(0)], score: 0 }), false);
  assert.equal(validateGameState("mines", { ...e.newMines(), flags: [0, 0] }), false);
  const cards = e.newSolitaire(); cards.stock[0] = cards.stock[1];
  assert.equal(validateGameState("solitaire", cards), false);
});

test("已中止实例不读取旧存档也不创建 namespace", () => {
  const abort = new AbortController(); abort.abort();
  const fail = () => { throw Error("storage touched after abort"); };
  const session = createGamesPersistence({ storage: { readLegacy: fail, namespace: fail }, engine: engine(), signal: abort.signal });
  assert.equal(session.save("selection").aborted, true);
});
