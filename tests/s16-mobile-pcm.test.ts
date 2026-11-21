import { expect, test } from "bun:test";
import { mobileCaptureWav } from "../src/s16/mobile/pcm";
import { captureWavInfo } from "../src/s16/voice/wav";

const expected = { lease: "fixture-one-use-lease", epoch: 17, maxMs: 30000 };
function pcm(rate: number, frames: number, value = 16384) {
  const bytes = Buffer.alloc(frames * 2); for (let frame = 0; frame < frames; frame++) bytes.writeInt16LE(value, frame * 2);
  return { lease: expected.lease, epoch: expected.epoch, encoding: "pcm16le", sampleRate: rate, channels: 1, base64: bytes.toString("base64") };
}
test("native actual 8/16/44.1/48/96 kHz converts the same one-second clip into canonical mono WAV", () => {
  for (const rate of [8000, 16000, 44100, 48000, 96000]) {
    const wav = mobileCaptureWav(pcm(rate, rate), expected); expect(captureWavInfo(wav)).toEqual({ frames: 16000, durationMs: 1000, bytes: 32044 });
    const view = new DataView(wav.buffer); expect(view.getInt16(44, true)).toBe(16384); expect(view.getInt16(wav.length - 2, true)).toBe(16384);
  }
  const wav = mobileCaptureWav(pcm(48000, 48000, -32768), expected); expect(new DataView(wav.buffer).getInt16(44, true)).toBe(-32768);
});
test("native capture refuses stale leases/epochs, unsupported formats, false duration and noncanonical base64", () => {
  const valid = pcm(48000, 48);
  for (const candidate of [{ ...valid, epoch: 18 }, { ...valid, lease: "old" }, { ...valid, channels: 2 }, { ...valid, sampleRate: 0 }, { ...valid, sampleRate: 48000.5 }, { ...valid, filename: "private.wav" }, { ...valid, base64: "AA==" }, { ...valid, base64: "AAA=" + "\n" }, { ...valid, base64: "AAB=" }, { ...valid, base64: "A=AA" }, { ...valid, base64: "" }]) expect(() => mobileCaptureWav(candidate, expected)).toThrow();
  expect(() => mobileCaptureWav(pcm(16000, 16001), { ...expected, maxMs: 1000 })).toThrow();
  expect(() => mobileCaptureWav(valid, { ...expected, maxMs: 30001 })).toThrow();
});
