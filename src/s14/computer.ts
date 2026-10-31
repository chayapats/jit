import { recordComputerActivity, computerActivity } from "./computer-activity";
import type { Work } from "./authority-types";
import { createHmac, randomBytes } from "node:crypto";
import { AppError } from "../errors";
import { redactCredentials } from "../security/credentials";
import { redactRegisteredSecrets } from "../security/secret-fingerprints";
import { createBoxBackend } from "../exec/box-backend";
import type { AppTransaction } from "../store";
import type { S14Application } from "./application";
import type { OwnerActor } from "./types";
import type { AgentInput, BotComputer, ComputerActivity, ComputerCommand, ComputerHandle, ComputerInputReceipt, ComputerLimits, ComputerOptions, ComputerReceipt, ComputerSession, ComputerView, InputLease, OwnerInputCommand } from "./computer-types";
import { validateComputerInput } from "./computer-podman";
import { canonical, exact, identity, integer } from "./validation";

/** Conservative per-component defaults; these are ceilings, not a claim about measured host capacity. */
export const defaultComputerLimits: Readonly<ComputerLimits> = Object.freeze({ startupMs: 30000, cpuMillis: 500, memoryBytes: 536870912, pids: 128, diskBytes: 1073741824, idleMs: 300000 });
const id = () => crypto.randomUUID().replaceAll("-", "");
const absent = (): ComputerView => ({ computer: null, lease: null });
interface Operation { sequence: number; computer_id: string; generation: number; kind: "start" | "stop" | "reset" | "delete"; state: string }
const load = (tx: AppTransaction, botId: string): BotComputer | null => {
  const row = tx.get<{ record_json: string }>("SELECT record_json FROM bot_computers WHERE bot_id=?", botId);
  return row ? JSON.parse(row.record_json) : null;
};
const leaseOf = (tx: AppTransaction, computerId: string): InputLease => JSON.parse(tx.get<{ record_json: string }>("SELECT record_json FROM input_leases WHERE computer_id=?", computerId)!.record_json);
const save = (tx: AppTransaction, c: BotComputer) => {
  if (c.diskSlot) c.diskSlot.generation = c.generation;
  tx.run("UPDATE bot_computers SET record_json=? WHERE id=?", canonical(c), c.id);
};
const saveLease = (tx: AppTransaction, lease: InputLease) => tx.run("UPDATE input_leases SET record_json=? WHERE computer_id=?", canonical(lease), lease.computerId);

