#!/usr/bin/env node
// @ts-check
"use strict";

/**
 * Antigravity-Proxy macOS 本地透明中继（Scheme B 核心组件，零第三方依赖）
 *
 * 为什么 macOS 方案 B 需要本地中继，而不是直接把 socks5://user:pass@... 塞进环境变量？
 * 1. Chromium / Electron 的 --proxy-server 不支持内联账号密码，也不支持 SOCKS5 RFC 1929 鉴权；
 * 2. Go grpc-go 默认只支持 HTTP CONNECT 代理，而 Go net/http 忽略 ALL_PROXY；
 * 3. 本地回环 HTTP CONNECT 中继（127.0.0.1:<port>）对 Electron / Go / gRPC / Node 100% 通用，
 *    同时把 config.json 中的上游 SOCKS5/HTTP（含账密认证）、路由规则（局域网直连/域名/CIDR/阻断）
 *    与 proxy-YYYYMMDD.log 实时日志统一到一套体验，且绝不触碰 .app 签名。
 *
 * 用法：
 *   node agp-relay.js --config ~/.antigravity-proxy/config.json [--port 0]
 *   node agp-relay.js --ensure --config ~/.antigravity-proxy/config.json
 *     （确保后台常驻中继已启动且健康；若 proxy.port==0 则输出空行并以 0 退出，否则在 stdout 输出单行 URL）
 */

const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

