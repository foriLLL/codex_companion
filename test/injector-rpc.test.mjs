import assert from "node:assert/strict";
import test from "node:test";
import { CodexInjector } from "../src/injector.mjs";
import { RPC_BINDING_NAME } from "../src/rpc-bridge.mjs";
import { ARTIFACT_HASH } from "../src/injection.mjs";
import { CARD_MANIFESTS } from "../src/card-registry.mjs";
import { normalizeRuntimeConfig } from "../src/platform/config/runtime-config.mjs";

const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;

class AutoReplyWebSocket {
  static OPEN = 1;
  static instances = [];
  static onSend = null;

  readyState = 0;
  calls = [];
  health = null;
  scripts = new Map();
  nextScriptId = 0;
  #listeners = new Map();

  constructor() {
    AutoReplyWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = AutoReplyWebSocket.OPEN;
      this.#emit("open", {});
    });
  }

  addEventListener(type, listener) {
    let listeners = this.#listeners.get(type);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(type, listeners);
    }
    listeners.add(listener);
  }

  send(serialized) {
    const message = JSON.parse(serialized);
    this.calls.push(message);
    AutoReplyWebSocket.onSend?.(message);
    let result = {};
    if (message.method === "Page.addScriptToEvaluateOnNewDocument") {
      const identifier = `script-${++this.nextScriptId}`;
      this.scripts.set(identifier, message.params.source);
      result = { identifier };
    } else if (message.method === "Page.removeScriptToEvaluateOnNewDocument") {
      this.scripts.delete(message.params.identifier);
    } else if (message.method === "Runtime.evaluate") {
      const source = message.params.expression;
      if (source.includes("bootstrap(")) {
        const payload = JSON.parse(source.slice(source.lastIndexOf("bootstrap(") + "bootstrap(".length, -1));
        this.health = payload.action === "unmount" ? null : {
          artifactHash: payload.artifactHash,
          mounted: true,
          config: normalizeRuntimeConfig(payload.config, CARD_MANIFESTS),
        };
        result = { result: { value: { status: payload.action === "unmount" ? "unmounted" : "mounted" } } };
      } else if (source.startsWith('globalThis["__CODEX_COMPANION__"]?.runtime?.applyConfig(')) {
        this.health.config = JSON.parse(source.slice(source.indexOf("applyConfig(") + "applyConfig(".length, -1));
        result = { result: { value: true } };
      } else {
        result = { result: { value: this.health } };
      }
    }
    queueMicrotask(() => this.#emit("message", {
      data: JSON.stringify({ id: message.id, result })
    }));
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.#emit("close", {});
  }

  #emit(type, event) {
    for (const listener of [...(this.#listeners.get(type) ?? [])]) listener(event);
  }
}

const mainTarget = {
  id: "main",
  type: "page",
  title: "Codex",
  url: "app://-/index.html",
  webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/main"
};
const auxiliaryTarget = {
  id: "pet",
  type: "page",
  title: "Pet",
  url: "app://-/avatar-overlay-composition-surface.html?surfaceId=mascot-badge",
  webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/pet"
};
let cdpTargets = [mainTarget];

test.before(() => {
  AutoReplyWebSocket.instances = [];
  globalThis.WebSocket = AutoReplyWebSocket;
  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return cdpTargets;
    }
  });
});

test.after(() => {
  globalThis.fetch = originalFetch;
  if (originalWebSocket === undefined) delete globalThis.WebSocket;
  else globalThis.WebSocket = originalWebSocket;
});

test("mount 只在主 renderer 注入 Runtime binding", async () => {
  cdpTargets = [mainTarget];
  AutoReplyWebSocket.instances = [];
  const injector = new CodexInjector(9222, {
    rpcHandler: async () => ({ ok: true })
  });

  const result = await injector.injectOnce("mount");
  assert.equal(result.length, 1);
  const calls = AutoReplyWebSocket.instances[0].calls;
  const methods = calls.map(({ method }) => method);
  assert.deepEqual(methods, [
    "Page.enable",
    "Runtime.enable",
    "Runtime.addBinding",
    "Runtime.evaluate"
  ]);
  assert.deepEqual(
    calls.filter(({ method }) => method === "Runtime.addBinding").map(({ params }) => params.name),
    [RPC_BINDING_NAME]
  );
});

