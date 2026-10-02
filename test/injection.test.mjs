import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import vm from "node:vm";
import test from "node:test";
import { ARTIFACT_HASH, INJECTION_VERSION, buildInjectionSource, buildConfigUpdateSource } from "../src/injection.mjs";
import { RENDERER_SOURCE } from "../src/renderer-embedded.generated.mjs";

// 布局/播放/生命周期在真实 Chromium smoke 中验证；这里验证注入传输边界。
test("构建产物内容决定注入身份，配置不改变 artifact", () => {
  assert.equal(ARTIFACT_HASH, createHash("sha256").update(RENDERER_SOURCE).digest("hex"));
  assert.ok(INJECTION_VERSION.endsWith(ARTIFACT_HASH.slice(0, 16)));
  for (const action of ["mount", "unmount"]) assert.doesNotThrow(() => new vm.Script(buildInjectionSource(action)));
  assert.throws(() => buildInjectionSource("replace"), /不支持的注入动作/);
});

test("任意卡片的配置与字符串完整传输，不拼入可执行代码", () => {
  const config = { revision: 9, order: ["new-card"], cards: { "new-card": { enabled: true, settings: { text: '\"); throw Error("injected");//\n</script>' } } } };
  const source = buildInjectionSource("mount", { config });
  let received;
  const suffix = source.slice(RENDERER_SOURCE.length);
  vm.runInNewContext(suffix, { __CODEX_COMPANION_RENDERER__: { bootstrap(value) { received = value; } } });
  assert.deepEqual(JSON.parse(JSON.stringify(received.config)), config);
  assert.equal(received.artifactHash, ARTIFACT_HASH);
});

test("配置更新只调用现有 runtime，返回异步结果且不重载 bundle", async () => {
  const config = { revision: 3, cards: { emby: { enabled: false, settings: {} } } };
  const source = buildConfigUpdateSource(config);
  assert.ok(source.length < 500);
  let calls = 0;
  const result = await vm.runInNewContext(source, { __CODEX_COMPANION__: { runtime: { async applyConfig(value) {
    calls += 1;
    assert.deepEqual(JSON.parse(JSON.stringify(value)), config);
    return true;
  } } } });
  assert.equal(result, true);
  assert.equal(calls, 1);
  assert.equal(vm.runInNewContext(source, {}), undefined);
});

test("构建后的真实 unmount 释放现有 bridge 并移除旧入口", () => {
  let disposed = 0;
  const removed = [];
  const context = vm.createContext({
    __CODEX_COMPANION__: { unmount() { disposed += 1; } },
    document: { getElementById(id) { return { remove() { removed.push(id); } }; } }
  });
  const result = vm.runInContext(buildInjectionSource("unmount"), context);
  assert.equal(result.status, "unmounted");
  assert.equal(disposed, 1);
  assert.equal(context.__CODEX_COMPANION__, undefined);
  assert.ok(removed.includes("codex-hg-root"));
});

test("重复注入的 DOMContentLoaded 等待只保留最新配置，卸载可取消", () => {
  const listeners = new Set();
  const context = vm.createContext({ document: {
    body: null, getElementById() { return null; },
    addEventListener(type, fn) { assert.equal(type, "DOMContentLoaded"); listeners.add(fn); },
    removeEventListener(type, fn) { listeners.delete(fn); }
  } });
  assert.equal(vm.runInContext(buildInjectionSource("mount"), context).status, "scheduled");
  assert.equal(vm.runInContext(buildInjectionSource("mount", { revision: 2 }), context).status, "scheduled");
  assert.equal(listeners.size, 1);
  vm.runInContext(buildInjectionSource("unmount"), context);
  assert.equal(listeners.size, 0);
});
