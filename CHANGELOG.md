# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/)。

## Unreleased

- 主入口为 macOS 无感注入：launchd 后台服务在安全条件下以 loopback 随机端口重开
  Codex 并注入卡片，崩溃后自动拉起并重新连接；
- 移除官方 Codex 插件（MCP Apps）链路及其 Windows / Linux 插件包；
- Linux 预览：`install.sh` 一条命令安装 x64 / ARM64 单文件后端（校验和在发布时写入脚本），
  覆盖应用菜单的 ChatGPT 入口以 loopback 随机端口启动，systemd 用户服务经 `/proc` 发现并注入；
  不自动退出或重启 ChatGPT，设置页相应隐藏自动加载与重启；
- 卡片平台化：统一外框、配置 v2、生命周期、存档与 RPC，新增代理状态卡片；
- Emby 播放界面重做，兼容 MP4 经 CDP 媒体拦截原生播放；
- 新增任务看板：钉住多个 Codex 会话、实时状态与未读提醒，悬停弹出单会话 Trace；
- Dot 会话页不显示 Companion 入口，避免遮挡原生通话按钮；回到普通会话后按原开关恢复；
- Codex 模态弹窗不再被卡片抽屉遮挡；Trace 收到新数据时保持滚动位置。
- 卡片抽屉的开合与原生 Summary 一致：直接复用 Codex 的布局判定与会话平移，留白足够时推开对话流，
  不够时浮在对话流上方，拖窄窗口越过临界点时常驻抽屉消失、拖回后重新出现。

## 0.0.1 - 2026-07-30

首个公开预览版本：

- 通过本机 CDP 向 Codex Desktop 右栏注入独立的红果短剧与 Emby 卡片；
- 支持红果公开内容浏览、搜索、选集、播放和自动连播；
- 支持 Emby 多服务器、媒体库、搜索、选季选集、字幕、续播与进度上报；
- 采用受限 HLS、Range/fMP4 与可选系统 FFmpeg 媒体路径；
- Release 安装器在已有 Homebrew 时自动补装 FFmpeg，失败时保留主程序并给出明确提示；
- 使用 Keychain 保存 Emby Token，并限制 CDP、远端资源和媒体缓存边界。
