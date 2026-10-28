import AppKit

final class DummyDelegate: NSObject, NSApplicationDelegate {
  var window: NSWindow?
  var expiry: Timer?
  var sampling: Timer?
  var everActive = false

  func record(terminated: Bool = false) {
    everActive = everActive || NSApp.isActive
    let args = CommandLine.arguments
    let index = args.firstIndex(of: "--record")
    let argumentPath = index.flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil }
    guard let path = ProcessInfo.processInfo.environment["DUMMY_APP_RECORD"] ?? argumentPath else { return }
    let value: [String: Any] = ["pid": ProcessInfo.processInfo.processIdentifier,
      "argv": args, "environment": ProcessInfo.processInfo.environment,
      "hidden": NSApp.isHidden, "active": NSApp.isActive, "everActive": everActive, "terminated": terminated]
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { return }
    try? data.write(to: URL(fileURLWithPath: path), options: [.atomic])
    try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path)
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    // 默认档不创建窗口；只有显式 interactive 冒烟传入 --window。
    if CommandLine.arguments.contains("--window") {
      window = NSWindow(contentRect: NSRect(x: 100, y: 100, width: 320, height: 160),
                        styleMask: [.titled, .closable], backing: .buffered, defer: false)
      window?.title = "Native helper smoke"
      window?.orderFront(nil)
    }
    record()
    // hide 通知可能早于 AppKit 属性刷新，下一轮 run loop 再记录实际状态。
    sampling = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in self?.record() }
    // 即使冒烟宿主意外消失，测试应用也会正常退出，不留下常驻进程。
    expiry = Timer.scheduledTimer(withTimeInterval: 90, repeats: false) { _ in NSApp.terminate(nil) }
  }

  func applicationDidHide(_ notification: Notification) { record() }
  func applicationDidUnhide(_ notification: Notification) { record() }
  func applicationDidBecomeActive(_ notification: Notification) { record() }
  func applicationDidResignActive(_ notification: Notification) { record() }
  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply { .terminateNow }
  func applicationWillTerminate(_ notification: Notification) { record(terminated: true) }
}

@main
struct DummyApp {
  static func main() {
    let app = NSApplication.shared
    let delegate = DummyDelegate()
    app.delegate = delegate
    withExtendedLifetime(delegate) { _ = NSApplicationMain(CommandLine.argc, CommandLine.unsafeArgv) }
  }
}
