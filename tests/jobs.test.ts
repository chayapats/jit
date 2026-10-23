import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { Application, type ApplicationOptions } from "../src/application";
import { readConfig } from "../src/config";
import { TransactionStore, type AppTransaction } from "../src/store";
import { createWebHandler } from "../src/web";
import { JobQueue, jobData } from "../src/jobs/queue";
import { projectStateWork } from "../src/jobs/project-state";
import type { EnqueueJobCommand, Job, JobLimits, WorkDefinition, WorkOutcome } from "../src/jobs/types";

const password = "fixture-job-owner-password", epoch = 1_800_000_000_000;
const roots: string[] = [], stores: TransactionStore[] = [], queues: JobQueue[] = [], releases: (() => void)[] = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const queue of queues.splice(0)) { queue.close(); await queue.idle(); }
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
class Clock {
  now = epoch; #id = 0; #timers = new Map<number, { at: number; callback: () => void }>();
  timers = { set: (callback: () => void, ms: number) => { const id = ++this.#id; this.#timers.set(id, { at: this.now + ms, callback }); return id; }, clear: (id: unknown) => { this.#timers.delete(id as number); } };
  advance(ms: number) { this.now += ms; for (const [id, timer] of [...this.#timers]) if (timer.at <= this.now) { this.#timers.delete(id); timer.callback(); } }
}
const limits: JobLimits = { roles: 4, calls: 4, rounds: 4, hops: 4, contextTokens: 10, outputTokens: 10, retries: 2, wallMs: 1000 };
function definition(run: WorkDefinition["run"] = () => ({ state: "succeeded", evidence: "หลักฐาน 🧪" })): WorkDefinition {
  return { replay: "read", id: "fixture.work", title: "งานตรวจสอบ", revision: 1, route: { provider: "fixture", model: "scripted", authRoute: "subscription-a" },
    cost: { roles: 1, calls: 1, rounds: 1, hops: 1 }, validate: (input, scope) => !!input && typeof input === "object" && !Object.keys(input).length && scope.projectRevision === scope.inputRevision, run };
}
async function fixture(options: { definitions?: WorkDefinition[]; env?: Record<string, string>; leaseMs?: number; beforeCommit?: ApplicationOptions["beforeCommit"] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "jit-job01-")); roots.push(root);
  const path = join(root, "app.sqlite"), config = readConfig({ JIT_DATABASE: path, ...options.env }), store = new TransactionStore(path); stores.push(store);
  const clock = new Clock(), definitions = options.definitions ?? [definition()];
  const queue = new JobQueue(store, config.jobs, definitions, { now: () => clock.now, timers: clock.timers, ...(options.leaseMs ? { leaseMs: options.leaseMs } : {}) }); queues.push(queue);
  const app = new Application(store, config, { jobs: queue, now: () => clock.now, ...(options.beforeCommit ? { beforeCommit: options.beforeCommit } : {}) });
  await app.setupOwner(password); const token = await app.login(password), auth = app.authenticate(token);
  const project = app.execute(auth.actor, { kind: "project.create", requestId: crypto.randomUUID(), projectId: null, expectedRevision: 0, payload: { name: "โครงการ 🧪" } }).project;
  return { root, path, config, store, clock, queue, app, project, token, auth, definitions, web: createWebHandler(app) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function command(f: Fixture, payload: Partial<EnqueueJobCommand["payload"]> = {}): EnqueueJobCommand {
  return { kind: "job.enqueue", requestId: crypto.randomUUID(), projectId: f.project.id, expectedRevision: 1,
    payload: { type: f.definitions[0]!.id, configurationRevision: 1, policyRevision: 1, purpose: "ตรวจงาน / review 🧪", inputRevision: 1, input: {}, priority: "background", limits: structuredClone(limits), ...payload } };
}
const job = (f: Fixture, id: string) => f.app.job(f.auth.actor, f.project.id, id);
function request(f: Fixture, path: string, body?: Record<string, unknown>) {
  return new Request(`http://localhost:3000${path}`, { method: body ? "POST" : "GET", headers: { cookie: `jit_session=${f.token}`,
    ...(body ? { origin: "http://localhost:3000", "content-type": "application/json", "x-csrf-token": f.auth.csrf } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
async function child(f: Fixture, cmd: EnqueueJobCommand, mode: string) {
  const process = Bun.spawn([globalThis.process.execPath, "--no-env-file", join(import.meta.dir, "fixtures/job-worker.ts")], {
    stdin: new Blob([JSON.stringify({ path: f.path, token: f.token, now: f.clock.now, command: cmd, mode })]), stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => process.kill("SIGKILL"), 5000);
  try { const [stdout, stderr, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]); expect(stderr).toBe(""); return { stdout, code }; }
  finally { clearTimeout(timer); if (process.exitCode === null) process.kill("SIGKILL"); await process.exited; }
}

test("owner enqueue, receipt, fake worker and Web job view commit one scoped result without read side effects", async () => {
  const f = await fixture(), cmd = command(f), receipt = f.app.execute(f.auth.actor, cmd);
  expect(receipt.job).toMatchObject({ projectId: f.project.id, state: "queued", authorization: { ownerId: "owner", generation: 1, requestId: cmd.requestId }, configuration: { revision: 1, policyRevision: 1 }, remaining: limits });
  expect(f.app.execute(f.auth.actor, cmd)).toEqual(receipt);
  expect(() => f.app.execute(f.auth.actor, { ...cmd, payload: { ...cmd.payload, purpose: "different" } })).toThrow("request_id_conflict");
  const path = `/projects/${f.project.id}/jobs`, before = f.store.read(tx => tx.get<{ count: number }>("SELECT count(*) AS count FROM command_receipts")!.count);
  expect((await f.web(request(f, path))).status).toBe(200);
  expect(job(f, receipt.job.id).state).toBe("queued");
  expect(f.store.read(tx => tx.get<{ count: number }>("SELECT count(*) AS count FROM command_receipts")!.count)).toBe(before);
  f.queue.pump(); expect(job(f, receipt.job.id).state).toBe("admitted"); await f.queue.idle();
  expect(job(f, receipt.job.id)).toMatchObject({ state: "succeeded", evidence: "หลักฐาน 🧪", remaining: { calls: 3, rounds: 3 } });
  const html = await (await f.web(request(f, `${path}/${receipt.job.id}`))).text(); expect(html).toContain("เสร็จแล้ว"); expect(html).toContain("หลักฐาน 🧪");
  expect(f.app.execute(f.auth.actor, cmd)).toEqual(receipt);
});

test("interactive admission overtakes queued background work and yielding is fair among peers", async () => {
  const order: string[] = []; const f = await fixture({ env: { JIT_JOB_CONCURRENCY: "1" }, definitions: [definition(({ job }) => {
    order.push(job.purpose); return job.steps === 1 ? { state: "yield", checkpoint: { step: 1 } } : { state: "succeeded", evidence: job.purpose };
  })] });
  const background = f.app.execute(f.auth.actor, command(f, { purpose: "background" })).job;
  const a = f.app.execute(f.auth.actor, command(f, { priority: "interactive", purpose: "interactive-a" })).job;
  const b = f.app.execute(f.auth.actor, command(f, { priority: "interactive", purpose: "interactive-b" })).job;
  for (let n = 0; n < 6; n++) { f.queue.pump(); await f.queue.idle(); }
  expect(order).toEqual(["interactive-a", "interactive-b", "interactive-a", "interactive-b", "background", "background"]);
  for (const id of [a.id, b.id, background.id]) expect(job(f, id).state).toBe("succeeded");
});

test("an existing call keeps its slot; models sharing one auth route share its concurrency ceiling", async () => {
  let release!: () => void; const gate = new Promise<WorkOutcome>(resolve => { release = () => resolve({ state: "succeeded", evidence: "done" }); }); releases.push(() => release());
  const one = definition(() => gate), two = { ...definition(), id: "fixture.other", route: { authRoute: "subscription-a", model: "other-model", provider: "fixture" } };
  const third = { ...definition(), id: "fixture.third", route: { provider: "fixture", model: "scripted", authRoute: "subscription-b" } };
  const f = await fixture({ definitions: [one, two, third] });
  const a = f.app.execute(f.auth.actor, command(f)).job; f.queue.pump(); await Promise.resolve();
  const b = f.app.execute(f.auth.actor, command(f, { type: two.id, priority: "interactive" })).job;
  const c = f.app.execute(f.auth.actor, command(f, { type: third.id })).job;
  f.queue.pump(); expect(job(f, a.id).state).toBe("admitted"); expect(job(f, b.id).state).toBe("queued"); expect(job(f, c.id).state).toBe("admitted");
  release(); await f.queue.idle(); f.queue.pump(); await f.queue.idle(); expect(job(f, b.id).state).toBe("succeeded");
});

test("quota/login/unavailable waits keep exact route and require deduplicated explicit resume within remaining budgets", async () => {
  for (const reason of ["quota", "needs_login", "route_unavailable"] as const) {
    const f = await fixture({ definitions: [definition(({ job }) => job.steps === 1 ? { state: "waiting", reason } : { state: "succeeded", evidence: "same route" })] });
    const original = f.app.execute(f.auth.actor, command(f)).job; f.queue.pump(); await f.queue.idle();
    const waiting = job(f, original.id); expect(waiting).toMatchObject({ state: "waiting", reason, route: original.route, remaining: { calls: 3, retries: 2 } });
    f.queue.pump(); await f.queue.idle(); expect(job(f, original.id)).toEqual(waiting);
    const resume = { kind: "job.resume" as const, requestId: crypto.randomUUID(), projectId: f.project.id, expectedRevision: waiting.revision, payload: { jobId: waiting.id } };
    const receipt = f.app.execute(f.auth.actor, resume); expect(f.app.execute(f.auth.actor, resume)).toEqual(receipt);
    expect(receipt.job).toMatchObject({ route: original.route, deadlineAt: original.deadlineAt, remaining: { calls: 3, retries: 1 } });
    f.queue.pump(); await f.queue.idle(); expect(job(f, waiting.id)).toMatchObject({ state: "succeeded", route: original.route, remaining: { calls: 2, retries: 1 } });
  }
});

test("queued, waiting and active reads project wall time without mutating state or replay receipts", async () => {
  for (const state of ["queued", "waiting", "admitted"] as const) {
    let release!: () => void;
    const gate = new Promise<WorkOutcome>(resolve => { release = () => resolve({ state: "succeeded", evidence: "done" }); }); releases.push(() => release());
    const f = await fixture({ definitions: [definition(() => state === "admitted" ? gate : { state: "waiting", reason: "quota" })] });
    const cmd = command(f), receipt = f.app.execute(f.auth.actor, cmd);
    if (state !== "queued") { f.queue.pump(); if (state === "waiting") await f.queue.idle(); }
    const persisted = () => f.store.read(tx => tx.get<{ record_json: string }>("SELECT record_json FROM jobs WHERE id = ?", receipt.job.id)!.record_json);
    const before = persisted(), original = job(f, receipt.job.id);
    f.clock.advance(200);
    expect(job(f, receipt.job.id)).toMatchObject({ state, revision: original.revision, updatedAt: original.updatedAt, remaining: { wallMs: 800 } });
    expect(f.app.jobs(f.auth.actor, f.project.id).items[0]!.remaining.wallMs).toBe(800);
    expect(persisted()).toBe(before);
    expect(f.app.execute(f.auth.actor, cmd)).toEqual(receipt);
    f.clock.now = epoch - 100;
    expect(job(f, receipt.job.id).remaining.wallMs).toBe(1000);
    f.clock.now = epoch + 200;
    release(); await f.queue.idle();
    if (state === "admitted") {
      const completed = job(f, receipt.job.id); f.clock.advance(200);
      expect(job(f, receipt.job.id)).toEqual(completed);
    } else {
      f.clock.advance(1000);
      expect(job(f, receipt.job.id).remaining.wallMs).toBe(0);
      expect(persisted()).toBe(before);
    }
  }
});

test("bounded JSON rejects sparse, oversized or modified arrays without invoking their methods", async () => {
  let calls = 0;
  const ownMethod = Object.assign([], { map() { calls++; return ["replacement"]; } });
  const inherited = Object.setPrototypeOf([], { map() { calls++; return []; } });
  const accessor = Object.defineProperty([0], "0", { enumerable: true, get() { calls++; return 1; } });
  const hidden = Object.defineProperty([], "hidden", { value: () => { calls++; } });
  for (const value of [new Array(1_000_000), new Array(2 ** 32 - 1), [, 1], Array(257).fill(0), ownMethod, inherited, accessor, hidden]) {
    expect(() => jobData(value, 64)).toThrow("invalid_job_data");
  }
  expect(calls).toBe(0);
  expect(jobData([{ z: 1, a: [true, null] }], 64)).toBe('[{"a":[true,null],"z":1}]');
  const f = await fixture({ definitions: [definition(() => ({ state: "yield", checkpoint: ownMethod }))] });
  const id = f.app.execute(f.auth.actor, command(f)).job.id; f.queue.pump(); await f.queue.idle();
  expect(job(f, id)).toMatchObject({ state: "failed", reason: "worker_failed", checkpoint: null });
  expect(calls).toBe(0);
});

test("finite queue overload and every budget boundary reject or terminate visibly before extra work", async () => {
  const f = await fixture({ env: { JIT_JOB_QUEUE_LIMIT: "1" }, definitions: [definition(() => ({ state: "yield", checkpoint: {} }))] });
  for (const key of Object.keys(limits) as (keyof JobLimits)[]) {
    for (const value of [0, -1, Infinity, 1.5]) expect(() => f.app.execute(f.auth.actor, command(f, { limits: { ...limits, [key]: value } }))).toThrow();
  }
  expect(() => f.app.execute(f.auth.actor, command(f, { limits: Object.create(limits) }))).toThrow();
  expect(() => f.app.execute(f.auth.actor, command(f, { input: new Date() as never }))).toThrow("invalid_job_data");
  expect(() => f.app.execute(f.auth.actor, command(f, { input: "x".repeat(f.config.jobs.inputBytes + 1) }))).toThrow("invalid_job_data");
  const cmd = command(f, { limits: { ...limits, calls: 1, rounds: 1, hops: 1 } }), first = f.app.execute(f.auth.actor, cmd).job;
  expect(() => f.app.execute(f.auth.actor, command(f))).toThrow("job_queue_full"); expect(f.app.execute(f.auth.actor, cmd).job.id).toBe(first.id);
  f.queue.pump(); await f.queue.idle(); f.queue.pump(); await f.queue.idle();
  expect(job(f, first.id)).toMatchObject({ state: "blocked", reason: "budget_exhausted", steps: 1, remaining: { calls: 0 } });
  expect(f.app.execute(f.auth.actor, command(f)).job.state).toBe("queued");
});

test("usage reservations persist before external work and cannot exceed context/output/retry budgets", async () => {
  let observed: Job | undefined;
  const f = await fixture({ definitions: [definition(context => {
    context.reserve({ contextTokens: 10, outputTokens: 10, retries: 1 }); observed = job(f, context.job.id);
    context.reserve({ outputTokens: 1 }); return { state: "succeeded", evidence: "must not publish" };
  })] });
  const receipt = f.app.execute(f.auth.actor, command(f)); f.queue.pump(); await f.queue.idle();
  expect(observed?.remaining).toMatchObject({ contextTokens: 0, outputTokens: 0, retries: 1 });
  expect(job(f, receipt.job.id)).toMatchObject({ state: "blocked", reason: "budget_exhausted", evidence: null, remaining: { outputTokens: 0 } });
});

test("prototype values cannot create or restore usage budgets", async () => {
  const f = await fixture({ definitions: [definition(context => {
    context.reserve(Object.assign(Object.create({ calls: -100 }), { roles: 1 }));
    return { state: "succeeded", evidence: "must not publish" };
  })] });
  const id = f.app.execute(f.auth.actor, command(f)).job.id; f.queue.pump(); await f.queue.idle();
  expect(job(f, id)).toMatchObject({ state: "failed", reason: "worker_failed", remaining: { calls: 3, roles: 3 }, evidence: null });
});

test("stalled calls time out visibly but hold capacity until actual settlement, including queued deadlines", async () => {
  let release!: () => void, signal: AbortSignal | undefined;
  const gate = new Promise<WorkOutcome>(resolve => { release = () => resolve({ state: "succeeded", evidence: "too late" }); }); releases.push(() => release());
  const f = await fixture({ env: { JIT_JOB_CONCURRENCY: "1" }, definitions: [definition(context => { signal = context.signal; return gate; })] });
  const first = f.app.execute(f.auth.actor, command(f)).job; f.queue.pump(); await Promise.resolve();
  const queued = f.app.execute(f.auth.actor, command(f)).job; f.clock.advance(1001); f.queue.pump();
  expect(signal?.aborted).toBe(true); expect(job(f, first.id)).toMatchObject({ state: "failed", reason: "deadline", evidence: null, occupiesAdmission: true, nextAction: "wait_for_adapter_to_stop" });
  expect(job(f, queued.id)).toMatchObject({ state: "failed", reason: "deadline", steps: 0 });
  expect(f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM jobs WHERE occupies = 1")!.n)).toBe(1);
  release(); await f.queue.idle(); expect(job(f, first.id)).toMatchObject({ evidence: null, occupiesAdmission: false, nextAction: "inspect_reason_and_authorize_new_work" });
  expect(f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM jobs WHERE occupies = 1")!.n)).toBe(0);
});

test("waiting deadlines and exhausted retries become terminal instead of silently extending the budget", async () => {
  const f = await fixture({ definitions: [definition(() => ({ state: "waiting", reason: "quota" }))] });
  const a = f.app.execute(f.auth.actor, command(f, { limits: { ...limits, retries: 1 } })).job; f.queue.pump(); await f.queue.idle();
  const waiting = job(f, a.id);
  f.app.execute(f.auth.actor, { kind: "job.resume", requestId: crypto.randomUUID(), projectId: f.project.id, expectedRevision: waiting.revision, payload: { jobId: a.id } });
  f.queue.pump(); await f.queue.idle(); expect(job(f, a.id)).toMatchObject({ state: "blocked", reason: "budget_exhausted", remaining: { retries: 0 } });
  const b = f.app.execute(f.auth.actor, command(f)).job; f.queue.pump(); await f.queue.idle(); f.clock.advance(1001); f.queue.pump();
  expect(job(f, b.id)).toMatchObject({ state: "failed", reason: "deadline" });
});

test("new configuration, source revisions and owner reset cannot silently authorize queued work", async () => {
  let calls = 0; const f = await fixture({ definitions: [definition(() => { calls++; return { state: "succeeded", evidence: "done" }; })] });
  const a = f.app.execute(f.auth.actor, command(f)).job;
  f.store.transaction(tx => tx.run("UPDATE projects SET revision = revision + 1 WHERE id = ?", f.project.id));
  f.queue.pump(); expect(job(f, a.id)).toMatchObject({ state: "blocked", reason: "input_changed" }); expect(calls).toBe(0);
  f.store.transaction(tx => tx.run("UPDATE projects SET revision = 1 WHERE id = ?", f.project.id));
  const b = f.app.execute(f.auth.actor, command(f)).job; f.queue.close();
  const queue = new JobQueue(f.store, { ...f.config.jobs, revision: 2 }, f.definitions, { now: () => f.clock.now, timers: f.clock.timers }); queues.push(queue); queue.pump();
  expect(job(f, b.id)).toMatchObject({ state: "blocked", reason: "configuration_changed" }); expect(calls).toBe(0); queue.close();
  const q = new JobQueue(f.store, f.config.jobs, f.definitions, { now: () => f.clock.now, timers: f.clock.timers }); queues.push(q);
  const app = new Application(f.store, f.config, { jobs: q, now: () => f.clock.now }), actor = app.authenticate(f.token).actor;
  const c = app.execute(actor, command(f)).job; await app.setupOwner(password, true); q.pump();
  const auth = app.authenticate(await app.login(password)); expect(app.job(auth.actor, f.project.id, c.id)).toMatchObject({ state: "blocked", reason: "authorization_changed" });
  expect(() => app.execute(actor, command(f))).toThrow("authentication_required"); expect(calls).toBe(0);
});

test("a second scheduler in this or another process cannot acknowledge work", async () => {
  const f = await fixture({ definitions: [] });
  expect(() => new JobQueue(f.store, f.config.jobs, [])).toThrow("scheduler_unavailable");
  const cmd = command({ ...f, definitions: [projectStateWork(f.store)] });
  const result = await child(f, cmd, "enqueue"); expect(result.code).toBe(2); expect(JSON.parse(result.stdout)).toEqual({ error: "scheduler_unavailable" });
  expect(f.app.jobs(f.auth.actor, f.project.id).items).toHaveLength(0);
});

for (const mode of ["queued-crash", "admitted-crash"] as const) test(`fresh process recovers ${mode} without losing budgets or guessing completion`, async () => {
  const f = await fixture({ definitions: [] }); f.queue.close();
  const cmd = command({ ...f, definitions: [projectStateWork(f.store)] });
  const result = await child(f, cmd, mode); expect(result.code).not.toBe(0); const id = JSON.parse(result.stdout).job.id;
  const queue = new JobQueue(f.store, f.config.jobs, [projectStateWork(f.store)], { now: () => f.clock.now, timers: f.clock.timers }); queues.push(queue);
  const app = new Application(f.store, f.config, { jobs: queue, now: () => f.clock.now }), actor = app.authenticate(f.token).actor;
  expect(app.job(actor, f.project.id, id)).toMatchObject({ state: mode === "queued-crash" ? "queued" : "waiting", reason: mode === "queued-crash" ? "queued" : "interrupted", remaining: { calls: mode === "queued-crash" ? 4 : 3 } });
  if (mode === "queued-crash") { queue.pump(); await queue.idle(); expect(app.job(actor, f.project.id, id).state).toBe("succeeded"); }
  else { queue.pump(); await queue.idle(); expect(app.job(actor, f.project.id, id).state).toBe("waiting"); }
});

for (const stage of ["job", "receipt"]) test(`SIGKILL after ${stage} writes cannot leave a half-acknowledged job`, async () => {
  const f = await fixture({ definitions: [] }); f.queue.close(); const cmd = command({ ...f, definitions: [projectStateWork(f.store)] });
  const before = f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM command_receipts")!.n);
  await child(f, cmd, `crash-${stage}`);
  expect(f.app.jobs(f.auth.actor, f.project.id).items).toHaveLength(0);
  expect(f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM command_receipts")!.n)).toBe(before);
  const queue = new JobQueue(f.store, f.config.jobs, [projectStateWork(f.store)], { now: () => f.clock.now, timers: f.clock.timers }); queues.push(queue);
  const app = new Application(f.store, f.config, { jobs: queue, now: () => f.clock.now }); expect(app.execute(app.authenticate(f.token).actor, cmd).job.state).toBe("queued");
});

test("SQLite COMMIT failure rolls back job, receipt and audit without acknowledging the request", async () => {
  let armed = false, store!: TransactionStore;
  const f = await fixture({ beforeCommit: stage => { if (armed && stage === "receipt") store.read(tx => {
    tx.run("PRAGMA defer_foreign_keys = ON"); tx.run("INSERT INTO project_groups VALUES ('invalid-job-group', 'missing-project')");
  }); } }); store = f.store; armed = true;
  const cmd = command(f), before = f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM command_receipts")!.n);
  const response = await f.web(request(f, `/api/projects/${f.project.id}/jobs`, { requestId: cmd.requestId, expectedRevision: cmd.expectedRevision, ...cmd.payload }));
  expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: "storage_unavailable" });
  expect(f.app.jobs(f.auth.actor, f.project.id).items).toHaveLength(0);
  expect(f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM command_receipts")!.n)).toBe(before);
  expect(f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM audit WHERE command_kind = 'job.enqueue'")!.n)).toBe(0);
  armed = false; expect(f.app.execute(f.auth.actor, cmd).job.state).toBe("queued");
});

test("admission cannot invoke a worker until its usage reservation commits", async () => {
  let calls = 0;
  const f = await fixture({ definitions: [definition(() => { calls++; return { state: "succeeded", evidence: "done" }; })] });
  const id = f.app.execute(f.auth.actor, command(f)).job.id;
  const transaction = f.store.transaction.bind(f.store);
  f.store.transaction = <T>(mutate: (tx: AppTransaction) => T) => transaction(tx => {
    const result = mutate(tx); tx.run("PRAGMA defer_foreign_keys = ON"); tx.run("INSERT INTO project_groups VALUES ('invalid-reservation-group', 'missing-project')"); return result;
  });
  try { expect(() => f.queue.pump()).toThrow(); }
  finally { f.store.transaction = transaction; }
  await f.queue.idle(); expect(calls).toBe(0);
  expect(job(f, id)).toMatchObject({ state: "queued", remaining: limits, steps: 0 });
  expect(f.app.jobs(f.auth.actor, f.project.id).admission.available).toBe(false);
  expect(() => f.app.execute(f.auth.actor, command(f))).toThrow("scheduler_unavailable");
});

test("Web uses owner/Origin/CSRF and project scope, safely renders output, and bounds cursor queries", async () => {
  const text = '<script>globalThis.pwned=1</script>\n```ts\nconst ไทย = "🧪";\n```\njavascript:alert(1)';
  const f = await fixture({ env: { JIT_PAGE_SIZE: "1" }, definitions: [definition(() => ({ state: "succeeded", evidence: text }))] });
  const cmd = command(f), path = `/api/projects/${f.project.id}/jobs`, body = { requestId: cmd.requestId, expectedRevision: 1, ...cmd.payload };
  expect((await f.web(new Request(`http://localhost:3000${path}`))).status).toBe(401);
  const crossOrigin = request(f, path, body); crossOrigin.headers.set("origin", "https://other.example.test"); expect((await f.web(crossOrigin)).status).toBe(403);
  const noCsrf = request(f, path, body); noCsrf.headers.delete("x-csrf-token"); expect((await f.web(noCsrf)).status).toBe(403);
  expect(() => f.app.execute({ ...f.auth.actor }, cmd)).toThrow("authentication_required");
  expect((await f.web(request(f, path, { ...body, actor: "owner" }))).status).toBe(400);
  const response = await f.web(request(f, path, body)), receipt = await response.json(); expect(response.status).toBe(200);
  expect(await (await f.web(request(f, path, body))).json()).toEqual(receipt);
  f.app.execute(f.auth.actor, command(f));
  const firstPage = await (await f.web(request(f, path))).json(); expect(firstPage.items).toHaveLength(1); expect(firstPage.hasMore).toBe(true);
  expect((await (await f.web(request(f, `${path}?after=${firstPage.nextAfter}`))).json()).items).toHaveLength(1);
  expect((await f.web(request(f, `${path}?after=${Number.MAX_SAFE_INTEGER + 1}`))).status).toBe(400);
  const other = f.app.execute(f.auth.actor, { kind: "project.create", requestId: crypto.randomUUID(), projectId: null, expectedRevision: 1, payload: { name: "same name" } }).project;
  expect((await f.web(request(f, `/api/projects/${other.id}/jobs/${receipt.job.id}`))).status).toBe(404);
  f.queue.pump(); await f.queue.idle();
  const html = await (await f.web(request(f, `/projects/${f.project.id}/jobs/${receipt.job.id}`))).text();
  expect(html).toContain("&lt;script&gt;"); expect(html).not.toContain("<script>"); expect(html).not.toContain('href="javascript:'); expect(html).toContain("const ไทย");
  const formCommand = command(f), form = new URLSearchParams({ csrf: f.auth.csrf, requestId: formCommand.requestId, expectedRevision: "1", ...Object.fromEntries(Object.entries(formCommand.payload).map(([key, value]) => [key, typeof value === "object" ? JSON.stringify(value) : String(value)])) });
  const submitted = await f.web(new Request(`http://localhost:3000/projects/${f.project.id}/jobs`, { method: "POST", headers: { cookie: `jit_session=${f.token}`, origin: "http://localhost:3000", "content-type": "application/x-www-form-urlencoded" }, body: form }));
  expect(submitted.status).toBe(303); expect(submitted.headers.get("location")).toMatch(/\/jobs\/[a-f0-9-]{36}#job-/);
});

test("shutdown retains admission ownership until an unsettled adapter stops and cannot publish its late success", async () => {
  let release!: () => void;
  const gate = new Promise<WorkOutcome>(resolve => { release = () => resolve({ state: "succeeded", evidence: "late result" }); }); releases.push(() => release());
  const f = await fixture({ definitions: [definition(() => gate)] }), id = f.app.execute(f.auth.actor, command(f)).job.id;
  f.queue.pump(); await Promise.resolve(); f.queue.close();
  expect(() => new JobQueue(f.store, f.config.jobs, f.definitions)).toThrow("scheduler_unavailable");
  expect(() => f.app.execute(f.auth.actor, command(f))).toThrow("scheduler_unavailable");
  release(); await f.queue.idle(); expect(job(f, id)).toMatchObject({ state: "waiting", reason: "interrupted", evidence: null });
  const next = new JobQueue(f.store, f.config.jobs, f.definitions); queues.push(next);
  expect(f.app.jobs(f.auth.actor, f.project.id).items).toHaveLength(1);
});

test("deadline before invocation, invalid adapter outcomes and raw thrown diagnostics never create a success", async () => {
  let calls = 0;
  const f = await fixture({ definitions: [definition(() => { calls++; throw new Error("credential-secret-sentinel"); })] });
  const a = f.app.execute(f.auth.actor, command(f)).job; f.queue.pump(); f.clock.advance(1001); await f.queue.idle();
  expect(calls).toBe(0); expect(job(f, a.id)).toMatchObject({ state: "failed", reason: "deadline", evidence: null });
  const b = f.app.execute(f.auth.actor, command(f)).job; f.queue.pump(); await f.queue.idle();
  expect(calls).toBe(1); expect(JSON.stringify(job(f, b.id))).not.toContain("credential-secret-sentinel"); expect(job(f, b.id).state).toBe("failed");
  f.queue.close();
  const invalid = new JobQueue(f.store, f.config.jobs, [definition(() => ({ state: "yield", checkpoint: { bad: Infinity } }))], { now: () => f.clock.now, timers: f.clock.timers }); queues.push(invalid);
  const app = new Application(f.store, f.config, { jobs: invalid, now: () => f.clock.now }), actor = app.authenticate(f.token).actor;
  const c = app.execute(actor, command(f)).job; invalid.pump(); await invalid.idle();
  expect(app.job(actor, f.project.id, c.id)).toMatchObject({ state: "failed", reason: "worker_failed" });
  expect(app.execute(actor, command(f)).job.state).toBe("queued");
});

test("invalid scheduler configuration fails before claiming ownership or acknowledging work", async () => {
  const f = await fixture(); f.queue.close();
  for (const policy of [{ ...f.config.jobs, concurrency: 0 }, { ...f.config.jobs, routeConcurrency: 3 }, { ...f.config.jobs, maximum: { ...limits, calls: Infinity } }]) {
    expect(() => new JobQueue(f.store, policy, f.definitions)).toThrow();
    expect(f.store.read(tx => tx.get("SELECT * FROM job_scheduler"))).toBeNull();
  }
  const wrongRevision = command(f, { policyRevision: 2 }); const queue = new JobQueue(f.store, f.config.jobs, f.definitions); queues.push(queue);
  const app = new Application(f.store, f.config, { jobs: queue, now: () => f.clock.now });
  expect(() => app.execute(app.authenticate(f.token).actor, wrongRevision)).toThrow("invalid_job_command");
});

test("frozen published v2 schema migrates with conversation, source identity and owner state intact", async () => {
  const root = mkdtempSync(join(tmpdir(), "jit-job01-v2-")); roots.push(root); const path = join(root, "app.sqlite"), old = new Database(path);
  old.exec(await Bun.file(join(import.meta.dir, "fixtures/foundation-v2.sql")).text());
  const projectId = crypto.randomUUID(), groupId = crypto.randomUUID(), topicId = crypto.randomUUID(), messageId = crypto.randomUUID(), topicSource = crypto.randomUUID(), messageSource = crypto.randomUUID();
  const token = crypto.getRandomValues(new Uint8Array(32)).toHex(), digest = (value: string) => createHash("sha256").update(value).digest("hex"), attribution = JSON.stringify({ kind: "owner", ownerId: "owner" });
  old.query("INSERT INTO owner VALUES ('owner', ?, 1)").run(await Bun.password.hash(password, { algorithm: "argon2id" }));
  old.query("INSERT INTO sessions VALUES (?, 'owner', 1, ?)").run(digest(token), epoch + 60000);
  old.query("INSERT INTO projects VALUES (?, 'ก่อนคิวงาน 🧪', 2, ?)").run(projectId, epoch); old.query("INSERT INTO project_groups VALUES (?, ?)").run(groupId, projectId);
  for (const [id, kind, text, descriptor] of [[topicSource, "topic", "หัวข้อเดิม", { kind: "topic", topicId }], [messageSource, "message", "ข้อความเดิม 🧪", { kind: "message", topicId, messageId }]] as const) {
    old.query("INSERT INTO sources VALUES (?, ?, ?, 1, 1, 'available')").run(id, projectId, kind);
    old.query("INSERT INTO source_versions VALUES (?, 1, 1, ?, ?, ?, ?)").run(id, JSON.stringify(descriptor), attribution, text, epoch);
  }
  old.query("INSERT INTO topics VALUES (?, ?, ?, 2, 1, 1, ?, ?, ?, 1, 1)").run(topicId, projectId, groupId, epoch, attribution, topicSource);
  old.query("INSERT INTO messages VALUES (?, ?, ?, 1, ?, ?, ?, 1, 1)").run(messageId, projectId, topicId, epoch, attribution, messageSource); old.close();
  const store = new TransactionStore(path); stores.push(store); const config = readConfig({ JIT_DATABASE: path });
  const queue = new JobQueue(store, config.jobs, [projectStateWork(store)], { now: () => epoch }); queues.push(queue);
  const app = new Application(store, config, { jobs: queue, now: () => epoch }), actor = app.authenticate(token).actor;
  expect(app.conversation(actor, projectId, topicId).items[0]).toMatchObject({ id: messageId, text: "ข้อความเดิม 🧪", source: { sourceId: messageSource, revision: 1, generation: 1 } });
  expect(app.source(actor, projectId, { sourceId: messageSource, revision: 1, generation: 1 })).toMatchObject({ state: "available", text: "ข้อความเดิม 🧪" });
  const cmd: EnqueueJobCommand = { kind: "job.enqueue", requestId: crypto.randomUUID(), projectId, expectedRevision: 2, payload: { type: "project.status", configurationRevision: 1, policyRevision: 1, purpose: "ตรวจโครงการเดิม", inputRevision: 2, input: {}, priority: "interactive", limits } };
  const id = app.execute(actor, cmd).job.id; queue.pump(); await queue.idle(); expect(app.job(actor, projectId, id).state).toBe("succeeded");
  const snapshot = new Database(join(root, readdirSync(root).find(name => name.includes(".pre-v2-"))!), { readonly: true });
  expect(snapshot.query("PRAGMA user_version").get()).toEqual({ user_version: 2 }); expect(snapshot.query("SELECT count(*) AS n FROM messages").get()).toEqual({ n: 1 }); snapshot.close();
  expect(store.read(tx => tx.get("PRAGMA user_version"))).toEqual({ user_version: 12 });
});

test("attempt snapshot and generation/lease commit before dispatch; non-model commit is atomic with producer mutations", async () => {
  let captured: import("../src/jobs/types").WorkContext | undefined;
  const f = await fixture({ definitions: [definition(context => {
    captured = context;
    const outcome = { state: "succeeded" as const, evidence: "transactional evidence" };
    expect(context.commit(outcome, tx => tx.run("UPDATE app_state SET revision = 21 WHERE id = 1"))).toBe(true);
    expect(context.commit(outcome, tx => tx.run("UPDATE app_state SET revision = 99 WHERE id = 1"))).toBe(false);
    return outcome;
  })] });
  const original = f.app.execute(f.auth.actor, command(f)).job;
  f.queue.pump();
  const prepared = job(f, original.id).attempts[0]!;
  expect(captured).toBeUndefined(); expect(prepared.state).toBe("prepared");
  expect(prepared.snapshot).toMatchObject({ input: original.input, authorization: original.authorization, configuration: original.configuration, remaining: { calls: 3 } });
  expect(prepared.generation).toBeGreaterThan(0); expect(prepared.leaseUntil).toBe(f.clock.now + limits.wallMs);
  await f.queue.idle();
  expect(job(f, original.id)).toMatchObject({ state: "succeeded", attempts: [{ state: "committed" }] });
  expect(f.app.workspace(f.auth.actor).revision).toBe(21);
  expect(job(f, original.id).attempts[0]!.snapshot).toEqual(prepared.snapshot);
});

test("owner stop persists fencing before abort, replays its receipt and reports actual settlement separately", async () => {
  let release!: () => void, entered!: () => void, aborted = false, changed = false;
  const gate = new Promise<void>(r => { release = r; }); releases.push(release);
  const started = new Promise<void>(r => { entered = r; });
  const f = await fixture({ definitions: [definition(async context => {
    context.signal.addEventListener("abort", () => {
      expect(job(f, context.job.id).stop).toMatchObject({ fencedAt: epoch, transport: "cancellation_requested" }); aborted = true;
    });
    entered(); await gate;
    context.commit({ state: "succeeded", evidence: "late" }, () => { changed = true; });
    return { state: "succeeded", evidence: "late" };
  })] });
  const original = f.app.execute(f.auth.actor, command(f)).job; f.queue.pump(); await started;
  const current = job(f, original.id), stop = { kind: "job.stop" as const, requestId: crypto.randomUUID(), projectId: f.project.id, expectedRevision: current.revision, payload: { jobId: original.id } };
  expect(() => f.app.execute({ ...f.auth.actor }, stop)).toThrow("authentication_required");
  const response = await f.web(request(f, `/api/projects/${f.project.id}/jobs/${original.id}/stop`, { requestId: stop.requestId, expectedRevision: stop.expectedRevision }));
  expect(response.status).toBe(200); const receipt = await response.json(); expect(aborted).toBe(true);
  expect(receipt.stop).toMatchObject({ requestedAt: epoch, fencedAt: epoch, transport: "cancellation_requested", attemptIds: [job(f, original.id).attempts[0]!.id] });
  expect(f.app.execute(f.auth.actor, stop)).toEqual(receipt);
  expect(job(f, original.id)).toMatchObject({ state: "blocked", reason: "cancelled", occupiesAdmission: true });
  release(); await f.queue.idle(); expect(changed).toBe(false);
  expect(job(f, original.id)).toMatchObject({ evidence: null, occupiesAdmission: false, stop: { transport: "observed_stopped" } });
  expect(f.app.execute(f.auth.actor, stop)).toEqual(receipt);
  const queued = f.app.execute(f.auth.actor, command(f)).job;
  const result = f.app.execute(f.auth.actor, { ...stop, requestId: crypto.randomUUID(), expectedRevision: queued.revision, payload: { jobId: queued.id } });
  expect(result.stop?.transport).toBe("not_dispatched");
});

for (const cause of ["revoked", "superseded", "source_retired", "context_retired", "owner", "input", "lease"] as const) test(`late non-model producer after ${cause} cannot publish evidence or enter the mutation callback`, async () => {
  let release!: () => void, entered!: () => void, mutated = false;
  const gate = new Promise<void>(r => { release = r; }); releases.push(release); const started = new Promise<void>(r => { entered = r; });
  const f = await fixture({ definitions: [definition(async context => {
    entered(); await gate; context.commit({ state: "succeeded", evidence: "late" }, () => { mutated = true; });
    return { state: "succeeded", evidence: "late" };
  })] });
  const original = f.app.execute(f.auth.actor, command(f)).job; f.queue.pump(); await started;
  if (["revoked", "superseded", "source_retired", "context_retired"].includes(cause)) {
    f.store.transaction(tx => f.queue.invalidate(tx, f.project.id, original.id, cause as "revoked")); f.queue.cancelFenced();
  } else if (cause === "owner") await f.app.setupOwner(password, true);
  else if (cause === "input") f.store.transaction(tx => tx.run("UPDATE projects SET revision = revision + 1 WHERE id = ?", f.project.id));
  else f.clock.advance(limits.wallMs);
  release(); await f.queue.idle();
  expect(mutated).toBe(false);
  const current = f.store.read(tx => JSON.parse(tx.get<{ record_json: string }>("SELECT record_json FROM jobs WHERE id = ?", original.id)!.record_json) as Job);
  expect(current.state).not.toBe("succeeded"); expect(current.evidence).toBeNull();
});

test("producer/app-result transaction rollback leaves an inspectable unresolved attempt and no partial state", async () => {
  const f = await fixture({ definitions: [definition(context => {
    const result = { state: "succeeded" as const, evidence: "must roll back" };
    expect(context.commit(result, tx => tx.run("UPDATE app_state SET revision = 99 WHERE id = 1"))).toBe(false);
    return result;
  })] });
  f.store.transaction(tx => tx.run(`CREATE TRIGGER reject_attempt_result BEFORE UPDATE OF record_json ON job_attempts
    WHEN json_extract(NEW.record_json, '$.state') = 'committed' BEGIN SELECT RAISE(ABORT, 'fixture result failure'); END`));
  const original = f.app.execute(f.auth.actor, command(f)).job; f.queue.pump(); await f.queue.idle();
  expect(f.app.workspace(f.auth.actor).revision).toBe(1);
  expect(job(f, original.id)).toMatchObject({ state: "waiting", reason: "interrupted", evidence: null, occupiesAdmission: false, attempts: [{ state: "interrupted" }] });
});

test("result-commit rollback orphans are recovered on reopen so eligible read resume still works", async () => {
  const work = definition(context => {
    const result = { state: "succeeded" as const, evidence: "rolled back then resumed" };
    context.commit(result, tx => tx.run("UPDATE app_state SET revision = 99 WHERE id = 1"));
    return result;
  });
  const f = await fixture({ definitions: [work] });
  f.store.transaction(tx => tx.run(`CREATE TRIGGER reject_attempt_result BEFORE UPDATE OF record_json ON job_attempts
    WHEN json_extract(NEW.record_json, '$.state') = 'committed' BEGIN SELECT RAISE(ABORT, 'fixture result failure'); END`));
  const original = f.app.execute(f.auth.actor, command(f)).job; f.queue.pump(); await f.queue.idle();
  expect(job(f, original.id)).toMatchObject({ state: "waiting", reason: "interrupted", remaining: { calls: 3, retries: 2 } });
  f.queue.close(); await f.queue.idle();
  f.store.transaction(tx => tx.run("DROP TRIGGER reject_attempt_result"));
  const queue = new JobQueue(f.store, f.config.jobs, [work], { now: () => f.clock.now, timers: f.clock.timers, isAlive: () => false }); queues.push(queue);
  const app = new Application(f.store, f.config, { jobs: queue, now: () => f.clock.now }), actor = app.authenticate(f.token).actor;
  const waiting = app.job(actor, f.project.id, original.id);
  expect(waiting).toMatchObject({ state: "waiting", reason: "interrupted", reconciliations: [] });
  app.execute(actor, { kind: "job.resume", requestId: crypto.randomUUID(), projectId: f.project.id, expectedRevision: waiting.revision, payload: { jobId: original.id } });
  queue.pump(); await queue.idle();
  expect(app.job(actor, f.project.id, original.id)).toMatchObject({ state: "succeeded", evidence: "rolled back then resumed", attempts: [{ state: "interrupted" }, { state: "committed" }] });
});

test("takeover fences old callbacks; explicit read resume uses a new attempt and never refunds uncertain reservations", async () => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(r => { release = r; }); releases.push(release); const started = new Promise<void>(r => { entered = r; });
  const work = definition(async ({ job }) => { if (job.steps === 1) { entered(); await gate; } return { state: "succeeded", evidence: `attempt ${job.steps}` }; });
  const f = await fixture({ definitions: [work] }), original = f.app.execute(f.auth.actor, command(f)).job; f.queue.pump(); await started;
  const replacement = new JobQueue(f.store, f.config.jobs, [work], { now: () => f.clock.now, timers: f.clock.timers, isAlive: () => false }); queues.push(replacement);
  const app = new Application(f.store, f.config, { jobs: replacement, now: () => f.clock.now }), actor = app.authenticate(f.token).actor;
  const waiting = app.job(actor, f.project.id, original.id);
  expect(waiting).toMatchObject({ reason: "interrupted", attempts: [{ state: "interrupted" }], remaining: { calls: 3, retries: 2 } });
  app.execute(actor, { kind: "job.resume", requestId: crypto.randomUUID(), projectId: f.project.id, expectedRevision: waiting.revision, payload: { jobId: original.id } });
  replacement.pump(); await replacement.idle(); release(); await f.queue.idle();
  const current = app.job(actor, f.project.id, original.id);
  expect(current).toMatchObject({ state: "succeeded", evidence: "attempt 2", remaining: { calls: 2, retries: 1 }, attempts: [{ state: "interrupted" }, { state: "committed" }] });
  expect(current.attempts[0]!.id).not.toBe(current.attempts[1]!.id); expect(current.attempts[1]!.generation).toBeGreaterThan(current.attempts[0]!.generation);
});

for (const replay of ["mutation", "send", undefined] as const) test(`interrupted ${replay ?? "unspecified"} work cannot be blindly replayed`, async () => {
  const work = definition(); if (replay === undefined) delete work.replay; else work.replay = replay;
  const f = await fixture({ definitions: [work] }), original = f.app.execute(f.auth.actor, command(f)).job;
  f.queue.pump(); // Kill seam before the dispatch microtask.
  const replacement = new JobQueue(f.store, f.config.jobs, [work], { now: () => f.clock.now, timers: f.clock.timers, isAlive: () => false }); queues.push(replacement);
  const app = new Application(f.store, f.config, { jobs: replacement, now: () => f.clock.now }), actor = app.authenticate(f.token).actor;
  const waiting = app.job(actor, f.project.id, original.id);
  expect(() => app.execute(actor, { kind: "job.resume", requestId: crypto.randomUUID(), projectId: f.project.id, expectedRevision: waiting.revision, payload: { jobId: original.id } })).toThrow("job_requires_manual_reconciliation");
  expect(app.job(actor, f.project.id, original.id).steps).toBe(1);
});

test("lease expiry fences a live worker before the job wall deadline even when it ignores cancellation", async () => {
  let release!: () => void, entered!: () => void, committed = true;
  const gate = new Promise<void>(r => { release = r; }); releases.push(release); const started = new Promise<void>(r => { entered = r; });
  const f = await fixture({ leaseMs: 50, definitions: [definition(async context => {
    entered(); await gate; committed = context.commit({ state: "succeeded", evidence: "expired lease" });
    return { state: "succeeded", evidence: "expired lease" };
  })] });
  const original = f.app.execute(f.auth.actor, command(f)).job; f.queue.pump(); await started; f.clock.advance(50);
  expect(job(f, original.id)).toMatchObject({ reason: "lease_expired", occupiesAdmission: true, remaining: { wallMs: 950 } });
  release(); await f.queue.idle(); expect(committed).toBe(false); expect(job(f, original.id).evidence).toBeNull();
});

test("repeated interrupted read resumes exhaust retries without dispatching an extra attempt", async () => {
  const work = definition(), f = await fixture({ definitions: [work] }), original = f.app.execute(f.auth.actor, command(f)).job;
  let queue = f.queue, app = f.app, actor = f.auth.actor;
  for (let index = 0; index < 3; index++) {
    queue.pump(); // Simulated process death before dispatch.
    queue = new JobQueue(f.store, f.config.jobs, [work], { now: () => f.clock.now, timers: f.clock.timers, isAlive: () => false }); queues.push(queue);
    app = new Application(f.store, f.config, { jobs: queue, now: () => f.clock.now }); actor = app.authenticate(f.token).actor;
    const waiting = app.job(actor, f.project.id, original.id);
    app.execute(actor, { kind: "job.resume", requestId: crypto.randomUUID(), projectId: f.project.id, expectedRevision: waiting.revision, payload: { jobId: original.id } });
  }
  const result = app.job(actor, f.project.id, original.id);
  expect(result).toMatchObject({ state: "blocked", reason: "budget_exhausted", steps: 3, remaining: { calls: 1, retries: 0 } });
  expect(result.attempts).toHaveLength(3); queue.pump(); expect(app.job(actor, f.project.id, original.id).steps).toBe(3);
});

test("failed stop receipt rolls back its fence and never requests transport cancellation", async () => {
  let release!: () => void, entered!: () => void, fail = false, aborted = false;
  const gate = new Promise<void>(r => { release = r; }); releases.push(release); const started = new Promise<void>(r => { entered = r; });
  const f = await fixture({ beforeCommit: stage => { if (fail && stage === "receipt") throw new Error("stop receipt rollback"); }, definitions: [definition(async ({ signal }) => {
    signal.addEventListener("abort", () => { aborted = true; }); entered(); await gate; return { state: "succeeded", evidence: "authorized result" };
  })] });
  const original = f.app.execute(f.auth.actor, command(f)).job; f.queue.pump(); await started;
  fail = true;
  expect(() => f.app.execute(f.auth.actor, { kind: "job.stop", requestId: crypto.randomUUID(), projectId: f.project.id, expectedRevision: job(f, original.id).revision, payload: { jobId: original.id } })).toThrow("stop receipt rollback");
  expect(aborted).toBe(false); expect(job(f, original.id)).toMatchObject({ state: "admitted", stop: null, attempts: [{ state: "dispatched" }] });
  release(); await f.queue.idle(); expect(job(f, original.id).state).toBe("succeeded");
});

for (const field of ["input", "authorization", "configuration"] as const) test(`in-place ${field} replacement cannot authorize an old attempt snapshot`, async () => {
  let release!: () => void, entered!: () => void, accepted = true;
  const gate = new Promise<void>(r => { release = r; }); releases.push(release); const started = new Promise<void>(r => { entered = r; });
  const work = definition(async context => { entered(); await gate; accepted = context.commit({ state: "succeeded", evidence: "old snapshot" }); return { state: "succeeded", evidence: "old snapshot" }; });
  work.validate = () => true; // This adapter accepts multiple input values; freshness still belongs to the shared gate.
  const f = await fixture({ definitions: [work] }), original = f.app.execute(f.auth.actor, command(f)).job; f.queue.pump(); await started;
  f.store.transaction(tx => {
    const current = JSON.parse(tx.get<{ record_json: string }>("SELECT record_json FROM jobs WHERE id = ?", original.id)!.record_json) as Job;
    if (field === "input") current.input = { replacement: true };
    if (field === "authorization") current.authorization.requestId = crypto.randomUUID();
    if (field === "configuration") current.configuration.revision++;
    tx.run("UPDATE jobs SET record_json = ? WHERE id = ?", JSON.stringify(current), current.id);
  });
  release(); await f.queue.idle(); expect(accepted).toBe(false); expect(job(f, original.id).evidence).toBeNull();
});

test("early yield commit retains occupancy and cannot dispatch another job or lose stop tracking", async () => {
  let releaseFirst!: () => void, releasePeer!: () => void, enteredFirst!: () => void, firstAborted = false;
  const firstGate = new Promise<void>(r => { releaseFirst = r; }); releases.push(releaseFirst);
  const peerGate = new Promise<void>(r => { releasePeer = r; }); releases.push(releasePeer);
  const firstStarted = new Promise<void>(r => { enteredFirst = r; });
  let workers = 0, peerWorkers = 0;
  const work = definition(async context => {
    workers++;
    expect(context.commit({ state: "yield", checkpoint: { step: 1 } })).toBe(true);
    enteredFirst();
    context.signal.addEventListener("abort", () => { firstAborted = true; });
    // Stall after durable yield so occupancy must outlive the commit.
    await firstGate;
    return { state: "failed", reason: "worker_failed" };
  });
  const peer = { ...definition(async () => { peerWorkers++; await peerGate; return { state: "succeeded", evidence: "peer" }; }), id: "fixture.peer",
    route: { provider: "fixture", model: "peer", authRoute: "subscription-b" } };
  const f = await fixture({ env: { JIT_JOB_CONCURRENCY: "1" }, definitions: [work, peer] });
  const original = f.app.execute(f.auth.actor, command(f)).job;
  const other = f.app.execute(f.auth.actor, command(f, { type: peer.id })).job;
  f.queue.pump(); await firstStarted;
  expect(workers).toBe(1);
  expect(job(f, original.id)).toMatchObject({ state: "queued", reason: "yielded", occupiesAdmission: true, attempts: [{ state: "committed", transport: "dispatched" }] });
  f.queue.pump(); // Must not admit the peer while the yielded worker is unsettled.
  expect(peerWorkers).toBe(0);
  expect(job(f, other.id).state).toBe("queued");
  const stop = f.app.execute(f.auth.actor, { kind: "job.stop", requestId: crypto.randomUUID(), projectId: f.project.id,
    expectedRevision: job(f, original.id).revision, payload: { jobId: original.id } });
  expect(stop.stop).toMatchObject({ transport: "cancellation_requested", attemptIds: [job(f, original.id).attempts[0]!.id] });
  expect(firstAborted).toBe(true);
  releaseFirst(); await f.queue.idle();
  expect(job(f, original.id)).toMatchObject({ reason: "cancelled", evidence: null, occupiesAdmission: false, stop: { transport: "observed_stopped" } });
  expect(job(f, original.id).attempts[0]).toMatchObject({ transport: "settled" });
  f.queue.pump(); releasePeer(); await f.queue.idle();
  expect(peerWorkers).toBe(1);
  expect(job(f, other.id).state).toBe("succeeded");
});

test("restart after unsettled early yield interrupts queued work and blocks mutation replay", async () => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(r => { release = r; }); releases.push(release);
  const started = new Promise<void>(r => { entered = r; });
  const work = definition(async context => {
    context.commit({ state: "yield", checkpoint: { step: 1 } });
    entered(); await gate;
    return { state: "failed", reason: "worker_failed" };
  });
  work.replay = "mutation";
  const f = await fixture({ definitions: [work] }), original = f.app.execute(f.auth.actor, command(f)).job;
  f.queue.pump(); await started;
  expect(job(f, original.id)).toMatchObject({ state: "queued", reason: "yielded", occupiesAdmission: true });
  const recovered = new JobQueue(f.store, f.config.jobs, [work], { now: () => f.clock.now, timers: f.clock.timers, isAlive: () => false }); queues.push(recovered);
  const app = new Application(f.store, f.config, { jobs: recovered, now: () => f.clock.now }), actor = app.authenticate(f.token).actor;
  const waiting = app.job(actor, f.project.id, original.id);
  // Yield already committed the attempt; takeover still marks the job interrupted and applies replay rules.
  expect(waiting).toMatchObject({ state: "waiting", reason: "interrupted", attempts: [{ state: "committed", reason: "yielded" }] });
  expect(() => app.execute(actor, { kind: "job.resume", requestId: crypto.randomUUID(), projectId: f.project.id,
    expectedRevision: waiting.revision, payload: { jobId: original.id } })).toThrow("job_requires_manual_reconciliation");
  recovered.pump();
  expect(app.job(actor, f.project.id, original.id)).toMatchObject({ state: "waiting", reason: "interrupted" });
  expect(app.job(actor, f.project.id, original.id).attempts).toHaveLength(1);
  release(); await f.queue.idle();
});

test("stop after restart of an interrupted recovered attempt requests cancellation, not not_dispatched", async () => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(r => { release = r; }); releases.push(release);
  const started = new Promise<void>(r => { entered = r; });
  const work = definition(async () => { entered(); await gate; return { state: "succeeded", evidence: "late" }; });
  const f = await fixture({ definitions: [work] }), original = f.app.execute(f.auth.actor, command(f)).job;
  f.queue.pump(); await started;
  const recovered = new JobQueue(f.store, f.config.jobs, [work], { now: () => f.clock.now, timers: f.clock.timers, isAlive: () => false }); queues.push(recovered);
  const app = new Application(f.store, f.config, { jobs: recovered, now: () => f.clock.now }), actor = app.authenticate(f.token).actor;
  const waiting = app.job(actor, f.project.id, original.id);
  expect(waiting).toMatchObject({ state: "waiting", reason: "interrupted", attempts: [{ state: "interrupted", nativeState: "missing" }] });
  const stop = app.execute(actor, { kind: "job.stop", requestId: crypto.randomUUID(), projectId: f.project.id,
    expectedRevision: waiting.revision, payload: { jobId: original.id } });
  expect(stop.stop?.transport).toBe("cancellation_requested");
  expect(stop.stop?.transport).not.toBe("not_dispatched");
  release(); await f.queue.idle();
});

test("I: in-process finalizer keeps cancellation_requested until every watched attempt settles", async () => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(r => { release = r; }); releases.push(release);
  const started = new Promise<void>(r => { entered = r; });
  const work = definition(async () => { entered(); await gate; return { state: "succeeded", evidence: "newer" }; });
  const f = await fixture({ definitions: [work] }), original = f.app.execute(f.auth.actor, command(f)).job;
  f.queue.pump(); await started;
  const liveId = job(f, original.id).attempts[0]!.id, olderId = crypto.randomUUID();
  f.store.transaction(tx => {
    const live = JSON.parse(tx.get<{ record_json: string }>("SELECT record_json FROM job_attempts WHERE id = ?", liveId)!.record_json);
    const older = {
      ...live, id: olderId, generation: live.generation, state: "interrupted", reason: "interrupted",
      transport: "dispatched", native: null, nativeState: "missing", contextState: "none",
    };
    tx.run("INSERT INTO job_attempts (id, job_id, record_json) VALUES (?, ?, ?)", olderId, original.id, JSON.stringify(older));
  });
  const stop = f.app.execute(f.auth.actor, { kind: "job.stop", requestId: crypto.randomUUID(), projectId: f.project.id,
    expectedRevision: job(f, original.id).revision, payload: { jobId: original.id } });
  expect(new Set(stop.stop?.attemptIds)).toEqual(new Set([olderId, liveId]));
  expect(stop.stop?.transport).toBe("cancellation_requested");
  release(); await f.queue.idle();
  const afterOne = job(f, original.id);
  expect(afterOne.attempts.find(a => a.id === liveId)).toMatchObject({ transport: "settled" });
  expect(afterOne.attempts.find(a => a.id === olderId)).toMatchObject({ transport: "dispatched" });
  expect(afterOne.stop).toMatchObject({ transport: "cancellation_requested", attemptIds: expect.arrayContaining([olderId, liveId]) });
  expect(afterOne.stop?.transport).not.toBe("observed_stopped");
});

test("pr.snapshot read work captures through the commit fence and respects revoke invalidation", async () => {
  const { ensurePrSchema, mutateMonitor, pollMonitorCatchUp, readCandidates, fixturePull, FakeGitHubFixture,
    TrustedGitHubConnector, prSnapshotWork, fencePrCandidateJobs, TRIGGER_POLICY_VERSION } = await import("../src/pr");
  const root = mkdtempSync(join(tmpdir(), "jit-job-pr-")); roots.push(root);
  const path = join(root, "app.sqlite"), config = readConfig({ JIT_DATABASE: path }), store = new TransactionStore(path); stores.push(store);
  const clock = new Clock(), github = new FakeGitHubFixture();
  const work = prSnapshotWork({ store, cacheRoot: join(root, "cache"), fixtureFor: () => github });
  const queue = new JobQueue(store, config.jobs, [work], { now: () => clock.now, timers: clock.timers }); queues.push(queue);
  const app = new Application(store, config, { jobs: queue, now: () => clock.now });
  await app.setupOwner(password); const token = await app.login(password), auth = app.authenticate(token);
  const project = app.execute(auth.actor, { kind: "project.create", requestId: crypto.randomUUID(), projectId: null, expectedRevision: 0, payload: { name: "pr" } }).project;
  const sha = (n: number) => n.toString(16).padStart(40, "0");
  const base = sha(1), head = sha(2);
  github.pulls = [fixturePull({ number: 1, base: { sha: base, ref: "main" }, head: { sha: head, ref: "f" } })];
  github.files.set(github.key(1, base, head), [{ filename: "a.ts", status: "modified", patch: "@@\n+a" }]);
  github.checks.set(head, []);
  const monitor = store.transaction(tx => {
    ensurePrSchema(tx);
    return mutateMonitor(tx, {
      kind: "pr.monitor.enable", requestId: crypto.randomUUID(), projectId: project.id, expectedRevision: 1,
      payload: { repository: { host: "github.com", owner: "acme", name: "app" }, apiBase: "https://api.github.com",
        allowed: { issues: false, specs: false, ci: true }, acceptPolicyVersion: TRIGGER_POLICY_VERSION },
    }, clock.now).monitor;
  });
  const conn = new TrustedGitHubConnector(github, monitor, join(root, "cache"));
  store.transaction(tx => pollMonitorCatchUp(tx, project.id, monitor.id, conn, clock.now));
  const candidate = store.read(tx => readCandidates(tx, project.id, monitor.id)[0]!);
  const receipt = app.execute(auth.actor, {
    kind: "job.enqueue", requestId: crypto.randomUUID(), projectId: project.id, expectedRevision: store.read(tx => tx.get<{ revision: number }>("SELECT revision FROM projects WHERE id = ?", project.id)!.revision),
    payload: { type: "pr.snapshot", configurationRevision: 1, policyRevision: 1, purpose: "snap", inputRevision: 1,
      input: { monitorId: monitor.id, candidateId: candidate.id }, priority: "background", limits: structuredClone(limits) },
  });
  queue.pump(); await queue.idle();
  expect(app.job(auth.actor, project.id, receipt.job.id)).toMatchObject({ state: "succeeded" });
  expect(app.job(auth.actor, project.id, receipt.job.id).evidence).toContain("coverage:complete");

  const second = app.execute(auth.actor, {
    kind: "job.enqueue", requestId: crypto.randomUUID(), projectId: project.id,
    expectedRevision: store.read(tx => tx.get<{ revision: number }>("SELECT revision FROM projects WHERE id = ?", project.id)!.revision),
    payload: { type: "pr.snapshot", configurationRevision: 1, policyRevision: 1, purpose: "late", inputRevision: 1,
      input: { monitorId: monitor.id, candidateId: candidate.id }, priority: "background", limits: structuredClone(limits) },
  }).job;
  const projectRev = store.read(tx => tx.get<{ revision: number }>("SELECT revision FROM projects WHERE id = ?", project.id)!.revision);
  store.transaction(tx => {
    const live = readCandidates(tx, project.id, monitor.id)[0]!;
    live.jobId = second.id;
    tx.run("UPDATE pr_candidates SET record_json = ? WHERE id = ?", JSON.stringify(live), live.id);
    mutateMonitor(tx, {
      kind: "pr.monitor.revoke", requestId: crypto.randomUUID(), projectId: project.id,
      expectedRevision: projectRev, payload: { monitorId: monitor.id },
    }, clock.now, (m) => {
      for (const row of readCandidates(tx, project.id, m.id)) fencePrCandidateJobs(tx, queue, project.id, row, "revoked");
    });
  });
  queue.cancelFenced();
  queue.pump(); await queue.idle();
  expect(app.job(auth.actor, project.id, second.id).state).not.toBe("succeeded");
});
