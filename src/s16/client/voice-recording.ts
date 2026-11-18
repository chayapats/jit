import { encodeCaptureWav } from '../voice/wav';

/** Fixed authenticated same-origin AudioWorklet module; callers never supply scripts or a remote recognizer. */
export const voiceWorkletPath = '/s16/voice-worklet.js';
/** One finite local microphone lease. Stop produces a draft clip; cancel discards it and never submits text. */
export interface VoiceRecording { done: Promise<Uint8Array>; stop(): void; cancel(): Promise<void> }
const failure = (code: string) => new Error(code);
const stopTracks = (stream?: MediaStream) => { for (const track of stream?.getTracks() ?? []) track.stop(); };

/** Explicit gesture-only capture with late-permission fencing, finite PCM buffers and native track/node cleanup. */
export async function startVoiceRecording(options: { signal: AbortSignal; durationMs: number; deadline?: number; progress(ms: number): void }): Promise<VoiceRecording> {
  if (!navigator.mediaDevices?.getUserMedia || typeof AudioContext !== 'function' || typeof AudioWorkletNode !== 'function') throw failure('voice_capture_unsupported');
  if (!Number.isFinite(options.durationMs) || options.durationMs < 1 || options.durationMs > 30000) throw failure('voice_capture_expired');
  if (options.signal.aborted) throw failure('voice_cancelled');
  let stream: MediaStream | undefined, context: AudioContext | undefined, source: MediaStreamAudioSourceNode | undefined, node: AudioWorkletNode | undefined, silent: GainNode | undefined;
  const deadline = options.deadline ?? performance.now() + options.durationMs + 15000;
  let stopping = false, finished = false, frames = 0, maximum = Math.floor(options.durationMs * 16), chunks: Float32Array[] = [];
  let timeout: ReturnType<typeof setTimeout> | undefined, watchdog: ReturnType<typeof setTimeout> | undefined;
  const complete = Promise.withResolvers<Uint8Array>(); void complete.promise.catch(() => {});
  const interrupted = Promise.withResolvers<never>(); void interrupted.promise.catch(() => {});
  let closing: Promise<void> | null = null;
  const close = (): Promise<void> => {
    stopping = true; stopTracks(stream); clearTimeout(timeout); clearTimeout(watchdog);
    if (node) { node.port.onmessage = null; node.port.close(); node.disconnect(); } source?.disconnect(); silent?.disconnect();
    return closing ??= (async () => { if (context && context.state !== 'closed') await context.close().catch(() => {}); })();
  };
  const refuse = async (code: string) => { interrupted.reject(failure(code)); if (finished) return; finished = true; chunks = []; await close(); complete.reject(failure(code)); };
  const abort = () => { void refuse('voice_cancelled'); };
  options.signal.addEventListener('abort', abort, { once: true });
  const done = complete.promise.finally(() => options.signal.removeEventListener('abort', abort)); void done.catch(() => {});
  timeout = setTimeout(() => { void refuse('voice_capture_expired'); }, Math.max(0, deadline - performance.now()));
  try {
    const pending = navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
    // A cancelled permission prompt may resolve later. Its stream is stopped even when this caller already returned.
    void pending.then(value => { if (options.signal.aborted || finished) stopTracks(value); }, () => {});
    stream = await Promise.race([pending, interrupted.promise]);
    if (options.signal.aborted || finished) { stopTracks(stream); throw failure('voice_cancelled'); }
    const lost = () => { if (!stopping) void refuse('voice_permission_lost'); };
    for (const track of stream.getAudioTracks()) { track.addEventListener('ended', lost, { once: true }); track.addEventListener('mute', lost, { once: true }); }
    context = new AudioContext(); await Promise.race([context.audioWorklet.addModule(voiceWorkletPath, { credentials: 'same-origin' }), interrupted.promise]);
    if (options.signal.aborted || finished) throw failure('voice_cancelled');
    maximum = Math.floor(Math.min(options.durationMs, deadline - performance.now()) * 16); if (maximum < 1) throw failure('voice_capture_expired');
    node = new AudioWorkletNode(context, 'jit-voice-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { maximumFrames: maximum } });
    const finish = async () => {
      if (finished) return; finished = true;
      try {
        if (!frames) throw failure('voice_audio_empty');
        const samples = new Float32Array(frames); let at = 0; for (const chunk of chunks) { samples.set(chunk, at); at += chunk.length; }
        chunks = []; const wav = encodeCaptureWav(samples); await close();
        if (options.signal.aborted) throw failure('voice_cancelled'); complete.resolve(wav);
      } catch (error) { chunks = []; await close(); complete.reject(error); }
    };
    node.port.onmessage = event => {
      if (finished || options.signal.aborted) return;
      const data = event.data;
      if (data?.kind === 'samples' && data.samples instanceof Float32Array && data.samples.length > 0 && data.samples.length <= 1024 && frames + data.samples.length <= maximum) { chunks.push(data.samples); frames += data.samples.length; options.progress(frames / 16); }
      else if (data?.kind === 'ended') void finish();
      else void refuse('voice_audio_invalid');
    };
    source = context.createMediaStreamSource(stream); silent = context.createGain(); silent.gain.value = 0; source.connect(node); node.connect(silent); silent.connect(context.destination);
    await Promise.race([context.resume(), interrupted.promise]); if (options.signal.aborted) throw failure('voice_cancelled');
    const stop = () => { if (finished || stopping) return; stopping = true; stopTracks(stream); clearTimeout(timeout); node!.port.postMessage({ kind: 'stop' }); watchdog = setTimeout(() => { void refuse('voice_capture_unavailable'); }, 1500); };
    if (!finished) { clearTimeout(timeout); timeout = setTimeout(stop, Math.max(0, Math.min(options.durationMs, deadline - performance.now()))); }
    return { done, stop, async cancel() { await refuse('voice_cancelled'); await close(); } };
  } catch (error) {
    const name = error instanceof Error ? error.name : '', code = error instanceof Error && /^voice_[a-z_]+$/.test(error.message) ? error.message : name === 'NotAllowedError' ? 'voice_permission_denied' : ['NotFoundError', 'NotReadableError'].includes(name) ? 'voice_microphone_unavailable' : 'voice_capture_unavailable';
    await refuse(code); await close(); throw failure(code);
  }
}
