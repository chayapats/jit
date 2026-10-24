import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Application } from "../src/application";
import { readConfig } from "../src/config";
import { planUpgrade, type UpgradeJournal } from "../src/ops/upgrade";
import { memoryExtractionMarker, memoryExtractionWork, scriptedMemoryResult } from "../src/memory/extract";
import type { ClaimReference, MemoryClaim } from "../src/memory/types";
import type { SourceReference } from "../src/sources";
import { JobQueue } from "../src/jobs/queue";
import { ScriptedRunPort, fixtureOutcome, withContextAnswer } from "../src/team/scripted-port";
import type { ApplicationRunPort } from "../src/team/run-port";
import type { ApplicationRunRequest, RoleRoute, TeamCommand } from "../src/team/types";
import { coordinatorSynthesisMarker, coordinatorSynthesisWork } from "../src/team/decisions";
import { discussionPlanWork, specialistAnalysisWork } from "../src/team/dispatch";
import { TransactionStore } from "../src/store";
import { createWebHandler } from "../src/web";

const roots: string[] = [], stores: TransactionStore[] = [], live: JobQueue[] = [];
afterEach(async () => {
  for (const q of live.splice(0)) { q.close(); await q.idle(); }
  for (const s of stores.splice(0)) s.close();
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});
const rid = () => crypto.randomUUID(), epoch = 1800000000000, password = "ops-upgrade-owner-password";
const grok: RoleRoute = { provider: "grok", model: "fixture-grok-exact", authRoute: "owner-grok" };
type Script = (request: ApplicationRunRequest, signal: AbortSignal) => unknown | Promise<unknown>;
type Config = ReturnType<typeof readConfig>;

function boot(config: Config, hooks: { extract: Script; specialist: Script }, clock: { now: number }, dirs: { backup: string; export: string; upgrade: string }, native: boolean) {
  const store = new TransactionStore(config.databasePath); stores.push(store);
  const script = (request: ApplicationRunRequest, signal: AbortSignal, observe: (event: never) => void) =>
    request.instructions.operator.includes(memoryExtractionMarker) ? hooks.extract(request, signal)
      : request.instructions.operator.includes(coordinatorSynthesisMarker) ? fixtureOutcome("complete", JSON.stringify(synthesisJson(request)))
      : hooks.specialist(request, signal);
  const port = new ScriptedRunPort(store, config.team, config.jobs.outputBytes, script, () => false, () => false);
  const now = () => clock.now;
  const queue = new JobQueue(store, config.jobs, [memoryExtractionWork(store, config, port, now), discussionPlanWork(),
    specialistAnalysisWork(store, config, port, now), coordinatorSynthesisWork(store, config, port, now)], { now }); live.push(queue);
  const nativeSnapshot = native ? { available: () => true, snapshot: () => ({ refs: [] as { id: string; generation: number }[], bytes: 128, engine: "scripted-fixture-v1" }) } : undefined;
  const app = new Application(store, config, { jobs: queue, now, backupDir: dirs.backup, exportDir: dirs.export, upgradeDir: dirs.upgrade, ...(nativeSnapshot ? { nativeSnapshot } : {}) });
  return { store, port, queue, app };
}

function synthesisJson(request: ApplicationRunRequest) {
  const citations = request.manifest.sources.map(source => ({ ...source.reference }));
  return { question: "เจ้าของจะเลือกทางใด", disagreement: false, consensus: true, options: [
    { id: "first", label: "ทางแรก", rationale: "ตามผลวิเคราะห์", citations },
    { id: "second", label: "ทางที่สอง", rationale: "alternative", citations },
  ] };
}

