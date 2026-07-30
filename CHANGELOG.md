# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/)。

## 0.0.1 - 2026-07-30

首个公开预览版本：

- 通过本机 CDP 向 Codex Desktop 右栏注入独立的红果短剧与 Emby 卡片；
- 支持红果公开内容浏览、搜索、选集、播放和自动连播；
- 支持 Emby 多服务器、媒体库、搜索、选季选集、字幕、续播与进度上报；
- 采用受限 HLS、Range/fMP4 与可选系统 FFmpeg 媒体路径；
- Release 安装器在已有 Homebrew 时自动补装 FFmpeg，失败时保留主程序并给出明确提示；
- 使用 Keychain 保存 Emby Token，并限制 CDP、远端资源和媒体缓存边界。