/** 复用仓库共享配置解析器（若独立部署到 ~/.antigravity-proxy 时自带同级回退） */
function loadConfigCore() {
  const candidates = [
    path.join(__dirname, "config-core.js"),
    path.resolve(__dirname, "..", "..", "resources", "shared", "config-core.js"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return require(p);
  }
  return null;
}

const ConfigCore = loadConfigCore();

const DEFAULT_HOME_DIR = path.join(os.homedir(), ".antigravity-proxy");
const MAX_LOG_FILE_BYTES = 10 * 1024 * 1024; // 10MB，与 src/core/Logger.hpp 保持一致
const LEVEL_WEIGHT = Object.freeze({ debug: 0, info: 1, warn: 2, error: 3 });
const LEVEL_ZH = Object.freeze({ debug: "调试", info: "信息", warn: "警告", error: "错误" });

/** 内置私有/局域网 IPv4 CIDR（对齐 src/core/Config.hpp 的 default-private） */
const DEFAULT_PRIVATE_CIDRS_V4 = Object.freeze([
  "127.0.0.0/8",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "169.254.0.0/16",
  "100.64.0.0/10",
  "0.0.0.0/8",
]);

/** 本地时间格式 YYYY-MM-DD HH:mm:ss（对齐 Logger.hpp） */
function formatTimestamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

function formatDateTag(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}`;
}

/**
 * 生成与 src/core/Logger.hpp 及 resources/ide-extension/lib/logTail.js 完全兼容的日志行。
 * @param {"debug" | "info" | "warn" | "error"} level
 * @param {string} message
 * @param {Date} [date]
 */
function formatLogLine(level, message, date = new Date()) {
  const zh = LEVEL_ZH[level] || LEVEL_ZH.info;
  return `[${formatTimestamp(date)}] [PID:${process.pid}][TID:0] [${zh}] ${message}`;
}

/**
 * 简单 JSONC 解析兜底（仅当无法加载 shared/config-core.js 时使用）。
 * @param {string} text
 */
function parseJsoncFallback(text) {
  let out = "";
  let inStr = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inStr) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "\"") inStr = false;
      continue;
    }
    if (ch === "\"") {
      inStr = true;
      out += ch;
    } else if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      if (i < text.length) out += "\n";
    } else if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else {
      out += ch;
    }
  }
  return JSON.parse(out.replace(/,\s*([}\]])/g, "$1"));
}

/**
 * 解析并规范化 config.json。
 * @param {string} configPath
 */
function loadNormalizedConfig(configPath) {
  let raw = {};
  if (configPath && fs.existsSync(configPath)) {
    const text = fs.readFileSync(configPath, "utf8");
    raw = ConfigCore ? ConfigCore.parseJsonc(text) : parseJsoncFallback(text);
  }
  if (ConfigCore) {
    const normalized = ConfigCore.normalizeForm(raw);
    // 保留 macOS 中继支持的扩展 action: "block"（config-core 仅枚举 proxy/direct）
    const rawRules = raw?.proxy_rules?.routing?.rules;
    if (Array.isArray(rawRules) && Array.isArray(normalized?.proxy_rules?.routing?.rules)) {
      rawRules.forEach((rr, idx) => {
        if (String(rr?.action || "").trim().toLowerCase() === "block" && normalized.proxy_rules.routing.rules[idx]) {
          normalized.proxy_rules.routing.rules[idx].action = "block";
        }
      });
    }
    return normalized;
  }
  const proxy = raw && typeof raw.proxy === "object" && raw.proxy ? raw.proxy : {};
  const timeout = raw && typeof raw.timeout === "object" && raw.timeout ? raw.timeout : {};
  const routing = raw?.proxy_rules?.routing || {};
  return {
    log_level: String(raw?.log_level || "info").toLowerCase(),
    proxy: {
      host: String(proxy.host || "127.0.0.1").trim() || "127.0.0.1",
      port: Number.isInteger(Number(proxy.port)) ? Number(proxy.port) : 7890,
      type: String(proxy.type || "socks5").toLowerCase() === "http" ? "http" : "socks5",
      username: String(proxy.username || proxy.user || ""),
      password: String(proxy.password || proxy.pass || ""),
    },
    timeout: {
      connect: Number(timeout.connect) > 0 ? Number(timeout.connect) : 5000,
    },
    proxy_rules: {
      routing: {
        enabled: routing.enabled !== false,
        priority_mode: String(routing.priority_mode || "order").toLowerCase(),
        default_action: String(routing.default_action || "proxy").toLowerCase(),
        use_default_private: routing.use_default_private !== false,
        rules: Array.isArray(routing.rules) ? routing.rules : [],
      },
    },
  };
}

/** @param {string} ip */
function ipv4ToInt(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let val = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n < 0 || n > 255) return null;
    val = ((val << 8) | n) >>> 0;
  }
  return val;
}

/** @param {string} ip @param {string} cidr */
function matchCidrV4(ip, cidr) {
  const ipNum = ipv4ToInt(ip);
  if (ipNum === null) return false;
  const [netStr, prefixStr] = String(cidr || "").trim().split("/");
  const netNum = ipv4ToInt(netStr || "");
  if (netNum === null) return false;
  const prefix = prefixStr === undefined ? 32 : Number(prefixStr);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  if (prefix === 0) return true;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (ipNum & mask) === (netNum & mask);
}

/** @param {string} host */
function isPrivateOrLoopbackHost(host) {
  const clean = String(host || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!clean) return false;
  if (clean === "localhost" || clean.endsWith(".localhost") || clean.endsWith(".local")) return true;
  if (clean === "::1" || clean === "::") return true;
  if (/^fe[89ab][0-9a-f]:/i.test(clean) || /^f[cd][0-9a-f]{2}:/i.test(clean)) return true;
  if (net.isIPv4(clean)) {
    return DEFAULT_PRIVATE_CIDRS_V4.some((cidr) => matchCidrV4(clean, cidr));
  }
  return false;
}

/**
 * 域名规则匹配：支持精确域名、*.example.com、.example.com、通配符 *。
 * @param {string} host
 * @param {string} pattern
 */
function matchDomain(host, pattern) {
  const h = String(host || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  const p = String(pattern || "").trim().toLowerCase();
  if (!h || !p) return false;
  if (p === "*") return true;
  if (p.startsWith("*.")) {
    const suffix = p.slice(2);
    return h === suffix || h.endsWith(`.${suffix}`);
  }
  if (p.startsWith(".")) {
    const suffix = p.slice(1);
    return h === suffix || h.endsWith(`.${suffix}`);
  }
  if (p.includes("*")) {
    const escaped = p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`, "i").test(h);
  }
  return h === p;
}

/**
 * 解析路由决策：返回 { action: "proxy" | "direct" | "block", rule: string }。
 * @param {string} host
 * @param {number} port
 * @param {any} config
 */
