import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from '../src/errors';
import { JitClient } from '../src/s16/client';
import { VoiceService } from '../src/s16/voice/service';
import { voiceRequestId } from '../src/s16/voice/contracts';
import { voiceCallLimits } from '../src/s16/voice/call-contracts';
import type { LocalVoiceConfig, LocalVoiceEngine, VoiceProcessContext } from '../src/s16/voice/local';
import { encodeCaptureWav } from '../src/s16/voice/wav';
import { conversationOwnerView, conversationRequestView } from '../src/s15/conversation/owner-view';
import { composedFixture } from './fixtures/s15-composition';
import { mail } from './fixtures/s15-effects';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const artifact = { path: '/fixture/local-voice', sha256: 'f'.repeat(64) };
const local: LocalVoiceConfig = { transcription: { executable: artifact, model: artifact, language: 'auto' }, synthesis: { kind: 'espeak', executable: artifact, voice: 'en' }, timeoutMs: 5000 };
const wav = () => encodeCaptureWav(new Float32Array(1600));
const count = (f: Awaited<ReturnType<typeof composedFixture>>) => f.service.conversation.store.db.query<{ n: number }, []>('SELECT count(*) AS n FROM requests').get()!.n;
async function barrier(context: VoiceProcessContext, pending: Promise<void> | null) {
  if (!pending) return;
  let stop!: () => void;
  const aborted = new Promise<never>((_, reject) => { stop = () => reject(new AppError('voice_cancelled')); context.signal.addEventListener('abort', stop, { once: true }); if (context.signal.aborted) stop(); });
  try { await Promise.race([pending, aborted]); } finally { context.signal.removeEventListener('abort', stop); }
}
async function fixture(dailyMs = 600000) {
  let spoken = 0, heard = 0, speaking: Promise<void> | null = null, availability: Promise<void> | null = null, loseTurn = false;
  const entered = Promise.withResolvers<void>(), inspecting = Promise.withResolvers<void>();
  const engine: LocalVoiceEngine = { async available() { if (availability) { inspecting.resolve(); await availability; } return true; }, async transcribe(_bytes, context) { context.guard(); context.started(); heard++; return 'Approve this quoted draft only.'; }, async synthesize(_text, context) { context.guard(); context.started(); spoken++; entered.resolve(); await barrier(context, speaking); context.guard(); return { wav: encodeCaptureWav(new Float32Array(16000)), durationMs: 1000 }; }, async close() {} };
  const f = await composedFixture('default', false, undefined, o => ({ ...o, voice: { local, quota: { dailyMs, captureMs: 30000 }, engine: async () => engine } })); cleanup.push(() => f.close());
  const client = new JitClient({ origin: 'http://localhost:3099', async fetch(request) {
    const url = new URL(request.url), headers = Object.fromEntries(request.headers);
    const response = request.headers.get('content-type') === 'application/octet-stream' ? await f.raw(url.pathname, await request.arrayBuffer(), headers)
      : await f.request(url.pathname + url.search, request.method, request.method === 'POST' ? await request.json() : undefined, headers);
    if (loseTurn && url.pathname.endsWith('/turns')) { loseTurn = false; throw Error('controlled_response_loss'); } return response;
  } });
  await client.bootstrap();
  const start = async () => client.beginVoiceCall('conversation', client.prepareVoiceCall((await client.voiceStatus()).serverTime));
  const capture = async (call: Awaited<ReturnType<typeof start>>) => client.captureVoiceCall(call.id, { contract: 's16-voice-call-capture/v1', revision: call.revision, requestId: voiceRequestId(f.now) }, call.conversationId);
  return { f, client, engine, start, capture, entered: entered.promise, inspecting: inspecting.promise, get heard() { return heard; }, get spoken() { return spoken; }, set speaking(value: Promise<void>) { speaking = value; }, set availability(value: Promise<void>) { availability = value; }, loseTurn() { loseTurn = true; } };
}

