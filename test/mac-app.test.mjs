import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { posixOnlyTest as test } from "./helpers/platform.mjs";
import { getAgentStatus } from "../src/agent/main.mjs";
import { parseArgs, signAppAdHoc, TARGETS } from "../scripts/build-app.mjs";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));

test("App 构建默认本机架构，保留两种显式 target 并拒绝错误参数", () => {
  for (const arch of ["arm64", "x64"]) {
    assert.equal(parseArgs([], arch).target, `darwin-${arch}`);
    assert.equal(parseArgs(["--target", `darwin-${arch}`, "--out", "custom"], "arm64").outDir, "custom");
  }
  assert.equal(TARGETS["darwin-x64"].swift, "x86_64-apple-macos13");
  assert.throws(() => parseArgs(["--target", "linux-x64"]), /不支持/);
  assert.throws(() => parseArgs(["--out"]), /必须提供值/);
  assert.throws(() => parseArgs(["--target", "--out"]), /必须提供值/);
});

test("ad-hoc 签名先内部后外层，内部签名失败即停止", async () => {
  const app = "/fixture/Codex Companion.app";
  const calls = [];
  await signAppAdHoc(app, async (command, args) => calls.push({ command, args }));
  assert.deepEqual(calls, [
    `${app}/Contents/Helpers/companion-native`, `${app}/Contents/Resources/codex-companion`, app
  ].map(path => ({ command: "codesign", args: ["--force", "--sign", "-", path] })));
  const failure = new Error("模拟签名失败");
  let attempts = 0;
  await assert.rejects(signAppAdHoc(app, async () => { attempts++; throw failure; }), error => error === failure);
  assert.equal(attempts, 1);
});

test("App LaunchAgent 声明可由 plutil 解析，日志交给 agent 且助手使用相对路径发现", { skip: process.platform !== "darwin" }, async () => {
  const path = join(root, "packaging/mac-app/LaunchAgents/com.codexcompanion.agent.plist");
  const { stdout } = await exec("/usr/bin/plutil", ["-convert", "json", "-o", "-", path]);
  assert.deepEqual(JSON.parse(stdout), {
    Label: "com.codexcompanion.agent",
    BundleProgram: "Contents/Resources/codex-companion",
    ProgramArguments: ["codex-companion", "agent", "--log-dir", "~/Library/Logs/codex-companion"],
    RunAtLoad: true,
    KeepAlive: { SuccessfulExit: false },
    ThrottleInterval: 10,
    ProcessType: "Interactive",
    EnvironmentVariables: { PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" }
  });
});

test("Swift 状态解码、路径选择与注册生命周期使用假依赖验证", { skip: process.platform !== "darwin", timeout: 120_000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), "companion-app-test-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const plain = { pid: 42, key: "42:1000", arguments: [] };
  const ours = { ...plain, arguments: ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=51234", "--proxy-server=http://127.0.0.1:7890"] };
  const status = overrides => getAgentStatus({ available: true, pid: 24, config: { agent: { autoRelaunch: true } }, nativeHelper: "ok", ...overrides });
  const fixtures = [
    status({ available: false, snapshot: { apps: [] } }),
    status({ snapshot: { apps: [ours] }, attachment: { key: ours.key, port: 51234 }, lastEvent: { event: "attached", at: 1234 } }),
    status({ snapshot: { apps: [plain] } }),
    status({ snapshot: { apps: [ours] } }),
    status({ snapshot: { apps: [{ ...plain, arguments: ["--remote-debugging-port=43210"] }] } }),
    status({ snapshot: { apps: [plain] }, nativeHelper: "missing" }),
    status({ available: false, snapshot: { apps: [plain] } })
  ];
  const fixturePath = join(temporary, "status.json");
  await writeFile(fixturePath, JSON.stringify(fixtures));
  const executable = join(temporary, "agent-settings-tests");
  const { stdout: sdk } = await exec("xcrun", ["--sdk", "macosx", "--show-sdk-path"]);
  await exec("swiftc", ["-parse-as-library", "-D", "COMPANION_TESTING", "-target", TARGETS[`darwin-${process.arch}`].swift,
    "-sdk", sdk.trim(), join(root, "packaging/mac-app/Sources/CodexCompanionApp.swift"),
    join(root, "packaging/mac-app/Tests/AgentSettingsTests.swift"), "-o", executable], { timeout: 90_000 });
  const { stdout } = await exec(executable, [fixturePath], { timeout: 10_000 });
  assert.match(stdout, /Swift agent checks: \d+ passed/);
  t.diagnostic(stdout.trim());
});

test("Release 原生助手签名使用 hardened runtime 且先于外层签名", async () => {
  const workflow = await readFile(join(root, ".github/workflows/release.yml"), "utf8");
  const helper = workflow.indexOf('"$APP/Contents/Helpers/companion-native"');
  const outer = workflow.indexOf('codesign --force --options runtime --timestamp --sign "$MACOS_SIGNING_IDENTITY" "$APP"');
  assert.ok(helper >= 0 && helper < outer);
  assert.match(workflow.slice(0, helper), /codesign --force --options runtime --timestamp --sign "\$MACOS_SIGNING_IDENTITY" \\\n\s*$/);
  assert.match(workflow, /缺少 release secret: \$name；拒绝发布未签名或未公证的应用。/);
});
