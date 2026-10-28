import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { generateCardRegistry } from "../scripts/generate-card-registry.mjs";
import { discoverCards } from "../src/platform/registry/discovery.mjs";
import { validateCatalog, validateManifest } from "../src/platform/registry/manifest.mjs";

function manifest(overrides = {}) {
  return {
    id: "alpha",
    title: "Alpha",
    version: 1,
    defaultEnabled: true,
    defaultOrder: 10,
    layout: { height: "content", minHeight: 0, scroll: "outer" },
    lifecycle: { hidden: "retain", start: "first-visible" },
    state: { scope: "target", version: 1 },
    capabilities: ["storage"],
    ...overrides
  };
}

async function withCards(run) {
  const cardsDir = await mkdtemp(join(tmpdir(), "card-registry-"));
  try {
    return await run(cardsDir);
  } finally {
    await rm(cardsDir, { recursive: true, force: true });
  }
}

async function writeCard(cardsDir, directoryName, data, files = {}) {
  const directory = join(cardsDir, directoryName);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "manifest.json"), `${JSON.stringify(data)}\n`);
  if (files.renderer) await writeFile(join(directory, "renderer.mjs"), "export {}\n");
  if (files.service) await writeFile(join(directory, "service.mjs"), "export {}\n");
}

test("validateManifest 接受合法 manifest 并拒绝未知字段与非法枚举", () => {
  const value = manifest({ capabilities: ["rpc", "storage"] });
  const validated = validateManifest(value);
  assert.equal(validated.id, "alpha");
  assert.deepEqual(validated.capabilities, ["rpc", "storage"]);
  value.title = "changed";
  assert.equal(validated.title, "Alpha");
  assert.throws(() => validated.title = "nope", TypeError);

  const cases = [
    [manifest({ extra: true }), "UNKNOWN_FIELD", "extra"],
    [manifest({ layout: { height: "content", minHeight: 0, scroll: "outer", width: 1 } }), "UNKNOWN_FIELD", "layout.width"],
    [manifest({ layout: { height: "fixed", minHeight: 0, scroll: "outer" } }), "INVALID_VALUE", "layout.height"],
    [manifest({ layout: { height: "content", minHeight: -1, scroll: "outer" } }), "INVALID_VALUE", "layout.minHeight"],
    [manifest({ layout: { height: "content", minHeight: 0, scroll: "both" } }), "INVALID_VALUE", "layout.scroll"],
    [manifest({ lifecycle: { hidden: "drop", start: "first-visible" } }), "INVALID_VALUE", "lifecycle.hidden"],
    [manifest({ lifecycle: { hidden: "retain", start: "eager" } }), "INVALID_VALUE", "lifecycle.start"],
    [manifest({ state: { scope: "window", version: 1 } }), "INVALID_VALUE", "state.scope"],
    [manifest({ state: { scope: "global", version: 0 } }), "INVALID_VALUE", "state.version"],
    [manifest({ version: 1.5 }), "INVALID_VALUE", "version"],
    [manifest({ defaultEnabled: "yes" }), "INVALID_TYPE", "defaultEnabled"],
    [manifest({ defaultOrder: 1.5 }), "INVALID_VALUE", "defaultOrder"],
    [manifest({ capabilities: ["storage", "storage"] }), "DUPLICATE_CAPABILITY", "capabilities[1]"],
    [manifest({ capabilities: ["network"] }), "INVALID_VALUE", "capabilities[0]"],
    [manifest({ id: "Bad" }), "INVALID_VALUE", "id"],
    [{ title: "x" }, "MISSING_FIELD", "id"]
  ];
  for (const [input, code, field] of cases) {
    assert.throws(() => validateManifest(input), (error) => {
      assert.equal(error.code, code, `${code} ${field}: ${error.message}`);
      assert.equal(error.field, field);
      assert.match(error.message, /./);
      return true;
    });
  }
});

