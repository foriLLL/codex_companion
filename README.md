# Codex Companion

Codex Companion 是一个仅支持 macOS 的非官方桌面增强工具。它通过本机
Chrome DevTools Protocol（CDP），在 Codex Desktop（`ChatGPT.app`）的右栏中
加入红果短剧和 Emby 两张隔离的 Shadow DOM 卡片，不修改 `app.asar`、
`/Applications/ChatGPT.app` 或其应用签名。

> 当前版本：`v0.0.1`，属于早期预览。Codex Desktop 的 DOM 更新可能导致注入
> 暂时失效。最后验证环境为 ChatGPT/Codex `26.721.81911`、macOS `26.5.2`。

## 功能

- 红果短剧：公开内容浏览、搜索、选集、播放和倒计时自动连播。
- Emby：多服务器、媒体库、继续观看、最近添加、搜索、选季选集、字幕和进度上报。
- 独立卡片按钮或跟随 Summary 显示；两张卡片可分别关闭并调整顺序。
- 媒体按需流式传输并限制缓冲，不把整部视频下载成 Blob。
- Emby Token 保存在 macOS Keychain；配置文件权限为 `0600`。

Emby 卡片宽度为 300px，高度不超过 400px，并会在较矮窗口中自适应。

## 系统要求

| 场景 | 要求 |
| --- | --- |
| 使用 Release 应用 | macOS 13+；`/Applications/ChatGPT.app`；不要求 Node.js |
| 从源码运行 | Node.js 22+、npm；依赖安装会提供构建所需的 Bun |
| 本机重封装/转码 | 可选的系统 FFmpeg；Release 安装器会优先通过现有 Homebrew 自动安装 |

没有 FFmpeg 时，红果播放、Emby HLS 和兼容 MP4 直连仍可使用；只有 MKV、
HEVC、EC-3、复杂多音轨或字幕烧录等本机处理路径不可用。也可以通过
`CODEX_COMPANION_FFMPEG=/absolute/path/to/ffmpeg` 指定已有 FFmpeg。

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

播放路径按以下顺序选择：

1. 服务端允许转码时使用 H.264/AAC HLS。
2. 单路 H.264 + 至多单路 AAC 的 MP4 直接增量转换为 fMP4。
3. HEVC、EC-3、多音轨、其他容器或烧录字幕交给用户安装的 FFmpeg，输出 H.264/AAC fMP4。

因此不兼容编码不会先交给 Renderer 再失败；需要第 3 条但系统没有 FFmpeg 时，
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
4. MP4 使用有限 Range 和 MP4Box 增量生成 fMP4；HLS 与 FFmpeg 流都有背压和缓冲上限。
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
- 不支持后台播放、Emby 自动连播、在线字幕搜索或字幕时间轴偏移。
- 红果仅支持公开播放页提供的 MP4 和当前 Renderer/FFmpeg 可处理的编码。
- Codex Desktop 更新后，原生右栏定位规则可能需要同步更新。

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
