# AGENTS.md

Codex Companion — 在 Codex 桌面端（macOS；Linux 预览）中注入红果短剧、Emby、小游戏、代理状态与任务看板。
不修改 app.asar 或应用签名：launchd 常驻 agent 监听 Codex 启动，刚打开且未带调试参数的 Codex
在安全条件下被正常退出、以 loopback 随机端口重开，再经 CDP 注入卡片；设置页在 Codex 内（卡片区齿轮）。
Linux 不自动重开：用户级 `chatgpt.desktop` 覆盖菜单入口（`open-codex` 带调试参数启动），
systemd 用户服务常驻发现并注入；主进程 cmdline 被 Chromium setproctitle 改写成空格拼接的一行。
官方插件（MCP Apps）链路已彻底放弃并删除，不要再加回来。

## 技术栈
- JavaScript ESM (`.mjs`, `"type": "module"`)，Node.js >= 22
- 打包用 Bun (`bun --compile`)；引导/备用设置 App 为 Swift/SwiftUI (AppKit)；
  原生助手 `companion-native` 为 Swift 命令行（NSWorkspace 观察与进程动作）
- 依赖本地精确锁定，无 CDN：hls.js、mp4box、undici；FFmpeg 由用户自行安装

## 目录结构
- `src/agent/` — 无感注入 agent：`controller.mjs` 状态机（纯逻辑）、`adapter.mjs`
  平台动作、`session.mjs` 注入会话、`main.mjs` 常驻运行时与单实例锁、
  `launch-agent.mjs` 安装/卸载/状态/重启命令、`native-bridge.mjs` 原生助手封装、
  `linux-service.mjs` systemd 用户服务与菜单入口覆盖、`open-codex.mjs` Linux 菜单入口启动器
- `packaging/mac-app/Native/` — 原生助手源码；`scripts/smoke-native.mjs` 只对 dummy app 冒烟
- `src/platform/` — 平台差异集中处：`paths.mjs` 数据目录/PATH 查找/路径包含判断、
  `processes.mjs` Linux `/proc` 进程发现、
  `secret-store.mjs` 凭证存储（钥匙串 / DPAPI / Secret Service）
- `src/` — 共用核心逻辑。旧入口 `cli.mjs`；`injection.mjs` 为旧注入的卡片
  UI/CSS/渲染器；`emby-*.mjs` Emby 相关；`hls-proxy.mjs` Emby HLS 的
  127.0.0.1 本地代理（替代 RPC + base64 分片通道）；`hongguo.mjs` 红果短剧；
  `daemon.mjs` 看门狗；`cdp-connection.mjs`、`rpc-bridge.mjs` 通信层
- `test/` — `*.test.mjs`，Node 内置 test runner
- `scripts/` — 构建 (`build-app.mjs`、`build-linux.mjs`、`build-native.mjs`、`prepare-installer.mjs`)、生成 (`generate-renderer.mjs`)、
  探测 (`probe-emby.mjs`)、冒烟 (`smoke-*.mjs`)
- `packaging/` — `install.sh`（macOS 与 Linux）与 macOS 启动器 (`mac-app/`)

## 常用命令
- 以源码注册 agent：`npm start`（即 `agent install`）
- 无感注入 agent：`node src/cli.mjs agent [--log-dir <dir>]`（常驻）、
  `agent install|uninstall|status|restart-codex`；原生助手 `node scripts/build-native.mjs`
- 原生冒烟：`node scripts/smoke-native.mjs`（默认档不抢焦点；`--interactive` 会激活窗口）
- 旧一次性 CDP 启动与注入：`npm run start:legacy`
- 测试：`npm test`（即 `node --test`）
- 构建 .app：`npm run build:app`（默认 arm64；`-- --target darwin-x64`）
- 构建 Linux 后端：`npm run build:linux -- --target linux-x64|linux-arm64`；Release 由
  `scripts/prepare-installer.mjs` 把 Team ID、tag 与 Linux 归档 SHA256 写入 `install.sh`
- 冒烟/探测：`npm run smoke` / `npm run probe:emby`

## 代码约定
- 无 lint/format 配置。风格：2 空格缩进、双引号、分号、ESM
- 注释与文档用中文，代码标识符用英文
- 提交信息遵循 Conventional Commits（`fix:` / `feat:` / `chore:`）
- 分支命名：`agent/*`、`codex/*`、`feature/*`、`fix/*`

## 关键陷阱
- Codex 的 Electron fuse 已关闭 inspect/RunAsNode/NODE_OPTIONS，CDP 只能在**启动参数**上开启；
  已运行且未带参数的 Codex 只能重启后注入。agent 只自动重开「刚启动、未被操作、在前台」
  的实例（守卫在 JS 状态机与原生助手两侧各查一次），其余情况只通知，绝不强杀。
- 退出 Codex 只能用 `NSRunningApplication.terminate()`；禁止 SIGKILL、forceTerminate。
  Linux 上 agent 不退出也不重启 Codex，只提示用户从应用菜单重开。
  开发与测试禁止对真实 Codex 执行 quit/launch/show，原生能力只对 dummy app 验证。
- 配置 `config-v2.json` 是唯一事实来源：设置页、Swift App 都通过
  revision + 文件锁写入；agent 由 config watcher 热更新。
- 平台 RPC 命名空间 `companion.*` 保留给设置页，卡片 id 不能为 `companion`。
- **测试必须用 `node --test`，不要用 `bun test`**：Bun 转译器会改写
  函数体，破坏基于 `toString()` 的源码断言。
  Bun 仅用于编译打包
- `src/*.generated.mjs`、`src/cards/*.generated.mjs` 由 `npm run generate:renderer`
  生成（`pretest` 自动执行），不要手改
- **安全红线**：CDP 调试端口只绑 loopback + 随机端口，禁止改为
  0.0.0.0；Emby AccessToken 只存系统凭证库（`src/platform/secret-store.mjs`），
  明文不得出现在命令行参数（macOS `security` 除外）；连接信息存数据目录下 `emby.json` (0600)
- 跨平台：平台分支函数接受 `platform` 参数，测试显式传入；macOS 专属能力（launchd、
  通过代理重启 Codex、`/bin/ps`、`defaults`）在其它平台返回「不支持」而非抛 ENOENT；
  文件权限断言用 `test/helpers/permissions.mjs` 的 `assertMode`
- `npm run inject` 是一次性注入后退出，RPC 随之结束，只能看静态布局，
  不能用于浏览/播放
- 公开 `.app` 不打包 FFmpeg；本机转码只调用用户通过 PATH、常见包管理器路径或
  `CODEX_COMPANION_FFMPEG` 指定的系统 FFmpeg
- tag Release 必须 Developer ID 签名并经 Apple 公证；缺少凭据时工作流应失败关闭。
  Linux 没有平台签名，install.sh 只下载同 tag 归档并比对写入脚本的 SHA256，不跟随 latest
