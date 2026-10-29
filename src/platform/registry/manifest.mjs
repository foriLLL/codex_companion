/**
 * 卡片 manifest 校验。纯数据，不读文件系统，可在浏览器与 Node 中共用。
 *
 * 允许字段且仅允许这些字段：
 * id, title, version, defaultEnabled, defaultOrder, layout, lifecycle, state, capabilities。
 * capabilities 只能是不重复的 storage / rpc / threads（threads：读取与标记宿主左侧会话列表，仅注入模式提供）。
 */

export const MANIFEST_FIELDS = Object.freeze([
  "id",
  "title",
  "version",
  "defaultEnabled",
  "defaultOrder",
  "layout",
  "lifecycle",
  "state",
  "capabilities"
]);

export const LAYOUT_FIELDS = Object.freeze(["height", "minHeight", "scroll"]);
export const LAYOUT_HEIGHTS = Object.freeze(["content", "viewport"]);
export const LAYOUT_SCROLLS = Object.freeze(["inner", "outer"]);

export const LIFECYCLE_FIELDS = Object.freeze(["hidden", "start"]);
export const LIFECYCLE_HIDDEN = Object.freeze(["retain", "suspend"]);
export const LIFECYCLE_STARTS = Object.freeze(["immediate", "first-visible"]);

export const STATE_FIELDS = Object.freeze(["scope", "version"]);
export const STATE_SCOPES = Object.freeze(["global", "target", "session"]);

export const CAPABILITIES = Object.freeze(["storage", "rpc", "threads"]);

const ID_PATTERN = /^[a-z][a-z0-9-]*$/;

export class ManifestValidationError extends Error {
  constructor(message, { code, field } = {}) {
    super(message);
    this.name = "ManifestValidationError";
    this.code = code;
    this.field = field;
  }
}

function fail(code, field, message) {
  throw new ManifestValidationError(message, { code, field });
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactFields(value, allowed, fieldPrefix) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      const field = fieldPrefix ? `${fieldPrefix}.${key}` : key;
      fail("UNKNOWN_FIELD", field, `未知字段 "${field}"`);
    }
  }
  for (const key of allowed) {
    if (!Object.hasOwn(value, key)) {
      const field = fieldPrefix ? `${fieldPrefix}.${key}` : key;
      fail("MISSING_FIELD", field, `缺少字段 "${field}"`);
    }
  }
}

function assertEnum(value, allowed, field) {
  if (!allowed.includes(value)) {
    fail("INVALID_VALUE", field, `${field} 必须是 ${allowed.join(" / ")}，实际为 ${JSON.stringify(value)}`);
  }
}

/**
 * 校验单份 manifest，返回冻结的纯数据副本。
 * @param {unknown} input
 */
