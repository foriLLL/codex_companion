import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = join(here, "..", "packaging", "install.sh");

/**
 * 生成 Release 用的 install.sh：写入 Apple Team ID、发布 tag 与 Linux 各架构归档的 SHA256。
 * 任何一项缺失或格式不对都失败，避免发布出会「放过」校验的安装脚本。
 */
export function renderInstaller(template, { teamId, tag, linuxX64Sha256, linuxArm64Sha256 }) {
  if (!/^[A-Z0-9]{10}$/.test(teamId ?? "")) throw new Error("Apple Team ID 必须是 10 位大写字母或数字");
  if (!/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(tag ?? "")) throw new Error(`发布 tag 格式错误：${tag}`);
  for (const [name, value] of [["linux-x64", linuxX64Sha256], ["linux-arm64", linuxArm64Sha256]]) {
    if (!/^[0-9a-f]{64}$/.test(value ?? "")) throw new Error(`${name} 的 SHA256 格式错误`);
  }
  const replacements = {
    __APPLE_TEAM_ID__: teamId,
    __RELEASE_TAG__: tag,
    __LINUX_X64_SHA256__: linuxX64Sha256,
    __LINUX_ARM64_SHA256__: linuxArm64Sha256
  };
  let output = template;
  for (const [placeholder, value] of Object.entries(replacements)) {
    if (!output.includes(placeholder)) throw new Error(`模板缺少占位符 ${placeholder}`);
    output = output.replaceAll(placeholder, value);
  }
  if (/__[A-Z0-9_]+__/.test(output)) throw new Error("安装脚本仍有未替换的占位符");
  return output;
}

const sha256 = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");

export function parseArgs(argv) {
  const options = {};
  const flags = { "--team-id": "teamId", "--tag": "tag", "--linux-x64": "linuxX64", "--linux-arm64": "linuxArm64", "--out": "out" };
  const args = [...argv];
  while (args.length > 0) {
    const arg = args.shift();
    const value = args.shift();
    if (!flags[arg]) throw new Error(`未知参数：${arg}`);
    if (!value || value.startsWith("--")) throw new Error(`${arg} 必须提供值`);
    options[flags[arg]] = value;
  }
  for (const flag of Object.keys(flags)) {
    if (!options[flags[flag]]) throw new Error(`缺少 ${flag}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const output = renderInstaller(await readFile(TEMPLATE, "utf8"), {
    teamId: options.teamId, tag: options.tag,
    linuxX64Sha256: await sha256(options.linuxX64), linuxArm64Sha256: await sha256(options.linuxArm64)
  });
  await writeFile(resolve(options.out), output, { mode: 0o755 });
  console.log(`[prepare-installer] 已生成 ${resolve(options.out)}（${options.tag}）`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[prepare-installer] 失败：${error.message}`);
    process.exitCode = 1;
  });
}
