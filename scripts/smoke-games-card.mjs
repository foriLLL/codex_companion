import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { CdpConnection } from "../src/cdp-connection.mjs";
import { reserveLoopbackPort } from "../src/launcher.mjs";
import { listCdpTargets } from "../src/targets.mjs";

// 独立 HTTP origin/profile 加载实际 ESM 卡片入口，不经过旧 injection 或用户 Codex。
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const server = createServer(async (req, res) => {
  try {
    if (req.url === "/") { res.setHeader("Content-Type", "text/html"); res.end('<body><textarea id="composer"></textarea></body>'); return; }
    const file = resolve(repo, `.${req.url}`);
    if (!file.startsWith(`${repo}${sep}src${sep}`)) { res.writeHead(404); res.end(); return; }
    res.setHeader("Content-Type", "text/javascript"); res.end(await readFile(file));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const profile = await mkdtemp(join(tmpdir(), "companion-games-card-"));
const port = await reserveLoopbackPort();
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
  "--headless=new", "--no-first-run", "--no-default-browser-check",
  "--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, `http://127.0.0.1:${server.address().port}`
], { stdio: "ignore" });
let connection;
try {
  let target;
  for (let index = 0; index < 100 && !target; index++) {
    try { target = (await listCdpTargets(port)).find(value => value.type === "page"); } catch {}
    if (!target) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(target?.webSocketDebuggerUrl);
  connection = new CdpConnection(target.webSocketDebuggerUrl); await connection.connect();
  const run = async expression => {
    const result = await connection.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  await connection.send("Page.navigate", { url: `http://127.0.0.1:${server.address().port}` });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await run(`location.protocol === 'http:' && !!document.getElementById('composer')`)) break;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  await run(`(async () => {
    const [{mount},{createStore},{createEffects},{createGameEngine}] = await Promise.all([
      import('/src/cards/games/renderer.mjs'),import('/src/renderer/platform/storage.mjs'),
      import('/src/renderer/platform/effects.mjs'),import('/src/games.mjs')]);
    globalThis.backend = localStorage;
    const engine=createGameEngine(()=>.42);
    const legacy={version:1,selected:'2048',games:{'2048':{board:[2,2,...Array(14).fill(0)],score:0},mines:{...engine.newMines(),open:[999]},solitaire:engine.newSolitaire()}};
    globalThis.original=JSON.stringify(legacy);
    backend.setItem('codex-companion-games-v1',original);
    globalThis.storageReads=0;globalThis.storageWrites=0;globalThis.errors=[];
    const tracked={getItem:key=>{storageReads++;return backend.getItem(key);},setItem:(key,value)=>{storageWrites++;backend.setItem(key,value);}};
    // 新入口必须仅通过传入 facade 访问，误用 global localStorage 会让场景失败。
    Object.defineProperty(globalThis,'localStorage',{configurable:true,get(){throw Error('unexpected global localStorage access');}});
    globalThis.createInstance=(scope='fixture')=>{
      const host=document.createElement('div');host.style.cssText='width:316px';document.body.append(host);
      const root=host.attachShadow({mode:'open'}),controller=new AbortController();
      const effects=createEffects({signal:controller.signal,onError:error=>errors.push(error.message)});
      const storage={namespace:(name,options)=>createStore({...options,storage:tracked,namespace:'games.'+name,scopeId:scope}),readLegacy:key=>tracked.getItem(key)};
      const handle=mount({root,storage,effects,signal:controller.signal,reportError:error=>errors.push(error.code||error.message)});
      return {host,root,controller,effects,handle};
    };
    globalThis.read=name=>JSON.parse(backend.getItem('games.'+name+'::fixture'));
    globalThis.a=createInstance();globalThis.b=createInstance();
  })()`);
  assert.equal(await run(`a.root.querySelectorAll('.game-tile').length`), 16);
  assert.equal(await run(`a.root.querySelector('.games-card').getRootNode()===a.root`), true);
  assert.equal(await run(`read('2048').value.score`), 0);
  assert.equal(await run(`read('mines').value.open.length`), 0, "只恢复损坏的扫雷");
  assert.equal(await run(`backend.getItem('codex-companion-games-v1')`), await run(`original`));
  assert.equal(await run(`a.effects.diagnostics().listeners`), 2, "登记键盘与指针监听");
  await run(`globalThis.oldCallback=a.root.querySelector('[aria-label="向左移动"]').onclick;a.root.querySelector('.game-board').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true,cancelable:true}))`);
  assert.equal(await run(`read('2048').value.score`), 4);
  assert.equal(await run(`document.getElementById('composer').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true,cancelable:true}))`), true, "不拦截外部输入框");
  await run(`b.root.querySelector('[aria-label="向左移动"]').click()`);
  assert.equal(await run(`read('2048').value.score`), 4, "过期实例不覆盖新存档");
  assert.match(await run(`b.root.querySelector('.game-status').textContent`), /已载入最新进度/);
  assert.equal(await run(`b.root.querySelectorAll('.game-actions button')[1].disabled`), true, "冲突清除受影响游戏的陈旧撤销历史");
  await run(`a.root.querySelectorAll('.game-tabs button')[1].click();a.root.querySelectorAll('.game-mines button')[40].click()`);
  assert.equal(await run(`read('mines').value.over`), false);
  assert.ok(await run(`read('mines').value.open.length`) > 1);
  // 选择项也是独立 CAS，冲突后显示最新选择并给反馈。
  await run(`b.root.querySelectorAll('.game-tabs button')[2].click()`);
  assert.equal(await run(`b.root.querySelectorAll('.game-mines button').length`), 81);
  assert.match(await run(`b.root.querySelector('.game-status').textContent`), /其他实例更新/);
  await run(`a.root.querySelectorAll('.game-tabs button')[2].click();a.root.querySelector('.sol-top button').click()`);
  assert.equal(await run(`read('solitaire').value.waste.length`), 1);
  const saved = await run(`['2048','mines','solitaire','selection'].map(name=>backend.getItem('games.'+name+'::fixture'))`);
  const writesBeforeHide = await run(`storageWrites`);
  await run(`globalThis.sameBoard=a.root.querySelector('.game-board');a.handle.visibilityChanged({visible:false});a.host.hidden=true;a.host.hidden=false;a.handle.visibilityChanged({visible:true})`);
  assert.equal(await run(`a.root.querySelector('.game-board')===sameBoard`), true);
  assert.equal(await run(`storageWrites`), writesBeforeHide);
  // 保存旧 DOM 和回调引用，abort 后手动触发也不能持久化。
  await run(`globalThis.oldRoot=a.root.querySelector('.games-card');globalThis.oldBoard=a.root.querySelector('.game-board');globalThis.lateClick=a.root.querySelector('.sol-top button').onclick;a.controller.abort();a.handle.dispose();lateClick();oldCallback();oldBoard.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}));oldBoard.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`);
  assert.equal(await run(`a.effects.diagnostics().active`), 0);
  assert.equal(await run(`oldRoot.isConnected`), false);
  assert.equal(await run(`storageWrites`), writesBeforeHide);
  assert.deepEqual(await run(`['2048','mines','solitaire','selection'].map(name=>backend.getItem('games.'+name+'::fixture'))`), saved);
  await run(`globalThis.c=createInstance()`);
  assert.equal(await run(`c.root.querySelectorAll('.sol-top .playing-card').length`), 6);
  assert.equal(await run(`read('solitaire').value.waste.length`), 1, "重挂载加载分游戏存档");
  assert.equal(await run(`storageWrites`), writesBeforeHide, "重挂载不整包重写已有存档");
  // 新 scope 从未改动的旧共享数据复制，不串用另一个窗口的新进度。
  await run(`globalThis.other=createInstance('other-window')`);
  assert.equal(await run(`JSON.parse(backend.getItem('games.2048::other-window')).value.score`), 0);
  assert.equal(await run(`read('2048').value.score`), 4);
  await run(`b.controller.abort();c.controller.abort();other.controller.abort()`);
  assert.deepEqual(await run(`[b,c,other].map(instance=>instance.effects.diagnostics().active)`), [0, 0, 0]);
  assert.equal(await run(`backend.getItem('codex-companion-games-v1')`), await run(`original`));
  assert.deepEqual(await run(`errors`), ["STATE_CONFLICT", "STATE_CONFLICT"]);
  console.log("Games card smoke passed: actual ESM entry, per-game migration, scoped storage, gameplay, CAS feedback, hide retention, abort cleanup");
} finally {
  connection?.close(); chrome.kill("SIGTERM"); server.close();
  await new Promise(resolve => { chrome.once("exit", resolve); setTimeout(resolve, 1500).unref(); });
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
