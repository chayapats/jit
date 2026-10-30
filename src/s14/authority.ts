import { AppError } from "../errors";
import { containsCredential } from "../security/credentials";
import type { AppTransaction } from "../store";
import type { S14Application } from "./application";
import { record, records, save } from "./application";
import type { Bot, OwnerActor } from "./types";
import type { Admission, ApprovalCommand, Attempt, AuthorityCommand, AuthorityOptions, AuthorityReceipt, Effect, EffectAction, ScopePolicy, ScopeRef, Work, WorkGrant, WorkLimits, WorkOutput, WorkView } from "./authority-types";
import { canonical, digest, exact, identity, integer, text } from "./validation";

const id = () => crypto.randomUUID().replaceAll("-", "");
const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const refsEqual = (a: ScopeRef, b: ScopeRef) => a.kind === b.kind && a.id === b.id && a.revision === b.revision;
const maxLimits: WorkLimits = { attempts: 64, steps: 64, calls: 256, outputBytes: 1048576, wallMs: 86400000 };
const stopped = ["blocked", "stopping", "stopped", "ready"];
const effectKinds = ["send", "publish", "push", "payment", "delete"];
function list(v: unknown): asserts v is string[] {
  if (!Array.isArray(v) || v.length > 64 || new Set(v).size !== v.length) throw new AppError("invalid_list");
  for (const item of v) identity(item);
}
function scopeRef(v: unknown): asserts v is ScopeRef {
  exact(v, ["kind", "id", "revision"]); if (v.kind !== "resource" && v.kind !== "share") throw new AppError("invalid_scope"); identity(v.id); integer(v.revision, 1);
}
function limits(v: unknown): asserts v is WorkLimits {
  exact(v, Object.keys(maxLimits)); for (const k of Object.keys(maxLimits) as (keyof WorkLimits)[]) integer(v[k], 1, maxLimits[k]);
}
function action(v: unknown): asserts v is EffectAction {
  exact(v, ["kind", "destination", "content"]);
  if (!effectKinds.includes(v.kind as string)) throw new AppError("unsupported_effect", 403);
  for (const [key, max] of [["destination", 4096], ["content", 32768]] as const) { text(v[key], max); if (containsCredential(v[key] as string)) throw new AppError("credential_content_refused", 403); }
}

/** Materializes only a model suggestion anchored to its committed reply; this never grants execution. */
export function suggestTask(tx: AppTransaction, conversationId: string, messageId: string, data: unknown, now: number): void {
  try {
    exact(data, ["title", "purpose", "completionRule"]);
    const work: Work = { id: id(), revision: 1, conversationId, sourceMessageId: messageId, title: text(data.title, 200), purpose: text(data.purpose, 16384), completionRule: text(data.completionRule, 4000), state: "proposed", reason: null, grantId: null, result: null, createdAt: now };
    tx.run("INSERT INTO work_items VALUES (?,?,?)", work.id, conversationId, canonical(work));
  } catch { /* Untrusted malformed suggestions cannot become work authority. */ }
}

