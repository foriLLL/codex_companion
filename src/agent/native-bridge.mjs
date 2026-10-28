import { execFile, spawn } from "node:child_process";
import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const maxOutputBytes = 1024 * 1024;

export function resolveNativeHelperPath({
  env = process.env, execPath = process.execPath, cwd = process.cwd(), arch = process.arch
} = {}) {
  const override = env.CODEX_COMPANION_NATIVE_HELPER;
  const candidates = [
    typeof override === "string" && override.trim() ? resolve(cwd, override) : null,
    resolve(dirname(execPath), "../Helpers/companion-native"),
    ["arm64", "x64"].includes(arch) ? join(cwd, "dist", "native", `darwin-${arch}`, "companion-native") : null
  ];
  return candidates.find((candidate) => {
    try { return candidate !== null && statSync(candidate).isFile(); }
    catch { return false; }
  }) ?? null;
}

function failure(code, message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}

function validSnapshot(value) {
  const integer = (number) => Number.isSafeInteger(number) && number >= 0;
  return Array.isArray(value.apps) && value.apps.every((app) => app && integer(app.pid) && app.pid > 0
    && integer(app.launchedAt) && app.key === `${app.pid}:${app.launchedAt}`
    && typeof app.finishedLaunching === "boolean"
    && (app.arguments === null || (Array.isArray(app.arguments) && app.arguments.every((arg) => typeof arg === "string"))))
    && integer(value.frontmostPid) && typeof value.inputStamp === "string" && /^\d+(?::\d+){4}$/.test(value.inputStamp)
    && Number.isFinite(value.inputIdleMs) && value.inputIdleMs >= 0 && integer(value.now);
}

function parseResponse(action, text) {
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid-object");
    let valid;
    if (action === "snapshot" || action === "watch") valid = validSnapshot(value);
    else if (action === "show") valid = typeof value.shown === "boolean";
    else {
      const flag = action === "quit" ? value.accepted : value.launched;
      valid = typeof flag === "boolean" && (flag || typeof value.reason === "string");
      if (action === "launch" && flag) valid &&= Number.isSafeInteger(value.pid) && value.pid > 0
        && typeof value.key === "string" && new RegExp(`^${value.pid}:\\d+$`).test(value.key);
      if (action === "launch") valid &&= ["finishedLaunching", "hidden"]
        .every((key) => !Object.hasOwn(value, key) || typeof value[key] === "boolean");
    }
    if (!valid) throw new Error("invalid-shape");
    return value;
  } catch (cause) {
    throw failure("NATIVE_PROTOCOL", `原生助手 ${action} 返回了无效 JSON 协议`, cause);
  }
}

function appendOptional(args, entries) {
  for (const [flag, value] of entries) if (value !== undefined) args.push(flag, String(value));
  return args;
}

