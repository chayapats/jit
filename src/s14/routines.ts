import { AppError } from "../errors";
import { dueRange, nextScheduledInstant, normalizeSummaryOutcome, validTimezone } from "../jobs/schedules";
import { containsCredential } from "../security/credentials";
import type { AppTransaction } from "../store";
import { record, save, type S14Application } from "./application";
import { validateWorkLimits } from "./authority";
import type { Attempt, StartWorkCommand, Work, WorkGrant, WorkOutput } from "./authority-types";
import { defaultWorkGraph } from "./graph";
import type { WorkGraph } from "./graph-types";
import { evidenceRequirements } from "./reports";
import type { EnableRoutineCommand, Routine, RoutineAttentionSummary, RoutineCommand, RoutineOccurrence, RoutineReceipt, RoutineView } from "./routine-types";
import type { Bot, OwnerActor } from "./types";
import { canonical, digest, exact, identity, integer, text } from "./validation";

const id = () => crypto.randomUUID().replaceAll("-", "");
const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const load = (tx: AppTransaction, key: string): Routine => {
  const row = tx.get<{ record_json: string }>("SELECT record_json FROM routines WHERE id=?", key);
  if (!row) throw new AppError("not_found", 404);
  return JSON.parse(row.record_json);
};
const storeRoutine = (tx: AppTransaction, routine: Routine) => tx.run("UPDATE routines SET record_json=? WHERE id=?", canonical(routine), routine.id);
const storeOccurrence = (tx: AppTransaction, occurrence: RoutineOccurrence) => tx.run("UPDATE routine_occurrences SET work_id=?,record_json=? WHERE id=?", occurrence.workId, canonical(occurrence), occurrence.id);

/** Captured standing authority over the ordinary bounded work graph, without a Project or source-authored commands. */
export class S14Routines {
  constructor(readonly app: S14Application) {}

  private all(tx: AppTransaction): Routine[] {
    return tx.all<{ record_json: string }>("SELECT record_json FROM routines ORDER BY rowid").map(row => JSON.parse(row.record_json));
  }

  private occurrences(tx: AppTransaction, key: string): RoutineOccurrence[] {
    return tx.all<{ record_json: string }>("SELECT record_json FROM routine_occurrences WHERE routine_id=? ORDER BY rowid DESC", key).map(row => JSON.parse(row.record_json));
  }

