import { AppError } from "../errors";
import type { AppTransaction } from "../store";
import { record, save, type S14Application } from "./application";
import type { Attempt, Work, WorkGrant } from "./authority-types";
import type { BotLifecycle, BotLifecycleCommand, BotLifecycleOptions, BotLifecyclePreview, BotLifecycleReceipt, CapabilityProposal } from "./bot-lifecycle-types";
import type { BotComputer } from "./computer-types";
import type { MemoryShare } from "./memory-types";
import type { NativeIntent, NativeRecoveryPort } from "./recovery-types";
import type { Routine } from "./routine-types";
import type { SnapshotShare } from "./sharing-types";
import type { Bot, OwnerActor } from "./types";
import { canonical, capabilities, digest, exact, identity } from "./validation";
import { eraseBotPayloads } from "./bot-payloads";

const id = () => crypto.randomUUID().replaceAll("-", "");
function rows<T>(tx: AppTransaction, table: "bots" | "work_grants" | "work_items" | "memory_shares" | "snapshot_shares" | "native_intents" | "bot_lifecycle"): T[] {
  return tx.all<{ record_json: string }>(`SELECT record_json FROM ${table} ORDER BY rowid`).map(row => JSON.parse(row.record_json));
}

/** Exact owner Bot policy/lifecycle authority, independent durable withdrawal facts and retry-safe cleanup. */
export class S14BotLifecycle {
  #draining: Promise<void> | null = null;
  constructor(readonly app: S14Application, readonly options: BotLifecycleOptions = {}) {}

  private lifecycle(tx: AppTransaction, bot: Bot): BotLifecycle {
    const row = tx.get<{ record_json: string }>("SELECT record_json FROM bot_lifecycle WHERE bot_id=?", bot.id);
    return row ? JSON.parse(row.record_json) : { botId: bot.id, generation: bot.generation, state: bot.enabled ? "active" : "retired",
      target: bot.enabled ? "active" : "retired", stage: "complete", reason: null };
  }

  private save(tx: AppTransaction, lifecycle: BotLifecycle): void {
    tx.run("INSERT INTO bot_lifecycle VALUES (?,?) ON CONFLICT(bot_id) DO UPDATE SET record_json=excluded.record_json", lifecycle.botId, canonical(lifecycle));
  }

  /** Returns current Bot/transition/proposals without starting cleanup, a model or a computer. */
  view(actor: OwnerActor, botId: string): { bot: Bot; lifecycle: BotLifecycle; proposals: CapabilityProposal[] } {
    identity(botId);
    return this.app.store.read(tx => {
      this.app.requireOwner(tx, actor);
      const bot = record<Bot>(tx, "bots", botId);
      return { bot, lifecycle: this.lifecycle(tx, bot), proposals: tx.all<{ record_json: string }>("SELECT record_json FROM capability_proposals WHERE bot_id=? ORDER BY rowid DESC LIMIT 100", botId).map(row => JSON.parse(row.record_json)) };
    });
  }

  private native(tx: AppTransaction, botId: string, derived: string[] = []): NativeIntent[] {
    const contexts = new Set([...derived, ...tx.all<{ id: string }>("SELECT id FROM memory_contexts WHERE bot_id=?", botId).map(row => row.id)]);
    const intents = new Map(rows<NativeIntent>(tx, "native_intents").map(intent => [intent.id, intent]));
    for (const row of tx.all<{ record_json: string }>("SELECT record_json FROM lifecycle.native_intents ORDER BY rowid")) {
      const intent = JSON.parse(row.record_json) as NativeIntent;
      if (!intents.has(intent.id)) intents.set(intent.id, intent);
    }
    const grants = new Set(rows<WorkGrant>(tx, "work_grants").filter(grant => grant.bots.some(bot => bot.id === botId)).map(grant => grant.id));
    return [...intents.values()].filter(intent => intent.botId === botId || intent.contextId !== null && contexts.has(intent.contextId) || intent.grantId !== null && grants.has(intent.grantId));
  }

