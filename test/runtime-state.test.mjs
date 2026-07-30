import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RuntimeState, normalizeRuntimeState } from "../src/runtime-state.mjs";

async function withTempDir(run) {
  const dir = await mkdtemp(join(tmpdir(), "runtime-state-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("normalizeRuntimeState 丢弃无效端口", () => {
  assert.equal(normalizeRuntimeState({ port: 0 }), null);
  assert.equal(normalizeRuntimeState({ port: 70_000 }), null);
  assert.equal(normalizeRuntimeState(null), null);
  assert.deepEqual(normalizeRuntimeState({ port: 5000, codexPid: -1, daemonPid: 3, startedAt: "x" }), {
    port: 5000,
    codexPid: null,
    daemonPid: 3,
    startedAt: null
  });
});

test("save 写入 0600 并可 load 回读", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "runtime.json");
    const state = new RuntimeState({ path });
    await state.save({ port: 51234, codexPid: 42, daemonPid: 7, startedAt: 1000 });

    const info = await stat(path);
    assert.equal(info.mode & 0o777, 0o600);

    const loaded = await state.load();
    assert.deepEqual(loaded, { port: 51234, codexPid: 42, daemonPid: 7, startedAt: 1000 });
  });
});

test("load 缺失文件返回 null，损坏内容返回 null", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "runtime.json");
    const state = new RuntimeState({ path });
    assert.equal(await state.load(), null);

    await state.save({ port: 6000 });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, "{ not json", "utf8");
    assert.equal(await state.load(), null);
  });
});

test("save 无有效端口时抛错", async () => {
  await withTempDir(async (dir) => {
    const state = new RuntimeState({ path: join(dir, "runtime.json") });
    await assert.rejects(state.save({ port: 0 }), /缺少有效端口/);
  });
});

test("clear 幂等删除", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "runtime.json");
    const state = new RuntimeState({ path });
    await state.save({ port: 6000 });
    await state.clear();
    await state.clear();
    assert.equal(await state.load(), null);
  });
});

test("pidIsAlive：存活/不存在/无权限的判定", async () => {
  const { pidIsAlive } = await import("../src/runtime-state.mjs");
  assert.equal(pidIsAlive(0), false);
  assert.equal(pidIsAlive(-1), false);
  assert.equal(pidIsAlive(1234, () => {}), true); // kill 成功 = 存活
  assert.equal(pidIsAlive(1234, () => { const e = new Error("no"); e.code = "ESRCH"; throw e; }), false);
  assert.equal(pidIsAlive(1234, () => { const e = new Error("perm"); e.code = "EPERM"; throw e; }), true);
});
