import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, writeSync, fsyncSync } from "node:fs";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { AppError } from "../../errors";
import { normalizeSummaryOutcome } from "../../jobs/schedule-policy";
import { escapeIcsText, foldIcsLine } from "../../schedule-feed";
import { FixedWindowRate } from "../../security/inbound";
import { DurableJournal } from "../../s15/durable-journal";
import { PolicyError, canonical, digest } from "../../s15/policy/validation";
import type { ConversationOwnerRow, ConversationRoutinePin } from "../../s15/conversation";
import type { FileArtifact } from "../files/types";
import { dueInstants, nextInstant, scheduleLimits, upcoming, validateRecurrence, type RoutineInstant } from "./schedule";
import type { Routine, RoutineDetail, RoutineDraft, RoutineFeedView, RoutineList, RoutineOccurrence, RoutineOptions, RoutineProposal, RoutineReceipt, RoutineScope, RoutineServiceOptions, RoutineSource, RoutineSourceView, RoutineSummary, RoutineTrigger } from "./types";

/** Fixed `s16-routines/v1` bounds. */
export const routineLimits = Object.freeze({
  routines: 32, maxRuns: 366, maxDays: 366, nameBytes: 240, instructionBytes: 4000, history: 400, triggers: 16, sources: 8,
  hookBodyBytes: 262144, hookRequests: 30, hookWindowMs: 60000, deliveryRetentionMs: 7 * 86400000, keyRetentionMs: 30 * 86400000,
  signedSkewMs: 300000, githubFreshnessMs: 24 * 3600000, skipGraceMs: 10 * 60000, feedHorizonMs: 30 * 86400000, feedEvents: 5000, dispatchRetries: 5,
});
/**
 * Host-authored owner decision added to an occurrence's model input when the owner chose a quiet routine.
 * It only allows a successful run to say there is nothing new; a failure, hold or unknown stays visible.
 */
export const routineQuietDecision = canonical({ routine: { contract: "s16-routine-run/v1", quiet: 'This scheduled run belongs to an owner-confirmed routine. When it finds nothing new for the owner, reply with exactly {"outcome":"no_update"}. Never use no_update to hide a failure, a missing read or a decision the owner must make.' } });

const ID = /^[A-Za-z0-9_-]{1,128}$/, REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/, EVENT = /^[a-z0-9][a-z0-9._-]{0,63}$/, DELIVERY = /^[A-Za-z0-9._:-]{1,128}$/;
const githubEvents = ["ci_completed", "review_submitted"] as const;
const accessLevels = ["read", "reversible_write", "effect"] as const;
const blocking = new Set<RoutineOccurrence["state"]>(["dispatching", "submitted", "running", "waiting_review"]);
const observed = new Set<RoutineOccurrence["state"]>(["submitted", "running", "waiting_review", "unknown", "needs_you"]);
const attentionStates = new Set<RoutineOccurrence["state"]>(["succeeded", "needs_you", "failed", "unknown", "waiting_review", "refused", "denied"]);
const bad = (code: string, status = 400): never => { throw new AppError(code, status); };
const uid = (prefix: string) => `${prefix}_${randomBytes(16).toString("hex")}`;
function keys(value: unknown, required: readonly string[], optional: readonly string[] = []): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) bad("invalid_routine_command");
  const own = Object.keys(value as object);
  if (own.some(key => !required.includes(key) && !optional.includes(key)) || required.some(key => !own.includes(key))) bad("invalid_routine_command");
}
const id = (value: unknown, code = "invalid_routine_command"): string => typeof value === "string" && ID.test(value) ? value : bad(code);
const nat = (value: unknown): number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : bad("invalid_routine_command");
function text(value: unknown, max: number, code: string, multiline: boolean): string {
  if (typeof value !== "string" || !value.trim() || !value.isWellFormed() || Buffer.byteLength(value) > max || (multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/).test(value)) bad(code);
  return value as string;
}
const safe = <T>(fn: () => T): T => { try { return fn(); } catch (error) { if (error instanceof PolicyError) throw new AppError(error.code); throw error; } };
const hmac = (key: Buffer | string, data: string | Uint8Array) => createHmac("sha256", key).update(data).digest();

interface Row { json: string }
/**
 * `s16-routines/v1`: owner-confirmed scheduled and reacting responsibilities. Occurrences run through CHAT's
 * protected `submitRoutine` under current standing policy; configuration and payloads confer no authority.
 */
