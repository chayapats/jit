/** Canonical capture format: mono PCM16 at 16 kHz, bounded independently of client MIME/duration. */
export const captureAudio = Object.freeze({ sampleRate: 16000, channels: 1, bits: 16, durationMs: 30000, bytes: 960044 });

/** Safe public failure code; never carries audio, transcript or private host paths. */
export class VoiceAudioError extends Error {
  constructor(readonly code: 'voice_audio_invalid' | 'voice_audio_limit') { super(code); }
}

const tag = (bytes: Uint8Array, offset: number, value: string): boolean => [...value].every((letter, index) => bytes[offset + index] === letter.charCodeAt(0));
const invalid = (): never => { throw new VoiceAudioError('voice_audio_invalid'); };
const limit = (): never => { throw new VoiceAudioError('voice_audio_limit'); };

/**
 * Validate the complete canonical WAV before a local engine sees bytes. Rejects other codecs/chunks,
 * false lengths, alignment, trailing data and excess samples. Metadata is derived from actual bytes;
 * the caller still owns snapshotting its input before an async boundary.
 */
export function captureWavInfo(bytes: Uint8Array, maxDurationMs: number = captureAudio.durationMs): { frames: number; durationMs: number; bytes: number } {
  if (!Number.isSafeInteger(maxDurationMs) || maxDurationMs < 1 || maxDurationMs > captureAudio.durationMs) invalid();
  if (bytes.byteLength > captureAudio.bytes || bytes.byteLength > 44 + Math.floor(maxDurationMs * captureAudio.sampleRate / 1000) * 2) limit();
  if (bytes.byteLength < 46 || !tag(bytes, 0, 'RIFF') || !tag(bytes, 8, 'WAVE') || !tag(bytes, 12, 'fmt ') || !tag(bytes, 36, 'data')) invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), size = bytes.byteLength - 44;
  if (view.getUint32(4, true) !== bytes.byteLength - 8 || view.getUint32(16, true) !== 16 || view.getUint16(20, true) !== 1
    || view.getUint16(22, true) !== 1 || view.getUint32(24, true) !== captureAudio.sampleRate || view.getUint32(28, true) !== 32000
    || view.getUint16(32, true) !== 2 || view.getUint16(34, true) !== 16 || view.getUint32(40, true) !== size || size % 2 !== 0) invalid();
  return { frames: size / 2, durationMs: size / 2 * 1000 / captureAudio.sampleRate, bytes: bytes.byteLength };
}

/** Encode already resampled mono 16 kHz capture. Finite samples are clipped to PCM16; no codec/dependency is used. */
export function encodeCaptureWav(samples: Float32Array): Uint8Array {
  if (samples.length > captureAudio.sampleRate * captureAudio.durationMs / 1000) limit();
  if (!samples.length) invalid();
  const bytes = new Uint8Array(44 + samples.length * 2), view = new DataView(bytes.buffer);
  const write = (offset: number, text: string) => { for (let index = 0; index < text.length; index++) bytes[offset + index] = text.charCodeAt(index); };
  write(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); write(8, 'WAVE'); write(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, captureAudio.sampleRate, true);
  view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); write(36, 'data'); view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index]!; if (!Number.isFinite(sample)) invalid();
    const clipped = Math.min(1, Math.max(-1, sample)); view.setInt16(44 + index * 2, Math.round(clipped * (clipped < 0 ? 32768 : 32767)), true);
  }
  return bytes;
}
