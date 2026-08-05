import assert from "node:assert/strict";
import test from "node:test";
import { CodexInjector } from "../src/injector.mjs";
import { RPC_BINDING_NAME } from "../src/rpc-bridge.mjs";

const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;

class AutoReplyWebSocket {
  static OPEN = 1;
  static instances = [];

  readyState = 0;
  calls = [];
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
    const result = message.method === "Runtime.evaluate"
      ? { result: { value: { status: "mounted" } } }
      : {};
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

test("enabled=false 时不挂载新页面，对已挂载页面执行 unmount，恢复后自动重挂载", async (t) => {
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

  // 先正常挂载，再关闭总开关：对已有页面执行 unmount（会话保留）。
  const injector = new CodexInjector(9222, {
    rpcHandler: async () => ({ ok: true }),
    logger: { info() {}, warn() {} }
  });
  t.after(() => injector.stop());
  await injector.start();
  const socket = AutoReplyWebSocket.instances.at(-1);

  injector.setConfig({ enabled: false });
  await injector.scanNow();
  const unmountEval = socket.calls.find(({ method, params }) =>
    method === "Runtime.evaluate" && String(params?.expression ?? "").includes('"action":"unmount"'));
  assert.ok(unmountEval, "总开关关闭应对已挂载页面执行 unmount");

  // 恢复总开关：cardsKey 健康检查发现页面没有 bridge，自动重挂载。
  injector.setConfig({ enabled: true });
  await injector.scanNow();
  const mountEvals = socket.calls.filter(({ method, params }) =>
    method === "Runtime.evaluate" && String(params?.expression ?? "").includes('"action":"mount"'));
  assert.ok(mountEvals.length >= 2, "恢复总开关后应自动重挂载（首次挂载 + 恢复后重挂载）");
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
