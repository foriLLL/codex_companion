# Codex Companion

通过 Chrome DevTools Protocol（CDP）向 Codex Desktop 的原生 pinned summary 右栏注入两个独立的 Shadow DOM 卡片：上方红果短剧卡片支持搜索、选集、播放和自动连播，下方 `300×400px` Emby 卡片支持多服务器切换、官方媒体库分类浏览、续播、最近添加、搜索、选季/选集和播放。两张卡片与 pinned summary 同步显示和隐藏，关闭原生右栏时不会创建独立的备用侧栏。

实现不修改 `/Applications/ChatGPT.app`、`app.asar` 或应用签名。

## 卡片显示方式（两种，配置窗可切换）

- **独立按钮（默认）**：在原生 Toggle Summary 按钮左侧并排注入一个「卡片按钮」，点击复用原生右栏的开合动画显示卡片。与 Toggle Summary **互斥**——打开一个会关掉另一个，也可同时关闭。按钮外观克隆自原生按钮，主题/悬停/焦点一致。
- **随 Summary 显示**：卡片跟随原生 pinned summary 一起显示/隐藏（旧行为）。

定位原生 summary 按钮采用多语言 + 结构信号，界面切换语言（含中文）不影响。

## 一键安装（面向用户，无需 Node）

分发物是 `bun --compile` 的自包含二进制加 `ffmpeg` sidecar，打包进 `Codex Companion.app`，用户机器**无需预装 Node**：

```bash
curl -fsSL https://github.com/foriLLL/codex-companion/releases/latest/download/install.sh | bash
```

脚本按 CPU 架构下载对应 tarball，安装到 `~/Applications/Codex Companion.app`，去除 Gatekeeper 隔离属性并打开。之后通过「Codex Companion」启动 Codex（首次会带调试参数拉起官方 Codex 并常驻维护注入）；由于 macOS 对已运行的 app 只做激活，首次启动后再点官方 ChatGPT 也不冲突。Codex 退出会自动清理；若检测到 Codex 未带调试参数运行，会发原生通知引导重新启动，不会强制关闭正在运行的任务。日志在 `~/Library/Logs/Codex Companion/launcher.log`。

> 未签名/未公证产物依赖安装脚本去隔离；正式分发建议 Apple Developer ID 签名 + 公证。`ffmpeg-static` 为 GPL 构建，`.app` 内附 `Resources/ffmpeg.LICENSE`，随附分发受 GPL 约束。

### 从源码构建 .app

```bash
npm ci
npm run build:app            # 默认 darwin-arm64
npm run build:app -- --target darwin-x64
```

产物在 `dist/Codex Companion.app`。

## 工作原理

Renderer 不直接访问 Emby 或短剧站点，也不把整部视频缓存为 Blob：

1. 卡片通过 CDP binding 向常驻 Node 进程发送控制与元数据 RPC；RPC 回包作为 `Runtime.callFunctionOn` 参数投递，不把响应内容拼进可执行源码。
2. Node 分别维护短剧和 Emby 服务；Emby Token 只留在 Node，红果官网页面、封面和签名 MP4 也全部由 Node 获取。
3. 红果官网播放页提供签名 MP4；Node 使用 HTTP Range 和 `mp4box@2.4.1` 增量转成 fMP4，不会下载完整视频。分片以有上限的 RPC 参数交给 Renderer，不会生成携带媒体内容的动态脚本。
4. Emby 在允许服务端转码时使用本地 `hls.js@1.6.16` 播放 H.264 + AAC HLS；Codex 的 `app://` CSP 禁止访问 loopback，因此 HLS loader 由 Node 代拉同源资源。禁止转码时，MP4 复用 Range/fMP4 管线，MKV 等其他容器通过一条带背压的持续 Range 流交给 Node 内的 FFmpeg，实时重封装为 fragmented MP4。
5. SRT/WebVTT 字幕由 Node 转成受控的 WebVTT Blob track，不重启视频；ASS/SSA 和 PGS/VobSub/DVB 图形字幕通过 Emby HLS 或本机 FFmpeg 烧录。
6. FFmpeg 会先判断轨道：H.264/AAC 只改变容器、画质不变；HEVC、AC3 或烧录字幕才转换为 H.264/AAC。
7. Renderer 只接收有限分片并写入 MediaSource 时间轴，不直连源站、Emby、localhost 或 123 盘 CDN，也不会逐块替换 `<video src>`。
8. 返回、切换视频、登出、renderer 关闭或维护进程停止时，取消待处理请求、字幕 Blob 和 FFmpeg 子进程；Emby 还会上报最终进度并停止活跃转码。

