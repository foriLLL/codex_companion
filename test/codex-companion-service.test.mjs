import assert from "node:assert/strict";
import test from "node:test";
import { CodexCompanionService } from "../src/codex-companion-service.mjs";

test("统一 RPC Service 按命名空间隔离红果和 Emby", async () => {
  const calls = [];
  const embyService = {
    async handleRpc(method) { calls.push(["emby", method]); return "emby"; },
    disposeTarget(target) { calls.push(["emby:disposeTarget", target]); },
    dispose() { calls.push(["emby:dispose"]); }
  };
  const hongguoService = {
    async handleRpc(method) { calls.push(["hongguo", method]); return "hongguo"; },
    disposeTarget(target) { calls.push(["hongguo:disposeTarget", target]); },
    dispose() { calls.push(["hongguo:dispose"]); }
  };
  const service = new CodexCompanionService({ embyService, hongguoService });
  assert.equal(await service.handleRpc("hongguo.home", {}, {}), "hongguo");
  assert.equal(await service.handleRpc("connection.status", {}, {}), "emby");
  await service.disposeTarget("renderer");
  await service.dispose();
  assert.deepEqual(calls, [
    ["hongguo", "hongguo.home"],
    ["emby", "connection.status"],
    ["hongguo:disposeTarget", "renderer"],
    ["emby:disposeTarget", "renderer"],
    ["hongguo:dispose"],
    ["emby:dispose"]
  ]);
});