  private impact(tx: AppTransaction, botId: string, action: "retire" | "delete"): BotLifecyclePreview {
    const bot = record<Bot>(tx, "bots", botId), data = this.app.memory.botImpact(tx, botId);
    const sourceIds = new Set(data.sources.map(s => s.id)), claimIds = new Set(data.claims.map(c => c.id));
    const memory = rows<MemoryShare>(tx, "memory_shares").filter(share => share.receiverBotId === botId || claimIds.has(share.claim.id));
    const snapshots = rows<SnapshotShare>(tx, "snapshot_shares").filter(share => share.ownerBotId === botId || share.receiverBotId === botId || sourceIds.has(share.source.id));
    const row = tx.get<{ record_json: string }>("SELECT record_json FROM bot_computers WHERE bot_id=?", botId);
    const computer = row ? JSON.parse(row.record_json) as BotComputer : null;
    const workIds = new Set(rows<WorkGrant>(tx, "work_grants").filter(grant => grant.bots.some(b => b.id === botId)).map(grant => grant.workId));
    const scopedIds = new Set([botId, ...data.sources.map(s => s.id), ...data.claims.map(c => c.id), ...data.contexts,
      ...memory.map(s => s.id), ...snapshots.map(s => s.id), ...(computer ? [computer.id] : [])]);
    const value: Omit<BotLifecyclePreview, "hash"> = { bot, lifecycle: this.lifecycle(tx, bot), action,
      retain: { history: action === "retire", evidence: action === "retire" }, data,
      conversations: tx.all<{ id: string; revision: number }>("SELECT id,revision FROM conversations WHERE bot_id=? ORDER BY id", botId),
      work: rows<Work>(tx, "work_items").filter(work => workIds.has(work.id)).map(work => ({ id: work.id, revision: work.revision })),
      shares: [...memory.map(share => ({ id: share.id, revision: share.revision, kind: "memory" as const })), ...snapshots.map(share => ({ id: share.id, revision: share.revision, kind: "snapshot" as const }))],
      computer: computer ? { id: computer.id, revision: computer.revision, generation: computer.generation, workspaceId: computer.workspaceId, profileId: computer.profileId } : null,
      native: this.native(tx, botId, action === "delete" ? data.contexts : []).map(intent => ({ id: intent.id, state: intent.state, mode: intent.mode,
        cleanup: intent.mode === "delete" || action === "delete" && (intent.botId === botId || intent.contextId !== null && data.contexts.includes(intent.contextId)) ? "delete" : "retire" })),
      routines: tx.all<{ record_json: string }>("SELECT record_json FROM routines ORDER BY rowid").map(row => JSON.parse(row.record_json) as Routine)
        .filter(routine => routine.capture.bots.some(b => b.id === botId))
        .map(routine => ({ id: routine.id, revision: routine.revision, generation: routine.generation, state: routine.state })),
      withdrawals: tx.all<{ kind: string; id: string; mode: string }>("SELECT kind,id,mode FROM lifecycle.withdrawals ORDER BY kind,id,mode").filter(row => scopedIds.has(row.id)),
      personal: this.app.personal.impact(tx, botId),
      retainedEffects: tx.all<{ id: string; record_json: string; attempt_json: string }>("SELECT e.id,e.record_json,a.record_json AS attempt_json FROM effects e JOIN work_attempts a ON a.id=e.attempt_id ORDER BY e.id")
        .filter(row => JSON.parse(row.record_json).botId === botId || data.contexts.includes(JSON.parse(row.attempt_json).memoryId)).map(row => {
        const effect = JSON.parse(row.record_json);
        return { id: row.id, revision: effect.revision, actionHash: effect.actionHash, state: effect.state };
      }),
      retainedLineage: "identity_hashes_and_independent_originals", disclosedKnowledge: "cannot_recall" };
    // Identity manifests may exceed a single record envelope; no body is persisted in the lifecycle ledger.
    return { ...value, hash: digest(JSON.stringify(value)) };
  }

  /** Produces the exact current lifecycle manifest/hash; a read itself never authorizes retirement or deletion. */
  preview(actor: OwnerActor, botId: string, action: "retire" | "delete"): BotLifecyclePreview {
    identity(botId);
    if (!["retire", "delete"].includes(action)) throw new AppError("invalid_lifecycle_action");
    return this.app.store.read(tx => { this.app.requireOwner(tx, actor); return this.impact(tx, botId, action); });
  }

  private proposal(tx: AppTransaction, proposalId: string): CapabilityProposal {
    const row = tx.get<{ record_json: string }>("SELECT record_json FROM capability_proposals WHERE id=?", proposalId);
    if (!row) throw new AppError("not_found", 404);
    return JSON.parse(row.record_json);
  }

