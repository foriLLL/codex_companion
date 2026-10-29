import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import http from "node:http";
import { CdpConnection } from "../src/cdp-connection.mjs";
import { reserveLoopbackPort } from "../src/launcher.mjs";
import { listCdpTargets } from "../src/targets.mjs";
import { createCodexAdapter } from "../src/renderer/adapters/codex.mjs";

// 原生 thread-summary-panel-layout chunk 的同构替身：函数体照抄原生，导出名故意打乱，
// 验证适配器按行为而非导出名识别。
const nativeLayoutSource = `function a(e,t=300){let n=(e-736)/2,r=t-300;return n<180+r/2?"overlay":n<400+r?"shift":"gutter"}
function b({displayMode:e,isPinned:t,isPopoverOpen:n}){let r=t&&e!=="overlay",i=null;return r?i="inline":e==="overlay"&&n&&(i="popover"),{displayMode:e,shouldHideInlineImmediately:e==="overlay"&&n,shouldShow:r,visibleSurface:i}}
function c({displayMode:e,isPinned:t,panelWidth:n=300}){return t&&e==="shift"?-(308+n-300)/2:0}
function d(){}
export { d as q, c as w, a as k, b as z };`;
const layoutServer = http.createServer((request, response) => {
  if (!request.url?.startsWith("/assets/thread-summary-panel-layout-")) { response.writeHead(404).end(); return; }
  response.writeHead(200, { "content-type": "text/javascript", "access-control-allow-origin": "*" }).end(nativeLayoutSource);
});
await new Promise((resolve) => layoutServer.listen(0, "127.0.0.1", resolve));
const layoutUrl = `http://127.0.0.1:${layoutServer.address().port}/assets/thread-summary-panel-layout-0a1b2c3d.js`;

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
  assert.equal(await evaluate(`getComputedStyle(document.getElementById('frame')).transform`), "matrix(1, 0, 0, 1, -80, 0)", "不改写原生自己的平移");
  assert.equal(await evaluate(`document.querySelector('.thread-scroll-container').getBoundingClientRect().width === innerWidth && adapter.getDiagnostics().drawerSurface`), "floating", "无原生布局模块时浮在会话上方，不收窄");
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
  // Summary 变体：无 origin-top-right 动画列，面板经 display:contents 包装在 flex 纵列里。
  await evaluate(`(() => {
    document.body.innerHTML='<header style="display:flex;justify-content:flex-end"><button id="variant-toggle" aria-label="Toggle pinned summary" aria-pressed="true"><svg></svg></button><button aria-label="New tab"><svg></svg></button></header><div class="thread-floating-content-top-inset right-0" style="display:none"><div style="display:flex;flex-direction:column;width:300px"><div style="display:contents"><div data-summary-panel-variant="summary" style="height:212px;border-radius:20px;background:white">后台标签</div></div></div></div><div id="variant-root" class="thread-floating-content-top-inset right-0" style="position:absolute;top:48px;bottom:16px;right:0;max-width:100%"><div style="position:relative;display:flex;max-height:100%;padding-right:8px"><div id="variant-scroll" style="max-height:100%;min-height:0"><div id="variant-column" style="display:flex;flex-direction:column;gap:12px;max-height:100%;width:300px"><div style="display:contents"><div id="variant-native" data-summary-panel-variant="summary" style="display:flex;flex-direction:column;height:212px;width:300px;border-radius:20px;background:white">Summary</div></div></div></div></div></div>';
    globalThis.variantAdapter=createCodexAdapter({host,placement:'inline-in-summary',onError:error=>errors.push(error.message)});
  })()`);
  assert.equal(await evaluate(`variantAdapter.getDiagnostics().mode`), "animated-summary", "Summary 变体应挂在摘要下方");
  assert.equal(await evaluate(`Math.round(host.getBoundingClientRect().top-document.getElementById('variant-native').getBoundingClientRect().bottom)`), 24);
  await evaluate(`variantAdapter.dispose()`);
  // 未知结构：Summary 已打开却定位不到面板时，短暂等待后退回独立入口，不能让入口消失。
  await evaluate(`(() => {
    document.body.innerHTML='<header style="display:flex;justify-content:flex-end"><button aria-label="Toggle pinned summary" aria-pressed="true" onclick="this.setAttribute(\\'aria-pressed\\',String(this.getAttribute(\\'aria-pressed\\')!==\\'true\\'))"><svg></svg></button><button aria-label="New tab"><svg></svg></button></header><div style="position:absolute;top:48px;right:0;width:300px;height:200px;border-radius:20px;background:white">Unknown summary</div>';
    globalThis.unknownAdapter=createCodexAdapter({host,placement:'inline-in-summary',onError:error=>errors.push(error.message)});
  })()`);
  assert.equal(await evaluate(`unknownAdapter.getDiagnostics().summaryUnsupported`), false, "宽限期内不立即切换");
  await waitFor(`unknownAdapter.getDiagnostics().summaryUnsupported && unknownAdapter.getDiagnostics().inlineEntryFallback`, "未知 Summary 结构退回独立入口");
  assert.equal(await evaluate(`Boolean(document.getElementById('codex-companion-root-toolbar')?.isConnected) || document.getElementById('codex-companion-root-shell').shadowRoot.querySelector('button').hidden === false`), true, "退回后顶栏或悬浮入口可见");
  await evaluate(`unknownAdapter.setOpen(true)`);
  await waitFor(`unknownAdapter.isOpen()`, "退回后入口可打开");
  assert.equal(await evaluate(`unknownAdapter.getDiagnostics().inlineEntryFallback`), true, "Summary 关闭后仍保持独立入口");
  await evaluate(`unknownAdapter.dispose()`);
  // 新版标题栏右侧只剩一个按钮（New tab），分组内也只有它：入口仍进顶栏，放在它左侧。
  await evaluate(`(() => {
    document.body.innerHTML='<header style="position:fixed;top:0;left:0;right:0;height:44px;display:flex"><div style="display:flex;gap:6px"><button aria-label="Back">B</button></div><div style="margin-left:auto;display:inline-flex;height:100%;align-items:center"><div style="display:flex;gap:6px;align-items:center"><div><button id="new-tab" aria-label="New tab" style="width:28px;height:28px">+</button></div></div></div></header>';
    globalThis.titlebarAdapter=createCodexAdapter({host,onError:error=>errors.push(error.message)});
  })()`);
  await waitFor(`!!document.getElementById('codex-companion-root-toolbar')`, "标题栏只有单个按钮时未进入顶栏");
  assert.deepEqual(await evaluate(`(() => {
    const entry=document.getElementById('codex-companion-root-toolbar').getBoundingClientRect(), tab=document.getElementById('new-tab').getBoundingClientRect();
    return {leftOfNative:entry.right<=tab.left, sameRow:Math.round(entry.top)===Math.round(tab.top), nativeAtEdge:Math.round(innerWidth-tab.right)===0,
      floatingHidden:document.getElementById('codex-companion-root-shell').shadowRoot.querySelector('button').hidden};
  })()`), { leftOfNative: true, sameRow: true, nativeAtEdge: true, floatingHidden: true });
  await evaluate(`titlebarAdapter.setOpen(true)`);
  await waitFor(`titlebarAdapter.isOpen()`, "顶栏入口打开");
  await evaluate(`titlebarAdapter.dispose()`);
  assert.equal(await evaluate(`!!document.getElementById('codex-companion-root-toolbar')`), false, "dispose 移除顶栏入口");
  assert.deepEqual(await evaluate(`errors`), []);

  // 原生 Summary 布局：判定来自原生 layout chunk（这里用导出名打乱的同构替身），
  // 平移只写原生的 --thread-content-x，由原生 _shiftWithTranscript_* 样式完成。
  // gutter 留白=(宽度-736)/2：<180 overlay，<400 shift（平移 154px），其余 gutter。
  await connection.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
  await evaluate(`(() => {
    document.body.innerHTML='<style>._shiftWithTranscript_t_2{translate:var(--thread-content-x,none);--thread-wide-block-inline-shift:max(var(--thread-content-x,0px), calc(-1 * var(--thread-content-x,0px)))}</style>'
      + '<link rel="modulepreload" href="${layoutUrl}">'
      + '<header style="position:fixed;top:0;left:0;right:0;height:44px;display:flex"><div style="margin-left:auto;display:flex;gap:6px"><div><button aria-label="New tab" style="width:28px;height:28px">+</button></div></div></header>'
      + '<div id="layout-root" data-request-input-activity-root style="position:absolute;top:48px;left:0;width:1280px;height:700px;--thread-content-x: initial;">'
      + '<div class="thread-scroll-container" style="height:100%;overflow:auto"><div id="shift-column" class="_shiftWithTranscript_t_2"><div data-thread-user-message-navigation-content style="max-width:736px;margin:0 auto">Conversation</div></div></div>'
      + '<div id="shift-footer" class="_shiftWithTranscript_t_2" style="position:absolute;left:0;right:0;bottom:0">Input</div></div>';
    globalThis.shiftAdapter=createCodexAdapter({host,onError:error=>errors.push(error.message)});
    globalThis.shiftOf=(id)=>{const t=getComputedStyle(document.getElementById(id)).translate;return t==='none'?0:-parseFloat(t);};
    globalThis.drawerOf=()=>document.getElementById('codex-companion-root-shell').shadowRoot.querySelector('.drawer');
    globalThis.setRootWidth=(width)=>new Promise(resolve=>{document.getElementById('layout-root').style.width=width+'px';requestAnimationFrame(()=>requestAnimationFrame(resolve));});
    globalThis.sampleShift=(ms)=>new Promise(resolve=>{const out=[],start=performance.now();const tick=()=>{out.push(Math.round(shiftOf('shift-column')*10)/10);if(performance.now()-start<ms)requestAnimationFrame(tick);else resolve(out);};requestAnimationFrame(tick);});
  })()`);
  await waitFor(`shiftAdapter.getDiagnostics().nativeLayout && shiftAdapter.getDiagnostics().displayMode === 'shift'`, "加载原生布局模块并判定 shift 档");
  const expectedShift = 154;
  const opening = await evaluate(`(async()=>{shiftAdapter.setOpen(true);return sampleShift(500);})()`);
  assert.equal(opening.at(-1), expectedShift, "平移量取自原生模块");
  assert.ok(opening.filter((value) => value > 0 && value < expectedShift).length >= 5, `打开需逐帧平移：${opening.join(",")}`);
  assert.ok(opening.every((value, index) => index === 0 || value >= opening[index - 1] - 0.5), "打开平移单调");
  assert.deepEqual(await evaluate(`({footer:Math.round(shiftOf('shift-footer')),surface:shiftAdapter.getDiagnostics().drawerSurface,width:Math.round(drawerOf().getBoundingClientRect().width)})`),
    { footer: expectedShift, surface: "inline", width: 324 }, "输入框同步平移，抽屉与原生面板同宽");
  const reversed = await evaluate(`(async()=>{shiftAdapter.setOpen(false);const head=await sampleShift(90);shiftAdapter.setOpen(true);const tail=await sampleShift(500);return {head,tail};})()`);
  const jump = Math.abs(reversed.tail[0] - reversed.head.at(-1));
  assert.ok(reversed.head.at(-1) < expectedShift && reversed.head.at(-1) > 0, `关闭中途：${reversed.head.join(",")}`);
  assert.ok(jump < 40, `中途反向必须从当前帧继续，跳变 ${jump}px`);
  assert.equal(reversed.tail.at(-1), expectedShift);

  // 常驻打开时拖窄到 overlay 档：与原生一样直接消失、会话回位；拖回宽档后重新出现。
  await evaluate(`setRootWidth(1000)`);
  await waitFor(`shiftAdapter.getDiagnostics().displayMode === 'overlay' && drawerOf().dataset.state === 'closed'`, "overlay 档常驻抽屉应消失");
  assert.deepEqual(await evaluate(`({shift:shiftOf('shift-column'),open:shiftAdapter.isOpen()})`), { shift: 0, open: false }, "overlay 档不平移");
  await evaluate(`setRootWidth(1280)`);
  await waitFor(`shiftAdapter.isOpen() && drawerOf().dataset.state === 'open' && shiftOf('shift-column') === ${expectedShift}`, "回到 shift 档常驻抽屉重新出现");

  // overlay 档点入口：浮在会话上方不平移；拖回宽档时浮层收起，常驻开关不受影响。
  await evaluate(`shiftAdapter.setOpen(false)`);
  await waitFor(`drawerOf().dataset.state === 'closed' && !document.querySelector('[data-companion-dock]')`, "关闭后撤销平移标记");
  assert.equal(await evaluate(`document.getElementById('layout-root').getAttribute('style').includes('--thread-content-x: initial')`), true, "原生 inline style 原样保留");
  await evaluate(`setRootWidth(1000)`);
  await waitFor(`shiftAdapter.getDiagnostics().displayMode === 'overlay'`, "切到 overlay 档");
  await evaluate(`document.getElementById('codex-companion-root-toolbar').shadowRoot.querySelector('button').click()`);
  await waitFor(`shiftAdapter.isOpen() && drawerOf().dataset.state === 'open'`, "overlay 档点入口浮出抽屉");
  assert.deepEqual(await evaluate(`({surface:shiftAdapter.getDiagnostics().drawerSurface,shift:shiftOf('shift-column'),marks:document.querySelectorAll('[data-companion-dock]').length})`),
    { surface: "popover", shift: 0, marks: 0 }, "浮层不推会话");
  await evaluate(`setRootWidth(1280)`);
  await waitFor(`shiftAdapter.getDiagnostics().displayMode === 'shift' && !shiftAdapter.isOpen()`, "离开 overlay 档浮层收起");

  // gutter 档（留白足够）：常驻打开但不平移。
  await evaluate(`setRootWidth(1600)`);
  await evaluate(`shiftAdapter.setOpen(true)`);
  await waitFor(`shiftAdapter.getDiagnostics().displayMode === 'gutter' && shiftAdapter.isOpen()`, "gutter 档打开");
  assert.deepEqual(await evaluate(`({surface:shiftAdapter.getDiagnostics().drawerSurface,shift:shiftOf('shift-column')})`), { surface: "inline", shift: 0 }, "gutter 档不平移");
  await evaluate(`shiftAdapter.dispose()`);
  assert.equal(await evaluate(`!!document.querySelector('[data-companion-dock]') || !!document.getElementById('codex-companion-root-dock-style')`), false, "dispose 撤销平移");
  assert.deepEqual(await evaluate(`errors`), []);

  // 没有原生布局模块：不自行判定、不平移，抽屉浮在会话上方。
  await evaluate(`(() => {
    document.querySelector('link[rel=modulepreload]').remove();
    performance.clearResourceTimings();
    document.getElementById('layout-root').style.width='1280px';
    globalThis.bareAdapter=createCodexAdapter({host,onError:error=>errors.push(error.message)});
  })()`);
  await evaluate(`bareAdapter.setOpen(true)`);
  await waitFor(`bareAdapter.isOpen() && drawerOf().dataset.state === 'open'`, "无原生模块时仍可打开");
  assert.deepEqual(await evaluate(`({native:bareAdapter.getDiagnostics().nativeLayout,surface:bareAdapter.getDiagnostics().drawerSurface,shift:shiftOf('shift-column')})`),
    { native: false, surface: "floating", shift: 0 }, "无原生模块时只浮层");
  await evaluate(`bareAdapter.dispose()`);
  assert.deepEqual(await evaluate(`errors`), []);

  // 侧聊关闭确认等 Codex 模态弹窗：遮罩（z-50）与确认框必须盖过已打开的抽屉，关闭后抽屉恢复置顶。
  await evaluate(`(() => {
    document.body.innerHTML='<header class="toolbar" style="display:flex;justify-content:flex-end;height:40px"><div><button aria-label="Share">S</button></div></header>'
      + '<div class="thread-scroll-container" style="position:absolute;inset:48px 0 0"><div data-thread-user-message-navigation-content>Conversation</div></div>';
    globalThis.modalAdapter=createCodexAdapter({host,onError:error=>errors.push(error.message)});
  })()`);
  await evaluate(`modalAdapter.setOpen(true)`);
  await waitFor(`modalAdapter.isOpen() && document.getElementById('codex-companion-root-shell').shadowRoot.querySelector('.drawer').dataset.state === 'open'`, "弹窗场景抽屉打开");
  const drawerHit = `(() => {
    const drawer=document.getElementById('codex-companion-root-shell').shadowRoot.querySelector('.drawer').getBoundingClientRect();
    return document.elementFromPoint(drawer.x+drawer.width/2,drawer.y+40);
  })()`;
  assert.equal(await evaluate(`${drawerHit}?.id`), "codex-companion-root-shell", "无弹窗时抽屉置顶");
  await evaluate(`(() => {
    const overlay=document.createElement('div');
    overlay.id='modal-overlay';overlay.className='codex-dialog-overlay';
    overlay.style.cssText='position:fixed;inset:0;z-index:50;pointer-events:auto';
    document.body.append(overlay);
  })()`);
  await waitFor(`${drawerHit}?.id === 'modal-overlay'`, "模态遮罩必须盖过抽屉");
  await evaluate(`document.getElementById('modal-overlay').remove()`);
  await waitFor(`${drawerHit}?.id === 'codex-companion-root-shell'`, "弹窗关闭后抽屉恢复置顶");
  await evaluate(`modalAdapter.dispose()`);
  assert.deepEqual(await evaluate(`errors`), []);

  await evaluate(`clearInterval(frameTimer);video.srcObject.getTracks().forEach(track=>track.stop())`);
  console.log("Codex adapter smoke passed:", JSON.stringify(evidence));
} finally {
  connection?.close();
  layoutServer.close();
  chrome.kill("SIGTERM");
  await new Promise((resolve) => { chrome.once("exit", resolve);setTimeout(resolve, 2000).unref(); });
  await rm(profile, { recursive: true, force: true });
}
