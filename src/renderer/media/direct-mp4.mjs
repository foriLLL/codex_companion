// 红果与 Emby 共用的 MSE 管线；每次调用独占播放器状态。
export function createDirectMp4Stream(scope, ui) {
  const { rpc, listen, unlisten, setTimeout, clearTimeout, createObjectURL, revokeObjectURL, isDisposed } = scope;
  const { rpcError, toRpcError, decodeBase64 } = ui;
  const configureDirectMp4Stream = async (embyVideo, playback, {
    rpcPrefix,
    setActivePlayer,
    clearActivePlayer,
    isStopping,
    onFailure,
    onQuotaExceeded,
    onDiagnostics = () => {}
  }) => {
    if (isDisposed()) throw rpcError("ABORTED", "播放器已经关闭");
    if (typeof MediaSource !== "function" || typeof MediaSource.isTypeSupported !== "function") {
      throw rpcError("MSE_UNAVAILABLE", "当前 Renderer 不支持 MediaSource 播放");
    }
    const mediaSource = new MediaSource();
    const objectUrl = createObjectURL(mediaSource);
    let resolveInitialBuffer;
    const initialBufferReady = new Promise((resolve) => { resolveInitialBuffer = resolve; });
    const requestedInitialBuffer = Number(playback?.initialBufferSeconds);
    const defaultInitialBuffer = rpcPrefix === "playback.direct"
      ? (playback?.streamMode === "ffmpeg-fmp4" ? 6 : 4)
      : 0.5;
    const initialBufferTarget = Number.isFinite(requestedInitialBuffer) && requestedInitialBuffer > 0.5
      ? Math.min(12, requestedInitialBuffer)
      : defaultInitialBuffer;
    // SourceBuffer 的配额按字节而不是按秒计算。以 40 MiB 编码数据为常驻预算，
    // 再给正在传输/解码的分片留出余量：低码率仍保留 12s + 5s，高码率则自动
    // 缩短（40 Mbps 约为 6.7s + 1.7s），避免“时间不长但字节已满”。
    const mediaBitrate = Number(playback?.mediaBitrate);
    const bufferBudgetSeconds = Number.isFinite(mediaBitrate) && mediaBitrate > 0
      ? (40 * 1024 * 1024 * 8) / mediaBitrate
      : Infinity;
    let backBufferSeconds = Number.isFinite(bufferBudgetSeconds)
      ? Math.max(1, Math.min(5, bufferBudgetSeconds * 0.2))
      : 5;
    let maxForwardBufferSeconds = Number.isFinite(bufferBudgetSeconds)
      ? Math.max(initialBufferTarget, Math.min(12, bufferBudgetSeconds - backBufferSeconds))
      : 12;
    // MSE remove 会连带删除直到下一关键帧的依赖帧。直连 MP4 初始化后用真实最大
    // GOP 间隔保留完整当前 GOP；0.5s 边缘容差则避免播放头落在被取整后的微小空洞
    // 前时误判为“完全没缓冲”，继而高速预取直至 SourceBuffer 配额耗尽。
    let bufferEdgeToleranceSeconds = 0.5;
    const tuneBufferForKeyframes = (keyframeIntervalValue) => {
      if (rpcPrefix !== "playback.direct" || playback?.streamMode !== "direct-mp4") return;
      const keyframeInterval = Number(keyframeIntervalValue);
      if (!Number.isFinite(keyframeInterval) || keyframeInterval <= 0) return;
      const retainedGop = Math.min(12, keyframeInterval + 0.5);
      backBufferSeconds = Math.max(backBufferSeconds, retainedGop);
      maxForwardBufferSeconds = Number.isFinite(bufferBudgetSeconds)
        ? Math.max(initialBufferTarget, Math.min(12, bufferBudgetSeconds - backBufferSeconds))
        : 12;
      bufferEdgeToleranceSeconds = Math.max(0.5, Math.min(1, keyframeInterval * 0.1));
    };
    const player = {
      destroyed: false,
      generation: 0,
      controller: null,
      seekTimer: null,
      seekController: null,
      seekInFlight: false,
      pendingSeekTime: null,
      pointerActive: false,
      pointerSawSeek: false,
      sourceBuffers: new Map(),
      parserComplete: new Map(),
      keyframeTimes: [],
      quotaRetries: 0,
      quotaKeyframeRecoveries: 0,
      quotaRestarts: Math.max(0, Number(playback?.mseQuotaRestarts) || 0),
      lastQuotaRecovery: null,
      recoveringQuota: false,
      initialSeekTarget: null,
      mediaSource,
      objectUrl,
      started: false,
      initialBufferFailure: null,
      initialBufferTimer: null,
      destroy: null
    };
    setActivePlayer(player);
    embyVideo.src = objectUrl;

    const waitForSourceOpen = () => new Promise((resolve, reject) => {
      if (mediaSource.readyState === "open") {
        resolve();
        return;
      }
      const timeout = setTimeout(() => finish(reject, rpcError("MSE_OPEN_TIMEOUT", "MediaSource 启动超时", true)), 10_000);
      const finish = (callback, value) => {
        clearTimeout(timeout);
        unlisten(mediaSource, "sourceopen", onOpen);
        unlisten(mediaSource, "sourceclose", onClose);
        callback(value);
      };
      const onOpen = () => finish(resolve);
      const onClose = () => finish(reject, rpcError("MSE_CLOSED", "MediaSource 已关闭", true));
      listen(mediaSource, "sourceopen", onOpen, { once: true });
      listen(mediaSource, "sourceclose", onClose, { once: true });
    });

    const waitForUpdateEnd = (sourceBuffer, operation) => new Promise((resolve, reject) => {
      if (player.destroyed) {
        reject(rpcError("ABORTED", "播放器已经关闭"));
        return;
      }
      const cleanup = () => {
        unlisten(sourceBuffer, "updateend", onUpdateEnd);
        unlisten(sourceBuffer, "error", onError);
        unlisten(sourceBuffer, "abort", onAbort);
      };
      const onUpdateEnd = () => { cleanup(); resolve(); };
      const onError = () => { cleanup(); reject(rpcError("MSE_APPEND_ERROR", "视频分片写入失败", true)); };
      const onAbort = () => { cleanup(); reject(rpcError("ABORTED", "视频分片写入已取消", true)); };
      listen(sourceBuffer, "updateend", onUpdateEnd, { once: true });
      listen(sourceBuffer, "error", onError, { once: true });
      listen(sourceBuffer, "abort", onAbort, { once: true });
      try {
        operation();
      } catch (errorValue) {
        cleanup();
        reject(errorValue);
      }
    });

    const isQuotaExceeded = (errorValue) => (
      errorValue?.name === "QuotaExceededError"
      || /SourceBuffer is full|QuotaExceededError/i.test(String(errorValue?.message || errorValue || ""))
    );

    const appendOnce = async (sourceBuffer, bytes) => {
      if (sourceBuffer.updating) await waitForUpdateEnd(sourceBuffer, () => {});
      await waitForUpdateEnd(sourceBuffer, () => sourceBuffer.appendBuffer(bytes));
    };

    const bufferAhead = () => {
      const time = Number(embyVideo.currentTime) || 0;
      for (let index = 0; index < embyVideo.buffered.length; index += 1) {
        const start = embyVideo.buffered.start(index);
        const end = embyVideo.buffered.end(index);
        if (time >= start - bufferEdgeToleranceSeconds && time <= end) return Math.max(0, end - time);
      }
      return 0;
    };

    const isBuffered = (time) => {
      for (let index = 0; index < embyVideo.buffered.length; index += 1) {
        if (
          time >= embyVideo.buffered.start(index) - bufferEdgeToleranceSeconds
          && time <= embyVideo.buffered.end(index) - 0.1
        ) return true;
      }
      return false;
    };

    const waitForDemand = (forwardLimit = maxForwardBufferSeconds) => new Promise((resolve) => {
      if (player.destroyed || bufferAhead() < forwardLimit) {
        resolve();
        return;
      }
      let timeout = null;
      const finish = () => {
        clearTimeout(timeout);
        unlisten(embyVideo, "timeupdate", finish);
        unlisten(embyVideo, "seeking", finish);
        unlisten(embyVideo, "play", finish);
        resolve();
      };
      // 暂停时 timeupdate 不再触发：等 play/seeking 事件，超时兜底拉长到 30s，
      // 避免整个暂停期间 pump 每秒空醒两次重建监听器。超时只是防垂死，destroy
      // 后 promise 也会经这条路径 resolve、循环随即因 player.destroyed 退出。
      timeout = setTimeout(finish, embyVideo.paused ? 30_000 : 500);
      listen(embyVideo, "timeupdate", finish, { once: true });
      listen(embyVideo, "seeking", finish, { once: true });
      listen(embyVideo, "play", finish, { once: true });
    });

    const evictBefore = async (removeEnd) => {
      if (removeEnd <= 0) return;
      await Promise.all([...player.sourceBuffers.entries()].map(async ([trackId, sourceBuffer]) => {
        if (sourceBuffer.updating) return;
        const duration = Number(mediaSource.duration);
        const end = Number.isFinite(duration) && duration > 0
          ? Math.min(removeEnd, duration)
          : removeEnd;
        if (end <= 0.25) return;
        // 一个 SourceBuffer 内含音频+视频时，buffered 是各 track 可播区间的交集。
        // 从 buffered.start 开始删会漏掉交集之前仍驻留的单轨 coded frames；必须
        // 从时间轴 0 删除，才会同时回收两条 track 的隐藏数据和真实媒体配额。
        await waitForUpdateEnd(sourceBuffer, () => sourceBuffer.remove(0, end));
        // remove 只删除 coded frames，不一定释放 ISO-BMFF byte-stream parser 的
        // 输入缓存。仅在一个完整 moof+mdat 边界上 abort，重置 parser 后让 Chromium
        // 真正回收已删数据；分片被拆成多次 RPC 时绝不能在中途 abort。
        if (
          player.parserComplete.get(trackId) === true
          && !sourceBuffer.updating
          && mediaSource.readyState === "open"
        ) {
          try { sourceBuffer.abort(); } catch {}
        }
      }));
    };

    const evictBackBuffer = async (retainedSeconds = backBufferSeconds) => {
      await evictBefore((Number(embyVideo.currentTime) || 0) - retainedSeconds);
    };

    const flushDecoderReferences = async () => {
      const current = Number(embyVideo.currentTime) || 0;
      let start = null;
      let end = null;
      for (let index = 0; index < embyVideo.buffered.length; index += 1) {
        const rangeStart = embyVideo.buffered.start(index);
        const rangeEnd = embyVideo.buffered.end(index);
        if (current >= rangeStart - bufferEdgeToleranceSeconds && current <= rangeEnd) {
          start = rangeStart;
          end = rangeEnd;
          break;
        }
      }
      if (start === null || end - start < 0.08) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return false;
      }
      // remove/updateend 只保证 coded frames 已从 SourceBuffer 时间轴删除，不保证
      // 解码器同步放开旧帧引用。同一可播区间内轻推 10ms 会刷新 decoder 而不触发
      // 网络 seek；等 seeked 后再 append，避免“时间轴只剩 0.4s 仍报 full”。
      const target = Math.min(end - 0.03, Math.max(start + 0.03, current + 0.01));
      if (!Number.isFinite(target) || Math.abs(target - current) < 0.001) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return false;
      }
      await new Promise((resolve) => {
        let timeout = null;
        const finish = () => {
          clearTimeout(timeout);
          unlisten(embyVideo, "seeked", finish);
          resolve();
        };
        timeout = setTimeout(finish, 300);
        listen(embyVideo, "seeked", finish, { once: true });
        embyVideo.currentTime = target;
      });
      return true;
    };

    const recoverQuotaAtKeyframe = async () => {
      if (player.keyframeTimes.length === 0) {
        player.lastQuotaRecovery = "no-keyframes";
        return false;
      }
      if (embyVideo.buffered.length === 0) {
        player.lastQuotaRecovery = "no-buffer";
        return false;
      }
      const current = Number(embyVideo.currentTime) || 0;
      let rangeStart = null;
      let rangeEnd = null;
      for (let index = 0; index < embyVideo.buffered.length; index += 1) {
        const start = embyVideo.buffered.start(index);
        const end = embyVideo.buffered.end(index);
        if (current >= start - bufferEdgeToleranceSeconds && current <= end) {
          rangeStart = start;
          rangeEnd = end;
          break;
        }
      }
      if (rangeStart === null) {
        player.lastQuotaRecovery = "outside-buffer";
        return false;
      }
      const candidates = player.keyframeTimes.filter((time) => (
        time > rangeStart + 0.05 && time < rangeEnd - 0.05
      ));
      if (candidates.length === 0) {
        player.lastQuotaRecovery = `no-boundary:${rangeStart.toFixed(2)}-${rangeEnd.toFixed(2)}`;
        return false;
      }
      // 边界附近不能留 ±0.05s 的“无人区”：重试常恰好发生在 54.05s，若同时
      // 要求 past<=54.00、future>54.10，会错过正好 54.00 的关键帧。
      const passed = candidates.filter((time) => time <= current).at(-1);
      const cutoff = passed ?? candidates.find((time) => time > current);
      if (!Number.isFinite(cutoff)) {
        player.lastQuotaRecovery = "no-cutoff";
        return false;
      }

      // 若安全边界还在播放头前方，让现有缓冲继续播放到该关键帧；到达后精确
      // 删除它之前的 coded frames。比“再等固定 N 秒”可靠，也不会删进当前 GOP。
      while (!player.destroyed && (Number(embyVideo.currentTime) || 0) < cutoff + 0.05) {
        if (bufferAhead() <= 0.1) {
          player.lastQuotaRecovery = `buffer-ended-before:${cutoff.toFixed(2)}`;
          return false;
        }
        await waitForDemand(-1);
      }
      if (player.destroyed) throw rpcError("ABORTED", "播放器已经关闭");
      await evictBefore(Math.max(0, cutoff - 0.001));
      const decoderFlushed = await flushDecoderReferences();
      player.quotaKeyframeRecoveries += 1;
      player.lastQuotaRecovery = `evicted-before:${cutoff.toFixed(2)}${decoderFlushed ? ":decoder-flushed" : ""}`;
      return true;
    };

    const append = async (trackId, sourceBuffer, bytes, segmentEnd = true) => {
      try {
        await appendOnce(sourceBuffer, bytes);
        player.parserComplete.set(trackId, segmentEnd);
        return;
      } catch (errorValue) {
        if (!isQuotaExceeded(errorValue) || player.destroyed) throw errorValue;
        player.quotaRetries += 1;
      }

      // 配额命中不是媒体损坏：当前分片尚未写入，可以让已缓冲内容继续播放，
      // 收缩到约 4 秒后清掉旧数据并原样重试。清理仍保留完整当前 GOP，避免
      // SourceBuffer 把依赖帧一并删到下一关键帧、制造微小空洞后再次错误预取。
      // 这样不需要
      // 重启 FFmpeg/Range 流；暂停状态则等用户继续播放后自然恢复。
      const retryAheadSeconds = Math.max(2, Math.min(4, initialBufferTarget));
      while (!player.destroyed && bufferAhead() >= retryAheadSeconds) {
        await waitForDemand(retryAheadSeconds);
      }
      if (player.destroyed) throw rpcError("ABORTED", "播放器已经关闭");
      await evictBackBuffer();
      try {
        await appendOnce(sourceBuffer, bytes);
      } catch (retryError) {
        if (!isQuotaExceeded(retryError) || !await recoverQuotaAtKeyframe()) throw retryError;
        await appendOnce(sourceBuffer, bytes);
      }
      player.parserComplete.set(trackId, segmentEnd);
    };

    const fail = (errorValue) => {
      const errorObject = toRpcError(errorValue);
      if (player.destroyed || isStopping() || ["ABORTED", "CANCELLED"].includes(errorObject.code)) return;
      onDiagnostics({
        keyframeCount: player.keyframeTimes.length,
        quotaRetries: player.quotaRetries,
        quotaKeyframeRecoveries: player.quotaKeyframeRecoveries,
        quotaRestarts: player.quotaRestarts,
        lastQuotaRecovery: player.lastQuotaRecovery
      });
      if (isQuotaExceeded(errorValue) && typeof onQuotaExceeded === "function" && !player.recoveringQuota) {
        player.recoveringQuota = true;
        const recoveryState = {
          currentTime: Math.max(0, Number(embyVideo.currentTime) || 0),
          paused: embyVideo.paused,
          volume: embyVideo.volume,
          muted: embyVideo.muted
        };
        player.destroy();
        clearActivePlayer(player);
        void Promise.resolve(onQuotaExceeded(recoveryState)).catch((recoveryError) => {
          onFailure(toRpcError(recoveryError));
        });
        return;
      }
      onFailure(errorObject);
    };

    const pump = async (generation) => {
      while (!player.destroyed && generation === player.generation) {
        if (bufferAhead() >= maxForwardBufferSeconds) {
          await waitForDemand();
          continue;
        }
        const controller = new AbortController();
        player.controller = controller;
        let result;
        try {
          result = await rpc(`${rpcPrefix}.next`, {
            playbackId: playback.playbackId
          }, { timeoutMs: 45_000, signal: controller.signal });
        } finally {
          if (player.controller === controller) player.controller = null;
        }
        if (player.destroyed || generation !== player.generation) return;
        await evictBackBuffer();
        const grouped = new Map();
        for (const segment of result?.segments || []) {
          const list = grouped.get(segment.trackId) || [];
          list.push({
            bytes: decodeBase64(segment.data),
            // 兼容旧 daemon：旧响应没有字段时，每个响应项本来就是完整分片。
            segmentEnd: segment.segmentEnd !== false
          });
          grouped.set(segment.trackId, list);
        }
        await Promise.all([...grouped.entries()].map(async ([trackId, segments]) => {
          const sourceBuffer = player.sourceBuffers.get(trackId);
          if (!sourceBuffer) throw rpcError("MSE_TRACK_MISSING", `找不到媒体轨道 ${trackId}`);
          for (const segment of segments) {
            if (player.destroyed || generation !== player.generation) return;
            await append(trackId, sourceBuffer, segment.bytes, segment.segmentEnd);
          }
        }));
        if (player.destroyed || generation !== player.generation) return;
        await evictBackBuffer();
        if (!player.started && (bufferAhead() >= initialBufferTarget || result?.end)) {
          player.started = true;
          resolveInitialBuffer();
        }
        if (result?.end) {
          if (mediaSource.readyState === "open" && [...player.sourceBuffers.values()].every((buffer) => !buffer.updating)) {
            try { mediaSource.endOfStream(); } catch {}
          }
          return;
        }
        if (!result?.segments?.length) await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };

    const schedulePendingSeek = (delay = 120) => {
      clearTimeout(player.seekTimer);
      if (
        player.destroyed
        || player.pointerActive
        || player.seekInFlight
        || !Number.isFinite(player.pendingSeekTime)
      ) return;
      player.seekTimer = setTimeout(() => {
        player.seekTimer = null;
        if (player.destroyed || player.seekInFlight || !Number.isFinite(player.pendingSeekTime)) return;
        const time = player.pendingSeekTime;
        player.pendingSeekTime = null;
        player.seekInFlight = true;
        player.generation += 1;
        const generation = player.generation;
        player.controller?.abort();
        const controller = new AbortController();
        player.seekController = controller;
        void (async () => {
          try {
            const result = await rpc(`${rpcPrefix}.seek`, {
              playbackId: playback.playbackId,
              timeSeconds: time
            }, { timeoutMs: 45_000, signal: controller.signal });
            if (player.destroyed || generation !== player.generation) return;
            // 拖动期间目标又变化了：后端已恢复 ready，但不要为过时位置启动 pump。
            // finally 会在指针松开/防抖结束后串行提交最后一个目标。
            if (Number.isFinite(player.pendingSeekTime)) return;
            const timestampOffset = Number(result?.timestampOffsetSeconds);
            if (Number.isFinite(timestampOffset)) {
              for (const sourceBuffer of player.sourceBuffers.values()) {
                if (sourceBuffer.updating) await waitForUpdateEnd(sourceBuffer, () => {});
                sourceBuffer.timestampOffset = timestampOffset;
              }
            }
            if (player.destroyed || generation !== player.generation || Number.isFinite(player.pendingSeekTime)) return;
            void pump(generation).catch((errorValue) => {
              if (player.destroyed || generation !== player.generation) return;
              fail(errorValue);
            });
          } catch (errorValue) {
            const errorObject = toRpcError(errorValue);
            if (
              !player.destroyed
              && generation === player.generation
              && !isStopping()
              && !["ABORTED", "CANCELLED"].includes(errorObject.code)
            ) fail(errorObject);
          } finally {
            if (player.seekController === controller) player.seekController = null;
            player.seekInFlight = false;
            if (Number.isFinite(player.pendingSeekTime) && !player.pointerActive) schedulePendingSeek();
          }
        })();
      }, delay);
    };

    const seek = (time) => {
      if (player.destroyed) return;
      const target = Math.max(0, Number(time) || 0);
      clearTimeout(player.seekTimer);
      player.seekTimer = null;
      // 还没有后端 seek 时，落在已有缓冲里的原生跳转无需重启流；但若已有
      // seek 在途，最终目标即使碰巧落在旧缓冲中也必须排队，以重新同步后端位置。
      if (!player.seekInFlight && isBuffered(target)) {
        player.pendingSeekTime = null;
        return;
      }
      player.pendingSeekTime = target;
      // 原生 controls 会在按住滑块期间持续触发 seeking。pointerup 前只记最新位置，
      // 不启动 FFmpeg；键盘跳播没有 pointer 序列，仍由尾沿防抖提交。
      if (!player.pointerActive && !player.seekInFlight) schedulePendingSeek();
    };

    const onPointerDown = () => {
      player.pointerActive = true;
      player.pointerSawSeek = false;
      clearTimeout(player.seekTimer);
      player.seekTimer = null;
    };
    const onPointerFinished = () => {
      if (!player.pointerActive) return;
      const pointerSawSeek = player.pointerSawSeek;
      player.pointerActive = false;
      player.pointerSawSeek = false;
      // 浏览器在一次未完成的 seeking 状态中不保证为每次滑块位移都再次派发
      // seeking；松手时直接读取 currentTime，确保提交的是最终位置而非第一次位置。
      if (pointerSawSeek) seek(Number(embyVideo.currentTime) || 0);
      else if (Number.isFinite(player.pendingSeekTime)) schedulePendingSeek(0);
    };

    const onSeeking = () => {
      const time = Number(embyVideo.currentTime) || 0;
      if (player.pointerActive) player.pointerSawSeek = true;
      const initialSeekTarget = Number(player.initialSeekTarget);
      if (
        Number.isFinite(initialSeekTarget)
        && Math.abs(time - initialSeekTarget) <= bufferEdgeToleranceSeconds
      ) {
        // initialize/配额重建已经让后端 MP4Box seek 到这个关键帧。给 video 对齐
        // currentTime 会异步触发 seeking；若再次进入 RPC seek，就会 abort 刚启动的
        // .next 请求，表现成新 MediaSource 写完 init 后立刻“请求已取消”。
        player.initialSeekTarget = null;
        return;
      }
      player.initialSeekTarget = null;
      seek(time);
    };
    const onVideoError = () => fail(rpcError("MEDIA_DECODE_ERROR", "视频解码失败，当前编码可能不受支持"));
    // 卡顿看护：直连 MP4 走自研 MSE 管线，没有 hls.js 那样的内建 gap/nudge。
    // 当 <video> 触发 waiting/stalled 时，若播放头正好卡在一个已缓冲区间「之前」的极小空洞，
    // 就把 currentTime 微推过去（目标区间已缓冲，不会触发重连）；否则通过 seeking→seek
    // 让上层从当前位置重新拉流，避免画面永久冻结却无任何提示。
    let stallTimer = null;
    const onWaiting = () => {
      if (player.destroyed) return;
      const time = Number(embyVideo.currentTime) || 0;
      // 找到播放头右侧最近的缓冲区间；若与当前位置只差一个极小空洞，直接跳过去。
      for (let index = 0; index < embyVideo.buffered.length; index += 1) {
        const start = embyVideo.buffered.start(index);
        const end = embyVideo.buffered.end(index);
        if (start > time && start - time <= 0.5 && end - start > 0.1) {
          embyVideo.currentTime = start + 0.01;
          return;
        }
      }
      // 没有可跳的小空洞：给管线一点时间续上；持续卡住则从当前位置重连。
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        if (player.destroyed || embyVideo.paused) return;
        if (bufferAhead() < 0.5 && !player.controller && !player.seekInFlight) {
          seek(Number(embyVideo.currentTime) || 0);
        }
      }, 3_000);
    };
    const onPlaying = () => { clearTimeout(stallTimer); };
    player.destroy = () => {
      if (player.destroyed) return;
      player.destroyed = true;
      player.generation += 1;
      clearTimeout(player.seekTimer);
      clearTimeout(stallTimer);
      clearTimeout(player.initialBufferTimer);
      resolveInitialBuffer();
      player.controller?.abort();
      player.seekController?.abort();
      unlisten(embyVideo, "seeking", onSeeking);
      unlisten(embyVideo, "pointerdown", onPointerDown);
      unlisten(embyVideo, "pointerup", onPointerFinished);
      unlisten(embyVideo, "pointercancel", onPointerFinished);
      unlisten(embyVideo, "lostpointercapture", onPointerFinished);
      unlisten(window, "pointerup", onPointerFinished, true);
      unlisten(window, "pointercancel", onPointerFinished, true);
      unlisten(embyVideo, "error", onVideoError);
      unlisten(embyVideo, "waiting", onWaiting);
      unlisten(embyVideo, "stalled", onWaiting);
      unlisten(embyVideo, "playing", onPlaying);
      for (const sourceBuffer of player.sourceBuffers.values()) {
        try { if (sourceBuffer.updating) sourceBuffer.abort(); } catch {}
      }
      if (mediaSource.readyState === "open") {
        try { mediaSource.endOfStream(); } catch {}
      }
      if (embyVideo.src === objectUrl) embyVideo.removeAttribute("src");
      revokeObjectURL(objectUrl);
    };

    try {
      await waitForSourceOpen();
      // init RPC 挂到 player.controller：destroy 时统一 abort，
      // 避免 45s 长请求在播放器销毁后仍然悬着、迟到失败又触发上面的 catch。
      const initController = new AbortController();
      player.controller = initController;
      const initialization = await rpc(`${rpcPrefix}.init`, {
        playbackId: playback.playbackId
      }, { timeoutMs: 45_000, signal: initController.signal });
      if (player.controller === initController) player.controller = null;
      if (player.destroyed) return;
      player.keyframeTimes = Array.isArray(initialization?.keyframeTimesSeconds)
        ? initialization.keyframeTimesSeconds
          .map(Number)
          .filter((time) => Number.isFinite(time) && time >= 0)
          .sort((left, right) => left - right)
        : [];
      tuneBufferForKeyframes(initialization?.keyframeIntervalSeconds);
      for (const track of initialization?.tracks || []) {
        if (!MediaSource.isTypeSupported(track.mime)) {
          throw rpcError("MEDIA_CODEC_UNSUPPORTED", `当前 Renderer 不支持 ${track.codec || track.mime} 编码`);
        }
        const sourceBuffer = mediaSource.addSourceBuffer(track.mime);
        player.sourceBuffers.set(track.id, sourceBuffer);
        await append(track.id, sourceBuffer, decodeBase64(track.initData), true);
        const timestampOffset = Number(initialization?.timestampOffsetSeconds);
        if (Number.isFinite(timestampOffset)) sourceBuffer.timestampOffset = timestampOffset;
      }
      if (player.sourceBuffers.size === 0) throw rpcError("MSE_TRACK_MISSING", "媒体没有可播放的音视频轨道");
      const duration = Number(initialization?.durationSeconds);
      if (Number.isFinite(duration) && duration > 0) mediaSource.duration = duration;
      const initializedStartTime = Number(initialization?.startTimeSeconds);
      const requestedStartTime = Number(playback.startPositionTicks || 0) / 10_000_000;
      // MP4Box seek 会返回真实关键帧时间；优先采用它，不能把 video 强设回请求值
      // 落在首个可解码帧之前，否则同样会形成“当前时间略早于 buffered.start”的假空洞。
      const startTime = Number.isFinite(initializedStartTime) && initializedStartTime >= 0
        ? initializedStartTime
        : requestedStartTime;
      if (Number.isFinite(startTime) && startTime > 0) {
        player.initialSeekTarget = startTime;
        embyVideo.currentTime = startTime;
      }
      listen(embyVideo, "seeking", onSeeking);
      listen(embyVideo, "pointerdown", onPointerDown);
      listen(embyVideo, "pointerup", onPointerFinished);
      listen(embyVideo, "pointercancel", onPointerFinished);
      listen(embyVideo, "lostpointercapture", onPointerFinished);
      // UA 原生进度条通常会捕获指针；全局捕获监听作为滑块拖出 video 边界后的
      // 兜底，确保 pointerActive 不会卡死，播放器销毁时成对移除。
      listen(window, "pointerup", onPointerFinished, true);
      listen(window, "pointercancel", onPointerFinished, true);
      listen(embyVideo, "error", onVideoError);
      listen(embyVideo, "waiting", onWaiting);
      listen(embyVideo, "stalled", onWaiting);
      listen(embyVideo, "playing", onPlaying);
      let configurationComplete = false;
      void pump(player.generation).catch((errorValue) => {
        player.initialBufferFailure = errorValue;
        resolveInitialBuffer();
        if (configurationComplete) fail(errorValue);
      });
      if (initialBufferTarget > 0.5) {
        player.initialBufferTimer = setTimeout(resolveInitialBuffer, 20_000);
        await initialBufferReady;
        clearTimeout(player.initialBufferTimer);
        player.initialBufferTimer = null;
        if (player.destroyed) return;
        if (player.initialBufferFailure) throw player.initialBufferFailure;
        // 超时只表示链路暂时较慢，已有数据仍可播放；后续 pump 继续受动态
        // 字节预算约束，不会因等待首播而无限积累。
        player.started = true;
      }
      configurationComplete = true;
    } catch (errorValue) {
      player.destroy();
      // 只有自己仍是活动播放器时才清空：快速切换视频时新播放器已经挂上，
      // 旧播放器迟到的失败若无条件清空，会把新播放器从活动槽里抹掉，
      // 之后 teardown 销毁不到它（pump 泄漏、持续发 .next RPC）。
      clearActivePlayer(player);
      throw errorValue;
    }
  };

  return configureDirectMp4Stream;
}
