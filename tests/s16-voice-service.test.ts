import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppError } from '../src/errors';
import { VoiceService } from '../src/s16/voice/service';
import { voiceLimits, voiceRequestId, type VoicePlaybackCommand } from '../src/s16/voice/contracts';
import type { LocalVoiceEngine, VoiceProcessContext } from '../src/s16/voice/local';
import { encodeCaptureWav } from '../src/s16/voice/wav';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const signal = () => new AbortController().signal;
const wav = () => encodeCaptureWav(new Float32Array(1600));
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
async function gate(context: VoiceProcessContext, pending: Promise<void> | null) {
  if (!pending) return;
  let stop!: () => void;
  const abort = new Promise<never>((_, reject) => { stop = () => reject(new AppError('voice_cancelled')); context.signal.addEventListener('abort', stop, { once: true }); if (context.signal.aborted) stop(); });
  try { await Promise.race([pending, abort]); } finally { context.signal.removeEventListener('abort', stop); }
}

async function fixture(dailyMs = 120000, captureMs = 30000) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'jit-voice-service-'))), owner = Object.freeze({});
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  let at = 1000000, generation = 1, allowed = true, source = true, available = true, text = 'A currently published result.', revision = 1;
  let transcriptions = 0, syntheses = 0, recording: Promise<void> | null = null, speaking: Promise<void> | null = null, availability: Promise<void> | null = null, closeBarrier: Promise<void> | null = null, beforeStart = false;
  const entered = Promise.withResolvers<void>(), speechEntered = Promise.withResolvers<void>();
  const makeEngine = (): LocalVoiceEngine => ({
    async available() { await availability; return available; },
    async transcribe(_wav, context) { if (beforeStart) throw new AppError('voice_unavailable'); context.guard(); context.started(); transcriptions++; entered.resolve(); await gate(context, recording); context.guard(); return 'Approve this draft only.'; },
    async synthesize(_text, context) { context.guard(); context.started(); syntheses++; speechEntered.resolve(); await gate(context, speaking); context.guard(); return { wav: wav(), durationMs: 100 }; },
    async close() { await closeBarrier; },
  });
  const options = (create: boolean) => ({ path: join(root, 'voice.sqlite'), installationId: 'fixture', create, limits: { dailyMs, captureMs }, engine: async () => makeEngine(),
    now: () => at, ownerGeneration: () => generation, requireOwner(actor: object) { if (actor !== owner || !allowed) throw new AppError('authentication_required', 401); }, conversation(_actor: object, id: string) { if (id !== 'conversation') throw new AppError('outside_scope'); },
    reply() { if (!source) throw new AppError('source_withdrawn', 403); return { text, revision }; } });
  let service = await VoiceService.open(options(true)); cleanup.push(() => service.close());
  const f = { owner: () => owner, entered: entered.promise, speechEntered: speechEntered.promise, get service() { return service; }, get transcriptions() { return transcriptions; }, get syntheses() { return syntheses; },
    set recording(value: Promise<void> | null) { recording = value; }, set speaking(value: Promise<void> | null) { speaking = value; }, set availability(value: Promise<void> | null) { availability = value; }, set closeBarrier(value: Promise<void> | null) { closeBarrier = value; },
    set beforeStart(value: boolean) { beforeStart = value; }, set allowed(value: boolean) { allowed = value; }, set source(value: boolean) { source = value; }, set generation(value: number) { generation = value; }, set at(value: number) { at = value; },
    command: () => ({ contract: 's16-voice-capture/v1' as const, requestId: voiceRequestId(at) }),
    playback: (): VoicePlaybackCommand => ({ contract: 's16-voice-playback/v1', requestId: voiceRequestId(at), conversationId: 'conversation', targetRequestId: 'request', targetRevision: revision, textSha256: hash(text) }),
    async reopen() { await service.close(); service = await VoiceService.open(options(false)); },
  }; return f;
}

test('Mic reserve/retry/cancel creates only a private draft; status starts no speech', async () => {
  const f = await fixture(), command = f.command();
  expect((await f.service.status(f.owner)).usage).toMatchObject({ chargedMs: 0, reservedMs: 0 });
  const capture = await f.service.begin(f.owner, 'conversation', command);
  expect(await f.service.begin(f.owner, 'conversation', command)).toEqual(capture);
  expect((await f.service.status(f.owner)).usage.reservedMs).toBe(30000); expect(f.transcriptions).toBe(0); expect(f.syntheses).toBe(0);
  expect((await f.service.cancel(f.owner, capture.id)).state).toBe('cancelled');
  expect((await f.service.status(f.owner)).usage).toMatchObject({ chargedMs: 0, reservedMs: 0 });
});

test('aborting Mic intent while route health is pending cannot reserve quota later', async () => {
  const f = await fixture(), release = Promise.withResolvers<void>(), stop = new AbortController(); f.availability = release.promise;
  const pending = f.service.begin(f.owner, 'conversation', f.command(), stop.signal);
  stop.abort(); release.resolve(); await expect(pending).rejects.toThrow('voice_cancelled');
  expect((await f.service.status(f.owner)).usage).toMatchObject({ chargedMs: 0, reservedMs: 0 }); expect(f.transcriptions).toBe(0);
});