function decideRoute(host, port, config) {
  const cleanHost = String(host || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  const proxyPort = Number(config?.proxy?.port ?? 0);
  if (proxyPort <= 0) {
    return { action: "direct", rule: "proxy-disabled" };
  }
  const routing = config?.proxy_rules?.routing;
  if (!routing || routing.enabled === false) {
    return { action: isPrivateOrLoopbackHost(cleanHost) ? "direct" : "proxy", rule: "routing-disabled" };
  }

  // 回环地址始终直连，防止中继自我循环
  if (cleanHost === "localhost" || cleanHost === "127.0.0.1" || cleanHost === "::1" || matchCidrV4(cleanHost, "127.0.0.0/8")) {
    return { action: "direct", rule: "loopback" };
  }

  const rawRules = Array.isArray(routing.rules) ? routing.rules : [];
  const byNumber = routing.priority_mode === "number" || routing.priority_mode === "priority";
  const orderedRules = byNumber
    ? rawRules.map((r, idx) => ({ r, idx })).sort((a, b) => (Number(b.r?.priority || 0) - Number(a.r?.priority || 0)) || (a.idx - b.idx)).map((x) => x.r)
    : rawRules;

  for (const rule of orderedRules) {
    if (!rule || rule.enabled === false) continue;
    const protocols = Array.isArray(rule.protocols) && rule.protocols.length ? rule.protocols.map((x) => String(x).toLowerCase()) : ["tcp"];
    if (!protocols.includes("tcp") && !protocols.includes("all") && !protocols.includes("*")) continue;

    const ports = Array.isArray(rule.ports) ? rule.ports.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
    if (ports.length > 0 && !ports.includes(Number(port))) continue;

    const domains = Array.isArray(rule.domains) ? rule.domains : [];
    const cidrsV4 = Array.isArray(rule.ip_cidrs_v4) ? rule.ip_cidrs_v4 : [];
    const hasTargetCondition = domains.length > 0 || cidrsV4.length > 0;
    let matchedTarget = !hasTargetCondition;
    if (!matchedTarget && domains.length > 0) {
      matchedTarget = domains.some((d) => matchDomain(cleanHost, d));
    }
    if (!matchedTarget && cidrsV4.length > 0 && net.isIPv4(cleanHost)) {
      matchedTarget = cidrsV4.some((c) => matchCidrV4(cleanHost, c));
    }
    if (!matchedTarget) continue;

    const action = ["direct", "proxy", "block"].includes(String(rule.action || "").toLowerCase())
      ? String(rule.action).toLowerCase()
      : "proxy";
    return { action, rule: String(rule.name || "custom-rule") };
  }

  if (routing.use_default_private !== false && isPrivateOrLoopbackHost(cleanHost)) {
    return { action: "direct", rule: "default-private" };
  }

  const def = ["direct", "proxy", "block"].includes(String(routing.default_action || "").toLowerCase())
    ? String(routing.default_action).toLowerCase()
    : "proxy";
  return { action: def, rule: "default" };
}

/**
 * 写入 proxy-YYYYMMDD.log（自动建目录 + 10MB 截断保护）。
 */
class FileLogger {
  /** @param {string} logsDir @param {string} [level] */
  constructor(logsDir, level = "info") {
    this.logsDir = logsDir;
    this.setLevel(level);
  }

  /** @param {string} level */
  setLevel(level) {
    const k = String(level || "info").toLowerCase();
    this.minWeight = LEVEL_WEIGHT[k] ?? LEVEL_WEIGHT.info;
  }

  /** @param {"debug" | "info" | "warn" | "error"} level @param {string} msg */
  log(level, msg) {
    const w = LEVEL_WEIGHT[level] ?? LEVEL_WEIGHT.info;
    if (w < this.minWeight) return;
    const now = new Date();
    const line = `${formatLogLine(level, msg, now)}\n`;
    if (!this.logsDir) return;
    try {
      fs.mkdirSync(this.logsDir, { recursive: true });
      const file = path.join(this.logsDir, `proxy-${formatDateTag(now)}.log`);
      try {
        const st = fs.statSync(file);
        if (st.size >= MAX_LOG_FILE_BYTES) {
          fs.writeFileSync(file, line, "utf8");
          return;
        }
      } catch { /* 新文件 */ }
      fs.appendFileSync(file, line, "utf8");
    } catch { /* 日志写入失败不影响转发主流程 */ }
  }

  debug(msg) { this.log("debug", msg); }
  info(msg) { this.log("info", msg); }
  warn(msg) { this.log("warn", msg); }
  error(msg) { this.log("error", msg); }
}

/**
 * 轻量套接字缓冲读取器：握手阶段集中缓冲所有分片，避免多次 unshift() 导致的 Node 流丢事件问题。
 * 握手完成后调用 detach() 摘除监听并归还多余字节给后续 pipe()。
 */
class SocketReader {
  /** @param {net.Socket} sock */
  constructor(sock) {
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    /** @type {Error | null} */
    this.err = null;
    this.closed = false;
    /** @type {(() => void) | null} */
    this.notify = null;

    this._onData = (/** @type {Buffer} */ chunk) => {
      this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
      if (this.notify) {
        const fn = this.notify;
        this.notify = null;
        fn();
      }
    };
    this._onError = (/** @type {Error} */ err) => {
      this.err = err;
      if (this.notify) {
        const fn = this.notify;
        this.notify = null;
        fn();
      }
    };
    this._onClose = () => {
      this.closed = true;
      if (this.notify) {
        const fn = this.notify;
        this.notify = null;
        fn();
      }
    };

    sock.on("data", this._onData);
    sock.once("error", this._onError);
    sock.once("close", this._onClose);
  }

  /** @param {number} timeoutMs */
  _waitChunk(timeoutMs) {
    return new Promise((resolve, reject) => {
      if (this.err) return reject(this.err);
      if (this.closed) return reject(new Error("上游连接提前关闭"));
      const timer = setTimeout(() => {
        this.notify = null;
        reject(new Error(`上游握手超时 (${timeoutMs}ms)`));
      }, timeoutMs);
      this.notify = () => {
        clearTimeout(timer);
        if (this.err) reject(this.err);
        else resolve();
      };
    });
  }

  /** @param {number} n @param {number} timeoutMs @returns {Promise<Buffer>} */
  async readExact(n, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (this.buf.length < n) {
      if (this.err) throw this.err;
      if (this.closed) throw new Error("上游连接提前关闭");
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`上游握手超时 (${timeoutMs}ms)`);
      await this._waitChunk(left);
    }
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }

  /** @param {number} timeoutMs @returns {Promise<string>} */
  async readHttpHeaders(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const idx = this.buf.indexOf("\r\n\r\n");
      if (idx >= 0) {
        const text = this.buf.subarray(0, idx).toString("latin1");
        this.buf = this.buf.subarray(idx + 4);
        return text;
      }
      if (this.buf.length > 65536) throw new Error("HTTP 代理响应头过大");
      if (this.err) throw this.err;
      if (this.closed) throw new Error("HTTP 代理连接提前关闭");
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`HTTP 代理握手超时 (${timeoutMs}ms)`);
      await this._waitChunk(left);
    }
  }

  /** 握手完成后调用：移除临时监听并把剩余载荷归还给 socket */
  detach() {
    this.sock.removeListener("data", this._onData);
    this.sock.removeListener("error", this._onError);
    this.sock.removeListener("close", this._onClose);
    const tail = this.buf;
    this.buf = Buffer.alloc(0);
    if (tail.length > 0) {
      this.sock.pause();
      this.sock.unshift(tail);
    }
  }
}