  private capture(tx: AppTransaction, command: EnableRoutineCommand): Routine["capture"] {
    const p = command.payload;
    exact(p, ["conversationId", "title", "purpose", "completionRule", "bots", "tools", "scopes", "limits", "timezone", "recurrence", "misfire", "occurrenceBudget", "endsAt", ...(Object.hasOwn(p, "requiredEvidence") ? ["requiredEvidence"] : [])]);
    identity(p.conversationId);
    for (const value of [p.title, p.purpose, p.completionRule]) {
      text(value);
      if (containsCredential(value)) throw new AppError("credential_content_refused", 403);
    }
    text(p.title, 200);
    text(p.completionRule, 4000);
    validateWorkLimits(p.limits);
    integer(p.occurrenceBudget, 1, 1000);
    integer(p.endsAt, this.app.now() + 1, this.app.now() + 366 * 86400000);
    if (!validTimezone(p.timezone) || p.misfire !== "coalesce") throw new AppError("invalid_routine_schedule");
    const r = p.recurrence;
    exact(r, ["kind", r?.kind === "once" ? "at" : r?.kind === "interval" ? "everyMs" : "time"]);
    if (r.kind === "once") integer(r.at, this.app.now() + 1, p.endsAt);
    else if (r.kind === "interval") integer(r.everyMs, 60000, 2592000000);
    else if (r.kind !== "daily" || typeof r.time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(r.time)) throw new AppError("invalid_routine_schedule");
    if (p.requiredEvidence) evidenceRequirements(p.requiredEvidence);
    if (!Array.isArray(p.bots) || !p.bots.length || p.bots.length > 8 || new Set(p.bots.map(b => b.id)).size !== p.bots.length) throw new AppError("invalid_bots");
    const bots = p.bots.map(ref => {
      exact(ref, ["id", "revision"]);
      identity(ref.id);
      const bot = record<Bot>(tx, "bots", ref.id);
      if (!bot.enabled || bot.revision !== ref.revision) throw new AppError("bot_authority_changed", 403);
      return bot;
    });
    if (!Array.isArray(p.tools) || new Set(p.tools).size !== p.tools.length || p.tools.length > 64) throw new AppError("invalid_list");
    for (const tool of p.tools) {
      identity(tool);
      if (!this.app.policy.tools.includes(tool) || !bots.some(bot => bot.capabilities.tools.includes(tool))) throw new AppError("bot_ceiling", 403);
    }
    if (!Array.isArray(p.scopes) || p.scopes.length > 64 || new Set(p.scopes.map(s => `${s.kind}:${s.id}`)).size !== p.scopes.length) throw new AppError("invalid_scope");
    const scopes = p.scopes.map(ref => {
      const scope = this.app.authority.scopePolicy(tx, ref);
      if (scope.workId !== null || !bots.some(bot => bot.capabilities.resources.includes(ref.id) &&
          (ref.kind === "share" ? scope.receiverBotId === bot.id : scope.ownerBotId === bot.id))) throw new AppError("scope_not_allowed", 403);
      return scope;
    });
    const capture = { command: structuredClone(command), ownerGeneration: tx.get<{ generation: number }>("SELECT generation FROM owner")!.generation,
      bots, routes: bots.map(bot => this.app.route(bot.routeId)), scopes };
    // Validate the same default graph and finite per-run budget now, before accepting standing authority.
    const start = this.startCommand({ id: "preview", capture } as Routine, this.app.now());
    defaultWorkGraph({ id: "preview", workId: "preview", revision: 1, generation: 1, ownerGeneration: capture.ownerGeneration,
      requestId: command.requestId, command: start, purpose: p.purpose, bots, routes: capture.routes, tools: p.tools, scopes,
      limits: p.limits, createdAt: this.app.now(), expiresAt: start.payload.expiresAt });
    return capture;
  }

  private schedule(routine: Routine) {
    return { ...routine.capture.command.payload, cursor: routine.cursor, createdAt: routine.createdAt };
  }

  private live(tx: AppTransaction, routine: Routine): void {
    if (!["active", "exhausted"].includes(routine.state) || routine.capture.command.payload.endsAt <= this.app.now()) throw new AppError("routine_fenced", 403);
    if (tx.get<{ generation: number }>("SELECT generation FROM owner")?.generation !== routine.capture.ownerGeneration) throw new AppError("owner_authority_changed", 403);
    for (const bot of routine.capture.bots) if (!bot.enabled || !equal(record<Bot>(tx, "bots", bot.id), bot) || !equal(this.app.route(bot.routeId), routine.capture.routes.find(r => r.id === bot.routeId))) throw new AppError("bot_authority_changed", 403);
    for (const scope of routine.capture.scopes) if (!equal(this.app.authority.scopePolicy(tx, scope.ref), scope)) throw new AppError("scope_revoked_or_stale", 403);
  }

