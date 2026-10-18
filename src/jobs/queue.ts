import { reconcileContext, reconcileSessions } from "./reconcile";
import type { ApplicationRunPort } from "../team/run-port";
import type { ManagedContextReference } from "../team/types";
import { attemptAuthority, invalidateJob, readAttempt, readAttempts, saveAttempt, unsettledTransportAttempts, type JobAttempt } from "./attempts";
import { createHash } from "node:crypto";
import { AppError } from "../errors";
import { TransactionStore, type AppTransaction } from "../store";
import type { Job, JobCommand, JobData, JobLimits, JobPolicy, JobReason, JobUsage, WorkDefinition, WorkOutcome } from "./types";

const counters = ["roles", "calls", "rounds", "hops", "contextTokens", "outputTokens", "retries"] as const;
const limitKeys = [...counters, "wallMs"];
const id = (value: unknown) => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,119}$/.test(value);
const exact = (value: unknown, keys: string[]) => !!value && typeof value === "object" && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  && Object.keys(value).every(key => keys.includes(key));
const positive = (value: unknown, max = 1_000_000_000): value is number => Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= max;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const routeKey = (route: Job["route"]) => jobData({ provider: route.provider, authRoute: route.authRoute }, 1024);

/** Canonicalizes bounded plain JSON data; arrays must be dense, ordinary and at most 256 entries. */
export function jobData(value: unknown, bytes: number): string {
  const seen = new Set<object>();
  let estimated = 0;
  const consume = (amount: number) => { estimated += amount; if (estimated > bytes) throw new AppError("invalid_job_data"); };
  function visit(item: unknown, depth: number): JobData {
    if (depth > 12) throw new AppError("invalid_job_data");
    consume(1);
    if (typeof item === "string") consume(item.length);
    if (item === null || typeof item === "boolean" || typeof item === "string") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (!item || typeof item !== "object" || seen.has(item)) throw new AppError("invalid_job_data");
    const array = Array.isArray(item);
    if (array && (Object.getPrototypeOf(item) !== Array.prototype || item.length > 256)) throw new AppError("invalid_job_data");
    const keys = Reflect.ownKeys(item);
    if (keys.length > (array ? 257 : 256) || keys.some(key => typeof key !== "string") ||
        (!array && !exact(item, keys as string[])) || (array && keys.length !== item.length + 1)) throw new AppError("invalid_job_data");
    const descriptors = Object.getOwnPropertyDescriptors(item);
    for (const key of keys as string[]) {
      if (array && key === "length") continue;
      consume(key.length);
      if (!descriptors[key]!.enumerable || !("value" in descriptors[key]!)) throw new AppError("invalid_job_data");
    }
    seen.add(item);
    let result: JobData;
    if (array) {
      const values: JobData[] = [];
      for (let index = 0; index < item.length; index++) {
        if (!Object.hasOwn(descriptors, String(index))) throw new AppError("invalid_job_data");
        values.push(visit(descriptors[String(index)]!.value, depth + 1));
      }
      result = values;
    } else result = Object.fromEntries((keys as string[]).sort().map(key => [key, visit(descriptors[key]!.value, depth + 1)]));
    seen.delete(item); return result;
  }
  const text = JSON.stringify(visit(value, 0));
  if (Buffer.byteLength(text) > bytes) throw new AppError("invalid_job_data");
  return text;
}

/** Rejects missing, nonpositive, unbounded or above-policy job ceilings before acknowledgment. */
export function validateJobLimits(value: unknown, maximum: JobLimits): asserts value is JobLimits {
  if (!exact(value, limitKeys) || limitKeys.some(key => !Object.hasOwn(value as object, key) || !positive((value as JobLimits)[key as keyof JobLimits], maximum[key as keyof JobLimits]))) {
    throw new AppError("invalid_job_limits");
  }
}

/** Produces the shared receipt identity without letting unknown command fields disappear in hashing. */
export function jobCommandIdentity(command: JobCommand, inputBytes: number): string {
  if (!exact(command, ["kind", "requestId", "projectId", "expectedRevision", "payload"]) ||
      !["job.enqueue", "job.resume", "job.stop"].includes(command.kind) || typeof command.requestId !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(command.requestId) ||
      !/^[a-f0-9-]{36}$/.test(command.projectId) || !Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0) {
    throw new AppError("invalid_job_command");
  }
  const keys = command.kind === "job.enqueue" ? ["type", "configurationRevision", "policyRevision", "purpose", "inputRevision", "input", "priority", "limits"] : ["jobId"];
  if (!exact(command.payload, keys) || keys.some(key => !Object.hasOwn(command.payload, key))) throw new AppError("invalid_job_command");
  return hash(jobData(command, inputBytes));
}

