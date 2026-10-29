#!/bin/bash
# 安装 GitHub Release 中的 Codex Companion：
# - macOS：经 Developer ID 签名和 Apple 公证的 App；
# - Linux（预览）：单文件后端，发布时把本版本各架构归档的 SHA256 写入本脚本。

set -euo pipefail

REPO="${CODEX_COMPANION_REPO:-foriLLL/codex_companion}"
APP_NAME="Codex Companion"
BUNDLE_ID="com.codexcompanion.launcher"
EXPECTED_TEAM_ID="__APPLE_TEAM_ID__"
RELEASE_TAG="__RELEASE_TAG__"
LINUX_X64_SHA256="__LINUX_X64_SHA256__"
LINUX_ARM64_SHA256="__LINUX_ARM64_SHA256__"
FFMPEG_STATUS="missing"

log() { printf '\033[1;36m[codex-companion]\033[0m %s\n' "$1"; }
die() { printf '\033[1;31m[codex-companion]\033[0m %s\n' "$1" >&2; exit 1; }

has_ffmpeg() {
  if [ -n "${CODEX_COMPANION_FFMPEG:-}" ] \
    && [ -x "$CODEX_COMPANION_FFMPEG" ]; then
    return 0
  fi
  command -v ffmpeg >/dev/null 2>&1 \
    || [ -x "/opt/homebrew/bin/ffmpeg" ] \
    || [ -x "/usr/local/bin/ffmpeg" ] \
    || [ -x "/opt/local/bin/ffmpeg" ] \
    || [ -x "/usr/bin/ffmpeg" ] \
    || [ -x "/snap/bin/ffmpeg" ] \
    || [ -x "/home/linuxbrew/.linuxbrew/bin/ffmpeg" ]
}

find_brew() {
  if command -v brew >/dev/null 2>&1; then
    command -v brew
    return 0
  fi
  local candidate
  for candidate in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

ensure_optional_ffmpeg() {
  if has_ffmpeg; then
    FFMPEG_STATUS="existing"
    return 0
  fi
  if [ "${CODEX_COMPANION_SKIP_FFMPEG:-0}" = "1" ]; then
    FFMPEG_STATUS="skipped"
    return 0
  fi

  local brew_bin
  if ! brew_bin="$(find_brew)"; then
    FFMPEG_STATUS="missing-homebrew"
    return 0
  fi

  log "未检测到 FFmpeg，正在通过 Homebrew 自动安装 …"
  if "$brew_bin" install ffmpeg; then
    if has_ffmpeg; then
      FFMPEG_STATUS="installed"
    else
      FFMPEG_STATUS="installed-unavailable"
    fi
  else
    FFMPEG_STATUS="install-failed"
  fi
  return 0
}

print_ffmpeg_summary() {
  case "$FFMPEG_STATUS" in
    existing)
      printf '  FFmpeg：已就绪。\n'
      ;;
    installed)
      printf '  FFmpeg：已通过 Homebrew 自动安装。\n'
      ;;
    skipped)
      cat <<EOF
  ⚠️  FFmpeg：已按 CODEX_COMPANION_SKIP_FFMPEG=1 跳过安装。
      红果、Emby HLS 和常规码率兼容 MP4 仍可播放；HEVC、EC-3、MKV、超高码率媒体和图形字幕烧录不可用。
      如需补装，请运行：brew install ffmpeg
EOF
      ;;
    *)
      cat <<EOF
  ⚠️  FFmpeg：未安装成功，但 Codex Companion 已可正常使用。
      红果、Emby HLS 和常规码率兼容 MP4 仍可播放；HEVC、EC-3、MKV、超高码率媒体和图形字幕烧录不可用。
      安装 Homebrew：https://brew.sh/
      安装 FFmpeg：brew install ffmpeg
EOF
      ;;
  esac
}

