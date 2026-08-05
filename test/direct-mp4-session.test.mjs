import assert from "node:assert/strict";
import test from "node:test";
import { DIRECT_MP4_SEGMENT_BYTES, DirectMp4Session } from "../src/direct-mp4-session.mjs";

function bytes(...values) {
  return Uint8Array.from(values);
}

test("DirectMp4Session 跳读尾部 moov、输出单一 MSE 时间轴并按关键帧 seek", async () => {
  const reads = [];
  const segmentOptions = [];
  const released = [];
  const seeks = [];
  let starts = 0;
  let stops = 0;
  const file = {
    onReady: null,
    onError: null,
    onSegment: null,
    appendBuffer(buffer) {
      if (buffer.fileStart === 0) return 3000;
      if (buffer.fileStart === 3000) {
        this.onReady({
          duration: 60_000,
          timescale: 1000,
          tracks: [
            { id: 1, type: "video", codec: "avc1.64001f", duration: 60_000, timescale: 1000, nb_samples: 1440 },
            { id: 2, type: "audio", codec: "mp4a.40.2", duration: 2_646_000, timescale: 44_100, nb_samples: 2584 }
          ]
        });
        return 64;
      }
      this.onSegment(1, 1, bytes(1, 2, 3).buffer, 48, false);
      this.onSegment(2, 2, bytes(4, 5).buffer, 48, false);
      return 4096;
    },
    setSegmentOptions(id, user, options) { segmentOptions.push({ id, user, options }); },
    initializeSegmentation(mode) {
      assert.equal(mode, undefined);
      return {
        tracks: [{ id: 1, user: 1 }, { id: 2, user: 2 }],
        buffer: bytes(10, 11, 12).buffer
      };
    },
    getTrackById(id) {
      if (id !== 1) return { samples: [] };
      return {
        samples: Array.from({ length: 10 }, (_value, index) => ({
          is_sync: true,
          cts: index * 6000,
          dts: index * 6000
        }))
      };
    },
    seek(time) {
      seeks.push(time);
      return time > 0 ? { offset: 2048, time: 10 } : { offset: 128, time: 0 };
    },
    start() { starts += 1; },
    stop() { stops += 1; },
    flush() {},
    releaseUsedSamples(id, sampleNumber) { released.push({ id, sampleNumber }); }
  };
  const session = new DirectMp4Session({
    createFileImpl: (keepMdatData) => {
      assert.equal(keepMdatData, false);
      return file;
    },
    chunkSize: 512,
    readRange: async ({ start, end }) => {
      reads.push({ start, end });
      const actualEnd = Math.min(end, 4095);
      return {
        bytes: new Uint8Array(actualEnd - start + 1),
        start,
        end: actualEnd,
        total: 4096,
        resolvedUrl: "https://cdn.example/video.mp4"
      };
    }
  });

  const initialization = await session.initialize({ startTimeSeconds: 0 });
  assert.equal(initialization.durationSeconds, 60);
  assert.equal(initialization.keyframeIntervalSeconds, 6);
  assert.deepEqual(initialization.keyframeTimesSeconds, [0, 6, 12, 18, 24, 30, 36, 42, 48, 54]);
  assert.deepEqual(initialization.tracks.map(({ id, type, codec, mime, initData }) => ({ id, type, codec, mime, initData })), [
    { id: 0, type: "combined", codec: "avc1.64001f,mp4a.40.2", mime: 'video/mp4; codecs="avc1.64001f,mp4a.40.2"', initData: "CgsM" }
  ]);
  assert.deepEqual(reads.slice(0, 2).map(({ start }) => start), [0, 3000]);
  assert.equal(segmentOptions[0].options.nbSamples, 48);
  assert.equal(segmentOptions[1].options.nbSamples, 48);
  assert.equal(segmentOptions[0].options.sizePerSegment, DIRECT_MP4_SEGMENT_BYTES);
  assert.equal(segmentOptions[1].options.sizePerSegment, DIRECT_MP4_SEGMENT_BYTES);
  assert.equal(segmentOptions[0].options.rapAlignement, false);
  assert.equal(segmentOptions[1].options.rapAlignement, false);

  const first = await session.next();
  assert.deepEqual(first.segments.map(({ trackId, data }) => ({ trackId, data })), [
    { trackId: 0, data: "AQID" },
    { trackId: 0, data: "BAU=" }
  ]);
  assert.deepEqual(first.segments.map(({ segmentStart, segmentEnd }) => ({ segmentStart, segmentEnd })), [
    { segmentStart: true, segmentEnd: true },
    { segmentStart: true, segmentEnd: true }
  ]);
  assert.deepEqual(released, [{ id: 1, sampleNumber: 48 }, { id: 2, sampleNumber: 48 }]);

  assert.deepEqual(await session.seek(12), { timeSeconds: 10, offset: 2048 });
  const afterSeek = await session.next();
  assert.equal(afterSeek.segments.length, 2);
  assert.deepEqual(seeks, [0, 12]);
  assert.equal(starts, 2);

  session.destroy();
  assert.equal(stops, 2);
});

