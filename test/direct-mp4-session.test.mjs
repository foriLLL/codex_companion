import assert from "node:assert/strict";
import test from "node:test";
import { DirectMp4Session } from "../src/direct-mp4-session.mjs";

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
  assert.deepEqual(initialization.tracks.map(({ id, type, codec, initData }) => ({ id, type, codec, initData })), [
    { id: 0, type: "combined", codec: "avc1.64001f,mp4a.40.2", initData: "CgsM" }
  ]);
  assert.deepEqual(reads.slice(0, 2).map(({ start }) => start), [0, 3000]);
  assert.equal(segmentOptions[0].options.nbSamples, segmentOptions[1].options.nbSamples);
  assert.equal(segmentOptions[0].options.sizePerSegment, 4 * 1024 * 1024);
  assert.equal(segmentOptions[1].options.sizePerSegment, 4 * 1024 * 1024);
  assert.equal(segmentOptions[0].options.rapAlignement, false);
  assert.equal(segmentOptions[1].options.rapAlignement, false);

  const first = await session.next();
  assert.deepEqual(first.segments.map(({ trackId, data }) => ({ trackId, data })), [
    { trackId: 0, data: "AQID" },
    { trackId: 0, data: "BAU=" }
  ]);
  assert.deepEqual(released, [{ id: 1, sampleNumber: 48 }, { id: 2, sampleNumber: 48 }]);

  assert.deepEqual(session.seek(12), { timeSeconds: 10, offset: 2048 });
  const afterSeek = await session.next();
  assert.equal(afterSeek.segments.length, 2);
  assert.deepEqual(seeks, [0, 12]);
  assert.equal(starts, 2);

  session.destroy();
  assert.equal(stops, 2);
});

test("DirectMp4Session 从源头生成完整小分片并限制单次 RPC 批次", async () => {
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
        this.onSegment(1, 1, bytes(0, 1, 2, 3).buffer, 10, false);
        this.onSegment(1, 1, bytes(4, 5, 6, 7).buffer, 20, false);
        this.onSegment(1, 1, bytes(8, 9).buffer, 30, true);
      }
      return 2;
    },
    setSegmentOptions(id, user, options) { segmentOptions.push({ id, user, options }); },
    initializeSegmentation() { return { buffer: bytes(10, 11).buffer }; },
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
    [[4], [4], [2]]
  );
  assert.deepEqual(
    [first, second, third].map((result) => result.segments[0].last),
    [false, false, true]
  );
  assert.deepEqual([first.end, second.end, third.end], [false, false, true]);
  assert.deepEqual(released, [
    { id: 1, sampleNumber: 10 },
    { id: 1, sampleNumber: 20 },
    { id: 1, sampleNumber: 30 }
  ]);
});
