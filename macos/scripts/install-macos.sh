#!/usr/bin/env bash
# ============================================================================
# Antigravity-Proxy macOS 一键安装器 (install-macos.sh)
#
# 功能：
# 1. 部署本地微中继、agy-acp-proxy、agy-proxy、antigravity-launcher.sh 到 ~/.antigravity-proxy/
# 2. 自动探测 macOS 系统代理（scutil --proxy）生成默认 ~/.antigravity-proxy/config.json（已有则保留）
# 3. 生成独立启动器 ~/Applications/Antigravity (Proxy).app（复制官方图标，绝不修改官方 .app）
# 4. 在 ~/.local/bin 创建 agy-acp-proxy 与 agy-proxy 软链接（若目录存在或可创建）
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MACOS_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$MACOS_ROOT/.." && pwd)"
AGP_HOME="${AGP_HOME:-$HOME/.antigravity-proxy}"
APP_BUNDLE="${AGP_PROXY_APP:-$HOME/Applications/Antigravity (Proxy).app}"

GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${CYAN}============================================================${NC}"
echo -e "${CYAN}  Antigravity-Proxy macOS 安装向导（免 TUN / 不破坏签名）${NC}"
echo -e "${CYAN}============================================================${NC}"

mkdir -p "$AGP_HOME/relay" "$AGP_HOME/bin" "$AGP_HOME/scripts" "$AGP_HOME/logs"

cp -f "$MACOS_ROOT/relay/agp-relay.js" "$AGP_HOME/relay/agp-relay.js"
if [[ -f "$REPO_ROOT/resources/shared/config-core.js" ]]; then
  cp -f "$REPO_ROOT/resources/shared/config-core.js" "$AGP_HOME/relay/config-core.js"
fi
cp -f "$MACOS_ROOT/bin/agy-acp-proxy" "$AGP_HOME/bin/agy-acp-proxy"
cp -f "$MACOS_ROOT/bin/agy-proxy" "$AGP_HOME/bin/agy-proxy"
cp -f "$MACOS_ROOT/scripts/antigravity-launcher.sh" "$AGP_HOME/scripts/antigravity-launcher.sh"

chmod +x \
  "$AGP_HOME/relay/agp-relay.js" \
  "$AGP_HOME/bin/agy-acp-proxy" \
  "$AGP_HOME/bin/agy-proxy" \
  "$AGP_HOME/scripts/antigravity-launcher.sh"

# 1. 自动探测 macOS 系统代理并初始化 config.json（不覆盖用户已有配置）
CONFIG_FILE="$AGP_HOME/config.json"
if [[ ! -f "$CONFIG_FILE" ]]; then
  DETECTED_HOST="127.0.0.1"
  DETECTED_PORT="7890"
  DETECTED_TYPE="socks5"
  if command -v scutil >/dev/null 2>&1; then
    SCUTIL_OUT="$(scutil --proxy 2>/dev/null || true)"
    SOCKS_EN="$(echo "$SCUTIL_OUT" | awk '/SOCKSEnable/ {print $3; exit}')"
    SOCKS_HOST="$(echo "$SCUTIL_OUT" | awk '/SOCKSProxy/ {print $3; exit}')"
    SOCKS_PORT="$(echo "$SCUTIL_OUT" | awk '/SOCKSPort/ {print $3; exit}')"
    HTTPS_EN="$(echo "$SCUTIL_OUT" | awk '/HTTPSEnable/ {print $3; exit}')"
    HTTPS_HOST="$(echo "$SCUTIL_OUT" | awk '/HTTPSProxy/ {print $3; exit}')"
    HTTPS_PORT="$(echo "$SCUTIL_OUT" | awk '/HTTPSPort/ {print $3; exit}')"
    if [[ "$SOCKS_EN" == "1" && -n "$SOCKS_HOST" && -n "$SOCKS_PORT" ]]; then
      DETECTED_HOST="$SOCKS_HOST"
      DETECTED_PORT="$SOCKS_PORT"
      DETECTED_TYPE="socks5"
    elif [[ "$HTTPS_EN" == "1" && -n "$HTTPS_HOST" && -n "$HTTPS_PORT" ]]; then
      DETECTED_HOST="$HTTPS_HOST"
      DETECTED_PORT="$HTTPS_PORT"
      DETECTED_TYPE="http"
    fi
  fi

  cat > "$CONFIG_FILE" <<EOF
{
  "_comment": "Antigravity-Proxy macOS 配置文件",
  "log_level": "info",
  "proxy": {
    "host": "${DETECTED_HOST}",
    "port": ${DETECTED_PORT},
    "type": "${DETECTED_TYPE}",
    "username": "",
    "password": ""
  },
  "timeout": {
    "connect": 5000,
    "send": 5000,
    "recv": 5000
  },
  "proxy_rules": {
    "routing": {
      "enabled": true,
      "priority_mode": "order",
      "default_action": "proxy",
      "use_default_private": true,
      "rules": []
    }
  }
}
EOF
  echo -e "${GREEN}[✓] 已生成配置文件: ${CONFIG_FILE} (探测到上游 ${DETECTED_TYPE}://${DETECTED_HOST}:${DETECTED_PORT})${NC}"