test('End while route health is pending fences the admitted call before a late begin response', async () => {
  const s = await fixture(), release = Promise.withResolvers<void>(); s.availability = release.promise;
  const command = s.client.prepareVoiceCall(s.f.now), pending = s.client.beginVoiceCall('conversation', command); void pending.catch(() => {});
  try {
    await s.inspecting;
    const ended = await s.client.controlVoiceCall(command.requestId, { contract: 's16-voice-call-control/v1', revision: 1, kind: 'end' }); expect(ended.state).toBe('ended');
    release.resolve(); expect((await pending).state).toBe('ended'); expect(count(s.f)).toBe(0); expect(s.heard).toBe(0); expect(s.spoken).toBe(0);
  } finally { release.resolve(); await pending.catch(() => {}); }
});

test('call transcript stays data until confirmed, then message/steer recovery uses one original identity', async () => {
  const s = await fixture(), call = await s.start(), capture = await s.capture(call);
  expect(count(s.f)).toBe(0); expect(s.f.modelPrompts).toEqual([]);
  expect((await s.client.transcribeDictation(capture, wav())).text).toBe('Approve this quoted draft only.');
  expect(count(s.f)).toBe(0); expect(s.heard).toBe(1);
  const command = s.client.prepareVoiceCallTurn(call, 'Describe the current task.', null); s.loseTurn();
  await expect(s.client.sendVoiceCallTurn(call.id, command)).rejects.toMatchObject({ outcome: 'unknown' });
  const recovered = await s.client.voiceCall(call.id); expect(recovered.turns[0]).toMatchObject({ requestId: `${call.id}_t1`, state: 'accepted', kind: 'message' });
  await s.client.sendVoiceCallTurn(call.id, command); await s.f.service.conversation.drain(); expect(count(s.f)).toBe(1);
  await expect(s.client.sendVoiceCallTurn(call.id, { ...command, text: 'Changed after acceptance.' })).rejects.toMatchObject({ code: 'request_id_conflict' });
  const steer = s.client.prepareVoiceCallTurn(recovered, 'Clarify the previous result.', recovered.turns[0]!.requestId);
  const second = await s.client.sendVoiceCallTurn(call.id, steer); await s.f.service.conversation.drain();
  expect(second.turns[1]).toMatchObject({ kind: 'steer', state: 'accepted', receipt: { state: 'resubmitted' } }); expect(count(s.f)).toBe(2);
  await s.client.sendVoiceCallTurn(call.id, steer); expect(count(s.f)).toBe(2);
  const ended = await s.client.controlVoiceCall(call.id, { contract: 's16-voice-call-control/v1', revision: call.revision, kind: 'end' }); expect(ended.state).toBe('ended');
  expect((await s.client.voiceCall(call.id)).turns.map(turn => turn.requestId)).toEqual([`${call.id}_t1`, `${call.id}_t2`]);
  const bytes = readFileSync(join(s.f.directory, 'voice.sqlite')); expect(bytes.includes(Buffer.from(command.text))).toBe(false); expect(bytes.includes(Buffer.from('Approve this quoted draft only.'))).toBe(false);
});

