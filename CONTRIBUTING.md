# Contributing

感谢参与 Codex Companion。提交改动前请先说明要解决的用户问题，并尽量提供可复现
场景；涉及安全边界、凭证存储、CDP 监听地址或媒体 URL 校验的改动需要额外说明风险。

## 开发环境

- macOS、Windows 或 Linux，Node.js 22+ 与 npm
- 可选系统 FFmpeg（`brew install ffmpeg`、`apt install ffmpeg`、`winget install ffmpeg` 等）
- 无感注入、`.app` 与原生助手的开发需要 macOS 与 `/Applications/ChatGPT.app`

```bash
npm ci
npm test
npm run build:plugin
npm run smoke:plugin:backend
npm run smoke:plugin
npm run smoke
```

测试必须使用 `node --test`（即 `npm test`），不要使用 `bun test`。注入源码包含基于
`Function.prototype.toString()` 的断言，Bun 转译会改变函数文本。Bun 只用于编译和打包。

主入口为官方插件，代码位于 `src/plugin/`；卡片渲染器和服务与旧 CDP 模式共用。
修改插件界面后运行 `build:plugin` 与 `smoke:plugin`；修改公共运行时还应验证
`smoke:platform`。`plugin:probe:host` 使用临时隔离配置，不调用模型、不重启桌面端。

### 跨平台约定

- 平台差异集中在 `src/platform/`（数据目录、凭证存储、PATH 查找）；
  新代码不要直接写死 `~/Library`、`/usr/bin/...` 或 `/` 路径分隔符。
- 需要平台分支的函数接受 `platform` 参数（默认 `process.platform`），测试显式传入，
  保证在任意宿主上都能覆盖 macOS / Windows / Linux 规则。
- 只在 macOS 上有意义的功能（launchd、钥匙串、通过代理重启 Codex）在其它平台
  返回明确的「不支持」状态，而不是抛出 `ENOENT`。
- 断言文件权限请使用 `test/helpers/permissions.mjs` 中的 `assertMode`（Windows 没有
  POSIX 权限位）。
- CI 在 Ubuntu、Windows 与 macOS 上运行全部测试，并为六个目标构建插件、按
  `.mcp.json` 启动后端冒烟。

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

GitHub Release 只接受与 `package.json` 版本一致的 `v*` tag；`package.json` 与
`plugin/.codex-plugin/plugin.json` 的版本必须一致（有测试校验）。仓库需要配置：

- `MACOS_CERTIFICATE_P12`、`MACOS_CERTIFICATE_PASSWORD`；
- `MACOS_SIGNING_IDENTITY`；
- `APPLE_ID`、`APPLE_TEAM_ID`、`APPLE_APP_SPECIFIC_PASSWORD`。

工作流会：

- 分别构建 arm64/x64 的 `Codex Companion.app`，签名内层后端和应用、核对 Team ID、
  提交 Apple 公证并 staple，再生成绑定同一 Team ID 的安装器；
- 在各平台原生 runner 上构建六个目标的插件包并冒烟；macOS 插件后端同样经过
  Developer ID 签名与公证，Linux 为 `.tar.gz`，Windows 为 `.zip`。

任一凭据缺失、版本不一致、签名或公证失败都会终止，不发布降级产物。
`workflow_dispatch` 只生成内部 workflow artifact，不创建 GitHub Release。
