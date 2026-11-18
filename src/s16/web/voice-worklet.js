// Fixed local capture code. No recognition service, network request, storage or approval operation.
class JitVoiceCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.maximum = Math.max(1, Math.min(480000, Math.floor(options.processorOptions?.maximumFrames ?? 480000)));
    this.count = 0; this.chunk = []; this.ended = false;
    this.ratio = sampleRate / 16000; this.needed = this.ratio; this.sum = 0;
    this.port.onmessage = event => { if (event.data?.kind === 'stop') this.end(); };
  }
  flush() {
    if (!this.chunk.length) return;
    const samples = Float32Array.from(this.chunk); this.chunk = [];
    this.port.postMessage({ kind: 'samples', samples }, [samples.buffer]);
  }
  end() { if (this.ended) return; this.ended = true; this.flush(); this.port.postMessage({ kind: 'ended' }); }
  process(inputs) {
    if (this.ended) return false;
    const channels = inputs[0]; if (!channels?.length) return true;
    for (let index = 0; index < channels[0].length && !this.ended; index++) {
      let value = 0; for (const channel of channels) value += channel[index] / channels.length;
      let remaining = 1;
      while (remaining > 1e-8 && !this.ended) {
        const weight = Math.min(remaining, this.needed); this.sum += value * weight; this.needed -= weight; remaining -= weight;
        if (this.needed <= 1e-8) {
          this.chunk.push(this.sum / this.ratio); this.sum = 0; this.needed = this.ratio; this.count++;
          if (this.chunk.length >= 1024) this.flush();
          if (this.count >= this.maximum) this.end();
        }
      }
    }
    return !this.ended;
  }
}
registerProcessor('jit-voice-capture', JitVoiceCapture);