test("validateCatalog 按 defaultOrder 排序，相同顺序再按 id，并拒绝重复 id", () => {
  const catalog = validateCatalog([
    manifest({ id: "emby", title: "Emby", defaultOrder: 40 }),
    manifest({ id: "beta", title: "Beta", defaultOrder: 10 }),
    manifest({ id: "alpha", title: "Alpha", defaultOrder: 10 }),
    manifest({ id: "hongguo", title: "红果", defaultOrder: 20 })
  ]);
  assert.deepEqual(catalog.map((item) => item.id), ["alpha", "beta", "hongguo", "emby"]);
  assert.throws(
    () => validateCatalog([
      manifest({ id: "alpha" }),
      manifest({ id: "alpha", title: "Other", defaultOrder: 30 })
    ]),
    (error) => error.code === "DUPLICATE_ID" && error.message.includes("alpha")
  );
});

test("校验器源码不依赖文件系统", async () => {
  const source = await readFile(new URL("../src/platform/registry/manifest.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:fs|node:path|node:child_process|from\s+["']fs["']/);
});

test("discoverCards 发现第五张未知卡并按稳定顺序返回入口存在性", async () => {
  await withCards(async (cardsDir) => {
    await writeCard(cardsDir, "emby", manifest({ id: "emby", title: "Emby", defaultOrder: 40 }));
    await writeCard(cardsDir, "games", manifest({ id: "games", title: "摸鱼", defaultOrder: 10 }), { renderer: true });
    await writeCard(cardsDir, "chess", manifest({ id: "chess", title: "Chess", defaultOrder: 30, capabilities: ["rpc"] }));
    await writeCard(cardsDir, "hongguo", manifest({ id: "hongguo", title: "红果短剧", defaultOrder: 20 }));
    await writeCard(cardsDir, "arcade", manifest({ id: "arcade", title: "Arcade", defaultOrder: 15, capabilities: [] }), { service: true });

    const first = await discoverCards({ cardsDir });
    const second = await discoverCards({ cardsDir, requireEntries: false });
    assert.deepEqual(first.cards.map((card) => card.manifest.id), ["games", "arcade", "hongguo", "chess", "emby"]);
    assert.deepEqual(second.cards.map((card) => card.directoryName), first.cards.map((card) => card.directoryName));
    const games = first.cards[0];
    const arcade = first.cards[1];
    assert.equal(games.entries.renderer, true);
    assert.equal(games.entries.service, false);
    assert.equal(arcade.entries.renderer, false);
    assert.equal(arcade.entries.service, true);
    assert.equal(arcade.manifest.title, "Arcade");
  });
});

test("相同 defaultOrder 时按 id 打破平局", async () => {
  await withCards(async (cardsDir) => {
    await writeCard(cardsDir, "beta", manifest({ id: "beta", title: "Beta", defaultOrder: 10 }));
    await writeCard(cardsDir, "alpha", manifest({ id: "alpha", title: "Alpha", defaultOrder: 10 }));
    const discovered = await discoverCards({ cardsDir });
    assert.deepEqual(discovered.cards.map((card) => card.manifest.id), ["alpha", "beta"]);
  });
});

test("目录名不一致时仍拒绝重复 id", async () => {
  await withCards(async (cardsDir) => {
    await writeCard(cardsDir, "left", manifest({ id: "shared", title: "Left" }));
    await writeCard(cardsDir, "right", manifest({ id: "shared", title: "Right", defaultOrder: 20 }));
    await assert.rejects(
      () => discoverCards({ cardsDir }),
      (error) => error.code === "DUPLICATE_ID" && error.message.includes("left") && error.message.includes("right")
    );
  });
});

test("manifest id 必须与目录名一致，缺文件与坏 JSON 会失败", async () => {
  await withCards(async (cardsDir) => {
    await writeCard(cardsDir, "alpha", manifest({ id: "beta" }));
    await assert.rejects(
      () => discoverCards({ cardsDir }),
      (error) => error.code === "ID_DIRECTORY_MISMATCH"
    );
  });
  await withCards(async (cardsDir) => {
    await mkdir(join(cardsDir, "alpha"));
    await assert.rejects(
      () => discoverCards({ cardsDir }),
      (error) => error.code === "MISSING_MANIFEST"
    );
  });
  await withCards(async (cardsDir) => {
    const directory = join(cardsDir, "alpha");
    await mkdir(directory);
    await writeFile(join(directory, "manifest.json"), "{");
    await assert.rejects(
      () => discoverCards({ cardsDir }),
      (error) => error.code === "INVALID_JSON"
    );
  });
});