/**
 * 建立 TCP 连接（带超时）。
 * @param {string} host
 * @param {number} port
 * @param {number} timeoutMs
 * @returns {Promise<net.Socket>}
 */
function connectTcp(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`连接 ${host}:${port} 超时 (${timeoutMs}ms)`));
    }, timeoutMs);
    sock.once("connect", () => {
      clearTimeout(timer);
      sock.setNoDelay(true);
      resolve(sock);
    });
    sock.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * 通过上游 SOCKS5（RFC 1928 + RFC 1929）建立到 targetHost:targetPort 的隧道。
 * 优先发 DOMAIN(ATYP=0x03)，由上游代理解析 DNS，避免本机 DNS 泄漏。
 * @param {any} proxy
 * @param {string} targetHost
 * @param {number} targetPort
 * @param {number} timeoutMs
 * @returns {Promise<net.Socket>}
 */
async function dialViaSocks5(proxy, targetHost, targetPort, timeoutMs) {
  const sock = await connectTcp(proxy.host, proxy.port, timeoutMs);
  const reader = new SocketReader(sock);
  try {
    const hasAuth = !!(proxy.username || proxy.password);
    const methods = hasAuth ? Buffer.from([0x05, 0x02, 0x00, 0x02]) : Buffer.from([0x05, 0x01, 0x00]);
    sock.write(methods);

    const greeting = await reader.readExact(2, timeoutMs);
    if (greeting[0] !== 0x05) throw new Error(`SOCKS5 版本异常: 0x${greeting[0].toString(16)}`);
    if (greeting[1] === 0xff) throw new Error("SOCKS5 代理拒绝认证方式 (0xFF)");

    if (greeting[1] === 0x02) {
      const userBuf = Buffer.from(String(proxy.username || ""), "utf8");
      const passBuf = Buffer.from(String(proxy.password || ""), "utf8");
      if (userBuf.length > 255 || passBuf.length > 255) throw new Error("SOCKS5 账密长度超过 255 字节");
      sock.write(Buffer.concat([Buffer.from([0x01, userBuf.length]), userBuf, Buffer.from([passBuf.length]), passBuf]));
      const authResp = await reader.readExact(2, timeoutMs);
      if (authResp[1] !== 0x00) throw new Error(`SOCKS5 认证失败 (status=0x${authResp[1].toString(16)})`);
    } else if (greeting[1] !== 0x00) {
      throw new Error(`不支持的 SOCKS5 认证方式: 0x${greeting[1].toString(16)}`);
    }

    const cleanHost = targetHost.replace(/^\[|\]$/g, "");
    /** @type {Buffer} */
    let addrPart;
    if (net.isIPv4(cleanHost)) {
      addrPart = Buffer.from([0x01, ...cleanHost.split(".").map(Number)]);
    } else {
      const hostBuf = Buffer.from(cleanHost, "utf8");
      if (hostBuf.length > 255) throw new Error("目标域名长度超过 255 字节");
      addrPart = Buffer.concat([Buffer.from([0x03, hostBuf.length]), hostBuf]);
    }
    const portBuf = Buffer.alloc(2);
    portBuf.writeUInt16BE(targetPort, 0);
    sock.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), addrPart, portBuf]));

    const head = await reader.readExact(4, timeoutMs);
    if (head[0] !== 0x05) throw new Error(`SOCKS5 CONNECT 响应版本异常: 0x${head[0].toString(16)}`);
    if (head[1] !== 0x00) throw new Error(`SOCKS5 CONNECT 被拒绝 (REP=0x${head[1].toString(16)})`);
    const atyp = head[3];
    if (atyp === 0x01) {
      await reader.readExact(4 + 2, timeoutMs);
    } else if (atyp === 0x04) {
      await reader.readExact(16 + 2, timeoutMs);
    } else if (atyp === 0x03) {
      const lenBuf = await reader.readExact(1, timeoutMs);
      await reader.readExact(lenBuf[0] + 2, timeoutMs);
    } else {
      throw new Error(`SOCKS5 响应 ATYP 异常: 0x${atyp.toString(16)}`);
    }
    reader.detach();
    return sock;
  } catch (err) {
    reader.detach();
    sock.destroy();
    throw err;
  }
}

