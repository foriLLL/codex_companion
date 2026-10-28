import AppKit
import ServiceManagement
import SwiftUI
import UniformTypeIdentifiers

// 目录和配置都由后端 CLI 提供，新增内置卡片无需修改 Swift。
struct CardDescriptor: Identifiable, Decodable {
    let id: String
    let title: String
    let defaultEnabled: Bool
}

struct AgentStatus: Decodable {
    struct Codex: Decodable {
        let running: Bool
        let pid: Int?
        let attached: Bool
        let port: Int?
        let proxyPort: Int?
    }
    struct Event: Decodable { let event: String; let at: Double }
    let available: Bool
    let version: String
    let pid: Int?
    let autoRelaunch: Bool
    let codex: Codex
    let lastEvent: Event?
    let nativeHelper: String

    // status 未暴露调试地址；已有端口时不猜测实例归属，也不建议重启。
    var shouldOfferRestart: Bool {
        available && codex.running && !codex.attached && codex.port == nil && nativeHelper == "ok"
    }
}

struct CardConfig: Decodable {
    var enabled: Bool
}

struct CompanionConfigFile: Decodable {
    struct Launch: Decodable {
        struct Proxy: Decodable { let enabled: Bool; let port: Int }
        let proxy: Proxy
    }
    var version: Int
    var revision: Int
    var enabled: Bool
    var placement: String
    var cards: [String: CardConfig]
    var order: [String]
    var launch: Launch
}

struct BackendFailure: Decodable {
    struct Detail: Decodable { let code: String; let message: String }
    let error: Detail
}

struct AgentInstallResult: Decodable { let installed: Bool }
struct AgentUninstallResult: Decodable { let uninstalled: Bool; let unmountError: String? }
struct AgentRestartResult: Decodable {
    let launched: Bool
    let reason: String?
    let message: String?

    func validate() throws {
        guard launched else {
            throw BackendError.commandFailed(message ?? "未能重启 Codex：\(reason ?? "未知原因")")
        }
    }
}

// 路径选择保持纯逻辑，测试不读取真实 bundle 或用户目录。
func resolveBackendURL(resourcesURL: URL?, developmentPath: String?, isExecutable: (String) -> Bool) -> URL? {
    if let bundled = resourcesURL?.appendingPathComponent("codex-companion"), isExecutable(bundled.path) {
        return bundled
    }
    if let developmentPath, isExecutable(developmentPath) { return URL(fileURLWithPath: developmentPath) }
    return nil
}

func parseProxyPort(_ text: String) -> Int? {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty, trimmed.allSatisfy({ $0.isASCII && $0.isNumber }),
          let port = Int(trimmed), (1...65_535).contains(port) else { return nil }
    return port
}

// MARK: - 后端桥（调 Resources/codex-companion 子命令、读写共享配置文件）

enum BackendError: LocalizedError {
    case binaryMissing
    case commandFailed(String)
    case conflict

    var errorDescription: String? {
        switch self {
        case .binaryMissing:
            return "找不到 codex-companion 后端，请重新安装。"
        case .conflict:
            return "配置已在其他窗口更新，正在刷新。"
        case .commandFailed(let message):
            return message
        }
    }
}

final class CompanionBackend {
    static let shared = CompanionBackend()

    private var binaryURL: URL? {
        resolveBackendURL(resourcesURL: Bundle.main.resourceURL,
                          developmentPath: ProcessInfo.processInfo.environment["CODEX_COMPANION_BACKEND"],
                          isExecutable: FileManager.default.isExecutableFile(atPath:))
    }

    private func backendEnvironment() -> [String: String] {
        var environment = ProcessInfo.processInfo.environment
        if let ffmpeg = Bundle.main.resourceURL?.appendingPathComponent("ffmpeg"),
           FileManager.default.isExecutableFile(atPath: ffmpeg.path) {
            environment["CODEX_COMPANION_FFMPEG"] = ffmpeg.path
        }
        return environment
    }

