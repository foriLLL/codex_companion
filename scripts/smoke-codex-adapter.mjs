import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { CdpConnection } from "../src/cdp-connection.mjs";
import { reserveLoopbackPort } from "../src/launcher.mjs";
import { listCdpTargets } from "../src/targets.mjs";
import { createCodexAdapter } from "../src/renderer/adapters/codex.mjs";

// 只启动独立临时 Chrome profile；不访问用户 Codex 的 CDP 端口或配置。
const port = await reserveLoopbackPort();
const profile = await mkdtemp(path.join(os.tmpdir(), "companion-native-adapter-"));
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--autoplay-policy=no-user-gesture-required", "--window-size=1280,900",
  "--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, "about:blank"
], { stdio: "ignore" });
let connection;
try {
  const deadline = Date.now() + 15_000;
  while (!connection && Date.now() < deadline) {
    try {
      const target = (await listCdpTargets(port)).find((entry) => entry.type === "page");
      if (target?.webSocketDebuggerUrl) {
        connection = new CdpConnection(target.webSocketDebuggerUrl);
        await connection.connect();
      }
    } catch {}
    if (!connection) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(connection, "独立 Chromium 必须启动");
  const evaluate = async (expression) => {
    const result = await connection.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  const waitFor = (expression, label) => evaluate(`new Promise((resolve,reject) => {
    const deadline = Date.now() + 4000;
    const poll = () => { if (${expression}) resolve(true); else if(Date.now()>deadline) reject(new Error(${JSON.stringify(label)})); else setTimeout(poll,20); }; poll();
  })`);
  await evaluate(`globalThis.createCodexAdapter = ${createCodexAdapter.toString()}`);
  await evaluate(`(() => {
    document.body.innerHTML = \`
      <style>html,body{margin:0;height:100%;overflow:hidden}header.toolbar{display:flex;justify-content:flex-end;height:40px}header.toolbar>div{display:flex;gap:8px}button{width:28px;height:28px}.thread-scroll-container{position:absolute;inset:48px 0 0;width:100%;height:700px}</style>
      <header class="toolbar"><div><button aria-label="Share">S</button><button id="toggle" aria-label="Toggle pinned summary" aria-pressed="false">T</button></div></header>
      <div class="thread-scroll-container"><div id="frame" style="transform:translateX(-80px)"><div data-thread-user-message-navigation-content>Conversation</div></div><div data-thread-scroll-footer style="transform:translateX(-80px)">Input</div></div>
      <div id="floating-root" class="thread-floating-content-top-inset right-0" style="position:absolute;top:48px;right:0;height:650px;width:316px">
        <div id="summary-animation" class="origin-top-right" style="height:100%;width:316px;opacity:0;transform:none">
          <div id="native-panel" style="height:240px;width:300px;background:white;border-radius:24px"><header>Summary</header><section>Sources</section></div>
        </div>
      </div>\`;
    globalThis.toggle = document.getElementById('toggle');
    toggle.onclick = () => {
      const open = toggle.getAttribute('aria-pressed') !== 'true';
      toggle.setAttribute('aria-pressed', String(open));
      document.getElementById('summary-animation').style.opacity = open ? '1' : '0';
    };
    globalThis.host = document.createElement('div');
    host.id = 'codex-companion-root';
    host.style.cssText = 'display:block;width:300px;height:1100px';
    host.attachShadow({mode:'open'});
    const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 32;
    const ctx = canvas.getContext('2d');
    globalThis.frameTimer = setInterval(() => { ctx.fillStyle = 'rgb('+(Date.now()%255)+',20,40)';ctx.fillRect(0,0,32,32); }, 30);
    globalThis.video = document.createElement('video'); video.muted = true; video.autoplay = true;
    video.srcObject = canvas.captureStream(30); host.shadowRoot.append(video);
    globalThis.events = []; globalThis.errors = [];
    globalThis.nativeBefore = ['floating-root','summary-animation','native-panel','frame'].map(id => document.getElementById(id).style.cssText);
    globalThis.adapter = createCodexAdapter({host,hasCards:false,onVisibilityChange:event=>events.push(event),onError:error=>errors.push(error.message)});
  })()`);
  assert.equal(await evaluate(`host.isConnected || !!document.getElementById('codex-companion-root-shell')`), false, "初始空集合不能挂载占位");
  await evaluate(`adapter.setHasCards(true)`);
  assert.equal(await evaluate(`adapter.isOpen()`), false);
  assert.equal(await evaluate(`!!document.getElementById('codex-companion-root-toolbar')`), true, "优先顶栏入口");
  assert.equal(await evaluate(`host.isConnected`), true, "初始隐藏也连接 host");
  await evaluate(`adapter.setOpen(true)`);
  await waitFor(`adapter.isOpen()`, "独立面板未打开");
  await waitFor(`video.currentTime > .1`, "测试媒体未播放");
  assert.equal(await evaluate(`getComputedStyle(document.getElementById('frame')).transform`), "none", "独立模式撤销原生平移");
  assert.ok(await evaluate(`document.querySelector('.thread-scroll-container').getBoundingClientRect().width < innerWidth - 300`), "对话为卡片让位");
  const beforeHide = await evaluate(`video.currentTime`);
  await evaluate(`adapter.setOpen(false)`);
  await waitFor(`!adapter.isOpen() && document.getElementById('codex-companion-root-shell').shadowRoot.querySelector('.drawer').hidden`, "关闭动画未结束");
  await waitFor(`video.currentTime > ${beforeHide} + .2`, "收起必须继续播放");
  assert.equal(await evaluate(`host.isConnected && video === host.shadowRoot.querySelector('video') && !video.paused`), true);
  assert.equal(await evaluate(`document.querySelector('[data-companion-dock]') === null`), true);
  await evaluate(`adapter.setOpen(true);adapter.setOpen(false);adapter.setOpen(true)`);
  await waitFor(`adapter.isOpen() && document.getElementById('codex-companion-root-shell').shadowRoot.querySelector('.drawer').dataset.state === 'open'`, "快速反向动画");
  await evaluate(`toggle.click()`);
  await waitFor(`!adapter.isOpen()`, "Summary 打开必须关闭独立卡片");
  assert.equal(await evaluate(`toggle.getAttribute('aria-pressed')`), "true");
  await evaluate(`adapter.setOpen(true)`);
  await waitFor(`adapter.isOpen() && toggle.getAttribute('aria-pressed') === 'false'`, "卡片打开必须关闭原生 Summary");
  // 原生状态异步提交时先等待关闭，不重复点击或短暂展示两侧栏。
  await evaluate(`toggle.click();globalThis.nativeClick=toggle.onclick;toggle.onclick=()=>setTimeout(nativeClick,80);adapter.setOpen(true)`);
  assert.equal(await evaluate(`adapter.isOpen()`), false);
  await waitFor(`adapter.isOpen() && toggle.getAttribute('aria-pressed') === 'false'`, "等待原生异步关闭");
  await evaluate(`toggle.onclick=nativeClick;document.getElementById('codex-companion-root-toolbar').shadowRoot.querySelector('button').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,composed:true,cancelable:true}))`);
  await waitFor(`!adapter.isOpen()`, "入口 Escape 应关闭");
  await evaluate(`adapter.setPlacement('inline-in-summary');adapter.setOpen(true)`);
  await waitFor(`adapter.getDiagnostics().mode === 'animated-summary'`, "inline 未挂载");
  assert.equal(await evaluate(`host.style.getPropertyValue('--cc-card-bg') === host.style.getPropertyValue('--hg-panel-bg') && host.style.getPropertyValue('--cc-card-fg') === host.style.getPropertyValue('--hg-panel-color') && !!host.style.getPropertyValue('--cc-card-border')`), true);
  assert.equal(await evaluate(`Math.round(host.getBoundingClientRect().top-document.getElementById('native-panel').getBoundingClientRect().bottom)`), 24);
  assert.equal(await evaluate(`Math.round(host.getBoundingClientRect().left-document.getElementById('native-panel').getBoundingClientRect().left)`), 0);
  assert.equal(await evaluate(`(() => {const panel=document.getElementById('native-panel'),root=document.getElementById('floating-root'),before=panel.getBoundingClientRect().top;root.scrollTop=100;const delta=Math.round(before-panel.getBoundingClientRect().top);root.scrollTop=0;return delta;})()`), 100, "原生 Summary 和卡片共享滚动");
  const beforeInlineHide = await evaluate(`video.currentTime`);
  await evaluate(`adapter.setOpen(false)`);
  await waitFor(`!adapter.isOpen()`, "inline Summary 开关未同步");
  assert.equal(await evaluate(`host.isConnected && host.parentElement.hidden`), true, "inline 关闭保留原 rail/host");
  await waitFor(`video.currentTime > ${beforeInlineHide} + .2`, "inline 收起媒体必须继续");
  await evaluate(`adapter.setOpen(true)`);
  await waitFor(`adapter.isOpen()`, "inline 重新打开");
  assert.equal(await evaluate(`video === host.shadowRoot.querySelector('video') && !video.paused`), true);
  // 保留原生退场动画直到 opacity 归零；scale 期间仍保持 24px 未变换布局间距。
  await evaluate(`toggle.setAttribute('aria-pressed','false');document.getElementById('summary-animation').style.opacity='.04';document.getElementById('summary-animation').style.transform='translateX(50px) scale(.8)'`);
  assert.equal(await evaluate(`adapter.isOpen()`), true);
  assert.equal(await evaluate(`document.getElementById('codex-companion-rail').style.top`), "252px");
  await evaluate(`document.getElementById('summary-animation').style.opacity='0'`);
  await waitFor(`!adapter.isOpen()`, "原生退场未完成");
  // 原生 popover 的 flex 压缩、共享滚动和状态还原。
  await evaluate(`(() => {
    toggle.setAttribute('aria-label','Toggle summary');toggle.setAttribute('aria-controls','popover');toggle.dataset.state='open';
    const popover=document.createElement('div');popover.id='popover';popover.setAttribute('role','dialog');popover.dataset.state='open';
    popover.style.cssText='position:absolute;top:48px;right:0';
    popover.innerHTML='<div id="stack" style="display:flex;max-height:650px;flex-direction:column;width:300px"><div id="popover-panel" style="height:300px;width:300px;flex:none;background:white;border-radius:24px">Summary</div></div>';
    document.body.append(popover);
  })()`);
  await waitFor(`adapter.getDiagnostics().mode === 'summary-popover'`, "popover 未识别");
  assert.equal(await evaluate(`Math.round(host.getBoundingClientRect().top-document.getElementById('popover-panel').getBoundingClientRect().bottom)`), 24);
  assert.equal(await evaluate(`getComputedStyle(document.getElementById('stack')).overflowY`), "auto");
  await evaluate(`globalThis.oldPanel=document.getElementById('popover-panel');document.getElementById('popover').remove();toggle.removeAttribute('aria-controls');toggle.removeAttribute('data-state')`);
  await waitFor(`!adapter.isOpen() && host.isConnected`, "原生删除父节点后必须停放 host");
  assert.equal(await evaluate(`oldPanel.style.height`), "300px");
  assert.equal(await evaluate(`oldPanel.style.getPropertyPriority('height')`), "");
  // 入口锚点缺失时仍有独立按钮。
  await evaluate(`document.querySelector('header.toolbar').style.display='none';adapter.setPlacement('standalone-button');adapter.setOpen(true)`);
  await waitFor(`adapter.isOpen()`, "悬浮入口打开");
  assert.equal(await evaluate(`document.getElementById('codex-companion-root-shell').shadowRoot.querySelector('button').hidden`), false);
  await connection.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await evaluate(`adapter.setOpen(false)`);
  await waitFor(`document.getElementById('codex-companion-root-shell').shadowRoot.querySelector('.drawer').hidden`, "减少动态效果关闭");
  assert.equal(await evaluate(`document.getElementById('codex-companion-root-shell').shadowRoot.querySelector('.drawer').getAnimations().length`), 0);
  await evaluate(`adapter.setHasCards(false)`);
  assert.equal(await evaluate(`host.isConnected || !!document.getElementById('codex-companion-root-shell') || !!document.querySelector('[data-companion-dock]')`), false, "空集合无入口或占位");
  await evaluate(`adapter.setHasCards(true);adapter.setOpen(true)`);
  await waitFor(`adapter.isOpen()`, "重新启用");
  assert.equal(await evaluate(`video === host.shadowRoot.querySelector('video')`), true);
  await evaluate(`adapter.dispose();adapter.dispose()`);
  assert.equal(await evaluate(`host.isConnected || !!document.getElementById('codex-companion-root-shell') || !!document.getElementById('codex-companion-root-toolbar') || !!document.querySelector('[data-companion-dock]')`), false);
  assert.equal(await evaluate(`adapter.getDiagnostics().disposed`), true);
  assert.equal(await evaluate(`document.getElementById('floating-root').style.cssText === nativeBefore[0]`), true, "原生滚动样式还原");
  assert.equal(await evaluate(`document.getElementById('native-panel').style.cssText === nativeBefore[2]`), true);
  assert.equal(await evaluate(`document.getElementById('frame').style.cssText === nativeBefore[3]`), true);
  assert.deepEqual(await evaluate(`errors`), []);
  const evidence = await evaluate(`({events:events.length,moveFallbacks:adapter.getDiagnostics().moveFallbacks,final:events.at(-1),moveBefore:typeof Element.prototype.moveBefore})`);
  // 新版嵌套 Summary，样式和 marker 均须在 dispose 后原样恢复。
  await evaluate(`(() => {
    document.body.innerHTML='<button id="modern-toggle" aria-label="Toggle pinned summary" aria-pressed="true"></button><div id="modern-root" class="thread-floating-content-top-inset right-0" style="position:absolute;top:48px;bottom:16px;right:0;width:316px"><div style="position:relative;max-height:100%;width:316px"><div id="modern-scroll" data-codex-companion-scroll-root="original-scroll" style="position:absolute;top:0;bottom:0;left:0;width:300px"><div id="modern-column" class="origin-top-right" data-codex-companion-animation-column="original-column" style="opacity:1;width:300px;position:static!important"><div style="display:flex;flex-direction:column"><div id="modern-native" style="height:430px;width:300px;border-radius:24px;background:white">Summary</div></div></div></div></div></div>';
    globalThis.modernAdapter=createCodexAdapter({host,placement:'inline-in-summary',onError:error=>errors.push(error.message)});
  })()`);
  assert.equal(await evaluate(`modernAdapter.getDiagnostics().mode`), "animated-summary");
  assert.deepEqual(await evaluate(`(() => {
    const panel=document.getElementById('modern-native'),scroll=document.getElementById('modern-scroll');
    const gap=Math.round(host.getBoundingClientRect().top-panel.getBoundingClientRect().bottom);
    const x=Math.round(host.getBoundingClientRect().left-panel.getBoundingClientRect().left);
    const before=panel.getBoundingClientRect().top;scroll.scrollTop=120;
    return {gap,x,delta:Math.round(before-panel.getBoundingClientRect().top),height:scroll.clientHeight,available:Math.floor(innerHeight-64)};
  })()`), { gap: 24, x: 0, delta: 120, height: await evaluate(`Math.floor(innerHeight-64)`), available: await evaluate(`Math.floor(innerHeight-64)`) });
  await evaluate(`modernAdapter.dispose()`);
  assert.deepEqual(await evaluate(`({scroll:document.getElementById('modern-scroll').getAttribute('data-codex-companion-scroll-root'),column:document.getElementById('modern-column').getAttribute('data-codex-companion-animation-column'),position:document.getElementById('modern-column').style.position,priority:document.getElementById('modern-column').style.getPropertyPriority('position')})`), { scroll: "original-scroll", column: "original-column", position: "static", priority: "important" });
  // 原生测量失败必须恢复修改并提供入口，回调抛错不能摧毁布局。
  await evaluate(`(() => {
    const panel=document.getElementById('modern-native');
    const measure=panel.getBoundingClientRect.bind(panel);
    let fail=true;
    panel.getBoundingClientRect=()=>{if(fail){fail=false;throw new Error('fixture-native-measure');}return measure();};
    globalThis.fallbackErrors=[];
    globalThis.fallbackAdapter=createCodexAdapter({host,placement:'inline-in-summary',onError:error=>fallbackErrors.push(error.message),onVisibilityChange:()=>{throw new Error('fixture-listener');}});
  })()`);
  assert.equal(await evaluate(`fallbackAdapter.getDiagnostics().fallbackActive`), true);
  assert.equal(await evaluate(`fallbackErrors.includes('fixture-native-measure') && fallbackErrors.includes('fixture-listener')`), true);
  assert.equal(await evaluate(`document.getElementById('codex-companion-root-shell').shadowRoot.querySelector('button').hidden`), false);
  await evaluate(`document.getElementById('modern-toggle').setAttribute('aria-pressed','false');document.getElementById('modern-column').style.opacity='0';fallbackAdapter.setOpen(true)`);
  await waitFor(`fallbackAdapter.isOpen()`, "异常降级按钮仍可打开");
  await evaluate(`fallbackAdapter.dispose()`);
  assert.equal(await evaluate(`document.getElementById('modern-scroll').getAttribute('data-codex-companion-scroll-root')`), "original-scroll");

  await evaluate(`clearInterval(frameTimer);video.srcObject.getTracks().forEach(track=>track.stop())`);
  console.log("Codex adapter smoke passed:", JSON.stringify(evidence));
} finally {
  connection?.close();
  chrome.kill("SIGTERM");
  await new Promise((resolve) => { chrome.once("exit", resolve);setTimeout(resolve, 2000).unref(); });
  await rm(profile, { recursive: true, force: true });
}
