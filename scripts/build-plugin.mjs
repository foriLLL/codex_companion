import { execFile } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { generateCardRegistry } from "./generate-card-registry.mjs";
import { isPathInside } from "../src/platform/paths.mjs";

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// 构建目标沿用 Node 的 `${process.platform}-${process.arch}` 命名。
export const PLUGIN_TARGETS = Object.freeze({
  "darwin-arm64": "bun-darwin-arm64",
  "darwin-x64": "bun-darwin-x64",
  "linux-arm64": "bun-linux-arm64",
  "linux-x64": "bun-linux-x64",
  "win32-arm64": "bun-windows-arm64",
  "win32-x64": "bun-windows-x64"
});

export function backendFileName(target) {
  return target.startsWith("win32-") ? "companion-backend.exe" : "companion-backend";
}

// Codex 以插件目录为 cwd 启动 MCP 后端。相对路径的可执行文件在不同平台上
// 解析基准不一致（父进程 cwd 还是子进程 cwd），因此交给 cwd 内的壳来查找：
// Unix 用 /usr/bin/env，Windows 用 cmd.exe（会优先搜索当前目录）。
export function mcpLaunchConfig(target) {
  const server = target.startsWith("win32-")
    ? { command: "cmd.exe", args: ["/d", "/s", "/c", backendFileName(target)], cwd: "." }
    : { command: "/usr/bin/env", args: [`./${backendFileName(target)}`], cwd: "." };
  return { mcpServers: { companion: server } };
}


// 生成独立的官方插件包：UI 自包含、后端自带运行时，不要求用户再启动 Companion 或安装 Node。
export async function buildPlugin({ outDir = join(root, "dist", "plugin"), target = `${process.platform}-${process.arch}` } = {}) {
  if (!Object.hasOwn(PLUGIN_TARGETS, target)) throw new Error(`不支持的插件构建目标：${target}`);
  outDir = resolve(outDir);
  if (!isPathInside(outDir, join(root, "dist"))) throw new Error("插件输出目录必须位于项目 dist/ 下");
  // 暂存目录与输出目录同盘同文件系统，最后的 rename 才是原子替换；系统临时目录
  // 可能在另一分区或盘符（如 CI 的 /tmp、Windows 的 C: 与 D:），rename 会报 EXDEV。
  await mkdir(dirname(outDir), { recursive: true });
  const work = await mkdtemp(join(dirname(outDir), ".plugin-build-"));
  const staging = join(work, "plugin");
  const bun = join(root, "node_modules", "bun", "bin", "bun.exe");
  try {
    await mkdir(staging);
    await generateCardRegistry({ cardsDir: join(root, "src", "cards"), outDir: join(root, "src"), requireEntries: true });
    const scriptFile = join(work, "ui.js");
    await exec(bun, ["build", join(root, "src", "plugin", "ui.mjs"), "--target=browser", "--format=esm", "--minify", "--outfile", scriptFile], { cwd: root });
    const [template, script] = await Promise.all([
      readFile(join(root, "src", "plugin", "ui.html"), "utf8"), readFile(scriptFile, "utf8")
    ]);
    if (!template.includes("<!-- SCRIPT -->")) throw new Error("插件 HTML 缺少脚本插槽");
    const html = template.replace("<!-- SCRIPT -->", () => `<script type="module">${script.replace(/<\/script/gi, "<\\/script")}</script>`);
    await writeFile(join(staging, "ui.html"), html);
    await cp(join(root, "plugin"), staging, { recursive: true });
    await writeFile(join(staging, ".mcp.json"), `${JSON.stringify(mcpLaunchConfig(target), null, 2)}\n`);
    const backend = join(staging, backendFileName(target));
    await exec(bun, ["build", "--compile", `--target=${PLUGIN_TARGETS[target]}`, join(root, "src", "plugin", "server.mjs"), "--outfile", backend], { cwd: root, maxBuffer: 4 * 1024 * 1024 });
    await chmod(backend, 0o755);
    const licenses = join(staging, "licenses");
    await mkdir(licenses);
    for (const dependency of ["hls.js", "mp4box", "undici", "@modelcontextprotocol/sdk", "@modelcontextprotocol/ext-apps", "zod"]) {
      const folder = join(root, "node_modules", dependency);
      const name = dependency.replaceAll("/", "-").replace(/^@/, "");
      let copied = false;
      for (const filename of ["LICENSE", "LICENSE.md", "LICENSE.txt"]) {
        try { await cp(join(folder, filename), join(licenses, `${name}.LICENSE`)); copied = true; break; }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      if (!copied) throw new Error(`缺少依赖许可证：${dependency}`);
    }
    await Promise.all([
      cp(join(root, "LICENSE"), join(staging, "LICENSE")),
      cp(join(root, "THIRD_PARTY_NOTICES.md"), join(staging, "THIRD_PARTY_NOTICES.md")),
      cp(join(root, "packaging", "licenses", "BUN-LICENSE.md"), join(licenses, "BUN-LICENSE.md"))
    ]);
    const result = { target, htmlBytes: Buffer.byteLength(html), uiSha256: createHash("sha256").update(html).digest("hex"), outDir };
    await writeFile(join(staging, "build.json"), `${JSON.stringify(result, null, 2)}\n`);
    await rm(outDir, { recursive: true, force: true });
    await rename(staging, outDir);
    return result;
  } finally { await rm(work, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = {};
  const args = process.argv.slice(2);
  while (args.length) {
    const flag = args.shift();
    if (flag === "--target") options.target = args.shift();
    else if (flag === "--out") options.outDir = args.shift();
    else throw new Error(`未知参数：${flag}`);
  }
  buildPlugin(options).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