/**
 * 通过上游 HTTP CONNECT 建立隧道（支持 Basic Auth）。
 * @param {any} proxy
 * @param {string} targetHost
 * @param {number} targetPort
 * @param {number} timeoutMs
 * @returns {Promise<net.Socket>}
 */
async function dialViaHttpConnect(proxy, targetHost, targetPort, timeoutMs) {
  const sock = await connectTcp(proxy.host, proxy.port, timeoutMs);
  const reader = new SocketReader(sock);
  try {
    const authority = targetHost.includes(":") && !targetHost.startsWith("[")
      ? `[${targetHost}]:${targetPort}`
      : `${targetHost}:${targetPort}`;
    const lines = [
      `CONNECT ${authority} HTTP/1.1`,
      `Host: ${authority}`,
      "Proxy-Connection: Keep-Alive",
    ];
    if (proxy.username || proxy.password) {
      const token = Buffer.from(`${proxy.username || ""}:${proxy.password || ""}`, "utf8").toString("base64");
      lines.push(`Proxy-Authorization: Basic ${token}`);
    }
    sock.write(`${lines.join("\r\n")}\r\n\r\n`);

    const headerText = await reader.readHttpHeaders(timeoutMs);
    const statusLine = headerText.split("\r\n", 1)[0] || "";
    const m = /^HTTP\/\d+\.\d+\s+(\d{3})/.exec(statusLine);
    const code = m ? Number(m[1]) : 0;
    if (code < 200 || code >= 300) {
      throw new Error(`上游 HTTP CONNECT 失败: ${statusLine || "empty response"}`);
    }
    reader.detach();
    return sock;
  } catch (err) {
    reader.detach();
    sock.destroy();
    throw err;
  }
}

