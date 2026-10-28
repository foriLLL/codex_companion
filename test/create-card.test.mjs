import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { createCard, parseArgs } from "../scripts/create-card.mjs";
import { discoverCards } from "../src/platform/registry/discovery.mjs";
import { generateCardRegistry } from "../scripts/generate-card-registry.mjs";
import { createStore } from "../src/renderer/platform/storage.mjs";
import { createEffects } from "../src/renderer/platform/effects.mjs";

const execute = promisify(execFile);
async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), "companion-card-template-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function dom() {
  const elements = [];
  const document = { createElement: tag => {
    const element = new Element(tag);
    elements.push(element);
    return element;
  } };
  class Element extends EventTarget {
    constructor(tag) { super(); this.tag = tag; this.children = []; this.dataset = {}; this.ownerDocument = document; }
    append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
    setAttribute(name, value) { this[name] = value; }
  }
  return { root: new Element("shadow-root"), elements };
}

function storage() {
  const values = new Map();
  return { values, namespace(name, options) {
    return createStore({ storage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }, namespace: name, ...options });
  } };
}

test("默认模板关闭且无服务依赖，CLI 生成可严格发现的卡片", async t => {
  const directory = await temporary(t);
  const cardsDir = join(directory, "cards");
  const { stdout } = await execute(process.execPath, ["scripts/create-card.mjs", "counter", "--title", "窗口计数器", "--dir", cardsDir], { cwd: new URL("..", import.meta.url) });
  const result = JSON.parse(stdout);
  assert.equal(result.service, false);
  const found = await discoverCards({ cardsDir, requireEntries: true });
  assert.equal(found.cards.length, 1);
  assert.equal(found.cards[0].manifest.defaultEnabled, false);
  assert.equal(found.cards[0].manifest.title, "窗口计数器");
  assert.deepEqual(found.cards[0].manifest.capabilities, ["storage"]);
  assert.deepEqual(found.cards[0].entries, { renderer: true, service: false });
  assert.deepEqual((await readdir(result.directory)).sort(), ["manifest.json", "renderer.mjs"]);
  const source = await readFile(join(result.directory, "renderer.mjs"), "utf8");
  assert.doesNotMatch(source, /ctx\.rpc\("ping"\)/);
});

test("五个陌生目录通过 strict discovery 与 generator 自动进入 renderer/service/catalog", async t => {
  const directory = await temporary(t);
  const cardsDir = join(directory, "cards");
  for (const id of ["alpha", "beta", "gamma", "delta", "fifth"]) await createCard({ id, cardsDir, service: id === "fifth" });
  const discovered = await discoverCards({ cardsDir, requireEntries: true });
  assert.equal(discovered.cards.length, 5);
  const { files } = await generateCardRegistry({ cardsDir, outDir: join(directory, "generated"), requireEntries: true });
  const { CARD_MANIFESTS } = await import(pathToFileURL(files.registry).href);
  const { RENDERER_REGISTRY } = await import(pathToFileURL(files.rendererRegistry).href);
  const { SERVICE_REGISTRY } = await import(pathToFileURL(files.serviceRegistry).href);
  assert.deepEqual(CARD_MANIFESTS.map(card => card.id), ["alpha", "beta", "delta", "fifth", "gamma"]);
  assert.deepEqual(Object.keys(RENDERER_REGISTRY), CARD_MANIFESTS.map(card => card.id));
  assert.ok(Object.values(RENDERER_REGISTRY).every(module => typeof module.mount === "function"));
  assert.deepEqual(Object.keys(SERVICE_REGISTRY), ["fifth"]);
  const catalog = JSON.parse(await readFile(files.catalog, "utf8"));
  assert.equal(catalog.cards.find(card => card.id === "fifth").entries.service, true);
  assert.deepEqual(catalog.cards.find(card => card.id === "fifth").capabilities, ["storage", "rpc"]);
  const service = SERVICE_REGISTRY.fifth.createService();
  assert.deepEqual(await service.methods.ping({}, { signal: new AbortController().signal }), { message: "pong" });
  const stopped = new AbortController();
  stopped.abort(new Error("stopped"));
  await assert.rejects(service.methods.ping({}, { signal: stopped.signal }), /stopped/);
});

