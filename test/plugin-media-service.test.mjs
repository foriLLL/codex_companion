import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createPluginMediaFixture } from "./fixtures/plugin-media.mjs";
import { PLUGIN_MEDIA_WIRE_BYTES } from "../src/plugin/media-transfer.mjs";
import { CompanionPluginBackend } from "../src/plugin/backend.mjs";
import { createCompanionMcpServer } from "../src/plugin/server.mjs";
import { createPluginTransport } from "../src/plugin/transport.mjs";
import { CodexCompanionService } from "../src/codex-companion-service.mjs";

test("真实 MCP client 和插件 UI adapter 经后端鉴权 HTTP 播放 MP4/MKV/HLS、seek 与字幕", async (t) => {
  const fixture = await createPluginMediaFixture();
  if (!fixture) return t.skip("未安装系统 FFmpeg，无法生成真实媒体 fixture");
  const configStore = { path: "/unused-fixture/config.json", loadV2: async () => ({ version: 2, revision: 1, enabled: true,
    cards: { emby: { enabled: true }, hongguo: { enabled: false }, games: { enabled: false }, proxy: { enabled: false } } }) };
  const logger = { warn() {}, info() {}, error() {} };
  const service = new CodexCompanionService({ configStore, embyService: fixture.service, logger });
  const backend = new CompanionPluginBackend({ configStore, service, logger });
  const { server } = createCompanionMcpServer({ backend, readUi: async () => "<!doctype html><html></html>" });
  const client = new Client({ name: "plugin-media-test", version: "1.0.0" });
  const [clientWire, serverWire] = InMemoryTransport.createLinkedPair();
  await backend.start({ watchConfig: false });
  await server.connect(serverWire);
  await client.connect(clientWire);
  let chunksRead = 0;
  const transport = createPluginTransport({ callServerTool: async (request, options) => {
    const response = await client.callTool(request, undefined, options);
    assert.ok(Buffer.byteLength(JSON.stringify(response)) < PLUGIN_MEDIA_WIRE_BYTES, "完整 MCP 响应（含 structuredContent）应低于预算");
    if (request.arguments?.method === "transfer.read") chunksRead += 1;
    return response;
  } });
  t.after(async () => {
    await transport.dispose();
    await client.close();
    await server.close();
    await backend.dispose();
    await fixture.close();
  });
  const rpc = transport.rpcClient.scoped("emby", 1, AbortSignal.timeout(20_000));
  const direct = await rpc("playback.open", { itemId: "direct" });
  assert.equal(direct.streamMode, "direct-mp4");
  assert.equal("directProxyUrl" in direct, false);
  const initialization = await rpc("playback.direct.init", { playbackId: direct.playbackId });
  assert.equal(initialization.tracks.length, 1);
  assert.ok(Buffer.from(initialization.tracks[0].initData, "base64").includes(Buffer.from("moov")));
  let mediaBytes = 0;
  let end = false;
  for (let index = 0; index < 100 && !end; index += 1) {
    const result = await rpc("playback.direct.next", { playbackId: direct.playbackId });
    const bytes = result.segments.reduce((sum, item) => sum + Buffer.from(item.data, "base64").length, 0);
    assert.ok(bytes <= 128 * 1024);
    mediaBytes += bytes;
    end = result.end;
  }
  assert.ok(end, "MP4 应自然结束，不能无限拉取");
  assert.ok(mediaBytes > 128 * 1024);
  assert.ok((await rpc("playback.direct.seek", { playbackId: direct.playbackId, timeSeconds: 2 })).timeSeconds >= 0);
  assert.ok((await rpc("playback.direct.next", { playbackId: direct.playbackId })).segments.length > 0);
  const subtitles = await rpc("playback.subtitle.load", { playbackId: direct.playbackId, subtitleStreamIndex: 2 });
  assert.match(subtitles.data, /WEBVTT/);
  await rpc("playback.stop", { playbackId: direct.playbackId });

  const ffmpeg = await rpc("playback.open", { itemId: "ffmpeg" });
  assert.equal(ffmpeg.streamMode, "ffmpeg-fmp4");
  const remuxed = await rpc("playback.direct.init", { playbackId: ffmpeg.playbackId });
  assert.ok(Buffer.from(remuxed.tracks[0].initData, "base64").includes(Buffer.from("moov")));
  const remuxedPart = await rpc("playback.direct.next", { playbackId: ffmpeg.playbackId });
  assert.ok(remuxedPart.segments.length > 0);
  assert.ok(remuxedPart.segments.reduce((sum, item) => sum + Buffer.from(item.data, "base64").length, 0) <= 128 * 1024);
  await rpc("playback.direct.seek", { playbackId: ffmpeg.playbackId, timeSeconds: 2 });
  assert.ok((await rpc("playback.direct.next", { playbackId: ffmpeg.playbackId })).segments.length > 0);
  await rpc("playback.stop", { playbackId: ffmpeg.playbackId });

  const hls = await rpc("playback.open", { itemId: "hls" });
  assert.equal(hls.streamMode, "hls");
  assert.equal("hlsProxyUrl" in hls, false);
  const manifest = await rpc("resource.load", { url: hls.hlsUrl, responseType: "text", resourceType: "hls" });
  assert.match(manifest.data, /^#EXTM3U/);
  for (const line of manifest.data.split("\n").filter(line => line && !line.startsWith("#"))) {
    const segment = await rpc("resource.load", { url: new URL(line, manifest.url).href, resourceType: "hls" });
    assert.deepEqual(Buffer.from(segment.data, "base64"), fixture.segments.get(new URL(line, manifest.url).pathname.split("/").at(-1)));
  }
  const selection = await rpc("playback.subtitle.select", { playbackId: hls.playbackId, subtitleStreamIndex: 2 });
  assert.equal(selection.selectedSubtitleIndex, 2);
  await rpc("playback.stop", { playbackId: hls.playbackId });
  assert.equal(fixture.proxyStarts, 0);
  assert.ok(fixture.calls.every(call => call.authenticated));
  assert.ok(chunksRead >= 2, "真实 HLS segment 应通过多条有界 MCP 消息");
  await transport.dispose();
  assert.equal(backend.transfers.bytes, 0);
});
