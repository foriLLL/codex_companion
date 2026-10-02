import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { discoverCards } from "../src/platform/registry/discovery.mjs";

/**
 * 从卡片目录生成静态注册表。
 *
 *   node scripts/generate-card-registry.mjs
 *     [--cards-dir <dir>] [--out-dir <dir>] [--require-entries]
 *
 * --cards-dir  默认 <repo>/src/cards
 * --out-dir    默认 <repo>/src，其下写出：
 *              card-registry.mjs
 *              cards/renderer-registry.generated.mjs
 *              cards/service-registry.generated.mjs
 *              cards/card-catalog.json
 * --require-entries  每张卡必须已有 renderer.mjs。默认关闭（metadata-only），
 *              允许内置卡尚未提供入口；已存在的 renderer.mjs / service.mjs 仍会写入导入注册表。
 *              service.mjs 在两种模式下都可选。
 *
 * 导入路径只指向固定文件名 renderer.mjs / service.mjs，不接受 manifest 里的路径。
 * 产物不含时间戳与绝对路径。
 */

const VALIDATOR_PATH = fileURLToPath(new URL("../src/platform/registry/manifest.mjs", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashCatalog(cards) {
  return createHash("sha256").update(canonicalJson(cards)).digest("hex");
}

function realpathExisting(path) {
  try {
    return realpathSync(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return join(realpathSync(dirname(path)), basename(path));
  }
}

function toImportSpecifier(fromFile, targetFile) {
  const raw = relative(dirname(realpathExisting(fromFile)), realpathExisting(targetFile));
  if (!raw || raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw)) {
    throw new Error(`入口导入必须是相对路径，无法从 ${fromFile} 指向 ${targetFile}`);
  }
  const specifier = raw.split(sep).join("/");
  return specifier.startsWith(".") ? specifier : `./${specifier}`;
}

function assertFixedEntry(specifier, fileName) {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
    throw new Error(`拒绝非相对入口 ${specifier}`);
  }
  if (specifier.includes("\\") || specifier.includes("//")) {
    throw new Error(`拒绝非相对入口 ${specifier}`);
  }
  const segments = specifier.split("/");
  if (segments.some((segment) => segment.length === 0) || segments.at(-1) !== fileName) {
    throw new Error(`拒绝非固定入口 ${specifier}`);
  }
}

function catalogCard(card) {
  const manifest = card.manifest;
  return {
    id: manifest.id,
    title: manifest.title,
    version: manifest.version,
    defaultEnabled: manifest.defaultEnabled,
    defaultOrder: manifest.defaultOrder,
    layout: {
      height: manifest.layout.height,
      minHeight: manifest.layout.minHeight,
      scroll: manifest.layout.scroll
    },
    lifecycle: {
      hidden: manifest.lifecycle.hidden,
      start: manifest.lifecycle.start
    },
    state: {
      scope: manifest.state.scope,
      version: manifest.state.version
    },
    capabilities: [...manifest.capabilities],
    entries: {
      renderer: card.entries.renderer,
      service: card.entries.service
    }
  };
}

function manifestRecord(card) {
  const record = catalogCard(card);
  delete record.entries;
  return record;
}

function renderEntryRegistry({ kind, cards, fromFile, requireEntries }) {
  const fileName = kind === "renderer" ? "renderer.mjs" : "service.mjs";
  const exportName = kind === "renderer" ? "RENDERER_REGISTRY" : "SERVICE_REGISTRY";
  const binding = kind === "renderer" ? "renderer" : "service";
  const present = cards.filter((card) => card.entries[kind]);
  const missing = cards.filter((card) => !card.entries[kind]).map((card) => card.manifest.id);
  const lines = [
    "// 由 scripts/generate-card-registry.mjs 生成。请勿手改。",
    `// mode: ${requireEntries ? "require-entries" : "metadata-only"}`
  ];
  if (missing.length > 0) {
    lines.push(`// 无 ${fileName}，未注册：${missing.join(", ")}`);
  }
  lines.push("");
  present.forEach((card, index) => {
    const specifier = toImportSpecifier(fromFile, join(card.directory, fileName));
    assertFixedEntry(specifier, fileName);
    lines.push(`import * as ${binding}${index} from ${JSON.stringify(specifier)};`);
  });
  if (present.length > 0) lines.push("");
  lines.push(`export const ${exportName} = Object.freeze({`);
  present.forEach((card, index) => {
    lines.push(`  ${JSON.stringify(card.manifest.id)}: ${binding}${index},`);
  });
  lines.push("});", "");
  return lines.join("\n");
}

function renderCardRegistry({ cards, hash, fromFile }) {
  const specifier = toImportSpecifier(fromFile, VALIDATOR_PATH);
  assertFixedEntry(specifier, "manifest.mjs");
  const manifests = cards.map((card) => manifestRecord(card));
  return [
    "// 由 scripts/generate-card-registry.mjs 生成。请勿手改。",
    "// 静态元数据，供 Node 与 bundle 直接 import；运行时不读文件系统。",
    `import { validateCatalog } from ${JSON.stringify(specifier)};`,
    "",
    `export const CARD_REGISTRY_HASH = ${JSON.stringify(hash)};`,
    "",
    `export const CARD_MANIFESTS = validateCatalog(${JSON.stringify(manifests, null, 2)});`,
    "",
    "const CARD_MANIFESTS_BY_ID = new Map(CARD_MANIFESTS.map((manifest) => [manifest.id, manifest]));",
    "",
    "export function getCardManifest(id) {",
    "  return CARD_MANIFESTS_BY_ID.get(id) ?? null;",
    "}",
    ""
  ].join("\n");
}

/**
 * @param {{ cardsDir: string, outDir: string, requireEntries?: boolean }} options
 */
export async function generateCardRegistry({ cardsDir, outDir, requireEntries = false } = {}) {
  if (typeof cardsDir !== "string" || typeof outDir !== "string") {
    throw new Error("cardsDir 与 outDir 必须是字符串");
  }
  const resolvedCardsDir = resolve(cardsDir);
  const resolvedOutDir = resolve(outDir);
  const discovered = await discoverCards({ cardsDir: resolvedCardsDir, requireEntries });
  const cards = discovered.cards.map((card) => catalogCard(card)).map((record, index) => ({
    ...discovered.cards[index],
    catalog: record
  }));
  const catalogCards = cards.map((card) => card.catalog);
  const hash = hashCatalog(catalogCards);
  const registryPath = join(resolvedOutDir, "card-registry.mjs");
  const cardsOutDir = join(resolvedOutDir, "cards");
  const rendererPath = join(cardsOutDir, "renderer-registry.generated.mjs");
  const servicePath = join(cardsOutDir, "service-registry.generated.mjs");
  const catalogPath = join(cardsOutDir, "card-catalog.json");
  await mkdir(cardsOutDir, { recursive: true });
  const catalog = { hash, cards: catalogCards };
  await writeFile(registryPath, renderCardRegistry({
    cards: discovered.cards,
    hash,
    fromFile: registryPath
  }));
  await writeFile(rendererPath, renderEntryRegistry({
    kind: "renderer",
    cards: discovered.cards,
    fromFile: rendererPath,
    requireEntries
  }));
  await writeFile(servicePath, renderEntryRegistry({
    kind: "service",
    cards: discovered.cards,
    fromFile: servicePath,
    requireEntries
  }));
  await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
  return {
    hash,
    files: {
      registry: registryPath,
      rendererRegistry: rendererPath,
      serviceRegistry: servicePath,
      catalog: catalogPath
    }
  };
}

function parseArgs(argv) {
  const options = { cardsDir: null, outDir: null, requireEntries: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--require-entries") options.requireEntries = true;
    else if (arg === "--cards-dir") options.cardsDir = readValue(argv, index += 1, arg);
    else if (arg === "--out-dir") options.outDir = readValue(argv, index += 1, arg);
    else throw new Error(`未知参数 ${arg}`);
  }
  return options;
}

function readValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} 需要路径参数`);
  return value;
}

const HELP = `用法: node scripts/generate-card-registry.mjs [--cards-dir <dir>] [--out-dir <dir>] [--require-entries]

默认 --cards-dir src/cards，--out-dir src。
metadata-only（默认）允许缺少 renderer.mjs；--require-entries 缺少前端入口时失败。
service.mjs 始终可选。`;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  const result = await generateCardRegistry({
    cardsDir: options.cardsDir ?? join(REPO_ROOT, "src", "cards"),
    outDir: options.outDir ?? join(REPO_ROOT, "src"),
    requireEntries: options.requireEntries
  });
  process.stdout.write(`${result.hash} ${result.files.registry}\n`);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
