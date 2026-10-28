# Security policy

## 支持范围

当前只维护 `main` 和最新 GitHub Release。早期预览版本不提供长期安全补丁支持。

## 报告漏洞

请使用 GitHub 仓库的 **Security → Report a vulnerability** 发起私密报告。若该入口
暂时不可用，请只创建不含漏洞细节和凭证的 issue，请求维护者开启私密沟通渠道。

报告建议包含：

- 受影响版本、操作系统与 Codex 版本；
- 最小复现步骤和影响；
- 已验证的攻击前提；
- 已脱敏的日志或证明材料。

不要提交 Emby Token、密码、完整服务器 URL、媒体签名地址、Cookie、个人目录路径
或未脱敏截图。维护者确认修复并完成发布前，请不要公开漏洞细节。

## 安全边界

CDP 可以控制 Codex Renderer，必须只绑定 loopback，不能暴露给其他机器。项目不会
要求关闭 TLS 校验、修改 Codex 安装包、替换 `app.asar`，也不会要求安装未经签名
和 Apple 公证的 macOS 公开 Release。

Emby Token 只保存在系统凭证库：macOS 钥匙串、Windows DPAPI（当前用户范围）或
Linux Secret Service。Linux 没有可用密钥环时回退到数据目录下权限 `0600` 的
`credentials.json`，这与 `gh`、`docker` 等 CLI 的做法一致；这种情况下凭证的保护
强度等同于用户主目录的文件权限。
