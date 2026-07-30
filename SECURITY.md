# Security policy

## 支持范围

当前只维护 `main` 和最新 GitHub Release。早期预览版本不提供长期安全补丁支持。

## 报告漏洞

请使用 GitHub 仓库的 **Security → Report a vulnerability** 发起私密报告。若该入口
暂时不可用，请只创建不含漏洞细节和凭证的 issue，请求维护者开启私密沟通渠道。

报告建议包含：

- 受影响版本、macOS 与 Codex Desktop 版本；
- 最小复现步骤和影响；
- 已验证的攻击前提；
- 已脱敏的日志或证明材料。

不要提交 Emby Token、密码、完整服务器 URL、媒体签名地址、Cookie、个人目录路径
或未脱敏截图。维护者确认修复并完成发布前，请不要公开漏洞细节。

## 安全边界

CDP 可以控制 Codex Renderer，必须只绑定 loopback，不能暴露给其他机器。项目不会
要求关闭 TLS 校验、修改 `ChatGPT.app`、替换 `app.asar`，也不会要求安装未经签名
和 Apple 公证的公开 Release。
