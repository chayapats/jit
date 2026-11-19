import { createHash } from 'node:crypto';
import { AppError } from '../../errors';
import type { DurableJournal } from '../../s15/durable-journal';
import { canonical, content, exact, identity, integer } from '../../s15/conversation/validation';
import type { ConversationReceipt, ConversationSteerCommand, ConversationSteerReceipt, ConversationTextCommand } from '../../s15/conversation/types';
import { voiceLimits, type VoiceCapture, type VoiceCaptureCommand, type VoicePlayback, type VoicePlaybackCommand, type VoiceStatus } from './contracts';
import { voiceCallLimits, type VoiceCallBegin, type VoiceCallBinding, type VoiceCallCapture, type VoiceCallConfirm, type VoiceCallControl, type VoiceCallPlayback, type VoiceCallTurn, type VoiceCallView } from './call-contracts';
import type { VoiceOwner } from './service';

/** Existing CHAT owners only. Call code never supplies a grant, action decision, model loop or cached private reply. */
export interface VoiceCallPorts<Actor> {
  submit(actor: Actor, command: ConversationTextCommand): ConversationReceipt;
  steer(actor: Actor, command: ConversationSteerCommand): ConversationSteerReceipt;
  receipt(actor: Actor, requestId: string): ConversationReceipt;
  steerReceipt(actor: Actor, requestId: string): ConversationSteerReceipt;
  /** Host timer seam; deterministic tests expire the same protected deadline without sleeping. */
  timer?(ms: number, expire: () => void): () => void;
}
interface CallRecord {
  id: string; conversationId: string; generation: number; revision: number; createdAt: number; expiresAt: number;
  state: VoiceCallView['state']; reason: VoiceCallView['reason']; lastResume: number | null;
}
interface TurnRecord { ordinal: number; requestId: string; kind: 'message' | 'steer'; target: string | null; hash: string; accepted: boolean }
interface Speech<Actor> {
  status(owner: VoiceOwner<Actor>): Promise<VoiceStatus>; idle(): boolean;
  capture(owner: VoiceOwner<Actor>, conversationId: string, command: VoiceCaptureCommand, signal: AbortSignal | undefined, binding: VoiceCallBinding): Promise<VoiceCapture>;
  playback(owner: VoiceOwner<Actor>, command: VoicePlaybackCommand, signal: AbortSignal, binding: VoiceCallBinding): Promise<VoicePlayback>;
  halt(id: string): Promise<void>;
}
interface CallOptions<Actor> { requireOwner(actor: Actor): void; generation(): number; conversation(actor: Actor, id: string): void; now(): number; clock(): number; ports: VoiceCallPorts<Actor> }
const fail = (code: string, status = 409): never => { throw new AppError(code, status); };
const issuedAt = (id: string) => { const found = /^v_(0|[1-9][0-9]{0,15})_[a-f0-9]{32}$/.exec(id); if (!found || !Number.isSafeInteger(Number(found[1]))) return fail('voice_request_invalid', 400); return Number(found[1]); };

/** Finite metadata-only call/turn continuity over the existing speech quota and owning CHAT journals.
 * An intent and CHAT receipt are separate durable writes. Recovery reads the original identity, never resubmits it. */
