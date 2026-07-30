# 发布前 Review 记录

> 目的：仓库推上 GitHub 前的整体质量审查。每个问题按「问题 → 判定 → 修复 → 状态」记录，方便逐条核对。
> 审查时间：2026-07-26。范围：src/、test/、scripts/、packaging/、配置与文档。

---

## 一、实现方案（配置界面 + 生命周期管控）期间发现并处理的问题

### A1. bun test 与 node --test 对注入源码断言不一致
- **问题**：`buildInjectionSource` 依赖 `Function.prototype.toString()`。Bun 的转译器会改写函数体（`true`→`!0`、合并 const 声明、重排空白），导致既有对源码做精确字符串断言的测试在 `bun test` 下失败；`node --test` 全绿。
- **判定**：产品行为无缺陷——注入源在 Bun 编译产物里仍是合法 JS 且行为一致（已用编译产物验证 `new Function(source)` 通过、cards 配置正确序列化）。真正约束是：对 toString 产物做精确文本断言的测试天生绑定转译器。
- **修复**：新增卡片开关断言改用两种运行时都稳定的子串正则；测试基线以 `node --test` 为准（CI 用 node 跑测试，bun 只负责编译打包）。
- **状态**：已修复。

### A2. `hidden` 属性被 `.panel { display:flex }` 覆盖
- **问题**：卡片 `<section>` 用 HTML `hidden` 属性控制显隐，但 `.panel` 的 `display:flex` 优先级高于 UA 的 `[hidden]{display:none}`，导致隐藏失效。
- **修复**：Shadow DOM 样式内显式加 `.panel[hidden]{display:none}`，并加 `.panel[hidden] + .emby-card{margin-top:0}` 消除红果卡隐藏后 Emby 卡残留的 24px 间距。
- **状态**：已修复。

### A3. 双卡片全关时的空壳与重复注入
- **问题**：两张卡片都关闭时若仍挂载，会得到一个空 rail；且注入器每 1.5s 健康检查若发现无 bridge 会反复重注入。
- **修复**：bootstrap 在双关时移除实例并安装一个轻量 stub bridge（保留 `version`/`cardsKey`、`isMounted()===true`），让健康检查短路，不再每轮重挂载。
- **状态**：已修复。

### A4. 配置热更新的 watcher 选型
- **问题**：配置文件用原子写（temp+rename），文件级 `fs.watch` 会在 rename 后失效。
- **修复**：watch 配置所在**目录**而非文件，并按文件名过滤 + 200ms 去抖；目录可能首次不存在，先 `mkdir -p`。shutdown 时关闭 watcher 与去抖定时器。
- **状态**：已修复。

---

## 二、整体 Review（结构 / 鲁棒性 / UI 一致性）

（下面在审查过程中逐条补充）

### B1. 常驻守护无单实例保护（自查发现）
- **问题**：`launch` 对「启动 Codex」是幂等的（已在运行则复用），但每次 `launch` 仍会起自己的常驻 injector + watchdog + 配置 watcher。用户重复点 App / Swift AppDelegate 每次打开都触发 launch 时，会出现多个守护进程同时对同一 renderer 每 1.5s 扫描注入，浪费且可能互相干扰（重复 RPC binding）。
- **判定**：中。功能不致命（injector 有 already-mounted 短路），但资源浪费 + 潜在竞争，开源质量不达标。
- **修复方向**：launch 进入常驻前，检查 runtime-state 里的 `daemonPid` 是否仍存活且端口可用；若是则打印「已有守护实例」并退出，不再起第二个。
- **状态**：待修（见下方批量修复）。

**修复实现**：
- `runtime-state.mjs` 新增 `pidIsAlive(pid)`（`kill(pid, 0)` 探测，EPERM 视为存活）。
- `cli.mjs` launch 进入前检查：`daemonPid` 存活 + 端口可用 → 打印提示并退出，不起第二个守护。
- 运行时状态改为在「进入常驻后」统一写入（记录本进程 daemonPid），复用既有 Codex 时保留上次的 codexPid。
- 已加 `pidIsAlive` 单测。

### B2. Swift AppDelegate 首启动的重复 launch（自查发现）
- **问题**：`launchedProcess != nil` 首次打开恒为 false，即使已有守护在跑，Swift 仍会调 `launchDetached()`。
- **判定**：低（有了 B1 的 bun 侧单实例守护后，这次多余的 launch 会被 bun 自己短路退出，无实际危害）。
- **修复**：依赖 B1 的单实例守护兜底；Swift 侧逻辑保持简单（宁可多调一次让 bun 幂等处理，也不在 Swift 里重复判断）。
- **状态**：已由 B1 覆盖。

