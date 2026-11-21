import { JitClientError } from "../client";
import type { VoiceCapture } from "../voice/contracts";
import { checkMobileIntent, mobileIntent, type MobileDrafts, type MobileIntent } from "./drafts";
import { mobileCaptureWav } from "./pcm";
import type { MobileSession } from "./session";
import { mobileServiceId, type MobileSecureStore } from "./transport";

/** Authored native adapter; permission, lease and PCM are separate from protected VOICE16 authority. */
export interface MobileVoiceOs {
  permission(): Promise<boolean>; active(): Promise<void>; epoch(): Promise<number>;
  prepare(epoch: number, ms: number): Promise<string>; start(lease: string): Promise<void>;
  finish(lease: string): Promise<unknown>; cancel(lease: string): Promise<void>;
}
/** Metadata only. A restarted client can inspect/cancel this identity but never reconstruct captured audio. */
export interface MobileVoicePending { id: string; conversationId: string; scope: string }
/** Renderable microphone state contains no raw audio, transcript or native handle. */
export interface MobileVoiceView { readonly phase: "idle" | "permission" | "starting" | "recording" | "transcribing" | "interrupted" | "uncertain" | "ready"; readonly busy: boolean; readonly code: string | null }
const queues = new Map<string, Promise<void>>();
const fail = (code: string): never => { throw Object.assign(new Error(code), { code }); };
const identifier = (raw: unknown): raw is string => typeof raw === "string" && raw.length >= 1 && raw.length <= 128 && !/[^A-Za-z0-9_-]/.test(raw);
const sha = (raw: unknown): raw is string => typeof raw === "string" && raw.length === 64 && !/[^a-f0-9]/.test(raw);
const terminal = (capture: VoiceCapture) => capture.state !== "capturing" && capture.state !== "processing";
async function finite<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Object.assign(Error(), { code: "mobile_capture_unavailable" })), 15000); })]); }
  finally { clearTimeout(timer); }
}

