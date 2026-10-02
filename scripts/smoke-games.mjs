import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { CdpConnection } from "../src/cdp-connection.mjs";
import { reserveLoopbackPort } from "../src/launcher.mjs";
import { listCdpTargets } from "../src/targets.mjs";
import { buildInjectionSource } from "../src/injection.mjs";
const server = createServer((req, res) => { res.setHeader("Content-Type", "text/html"); res.end('<body style="font-family:system-ui"><textarea id="composer"></textarea><button aria-label="Toggle summary" aria-pressed="false">Summary</button></body>'); });
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const port = await reserveLoopbackPort(), profile = await mkdtemp(join(tmpdir(), "companion-games-"));
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", "--no-first-run", "--no-default-browser-check", "--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, `http://127.0.0.1:${server.address().port}`], { stdio: "ignore" });
let connection;
const sleep = ms => new Promise(r => setTimeout(r, ms));
try {
  let target;
  for (let i = 0; i < 100 && !target; i++) { try { target = (await listCdpTargets(port)).find(t => t.type === "page"); } catch {} if (!target) await sleep(100); }
  connection = new CdpConnection(target.webSocketDebuggerUrl); await connection.connect();
  const run = async expression => { const r = await connection.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
  await connection.send("Emulation.setDeviceMetricsOverride", { width: 1000, height: 1000, deviceScaleFactor: 1, mobile: false });
  const mount = buildInjectionSource("mount", { cards: { games: true, hongguo: false, riverclub: false, emby: false } });
  await sleep(300);
  await run(mount);
  await run(`globalThis.r = document.getElementById('codex-companion-root-shell').shadowRoot.querySelector('#codex-companion-root').shadowRoot; globalThis.g = r.querySelector('[data-card=games]');`);
  // 使用产品入口打开，保留真实收起/重挂载行为。
  await run(`document.querySelector('#codex-companion-toolbar-entry')?.shadowRoot?.querySelector('button')?.click();`);
  const buttons = await run(`Array.from(document.querySelectorAll('*')).filter(e => e.shadowRoot).map(e=>({id:e.id,buttons:Array.from(e.shadowRoot.querySelectorAll('button')).map(b=>b.getAttribute('aria-label'))}))`);
  // 不同布局的入口可能在 shell；依据当前生成的 DOM 查找。
  await run(`(() => { for (const e of document.querySelectorAll('*')) { const b = e.shadowRoot?.querySelector('[aria-expanded="false"]'); if (b && b.getAttribute('aria-label')?.includes('卡片')) b.click(); } })()`);
  await sleep(250);
  assert.equal(await run(`g.querySelectorAll('.game-tile').length`), 16);
  // 固定棋局验证真实方向键事件，并确认不会截获输入框按键。
  await run(`(() => { const d=JSON.parse(localStorage.getItem('codex-companion-games-v1')); d.games['2048']={board:[2,2,0,0,...Array(12).fill(0)],score:0}; localStorage.setItem('codex-companion-games-v1',JSON.stringify(d)); })()`);
  // 卸载会保存旧状态，因此先卸载，再写入目标棋局。
  await run(buildInjectionSource("unmount"));
  await run(`(() => { const d=JSON.parse(localStorage.getItem('codex-companion-games-v1')); d.games['2048']={board:[2,2,0,0,...Array(12).fill(0)],score:0}; localStorage.setItem('codex-companion-games-v1',JSON.stringify(d)); })()`);
  await run(mount);
  await run(`globalThis.r=document.getElementById('codex-companion-root-shell').shadowRoot.querySelector('#codex-companion-root').shadowRoot; globalThis.g=r.querySelector('[data-card=games]'); g.querySelector('.game-board').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true,cancelable:true}));`);
  assert.equal(await run(`JSON.parse(localStorage.getItem('codex-companion-games-v1')).games['2048'].score`), 4);
  assert.equal(await run(`document.querySelector('#composer').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true,cancelable:true}))`), true);
  await run(`g.querySelectorAll('.game-tabs button')[1].click(); g.querySelectorAll('.game-mines button')[40].click();`);
  assert.equal(await run(`JSON.parse(localStorage.getItem('codex-companion-games-v1')).games.mines.over`), false);
  assert.ok(await run(`g.querySelectorAll('.game-mines .open').length`) > 1);
  await run(`g.querySelectorAll('.game-tabs button')[2].click(); g.querySelector('.sol-top button').click();`);
  assert.equal(await run(`JSON.parse(localStorage.getItem('codex-companion-games-v1')).games.solitaire.waste.length`), 1);
  const saved = await run(`localStorage.getItem('codex-companion-games-v1')`);
  await run(buildInjectionSource("unmount")); await run(mount);
  assert.equal(await run(`localStorage.getItem('codex-companion-games-v1')`), saved);
  await run(`globalThis.r=document.getElementById('codex-companion-root-shell').shadowRoot.querySelector('#codex-companion-root').shadowRoot; globalThis.g=r.querySelector('[data-card=games]');`);
  await run(`(() => { for (const e of document.querySelectorAll('*')) { const b = e.shadowRoot?.querySelector('[aria-expanded="false"]'); if (b && b.getAttribute('aria-label')?.includes('卡片')) b.click(); } })()`);
  await sleep(250);
  // 穷举开关组合与两种顺序：隐藏项不能吃掉两个可见卡片之间的间距。
  await run(`(() => {
    const cards = [...r.querySelectorAll('.panel')];
    const original = cards.map(c => c.hidden);
    for (const order of [cards, [...cards].reverse()]) {
      order.forEach(c => r.append(c));
      for (let mask = 1; mask < 16; mask++) {
        order.forEach((c, i) => c.hidden = !(mask & (1 << i)));
        const visible = order.filter(c => !c.hidden);
        visible.forEach((c, i) => {
          const margin = parseFloat(getComputedStyle(c).marginTop);
          if (margin !== (i ? 24 : 0)) throw Error('卡片间距错误: ' + c.dataset.card + ' mask=' + mask + ' margin=' + margin);
          if (i) {
            const gap = c.getBoundingClientRect().top - visible[i - 1].getBoundingClientRect().bottom;
            if (Math.abs(gap - 24) > 1) throw Error('实际卡片间距错误: ' + gap);
          }
        });
      }
    }
    cards.forEach((c, i) => { r.append(c); c.hidden = original[i]; });
    r.querySelector('[data-card=riverclub]').hidden = false;
  })()`);
  // 保存卡片截图，以便检查窄栏内牌面是否可读。
  const rect = await run(`(() => {const b=g.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height,scale:1}})()`);
  assert.ok(rect.width > 200 && rect.height > 300, JSON.stringify({rect,buttons}));
  const shot = await connection.send("Page.captureScreenshot", { format: "png", clip: rect });
  await writeFile("/tmp/companion-r15-games.png", Buffer.from(shot.data, "base64"));
  // 收起/展开不重建棋局。
  await run(`(() => { for (const e of document.querySelectorAll('*')) { const b=e.shadowRoot?.querySelector('[aria-expanded="true"]'); if(b?.getAttribute('aria-label')?.includes('卡片')) b.click(); } })()`);
  await sleep(200);
  assert.equal(await run(`localStorage.getItem('codex-companion-games-v1')`), saved);
  console.log("PASS: 2048 按键合并 / 输入框隔离 / 扫雷首击 / 接龙翻牌 / 收起与重挂载存档；截图 /tmp/companion-r15-games.png");
} finally { connection?.close(); chrome.kill("SIGTERM"); server.close(); await sleep(500); await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