export class VoiceCallService<Actor> {
  private readonly timers = new Map<string, () => void>();
  private closed = false;
  constructor(private readonly journal: DurableJournal, private readonly options: CallOptions<Actor>, private readonly speech: Speech<Actor>) {
    journal.db.exec('CREATE TABLE IF NOT EXISTS voice_calls (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS voice_call_turns (call_id TEXT NOT NULL, ordinal INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY(call_id,ordinal));');
    journal.tx(() => { for (const call of this.all()) if (call.state !== 'ended') { call.state = 'ended'; call.reason = 'restart'; call.revision++; this.save(call); } });
  }
  private all(): CallRecord[] { return this.journal.db.query<{ json: string }, []>('SELECT json FROM voice_calls ORDER BY created_at DESC,rowid DESC').all().map(row => JSON.parse(row.json) as CallRecord); }
  private get(id: string): CallRecord { issuedAt(id); const row = this.journal.db.query<{ json: string }, [string]>('SELECT json FROM voice_calls WHERE id=?').get(id); if (!row) return fail('voice_call_not_found', 404); return JSON.parse(row.json) as CallRecord; }
  private save(call: CallRecord): void { this.journal.db.query('INSERT INTO voice_calls VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(call.id, call.createdAt, canonical(call)); }
  private turns(id: string): TurnRecord[] { return this.journal.db.query<{ json: string }, [string]>('SELECT json FROM voice_call_turns WHERE call_id=? ORDER BY ordinal').all(id).map(row => JSON.parse(row.json) as TurnRecord); }
  private saveTurn(id: string, turn: TurnRecord): void { this.journal.db.query('INSERT INTO voice_call_turns VALUES(?,?,?) ON CONFLICT(call_id,ordinal) DO UPDATE SET json=excluded.json').run(id, turn.ordinal, canonical(turn)); }
  private owner(owner: VoiceOwner<Actor>, call?: CallRecord): Actor {
    if (this.closed) return fail('voice_unavailable', 503);
    const actor = owner(); this.options.requireOwner(actor);
    if (call) { if (call.generation !== this.options.generation()) return fail('voice_stale', 403); this.options.conversation(actor, call.conversationId); }
    return actor;
  }
  private finish(call: CallRecord, reason: NonNullable<VoiceCallView['reason']>): void {
    if (call.state === 'ended') return;
    call.state = 'ended'; call.reason = reason; call.revision++; this.save(call);
    this.timers.get(call.id)?.(); this.timers.delete(call.id); void this.speech.halt(call.id).catch(() => {});
  }
  private expire(id: string): void { if (this.closed) return; this.journal.tx(() => { const call = this.get(id); this.finish(call, 'timeout'); }); }
  private arm(call: CallRecord): void {
    const timer = this.options.ports.timer ?? ((ms: number, expire: () => void) => { const handle = setTimeout(expire, ms); handle.unref(); return () => clearTimeout(handle); });
    this.timers.set(call.id, timer(Math.max(0, call.expiresAt - this.options.now()), () => this.expire(call.id)));
  }
  /** Rechecked at every speech start/publication; a muted/expired/old revision can never revive native audio. */
  guard(owner: VoiceOwner<Actor>, binding: VoiceCallBinding): CallRecord {
    const call = this.get(binding.id); this.owner(owner, call);
    if (call.expiresAt <= this.options.now()) this.journal.tx(() => this.finish(call, 'timeout'));
    if (call.state !== 'active') return fail('voice_call_inactive');
    if (binding.revision !== call.revision) return fail('voice_call_stale'); return call;
  }
  // The actor is captured after a current conversation check in the same synchronous turn. Each owning
  // receipt port rechecks it; do not carry this projection optimization across an async boundary.
  private resolve(actor: Actor, call: CallRecord, turn: TurnRecord): VoiceCallTurn {
    let receipt: VoiceCallTurn['receipt'] = null;
    try {
      receipt = turn.kind === 'message' ? this.options.ports.receipt(actor, turn.requestId) : this.options.ports.steerReceipt(actor, turn.requestId);
      if (receipt.requestId !== turn.requestId || receipt.conversationId !== call.conversationId || turn.kind === 'steer' && (!('target' in receipt) || receipt.target !== turn.target)) return fail('voice_turn_receipt_invalid');
      if (!turn.accepted) this.journal.tx(() => { turn.accepted = true; this.saveTurn(call.id, turn); });
    } catch (error) { if (!(error instanceof AppError) || error.status !== 404) throw error; }
    return { ordinal: turn.ordinal, requestId: turn.requestId, kind: turn.kind, target: turn.target, state: receipt ? 'accepted' : turn.accepted ? 'unavailable' : 'unaccepted', receipt };
  }
  /** Read-only with respect to speech/CHAT: only metadata reconciliation and finite expiry may change. */
  view(owner: VoiceOwner<Actor>, id: string): VoiceCallView {
    const call = this.get(id), actor = this.owner(owner, call);
    if (call.expiresAt <= this.options.now()) this.journal.tx(() => this.finish(call, 'timeout'));
    return { contract: 's16-voice-call/v1', id, conversationId: call.conversationId, revision: call.revision, state: call.state, reason: call.reason, serverTime: this.options.now(), expiresAt: call.expiresAt, limits: voiceCallLimits, turns: this.turns(id).map(turn => this.resolve(actor, call, turn)) };
  }
  /** Current-owner conversation history, with no automatic resume, send or synthesis. */
  list(owner: VoiceOwner<Actor>, conversationId: string): VoiceCallView[] {
    identity(conversationId); this.options.conversation(this.owner(owner), conversationId);
    return this.all().filter(call => call.generation === this.options.generation() && call.conversationId === conversationId).slice(0, 8).map(call => this.view(owner, call.id));
  }
  /** Explicit Call intent; an old identity returns its original ended lifecycle instead of admitting another call. */
  async begin(owner: VoiceOwner<Actor>, conversationId: string, value: unknown, signal?: AbortSignal): Promise<VoiceCallView> {
    if (signal?.aborted) return fail('voice_cancelled');
    exact(value, ['contract', 'requestId']); if (value.contract !== 's16-voice-call-begin/v1') return fail('voice_request_invalid', 400);
    const input = structuredClone(value) as unknown as VoiceCallBegin; issuedAt(input.requestId); identity(conversationId);
    this.options.conversation(this.owner(owner), conversationId);
    const fresh = this.journal.tx(() => {
      this.options.conversation(this.owner(owner), conversationId); const at = this.options.clock();
      for (const call of this.all()) {
        if (call.state !== 'ended' && call.expiresAt <= at) this.finish(call, 'timeout');
        if (call.state === 'ended' && call.createdAt < at - voiceLimits.retentionMs) { this.journal.db.query('DELETE FROM voice_call_turns WHERE call_id=?').run(call.id); this.journal.db.query('DELETE FROM voice_calls WHERE id=?').run(call.id); }
      }
      const old = this.all().find(call => call.id === input.requestId);
      if (old) { this.owner(owner, old); if (old.conversationId !== conversationId) fail('request_id_conflict'); return false; }
      const issued = issuedAt(input.requestId); if (issued < at - voiceLimits.requestAgeMs || issued > at + 30000) fail('voice_request_expired');
      if (this.all().some(call => call.state !== 'ended') || !this.speech.idle()) fail('voice_busy');
      if (this.all().length >= voiceCallLimits.retainedCalls) fail('voice_storage_limit');
      const call: CallRecord = { id: input.requestId, conversationId, generation: this.options.generation(), revision: 1, createdAt: at, expiresAt: at + voiceCallLimits.durationMs, state: 'active', reason: null, lastResume: null };
      this.save(call); this.arm(call); return true;
    });
    if (!fresh) return this.view(owner, input.requestId);
    // Admit the metadata identity before route-health awaits, so an immediate End can fence it while preparing.
    const abort = () => this.journal.tx(() => this.finish(this.get(input.requestId), 'owner'));
    signal?.addEventListener('abort', abort, { once: true });
    try {
      if (signal?.aborted) { abort(); fail('voice_cancelled'); }
      const status = await this.speech.status(owner), call = this.get(input.requestId); this.owner(owner, call);
      if (signal?.aborted) fail('voice_cancelled');
      if (call.state === 'ended') return this.view(owner, call.id);
      if (!status.available) fail('voice_unavailable', 503);
      if (status.usage.chargedMs + status.usage.reservedMs >= status.usage.limitMs) fail('voice_budget_exhausted');
      return this.view(owner, input.requestId);
    } catch (error) {
      this.journal.tx(() => this.finish(this.get(input.requestId), error instanceof AppError && error.code === 'voice_budget_exhausted' ? 'budget' : signal?.aborted ? 'owner' : 'unavailable'));
      throw error;
    } finally { signal?.removeEventListener('abort', abort); }
  }
  /** Narrowing mute/end is safe when repeated; explicit resume is bound to exactly the current revision. */
  async control(owner: VoiceOwner<Actor>, id: string, value: unknown): Promise<VoiceCallView> {
    exact(value, ['contract', 'revision', 'kind']); if (value.contract !== 's16-voice-call-control/v1' || !['mute', 'resume', 'end'].includes(String(value.kind))) return fail('voice_request_invalid', 400);
    integer(value.revision, 1); const input = value as unknown as VoiceCallControl; let resumed = false;
    this.journal.tx(() => {
      const call = this.get(id); this.owner(owner, call); this.options.clock();
      if (call.expiresAt <= this.options.now()) this.finish(call, 'timeout');
      if (input.kind === 'end') { this.finish(call, 'owner'); return; }
      if (input.kind === 'mute') { if (call.state === 'active') { call.state = 'muted'; call.revision++; call.lastResume = null; this.save(call); } return; }
      if (call.state === 'active' && call.lastResume === input.revision) return;
      if (!['active', 'muted'].includes(call.state) || call.revision !== input.revision) fail('voice_call_stale');
      call.state = 'active'; call.lastResume = input.revision; call.revision++; this.save(call); resumed = true;
    });
    if (input.kind !== 'resume' || resumed) await this.speech.halt(id);
    return this.view(owner, id);
  }
  /** Owner-confirmed exact text goes to the existing CHAT/steer port once; recovery first reads that identity. */
  confirm(owner: VoiceOwner<Actor>, id: string, value: unknown): VoiceCallView {
    exact(value, ['contract', 'revision', 'ordinal', 'text', 'target']);
    if (value.contract !== 's16-voice-call-turn/v1') return fail('voice_request_invalid', 400);
    integer(value.revision, 1); integer(value.ordinal, 1, voiceCallLimits.turns); content(value.text); if (value.target !== null) identity(value.target);
    const input = structuredClone(value) as unknown as VoiceCallConfirm, call = this.get(id); this.owner(owner, call);
    const hash = createHash('sha256').update(canonical({ ...input, callId: id, conversationId: call.conversationId })).digest('hex');
    let turn = this.turns(id).find(turn => turn.ordinal === input.ordinal);
    if (turn) {
      if (turn.hash !== hash) fail('request_id_conflict');
      if (this.resolve(this.owner(owner, call), call, turn).state !== 'unaccepted') return this.view(owner, id);
    }
    this.guard(owner, { id, revision: input.revision });
    if (input.target !== null) {
      const target = this.options.ports.receipt(this.owner(owner, call), input.target);
      if (target.conversationId !== call.conversationId || target.rootRequestId !== input.target) fail('outside_scope', 403);
    }
    if (!turn) this.journal.tx(() => {
      this.guard(owner, { id, revision: input.revision }); const previous = this.turns(id);
      if (input.ordinal !== previous.length + 1) fail('voice_turn_order');
      const actor = this.owner(owner, call);
      if (previous.some(row => !row.accepted && this.resolve(actor, call, row).state === 'unaccepted')) fail('voice_turn_recovery_required');
      turn = { ordinal: input.ordinal, requestId: `${id}_t${input.ordinal}`, kind: input.target === null ? 'message' : 'steer', target: input.target, hash, accepted: false }; this.saveTurn(id, turn);
    });
    // The committed intent and CHAT write are distinct crash boundaries; no await or invented retry ID is used.
    const actor = this.owner(owner, this.guard(owner, { id, revision: input.revision }));
    if (turn!.kind === 'message') this.options.ports.submit(actor, { contract: 's15-conversation/v1', requestId: turn!.requestId, conversationId: call.conversationId, text: input.text, continuation: null });
    else this.options.ports.steer(actor, { contract: 's16-conversation-steer/v1', requestId: turn!.requestId, conversationId: call.conversationId, target: turn!.target!, text: input.text });
    this.resolve(this.owner(owner, call), call, turn!);
    if (turn!.ordinal === voiceCallLimits.turns) this.journal.tx(() => this.finish(this.get(id), 'turn_limit'));
    return this.view(owner, id);
  }
  private async speechFailure(owner: VoiceOwner<Actor>, id: string, error: unknown): Promise<never> {
    if (error instanceof AppError && ['voice_budget_exhausted', 'voice_unavailable', 'voice_call_time_limit'].includes(error.code)) {
      this.journal.tx(() => { const call = this.get(id); this.owner(owner, call); this.finish(call, error.code === 'voice_budget_exhausted' ? 'budget' : error.code === 'voice_call_time_limit' ? 'timeout' : 'unavailable'); });
      await this.speech.halt(id);
    }
    throw error;
  }
  /** Reserve one bounded native clip through the existing quota, bound to this call/revision. */
  async capture(owner: VoiceOwner<Actor>, id: string, value: unknown, signal?: AbortSignal): Promise<VoiceCapture> {
    exact(value, ['contract', 'revision', 'requestId']); if (value.contract !== 's16-voice-call-capture/v1') return fail('voice_request_invalid', 400);
    integer(value.revision, 1); const input = value as unknown as VoiceCallCapture, binding = { id, revision: input.revision }, call = this.guard(owner, binding);
    try { return await this.speech.capture(owner, call.conversationId, { contract: 's16-voice-capture/v1', requestId: input.requestId }, signal, binding); }
    catch (error) { return this.speechFailure(owner, id, error); }
  }
  /** Synthesis still selects the exact currently guarded CHAT result; no arbitrary page text is accepted. */
  async playback(owner: VoiceOwner<Actor>, id: string, value: unknown, signal: AbortSignal): Promise<VoicePlayback> {
    exact(value, ['contract', 'revision', 'request']); if (value.contract !== 's16-voice-call-playback/v1') return fail('voice_request_invalid', 400);
    integer(value.revision, 1); const input = value as unknown as VoiceCallPlayback, binding = { id, revision: input.revision }, call = this.guard(owner, binding);
    if (!input.request || input.request.conversationId !== call.conversationId) return fail('outside_scope', 403);
    try { return await this.speech.playback(owner, input.request, signal, binding); }
    catch (error) { return this.speechFailure(owner, id, error); }
  }
  /** Shutdown fences this lifecycle before the owning speech service joins its real child processes. */
  async close(): Promise<void> {
    const live = this.all().filter(call => call.state !== 'ended');
    this.journal.tx(() => { for (const call of live) this.finish(call, 'restart'); }); this.closed = true;
    for (const stop of this.timers.values()) stop(); this.timers.clear();
    await Promise.allSettled(live.map(call => this.speech.halt(call.id)));
  }
}