async function fixture(native = true) {
  const root = mkdtempSync(join(tmpdir(), "jit-ops-upgrade-")); roots.push(root);
  const config = readConfig({ JIT_DATABASE: join(root, "state.sqlite") }), clock = { now: epoch };
  const defaults = {
    extract: ((request: ApplicationRunRequest) => scriptedMemoryResult(request, true)) as Script,
    specialist: ((request: ApplicationRunRequest) => fixtureOutcome("complete", withContextAnswer("ตอบจำลอง", request, config.jobs.outputBytes))) as Script,
  };
  const hooks = { ...defaults };
  const dirs = { backup: join(root, "backups"), export: join(root, "exports"), upgrade: join(root, "upgrades") };
  const rt = boot(config, hooks, clock, dirs, native);
  await rt.app.setupOwner(password);
  const f = { root, config, clock, hooks, defaults, dirs, rt, token: await rt.app.login(password), roles: { tech: "", coordinator: "" } };
  const owner = rt.app.authenticate(f.token).actor;
  f.roles.tech = rt.app.execute(owner, { kind: "role.save", projectId: null, requestId: rid(), expectedRevision: rt.app.team(owner).ownerRevision,
    payload: { roleId: null, name: "เทคโนโลยี", kind: "specialist", responsibility: "วิเคราะห์ฐานข้อมูลและโครงสร้างซอฟต์แวร์", enabled: true, route: grok } }).role!.id;
  f.roles.coordinator = rt.app.execute(owner, { kind: "role.save", projectId: null, requestId: rid(), expectedRevision: rt.app.team(owner).ownerRevision,
    payload: { roleId: null, name: "ผู้ประสานงาน", kind: "coordinator", responsibility: "สรุปความเห็นต่างให้เจ้าของตัดสิน", enabled: true, route: grok } }).role!.id;
  return f;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const actor = (f: Fixture) => f.rt.app.authenticate(f.token).actor;
const dirsOf = (f: Fixture) => f.dirs;
async function restart(f: Fixture, native = true) {
  f.rt.queue.close(); await f.rt.queue.idle(); live.splice(live.indexOf(f.rt.queue), 1);
  f.rt.store.close(); stores.splice(stores.indexOf(f.rt.store), 1);
  f.rt = boot(f.config, f.hooks, f.clock, dirsOf(f), native);
}
async function drain(f: Fixture) {
  for (let i = 0; i < 400; i++) {
    f.rt.queue.pump();
    const pending = f.rt.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM jobs WHERE state IN ('queued', 'admitted')")!.n);
    if (pending === 0) { await f.rt.queue.idle(); return; }
    await f.rt.queue.idle(); await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error("queue did not drain");
}
function project(f: Fixture, name: string, title: string) {
  const created = f.rt.app.execute(actor(f), { kind: "project.create", projectId: null, requestId: rid(), expectedRevision: f.rt.app.workspace(actor(f)).revision, payload: { name } }).project;
  const topic = f.rt.app.execute(actor(f), { kind: "topic.create", requestId: rid(), projectId: created.id, expectedRevision: created.revision, payload: { title } }).topic;
  return { id: created.id, topic };
}
type Project = ReturnType<typeof project>;
const projectRevision = (f: Fixture, p: Project) => f.rt.app.project(actor(f), p.id).revision;
const topicRevision = (f: Fixture, p: Project) => f.rt.app.conversation(actor(f), p.id, p.topic.id).topic.revision;
function say(f: Fixture, p: Project, text: string): SourceReference {
  return f.rt.app.execute(actor(f), { kind: "message.send", requestId: rid(), projectId: p.id, expectedRevision: topicRevision(f, p), payload: { topicId: p.topic.id, text } }).message.source;
}
const ref = (claim: ClaimReference): ClaimReference => ({ claimId: claim.claimId, revision: claim.revision, generation: claim.generation });
async function remember(f: Fixture, p: Project, source: SourceReference): Promise<MemoryClaim[]> {
  const before = new Set(f.rt.app.memory(actor(f), p.id).items.flatMap(item => item.state === "available" ? [item.claim.claimId] : []));
  f.rt.app.execute(actor(f), { kind: "memory.extract" as const, requestId: rid(), projectId: p.id, expectedRevision: projectRevision(f, p),
    payload: { topicId: p.topic.id, roleId: f.roles.tech, source, dependencies: [], limits: { ...f.config.jobs.maximum } } });
  await drain(f);
  return f.rt.app.memory(actor(f), p.id).items.flatMap(item => item.state === "available" && !before.has(item.claim.claimId) ? [item.claim] : []);
}
const appRevision = (f: Fixture) => f.rt.app.workspace(actor(f)).revision;
const prepareCommand = (f: Fixture, targetSchema: number, requestId = rid()) => ({
  kind: "upgrade.prepare" as const, requestId, projectId: null, expectedRevision: appRevision(f),
  payload: { targetSchema, note: "test upgrade" },
});
const stepCommand = (f: Fixture, kind: "upgrade.migrate" | "upgrade.validate" | "upgrade.activate" | "upgrade.rollback", upgradeId: string, requestId = rid()) => ({
  kind, requestId, projectId: null, expectedRevision: appRevision(f), payload: { upgradeId },
});
function dispatch(f: Fixture, p: Project, purpose: string): Extract<TeamCommand, { kind: "team.dispatch" }> {
  return { kind: "team.dispatch", requestId: rid(), projectId: p.id, expectedRevision: projectRevision(f, p),
    payload: { topicId: p.topic.id, purpose, sources: [p.topic.source], include: [f.roles.tech], exclude: [], limits: { ...f.config.jobs.maximum } } };
}

/** Seeds tasks, a decision, corrected/forgotten memory, a deletion ledger, deliveries and queued work. */
async function rich(f: Fixture) {
  const a = project(f, "โครงการอัปเกรด ไทย/English 🧠", "หัวข้ออัปเกรด");
  const sKeep = say(f, a, "ความรู้ที่เก็บไว้ upgrade-keep-001");
  const [keep] = await remember(f, a, sKeep);
  const sWrong = say(f, a, "ข้อความที่ผิด upgrade-fix-002!");
  const [wrong] = await remember(f, a, sWrong);
  const sFix = say(f, a, "ข้อความที่ถูก upgrade-fix-002! จบ");
  f.rt.app.execute(actor(f), { kind: "memory.correct" as const, requestId: rid(), projectId: a.id, expectedRevision: projectRevision(f, a),
    payload: { claim: ref(wrong!), text: "ข้อความที่แก้แล้ว", quote: "upgrade-fix-002!", source: { ...sFix }, reason: "แก้" } });
  const sForget = say(f, a, "เรื่องลืม upgrade-forget-003");
  const [forgotten] = await remember(f, a, sForget);
  f.rt.app.execute(actor(f), { kind: "memory.forget" as const, requestId: rid(), projectId: a.id, expectedRevision: projectRevision(f, a),
    payload: { claim: ref(forgotten!), reason: "ลืม", acknowledged: true } });
  f.rt.app.execute(actor(f), { kind: "task.propose", requestId: rid(), projectId: a.id, expectedRevision: topicRevision(f, a),
    payload: { topicId: a.topic.id, title: "งานก่อนอัปเกรด", summary: "ต้องคงอยู่หลังอัปเกรด" } });
  f.rt.app.execute(actor(f), dispatch(f, a, "ตัดสินใจก่อนอัปเกรด"));
  await drain(f);
  const discussion = f.rt.app.discussions(actor(f), a.id, a.topic.id)[0]!;
  const synthesis = f.rt.app.execute(actor(f), { kind: "decision.synthesize", requestId: rid(), projectId: a.id, expectedRevision: discussion.revision,
    payload: { discussionId: discussion.id, limits: { ...f.config.jobs.maximum } } });
  void synthesis;
  await drain(f);
  const proposal = f.rt.app.decision(actor(f), a.id, a.topic.id).proposal!;
  f.rt.app.execute(actor(f), { kind: "decision.accept", requestId: rid(), projectId: a.id, expectedRevision: proposal.revision,
    payload: { proposalId: proposal.id, optionId: proposal.artifact.options[0]!.id, conclusion: "เลือกทางแรก", rationale: "เจ้าของเห็นด้วย" } });
  f.rt.app.execute(actor(f), { kind: "delivery.commit", requestId: rid(), projectId: a.id, expectedRevision: projectRevision(f, a),
    payload: { kind: "report", text: "รายงานก่อนอัปเกรด", dedupeKey: "pre-upgrade-1" } });
  // One queued discussion (survives upgrade) and one stopped job (terminal, preserved).
  const queued = f.rt.app.execute(actor(f), dispatch(f, a, "งานค้างข้ามอัปเกรด"));
  const queuedJobId = queued.discussion!.jobId;
  f.rt.app.execute(actor(f), dispatch(f, a, "งานที่จะหยุด"));
  const toStop = f.rt.store.read(tx => tx.all<{ record_json: string }>("SELECT record_json FROM jobs WHERE project_id = ? ORDER BY sequence DESC LIMIT 5", a.id)
    .map(r => JSON.parse(r.record_json) as { id: string; state: string; revision: number }).find(j => j.state === "queued")!);
  f.rt.app.execute(actor(f), { kind: "job.stop", requestId: rid(), projectId: a.id, expectedRevision: toStop.revision, payload: { jobId: toStop.id } });
  return { a, keep: keep!, sKeep: sKeep!, queuedJobId };
}

test("preflight matrix rejects downgrade, future schema, newer live and missing engine", () => {
  expect(planUpgrade(20, 20, "scripted-fixture-v1")).toEqual({ compatible: true, reason: null,
    plannedSteps: ["quiesce", "snapshot", "migrate", "validate", "activate"] });
  expect(planUpgrade(15, 20, "scripted-fixture-v1").compatible).toBe(true);
  expect(planUpgrade(20, 99, "scripted-fixture-v1")).toMatchObject({ compatible: false, reason: "forward_upgrade_unsupported" });
  expect(planUpgrade(20, 19, "scripted-fixture-v1")).toMatchObject({ compatible: false, reason: "downgrade_rejected" });
  expect(planUpgrade(99, 99, "scripted-fixture-v1")).toMatchObject({ compatible: false, reason: "newer_schema_unsupported" });
  expect(planUpgrade(14, 19, "scripted-fixture-v1")).toMatchObject({ compatible: false, reason: "manual_recovery_required" });
  expect(planUpgrade(20, 20, null)).toMatchObject({ compatible: false, reason: "engine_unavailable" });
});

test("newer-than-supported database fails at startup without writes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jit-upgrade-future-")); roots.push(dir);
  const path = join(dir, "future.sqlite");
  const db = new Database(path);
  db.exec("CREATE TABLE t(x TEXT); PRAGMA user_version = 99;"); db.close();
  expect(() => new TransactionStore(path)).toThrow("newer");
});

