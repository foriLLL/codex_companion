import test from "node:test";
import assert from "node:assert/strict";
import { appendFile, chmod, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { AGENT_LOG_MAX_BYTES, createAgentFileLogger } from "../src/agent/logger.mjs";
import { parseArgs, runCli } from "../src/cli.mjs";
import { defaultAgentLockPath } from "../src/agent/main.mjs";
import { clock, configStore, deferred, fakeLockSpawn, logger, nativeBridge, ours, snapshot, stateStore, temporary } from "./helpers/agent.mjs";
import { assertMode } from "./helpers/permissions.mjs";

// runAgent 是 macOS launchd 后台服务的入口（单实例锁依赖 POSIX 文件语义），Windows 上不运行。
const agentOnly = { skip: process.platform === "win32" && "agent 仅适用于 macOS" };

const timestamp = "2026-10-28T00:00:00.000Z";
const now = () => Date.parse(timestamp);

test("--log-dir 只用于常驻 agent，校验路径并接受含空格的 ~/ 路径", () => {
  assert.equal(parseArgs(["agent", "--log-dir", "~/Library/Logs/Companion Test"]).logDir, "~/Library/Logs/Companion Test");
  for (const args of [["agent", "--log-dir"], ["agent", "--log-dir", ""], ["agent", "--log-dir", "--help"]]) {
    assert.throws(() => parseArgs(args), /必须提供路径/);
  }
  for (const command of [["launch"], ["agent", "install"], ["agent", "status"]]) {
    assert.throws(() => parseArgs([...command, "--log-dir", "/tmp/logs"]), /只能用于 agent 常驻命令/);
  }
});

test("文件日志展开 home，修正既有权限，追加三种级别，每一物理行都有 ISO 时间戳", async t => {
  const home = await temporary(t);
  const directory = join(home, "Library/Logs/Companion Test");
  const path = join(directory, "agent.log");
  await mkdir(directory, { recursive: true });
  await chmod(directory, 0o755);
  await writeFile(path, "previous\n");
  await chmod(path, 0o644);
  const output = await createAgentFileLogger({ logDir: "~/Library/Logs/Companion Test", home, now });
  output.info("port=%d", 51234);
  output.warn("首行\r\n次行\n末行");
  output.error(new Error("fake failure"));
  await output.close();
  assertMode(await stat(directory), 0o700);
  assertMode(await stat(path), 0o600);
  const contents = await readFile(path, "utf8");
  assert.ok(contents.startsWith(`previous\n${timestamp} [INFO] port=51234\n`));
  assert.ok(contents.includes(`${timestamp} [WARN] 首行\n${timestamp} [WARN] 次行\n${timestamp} [WARN] 末行\n`));
  assert.ok(contents.includes(`${timestamp} [ERROR] Error: fake failure\n`));
  for (const line of contents.trimEnd().split("\n").slice(1)) assert.match(line, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[(INFO|WARN|ERROR)\] /);
  await output.info("closed");
  assert.equal(await readFile(path, "utf8"), contents);
});

test("日志按调用顺序串行写入，close 等待所有尚未 await 的追加完成", async t => {
  const home = await temporary(t);
  let time = 0;
  const output = await createAgentFileLogger({ logDir: join(home, "logs"), now: () => time++ });
  for (let index = 0; index < 40; index += 1) output.info("entry %d", index);
  await output.close();
  const lines = (await readFile(join(home, "logs/agent.log"), "utf8")).trimEnd().split("\n");
  assert.equal(lines.length, 40);
  assert.deepEqual(lines, Array.from({ length: 40 }, (_, index) => `${new Date(index).toISOString()} [INFO] entry ${index}`));
});

test("日志超过 5 MiB 才轮转，轮转覆盖唯一 .1 备份并保持 0600", async t => {
  const home = await temporary(t);
  const path = join(home, "agent.log");
  const line = `${timestamp} [INFO] 一条\n`;
  await writeFile(path, Buffer.alloc(AGENT_LOG_MAX_BYTES - Buffer.byteLength(line), "a"));
  const output = await createAgentFileLogger({ logDir: home, now });
  await output.info("一条");
  assert.equal((await stat(path)).size, AGENT_LOG_MAX_BYTES);
  await assert.rejects(stat(`${path}.1`), { code: "ENOENT" });
  await output.warn("轮转");
  assert.equal((await stat(`${path}.1`)).size, AGENT_LOG_MAX_BYTES);
  assert.equal(await readFile(path, "utf8"), `${timestamp} [WARN] 轮转\n`);
  await appendFile(path, Buffer.alloc(AGENT_LOG_MAX_BYTES - (await stat(path)).size, "b"));
  await output.error("再次轮转");
  await output.close();
  assert.ok((await readFile(`${path}.1`, "utf8")).startsWith(`${timestamp} [WARN] 轮转\n`));
  assert.equal(await readFile(path, "utf8"), `${timestamp} [ERROR] 再次轮转\n`);
  assert.deepEqual((await readdir(home)).sort(), ["agent.log", "agent.log.1"]);
  for (const file of [path, `${path}.1`]) assertMode(await stat(file), 0o600);
});

test("启动即轮转既有超大日志，超大单条日志也保留完整内容且活动文件清空", async t => {
  const home = await temporary(t);
  const path = join(home, "agent.log");
  await writeFile(path, Buffer.alloc(AGENT_LOG_MAX_BYTES + 1, "a"));
  await writeFile(`${path}.1`, "old backup");
  const output = await createAgentFileLogger({ logDir: home, now });
  assert.equal((await stat(path)).size, 0);
  assert.equal((await stat(`${path}.1`)).size, AGENT_LOG_MAX_BYTES + 1);
  const message = "x".repeat(AGENT_LOG_MAX_BYTES + 1);
  await output.info(message);
  await output.close();
  assert.equal((await stat(path)).size, 0);
  assert.equal(await readFile(`${path}.1`, "utf8"), `${timestamp} [INFO] ${message}\n`);
  assert.deepEqual((await readdir(home)).sort(), ["agent.log", "agent.log.1"]);
});

test("写日志失败不会产生异步拒绝，后续可继续写入", async t => {
  const home = await temporary(t);
  const path = join(home, "agent.log");
  const errors = [];
  const output = await createAgentFileLogger({ logDir: home, now, fallbackLogger: { error: message => errors.push(message) } });
  await rm(path);
  await mkdir(path);
  await output.warn("cannot write");
  assert.equal(errors.length, 1);
  await rm(path, { recursive: true });
  output.info("recovered");
  await output.close();
  assert.equal(await readFile(path, "utf8"), `${timestamp} [INFO] recovered\n`);
});

async function agentOptions(t) {
  const home = await temporary(t);
  const processRef = new EventEmitter();
  processRef.pid = 700;
  const timer = clock();
  return { home, processRef, helperPath: "/fake/native", nativeBridge: nativeBridge(snapshot([ours()])),
    configStore: configStore(), runtimeState: stateStore(), logger, isAlive: () => false,
    lockSpawnImpl: fakeLockSpawn(), now: timer.now, setTimeoutImpl: timer.setTimeoutImpl, clearTimeoutImpl: timer.clearTimeoutImpl,
    waitForTargets: async () => [], notifyImpl: async () => {}, watchConfig: async () => ({ close: async () => {} }) };
}

test("CLI --log-dir 将运行时/session logger 写入文件，SIGTERM 排空日志队列", agentOnly, async t => {
  const options = await agentOptions(t);
  const ready = deferred();
  const agent = await runCli(["agent", "--log-dir", "~/logs"], { ...options,
    sessionFactory: ({ logger: fileLogger }) => ({
      async start() { fileLogger.info("session ready"); fileLogger.warn("session warning"); fileLogger.error("session error"); ready.resolve(); },
      async stop() { fileLogger.info("session stopped"); }, async applyConfig() {}
    })
  });
  t.after(() => agent.stop());
  await ready.promise;
  options.nativeBridge.watches[0].onExit(new Error("watch failed"));
  options.processRef.emit("SIGTERM");
  await agent.stop();
  const contents = await readFile(join(options.home, "logs/agent.log"), "utf8");
  for (const message of ["session ready", "session warning", "session error", "watch failed", "session stopped"]) assert.ok(contents.includes(message));
  assert.equal(options.processRef.exitCode, 0);
  assert.equal(await readFile(defaultAgentLockPath(options.home), "utf8"), "");
});

test("没有 --log-dir 时沿用传入的 console logger，不创建日志目录", agentOnly, async t => {
  const options = await agentOptions(t);
  const ready = deferred();
  const agent = await runCli(["agent"], { ...options,
    sessionFactory: ({ logger: received }) => ({ async start() { ready.resolve(received); }, async stop() {}, async applyConfig() {} })
  });
  t.after(() => agent.stop());
  assert.equal(await ready.promise, options.logger);
  await agent.stop();
  await assert.rejects(stat(join(options.home, "logs")), { code: "ENOENT" });
});

test("agent 启动失败先写入并排空文件日志，再释放锁", agentOnly, async t => {
  const options = await agentOptions(t);
  await assert.rejects(runCli(["agent", "--log-dir", "~/logs"], { ...options,
    configStore: { loadV2: async () => { throw new Error("bad config"); } }
  }), /bad config/);
  assert.match(await readFile(join(options.home, "logs/agent.log"), "utf8"), /\[ERROR\].*agent 启动失败：bad config/);
  assert.equal(await readFile(defaultAgentLockPath(options.home), "utf8"), "");
});
