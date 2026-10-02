import AppKit
import SwiftUI
import UniformTypeIdentifiers

// 目录和配置都由后端 CLI 提供，新增内置卡片无需修改 Swift。
struct CardDescriptor: Identifiable, Decodable {
    let id: String
    let title: String
    let defaultEnabled: Bool
}

struct CompanionStatus: Decodable {
    var statusError: Bool?
    var codexRunning: Bool
    var hasCdpFlag: Bool
    var codexPids: [Int]
    var port: Int?
    var daemonPid: Int?
}

struct CardConfig: Decodable {
    var enabled: Bool
}

struct CompanionConfigFile: Decodable {
    var version: Int
    var revision: Int
    var enabled: Bool
    var placement: String
    var cards: [String: CardConfig]
    var order: [String]
}

struct BackendFailure: Decodable {
    struct Detail: Decodable { let code: String; let message: String }
    let error: Detail
}

struct StopResult: Decodable {
    var stopped: Bool
    var reason: String
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
        if let bundled = Bundle.main.resourceURL?.appendingPathComponent("codex-companion"),
           FileManager.default.isExecutableFile(atPath: bundled.path) {
            return bundled
        }
        // 开发态回退：swift run 时无 bundle 资源，用环境变量指向仓库里的二进制
        if let dev = ProcessInfo.processInfo.environment["CODEX_COMPANION_BACKEND"],
           FileManager.default.isExecutableFile(atPath: dev) {
            return URL(fileURLWithPath: dev)
        }
        return nil
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

    func status() async throws -> CompanionStatus {
        try JSONDecoder().decode(CompanionStatus.self, from: await run(["status"]))
    }

