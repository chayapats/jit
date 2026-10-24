import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Application } from "../src/application";
import { readConfig } from "../src/config";
import { DeliveryWorker } from "../src/delivery";
import { attemptAuthority, type JobAttempt } from "../src/jobs/attempts";
import { JobQueue } from "../src/jobs/queue";
import { reconcileDeletions } from "../src/memory/delete";
import { memoryExtractionMarker, memoryExtractionWork, scriptedMemoryResult } from "../src/memory/extract";
import type { ClaimReference, MemoryClaim } from "../src/memory/types";
import type { BackupNativePort } from "../src/ops/backup";
import { ledgerCheckpointPathFor, syncLedgerCheckpoint } from "../src/ops/lifecycle-ledger";
import { startFullApp } from "../src/ops/lifecycle";
import {
  SimulatedRestoreCrash, readRestoreGate, restoreAppCompat, restoreCompat, restoreEngineCompat, type RestoreEvidence, type RestoreFaultPoint,
} from "../src/ops/restore";
import { upgradeEngineContract, upgradeNativeFormatVersion } from "../src/ops/upgrade";
import { clearUpgradeFence, readUpgradeFence, upgradeFencePath, writeUpgradeFence } from "../src/ops/upgrade-fence";
import { ManagedService } from "../src/ops/upgrade-service";
import type { SourceReference } from "../src/sources";
import { TransactionStore, schemaVersion } from "../src/store";
import { coordinatorSynthesisMarker, coordinatorSynthesisWork } from "../src/team/decisions";
import { discussionPlanWork, specialistAnalysisWork } from "../src/team/dispatch";
import type { ApplicationRunPort } from "../src/team/run-port";
import { ScriptedRunPort, fixtureOutcome, withContextAnswer } from "../src/team/scripted-port";
import type { ApplicationRunRequest, RoleRoute, TeamCommand } from "../src/team/types";
import { createWebHandler } from "../src/web";
import type { ServiceConfig } from "../ops/package/service-config";

/**
 * OPS02 ops.quarantined_restore/v1. Scripted models, fixture engine ports and
 * fake clocks only; the shared admission fence and service lifecycle come
 * from OPS06 (ops.schema_migrations/v1).
 */
const roots: string[] = [], stores: TransactionStore[] = [], services: ManagedService[] = [];
afterEach(async () => {
  for (const s of services.splice(0)) { s.close(); try { await s.queue?.idle(); } catch { /* Teardown. */ } }
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* Already closed. */ } }
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});
const rid = (): string => crypto.randomUUID(), epoch = 1800000000000, password = "ops-restore-owner-password";
const grok: RoleRoute = { provider: "grok", model: "fixture-grok-exact", authRoute: "owner-grok" };
type Script = (request: ApplicationRunRequest, signal: AbortSignal) => unknown | Promise<unknown>;
type Config = ReturnType<typeof readConfig>;

/** Fixture engine port declaring the supported snapshot contract (no native references, so no native bytes). */
function enginePort(options: { contract?: string; available?: boolean } = {}): BackupNativePort {
  const contract = options.contract ?? upgradeEngineContract;
  return { engine: "fixture-engine/1", contract, formatVersion: upgradeNativeFormatVersion,
    available: () => options.available ?? true,
    snapshot: () => ({ refs: [], bytes: 0, engine: "fixture-engine/1", contract, formatVersion: upgradeNativeFormatVersion, artifacts: [] }) };
}

interface Flags { deleteFail: boolean; failCompose: boolean; failResume: boolean; fault: RestoreFaultPoint | null }
interface Runtime { store: TransactionStore; port: ScriptedRunPort; service: ManagedService; app: Application }

async function boot(config: Config, hooks: { extract: Script; specialist: Script }, clock: { now: number }, dirs: { backup: string; restore: string; upgrade: string },
  flags: Flags, native: BackupNativePort): Promise<Runtime> {
  const store = new TransactionStore(config.databasePath, { migrateExisting: false }); stores.push(store);
  const script = (request: ApplicationRunRequest, signal: AbortSignal) =>
    request.instructions.operator.includes(memoryExtractionMarker) ? hooks.extract(request, signal)
      : request.instructions.operator.includes(coordinatorSynthesisMarker) ? fixtureOutcome("complete", JSON.stringify({ question: "เจ้าของจะเลือกทางใด", disagreement: false, consensus: true,
        options: [{ id: "first", label: "ทางแรก", rationale: "ตามผลวิเคราะห์", citations: request.manifest.sources.map(source => ({ ...source.reference })) },
          { id: "second", label: "ทางที่สอง", rationale: "alternative", citations: request.manifest.sources.map(source => ({ ...source.reference })) }] }))
      : hooks.specialist(request, signal);
  const port = new ScriptedRunPort(store, config.team, config.jobs.outputBytes, script, () => flags.deleteFail, () => false);
  const now = () => clock.now;
  const service = new ManagedService(store, () => {
    if (flags.failCompose) throw new Error("fixture compose failure");
    return { teamPort: port, queue: new JobQueue(store, config.jobs, [memoryExtractionWork(store, config, port, now), discussionPlanWork(),
      specialistAnalysisWork(store, config, port, now), coordinatorSynthesisWork(store, config, port, now)], { now }) };
  }, { drainTimeoutMs: 200 });
  services.push(service);
  const resume = service.resume.bind(service);
  service.resume = async () => flags.failResume ? { reconciled: false, detail: "fixture_resume_failure" } : resume();
  const app = new Application(store, config, { service, now, backupDir: dirs.backup, restoreDir: dirs.restore, upgradeDir: dirs.upgrade, nativeSnapshot: native,
    restoreFault: point => { if (flags.fault === point) { flags.fault = null; throw new SimulatedRestoreCrash(point); } } });
  await app.boot();
  return { store, port, service, app };
}