else
  echo -e "${YELLOW}[i] 保留已有配置文件: ${CONFIG_FILE}${NC}"
fi

# 2. 创建独立启动器 ~/Applications/Antigravity (Proxy).app
mkdir -p "$APP_BUNDLE/Contents/MacOS" "$APP_BUNDLE/Contents/Resources"

ICON_NAME=""
for src_app in "/Applications/Antigravity IDE.app" "/Applications/Antigravity.app"; do
  if [[ -d "$src_app/Contents/Resources" ]]; then
    icns="$(find "$src_app/Contents/Resources" -maxdepth 1 -name '*.icns' 2>/dev/null | head -n 1 || true)"
    if [[ -n "$icns" && -f "$icns" ]]; then
      cp -f "$icns" "$APP_BUNDLE/Contents/Resources/AppIcon.icns"
      ICON_NAME="AppIcon"
      break
    fi
  fi
done

cat > "$APP_BUNDLE/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleExecutable</key>
  <string>AntigravityProxyLauncher</string>
  <key>CFBundleIdentifier</key>
  <string>io.github.antigravity-proxy.launcher</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>Antigravity (Proxy)</string>
  <key>CFBundleDisplayName</key>
  <string>Antigravity (Proxy)</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>2.6.5</string>
  <key>CFBundleVersion</key>
  <string>2.6.5</string>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
$(if [[ -n "$ICON_NAME" ]]; then echo "  <key>CFBundleIconFile</key>"; echo "  <string>${ICON_NAME}</string>"; fi)
</dict>
</plist>
EOF

cat > "$APP_BUNDLE/Contents/MacOS/AntigravityProxyLauncher" <<EOF
#!/usr/bin/env bash
exec "$AGP_HOME/scripts/antigravity-launcher.sh" "\$@"
EOF
chmod +x "$APP_BUNDLE/Contents/MacOS/AntigravityProxyLauncher"
echo -e "${GREEN}[✓] 已创建独立代理启动器: ${APP_BUNDLE}${NC}"

# 3. 软链接 CLI / ACP 包装器到 ~/.local/bin
if mkdir -p "$HOME/.local/bin" 2>/dev/null; then
  ln -sf "$AGP_HOME/bin/agy-acp-proxy" "$HOME/.local/bin/agy-acp-proxy"
  ln -sf "$AGP_HOME/bin/agy-proxy" "$HOME/.local/bin/agy-proxy"
  echo -e "${GREEN}[✓] 已链接命令行包装器到 ~/.local/bin/agy-acp-proxy 与 ~/.local/bin/agy-proxy${NC}"
fi

echo ""
echo -e "${CYAN}使用方式：${NC}"
echo "  1. 桌面 / IDE：打开 ~/Applications/Antigravity (Proxy).app（可拖入程序坞 Dock）"
echo "  2. CLI 终端  ：运行 agy-proxy models 或 agy-proxy -p \"hello\""
echo "  3. 外部 ACP  ：将 JetBrains / Zed 的 Agent 命令设为 ~/.local/bin/agy-acp-proxy，参数为 [\"$(command -v agy || echo ~/.local/bin/agy)\", \"acp\"]"
echo "  4. 配置文件  ：${CONFIG_FILE}"
echo "  5. 实时日志  ：${AGP_HOME}/logs/proxy-YYYYMMDD.log"
