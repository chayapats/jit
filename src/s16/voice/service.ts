import { createHash } from 'node:crypto';
import { AppError } from '../../errors';
import { DurableJournal } from '../../s15/durable-journal';
import { canonical, exact, nat } from '../../s15/policy/validation';
import { identity } from '../../s15/conversation/validation';
import type { LocalVoiceEngine, VoiceProcessContext } from './local';
import { captureWavInfo } from './wav';
import { voiceLimits, type VoiceCapture, type VoiceCaptureCommand, type VoicePlayback, type VoicePlaybackCommand, type VoiceQuotaConfig, type VoiceStatus, type VoiceTranscript, type VoiceUsage } from './contracts';
import { VoiceCallService, type VoiceCallPorts } from './calls';
import { voiceCallLimits, type VoiceCallBinding } from './call-contracts';

/** Authenticated ingress reacquired after every wait. This host closure is never serialized or offered as a tool. */
export type VoiceOwner<Actor> = () => Actor;
/** Existing owning projections supply conversation access and the current guarded result, never cached client text. */
export interface VoiceServiceOptions<Actor> {
  path: string; installationId: string; create: boolean; limits: VoiceQuotaConfig;
  engine(): Promise<LocalVoiceEngine>;
  requireOwner(actor: Actor): void; ownerGeneration(): number;
  conversation(actor: Actor, id: string): void;
  reply(actor: Actor, conversationId: string, requestId: string): { revision: number; text: string };
  now?: () => number;
  /** Optional existing CHAT/steer owners; no call capability is exposed without this explicit composition. */
  calls?: VoiceCallPorts<Actor>;
}
interface Operation {
  id: string; kind: 'capture' | 'playback'; conversationId: string; generation: number; commandHash: string;
  state: VoiceCapture['state']; createdAt: number; expiresAt: number; day: string; boundMs: number;
  reservedMs: number; chargedMs: number; conservative: boolean; started: boolean; inputHash: string | null; inputMs: number | null;
  call?: VoiceCallBinding;
}
interface Active { abort: AbortController; promise: Promise<VoiceTranscript | VoicePlayback> }
const fail = (code: string, status = 409): never => { throw new AppError(code, status); };
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const day = (at: number) => new Date(at).toISOString().slice(0, 10);
const stamp = (id: string): number => { const match = /^v_(0|[1-9][0-9]{0,15})_[a-f0-9]{32}$/.exec(id); if (!match || !Number.isSafeInteger(Number(match[1]))) return fail('voice_request_invalid', 400); return Number(match[1]); };

/** Validate only explicit finite local quotas. Configuration never creates provider/account/billing authority. */
export function validateVoiceQuota(value: unknown): asserts value is VoiceQuotaConfig {
  exact(value, ['dailyMs', 'captureMs']); nat(value.dailyMs, true); nat(value.captureMs, true);
  if (value.dailyMs > 3600000 || value.captureMs > voiceLimits.captureMs || value.captureMs > value.dailyMs) fail('invalid_voice_config', 400);
}

/** Protected owner-only speech/quota journal. Speech never admits work; explicit call confirmation delegates to
 * existing CHAT/steer owners. No actor, approval or provider tool is exposed. */
export class VoiceService<Actor> {
  private readonly active = new Map<string, Active>();
  private readonly results = new Map<string, { value: VoiceTranscript | VoicePlayback; bytes: number; until: number }>();
  private closed = false;
  private closing: Promise<void> | null = null;
  /** Additive finite call metadata; the existing CHAT ports retain all work/decision authority. */
  readonly calls: VoiceCallService<Actor> | undefined;
  private constructor(readonly options: VoiceServiceOptions<Actor>, private readonly journal: DurableJournal, private readonly engine: LocalVoiceEngine) {
    this.calls = options.calls ? new VoiceCallService(journal, { requireOwner: options.requireOwner, generation: options.ownerGeneration, conversation: options.conversation, now: () => this.now(), clock: () => this.clock(), ports: options.calls }, {
      status: owner => this.status(owner), idle: () => !this.all().some(record => ['capturing', 'processing'].includes(record.state)),
      capture: (owner, conversationId, command, signal, binding) => this.begin(owner, conversationId, command, signal, binding),
      playback: (owner, command, signal, binding) => this.playback(owner, command, signal, binding), halt: id => this.haltCall(id),
    }) : undefined;
  }