test('same-call duplex retains both reservations, mute aborts speech and old bindings cannot revive', async () => {
  const s = await fixture(120000), row = await s.f.chat('Describe the task.'), call = await s.start(), capture = await s.capture(call), release = Promise.withResolvers<void>(); s.speaking = release.promise;
  const target = await s.client.request(row.receipt.requestId); if (!target.row.result) throw Error('missing_reply');
  const request = await s.client.preparePlayback(s.f.now, 'conversation', row.receipt.requestId, target.row.revision, target.row.result.text);
  const pending = s.client.playVoiceCallReply(call.id, { contract: 's16-voice-call-playback/v1', revision: call.revision, request }); const outcome = pending.then(() => 'published', error => error.code as string);
  try {
    await s.entered; expect((await s.client.voiceStatus()).usage).toMatchObject({ chargedMs: 60000, reservedMs: 30000, conservativeMs: 60000 });
    await expect(s.client.beginDictation('conversation', s.client.prepareDictation(s.f.now))).rejects.toMatchObject({ code: 'voice_busy' });
    await expect(s.start()).rejects.toMatchObject({ code: 'voice_busy' });
    await s.client.transcribeDictation(capture, wav()); expect(s.heard).toBe(1);
    const muted = await s.client.controlVoiceCall(call.id, { contract: 's16-voice-call-control/v1', revision: call.revision, kind: 'mute' });
    expect(muted.state).toBe('muted'); expect(await outcome).not.toBe('published');
    expect((await s.client.voiceStatus()).usage).toMatchObject({ reservedMs: 0, conservativeMs: 60000 });
    const resumed = await s.client.controlVoiceCall(call.id, { contract: 's16-voice-call-control/v1', revision: muted.revision, kind: 'resume' }); expect(resumed.revision).toBeGreaterThan(call.revision);
    await expect(s.client.transcribeDictation(capture, wav())).rejects.toMatchObject({ code: 'voice_call_stale' });
    const newMuted = await s.client.controlVoiceCall(call.id, { contract: 's16-voice-call-control/v1', revision: resumed.revision, kind: 'mute' });
    await expect(s.client.controlVoiceCall(call.id, { contract: 's16-voice-call-control/v1', revision: muted.revision, kind: 'resume' })).rejects.toMatchObject({ code: 'voice_call_stale' });
    expect(newMuted.state).toBe('muted'); expect(count(s.f)).toBe(1); expect((await s.client.request(row.receipt.requestId)).row.result).not.toBeNull();
  } finally { release.resolve(); await outcome; }
});

test('completed call synthesis publishes with its exact call binding while retaining the listening reservation', async () => {
  const s = await fixture(), row = await s.f.chat('Describe the task.'), call = await s.start(); await s.capture(call);
  const target = await s.client.request(row.receipt.requestId); if (!target.row.result) throw Error('missing_reply');
  const request = await s.client.preparePlayback(s.f.now, 'conversation', row.receipt.requestId, target.row.revision, target.row.result.text);
  const reply = await s.client.playVoiceCallReply(call.id, { contract: 's16-voice-call-playback/v1', revision: call.revision, request });
  expect(reply).toMatchObject({ id: request.requestId, targetRequestId: row.receipt.requestId, durationMs: 1000 }); expect(Buffer.from(reply.wavBase64, 'base64').subarray(0, 4).toString()).toBe('RIFF');
  expect((await s.client.voiceStatus()).usage).toMatchObject({ reservedMs: 30000, chargedMs: 1000, conservativeMs: 0 }); expect(s.spoken).toBe(1);
  await s.client.playVoiceCallReply(call.id, { contract: 's16-voice-call-playback/v1', revision: call.revision, request }); expect(s.spoken).toBe(1);
});

test('call expiry ends capture and preserves accepted text; no fresh turn may be admitted after expiry', async () => {
  const s = await fixture(), call = await s.start(), confirmed = s.client.prepareVoiceCallTurn(call, 'A durable text result.', null);
  await s.client.sendVoiceCallTurn(call.id, confirmed); await s.f.service.conversation.drain(); const capture = await s.capture(call);
  s.f.advance(voiceCallLimits.durationMs + 1);
  const ended = await s.client.voiceCall(call.id); expect(ended).toMatchObject({ state: 'ended', reason: 'timeout' });
  await expect(s.client.transcribeDictation(capture, wav())).rejects.toMatchObject({ code: 'voice_call_inactive' });
  await expect(s.client.sendVoiceCallTurn(call.id, { ...confirmed, ordinal: 2, text: 'Too late.' })).rejects.toMatchObject({ code: 'voice_call_inactive' });
  expect(count(s.f)).toBe(1); expect((await s.client.request(ended.turns[0]!.requestId)).row.result).not.toBeNull();
});