# 归档内每个路径都必须严格位于唯一的顶层目录下，拒绝绝对路径和目录穿越；
# 应用包不需要符号链接、硬链接或设备节点，拒绝它们，避免解压阶段借链接越界写入。
verify_archive() {
  local archive="$1" root="$2" entry listing kind
  while IFS= read -r entry; do
    case "$entry" in
      "$root"|"$root/"|"$root/"*) ;;
      *) die "归档包含非预期路径：$entry" ;;
    esac
    case "/$entry/" in
      */../*) die "归档包含目录穿越路径：$entry" ;;
    esac
  done < <(tar -tzf "$archive")
  while IFS= read -r listing; do
    kind="${listing:0:1}"
    [ "$kind" = "-" ] || [ "$kind" = "d" ] || die "归档包含不允许的条目类型：$listing"
  done < <(tar -tvzf "$archive")
}

# ---------------------------------------------------------------- macOS

uninstall_macos() {
  INSTALL_DIR="${CODEX_COMPANION_INSTALL_DIR:-$HOME/Applications}"
  APP_PATH="$INSTALL_DIR/$APP_NAME.app"
  if [ ! -d "$APP_PATH" ] || [ -L "$APP_PATH" ]; then die "未找到可卸载的 App：$APP_PATH"; fi
  local identifier backend
  identifier="$(defaults read "$APP_PATH/Contents/Info" CFBundleIdentifier 2>/dev/null || true)"
  [ "$identifier" = "$BUNDLE_ID" ] || die "Bundle ID 不匹配；拒绝删除 $APP_PATH。"
  backend="$APP_PATH/Contents/Resources/codex-companion"
  [ -x "$backend" ] || die "未找到 App 内的后端；请在 App 中停用后手动卸载。"
  # 后台服务未成功停用时保留 App，避免留下指向已删除程序的 job。
  "$backend" agent uninstall || die "停用后台服务失败；App 已保留，请重试。"
  rm -rf "$APP_PATH"
  log "Companion 已卸载；配置保留在 ~/Library/Application Support/codex-companion。"
}

install_macos() {
  INSTALL_DIR="${CODEX_COMPANION_INSTALL_DIR:-$HOME/Applications}"
  APP_PATH="$INSTALL_DIR/$APP_NAME.app"
  [[ "$EXPECTED_TEAM_ID" =~ ^[A-Z0-9]{10}$ ]] \
    || die "这是未注入有效 Apple Team ID 的安装脚本模板，请改用 GitHub Release 中的 install.sh。"

  case "$(uname -m)" in
    arm64) ASSET="codex-companion-darwin-arm64.tar.gz" ;;
    x86_64) ASSET="codex-companion-darwin-x64.tar.gz" ;;
    *) die "不支持的架构：$(uname -m)" ;;
  esac

  [ -d "/Applications/ChatGPT.app" ] || \
    log "警告：未检测到 /Applications/ChatGPT.app；安装可继续，但运行前需要先安装 Codex Desktop。"

  VERSION="${CODEX_COMPANION_VERSION:-latest}"
  if [ "$VERSION" = "latest" ]; then
    URL="https://github.com/$REPO/releases/latest/download/$ASSET"
  else
    URL="https://github.com/$REPO/releases/download/$VERSION/$ASSET"
  fi

  TMP="$(mktemp -d)"
  BACKUP_PATH=""
  cleanup() {
    rm -rf "$TMP"
    if [ -n "$BACKUP_PATH" ] && [ -d "$BACKUP_PATH" ]; then
      if [ ! -e "$APP_PATH" ]; then
        mv "$BACKUP_PATH" "$APP_PATH" || true
      else
        rm -rf "$BACKUP_PATH"
      fi
    fi
  }
  trap cleanup EXIT

  log "下载 $ASSET …"
  curl --proto '=https' --tlsv1.2 -fsSL "$URL" -o "$TMP/app.tar.gz" || die "下载失败：$URL"
  curl --proto '=https' --tlsv1.2 -fsSL "$URL.sha256" -o "$TMP/app.tar.gz.sha256" \
    || die "Release 缺少校验和：$URL.sha256"

# Release 同源 SHA256 用来发现下载损坏；发布者身份由下方 Apple 代码签名与公证校验确认。
  EXPECTED="$(awk 'NR == 1 { print $1 }' "$TMP/app.tar.gz.sha256")"
  ACTUAL="$(shasum -a 256 "$TMP/app.tar.gz" | awk '{print $1}')"
  if [ -z "$EXPECTED" ] || [ "$EXPECTED" != "$ACTUAL" ]; then
    die "校验和不匹配（期望 $EXPECTED，实际 $ACTUAL）；拒绝安装。"
  fi

  verify_archive "$TMP/app.tar.gz" "$APP_NAME.app"
  mkdir -p "$TMP/extract"
  tar -xzf "$TMP/app.tar.gz" -C "$TMP/extract"
  STAGED_APP="$TMP/extract/$APP_NAME.app"
  [ -d "$STAGED_APP" ] || die "归档中未找到 $APP_NAME.app"

  IDENTIFIER="$(defaults read "$STAGED_APP/Contents/Info" CFBundleIdentifier 2>/dev/null || true)"
  [ "$IDENTIFIER" = "$BUNDLE_ID" ] || die "Bundle ID 不匹配：$IDENTIFIER"
  codesign --verify --deep --strict --verbose=2 "$STAGED_APP" \
    || die "Developer ID 签名校验失败。"
  spctl --assess --type execute --verbose=2 "$STAGED_APP" \
    || die "Apple 公证校验失败。"
  ACTUAL_TEAM_ID="$(codesign -dv --verbose=4 "$STAGED_APP" 2>&1 \
    | awk -F= '/^TeamIdentifier=/ { print $2; exit }')"
  [ "$ACTUAL_TEAM_ID" = "$EXPECTED_TEAM_ID" ] \
    || die "签名团队不匹配（期望 $EXPECTED_TEAM_ID，实际 $ACTUAL_TEAM_ID）；拒绝安装。"

  log "安装到 $INSTALL_DIR …"
  mkdir -p "$INSTALL_DIR"
  if [ -e "$APP_PATH" ]; then
    BACKUP_PATH="$INSTALL_DIR/.${APP_NAME}.backup.$$"
    mv "$APP_PATH" "$BACKUP_PATH" || die "无法备份现有安装。"
  fi
  if ! mv "$STAGED_APP" "$APP_PATH"; then
    if [ -n "$BACKUP_PATH" ] && [ -e "$BACKUP_PATH" ]; then
      mv "$BACKUP_PATH" "$APP_PATH" || true
      BACKUP_PATH=""
    fi
    die "安装失败；已尝试恢复原版本。"
  fi

  if [ -n "$BACKUP_PATH" ] && [ -e "$BACKUP_PATH" ]; then
    rm -rf "$BACKUP_PATH"
    BACKUP_PATH=""
  fi

  log "主程序安装完成：$APP_PATH"
  ensure_optional_ffmpeg
  cat <<EOF

  已安装到：$APP_PATH
  即将打开引导，请点击「启用自动加载」；如需批准，请前往「系统设置 › 通用 › 登录项」。
  以后直接打开 Codex 即可；「$APP_NAME」仅用于引导、状态和备用设置。
  日志：~/Library/Logs/codex-companion/
  卸载：在 App 中点击「卸载 Companion」后移到废纸篓，或运行 bash install.sh --uninstall。
  配置保留在 ~/Library/Application Support/codex-companion。

EOF
  print_ffmpeg_summary
  printf '\n'
  if ! open "$APP_PATH"; then
    log "应用已安装，但未能打开引导；请手动打开 $APP_PATH 并点击「启用自动加载」。"
  fi
}

# ---------------------------------------------------------------- Linux（预览）

LINUX_FILES=(codex-companion LICENSE THIRD_PARTY_NOTICES.md hls.js.LICENSE mp4box.LICENSE undici.LICENSE BUN-LICENSE.md)

linux_install_dir() {
  if [ -n "${CODEX_COMPANION_INSTALL_DIR:-}" ]; then
    printf '%s\n' "$CODEX_COMPANION_INSTALL_DIR"
  elif [[ "${XDG_DATA_HOME:-}" = /* ]]; then
    printf '%s\n' "$XDG_DATA_HOME/codex-companion"
  else
    printf '%s\n' "$HOME/.local/share/codex-companion"
  fi
}

# 安装目录只能不存在，或是只含 Companion 自己文件的真实目录：
# 避免 CODEX_COMPANION_INSTALL_DIR 指向已有目录时把别人的文件一起替换或删除。
linux_dir_is_ours() {
  local directory="$1" entry name file known
  if [ ! -d "$directory" ] || [ -L "$directory" ]; then return 1; fi
  [ -f "$directory/codex-companion" ] || return 1
  for entry in "$directory"/* "$directory"/.[!.]*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    name="${entry##*/}"
    known=0
    for file in "${LINUX_FILES[@]}"; do
      if [ "$name" = "$file" ]; then known=1; fi
    done
    [ "$known" = 1 ] || return 1
  done
}