/**
 * 按路由决策拨号到目标地址。
 * @param {string} host
 * @param {number} port
 * @param {any} config
 * @param {FileLogger} logger
 * @returns {Promise<{ socket: net.Socket, route: { action: string, rule: string } }>}
 */
async function dialTarget(host, port, config, logger) {
  const route = decideRoute(host, port, config);
  const timeoutMs = Number(config?.timeout?.connect) > 0 ? Number(config.timeout.connect) : 5000;

  if (route.action === "block") {
    logger.warn(`[macOS Relay] 阻断连接 ${host}:${port} (rule=${route.rule})`);
    const err = new Error(`Blocked by rule: ${route.rule}`);
    /** @type {any} */ (err).statusCode = 403;
    throw err;
  }

  if (route.action === "direct") {
    logger.debug(`[macOS Relay] 直连 ${host}:${port} (rule=${route.rule})`);
    const socket = await connectTcp(host, port, timeoutMs);
    return { socket, route };
  }

  const proxy = config.proxy;
  logger.info(`[macOS Relay] ${proxy.type.toUpperCase()} 代理 ${host}:${port} -> ${proxy.host}:${proxy.port} (rule=${route.rule})`);
  const socket = proxy.type === "http"
    ? await dialViaHttpConnect(proxy, host, port, timeoutMs)
    : await dialViaSocks5(proxy, host, port, timeoutMs);
  return { socket, route };
}

/** 解析 CONNECT 的 host:port（支持 IPv6 [::1]:443）。 */
function parseConnectAuthority(authority) {
  const s = String(authority || "").trim();
  const v6 = /^\[([^\]]+)\]:(\d+)$/.exec(s);
  if (v6) return { host: v6[1], port: Number(v6[2]) };
  const idx = s.lastIndexOf(":");
  if (idx <= 0) return { host: s, port: 443 };
  return { host: s.slice(0, idx), port: Number(s.slice(idx + 1)) || 443 };
}

/**
 * 创建本地 macOS 中继服务器（支持热重载 config.json）。
 * @param {{
 *   configPath?: string,
 *   config?: any,
 *   logsDir?: string,
 *   listenHost?: string,
 *   listenPort?: number,
 *   stateFile?: string,
 * }} [opts]
 */
