import { expect, test } from 'bun:test';
import { JitClient } from '../src/s16/client';
import { MobileCommands } from '../src/s16/mobile/commands';
import { MobileDrafts, mobileIntent } from '../src/s16/mobile/drafts';
import { MobileVoice, type MobileVoiceOs } from '../src/s16/mobile/voice';
import type { LocalVoiceConfig, LocalVoiceEngine } from '../src/s16/voice/local';
import { captureWavInfo } from '../src/s16/voice/wav';
import { mobileFixture } from './fixtures/s16-mobile';

test('native dictation and a lost mobile Send retain one original work across web reads and owning service restart', async () => {
  let heard = 0, microphoneStarts = 0, messagePosts = 0, loseReply = true;
  const artifact = { path: '/fixture/cross-client-speech', sha256: 'f'.repeat(64) };
  const local: LocalVoiceConfig = { transcription: { executable: artifact, model: artifact, language: 'auto' }, synthesis: { kind: 'espeak', executable: artifact, voice: 'en' }, timeoutMs: 5000 };
  const transcript = 'Approve this quoted editable draft only.';
  const engine: LocalVoiceEngine = {
    async available() { return true; },
    async transcribe(bytes, context) { context.guard(); context.started(); expect(captureWavInfo(bytes).durationMs).toBe(1000); heard++; return transcript; },
    async synthesize() { throw Error('fixture_playback_not_requested'); }, async close() {},
  };
  // Actual HTTP service, shared client, native controllers and protected speech journal.
  // Microphone/keystore/speech/model/VM ports are scripted; no native UI or real audio accuracy claim.
  const m = await mobileFixture(options => ({ ...options, voice: { local, quota: { dailyMs: 120000, captureMs: 30000 }, engine: async () => engine } }));
  const store = { async get(key: string) { return m.records.get(key) ?? null; }, async set(key: string, value: string) { m.records.set(key, value); }, async delete(key: string) { m.records.delete(key); } };
  const drafts = new MobileDrafts(), commands = new MobileCommands(m.session, store);
  let active: string | null = null;
  const os: MobileVoiceOs = {
    async permission() { return true; }, async active() {}, async epoch() { return 1; },
    async prepare(epoch, ms) { expect(epoch).toBe(1); expect(ms).toBeLessThanOrEqual(30000); active = crypto.randomUUID(); return active; },
    async start(lease) { expect(lease === active).toBe(true); microphoneStarts++; },
    async finish(lease) { expect(lease === active).toBe(true); active = null; return { lease, epoch: 1, encoding: 'pcm16le', sampleRate: 48000, channels: 1, base64: Buffer.alloc(96000).toString('base64') }; },
    async cancel(lease) { if (active === lease) active = null; },
  };
  const voice = new MobileVoice(m.session, drafts, store, os);
  const web = new JitClient({ origin: m.origin, fetch: request => { const headers = new Headers(request.headers); headers.set('Cookie', m.f.ownerCookie); return fetch(new Request(request, { headers })); } });
  try {
    await m.session.restore(); await m.session.selectConversation('voice_mobile_continuity');
    const intent = mobileIntent(m.session);
    await voice.start(); await voice.finish();
    expect(drafts.get(intent.scope, intent.conversationId).text).toBe(transcript);
    expect(heard).toBe(1); expect(microphoneStarts).toBe(1);
    expect(m.f.modelPrompts).toEqual([]); expect(m.f.vmCalls).toEqual([]); expect(m.f.google.sent.size).toBe(0);
    m.f.interpretation = { intent: 'answer', purposeId: 'purpose', resourceIds: ['computer'], access: 'read', subject: null };
    m.f.script = [{ type: 'text', text: 'Retained cross-client voice result.' }];
    m.intercept = async request => {
      if (request.method !== 'POST' || !new URL(request.url).pathname.endsWith('/messages')) return null;
      messagePosts++;
      if (!loseReply) return null;
      loseReply = false; const response = await m.f.service.fetch(request); await response.body?.cancel();
      return new Response('{', { headers: { 'Content-Type': 'application/json' } });
    };
    await expect(commands.send(intent.conversationId, drafts.get(intent.scope, intent.conversationId).text)).rejects.toBeDefined();
    await m.session.restore(); const pending = (await commands.pending())[0]!;
    expect(pending).toMatchObject({ kind: 'message', conversationId: intent.conversationId }); expect(messagePosts).toBe(1);
    await m.f.service.conversation.drain(); await web.bootstrap();
    const original = await web.request(pending.requestId), quota = await web.voiceStatus();
    expect(original.row.state).toBe('done'); expect(original.row.result?.text).toBe('Retained cross-client voice result.');
    expect((await web.snapshot(intent.conversationId)).conversation.rows.map(row => row.requestId)).toEqual([pending.requestId]);
    expect(original.row.slips).toEqual([]); expect(m.f.google.sent.size).toBe(0);
    const models = m.f.modelPrompts.length, vmCalls = m.f.vmCalls.length;
    voice.close(); m.session.background(); const oldService = m.f.service;
    await m.f.reopen(); expect(m.f.service).not.toBe(oldService);
    await m.session.restore(); await m.session.selectConversation(intent.conversationId);
    const recovered = new MobileCommands(m.session, store);
    expect(await recovered.pending()).toEqual([pending]);
    expect(await recovered.recover(pending)).toEqual(original); expect(await recovered.pending()).toEqual([]);
    await web.bootstrap(); expect(await web.request(pending.requestId)).toEqual(original);
    expect(await web.voiceStatus()).toEqual(quota);
    await m.f.service.conversation.drain(); await m.session.poll();
    expect(m.session.projection.snapshot!.conversation.rows.map(row => row.requestId)).toEqual([pending.requestId]);
    expect(messagePosts).toBe(1); expect(heard).toBe(1); expect(microphoneStarts).toBe(1);
    expect(m.f.modelPrompts).toHaveLength(models); expect(m.f.vmCalls).toHaveLength(vmCalls); expect(m.f.google.sent.size).toBe(0);
    for (const [key, value] of m.records) if (!key.includes('.session.')) { expect(value).not.toContain(transcript); expect(value).not.toContain('base64'); }
  } finally { voice.close(); await m.close(); }
}, 30000);