    /// 所有短命令在后台队列执行；共享输出管道避免 stdout/stderr 相互阻塞。
    private func run(_ arguments: [String], input: Data? = nil) async throws -> Data {
        guard let binary = binaryURL else { throw BackendError.binaryMissing }
        let environment = backendEnvironment()
        return try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                do {
                    let process = Process()
                    process.executableURL = binary
                    process.arguments = arguments
                    process.environment = environment
                    let output = Pipe()
                    let stdinPipe = Pipe()
                    process.standardOutput = output
                    process.standardError = output
                    process.standardInput = stdinPipe
                    try process.run()
                    if let input { try stdinPipe.fileHandleForWriting.write(contentsOf: input) }
                    try stdinPipe.fileHandleForWriting.close()
                    let data = output.fileHandleForReading.readDataToEndOfFile()
                    process.waitUntilExit()
                    guard process.terminationStatus == 0 else {
                        if let failure = try? JSONDecoder().decode(BackendFailure.self, from: data) {
                            if failure.error.code == "CONFIG_CONFLICT" { throw BackendError.conflict }
                            throw BackendError.commandFailed(failure.error.message)
                        }
                        throw BackendError.commandFailed(String(data: data, encoding: .utf8) ?? "后端命令失败")
                    }
                    continuation.resume(returning: data)
                } catch { continuation.resume(throwing: error) }
            }
        }
    }

    func status() async throws -> AgentStatus {
        try JSONDecoder().decode(AgentStatus.self, from: await run(["agent", "status"]))
    }

    func installAgent() async throws {
        let result = try JSONDecoder().decode(AgentInstallResult.self, from: await run(["agent", "install"]))
        guard result.installed else { throw BackendError.commandFailed("后台服务安装失败。") }
    }

    func uninstallAgent() async throws {
        let result = try JSONDecoder().decode(AgentUninstallResult.self, from: await run(["agent", "uninstall"]))
        guard result.uninstalled else { throw BackendError.commandFailed("后台服务停用失败。") }
        if let error = result.unmountError {
            throw BackendError.commandFailed("后台服务已停用，但卡片未完全移除：\(error)。可重试停用。")
        }
    }

    func restartCodex() async throws {
        let result = try JSONDecoder().decode(AgentRestartResult.self, from: await run(["agent", "restart-codex"]))
        try result.validate()
    }

    func catalog() async throws -> [CardDescriptor] {
        try JSONDecoder().decode([CardDescriptor].self, from: await run(["cards", "list"]))
    }

    func loadConfig() async throws -> CompanionConfigFile {
        try JSONDecoder().decode(CompanionConfigFile.self, from: await run(["config", "get"]))
    }

    func patchConfig(_ patch: [String: Any], expectedRevision: Int) async throws -> CompanionConfigFile {
        let data = try JSONSerialization.data(withJSONObject: ["expectedRevision": expectedRevision, "patch": patch])
        return try JSONDecoder().decode(CompanionConfigFile.self, from: await run(["config", "patch"], input: data))
    }

}

// MARK: - 自动加载注册（依赖可替换；测试不调用 ServiceManagement 或 CLI）

enum AgentInstallMethod: String { case serviceManagement, commandLine }
enum AgentRegistrationState { case enabled, requiresApproval, notRegistered, notFound }

@MainActor
final class AgentRegistration {
    static let defaultsKey = "agentInstallMethod"
    private let readMethod: () -> AgentInstallMethod?
    private let writeMethod: (AgentInstallMethod?) -> Void
    private let serviceState: () -> AgentRegistrationState
    private let fallbackExists: () -> Bool
    private let registerService: () throws -> Void
    private let unregisterService: () async throws -> Void
    private let installCommand: () async throws -> Void
    private let uninstallCommand: () async throws -> Void

