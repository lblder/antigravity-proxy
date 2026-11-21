# macOS 代理方案设计与使用指南

## 1. 背景与 macOS 平台硬约束

Windows 版 Antigravity-Proxy 基于 `version.dll` / `dbghelp.dll` 侧载与 `CreateRemoteThread` 子进程注入实现。但在 macOS 上，经对官方安装产物（`codesign -dv --entitlements -`）实测，核心二进制全部开启了 **Apple Hardened Runtime (`flags=0x10000`)** 并带有 Google 正式签名（`TeamIdentifier=EQHXZ8M8AV`）：

| 二进制 | 签名与运行态 | 关键限制 |
| :--- | :--- | :--- |
| `/Applications/Antigravity.app` | Hardened Runtime + `Sealed Resources`（394 文件封印） | 无 `allow-dyld-environment-variables`、无 `disable-library-validation` |
| `.../Contents/Resources/bin/language_server` | Mach-O arm64，Hardened Runtime | 仅 `allow-jit`，无 dyld 放宽项 |
| `~/.local/bin/agy`（CLI） | Mach-O arm64，Hardened Runtime | 无 dyld / task 放宽项 |

因此：
- **`DYLD_INSERT_LIBRARIES` / `proxychains4` 注入不可行**：macOS `dyld` 会在启动前直接剥离 `DYLD_INSERT_LIBRARIES`；强行重签名会破坏公证、钥匙串 OAuth 凭据与自动更新。
- **不可照搬 Linux 替换二进制方案**：修改 `.app` 内 `language_server` 会破坏 `Sealed Resources` 签名封印。

---

## 2. 实测验证：环境变量与本地中继覆盖率

使用本地抓包代理对 macOS 版 `agy models` 进行 6 组隔离实测，结果如下：

| 测试场景 | 结果 | 捕获流量 / 关键结论 |
| :--- | :---: | :--- |
| `HTTP_PROXY` + `HTTPS_PROXY` 指向 `http://127.0.0.1:<relay>` | ✅ 成功 (`3.28s`) | **100% 命中中继**：`www.googleapis.com`、`daily-cloudcode-pa.googleapis.com`、`lh3.googleusercontent.com`、`play.googleapis.com`、`antigravity-cli-auto-updater-*.run.app` |
| `HTTP_PROXY` + `HTTPS_PROXY` 指向不可达端口 `127.0.0.1:1` | ❌ 超时失败 | **严格 Fail-Closed**：设置后不会静默回退直连或系统代理 |
| 仅设置 `ALL_PROXY=socks5://...`（未设 `HTTPS_PROXY`） | ⚠️ 绕过 (`0` 命中) | Go `httpproxy.FromEnvironment()` **完全忽略 `ALL_PROXY`** |
| `HTTPS_PROXY=socks5://` 或 `socks5h://` | ✅ 成功 (`2.77s`) | 经 SOCKS5 `ATYP=0x03` 域名远端解析，无 DNS 泄漏 |

同时考虑到两项客户端限制：
1. **Chromium / Electron** 的 `--proxy-server` 不支持内联账密，且不支持 SOCKS5 RFC 1929 用户名密码认证；
2. **`grpc-go`** 默认只支持 HTTP CONNECT 代理。

因此 macOS 落地 **方案 B（本地微中继 + 无侵入独立启动器 + ACP 包装器 + 跨平台 IDE 扩展）**：所有子进程统一接入本地无鉴权回环 HTTP CONNECT 中继 `http://127.0.0.1:<port>`，再由中继按 `config.json` 转发至上游 **SOCKS5（含 RFC 1929 鉴权、远端域名解析）或 HTTP CONNECT（含 Basic Auth）**。

---

## 3. 架构组成

| 组件 | 路径 | 职责 |
| :--- | :--- | :--- |
| **本地微中继** | `macos/relay/agp-relay.js` | 零第三方依赖 Node.js 守护进程：复用 `resources/shared/config-core.js`、支持上游 SOCKS5/HTTP 账密认证、支持 `proxy_rules.routing`（含局域网直连/通配符域名/CIDR/阻断）与热重载、按 Windows 同格式写入 `~/.antigravity-proxy/logs/proxy-YYYYMMDD.log` |
| **ACP 包装器** | `macos/bin/agy-acp-proxy` | 确保中继在线后注入全套代理环境变量并 `exec` 目标程序；**零 `stdout` 污染**（保护 ACP JSON-RPC 管道），透传退出码 |
| **CLI 包装器** | `macos/bin/agy-proxy` | 封装 `agy-acp-proxy` 自动定位本机 `agy` 执行 |
| **桌面/IDE 启动器** | `macos/scripts/antigravity-launcher.sh` | 不修改官方 `.app`，附加 `--proxy-server`、`--proxy-bypass-list` 与代理环境变量及 `AGP_MACOS_RELAY_URL` 标记 |
| **一键安装脚本** | `macos/scripts/install-macos.sh` | 自动读取 `scutil --proxy` 生成 `~/.antigravity-proxy/config.json`，创建独立 `~/Applications/Antigravity (Proxy).app` 并链接 `~/.local/bin/agy-acp-proxy` |
| **跨平台 IDE 扩展** | `resources/ide-extension/` | 支持 `darwin`：读取 `~/.antigravity-proxy/config.json`、`scutil --proxy` 自动扫代理、实时日志尾随、出口 IP/Gemini 三层检测、ACP 向导与 macOS 重启编排 |

---

## 4. 安装与使用

### 一键安装

```bash
./macos/scripts/install-macos.sh
```

安装完成后：
1. **Antigravity IDE / 桌面端**：启动 `~/Applications/Antigravity (Proxy).app`（可拖到程序坞 Dock），官方升级 `/Applications/Antigravity.app` 不会覆盖代理配置。
2. **Antigravity CLI**：
   ```bash
   agy-proxy models
   agy-proxy -p "你好"
   ```
3. **外部编辑器 ACP（JetBrains / Zed / VS Code）**：
   - JetBrains `~/.jetbrains/acp.json` 或 Zed `~/.config/zed/settings.json` 中将命令指向 `~/.local/bin/agy-acp-proxy`，参数设为 `["~/.local/bin/agy", "acp"]`（或通过 IDE 插件的 ACP 向导自动配置）。
4. **配置文件与日志**：
   - 配置：`~/.antigravity-proxy/config.json`（将 `proxy.port` 设为 `0` 即自动退回直连；修改后中继自动热重载）
   - 日志：`~/.antigravity-proxy/logs/proxy-YYYYMMDD.log`

---

## 5. 测试验证

```bash
# 运行 macOS 中继与包装器单测 + IDE 扩展全量单测
node --test macos/test/*.test.js resources/ide-extension/test/*.test.js
```

---

## 6. 后续演进：方案 A（`NETransparentProxyProvider`）

如果未来遇到绕过 `HTTP_PROXY` / `HTTPS_PROXY` 的直连 TCP/UDP（如原生 QUIC）场景，可在当前 `config.json` 与 IDE 扩展不变的前提下，增加基于 Apple `NetworkExtension` 的 `NETransparentProxyProvider`（SwiftUI 菜单栏 App + System Extension），按 `sourceAppSigningIdentifier`（`com.google.antigravity` / `language_server` / `cli`）实现内核级进程分流（对外签名分发需付费 Apple Developer 账号）。
