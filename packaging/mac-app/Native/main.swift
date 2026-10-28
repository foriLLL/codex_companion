import AppKit
import ApplicationServices
import Darwin

let version = "0.0.1"

func emit(_ value: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else {
    print("{\"error\":\"serialization-failed\"}")
    return
  }
  FileHandle.standardOutput.write(data + Data([10]))
}

struct UsageError: Error { let message: String }

struct Options {
  let action: String
  let appURL: URL
  var values: [String: String] = [:]
  var hidden = false
  var pid: Int32 { Int32(values["--pid"] ?? "") ?? 0 }
  var key: String { values["--key"] ?? "" }
  var stamp: String? { values["--input-stamp"] }
  var frontmostPid: Int32? { values["--frontmost-pid"].flatMap(Int32.init) }
  var maxAgeMs: Int64 { Int64(values["--max-age-ms"] ?? "8000")! }

  init(_ args: [String]) throws {
    let allowed: [String: Set<String>] = [
      "snapshot": [], "watch": [],
      "quit": ["--pid", "--key", "--mode", "--input-stamp", "--max-age-ms"],
      "launch": ["--args-json", "--env-json", "--unset-env-json", "--hidden", "--input-stamp", "--frontmost-pid"],
      "show": ["--pid", "--key", "--input-stamp", "--frontmost-pid"]
    ]
    guard let action = args.first, let flags = allowed[action] else {
      throw UsageError(message: "unknown-action")
    }
    self.action = action
    var index = 1
    while index < args.count {
      let flag = args[index]
      guard flag == "--app" || flags.contains(flag), values[flag] == nil else {
        throw UsageError(message: "unknown-or-duplicate-option")
      }
      if flag == "--hidden" {
        hidden = true
        values[flag] = "true"
        index += 1
      } else {
        guard index + 1 < args.count, !args[index + 1].isEmpty else {
          throw UsageError(message: "missing-option-value")
        }
        values[flag] = args[index + 1]
        index += 2
      }
    }
    guard let path = values["--app"], path.hasPrefix("/") else {
      throw UsageError(message: "absolute-app-path-required")
    }
    appURL = normalized(URL(fileURLWithPath: path))
    if action == "quit" || action == "show" {
      guard pid > 0, !key.isEmpty else { throw UsageError(message: "pid-and-key-required") }
    }
    if action == "quit" {
      guard ["fresh", "user"].contains(values["--mode"] ?? ""),
            let age = Int64(values["--max-age-ms"] ?? "8000"), age >= 0 else {
        throw UsageError(message: "invalid-quit-options")
      }
      if values["--mode"] == "fresh" && stamp == nil { throw UsageError(message: "input-stamp-required") }
    }
    if action == "launch" || action == "show" {
      guard (stamp == nil) == (values["--frontmost-pid"] == nil),
            values["--frontmost-pid"] == nil || (frontmostPid != nil && frontmostPid! >= 0) else {
        throw UsageError(message: "input-stamp-and-frontmost-pid-required-together")
      }
    }
  }
}

func normalized(_ url: URL) -> URL { url.standardizedFileURL.resolvingSymlinksInPath() }

// 只取 argc 指定的 argv，不把缓冲区后面的环境或键盘内容暴露给调用方。
func processArguments(_ pid: Int32) -> [String]? {
  var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
  var size = 0
  guard sysctl(&mib, UInt32(mib.count), nil, &size, nil, 0) == 0, size >= 4 else { return nil }
  var bytes = [UInt8](repeating: 0, count: size)
  guard sysctl(&mib, UInt32(mib.count), &bytes, &size, nil, 0) == 0 else { return nil }
  let argc = bytes.withUnsafeBytes { $0.loadUnaligned(as: Int32.self) }
  guard argc > 0 && argc <= size else { return nil }
  var offset = MemoryLayout<Int32>.size
  while offset < size && bytes[offset] != 0 { offset += 1 }
  while offset < size && bytes[offset] == 0 { offset += 1 }
  var arguments: [String] = []
  for _ in 0..<argc {
    let start = offset
    while offset < size && bytes[offset] != 0 { offset += 1 }
    guard offset < size, let value = String(bytes: bytes[start..<offset], encoding: .utf8) else { return nil }
    arguments.append(value)
    offset += 1
  }
  return Array(arguments.dropFirst())
}

func matches(_ app: NSRunningApplication, _ appURL: URL) -> Bool {
  guard !app.isTerminated, let bundle = app.bundleURL, normalized(bundle) == appURL,
        let executable = app.executableURL else { return false }
  var path = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
  guard proc_pidpath(app.processIdentifier, &path, UInt32(path.count)) > 0 else { return false }
  return normalized(URL(fileURLWithPath: String(cString: path))) == normalized(executable)
}