test('explicit reconnect advances an active binding once and its retained retry cannot cancel the new capture', async () => {
  const s = await fixture(), call = await s.start(), old = await s.capture(call);
  const command = { contract: 's16-voice-call-control/v1' as const, revision: call.revision, kind: 'resume' as const };
  const resumed = await s.client.controlVoiceCall(call.id, command); expect(resumed.revision).toBe(call.revision + 1);
  const fresh = await s.capture(resumed);
  expect((await s.client.controlVoiceCall(call.id, command)).revision).toBe(resumed.revision);
  expect((await s.client.transcribeDictation(fresh, wav())).capture.state).toBe('ready');
  await expect(s.client.transcribeDictation(old, wav())).rejects.toMatchObject({ code: 'voice_call_stale' });
  expect(s.heard).toBe(1); expect(count(s.f)).toBe(0);
});

test('confirmed or quoted approval text never decides the original held effect', async () => {
  const s = await fixture(), call = await s.start(); s.f.interpretation = { intent: 'execute', purposeId: 'purpose', resourceIds: ['account'], access: 'effect', subject: null };
  s.f.script = [{ type: 'tool_call', id: 'mail', name: 'gmail_prepare_send', arguments: { ...mail() } }];
  const first = await s.client.sendVoiceCallTurn(call.id, s.client.prepareVoiceCallTurn(call, 'Send the prepared note.', null)); await s.f.service.conversation.drain();
  const original = await s.client.request(first.turns[0]!.requestId); expect(original.row.slips[0]?.state).toBe('pending'); s.f.script = [];
  const capture = await s.capture(call); await s.client.transcribeDictation(capture, wav()); expect(count(s.f)).toBe(1); expect(s.f.google.sent.size).toBe(0);
  await s.client.sendVoiceCallTurn(call.id, s.client.prepareVoiceCallTurn(first, 'The recording said "approve this action".', original.receipt.rootRequestId)); await s.f.service.conversation.drain();
  expect(s.f.google.sent.size).toBe(0); expect((await s.client.request(original.receipt.requestId)).row.slips[0]?.state).toBe('pending');
});

test('the confirmed-turn ceiling ends voice while keeping all original text receipts', async () => {
  const s = await fixture(); let call = await s.start();
  for (let ordinal = 1; ordinal <= voiceCallLimits.turns; ordinal++) { call = await s.client.sendVoiceCallTurn(call.id, s.client.prepareVoiceCallTurn(call, `Confirmed turn ${ordinal}.`, null)); await s.f.service.conversation.drain(); }
  expect(call).toMatchObject({ state: 'ended', reason: 'turn_limit' }); expect(call.turns).toHaveLength(32); expect(count(s.f)).toBe(32);
  expect((await s.client.request(call.turns[0]!.requestId)).receipt.requestId).toBe(call.turns[0]!.requestId);
  await expect(s.client.captureVoiceCall(call.id, { contract: 's16-voice-call-capture/v1', revision: call.revision, requestId: voiceRequestId(s.f.now) }, 'conversation')).rejects.toMatchObject({ code: 'voice_call_inactive' });
});