test("requireEntries 要求 renderer.mjs，service.mjs 可选", async () => {
  await withCards(async (cardsDir) => {
    await writeCard(cardsDir, "alpha", manifest());
    await assert.rejects(
      () => discoverCards({ cardsDir, requireEntries: true }),
      (error) => error.code === "MISSING_RENDERER" && error.id === "alpha"
    );
    await writeFile(join(cardsDir, "alpha", "renderer.mjs"), "export {}\n");
    const rendererOnly = await discoverCards({ cardsDir, requireEntries: true });
    assert.equal(rendererOnly.cards.length, 1);
    assert.equal(rendererOnly.cards[0].entries.renderer, true);
    assert.equal(rendererOnly.cards[0].entries.service, false);
    await writeFile(join(cardsDir, "alpha", "service.mjs"), "export {}\n");
    const withService = await discoverCards({ cardsDir, requireEntries: true });
    assert.equal(withService.cards[0].entries.service, true);
  });
});

test("仓库内置卡片可被发现且能力符合冻结枚举", async () => {
  const cardsDir = fileURLToPath(new URL("../src/cards/", import.meta.url));
  const discovered = await discoverCards({ cardsDir });
  assert.deepEqual(discovered.cards.map((card) => card.manifest.id), ["proxy", "games", "hongguo", "emby"]);
  assert.deepEqual(discovered.cards.map((card) => card.manifest.defaultOrder), [0, 10, 20, 40]);
  assert.deepEqual(discovered.cards.find((card) => card.manifest.id === "proxy").manifest.capabilities, ["rpc"]);
  assert.deepEqual(discovered.cards.find((card) => card.manifest.id === "games").manifest.capabilities, ["storage"]);
  assert.deepEqual(discovered.cards.find((card) => card.manifest.id === "hongguo").manifest.capabilities, ["rpc", "storage"]);
  assert.deepEqual(discovered.cards.find((card) => card.manifest.id === "emby").manifest.capabilities, ["rpc", "storage"]);
  for (const card of discovered.cards) {
    // 代理轮询在收起时暂停，其余卡片保留媒体或存档。
    assert.equal(card.manifest.lifecycle.hidden, card.manifest.id === "proxy" ? "suspend" : "retain");
    assert.equal(card.manifest.lifecycle.start, "first-visible");
    assert.equal(card.entries.renderer, true);
    assert.equal(card.entries.service, card.manifest.capabilities.includes("rpc"));
  }
});

async function readOutputs(files) {
  const entries = await Promise.all(Object.entries(files).map(async ([name, path]) => [name, await readFile(path, "utf8")]));
  return Object.fromEntries(entries);
}

test("生成两次字节相同，且 src/cards 内的生成文件不参与目录扫描", async () => {
  await withCards(async (cardsDir) => {
    await writeCard(cardsDir, "zeta", manifest({ id: "zeta", title: "Zeta", defaultOrder: 50, capabilities: ["rpc"] }));
    await writeCard(cardsDir, "alpha", manifest({ id: "alpha", title: "Alpha", defaultOrder: 10 }));
    const parent = dirname(cardsDir);
    const outDir = join(parent, "out");
    const first = await generateCardRegistry({ cardsDir, outDir });
    const second = await generateCardRegistry({ cardsDir, outDir });
    assert.equal(first.hash, second.hash);
    assert.deepEqual(await readOutputs(first.files), await readOutputs(second.files));
    await writeFile(join(cardsDir, "renderer-registry.generated.mjs"), "export {}\n");
    await writeFile(join(cardsDir, "card-catalog.json"), "{}\n");
    const again = await discoverCards({ cardsDir });
    assert.deepEqual(again.cards.map((card) => card.manifest.id), ["alpha", "zeta"]);
    const text = Object.values(await readOutputs(first.files)).join("\n");
    assert.equal(text.includes(cardsDir), false);
    assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T/);
  });
});

