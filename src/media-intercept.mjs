// Codex 主文档 CSP 的 media-src 允许任意 https:，但不允许 http://127.0.0.1；
// blob 子文档同样继承这条策略。注入链路持有页面的 CDP 会话，因此让 <video>
// 请求一个保留域名（RFC 2606 的 .invalid 永不解析），再用 Fetch 拦截在网络栈里
// 改写到本机媒体代理：Range 数据直接走 Chromium 网络栈，不经过 RPC/Base64。
//
// 安全边界：
// - 只改写到本进程登记过的 loopback 端口，且路径必须落在代理的 /hls/ 秘密路径下；
//   页面不能借此访问任意本机端口（例如 CDP 调试端口）。
// - 拦截随 CDP 会话存在；会话断开后 .invalid 请求自然解析失败，不会落到外网。
// - connect-src 不含该域名，fetch/XHR 仍被 CSP 拦截，只有媒体元素能用这条通道。
export const MEDIA_INTERCEPT_ORIGIN = "https://codex-companion.invalid";

const PATH_PATTERN = /^\/(\d{1,5})(\/hls\/[^/]+\/.+)$/;
const allowedPorts = new Map();

// 返回注销函数；同一端口多次登记按引用计数处理。
export function registerMediaInterceptPort(port) {
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
    throw new TypeError("媒体代理端口无效");
  }
  allowedPorts.set(port, (allowedPorts.get(port) ?? 0) + 1);
  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    const count = (allowedPorts.get(port) ?? 1) - 1;
    if (count > 0) allowedPorts.set(port, count);
    else allowedPorts.delete(port);
  };
}

// 本机代理 URL → 页面可用的拦截 URL；不是已登记的 loopback 代理地址时返回 null。
export function toMediaInterceptUrl(loopbackUrl) {
  let url;
  try {
    url = new URL(String(loopbackUrl ?? ""));
  } catch {
    return null;
  }
  const port = Number(url.port);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !allowedPorts.has(port)) return null;
  if (url.username || url.password || url.hash || !url.pathname.startsWith("/hls/")) return null;
  return `${MEDIA_INTERCEPT_ORIGIN}/${port}${url.pathname}${url.search}`;
}

// 拦截 URL → 本机代理 URL；任何不合规的请求返回 null（由调用方拒绝）。
export function resolveMediaInterceptUrl(value) {
  let url;
  try {
    url = new URL(String(value ?? ""));
  } catch {
    return null;
  }
  if (url.origin !== MEDIA_INTERCEPT_ORIGIN || url.username || url.password) return null;
  const rawPath = String(value).slice(MEDIA_INTERCEPT_ORIGIN.length).split(/[?#]/, 1)[0];
  const hasDotSegment = rawPath.split("/").some((segment) => {
    try {
      return [".", ".."].includes(decodeURIComponent(segment));
    } catch {
      return true;
    }
  });
  const match = PATH_PATTERN.exec(url.pathname);
  if (hasDotSegment || !match) return null;
  const port = Number(match[1]);
  if (!allowedPorts.has(port)) return null;
  return `http://127.0.0.1:${port}${match[2]}${url.search}`;
}

// 在一个页面 CDP 会话上启用媒体拦截。失败时返回 { active: false }，调用方据此
// 退回 RPC/MSE 传输，绝不影响注入本身。
export async function attachMediaIntercept(connection, { logger = console } = {}) {
  const onPaused = (params) => {
    const requestId = params?.requestId;
    if (!requestId) return;
    const target = resolveMediaInterceptUrl(params.request?.url);
    const command = target
      ? connection.send("Fetch.continueRequest", { requestId, url: target })
      : connection.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" });
    Promise.resolve(command).catch((error) => {
      logger.debug?.(`[codex-companion] 媒体拦截处理失败：${error?.message ?? error}`);
    });
  };
  const remove = connection.on("Fetch.requestPaused", onPaused);
  const unsubscribe = typeof remove === "function" ? remove : () => connection.off?.("Fetch.requestPaused", onPaused);
  try {
    await connection.send("Fetch.enable", {
      patterns: [{ urlPattern: `${MEDIA_INTERCEPT_ORIGIN}/*`, requestStage: "Request" }]
    });
  } catch (error) {
    unsubscribe();
    logger.warn?.(`[codex-companion] 媒体拦截不可用，回退 RPC 传输：${error?.message ?? error}`);
    return { active: false, detach() {} };
  }
  let attached = true;
  return {
    active: true,
    detach() {
      if (!attached) return;
      attached = false;
      unsubscribe();
      Promise.resolve(connection.send("Fetch.disable")).catch(() => {});
    }
  };
}
