import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const installerPath = fileURLToPath(new URL("../packaging/install.sh", import.meta.url));
const installer = readFileSync(installerPath, "utf8");

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
  const start = installer.indexOf('if [ "$#" -eq 1 ] && [ "$1" = "--uninstall" ]');
  const end = installer.indexOf('[ "$#" -eq 0 ]', start);
  assert.ok(start >= 0 && end > start);
  const uninstall = installer.slice(start, end);
  const validate = uninstall.indexOf('[ "$identifier" = "$BUNDLE_ID" ] || die');
  const stop = uninstall.indexOf('"$backend" agent uninstall || die');
  const remove = uninstall.indexOf('rm -rf "$APP_PATH"');
  assert.ok(validate >= 0 && validate < stop && stop < remove);
  assert.match(uninstall, /\[ ! -L "\$APP_PATH" \]/);
  assert.match(uninstall, /配置保留在 ~\/Library\/Application Support\/codex-companion/);
  assert.doesNotMatch(uninstall, /open |agent install|ensure_optional_ffmpeg/);
});

test("安装完成先说明启用步骤再打开引导，不安装服务或启动 Codex", () => {
  const complete = installer.slice(installer.indexOf('log "主程序安装完成'));
  assert.ok(complete.indexOf("请点击「启用自动加载」") < complete.indexOf('open "$APP_PATH"'));
  assert.match(complete, /以后直接打开 Codex 即可/);
  assert.match(complete, /bash install\.sh --uninstall/);
  assert.doesNotMatch(installer, /agent install|通过「\$APP_NAME」启动 Codex/);
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
