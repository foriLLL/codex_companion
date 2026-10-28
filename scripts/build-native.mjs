import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const targets = { "darwin-arm64": "arm64-apple-macos13", "darwin-x64": "x86_64-apple-macos13" };

// 冒烟把输出放到临时目录；打包默认使用契约规定的位置。
export async function buildNative({ target = `darwin-${process.arch}`, outputPath, execFileImpl = execFile } = {}) {
  if (!targets[target]) throw new Error(`不支持的 target：${target}`);
  const output = outputPath ?? join(repoRoot, "dist", "native", target, "companion-native");
  await mkdir(dirname(output), { recursive: true });
  await promisify(execFileImpl)("swiftc", [
    "-O", "-target", targets[target], "-framework", "AppKit", "-framework", "ApplicationServices",
    join(repoRoot, "packaging/mac-app/Native/NativeGuards.swift"),
    join(repoRoot, "packaging/mac-app/Native/main.swift"), "-o", output
  ], { timeout: 120_000, maxBuffer: 1024 * 1024 });
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  Promise.resolve().then(() => {
    if (args.length !== 0 && (args.length !== 2 || args[0] !== "--target")) {
      throw new Error("用法：node scripts/build-native.mjs [--target darwin-arm64|darwin-x64]");
    }
    return buildNative({ target: args[1] });
  }).then((output) => console.log(`[build-native] ${output}`)).catch((error) => {
    console.error(`[build-native] ${error.message}`);
    process.exitCode = 1;
  });
}