  /** Applies exact standing enable/pause/resume/revoke commands inside the authenticated receipt transaction. */
  apply(tx: AppTransaction, command: RoutineCommand): RoutineReceipt {
    if (command.kind === "routine.enable") {
      const conversation = this.app.readConversation(tx, command.payload.conversationId);
      if (conversation.revision !== command.expectedRevision) throw new AppError("stale_revision", 409);
      if (tx.get<{ n: number }>("SELECT count(*) n FROM routines")!.n >= 128) throw new AppError("routine_capacity", 409);
      const routine: Routine = { id: id(), revision: 1, generation: 1, state: "active", reason: null,
        capture: this.capture(tx, command), occurrencesRemaining: command.payload.occurrenceBudget,
        cursor: { lastInstant: null, lastRevision: null }, createdAt: this.app.now() };
      if (!nextScheduledInstant(this.schedule(routine), this.app.now())) throw new AppError("invalid_routine_schedule");
      tx.run("INSERT INTO routines VALUES (?,?)", routine.id, canonical(routine));
      tx.run("UPDATE conversations SET revision=revision+1 WHERE id=?", conversation.id);
      return { kind: command.kind, requestId: command.requestId, routine };
    }
    exact(command.payload, ["routineId"]);
    identity(command.payload.routineId);
    const routine = load(tx, command.payload.routineId);
    if (routine.revision !== command.expectedRevision || routine.state === "revoked") throw new AppError("stale_revision", 409);
    if (command.kind === "routine.resume") {
      if (routine.state !== "paused" || routine.occurrencesRemaining < 1) throw new AppError("routine_not_paused", 409);
      this.live(tx, { ...routine, state: "active" });
      routine.state = "active";
      // Pause time never becomes catch-up authority, including interval and DST schedules.
      routine.cursor.lastInstant = this.app.now();
    } else {
      this.fence(tx, routine, command.kind === "routine.pause" ? "paused" : "revoked", "owner_routine_control");
    }
    routine.generation++;
    routine.revision++;
    tx.run("INSERT OR IGNORE INTO lifecycle.withdrawals VALUES ('routine',?,?)", routine.id, `through_generation_${routine.generation - 1}`);
    storeRoutine(tx, routine);
    return { kind: command.kind, requestId: command.requestId, routine };
  }

  private startCommand(routine: Routine, now: number): StartWorkCommand {
    const { timezone: _timezone, recurrence: _recurrence, misfire: _misfire, occurrenceBudget: _budget, endsAt, ...scope } = routine.capture.command.payload;
    return { kind: "work.start", requestId: `routine_${routine.id}_${now}`, expectedRevision: 0,
      payload: { ...scope, task: null, expiresAt: Math.min(now + scope.limits.wallMs, endsAt) } };
  }

  /** Rechecks captured generation at admission, tool/input and publication barriers without granting anything new. */
  guard(tx: AppTransaction, workId: string): void {
    const row = tx.get<{ record_json: string }>("SELECT record_json FROM routine_occurrences WHERE work_id=?", workId);
    if (!row) return;
    const occurrence = JSON.parse(row.record_json) as RoutineOccurrence, routine = load(tx, occurrence.routineId);
    if (routine.generation !== occurrence.generation) throw new AppError("routine_fenced", 403);
    this.live(tx, routine);
  }

  /** Advances bounded coalesced schedule cursors and atomically admits only exact captured work through the normal graph. */
  tick(): void {
    if ((this.app.recovery.booting || this.app.backups.busy)) return;
    this.app.store.transaction(tx => {
      this.reconcile(tx);
      for (const routine of this.all(tx)) {
        if (routine.state !== "active") continue;
        if (this.occurrences(tx, routine.id).some(o => o.state === "running")) continue;
        if (routine.capture.command.payload.endsAt <= this.app.now()) {
          this.fence(tx, routine, "blocked", "routine_expired");
          continue;
        }
        const range = dueRange(this.schedule(routine), Math.min(this.app.now(), routine.capture.command.payload.endsAt));
        if (!range) continue;
        const occurrence: RoutineOccurrence = { id: digest(`${routine.id}:${routine.generation}:${range.last}`), routineId: routine.id,
          generation: routine.generation, scheduledInstant: range.last, missed: range.count > 1 ? { from: range.first, to: range.last, count: range.count - 1 } : null,
          resolution: range.resolution, workId: null, state: "running", outcome: null, reason: null, proposals: [], createdAt: this.app.now() };
        if (tx.get("SELECT 1 FROM lifecycle.withdrawals WHERE kind='routine_occurrence' AND id=?", occurrence.id)) {
          this.fence(tx, routine, "blocked", "restored_occurrence_requires_review");
          continue;
        }
        tx.run("INSERT INTO routine_occurrences VALUES (?,?,NULL,?)", occurrence.id, routine.id, canonical(occurrence));
        tx.run("INSERT INTO lifecycle.withdrawals VALUES ('routine_occurrence',?,'consumed')", occurrence.id);
        try {
          this.app.store.transaction(() => {
            this.live(tx, routine);
            const command = this.startCommand(routine, this.app.now());
            command.expectedRevision = this.app.readConversation(tx, command.payload.conversationId).revision;
            const result = this.app.authority.apply(tx, command), grant = result.grant!;
            if (!equal(grant.bots, routine.capture.bots) || !equal(grant.scopes, routine.capture.scopes) || !equal(grant.routes, routine.capture.routes) || grant.ownerGeneration !== routine.capture.ownerGeneration) throw new AppError("routine_capture_changed", 403);
            occurrence.workId = result.work!.id;
            const graph = record<WorkGraph>(tx, "work_graphs", occurrence.workId);
            graph.priority = "background";
            save(tx, "work_graphs", graph);
          });
        } catch (error) {
          occurrence.workId = null;
          occurrence.state = "failed";
          occurrence.outcome = "failed";
          occurrence.reason = error instanceof AppError ? error.code : "routine_not_admitted";
          routine.state = "blocked";
          routine.reason = occurrence.reason;
        }
        tx.run(`INSERT INTO lifecycle.routine_usage VALUES (?,1,?) ON CONFLICT(routine_id)
          DO UPDATE SET consumed=consumed+1,last_instant=max(last_instant,excluded.last_instant)`, routine.id, range.last);
        routine.occurrencesRemaining--;
        routine.cursor = { lastInstant: range.last, lastRevision: routine.revision };
        const next = nextScheduledInstant(this.schedule(routine), range.last);
        if (routine.state === "active" && (routine.occurrencesRemaining === 0 || !next || next.utc > routine.capture.command.payload.endsAt)) routine.state = "exhausted";
        storeRoutine(tx, routine);
        storeOccurrence(tx, occurrence);
        this.notify(tx, occurrence);
      }
    });
    this.app.authority.cancelFenced();
  }