test("临时第五张卡生成可导入的入口注册表，输出目录与卡片目录分离", async () => {
  const root = await mkdtemp(join(tmpdir(), "card-registry-gen-"));
  try {
    const cardsDir = join(root, "library");
    const outDir = join(root, "bundle");
    await mkdir(cardsDir);
    await writeCard(cardsDir, "emby", manifest({ id: "emby", title: "Emby", defaultOrder: 40, capabilities: ["rpc", "storage"] }));
    await writeCard(cardsDir, "games", manifest({ id: "games", title: "摸鱼", defaultOrder: 10 }));
    await writeCard(cardsDir, "hongguo", manifest({ id: "hongguo", title: "红果", defaultOrder: 20, capabilities: ["rpc", "storage"] }));
    await writeCard(cardsDir, "chess", manifest({ id: "chess", title: "Chess", defaultOrder: 30, capabilities: ["rpc"] }));
    await writeCard(cardsDir, "arcade", manifest({ id: "arcade", title: "Arcade", defaultOrder: 15, capabilities: ["storage", "rpc"] }), { renderer: true, service: true });
    await writeFile(join(cardsDir, "arcade", "renderer.mjs"), "export const marker = \"arcade-renderer\";\n");
    await writeFile(join(cardsDir, "arcade", "service.mjs"), "export const marker = \"arcade-service\";\n");
    const result = await generateCardRegistry({ cardsDir, outDir });
    const registry = await import(pathToFileURL(result.files.registry).href);
    const renderers = await import(pathToFileURL(result.files.rendererRegistry).href);
    const services = await import(pathToFileURL(result.files.serviceRegistry).href);
    assert.deepEqual(registry.CARD_MANIFESTS.map((item) => item.id), ["games", "arcade", "hongguo", "chess", "emby"]);
    assert.equal(registry.getCardManifest("arcade").title, "Arcade");
    assert.equal(registry.getCardManifest("missing"), null);
    assert.equal(registry.CARD_REGISTRY_HASH, result.hash);
    assert.equal(renderers.RENDERER_REGISTRY.arcade.marker, "arcade-renderer");
    assert.equal(services.SERVICE_REGISTRY.arcade.marker, "arcade-service");
    assert.deepEqual(Object.keys(renderers.RENDERER_REGISTRY), ["arcade"]);
    const rendererSource = await readFile(result.files.rendererRegistry, "utf8");
    assert.match(rendererSource, /from "\.\.\/\.\.\/library\/arcade\/renderer\.mjs"/);
    const catalog = JSON.parse(await readFile(result.files.catalog, "utf8"));
    assert.equal(catalog.hash, result.hash);
    assert.equal(catalog.cards.length, 5);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("未知字段与严格缺入口在生成阶段失败", async () => {
  await withCards(async (cardsDir) => {
    await writeCard(cardsDir, "alpha", manifest({ extra: true }));
    const outDir = join(cardsDir, "..", "out-invalid");
    await assert.rejects(
      () => generateCardRegistry({ cardsDir, outDir }),
      (error) => error.code === "UNKNOWN_FIELD"
    );
  });
  await withCards(async (cardsDir) => {
    await writeCard(cardsDir, "alpha", manifest(), { service: true });
    const outDir = join(dirname(cardsDir), "out-strict");
    await assert.rejects(
      () => generateCardRegistry({ cardsDir, outDir, requireEntries: true }),
      (error) => error.code === "MISSING_RENDERER"
    );
    await writeFile(join(cardsDir, "alpha", "renderer.mjs"), "export const marker = \"alpha\";\n");
    const result = await generateCardRegistry({ cardsDir, outDir, requireEntries: true });
    const renderers = await import(pathToFileURL(result.files.rendererRegistry).href);
    const services = await import(pathToFileURL(result.files.serviceRegistry).href);
    assert.equal(renderers.RENDERER_REGISTRY.alpha.marker, "alpha");
    assert.equal(Object.keys(services.SERVICE_REGISTRY).length, 1);
  });
});
