import Foundation

// 只运行纯逻辑及假依赖；不创建 App、真实 UserDefaults、SMAppService 或 CLI 进程。
@MainActor
private final class RegistrationFixture {
    var method: AgentInstallMethod?
    var state = AgentRegistrationState.notRegistered
    var plistExists = false
    var calls: [String] = []
    var registerFailure = false
    var installFailure = false
    var removalFailure = false
    var needsApproval = false

    lazy var registration = AgentRegistration(
        readMethod: { self.method }, writeMethod: { self.method = $0 },
        serviceState: { self.state }, fallbackExists: { self.plistExists },
        registerService: {
            self.calls.append("register")
            if self.needsApproval { self.state = .requiresApproval }
            if self.registerFailure { throw BackendError.commandFailed("模拟签名错误") }
            self.state = self.needsApproval ? .requiresApproval : .enabled
        },
        unregisterService: {
            self.calls.append("unregister")
            if self.removalFailure { throw BackendError.commandFailed("模拟停用错误") }
            self.state = .notRegistered
        },
        installCommand: {
            self.calls.append("install")
            self.plistExists = true
            if self.installFailure { throw BackendError.commandFailed("模拟 bootstrap 错误") }
        },
        uninstallCommand: {
            self.calls.append("uninstall")
            if self.removalFailure { throw BackendError.commandFailed("模拟 bootout 错误") }
            self.plistExists = false
        }
    )
}

@main
struct AgentSettingsTests {
    @MainActor static var checks = 0

    @MainActor static func check(_ condition: @autoclosure () -> Bool, _ message: String) {
        precondition(condition(), message)
        checks += 1
    }

    @MainActor static func expectFailure(_ action: () async throws -> Void) async {
        do {
            try await action()
            preconditionFailure("应报告失败，不能把命令完成当作业务成功")
        } catch { checks += 1 }
    }

