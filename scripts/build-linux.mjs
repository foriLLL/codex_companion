import { execFile } from "node:child_process";
import { chmod, cp, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const BINARY_NAME = "codex-companion";

export const TARGETS = {
  "linux-x64": { bun: "bun-linux-x64" },
  "linux-arm64": { bun: "bun-linux-arm64" }
};

export function parseArgs(argv, arch = process.arch) {
  const options = { target: `linux-${arch}`, outDir: join(repoRoot, "dist") };
  const args = [...argv];
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--target" || arg === "--out") {
      const value = args.shift();
      if (!value || value.startsWith("--")) throw new Error(`${arg} 必须提供值`);
      options[arg === "--target" ? "target" : "outDir"] = value;
    }
    else throw new Error(`未知参数：${arg}`);
  }
  if (!TARGETS[options.target]) {
    throw new Error(`不支持的 target：${options.target}（可选：${Object.keys(TARGETS).join(", ")}）`);
  }
  return options;
}

// 产物为 <out>/<target>/codex-companion/ 目录：单文件后端与许可说明。
// Release 把该目录打成 codex-companion-<target>.tar.gz，install.sh 解压到用户目录后执行 agent install。
async function main() {
  const options = parseArgs(process.argv.slice(2));
  const target = TARGETS[options.target];

  console.log("[build-linux] 生成卡片目录与 renderer bundle…");
  await execFileAsync(process.execPath, [join(here, "generate-renderer.mjs")]);

  const root = join(resolve(options.outDir), options.target, BINARY_NAME);
  await rm(dirname(root), { recursive: true, force: true });
  await mkdir(root, { recursive: true });

  const bunBin = process.env.CODEX_COMPANION_BUN
    ?? join(repoRoot, "node_modules", "bun", "bin", "bun.exe");
  const binaryOut = join(root, BINARY_NAME);
  console.log(`[build-linux] bun --compile（${target.bun}）…`);
  await execFileAsync(bunBin, [
    "build", "--compile",
    `--target=${target.bun}`,
    join(repoRoot, "src", "cli.mjs"),
    "--outfile", binaryOut
  ]);
  await chmod(binaryOut, 0o755);

  // 与 macOS 包一致：附带项目及打包依赖的许可说明；FFmpeg 不进入分发物。
  const licenses = [
    [join(repoRoot, "LICENSE"), "LICENSE"],
    [join(repoRoot, "THIRD_PARTY_NOTICES.md"), "THIRD_PARTY_NOTICES.md"],
    [join(repoRoot, "node_modules", "hls.js", "LICENSE"), "hls.js.LICENSE"],
    [join(repoRoot, "node_modules", "mp4box", "LICENSE"), "mp4box.LICENSE"],
    [join(repoRoot, "node_modules", "undici", "LICENSE"), "undici.LICENSE"],
    [join(repoRoot, "packaging", "licenses", "BUN-LICENSE.md"), "BUN-LICENSE.md"]
  ];
  for (const [source, destination] of licenses) {
    await cp(source, join(root, destination));
  }
  console.log(`[build-linux] 完成：${root}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[build-linux] 失败：${error.message}`);
    process.exitCode = 1;
  });
}