  /** Acquire the exclusive journal lease before opening local scratch/engine, then retain interrupted usage without replay. */
  static async open<Actor>(options: VoiceServiceOptions<Actor>): Promise<VoiceService<Actor>> {
    validateVoiceQuota(options.limits);
    options = { ...options, limits: { ...options.limits } };
    const journal = new DurableJournal(options.path, options.installationId, options.create, 0x4a565631);
    let engine: LocalVoiceEngine | undefined;
    try {
      if (options.create) journal.db.exec('CREATE TABLE voice_operations (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, record_json TEXT NOT NULL)');
      engine = await options.engine(); const service = new VoiceService(options, journal, engine);
      journal.tx(() => {
        for (const record of service.all()) if (['capturing', 'processing'].includes(record.state)) { record.state = record.started ? 'unknown' : 'expired'; record.reservedMs = 0; service.save(record); }
      });
      return service;
    } catch (error) { await engine?.close(); journal.close(); throw error; }
  }
  private all(): Operation[] { return this.journal.db.query<{ record_json: string }, []>('SELECT record_json FROM voice_operations ORDER BY rowid').all().map(row => JSON.parse(row.record_json) as Operation); }
  private get(id: string): Operation { stamp(id); const row = this.journal.db.query<{ record_json: string }, [string]>('SELECT record_json FROM voice_operations WHERE id=?').get(id); if (!row) return fail('voice_not_found', 404); return JSON.parse(row.record_json) as Operation; }
  private find(id: string): Operation | null { stamp(id); const row = this.journal.db.query<{ record_json: string }, [string]>('SELECT record_json FROM voice_operations WHERE id=?').get(id); return row ? JSON.parse(row.record_json) as Operation : null; }
  private save(record: Operation): void { const text = canonical(record); if (Buffer.byteLength(text) > 4096) fail('voice_storage_limit'); this.journal.db.query('INSERT INTO voice_operations VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json').run(record.id, record.createdAt, text); }
  private now(): number {
    const wall = (this.options.now ?? Date.now)(); if (!Number.isSafeInteger(wall) || wall < 0 || wall > 8640000000000000) return fail('voice_time_invalid');
    const clock = this.journal.db.query<{ json: string }, []>("SELECT json FROM records WHERE id='voice_clock'").get();
    return Math.max(wall, clock ? (JSON.parse(clock.json) as { at: number }).at : 0);
  }
  private clock(): number { const at = this.now(); this.journal.put('voice_clock', { at }); return at; }
  private owner(owner: VoiceOwner<Actor>, record?: Operation, inactiveCall = false): Actor {
    if (this.closed) return fail('voice_unavailable', 503);
    const actor = owner(); this.options.requireOwner(actor);
    if (record) { if (record.generation !== this.options.ownerGeneration()) return fail('voice_stale', 403); this.options.conversation(actor, record.conversationId); if (record.call && !inactiveCall) { if (!this.calls) return fail('voice_call_inactive'); this.calls.guard(owner, record.call); } }
    return actor;
  }
  private prune(at: number): void {
    // Expired recording reservations sent no CLI command. Processing capacity is released only by its real completion.
    for (const record of this.all()) if (record.state === 'capturing' && record.expiresAt <= at) { record.state = 'expired'; record.reservedMs = 0; this.save(record); }
    this.journal.db.query("DELETE FROM voice_operations WHERE created_at<? AND json_extract(record_json,'$.state') NOT IN ('capturing','processing')").run(at - voiceLimits.retentionMs);
    for (const [id, entry] of this.results) if (entry.until <= at) this.results.delete(id);
  }
  private usageAt(at: number): VoiceUsage {
    const today = day(at), rows = this.all().filter(row => row.day === today);
    return { day: today, unit: 'local_audio_ms', limitMs: this.options.limits.dailyMs, chargedMs: rows.reduce((n, row) => n + row.chargedMs, 0), reservedMs: rows.reduce((n, row) => n + (row.state === 'capturing' && row.expiresAt <= at ? 0 : row.reservedMs), 0), conservativeMs: rows.reduce((n, row) => n + (row.conservative ? row.chargedMs : 0), 0) };
  }
  private capture(record: Operation): VoiceCapture { return { id: record.id, conversationId: record.conversationId, state: record.state, recordingEndsAt: record.kind === 'capture' ? record.expiresAt - voiceLimits.submissionMs : record.expiresAt, expiresAt: record.expiresAt, maxDurationMs: record.boundMs }; }
  private cached<T extends VoiceTranscript | VoicePlayback>(id: string, owner: VoiceOwner<Actor>): T {
    const record = this.get(id); this.owner(owner, record);
    const result = this.results.get(id); if (!result || result.until <= this.now()) return fail(record.state === 'unknown' ? 'voice_outcome_unknown' : 'voice_result_expired');
    return { ...structuredClone(result.value), usage: this.usageAt(this.now()) } as T;
  }
  private cache(id: string, value: VoiceTranscript | VoicePlayback): void {
    const bytes = Buffer.byteLength(JSON.stringify(value)); if (bytes > voiceLimits.responseCacheBytes) fail('voice_audio_limit');
    this.results.set(id, { value: structuredClone(value), bytes, until: this.now() + voiceLimits.responseCacheMs });
    let total = [...this.results.values()].reduce((n, entry) => n + entry.bytes, 0);
    for (const [key, entry] of this.results) { if (total <= voiceLimits.responseCacheBytes && this.results.size <= 16) break; this.results.delete(key); total -= entry.bytes; }
  }
  private fresh(id: string, at: number): void { const issued = stamp(id); if (issued > at + 30000 || issued < at - voiceLimits.requestAgeMs) fail('voice_request_expired'); }
  private capacity(at: number, upper: number, kind: Operation['kind'], call?: VoiceCallBinding): void {
    this.prune(at);
    if (this.all().some(row => ['capturing', 'processing'].includes(row.state) && (!call || !row.call || row.call.id !== call.id || row.call.revision !== call.revision || row.kind === kind))) fail('voice_busy');
    if (this.all().length >= voiceLimits.operations) fail('voice_storage_limit');
    const usage = this.usageAt(at); if (upper > usage.limitMs - usage.chargedMs - usage.reservedMs) fail('voice_budget_exhausted');
  }

