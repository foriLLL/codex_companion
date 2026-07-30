import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { CdpConnection } from "../src/cdp-connection.mjs";
import { BRIDGE_KEY, HOST_ID, RAIL_ID, buildInjectionSource } from "../src/injection.mjs";
import { reserveLoopbackPort } from "../src/launcher.mjs";
import { listCdpTargets } from "../src/targets.mjs";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = await reserveLoopbackPort();
const profileDir = await mkdtemp(path.join(os.tmpdir(), "codex-companion-placement-"));
const page = `data:text/html,${encodeURIComponent(`
  <html>
    <head><style>html,body{margin:0;height:100%;overflow:hidden}</style></head>
    <body>
      <button id="side-panel-toggle" aria-label="Toggle side panel" aria-pressed="true"></button>
      <button id="pinned-toggle" aria-label="Toggle pinned summary" aria-pressed="true"></button>
      <div id="floating-root" class="thread-floating-content-top-inset right-0" style="position:relative;height:900px;width:316px">
        <div id="summary-animation" class="origin-top-right" style="height:100%;width:316px;visibility:visible;opacity:1;transform:none;transform-origin:top right">
          <div id="native-panel" class="rounded-3xl bg-token-dropdown-background" style="height:240px;width:300px">
            <header>Outputs</header><section>Sources</section>
          </div>
        </div>
      </div>
    </body>
  </html>
