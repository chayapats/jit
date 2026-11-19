import { captureAudio, captureWavInfo, encodeCaptureWav, VoiceAudioError } from "../voice/wav";

/** Native RAM-only finished capture; actual sample rate is never inferred from requested hardware settings. */
export interface MobilePcm { lease: string; epoch: number; encoding: "pcm16le"; sampleRate: number; channels: 1; base64: string }
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const invalid = (): never => { throw new VoiceAudioError("voice_audio_invalid"); };
/** Strict bounded base64 decoding without Node/Blob/global codec dependencies in Hermes. */
function decode(value: string, limit: number): Uint8Array {
  if (!value.length || value.length % 4 || value.length > Math.ceil(limit / 3) * 4 || /[^A-Za-z0-9+/=]/.test(value)) return invalid();
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  if (value.slice(0, value.length - padding).includes("=")) return invalid();
  const length = value.length / 4 * 3 - padding; if (length < 2 || length > limit || length % 2) return invalid();
  if (padding === 2 && (alphabet.indexOf(value.at(-3)!) & 15) || padding === 1 && (alphabet.indexOf(value.at(-2)!) & 3)) return invalid();
  const bytes = new Uint8Array(length);
  for (let input = 0, output = 0; input < value.length; input += 4) {
    const bits = alphabet.indexOf(value[input]!) << 18 | alphabet.indexOf(value[input + 1]!) << 12 | (value[input + 2] === "=" ? 0 : alphabet.indexOf(value[input + 2]!)) << 6 | (value[input + 3] === "=" ? 0 : alphabet.indexOf(value[input + 3]!));
    for (let shift = 16; shift >= 0 && output < length; shift -= 8) bytes[output++] = bits >>> shift & 255;
  }
  return bytes;
}
/** Bounded area-average resampling of actual mono PCM. Never changes clip duration by assuming 48/44.1 kHz. */
export function mobileCaptureWav(raw: unknown, expected: { lease: string; epoch: number; maxMs: number }): Uint8Array {
  if (!Number.isSafeInteger(expected.maxMs) || expected.maxMs < 1 || expected.maxMs > captureAudio.durationMs || !raw || typeof raw !== "object" || Array.isArray(raw)) return invalid();
  const value = raw as MobilePcm;
  if (Object.keys(value).sort().join() !== "base64,channels,encoding,epoch,lease,sampleRate" || value.lease !== expected.lease || value.epoch !== expected.epoch || !Number.isSafeInteger(value.epoch) || value.epoch < 0 || value.encoding !== "pcm16le" || value.channels !== 1 || !Number.isSafeInteger(value.sampleRate) || value.sampleRate < 8000 || value.sampleRate > 96000 || typeof value.base64 !== "string") return invalid();
  const bytes = decode(value.base64, Math.floor(value.sampleRate * expected.maxMs / 1000) * 2), input = new DataView(bytes.buffer);
  try {
    const ratio = value.sampleRate / captureAudio.sampleRate, frames = bytes.length / 2, count = Math.floor(frames / ratio);
    if (!count) return invalid(); const samples = new Float32Array(count);
    for (let output = 0; output < count; output++) {
      const start = output * ratio, end = (output + 1) * ratio; let sum = 0;
      for (let source = Math.floor(start); source < Math.ceil(end); source++) {
        const pcm = input.getInt16(Math.min(source, frames - 1) * 2, true), weight = Math.max(0, Math.min(end, source + 1) - Math.max(start, source));
        sum += pcm / (pcm < 0 ? 32768 : 32767) * weight;
      }
      samples[output] = sum / ratio;
    }
    const wav = encodeCaptureWav(samples); samples.fill(0); captureWavInfo(wav, expected.maxMs); return wav;
  } finally { bytes.fill(0); }
}
