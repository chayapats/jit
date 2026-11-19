import ExpoModulesCore
import UIKit

/// Authored Jit visibility fence. Native lifecycle/opaque cover only; no service, credential or effect authority.
@MainActor public final class JitNativeGateRuntime {
  public static let shared = JitNativeGateRuntime()
  private var observers: [NSObjectProtocol] = []
  private var listeners: [UUID: ([String: Any]) -> Void] = [:]
  private var epoch = 0
  private var active = false
  private var covered = true
  private var roots: [UIView] = []
  private let coverId = "jit.native.privacy"

  public func start() {
    guard observers.isEmpty else { return }
    let center = NotificationCenter.default
    for name in [UIApplication.willResignActiveNotification, UIScene.willDeactivateNotification] {
      observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated { self?.transition(false) }
      })
    }
    for name in [UIApplication.didBecomeActiveNotification, UIScene.didActivateNotification] {
      observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated {
          let isActive = UIApplication.shared.applicationState == .active
          self?.transition(isActive)
        }
      })
    }
    observers.append(center.addObserver(forName: UIWindow.didBecomeKeyNotification, object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.coverRoots() }
    })
    transition(UIApplication.shared.applicationState == .active)
  }
  private func transition(_ next: Bool) {
    JitNativeCaptureRuntime.shared.invalidate()
    guard epoch < 9_007_199_254_740_991 else { active = false; covered = true; coverRoots(); return }
    epoch += 1; active = next; covered = true; coverRoots()
    let value = status(); for listener in listeners.values { listener(value) }
  }
  private func coverRoots() {
    guard covered else { return }
    roots.removeAll { $0.window == nil }
    let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap { $0.windows }
    for window in windows where !window.isHidden && window.windowLevel == .normal {
      // Private React views stay within this root; owner-controlled native document/permission sheets remain usable.
      guard let root = window.rootViewController?.view, let parent = root.superview else { continue }
      if !roots.contains(where: { $0 === root }) { roots.append(root) }
      // Keep the cover outside React's managed children so a delayed Fabric commit cannot reorder/remove it.
      // UIKit's owner-presented document/permission sheets remain above this root sibling.
      if let existing = parent.subviews.first(where: { $0.accessibilityIdentifier == coverId }) { parent.insertSubview(existing, aboveSubview: root); continue }
      let cover = UIView(frame: root.frame)
      cover.accessibilityIdentifier = coverId; cover.accessibilityViewIsModal = true
      cover.autoresizingMask = [.flexibleWidth, .flexibleHeight]; cover.backgroundColor = .systemBackground
      let brand = UILabel(); brand.text = "Jit"; brand.textColor = .label; brand.font = .preferredFont(forTextStyle: .title1)
      brand.translatesAutoresizingMaskIntoConstraints = false; cover.addSubview(brand)
      NSLayoutConstraint.activate([brand.centerXAnchor.constraint(equalTo: cover.centerXAnchor), brand.centerYAnchor.constraint(equalTo: cover.centerYAnchor)])
      parent.insertSubview(cover, aboveSubview: root)
    }
  }
  func status() -> [String: Any] { return ["epoch": epoch, "active": active] }
  func acceptsCapture(_ value: Double) -> Bool { value.isFinite && value == Double(epoch) && active && UIApplication.shared.applicationState == .active }
  func subscribe(_ listener: @escaping ([String: Any]) -> Void) -> UUID { let id = UUID(); listeners[id] = listener; return id }
  func unsubscribe(_ id: UUID) { listeners.removeValue(forKey: id) }
  func lockRenderer() { transition(UIApplication.shared.applicationState == .active) }
  func acknowledge(_ value: Double) -> Bool {
    guard value.isFinite, value.rounded(.down) == value, value == Double(epoch), active,
      UIApplication.shared.applicationState == .active else { return false }
    coverRoots(); guard !roots.isEmpty else { return false }
    for root in roots { root.superview?.subviews.filter { $0.accessibilityIdentifier == coverId }.forEach { $0.removeFromSuperview() } }
    covered = false; return true
  }
}

public final class JitNativeGateModule: Module {
  private var listener: UUID?
  public func definition() -> ModuleDefinition {
    Name("JitNativeGate")
    Events("lifecycle")
    OnStartObserving {
      DispatchQueue.main.async { [weak self] in
        guard let self else { return }
        JitNativeGateRuntime.shared.start()
        self.listener = JitNativeGateRuntime.shared.subscribe { [weak self] value in self?.sendEvent("lifecycle", value) }
      }
    }
    OnStopObserving { self.removeListener(lock: false) }
    OnDestroy { self.removeListener(lock: true) }
    AsyncFunction("status") { () -> [String: Any] in
      MainActor.assumeIsolated { JitNativeGateRuntime.shared.start(); return JitNativeGateRuntime.shared.status() }
    }.runOnQueue(.main)
    AsyncFunction("acknowledge") { (epoch: Double) -> Bool in
      MainActor.assumeIsolated { JitNativeGateRuntime.shared.acknowledge(epoch) }
    }.runOnQueue(.main)
  }
  private func removeListener(lock: Bool) {
    DispatchQueue.main.async { [self] in
      if let id = self.listener { JitNativeGateRuntime.shared.unsubscribe(id); self.listener = nil }
      if lock { JitNativeGateRuntime.shared.lockRenderer() }
    }
  }
}