`)}`;
const chrome = spawn(CHROME, [
  "--headless=new",
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
  "--remote-debugging-address=127.0.0.1",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profileDir}`,
  page
], { stdio: "ignore" });

const waitForTarget = async () => {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const target = (await listCdpTargets(port)).find((item) => item.type === "page" && item.webSocketDebuggerUrl);
      if (target) return target;
    } catch {
      // Chromium 仍在启动。
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("等待 placement smoke Chromium target 超时");
};

let connection;
try {
  const target = await waitForTarget();
  connection = new CdpConnection(target.webSocketDebuggerUrl);
  await connection.connect();
  await connection.send("Runtime.enable");

  const evaluate = async (expression, options = {}) => {
    const result = await connection.send("Runtime.evaluate", {
      expression,
      awaitPromise: options.awaitPromise,
      returnByValue: true
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "Renderer 执行失败");
    }
    return result.result.value;
  };

  await evaluate(`(() => {
    const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL7WQAAAABJRU5ErkJggg==";
    globalThis.__pendingHongguoImages = [];
    globalThis.__releaseHongguoImages = () => {
      for (const request of globalThis.__pendingHongguoImages.splice(0)) {
        globalThis[${JSON.stringify(BRIDGE_KEY)}]?.emby.receiveRpc({
          id: request.id,
          ok: true,
          result: { data: pixel, encoding: "base64", contentType: "image/png", url: request.params.url }
        });
      }
    };
    globalThis.__CODEX_COMPANION_RPC__ = (rawRequest) => {
      const request = JSON.parse(rawRequest);
      if (request.method === "hongguo.image.load") {
        globalThis.__pendingHongguoImages.push(request);
        return;
      }
      const result = request.method === "hongguo.home"
        ? { featured: [{
            id: "placement-drama",
            name: "异步封面样片",
            posterUrl: "https://hongguo.test/delayed-poster.png"
          }] }
        : request.method === "connection.status"
          ? { connected: false, baseUrl: "", username: "" }
          : { ok: true };
      queueMicrotask(() => globalThis[${JSON.stringify(BRIDGE_KEY)}]?.emby.receiveRpc({
        id: request.id,
        ok: true,
        result
      }));
    };
  })()`);

  const mounted = await evaluate(buildInjectionSource("mount"));
  assert.equal(mounted.status, "mounted");

  const snapshot = () => evaluate(`(() => {
    const bridge = globalThis[${JSON.stringify(BRIDGE_KEY)}];
    const host = document.getElementById(${JSON.stringify(HOST_ID)});
    return {
      pressed: document.getElementById("pinned-toggle").getAttribute("aria-pressed"),
      placement: bridge.getPlacement(),
      placed: bridge.isPlaced(),
      host: Boolean(host),
      rail: Boolean(document.getElementById(${JSON.stringify(RAIL_ID)})),
      railMode: document.getElementById(${JSON.stringify(RAIL_ID)})?.dataset.mode || null,
      railParent: document.getElementById(${JSON.stringify(RAIL_ID)})?.parentElement?.id || null,
      railTop: document.getElementById(${JSON.stringify(RAIL_ID)})?.style.top || null,
      railHeight: document.getElementById(${JSON.stringify(RAIL_ID)})?.style.height || null,
      cards: host?.shadowRoot.querySelectorAll("[data-card]").length || 0
    };
  })()`);
  const waitFor = (condition, label) => evaluate(`new Promise((resolve, reject) => {
    const deadline = Date.now() + 3_000;
    const poll = () => {
      if (${condition}) resolve(true);
      else if (Date.now() > deadline) reject(new Error(${JSON.stringify(label)}));
      else setTimeout(poll, 20);
    };
    poll();
  })`, { awaitPromise: true });

  assert.deepEqual(await snapshot(), {
    pressed: "true", placement: "animated-summary", placed: true, host: true, rail: true,
    railMode: "animated-summary", railParent: "summary-animation", railTop: "252px", railHeight: null, cards: 2
  });
  assert.equal(await evaluate(`document.getElementById(${JSON.stringify(RAIL_ID)}).parentElement === document.querySelector(".origin-top-right")`), true);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector(".origin-top-right")).position`), "relative");
  assert.equal(await evaluate(`document.getElementById(${JSON.stringify(RAIL_ID)}).style.left`), "-16px");
  assert.equal(await evaluate(`Math.round(document.getElementById(${JSON.stringify(HOST_ID)}).getBoundingClientRect().top - document.getElementById("native-panel").getBoundingClientRect().bottom)`), 24);
  assert.equal(await evaluate(`Math.round(document.getElementById(${JSON.stringify(HOST_ID)}).getBoundingClientRect().left - document.getElementById("native-panel").getBoundingClientRect().left)`), 0);
  const animatedScroll = await evaluate(`(() => {
    const scroller = document.querySelector('[data-codex-companion-scroll-root="animated-summary"]');
    const panel = document.getElementById('native-panel');
    const before = panel.getBoundingClientRect().top;
    scroller.scrollTop = 100;
    const after = panel.getBoundingClientRect().top;
    const result = {
      id: scroller.id,
      overflowY: getComputedStyle(scroller).overflowY,
      max: scroller.scrollHeight - scroller.clientHeight,
      delta: Math.round(before - after)
    };
    scroller.scrollTop = 0;
    return result;
  })()`);
  assert.equal(animatedScroll.id, "floating-root");
  assert.equal(animatedScroll.overflowY, "auto");
  assert.ok(animatedScroll.max > 0, "外层容器必须容纳 Summary 与两张卡片的总高度");
  assert.equal(animatedScroll.delta, 100, "外层滚动必须同时移动官方 Summary");
  await waitFor(`globalThis.__pendingHongguoImages.length === 1`, "红果封面请求未发出");

  await evaluate(`document.getElementById("pinned-toggle").setAttribute("aria-pressed", "false")`);
  await evaluate(`(() => {
    const column = document.querySelector(".origin-top-right");
    column.style.visibility = "visible";
    column.style.opacity = ".04";
    column.style.transform = "translateX(300px) scale(.81)";
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal((await snapshot()).placement, "animated-summary", "关闭动画结束前卡片不应提前卸载");
  assert.equal(await evaluate(`document.getElementById(${JSON.stringify(RAIL_ID)}).parentElement.style.transform`), "translateX(300px) scale(0.81)");
  assert.equal(
    await evaluate(`Math.round(document.getElementById(${JSON.stringify(HOST_ID)}).getBoundingClientRect().left - document.getElementById("native-panel").getBoundingClientRect().left)`),
    0,
    "Summary transform 动画期间卡片也必须保持横向对齐"
  );
  await evaluate(`(() => {
    const column = document.querySelector(".origin-top-right");
    column.style.opacity = "0";
    column.style.transform = "translateX(100%) scale(.8)";
  })()`);
  await waitFor(`globalThis[${JSON.stringify(BRIDGE_KEY)}].getPlacement() === "hidden"`, "关闭 pinned summary 后卡片未隐藏");
  assert.deepEqual(await snapshot(), {
    pressed: "false", placement: "hidden", placed: false, host: false, rail: false,
    railMode: null, railParent: null, railTop: null, railHeight: null, cards: 0
  });
  assert.equal(await evaluate(`getComputedStyle(document.querySelector(".origin-top-right")).overflowY`), "visible");
  assert.equal(await evaluate(`getComputedStyle(document.querySelector(".origin-top-right")).position`), "static");
  await evaluate(`globalThis.__releaseHongguoImages()`);
  await new Promise((resolve) => setTimeout(resolve, 50));

  await evaluate(`(() => {
    const trigger = document.getElementById("pinned-toggle");
    trigger.setAttribute("aria-label", "Toggle summary");
    trigger.setAttribute("aria-expanded", "true");
    trigger.setAttribute("aria-controls", "summary-popover");
    trigger.setAttribute("data-state", "open");
    const popover = document.createElement("div");
    popover.id = "summary-popover";
    popover.setAttribute("role", "dialog");
    popover.dataset.state = "open";
    const stack = document.createElement("div");
    stack.id = "summary-stack";
    stack.style.cssText = "display:flex;max-height:880px;flex-direction:column;width:300px";
    stack.innerHTML = '<div id="popover-native-panel" class="rounded-3xl bg-token-dropdown-background" style="height:300px;width:300px;flex:none"><header>Environment</header><section>Sources</section></div>';
    popover.append(stack);
    document.body.append(popover);
  })()`);
  await waitFor(`globalThis[${JSON.stringify(BRIDGE_KEY)}].getPlacement() === "summary-popover"`, "Side Panel Summary popover 未挂载卡片");
  assert.deepEqual(await snapshot(), {
    pressed: "false", placement: "summary-popover", placed: true, host: true, rail: true,
    railMode: "summary-popover", railParent: "summary-stack", railTop: null, railHeight: null, cards: 2
  });
  assert.equal(await evaluate(`document.getElementById(${JSON.stringify(RAIL_ID)}).previousElementSibling.id`), "popover-native-panel");
  assert.equal(await evaluate(`Math.round(document.getElementById("popover-native-panel").getBoundingClientRect().height)`), 300);
  assert.equal(await evaluate(`Math.round(document.getElementById(${JSON.stringify(HOST_ID)}).getBoundingClientRect().top - document.getElementById("popover-native-panel").getBoundingClientRect().bottom)`), 24);
  assert.equal(await evaluate(`Math.round(document.getElementById(${JSON.stringify(HOST_ID)}).getBoundingClientRect().left - document.getElementById("popover-native-panel").getBoundingClientRect().left)`), 0);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('[data-codex-companion-scroll-root="summary-popover"]')).overflowY`), "auto");
  await waitFor(`(() => {
    const image = document.getElementById(${JSON.stringify(HOST_ID)})?.shadowRoot
      ?.querySelector('[data-card="hongguo"] img');
    return image?.src.startsWith("blob:") && image.complete && image.naturalWidth === 1;
  })()`, "Summary 隐藏期间返回的红果封面未在重新挂载后显示");

  await evaluate(`(() => {
    document.getElementById("summary-popover").remove();
    const trigger = document.getElementById("pinned-toggle");
    trigger.removeAttribute("aria-expanded");
    trigger.removeAttribute("aria-controls");
    trigger.removeAttribute("data-state");
  })()`);
  await waitFor(`globalThis[${JSON.stringify(BRIDGE_KEY)}].getPlacement() === "hidden"`, "关闭 Side Panel Summary popover 后卡片未隐藏");

  await evaluate(`(() => {
    const trigger = document.getElementById("pinned-toggle");
    trigger.setAttribute("aria-label", "Toggle pinned summary");
    document.getElementById("pinned-toggle").setAttribute("aria-pressed", "true");
    const column = document.querySelector(".origin-top-right");
    column.style.visibility = "visible";
    column.style.opacity = "0";
    column.style.transform = "translateX(100%) scale(.8)";
  })()`);
  await waitFor(`globalThis[${JSON.stringify(BRIDGE_KEY)}].isPlaced()`, "重新打开 pinned summary 后卡片未恢复");
  assert.equal((await snapshot()).placement, "animated-summary", "打开动画首帧应已挂载卡片");
  assert.equal((await snapshot()).railTop, "252px", "打开动画首帧必须按未缩放的 Summary 高度定位");
  assert.equal((await snapshot()).railHeight, null, "卡片 rail 应使用内容高度，由外层容器统一滚动");
  await evaluate(`(() => {
    const column = document.querySelector(".origin-top-right");
    column.style.opacity = "1";
    column.style.transform = "none";
  })()`);
  assert.deepEqual(await snapshot(), {
    pressed: "true", placement: "animated-summary", placed: true, host: true, rail: true,
    railMode: "animated-summary", railParent: "summary-animation", railTop: "252px", railHeight: null, cards: 2
  });

  await evaluate(`(() => {
    globalThis.__nativePanel = document.getElementById("native-panel");
    globalThis.__nativePanelParent = globalThis.__nativePanel.parentElement;
    globalThis.__nativePanel.remove();
  })()`);
  await waitFor(`globalThis[${JSON.stringify(BRIDGE_KEY)}].getPlacement() === "hidden"`, "原生面板卸载后卡片未隐藏");
  assert.deepEqual(await snapshot(), {
    pressed: "true", placement: "hidden", placed: false, host: false, rail: false,
    railMode: null, railParent: null, railTop: null, railHeight: null, cards: 0
  });

  await evaluate(`globalThis.__nativePanelParent.prepend(globalThis.__nativePanel)`);
  await waitFor(`globalThis[${JSON.stringify(BRIDGE_KEY)}].isPlaced()`, "原生面板恢复后卡片未恢复");
  assert.equal((await snapshot()).cards, 2);

  await evaluate(buildInjectionSource("unmount"));
  assert.equal(await evaluate(`Boolean(document.getElementById(${JSON.stringify(HOST_ID)}) || document.getElementById(${JSON.stringify(RAIL_ID)}))`), false);
  assert.deepEqual(await evaluate(`(() => {
    const root = document.getElementById('floating-root');
    return {
      marker: root.hasAttribute('data-codex-companion-scroll-root'),
      width: root.style.width,
      marginLeft: root.style.marginLeft,
      paddingLeft: root.style.paddingLeft,
      overflowY: root.style.overflowY
    };
  })()`), { marker: false, width: "316px", marginLeft: "", paddingLeft: "", overflowY: "" });
  console.log("Placement smoke passed: shared Summary animation + controlled Summary popover → close/open → unmount");
} finally {
  connection?.close();
  chrome.kill("SIGTERM");
  await new Promise((resolve) => {
    chrome.once("exit", resolve);
    setTimeout(resolve, 2_000).unref();
  });
  await rm(profileDir, { recursive: true, force: true });
}
