const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const safeId = (value) => typeof value === "string" && /^[a-z][a-z0-9-]*$/.test(value)
  && !["constructor", "prototype", "__proto__"].includes(value);

// Node 注入器与浏览器共用同一配置投影；未知卡片配置保留，挂载仍由 registry 决定。
export function normalizeRuntimeConfig(value = {}, manifests = []) {
  const input = isRecord(value) ? value : {};
  const rawCards = isRecord(input.cards) ? input.cards : {};
  const defaults = new Map(manifests.map((manifest) => [manifest.id, manifest.defaultEnabled]));
  const ids = [...defaults.keys(), ...Object.keys(rawCards).filter((id) => safeId(id) && !defaults.has(id))];
  const cards = Object.fromEntries(ids.map((id) => {
    const raw = rawCards[id];
    return [id, {
      enabled: typeof raw === "boolean" ? raw : typeof raw?.enabled === "boolean" ? raw.enabled : defaults.get(id) ?? false,
      settings: isRecord(raw?.settings) ? JSON.parse(JSON.stringify(raw.settings)) : {},
    }];
  }));
  const order = [];
  const requestedOrder = input.order ?? input.cardOrder;
  if (Array.isArray(requestedOrder)) {
    for (const id of requestedOrder) if (safeId(id) && !order.includes(id)) order.push(id);
  }
  for (const id of ids) if (!order.includes(id)) order.push(id);
  return {
    enabled: input.enabled !== false,
    placement: input.placement === "inline-in-summary" ? "inline-in-summary" : "standalone-button",
    revision: Number.isSafeInteger(input.revision) ? input.revision : null,
    order,
    cards,
  };
}