/** Reads committed jobs in immutable insertion order without admitting or contacting anything. */
export function readJobs(tx: AppTransaction, projectId: string, after: number, size: number) {
  if (!Number.isSafeInteger(after) || after < 0) throw new AppError("invalid_cursor");
  const rows = tx.all<{ sequence: number; record_json: string }>("SELECT sequence, record_json FROM jobs WHERE project_id = ? AND sequence > ? ORDER BY sequence LIMIT ?", projectId, after, size + 1);
  return { items: rows.slice(0, size).map(row => JSON.parse(row.record_json) as Job), hasMore: rows.length > size,
    nextAfter: rows.slice(0, size).at(-1)?.sequence ?? after };
}

/** Resolves an exact project-scoped job; its ID never broadens authorization scope. */
export function readJob(tx: AppTransaction, projectId: string, jobId: string): Job {
  const row = tx.get<{ record_json: string }>("SELECT record_json FROM jobs WHERE project_id = ? AND id = ?", projectId, jobId);
  if (!row) throw new AppError("job_not_found", 404);
  return JSON.parse(row.record_json) as Job;
}

/** Projects a live wall budget at read time without mutating committed state or replay receipts. */
export function projectJob(job: Job, now: number): Job {
  if (!Number.isSafeInteger(now) || now < 0) throw new AppError("invalid_job_clock");
  if (!["queued", "admitted", "waiting"].includes(job.state)) return job;
  return { ...job, remaining: { ...job.remaining, wallMs: Math.max(0, Math.min(job.remaining.wallMs, job.deadlineAt - now)) } };
}

/** Injectable process/clock/timer ports keep scheduler ownership and deadlines deterministic in tests. */
export interface SchedulerOptions {
  leaseMs?: number;
  now?: () => number; pid?: number; isAlive?: (pid: number) => boolean;
  timers?: { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void };
}

/** Owns one local scheduler, durable admission and usage reservations, never a model/tool protocol loop. */
export class JobQueue {
  readonly policy: JobPolicy;
  #definitions = new Map<string, { definition: WorkDefinition; fingerprint: string }>();
  #token = crypto.randomUUID(); #pid: number; #now: () => number;
  #timers: NonNullable<SchedulerOptions["timers"]>;
  #active = new Map<string, { attemptId: string; abort: AbortController; timer: unknown; promise: Promise<unknown> }>();
  #closing = false; #fault = false; #leaseMs: number;