test("unsupported targets and missing engine fail before mutating, with failed journals", async () => {
  const f = await fixture();
  const { a } = await rich(f);
  void a;
  const before = f.rt.app.upgrades(actor(f)).journals.length;
  expect(() => f.rt.app.execute(actor(f), prepareCommand(f, 99))).toThrow("unsupported_upgrade");
  expect(() => f.rt.app.execute(actor(f), prepareCommand(f, 19))).toThrow("unsupported_upgrade");
  expect(f.rt.app.upgrades(actor(f)).journals.length).toBe(before + 2);
  expect(f.rt.app.upgrades(actor(f)).journals.every(j => j.state === "failed")).toBe(true);
  const broken = await fixture(false);
  expect(() => broken.rt.app.execute(actor(broken), prepareCommand(broken, 22))).toThrow("engine_unavailable");
});

test("happy path preserves tasks, decisions, claims, receipts, jobs and outbox across activation", async () => {
  const f = await fixture();
  const { a, keep, queuedJobId } = await rich(f);
  const ledgersBefore = f.rt.app.deletionLedger(actor(f)).tombstones.length;
  const tasksBefore = f.rt.app.tasks(actor(f), a.id);
  const prepared = f.rt.app.execute(actor(f), prepareCommand(f, 22));
  expect(prepared.journal.state).toBe("prepared");
  expect(prepared.journal.snapshotBackupId).toBeString();
  expect(prepared.journal.sidecarPath).toBeString();
  expect(prepared.journal.preflight.compatible).toBe(true);
  const migrated = f.rt.app.execute(actor(f), stepCommand(f, "upgrade.migrate", prepared.journal.id));
  expect(migrated.journal.state).toBe("staged");
  expect(migrated.journal.stagedSchema).toBe(22);
  const validated = f.rt.app.execute(actor(f), stepCommand(f, "upgrade.validate", prepared.journal.id));
  expect(validated.journal.state).toBe("ready");
  expect(validated.journal.validation!.checks.every(c => c.pass)).toBe(true);
  expect(validated.journal.validation!.ledgersMatch).toBe(true);
  const completed = f.rt.app.execute(actor(f), stepCommand(f, "upgrade.activate", prepared.journal.id));
  expect(completed.journal.state).toBe("complete");
  expect(completed.journal.nextAction).toContain("reconcile");
  // State survived the swap: tasks, decision, memory, receipts, queued jobs, outbox, ledgers.
  expect(f.rt.app.tasks(actor(f), a.id).proposed).toHaveLength(tasksBefore.proposed.length);
  expect(f.rt.app.decision(actor(f), a.id, a.topic.id).currentDecision!.decision.conclusion).toBe("เลือกทางแรก");
  expect(f.rt.app.memoryClaim(actor(f), a.id, ref(keep)).state).toBe("available");
  expect(f.rt.app.jobs(actor(f), a.id).items.some(j => j.id === queuedJobId)).toBe(true);
  expect(f.rt.app.deliveries(actor(f), a.id).items.length).toBeGreaterThan(0);
  expect(f.rt.app.deletionLedger(actor(f)).tombstones.length).toBe(ledgersBefore);
  expect(f.rt.app.upgrades(actor(f)).journals.some(j => j.state === "complete")).toBe(true);
});

