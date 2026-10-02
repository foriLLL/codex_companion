import { createEffects } from "../platform/effects.mjs";

// 业务模块独占的资源作用域；只调用平台 RPC，不建立第二套响应路由。
export function createMediaScope(ctx) {
  const controller = new AbortController();
  const urls = new Set();
  const listeners = new WeakMap();
  let pending = 0;
  let disposed = false;
  let cleanup;
  let releaseParent = () => {};
  const isDisposed = () => disposed || ctx.signal.aborted;
  const report = (error) => {
    try { Promise.resolve(ctx.reportError?.(error)).catch(() => {}); } catch {}
  };
  const effects = createEffects({ signal: controller.signal, onError: report });
  function dispose() {
    if (cleanup) return cleanup;
    let finish;
    cleanup = new Promise((resolve) => { finish = resolve; });
    disposed = true;
    controller.abort();
    const done = effects.dispose();
    for (const url of urls) URL.revokeObjectURL(url);
    urls.clear();
    releaseParent();
    Promise.resolve(done).then(finish, finish);
    return cleanup;
  }
  const aborted = () => Object.assign(new Error("卡片已经卸载"), { code: "ABORTED" });
  const check = () => { if (isDisposed()) throw aborted(); };
  const guard = (fn) => function guarded(...args) {
    if (isDisposed()) return;
    return fn.apply(this, args);
  };
  const safe = (fn) => function safely(...args) {
    if (isDisposed()) return;
    try {
      const result = fn.apply(this, args);
      if (result && typeof result.then === "function") {
        result.catch(report);
        return undefined;
      }
      return result;
    } catch (error) { report(error); }
  };
  const listen = (target, type, fn, options = {}) => {
    if (isDisposed()) return;
    let callbacks = listeners.get(target);
    if (!callbacks) listeners.set(target, callbacks = new WeakMap());
    let wrapped = callbacks.get(fn);
    if (!wrapped) callbacks.set(fn, wrapped = safe(fn));
    target.addEventListener(type, wrapped, {
      ...(typeof options === "boolean" ? { capture: options } : options),
      signal: controller.signal,
    });
  };
  const unlisten = (target, type, fn, options) => {
    const wrapped = listeners.get(target)?.get(fn);
    if (wrapped) target.removeEventListener(type, wrapped, options);
  };
  const requestRpc = (method, params = {}, options = {}) => {
    try {
      check();
      const signal = options.signal
        ? AbortSignal.any([controller.signal, ctx.signal, options.signal])
        : AbortSignal.any([controller.signal, ctx.signal]);
      const request = ctx.rpc.request(method, params, { ...options, signal });
      pending += 1;
      const promise = Promise.resolve(request.promise).then(
        (value) => { pending -= 1; check(); return value; },
        (error) => { pending -= 1; throw error; },
      );
      return { ...request, promise };
    } catch (error) {
      return { id: null, promise: Promise.reject(error), cancel() {} };
    }
  };
  const createObjectURL = (blob) => {
    check();
    const url = URL.createObjectURL(blob);
    urls.add(url);
    return url;
  };
  const revokeObjectURL = (url) => { urls.delete(url); URL.revokeObjectURL(url); };
  const requestAnimationFrame = (fn) => {
    if (isDisposed()) return () => {};
    const id = globalThis.requestAnimationFrame((time) => { stop(); safe(fn)(time); });
    const stop = effects.add(() => globalThis.cancelAnimationFrame(id));
    return stop;
  };
  releaseParent = ctx.effects.add(dispose);
  if (ctx.signal.aborted) dispose();
  return {
    effects, dispose, isDisposed, guard, listen, unlisten, createObjectURL, revokeObjectURL,
    release: (fn) => { try { return fn(); } catch (error) { report(error); } },
    requestAnimationFrame,
    queueMicrotask: (fn) => globalThis.queueMicrotask(safe(fn)),
    setTimeout: (fn, ms) => effects.timeout(safe(fn), ms),
    clearTimeout: (stop) => stop?.(),
    setInterval: (fn, ms) => effects.interval(safe(fn), ms),
    clearInterval: (stop) => stop?.(),
    requestRpc,
    rpc: (method, params, options) => requestRpc(method, params, options).promise,
    cancelRpc: (id) => { try { if (id) ctx.rpc.cancel(id); } catch (error) { report(error); } },
    pendingRpcCount: () => pending,
  };
}
