import { expect, test } from 'bun:test';
import { captureAudio, captureWavInfo, encodeCaptureWav } from '../src/s16/voice/wav';

// Independently specified PCM fixture: [-32768, 0, 32767] in a standard 16 kHz mono WAV.
const fixture = (): Uint8Array => Uint8Array.from(Buffer.from('524946462a00000057415645666d74201000000001000100803e0000007d000002001000646174610600000000800000ff7f', 'hex'));

test('actual header/data bytes determine capture duration, including nonzero byte-offset views', () => {
  const wav = fixture(), wrapped = new Uint8Array(wav.length + 14); wrapped.set(wav, 7);
  expect(captureWavInfo(wav)).toEqual({ frames: 3, durationMs: 0.1875, bytes: 50 });
  expect(captureWavInfo(wrapped.subarray(7, 7 + wav.length))).toEqual(captureWavInfo(wav));
  expect(encodeCaptureWav(new Float32Array([-1, 0, 1]))).toEqual(wav);
});

test('codec, layout, declared sizes and trailing bytes cannot smuggle another input into the local engine', () => {
  for (const [offset, value] of [[0, 0], [8, 0], [12, 0], [16, 18], [20, 3], [22, 2], [24, 0], [28, 1], [32, 4], [34, 8], [36, 0], [40, 4], [4, 0]] as const) {
    const bytes = fixture(); bytes[offset] = value; expect(() => captureWavInfo(bytes)).toThrow('voice_audio_invalid');
  }
  expect(() => captureWavInfo(new Uint8Array())).toThrow('voice_audio_invalid');
  expect(() => captureWavInfo(fixture().subarray(0, 49))).toThrow('voice_audio_invalid');
  const trailing = new Uint8Array(52); trailing.set(fixture()); expect(() => captureWavInfo(trailing)).toThrow('voice_audio_invalid');
});

test('exact hard duration/byte bound accepts 30 seconds and refuses an additional sample', () => {
  const maximum = encodeCaptureWav(new Float32Array(480000));
  expect(maximum.length).toBe(captureAudio.bytes); expect(captureWavInfo(maximum).durationMs).toBe(30000);
  expect(() => encodeCaptureWav(new Float32Array(480001))).toThrow('voice_audio_limit');
  const tooLarge = new Uint8Array(maximum.length + 2); tooLarge.set(maximum);
  expect(() => captureWavInfo(tooLarge)).toThrow('voice_audio_limit');
  expect(() => captureWavInfo(encodeCaptureWav(new Float32Array(16001)), 1000)).toThrow('voice_audio_limit');
  expect(captureWavInfo(encodeCaptureWav(new Float32Array(16000)), 1000).durationMs).toBe(1000);
});

test('invalid limits/nonfinite audio refuse, while finite out-of-range device samples clip without wrapping', () => {
  for (const duration of [0, -1, 0.5, NaN, Infinity, 30001]) expect(() => captureWavInfo(fixture(), duration)).toThrow('voice_audio_invalid');
  for (const value of [NaN, Infinity, -Infinity]) expect(() => encodeCaptureWav(new Float32Array([value]))).toThrow('voice_audio_invalid');
  expect(() => encodeCaptureWav(new Float32Array())).toThrow('voice_audio_invalid');
  expect(encodeCaptureWav(new Float32Array([-4, 0, 4]))).toEqual(fixture());
});
