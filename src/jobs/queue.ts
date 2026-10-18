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

/** Canonicalizes bounded JSON data while rejecting cycles, non-finite numbers and executable values. */
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
    const keys = Object.keys(item);
    if (keys.length > 256) throw new AppError("invalid_job_data");
    for (const key of keys) consume(key.length);
    if ((!Array.isArray(item) && !exact(item, keys)) || Object.getOwnPropertySymbols(item).length ||
        Object.values(Object.getOwnPropertyDescriptors(item)).some(descriptor => !("value" in descriptor))) throw new AppError("invalid_job_data");
    seen.add(item);
    const result: JobData = Array.isArray(item) ? item.map(x => visit(x, depth + 1))
      : Object.fromEntries(keys.sort().map(key => [key, visit((item as Record<string, unknown>)[key], depth + 1)]));
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
      !["job.enqueue", "job.resume"].includes(command.kind) || typeof command.requestId !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(command.requestId) ||
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

/** Injectable process/clock/timer ports keep scheduler ownership and deadlines deterministic in tests. */
export interface SchedulerOptions {
  now?: () => number; pid?: number; isAlive?: (pid: number) => boolean;
  timers?: { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void };
}

/** Owns one local scheduler, durable admission and usage reservations, never a model/tool protocol loop. */
export class JobQueue {
  readonly policy: JobPolicy;
  #definitions = new Map<string, { definition: WorkDefinition; fingerprint: string }>();
  #token = crypto.randomUUID(); #pid: number; #now: () => number;
  #timers: NonNullable<SchedulerOptions["timers"]>;
  #active = new Map<string, { abort: AbortController; timer: unknown; promise: Promise<void> }>();
  #closing = false; #fault = false;

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
    if (!Array.isArray(definitions) || definitions.length > 32) throw new AppError("invalid_work_definition");
    for (const raw of definitions) {
      const { run, validate } = raw, definition = { ...structuredClone({ ...raw, run: undefined, validate: undefined }), run, validate };
      if (!id(raw.id) || this.#definitions.has(raw.id) || !positive(raw.revision) || typeof raw.title !== "string" || !raw.title.length || raw.title.length > 120 ||
          typeof run !== "function" || typeof validate !== "function" || !exact(raw.route, ["provider", "model", "authRoute"]) ||
          !id(raw.route.provider) || (raw.route.model !== null && !id(raw.route.model)) || !id(raw.route.authRoute)) throw new AppError("invalid_work_definition");
      this.#usage(raw.cost);
      if (["roles", "calls", "rounds", "hops"].some(key => !positive(raw.cost[key as keyof JobUsage]))) throw new AppError("invalid_work_definition");
      const fingerprint = hash(jobData({ id: raw.id, revision: raw.revision, route: raw.route, cost: raw.cost }, policy.inputBytes));
      this.#definitions.set(raw.id, { definition, fingerprint });
    }
    const isAlive = options.isAlive ?? ((pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; } });
    store.transaction(tx => {
      const owner = tx.get<{ pid: number }>("SELECT pid FROM job_scheduler WHERE id = 1");
      if (owner && (!positive(owner.pid, 2_147_483_647) || isAlive(owner.pid))) throw new AppError("scheduler_unavailable", 503);
      for (const row of tx.all<{ record_json: string }>("SELECT record_json FROM jobs WHERE occupies = 1")) {
        const job = JSON.parse(row.record_json) as Job;
        if (job.state === "admitted") this.#transition(job, "waiting", "interrupted");
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
    if (command.kind === "job.resume") {
      const job = readJob(tx, command.projectId, command.payload.jobId);
      if (job.revision !== command.expectedRevision) throw new AppError("stale_revision", 409);
      if (job.state !== "waiting" || this.#active.has(job.id)) throw new AppError("job_not_resumable", 409);
      const entry = this.#definitions.get(job.type);
      if (!entry || entry.fingerprint !== job.configuration.fingerprint || job.configuration.policyRevision !== this.policy.revision) throw new AppError("job_configuration_changed", 409);
      if (job.remaining.retries < 1 || now >= job.deadlineAt) {
        this.#transition(job, now >= job.deadlineAt ? "failed" : "blocked", now >= job.deadlineAt ? "deadline" : "budget_exhausted");
        this.#save(tx, job, false); return { job };
      }
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
            if (reason) { this.#transition(job, reason === "deadline" ? "failed" : "blocked", reason); this.#save(tx, job, false); continue; }
            if (job.state === "waiting" || occupied >= this.policy.concurrency) continue;
            const routeSlots = tx.get<{ count: number }>("SELECT count(*) AS count FROM jobs WHERE occupies = 1 AND route_key = ?", routeKey(job.route))!.count;
            if (routeSlots >= this.policy.routeConcurrency) continue;
            if (!this.#spend(job, entry!.definition.cost)) { this.#save(tx, job, false); continue; }
            job.steps++; this.#transition(job, "admitted", "running"); this.#save(tx, job, true); return { job, definition: entry!.definition };
          }
          return null;
        });
        if (!admitted) return;
        this.#start(admitted.job, admitted.definition);
      }
    } catch (error) { this.#fault = true; throw error instanceof AppError ? error : new AppError("storage_unavailable", 503); }
  }

  /** Waits for currently admitted scripted steps; callers must not await a deliberately stalled adapter. */
  async idle(): Promise<void> { await Promise.all([...this.#active.values()].map(item => item.promise)); }

  /** Stops admission and requests cancellation, retaining ownership while any adapter is still running. */
  close(): void {
    this.#closing = true;
    for (const item of this.#active.values()) item.abort.abort();
    if (!this.#active.size) this.#release();
  }

  #start(job: Job, definition: WorkDefinition) {
    const abort = new AbortController();
    const timer = this.#timers.set(() => {
      try { this.store.transaction(tx => { if (!this.#owns(tx)) return; const current = readJob(tx, job.projectId, job.id); if (current.state === "admitted") { this.#transition(current, "failed", "deadline"); this.#save(tx, current, true); } }); }
      catch { this.#fault = true; }
      abort.abort();
    }, Math.max(0, Math.min(job.remaining.wallMs, job.deadlineAt - this.#time())));
    const promise = Promise.resolve().then(() => {
      this.store.read(tx => { this.assertOwner(tx); if (abort.signal.aborted || this.#time() >= job.deadlineAt || readJob(tx, job.projectId, job.id).state !== "admitted" ||
        tx.get<{ generation: number }>("SELECT generation FROM owner WHERE id = 'owner'")?.generation !== job.authorization.generation) throw new AppError("job_interrupted"); });
      return definition.run({ job: structuredClone(job), signal: abort.signal, reserve: usage => {
      const ok = this.store.transaction(tx => {
        this.assertOwner(tx); const current = readJob(tx, job.projectId, job.id);
        if (current.state !== "admitted") return false;
        if (this.#time() >= current.deadlineAt) { this.#transition(current, "failed", "deadline"); this.#save(tx, current, true); return false; }
        if (tx.get<{ generation: number }>("SELECT generation FROM owner WHERE id = 'owner'")?.generation !== current.authorization.generation) {
          this.#transition(current, "blocked", "authorization_changed"); this.#save(tx, current, true); return false;
        }
        const spent = this.#spend(current, usage); this.#save(tx, current, true); return spent;
      });
      if (!ok) { abort.abort(); throw new AppError("job_budget_exhausted"); }
      } });
    }).then(outcome => this.#finish(job, outcome), () => this.#finish(job, { state: "failed", reason: "worker_failed" })).finally(() => {
      this.#timers.clear(timer); this.#active.delete(job.id); if (this.#closing && !this.#active.size) this.#release();
    });
    this.#active.set(job.id, { abort, timer, promise });
  }

  #finish(original: Job, outcome: WorkOutcome) {
    try {
      if (outcome?.state === "yield") jobData(outcome.checkpoint, this.policy.inputBytes);
      if (outcome?.state === "waiting" && outcome.checkpoint !== undefined) jobData(outcome.checkpoint, this.policy.inputBytes);
    } catch { outcome = { state: "failed", reason: "worker_failed" }; }
    try {
      this.store.transaction(tx => {
        if (!this.#owns(tx)) return;
        const job = readJob(tx, original.projectId, original.id);
        if (job.state === "admitted") {
          if (tx.get<{ generation: number }>("SELECT generation FROM owner WHERE id = 'owner'")?.generation !== job.authorization.generation) this.#transition(job, "blocked", "authorization_changed");
          else if (this.#closing) this.#transition(job, "waiting", "interrupted");
          else if (this.#time() >= job.deadlineAt) this.#transition(job, "failed", "deadline");
          else if (outcome?.state === "succeeded" && typeof outcome.evidence === "string" && outcome.evidence.length && Buffer.byteLength(outcome.evidence) <= this.policy.outputBytes) {
            job.evidence = outcome.evidence; this.#transition(job, "succeeded", "complete");
          } else if (outcome?.state === "yield") {
            job.checkpoint = JSON.parse(jobData(outcome.checkpoint, this.policy.inputBytes)); this.#transition(job, "queued", "yielded");
          } else if (outcome?.state === "waiting" && ["quota", "needs_login", "route_unavailable"].includes(outcome.reason)) {
            if (outcome.checkpoint !== undefined) job.checkpoint = JSON.parse(jobData(outcome.checkpoint, this.policy.inputBytes));
            this.#transition(job, job.remaining.retries ? "waiting" : "blocked", job.remaining.retries ? outcome.reason : "budget_exhausted");
          } else if (outcome?.state === "failed" && outcome.evidence && typeof outcome.evidence === "string" && Buffer.byteLength(outcome.evidence) <= this.policy.outputBytes) {
            job.evidence = outcome.evidence; this.#transition(job, "partial", "worker_failed");
          } else this.#transition(job, "failed", "worker_failed");
        }
        this.#save(tx, job, false, job.state === "queued");
      });
    } catch { this.#fault = true; }
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