// execFileImpl 与仓库其他包装器一致，使用 Promise<{stdout, stderr}>；spawnImpl 使用 Node ChildProcess 接口。
export function createNativeBridge({
  helperPath, appPath, execFileImpl = execFileAsync, spawnImpl = spawn, timeoutMs = 35_000
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError("timeoutMs 必须为正数");
  const commandArgs = (action, args = []) => [action, "--app", appPath, ...args];
  const requirePaths = () => {
    if (typeof helperPath !== "string" || !helperPath || typeof appPath !== "string" || !appPath) {
      throw failure("NATIVE_FAILED", "缺少原生助手或目标应用路径");
    }
  };

  async function request(action, args = []) {
    requirePaths();
    let timer;
    let timedOut = false;
    try {
      const pending = execFileImpl(helperPath, commandArgs(action, args), {
        encoding: "utf8", timeout: timeoutMs, killSignal: "SIGTERM", maxBuffer: maxOutputBytes
      });
      const { stdout } = await Promise.race([
        pending,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            pending?.child?.kill("SIGTERM");
            reject(failure("NATIVE_TIMEOUT", `原生助手 ${action} 超时`));
          }, timeoutMs);
        })
      ]);
      const output = String(stdout ?? "").trim();
      if (output.includes("\n") || Buffer.byteLength(output) > maxOutputBytes) {
        throw failure("NATIVE_PROTOCOL", `原生助手 ${action} 必须输出单行 JSON`);
      }
      return parseResponse(action, output);
    } catch (cause) {
      if (["NATIVE_TIMEOUT", "NATIVE_PROTOCOL"].includes(cause?.code)) throw cause;
      const timeout = timedOut || cause?.code === "ETIMEDOUT" || (cause?.killed && cause?.signal === "SIGTERM");
      throw failure(timeout ? "NATIVE_TIMEOUT" : "NATIVE_FAILED", `原生助手 ${action} ${timeout ? "超时" : "执行失败"}`, cause);
    } finally {
      clearTimeout(timer);
    }
  }

  function watch({ onSnapshot = () => {}, onExit = () => {} } = {}) {
    let child;
    let buffer = "";
    let finished = false;
    let timer;
    const decoder = new StringDecoder("utf8");
    const stopChild = () => {
      child?.stdin?.end();
      child?.kill("SIGTERM");
    };
    const finish = (error, { stop = false, notify = true } = {}) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (stop) stopChild();
      if (notify) onExit(error);
    };
    const resetTimeout = () => {
      clearTimeout(timer);
      timer = setTimeout(() => finish(failure("NATIVE_TIMEOUT", "原生助手 watch 心跳超时"), { stop: true }), timeoutMs);
    };
    const consume = (chunk) => {
      if (finished) return;
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        let snapshot;
        try {
          if (Buffer.byteLength(line) > maxOutputBytes) throw failure("NATIVE_PROTOCOL", "原生助手 watch 行过长");
          snapshot = parseResponse("watch", line);
        } catch (error) {
          finish(error, { stop: true });
          return;
        }
        resetTimeout();
        onSnapshot(snapshot);
        if (finished) return;
      }
      if (Buffer.byteLength(buffer) > maxOutputBytes) {
        finish(failure("NATIVE_PROTOCOL", "原生助手 watch 行过长"), { stop: true });
      }
    };
    try {
      requirePaths();
      child = spawnImpl(helperPath, commandArgs("watch"), { stdio: ["pipe", "pipe", "pipe"] });
      child.stdout.on("data", (chunk) => consume(typeof chunk === "string" ? chunk : decoder.write(chunk)));
      child.stderr.resume();
      child.stdin.on("error", (cause) => finish(failure("NATIVE_FAILED", "原生助手 watch 输入管道失败", cause), { stop: true }));
      child.stdout.on("error", (cause) => finish(failure("NATIVE_FAILED", "原生助手 watch 输出管道失败", cause), { stop: true }));
      child.stderr.on("error", (cause) => finish(failure("NATIVE_FAILED", "原生助手 watch 错误管道失败", cause), { stop: true }));
      child.on("error", (cause) => finish(failure("NATIVE_FAILED", "原生助手 watch 启动失败", cause), { stop: true }));
      child.on("close", (code, signal) => {
        if (finished) return;
        if (code !== 0 || signal) {
          finish(failure("NATIVE_FAILED", `原生助手 watch 异常退出（${code ?? signal}）`));
          return;
        }
        consume(decoder.end());
        // JSON Lines 必须以换行结束，避免把进程中断产生的半行当成完整快照。
        finish(buffer ? failure("NATIVE_PROTOCOL", "原生助手 watch 输出了未结束的行") : null);
      });
      resetTimeout();
    } catch (cause) {
      queueMicrotask(() => finish(failure("NATIVE_FAILED", "原生助手 watch 启动失败", cause), { stop: true }));
    }
    return { close: () => finish(null, { stop: true, notify: false }) };
  }

  return {
    snapshot: () => request("snapshot"),
    quit: ({ pid, key, mode, inputStamp, maxAgeMs }) => request("quit", appendOptional([
      "--pid", String(pid), "--key", key, "--mode", mode
    ], [["--input-stamp", inputStamp], ["--max-age-ms", maxAgeMs]])),
    launch: ({ args = [], env, unsetEnv, hidden = false, inputStamp, frontmostPid } = {}) => request("launch", appendOptional([
      "--args-json", JSON.stringify(args), ...(hidden ? ["--hidden"] : [])
    ], [["--env-json", env === undefined ? undefined : JSON.stringify(env)],
      ["--unset-env-json", unsetEnv === undefined ? undefined : JSON.stringify(unsetEnv)],
      ["--input-stamp", inputStamp], ["--frontmost-pid", frontmostPid]])),
    show: ({ pid, key, inputStamp, frontmostPid }) => request("show", appendOptional([
      "--pid", String(pid), "--key", key
    ], [["--input-stamp", inputStamp], ["--frontmost-pid", frontmostPid]])),
    watch
  };
}