test('one snapshotted WAV has one transcription across concurrent retry, with no approval or work admission', async () => {
  const f = await fixture(), release = Promise.withResolvers<void>(); f.recording = release.promise;
  const capture = await f.service.begin(f.owner, 'conversation', f.command()), input = wav();
  const first = f.service.transcribe(f.owner, capture.id, input, signal()); await f.entered;
  const second = f.service.transcribe(f.owner, capture.id, input, signal()); input.fill(0); release.resolve();
  const result = await first; expect(await second).toEqual(result); expect(result.text).toBe('Approve this draft only.'); expect(result.capture.state).toBe('ready');
  expect(f.transcriptions).toBe(1); expect(result.usage).toMatchObject({ chargedMs: 100, reservedMs: 0, conservativeMs: 0 });
  const changed = wav(); changed[44] = 1; expect(() => f.service.transcribe(f.owner, capture.id, changed, signal())).toThrow('request_id_conflict');
  f.generation = 2; expect(() => f.service.transcribe(f.owner, capture.id, wav(), signal())).toThrow('voice_stale');
});

test('permission/capture expiry releases an unused reservation and a pruned old identity never becomes a fresh Mic intent', async () => {
  const f = await fixture(), command = f.command(), capture = await f.service.begin(f.owner, 'conversation', command);
  f.at = capture.expiresAt;
  expect(f.service.inspect(f.owner, capture.id).state).toBe('expired'); expect((await f.service.status(f.owner)).usage.reservedMs).toBe(0);
  expect(() => f.service.transcribe(f.owner, capture.id, wav(), signal())).toThrow('voice_capture_expired');
  f.at = capture.expiresAt + voiceLimits.retentionMs + 1;
  const fresh = await f.service.begin(f.owner, 'conversation', f.command()); await f.service.cancel(f.owner, fresh.id);
  await expect(f.service.begin(f.owner, 'conversation', command)).rejects.toThrow('voice_request_expired'); expect(f.transcriptions).toBe(0);
});

test('local input budget persists across restart and clock rewind cannot reset the current quota day', async () => {
  const f = await fixture(100, 100), capture = await f.service.begin(f.owner, 'conversation', f.command());
  await f.service.transcribe(f.owner, capture.id, wav(), signal()); await f.reopen();
  await expect(f.service.begin(f.owner, 'conversation', f.command())).rejects.toThrow('voice_budget_exhausted');
  f.at = 86400000 + 1000000; const next = await f.service.begin(f.owner, 'conversation', f.command()); await f.service.cancel(f.owner, next.id);
  f.at = 1000000; const current = await f.service.status(f.owner); expect(current.usage.day).toBe('1970-01-02'); expect(current.serverTime).toBe(87400000);
});

test('withdrawal during local synthesis prevents audio publication and retains conservative usage across restart', async () => {
  const f = await fixture(), release = Promise.withResolvers<void>(); f.speaking = release.promise;
  const command = f.playback(), operation = f.service.playback(f.owner, command, signal()).catch(error => error);
  await f.speechEntered; f.source = false; release.resolve();
  expect(await operation).toMatchObject({ code: 'source_withdrawn' });
  expect((await f.service.status(f.owner)).usage).toMatchObject({ chargedMs: 60000, reservedMs: 0, conservativeMs: 60000 });
  f.source = true; await f.reopen(); await expect(f.service.playback(f.owner, command, signal())).rejects.toThrow('voice_outcome_unknown'); expect(f.syntheses).toBe(1);
});

test('two playback calls racing route health reuse one identity and one actual synthesis', async () => {
  const f = await fixture(), available = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); f.availability = available.promise; f.speaking = release.promise;
  const command = f.playback(), one = f.service.playback(f.owner, command, signal()), two = f.service.playback(f.owner, command, signal());
  available.resolve(); await f.speechEntered; release.resolve();
  expect(await two).toEqual(await one); expect(f.syntheses).toBe(1); expect((await f.service.status(f.owner)).usage.chargedMs).toBe(100);
});

test('failure before process start releases quota and repeated close callers both wait for physical settlement', async () => {
  const f = await fixture(), capture = await f.service.begin(f.owner, 'conversation', f.command()); f.beforeStart = true;
  await expect(f.service.transcribe(f.owner, capture.id, wav(), signal())).rejects.toThrow('voice_unavailable');
  expect((await f.service.status(f.owner)).usage).toMatchObject({ chargedMs: 0, reservedMs: 0 });
  const closed = Promise.withResolvers<void>(); f.closeBarrier = closed.promise;
  const first = f.service.close(), second = f.service.close(); let finished = false; void second.then(() => { finished = true; });
  await Promise.resolve(); expect(finished).toBe(false); closed.resolve(); await Promise.all([first, second]); expect(finished).toBe(true);
});