### B3. 跨架构 ffmpeg：x64 产物会捆绑 arm64 的 ffmpeg（agent 发现，发布阻断级）
- **问题**：`build-app.mjs` 用 `require("ffmpeg-static")` 取路径，但 `ffmpeg-static@5` 的 postinstall 只下载**构建机架构**的二进制。release.yml 两个矩阵都跑在 arm64 runner，导致 `darwin-x64` 的 `.app` 里塞的是 arm64 ffmpeg，x64 用户运行时 `Bad CPU type`，HLS 转封装静默失败。
- **修复**：
  1. `build-app.mjs`：复制 ffmpeg 后用 `file` 校验 Mach-O 架构与 target 匹配，不匹配即 fail（快速失败而非发布出坏包）。
  2. release.yml：`darwin-x64` 矩阵改用 Intel runner `macos-13`，各自 `npm ci` 拿到对应架构 ffmpeg。
- **状态**：已修复。

### B4. uncaughtException 清理不完整（M1）
- **问题**：`uncaughtException` 只调 `shutdown`，漏了 `watchdog.stop()` / `configWatcher.close()` / `runtimeState.clear()`，且不 `exit`，残留陈旧 `runtime.json` 会误导下次幂等。
- **修复**：改调 `shutdownAll("uncaughtException")` 后 `process.exit(1)`。
- **状态**：已修复。

### B5. Swift Process 管道死锁 + stderr 不排空（M2）
- **问题**：`waitUntilExit()` 先于 `readDataToEndOfFile()`，输出超管道缓冲会死锁；stderr 无 reader。
- **修复**：并发读 stdout/stderr（`readabilityHandler` 或先读后等），stderr 也排空。
- **状态**：已修复。

### B6. GPL LICENSE 复制失败被吞（M3）
- **问题**：`cp(ffmpeg.LICENSE).catch(()=>{})` 吞掉失败，可能发布无许可证的 GPL 产物。
- **修复**：去掉 catch，缺失即 fail。
- **状态**：已修复。

### B7. collectStatus 吞 ps 失败误报未运行（M5）
- **问题**：`inspect.catch(()=>[])` 把扫描失败当「无进程」，Swift 显示可启动，可能重复启动。
- **修复**：加 `statusError` 字段区分「确认无进程」与「扫描失败」；Swift 侧扫描失败时显示「状态未知」而非「未运行」，且不自动启动。
- **状态**：已修复。

### B8. 配置 reload 回调关停竞态（M6b）+ install.sh 校验和（M4）+ 其它低危
- reload 回调加 `stopped` 门闩：已修复。
- install.sh：release 产 `.sha256`，脚本 `shasum -c`：已修复。
- hls-runtime 版本常量从 package.json 读取，消除手工漂移；`loadEmbeddedSource` catch 收窄为仅缺失模块静默：已修复。
- Swift `loadConfig` 字段改可选 + 默认，与 bun normalize 对齐：已修复。
- release.yml 未使用的 `workflow_dispatch.tag` 输入：已接入 checkout。

### B9. 既有核心代码（cdp-connection / rpc-bridge / injector / injection 生命周期）
- **审查方式**：这一维度的自动 review agent 因上游配额错误中断，未完成。我手工复核了最高风险路径：
  - `injector.mjs` 的扫描串行化（`#runScan` 加锁）、会话回收（isOpen 检查）、stop 期间 connect 竞态处理——均已妥善。
  - `cdp-connection.mjs` 的 pending 超时（unref）、close 时 reject 全部 pending、监听器清理——完整。
  - `injection.mjs` 的 `cleanupEmby`/`cleanupHongguo`/`cleanupPlayback`：object URL（video/subtitle/image cache）、RPC pending、timer、FFmpeg 会话均在卸载路径显式释放，无发现泄漏。
- **结论**：未发现新的高危缺陷。若需更彻底，可在配额恢复后补跑一次该维度的 agent。
- **状态**：手工复核通过。

---

## 三、隐私 / 发布准备（详见任务 14）

已处理：
- README 删除写死的本机绝对路径（3 处），改为相对路径。
- `.gitignore` 加固：`config.json`/`runtime.json`/`emby*.json`/`*.tar.gz`/`*.app/`/`.env`/`*.local`，以及内部研究/规划文档。
- `package.json` 补 `license: MIT`，description 去掉「红果」字样，保留 `private: true` 防误发布；新增根 `LICENSE`（MIT + ffmpeg GPL 说明）。
- **package-lock.json 已在公网 registry 重新生成**：`rm -rf node_modules package-lock.json && npm install --registry=https://registry.npmjs.org/`，17 处内网镜像引用清零，全部 `registry.npmjs.org`，测试仍 148 全绿。
- 从 git 跟踪中移除 3 份内部研究/规划文档（保留在本地磁盘，仅不发布）。
- 本仓库 git local `user.name/email` 已改为公开 GitHub noreply 身份（`foriLLL`），新提交不再带企业邮箱。
- README 与 install.sh 的仓库 owner 统一为实际 remote `foriLLL/codex-companion`（原先误写 `Fei-Away`）。