  /** Metadata-only status; health inspection never starts capture, speech or Bot work. */
  async status(owner: VoiceOwner<Actor>): Promise<VoiceStatus> {
    this.owner(owner); const available = await this.engine.available(); this.owner(owner);
    const at = this.now(); return { contract: 's16-voice/v1', available, serverTime: at, route: 'local', limits: { ...this.options.limits }, usage: this.usageAt(at), ...(this.calls ? { calls: voiceCallLimits } : {}) };
  }
  /** Reserve a bounded draft. Retried/expired identities cannot silently create another capture. */
  async begin(owner: VoiceOwner<Actor>, conversationId: string, input: VoiceCaptureCommand, signal?: AbortSignal, binding?: VoiceCallBinding): Promise<VoiceCapture> {
    if (signal?.aborted) fail('voice_cancelled');
    exact(input, ['contract', 'requestId']); if (input.contract !== 's16-voice-capture/v1') fail('voice_request_invalid', 400); identity(conversationId); stamp(input.requestId);
    binding = binding ? { ...binding } : undefined;
    const command = structuredClone(input), hash = sha(canonical({ ...command, conversationId, ...(binding ? { call: binding } : {}) }));
    this.options.conversation(this.owner(owner), conversationId);
    if (!await this.engine.available()) fail('voice_unavailable', 503);
    return this.journal.tx(() => {
      if (signal?.aborted) fail('voice_cancelled');
      this.options.conversation(this.owner(owner), conversationId); const at = this.clock(), old = this.find(command.requestId);
      if (old) { if (old.commandHash !== hash) fail('request_id_conflict'); this.owner(owner, old); this.prune(at); return this.capture(this.get(old.id)); }
      const call = binding ? this.calls?.guard(owner, binding) : undefined; if (binding && (!call || call.conversationId !== conversationId)) fail('voice_call_inactive');
      const bound = call ? Math.floor(Math.min(this.options.limits.captureMs, call.expiresAt - at - voiceLimits.permissionMs - voiceLimits.submissionMs)) : this.options.limits.captureMs;
      if (bound < 1) fail('voice_call_time_limit');
      this.fresh(command.requestId, at); this.capacity(at, bound, 'capture', binding);
      const record: Operation = { id: command.requestId, kind: 'capture', conversationId, generation: this.options.ownerGeneration(), commandHash: hash, state: 'capturing', createdAt: at, expiresAt: at + bound + voiceLimits.permissionMs + voiceLimits.submissionMs, day: day(at), boundMs: bound, reservedMs: bound, chargedMs: 0, conservative: false, started: false, inputHash: null, inputMs: null, ...(binding ? { call: binding } : {}) };
      this.save(record); return this.capture(record);
    });
  }
  /** Inspect current capture metadata without exposing its transcript/audio or admitting new work. */
  inspect(owner: VoiceOwner<Actor>, id: string): VoiceCapture { this.owner(owner); const record = this.get(id); this.owner(owner, record); return { ...this.capture(record), state: record.state === 'capturing' && record.expiresAt <= this.now() ? 'expired' : record.state }; }

