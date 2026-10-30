import { HostError, type HostSessionReference } from "schway/host";
import { AppError } from "../errors";
import { containsCredential } from "../security/credentials";
import type { AppTransaction } from "../store";
import { record, save, type S14Application } from "./application";
import type { Attempt, Effect, Work } from "./authority-types";
import type { WorkGraph, WorkStep } from "./graph-types";
import type { MemoryPacket } from "./memory-types";
import type { OwnerActor, Route } from "./types";
import type { NativeIntent, NativeRecoveryPort, RecoveryCommand, RecoveryReceipt, RecoveryView, WorkCheckpoint } from "./recovery-types";
import { checkpointFingerprint, replayPolicy } from "./replay-policy";
import { canonical, exact, identity, text } from "./validation";

const id = () => crypto.randomUUID().replaceAll("-", "");
const safeReason = (error: unknown) => error instanceof AppError ? error.code : error instanceof HostError ? `native_${error.code}` : "native_reconciliation_unresolved";

/** Exclusive-boot attempt fencing, public native discovery and trusted replay admission without effect retry. */
export class S14Recovery {
  #booting = false;
  #bootComplete: boolean;
  /** Process-local application boot time in epoch milliseconds, stable across repeated reconciliation and read-only queries. */
  readonly bootedAt: number;
  constructor(readonly app: S14Application) { this.bootedAt = app.now(); this.#bootComplete = !app.options.requireBootReconciliation; }

  /** Indicates the startup barrier; worker drains cannot admit work while metadata reconciliation is in progress. */
  get booting(): boolean { return this.#booting || !this.#bootComplete; }

  private checkpoints(tx: AppTransaction): WorkCheckpoint[] {
    return tx.all<{ record_json: string }>("SELECT record_json FROM work_checkpoints ORDER BY rowid").map(row => JSON.parse(row.record_json));
  }
  private intents(tx: AppTransaction): NativeIntent[] {
    return tx.all<{ record_json: string }>("SELECT record_json FROM native_intents ORDER BY rowid").map(row => JSON.parse(row.record_json));
  }
  private saveCheckpoint(tx: AppTransaction, checkpoint: WorkCheckpoint): void {
    tx.run("UPDATE work_checkpoints SET record_json=? WHERE id=?", canonical(checkpoint), checkpoint.id);
  }
  private saveIntent(tx: AppTransaction, intent: NativeIntent): void {
    tx.run("UPDATE native_intents SET record_json=? WHERE id=?", canonical(intent), intent.id);
  }
  private graph(tx: AppTransaction, attempt: Attempt): WorkGraph | null {
    return attempt.step ? record<WorkGraph>(tx, "work_graphs", attempt.workId) : null;
  }

  /** Captures trusted replay policy and immutable admission before any worker dispatch. */
  prepare(tx: AppTransaction, attempt: Attempt): void {
    const checkpoint: WorkCheckpoint = { id: attempt.id, workId: attempt.workId, stepId: attempt.step?.id ?? null,
      fingerprint: checkpointFingerprint(attempt, this.graph(tx, attempt)), ...replayPolicy(attempt), reservationId: attempt.id,
      evidence: [], transport: "not_started", state: "prepared", reason: null, replacementAttemptId: null };
    tx.run("INSERT OR REPLACE INTO work_checkpoints VALUES (?,?,?)", checkpoint.id, checkpoint.workId, canonical(checkpoint));
    for (const previous of this.checkpoints(tx)) if (previous.id !== attempt.id && previous.stepId === checkpoint.stepId && previous.state === "queued") {
      previous.state = "resumed";
      previous.reason = "replay_safe_resumed";
      previous.replacementAttemptId = attempt.id;
      this.saveCheckpoint(tx, previous);
    }
  }

  /** Retains monotonic charged reservations outside stale application images in the same writer transaction. */
  reserve(tx: AppTransaction, grantId: string): void {
    tx.run(`INSERT INTO lifecycle.grant_usage SELECT grant_id,attempts,steps,calls,output_bytes,reads FROM grant_usage WHERE grant_id=?
      ON CONFLICT(grant_id) DO UPDATE SET attempts=max(attempts,excluded.attempts),steps=max(steps,excluded.steps),
      calls=max(calls,excluded.calls),output_bytes=max(output_bytes,excluded.output_bytes),reads=max(reads,excluded.reads)`, grantId);
  }

  /** Restores conservative reservation high-water marks before any command, worker or owner usage projection. */
  reconcileReservations(tx: AppTransaction): void {
    tx.run(`UPDATE grant_usage SET attempts=max(attempts,coalesce((SELECT attempts FROM lifecycle.grant_usage l WHERE l.grant_id=grant_usage.grant_id),0)),
      steps=max(steps,coalesce((SELECT steps FROM lifecycle.grant_usage l WHERE l.grant_id=grant_usage.grant_id),0)),
      calls=max(calls,coalesce((SELECT calls FROM lifecycle.grant_usage l WHERE l.grant_id=grant_usage.grant_id),0)),
      output_bytes=max(output_bytes,coalesce((SELECT output_bytes FROM lifecycle.grant_usage l WHERE l.grant_id=grant_usage.grant_id),0)),
      reads=max(reads,coalesce((SELECT reads FROM lifecycle.grant_usage l WHERE l.grant_id=grant_usage.grant_id),0))`);
  }

  /** Records dispatch uncertainty durably before invoking a trusted executor. */
  dispatch(tx: AppTransaction, attemptId: string): void {
    const checkpoint = this.checkpoints(tx).find(c => c.id === attemptId)!;
    checkpoint.state = "dispatched";
    checkpoint.transport = "unknown";
    this.saveCheckpoint(tx, checkpoint);
  }

  /** Records committed evidence atomically with result/artifact publication, never from model done text. */
  committed(tx: AppTransaction, attemptId: string): void {
    const checkpoint = this.checkpoints(tx).find(c => c.id === attemptId);
    if (!checkpoint) return;
    checkpoint.state = "committed";
    checkpoint.evidence = tx.all<{ id: string }>("SELECT id FROM reports WHERE attempt_id=?", attemptId).map(row => row.id);
    this.saveCheckpoint(tx, checkpoint);
  }

  /** Records actual local transport settlement independently from result publication and reservation accounting. */
  settled(tx: AppTransaction, attemptId: string, interrupted = false): void {
    const checkpoint = this.checkpoints(tx).find(c => c.id === attemptId);
    if (!checkpoint) return;
    checkpoint.transport = "settled";
    const attempt = record<Attempt>(tx, "work_attempts", attemptId);
    if (attempt.state === "settled" && checkpoint.state !== "committed" && !interrupted && attempt.reason !== "work_cancelled_or_deadline") {
      checkpoint.state = "finished";
      checkpoint.reason = attempt.reason ?? "handler_finished_without_result";
    }
    this.saveCheckpoint(tx, checkpoint);
  }

  /** Persists a correlation intent before native creation; its private workspace permits orphan discovery. */
  intent(attemptId: string | null, contextId: string | null, route: Route): NativeIntent {
    return this.app.store.transaction(tx => {
      const attempt = attemptId ? this.app.authority.guard(tx, attemptId) : null;
      if (attempt && (contextId !== attempt.memoryId || canonical(route) !== canonical(attempt.snapshot.route))) throw new AppError("native_correlation_scope_changed", 403);
      const context = contextId ? record<MemoryPacket>(tx, "memory_contexts", contextId) : null;
      if (context && !this.app.memory.current(tx, context)) throw new AppError("native_context_fenced", 403);
      const intent: NativeIntent = {
        id: id(), attemptId, contextId, route: structuredClone(route), reference: null,
        workId: attempt?.workId ?? null, grantId: attempt?.snapshot.grant.id ?? null,
        botId: attempt?.snapshot.bot.id ?? context?.botId ?? null, computer: attempt?.snapshot.tools.includes("computer") ?? false,
        state: "creating", discovered: [], mode: "retire", reason: null,
      };
      tx.run("INSERT INTO native_intents VALUES (?,?)", intent.id, canonical(intent));
      tx.run("INSERT INTO lifecycle.native_intents VALUES (?,?)", intent.id, canonical(intent));
      return intent;
    });
  }

  /** Rechecks a chat context before native creation, credentials and inference dispatch without creating authority. */
  guardContext(contextId: string): void {
    this.app.store.read(tx => {
      const packet = record<MemoryPacket>(tx, "memory_contexts", contextId);
      if (!this.app.memory.current(tx, packet)) throw new AppError("native_context_fenced", 403);
    });
  }

  /** Records the exact execution branch returned after native persistence without changing original authority. */
  correlate(intentId: string, reference: HostSessionReference): void {
    this.app.store.transaction(tx => {
      const intent = this.intents(tx).find(i => i.id === intentId);
      if (!intent || intent.state !== "creating") throw new AppError("native_intent_fenced", 409);
      intent.reference = structuredClone(reference);
      intent.state = "correlated";
      this.saveIntent(tx, intent);
    });
  }

  /** Records an acknowledged normal retirement; errors stay discoverable and never imply stopped or deleted. */
  retired(intentId: string): void {
    this.app.store.transaction(tx => {
      const intent = this.intents(tx).find(i => i.id === intentId)!;
      intent.state = "retired";
      intent.reason = null;
      this.saveIntent(tx, intent);
    });
  }

  /** Reconciles independent effect claims/resolutions before any restored approval or worker can execute. */
  reconcileEffects(tx: AppTransaction): void {
    for (const effect of tx.all<{ record_json: string }>("SELECT record_json FROM effects").map(row => JSON.parse(row.record_json) as Effect)) {
      const claimed = tx.get("SELECT 1 FROM lifecycle.withdrawals WHERE kind='effect_claim' AND id=? AND mode=?", effect.id, `revision_${effect.revision}`);
      if (claimed && ["pending", "approved", "executing"].includes(effect.state)) {
        effect.state = "unknown";
        effect.reason = "interrupted_reconcile_only_no_retry";
      }
      const resolution = tx.get<{ revision: number; outcome: "occurred" | "did_not_occur"; recorded_at: number }>("SELECT revision,outcome,recorded_at FROM lifecycle.effect_outcomes WHERE effect_id=? AND action_hash=? ORDER BY revision DESC LIMIT 1", effect.id, effect.actionHash);
      if (resolution && (resolution.revision > effect.revision || resolution.revision === effect.revision && !effect.resolution)) {
        effect.revision = resolution.revision;
        effect.state = "unknown";
        effect.reason = "owner_statement_not_verified";
        effect.resolution = { basis: "owner_statement", outcome: resolution.outcome, note: "[restored owner statement]", recordedAt: resolution.recorded_at };
      }
      save(tx, "effects", effect);
      tx.run("INSERT OR REPLACE INTO effect_versions VALUES (?,?,?)", effect.id, effect.revision, canonical(effect));
    }
  }

  /** Records an owner's stated unknown-effect outcome without retrying, invoking a performer or asserting verification. */
  apply(tx: AppTransaction, command: RecoveryCommand): RecoveryReceipt {
    const p = command.payload;
    exact(p, ["effectId", "actionHash", "outcome", "note"]);
    identity(p.effectId);
    if (!["occurred", "did_not_occur"].includes(p.outcome) || containsCredential(p.note)) throw new AppError("invalid_effect_resolution");
    const note = text(p.note, 2000), effect = record<Effect>(tx, "effects", p.effectId);
    if (effect.revision !== command.expectedRevision || effect.actionHash !== p.actionHash || effect.state !== "unknown" || effect.resolution) throw new AppError("stale_effect_resolution", 409);
    effect.revision++;
    effect.state = "unknown";
    effect.reason = "owner_statement_not_verified";
    effect.resolution = { basis: "owner_statement", outcome: p.outcome, note, recordedAt: this.app.now() };
    tx.run("INSERT INTO lifecycle.effect_outcomes VALUES (?,?,?,?,?)", effect.id, effect.actionHash, effect.revision, p.outcome, this.app.now());
    save(tx, "effects", effect);
    tx.run("INSERT INTO effect_versions VALUES (?,?,?)", effect.id, effect.revision, canonical(effect));
    return { kind: command.kind, requestId: command.requestId, effect };
  }

  private async discover(port: NativeRecoveryPort, original: NativeIntent): Promise<void> {
    const intent = structuredClone(original);
    let host: Awaited<ReturnType<NativeRecoveryPort["open"]>> | undefined;
    try {
      host = await port.open(intent);
      const sessions = new Map<string, NativeIntent["discovered"][number]>();
      let after: string | undefined;
      const cursors = new Set<string>();
      do {
        const page = await host.listSessions({ limit: 64, ...(after ? { after } : {}) });
        for (const session of page.sessions) sessions.set(session.reference.id, session);
        after = page.next;
        if (after && cursors.has(after)) throw new AppError("native_inventory_cursor_unresolved", 503);
        if (after) cursors.add(after);
      } while (after);
      intent.discovered = [...sessions.values()];
      this.app.store.transaction(tx => this.saveIntent(tx, intent));
      if (intent.reference && !sessions.has(intent.reference.id)) throw new AppError("native_reference_missing", 503);
      for (const session of sessions.values()) {
        // Management uses inventory main identity; the saved execution branch is retained unchanged.
        if (intent.mode === "delete") {
          if (session.state !== "deleted") {
            const result = await host.deleteSession(session.reference);
            if (result.status !== "deleted" && result.status !== "already-deleted") throw new AppError(result.status === "blocked" ? `native_${result.reason}` : "native_delete_partial", 503);
          }
        } else if (session.state === "active") await host.retireSession(session.reference);
      }
      intent.state = !sessions.size ? "not_created" : intent.mode === "delete" || [...sessions.values()].every(s => s.state === "deleted") ? "deleted" : "retired";
      intent.reason = sessions.size ? null : "native_not_created";
    } catch (error) {
      intent.state = "unresolved";
      intent.reason = safeReason(error);
    } finally {
      try { await host?.close(); }
      catch {
        intent.state = "unresolved";
        intent.reason = "native_close_unresolved";
      }
      this.app.store.transaction(tx => this.saveIntent(tx, intent));
    }
  }

  /** Retires or deletes all discoverable native contexts for one fenced Bot using metadata-only public APIs. */
  async cleanupBot(botId: string, mode: "retire" | "delete", port: NativeRecoveryPort): Promise<boolean> {
    const intents = this.app.store.transaction(tx => {
      tx.run("INSERT OR IGNORE INTO native_intents SELECT id,record_json FROM lifecycle.native_intents");
      const contexts = new Set([
        ...tx.all<{ id: string }>("SELECT id FROM memory_contexts WHERE bot_id=?", botId).map(row => row.id),
        ...(mode === "delete" ? tx.all<{ mode: string }>("SELECT mode FROM lifecycle.withdrawals WHERE kind='bot_context' AND id=?", botId).map(row => row.mode) : []),
      ]);
      const grants = new Set(tx.all<{ id: string }>(`SELECT id FROM work_grants g WHERE EXISTS
        (SELECT 1 FROM json_each(g.record_json,'$.bots') b WHERE json_extract(b.value,'$.id')=?)`, botId).map(row => row.id));
      return this.intents(tx).filter(intent => intent.botId === botId || intent.contextId !== null && contexts.has(intent.contextId) || intent.grantId !== null && grants.has(intent.grantId)).map(intent => {
        if (mode === "delete" && (intent.botId === botId || intent.contextId !== null && contexts.has(intent.contextId))) intent.mode = "delete";
        this.saveIntent(tx, intent);
        return intent;
      });
    });
    for (const intent of intents) await this.discover(port, intent);
    return this.app.store.transaction(tx => {
      const current = this.intents(tx).filter(intent => intents.some(i => i.id === intent.id));
      const settled = (intent: NativeIntent) => (intent.mode === "delete" ? ["deleted", "not_created"] : ["retired", "deleted", "not_created"]).includes(intent.state);
      for (const attemptId of new Set(current.map(i => i.attemptId).filter((key): key is string => key !== null))) {
        const owned = current.filter(i => i.attemptId === attemptId);
        const row = tx.get<{ record_json: string }>("SELECT record_json FROM work_attempts WHERE id=?", attemptId);
        if (!row || !owned.every(settled)) continue;
        const attempt = JSON.parse(row.record_json) as Attempt;
        if (attempt.state !== "interrupted") continue;
        attempt.state = "settled";
        attempt.reason = "bot_lifecycle_fenced";
        save(tx, "work_attempts", attempt);
        tx.run("UPDATE attempt_transports SET active=0 WHERE attempt_id=?", attempt.id);
        const checkpoint = this.checkpoints(tx).find(c => c.id === attemptId);
        if (checkpoint) { checkpoint.transport = "settled"; checkpoint.state = "waiting"; checkpoint.reason = "bot_lifecycle_fenced"; this.saveCheckpoint(tx, checkpoint); }
        const work = record<Work>(tx, "work_items", attempt.workId);
        if (work.state === "stopping" && !tx.get("SELECT 1 FROM work_attempts WHERE work_id=? AND (json_extract(record_json,'$.state') IN ('running','interrupted') OR EXISTS (SELECT 1 FROM attempt_transports WHERE attempt_id=work_attempts.id AND active=1))", work.id)) {
          work.state = "stopped"; work.revision++; save(tx, "work_items", work);
        }
      }
      return current.every(settled);
    });
  }

  private reason(tx: AppTransaction, checkpoint: WorkCheckpoint, attempt: Attempt): string | null {
    const work = record<Work>(tx, "work_items", attempt.workId);
    if (["stopped", "stopping"].includes(work.state) || work.reason === "owner_stopped") return "owner_stopped";
    if (attempt.step) {
      const step = record<WorkStep>(tx, "work_steps", attempt.step.id);
      if (["cancelled", "stopping"].includes(step.state) || tx.get("SELECT 1 FROM lifecycle.withdrawals WHERE kind='step_stop' AND id=?", step.id)) return "owner_stopped_step";
    }
    try {
      // Retention is not a new admission: expiry cannot erase a committed result.
      this.app.authority.recoveryGrant(tx, attempt.snapshot.grant, !!tx.get("SELECT 1 FROM work_results WHERE attempt_id=?", attempt.id));
      if (!this.app.authority.retainedEvidence(tx, attempt.id)) return "configuration_or_route_changed";
      if (!this.app.memory.attemptCurrent(tx, attempt.id)) return "source_or_context_changed";
    } catch (error) { return safeReason(error); }
    if (checkpoint.fingerprint !== checkpointFingerprint(attempt, this.graph(tx, attempt)) || checkpoint.handlerVersion !== replayPolicy(attempt).handlerVersion) return "checkpoint_configuration_changed";
    if (tx.get("SELECT 1 FROM effects WHERE attempt_id=? AND json_extract(record_json,'$.state') IN ('unknown','executing')", attempt.id)) return "unknown_effect_reconcile_only";
    if (checkpoint.transport !== "settled") return "old_transport_unsettled";
    if (tx.get("SELECT 1 FROM work_results WHERE attempt_id=?", attempt.id)) return null;
    if (checkpoint.replay !== "replay_safe" || replayPolicy(attempt).replay !== "replay_safe") return "handler_requires_reconciliation";
    const grant = attempt.snapshot.grant, usage = tx.get<{ attempts: number; steps: number; calls: number; output_bytes: number; reads: number }>("SELECT * FROM grant_usage WHERE grant_id=?", grant.id)!;
    if (usage.attempts >= grant.limits.attempts || usage.steps >= grant.limits.steps || usage.calls + attempt.snapshot.calls > grant.limits.calls ||
        usage.output_bytes + attempt.snapshot.outputBytes > grant.limits.outputBytes || attempt.snapshot.tools.some(t => t.startsWith("web_")) && usage.reads >= grant.limits.reads) return "budget_exhausted";
    if (!attempt.step) return "handler_requires_reconciliation";
    return null;
  }

  /** Fences first, discovers correlated/orphan native identities, then queues only settled unchanged trusted safe steps. */
  async boot(port: NativeRecoveryPort): Promise<void> {
    if (this.#booting) throw new AppError("recovery_in_progress", 409);
    this.#booting = true;
    this.#bootComplete = false;
    try {
      this.app.store.transaction(tx => { this.app.botLifecycle.reconcile(tx); this.reconcileReservations(tx); this.reconcileEffects(tx); });
      this.app.store.transaction(tx => tx.run("UPDATE reply_transports SET active=0"));
      this.app.recoverReplies();
      this.app.authority.recover();
      this.app.parallel.recover();
      this.app.computers.recover();
      const intents = this.app.store.transaction(tx => {
        tx.run("INSERT OR IGNORE INTO native_intents SELECT id,record_json FROM lifecycle.native_intents");
        return this.intents(tx).map(intent => {
          if (intent.contextId) {
            if (tx.get("SELECT 1 FROM lifecycle.withdrawals WHERE kind='native_context' AND id=?", intent.contextId)) intent.mode = "delete";
            const row = tx.get<{ record_json: string }>("SELECT record_json FROM memory_contexts WHERE id=?", intent.contextId);
            if (!row || !this.app.memory.current(tx, JSON.parse(row.record_json))) intent.mode = "delete";
          }
          if (intent.attemptId) {
            const retained = tx.get("SELECT id FROM work_attempts WHERE id=?", intent.attemptId);
            if (!retained || !this.app.memory.attemptCurrent(tx, intent.attemptId)) intent.mode = "delete";
            if (!retained && intent.grantId) {
              tx.run("INSERT OR IGNORE INTO lifecycle.withdrawals VALUES ('uncertain_grant',?,'checkpoint_missing')", intent.grantId);
              if (intent.workId && tx.get("SELECT id FROM work_items WHERE id=?", intent.workId)) {
                const work = record<Work>(tx, "work_items", intent.workId);
                work.state = "blocked"; work.reason = "native_checkpoint_missing"; work.revision++;
                save(tx, "work_items", work);
              }
            }
          }
          this.saveIntent(tx, intent);
          return intent;
        });
      });
      for (const intent of intents) await this.discover(port, intent);
      this.app.store.transaction(tx => {
        const native = this.intents(tx);
        for (const checkpoint of this.checkpoints(tx)) {
          if (["resumed", "finished"].includes(checkpoint.state)) continue;
          const attempt = record<Attempt>(tx, "work_attempts", checkpoint.id);
          const owned = native.filter(i => i.attemptId === attempt.id);
          if (owned.some(intent => intent.state === "unresolved")) checkpoint.transport = "unknown";
          else if (checkpoint.transport === "not_started" || owned.length && owned.every(i => ["retired", "deleted", "not_created"].includes(i.state))) checkpoint.transport = "settled";
          const reason = this.reason(tx, checkpoint, attempt);
          const result = tx.get<{ state: string }>("SELECT state FROM work_results WHERE attempt_id=?", attempt.id);
          checkpoint.reason = reason;
          checkpoint.state = reason ? "waiting" : result ? "committed" : "queued";
          if (checkpoint.transport === "settled") {
            tx.run("UPDATE attempt_transports SET active=0 WHERE attempt_id=?", attempt.id);
            attempt.state = result?.state === "ready" && !reason ? "committed" : "settled";
          }
          attempt.reason = reason; save(tx, "work_attempts", attempt);
          if (attempt.step) {
            const step = record<WorkStep>(tx, "work_steps", attempt.step.id);
            if (step.attemptId === attempt.id || checkpoint.state === "waiting" && step.attemptId === null && step.state === "queued") {
              step.state = reason ? "blocked" : result?.state === "ready" ? "committed" : result ? "blocked" : "queued";
              step.reason = reason ?? (result?.state === "waiting" ? "handler_waiting" : checkpoint.state === "queued" ? "replay_safe_requeued" : null);
              step.settledAt = checkpoint.transport === "settled" ? this.app.now() : null;
              if (checkpoint.state === "queued") step.attemptId = null;
              step.revision++; save(tx, "work_steps", step);
            }
          }
          const work = record<Work>(tx, "work_items", attempt.workId);
          if (!["stopped", "stopping"].includes(work.state)) {
            work.state = reason ? "blocked" : result?.state === "ready" ? "ready" : result ? "waiting" : "queued";
            work.reason = reason; work.revision++; save(tx, "work_items", work);
          } else if (work.state === "stopping" && !tx.get("SELECT 1 FROM work_attempts WHERE work_id=? AND (json_extract(record_json,'$.state') IN ('running','interrupted') OR EXISTS (SELECT 1 FROM attempt_transports WHERE attempt_id=work_attempts.id AND active=1))", work.id)) {
            work.state = "stopped"; work.revision++; save(tx, "work_items", work);
          }
          this.saveCheckpoint(tx, checkpoint);
        }
        for (const workId of new Set(this.checkpoints(tx).map(c => c.workId))) {
          const work = record<Work>(tx, "work_items", workId);
          if (["stopped", "stopping"].includes(work.state)) continue;
          const steps = this.app.graph.steps(tx, workId);
          if (tx.get("SELECT 1 FROM effects WHERE work_id=? AND json_extract(record_json,'$.state')='unknown'", workId)) {
            work.state = "waiting";
            work.reason = "unknown_effect_reconcile_only";
          } else if (steps.some(step => ["queued", "waiting_evidence"].includes(step.state))) {
            work.state = "queued";
            work.reason = "replay_safe_requeued";
          }
          else if (steps.some(step => step.state === "committed")) work.state = "ready";
          if (work.state === "ready" && steps.some(step => step.state !== "committed")) work.reason = "partial_graph_evidence";
          save(tx, "work_items", work);
        }
      });
      this.app.store.transaction(tx => this.app.botLifecycle.reconcile(tx));
      this.#bootComplete = true;
    } finally { this.#booting = false; }
  }

  /** Returns owner-only checkpoint/native metadata; inspection never starts a model, tool or lifecycle operation. */
  view(actor: OwnerActor): RecoveryView {
    return this.app.store.read(tx => { this.app.requireOwner(tx, actor); return { bootedAt: this.bootedAt, checkpoints: this.checkpoints(tx), native: this.intents(tx), actualUsage: null }; });
  }
}
