import assert from "node:assert/strict";
import test from "node:test";
import { createEmbyRuntime, createRuntimeShutdown } from "../src/cli.mjs";

test("CLI 把本地 HLS prelude 和统一 RPC Service 交给 Injector", async () => {
  const service = { handleRpc() {} };
  let constructorArgs;
  class FakeInjector {
    constructor(port, options) {
      constructorArgs = { port, options };
    }
  }

  const runtime = await createEmbyRuntime(56837, {
    InjectorClass: FakeInjector,
    loadRuntimeSource: async () => "/* local hls */",
    serviceFactory: () => service,
    logger: { info() {}, warn() {}, error() {} }
  });

  assert.equal(constructorArgs.port, 56837);
  assert.equal(constructorArgs.options.rpcHandler, service);
  assert.equal(constructorArgs.options.runtimePrelude, "/* local hls */");
  assert.equal(runtime.embyService, service);
  assert.equal(runtime.runtimePrelude, "/* local hls */");
});

test("常驻关闭先等待 Emby 会话停止，再停止 Injector，且可重入", async () => {
  const calls = [];
  const processRef = { exitCode: 0 };
  const shutdown = createRuntimeShutdown({
    embyService: {
      async dispose() {
        calls.push("dispose:start");
        await Promise.resolve();
        calls.push("dispose:end");
      }
    },
    injector: {
      stop() {
        calls.push("injector:stop");
      }
    },
    logger: { info(message) { calls.push(message); }, error() {} },
    processRef
  });

  const first = shutdown("SIGINT");
  const second = shutdown("SIGTERM");
  assert.equal(first, second);
  await first;

  assert.deepEqual(calls.slice(0, 3), ["dispose:start", "dispose:end", "injector:stop"]);
  assert.equal(processRef.exitCode, 0);
});

test("Emby dispose 失败时仍停止 Injector，并通过 exitCode 报错", async () => {
  const calls = [];
  const processRef = { exitCode: 0 };
  const shutdown = createRuntimeShutdown({
    embyService: {
      async dispose() {
        calls.push("dispose");
        throw new Error("stop failed");
      }
    },
    injector: { stop() { calls.push("stop"); } },
    logger: { info() {}, error(message) { calls.push(message); } },
    processRef
  });

  await shutdown("SIGTERM");

  assert.equal(processRef.exitCode, 1);
  assert.equal(calls[0], "dispose");
  assert.equal(calls[1], "stop");
  assert.match(calls[2], /停止媒体会话失败/);
});
