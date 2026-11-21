import AVFoundation
import ExpoModulesCore
import UIKit

private struct CaptureFailure: Error { let code = "mobile_capture_unavailable" }
private final class CaptureLease: @unchecked Sendable {
  let id = UUID().uuidString
  let epoch: Double
  let ms: Int
  let lock = NSLock()
  var rate = 0.0
  var pcm = Data()
  var running = false
  var started = false
  var valid = true
  init(epoch: Double, ms: Int) { self.epoch = epoch; self.ms = ms }
}

/** Main-thread owner with a bounded audio-thread buffer. Native lifecycle invalidation precedes React callbacks. */
@MainActor
final class JitNativeCaptureRuntime {
  static let shared = JitNativeCaptureRuntime()
  private var lease: CaptureLease?
  private var engine: AVAudioEngine?
  private var timer: DispatchWorkItem?
  private var interruptions: [NSObjectProtocol] = []
  func prepare(_ epoch: Double, _ ms: Double) throws -> String {
    invalidate()
    guard JitNativeGateRuntime.shared.acceptsCapture(epoch), ms.isFinite, ms.rounded(.down) == ms, ms >= 100, ms <= 30_000 else { throw CaptureFailure() }
    let value = CaptureLease(epoch: epoch, ms: Int(ms)); lease = value; return value.id
  }
  private func current(_ id: String) throws -> CaptureLease {
    guard let value = lease, value.id == id, value.valid, JitNativeGateRuntime.shared.acceptsCapture(value.epoch) else { invalidate(); throw CaptureFailure() }
    return value
  }
  func start(_ id: String) throws {
    let value = try current(id)
    guard !value.started, AVAudioSession.sharedInstance().recordPermission == .granted else { invalidate(); throw CaptureFailure() }
    do {
      let session = AVAudioSession.sharedInstance()
      try session.setCategory(.record, mode: .measurement, options: [])
      try session.setActive(true)
      let audio = AVAudioEngine(), input = audio.inputNode, format = input.outputFormat(forBus: 0)
      guard format.sampleRate >= 8_000, format.sampleRate <= 96_000, format.channelCount >= 1, format.channelCount <= 8,
        format.commonFormat == .pcmFormatFloat32, !format.isInterleaved else { throw CaptureFailure() }
      value.rate = format.sampleRate; value.started = true; value.running = true
      value.pcm.reserveCapacity(Int(format.sampleRate * Double(value.ms) / 1000) * 2)
      engine = audio
      input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
        value.lock.lock(); defer { value.lock.unlock() }
        guard value.valid, value.running, let channels = buffer.floatChannelData, buffer.format.sampleRate == value.rate,
          buffer.format.channelCount == format.channelCount else { return }
        let limit = Int(value.rate * Double(value.ms) / 1000) * 2
        let frames = min(Int(buffer.frameLength), max(0, (limit - value.pcm.count) / 2))
        for frame in 0..<frames {
          var sample: Float = 0
          for channel in 0..<Int(format.channelCount) { sample += channels[channel][frame] / Float(format.channelCount) }
          let bounded = sample.isFinite ? max(-1, min(1, sample)) : 0
          let scalar = Int16((bounded < 0 ? bounded * 32768 : bounded * 32767).rounded())
          let bits = UInt16(bitPattern: scalar)
          value.pcm.append(UInt8(truncatingIfNeeded: bits)); value.pcm.append(UInt8(truncatingIfNeeded: bits >> 8))
        }
        if value.pcm.count >= limit {
          value.running = false
          DispatchQueue.main.async { JitNativeCaptureRuntime.shared.complete(value.id) }
        }
      }
      audio.prepare(); try audio.start()
      for name in [AVAudioSession.interruptionNotification, AVAudioSession.routeChangeNotification, Notification.Name.AVAudioEngineConfigurationChange] {
        interruptions.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { _ in MainActor.assumeIsolated { JitNativeCaptureRuntime.shared.invalidate() } })
      }
      let stop = DispatchWorkItem { JitNativeCaptureRuntime.shared.complete(value.id) }; timer = stop
      DispatchQueue.main.asyncAfter(deadline: .now() + Double(value.ms) / 1000, execute: stop)
    } catch { invalidate(); throw CaptureFailure() }
  }
  private func stopEngine() {
    timer?.cancel(); timer = nil
    for observer in interruptions { NotificationCenter.default.removeObserver(observer) }; interruptions.removeAll()
    if let audio = engine { audio.inputNode.removeTap(onBus: 0); audio.stop(); engine = nil }
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }
  func complete(_ id: String) {
    guard let value = lease, value.id == id else { return }
    value.lock.lock(); value.running = false; value.lock.unlock(); stopEngine()
  }
  func invalidate() {
    if let value = lease { value.lock.lock(); value.valid = false; value.running = false; value.pcm.removeAll(keepingCapacity: false); value.lock.unlock() }
    lease = nil; stopEngine()
  }
  func cancel(_ id: String) { if lease?.id == id { invalidate() } }
  func finish(_ id: String) throws -> [String: Any] {
    let value = try current(id); complete(id)
    value.lock.lock(); defer { value.lock.unlock() }
    guard value.started, value.valid, !value.pcm.isEmpty else { lease = nil; throw CaptureFailure() }
    let result: [String: Any] = ["lease": value.id, "epoch": value.epoch, "encoding": "pcm16le", "sampleRate": value.rate, "channels": 1, "base64": value.pcm.base64EncodedString()]
    value.valid = false; value.pcm.removeAll(keepingCapacity: false); lease = nil; return result
  }
}

/** Finite capture only. No file, URL, playback, authentication or execution API. */
public final class JitNativeCaptureModule: Module {
  public func definition() -> ModuleDefinition {
    Name("JitNativeCapture")
    AsyncFunction("requestPermission") { (promise: Promise) in
      AVAudioSession.sharedInstance().requestRecordPermission { granted in promise.resolve(["granted": granted]) }
    }.runOnQueue(.main)
    AsyncFunction("prepare") { (epoch: Double, ms: Double) throws -> String in try MainActor.assumeIsolated { try JitNativeCaptureRuntime.shared.prepare(epoch, ms) } }.runOnQueue(.main)
    AsyncFunction("start") { (id: String) throws in try MainActor.assumeIsolated { try JitNativeCaptureRuntime.shared.start(id) } }.runOnQueue(.main)
    AsyncFunction("finish") { (id: String) throws -> [String: Any] in try MainActor.assumeIsolated { try JitNativeCaptureRuntime.shared.finish(id) } }.runOnQueue(.main)
    AsyncFunction("cancel") { (id: String) in MainActor.assumeIsolated { JitNativeCaptureRuntime.shared.cancel(id) } }.runOnQueue(.main)
    OnDestroy { DispatchQueue.main.async { JitNativeCaptureRuntime.shared.invalidate() } }
  }
}
