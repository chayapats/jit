import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Application } from "../src/application";
import { readConfig } from "../src/config";
import { reconcileDeletions } from "../src/memory/delete";
import { restoreCompat, type ExternalTombstone } from "../src/ops/restore";
import { memoryExtractionMarker, memoryExtractionWork, scriptedMemoryResult } from "../src/memory/extract";
import type { ClaimReference, MemoryClaim } from "../src/memory/types";
import type { SourceReference } from "../src/sources";
import { JobQueue } from "../src/jobs/queue";
import { ScriptedRunPort, fixtureOutcome, withContextAnswer } from "../src/team/scripted-port";
import type { ApplicationRunPort } from "../src/team/run-port";
import type { ApplicationRunRequest, RoleRoute, TeamCommand } from "../src/team/types";
import { discussionPlanWork, specialistAnalysisWork } from "../src/team/dispatch";
import { coordinatorSynthesisMarker, coordinatorSynthesisWork } from "../src/team/decisions";
import { TransactionStore } from "../src/store";
import { createWebHandler } from "../src/web";

const roots: string[] = [], stores: TransactionStore[] = [], live: JobQueue[] = [];
afterEach(async () => {
  for (const q of live.splice(0)) { q.close(); await q.idle(); }
  for (const s of stores.splice(0)) s.close();
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});
const rid = () => crypto.randomUUID(), epoch = 1800000000000, password = "ops-restore-owner-password";
const grok: RoleRoute = { provider: "grok", model: "fixture-grok-exact", authRoute: "owner-grok" };
type Script = (request: ApplicationRunRequest, signal: AbortSignal) => unknown | Promise<unknown>;
type Config = ReturnType<typeof readConfig>;

function boot(config: Config, hooks: { extract: Script; specialist: Script }, clock: { now: number }, dirs: { backup: string; restore: string }, flags: { deleteFail: boolean }) {
  const store = new TransactionStore(config.databasePath); stores.push(store);
  const script = (request: ApplicationRunRequest, signal: AbortSignal, observe: (event: never) => void) =>
    request.instructions.operator.includes(memoryExtractionMarker) ? hooks.extract(request, signal)
      : request.instructions.operator.includes(coordinatorSynthesisMarker) ? fixtureOutcome("complete", JSON.stringify({ question: "q", disagreement: false, consensus: true, options: [] }))
      : hooks.specialist(request, signal);
  const port = new ScriptedRunPort(store, config.team, config.jobs.outputBytes, script, () => flags.deleteFail, () => false);
  const now = () => clock.now;
  const queue = new JobQueue(store, config.jobs, [memoryExtractionWork(store, config, port, now), discussionPlanWork(),
    specialistAnalysisWork(store, config, port, now), coordinatorSynthesisWork(store, config, port, now)], { now }); live.push(queue);
  const nativeSnapshot = { available: () => true, snapshot: () => ({ refs: [] as { id: string; generation: number }[], bytes: 128, engine: "scripted-fixture-v1" }) };
  const app = new Application(store, config, { jobs: queue, now, backupDir: dirs.backup, restoreDir: dirs.restore, nativeSnapshot });
  return { store, port, queue, app };
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "jit-ops-restore-")); roots.push(root);
  const config = readConfig({ JIT_DATABASE: join(root, "state.sqlite") }), clock = { now: epoch }, flags = { deleteFail: false };
  const defaults = {
    extract: ((request: ApplicationRunRequest) => scriptedMemoryResult(request, true)) as Script,
    specialist: ((request: ApplicationRunRequest) => fixtureOutcome("complete", withContextAnswer("ตอบจำลอง", request, config.jobs.outputBytes))) as Script,
  };
  const hooks = { ...defaults };
  const dirs = { backup: join(root, "backups"), restore: join(root, "restores") };
  const rt = boot(config, hooks, clock, dirs, flags);
  await rt.app.setupOwner(password);
  const f = { root, config, clock, flags, hooks, defaults, dirs, rt, token: await rt.app.login(password), roles: { tech: "" } };
  const owner = rt.app.authenticate(f.token).actor;
  f.roles.tech = rt.app.execute(owner, { kind: "role.save", projectId: null, requestId: rid(), expectedRevision: rt.app.team(owner).ownerRevision,
    payload: { roleId: null, name: "เทคโนโลยี", kind: "specialist", responsibility: "วิเคราะห์ฐานข้อมูลและโครงสร้างซอฟต์แวร์", enabled: true, route: grok } }).role!.id;
  return f;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const actor = (f: Fixture) => f.rt.app.authenticate(f.token).actor;
