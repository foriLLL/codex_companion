# Third-party notices

Codex Companion 自身以 MIT License 发布。构建产物还包含以下直接依赖；完整
许可证文本会复制到插件包的 `licenses/`；旧 `.app` 构建仍复制到其 Resources。

| 组件 | 固定版本 | 许可证 | 用途 |
| --- | --- | --- | --- |
| [hls.js](https://github.com/video-dev/hls.js) | 1.6.16 | Apache-2.0 | HLS 播放运行时 |
| [MP4Box.js](https://github.com/gpac/mp4box.js) | 2.4.1 | BSD-3-Clause | MP4/fMP4 增量解析 |
| [Undici](https://github.com/nodejs/undici) | 7.28.0 | MIT | Node HTTP 客户端 |
| MCP SDK | 1.32.1 | MIT | 官方插件后端协议 |
| MCP Apps SDK | 1.7.5 | MIT | 插件页面与宿主桥接 |
| Zod | 4.3.6 | MIT | 工具参数校验 |
| [Bun](https://github.com/oven-sh/bun) | 1.3.14 | MIT；运行时另含 Bun 上游列出的 LGPL/Apache/BSD 等组件 | 编译自包含后端 |

Bun 的完整上游许可及其静态链接组件清单保存在
`packaging/licenses/BUN-LICENSE.md`，并随 `.app` 分发。

## FFmpeg

Codex Companion **不打包或再分发 FFmpeg 二进制**。当媒体必须在本机重封装、
转码或烧录字幕时，应用只调用用户自行安装并通过 `PATH`、Homebrew/MacPorts
标准路径或 `CODEX_COMPANION_FFMPEG` 指定的 FFmpeg。该安装由用户独立获取，
适用其自身构建和分发渠道的许可证。