    @MainActor static func main() async throws {
        // JSON 由 Node 测试调用 E 的 getAgentStatus 生成，避免双方字段发生漂移。
        let data = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
        let statuses = try JSONDecoder().decode([AgentStatus].self, from: data)
        check(statuses.count == 7, "状态场景数量")
        check(!statuses[0].available && statuses[0].pid == nil, "后台未运行")
        check(!statuses[0].codex.running && !statuses[0].shouldOfferRestart, "Codex 未运行不重启")
        check(statuses[1].available && statuses[1].codex.attached, "已连接")
        check(statuses[1].codex.port == 51234 && statuses[1].codex.proxyPort == 7890, "端口解码")
        check(!statuses[1].shouldOfferRestart, "已加载不重启")
        check(statuses[2].shouldOfferRestart, "普通实例需用户选择重启")
        check(!statuses[3].shouldOfferRestart, "未连接的自有调试实例不重启")
        check(!statuses[4].shouldOfferRestart, "外部调试实例保守跳过")
        check(!statuses[5].shouldOfferRestart && statuses[5].nativeHelper == "missing", "缺助手不能重启")
        check(!statuses[6].shouldOfferRestart, "后台尚未运行时不建议重启")
        check(statuses[1].lastEvent?.event == "attached" && statuses[1].lastEvent?.at == 1234, "事件解码")
        await expectFailure { _ = try JSONDecoder().decode(AgentStatus.self, from: Data("{}".utf8)) }
        await expectFailure { _ = try JSONDecoder().decode(AgentStatus.self, from: Data("log\n{}\n".utf8)) }
        let refusal = try JSONDecoder().decode(AgentRestartResult.self, from: Data("{\"stopped\":false,\"launched\":false,\"reason\":\"multiple-instances\"}".utf8))
        await expectFailure { try refusal.validate() }
        try JSONDecoder().decode(AgentRestartResult.self, from: Data("{\"stopped\":true,\"launched\":true,\"pid\":42}".utf8)).validate()
        checks += 1

        // 不调用 start；视图模型的注册依赖为 lazy，此处只验证状态文案。
        let model = CompanionViewModel()
        model.registrationState = .requiresApproval
        model.agentStatus = statuses[0]
        model.statusUnknown = false
        check(!model.autoLoadEnabled && model.statusTitle.contains("未启用（待批准）"), "待批准不冒充启用成功")
        check(model.statusTitle.contains("后台服务未运行") && model.statusTitle.contains("Codex 未运行"), "离线状态文案")
        model.registrationState = .enabled
        model.agentStatus = statuses[1]
        check(model.statusTitle.contains("自动加载已启用") && model.statusTitle.contains("Codex 已加载卡片"), "已连接状态文案")
        model.agentStatus = statuses[2]
        check(model.statusTitle.contains("Codex 未加载卡片"), "普通实例文案")
        model.statusUnknown = true
        check(model.statusTitle.contains("后台与卡片状态未知"), "读取失败不冒充离线")

        let resources = URL(fileURLWithPath: "/fixture/Test App.app/Contents/Resources")
        let bundled = resources.appendingPathComponent("codex-companion").path
        check(resolveBackendURL(resourcesURL: resources, developmentPath: "/dev/backend", isExecutable: { _ in true })?.path == bundled, "bundle 优先")
        check(resolveBackendURL(resourcesURL: resources, developmentPath: "/dev/backend", isExecutable: { $0 == "/dev/backend" })?.path == "/dev/backend", "开发回退")
        check(resolveBackendURL(resourcesURL: nil, developmentPath: nil, isExecutable: { _ in true }) == nil, "缺失路径")
        check(resolveBackendURL(resourcesURL: resources, developmentPath: "/dev/backend", isExecutable: { _ in false }) == nil, "不可执行文件不选择")
        check(parseProxyPort(" 7890\n") == 7890 && parseProxyPort("1") == 1 && parseProxyPort("65535") == 65535, "合法代理端口")
        for invalid in ["", "0", "65536", "-1", "+80", "1.5", "1e3", "１２３", "1 2"] {
            check(parseProxyPort(invalid) == nil, "拒绝非法代理端口")
        }
        let config = try JSONDecoder().decode(CompanionConfigFile.self, from: Data(#"{"version":2,"revision":8,"enabled":true,"placement":"standalone-button","cards":{},"order":[],"launch":{"proxy":{"enabled":true,"port":7891}},"agent":{"autoRelaunch":false},"futureField":42}"#.utf8))
        check(config.launch.proxy.enabled && config.launch.proxy.port == 7891 && config.revision == 8, "v2 launch.proxy 与未知字段兼容")

        let standard = RegistrationFixture()
        check(standard.registration.method == nil && standard.registration.state == .notRegistered, "首次安装")
        try await standard.registration.enable()
        check(standard.calls == ["register"] && standard.method == .serviceManagement, "优先 SM 且保存路径")
        check(standard.registration.state == .enabled, "SM 启用成功")
        try await standard.registration.enable()
        check(standard.calls == ["register"], "重复启用不重复注册")
        try await standard.registration.disable()
        check(standard.calls == ["register", "unregister"] && standard.method == nil, "同路径停用并清理选择")
        try await standard.registration.disable()
        check(standard.calls.count == 2, "已停用时幂等")

        for registerThrows in [false, true] {
            let pending = RegistrationFixture()
            pending.needsApproval = true
            pending.registerFailure = registerThrows
            try await pending.registration.enable()
            check(pending.registration.state == .requiresApproval && pending.method == .serviceManagement, "批准前不显示已启用")
            check(pending.calls == ["register"], "不通过 fallback 绕过系统批准")
            try await pending.registration.enable()
            check(pending.calls == ["register"], "等待批准时不重复 register")
            try await pending.registration.disable()
            check(pending.calls == ["register", "unregister"] && pending.method == nil, "可以取消待批准服务")
        }

        let fallback = RegistrationFixture()
        fallback.registerFailure = true
        try await fallback.registration.enable()
        check(fallback.calls == ["register", "install"] && fallback.method == .commandLine, "SM 抛错后 CLI 回退")
        try await fallback.registration.enable()
        check(fallback.calls == ["register", "install", "install"], "回退安装保持原路径")
        fallback.removalFailure = true
        await expectFailure { try await fallback.registration.disable() }
        check(fallback.method == .commandLine && fallback.plistExists, "CLI 停用失败保留路径与文件")
        fallback.removalFailure = false
        try await fallback.registration.disable()
        check(fallback.method == nil && !fallback.plistExists && !fallback.calls.contains("unregister"), "CLI 停用成功")

        let partial = RegistrationFixture()
        partial.registerFailure = true
        partial.installFailure = true
        await expectFailure { try await partial.registration.enable() }
        check(partial.method == .commandLine && partial.plistExists, "部分安装失败仍记录清理路径")
        try await partial.registration.disable()
        check(partial.calls == ["register", "install", "uninstall"], "部分安装也可以卸载")

        let serviceFailure = RegistrationFixture()
        serviceFailure.method = .serviceManagement
        serviceFailure.state = .enabled
        serviceFailure.removalFailure = true
        await expectFailure { try await serviceFailure.registration.disable() }
        check(serviceFailure.method == .serviceManagement && serviceFailure.calls == ["unregister"], "SM 停用错误不换路径")
        serviceFailure.state = .notFound
        await expectFailure { try await serviceFailure.registration.disable() }
        check(serviceFailure.method == .serviceManagement, "notFound 不等同于成功停用")
        serviceFailure.state = .notRegistered
        try await serviceFailure.registration.disable()
        check(serviceFailure.method == nil, "系统已明确注销可以清理记录")

        let recovered = RegistrationFixture()
        recovered.state = .enabled
        check(recovered.registration.method == .serviceManagement, "无 UserDefaults 时识别 SM 注册")
        recovered.state = .notRegistered
        recovered.plistExists = true
        check(recovered.registration.method == .commandLine, "无 UserDefaults 时识别旧 CLI plist")
        recovered.method = .commandLine
        recovered.state = .enabled
        check(recovered.registration.method == .commandLine, "停用优先遵守已记录路径")
        print("Swift agent checks: \(checks) passed")
    }
}
