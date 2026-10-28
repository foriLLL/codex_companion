import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  PluginMediaTransferStore,
  PLUGIN_MEDIA_WIRE_BYTES
} from "../src/plugin/media-transfer.mjs";
import { FfmpegFmp4Session } from "../src/ffmpeg-fmp4-session.mjs";

test("MCP 媒体大响应逐块恢复，Base64 与 metadata 都计入消息预算", (t) => {
  const store = new PluginMediaTransferStore();
  t.after(() => store.dispose());
  const expected = { data: Buffer.alloc(2 * 1024 * 1024, 0x81).toString("base64"), encoding: "base64", title: "字幕与剧集 🎞" };
  const descriptor = store.pack(expected, { owner: "view-a", requestId: "request-a" }).__companionTransfer;
  assert.ok(descriptor);
  const chunks = [];
  let offset = 0;
  while (offset < descriptor.totalBytes) {
    const result = store.read({ transferId: descriptor.id, offset }, { owner: "view-a" });
    assert.ok(Buffer.byteLength(JSON.stringify({ id: "request-a", ok: true, result })) < PLUGIN_MEDIA_WIRE_BYTES);
    const chunk = Buffer.from(result.data, "base64");
    assert.equal(result.nextOffset - result.offset, chunk.length);
    assert.equal(result.end, result.nextOffset === descriptor.totalBytes);
    chunks.push(chunk);
    offset = result.nextOffset;
  }
  assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString("utf8")), expected);
  assert.equal(store.close({ transferId: descriptor.id }, { owner: "view-a" }).closed, true);
  assert.equal(store.bytes, 0);
  assert.equal(store.close({ transferId: descriptor.id }, { owner: "view-a" }).closed, false);
});

test("MCP 媒体传输绑定页面，支持取消、过期和容量回压", (t) => {
  let now = 0;
  const store = new PluginMediaTransferStore({ inlineBytes: 8, chunkBytes: 12, maxTransferBytes: 256, maxOwnerBytes: 96, maxBytes: 128, idleTimeoutMs: 100, now: () => now });
  t.after(() => store.dispose());
  const owner = { owner: "view-a", requestId: "request-a" };
  const id = store.pack({ data: "a".repeat(50) }, owner).__companionTransfer.id;
  assert.throws(() => store.read({ transferId: id }, { owner: "view-b" }), { code: "TRANSFER_NOT_FOUND" });
  assert.throws(() => store.close({ transferId: id }, { owner: "view-b" }), { code: "TRANSFER_NOT_FOUND" });
  assert.throws(() => store.read({ transferId: id, offset: -1 }, owner), { code: "INVALID_PARAMS" });
  assert.throws(() => store.pack({ data: "a".repeat(50) }, owner), { code: "MEDIA_BACKPRESSURE", retryable: true });
  now = 99;
  store.read({ transferId: id }, owner);
  now = 101;
  assert.ok(store.read({ transferId: id }, owner));
  store.releaseRequest("request-a", owner);
  assert.equal(store.bytes, 0);
  const expired = store.pack({ data: "b".repeat(50) }, owner).__companionTransfer.id;
  now = 202;
  assert.throws(() => store.read({ transferId: expired }, owner), { code: "TRANSFER_NOT_FOUND" });
  assert.equal(store.bytes, 0);
  store.pack({ data: "c".repeat(50) }, owner);
  store.releaseOwner("view-a");
  assert.equal(store.transfers.size, 0);
  assert.throws(() => store.pack({ data: "x".repeat(257) }, owner), { code: "RESPONSE_TOO_LARGE" });
});

function box(type, bytes = Buffer.alloc(0)) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + bytes.length);
  header.write(type, 4, "ascii");
  return Buffer.concat([header, bytes]);
}

test("FFmpeg 大 fragment 经小批次传输字节不变，seek 清除半片偏移", async (t) => {
  const segment = Buffer.concat([box("moof"), box("mdat", Buffer.alloc(1000, 0x72))]);
  const childFactory = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = (signal) => {
      child.signalCode = signal;
      queueMicrotask(() => child.emit("exit", null, signal));
      return true;
    };
    queueMicrotask(() => {
      child.stdout.write(Buffer.concat([box("ftyp"), box("moov"), segment]));
    });
    return child;
  };
  const session = new FfmpegFmp4Session({
    readRange: async () => ({ bytes: Buffer.from([1]), start: 0, end: 0, total: 1 }),
    mediaSource: { MediaStreams: [{ Type: "Video", Codec: "h264" }] },
    ffmpegPathImpl: "/mock/ffmpeg", spawnImpl: childFactory,
    maxBatchBytes: 256, maxQueueBytes: 512, resumeQueueBytes: 128, platform: "linux"
  });
  t.after(() => session.destroy());
  await session.initialize();
  const chunks = [];
  while (session.queueBytes > 0) {
    const result = await session.next();
    assert.equal(result.segments.length, 1);
    const part = result.segments[0];
    assert.equal(part.segmentStart, chunks.length === 0);
    assert.equal(part.segmentEnd, session.queueBytes === 0);
    const bytes = Buffer.from(part.data, "base64");
    assert.ok(bytes.length <= 256);
    chunks.push(bytes);
  }
  assert.deepEqual(Buffer.concat(chunks), segment);
  await session.seek(10);
  await session.next();
  assert.ok(session.segmentOffset > 0);
  await session.seek(20);
  const fresh = await session.next();
  assert.equal(fresh.segments[0].segmentStart, true);
  assert.deepEqual(Buffer.from(fresh.segments[0].data, "base64"), segment.subarray(0, 256));
});