test("DirectMp4Session 生成有界小分片，并把异常大分片拆成有界 RPC 字节流", async () => {
  const released = [];
  const segmentOptions = [];
  let emitted = false;
  const file = {
    onReady: null,
    onError: null,
    onSegment: null,
    appendBuffer(buffer) {
      if (buffer.fileStart === 0) {
        this.onReady({
          duration: 10_000,
          timescale: 1000,
          tracks: [
            { id: 1, type: "video", codec: "hvc1.1.6.L153", duration: 10_000, timescale: 1000, nb_samples: 250 }
          ]
        });
        return 1;
      }
      if (!emitted) {
        emitted = true;
        this.onSegment(1, 1, bytes(0, 1, 2, 3, 4, 5).buffer, 10, false);
        this.onSegment(1, 1, bytes(4, 5, 6, 7).buffer, 20, false);
        this.onSegment(1, 1, bytes(8, 9).buffer, 30, true);
      }
      return 2;
    },
    setSegmentOptions(id, user, options) { segmentOptions.push({ id, user, options }); },
    initializeSegmentation(mode) {
      assert.equal(mode, undefined);
      return { buffer: bytes(10, 11).buffer };
    },
    seek() { return { offset: 1, time: 0 }; },
    start() {},
    stop() {},
    flush() {},
    releaseUsedSamples(id, sampleNumber) { released.push({ id, sampleNumber }); }
  };
  const session = new DirectMp4Session({
    createFileImpl: () => file,
    chunkSize: 1,
    segmentSizeBytes: 4,
    maxBatchBytes: 4,
    maxSegmentBytes: 6,
    readRange: async ({ start }) => ({
      bytes: bytes(start),
      start,
      end: start,
      total: 2
    })
  });

  await session.initialize();
  assert.deepEqual(segmentOptions, [{
    id: 1,
    user: 1,
    options: { nbSamples: 50, sizePerSegment: 4, rapAlignement: false }
  }]);
  const first = await session.next();
  const second = await session.next();
  const third = await session.next();

  assert.deepEqual(
    [first, second, third].map((result) => result.segments.map((segment) => Buffer.from(segment.data, "base64").length)),
    [[4], [2, 2], [2, 2]]
  );
  assert.deepEqual(
    [first, second, third].map((result) => result.segments.map((segment) => segment.last)),
    [[false], [false, false], [false, true]]
  );
  assert.deepEqual(
    [first, second, third].map((result) => result.segments.map(({ segmentStart, segmentEnd }) => [segmentStart, segmentEnd])),
    [[[true, false]], [[false, true], [true, false]], [[false, true], [true, true]]]
  );
  assert.deepEqual([first.end, second.end, third.end], [false, false, true]);
  assert.deepEqual(released, [
    { id: 1, sampleNumber: 10 },
    { id: 1, sampleNumber: 20 },
    { id: 1, sampleNumber: 30 }
  ]);
});

function makeStreamingFile({ seekOffset = 1 } = {}) {
  let sampleNumber = 0;
  let queuedBytes = 0;
  let maxQueuedBytes = 0;
  const sampleSizes = new Map();
  const file = {
    onReady: null,
    onError: null,
    onSegment: null,
    appendBuffer(buffer) {
      if (buffer.fileStart === 0) {
        this.onReady({
          duration: 100_000,
          timescale: 1000,
          tracks: [
            { id: 1, type: "video", codec: "avc1.640028", duration: 100_000, timescale: 1000, nb_samples: 2500 }
          ]
        });
        return 1;
      }
      const size = buffer.byteLength;
      sampleNumber += 1;
      sampleSizes.set(sampleNumber, size);
      queuedBytes += size;
      maxQueuedBytes = Math.max(maxQueuedBytes, queuedBytes);
      this.onSegment(1, 1, buffer, sampleNumber, false);
      return buffer.fileStart + size;
    },
    setSegmentOptions() {},
    initializeSegmentation(mode) {
      assert.equal(mode, undefined);
      return { buffer: bytes(10, 11).buffer };
    },
    seek(time) { return { offset: time > 0 ? seekOffset : 1, time }; },
    start() {},
    stop() {},
    flush() {},
    releaseUsedSamples(_id, releasedSample) {
      queuedBytes -= sampleSizes.get(releasedSample) ?? 0;
      sampleSizes.delete(releasedSample);
    }
  };
  return { file, maxQueuedBytes: () => maxQueuedBytes };
}

