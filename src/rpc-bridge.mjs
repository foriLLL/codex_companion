export const RPC_BINDING_NAME = "__CODEX_COMPANION_RPC__";
export const RPC_CANCEL_METHOD = "rpc.cancel";
// Subtitle burn-in may need to download a track and wait up to 40 seconds for
// FFmpeg's first fragmented-MP4 initialization box. Keep the bridge deadline
// above that end-to-end path; renderer requests still cancel shorter methods.
export const DEFAULT_RPC_TIMEOUT_MS = 70_000;

const DEFAULT_BRIDGE_KEY = "__CODEX_COMPANION__";
const MAX_REQUEST_LENGTH = 1024 * 1024;
const MAX_RESPONSE_LENGTH = 16 * 1024 * 1024;

class RpcBridgeError extends Error {
  constructor(code, message, { retryable = false } = {}) {
    super(message);
    this.name = "RpcBridgeError";
    this.code = code;
    this.retryable = retryable;
  }
}

function isRequestId(value) {
  return (typeof value === "string" && value.length > 0 && value.length <= 128)
    || (typeof value === "number" && Number.isSafeInteger(value));
}

function requestKey(executionContextId, requestId) {
  return `${executionContextId}:${typeof requestId}:${String(requestId)}`;
}

function redactSensitiveText(value) {
  return String(value)
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/((?:x-emby-token|access[_-]?token|api[_-]?key)\s*[=:]\s*["']?)[^\s,"'&;]+/gi, "$1[REDACTED]")
    .replace(/(token\s*=\s*["']?)[^\s,"'&;]+/gi, "$1[REDACTED]")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .slice(0, 500);
}

export function sanitizeRpcError(error) {
  const rawCode = typeof error?.code === "string" ? error.code : "RPC_ERROR";
  const code = /^[A-Z][A-Z0-9_.-]{0,63}$/.test(rawCode) ? rawCode : "RPC_ERROR";
  const rawMessage = typeof error?.message === "string" && error.message.length > 0
    ? error.message
    : "RPC 请求失败";

  return {
    code,
    message: redactSensitiveText(rawMessage),
    retryable: error?.retryable === true
  };
}

function serializeResult(value) {
  let serialized;
  try {
    serialized = JSON.stringify(value === undefined ? null : value);
  } catch {
    throw new RpcBridgeError("RPC_SERIALIZATION_ERROR", "RPC 返回值无法序列化");
  }

  if (serialized === undefined) {
    throw new RpcBridgeError("RPC_SERIALIZATION_ERROR", "RPC 返回值无法序列化");
  }
  if (serialized.length > MAX_RESPONSE_LENGTH) {
    const error = new RpcBridgeError("RPC_RESPONSE_TOO_LARGE", "RPC 返回值超过大小限制");
    error.responseLength = serialized.length;
    throw error;
  }

  return JSON.parse(serialized);
}

function normalizeHandler(handler) {
  if (handler === undefined || handler === null) {
    return {
      dispatch: async () => {
        throw new RpcBridgeError("RPC_UNAVAILABLE", "Emby 服务尚未初始化", { retryable: true });
      },
      disposeTarget: null
    };
  }
  if (typeof handler === "function") {
    return { dispatch: handler, disposeTarget: null };
  }
  if (typeof handler?.handleRpc === "function") {
    return {
      dispatch: handler.handleRpc.bind(handler),
      disposeTarget: typeof handler.disposeTarget === "function"
        ? handler.disposeTarget.bind(handler)
        : null
    };
  }
  throw new TypeError("rpcHandler 必须是函数或实现 handleRpc(method, params, context) 的对象");
}

function parseRequest(payload) {
  if (typeof payload !== "string" || payload.length === 0 || payload.length > MAX_REQUEST_LENGTH) {
    throw new RpcBridgeError("RPC_INVALID_REQUEST", "RPC 请求载荷无效");
  }

  let request;
  try {
    request = JSON.parse(payload);
  } catch {
    throw new RpcBridgeError("RPC_INVALID_REQUEST", "RPC 请求不是合法 JSON");
  }

  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new RpcBridgeError("RPC_INVALID_REQUEST", "RPC 请求必须是对象");
  }
  if (!isRequestId(request.id)) {
    throw new RpcBridgeError("RPC_INVALID_REQUEST", "RPC 请求 id 无效");
  }
  if (typeof request.method !== "string" || request.method.length === 0 || request.method.length > 128) {
    const error = new RpcBridgeError("RPC_INVALID_REQUEST", "RPC method 无效");
    error.requestId = request.id;
    throw error;
  }
  if (
    request.params !== undefined
    && (request.params === null || typeof request.params !== "object" || Array.isArray(request.params))
  ) {
    const error = new RpcBridgeError("RPC_INVALID_REQUEST", "RPC params 必须是对象");
    error.requestId = request.id;
    throw error;
  }

  return {
    id: request.id,
    method: request.method,
    params: request.params ?? {}
  };
}

export class CdpRpcBridge {
  #connection;
  #handler;
  #disposeTarget;
  #targetId;
  #logger;
  #timeoutMs;
  #bindingName;
  #bridgeKey;
  #pending = new Map();
  #attached = false;
  #targetDisposed = false;
  #removeListeners = [];

  constructor(connection, {
    handler,
    targetId = null,
    logger = console,
    timeoutMs = DEFAULT_RPC_TIMEOUT_MS,
    bindingName = RPC_BINDING_NAME,
    bridgeKey = DEFAULT_BRIDGE_KEY
  } = {}) {
    if (!connection || typeof connection.send !== "function" || typeof connection.on !== "function") {
      throw new TypeError("connection 必须支持 send() 和 on()");
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError("RPC timeoutMs 必须是正数");
    }

    this.#connection = connection;
    const normalizedHandler = normalizeHandler(handler);
    this.#handler = normalizedHandler.dispatch;
    this.#disposeTarget = normalizedHandler.disposeTarget;
    this.#targetId = targetId;
    this.#logger = logger;
    this.#timeoutMs = timeoutMs;
    this.#bindingName = bindingName;
    this.#bridgeKey = bridgeKey;
  }

  get isAttached() {
    return this.#attached;
  }

  async attach() {
    if (this.#attached) return;
    this.#attached = true;

    const subscribe = (method, listener) => {
      const remove = this.#connection.on(method, listener);
      this.#removeListeners.push(typeof remove === "function"
        ? remove
        : () => this.#connection.off?.(method, listener));
    };

    subscribe("Runtime.bindingCalled", (params) => {
      void this.#handleBindingCalled(params).catch((error) => {
        this.#logger.warn?.(`[codex-companion] RPC binding 处理失败：${sanitizeRpcError(error).message}`);
      });
    });
    subscribe("Runtime.executionContextDestroyed", (params) => {
      this.#abortContext(params?.executionContextId, new RpcBridgeError(
        "RPC_CONTEXT_DESTROYED",
        "Renderer 执行上下文已销毁"
      ));
    });
    subscribe("Runtime.executionContextsCleared", () => {
      this.#abortAll(new RpcBridgeError("RPC_CONTEXT_DESTROYED", "Renderer 执行上下文已清空"));
    });
    subscribe("close", () => {
      this.detach(new RpcBridgeError("RPC_DISCONNECTED", "Renderer 已断开", { retryable: true }));
    });

    try {
      await this.#connection.send("Runtime.addBinding", { name: this.#bindingName });
    } catch (error) {
      this.detach(new RpcBridgeError("RPC_DISCONNECTED", "RPC binding 注册失败", { retryable: true }));
      throw error;
    }
  }

  detach(reason = new RpcBridgeError("RPC_DISCONNECTED", "RPC bridge 已关闭", { retryable: true })) {
    if (!this.#attached && this.#pending.size === 0) return;
    this.#attached = false;
    for (const remove of this.#removeListeners.splice(0)) remove();
    this.#abortAll(reason);
    this.#disposeTargetOnce();
  }

  async #handleBindingCalled(params) {
    if (!this.#attached || params?.name !== this.#bindingName) return;
    const executionContextId = params.executionContextId;
    if (!Number.isInteger(executionContextId)) return;

    let request;
    try {
      request = parseRequest(params.payload);
    } catch (error) {
      if (isRequestId(error?.requestId)) {
        await this.#sendResponse(executionContextId, {
          id: error.requestId,
          ok: false,
          error: sanitizeRpcError(error)
        });
      }
      return;
    }

    if (request.method === RPC_CANCEL_METHOD) {
      await this.#handleCancellation(executionContextId, request);
      return;
    }

    const key = requestKey(executionContextId, request.id);
    if (this.#pending.has(key)) {
      await this.#sendResponse(executionContextId, {
        id: request.id,
        ok: false,
        error: sanitizeRpcError(new RpcBridgeError("RPC_DUPLICATE_REQUEST", "RPC 请求 id 重复"))
      });
      return;
    }

    const controller = new AbortController();
    const entry = { controller, executionContextId, requestId: request.id, canReply: true };
    this.#pending.set(key, entry);

    let rejectOnAbort;
    const aborted = new Promise((resolve, reject) => {
      rejectOnAbort = () => reject(controller.signal.reason ?? new RpcBridgeError("RPC_CANCELLED", "RPC 请求已取消"));
      controller.signal.addEventListener("abort", rejectOnAbort, { once: true });
    });
    const timeout = setTimeout(() => {
      controller.abort(new RpcBridgeError("RPC_TIMEOUT", `${request.method} 请求超时`, { retryable: true }));
    }, this.#timeoutMs);
    timeout.unref?.();

    try {
      const result = await Promise.race([
        Promise.resolve().then(() => this.#handler(request.method, request.params, {
          signal: controller.signal,
          requestId: request.id,
          targetId: this.#targetId,
          executionContextId
        })),
        aborted
      ]);
      if (entry.canReply && this.#attached) {
        await this.#sendResponse(executionContextId, {
          id: request.id,
          ok: true,
          result: serializeResult(result)
        });
      }
    } catch (error) {
      if (error?.code === "RPC_RESPONSE_TOO_LARGE") {
        this.#logger.warn?.(
          `[codex-companion] ${request.method} RPC 返回值超过大小限制：${error.responseLength} 字符`
        );
      }
      if (entry.canReply && this.#attached) {
        await this.#sendResponse(executionContextId, {
          id: request.id,
          ok: false,
          error: sanitizeRpcError(error)
        });
      }
    } finally {
      clearTimeout(timeout);
      controller.signal.removeEventListener("abort", rejectOnAbort);
      this.#pending.delete(key);
    }
  }

  async #handleCancellation(executionContextId, request) {
    const targetRequestId = request.params.requestId;
    let cancelled = false;

    if (isRequestId(targetRequestId)) {
      const entry = this.#pending.get(requestKey(executionContextId, targetRequestId));
      if (entry && !entry.controller.signal.aborted) {
        cancelled = true;
        entry.controller.abort(new RpcBridgeError("RPC_CANCELLED", "RPC 请求已取消"));
      }
    }

    await this.#sendResponse(executionContextId, {
      id: request.id,
      ok: true,
      result: { cancelled }
    });
  }

  #abortContext(executionContextId, reason) {
    if (!Number.isInteger(executionContextId)) return;
    for (const entry of this.#pending.values()) {
      if (entry.executionContextId !== executionContextId) continue;
      entry.canReply = false;
      entry.controller.abort(reason);
    }
  }

  #abortAll(reason) {
    for (const entry of this.#pending.values()) {
      entry.canReply = false;
      entry.controller.abort(reason);
    }
  }

  #disposeTargetOnce() {
    if (this.#targetDisposed || !this.#disposeTarget || this.#targetId === null) return;
    this.#targetDisposed = true;
    Promise.resolve()
      .then(() => this.#disposeTarget(this.#targetId))
      .catch((error) => {
        this.#logger.warn?.(`[codex-companion] 清理 renderer ${this.#targetId} 失败：${sanitizeRpcError(error).message}`);
      });
  }

  async #sendResponse(executionContextId, response) {
    // 响应作为 CDP 调用参数传入，绝不拼进 JavaScript 源码。Runtime.evaluate 会让 V8
    // 为每个不同的大响应创建匿名脚本，视频 Base64 因此在 ScriptStore 中长期滞留。
    const evaluation = await this.#connection.send("Runtime.callFunctionOn", {
      functionDeclaration: `function(response) { const emby = globalThis[${JSON.stringify(this.#bridgeKey)}]?.emby; if (typeof emby?.receiveRpc !== "function") return false; emby.receiveRpc(response); return true; }`,
      executionContextId,
      arguments: [{ value: response }],
      awaitPromise: false,
      returnByValue: true,
      userGesture: false
    });

    if (evaluation?.exceptionDetails || evaluation?.result?.value !== true) {
      throw new RpcBridgeError("RPC_DELIVERY_FAILED", "RPC 响应无法投递到 Renderer", { retryable: true });
    }
  }
}
