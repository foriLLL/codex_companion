import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { CdpConnection } from "../src/cdp-connection.mjs";
import { reserveLoopbackPort } from "../src/launcher.mjs";
import { listCdpTargets } from "../src/targets.mjs";

// 任务看板冒烟：独立临时 Chrome profile + 模拟的 Codex 侧栏，验证定位、自动展开、滚动、
// 指向动画、颜色标记与点击打开。不访问用户 Codex 的 CDP 端口、配置或会话数据。
//   node scripts/smoke-task-board.mjs [--screenshot-dir <dir>]
const shotIndex = process.argv.indexOf("--screenshot-dir");
const shotDir = shotIndex > 0 ? process.argv[shotIndex + 1] : null;
const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
// data: URL 无法解析相对导入，先把同目录下的相对导入递归换成 data: URL。
const moduleUrl = async (file) => {
  let source = await readFile(path.join(root, file), "utf8");
  for (const [statement, specifier] of source.matchAll(/from "(\.\/[^"]+)"/g)) {
    source = source.replace(statement, `from "${await moduleUrl(path.join(path.dirname(file), specifier))}"`);
  }
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
};

const port = await reserveLoopbackPort();
const profile = await mkdtemp(path.join(os.tmpdir(), "companion-task-board-"));
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--window-size=1280,760",
  "--force-device-scale-factor=2",
  "--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank"
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
  const waitFor = (expression, label, timeoutMs = 4000) => evaluate(`new Promise((resolve, reject) => {
    const deadline = Date.now() + ${timeoutMs};
    const poll = () => { if (${expression}) resolve(true); else if (Date.now() > deadline) reject(new Error(${JSON.stringify(label)})); else setTimeout(poll, 20); };
    poll();
  })`);
  const screenshot = async (name) => {
    if (!shotDir) return;
    const { data } = await connection.send("Page.captureScreenshot", { format: "png" });
    await writeFile(path.join(shotDir, name), Buffer.from(data, "base64"));
  };

  await evaluate(`(async () => {
    const [{ createCodexThreads }, { mount }, { createEffects }] = await Promise.all([
      import(${JSON.stringify(await moduleUrl("src/renderer/adapters/codex-threads.mjs"))}),
      import(${JSON.stringify(await moduleUrl("src/cards/tasks/renderer.mjs"))}),
      import(${JSON.stringify(await moduleUrl("src/renderer/platform/effects.mjs"))})
    ]);
    const id = (n) => '01a18216-3b02-7db0-b394-' + String(n).padStart(12, '0');
    globalThis.ids = { a3: id(3), a10: id(10), a24: id(24), b1: id(101), bHidden: id(105), s1: id(201) };
    const row = (n, title) => '<div class="row" data-app-action-sidebar-thread-row="" data-app-action-sidebar-thread-id="local:' + id(n) + '" data-app-action-sidebar-thread-kind="local" data-app-action-sidebar-thread-active="false" data-app-action-sidebar-thread-pinned="false" data-app-action-sidebar-thread-selected="false" data-app-action-sidebar-thread-title="' + title + '"><span data-thread-title>' + title + '</span></div>';
    const titles = ['修复登录页闪烁', '整理周报数据', '升级 hls.js', '接入任务看板', '排查代理超时', 'Emby 字幕偏移', '重构播放器状态机', '补齐 Windows 测试'];
    const rowsA = Array.from({ length: 25 }, (_, n) => row(n, n === 24 ? '发布 v0.2 检查清单' : titles[n % titles.length] + (n >= titles.length ? ' ' + n : ''))).join('');
    document.body.innerHTML = \`<style>
      :root{--bg:#fff;--side:#f7f7f7;--fg:#0d0d0d;--fg2:#8f8f8f;--line:#ececec;--active:rgba(0,0,0,.055);--card:#fff;--cardline:rgba(0,0,0,.08);color-scheme:light}
      :root[data-theme=dark]{--bg:#212121;--side:#181818;--fg:#ececec;--fg2:#8a8a8a;--line:#2a2a2a;--active:rgba(255,255,255,.07);--card:#2a2a2a;--cardline:rgba(255,255,255,.08);color-scheme:dark}
      html,body{margin:0;height:100%;font:13px/1.4 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;background:var(--bg);color:var(--fg);overflow:hidden;-webkit-font-smoothing:antialiased}
      nav{position:fixed;left:0;top:0;bottom:0;width:264px;background:var(--side);border-right:1px solid var(--line)}
      .brand{display:flex;align-items:center;gap:8px;height:48px;padding:0 18px;font-weight:600;font-size:14px}
      .newchat{margin:0 10px 6px;padding:7px 10px;border-radius:8px;color:var(--fg)}
      [data-app-action-sidebar-scroll]{position:absolute;inset:92px 0 0;overflow:auto;padding:0 10px 16px;scrollbar-width:none}
      .row{height:30px;display:flex;align-items:center;padding:0 10px 0 28px;border-radius:8px;cursor:pointer;white-space:nowrap;overflow:hidden}
      .row span{overflow:hidden;text-overflow:ellipsis}
      .row:hover{background:var(--active)}
      .row[data-app-action-sidebar-thread-active=true]{background:var(--active)}
      .project,.toggle{display:flex;align-items:center;gap:6px;height:30px;padding:0 10px;border:0;background:none;font:inherit;color:var(--fg2);cursor:pointer;width:100%;text-align:left}
      .project::before{content:"";width:13px;height:10px;border:1.4px solid currentColor;border-radius:2.5px;opacity:.8}
      .toggle{padding-left:28px;font-size:12px}
      main{position:fixed;left:265px;right:0;top:0;bottom:0}
      main header{height:48px;display:flex;align-items:center;padding:0 24px;font-weight:500;border-bottom:1px solid var(--line)}
      .msg{max-width:560px;margin:28px auto 0;padding:0 24px;color:var(--fg2);line-height:1.7}
      .msg p{margin:0 0 14px}.msg .user{margin-left:auto;width:fit-content;max-width:70%;padding:8px 14px;border-radius:18px;background:var(--active);color:var(--fg)}
      #companion{position:fixed;right:14px;top:60px;width:332px;background:var(--card);color:var(--fg);border-radius:18px;box-shadow:0 0 0 1px var(--cardline),0 8px 28px rgba(0,0,0,.08);--cc-card-bg:var(--card)}
    </style>
    <nav id="app-shell-sidebar"><div class="brand">Codex</div><div class="newchat">＋ 新对话</div><div data-app-action-sidebar-scroll="">
      <div data-app-action-sidebar-section="" data-app-action-sidebar-section-collapsed="true" data-app-action-sidebar-section-heading="已置顶">
        <button class="project" data-app-action-sidebar-section-toggle="">已置顶</button></div>
      <div class="project" data-app-action-sidebar-project-row="" data-app-action-sidebar-project-id="/Users/me/projects/codex-companion" data-app-action-sidebar-project-label="codex-companion" data-app-action-sidebar-project-collapsed="false">codex-companion</div>
      <div data-app-action-sidebar-project-list-id="/Users/me/projects/codex-companion" data-app-action-sidebar-project-show-all="true">\${rowsA}</div>
      <div class="project" id="project-b" data-app-action-sidebar-project-row="" data-app-action-sidebar-project-id="/Users/me/projects/ecam" data-app-action-sidebar-project-label="ecam" data-app-action-sidebar-project-collapsed="true">ecam</div>
    </div></nav><main><header>接入任务看板</header><div class="msg"><p class="user">帮我给 Companion 加一个任务看板卡片</p><p>好的，先梳理现有卡片平台的接口……</p></div></main><div id="companion"></div>\`;
    // 模拟 React：异步提交展开结果，点击条目即切换当前会话。
    globalThis.clicks = [];
    globalThis.flowAtClick = [];
    document.addEventListener('click', (event) => {
      const thread = event.target.closest('[data-app-action-sidebar-thread-row]');
      if (thread) {
        clicks.push(thread.getAttribute('data-app-action-sidebar-thread-id'));
        // 模拟 Codex 打开会话时主线程被占住；此时落点动画必须已经交给合成器（WAAPI）。
        const flow = document.querySelector('.codex-companion-thread-flow');
        flowAtClick.push(flow ? flow.getAnimations({ subtree: true }).length : -1);
        const busyUntil = performance.now() + 300;
        while (performance.now() < busyUntil) {}
        for (const item of document.querySelectorAll('[data-app-action-sidebar-thread-active=true]')) item.setAttribute('data-app-action-sidebar-thread-active', 'false');
        thread.setAttribute('data-app-action-sidebar-thread-active', 'true');
        return;
      }
      const project = event.target.closest('#project-b[data-app-action-sidebar-project-collapsed=true]');
      if (project) setTimeout(() => {
        project.setAttribute('data-app-action-sidebar-project-collapsed', 'false');
        project.insertAdjacentHTML('afterend', '<div data-app-action-sidebar-project-list-id="/Users/me/projects/ecam" data-app-action-sidebar-project-show-all="false">' + [101, 102, 103].map((n) => row(n, '对齐埋点口径 ' + n)).join('') + '<button class="toggle" data-app-action-sidebar-project-show-all-toggle="">显示全部</button></div>');
      }, 60);
      const showAll = event.target.closest('[data-app-action-sidebar-project-show-all-toggle]');
      if (showAll) setTimeout(() => {
        const list = showAll.parentElement;
        list.setAttribute('data-app-action-sidebar-project-show-all', 'true');
        showAll.insertAdjacentHTML('beforebegin', [104, 105].map((n) => row(n, n === 105 ? '评审值班号二期前端' : '旧会话 ' + n)).join(''));
        showAll.remove();
      }, 60);
      const section = event.target.closest('[data-app-action-sidebar-section-collapsed=true]');
      if (section) setTimeout(() => {
        section.setAttribute('data-app-action-sidebar-section-collapsed', 'false');
        section.insertAdjacentHTML('beforeend', row(201, '准备周五分享'));
      }, 60);
    });
    document.querySelector('[data-app-action-sidebar-thread-id="local:' + ids.a3 + '"]').setAttribute('data-app-action-sidebar-thread-active', 'true');

    // 内存版看板服务，语义与 src/cards/tasks/service.mjs 一致。
    globalThis.rpcCalls = [];
    let revision = 0, tasks = [];
    const statusOf = { [ids.a24]: 'running', [ids.bHidden]: 'asking', [ids.s1]: 'interrupted' };
    const ageOf = { [ids.a24]: 40e3, [ids.bHidden]: 2 * 3600e3, [ids.s1]: 3 * 86400e3, [ids.a10]: 25 * 60e3 };
    const started = Date.now();
    globalThis.activityOf = { [ids.a24]: '运行 npm test' };
    const summaryOf = { [ids.bHidden]: '要先合并 #482 还是先发预览？', [ids.a10]: '已升级到 1.6.2，播放冒烟通过', [ids.a3]: '看板已接入，等你确认样式' };
    // 长轮询：sig 没变就挂起，变了（或超时）再返回。
    let wake = null;
    globalThis.bump = () => { wake?.(); };
    const view = () => ({ revision, tasks: tasks.map((task) => {
      const updatedAt = started - (ageOf[task.threadId] ?? 6 * 60e3);
      const status = statusOf[task.threadId] ?? 'idle';
      return { ...task, name: task.customName ?? task.suggestedName ?? '未命名会话', status, updatedAt, turnAt: updatedAt, unread: status !== 'running' && updatedAt > task.seenAt,
        activity: status === 'running' ? activityOf[task.threadId] ?? '思考中' : null, summary: summaryOf[task.threadId] ?? null };
    }), sig: String(revision) + ':' + JSON.stringify(activityOf) });
    const pick = () => { const used = new Array(8).fill(0); for (const task of tasks) used[task.color] += 1; return used.indexOf(Math.min(...used)); };
    const methods = {
      list: () => view(),
      add: ({ threadId, title, projectId, seenAt }) => { if (!tasks.some((task) => task.threadId === threadId)) { tasks = [{ threadId, suggestedName: title, customName: null, color: pick(), projectId: projectId ?? null, addedAt: Date.now(), seenAt: seenAt ?? Date.now() }, ...tasks]; revision += 1; } return view(); },
      rename: ({ threadId, name }) => { const task = tasks.find((item) => item.threadId === threadId); task.customName = name; revision += 1; return view(); },
      remove: ({ threadId }) => { const index = tasks.findIndex((task) => task.threadId === threadId); const removed = { task: tasks[index], index }; tasks = tasks.toSpliced(index, 1); revision += 1; return { ...view(), removed }; },
      restore: ({ task, index }) => { tasks = tasks.toSpliced(index, 0, task); revision += 1; return view(); },
      recolor: ({ threadId, color }) => { tasks.find((task) => task.threadId === threadId).color = color; revision += 1; return view(); },
      seen: ({ threadId, at }) => { const task = tasks.find((item) => item.threadId === threadId); if (task.seenAt < at) { task.seenAt = at; revision += 1; } return view(); },
      open: () => ({ opened: true }),
      // Trace：两个已结束的回合（一个以提问结束）和一个进行中的回合，最后一段还在长。
      trace: async ({ threadId, since }) => {
        if (since === 'trace-' + threadId) await new Promise((resolve) => setTimeout(resolve, 2000));
        const now = Date.now();
        const s = 1000;
        const seg = (lane, kind, from, to, label, extra = {}) => ({ lane, kind, start: from, end: to, label, ...extra });
        const t1 = now - 31 * 60 * s;
        const t2 = now - 9 * 60 * s;
        const t3 = now - 70 * s;
        const turns = [
          { start: t1, end: t1 + 48 * s, status: 'done', asking: false, ttftMs: 2100, tokens: { input: 40000, output: 2100, reasoning: 800 }, segments: [
            seg('model', 'think', t1, t1 + 9 * s, '思考'), seg('model', 'call', t1 + 9 * s, t1 + 12 * s, '准备运行 git status', { tokens: { output: 420, reasoning: 300, perSecond: 35 } }),
            seg('shell', 'tool', t1 + 12 * s, t1 + 15 * s, '运行 git status', { failed: false }), seg('model', 'think', t1 + 15 * s, t1 + 30 * s, '思考'),
            seg('model', 'reply', t1 + 30 * s, t1 + 48 * s, '工作区干净，可以开始', { tokens: { output: 1680, reasoning: 500, perSecond: 51 } })] },
          { start: t2, end: t2 + 150 * s, status: 'done', asking: true, ttftMs: 1500, tokens: { input: 52000, output: 5200, reasoning: 2400 }, segments: [
            seg('model', 'think', t2, t2 + 14 * s, '思考'), seg('model', 'reply', t2 + 14 * s, t2 + 17 * s, '先跑一遍测试'),
            seg('model', 'call', t2 + 17 * s, t2 + 20 * s, '准备运行 npm test', { tokens: { output: 600, reasoning: 400, perSecond: 30 } }),
            seg('shell', 'tool', t2 + 20 * s, t2 + 62 * s, '运行 npm test', { failed: true }), seg('model', 'think', t2 + 62 * s, t2 + 80 * s, '思考'),
            seg('model', 'call', t2 + 80 * s, t2 + 101 * s, '准备修改 renderer.mjs', { tokens: { output: 2900, reasoning: 1300, perSecond: 74 } }),
            seg('edit', 'tool', t2 + 101 * s, t2 + 103 * s, '修改 renderer.mjs', { failed: false }),
            seg('agent', 'tool', t2 + 103 * s, t2 + 130 * s, '派出子代理', { failed: false }),
            seg('model', 'reply', t2 + 130 * s, t2 + 150 * s, '改好了，要我提交吗？', { tokens: { output: 1700, reasoning: 700, perSecond: 60 } })] },
          { start: t3, end: null, status: 'running', asking: false, ttftMs: null, tokens: { input: 61000, output: 900, reasoning: 300 }, segments: [
            seg('model', 'think', t3, t3 + 12 * s, '思考'), seg('model', 'call', t3 + 12 * s, t3 + 16 * s, '准备运行 npm run smoke', { tokens: { output: 900, reasoning: 300, perSecond: 56 } }),
            seg('shell', 'tool', t3 + 16 * s, t3 + 52 * s, '运行 npm run smoke', { failed: false }), seg('model', 'think', t3 + 52 * s, null, '思考中')] }
        ];
        const data = { threadId, model: 'gpt-5.6-sol', contextWindow: 258400, turns, updatedAt: now };
        return { ...data, sig: 'trace-' + threadId, now };
      },
      watch: async ({ since, waitMs }) => {
        if (view().sig === since) await new Promise((resolve) => { wake = resolve; setTimeout(resolve, Math.min(waitMs, 2000)); });
        return view();
      }
    };
    globalThis.unsee = (id) => { tasks.find((task) => task.threadId === id).seenAt = 1; };
    globalThis.seed = (entries) => { for (const entry of entries) methods.add(entry); };
    const rpc = async (method, params = {}) => { rpcCalls.push(method); return structuredClone(await methods[method](params)); };

    globalThis.errors = [];
    globalThis.threads = createCodexThreads({ document, onError: (error) => errors.push(error.message) });
    const host = document.getElementById('companion');
    globalThis.card = host.attachShadow({ mode: 'open' });
    globalThis.controller = new AbortController();
    const effects = createEffects({ signal: controller.signal, onError: (error) => errors.push(error.message) });
    globalThis.handle = mount({ root: card, rpc, effects, signal: controller.signal, threads, isVisible: () => true });
  })()`);

  const $ = (selector) => `card.querySelector(${JSON.stringify(selector)})`;
  const task = (key) => `card.querySelector('.task[data-id="' + ids.${key} + '"]')`;
  const marked = (key) => `document.querySelector('[data-app-action-sidebar-thread-id="local:' + ids.${key} + '"]')?.getAttribute('data-codex-companion-task')`;

  await waitFor(`${$(".add b")}.textContent === '接入任务看板' && !${$(".add")}.hidden`, "当前会话标题");
  assert.equal(await evaluate(`${$(".empty")}.hidden`), false, "空看板提示");
  await screenshot("task-board-0-empty.png");
  await evaluate(`${$(".add")}.click()`);
  await waitFor(`${task("a3")} && ${$(".add")}.hidden`, "加入看板");
  assert.equal(await evaluate(marked("a3")), "0", "侧栏条目同色标记");
  assert.deepEqual(await evaluate(`threads.current()`), { id: await evaluate(`ids.a3`), title: "接入任务看板", projectId: "/Users/me/projects/codex-companion" });

  // React 重绘替换节点后，标记在下一帧补回。
  await evaluate(`(() => { const old = document.querySelector('[data-app-action-sidebar-thread-id="local:' + ids.a3 + '"]'); const fresh = old.cloneNode(true); fresh.removeAttribute('data-codex-companion-task'); old.replaceWith(fresh); })()`);
  await waitFor(`${marked("a3")} === '0'`, "重绘后补回标记");

  await evaluate(`seed([
    { threadId: ids.s1, title: '准备周五分享', projectId: null },
    { threadId: ids.a10, title: '升级 hls.js', projectId: '/Users/me/projects/codex-companion', seenAt: 1 },
    { threadId: ids.bHidden, title: '评审值班号二期前端', projectId: '/Users/me/projects/ecam', seenAt: 1 },
    { threadId: ids.a24, title: '发布 v0.2 检查清单', projectId: '/Users/me/projects/codex-companion' }
  ]); handle.visibilityChanged({ visible: true })`);
  await waitFor(`card.querySelectorAll('.task').length === 5`, "刷新出 5 个任务");
  // 当前会话 a3 的新回复视为已读；需要人处理且没看过的排最前并跳动，其次是没看过的回复。
  await evaluate(`unsee(ids.a3); handle.visibilityChanged({ visible: true })`);
  await waitFor(`rpcCalls.includes('seen') && ${task("a3")}?.querySelector('.status').dataset.icon === 'reply'`, "停在当前会话即已读");
  assert.deepEqual(await evaluate(`[...card.querySelectorAll('.task')].map((item) => item.querySelector('.status').dataset.icon)`), ["ask", "unread", "alert", "spin", "reply"], "按需要处理的程度排序");
  assert.equal(await evaluate(`${task("bHidden")}.hasAttribute('data-hop')`), true, "没看过的提问会跳动");
  assert.equal(await evaluate(`${task("s1")}.hasAttribute('data-hop')`), false, "看过的中断不跳");
  assert.equal(await evaluate(`${task("a10")}.querySelector('.meta').textContent`), "25 分钟前 · 已升级到 1.6.2，播放冒烟通过", "第二行是时间和最后一句回复");
  assert.equal(await evaluate(`${task("a24")}.querySelector('.meta .live')?.textContent`), "运行 npm test", "进行中显示当前动作");
  assert.equal(await evaluate(`${task("bHidden")}.querySelector('.tag')?.textContent`), "需要你");
  assert.deepEqual(await evaluate(`[...card.querySelectorAll('.chip')].map((chip) => chip.textContent)`), ["1 进行中", "2 需要你"]);
  // 实时：进度一变，原条目原地换文字（不重建），旧文字淡出、新文字浮入。
  await evaluate(`globalThis.liveNode = ${task("a24")}; activityOf[ids.a24] = '修改 renderer.mjs'; bump()`);
  await waitFor(`${task("a24")}.querySelector('.meta .label:not(.out)')?.textContent === '修改 renderer.mjs'`, "进度实时更新");
  assert.equal(await evaluate(`${task("a24")} === liveNode`), true, "条目节点被复用");
  await screenshot("task-board-1d-live.png");
  assert.equal(await evaluate(marked("a24")), "4");
  await evaluate(`(() => { for (const node of card.querySelectorAll('[data-hop], [data-hop] .status')) node.getAnimations().forEach((animation) => { animation.pause(); animation.currentTime = 3200 * 0.22; }); })()`);
  await screenshot("task-board-1b-hop.png");
  await evaluate(`card.querySelectorAll('[data-hop], [data-hop] .status').forEach((node) => node.getAnimations().forEach((animation) => { animation.currentTime = 3200 * 0.37; }))`);
  await screenshot("task-board-1c-knock.png");
  await evaluate(`card.querySelectorAll('[data-hop], [data-hop] .status').forEach((node) => node.getAnimations().forEach((animation) => { animation.currentTime = 0; animation.play(); }))`);
  await screenshot("task-board-1-light.png");
  await evaluate(`document.documentElement.dataset.theme = 'dark'`);
  await screenshot("task-board-2-dark.png");
  await evaluate(`delete document.documentElement.dataset.theme`);

  // Trace 浮层：悬停任务一会儿，在看板左侧弹出该会话的 Trace；进行中的最后一段随时间生长。
  const pointAt = async (expression) => {
    const { x, y } = await evaluate(`(() => { const rect = ${expression}.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; })()`);
    await connection.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  };
  await pointAt(`${task("a3")}.querySelector('.name')`);
  await waitFor(`card.querySelector('.peek').matches(':popover-open') && card.querySelectorAll('.seg-bar').length === 18`, "悬停打开 Trace 浮层");
  assert.deepEqual(await evaluate(`(() => {
    const peek = card.querySelector('.peek').getBoundingClientRect();
    const board = document.getElementById('companion').getBoundingClientRect();
    return { leftOfBoard: peek.right <= board.left, wide: peek.width >= 600, inView: peek.top >= 0 && peek.bottom <= innerHeight, title: card.querySelector('.trace-title')?.textContent };
  })()`), { leftOfBoard: true, wide: true, inView: true, title: "接入任务看板" }, "浮层在看板左侧、足够宽、不出窗口");
  assert.deepEqual(await evaluate(`[...card.querySelectorAll('.tl-lane')].map((lane) => lane.dataset.lane)`), ["model", "shell", "edit", "agent", "you"]);
  assert.equal(await evaluate(`card.querySelectorAll('.seg-bar[data-failed]').length`), 1, "失败的工具标红");
  assert.equal(await evaluate(`card.querySelectorAll('.needs').length`), 1, "以提问结束的回合标出「需要你」");
  const grow = await evaluate(`(async () => { const bar = card.querySelector('.seg-bar[data-live]'); const before = bar.getBoundingClientRect().width; await new Promise((r) => setTimeout(r, 1200)); return [before, bar.getBoundingClientRect().width, card.querySelector('.trace-live').textContent]; })()`);
  assert.ok(grow[1] > grow[0], "进行中的段向右生长");
  assert.match(grow[2], /^思考 \d+(\.\d)?s$/);
  assert.equal(await evaluate(`(() => { const box = card.querySelector('.tl-scroll'); return box.scrollLeft + box.clientWidth >= box.scrollWidth - 2; })()`), true, "默认跟随最新进度");
  await screenshot("task-board-3-trace-light.png");
  await evaluate(`document.documentElement.dataset.theme = 'dark'`);
  await screenshot("task-board-4-trace-dark.png");
  await evaluate(`delete document.documentElement.dataset.theme`);
  // 鼠标移进浮层不关；移到别的任务直接切换；移出后关闭。
  await pointAt(`card.querySelector('.tl-scroll')`);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(await evaluate(`card.querySelector('.peek').matches(':popover-open')`), true, "移进浮层保持打开");
  await evaluate(`card.querySelector('.tl-scroll').scrollLeft = 0`);
  await screenshot("task-board-5-trace-scrolled.png");
  await pointAt(`${task("a24")}.querySelector('.name')`);
  await waitFor(`card.querySelector('.trace-title')?.textContent === ${task("a24")}.querySelector('.name').textContent && ${task("a24")}.hasAttribute('data-peek')`, "移到别的任务直接切换");
  await connection.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 600, y: 700 });
  await waitFor(`!card.querySelector('.peek').matches(':popover-open') && !card.querySelector('[data-peek]')`, "移出后关闭浮层");

  // 底部条目：先滚动到可视，再播放指向动画，最后打开。
  await evaluate(`document.querySelector('[data-app-action-sidebar-scroll]').scrollTop = 0`);
  assert.equal(await evaluate(`(() => { const rect = document.querySelector('[data-app-action-sidebar-thread-id="local:' + ids.a24 + '"]').getBoundingClientRect(); return rect.top < innerHeight; })()`), false, "目标初始不在可视区");
  // 对照：没有指向动画时（看板里的跳动、转圈照常）的帧间隔。
  const idleFrames = await evaluate(`new Promise((resolve) => { const list = []; let last = performance.now(); const tick = (now) => { list.push(now - last); last = now; if (list.length < 40) requestAnimationFrame(tick); else { const gaps = list.slice(1); resolve({ max: Math.round(Math.max(...gaps)), avg: Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length * 10) / 10 }); } }; requestAnimationFrame(tick); })`);
  const measureIdle = `new Promise((resolve) => { const list = []; let last = performance.now(); const tick = (now) => { list.push(now - last); last = now; if (list.length < 40) requestAnimationFrame(tick); else { const gaps = list.slice(1); resolve(Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length * 10) / 10); } }; requestAnimationFrame(tick); })`;
  await evaluate(`card.getAnimations().forEach((animation) => animation.pause())`);
  const pausedAvg = await evaluate(measureIdle);
  await evaluate(`card.getAnimations().forEach((animation) => animation.play())`);
  idleFrames.pausedAvg = pausedAvg;
  // 记录动画期间的帧间隔，用来发现掉帧。
  await evaluate(`(() => { globalThis.frames = []; let last = performance.now(); const tick = (now) => { frames.push(now - last); last = now; if (frames.length < 120) requestAnimationFrame(tick); }; requestAnimationFrame(tick); })()`);
  await evaluate(`${task("a24")}.querySelector('.main').click()`);
  await waitFor(`document.querySelectorAll('.codex-companion-thread-flow').length === 1`, "动画开始");
  const scrolledFirst = await evaluate(`(() => { const rect = document.querySelector('[data-app-action-sidebar-thread-id="local:' + ids.a24 + '"]').getBoundingClientRect(); const box = document.querySelector('[data-app-action-sidebar-scroll]').getBoundingClientRect(); return rect.top >= box.top && rect.bottom <= box.bottom; })()`);
  assert.equal(scrolledFirst, true, "动画开始前目标已完整可见");
  await new Promise((resolve) => setTimeout(resolve, 60));
  await screenshot("task-board-3-flow.png");
  await screenshot("task-board-4-landing.png");
  await waitFor(`threads.current()?.id === ids.a24 && !document.querySelector('.codex-companion-thread-flow')`, "动画结束并打开会话");
  assert.ok(await evaluate(`flowAtClick.at(-1) >= 3`), "打开会话时落点铺开、液流淡出、整体淡出都已交给 WAAPI");
  const frameStats = await evaluate(`(() => { const list = frames.slice(1, 40); return { max: Math.round(Math.max(...list)), avg: Math.round(list.reduce((a, b) => a + b, 0) / list.length * 10) / 10, slow: list.filter((gap) => gap > 25).length }; })()`);

  // 折叠项目 + 「显示全部」：按加入时记录的项目精确展开。
  await evaluate(`${task("bHidden")}.querySelector('.main').click()`);
  // 展开会改侧栏、触发看板重绘，起点节点被替换后动画仍要播放。
  await waitFor(`document.querySelectorAll('.codex-companion-thread-flow').length === 1`, "展开项目后播放动画", 6000);
  await waitFor(`threads.current()?.id === ids.bHidden`, "展开折叠项目并打开", 6000);
  assert.equal(await evaluate(`document.getElementById('project-b').getAttribute('data-app-action-sidebar-project-collapsed')`), "false");
  assert.equal(await evaluate(marked("bHidden")), "3", "新出现的条目同样被标记");
  // 没有项目信息时展开折叠分区。
  await evaluate(`${task("s1")}.querySelector('.main').click()`);
  await waitFor(`document.querySelectorAll('.codex-companion-thread-flow').length === 1`, "展开分区后播放动画", 6000);
  await waitFor(`threads.current()?.id === ids.s1`, "展开折叠分区并打开", 6000);
  await screenshot("task-board-5-opened.png");

  // 侧栏找不到时回退到深链。
  await evaluate(`seed([{ threadId: '01a18216-3b02-7db0-b394-999999999999', title: '已不在列表中的会话' }]); handle.visibilityChanged({ visible: true })`);
  await waitFor(`card.querySelectorAll('.task').length === 6`, "加入不在侧栏的会话");
  await evaluate(`card.querySelector('.task[data-id="01a18216-3b02-7db0-b394-999999999999"] .main').click()`);
  await waitFor(`rpcCalls.includes('open')`, "回退深链", 8000);

  // 改名：默认推荐名，可改，留空回到推荐名。
  await evaluate(`${task("a3")}.querySelectorAll('.icon')[1].click()`);
  await waitFor(`${task("a3")}.querySelector('input')`, "进入改名");
  await evaluate(`(() => { const input = ${task("a3")}.querySelector('input'); input.value = '任务看板：着色与跳转'; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  await waitFor(`${task("a3")}.querySelector('.name')?.textContent === '任务看板：着色与跳转'`, "改名生效");
  await evaluate(`${task("a3")}.querySelectorAll('.icon')[1].click()`);
  await waitFor(`${task("a3")}.querySelector('input')`, "再次改名");
  await evaluate(`(() => { const input = ${task("a3")}.querySelector('input'); input.value = ''; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
  await waitFor(`${task("a3")}.querySelector('.name')?.textContent === '接入任务看板'`, "留空回到推荐名");

  // 换颜色：色板选深靛，条目底色随任务色，侧栏标记同步。
  await evaluate(`${task("a24")}.querySelectorAll('.icon')[0].click()`);
  await waitFor(`${task("a24")}?.querySelectorAll('.palette button').length === 8`, "打开色板");
  await screenshot("task-board-6-palette.png");
  await evaluate(`${task("a24")}.querySelectorAll('.palette button')[7].click()`);
  await waitFor(`${marked("a24")} === '7' && !card.querySelector('.palette')`, "换成深靛");
  assert.equal(await evaluate(`${task("a24")}.style.getPropertyValue('--task')`), "#3f3ca8", "条目底色取任务色");
  await screenshot("task-board-7-deep.png");

  // 完成即移出，可撤销。
  await evaluate(`${task("s1")}.querySelectorAll('.icon')[2].click()`);
  await waitFor(`!${task("s1")} && !${$(".toast")}.hidden`, "完成后移出");
  assert.equal(await evaluate(marked("s1")), null, "移出后撤销侧栏标记");
  await evaluate(`${$(".toast button")}.click()`);
  await waitFor(`${task("s1")} && ${marked("s1")} === '1'`, "撤销后放回原位");

  await evaluate(`controller.abort(); handle.dispose(); threads.dispose()`);
  assert.equal(await evaluate(`document.querySelectorAll('[data-codex-companion-task]').length + (document.getElementById('codex-companion-thread-marks') ? 1 : 0)`), 0, "释放后不残留标记");
  assert.deepEqual(await evaluate(`errors`), []);
  console.log("Task board smoke passed:", JSON.stringify({ clicks: (await evaluate(`clicks`)).length, rpc: await evaluate(`rpcCalls.length`), idleFrames, flowFrames: frameStats }));
} finally {
  connection?.close();
  chrome.kill("SIGTERM");
  await new Promise((resolve) => { chrome.once("exit", resolve); setTimeout(resolve, 2000).unref(); });
  await rm(profile, { recursive: true, force: true });
}
