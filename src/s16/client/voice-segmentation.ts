import { voiceCallLimits } from '../voice/call-contracts';

/** One finite PCM window; activity is segmentation data, never speaker identity, a send or an approval. */
export class VoiceSegmenter {
  private frames = 0;
  private activeFrames = 0;
  private quietFrames = 0;
  private heard = false;
  private ended: 'silence' | 'no_speech' | null = null;
  /** True only after enough consecutive actual 16 kHz activity; drafts still require an owner Send turn. */
  get hasSpeech(): boolean { return this.heard; }
  /** Consume one bounded worklet chunk. Onset is emitted once; completion retains no PCM or transcript. */
  push(samples: Float32Array): { onset: boolean; end: 'silence' | 'no_speech' | null } {
    if (this.ended) return { onset: false, end: this.ended };
    if (!samples.length || samples.length > 1024 || this.frames + samples.length > 480000) throw Error('voice_audio_invalid');
    let squared = 0;
    for (const sample of samples) { if (!Number.isFinite(sample)) throw Error('voice_audio_invalid'); const value = Math.min(1, Math.max(-1, sample)); squared += value * value; }
    this.frames += samples.length;
    const active = Math.sqrt(squared / samples.length) >= voiceCallLimits.activityRms;
    this.activeFrames = active ? this.activeFrames + samples.length : 0;
    this.quietFrames = active ? 0 : this.quietFrames + samples.length;
    const onset = !this.heard && this.activeFrames >= voiceCallLimits.onsetMs * 16;
    if (onset) this.heard = true;
    if (this.heard && this.quietFrames >= voiceCallLimits.silenceMs * 16) this.ended = 'silence';
    else if (!this.heard && this.frames >= voiceCallLimits.noSpeechMs * 16) this.ended = 'no_speech';
    return { onset, end: this.ended };
  }
}