  /** Final synchronous draft release, after every transport wait. A transcript is never an approval or message. */
  publishTranscript<T>(owner: VoiceOwner<Actor>, id: string, publish: (value: VoiceTranscript) => T): T {
    this.owner(owner); if (this.get(id).kind !== 'capture') fail('voice_request_invalid');
    return publish(this.cached<VoiceTranscript>(id, owner));
  }
  /** Reacquire current reply/source permission in the same synchronous turn that the owner transport serializes audio. */
  publishPlayback<T>(owner: VoiceOwner<Actor>, command: VoicePlaybackCommand, publish: (value: VoicePlayback) => T): T {
    this.owner(owner); const record = this.get(command.requestId); this.owner(owner, record);
    if (record.kind !== 'playback' || record.commandHash !== sha(canonical(command))) fail('request_id_conflict');
    const reply = this.options.reply(this.owner(owner), command.conversationId, command.targetRequestId);
    if (reply.revision !== command.targetRevision || sha(reply.text) !== command.textSha256) fail('voice_result_changed');
    return publish(this.cached<VoicePlayback>(record.id, owner));
  }

  private run<T extends VoiceTranscript | VoicePlayback>(owner: VoiceOwner<Actor>, record: Operation, signal: AbortSignal, body: (context: VoiceProcessContext) => Promise<T>, finalGuard?: () => void): Promise<T> {
    const abort = new AbortController(), stop = () => abort.abort(); signal.addEventListener('abort', stop, { once: true }); if (signal.aborted) stop();
    const guard = () => { if (abort.signal.aborted) fail('voice_cancelled'); const current = this.get(record.id); this.owner(owner, current); if (current.state !== 'processing') fail('voice_cancelled'); };
    const promise = Promise.resolve().then(async () => {
      try {
        guard(); const result = await body({ signal: abort.signal, guard, started: () => this.journal.tx(() => { guard(); const current = this.get(record.id); if (current.started) fail('voice_process_replay'); current.started = true; current.reservedMs = 0; current.chargedMs = current.kind === 'capture' ? current.inputMs! : current.boundMs; current.conservative = current.kind === 'playback'; this.save(current); }) });
        if (abort.signal.aborted) fail('voice_cancelled');
        const current = this.get(record.id); this.owner(owner, current); if (current.state !== 'ready') fail('voice_cancelled');
        finalGuard?.(); this.cache(record.id, result); return structuredClone(result);
      } catch (error) {
        this.journal.tx(() => { const current = this.get(record.id); current.state = abort.signal.aborted ? 'cancelled' : current.started ? 'unknown' : 'failed'; current.reservedMs = 0; this.save(current); });
        this.results.delete(record.id); throw error;
      } finally { signal.removeEventListener('abort', stop); this.active.delete(record.id); }
    });
    this.active.set(record.id, { abort, promise }); return promise;
  }

