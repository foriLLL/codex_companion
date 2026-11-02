import Foundation

@main
struct GuardChecks {
  static func main() {
    let base = AppInstance(pid: 42, launchedAt: 1000, finishedLaunching: true, arguments: [])
    let input = InputState(frontmostPid: 42, inputStamp: "1:2:3:4:5", inputIdleMs: 8000, now: 2000)
    var count = 0
    func check(_ label: String, _ actual: String?, _ expected: String?) {
      guard actual == expected else {
        FileHandle.standardError.write(Data("\(label): \(actual ?? "accepted") != \(expected ?? "accepted")\n".utf8))
        exit(1)
      }
      count += 1
    }
    func refusal(_ app: AppInstance? = base, key: String? = nil, mode: String = "fresh",
                 maxAge: Int64 = 8000, state: InputState = input) -> String? {
      quitRefusal(app, key: key ?? base.key, mode: mode, maxAgeMs: maxAge, input: state)
    }
    check("fresh", refusal(), nil)
    check("missing", refusal(nil), "instance-mismatch")
    check("fresh-key", refusal(key: "42:999"), "key-mismatch")
    check("user-key", refusal(key: "42:999", mode: "user"), "key-mismatch")
    check("user-missing", refusal(nil, mode: "user"), "instance-mismatch")
    var app = base
    app.finishedLaunching = false
    check("pending", refusal(app), "not-finished-launching")
    app = base
    app.arguments = nil
    check("unknown-argv", refusal(app), "arguments-unknown")
    for args in [["--remote-debugging-port=12345"], ["--remote-debugging-port", "12345"], ["--remote-debugging-port="]] {
      app.arguments = args
      check("debug", refusal(app), "debug-port-present")
    }
    app.arguments = ["--remote-debugging-port-file=keep"]
    check("non-debug-prefix", refusal(app), nil)
    var state = input
    state.now = 999
    check("negative-age", refusal(state: state), "age-out-of-range")
    state.now = 1000
    check("age-zero", refusal(state: state), nil)
    state.now = 9000
    check("age-boundary", refusal(state: state), nil)
    state.now = 9001
    check("old", refusal(state: state), "age-out-of-range")
    check("custom-window", refusal(maxAge: 999), "age-out-of-range")
    state = input
    state.inputStamp = "9:9:9:9:9"
    state.inputIdleMs = 0
    check("input-since-launch-allowed", refusal(state: state), nil)
    state.frontmostPid = 99
    check("background", refusal(state: state), "not-frontmost")
    app.finishedLaunching = false
    app.arguments = nil
    check("user-bypasses-fresh", refusal(app, mode: "user", maxAge: 0, state: state), nil)
    func encoded(_ value: [String: Any]?) -> String? {
      guard let value else { return nil }
      return String(data: try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), encoding: .utf8)
    }
    for hidden in [false, true] {
      var expected: [String: Any] = ["launched": true, "pid": Int32(42), "key": "42:1000", "finishedLaunching": true, "hidden": hidden]
      check("launch-ready-\(hidden)", encoded(launchResult(base, key: base.key, hidden: hidden, waitExpired: false)), encoded(expected))
      var pending = base
      pending.finishedLaunching = false
      check("launch-pending-\(hidden)", encoded(launchResult(pending, key: base.key, hidden: hidden, waitExpired: false)), nil)
      expected["finishedLaunching"] = false
      check("launch-wait-expired-\(hidden)", encoded(launchResult(pending, key: base.key, hidden: hidden, waitExpired: true)), encoded(expected))
    }
    let unverified: [String: Any] = ["launched": false, "reason": "unverified-instance"]
    check("launch-missing", encoded(launchResult(nil, key: base.key, hidden: false, waitExpired: true)), encoded(unverified))
    check("launch-key-reused", encoded(launchResult(base, key: "42:999", hidden: false, waitExpired: true)), encoded(unverified))
    print("{\"tests\":\(count),\"pass\":\(count),\"fail\":0}")
  }
}
