import { EmbyService } from "../../emby-service.mjs";
import { rpcError } from "../../platform/services/errors.mjs";

export const EMBY_OPERATIONS = Object.freeze([
  "connection.status", "auth.login", "auth.logout", "servers.list", "servers.switch", "servers.remove",
  "home.get", "library.get", "search", "series.get", "playback.open", "playback.progress", "playback.stop",
  "playback.direct.init", "playback.direct.next", "playback.direct.seek", "playback.subtitle.load", "playback.subtitle.select", "resource.load"
]);

export function createService({ embyService, logger = console } = {}) {
  const engine = embyService ?? new EmbyService({ logger });
  const owners = new Map();
  return {
    methods: Object.fromEntries(EMBY_OPERATIONS.map(operation => [operation, async (params, context) => {
      if (operation.startsWith("playback.") && operation !== "playback.open" && params.playbackId) {
        if (operation === "playback.stop" && !owners.has(params.playbackId)) return { playbackId: params.playbackId, stopped: false };
        if (!owners.has(params.playbackId) || owners.get(params.playbackId) !== context.targetId) throw rpcError("PLAYBACK_NOT_FOUND", "播放会话不属于当前卡片实例");
      }
      const result = await engine.handleRpc(operation, params, context);
      if (operation === "playback.open" && result?.playbackId) owners.set(result.playbackId, context.targetId);
      if (operation === "playback.stop" && result?.stopped) owners.delete(params.playbackId);
      return result;
    }])),
    aliases: Object.fromEntries(EMBY_OPERATIONS.map(operation => [operation, operation])),
    cleanupMethods: ["playback.stop"],
    async disposeTarget(targetId) {
      try { await engine.disposeTarget?.(targetId); }
      finally { for (const [id, owner] of owners) if (owner === targetId) owners.delete(id); }
    },
    async dispose() { try { await engine.dispose?.(); } finally { owners.clear(); } }
  };
}