test("DirectMp4Session 播放阶段复用持续 Range、断流后从已收偏移续接并限制预取", async () => {
  const { file, maxQueuedBytes } = makeStreamingFile();
  const opens = [];
  let releaseFirstStream;
  const firstStreamGate = new Promise((resolve) => { releaseFirstStream = resolve; });
  const session = new DirectMp4Session({
    createFileImpl: () => file,
    chunkSize: 1,
    segmentSizeBytes: 2,
    maxBatchBytes: 2,
    maxQueueBytes: 4,
    resumeQueueBytes: 2,
    readRange: async ({ start }) => ({
      bytes: bytes(start),
      start,
      end: start,
      total: 7,
      resolvedUrl: "https://cdn.example/video.mp4"
    }),
    openRangeStream: async ({ start, end, signal, resolvedUrl }) => {
      opens.push({ start, end, signal, resolvedUrl });
      if (start === 1) {
        return {
          start,
          end: 6,
          total: 7,
          resolvedUrl,
          body: (async function* () {
            yield bytes(1, 2);
            await firstStreamGate;
            throw new Error("模拟中途断流");
          })(),
          async cancel() {}
        };
      }
      return {
        start,
        end: 6,
        total: 7,
        resolvedUrl,
        body: (async function* () {
          for (let offset = start; offset <= 6; offset += 2) {
            yield bytes(offset, offset + 1);
          }
        })(),
        async cancel() {}
      };
    }
  });

  await session.initialize();
  const received = [];
  const first = await session.next();
  received.push(...first.segments.flatMap((segment) => [...Buffer.from(segment.data, "base64")]));
  releaseFirstStream();
  for (let attempts = 0; attempts < 5; attempts += 1) {
    const result = await session.next();
    received.push(...result.segments.flatMap((segment) => [...Buffer.from(segment.data, "base64")]));
    if (result.end) break;
  }

  assert.deepEqual(received, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(opens.map(({ start, end }) => ({ start, end })), [
    { start: 1, end: null },
    { start: 3, end: null }
  ]);
  assert.equal(opens[0].resolvedUrl, "https://cdn.example/video.mp4");
  assert.ok(maxQueuedBytes() <= 4, `预取队列峰值不应超过 4 字节，实际 ${maxQueuedBytes()}`);
  session.destroy();
});

test("DirectMp4Session seek 和 destroy 都会取消当前持续流", async () => {
  const { file } = makeStreamingFile({ seekOffset: 5 });
  const opens = [];
  const cancellations = [];
  const session = new DirectMp4Session({
    createFileImpl: () => file,
    chunkSize: 1,
    segmentSizeBytes: 2,
    maxBatchBytes: 2,
    maxQueueBytes: 4,
    resumeQueueBytes: 2,
    readRange: async ({ start }) => ({ bytes: bytes(start), start, end: start, total: 100 }),
    openRangeStream: async ({ start, signal }) => {
      opens.push({ start, signal });
      return {
        start,
        end: 99,
        total: 100,
        body: (async function* () {
          yield bytes(start, start + 1);
          await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
          throw signal.reason;
        })(),
        async cancel(reason) { cancellations.push({ start, reason }); }
      };
    }
  });

  await session.initialize();
  await session.next();
  assert.deepEqual(await session.seek(10), { timeSeconds: 10, offset: 5 });
  assert.equal(opens[0].signal.aborted, true);

  await session.next();
  session.destroy();
  assert.equal(opens[1].signal.aborted, true);
  assert.deepEqual(opens.map(({ start }) => start), [1, 5]);
  assert.ok(cancellations.some((entry) => entry.start === 1));
  assert.ok(cancellations.some((entry) => entry.start === 5));
});
