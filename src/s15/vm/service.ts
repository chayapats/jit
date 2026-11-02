import { coreToolDefinitions } from "schway/host";
import { AppError } from "../../errors";
import { createVmBackend } from "./backend";
import { VmStore, type VmRegistration } from "./store";
import { VmSshTransport } from "./transport";
import { probeVmDirectEgress } from "./network";
import { defaultVmLimits, type VmEvidence, type VmLimits, type VmManagement, type VmPolicyOperation, type VmPolicyPort, type VmSession, type WorkingVmPort } from "./types";
import { vmCanonical, vmFail, vmHash, vmId, vmLimits } from "./validation";
import { fetchVmArtifact, type VmArtifactRequest } from "./acquisition";
import type { VmProxyLease } from "./proxy";

/** Protected composition dependencies; the service is opt-in and never replaces the S14 computer/runtime. */
export interface WorkingVmOptions {
  store: VmStore; policy: VmPolicyPort; managers: ReadonlyMap<string, VmManagement>;
  limits?: VmLimits; now?: () => number; requireOwner?: (actor: object) => void;
  transport?: (registration: VmRegistration) => VmSshTransport;
  proxyLease?: (sessionId: string, expiresAt: number) => VmProxyLease;
  artifactFetch?: typeof fetchVmArtifact;
}
interface LiveSession { id: string; vmId: string; workId: string; attemptId: string; generation: number; mode: "work" | "system";
  unit: string; root: string; temporary: string; deadline: number; calls: number; cancelled: boolean; closed: boolean;
  controller: AbortController; tail: Promise<void>; pending: number; closing: Promise<void> | null; timer: ReturnType<typeof setTimeout> | null; proxy: VmProxyLease | null }
