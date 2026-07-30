const REQUEST_TIMEOUT_MS = 2_000;

export async function listCdpTargets(port, { fetchImpl = fetch } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError(`无效 CDP 端口：${port}`);
  }

  const response = await fetchImpl(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`CDP target 查询失败：HTTP ${response.status}`);

  const targets = await response.json();
  if (!Array.isArray(targets)) throw new Error("CDP target 响应不是数组");
  return targets;
}

export function isCodexAppTarget(target) {
  if (target?.type !== "page" || typeof target.webSocketDebuggerUrl !== "string") return false;
  if (typeof target.url !== "string") return false;
  try {
    const url = new URL(target.url);
    return url.protocol === "app:" && url.hostname === "-";
  } catch {
    return false;
  }
}

export function filterCodexTargets(targets) {
  return targets.filter((target) => {
    if (!isCodexAppTarget(target)) return false;
    try {
      const url = new URL(target.url);
      return url.pathname === "/index.html"
        && url.searchParams.get("initialRoute") !== "/avatar-overlay";
    } catch {
      return false;
    }
  });
}

export async function waitForCodexTargets(port, { timeoutMs = 30_000, intervalMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const targets = filterCodexTargets(await listCdpTargets(port));
      if (targets.length > 0) return targets;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  const suffix = lastError ? `；最后错误：${lastError.message}` : "";
  throw new Error(`等待 Codex renderer 超时（端口 ${port}）${suffix}`);
}
