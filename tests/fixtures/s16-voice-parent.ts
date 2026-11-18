import { openLocalVoice, type LocalVoiceConfig } from '../../src/s16/voice/local';
import { encodeCaptureWav } from '../../src/s16/voice/wav';
import { VoiceService } from '../../src/s16/voice/service';
import { voiceRequestId } from '../../src/s16/voice/contracts';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Disposable controller for the real parent-SIGKILL/CLI-liveness test. No model or microphone is used.
if (process.env.JIT_LOCAL_VOICE_FIXTURE !== '1') throw Error('explicit_voice_fixture_required');
const input = JSON.parse(await Bun.stdin.text()) as { config: LocalVoiceConfig; scratch: string; journal?: string };
if (input.journal) {
  const service = await VoiceService.open({ path: input.journal, installationId: 'fixture', create: true, limits: { dailyMs: 120000, captureMs: 30000 }, now: () => 1000000,
    ownerGeneration: () => 1, requireOwner() {}, conversation() {}, reply() { throw Error('not_used'); }, engine: () => openLocalVoice(input.config, input.scratch) });
  try {
    const capture = await service.begin(() => ({}), 'conversation', { contract: 's16-voice-capture/v1', requestId: voiceRequestId(1000000) });
    writeFileSync(join(input.scratch, '..', 'capture.json'), JSON.stringify(capture), { mode: 0o600 });
    await service.transcribe(() => ({}), capture.id, encodeCaptureWav(new Float32Array(1600)), new AbortController().signal);
  } finally { await service.close(); }
} else {
  const engine = await openLocalVoice(input.config, input.scratch);
  try { await engine.transcribe(encodeCaptureWav(new Float32Array(1600)), { signal: new AbortController().signal, guard() {}, started() {} }); }
  finally { await engine.close(); }
}