uninstall_linux() {
  INSTALL_DIR="$(linux_install_dir)"
  linux_dir_is_ours "$INSTALL_DIR" || die "未找到可卸载的 Companion：$INSTALL_DIR"
  # 后台服务未成功停用时保留程序，避免留下指向已删除程序的服务与菜单入口。
  "$INSTALL_DIR/codex-companion" agent uninstall >/dev/null || die "停用后台服务失败；程序已保留，请重试。"
  local file
  for file in "${LINUX_FILES[@]}"; do rm -f "${INSTALL_DIR:?}/$file"; done
  rmdir "$INSTALL_DIR"
  log "Companion 已卸载，应用菜单恢复为系统原有的 ChatGPT 入口；配置保留在 ~/.config/codex-companion。"
}

print_linux_ffmpeg_summary() {
  if has_ffmpeg; then
    printf '  FFmpeg：已就绪。\n'
    return 0
  fi
  cat <<EOF
  ⚠️  FFmpeg：未检测到，但 Codex Companion 已可正常使用。
      红果、Emby HLS 和常规码率兼容 MP4 仍可播放；HEVC、EC-3、MKV、超高码率媒体和图形字幕烧录不可用。
      如需补装：sudo apt install ffmpeg（Fedora：sudo dnf install ffmpeg-free）
EOF
}

