import assert from "node:assert/strict";
import vm from "node:vm";
import test from "node:test";
import {
  CdpRpcBridge,
  DEFAULT_RPC_TIMEOUT_MS,
  RPC_BINDING_NAME,
  RPC_CANCEL_METHOD,
  sanitizeRpcError
} from "../src/rpc-bridge.mjs";

class FakeConnection {
  calls = [];
  responses = [];
  #listeners = new Map();

  on(method, listener) {
    let listeners = this.#listeners.get(method);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(method, listeners);
    }
    listeners.add(listener);
    return () => this.off(method, listener);
  }

  off(method, listener) {
    const listeners = this.#listeners.get(method);
    const removed = listeners?.delete(listener) ?? false;
    if (listeners?.size === 0) this.#listeners.delete(method);
    return removed;
  }

  async send(method, params = {}) {
    this.calls.push({ method, params });
    if (method !== "Runtime.callFunctionOn") return {};

    const context = {
      __CODEX_COMPANION__: {
        emby: {
          receiveRpc: (response) => this.responses.push({
            contextId: params.executionContextId,
            response: JSON.parse(JSON.stringify(response))
          })
        }
      }
    };
    const delivery = vm.runInNewContext(`(${params.functionDeclaration})`, context);
    const value = delivery(params.arguments[0].value);
    return { result: { value } };
  }

  emit(method, params = {}) {
    for (const listener of [...(this.#listeners.get(method) ?? [])]) listener(params, { method, params });
  }
}

function emitRequest(connection, request, executionContextId = 7) {
  connection.emit("Runtime.bindingCalled", {
    name: RPC_BINDING_NAME,
    payload: JSON.stringify(request),
    executionContextId
  });
}

async function waitFor(predicate, message = "等待条件超时") {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

test("默认 RPC 超时覆盖字幕烧录的首次 FFmpeg 初始化窗口", () => {
  assert.equal(DEFAULT_RPC_TIMEOUT_MS, 70_000);
});

test("注册 binding，并把 RPC 结果定向送回来源 execution context", async () => {
  const connection = new FakeConnection();
  const calls = [];
  const disposedTargets = [];
  const service = {
    prefix: "emby",
    async handleRpc(method, params, context) {
      calls.push({ receiver: this.prefix, method, params, context });
      return { connected: true };
    },
    async disposeTarget(targetId) {
      disposedTargets.push(targetId);
    }
  };
  const bridge = new CdpRpcBridge(connection, { handler: service, targetId: "main" });

  await bridge.attach();
  assert.deepEqual(connection.calls[0], {
    method: "Runtime.addBinding",
    params: { name: RPC_BINDING_NAME }
  });

  emitRequest(connection, { id: "status-1", method: "connection.status", params: {} }, 42);
  await waitFor(() => connection.responses.length === 1);

  assert.equal(calls[0].receiver, "emby");
  assert.equal(calls[0].method, "connection.status");
  assert.equal(calls[0].context.targetId, "main");
  assert.equal(calls[0].context.executionContextId, 42);
  assert.equal(calls[0].context.requestId, "status-1");
  assert.equal(calls[0].context.signal instanceof AbortSignal, true);
  assert.deepEqual(connection.responses[0], {
    contextId: 42,
    response: { id: "status-1", ok: true, result: { connected: true } }
  });
  bridge.detach();
  bridge.detach();
  await waitFor(() => disposedTargets.length === 1);
  assert.deepEqual(disposedTargets, ["main"]);
});

test("错误响应只暴露白名单字段并脱敏", async () => {
  const connection = new FakeConnection();
  const bridge = new CdpRpcBridge(connection, {
    handler: async () => {
      const error = new Error("Authorization: Bearer secret-token");
      error.code = "EMBY_AUTH_FAILED";
      error.retryable = false;
      error.internalState = { token: "secret-token" };
      throw error;
    }
  });
  await bridge.attach();

  emitRequest(connection, { id: 1, method: "auth.login", params: {} });
  await waitFor(() => connection.responses.length === 1);

  const response = connection.responses[0].response;
  assert.deepEqual(Object.keys(response.error).sort(), ["code", "message", "retryable"]);
  assert.equal(response.error.code, "EMBY_AUTH_FAILED");
  assert.doesNotMatch(JSON.stringify(response), /secret-token|internalState|stack/);
  assert.match(response.error.message, /\[REDACTED\]/);
  bridge.detach();
});

test("RPC 响应作为 callFunctionOn 参数投递，不生成携带响应数据的匿名脚本", async () => {
  const connection = new FakeConnection();
  const canary = "media-payload-must-not-enter-script-source";
  const bridge = new CdpRpcBridge(connection, {
    handler: async () => ({ canary, data: "A".repeat(1024 * 1024) })
  });
  await bridge.attach();

  emitRequest(connection, { id: "large", method: "resource.load", params: {} }, 99);
  await waitFor(() => connection.responses.length === 1);

  const delivery = connection.calls.find(({ method }) => method === "Runtime.callFunctionOn");
  assert.ok(delivery);
  assert.equal(delivery.params.executionContextId, 99);
  assert.doesNotMatch(delivery.params.functionDeclaration, new RegExp(canary));
  assert.equal(delivery.params.arguments[0].value.result.canary, canary);
  assert.equal(connection.calls.some(({ method }) => method === "Runtime.evaluate"), false);
  bridge.detach();
});

test("大体积 RPC 响应累计到阈值后主动回收 Renderer 媒体垃圾", async () => {
  const connection = new FakeConnection();
  const bridge = new CdpRpcBridge(connection, {
    rendererGcThresholdBytes: 128,
    handler: async () => ({ data: "A".repeat(256) })
  });
  await bridge.attach();

  emitRequest(connection, { id: "media", method: "playback.direct.next", params: {} });
  await waitFor(() => connection.calls.some(({ method }) => method === "HeapProfiler.collectGarbage"));

  const deliveryIndex = connection.calls.findIndex(({ method }) => method === "Runtime.callFunctionOn");
  const garbageIndex = connection.calls.findIndex(({ method }) => method === "HeapProfiler.collectGarbage");
  assert.ok(deliveryIndex >= 0 && garbageIndex > deliveryIndex);
  bridge.detach();
});

test("rpc.cancel 仅取消同 execution context 的目标请求", async () => {
  const connection = new FakeConnection();
  const signals = new Map();
  const handler = async (_method, _params, context) => {
    signals.set(`${context.executionContextId}:${context.requestId}`, context.signal);
    return new Promise((resolve, reject) => {
      context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true });
    });
  };
  const bridge = new CdpRpcBridge(connection, { handler });
  await bridge.attach();

  emitRequest(connection, { id: "same-id", method: "resource.load", params: {} }, 7);
  emitRequest(connection, { id: "same-id", method: "resource.load", params: {} }, 8);
  await waitFor(() => signals.size === 2);
  emitRequest(connection, {
    id: "cancel-1",
    method: RPC_CANCEL_METHOD,
    params: { requestId: "same-id" }
  }, 7);

  await waitFor(() => connection.responses.length === 2);
  assert.equal(signals.get("7:same-id").aborted, true);
  assert.equal(signals.get("8:same-id").aborted, false);
  const byId = new Map(connection.responses.map(({ response }) => [response.id, response]));
  assert.deepEqual(byId.get("cancel-1"), { id: "cancel-1", ok: true, result: { cancelled: true } });
  assert.equal(byId.get("same-id").error.code, "RPC_CANCELLED");
  bridge.detach();
});

test("超时会 abort handler 并返回可重试错误", async () => {
  const connection = new FakeConnection();
  let signal;
  const bridge = new CdpRpcBridge(connection, {
    timeoutMs: 10,
    handler: async (_method, _params, context) => {
      signal = context.signal;
      return new Promise(() => {});
    }
  });
  await bridge.attach();

  emitRequest(connection, { id: 9, method: "home.get", params: {} });
  await waitFor(() => connection.responses.length === 1);

  assert.equal(signal.aborted, true);
  assert.deepEqual(connection.responses[0].response, {
    id: 9,
    ok: false,
    error: { code: "RPC_TIMEOUT", message: "home.get 请求超时", retryable: true }
  });
  bridge.detach();
});

test("execution context 销毁和 renderer 断开都会 abort，且不向失效 context 回包", async () => {
  const connection = new FakeConnection();
  const signals = [];
  const bridge = new CdpRpcBridge(connection, {
    handler: async (_method, _params, context) => {
      signals.push(context.signal);
      return new Promise(() => {});
    }
  });
  await bridge.attach();

  emitRequest(connection, { id: "destroyed", method: "search", params: {} }, 11);
  await waitFor(() => signals.length === 1);
  connection.emit("Runtime.executionContextDestroyed", { executionContextId: 11 });
  await waitFor(() => signals[0].aborted);
  assert.equal(connection.responses.length, 0);

  emitRequest(connection, { id: "closed", method: "search", params: {} }, 12);
  await waitFor(() => signals.length === 2);
  connection.emit("close");
  await waitFor(() => signals[1].aborted);
  assert.equal(connection.responses.length, 0);
  assert.equal(bridge.isAttached, false);
});

test("sanitizeRpcError 丢弃未知 code 与内部字段", () => {
  assert.deepEqual(sanitizeRpcError({
    code: "not safe",
    message: "failed",
    retryable: true,
    stack: "private"
  }), {
    code: "RPC_ERROR",
    message: "failed",
    retryable: true
  });
});
