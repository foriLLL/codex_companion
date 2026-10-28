import { randomUUID } from "node:crypto";
import { rpcError } from "../platform/services/errors.mjs";

// 预算包含 Base64 膨胀和 JSON 元数据。每个工具响应低于 256 KiB，
// 媒体只在播放器提出需求时传输；这里不缓存完整视频，也不记录资源 URL。
export const PLUGIN_MEDIA_WIRE_BYTES = 256 * 1024;
export const PLUGIN_MEDIA_CHUNK_BYTES = 180 * 1024;
export const PLUGIN_MEDIA_INLINE_BYTES = 192 * 1024;
export const PLUGIN_MEDIA_MAX_TRANSFER_BYTES = 16 * 1024 * 1024;

function ownerKey(owner) {
  if (typeof owner !== "string" || owner.length === 0 || owner.length > 512) {
    throw rpcError("INVALID_PARAMS", "缺少媒体传输的页面标识");
  }
  return owner;
}

// MCP 没有二进制流：将单个已有界限的资源/JSON 响应分块，页面拿齐后恢复
// 原 RPC 结果。转移 ID 只属于创建它的 view；关闭页面、取消请求与空闲过期
// 都释放缓存。容量不足直接施加回压，不逐出另一条正在消费的媒体传输。
export class PluginMediaTransferStore {
  constructor({
    inlineBytes = PLUGIN_MEDIA_INLINE_BYTES,
    chunkBytes = PLUGIN_MEDIA_CHUNK_BYTES,
    maxTransferBytes = PLUGIN_MEDIA_MAX_TRANSFER_BYTES,
    maxBytes = 64 * 1024 * 1024,
    maxOwnerBytes = 32 * 1024 * 1024,
    maxOwnerTransfers = 8,
    idleTimeoutMs = 60_000,
    now = Date.now,
    randomUUIDImpl = randomUUID
  } = {}) {
    for (const value of [inlineBytes, chunkBytes, maxTransferBytes, maxBytes, maxOwnerBytes, maxOwnerTransfers, idleTimeoutMs]) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError("传输预算必须是正整数");
    }
    if (inlineBytes > PLUGIN_MEDIA_INLINE_BYTES || chunkBytes > PLUGIN_MEDIA_CHUNK_BYTES) {
      throw new TypeError("传输消息超过 MCP 安全预算");
    }
    this.inlineBytes = inlineBytes;
    this.chunkBytes = chunkBytes;
    this.maxTransferBytes = maxTransferBytes;
    this.maxBytes = maxBytes;
    this.maxOwnerBytes = maxOwnerBytes;
    this.maxOwnerTransfers = maxOwnerTransfers;
    this.idleTimeoutMs = idleTimeoutMs;
    this.now = now;
    this.randomUUIDImpl = randomUUIDImpl;
    this.transfers = new Map();
    this.bytes = 0;
    this.closed = false;
    this.timer = setInterval(() => this.sweep(), Math.min(idleTimeoutMs, 15_000));
    this.timer.unref?.();
  }

  pack(value, { owner, requestId } = {}) {
    owner = ownerKey(owner);
    if (this.closed) throw rpcError("CANCELLED", "媒体传输已经关闭");
    this.sweep();
    const data = Buffer.from(JSON.stringify(value ?? null), "utf8");
    if (data.byteLength <= this.inlineBytes) return value;
    if (data.byteLength > this.maxTransferBytes) {
      throw rpcError("RESPONSE_TOO_LARGE", "单次媒体资源超过传输预算，请使用较小的媒体分片");
    }
    const owned = [...this.transfers.values()].filter((entry) => entry.owner === owner);
    const ownerBytes = owned.reduce((sum, entry) => sum + entry.data.byteLength, 0);
    if (this.bytes + data.byteLength > this.maxBytes
      || ownerBytes + data.byteLength > this.maxOwnerBytes
      || owned.length >= this.maxOwnerTransfers) {
      throw Object.assign(rpcError("MEDIA_BACKPRESSURE", "媒体读取队列已满，请稍后重试"), { retryable: true });
    }
    const id = this.randomUUIDImpl();
    if (this.transfers.has(id)) throw rpcError("INTERNAL_ERROR", "媒体传输标识重复");
    this.transfers.set(id, { owner, requestId, data, touchedAt: this.now() });
    this.bytes += data.byteLength;
    return { __companionTransfer: {
      version: 1, id, totalBytes: data.byteLength, chunkBytes: this.chunkBytes, encoding: "base64-json"
    } };
  }

  read({ transferId, offset = 0 } = {}, { owner } = {}) {
    const entry = this.#entry(transferId, owner);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= entry.data.byteLength) {
      throw rpcError("INVALID_PARAMS", "媒体分块偏移无效");
    }
    const nextOffset = Math.min(entry.data.byteLength, offset + this.chunkBytes);
    const result = {
      data: entry.data.subarray(offset, nextOffset).toString("base64"), encoding: "base64",
      offset, nextOffset, totalBytes: entry.data.byteLength, end: nextOffset === entry.data.byteLength
    };
    entry.touchedAt = this.now();
    return result;
  }

  close({ transferId } = {}, { owner } = {}) {
    owner = ownerKey(owner);
    this.sweep();
    const entry = this.transfers.get(transferId);
    if (!entry) return { closed: false };
    if (entry.owner !== owner) throw rpcError("TRANSFER_NOT_FOUND", "媒体传输不存在或已过期");
    this.#delete(transferId, entry);
    return { closed: true };
  }

  releaseOwner(owner) {
    owner = ownerKey(owner);
    for (const [id, entry] of this.transfers) if (entry.owner === owner) this.#delete(id, entry);
  }

  releaseRequest(requestId, { owner } = {}) {
    owner = ownerKey(owner);
    for (const [id, entry] of this.transfers) {
      if (entry.owner === owner && entry.requestId === requestId) this.#delete(id, entry);
    }
  }

  sweep() {
    const cutoff = this.now() - this.idleTimeoutMs;
    for (const [id, entry] of this.transfers) if (entry.touchedAt <= cutoff) this.#delete(id, entry);
  }

  dispose() {
    this.closed = true;
    clearInterval(this.timer);
    this.transfers.clear();
    this.bytes = 0;
  }

  #entry(id, owner) {
    owner = ownerKey(owner);
    this.sweep();
    const entry = this.transfers.get(id);
    if (!entry || entry.owner !== owner) throw rpcError("TRANSFER_NOT_FOUND", "媒体传输不存在或已过期");
    return entry;
  }

  #delete(id, entry) {
    this.transfers.delete(id);
    this.bytes -= entry.data.byteLength;
  }
}