install_linux() {
  INSTALL_DIR="$(linux_install_dir)"
  local codex="${CODEX_COMPANION_CODEX_EXECUTABLE:-/usr/lib/chatgpt/ChatGPT}"
  [ -x "$codex" ] || die "未检测到 ChatGPT 桌面版（$codex）；请先安装：https://learn.chatgpt.com/docs/linux/linux-app"
  if ! command -v systemctl >/dev/null 2>&1 || ! systemctl --user show-environment >/dev/null 2>&1; then
    die "需要 systemd 用户服务（systemctl --user），当前会话不可用。"
  fi
  [[ "$RELEASE_TAG" =~ ^v[0-9] ]] \
    || die "这是未注入发布版本与校验和的安装脚本模板，请改用 GitHub Release 中的 install.sh。"

  local asset expected
  case "$(uname -m)" in
    x86_64|amd64) asset="codex-companion-linux-x64.tar.gz"; expected="$LINUX_X64_SHA256" ;;
    aarch64|arm64) asset="codex-companion-linux-arm64.tar.gz"; expected="$LINUX_ARM64_SHA256" ;;
    *) die "不支持的架构：$(uname -m)" ;;
  esac
  [[ "$expected" =~ ^[0-9a-f]{64}$ ]] || die "安装脚本缺少 $asset 的校验和；拒绝安装。"
  if [ -e "$INSTALL_DIR" ] || [ -L "$INSTALL_DIR" ]; then
    linux_dir_is_ours "$INSTALL_DIR" || die "$INSTALL_DIR 已存在且不是 Companion 的安装目录；拒绝覆盖。"
  fi

  # 只下载与本脚本同一版本的归档：校验和在发布时写入脚本，与下载地址一一对应，
  # Linux 没有平台级签名，发布者身份由从 GitHub Release 取得的本脚本保证。
  local url="https://github.com/$REPO/releases/download/$RELEASE_TAG/$asset"
  TMP="$(mktemp -d)"
  BACKUP_PATH=""
  cleanup_linux() {
    rm -rf "$TMP"
    if [ -n "$BACKUP_PATH" ] && [ -d "$BACKUP_PATH" ]; then
      if [ ! -e "$INSTALL_DIR" ]; then
        mv "$BACKUP_PATH" "$INSTALL_DIR" || true
      else
        rm -rf "$BACKUP_PATH"
      fi
    fi
  }
  trap cleanup_linux EXIT

  log "下载 $asset（$RELEASE_TAG）…"
  curl --proto '=https' --tlsv1.2 -fsSL "$url" -o "$TMP/app.tar.gz" || die "下载失败：$url"
  local actual
  actual="$(sha256sum "$TMP/app.tar.gz" | awk '{print $1}')"
  [ "$actual" = "$expected" ] || die "校验和不匹配（期望 $expected，实际 $actual）；拒绝安装。"
  verify_archive "$TMP/app.tar.gz" "codex-companion"
  mkdir -p "$TMP/extract"
  tar -xzf "$TMP/app.tar.gz" -C "$TMP/extract"
  local staged="$TMP/extract/codex-companion"
  [ -f "$staged/codex-companion" ] || die "归档中未找到 codex-companion"
  chmod 0755 "$staged/codex-companion"

  log "安装到 $INSTALL_DIR …"
  mkdir -p "$(dirname "$INSTALL_DIR")"
  if [ -e "$INSTALL_DIR" ]; then
    BACKUP_PATH="$INSTALL_DIR.backup.$$"
    mv "$INSTALL_DIR" "$BACKUP_PATH" || die "无法备份现有安装。"
  fi
  if ! mv "$staged" "$INSTALL_DIR"; then
    if [ -n "$BACKUP_PATH" ] && [ -e "$BACKUP_PATH" ]; then
      mv "$BACKUP_PATH" "$INSTALL_DIR" || true
      BACKUP_PATH=""
    fi
    die "安装失败；已尝试恢复原版本。"
  fi
  if [ -n "$BACKUP_PATH" ] && [ -e "$BACKUP_PATH" ]; then
    rm -rf "$BACKUP_PATH"
    BACKUP_PATH=""
  fi

  # 注册 systemd 用户服务并覆盖应用菜单入口；升级时重启服务换上新版本。
  "$INSTALL_DIR/codex-companion" agent install >/dev/null \
    || die "注册后台服务失败；程序已安装在 $INSTALL_DIR，按上方提示处理后重新运行本脚本。"

  # 没带调试参数（port 为 null）的 ChatGPT 需要从菜单重开一次才能加载卡片。
  local status reopen=""
  sleep 2
  status="$("$INSTALL_DIR/codex-companion" agent status 2>/dev/null || true)"
  case "$status" in
    *'"running":true'*'"port":null'*) reopen=1 ;;
  esac
  cat <<EOF

  已安装到：$INSTALL_DIR
  以后从应用菜单打开 ChatGPT 即可加载卡片；在终端直接运行 chatgpt 不会加载。
  日志：journalctl --user -u codex-companion-agent
  卸载：bash install.sh --uninstall
  配置保留在 ~/.config/codex-companion。

EOF
  if [ -n "$reopen" ]; then
    printf '  ⚠️  ChatGPT 正在运行：请退出后从应用菜单重新打开，卡片才会出现。\n\n'
  fi
  print_linux_ffmpeg_summary
  printf '\n'
}

main() {
  local system
  system="$(uname -s)"
  case "$system" in
    Darwin|Linux) ;;
    *) die "目前仅支持 macOS 与 Linux。" ;;
  esac
  if [ "$#" -eq 1 ] && [ "$1" = "--uninstall" ]; then
    if [ "$system" = "Darwin" ]; then uninstall_macos; else uninstall_linux; fi
    return 0
  fi
  [ "$#" -eq 0 ] || die "用法：bash install.sh [--uninstall]"
  if [ "$system" = "Darwin" ]; then install_macos; else install_linux; fi
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