test("unquiesced running work fails validation; drained work passes", async () => {
  const f = await fixture();
  const a = project(f, "โครงการ quiesce", "หัวข้อ quiesce");
  say(f, a, "ข้อความ quiesce");
  const prepared = f.rt.app.execute(actor(f), prepareCommand(f, 22));
  const migrated = f.rt.app.execute(actor(f), stepCommand(f, "upgrade.migrate", prepared.journal.id));
  expect(migrated.journal.state).toBe("staged");
  let release: (() => void) | null = null;
  f.hooks.specialist = (request: ApplicationRunRequest) => new Promise<unknown>(resolve => {
    release = () => resolve(fixtureOutcome("complete", withContextAnswer("ตอบจำลอง", request, f.config.jobs.outputBytes)));
  });
  f.rt.app.execute(actor(f), dispatch(f, a, "งานที่กำลังรัน"));
  f.rt.queue.pump();
  await new Promise(resolve => setTimeout(resolve, 20));
  let blocked;
  try {
    blocked = f.rt.app.execute(actor(f), stepCommand(f, "upgrade.validate", prepared.journal.id));
  } finally {
    release!();
  }
  expect(blocked.journal.state).toBe("failed");
  expect(blocked.journal.validation!.checks.find(c => c.name === "quiesce")!.pass).toBe(false);
  await drain(f);
  const ready = f.rt.app.execute(actor(f), stepCommand(f, "upgrade.validate", prepared.journal.id));
  expect(ready.journal.state).toBe("ready");
  expect(f.rt.app.execute(actor(f), stepCommand(f, "upgrade.activate", prepared.journal.id)).journal.state).toBe("complete");
});