**仍需用户决定 / 用户侧操作（我不擅自处理）**：
1. **git 历史里的旧提交仍带企业邮箱与个人邮箱**。新提交已换公开身份，但要彻底清历史需用户确认后执行破坏性操作（全新 `git init` 重做首次提交，或 `git filter-repo` 改写作者）。
2. **红果版权/身份关联**：README 与源码大量引用 `hongguoduanju.com` 并描述抓取行为。是否重命名为中性代号 / 删减描述，是产品与法律决策，需用户定夺（已在更早的对话中反复提示）。

## 四、并排「卡片按钮」+ 与 Toggle Summary 互斥（新增功能）

在实现「独立按钮控制卡片、与原生 Toggle Summary 互斥」时，暴露并修复了几个 CDP DOM 注入的真实陷阱（smoke 与真机 CDP 双重验证通过）：

### D1. MutationObserver 自触发导致微任务风暴（渲染冻结）
- **问题**：`ensurePlacement` 自身改 DOM（隐藏原生面板、写 rail 定位、同步 host CSS 变量、写按钮 aria-pressed），被同一 observer 捕获 → 再次 `schedulePlacement` → 每轮都产生 mutation 时形成无限微任务循环，renderer 冻结（CDP evaluate 超时）。
- **修复**：① 属性写入前比较值，只在变化时写；② `runPlacement` 跑 `ensurePlacement` 前 `observer.disconnect()`，结束后 `takeRecords()` 丢弃自产 records 再重连，彻底切断自触发回环。所有放置入口统一走 `runPlacement`。

### D2. rail 定位依赖被隐藏面板的坍缩尺寸而抖动
- **问题**：隐藏原生面板后其 bounds 归零，`positionAnimatedRail` 每轮算出不同 top，又一个循环源。
- **修复**：standalone+cards 下 rail 直接贴列顶（top:0），不依赖被隐藏面板 bounds。

### D3. 函数声明顺序（TDZ）
- **问题**：挂载时立即执行的 `ensurePlacement`→`ensureCompanionButton` 用到其后定义的 `const makeToolbarIcon`，触发 "Cannot access before initialization"。`new Function()` 只解析不执行，发现不了；smoke 执行时才暴露。
- **修复**：把首次 `runPlacement()` + observer 启动移到 `makeToolbarIcon` 定义之后。**教训：注入源正确性必须靠真实执行（smoke）验证。**

### D4. 互斥的状态判定
- **问题**：用户点原生按钮关掉再打开时，我们的 cards 意图不能残留，否则重开会错误显示卡片。
- **修复**：每轮观察原生 trigger 开合态，检测 open→closed 跳变即清 cards 意图，让原生 summary 重开时正确接管。

### D5. 顶栏按钮点击穿透（真机才暴露）
- **问题**：注入的按钮插进去、可见、但**点不动**。真机 CDP 命中测试显示按钮中心点最上层元素是背后的内容层，`getComputedStyle(button).pointerEvents === "none"`。根因：Codex 顶栏 `header` 是 `pointer-events:none` 的窗口拖拽区（`-webkit-app-region:drag`），克隆原生按钮的 className 没有把 `pointer-events`/`no-drag` 带回来 → 点击穿透。
- **修复**：给按钮显式 `pointer-events:auto !important` + `-webkit-app-region:no-drag !important`，不依赖克隆 class。smoke 增加 `getComputedStyle(button).pointerEvents === "auto"` 断言防回归；真机 CDP 命中测试确认 `topIsOurButton:true`、点击后卡片正常打开。

### D6. 原生 Toggle Summary 在 cards 模式下被高亮
- **问题**：点卡片按钮时原生 Toggle Summary 也高亮。因为卡片装在原生面板里，卡片显示 = 原生面板必须 open = 原生按钮进入激活态（class `bg-token-foreground/5` / `data-[state=open]:bg-token-foreground/10`）。
- **修复**：仅在 `panelIntent==="cards"`（卡片借用面板）时，给原生 trigger 加标记属性 + 注入文档级 `<style>` 把其背景压成 transparent；退出 cards / 用户自己开 summary / 卸载时移除标记与 style。真机验证：cards 打开时原生按钮背景透明、用户自己开 summary 时原生高亮照常（未压过头）。smoke 断言标记属性的加/removed。



