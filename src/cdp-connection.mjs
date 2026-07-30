const DEFAULT_TIMEOUT_MS = 10_000;

export function assertLoopbackWebSocketUrl(rawUrl) {
  const url = new URL(rawUrl);
  const isLoopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
  if ((url.protocol !== "ws:" && url.protocol !== "wss:") || !isLoopback) {
    throw new Error(`拒绝连接非本机 CDP 地址：${rawUrl}`);
  }
  return url.toString();
}

export class CdpConnection {
  #url;
  #socket;
  #nextId = 1;
  #pending = new Map();
  #listeners = new Map();
  #timeoutMs;

  constructor(url, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.#url = assertLoopbackWebSocketUrl(url);
    this.#timeoutMs = timeoutMs;
  }

  get isOpen() {
    return this.#socket?.readyState === WebSocket.OPEN;
  }

  on(method, listener) {
    if (typeof method !== "string" || method.length === 0) {
      throw new TypeError("CDP event 名称必须是非空字符串");
    }
    if (typeof listener !== "function") {
      throw new TypeError("CDP event listener 必须是函数");
    }

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
    if (!listeners) return false;

    const removed = listeners.delete(listener);
    if (listeners.size === 0) this.#listeners.delete(method);
    return removed;
  }

  async connect() {
    if (this.isOpen) return;

    await new Promise((resolve, reject) => {
      const socket = new WebSocket(this.#url);
      this.#socket = socket;
      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error(`连接 CDP 超时：${this.#url}`));
      }, this.#timeoutMs);

      socket.addEventListener("open", () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });

      socket.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error(`无法连接 CDP：${this.#url}`));
      }, { once: true });

      socket.addEventListener("message", (event) => this.#handleMessage(event.data));
      socket.addEventListener("close", () => this.#handleClose(socket));
    });
  }

  async send(method, params = {}) {
    if (!this.isOpen) throw new Error("CDP 连接尚未建立");

    const id = this.#nextId++;
    const payload = JSON.stringify({ id, method, params });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`CDP 调用超时：${method}`));
      }, this.#timeoutMs);
      // 不要让一个悬挂的 CDP 调用把常驻进程的事件循环钉住，避免 Ctrl-C 后无法退出。
      timeout.unref?.();

      this.#pending.set(id, { method, resolve, reject, timeout });
      try {
        // isOpen 检查与 send 之间套接字可能已经关闭；同步捕获避免留下永不清理的 pending。
        this.#socket.send(payload);
      } catch (error) {
        clearTimeout(timeout);
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error(`CDP 发送失败：${method}`));
      }
    });
  }

  close() {
    this.#socket?.close();
  }

  #handleMessage(data) {
    let message;
    try {
      message = JSON.parse(String(data));
    } catch {
      return;
    }

    if (typeof message.method === "string") {
      this.#emit(message.method, message.params ?? {}, message);
      return;
    }

    if (message.id === undefined || message.id === null) return;
    const pending = this.#pending.get(message.id);
    if (!pending) return;

    clearTimeout(pending.timeout);
    this.#pending.delete(message.id);

    if (message.error) {
      pending.reject(new Error(`${pending.method} 失败：${message.error.message}`));
      return;
    }
    pending.resolve(message.result ?? {});
  }

  #emit(method, params, message) {
    const listeners = this.#listeners.get(method);
    if (!listeners) return;

    for (const listener of [...listeners]) {
      try {
        const result = listener(params, message);
        if (result && typeof result.then === "function") result.catch(() => {});
      } catch {
        // A consumer listener must not be able to break CDP response routing.
      }
    }
  }

  #handleClose(socket) {
    if (socket !== this.#socket) return;

    for (const { method, reject, timeout } of this.#pending.values()) {
      clearTimeout(timeout);
      reject(new Error(`CDP 连接已断开：${method}`));
    }
    this.#pending.clear();
    this.#emit("close", { url: this.#url }, { method: "close", params: { url: this.#url } });
    this.#listeners.clear();
    this.#socket = null;
  }
}