test("常驻 mount 在当前文档和新文档中都先加载本地 runtime prelude", async () => {
  cdpTargets = [mainTarget];
  AutoReplyWebSocket.instances = [];
  const prelude = "globalThis.__localHlsLoaded = true;";
  const injector = new CodexInjector(9222, {
    rpcHandler: async () => ({ ok: true }),
    runtimePrelude: prelude,
    logger: { info() {}, warn() {} }
  });

  await injector.start();
  injector.stop();

  const calls = AutoReplyWebSocket.instances[0].calls;
  const newDocument = calls.find(({ method }) => method === "Page.addScriptToEvaluateOnNewDocument");
  const evaluate = calls.find(({ method }) => method === "Runtime.evaluate");
  assert.ok(newDocument.params.source.startsWith(prelude));
  assert.ok(evaluate.params.expression.startsWith(prelude));
  assert.match(newDocument.params.source, /codex-companion-root/);
  assert.match(evaluate.params.expression, /codex-companion-root/);
});

test("重叠扫描不会为同一 target 重复注入或泄漏连接", async () => {
  cdpTargets = [mainTarget];
  AutoReplyWebSocket.instances = [];
  const injector = new CodexInjector(9222, {
    rpcHandler: async () => ({ ok: true }),
    logger: { info() {}, warn() {} }
  });

  await injector.start();
  // start() 已完成首轮扫描并建立会话；再并发触发多轮扫描。
  // 串行化守卫应让并发调用复用同一进行中的扫描，对同一 target 只保留一个会话。
  await Promise.all([injector.scanNow(), injector.scanNow(), injector.scanNow()]);

  const addBindingCalls = AutoReplyWebSocket.instances
    .flatMap((socket) => socket.calls)
    .filter(({ method }) => method === "Runtime.addBinding");
  assert.equal(addBindingCalls.length, 1, "同一 target 只应注册一次 RPC binding");
  const openSockets = AutoReplyWebSocket.instances.filter((socket) => socket.readyState === AutoReplyWebSocket.OPEN);
  assert.equal(openSockets.length, 1, "重叠扫描不应泄漏额外的打开连接");
  injector.stop();
});

test("stop() 之后触发的扫描不会重新建立会话", async () => {
  cdpTargets = [mainTarget];
  AutoReplyWebSocket.instances = [];
  const injector = new CodexInjector(9222, {
    rpcHandler: async () => ({ ok: true }),
    logger: { info() {}, warn() {} }
  });

  await injector.start();
  injector.stop();
  const socketsAfterStop = AutoReplyWebSocket.instances.length;
  // stop() 后触发的扫描应因 #stopped 提前返回，不再新建连接。
  await injector.scanNow();
  assert.equal(AutoReplyWebSocket.instances.length, socketsAfterStop, "stop() 后不应再打开新连接");
});

test("辅助 renderer 只执行 unmount 清理，不注册 RPC binding", async () => {
  cdpTargets = [mainTarget, auxiliaryTarget];
  AutoReplyWebSocket.instances = [];
  const injector = new CodexInjector(9222, {
    rpcHandler: async () => ({ ok: true })
  });

  await injector.injectOnce("mount");
  assert.equal(AutoReplyWebSocket.instances.length, 2);
  const auxiliaryMethods = AutoReplyWebSocket.instances[0].calls.map(({ method }) => method);
  const mainMethods = AutoReplyWebSocket.instances[1].calls.map(({ method }) => method);
  assert.deepEqual(auxiliaryMethods, ["Runtime.evaluate"]);
  assert.equal(mainMethods.includes("Runtime.addBinding"), true);
});

