import assert from "node:assert/strict";
import test from "node:test";
import { createSettingsPanel } from "../src/renderer/shell/settings-panel.mjs";
import { createCardShell } from "../src/renderer/shell/card-shell.mjs";
import { createCardRuntime } from "../src/renderer/runtime/card-runtime.mjs";
import { createRpcClient } from "../src/renderer/platform/rpc-client.mjs";

// 只实现面板用到的 DOM；布局、原生输入行为与 Shadow DOM 另由 Chromium 冒烟验证。
class Element extends EventTarget {
  constructor(tag, document) {
    super();
    this.tagName = tag;
    this.ownerDocument = document;
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.attributes = new Map();
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = "";
    this.text = "";
  }
  set textContent(value) { this.text = value; this.replaceChildren(); }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(""); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  append(...children) { for (const child of children) this.insertBefore(child, null); }
  insertBefore(child, anchor) {
    child.remove();
    const index = anchor ? this.children.indexOf(anchor) : this.children.length;
    this.children.splice(index, 0, child);
    child.parentNode = this;
    return child;
  }
  replaceChildren(...children) {
    for (const child of [...this.children]) child.remove();
    this.append(...children);
  }
  remove() {
    if (!this.parentNode) return;
    this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
    this.parentNode = null;
  }
  get parentElement() { return this.parentNode; }
  get nextSibling() { return this.parentNode?.children[this.parentNode.children.indexOf(this) + 1] ?? null; }
  get isConnected() { return this === this.ownerDocument.body || Boolean(this.parentNode?.isConnected || this.host?.isConnected); }
  contains(other) { return this === other || this.children.some(child => child.contains(other)); }
  querySelector(tag) { return descendants(this).find(child => child.tagName === tag) ?? null; }
  getRootNode() { return this.ownerDocument; }
  focus() { if (!this.disabled) this.ownerDocument.activeElement = this; }
  click() { if (!this.disabled) this.dispatchEvent(new Event("click")); }
  attachShadow() { this.shadowRoot = new Element("#shadow-root", this.ownerDocument); this.shadowRoot.host = this; return this.shadowRoot; }
}
function makeDocument() {
  const document = { createElement(tag) { return new Element(tag, this); } };
  document.body = document.createElement("body");
  document.activeElement = document.body;
  return document;
}
const descendants = root => root.children.flatMap(child => [child, ...descendants(child)]);
const bySetting = (root, key) => descendants(root).find(child => child.dataset.setting === key);
const byLabel = (root, label) => descendants(root).find(child => child.getAttribute("aria-label") === label);
const byText = (root, text, tag = "button") => descendants(root).find(child => child.tagName === tag && child.textContent === text);
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const catalog = [
  { id: "alpha", title: "甲卡片", defaultEnabled: true, defaultOrder: 0 },
  { id: "beta", title: "乙卡片", defaultEnabled: false, defaultOrder: 1 }
];
const initialConfig = () => ({
  version: 2, revision: 4, enabled: true, order: ["alpha", "future", "beta"], placement: "standalone-button",
  cards: { alpha: { enabled: true, settings: { keep: true } }, beta: { enabled: false, settings: {} }, future: { enabled: true, settings: { unknown: true } } },
  launch: { proxy: { enabled: false, port: 7890 } }, agent: { autoRelaunch: true }
});
function fixture(handler) {
  const document = makeDocument();
  const calls = [];
  let closed = 0;
  const call = async (method, params) => {
    calls.push({ method, params });
    if (handler) return handler(method, params, calls);
    if (method === "companion.settings.get") return { config: initialConfig(), catalog, agent: null };
    if (method === "companion.agent.status") return { available: false };
    throw Error(`unexpected ${method}`);
  };
  const panel = createSettingsPanel({ document, call, onClose: () => { closed++; } });
  document.body.append(panel.element);
  return { document, panel, calls, get closed() { return closed; } };
}
function change(input, value) {
  if (input.type === "checkbox" || input.type === "radio") input.checked = value;
  else input.value = value;
  input.dispatchEvent(new Event("change"));
}
function submitPort(root, value) {
  const input = bySetting(root, "proxy-port");
  input.value = value;
  input.dispatchEvent(new Event("input"));
  input.parentNode.parentNode.dispatchEvent(new Event("submit", { cancelable: true }));
}
function arrow(element, key) {
  const event = new Event("keydown", { cancelable: true });
  Object.defineProperty(event, "key", { value: key });
  element.dispatchEvent(event);
}
function escape(element) {
  const event = new Event("keydown", { cancelable: true });
  Object.defineProperty(event, "key", { value: "Escape" });
  element.dispatchEvent(event);
  return event;
}

