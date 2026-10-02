# Codex Companion

Codex Companion 是一个仅支持 macOS 的非官方桌面增强工具。它通过本机
Chrome DevTools Protocol（CDP），在 Codex Desktop（`ChatGPT.app`）的右栏中
加入红果短剧、River Club 网页入口和 Emby 三张卡片，不修改 `app.asar`、
`/Applications/ChatGPT.app` 或其应用签名。

> 当前版本：`v0.0.1`，属于早期预览。Codex Desktop 的 DOM 更新可能导致注入
> 暂时失效。最后验证环境为 ChatGPT/Codex `26.908.40834`、macOS `26.6.2`。

## 功能

- 红果短剧：公开内容浏览、搜索、选集、播放和倒计时自动连播。
- Emby：多服务器、媒体库、继续观看、最近添加、搜索、选季选集、字幕和进度上报。
- 独立卡片按钮或跟随 Summary 显示；三张卡片可分别关闭并调整顺序。
- 媒体按需流式传输并限制缓冲，不把整部视频下载成 Blob。
- Emby Token 保存在 macOS Keychain；配置文件权限为 `0600`。

Emby 卡片宽度为 300px，高度不超过 400px，并会在较矮窗口中自适应。

## 系统要求

| 场景 | 要求 |
| --- | --- |
| 使用 Release 应用 | macOS 13+；`/Applications/ChatGPT.app`；不要求 Node.js |
| 从源码运行 | Node.js 22+、npm；依赖安装会提供构建所需的 Bun |
| 本机重封装/转码 | 可选的系统 FFmpeg；Release 安装器会优先通过现有 Homebrew 自动安装 |

没有 FFmpeg 时，红果播放、Emby HLS 和常规码率的兼容 MP4 直连仍可使用；只有 MKV、
HEVC、EC-3、复杂多音轨、超过 40 Mbps 的媒体或图形字幕烧录等本机处理路径不可用。也可以通过
`CODEX_COMPANION_FFMPEG=/absolute/path/to/ffmpeg` 指定已有 FFmpeg。

杜比视界/HDR 本机播放需要 `brew install ffmpeg-full molten-vk`。色彩处理优先查找
Homebrew 的 `ffmpeg-full`，保留显式环境变量覆盖；普通 SDR 继续使用常规 FFmpeg。
播放前会实际运行滤镜检测驱动可用性，不具备能力时明确报错，避免输出紫绿偏色。
macOS 本机转码启用 VideoToolbox 解码和编码；杜比 RPU 保留至 libplacebo 色彩映射，
不再为 HDR 强制软件解码。

