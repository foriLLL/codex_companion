import assert from "node:assert/strict";
import test from "node:test";
import { replaceFile } from "../src/platform/replace-file.mjs";

const failing = (codes) => {
  const calls = [];
  return { calls, async renameImpl(from, to) {
    calls.push([from, to]);
    const code = codes.shift();
    if (code) throw Object.assign(new Error(code), { code });
  } };
};

test("Windows 上目标被短暂占用时重试 rename，成功后返回", async () => {
  const fake = failing(["EPERM", "EBUSY", "EACCES"]);
  const delays = [];
  await replaceFile("a.tmp", "a.json", { platform: "win32", renameImpl: fake.renameImpl, sleep: async ms => delays.push(ms) });
  assert.equal(fake.calls.length, 4);
  assert.deepEqual(delays, [20, 40, 60]);
});

test("重试次数用尽后抛出最后的错误", async () => {
  const fake = failing(["EPERM", "EPERM", "EPERM"]);
  await assert.rejects(replaceFile("a", "b", { platform: "win32", renameImpl: fake.renameImpl, attempts: 3, sleep: async () => {} }), { code: "EPERM" });
  assert.equal(fake.calls.length, 3);
});

test("非 Windows 或非占用类错误不重试", async () => {
  for (const [platform, code] of [["linux", "EPERM"], ["darwin", "EBUSY"], ["win32", "ENOENT"]]) {
    const fake = failing([code]);
    await assert.rejects(replaceFile("a", "b", { platform, renameImpl: fake.renameImpl, sleep: async () => { throw new Error("不应等待"); } }), { code });
    assert.equal(fake.calls.length, 1);
  }
});
