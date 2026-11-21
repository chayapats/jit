import { expect, test } from "bun:test";
import { MobileDrafts, mobileIntent } from "../src/s16/mobile/drafts";
import { MobileVoice, type MobileVoiceOs } from "../src/s16/mobile/voice";
import type { LocalVoiceConfig, LocalVoiceEngine } from "../src/s16/voice/local";
import { captureWavInfo } from "../src/s16/voice/wav";
import { mobileFixture } from "./fixtures/s16-mobile";

const artifact = { path: "/fixture/native-speech", sha256: "f".repeat(64) };
const local: LocalVoiceConfig = { transcription: { executable: artifact, model: artifact, language: "auto" }, synthesis: { kind: "espeak", executable: artifact, voice: "en" }, timeoutMs: 5000 };
async function fixture(enabled = true) {
  let transcriptions = 0, permissions = 0, starts = 0, stops = 0, granted = true, epoch = 17;
  const engine: LocalVoiceEngine = { async available() { return true; }, async transcribe(bytes, context) { context.guard(); context.started(); expect(captureWavInfo(bytes).durationMs).toBe(1000); transcriptions++; return "Approve this editable draft."; }, async synthesize() { throw Error("No playback is selected"); }, async close() {} };
  const m = await mobileFixture(options => ({ ...options, ...(enabled ? { voice: { local, quota: { dailyMs: 120000, captureMs: 30000 }, engine: async () => engine } } : {}) }));
  await m.session.restore(); await m.session.selectConversation("original");
  const records = m.records, store = { async get(key: string) { return records.get(key) ?? null; }, async set(key: string, value: string) { records.set(key, value); }, async delete(key: string) { records.delete(key); } };
  const drafts = new MobileDrafts(); let valid = false, current = "";
  const os: MobileVoiceOs = {
    async permission() { permissions++; return granted; }, async active() {}, async epoch() { return epoch; },
    async prepare(expected, ms) { expect(expected).toBe(epoch); expect(ms).toBeLessThanOrEqual(30000); valid = true; current = crypto.randomUUID(); return current; },
    async start(id) { if (!valid || id !== current) throw Error("Consumed native lease"); starts++; },
    async finish(id) { if (!valid || id !== current) throw Error("Invalid native lease"); valid = false; const bytes = Buffer.alloc(96000); return { lease: id, epoch, encoding: "pcm16le", sampleRate: 48000, channels: 1, base64: bytes.toString("base64") }; },
    async cancel(id) { stops++; if (current === id) valid = false; }
  };
  const control = new MobileVoice(m.session, drafts, store, os);
  return { m, store, drafts, os, control, get transcriptions() { return transcriptions; }, get permissions() { return permissions; }, get starts() { return starts; }, get stops() { return stops; }, set granted(value: boolean) { granted = value; }, set epoch(value: number) { epoch = value; }, async close() { control.close(); await m.close(); } };
}

test("finite native dictation produces an editable same-session draft without CHAT, effects, audio files or duplicate Mic", async () => {
  const f = await fixture();
  try {
    const intent = mobileIntent(f.m.session); f.drafts.change(intent, () => ({ text: "Existing text", files: [] }));
    await Promise.all([f.control.start(), f.control.start()]); expect(f.starts).toBe(1); expect(f.control.projection.phase).toBe("recording"); expect(await f.control.pending()).toHaveLength(1);
    const saved = [...f.m.records.values()].find(value => value.includes('"entries"'))!; expect(JSON.parse(saved).entries[0]).toMatchObject({ conversationId: "original", scope: intent.scope });
    expect(saved).not.toContain("Existing text"); expect(saved).not.toContain("base64");
    await Promise.all([f.control.finish(), f.control.finish()]); expect(f.transcriptions).toBe(1); expect(f.drafts.get(intent.scope, "original").text).toBe("Existing text\nApprove this editable draft."); expect(await f.control.pending()).toEqual([]);
    expect(f.m.f.modelPrompts).toEqual([]); expect(f.m.f.interpreterPrompts).toEqual([]); expect(f.m.f.vmCalls).toEqual([]); expect(f.m.f.google.sent.size).toBe(0);
  } finally { await f.close(); }
});

test("unavailable voice and denied microphone never start native capture or reserve a protected identity", async () => {
  for (const enabled of [false, true]) {
    const f = await fixture(enabled); f.granted = false;
    try { await expect(f.control.start()).rejects.toBeDefined(); expect(f.permissions).toBe(enabled ? 1 : 0); expect(f.starts).toBe(0); expect(await f.control.pending()).toEqual([]); expect(f.m.f.vmCalls).toEqual([]); }
    finally { await f.close(); }
  }
});

test("background consumes the native capture; foreground recovery checks the original ID and never restarts audio", async () => {
  const f = await fixture();
  try {
    await f.control.start(); const original = (await f.control.pending())[0]!; f.m.session.background(); expect(f.control.projection.phase).toBe("interrupted"); expect(f.stops).toBeGreaterThan(0);
    await f.m.session.restore(); const restored = new MobileVoice(f.m.session, f.drafts, f.store, f.os);
    try {
      expect(await restored.pending()).toEqual([original]); expect((await restored.check(original))!.id).toBe(original.id); expect(f.starts).toBe(1); expect(f.transcriptions).toBe(0);
      await expect(restored.start()).rejects.toMatchObject({ code: "mobile_voice_pending" }); expect(f.starts).toBe(1);
      await restored.cancel(original); expect(await restored.pending()).toEqual([]); expect(f.transcriptions).toBe(0);
    } finally { restored.close(); }
  } finally { await f.close(); }
});

test("a late native lease after A to B to A is cancelled before Start and leaves only original read-only recovery", async () => {
  const f = await fixture(); let ready!: () => void, release!: () => void;
  const arrived = new Promise<void>(resolve => { ready = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const prepare = f.os.prepare; f.os.prepare = async (epoch, ms) => { const id = await prepare(epoch, ms); ready(); await held; return id; };
  try {
    const starting = f.control.start().then(() => null, error => error); await arrived;
    await f.m.session.selectConversation("other"); await f.m.session.selectConversation("original"); release();
    expect(await starting).toMatchObject({ code: "mobile_capture_interrupted" }); expect(f.starts).toBe(0); expect(f.stops).toBeGreaterThan(0); expect(f.transcriptions).toBe(0); expect(await f.control.pending()).toHaveLength(1);
  } finally { release(); await f.close(); }
});

test("uncertain transcription cannot replay audio or recreate lost transcript; restart only checks its original terminal ID", async () => {
  const f = await fixture(); let posts = 0;
  try {
    await f.control.start(); const original = (await f.control.pending())[0]!;
    f.m.intercept = async request => { if (new URL(request.url).pathname.endsWith("/transcribe")) { posts++; await f.m.f.service.fetch(request); return new Response("{", { headers: { "content-type": "application/json" } }); } return null; };
    await expect(f.control.finish()).rejects.toBeDefined(); expect(f.transcriptions).toBe(1); expect(posts).toBe(1);
    f.m.intercept = request => { if (request.method === "POST") posts++; return null; }; await f.m.session.restore();
    const restored = new MobileVoice(f.m.session, f.drafts, f.store, f.os);
    try { expect((await restored.check(original))!.state).toBe("ready"); expect(await restored.pending()).toEqual([]); expect(posts).toBe(1); expect(f.starts).toBe(1); expect(f.drafts.get(mobileIntent(f.m.session).scope, "original").text).toBe(""); expect(f.m.f.vmCalls).toEqual([]); }
    finally { restored.close(); }
  } finally { await f.close(); }
});
