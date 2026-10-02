// 浏览器安全的副作用跟踪器：统一登记清理，并在释放或中止时执行。
export function createEffects({ signal, onError, cleanupTimeoutMs = 1000 } = {}) {
  const buckets = {
    cleanups: new Set(),
    listeners: new Set(),
    timeouts: new Set(),
    intervals: new Set(),
    observers: new Set(),
    objectUrls: new Set(),
  };
  let disposed = false;
  let suspended = false;
  let disposing = null;
  let onAbort = null;

  function isPromise(value) {
    return value != null && typeof value.then === "function";
  }

  // 把同步抛错和被拒绝的 Promise 交给 onError，避免打断调用方。
  function report(error) {
    if (typeof onError !== "function") return;
    try {
      const result = onError(error);
      // onError 自己返回的拒绝也要接住，避免变成未处理拒绝。
      if (isPromise(result)) result.catch(() => {});
    } catch {
      // 错误回调自身失败时吞掉，避免清理链中断。
    }
  }

  function runNow(run) {
    try {
      const result = run();
      if (isPromise(result)) result.catch(report);
    } catch (error) {
      report(error);
    }
  }

  function guard(fn) {
    return function wrapped(...args) {
      // 释放之后，已排队的事件和定时器回调直接丢掉。
      if (disposed) return;
      try {
        const result = fn.apply(this, args);
        // 异步回调的拒绝要在这里消化，避免事件目标再次抛出。
        if (isPromise(result)) {
          result.catch(report);
          return undefined;
        }
        return result;
      } catch (error) {
        report(error);
      }
    };
  }

  function bind(bucket, run) {
    // 释放之后才登记的清理必须立刻执行。
    if (disposed) {
      runNow(run);
      return () => {};
    }
    const entry = { done: false, run };
    bucket.add(entry);
    return function unregister() {
      if (entry.done) return;
      entry.done = true;
      bucket.delete(entry);
      runNow(run);
    };
  }

  function add(cleanup) {
    return bind(buckets.cleanups, cleanup);
  }

  function listen(target, event, fn, options) {
    if (disposed) return () => {};
    const wrapped = guard(fn);
    target.addEventListener(event, wrapped, options);
    return bind(buckets.listeners, () => {
      target.removeEventListener(event, wrapped, options);
    });
  }

  function timeout(fn, ms) {
    if (disposed) return () => {};
    const wrapped = guard(fn);
    const entry = {
      done: false,
      id: null,
      token: 0,
      remaining: Math.max(0, Number(ms) || 0),
      deadline: 0,
      run() {
        entry.token += 1;
        clearTimeout(entry.id);
        entry.id = null;
      },
      pause() {
        if (entry.id === null) return;
        entry.remaining = Math.max(0, entry.deadline - performance.now());
        entry.run();
      },
      resume() {
        if (disposed || suspended || entry.done || entry.id !== null) return;
        const token = ++entry.token;
        entry.deadline = performance.now() + entry.remaining;
        entry.id = setTimeout(() => {
          // 旧原生回调即使已排队，也不能在恢复后抢先执行。
          if (disposed || suspended || entry.done || token !== entry.token) return;
          entry.id = null;
          entry.done = true;
          buckets.timeouts.delete(entry);
          wrapped();
        }, entry.remaining);
      },
    };
    buckets.timeouts.add(entry);
    entry.resume();
    return function unregister() {
      if (entry.done) return;
      entry.done = true;
      buckets.timeouts.delete(entry);
      entry.run();
    };
  }

  function interval(fn, ms) {
    if (disposed) return () => {};
    const wrapped = guard(fn);
    const entry = {
      done: false,
      id: null,
      token: 0,
      run() {
        entry.token += 1;
        clearInterval(entry.id);
        entry.id = null;
      },
      pause() { entry.run(); },
      resume() {
        if (disposed || suspended || entry.done || entry.id !== null) return;
        const token = ++entry.token;
        // 恢复从完整周期开始，不补发隐藏期间错过的 tick。
        entry.id = setInterval(() => {
          if (disposed || suspended || entry.done || token !== entry.token) return;
          wrapped();
        }, ms);
      },
    };
    buckets.intervals.add(entry);
    entry.resume();
    return function unregister() {
      if (entry.done) return;
      entry.done = true;
      buckets.intervals.delete(entry);
      entry.run();
    };
  }

  function setSuspended(value) {
    if (disposed || suspended === Boolean(value)) return;
    suspended = Boolean(value);
    for (const bucket of [buckets.timeouts, buckets.intervals]) {
      for (const entry of bucket) {
        if (suspended) entry.pause();
        else entry.resume();
      }
    }
  }

  function observe(observer) {
    return bind(buckets.observers, () => observer.disconnect());
  }

  function objectUrl(url) {
    return bind(buckets.objectUrls, () => URL.revokeObjectURL(url));
  }

  // 异步清理超过时限就放弃等待，并让后续清理继续。
  async function settle(result) {
    if (!isPromise(result)) return;
    let timer;
    try {
      await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("清理超时")), cleanupTimeoutMs);
        result.then(
          () => resolve(),
          (error) => reject(error)
        );
      });
    } finally {
      clearTimeout(timer);
    }
  }

  // 先同步停用全部资源，再并行等待异步清理；每条清理单独计时。
  function dispose() {
    if (disposing) return disposing;
    disposed = true;
    let finish = () => {};
    disposing = new Promise((resolve) => {
      finish = resolve;
    });
    const pending = [];
    try {
      // 手动释放后不再听中止，避免信号稍后触发第二次清理。
      const abortHandler = onAbort;
      onAbort = null;
      if (abortHandler && signal && typeof signal.removeEventListener === "function") {
        signal.removeEventListener("abort", abortHandler);
      }
      const jobs = [];
      for (const bucket of Object.values(buckets)) {
        for (const entry of bucket) jobs.push(entry);
        bucket.clear();
      }
      for (const entry of jobs) {
        if (entry.done) continue;
        entry.done = true;
        try {
          const result = entry.run();
          if (isPromise(result)) pending.push(result);
        } catch (error) {
          // 单条清理失败后继续，保证其余副作用仍被释放。
          report(error);
        }
      }
    } catch (error) {
      report(error);
    }
    Promise.all(
      pending.map((result) =>
        settle(result).catch((error) => {
          report(error);
        })
      )
    ).then(finish, finish);
    return disposing;
  }

  // 信号无论是否已经中止，都要安全地触发释放。
  if (signal) {
    if (signal.aborted) {
      dispose();
    } else if (typeof signal.addEventListener === "function") {
      onAbort = () => dispose();
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  function diagnostics() {
    const counts = {};
    let active = 0;
    for (const [name, bucket] of Object.entries(buckets)) {
      counts[name] = bucket.size;
      active += bucket.size;
    }
    counts.active = active;
    counts.disposed = disposed;
    counts.suspended = suspended;
    return counts;
  }

  return {
    add,
    listen,
    timeout,
    interval,
    setSuspended,
    observe,
    objectUrl,
    dispose,
    diagnostics,
  };
}