/** Durable computer lifecycle and single-input barrier; all runtime dispatches revalidate live owner/Bot/work scope. */
export class S14Computers {
  readonly #pages = new Map<string, { generation: number; page: NonNullable<ComputerView["page"]> }>();
  readonly #handles = new Map<string, ComputerHandle>();
  readonly #locks = new Map<string, Promise<void>>();
  readonly #waiting = new Map<string, number>();
  readonly #inputKey = randomBytes(32);
  readonly #processId = id();
  readonly #limits: ComputerLimits;
  #draining: Promise<void> | null = null;
  #wakeDrain: (() => void) | null = null;
  constructor(readonly app: S14Application, readonly options: ComputerOptions = {}) {
    this.#limits = structuredClone(options.limits ?? defaultComputerLimits);
    exact(this.#limits, Object.keys(defaultComputerLimits));
    for (const key of Object.keys(defaultComputerLimits) as (keyof ComputerLimits)[]) integer(this.#limits[key], 1, defaultComputerLimits[key] * 4);
    if (this.#limits.memoryBytes < 67108864 || this.#limits.diskBytes < 1048576) throw new AppError("computer_limits_invalid");
  }
  private fence(tx: AppTransaction, c: BotComputer): InputLease {
    const lease = leaseOf(tx, c.id);
    lease.revision++;
    lease.generation = c.generation;
    lease.actor = null;
    lease.attemptId = null;
    lease.expiresAt = 0;
    saveLease(tx, lease);
    return lease;
  }
  private live(tx: AppTransaction, c: BotComputer): void {
    const { bot, grant } = this.app.authority.computerAuthority(tx, c.workId, c.botId);
    if (c.botGeneration !== bot.generation || c.ownerGeneration !== grant.ownerGeneration) throw new AppError("computer_authority_changed", 403);
  }
  private current(tx: AppTransaction, botId: string, computerId: string, generation: number): BotComputer {
    const c = load(tx, botId);
    if (!c || c.id !== computerId || c.generation !== generation) throw new AppError("computer_scope_changed", 409);
    return c;
  }
  /** Reads one Bot's logical identity and lease without starting a runtime or granting input. */
  view(actor: OwnerActor, botId: string): ComputerView {
    identity(botId);
    return this.app.store.read(tx => {
      this.app.requireOwner(tx, actor);
      if (!tx.get("SELECT id FROM bots WHERE id=?", botId)) throw new AppError("not_found", 404);
      const computer = load(tx, botId);
      return computer ? { computer, lease: leaseOf(tx, computer.id), page: computer.state === "running" && this.#pages.get(computer.id)?.generation === computer.generation ? this.#pages.get(computer.id)!.page : null } : absent();
    });
  }
  /** Reads the newest bounded activity lines from existing receipts, audit and attempt bindings; it records and starts nothing. */
  activity(actor: OwnerActor, botId: string, limit = 20): ComputerActivity[] {
    integer(limit, 1, 100);
    const id = this.view(actor, botId).computer?.id;
    if (!id) return [];
    return this.app.store.read(tx => [...computerActivity(tx, id, limit), ...tx.all<{ kind: ComputerActivity["kind"]; at: number; state: string | null }>(`
      SELECT a.kind AS kind, a.committed_at AS at, NULL AS state, a.sequence AS sequence FROM audit a JOIN command_receipts r ON r.request_id=a.request_id WHERE json_extract(r.result_json,'$.computer.id')=?
      UNION ALL SELECT 'takeover.input', a.committed_at, i.state, a.sequence FROM computer_inputs i JOIN audit a ON a.request_id=i.request_id WHERE i.computer_id=?
      UNION ALL SELECT 'attempt.bound', json_extract(w.record_json,'$.createdAt'), NULL, 0 FROM computer_attempts c JOIN work_attempts w ON w.id=c.attempt_id WHERE c.computer_id=?
      ORDER BY at DESC, sequence DESC LIMIT ?`, id, id, id, limit)
      .map(row => ({ kind: row.kind, at: row.at, state: row.kind === "takeover.input" ? row.state === "succeeded" ? "succeeded" as const : "unknown" as const : null }))].sort((a, b) => b.at - a.at).slice(0, limit));
  }
  /** Lists only work whose original live grant currently permits this Bot to open a computer; the command rechecks it. */
  eligibleWork(actor: OwnerActor, botId: string): { id: string; title: string; revision: number; expiresAt: number }[] {
    identity(botId);
    return this.app.store.read(tx => {
      this.app.requireOwner(tx, actor);
      if (!tx.get("SELECT id FROM bots WHERE id=?", botId)) throw new AppError("not_found", 404);
      const rows = tx.all<{ record_json: string }>("SELECT record_json FROM work_items WHERE json_extract(record_json,'$.grantId') IS NOT NULL AND json_extract(record_json,'$.state') NOT IN ('blocked','stopping','stopped','ready') ORDER BY rowid DESC LIMIT 256");
      const eligible = [];
      for (const row of rows) {
        const work = JSON.parse(row.record_json) as Work;
        try {
          const { grant } = this.app.authority.computerAuthority(tx, work.id, botId);
          eligible.push({ id: work.id, title: work.title, revision: work.revision, expiresAt: grant.expiresAt });
        } catch { /* A query is no authority; stale or revoked grants are omitted. */ }
        if (eligible.length >= 100) break;
      }
      return eligible;
    });
  }
  /** Applies exact authenticated lifecycle/lease commands inside the shared receipt transaction. */
  apply(tx: AppTransaction, command: ComputerCommand): ComputerReceipt {
    const p = command.payload;
    identity(p.botId);
    let c = load(tx, p.botId);
    const receipt = (): ComputerReceipt => ({ kind: command.kind, requestId: command.requestId, computer: c, lease: c ? leaseOf(tx, c.id) : null });
    if (command.kind === "computer.open") {
      const p = command.payload;
      exact(p, ["botId", "workId"]);
      identity(p.workId);
      const { bot, grant } = this.app.authority.computerAuthority(tx, p.workId, p.botId);
      if (command.expectedRevision !== (c?.revision ?? 0)) throw new AppError("stale_revision", 409);
      if (c && ["starting", "running", "stopping", "resetting", "deleting"].includes(c.state)) throw new AppError("computer_busy", 409);
      // An unavailable runtime may still contain an unsettled process; only a verified stop releases its slot.
      if (tx.get<{ n: number }>("SELECT count(*) AS n FROM bot_computers WHERE id<>? AND json_extract(record_json,'$.state') IN ('starting','running','stopping','resetting','deleting','unavailable')", c?.id ?? "")!.n >= 2) throw new AppError("computer_capacity", 409);
      if (!c) {
        const computerId = id();
        c = { id: computerId, botId: bot.id, revision: 0, generation: 0, botGeneration: bot.generation, ownerGeneration: grant.ownerGeneration, workId: p.workId,
          state: "stopped", reason: null, limits: structuredClone(this.#limits), workspaceId: id(), profileId: id(), lastUsedAt: this.app.now() };
        tx.run("INSERT INTO bot_computers VALUES (?,?,?)", c.id, c.botId, canonical(c));
        const lease: InputLease = { computerId: c.id, generation: 0, revision: 0, actor: null, attemptId: null, expiresAt: 0 };
        tx.run("INSERT INTO input_leases VALUES (?,?)", c.id, canonical(lease));
      }
      c.generation++;
      if (this.options.runtime?.diskSlots && !c.diskSlot) {
        const used = new Set(tx.all<{ record_json: string }>("SELECT record_json FROM bot_computers").map(row => (JSON.parse(row.record_json) as BotComputer).diskSlot?.id));
        const slot = this.options.runtime.diskSlots().find(slot => !used.has(slot));
        if (!slot) throw new AppError("computer_disk_pool_full_rerun_installer_to_extend", 503);
        c.diskSlot = { id: slot, generation: c.generation, clean: false };
      }
      c.revision++;
      c.workId = p.workId;
      c.ownerGeneration = grant.ownerGeneration;
      c.botGeneration = bot.generation;
      c.state = "starting";
      c.reason = null;
      c.lastUsedAt = this.app.now();
      this.fence(tx, c);
      save(tx, c);
      this.enqueue(tx, c, "start");
      return receipt();
    }
    const takeover = ["takeover.start", "takeover.end", "takeover.renew"].includes(command.kind);
    exact(p, takeover ? ["botId", "computerId", "generation", "leaseRevision"] : ["botId", "computerId", "generation"]);
    const scope = p as { computerId: string; generation: number; leaseRevision?: number };
    identity(scope.computerId);
    integer(scope.generation, 1);
    c = this.current(tx, p.botId, scope.computerId, scope.generation);
    if (c.revision !== command.expectedRevision) throw new AppError("stale_revision", 409);
    if (takeover) {
      this.live(tx, c);
      if (c.state !== "running") throw new AppError("computer_not_running", 409);
      const lease = leaseOf(tx, c.id);
      if (scope.leaseRevision !== lease.revision) throw new AppError("stale_lease", 409);
      if (command.kind === "takeover.start" ? lease.actor === "owner" : lease.actor !== "owner") throw new AppError("takeover_state_changed", 409);
      lease.revision++;
      lease.actor = command.kind === "takeover.end" ? null : "owner";
      lease.attemptId = null;
      lease.expiresAt = command.kind === "takeover.end" ? 0 : Math.min(this.app.now() + c.limits.idleMs, this.app.authority.computerAuthority(tx, c.workId, c.botId).grant.expiresAt);
      saveLease(tx, lease);
      c.revision++;
      c.lastUsedAt = this.app.now();
      save(tx, c);
      return receipt();
    }
    if (["starting", "stopping", "resetting", "deleting"].includes(c.state)) {
      // Stop may interrupt startup immediately; destructive operations wait for its settlement.
      if (command.kind !== "computer.stop" || c.state !== "starting") throw new AppError("computer_busy", 409);
    }
    if (c.state === "deleted") throw new AppError("computer_deleted", 409);
    if (command.kind === "computer.reset" || command.kind === "computer.delete") {
      tx.run("INSERT OR IGNORE INTO lifecycle.withdrawals VALUES ('computer',?,?)", c.id, `through_generation_${c.generation}`);
    }
    c.generation++;
    c.revision++;
    c.ownerGeneration = tx.get<{ generation: number }>("SELECT generation FROM owner")!.generation;
    c.state = command.kind === "computer.reset" ? "resetting" : command.kind === "computer.delete" ? "deleting" : "stopping";
    c.reason = null;
    this.fence(tx, c);
    save(tx, c);
    this.enqueue(tx, c, command.kind === "computer.reset" ? "reset" : command.kind === "computer.delete" ? "delete" : "stop");
    return receipt();
  }
  private enqueue(tx: AppTransaction, c: BotComputer, kind: Operation["kind"]): void {
    tx.run("INSERT INTO computer_operations(computer_id,generation,kind,state) VALUES (?,?,?,'queued')", c.id, c.generation, kind);
    // The drainer resumes after this synchronous transaction commits, never inside it.
    this.#wakeDrain?.();
  }
  private async locked<T>(computerId: string, run: () => Promise<T>): Promise<T> {
    const waiting = this.#waiting.get(computerId) ?? 0;
    if (waiting >= 16) throw new AppError("computer_input_capacity", 409);
    this.#waiting.set(computerId, waiting + 1);
    const previous = this.#locks.get(computerId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => gate);
    this.#locks.set(computerId, tail);
    await previous;
    try { return await run(); }
    finally {
      release();
      this.#waiting.set(computerId, this.#waiting.get(computerId)! - 1);
      if (this.#locks.get(computerId) === tail) { this.#locks.delete(computerId); this.#waiting.delete(computerId); }
    }
  }
  private guard(c: BotComputer, state = "running"): () => void {
    return () => this.app.store.read(tx => {
      const current = this.current(tx, c.botId, c.id, c.generation);
      if (current.state !== state) throw new AppError("computer_fenced", 403);
      if (state === "starting" && this.app.now() - current.lastUsedAt >= current.limits.startupMs) throw new AppError("computer_startup_timeout", 503);
      this.live(tx, current);
    });
  }
  /** Drains at most two computers concurrently, preserving each computer's order and live authority checks. */
  async drain(): Promise<void> {
    if (this.app.recovery.booting || this.app.backups.busy) return;
    if (this.#draining) {
      await this.#draining;
      // A committed intent may have arrived after the previous drainer's final empty read.
      return this.drain();
    }
    this.#draining = this.drainOperations();
    try { await this.#draining; }
    finally { this.#draining = null; }
  }
  private async drainOperations(): Promise<void> {
    const pending = new Map<string, Promise<void>>();
    const failures: unknown[] = [];
    try {
      for (;;) {
        const wake = Promise.withResolvers<void>();
        this.#wakeDrain = () => wake.resolve();
        while (pending.size < 2) {
          const excluded = [...pending.keys()];
          const next = (tx: AppTransaction) => tx.get<Operation>(`SELECT q.* FROM computer_operations q
            WHERE q.state='queued' AND q.computer_id NOT IN (?,?)
              AND NOT EXISTS (SELECT 1 FROM computer_operations r WHERE r.computer_id=q.computer_id AND r.state='running')
            ORDER BY q.sequence LIMIT 1`, excluded[0] ?? "", excluded[1] ?? "");
          // Avoid an attached-database write transaction for an empty queue on slow storage.
          if (!this.app.store.read(next)) break;
          const op = this.app.store.transaction(tx => {
            const row = next(tx);
            if (row) tx.run("UPDATE computer_operations SET state='running' WHERE sequence=?", row.sequence);
            return row;
          });
          if (!op) break;
          const task = this.runOperation(op).catch(error => { failures.push(error); }).finally(() => pending.delete(op.computer_id));
          pending.set(op.computer_id, task);
        }
        if (failures.length) throw failures[0];
        if (!pending.size) return;
        await Promise.race([...pending.values(), wake.promise]);
      }
    } finally {
      this.#wakeDrain = null;
      // Do not release drainer ownership while another computer is still settling.
      await Promise.allSettled(pending.values());
    }
  }
  private async runOperation(op: Operation): Promise<void> {
    const c = this.app.store.read(tx => {
      const row = tx.get<{ record_json: string }>("SELECT record_json FROM bot_computers WHERE id=?", op.computer_id);
      return row ? JSON.parse(row.record_json) as BotComputer : null;
    });
    if (!c || c.generation !== op.generation) { this.finishOperation(op); return; }
    let reason: string | null = null;
    try {
      const runtime = this.options.runtime;
      if (!runtime) throw new AppError("computer_runtime_not_configured", 503);
      await this.locked(c.id, async () => {
        if (op.kind === "start") {
          const allowed = this.guard(c, "starting");
          allowed();
          if (c.diskSlot && !c.diskSlot.clean) {
            await runtime.destroy(structuredClone(c), allowed);
            allowed();
            c.diskSlot.clean = true;
            this.app.store.transaction(tx => save(tx, c));
          }
          const handle = await runtime.start(structuredClone(c), allowed);
          try { allowed(); this.#handles.set(c.id, handle); }
          catch (error) { await runtime.stop(c); throw error; }
        } else {
          this.#handles.delete(c.id);
          if (op.kind === "reset" || op.kind === "delete") {
            const allowed = () => this.app.store.read(tx => {
              const current = this.current(tx, c.botId, c.id, c.generation);
              if (current.state !== c.state || tx.get<{ generation: number }>("SELECT generation FROM owner")?.generation !== c.ownerGeneration) throw new AppError("computer_owner_scope_changed", 403);
            });
            allowed();
            await runtime.destroy(structuredClone(c), allowed);
          }
          else await runtime.stop(structuredClone(c));
        }
      });
    } catch (error) {
      reason = error instanceof AppError ? error.code : "computer_runtime_unavailable";
      this.#handles.delete(c.id);
      this.app.store.transaction(tx => recordComputerActivity(tx, c.id, c.generation, "system.stop", this.app.now()));
      await this.options.runtime?.stop(c).catch(() => {});
    }
    this.app.store.transaction(tx => {
      const current = load(tx, c.botId);
      if (current?.generation === c.generation) {
        current.state = reason ? "unavailable" : op.kind === "start" ? "running" : op.kind === "delete" ? "deleted" : "stopped";
        current.reason = reason ?? current.reason;
        current.revision++;
        if (!reason && (op.kind === "reset" || op.kind === "delete")) { current.workspaceId = id(); current.profileId = id(); }
        if (!reason && op.kind === "delete") current.diskSlot = null;
        if (!reason && op.kind === "reset" && current.diskSlot) current.diskSlot.clean = true;
        save(tx, current);
      }
      tx.run("UPDATE computer_operations SET state='done' WHERE sequence=?", op.sequence);
    });
  }
  private finishOperation(op: Operation): void { this.app.store.transaction(tx => tx.run("UPDATE computer_operations SET state='done' WHERE sequence=?", op.sequence)); }
  /** Fences one Bot's computer/input immediately and queues only its authorized stop or destructive cleanup. */
  fenceBot(tx: AppTransaction, botId: string, destructive: boolean): void {
    const c = load(tx, botId);
    if (!c || c.state === "deleted" || destructive && c.state === "deleting" || !destructive && c.state === "stopping") return;
    if (!destructive && c.state === "stopped") { this.fence(tx, c); return; }
    if (destructive) tx.run("INSERT OR IGNORE INTO lifecycle.withdrawals VALUES ('computer',?,?)", c.id, `through_generation_${c.generation}`);
    c.generation++;
    c.revision++;
    c.ownerGeneration = tx.get<{ generation: number }>("SELECT generation FROM owner")!.generation;
    c.state = destructive ? "deleting" : "stopping";
    c.reason = "bot_lifecycle_fenced";
    this.fence(tx, c);
    save(tx, c);
    this.enqueue(tx, c, destructive ? "delete" : "stop");
  }
  /** Fences revoked/expired/idle computers before requesting runtime cancellation; no unrelated computer is stopped. */
  sweep(): void {
    this.app.store.transaction(tx => {
      for (const row of tx.all<{ record_json: string }>("SELECT record_json FROM bot_computers")) {
        const c = JSON.parse(row.record_json) as BotComputer;
        if (!["starting", "running"].includes(c.state)) continue;
        let reason: string | null = null;
        try { this.live(tx, c); } catch { reason = "computer_authority_revoked"; }
        if (this.app.now() - c.lastUsedAt >= c.limits.idleMs) reason ??= "computer_idle";
        if (!reason) continue;
        c.generation++;
        c.revision++;
        c.state = "stopping";
        c.reason = reason;
        this.fence(tx, c);
        save(tx, c);
        this.enqueue(tx, c, "stop");
        recordComputerActivity(tx, c.id, c.generation, "system.stop", this.app.now());
      }
    });
  }
  /** Exclusive boot stops prior processes, fences every lease and marks transient input outcomes unknown without replay. */
  recover(): void {
    this.app.store.transaction(tx => {
      tx.run("UPDATE computer_operations SET state='done' WHERE state IN ('queued','running')");
      tx.run("UPDATE computer_inputs SET state='unknown' WHERE state='dispatching'");
      for (const row of tx.all<{ record_json: string }>("SELECT record_json FROM bot_computers")) {
        const c = JSON.parse(row.record_json) as BotComputer;
        if (c.state === "deleted") continue;
        c.generation++;
        c.revision++;
        c.state = "stopping";
        c.reason = "restart_fenced_no_replay";
        this.fence(tx, c);
        save(tx, c);
        this.enqueue(tx, c, "stop");
        recordComputerActivity(tx, c.id, c.generation, "system.stop", this.app.now());
      }
    });
  }
  /** Lazily provisions under the admitted work grant, settling the previous work's stop before binding a fresh generation. */
  async prepare(attemptId: string): Promise<void> {
    const stopping = this.app.store.transaction(tx => {
      const attempt = this.app.authority.assertTool(tx, attemptId, "computer");
      let c = load(tx, attempt.snapshot.bot.id);
      if (c?.state === "running" && c.workId !== attempt.workId) {
        // A new work grant cannot inherit the previous work's runtime or input lease.
        this.apply(tx, { kind: "computer.stop", requestId: `computer_stop_${attempt.id}`, expectedRevision: c.revision,
          payload: { botId: c.botId, computerId: c.id, generation: c.generation } });
        recordComputerActivity(tx, c.id, c.generation, "system.stop", this.app.now());
        c = load(tx, c.botId);
      }
      return c?.state === "stopping" ? c : null;
    });
    if (stopping) await this.drain();
    this.app.store.transaction(tx => {
      const attempt = this.app.authority.assertTool(tx, attemptId, "computer");
      const c = stopping ? this.current(tx, stopping.botId, stopping.id, stopping.generation) : load(tx, attempt.snapshot.bot.id);
      // Failed or superseded stops never authorize a replacement runtime.
      if (stopping && c?.state !== "stopped") throw new AppError(c?.reason ?? "computer_not_stopped", 503);
      if (c?.state === "running" && c.workId === attempt.workId) return;
      this.apply(tx, { kind: "computer.open", requestId: `computer_${attempt.id}`, expectedRevision: c?.revision ?? 0,
        payload: { botId: attempt.snapshot.bot.id, workId: attempt.workId } });
    });
    await this.drain();
    this.app.store.read(tx => {
      const attempt = this.app.authority.assertTool(tx, attemptId, "computer");
      const c = load(tx, attempt.snapshot.bot.id);
      if (!c || c.state !== "running" || c.workId !== attempt.workId) throw new AppError(c?.reason ?? "computer_not_running", 503);
    });
  }
  /** Acquires one attempt-bound agent input lease and the public Schway runner backend under live computer authority. */
  open(attemptId: string): ComputerSession {
    const { c, lease } = this.app.store.transaction(tx => {
      const attempt = this.app.authority.assertTool(tx, attemptId, "computer");
      const c = load(tx, attempt.snapshot.bot.id);
      if (!c || c.state !== "running" || c.workId !== attempt.workId || !this.#handles.has(c.id)) throw new AppError("computer_not_running", 409);
      this.live(tx, c);
      const previous = tx.get<{ computer_id: string; generation: number }>("SELECT * FROM computer_attempts WHERE attempt_id=?", attemptId);
      if (previous && (previous.computer_id !== c.id || previous.generation !== c.generation)) throw new AppError("computer_attempt_fenced", 403);
      if (!previous) tx.run("INSERT INTO computer_attempts VALUES (?,?,?)", attemptId, c.id, c.generation);
      const lease = leaseOf(tx, c.id);
      if (lease.actor && lease.expiresAt > this.app.now()) throw new AppError(lease.actor === "owner" ? "takeover_active" : "input_lease_busy", 409);
      lease.revision++;
      lease.actor = "agent";
      lease.attemptId = attempt.id;
      lease.expiresAt = Math.min(attempt.snapshot.grant.expiresAt, this.app.now() + c.limits.idleMs);
      saveLease(tx, lease);
      c.lastUsedAt = this.app.now();
      save(tx, c);
      return { c, lease };
    });
    const handle = this.#handles.get(c.id)!;
    const backend = createBoxBackend({ exec: async (_handle, request) => {
      const allowed = () => {
        this.guard(c)();
        this.app.store.read(tx => this.app.authority.assertTool(tx, attemptId, "computer"));
      };
      allowed();
      const op = JSON.parse(new TextDecoder().decode(request.input)).op;
      if (op !== "kill") this.app.authority.reserveTool(attemptId, "computer");
      const result = await this.options.runtime!.exec(handle, request, allowed);
      allowed();
      this.touch(c);
      return result;
    } }, { projectId: c.id, name: `s14-${c.id}`, mode: "workspace", profile: false, workspaceRoot: "/workspace", temporaryDirectory: "/tmp" }, { redact: value => redactRegisteredSecrets(redactCredentials(value)) });
    return { backend, lease, registrySpawn: async (request, hosts, scopeAllowed) => {
      const allowed = () => {
        this.guard(c)();
        this.app.store.read(tx => this.app.authority.assertTool(tx, attemptId, "coding"));
        scopeAllowed();
      };
      allowed();
      if (!this.options.runtime?.registrySpawn) throw new AppError("coding_registry_proxy_unavailable", 503);
      this.app.authority.reserveTool(attemptId, "computer");
      const result = await this.options.runtime.registrySpawn(handle, request, hosts, allowed);
      allowed();
      this.touch(c);
      return result;
    }, release: () => this.app.store.transaction(tx => {
      const current = leaseOf(tx, c.id);
      if (current.revision === lease.revision && current.attemptId === attemptId) { current.revision++; current.actor = null; current.attemptId = null; current.expiresAt = 0; saveLease(tx, current); }
    }) };
  }
  private inputGuard(c: BotComputer, revision: number, actor: "owner" | "agent", attemptId: string | null, owner?: OwnerActor): () => void {
    return () => this.app.store.read(tx => {
      if (owner) this.app.requireOwner(tx, owner);
      this.guard(c)();
      const lease = leaseOf(tx, c.id);
      if (lease.generation !== c.generation || lease.revision !== revision || lease.actor !== actor || lease.attemptId !== attemptId || lease.expiresAt <= this.app.now()) throw new AppError("input_lease_fenced", 403);
      if (attemptId) this.app.authority.assertTool(tx, attemptId, "computer");
    });
  }
  /** Sends only reviewed agent scroll input; unknown browser/CDP/MCP actions never reach a runtime. */
  async agentInput(attemptId: string, lease: InputLease, input: AgentInput): Promise<void> {
    validateComputerInput(input);
    if (input.kind !== "scroll") throw new AppError("unsupported_browser_action", 403);
    const c = this.app.store.read(tx => {
      const attempt = this.app.authority.assertTool(tx, attemptId, "computer");
      const c = load(tx, attempt.snapshot.bot.id);
      if (!c || c.id !== lease.computerId || c.workId !== attempt.workId) throw new AppError("computer_scope_changed", 403);
      return c;
    });
    const allowed = this.inputGuard(c, lease.revision, "agent", attemptId);
    await this.locked(c.id, async () => {
      allowed();
      this.app.authority.reserveTool(attemptId, "computer");
      await this.options.runtime!.input(this.#handles.get(c.id)!, structuredClone(input), allowed);
      allowed();
      this.touch(c);
      this.app.store.transaction(tx => recordComputerActivity(tx, c.id, c.generation, "agent.scroll", this.app.now()));
    });
  }
  /** Consumes transient Web-only owner input once; only keyed digests, safe outcomes and IDs enter SQLite. */
  async ownerInput(actor: OwnerActor, command: OwnerInputCommand): Promise<{ requestId: string; state: "succeeded" | "unknown" }> {
    exact(command, ["kind", "requestId", "expectedRevision", "payload"]);
    if (command.kind !== "takeover.input") throw new AppError("unknown_command");
    identity(command.requestId);
    integer(command.expectedRevision);
    exact(command.payload, ["botId", "computerId", "generation", "leaseRevision", "input"]);
    const p = command.payload;
    identity(p.botId);
    identity(p.computerId);
    integer(p.generation, 1);
    integer(p.leaseRevision, 1);
    validateComputerInput(p.input);
    if (!["click", "text", "key"].includes(p.input.kind)) throw new AppError("unsupported_browser_action", 403);
    const hash = createHmac("sha256", this.#inputKey).update(canonical(command)).digest("hex");
    return this.locked(p.computerId, async () => {
      const claimed: { state: "succeeded" | "unknown" } | { c: BotComputer } = this.app.store.transaction(tx => {
        this.app.requireOwner(tx, actor);
        if (tx.get("SELECT request_id FROM command_receipts WHERE owner_id='owner' AND request_id=?", command.requestId)) throw new AppError("request_id_conflict", 409);
        const previous = tx.get<{ process_id: string; payload_hash: string; state: "dispatching" | "succeeded" | "unknown" }>("SELECT * FROM computer_inputs WHERE request_id=?", command.requestId);
        if (previous) {
          if (previous.process_id !== this.#processId) return { state: "unknown" as const };
          if (previous.payload_hash !== hash) throw new AppError("request_id_conflict", 409);
          return { state: previous.state === "succeeded" ? "succeeded" as const : "unknown" as const };
        }
        const c = this.current(tx, p.botId, p.computerId, p.generation);
        if (c.revision !== command.expectedRevision) throw new AppError("stale_revision", 409);
        this.inputGuard(c, p.leaseRevision, "owner", null, actor)();
        tx.run("INSERT INTO computer_inputs VALUES (?,?,?,?,?)", command.requestId, c.id, this.#processId, hash, "dispatching");
        tx.run("INSERT INTO audit(kind,request_id,committed_at) VALUES ('takeover.input',?,?)", command.requestId, this.app.now());
        this.app.options.beforeCommit?.();
        return { c };
      });
      if ("state" in claimed) return { requestId: command.requestId, state: claimed.state };
      const c = claimed.c, allowed = this.inputGuard(c, p.leaseRevision, "owner", null, actor);
      let state: "succeeded" | "unknown" = "unknown";
      try {
        allowed();
        const handle = this.#handles.get(c.id);
        if (!handle || !this.options.runtime) throw new AppError("computer_not_running", 409);
        await this.options.runtime.input(handle, structuredClone(p.input), allowed);
        allowed();
        this.touch(c);
        state = "succeeded";
      } catch { /* An input may already have reached the page: consume it and never retry. */ }
      this.app.store.transaction(tx => tx.run("UPDATE computer_inputs SET state=? WHERE request_id=?", state, command.requestId));
      return { requestId: command.requestId, state };
    });
  }
  /** Returns only the retained safe owner-input outcome, projecting interrupted/in-flight input as unknown. */
  inputReceipt(actor: OwnerActor, requestId: string): ComputerInputReceipt {
    identity(requestId);
    return this.app.store.read(tx => {
      this.app.requireOwner(tx, actor);
      const row = tx.get<{ computer_id: string; state: string }>("SELECT computer_id,state FROM computer_inputs WHERE request_id=?", requestId);
      if (!row) throw new AppError("not_found", 404);
      return { requestId, computerId: row.computer_id, state: row.state === "succeeded" ? "succeeded" : "unknown" };
    });
  }
  private touch(c: BotComputer): void {
    this.app.store.transaction(tx => {
      const current = this.current(tx, c.botId, c.id, c.generation);
      current.lastUsedAt = this.app.now();
      save(tx, current);
    });
  }
  /** Captures an owner-only bounded PNG in memory; no image or session material enters ordinary state or model input. */
  async screenshot(actor: OwnerActor, botId: string): Promise<Uint8Array> {
    const c = this.view(actor, botId).computer;
    if (!c || c.state !== "running") throw new AppError("computer_not_running", 409);
    return this.locked(c.id, async () => {
      const allowed = () => { this.app.store.read(tx => this.app.requireOwner(tx, actor)); this.guard(c)(); };
      allowed();
      const handle = this.#handles.get(c.id);
      if (!handle || !this.options.runtime) throw new AppError("computer_not_running", 409);
      const bytes = await this.options.runtime.screenshot(handle, allowed);
      allowed();
      if (bytes.length < 8 || bytes.length > 2097152 || Buffer.from(bytes.subarray(0, 8)).toString("hex") !== "89504e470d0a1a0a") throw new AppError("computer_image_invalid", 422);
      let metadata: { url?: string; title?: string } | undefined;
      try { metadata = await this.options.runtime.pageInfo?.(handle, allowed); }
      catch { /* Optional metadata failure cannot replace an otherwise valid screenshot with raw diagnostics. */ }
      allowed();
      this.app.store.transaction(tx => {
        // Arbitrary titles/URLs may contain typed secrets. Only the observed built-in blank page is safe in Phase A.
        if (metadata?.url === "about:blank" && this.#pages.get(c.id)?.generation !== c.generation) {
          this.#pages.set(c.id, { generation: c.generation, page: { url: "about:blank", title: null, untrusted: true } });
          recordComputerActivity(tx, c.id, c.generation, "page.opened", this.app.now());
        }
        recordComputerActivity(tx, c.id, c.generation, "screenshot", this.app.now());
      });
      return bytes;
    });
  }
}
