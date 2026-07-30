import assert from "node:assert/strict";
import vm from "node:vm";
import test from "node:test";
import { HLS_RUNTIME_VERSION, loadHlsRuntimeSource } from "../src/hls-runtime.mjs";

test("从精确依赖读取本地 hls.js，并在 renderer 中暴露 Hls", async () => {
  const source = await loadHlsRuntimeSource();
  const context = {};
  context.globalThis = context;
  context.self = context;

  vm.runInNewContext(source, context, { timeout: 2_000 });

  assert.equal(typeof context.Hls, "function");
  assert.equal(context.Hls.version, HLS_RUNTIME_VERSION);
  assert.doesNotMatch(source, /https?:\/\/cdn\./i);
});

test("拒绝与锁定版本不一致的 hls.js", async () => {
  const files = new Map([
    ["/fake/package.json", JSON.stringify({ version: "1.6.15" })],
    ["/fake/hls.min.js", "globalThis.Hls = { version: '1.6.15' };\n"]
  ]);

  await assert.rejects(
    loadHlsRuntimeSource({
      resolveImpl(specifier) {
        return specifier.endsWith("package.json") ? "/fake/package.json" : "/fake/hls.min.js";
      },
      async readFileImpl(path) {
        return files.get(path);
      }
    }),
    /版本不匹配/
  );
});

test("拒绝空的浏览器 bundle", async () => {
  await assert.rejects(
    loadHlsRuntimeSource({
      resolveImpl(specifier) {
        return specifier.endsWith("package.json") ? "/fake/package.json" : "/fake/hls.min.js";
      },
      async readFileImpl(path) {
        return path.endsWith("package.json")
          ? JSON.stringify({ version: HLS_RUNTIME_VERSION })
          : "  ";
      }
    }),
    /bundle 为空/
  );
});
