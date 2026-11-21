package io.jit.nativegate

import android.app.Activity
import android.graphics.Color
import android.os.Looper
import android.os.Handler
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.TextView
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.lang.ref.WeakReference
import java.util.concurrent.CopyOnWriteArraySet

/** Native Activity hooks run before React's pause/resume. This owns visibility only, never a protected action. */
object JitNativeGateRuntime {
  private var epoch = 0L
  private var active = false
  private var activity = WeakReference<Activity>(null)
  private var cover: View? = null
  private var hiddenContent: View? = null
  private var previousAccessibility: Int? = null
  private const val coverTag = "jit.native.privacy"
  private val listeners = CopyOnWriteArraySet<(Map<String, Any>) -> Unit>()
  private fun main() { check(Looper.myLooper() == Looper.getMainLooper()) }
  fun foreground(value: Activity) { transition(value, true) }
  fun background(value: Activity) { transition(value, false) }
  fun destroy(value: Activity) {
    main()
    if (activity.get() === value) { transition(value, false); cover = null; hiddenContent = null; previousAccessibility = null; activity.clear() }
  }
  private fun transition(value: Activity, next: Boolean) {
    main()
    JitNativeCaptureRuntime.invalidate()
    if (epoch >= 9_007_199_254_740_991L) { active = false; ensureCover(value); return }
    epoch++; active = next; activity = WeakReference(value); ensureCover(value)
    val state = status(); listeners.forEach { it(state) }
  }
  private fun ensureCover(value: Activity) {
    value.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
    val content = value.findViewById<View>(android.R.id.content)
    if (content != null && hiddenContent !== content) { hiddenContent = content; previousAccessibility = content.importantForAccessibility }
    content?.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
    val root = value.window.decorView as? ViewGroup ?: return
    val existing = root.findViewWithTag<View>(coverTag)
    if (existing != null) { cover = existing; existing.bringToFront(); return }
    val layer = FrameLayout(value).apply { tag = coverTag; setBackgroundColor(Color.rgb(16, 17, 22)); isClickable = true; isFocusable = true; importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES }
    layer.addView(TextView(value).apply { text = "Jit"; textSize = 28f; setTextColor(Color.WHITE); gravity = Gravity.CENTER }, FrameLayout.LayoutParams(-1, -1))
    root.addView(layer, ViewGroup.LayoutParams(-1, -1)); layer.requestFocus(); cover = layer
  }
  fun status(): Map<String, Any> { main(); return mapOf("epoch" to epoch.toDouble(), "active" to active) }
  fun acceptsCapture(value: Double): Boolean { main(); val owner = activity.get(); return value.isFinite() && value == epoch.toDouble() && active && owner != null && !owner.isFinishing && !owner.isDestroyed }
  fun acknowledge(value: Double): Boolean {
    main()
    val owner = activity.get() ?: return false
    if (!value.isFinite() || value != epoch.toDouble() || !active || owner.isFinishing || owner.isDestroyed) return false
    (cover?.parent as? ViewGroup)?.removeView(cover); cover = null
    hiddenContent?.importantForAccessibility = previousAccessibility ?: View.IMPORTANT_FOR_ACCESSIBILITY_AUTO
    hiddenContent = null; previousAccessibility = null
    owner.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
    return true
  }
  fun addListener(listener: (Map<String, Any>) -> Unit) { listeners.add(listener) }
  fun removeListener(listener: (Map<String, Any>) -> Unit) { listeners.remove(listener) }
  fun lockRenderer() { main(); activity.get()?.let { transition(it, active) } }
}

class JitNativeGateModule : Module() {
  private val listener: (Map<String, Any>) -> Unit = { value -> sendEvent("lifecycle", value) }
  override fun definition() = ModuleDefinition {
    Name("JitNativeGate")
    AsyncFunction("nativePushConfigured") {
      val context = appContext.reactContext ?: return@AsyncFunction false
      val id = context.resources.getIdentifier("google_app_id", "string", context.packageName)
      id != 0 && context.resources.getString(id).isNotBlank()
    }.runOnQueue(Queues.MAIN)
    Events("lifecycle")
    OnStartObserving { JitNativeGateRuntime.addListener(listener) }
    OnStopObserving { JitNativeGateRuntime.removeListener(listener) }
    OnDestroy {
      JitNativeGateRuntime.removeListener(listener)
      if (Looper.myLooper() == Looper.getMainLooper()) JitNativeGateRuntime.lockRenderer()
      else Handler(Looper.getMainLooper()).post { JitNativeGateRuntime.lockRenderer() }
    }
    AsyncFunction("status") { JitNativeGateRuntime.status() }.runOnQueue(Queues.MAIN)
    AsyncFunction("acknowledge") { epoch: Double -> JitNativeGateRuntime.acknowledge(epoch) }.runOnQueue(Queues.MAIN)
  }
}