test("设置页首次打开才读取，渲染全部区块与 catalog 标题，状态只认 status RPC", async () => {
  const f = fixture();
  assert.equal(f.panel.element.hidden, true);
  assert.equal(f.calls.length, 0);
  await f.panel.open();
  const root = f.panel.element;
  assert.deepEqual(f.calls.map(item => item.method), ["companion.settings.get", "companion.agent.status"]);
  assert.deepEqual(descendants(root).filter(item => item.tagName === "legend").map(item => item.textContent), ["卡片", "显示方式", "启动", "自动加载", "状态"]);
  assert.ok(bySetting(root, "enabled").checked);
  assert.ok(bySetting(root, "card-alpha").parentNode.textContent.includes("甲卡片"));
  assert.equal(bySetting(root, "card-beta").checked, false);
  assert.equal(bySetting(root, "proxy-port").value, "7890");
  assert.ok(root.textContent.includes("后台服务未运行"));
  assert.equal(f.document.activeElement, byLabel(root, "关闭 Companion 设置"));
  await f.panel.open();
  assert.equal(f.calls.length, 2, "重复 open 幂等");
  f.panel.destroy();
});

test("每次 patch 带当前 revision，保存期间禁止并发编辑，结果只更新表单", async () => {
  let config = initialConfig();
  const gate = deferred();
  const f = fixture(async (method, params) => {
    if (method === "companion.settings.get") return { config, catalog };
    if (method === "companion.agent.status") return { available: false };
    assert.equal(params.expectedRevision, config.revision);
    if (params.patch.enabled === false) await gate.promise;
    config = { ...config, ...params.patch, revision: config.revision + 1 };
    return { config };
  });
  await f.panel.open();
  const root = f.panel.element;
  change(bySetting(root, "enabled"), false);
  for (const input of descendants(root).filter(item => item.tagName === "input")) assert.ok(input.disabled);
  assert.equal(byLabel(root, "关闭 Companion 设置").disabled, false);
  byText(root, "立即重启 Codex").click();
  change(bySetting(root, "auto-relaunch"), false);
  assert.equal(f.calls.filter(item => item.method.endsWith("patch")).length, 1);
  gate.resolve();
  await turn();
  assert.equal(bySetting(root, "enabled").disabled, false);
  change(bySetting(root, "auto-relaunch"), false);
  await turn();
  const patches = f.calls.filter(item => item.method.endsWith("patch"));
  assert.deepEqual(patches.map(item => item.params), [
    { expectedRevision: 4, patch: { enabled: false } },
    { expectedRevision: 5, patch: { agent: { autoRelaunch: false } } }
  ]);
  assert.equal(f.calls.some(item => item.method.endsWith("restart")), false);
  f.panel.destroy();
});

test("刷新状态只请求 status，不丢弃尚未保存的端口", async () => {
  const f = fixture();
  await f.panel.open();
  bySetting(f.panel.element, "proxy-port").value = "9000";
  byLabel(f.panel.element, "刷新状态").click();
  await turn();
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls.at(-1).method, "companion.agent.status");
  assert.equal(bySetting(f.panel.element, "proxy-port").value, "9000");
  f.panel.destroy();
});

