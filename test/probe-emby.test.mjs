import assert from "node:assert/strict";
import test from "node:test";
import { parseProbeArgs, runProbe } from "../scripts/probe-emby.mjs";

test("探针拒绝命令行密码，只接受非敏感连接参数", () => {
  assert.deepEqual(parseProbeArgs([
    "--server", "https://emby.example",
    "--username", "alice",
    "--search", "剧集",
    "--item", "movie"
  ]), {
    server: "https://emby.example",
    username: "alice",
    search: "剧集",
    itemId: "movie",
    help: false
  });
  assert.throws(() => parseProbeArgs(["--password", "secret"]), { code: "UNSAFE_ARGUMENT" });
});

test("mock 探针覆盖认证、目录、剧集、图片和 HLS 首分片且不触碰存储", async () => {
  const calls = [];
  const output = { text: "", write(value) { this.text += value; } };
  const clientFactory = ({ token }) => ({
    async authenticate(username, password) {
      calls.push(["authenticate", username, password]);
      return { ServerId: "server", AccessToken: "token", User: { Id: "user", Name: username } };
    },
    async getViews() { calls.push(["views", token]); return { Items: [{ Id: "view" }] }; },
    async getResume() { return { Items: [] }; },
    async getLatest() {
      return [
        { Id: "series", Type: "Series", ImageTags: { Primary: "tag" } },
        { Id: "movie", Type: "Movie" }
      ];
    },
    async search() { return { Items: [] }; },
    async getSeasons() { calls.push(["seasons"]); return { Items: [{ Id: "season" }] }; },
    async getEpisodes() { calls.push(["episodes"]); return { Items: [] }; },
    imageUrl(id) { return `https://emby.example/image/${id}`; },
    async getPlaybackInfo() {
      return {
        PlaySessionId: "play",
        MediaSources: [{
          Id: "media",
          SupportsTranscoding: true,
          MediaStreams: [
            {
              Type: "Subtitle", Index: 3, Codec: "ass", Language: "jpn",
              DisplayTitle: "日文 ASS", IsTextSubtitleStream: true
            },
            {
              Type: "Subtitle", Index: 4, Codec: "hdmv_pgs_subtitle", Language: "chi",
              DisplayTitle: "中文 PGS", IsTextSubtitleStream: false
            }
          ]
        }]
      };
    },
    subtitleUrl(_itemId, _mediaSourceId, index, options = {}) {
      return `https://emby.example/subtitle-${index}.${options.format ?? "vtt"}`;
    },
    hlsUrl() { return "https://emby.example/master.m3u8"; },
    async loadResource(url, { responseType } = {}) {
      calls.push(["resource", url, responseType]);
      if (url.endsWith("subtitle-3.ass")) {
        return {
          bytes: new TextEncoder().encode(`[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,探针 ASS 字幕`),
          contentType: "text/x-ass",
          url
        };
      }
      if (url.endsWith(".vtt")) {
        return { text: "WEBVTT\n\n00:00.000 --> 00:01.000\n字幕", contentType: "text/vtt", url };
      }
      if (url.endsWith("master.m3u8")) return { text: "#EXTM3U\nvariant.m3u8", contentType: "x", url };
      if (url.endsWith("variant.m3u8")) return { text: "#EXTM3U\nsegment.ts", contentType: "x", url };
      return { bytes: Uint8Array.of(1), contentType: "x", url };
    },
    async stopActiveEncoding() { calls.push(["stop"]); }
  });

  const result = await runProbe({
    options: { server: "https://emby.example", username: "alice", search: "", itemId: "" },
    password: "password",
    output,
    clientFactory,
    deviceId: "probe"
  });
  assert.equal(result.checkedHls, true);
  assert.equal(result.subtitleCount, 2);
  assert.equal(result.checkedTextSubtitle, true);
  assert.equal(result.checkedBurnInSubtitle, true);
  assert.ok(calls.some(([name]) => name === "episodes"));
  assert.ok(calls.some(([name]) => name === "stop"));
  assert.doesNotMatch(output.text, /password|token/);
  assert.match(output.text, /日文 ASS · jpn · ass · 文字\/VTT · 内嵌/);
  assert.match(output.text, /中文 PGS · chi · hdmv_pgs_subtitle · 烧录 · 内嵌/);
});

