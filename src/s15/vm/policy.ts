import { AppError } from "../../errors";
import type { ActionAdapter, ActionDraft, ActionRef, AdapterResult, BudgetVector, CatalogPort, Fence, JsonValue, Observation,
  ReadHandler, ReadOperation, Ref, S15PolicyService, Usage, WorkActor, WorkAuthority, PreparedAction, DispatchContext } from "../policy";
import type { VmStore } from "./store";
import type { VmEvidence, VmPolicyClaim, VmPolicyOperation, VmPolicyPort } from "./types";
import { vmCanonical, vmFail, vmHash, vmId, vmInteger, vmPath, vmRecord } from "./validation";

const unknownUsage = (): Usage => ({ attempts: null, steps: null, calls: null, reads: null, outputBytes: null, activeMs: null, spendMinor: null });
const same = (a: unknown, b: unknown) => vmCanonical(a) === vmCanonical(b);
const reference = (a: ActionRef): ActionRef => ({ id: a.id, revision: a.revision, actionHash: a.actionHash });
interface Invocation { operation: Readonly<VmPolicyOperation>; request: Record<string, unknown>; payload: JsonValue; read: ReadOperation | null; bound: BudgetVector | null }
interface Pending { invocation: Invocation; send: (guard: () => void) => Promise<AdapterResult> }

/** Protected VM/policy composition. Every resolver is owning-service code, never guest/model/current-state JSON. */
export interface VmPolicyIntegrationOptions {
  store: VmStore;
  resource(vmId: string): Ref;
  attemptCurrent(work: WorkAuthority, attemptId: string): boolean;
  /** Installation-approved conservative pricing/resource bound. Null is held, never interpreted as free. */
  upperBound(operation: Readonly<VmPolicyOperation>): BudgetVector | null;
  /** Resolve a proposed external artifact recipient in the protected consent catalog; absence refuses acquisition. */
  destination(hostname: string): Ref | null;
  /** DATA15 binds actual acquisition bytes/recipients and rechecks after DNS/transport waits. */
  disclosure?: ReturnType<import('../disclosure').DisclosureService['acquisition']>;
}
/**
 * Registers supported POLICY15 read handlers and one exact VM action adapter, then binds the real service.
 * No fake/allow-all implementation is supplied. Lost live invocations cannot be recovered or replayed.
 */