export function validateManifest(input) {
  if (!isPlainObject(input)) {
    fail("INVALID_TYPE", "", "manifest 必须是对象");
  }
  assertExactFields(input, MANIFEST_FIELDS, "");

  if (typeof input.id !== "string" || !ID_PATTERN.test(input.id)) {
    fail("INVALID_VALUE", "id", `id 必须匹配 ${ID_PATTERN}，实际为 ${JSON.stringify(input.id)}`);
  }
  if (input.id === "companion") {
    fail("RESERVED_ID", "id", "companion 为平台保留 id，不能注册为卡片");
  }
  if (typeof input.title !== "string" || input.title.length === 0) {
    fail("INVALID_VALUE", "title", "title 必须是非空字符串");
  }
  if (!Number.isInteger(input.version) || input.version < 1) {
    fail("INVALID_VALUE", "version", `version 必须是正整数，实际为 ${JSON.stringify(input.version)}`);
  }
  if (typeof input.defaultEnabled !== "boolean") {
    fail("INVALID_TYPE", "defaultEnabled", "defaultEnabled 必须是布尔值");
  }
  if (!Number.isInteger(input.defaultOrder)) {
    fail("INVALID_VALUE", "defaultOrder", `defaultOrder 必须是整数，实际为 ${JSON.stringify(input.defaultOrder)}`);
  }

  if (!isPlainObject(input.layout)) {
    fail("INVALID_TYPE", "layout", "layout 必须是对象");
  }
  assertExactFields(input.layout, LAYOUT_FIELDS, "layout");
  assertEnum(input.layout.height, LAYOUT_HEIGHTS, "layout.height");
  if (typeof input.layout.minHeight !== "number" || !Number.isFinite(input.layout.minHeight) || input.layout.minHeight < 0) {
    fail("INVALID_VALUE", "layout.minHeight", `layout.minHeight 必须是大于等于 0 的有限数字，实际为 ${JSON.stringify(input.layout.minHeight)}`);
  }
  assertEnum(input.layout.scroll, LAYOUT_SCROLLS, "layout.scroll");

  if (!isPlainObject(input.lifecycle)) {
    fail("INVALID_TYPE", "lifecycle", "lifecycle 必须是对象");
  }
  assertExactFields(input.lifecycle, LIFECYCLE_FIELDS, "lifecycle");
  assertEnum(input.lifecycle.hidden, LIFECYCLE_HIDDEN, "lifecycle.hidden");
  assertEnum(input.lifecycle.start, LIFECYCLE_STARTS, "lifecycle.start");

  if (!isPlainObject(input.state)) {
    fail("INVALID_TYPE", "state", "state 必须是对象");
  }
  assertExactFields(input.state, STATE_FIELDS, "state");
  assertEnum(input.state.scope, STATE_SCOPES, "state.scope");
  if (!Number.isInteger(input.state.version) || input.state.version < 1) {
    fail("INVALID_VALUE", "state.version", `state.version 必须是正整数，实际为 ${JSON.stringify(input.state.version)}`);
  }

  if (!Array.isArray(input.capabilities)) {
    fail("INVALID_TYPE", "capabilities", "capabilities 必须是数组");
  }
  const seen = new Set();
  input.capabilities.forEach((capability, index) => {
    const field = `capabilities[${index}]`;
    if (!CAPABILITIES.includes(capability)) {
      fail("INVALID_VALUE", field, `${field} 必须是 ${CAPABILITIES.join(" / ")}，实际为 ${JSON.stringify(capability)}`);
    }
    if (seen.has(capability)) {
      fail("DUPLICATE_CAPABILITY", field, `capabilities 含重复值 "${capability}"`);
    }
    seen.add(capability);
  });

  return Object.freeze({
    id: input.id,
    title: input.title,
    version: input.version,
    defaultEnabled: input.defaultEnabled,
    defaultOrder: input.defaultOrder,
    layout: Object.freeze({
      height: input.layout.height,
      minHeight: input.layout.minHeight,
      scroll: input.layout.scroll
    }),
    lifecycle: Object.freeze({
      hidden: input.lifecycle.hidden,
      start: input.lifecycle.start
    }),
    state: Object.freeze({
      scope: input.state.scope,
      version: input.state.version
    }),
    capabilities: Object.freeze([...input.capabilities])
  });
}

/** defaultOrder 升序，相同则按 id 的 en 字典序。 */
export function compareManifests(left, right) {
  if (left.defaultOrder !== right.defaultOrder) return left.defaultOrder - right.defaultOrder;
  return left.id.localeCompare(right.id, "en");
}

/**
 * 校验一组 manifest：逐个校验、拒绝重复 id，并按稳定顺序返回冻结数组。
 * @param {unknown} inputs
 */
export function validateCatalog(inputs) {
  if (!Array.isArray(inputs)) {
    fail("INVALID_TYPE", "", "catalog 必须是数组");
  }
  const manifests = inputs.map((input) => validateManifest(input));
  const seen = new Map();
  for (const manifest of manifests) {
    if (seen.has(manifest.id)) {
      fail("DUPLICATE_ID", "id", `重复的卡片 id "${manifest.id}"`);
    }
    seen.set(manifest.id, manifest);
  }
  return Object.freeze([...manifests].sort(compareManifests));
}
