#!/bin/bash
# 安装 GitHub Release 中已经过 Developer ID 签名和 Apple 公证的 Codex Companion。

set -euo pipefail

REPO="${CODEX_COMPANION_REPO:-foriLLL/codex_companion}"
APP_NAME="Codex Companion"
BUNDLE_ID="com.codexcompanion.launcher"
EXPECTED_TEAM_ID="__APPLE_TEAM_ID__"
INSTALL_DIR="${CODEX_COMPANION_INSTALL_DIR:-$HOME/Applications}"
APP_PATH="$INSTALL_DIR/$APP_NAME.app"
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
    || [ -x "/opt/local/bin/ffmpeg" ]
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
      红果、Emby HLS 和兼容 MP4 仍可播放；HEVC、EC-3、MKV 和图形字幕烧录不可用。
      如需补装，请运行：brew install ffmpeg
EOF
      ;;
    *)
      cat <<EOF
  ⚠️  FFmpeg：未安装成功，但 Codex Companion 已可正常使用。
      红果、Emby HLS 和兼容 MP4 仍可播放；HEVC、EC-3、MKV 和图形字幕烧录不可用。
      安装 Homebrew：https://brew.sh/
      安装 FFmpeg：brew install ffmpeg
EOF
      ;;
  esac
}

main() {
  [ "$(uname -s)" = "Darwin" ] || die "目前仅支持 macOS。"
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
  [ -n "$EXPECTED" ] && [ "$EXPECTED" = "$ACTUAL" ] \
    || die "校验和不匹配（期望 $EXPECTED，实际 $ACTUAL）；拒绝安装。"

# 先验证归档内每个路径都严格位于唯一的 App bundle 下，拒绝绝对路径和目录穿越。
  while IFS= read -r entry; do
    case "$entry" in
      "$APP_NAME.app"|"$APP_NAME.app/"|"$APP_NAME.app/"*) ;;
      *) die "归档包含非预期路径：$entry" ;;
    esac
    case "/$entry/" in
      */../*) die "归档包含目录穿越路径：$entry" ;;
    esac
  done < <(tar -tzf "$TMP/app.tar.gz")

# 当前应用包不需要符号链接、硬链接或设备节点；拒绝它们，避免解压阶段借链接越界写入。
  while IFS= read -r listing; do
    kind="${listing:0:1}"
    [ "$kind" = "-" ] || [ "$kind" = "d" ] || die "归档包含不允许的条目类型：$listing"
  done < <(tar -tvzf "$TMP/app.tar.gz")

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
  if ! open "$APP_PATH"; then
    log "应用已安装，但未能自动打开；请从 $APP_PATH 手动启动。"
  fi

  cat <<EOF

  已安装到：$APP_PATH
  以后请通过「$APP_NAME」启动 Codex。
  日志：~/Library/Logs/$APP_NAME/launcher.log

EOF
  print_ffmpeg_summary
  printf '\n'
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
