import { expect, test } from 'bun:test';
import { VoiceSegmenter } from '../src/s16/client/voice-segmentation';

function feed(segment: VoiceSegmenter, ms: number, amplitude: number, chunk = 320) {
  const events: ReturnType<VoiceSegmenter['push']>[] = []; let frames = Math.round(ms * 16);
  while (frames > 0) { const count = Math.min(frames, chunk); events.push(segment.push(new Float32Array(count).fill(amplitude))); frames -= count; }
  return events;
}
test('short noise cannot trigger barge-in; sustained PCM activity emits onset once and silence finalizes it', () => {
  const segment = new VoiceSegmenter();
  expect(feed(segment, 100, 0.1).some(event => event.onset)).toBe(false);
  feed(segment, 100, 0); expect(segment.hasSpeech).toBe(false);
  expect(feed(segment, 160, 0.1).filter(event => event.onset)).toHaveLength(1); expect(segment.hasSpeech).toBe(true);
  expect(feed(segment, 200, 0.2).some(event => event.onset)).toBe(false);
  expect(feed(segment, 880, 0).at(-1)?.end).toBeNull(); expect(feed(segment, 20, 0).at(-1)?.end).toBe('silence');
  expect(segment.push(new Float32Array(320).fill(1))).toEqual({ onset: false, end: 'silence' });
});
test('quiet ambient input reaches a finite no-speech result with no onset or retained audio', () => {
  const segment = new VoiceSegmenter();
  const events = feed(segment, 15000, 0.01, 1024);
  expect(events.some(event => event.onset)).toBe(false); expect(events.at(-1)?.end).toBe('no_speech'); expect(segment.hasSpeech).toBe(false);
});
test('invalid or oversized PCM refuses instead of poisoning activity counters', () => {
  for (const samples of [new Float32Array(0), new Float32Array(1025), new Float32Array([NaN]), new Float32Array([Infinity])]) {
    expect(() => new VoiceSegmenter().push(samples)).toThrow('voice_audio_invalid');
  }
});