/** Finite microphone-to-editable-draft workflow. No Send, Decide, playback, offline queue or automatic replay. */
export class MobileVoice {
  #view: MobileVoiceView = Object.freeze({ phase: "idle", busy: false, code: null });
  readonly #listeners = new Set<() => void>();
  readonly #release: () => void;
  #busy = false;
  #nonce = 0;
  #lease: string | null = null;
  #capture: VoiceCapture | null = null;
  #intent: MobileIntent | null = null;
  #epoch = 0;
  #maxMs = 0;
  #original = "";
  #timer: ReturnType<typeof setTimeout> | undefined;
  constructor(readonly session: MobileSession, readonly drafts: MobileDrafts, readonly store: MobileSecureStore, readonly os: MobileVoiceOs) {
    this.#release = session.subscribe(() => {
      if (!["starting", "recording", "transcribing"].includes(this.#view.phase)) return;
      try { if (this.#intent) checkMobileIntent(this.#intent); } catch { this.#interrupt(); }
    });
  }
  get projection(): MobileVoiceView { return this.#view; }
  subscribe(listener: () => void): () => void { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; }
  #publish(phase: MobileVoiceView["phase"], code: string | null = null): void { this.#view = Object.freeze({ phase, busy: this.#busy || phase === "recording", code }); for (const listener of this.#listeners) listener(); }
  #interrupt(): void { this.#nonce++; clearTimeout(this.#timer); this.#timer = undefined; const lease = this.#lease; this.#lease = null; if (lease) void this.os.cancel(lease).catch(() => {}); this.#publish("interrupted", "mobile_capture_interrupted"); }
  /** Drop native resources and private RAM when this service renderer is retired. Pending IDs remain inspectable. */
  close(): void { this.#release(); this.#interrupt(); this.#capture = null; this.#intent = null; this.#original = ""; this.#listeners.clear(); }
  #check(nonce: number, intent: MobileIntent): void { if (nonce !== this.#nonce) fail("mobile_capture_interrupted"); checkMobileIntent(intent); }
  async #key(): Promise<string> { return "jit.mobile.voice.v1." + await mobileServiceId(this.session.transport.origin); }
  async #read(key: string): Promise<MobileVoicePending[]> {
    const raw = await this.store.get(key); if (raw === null) return [];
    try {
      if (raw.length > 8192) throw Error(); const value = JSON.parse(raw);
      if (!value || Object.keys(value).sort().join() !== "entries,v" || value.v !== 1 || !Array.isArray(value.entries) || value.entries.length > 8) throw Error();
      const ids = new Set<string>();
      for (const entry of value.entries) { if (!entry || Object.keys(entry).sort().join() !== "conversationId,id,scope" || !identifier(entry.id) || !identifier(entry.conversationId) || !sha(entry.scope) || ids.has(entry.id)) throw Error(); ids.add(entry.id); }
      return value.entries;
    } catch { return fail("mobile_voice_storage_invalid"); }
  }
  async #edit(intent: MobileIntent, update: (entries: MobileVoicePending[]) => MobileVoicePending[]): Promise<void> {
    const key = await this.#key(), previous = queues.get(key) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      checkMobileIntent(intent); const before = await this.store.get(key), next = update((await this.#read(key)).filter(entry => entry.scope === intent.scope)); checkMobileIntent(intent);
      if (next.length > 8) fail("mobile_voice_pending_limit");
      if (next.length) await this.store.set(key, JSON.stringify({ v: 1, entries: next })); else await this.store.delete(key);
      try { checkMobileIntent(intent); } catch (error) { if (before === null) await this.store.delete(key); else await this.store.set(key, before); throw error; }
    });
    queues.set(key, operation); try { await operation; } finally { if (queues.get(key) === operation) queues.delete(key); }
  }
  /** Original IDs for this exact current conversation/session only; reading never reserves or transcribes. */
  async pending(): Promise<readonly MobileVoicePending[]> {
    const intent = mobileIntent(this.session), entries = await this.#read(await this.#key()); checkMobileIntent(intent);
    return entries.filter(entry => entry.scope === intent.scope && entry.conversationId === intent.conversationId).map(entry => Object.freeze({ ...entry }));
  }
  /** Check a retained original only. Terminal/absent captures release local metadata without reconstructing audio. */
  async check(entry: MobileVoicePending): Promise<VoiceCapture | null> {
    const intent = mobileIntent(this.session);
    if (entry.scope !== intent.scope || entry.conversationId !== intent.conversationId || !(await this.pending()).some(value => value.id === entry.id)) fail("mobile_binding_changed");
    let result: VoiceCapture | null;
    try { result = await this.session.perform((client, signal) => client.dictationStatus({ id: entry.id, conversationId: entry.conversationId }, signal)); }
    catch (error) { if (!(error instanceof JitClientError && error.status === 404 && error.outcome === "response")) throw error; result = null; }
    checkMobileIntent(intent); if (!result || terminal(result)) await this.#edit(intent, entries => entries.filter(value => value.id !== entry.id)); return result;
  }
  /** One Mic gesture checks current local capability/quota before any permission request and reserves one identity. */
  async start(): Promise<void> {
    if (this.#busy || this.#view.phase === "recording") return;
    const intent = mobileIntent(this.session); this.#busy = true; const nonce = ++this.#nonce; this.#intent = intent; this.#capture = null; this.#original = ""; this.#publish("permission");
    try {
      if ((await this.pending()).length) fail("mobile_voice_pending"); this.#check(nonce, intent);
      if (!this.session.projection.bootstrap?.capabilities.voice?.available) fail("voice_unavailable");
      const before = await this.session.perform((client, signal) => client.voiceStatus(signal)); this.#check(nonce, intent);
      if (!before.available || before.usage.chargedMs + before.usage.reservedMs >= before.usage.limitMs) fail("voice_unavailable");
      const allowed = await finite(this.os.permission()); await finite(this.os.active()); await this.session.restore(); this.#check(nonce, intent);
      if (!allowed) fail("mobile_microphone_denied");
      const status = await this.session.perform((client, signal) => client.voiceStatus(signal)); this.#check(nonce, intent); if (!status.available) fail("voice_unavailable");
      this.#publish("starting"); this.#original = this.drafts.get(intent.scope, intent.conversationId).text;
      const command = await this.session.perform(async client => client.prepareDictation(status.serverTime)); this.#check(nonce, intent);
      const metadata = { id: command.requestId, conversationId: intent.conversationId, scope: intent.scope };
      await this.#edit(intent, entries => [...entries, metadata]); this.#check(nonce, intent);
      const capture = await this.session.perform((client, signal) => client.beginDictation(intent.conversationId, command, signal)); this.#capture = capture; this.#check(nonce, intent);
      const fresh = await this.session.perform((client, signal) => client.voiceStatus(signal)); this.#check(nonce, intent);
      if (!fresh.available) fail("voice_unavailable");
      this.#maxMs = Math.floor(Math.min(30000, capture.maxDurationMs, capture.recordingEndsAt - fresh.serverTime)); if (this.#maxMs < 100) fail("voice_capture_expired");
      this.#epoch = await finite(this.os.epoch()); this.#check(nonce, intent);
      const lease = await finite(this.os.prepare(this.#epoch, this.#maxMs)); this.#lease = lease; this.#check(nonce, intent);
      await finite(this.os.start(lease)); this.#check(nonce, intent); this.#publish("recording");
      this.#timer = setTimeout(() => { if (nonce === this.#nonce && this.#view.phase === "recording") void this.finish().catch(() => {}); }, this.#maxMs);
    } catch (error) { const lease = this.#lease; this.#lease = null; if (lease) await finite(this.os.cancel(lease)).catch(() => {}); this.#publish("uncertain", error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[a-z][a-z0-9_]{0,127}$/.test(error.code) ? error.code : "mobile_capture_unavailable"); throw error; }
    finally { this.#busy = false; this.#publish(this.#view.phase, this.#view.code); }
  }
  /** Stop this finite capture and transcribe once. The editable draft changes only under the original current binding. */
  async finish(): Promise<void> {
    if (this.#busy || this.#view.phase !== "recording" || !this.#lease || !this.#capture || !this.#intent) return;
    this.#busy = true; clearTimeout(this.#timer); this.#timer = undefined;
    const nonce = this.#nonce, intent = this.#intent, lease = this.#lease, capture = this.#capture; this.#publish("transcribing"); let wav: Uint8Array | undefined;
    try {
      this.#check(nonce, intent); const raw = await finite(this.os.finish(lease)); this.#lease = null; this.#check(nonce, intent);
      wav = mobileCaptureWav(raw, { lease, epoch: this.#epoch, maxMs: this.#maxMs });
      const result = await this.session.perform((client, signal) => client.transcribeDictation(capture, wav!, signal)); this.#check(nonce, intent);
      this.drafts.change(intent, current => { if (current.text !== this.#original) return fail("mobile_voice_draft_changed"); return { ...current, text: [current.text.trimEnd(), result.text].filter(Boolean).join("\n") }; });
      await this.#edit(intent, entries => entries.filter(value => value.id !== capture.id)); this.#check(nonce, intent); this.#publish("ready");
    } catch (error) { this.#publish("uncertain", "mobile_capture_unavailable"); throw error; }
    finally { wav?.fill(0); await finite(this.os.cancel(lease)).catch(() => {}); this.#busy = false; this.#original = ""; this.#publish(this.#view.phase, this.#view.code); }
  }
  /** Explicit cancellation stops native capture first, then cancels only the known VOICE16 receipt if currently usable. */
  async cancel(entry?: MobileVoicePending): Promise<void> {
    this.#interrupt(); const intent = mobileIntent(this.session), original = entry ?? (this.#capture ? { id: this.#capture.id, conversationId: this.#capture.conversationId, scope: intent.scope } : null);
    if (!original) return;
    if (original.scope !== intent.scope || original.conversationId !== intent.conversationId) fail("mobile_binding_changed");
    await this.session.perform((client, signal) => client.cancelVoice({ id: original.id, conversationId: original.conversationId }, signal)); checkMobileIntent(intent);
    await this.#edit(intent, entries => entries.filter(value => value.id !== original.id)); this.#capture = null; this.#original = ""; this.#publish("idle");
  }
}
