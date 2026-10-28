import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";

// 仅供隔离浏览器冒烟：官方 AppBridge 负责真实协议握手，工具经测试主页面
// 转发给 Node 里的真实 MCP client。插件 iframe 自身没有网络访问能力。
const frame = document.querySelector("iframe");
const errors = [];
const links = [];
const calls = [];
addEventListener("unhandledrejection", event => errors.push(String(event.reason?.stack || event.reason)));
const bridge = new AppBridge(null, { name: "Companion smoke host", version: "1.0.0" }, {
  serverTools: {}, openLinks: {}, logging: {}
}, { hostContext: { theme: "light", displayMode: "inline", availableDisplayModes: ["inline", "fullscreen"],
  containerDimensions: { width: innerWidth, height: innerHeight } } });
bridge.oncalltool = async (params, extra) => {
  calls.push({ name: params.name, method: params.arguments?.method });
  const response = await fetch("/tool", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(params), signal: extra.signal });
  if (!response.ok) throw new Error(`测试 MCP host HTTP ${response.status}`);
  return response.json();
};
bridge.onopenlink = async (params) => { links.push(params.url); return {}; };
bridge.onrequestdisplaymode = async ({ mode }) => { bridge.setHostContext({ displayMode: mode }); return { mode }; };
bridge.onloggingmessage = () => {};
bridge.oninitialized = () => { globalThis.fixture.initialized = true; };
await bridge.connect(new PostMessageTransport(frame.contentWindow, frame.contentWindow));
globalThis.fixture = {
  frame, bridge, errors, links, calls, initialized: false,
  document: () => frame.contentDocument,
  root: id => frame.contentDocument.querySelector(`#panel-${id} .card-content`)?.shadowRoot,
  setTheme: theme => bridge.setHostContext({ theme }),
  dimensions: () => bridge.setHostContext({ containerDimensions: { width: innerWidth, height: innerHeight } }),
  async teardown() { await bridge.teardownResource({}); await bridge.close(); }
};
frame.src = "/ui";