export class RoutineService<Actor> {
  readonly journal: DurableJournal;
  readonly #rate: FixedWindowRate;
  readonly #now: () => number;
  /** Occurrences submitted by an earlier process. CHAT's runnable registration is process-local, so each is
   * resubmitted once with its original request ID and pin; CHAT dedupes and only re-registers a queued request. */
  readonly #resubmit = new Set<string>();
  constructor(readonly options: RoutineServiceOptions<Actor>) {
    this.journal = new DurableJournal(options.path, options.installationId, options.create, 0x52543136);
    this.#now = options.now ?? Date.now;
    this.#rate = new FixedWindowRate({ requests: routineLimits.hookRequests, windowMs: routineLimits.hookWindowMs }, this.#now);
    const db = this.journal.db;
    db.exec(`CREATE TABLE IF NOT EXISTS routines_v1 (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, state TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS occurrences_v1 (id TEXT PRIMARY KEY, routine_id TEXT NOT NULL, seq INTEGER NOT NULL, state TEXT NOT NULL, json TEXT NOT NULL, UNIQUE (routine_id, seq));
      CREATE INDEX IF NOT EXISTS occurrences_v1_state ON occurrences_v1(state, routine_id);
      CREATE TABLE IF NOT EXISTS sources_v1 (id TEXT PRIMARY KEY, routine_id TEXT NOT NULL, state TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS deliveries_v1 (source_id TEXT NOT NULL, delivery_id TEXT NOT NULL, received_at INTEGER NOT NULL, PRIMARY KEY (source_id, delivery_id));
      CREATE TABLE IF NOT EXISTS event_keys_v1 (routine_id TEXT NOT NULL, key TEXT NOT NULL, first_at INTEGER NOT NULL, count INTEGER NOT NULL, occurrence_id TEXT NOT NULL, PRIMARY KEY (routine_id, key));
      CREATE TABLE IF NOT EXISTS feed_v1 (id INTEGER PRIMARY KEY CHECK (id = 1), owner_id TEXT, token_hash TEXT, names INTEGER NOT NULL, revision INTEGER NOT NULL, updated_at INTEGER);`);
    for (const row of db.query<{ id: string }, []>("SELECT id FROM occurrences_v1 WHERE state IN ('submitted','running')").all()) this.#resubmit.add(row.id);
  }
  now(): number { return this.#now(); }

  // ---------------------------------------------------------------- persistence
  routine(routineId: string): Routine | null { const row = this.journal.db.query<Row, [string]>("SELECT json FROM routines_v1 WHERE id=?").get(routineId); return row ? JSON.parse(row.json) as Routine : null; }
  #routines(state?: Routine["state"]): Routine[] { return (state ? this.journal.db.query<Row, [string]>("SELECT json FROM routines_v1 WHERE state=? ORDER BY rowid").all(state) : this.journal.db.query<Row, []>("SELECT json FROM routines_v1 ORDER BY rowid").all()).map(row => JSON.parse(row.json) as Routine); }
  #saveRoutine(routine: Routine): void { routine.updatedAt = Math.max(routine.updatedAt, this.now()); this.journal.db.query("INSERT INTO routines_v1 VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state, json=excluded.json").run(routine.id, routine.owner.ownerId, routine.state, canonical(routine)); }
  occurrences(routineId: string, states?: readonly RoutineOccurrence["state"][]): RoutineOccurrence[] {
    const rows = this.journal.db.query<Row, [string]>("SELECT json FROM occurrences_v1 WHERE routine_id=? ORDER BY seq").all(routineId).map(row => JSON.parse(row.json) as RoutineOccurrence);
    return states ? rows.filter(row => states.includes(row.state)) : rows;
  }
  #saveOccurrence(occurrence: RoutineOccurrence): void { this.journal.db.query("INSERT INTO occurrences_v1 VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state, json=excluded.json").run(occurrence.id, occurrence.routineId, occurrence.seq, occurrence.state, canonical(occurrence)); }
  sources(routineId: string): RoutineSource[] { return this.journal.db.query<Row, [string]>("SELECT json FROM sources_v1 WHERE routine_id=? ORDER BY rowid").all(routineId).map(row => JSON.parse(row.json) as RoutineSource); }
  #source(sourceId: string): RoutineSource | null { const row = this.journal.db.query<Row, [string]>("SELECT json FROM sources_v1 WHERE id=?").get(sourceId); return row ? JSON.parse(row.json) as RoutineSource : null; }
  #saveSource(source: RoutineSource): void { this.journal.db.query("INSERT INTO sources_v1 VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state, json=excluded.json").run(source.id, source.routineId, source.state, canonical(source)); }

  // ---------------------------------------------------------------- owner reads
  #owned(actor: Actor, routineId: unknown): Routine {
    const owner = this.options.principal(actor), routine = this.routine(id(routineId, "not_found"));
    if (!routine || routine.owner.ownerId !== owner.ownerId || routine.owner.generation !== owner.generation) bad("routine_not_found", 404);
    return routine!;
  }
  /** Live review-sheet choices from current standing policy; reading changes nothing. */
  choices(actor: Actor): RoutineOptions {
    this.options.principal(actor);
    const catalog = this.options.catalog(actor), limits = { maxRuns: routineLimits.maxRuns, maxDays: routineLimits.maxDays, intervalMinutes: { ...scheduleLimits.intervalMinutes }, nameBytes: routineLimits.nameBytes, instructionBytes: routineLimits.instructionBytes };
    if (!catalog) return { contract: "s16-routine-options/v1", available: false, code: "policy_required", policyRevision: null, policyExpiresAt: null, purposes: [], resources: [], defaults: null, limits };
    return { contract: "s16-routine-options/v1", available: !!catalog.purposes.length && !!catalog.resources.length, code: catalog.purposes.length && catalog.resources.length ? null : "policy_match_required", policyRevision: catalog.policyRevision, policyExpiresAt: catalog.policyExpiresAt, purposes: structuredClone(catalog.purposes), resources: structuredClone(catalog.resources), defaults: catalog.defaults ? structuredClone(catalog.defaults) : null, limits };
  }
  /**
   * Validates a draft against current standing policy and computes the review sheet: next three instants
   * with DST interpretation, effective scope and the hash a save must present. Nothing is stored.
   */
  propose(actor: Actor, raw: unknown): RoutineProposal {
    const owner = this.options.principal(actor), catalog = this.options.catalog(actor);
    if (!catalog) bad("policy_required", 409);
    keys(raw, ["contract", "conversationId", "name", "instruction", "schedule", "timezone", "misfire", "quiet", "limits", "scope"]);
    const draft = raw as unknown as RoutineDraft, now = this.now();
    if (draft.contract !== "s16-routine-draft/v1") bad("invalid_routine_command");
    id(draft.conversationId); text(draft.name, routineLimits.nameBytes, "invalid_routine_name", false); text(draft.instruction, routineLimits.instructionBytes, "invalid_routine_instruction", true);
    if (draft.schedule !== null) validateRecurrence(draft.schedule, draft.timezone); else validateRecurrence({ kind: "daily", time: "00:00" }, draft.timezone);
    if (!["coalesce", "skip"].includes(draft.misfire) || typeof draft.quiet !== "boolean") bad("invalid_routine_command");
    keys(draft.limits, ["maxRuns", "endsAt"]); nat(draft.limits.maxRuns); nat(draft.limits.endsAt);
    if (draft.limits.maxRuns < 1 || draft.limits.maxRuns > routineLimits.maxRuns) bad("invalid_routine_limits");
    if (draft.limits.endsAt <= now || draft.limits.endsAt > now + routineLimits.maxDays * 86400000) bad("invalid_routine_limits");
    if (draft.limits.endsAt > catalog!.policyExpiresAt) bad("routine_outlives_policy", 409);
    keys(draft.scope, ["purposeId", "resourceIds", "access"]); id(draft.scope.purposeId);
    if (!Array.isArray(draft.scope.resourceIds) || !draft.scope.resourceIds.length || draft.scope.resourceIds.length > 16 || new Set(draft.scope.resourceIds).size !== draft.scope.resourceIds.length) bad("invalid_routine_scope");
    draft.scope.resourceIds.forEach(value => id(value, "invalid_routine_scope"));
    if (!accessLevels.includes(draft.scope.access)) bad("invalid_routine_scope");
    const purpose = catalog!.purposes.find(entry => entry.id === draft.scope.purposeId), resources = draft.scope.resourceIds.map(resource => catalog!.resources.find(entry => entry.id === resource));
    if (!purpose || resources.some(entry => !entry)) bad("outside_scope", 403);
    const next = draft.schedule ? upcoming(draft.schedule, draft.timezone, now, now, 3, draft.limits.endsAt) : [];
    if (draft.schedule && !next.length) bad("routine_never_runs", 409);
    const clean = safe(() => JSON.parse(canonical(draft))) as RoutineDraft;
    return { contract: "s16-routine-proposal/v1", draft: clean, ownerGeneration: owner.generation, policyRevision: catalog!.policyRevision, next,
      effective: { purpose: structuredClone(purpose!), resources: structuredClone(resources as NonNullable<(typeof resources)[number]>[]), access: draft.scope.access, reactions: { signed: draft.scope.access === "read", github: draft.scope.access === "read", artifacts: !!this.options.files && draft.scope.access !== "effect" } },
      proposalHash: digest("s16.routine.proposal.v1", { draft: clean, ownerGeneration: owner.generation, policyRevision: catalog!.policyRevision }) };
  }
  /** Bounded owner list, newest first. Reading never ticks, dispatches or notifies. */
  list(actor: Actor): RoutineList {
    const owner = this.options.principal(actor);
    const routines = this.#routines().filter(routine => routine.owner.ownerId === owner.ownerId && routine.owner.generation === owner.generation).reverse().slice(0, 64);
    const summaries = routines.map(routine => this.#summary(routine));
    return { contract: "s16-client-routines/v1", routines: summaries, attention: summaries.reduce((sum, row) => sum + row.routine.attention, 0), feed: this.#feedView(owner.ownerId) };
  }
  detail(actor: Actor, routineId: unknown): RoutineDetail {
    const routine = this.#owned(actor, routineId), summary = this.#summary(routine);
    const next = routine.state === "active" && routine.draft.schedule && summary.remainingRuns > 0 ? upcoming(routine.draft.schedule, routine.draft.timezone, routine.anchor, routine.cursor, Math.min(3, summary.remainingRuns), routine.draft.limits.endsAt) : [];
    return { contract: "s16-client-routine/v1", summary, next, occurrences: this.occurrences(routine.id).reverse().slice(0, routineLimits.history), sources: this.sources(routine.id).map(source => this.#sourceView(source)) };
  }
  #summary(routine: Routine): RoutineSummary {
    const rows = this.occurrences(routine.id), pending = rows.some(row => row.state === "pending"), last = rows.filter(row => row.state !== "pending").at(-1) ?? null;
    const remainingRuns = Math.max(0, routine.draft.limits.maxRuns - routine.runsUsed - (pending ? 1 : 0));
    const next = routine.state === "active" && routine.draft.schedule && remainingRuns > 0 ? nextInstant(routine.draft.schedule, routine.draft.timezone, routine.anchor, routine.cursor) : null;
    const holding = rows.find(row => row.state === "waiting_review" || row.state === "unknown" && !row.acknowledged || row.state === "needs_you" && !row.acknowledged);
    const display: RoutineSummary["display"] = routine.state === "stopped" ? "stopped" : routine.state === "ended" ? "ended" : routine.state === "paused" ? "paused"
      : holding ? "waiting_for_you" : rows.some(row => blocking.has(row.state)) ? "running" : last?.state === "refused" ? "blocked" : "active";
    return { routine: structuredClone(routine), display, next: next && next.at < routine.draft.limits.endsAt ? next : null, remainingRuns, last, sources: this.sources(routine.id).filter(source => source.state === "active").length };
  }
  #sourceView(source: RoutineSource): RoutineSourceView { return { ...structuredClone(source), path: source.kind === "artifact" || source.state !== "active" ? null : `/hooks/s16/routines/${source.id}` }; }

  // ---------------------------------------------------------------- owner commands
  /** Exact owner command: Web session only, revisioned, idempotent by request ID and replay-safe for secrets. */
  command(actor: Actor, raw: unknown): RoutineReceipt {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) bad("invalid_routine_command");
    const kind = (raw as { kind?: unknown }).kind, requestId = id((raw as { requestId?: unknown }).requestId);
    const owner = this.options.principal(actor);
    let minted: { secret: string | null; url: string | null } = { secret: null, url: null };
    const hash = safe(() => digest("s16.routine.command.v1", { owner, raw }));
    const receipt = safe(() => this.journal.tx(() => this.journal.once(`cmd_${digest("s16.routine.command.id.v1", requestId).slice(0, 48)}`, hash, () => {
      const result = this.#execute(actor, owner, String(kind), raw as Record<string, unknown>);
      minted = { secret: result.secret, url: result.url };
      return { ...result, secret: null, url: null } satisfies RoutineReceipt;
    })));
    return { ...receipt, secret: minted.secret, url: minted.url };
  }
  #execute(actor: Actor, owner: { ownerId: string; generation: number }, kind: string, raw: Record<string, unknown>): RoutineReceipt {
    const now = this.now(), receipt = (routine: Routine | null, extra: Partial<RoutineReceipt> = {}): RoutineReceipt => ({ contract: "s16-routine-receipt/v1", routine: routine ? structuredClone(routine) : null, source: null, secret: null, feed: null, url: null, ...extra });
    if (kind === "routine.confirm") {
      keys(raw, ["kind", "requestId", "draft", "proposalHash"]);
      const proposal = this.propose(actor, raw.draft);
      if (proposal.proposalHash !== raw.proposalHash) bad("stale_proposal", 409);
      if (this.#routines().filter(row => row.owner.ownerId === owner.ownerId && (row.state === "active" || row.state === "paused")).length >= routineLimits.routines) bad("routine_capacity", 409);
      const routine: Routine = { contract: "s16-routine/v1", id: uid("rt"), revision: 1, owner: { ...owner }, draft: proposal.draft, proposalHash: proposal.proposalHash, policyRevision: proposal.policyRevision,
        state: "active", endedReason: null, anchor: now, cursor: now, runsUsed: 0, skipped: 0, attention: 0, createdAt: now, updatedAt: now, pausedAt: null };
      this.#saveRoutine(routine); return receipt(routine);
    }
    if (kind.startsWith("feed.")) return this.#feedCommand(owner, kind, raw);
    const shape: Record<string, string[]> = { "routine.pause": [], "routine.resume": [], "routine.stop": [], "routine.run_now": [], "routine.seen": [], "routine.acknowledge": ["occurrenceId"], "routine.source.create": ["source"], "routine.source.rotate": ["sourceId"], "routine.source.revoke": ["sourceId"] };
    if (!shape[kind]) bad("invalid_routine_command");
    keys(raw, ["kind", "requestId", "routineId", "expectedRevision", ...shape[kind]!]);
    const routine = this.#owned(actor, raw.routineId);
    if (nat(raw.expectedRevision) !== routine.revision) bad("stale_revision", 409);
    const bump = () => { routine.revision++; this.#saveRoutine(routine); };
    const live = () => { if (routine.state === "stopped" || routine.state === "ended") bad("routine_not_active", 409); };
    switch (kind) {
      case "routine.pause": {
        if (routine.state !== "active") bad("routine_not_active", 409);
        routine.state = "paused"; routine.pausedAt = now; this.#drop(routine, "paused"); bump(); return receipt(routine);
      }
      case "routine.resume": {
        if (routine.state !== "paused") bad("routine_not_paused", 409);
        // Missed instants while paused are counted, never replayed; scope and budget are not renewed.
        if (routine.draft.schedule) { const due = dueInstants(routine.draft.schedule, routine.draft.timezone, routine.anchor, routine.cursor, now); if (due) routine.skipped += due.count; }
        routine.cursor = Math.max(routine.cursor, now); routine.state = "active"; routine.pausedAt = null; bump(); this.#end(routine); return receipt(routine);
      }
      case "routine.stop": {
        live();
        routine.state = "stopped"; this.#drop(routine, "stopped");
        for (const occurrence of this.occurrences(routine.id, ["dispatching", "submitted", "running", "waiting_review"])) if (occurrence.requestId) {
          try { this.options.conversation.stop(actor, occurrence.requestId); } catch { /* Not submitted yet or already terminal. */ }
          // A claimed but unrecorded submit is fenced here; it is never resubmitted for a stopped routine.
          if (occurrence.state === "dispatching") { occurrence.state = "stopped"; occurrence.code = "aborted"; occurrence.settledAt = now; this.#saveOccurrence(occurrence); }
        }
        for (const source of this.sources(routine.id)) if (source.state === "active") { source.state = "revoked"; source.revokedAt = now; this.#saveSource(source); }
        bump(); return receipt(routine);
      }
      case "routine.run_now": {
        if (routine.state !== "active") bad("routine_not_active", 409);
        if (!this.#enqueue(routine, { kind: "run_now", key: `run_now:${String(raw.requestId)}`, sourceId: null, at: now }, { dueAt: now, local: null, resolution: null, coalesced: 0, input: null })) bad("routine_budget_exhausted", 409);
        bump(); return receipt(routine);
      }
      case "routine.seen": {
        // Attention is display state, not configuration: clearing it does not invalidate other owner views.
        routine.attention = 0; this.#saveRoutine(routine); return receipt(routine);
      }
      case "routine.acknowledge": {
        const occurrence = this.occurrences(routine.id).find(row => row.id === raw.occurrenceId);
        if (!occurrence || !["unknown", "needs_you"].includes(occurrence.state) || occurrence.acknowledged) bad("occurrence_not_waiting", 409);
        // An owner statement that they handled it; it never certifies the effect outcome.
        occurrence!.acknowledged = true; this.#saveOccurrence(occurrence!); bump(); return receipt(routine);
      }
      case "routine.source.create": {
        live(); return this.#createSource(actor, routine, raw.source, bump, receipt);
      }
      case "routine.source.rotate": case "routine.source.revoke": {
        const source = this.#source(id(raw.sourceId));
        if (!source || source.routineId !== routine.id || source.state !== "active") bad("source_not_found", 404);
        if (kind === "routine.source.revoke") { source!.state = "revoked"; source!.revokedAt = now; this.#saveSource(source!); bump(); return receipt(routine, { source: this.#sourceView(source!) }); }
        if (source!.kind === "artifact") bad("source_not_signed", 409);
        source!.revision++; source!.rotatedAt = now; this.#saveSource(source!); bump();
        return receipt(routine, { source: this.#sourceView(source!), secret: this.#secret(source!) });
      }
    }
    return bad("invalid_routine_command");
  }
  #createSource(actor: Actor, routine: Routine, raw: unknown, bump: () => void, receipt: (routine: Routine | null, extra?: Partial<RoutineReceipt>) => RoutineReceipt): RoutineReceipt {
    if (this.sources(routine.id).filter(source => source.state === "active").length >= routineLimits.sources) bad("source_capacity", 409);
    keys(raw, ["kind"], ["repository", "events", "artifactId"]);
    const now = this.now(), base = { contract: "s16-routine-source/v1" as const, id: uid("rs"), routineId: routine.id, revision: 1, state: "active" as const, createdAt: now, rotatedAt: null, revokedAt: null, stats: { accepted: 0, coalesced: 0, duplicates: 0, ignored: 0, refused: 0, lastAt: null, lastOutcome: null } };
    let source: RoutineSource;
    if (raw.kind === "github" || raw.kind === "signed") {
      // FR-08: a monitor/review/signed event is a wake-up for reporting work; it never starts implementation.
      if (routine.draft.scope.access !== "read") bad("reaction_requires_read_scope", 409);
      const events = Array.isArray(raw.events) ? raw.events : bad("invalid_routine_source");
      if (!events.length || events.length > 8 || new Set(events).size !== events.length) bad("invalid_routine_source");
      if (raw.kind === "github") {
        keys(raw, ["kind", "repository", "events"]);
        if (typeof raw.repository !== "string" || !REPOSITORY.test(raw.repository) || events.some(event => !(githubEvents as readonly unknown[]).includes(event))) bad("invalid_routine_source");
        source = { ...base, kind: "github", repository: (raw.repository as string).toLowerCase(), events: [...events].sort() as string[], artifact: null };
      } else {
        keys(raw, ["kind", "events"]);
        if (events.some(event => typeof event !== "string" || !EVENT.test(event))) bad("invalid_routine_source");
        source = { ...base, kind: "signed", repository: null, events: [...events].sort() as string[], artifact: null };
      }
      this.#key(true); this.#saveSource(source); bump();
      return receipt(routine, { source: this.#sourceView(source), secret: this.#secret(source) });
    }
    if (raw.kind !== "artifact") bad("invalid_routine_source");
    keys(raw, ["kind", "artifactId"]);
    if (!this.options.files) bad("artifact_unavailable", 503);
    if (routine.draft.scope.access === "effect") bad("reaction_requires_bounded_scope", 409);
    const committed = this.options.files!.committed(actor), root = committed.find(item => item.artifact.id === raw.artifactId);
    // The watch names one exact committed lineage in this routine's own conversation, never a path or name.
    if (!root || root.artifact.conversationId !== routine.draft.conversationId) bad("artifact_unavailable", 409);
    const rootId = this.#root(committed, root!.artifact.id);
    source = { ...base, kind: "artifact", repository: null, events: ["revision"], artifact: { rootId, lastSeen: this.#newest(committed, rootId, routine)?.artifact.id ?? null } };
    this.#saveSource(source); bump(); return receipt(routine, { source: this.#sourceView(source) });
  }
  /** Drop an undispatched coalescing slot; it consumed no budget and created no work. */
  #drop(routine: Routine, code: string): void {
    for (const occurrence of this.occurrences(routine.id, ["pending"])) { occurrence.state = "dropped"; occurrence.code = code; occurrence.settledAt = this.now(); this.#saveOccurrence(occurrence); }
  }
  /**
   * Merge a trigger into the single pending slot, or open it. Budget is consumed only at dispatch. Returns
   * false when the finite run budget has no room for another occurrence.
   */
  #enqueue(routine: Routine, trigger: RoutineTrigger, fields: Pick<RoutineOccurrence, "dueAt" | "local" | "resolution" | "coalesced" | "input">): RoutineOccurrence | null {
    const rows = this.occurrences(routine.id), pending = rows.find(row => row.state === "pending");
    if (pending) {
      pending.coalesced += 1 + fields.coalesced; pending.dueAt = Math.max(pending.dueAt, fields.dueAt);
      if (fields.local) { pending.local = fields.local; pending.resolution = fields.resolution; }
      if (fields.input) { pending.input = structuredClone(fields.input); pending.trigger = "file"; }
      if (pending.triggers.length < routineLimits.triggers) pending.triggers.push(trigger);
      this.#saveOccurrence(pending); return pending;
    }
    if (routine.runsUsed >= routine.draft.limits.maxRuns || this.now() >= routine.draft.limits.endsAt) return null;
    const occurrence: RoutineOccurrence = { contract: "s16-routine-occurrence/v1", id: uid("oc"), routineId: routine.id, seq: (rows.at(-1)?.seq ?? 0) + 1, trigger: trigger.kind, ...structuredClone(fields), triggers: [trigger],
      state: "pending", code: null, requestId: null, committedAt: this.now(), dispatchedAt: null, settledAt: null, acknowledged: false, notified: false };
    this.#saveOccurrence(occurrence);
    // Bound the journal without limiting admission: only the oldest rows that consumed no run are discarded.
    this.journal.db.query(`DELETE FROM occurrences_v1 WHERE routine_id=? AND state IN ('refused','dropped') AND id NOT IN (SELECT id FROM occurrences_v1 WHERE routine_id=? ORDER BY seq DESC LIMIT ?)`).run(routine.id, routine.id, routineLimits.history);
    return occurrence;
  }
  /** Terminal transitions that need no owner input: exhausted budget, end date, consumed one-time schedule. */
  #end(routine: Routine): void {
    if (routine.state !== "active") return;
    // Outstanding work keeps the routine active (and stoppable) until it settles; nothing new is admitted meanwhile.
    const rows = this.occurrences(routine.id), pending = rows.some(row => row.state === "pending"), busy = rows.some(row => blocking.has(row.state) || row.state === "unknown" && !row.acknowledged);
    let reason: Routine["endedReason"] = null;
    if (this.now() >= routine.draft.limits.endsAt) { this.#drop(routine, "expired"); if (!busy) reason = "expired"; }
    else if (routine.runsUsed >= routine.draft.limits.maxRuns && !pending && !busy) reason = "exhausted";
    else if (routine.draft.schedule?.kind === "once" && !nextInstant(routine.draft.schedule, routine.draft.timezone, routine.anchor, routine.cursor) && !pending && !busy && !this.sources(routine.id).some(source => source.state === "active")) reason = "completed";
    if (!reason) return;
    routine.state = "ended"; routine.endedReason = reason; routine.revision++;
    for (const source of this.sources(routine.id)) if (source.state === "active") { source.state = "revoked"; source.revokedAt = this.now(); this.#saveSource(source); }
    this.#saveRoutine(routine);
  }

  // ---------------------------------------------------------------- scheduler
  /** Commit due schedule instants and new artifact revisions. Durable identity is written before any dispatch. */
  tick(): void {
    const now = this.now();
    for (const routine of this.#routines("active")) safe(() => this.journal.tx(() => {
      const current = this.routine(routine.id)!; if (current.state !== "active") return;
      this.#end(current); if (current.state !== "active") return;
      const schedule = current.draft.schedule;
      if (schedule) {
        const due = dueInstants(schedule, current.draft.timezone, current.anchor, current.cursor, now);
        if (due) {
          current.cursor = due.last.at;
          const late = now - due.last.at > routineLimits.skipGraceMs;
          if (current.draft.misfire === "skip" && late) current.skipped += due.count;
          else {
            if (current.draft.misfire === "skip") current.skipped += due.count - 1;
            const coalesced = current.draft.misfire === "coalesce" ? due.count - 1 : 0;
            if (!this.#enqueue(current, { kind: "schedule", key: `schedule:${due.last.at}`, sourceId: null, at: now }, { dueAt: due.last.at, local: due.last.local, resolution: due.last.resolution, coalesced, input: null })) current.skipped += due.count;
          }
          this.#saveRoutine(current);
        }
      }
      this.#end(current);
    }));
    this.#watchArtifacts();
  }
  #root(committed: { artifact: { id: string }; parents: string[] }[], start: string): string {
    const byId = new Map(committed.map(item => [item.artifact.id, item]));
    let current = start;
    for (let depth = 0; depth < 64; depth++) { const parent = byId.get(current)?.parents[0]; if (!parent || !byId.has(parent)) return current; current = parent; }
    return current;
  }
  #newest(committed: { artifact: FileArtifact; parents: string[] }[], rootId: string, routine: Routine): { artifact: FileArtifact; parents: string[] } | null {
    const own = new Set(this.occurrences(routine.id).flatMap(row => row.requestId ? [row.requestId] : []));
    const byId = new Map(committed.map(item => [item.artifact.id, item])), depth = (start: string) => { let n = 0; for (let id: string | undefined = start; id && byId.has(id) && n < 64; id = byId.get(id)!.parents[0]) n++; return n; };
    // The latest revision is the deepest descendant; a revision this routine produced itself never wakes it again.
    return committed.filter(item => item.artifact.conversationId === routine.draft.conversationId && !own.has(item.artifact.requestId) && this.#root(committed, item.artifact.id) === rootId)
      .sort((a, b) => depth(b.artifact.id) - depth(a.artifact.id) || b.artifact.createdAt - a.artifact.createdAt || (a.artifact.id < b.artifact.id ? 1 : -1))[0] ?? null;
  }
  #watchArtifacts(): void {
    if (!this.options.files) return;
    const watched = this.journal.db.query<Row, []>("SELECT json FROM sources_v1 WHERE state='active' AND json_extract(json,'$.kind')='artifact'").all().map(row => JSON.parse(row.json) as RoutineSource);
    for (const source of watched) {
      const routine = this.routine(source.routineId); if (!routine || routine.state !== "active") continue;
      const actor = this.options.owner(routine.owner); if (!actor) continue;
      let committed: ReturnType<NonNullable<RoutineServiceOptions<Actor>["files"]>["committed"]>;
      try { committed = this.options.files.committed(actor); } catch { continue; }
      const newest = this.#newest(committed, source.artifact!.rootId, routine);
      if (!newest || newest.artifact.id === source.artifact!.lastSeen) continue;
      safe(() => this.journal.tx(() => {
        const current = this.#source(source.id)!, owner = this.routine(routine.id)!;
        if (current.state !== "active" || owner.state !== "active" || current.artifact!.lastSeen === newest.artifact.id) return;
        current.artifact!.lastSeen = newest.artifact.id;
        const outcome = this.#admitEvent(owner, current, `file:${current.artifact!.rootId}:${newest.artifact.id}`, "file", { id: newest.artifact.id, sha256: newest.artifact.sha256 });
        current.stats.lastAt = this.now(); current.stats.lastOutcome = outcome; this.#saveSource(current);
      }));
    }
  }
  /** Event-key dedupe and coalescing inside the caller's transaction. */
  #admitEvent(routine: Routine, source: RoutineSource, key: string, kind: "event" | "file", input: RoutineOccurrence["input"]): "scheduled" | "coalesced" | "exhausted" {
    const now = this.now();
    this.journal.db.query("DELETE FROM event_keys_v1 WHERE first_at<=?").run(now - routineLimits.keyRetentionMs);
    const seen = this.journal.db.query<{ count: number }, [string, string]>("SELECT count FROM event_keys_v1 WHERE routine_id=? AND key=?").get(routine.id, key);
    if (seen) { this.journal.db.query("UPDATE event_keys_v1 SET count=count+1 WHERE routine_id=? AND key=?").run(routine.id, key); source.stats.coalesced++; return "coalesced"; }
    const merged = this.occurrences(routine.id, ["pending"]).length > 0;
    const occurrence = this.#enqueue(routine, { kind, key, sourceId: source.id, at: now }, { dueAt: now, local: null, resolution: null, coalesced: 0, input });
    if (!occurrence) { source.stats.refused++; return "exhausted"; }
    this.journal.db.query("INSERT INTO event_keys_v1 VALUES (?,?,?,?,?)").run(routine.id, key, now, 1, occurrence.id);
    if (merged) { source.stats.coalesced++; return "coalesced"; }
    source.stats.accepted++; return "scheduled";
  }

  /**
   * Submit each routine's next occurrence once nothing it owns is running or waiting for the owner. The
   * `dispatching` record is committed first and consumes one run; the deterministic CHAT request ID makes a
   * resubmission after restart return the original receipt instead of a second responsibility.
   */
  dispatch(): number {
    let submitted = 0;
    this.#recover();
    const candidates = this.journal.db.query<{ routine_id: string }, []>("SELECT DISTINCT routine_id FROM occurrences_v1 WHERE state IN ('pending','dispatching')").all();
    for (const { routine_id } of candidates) {
      const routine = this.routine(routine_id); if (!routine) continue;
      const rows = this.occurrences(routine.id);
      let occurrence = rows.find(row => row.state === "dispatching");
      if (occurrence && (routine.state === "stopped" || routine.state === "ended")) {
        const actor = this.options.owner(routine.owner);
        if (actor && occurrence.requestId) { try { this.options.conversation.stop(actor, occurrence.requestId); } catch { /* Never submitted. */ } }
        const fenced = occurrence;
        safe(() => this.journal.tx(() => { const current = this.occurrences(routine.id).find(row => row.id === fenced.id)!; if (current.state === "dispatching") { current.state = "stopped"; current.code = "aborted"; current.settledAt = this.now(); this.#saveOccurrence(current); } }));
        continue;
      }
      if (!occurrence) {
        if (routine.state !== "active" || rows.some(row => blocking.has(row.state) || row.state === "unknown" && !row.acknowledged)) continue;
        occurrence = rows.find(row => row.state === "pending"); if (!occurrence) continue;
      }
      const actor = this.options.owner(routine.owner);
      if (!actor) { this.#settle(routine.id, occurrence.id, "refused", "owner_changed"); continue; }
      // After the end date nothing new is submitted. A claim whose CHAT request was already saved is recovered;
      // one that never reached CHAT is refused and its run returned.
      // A claim whose CHAT request was already saved is recorded as submitted and recovered from CHAT's own
      // saved command; it never adopts its input again. After the end date an unsaved claim is refused instead.
      if (occurrence.state === "dispatching" && occurrence.requestId && this.options.conversation.saved(occurrence.requestId)) {
        const recovered = occurrence;
        safe(() => this.journal.tx(() => { const current = this.occurrences(routine.id).find(row => row.id === recovered.id)!; if (current.state === "dispatching") { current.state = "submitted"; current.code = null; this.#saveOccurrence(current); } }));
        this.#resubmit.add(recovered.id); this.#recover(); continue;
      }
      if (occurrence.state === "dispatching" && this.now() >= routine.draft.limits.endsAt) { this.#settle(routine.id, occurrence.id, "refused", "expired"); continue; }
      let files: { id: string; sha256: string }[] | null;
      try { files = this.#files(actor, routine, occurrence); }
      catch (error) { this.#settle(routine.id, occurrence.id, "refused", error instanceof AppError ? error.code : "file_unavailable"); continue; }
      const claimed = safe(() => this.journal.tx(() => {
        const current = this.occurrences(routine.id).find(row => row.id === occurrence!.id)!, owner = this.routine(routine.id)!;
        if (current.state === "dispatching") return current;
        if (current.state !== "pending" || owner.state !== "active") return null;
        if (this.now() >= owner.draft.limits.endsAt) { current.state = "dropped"; current.code = "expired"; current.settledAt = this.now(); this.#saveOccurrence(current); this.#end(owner); return null; }
        if (owner.runsUsed >= owner.draft.limits.maxRuns) { current.state = "dropped"; current.code = "routine_budget_exhausted"; current.settledAt = this.now(); this.#saveOccurrence(current); this.#end(owner); return null; }
        current.state = "dispatching"; current.dispatchedAt = this.now(); current.requestId = `ro_${current.id.slice(3)}`; this.#saveOccurrence(current);
        owner.runsUsed++; this.#saveRoutine(owner); return current;
      }));
      if (!claimed) continue;
      try { this.#submit(actor, routine, claimed, files); }
      catch (error) {
        const code = error instanceof AppError || error instanceof PolicyError ? error.code : "conversation_unavailable";
        const retry = ["conversation_unavailable", "continuity_capacity", "service_closed"].includes(code);
        safe(() => this.journal.tx(() => {
          const current = this.occurrences(routine.id).find(row => row.id === claimed.id)!, owner = this.routine(routine.id)!;
          if (current.state !== "dispatching") return;
          const attempts = (current.code?.startsWith("retry_") ? Number(current.code.slice(6)) : 0) + 1;
          if (retry && attempts < routineLimits.dispatchRetries) { current.code = `retry_${attempts}`; this.#saveOccurrence(current); return; }
          // CHAT rolled its transaction back: no request exists, so the run is returned to the budget.
          current.state = "refused"; current.code = code; current.settledAt = this.now(); this.#notify(owner, current); this.#saveOccurrence(current);
          owner.runsUsed = Math.max(0, owner.runsUsed - 1); this.#saveRoutine(owner);
        }));
        continue;
      }
      safe(() => this.journal.tx(() => { const current = this.occurrences(routine.id).find(row => row.id === claimed.id)!; if (current.state === "dispatching") { current.state = "submitted"; current.code = null; this.#saveOccurrence(current); } }));
      submitted++;
    }
    return submitted;
  }
  /** The exact original command and pin of one occurrence; resubmission must reproduce both byte for byte. */
  #submit(actor: Actor, routine: Routine, occurrence: RoutineOccurrence, files: { id: string; sha256: string }[] | null): void {
    const base = { requestId: occurrence.requestId!, conversationId: routine.draft.conversationId, text: routine.draft.instruction, continuation: null };
    const command = files ? { contract: "s16-conversation/v2", ...base, files } : { contract: "s15-conversation/v1", ...base };
    const pin: ConversationRoutinePin = { contract: "s16-routine-run/v1", routineId: routine.id, occurrenceId: occurrence.id, purposeId: routine.draft.scope.purposeId, resourceIds: [...routine.draft.scope.resourceIds], access: routine.draft.scope.access, quiet: routine.draft.quiet };
    this.options.conversation.submitRoutine(actor, command, pin);
  }
  /** Adopted input of a file occurrence; the adoption request ID is deterministic, so a repeat returns the same receipt. */
  #files(actor: Actor, routine: Routine, occurrence: RoutineOccurrence): { id: string; sha256: string }[] | null {
    if (!occurrence.input) return null;
    if (!this.options.files) throw new AppError("artifact_unavailable");
    const upload = this.options.files.adopt(actor, { requestId: `ra_${occurrence.id.slice(3)}`, conversationId: routine.draft.conversationId, artifact: { ...occurrence.input } });
    if (upload.state !== "ready" || !upload.receipt) throw new AppError(upload.code ?? "file_unavailable");
    return [{ id: upload.receipt.id, sha256: upload.receipt.sha256 }];
  }
  /** Re-register requests an earlier process submitted. A stopped routine's request is stopped instead. */
  #recover(): void {
    for (const occurrenceId of [...this.#resubmit]) {
      const row = this.journal.db.query<Row, [string]>("SELECT json FROM occurrences_v1 WHERE id=?").get(occurrenceId);
      const occurrence = row ? JSON.parse(row.json) as RoutineOccurrence : null, routine = occurrence ? this.routine(occurrence.routineId) : null;
      if (!occurrence || !routine || !occurrence.requestId || !["submitted", "running"].includes(occurrence.state)) { this.#resubmit.delete(occurrenceId); continue; }
      const actor = this.options.owner(routine.owner); if (!actor) continue;
      if (!this.options.conversation.saved(occurrence.requestId)) { this.#resubmit.delete(occurrenceId); continue; }
      try {
        if (routine.state === "stopped") this.options.conversation.stop(actor, occurrence.requestId);
        else {
          // Reproduce the exact original command from CHAT's saved file receipts; a withdrawn input is not re-adopted.
          const saved = this.options.conversation.row(actor, occurrence.requestId);
          this.#submit(actor, routine, occurrence, occurrence.input ? (saved.files?.inputs ?? []).map(file => ({ id: file.id, sha256: file.sha256 })) : null);
        }
        this.#resubmit.delete(occurrenceId);
      } catch (error) {
        const code = error instanceof AppError || error instanceof PolicyError ? error.code : "conversation_unavailable";
        if (["conversation_unavailable", "continuity_capacity", "service_closed"].includes(code)) continue;
        // CHAT refuses to re-register it: fence the saved request so observation settles it instead of waiting forever.
        try { this.options.conversation.stop(actor, occurrence.requestId); } catch { /* Already terminal. */ }
        this.#resubmit.delete(occurrenceId);
      }
    }
  }
  #notify(routine: Routine, occurrence: RoutineOccurrence): void { if (!occurrence.notified && attentionStates.has(occurrence.state)) { occurrence.notified = true; routine.attention++; } }
  #settle(routineId: string, occurrenceId: string, state: RoutineOccurrence["state"], code: string | null): void {
    safe(() => this.journal.tx(() => {
      const routine = this.routine(routineId)!, occurrence = this.occurrences(routineId).find(row => row.id === occurrenceId)!;
      if (!["pending", "dispatching"].includes(occurrence.state)) return;
      const wasDispatching = occurrence.state === "dispatching";
      occurrence.state = state; occurrence.code = code; occurrence.settledAt = this.now(); this.#notify(routine, occurrence); this.#saveOccurrence(occurrence);
      if (wasDispatching) routine.runsUsed = Math.max(0, routine.runsUsed - 1);
      this.#saveRoutine(routine); this.#end(routine);
    }));
  }
  /** Map each submitted occurrence to its CHAT owner row. Quiet means a completed typed no_update only. */
  observe(): void {
    const rows = this.journal.db.query<{ json: string }, []>(`SELECT json FROM occurrences_v1 WHERE state IN (${[...observed].map(state => `'${state}'`).join(",")}) ORDER BY rowid`).all().map(row => JSON.parse(row.json) as RoutineOccurrence);
    for (const occurrence of rows) {
      const routine = this.routine(occurrence.routineId); if (!routine || !occurrence.requestId) continue;
      const actor = this.options.owner(routine.owner); if (!actor) continue;
      let row: ConversationOwnerRow;
      try { row = this.options.conversation.row(actor, occurrence.requestId); } catch { continue; }
      const [mapped, code] = occurrenceOutcome(row);
      // A "report every result" routine treats a typed no_update as an ordinary visible result.
      const state = mapped === "quiet" && !routine.draft.quiet ? "succeeded" : mapped;
      if (state === occurrence.state && code === occurrence.code) continue;
      safe(() => this.journal.tx(() => {
        const current = this.occurrences(routine.id).find(item => item.id === occurrence.id)!, owner = this.routine(routine.id)!;
        if (!observed.has(current.state)) return;
        current.state = state; current.code = code; current.settledAt = state === "running" ? null : current.settledAt ?? this.now();
        this.#notify(owner, current); this.#saveOccurrence(current); this.#saveRoutine(owner); this.#end(owner);
      }));
    }
  }

  // ---------------------------------------------------------------- signed reaction ingress
  #key(create: boolean): Buffer {
    const path = this.options.keyPath, existing = lstatSync(path, { throwIfNoEntry: false });
    if (!existing) {
      if (!create) bad("routine_key_unavailable", 503);
      const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { writeSync(fd, randomBytes(32)); fsyncSync(fd); } finally { closeSync(fd); }
    }
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd); if (!stat.isFile() || stat.size !== 32 || stat.mode & 0o077 || stat.nlink !== 1) bad("routine_key_unavailable", 503);
      const key = Buffer.alloc(32); if (readSync(fd, key, 0, 32, 0) !== 32) bad("routine_key_unavailable", 503); return key;
    } finally { closeSync(fd); }
  }
  /** Per-source secret derived from the installation key and the source revision; nothing secret is stored. */
  #secret(source: RoutineSource): string { return "jitrt_" + hmac(this.#key(true), `s16.routine.source.v1\n${source.id}\n${source.revision}`).toString("base64url"); }
  /**
   * Verify and admit one signed delivery. Every refusal before the signature check writes nothing. A
   * payload only selects which configured event fired and its coalescing identity; it is never stored,
   * shown to a model, used as an instruction or allowed to choose purpose, resources or recipients.
   */
  async receive(sourceId: string, request: Request): Promise<{ status: number; body: Record<string, unknown>; headers?: Record<string, string> }> {
    const refuse = (status: number, error: string, headers?: Record<string, string>) => ({ status, body: { error }, ...(headers ? { headers } : {}) });
    if (request.method !== "POST") return refuse(405, "method_not_allowed");
    if (request.headers.has("origin") || request.headers.has("sec-fetch-site") || request.headers.has("cookie")) return refuse(403, "origin_rejected");
    const source = ID.test(sourceId) ? this.#source(sourceId) : null;
    if (!source || source.state !== "active" || source.kind === "artifact") return refuse(404, "not_found");
    const declared = request.headers.get("content-length");
    if (declared !== null && (!/^\d{1,9}$/.test(declared) || Number(declared) > routineLimits.hookBodyBytes)) return refuse(413, "request_too_large");
    const chunks: Uint8Array[] = []; let total = 0; const reader = request.body?.getReader();
    if (reader) { try { for (;;) { const { done, value } = await reader.read(); if (done) break; total += value.byteLength; if (total > routineLimits.hookBodyBytes) { await reader.cancel().catch(() => {}); return refuse(413, "request_too_large"); } chunks.push(value); } } finally { reader.releaseLock(); } }
    const body = Buffer.concat(chunks);
    const rate = this.#rate.admit(source.id); if (!rate.ok) return refuse(429, "rate_limited", { "Retry-After": String(rate.retryAfterSeconds) });
    let key: Buffer; try { key = this.#key(false); } catch { return refuse(401, "signature_invalid"); }
    const secret = "jitrt_" + hmac(key, `s16.routine.source.v1\n${source.id}\n${source.revision}`).toString("base64url"), now = this.now();
    const equal = (expected: Buffer, supplied: string | null) => { const value = Buffer.from(supplied && /^[a-f0-9]{64}$/.test(supplied) ? supplied : "0".repeat(64), "hex"); return timingSafeEqual(expected, value) && !!supplied && /^[a-f0-9]{64}$/.test(supplied); };
    let deliveryId: string | null, event: { name: string; key: string } | "ignored" | "pong" | "expired" | "invalid";
    if (source.kind === "github") {
      const header = request.headers.get("x-hub-signature-256"), match = header ? /^sha256=([a-f0-9]{64})$/.exec(header) : null;
      if (!equal(hmac(secret, body), match?.[1] ?? null)) return refuse(401, "signature_invalid");
      deliveryId = request.headers.get("x-github-delivery");
      event = githubEvent(request.headers.get("x-github-event"), body, source, now);
    } else {
      const header = request.headers.get("x-jit-signature") ?? "", match = /^t=(\d{1,12}),v1=([a-f0-9]{64})$/.exec(header);
      const stamp = match ? Number(match[1]) * 1000 : 0;
      deliveryId = request.headers.get("x-jit-delivery");
      const name = request.headers.get("x-jit-event") ?? "", supplied = request.headers.get("x-jit-key");
      // The signature covers the timestamp and every identity header, so a captured delivery cannot be replayed under new IDs.
      if (!equal(hmac(secret, Buffer.concat([Buffer.from(signedPrefix(match?.[1] ?? "0", deliveryId ?? "", name, supplied ?? "")), body])), match?.[2] ?? null)) return refuse(401, "signature_invalid");
      if (Math.abs(now - stamp) > routineLimits.signedSkewMs) return refuse(401, "event_expired");
      event = !EVENT.test(name) || supplied !== null && !DELIVERY.test(supplied) ? "invalid" : source.events.includes(name) ? { name, key: `event:${name}:${supplied ?? deliveryId ?? ""}` } : "ignored";
    }
    if (!deliveryId || !DELIVERY.test(deliveryId)) return refuse(400, "delivery_id_required");
    if (event === "invalid") return refuse(400, "invalid_event");
    try {
      return safe(() => this.journal.tx(() => {
        const current = this.#source(source.id)!, routine = this.routine(current.routineId)!;
        if (current.state !== "active" || current.revision !== source.revision) return refuse(401, "signature_invalid");
        const stat = (outcome: string, field: keyof RoutineSource["stats"] | null) => { if (field) (current.stats[field] as number)++; current.stats.lastAt = now; current.stats.lastOutcome = outcome; this.#saveSource(current); };
        this.journal.db.query("DELETE FROM deliveries_v1 WHERE received_at<=?").run(now - routineLimits.deliveryRetentionMs);
        if (this.journal.db.query("SELECT 1 FROM deliveries_v1 WHERE source_id=? AND delivery_id=?").get(current.id, deliveryId!)) { stat("duplicate", "duplicates"); return { status: 202, body: { outcome: "duplicate" } }; }
        this.journal.db.query("INSERT INTO deliveries_v1 VALUES (?,?,?)").run(current.id, deliveryId!, now);
        if (event === "pong") { stat("pong", null); return { status: 202, body: { outcome: "pong" } }; }
        if (event === "expired") { stat("event_expired", "refused"); return { status: 409, body: { error: "event_expired" } }; }
        if (event === "ignored") { stat("ignored", "ignored"); return { status: 202, body: { outcome: "ignored" } }; }
        if (routine.state !== "active") { stat(routine.state === "paused" ? "routine_paused" : "routine_not_active", "refused"); return { status: 409, body: { error: routine.state === "paused" ? "routine_paused" : "routine_not_active" } }; }
        const outcome = this.#admitEvent(routine, current, (event as { key: string }).key, "event", null);
        current.stats.lastAt = now; current.stats.lastOutcome = outcome; this.#saveSource(current);
        return outcome === "exhausted" ? { status: 409, body: { error: "routine_budget_exhausted" } } : { status: 202, body: { outcome } };
      }));
    } catch (error) { return refuse(error instanceof AppError && error.status === 503 ? 503 : 409, error instanceof AppError ? error.code : "routine_unavailable"); }
  }

  // ---------------------------------------------------------------- read-only calendar feed (FR-34)
  #feedRow(): { owner_id: string | null; token_hash: string | null; names: number; revision: number; updated_at: number | null } | null {
    return this.journal.db.query<{ owner_id: string | null; token_hash: string | null; names: number; revision: number; updated_at: number | null }, []>("SELECT owner_id, token_hash, names, revision, updated_at FROM feed_v1 WHERE id=1").get();
  }
  #feedView(ownerId: string): RoutineFeedView {
    const row = this.#feedRow(), mine = !!row && (row.owner_id === null || row.owner_id === ownerId);
    return { contract: "s16-routine-feed/v1", enabled: mine && !!row?.token_hash, names: mine && !!row?.names, revision: row?.revision ?? 0, updatedAt: row?.updated_at ?? null };
  }
  #feedCommand(owner: { ownerId: string }, kind: string, raw: Record<string, unknown>): RoutineReceipt {
    keys(raw, ["kind", "requestId", "expectedRevision", ...(kind === "feed.names" ? ["names"] : [])]);
    const row = this.#feedRow(), revision = row?.revision ?? 0, now = this.now();
    if (nat(raw.expectedRevision) !== revision) bad("stale_revision", 409);
    let token: string | null = null, hash = row?.token_hash ?? null, names = !!row?.names;
    if (kind === "feed.enable") { if (hash) bad("feed_already_enabled", 409); token = randomBytes(32).toString("base64url"); }
    else if (kind === "feed.rotate") { if (!hash) bad("feed_not_enabled", 409); token = randomBytes(32).toString("base64url"); }
    else if (kind === "feed.disable") { if (!hash) bad("feed_not_enabled", 409); hash = null; }
    else if (kind === "feed.names") { if (typeof raw.names !== "boolean") bad("invalid_routine_command"); names = raw.names as boolean; }
    else bad("invalid_routine_command");
    if (token) hash = createHash("sha256").update(token).digest("hex");
    this.journal.db.query("INSERT INTO feed_v1 VALUES (1,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET owner_id=excluded.owner_id, token_hash=excluded.token_hash, names=excluded.names, revision=excluded.revision, updated_at=excluded.updated_at").run(owner.ownerId, hash, names ? 1 : 0, revision + 1, now);
    return { contract: "s16-routine-receipt/v1", routine: null, source: null, secret: null, feed: this.#feedView(owner.ownerId), url: token ? `${this.options.origin}/feeds/s16/routines/${token}.ics` : null };
  }
  /**
   * Read-only calendar for a presented token, or null. A malformed, wrong, rotated or disabled token takes the
   * same comparison path. The feed writes nothing and starts nothing; instructions never appear in it.
   */
  feed(token: string): string | null {
    const row = this.#feedRow(), presented = createHash("sha256").update(/^[A-Za-z0-9_-]{43}$/.test(token) ? token : "").digest();
    const stored = Buffer.from(row?.token_hash ?? "0".repeat(64), "hex");
    if (!timingSafeEqual(presented, stored) || !row?.token_hash || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const now = this.now(), until = now + routineLimits.feedHorizonMs, events: { at: number; routine: Routine }[] = [];
    for (const routine of this.#routines("active")) {
      if (routine.owner.ownerId !== row.owner_id || !routine.draft.schedule) continue;
      const pending = this.occurrences(routine.id, ["pending"]).length, remaining = Math.max(0, routine.draft.limits.maxRuns - routine.runsUsed - pending);
      for (const instant of upcoming(routine.draft.schedule, routine.draft.timezone, routine.anchor, Math.max(routine.cursor, now), Math.min(remaining, routineLimits.feedEvents), Math.min(until, routine.draft.limits.endsAt - 1))) events.push({ at: instant.at, routine });
    }
    events.sort((a, b) => a.at - b.at || (a.routine.id < b.routine.id ? -1 : 1));
    const stamp = (at: number) => new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "");
    const label = this.options.feedLabel ?? "Jit routine";
    const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Jit//s16-routine-feed/v1//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", `X-WR-CALNAME:${escapeIcsText(label)}`, "REFRESH-INTERVAL;VALUE=DURATION:PT1H", "X-PUBLISHED-TTL:PT1H"];
    for (const { at, routine } of events.slice(0, routineLimits.feedEvents)) lines.push("BEGIN:VEVENT", `UID:${routine.id}-${routine.revision}-${at}@jit`, `DTSTAMP:${stamp(routine.updatedAt)}`, `DTSTART:${stamp(at)}`, `SUMMARY:${escapeIcsText(row.names ? routine.draft.name : label)}`, "TRANSP:TRANSPARENT", "END:VEVENT");
    lines.push("END:VCALENDAR");
    return lines.map(foldIcsLine).join("\r\n") + "\r\n";
  }
  close(): void { this.journal.close(); }
}

/**
 * Exact signed prefix of the `signed` source format: `t`, delivery ID, event name and optional coalescing key,
 * each on its own line, followed by the raw body bytes. HMAC-SHA256 with the source secret signs the whole.
 */
export const signedPrefix = (stamp: string, delivery: string, event: string, key: string) => `s16-routine-event/v1\n${stamp}\n${delivery}\n${event}\n${key}\n`;

/** CHAT owner row → occurrence state. Only CHAT's committed facts decide; a model reply alone never does. */
export function occurrenceOutcome(row: ConversationOwnerRow): [RoutineOccurrence["state"], string | null] {
  // Only a pending exact slip is a review wait; a slip-less hold is an ordinary needs-you outcome.
  if (row.needsYou?.kind === "action" && row.needsYou.slip) return ["waiting_review", row.needsYou.code];
  if (row.needsYou?.kind === "reconciliation" || row.state === "unknown") return ["unknown", row.needsYou?.code ?? "context_lost"];
  switch (row.state) {
    case "received": return ["failed", "not_executed"];
    case "understanding": case "inspecting": case "working": return ["running", null];
    case "question": case "needs_you": case "budget_hold": case "unsupported": case "partial": return ["needs_you", row.needsYou?.code ?? row.state];
    case "blocked": return ["failed", "result_unavailable"];
    case "stopped": return ["stopped", "aborted"];
    case "denied": return ["denied", null];
    case "done": {
      if (row.slips.some(slip => ["failed", "expired", "denied", "changed", "unsupported", "stale_rules"].includes(slip.state))) return ["failed", row.slips.find(slip => slip.state !== "succeeded")?.state ?? "action_failed"];
      return [row.result && normalizeSummaryOutcome(row.result.text).kind === "no_update" ? "quiet" : "succeeded", null];
    }
  }
  return ["running", null];
}

/** GitHub delivery → configured event identity. Only validated identity fields are read; the rest is discarded. */
function githubEvent(name: string | null, body: Buffer, source: RoutineSource, now: number): { name: string; key: string } | "ignored" | "pong" | "expired" | "invalid" {
  if (name === "ping") return "pong";
  if (!name || !/^[a-z_]{1,64}$/.test(name)) return "invalid";
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as Record<string, unknown>; } catch { return "invalid"; }
  if (!payload || typeof payload !== "object") return "invalid";
  const object = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const repository = object(payload.repository)?.full_name;
  if (typeof repository !== "string" || !REPOSITORY.test(repository)) return "invalid";
  if (repository.toLowerCase() !== source.repository) return "ignored";
  const fresh = (value: unknown) => { const at = typeof value === "string" ? Date.parse(value) : NaN; return Number.isFinite(at) && now - at <= routineLimits.githubFreshnessMs && at - now <= routineLimits.signedSkewMs; };
  if ((name === "check_suite" || name === "workflow_run") && payload.action === "completed") {
    if (!source.events.includes("ci_completed")) return "ignored";
    const suite = object(payload[name]), sha = suite?.head_sha;
    if (typeof sha !== "string" || !/^[a-f0-9]{40}$/.test(sha)) return "invalid";
    if (!fresh(suite!.updated_at)) return "expired";
    return { name: "ci_completed", key: `ci:${repository.toLowerCase()}:${sha}` };
  }
  if (name === "pull_request_review" && payload.action === "submitted") {
    if (!source.events.includes("review_submitted")) return "ignored";
    const review = object(payload.review), pull = object(payload.pull_request);
    if (typeof review?.id !== "number" || !Number.isSafeInteger(review.id) || typeof pull?.number !== "number" || !Number.isSafeInteger(pull.number)) return "invalid";
    if (!fresh(review.submitted_at)) return "expired";
    return { name: "review_submitted", key: `review:${repository.toLowerCase()}:${pull.number}:${review.id}` };
  }
  return "ignored";
}

/** Narrow export for tests and docs: a quiet run is a completed CHAT result normalizing to typed no_update. */
export type { RoutineInstant, RoutineScope };
