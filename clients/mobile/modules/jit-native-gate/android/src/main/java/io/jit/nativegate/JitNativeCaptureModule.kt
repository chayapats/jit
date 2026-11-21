package io.jit.nativegate

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Handler
import android.os.Looper
import android.util.Base64
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.interfaces.permissions.Permissions
import java.util.UUID

private class CaptureLease(val epoch: Double, val ms: Int) {
  val id = UUID.randomUUID().toString()
  val lock = Any()
  var rate = 0
  var pcm = ByteArray(0)
  var length = 0
  var running = false
  var started = false
  var readerStarted = false
  var valid = true
  var audio: AudioRecord? = null
}

/** Main-thread lease owner; the blocking reader has no Activity, file, session or network authority. */
object JitNativeCaptureRuntime {
  private val main = Handler(Looper.getMainLooper())
  private var lease: CaptureLease? = null
  private var timer: Runnable? = null
  private fun checkMain() { check(Looper.myLooper() == Looper.getMainLooper()) }
  private fun unavailable(): Nothing = throw IllegalStateException("mobile_capture_unavailable")
  fun prepare(epoch: Double, ms: Double): String {
    checkMain(); invalidate()
    if (!JitNativeGateRuntime.acceptsCapture(epoch) || !ms.isFinite() || ms % 1.0 != 0.0 || ms < 100 || ms > 30000) unavailable()
    val value = CaptureLease(epoch, ms.toInt()); lease = value; return value.id
  }
  private fun current(id: String): CaptureLease {
    val value = lease
    if (value == null || value.id != id || !value.valid || !JitNativeGateRuntime.acceptsCapture(value.epoch)) { invalidate(); unavailable() }
    return value
  }
  fun start(context: Context, id: String) {
    checkMain(); val value = current(id)
    if (value.started || context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) { invalidate(); unavailable() }
    try {
      var audio: AudioRecord? = null
      for (rate in listOf(16000, 48000, 44100, 22050, 8000)) {
        val minimum = AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        if (minimum <= 0) continue
        val candidate = try { AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, maxOf(minimum * 2, 8192)) } catch (_: Exception) { continue }
        if (candidate.state == AudioRecord.STATE_INITIALIZED) { audio = candidate; break }; candidate.release()
      }
      val recorder = audio ?: unavailable()
      value.audio = recorder; value.rate = recorder.sampleRate
      if (value.rate !in 8000..96000 || recorder.channelCount != 1) unavailable()
      value.pcm = ByteArray((value.rate.toLong() * value.ms / 1000 * 2).toInt()); value.started = true; value.running = true
      recorder.startRecording()
      if (recorder.recordingState != AudioRecord.RECORDSTATE_RECORDING) unavailable()
      Thread({ read(value, recorder) }, "JitFiniteCapture").start()
      value.readerStarted = true
      val stop = Runnable { complete(value.id) }; timer = stop; main.postDelayed(stop, value.ms.toLong())
    } catch (_: Exception) { invalidate(); unavailable() }
  }
  private fun read(value: CaptureLease, recorder: AudioRecord) {
    val chunk = ShortArray(1024)
    try {
      while (synchronized(value.lock) { value.valid && value.running }) {
        val count = recorder.read(chunk, 0, chunk.size, AudioRecord.READ_BLOCKING)
        if (count <= 0) { main.post { if (lease === value && value.running) invalidate() }; break }
        var full = false
        synchronized(value.lock) {
          if (value.valid && value.running) {
            val take = minOf(count, (value.pcm.size - value.length) / 2)
            for (index in 0 until take) { val bits = chunk[index].toInt(); value.pcm[value.length++] = bits.toByte(); value.pcm[value.length++] = (bits shr 8).toByte() }
            if (value.length >= value.pcm.size) { value.running = false; full = true }
          }
        }
        if (full) { main.post { complete(value.id) }; break }
      }
    } catch (_: Exception) { main.post { if (lease === value && value.running) invalidate() } }
    finally { chunk.fill(0); recorder.release() }
  }
  private fun stop(value: CaptureLease) {
    synchronized(value.lock) { value.running = false }
    timer?.let { main.removeCallbacks(it) }; timer = null
    val audio = value.audio; value.audio = null
    if (audio != null) { try { audio.stop() } catch (_: Exception) { }; if (!value.readerStarted) audio.release() }
  }
  private fun complete(id: String) { checkMain(); lease?.takeIf { it.id == id }?.let { stop(it) } }
  fun invalidate() {
    checkMain(); val value = lease ?: return; lease = null
    synchronized(value.lock) { value.valid = false; value.running = false; value.pcm.fill(0); value.pcm = ByteArray(0); value.length = 0 }
    stop(value)
  }
  fun cancel(id: String) { checkMain(); if (lease?.id == id) invalidate() }
  fun finish(id: String): Map<String, Any> {
    checkMain(); val value = current(id); complete(id)
    synchronized(value.lock) {
      if (!value.started || !value.valid || value.length == 0) { invalidate(); unavailable() }
      val result = mapOf("lease" to value.id, "epoch" to value.epoch, "encoding" to "pcm16le", "sampleRate" to value.rate, "channels" to 1, "base64" to Base64.encodeToString(value.pcm, 0, value.length, Base64.NO_WRAP))
      value.valid = false; value.pcm.fill(0); value.pcm = ByteArray(0); value.length = 0; lease = null; return result
    }
  }
}

/** Separate authored finite capture capability; no background service or automatic playback/resume. */
class JitNativeCaptureModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("JitNativeCapture")
    AsyncFunction("requestPermission") { promise: Promise -> Permissions.askForPermissionsWithPermissionsManager(appContext.permissions, promise, Manifest.permission.RECORD_AUDIO) }.runOnQueue(Queues.MAIN)
    AsyncFunction("prepare") { epoch: Double, ms: Double -> JitNativeCaptureRuntime.prepare(epoch, ms) }.runOnQueue(Queues.MAIN)
    AsyncFunction("start") { id: String -> JitNativeCaptureRuntime.start(appContext.reactContext ?: throw IllegalStateException("mobile_capture_unavailable"), id) }.runOnQueue(Queues.MAIN)
    AsyncFunction("finish") { id: String -> JitNativeCaptureRuntime.finish(id) }.runOnQueue(Queues.MAIN)
    AsyncFunction("cancel") { id: String -> JitNativeCaptureRuntime.cancel(id) }.runOnQueue(Queues.MAIN)
    OnDestroy { Handler(Looper.getMainLooper()).post { JitNativeCaptureRuntime.invalidate() } }
  }
}