test("卡片开关、排序、placement 和代理开关只发送最小补丁，保留未知卡片的顺序", async () => {
  const config = initialConfig();
  const f = fixture((method, params) => {
    if (method === "companion.settings.get") return { config, catalog };
    if (method === "companion.agent.status") return { available: false };
    return { config: { ...config, ...(params.patch.order ? { order: params.patch.order } : {}), revision: 5 } };
  });
  await f.panel.open();
  const root = f.panel.element;
  const callCount = f.calls.length;
  arrow(byLabel(root, "调整 甲卡片 的顺序"), "ArrowUp");
  arrow(byLabel(root, "调整 乙卡片 的顺序"), "ArrowDown");
  await turn();
  assert.equal(f.calls.length, callCount, "首尾越界不保存");
  arrow(byLabel(root, "调整 甲卡片 的顺序"), "ArrowDown");
  await turn();
  assert.deepEqual(f.calls.at(-1).params.patch, { order: ["beta", "future", "alpha"] });
  change(bySetting(root, "card-beta"), true);
  await turn();
  assert.deepEqual(f.calls.at(-1).params.patch, { cards: { beta: { enabled: true } } });
  const inline = descendants(root).find(item => item.type === "radio" && item.value === "inline-in-summary");
  change(inline, true);
  await turn();
  assert.deepEqual(f.calls.at(-1).params.patch, { placement: "inline-in-summary" });
  change(bySetting(root, "proxy-enabled"), true);
  await turn();
  assert.deepEqual(f.calls.at(-1).params.patch, { launch: { proxy: { enabled: true } } });
  assert.deepEqual(config, initialConfig(), "不能修改 RPC 返回的原始配置对象");
  f.panel.destroy();
});

test("CONFIG_CONFLICT 重新读取，不重放旧 patch，下一次编辑使用刷新后的 revision", async () => {
  let reads = 0, patches = 0;
  const f = fixture((method, params) => {
    if (method === "companion.settings.get") return { config: { ...initialConfig(), revision: ++reads === 1 ? 4 : 9, enabled: reads === 1 }, catalog };
    if (method === "companion.agent.status") return { available: false };
    if (++patches === 1) throw Object.assign(Error("conflict"), { code: "CONFIG_CONFLICT", revision: 9 });
    return { config: { ...initialConfig(), revision: 10, enabled: params.patch.enabled } };
  });
  await f.panel.open();
  change(bySetting(f.panel.element, "enabled"), false);
  await turn();
  assert.equal(reads, 2);
  assert.equal(patches, 1);
  assert.ok(f.panel.element.textContent.includes("配置已在别处修改，已刷新"));
  assert.equal(bySetting(f.panel.element, "enabled").checked, false);
  change(bySetting(f.panel.element, "enabled"), true);
  await turn();
  assert.equal(f.calls.at(-1).params.expectedRevision, 9);
  f.panel.destroy();
});

test("CONFIG_CONFLICT 后重读失败时不能继续用旧 revision，重试重新读取", async () => {
  let reads = 0;
  const f = fixture(method => {
    if (method === "companion.settings.get") {
      if (++reads === 2) throw Object.assign(Error("offline"), { code: "BRIDGE_UNAVAILABLE" });
      return { config: initialConfig(), catalog };
    }
    if (method === "companion.agent.status") return { available: false };
    throw Object.assign(Error("conflict"), { code: "CONFIG_CONFLICT" });
  });
  await f.panel.open();
  change(bySetting(f.panel.element, "enabled"), false);
  await turn();
  assert.equal(bySetting(f.panel.element, "enabled").disabled, true);
  byText(f.panel.element, "重试").click();
  await turn();
  assert.equal(reads, 3);
  assert.equal(bySetting(f.panel.element, "enabled").disabled, false);
  f.panel.destroy();
});

test("冲突刷新配置成功但状态读取失败，仍提示冲突刷新并保留可编辑配置", async () => {
  let reads = 0;
  const f = fixture(method => {
    if (method === "companion.settings.get") return { config: { ...initialConfig(), revision: ++reads + 4 }, catalog };
    if (method === "companion.agent.status") {
      if (reads > 1) throw Object.assign(Error("timeout"), { code: "RPC_TIMEOUT" });
      return { available: false };
    }
    throw Object.assign(Error("conflict"), { code: "CONFIG_CONFLICT" });
  });
  await f.panel.open();
  change(bySetting(f.panel.element, "enabled"), false);
  await turn();
  assert.ok(f.panel.element.textContent.includes("配置已在别处修改，已刷新"));
  assert.ok(f.panel.element.textContent.includes("请求超时"));
  assert.equal(bySetting(f.panel.element, "enabled").disabled, false);
  f.panel.destroy();
});

