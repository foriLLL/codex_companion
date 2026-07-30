import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const OUTPUT = join(here, "..", "src", "hls-embedded.generated.mjs");

/**
 * 生成编译期嵌入的 hls.js 模块。
 *
 * `bun build --compile` 后运行时无法 `require.resolve("hls.js/...")`（模块被打进
 * 只读的 `/$bunfs/root/`），因此改为在构建前把浏览器 UMD bundle 内联成一个普通
 * ES 模块。该文件由本脚本生成、被 gitignore，开发态可缺失（loadHlsRuntimeSource
 * 会回退到磁盘读取）。
 */
async function main() {
  const packagePath = require.resolve("hls.js/package.json");
  const bundlePath = require.resolve("hls.js/dist/hls.min.js");
  const [packageJson, bundleSource] = await Promise.all([
    readFile(packagePath, "utf8"),
    readFile(bundlePath, "utf8")
  ]);
  const version = JSON.parse(packageJson).version;
  if (typeof bundleSource !== "string" || bundleSource.trim() === "") {
    throw new Error("hls.js 浏览器 bundle 为空，无法嵌入");
  }

  const contents = [
    "// 本文件由 scripts/generate-hls-embed.mjs 生成，请勿手动编辑。",
    "// 它把锁定版本的 hls.js 浏览器 bundle 内联，供 bun --compile 单文件产物使用。",
    `export const HLS_EMBEDDED_VERSION = ${JSON.stringify(version)};`,
    `export const HLS_EMBEDDED_SOURCE = ${JSON.stringify(bundleSource)};`,
    ""
  ].join("\n");

  await writeFile(OUTPUT, contents, "utf8");
  console.log(`[generate-hls-embed] 已生成 ${OUTPUT}（hls.js ${version}，${bundleSource.length} 字节）`);
}

main().catch((error) => {
  console.error(`[generate-hls-embed] 失败：${error.message}`);
  process.exitCode = 1;
});