  /** Applies exact owner proposals/acceptance/preview-bound retire/delete inside the shared receipt transaction. */
  apply(tx: AppTransaction, command: BotLifecycleCommand): BotLifecycleReceipt {
    const receipt = { kind: command.kind, requestId: command.requestId };
    if (command.kind === "bot.capabilities.propose" || command.kind === "bot.reenable.propose") {
      exact(command.payload, ["botId", "capabilities"]);
      identity(command.payload.botId);
      const bot = record<Bot>(tx, "bots", command.payload.botId), lifecycle = this.lifecycle(tx, bot);
      if (bot.revision !== command.expectedRevision) throw new AppError("stale_revision", 409);
      const action = command.kind === "bot.reenable.propose" ? "reenable" : "capabilities";
      if (action === "reenable" ? lifecycle.state !== "retired" : lifecycle.state !== "active") throw new AppError("bot_lifecycle_changed", 409);
      for (const row of tx.all<{ record_json: string }>("SELECT record_json FROM capability_proposals WHERE bot_id=? AND json_extract(record_json,'$.state')='proposed'", bot.id)) {
        const previous = JSON.parse(row.record_json) as CapabilityProposal;
        previous.state = "superseded";
        previous.revision++;
        tx.run("UPDATE capability_proposals SET record_json=? WHERE id=?", canonical(previous), previous.id);
      }
      const proposal: CapabilityProposal = { id: id(), revision: 1, botId: bot.id, botRevision: bot.revision, botGeneration: bot.generation, ownerGeneration: tx.get<{ generation: number }>("SELECT generation FROM owner")!.generation,
        action, capabilities: capabilities(command.payload.capabilities, this.app.policy), hash: "", state: "proposed" };
      proposal.hash = digest(canonical({ bot, action, capabilities: proposal.capabilities }));
      tx.run("INSERT INTO capability_proposals VALUES (?,?,?)", proposal.id, bot.id, canonical(proposal));
      return { ...receipt, proposal };
    }
    if (command.kind === "bot.capabilities.accept") {
      exact(command.payload, ["proposalId", "proposalHash"]);
      identity(command.payload.proposalId);
      const proposal = this.proposal(tx, command.payload.proposalId), bot = record<Bot>(tx, "bots", proposal.botId);
      const lifecycle = this.lifecycle(tx, bot);
      if (proposal.revision !== command.expectedRevision || proposal.state !== "proposed" || proposal.hash !== command.payload.proposalHash ||
          proposal.botRevision !== bot.revision || proposal.botGeneration !== bot.generation ||
          proposal.ownerGeneration !== tx.get<{ generation: number }>("SELECT generation FROM owner")?.generation ||
          proposal.hash !== digest(canonical({ bot, action: proposal.action, capabilities: proposal.capabilities }))) throw new AppError("stale_capability_proposal", 409);
      if (proposal.action === "reenable" ? lifecycle.state !== "retired" : lifecycle.state !== "active") throw new AppError("bot_lifecycle_changed", 409);
      // Changing a ceiling fences execution, not already committed owner evidence.
      // Capture retention before changing the Bot; withdrawn lineage is never blessed by widening.
      for (const row of tx.all<{ id: string }>("SELECT id FROM work_attempts WHERE json_extract(record_json,'$.snapshot.bot.id')=? AND EXISTS (SELECT 1 FROM work_results WHERE attempt_id=work_attempts.id)", bot.id)) {
        if (this.app.memory.sourceCurrent(tx, { id: `result_${row.id}`, revision: 1, generation: 1 })) {
          tx.run("INSERT OR IGNORE INTO lifecycle.withdrawals VALUES ('retained_evidence',?,'owner_retained')", row.id);
        }
      }
      bot.capabilities = capabilities(proposal.capabilities, this.app.policy);
      proposal.state = "accepted";
      tx.run("UPDATE capability_proposals SET record_json=? WHERE id=?", canonical(proposal), proposal.id);
      const next = this.transition(tx, bot, "active");
      return { ...receipt, bot, proposal, lifecycle: next };
    }
    if (command.kind !== "bot.retire" && command.kind !== "bot.delete") throw new AppError("unknown_command");
    exact(command.payload, command.kind === "bot.retire" ? ["botId", "previewHash", "retain"] : ["botId", "previewHash"]);
    identity(command.payload.botId);
    const bot = record<Bot>(tx, "bots", command.payload.botId), lifecycle = this.lifecycle(tx, bot);
    if (bot.id === "jit") throw new AppError("main_bot_required", 409);
    if (!["active", "retired"].includes(lifecycle.state)) throw new AppError("bot_lifecycle_changed", 409);
    const preview = this.impact(tx, bot.id, command.kind === "bot.delete" ? "delete" : "retire");
    if (bot.revision !== command.expectedRevision || preview.hash !== command.payload.previewHash) throw new AppError("stale_lifecycle_preview", 409);
    if (command.kind === "bot.retire") {
      exact(command.payload.retain, ["history", "evidence"]);
      if (command.payload.retain.history !== true || command.payload.retain.evidence !== true) throw new AppError("explicit_retention_required");
      if (lifecycle.state !== "active") throw new AppError("bot_lifecycle_changed", 409);
      // Retention is owner inspection only; packets remain retired and old authority remains revoked.
      for (const row of tx.all<{ id: string }>("SELECT id FROM work_attempts WHERE json_extract(record_json,'$.snapshot.bot.id')=? AND EXISTS (SELECT 1 FROM work_results WHERE attempt_id=work_attempts.id)", bot.id)) {
        tx.run("INSERT OR IGNORE INTO lifecycle.withdrawals VALUES ('retained_evidence',?,'owner_retained')", row.id);
      }
    }
    const next = this.transition(tx, bot, command.kind === "bot.delete" ? "deleted" : "retired");
    if (command.kind === "bot.delete") this.tombstoneData(tx, bot.id);
    return { ...receipt, bot, lifecycle: next };
  }

