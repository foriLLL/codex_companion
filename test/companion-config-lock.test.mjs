import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CompanionConfig } from "../src/companion-config.mjs";
import { assertMode } from "./helpers/permissions.mjs";

const moduleUrl = new URL("../src/companion-config.mjs", import.meta.url).href;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "companion-lock-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, path: join(dir, "config.json") };
}

function childScript(t, source) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  let output = "";
  child.stderr.on("data", bytes => { output += bytes; });
  const completed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, output }));
  });
  return { child, completed };
}

async function deadWriter(t, path) {
  const process = childScript(t, `
    import { CompanionConfig } from ${JSON.stringify(moduleUrl)};
    await new CompanionConfig({ path: ${JSON.stringify(path)} }).withLock(async () => {
      console.log("locked");
      await new Promise(() => { setInterval(() => {}, 1000); });
    });
  `);
  await once(process.child.stdout, "data");
  process.child.kill("SIGKILL");
  assert.equal((await process.completed).signal, "SIGKILL");
  return process.child.pid;
}

test("配置锁：真实写入进程异常退出后恢复，锁发布完整且权限为0600", { timeout: 10_000 }, async t => {
  const { path } = await fixture(t);
  const pid = await deadWriter(t, path);
  assert.deepEqual(JSON.parse(await readFile(`${path}.lock`, "utf8")), { pid });
  const store = new CompanionConfig({ path });
  await store.withLock(async () => {
    assert.deepEqual(JSON.parse(await readFile(`${path}.lock`, "utf8")), { pid: process.pid });
    assertMode(await stat(`${path}.lock`), 0o600);
    await writeFile(path, "recovered");
  });
  assert.equal(await readFile(path, "utf8"), "recovered");
  await assert.rejects(stat(`${path}.lock`), { code: "ENOENT" });
  await assert.rejects(stat(`${path}.lock.recovery`), { code: "ENOENT" }, "回收完成后不保留 guard");
});

test("配置锁：活 PID（包括 PID 重用）、空锁和未知归属均失败关闭", async t => {
  const { dir } = await fixture(t);
  const contents = [JSON.stringify({ pid: process.pid }), "", "occupied", "null", JSON.stringify({ pid: 0 }), JSON.stringify({ pid: 0x80000000 })];
  for (const [index, content] of contents.entries()) {
    const path = join(dir, `${index}.json`);
    await writeFile(`${path}.lock`, content, { mode: 0o600 });
    const store = new CompanionConfig({ path, lockTimeoutMs: 20 });
    await assert.rejects(store.withLock(() => assert.fail("不得进入活跃或归属不明的临界区")), { code: "CONFIG_LOCKED" });
    assert.equal(await readFile(`${path}.lock`, "utf8"), content);
  }
  assert.deepEqual((await readdir(dir)).filter(name => name.endsWith(".tmp")), []);
});

test("配置锁：多个进程同时回收死锁并连续写入，临界区不重叠", { timeout: 15_000 }, async t => {
  const { path, dir } = await fixture(t);
  await deadWriter(t, path);
  await writeFile(path, "0");
  const marker = join(dir, "critical-section");
  const writers = Array.from({ length: 8 }, () => childScript(t, `
    import { CompanionConfig } from ${JSON.stringify(moduleUrl)};
    import { open, readFile, writeFile, unlink } from "node:fs/promises";
    const store = new CompanionConfig({ path: ${JSON.stringify(path)}, lockTimeoutMs: 10_000 });
    for (let attempt = 0; attempt < 3; attempt++) await store.withLock(async () => {
      const marker = await open(${JSON.stringify(marker)}, "wx");
      try {
        const count = Number(await readFile(store.path, "utf8"));
        await new Promise(resolve => setTimeout(resolve, 5));
        await writeFile(store.path, String(count + 1));
      } finally { await marker.close(); await unlink(${JSON.stringify(marker)}); }
    });
  `));
  for (const result of await Promise.all(writers.map(writer => writer.completed))) assert.equal(result.code, 0, result.output);
  assert.equal(await readFile(path, "utf8"), "24");
  assert.deepEqual((await readdir(dir)).filter(name => name.endsWith(".lock") || name.endsWith(".tmp")), []);
});

test("配置锁：正在回收的进程挡住其它回收者，崩溃后其 guard 可被回收", { timeout: 10_000 }, async t => {
  const { path } = await fixture(t);
  await deadWriter(t, path);
  const guardPath = `${path}.lock.recovery`;
  const holder = childScript(t, `
    import { open } from "node:fs/promises";
    const file = await open(${JSON.stringify(guardPath)}, "wx", 0o600);
    await file.writeFile(JSON.stringify({ pid: process.pid }));
    await file.sync();
    console.log("locked");
    setInterval(() => {}, 1000);
  `);
  await once(holder.child.stdout, "data");
  const blocked = new CompanionConfig({ path, lockTimeoutMs: 40 });
  await assert.rejects(blocked.withLock(() => assert.fail("不得越过正在回收的进程")), { code: "CONFIG_LOCKED" });
  holder.child.kill("SIGKILL");
  await holder.completed;
  const store = new CompanionConfig({ path });
  await store.withLock(() => writeFile(path, "recovered-again"));
  assert.equal(await readFile(path, "utf8"), "recovered-again");
  await assert.rejects(stat(guardPath), { code: "ENOENT" });
});

test("配置锁：写入 PID 前崩溃留下的空 guard 超过宽限期后回收", { timeout: 10_000 }, async t => {
  const { path } = await fixture(t);
  await deadWriter(t, path);
  const guardPath = `${path}.lock.recovery`;
  await writeFile(guardPath, "", { mode: 0o600 });
  const blocked = new CompanionConfig({ path, lockTimeoutMs: 40 });
  await assert.rejects(blocked.withLock(() => assert.fail("宽限期内不得越过空 guard")), { code: "CONFIG_LOCKED" });
  const old = new Date(Date.now() - 60_000);
  await utimes(guardPath, old, old);
  const store = new CompanionConfig({ path });
  await store.withLock(() => writeFile(path, "recovered-empty-guard"));
  assert.equal(await readFile(path, "utf8"), "recovered-empty-guard");
});

test("配置锁：临界区异常会释放锁和候选文件", async t => {
  const { path, dir } = await fixture(t);
  const store = new CompanionConfig({ path });
  await assert.rejects(store.withLock(async () => { await delay(1); throw new Error("operation-failed"); }), /operation-failed/);
  assert.deepEqual(await readdir(dir), []);
  assert.equal(await store.withLock(async () => "next-writer"), "next-writer");
});