  /** Records untrusted typed quiet outcomes and bounded out-of-scope proposals atomically with fenced result evidence. */
  result(tx: AppTransaction, attempt: Attempt, output: WorkOutput): void {
    const row = tx.get<{ record_json: string }>("SELECT record_json FROM routine_occurrences WHERE work_id=?", attempt.workId);
    if (!row) return;
    this.guard(tx, attempt.workId);
    const occurrence = JSON.parse(row.record_json) as RoutineOccurrence;
    const outcome = normalizeSummaryOutcome(output.text);
    const proposals: string[] = [];
    let suggested = output.proposals;
    if (suggested === undefined) {
      try { suggested = JSON.parse(output.text)?.proposals; } catch { /* Prose is a report. */ }
    }
    if (suggested !== undefined) {
      if (!Array.isArray(suggested) || suggested.length > 8) throw new AppError("invalid_routine_proposals");
      for (const data of suggested) {
        exact(data, ["title", "purpose", "completionRule"]);
        for (const value of Object.values(data)) if (typeof value !== "string" || containsCredential(value)) throw new AppError("invalid_routine_proposals");
        const work: Work = { id: id(), revision: 1, conversationId: attempt.snapshot.grant.command.payload.conversationId,
          sourceMessageId: null, source: { id: `result_${attempt.id}`, revision: 1, generation: 1 },
          title: text(data.title, 200), purpose: text(data.purpose), completionRule: text(data.completionRule, 4000),
          state: "proposed", reason: "routine_out_of_scope", grantId: null, result: null, createdAt: this.app.now() };
        tx.run("INSERT INTO work_items VALUES (?,?,?)", work.id, work.conversationId, canonical(work));
        proposals.push(work.id);
      }
    }
    tx.run("INSERT INTO routine_results VALUES (?,?,?)", attempt.id, occurrence.id, canonical({ kind: outcome.kind,
      reason: outcome.kind === "failed" ? outcome.reason : null, waiting: output.state === "waiting" }));
    occurrence.proposals.push(...proposals);
    if (proposals.length || output.state === "waiting") {
      occurrence.outcome = "needs_owner";
      this.notify(tx, occurrence);
    }
    storeOccurrence(tx, occurrence);
  }

  private notify(tx: AppTransaction, occurrence: RoutineOccurrence): void {
    if (!occurrence.outcome || occurrence.outcome === "no_update") return;
    this.app.attention.commit(tx, { groupId: occurrence.id, class: "needs_owner",
      reason: occurrence.outcome === "failed" || occurrence.state === "stopped" ? "routine_failed" : occurrence.outcome === "needs_owner" ? "owner_decision" : "routine_report",
      workId: occurrence.workId, proposalIds: occurrence.proposals });
  }

