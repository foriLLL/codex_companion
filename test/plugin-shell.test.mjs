import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CdpConnection } from "../src/cdp-connection.mjs";
import { reserveLoopbackPort } from "../src/launcher.mjs";
import { listCdpTargets } from "../src/targets.mjs";

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

test("插件启动设置读取成功前不可保存，失败可重试，冲突可恢复且不影响卡片管理", { timeout: 25_000 }, async t => {
  const executable = process.env.CODEX_COMPANION_TEST_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  try { await access(executable, constants.X_OK); }
  catch { t.skip("需要独立 Chromium 验证真实 DOM 交互"); return; }
  const temp = await mkdtemp(join(tmpdir(), "companion-shell-test-"));
  const source = await readFile(new URL("../src/plugin/shell.mjs", import.meta.url), "utf8");
  let chrome, connection;
  const host = createServer((request, response) => {
    response.setHeader("content-type", request.url === "/shell.mjs" ? "text/javascript" : "text/html");
    if (request.url === "/shell.mjs") { response.end(source); return; }
    response.end(`<!doctype html><html><body><script type="module">
      import { createPluginShell } from "/shell.mjs";
      globalThis.errors = [];
      addEventListener("unhandledrejection", event => errors.push(String(event.reason)));
      addEventListener("error", event => errors.push(event.message));
      globalThis.makeFixture = () => {
        globalThis.fixture?.shell.dispose();
        const fixture = { loads: [], saves: [], updates: [], stops: 0, revision: undefined, conflict: false };
        fixture.shell = createPluginShell({ manifests: [],
          onLoadLauncher() {
            let resolve, reject;
            const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
            fixture.loads.push({ resolve, reject });
            return promise.then(result => { fixture.revision = result?.revision; return result; });
          },
          async onSaveLauncher(preferences, relaunch) {
            fixture.saves.push({ preferences, relaunch, revision: fixture.revision });
            if (fixture.conflict) {
              fixture.conflict = false;
              throw Object.assign(new Error("启动偏好已变化"), { code: "CONFIG_CONFLICT" });
            }
          },
          async onUpdateConfig(patch) { fixture.updates.push(patch); },
          async onStopLauncher() { fixture.stops++; return { scheduled: false }; }
        });
        fixture.shell.setConfig({ enabled: true, order: [], cards: {} });
        fixture.shell.ready();
        globalThis.fixture = fixture;
      };
      globalThis.q = selector => fixture.shell.host.querySelector(selector);
    </script></body></html>`);
  });
  t.after(async () => {
    connection?.close();
    chrome?.kill("SIGTERM");
    host.closeAllConnections();
    await new Promise(resolve => host.close(resolve));
    if (chrome && chrome.exitCode === null && chrome.signalCode === null) {
      await Promise.race([new Promise(resolve => chrome.once("exit", resolve)), pause(1500)]);
    }
    await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await new Promise(resolve => host.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${host.address().port}/`;
  const port = await reserveLoopbackPort();
  chrome = spawn(executable, ["--headless=new", "--no-first-run", "--no-default-browser-check",
    "--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${port}`, `--user-data-dir=${join(temp, "profile")}`, url], { stdio: "ignore" });
  let spawnError, target;
  chrome.once("error", error => { spawnError = error; });
  for (let index = 0; index < 80 && !target; index++) {
    if (spawnError) throw spawnError;
    try { target = (await listCdpTargets(port)).find(entry => entry.type === "page"); } catch {}
    if (!target) await pause(100);
  }
  assert.ok(target?.webSocketDebuggerUrl, "隔离 Chromium 未启动");
  connection = new CdpConnection(target.webSocketDebuggerUrl);
  await connection.connect();
  const run = async expression => {
    const result = await connection.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const wait = async expression => {
    for (let index = 0; index < 100; index++) {
      if (await run(expression)) return;
      await pause(20);
    }
    assert.fail(`等待页面状态超时：${expression}`);
  };
  await wait("typeof makeFixture === 'function'");
  await run("makeFixture(); fixture.shell.openSettings(); q('.close-settings').click(); fixture.shell.openSettings()");
  await wait("fixture.loads.length === 1");
  assert.deepEqual(await run(`({
    disabled: ['.launcher-enabled','.launcher-port','.save-launcher','.relaunch-codex'].every(selector => q(selector).disabled),
    exitEnabled: !q('.exit-codex').disabled, cardsEnabled: !q('.master-toggle input').disabled
  })`), { disabled: true, exitEnabled: true, cardsEnabled: true });
  await run("q('.save-launcher').dispatchEvent(new MouseEvent('click')); q('.relaunch-codex').dispatchEvent(new MouseEvent('click'))");
  assert.equal(await run("fixture.saves.length"), 0, "读取期间连程序派发的点击也不能保存默认值");
  await run("fixture.loads[0].resolve({ preferences: { launchThroughProxy: true, proxyPort: 1080 }, revision: 3 })");
  await wait("!q('.save-launcher').disabled");
  assert.deepEqual(await run("({ enabled: q('.launcher-enabled').checked, port: q('.launcher-port').value })"), { enabled: true, port: "1080" });

  await run("makeFixture(); fixture.shell.openSettings()");
  await wait("fixture.loads.length === 1");
  await run("fixture.loads[0].reject(new Error('读取暂时失败'))");
  await wait("!q('.retry-launcher').hidden");
  assert.equal(await run("q('.save-launcher').disabled && q('.relaunch-codex').disabled && !q('.retry-launcher').disabled"), true);
  await run("q('.master-toggle input').click()");
  await wait("fixture.updates.length === 1");
  assert.deepEqual(await run("fixture.updates[0]"), { enabled: false });
  await run("q('.retry-launcher').click(); fixture.shell.openSettings()");
  await wait("fixture.loads.length === 2");
  assert.equal(await run("q('.launcher-port').disabled && q('.retry-launcher').hidden"), true);
  await run("fixture.loads[1].resolve({ preferences: { launchThroughProxy: true, proxyPort: 7891 }, revision: 4 })");
  await wait("!q('.save-launcher').disabled");

  await run("fixture.conflict = true; q('.save-launcher').click()");
  await wait("fixture.loads.length === 3");
  assert.equal(await run("q('.save-launcher').disabled && q('.launcher-port').disabled"), true);
  await run("fixture.loads[2].resolve({ preferences: { launchThroughProxy: false, proxyPort: 8888 }, revision: 5 })");
  await wait("!q('.save-launcher').disabled && q('.launcher-status').textContent.includes('重新保存')");
  assert.equal(await run("q('.launcher-port').value"), "8888");
  await run("q('.save-launcher').click()");
  await wait("fixture.saves.length === 2 && !q('.save-launcher').disabled");
  assert.deepEqual(await run("fixture.saves[1]"), { preferences: { launchThroughProxy: false, proxyPort: 8888 }, relaunch: false, revision: 5 });
  assert.equal(await run("fixture.stops"), 0);

  await run("makeFixture(); fixture.shell.openSettings()");
  await wait("fixture.loads.length === 1");
  await run("fixture.shell.dispose(); fixture.loads[0].resolve({ preferences: { launchThroughProxy: true, proxyPort: 1080 }, revision: 6 })");
  await pause(30);
  assert.deepEqual(await run("errors"), [], "异步读取晚于卸载时不得产生未处理错误");
});
