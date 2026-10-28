import nodeTest from "node:test";

// launchd、Codex Companion.app 与原生助手只在 macOS 上运行，模块按 POSIX 路径编写；
// 在 Windows 上整体跳过这些用例（Linux 上仍运行，用于覆盖纯逻辑）。
export const posixOnlyTest = process.platform === "win32" ? nodeTest.skip : nodeTest;
