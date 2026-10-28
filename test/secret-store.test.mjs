import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSecretStore } from "../src/platform/secret-store.mjs";
import { assertMode } from "./helpers/permissions.mjs";

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), "companion-secret-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("Linux 优先使用 secret-tool，明文只经 stdin 传入", async (t) => {
  const dataDir = await tempDir(t);
  const vault = new Map();
  const calls = [];
  const store = createSecretStore({
    platform: "linux",
    dataDir,
    runImpl: async (command, args, input) => {
      calls.push({ command, args, input });
      const key = args.slice(-4).join("|");
      if (args[0] === "store") { vault.set(key, input); return { stdout: "", stderr: "" }; }
      if (args[0] === "lookup") {
        if (!vault.has(key)) throw Object.assign(new Error("not found"), { code: 1, stderr: "" });
        return { stdout: `${vault.get(key)}\n`, stderr: "" };
      }
      if (args[0] === "clear") { vault.delete(key); return { stdout: "", stderr: "" }; }
      throw new Error(`unexpected ${args[0]}`);
    }
  });
  assert.equal(store.kind, "secret-service");
  assert.equal(await store.read("svc", "acc"), null);
  await store.write("svc", "acc", "s3cret");
  assert.equal(await store.read("svc", "acc"), "s3cret");
  assert.ok(calls.every(({ command, args }) => command === "secret-tool" && !args.includes("s3cret")), "secret 不得出现在命令行参数");
  assert.equal(await store.delete("svc", "acc"), true);
  assert.equal(await store.read("svc", "acc"), null);
  assert.deepEqual(await readdir(dataDir), [], "密钥环可用时不写本机文件");
});

test("Linux 没有 Secret Service 时回退到 0600 文件，并只探测一次", async (t) => {
  const dataDir = await tempDir(t);
  let probes = 0;
  const store = createSecretStore({
    platform: "linux",
    dataDir,
    runImpl: async () => {
      probes += 1;
      throw Object.assign(new Error("Cannot autolaunch D-Bus without X11 $DISPLAY"), { code: 1, stderr: "Cannot autolaunch D-Bus without X11 $DISPLAY" });
    }
  });
  await store.write("svc", "acc", "fallback");
  await store.write("svc", "other", "second");
  assert.equal(await store.read("svc", "acc"), "fallback");
  assert.equal(probes, 1);
  assert.equal(store.kind, "file");
  const file = join(dataDir, "credentials.json");
  assertMode(await stat(file), 0o600);
  assert.doesNotMatch(await readFile(file, "utf8"), /svc|acc/);
  assert.equal(await store.delete("svc", "acc"), true);
  assert.equal(await store.delete("svc", "acc"), false);
  assert.equal(await store.read("svc", "other"), "second");
  assert.equal(await store.delete("svc", "other"), true);
  assert.deepEqual(await readdir(dataDir), [], "最后一条删除后移除凭证文件");
});

test("Linux secret-tool 的其它错误不会静默降级为明文", async (t) => {
  const dataDir = await tempDir(t);
  const store = createSecretStore({
    platform: "linux",
    dataDir,
    runImpl: async () => { throw Object.assign(new Error("prompt dismissed"), { code: 1, stderr: "prompt dismissed" }); }
  });
  await assert.rejects(store.write("svc", "acc", "x"), /prompt dismissed/);
  assert.deepEqual(await readdir(dataDir), []);
});

test("Windows 用 DPAPI 加密后落盘，盘上只有密文", async (t) => {
  const dataDir = await tempDir(t);
  const calls = [];
  // 用可逆变换模拟 DPAPI；真实环境由 PowerShell 调 ProtectedData。
  const seal = (text) => Buffer.from(`sealed:${text}`).toString("base64");
  const unseal = (text) => Buffer.from(text.trim(), "base64").toString().replace(/^sealed:/, "");
  const store = createSecretStore({
    platform: "win32",
    dataDir,
    environment: { SystemRoot: "C:\\Windows" },
    runImpl: async (command, args, input) => {
      calls.push({ command, args, input });
      const script = args.at(-1);
      return { stdout: script.includes("::Protect(") ? seal(input) : unseal(input), stderr: "" };
    }
  });
  assert.equal(store.kind, "dpapi");
  assert.equal(await store.read("svc", "acc"), null);
  await store.write("svc", "acc", "win-token");
  assert.equal(await store.read("svc", "acc"), "win-token");
  const [entry] = await readdir(join(dataDir, "credentials"));
  assert.match(entry, /^[0-9a-f]{32}\.dpapi$/);
  assert.doesNotMatch(await readFile(join(dataDir, "credentials", entry), "utf8"), /win-token/);
  assert.ok(calls.every(({ command, args }) => /powershell\.exe$/i.test(command) && !args.includes("win-token")));
  assert.equal(await store.delete("svc", "acc"), true);
  assert.equal(await store.read("svc", "acc"), null);
});

test("macOS 继续使用钥匙串，不需要数据目录", async () => {
  const store = createSecretStore({ platform: "darwin", execFileImpl: async () => ({ stdout: "token\n" }) });
  assert.equal(store.kind, "keychain");
  assert.equal(await store.read("svc", "acc"), "token");
  assert.throws(() => createSecretStore({ platform: "linux" }), TypeError);
});
