import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Application } from "../src/application";
import { readConfig } from "../src/config";
import { AppError } from "../src/errors";
import { normalizeNativeSnapshot, type BackupNativePort } from "../src/ops/backup";
import {
  SimulatedCrash, checkUpgradeEngine, currentSupportedSchema, inspectUpgradeEngine, managedStateDigest, minUpgradeSourceSchema,
  planSchema, planUpgrade, upgradeActions, upgradeEngineContract, upgradeNativeFormatVersion,
  type UpgradeFaultPoint, type UpgradeJournal,
} from "../src/ops/upgrade";
import { readUpgradeFence, upgradeFencePath } from "../src/ops/upgrade-fence";
import { ManagedService } from "../src/ops/upgrade-service";
import { preflightService, startFullApp } from "../src/ops/lifecycle";
import { SCHWAY_SNAPSHOT_CONTRACT, SchwayRunPort } from "../src/team/schway-port";
import { memoryExtractionMarker, memoryExtractionWork, scriptedMemoryResult } from "../src/memory/extract";
import type { ClaimReference, MemoryClaim } from "../src/memory/types";
import type { SourceReference } from "../src/sources";
import { JobQueue } from "../src/jobs/queue";
import { tickSchedules } from "../src/jobs/schedules";
import { DeliveryWorker } from "../src/delivery";
import { ScriptedRunPort, fixtureOutcome, withContextAnswer } from "../src/team/scripted-port";
import type { ApplicationRunRequest, RoleRoute, TeamCommand } from "../src/team/types";
import { coordinatorSynthesisMarker, coordinatorSynthesisWork } from "../src/team/decisions";
import { discussionPlanWork, specialistAnalysisWork } from "../src/team/dispatch";
import { TransactionStore, inspectStoreSchema, schemaVersion } from "../src/store";
import { createWebHandler } from "../src/web";
import type { ServiceConfig } from "../ops/package/service-config";

// Full-app fixtures here take several seconds each on Pi-class hosts (#84); a
// timeout would also leave single-flight state held for the following tests.
setDefaultTimeout(30_000);

/**
 * OPS06 ops.schema_migrations/v1. Scripted models and fixture ports only; the
 * concrete Schway snapshot path is exercised in tests/ops-backup.test.ts and
 * the startFullApp integration below.
 */
const roots: string[] = [], stores: TransactionStore[] = [], services: ManagedService[] = [];
afterEach(async () => {
  for (const s of services.splice(0)) { s.close(); try { await s.queue?.idle(); } catch { /* Teardown. */ } }
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* Already closed. */ } }
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});
const rid = (): string => crypto.randomUUID(), epoch = 1800000000000, password = "ops-upgrade-owner-password";
const grok: RoleRoute = { provider: "grok", model: "fixture-grok-exact", authRoute: "owner-grok" };
type Script = (request: ApplicationRunRequest, signal: AbortSignal) => unknown | Promise<unknown>;
type Config = ReturnType<typeof readConfig>;

/** Fixture engine port declaring the supported snapshot contract; counts every engine touch. */
function fixturePort(options: { contract?: string; formatVersion?: number; available?: boolean; snapshot?: () => unknown } = {}) {
  const calls = { available: 0, snapshot: 0, resolve: 0 };
  const port: BackupNativePort & { calls: typeof calls } = {
    calls, engine: "fixture-engine/1",
    contract: options.contract ?? upgradeEngineContract, formatVersion: options.formatVersion ?? upgradeNativeFormatVersion,
    available: () => { calls.available++; return options.available ?? true; },
    snapshot: () => {
      calls.snapshot++;
      if (options.snapshot) return options.snapshot() as never;
      return { refs: [], bytes: 0, engine: "fixture-engine/1", contract: options.contract ?? upgradeEngineContract, formatVersion: options.formatVersion ?? upgradeNativeFormatVersion, artifacts: [] };
    },
  };
  return port;
}
type Port = ReturnType<typeof fixturePort>;

interface Runtime { store: TransactionStore; port: ScriptedRunPort; service: ManagedService; app: Application }

async function boot(config: Config, hooks: { extract: Script; specialist: Script }, clock: { now: number }, dirs: { backup: string; upgrade: string },
  native: Port | undefined, fault?: { point: UpgradeFaultPoint | null }): Promise<Runtime> {
  const store = new TransactionStore(config.databasePath, { migrateExisting: false }); stores.push(store);
  const script = (request: ApplicationRunRequest, signal: AbortSignal) =>
    request.instructions.operator.includes(memoryExtractionMarker) ? hooks.extract(request, signal)
      : request.instructions.operator.includes(coordinatorSynthesisMarker) ? fixtureOutcome("complete", JSON.stringify(synthesisJson(request)))
      : hooks.specialist(request, signal);
  const port = new ScriptedRunPort(store, config.team, config.jobs.outputBytes, script, () => false, () => false);
  const now = () => clock.now;
  const service = new ManagedService(store, () => ({ teamPort: port, queue: new JobQueue(store, config.jobs, [memoryExtractionWork(store, config, port, now), discussionPlanWork(),
    specialistAnalysisWork(store, config, port, now), coordinatorSynthesisWork(store, config, port, now)], { now }) }), { drainTimeoutMs: 200 });
  services.push(service);
  const app = new Application(store, config, { service, now, backupDir: dirs.backup, upgradeDir: dirs.upgrade,
    ...(native ? { nativeSnapshot: native } : {}),
    upgradeFault: point => { if (fault?.point === point) throw new SimulatedCrash(point); } });
  await app.boot();
  return { store, port, service, app };
}

function synthesisJson(request: ApplicationRunRequest) {
  const citations = request.manifest.sources.map(source => ({ ...source.reference }));
  return { question: "เจ้าของจะเลือกทางใด", disagreement: false, consensus: true, options: [
    { id: "first", label: "ทางแรก", rationale: "ตามผลวิเคราะห์", citations },
    { id: "second", label: "ทางที่สอง", rationale: "alternative", citations },
  ] };
}

