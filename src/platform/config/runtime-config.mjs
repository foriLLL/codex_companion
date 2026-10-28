const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const safeId = (value) => typeof value === "string" && /^[a-z][a-z0-9-]*$/.test(value)
  && !["constructor", "prototype", "__proto__"].includes(value);

// 缺失的内置卡按 defaultOrder 插到第一张默认更靠后的卡片之前，
// 升级后新增的卡片出现在预期位置，而不是一律补到末尾；其余未知 id 仍补末尾。
export function completeCardOrder(requested, manifests = [], extraIds = []) {
  const order = [];
  for (const id of Array.isArray(requested) ? requested : []) if (safeId(id) && !order.includes(id)) order.push(id);
  const rank = new Map(manifests.map((manifest) => [manifest.id, manifest.defaultOrder]));
  for (const { id, defaultOrder } of manifests) {
    if (order.includes(id)) continue;
    const index = order.findIndex((other) => rank.get(other) > defaultOrder);
    if (index === -1) order.push(id);
    else order.splice(index, 0, id);
  }
  for (const id of extraIds) if (safeId(id) && !order.includes(id)) order.push(id);
  return order;
}

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
  const order = completeCardOrder(input.order ?? input.cardOrder, manifests, ids);
  return {
    enabled: input.enabled !== false,
    placement: input.placement === "inline-in-summary" ? "inline-in-summary" : "standalone-button",
    revision: Number.isSafeInteger(input.revision) ? input.revision : null,
    order,
    cards,
  };
}
