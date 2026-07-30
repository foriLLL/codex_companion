# Contributing

感谢参与 Codex Companion。提交改动前请先说明要解决的用户问题，并尽量提供可复现
场景；涉及安全边界、凭证存储、CDP 监听地址或媒体 URL 校验的改动需要额外说明风险。

## 开发环境

- macOS 13+
- Node.js 22+
- `/Applications/ChatGPT.app`
- 可选系统 FFmpeg：`brew install ffmpeg`

```bash
npm ci
npm test
npm run smoke
```

测试必须使用 `node --test`（即 `npm test`），不要使用 `bun test`。注入源码包含基于
`Function.prototype.toString()` 的断言，Bun 转译会改变函数文本。Bun 只用于构建应用。

## 代码约定

- JavaScript ESM、双引号、分号、2 空格缩进。
- 代码标识符使用英文，注释和面向用户的文档使用中文。
- 提交信息遵循 Conventional Commits，例如 `fix:`、`feat:`、`docs:`、`chore:`。
- 不提交本机配置、Token、日志、媒体地址、构建产物或生成的 HLS bundle。
- 依赖必须精确锁定并更新 `package-lock.json`；运行时不新增 CDN 依赖。

## Pull request

PR 应说明问题、根因、用户影响和验证方式。行为改动需要测试；界面改动至少运行
smoke。macOS Release 必须保持 Developer ID 签名和 Apple 公证的失败关闭策略。

安全漏洞不要提交公开 PR 或 issue，请遵循 [SECURITY.md](SECURITY.md)。

## 维护者发布

GitHub Release 只接受与 `package.json` 版本一致的 `v*` tag。仓库需要配置：

- `MACOS_CERTIFICATE_P12`、`MACOS_CERTIFICATE_PASSWORD`；
- `MACOS_SIGNING_IDENTITY`；
- `APPLE_ID`、`APPLE_TEAM_ID`、`APPLE_APP_SPECIFIC_PASSWORD`。

工作流会分别构建 arm64/x64，签名内层后端和应用、核对 Team ID、提交 Apple
公证并 staple，再生成绑定同一 Team ID 的安装器。任一凭据缺失、版本不一致、签名
或公证失败都会终止，不发布降级产物。`workflow_dispatch` 只生成内部 workflow
artifact，不创建 GitHub Release。