  constructor(readonly store: TransactionStore, policy: JobPolicy, definitions: WorkDefinition[], options: SchedulerOptions = {}) {
    this.policy = structuredClone(policy);
    if (!exact(policy, ["revision", "queueLimit", "concurrency", "routeConcurrency", "inputBytes", "outputBytes", "maximum"]) ||
        !positive(policy.revision) || !positive(policy.queueLimit, 10_000) || !positive(policy.concurrency, 32) ||
        !positive(policy.routeConcurrency, policy.concurrency) || !positive(policy.inputBytes, 65_536) || !positive(policy.outputBytes, 65_536)) throw new AppError("invalid_job_policy");
    validateJobLimits(policy.maximum, { roles: 10_000, calls: 10_000, rounds: 10_000, hops: 10_000, contextTokens: 1_000_000_000, outputTokens: 1_000_000_000, retries: 100, wallMs: 3_600_000 });
    Object.freeze(this.policy.maximum); Object.freeze(this.policy);
    this.#pid = options.pid ?? process.pid; if (!positive(this.#pid, 2_147_483_647)) throw new AppError("invalid_job_policy");
    this.#now = options.now ?? Date.now;
    this.#timers = options.timers ?? { set: (fn, ms) => setTimeout(fn, ms), clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) };
    this.#time();
    this.#leaseMs = options.leaseMs ?? 60_000;
    if (!positive(this.#leaseMs, 3_600_000)) throw new AppError("invalid_job_policy");
    if (!Array.isArray(definitions) || definitions.length > 32) throw new AppError("invalid_work_definition");
    for (const raw of definitions) {
      const { run, validate, prepare, isCurrent, ...metadata } = raw, definition: WorkDefinition = { ...structuredClone(metadata), run, validate, ...(prepare ? { prepare } : {}), ...(isCurrent ? { isCurrent } : {}) };
      if (!id(raw.id) || this.#definitions.has(raw.id) || !positive(raw.revision) || typeof raw.title !== "string" || !raw.title.length || raw.title.length > 120 ||
          typeof run !== "function" || typeof validate !== "function" || (raw.replay !== undefined && !["read", "mutation", "send"].includes(raw.replay)) ||
          (prepare !== undefined && typeof prepare !== "function") || (isCurrent !== undefined && typeof isCurrent !== "function") || !exact(raw.route, ["provider", "model", "authRoute"]) ||
          !id(raw.route.provider) || (raw.route.model !== null && !id(raw.route.model)) || !id(raw.route.authRoute)) throw new AppError("invalid_work_definition");
      this.#usage(raw.cost);
      if (["roles", "calls", "rounds", "hops"].some(key => !positive(raw.cost[key as keyof JobUsage]))) throw new AppError("invalid_work_definition");
      const fingerprint = hash(jobData({ id: raw.id, revision: raw.revision, route: raw.route, cost: raw.cost, replay: raw.replay ?? "manual" }, policy.inputBytes));
      this.#definitions.set(raw.id, { definition, fingerprint });
    }
    const isAlive = options.isAlive ?? ((pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; } });
    store.transaction(tx => {
      const owner = tx.get<{ pid: number }>("SELECT pid FROM job_scheduler WHERE id = 1");
      if (owner && (!positive(owner.pid, 2_147_483_647) || isAlive(owner.pid))) throw new AppError("scheduler_unavailable", 503);
      const recoverIds = new Set<string>();
      for (const row of tx.all<{ record_json: string }>("SELECT record_json FROM jobs WHERE occupies = 1 OR state = 'admitted'")) {
        recoverIds.add(JSON.parse(row.record_json).id);
      }
      // Unsettled early yield/wait may have cleared occupancy incorrectly; still recover by transport evidence.
      for (const row of tx.all<{ job_id: string; record_json: string }>("SELECT job_id, record_json FROM job_attempts")) {
        const attempt = JSON.parse(row.record_json) as JobAttempt;
        if (attempt.transport === "dispatched") recoverIds.add(row.job_id);
      }
      for (const id of recoverIds) {
        const row = tx.get<{ record_json: string }>("SELECT record_json FROM jobs WHERE id = ?", id);
        if (!row) continue;
        const job = JSON.parse(row.record_json) as Job;
        // Preserve settlement uncertainty for admitted work and for queued/waiting jobs with unsettled workers.
        if (job.state === "admitted" || (["queued", "waiting"].includes(job.state) && (job.occupiesAdmission || unsettledTransportAttempts(tx, job.id).length))) {
          invalidateJob(tx, job.id, "interrupted", this.#time());
          this.#transition(job, "waiting", "interrupted");
        }
        const authority = tx.get<{ stop_json: string | null }>("SELECT stop_json FROM job_authority WHERE job_id = ?", job.id);
        if (authority?.stop_json) { const stop = JSON.parse(authority.stop_json); if (stop.transport === "cancellation_requested") { stop.transport = "unknown";
          tx.run("UPDATE job_authority SET stop_json = ? WHERE job_id = ?", JSON.stringify(stop), job.id); } }
        this.#save(tx, job, false);
      }
      tx.run("INSERT OR REPLACE INTO job_scheduler VALUES (1, ?, ?)", this.#token, this.#pid);
    });
  }

  /** Lists inert registered choices and limits; discovery does not start work or verify a real provider. */
  choices() { return [...this.#definitions.values()].map(({ definition: d }) => ({ id: d.id, title: d.title, revision: d.revision, policyRevision: this.policy.revision, route: structuredClone(d.route) })); }

  /** Requires the still-owned scheduler before a new command can be acknowledged. */
  assertOwner(tx: AppTransaction): void {
    if (!this.available(tx)) throw new AppError("scheduler_unavailable", 503);
  }

  /** Reports local admission availability without contacting or claiming readiness for a provider. */
  available(tx: AppTransaction): boolean { return !this.#closing && !this.#fault && this.#owns(tx); }

  /** Mutates only inside the authenticated application's receipt/audit transaction. */
  execute(tx: AppTransaction, command: JobCommand, generation: number, now: number) {
    this.assertOwner(tx);
    if (!Number.isSafeInteger(now) || now < 0) throw new AppError("invalid_job_clock");
    if (command.kind === "job.stop") {
      const job = readJob(tx, command.projectId, command.payload.jobId);
      if (job.revision !== command.expectedRevision) throw new AppError("stale_revision", 409);
      if (["succeeded", "partial", "failed", "blocked"].includes(job.state) && job.reason !== "cancelled") throw new AppError("job_already_terminal", 409);
      const stop = invalidateJob(tx, job.id, "cancelled", now, true)!;
      this.#transition(job, "blocked", "cancelled"); this.#save(tx, job, job.occupiesAdmission);
      return { job, stop };
    }
    if (command.kind === "job.resume") {
      const job = readJob(tx, command.projectId, command.payload.jobId);
      if (job.revision !== command.expectedRevision) throw new AppError("stale_revision", 409);
      // Native transports must settle before resume; local-only dispatched workers die with the process.
      if (job.state !== "waiting" || this.#active.has(job.id) || unsettledTransportAttempts(tx, job.id).some(a => a.native)) {
        throw new AppError("job_not_resumable", 409);
      }
      const entry = this.#definitions.get(job.type);
      if (!entry || entry.fingerprint !== job.configuration.fingerprint || job.configuration.policyRevision !== this.policy.revision) throw new AppError("job_configuration_changed", 409);
      if (job.remaining.retries < 1 || now >= job.deadlineAt) {
        this.#transition(job, now >= job.deadlineAt ? "failed" : "blocked", now >= job.deadlineAt ? "deadline" : "budget_exhausted");
        this.#save(tx, job, false); return { job };
      }
      if (job.reason === "interrupted" && entry.definition.replay !== "read") throw new AppError("job_requires_manual_reconciliation", 409);
      if (readAttempts(tx, job.id).some(a => a.native && !["retired", "deleted"].includes(a.contextState))) throw new AppError("job_context_reconciliation_required", 409);
      validateJobLimits(job.limits, this.policy.maximum);
      job.remaining.retries--; job.authorization = { ownerId: "owner", generation, requestId: command.requestId };
      this.#transition(job, "queued", "queued"); this.#save(tx, job, false, true); return { job };
    }
    const p = command.payload, entry = this.#definitions.get(p.type);
    if (!entry || p.configurationRevision !== entry.definition.revision || p.policyRevision !== this.policy.revision || typeof p.purpose !== "string" || !p.purpose.trim() || p.purpose.length > 300 ||
        !positive(p.inputRevision) || !["interactive", "background"].includes(p.priority)) throw new AppError("invalid_job_command");
    validateJobLimits(p.limits, this.policy.maximum);
    const project = tx.get<{ revision: number }>("SELECT revision FROM projects WHERE id = ?", command.projectId);
    if (project?.revision !== command.expectedRevision) throw new AppError("stale_revision", 409);
    const input = JSON.parse(jobData(p.input, this.policy.inputBytes)) as JobData;
    if (!entry.definition.validate(input, { projectId: command.projectId, projectRevision: project.revision, inputRevision: p.inputRevision })) throw new AppError("invalid_job_input");
    const count = tx.get<{ count: number }>("SELECT count(*) AS count FROM jobs WHERE state IN ('queued', 'admitted', 'waiting')")!.count;
    if (count >= this.policy.queueLimit) throw new AppError("job_queue_full", 429);
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(now + p.limits.wallMs)) throw new AppError("invalid_job_clock");
    const job: Job = { id: crypto.randomUUID(), projectId: command.projectId, revision: 1, type: p.type, purpose: p.purpose.trim(), priority: p.priority,
      inputRevision: p.inputRevision, input, authorization: { ownerId: "owner", generation, requestId: command.requestId },
      configuration: { revision: entry.definition.revision, policyRevision: this.policy.revision, fingerprint: entry.fingerprint }, route: structuredClone(entry.definition.route),
      limits: structuredClone(p.limits), remaining: structuredClone(p.limits), state: "queued", reason: "queued", nextAction: "wait_for_admission",
      createdAt: now, updatedAt: now, deadlineAt: now + p.limits.wallMs, steps: 0, checkpoint: null, evidence: null, occupiesAdmission: false };
    tx.run("INSERT INTO jobs (id, project_id, queue_order, priority, state, occupies, route_key, record_json) VALUES (?, ?, ?, ?, ?, 0, ?, ?)",
      job.id, job.projectId, this.#order(tx), job.priority === "interactive" ? 1 : 0, job.state, routeKey(job.route), JSON.stringify(job));
    tx.run("INSERT INTO job_authority VALUES (?, 1, NULL, NULL)", job.id);
    return { job };
  }

  /** Admits only available capacity in priority order; it never waits for or preempts an existing call. */
  pump(): void {
    try {
      for (;;) {
        const admitted = this.store.transaction(tx => {
          this.assertOwner(tx);
          const occupied = tx.get<{ count: number }>("SELECT count(*) AS count FROM jobs WHERE occupies = 1")!.count;
          const candidates = tx.all<{ record_json: string }>("SELECT record_json FROM jobs WHERE state IN ('queued', 'waiting') ORDER BY priority DESC, queue_order LIMIT ?", this.policy.queueLimit);
          for (const row of candidates) {
            const job = JSON.parse(row.record_json) as Job, entry = this.#definitions.get(job.type);
            const generation = tx.get<{ generation: number }>("SELECT generation FROM owner WHERE id = 'owner'")?.generation;
            const project = tx.get<{ revision: number }>("SELECT revision FROM projects WHERE id = ?", job.projectId);
            let reason: JobReason | null = generation !== job.authorization.generation ? "authorization_changed"
              : !entry || entry.fingerprint !== job.configuration.fingerprint || job.configuration.policyRevision !== this.policy.revision ? "configuration_changed"
              : this.#time() >= job.deadlineAt ? "deadline" : null;
            try { validateJobLimits(job.limits, this.policy.maximum); } catch { reason = "configuration_changed"; }
            if (!reason) { try { if (!entry!.definition.validate(job.input, { projectId: job.projectId, projectRevision: project?.revision ?? -1, inputRevision: job.inputRevision })) reason = "input_changed"; } catch { reason = "input_changed"; } }
            // Occupancy must outlive yield/freshness until the in-process worker settles.
            if (reason) {
              this.#transition(job, reason === "deadline" ? "failed" : "blocked", reason);
              this.#save(tx, job, this.#active.has(job.id));
              continue;
            }
            // An unsettled in-process worker (including early yield commit) still owns this job.
            if (job.state === "waiting" || occupied >= this.policy.concurrency || this.#active.has(job.id)) continue;
            const routeSlots = tx.get<{ count: number }>("SELECT count(*) AS count FROM jobs WHERE occupies = 1 AND route_key = ?", routeKey(job.route))!.count;
            if (routeSlots >= this.policy.routeConcurrency) continue;
            if (!this.#spend(job, entry!.definition.cost)) { this.#save(tx, job, false); continue; }
            job.steps++; this.#transition(job, "admitted", "running"); this.#save(tx, job, true);
            tx.run("UPDATE job_authority SET generation = generation + 1, reason = NULL WHERE job_id = ?", job.id);
            const attemptGeneration = tx.get<{ generation: number }>("SELECT generation FROM job_authority WHERE job_id = ?", job.id)!.generation;
            let preparation: { native: JobAttempt["native"]; data: JobAttempt["data"] };
            try {
              preparation = entry!.definition.prepare?.(tx, structuredClone(job), attemptGeneration) ?? { native: null, data: null };
              // TEAM accepts request bodies up to 64KiB; the attempt envelope adds small native refs beyond that.
              jobData(preparation.data, 65_536);
              jobData({ native: preparation.native }, 4096);
            } catch (error) {
              // Fail this job only; a single oversized/invalid preparation must not disable the scheduler.
              if (!(error instanceof AppError)) throw error;
              this.#transition(job, "blocked", "configuration_changed"); this.#save(tx, job, false); continue;
            }
            const attempt: JobAttempt = { ...preparation, id: crypto.randomUUID(), jobId: job.id, generation: attemptGeneration,
              scheduler: this.#token, leaseUntil: Math.min(job.deadlineAt, this.#time() + this.#leaseMs), snapshot: structuredClone(job), createdAt: this.#time(),
              state: "prepared", reason: null, nativeState: "uninspected", contextState: preparation.native ? "pending" : "none", transport: "none" };
            tx.run("INSERT INTO job_attempts (id, job_id, record_json) VALUES (?, ?, ?)", attempt.id, job.id, JSON.stringify(attempt));
            return { job, attempt, definition: entry!.definition };
          }
          return null;
        });
        if (!admitted) return;
        this.#start(admitted.job, admitted.definition, admitted.attempt);
      }
    } catch (error) { this.#fault = true; throw error instanceof AppError ? error : new AppError("storage_unavailable", 503); }
  }

  /** Waits for currently admitted scripted steps; callers must not await a deliberately stalled adapter. */
  async idle(): Promise<void> { await Promise.all([...this.#active.values()].map(item => item.promise)); }

  /** Stops admission and requests cancellation, retaining ownership while any adapter is still running. */
  close(): void {
    this.#closing = true;
    this.store.transaction(tx => {
      if (!this.#owns(tx)) return;
      for (const id of this.#active.keys()) {
        const attempts = readAttempts(tx, id), original = attempts.at(-1)?.snapshot;
        if (!original) continue;
        const job = readJob(tx, original.projectId, id);
        if (job.state === "admitted") { invalidateJob(tx, id, "interrupted", this.#time()); this.#transition(job, "waiting", "interrupted"); this.#save(tx, job, true); }
      }
    });
    for (const item of this.#active.values()) item.abort.abort();
    if (!this.#active.size) this.#release();
  }

  /** Reconciles persisted references without dispatching or accepting native output. */
  async reconcile(port: ApplicationRunPort) {
    this.store.read(tx => this.assertOwner(tx));
    return reconcileSessions(this.store, port, this.#time(), () => this.cancelFenced());
  }

  /** Service lifecycle port: fence first, then await retirement/deletion acknowledgment before replacement. */
  async retireContext(port: ApplicationRunPort, context: ManagedContextReference, deleteRequested = false) {
    this.store.read(tx => this.assertOwner(tx));
    return reconcileContext(this.store, port, { id: `context:${context.id}:${context.generation}`, kind: "context", context,
      appState: "missing", nativeState: "unknown", lifecycle: "pending", deleteRequested, nextAction: "await_managed_retirement" }, this.#time(), () => this.cancelFenced());
  }

  /** Requests transport cancellation after an owner stop or service revocation transaction has committed. */
  cancelFenced(): void {
    for (const [id, item] of this.#active) {
      const fenced = this.store.read(tx => tx.get<{ reason: string | null }>("SELECT reason FROM job_authority WHERE job_id = ?", id)?.reason);
      if (fenced) item.abort.abort();
    }
  }

  /** Trusted standing-authorization/source adapters invalidate all affected jobs in their own state transaction. */
  invalidate(tx: AppTransaction, projectId: string, jobId: string, reason: "revoked" | "superseded" | "source_retired" | "context_retired"): void {
    const job = readJob(tx, projectId, jobId);
    if (["succeeded", "partial", "failed", "blocked"].includes(job.state)) return;
    invalidateJob(tx, jobId, reason, this.#time()); this.#transition(job, "blocked", reason); this.#save(tx, job, job.occupiesAdmission);
  }

  #current(tx: AppTransaction, original: Job, attempt: JobAttempt): JobReason | null {
    const reason = attemptAuthority(tx, attempt, this.#time()); if (reason) return reason;
    const current = readJob(tx, original.projectId, original.id), entry = this.#definitions.get(current.type);
    if (current.state !== "admitted" || current.steps !== original.steps) return "interrupted";
    const snapshot = attempt.snapshot;
    if (jobData(current.authorization, 1024) !== jobData(snapshot.authorization, 1024)) return "authorization_changed";
    if (current.inputRevision !== snapshot.inputRevision || jobData(current.input, this.policy.inputBytes) !== jobData(snapshot.input, this.policy.inputBytes)) return "input_changed";
    if (jobData(current.configuration, 1024) !== jobData(snapshot.configuration, 1024) || jobData(current.route, 1024) !== jobData(snapshot.route, 1024)) return "configuration_changed";
    if (!entry || entry.fingerprint !== current.configuration.fingerprint || current.configuration.policyRevision !== this.policy.revision) return "configuration_changed";
    const revision = tx.get<{ revision: number }>("SELECT revision FROM projects WHERE id = ?", current.projectId)?.revision ?? -1;
    try {
      if (!entry.definition.validate(current.input, { projectId: current.projectId, projectRevision: revision, inputRevision: current.inputRevision }) ||
          (entry.definition.isCurrent && !entry.definition.isCurrent(tx, current, attempt))) return "input_changed";
    } catch { return "input_changed"; }
    return null;
  }

  #start(job: Job, definition: WorkDefinition, attempt: JobAttempt) {
    const abort = new AbortController();
    const timer = this.#timers.set(() => {
      try { this.store.transaction(tx => {
        if (!this.#owns(tx)) return;
        const current = readJob(tx, job.projectId, job.id);
        if (current.state === "admitted") { const reason = this.#time() >= job.deadlineAt ? "deadline" : "lease_expired";
          invalidateJob(tx, job.id, reason, this.#time()); this.#transition(current, "failed", reason); this.#save(tx, current, true); }
      }); } catch { this.#fault = true; }
      abort.abort();
    }, Math.max(0, attempt.leaseUntil - this.#time()));
    const promise = Promise.resolve().then(() => {
      this.store.transaction(tx => {
        this.assertOwner(tx); const current = readAttempt(tx, attempt.id);
        if (abort.signal.aborted || this.#current(tx, job, current)) throw new AppError("job_interrupted");
        current.state = "dispatched";
        current.transport = "dispatched";
        if (current.nativeState === "uninspected") current.nativeState = current.native ? "running" : "missing";
        saveAttempt(tx, current);
      });
      return definition.run({ job: structuredClone(job), attempt: structuredClone(attempt), signal: abort.signal,
        commit: (outcome, mutate) => this.#finish(job, attempt, outcome, mutate),
        reserve: usage => {
          const ok = this.store.transaction(tx => {
            this.assertOwner(tx); const current = readJob(tx, job.projectId, job.id);
            if (this.#current(tx, job, readAttempt(tx, attempt.id))) return false;
            const spent = this.#spend(current, usage); this.#save(tx, current, true); return spent;
          });
          if (!ok) { abort.abort(); throw new AppError("job_budget_exhausted"); }
        } });
    }).then(outcome => this.#finish(job, attempt, outcome), () => this.#finish(job, attempt, { state: "failed", reason: "worker_failed" })).finally(() => {
      this.#timers.clear(timer);
      // Only the worker that still owns this job may clear tracking or release admission.
      const tracked = this.#active.get(job.id);
      if (!tracked || tracked.attemptId !== attempt.id) return;
      this.#active.delete(job.id);
      try { this.store.transaction(tx => {
        if (!this.#owns(tx)) return;
        const current = readJob(tx, job.projectId, job.id);
        const live = readAttempt(tx, attempt.id);
        live.transport = "settled";
        saveAttempt(tx, live);
        const authority = tx.get<{ stop_json: string | null }>("SELECT stop_json FROM job_authority WHERE job_id = ?", job.id);
        if (authority?.stop_json) {
          const stop = JSON.parse(authority.stop_json);
          const watched = Array.isArray(stop.attemptIds) ? stop.attemptIds.includes(attempt.id) : stop.transport !== "not_dispatched";
          if (watched && stop.transport !== "not_dispatched") {
            stop.transport = "observed_stopped";
            tx.run("UPDATE job_authority SET stop_json = ? WHERE job_id = ?", JSON.stringify(stop), job.id);
          }
        }
        // Failed result commits leave admitted+dispatched; mark interrupted so reopen/resume can reconcile.
        if (current.state === "admitted" && current.steps === attempt.snapshot.steps) {
          invalidateJob(tx, current.id, "interrupted", this.#time());
          this.#transition(current, "waiting", "interrupted");
          this.#save(tx, current, false);
        } else if (current.occupiesAdmission && current.steps === attempt.snapshot.steps) this.#save(tx, current, false);
      }); } catch { this.#fault = true; }
      if (this.#closing && !this.#active.size) this.#release();
    });
    this.#active.set(job.id, { attemptId: attempt.id, abort, timer, promise });
  }

  #finish(original: Job, reference: JobAttempt, outcome: WorkOutcome, mutate?: (tx: AppTransaction) => void): boolean {
    try {
      if (outcome?.state === "yield") jobData(outcome.checkpoint, this.policy.inputBytes);
      if (outcome?.state === "waiting" && outcome.checkpoint !== undefined) jobData(outcome.checkpoint, this.policy.inputBytes);
    } catch { outcome = { state: "failed", reason: "worker_failed" }; mutate = undefined; }
    try {
      return this.store.transaction(tx => {
        if (!this.#owns(tx)) return false;
        const attempt = readAttempt(tx, reference.id), job = readJob(tx, original.projectId, original.id);
        if (attempt.state === "committed") return false;
        const reason = this.#current(tx, original, attempt);
        if (reason || this.#closing) {
          attempt.state = "rejected"; attempt.reason = reason ?? "interrupted"; saveAttempt(tx, attempt);
          if (job.state === "admitted") { this.#transition(job, reason === "deadline" || reason === "lease_expired" ? "failed" : "blocked", reason ?? "interrupted"); this.#save(tx, job, true); }
          return false;
        }
        let accepted = false;
        if (outcome?.state === "succeeded" && typeof outcome.evidence === "string" && outcome.evidence.length && Buffer.byteLength(outcome.evidence) <= this.policy.outputBytes) {
          mutate?.(tx); job.evidence = outcome.evidence; this.#transition(job, "succeeded", "complete"); accepted = true;
        } else if (outcome?.state === "yield") {
          job.checkpoint = JSON.parse(jobData(outcome.checkpoint, this.policy.inputBytes)); this.#transition(job, "queued", "yielded"); accepted = true;
        } else if (outcome?.state === "waiting" && ["quota", "needs_login", "route_unavailable"].includes(outcome.reason)) {
          if (outcome.checkpoint !== undefined) job.checkpoint = JSON.parse(jobData(outcome.checkpoint, this.policy.inputBytes));
          this.#transition(job, job.remaining.retries ? "waiting" : "blocked", job.remaining.retries ? outcome.reason : "budget_exhausted");
          accepted = true;
        } else if (outcome?.state === "failed" && typeof outcome.evidence === "string" && outcome.evidence.length && Buffer.byteLength(outcome.evidence) <= this.policy.outputBytes) {
          job.evidence = outcome.evidence; this.#transition(job, "partial", "worker_failed");
        } else this.#transition(job, "failed", "worker_failed");
        attempt.state = "committed"; attempt.reason = job.reason; saveAttempt(tx, attempt);
        // Keep occupancy until the worker finalizer settles, including early yield/wait commits.
        this.#save(tx, job, true, job.state === "queued"); return accepted;
      });
    } catch { this.#fault = true; return false; }
  }

  #usage(value: JobUsage) {
    if (!exact(value, [...counters]) || !Object.values(value).some(n => n > 0) || Object.values(value).some(n => !Number.isSafeInteger(n) || n < 0 || n > 1_000_000_000)) throw new AppError("invalid_job_usage");
  }
  #spend(job: Job, usage: JobUsage) {
    this.#usage(usage);
    const amount = (key: typeof counters[number]) => Object.hasOwn(usage, key) ? usage[key]! : 0;
    if (counters.some(key => amount(key) > job.remaining[key])) { this.#transition(job, job.evidence ? "partial" : "blocked", "budget_exhausted"); return false; }
    for (const key of counters) job.remaining[key] -= amount(key);
    return true;
  }
  #time() { const now = this.#now(); if (!Number.isSafeInteger(now) || now < 0) throw new AppError("invalid_job_clock"); return now; }
  #owns(tx: AppTransaction) { return tx.get<{ token: string }>("SELECT token FROM job_scheduler WHERE id = 1")?.token === this.#token; }
  #order(tx: AppTransaction) { const next = tx.get<{ value: number }>("SELECT coalesce(max(queue_order), 0) + 1 AS value FROM jobs")!.value; if (!positive(next)) throw new AppError("job_queue_full", 429); return next; }
  #save(tx: AppTransaction, job: Job, occupies: boolean, requeue = false) {
    job.revision++;
    job.occupiesAdmission = occupies;
    job.nextAction = occupies && job.state !== "admitted" ? "wait_for_adapter_to_stop" : job.state === "queued" ? "wait_for_admission"
      : job.state === "admitted" ? "wait_for_running_work" : job.state === "waiting" ? job.reason === "interrupted" ? "inspect_interrupted_work_then_resume" : "resolve_same_route_then_resume"
      : job.state === "succeeded" ? "inspect_committed_evidence" : "inspect_reason_and_authorize_new_work";
    job.updatedAt = Math.max(job.updatedAt, this.#time()); job.remaining.wallMs = Math.max(0, job.deadlineAt - job.updatedAt);
    if (requeue) tx.run("UPDATE jobs SET queue_order = ? WHERE id = ?", this.#order(tx), job.id);
    tx.run("UPDATE jobs SET state = ?, occupies = ?, record_json = ? WHERE id = ?", job.state, occupies ? 1 : 0, JSON.stringify(job), job.id);
  }
  #transition(job: Job, state: Job["state"], reason: JobReason) {
    job.state = state; job.reason = reason;
  }
  #release() { try { this.store.transaction(tx => { if (this.#owns(tx)) tx.run("DELETE FROM job_scheduler WHERE id = 1"); }); } catch { this.#fault = true; } }
}
