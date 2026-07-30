# AGENTS.md

Codex Companion — 通过 Chrome DevTools Protocol (CDP) 向 Codex Desktop
(macOS 上的 ChatGPT.app) 的右栏注入两个独立 Shadow DOM 卡片：红果短剧
与 Emby。不修改 app.asar，不破坏应用签名。仅支持 macOS (arm64 + x64)。

## 技术栈
- JavaScript ESM (`.mjs`, `"type": "module"`)，Node.js >= 22
- 打包用 Bun (`bun --compile`)；启动器为 Swift/SwiftUI (AppKit)
- 依赖本地精确锁定，无 CDN：ffmpeg-static、hls.js、mp4box、undici

## 目录结构
- `src/` — 核心逻辑。入口 `cli.mjs`；`injection.mjs` 为注入的卡片
  UI/CSS/渲染器；`emby-*.mjs` Emby 相关；`hls-proxy.mjs` Emby HLS 的
  127.0.0.1 本地代理（替代 RPC + base64 分片通道）；`hongguo.mjs` 红果短剧；
  `daemon.mjs` 看门狗；`cdp-connection.mjs`、`rpc-bridge.mjs` 通信层
- `test/` — `*.test.mjs`，Node 内置 test runner
- `scripts/` — 构建 (`build-app.mjs`)、生成 (`generate-hls-embed.mjs`)、
  探测 (`probe-emby.mjs`)、冒烟 (`smoke-*.mjs`)
- `packaging/` — `install.sh` 与 macOS 启动器 (`mac-app/`)
- `docs/REVIEW-NOTES.md` — 发版前代码评审记录

## 常用命令
- 启动并注入：`npm start`（会以带 CDP flag 的方式拉起 Codex）
- 测试：`npm test`（即 `node --test`）
- 构建 .app：`npm run build:app`（默认 arm64；`-- --target darwin-x64`）
- 冒烟/探测：`npm run smoke` / `npm run probe:emby`

## 代码约定
- 无 lint/format 配置。风格：2 空格缩进、双引号、分号、ESM
- 注释与文档用中文，代码标识符用英文
- 提交信息遵循 Conventional Commits（`fix:` / `feat:` / `chore:`）
- 分支命名：`agent/*`、`codex/*`、`feature/*`、`fix/*`

## 关键陷阱
- **CDP 必须在启动时开启**：无法对已运行的 Codex 事后附加。改动前
  先完全退出 Codex，再 `npm start`
- **测试必须用 `node --test`，不要用 `bun test`**：Bun 转译器会改写
  函数体，破坏基于 `toString()` 的源码断言（见 REVIEW-NOTES A1）。
  Bun 仅用于编译打包
- `src/hls-embedded.generated.mjs` 为生成产物且 gitignored；dev 模式
  会回退到磁盘读取，本地缺失属正常
- **安全红线**：CDP 调试端口只绑 loopback + 随机端口，禁止改为
  0.0.0.0；Emby AccessToken 存 macOS Keychain，连接信息存
  `~/Library/Application Support/codex-companion/emby.json` (0600)
- `npm run inject` 是一次性注入后退出，RPC 随之结束，只能看静态布局，
  不能用于浏览/播放
- ffmpeg-static 为 GPL 构建，分发受 GPL 约束
