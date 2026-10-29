# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/)。

## Unreleased

- 主入口改为官方 Codex 插件（MCP Apps），后端由 Codex 自动启动，不再依赖 CDP；
- 插件支持 macOS、Windows 与 Linux（arm64 / x64）：数据目录遵循各平台约定，
  Emby Token 分别存入钥匙串、DPAPI 与 Secret Service；
- 卡片平台化：统一外框、配置 v2、生命周期、存档与 RPC，新增代理状态卡片；
- Emby 播放界面重做，注入模式下兼容 MP4 经 CDP 媒体拦截原生播放；
- 通过代理重启 Codex、无感注入与 `.app` 仅在 macOS 提供；
- 新增任务看板（仅无感注入）：钉住多个 Codex 会话、实时状态与未读提醒，
  悬停弹出单会话 Trace。

## 0.0.1 - 2026-07-30

首个公开预览版本：

- 通过本机 CDP 向 Codex Desktop 右栏注入独立的红果短剧与 Emby 卡片；
- 支持红果公开内容浏览、搜索、选集、播放和自动连播；
- 支持 Emby 多服务器、媒体库、搜索、选季选集、字幕、续播与进度上报；
- 采用受限 HLS、Range/fMP4 与可选系统 FFmpeg 媒体路径；
- Release 安装器在已有 Homebrew 时自动补装 FFmpeg，失败时保留主程序并给出明确提示；
- 使用 Keychain 保存 Emby Token，并限制 CDP、远端资源和媒体缓存边界。
