import { CompanionConfig } from "./companion-config.mjs";
import { ServiceRegistry } from "./platform/services/registry.mjs";

// 保留旧构造注入边界，具体引擎与方法清单由各卡片 service entry 拥有。
export class CodexCompanionService {
  constructor({ configStore = new CompanionConfig(), openUrlImpl, logger = console, embyService, hongguoService, modules, manifests } = {}) {
    this.configStore = configStore;
    this.embyService = embyService;
    this.hongguoService = hongguoService;
    const loadConfig = () => typeof configStore.loadV2 === "function" ? configStore.loadV2() : configStore.load();
    this.registry = new ServiceRegistry({
      modules, manifests, loadConfig, logger,
      dependencies: { embyService, hongguoService, openUrlImpl, logger, loadConfig }
    });
  }

  handleRpc(method, params, context) { return this.registry.handleRpc(method, params, context); }
  openRiverclub() { return this.handleRpc("riverclub.open", {}); }
  applyConfig(config) { return this.registry.applyConfig(config); }
  disposeContext(targetId, executionContextId) { return this.registry.disposeContext(targetId, executionContextId); }
  disposeTarget(targetId) { return this.registry.disposeTarget(targetId); }
  dispose() { return this.registry.dispose(); }
}