/** Finite grant, admission and exact-effect ledger; every barrier re-reads current owner/Bot/resource authority. */
export class S14Authority {
  #busy = false;
  #effects = new Set<string>();
  #running = new Map<string, AbortController>();
  constructor(readonly app: S14Application, readonly options: AuthorityOptions = {}) {}
  /** Applies typed authority commands inside the application's authenticated receipt transaction. */
  apply(tx: AppTransaction, c: AuthorityCommand): AuthorityReceipt {
    const receipt: AuthorityReceipt = { kind: c.kind, requestId: c.requestId };
    if (c.kind === "task.accept") {
      exact(c.payload, ["taskId"]); identity(c.payload.taskId);
      const work = record<Work>(tx, "work_items", c.payload.taskId);
      if (work.revision !== c.expectedRevision || work.state !== "proposed") throw new AppError("stale_revision", 409);
      work.state = "accepted"; work.revision++; save(tx, "work_items", work); return { ...receipt, work };
    }
    if (c.kind === "work.start") {
      const p = c.payload;
      exact(p, ["conversationId", "task", "title", "purpose", "completionRule", "bots", "tools", "scopes", "limits", "expiresAt"]);
      for (const value of [p.title, p.purpose, p.completionRule]) { text(value); if (containsCredential(value)) throw new AppError("credential_content_refused", 403); }
      identity(p.conversationId); const conversation = this.app.readConversation(tx, p.conversationId);
      if (conversation.revision !== c.expectedRevision) throw new AppError("stale_revision", 409);
      limits(p.limits); integer(p.expiresAt, 1, Number.MAX_SAFE_INTEGER);
      if (p.expiresAt <= this.app.now() || p.expiresAt > this.app.now() + p.limits.wallMs) throw new AppError("invalid_expiry");
      list(p.tools); if (p.tools.some(t => !this.app.policy.tools.includes(t))) throw new AppError("tool_not_allowed", 403);
      if (!Array.isArray(p.bots) || !p.bots.length || p.bots.length > 8 || new Set(p.bots.map(b => b.id)).size !== p.bots.length) throw new AppError("invalid_bots");
      const bots = p.bots.map(ref => {
        exact(ref, ["id", "revision"]); identity(ref.id); integer(ref.revision, 1);
        const bot = record<Bot>(tx, "bots", ref.id);
        if (!bot.enabled || bot.revision !== ref.revision) throw new AppError("bot_authority_changed", 403);
        this.app.route(bot.routeId); return bot;
      });
      if (p.tools.some(t => !bots.some(b => b.capabilities.tools.includes(t)))) throw new AppError("bot_ceiling", 403);
      let work: Work;
      if (p.task !== null) {
        exact(p.task, ["id", "revision"]); identity(p.task.id); integer(p.task.revision, 1);
        work = record<Work>(tx, "work_items", p.task.id);
        if (work.conversationId !== conversation.id || work.revision !== p.task.revision || work.state !== "accepted" || work.grantId) throw new AppError("stale_revision", 409);
        if (work.title !== p.title || work.purpose !== p.purpose || work.completionRule !== p.completionRule) throw new AppError("task_changed", 409);
      } else work = { id: id(), revision: 0, conversationId: conversation.id, sourceMessageId: null, title: text(p.title, 200), purpose: text(p.purpose), completionRule: text(p.completionRule, 4000), state: "accepted", reason: null, grantId: null, result: null, createdAt: this.app.now() };
      if (!Array.isArray(p.scopes) || p.scopes.length > 64) throw new AppError("invalid_scope");
      for (const ref of p.scopes) scopeRef(ref);
      if (new Set(p.scopes.map(s => `${s.kind}:${s.id}`)).size !== p.scopes.length) throw new AppError("invalid_scope");
      const scopes = p.scopes.map(ref => {
        const current = this.scope(tx, ref);
        if (!bots.some(b => this.accessible(current, b, work.id))) throw new AppError("scope_not_allowed", 403);
        return current;
      });
      const grant: WorkGrant = { id: id(), workId: work.id, revision: 1, generation: 1, ownerGeneration: tx.get<{ generation: number }>("SELECT generation FROM owner")!.generation, requestId: c.requestId, command: structuredClone(c),
        purpose: work.purpose, bots, routes: bots.map(b => this.app.route(b.routeId)), tools: structuredClone(p.tools), scopes, limits: structuredClone(p.limits), createdAt: this.app.now(), expiresAt: p.expiresAt };
      work.state = "queued"; work.revision++; work.grantId = grant.id;
      if (p.task === null) tx.run("INSERT INTO work_items VALUES (?,?,?)", work.id, work.conversationId, canonical(work)); else save(tx, "work_items", work);
      tx.run("INSERT INTO work_grants VALUES (?,?,?)", grant.id, work.id, canonical(grant));
      tx.run("INSERT INTO grant_state VALUES (?,1,0)", grant.id); tx.run("INSERT INTO grant_usage VALUES (?,0,0,0,0)", grant.id);
      tx.run("INSERT INTO work_queue VALUES (?,'queued')", work.id);
      tx.run("UPDATE conversations SET revision=revision+1 WHERE id=?", conversation.id);
      return { ...receipt, work, grant };
    }
    if (c.kind === "work.stop") {
      exact(c.payload, ["workId"]); identity(c.payload.workId);
      const work = record<Work>(tx, "work_items", c.payload.workId);
      if (work.revision !== c.expectedRevision) throw new AppError("stale_revision", 409);
      if (!work.grantId) throw new AppError("work_not_started", 409);
      tx.run("UPDATE grant_state SET generation=generation+1,revoked=1 WHERE grant_id=?", work.grantId);
      tx.run("UPDATE work_queue SET state='blocked' WHERE work_id=?", work.id);
      for (const attempt of this.attempts(tx, work.id)) if (attempt.state === "waiting") { attempt.state = "settled"; attempt.reason = "stopped"; save(tx, "work_attempts", attempt); }
      for (const effect of this.effects(tx, work.id)) if (["pending", "approved"].includes(effect.state)) { effect.state = "denied"; effect.reason = "work_stopped"; this.saveEffect(tx, effect); }
      work.state = this.attempts(tx, work.id).some(a => a.state === "running" || a.state === "interrupted") || this.effects(tx, work.id).some(e => e.state === "executing") ? "stopping" : "stopped";
      work.reason = "owner_stopped"; work.revision++; save(tx, "work_items", work); return { ...receipt, work };
    }
    if (c.kind === "approval.decide") return { ...receipt, effect: this.decide(tx, c) };
    throw new AppError("unknown_command");
  }
  /** Lists retained obligations without dispatch, acceptance or authority creation. */
  list(actor: OwnerActor): Work[] { return this.app.store.read(tx => { this.app.requireOwner(tx, actor); return records<Work>(tx, "work_items"); }); }
  /** Returns an exact effect and retained action revisions for the owner's changed-card diff. */
  effect(actor: OwnerActor, effectId: string): { effect: Effect; history: Effect[] } {
    identity(effectId);
    return this.app.store.read(tx => {
      this.app.requireOwner(tx, actor); const effect = record<Effect>(tx, "effects", effectId);
      return { effect: ["pending", "approved"].includes(effect.state) && effect.expiresAt <= this.app.now() ? { ...effect, state: "expired" } : effect,
        history: tx.all<{ record_json: string }>("SELECT record_json FROM effect_versions WHERE effect_id=? ORDER BY revision", effectId).map(r => JSON.parse(r.record_json)) };
    });
  }
  /** Returns immutable grant snapshots, current revocation, reservations, attempts and exact action cards. */
  view(actor: OwnerActor, workId: string): WorkView {
    identity(workId);
    return this.app.store.read(tx => {
      this.app.requireOwner(tx, actor); const work = record<Work>(tx, "work_items", workId);
      const authority = work.grantId ? tx.get<{ generation: number; revoked: number }>("SELECT generation,revoked FROM grant_state WHERE grant_id=?", work.grantId)! : null;
      return { work, grant: work.grantId ? record<WorkGrant>(tx, "work_grants", work.grantId) : null, authority: authority ? { ...authority, revoked: !!authority.revoked } : null,
        reservations: work.grantId ? tx.get<NonNullable<WorkView["reservations"]>>("SELECT attempts,steps,calls,output_bytes AS outputBytes FROM grant_usage WHERE grant_id=?", work.grantId) : null,
        actualUsage: null, attempts: this.attempts(tx, workId), effects: this.effects(tx, workId).map(e => (["pending", "approved"].includes(e.state) && e.expiresAt <= this.app.now() ? { ...e, state: "expired" as const } : e)) };
    });
  }
  private scope(tx: AppTransaction, ref: ScopeRef): ScopePolicy {
    scopeRef(ref); const current = this.options.scopes?.current(tx, structuredClone(ref));
    if (!current || !current.active || !refsEqual(current.ref, ref)) throw new AppError("scope_revoked_or_stale", 403);
    identity(current.ownerBotId); if (current.receiverBotId !== null) identity(current.receiverBotId); if (current.workId !== null) identity(current.workId);
    list(current.tools); identity(current.snapshot.id); integer(current.snapshot.revision, 1);
    if (!/^[a-f0-9]{64}$/.test(current.snapshot.hash) || (ref.kind === "share" && current.receiverBotId === null)) throw new AppError("invalid_scope_policy", 403);
    return structuredClone(current);
  }
  private accessible(scope: ScopePolicy, bot: Bot, workId: string): boolean {
    return bot.capabilities.resources.includes(scope.ref.id) && (scope.workId === null || scope.workId === workId) &&
      (scope.ref.kind === "share" ? scope.receiverBotId === bot.id : scope.ownerBotId === bot.id);
  }
  private attempts(tx: AppTransaction, workId: string): Attempt[] { return tx.all<{ record_json: string }>("SELECT record_json FROM work_attempts WHERE work_id=? ORDER BY rowid", workId).map(r => JSON.parse(r.record_json)); }
  private effects(tx: AppTransaction, workId: string): Effect[] { return tx.all<{ record_json: string }>("SELECT record_json FROM effects WHERE work_id=? ORDER BY rowid", workId).map(r => JSON.parse(r.record_json)); }
  private grantLive(tx: AppTransaction, grant: WorkGrant): Work {
    const work = record<Work>(tx, "work_items", grant.workId), state = tx.get<{ generation: number; revoked: number }>("SELECT generation,revoked FROM grant_state WHERE grant_id=?", grant.id);
    if (work.grantId !== grant.id || !state || state.revoked || state.generation !== grant.generation || stopped.includes(work.state)) throw new AppError("grant_revoked", 403);
    if (this.app.now() >= grant.expiresAt) throw new AppError("grant_expired", 403);
    if (tx.get<{ generation: number }>("SELECT generation FROM owner")?.generation !== grant.ownerGeneration) throw new AppError("owner_authority_changed", 403);
    return work;
  }
  private live(tx: AppTransaction, attempt: Attempt): Work {
    if (attempt.state !== "running" && attempt.state !== "waiting") throw new AppError("attempt_fenced", 403);
    if (!this.app.memory.attemptCurrent(tx, attempt.id)) throw new AppError("memory_context_stale", 403);
    const s = attempt.snapshot, work = this.grantLive(tx, s.grant), bot = record<Bot>(tx, "bots", s.bot.id);
    if (!bot.enabled || bot.revision !== s.bot.revision || bot.generation !== s.bot.generation || !equal(bot.capabilities, s.bot.capabilities) || !equal(this.app.route(bot.routeId), s.route)) throw new AppError("bot_authority_changed", 403);
    for (const scope of s.scopes) if (!equal(this.scope(tx, scope.ref), scope) || !this.accessible(scope, bot, work.id)) throw new AppError("scope_revoked_or_stale", 403);
    return work;
  }
  /** Admits a service-chosen bounded step once; model suggestions can only narrow a live owner grant. */
  admit(workId: string, requestId: string, input: Admission, parentId: string | null = null): Attempt {
    identity(workId); identity(requestId); const encoded = canonical({ input, parentId });
    return this.app.store.transaction(tx => this.admitIn(tx, workId, requestId, input, parentId, digest(encoded)));
  }
  private admitIn(tx: AppTransaction, workId: string, requestId: string, input: Admission, parentId: string | null, payloadHash: string): Attempt {
    exact(input, ["botId", "tools", "scopes", "input", "calls", "outputBytes"]); identity(input.botId); list(input.tools); integer(input.calls, 1, 256); integer(input.outputBytes, 1, 1048576); const purpose = text(input.input);
    const work = record<Work>(tx, "work_items", workId); if (!work.grantId) throw new AppError("grant_required", 403);
    const grant = record<WorkGrant>(tx, "work_grants", work.grantId); this.grantLive(tx, grant);
    const previous = tx.get<{ payload_hash: string; record_json: string }>("SELECT payload_hash,record_json FROM work_attempts WHERE work_id=? AND request_id=?", workId, requestId);
    if (previous) { if (previous.payload_hash !== payloadHash) throw new AppError("request_id_conflict", 409); return JSON.parse(previous.record_json); }
    const parent = parentId ? record<Attempt>(tx, "work_attempts", parentId) : null;
    if (parent) { if (parent.workId !== workId) throw new AppError("delegation_outside_grant", 403); this.live(tx, parent); }
    const origin = parent?.snapshot ?? grant;
    const bot = grant.bots.find(b => b.id === input.botId); if (!bot) throw new AppError("bot_outside_grant", 403);
    const current = record<Bot>(tx, "bots", bot.id);
    const route = grant.routes.find(r => r.id === bot.routeId)!;
    if (!equal(current, bot) || !current.enabled || !equal(this.app.route(bot.routeId), route)) throw new AppError("bot_authority_changed", 403);
    if (input.tools.some(t => !origin.tools.includes(t) || !bot.capabilities.tools.includes(t))) throw new AppError("tool_outside_grant", 403);
    if (!Array.isArray(input.scopes) || input.scopes.length > 64) throw new AppError("invalid_scope");
    const scopes = input.scopes.map(ref => {
      scopeRef(ref); const pinned = origin.scopes.find(s => refsEqual(s.ref, ref));
      if (!pinned || !this.accessible(pinned, bot, workId) || !equal(this.scope(tx, ref), pinned) || input.tools.some(t => !pinned.tools.includes(t))) throw new AppError("scope_outside_grant", 403);
      return pinned;
    });
    if (new Set(scopes.map(s => s.ref.id)).size !== scopes.length) throw new AppError("invalid_scope");
    // The pinned credential lifecycle does not authorize overlapping native hosts yet.
    if (tx.get("SELECT id FROM work_attempts WHERE json_extract(record_json,'$.state') IN ('running','interrupted') LIMIT 1")) throw new AppError("execution_capacity_held", 409);
    const usage = tx.get<{ attempts: number; steps: number; calls: number; output_bytes: number }>("SELECT * FROM grant_usage WHERE grant_id=?", grant.id)!;
    if (usage.attempts + 1 > grant.limits.attempts || usage.steps + 1 > grant.limits.steps || usage.calls + 1 > grant.limits.calls || usage.output_bytes + input.outputBytes > grant.limits.outputBytes || input.calls > grant.limits.calls) throw new AppError("budget_exhausted", 409);
    const attempt: Attempt = { id: id(), workId, requestId, parentId, snapshot: { grant, bot, route, tools: structuredClone(input.tools), scopes: structuredClone(scopes), input: purpose, calls: input.calls, outputBytes: input.outputBytes }, state: "running", reason: null, createdAt: this.app.now() };
    tx.run("INSERT INTO work_attempts VALUES (?,?,?,?,?)", attempt.id, workId, requestId, payloadHash, canonical(attempt));
    const packet = this.app.memory.assemble(tx, { botId: bot.id, conversationId: work.conversationId, purpose, sources: [], attempt });
    attempt.memoryId = packet.id;
    save(tx, "work_attempts", attempt);
    tx.run("INSERT INTO attempt_usage VALUES (?,1)", attempt.id);
    tx.run("UPDATE grant_usage SET attempts=attempts+1,steps=steps+1,calls=calls+1,output_bytes=output_bytes+? WHERE grant_id=?", input.outputBytes, grant.id);
    tx.run("UPDATE work_queue SET state='claimed' WHERE work_id=?", workId);
    work.state = "running"; work.revision++; save(tx, "work_items", work); return attempt;
  }
  /** Delegates only within the parent's narrowed tools/scopes and the receiving Bot's captured ceiling. */
  delegate(parentAttemptId: string, requestId: string, input: Admission): Attempt {
    const parent = this.app.store.read(tx => record<Attempt>(tx, "work_attempts", parentAttemptId));
    return this.admit(parent.workId, requestId, input, parent.id);
  }
  /** Reserves one call at the tool barrier; trusted adapters must use this immediately before their scoped call. */
  reserveTool(attemptId: string, tool: string, ref: ScopeRef | null = null): void {
    this.app.store.transaction(tx => {
      const attempt = record<Attempt>(tx, "work_attempts", attemptId); this.live(tx, attempt);
      if (!attempt.snapshot.tools.includes(tool)) throw new AppError("tool_outside_grant", 403);
      if (ref && !attempt.snapshot.scopes.some(s => refsEqual(s.ref, ref) && s.tools.includes(tool))) throw new AppError("scope_outside_grant", 403);
      this.chargeCall(tx, attempt);
    });
  }
  private chargeCall(tx: AppTransaction, attempt: Attempt): void {
    const calls = tx.get<{ calls: number }>("SELECT calls FROM attempt_usage WHERE attempt_id=?", attempt.id)!.calls;
    const total = tx.get<{ calls: number }>("SELECT calls FROM grant_usage WHERE grant_id=?", attempt.snapshot.grant.id)!.calls;
    if (calls >= attempt.snapshot.calls || total >= attempt.snapshot.grant.limits.calls) throw new AppError("budget_exhausted", 409);
    tx.run("UPDATE attempt_usage SET calls=calls+1 WHERE attempt_id=?", attempt.id); tx.run("UPDATE grant_usage SET calls=calls+1 WHERE grant_id=?", attempt.snapshot.grant.id);
  }
  /** Commits result evidence only under the original still-live authority; late/fenced output is discarded. */
  commit(attemptId: string, output: WorkOutput): void {
    exact(output, ["state", "text"]); if (!["ready", "waiting"].includes(output.state)) throw new AppError("invalid_result");
    this.app.store.transaction(tx => {
      const attempt = record<Attempt>(tx, "work_attempts", attemptId), work = this.live(tx, attempt);
      const content = text(output.text, attempt.snapshot.outputBytes);
      const previous = tx.get("SELECT attempt_id FROM work_results WHERE attempt_id=?", attempt.id); if (previous) throw new AppError("result_already_committed", 409);
      tx.run("INSERT INTO work_results VALUES (?,?,?,?)", attempt.id, work.id, content, this.app.now());
      const held = this.effects(tx, work.id).some(e => ["pending", "approved", "executing", "unknown"].includes(e.state));
      attempt.state = output.state === "waiting" || held ? "waiting" : "committed"; save(tx, "work_attempts", attempt);
      const others = this.attempts(tx, work.id).filter(a => a.id !== attempt.id && ["running", "waiting", "interrupted"].includes(a.state));
      work.result = tx.all<{ content: string }>("SELECT content FROM work_results WHERE work_id=? ORDER BY rowid", work.id).map(r => r.content).join("\n\n");
      work.state = held || output.state === "waiting" ? "waiting" : others.length ? "running" : "ready"; work.revision++; save(tx, "work_items", work);
    });
  }
  /** Settles an actual returned transport while preserving stop/revocation fences and already committed evidence. */
  settle(attemptId: string, reason = "handler_unavailable"): void {
    this.app.store.transaction(tx => {
      const attempt = record<Attempt>(tx, "work_attempts", attemptId); if (attempt.state !== "running") return;
      attempt.state = "settled"; attempt.reason = reason; save(tx, "work_attempts", attempt);
      const work = record<Work>(tx, "work_items", attempt.workId);
      if (work.state === "stopping") this.finishStop(tx, work);
      else if (!this.attempts(tx, work.id).some(a => ["running", "waiting"].includes(a.state))) { work.state = "blocked"; work.reason = reason; work.revision++; save(tx, "work_items", work); }
    });
  }
  private finishStop(tx: AppTransaction, work: Work): void {
    if (!this.attempts(tx, work.id).some(a => ["running", "interrupted"].includes(a.state)) && !this.effects(tx, work.id).some(e => e.state === "executing")) { work.state = "stopped"; work.revision++; save(tx, "work_items", work); }
  }
  /** Records an exact held effect under live scoped tool authority, without performing any external action. */
  proposeEffect(attemptId: string, requestId: string, proposed: EffectAction, expiresAt: number): Effect {
    identity(requestId); action(proposed); integer(expiresAt, 1, Number.MAX_SAFE_INTEGER); const encoded = canonical({ proposed, expiresAt });
    return this.app.store.transaction(tx => {
      const attempt = record<Attempt>(tx, "work_attempts", attemptId); this.live(tx, attempt);
      if (!attempt.snapshot.tools.includes(`effect_${proposed.kind}`)) throw new AppError("effect_outside_grant", 403);
      if (expiresAt <= this.app.now() || expiresAt > attempt.snapshot.grant.expiresAt) throw new AppError("invalid_expiry");
      const previous = tx.get<{ payload_hash: string; record_json: string }>("SELECT payload_hash,record_json FROM effects WHERE attempt_id=? AND request_id=?", attemptId, requestId);
      if (previous) { if (previous.payload_hash !== digest(encoded)) throw new AppError("request_id_conflict", 409); return JSON.parse(previous.record_json); }
      if (tx.get<{ n: number }>("SELECT count(*) AS n FROM effects WHERE attempt_id=?", attemptId)!.n >= attempt.snapshot.calls) throw new AppError("budget_exhausted", 409);
      const effect: Effect = { id: id(), revision: 1, workId: attempt.workId, attemptId, botId: attempt.snapshot.bot.id, action: structuredClone(proposed), actionHash: digest(canonical(proposed)), expiresAt, state: "pending", reason: null, supported: !!this.options.effects?.[proposed.kind] };
      tx.run("INSERT INTO effects VALUES (?,?,?,?,?,?)", effect.id, effect.workId, effect.attemptId, requestId, digest(encoded), canonical(effect));
      tx.run("INSERT INTO effect_versions VALUES (?,?,?)", effect.id, effect.revision, canonical(effect)); return effect;
    });
  }
  /** Replaces a held action with a new unapproved revision; previous decisions never authorize changed content. */
  reviseEffect(attemptId: string, effectId: string, expectedRevision: number, proposed: EffectAction, expiresAt: number): Effect {
    action(proposed); integer(expiresAt, 1, Number.MAX_SAFE_INTEGER);
    return this.app.store.transaction(tx => {
      const attempt = record<Attempt>(tx, "work_attempts", attemptId); this.live(tx, attempt);
      const effect = record<Effect>(tx, "effects", effectId);
      if (effect.attemptId !== attemptId || effect.revision !== expectedRevision || !["pending", "approved"].includes(effect.state)) throw new AppError("stale_revision", 409);
      if (!attempt.snapshot.tools.includes(`effect_${proposed.kind}`)) throw new AppError("effect_outside_grant", 403);
      if (effect.revision >= attempt.snapshot.calls) throw new AppError("budget_exhausted", 409);
      if (expiresAt <= this.app.now() || expiresAt > attempt.snapshot.grant.expiresAt) throw new AppError("invalid_expiry");
      effect.state = "changed"; this.saveEffect(tx, effect);
      effect.revision++; effect.action = structuredClone(proposed); effect.actionHash = digest(canonical(proposed)); effect.expiresAt = expiresAt; effect.state = "pending"; effect.reason = null; effect.supported = !!this.options.effects?.[proposed.kind]; this.saveEffect(tx, effect); return effect;
    });
  }
  private decide(tx: AppTransaction, c: ApprovalCommand): Effect {
    exact(c.payload, ["effectId", "actionHash", "decision"]); identity(c.payload.effectId);
    const effect = record<Effect>(tx, "effects", c.payload.effectId);
    if (effect.revision !== c.expectedRevision || effect.actionHash !== c.payload.actionHash || effect.state !== "pending") throw new AppError("stale_approval", 409);
    if (this.app.now() >= effect.expiresAt) throw new AppError("approval_expired", 409);
    this.live(tx, record<Attempt>(tx, "work_attempts", effect.attemptId));
    if (!["approve", "deny"].includes(c.payload.decision)) throw new AppError("invalid_decision");
    effect.state = c.payload.decision === "approve" ? "approved" : "denied"; this.saveEffect(tx, effect); return effect;
  }
  private saveEffect(tx: AppTransaction, effect: Effect): void { save(tx, "effects", effect); tx.run("INSERT OR REPLACE INTO effect_versions VALUES (?,?,?)", effect.id, effect.revision, canonical(effect)); }
  /** Runs a configured reviewed performer at most once; a crash or uncertain result becomes reconcile-only unknown. */
  async runEffect(effectId: string, expectedRevision: number, actionHash: string): Promise<Effect> {
    if (this.#effects.has(effectId)) throw new AppError("effect_busy", 409);
    const effect = this.app.store.transaction(tx => {
      const current = record<Effect>(tx, "effects", effectId);
      if (current.revision !== expectedRevision || current.actionHash !== actionHash || current.actionHash !== digest(canonical(current.action)) || current.state !== "approved") throw new AppError("stale_approval", 409);
      const attempt = record<Attempt>(tx, "work_attempts", current.attemptId); this.live(tx, attempt);
      if (this.app.now() >= current.expiresAt) throw new AppError("approval_expired", 409);
      if (!this.options.effects?.[current.action.kind]) throw new AppError("effect_adapter_unavailable", 503);
      this.chargeCall(tx, attempt); current.state = "executing"; this.saveEffect(tx, current); return current;
    });
    this.#effects.add(effect.id);
    const selectedAction = structuredClone(effect.action);
    const allowed = () => this.app.store.read(tx => {
      const current = record<Effect>(tx, "effects", effect.id); this.live(tx, record<Attempt>(tx, "work_attempts", effect.attemptId));
      if (current.state !== "executing" || current.revision !== effect.revision || current.actionHash !== effect.actionHash || digest(canonical(selectedAction)) !== effect.actionHash || this.app.now() >= effect.expiresAt) throw new AppError("effect_fenced", 403);
    });
    let outcome: "succeeded" | "failed" | "unknown" = "unknown";
    try { allowed(); outcome = await this.options.effects![effect.action.kind]!(selectedAction, allowed); if (!["succeeded", "failed", "unknown"].includes(outcome)) outcome = "unknown"; }
    catch { /* Exceptions may contain secrets; uncertainty is not retryable. */ }
    finally { this.#effects.delete(effect.id); }
    return this.app.store.transaction(tx => {
      const current = record<Effect>(tx, "effects", effect.id); if (current.state !== "executing") return current;
      try { this.live(tx, record<Attempt>(tx, "work_attempts", current.attemptId)); if (this.app.now() >= current.expiresAt) outcome = "unknown"; } catch { outcome = "unknown"; }
      current.state = outcome; current.reason = outcome === "unknown" ? "reconcile_only_no_retry" : null; this.saveEffect(tx, current);
      const work = record<Work>(tx, "work_items", current.workId); if (work.state === "stopping") this.finishStop(tx, work); return current;
    });
  }
  /** Exclusive-boot fencing; interrupted attempts and executing effects are never automatically replayed. */
  recover(): void { this.app.store.transaction(tx => {
    for (const row of tx.all<{ record_json: string }>("SELECT record_json FROM work_attempts WHERE json_extract(record_json,'$.state') IN ('running','waiting')")) {
      const attempt = JSON.parse(row.record_json) as Attempt; attempt.state = "interrupted"; attempt.reason = "native_reconciliation_required"; save(tx, "work_attempts", attempt);
      const work = record<Work>(tx, "work_items", attempt.workId); if (work.state !== "stopping" && work.state !== "stopped") { work.state = "blocked"; work.reason = attempt.reason; work.revision++; save(tx, "work_items", work); }
    }
    for (const row of tx.all<{ record_json: string }>("SELECT record_json FROM effects WHERE json_extract(record_json,'$.state')='executing'")) {
      const effect = JSON.parse(row.record_json) as Effect; effect.state = "unknown"; effect.reason = "interrupted_reconcile_only_no_retry"; this.saveEffect(tx, effect);
    }
  }); }
  /** Requests cancellation after committed fencing; capacity stays held until the actual call settles. */
  cancelFenced(): void {
    for (const [attemptId, abort] of this.#running) {
      try { this.app.store.read(tx => this.live(tx, record<Attempt>(tx, "work_attempts", attemptId))); } catch { abort.abort(); }
    }
  }
  /** Drains committed internal queue intents serially; no missing handler can fall back to shell or another route. */
  async drain(): Promise<void> {
    if (this.#busy || !this.options.executor) return; this.#busy = true;
    try { for (;;) {
      const key = this.app.store.read(tx => tx.get<{ work_id: string }>("SELECT work_id FROM work_queue WHERE state='queued' ORDER BY rowid LIMIT 1")?.work_id); if (!key) return;
      let attempt: Attempt | null;
      try { attempt = this.app.store.transaction(tx => {
        if (tx.get<{ state: string }>("SELECT state FROM work_queue WHERE work_id=?", key)?.state !== "queued") return null;
        const work = record<Work>(tx, "work_items", key), grant = record<WorkGrant>(tx, "work_grants", work.grantId!), bot = grant.bots[0]!;
        const admission: Admission = { botId: bot.id, tools: grant.tools.filter(t => bot.capabilities.tools.includes(t)), scopes: grant.scopes.filter(s => this.accessible(s, bot, work.id)).map(s => s.ref), input: `${work.purpose}\nCompletion rule: ${work.completionRule}`, calls: Math.max(1, Math.floor(grant.limits.calls / grant.limits.attempts)), outputBytes: Math.max(1, Math.floor(grant.limits.outputBytes / grant.limits.attempts)) };
        return this.admitIn(tx, key, `initial_${grant.requestId}`, admission, null, digest(canonical({ input: admission, parentId: null })));
      }); } catch (e) { if (e instanceof AppError && e.code === "execution_capacity_held") return; this.app.store.transaction(tx => { const w = record<Work>(tx, "work_items", key); w.state = "blocked"; w.reason = e instanceof AppError ? e.code : "admission_refused"; w.revision++; save(tx, "work_items", w); tx.run("UPDATE work_queue SET state='blocked' WHERE work_id=?", key); }); continue; }
      if (!attempt) continue;
      const abort = new AbortController(), timer = setTimeout(() => abort.abort(), Math.max(1, attempt.snapshot.grant.expiresAt - this.app.now()));
      this.#running.set(attempt.id, abort);
      try { const output = await this.options.executor.run(structuredClone(attempt), abort.signal); if (abort.signal.aborted) this.settle(attempt.id, "deadline_exceeded"); else this.commit(attempt.id, output); }
      catch (e) { this.settle(attempt.id, e instanceof AppError ? e.code : "handler_unavailable"); }
      finally { clearTimeout(timer); this.#running.delete(attempt.id); }
    } } finally { this.#busy = false; }
  }
}