test("crash at every journal boundary leaves a resumable journal; reopen preserves it", async () => {
  const f = await fixture();
  const { a } = await rich(f);
  void a;
  let fail = "";
  const fragile = (stage: string) => new Application(f.rt.store, f.config, { jobs: f.rt.queue, now: () => f.clock.now,
    backupDir: f.dirs.backup, exportDir: f.dirs.export, upgradeDir: f.dirs.upgrade,
    nativeSnapshot: { available: () => true, snapshot: () => ({ refs: [], bytes: 8, engine: "scripted-fixture-v1" }) },
    beforeCommit(s) { if (s === stage && fail === stage) throw new Error(`fixture ${stage} crash`); } });
  const fragileActor = (app: Application) => app.authenticate(f.token).actor;
  // Crash at prepare: nothing commits, but an explicit failed journal is recorded; resume prepares anew.
  fail = "ops";
  const app = fragile("ops");
  const target = 22;
  expect(() => app.execute(fragileActor(app), { kind: "upgrade.prepare" as const, requestId: rid(), projectId: null,
    expectedRevision: app.workspace(fragileActor(app)).revision, payload: { targetSchema: target, note: "x" } })).toThrow("fixture ops crash");
  const interrupted = app.upgrades(fragileActor(app)).journals.find(j => j.state === "failed")!;
  expect(interrupted).toBeDefined();
  expect(interrupted.reason).toBe("interrupted_at_snapshot");
  fail = "";
  const prepared = app.execute(fragileActor(app), { kind: "upgrade.prepare" as const, requestId: rid(), projectId: null,
    expectedRevision: app.workspace(fragileActor(app)).revision, payload: { targetSchema: target, note: "x" } });
  const discovered = prepared.journal;
  expect(discovered.state).toBe("prepared");
  const resumed = app.execute(fragileActor(app), stepCommand(f, "upgrade.migrate", discovered.id));
  expect(resumed.journal.state).toBe("staged");
  // Crash at migrate: staged file and journal persist; re-migrate is idempotent.
  fail = "ops";
  const crashing = fragile("ops");
  expect(() => crashing.execute(fragileActor(crashing), stepCommand(f, "upgrade.migrate", discovered.id, rid()))).toThrow("fixture ops crash");
  fail = "";
  expect(crashing.execute(fragileActor(crashing), stepCommand(f, "upgrade.migrate", discovered.id)).journal.state).toBe("staged");
  // Crash at validate and activate, with a reopen between each.
  fail = "ops";
  expect(() => crashing.execute(fragileActor(crashing), stepCommand(f, "upgrade.validate", discovered.id, rid()))).toThrow("fixture ops crash");
  fail = "";
  await restart(f);
  expect(f.rt.app.execute(actor(f), stepCommand(f, "upgrade.validate", discovered.id)).journal.state).toBe("ready");
  fail = "ops";
  const crashing2 = fragile("ops");
  expect(() => crashing2.execute(fragileActor(crashing2), stepCommand(f, "upgrade.activate", discovered.id, rid()))).toThrow("fixture ops crash");
  fail = "";
  await restart(f);
  const done = f.rt.app.execute(actor(f), stepCommand(f, "upgrade.activate", discovered.id));
  expect(done.journal.state).toBe("complete");
  expect(f.rt.app.upgrade(actor(f), discovered.id).journal.state).toBe("complete");
});

