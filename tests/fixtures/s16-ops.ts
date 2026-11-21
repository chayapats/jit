import { join } from 'node:path';
import { ConnectionVault } from '../../src/exec/connections';
import type { LocalVoiceConfig, LocalVoiceEngine } from '../../src/s16/voice/local';
import { composedFixture } from './s15-composition';
import type { S15CompositionOptions } from '../../src/s15/composition';

/** All seventeen real owning runtime stores, with explicitly scripted guest/speech/network seams. */
export async function operationsFixture(nativeNotifications?: S15CompositionOptions['nativeNotifications']) {
  const artifact = { path: '/fixture/local-speech', sha256: 'f'.repeat(64) };
  const local: LocalVoiceConfig = { transcription: { executable: artifact, model: artifact, language: 'auto' }, synthesis: { kind: 'espeak', executable: artifact, voice: 'en' }, timeoutMs: 5000 };
  const engine: LocalVoiceEngine = { async available() { return true; }, async transcribe() { throw Error('unexpected speech'); }, async synthesize() { throw Error('unexpected speech'); }, async close() {} };
  return composedFixture('default', false, undefined, options => ({ ...options, files: { memory: true }, bots: {}, routines: {}, notifications: {}, computers: { idleStopMs: 1800000, sweepMs: 0 },
    connections: { vault: new ConnectionVault(join(options.directory, '..', 'connections-vault'), { forbidden: [options.directory] }) }, skills: {},
    voice: { local, quota: { dailyMs: 120000, captureMs: 30000 }, engine: async () => engine }, ...(nativeNotifications ? { nativeNotifications, origin: 'http://127.0.0.1:3099' } : {}) }));
}
