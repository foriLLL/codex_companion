import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const installerPath = fileURLToPath(new URL("../packaging/install.sh", import.meta.url));

function runInstallerFunction(script) {
  return execFileSync("/bin/bash", ["-c", `source "$1"\n${script}`, "bash", installerPath], {
    encoding: "utf8"
  });
}

test("Release 安装脚本保持有效的 Bash 语法", () => {
  const result = spawnSync("/bin/bash", ["-n", installerPath], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("已有 FFmpeg 时不调用 Homebrew", () => {
  const output = runInstallerFunction(`
has_ffmpeg() { return 0; }
find_brew() { printf 'brew_mock\\n'; }
brew_mock() { printf 'unexpected-brew-call\\n'; return 1; }
ensure_optional_ffmpeg
printf 'status=%s\\n' "$FFMPEG_STATUS"
`);
  assert.equal(output, "status=existing\n");
});

test("缺少 FFmpeg 但有 Homebrew 时默认自动安装", () => {
  const output = runInstallerFunction(`
FFMPEG_TEST_READY=0
has_ffmpeg() { [ "$FFMPEG_TEST_READY" = "1" ]; }
find_brew() { printf 'brew_mock\\n'; }
brew_mock() {
  printf 'brew=%s %s\\n' "$1" "$2"
  FFMPEG_TEST_READY=1
}
ensure_optional_ffmpeg
printf 'status=%s\\n' "$FFMPEG_STATUS"
`);
  assert.match(output, /brew=install ffmpeg/);
  assert.match(output, /status=installed/);
});

test("Homebrew 安装失败不终止安装器并保留补装状态", () => {
  const output = runInstallerFunction(`
has_ffmpeg() { return 1; }
find_brew() { printf 'brew_mock\\n'; }
brew_mock() { return 42; }
ensure_optional_ffmpeg
printf 'still-running status=%s\\n' "$FFMPEG_STATUS"
`);
  assert.match(output, /still-running status=install-failed/);
});

test("没有 Homebrew 时降级为安装后提示", () => {
  const output = runInstallerFunction(`
has_ffmpeg() { return 1; }
find_brew() { return 1; }
ensure_optional_ffmpeg
print_ffmpeg_summary
printf 'status=%s\\n' "$FFMPEG_STATUS"
`);
  assert.match(output, /FFmpeg：未安装成功/);
  assert.match(output, /brew install ffmpeg/);
  assert.match(output, /status=missing-homebrew/);
});

test("用户可以显式跳过 FFmpeg 自动安装", () => {
  const output = runInstallerFunction(`
CODEX_COMPANION_SKIP_FFMPEG=1
has_ffmpeg() { return 1; }
find_brew() { printf 'brew_mock\\n'; }
brew_mock() { printf 'unexpected-brew-call\\n'; return 1; }
ensure_optional_ffmpeg
printf 'status=%s\\n' "$FFMPEG_STATUS"
`);
  assert.equal(output, "status=skipped\n");
});
