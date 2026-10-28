function flagValue(args, flag) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag) {
      const next = args[index + 1];
      values.push(next && !next.startsWith("--") ? next : null);
    } else if (args[index].startsWith(`${flag}=`)) {
      values.push(args[index].slice(flag.length + 1));
    }
  }
  // 重复标志的生效顺序不明确，不能据此认领实例。
  return values.length === 1 ? values[0] : null;
}

function parsePort(value) {
  if (typeof value !== "string" || !/^\d{1,5}$/.test(value)) return null;
  const port = Number(value);
  return port >= 1 && port <= 65535 ? port : null;
}

export function parseCodexDebugArgs(args) {
  const parsed = { known: false, debugPort: null, debugAddress: null, proxyPort: null };
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) return parsed;
  const proxy = flagValue(args, "--proxy-server")?.match(/^(?:http:\/\/)?127\.0\.0\.1:(\d{1,5})$/);
  return {
    known: true,
    debugPort: parsePort(flagValue(args, "--remote-debugging-port")),
    debugAddress: flagValue(args, "--remote-debugging-address"),
    proxyPort: proxy ? parsePort(proxy[1]) : null
  };
}

export function isCompanionDebugInstance(parsed) {
  return parsed?.known === true && parsed.debugAddress === "127.0.0.1"
    && Number.isInteger(parsed.debugPort) && parsed.debugPort >= 1 && parsed.debugPort <= 65535;
}