function createRelayServer(opts = {}) {
  const configPath = opts.configPath || "";
  const listenHost = opts.listenHost || "127.0.0.1";
  const listenPort = opts.listenPort ?? 0;
  const stateFile = opts.stateFile || "";
  const logsDir = opts.logsDir !== undefined
    ? opts.logsDir
    : (configPath ? path.join(path.dirname(configPath), "logs") : "");

  let currentConfig = opts.config ? opts.config : loadNormalizedConfig(configPath);
  let lastConfigMtime = 0;
  let lastConfigCheckAt = 0;
  try {
    if (configPath && fs.existsSync(configPath)) lastConfigMtime = fs.statSync(configPath).mtimeMs;
  } catch { /* ignore */ }

  const logger = new FileLogger(logsDir, currentConfig.log_level);

  const reloadConfigIfChanged = (force = false) => {
    if (!configPath) return currentConfig;
    const now = Date.now();
    if (!force && now - lastConfigCheckAt < 1000) return currentConfig;
    lastConfigCheckAt = now;
    try {
      const st = fs.statSync(configPath);
      if (force || st.mtimeMs !== lastConfigMtime) {
        const next = loadNormalizedConfig(configPath);
        lastConfigMtime = st.mtimeMs;
        currentConfig = next;
        logger.setLevel(next.log_level);
        logger.info(`[macOS Relay] 已热重载配置: ${next.proxy.type}://${next.proxy.host}:${next.proxy.port}`);
      }
    } catch (err) {
      logger.warn(`[macOS Relay] 重载配置失败，继续沿用旧配置: ${/** @type {Error} */ (err).message}`);
    }
    return currentConfig;
  };

  let activeConnections = 0;

  const server = http.createServer(async (req, res) => {
    // 内置健康检查端点（供启动器与 IDE 插件快速探测）
    if (req.url === "/_agp/health") {
      const cfg = reloadConfigIfChanged(false);
      const body = JSON.stringify({
        ok: true,
        pid: process.pid,
        activeConnections,
        upstream: { host: cfg.proxy.host, port: cfg.proxy.port, type: cfg.proxy.type },
        configPath,
      });
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
      res.end(body);
      return;
    }

    // 普通 HTTP 代理请求：GET http://example.com/path HTTP/1.1
    let targetUrl;
    try {
      targetUrl = new URL(req.url || "");
    } catch {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Bad proxy request URL");
      return;
    }

    const cfg = reloadConfigIfChanged(false);
    const targetHost = targetUrl.hostname;
    const targetPort = Number(targetUrl.port) || (targetUrl.protocol === "https:" ? 443 : 80);

    try {
      const { socket: upstream } = await dialTarget(targetHost, targetPort, cfg, logger);
      activeConnections++;
      const cleanup = () => { activeConnections = Math.max(0, activeConnections - 1); };
      upstream.once("close", cleanup);

      const reqPath = `${targetUrl.pathname || "/"}${targetUrl.search || ""}`;
      const rawHeaders = [];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const k = req.rawHeaders[i];
        const v = req.rawHeaders[i + 1];
        if (/^(proxy-connection|proxy-authorization)$/i.test(k)) continue;
        rawHeaders.push(`${k}: ${v}`);
      }
      if (!rawHeaders.some((h) => /^host:/i.test(h))) {
        rawHeaders.push(`Host: ${targetUrl.host}`);
      }
      upstream.write(`${req.method} ${reqPath} HTTP/1.1\r\n${rawHeaders.join("\r\n")}\r\n\r\n`);
      req.pipe(upstream);
      upstream.pipe(res.socket);
      upstream.on("error", () => { try { res.socket?.destroy(); } catch { /* ignore */ } });
      req.on("error", () => { try { upstream.destroy(); } catch { /* ignore */ } });
    } catch (err) {
      const status = /** @type {any} */ (err).statusCode || 502;
      logger.error(`[macOS Relay] HTTP 转发失败 ${targetHost}:${targetPort}: ${/** @type {Error} */ (err).message}`);
      res.writeHead(status, { "Content-Type": "text/plain" });
      res.end(`Antigravity-Proxy Relay Error: ${/** @type {Error} */ (err).message}`);
    }
  });

  // HTTPS / gRPC / WebSocket 通用 CONNECT 隧道
  server.on("connect", async (req, clientSocket, head) => {
    const { host, port } = parseConnectAuthority(req.url);
    const cfg = reloadConfigIfChanged(false);

    clientSocket.on("error", () => { /* 客户端断开时静默忽略 */ });

    try {
      const { socket: upstream } = await dialTarget(host, port, cfg, logger);
      activeConnections++;
      let closed = false;
      const onDone = () => {
        if (closed) return;
        closed = true;
        activeConnections = Math.max(0, activeConnections - 1);
      };
      upstream.once("close", onDone);
      clientSocket.once("close", onDone);

      clientSocket.write("HTTP/1.1 200 Connection Established\r\nProxy-Agent: Antigravity-Proxy-macOS\r\n\r\n");
      if (head && head.length > 0) upstream.write(head);

      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);

      upstream.on("error", () => { try { clientSocket.destroy(); } catch { /* ignore */ } });
      clientSocket.on("error", () => { try { upstream.destroy(); } catch { /* ignore */ } });
    } catch (err) {
      const status = /** @type {any} */ (err).statusCode === 403 ? "403 Forbidden" : "502 Bad Gateway";
      logger.error(`[macOS Relay] CONNECT 失败 ${host}:${port}: ${/** @type {Error} */ (err).message}`);
      try {
        clientSocket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
      } catch { /* ignore */ }
      clientSocket.destroy();
    }
  });

  const writeState = (port) => {
    if (!stateFile) return;
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      const tmp = `${stateFile}.${process.pid}.tmp`;
      const payload = {
        pid: process.pid,
        host: listenHost,
        port,
        configPath,
        startedAt: Date.now(),
      };
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n", "utf8");
      fs.renameSync(tmp, stateFile);
    } catch { /* ignore */ }
  };

  const removeState = () => {
    if (!stateFile) return;
    try {
      const raw = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      if (raw && raw.pid === process.pid) fs.unlinkSync(stateFile);
    } catch { /* ignore */ }
  };

  return {
    server,
    logger,
    reloadConfig: () => reloadConfigIfChanged(true),
    getConfig: () => currentConfig,
    start() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(listenPort, listenHost, () => {
          server.removeListener("error", reject);
          const addr = server.address();
          const port = typeof addr === "object" && addr ? addr.port : listenPort;
          writeState(port);
          logger.info(`[macOS Relay] 已启动监听 http://${listenHost}:${port}，上游=${currentConfig.proxy.type}://${currentConfig.proxy.host}:${currentConfig.proxy.port}`);
          resolve({ host: listenHost, port });
        });
      });
    },
    stop() {
      return new Promise((resolve) => {
        removeState();
        server.close(() => resolve());
      });
    },
  };
}

