import { execFile } from "node:child_process";
import { chmod, cp, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

const APP_NAME = "Codex Companion";
const BUNDLE_ID = "com.codexcompanion.launcher";
const BINARY_NAME = "codex-companion";

const TARGETS = {
  "darwin-arm64": { bun: "bun-darwin-arm64", swift: "arm64-apple-macos13", arch: "arm64" },
  "darwin-x64": { bun: "bun-darwin-x64", swift: "x86_64-apple-macos13", arch: "x86_64" }
};

function parseArgs(argv) {
  const options = { target: "darwin-arm64", outDir: join(repoRoot, "dist") };
  const args = [...argv];
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--target") options.target = args.shift();
    else if (arg === "--out") options.outDir = args.shift();
    else throw new Error(`未知参数：${arg}`);
  }
  if (!TARGETS[options.target]) {
    throw new Error(`不支持的 target：${options.target}（可选：${Object.keys(TARGETS).join(", ")}）`);
  }
  return options;
}

// 由 packaging/mac-app/AppIcon.png 生成各尺寸 iconset 并打成 AppIcon.icns。
// 只用 macOS 自带工具（sips / iconutil），与「依赖本机精确锁定、无 CDN」约定一致。
const ICON_REPS = [
  ["icon_16x16.png", 16],
  ["icon_16x16@2x.png", 32],
  ["icon_32x32.png", 32],
  ["icon_32x32@2x.png", 64],
  ["icon_128x128.png", 128],
  ["icon_128x128@2x.png", 256],
  ["icon_256x256.png", 256],
  ["icon_256x256@2x.png", 512],
  ["icon_512x512.png", 512],
  ["icon_512x512@2x.png", 1024]
];

async function buildAppIcon(resources) {
  const source = join(repoRoot, "packaging", "mac-app", "AppIcon.png");
  const iconset = join(resources, "AppIcon.iconset");
  await mkdir(iconset, { recursive: true });
  for (const [fileName, pixels] of ICON_REPS) {
    await execFileAsync("sips", ["-z", String(pixels), String(pixels), source, "--out", join(iconset, fileName)]);
  }
  await execFileAsync("iconutil", ["-c", "icns", iconset, "-o", join(resources, "AppIcon.icns")]);
  await rm(iconset, { recursive: true, force: true });
}

function infoPlist(version) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key><string>${APP_NAME}</string>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>launcher</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
</dict>
</plist>
`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const target = TARGETS[options.target];
  const pkg = require("../package.json");
  const version = pkg.version ?? "0.0.0";

  // 1. 嵌入 hls.js
  console.log("[build-app] 生成 hls 嵌入模块…");
  await execFileAsync(process.execPath, [join(here, "generate-hls-embed.mjs")]);

  const appRoot = join(options.outDir, `${APP_NAME}.app`);
  const contents = join(appRoot, "Contents");
  const macos = join(contents, "MacOS");
  const resources = join(contents, "Resources");
  await rm(appRoot, { recursive: true, force: true });
  await mkdir(macos, { recursive: true });
  await mkdir(resources, { recursive: true });

  // 2. 编译 Bun 单文件后端二进制 → Resources/codex-companion
  const bunBin = process.env.CODEX_COMPANION_BUN
    ?? join(repoRoot, "node_modules", ".bin", "bun");
  const binaryOut = join(resources, BINARY_NAME);
  console.log(`[build-app] bun --compile（${target.bun}）…`);
  await execFileAsync(bunBin, [
    "build", "--compile",
    `--target=${target.bun}`,
    join(repoRoot, "src", "cli.mjs"),
    "--outfile", binaryOut
  ]);
  await chmod(binaryOut, 0o755);

  // 3. 复制 ffmpeg sidecar（GPL 构建：分发物必须附带 LICENSE）
  //    ffmpeg-static 的 postinstall 只下载“构建机架构”的二进制，因此交叉打包（在 arm64
  //    机器上构建 x64 产物）会塞错架构。复制后用 `file` 校验，架构不符直接 fail，
  //    绝不发布一个运行时 "Bad CPU type" 的坏包。
  const ffmpegSrc = require("ffmpeg-static");
  const ffmpegDest = join(resources, "ffmpeg");
  await cp(ffmpegSrc, ffmpegDest);
  await chmod(ffmpegDest, 0o755);
  const { stdout: fileInfo } = await execFileAsync("file", ["-b", ffmpegDest]);
  if (!fileInfo.includes(target.arch)) {
    throw new Error(
      `ffmpeg sidecar 架构与目标不符：目标 ${target.arch}，实际 “${fileInfo.trim()}”。\n` +
      `交叉打包时请在对应架构的 runner 上重新 npm ci（ffmpeg-static 只下载构建机架构）。`
    );
  }
  // GPL 许可证必须随附：缺失即 fail，不静默吞。
  await cp(
    join(repoRoot, "node_modules", "ffmpeg-static", "ffmpeg.LICENSE"),
    join(resources, "ffmpeg.LICENSE")
  );

  // 4. 编译 Swift 配置窗为 CFBundleExecutable → MacOS/launcher
  console.log(`[build-app] swiftc（${target.swift}）…`);
  const launcherPath = join(macos, "launcher");
  await execFileAsync("swiftc", [
    "-target", target.swift,
    "-parse-as-library",
    "-O",
    join(repoRoot, "packaging", "mac-app", "Sources", "CodexCompanionApp.swift"),
    "-o", launcherPath
  ]);
  await chmod(launcherPath, 0o755);

  // 5. Info.plist + App 图标
  await writeFile(join(contents, "Info.plist"), infoPlist(version), "utf8");
  console.log("[build-app] 生成 AppIcon.icns…");
  await buildAppIcon(resources);

  console.log(`[build-app] 完成：${appRoot}`);
  console.log("[build-app] 未签名产物，分发前需 codesign + notarize，或让用户去 quarantine（见 install.sh）。");
}

main().catch((error) => {
  console.error(`[build-app] 失败：${error.message}`);
  process.exitCode = 1;
});