    init(readMethod: @escaping () -> AgentInstallMethod?, writeMethod: @escaping (AgentInstallMethod?) -> Void,
         serviceState: @escaping () -> AgentRegistrationState, fallbackExists: @escaping () -> Bool,
         registerService: @escaping () throws -> Void, unregisterService: @escaping () async throws -> Void,
         installCommand: @escaping () async throws -> Void, uninstallCommand: @escaping () async throws -> Void) {
        self.readMethod = readMethod
        self.writeMethod = writeMethod
        self.serviceState = serviceState
        self.fallbackExists = fallbackExists
        self.registerService = registerService
        self.unregisterService = unregisterService
        self.installCommand = installCommand
        self.uninstallCommand = uninstallCommand
    }

    var method: AgentInstallMethod? {
        if let saved = readMethod() { return saved }
        if serviceState() == .enabled || serviceState() == .requiresApproval { return .serviceManagement }
        return fallbackExists() ? .commandLine : nil
    }

    var state: AgentRegistrationState {
        switch method {
        case .serviceManagement: return serviceState()
        case .commandLine: return fallbackExists() ? .enabled : .notRegistered
        case nil: return .notRegistered
        }
    }

    func enable() async throws {
        // 保持既有安装路径，避免重复注册同一个 label。
        if method == .commandLine {
            writeMethod(.commandLine)
            try await installCommand()
            return
        }
        if serviceState() == .enabled || serviceState() == .requiresApproval {
            writeMethod(.serviceManagement)
            return
        }
        do {
            try registerService()
        } catch {
            // 系统已经登记但等待批准时，不能通过 fallback 绕过用户的登录项选择。
            if serviceState() == .enabled || serviceState() == .requiresApproval {
                writeMethod(.serviceManagement)
                return
            }
            // CLI 可能在写 plist 后 bootstrap 失败；提前记住路径，便于停用时清理。
            writeMethod(.commandLine)
            try await installCommand()
            return
        }
        writeMethod(.serviceManagement)
        guard state == .enabled || state == .requiresApproval else {
            throw BackendError.commandFailed("系统未确认自动加载注册，请重试。")
        }
    }

    func disable() async throws {
        switch method {
        case .serviceManagement:
            if serviceState() != .notRegistered {
                try await unregisterService()
            }
        case .commandLine: try await uninstallCommand()
        case nil: break
        }
        // 失败时保留选择，下一次停用仍走原路径。
        writeMethod(nil)
    }

    static func live(backend: CompanionBackend, defaults: UserDefaults = .standard) -> AgentRegistration {
        let service = SMAppService.agent(plistName: "com.codexcompanion.agent.plist")
        let plist = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/com.codexcompanion.agent.plist")
        return AgentRegistration(
            readMethod: { defaults.string(forKey: defaultsKey).flatMap(AgentInstallMethod.init(rawValue:)) },
            writeMethod: { method in
                if let method { defaults.set(method.rawValue, forKey: defaultsKey) }
                else { defaults.removeObject(forKey: defaultsKey) }
            },
            serviceState: {
                switch service.status {
                case .enabled: return .enabled
                case .requiresApproval: return .requiresApproval
                case .notRegistered: return .notRegistered
                case .notFound: return .notFound
                @unknown default: return .notFound
                }
            },
            fallbackExists: { FileManager.default.fileExists(atPath: plist.path) },
            registerService: { try service.register() },
            unregisterService: { try await service.unregister() },
            installCommand: { try await backend.installAgent() },
            uninstallCommand: { try await backend.uninstallAgent() }
        )
    }
}

// MARK: - 视图模型

@MainActor
final class CompanionViewModel: ObservableObject {
    @Published var injectionEnabled = true      // 注入总开关（mount/unmount）
    @Published var cardEnabled: [String: Bool] = [:]
    @Published var cardOrder: [String] = []
    @Published var cardCatalog: [CardDescriptor] = []
    @Published var configReady = false
    @Published var draggingCardId: String?
    @Published var standalonePlacement = true   // true=独立按钮；false=随 Summary 显示
    @Published var proxyEnabled = false
    @Published var proxyPort = "7890"
    @Published var agentStatus: AgentStatus?
    @Published var registrationState = AgentRegistrationState.notRegistered
    @Published var busy = false
    @Published var saving = false
    @Published var statusUnknown = true
    @Published var errorMessage: String?

