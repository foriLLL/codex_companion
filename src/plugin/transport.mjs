import { createRpcClient } from "../renderer/platform/rpc-client.mjs";

const failure = (error, fallback = "暂时无法完成，请稍后重试") => Object.assign(
  new Error(error?.message || fallback), { code: error?.code || "PLUGIN_REQUEST_FAILED", retryable: error?.retryable === true }
);

export function readToolResult(response) {
  let payload = response?.structuredContent;
  if (!payload && response?.content) {
    for (const item of response.content) {
      if (item.type !== "text") continue;
      try { payload = JSON.parse(item.text); break; } catch {}
    }
  }
  if (response?.isError || payload?.ok === false || payload?.error) throw failure(payload?.error || payload);
  if (!payload || typeof payload !== "object") throw failure(null, "连接返回了不完整的数据，请重试");
  return payload;
}

export function createPluginTransport(app, { viewId = crypto.randomUUID() } = {}) {
  const transfers = new Map();
  let sequence = 0;
  let disposed = false;
  const callTool = async (name, args, options) => readToolResult(await app.callServerTool({ name, arguments: args }, options));

  async function wire(request, signal) {
    const payload = await callTool("companion.rpc", { ...request, viewId }, signal ? { signal } : undefined);
    return Object.hasOwn(payload, "result") ? payload.result : payload;
  }

  function send(raw) {
    const request = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (request.method === "rpc.cancel") {
      transfers.get(request.params?.requestId)?.abort();
      void wire(request).catch(() => {});
      return undefined;
    }
    return sendRequest(request);
  }
  async function sendRequest(request) {
    if (disposed && !request.method.endsWith("lifecycle.dispose")) throw failure({ code: "ABORTED", message: "页面已关闭" });
    const controller = new AbortController();
    transfers.set(request.id, controller);
    let descriptor;
    try {
      const value = await wire(request, controller.signal);
      descriptor = value?.__companionTransfer;
      if (!descriptor || Object.keys(value).length !== 1) return value;
      if (descriptor.version !== 1 || descriptor.encoding !== "base64-json" || typeof descriptor.id !== "string"
        || !Number.isSafeInteger(descriptor.totalBytes) || descriptor.totalBytes < 1 || descriptor.totalBytes > 16 * 1024 * 1024) {
        throw failure(null, "内容过大或传输格式无效");
      }
      const bytes = new Uint8Array(descriptor.totalBytes);
      let offset = 0;
      while (offset < bytes.length) {
        if (controller.signal.aborted) throw failure({ code: "ABORTED", message: "请求已取消" });
        const part = await wire({ ...request, id: `${request.id}-part-${++sequence}`, method: "transfer.read",
          params: { transferId: descriptor.id, offset } }, controller.signal);
        if (part.encoding !== "base64" || part.offset !== offset || part.totalBytes !== bytes.length
          || !Number.isSafeInteger(part.nextOffset) || part.nextOffset <= offset || part.nextOffset > bytes.length) {
          throw failure(null, "内容传输中断，请重试");
        }
        const decoded = Uint8Array.from(atob(part.data), (char) => char.charCodeAt(0));
        if (decoded.length !== part.nextOffset - offset) throw failure(null, "内容校验失败，请重试");
        bytes.set(decoded, offset);
        offset = part.nextOffset;
      }
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } finally {
      transfers.delete(request.id);
      if (descriptor?.id) {
        void wire({ ...request, id: `${request.id}-close-${++sequence}`, method: "transfer.close",
          params: { transferId: descriptor.id } }).catch(() => {});
      }
    }
  }

  const rpcClient = createRpcClient({ binding: () => send });
  return {
    viewId, rpcClient,
    config: (args) => callTool("companion.config", args),
    launcher: (args) => callTool("companion.launcher", args),
    state: (args) => callTool("companion.state", args),
    heartbeat: () => callTool("companion.view", { viewId, operation: "heartbeat" }),
    async dispose() {
      if (disposed) return;
      disposed = true;
      rpcClient.dispose();
      for (const controller of transfers.values()) controller.abort();
      transfers.clear();
      await callTool("companion.view", { viewId, operation: "dispose" });
    }
  };
}

// 卡片使用同步存档接口；持久化在短暂合并后通过插件服务完成。
// 不接触宿主 localStorage，也不依赖 sandbox 是否提供浏览器存储。
export async function createPluginStorage(transport, { onError = () => {}, debounceMs = 250 } = {}) {
  const snapshot = await transport.state({ operation: "get" });
  const values = new Map(Object.entries(snapshot.entries ?? {}));
  const revisions = new Map(Object.entries(snapshot.revisions ?? {}));
  const dirty = new Map();
  let timer;
  let flushing;
  let closed = false;
  let version = 0;
  function report(error) { try { onError(error); } catch {} }
  function schedule(delay) {
    clearTimeout(timer);
    timer = setTimeout(() => { void flush().catch(report); }, delay);
  }
  function flush() {
    clearTimeout(timer);
    timer = undefined;
    if (flushing) return flushing;
    flushing = (async () => {
      // 合并所有等待者；保存期间的新进度也必须写完，才能允许退出或重启。
      while (dirty.size) for (const [key, change] of [...dirty]) {
        try {
          const next = await transport.state({ operation: "set", key, value: change.value, expectedRevision: revisions.get(key) ?? null });
          if (next.revision === null) revisions.delete(key); else revisions.set(key, next.revision);
          if (dirty.get(key)?.version === change.version) dirty.delete(key);
        } catch (error) {
          if (/CONFLICT/.test(error.code ?? "")) {
            try {
              const latest = await transport.state({ operation: "get", key });
              if (latest.value === null) values.delete(key); else values.set(key, latest.value);
              if (latest.revision === null) revisions.delete(key); else revisions.set(key, latest.revision);
              dirty.delete(key);
            } catch {}
          }
          throw error;
        }
      }
    })().finally(() => {
      flushing = undefined;
      if (dirty.size && !closed) schedule(2000);
    });
    return flushing;
  }
  const local = {
    getItem: (key) => values.get(key) ?? null,
    setItem(key, value) {
      if (closed) throw failure({ code: "STATE_DISPOSED", message: "存档已关闭" });
      if (values.get(key) === String(value)) return;
      values.set(key, String(value));
      dirty.set(key, { value: String(value), version: ++version });
      schedule(debounceMs);
    },
    removeItem(key) {
      if (closed) return;
      values.delete(key);
      dirty.set(key, { value: null, version: ++version });
      schedule(debounceMs);
    }
  };
  const sessionValues = new Map([["companion.platform.scopeId", "plugin-profile"]]);
  return {
    local,
    session: { getItem: (key) => sessionValues.get(key) ?? null, setItem: (key, value) => sessionValues.set(key, String(value)) },
    flush,
    async dispose() {
      closed = true;
      clearTimeout(timer);
      try { await flush(); } finally { clearTimeout(timer); }
    }
  };
}
