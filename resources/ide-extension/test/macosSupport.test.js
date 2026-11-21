// macOS 跨平台适配单元测试：node --test resources/ide-extension/test/macosSupport.test.js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { resolveInstallInfo, isMacosRelayActive } = require("../lib/installInfo");
const { parseMacosScutilProxy } = require("../lib/proxyScan");
const { ConfigStore } = require("../lib/configStore");
const { PatchGuard } = require("../lib/patchGuard");
const Acp = require("../lib/acpSupport");
const { buildMacosRelaunchScript } = require("../lib/restart");

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agp-ext-macos-"));
}

test("installInfo(darwin)：配置与日志定位在 ~/.antigravity-proxy，不触碰 .app 内部", () => {
  const tmp = mkTmp();
  try {
    const info = resolveInstallInfo("/Applications/Antigravity.app/Contents/Resources/app", {
      platform: "darwin",
      homeDir: tmp,
      env: {},
    });
    assert.equal(info.supported, true);
    assert.equal(info.mode, "macos-relay");
    assert.equal(info.installDir, path.join(tmp, ".antigravity-proxy"));
    assert.equal(info.configPath, path.join(tmp, ".antigravity-proxy", "config.json"));
    assert.equal(info.logsDir, path.join(tmp, ".antigravity-proxy", "logs"));
    assert.equal(info.dllPath, path.join(tmp, ".antigravity-proxy", "relay", "agp-relay.js"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("isMacosRelayActive：支持 AGP_MACOS_RELAY_URL 与 relay.json + HTTPS_PROXY 双重识别", () => {
  assert.equal(isMacosRelayActive({ AGP_MACOS_RELAY_URL: "http://127.0.0.1:54321" }), true);
  assert.equal(isMacosRelayActive({}), false);
  assert.equal(isMacosRelayActive({ AGP_MACOS_RELAY_URL: "http://example.com:8080" }), false);

  // 真机场景：宿主可能过滤自定义 AGP_* 变量但保留 HTTPS_PROXY，此时通过 relay.json 比对识别
  const tmp = mkTmp();
  try {
    const stateFile = path.join(tmp, "relay.json");
    fs.writeFileSync(stateFile, JSON.stringify({ pid: process.pid, host: "127.0.0.1", port: 54645 }));
    assert.equal(isMacosRelayActive({ HTTPS_PROXY: "http://127.0.0.1:54645" }, stateFile), true);
    assert.equal(isMacosRelayActive({ HTTPS_PROXY: "http://127.0.0.1:7897" }, stateFile), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("parseMacosScutilProxy：正确解析 scutil --proxy 中的 SOCKS 与 HTTPS 代理", () => {
  const sample = `
<dictionary> {
  HTTPEnable : 1
  HTTPPort : 7897
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7897
  HTTPSProxy : 127.0.0.1
  SOCKSEnable : 1
  SOCKSPort : 7898
  SOCKSProxy : 127.0.0.1
}
`;
  const eps = parseMacosScutilProxy(sample);
  assert.deepEqual(eps, [
    { host: "127.0.0.1", port: 7898, hint: "socks5" },
    { host: "127.0.0.1", port: 7897, hint: "http" },
    { host: "127.0.0.1", port: 7897, hint: "http" },
  ]);
  assert.deepEqual(parseMacosScutilProxy("HTTPEnable : 0\nHTTPPort : 7897\nHTTPProxy : 127.0.0.1\n"), []);
});

test("PatchGuard(macos-relay)：支持自动生成默认 config.json 并识别独立安装的 agy-acp-proxy", () => {
  const tmp = mkTmp();
  try {
    const info = resolveInstallInfo("/Applications/Antigravity.app/Contents/Resources/app", {
      platform: "darwin",
      homeDir: tmp,
      env: {},
    });
    const storage = path.join(tmp, "storage");
    const extPath = path.join(tmp, "ext");
    fs.mkdirSync(path.dirname(info.dllPath), { recursive: true });
    fs.writeFileSync(info.dllPath, "// relay stub\n");
    fs.mkdirSync(path.join(info.installDir, "bin"), { recursive: true });
    fs.writeFileSync(path.join(info.installDir, "bin", "agy-acp-proxy"), "#!/bin/sh\n");

    const store = new ConfigStore(info.configPath, storage);
    const guard = new PatchGuard(info, store, extPath);

    assert.equal(guard.check().configExists, false);
    const r = guard.restore();
    assert.equal(r.ok, true);
    assert.equal(guard.check().configExists, true);

    const deployed = guard.deployAcpWrapper();
    assert.equal(deployed.ok, true);
    assert.equal(deployed.path, path.join(info.installDir, "bin", "agy-acp-proxy"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("acpSupport(darwin)：发现 ~/.local/bin/agy、~/.config/zed/settings.json 与 agy-acp-proxy", () => {
  const tmp = mkTmp();
  try {
    const localBin = path.join(tmp, ".local", "bin");
    fs.mkdirSync(localBin, { recursive: true });
    const agyPath = path.join(localBin, "agy");
    fs.writeFileSync(agyPath, "stub");

    const found = Acp.findAgyCandidates({ platform: "darwin", homeDir: tmp, env: {} });
    assert.ok(found.some((t) => t.path === agyPath && t.kind === "agy"));
    assert.equal(Acp.zedSettingsPath({}, tmp, "darwin"), path.join(tmp, ".config", "zed", "settings.json"));

    const analyzed = Acp.analyzeAgentServers(JSON.stringify({
      agent_servers: {
        "Antigravity (Proxy)": { command: "/Users/test/.local/bin/agy-acp-proxy", args: [agyPath, "acp"] },
      },
    }));
    assert.deepEqual(analyzed, { proxied: true, unwrapped: false });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("buildMacosRelaunchScript：对 .app 使用 open -na 并正确转义路径", () => {
  const script = buildMacosRelaunchScript(12345, "/Users/test/Applications/Antigravity (Proxy).app");
  assert.match(script, /MAIN_PID=12345/);
  assert.match(script, /open -na '\/Users\/test\/Applications\/Antigravity \(Proxy\)\.app'/);
});
