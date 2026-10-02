import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
const run = promisify(execFile);
// 按平台边界运行真实 Chromium 场景，不再依赖旧单体 ShadowRoot 或 FakeHls 私有全局。
for (const script of ["smoke-codex-adapter.mjs", "smoke-card-platform.mjs", "smoke-games-card.mjs", "smoke-media-modules.mjs"]) {
  const { stdout, stderr } = await run(process.execPath, [fileURLToPath(new URL(script, import.meta.url))], { maxBuffer: 4 * 1024 * 1024 });
  process.stdout.write(stdout);
  process.stderr.write(stderr);
}
