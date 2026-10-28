import { execFile } from "node:child_process";
import { chmod, cp, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildNative } from "./build-native.mjs";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

const APP_NAME = "Codex Companion";
const BUNDLE_ID = "com.codexcompanion.launcher";
const BINARY_NAME = "codex-companion";

export const TARGETS = {
  "darwin-arm64": { bun: "bun-darwin-arm64", swift: "arm64-apple-macos13", arch: "arm64" },
  "darwin-x64": { bun: "bun-darwin-x64", swift: "x86_64-apple-macos13", arch: "x86_64" }
};

export function parseArgs(argv, arch = process.arch) {
  const options = { target: `darwin-${arch}`, outDir: join(repoRoot, "dist") };
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

// 内层代码签名完成后才能封存外层 bundle；Release 会替换为 Developer ID 签名。
export async function signAppAdHoc(appRoot, execFileImpl = execFileAsync) {
  for (const path of [
    join(appRoot, "Contents", "Helpers", "companion-native"),
    join(appRoot, "Contents", "Resources", BINARY_NAME),
    appRoot
  ]) {
    await execFileImpl("codesign", ["--force", "--sign", "-", path]);
  }
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

  console.log("[build-app] 生成卡片目录与 renderer bundle…");
  await execFileAsync(process.execPath, [join(here, "generate-renderer.mjs")]);

  const appRoot = join(options.outDir, `${APP_NAME}.app`);
  const contents = join(appRoot, "Contents");
  const macos = join(contents, "MacOS");
  const resources = join(contents, "Resources");
  const helpers = join(contents, "Helpers");
  const launchAgents = join(contents, "Library", "LaunchAgents");
  await rm(appRoot, { recursive: true, force: true });
  await mkdir(macos, { recursive: true });
  await mkdir(resources, { recursive: true });
  await mkdir(helpers, { recursive: true });
  await mkdir(launchAgents, { recursive: true });
  await cp(join(repoRoot, "src", "cards", "card-catalog.json"), join(resources, "card-catalog.json"));
  await cp(join(repoRoot, "packaging", "mac-app", "LaunchAgents", "com.codexcompanion.agent.plist"),
    join(launchAgents, "com.codexcompanion.agent.plist"));

  console.log(`[build-app] 编译原生助手（${options.target}）…`);
  const nativeOutput = await buildNative({ target: options.target });
  const nativeDestination = join(helpers, "companion-native");
  await cp(nativeOutput, nativeDestination);
  await chmod(nativeDestination, 0o755);

  // 1. 编译 Bun 单文件后端二进制 → Resources/codex-companion
  const bunBin = process.env.CODEX_COMPANION_BUN
    ?? join(repoRoot, "node_modules", "bun", "bin", "bun.exe");
  const binaryOut = join(resources, BINARY_NAME);
  console.log(`[build-app] bun --compile（${target.bun}）…`);
  await execFileAsync(bunBin, [
    "build", "--compile",
    `--target=${target.bun}`,
    join(repoRoot, "src", "cli.mjs"),
    "--outfile", binaryOut
  ]);
  await chmod(binaryOut, 0o755);

  // 2. 随应用附带项目及所有直接打包依赖的许可说明。
  // FFmpeg 不再进入分发物；需要本机转码时只解析用户自行安装的 ffmpeg。
  const licenses = [
    [join(repoRoot, "LICENSE"), "LICENSE"],
    [join(repoRoot, "THIRD_PARTY_NOTICES.md"), "THIRD_PARTY_NOTICES.md"],
    [join(repoRoot, "node_modules", "hls.js", "LICENSE"), "hls.js.LICENSE"],
    [join(repoRoot, "node_modules", "mp4box", "LICENSE"), "mp4box.LICENSE"],
    [join(repoRoot, "node_modules", "undici", "LICENSE"), "undici.LICENSE"],
    [join(repoRoot, "packaging", "licenses", "BUN-LICENSE.md"), "BUN-LICENSE.md"]
  ];
  for (const [source, destination] of licenses) {
    await cp(source, join(resources, destination));
  }

  // 3. 编译 Swift 配置窗为 CFBundleExecutable → MacOS/launcher
  console.log(`[build-app] swiftc（${target.swift}）…`);
  const launcherPath = join(macos, "launcher");
  const { stdout: sdk } = await execFileAsync("xcrun", ["--sdk", "macosx", "--show-sdk-path"]);
  await execFileAsync("swiftc", [
    "-target", target.swift,
    "-sdk", sdk.trim(),
    "-parse-as-library",
    "-O",
    join(repoRoot, "packaging", "mac-app", "Sources", "CodexCompanionApp.swift"),
    "-o", launcherPath
  ]);
  await chmod(launcherPath, 0o755);

  // 4. Info.plist + App 图标
  await writeFile(join(contents, "Info.plist"), infoPlist(version), "utf8");
  console.log("[build-app] 生成 AppIcon.icns…");
  await buildAppIcon(resources);

  console.log("[build-app] 按内层到外层进行 ad-hoc 签名…");
  await signAppAdHoc(appRoot);
  console.log(`[build-app] 完成：${appRoot}`);
  console.log("[build-app] 本地产物为 ad-hoc 签名；公开 Release 必须经 Developer ID 签名和 Apple 公证。");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[build-app] 失败：${error.message}`);
    process.exitCode = 1;
  });
}
