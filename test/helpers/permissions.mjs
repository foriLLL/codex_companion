import assert from "node:assert/strict";

// Windows 没有 POSIX 权限位（stat 只反映只读属性），只在类 Unix 系统上校验。
export function assertMode(stats, mode) {
  if (process.platform !== "win32") assert.equal(stats.mode & 0o777, mode);
}