/** 探测已有中继健康状态。 */
function checkRelayHealth(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: "/_agp/health", timeout: timeoutMs }, (res) => {
      let body = "";
      res.on("data", (d) => { body += d; });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(body);
          resolve(res.statusCode === 200 && parsed && parsed.ok === true ? parsed : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

/**
 * 确保后台常驻中继已就绪，返回 http://127.0.0.1:<port>（当 proxy.port==0 时返回 ""）。
 * @param {{ configPath: string, stateFile: string, listenPort?: number }} opts
 */
async function ensureRelayRunning(opts) {
  const cfg = loadNormalizedConfig(opts.configPath);
  if (!cfg.proxy || cfg.proxy.port <= 0) {
    return "";
  }

  // 1. 检查现有 stateFile 是否指向存活且健康的实例
  try {
    const existing = JSON.parse(fs.readFileSync(opts.stateFile, "utf8"));
    if (existing && existing.port > 0) {
      const health = await checkRelayHealth(existing.host || "127.0.0.1", existing.port, 500);
      if (health && (!existing.configPath || path.resolve(existing.configPath) === path.resolve(opts.configPath))) {
        return `http://${existing.host || "127.0.0.1"}:${existing.port}`;
      }
    }
  } catch { /* 状态文件不存在或已过期 */ }

  // 2. 后台拉起独立守护进程（stdio 全忽略，绝不污染调用方 stdout）
  const child = spawn(process.execPath, [
    __filename,
    "--config", opts.configPath,
    "--state-file", opts.stateFile,
    "--port", String(opts.listenPort ?? 0),
  ], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
  });
  child.unref();

  // 3. 轮询等待就绪（最多 5 秒）
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 80));
    try {
      const st = JSON.parse(fs.readFileSync(opts.stateFile, "utf8"));
      if (st && st.port > 0) {
        const health = await checkRelayHealth(st.host || "127.0.0.1", st.port, 400);
        if (health) return `http://${st.host || "127.0.0.1"}:${st.port}`;
      }
    } catch { /* 继续等待 */ }
  }
  throw new Error("启动 Antigravity-Proxy macOS 中继超时");
}

function parseCliArgs(argv) {
  const args = {
    ensure: false,
    configPath: process.env.AGP_CONFIG_PATH || path.join(DEFAULT_HOME_DIR, "config.json"),
    stateFile: process.env.AGP_RELAY_STATE || path.join(DEFAULT_HOME_DIR, "relay.json"),
    port: Number(process.env.AGP_RELAY_PORT || 0) || 0,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--ensure") args.ensure = true;
    else if (a === "--config" && argv[i + 1]) args.configPath = argv[++i];
    else if (a === "--state-file" && argv[i + 1]) args.stateFile = argv[++i];
    else if (a === "--port" && argv[i + 1]) args.port = Number(argv[++i]) || 0;
  }
  return args;
}

async function main() {
  const cli = parseCliArgs(process.argv.slice(2));
  if (cli.ensure) {
    try {
      const url = await ensureRelayRunning(cli);
      if (url) process.stdout.write(`${url}\n`);
      process.exit(0);
    } catch (err) {
      process.stderr.write(`[agp-relay] ${/** @type {Error} */ (err).message}\n`);
      process.exit(1);
    }
    return;
  }

  const relay = createRelayServer({
    configPath: cli.configPath,
    stateFile: cli.stateFile,
    listenPort: cli.port,
  });

  process.on("SIGHUP", () => relay.reloadConfig());
  const shutdown = async () => {
    await relay.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await relay.start();
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`[agp-relay] 启动失败: ${err.message}\n`);
    process.exit(1);
  });
}

module.exports = {
  createRelayServer,
  ensureRelayRunning,
  checkRelayHealth,
  loadNormalizedConfig,
  decideRoute,
  matchDomain,
  matchCidrV4,
  isPrivateOrLoopbackHost,
  formatLogLine,
  dialViaSocks5,
  dialViaHttpConnect,
  parseConnectAuthority,
  DEFAULT_HOME_DIR,
};