因此正常播放只保留有限缓冲，不会先下载完整视频。HLS 当前参数为：前向 30 秒、后向 15 秒、24MiB 缓冲、单资源 8MiB、最多 4 个并发资源请求、最高 720p。MP4 随机访问每次 Range 最多 1MiB；FFmpeg 媒体桥会从当前偏移建立一个持续 Range，并把 CDN 响应边到边转发，Renderer 达到 30 秒前向缓冲后产生的 backpressure 会一路暂停到 CDN。seek 会取消旧流、从新位置重连，同时保持同一条原生进度时间轴。

## 运行要求

- macOS 上已安装 `/Applications/ChatGPT.app`（界面产品名为 Codex）。
- Node.js 22 或更高版本。
- Codex 必须带 CDP 参数启动。已经普通启动的进程无法事后打开 CDP。
- Emby 服务器使用 HTTP 或证书有效的 HTTPS；第一版不关闭 TLS 校验，也不支持自签名证书。

## 先验证 Emby 服务器

正式连接卡片前，建议运行只读探针：

```bash
cd codex-companion
npm install
npm run probe:emby -- --server https://emby.example.com --username alice --search 三体
```

密码只在交互式终端中无回显输入，不能通过 `--password` 传入。探针不会写配置或钥匙串；它依次验证认证、媒体目录/图片和 PlaybackInfo，列出字幕的语言、编码、内嵌/外挂及默认/强制状态，并根据服务器能力验证 WebVTT、HLS 烧录或本机 FFmpeg 烧录的首批分片。空媒体库时可通过 `--item <项目ID>` 指定一个可播放项目。

## 启动

先从菜单完全退出当前 Codex，然后运行：

```bash
cd codex-companion
npm start
```

脚本会在 `127.0.0.1` 上分配随机 CDP 端口，启动官方 Codex，注入本地 hls.js 与卡片，并常驻维护 renderer、短剧和 Emby RPC。按 `Ctrl-C` 会先停止媒体请求、Emby 播放会话和活跃转码，再停止注入维护；不会关闭 Codex。

开发时如果 Codex 已经由本工具启动，停止旧维护进程后可复用启动日志中的端口：

```bash
npm run attach -- --port 56837
```

短剧和 Emby 都必须使用 `npm start` 或常驻的 `npm run attach`。`npm run inject -- --port ...` 会在单次注入后退出，RPC 接收方随之消失，只适合检查静态布局；它不能维持内容浏览或播放。

其他命令：

```bash
# 移除卡片
npm run unmount -- --port 56837

# 自动化测试和无头 Chromium smoke
npm test
npm run smoke
```

## 使用红果短剧卡片

