import { coreToolDefinitions } from "schway/host";
import { containsCredential } from "../../security/credentials";
import { AppError } from "../../errors";
import { createVmBackend } from "./backend";
import { VmStore, type VmRegistration } from "./store";
import { VmSshTransport } from "./transport";
import { probeVmDirectEgress } from "./network";
import { defaultVmLimits, type VmEvidence, type VmLimits, type VmManagement, type VmPolicyOperation, type VmPolicyPort, type VmSession, type WorkingVmPort } from "./types";
import { vmCanonical, vmFail, vmHash, vmId, vmLimits, vmPath, vmInteger } from "./validation";
import { fetchVmArtifact, type VmArtifactRequest } from "./acquisition";
import type { VmProxyLease } from "./proxy";
import { vmIdentityMatches } from "./binding";

/** Protected composition dependencies; the service is opt-in and never replaces the S14 computer/runtime. */
export interface WorkingVmOptions {
  store: VmStore; policy: VmPolicyPort; managers: ReadonlyMap<string, VmManagement>;
  limits?: VmLimits; now?: () => number; monotonic?: () => number; requireOwner?: (actor: object) => void;
  transport?: (registration: VmRegistration) => VmSshTransport;
  proxyLease?: (sessionId: string, expiresAt: number, authorize?: (host: string) => void) => VmProxyLease;
  /** DATA15 registry destination checks run outside the guest, before DNS and during live tunnels. */
  disclosure?: Pick<import('../disclosure').DisclosureService, 'registryLease' | 'vmInput' | 'vmOutput'>;
  artifactFetch?: typeof fetchVmArtifact;
  snapshotRetention?: number;
  expiryTimer?: (milliseconds: number, expire: () => void) => () => void;
}
interface LiveSession { id: string; vmId: string; workId: string; attemptId: string; generation: number; mode: "work" | "system";
  unit: string; root: string; temporary: string; deadline: number; calls: number; cancelled: boolean; closed: boolean;
  controller: AbortController; cleanupController: AbortController; tail: Promise<void>; pending: number; closing: Promise<void> | null; cancelExpiry: () => void; proxy: VmProxyLease | null; removeSignal: () => void; acquisitions: Map<string, VmPolicyOperation> }