async function fixture(native: BackupNativePort = enginePort()) {
  const root = mkdtempSync(join(tmpdir(), "jit-ops-restore-")); roots.push(root);
  const config = readConfig({ JIT_DATABASE: join(root, "state.sqlite") }), clock = { now: epoch };
  const flags: Flags = { deleteFail: false, failCompose: false, failResume: false, fault: null };
  const requests: string[] = [];
  const defaults = {
    extract: ((request: ApplicationRunRequest) => scriptedMemoryResult(request, true)) as Script,
    specialist: ((request: ApplicationRunRequest) => { requests.push(JSON.stringify(request)); return fixtureOutcome("complete", withContextAnswer("ตอบจำลอง", request, config.jobs.outputBytes)); }) as Script,
  };
  const hooks = { ...defaults };
  const dirs = { backup: join(root, "backups"), restore: join(root, "restores"), upgrade: join(root, "upgrades") };
  const rt = await boot(config, hooks, clock, dirs, flags, native);
  await rt.app.setupOwner(password);
  const f = { root, config, clock, flags, hooks, defaults, dirs, rt, native, requests, token: await rt.app.login(password), roles: { tech: "", coordinator: "" } };
  f.roles.tech = rt.app.execute(actor(f), { kind: "role.save", projectId: null, requestId: rid(), expectedRevision: rt.app.team(actor(f)).ownerRevision,
    payload: { roleId: null, name: "เทคโนโลยี", kind: "specialist", responsibility: "วิเคราะห์ฐานข้อมูลและโครงสร้างซอฟต์แวร์", enabled: true, route: grok } }).role!.id;
  f.roles.coordinator = rt.app.execute(actor(f), { kind: "role.save", projectId: null, requestId: rid(), expectedRevision: rt.app.team(actor(f)).ownerRevision,
    payload: { roleId: null, name: "ผู้ประสานงาน", kind: "coordinator", responsibility: "สรุปความเห็นต่างให้เจ้าของตัดสิน", enabled: true, route: grok } }).role!.id;
  return f;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function actor(f: { rt: Runtime; token: string }) { return f.rt.app.authenticate(f.token).actor; }
const queue = (f: Fixture) => f.rt.service.queue!;
/** Simulated process death and reopen: a new store, service and Application reconcile durable intent at boot. */
async function restart(f: Fixture) {
  f.rt.service.close();
  try { await f.rt.service.queue?.idle(); } catch { /* Settled. */ }
  services.splice(services.indexOf(f.rt.service), 1);
  f.rt.store.close(); stores.splice(stores.indexOf(f.rt.store), 1);
  f.rt = await boot(f.config, f.hooks, f.clock, f.dirs, f.flags, f.native);
}
/** Activation revokes every session (generation fence): the owner signs in again. */
async function relogin(f: Fixture) { f.token = await f.rt.app.login(password); }
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
const extractCommand = (f: Fixture, p: Project, source: SourceReference) => ({ kind: "memory.extract" as const, requestId: rid(), projectId: p.id, expectedRevision: projectRevision(f, p),
  payload: { topicId: p.topic.id, roleId: f.roles.tech, source: { ...source }, dependencies: [], limits: { ...f.config.jobs.maximum } } });
async function remember(f: Fixture, p: Project, source: SourceReference): Promise<MemoryClaim[]> {
  const before = new Set(f.rt.app.memory(actor(f), p.id).items.flatMap(item => item.state === "available" ? [item.claim.claimId] : []));
  f.rt.app.execute(actor(f), extractCommand(f, p, source));
  await drain(f);
  return f.rt.app.memory(actor(f), p.id).items.flatMap(item => item.state === "available" && !before.has(item.claim.claimId) ? [item.claim] : []);
}
function dispatch(f: Fixture, p: Project, purpose: string, sources: SourceReference[]): Extract<TeamCommand, { kind: "team.dispatch" }> {
  return { kind: "team.dispatch", requestId: rid(), projectId: p.id, expectedRevision: projectRevision(f, p),
    payload: { topicId: p.topic.id, purpose, sources, include: [f.roles.tech], exclude: [], limits: { ...f.config.jobs.maximum } } };
}
function deleteSource(f: Fixture, p: Project, source: SourceReference) {
  const preview = f.rt.app.execute(actor(f), { kind: "memory.delete.preview" as const, requestId: rid(), projectId: p.id,
    expectedRevision: projectRevision(f, p), payload: { scope: { kind: "source", projectId: p.id, source: { ...source } } } }) as { preview: { id: string; wholeSession: { required: boolean } } };
  return f.rt.app.execute(actor(f), { kind: "memory.delete.confirm" as const, requestId: rid(), projectId: p.id,
    expectedRevision: projectRevision(f, p), payload: { previewId: preview.preview.id, acknowledged: true, acknowledgedWholeSession: preview.preview.wholeSession.required } }) as { operation: { id: string; state: string } };
}
function forget(f: Fixture, p: Project, claim: ClaimReference) {
  return f.rt.app.execute(actor(f), { kind: "memory.forget", requestId: rid(), projectId: p.id, expectedRevision: projectRevision(f, p),
    payload: { claim: ref(claim), reason: "เจ้าของขอให้ลืม", acknowledged: true } });
}
const appRevision = (f: Fixture) => f.rt.app.restoreConsole(actor(f)).revision;
const backupNow = async (f: Fixture) => (await f.rt.app.execute(actor(f), { kind: "backup.create" as const, requestId: rid(), projectId: null,
  expectedRevision: appRevision(f), payload: { note: "restore fixture backup" } })).manifest;
const prepare = (f: Fixture, backupId: string) => f.rt.app.execute(actor(f), { kind: "restore.prepare", requestId: rid(), projectId: null,
  expectedRevision: appRevision(f), payload: { backupId, note: "test restore" } });
type Step = "restore.migrate" | "restore.apply_ledger" | "restore.validate" | "restore.activate" | "restore.discard";
const stepCmd = (f: Fixture, kind: Step, quarantineId: string) => f.rt.app.execute(actor(f), { kind, requestId: rid(), projectId: null,
  expectedRevision: appRevision(f), payload: { quarantineId } });
async function restoreThrough(f: Fixture, backupId: string, until: Step = "restore.activate"): Promise<RestoreEvidence> {
  let q = (await prepare(f, backupId)).quarantine;
  for (const kind of ["restore.migrate", "restore.apply_ledger", "restore.validate", "restore.activate"] as const) {
    q = (await stepCmd(f, kind, q.id)).quarantine;
    if (kind === until) break;
  }
  return q;
}
const journal = (f: Fixture, id: string) => f.rt.app.restore(actor(f), id).quarantine;
const dbContains = (store: TransactionStore, needle: string) => Buffer.from(store.snapshotBytes()).includes(Buffer.from(needle));

// ---------------------------------------------------------------------------
// Compatibility
// ---------------------------------------------------------------------------

test("app build compatibility: same or older build of the same major only", () => {
  expect(restoreAppCompat("jit/0.1.0", "jit/0.1.0")).toEqual({ compatible: true, reason: null });
  expect(restoreAppCompat("jit/0.0.9", "jit/0.1.0")).toEqual({ compatible: true, reason: null });
  expect(restoreAppCompat("jit/0.1.1", "jit/0.1.0")).toEqual({ compatible: false, reason: "newer_app_unsupported" });
  expect(restoreAppCompat("jit/0.2.0", "jit/0.1.9")).toEqual({ compatible: false, reason: "newer_app_unsupported" });
  expect(restoreAppCompat("jit/999.0.0", "jit/0.1.0")).toEqual({ compatible: false, reason: "newer_app_unsupported" });
  expect(restoreAppCompat("jit/0.1.0", "jit/1.0.0")).toEqual({ compatible: false, reason: "unsupported_app_version" });
  expect(restoreAppCompat("not-a-version", "jit/0.1.0")).toEqual({ compatible: false, reason: "unsupported_app_version" });
});

test("compat matrix: direct, staged migrate and reject before touching data; engine contract only matters with native references", () => {
  expect(restoreCompat(schemaVersion)).toEqual({ action: "direct", reason: null });
  expect(restoreCompat(15)).toEqual({ action: "migrate", reason: null });
  expect(restoreCompat(schemaVersion - 1)).toEqual({ action: "migrate", reason: null });
  expect(restoreCompat(99)).toEqual({ action: "reject", reason: "newer_backup_unsupported" });
  expect(restoreCompat(3)).toEqual({ action: "reject", reason: "manual_recovery_required" });
  const refs = { refs: [{ id: "c", generation: 1 }], contract: upgradeEngineContract, formatVersion: upgradeNativeFormatVersion };
  expect(restoreEngineCompat({ native: { refs: [], contract: null, formatVersion: null } } as never, undefined)).toMatchObject({ compatible: true, nativeRefs: 0 });
  expect(restoreEngineCompat({ native: refs } as never, enginePort())).toMatchObject({ compatible: true, nativeRefs: 1 });
  expect(restoreEngineCompat({ native: { ...refs, contract: "legacy.snapshot/v0" } } as never, enginePort())).toMatchObject({ compatible: false, reason: "unsupported_engine" });
  expect(restoreEngineCompat({ native: refs } as never, enginePort({ available: false }))).toMatchObject({ compatible: false, reason: "engine_unavailable" });
  expect(restoreEngineCompat({ native: refs } as never, enginePort({ contract: "schway.host.session-snapshot/v2" }))).toMatchObject({ compatible: false, reason: "unsupported_engine" });
});

// ---------------------------------------------------------------------------
// Latest ledger replay end to end
// ---------------------------------------------------------------------------

test("older backup restored after delete and forget: removed payload never reaches context, extraction, reports or notifications", async () => {
  const f = await fixture();
  const a = project(f, "โครงการกู้คืน ไทย/English 🧠", "หัวข้อกู้คืน");
  const sKeep = say(f, a, "ความรู้ที่เก็บไว้ restore-keep-canary-001 🌏");
  const [keep] = await remember(f, a, sKeep);
  const sDel = say(f, a, "ข้อมูลที่ต้องลบ restore-del-canary-002 ทิ้ง");
  const [doomed] = await remember(f, a, sDel);
  const sForget = say(f, a, "ข้อมูลที่ต้องลืม restore-forget-canary-003");
  const [forgotten] = await remember(f, a, sForget);
  // Committed before the backup, extracted and forgotten after it: the image has the source but no claim.
  const sLate = say(f, a, "ข้อมูลที่ลืมหลังสำรอง restore-late-canary-004");
  const pending = f.rt.app.execute(actor(f), { kind: "delivery.commit", requestId: rid(), projectId: a.id, expectedRevision: projectRevision(f, a),
    payload: { kind: "report", text: "รายงานก่อนสำรอง restore-report-canary-005", dedupeKey: "pre-backup-1" } });
  // A local notification quoting the payload that is deleted after the backup.
  const quoting = f.rt.app.execute(actor(f), { kind: "delivery.commit", requestId: rid(), projectId: a.id, expectedRevision: projectRevision(f, a),
    payload: { kind: "report", text: "อ้างถึง: ข้อมูลที่ต้องลบ restore-del-canary-002 ทิ้ง", dedupeKey: "pre-backup-quote" } }) as { intent: { id: string } };
  const backup = await backupNow(f);
  f.clock.now += 60_000;
  deleteSource(f, a, sDel);
  await reconcileDeletions(f.rt.store, f.rt.port as unknown as ApplicationRunPort, f.clock.now);
  forget(f, a, forgotten!);
  const [late] = await remember(f, a, sLate);
  forget(f, a, late!);
  const sNew = say(f, a, "ข้อความใหม่หลังสำรอง restore-new-canary-006");
  const liveRevision = appRevision(f);
  const staleToken = f.token;
  // Prepare fences the installation: no managed command, admission or delivery while quarantined.
  const prepared = (await prepare(f, backup.id)).quarantine;
  expect(prepared).toMatchObject({ state: "quarantined", compat: { action: "direct", backupSchema: schemaVersion }, quiesce: { settled: true } });
  expect(readUpgradeFence(f.rt.store.path)).toMatchObject({ holder: "restore", upgradeId: prepared.id });
  expect(() => f.rt.app.execute(actor(f), extractCommand(f, a, sKeep))).toThrow("restore_in_progress");
  expect(() => f.rt.app.execute(actor(f), { kind: "message.send", requestId: rid(), projectId: a.id, expectedRevision: topicRevision(f, a), payload: { topicId: a.topic.id, text: "ระหว่าง quarantine" } })).toThrow("restore_in_progress");
  expect(f.rt.service.queue?.available.bind(f.rt.service.queue) && f.rt.store.read(tx => f.rt.service.queue!.available(tx))).toBe(false);
  const migrated = (await stepCmd(f, "restore.migrate", prepared.id)).quarantine;
  expect(migrated.steps.at(-1)!.detail).toBe("not_required_schema_current");
  const applied = (await stepCmd(f, "restore.apply_ledger", prepared.id)).quarantine;
  expect(applied.state).toBe("ledger_applied");
  expect(applied.ledger).toMatchObject({ source: "installation_lifecycle_ledger" });
  expect(applied.ledger!.deletions).toBeGreaterThan(0);
  expect(applied.ledger!.suppressions).toBe(2);
  const validated = (await stepCmd(f, "restore.validate", prepared.id)).quarantine;
  expect(validated.validation!.checks.filter(c => !c.pass)).toEqual([]);
  expect(validated.state).toBe("validated");
  expect(validated.report).toMatchObject({ activation: { allowed: true, blockers: [] }, versions: { backupSchema: schemaVersion, currentSchema: schemaVersion } });
  expect(validated.report.invalidated!.sourcesPurged).toBeGreaterThan(0);
  expect(validated.report.invalidated!.claimsForgotten).toBeGreaterThan(0);
  expect(validated.report.invalidated!.ledgerOnlySuppressions).toBe(1);
  expect(validated.report.invalidated!.deliveriesHeld).toBe(2);
  expect(validated.report.discarded.liveOnlySources).toBeGreaterThan(0);
  expect(validated.report.generation.restoredRevision).toBeGreaterThan(liveRevision);
  expect(validated.report.retention.length).toBeGreaterThan(0);
  const activated = (await stepCmd(f, "restore.activate", prepared.id)).quarantine;
  expect(activated).toMatchObject({ state: "complete", activation: { sessionsRevoked: true, nativeReconciled: true, fenceReleased: true }, reconcile: { reconciled: true } });
  expect(existsSync(upgradeFencePath(f.rt.store.path))).toBe(false);
  // Generation fence: pre-restore sessions and stale revisions are refused.
  expect(() => f.rt.app.authenticate(staleToken)).toThrow("authentication_required");
  await relogin(f);
  expect(() => f.rt.app.execute(actor(f), { kind: "project.create", projectId: null, requestId: rid(), expectedRevision: liveRevision, payload: { name: "stale" } })).toThrow("stale_revision");
  // Restored content serves; deleted and forgotten material cannot be used; the live-only write is gone.
  expect(f.rt.app.source(actor(f), a.id, sKeep).state).toBe("available");
  expect(f.rt.app.memoryClaim(actor(f), a.id, ref(keep!)).state).toBe("available");
  expect(f.rt.app.source(actor(f), a.id, sDel).state).toBe("unavailable");
  expect(f.rt.app.memoryClaim(actor(f), a.id, ref(doomed!)).state).toBe("unavailable");
  expect(f.rt.app.memoryClaim(actor(f), a.id, ref(forgotten!))).toMatchObject({ state: "unavailable" });
  expect(() => f.rt.app.execute(actor(f), extractCommand(f, a, sDel))).toThrow("memory_source_deleted");
  expect(() => f.rt.app.execute(actor(f), extractCommand(f, a, sForget))).toThrow("memory_source_suppressed");
  // The image never had this forget; only the installation ledger knows it, and it still denies extraction.
  expect(f.rt.app.sourceSuppressed(actor(f), a.id, sLate)).toBe(true);
  expect(() => f.rt.app.execute(actor(f), extractCommand(f, a, sLate))).toThrow("memory_source_suppressed");
  expect(f.rt.app.conversation(actor(f), a.id, a.topic.id).items.some((m: { source: SourceReference }) => m.source.sourceId === sNew.sourceId)).toBe(false);
  expect(f.rt.app.deletionLedger(actor(f)).tombstones.some(t => t.sourceId === sDel.sourceId)).toBe(true);
  // No payload bytes of the deleted source survive in the activated database (freed pages included).
  expect(dbContains(f.rt.store, "restore-del-canary-002")).toBe(false);
  const quoted = f.rt.app.delivery(actor(f), a.id, quoting.intent.id);
  expect(JSON.stringify(quoted.intent.payload)).not.toContain("restore-del-canary-002");
  expect(JSON.stringify(quoted.report)).not.toContain("restore-del-canary-002");
  expect(quoted.intent.status).toBe("unknown");
  // Notification: the restored unsent report is held as unknown and never sent by a worker.
  const intentId = (pending as { intent: { id: string } }).intent.id;
  expect(f.rt.app.delivery(actor(f), a.id, intentId).intent).toMatchObject({ status: "unknown", nextAction: "inspect_restored_intent_then_resend_explicitly" });
  const worker = new DeliveryWorker(f.rt.store, { sender: { send: () => { throw new Error("restored intents must not send"); } } });
  expect(worker.pump()).toEqual([]);
  worker.close();
  // Context assembly for new work cites no removed payload.
  f.rt.app.execute(actor(f), dispatch(f, a, "งานหลังกู้คืน", [sKeep]));
  await drain(f);
  expect(f.requests.length).toBeGreaterThan(0);
  const after = f.requests.at(-1)!;
  for (const canary of ["restore-del-canary-002", "restore-forget-canary-003", "restore-late-canary-004"]) expect(after).not.toContain(canary);
  // Receipts and audit are mirrored after the swap; the journal keeps the full evidence outside the database.
  expect(f.rt.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM audit WHERE command_kind LIKE 'restore.%'")!.n)).toBe(5);
  expect(journal(f, prepared.id).steps.map(s => s.name)).toEqual(["preflight", "fence", "quiesce", "quarantine_copy", "migrate", "apply_ledger", "validate",
    "activation_intent", "activate", "generation_fence", "native_reconcile", "reconcile"]);
}, 60_000);

// ---------------------------------------------------------------------------
// Untrusted ledgers
// ---------------------------------------------------------------------------

test("missing, corrupt, incompatible or mismatched latest ledgers keep the installation quarantined; no owner payload can substitute", async () => {
  const f = await fixture();
  const a = project(f, "โครงการ ledger", "หัวข้อ ledger");
  const s1 = say(f, a, "ข้อความหนึ่ง ledger-canary-001");
  await remember(f, a, s1);
  const s2 = say(f, a, "ข้อความสอง ledger-canary-002");
  await remember(f, a, s2);
  deleteSource(f, a, s1);
  const backup = await backupNow(f);
  f.clock.now += 60_000;
  deleteSource(f, a, s2);
  const ledgerPath = ledgerCheckpointPathFor(f.rt.store.path);
  const good = readFileSync(ledgerPath, "utf8");
  expect(JSON.parse(good)).toMatchObject({ ledger: "jit.deletion.ledger/v1", contract: "app.deletion_ledger/v1" });
  const q = (await prepare(f, backup.id)).quarantine;
  await stepCmd(f, "restore.migrate", q.id);
  // An owner-supplied tombstone list is not part of the contract.
  await expect(f.rt.app.execute(actor(f), { kind: "restore.apply_ledger", requestId: rid(), projectId: null, expectedRevision: appRevision(f),
    payload: { quarantineId: q.id, tombstones: [], source: "owner", asOf: f.clock.now, acknowledgedEmpty: true } } as never)).rejects.toThrow("invalid_restore_command");
  const cases: [string, () => void, string][] = [
    ["missing", () => rmSync(ledgerPath), "ledger_checkpoint_missing"],
    ["corrupt", () => writeFileSync(ledgerPath, "{not json"), "ledger_checkpoint_unverifiable"],
    ["tampered", () => { const body = JSON.parse(good); body.entries.pop(); writeFileSync(ledgerPath, JSON.stringify(body)); }, "ledger_checkpoint_unverifiable"],
    ["incompatible", () => writeFileSync(ledgerPath, JSON.stringify({ ...JSON.parse(good), ledger: "jit.deletion.ledger/v2" })), "ledger_checkpoint_incompatible"],
    ["seed over real", () => writeFileSync(ledgerPath, JSON.stringify({ ledger: "jit.deletion.ledger/v1", revision: 1 })), "ledger_checkpoint_unverifiable"],
  ];
  for (const [, breakIt, reason] of cases) {
    breakIt();
    await expect(stepCmd(f, "restore.apply_ledger", q.id)).rejects.toThrow(reason);
    expect(journal(f, q.id)).toMatchObject({ state: "blocked", reason });
    expect(journal(f, q.id).actions).not.toContain("activate");
    await expect(stepCmd(f, "restore.activate", q.id)).rejects.toThrow("restore_bad_state");
    writeFileSync(ledgerPath, good);
  }
  // The installation database lost a ledger entry its checkpoint holds (replaced outside the restore flow).
  const removed = f.rt.store.read(tx => tx.get<{ sequence: number }>("SELECT max(sequence) AS sequence FROM lifecycle_ledger")!.sequence);
  const row = f.rt.store.read(tx => tx.get<Record<string, string | number>>("SELECT * FROM lifecycle_ledger WHERE sequence = ?", removed))!;
  f.rt.store.transaction(tx => tx.run("DELETE FROM lifecycle_ledger WHERE sequence = ?", removed));
  await expect(stepCmd(f, "restore.apply_ledger", q.id)).rejects.toThrow("ledger_checkpoint_mismatch");
  f.rt.store.transaction(tx => tx.run("INSERT INTO lifecycle_ledger VALUES (?, ?, ?, ?, ?, ?, ?)", row.sequence!, row.kind!, row.entry_key!, row.subject!, row.project_id!, row.record_json!, row.recorded_at!));
  // Restored to the verified checkpoint, the quarantine proceeds; the backup stayed recoverable throughout.
  expect((await stepCmd(f, "restore.apply_ledger", q.id)).quarantine.state).toBe("ledger_applied");
  expect((await stepCmd(f, "restore.validate", q.id)).quarantine.state).toBe("validated");
  expect(f.rt.app.backups(actor(f)).manifests.some(m => m.id === backup.id)).toBe(true);
  // Discard ends the attempt without touching live state and releases the fence.
  expect((await stepCmd(f, "restore.discard", q.id)).quarantine.state).toBe("discarded");
  expect(existsSync(upgradeFencePath(f.rt.store.path))).toBe(false);
  expect(f.rt.app.source(actor(f), a.id, s2).state).toBe("unavailable");
});

test("the backup's own ledger never proves the absence of later deletions: a re-established empty ledger keeps the restore blocked", async () => {
  const f = await fixture();
  const a = project(f, "โครงการ coverage", "หัวข้อ coverage");
  const s1 = say(f, a, "ข้อความ coverage-canary-001");
  await remember(f, a, s1);
  deleteSource(f, a, s1);
  const backup = await backupNow(f);
  // The installation ledger and its checkpoint are wiped (as if a different, fresh ledger were presented).
  f.rt.store.transaction(tx => { tx.run("DELETE FROM lifecycle_ledger"); tx.run("DELETE FROM lifecycle_checkpoint"); });
  rmSync(ledgerCheckpointPathFor(f.rt.store.path));
  const q = await restoreThrough(f, backup.id, "restore.validate");
  expect(q.state).toBe("blocked");
  expect(q.validation!.checks.find(c => c.name === "ledger_covers_backup")).toMatchObject({ pass: false });
  expect(q.report.activation.allowed).toBe(false);
  await expect(stepCmd(f, "restore.activate", q.id)).rejects.toThrow("restore_bad_state");
});

// ---------------------------------------------------------------------------
// Native sessions
// ---------------------------------------------------------------------------

test("a context deleted after the backup is deleted through the run port before workers resume; a failed delete keeps the installation fenced", async () => {
  const f = await fixture();
  const a = project(f, "โครงการ native", "หัวข้อ native");
  const s1 = say(f, a, "ข้อความ native-canary-001 ที่ถูกอ้างถึง");
  f.rt.app.execute(actor(f), dispatch(f, a, "งานที่ใช้ native session", [s1]));
  await drain(f);
  // A coordinator synthesis owns its own native context (outside team_runs).
  const discussion = f.rt.app.discussions(actor(f), a.id, a.topic.id)[0]!;
  f.rt.app.execute(actor(f), { kind: "decision.synthesize", requestId: rid(), projectId: a.id, expectedRevision: discussion.revision,
    payload: { discussionId: discussion.id, limits: { ...f.config.jobs.maximum } } });
  await drain(f);
  const synthesisContexts = () => f.rt.store.read(tx => tx.all<{ state: string }>("SELECT c.state FROM team_contexts c JOIN coordinator_syntheses s ON s.context_id = c.id WHERE s.project_id = ?", a.id));
  expect(synthesisContexts().length).toBeGreaterThan(0);
  const contexts = () => f.rt.store.read(tx => tx.all<{ id: string; state: string }>("SELECT c.id, c.state FROM team_contexts c JOIN team_runs r ON r.context_id = c.id WHERE r.project_id = ?", a.id));
  expect(contexts().length).toBeGreaterThan(0);
  const backup = await backupNow(f);
  f.clock.now += 60_000;
  f.flags.deleteFail = true;
  deleteSource(f, a, s1);
  await reconcileDeletions(f.rt.store, f.rt.port as unknown as ApplicationRunPort, f.clock.now);
  const q = await restoreThrough(f, backup.id, "restore.validate");
  expect(q.state).toBe("validated");
  expect(q.report.invalidated!.contextsScheduledForDeletion).toBeGreaterThan(0);
  const stuck = (await stepCmd(f, "restore.activate", q.id)).quarantine;
  expect(stuck).toMatchObject({ state: "activated", reason: "native_delete_pending", actions: ["activate"], activation: { nativeReconciled: false, fenceReleased: false } });
  // Still fenced: no reader/worker is enabled, nothing else is admitted; the backup stays in the registry.
  await relogin(f);
  expect(readUpgradeFence(f.rt.store.path)?.upgradeId).toBe(q.id);
  // Read-side gate: a fresh session sees only restore status and remediation, never restored read models.
  expect(() => f.rt.app.workspace(actor(f))).toThrow("restore_incomplete");
  expect(() => f.rt.app.memory(actor(f), a.id)).toThrow("restore_incomplete");
  expect(() => f.rt.app.execute(actor(f), { kind: "project.create", projectId: null, requestId: rid(), expectedRevision: 1, payload: { name: "x" } })).toThrow("restore_incomplete");
  expect(f.rt.app.restoreConsole(actor(f)).gatedBy).toBe(q.id);
  const web = createWebHandler(f.rt.app);
  const home = await web(new Request("http://localhost:3000/", { headers: { cookie: `jit_session=${f.token}` } }));
  expect([home.status, home.headers.get("location")]).toEqual([303, "/restores"]);
  const consolePage = await web(new Request("http://localhost:3000/restores", { headers: { cookie: `jit_session=${f.token}` } }));
  expect(consolePage.status).toBe(200);
  expect(await consolePage.text()).not.toContain("โครงการ native");
  const memoryApi = await web(new Request(`http://localhost:3000/api/projects/${a.id}/memory`, { headers: { cookie: `jit_session=${f.token}` } }));
  expect(memoryApi.status).toBe(423);
  expect(f.rt.app.backups(actor(f)).manifests.some(m => m.id === backup.id)).toBe(true);
  // Exhausting the managed-delete budget never releases the fence: a failed operation still holding native data blocks.
  for (let i = 0; i < 6; i++) expect((await stepCmd(f, "restore.activate", q.id)).quarantine).toMatchObject({ state: "activated", reason: "native_delete_pending" });
  expect(f.rt.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM deletion_operations WHERE state = 'failed'")!.n)).toBeGreaterThan(0);
  expect(journal(f, q.id).report.pending.nativeDeletesPending).toBeGreaterThan(0);
  expect(readUpgradeFence(f.rt.store.path)?.upgradeId).toBe(q.id);
  expect(readRestoreGate(f.rt.store.path)).toBe(q.id);
  // A restart keeps it fenced and retries under the fence at boot.
  await restart(f);
  expect(journal(f, q.id)).toMatchObject({ state: "activated", reason: "native_delete_pending" });
  f.flags.deleteFail = false;
  const done = (await stepCmd(f, "restore.activate", q.id)).quarantine;
  expect(done.state).toBe("complete");
  expect(contexts().every(c => c.state === "deleted")).toBe(true);
  expect(synthesisContexts().every(c => c.state === "deleted")).toBe(true);
  expect(f.rt.app.restoreConsole(actor(f)).gatedBy).toBeNull();
  expect(f.rt.app.workspace(actor(f)).projects.length).toBeGreaterThan(0);
  expect(existsSync(upgradeFencePath(f.rt.store.path))).toBe(false);
}, 60_000);

// ---------------------------------------------------------------------------
// Crash at every boundary
// ---------------------------------------------------------------------------

test("crash at every restore boundary is recovered from durable intent and ends complete with the ledger applied", async () => {
  for (const point of ["fenced", "quiesced", "staged_copy", "migrated", "ledger_applied", "validated",
    "activation_intent", "swapped", "activated", "native_reconciled", "reconciled"] as RestoreFaultPoint[]) {
    const f = await fixture();
    const a = project(f, `โครงการ crash ${point}`, "หัวข้อ crash");
    const s1 = say(f, a, `ข้อความ crash-canary-${point}-001`);
    await remember(f, a, s1);
    const backup = await backupNow(f);
    deleteSource(f, a, s1);
    f.flags.fault = point;
    let id: string | null = null;
    try { await restoreThrough(f, backup.id); throw new Error(`no crash at ${point}`); }
    catch (error) { expect(error).toBeInstanceOf(SimulatedRestoreCrash); }
    await restart(f);
    await relogin(f);
    const [latest] = f.rt.app.restores(actor(f)).quarantines.slice(-1);
    id = latest!.id;
    if (["fenced", "quiesced", "staged_copy"].includes(point)) {
      // Prepare never touched live: the attempt fails, the fence is released and a new prepare works.
      expect(latest).toMatchObject({ state: "failed", reason: "prepare_interrupted" });
      expect(existsSync(upgradeFencePath(f.rt.store.path))).toBe(false);
      id = (await restoreThrough(f, backup.id)).id;
    } else if (["swapped", "activated", "native_reconciled", "reconciled"].includes(point)) {
      // The swap happened: boot completed the activation under the fence before admission.
      expect(latest!.state).toBe("complete");
    } else {
      expect(latest!.state).toBe(point === "activation_intent" ? "validated" : point === "migrated" ? "migrated" : point === "ledger_applied" ? "ledger_applied" : "validated");
      const order: Step[] = ["restore.migrate", "restore.apply_ledger", "restore.validate", "restore.activate"];
      const from = { migrated: 1, ledger_applied: 2, validated: 3, activation_intent: 3 }[point as "migrated"]!;
      for (const kind of order.slice(from)) await stepCmd(f, kind, id);
    }
    await relogin(f);
    expect(journal(f, id).state).toBe("complete");
    expect(f.rt.app.source(actor(f), a.id, s1).state).toBe("unavailable");
    expect(dbContains(f.rt.store, `crash-canary-${point}-001`)).toBe(false);
    expect(existsSync(upgradeFencePath(f.rt.store.path))).toBe(false);
    expect(f.rt.app.backups(actor(f)).manifests.some(m => m.id === backup.id)).toBe(true);
  }
}, 240_000);

// ---------------------------------------------------------------------------
// Jobs, attempts and outbox
// ---------------------------------------------------------------------------

test("restored pending jobs, in-flight attempts and unknown outbox are fenced, never replayed; failed reconciliation stays fenced until boot", async () => {
  const f = await fixture();
  const a = project(f, "โครงการ pending", "หัวข้อ pending");
  const s1 = say(f, a, "pending 001 ข้อความ");
  // An attempt that is running while the backup is taken.
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.hooks.specialist = async (request, signal) => {
    await Promise.race([gate, new Promise(resolve => signal.addEventListener("abort", resolve))]);
    return fixtureOutcome("complete", withContextAnswer("ช้า", request, f.config.jobs.outputBytes));
  };
  f.rt.app.execute(actor(f), dispatch(f, a, "งานที่กำลังทำตอนสำรอง", [s1]));
  for (let i = 0; i < 50 && !f.rt.store.read(tx => tx.get("SELECT 1 FROM jobs WHERE state = 'admitted' AND json_extract(record_json, '$.type') != 'team.discussion.plan'")); i++) {
    queue(f).pump(); await new Promise(resolve => setTimeout(resolve, 2));
  }
  const delivery = f.rt.app.execute(actor(f), { kind: "delivery.commit", requestId: rid(), projectId: a.id, expectedRevision: projectRevision(f, a),
    payload: { kind: "report", text: "รายงาน outbox ที่ผลไม่แน่ชัด", dedupeKey: "outbox-unknown-1" } }) as { intent: { id: string } };
  f.rt.store.transaction(tx => {
    const row = tx.get<{ record_json: string }>("SELECT record_json FROM delivery_intents WHERE id = ?", delivery.intent.id)!;
    tx.run("UPDATE delivery_intents SET record_json = ? WHERE id = ?", JSON.stringify({ ...JSON.parse(row.record_json), status: "unknown", remote: "uncertain" }), delivery.intent.id);
  });
  const backup = await backupNow(f);
  const image = new Database(backup.artifact.path, { readonly: true });
  const inFlight = (image.query("SELECT record_json FROM job_attempts WHERE json_extract(record_json, '$.state') IN ('prepared', 'dispatched')").all() as { record_json: string }[])
    .map(r => JSON.parse(r.record_json) as JobAttempt);
  const queuedInImage = (image.query("SELECT id FROM jobs WHERE state IN ('queued', 'admitted', 'waiting')").all() as { id: string }[]).map(r => r.id);
  image.close();
  expect(inFlight.length).toBeGreaterThan(0);
  release();
  f.hooks.specialist = f.defaults.specialist;
  await drain(f);
  const q = await restoreThrough(f, backup.id, "restore.validate");
  expect(q.state).toBe("validated");
  expect(q.report.invalidated!.attemptsFenced).toBeGreaterThan(0);
  expect(q.validation!.pendingJobs.length).toBe(queuedInImage.length);
  expect(q.validation!.pendingJobs.every(j => j.state === "waiting" && j.reason === "interrupted")).toBe(true);
  expect(q.validation!.unknownOutbox).toBe(1);
  // Reconciliation cannot run (scheduler/port composition unavailable): activated but still fenced, nothing admitted.
  f.flags.failCompose = true;
  const pendingResume = (await stepCmd(f, "restore.activate", q.id)).quarantine;
  expect(pendingResume).toMatchObject({ state: "activated", reason: "native_delete_pending", activation: { fenceReleased: false } });
  expect(readUpgradeFence(f.rt.store.path)?.upgradeId).toBe(q.id);
  f.flags.failCompose = false;
  await restart(f);
  await relogin(f);
  expect(journal(f, q.id).state).toBe("complete");
  // Nothing restored ran by itself, and stale pre-restore attempts cannot commit.
  await drain(f);
  const jobs = f.rt.app.jobs(actor(f), a.id).items;
  for (const id of queuedInImage) expect(jobs.find(j => j.id === id)).toMatchObject({ state: "waiting", reason: "interrupted" });
  for (const attempt of inFlight) {
    const current = f.rt.store.read(tx => tx.get<{ record_json: string }>("SELECT record_json FROM job_attempts WHERE id = ?", attempt.id))!;
    expect((JSON.parse(current.record_json) as JobAttempt).state).toBe("interrupted");
    expect(f.rt.store.read(tx => attemptAuthority(tx, attempt, f.clock.now))).not.toBeNull();
  }
  expect(f.rt.app.delivery(actor(f), a.id, delivery.intent.id).intent.status).toBe("unknown");
}, 60_000);

// ---------------------------------------------------------------------------
// Version fixtures through the migration contract
// ---------------------------------------------------------------------------

/** Rewrites a backup's image to a historical schema and re-registers its hash (fixture for older releases). */
function historicalBackup(f: Fixture, backupId: string, version: number, extra = "") {
  const manifest = f.rt.app.backup(actor(f), backupId).manifest;
  const db = new Database(manifest.artifact.path);
  for (const trigger of ["lifecycle_ledger_deletion", "lifecycle_ledger_suppression", "lifecycle_ledger_suppressed_claim", "lifecycle_ledger_suppressed_source"]) db.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
  for (const table of ["lifecycle_ledger", "lifecycle_checkpoint"]) db.exec(`DROP TABLE IF EXISTS ${table}`);
  if (version < 22) { /* Schema 22 only rebuilds pr_reports, created lazily. */ }
  if (version < 21) db.exec("DROP TABLE IF EXISTS schway_native_refs");
  if (extra) db.exec(extra);
  db.exec(`PRAGMA user_version = ${version};`);
  db.close();
  const bytes = readFileSync(manifest.artifact.path);
  const hash = createHash("sha256").update(bytes).digest("hex");
  f.rt.store.transaction(tx => tx.run("UPDATE ops_backups SET record_json = json_set(record_json, '$.appSchema', ?, '$.artifact.hash', ?, '$.artifact.bytes', ?) WHERE id = ?",
    version, hash, bytes.length, backupId));
}

test("supported older images migrate inside quarantine; unsupported, failed or engine-incompatible images never activate and keep the backup", async () => {
  const f = await fixture();
  const a = project(f, "โครงการ version", "หัวข้อ version");
  const s1 = say(f, a, "ข้อความ version-canary-001");
  await remember(f, a, s1);
  const supported = await backupNow(f);
  const failing = await backupNow(f);
  const newer = await backupNow(f);
  deleteSource(f, a, s1);
  historicalBackup(f, supported.id, 21);
  historicalBackup(f, failing.id, 21, "DROP TABLE memory_suppressed_claims");
  // Newer than this build: refused before any fence, with a failed journal and a next action.
  f.rt.store.transaction(tx => tx.run("UPDATE ops_backups SET record_json = json_set(record_json, '$.appSchema', 99) WHERE id = ?", newer.id));
  await expect(prepare(f, newer.id)).rejects.toThrow("newer_backup_unsupported");
  expect(f.rt.app.restores(actor(f)).quarantines.find(q => q.backupId === newer.id))
    .toMatchObject({ state: "failed", reason: "newer_backup_unsupported", nextAction: "keep_backup_and_restore_with_a_build_supporting_its_schema" });
  f.rt.store.transaction(tx => tx.run("UPDATE ops_backups SET record_json = json_set(record_json, '$.appSchema', 3) WHERE id = ?", newer.id));
  await expect(prepare(f, newer.id)).rejects.toThrow("backup_unrestorable");
  // Same schema, newer producing build: refused by the app-version gate before any fence.
  f.rt.store.transaction(tx => tx.run("UPDATE ops_backups SET record_json = json_set(record_json, '$.appSchema', ?, '$.jitVersion', 'jit/999.0.0') WHERE id = ?", schemaVersion, newer.id));
  await expect(prepare(f, newer.id)).rejects.toThrow("newer_app_unsupported");
  expect(f.rt.app.restores(actor(f)).quarantines.some(q => q.backupId === newer.id && q.reason === "newer_app_unsupported" && q.compat.jitVersion.compatible === false)).toBe(true);
  expect(existsSync(upgradeFencePath(f.rt.store.path))).toBe(false);
  // Failed staged migration blocks the quarantine; live and the backup stay intact.
  const broken = (await prepare(f, failing.id)).quarantine;
  expect(broken.compat).toMatchObject({ action: "migrate", backupSchema: 21 });
  await expect(stepCmd(f, "restore.migrate", broken.id)).rejects.toThrow("quarantine_migration_failed");
  expect(journal(f, broken.id)).toMatchObject({ state: "blocked", actions: ["migrate", "discard"] });
  await expect(stepCmd(f, "restore.activate", broken.id)).rejects.toThrow("restore_bad_state");
  await stepCmd(f, "restore.discard", broken.id);
  expect(f.rt.app.backups(actor(f)).manifests.map(m => m.id)).toContain(failing.id);
  // Supported older image: staged migration with row preservation, then the latest ledger.
  const q = await restoreThrough(f, supported.id, "restore.validate");
  expect(q.steps.find(s => s.name === "migrate")!.detail).toBe(`schema_21_to_${schemaVersion}`);
  expect(q.state).toBe("validated");
  const done = (await stepCmd(f, "restore.activate", q.id)).quarantine;
  expect(done.state).toBe("complete");
  await relogin(f);
  expect(f.rt.store.read(tx => tx.get<{ user_version: number }>("PRAGMA user_version")!.user_version)).toBe(schemaVersion);
  expect(f.rt.app.source(actor(f), a.id, s1).state).toBe("unavailable");
}, 60_000);

test("a verified backup whose native references use an unsupported engine contract is refused before any fence", async () => {
  const legacy = "legacy.snapshot/v9";
  const bytes = new TextEncoder().encode("opaque-native-bytes"), nativeId = crypto.randomUUID();
  const port: BackupNativePort = { engine: "legacy-engine/0", contract: legacy, formatVersion: 1, available: () => true,
    snapshot: () => ({ refs: [{ id: nativeId, generation: 1 }], bytes: bytes.length, engine: "legacy-engine/0", contract: legacy, formatVersion: 1,
      artifacts: [{ name: "legacy-0", bytes, sha256: createHash("sha256").update(bytes).digest("hex") }] }) };
  const f = await fixture(port);
  project(f, "โครงการ engine", "หัวข้อ engine");
  const backup = await backupNow(f);
  expect([backup.state, backup.reason, f.rt.app.backup(actor(f), backup.id).integrity.state]).toEqual(["valid", null, "verified"]);
  await expect(prepare(f, backup.id)).rejects.toThrow("unsupported_engine");
  expect(f.rt.app.restores(actor(f)).quarantines.find(q => q.backupId === backup.id))
    .toMatchObject({ state: "failed", reason: "unsupported_engine", compat: { engine: { nativeRefs: 1, backupContract: legacy, compatible: false } } });
  expect(existsSync(upgradeFencePath(f.rt.store.path))).toBe(false);
  expect(f.rt.app.backups(actor(f)).manifests.some(m => m.id === backup.id)).toBe(true);
});

// ---------------------------------------------------------------------------
// Mutual exclusion, service packaging and Web
// ---------------------------------------------------------------------------

test("an external integration revoked after the backup is never silently re-enabled by the restore", async () => {
  const f = await fixture();
  project(f, "โครงการ integration", "หัวข้อ integration");
  f.rt.store.transaction(tx => tx.run("UPDATE telegram_binding SET revision = 2, state = 'bound', telegram_user_id = 11, telegram_chat_id = 22, bound_at = ? WHERE id = 1", f.clock.now));
  const backup = await backupNow(f);
  f.rt.store.transaction(tx => tx.run("UPDATE telegram_binding SET revision = 3, state = 'unbound', telegram_user_id = NULL, telegram_chat_id = NULL, bound_at = NULL WHERE id = 1"));
  const q = await restoreThrough(f, backup.id);
  expect(q.state).toBe("complete");
  expect(q.report.invalidated!.telegramBinding).toBe("adopted_live");
  expect(f.rt.store.read(tx => tx.get<{ state: string; telegram_chat_id: number | null }>("SELECT state, telegram_chat_id FROM telegram_binding WHERE id = 1")))
    .toEqual({ state: "unbound", telegram_chat_id: null });
});

test("a run record without a valid manifest is treated as unknown: its context is deleted before service resumes", async () => {
  const f = await fixture();
  const a = project(f, "โครงการ opaque", "หัวข้อ opaque");
  const s1 = say(f, a, "ข้อความ opaque-canary-001");
  f.rt.app.execute(actor(f), dispatch(f, a, "งานเก่าไม่มี manifest", [s1]));
  await drain(f);
  // Legacy/damaged records: what they cited cannot be proven.
  f.rt.store.transaction(tx => tx.run("UPDATE team_runs SET record_json = json_object('id', id) WHERE project_id = ?", a.id));
  const backup = await backupNow(f);
  const q = await restoreThrough(f, backup.id, "restore.validate");
  expect(q.state).toBe("validated");
  expect(q.report.invalidated!.contextsUnknownCitation).toBeGreaterThan(0);
  expect(q.report.invalidated!.contextsScheduledForDeletion).toBeGreaterThan(0);
  expect((await stepCmd(f, "restore.activate", q.id)).quarantine.state).toBe("complete");
  await relogin(f);
  const states = f.rt.store.read(tx => tx.all<{ state: string }>("SELECT c.state FROM team_contexts c JOIN team_runs r ON r.context_id = c.id WHERE r.project_id = ?", a.id));
  expect(states.length).toBeGreaterThan(0);
  expect(states.every(c => c.state === "deleted")).toBe(true);
});

test("a failed service resume re-acquires the fence: nothing is admitted or readable until reconciliation succeeds", async () => {
  const f = await fixture();
  const a = project(f, "โครงการ resume", "หัวข้อ resume");
  say(f, a, "ข้อความ resume-001");
  const backup = await backupNow(f);
  f.flags.failResume = true;
  const q = await restoreThrough(f, backup.id);
  expect(q).toMatchObject({ state: "activated", reason: "reconcile_pending", activation: { nativeReconciled: true, fenceReleased: false } });
  expect(readUpgradeFence(f.rt.store.path)?.upgradeId).toBe(q.id);
  expect(readRestoreGate(f.rt.store.path)).toBe(q.id);
  await relogin(f);
  expect(() => f.rt.app.execute(actor(f), { kind: "project.create", projectId: null, requestId: rid(), expectedRevision: appRevision(f), payload: { name: "x" } })).toThrow("restore_incomplete");
  // A crash right after releasing the fence is re-fenced on reopen (durable intent wins), then completed at boot.
  f.flags.failResume = false;
  f.flags.fault = "reconciled";
  await expect(stepCmd(f, "restore.activate", q.id)).rejects.toBeInstanceOf(SimulatedRestoreCrash);
  await restart(f);
  await relogin(f);
  expect(journal(f, q.id).state).toBe("complete");
  expect(existsSync(upgradeFencePath(f.rt.store.path))).toBe(false);
  expect(readRestoreGate(f.rt.store.path)).toBeNull();
});

test("the shared fence is acquired exclusively: two processes racing restore against upgrade yield exactly one holder", async () => {
  const root = mkdtempSync(join(tmpdir(), "jit-fence-race-")); roots.push(root);
  const db = join(root, "state.sqlite"), barrier = join(root, "go");
  for (let round = 0; round < 3; round++) {
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    const workers = ids.map((id, i) => Bun.spawn(["bun", join(import.meta.dir, "fence-race-worker.ts"), db, id, i === 0 ? "restore" : "upgrade", barrier], { stdout: "pipe", stderr: "pipe" }));
    await new Promise(resolve => setTimeout(resolve, 150));
    writeFileSync(barrier, "go");
    const results = await Promise.all(workers.map(async w => { await w.exited; return JSON.parse((await new Response(w.stdout).text()).trim()) as { id: string; won: boolean; code?: string }; }));
    const winners = results.filter(r => r.won);
    expect(winners).toHaveLength(1);
    expect(results.find(r => !r.won)!.code).toMatch(/^(restore|upgrade)_in_progress$/);
    expect(readUpgradeFence(db)?.upgradeId).toBe(winners[0]!.id);
    // The loser can neither overwrite nor clear the winner's claim.
    const loser = results.find(r => !r.won)!.id;
    expect(() => writeUpgradeFence(db, loser, 2, "upgrade")).toThrow(/_in_progress/);
    clearUpgradeFence(db, loser);
    expect(readUpgradeFence(db)?.upgradeId).toBe(winners[0]!.id);
    clearUpgradeFence(db, winners[0]!.id);
    expect(readUpgradeFence(db)).toBeNull();
    rmSync(barrier);
  }
});

test("restore and upgrade exclude each other through the one durable fence", async () => {
  const f = await fixture();
  project(f, "โครงการ exclusive", "หัวข้อ exclusive");
  const backup = await backupNow(f);
  const q = (await prepare(f, backup.id)).quarantine;
  await expect(f.rt.app.execute(actor(f), { kind: "upgrade.prepare", requestId: rid(), projectId: null, expectedRevision: appRevision(f),
    payload: { targetSchema: schemaVersion, note: "during restore" } })).rejects.toThrow("restore_in_progress");
  await stepCmd(f, "restore.discard", q.id);
  const upgrade = (await f.rt.app.execute(actor(f), { kind: "upgrade.prepare", requestId: rid(), projectId: null, expectedRevision: appRevision(f),
    payload: { targetSchema: schemaVersion, note: "no-op upgrade" } })).journal;
  expect(upgrade.state).toBe("prepared");
  await expect(prepare(f, backup.id)).rejects.toThrow("upgrade_in_progress");
  await f.rt.app.execute(actor(f), { kind: "upgrade.rollback", requestId: rid(), projectId: null, expectedRevision: appRevision(f), payload: { upgradeId: upgrade.id } });
  expect((await prepare(f, backup.id)).quarantine.state).toBe("quarantined");
});

test("lifecycle ledger: trigger entries commit with the lifecycle change; the checkpoint is established, extended and binds the service ledger path", async () => {
  const f = await fixture();
  const a = project(f, "โครงการ checkpoint", "หัวข้อ checkpoint");
  const s1 = say(f, a, "ข้อความ checkpoint-canary-001");
  const [claim] = await remember(f, a, s1);
  const path = ledgerCheckpointPathFor(f.rt.store.path);
  const beforeText = readFileSync(path, "utf8");
  const before = JSON.parse(beforeText) as { count: number; revision: number };
  expect(before).toMatchObject({ count: 0, revision: 1 });
  forget(f, a, claim!);
  const after = JSON.parse(readFileSync(path, "utf8")) as { count: number; entries: { kind: string; record: Record<string, unknown> }[] };
  expect(after.entries.map(e => e.kind)).toEqual(expect.arrayContaining(["suppression", "suppressed_claim", "suppressed_source"]));
  // Identity only: neither the owner's reason nor any payload text enters the ledger.
  expect(JSON.stringify(after)).not.toContain("เจ้าของขอให้ลืม");
  expect(JSON.stringify(after)).not.toContain("checkpoint-canary-001");
  // A rolled-back lifecycle transaction leaves no ledger entry.
  const count = f.rt.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM lifecycle_ledger")!.n);
  expect(() => f.rt.store.transaction(tx => {
    tx.run("INSERT INTO deletion_ledger (id, operation_id, project_id, kind, source_id, claim_id, revision, generation, deleted_at) VALUES (?, 'op', ?, 'source', ?, NULL, 1, 1, 1)", rid(), a.id, s1.sourceId);
    throw new Error("rollback");
  })).toThrow("rollback");
  expect(f.rt.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM lifecycle_ledger")!.n)).toBe(count);
  expect(syncLedgerCheckpoint(f.rt.store, path, f.clock.now)).toMatchObject({ state: "trusted", count });
  // An older, internally valid checkpoint copy put back over the established one is stale, not a lag to extend.
  const current = readFileSync(path, "utf8");
  writeFileSync(path, beforeText);
  expect(syncLedgerCheckpoint(f.rt.store, path, f.clock.now)).toMatchObject({ state: "untrusted", reason: "ledger_checkpoint_mismatch" });
  writeFileSync(path, current);
  // Service packaging: the configured ledgerPath must carry the verified checkpoint; a diverged one quarantines.
  const service = serviceFor(f.root);
  f.rt.service.close(); await f.rt.service.queue?.idle();
  // The installation already checkpointed at its default location: a seed at a new location cannot
  // re-establish authority from database contents (relocation must carry the verified checkpoint).
  const seeded = await startFullApp({ config: f.config, service, store: f.rt.store, now: () => f.clock.now });
  expect(seeded).toMatchObject({ ok: false, gates: [{ gate: "quarantine", detail: "lifecycle ledger ledger_checkpoint_relocation_unverified" }] });
  rmSync(service.ledgerPath);
  expect(await startFullApp({ config: f.config, service, store: f.rt.store, now: () => f.clock.now })).toMatchObject({ ok: false });
  writeFileSync(service.ledgerPath, readFileSync(path));
  const moved = await startFullApp({ config: f.config, service, store: f.rt.store, now: () => f.clock.now });
  expect(moved.ok ? "ok" : JSON.stringify(moved.gates)).toBe("ok");
  if (moved.ok) moved.handle.service.close();
  expect(JSON.parse(readFileSync(service.ledgerPath, "utf8"))).toMatchObject({ ledger: "jit.deletion.ledger/v1", count });
  const body = JSON.parse(readFileSync(service.ledgerPath, "utf8"));
  writeFileSync(service.ledgerPath, JSON.stringify({ ...body, head: body.head + 5 }));
  const blocked = await startFullApp({ config: f.config, service, store: f.rt.store, now: () => f.clock.now });
  expect(blocked).toMatchObject({ ok: false, gates: [{ gate: "quarantine", state: "blocked" }] });
});

function serviceFor(root: string): ServiceConfig {
  for (const dir of ["release", "work", "state", "backup"]) mkdirSync(join(root, dir), { recursive: true, mode: 0o700 });
  const ledger = join(root, "state", "ledger.json");
  writeFileSync(ledger, JSON.stringify({ ledger: "jit.deletion.ledger/v1", revision: 1 }) + "\n", { mode: 0o600 });
  return { serviceUser: "jit-service", executablePath: join(root, "release"), workingDirectory: join(root, "work"),
    stateDirectory: join(root, "state"), ledgerPath: ledger, backupDirectory: join(root, "backup"), routes: [], secretRefs: [],
    network: { bindHost: "127.0.0.1", port: 3443, vpnInterface: null },
    resources: { memoryMaxBytes: 536870912, maxRestarts: 3, restartWindowSeconds: 300, logBytes: 1048576, retentionDays: 30 } };
}

test("web restore inventory, report and actions render sanitized evidence; activation sends the browser to sign in again", async () => {
  const f = await fixture();
  const a = project(f, "โครงการ web restore", "หัวข้อ web");
  say(f, a, "web-canary-restore-007");
  const backup = await backupNow(f);
  f.clock.now += 60_000;
  const web = createWebHandler(f.rt.app);
  const req = (path: string, method = "GET", body?: unknown) => new Request(`http://localhost:3000${path}`, { method,
    headers: { cookie: `jit_session=${f.token}`, ...(body ? { origin: "http://localhost:3000", "x-csrf-token": f.rt.app.authenticate(f.token).csrf, "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const prepared = await (await web(req("/api/restores", "POST", { requestId: rid(), expectedRevision: appRevision(f), backupId: backup.id, note: "web" }))).json() as { quarantine: RestoreEvidence };
  expect(prepared.quarantine.state).toBe("quarantined");
  const rejected = await web(req(`/api/restores/${prepared.quarantine.id}`, "POST", { requestId: rid(), expectedRevision: appRevision(f), action: "apply_ledger", tombstones: "[]" }));
  expect(rejected.status).toBe(400);
  for (const action of ["migrate", "apply_ledger", "validate"]) {
    const response = await web(req(`/api/restores/${prepared.quarantine.id}`, "POST", { requestId: rid(), expectedRevision: appRevision(f), action }));
    expect(response.status).toBe(200);
  }
  const list = await web(req("/restores"));
  expect(list.status).toBe(200);
  const html = await list.text();
  expect(html).toContain(prepared.quarantine.id);
  expect(html).toContain("ledger ของ installation เชื่อถือได้");
  expect(html).not.toContain("web-canary-restore-007");
  expect(html).not.toContain(f.token);
  const detail = await (await web(req(`/restores/${prepared.quarantine.id}`))).text();
  expect(detail).toContain("ops.quarantined_restore/v1");
  expect(detail).toContain("พร้อม activate");
  expect(detail).not.toContain("web-canary-restore-007");
  const api = await (await web(req(`/api/restores/${prepared.quarantine.id}`))).json() as { quarantine: RestoreEvidence };
  expect(api.quarantine.report.activation.allowed).toBe(true);
  expect(JSON.stringify(api)).not.toContain(f.token);
  const form = new URLSearchParams({ csrf: f.rt.app.authenticate(f.token).csrf, requestId: rid(), expectedRevision: String(appRevision(f)), action: "activate" });
  const activated = await web(new Request(`http://localhost:3000/restores/${prepared.quarantine.id}`, { method: "POST",
    headers: { cookie: `jit_session=${f.token}`, origin: "http://localhost:3000", "content-type": "application/x-www-form-urlencoded" }, body: form }));
  expect(activated.status).toBe(303);
  expect(activated.headers.get("location")).toBe("/login");
  expect((await web(req("/restores"))).status).not.toBe(200);
}, 60_000);
