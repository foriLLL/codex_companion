import assert from "node:assert/strict";
import test from "node:test";
import { isCompanionDebugInstance, parseCodexDebugArgs } from "../src/agent/codex-args.mjs";

test("C2 参数：同时支持等号、空格与混合写法", () => {
  for (const args of [
    ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=51234", "--proxy-server=http://127.0.0.1:7890"],
    ["--remote-debugging-address", "127.0.0.1", "--remote-debugging-port", "51234", "--proxy-server", "127.0.0.1:7890"],
    ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port", "51234", "--proxy-server", "http://127.0.0.1:7890"]
  ]) {
    const parsed = parseCodexDebugArgs(args);
    assert.deepEqual(parsed, { known: true, debugPort: 51234, debugAddress: "127.0.0.1", proxyPort: 7890 });
    assert.equal(isCompanionDebugInstance(parsed), true);
  }
});

test("C2 参数：null 是未知，空数组是已知且不带调试参数", () => {
  assert.deepEqual(parseCodexDebugArgs(null), { known: false, debugPort: null, debugAddress: null, proxyPort: null });
  assert.deepEqual(parseCodexDebugArgs([]), { known: true, debugPort: null, debugAddress: null, proxyPort: null });
  for (const args of [undefined, "--remote-debugging-port=51234", [null]]) {
    assert.equal(parseCodexDebugArgs(args).known, false);
  }
  assert.equal(isCompanionDebugInstance(parseCodexDebugArgs(null)), false);
  assert.equal(isCompanionDebugInstance(null), false);
});

test("C2 参数：调试端口只接受 1–65535 的十进制整数", () => {
  for (const value of ["0", "65536", "99999", "-1", "+1", "1.5", "1e3", "0x100", "NaN", "", " 42", "42 ", "42x", "000001"]) {
    for (const args of [[`--remote-debugging-port=${value}`], ["--remote-debugging-port", value]]) {
      const parsed = parseCodexDebugArgs(["--remote-debugging-address=127.0.0.1", ...args]);
      assert.equal(parsed.debugPort, null, value);
      assert.equal(isCompanionDebugInstance(parsed), false, value);
    }
  }
  for (const port of [1, 65535]) {
    assert.equal(parseCodexDebugArgs([`--remote-debugging-port=${port}`]).debugPort, port);
  }
});

test("C2 参数：非 127.0.0.1 或未显式绑定的实例不属于 Companion", () => {
  for (const address of ["0.0.0.0", "::1", "localhost", "127.0.0.2", "192.168.1.1", "", "127.0.0.1 "]) {
    const parsed = parseCodexDebugArgs([`--remote-debugging-address=${address}`, "--remote-debugging-port=51234"]);
    assert.equal(parsed.debugAddress, address);
    assert.equal(isCompanionDebugInstance(parsed), false);
  }
  assert.equal(isCompanionDebugInstance(parseCodexDebugArgs(["--remote-debugging-port=51234"])), false);
});

test("C2 参数：代理只接受本机 HTTP 或无协议的完整地址", () => {
  for (const address of ["127.0.0.1:1", "http://127.0.0.1:65535", "127.0.0.1:07890"]) {
    for (const args of [[`--proxy-server=${address}`], ["--proxy-server", address]]) {
      assert.equal(parseCodexDebugArgs(args).proxyPort, Number(address.split(":").at(-1)));
    }
  }
  for (const address of ["http://10.0.0.2:7890", "http://localhost:7890", "http://[::1]:7890", "https://127.0.0.1:7890",
    "socks5://127.0.0.1:7890", "127.0.0.1:0", "127.0.0.1:65536", "127.0.0.1:-1", "127.0.0.1:123456",
    "127.0.0.1:7890/path", "127.0.0.1:7890;other:80", "user@127.0.0.1:7890", "127.0.0.1:7890 "]) {
    assert.equal(parseCodexDebugArgs(["--proxy-server", address]).proxyPort, null, address);
  }
});

test("C2 参数：缺值、重复标志与相似名称不能认领实例", () => {
  assert.deepEqual(parseCodexDebugArgs(["--remote-debugging-port", "--remote-debugging-address", "127.0.0.1"]), {
    known: true, debugPort: null, debugAddress: "127.0.0.1", proxyPort: null
  });
  for (const flag of ["--remote-debugging-port", "--remote-debugging-address", "--proxy-server"]) {
    assert.equal(parseCodexDebugArgs([flag]).debugPort, null);
  }
  assert.equal(parseCodexDebugArgs(["--remote-debugging-port=51234", "--remote-debugging-port", "51235"]).debugPort, null);
  assert.equal(parseCodexDebugArgs(["--remote-debugging-address=127.0.0.1", "--remote-debugging-address=127.0.0.1"]).debugAddress, null);
  assert.equal(parseCodexDebugArgs(["--proxy-server=127.0.0.1:7890", "--proxy-server=127.0.0.1:7890"]).proxyPort, null);
  assert.deepEqual(parseCodexDebugArgs(["--remote-debugging-ports=51234", "x--remote-debugging-port=51234", "--proxy-server-extra=127.0.0.1:7890"]), {
    known: true, debugPort: null, debugAddress: null, proxyPort: null
  });
});

test("C2 参数：认领判定也拒绝外部传入的非法端口类型和值", () => {
  for (const debugPort of [null, "51234", 0, -1, 65536, 1.5, NaN, Infinity]) {
    assert.equal(isCompanionDebugInstance({ known: true, debugAddress: "127.0.0.1", debugPort }), false);
  }
});
