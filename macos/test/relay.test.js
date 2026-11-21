// macOS 本地微中继与包装器单元测试：node --test macos/test/relay.test.js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const Relay = require("../relay/agp-relay.js");
const { parseLogLine } = require("../../resources/ide-extension/lib/logTail.js");

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agp-macos-test-"));
}

/** 构造极简 TCP 回显目标服务 */
function startEchoServer() {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      sock.on("data", (buf) => sock.write(Buffer.concat([Buffer.from("ECHO:"), buf])));
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, port: addr.port, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

/** 构造模拟上游 SOCKS5 服务器（支持可选用户名密码认证，返回收到连接的目标主机列表） */
function startMockSocks5Server({ username = "", password = "", connectToPort }) {
  const seenTargets = [];
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      let state = "greeting";
      let buf = Buffer.alloc(0);

      const handle = () => {
        if (state === "greeting") {
          if (buf.length < 2) return;
          const nMethods = buf[1];
          if (buf.length < 2 + nMethods) return;
          const methods = [...buf.subarray(2, 2 + nMethods)];
          buf = buf.subarray(2 + nMethods);
          if (username || password) {
            if (!methods.includes(0x02)) {
              sock.end(Buffer.from([0x05, 0xff]));
              return;
            }
            sock.write(Buffer.from([0x05, 0x02]));
            state = "auth";
          } else {
            sock.write(Buffer.from([0x05, 0x00]));
            state = "connect";
          }
          handle();
          return;
        }
        if (state === "auth") {
          if (buf.length < 2) return;
          const ulen = buf[1];
          if (buf.length < 2 + ulen + 1) return;
          const plen = buf[2 + ulen];
          if (buf.length < 2 + ulen + 1 + plen) return;
          const u = buf.subarray(2, 2 + ulen).toString("utf8");
          const p = buf.subarray(3 + ulen, 3 + ulen + plen).toString("utf8");
          buf = buf.subarray(3 + ulen + plen);
          if (u !== username || p !== password) {
            sock.end(Buffer.from([0x01, 0x01]));
            return;
          }
          sock.write(Buffer.from([0x01, 0x00]));
          state = "connect";
          handle();
          return;
        }
        if (state === "connect") {
          if (buf.length < 4) return;
          const atyp = buf[3];
          let host = "";
          let headerLen = 0;
          if (atyp === 0x01) {
            if (buf.length < 10) return;
            host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`;
            headerLen = 10;
          } else if (atyp === 0x03) {
            if (buf.length < 5) return;
            const dlen = buf[4];
            if (buf.length < 5 + dlen + 2) return;
            host = buf.subarray(5, 5 + dlen).toString("utf8");
            headerLen = 5 + dlen + 2;
          } else {
            sock.end(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            return;
          }
          const port = buf.readUInt16BE(headerLen - 2);
          const rest = buf.subarray(headerLen);
          buf = Buffer.alloc(0);
          seenTargets.push(`${host}:${port}`);
          state = "piping";

          const upstream = net.createConnection({ host: "127.0.0.1", port: connectToPort || port }, () => {
            sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
            if (rest.length > 0) upstream.write(rest);
            sock.pipe(upstream);
            upstream.pipe(sock);
          });
          upstream.on("error", () => sock.destroy());
        }
      };

      sock.on("data", (chunk) => {
        if (state === "piping") return;
        buf = Buffer.concat([buf, chunk]);
        handle();
      });
    });

    server.listen(0, "127.0.0.1", () => {
      resolve({
        server,
        port: server.address().port,
        seenTargets,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/** 构造模拟上游 HTTP CONNECT 代理（支持可选 Basic Auth） */
function startMockHttpProxy({ username = "", password = "", connectToPort }) {
  const seenTargets = [];
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(405);
      res.end();
    });
    server.on("connect", (req, clientSocket, head) => {
      if (username || password) {
        const expected = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
        if (req.headers["proxy-authorization"] !== expected) {
          clientSocket.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
          return;
        }
      }
      seenTargets.push(req.url);
      const targetPort = connectToPort || Number(String(req.url).split(":")[1]) || 80;
      const upstream = net.createConnection({ host: "127.0.0.1", port: targetPort }, () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head && head.length) upstream.write(head);
        clientSocket.pipe(upstream);
        upstream.pipe(clientSocket);
      });
      upstream.on("error", () => clientSocket.destroy());
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({
        server,
        port: server.address().port,
        seenTargets,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/** 通过本地 HTTP CONNECT 中继建立隧道并收发一段数据 */
function connectThroughRelay(relayPort, authority, payload) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: "127.0.0.1", port: relayPort }, () => {
      sock.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    });
    let headerDone = false;
    let buf = Buffer.alloc(0);
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!headerDone) {
        const idx = buf.indexOf("\r\n\r\n");
        if (idx < 0) return;
        const header = buf.subarray(0, idx).toString("latin1");
        const tail = buf.subarray(idx + 4);
        headerDone = true;
        if (!/^HTTP\/1\.1 200\b/.test(header)) {
          sock.destroy();
          resolve({ statusLine: header.split("\r\n")[0], body: "" });
          return;
        }
        buf = tail;
        if (payload) sock.write(payload);
      }
      if (headerDone && buf.length >= ("ECHO:" + payload).length) {
        const text = buf.toString("utf8");
        sock.destroy();
        resolve({ statusLine: "HTTP/1.1 200 Connection Established", body: text });
      }
    });
    sock.on("error", reject);
  });
}

test("路由决策：回环/局域网直连、域名通配符、CIDR、阻断与 proxy.port=0 禁用", () => {
  const cfg = {
    proxy: { host: "127.0.0.1", port: 7897, type: "socks5" },
    proxy_rules: {
      routing: {
        enabled: true,
        priority_mode: "priority",
        default_action: "proxy",
        use_default_private: true,
        rules: [
          { name: "block-telemetry", enabled: true, action: "block", priority: 100, domains: ["*.telemetry.example.com"], protocols: ["tcp"] },
          { name: "direct-corp", enabled: true, action: "direct", priority: 50, domains: ["*.corp.internal"], ip_cidrs_v4: ["203.0.113.0/24"], protocols: ["tcp"] },
          { name: "disabled-rule", enabled: false, action: "block", priority: 999, domains: ["*"], protocols: ["tcp"] },
        ],
      },
    },
  };

  assert.equal(Relay.decideRoute("127.0.0.1", 8080, cfg).action, "direct");
  assert.equal(Relay.decideRoute("192.168.1.50", 443, cfg).action, "direct");
  assert.equal(Relay.decideRoute("10.0.0.1", 443, cfg).action, "direct");
  assert.equal(Relay.decideRoute("foo.local", 443, cfg).action, "direct");
  assert.equal(Relay.decideRoute("a.telemetry.example.com", 443, cfg).action, "block");
  assert.equal(Relay.decideRoute("git.corp.internal", 443, cfg).action, "direct");
  assert.equal(Relay.decideRoute("203.0.113.42", 443, cfg).action, "direct");
  assert.equal(Relay.decideRoute("daily-cloudcode-pa.googleapis.com", 443, cfg).action, "proxy");

  const disabledCfg = { ...cfg, proxy: { host: "127.0.0.1", port: 0, type: "socks5" } };
  assert.equal(Relay.decideRoute("daily-cloudcode-pa.googleapis.com", 443, disabledCfg).action, "direct");
});

test("日志格式与 IDE 插件 logTail.parseLogLine 完全兼容", () => {
  const line = Relay.formatLogLine("info", "[macOS Relay] SOCKS5 代理 www.googleapis.com:443 -> 127.0.0.1:7897");
  const parsed = parseLogLine(line);
  assert.equal(parsed.level, "info");
  assert.equal(parsed.pid, process.pid);
  assert.match(parsed.ts, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.match(parsed.text, /www\.googleapis\.com:443/);
});

test("端到端：本地 HTTP CONNECT 中继 -> 上游 SOCKS5（含账密认证）+ 阻断规则 + 写入日志", async () => {
  const dir = makeTempDir();
  const echo = await startEchoServer();
  const socks = await startMockSocks5Server({ username: "alice", password: "secret", connectToPort: echo.port });
  const cfgPath = path.join(dir, "config.json");
  fs.writeFileSync(cfgPath, JSON.stringify({
    log_level: "info",
    proxy: { host: "127.0.0.1", port: socks.port, type: "socks5", username: "alice", password: "secret" },
    proxy_rules: {
      routing: {
        enabled: true,
        priority_mode: "order",
        default_action: "proxy",
        use_default_private: true,
        rules: [{ name: "deny-ads", enabled: true, action: "block", domains: ["ads.blocked.test"], protocols: ["tcp"] }],
      },
    },
  }));

  const relay = Relay.createRelayServer({ configPath: cfgPath, stateFile: path.join(dir, "relay.json") });
  const { port } = await relay.start();
  try {
    // 1. 经 SOCKS5 带账密转发公网域名（走 ATYP=0x03 远端解析，不泄露本地 DNS）
    const ok = await connectThroughRelay(port, "daily-cloudcode-pa.googleapis.com:443", "hello-socks5");
    assert.equal(ok.body, "ECHO:hello-socks5");
    assert.deepEqual(socks.seenTargets, ["daily-cloudcode-pa.googleapis.com:443"]);

    // 2. 命中 block 规则返回 403
    const blocked = await connectThroughRelay(port, "ads.blocked.test:443", "nope");
    assert.match(blocked.statusLine, /403/);

    // 3. 健康检查端点可用
    const health = await Relay.checkRelayHealth("127.0.0.1", port);
    assert.equal(health?.ok, true);
    assert.equal(health?.upstream?.port, socks.port);

    // 4. 日志文件按 proxy-YYYYMMDD.log 落盘并可被 IDE 插件解析
    const logFiles = fs.readdirSync(path.join(dir, "logs")).filter((f) => /^proxy-\d{8}\.log$/.test(f));
    assert.equal(logFiles.length, 1);
    const content = fs.readFileSync(path.join(dir, "logs", logFiles[0]), "utf8");
    assert.match(content, /daily-cloudcode-pa\.googleapis\.com:443/);
  } finally {
    await relay.stop();
    await socks.close();
    await echo.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("端到端：本地 HTTP CONNECT 中继 -> 上游 HTTP CONNECT（含 Basic Auth）+ 热重载", async () => {
  const dir = makeTempDir();
  const echo = await startEchoServer();
  const httpProxy = await startMockHttpProxy({ username: "bob", password: "pw", connectToPort: echo.port });
  const cfgPath = path.join(dir, "config.json");
  fs.writeFileSync(cfgPath, JSON.stringify({
    log_level: "info",
    proxy: { host: "127.0.0.1", port: httpProxy.port, type: "http", username: "bob", password: "pw" },
  }));

  const relay = Relay.createRelayServer({ configPath: cfgPath });
  const { port } = await relay.start();
  try {
    const ok = await connectThroughRelay(port, "www.googleapis.com:443", "hello-http");
    assert.equal(ok.body, "ECHO:hello-http");
    assert.deepEqual(httpProxy.seenTargets, ["www.googleapis.com:443"]);

    // 修改 config.json 禁用代理并触发 reloadConfig
    fs.writeFileSync(cfgPath, JSON.stringify({
      log_level: "info",
      proxy: { host: "127.0.0.1", port: 0, type: "http" },
    }));
    relay.reloadConfig();
    assert.equal(relay.getConfig().proxy.port, 0);
  } finally {
    await relay.stop();
    await httpProxy.close();
    await echo.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("包装器 agy-acp-proxy：零 stdout 污染、注入代理环境变量并透传退出码", async () => {
  const dir = makeTempDir();
  const cfgPath = path.join(dir, "config.json");
  const stateFile = path.join(dir, "relay.json");
  fs.writeFileSync(cfgPath, JSON.stringify({
    log_level: "info",
    proxy: { host: "127.0.0.1", port: 7897, type: "socks5" },
  }));

  const wrapper = path.resolve(__dirname, "../bin/agy-acp-proxy");
  const res = spawnSync(wrapper, [
    process.execPath,
    "-e",
    "process.stdout.write(JSON.stringify({ https: process.env.HTTPS_PROXY, http: process.env.HTTP_PROXY, marker: process.env.AGP_MACOS_RELAY_URL })); process.exit(7);",
  ], {
    env: { ...process.env, AGP_CONFIG_PATH: cfgPath, AGP_RELAY_STATE: stateFile, AGP_NODE_BIN: process.execPath },
    encoding: "utf8",
  });

  try {
    assert.equal(res.status, 7, `应透传退出码 7，stderr=${res.stderr}`);
    const parsed = JSON.parse(res.stdout);
    assert.match(parsed.https, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(parsed.http, parsed.https);
    assert.equal(parsed.marker, parsed.https);
  } finally {
    // 停止测试拉起的后台中继进程
    try {
      const st = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      if (st?.pid) process.kill(st.pid, "SIGTERM");
    } catch { /* ignore */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
