import AppKit
import SwiftUI
import UniformTypeIdentifiers

// 卡片目录：配置窗按此集合渲染，新增卡片只需在此登记。
// 与 bun 侧 companion-config 的 CARD_IDS 对齐。
struct CardDescriptor: Identifiable, Hashable {
    let id: String
    let title: String
}

let cardCatalog: [CardDescriptor] = [
    CardDescriptor(id: "hongguo", title: "红果短剧"),
    CardDescriptor(id: "emby", title: "Emby 媒体")
]

func cardTitle(_ id: String) -> String {
    cardCatalog.first(where: { $0.id == id })?.title ?? id
}

// MARK: - 数据模型（与 bun 侧 CLI 的 JSON 输出/配置文件 schema 对齐）

struct CompanionStatus: Decodable {
    var statusError: Bool?
    var codexRunning: Bool
    var hasCdpFlag: Bool
    var codexPids: [Int]
    var port: Int?
    var daemonPid: Int?
    var cards: CardsConfig?
}

struct CardsConfig: Codable {
    var hongguo: Bool
    var emby: Bool

    // 与 bun 侧 normalizeCards 对齐：缺字段回退默认（开），不因单字段缺失整体失败。
    init(hongguo: Bool = true, emby: Bool = true) {
        self.hongguo = hongguo
        self.emby = emby
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        hongguo = (try? container.decode(Bool.self, forKey: .hongguo)) ?? true
        emby = (try? container.decode(Bool.self, forKey: .emby)) ?? true
    }
}

struct CompanionConfigFile: Codable {
    var version: Int
    var enabled: Bool
    var placement: String
    var cards: CardsConfig
    var cardOrder: [String]

    init(version: Int = 1, enabled: Bool = true, placement: String = "standalone-button", cards: CardsConfig = CardsConfig(), cardOrder: [String] = ["hongguo", "emby"]) {
        self.version = version
        self.enabled = enabled
        self.placement = placement
        self.cards = cards
        self.cardOrder = cardOrder
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        version = (try? container.decode(Int.self, forKey: .version)) ?? 1
        // 注入总开关：缺省开（与 bun 侧 normalize 一致）。
        enabled = (try? container.decode(Bool.self, forKey: .enabled)) ?? true
        let raw = (try? container.decode(String.self, forKey: .placement)) ?? "standalone-button"
        placement = (raw == "inline-in-summary") ? raw : "standalone-button"
        cards = (try? container.decode(CardsConfig.self, forKey: .cards)) ?? CardsConfig()
        // 与 bun 侧 normalizeCardOrder 对齐：白名单过滤 + 去重 + 缺失项补末尾。
        let rawOrder = (try? container.decode([String].self, forKey: .cardOrder)) ?? []
        var order: [String] = []
        for id in rawOrder where ["hongguo", "emby"].contains(id) && !order.contains(id) {
            order.append(id)
        }
        for id in ["hongguo", "emby"] where !order.contains(id) {
            order.append(id)
        }
        cardOrder = order
    }
}

struct StopResult: Decodable {
    var stopped: Bool
    var reason: String
}

// MARK: - 后端桥（调 Resources/codex-companion 子命令、读写共享配置文件）

enum BackendError: LocalizedError {
    case binaryMissing
    case commandFailed(String)

    var errorDescription: String? {
        switch self {
        case .binaryMissing:
            return "找不到 codex-companion 后端，请重新安装。"
        case .commandFailed(let message):
            return message
        }
    }
}

final class CompanionBackend {
    static let shared = CompanionBackend()

    let configURL: URL = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/codex-companion/config.json")

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

    /// 运行后端子命令并等待退出，返回 stdout。后端约定输出单行 JSON。
    /// 并发读取 stdout/stderr 后再 waitUntilExit，避免管道缓冲写满导致的死锁。
    private func run(_ arguments: [String]) throws -> Data {
        guard let binary = binaryURL else { throw BackendError.binaryMissing }
        let process = Process()
        process.executableURL = binary
        process.arguments = arguments
        process.environment = backendEnvironment()
        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe
        try process.run()
        // 先读到 EOF（读操作会阻塞直到子进程关闭写端），再 wait，避免死锁。
        let stdoutData = stdoutPipe.fileHandleForReading.readDataToEndOfFile()
        let stderrData = stderrPipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            let message = String(data: stdoutData + stderrData, encoding: .utf8) ?? ""
            throw BackendError.commandFailed("后端命令失败（\(arguments.joined(separator: " "))）：\(message)")
        }
        return stdoutData
    }

    func status() throws -> CompanionStatus {
        try JSONDecoder().decode(CompanionStatus.self, from: run(["status"]))
    }

    func stopCodex() throws -> StopResult {
        try JSONDecoder().decode(StopResult.self, from: run(["stop-codex"]))
    }

    private(set) var launchedProcess: Process?

    /// 启动 Codex + 常驻注入维护。launch 是长驻进程，不等待退出；输出写入日志文件。
    func launchDetached() throws {
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
        process.arguments = ["launch"]
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

    /// 读配置：文件缺失/损坏回退默认（与 bun 侧 normalize 语义一致）。
    func loadConfig() -> CompanionConfigFile {
        guard let data = try? Data(contentsOf: configURL),
              let parsed = try? JSONDecoder().decode(CompanionConfigFile.self, from: data) else {
            return CompanionConfigFile()
        }
        return CompanionConfigFile(version: 1, placement: parsed.placement, cards: parsed.cards)
    }

    /// 写配置：0600 权限。bun 常驻进程 watch 该目录，写入后数秒内重注入生效。
    func saveConfig(_ config: CompanionConfigFile) throws {
        let directory = configURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        var data = try encoder.encode(config)
        data.append(Data("\n".utf8))
        let temporary = directory.appendingPathComponent(".config-swift-\(UUID().uuidString).tmp")
        try data.write(to: temporary)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: temporary.path)
        _ = try FileManager.default.replaceItemAt(configURL, withItemAt: temporary)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: configURL.path)
    }
}

