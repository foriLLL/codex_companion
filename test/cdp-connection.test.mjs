import assert from "node:assert/strict";
import test from "node:test";
import { CdpConnection, assertLoopbackWebSocketUrl } from "../src/cdp-connection.mjs";

const originalWebSocket = globalThis.WebSocket;

class FakeWebSocket {
  static OPEN = 1;
  static instances = [];

  readyState = 0;
  sent = [];
  #listeners = new Map();

  constructor(url) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type, listener) {
    let listeners = this.#listeners.get(type);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(type, listeners);
    }
    listeners.add(listener);
  }

  send(payload) {
    if (this.readyState === 3) throw new Error("socket 已关闭");
    this.sent.push(JSON.parse(payload));
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.#emit("open", {});
  }

  message(message) {
    this.#emit("message", { data: JSON.stringify(message) });
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

async function openConnection(options) {
  FakeWebSocket.instances = [];
  const connection = new CdpConnection("ws://127.0.0.1:9222/devtools/page/main", options);
  const connecting = connection.connect();
  const socket = FakeWebSocket.instances.at(-1);
  socket.open();
  await connecting;
  return { connection, socket };
}

test.before(() => {
  globalThis.WebSocket = FakeWebSocket;
});

test.after(() => {
  if (originalWebSocket === undefined) delete globalThis.WebSocket;
  else globalThis.WebSocket = originalWebSocket;
});

test("只允许本机 CDP WebSocket", () => {
  assert.equal(
    assertLoopbackWebSocketUrl("ws://localhost:9222/devtools/page/main"),
    "ws://localhost:9222/devtools/page/main"
  );
  assert.throws(
    () => assertLoopbackWebSocketUrl("wss://example.com/devtools/page/main"),
    /拒绝连接非本机/
  );
});

test("响应仍按 id 关联，CDP event 可订阅和取消订阅", async () => {
  const { connection, socket } = await openConnection();
  const events = [];
  const listener = (params, message) => events.push({ params, method: message.method });
  const unsubscribe = connection.on("Runtime.bindingCalled", listener);

  const response = connection.send("Runtime.enable");
  assert.deepEqual(socket.sent[0], { id: 1, method: "Runtime.enable", params: {} });
  socket.message({ method: "Runtime.bindingCalled", params: { name: "rpc", payload: "{}" } });
  socket.message({ id: 1, result: { enabled: true } });

  assert.deepEqual(await response, { enabled: true });
  assert.deepEqual(events, [{
    params: { name: "rpc", payload: "{}" },
    method: "Runtime.bindingCalled"
  }]);

  assert.equal(unsubscribe(), true);
  socket.message({ method: "Runtime.bindingCalled", params: { name: "rpc", payload: "again" } });
  assert.equal(events.length, 1);
  connection.close();
});

test("断开时拒绝 pending 调用、发出 close 并清理 event listener", async () => {
  const { connection, socket } = await openConnection();
  let closeCount = 0;
  connection.on("close", () => closeCount++);
  const pending = connection.send("Page.enable");

  socket.close();

  await assert.rejects(pending, /CDP 连接已断开：Page.enable/);
  assert.equal(closeCount, 1);
  assert.equal(connection.isOpen, false);
  assert.equal(connection.off("close", () => {}), false);
});

test("send() 在套接字发送抛错时立即拒绝且不留下悬挂的 pending", async () => {
  const { connection, socket } = await openConnection();
  // 模拟 isOpen 检查通过后套接字底层已不可用：send 同步抛错。
  // isOpen 依赖 readyState === OPEN，这里让 send 抛错而不改状态，直接触发 catch 分支。
  const originalSend = socket.send.bind(socket);
  socket.send = () => { throw new Error("底层套接字已失效"); };

  await assert.rejects(connection.send("Page.enable"), /底层套接字已失效/);

  // 应该没有悬挂的 pending：恢复 send 后一个正常的往返仍可完成，
  // 且 id 计数没有被漏删的条目干扰。
  socket.send = originalSend;
  const ok = connection.send("Runtime.enable");
  socket.message({ id: socket.sent.at(-1).id, result: { enabled: true } });
  assert.deepEqual(await ok, { enabled: true });
  connection.close();
});