test("mock 探针在禁止转码时验证 MP4 Range/fMP4，而不是请求 HLS", async () => {
  const calls = [];
  const clientFactory = ({ token }) => token
    ? {
        async getViews() { return { Items: [{ Id: "view" }] }; },
        async getResume() { return { Items: [{ Id: "episode", Type: "Episode" }] }; },
        async getLatest() { return []; },
        async getPlaybackInfo() {
          return {
            PlaySessionId: "direct-play",
            MediaSources: [{
              Id: "direct-media",
              Container: "mp4",
              SupportsDirectStream: true,
              SupportsTranscoding: false,
              DirectStreamUrl: "/Videos/episode/stream.mp4?api_key=secret"
            }]
          };
        },
        async loadDirectRange(url, options) {
          calls.push(["range", url, options]);
          return { bytes: Uint8Array.of(1), start: options.start, end: options.start, total: 1 };
        }
      }
    : {
        async authenticate() {
          return { ServerId: "server", AccessToken: "token", User: { Id: "user", Name: "alice" } };
        }
      };
  let destroyed = false;
  const result = await runProbe({
    options: { server: "https://emby.example", username: "alice", search: "", itemId: "" },
    password: "password",
    output: { write() {} },
    clientFactory,
    directSessionFactory: ({ readRange }) => ({
      async initialize() {
        await readRange({ start: 0, end: 0 });
        return { tracks: [{ id: 0 }] };
      },
      async next() { return { segments: [{ trackId: 0, data: "AQ==" }] }; },
      destroy() { destroyed = true; }
    }),
    deviceId: "probe"
  });

  assert.equal(result.checkedMode, "direct-mp4");
  assert.equal(result.checkedDirect, true);
  assert.equal(result.checkedHls, false);
  assert.equal(destroyed, true);
  assert.match(calls[0][1], /stream\.mp4/);
  assert.doesNotMatch(calls[0][1], /api_key|secret/);
});

test("mock 探针把非 MP4 直连媒体交给 FFmpeg", async () => {
  const clientFactory = ({ token }) => token
    ? {
        async getViews() { return { Items: [{ Id: "view" }] }; },
        async getResume() { return { Items: [{ Id: "episode", Type: "Episode" }] }; },
        async getLatest() { return []; },
        async getPlaybackInfo() {
          return {
            PlaySessionId: "ffmpeg-play",
            MediaSources: [{
              Id: "mkv-media",
              Container: "mkv",
              SupportsDirectStream: true,
              SupportsTranscoding: false,
              DirectStreamUrl: "/Videos/episode/stream.mkv?api_key=secret",
              MediaStreams: [
                { Type: "Video", Codec: "h264" },
                { Type: "Audio", Codec: "aac" }
              ]
            }]
          };
        },
        async loadDirectRange(url, options) {
          assert.doesNotMatch(url, /api_key|secret/);
          return {
            bytes: Uint8Array.of(1),
            start: options.start,
            end: options.start,
            total: 1,
            contentType: "video/x-matroska"
          };
        }
      }
    : {
        async authenticate() {
          return { ServerId: "server", AccessToken: "token", User: { Id: "user", Name: "alice" } };
        }
      };
  let destroyed = false;
  const result = await runProbe({
    options: { server: "https://emby.example", username: "alice", search: "", itemId: "" },
    password: "password",
    output: { write() {} },
    clientFactory,
    ffmpegSessionFactory: ({ readRange, mediaSource }) => ({
      async initialize() {
        assert.equal(mediaSource.Container, "mkv");
        await readRange({ start: 0, end: 0 });
        return { tracks: [{ id: 0 }] };
      },
      async next() { return { segments: [{ trackId: 0, data: "AQ==" }] }; },
      destroy() { destroyed = true; }
    }),
    deviceId: "probe"
  });
  assert.equal(result.checkedMode, "ffmpeg-fmp4");
  assert.equal(result.checkedFfmpeg, true);
  assert.equal(destroyed, true);
});

test("没有可播放项目时媒体关卡失败，并提示使用 --item", async () => {
  const clientFactory = ({ token }) => token
    ? {
        async getViews() { return { Items: [] }; },
        async getResume() { return { Items: [] }; },
        async getLatest() { return []; }
      }
    : {
        async authenticate() {
          return { ServerId: "server", AccessToken: "token", User: { Id: "user" } };
        }
      };

  await assert.rejects(runProbe({
    options: { server: "https://emby.example", username: "alice", search: "", itemId: "" },
    password: "password",
    output: { write() {} },
    clientFactory,
    deviceId: "probe"
  }), {
    code: "PLAYABLE_ITEM_REQUIRED",
    message: /--item/
  });
});
