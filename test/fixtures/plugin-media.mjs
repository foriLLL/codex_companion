import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { EmbyService } from "../../src/emby-service.mjs";
import { resolveFfmpegPath } from "../../src/ffmpeg-path.mjs";

const run = promisify(execFile);
const token = "fixture-only-token-never-a-user-credential";

// 本地生成的测试画面，不接触用户 Keychain/配置/媒体库。供 RPC 与浏览器
// 冒烟共用，使页面仍通过完整后端 fetch、鉴权、MSE 与字幕路径拿到真实字节。
export async function createPluginMediaFixture() {
  const ffmpegPath = resolveFfmpegPath();
  if (!ffmpegPath) return null;
  const directory = await mkdtemp(join(tmpdir(), "companion-plugin-media-"));
  let server;
  try {
    await run(ffmpegPath, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=6",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=6",
      "-shortest", "-c:v", "libx264", "-b:v", "700k", "-g", "48", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-movflags", "+faststart", join(directory, "fixture.mp4")
    ], { timeout: 20_000 });
    await run(ffmpegPath, [
      "-hide_banner", "-loglevel", "error", "-y", "-i", join(directory, "fixture.mp4"),
      "-c", "copy", "-hls_time", "2", "-hls_playlist_type", "vod", join(directory, "master.m3u8")
    ], { timeout: 20_000 });
    await run(ffmpegPath, [
      "-hide_banner", "-loglevel", "error", "-y", "-i", join(directory, "fixture.mp4"),
      "-c", "copy", join(directory, "fixture.mkv")
    ], { timeout: 20_000 });
    const mp4 = await readFile(join(directory, "fixture.mp4"));
    const mkv = await readFile(join(directory, "fixture.mkv"));
    const playlist = await readFile(join(directory, "master.m3u8"), "utf8");
    const segments = new Map(await Promise.all(playlist.split("\n").filter(line => line && !line.startsWith("#")).map(async name => [name, await readFile(join(directory, name))])));
    const calls = [];
    let playSession = 0;
    const items = [
      { Id: "direct", Name: "直放测试", Type: "Movie", ProductionYear: 2026, RunTimeTicks: 60_000_000, ImageTags: { Primary: "fixture" }, UserData: { PlaybackPositionTicks: 0 } },
      { Id: "hls", Name: "HLS 测试", Type: "Movie", ProductionYear: 2026, RunTimeTicks: 60_000_000, ImageTags: { Primary: "fixture" }, UserData: { PlaybackPositionTicks: 0 } },
      { Id: "ffmpeg", Name: "重封装测试", Type: "Movie", ProductionYear: 2026, RunTimeTicks: 60_000_000, ImageTags: { Primary: "fixture" }, UserData: { PlaybackPositionTicks: 0 } }
    ];
    const send = (response, body, type = "application/json", status = 200, headers = {}) => {
      const data = typeof body === "object" && !Buffer.isBuffer(body) ? JSON.stringify(body) : body;
      response.writeHead(status, { "content-type": type, "content-length": Buffer.byteLength(data), ...headers });
      response.end(data);
    };
    server = createServer(async (request, response) => {
      try {
        const url = new URL(request.url, "http://fixture.invalid");
        for await (const _chunk of request) { /* 消费会话上报体 */ }
        calls.push({ pathname: url.pathname, range: request.headers.range, authenticated: request.headers["x-emby-token"] === token });
        if (request.headers["x-emby-token"] !== token) return send(response, { error: "missing fixture authentication" }, "application/json", 401);
        if (url.pathname.endsWith("/Views")) return send(response, { Items: [{ Id: "fixture-library", Name: "测试媒体库", Type: "CollectionFolder" }] });
        if (url.pathname.endsWith("/Items/Resume")) return send(response, { Items: [] });
        if (url.pathname.endsWith("/Items/Latest")) return send(response, items);
        if (url.pathname.endsWith("/Items")) {
          const query = String(url.searchParams.get("SearchTerm") || "").toLowerCase();
          return send(response, { Items: items.filter(item => item.Name.toLowerCase().includes(query)), TotalRecordCount: items.length });
        }
        if (url.pathname.includes("/Images/")) return send(response, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jrVsAAAAASUVORK5CYII=", "base64"), "image/png");
        if (url.pathname.endsWith("/Seasons")) return send(response, { Items: [{ Id: "fixture-season", Name: "测试季", IndexNumber: 1 }] });
        if (url.pathname.endsWith("/Episodes")) return send(response, { Items: items.map((item, index) => ({ ...item, Type: "Episode", SeriesId: "fixture-series", SeasonId: "fixture-season", IndexNumber: index + 1 })) });
        if (url.pathname.includes("/PlaybackInfo")) {
          const isHls = url.pathname.includes("/hls/");
          const isMkv = url.pathname.includes("/ffmpeg/");
          return send(response, { PlaySessionId: `fixture-session-${++playSession}`, MediaSources: [{
            Id: isHls ? "hls-source" : isMkv ? "mkv-source" : "direct-source", Container: isMkv ? "mkv" : "mp4", RunTimeTicks: 60_000_000,
            ...(isHls ? { SupportsTranscoding: true } : { SupportsDirectPlay: true, DirectStreamUrl: isMkv ? "/emby/Videos/ffmpeg/stream.mkv" : "/emby/Videos/direct/stream.mp4" }),
            MediaStreams: [
              { Index: 0, Type: "Video", Codec: "h264", Height: 180, Width: 320, BitRate: 700_000 },
              { Index: 1, Type: "Audio", Codec: "aac" },
              { Index: 2, Type: "Subtitle", Codec: "webvtt", IsExternal: true, IsTextSubtitleStream: true, Language: "chi", DisplayTitle: "中文测试字幕" }
            ]
          }] });
        }
        if (/stream\.(mp4|mkv)$/.test(url.pathname)) {
          const media = url.pathname.endsWith(".mkv") ? mkv : mp4;
          const contentType = url.pathname.endsWith(".mkv") ? "video/x-matroska" : "video/mp4";
          const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || "");
          if (!match) return send(response, media, contentType);
          const start = Number(match[1]);
          const end = Math.min(media.length - 1, match[2] ? Number(match[2]) : media.length - 1);
          if (start > end) return send(response, "", contentType, 416, { "content-range": `bytes */${media.length}` });
          return send(response, media.subarray(start, end + 1), contentType, 206, { "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${media.length}` });
        }
        if (url.pathname.endsWith("master.m3u8")) return send(response, playlist, "application/vnd.apple.mpegurl");
        const segment = segments.get(url.pathname.split("/").at(-1));
        if (segment) return send(response, segment, "video/mp2t");
        if (url.pathname.endsWith("Stream.vtt")) return send(response, "WEBVTT\n\n00:00:00.000 --> 00:00:05.000\n插件媒体通道测试\n", "text/vtt");
        if (url.pathname.startsWith("/emby/Sessions/") || url.pathname === "/emby/Videos/ActiveEncodings") return send(response, "", "application/json", 204);
        return send(response, { error: "unknown fixture route" }, "application/json", 404);
      } catch {
        if (!response.headersSent) send(response, { error: "fixture failed" }, "application/json", 500);
        else response.destroy();
      }
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const baseUrl = `http://127.0.0.1:${server.address().port}/emby`;
    const config = { baseUrl, serverId: "fixture-server", userId: "fixture-user", username: "fixture", deviceId: "fixture-device" };
    const storage = { loadConfig: async () => config, readToken: async () => token };
    let proxyStarts = 0;
    const service = new EmbyService({
      storage,
      hlsProxyFactory: () => ({ start: async () => { proxyStarts += 1; throw new Error("插件不应启动 HTTP 代理"); }, close: async () => {} })
    });
    return {
      service, calls, baseUrl, mp4, playlist, segments, get proxyStarts() { return proxyStarts; },
      async close() {
        await service.dispose();
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        await rm(directory, { recursive: true, force: true });
      }
    };
  } catch (error) {
    server?.closeAllConnections();
    server?.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