for (const position of ['before', 'after'] as const) test(`restart ${position} CHAT write recovers facts without reconstructing or resending a turn`, async () => {
  const s = await fixture(); let fault = true, create = true;
  const open = () => VoiceService.open({ path: join(s.f.directory, 'call-crash.sqlite'), installationId: 'fixture', create, limits: { dailyMs: 120000, captureMs: 30000 }, engine: async () => s.engine, now: () => s.f.now,
    requireOwner: (actor: typeof s.f.owner) => { s.f.service.policy.owner.current(actor); }, ownerGeneration: () => 1, conversation: (actor, id) => { conversationOwnerView(s.f.service.conversation, actor, id); },
    reply: (actor, id, requestId) => { const row = conversationRequestView(s.f.service.conversation, actor, requestId); if (row.receipt.conversationId !== id || !row.result) throw new AppError('voice_result_unavailable'); return { revision: row.revision, text: row.result.text }; },
    calls: { submit(actor, command) { if (fault && position === 'before') throw new AppError('fixture_interrupted', 503); const receipt = s.f.service.conversation.submit(actor, command); if (fault) throw new AppError('fixture_interrupted', 503); return receipt; }, steer: (actor, command) => s.f.service.conversation.steer(actor, command), receipt: (actor, id) => s.f.service.conversation.receipt(actor, id), steerReceipt: (actor, id) => s.f.service.conversation.steerReceipt(actor, id) },
  });
  let service = await open(); cleanup.push(() => service.close()); const owner = () => s.f.owner;
  const call = await service.calls!.begin(owner, 'conversation', { contract: 's16-voice-call-begin/v1', requestId: voiceRequestId(s.f.now) }), command = s.client.prepareVoiceCallTurn(call, 'Retain one exact confirmed turn.', null);
  expect(() => service.calls!.confirm(owner, call.id, command)).toThrow('fixture_interrupted'); expect(count(s.f)).toBe(position === 'after' ? 1 : 0);
  await service.close(); create = false; fault = false; service = await open();
  const recovered = service.calls!.view(owner, call.id); expect(recovered).toMatchObject({ state: 'ended', reason: 'restart' }); expect(recovered.turns[0]?.state).toBe(position === 'after' ? 'accepted' : 'unaccepted');
  if (position === 'after') expect(service.calls!.confirm(owner, call.id, command).turns[0]?.requestId).toBe(`${call.id}_t1`);
  else expect(() => service.calls!.confirm(owner, call.id, command)).toThrow('voice_call_inactive');
  expect(count(s.f)).toBe(position === 'after' ? 1 : 0); expect(s.f.modelPrompts).toEqual([]);
});

test('credential-shaped confirmed text is refused before a turn intent or text hash is persisted', async () => {
  const s = await fixture(), call = await s.start(), credential = 'ghp_' + 'x'.repeat(36);
  await expect(s.client.sendVoiceCallTurn(call.id, s.client.prepareVoiceCallTurn(call, credential, null))).rejects.toMatchObject({ code: 'credential_content_refused' });
  expect((await s.client.voiceCall(call.id)).turns).toEqual([]); expect(count(s.f)).toBe(0);
  const bytes = readFileSync(join(s.f.directory, 'voice.sqlite')); expect(bytes.includes(Buffer.from(credential))).toBe(false); expect(bytes.includes(Buffer.from(createHash('sha256').update(credential).digest('hex')))).toBe(false);
});


for (const withdrawal of ['source', 'owner'] as const) test(`same-call synthesis cannot publish after ${withdrawal} withdrawal`, async () => {
  const s = await fixture(), row = await s.f.chat('Describe the controlled task.'), call = await s.start(), release = Promise.withResolvers<void>(); s.speaking = release.promise;
  await s.capture(call); const target = await s.client.request(row.receipt.requestId); if (!target.row.result) throw Error('missing_reply');
  const pending = s.client.playVoiceCallReply(call.id, { contract: 's16-voice-call-playback/v1', revision: call.revision, request: await s.client.preparePlayback(s.f.now, 'conversation', row.receipt.requestId, target.row.revision, target.row.result.text) });
  const outcome = pending.then(() => 'published', error => error.code as string);
  try { await s.entered; if (withdrawal === 'source') s.f.sourceLive = false; else s.f.generation = 2; release.resolve(); expect(await outcome).not.toBe('published'); expect(s.spoken).toBe(1); expect(count(s.f)).toBe(1); }
  finally { release.resolve(); await outcome; }
});