  private fence(tx: AppTransaction, routine: Routine, state: Routine["state"], reason: string): void {
    routine.state = state;
    routine.reason = reason;
    storeRoutine(tx, routine);
    for (const occurrence of this.occurrences(tx, routine.id)) if (occurrence.state === "running") {
      if (occurrence.workId) {
        const work = record<Work>(tx, "work_items", occurrence.workId);
        if (work.grantId && !["stopped", "stopping"].includes(work.state)) this.app.authority.apply(tx, {
          kind: "work.stop", requestId: `fence_${occurrence.id}`, expectedRevision: work.revision, payload: { workId: work.id } });
      }
      occurrence.state = "stopped";
      occurrence.outcome = "failed";
      occurrence.reason = reason;
      storeOccurrence(tx, occurrence);
      this.notify(tx, occurrence);
    }
  }

  /** Disables captured dispatch for a changed Bot without widening or rebuilding any standing instruction. */
  fenceBot(tx: AppTransaction, botId: string): void {
    for (const routine of this.all(tx)) if (routine.capture.bots.some(b => b.id === botId) && routine.state !== "revoked") {
      tx.run("INSERT OR IGNORE INTO lifecycle.withdrawals VALUES ('routine',?,?)", routine.id, `through_generation_${routine.generation}`);
      this.fence(tx, routine, "blocked", "bot_authority_changed");
    }
  }

  /** Reconciles independent fences and settled graph outcomes without interpreting prose as authority or quietness. */
  reconcile(tx: AppTransaction): void {
    for (const routine of this.all(tx)) {
      const usage = tx.get<{ consumed: number; last_instant: number }>("SELECT consumed,last_instant FROM lifecycle.routine_usage WHERE routine_id=?", routine.id);
      if (usage) {
        routine.occurrencesRemaining = Math.min(routine.occurrencesRemaining, Math.max(0, routine.capture.command.payload.occurrenceBudget - usage.consumed));
        const retained = tx.get<{ n: number }>("SELECT count(*) n FROM routine_occurrences WHERE routine_id=?", routine.id)!.n;
        if (retained < usage.consumed) this.fence(tx, routine, "blocked", "restored_occurrence_requires_review");
        storeRoutine(tx, routine);
      }
      const withdrawn = tx.all<{ mode: string }>("SELECT mode FROM lifecycle.withdrawals WHERE kind='routine' AND id=?", routine.id)
        .some(row => Number(/^through_generation_([0-9]+)$/.exec(row.mode)?.[1]) >= routine.generation);
      if (withdrawn && routine.state !== "revoked") this.fence(tx, routine, "blocked", "routine_generation_withdrawn");
      for (const occurrence of this.occurrences(tx, routine.id)) {
        if (occurrence.state !== "running" || !occurrence.workId) continue;
        const work = record<Work>(tx, "work_items", occurrence.workId);
        if (["queued", "running", "stopping"].includes(work.state)) continue;
        const steps = this.app.graph.steps(tx, work.id);
        if (steps.some(s => ["running", "stopping"].includes(s.state))) continue;
        const results = tx.all<{ record_json: string }>("SELECT record_json FROM routine_results WHERE occurrence_id=?", occurrence.id)
          .map(row => JSON.parse(row.record_json) as { kind: string; reason: string | null; waiting: boolean });
        const readFailure = !!tx.get("SELECT 1 FROM web_reads WHERE json_extract(record_json,'$.workId')=? AND json_extract(record_json,'$.outcome')<>'success'", work.id);
        const needsOwner = occurrence.proposals.length > 0 || work.state === "waiting" || results.some(r => r.waiting);
        const reportMissing = !needsOwner && results.some(r => r.kind === "report") && !tx.all<{ id: string }>("SELECT id FROM reports WHERE work_id=? AND content_json IS NOT NULL", work.id)
          .some(row => this.app.reports.read(tx, row.id).state === "available");
        const failed = readFailure || reportMissing || ["blocked", "stopped"].includes(work.state) || steps.some(s => s.state !== "committed" && !(s.state === "blocked" && s.reason === "handler_waiting")) || results.some(r => r.kind === "failed") || !results.length;
        occurrence.outcome = failed ? "failed" : needsOwner ? "needs_owner" : results.every(r => r.kind === "no_update") ? "no_update" : "report";
        occurrence.state = work.state === "stopped" ? "stopped" : failed ? "failed" : "complete";
        occurrence.reason = failed ? results.find(r => r.kind === "failed")?.reason ?? work.reason ?? (reportMissing ? "routine_report_missing" : "routine_failed") : null;
        storeOccurrence(tx, occurrence);
        this.notify(tx, occurrence);
      }
    }
    this.app.attention.resolve(tx);
  }

