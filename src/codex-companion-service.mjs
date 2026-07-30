import { EmbyService } from "./emby-service.mjs";
import { HongguoService } from "./hongguo-service.mjs";

export class CodexCompanionService {
  constructor({ logger = console, embyService = new EmbyService({ logger }), hongguoService = new HongguoService() } = {}) {
    this.embyService = embyService;
    this.hongguoService = hongguoService;
  }

  handleRpc(method, params, context) {
    return method.startsWith("hongguo.")
      ? this.hongguoService.handleRpc(method, params, context)
      : this.embyService.handleRpc(method, params, context);
  }

  async disposeTarget(targetId) {
    await Promise.allSettled([
      this.hongguoService.disposeTarget?.(targetId),
      this.embyService.disposeTarget?.(targetId)
    ]);
  }

  async dispose() {
    const results = await Promise.allSettled([
      this.hongguoService.dispose?.(),
      this.embyService.dispose?.()
    ]);
    const failure = results.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
  }
}