test("unmount 不创建无接收方的 RPC binding", async () => {
  cdpTargets = [mainTarget];
  AutoReplyWebSocket.instances = [];
  const injector = new CodexInjector(9222);

  await injector.injectOnce("unmount");
  const methods = AutoReplyWebSocket.instances[0].calls.map(({ method }) => method);
  assert.deepEqual(methods, ["Page.enable", "Runtime.enable", "Runtime.evaluate"]);
});

test("enabled=false 时不挂载新页面，已有 runtime 通过配置停用和恢复", async (t) => {
  cdpTargets = [mainTarget];
  AutoReplyWebSocket.instances = [];

  // 总开关关闭启动：不建立任何会话/连接。
  const disabledInjector = new CodexInjector(9222, {
    rpcHandler: async () => ({ ok: true }),
    enabled: false,
    logger: { info() {}, warn() {} }
  });
  t.after(() => disabledInjector.stop());
  await disabledInjector.start();
  assert.equal(AutoReplyWebSocket.instances.length, 0, "总开关关闭不应挂载新页面");

  // 已经建立的 runtime 保留，由 applyConfig 停用卡片。
  const injector = new CodexInjector(9222, {
    rpcHandler: async () => ({ ok: true }),
    logger: { info() {}, warn() {} }
  });
  t.after(() => injector.stop());
  await injector.start();
  const socket = AutoReplyWebSocket.instances.at(-1);

  injector.setConfig({ enabled: false });
  await injector.scanNow();
  assert.equal(socket.health.config.enabled, false);
  injector.setConfig({ enabled: true });
  await injector.scanNow();
  assert.equal(socket.health.config.enabled, true);
  const mounts = socket.calls.filter(({ method, params }) => method === "Runtime.evaluate" && params.expression.includes('"action":"mount"'));
  const updates = socket.calls.filter(({ method, params }) => method === "Runtime.evaluate" && params.expression.startsWith('globalThis["__CODEX_COMPANION__"]?.runtime?.applyConfig('));
  assert.equal(mounts.length, 1, "总开关不重跑 bundle");
  assert.equal(updates.length, 2);

});

test("unmount 和辅助 renderer 清理都不执行 HLS runtime prelude", async () => {
  cdpTargets = [mainTarget, auxiliaryTarget];
  AutoReplyWebSocket.instances = [];
  const prelude = "globalThis.__mustNotRunDuringUnmount = true;";
  const injector = new CodexInjector(9222, { runtimePrelude: prelude });

  await injector.injectOnce("unmount");

  for (const socket of AutoReplyWebSocket.instances) {
    const evaluation = socket.calls.find(({ method }) => method === "Runtime.evaluate");
    assert.ok(evaluation);
    assert.doesNotMatch(evaluation.params.expression, /__mustNotRunDuringUnmount/);
  }
});

test("Injector 拒绝冲突的 service 配置", () => {
  assert.throws(() => new CodexInjector(9222, {
    rpcHandler: async () => {},
    embyService: { handleRpc() {} }
  }), /不能同时配置/);
  assert.throws(() => new CodexInjector(9222, { runtimePrelude: null }), /必须是字符串/);
});

const mountCalls = (socket) => socket.calls.filter(({ method, params }) => method === "Runtime.evaluate" && params.expression.includes('"action":"mount"'));
const configCalls = (socket) => socket.calls.filter(({ method, params }) => method === "Runtime.evaluate" && params.expression.startsWith('globalThis["__CODEX_COMPANION__"]?.runtime?.applyConfig('));
const quietLogger = { info() {}, warn() {}, debug() {} };

async function runningInjector(t, options = {}) {
  cdpTargets = [mainTarget];
  AutoReplyWebSocket.instances = [];
  const injector = new CodexInjector(9222, { logger: quietLogger, ...options });
  t.after(() => injector.stop());
  await injector.start();
  return { injector, socket: AutoReplyWebSocket.instances.at(-1) };
}