func instance(_ app: NSRunningApplication, _ appURL: URL) -> AppInstance? {
  guard matches(app, appURL), let date = app.launchDate else { return nil }
  let arguments = processArguments(app.processIdentifier)
  guard matches(app, appURL), app.launchDate == date else { return nil }
  return AppInstance(pid: app.processIdentifier, launchedAt: Int64(date.timeIntervalSince1970 * 1000),
                     finishedLaunching: app.isFinishedLaunching, arguments: arguments)
}

func targetApps(_ appURL: URL) -> [NSRunningApplication] {
  NSWorkspace.shared.runningApplications.filter { matches($0, appURL) }
}

func inputState() -> InputState {
  let events: [CGEventType] = [.keyDown, .leftMouseDown, .rightMouseDown, .otherMouseDown, .scrollWheel]
  let stamp = events.map { String(CGEventSource.counterForEventType(.combinedSessionState, eventType: $0)) }.joined(separator: ":")
  let seconds = events.map { CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: $0) }.min() ?? 0
  let idle = seconds.isFinite && seconds >= 0 ? min(seconds, Double(Int64.max) / 1000) * 1000 : 0
  return InputState(frontmostPid: NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0,
                    inputStamp: stamp, inputIdleMs: idle, now: Int64(Date().timeIntervalSince1970 * 1000))
}

func snapshot(_ appURL: URL) -> [String: Any] {
  let apps = targetApps(appURL).compactMap { instance($0, appURL) }.sorted { $0.pid < $1.pid }
  let input = inputState()
  return ["apps": apps.map(\.json), "frontmostPid": input.frontmostPid, "inputStamp": input.inputStamp,
          "inputIdleMs": input.inputIdleMs, "now": input.now]
}

func quitApp(_ options: Options) -> [String: Any] {
  let app = NSRunningApplication(processIdentifier: options.pid)
  let current = app.flatMap { instance($0, options.appURL) }
  if let reason = quitRefusal(current, key: options.key, mode: options.values["--mode"]!,
                              stamp: options.stamp, maxAgeMs: options.maxAgeMs, input: inputState()) {
    return ["accepted": false, "reason": reason]
  }
  let accepted = app?.terminate() ?? false
  return accepted ? ["accepted": true] : ["accepted": false, "reason": "terminate-refused"]
}

func showApp(_ options: Options) -> [String: Any] {
  guard let app = NSRunningApplication(processIdentifier: options.pid),
        instance(app, options.appURL)?.key == options.key else {
    return ["shown": false, "reason": "instance-mismatch"]
  }
  if let reason = contextRefusal(stamp: options.stamp, frontmostPid: options.frontmostPid, input: inputState()) {
    return ["shown": false, "reason": reason]
  }
  // 短命进程里 isHidden 不随 hides=true 更新，unhide 对「看似未隐藏」的应用返回 false；
  // 因此总是请求 unhide，但不把返回值当作失败条件。
  _ = app.unhide()
  guard instance(app, options.appURL)?.key == options.key else { return ["shown": false, "reason": "instance-mismatch"] }
  if let reason = contextRefusal(stamp: options.stamp, frontmostPid: options.frontmostPid, input: inputState()) {
    return ["shown": false, "reason": reason]
  }
  return app.activate(options: [.activateAllWindows]) ? ["shown": true] : ["shown": false, "reason": "activate-refused"]
}