  private transition(tx: AppTransaction, bot: Bot, target: BotLifecycle["target"]): BotLifecycle {
    bot.generation++;
    bot.revision++;
    bot.enabled = false;
    save(tx, "bots", bot);
    tx.run("INSERT INTO lifecycle.bot_events VALUES (?,?,?,?,?)", bot.id, bot.generation, bot.revision, target, digest(canonical(bot.capabilities)));
    if (target === "deleted") tx.run("INSERT OR IGNORE INTO lifecycle.withdrawals VALUES ('bot',?,'deleted')", bot.id);
    const lifecycle: BotLifecycle = { botId: bot.id, generation: bot.generation, state: target === "deleted" ? "deleting" : "stopping",
      target, stage: "fenced", reason: null };
    this.save(tx, lifecycle);
    this.fence(tx, bot.id, target === "deleted");
    return lifecycle;
  }

  private fence(tx: AppTransaction, botId: string, destructive: boolean): void {
    for (const grant of rows<WorkGrant>(tx, "work_grants")) if (grant.bots.some(bot => bot.id === botId)) {
      const work = record<Work>(tx, "work_items", grant.workId);
      if (!["stopped", "stopping"].includes(work.state)) this.app.authority.apply(tx, {
        kind: "work.stop", requestId: `bot_fence_${grant.id}`, expectedRevision: work.revision, payload: { workId: work.id } });
    }
    this.app.routines.fenceBot(tx, botId);
    this.app.computers.fenceBot(tx, botId, destructive);
    this.app.memory.fence(tx);
  }

  /** Tests the independent explicit owner-retention fact without making an old context executable. */
  retained(tx: AppTransaction, attemptId: string | null | undefined): boolean {
    return !!attemptId && !!tx.get("SELECT 1 FROM lifecycle.withdrawals WHERE kind='retained_evidence' AND id=?", attemptId) &&
      this.app.memory.sourceCurrent(tx, { id: `result_${attemptId}`, revision: 1, generation: 1 });
  }

