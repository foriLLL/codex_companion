import { HongguoService } from "../../hongguo-service.mjs";

export const HONGGUO_OPERATIONS = Object.freeze([
  "home", "feed.next", "list.get", "list.add", "list.remove", "detail", "image.load", "playback.open",
  "playback.direct.init", "playback.direct.next", "playback.direct.seek", "playback.stop"
]);

export function createService({ hongguoService } = {}) {
  const engine = hongguoService ?? new HongguoService();
  return {
    methods: Object.fromEntries(HONGGUO_OPERATIONS.map(operation => [operation, (params, context) => engine.handleRpc(`hongguo.${operation}`, params, context)])),
    cleanupMethods: ["playback.stop"],
    disposeTarget: targetId => engine.disposeTarget?.(targetId),
    dispose: () => engine.dispose?.()
  };
}
