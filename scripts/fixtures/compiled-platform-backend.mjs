// 由 smoke-backend-platform 复制到临时目录并将导入根替换为源码快照。
import { createInterface } from "node:readline";
import { createEmbyRuntime } from "__SOURCE_ROOT__/src/cli.mjs";
import { CompanionConfig } from "__SOURCE_ROOT__/src/companion-config.mjs";
import { watchCompanionConfig } from "__SOURCE_ROOT__/src/platform/config/watcher.mjs";

const [portValue, configPath] = process.argv.slice(2);
if (!configPath || !portValue) throw new Error("需要 fixture CDP 端口与临时配置路径");
const counters = { socketsCreated: 0, socketsOpen: 0, bindings: 0, mounts: 0, configUpdates: 0, newDocumentScripts: 0, watchUpdates: 0, rpcSuccessResponses: 0, rpcErrorResponses: 0 };
const errors = [];
const NativeWebSocket = globalThis.WebSocket;
// 只记录真实 CDP 连接与调用，不替换任何响应或注入器行为。
globalThis.WebSocket = class TrackedWebSocket extends NativeWebSocket {
  constructor(...args) {
    super(...args);
    counters.socketsCreated += 1;
    let counted = false;
    this.addEventListener("open", () => { counted = true; counters.socketsOpen += 1; });
    this.addEventListener("close", () => { if (counted) counters.socketsOpen -= 1; counted = false; });
  }
  send(data) {
    try {
      const call = JSON.parse(data);
      if (call.method === "Runtime.addBinding") counters.bindings += 1;
      if (call.method === "Page.addScriptToEvaluateOnNewDocument") counters.newDocumentScripts += 1;
      if (call.method === "Runtime.evaluate" && call.params?.expression?.includes('"action":"mount"')) counters.mounts += 1;
      if (call.method === "Runtime.evaluate" && call.params?.expression?.startsWith('globalThis["__CODEX_COMPANION__"]?.runtime?.applyConfig(')) counters.configUpdates += 1;
      const response = call.params?.arguments?.[0]?.value;
      if (call.method === "Runtime.callFunctionOn" && response?.id?.startsWith("backend-rpc-")) {
        if (response.ok === true) counters.rpcSuccessResponses += 1;
        if (response.ok === false) counters.rpcErrorResponses += 1;
      }
    } catch {}
    return super.send(data);
  }
};
const output = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const logger = { info() {}, debug() {}, warn(message) { errors.push(String(message)); } };
const store = new CompanionConfig({ path: configPath });
const { injector, service } = await createEmbyRuntime(Number(portValue), { configStore: store, logger });
await injector.start();
const watcher = await watchCompanionConfig({
  config: store,
  onChange(next) { counters.watchUpdates += 1; injector.setConfig({ config: next }); },
  onError(error) { errors.push(`watch: ${error.message}`); },
});
output({ event: "ready", counters, config: injector.config, compiled: typeof Bun !== "undefined", serviceScopes: service.registry.scopes.size });
const input = createInterface({ input: process.stdin });
let stopped = false;
async function shutdown() {
  if (stopped) return;
  stopped = true;
  await watcher.close();
  await service.dispose();
  injector.stop();
  const until = Date.now() + 2000;
  while (counters.socketsOpen > 0 && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10));
}
try {
  for await (const line of input) {
    const command = JSON.parse(line);
    if (command.command === "stop") {
      await shutdown();
      output({ id: command.id, counters, errors, stopped: true, serviceClosed: service.registry.closed });
      break;
    }
    if (command.command !== "status") throw new Error(`未知夹具命令 ${command.command}`);
    output({ id: command.id, counters, errors, config: injector.config, serviceScopes: service.registry.scopes.size,
      scopes: [...service.registry.scopes.values()].map(scope => ({ cardId: scope.entry.id, generation: scope.generation, disposed: scope.disposed })) });
  }
} finally {
  input.close();
  await shutdown();
}
