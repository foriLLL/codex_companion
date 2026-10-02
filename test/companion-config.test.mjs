import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CompanionConfig,
  DEFAULT_CARDS,
  normalizeCompanionConfig
} from "../src/companion-config.mjs";

async function withTempDir(run) {
  const dir = await mkdtemp(join(tmpdir(), "companion-config-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("normalize：默认四张卡片全开、placement 默认 standalone，未知字段丢弃，非法值回退默认", () => {
  assert.deepEqual(normalizeCompanionConfig(null), {
    version: 1,
    enabled: true,
    placement: "standalone-button",
    cards: { games: true, hongguo: true, riverclub: true, emby: true },
    cardOrder: ["games", "hongguo", "riverclub", "emby"],
    riverclubUrl: "https://riverclub.booocai.com/"
  });
  assert.deepEqual(normalizeCompanionConfig({
    version: 99,
    enabled: "no",
    placement: "bogus",
    cards: { hongguo: false, emby: "yes", extra: 1 },
    unknownTopLevel: {}
  }), {
    version: 1,
    enabled: true,
    placement: "standalone-button",
    cards: { games: true, hongguo: false, riverclub: true, emby: true },
    cardOrder: ["games", "hongguo", "riverclub", "emby"],
    riverclubUrl: "https://riverclub.booocai.com/"
  });
  assert.equal(normalizeCompanionConfig({ enabled: false }).enabled, false);
  assert.equal(normalizeCompanionConfig({ placement: "inline-in-summary" }).placement, "inline-in-summary");
  assert.deepEqual(normalizeCompanionConfig({ cards: [] }).cards, DEFAULT_CARDS);
});

test("normalize：cardOrder 白名单过滤、去重、缺失项补末尾", () => {
  assert.deepEqual(normalizeCompanionConfig({ cardOrder: ["emby", "hongguo"] }).cardOrder, ["games", "emby", "hongguo", "riverclub"]);
  assert.deepEqual(normalizeCompanionConfig({ cardOrder: ["emby"] }).cardOrder, ["games", "emby", "hongguo", "riverclub"]);
  assert.deepEqual(normalizeCompanionConfig({ cardOrder: ["emby", "emby", "bogus"] }).cardOrder, ["games", "emby", "hongguo", "riverclub"]);
  assert.deepEqual(normalizeCompanionConfig({ cardOrder: "emby" }).cardOrder, ["games", "hongguo", "riverclub", "emby"]);
  assert.deepEqual(normalizeCompanionConfig({ cardOrder: [] }).cardOrder, ["games", "hongguo", "riverclub", "emby"]);
});

test("save 写入 0600 并可 load 回读", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "config.json");
    const config = new CompanionConfig({ path });
    await config.save({ cards: { hongguo: false, emby: true } });

    const info = await stat(path);
    assert.equal(info.mode & 0o777, 0o600);

    const loaded = await config.load();
    assert.deepEqual(loaded, {
      version: 1,
      enabled: true,
      placement: "standalone-button",
      cards: { games: true, hongguo: false, riverclub: true, emby: true },
      cardOrder: ["games", "hongguo", "riverclub", "emby"],
    riverclubUrl: "https://riverclub.booocai.com/"
    });
  });
});

test("load：文件缺失或损坏时回退默认，不抛异常", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "config.json");
    const config = new CompanionConfig({ path });
    assert.deepEqual(await config.load(), {
      version: 1,
      enabled: true,
      placement: "standalone-button",
      cards: { ...DEFAULT_CARDS },
      cardOrder: ["games", "hongguo", "riverclub", "emby"],
    riverclubUrl: "https://riverclub.booocai.com/"
    });

    await writeFile(path, "{ broken", "utf8");
    assert.deepEqual(await config.load(), {
      version: 1,
      enabled: true,
      placement: "standalone-button",
      cards: { ...DEFAULT_CARDS },
      cardOrder: ["games", "hongguo", "riverclub", "emby"],
    riverclubUrl: "https://riverclub.booocai.com/"
    });
  });
});

test("save 失败时清理临时文件", async () => {
  await withTempDir(async (dir) => {
    const config = new CompanionConfig({
      path: join(dir, "missing-parent-as-file", "config.json")
    });
    // 先把父路径占成一个普通文件，让 mkdir 失败
    await writeFile(join(dir, "missing-parent-as-file"), "occupied", "utf8");
    await assert.rejects(config.save({ cards: DEFAULT_CARDS }));
  });
});


test("River Club URL 限制来源，旧配置迁移到红果之后且保留既有顺序", () => {
  assert.deepEqual(normalizeCompanionConfig({cardOrder:["hongguo","emby"]}).cardOrder,["games","hongguo","riverclub","emby"]);
  assert.equal(normalizeCompanionConfig({riverclubUrl:"https://evil.test/"}).riverclubUrl,"https://riverclub.booocai.com/");
  assert.equal(normalizeCompanionConfig({riverclubUrl:"https://riverclub.booocai.com/?invite=test"}).riverclubUrl,"https://riverclub.booocai.com/?invite=test");
});