for (const code of ["BRIDGE_UNAVAILABLE", "RPC_TIMEOUT"]) {
  test(`${code} 显示错误和重试，失败写入的重试只读取`, async () => {
    let failRead = true;
    const f = fixture(method => {
      if (method === "companion.settings.get" && !failRead) return { config: initialConfig(), catalog };
      if (method === "companion.agent.status") return { available: false };
      throw Object.assign(Error("backend failure"), { code });
    });
    await f.panel.open();
    assert.equal(byText(f.panel.element, "重试").hidden, false);
    assert.ok(f.panel.element.textContent.includes(code === "RPC_TIMEOUT" ? "请求超时" : "后台连接不可用"));
    failRead = false;
    byText(f.panel.element, "重试").click();
    await turn();
    change(bySetting(f.panel.element, "enabled"), false);
    await turn();
    assert.equal(bySetting(f.panel.element, "enabled").disabled, true);
    byText(f.panel.element, "重试").click();
    await turn();
    assert.equal(f.calls.filter(item => item.method.endsWith("patch")).length, 1);
    assert.equal(bySetting(f.panel.element, "enabled").disabled, false);
    f.panel.destroy();
  });
}

test("端口只接受 1–65535 的十进制整数，边界有效且保存带 revision", async () => {
  const f = fixture((method, params) => {
    if (method === "companion.settings.get") return { config: initialConfig(), catalog };
    if (method === "companion.agent.status") return { available: false };
    return { config: { ...initialConfig(), launch: { proxy: { enabled: false, port: params.patch.launch.proxy.port } }, revision: 5 } };
  });
  await f.panel.open();
  for (const invalid of ["", " ", "0", "65536", "-1", "1.5", "1e3", "abc", "+80", "0x50"]) {
    submitPort(f.panel.element, invalid);
    assert.equal(bySetting(f.panel.element, "proxy-port").getAttribute("aria-invalid"), "true", invalid);
  }
  assert.equal(f.calls.length, 2);
  for (const port of [1, 65535]) {
    submitPort(f.panel.element, String(port));
    await turn();
    assert.deepEqual(f.calls.at(-1).params.patch, { launch: { proxy: { port } } });
    assert.equal(bySetting(f.panel.element, "proxy-port").getAttribute("aria-invalid"), null);
  }
  assert.equal(f.calls.at(-1).params.expectedRevision, 5);
  f.panel.destroy();
});

test("重启必须面板内确认，取消不调用，确认期间禁用，失败重试不重放重启", async () => {
  const gate = deferred();
  const f = fixture(method => {
    if (method === "companion.settings.get") return { config: initialConfig(), catalog };
    if (method === "companion.agent.status") return { available: false };
    return gate.promise;
  });
  await f.panel.open();
  const root = f.panel.element;
  byText(root, "立即重启 Codex").click();
  assert.equal(byLabel(root, "确认重启 Codex").hidden, false);
  assert.ok(root.textContent.includes("将正常退出并重新打开 Codex，未保存的输入可能丢失"));
  assert.equal(f.document.activeElement, byText(root, "取消"));
  byText(root, "取消").click();
  assert.equal(f.calls.length, 2);
  byText(root, "立即重启 Codex").click();
  byText(root, "确认重启").click();
  byText(root, "确认重启").click();
  assert.equal(f.calls.length, 3);
  assert.deepEqual(f.calls.at(-1), { method: "companion.codex.restart", params: { reason: "settings" } });
  assert.equal(byText(root, "确认重启").disabled, true);
  gate.reject(Object.assign(Error("timeout"), { code: "RPC_TIMEOUT" }));
  await turn();
  assert.equal(byLabel(root, "确认重启 Codex").hidden, true);
  byText(root, "重试").click();
  await turn();
  assert.equal(f.calls.filter(item => item.method.endsWith("restart")).length, 1);
  f.panel.destroy();
});

test("重启被拒与接受分别显示结果，不把 accepted:false 当成功", async () => {
  for (const accepted of [false, true]) {
    const f = fixture(method => {
      if (method === "companion.settings.get") return { config: initialConfig(), catalog };
      if (method === "companion.agent.status") return { available: true, version: "1.2.3", codex: { attached: true, port: 51234, proxyPort: 7890 }, nativeHelper: "ok", lastEvent: null };
      return { accepted, reason: "busy" };
    });
    await f.panel.open();
    assert.ok(f.panel.element.textContent.includes("后台服务运行中"));
    assert.ok(f.panel.element.textContent.includes("51234"));
    byText(f.panel.element, "立即重启 Codex").click();
    byText(f.panel.element, "确认重启").click();
    await turn();
    assert.ok(f.panel.element.textContent.includes(accepted ? "已请求重启 Codex" : "无法重启 Codex：后台正在处理其他操作，请稍后再试"));
    f.panel.destroy();
  }
});

