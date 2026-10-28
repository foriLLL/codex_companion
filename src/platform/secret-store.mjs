import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { replaceFile } from "./replace-file.mjs";

const execFileAsync = promisify(execFile);

// 按平台选择系统凭证存储。所有后端都只接收 (service, account) 定位一条密文，
// 明文 secret 只经 stdin 传给子进程（macOS security 例外，见下）。
// - macOS：钥匙串（/usr/bin/security）
// - Windows：DPAPI（当前用户范围）加密后写入数据目录，密钥由系统托管
// - Linux：libsecret（secret-tool）；没有可用密钥环（无 D-Bus 会话、未安装）时
//   回退到数据目录下权限 0600 的本机文件，与 gh/docker 等 CLI 的做法一致
export class SecretStoreError extends Error {
  constructor(code, message, { cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "SecretStoreError";
    this.code = code;
  }
}

function runWithInput(command, args, input, { spawnImpl = spawn, timeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    timer.unref?.();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(Object.assign(new Error(stderr.trim() || `${command} 退出码 ${code}`), { code, stdout, stderr }));
    });
    child.stdin.end(input ?? "");
  });
}

function entryName(service, account) {
  return createHash("sha256").update(`${service}\0${account}`).digest("hex").slice(0, 32);
}

async function writePrivateFile(path, contents) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
    await replaceFile(temporary, path);
    await chmod(path, 0o600);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

async function readOptional(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function unlinkOptional(path) {
  try {
    await unlink(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function macosKeychain({ execFileImpl }) {
  const missing = (cause) => cause?.code === 44 || /could not be found|not found/i.test(cause?.stderr ?? "");
  return {
    kind: "keychain",
    label: "macOS 钥匙串",
    async read(service, account) {
      try {
        const { stdout } = await execFileImpl("/usr/bin/security", ["find-generic-password", "-s", service, "-a", account, "-w"]);
        return String(stdout ?? "").replace(/[\r\n]+$/, "") || null;
      } catch (cause) {
        if (missing(cause)) return null;
        throw cause;
      }
    },
    async write(service, account, secret) {
      // security 不支持从 stdin 读取口令；-w 参数只在本机短暂可见，且仅当前用户进程可读。
      await execFileImpl("/usr/bin/security", ["add-generic-password", "-U", "-s", service, "-a", account, "-w", secret]);
    },
    async delete(service, account) {
      try {
        await execFileImpl("/usr/bin/security", ["delete-generic-password", "-s", service, "-a", account]);
        return true;
      } catch (cause) {
        if (missing(cause)) return false;
        throw cause;
      }
    }
  };
}

const DPAPI_SCRIPT = (operation) => [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -AssemblyName System.Security",
  "$text = [Console]::In.ReadToEnd()",
  "$scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser",
  operation === "protect"
    ? "$bytes = [System.Text.Encoding]::UTF8.GetBytes($text); [Console]::Out.Write([Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, $scope)))"
    : "$bytes = [System.Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($text.Trim()), $null, $scope); [Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($bytes))"
].join("; ");

function windowsDpapi({ dataDir, runImpl, environment }) {
  const powershell = join(environment.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const run = (operation, input) => runImpl(powershell, ["-NoProfile", "-NonInteractive", "-Command", DPAPI_SCRIPT(operation)], input);
  const pathFor = (service, account) => join(dataDir, "credentials", `${entryName(service, account)}.dpapi`);
  return {
    kind: "dpapi",
    label: "Windows 数据保护（DPAPI）",
    async read(service, account) {
      const sealed = await readOptional(pathFor(service, account));
      if (!sealed) return null;
      const { stdout } = await run("unprotect", sealed);
      return stdout || null;
    },
    async write(service, account, secret) {
      const { stdout } = await run("protect", secret);
      if (!stdout.trim()) throw new Error("DPAPI 没有返回密文");
      await writePrivateFile(pathFor(service, account), stdout.trim());
    },
    delete: (service, account) => unlinkOptional(pathFor(service, account))
  };
}

function plaintextFile({ dataDir }) {
  const path = join(dataDir, "credentials.json");
  const load = async () => {
    const contents = await readOptional(path);
    if (!contents) return {};
    const parsed = JSON.parse(contents);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  };
  return {
    kind: "file",
    label: "本机凭证文件",
    path,
    async read(service, account) {
      const value = (await load())[entryName(service, account)];
      return typeof value === "string" && value ? value : null;
    },
    async write(service, account, secret) {
      const entries = await load();
      entries[entryName(service, account)] = secret;
      await writePrivateFile(path, `${JSON.stringify(entries, null, 2)}\n`);
    },
    async delete(service, account) {
      const entries = await load();
      const key = entryName(service, account);
      if (!Object.hasOwn(entries, key)) return false;
      delete entries[key];
      if (Object.keys(entries).length) await writePrivateFile(path, `${JSON.stringify(entries, null, 2)}\n`);
      else await unlinkOptional(path);
      return true;
    }
  };
}

// secret-tool 不可用（未安装 / 没有 Secret Service）时回退文件，并记住回退结果，
// 避免每次读写都等一次 D-Bus 超时。读取时两处都查，兼容密钥环后来才可用的情况。
function linuxSecretService({ dataDir, runImpl }) {
  const fallback = plaintextFile({ dataDir });
  let available = null;
  const attributes = (service, account) => ["service", service, "account", account];
  const unavailable = (error) => error?.code === "ENOENT"
    || /dbus|secret service|org\.freedesktop|no such interface|cannot autolaunch|not provided by any/i.test(`${error?.stderr ?? ""} ${error?.message ?? ""}`);
  const attempt = async (operation) => {
    if (available === false) return { ok: false };
    try {
      const value = await operation();
      available = true;
      return { ok: true, value };
    } catch (error) {
      if (!unavailable(error)) throw error;
      available = false;
      return { ok: false };
    }
  };
  const store = {
    kind: "secret-service",
    label: "系统密钥环（Secret Service）",
    async read(service, account) {
      const result = await attempt(async () => {
        try {
          const { stdout } = await runImpl("secret-tool", ["lookup", ...attributes(service, account)], "");
          return stdout.replace(/[\r\n]+$/, "") || null;
        } catch (error) {
          // lookup 未找到时以退出码 1 且无输出结束。
          if (error?.code === 1 && !String(error.stderr ?? "").trim()) return null;
          throw error;
        }
      });
      if (result.ok && result.value) return result.value;
      return fallback.read(service, account);
    },
    async write(service, account, secret) {
      const result = await attempt(() => runImpl("secret-tool", ["store", "--label", `Codex Companion (${service})`, ...attributes(service, account)], secret));
      if (!result.ok) {
        store.kind = fallback.kind;
        store.label = fallback.label;
        await fallback.write(service, account, secret);
        return;
      }
      await fallback.delete(service, account);
    },
    async delete(service, account) {
      let deleted = false;
      const result = await attempt(async () => {
        await runImpl("secret-tool", ["clear", ...attributes(service, account)], "");
        return true;
      });
      if (result.ok) deleted = true;
      return (await fallback.delete(service, account)) || deleted;
    }
  };
  return store;
}

export function createSecretStore({
  platform = process.platform,
  dataDir,
  execFileImpl = execFileAsync,
  runImpl = (command, args, input) => runWithInput(command, args, input),
  environment = process.env
} = {}) {
  if (platform === "darwin") return macosKeychain({ execFileImpl });
  if (!dataDir) throw new TypeError("非 macOS 平台的凭证存储需要 dataDir");
  if (platform === "win32") return windowsDpapi({ dataDir, runImpl, environment });
  return linuxSecretService({ dataDir, runImpl });
}
