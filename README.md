# Codex Companion

Companion 是一个非官方的 Codex 插件，把红果短剧、Emby、小游戏和代理状态放进
聊天旁的会话侧栏。页面通过官方 MCP Apps 协议运行，后端由 Codex 按需自动启动；安装一次后，日常只需打开 Codex，不用单独启动 Companion。
不修改 `app.asar`、Codex 安装包或应用签名。

> Codex Companion 与 OpenAI、ChatGPT、Codex、字节跳动、红果短剧及 Emby 均无隶属、
> 授权或背书关系；相关名称和商标归各自权利人所有。

## 功能

- **红果短剧**：公开内容浏览、搜索、收藏、选集、播放和倒计时自动连播。
- **Emby**：多服务器、媒体库、继续观看、最近添加、搜索、选季选集、选源、字幕和进度上报。
- **小游戏**：2048、扫雷和纸牌，存档通过插件后端保存在本机。
- **代理状态**：查看当前 Codex 的启动代理与本机端口连通性（macOS）。
- **卡片管理**：分别启停、调整顺序；窄侧栏和宽页面自适应，跟随宿主明暗主题。

切换卡片保留页面状态并暂停隐藏的媒体；关闭页面、取消请求或后端退出时回收
媒体会话、Blob URL、分片缓存与转码进程。

## 平台支持

| 能力 | macOS | Windows | Linux |
| --- | :---: | :---: | :---: |
| 官方插件（全部卡片、媒体播放、存档） | ✅ | ✅ | ✅ |
| Emby 凭证保存在系统凭证库 | 钥匙串 | DPAPI（当前用户） | Secret Service，无密钥环时回退 0600 文件 |
| 本机 FFmpeg 转码 | ✅ VideoToolbox 硬件编码 | ✅ 软件编码 | ✅ 软件编码 |
| 代理状态检测；由 Companion 通过代理重启 / 退出 Codex | ✅ | — | — |
| 无感注入（CDP）、`Codex Companion.app`、原生助手 | ✅ | — | — |

插件后端为 Bun 编译的单文件可执行程序，提供 `darwin`、`linux`、`win32` 的
`arm64` / `x64` 六个目标。不支持的功能在界面中降级说明，不影响其它卡片。

本机数据目录：

