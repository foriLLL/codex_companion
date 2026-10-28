import net from "node:net";
import { detectCodexProxy } from "../../launcher.mjs";

const PROBE_TIMEOUT_MS = 1500;

// 只探测 loopback 端口能否建立 TCP 连接，不发送任何数据，也不经代理访问外网。
export function probeLoopbackPort(port, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const finish = (reachable) => {
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

export function createService({ inspectCodexProxy = () => detectCodexProxy(), probePortImpl = probeLoopbackPort } = {}) {
  return {
    methods: {
      async status(_params, context) {
        const { running, proxyPort, supported = true } = await inspectCodexProxy();
        if (context.signal?.aborted) throw context.signal.reason;
        if (!supported) return { supported: false, running: null, proxyPort: null, reachable: null };
        if (proxyPort === null) return { running, proxyPort: null, reachable: null };
        const reachable = await probePortImpl(proxyPort);
        if (context.signal?.aborted) throw context.signal.reason;
        return { running, proxyPort, reachable };
      }
    }
  };
}