  private tombstoneData(tx: AppTransaction, botId: string): void {
    const impact = this.app.memory.botImpact(tx, botId);
    const contexts = new Set([...impact.contexts, ...tx.all<{ id: string }>("SELECT id FROM memory_contexts WHERE bot_id=?", botId).map(row => row.id)]);
    for (const contextId of contexts) {
      tx.run("INSERT OR IGNORE INTO lifecycle.withdrawals VALUES ('bot_context',?,?)", botId, contextId);
      tx.run("INSERT OR IGNORE INTO lifecycle.withdrawals VALUES ('native_context',?,'deleted')", contextId);
    }
    for (const [kind, refs] of [["source", impact.sources], ["claim", impact.claims]] as const) {
      for (const ref of refs) tx.run("INSERT OR IGNORE INTO lifecycle.withdrawals VALUES (?,?, 'deleted')", kind, ref.id);
    }
    const claims = new Set(impact.claims.map(c => c.id)), sources = new Set(impact.sources.map(s => s.id));
    for (const share of rows<MemoryShare>(tx, "memory_shares")) if (share.receiverBotId === botId || claims.has(share.claim.id)) {
      tx.run("INSERT OR IGNORE INTO lifecycle.withdrawals VALUES ('share',?,?)", share.id, `revision_${share.revision}`);
    }
    for (const share of rows<SnapshotShare>(tx, "snapshot_shares")) if (share.receiverBotId === botId || share.ownerBotId === botId || sources.has(share.source.id)) {
      tx.run("INSERT OR IGNORE INTO lifecycle.withdrawals VALUES ('snapshot_share',?,'revoked')", share.id);
    }
  }

  /** Applies current independent Bot identity facts before restored data or workers can regain withdrawn authority. */
  reconcile(tx: AppTransaction): void {
    for (const bot of rows<Bot>(tx, "bots")) {
      const event = tx.get<{ generation: number; revision: number; target: BotLifecycle["target"] }>("SELECT generation,revision,target FROM lifecycle.bot_events WHERE bot_id=? ORDER BY generation DESC LIMIT 1", bot.id);
      const deleted = !!tx.get("SELECT 1 FROM lifecycle.withdrawals WHERE kind='bot' AND id=? AND mode='deleted'", bot.id);
      if (event && (bot.generation < event.generation || deleted && this.lifecycle(tx, bot).target !== "deleted")) {
        bot.generation = Math.max(bot.generation, event.generation);
        bot.revision = Math.max(bot.revision, event.revision) + 1;
        bot.enabled = false;
        bot.capabilities = { tools: [], resources: [] };
        save(tx, "bots", bot);
        const lifecycle: BotLifecycle = { botId: bot.id, generation: bot.generation, state: deleted ? "deleting" : "stopping",
          target: deleted ? "deleted" : "retired", stage: "fenced", reason: "restored_bot_generation_withdrawn" };
        this.save(tx, lifecycle);
        this.fence(tx, bot.id, deleted);
      }
      if (deleted) {
        const computer = tx.get<{ record_json: string }>("SELECT record_json FROM bot_computers WHERE bot_id=?", bot.id);
        if (computer && !["deleting", "deleted"].includes((JSON.parse(computer.record_json) as BotComputer).state)) this.app.computers.fenceBot(tx, bot.id, true);
        bot.enabled = false;
        bot.name = "[deleted]";
        bot.responsibility = "[deleted]";
        bot.capabilities = { tools: [], resources: [] };
        save(tx, "bots", bot);
        this.tombstoneData(tx, bot.id);
        eraseBotPayloads(this.app, tx, bot.id);
      }
    }
    this.app.memory.reconcile(tx);
    this.app.personal.reconcile(tx);
    this.app.sharing.fence(tx);
    this.app.parallel.reconcile(tx);
    this.app.reports.reconcile(tx);
  }