  /** Strict raw WAV is snapshotted/bound once; cancellation or a lost result never replays transcription. */
  transcribe(owner: VoiceOwner<Actor>, id: string, input: Uint8Array, signal: AbortSignal): Promise<VoiceTranscript> {
    this.owner(owner);
    const wav = input.slice(), info = captureWavInfo(wav), hash = sha(wav); let record = this.get(id); this.owner(owner, record);
    if (record.kind !== 'capture' || info.durationMs > record.boundMs) return fail('voice_audio_limit', 400);
    if (record.inputHash && record.inputHash !== hash) return fail('request_id_conflict');
    const active = this.active.get(id); if (active) return active.promise.then(() => this.cached<VoiceTranscript>(id, owner));
    if (record.state !== 'capturing') return Promise.resolve(this.cached<VoiceTranscript>(id, owner));
    record = this.journal.tx(() => { const current = this.get(id), at = this.clock(); this.owner(owner, current); if (at >= current.expiresAt) fail('voice_capture_expired'); current.state = 'processing'; current.inputHash = hash; current.inputMs = Math.ceil(info.durationMs); this.save(current); return current; });
    return this.run(owner, record, signal, async context => {
      const text = await this.engine.transcribe(wav, context); context.guard();
      return this.journal.tx(() => { context.guard(); const current = this.get(id); current.state = 'ready'; current.reservedMs = 0; current.chargedMs = current.inputMs!; current.conservative = false; this.save(current); return { contract: 's16-voice-transcript/v1', capture: this.capture(current), text, usage: this.usageAt(this.clock()) }; });
    });
  }
  /** Reacquire exact current result before processing and before publishing bounded local reply audio. */
  async playback(owner: VoiceOwner<Actor>, input: VoicePlaybackCommand, signal: AbortSignal, binding?: VoiceCallBinding): Promise<VoicePlayback> {
    exact(input, ['contract', 'requestId', 'conversationId', 'targetRequestId', 'targetRevision', 'textSha256']);
    if (input.contract !== 's16-voice-playback/v1' || !/^[a-f0-9]{64}$/.test(input.textSha256)) fail('voice_request_invalid', 400);
    identity(input.conversationId); identity(input.targetRequestId); nat(input.targetRevision, true); stamp(input.requestId);
    binding = binding ? { ...binding } : undefined;
    const command = structuredClone(input), hash = sha(canonical(binding ? { ...command, call: binding } : command));
    const reply = () => { const actor = this.owner(owner); if (binding) { const call = this.calls?.guard(owner, binding); if (!call || call.conversationId !== command.conversationId) fail('voice_call_inactive'); } const value = this.options.reply(actor, command.conversationId, command.targetRequestId); if (value.revision !== command.targetRevision || sha(value.text) !== command.textSha256) fail('voice_result_changed'); return value.text; };
    const text = reply(), existing = this.find(command.requestId);
    if (existing) { if (existing.commandHash !== hash) fail('request_id_conflict'); const active = this.active.get(existing.id); if (active) await active.promise; reply(); return this.cached(existing.id, owner); }
    if (!await this.engine.available()) fail('voice_unavailable', 503);
    const admitted = this.journal.tx(() => {
      const old = this.find(command.requestId);
      if (old) { if (old.commandHash !== hash) fail('request_id_conflict'); return { record: old, existing: true }; }
      reply(); const at = this.clock(); this.fresh(command.requestId, at); this.capacity(at, voiceLimits.synthesisMs, 'playback', binding);
      const value: Operation = { id: command.requestId, kind: 'playback', conversationId: command.conversationId, generation: this.options.ownerGeneration(), commandHash: hash, state: 'processing', createdAt: at, expiresAt: at + 120000, day: day(at), boundMs: voiceLimits.synthesisMs, reservedMs: voiceLimits.synthesisMs, chargedMs: 0, conservative: false, started: false, inputHash: command.textSha256, inputMs: null, ...(binding ? { call: binding } : {}) }; this.save(value); return { record: value, existing: false };
    });
    const record = admitted.record;
    if (admitted.existing) { const active = this.active.get(record.id); if (active) await active.promise; reply(); return this.cached(record.id, owner); }
    return this.run(owner, record, signal, async context => {
      const audio = await this.engine.synthesize(text, { ...context, guard() { context.guard(); reply(); } }); context.guard(); reply();
      return this.journal.tx(() => { context.guard(); reply(); const current = this.get(record.id); current.state = 'ready'; current.reservedMs = 0; current.chargedMs = Math.ceil(audio.durationMs); current.conservative = false; this.save(current); return { contract: 's16-voice-playback/v1', id: current.id, conversationId: command.conversationId, targetRequestId: command.targetRequestId, wavBase64: Buffer.from(audio.wav).toString('base64'), durationMs: Math.ceil(audio.durationMs), usage: this.usageAt(this.clock()) }; });
    }, reply);
  }
  /** Cancel fences private drafts/playback only; it never stops or approves underlying CHAT work. */
  async cancel(owner: VoiceOwner<Actor>, id: string): Promise<VoiceCapture> {
    this.owner(owner); this.owner(owner, this.get(id), true); const active = this.active.get(id); active?.abort.abort(); if (active) await active.promise.catch(() => {});
    return this.journal.tx(() => { this.owner(owner); this.clock(); const record = this.get(id); this.owner(owner, record, true); record.state = 'cancelled'; record.reservedMs = 0; this.results.delete(id); this.save(record); return this.capture(record); });
  }
  private async haltCall(id: string): Promise<void> {
    const records = this.all().filter(record => record.call?.id === id), active = records.flatMap(record => { const operation = this.active.get(record.id); return operation ? [operation] : []; });
    for (const operation of active) operation.abort.abort(); await Promise.allSettled(active.map(operation => operation.promise));
    this.journal.tx(() => { for (const previous of records) { const record = this.get(previous.id); if (['capturing', 'processing', 'ready'].includes(record.state)) { record.state = 'cancelled'; record.reservedMs = 0; this.save(record); } this.results.delete(record.id); } });
  }
  /** Native engine closure joins all children before journal/capacity custody closes. */
  close(): Promise<void> { return this.closing ??= (async () => { this.closed = true; const calls = this.calls?.close(); for (const active of this.active.values()) active.abort.abort(); await this.engine.close(); await calls; await Promise.allSettled([...this.active.values()].map(value => value.promise)); this.results.clear(); this.journal.close(); })(); }
}
