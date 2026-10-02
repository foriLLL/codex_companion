export function rpcError(code, message) {
  return Object.assign(new Error(message), { code });
}
