#!/usr/bin/env bash
# ============================================================================
# Antigravity-Proxy macOS 启动器 (antigravity-launcher.sh)
#
# 功能：
# 1. 不修改官方 /Applications/Antigravity.app 的任何文件（保留 Apple 签名与自动更新）；
# 2. 启动/复用 ~/.antigravity-proxy 本地微中继（支持 SOCKS5/HTTP 账密认证、路由规则与实时日志）；
# 3. 以 --proxy-server 与全套代理环境变量启动 Antigravity，确保主进程与子进程
#    （language_server / agy / node）全部走本地中继且零全局污染。
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGP_HOME="${AGP_HOME:-$HOME/.antigravity-proxy}"
CONFIG_PATH="${AGP_CONFIG_PATH:-$AGP_HOME/config.json}"
STATE_FILE="${AGP_RELAY_STATE:-$AGP_HOME/relay.json}"

# 定位本地中继脚本
RELAY_SCRIPT=""
for candidate in \
  "$SCRIPT_DIR/../relay/agp-relay.js" \
  "$AGP_HOME/relay/agp-relay.js"; do
  if [[ -f "$candidate" ]]; then
    RELAY_SCRIPT="$candidate"
    break
  fi
done

find_node() {
  if [[ -n "${AGP_NODE_BIN:-}" && -x "${AGP_NODE_BIN}" ]]; then
    echo "$AGP_NODE_BIN"
    return 0
  fi
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  for candidate in \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    "$HOME/.volta/bin/node" \
    "$HOME/.asdf/shims/node" \
    "$HOME/.local/share/fnm/aliases/default/bin/node"; do
    if [[ -x "$candidate" ]]; then
      echo "$candidate"
      return 0
    fi
  done
  if [[ -d "$HOME/.nvm/versions/node" ]]; then
    local latest
    latest="$(ls -1d "$HOME/.nvm/versions/node/"*/bin/node 2>/dev/null | sort -V | tail -n 1 || true)"
    if [[ -n "$latest" && -x "$latest" ]]; then
      echo "$latest"
      return 0
    fi
  fi
  return 1
}

find_app_executable() {
  if [[ -n "${AGP_APP_PATH:-}" ]]; then
    if [[ -x "$AGP_APP_PATH" && ! -d "$AGP_APP_PATH" ]]; then
      echo "$AGP_APP_PATH"
      return 0
    fi
    for inner in "Contents/MacOS/Antigravity IDE" "Contents/MacOS/Antigravity"; do
      if [[ -x "$AGP_APP_PATH/$inner" ]]; then
        echo "$AGP_APP_PATH/$inner"
        return 0
      fi
    done
  fi
  for candidate in \
    "/Applications/Antigravity IDE.app/Contents/MacOS/Antigravity IDE" \
    "/Applications/Antigravity.app/Contents/MacOS/Antigravity" \
    "$HOME/Applications/Antigravity IDE.app/Contents/MacOS/Antigravity IDE" \
    "$HOME/Applications/Antigravity.app/Contents/MacOS/Antigravity"; do
    if [[ -x "$candidate" ]]; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

APP_BIN="$(find_app_executable || true)"
if [[ -z "$APP_BIN" ]]; then
  echo "[antigravity-launcher] 未找到 Antigravity.app，请确认已安装到 /Applications 或设置 AGP_APP_PATH" >&2
  exit 1
fi

RELAY_URL=""
if [[ -n "$RELAY_SCRIPT" ]]; then
  NODE_BIN="$(find_node || true)"
  if [[ -n "$NODE_BIN" ]]; then
    RELAY_URL="$("$NODE_BIN" "$RELAY_SCRIPT" --ensure --config "$CONFIG_PATH" --state-file "$STATE_FILE" || true)"
  else
    echo "[antigravity-launcher] 警告: 未找到 Node.js，将以直连模式启动" >&2
  fi
fi

EXTRA_ARGS=()
if [[ -n "$RELAY_URL" ]]; then
  NO_PROXY_VAL="localhost,127.0.0.1,::1,.local"
  export HTTP_PROXY="$RELAY_URL"
  export HTTPS_PROXY="$RELAY_URL"
  export ALL_PROXY="$RELAY_URL"
  export http_proxy="$RELAY_URL"
  export https_proxy="$RELAY_URL"
  export all_proxy="$RELAY_URL"
  export NO_PROXY="$NO_PROXY_VAL"
  export no_proxy="$NO_PROXY_VAL"
  export AGP_MACOS_RELAY_URL="$RELAY_URL"
  export AGP_CONFIG_PATH="$CONFIG_PATH"
  EXTRA_ARGS+=("--proxy-server=${RELAY_URL}" "--proxy-bypass-list=localhost;127.0.0.1;[::1];*.local")
fi

exec "$APP_BIN" "${EXTRA_ARGS[@]}" "$@"
