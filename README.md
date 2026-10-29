# Codex Companion

Companion 是一个非官方的 Codex 桌面端（macOS / Linux）增强，把红果短剧、Emby、小游戏、
代理状态和跟踪多个会话的任务看板注入到 Codex 聊天旁。后台服务随登录启动，
安装一次后日常只需打开 Codex，不用单独启动 Companion。
不修改 `app.asar`、Codex 安装包或应用签名。

> Codex Companion 与 OpenAI、ChatGPT、Codex、字节跳动、红果短剧及 Emby 均无隶属、
> 授权或背书关系；相关名称和商标归各自权利人所有。

## 功能

- **红果短剧**：公开内容浏览、搜索、收藏、选集、播放和倒计时自动连播。
- **Emby**：多服务器、媒体库、继续观看、最近添加、搜索、选季选集、选源、字幕和进度上报。
- **小游戏**：2048、扫雷和纸牌，存档保存在本机。
- **代理状态**：查看当前 Codex 的启动代理与本机端口连通性。
- **任务看板**：把正在推进的 Codex 会话钉在一处，实时显示进行中、等你回答、已中断等状态，
  悬停查看单个会话的 Trace。
- **卡片管理**：分别启停、调整顺序；跟随宿主明暗主题。

收起卡片保留页面状态；关闭页面、取消请求或后台退出时回收
媒体会话、Blob URL、分片缓存与转码进程。

## 平台支持

Codex 已关闭 Electron 的运行时调试入口，注入依赖以启动参数开启的本机 CDP，两个平台
加载卡片的方式不同：

| 平台 | 加载方式 | 数据目录 |
|---|---|---|
| macOS（Apple Silicon / Intel） | 原生助手识别刚打开的 Codex，安全退出后带调试参数重开 | `~/Library/Application Support/codex-companion/` |
| Linux（预览，x64 / ARM64） | 覆盖应用菜单里的 ChatGPT 入口，打开时直接带上调试参数，不需要重开 | `~/.config/codex-companion/` |

Linux 版为预览：已验证安装、启动、连接、注入与 RPC，登录后会话界面里的卡片位置尚未在 Linux 上验证。

## 系统要求

- macOS 上的 Codex 桌面端，或 Linux 上官方 deb / rpm 安装的 ChatGPT 桌面版
  （`/usr/lib/chatgpt/ChatGPT`，其它位置用 `CODEX_COMPANION_CODEX_EXECUTABLE` 指定）。
- Linux 需要 systemd 用户服务（`systemctl --user`）；可选 `notify-send`（libnotify）用于
  提示重开，`secret-tool`（libsecret）用于保存 Emby Token，缺少时 Token 存到数据目录下 `0600` 的文件。
- 使用发布版（macOS 的 `.app`、Linux 的单文件后端）不需要 Node.js；从源码运行需要 Node.js 22+ 与 npm
  （依赖安装会提供固定版本的 Bun）。
- 可选：系统 FFmpeg，用于本机重封装、转码与复杂字幕。项目不打包 FFmpeg，
  只查找 `CODEX_COMPANION_FFMPEG`、`PATH` 与 Homebrew / MacPorts（Linux 另含 `/usr/bin`、snap、Linuxbrew）目录。

macOS 上的杜比视界 / HDR 本机播放需要 `brew install ffmpeg-full molten-vk`；
P5/P8 使用 RPU 映射到 BT.709 SDR，HDR10/HLG 做色调映射，这不是原生 HDR 输出。

## 安装

### 使用发布版（推荐）

```sh
curl -fsSL https://github.com/foriLLL/codex_companion/releases/latest/download/install.sh | bash
```

macOS 上，安装器下载经 Developer ID 签名与 Apple 公证的 `Codex Companion.app`，校验后安装到
`~/Applications` 并打开引导；在引导中点击「启用自动加载」，注册登录后自动启动的
后台服务（如需批准，前往「系统设置 › 通用 › 登录项」）。已有 Homebrew 时会补装 FFmpeg。

