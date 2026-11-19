import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JitClient } from '../src/s16/client';
import { openLocalVoice, speechWavInfo, type LocalVoiceConfig } from '../src/s16/voice/local';
import { encodeCaptureWav } from '../src/s16/voice/wav';
import { composedFixture } from './fixtures/s15-composition';

// Explicit local-only proof: real supplied speech executables/model, no microphone, account or provider inference.
// The ordinary conversation/model/VM fixture remains scripted; this is not owner-host/device acceptance (#431).
const nativeTest = process.env.JIT_S16_NATIVE_VOICE_TESTS === '1' ? test : test.skip;
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
function capture(speech: Uint8Array): Uint8Array {
  speechWavInfo(speech); const view = new DataView(speech.buffer, speech.byteOffset, speech.byteLength);
  let rate = 0;
  for (let at = 12; at + 8 <= speech.length;) {
    const name = String.fromCharCode(...speech.subarray(at, at + 4)), size = view.getUint32(at + 4, true);
    if (name === 'fmt ') rate = view.getUint32(at + 12, true);
    if (name === 'data' && rate) {
      const samples = new Float32Array(size / 2); for (let n = 0; n < samples.length; n++) samples[n] = view.getInt16(at + 8 + n * 2, true) / 32768;
      const capture = new Float32Array(Math.floor(samples.length * 16000 / rate));
      for (let n = 0; n < capture.length; n++) { const position = n * rate / 16000, index = Math.floor(position), fraction = position - index; capture[n] = samples[index]! * (1 - fraction) + samples[Math.min(index + 1, samples.length - 1)]! * fraction; }
      return encodeCaptureWav(capture);
    }
    at += 8 + size + size % 2;
  }
  throw Error('native_audio_missing');
}
nativeTest('actual local speech transcribes known synthetic audio, stays draft until Send and speaks a guarded reply', async () => {
  const path = process.env.JIT_S16_NATIVE_VOICE_CONFIG; if (!path) throw Error('Set JIT_S16_NATIVE_VOICE_CONFIG to an ignored local config file');
  const local = JSON.parse(readFileSync(path, 'utf8')) as LocalVoiceConfig;
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'jit-native-voice-'))), engine = await openLocalVoice(local, join(root, 'source'));
  const sentence = 'The quick brown fox jumps over the lazy dog.';
  try {
    const source = await engine.synthesize(sentence, { signal: new AbortController().signal, guard() {}, started() {} });
    await engine.close(); const wav = capture(source.wav);
    const f = await composedFixture('default', false, undefined, o => ({ ...o, voice: { local, quota: { dailyMs: 120000, captureMs: 30000 } } }));
    try {
      const client = new JitClient({ origin: 'http://localhost:3099', fetch: async request => {
        const path = new URL(request.url).pathname, headers = Object.fromEntries(request.headers);
        return request.headers.get('content-type') === 'application/octet-stream'
          ? f.raw(path, await request.arrayBuffer(), headers)
          : f.request(path, request.method, request.method === 'POST' ? await request.json() : undefined, headers);
      } });
      await client.bootstrap(); const status = await client.voiceStatus(); expect(status.available).toBe(true);
      const capture = await client.beginDictation('conversation', client.prepareDictation(status.serverTime)), transcript = await client.transcribeDictation(capture, wav);
      expect(transcript.text.toLowerCase()).toContain('quick brown fox'); expect(transcript.text.toLowerCase()).toContain('lazy dog');
      expect(f.modelPrompts).toEqual([]); expect(f.service.conversation.store.db.query<{ n: number }, []>('SELECT count(*) AS n FROM requests').get()!.n).toBe(0);
      await client.cancelVoice(capture);
      await client.send(client.prepareMessage('conversation', 'Run a private diagnostic. ' + transcript.text + ' Edited before ordinary Send.')); await f.service.conversation.drain();
      const row = (await client.snapshot('conversation')).conversation.rows[0]!; expect(row.result?.text).toBe('Completed with observed tool evidence.');
      const reply = await client.playReply(await client.preparePlayback((await client.voiceStatus()).serverTime, 'conversation', row.requestId, row.revision, row.result!.text)), bytes = Buffer.from(reply.wavBase64, 'base64');
      expect(speechWavInfo(bytes).durationMs).toBeGreaterThan(1000); expect(bytes.some(byte => byte !== 0)).toBe(true);
      const usage = (await client.voiceStatus()).usage; expect(usage.reservedMs).toBe(0); expect(usage.conservativeMs).toBe(0);
      if (process.env.JIT_S16_NATIVE_VOICE_RECEIPT) writeFileSync(process.env.JIT_S16_NATIVE_VOICE_RECEIPT, JSON.stringify({ contract: 'jit-native-voice-proof/v1', at: new Date().toISOString(), platform: process.platform, arch: process.arch, bun: Bun.version, local, sentence, source: { sha256: sha(wav), durationMs: (wav.length - 44) / 32 }, transcript: transcript.text, reply: { text: row.result!.text, sha256: sha(bytes), durationMs: reply.durationMs }, usage, scope: 'Actual configured speech through composed client; scripted model/VM; no microphone, private recordings, provider, billing or owner-host activation' }, null, 2) + '\n', { mode: 0o600 });
    } finally { await f.close(); }
  } finally { await engine.close(); rmSync(root, { recursive: true, force: true }); }
}, 120000);