    func stopCodex() async throws -> StopResult {
        try JSONDecoder().decode(StopResult.self, from: await run(["stop-codex"]))
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

    private(set) var launchedProcess: Process?

    /// 启动 Codex + 常驻注入维护。launch 是长驻进程，不等待退出；输出写入日志文件。
    func launchDetached(proxyPort: Int? = nil) throws {
        guard let binary = binaryURL else { throw BackendError.binaryMissing }
        let logDirectory = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs/Codex Companion")
        try? FileManager.default.createDirectory(
            at: logDirectory,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        let logURL = logDirectory.appendingPathComponent("launcher.log")
        // 日志会记录临时 CDP 端口等信息；限制为仅本用户可读写（0600），
        // 避免同机其他用户读取端口后连上无鉴权的 CDP 调试端点。
        if !FileManager.default.fileExists(atPath: logURL.path) {
            FileManager.default.createFile(
                atPath: logURL.path,
                contents: nil,
                attributes: [.posixPermissions: 0o600]
            )
        } else {
            // 收紧旧版本可能以默认 0644 创建的日志文件。
            try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: logURL.path)
        }

        let process = Process()
        process.executableURL = binary
        process.arguments = ["launch"] + (proxyPort.map { ["--proxy-port", String($0)] } ?? [])
        process.environment = backendEnvironment()
        if let logHandle = try? FileHandle(forWritingTo: logURL) {
            logHandle.seekToEndOfFile()
            process.standardOutput = logHandle
            process.standardError = logHandle
        }
        try process.run()
        // 不 waitUntilExit：launch 常驻。保留引用避免被提前回收。
        launchedProcess = process
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
    @Published var codexRunning = false
    @Published var hasCdpFlag = false
    @Published var port: Int?
    @Published var busy = false
    @Published var statusUnknown = false
    @Published var errorMessage: String?

    private let backend = CompanionBackend.shared
    private var pollTimer: Timer?
    private var config: CompanionConfigFile?
    private var pendingPatches: [[String: Any]] = []
    private var saving = false
    private var refreshing = false

    func start() {
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
        let ids = Set(cardCatalog.map(\.id))
        cardOrder = value.order.filter { ids.contains($0) }
    }

    func cardTitle(_ id: String) -> String { cardCatalog.first { $0.id == id }?.title ?? id }

    func stop() {
        pollTimer?.invalidate()
        pollTimer = nil
    }

    func refreshStatus() {
        guard !refreshing else { return }
        refreshing = true
        let backend = self.backend
        Task {
            defer { refreshing = false }
            let status = try? await backend.status()
            await MainActor.run {
                guard let status else {
                    // 连 status 命令都跑不起来：标记未知，不误判为「未运行」。
                    self.statusUnknown = true
                    return
                }
                // ps 扫描失败时后端置 statusError=true；此时进程状态不可信，显示未知。
                if status.statusError == true {
                    self.statusUnknown = true
                    return
                }
                self.statusUnknown = false
                self.codexRunning = status.codexRunning
                self.hasCdpFlag = status.hasCdpFlag
                self.port = status.port
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
                    guard let current = config else { break }
                    let updated: CompanionConfigFile
                    do {
                        updated = try await backend.patchConfig(next, expectedRevision: current.revision)
                    } catch BackendError.conflict {
                        let latest = try await backend.loadConfig()
                        config = latest
                        updated = try await backend.patchConfig(next, expectedRevision: latest.revision)
                    }
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

    func launchCodex(proxyPort portText: String? = nil) {
        var proxyPort: Int?
        if let portText {
            let trimmed = portText.trimmingCharacters(in: .whitespacesAndNewlines)
            guard let port = Int(trimmed), (1...65_535).contains(port) else {
                errorMessage = "代理端口请输入 1–65535 的整数。"
                return
            }
            proxyPort = port
        }
        busy = true
        errorMessage = nil
        let backend = self.backend
        Task.detached {
            do {
                try backend.launchDetached(proxyPort: proxyPort)
            } catch {
                await MainActor.run { self.errorMessage = error.localizedDescription }
            }
            // 给 Codex 一点启动时间再刷新状态
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            await MainActor.run {
                self.busy = false
                self.refreshStatus()
            }
        }
    }

    /// 停止 Codex：先弹确认（温和退出 + 确认），确认后 SIGTERM，绝不强杀。
    func confirmAndStopCodex() {
        let alert = NSAlert()
        alert.messageText = "停止 Codex？"
        alert.informativeText = "将温和退出 Codex（等同于正常退出）。如果 Codex 正在执行任务，任务会被中断。"
        alert.alertStyle = .warning
        alert.addButton(withTitle: "停止")
        alert.addButton(withTitle: "取消")
        guard alert.runModal() == .alertFirstButtonReturn else { return }

        busy = true
        errorMessage = nil
        let backend = self.backend
        Task.detached {
            do {
                _ = try await backend.stopCodex()
            } catch {
                await MainActor.run { self.errorMessage = error.localizedDescription }
            }
            await MainActor.run {
                self.busy = false
                self.refreshStatus()
            }
        }
    }
}

// MARK: - 界面

struct ContentView: View {
    @StateObject private var model = CompanionViewModel()
    @AppStorage("launchThroughProxy") private var launchThroughProxy = false
    @AppStorage("launchProxyPort") private var launchProxyPort = "7890"

    var body: some View {
        Form {
            // 状态区
            Section {
                HStack(spacing: 10) {
                    Circle()
                        .fill(statusColor)
                        .frame(width: 10, height: 10)
                    Text(statusTitle)
                        .font(.headline)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer()
                    statusButton
                    if model.busy {
                        ProgressView().controlSize(.small)
                    }
                }
                .padding(.vertical, 4)
                HStack(spacing: 10) {
                    Toggle("通过代理启动", isOn: $launchThroughProxy)
                        .toggleStyle(.checkbox)
                    if launchThroughProxy {
                        Text("端口")
                        TextField("7890", text: $launchProxyPort)
                            .frame(width: 72)
                            .textFieldStyle(.roundedBorder)
                            .accessibilityLabel("本机代理端口")
                    }
                }
                .disabled(model.busy || model.codexRunning)
                Text("代理仅对新启动的 Codex 生效；已运行时需先退出再启动。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            // 卡片区：总开关 + 可拖拽排序的卡片行（为以后更多卡片设计）
            Section {
                Toggle("启用注入卡片", isOn: model.enabledBinding)
                    .disabled(!model.configReady)

                ForEach(model.cardOrder, id: \.self) { cardId in
                    HStack(spacing: 10) {
                        Image(systemName: "line.3.horizontal")
                            .foregroundStyle(.tertiary)
                        Text(model.cardTitle(cardId))
                        Spacer()
                        Toggle("", isOn: model.cardBinding(cardId))
                            .labelsHidden()
                    }
                    .padding(.vertical, 2)
                    .contentShape(Rectangle())
                    .onDrag {
                        model.draggingCardId = cardId
                        return NSItemProvider(object: cardId as NSString)
                    }
                    .onDrop(of: [UTType.text], delegate: CardReorderDropDelegate(
                        target: cardId,
                        order: $model.cardOrder,
                        draggingId: $model.draggingCardId,
                        persist: model.persistOrder
                    ))
                }
                .disabled(!model.configReady || !model.injectionEnabled)
            } header: {
                Text("卡片")
            } footer: {
                Text("拖动 ≡ 调整卡片顺序；改动实时生效，无需重启 Codex。升级后请关闭旧版设置窗口，再重新打开。")
            }

            // 显示方式
            Section {
                Picker("显示方式", selection: model.placementBinding) {
                    Text("独立浮层").tag(true)
                    Text("随 Summary").tag(false)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .disabled(!model.configReady || !model.injectionEnabled)
            } header: {
                Text("显示方式")
            } footer: {
                Text("独立浮层由顶栏播放图标打开，与 Summary 互斥；随 Summary 时由摘要开关统一控制，播放器按卡片顺序排在摘要下方。")
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
        .padding(16)
        .frame(width: 400)
        .onAppear { model.start() }
        .onDisappear { model.stop() }
    }

    @ViewBuilder
    private var statusButton: some View {
        if model.statusUnknown {
            Button("重试") { model.refreshStatus() }
                .disabled(model.busy)
        } else if model.codexRunning {
            Button("停止 Codex") { model.confirmAndStopCodex() }
                .disabled(model.busy)
        } else {
            Button("启动 Codex") { model.launchCodex(proxyPort: launchThroughProxy ? launchProxyPort : nil) }
                .keyboardShortcut(.defaultAction)
                .disabled(model.busy)
        }
    }

    private var statusColor: Color {
        if model.statusUnknown { return .gray }
        if !model.codexRunning { return .gray }
        return model.hasCdpFlag ? .green : .orange
    }

    private var statusTitle: String {
        if model.statusUnknown { return "状态未知（无法查询后端）" }
        if !model.codexRunning { return "Codex 未运行" }
        if model.hasCdpFlag { return "Codex 运行中（伴侣已启用）" }
        return "Codex 运行中（未启用伴侣，请从本 App 重启）"
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
        // 等待用户选择是否使用代理，再由窗口按钮启动 Codex。
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        // 关窗即退出 App；后端 launch 进程是独立子进程组，Codex 不受影响。
        true
    }
}
