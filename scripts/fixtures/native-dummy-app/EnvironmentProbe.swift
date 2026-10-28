import AppKit

// 直接传入 API 的原始 environment，绕过生产助手的合并逻辑，避免循环验证。
@main
struct EnvironmentProbe {
  static func main() {
    let args = CommandLine.arguments
    guard args.count == 4 else { exit(2) }
    let appURL = URL(fileURLWithPath: args[1]).standardizedFileURL.resolvingSymlinksInPath()
    guard appURL.path != "/Applications/ChatGPT.app",
          Bundle(url: appURL)?.bundleIdentifier == "local.codexcompanion.dummy",
          !NSWorkspace.shared.runningApplications.contains(where: {
            $0.bundleURL?.standardizedFileURL.resolvingSymlinksInPath() == appURL
          }) else { exit(2) }
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = false
    configuration.hides = true
    configuration.addsToRecentItems = false
    configuration.promptsUserIfNeeded = false
    configuration.allowsRunningApplicationSubstitution = false
    configuration.arguments = ["--record", args[2]]
    if args[3] == "override" {
      configuration.environment = ["DUMMY_APP_RECORD": args[2], "DUMMY_OVERRIDE": "raw-api"]
    } else if args[3] != "default" { exit(2) }
    var completed = false
    var success = false
    var launchedApp: NSRunningApplication?
    NSWorkspace.shared.openApplication(at: appURL, configuration: configuration) { app, error in
      DispatchQueue.main.async {
        success = app != nil && error == nil
        launchedApp = app
        completed = true
      }
    }
    let deadline = ProcessInfo.processInfo.systemUptime + 15
    while ProcessInfo.processInfo.systemUptime < deadline {
      if completed && (!success || (launchedApp?.isFinishedLaunching == true && launchedApp?.isHidden == true)) { break }
      RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.02))
    }
    success = success && launchedApp?.isHidden == true
    print("{\"launched\":\(success)}")
    if !success { exit(1) }
  }
}