Linux 上先安装官方 ChatGPT 桌面版，再运行同一条命令。安装器下载与脚本同版本的单文件后端，
按发布时写入脚本的 SHA256 校验后放到 `~/.local/share/codex-companion`，注册 systemd 用户服务
并覆盖应用菜单里的 ChatGPT 入口，不需要 sudo。之后从应用菜单打开 ChatGPT 即可；安装时
ChatGPT 若已开着，需要退出后从菜单重开一次。FFmpeg 需自行安装（如 `sudo apt install ffmpeg`）。

### 从源码安装（开发者）

```sh
npm ci
npm start        # 生成渲染器并以当前源码注册后台服务（macOS：launchd；Linux：systemd 用户服务）
```

开发安装的后台服务直接运行当前 Node 与仓库源码；更换 Node 版本或移动仓库后需重新执行。

Linux 上 `npm start` 同样以源码注册 systemd 用户服务并覆盖菜单入口。

### Linux 安装写入的文件

安装会写入两个文件：`~/.config/systemd/user/codex-companion-agent.service`，以及与系统同名的
`~/.local/share/applications/chatgpt.desktop`。后者只把启动命令换成 Companion 的入口，
名称、图标和 `codex://` 等协议关联保持不变。如果这个位置已有你自己的同名文件，安装会停下，不会覆盖。

### 打开 Companion

后台服务（launchd `com.codexcompanion.agent`）在 Codex 刚启动、尚未操作且位于前台时，
请求它正常退出，再以 `--remote-debugging-address=127.0.0.1` 和随机端口重开并注入卡片。
已经在使用的 Codex 窗口不会被自动退出，只提示需要重开；两次自动重开至少间隔两分钟。

注入后 Codex 顶栏出现 Companion 入口，点开即显示卡片；设置（卡片区齿轮）里可以改为
排在原生摘要下方。后台服务崩溃后由 launchd 自动拉起，并重新连接已开启调试端口的 Codex。

Linux 上从应用菜单打开 ChatGPT 即可：入口以 `--remote-debugging-address=127.0.0.1` 和随机端口
启动它，常驻服务发现后连接并注入。在终端直接运行 `chatgpt`、或安装时 ChatGPT 已经开着，
都不会带调试参数，此时会提示退出后从应用菜单重新打开。Companion 不会在 Linux 上自动退出或重启 ChatGPT，
修改启动代理后同样需要手动从菜单重开。

## 使用

- 设置中调整卡片开关与顺序；关闭卡片保留存档。
- 「Codex 启动代理」保存启动偏好后，点击「保存并重启」应用。

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
2. 兼容的 H.264/AAC MP4 经 CDP 媒体拦截原生播放，或经 MP4Box 分段，通过有界 RPC 分片和 MSE 播放。
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

### 任务看板

- 打开一个会话后点「加入当前会话」，它会一直留在看板上，左侧侧栏对应条目也会标上
  同样的颜色；做完点 ✓ 移出，几秒内可以撤销。最多保留 100 个任务。
- 状态图标实时更新：等你回答、已中断、超过 15 分钟无响应排在最前，其次是没看过的新回复，进行中的放在后面；
  回合结束后没看过的会提醒。点击任务在左侧定位并打开对应会话。
- 名字默认跟随 Codex 的会话标题，可以改成自己的叫法（只改看板，不改 Codex）；
  颜色可以单独调整。
- 鼠标在任务上停一会儿，看板左侧会弹出这个会话的 Trace：按模型、命令、文件、子代理和你分道展示
  时间线，失败与等待你输入的片段单独标出；鼠标移进面板可滚动和缩放，按 Esc 关闭。

## 工作原理

1. launchd 常驻的后台服务经原生助手观察 Codex 启动，在安全条件下以 loopback
   随机调试端口重开 Codex，再通过 CDP 注入卡片渲染器。
