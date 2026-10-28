import test from "node:test";
import assert from "node:assert/strict";
import { createCardRuntime } from "../src/renderer/runtime/card-runtime.mjs";

const settle = () => new Promise((resolve) => setImmediate(resolve));
function fixture({ start = "first-visible" } = {}) {
  const records = new Map();
  const values = new Map();
  const backend = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const manifests = ["alpha", "beta"].map((id) => ({ id, title: id, defaultEnabled: true, defaultOrder: id === "alpha" ? 0 : 1,
    state: { scope: "target", version: 1 }, capabilities: [], lifecycle: { hidden: "suspend", start }, layout: { height: "content", minHeight: 0, scroll: "outer" } }));
  let notify;
  const renderers = Object.fromEntries(manifests.map(({ id }) => [id, { mount(ctx) {
    const record = { ctx, visibility: [], disposed: false };
    records.set(id, record);
    return { visibilityChanged: (state) => record.visibility.push(state.visible), dispose() { record.disposed = true; } };
  } }]));
  const runtime = createCardRuntime({ manifests, renderers, config: {}, localStorage: backend, sessionStorage: backend,
    shellFactory: () => ({ host: {}, add: () => ({ root: {}, showError() {}, remove() {} }), reorder() {}, dispose() {}, diagnostics: () => ({}) }),
    adapterFactory: ({ onVisibilityChange }) => {
      notify = (visible) => onVisibilityChange({ visible, placement: "fixture" });
      return { setPlacement() {}, setHasCards() {}, setOpen: notify, dispose() { notify(false); }, isPlaced: () => true, getDiagnostics: () => ({ mode: "fixture" }) };
    }
  });
  return { records, runtime, notify: (visible) => notify(visible) };
}

test("插件逐卡可见性只启动当前页面，切换保留实例并暂停隐藏卡的effects", async () => {
  const { records, runtime, notify } = fixture();
  runtime.setCardVisibility("alpha", true);
  runtime.setCardVisibility("beta", false);
  notify(true);
  await settle();
  assert.deepEqual([...records.keys()], ["alpha"]);
  const alpha = records.get("alpha");
  assert.equal(alpha.ctx.isVisible(), true);
  assert.equal(alpha.ctx.effects.diagnostics().suspended, false);
  await runtime.setCardVisibility("alpha", false);
  await runtime.setCardVisibility("beta", true);
  const beta = records.get("beta");
  assert.equal(alpha.ctx.isVisible(), false);
  assert.equal(alpha.ctx.effects.diagnostics().suspended, true);
  assert.equal(alpha.disposed, false);
  assert.equal(beta.ctx.isVisible(), true);
  notify(false);
  await settle();
  assert.equal(beta.ctx.isVisible(), false);
  assert.equal(beta.ctx.effects.diagnostics().suspended, true);
  notify(true);
  await settle();
  assert.equal(beta.ctx.isVisible(), true);
  assert.equal(alpha.ctx.isVisible(), false);
  assert.equal(records.get("alpha"), alpha);
  assert.equal(records.get("beta"), beta);
  await runtime.dispose();
  assert.equal(alpha.disposed, true);
  assert.equal(beta.disposed, true);
  assert.equal(alpha.ctx.effects.diagnostics().active, 0);
});

test("未设置逐卡覆盖时保留旧入口全卡可见语义，immediate卡仍立即启动", async () => {
  const { records, runtime, notify } = fixture();
  notify(true);
  await settle();
  assert.equal(records.size, 2);
  assert.ok([...records.values()].every(({ ctx }) => ctx.isVisible()));
  await runtime.dispose();
  const immediate = fixture({ start: "immediate" });
  await settle();
  assert.equal(immediate.records.size, 2);
  assert.ok([...immediate.records.values()].every(({ ctx }) => !ctx.isVisible()));
  await immediate.runtime.dispose();
});