test("Esc 先取消重启确认再关闭；关闭重开会重新读取，销毁后迟到响应无效", async () => {
  const f = fixture();
  await f.panel.open();
  byText(f.panel.element, "立即重启 Codex").click();
  assert.equal(escape(f.panel.element).defaultPrevented, true);
  assert.equal(f.panel.element.hidden, false);
  escape(f.panel.element);
  assert.equal(f.closed, 1);
  assert.equal(f.panel.element.hidden, true);
  await f.panel.open();
  assert.equal(f.calls.length, 4);
  f.panel.destroy();
  f.panel.destroy();
  byText(f.panel.element, "立即重启 Codex").click();
  assert.equal(f.panel.element.isConnected, false);
  const gate = deferred();
  const late = fixture(() => gate.promise);
  const reading = late.panel.open();
  late.panel.destroy();
  gate.resolve({ config: initialConfig(), catalog });
  await reading;
  assert.equal(bySetting(late.panel.element, "proxy-port").value, "");
});

test("runtime 的平台 RPC 独立于业务卡片，总开关关闭仍保留外框、齿轮和待处理设置读取", async () => {
  const document = makeDocument();
  const sent = [];
  const client = createRpcClient({ binding: () => raw => {
    const request = JSON.parse(raw); sent.push(request);
    if (request.method.endsWith("lifecycle.dispose")) return {};
  } });
  const shell = createCardShell({ document });
  const backend = { getItem: () => null, setItem() {} };
  const manifest = { ...catalog[0], layout: { minHeight: 0 }, state: { scope: "target", version: 1 }, lifecycle: { start: "immediate", hidden: "retain" }, capabilities: ["rpc"] };
  let disposed = 0, settingsAvailable;
  const runtime = createCardRuntime({
    manifests: [manifest], renderers: { alpha: { mount: () => ({ dispose() { disposed++; } }) } },
    config: initialConfig(), shellFactory: () => shell, rpcClient: client, localStorage: backend, sessionStorage: backend,
    adapterFactory: ({ host, hasSettings }) => {
      settingsAvailable = hasSettings;
      document.body.append(host);
      return { setPlacement() {}, setHasCards() {}, dispose() {}, getDiagnostics: () => ({ mode: "fixture" }) };
    }
  });
  await turn();
  const gear = byLabel(shell.root, "Companion 设置");
  gear.click();
  const platform = sent.filter(item => item.cardId === "companion");
  assert.equal(settingsAvailable, true);
  assert.deepEqual(platform.map(item => item.method), ["companion.settings.get", "companion.agent.status"]);
  assert.ok(platform.every(item => Number.isInteger(item.generation) && item.generation === platform[0].generation));
  await runtime.applyConfig({ ...initialConfig(), enabled: false, revision: 5 });
  assert.equal(disposed, 1);
  assert.equal(runtime.getDiagnostics().shell.count, 0);
  assert.equal(shell.host.isConnected, true);
  assert.equal(byLabel(shell.root, "Companion 设置"), gear);
  assert.ok(byText(shell.root, "卡片已关闭", "p"));
  assert.equal(client.diagnostics().pending, 2, "业务停用不能取消平台请求");
  for (const request of platform) client.receiveRpc({ id: request.id, result: request.method.endsWith("get") ? { config: { ...initialConfig(), enabled: false }, catalog } : { available: false } });
  await turn();
  assert.equal(bySetting(shell.root, "enabled").checked, false);
  byLabel(shell.root, "关闭 Companion 设置").click();
  assert.equal(document.activeElement, gear);
  gear.click();
  assert.equal(client.diagnostics().pending, 2);
  await runtime.dispose();
  assert.equal(client.diagnostics().pending, 0);
  assert.equal(shell.host.isConnected, false);
  assert.equal(sent.some(item => item.method === "companion.lifecycle.dispose"), false);
});