test("rollback restores the snapshot and never clears a ledger", async () => {
  const f = await fixture();
  const { a } = await rich(f);
  const ledgersBefore = f.rt.app.deletionLedger(actor(f)).tombstones;
  const prepared = f.rt.app.execute(actor(f), prepareCommand(f, 22));
  f.rt.app.execute(actor(f), stepCommand(f, "upgrade.migrate", prepared.journal.id));
  f.rt.app.execute(actor(f), stepCommand(f, "upgrade.validate", prepared.journal.id));
  f.rt.app.execute(actor(f), stepCommand(f, "upgrade.activate", prepared.journal.id));
  const afterActivate = say(f, a, "ข้อความหลัง activate ต้องหายไปเมื่อ rollback");
  expect(f.rt.app.conversation(actor(f), a.id, a.topic.id).items.some((m: { source: SourceReference }) => m.source.sourceId === afterActivate.sourceId)).toBe(true);
  const rolled = f.rt.app.execute(actor(f), stepCommand(f, "upgrade.rollback", prepared.journal.id));
  expect(rolled.journal.state).toBe("rolled_back");
  const messages = f.rt.app.conversation(actor(f), a.id, a.topic.id).items;
  expect(messages.some((m: { source: SourceReference }) => m.source.sourceId === afterActivate.sourceId)).toBe(false);
  expect(f.rt.app.deletionLedger(actor(f)).tombstones).toEqual(ledgersBefore);
  expect(f.rt.app.upgrade(actor(f), prepared.journal.id).journal.state).toBe("rolled_back");
});

test("web upgrades render journals without secrets and drive the full flow", async () => {
  const f = await fixture();
  const { a } = await rich(f);
  void a;
  const web = createWebHandler(f.rt.app);
  const req = (path: string, method = "GET", body?: unknown) => new Request(`http://localhost:3000${path}`, { method,
    headers: { cookie: `jit_session=${f.token}`, ...(body ? { origin: "http://localhost:3000", "x-csrf-token": f.rt.app.authenticate(f.token).csrf, "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const prepared = await (await web(req("/api/upgrades", "POST", { requestId: rid(), expectedRevision: appRevision(f), targetSchema: 22, note: "web" }))).json() as { journal: UpgradeJournal };
  expect(prepared.journal.state).toBe("prepared");
  for (const action of ["migrate", "validate", "activate"] as const) {
    const receipt = await (await web(req(`/api/upgrades/${prepared.journal.id}`, "POST",
      { requestId: rid(), expectedRevision: appRevision(f), action }))).json() as { journal: UpgradeJournal };
    expect(receipt.journal).toBeDefined();
  }
  const final = f.rt.app.upgrade(actor(f), prepared.journal.id).journal;
  expect(final.state).toBe("complete");
  const html = await (await web(req(`/upgrades/${prepared.journal.id}`, "GET"))).text();
  expect(html).toContain("ops.schema_migrations/v1");
  expect(html).not.toContain(f.token);
});
