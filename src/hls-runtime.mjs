import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

export const HLS_RUNTIME_VERSION = "1.6.16";

const require = createRequire(import.meta.url);

function defaultResolve(specifier) {
  return require.resolve(specifier);
}

/**
 * 尝试加载编译期嵌入的 hls.js（bun --compile 单文件产物走这条路）。
 * 开发/测试态该生成文件不存在时返回 null，交由磁盘读取回退。
 * 仅「模块不存在」静默回退；其它错误（生成文件损坏/求值异常）向上抛，
 * 避免在编译产物里把真实故障误报成「版本不匹配」。
 */
async function loadEmbeddedSource() {
  try {
    const module = await import("./hls-embedded.generated.mjs");
    if (typeof module.HLS_EMBEDDED_SOURCE === "string" && module.HLS_EMBEDDED_SOURCE.trim() !== "") {
      return { version: module.HLS_EMBEDDED_VERSION, bundleSource: module.HLS_EMBEDDED_SOURCE };
    }
    return null;
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND" || error?.code === "MODULE_NOT_FOUND") {
      return null;
    }
    throw error;
  }
}

async function loadDiskSource(readFileImpl, resolveImpl) {
  const packagePath = resolveImpl("hls.js/package.json");
  const bundlePath = resolveImpl("hls.js/dist/hls.min.js");
  const [packageJson, bundleSource] = await Promise.all([
    readFileImpl(packagePath, "utf8"),
    readFileImpl(bundlePath, "utf8")
  ]);
  let version;
  try {
    version = JSON.parse(packageJson).version;
  } catch (cause) {
    throw new Error("无法解析本地 hls.js package.json", { cause });
  }
  return { version, bundleSource };
}

/**
 * 读取固定版本的浏览器 UMD bundle，并追加一个 renderer 内的版本断言。
 * 这里不 import hls.js：Node 只负责把源码交给 CDP，renderer 才真正执行它。
 *
 * 来源优先级：
 *   1. 编译期嵌入的 hls-embedded.generated.mjs（bun --compile 产物）；
 *   2. 从 node_modules 磁盘读取（开发态、可被 readFileImpl/resolveImpl 注入测试）。
 * 显式传入 readFileImpl 或 resolveImpl 时强制走磁盘分支，保证测试可控。
 */
export async function loadHlsRuntimeSource({
  readFileImpl,
  resolveImpl
} = {}) {
  const forceDisk = readFileImpl !== undefined || resolveImpl !== undefined;
  const loaded = forceDisk
    ? await loadDiskSource(readFileImpl ?? readFile, resolveImpl ?? defaultResolve)
    : (await loadEmbeddedSource()) ?? await loadDiskSource(readFile, defaultResolve);

  const { version: installedVersion, bundleSource } = loaded;

  if (installedVersion !== HLS_RUNTIME_VERSION) {
    throw new Error(
      `hls.js 版本不匹配：需要 ${HLS_RUNTIME_VERSION}，实际为 ${installedVersion || "未知"}`
    );
  }
  if (typeof bundleSource !== "string" || bundleSource.trim() === "") {
    throw new Error("本地 hls.js 浏览器 bundle 为空");
  }

  return [
    `/* codex-companion embedded hls.js ${HLS_RUNTIME_VERSION} */`,
    bundleSource,
    `if (globalThis.Hls?.version !== ${JSON.stringify(HLS_RUNTIME_VERSION)}) {`,
    `  throw new Error("hls.js ${HLS_RUNTIME_VERSION} 未正确加载");`,
    "}",
    "//# sourceURL=codex-companion-hls-runtime.js"
  ].join("\n");
}