  /** Returns at most 128 grouped summaries; open decisions and delivery failures are selected across all history in SQL. */
  attention(actor: OwnerActor): RoutineAttentionSummary[] {
    return this.app.store.read(tx => {
      this.app.requireOwner(tx, actor);
      return tx.all<{ record_json: string }>("SELECT record_json FROM routines ORDER BY rowid LIMIT 128").map(row => {
        const routine = JSON.parse(row.record_json) as Routine;
        const decisions = tx.get<{ count: number; at: number | null }>(`SELECT count(DISTINCT id) AS count,max(at) AS at FROM (
          SELECT w.id,json_extract(o.record_json,'$.createdAt') AS at FROM routine_occurrences o
          JOIN json_each(o.record_json,'$.proposals') p JOIN work_items w ON w.id=p.value
          WHERE o.routine_id=? AND json_extract(w.record_json,'$.state')='proposed'
          UNION ALL
          SELECT w.id,json_extract(o.record_json,'$.createdAt') AS at FROM routine_occurrences o
          JOIN work_items w ON w.id=o.work_id
          WHERE o.routine_id=? AND json_extract(w.record_json,'$.state')='waiting'
        )`, routine.id, routine.id)!;
        const settled = tx.get<{ record_json: string }>("SELECT record_json FROM routine_occurrences WHERE routine_id=? AND json_extract(record_json,'$.state')<>'running' ORDER BY rowid DESC LIMIT 1", routine.id);
        const report = tx.get<{ record_json: string }>(`SELECT o.record_json FROM routine_occurrences o
          WHERE o.routine_id=? AND json_extract(o.record_json,'$.outcome')='report'
          AND EXISTS (SELECT 1 FROM attention_notices n WHERE n.group_id=o.id) ORDER BY o.rowid DESC LIMIT 1`, routine.id);
        const delivery = tx.get<{ severity: number | null }>(`SELECT max(CASE
          WHEN json_extract(n.record_json,'$.state')='unknown' OR json_extract(n.record_json,'$.remote')='uncertain' THEN 2
          WHEN json_extract(n.record_json,'$.state')='failed' THEN 1 ELSE 0 END) AS severity
          FROM attention_notices n JOIN routine_occurrences o ON o.id=n.group_id WHERE o.routine_id=?`, routine.id)!.severity;
        return { routine, decisions, settled: settled ? JSON.parse(settled.record_json) : null,
          report: report ? JSON.parse(report.record_json) : null, delivery: delivery === 2 ? "unknown" : delivery === 1 ? "failed" : null };
      });
    });
  }

  /** Returns owner-only standing captures and complete quiet/failure history without running a tick. */
  view(actor: OwnerActor, routineId: string): RoutineView {
    identity(routineId);
    return this.app.store.read(tx => {
      this.app.requireOwner(tx, actor);
      const routine = load(tx, routineId);
      const next = routine.state === "active" && routine.occurrencesRemaining > 0 ? nextScheduledInstant(this.schedule(routine), this.app.now()) : null;
      return { routine, nextRun: next && next.utc <= routine.capture.command.payload.endsAt ? next.utc : null, history: this.occurrences(tx, routineId) };
    });
  }

  /** Lists bounded standing captures; inspection alone does not grant or schedule work. */
  list(actor: OwnerActor): RoutineView[] {
    return this.app.store.read(tx => {
      this.app.requireOwner(tx, actor);
      return this.all(tx).map(r => this.view(actor, r.id));
    });
  }
}