  private unsettled(tx: AppTransaction, botId: string): boolean {
    const grants = new Set(rows<WorkGrant>(tx, "work_grants").filter(g => g.bots.some(b => b.id === botId)).map(g => g.id));
    const attempts = tx.all<{ record_json: string }>("SELECT record_json FROM work_attempts").map(row => JSON.parse(row.record_json) as Attempt);
    for (const attempt of attempts.filter(a => grants.has(a.snapshot.grant.id))) {
      if (attempt.state === "interrupted") {
        // Only metadata discovery of a recorded old intent can prove this orphan settled.
        if (!tx.get("SELECT 1 FROM native_intents WHERE json_extract(record_json,'$.attemptId')=?", attempt.id)) return true;
      } else if (attempt.state === "running" || tx.get("SELECT 1 FROM attempt_transports WHERE attempt_id=? AND active=1", attempt.id)) return true;
    }
    const workIds = new Set(attempts.filter(a => grants.has(a.snapshot.grant.id)).map(a => a.workId));
    for (const row of tx.all<{ work_id: string }>("SELECT work_id FROM effects WHERE json_extract(record_json,'$.state')='executing'")) if (workIds.has(row.work_id)) return true;
    if (tx.get(`SELECT 1 FROM reply_transports t JOIN reply_outbox r ON r.id=t.reply_id WHERE t.active=1
      AND (json_extract(r.record_json,'$.snapshot.bot.id')=? OR EXISTS
        (SELECT 1 FROM lifecycle.withdrawals w WHERE w.kind='bot_context' AND w.id=? AND w.mode=t.context_id))`, botId, botId)) return true;
    if (tx.get("SELECT 1 FROM computer_inputs i JOIN bot_computers c ON c.id=i.computer_id WHERE c.bot_id=? AND i.state='dispatching'", botId)) return true;
    return false;
  }

  private advance(botId: string, stage: BotLifecycle["stage"]): void {
    this.app.store.transaction(tx => {
      const bot = record<Bot>(tx, "bots", botId), lifecycle = this.lifecycle(tx, bot);
      lifecycle.stage = stage;
      lifecycle.reason = null;
      this.save(tx, lifecycle);
    });
    this.options.afterStage?.(stage, botId);
  }

  /** Drains retry-safe local/computer/native cleanup after fencing, retaining stopping until actual transports settle. */
  async drain(port: NativeRecoveryPort): Promise<void> {
    if (this.app.recovery.booting || this.app.backups.busy) return;
    if (this.#draining) return this.#draining;
    this.#draining = this.cleanup(port);
    try { await this.#draining; }
    finally { this.#draining = null; }
  }

  private async cleanup(port: NativeRecoveryPort): Promise<void> {
    const pending = this.app.store.read(tx => rows<BotLifecycle>(tx, "bot_lifecycle").filter(l => l.state === "stopping" || l.state === "deleting"));
    for (const operation of pending) {
      const botId = operation.botId;
      this.options.afterStage?.("fenced", botId);
      if (this.app.store.read(tx => this.unsettled(tx, botId))) {
        this.app.store.transaction(tx => { const current = this.lifecycle(tx, record<Bot>(tx, "bots", botId)); current.reason = "bot_transports_unsettled"; this.save(tx, current); });
        continue;
      }
      if (operation.target === "deleted") this.app.store.transaction(tx => this.reconcile(tx));
      this.advance(botId, "data");
      this.app.store.transaction(tx => {
        const row = tx.get<{ record_json: string }>("SELECT record_json FROM bot_computers WHERE bot_id=?", botId);
        if (row && (JSON.parse(row.record_json) as BotComputer).state === "unavailable") this.app.computers.fenceBot(tx, botId, operation.target === "deleted");
      });
      await this.app.computers.drain();
      const computer = this.app.store.read(tx => tx.get<{ record_json: string }>("SELECT record_json FROM bot_computers WHERE bot_id=?", botId));
      if (computer && !["stopped", "deleted"].includes((JSON.parse(computer.record_json) as BotComputer).state)) {
        this.app.store.transaction(tx => { const current = this.lifecycle(tx, record<Bot>(tx, "bots", botId)); current.reason = "bot_computer_cleanup_unresolved"; this.save(tx, current); });
        continue;
      }
      this.advance(botId, "computer");
      if (!await this.app.recovery.cleanupBot(botId, operation.target === "deleted" ? "delete" : "retire", port)) {
        this.app.store.transaction(tx => { const current = this.lifecycle(tx, record<Bot>(tx, "bots", botId)); current.reason = "bot_native_cleanup_unresolved"; this.save(tx, current); });
        continue;
      }
      this.advance(botId, "native");
      this.app.store.transaction(tx => {
        const bot = record<Bot>(tx, "bots", botId), lifecycle = this.lifecycle(tx, bot);
        if (lifecycle.generation !== operation.generation) return;
        lifecycle.state = lifecycle.target;
        lifecycle.stage = "complete";
        lifecycle.reason = null;
        bot.enabled = lifecycle.target === "active";
        bot.revision++;
        save(tx, "bots", bot);
        this.save(tx, lifecycle);
      });
      this.options.afterStage?.("complete", botId);
    }
  }
}