const uuid = () => crypto.randomUUID().replaceAll("-", "");
/** Shared working VM with exact-unit cooperative cleanup and protected hypervisor recovery. No automatic command replay. */
export class WorkingVmService implements WorkingVmPort {
  readonly #limits: VmLimits;
  readonly #now: () => number;
  readonly #live = new WeakMap<VmSession, LiveSession>();
  readonly #sessions = new Map<string, LiveSession>();
  readonly #health = new Map<string, Promise<void>>();
  constructor(readonly options: WorkingVmOptions) {
    this.#limits = vmLimits(options.limits ?? { ...defaultVmLimits }); this.#now = options.now ?? Date.now;
    // Existing process-local contexts are not reconstructed. Claims survive, mutation authority does not.
    options.store.transaction(() => {
      const orphans = options.store.db.query<{ vm_id: string }, []>("SELECT DISTINCT vm_id FROM vm_sessions WHERE state<>'closed'").all();
      for (const { vm_id } of orphans) this.uncertain(vm_id, "vm_reconciliation_required");
    });
  }
  private transport(row: VmRegistration): VmSshTransport { return this.options.transport?.(row) ?? new VmSshTransport(row.endpoint); }
  private uncertain(vmId: string, reason: string): void {
    const row = this.options.store.registration(vmId); row.state = "uncertain"; row.reason = reason; this.options.store.save(row);
    for (const s of this.#sessions.values()) if (s.vmId === vmId) { s.cancelled = true; s.controller.abort(); s.proxy?.close(); }
  }
  private current(actor: object, s: LiveSession): void {
    if (s.cancelled || s.closed || this.#now() >= s.deadline) throw new DOMException("Aborted", "AbortError");
    const row = this.options.store.registration(s.vmId);
    if (row.generation !== s.generation || row.state !== "ready" || !row.networkIsolated) vmFail(row.reason ?? "vm_fenced", 403);
    this.options.policy.assertCurrent(actor, { vmId: s.vmId, workId: s.workId, attemptId: s.attemptId, mode: s.mode });
  }
  private async health(row: VmRegistration, force = false): Promise<void> {
    if (!force && this.#now() - row.networkCheckedAt < this.#limits.networkProbeMs) return;
    const running = this.#health.get(row.id); if (running) return running;
    const promise = (async () => {
      try {
        const manager = row.managerId ? this.options.managers.get(row.managerId) : null;
        const machine = manager ? await manager.inspect() : null;
        if (!machine || machine.state !== "running" || machine.identity !== row.machineIdentity || machine.boot !== row.boot || machine.network === "unproven" || !await probeVmDirectEgress(this.transport(row))) vmFail("vm_network_unproven");
        const current = this.options.store.registration(row.id);
        if (current.generation !== row.generation || current.state !== "ready") vmFail("vm_fenced");
        current.networkCheckedAt = this.#now(); this.options.store.save(current);
      } catch (error) { this.uncertain(row.id, error instanceof AppError ? error.code : "vm_network_unproven"); throw error; }
    })().finally(() => this.#health.delete(row.id));
    this.#health.set(row.id, promise); return promise;
  }
  /** Acquires a bounded shared work slot or an exclusive snapshot-backed system-administration slot. */
  async openAttempt(actor: object, input: Parameters<WorkingVmPort["openAttempt"]>[1]): Promise<VmSession> {
    for (const v of [input.vmId, input.workId, input.attemptId]) vmId(v);
    const access = input.access ?? "execute"; if (access !== "inspect" && access !== "execute" || access === "inspect" && input.mode === "system") vmFail("vm_invalid_setup");
    const mode = input.mode ?? "work"; if (mode !== "work" && mode !== "system") vmFail("vm_invalid_setup");
    if (input.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    this.options.policy.assertCurrent(actor, { ...input, mode });
    const id = uuid(), unit = `jit-${id}.slice`, row = this.options.store.registration(input.vmId);
    if (row.state !== "ready" || !row.networkIsolated) vmFail(row.reason ?? "vm_network_unproven");
    const manager = row.managerId ? this.options.managers.get(row.managerId) : null;
    if (mode === "system" && !manager) vmFail("vm_recovery_unavailable", 423);
    this.options.store.transaction(() => {
      this.options.policy.assertCurrent(actor, { ...input, mode });
      const r = this.options.store.registration(row.id);
      if (r.state !== "ready" || r.generation !== row.generation) vmFail("vm_fenced");
      const active = this.options.store.db.query<{ mode: string }, [string]>("SELECT mode FROM vm_sessions WHERE vm_id=? AND state<>'closed'").all(row.id);
      if (active.length >= Math.min(r.maxSessions, this.#limits.maxSessions) || active.some(s => s.mode === "system") || mode === "system" && active.length) vmFail("vm_capacity");
      this.options.store.db.query("INSERT INTO vm_sessions VALUES (?,?,?,?,?,?,?,?)").run(id, row.id, input.workId, input.attemptId, mode, "opening", unit, row.generation);
    });
    let s: LiveSession | undefined;
    try {
      if (mode === "system") {
        const count = this.options.store.db.query<{ n: number }, [string]>("SELECT count(*) n FROM vm_snapshots WHERE vm_id=?").get(row.id)!.n;
        if (count >= 8) vmFail("vm_snapshot_capacity", 423);
        const snapshot = `jit-${uuid()}`, payload = vmCanonical({ kind: "snapshot", snapshot, vmId: row.id, generation: row.generation });
        const claim = await this.options.policy.claim(actor, { vmId: row.id, generation: row.generation, sessionId: id, workId: input.workId,
          attemptId: input.attemptId, operationId: uuid(), kind: "system_admin", payloadHash: vmHash(payload), payload, timeoutMs: this.#limits.commandMs, outputBytes: 0 });
        await claim.dispatch(() => manager!.snapshot(snapshot));
        const machine = await manager!.inspect();
        this.options.store.transaction(() => {
          const current = this.options.store.registration(row.id); current.generation++; current.boot = machine.boot; this.options.store.save(current);
          this.options.store.db.query("INSERT INTO vm_snapshots VALUES (?,?,?)").run(snapshot, row.id, current.generation);
          this.options.store.db.query("UPDATE vm_sessions SET generation=? WHERE id=?").run(current.generation, id);
          row.generation = current.generation; row.boot = current.boot;
        });
      }
      await this.health(row, true);
      const root = `/var/lib/jit-work/${input.workId}`, temporary = `${root}/.tmp-${id}`;
      s = { id, vmId: row.id, workId: input.workId, attemptId: input.attemptId, generation: row.generation, mode, unit, root, temporary,
        deadline: this.#now() + this.#limits.sessionMs, calls: 0, cancelled: false, closed: false, controller: new AbortController(), tail: Promise.resolve(),
        pending: 0, closing: null, timer: null, proxy: this.options.proxyLease?.(id, Date.now() + this.#limits.sessionMs) ?? null };
      this.#sessions.set(id, s);
      const state = s, transport = this.transport(row);
      const guard = () => { if (input.signal?.aborted) { state.cancelled = true; throw new DOMException("Aborted", "AbortError"); } this.current(actor, state); };
      await transport.openScope(unit, this.#limits.sessionMs, guard); guard();
      const call = (operation: Record<string, unknown>, kind: "read" | "write" | "shell", signal?: AbortSignal) => this.call(actor, state, operation, kind, signal);
      // Fixed, work-root-only infrastructure setup is separately claimed; it cannot dispatch a domain edit/shell.
      await call({ op: "init" }, "read");
      const backend = createVmBackend({ call }, root, temporary, this.#limits, {}, access);
      const session: VmSession = Object.freeze({ id, backend,
        definitions: Object.freeze(coreToolDefinitions(backend).filter(definition => access === "execute" || ["read", "list", "search"].includes(definition.name)).map(definition => ({ ...definition, execute: async (value: unknown, context: Parameters<typeof definition.execute>[1]) => {
          guard(); const result = await definition.execute(value, context); guard(); return result;
        } }))),
        evidence: () => Object.freeze(this.options.store.evidence(id).map(e => Object.freeze(e))),
        cancel: () => this.closeState(state), close: () => this.closeState(state) });
      this.#live.set(session, state);
      state.timer = setTimeout(() => { void this.closeState(state).catch(() => {}); }, this.#limits.sessionMs);
      const abort = () => { void session.cancel().catch(() => {}); };
      input.signal?.addEventListener("abort", abort, { once: true });
      if (input.signal?.aborted) { await session.cancel(); throw new DOMException("Aborted", "AbortError"); }
      this.options.store.db.query("UPDATE vm_sessions SET state='active' WHERE id=?").run(id);
      return session;
    } catch (error) {
      if (s) await this.closeState(s).catch(() => {});
      else { this.uncertain(row.id, "vm_reconciliation_required"); this.options.store.db.query("UPDATE vm_sessions SET state='unknown' WHERE id=?").run(id); }
      throw error;
    }
  }
  private async call(actor: object, s: LiveSession, operation: Record<string, unknown>, kind: "read" | "write" | "shell", signal?: AbortSignal): Promise<Record<string, unknown>> {
    this.current(actor, s); if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (++s.calls > this.#limits.calls || s.pending >= 32) vmFail("vm_limit_exhausted");
    s.pending++;
    const previous = s.tail, gate = Promise.withResolvers<void>(); s.tail = previous.then(() => gate.promise);
    await previous;
    const abort = () => { void this.closeState(s).catch(() => {}); };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      this.current(actor, s); if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      await this.health(this.options.store.registration(s.vmId)); this.current(actor, s);
      const id = uuid(), request: Record<string, unknown> = { v: 1, id, root: s.root, tmp: s.temporary, cap: kind === "shell" ? this.#limits.outputBytes : this.#limits.fileBytes, ...structuredClone(operation) };
      const payload = vmCanonical(request), operationId = id, payloadHash = vmHash(payload);
      const action: VmPolicyOperation = { vmId: s.vmId, generation: s.generation, sessionId: s.id, workId: s.workId, attemptId: s.attemptId,
        operationId, kind: operation.op === "init" ? "setup" : s.mode === "system" && kind === "shell" ? "system_admin" : kind, payload, payloadHash,
        timeoutMs: Math.min(typeof operation.timeoutMs === "number" ? operation.timeoutMs + 5000 : this.#limits.commandMs, s.deadline - this.#now()), outputBytes: this.#limits.outputBytes };
      const claim = await this.options.policy.claim(actor, Object.freeze(action)); this.current(actor, s);
      const evidence: VmEvidence = { id, vmId: s.vmId, sessionId: s.id, operationId, payloadHash, outcome: "not_dispatched", responseHash: null,
        outputBytes: null, transport: "pending", execution: "unsettled", published: false };
      this.options.store.saveEvidence(evidence);
      try {
        const transportRequest = request.op === "spawn" ? { ...request, env: { ...(operation.env as Record<string, string>), ...s.proxy?.environment } } : request;
        const response = await claim.dispatch(() => {
          this.current(actor, s); evidence.outcome = "unknown"; this.options.store.saveEvidence(evidence);
          return this.transport(this.options.store.registration(s.vmId)).invoke(transportRequest, { unit: s.unit, timeoutMs: action.timeoutMs,
            maxBytes: Math.max(this.#limits.fileBytes, this.#limits.outputBytes) * 3 + 65536, signal: s.controller.signal, beforeStart: () => this.current(actor, s) });
        });
        evidence.transport = "closed"; evidence.outcome = "guest_reported"; const bytes = vmCanonical(response);
        evidence.responseHash = vmHash(bytes); evidence.outputBytes = Buffer.byteLength(bytes); this.options.store.saveEvidence(evidence); claim.observe({ ...evidence });
        this.current(actor, s);
        return claim.publish(() => { this.current(actor, s); evidence.published = true; this.options.store.saveEvidence(evidence); return response; });
      } catch (error) {
        evidence.transport = "closed"; this.options.store.saveEvidence(evidence); claim.observe({ ...evidence });
        if (error instanceof AppError && ["vm_protocol_invalid", "vm_connection_failed", "vm_transport_timeout", "vm_output_limit"].includes(error.code)) this.uncertain(s.vmId, error.code);
        throw error;
      }
    } finally { signal?.removeEventListener("abort", abort); s.pending--; gate.resolve(); }
  }
  private closeState(s: LiveSession): Promise<void> {
    if (s.closing) return s.closing;
    s.cancelled = true; s.controller.abort(); s.proxy?.close(); if (s.timer) clearTimeout(s.timer);
    this.options.store.db.query("UPDATE vm_sessions SET state='stopping' WHERE id=? AND state<>'closed'").run(s.id);
    s.closing = (async () => {
      // Client/channel closure is separate from guest scope cessation. Never stop a sibling unit here.
      await s.tail;
      const row = this.options.store.registration(s.vmId);
      const empty = await this.transport(row).closeScope(s.unit);
      if (!empty || row.state === "uncertain") { this.uncertain(s.vmId, "vm_stop_unconfirmed"); this.options.store.db.query("UPDATE vm_sessions SET state='unknown' WHERE id=?").run(s.id); vmFail("vm_stop_unconfirmed"); }
      this.options.store.transaction(() => {
        for (const evidence of this.options.store.evidence(s.id)) { evidence.execution = "guest_scope_empty"; this.options.store.saveEvidence(evidence); }
        this.options.store.db.query("UPDATE vm_sessions SET state='closed' WHERE id=?").run(s.id);
      });
      s.closed = true; this.#sessions.delete(s.id);
    })();
    return s.closing;
  }
  /** Downloads an exact separately authorized artifact, then performs a separately claimed bounded guest write. */
  async acquire(actor: object, session: VmSession, input: VmArtifactRequest & { path: string }): Promise<void> {
    const s = this.#live.get(session); if (!s) vmFail("vm_session_invalid", 403); this.current(actor, s);
    const payload = vmCanonical(input), operationId = uuid();
    const claim = await this.options.policy.claim(actor, { vmId: s.vmId, generation: s.generation, sessionId: s.id, workId: s.workId, attemptId: s.attemptId,
      operationId, kind: "acquire", payloadHash: vmHash(payload), payload, timeoutMs: 30000, outputBytes: input.maxBytes });
    const bytes = await claim.dispatch(() => { this.current(actor, s); return (this.options.artifactFetch ?? fetchVmArtifact)(input, s.controller.signal); });
    claim.publish(() => this.current(actor, s));
    await this.call(actor, s, { op: "write", path: input.path, data: Buffer.from(bytes).toString("base64"), createParents: false }, "write");
  }
  /** Owner-authorized strong settlement/restore. The caller supplies a real owner verifier; no guest actor can invoke it. */
  async recover(actor: object, input: { vmId: string; snapshotId?: string }): Promise<void> {
    const requireOwner = this.options.requireOwner; if (!requireOwner) vmFail("vm_owner_required", 403);
    requireOwner(actor); vmId(input.vmId); const row = this.options.store.registration(input.vmId), manager = row.managerId ? this.options.managers.get(row.managerId) : null;
    if (!manager) vmFail("vm_recovery_unavailable", 423);
    if (input.snapshotId && !this.options.store.db.query("SELECT id FROM vm_snapshots WHERE id=? AND vm_id=?").get(input.snapshotId, row.id)) vmFail("vm_snapshot_unknown");
    this.options.store.transaction(() => { requireOwner(actor); this.uncertain(row.id, "vm_recovery_in_progress"); row.generation++; row.state = "uncertain"; row.reason = "vm_recovery_in_progress"; this.options.store.save(row); });
    await manager.stop(); requireOwner(actor);
    if ((await manager.inspect()).state !== "stopped") vmFail("vm_stop_unconfirmed");
    this.options.store.transaction(() => {
      for (const r of this.options.store.db.query<{ id: string }, [string]>("SELECT id FROM vm_sessions WHERE vm_id=?").all(row.id)) {
        for (const evidence of this.options.store.evidence(r.id)) { evidence.execution = "vm_stopped"; this.options.store.saveEvidence(evidence); }
      }
      this.options.store.db.query("UPDATE vm_sessions SET state='closed' WHERE vm_id=?").run(row.id);
    });
    this.options.store.db.query("INSERT INTO vm_events(vm_id,kind,generation) VALUES (?,'stop',?)").run(row.id, row.generation);
    if (input.snapshotId) { requireOwner(actor); await manager.restore(input.snapshotId); this.options.store.db.query("INSERT INTO vm_events(vm_id,kind,generation) VALUES (?,'restore',?)").run(row.id, row.generation); }
    const current = this.options.store.registration(row.id); current.state = "stopped"; current.reason = null; current.boot = null; this.options.store.save(current);
  }
}
