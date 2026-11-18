import { afterEach, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { JitClient } from '../src/s16/client';
import type { LocalVoiceConfig, LocalVoiceEngine } from '../src/s16/voice/local';
import { encodeCaptureWav } from '../src/s16/voice/wav';
import { composedFixture } from './fixtures/s15-composition';
import { mail } from './fixtures/s15-effects';

type Fixture = Awaited<ReturnType<typeof composedFixture>>;
const fixtures: Fixture[] = [];
afterEach(async () => { for (const f of fixtures.splice(0).reverse()) await f.close(); });
const origin = 'http://localhost:3099', audio = () => encodeCaptureWav(new Float32Array(1600));
const artifact = { path: '/fixture/local-speech', sha256: 'f'.repeat(64) };
const local: LocalVoiceConfig = { transcription: { executable: artifact, model: artifact, language: 'auto' }, synthesis: { kind: 'espeak', executable: artifact, voice: 'en' }, timeoutMs: 5000 };
async function fixture(enabled = true) {
  let transcriptions = 0, syntheses = 0;
  const engine: LocalVoiceEngine = { async available() { return true; }, async transcribe(_input, context) { context.guard(); context.started(); transcriptions++; return 'Approve this draft only.'; }, async synthesize(_text, context) { context.guard(); context.started(); syntheses++; return { wav: audio(), durationMs: 100 }; }, async close() {} };
  const f = await composedFixture('default', false, undefined, options => ({ ...options, ...(enabled ? { voice: { local, quota: { dailyMs: 120000, captureMs: 30000 }, engine: async () => engine } } : {}) })); fixtures.push(f);
  const fetch = async (request: Request) => {
    const path = new URL(request.url).pathname, headers = Object.fromEntries(request.headers);
    if (request.method === 'POST' && request.headers.get('content-type') === 'application/octet-stream') return f.raw(path, await request.arrayBuffer(), headers);
    return f.request(path, request.method, request.method === 'POST' ? await request.json() : undefined, headers);
  };
  const client = new JitClient({ origin, fetch }); await client.bootstrap();
  return { f, client, fetch, get transcriptions() { return transcriptions; }, get syntheses() { return syntheses; } };
}

test('the actual composed client keeps a transcript editable and outside CHAT/model history until ordinary Send', async () => {
  const h = await fixture(), { f, client } = h, before = f.service.conversation.store.db.query<{ n: number }, []>('SELECT count(*) AS n FROM requests').get()!.n;
  expect((await client.bootstrap()).capabilities.voice).toMatchObject({ available: true, route: 'local' });
  const status = await client.voiceStatus(), capture = await client.beginDictation('conversation', client.prepareDictation(status.serverTime));
  const transcript = await client.transcribeDictation(capture, audio());
  expect(transcript.text).toBe('Approve this draft only.'); expect(h.transcriptions).toBe(1); expect(f.modelPrompts).toEqual([]); expect(f.interpreterPrompts).toEqual([]);
  expect(f.service.conversation.store.db.query<{ n: number }, []>('SELECT count(*) AS n FROM requests').get()!.n).toBe(before);
  await client.cancelVoice(capture); expect((await client.voiceStatus()).usage).toMatchObject({ chargedMs: 100, reservedMs: 0 });
  expect(f.service.conversation.store.db.query<{ n: number }, []>('SELECT count(*) AS n FROM requests').get()!.n).toBe(before);
  const command = client.prepareMessage('conversation', transcript.text + ' Edited before sending.'); await client.send(command); await f.service.conversation.drain();
  const row = (await client.snapshot('conversation')).conversation.rows[0]!; expect(row.ownerMessage).toBe(command.text); expect(row.result).not.toBeNull();
  const playback = client.playReply(await client.preparePlayback((await client.voiceStatus()).serverTime, 'conversation', row.requestId, row.revision, row.result!.text));
  expect((await playback).wavBase64).toBe(Buffer.from(audio()).toString('base64')); expect(h.syntheses).toBe(1);
});

test('transcribed approval words use ordinary text ingress and cannot approve an existing held action', async () => {
  const h = await fixture(), { f, client } = h;
  f.interpretation = { intent: 'execute', purposeId: 'purpose', resourceIds: ['account'], access: 'effect', subject: null };
  f.script = [{ type: 'tool_call', id: 'email', name: 'gmail_prepare_send', arguments: { ...mail() } }];
  const original = client.prepareMessage('conversation', 'Send the prepared email.'); await client.send(original); await f.service.conversation.drain();
  expect((await client.request(original.requestId)).row.slips[0]?.state).toBe('pending');
  const capture = await client.beginDictation('conversation', client.prepareDictation((await client.voiceStatus()).serverTime)), transcript = await client.transcribeDictation(capture, audio());
  f.interpretation = { intent: 'inspect', purposeId: 'purpose', resourceIds: ['computer'], access: 'read', subject: null }; f.script = [{ type: 'text', text: 'The transcript is ordinary text.' }];
  await client.send(client.prepareMessage('conversation', transcript.text)); await f.service.conversation.drain();
  expect(f.google.sent.size).toBe(0); expect((await client.request(original.requestId)).row.slips[0]?.state).toBe('pending');
});

test('voice raw-body ingress reauthenticates after streaming and refuses oversized or malformed WAV before processing', async () => {
  const h = await fixture(), { f, client } = h, capture = await client.beginDictation('conversation', client.prepareDictation((await client.voiceStatus()).serverTime));
  expect((await f.raw(`/api/s16/client/voice/${capture.id}/transcribe`, new Uint8Array(960045))).status).toBe(413);
  expect(await (await f.raw(`/api/s16/client/voice/${capture.id}/transcribe`, new Uint8Array(64))).json()).toEqual({ error: 'voice_audio_invalid' });
  const bytes = audio(), reading = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let pull = 0;
  const stream = new ReadableStream<Uint8Array>({ async pull(controller) { if (pull++ === 0) controller.enqueue(bytes.subarray(0, 44)); else { reading.resolve(); await release.promise; controller.enqueue(bytes.subarray(44)); controller.close(); } } });
  const pending = f.raw(`/api/s16/client/voice/${capture.id}/transcribe`, stream); await reading.promise; f.generation = 2; release.resolve(); const response = await pending;
  expect(await response.json()).toEqual({ error: 'voice_stale' }); expect(h.transcriptions).toBe(0);
});

test('withdrawal after synthesis resolves but before HTTP release withholds the cached audio at the final publisher', async () => {
  const { f, client } = await fixture(); await client.send(client.prepareMessage('conversation', 'Run a private diagnostic')); await f.service.conversation.drain();
  const row = (await client.snapshot('conversation')).conversation.rows[0]!, voice = f.service.voice!, original = voice.playback.bind(voice);
  voice.playback = async (...args) => { const result = await original(...args); f.dataSources[0]!.active = false; return result; };
  const command = await client.preparePlayback((await client.voiceStatus()).serverTime, 'conversation', row.requestId, row.revision, row.result!.text);
  await expect(client.playReply(command)).rejects.toMatchObject({ code: 'voice_result_unavailable', status: 409 });
  expect((await client.request(row.requestId)).row.result).toBeNull();
});

test('late voice JSON after client clear cannot restore private draft text or the prior session', async () => {
  const h = await fixture(), { f, client: first } = h, capture = await first.beginDictation('conversation', first.prepareDictation((await first.voiceStatus()).serverTime));
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const client = new JitClient({ origin, fetch: async request => { const response = await h.fetch(request); if (new URL(request.url).pathname.endsWith('/transcribe')) { entered.resolve(); await release.promise; } return response; } });
  await client.bootstrap(); const pending = client.transcribeDictation(capture, audio()); await entered.promise; client.clear(); release.resolve();
  await expect(pending).rejects.toMatchObject({ code: 'client_response_stale', outcome: 'unknown', requestId: capture.id }); expect(h.transcriptions).toBe(1);
  expect(f.service.conversation.store.db.query<{ n: number }, []>('SELECT count(*) AS n FROM requests').get()!.n).toBe(0);
});

test('omitting voice preserves text service and creates no voice journal', async () => {
  const { f, client } = await fixture(false);
  expect((await client.bootstrap()).capabilities.voice).toMatchObject({ available: false }); expect(existsSync(join(f.directory, 'voice.sqlite'))).toBe(false);
  await expect(client.voiceStatus()).rejects.toMatchObject({ code: 'voice_unavailable', status: 503 });
  await client.send(client.prepareMessage('conversation', 'Continue through ordinary text.')); await f.service.conversation.drain();
  expect((await client.snapshot('conversation')).conversation.rows[0]!.result).not.toBeNull();
});
