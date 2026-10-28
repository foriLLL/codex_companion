import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CdpConnection } from "../src/cdp-connection.mjs";
import { reserveLoopbackPort } from "../src/launcher.mjs";
import { attachMediaIntercept, registerMediaInterceptPort } from "../src/media-intercept.mjs";
import { listCdpTargets } from "../src/targets.mjs";

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(path.join(tmpdir(), "companion-media-modules-"));
const chromePath = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ffmpeg = process.env.CODEX_COMPANION_FFMPEG || "ffmpeg";
let chrome;
let cdp;
let server;
try {
  const bun = path.join(root, "node_modules", "bun", "bin", "bun.exe");
  for (const [source, output] of [["src/cards/emby/renderer.mjs", "emby.js"], ["src/cards/hongguo/renderer.mjs", "hongguo.js"], ["src/renderer/platform/effects.mjs", "effects.js"]]) {
    await run(bun, ["build", source, "--target", "browser", "--outfile", path.join(temporary, output)], { cwd: root });
  }
  // 所有媒体由本机生成，测试不接触真实服务器或用户凭据。
  const baseArgs = ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=blue:size=160x90:rate=10", "-t", "8", "-c:v", "libx264", "-profile:v", "baseline", "-level", "3.0", "-g", "10", "-pix_fmt", "yuv420p", "-an"];
  await run(ffmpeg, [...baseArgs, "-movflags", "frag_keyframe+empty_moov+default_base_moof", path.join(temporary, "clip.mp4")]);
  await run(ffmpeg, [...baseArgs, "-f", "hls", "-hls_time", "1", "-hls_list_size", "0", path.join(temporary, "stream.m3u8")]);
  const mp4 = await readFile(path.join(temporary, "clip.mp4"));
  let offset = 0;
  while (offset < mp4.length && mp4.toString("ascii", offset + 4, offset + 8) !== "moof") offset += mp4.readUInt32BE(offset);
  assert.ok(offset > 0 && offset < mp4.length);
  await writeFile(path.join(temporary, "fixture.json"), JSON.stringify({ init: mp4.subarray(0, offset).toString("base64"), media: mp4.subarray(offset).toString("base64") }));
  await writeFile(path.join(temporary, "page.mjs"), await readFile(path.join(root, "scripts/fixtures/media-modules-page.mjs")));
  server = createServer(async (request, response) => {
    try {
      let name = new URL(request.url, "http://127.0.0.1").pathname.slice(1);
      if (name === "hls/11111111-1111-4111-8111-111111111111/clip.mp4") name = "clip.mp4";
      if (name.startsWith("hls/")) { response.writeHead(404).end(); return; }
      if (!name) { response.end('<!doctype html><meta charset="utf-8"><script type="module" src="/page.mjs"></script>'); return; }
      if (!/^[a-zA-Z0-9.-]+$/.test(name)) { response.writeHead(400).end(); return; }
      const data = await readFile(path.join(temporary, name));
      response.setHeader("Content-Type", name.endsWith(".js") || name.endsWith(".mjs") ? "text/javascript" : name.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : name.endsWith(".ts") ? "video/mp2t" : name.endsWith(".mp4") ? "video/mp4" : "application/json");
      response.end(data);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = await reserveLoopbackPort();
  chrome = spawn(chromePath, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--autoplay-policy=no-user-gesture-required", "--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(temporary, "profile")}`, "about:blank"], { stdio: "ignore" });
  let target;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { target = (await listCdpTargets(port)).find((entry) => entry.type === "page"); } catch {}
    if (target) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(target, "独立 Chromium target 启动");
  cdp = new CdpConnection(target.webSocketDebuggerUrl, { timeoutMs: 60000 });
  await cdp.connect();
  // 与注入链路相同：页面请求 .invalid 媒体地址，由 CDP 拦截改写到登记过的本机端口。
  registerMediaInterceptPort(server.address().port);
  assert.equal((await attachMediaIntercept(cdp)).active, true, "CDP 媒体拦截启用");
  await cdp.send("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/` });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const ready = await cdp.send("Runtime.evaluate", { expression: "Boolean(globalThis.__mediaResult)", returnByValue: true });
    if (ready.result.value) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const evaluation = await cdp.send("Runtime.evaluate", { expression: "globalThis.__mediaResult", awaitPromise: true, returnByValue: true });
  assert.equal(evaluation.exceptionDetails, undefined);
  const result = evaluation.result.value;
  console.log(JSON.stringify(result, null, 2));
  assert.equal(result?.ok, true, result?.error || "夹具未启动");
} finally {
  cdp?.close();
  if (chrome) {
    const exited = new Promise((resolve) => chrome.once("exit", resolve));
    chrome.kill("SIGTERM");
    await exited;
  }
  if (server) await new Promise((resolve) => server.close(resolve));
  await rm(temporary, { recursive: true, force: true });
}