// MARK: - 视图模型

@MainActor
final class CompanionViewModel: ObservableObject {
    @Published var injectionEnabled = true      // 注入总开关（mount/unmount）
    @Published var cardEnabled: [String: Bool] = [:]
    @Published var cardOrder: [String] = cardCatalog.map(\.id)
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

    func start() {
        let config = backend.loadConfig()
        injectionEnabled = config.enabled
        cardEnabled = Dictionary(uniqueKeysWithValues: cardCatalog.map { ($0.id, true) })
        cardEnabled["hongguo"] = config.cards.hongguo
        cardEnabled["emby"] = config.cards.emby
        cardOrder = config.cardOrder
        standalonePlacement = config.placement != "inline-in-summary"
        refreshStatus()
        pollTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refreshStatus() }
        }
    }

    func stop() {
        pollTimer?.invalidate()
        pollTimer = nil
    }

    func refreshStatus() {
        let backend = self.backend
        Task.detached {
            let status = try? backend.status()
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
        Binding(
            get: { self.cardEnabled[id] ?? true },
            set: { self.cardEnabled[id] = $0; self.persistConfig() }
        )
    }

    func persistConfig() {
        let config = CompanionConfigFile(
            version: 1,
            enabled: injectionEnabled,
            placement: standalonePlacement ? "standalone-button" : "inline-in-summary",
            cards: CardsConfig(
                hongguo: cardEnabled["hongguo"] ?? true,
                emby: cardEnabled["emby"] ?? true
            ),
            cardOrder: cardOrder
        )
        do {
            try backend.saveConfig(config)
            errorMessage = nil
        } catch {
            errorMessage = "保存配置失败：\(error.localizedDescription)"
        }
    }

    func launchCodex() {
        busy = true
        errorMessage = nil
        let backend = self.backend
        Task.detached {
            do {
                try backend.launchDetached()
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
                _ = try backend.stopCodex()
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
            }

            // 卡片区：总开关 + 可拖拽排序的卡片行（为以后更多卡片设计）
            Section {
                Toggle("启用注入卡片", isOn: $model.injectionEnabled)
                    .onChange(of: model.injectionEnabled) { _ in model.persistConfig() }

                ForEach(model.cardOrder, id: \.self) { cardId in
                    HStack(spacing: 10) {
                        Image(systemName: "line.3.horizontal")
                            .foregroundStyle(.tertiary)
                        Text(cardTitle(cardId))
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
                        persist: model.persistConfig
                    ))
                }
                .disabled(!model.injectionEnabled)
            } header: {
                Text("卡片")
            } footer: {
                Text("拖动 ≡ 调整卡片顺序；改动实时生效，无需重启 Codex。")
            }

            // 显示方式
            Section {
                Picker("显示方式", selection: $model.standalonePlacement) {
                    Text("独立按钮").tag(true)
                    Text("随 Summary").tag(false)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .onChange(of: model.standalonePlacement) { _ in model.persistConfig() }
                .disabled(!model.injectionEnabled)
            } header: {
                Text("显示方式")
            } footer: {
                Text("独立按钮与原生 Summary 并排、互斥；随 Summary 则嵌入原生面板。")
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
            Button("启动 Codex") { model.launchCodex() }
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
        // 首次打开即自动确保 Codex 以伴侣模式运行（保持“点开即用”的无感体验）。
        // launch 幂等：已在运行且带 flag 时只是 attach，不会重复启动。
        if let status = try? CompanionBackend.shared.status(),
           !(status.codexRunning && status.hasCdpFlag && CompanionBackend.shared.launchedProcess != nil) {
            try? CompanionBackend.shared.launchDetached()
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        // 关窗即退出 App；后端 launch 进程是独立子进程组，Codex 不受影响。
        true
    }
}