卡片只读取 [hongguoduanju.com](https://hongguoduanju.com/) 公开网页中的 SSR 数据。首页推荐来自官网 banner 和目录；搜索在官网公开目录中本地完成。选择短剧后只展示官网标记为可访问的集数，点击即可播放。Node 按需读取签名 MP4，播放覆盖整张卡片并保留原生进度、音量和全屏控制；返回会立即停止解析器和旧 Range 请求。

一集播放结束且官网仍有下一集时，卡片会显示“即将为你播放下一集”并倒计时 5 秒；可以立即播放或取消。取消后仍可手动播放下一集或重播，最后一集只显示重播。返回、换集、报错或卸载卡片都会取消倒计时。

这里没有使用红果 SDK、私有 API 或账号权益，也不会绕过官网的集数限制。例如详情页显示全 76 集但只开放前 5 集时，卡片只提供前 5 集。签名地址过期会重新读取对应官网播放页一次。官网页面结构和公开内容仍可能变化；红果的数据获取与播放状态独立于 Emby，退出任一播放器不会修改另一张卡片的状态。

## 在卡片中连接 Emby

未连接视图输入服务器地址、用户名和密码。地址可以是服务器根地址，也可以带 `/emby` 路径；客户端会统一规范化。成功后首页优先显示 Emby 官方 `Views`（例如华语电影、动画片、综艺），点击后按服务端目录层级浏览；下方保留“继续观看”和“最近添加”。搜索支持 `Movie`、`Series`、`Episode`、`Video`：

- 首页右上角的服务器按钮会列出全部已保存连接；点击另一台服务器会复用它自己的 Keychain Token 并立即刷新首页。可以继续添加服务器、只退出当前服务器，或确认后移除当前连接，均不会覆盖其他连接。
- 旧版单服务器 `emby.json` 会在首次保存时自动升级为多服务器格式，不需要重新登录。

- `Series` 进入季和选集列表。
- `Movie`、`Episode`、`Video` 直接开始播放。
- 播放覆盖整张 Emby 卡片；剧集播放时顶部提供“上一集 / 当前集 / 下一集”，点击当前集会在视频内打开季与选集面板。从“继续观看”直接进入单集时，卡片会在后台补齐剧集上下文，不阻塞首帧。
- 返回会停止请求和转码，并恢复之前的列表及滚动位置。
- 播放器右上角“字幕”菜单支持关闭和多轨切换。SRT/WebVTT 即时切换；ASS/SSA、PGS、VobSub、DVB 从当前时间重启烧录流，并恢复原来的暂停状态、音量和静音状态。
- 当前 Renderer 会记住用户显式选择的“关闭”或字幕语言，播放下一集时优先匹配；退出 Codex 后不保留这一偏好。
- 播放结束不会自动连播，需要用户选择重播或下一集。

非敏感连接信息保存在：

```text
~/Library/Application Support/codex-companion/emby.json
```

文件权限为 `0600`，只包含当前服务器标识、各服务器地址、ServerId、UserId、用户名和稳定 DeviceId。每个连接的 AccessToken 独立保存在 macOS Keychain，service 为 `codex-companion.emby`、account 为 `{ServerId}:{UserId}`。密码仅存在于登录请求内存中，登录成功后立即清空输入，不会落盘。退出当前服务器只删除它的 Keychain Token；Token 失效或服务器返回 401 时也只清除当前连接的 Token。

从旧版 `codex-hg` 升级时，首次读取会自动把原配置、首页缓存和 Keychain Token 迁移到 `codex-companion`；旧数据会保留，方便回退。

## 支持边界

当前版本支持 macOS、多 Emby 服务器/账号连接和视频媒体。暂不支持：

- Emby Connect 和局域网自动发现服务器；
- Live TV、音频库、DRM；
- 自签名 HTTPS；
- 无法被 FFmpeg 6.0 读取或转换的罕见容器/编码；
- 后台播放、Emby 自动连播；
- 在线字幕搜索、下载、上传、时间轴偏移和双语字幕合并；
- 通过 iframe 嵌入 Emby Web；
- 修改或关闭 Codex CSP。

短剧路线目前只支持 `hongguoduanju.com` 公开播放页提供的 MP4，以及 Renderer 原生支持的音视频编码；不支持登录态内容、DRM、账号权益或绕过站点访问控制。

## 安全边界

CDP 是高权限接口。调试端口只绑定回环地址且默认随机分配；不要改成 `0.0.0.0`，也不要暴露到局域网或公网。

Node 是唯一接触远程网络和 Emby 凭证的组件。短剧目录与详情只允许访问 `hongguoduanju.com`，媒体和图片只允许 HTTPS 且必须通过公网地址校验；MP4 每次 Range 最多读取 1MiB。Emby HLS、图片和字幕强制与 Emby origin 同源。Emby 直连只允许由同源地址发起；跨源 CDN 的每次连接都强制使用 HTTPS、校验 DNS 并固定到已验证的公网 IP，再打开不携带 Emby Token 的持续 Range；断流时从已接收偏移有限重连。FFmpeg 只访问带随机路径的 `127.0.0.1` 临时媒体桥，以及权限为 `0600` 的随机临时外挂字幕文件；两者均不会进入 Renderer，并在播放结束时删除。媒体桥再由 Node 使用认证 Header 访问 Emby。Emby Token 只发给 Emby origin，不会发给 CDN、FFmpeg 命令行、DOM、媒体 URL或日志。Renderer 不直接请求红果官网、Emby、CDN 或 localhost；媒体回包由静态 `Runtime.callFunctionOn` 参数投递，媒体数据不会进入可执行源码。`hls.js`、`mp4box`、`undici` 和 `ffmpeg-static` 均为精确锁定的本地 npm 依赖，不使用 CDN bundle。

红果与 Emby 仅共享 Codex 主题和右栏滚动，媒体状态、`video`、Blob URL、播放会话和控制接口互不复用。
