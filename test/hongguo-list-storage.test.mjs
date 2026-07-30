import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HongguoListStorage, normalizeListEntry } from "../src/hongguo-list-storage.mjs";

const poster = "https://p6-novel.byteimg.com/cover.jpg";

async function withTempDir(run) {
  const dir = await mkdtemp(join(tmpdir(), "hongguo-list-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("normalizeListEntry：仅接受数字 ID，白名单字段", () => {
  assert.equal(normalizeListEntry(null), null);
  assert.equal(normalizeListEntry({ id: "abc" }), null);
  assert.deepEqual(normalizeListEntry({ id: "7503745441910017049", name: "剧", posterUrl: poster, extra: 1 }), {
    id: "7503745441910017049",
    name: "剧",
    posterUrl: poster
  });
  // 缺字段回退空串
  assert.deepEqual(normalizeListEntry({ id: "123" }), { id: "123", name: "", posterUrl: "" });
});

test("add：去重并置顶为最新；0600 落盘可回读", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "hongguo-list.json");
    const store = new HongguoListStorage({ path });

    await store.add({ id: "111", name: "A", posterUrl: poster });
    await store.add({ id: "222", name: "B", posterUrl: poster });
    let items = await store.add({ id: "111", name: "A2", posterUrl: poster }); // 重复 → 置顶更新
    assert.deepEqual(items.map((x) => x.id), ["111", "222"]);
    assert.equal(items[0].name, "A2");

    const info = await stat(path);
    assert.equal(info.mode & 0o777, 0o600);

    assert.deepEqual((await store.load()).map((x) => x.id), ["111", "222"]);
  });
});

test("remove：删除指定项", async () => {
  await withTempDir(async (dir) => {
    const store = new HongguoListStorage({ path: join(dir, "hongguo-list.json") });
    await store.add({ id: "111", name: "A", posterUrl: poster });
    await store.add({ id: "222", name: "B", posterUrl: poster });
    const items = await store.remove("111");
    assert.deepEqual(items.map((x) => x.id), ["222"]);
  });
});

test("load：文件缺失/损坏/非法项一律回退空列表，不抛", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "hongguo-list.json");
    const store = new HongguoListStorage({ path });
    assert.deepEqual(await store.load(), []);

    await writeFile(path, "{ broken", "utf8");
    assert.deepEqual(await store.load(), []);

    await writeFile(path, JSON.stringify({ version: 1, items: [{ id: "bad-id" }, { id: "999", name: "ok" }] }), "utf8");
    assert.deepEqual((await store.load()).map((x) => x.id), ["999"]);
  });
});