2. 页面经 CDP binding 与后台 RPC 通信；各卡片共用渲染器、服务注册表与生命周期管理。
3. 后台访问红果、Emby 和允许的媒体 CDN；页面不直接接触凭证。
4. 媒体经 127.0.0.1 本地代理（HLS）、CDP 媒体拦截或有界 RPC 分片 + MSE 播放；
   每次响应、后台队列、分片缓存与页面缓冲都有上限。
5. 返回、seek、切集、登出或关闭页面会取消对应请求并回收资源；心跳超时也会触发回收。

注入依赖 Codex 的 DOM 结构，Codex 改版后可能需要更新。日志位于
`~/Library/Logs/codex-companion/agent.log`（Linux：`journalctl --user -u codex-companion-agent`），
`node src/cli.mjs agent status` 输出状态。

## 开发

```sh
npm test                                        # 必须使用 Node 内置测试运行器
npm run smoke                                   # Chromium 冒烟
npm run card:create -- my-card --title 我的卡片  # 新建内置卡片
node src/cli.mjs agent                          # 前台运行后台服务
node scripts/build-native.mjs                   # 编译原生助手
npm run build:app                               # 构建 Codex Companion.app
npm run build:linux -- --target linux-x64       # 构建 Linux 单文件后端
npm run start:legacy                            # 旧一次性 CDP 启动与注入
```

新增卡片只需在 `src/cards/<id>/` 下新建目录，平台统一管理外框、Shadow DOM、配置、
生命周期、存档与 RPC；新卡默认关闭。更多约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 安全与隐私

CDP 调试端口强制绑定 loopback 和随机端口，禁止暴露到局域网或公网。卡片、请求代次和
媒体分片相互绑定，关闭或禁用卡片后不能继续读取旧分片。

Emby Token 只发往配置的 Emby origin，不进入 DOM、媒体 URL、FFmpeg 命令行或日志。
跨源媒体 CDN 必须使用 HTTPS，并经过地址、DNS 和公网 IP 校验。依赖版本由
`package-lock.json` 固定，运行时不加载 CDN 脚本。

任务看板只读本机 Codex 数据目录（`~/.codex`，或 `CODEX_HOME`）下的会话记录、
`session_index.jsonl` 与 `.codex-global-state.json`，不写入、不上传；看板自身的
任务列表保存在数据目录下的 `task-board.json`。

安全问题请按 [SECURITY.md](SECURITY.md) 私下报告，不要在公开 issue 中提交 Token、
服务器地址、日志原文或其他隐私信息。

## 已知边界

- 不支持 Emby Connect、服务器自动发现、Live TV、音频库和 DRM；不关闭 TLS 校验，
  不支持自签名 Emby HTTPS。
- 切换到其他卡片时暂停媒体；不支持 Emby 自动连播、在线字幕搜索或字幕时间轴偏移。
- 红果仅支持公开播放页提供的 MP4 和当前页面 / FFmpeg 可处理的编码。
- 已经在使用、未带调试参数的 Codex 需要手动重开一次才能注入。
- Linux 为预览：登录后会话界面中的卡片位置尚未验证；Windows 暂不支持。
- 任务看板的状态由 Codex 本地会话记录推断，依赖其记录格式与侧栏 DOM，Codex 改版后
  可能需要更新。

## 卸载

在 `Codex Companion.app` 中点击「卸载 Companion」再删除 App，或运行
`bash install.sh --uninstall`（Linux 同样适用：停用服务、删除 Companion 生成的菜单入口与程序，
系统原有入口随之恢复）；开发安装使用 `node src/cli.mjs agent uninstall`。

如需同时清除配置与存档，手动删除上文的数据目录；Emby Token 位于「钥匙串访问」
（service 为 `codex-companion.emby`）。删除不可恢复。

## 参与贡献与许可

开发流程见 [CONTRIBUTING.md](CONTRIBUTING.md)，版本变化见 [CHANGELOG.md](CHANGELOG.md)，
第三方组件见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。项目源码采用
[MIT License](LICENSE)。