    private let backend = CompanionBackend.shared
    private lazy var registration = AgentRegistration.live(backend: backend)
    private var pollTimer: Timer?
    private var config: CompanionConfigFile?
    private var pendingPatches: [[String: Any]] = []
    private var refreshing = false
    private var promptAfterEnable = false

    var autoLoadEnabled: Bool { registrationState == .enabled && agentStatus?.autoRelaunch != false }
    var requiresApproval: Bool { registrationState == .requiresApproval }
    var statusTitle: String {
        let loading = requiresApproval ? "自动加载未启用（待批准）" : autoLoadEnabled ? "自动加载已启用" : "自动加载未启用"
        guard !statusUnknown, let status = agentStatus else { return "\(loading) · 后台与卡片状态未知" }
        let service = status.available ? "后台服务运行中" : "后台服务未运行"
        let cards = !status.codex.running ? "Codex 未运行" : status.codex.attached ? "Codex 已加载卡片" : "Codex 未加载卡片"
        return "\(loading) · \(service) · \(cards)"
    }

    func start() {
        guard pollTimer == nil else { return }
        registrationState = registration.state
        promptAfterEnable = requiresApproval
        Task {
            do {
                cardCatalog = try await backend.catalog()
                apply(try await backend.loadConfig())
                configReady = true
            } catch { errorMessage = error.localizedDescription }
        }
        refreshStatus()
        pollTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refreshStatus() }
        }
    }

    private func apply(_ value: CompanionConfigFile) {
        config = value
        injectionEnabled = value.enabled
        standalonePlacement = value.placement != "inline-in-summary"
        cardEnabled = value.cards.mapValues { $0.enabled }
        proxyEnabled = value.launch.proxy.enabled
        proxyPort = String(value.launch.proxy.port)
        let ids = Set(cardCatalog.map(\.id))
        cardOrder = value.order.filter { ids.contains($0) }
    }

    func cardTitle(_ id: String) -> String { cardCatalog.first { $0.id == id }?.title ?? id }

    func stop() {
        pollTimer?.invalidate()
        pollTimer = nil
    }

    func refreshStatus() {
        guard !refreshing, !busy else { return }
        registrationState = registration.state
        refreshing = true
        Task {
            defer { refreshing = false }
            do {
                let status = try await backend.status()
                guard !busy else { return }
                registrationState = registration.state
                agentStatus = status
                statusUnknown = false
                if promptAfterEnable && autoLoadEnabled && status.available {
                    promptAfterEnable = false
                    if status.shouldOfferRestart { confirmRestart() }
                }
            } catch {
                statusUnknown = true
            }
        }
    }

    func cardBinding(_ id: String) -> Binding<Bool> {
        Binding(get: { self.cardEnabled[id] ?? false }, set: { value in
            self.cardEnabled[id] = value
            self.enqueue(["cards": [id: ["enabled": value]]])
        })
    }

    var enabledBinding: Binding<Bool> {
        Binding(get: { self.injectionEnabled }, set: { value in
            self.injectionEnabled = value
            self.enqueue(["enabled": value])
        })
    }

    var placementBinding: Binding<Bool> {
        Binding(get: { self.standalonePlacement }, set: { value in
            self.standalonePlacement = value
            self.enqueue(["placement": value ? "standalone-button" : "inline-in-summary"])
        })
    }

    var proxyBinding: Binding<Bool> {
        Binding(get: { self.proxyEnabled }, set: { value in
            self.proxyEnabled = value
            self.enqueue(["launch": ["proxy": ["enabled": value]]])
        })
    }

    func saveProxyPort() {
        guard let port = parseProxyPort(proxyPort) else {
            errorMessage = "代理端口请输入 1–65535 的整数。"
            return
        }
        enqueue(["launch": ["proxy": ["port": port]]])
    }

    func persistOrder() {
        let known = Set(cardCatalog.map(\.id))
        enqueue(["order": cardOrder + (config?.order.filter { !known.contains($0) } ?? [])])
    }

    private func enqueue(_ patch: [String: Any]) {
        guard configReady else { return }
        pendingPatches.append(patch)
        guard !saving else { return }
        saving = true
        Task {
            defer { saving = false }
            while !pendingPatches.isEmpty {
                let next = pendingPatches.removeFirst()
                do {
                    let updated = try await savePatch(next)
                    config = updated
                    if pendingPatches.isEmpty { apply(updated) }
                    errorMessage = nil
                } catch {
                    pendingPatches.removeAll()
                    if let latest = try? await backend.loadConfig() { apply(latest) }
                    errorMessage = "保存配置失败：\(error.localizedDescription)"
                }
            }
        }
    }

    private func savePatch(_ patch: [String: Any]) async throws -> CompanionConfigFile {
        let current: CompanionConfigFile
        if let config { current = config }
        else { current = try await backend.loadConfig() }
        do {
            return try await backend.patchConfig(patch, expectedRevision: current.revision)
        } catch BackendError.conflict {
            let latest = try await backend.loadConfig()
            return try await backend.patchConfig(patch, expectedRevision: latest.revision)
        }
    }

    func enableAutoLoad() {
        guard !busy, !saving else { return }
        busy = true
        errorMessage = nil
        Task {
            defer {
                registrationState = registration.state
                busy = false
                refreshStatus()
            }
            do {
                apply(try await savePatch(["agent": ["autoRelaunch": true]]))
                try await registration.enable()
                promptAfterEnable = true
            } catch { errorMessage = error.localizedDescription }
        }
    }

    func disableAutoLoad(uninstall: Bool = false) {
        guard !busy, !saving else { return }
        busy = true
        errorMessage = nil
        promptAfterEnable = false
        Task {
            defer {
                registrationState = registration.state
                busy = false
                refreshStatus()
            }
            do {
                try await registration.disable()
                if uninstall {
                    let alert = NSAlert()
                    alert.messageText = "Companion 已停用"
                    alert.informativeText = "现在可以将 Codex Companion App 移到废纸篓。配置保留在 ~/Library/Application Support/codex-companion。"
                    alert.addButton(withTitle: "知道了")
                    alert.runModal()
                }
            } catch { errorMessage = error.localizedDescription }
        }
    }

    private func confirmRestart() {
        let alert = NSAlert()
        alert.messageText = "重启 Codex 以加载卡片？"
        alert.informativeText = "将正常退出并重新打开 Codex，未保存的输入可能丢失。也可以等下次启动时生效。"
        alert.alertStyle = .warning
        alert.addButton(withTitle: "立即重启 Codex 以启用")
        alert.addButton(withTitle: "下次启动时生效")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        busy = true
        Task {
            defer { busy = false; refreshStatus() }
            do { try await backend.restartCodex() }
            catch { errorMessage = error.localizedDescription }
        }
    }
}

