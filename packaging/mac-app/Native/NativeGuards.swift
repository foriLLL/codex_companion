import Foundation

struct AppInstance {
  let pid: Int32
  let launchedAt: Int64
  var finishedLaunching: Bool
  var arguments: [String]?
  var key: String { "\(pid):\(launchedAt)" }
  var json: [String: Any] {
    ["pid": pid, "key": key, "launchedAt": launchedAt,
     "finishedLaunching": finishedLaunching, "arguments": arguments as Any? ?? NSNull()]
  }
}

struct InputState {
  var frontmostPid: Int32
  var inputStamp: String
  var inputIdleMs: Double
  var now: Int64
}

// 守卫保持纯函数；生产入口必须在调用 AppKit 动作前读取原生状态再判断。
func quitRefusal(_ instance: AppInstance?, key: String, mode: String,
                 stamp: String?, maxAgeMs: Int64, input: InputState) -> String? {
  guard let instance else { return "instance-mismatch" }
  guard instance.key == key else { return "key-mismatch" }
  if mode == "user" { return nil }
  guard mode == "fresh" else { return "invalid-mode" }
  guard instance.finishedLaunching else { return "not-finished-launching" }
  guard let arguments = instance.arguments else { return "arguments-unknown" }
  guard !arguments.contains(where: { $0 == "--remote-debugging-port" || $0.hasPrefix("--remote-debugging-port=") }) else {
    return "debug-port-present"
  }
  let age = input.now - instance.launchedAt
  guard age >= 0 && age <= maxAgeMs else { return "age-out-of-range" }
  guard stamp == input.inputStamp else { return "input-changed" }
  guard input.inputIdleMs >= Double(age) else { return "input-since-launch" }
  guard input.frontmostPid == instance.pid else { return "not-frontmost" }
  return nil
}

func contextRefusal(stamp: String?, frontmostPid: Int32?, input: InputState) -> String? {
  if let stamp, stamp != input.inputStamp { return "input-changed" }
  if let frontmostPid, frontmostPid != input.frontmostPid { return "frontmost-changed" }
  return nil
}

// 启动完成和隐藏状态只是观测值；等待到期不能把仍存活的已核验实例判成启动失败。
func launchResult(_ current: AppInstance?, key: String, hidden: Bool, waitExpired: Bool) -> [String: Any]? {
  guard let current, current.key == key else { return ["launched": false, "reason": "unverified-instance"] }
  guard current.finishedLaunching || waitExpired else { return nil }
  return ["launched": true, "pid": current.pid, "key": current.key,
          "finishedLaunching": current.finishedLaunching, "hidden": hidden]
}