### 定位鲁棒性
`findSummaryToggle` 多策略打分（多语言 aria-label + aria-controls→dialog + header 内图标按钮位置），替换写死的英文 `"toggle summary"` 字面量 —— 顺带修掉「界面切非英文时卡片/按钮消失」的既有隐患。

### 验证
- 152 项单测全绿；smoke 新增 standalone 场景（插入位置、开合、互斥、卸载清理、中文 aria-label 定位）通过。
- **真机 CDP 验证**：连活跃 Codex 确认按钮插入真实 header 工具栏、点击开合卡片、与原生 summary 互斥均符合预期。


## 五、Emby 使用中发现的两个问题

### E1. 搜索/媒体库只有一个结果时卡片被纵向拉伸
- **问题**：`.emby-library-grid` 同时是 `.emby-scroll`（`flex:1` 撑满卡片高度），grid 默认 `align-content: stretch`，单行结果被拉满整个高度，海报按 `aspect-ratio:2/3` 居中，上下大片空白（样式诡异）。
- **修复**：`.emby-library-grid` 加 `align-content: start`，单行/少量结果贴顶、按内容高度排列。

### E2. FFmpeg 转封装播放卡顿（“看一秒卡三秒”）
- **问题**：非 H.264 直连、走本机 FFmpeg 重封装的内容（如 MKV 剧集）播放严重卡顿。根因：FFmpeg 会话的 `next()` 每次只返回**一个** fMP4 分片（`frag_duration≈2s`），renderer 的 pump 是严格串行（`rpc(next)`→append→再请求）。每个分片一次 CDP 往返 + base64，往返开销跟不上播放速度 → 缓冲喂不满 → 反复 underrun。对比：MP4 直连路径（`direct-mp4-session`）早已按字节上限**批量**返回，所以不卡。
- **修复**：FFmpeg 会话 `next()` 改为打包多个已就绪分片一起返回（上限 `NEXT_BATCH_BYTES=6MiB`），与 MP4 路径对齐，单次往返可交付多段，往返次数 ~N× 降低。新增 2 个单测覆盖“打包多段”“超上限分批”。
- **仍需真机确认**：卡顿改善程度取决于源拉流速度与是否触发重编码（HEVC/AC3 会走 `libx264 veryfast` 重编码，是另一条 CPU 瓶颈）。若仍卡，下一步查 RangeProxy 拉流速度与是否误判成重编码。

### E3. 红果瀑布流向下滚动时上方封面消失
- **问题**：feed 往下刷，先前加载的封面变空白。根因：`trimHongguoImages` 按纯 LRU 淘汰，缓存超过 30 张/12MiB 时 `revokeObjectURL` 最旧的 Blob URL——但那些 URL 仍被已滚出视口、仍在 DOM 里的 `<img>` 引用，revoke 后图变空白。
- **修复**：淘汰前收集所有在场 `<img>` 的 `src` 为 in-use 集合；仍被引用的条目不 revoke、重新放回队尾保活，只回收无人引用的。加 `guard` 防止全部在用时空转。缓存上限实际变为 `max(30, 在场数)`，内存仍受 feed DOM 规模约束。smoke 扩到 44 张封面（超上限），断言在场封面 blob URL 全部可 fetch（未被 revoke）。

### E4. 红果首页移除说明字段
- 删除首页 `内容来自 hongguoduanju.com 公开网页…` 的 `hg-caption`（用户不需要）。同步移除对应 smoke/单测断言。

### E5. 长时间播放导致 companion / Renderer 内存升到 10GB+
- **问题**：fMP4 每批分片先转 Base64，再被 `CdpRpcBridge` 拼进新的 `Runtime.evaluate` 源码。V8 把每次不同的表达式当匿名脚本保留；实测数百个 1–8MiB 匿名脚本累计占用数 GB，视频缓冲本身只有几十秒。
- **约束发现**：Codex 主页面 CSP 的 `connect-src` 不允许 `http://127.0.0.1`，所以 Renderer 不能使用 loopback fMP4/HLS 数据面；强制切换会让红果和 Emby 都无法播放。
- **修复**：保留 CDP binding 媒体通道，但所有 RPC 回包改用静态 `Runtime.callFunctionOn`，响应只作为 `arguments` 参数传入，不再进入脚本源码。fMP4/HLS 每批仍有严格大小和缓冲上限，停止、seek、切集或 Renderer 断开会取消在途 RPC。
- **防回归**：单测用 1MiB canary 验证 `functionDeclaration` 不包含响应内容且不再调用 `Runtime.evaluate`；Chromium 冒烟覆盖 HLS RPC loader，真实集成测试覆盖 manifest、variant 和媒体分片。
