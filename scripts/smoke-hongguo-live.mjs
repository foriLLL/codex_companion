// 实际红果官网 → RPC → Chromium 播放；片单仅存内存，不修改用户收藏。
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtemp,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {CdpConnection} from "../src/cdp-connection.mjs";
import {CdpRpcBridge} from "../src/rpc-bridge.mjs";
import {buildInjectionSource} from "../src/injection.mjs";
import {reserveLoopbackPort} from "../src/launcher.mjs";
import {listCdpTargets} from "../src/targets.mjs";
import {HongguoService} from "../src/hongguo-service.mjs";
import {HongguoClient} from "../src/hongguo.mjs";
let entries=[];
const service=new HongguoService({client:new HongguoClient(),listStorage:{load:async()=>entries,add:async e=>(entries=[e]),remove:async()=>[]}});
const profile = await mkdtemp(join(tmpdir(), "companion-color-browser-"));
const port = await reserveLoopbackPort();
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
  "--headless=new", "--mute-audio", "--autoplay-policy=no-user-gesture-required", "--no-first-run",
  "--no-default-browser-check", "--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, "--window-size=900,760", "about:blank"
], { stdio: "ignore" });
let connection;
let bridge;
try {
  const deadline = Date.now() + 15_000;
  let target;
  while (!target && Date.now() < deadline) {
    target = await listCdpTargets(port).then((targets) => targets.find((target) => target.type === "page")).catch(() => null);
    if (!target) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(target, "浏览器未启动");
  connection = new CdpConnection(target.webSocketDebuggerUrl);
  await connection.connect();
  bridge = new CdpRpcBridge(connection, { handler: service, targetId: "color-smoke" });
  await bridge.attach();
  const read = async (expression) => {
    const result = await connection.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  const waitFor=async expression=>{
    const deadline=Date.now()+60000;
    while(Date.now()<deadline){if(await read(expression))return;await new Promise(r=>setTimeout(r,200));}
    throw new Error(`等待失败：${expression}`);
  };
  const root="document.getElementById('codex-companion-root-shell').shadowRoot";
  const app=`${root}.querySelector('#codex-companion-root').shadowRoot`;
  await read(buildInjectionSource("mount",{cards:{hongguo:true,riverclub:false,emby:false},placement:"standalone-button"}));
  await read(`${root}.querySelector('button').click()`);
  await waitFor(`__CODEX_COMPANION__.hongguo.getState().featuredCount>0`);
  const count=await read(`__CODEX_COMPANION__.hongguo.getState().featuredCount`);
  await read(`__CODEX_COMPANION__.hongguo.openById('7685224734895655960')`);
  await waitFor(`__CODEX_COMPANION__.hongguo.getState().view==='detail'`);
  await read(`__CODEX_COMPANION__.hongguo.playEpisode(1)`);
  await waitFor(`${app}.querySelector('video')?.currentTime>3`);
  const playback=await read(`(()=>{const v=${app}.querySelector('video');return {width:v.videoWidth,height:v.videoHeight,time:v.currentTime,error:v.error?.message??null}})()`);
  assert.ok(playback.width>0);assert.equal(playback.error,null);
  const screenshot=await connection.send("Page.captureScreenshot",{format:"png"});
  await writeFile("/tmp/companion-hongguo-live.png",Buffer.from(screenshot.data,"base64"),{mode:0o600});
  await read(buildInjectionSource("unmount"));
  console.log(JSON.stringify({count,playback,unmounted:true}));
} finally {
  bridge?.detach();
  connection?.close();
  await service.dispose();
  chrome.kill("SIGTERM");
  await new Promise((resolve) => { chrome.once("exit", resolve); setTimeout(resolve, 2000).unref(); });
  await rm(profile, { recursive: true, force: true });
}