export class VmPolicyIntegration {
  readonly #invocations = new Map<string, Invocation>();
  readonly #pending = new Map<string, Pending>();
  #policy: S15PolicyService | null = null;
  readonly adapter: ActionAdapter;
  readonly reads: readonly ReadHandler[];
  constructor(readonly options: VmPolicyIntegrationOptions) {
    this.reads = Object.freeze((["read", "grep", "find", "ls", "workspace_setup"] as const).map(operation => ({ operation,
      validate: (payload: JsonValue, context: { work: WorkAuthority; resource: Ref }) => {
        const invocation = this.lookup(payload);
        if (invocation.read !== operation || context.work.id !== invocation.operation.workId || !same(context.resource, this.options.resource(invocation.operation.vmId))) vmFail("vm_policy_denied", 403);
        this.checkScope(context.work, invocation.operation);
      } })));
    this.adapter = Object.freeze({ id: "working_vm", version: 1,
      prepare: (proposal: unknown, context: { work: WorkAuthority; now: number }): ActionDraft => {
        const invocation = this.lookup(proposal), op = invocation.operation;
        this.checkScope(context.work, op);
        if (invocation.read) vmFail("vm_policy_denied", 403);
        const snapshot = this.snapshot(op.vmId), snapshotPreparation = ["snapshot", "retire_snapshot"].includes(invocation.request.kind as string);
        const classes: ActionDraft["classes"] = op.kind === "acquire" ? ["new_egress"] : op.kind === "system_admin" && !snapshotPreparation ? ["guest_system_admin"] : ["guest_local_admin"];
        let recipients: Ref[] = [];
        if (op.kind === "acquire") {
          const destination = this.options.destination(new URL(invocation.request.url as string).hostname);
          if (!destination) vmFail("vm_destination_denied", 423);
          recipients = [destination];
        }
        const fences: Fence[] = [{ kind: "vm", ref: this.vmRef(op.vmId) }];
        if (classes.includes("guest_system_admin") && snapshot) fences.push(snapshot);
        const draft: ActionDraft = { operation: snapshotPreparation ? "vm_snapshot" : `vm_${op.kind}`, classes,
          resources: [this.options.resource(op.vmId)], recipients, payload: invocation.payload, fences,
          upperBound: invocation.bound, expiresAt: context.work.expiresAt, transaction: null, github: null,
          impact: "reversible", snapshot: classes.includes("guest_system_admin") ? snapshot : null };
        return op.kind === 'acquire' && this.options.disclosure ? this.options.disclosure.prepare(context.work, draft) : draft;
      },
      perform: async (action: PreparedAction, context: DispatchContext) => {
        const pending = this.#pending.get(action.id);
        if (!pending || !same(action.payload, pending.invocation.payload)) vmFail("vm_reconciliation_required", 403);
        const policy = this.policy();
        this.checkScope(policy.work.guard(pendingActor(pending)), pending.invocation.operation);
        return context.commit(action.payload, () => pending.send(() => {
          context.guard(); const work = policy.work.guard(pendingActor(pending)); this.checkScope(work, pending.invocation.operation);
          if (pending.invocation.operation.kind === 'acquire') this.options.disclosure?.guard(work, action);
        }));
      },
    });
  }
  private policy(): S15PolicyService { if (!this.#policy) vmFail("vm_policy_unavailable", 503); return this.#policy; }
  private vmRef(id: string): Ref { const row = this.options.store.registration(id); return { id, revision: row.generation, generation: row.generation }; }
  private snapshot(vmId: string): Fence | null {
    const row = this.options.store.registration(vmId);
    const snapshot = this.options.store.db.query<{ id: string; generation: number }, [string, number]>("SELECT id,generation FROM vm_snapshots WHERE vm_id=? AND generation=? ORDER BY rowid DESC LIMIT 1").get(vmId, row.generation);
    return snapshot ? { kind: "lineage", ref: { id: snapshot.id, revision: 1, generation: snapshot.generation } } : null;
  }
  /** Adds protected current VM/snapshot fences to the owning catalog without widening its consent/actor checks. */
  catalogs(base: CatalogPort): CatalogPort {
    return { ...(base.allowsModel ? { allowsModel: (work: WorkAuthority, selection: import('../policy').Selection) => base.allowsModel!(work, selection) } : {}), allows: (work, action) => base.allows(work, action), current: (kind, id) => {
      if (kind === "vm" && this.options.store.db.query("SELECT id FROM vm_registry WHERE id=?").get(id)) {
        const row = this.options.store.registration(id); return { ref: this.vmRef(id), active: row.state === "ready" && row.networkIsolated };
      }
      if (kind === "lineage") {
        const row = this.options.store.db.query<{ vm_id: string; generation: number }, [string]>("SELECT vm_id,generation FROM vm_snapshots WHERE id=?").get(id);
        if (row) { const vm = this.options.store.registration(row.vm_id); return { ref: { id, revision: 1, generation: row.generation }, active: vm.generation === row.generation && vm.state === "ready" }; }
      }
      return base.current(kind, id);
    } };
  }
  private checkScope(work: WorkAuthority, op: Pick<VmPolicyOperation, "vmId" | "workId" | "attemptId" | "generation">): void {
    const row = this.options.store.registration(op.vmId), resource = this.options.resource(op.vmId);
    if (work.mode !== "work" || work.id !== op.workId || !this.options.attemptCurrent(work, op.attemptId) ||
      !work.request.resources.some(r => same(r, resource))) vmFail("vm_policy_denied", 403);
    if (row.generation !== op.generation || row.state !== "ready" || !row.networkIsolated) vmFail("vm_fenced", 403);
  }
  private lookup(payload: unknown): Invocation {
    const r = vmRecord(payload, ["contract", "operationId", "payloadHash", "payloadBytes", "request"]);
    const invocation = typeof r.operationId === "string" ? this.#invocations.get(r.operationId) : null;
    if (!invocation || !same(r, invocation.payload)) vmFail("vm_reconciliation_required", 403);
    return invocation;
  }
  private register(input: Readonly<VmPolicyOperation>): Invocation {
    for (const value of [input.vmId, input.workId, input.attemptId, input.sessionId, input.operationId]) vmId(value);
    vmInteger(input.generation); vmInteger(input.timeoutMs, 360000); vmInteger(input.outputBytes, 8_388_608, 0);
    if (vmHash(input.payload) !== input.payloadHash) vmFail("vm_policy_denied", 403);
    const existing = this.#invocations.get(input.operationId);
    if (existing) { if (!same(existing.operation, input)) vmFail('vm_policy_denied', 403); return existing; }
    if (this.#invocations.size >= 2048) vmFail("vm_policy_denied", 403);
    let parsed: unknown; try { parsed = JSON.parse(input.payload); } catch { vmFail("vm_protocol_invalid"); }
    if (vmCanonical(parsed) !== input.payload) vmFail("vm_protocol_invalid");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) vmFail("vm_protocol_invalid");
    const request = parsed as Record<string, unknown>;
    let read: ReadOperation | null = null;
    if (input.kind === "acquire") {
      vmRecord(request, ["url", "sha256", "maxBytes", "path"]);
      const url = new URL(request.url as string); if (url.protocol !== "https:" || url.username || url.password || url.hash) vmFail("vm_acquisition_invalid", 400);
      vmInteger(request.maxBytes, 8_388_608);
    } else if (input.kind === "system_admin" && ["snapshot", "retire_snapshot"].includes(request.kind as string)) {
      vmRecord(request, ["kind", "snapshot", "vmId", "generation"]);
      if (!/^jit-[a-f0-9]{32}$/.test(request.snapshot as string) || request.vmId !== input.vmId || request.generation !== input.generation) vmFail("vm_policy_denied", 403);
    } else {
      const root = `/var/lib/jit-work/${input.workId}/${input.attemptId}`, temporary = `${root}/.tmp-${input.sessionId}`;
      const base = ["v", "id", "root", "tmp", "cap", "op"];
      const fields: Record<string, string[]> = { init: [], realpath: ["path"], stat: ["path"], read: ["path"], observe: ["path", "content"],
        list: ["path", "recursive"], search: ["path", "cwd", "pattern", "limit", "ignoreCase", "glob", "timeoutMs"],
        write: ["path", "data", "createParents"], spawn: ["cwd", "command", "env", "timeoutMs"] };
      const keys = typeof request.op === "string" ? fields[request.op] : null;
      if (!keys) vmFail("vm_policy_denied", 403);
      vmRecord(request, [...base, ...keys], request.op === "write" ? ["observed"] : []);
      if (request.v !== 1 || request.id !== input.operationId || request.root !== root || request.tmp !== temporary) vmFail("vm_policy_denied", 403);
      vmInteger(request.cap, 8_388_608);
      if (request.path !== undefined) vmPath(request.path as string, [root, temporary]);
      if (request.cwd !== undefined) vmPath(request.cwd as string, [root]);
      if (input.kind === "setup" && request.op === "init") read = "workspace_setup";
      else if (input.kind === "read") {
        if (["realpath", "stat", "read", "observe"].includes(request.op as string)) read = "read";
        else if (request.op === "list") read = request.recursive ? "find" : "ls";
        else if (request.op === "search") read = "grep";
        else vmFail("vm_policy_denied", 403);
      } else if (!(input.kind === "write" && request.op === "write" || ["shell", "system_admin"].includes(input.kind) && request.op === "spawn")) vmFail("vm_policy_denied", 403);
    }
    // Small exact requests stay inspectable; large file writes bind all bytes by hash without enlarging POLICY's command limit.
    const projected = Buffer.byteLength(input.payload) <= 60_000 ? request : { op: request.op as string, ...(typeof request.path === "string" ? { path: request.path } : { cwd: request.cwd as string }), dataHash: vmHash(input.payload), bytes: Buffer.byteLength(input.payload) };
    const payload: JsonValue = { contract: "s15-working-vm-policy/v1", operationId: input.operationId, payloadHash: input.payloadHash,
      payloadBytes: Buffer.byteLength(input.payload), request: projected as JsonValue };
    const invocation = { operation: Object.freeze({ ...input }), request, payload, read, bound: this.options.upperBound(input) };
    this.#invocations.set(input.operationId, invocation); return invocation;
  }
  /** Binds once to the actual POLICY module; actor verification, reservations, claims and publication stay there. */
  bind(policy: S15PolicyService): VmPolicyPort {
    if (this.#policy) vmFail("vm_policy_denied", 403); this.#policy = policy;
    return Object.freeze({
      assertCurrent: (actor: object, scope: Parameters<VmPolicyPort["assertCurrent"]>[1]) => {
        const work = policy.work.guard(actor as WorkActor), row = this.options.store.registration(scope.vmId);
        this.checkScope(work, { ...scope, generation: row.generation });
        if (scope.mode === "system" && (work.request.intent !== "execute" || work.request.access === "read")) vmFail("vm_inspect_only", 403);
      },
      claim: async (actor: object, operation: Readonly<VmPolicyOperation>): Promise<VmPolicyClaim> => {
        const worker = actor as WorkActor, work = policy.work.guard(worker); this.checkScope(work, operation);
        const invocation = this.register(operation), bound = invocation.bound;
        if (!bound) { this.#invocations.delete(operation.operationId); vmFail("vm_cost_unknown", 423); }
        if (invocation.read) {
          let decision;
          try { decision = policy.work.reserveRead(worker, { requestId: operation.operationId, resource: this.options.resource(operation.vmId),
            operation: invocation.read, exactPayload: invocation.payload, upperBound: bound, fences: [{ kind: "vm", ref: this.vmRef(operation.vmId) }] }); }
          catch (error) { this.#invocations.delete(operation.operationId); throw error; }
          if (decision.state !== "allow") { this.#invocations.delete(operation.operationId); throw new AppError(decision.code, decision.state === "hold" ? 423 : 403); }
          let dispatched = false, observedHash: string | null = null;
          return { release: () => { this.#invocations.delete(operation.operationId); }, dispatch: async start => {
            try {
              this.checkScope(policy.work.guard(worker), operation); policy.work.guardRead(worker, decision.claim.id); dispatched = true;
              return await start();
            } catch (error) { this.#invocations.delete(operation.operationId); throw error; }
          }, observe: evidence => {
            observedHash = evidence.responseHash;
            const succeeded = evidence.outcome === "guest_reported" && observedHash !== null;
            const observation: Observation = { outcome: succeeded ? "succeeded" : dispatched ? "unknown" : "not_dispatched",
              basis: succeeded ? "remote_verified" : dispatched ? "uncertain" : "local_guard", code: null, actual: unknownUsage(), transportSettled: evidence.transport === "closed" };
            try { policy.control.settleRead(decision.claim.id, observation, succeeded ? observedHash : null); }
            catch (error) { this.#invocations.delete(operation.operationId); throw error; }
            if (!succeeded) this.#invocations.delete(operation.operationId);
          }, publish: consume => {
            try {
              this.checkScope(policy.work.guard(worker), operation);
              const read = policy.control.publishRead(worker, decision.claim.id);
              if (read.observation.outcome !== "succeeded" || read.resultHash !== observedHash) vmFail("vm_policy_denied", 403);
              return consume();
            } finally { this.#invocations.delete(operation.operationId); }
          } };
        }
        let prepared;
        try { prepared = policy.work.prepare(worker, { slot: operation.operationId, adapter: this.adapter.id, proposal: invocation.payload }); }
        catch (error) { this.#invocations.delete(operation.operationId); throw error; }
        const action = reference(prepared.action);
        if (prepared.decision.state !== "allow") { if (prepared.decision.state !== 'hold' || operation.kind !== 'acquire') this.#invocations.delete(operation.operationId); throw new AppError(prepared.decision.code, prepared.decision.state === "hold" ? 423 : 403, { actionId: action.id, revision: action.revision, actionHash: action.actionHash }); }
        let originalGuard: (() => void) | null = null;
        return { guard: () => { if (!originalGuard) vmFail('vm_reconciliation_required', 403); originalGuard(); }, release: () => { this.#invocations.delete(operation.operationId); }, dispatch: async <T>(start: () => Promise<T>): Promise<T> => {
          try {
          this.checkScope(policy.work.guard(worker), operation); policy.work.guardBeforeDispatch(worker, action);
          let result: T | undefined, captured = false, failure: unknown;
          const pending: Pending = { invocation, send: async guard => {
            originalGuard = guard;
            try { this.checkScope(policy.work.guard(worker), operation); result = await start(); captured = true; return { outcome: "succeeded", actual: unknownUsage(), transportSettled: true }; }
            catch (error) { failure = error; return { outcome: "unknown", actual: unknownUsage(), transportSettled: true }; }
          } };
          actors.set(pending, worker); this.#pending.set(action.id, pending);
          let observation: Observation;
          try { observation = await policy.work.dispatch(worker, action); }
          finally { this.#pending.delete(action.id); actors.delete(pending); this.#invocations.delete(operation.operationId); }
          if (failure) throw failure;
          if (!captured || observation.outcome !== "succeeded") { this.#invocations.delete(operation.operationId); throw new AppError(observation.code ?? "vm_reconciliation_required", 409); }
          return result as T;
          } finally { this.#invocations.delete(operation.operationId); }
        }, observe: (_evidence: VmEvidence) => {}, publish: consume => {
          try {
            this.checkScope(policy.work.guard(worker), operation); const observation = policy.control.publishable(worker, action);
            if (observation.outcome !== "succeeded") vmFail("vm_reconciliation_required", 409);
            return consume();
          } finally { this.#invocations.delete(operation.operationId); }
        } };
      },
    });
  }
}
// Process-local original actor binding. Neither JSON nor a copied action can recreate this dispatch context.
const actors = new WeakMap<Pending, WorkActor>();
function pendingActor(pending: Pending): WorkActor { const actor = actors.get(pending); if (!actor) vmFail("vm_policy_denied", 403); return actor; }
