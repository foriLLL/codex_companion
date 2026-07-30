import assert from "node:assert/strict";
import test from "node:test";
import { filterCodexTargets, isCodexAppTarget } from "../src/targets.mjs";

test("只选择带本机调试地址的 app:// 页面 target", () => {
  const targets = filterCodexTargets([
    { id: "main", type: "page", url: "app://-/index.html", webSocketDebuggerUrl: "ws://127.0.0.1:9000/devtools/page/main" },
    { id: "overlay", type: "page", url: "app://-/index.html?initialRoute=%2Favatar-overlay", webSocketDebuggerUrl: "ws://127.0.0.1:9000/devtools/page/overlay" },
    { id: "pet", type: "page", url: "app://-/avatar-overlay-composition-surface.html?surfaceId=mascot-badge", webSocketDebuggerUrl: "ws://127.0.0.1:9000/devtools/page/pet" },
    { id: "sandbox", type: "page", url: "https://web-sandbox.oaiusercontent.com/", webSocketDebuggerUrl: "ws://127.0.0.1:9000/devtools/page/sandbox" },
    { id: "worker", type: "worker", url: "app://codex/worker", webSocketDebuggerUrl: "ws://127.0.0.1:9000/devtools/page/worker" },
    { id: "missing-socket", type: "page", url: "app://codex/settings" }
  ]);

  assert.deepEqual(targets.map((target) => target.id), ["main"]);
});

test("识别 Codex 辅助 app renderer，但不把它当作主界面", () => {
  const pet = {
    id: "pet",
    type: "page",
    url: "app://-/avatar-overlay-composition-surface.html?surfaceId=mascot-badge",
    webSocketDebuggerUrl: "ws://127.0.0.1:9000/devtools/page/pet"
  };
  assert.equal(isCodexAppTarget(pet), true);
  assert.deepEqual(filterCodexTargets([pet]), []);
});
