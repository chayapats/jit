import { openLocalVoice, type LocalVoiceConfig } from '../../src/s16/voice/local';
import { encodeCaptureWav } from '../../src/s16/voice/wav';

// Disposable controller for the real parent-SIGKILL/CLI-liveness test. No model or microphone is used.
if (process.env.JIT_LOCAL_VOICE_FIXTURE !== '1') throw Error('explicit_voice_fixture_required');
const input = JSON.parse(await Bun.stdin.text()) as { config: LocalVoiceConfig; scratch: string };
const engine = await openLocalVoice(input.config, input.scratch);
try { await engine.transcribe(encodeCaptureWav(new Float32Array(1600)), { signal: new AbortController().signal, guard() {}, started() {} }); }
finally { await engine.close(); }