const uuid = () => crypto.randomUUID().replaceAll("-", "");
/** Shared working VM with exact-unit cooperative cleanup and protected hypervisor recovery. No automatic command replay. */
export class WorkingVmService implements WorkingVmPort {
  readonly #limits: VmLimits;
  readonly #now: () => number;
  readonly #clock: () => number;
  readonly #checked = new Map<string, number>();
  readonly #live = new WeakMap<VmSession, LiveSession>();
  readonly #sessions = new Map<string, LiveSession>();
  readonly #health = new Map<string, Promise<void>>();
  readonly #managementBusy = new Set<string>();
  constructor(readonly options: WorkingVmOptions) {
    this.#limits = vmLimits(options.limits ?? { ...defaultVmLimits }); this.#now = options.now ?? Date.now; this.#clock = options.monotonic ?? (() => performance.now());
    vmInteger(options.snapshotRetention ?? 3, 8);
    // Existing process-local contexts are not reconstructed. Claims survive, mutation authority does not.
    options.store.transaction(() => {
      const orphans = options.store.db.query<{ vm_id: string }, []>("SELECT DISTINCT vm_id FROM vm_sessions WHERE state<>'closed'").all();
      for (const { vm_id } of orphans) this.uncertain(vm_id, "vm_reconciliation_required");
    });
  }
  private transport(row: VmRegistration): VmSshTransport { return this.options.transport?.(row) ?? new VmSshTransport(row.endpoint); }
  private uncertain(vmId: string, reason: string, generation?: number): void {
    const row = this.options.store.registration(vmId); if (generation !== undefined && row.generation !== generation) return;
    row.state = "uncertain"; row.reason = reason; this.options.store.save(row);
    for (const s of this.#sessions.values()) if (s.vmId === vmId) { s.cancelled = true; s.controller.abort(); s.proxy?.close(); }
  }
  private current(actor: object, s: LiveSession): void {
    if (s.cancelled || s.closed || this.#clock() >= s.deadline) throw new DOMException("Aborted", "AbortError");
    const row = this.options.store.registration(s.vmId);
    if (row.generation !== s.generation || row.state !== "ready" || !row.networkIsolated) vmFail(row.reason ?? "vm_fenced", 403);
    this.options.policy.assertCurrent(actor, { vmId: s.vmId, workId: s.workId, attemptId: s.attemptId, mode: s.mode });
  }
  private async health(row: VmRegistration, force = false): Promise<void> {
    if (!force && this.#checked.has(row.id) && this.#clock() - this.#checked.get(row.id)! < this.#limits.networkProbeMs) return;
    const running = this.#health.get(row.id); if (running) return running;
    const promise = (async () => {
      try {
        const manager = row.managerId ? this.options.managers.get(row.managerId) : null;
        const machine = manager ? await manager.inspect() : null;
        if (!machine || machine.state !== "running" || machine.identity !== row.machineIdentity || machine.boot !== row.boot || !row.bindingMac || machine.nicMac !== row.bindingMac || !await vmIdentityMatches(this.transport(row), machine, row.endpoint)) vmFail("vm_identity_unproven");
        if (machine.network === "unproven" || !await probeVmDirectEgress(this.transport(row))) vmFail("vm_network_unproven");
        const current = this.options.store.registration(row.id);
        if (current.generation !== row.generation || current.state !== "ready") vmFail("vm_fenced");
        current.networkCheckedAt = this.#now(); this.options.store.save(current); this.#checked.set(row.id, this.#clock());
      } catch (error) { this.uncertain(row.id, error instanceof AppError ? error.code : "vm_network_unproven", row.generation); throw error; }
    })().finally(() => { if (this.#health.get(row.id) === promise) this.#health.delete(row.id); });
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
    if (this.#managementBusy.has(row.id)) vmFail("vm_capacity");
    if (!row.bindingMac) vmFail("vm_identity_unproven");
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
    let s: LiveSession | undefined; let managementStarted = false;
    try {
      if (mode === "system") {
        this.#managementBusy.add(row.id);
        try {
        await this.health(row, true);
        const snapshot = `jit-${uuid()}`, payload = vmCanonical({ kind: "snapshot", snapshot, vmId: row.id, generation: row.generation });
        const claim = await this.options.policy.claim(actor, { vmId: row.id, generation: row.generation, sessionId: id, workId: input.workId,
          attemptId: input.attemptId, operationId: uuid(), kind: "system_admin", payloadHash: vmHash(payload), payload, timeoutMs: 360000, outputBytes: 0 });
        try { await claim.dispatch(() => { if (input.signal?.aborted) throw new DOMException("Aborted", "AbortError"); managementStarted = true; return manager!.snapshot(snapshot); }); }
        finally { claim.release?.(); }
        const machine = await manager!.inspect();
        this.options.store.transaction(() => {
          const current = this.options.store.registration(row.id); current.generation++; current.boot = machine.boot; this.options.store.save(current);
          this.options.store.db.query("INSERT INTO vm_snapshots VALUES (?,?,?)").run(snapshot, row.id, current.generation);
          this.options.store.db.query("UPDATE vm_sessions SET generation=? WHERE id=?").run(current.generation, id);
          row.generation = current.generation; row.boot = current.boot;
        });
        await this.rotateSnapshots(actor, row, manager!, { sessionId: id, workId: input.workId, attemptId: input.attemptId, ...(input.signal ? { signal: input.signal } : {}) });
        } finally { this.#managementBusy.delete(row.id); }
      }
      await this.health(row, true);
      const root = `/var/lib/jit-work/${input.workId}/${input.attemptId}`, temporary = `${root}/.tmp-${id}`;
      s = { id, vmId: row.id, workId: input.workId, attemptId: input.attemptId, generation: row.generation, mode, unit, root, temporary,
        deadline: this.#clock() + this.#limits.sessionMs, calls: 0, cancelled: false, closed: false, controller: new AbortController(), cleanupController: new AbortController(), tail: Promise.resolve(),
        pending: 0, closing: null, cancelExpiry: () => {}, removeSignal: () => {}, acquisitions: new Map(), proxy: this.options.proxyLease?.(id, Date.now() + this.#limits.sessionMs, this.options.disclosure ? host => this.options.disclosure!.registryLease(actor, host, row.id) : undefined) ?? null };
      this.#sessions.set(id, s);
      const state = s;
      const abort = () => { void this.closeState(state).catch(() => {}); };
      input.signal?.addEventListener("abort", abort, { once: true });
      state.removeSignal = () => input.signal?.removeEventListener("abort", abort);
      const guard = () => { if (input.signal?.aborted) { state.cancelled = true; throw new DOMException("Aborted", "AbortError"); } this.current(actor, state); };
      guard();
      const call = (operation: Record<string, unknown>, kind: "read" | "write" | "shell", signal?: AbortSignal) => this.call(actor, state, operation, kind, signal);
      // Fixed, work-root-only infrastructure setup is separately claimed; it cannot dispatch a domain edit/shell.
      await call({ op: "init" }, "read");
      const backend = createVmBackend({ call, protocolError: () => this.uncertain(state.vmId, "vm_protocol_invalid", state.generation) }, root, temporary, this.#limits, {}, access);
      const session: VmSession = Object.freeze({ id, backend,
        definitions: Object.freeze(coreToolDefinitions(backend).filter(definition => access === "execute" || ["read", "grep", "find", "ls"].includes(definition.name)).map(definition => ({ ...definition, execute: async (value: unknown, context: Parameters<typeof definition.execute>[1]) => {
          guard(); const result = await definition.execute(value, context); guard(); return result;
        } }))),
        evidence: () => Object.freeze(this.options.store.evidence(id).map(e => Object.freeze(e))),
        cancel: () => this.closeState(state), close: () => this.closeState(state) });
      this.#live.set(session, state);
      state.cancelExpiry = (this.options.expiryTimer ?? ((ms, expire) => { const timer = setTimeout(expire, ms); return () => clearTimeout(timer); }))(this.#limits.sessionMs, () => { void this.closeState(state).catch(() => {}); });
      if (input.signal?.aborted) { await session.cancel(); throw new DOMException("Aborted", "AbortError"); }
      this.options.store.db.query("UPDATE vm_sessions SET state='active' WHERE id=?").run(id);
      return session;
    } catch (error) {
      if (s) await this.closeState(s).catch(() => {});
      else if (this.options.store.registration(row.id).generation === row.generation) {
        if (managementStarted) { this.uncertain(row.id, "vm_reconciliation_required", row.generation); this.options.store.db.query("UPDATE vm_sessions SET state='unknown' WHERE id=? AND generation=?").run(id, row.generation); }
        else this.options.store.db.query("UPDATE vm_sessions SET state='closed' WHERE id=? AND generation=?").run(id, row.generation);
      }
      throw error;
    }
  }
  private async enqueue<T>(actor: object, s: LiveSession, signal: AbortSignal | undefined, perform: () => Promise<T>): Promise<T> {
    this.current(actor, s); if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (++s.calls > this.#limits.calls || s.pending >= 32) vmFail("vm_limit_exhausted");
    s.pending++;
    const previous = s.tail, gate = Promise.withResolvers<void>(); s.tail = previous.then(() => gate.promise);
    await previous;
    const abort = () => { void this.closeState(s).catch(() => {}); };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      this.current(actor, s); if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      return await perform();
    } finally { signal?.removeEventListener("abort", abort); s.pending--; gate.resolve(); }
  }
  private async call(actor: object, s: LiveSession, operation: Record<string, unknown>, kind: "read" | "write" | "shell", signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.enqueue(actor, s, signal, async () => {
      await this.health(this.options.store.registration(s.vmId)); this.current(actor, s);
      const id = uuid(), request: Record<string, unknown> = { v: 1, id, root: s.root, tmp: s.temporary, cap: kind === "shell" ? this.#limits.outputBytes : this.#limits.fileBytes, ...structuredClone(operation) };
      const payload = vmCanonical(request), operationId = id, payloadHash = vmHash(payload);
      if (containsCredential(payload)) vmFail("vm_credentials_denied", 403);
      const action: VmPolicyOperation = { vmId: s.vmId, generation: s.generation, sessionId: s.id, workId: s.workId, attemptId: s.attemptId,
        operationId, kind: operation.op === "init" ? "setup" : s.mode === "system" && kind === "shell" ? "system_admin" : kind, payload, payloadHash,
        timeoutMs: Math.max(1, Math.floor(Math.min(typeof operation.timeoutMs === "number" ? operation.timeoutMs + 5000 : this.#limits.commandMs, s.deadline - this.#clock()))), outputBytes: this.#limits.outputBytes };
      const claim = await this.options.policy.claim(actor, Object.freeze(action));
      try {
      const evidence: VmEvidence = { id, vmId: s.vmId, sessionId: s.id, operationId, payloadHash, outcome: "not_dispatched", responseHash: null,
        outputBytes: null, transport: "pending", execution: "unsettled", published: false };
      this.options.store.saveEvidence(evidence);
      try {
        this.current(actor, s);
        this.options.disclosure?.vmInput(actor, s.vmId);
        const transportRequest = request.op === "spawn" ? { ...request, env: { ...(request.env as Record<string, string>), ...s.proxy?.environment } } : request;
        const response = await claim.dispatch(() => {
          this.current(actor, s); evidence.outcome = "unknown"; this.options.store.saveEvidence(evidence);
          const transport = this.transport(this.options.store.registration(s.vmId)), began = this.#clock();
          const invoke = async () => {
            if (operation.op === "init") await transport.openScope(s.unit, Math.max(1, s.deadline - this.#clock()), () => this.current(actor, s), s.controller.signal);
            this.current(actor, s);
            return transport.invoke(transportRequest, { unit: s.unit, timeoutMs: Math.max(1, Math.floor(action.timeoutMs - (this.#clock() - began))),
            maxBytes: Math.max(this.#limits.fileBytes, this.#limits.outputBytes) * 3 + 65536, signal: s.controller.signal, beforeStart: () => this.current(actor, s) });
          };
          return invoke();
        });
        evidence.transport = "closed"; evidence.outcome = "guest_reported"; const bytes = vmCanonical(response);
        evidence.responseHash = vmHash(bytes); evidence.outputBytes = Buffer.byteLength(bytes); this.options.store.saveEvidence(evidence); claim.observe({ ...evidence });
        this.current(actor, s);
        return claim.publish(() => { this.current(actor, s); this.options.disclosure?.vmOutput(actor, s.vmId); evidence.published = true; this.options.store.saveEvidence(evidence); return response; });
      } catch (error) {
        evidence.transport = "closed"; this.options.store.saveEvidence(evidence); claim.observe({ ...evidence });
        if (error instanceof AppError && ["vm_protocol_invalid", "vm_connection_failed", "vm_transport_timeout", "vm_output_limit"].includes(error.code)) this.uncertain(s.vmId, error.code, s.generation);
        throw error;
      }
      } finally { claim.release?.(); }
    });
  }
  private releaseHeld(s: LiveSession): void {
    s.acquisitions.clear();
    this.options.policy.releaseSession?.({ vmId: s.vmId, workId: s.workId, attemptId: s.attemptId, sessionId: s.id, generation: s.generation });
  }
  private retireLive(s: LiveSession): void {
    s.cancelled = true; s.closed = true; s.controller.abort(); s.cleanupController.abort(); s.proxy?.close(); s.removeSignal(); s.cancelExpiry();
    this.releaseHeld(s);
    this.#sessions.delete(s.id);
  }
  private async retireExact(row: VmRegistration, manager: VmManagement, snapshotId: string): Promise<void> {
    if (!this.options.store.db.query("SELECT id FROM vm_snapshots WHERE id=? AND vm_id=?").get(snapshotId, row.id)) vmFail("vm_snapshot_unknown");
    const pinned = this.options.store.db.query("SELECT s.id FROM vm_sessions s JOIN vm_snapshots p ON p.vm_id=s.vm_id AND p.generation=s.generation WHERE p.id=? AND s.mode='system' AND s.state<>'closed' LIMIT 1").get(snapshotId);
    if (pinned) vmFail("vm_snapshot_in_use", 423);
    if (this.options.store.registration(row.id).generation !== row.generation) vmFail("vm_fenced");
    await manager.retireSnapshot(snapshotId);
    if (this.options.store.registration(row.id).generation !== row.generation) vmFail("vm_fenced");
    this.options.store.db.query("DELETE FROM vm_snapshots WHERE id=? AND vm_id=?").run(snapshotId, row.id);
  }
  private async rotateSnapshots(actor: object, row: VmRegistration, manager: VmManagement, scope: { sessionId: string; workId: string; attemptId: string; signal?: AbortSignal }): Promise<void> {
    const old = this.options.store.db.query<{ id: string }, [string, number]>("SELECT id FROM vm_snapshots WHERE vm_id=? ORDER BY rowid DESC LIMIT 32 OFFSET ?").all(row.id, this.options.snapshotRetention ?? 3);
    for (const snapshot of old) {
      const payload = vmCanonical({ kind: "retire_snapshot", snapshot: snapshot.id, vmId: row.id, generation: row.generation });
      const claim = await this.options.policy.claim(actor, { ...scope, vmId: row.id, generation: row.generation, operationId: uuid(), kind: "system_admin", payload, payloadHash: vmHash(payload), timeoutMs: 120000, outputBytes: 0 });
      try { await claim.dispatch(() => {
        if (scope.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        this.options.policy.assertCurrent(actor, { ...scope, vmId: row.id, mode: "system" });
        return this.retireExact(row, manager, snapshot.id);
      }); } finally { claim.release?.(); }
    }
  }
  private async checkManager(row: VmRegistration, manager: VmManagement): Promise<void> {
    const machine = await manager.inspect();
    if (!row.bindingMac || machine.identity !== row.machineIdentity || machine.state === "running" && machine.nicMac !== row.bindingMac) vmFail("vm_identity_unproven");
  }
  /** Owner-only exact retirement; an active system session's snapshot is never eligible. */
  async retireSnapshot(actor: object, input: { vmId: string; snapshotId: string }): Promise<void> {
    if (!this.options.requireOwner) vmFail("vm_owner_required", 403);
    this.options.requireOwner(actor); vmId(input.vmId); const row = this.options.store.registration(input.vmId);
    const manager = row.managerId ? this.options.managers.get(row.managerId) : null;
    if (!manager || !row.bindingMac) vmFail("vm_recovery_unavailable", 423);
    if (this.#managementBusy.has(row.id)) vmFail("vm_capacity"); this.#managementBusy.add(row.id);
    try { await this.checkManager(row, manager); this.options.requireOwner(actor); await this.retireExact(row, manager, input.snapshotId); }
    finally { this.#managementBusy.delete(row.id); }
  }
  private closeState(s: LiveSession): Promise<void> {
    if (s.closed || this.options.store.registration(s.vmId).generation !== s.generation) { this.retireLive(s); return Promise.resolve(); }
    if (s.closing) return s.closing;
    s.cancelled = true; s.controller.abort(); s.proxy?.close(); s.removeSignal(); s.cancelExpiry();
    this.releaseHeld(s);
    this.options.store.db.query("UPDATE vm_sessions SET state='stopping' WHERE id=? AND generation=? AND state<>'closed'").run(s.id, s.generation);
    s.closing = (async () => {
      // Client/channel closure is separate from guest scope cessation. Never stop a sibling unit here.
      await s.tail;
      this.releaseHeld(s);
      if (s.closed || this.options.store.registration(s.vmId).generation !== s.generation) return;
      const row = this.options.store.registration(s.vmId);
      const empty = await this.transport(row).closeScope(s.unit, () => {
        if (s.closed || this.options.store.registration(s.vmId).generation !== s.generation) throw new DOMException("Aborted", "AbortError");
      }, s.cleanupController.signal);
      if (s.closed || this.options.store.registration(s.vmId).generation !== s.generation) return;
      if (!empty || this.options.store.registration(s.vmId).state === "uncertain") { this.uncertain(s.vmId, "vm_stop_unconfirmed", s.generation); this.options.store.db.query("UPDATE vm_sessions SET state='unknown' WHERE id=? AND generation=?").run(s.id, s.generation); vmFail("vm_stop_unconfirmed"); }
      this.options.store.transaction(() => {
        for (const evidence of this.options.store.evidence(s.id)) { evidence.execution = "guest_scope_empty"; this.options.store.saveEvidence(evidence); }
        this.options.store.db.query("UPDATE vm_sessions SET state='closed' WHERE id=?").run(s.id);
      });
      this.retireLive(s);
    })();
    return s.closing;
  }
  /** Downloads an exact separately authorized artifact, then performs a separately claimed bounded guest write. */
  async acquire(actor: object, session: VmSession, input: VmArtifactRequest & { path: string }): Promise<void> {
    input = Object.freeze(structuredClone(input));
    const s = this.#live.get(session); if (!s) vmFail("vm_session_invalid", 403); this.current(actor, s);
    vmPath(input.path, [s.root, s.temporary]); vmInteger(input.maxBytes, this.#limits.fileBytes);
    if (!/^[a-f0-9]{64}$/.test(input.sha256)) vmFail("vm_acquisition_invalid", 400);
    const payload = vmCanonical(input), operationId = uuid();
    if (containsCredential(payload)) vmFail("vm_credentials_denied", 403);
    const bytes = await this.enqueue(actor, s, undefined, async () => {
      const key = vmHash(payload), operation = s.acquisitions.get(key) ?? { vmId: s.vmId, generation: s.generation, sessionId: s.id, workId: s.workId, attemptId: s.attemptId,
        operationId, kind: 'acquire' as const, payloadHash: key, payload, timeoutMs: Math.max(1, Math.min(30000, Math.floor(s.deadline - this.#clock()))), outputBytes: input.maxBytes };
      if (s.acquisitions.size >= 64 && !s.acquisitions.has(key)) vmFail('vm_capacity', 423);
      s.acquisitions.set(key, operation);
      let claim;
      try { claim = await this.options.policy.claim(actor, operation); }
      catch (error) { if (!(error instanceof AppError) || error.status !== 423) s.acquisitions.delete(key); throw error; }
      try {
        const bytes = await claim.dispatch(() => { this.current(actor, s); return (this.options.artifactFetch ?? fetchVmArtifact)(input, s.controller.signal, { beforeRequest: () => { this.current(actor, s); claim.guard?.(); } }); });
        return claim.publish(() => { this.current(actor, s); return bytes; });
      } finally { s.acquisitions.delete(key); claim.release?.(); }
    });
    if (bytes.length > input.maxBytes || vmHash(bytes) !== input.sha256) vmFail("vm_acquisition_invalid");
    await this.call(actor, s, { op: "write", path: input.path, data: Buffer.from(bytes).toString("base64"), createParents: false }, "write");
  }
  /** Explicit owner start/re-verification after recovery. No old session, command or policy claim is resumed. */
  async start(actor: object, vm: string): Promise<void> {
    const requireOwner = this.options.requireOwner; if (!requireOwner) vmFail("vm_owner_required", 403);
    requireOwner(actor); vmId(vm); const row = this.options.store.registration(vm);
    if (row.state !== "stopped" || this.options.store.db.query("SELECT id FROM vm_sessions WHERE vm_id=? AND state<>'closed' LIMIT 1").get(vm)) vmFail("vm_fenced");
    const manager = row.managerId ? this.options.managers.get(row.managerId) : null;
    if (!manager?.start) vmFail("vm_management_unavailable");
    if (this.#managementBusy.has(vm)) vmFail("vm_capacity"); this.#managementBusy.add(vm);
    try {
    await this.checkManager(row, manager); requireOwner(actor);
    this.options.store.transaction(() => { requireOwner(actor); row.generation++; row.state = "uncertain"; row.reason = "vm_recovery_in_progress"; this.options.store.save(row); });
    await manager.start(); requireOwner(actor); const machine = await manager.inspect();
    if (machine.identity !== row.machineIdentity || machine.nicMac !== row.bindingMac || !await vmIdentityMatches(this.transport(row), machine, row.endpoint)) vmFail("vm_identity_unproven");
    if (machine.network === "unproven" || !await probeVmDirectEgress(this.transport(row))) vmFail("vm_network_unproven");
    this.options.store.transaction(() => { requireOwner(actor); row.boot = machine.boot; row.state = "ready"; row.reason = null; row.networkIsolated = true; row.networkCheckedAt = this.#now(); this.options.store.save(row); });
    } finally { this.#managementBusy.delete(vm); }
  }
  /** Owner-authorized strong settlement/restore. The caller supplies a real owner verifier; no guest actor can invoke it. */
  async recover(actor: object, input: { vmId: string; snapshotId?: string }): Promise<void> {
    const requireOwner = this.options.requireOwner; if (!requireOwner) vmFail("vm_owner_required", 403);
    requireOwner(actor); vmId(input.vmId); const row = this.options.store.registration(input.vmId), manager = row.managerId ? this.options.managers.get(row.managerId) : null;
    if (!manager || !row.bindingMac) vmFail("vm_recovery_unavailable", 423);
    if (input.snapshotId && !this.options.store.db.query("SELECT id FROM vm_snapshots WHERE id=? AND vm_id=?").get(input.snapshotId, row.id)) vmFail("vm_snapshot_unknown");
    if (this.#managementBusy.has(row.id)) vmFail("vm_capacity"); this.#managementBusy.add(row.id);
    try {
    await this.checkManager(row, manager); requireOwner(actor);
    this.options.store.transaction(() => { requireOwner(actor); this.uncertain(row.id, "vm_recovery_in_progress"); row.generation++; row.state = "uncertain"; row.reason = "vm_recovery_in_progress"; this.options.store.save(row); });
    for (const session of [...this.#sessions.values()]) if (session.vmId === row.id) this.retireLive(session);
    this.#checked.delete(row.id); this.#health.delete(row.id);
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
    const current = this.options.store.registration(row.id); current.state = "stopped"; current.reason = null; current.boot = null; current.networkIsolated = false; this.options.store.save(current);
    } finally { this.#managementBusy.delete(row.id); }
  }
}