| 系统 | 路径 |
| --- | --- |
| macOS | `~/Library/Application Support/codex-companion/` |
| Windows | `%APPDATA%\codex-companion\` |
| Linux | `$XDG_CONFIG_HOME/codex-companion/`（默认 `~/.config/codex-companion/`） |

## 系统要求

- 支持本地插件与 MCP Apps 的 Codex 桌面端或 Codex CLI。
- 使用发布的插件包不需要 Node.js；从源码构建需要 Node.js 22+ 与 npm
  （依赖安装会提供固定版本的 Bun）。
- 可选：系统 FFmpeg，用于本机重封装、转码与复杂字幕。项目不打包、不自动安装 FFmpeg，
  只查找 `CODEX_COMPANION_FFMPEG`、`PATH` 与各平台常见包管理器目录
  （Homebrew / MacPorts、apt / Snap / Linuxbrew、winget / Scoop / Chocolatey）。

macOS 上的杜比视界 / HDR 本机播放需要 `brew install ffmpeg-full molten-vk`；
P5/P8 使用 RPU 映射到 BT.709 SDR，HDR10/HLG 做色调映射，这不是原生 HDR 输出。

## 安装

### 从源码安装（推荐给开发者）

```sh
npm ci
npm start        # 构建本机平台的插件并通过官方 CLI 安装
```

安装器只更新本插件的本地 marketplace 与缓存，不更改其他插件、认证或 Codex
安装包，也不会退出正在运行的 Codex。它会依次查找：macOS 桌面端附带的 CLI、
`PATH` 中的 `codex`（Windows 上为 `codex.exe` / `codex.cmd`）。也可以显式指定：

```sh
npm run plugin:install -- --cli /path/to/codex --codex-home "$HOME/.codex"
```

`--codex-home` 必须是桌面端使用的配置目录；省略时依次使用 `CODEX_HOME` 和
`~/.codex`。

### 使用发布的插件包

从 GitHub Release 下载与系统匹配的 `codex-companion-plugin-<os>-<arch>` 包并解压，
然后用 Codex CLI 注册：

```sh
codex plugin marketplace add /path/to/plugin
codex plugin add codex-companion@codex-companion-local
```

macOS 插件包中的后端经过 Developer ID 签名与 Apple 公证。

### 打开 Companion

安装或更新后，保存手头工作并**手动重启** Codex，使本地插件重新加载（见
[官方本地插件流程](https://developers.openai.com/plugins/build/plugins)）。
重启后在聊天中说「打开 Companion」，Codex 会在右侧面板显示插件页面。

## 使用

- 右上角「管理卡片」调整开关与顺序；关闭卡片保留存档。
- 「Codex 启动代理」（仅 macOS）保存启动偏好后，点击「保存并重启」应用。
  其它系统请在系统或 Codex 设置中配置网络代理。
- 游戏存档写入数据目录下的 `plugin-state.json`，不依赖 iframe 的 `localStorage`；
  多个插件窗口共享存档并检查版本冲突。

### 红果短剧

卡片只读取 [hongguoduanju.com](https://hongguoduanju.com/) 公开网页中的 SSR
数据和网页标记为可访问的集数，不使用红果 SDK、私有 API、登录态或账号权益，
也不绕过 DRM 和访问控制。签名媒体地址过期时会重新读取对应播放页一次。

官网结构、内容可用性和访问规则都可能变化。使用者应自行确认所在地法律、
站点条款及内容权利允许相应访问；本项目不提供、托管或授权任何视频内容。

### Emby

首次打开卡片时输入服务器地址、用户名和密码。数据目录中的 `emby.json`（`0600`）
只保存服务器地址与标识、UserId、用户名与 DeviceId；每个 AccessToken 单独存入
系统凭证库（service 为 `codex-companion.emby`），密码不会落盘。

有多个媒体版本时，手动选择始终优先；默认保留字幕与最高分辨率档，再优先逐行源，
并估算输入、转码输出和页面解码的成本。播放路径：

1. 服务端允许转码时使用 H.264/AAC HLS。
2. 兼容的 H.264/AAC MP4 经 MP4Box 分段，通过有界 MCP 分片和 MSE 播放。
3. 超高码率 MP4、HEVC、EC-3、多音轨、其他容器或图形字幕烧录交给本机 FFmpeg，
   输出 H.264/AAC fMP4。

SRT、WebVTT、ASS 和 SSA 等文字字幕由播放器单独渲染（ASS/SSA 在本机转换为
WebVTT），不会仅为显示文字而重新编码视频；PGS、VobSub、DVB 等图形字幕需要烧录。
需要本机处理但没有 FFmpeg 时，界面会提示安装或指定 FFmpeg。

连接前可以运行只读探针（密码在终端无回显输入，不写配置或凭证库）：

```sh
npm run probe:emby -- --server https://emby.example.com --username alice --search 三体
```

### 小游戏

「摸鱼」卡片包含本地实现的 2048、9×9 扫雷（首击安全）和经典接龙，支持最多 30 步
撤销，不请求外部网站。

## 工作原理

1. Codex 读取插件声明（`plugin/`），按 `.mcp.json` 启动打包好的 stdio MCP 后端。
2. MCP Apps 页面通过 AppBridge 调用仅供页面使用的工具；各卡片共用渲染器、
   服务注册表与生命周期管理。
3. 后端访问红果、Emby 和允许的媒体 CDN；页面不直接接触凭证或远端，也不访问
   HTTP loopback。
4. 媒体按需分片传输，通过 MSE、HLS 或 FFmpeg 路径播放；每次响应、后台队列、
   分片缓存与页面缓冲都有上限。
5. 返回、seek、切集、登出或关闭页面会取消对应请求并回收资源；心跳超时也会触发回收。

### 无感注入（仅 macOS，可选）

除官方插件外，macOS 还可以使用 `Codex Companion.app` 提供的无感注入：后台服务
（launchd `com.codexcompanion.agent`）在 Codex 刚启动、尚未操作且位于前台时，请求它
正常退出，再以 `--remote-debugging-address=127.0.0.1` 和随机端口重开并注入卡片。
已经在使用的 Codex 窗口不会被自动退出，两次自动重开至少间隔两分钟。

Codex 已关闭 Electron 的运行时调试入口，CDP 只能通过启动参数开启。该模式依赖
Codex 的 DOM 结构，Codex 改版后可能需要更新。日志位于
`~/Library/Logs/codex-companion/agent.log`，`node src/cli.mjs agent status` 输出状态。

## 开发

```sh
npm test                                        # 必须使用 Node 内置测试运行器
npm run build:plugin                            # 本机平台 → dist/plugin
npm run build:plugin -- --target linux-x64      # 交叉编译：darwin|linux|win32 - arm64|x64
npm run smoke:plugin:backend                    # 按 .mcp.json 启动后端并完成 MCP 握手
npm run smoke:plugin                            # 官方 AppBridge、全部卡片与媒体的浏览器验证
npm run smoke                                   # Chromium 冒烟（旧注入渲染器）
npm run card:create -- my-card --title 我的卡片  # 新建内置卡片
```

macOS 专用：

```sh
npm run start:legacy              # 旧 CDP 启动与常驻注入
node src/cli.mjs agent            # 前台运行无感注入后台服务
node scripts/build-native.mjs     # 编译原生助手
npm run build:app                 # 构建 Codex Companion.app
```

新增卡片只需在 `src/cards/<id>/` 下新建目录，平台统一管理外框、Shadow DOM、配置、
生命周期、存档与 RPC；新卡默认关闭。更多约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 安全与隐私

插件页面使用受限 CSP，通过后端工具访问服务；视图、卡片、请求代次和媒体分片相互
绑定，关闭或禁用卡片后不能继续读取旧分片。旧 CDP 模式强制绑定 loopback 和随机
端口，禁止暴露到局域网或公网。

Emby Token 只发往配置的 Emby origin，不进入 DOM、媒体 URL、FFmpeg 命令行或日志。
跨源媒体 CDN 必须使用 HTTPS，并经过地址、DNS 和公网 IP 校验。依赖版本由
`package-lock.json` 固定，运行时不加载 CDN 脚本。

安全问题请按 [SECURITY.md](SECURITY.md) 私下报告，不要在公开 issue 中提交 Token、
服务器地址、日志原文或其他隐私信息。

## 已知边界

- 不支持 Emby Connect、服务器自动发现、Live TV、音频库和 DRM；不关闭 TLS 校验，
  不支持自签名 Emby HTTPS。
- 切换到其他卡片时暂停媒体；不支持 Emby 自动连播、在线字幕搜索或字幕时间轴偏移。
- 红果仅支持公开播放页提供的 MP4 和当前页面 / FFmpeg 可处理的编码。
- 插件入口、侧栏宽度和页面模式由 Codex 宿主提供。
- Windows / Linux 不提供通过代理重启 Codex 与无感注入。

## 卸载

在 Codex 的插件管理中移除 Companion，或使用与安装时相同 `CODEX_HOME` 的 CLI：

```sh
codex plugin remove codex-companion@codex-companion-local
```

如需同时清除配置与存档，手动删除上文的数据目录；Emby Token 位于 macOS「钥匙串访问」、
Windows 数据目录下的 `credentials\`，或 Linux 密钥环（`secret-tool clear service
codex-companion.emby`）/ 数据目录下的 `credentials.json`。删除不可恢复。

macOS 无感注入：在 `Codex Companion.app` 中点击「卸载 Companion」再删除 App，或运行
`bash install.sh --uninstall`；开发安装使用 `node src/cli.mjs agent uninstall`。

## 参与贡献与许可

开发流程见 [CONTRIBUTING.md](CONTRIBUTING.md)，版本变化见 [CHANGELOG.md](CHANGELOG.md)，
第三方组件见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。项目源码采用
[MIT License](LICENSE)。
