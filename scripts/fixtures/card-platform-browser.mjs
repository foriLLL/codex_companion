import { createCardRuntime } from "/src/renderer/runtime/card-runtime.mjs";
import { createCardShell } from "/src/renderer/shell/card-shell.mjs";
import { createSettingsPanel } from "/src/renderer/shell/settings-panel.mjs";
import { createRpcClient } from "/src/renderer/platform/rpc-client.mjs";
import { CARD_MANIFESTS } from "/src/card-registry.mjs";

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const equal = (actual, expected, message) => assert(JSON.stringify(actual) === JSON.stringify(expected), `${message}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(condition, label) {
  const deadline = Date.now() + 4000;
  while (!condition()) { if (Date.now() > deadline) throw Error(`等待超时: ${label}`); await tick(); }
}
function memory() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)) };
}
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const permutations = values => values.length ? values.flatMap((value, index) => permutations(values.filter((_, i) => i !== index)).map(rest => [value, ...rest])) : [[]];

function fixture({ manifests = CARD_MANIFESTS, config, renderers, nativeAdapter = false, mediaCard, initialOpen = true, platformCall } = {}) {
  const contexts = [], sent = [], errors = [], behavior = new Map();
  const localBackend = memory(), sessionBackend = memory();
  let instanceSequence = 0, shell, adapter;
  const rpcClient = createRpcClient({ timeoutMs: 3000, binding: () => raw => {
    const request = JSON.parse(raw); sent.push(request);
    if (request.cardId === "companion" && platformCall) return platformCall(request.method, request.params);
    if (request.method === "rpc.cancel" || request.method.endsWith(".hold")) return undefined;
    return Promise.resolve({ method: request.method, cardId: request.cardId, generation: request.generation });
  } });
  const mount = async ctx => {
    const id = ctx.manifest.id;
    const instance = { ctx, id, serial: ++instanceSequence, disposeCalls: 0, updates: [], visibility: [], events: 0, ticks: 0 };
    contexts.push(instance);
    const marker = document.createElement("div"); marker.textContent = id; marker.dataset.instance = String(instance.serial);
    marker.style.cssText = "height:96px;padding:12px;box-sizing:border-box";
    ctx.root.append(marker); instance.marker = marker;
    ctx.effects.listen(window, "fixture-event", () => { instance.events++; });
    ctx.effects.interval(() => { instance.ticks++; }, 10);
    ctx.effects.timeout(() => { instance.lateTimer = true; }, 100_000);
    const observer = new ResizeObserver(() => {}); observer.observe(marker); ctx.effects.observe(observer);
    ctx.effects.objectUrl(URL.createObjectURL(new Blob([id])));
    ctx.effects.add(() => { instance.cleanupCalled = true; });
    if (id === mediaCard) {
      const canvas = document.createElement("canvas"); canvas.width = canvas.height = 32;
      const paint = canvas.getContext("2d");
      const draw = () => { paint.fillStyle = `rgb(${Date.now() % 255},50,100)`; paint.fillRect(0, 0, 32, 32); };
      draw(); ctx.effects.interval(draw, 30);
      const video = document.createElement("video"); video.muted = true; video.autoplay = true;
      video.style.cssText = "width:32px;height:32px";
      const stream = canvas.captureStream(30); video.srcObject = stream; ctx.root.append(video);
      ctx.effects.add(() => { stream.getTracks().forEach(track => track.stop()); video.srcObject = null; });
      await video.play(); instance.video = video;
    }
    const mode = behavior.get(id) ?? {};
    if (mode.gate) await mode.gate.promise;
    if (mode.mountError) throw Error(`mount-${id}`);
    return {
      api: instance,
      updateSettings(value) { instance.updates.push(value); if (behavior.get(id)?.updateError) throw Error(`update-${id}`); },
      visibilityChanged(value) { instance.visibility.push(value); },
      dispose() { instance.disposeCalls++; if (mode.disposeError) throw Error(`dispose-${id}`); ctx.root.replaceChildren(); }
    };
  };
  const fakeAdapter = ({ host, placement, onVisibilityChange, hasSettings }) => {
    const container = document.createElement("div"); container.style.cssText = "width:332px;position:relative";
    container.dataset.fixtureAdapter = "true";
    let hasCards = false, open = initialOpen, disposed = false;
    const sync = () => {
      if ((hasCards || hasSettings) && !disposed) { if (!container.isConnected) document.body.append(container); if (host.parentNode !== container) container.append(host); }
      else container.remove();
      host.hidden = !open;
      onVisibilityChange({ visible: (hasCards || hasSettings) && open && !disposed, placement, reason: "fixture" });
    };
    adapter = {
      setPlacement(value) { placement = value; sync(); }, setHasCards(value) { hasCards = value; sync(); },
      setOpen(value) { open = value; sync(); }, isPlaced: () => (hasCards || hasSettings) && open && !disposed,
      getDiagnostics: () => ({ mode: open ? placement : "hidden", placement, hasCards, disposed }),
      dispose() { disposed = true; sync(); }
    };
    return adapter;
  };
  const runtime = createCardRuntime({
    manifests, renderers: renderers ?? Object.fromEntries(manifests.map(manifest => [manifest.id, { mount }])),
    config: config ?? { enabled: true, cards: Object.fromEntries(manifests.map(manifest => [manifest.id, { enabled: true, settings: {} }])) },
    shellFactory: () => { shell = createCardShell(); return shell; },
    ...(nativeAdapter ? {} : { adapterFactory: fakeAdapter }),
    rpcClient, localStorage: localBackend, sessionStorage: sessionBackend, onError: (error, details) => errors.push({ message: error.message, ...details })
  });
  return { runtime, contexts, sent, errors, behavior, rpcClient, mount, localBackend, sessionBackend, get shell() { return shell; }, get adapter() { return adapter; } };
}
async function settled(f, ids) {
  await until(() => ids.every(id => f.runtime.getDiagnostics().cards[id]?.state === "active"), `active ${ids}`);
  await tick();
}
const snapshot = f => Object.fromEntries(Object.keys(f.runtime.getDiagnostics().cards).map(id => [id, f.runtime.getCardApi(id)]));
function unchanged(f, previous, ids, label) {
  for (const id of ids) assert(f.runtime.getCardApi(id) === previous[id], `${label}: ${id} 实例被重建`);
}
const cardConfig = (ids, enabled = ids) => Object.fromEntries(ids.map(id => [id, { enabled: enabled.includes(id), settings: {} }]));

export async function matrix() {
  assert(CARD_MANIFESTS.length >= 4, "矩阵必须使用全部实际 manifest");
  const ids = CARD_MANIFESTS.map(card => card.id), orders = permutations(ids);
  const f = fixture({ config: { cards: cardConfig(ids, []) } });
  let cases = 0, gapChecks = 0;
  try {
    for (const placement of ["standalone-button", "inline-in-summary"]) {
      for (let mask = 0; mask < 2 ** ids.length; mask++) {
        const enabled = ids.filter((_, index) => mask & (1 << index));
        for (const order of orders) {
          const previous = snapshot(f), beforeIds = Object.keys(previous);
          await f.runtime.applyConfig({ placement, order, cards: cardConfig(ids, enabled) });
          await settled(f, enabled);
          unchanged(f, previous, enabled.filter(id => beforeIds.includes(id)), `matrix ${mask}/${placement}`);
          const slots = [...f.shell.root.querySelectorAll(".slot")].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
          equal(slots.map(slot => slot.dataset.card), order.filter(id => enabled.includes(id)), "实际视觉顺序");
          equal(f.runtime.getDiagnostics().shell.count, enabled.length, "slot 数量");
          const roots = slots.map(slot => slot.querySelector(".content").shadowRoot);
          assert(roots.every(root => root instanceof ShadowRoot) && new Set(roots).size === slots.length, "每卡独立 ShadowRoot");
          for (let index = 1; index < slots.length; index++) {
            const gap = slots[index].getBoundingClientRect().top - slots[index - 1].getBoundingClientRect().bottom;
            assert(Math.abs(gap - 24) <= 1, `gap ${gap}, mask=${mask}, placement=${placement}, order=${order}`); gapChecks++;
          }
          if (!enabled.length) assert(f.shell.host.isConnected && f.shell.root.querySelector('[aria-label="Companion 设置"]'), "空集合丢失设置入口");
          cases++;
        }
      }
    }
    equal(cases, 2 * 2 ** ids.length * orders.length, "完整矩阵数量");
  } finally { await f.runtime.dispose(); }
  assert(f.contexts.every(instance => instance.ctx.effects.diagnostics().active === 0 && instance.disposeCalls === 1), "矩阵卸载资源泄漏或重复 dispose");
  assert(f.rpcClient.diagnostics().pending === 0, "矩阵 RPC 泄漏");
  return { cases, gapChecks, instances: f.contexts.length };
}

export async function incremental() {
  const ids = CARD_MANIFESTS.map(card => card.id), f = fixture();
  try {
    await settled(f, ids);
    const previous = snapshot(f), mounts = f.contexts.length;
    const updates = Object.fromEntries(ids.map(id => [id, previous[id].updates.length]));
    const config = { placement: "inline-in-summary", order: [...ids].reverse(), cards: cardConfig(ids) };
    config.cards[ids[0]].settings = { difficulty: "new" };
    await f.runtime.applyConfig(config); await tick();
    unchanged(f, previous, ids, "settings/reorder/placement");
    equal(previous[ids[0]].updates.length, updates[ids[0]] + 1, "目标 settings 更新");
    for (const id of ids.slice(1)) equal(previous[id].updates.length, updates[id], "无关卡 settings 不更新");
    f.runtime.setOpen(false); await tick();
    assert(f.contexts.every(instance => instance.disposeCalls === 0), "hide 触发 dispose");
    f.runtime.setOpen(true); await tick(); unchanged(f, previous, ids, "hide/show");
    equal(f.contexts.length, mounts, "隐藏后重复 mount");
    const target = ids[0]; config.cards[target].enabled = false;
    await f.runtime.applyConfig(config);
    unchanged(f, previous, ids.slice(1), "disable unrelated");
    assert(previous[target].ctx.signal.aborted && previous[target].ctx.effects.diagnostics().active === 0, "关闭单卡资源未释放");
    const count = previous[target].events; window.dispatchEvent(new Event("fixture-event"));
    equal(previous[target].events, count, "被关闭卡监听仍响应");
    let rejected = false; try { previous[target].ctx.storage.write({ stale: true }); } catch (error) { rejected = error.code === "STATE_DISPOSED"; }
    assert(rejected, "旧 context storage 写入未被阻止");
    const current = f.runtime.getConfig();
    await f.runtime.applyConfig({ ...config, revision: 10 });
    assert(await f.runtime.applyConfig({ ...current, revision: 9 }) === false, "旧 revision 配置未拒绝");
    return { mounts, settingsTarget: target, retained: ids.length - 1 };
  } finally { await f.runtime.dispose(); assert(f.contexts.every(instance => instance.ctx.effects.diagnostics().active === 0), "增量场景资源泄漏"); }
}

export async function failures() {
  const ids = CARD_MANIFESTS.map(card => card.id), target = ids[0];
  const f = fixture({ config: { cards: cardConfig(ids, []) } });
  try {
    f.behavior.set(target, { mountError: true });
    await f.runtime.applyConfig({ cards: cardConfig(ids) });
    await settled(f, ids.slice(1));
    await until(() => f.shell.get(target).outer.querySelector('[role="alert"]').hidden === false, "mount 错误边界");
    const peers = snapshot(f), failed = f.contexts.find(instance => instance.id === target);
    equal(failed.ctx.effects.diagnostics().active, 0, "mount 失败未清理 effects");
    f.behavior.delete(target);
    f.shell.get(target).outer.querySelector(".error button").click();
    await settled(f, ids);
    unchanged(f, peers, ids.slice(1), "retry");
    equal(f.contexts.filter(instance => instance.id === target).length, 2, "retry 应仅重建目标卡");
    f.behavior.set(target, { updateError: true });
    const config = { cards: cardConfig(ids) }; config.cards[target].settings = { force: "error" };
    await f.runtime.applyConfig(config); await tick();
    assert(!f.shell.get(target).outer.querySelector(".error").hidden, "update 错误未隔离呈现");
    unchanged(f, peers, ids.slice(1), "update failure");
    // 另起一代，在 mount 时声明 dispose 抛错。
    f.behavior.set(target, { disposeError: true }); await f.runtime.retry(target); await settled(f, ids);
    config.cards[target].enabled = false; await f.runtime.applyConfig(config);
    assert(f.errors.some(error => error.message === `dispose-${target}`), "dispose 异常未报告");
    unchanged(f, peers, ids.slice(1), "dispose failure");
    return { mountError: true, updateError: true, disposeError: true, retries: 2 };
  } finally { await f.runtime.dispose(); assert(f.contexts.every(instance => instance.ctx.effects.diagnostics().active === 0), "失败场景 effects 泄漏"); }
}

export async function lateMount() {
  const ids = CARD_MANIFESTS.map(card => card.id), target = ids[0];
  const f = fixture({ config: { cards: cardConfig(ids, []) } });
  const gate = deferred();
  try {
    f.behavior.set(target, { gate });
    await f.runtime.applyConfig({ cards: cardConfig(ids, [target]) });
    await until(() => f.contexts.length === 1, "late mount started");
    const old = f.contexts[0];
    await f.runtime.applyConfig({ cards: cardConfig(ids, []) });
    assert(old.ctx.signal.aborted && old.ctx.effects.diagnostics().active === 0, "pending mount 关闭未中止");
    f.behavior.delete(target);
    await f.runtime.applyConfig({ cards: cardConfig(ids, [target]) }); await settled(f, [target]);
    const current = f.runtime.getCardApi(target);
    assert(current.ctx.generation !== old.ctx.generation, "新一代 context 复用了旧 generation");
    gate.resolve();
    await until(() => old.disposeCalls === 1, "迟到 handle 未清理");
    assert(f.runtime.getCardApi(target) === current && current !== old, "迟到 mount 覆盖新一代");
    assert(!old.marker.isConnected && current.marker.isConnected, "旧代 DOM 重新挂载");
    return { oldGeneration: old.ctx.generation, newGeneration: current.ctx.generation, lateDispose: old.disposeCalls };
  } finally { gate.resolve(); await f.runtime.dispose(); }
}

export async function rpcIsolation() {
  const ids = CARD_MANIFESTS.filter(card => card.capabilities.includes("rpc")).map(card => card.id);
  assert(ids.length >= 2, "需要两张 RPC 卡");
  const all = CARD_MANIFESTS.map(card => card.id), f = fixture({ config: { cards: cardConfig(all, ids) } });
  try {
    await settled(f, ids);
    const first = f.runtime.getCardApi(ids[0]), second = f.runtime.getCardApi(ids[1]);
    const a = first.ctx.rpc.request("hold"), b = second.ctx.rpc.request("hold");
    let aError, bSettled = false;
    a.promise.catch(error => { aError = error.code; }); b.promise.finally(() => { bSettled = true; }).catch(() => {});
    equal(f.rpcClient.diagnostics().pending, 2, "独立 RPC pending");
    second.ctx.rpc.cancel(a.id); equal(f.rpcClient.diagnostics().pending, 2, "另一张卡取消了不属于自己的请求");
    await f.runtime.applyConfig({ cards: cardConfig(all, ids.slice(1)) });
    await until(() => aError === "ABORTED", "disabled RPC 未中止");
    assert(!bSettled && f.rpcClient.diagnostics().pending === 1, "关闭一张卡影响另一 RPC");
    const requestA = f.sent.find(request => request.id === a.id);
    assert(requestA.generation === first.ctx.generation, "context generation 与 RPC scope 不一致");
    const release = f.sent.find(request => request.method === `${ids[0]}.lifecycle.dispose`);
    assert(release && release.generation === requestA.generation, "释放 RPC 未保留旧代身份");
    const cancel = f.sent.find(request => request.method === "rpc.cancel" && request.params.requestId === a.id);
    assert(cancel?.cardId === ids[0] && cancel?.generation === requestA.generation, "取消请求没有独立边界");
    assert(f.runtime.receiveRpc({ id: a.id, ok: true, result: "late" }) === false, "已取消 RPC 接受迟到回复");
    f.runtime.receiveRpc({ id: b.id, ok: true, result: "second" }); equal(await b.promise, "second", "另一卡响应错配");
    equal(f.rpcClient.diagnostics().pending, 0, "RPC 未清空");
    return { independentCards: ids.length, cancelScope: cancel.cardId, releaseGeneration: release.generation };
  } finally { await f.runtime.dispose(); }
}

export async function discoveredCard() {
  const catalog = await (await fetch("/fixture-catalog.json")).json();
  const renderers = Object.fromEntries(await Promise.all(catalog.map(async card => [card.manifest.id, await import(card.rendererUrl)])));
  const probe = catalog.find(card => card.manifest.id === "fixture-probe"); assert(probe, "目录发现没有找到陌生卡");
  let f;
  globalThis.__fixtureMount = ctx => f.mount(ctx);
  f = fixture({ manifests: catalog.map(card => card.manifest), renderers, config: { enabled: false } });
  try {
    const ids = catalog.map(card => card.manifest.id);
    await f.runtime.applyConfig({ cards: cardConfig(ids) }); await settled(f, ids);
    const instance = f.runtime.getCardApi(probe.manifest.id), peers = snapshot(f);
    const saved = instance.ctx.storage.namespace("progress", { version: 1, validate: value => Number.isInteger(value?.level) });
    saved.write({ level: 3 }, { expectedRevision: saved.read(null).revision });
    equal(saved.read(null).value, { level: 3 }, "陌生卡存档");
    const reply = await instance.ctx.rpc("echo", { number: 5 });
    equal(reply.cardId, "fixture-probe", "陌生卡 RPC 自动路由标识");
    const config = { order: [...ids].reverse(), cards: cardConfig(ids) };
    config.cards[probe.manifest.id].settings = { level: 4 };
    await f.runtime.applyConfig(config); await tick(); unchanged(f, peers, ids, "陌生卡 settings/reorder");
    config.cards[probe.manifest.id].enabled = false; await f.runtime.applyConfig(config);
    unchanged(f, peers, ids.filter(id => id !== probe.manifest.id), "陌生卡 disable");
    config.cards[probe.manifest.id].enabled = true; await f.runtime.applyConfig(config); await settled(f, ids);
    const next = f.runtime.getCardApi(probe.manifest.id);
    equal(next.ctx.storage.namespace("progress", { version: 1 }).read(null).value, { level: 3 }, "陌生卡重新启用保存进度");
    return { directoryDiscovered: ids.length, addedId: probe.manifest.id, coreChanges: 0 };
  } finally { await f.runtime.dispose(); delete globalThis.__fixtureMount; }
}

export async function nativeIntegration() {
  const native = document.createElement("div");
  native.innerHTML = '<button id="fixture-summary-toggle" aria-label="Toggle pinned summary" aria-pressed="false"></button><div class="thread-floating-content-top-inset right-0" style="position:absolute;top:48px;right:0;height:600px;width:316px"><div id="fixture-summary-column" class="origin-top-right" style="width:316px;height:100%;opacity:0"><div id="fixture-native-panel" style="width:300px;height:240px;background:white;border-radius:24px">Summary</div></div></div>';
  document.body.append(native);
  const toggle = native.querySelector("button"), column = native.querySelector(".origin-top-right");
  toggle.onclick = () => { const open = toggle.getAttribute("aria-pressed") !== "true"; toggle.setAttribute("aria-pressed", String(open)); column.style.opacity = open ? "1" : "0"; };
  const ids = CARD_MANIFESTS.map(card => card.id), mediaId = ids.at(-1), f = fixture({ nativeAdapter: true, mediaCard: mediaId });
  try {
    f.runtime.setOpen(true); await settled(f, ids); const previous = snapshot(f);
    const video = previous[mediaId].video;
    await until(() => video.currentTime > .1, "模拟媒体开始播放");
    for (const order of permutations(ids)) {
      await f.runtime.applyConfig({ placement: "standalone-button", order, cards: cardConfig(ids) });
      assert(f.runtime.getCardApi(mediaId).video === video && !video.paused, "Shell reorder 重置媒体");
    }
    await f.runtime.applyConfig({ placement: "inline-in-summary", cards: cardConfig(ids) }); f.runtime.setOpen(true);
    await until(() => f.runtime.getPlacement() === "animated-summary", "原生 inline 挂载");
    unchanged(f, previous, ids, "原生 placement 切换");
    const gap = f.shell.host.getBoundingClientRect().top - native.querySelector("#fixture-native-panel").getBoundingClientRect().bottom;
    assert(Math.abs(gap - 24) <= 1, `原生 Summary gap=${gap}`);
    f.runtime.setOpen(false); await until(() => !f.runtime.isPlaced(), "原生 inline 收起");
    assert(f.shell.host.isConnected && f.contexts.every(instance => instance.disposeCalls === 0), "原生收起丢弃卡片");
    const hiddenAt = video.currentTime;
    await until(() => video.currentTime > hiddenAt + .2, "原生隐藏后媒体时间停止");
    assert(!video.paused && f.runtime.getCardApi(mediaId).video === video, "原生隐藏/placement 重置媒体");
    f.runtime.setOpen(true); await until(() => f.runtime.isPlaced(), "原生重新打开"); unchanged(f, previous, ids, "原生 hide/show");
    return { gap, instancesRetained: ids.length, mediaAdvanced: video.currentTime > hiddenAt + .2, mediaReorders: 24 };
  } finally { await f.runtime.dispose(); native.remove(); }
}

export async function storageContracts() {
  const manifests = ["target", "global", "session"].map((scope, index) => ({
    id: `fixture-${scope}`, title: scope, version: 1, defaultEnabled: true, defaultOrder: index,
    layout: { height: "content", minHeight: 100, scroll: "outer" },
    lifecycle: { start: "first-visible", hidden: "retain" }, state: { scope, version: 1 }, capabilities: ["storage"]
  }));
  const f = fixture({ manifests });
  const throwsCode = (action, code, label) => {
    let caught; try { action(); } catch (error) { caught = error.code; }
    equal(caught, code, label);
  };
  try {
    await settled(f, manifests.map(card => card.id));
    const target = f.runtime.getCardApi("fixture-target").ctx.storage;
    const validate = value => Number.isInteger(value?.level);
    const schema = target.namespace("state", { version: 1, validate });
    throwsCode(() => schema.write({ level: "invalid" }), "STORAGE_INVALID", "默认 state 的 validator 必须生效");
    assert(f.localBackend.getItem(schema.key) === null, "非法默认 state 被写入");
    schema.write({ level: 1 }, { expectedRevision: null });
    equal(target.read(null).value, { level: 1 }, "默认 facade 复用已声明 schema");
    assert(target.namespace("state", { validate }) === schema, "相同 schema 重复访问没有复用");
    throwsCode(() => target.namespace("state", { validate: () => true }), "STATE_SCHEMA_CONFLICT", "重复声明不同 validator 必须拒绝");
    const migrate = record => ({ version: 2, value: record.value });
    target.namespace("migration", { version: 2, migrate });
    throwsCode(() => target.namespace("migration", { version: 2, migrate: () => ({ version: 2, value: 0 }) }), "STATE_SCHEMA_CONFLICT", "重复声明不同 migrate 必须拒绝");
    const globalStore = f.runtime.getCardApi("fixture-global").ctx.storage;
    f.localBackend.setItem(globalStore.key, JSON.stringify({ version: 1, revision: 1, value: { shared: true } }));
    equal(globalStore.read(null).value, { shared: true }, "global 读取");
    for (const [name, action] of [
      ["write", () => globalStore.write({ shared: false }, { expectedRevision: 1 })],
      ["update", () => globalStore.update(() => ({ shared: false }))],
      ["copyLegacy", () => globalStore.copyLegacy("legacy")]
    ]) throwsCode(action, "STATE_SCOPE_READONLY", `global ${name} 必须拒绝非原子写入`);
    equal(globalStore.read(null).value, { shared: true }, "拒绝写入后 global 原值保留");
    const session = f.runtime.getCardApi("fixture-session").ctx.storage;
    session.write({ transient: true }, { expectedRevision: null });
    assert(f.sessionBackend.getItem(session.key) !== null && f.localBackend.getItem(session.key) === null, "session scope 误写 localStorage");
    assert(f.localBackend.getItem(schema.key) !== null && f.sessionBackend.getItem(schema.key) === null, "target scope 后端错误");
    return { defaultSchemaValidated: true, schemaConflicts: 2, globalMutationsRejected: 3, sessionBackend: true };
  } finally { await f.runtime.dispose(); }
}

export async function suspendPolicy() {
  const manifests = ["suspend", "retain"].map((hidden, index) => ({
    id: `fixture-${hidden}`, title: hidden, version: 1, defaultEnabled: true, defaultOrder: index,
    layout: { height: "content", minHeight: 100, scroll: "outer" },
    lifecycle: { start: "immediate", hidden }, state: { scope: "target", version: 1 }, capabilities: []
  }));
  const f = fixture({ manifests, initialOpen: false });
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  let timeoutFired = 0;
  try {
    await settled(f, manifests.map(card => card.id));
    const paused = f.runtime.getCardApi("fixture-suspend"), retained = f.runtime.getCardApi("fixture-retain");
    await delay(60);
    equal(paused.ticks, 0, "初始隐藏的 immediate+suspend 卡仍执行 interval");
    assert(retained.ticks > 0, "retain 错误暂停 interval");
    f.runtime.setOpen(true);
    await until(() => paused.ticks >= 2, "suspend 展开未恢复 interval");
    paused.ctx.effects.timeout(() => { timeoutFired++; }, 60);
    f.runtime.setOpen(false);
    const hiddenTicks = paused.ticks, retainedTicks = retained.ticks;
    await delay(100);
    equal(paused.ticks, hiddenTicks, "隐藏期间 interval 继续执行");
    equal(timeoutFired, 0, "隐藏期间 timeout 继续执行");
    assert(retained.ticks > retainedTicks, "隐藏误伤 retain 卡");
    const eventCount = paused.events; window.dispatchEvent(new Event("fixture-event"));
    equal(paused.events, eventCount + 1, "suspend 不应擅自移除事件监听");
    f.runtime.setOpen(true);
    equal(paused.ticks, hiddenTicks, "恢复同步补发了隐藏期间的 tick");
    equal(timeoutFired, 0, "恢复忽略 timeout 的剩余延迟");
    await until(() => timeoutFired === 1 && paused.ticks > hiddenTicks, "恢复后计时器未继续");
    f.runtime.setOpen(false);
    paused.ctx.effects.timeout(() => { timeoutFired++; }, 20);
    await f.runtime.dispose();
    const disposedTicks = paused.ticks; await delay(40);
    equal(timeoutFired, 1, "隐藏状态卸载后 timeout 仍执行");
    equal(paused.ticks, disposedTicks, "隐藏状态卸载后 interval 仍执行");
    assert(f.contexts.every(instance => instance.ctx.effects.diagnostics().active === 0 && instance.disposeCalls === 1), "suspend 卸载未完全清理");
    return { initialHiddenPaused: true, timersPaused: 2, retainUnaffected: true, resumed: true, disposedResources: 0 };
  } finally { await f.runtime.dispose(); }
}

export async function viewportScroll() {
  const manifests = ["inner", "outer"].map((scroll, index) => ({
    id: `fixture-${scroll}`, title: scroll, version: 1, defaultEnabled: true, defaultOrder: index,
    layout: { height: scroll === "inner" ? "viewport" : "content", minHeight: 100, scroll },
    lifecycle: { start: "first-visible", hidden: "retain" }, state: { scope: "target", version: 1 }, capabilities: []
  }));
  const f = fixture({ manifests });
  try {
    await settled(f, manifests.map(card => card.id));
    for (const manifest of manifests) {
      const long = document.createElement("div"); long.style.height = "1800px"; long.textContent = "Long card content";
      f.runtime.getCardApi(manifest.id).ctx.root.append(long);
    }
    const inner = f.shell.get("fixture-inner").outer.querySelector(".content");
    const marker = f.runtime.getCardApi("fixture-inner").marker;
    const before = marker.getBoundingClientRect().top;
    assert(getComputedStyle(inner).overflowY === "auto" && inner.scrollHeight > inner.clientHeight, "viewport+inner 没有滚动容器");
    inner.scrollTop = 175;
    equal(inner.scrollTop, 175, "viewport+inner 无法滚动长内容");
    equal(Math.round(before - marker.getBoundingClientRect().top), 175, "内部滚动未移动业务内容");
    const outer = f.shell.get("fixture-outer").outer.querySelector(".content");
    assert(getComputedStyle(outer).overflowY === "visible" && outer.clientHeight >= 1800, "content+outer 被固定高度裁剪");
    return { innerScrollTop: inner.scrollTop, innerHeight: inner.clientHeight, outerHeight: outer.clientHeight };
  } finally { await f.runtime.dispose(); }
}

export async function settingsEntrypoints() {
  const native = document.createElement("div");
  native.innerHTML = '<button aria-label="Toggle pinned summary" aria-pressed="false">Summary</button><div class="thread-floating-content-top-inset right-0" style="position:absolute;top:48px;right:0;height:600px;width:316px"><div class="origin-top-right" style="width:316px;height:100%;opacity:0"><div style="width:300px;height:140px;background:white;border-radius:24px">Summary</div></div></div>';
  document.body.append(native);
  const toggle = native.querySelector("button"), column = native.querySelector(".origin-top-right");
  toggle.onclick = () => {
    const open = toggle.getAttribute("aria-pressed") !== "true";
    toggle.setAttribute("aria-pressed", String(open));
    column.style.opacity = open ? "1" : "0";
  };
  let checked = 0;
  try {
    for (const placement of ["standalone-button", "inline-in-summary"]) {
      let config = {
        version: 2, revision: 4, enabled: false, placement,
        cards: cardConfig(CARD_MANIFESTS.map(card => card.id)), order: CARD_MANIFESTS.map(card => card.id),
        launch: { proxy: { enabled: false, port: 7890 } }, agent: { autoRelaunch: true }
      };
      const f = fixture({ nativeAdapter: true, config, platformCall(method, params) {
        if (method === "companion.settings.get") return Promise.resolve({ config: structuredClone(config), catalog: CARD_MANIFESTS, agent: null });
        if (method === "companion.agent.status") return Promise.resolve({ available: false });
        if (method === "companion.settings.patch") {
          equal(params.expectedRevision, config.revision, "保存 revision");
          config = { ...config, ...params.patch, revision: config.revision + 1 };
          return Promise.resolve({ config: structuredClone(config) });
        }
        throw Error(`unexpected ${method}`);
      } });
      try {
        await tick();
        if (placement === "standalone-button") {
          const outer = document.getElementById("codex-companion-root-shell");
          outer.shadowRoot.querySelector('button[aria-label="Companion 卡片"]').click();
        } else toggle.click();
        await until(() => f.runtime.isPlaced(), `${placement} 入口打开`);
        const gear = f.shell.root.querySelector('[aria-label="Companion 设置"]');
        assert(gear.getBoundingClientRect().width > 0, `${placement} 齿轮不可见`);
        assert(f.shell.root.querySelector(".platform-bar").textContent.includes("卡片已关闭"), "禁用提示缺失");
        equal(f.contexts.length, 0, "disabled 不能启动业务卡片");
        gear.focus(); gear.click();
        const panel = f.shell.root.querySelector(".cc-settings");
        await until(() => panel.getAttribute("aria-busy") === "false", "设置加载完成");
        assert(panel.textContent.includes("后台服务未运行"), "未运行状态缺失");
        equal(f.shell.root.activeElement.getAttribute("aria-label"), "关闭 Companion 设置", "打开后的焦点");
        for (const next of [placement === "standalone-button" ? "inline-in-summary" : "standalone-button", placement]) {
          panel.querySelector(`input[value="${next}"]`).click();
          await until(() => panel.getAttribute("aria-busy") === "false", "显示方式已保存");
          await f.runtime.applyConfig(config);
          await until(() => f.runtime.getPlacement() === (next === "standalone-button" ? "standalone" : "animated-summary"), "显示方式切换后设置仍打开");
          assert(panel.isConnected && !panel.hidden, "显示方式切换丢失设置页");
        }
        const enabled = panel.querySelector('[data-setting="enabled"]');
        enabled.focus(); enabled.click();
        await until(() => panel.getAttribute("aria-busy") === "false", "开启已保存");
        assert(f.shell.root.activeElement === enabled, "保存完成后键盘焦点丢失");
        equal(f.contexts.length, 0, "设置页不能直接开启运行时");
        await f.runtime.applyConfig(config);
        await settled(f, CARD_MANIFESTS.map(card => card.id));
        enabled.focus(); enabled.click();
        await until(() => panel.getAttribute("aria-busy") === "false", "关闭已保存");
        await f.runtime.applyConfig(config);
        equal(f.runtime.getDiagnostics().shell.count, 0, "关闭后业务外框残留");
        assert(panel.isConnected && !panel.hidden && gear.isConnected && f.runtime.isPlaced(), "关闭后设置入口被拆除");
        panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true, cancelable: true }));
        assert(panel.hidden && f.shell.root.activeElement === gear, "Esc 未恢复齿轮焦点");
        assert(f.runtime.isPlaced(), "设置 Escape 误关整个卡片区域");
        checked++;
      } finally { await f.runtime.dispose(); }
      if (toggle.getAttribute("aria-pressed") === "true") toggle.click();
    }
    return { placements: checked, disabledEntry: true, watcherOnly: true, focusRestored: true, openPlacementSwitches: checked * 2 };
  } finally { native.remove(); }
}

export async function settingsWithoutSummary() {
  const f = fixture({ nativeAdapter: true, config: { enabled: false, placement: "inline-in-summary" } });
  const native = document.createElement("div");
  try {
    f.runtime.setOpen(true);
    await until(() => f.runtime.isPlaced(), "无 Summary 时的独立入口兜底");
    assert(f.runtime.getDiagnostics().adapter.inlineEntryFallback, "未记录缺少 Summary 的兜底");
    assert(f.shell.root.querySelector('[aria-label="Companion 设置"]').getBoundingClientRect().width > 0, "兜底齿轮不可见");
    native.innerHTML = '<button aria-label="Toggle pinned summary" aria-pressed="true">Summary</button><div class="thread-floating-content-top-inset right-0" style="position:absolute;top:48px;right:0;height:600px;width:316px"><div class="origin-top-right" style="width:316px;height:100%;opacity:1"><div style="width:300px;height:140px;background:white;border-radius:24px">Summary</div></div></div>';
    document.body.append(native);
    await until(() => f.runtime.getPlacement() === "animated-summary", "Summary 出现后恢复 inline");
    native.remove();
    await until(() => f.runtime.getPlacement() === "standalone", "Summary 消失后恢复独立入口");
    assert(f.shell.root.querySelector('[aria-label="Companion 设置"]').getBoundingClientRect().width > 0, "恢复兜底后抽屉仍被隐藏");
    return { configuredPlacement: f.runtime.getConfig().placement, actualPlacement: f.runtime.getPlacement(), disabledEntry: true, summaryTransitions: 2 };
  } finally { await f.runtime.dispose(); native.remove(); }
}

export async function settingsLayout() {
  const host = document.createElement("div");
  host.style.cssText = "width:320px;color-scheme:light dark";
  const shadow = host.attachShadow({ mode: "open" });
  document.body.append(host);
  const calls = [];
  let config = { version: 2, revision: 0, enabled: true, cards: {}, order: ["long-title"], placement: "standalone-button", launch: { proxy: { enabled: false, port: 7890 } }, agent: { autoRelaunch: true } };
  const panel = createSettingsPanel({ document, call: async (method, params) => {
    calls.push({ method, params });
    if (method === "companion.settings.get") return { config, catalog: [{ id: "long-title", title: "LongUnbrokenCardTitle".repeat(5), defaultEnabled: true, defaultOrder: 0 }] };
    if (method === "companion.agent.status") return { available: false };
    if (method === "companion.codex.restart") return { accepted: true };
    config = { ...config, ...params.patch, revision: config.revision + 1 };
    return { config };
  } });
  shadow.append(panel.element);
  try {
    await panel.open();
    for (const [scheme, background, foreground] of [["light", "rgb(255, 255, 255)", "rgb(26, 28, 31)"], ["dark", "rgb(37, 37, 37)", "rgb(236, 236, 236)"]]) {
      host.style.colorScheme = scheme;
      host.style.setProperty("--cc-card-bg", background);
      host.style.setProperty("--cc-card-fg", foreground);
      equal(getComputedStyle(panel.element).backgroundColor, background, `${scheme} 背景 token`);
      equal(getComputedStyle(panel.element).color, foreground, `${scheme} 文字 token`);
      assert(panel.element.scrollWidth <= panel.element.clientWidth, `${scheme} 320px 设置页横向滚动`);
      for (const input of panel.element.querySelectorAll("input")) assert(input.labels?.length, "表单缺少可访问 label");
    }
    const buttons = [...panel.element.querySelectorAll("button")];
    buttons.find(button => button.textContent === "立即重启 Codex").click();
    equal(calls.filter(call => call.method.endsWith("restart")).length, 0, "显示确认前就发重启");
    equal(shadow.activeElement.textContent, "取消", "重启默认焦点应为取消");
    buttons.find(button => button.textContent === "确认重启").click();
    await tick();
    equal(calls.filter(call => call.method.endsWith("restart")).length, 1, "确认后只发一次重启");
    return { width: 320, themes: 2, overflow: false, labelledInputs: panel.element.querySelectorAll("input").length, confirmedRestart: true };
  } finally { panel.destroy(); host.remove(); }
}

export async function settingsBundle() {
  const { RENDERER_SOURCE, RENDERER_ARTIFACT_HASH } = await import("/src/renderer-embedded.generated.mjs");
  const config = { version: 2, revision: 3, enabled: false, placement: "standalone-button", cards: {}, order: [], launch: { proxy: { enabled: false, port: 7890 } }, agent: { autoRelaunch: true } };
  const sent = [];
  const previousBinding = globalThis.__CODEX_COMPANION_RPC__;
  globalThis.__CODEX_COMPANION_RPC__ = raw => {
    const request = JSON.parse(raw);
    sent.push(request);
    if (request.method === "companion.settings.get") return Promise.resolve({ config, catalog: CARD_MANIFESTS, agent: null });
    if (request.method === "companion.agent.status") return Promise.resolve({ available: false });
    throw Error(`unexpected ${request.method}`);
  };
  try {
    (0, eval)(RENDERER_SOURCE);
    const renderer = globalThis.__CODEX_COMPANION_RENDERER__;
    const result = renderer.bootstrap({ config, artifactHash: RENDERER_ARTIFACT_HASH, version: "fixture" });
    equal(result.status, "cards-disabled", "bundle disabled 状态");
    const bridge = globalThis.__CODEX_COMPANION__;
    bridge.setOpen(true);
    await until(() => bridge.isPlaced(), "bundle 设置入口打开");
    const root = document.getElementById("codex-companion-root-shell").shadowRoot.querySelector("#codex-companion-root").shadowRoot;
    root.querySelector('[aria-label="Companion 设置"]').click();
    await until(() => root.querySelector(".cc-settings").getAttribute("aria-busy") === "false", "bundle 设置读取");
    equal(sent.map(item => item.method), ["companion.settings.get", "companion.agent.status"], "bundle 平台 RPC");
    assert(sent.every(item => item.cardId === "companion" && Number.isInteger(item.generation)), "bundle 平台 scope");
    equal(renderer.bootstrap({ config: { ...config, revision: 4 }, artifactHash: RENDERER_ARTIFACT_HASH }).status, "already-mounted", "重复 bundle 不重建入口");
    assert(globalThis.__CODEX_COMPANION__ === bridge, "重复注入替换了 runtime");
    return { artifact: RENDERER_ARTIFACT_HASH.slice(0, 16), disabledMount: true, scopedRpc: sent.length, reusedRuntime: true };
  } finally {
    globalThis.__CODEX_COMPANION_RENDERER__?.bootstrap({ action: "unmount" });
    delete globalThis.__CODEX_COMPANION_RENDERER__;
    if (previousBinding === undefined) delete globalThis.__CODEX_COMPANION_RPC__;
    else globalThis.__CODEX_COMPANION_RPC__ = previousBinding;
    assert(!document.getElementById("codex-companion-root-shell"), "bundle 卸载残留平台外框");
  }
}

export const scenarios = { matrix, incremental, failures, lateMount, rpcIsolation, discoveredCard, nativeIntegration, storageContracts, suspendPolicy, viewportScroll, settingsEntrypoints, settingsWithoutSummary, settingsLayout, settingsBundle };