test("v2 settings、未知卡片与顺序完整透传，配置变化不重跑 bundle", async (t) => {
  const initial = {
    version: 2, enabled: true, revision: 7, placement: "standalone-button",
    order: ["future-card", "emby"],
    cards: { emby: { enabled: true, settings: { subtitles: { language: "chi" } } }, "future-card": { enabled: true, settings: { title: "未来" } } },
  };
  const { injector, socket } = await runningInjector(t, { config: initial });
  assert.deepEqual(socket.health.config, normalizeRuntimeConfig(initial, CARD_MANIFESTS));
  assert.equal(socket.health.artifactHash, ARTIFACT_HASH);
  const next = structuredClone(initial);
  next.revision = 8;
  next.order = ["emby", "future-card", "games"];
  next.placement = "inline-in-summary";
  next.cards.emby.settings.subtitles.language = "eng";
  next.cards["future-card"].settings.title = "更新";
  injector.setConfig({ config: next });
  await injector.scanNow();
  assert.deepEqual(socket.health.config, normalizeRuntimeConfig(next, CARD_MANIFESTS));
  assert.equal(mountCalls(socket).length, 1);
  assert.equal(configCalls(socket).length, 1);
  assert.equal(socket.scripts.size, 1, "旧导航脚本已移除");
  const registered = [...socket.scripts.values()][0];
  const payload = JSON.parse(registered.slice(registered.lastIndexOf("bootstrap(") + "bootstrap(".length, -1));
  assert.deepEqual(payload.config, socket.health.config);
  assert.equal(socket.calls.filter(({ method }) => method === "Runtime.addBinding").length, 1);
});

test("健康配置一致时不重复更新、注入或注册导航脚本", async (t) => {
  const { injector, socket } = await runningInjector(t);
  await injector.scanNow();
  await injector.scanNow();
  assert.equal(mountCalls(socket).length, 1);
  assert.equal(configCalls(socket).length, 0);
  assert.equal(socket.calls.filter(({ method }) => method === "Page.addScriptToEvaluateOnNewDocument").length, 1);
});

test("页面重载执行旧配置时，即使 Node 已推送也重新 applyConfig", async (t) => {
  const { injector, socket } = await runningInjector(t);
  const oldConfig = structuredClone(socket.health.config);
  injector.setConfig({ cards: { emby: { settings: { audio: "eng" } } }, revision: 3 });
  await injector.scanNow();
  const desired = structuredClone(socket.health.config);
  socket.health = { artifactHash: ARTIFACT_HASH, mounted: true, config: oldConfig };
  await injector.scanNow();
  assert.deepEqual(socket.health.config, desired);
  assert.equal(configCalls(socket).length, 2, "当前页面真实配置是最终依据");
  assert.equal(mountCalls(socket).length, 1);
  assert.equal(socket.calls.filter(({ method }) => method === "Page.addScriptToEvaluateOnNewDocument").length, 2, "重载修正不再次注册相同配置");
});

test("artifact 不匹配或 runtime 丢失才重新运行 bundle", async (t) => {
  const { injector, socket } = await runningInjector(t, { runtimePrelude: "/* fixture prelude */" });
  socket.health.artifactHash = "previous-artifact";
  await injector.scanNow();
  assert.equal(mountCalls(socket).length, 2);
  assert.equal(socket.health.artifactHash, ARTIFACT_HASH);
  socket.health = null;
  await injector.scanNow();
  assert.equal(mountCalls(socket).length, 3);
  assert.equal(configCalls(socket).length, 0);
  assert.ok(mountCalls(socket).every(({ params }) => params.expression.startsWith("/* fixture prelude */")));
});

test("停用后导航脚本也携带 enabled=false，重载不会重新启用卡片", async (t) => {
  const { injector, socket } = await runningInjector(t);
  injector.setConfig({ enabled: false });
  await injector.scanNow();
  const script = [...socket.scripts.values()][0];
  const payload = JSON.parse(script.slice(script.lastIndexOf("bootstrap(") + "bootstrap(".length, -1));
  assert.equal(payload.config.enabled, false);
  socket.health = { artifactHash: ARTIFACT_HASH, mounted: true, config: payload.config };
  await injector.scanNow();
  assert.equal(configCalls(socket).length, 1);
  assert.equal(mountCalls(socket).length, 1);
});