nativeTest('actual local call confirms two turns, recovers a lost receipt and synthesizes through same-call duplex', async () => {
  const path = process.env.JIT_S16_NATIVE_VOICE_CONFIG; if (!path) throw Error('Set JIT_S16_NATIVE_VOICE_CONFIG to an ignored local config file');
  const local = JSON.parse(readFileSync(path, 'utf8')) as LocalVoiceConfig, root = realpathSync(mkdtempSync(join(tmpdir(), 'jit-native-call-'))), source = await openLocalVoice(local, join(root, 'source'));
  let transcriptions = 0, syntheses = 0, lose = true;
  try {
    const sentence = 'The quick brown fox jumps over the lazy dog.', input = capture((await source.synthesize(sentence, { signal: new AbortController().signal, guard() {}, started() {} })).wav); await source.close();
    const f = await composedFixture('default', false, undefined, options => ({ ...options, voice: { local, quota: { dailyMs: 240000, captureMs: 30000 }, engine: async () => {
      const engine = await openLocalVoice(local, join(root, 'call'));
      return { available: () => engine.available(), transcribe: (bytes, context) => { transcriptions++; return engine.transcribe(bytes, context); }, synthesize: (text, context) => { syntheses++; return engine.synthesize(text, context); }, close: () => engine.close() };
    } } }));
    f.interpretation = { intent: 'answer', purposeId: 'purpose', resourceIds: [], access: 'read', subject: null }; f.script = [{ type: 'text', text: 'The confirmed voice turn was received.' }];
    try {
      const client = new JitClient({ origin: 'http://localhost:3099', async fetch(request) {
        const path = new URL(request.url).pathname, headers = Object.fromEntries(request.headers);
        const response = request.headers.get('content-type') === 'application/octet-stream' ? await f.raw(path, await request.arrayBuffer(), headers) : await f.request(path, request.method, request.method === 'POST' ? await request.json() : undefined, headers);
        if (lose && path.endsWith('/turns')) { lose = false; throw Error('controlled_accepted_response_loss'); } return response;
      } });
      const requests = () => f.service.conversation.store.db.query<{ n: number }, []>('SELECT count(*) AS n FROM requests').get()!.n;
      await client.bootstrap(); const status = await client.voiceStatus(), call = await client.beginVoiceCall('conversation', client.prepareVoiceCall(status.serverTime));
      const record = async (revision: number) => client.captureVoiceCall(call.id, { contract: 's16-voice-call-capture/v1', revision, requestId: client.prepareDictation((await client.voiceStatus()).serverTime).requestId }, 'conversation');
      const firstCapture = await record(call.revision), first = await client.transcribeDictation(firstCapture, input);
      expect(first.text.toLowerCase()).toContain('quick brown fox'); expect(first.text.toLowerCase()).toContain('lazy dog'); expect(requests()).toBe(0); expect(f.modelPrompts).toEqual([]); await client.cancelVoice(firstCapture);
      const confirmed = client.prepareVoiceCallTurn(call, 'Explain this confirmed transcript. ' + first.text + ' Edited before Call Send.', null);
      await expect(client.sendVoiceCallTurn(call.id, confirmed)).rejects.toMatchObject({ outcome: 'unknown' });
      const recovered = await client.voiceCall(call.id); expect(recovered.turns[0]).toMatchObject({ requestId: `${call.id}_t1`, state: 'accepted' }); await client.sendVoiceCallTurn(call.id, confirmed); await f.service.conversation.drain(); expect(requests()).toBe(1);
      const firstRow = await client.request(recovered.turns[0]!.requestId); expect(firstRow.row.result?.text).toBe('The confirmed voice turn was received.');
      const listening = await record(call.revision), firstAudio = await client.playVoiceCallReply(call.id, { contract: 's16-voice-call-playback/v1', revision: call.revision, request: await client.preparePlayback((await client.voiceStatus()).serverTime, 'conversation', firstRow.row.requestId, firstRow.row.revision, firstRow.row.result!.text) });
      expect(capture(Buffer.from(firstAudio.wavBase64, 'base64')).subarray(44).some(byte => byte !== 0)).toBe(true); expect(firstAudio.durationMs).toBeGreaterThan(1000); expect((await client.voiceStatus()).usage.reservedMs).toBe(30000);
      const muted = await client.controlVoiceCall(call.id, { contract: 's16-voice-call-control/v1', revision: call.revision, kind: 'mute' }), resumed = await client.controlVoiceCall(call.id, { contract: 's16-voice-call-control/v1', revision: muted.revision, kind: 'resume' });
      await expect(client.transcribeDictation(listening, input)).rejects.toMatchObject({ code: 'voice_call_stale' }); expect(transcriptions).toBe(1);
      const nextCapture = await record(resumed.revision), second = await client.transcribeDictation(nextCapture, input); expect(second.text.toLowerCase()).toContain('quick brown fox'); expect(second.text.toLowerCase()).toContain('lazy dog'); expect(requests()).toBe(1); await client.cancelVoice(nextCapture);
      const secondView = await client.sendVoiceCallTurn(call.id, client.prepareVoiceCallTurn(resumed, 'Follow up on this confirmed transcript. ' + second.text, firstRow.receipt.rootRequestId));
      expect(secondView.turns[1]?.receipt).toMatchObject({ state: 'resubmitted' }); await f.service.conversation.drain(); expect(requests()).toBe(2);
      const secondReceipt = secondView.turns[1]!.receipt; if (secondReceipt?.contract !== 's16-conversation-steer-receipt/v1' || !secondReceipt.followUp) throw Error('native_followup_missing');
      const secondRow = await client.request(secondReceipt.followUp); expect(secondRow.row.result?.text).toBe('The confirmed voice turn was received.'); await record(resumed.revision);
      const secondAudio = await client.playVoiceCallReply(call.id, { contract: 's16-voice-call-playback/v1', revision: resumed.revision, request: await client.preparePlayback((await client.voiceStatus()).serverTime, 'conversation', secondRow.row.requestId, secondRow.row.revision, secondRow.row.result!.text) });
      expect(capture(Buffer.from(secondAudio.wavBase64, 'base64')).subarray(44).some(byte => byte !== 0)).toBe(true); expect(secondAudio.durationMs).toBeGreaterThan(1000);
      const ended = await client.controlVoiceCall(call.id, { contract: 's16-voice-call-control/v1', revision: resumed.revision, kind: 'end' }), usage = (await client.voiceStatus()).usage;
      expect(ended.state).toBe('ended'); expect(usage.reservedMs).toBe(0); expect(usage.conservativeMs).toBe(0); expect(transcriptions).toBe(2); expect(syntheses).toBe(2); expect(requests()).toBe(2);
      if (process.env.JIT_S16_NATIVE_CALL_RECEIPT) writeFileSync(process.env.JIT_S16_NATIVE_CALL_RECEIPT, JSON.stringify({ contract: 'jit-native-voice-call-proof/v1', sourceRevision: process.env.JIT_S16_NATIVE_CALL_SOURCE ?? null, at: new Date().toISOString(), platform: process.platform, arch: process.arch, bun: Bun.version, local, input: { sha256: sha(input), durationMs: (input.length - 44) / 32 }, transcripts: [sha(first.text), sha(second.text)], audio: [firstAudio, secondAudio].map(value => ({ sha256: sha(Buffer.from(value.wavBase64, 'base64')), durationMs: value.durationMs })), counts: { transcriptions, syntheses, requests: requests() }, usage, scope: 'Actual local STT/TTS through composed call client and CHAT/steer receipts; supplied public synthetic speech; scripted model/VM; no microphone, private recording, provider, billing or owner-host activation' }, null, 2) + '\n', { mode: 0o600 });
    } finally { await f.close(); }
  } finally { await source.close(); rmSync(root, { recursive: true, force: true }); }
}, 180000);