async function restart(f: Fixture) {
  f.rt.queue.close(); await f.rt.queue.idle(); live.splice(live.indexOf(f.rt.queue), 1);
  f.rt.store.close(); stores.splice(stores.indexOf(f.rt.store), 1);
  f.rt = boot(f.config, f.hooks, f.clock, f.dirs, f.flags);
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
const prepareRestore = (f: Fixture, backupId: string, requestId = rid()) => f.rt.app.execute(actor(f), {
  kind: "restore.prepare" as const, requestId, projectId: null, expectedRevision: appRevision(f), payload: { backupId, note: "test restore" } });
const stepRestore = (f: Fixture, kind: "restore.migrate" | "restore.validate" | "restore.activate" | "restore.discard", quarantineId: string, requestId = rid()) => f.rt.app.execute(actor(f), {
  kind, requestId, projectId: null, expectedRevision: appRevision(f), payload: { quarantineId } });
const applyLedger = (f: Fixture, quarantineId: string, tombstones: ExternalTombstone[], source: string, asOf: number, acknowledgedEmpty = false, requestId = rid()) => f.rt.app.execute(actor(f), {
  kind: "restore.apply_ledger" as const, requestId, projectId: null, expectedRevision: appRevision(f),
  payload: { quarantineId, tombstones, source, asOf, ...(acknowledgedEmpty ? { acknowledgedEmpty: true as const } : {}) } });
const liveTombstones = (f: Fixture): ExternalTombstone[] => f.rt.app.deletionLedger(actor(f)).tombstones.map(t => ({
  kind: t.kind, projectId: t.projectId, sourceId: t.sourceId, claimId: t.claimId, revision: t.revision, generation: t.generation }));
function deleteSource(f: Fixture, p: Project, source: SourceReference) {
  const preview = f.rt.app.execute(actor(f), { kind: "memory.delete.preview" as const, requestId: rid(), projectId: p.id,
    expectedRevision: projectRevision(f, p), payload: { scope: { kind: "source", projectId: p.id, source: { ...source } } } });
  const confirmed = f.rt.app.execute(actor(f), { kind: "memory.delete.confirm" as const, requestId: rid(), projectId: p.id,
    expectedRevision: projectRevision(f, p), payload: { previewId: (preview as { preview: { id: string } }).preview.id, acknowledged: true, acknowledgedWholeSession: false } });
  return confirmed as { operation: { id: string } };
}
const backupNow = (f: Fixture) => f.rt.app.execute(actor(f), { kind: "backup.create" as const, requestId: rid(), projectId: null,
  expectedRevision: appRevision(f), payload: { note: "restore fixture backup" } });

test("compat matrix routes direct, migrate and reject paths before touching data", () => {
  expect(restoreCompat(22)).toEqual({ action: "direct", reason: null });
  expect(restoreCompat(15)).toEqual({ action: "migrate", reason: null });
  expect(restoreCompat(21)).toEqual({ action: "migrate", reason: null });
  expect(restoreCompat(99)).toEqual({ action: "reject", reason: "newer_backup_unsupported" });
  expect(restoreCompat(3)).toEqual({ action: "reject", reason: "manual_recovery_required" });
});

test("older backup restores in quarantine, replays latest external tombstones and stays worker-silent", async () => {
  const f = await fixture();
  const a = project(f, "โครงการกู้คืน ไทย/English 🧠", "หัวข้อกู้คืน");
  const sKeep = say(f, a, "ความรู้ที่เก็บไว้ restore-keep-001 🌏");
  const [keep] = await remember(f, a, sKeep);
  const sDel = say(f, a, "ลบออก restore-del-002 ทิ้ง");
  const [doomed] = await remember(f, a, sDel);
  void doomed;
  f.rt.app.execute(actor(f), { kind: "delivery.commit", requestId: rid(), projectId: a.id, expectedRevision: projectRevision(f, a),
    payload: { kind: "report", text: "รายงานก่อนสำรอง", dedupeKey: "pre-backup-1" } });
  const snap = backupNow(f);
  f.clock.now += 60_000;
  const op = deleteSource(f, a, sDel);
  await reconcileDeletions(f.rt.store, f.rt.port as unknown as ApplicationRunPort, f.clock.now);
  expect(f.rt.app.deletionOperation(actor(f), a.id, op.operation.id).operation!.state).toBe("complete");
  // Live-only write after the backup: discarded by activation and disclosed in validation.
  const sNew = say(f, a, "ข้อความใหม่หลังสำรอง restore-new-003");
  const prepared = prepareRestore(f, snap.manifest.id);
  expect(prepared.quarantine.state).toBe("quarantining");
  expect(prepared.quarantine.fromSchema).toBe(22);
  const migrated = f.rt.app.execute(actor(f), { kind: "restore.migrate" as const, requestId: rid(), projectId: null,
    expectedRevision: appRevision(f), payload: { quarantineId: prepared.quarantine.id } });
  expect(migrated.quarantine.state).toBe("migrated");
  const applied = applyLedger(f, prepared.quarantine.id, liveTombstones(f), "live-deletion-ledger", f.clock.now);
  expect(applied.quarantine.state).toBe("ledger_applied");
  expect(applied.quarantine.ledger!.count).toBeGreaterThan(0);
  const validated = f.rt.app.execute(actor(f), { kind: "restore.validate" as const, requestId: rid(), projectId: null,
    expectedRevision: appRevision(f), payload: { quarantineId: prepared.quarantine.id } });
  expect(validated.quarantine.state).toBe("validated");
  expect(validated.quarantine.validation!.checks.every(c => c.pass)).toBe(true);
  expect(validated.quarantine.validation!.liveOnlySources).toBeGreaterThan(0);
  expect(validated.quarantine.nextAction).toContain("activate");
  // No worker, extractor, context or notification became active inside quarantine.
  const activated = f.rt.app.execute(actor(f), { kind: "restore.activate" as const, requestId: rid(), projectId: null,
    expectedRevision: appRevision(f), payload: { quarantineId: prepared.quarantine.id } });
  expect(activated.quarantine.state).toBe("complete");
  await restart(f);
  // Restored content serves; deleted payload cannot enter context/extraction/reports; live-only write is gone.
  expect(f.rt.app.source(actor(f), a.id, sKeep).state).toBe("available");
  expect(f.rt.app.memoryClaim(actor(f), a.id, ref(keep!)).state).toBe("available");
  expect(f.rt.app.source(actor(f), a.id, sDel).state).toBe("unavailable");
  expect(f.rt.app.memoryClaim(actor(f), a.id, ref(doomed!)).state).toBe("unavailable");
  expect(() => f.rt.app.execute(actor(f), { kind: "memory.extract" as const, requestId: rid(), projectId: a.id,
    expectedRevision: projectRevision(f, a), payload: { topicId: a.topic.id, roleId: f.roles.tech, source: { ...sDel }, dependencies: [], limits: { ...f.config.jobs.maximum } } })).toThrow("memory_source_deleted");
  expect(f.rt.app.conversation(actor(f), a.id, a.topic.id).items.some((m: { source: SourceReference }) => m.source.sourceId === sNew.sourceId)).toBe(false);
  expect(f.rt.app.deletionLedger(actor(f)).tombstones.some(t => t.sourceId === sDel.sourceId)).toBe(true);
});

test("missing, corrupt, stale or unverifiable ledgers keep the installation quarantined", async () => {
  const f = await fixture();
  const a = project(f, "โครงการ ledger", "หัวข้อ ledger");
  const s1 = say(f, a, "ข้อความหนึ่ง ledger-001");
  await remember(f, a, s1);
  const s2 = say(f, a, "ข้อความสอง ledger-002");
  await remember(f, a, s2);
  const op1 = deleteSource(f, a, s1);
  void op1;
  const snap = backupNow(f);
  f.clock.now += 60_000;
  const op2 = deleteSource(f, a, s2);
  void op2;
  // Unknown backup.
  expect(() => prepareRestore(f, crypto.randomUUID())).toThrow("backup_not_found");
  // Corrupt artifact bytes fail integrity with a recoverable source artifact.
  const artifactPath = f.rt.app.backup(actor(f), snap.manifest.id).manifest.artifact.path;
  writeFileSync(artifactPath, "corrupted-bytes");
  expect(() => prepareRestore(f, snap.manifest.id)).toThrow("backup_integrity_failed");
  expect(f.rt.app.backups(actor(f)).manifests.some(m => m.id === snap.manifest.id)).toBe(true);
});

test("stale or empty external ledgers block activation until resolved", async () => {
  const f = await fixture();
  const a = project(f, "โครงการ stale ledger", "หัวข้อ stale");
  const s1 = say(f, a, "stale หนึ่ง 001");
  await remember(f, a, s1);
  const s2 = say(f, a, "stale สอง 002");
  await remember(f, a, s2);
  deleteSource(f, a, s1);
  const snap = backupNow(f);
  f.clock.now += 60_000;
  deleteSource(f, a, s2);
  await reconcileDeletions(f.rt.store, f.rt.port as unknown as ApplicationRunPort, f.clock.now);
  const full = liveTombstones(f);
  expect(full.length).toBeGreaterThanOrEqual(2);
  const prepared = prepareRestore(f, snap.manifest.id);
  f.rt.app.execute(actor(f), { kind: "restore.migrate" as const, requestId: rid(), projectId: null,
    expectedRevision: appRevision(f), payload: { quarantineId: prepared.quarantine.id } });
  // Hand-crafted stale subset omits a backup-owned tombstone.
  const stale = full.filter(t => t.sourceId !== s1.sourceId);
  const appliedStale = applyLedger(f, prepared.quarantine.id, stale, "stale-copy", f.clock.now);
  expect(appliedStale.quarantine.state).toBe("ledger_applied");
  const blocked = f.rt.app.execute(actor(f), { kind: "restore.validate" as const, requestId: rid(), projectId: null,
    expectedRevision: appRevision(f), payload: { quarantineId: prepared.quarantine.id } });
  expect(blocked.quarantine.state).toBe("blocked");
  expect(blocked.quarantine.reason).toContain("blocked");
  expect(() => f.rt.app.execute(actor(f), { kind: "restore.activate" as const, requestId: rid(), projectId: null,
    expectedRevision: appRevision(f), payload: { quarantineId: prepared.quarantine.id } })).toThrow("restore_bad_state");
  // Empty ledger without acknowledgment is unverifiable; with acknowledgment it applies zero.
  f.rt.app.execute(actor(f), { kind: "restore.discard" as const, requestId: rid(), projectId: null,
    expectedRevision: appRevision(f), payload: { quarantineId: prepared.quarantine.id } });
  const prepared2 = prepareRestore(f, snap.manifest.id);
  f.rt.app.execute(actor(f), { kind: "restore.migrate" as const, requestId: rid(), projectId: null,
    expectedRevision: appRevision(f), payload: { quarantineId: prepared2.quarantine.id } });
  expect(() => applyLedger(f, prepared2.quarantine.id, [], "nobody", f.clock.now)).toThrow("ledger_unverifiable");
  // asOf older than the backup is stale even with full coverage.
  const appliedOld = applyLedger(f, prepared2.quarantine.id, full, "live-deletion-ledger", snap.manifest.createdAt - 1, true);
  expect(appliedOld.quarantine.state).toBe("ledger_applied");
  const blockedOld = f.rt.app.execute(actor(f), { kind: "restore.validate" as const, requestId: rid(), projectId: null,
    expectedRevision: appRevision(f), payload: { quarantineId: prepared2.quarantine.id } });
  expect(blockedOld.quarantine.state).toBe("blocked");
  expect(blockedOld.quarantine.validation!.checks.find(c => c.name === "external_ledger_freshness")!.pass).toBe(false);
});

test("failed session delete keeps the restore quarantined with a recoverable artifact", async () => {
  const f = await fixture();
  f.flags.deleteFail = true;
  const a = project(f, "โครงการ native fail", "หัวข้อ native");
  const s1 = say(f, a, "native fail 001");
  await remember(f, a, s1);
  f.rt.app.execute(actor(f), { kind: "team.dispatch" as const, requestId: rid(), projectId: a.id, expectedRevision: projectRevision(f, a),
    payload: { topicId: a.topic.id, purpose: "งานที่ใช้ native session", sources: [a.topic.source], include: [f.roles.tech], exclude: [], limits: { ...f.config.jobs.maximum } } });
  const op = deleteSource(f, a, s1);
  await reconcileDeletions(f.rt.store, f.rt.port as unknown as ApplicationRunPort, f.clock.now);
  const blocked = f.rt.app.deletionOperation(actor(f), a.id, op.operation.id).operation!;
  expect(["pending", "blocked"]).toContain(blocked.state);
  const snap = backupNow(f);
  f.clock.now += 60_000;
  const prepared = prepareRestore(f, snap.manifest.id);
  f.rt.app.execute(actor(f), { kind: "restore.migrate" as const, requestId: rid(), projectId: null,
    expectedRevision: appRevision(f), payload: { quarantineId: prepared.quarantine.id } });
  applyLedger(f, prepared.quarantine.id, liveTombstones(f), "live-deletion-ledger", f.clock.now);
  const validated = f.rt.app.execute(actor(f), { kind: "restore.validate" as const, requestId: rid(), projectId: null,
    expectedRevision: appRevision(f), payload: { quarantineId: prepared.quarantine.id } });
  expect(validated.quarantine.state).toBe("blocked");
  expect(validated.quarantine.validation!.checks.find(c => c.name === "native_sessions")!.pass).toBe(false);
  expect(() => f.rt.app.execute(actor(f), { kind: "restore.activate" as const, requestId: rid(), projectId: null,
    expectedRevision: appRevision(f), payload: { quarantineId: prepared.quarantine.id } })).toThrow("restore_bad_state");
  // Live installation is untouched and the backup artifact stays recoverable.
  expect(f.rt.app.source(actor(f), a.id, s1).state).toBe("unavailable");
  expect(f.rt.app.backups(actor(f)).manifests.some(m => m.id === snap.manifest.id)).toBe(true);
});

test("crash at every restore boundary leaves a resumable quarantine; reopen preserves it", async () => {
  const f = await fixture();
  const a = project(f, "โครงการ crash", "หัวข้อ crash");
  const s1 = say(f, a, "crash 001");
  await remember(f, a, s1);
  const snap = backupNow(f);
  f.clock.now += 60_000;
  let fail = "";
  const fragile = () => new Application(f.rt.store, f.config, { jobs: f.rt.queue, now: () => f.clock.now,
    backupDir: f.dirs.backup, restoreDir: f.dirs.restore,
    nativeSnapshot: { available: () => true, snapshot: () => ({ refs: [], bytes: 8, engine: "scripted-fixture-v1" }) },
    beforeCommit(s) { if (fail === "ops" && s === "ops") throw new Error("fixture ops crash"); } });
  const fragileActor = (app: Application) => app.authenticate(f.token).actor;
  const prepCmd = { kind: "restore.prepare" as const, requestId: rid(), projectId: null, expectedRevision: appRevision(f), payload: { backupId: snap.manifest.id, note: "x" } };
  // Crash at prepare rolls back wholly; re-prepare is clean.
  fail = "ops";
  const fragileApp = fragile();
  const fragileAct = fragileActor(fragileApp);
  expect(() => fragileApp.execute(fragileAct, prepCmd)).toThrow("fixture ops crash");
  expect(f.rt.app.restores(actor(f)).quarantines).toHaveLength(0);
  fail = "";
  const prepared = fragileApp.execute(fragileAct, { ...prepCmd, requestId: rid() });
  const qid = (prepared as unknown as { quarantine: { id: string } }).quarantine.id;
  // Crash at migrate/apply/validate/activate: journal persists, receipt missing; re-run resumes.
  for (const kind of ["restore.migrate", "restore.apply_ledger", "restore.validate", "restore.activate"] as const) {
    const payload = kind === "restore.apply_ledger"
      ? { quarantineId: qid, tombstones: [], source: "owner-attested-empty", asOf: f.clock.now, acknowledgedEmpty: true }
      : { quarantineId: qid };
    fail = "ops";
    const crashApp = fragile();
    const crashAct = fragileActor(crashApp);
    expect(() => crashApp.execute(crashAct, { kind, requestId: rid(), projectId: null,
      expectedRevision: appRevision(f), payload } as never)).toThrow("fixture ops crash");
    fail = "";
    await restart(f);
    const resumed = f.rt.app.execute(actor(f), { kind, requestId: rid(), projectId: null,
      expectedRevision: appRevision(f), payload } as never) as unknown as { quarantine: { state: string } };
    expect(["migrated", "ledger_applied", "validated", "complete"]).toContain(resumed.quarantine.state);
    if (kind === "restore.activate") break;
  }
  expect(f.rt.app.restore(actor(f), qid).quarantine.state).toBe("complete");
});

test("pending jobs and unknown outbox are listed, never replayed; newer backups are rejected", async () => {
  const f = await fixture();
  const a = project(f, "โครงการ pending", "หัวข้อ pending");
  say(f, a, "pending 001");
  // Queued discussion stays queued across restore; unknown outbox stays unknown.
  f.rt.app.execute(actor(f), { kind: "team.dispatch" as const, requestId: rid(), projectId: a.id, expectedRevision: projectRevision(f, a),
    payload: { topicId: a.topic.id, purpose: "งานค้างข้าม restore", sources: [a.topic.source], include: [f.roles.tech], exclude: [], limits: { ...f.config.jobs.maximum } } });
  const delivery = f.rt.app.execute(actor(f), { kind: "delivery.commit", requestId: rid(), projectId: a.id, expectedRevision: projectRevision(f, a),
    payload: { kind: "report", text: "รายงาน outbox", dedupeKey: "outbox-1" } });
  f.rt.store.transaction(tx => {
    const row = tx.get<{ record_json: string }>("SELECT record_json FROM delivery_intents WHERE id = ?", (delivery as { intent: { id: string } }).intent.id)!;
    const intent = JSON.parse(row.record_json) as Record<string, unknown>;
    tx.run("UPDATE delivery_intents SET record_json = ? WHERE id = ?", JSON.stringify({ ...intent, status: "unknown" }), (delivery as { intent: { id: string } }).intent.id);
  });
  const snap = backupNow(f);
  f.clock.now += 60_000;
  const prepared = prepareRestore(f, snap.manifest.id);
  f.rt.app.execute(actor(f), { kind: "restore.migrate" as const, requestId: rid(), projectId: null,
    expectedRevision: appRevision(f), payload: { quarantineId: prepared.quarantine.id } });
  applyLedger(f, prepared.quarantine.id, [], "owner-attested-empty", f.clock.now, true);
  const validated = f.rt.app.execute(actor(f), { kind: "restore.validate" as const, requestId: rid(), projectId: null,
    expectedRevision: appRevision(f), payload: { quarantineId: prepared.quarantine.id } });
  expect(validated.quarantine.state).toBe("validated");
  expect(validated.quarantine.validation!.unknownOutbox).toBe(1);
  expect(validated.quarantine.validation!.pendingJobs.length).toBeGreaterThan(0);
  f.rt.app.execute(actor(f), { kind: "restore.activate" as const, requestId: rid(), projectId: null,
    expectedRevision: appRevision(f), payload: { quarantineId: prepared.quarantine.id } });
  await restart(f);
  const jobs = f.rt.app.jobs(actor(f), a.id).items;
  expect(jobs.some(j => j.state === "queued")).toBe(true);
  expect(jobs.some(j => ["succeeded", "partial"].includes(j.state))).toBe(false);
  // A backup claiming a newer schema is rejected before touching anything.
  const fakeId = crypto.randomUUID();
  f.rt.store.transaction(tx => {
    tx.run("INSERT INTO ops_backups VALUES (?, ?, ?)", fakeId, f.clock.now,
      JSON.stringify({ id: fakeId, appSchema: 99, createdAt: f.clock.now, artifact: { path: join(f.root, "x"), bytes: 1, hash: "00" } }));
  });
  expect(() => prepareRestore(f, fakeId)).toThrow("newer_backup_unsupported");
  expect(f.rt.app.restores(actor(f)).quarantines.filter(q => q.state === "complete")).toHaveLength(1);
});

test("web quarantine inventory and detail render without secrets", async () => {
  const f = await fixture();
  const a = project(f, "โครงการ web restore", "หัวข้อ web");
  say(f, a, "web-canary-restore-007");
  const snap = backupNow(f);
  f.clock.now += 60_000;
  const web = createWebHandler(f.rt.app);
  const req = (path: string, method = "GET", body?: unknown) => new Request(`http://localhost:3000${path}`, { method,
    headers: { cookie: `jit_session=${f.token}`, ...(body ? { origin: "http://localhost:3000", "x-csrf-token": f.rt.app.authenticate(f.token).csrf, "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const prepared = await (await web(req("/api/restores", "POST", { requestId: rid(), expectedRevision: appRevision(f), backupId: snap.manifest.id, note: "web" }))).json() as { quarantine: { id: string } };
  expect(prepared.quarantine.id).toBeString();
  const list = await web(req("/restores", "GET"));
  expect(list.status).toBe(200);
  const html = await list.text();
  expect(html).toContain(prepared.quarantine.id);
  expect(html).not.toContain("web-canary-restore-007");
  expect(html).not.toContain(f.token);
  const detail = await web(req(`/restores/${prepared.quarantine.id}`, "GET"));
  expect(detail.status).toBe(200);
  expect(await detail.text()).toContain("ops.quarantined_restore/v1");
});
