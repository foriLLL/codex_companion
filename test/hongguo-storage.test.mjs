import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HongguoCatalogStorage } from "../src/hongguo-storage.mjs";
import { assertMode } from "./helpers/permissions.mjs";

test("红果目录快照原子保存为 0600，并忽略损坏缓存", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-companion-hongguo-storage-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cachePath = join(directory, "nested", "hongguo-home.json");
  const storage = new HongguoCatalogStorage({
    cachePath,
    randomUUIDImpl: () => "snapshot"
  });
  const snapshot = {
    at: 1234,
    data: {
      featured: [{ id: "1", name: "短剧" }],
      items: [{ id: "1", name: "短剧" }]
    }
  };

  await storage.save(snapshot);
  assert.deepEqual(await storage.load(), snapshot);
  assertMode(await stat(cachePath), 0o600);
  assert.match(await readFile(cachePath, "utf8"), /"短剧"/);

  await writeFile(cachePath, "{broken", "utf8");
  assert.equal(await storage.load(), null);
});

test("codex-hg 红果缓存自动复制到 codex-companion 路径", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "codex-companion-hongguo-migration-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cachePath = join(directory, "codex-companion", "hongguo-home.json");
  const legacyCachePath = join(directory, "codex-hg", "hongguo-home.json");
  await mkdir(join(directory, "codex-hg"), { recursive: true });
  const snapshot = {
    at: 1234,
    data: { featured: [{ id: "1" }], items: [{ id: "1" }] }
  };
  await writeFile(legacyCachePath, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });

  const storage = new HongguoCatalogStorage({ cachePath, legacyCachePath });
  assert.deepEqual(await storage.load(), snapshot);
  assert.deepEqual(JSON.parse(await readFile(cachePath, "utf8")), snapshot);
});
