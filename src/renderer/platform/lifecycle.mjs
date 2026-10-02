import { createEffects } from "./effects.mjs";

// 每次启用独占一代资源；旧异步任务只能清理自己，不能重新激活卡片。
export function createCardLifecycle({ mount, createContext = () => ({}), onError, timeoutMs = 1000 }) {
  if (typeof mount !== "function") throw new TypeError("mount 必须是函数");
  if (typeof createContext !== "function") throw new TypeError("createContext 必须是函数");
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new TypeError("timeoutMs 必须是非负有限数");

  let generation = 0;
  let current = null;
  let last = null;
  let pendingMounts = 0;
  let errors = 0;
  let visibility;
  let hasVisibility = false;
  const idle = Promise.resolve();

  function report(error, phase, instance) {
    errors += 1;
    if (typeof onError !== "function") return;
    try {
      Promise.resolve(onError(error, { phase, generation: instance.id })).catch(() => {});
    } catch {
      // 错误上报不能中断资源清理，也不能制造新的未处理拒绝。
    }
  }

  function isActive(instance) {
    return current === instance && !instance.controller.signal.aborted;
  }

  function bounded(result, instance, phase) {
    let timer;
    return new Promise((resolve) => {
      timer = setTimeout(() => {
        report(new Error(`${phase} 清理超时`), phase, instance);
        resolve();
      }, timeoutMs);
      Promise.resolve(result).then(resolve, (error) => {
        report(error, phase, instance);
        resolve();
      });
    }).finally(() => clearTimeout(timer));
  }

  function disposeHandle(instance) {
    if (instance.handleDisposed || !instance.handle) return idle;
    instance.handleDisposed = true;
    try {
      return bounded(instance.handle.dispose?.({ reason: instance.reason }), instance, "dispose");
    } catch (error) {
      report(error, "dispose", instance);
      return idle;
    }
  }

  function stop(instance, reason) {
    if (instance.cleanup) return instance.cleanup;
    let finish;
    instance.cleanup = new Promise((resolve) => { finish = resolve; });
    instance.reason = reason;
    instance.state = "disposed";
    if (current === instance) current = null;
    // 先摘除实例再同步 abort；清理回调重入 start 也会获得全新一代。
    instance.controller.abort(reason);
    const effectsCleanup = instance.effects.dispose();
    const handleCleanup = disposeHandle(instance);
    Promise.all([effectsCleanup, handleCleanup]).then(finish, finish);
    return instance.cleanup;
  }

  function enqueue(instance, name, value) {
    instance.queue = instance.queue.then(async () => {
      if (!isActive(instance)) return;
      try {
        await instance.handle?.[name]?.(value);
      } catch (error) {
        report(error, name, instance);
      }
    });
    return instance.queue;
  }

  function start(settings) {
    if (current) return current.ready;
    const instance = {
      id: ++generation,
      controller: new AbortController(),
      state: "mounting",
      settings,
      handle: null,
      handleDisposed: false,
      cleanup: null,
      queue: idle,
    };
    instance.effects = createEffects({
      signal: instance.controller.signal,
      cleanupTimeoutMs: timeoutMs,
      onError: (error) => report(error, "effects", instance),
    });
    current = last = instance;
    // 延后一微任务，确保 mount/createContext 重入时 ready 已初始化。
    instance.ready = Promise.resolve().then(async () => {
      let phase = "createContext";
      try {
        if (!isActive(instance)) return;
        const owned = {
          generation: instance.id,
          signal: instance.controller.signal,
          effects: instance.effects,
          settings: instance.settings,
        };
        const context = await createContext(owned);
        if (!isActive(instance)) return;
        phase = "mount";
        pendingMounts += 1;
        try {
          instance.handle = await mount({ ...context, ...owned, settings: instance.settings });
        } finally {
          pendingMounts -= 1;
        }
        if (!isActive(instance)) {
          await disposeHandle(instance);
          return;
        }
        instance.state = "active";
        enqueue(instance, "updateSettings", instance.settings);
        if (hasVisibility) enqueue(instance, "visibilityChanged", visibility);
        await instance.queue;
      } catch (error) {
        report(error, phase, instance);
        await stop(instance, "error");
      }
    });
    return instance.ready;
  }

  function update(settings) {
    if (!current) return idle;
    current.settings = settings;
    if (current.state === "mounting") return current.ready;
    return enqueue(current, "updateSettings", settings);
  }

  function visibilityChanged(state) {
    visibility = state;
    hasVisibility = true;
    if (!current) return idle;
    if (current.state === "mounting") return current.ready;
    return enqueue(current, "visibilityChanged", state);
  }

  function dispose(reason) {
    return current ? stop(current, reason) : (last?.cleanup ?? idle);
  }

  function diagnostics() {
    return {
      generation,
      active: current !== null,
      state: current?.state ?? (last ? "disposed" : "idle"),
      pendingMounts,
      effects: (current ?? last)?.effects.diagnostics() ?? null,
      errors,
    };
  }

  return { start, update, visibilityChanged, dispose, diagnostics };
}