// MARK: - 界面

struct ContentView: View {
    @StateObject private var model = CompanionViewModel()
    @State private var showBackupSettings = false

    var body: some View {
        Form {
            Section {
                Text(model.statusTitle)
                    .font(.callout)
                    .accessibilityLabel(model.statusTitle)
                HStack {
                    Button(model.autoLoadEnabled || model.requiresApproval ? "停用自动加载" : "启用自动加载") {
                        if model.autoLoadEnabled || model.requiresApproval { model.disableAutoLoad() }
                        else { model.enableAutoLoad() }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(model.busy || model.saving)
                    Button("卸载 Companion") { model.disableAutoLoad(uninstall: true) }
                        .disabled(model.busy || model.saving)
                    if model.busy { ProgressView().controlSize(.small) }
                }
                Text("启用一次后，直接打开 Codex 即可。日常设置在 Codex 卡片区的齿轮中。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if model.requiresApproval {
                    Text("请到「系统设置 › 通用 › 登录项」批准自动加载。")
                        .font(.caption)
                    Button("打开登录项设置") { SMAppService.openSystemSettingsLoginItems() }
                }
                if model.statusUnknown {
                    Button("重试读取状态") { model.refreshStatus() }.disabled(model.busy)
                } else if model.agentStatus?.nativeHelper == "missing" {
                    Text("原生助手缺失，请重新安装 Companion。")
                        .font(.caption)
                        .foregroundStyle(.red)
                }
            }

            Section {
                DisclosureGroup("备用设置", isExpanded: $showBackupSettings) {
                    backupSettings
                }
            }
            if let message = model.errorMessage {
                Section {
                    Text(message)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .formStyle(.grouped)
        .padding(12)
        .frame(width: 620, height: showBackupSettings ? 680 : 300)
        .onAppear { model.start() }
        .onDisappear { model.stop() }
    }

    private var backupSettings: some View {
        VStack(alignment: .leading, spacing: 12) {
            Toggle("启用注入卡片", isOn: model.enabledBinding)
            ForEach(model.cardOrder, id: \.self) { cardId in
                HStack(spacing: 10) {
                    Image(systemName: "line.3.horizontal").foregroundStyle(.tertiary)
                    Text(model.cardTitle(cardId))
                    Spacer()
                    Toggle("启用\(model.cardTitle(cardId))", isOn: model.cardBinding(cardId)).labelsHidden()
                }
                .padding(.vertical, 2)
                .contentShape(Rectangle())
                .onDrag {
                    model.draggingCardId = cardId
                    return NSItemProvider(object: cardId as NSString)
                }
                .onDrop(of: [UTType.text], delegate: CardReorderDropDelegate(
                    target: cardId, order: $model.cardOrder, draggingId: $model.draggingCardId,
                    persist: model.persistOrder
                ))
            }
            .disabled(!model.injectionEnabled)
            Text("拖动 ≡ 调整卡片顺序；卡片与显示方式的改动实时生效。")
                .font(.caption).foregroundStyle(.secondary)
            Picker("显示方式", selection: model.placementBinding) {
                Text("独立浮层").tag(true)
                Text("随 Summary").tag(false)
            }
            .pickerStyle(.segmented)
            .disabled(!model.injectionEnabled)
            Divider()
            Toggle("通过代理启动", isOn: model.proxyBinding)
            HStack {
                Text("代理端口")
                TextField("7890", text: $model.proxyPort)
                    .frame(width: 80)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { model.saveProxyPort() }
                    .accessibilityLabel("本机代理端口")
                Button("保存端口") { model.saveProxyPort() }
            }
            .disabled(!model.proxyEnabled)
            Text("代理设置在重启 Codex 后生效。")
                .font(.caption).foregroundStyle(.secondary)
        }
        .padding(.top, 8)
        .disabled(!model.configReady || model.busy || model.saving)
    }
}

// 拖拽排序：onDrag 记下当前拖动的卡片，进入目标行时移动，落下时持久化。
private struct CardReorderDropDelegate: DropDelegate {
    let target: String
    @Binding var order: [String]
    @Binding var draggingId: String?
    let persist: () -> Void

    func dropEntered(info: DropInfo) {
        guard let draggingId,
              draggingId != target,
              let from = order.firstIndex(of: draggingId),
              let to = order.firstIndex(of: target) else { return }
        withAnimation(.easeInOut(duration: 0.15)) {
            order.move(fromOffsets: IndexSet(integer: from), toOffset: to > from ? to + 1 : to)
        }
    }

    func dropUpdated(info: DropInfo) -> DropProposal? {
        DropProposal(operation: .move)
    }

    func performDrop(info: DropInfo) -> Bool {
        draggingId = nil
        persist()
        return true
    }
}


// MARK: - App 入口

#if !COMPANION_TESTING
@main
struct CodexCompanionApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        WindowGroup("Codex Companion") {
            ContentView()
        }
        .windowResizability(.contentSize)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.activate(ignoringOtherApps: true)
        // 只展示引导；启用服务前不操作 Codex。
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        // 关窗即退出设置；后台服务由系统独立管理。
        true
    }
}
#endif
