import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs } from "../src/cli.mjs";

test("launch 默认使用随机端口并保持常驻", () => {
  const options = parseArgs([]);
  assert.equal(options.command, "launch");
  assert.equal(options.port, null);
  assert.equal(options.once, false);
});

test("attach 允许省略 --port（改由运行时状态文件解析），inject 仍必须显式指定", () => {
  assert.equal(parseArgs(["attach"]).port, null);
  assert.equal(parseArgs(["attach", "--port", "12345"]).port, 12345);
  assert.throws(() => parseArgs(["inject"]), /必须提供 --port/);
  assert.throws(() => parseArgs(["unmount"]), /必须提供 --port/);
});