test("生成 renderer 实际使用 effects/storage/settings，服务模板的 ping 按声明工作", async t => {
  const directory = await temporary(t);
  for (const service of [false, true]) {
    const title = '标题 " ; globalThis.templateInjection = true; // <b>';
    const created = await createCard({ id: service ? "with-service" : "local-only", title, cardsDir: directory, service });
    const { mount } = await import(pathToFileURL(join(created.directory, "renderer.mjs")).href);
    const { root, elements } = dom();
    const controller = new AbortController();
    const effects = createEffects({ signal: controller.signal });
    const store = storage();
    const errors = [];
    const rpcCalls = [];
    const handle = mount({ root, effects, signal: controller.signal, storage: store, reportError: error => errors.push(error), rpc: async method => { rpcCalls.push(method); return { message: "pong" }; } });
    assert.equal(elements.find(element => element.tag === "h2").textContent, title);
    assert.equal(globalThis.templateInjection, undefined);
    const buttons = elements.filter(element => element.tag === "button");
    buttons[0].dispatchEvent(new Event("click"));
    assert.equal(buttons[0].textContent, "本窗口计数：1");
    assert.equal(JSON.parse(store.values.get("counter")).value.count, 1);
    handle.updateSettings({ label: "新的标签" });
    assert.equal(elements.find(element => element.tag === "h2").textContent, "新的标签");
    handle.visibilityChanged({ visible: false });
    assert.equal(JSON.parse(store.values.get("counter")).value.count, 1);
    assert.equal(root.children.length, 2);
    if (service) {
      buttons[1].dispatchEvent(new Event("click"));
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(rpcCalls, ["ping"]);
      assert.equal(elements.find(element => element.role === "status").textContent, "pong");
    } else assert.deepEqual(rpcCalls, []);
    assert.deepEqual(errors, []);
    controller.abort();
    await effects.dispose();
    handle.dispose();
    handle.dispose();
    buttons[0].dispatchEvent(new Event("click"));
    assert.equal(JSON.parse(store.values.get("counter")).value.count, 1);
    assert.equal(root.children.length, 0);
    assert.equal(effects.diagnostics().active, 0);
  }
});

test("拒绝非法 id、路径穿越和无效选项，验证失败不会创建目录", async t => {
  const directory = await temporary(t);
  const cardsDir = join(directory, "cards");
  for (const id of [undefined, "", "../escape", "/absolute", "a/b", "a\\b", "a.b", "Upper", "卡片", "constructor", "prototype", "a".repeat(65)]) {
    await assert.rejects(createCard({ id, cardsDir }));
  }
  for (const title of ["", " ", 42, "a".repeat(201)]) await assert.rejects(createCard({ id: "valid", cardsDir, title }));
  await assert.rejects(stat(cardsDir), { code: "ENOENT" });
  for (const args of [["valid", "other"], ["valid", "--title"], ["valid", "--dir"], ["valid", "--service", "--service"], ["valid", "--unknown"], ["valid", "--title", "one", "--title", "two"]]) assert.throws(() => parseArgs(args));
  assert.deepEqual(parseArgs(["--help"]), { help: true });
});

test("既有文件/目录/符号链接和并发创建均不覆盖目标", async t => {
  const directory = await temporary(t);
  const cardsDir = join(directory, "cards");
  await mkdir(cardsDir);
  await writeFile(join(cardsDir, "file"), "preserve-file");
  await mkdir(join(cardsDir, "existing"));
  await writeFile(join(cardsDir, "existing", "marker"), "preserve-directory");
  const outside = join(directory, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "marker"), "preserve-link-target");
  // Windows 未开启开发者模式时不能创建符号链接，此时只验证文件与目录。
  const linked = await symlink(outside, join(cardsDir, "linked"))
    .then(() => lstat(join(cardsDir, "linked")))
    .then((stats) => stats.isSymbolicLink(), () => false);
  for (const id of ["file", "existing", ...(linked ? ["linked"] : [])]) await assert.rejects(createCard({ id, cardsDir }), { code: "EEXIST" });
  assert.equal(await readFile(join(cardsDir, "file"), "utf8"), "preserve-file");
  assert.equal(await readFile(join(cardsDir, "existing", "marker"), "utf8"), "preserve-directory");
  assert.deepEqual(await readdir(outside), ["marker"]);
  const results = await Promise.allSettled([createCard({ id: "race", cardsDir }), createCard({ id: "race", cardsDir })]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.find(result => result.status === "rejected").reason.code, "EEXIST");
  assert.equal(JSON.parse(await readFile(join(cardsDir, "race", "manifest.json"), "utf8")).id, "race");
});