test("legacy getter/setter 兼容，配置与 getter 不共享可变 settings", () => {
  const settings = { nested: { value: 1 } };
  const injector = new CodexInjector(9222, { cards: { emby: false }, cardOrder: ["emby"] });
  assert.equal(injector.cards.emby, false);
  assert.equal(injector.cardOrder[0], "emby");
  injector.setConfig({ cards: { emby: { settings } } });
  settings.nested.value = 99;
  assert.equal(injector.cards.emby, false);
  assert.equal(injector.config.cards.emby.settings.nested.value, 1);
  const snapshot = injector.config;
  snapshot.cards.emby.settings.nested.value = 77;
  assert.equal(injector.config.cards.emby.settings.nested.value, 1);
  injector.setConfig({ cards: { emby: true }, placement: "inline-in-summary" });
  assert.equal(injector.cards.emby, true);
  assert.equal(injector.placement, "inline-in-summary");
  assert.equal(injector.config.cards.emby.settings.nested.value, 1);
});

test("共享配置归一化支持新 registry 默认值，并过滤损坏输入", () => {
  const manifests = [{ id: "brand-new", defaultEnabled: false }, { id: "other", defaultEnabled: true }];
  const value = normalizeRuntimeConfig({ cards: { "future-card": { enabled: true, settings: { x: [1, 2] } } }, order: ["future-card", "future-card", "constructor", 7, "other"] }, manifests);
  assert.deepEqual(value.order, ["future-card", "other", "brand-new"]);
  assert.deepEqual(value.cards, { "brand-new": { enabled: false, settings: {} }, other: { enabled: true, settings: {} }, "future-card": { enabled: true, settings: { x: [1, 2] } } });
  assert.doesNotThrow(() => normalizeRuntimeConfig(null, manifests));
  assert.doesNotThrow(() => normalizeRuntimeConfig({ order: {} }, manifests));
  assert.deepEqual(normalizeRuntimeConfig({ cards: [] }, manifests).cards.other, { enabled: true, settings: {} });
});

test("拒绝旧 revision，避免运行时无法接受的陈旧配置反复推送", () => {
  const injector = new CodexInjector(9222, { config: { revision: 4, cards: { emby: { enabled: false, settings: {} } } } });
  assert.equal(injector.setConfig({ config: { revision: 3, cards: { emby: true } } }), false);
  assert.equal(injector.config.revision, 4);
  assert.equal(injector.cards.emby, false);
});

test("CDP 重连重新登记导航脚本并撤销已知旧注册", async (t) => {
  const { injector, socket } = await runningInjector(t);
  const oldIdentifier = [...socket.scripts.keys()][0];
  socket.close();
  await injector.scanNow();
  const reconnected = AutoReplyWebSocket.instances.at(-1);
  assert.notEqual(reconnected, socket);
  assert.equal(reconnected.calls.find(({ method }) => method === "Page.removeScriptToEvaluateOnNewDocument")?.params.identifier, oldIdentifier);
  assert.equal(reconnected.scripts.size, 1);
  assert.equal(mountCalls(reconnected).length, 1);
});

test("stop 在首次异步注入期间发生时不会登记泄漏会话", async (t) => {
  cdpTargets = [mainTarget];
  AutoReplyWebSocket.instances = [];
  const injector = new CodexInjector(9222, { logger: quietLogger });
  t.after(() => { AutoReplyWebSocket.onSend = null; injector.stop(); });
  AutoReplyWebSocket.onSend = ({ method, params }) => {
    if (method === "Runtime.evaluate" && params.expression.includes('"action":"mount"')) injector.stop();
  };
  await injector.scanNow();
  assert.ok(AutoReplyWebSocket.instances.every((socket) => socket.readyState === 3));
});