async function fixture(engine: Port | null = fixturePort()) {
  const native = engine ?? undefined;
  const root = mkdtempSync(join(tmpdir(), "jit-ops-upgrade-")); roots.push(root);
  const config = readConfig({ JIT_DATABASE: join(root, "state.sqlite") }), clock = { now: epoch };
  const defaults = {
    extract: ((request: ApplicationRunRequest) => scriptedMemoryResult(request, true)) as Script,
    specialist: ((request: ApplicationRunRequest) => fixtureOutcome("complete", withContextAnswer("ตอบจำลอง", request, config.jobs.outputBytes))) as Script,
  };
  const hooks = { ...defaults };
  const dirs = { backup: join(root, "backups"), upgrade: join(root, "upgrades") };
  const fault = { point: null as UpgradeFaultPoint | null };
  const rt = await boot(config, hooks, clock, dirs, native, fault);
  await rt.app.setupOwner(password);
  const f = { root, config, clock, hooks, defaults, dirs, rt, native, fault, token: await rt.app.login(password), roles: { tech: "", coordinator: "" } };
  const owner = rt.app.authenticate(f.token).actor;
  f.roles.tech = rt.app.execute(owner, { kind: "role.save", projectId: null, requestId: rid(), expectedRevision: rt.app.team(owner).ownerRevision,
    payload: { roleId: null, name: "เทคโนโลยี", kind: "specialist", responsibility: "วิเคราะห์ฐานข้อมูลและโครงสร้างซอฟต์แวร์", enabled: true, route: grok } }).role!.id;
  f.roles.coordinator = rt.app.execute(owner, { kind: "role.save", projectId: null, requestId: rid(), expectedRevision: rt.app.team(owner).ownerRevision,
    payload: { roleId: null, name: "ผู้ประสานงาน", kind: "coordinator", responsibility: "สรุปความเห็นต่างให้เจ้าของตัดสิน", enabled: true, route: grok } }).role!.id;
  return f;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const actor = (f: Fixture) => f.rt.app.authenticate(f.token).actor;
const queue = (f: Fixture) => f.rt.service.queue!;
/** Simulated process death and reopen: the store handle is dropped, a new Application reconciles durable intent. */
async function restart(f: Fixture) {
  f.rt.service.close();
  try { await f.rt.service.queue?.idle(); } catch { /* Settled. */ }
  services.splice(services.indexOf(f.rt.service), 1);
  f.rt.store.close(); stores.splice(stores.indexOf(f.rt.store), 1);
  f.fault.point = null;
  f.rt = await boot(f.config, f.hooks, f.clock, f.dirs, f.native, f.fault);
}
async function drain(f: Fixture) {
  for (let i = 0; i < 400; i++) {
    queue(f).pump();
    const pending = f.rt.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM jobs WHERE state IN ('queued', 'admitted')")!.n);
    if (pending === 0) { await queue(f).idle(); return; }
    await queue(f).idle(); await new Promise(resolve => setTimeout(resolve, 2));
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
const prepare = (f: Fixture, targetSchema = currentSupportedSchema, requestId = rid()) => f.rt.app.execute(actor(f), {
  kind: "upgrade.prepare" as const, requestId, projectId: null, expectedRevision: appRevision(f), payload: { targetSchema, note: "test upgrade" } });
const stepCmd = (f: Fixture, kind: "upgrade.migrate" | "upgrade.validate" | "upgrade.activate" | "upgrade.rollback", upgradeId: string, requestId = rid()) =>
  f.rt.app.execute(actor(f), { kind, requestId, projectId: null, expectedRevision: appRevision(f), payload: { upgradeId } });
function dispatch(f: Fixture, p: Project, purpose: string): Extract<TeamCommand, { kind: "team.dispatch" }> {
  return { kind: "team.dispatch", requestId: rid(), projectId: p.id, expectedRevision: projectRevision(f, p),
    payload: { topicId: p.topic.id, purpose, sources: [p.topic.source], include: [f.roles.tech], exclude: [], limits: { ...f.config.jobs.maximum } } };
}
const digestOf = (store: TransactionStore) => store.read(managedStateDigest);
/** Owner-visible authoritative data (reboots may legitimately reconcile scheduler bookkeeping). */
const userData = (store: TransactionStore) => store.read(tx => JSON.stringify(["projects", "sources", "source_versions", "messages", "tasks",
  "memory_claims", "memory_suppressions", "deletion_ledger", "decision_proposals", "owner_decisions", "delivery_intents"]
  .map(table => tx.all(`SELECT * FROM ${table} ORDER BY rowid`)).concat([[tx.get("PRAGMA user_version")]])));
const journals = (f: Fixture) => f.rt.app.upgrades(actor(f)).journals;
const backupFiles = (f: Fixture) => existsSync(f.dirs.backup) ? readdirSync(f.dirs.backup) : [];
const tombstone = (store: TransactionStore, projectId: string) => store.transaction(tx => tx.run(
  "INSERT INTO deletion_ledger VALUES (?, ?, ?, 'claim', NULL, ?, 1, 1, ?)", rid(), rid(), projectId, rid(), epoch));

/** Seeds tasks, a decision, corrected/forgotten memory, a tombstone, an unknown delivery and pending/cancelled jobs. */
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
  f.rt.app.execute(actor(f), { kind: "decision.synthesize", requestId: rid(), projectId: a.id, expectedRevision: discussion.revision,
    payload: { discussionId: discussion.id, limits: { ...f.config.jobs.maximum } } });
  await drain(f);
  const proposal = f.rt.app.decision(actor(f), a.id, a.topic.id).proposal!;
  f.rt.app.execute(actor(f), { kind: "decision.accept", requestId: rid(), projectId: a.id, expectedRevision: proposal.revision,
    payload: { proposalId: proposal.id, optionId: proposal.artifact.options[0]!.id, conclusion: "เลือกทางแรก", rationale: "เจ้าของเห็นด้วย" } });
  f.rt.app.execute(actor(f), { kind: "delivery.commit", requestId: rid(), projectId: a.id, expectedRevision: projectRevision(f, a),
    payload: { kind: "report", text: "รายงานก่อนอัปเกรด", dedupeKey: "pre-upgrade-1" } });
  // An unknown external outcome must stay unknown and never be resent.
  f.rt.store.transaction(tx => tx.run("UPDATE delivery_intents SET record_json = json_set(record_json, '$.status', 'unknown') WHERE dedupe_key = 'pre-upgrade-1'"));
  // One queued discussion (survives upgrade) and one stopped job (terminal, preserved).
  const queued = f.rt.app.execute(actor(f), dispatch(f, a, "งานค้างข้ามอัปเกรด"));
  const queuedJobId = queued.discussion!.jobId;
  f.rt.app.execute(actor(f), dispatch(f, a, "งานที่จะหยุด"));
  const toStop = f.rt.store.read(tx => tx.all<{ record_json: string }>("SELECT record_json FROM jobs WHERE project_id = ? ORDER BY sequence DESC LIMIT 5", a.id)
    .map(r => JSON.parse(r.record_json) as { id: string; state: string; revision: number }).find(j => j.state === "queued")!);
  f.rt.app.execute(actor(f), { kind: "job.stop", requestId: rid(), projectId: a.id, expectedRevision: toStop.revision, payload: { jobId: toStop.id } });
  tombstone(f.rt.store, a.id);
  return { a, keep: keep!, sKeep: sKeep!, queuedJobId, stoppedJobId: toStop.id };
}

async function fullUpgrade(f: Fixture) {
  const prepared = (await prepare(f)).journal;
  for (const kind of ["upgrade.migrate", "upgrade.validate", "upgrade.activate"] as const) await stepCmd(f, kind, prepared.id);
  return f.rt.app.upgrade(actor(f), prepared.id).journal;
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

test("preflight matrix: one supported target, sequential sources, downgrade/forward/newer/too-old rejection, exact engine contract", () => {
  expect(planUpgrade(schemaVersion, schemaVersion, upgradeEngineContract)).toMatchObject({ compatible: true, reason: null });
  expect(planSchema(17, schemaVersion)).toEqual({ compatible: true, reason: null, migrations: [18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28].filter(v => v <= schemaVersion) });
  expect(planSchema(schemaVersion, 99)).toMatchObject({ compatible: false, reason: "forward_upgrade_unsupported" });
  expect(planSchema(schemaVersion, schemaVersion - 1)).toMatchObject({ compatible: false, reason: "downgrade_rejected" });
  expect(planSchema(99, 99)).toMatchObject({ compatible: false, reason: "newer_schema_unsupported" });
  expect(planSchema(minUpgradeSourceSchema - 1, schemaVersion)).toMatchObject({ compatible: false, reason: "manual_recovery_required" });
  expect(planSchema(17, 20)).toMatchObject({ compatible: false, reason: "unsupported_target_schema" });
  expect(planUpgrade(schemaVersion, schemaVersion, null)).toMatchObject({ compatible: false, reason: "engine_unavailable" });
  for (const identity of ["scripted-fixture-v1", "schway.host.session-snapshot/v2", "future-engine-v9"]) {
    expect(checkUpgradeEngine(identity)).toEqual({ supported: false, reason: "unsupported_engine" });
  }
  expect(upgradeEngineContract).toBe(SCHWAY_SNAPSHOT_CONTRACT);
});

test("engine compatibility reads only declared metadata and never snapshots or resolves", () => {
  const good = fixturePort();
  expect(inspectUpgradeEngine(good)).toMatchObject({ compatible: true, contract: upgradeEngineContract, formatVersion: upgradeNativeFormatVersion });
  expect(inspectUpgradeEngine(undefined)).toMatchObject({ compatible: false, reason: "engine_unavailable" });
  expect(inspectUpgradeEngine(fixturePort({ available: false }))).toMatchObject({ compatible: false, reason: "engine_unavailable" });
  expect(inspectUpgradeEngine(fixturePort({ contract: "schway.host.session-snapshot/v2" }))).toMatchObject({ compatible: false, reason: "unsupported_engine" });
  expect(inspectUpgradeEngine(fixturePort({ formatVersion: upgradeNativeFormatVersion + 1 }))).toMatchObject({ compatible: false, reason: "unsupported_engine" });
  expect(inspectUpgradeEngine({ available: () => { throw new Error("probe"); }, snapshot: () => { throw new Error("never"); } })).toMatchObject({ compatible: false });
  expect(good.calls.snapshot).toBe(0);
});

test("schema rejection through Application.execute is preflight-only: zero engine calls, no artifacts, one accurate failed journal", async () => {
  const f = await fixture();
  project(f, "p", "t");
  const before = { digest: digestOf(f.rt.store), revision: appRevision(f) };
  for (const [target, reason] of [[schemaVersion - 1, "downgrade_rejected"], [99, "forward_upgrade_unsupported"], [schemaVersion + 1, "forward_upgrade_unsupported"]] as const) {
    const count = journals(f).length;
    const requestId = rid();
    await expect(prepare(f, target, requestId)).rejects.toThrow("unsupported_upgrade");
    const all = journals(f);
    expect(all).toHaveLength(count + 1);
    expect(all.find(j => j.requests[0]!.requestId === requestId)).toMatchObject({ state: "failed", reason, snapshotBackupId: null, steps: [{ name: "preflight", ok: false, detail: reason }] });
  }
  expect(f.native!.calls).toEqual({ available: 0, snapshot: 0, resolve: 0 });
  expect(backupFiles(f)).toHaveLength(0);
  expect(readUpgradeFence(f.rt.store.path)).toBeNull();
  expect(digestOf(f.rt.store)).toBe(before.digest);
  expect(appRevision(f)).toBe(before.revision);
  // Newer-than-supported installations are refused at open, read-only, before anything else.
  const future = join(f.root, "future.sqlite");
  const db = new Database(future); db.exec("CREATE TABLE t(x TEXT); PRAGMA user_version = 99;"); db.close();
  const bytes = readFileSync(future);
  expect(inspectStoreSchema(future)).toBe(99);
  expect(() => new TransactionStore(future, { migrateExisting: false })).toThrow("newer");
  expect(readFileSync(future)).toEqual(bytes);
});

test("engine rejection snapshots nothing and records engine_unavailable or unsupported_engine", async () => {
  for (const [port, code] of [[null, "engine_unavailable"], [fixturePort({ available: false }), "engine_unavailable"],
    [fixturePort({ contract: "scripted-fixture-v1" }), "unsupported_engine"]] as const) {
    const f = await fixture(port);
    await expect(prepare(f)).rejects.toThrow(code);
    expect(journals(f).at(-1)).toMatchObject({ state: "failed", reason: code, preflight: { engine: { compatible: false, reason: code } } });
    if (port) expect(port.calls.snapshot).toBe(0);
    expect(backupFiles(f)).toHaveLength(0);
    expect(readUpgradeFence(f.rt.store.path)).toBeNull();
  }
});

test("authorization, revision and request identity are checked before any upgrade evidence is written", async () => {
  const f = await fixture();
  const forged = { ownerId: "owner", channel: "web" } as never;
  await expect(f.rt.app.execute(forged, { kind: "upgrade.prepare", requestId: rid(), projectId: null, expectedRevision: appRevision(f),
    payload: { targetSchema: 99, note: "forged" } })).rejects.toThrow("authentication_required");
  await expect(f.rt.app.execute(actor(f), { kind: "upgrade.prepare", requestId: rid(), projectId: null, expectedRevision: appRevision(f) + 5,
    payload: { targetSchema: 99, note: "stale" } })).rejects.toThrow("stale_revision");
  const used = rid();
  f.rt.app.execute(actor(f), { kind: "project.create", projectId: null, requestId: used, expectedRevision: appRevision(f), payload: { name: "x" } });
  await expect(prepare(f, schemaVersion, used)).rejects.toThrow("request_id_conflict");
  await expect(f.rt.app.execute(actor(f), { kind: "upgrade.prepare", requestId: "bad", projectId: null, expectedRevision: 0,
    payload: { targetSchema: schemaVersion, note: "x" } } as never)).rejects.toThrow("invalid_upgrade_command");
  expect(journals(f)).toHaveLength(0);
  expect(f.native!.calls.available).toBe(0);
  // A replayed prepare returns the same journal; a different payload under the same id conflicts.
  const id = rid();
  const first = await prepare(f, schemaVersion, id);
  const again = await prepare(f, schemaVersion, id);
  expect(again).toMatchObject({ duplicate: true, journal: { id: first.journal.id } });
  await expect(f.rt.app.execute(actor(f), { kind: "upgrade.prepare", requestId: id, projectId: null, expectedRevision: appRevision(f),
    payload: { targetSchema: schemaVersion, note: "different" } })).rejects.toThrow("request_id_conflict");
  expect(f.native!.calls.snapshot).toBe(1);
});

// ---------------------------------------------------------------------------
// Happy path, fence, quiesce and reconciliation
// ---------------------------------------------------------------------------

test("full upgrade preserves tasks, decisions, claims, receipts, jobs, outbox and ledgers, then reconciles under the managed service", async () => {
  const f = await fixture();
  const { a, keep, queuedJobId, stoppedJobId } = await rich(f);
  const ledgersBefore = f.rt.app.deletionLedger(actor(f)).tombstones;
  const tasksBefore = f.rt.app.tasks(actor(f), a.id);
  const receiptsBefore = f.rt.store.read(tx => tx.all<{ request_id: string; result_json: string }>("SELECT request_id, result_json FROM command_receipts ORDER BY request_id"));
  const revisionBefore = appRevision(f);
  const oldQueue = queue(f);
  const requestIds = [rid(), rid(), rid(), rid()];
  const prepared = (await prepare(f, schemaVersion, requestIds[0])).journal;
  expect(prepared).toMatchObject({ state: "prepared", preflight: { compatible: true, engine: { compatible: true, contract: upgradeEngineContract } },
    quiesce: { settled: true }, checkpoint: { appSchema: schemaVersion }, ledger: { deletions: ledgersBefore.length } });
  expect(f.native!.calls.snapshot).toBe(1);
  expect(readUpgradeFence(f.rt.store.path)?.upgradeId).toBe(prepared.id);
  const migrated = (await stepCmd(f, "upgrade.migrate", prepared.id, requestIds[1])).journal;
  expect(migrated).toMatchObject({ state: "staged", stagedSchema: schemaVersion, actions: ["validate", "rollback"] });
  const validated = (await stepCmd(f, "upgrade.validate", prepared.id, requestIds[2])).journal;
  expect(validated.validation!.checks.filter(c => !c.pass)).toEqual([]);
  expect(validated).toMatchObject({ state: "ready", validation: { ledgersMatch: true, unknownOutbox: 1 } });
  expect(validated.validation!.tables).toBeGreaterThan(20);
  const completed = (await stepCmd(f, "upgrade.activate", prepared.id, requestIds[3])).journal;
  expect(completed).toMatchObject({ state: "complete", reconcile: { reconciled: true }, actions: [] });
  expect(completed.reconcile!.detail).toContain("jobs_sessions_reconciled");
  expect(completed.nextAction).toContain("OPS02");
  expect(readUpgradeFence(f.rt.store.path)).toBeNull();
  // Scheduler ownership was rebuilt, not reused.
  expect(queue(f)).not.toBe(oldQueue);
  expect(queue(f).available(f.rt.store.read(tx => tx))).toBe(true);
  // State survived: tasks, decision, memory, receipts, queued/stopped jobs, outbox, ledgers, revision.
  expect(f.rt.app.tasks(actor(f), a.id).proposed).toHaveLength(tasksBefore.proposed.length);
  expect(f.rt.app.decision(actor(f), a.id, a.topic.id).currentDecision!.decision.conclusion).toBe("เลือกทางแรก");
  expect(f.rt.app.memoryClaim(actor(f), a.id, ref(keep)).state).toBe("available");
  expect(f.rt.app.deletionLedger(actor(f)).tombstones).toEqual(ledgersBefore);
  expect(appRevision(f)).toBe(revisionBefore);
  const after = f.rt.store.read(tx => tx.all<{ request_id: string; result_json: string }>("SELECT request_id, result_json FROM command_receipts ORDER BY request_id"));
  for (const receipt of receiptsBefore) expect(after).toContainEqual(receipt);
  // Every upgrade request is a durable receipt and audit entry after the swap.
  const audited = f.rt.store.read(tx => tx.all<{ request_id: string; command_kind: string }>("SELECT request_id, command_kind FROM audit WHERE command_kind LIKE 'upgrade.%'"));
  expect(audited.map(r => r.request_id).sort()).toEqual([...requestIds].sort());
  expect(after.filter(r => requestIds.includes(r.request_id))).toHaveLength(4);
  const unknown = f.rt.store.read(tx => tx.get<{ status: string; attempts: number }>(
    "SELECT json_extract(record_json, '$.status') AS status, (SELECT count(*) FROM delivery_attempts) AS attempts FROM delivery_intents WHERE dedupe_key = 'pre-upgrade-1'"));
  expect(unknown).toEqual({ status: "unknown", attempts: 0 });
  expect(f.rt.store.read(tx => JSON.parse(tx.get<{ record_json: string }>("SELECT record_json FROM jobs WHERE id = ?", stoppedJobId)!.record_json).reason)).toBe("cancelled");
  // The pending job resumes only through the rebuilt, reconciled scheduler.
  await drain(f);
  expect(f.rt.app.jobs(actor(f), a.id).items.find(j => j.id === queuedJobId)!.state).toBe("succeeded");
  expect(existsSync(prepared.stagedPath!)).toBe(false);
});

test("the durable fence disables admission, schedules, delivery and other owner commands until the upgrade ends", async () => {
  const f = await fixture();
  const a = project(f, "fence", "t");
  const prepared = (await prepare(f)).journal;
  expect(prepared.quiesce!.disabled).toEqual(expect.arrayContaining(["job_admission", "memory_extraction", "pr_monitoring", "schedules", "delivery", "automatic_contexts"]));
  expect(() => f.rt.app.execute(actor(f), { kind: "message.send", requestId: rid(), projectId: a.id, expectedRevision: topicRevision(f, a), payload: { topicId: a.topic.id, text: "x" } }))
    .toThrow("upgrade_in_progress");
  expect(() => f.rt.app.execute(actor(f), dispatch(f, a, "blocked"))).toThrow("upgrade_in_progress");
  expect(() => f.rt.app.execute({ ownerId: "owner", channel: "web" } as never, { kind: "project.create", projectId: null, requestId: rid(), expectedRevision: 0, payload: { name: "x" } }))
    .toThrow("authentication_required");
  // A rebooted process composes a queue but admits nothing while the fence holds.
  await restart(f);
  expect(f.rt.store.read(tx => queue(f).available(tx))).toBe(false);
  expect(() => queue(f).pump()).not.toThrow();
  expect(tickSchedules(f.rt.store, queue(f), f.config, epoch)).toEqual([]);
  const worker = new DeliveryWorker(f.rt.store, { sender: { send: () => { throw new Error("must not send"); } } });
  expect(worker.claimNext()).toBeNull();
  worker.close();
  // Rollback releases the fence and resumes a reconciled scheduler.
  const rolled = (await stepCmd(f, "upgrade.rollback", prepared.id)).journal;
  expect(rolled).toMatchObject({ state: "rolled_back", reconcile: { reconciled: true } });
  expect(readUpgradeFence(f.rt.store.path)).toBeNull();
  expect(f.rt.store.read(tx => queue(f).available(tx))).toBe(true);
  say(f, a, "writes resume after rollback");
});

test("a writer that bypasses the fence makes activation fail closed instead of losing its write", async () => {
  const f = await fixture();
  const a = project(f, "race", "t");
  const prepared = (await prepare(f)).journal;
  await stepCmd(f, "upgrade.migrate", prepared.id);
  await stepCmd(f, "upgrade.validate", prepared.id);
  // Simulate an unfenced managed writer committing an admitted job after validation.
  const job = rid();
  f.rt.store.transaction(tx => {
    tx.run("INSERT INTO jobs (id, project_id, queue_order, priority, state, occupies, route_key, record_json) VALUES (?, ?, 999, 1, 'waiting', 0, 'route', ?)",
      job, a.id, JSON.stringify({ id: job, state: "waiting" }));
    tx.run("INSERT INTO job_authority VALUES (?, 1, NULL, NULL)", job);
  });
  await expect(stepCmd(f, "upgrade.activate", prepared.id)).rejects.toThrow("upgrade_stale_live");
  const blocked = f.rt.app.upgrade(actor(f), prepared.id).journal;
  expect(blocked).toMatchObject({ state: "blocked", reason: "upgrade_stale_live", actions: ["migrate", "rollback"] });
  expect(f.rt.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM jobs WHERE id = ?", job)!.n)).toBe(1);
  // Migrating again captures the write; the upgrade then completes with it preserved.
  await stepCmd(f, "upgrade.migrate", prepared.id);
  expect((await stepCmd(f, "upgrade.validate", prepared.id)).journal.state).toBe("ready");
  expect((await stepCmd(f, "upgrade.activate", prepared.id)).journal.state).toBe("complete");
  expect(f.rt.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM jobs WHERE id = ?", job)!.n)).toBe(1);
});

test("quiesce fences in-flight attempts; work that cannot settle fails prepare and leaves the installation untouched", async () => {
  const f = await fixture();
  const a = project(f, "quiesce", "t");
  say(f, a, "ข้อความ quiesce");
  let release: (() => void) | null = null;
  f.hooks.specialist = (request: ApplicationRunRequest, signal: AbortSignal) => new Promise<unknown>(resolve => {
    release = () => resolve(fixtureOutcome("complete", withContextAnswer("ตอบจำลอง", request, f.config.jobs.outputBytes)));
    void signal; // Stalled adapter ignores cancellation.
  });
  f.rt.app.execute(actor(f), dispatch(f, a, "งานที่ค้าง"));
  queue(f).pump();
  await new Promise(resolve => setTimeout(resolve, 20));
  const data = userData(f.rt.store);
  await expect(prepare(f)).rejects.toThrow("upgrade_quiesce_incomplete");
  const failed = journals(f).at(-1)!;
  expect(failed).toMatchObject({ state: "failed", reason: "upgrade_quiesce_incomplete", snapshotBackupId: null, quiesce: { settled: false } });
  expect(readUpgradeFence(f.rt.store.path)).toBeNull();
  expect(f.native!.calls.snapshot).toBe(0);
  expect(userData(f.rt.store)).toBe(data);
  release!();
  await new Promise(resolve => setTimeout(resolve, 20));
  // Once the stalled attempt settled (fenced as interrupted), quiesce succeeds.
  f.hooks.specialist = f.defaults.specialist;
  const prepared = (await prepare(f)).journal;
  expect(prepared).toMatchObject({ state: "prepared", quiesce: { settled: true } });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test("validation pages every row: tampering anywhere in the staged copy blocks activation", async () => {
  const tamper = async (sql: string, failing: string) => {
    const f = await fixture();
    const { a } = await rich(f);
    const prepared = (await prepare(f)).journal;
    const migrated = (await stepCmd(f, "upgrade.migrate", prepared.id)).journal;
    const db = new Database(migrated.stagedPath!);
    db.exec("PRAGMA foreign_keys = OFF;");
    db.query(sql).run(...(sql.includes("?") ? [a.id] : []));
    db.close();
    const validated = (await stepCmd(f, "upgrade.validate", prepared.id)).journal;
    expect(validated.state).toBe("blocked");
    expect(validated.validation!.checks.filter(c => !c.pass).map(c => c.name)).toContain(failing);
    expect(validated.actions).toEqual(["migrate", "rollback"]);
    await expect(stepCmd(f, "upgrade.activate", prepared.id)).rejects.toThrow("upgrade_bad_state");
  };
  await tamper("DELETE FROM deletion_ledger", "ledger_preservation");
  await tamper("DELETE FROM command_receipts WHERE rowid = (SELECT max(rowid) FROM command_receipts)", "preservation");
  await tamper("UPDATE delivery_intents SET record_json = 'not json'", "outbox");
  await tamper(`INSERT INTO schway_native_refs (run_id, context_id, generation, session_id, branch_id, state, created_at, updated_at)
    VALUES ('${rid()}', '${rid()}', 1, 'session', 'branch', 'finished', 1, 1)`, "native_opaque_refs");
  await tamper("UPDATE jobs SET record_json = '{}' WHERE rowid = (SELECT max(rowid) FROM jobs)", "jobs");
});

test("a managed table above the documented bound fails closed instead of sampling", async () => {
  const f = await fixture();
  f.rt.store.transaction(tx => tx.run(`WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 200001)
    INSERT INTO audit (actor_id, command_kind, request_id, project_id, committed_at) SELECT 'owner', 'fixture', 'r' || x, 'owner', 1 FROM c`));
  const prepared = (await prepare(f)).journal;
  await expect(stepCmd(f, "upgrade.migrate", prepared.id)).rejects.toThrow("upgrade_validation_bound_exceeded");
  expect(f.rt.app.upgrade(actor(f), prepared.id).journal).toMatchObject({ state: "blocked", reason: "upgrade_validation_bound_exceeded" });
}, 60_000);

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

test("rollback before activation keeps the live installation exactly; after activation it is refused in favour of OPS02", async () => {
  for (const stage of ["prepared", "staged", "ready"] as const) {
    const f = await fixture();
    await rich(f);
    const data = userData(f.rt.store);
    const ledger = f.rt.app.deletionLedger(actor(f)).tombstones;
    const prepared = (await prepare(f)).journal;
    if (stage !== "prepared") await stepCmd(f, "upgrade.migrate", prepared.id);
    if (stage === "ready") await stepCmd(f, "upgrade.validate", prepared.id);
    const rolled = (await stepCmd(f, "upgrade.rollback", prepared.id)).journal;
    expect(rolled).toMatchObject({ state: "rolled_back", reason: "rolled_back_before_activation", actions: [] });
    // Rolling back never restores an image over live: nothing newer can be erased.
    expect(f.rt.app.deletionLedger(actor(f)).tombstones).toEqual(ledger);
    expect(userData(f.rt.store)).toBe(data);
    expect(readUpgradeFence(f.rt.store.path)).toBeNull();
    expect(existsSync(prepared.stagedPath!)).toBe(false);
    expect(f.rt.app.backups(actor(f)).manifests.map(m => m.id)).toContain(prepared.snapshotBackupId!);
  }
  const f = await fixture();
  const { a } = await rich(f);
  const done = await fullUpgrade(f);
  expect(done.state).toBe("complete");
  // A newer tombstone after activation survives: rollback is refused, never swapped.
  tombstone(f.rt.store, a.id);
  const ledger = f.rt.app.deletionLedger(actor(f)).tombstones;
  await expect(stepCmd(f, "upgrade.rollback", done.id)).rejects.toThrow("upgrade_rollback_requires_restore");
  expect(f.rt.app.deletionLedger(actor(f)).tombstones).toEqual(ledger);
  expect(f.rt.app.upgrade(actor(f), done.id).journal.state).toBe("complete");
});

// ---------------------------------------------------------------------------
// Crash and error at every journal boundary
// ---------------------------------------------------------------------------

test("crash at every journal boundary leaves an explicit, recoverable state with no half-acknowledged activation", async () => {
  const expectations: [UpgradeFaultPoint, UpgradeJournal["state"], string][] = [
    ["fenced", "failed", "prepare_interrupted"],
    ["quiesced", "failed", "prepare_interrupted"],
    ["snapshot", "failed", "prepare_interrupted"],
    ["ledger", "prepared", ""],
    ["staged_copy", "prepared", ""],
    ["migrated", "staged", ""],
    ["validated", "ready", ""],
    // Same-schema upgrade: staged and live are the same validated state, so an intent resolves as applied.
    ["activation_intent", "complete", ""],
    ["swapped", "complete", ""],
    ["activated", "complete", ""],
    ["reconciled", "complete", ""],
  ];
  for (const [point, state, reason] of expectations) {
    const f = await fixture();
    const { a } = await rich(f);
    const ledger = f.rt.app.deletionLedger(actor(f)).tombstones;
    const original = userData(f.rt.store);
    f.fault.point = point;
    let id: string | null = null;
    try {
      id = (await prepare(f)).journal.id;
      for (const kind of ["upgrade.migrate", "upgrade.validate", "upgrade.activate"] as const) await stepCmd(f, kind, id);
      throw new Error(`no crash at ${point}`);
    } catch (error) {
      expect(error).toBeInstanceOf(SimulatedCrash);
    }
    id ??= journals(f).at(-1)!.id;
    // The crashed command was never acknowledged as complete.
    expect(f.rt.app.upgrade(actor(f), id).journal.state).not.toBe("complete");
    await restart(f);
    const recovered = f.rt.app.upgrade(actor(f), id).journal;
    expect(recovered.state).toBe(state);
    if (reason) expect(recovered.reason).toBe(reason);
    if (state === "failed") {
      expect(readUpgradeFence(f.rt.store.path)).toBeNull();
      expect(userData(f.rt.store)).toBe(original);
    }
    if (["prepared", "staged", "ready"].includes(state)) {
      expect(readUpgradeFence(f.rt.store.path)?.upgradeId).toBe(id);
      expect(userData(f.rt.store)).toBe(original);
      // Resume from the recorded phase to completion.
      for (const action of ["migrate", "validate", "activate"] as const) {
        const current = f.rt.app.upgrade(actor(f), id).journal;
        if (current.actions.includes(action)) await stepCmd(f, `upgrade.${action}`, id);
      }
      expect(f.rt.app.upgrade(actor(f), id).journal.state).toBe("complete");
    }
    expect(f.rt.app.deletionLedger(actor(f)).tombstones).toEqual(ledger);
    expect(f.rt.app.tasks(actor(f), a.id).proposed.length).toBeGreaterThan(0);
  }
}, 120_000);

test("disk, native and storage errors leave explicit failed or pending journals and the original installation", async () => {
  // Native error inside the recovery point: failed, fence released, nothing activated.
  const broken = await fixture(fixturePort({ snapshot: () => { throw new AppError("native_snapshot_failed", 500); } }));
  const before = userData(broken.rt.store);
  await expect(prepare(broken)).rejects.toThrow(/recovery_point_native_snapshot_failed/);
  expect(journals(broken).at(-1)).toMatchObject({ state: "failed", steps: expect.arrayContaining([expect.objectContaining({ name: "snapshot", ok: false })]) });
  expect(readUpgradeFence(broken.rt.store.path)).toBeNull();
  expect(userData(broken.rt.store)).toBe(before);
  // Disk error writing the staged copy: the journal stays prepared and retryable.
  const f = await fixture();
  project(f, "disk", "t");
  const prepared = (await prepare(f)).journal;
  const attemptDir = join(f.dirs.upgrade, prepared.id);
  chmodSync(attemptDir, 0o500);
  try {
    await expect(stepCmd(f, "upgrade.migrate", prepared.id)).rejects.toThrow("upgrade_storage_unavailable");
  } finally { chmodSync(attemptDir, 0o700); }
  expect(f.rt.app.upgrade(actor(f), prepared.id).journal.state).toBe("prepared");
  await stepCmd(f, "upgrade.migrate", prepared.id);
  await stepCmd(f, "upgrade.validate", prepared.id);
  // A staged copy altered after validation is never activated.
  const db = new Database(prepared.stagedPath!); db.exec("UPDATE app_state SET revision = revision + 7"); db.close();
  await expect(stepCmd(f, "upgrade.activate", prepared.id)).rejects.toThrow("upgrade_staged_changed");
  expect(f.rt.app.upgrade(actor(f), prepared.id).journal).toMatchObject({ state: "blocked", reason: "upgrade_staged_changed" });
  // An unknown live identity after an activation intent stays blocked; nothing guesses.
  const g = await fixture();
  project(g, "unknown", "t");
  g.fault.point = "activation_intent";
  const pid = (await prepare(g)).journal.id;
  await stepCmd(g, "upgrade.migrate", pid);
  await stepCmd(g, "upgrade.validate", pid);
  await expect(stepCmd(g, "upgrade.activate", pid)).rejects.toBeInstanceOf(SimulatedCrash);
  g.rt.store.transaction(tx => tx.run("UPDATE app_state SET revision = revision + 1"));
  await restart(g);
  expect(g.rt.app.upgrade(actor(g), pid).journal).toMatchObject({ state: "blocked", reason: "activation_state_unknown", actions: [] });
  expect(upgradeActions({ state: "blocked", reason: "activation_state_unknown", snapshotBackupId: "x", stagedPath: "y", stagedSchema: 1 })).toEqual([]);
});

// ---------------------------------------------------------------------------
// Historical installations (offline owner upgrade path)
// ---------------------------------------------------------------------------

/** A valid service configuration rooted at `root` (directories and ledger created). */
function serviceFor(root: string): ServiceConfig {
  for (const dir of ["release", "work", "state", "backup"]) mkdirSync(join(root, dir), { recursive: true, mode: 0o700 });
  const ledger = join(root, "state", "ledger.json");
  writeFileSync(ledger, JSON.stringify({ ledger: "jit.deletion.ledger/v1", revision: 1 }) + "\n", { mode: 0o600 });
  return { serviceUser: "jit-service", executablePath: join(root, "release"), workingDirectory: join(root, "work"),
    stateDirectory: join(root, "state"), ledgerPath: ledger, backupDirectory: join(root, "backup"), routes: [], secretRefs: [],
    network: { bindHost: "127.0.0.1", port: 3443, vpnInterface: null },
    resources: { memoryMaxBytes: 536870912, maxRestarts: 3, restartWindowSeconds: 300, logBytes: 1048576, retentionDays: 30 } };
}

/** Rewinds a fresh current store to a historical fixture schema by removing tables later migrations add. */
function historical(path: string, version: number) {
  const db = new Database(path);
  const drops: Record<number, string[]> = { 28: ["topic_promotions", "chat_title_sources"], 27: ["dispatch_proposals", "dispatch_allowance_revisions"], 26: ["general_space", "setup_state"], 25: ["jit_reply_sources", "jit_replies", "persona_revisions"], 24: ["owner_preferences"], 23: ["lifecycle_ledger", "lifecycle_checkpoint"], 22: [], 21: ["schway_native_refs"], 20: ["restore_quarantines"], 19: ["upgrade_journal"], 18: ["export_artifacts"] };
  const triggers: Record<number, string[]> = { 28: ["general_space_keep", "general_space_fixed", "general_project_keep"], 25: ["jit_reply_job_change"], 23: ["lifecycle_ledger_deletion", "lifecycle_ledger_suppression", "lifecycle_ledger_suppressed_claim", "lifecycle_ledger_suppressed_source"] };
  for (let v = schemaVersion; v > version; v--) {
    for (const trigger of triggers[v] ?? []) db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
    for (const table of drops[v] ?? []) db.exec(`DROP TABLE IF EXISTS ${table}`);
  }
  db.exec(`PRAGMA user_version = ${version};`);
  db.close();
}

test("boot never migrates an older installation; the owner upgrade migrates staged copies from every supported schema", async () => {
  for (const version of [17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27]) {
    const root = mkdtempSync(join(tmpdir(), "jit-ops-upgrade-legacy-")); roots.push(root);
    const path = join(root, "state.sqlite");
    const config = readConfig({ JIT_DATABASE: path });
    // Seed with the current build, then rewind to the historical schema.
    {
      const store = new TransactionStore(path);
      const app = new Application(store, config, { now: () => epoch });
      await app.setupOwner(password);
      const owner = app.authenticate(await app.login(password)).actor;
      const p = app.execute(owner, { kind: "project.create", projectId: null, requestId: rid(), expectedRevision: app.workspace(owner).revision, payload: { name: `legacy ${version}` } }).project;
      app.execute(owner, { kind: "topic.create", requestId: rid(), projectId: p.id, expectedRevision: p.revision, payload: { title: "legacy topic" } });
      tombstone(store, p.id);
      store.close();
    }
    historical(path, version);
    const bytes = readFileSync(path);
    // Read-only boot gates: preflight blocks with run-owner-upgrade and nothing migrates.
    const store = new TransactionStore(path, { migrateExisting: false }); stores.push(store);
    expect(store.read(tx => tx.get<{ user_version: number }>("PRAGMA user_version")!.user_version)).toBe(version);
    const service = serviceFor(root);
    expect(preflightService({ store, config, service, requiredEngine: "jit.schway.bridge/v1" }).gates.find(g => g.gate === "schema"))
      .toMatchObject({ state: "blocked", nextAction: "run-owner-upgrade" });
    expect(readFileSync(path).subarray(100)).toEqual(bytes.subarray(100));
    // Owner-authorized staged upgrade on the old installation.
    const port = fixturePort();
    const app = new Application(store, config, { now: () => epoch, nativeSnapshot: port });
    const owner = app.authenticate(await app.login(password)).actor;
    const status = app.upgradeStatus(owner);
    expect(status).toMatchObject({ currentSchema: version, target: schemaVersion, upgradeAvailable: true, engine: { compatible: true } });
    const projectsBefore = store.read(tx => tx.all("SELECT * FROM projects ORDER BY id"));
    const ledgerBefore = store.read(tx => tx.all("SELECT * FROM deletion_ledger ORDER BY id"));
    const prepared = (await app.execute(owner, { kind: "upgrade.prepare", requestId: rid(), projectId: null, expectedRevision: status.revision,
      payload: { targetSchema: schemaVersion, note: "legacy" } })).journal;
    expect(prepared.preflight.migrations).toEqual(Array.from({ length: schemaVersion - version }, (_, i) => version + 1 + i));
    expect(store.read(tx => tx.get<{ user_version: number }>("PRAGMA user_version")!.user_version)).toBe(version);
    for (const kind of ["upgrade.migrate", "upgrade.validate", "upgrade.activate"] as const) {
      const receipt = await app.execute(owner, { kind, requestId: rid(), projectId: null, expectedRevision: app.upgradeStatus(owner).revision, payload: { upgradeId: prepared.id } });
      if (kind === "upgrade.validate") expect(receipt.journal.validation!.checks.filter(c => !c.pass)).toEqual([]);
    }
    expect(store.read(tx => tx.get<{ user_version: number }>("PRAGMA user_version")!.user_version)).toBe(schemaVersion);
    expect(app.upgrade(owner, prepared.id).journal).toMatchObject({ state: "activated", nextAction: "start_service_to_reconcile_jobs_sessions" });
    expect(store.read(tx => tx.all("SELECT * FROM projects ORDER BY id"))).toEqual(projectsBefore);
    expect(store.read(tx => tx.all("SELECT * FROM deletion_ledger ORDER BY id"))).toEqual(ledgerBefore);
    // The next service boot reconciles before admission and completes the journal.
    const managed = ManagedService.forConfig(store, config); services.push(managed);
    const booted = new Application(store, config, { now: () => epoch, service: managed });
    const result = await booted.boot();
    expect(result).toMatchObject({ reconciled: true, upgrade: { state: "complete" } });
  }
}, 120_000);

test("serve refuses an older installation without migrating it, and the offline upgrade CLI fails closed without an engine", async () => {
  const root = mkdtempSync(join(tmpdir(), "jit-ops-upgrade-cli-")); roots.push(root);
  const path = join(root, "state.sqlite");
  const config = readConfig({ JIT_DATABASE: path });
  {
    const store = new TransactionStore(path);
    await new Application(store, config).setupOwner(password);
    store.close();
  }
  historical(path, 20);
  const env = { ...process.env, JIT_DATABASE: path, JIT_RUN_PORT: "scripted" };
  const serve = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "main.ts"), "serve"], { env, stdout: "pipe", stderr: "pipe" });
  expect(await serve.exited).toBe(1);
  expect(await new Response(serve.stderr).text()).toContain("Upgrade required: installation schema 20");
  expect(inspectStoreSchema(path)).toBe(20);
  const cli = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "main.ts"), "upgrade", "--password-stdin"], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  cli.stdin.write(`${password}\n`); cli.stdin.end();
  expect(await cli.exited).toBe(1);
  const out = JSON.parse((await new Response(cli.stdout).text()).trim()) as { error: string; upgrade: UpgradeJournal };
  expect(out).toMatchObject({ error: "engine_unavailable", upgrade: { state: "failed", fromSchema: 20, targetSchema: schemaVersion } });
  expect(inspectStoreSchema(path)).toBe(20);
  expect(existsSync(upgradeFencePath(path))).toBe(false);
}, 60_000);

test("startFullApp blocks an older installation at the schema gate without migrating it", async () => {
  const root = mkdtempSync(join(tmpdir(), "jit-ops-upgrade-full-")); roots.push(root);
  const service = serviceFor(root);
  const path = join(root, "state", "app.sqlite");
  new TransactionStore(path).close();
  historical(path, 21);
  const config = readConfig({ JIT_DATABASE: path });
  const started = await startFullApp({ config, service });
  expect(started.ok).toBe(false);
  if (!started.ok) expect(started.gates.find(g => g.gate === "schema")).toMatchObject({ state: "blocked", nextAction: "run-owner-upgrade" });
  expect(inspectStoreSchema(path)).toBe(21);
});

// ---------------------------------------------------------------------------
// Owner Web
// ---------------------------------------------------------------------------

test("web upgrades render the supported target, valid recovery choices only, and drive the full flow without secrets", async () => {
  const f = await fixture();
  await rich(f);
  const web = createWebHandler(f.rt.app);
  const req = (path: string, method = "GET", body?: unknown) => new Request(`http://localhost:3000${path}`, { method,
    headers: { cookie: `jit_session=${f.token}`, ...(body ? { origin: "http://localhost:3000", "x-csrf-token": f.rt.app.authenticate(f.token).csrf, "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const list = await (await web(req("/settings/upgrades"))).text();
  expect(list).toContain(`name="targetSchema" value="${schemaVersion}"`);
  expect(list).not.toContain('value="20"');
  // A preflight failure has no checkpoint: no rollback or migrate is offered.
  await expect(prepare(f, 99)).rejects.toThrow("unsupported_upgrade");
  const failed = journals(f).at(-1)!;
  expect(failed.actions).toEqual([]);
  expect(await (await web(req(`/settings/upgrades/${failed.id}`))).text()).not.toContain('value="rollback"');
  const prepared = await (await web(req("/api/upgrades", "POST", { requestId: rid(), expectedRevision: appRevision(f), targetSchema: schemaVersion, note: "web" }))).json() as { journal: UpgradeJournal & { actions: string[] } };
  expect(prepared.journal).toMatchObject({ state: "prepared", actions: ["migrate", "rollback"] });
  const html = await (await web(req(`/settings/upgrades/${prepared.journal.id}`))).text();
  expect(html).toContain('value="migrate"');
  expect(html).not.toContain('value="activate"');
  for (const action of ["migrate", "validate", "activate"] as const) {
    const response = await web(req(`/api/upgrades/${prepared.journal.id}`, "POST", { requestId: rid(), expectedRevision: appRevision(f), action }));
    expect(response.status).toBe(200);
  }
  const done = await (await web(req(`/settings/upgrades/${prepared.journal.id}`))).text();
  expect(done).toContain("ops.schema_migrations/v1");
  expect(done).toContain("OPS02");
  expect(done).not.toContain('value="rollback"');
  expect(done).not.toContain(f.token);
  const api = await (await web(req(`/api/upgrades/${prepared.journal.id}`))).json() as { journal: UpgradeJournal };
  expect(api.journal.state).toBe("complete");
  expect(JSON.stringify(api)).not.toContain(f.token);
});

// ---------------------------------------------------------------------------
// Review regressions: snapshot metadata, real-migration activation intent,
// concrete Schway bridge through the production lifecycle.
// ---------------------------------------------------------------------------

test("malformed native snapshot metadata never yields a valid recovery point", async () => {
  const base = { engine: "fixture-engine/1", contract: upgradeEngineContract, formatVersion: upgradeNativeFormatVersion, artifacts: [] };
  const id = rid();
  for (const snap of [
    { ...base, refs: [], bytes: Number.NaN }, { ...base, refs: [], bytes: Number.POSITIVE_INFINITY }, { ...base, refs: [], bytes: 1.5 }, { ...base, refs: [], bytes: -1 },
    { ...base, refs: [{ id, generation: 0 }], bytes: 0 }, { ...base, refs: [{ id, generation: 1 }, { id, generation: 1 }], bytes: 0 },
    { ...base, refs: [{ id, generation: 1, extra: true }], bytes: 0 },
  ]) {
    expect(normalizeNativeSnapshot(snap).section).toMatchObject({ state: "incomplete", reason: "native_snapshot_invalid" });
  }
  const f = await fixture(fixturePort({ snapshot: () => ({ ...base, refs: [], bytes: Number.NaN }) }));
  await expect(prepare(f)).rejects.toThrow("recovery_point_native_snapshot_invalid");
  expect(journals(f).at(-1)).toMatchObject({ state: "failed", reason: "recovery_point_native_snapshot_invalid" });
  expect(f.native!.calls.snapshot).toBe(1);
  expect(readUpgradeFence(f.rt.store.path)).toBeNull();
});

test("a real migration's activation intent resolves by live identity: not applied stays ready, applied completes after boot", async () => {
  for (const [point, recovered] of [["activation_intent", "ready"], ["swapped", "complete"]] as const) {
    const root = mkdtempSync(join(tmpdir(), "jit-ops-upgrade-intent-")); roots.push(root);
    const path = join(root, "state.sqlite");
    const config = readConfig({ JIT_DATABASE: path });
    {
      const store = new TransactionStore(path);
      const app = new Application(store, config, { now: () => epoch });
      await app.setupOwner(password);
      store.close();
    }
    historical(path, 21);
    const open = (fault: UpgradeFaultPoint | null) => {
      const store = new TransactionStore(path, { migrateExisting: false }); stores.push(store);
      const app = new Application(store, config, { now: () => epoch, nativeSnapshot: fixturePort(),
        upgradeFault: at => { if (at === fault) throw new SimulatedCrash(at); } });
      return { store, app };
    };
    let rt = open(point);
    let owner = rt.app.authenticate(await rt.app.login(password)).actor;
    const rev = () => rt.app.upgradeStatus(owner).revision;
    const id = (await rt.app.execute(owner, { kind: "upgrade.prepare", requestId: rid(), projectId: null, expectedRevision: rev(), payload: { targetSchema: schemaVersion, note: "intent" } })).journal.id;
    await rt.app.execute(owner, { kind: "upgrade.migrate", requestId: rid(), projectId: null, expectedRevision: rev(), payload: { upgradeId: id } });
    await rt.app.execute(owner, { kind: "upgrade.validate", requestId: rid(), projectId: null, expectedRevision: rev(), payload: { upgradeId: id } });
    await expect(rt.app.execute(owner, { kind: "upgrade.activate", requestId: rid(), projectId: null, expectedRevision: rev(), payload: { upgradeId: id } }))
      .rejects.toBeInstanceOf(SimulatedCrash);
    rt.store.close(); stores.splice(stores.indexOf(rt.store), 1);
    expect(inspectStoreSchema(path)).toBe(point === "activation_intent" ? 21 : schemaVersion);
    rt = open(null);
    owner = rt.app.authenticate(await rt.app.login(password)).actor;
    if (point === "activation_intent") {
      expect(rt.app.upgrade(owner, id).journal).toMatchObject({ state: "ready", reason: "activation_interrupted", actions: ["activate", "rollback"] });
      expect(readUpgradeFence(path)?.upgradeId).toBe(id);
      // Rollback keeps the untouched schema-21 installation.
      expect((await rt.app.execute(owner, { kind: "upgrade.rollback", requestId: rid(), projectId: null, expectedRevision: rev(), payload: { upgradeId: id } })).journal.state).toBe("rolled_back");
      expect(inspectStoreSchema(path)).toBe(21);
    } else {
      expect(rt.app.upgrade(owner, id).journal).toMatchObject({ state: "activated" });
      expect(readUpgradeFence(path)).toBeNull();
      const managed = ManagedService.forConfig(rt.store, config); services.push(managed);
      const booted = await new Application(rt.store, config, { now: () => epoch, service: managed }).boot();
      expect(booted.upgrade?.state).toBe(recovered);
    }
  }
});

test("startFullApp in schway mode upgrades over real native sessions and rebuilds the scheduler through the managed service", async () => {
  const root = mkdtempSync(join(tmpdir(), "jit-ops-upgrade-schway-")); roots.push(root);
  const service = serviceFor(root);
  const config = readConfig({ JIT_DATABASE: join(root, "state", "app.sqlite"), JIT_RUN_PORT: "schway" });
  const started = await startFullApp({ config, service });
  if (!started.ok) throw new Error(JSON.stringify(started.gates));
  const { app, store } = started.handle;
  stores.push(store); services.push(started.handle.service);
  await app.setupOwner(password);
  const owner = app.authenticate(await app.login(password)).actor;
  app.execute(owner, { kind: "project.create", requestId: rid(), projectId: null, expectedRevision: app.workspace(owner).revision, payload: { name: "schway upgrade" } });
  const run = { ...schwayRun(config) };
  store.transaction(tx => { tx.run("INSERT INTO team_contexts VALUES (?, 1, 'active')", run.context.id); });
  const bridge = new SchwayRunPort(store, config.team, config.jobs.outputBytes, { model: {
    provider: "scripted", id: "upgrade-fixture",
    async *stream() { yield { type: "message_complete", message: { type: "assistant", id: rid(), content: [{ type: "text", text: "หลักฐาน" }] } }; },
  } });
  expect(await bridge.invoke(run, new AbortController().signal, () => {})).toMatchObject({ state: "complete" });
  const before = started.handle.queue;
  const rev = () => app.workspace(owner).revision;
  const prepared = (await app.execute(owner, { kind: "upgrade.prepare", requestId: rid(), projectId: null, expectedRevision: rev(),
    payload: { targetSchema: schemaVersion, note: "schway" } })).journal;
  expect(prepared).toMatchObject({ state: "prepared", preflight: { engine: { compatible: true, contract: upgradeEngineContract } }, checkpoint: { nativeRefs: 1 } });
  await app.execute(owner, { kind: "upgrade.migrate", requestId: rid(), projectId: null, expectedRevision: rev(), payload: { upgradeId: prepared.id } });
  const validated = (await app.execute(owner, { kind: "upgrade.validate", requestId: rid(), projectId: null, expectedRevision: rev(), payload: { upgradeId: prepared.id } })).journal;
  expect(validated.validation!.checks.filter(c => !c.pass)).toEqual([]);
  expect(validated.validation!.nativeRefs).toBeGreaterThan(0);
  const done = (await app.execute(owner, { kind: "upgrade.activate", requestId: rid(), projectId: null, expectedRevision: rev(), payload: { upgradeId: prepared.id } })).journal;
  expect(done).toMatchObject({ state: "complete", reconcile: { reconciled: true } });
  expect(started.handle.queue).not.toBe(before);
  expect(store.read(tx => started.handle.queue.available(tx))).toBe(true);
  expect(store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM schway_native_refs WHERE run_id = ?", run.runId)!.n)).toBe(1);
}, 60_000);

function schwayRun(config: Config): ApplicationRunRequest {
  const projectId = rid();
  return { runId: rid(), projectId, topicId: rid(), roleId: rid(), purpose: "upgrade native run",
    route: { provider: "grok", model: "fixture-grok-exact", authRoute: "owner-grok" },
    configuration: { ownerRevision: 1, projectRevision: 1, roleRevision: 1 },
    context: { id: rid(), generation: 1 }, fence: { jobId: rid(), generation: 1, ownerGeneration: 1 },
    instructions: { operator: ["fixture"], responsibility: "ทดสอบ" },
    manifest: { sources: [{ projectId, reference: { sourceId: rid(), revision: 1, generation: 1 }, text: "ต้นทาง" }], claims: [] },
    tools: [], policy: { genericExecution: false, arbitraryFetch: false, hostedLookup: false, repositoryDiscovery: false },
    limits: structuredClone(config.jobs.maximum) };
}

// ---------------------------------------------------------------------------
// Review round 2: untrusted control-plane journal, attempt native binding
// ---------------------------------------------------------------------------

test("a tampered journal is a durable blocked corrupt state: derived paths only, no destructive action", async () => {
  const f = await fixture();
  project(f, "journal", "t");
  const prepared = (await prepare(f)).journal;
  const file = join(f.dirs.upgrade, prepared.id, "journal.json");
  const original = readFileSync(file, "utf8");
  const tamper = (mutate: (journal: Record<string, unknown>) => void) => {
    const journal = JSON.parse(original) as Record<string, unknown>;
    mutate(journal);
    writeFileSync(file, JSON.stringify(journal));
  };
  for (const mutate of [
    (j: Record<string, unknown>) => { j.stagedPath = f.rt.store.path; },
    (j: Record<string, unknown>) => { j.stagedPath = join(tmpdir(), "outside.sqlite"); },
    (j: Record<string, unknown>) => { j.ledger = { ...(j.ledger as object), path: f.rt.store.path }; },
    (j: Record<string, unknown>) => { j.state = "exploded"; },
    (j: Record<string, unknown>) => { j.state = "ready"; },
    (j: Record<string, unknown>) => { delete j.liveDigest; },
    (j: Record<string, unknown>) => { j.extra = true; },
  ]) {
    tamper(mutate);
    const view = f.rt.app.upgrade(actor(f), prepared.id).journal;
    expect(view).toMatchObject({ state: "blocked", reason: "upgrade_corrupt", actions: [], stagedPath: null });
    expect(journals(f).find(j => j.id === prepared.id)).toMatchObject({ reason: "upgrade_corrupt", actions: [] });
    for (const kind of ["upgrade.rollback", "upgrade.migrate", "upgrade.activate"] as const) {
      await expect(stepCmd(f, kind, prepared.id)).rejects.toThrow("upgrade_corrupt");
    }
    await expect(prepare(f)).rejects.toThrow("upgrade_in_progress");
    expect(existsSync(f.rt.store.path)).toBe(true);
    expect(f.rt.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM projects")!.n)).toBe(1);
  }
  // The journal file itself must be a regular file, not a symlink.
  rmSync(file);
  symlinkSync(join(tmpdir(), "elsewhere.json"), file);
  expect(f.rt.app.upgrade(actor(f), prepared.id).journal).toMatchObject({ reason: "upgrade_corrupt", actions: [] });
});

test("a symlinked staged copy blocks the attempt as corrupt and never touches its target", async () => {
  const f = await fixture();
  project(f, "symlink", "t");
  const prepared = (await prepare(f)).journal;
  await stepCmd(f, "upgrade.migrate", prepared.id);
  rmSync(prepared.stagedPath!);
  symlinkSync(f.rt.store.path, prepared.stagedPath!);
  await expect(stepCmd(f, "upgrade.validate", prepared.id)).rejects.toThrow("upgrade_corrupt");
  expect(f.rt.app.upgrade(actor(f), prepared.id).journal).toMatchObject({ state: "blocked", reason: "upgrade_corrupt", actions: [] });
  await expect(stepCmd(f, "upgrade.rollback", prepared.id)).rejects.toThrow("upgrade_bad_state");
  expect(existsSync(f.rt.store.path)).toBe(true);
  expect(f.rt.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM projects")!.n)).toBe(1);
});

test("orphaned, unbound or uncorrelated attempt native references fail validation and block activation", async () => {
  const cases: [string, string][] = [
    // Context identity missing from team_contexts.
    [(() => { const context = rid(); return `UPDATE job_attempts SET record_json = json_set(record_json, '$.native.context.id', '${context}', '$.data.context.id', '${context}') WHERE rowid = (SELECT max(rowid) FROM job_attempts WHERE json_extract(record_json, '$.native') IS NOT NULL)`; })(), "context_orphaned"],
    // Not bound to the owning job.
    [`UPDATE job_attempts SET record_json = json_set(record_json, '$.jobId', '${rid()}') WHERE rowid = (SELECT max(rowid) FROM job_attempts)`, "envelope_invalid"],
    // Not bound to its run request.
    [(() => { const run = rid(); return `UPDATE job_attempts SET record_json = json_set(record_json, '$.native.runId', '${run}', '$.native.sessionId', '${run}') WHERE rowid = (SELECT max(rowid) FROM job_attempts WHERE json_extract(record_json, '$.native') IS NOT NULL)`; })(), "run_mismatch"],
    // Missing or non-object admission snapshot.
    [`UPDATE job_attempts SET record_json = json_remove(record_json, '$.snapshot') WHERE rowid = (SELECT max(rowid) FROM job_attempts)`, "envelope_invalid"],
    [`UPDATE job_attempts SET record_json = json_set(record_json, '$.snapshot', 'gone') WHERE rowid = (SELECT max(rowid) FROM job_attempts)`, "snapshot_invalid"],
    // A native reference whose data is not the admitted run request.
    [`UPDATE job_attempts SET record_json = json_set(record_json, '$.data', 'opaque') WHERE rowid = (SELECT max(rowid) FROM job_attempts WHERE json_extract(record_json, '$.native') IS NOT NULL)`, "run_request_invalid"],
    [`UPDATE job_attempts SET record_json = json_set(record_json, '$.data', json('null')) WHERE rowid = (SELECT max(rowid) FROM job_attempts WHERE json_extract(record_json, '$.native') IS NOT NULL)`, "run_request_invalid"],
    // The run request's fence must belong to this job and attempt generation.
    [`UPDATE job_attempts SET record_json = json_set(record_json, '$.data.fence.generation', 999) WHERE rowid = (SELECT max(rowid) FROM job_attempts WHERE json_extract(record_json, '$.native') IS NOT NULL)`, "fence_mismatch"],
    // A dispatched Schway attempt without its durable bridge correlation.
    [`UPDATE job_attempts SET record_json = json_set(record_json, '$.native.adapter', 'schway', '$.transport', 'settled') WHERE rowid = (SELECT max(rowid) FROM job_attempts WHERE json_extract(record_json, '$.native') IS NOT NULL)`, "native_ref_missing"],
  ];
  for (const [sql, detail] of cases) {
    const f = await fixture();
    await rich(f);
    const prepared = (await prepare(f)).journal;
    const migrated = (await stepCmd(f, "upgrade.migrate", prepared.id)).journal;
    const db = new Database(migrated.stagedPath!);
    db.exec(sql);
    db.close();
    const validated = (await stepCmd(f, "upgrade.validate", prepared.id)).journal;
    expect(validated.state).toBe("blocked");
    expect(validated.validation!.checks.find(c => c.name === "native_opaque_refs")!.detail).toContain(detail);
    await expect(stepCmd(f, "upgrade.activate", prepared.id)).rejects.toThrow("upgrade_bad_state");
  }
});

test("rollback over an unsafe staged artifact blocks as corrupt, keeps the fence and never touches the target", async () => {
  for (const unsafe of ["symlink", "directory"] as const) {
    const f = await fixture();
    project(f, "rollback-unsafe", "t");
    const prepared = (await prepare(f)).journal;
    await stepCmd(f, "upgrade.migrate", prepared.id);
    rmSync(prepared.stagedPath!);
    if (unsafe === "symlink") symlinkSync(f.rt.store.path, prepared.stagedPath!);
    else { mkdirSync(prepared.stagedPath!); writeFileSync(join(prepared.stagedPath!, "keep"), "x"); }
    await expect(stepCmd(f, "upgrade.rollback", prepared.id)).rejects.toThrow("upgrade_corrupt");
    expect(f.rt.app.upgrade(actor(f), prepared.id).journal).toMatchObject({ state: "blocked", reason: "upgrade_corrupt", actions: [] });
    expect(readUpgradeFence(f.rt.store.path)?.upgradeId).toBe(prepared.id);
    expect(existsSync(f.rt.store.path)).toBe(true);
    expect(f.rt.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM projects")!.n)).toBe(1);
    if (unsafe === "directory") expect(existsSync(join(prepared.stagedPath!, "keep"))).toBe(true);
  }
});
