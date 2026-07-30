#!/bin/bash
# Codex Companion 一键安装脚本
#
#   curl -fsSL https://<release-host>/install.sh | bash
#
# 无需预装 Node —— 分发物是 bun --compile 的自包含二进制 + ffmpeg sidecar，打包进
# Codex Companion.app。脚本不修改 /Applications/ChatGPT.app。

set -euo pipefail

REPO="${CODEX_COMPANION_REPO:-foriLLL/codex-companion}"
APP_NAME="Codex Companion"
INSTALL_DIR="${CODEX_COMPANION_INSTALL_DIR:-$HOME/Applications}"
APP_PATH="$INSTALL_DIR/$APP_NAME.app"

log() { printf '\033[1;36m[codex-companion]\033[0m %s\n' "$1"; }
die() { printf '\033[1;31m[codex-companion]\033[0m %s\n' "$1" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "目前仅支持 macOS。"

ARCH="$(uname -m)"
case "$ARCH" in
  arm64) ASSET="codex-companion-darwin-arm64.tar.gz" ;;
  x86_64) ASSET="codex-companion-darwin-x64.tar.gz" ;;
  *) die "不支持的架构：$ARCH" ;;
esac

[ -d "/Applications/ChatGPT.app" ] || \
  log "警告：未检测到 /Applications/ChatGPT.app（界面产品名 Codex）。安装可继续，但运行前需先安装它。"

VERSION="${CODEX_COMPANION_VERSION:-latest}"
if [ "$VERSION" = "latest" ]; then
  URL="https://github.com/$REPO/releases/latest/download/$ASSET"
else
  URL="https://github.com/$REPO/releases/download/$VERSION/$ASSET"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

log "下载 $ASSET …"
curl -fsSL "$URL" -o "$TMP/app.tar.gz" || die "下载失败：$URL"

# 完整性校验：未签名未公证 + 主动去隔离，校验和是唯一的完整性保证。
# 下载对应 .sha256（缺失或不符则中止），默认强制；设 CODEX_COMPANION_SKIP_CHECKSUM=1 可跳过。
if [ "${CODEX_COMPANION_SKIP_CHECKSUM:-0}" != "1" ]; then
  if curl -fsSL "$URL.sha256" -o "$TMP/app.tar.gz.sha256" 2>/dev/null; then
    EXPECTED="$(awk '{print $1}' "$TMP/app.tar.gz.sha256")"
    ACTUAL="$(shasum -a 256 "$TMP/app.tar.gz" | awk '{print $1}')"
    [ -n "$EXPECTED" ] && [ "$EXPECTED" = "$ACTUAL" ] \
      || die "校验和不匹配（期望 $EXPECTED，实际 $ACTUAL）；拒绝安装。"
    log "校验和通过。"
  else
    die "未找到校验和文件 $URL.sha256；如确需跳过请设 CODEX_COMPANION_SKIP_CHECKSUM=1。"
  fi
fi

log "解压到 $INSTALL_DIR …"
mkdir -p "$INSTALL_DIR"
rm -rf "$APP_PATH"
tar -xzf "$TMP/app.tar.gz" -C "$INSTALL_DIR"
[ -d "$APP_PATH" ] || die "解压后未找到 $APP_PATH"

# 未签名/未公证产物：去除隔离属性，否则 Gatekeeper 会拦。
log "去除隔离属性 …"
xattr -dr com.apple.quarantine "$APP_PATH" 2>/dev/null || true

log "安装完成：$APP_PATH"
log "正在打开 Codex Companion（会带调试参数启动 Codex）…"
open "$APP_PATH"

cat <<EOF

  已安装到：$APP_PATH
  之后请通过「$APP_NAME」启动 Codex；首次启动后，点官方 ChatGPT 也不冲突。
  日志：~/Library/Logs/$APP_NAME/launcher.log

EOF