杜比视界 P5/P8 应用 RPU 元数据后映射到 BT.709 SDR，P7 使用基础层与可用 RPU
（不重建 FEL 增强层）；HDR10/HLG 也经过色调映射。界面显示源格式和“→ SDR”，
这不是原生杜比视界 HDR 输出。实现依据 [FFmpeg libplacebo 文档](https://ffmpeg.org/ffmpeg-filters.html#libplacebo)。

Codex 必须在启动时启用 CDP，无法对已经普通启动的进程事后开启。因此首次
使用前需要从菜单完全退出 Codex。

## 安装

### 已签名 Release

正式 Release 只发布通过 Developer ID 签名和 Apple 公证的应用。安装脚本会
校验下载哈希、归档路径、Bundle ID、代码签名和公证结果，然后保留原版本直到
新版本验证完成：

```bash
curl --proto '=https' --tlsv1.2 -fL \
  https://github.com/foriLLL/codex_companion/releases/latest/download/install.sh \
  -o install-codex-companion.sh
less install-codex-companion.sh
bash install-codex-companion.sh
```

应用安装到 `~/Applications/Codex Companion.app`。如果仓库尚未发布 Release，
请使用下面的源码方式；不要从第三方下载未经签名的安装包。

安装器发现系统缺少 FFmpeg 时，会在已有 Homebrew 的机器上默认执行
`brew install ffmpeg`。Homebrew 不存在或安装失败不会影响主程序安装，结束时会
明确提示受影响的视频格式和补装命令。如需主动跳过自动安装，可以运行
`CODEX_COMPANION_SKIP_FFMPEG=1 bash install-codex-companion.sh`。

### 从源码运行

```bash
git clone https://github.com/foriLLL/codex_companion.git
cd codex_companion
npm ci
npm test
npm start
```

停止维护进程按 `Ctrl-C`。这会结束媒体请求、转码和 Emby 播放会话，但不会关闭
Codex Desktop。

### 构建本地应用

```bash
npm run build:app
npm run build:app -- --target darwin-x64
```

产物位于 `dist/Codex Companion.app`。本地构建默认未签名，只用于开发验证；
公开 Release 工作流会在上传前强制签名和公证。构建产物不包含 FFmpeg。

## 使用

### 启动时使用本机代理

打开 Codex Companion 后，勾选「通过代理启动」、输入本机代理端口（默认 7890），
再点击「启动 Codex」。这个选项只在启动新的 Codex 进程时生效；如果 Codex 已在运行，
先从设置窗口停止 Codex，再按所需选项启动。勾选和端口会由本机设置记住。
设置窗口打开时会等待你的选择，不会自动拉起 Codex。

例如端口为 7890 时，Codex 子进程会收到
`HTTP_PROXY=http://127.0.0.1:7890` 和
`HTTPS_PROXY=http://127.0.0.1:7890`。不勾选时不向 Codex 传递 HTTP 代理环境变量。
此功能不更改 macOS 的系统代理设置。命令行启动也可使用
`node src/cli.mjs launch --proxy-port 7890`。

### 红果短剧

卡片只读取 [hongguoduanju.com](https://hongguoduanju.com/) 公开网页中的 SSR
数据和网页标记为可访问的集数。它不使用红果 SDK、私有 API、登录态或账号权益，
也不绕过 DRM 和访问控制。签名媒体地址过期时会重新读取对应播放页一次。

官网结构、内容可用性和访问规则都可能变化。使用者应自行确认其所在地法律、
站点条款及内容权利允许相应访问；本项目不提供、托管或授权任何视频内容。

### Emby

首次打开卡片时输入服务器地址、用户名和密码。非敏感连接信息保存在：

```text
~/Library/Application Support/codex-companion/emby.json
```

文件只包含服务器地址和标识、UserId、用户名与 DeviceId。每个 AccessToken 独立
存入 macOS Keychain，service 为 `codex-companion.emby`，密码不会落盘。

有多个媒体版本时，用户手动选择始终优先；默认先保留字幕与最高分辨率档，
再优先逐行源并估算输入、转码输出和 Renderer 解码的数据成本。没有 FFmpeg 时，
兼容的直放源会优先于需要本机处理的版本。具体播放路径为：

1. 服务端允许转码时使用 H.264/AAC HLS。
2. 不超过 40 Mbps、单路 H.264 + 至多单路 AAC 的 MP4 经带鉴权的本机
   loopback Range 代理交给原生 `<video>` 持续播放，不经过 CDP Base64 分片。
3. 原生代理不可用时，兼容 MP4 才回退到 MP4Box + 有界 MSE 流。
4. 超高码率 MP4、HEVC、EC-3、多音轨、其他容器或图形字幕烧录交给用户安装的
   FFmpeg，输出 H.264/AAC fMP4；macOS 优先使用 VideoToolbox。

SRT、WebVTT、ASS 和 SSA 等文字字幕由播放器单独渲染；其中 ASS/SSA 会在本机
转换为 WebVTT，不会仅为显示文字而重新编码整段 4K 视频。PGS、VobSub 和 DVB
等图形字幕仍需要烧录。

因此不兼容编码不会先交给 Renderer 再失败；需要第 4 条但系统没有 FFmpeg 时，
界面会明确提示安装或指定 FFmpeg。

连接前可以运行只读探针：

```bash
npm run probe:emby -- --server https://emby.example.com --username alice --search 三体
```

密码仅通过终端无回显输入；探针不写配置或钥匙串。

## 工作原理

1. 启动器仅在 `127.0.0.1` 上分配随机 CDP 端口并启动 Codex。
2. Renderer 通过 CDP binding 发送控制和元数据 RPC，响应通过静态
   `Runtime.callFunctionOn` 参数传递，媒体内容不会拼入动态脚本。
3. Node 进程访问红果、Emby 和允许的媒体 CDN；Renderer 不直接接触凭证或远端。
4. 兼容 MP4 通过秘密 loopback URL 持续 Range 播放；CSP 受限或代理不可用时，
   MP4Box 才按关键帧生成可回收的 fMP4。HLS、MSE 与 FFmpeg 路径都有背压和缓冲上限。
5. 返回、seek、切集、登出、Renderer 关闭或维护进程退出时，会取消请求、Blob URL、
   字幕文件、转码进程和服务端活跃播放会话。

常用开发命令：

```bash
npm start                         # 启动 Codex 并常驻注入
npm run attach -- --port 56837   # 复用已经开启的 CDP 端口
npm run unmount -- --port 56837  # 移除卡片
npm test                          # Node 内置测试运行器
npm run smoke                     # Chromium 冒烟测试
```

`npm run inject` 只做一次静态注入后退出，RPC 随即不可用，不能用于实际浏览或播放。

## 安全与隐私

CDP 是高权限调试接口。项目强制绑定 loopback 和随机端口，禁止将端口改为
`0.0.0.0` 或暴露到局域网/公网；只应在可信的本机账户中运行。

Emby Token 只发往配置的 Emby origin，不进入 DOM、媒体 URL、FFmpeg 命令行或
日志。跨源媒体 CDN 必须使用 HTTPS，并经过地址、DNS 和公网 IP 校验。依赖版本
由 `package-lock.json` 固定，运行时不加载 CDN 脚本。

安全问题请按 [SECURITY.md](SECURITY.md) 私下报告。不要在公开 issue 中提交
Token、服务器地址、日志原文或其他隐私信息。

## 已知边界

- 不支持 Windows、Linux、Emby Connect、服务器自动发现、Live TV、音频库和 DRM。
- 不关闭 TLS 校验，不支持自签名 Emby HTTPS。
- 收起播放器或 Summary 会保留后台播放；禁用卡片或退出应用才释放会话。不支持 Emby 自动连播、在线字幕搜索或字幕时间轴偏移。
- 红果仅支持公开播放页提供的 MP4 和当前 Renderer/FFmpeg 可处理的编码。
- 默认使用独立的“播放器”按钮与 Shadow DOM 浮层（优先以播放图标排在顶栏 Share 与 Summary 之间；无法定位时显示右上方悬浮按钮，点击开关，播放器内 Esc 关闭）。打开时给会话和输入框预留宽度，关闭/卸载恢复原生布局；页面重建时自动恢复。独立模式与 Summary 互斥：打开播放器会关闭原生 Summary，打开 Summary（含快捷键）会收起播放器。播放器开合采用淡入淡出及轻微缩放，支持中途反向切换；系统“减少动态效果”开启时直接切换。
- 顶栏入口依次定位 Summary 前、Share 后的空间，支持多语言标签、嵌套容器和 `role="toolbar"`。挂载后检查实际可点击性；原生结构变化时保留悬浮入口。DOM 注入仍依赖 Codex 提供 CDP，不能承诺所有未来版本都兼容。
- “随 Summary”把播放器卡片排在原生摘要卡片下方，保持 24px 间距、共同滚动与开合。Summary 关闭时卡片一起收起，不会切成独立浮层；兼容新版背景样式与多层动画容器。
- 仍依赖 Codex 启动时启用 CDP、主窗口地址及浏览器标准 DOM。若 Codex 改变这些机制，仍需适配；无法保证未来所有更新都兼容。

## 卸载

完全退出 Codex Companion 后删除：

```bash
rm -rf "$HOME/Applications/Codex Companion.app"
```

如需同时清除 Emby 配置，请手动删除
`~/Library/Application Support/codex-companion/`，并在“钥匙串访问”中删除
`codex-companion.emby` 项。删除配置与凭证不可恢复。

## 参与贡献

开发流程见 [CONTRIBUTING.md](CONTRIBUTING.md)，版本变化见
[CHANGELOG.md](CHANGELOG.md)，第三方组件见
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

项目源码采用 [MIT License](LICENSE)。Codex Companion 与 OpenAI、ChatGPT、
Codex、字节跳动、红果短剧及 Emby 均无隶属、授权或背书关系；相关名称和商标
归各自权利人所有。


### 网页入口与后台播放

独立模式点击“播放器”收起时，Emby 保留播放会话、媒体元素、进度和音量，继续后台播放；再次展开不会重新取源。返回媒体列表、明确停播、关闭注入或重启后台仍会释放播放。

River Club 默认位于红果与 Emby 之间，可在设置中开关和排序。入口在系统浏览器打开原站，保留站点自己的飞书登录。原站返回 `X-Frame-Options: SAMEORIGIN`，不能直接嵌入 Codex 的 iframe；没有移除或绕过这一策略。邀请链接存本机 0600 的 `config-v2.json` 中 `cards.riverclub.settings.url`（旧 `riverclubUrl` 自动迁移），不会写进发布代码。

红果新版官网的 `_ROUTER_DATA` 裸变量、`homeSections[].video_list` 和 `series_title` 已兼容，并保留旧结构支持。真实官网首页、详情及首集播放已验证，官网未开放的集数仍不能播放。

### 摸鱼小游戏

播放器中新增「摸鱼」卡片，默认排在最前；可在 Companion 设置中关闭或拖动排序。
包含本地实现的 2048、9×9 扫雷（10 雷、首击安全）和经典单张翻牌接龙。
不请求外部网站；三款游戏分别保存进度到当前 Codex 页面来源的 localStorage，
收起、切换游戏和重新注入后可以继续。清除应用网页数据会清除存档。
2048 的方向键只在游戏卡片获得焦点时接收；各游戏支持最多 30 步撤销（撤销历史不跨重挂载保存）。
验证：`node --test test/games.test.mjs`、`node scripts/smoke-games.mjs`。

## 新卡片接入

平台统一管理外框与 24px 间距、独立 Shadow DOM、增量配置、生命周期、存档和 RPC。
新增可信内置卡片只新增 `src/cards/<id>/` 目录，不修改公共卡片名单或 Swift 设置。

```bash
npm run card:create -- my-card --title 我的卡片
npm run generate:renderer
npm test
npm run smoke
npm run smoke:backend
```

新卡默认关闭；在设置中启用。带后端方法的卡片可在创建时增加 `--service`。

设置统一通过后端 `config get/patch` 命令写入带 revision 的 v2 配置，支持字段补丁、
冲突提示和未知卡片保留。首次运行保留旧配置并备份；迁移后请使用新版设置窗口，
旧版本设置仍写旧文件，不会覆盖 v2。
