import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { renderInstaller } from "../scripts/prepare-installer.mjs";

const installerPath = fileURLToPath(new URL("../packaging/install.sh", import.meta.url));
const installer = readFileSync(installerPath, "utf8");
// 按函数切出各平台流程，分别断言。
const section = (name) => {
  const start = installer.indexOf(`\n${name}() {`);
  const end = installer.indexOf("\n}\n", start);
  assert.ok(start >= 0 && end > start, `缺少 ${name}`);
  return installer.slice(start, end);
};

// 安装器只做静态检查，不 source 或执行安装、卸载与 Homebrew 操作。
test("Release 安装脚本保持有效的 Bash 语法", { skip: process.platform === "win32" && "安装脚本只面向 macOS" }, () => {
  const result = spawnSync("/bin/bash", ["-n", installerPath], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("安装器在 shellcheck 可用时进行静态检查", t => {
  const result = spawnSync("shellcheck", [installerPath], { encoding: "utf8" });
  if (result.error?.code === "ENOENT") {
    t.diagnostic("shellcheck 不可用；已执行 bash -n");
    return;
  }
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("卸载先验证目标 App，再停用服务，失败时保留 App", () => {
  const uninstall = section("uninstall_macos");
  const validate = uninstall.indexOf('[ "$identifier" = "$BUNDLE_ID" ] || die');
  const stop = uninstall.indexOf('"$backend" agent uninstall || die');
  const remove = uninstall.indexOf('rm -rf "$APP_PATH"');
  assert.ok(validate >= 0 && validate < stop && stop < remove);
  assert.match(uninstall, /\[ -L "\$APP_PATH" \]; then die/);
  assert.match(uninstall, /配置保留在 ~\/Library\/Application Support\/codex-companion/);
  assert.doesNotMatch(uninstall, /open |agent install|ensure_optional_ffmpeg/);
});

test("macOS 安装完成先说明启用步骤再打开引导，不安装服务或启动 Codex", () => {
  const macos = section("install_macos");
  const complete = macos.slice(macos.indexOf('log "主程序安装完成'));
  assert.ok(complete.indexOf("请点击「启用自动加载」") < complete.indexOf('open "$APP_PATH"'));
  assert.match(complete, /以后直接打开 Codex 即可/);
  assert.match(complete, /bash install\.sh --uninstall/);
  assert.doesNotMatch(macos, /agent install|通过「\$APP_NAME」启动 Codex/);
});

test("Linux 安装：先查前置条件与模板，按写入脚本的校验和核对同版本归档，再注册服务", () => {
  const linux = section("install_linux");
  const order = ["/usr/lib/chatgpt/ChatGPT", "systemctl --user show-environment", "未注入发布版本与校验和",
    "linux_dir_is_ours", "releases/download/$RELEASE_TAG/$asset", "sha256sum", "校验和不匹配", "verify_archive",
    'mv "$staged" "$INSTALL_DIR"', '"$INSTALL_DIR/codex-companion" agent install'];
  const positions = order.map((needle) => linux.indexOf(needle));
  assert.ok(positions.every((position) => position >= 0), JSON.stringify(Object.fromEntries(order.map((n, i) => [n, positions[i]]))));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
  // Linux 不跟随 latest、不读 Release 同源 .sha256，也不自动 sudo 安装依赖。
  assert.doesNotMatch(linux, /latest|\.sha256|sudo apt|CODEX_COMPANION_VERSION/);
  assert.match(linux, /从应用菜单打开 ChatGPT/);
});

test("Linux 卸载只删除 Companion 自己的文件，服务停用失败时保留程序", () => {
  const uninstall = section("uninstall_linux");
  const owned = uninstall.indexOf("linux_dir_is_ours");
  const stop = uninstall.indexOf("agent uninstall >/dev/null || die");
  const remove = uninstall.indexOf('rm -f "${INSTALL_DIR:?}/$file"');
  assert.ok(owned >= 0 && owned < stop && stop < remove);
  assert.doesNotMatch(uninstall, /rm -rf/);
  assert.match(section("linux_dir_is_ours"), /\[ -L "\$directory" \]; then return 1/);
});

test("Release 安装脚本必须写入 Team ID、tag 与两个 Linux 校验和，缺一即失败", () => {
  const values = { teamId: "ABCDE12345", tag: "v1.2.3", linuxX64Sha256: "a".repeat(64), linuxArm64Sha256: "b".repeat(64) };
  const rendered = renderInstaller(installer, values);
  assert.match(rendered, /^EXPECTED_TEAM_ID="ABCDE12345"$/m);
  assert.match(rendered, /^RELEASE_TAG="v1\.2\.3"$/m);
  assert.match(rendered, new RegExp(`^LINUX_X64_SHA256="${"a".repeat(64)}"$`, "m"));
  assert.match(rendered, new RegExp(`^LINUX_ARM64_SHA256="${"b".repeat(64)}"$`, "m"));
  assert.doesNotMatch(rendered, /__[A-Z0-9_]+__/);
  for (const broken of [{ teamId: "abc" }, { tag: "latest" }, { linuxX64Sha256: "x" }, { linuxArm64Sha256: undefined }]) {
    assert.throws(() => renderInstaller(installer, { ...values, ...broken }));
  }
  assert.throws(() => renderInstaller("no placeholders", values), /占位符/);
});

test("安装器保留发布签名、公证与下载校验的失败关闭条件", () => {
  assert.match(installer, /未注入有效 Apple Team ID/);
  assert.match(installer, /codesign --verify --deep --strict/);
  assert.match(installer, /spctl --assess --type execute/);
  assert.match(installer, /签名团队不匹配/);
  assert.match(installer, /校验和不匹配/);
});

test("可选 FFmpeg 保留已安装检查、显式跳过与失败提示", () => {
  const start = installer.indexOf("ensure_optional_ffmpeg() {");
  const end = installer.indexOf("print_ffmpeg_summary() {", start);
  const optional = installer.slice(start, end);
  assert.match(optional, /if has_ffmpeg; then/);
  assert.match(optional, /CODEX_COMPANION_SKIP_FFMPEG:-0/);
  assert.match(optional, /if "\$brew_bin" install ffmpeg; then/);
  assert.match(optional, /FFMPEG_STATUS="install-failed"/);
  assert.match(installer, /如需补装，请运行：brew install ffmpeg/);
});