func launchApp(_ options: Options) throws -> [String: Any] {
  let decoder = JSONDecoder()
  guard let raw = options.values["--args-json"],
        let arguments = try? decoder.decode([String].self, from: Data(raw.utf8)),
        arguments.allSatisfy({ !$0.contains("\0") }) else { throw UsageError(message: "invalid-args-json") }
  let validEnvKey: (String) -> Bool = { !$0.isEmpty && !$0.contains("=") && !$0.contains("\0") }
  var environment: [String: String] = [:]
  if let raw = options.values["--env-json"] {
    guard let env = try? decoder.decode([String: String].self, from: Data(raw.utf8)),
          env.allSatisfy({ validEnvKey($0.key) && !$0.value.contains("\0") }) else {
      throw UsageError(message: "invalid-env-json")
    }
    environment = env
  }
  var unsetEnvironment: [String] = []
  if let raw = options.values["--unset-env-json"] {
    guard let keys = try? decoder.decode([String].self, from: Data(raw.utf8)), keys.allSatisfy(validEnvKey) else {
      throw UsageError(message: "invalid-unset-env-json")
    }
    unsetEnvironment = keys
  }
  guard unsetEnvironment.allSatisfy({ environment[$0] == nil }) else { throw UsageError(message: "conflicting-env-keys") }
  // LaunchServices 继承调用方环境；先清除短命助手自身的键，再传递显式覆盖项。
  for key in unsetEnvironment {
    guard unsetenv(key) == 0 else { throw UsageError(message: "invalid-unset-env-json") }
  }
  let configuration = NSWorkspace.OpenConfiguration()
  configuration.arguments = arguments
  // 原始 API 冒烟证实会合并默认环境，这里只传覆盖项。
  configuration.environment = environment
  configuration.activates = !options.hidden
  configuration.hides = options.hidden
  configuration.addsToRecentItems = false
  configuration.promptsUserIfNeeded = false
  configuration.allowsRunningApplicationSubstitution = false
  guard targetApps(options.appURL).isEmpty else { return ["launched": false, "reason": "already-running"] }
  if let reason = contextRefusal(stamp: options.stamp, frontmostPid: options.frontmostPid, input: inputState()) {
    return ["launched": false, "reason": reason]
  }
  var failure: [String: Any]?
  var launchedApp: NSRunningApplication?
  var launchedKey: String?
  let deadline = ProcessInfo.processInfo.systemUptime + 30
  var finishDeadline = deadline
  NSWorkspace.shared.openApplication(at: options.appURL, configuration: configuration) { app, error in
    DispatchQueue.main.async {
      if let error = error as NSError? {
        failure = ["launched": false, "reason": "open-failed", "errorCode": error.code]
      } else if let app, let current = instance(app, options.appURL) {
        launchedApp = app
        launchedKey = current.key
        finishDeadline = min(deadline, ProcessInfo.processInfo.systemUptime + 15)
      } else {
        failure = ["launched": false, "reason": "unverified-instance"]
      }
    }
  }
  // 回调成功后最多等 15 秒 finishedLaunching，isHidden 不参与成功判定。
  while true {
    if let failure { return failure }
    let now = ProcessInfo.processInfo.systemUptime
    if let launchedApp, let key = launchedKey {
      guard !launchedApp.isTerminated,
            let app = NSRunningApplication(processIdentifier: launchedApp.processIdentifier), !app.isTerminated else {
        return ["launched": false, "reason": "exited-during-launch"]
      }
      if let result = launchResult(instance(app, options.appURL), key: key, hidden: app.isHidden, waitExpired: now >= finishDeadline) {
        return result
      }
    }
    // 回调始终未返回时，不能确认任何启动实例；仍保留原契约的总等待上限。
    if now >= deadline { return ["launched": false, "reason": "unverified-instance"] }
    RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.02))
  }
}

func watch(_ appURL: URL) {
  var stopped = false
  var signature = ""
  var launching = false
  func publish(changedOnly: Bool = false) {
    let value = snapshot(appURL)
    let apps = value["apps"] as! [[String: Any]]
    let next = apps.map { "\($0["key"]!):\($0["finishedLaunching"]!)" }.joined(separator: ",") + ":\(value["frontmostPid"]!)"
    if !changedOnly || next != signature { emit(value) }
    signature = next
    launching = apps.contains { ($0["finishedLaunching"] as? Bool) != true }
  }
  let center = NSWorkspace.shared.notificationCenter
  let observers = [NSWorkspace.didLaunchApplicationNotification, NSWorkspace.didTerminateApplicationNotification,
                   NSWorkspace.didActivateApplicationNotification].map { name in
    center.addObserver(forName: name, object: nil, queue: .main) { notification in
      // terminate 时进程已不存在，通知只按规范化 bundleURL 过滤，再重新取完整快照。
      let app = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
      if name == NSWorkspace.didActivateApplicationNotification || app?.bundleURL.map(normalized) == appURL {
        publish()
      }
    }
  }
  // 启动/退出/前台切换都有通知；只有 isFinishedLaunching 翻转没有，靠逐秒轮询补。
  // 没有实例处于启动中时跳过完整快照（每次要取全部进程参数），常驻 CPU 降到近零。
  let timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in
    if launching { publish(changedOnly: true) }
  }
  let heartbeat = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { _ in publish() }
  signal(SIGTERM, SIG_IGN)
  let termination = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
  termination.setEventHandler { stopped = true }
  termination.resume()
  // stdin 仅作父进程存活通道；EOF 或意外数据就结束，不读取输入内容。
  FileHandle.standardInput.readabilityHandler = { handle in
    handle.readabilityHandler = nil
    DispatchQueue.main.async { stopped = true }
  }
  publish()
  while !stopped { RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.1)) }
  FileHandle.standardInput.readabilityHandler = nil
  timer.invalidate()
  heartbeat.invalidate()
  observers.forEach(center.removeObserver)
  termination.cancel()
}

do {
  let args = Array(CommandLine.arguments.dropFirst())
  if args == ["--version"] {
    emit(["version": version])
  } else {
    let options = try Options(args)
    switch options.action {
    case "snapshot": emit(snapshot(options.appURL))
    case "watch": watch(options.appURL)
    case "quit": emit(quitApp(options))
    case "launch": emit(try launchApp(options))
    case "show": emit(showApp(options))
    default: break
    }
  }
} catch {
  emit(["error": (error as? UsageError)?.message ?? "invalid-request"])
  exit(2)
}
