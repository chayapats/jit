import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Application, type OwnerActor } from "../src/application";
import { readConfig } from "../src/config";
import {
  defaultExportRoot, prepareDeletionPreview, readDeletionLedger, reconcileDeletions, reconstructLegacyExportScopes,
  type DeleteScope, type DeletionConfirmReceipt, type DeletionOperation, type DeletionReceipt,
} from "../src/memory/delete";
import { memoryExtractionMarker, memoryExtractionWork, scriptedMemoryResult } from "../src/memory/extract";
import type { ClaimReference, MemoryClaim } from "../src/memory/types";
import type { SourceReference } from "../src/sources";
import { JobQueue } from "../src/jobs/queue";
import { ScriptedRunPort, fixtureOutcome, withContextAnswer } from "../src/team/scripted-port";
import type { ApplicationRunPort } from "../src/team/run-port";
import type { ApplicationRunRequest, RoleRoute, TeamCommand } from "../src/team/types";
import { coordinatorSynthesisMarker, coordinatorSynthesisWork } from "../src/team/decisions";
import { discussionPlanWork, specialistAnalysisWork } from "../src/team/dispatch";
import { SchwayRunPort } from "../src/team/schway-port";
import type { Model } from "schway/host";
import { TransactionStore, type AppTransaction } from "../src/store";
import { deletedSource } from "../src/memory/read";
import { commitOutputSource } from "../src/sources";
import { readExportArtifact } from "../src/ops/export";
import { createWebHandler } from "../src/web";
import { registerTaskEvidenceArtifact } from "../src/tasks";

const roots: string[] = [], stores: TransactionStore[] = [], live: JobQueue[] = [];
afterEach(async () => {
  for (const q of live.splice(0)) { q.close(); await q.idle(); }
  for (const s of stores.splice(0)) s.close();
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});
const rid = () => crypto.randomUUID(), epoch = 1800000000000, password = "memory-delete-owner-password";
const grok: RoleRoute = { provider: "grok", model: "fixture-grok-exact", authRoute: "owner-grok" };
type Script = (request: ApplicationRunRequest, signal: AbortSignal) => unknown | Promise<unknown>;
type Config = ReturnType<typeof readConfig>;
const asPreview = (value: unknown): DeletionReceipt => value as DeletionReceipt;
const asConfirmed = (value: unknown): DeletionConfirmReceipt => value as DeletionConfirmReceipt;

function boot(config: Config, hooks: { extract: Script; specialist: Script }, clock: { now: number }, flags: { retire: boolean; deleteFail: boolean }, backupDir: string, concrete = false) {
  const store = new TransactionStore(config.databasePath); stores.push(store);
  const script = (request: ApplicationRunRequest, signal: AbortSignal, observe: (event: never) => void) =>
    request.instructions.operator.includes(memoryExtractionMarker) ? hooks.extract(request, signal)
      : request.instructions.operator.includes(coordinatorSynthesisMarker) ? fixtureOutcome("complete", JSON.stringify(synthesisJson(request)))
      : hooks.specialist(request, signal);
  const port = new ScriptedRunPort(store, config.team, config.jobs.outputBytes, script, () => flags.deleteFail, () => flags.retire);
  // Concrete mode runs specialists through the real SchwayRunPort with an in-process fixture model (no network/accounts).
  const teamPort: ApplicationRunPort = concrete
    ? new SchwayRunPort(store, config.team, config.jobs.outputBytes, { model: scriptedModel("วิเคราะห์ผ่านสะพานจริง concrete-output-321") }) : port;
  const now = () => clock.now;
  const queue = new JobQueue(store, config.jobs, [memoryExtractionWork(store, config, port, now), discussionPlanWork(),
    specialistAnalysisWork(store, config, teamPort, now), coordinatorSynthesisWork(store, config, port, now)], { now }); live.push(queue);
  const nativeSnapshot = { available: () => true, snapshot: () => ({ refs: [] as { id: string; generation: number }[], bytes: 128, engine: "scripted-fixture-v1" }) };
  const app = new Application(store, config, { jobs: queue, now, backupDir, nativeSnapshot });
  return { store, port, teamPort, queue, app };
}

function synthesisJson(request: ApplicationRunRequest) {
  const citations = request.manifest.sources.map(source => ({ ...source.reference }));
  return { question: "เจ้าของจะเลือกทางใด", disagreement: false, consensus: true, options: [
    { id: "first", label: "ทางแรก", rationale: "ตามผลวิเคราะห์", citations },
    { id: "second", label: "ทางที่สอง", rationale: "ทางเลือกสำรอง", citations },
  ] };
}

async function fixture(options: { concrete?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "jit-mem05-")); roots.push(root);
  const concrete = options.concrete ?? false;
  const config = readConfig({ JIT_DATABASE: join(root, "state.sqlite") }), clock = { now: epoch }, flags = { retire: false, deleteFail: false };
  const defaults = {
    extract: ((request: ApplicationRunRequest) => scriptedMemoryResult(request, true)) as Script,
    specialist: ((request: ApplicationRunRequest) => fixtureOutcome("complete", withContextAnswer("ตอบจำลอง", request, config.jobs.outputBytes))) as Script,
  };
  const hooks = { ...defaults };
  const rt = boot(config, hooks, clock, flags, join(root, "backups"), concrete);
  await rt.app.setupOwner(password);
  const f = { root, config, clock, flags, hooks, defaults, rt, concrete, token: await rt.app.login(password), roles: { tech: "", coordinator: "" } };
  const owner = rt.app.authenticate(f.token).actor;
  f.roles.tech = rt.app.execute(owner, { kind: "role.save", projectId: null, requestId: rid(), expectedRevision: rt.app.team(owner).ownerRevision,
    payload: { roleId: null, name: "เทคโนโลยี", kind: "specialist", responsibility: "วิเคราะห์ฐานข้อมูลและโครงสร้างซอฟต์แวร์", enabled: true, route: grok } }).role!.id;
  f.roles.coordinator = rt.app.execute(owner, { kind: "role.save", projectId: null, requestId: rid(), expectedRevision: rt.app.team(owner).ownerRevision,
    payload: { roleId: null, name: "ผู้ประสานงาน", kind: "coordinator", responsibility: "สรุปความเห็นต่างให้เจ้าของตัดสิน", enabled: true, route: grok } }).role!.id;
  return f;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const actor = (f: Fixture) => f.rt.app.authenticate(f.token).actor;
async function restart(f: Fixture) {
  f.rt.queue.close(); await f.rt.queue.idle(); live.splice(live.indexOf(f.rt.queue), 1);
  f.rt.store.close(); stores.splice(stores.indexOf(f.rt.store), 1);
  f.rt = boot(f.config, f.hooks, f.clock, f.flags, join(f.root, "backups"), f.concrete);
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
const claims = (f: Fixture, p: Project): MemoryClaim[] => f.rt.app.memory(actor(f), p.id).items.flatMap(item => item.state === "available" ? [item.claim] : []);
const ref = (claim: ClaimReference): ClaimReference => ({ claimId: claim.claimId, revision: claim.revision, generation: claim.generation });
function extractCommand(f: Fixture, p: Project, source: SourceReference, dependencies: ClaimReference[] = []) {
  return { kind: "memory.extract" as const, requestId: rid(), projectId: p.id, expectedRevision: projectRevision(f, p),
    payload: { topicId: p.topic.id, roleId: f.roles.tech, source, dependencies, limits: { ...f.config.jobs.maximum } } };
}
async function remember(f: Fixture, p: Project, source: SourceReference): Promise<MemoryClaim[]> {
  const before = new Set(claims(f, p).map(claim => claim.claimId));
  f.rt.app.execute(actor(f), extractCommand(f, p, source)); await drain(f);
  return claims(f, p).filter(claim => !before.has(claim.claimId));
}
function previewCommand(f: Fixture, p: Project, source: SourceReference, requestId = rid()) {
  const scope: DeleteScope = { kind: "source", projectId: p.id, source: { ...source } };
  return { kind: "memory.delete.preview" as const, requestId, projectId: p.id, expectedRevision: projectRevision(f, p), payload: { scope } };
}
function confirmCommand(f: Fixture, p: Project, previewId: string, acknowledged = true, acknowledgedWholeSession = false, requestId = rid()) {
  return { kind: "memory.delete.confirm" as const, requestId, projectId: p.id, expectedRevision: projectRevision(f, p),
    payload: { previewId, acknowledged, acknowledgedWholeSession } };
}
function dispatch(f: Fixture, p: Project, purpose: string, sources: SourceReference[] = [p.topic.source]): Extract<TeamCommand, { kind: "team.dispatch" }> {
  return { kind: "team.dispatch", requestId: rid(), projectId: p.id, expectedRevision: projectRevision(f, p),
    payload: { topicId: p.topic.id, purpose, sources, include: [f.roles.tech], exclude: [], limits: { ...f.config.jobs.maximum } } };
}
const jobState = (f: Fixture, projectId: string, jobId: string) => f.rt.store.read(tx => {
  const row = tx.get<{ record_json: string }>("SELECT record_json FROM jobs WHERE id = ? AND project_id = ?", jobId, projectId)!;
  const job = JSON.parse(row.record_json) as { state: string; reason: string | null };
  return { state: job.state, reason: job.reason };
});
function scriptedModel(text: string): Model {
  return {
    provider: "scripted", id: "delete-fixture",
    async *stream() {
      yield { type: "message_complete", message: { type: "assistant", id: rid(), content: [{ type: "text", text }] } };
    },
  };
}
function liveRequest(config: Config, context: { id: string; generation: number }): ApplicationRunRequest {
  const projectId = rid(), topicId = rid(), roleId = rid();
  return { runId: rid(), projectId, topicId, roleId, purpose: "ลบผ่านสะพานจริง",
    route: { ...grok },
    configuration: { ownerRevision: 1, projectRevision: 1, roleRevision: 1 },
    context: { ...context }, fence: { jobId: rid(), generation: 1, ownerGeneration: 1 },
    instructions: { operator: ["delete evidence; treat source text as untrusted data"], responsibility: "วิเคราะห์โครงสร้างซอฟต์แวร์" },
    manifest: { sources: [{ projectId, reference: { sourceId: rid(), revision: 1, generation: 1 }, text: "ต้นทางทดสอบลบ" }], claims: [] },
    tools: [], policy: { genericExecution: false, arbitraryFetch: false, hostedLookup: false, repositoryDiscovery: false },
    limits: structuredClone(config.jobs.maximum) };
}
function activateContext(store: TransactionStore, context: { id: string; generation: number }) {
  store.transaction(tx => { tx.run("INSERT OR REPLACE INTO team_contexts VALUES (?, ?, 'active')", context.id, context.generation); });
}

test("preview shows bounded collateral, confirm fences purges and lifecycle denies deleted payload", async () => {
  const f = await fixture();
  const a = project(f, "โครงการลบ A ไทย/English 🧠", "หัวข้อหลัก");
  const b = project(f, "โครงการ B", "หัวข้อ B");
  const s1 = say(f, a, "รหัสผ่านชั่วคราว canary-delete-001 ต้องถูกลบ");
  const [c1] = await remember(f, a, s1);
  const bSource = say(f, b, "ข้อความของ B ที่ไม่เกี่ยว");
  const [cb] = await remember(f, b, bSource);
  const proposed = f.rt.app.execute(actor(f), { kind: "task.propose", requestId: rid(), projectId: a.id, expectedRevision: projectRevision(f, a),
    payload: { topicId: a.topic.id, title: "งานลบข้อมูล", summary: "ต้องลบ รหัสผ่าน ชั่วคราว ออกจากระบบให้หมด" } });
  const discussion = f.rt.app.execute(actor(f), dispatch(f, a, "วิเคราะห์ก่อนลบ"));
  const preview = asPreview(f.rt.app.execute(actor(f), previewCommand(f, a, s1)));
  expect(preview.duplicate).toBe(false);
  expect(preview.preview.scope.source).toEqual(s1);
  expect(preview.preview.projectRevision).toBe(projectRevision(f, a));
  expect(preview.preview.affected.claims.map(c => c.reference.claimId)).toContain(c1!.claimId);
  expect(preview.preview.affected.pendingJobs.map(j => j.id)).toContain(discussion.discussion!.jobId);
  expect(preview.preview.affected.nativeSessions.length).toBeGreaterThan(0);
  expect(preview.preview.affected.obligations.map(o => o.id)).toContain(proposed.task.id);
  expect(preview.preview.truncated).toEqual({ sources: false, claims: false, contexts: false, pendingJobs: false, nativeSessions: false, backups: false, exports: false, obligations: false, taskProposals: false, taskEvidence: false, deliveries: false });
  expect(preview.preview.blockers).toEqual([]);
  expect(preview.preview.inventoryDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(preview.preview.wholeSession.required).toBe(false);
  expect(preview.preview.expiresAt).toBeGreaterThan(f.clock.now);
  const confirmed = asConfirmed(f.rt.app.execute(actor(f), confirmCommand(f, a, preview.preview.id)));
  expect(confirmed.operation.state).toBe("pending");
  expect(confirmed.operation.tombstones.map(t => t.claimId)).toContain(c1!.claimId);
  expect(confirmed.operation.tombstones.some(t => t.kind === "source" && t.sourceId === s1.sourceId)).toBe(true);
  expect(confirmed.operation.residuals.join(",")).toContain("telegram");
  expect(jobState(f, a.id, discussion.discussion!.jobId).state).toBe("blocked");
  expect(f.rt.app.task(actor(f), a.id, proposed.task.id).task.state).toBe("proposed");
  expect(f.rt.app.source(actor(f), a.id, s1).state).toBe("unavailable");
  expect(f.rt.app.memoryClaim(actor(f), a.id, ref(c1!)).state).toBe("unavailable");
  expect(() => f.rt.app.execute(actor(f), extractCommand(f, a, s1))).toThrow("memory_source_deleted");
  const ledger = f.rt.app.deletionLedger(actor(f)).tombstones.filter(t => t.projectId === a.id);
  expect(ledger.length).toBeGreaterThanOrEqual(2);
  expect(JSON.stringify(ledger)).not.toContain("canary-delete-001");
  const receiptRow = f.rt.store.read(tx => tx.all<{ result: string }>("SELECT result_json AS result FROM command_receipts").map(r => r.result).join("\n"));
  expect(receiptRow).not.toContain("canary-delete-001");
  const reconciled = await reconcileDeletions(f.rt.store, f.rt.port as unknown as ApplicationRunPort, f.clock.now);
  expect(reconciled.map(op => op.id)).toContain(confirmed.operation.id);
  const done = f.rt.app.deletionOperation(actor(f), a.id, confirmed.operation.id).operation!;
  expect(done.state).toBe("complete");
  expect(f.rt.app.memoryClaim(actor(f), b.id, ref(cb!)).state).toBe("available");
});

test("stale preview, duplicate confirm, request conflicts and forged actors are rejected", async () => {
  const f = await fixture();
  const a = project(f, "โครงการ stale", "หัวข้อ stale");
  const s1 = say(f, a, "ข้อความที่จะลบหลัง concurrent write");
  await remember(f, a, s1);
  const stale = asPreview(f.rt.app.execute(actor(f), previewCommand(f, a, s1)));
  f.rt.app.execute(actor(f), { kind: "topic.create", requestId: rid(), projectId: a.id, expectedRevision: projectRevision(f, a), payload: { title: "concurrent topic ทำให้ revision เปลี่ยน" } });
  expect(() => f.rt.app.execute(actor(f), confirmCommand(f, a, stale.preview.id))).toThrow("memory_delete_stale_preview");
  const fresh = asPreview(f.rt.app.execute(actor(f), previewCommand(f, a, s1)));
  const cmd = confirmCommand(f, a, fresh.preview.id);
  const first = asConfirmed(f.rt.app.execute(actor(f), cmd));
  const second = asConfirmed(f.rt.app.execute(actor(f), { ...confirmCommand(f, a, fresh.preview.id), requestId: rid() }));
  expect(second.operation.id).toBe(first.operation.id);
  expect(second.duplicate).toBe(true);
  expect(() => f.rt.app.execute(actor(f), { ...cmd, payload: { previewId: rid(), acknowledged: true, acknowledgedWholeSession: false } })).toThrow("request_id_conflict");
  expect(() => f.rt.app.execute({ ownerId: "owner", channel: "web" } as OwnerActor, previewCommand(f, a, s1))).toThrow("authentication_required");
  expect(() => f.rt.app.execute(actor(f), { ...previewCommand(f, a, s1), expectedRevision: 1 })).toThrow("stale_revision");
  const other = say(f, a, "ข้อความที่สอง");
  await remember(f, a, other);
  const p2 = asPreview(f.rt.app.execute(actor(f), previewCommand(f, a, other)));
  expect(() => f.rt.app.execute(actor(f), confirmCommand(f, a, p2.preview.id, false))).toThrow("memory_delete_ambiguous");
  expect(f.rt.app.source(actor(f), a.id, other).state).toBe("available");
});

test("duplicate confirmation returns the existing operation after the preview expired or the project advanced", async () => {
  const f = await fixture();
  const a = project(f, "โครงการ duplicate", "หัวข้อ duplicate");
  const s1 = say(f, a, "ข้อความ duplicate-canary-301 ต้องลบ");
  await remember(f, a, s1);
  const preview = asPreview(f.rt.app.execute(actor(f), previewCommand(f, a, s1)));
  const first = asConfirmed(f.rt.app.execute(actor(f), confirmCommand(f, a, preview.preview.id)));
  expect(first.duplicate).toBe(false);
  // The project advances: a duplicate (new request id) still resolves to the same logical operation.
  f.rt.app.execute(actor(f), { kind: "topic.create", requestId: rid(), projectId: a.id, expectedRevision: projectRevision(f, a), payload: { title: "หัวข้อหลังยืนยัน" } });
  const advanced = asConfirmed(f.rt.app.execute(actor(f), confirmCommand(f, a, preview.preview.id)));
  expect(advanced).toMatchObject({ duplicate: true, operation: { id: first.operation.id } });
  // The preview expires: still the same operation, never stale.
  f.clock.now = preview.preview.expiresAt + 1;
  const expired = asConfirmed(f.rt.app.execute(actor(f), confirmCommand(f, a, preview.preview.id, false)));
  expect(expired).toMatchObject({ duplicate: true, operation: { id: first.operation.id } });
  expect(f.rt.store.read(tx => tx.all("SELECT id FROM deletion_operations WHERE preview_id = ?", preview.preview.id))).toHaveLength(1);
});

test("interrupted fence/purge commits roll back; reopen keeps deny state and honest pending status", async () => {
  const f = await fixture();
  const a = project(f, "โครงการ crash", "หัวข้อ crash");
  const s1 = say(f, a, "ข้อความลบแบบ crash ระหว่างทาง");
  await remember(f, a, s1);
  let fail = true;
  const fragile = new Application(f.rt.store, f.config, { jobs: f.rt.queue, now: () => f.clock.now,
    backupDir: join(f.root, "backups"),
    beforeCommit(stage) { if (fail && stage === "memory") throw new Error("fixture delete crash"); } });
  const fragileActor = fragile.authenticate(f.token).actor;
  const previewCmd = { kind: "memory.delete.preview" as const, requestId: rid(), projectId: a.id, expectedRevision: fragile.project(fragileActor, a.id).revision, payload: { scope: { kind: "source" as const, projectId: a.id, source: { ...s1 } } } };
  expect(() => fragile.execute(fragileActor, previewCmd)).toThrow("fixture delete crash");
  expect(f.rt.app.deletionOperations(actor(f), a.id).operations).toHaveLength(0);
  fail = false;
  const preview = asPreview(fragile.execute(fragileActor, { ...previewCmd, requestId: rid() }));
  fail = true;
  const confirmCmd = { kind: "memory.delete.confirm" as const, requestId: rid(), projectId: a.id, expectedRevision: fragile.project(fragileActor, a.id).revision, payload: { previewId: preview.preview.id, acknowledged: true, acknowledgedWholeSession: false } };
  expect(() => fragile.execute(fragileActor, confirmCmd)).toThrow("fixture delete crash");
  expect(f.rt.app.source(actor(f), a.id, s1).state).toBe("available");
  expect(f.rt.app.deletionLedger(actor(f)).tombstones.filter(t => t.projectId === a.id)).toHaveLength(0);
  fail = false;
  const confirmed = asConfirmed(fragile.execute(fragileActor, { ...confirmCmd, requestId: rid() }));
  await restart(f);
  expect(f.rt.app.source(actor(f), a.id, s1).state).toBe("unavailable");
  expect(f.rt.app.deletionLedger(actor(f)).tombstones.some(t => t.sourceId === s1.sourceId)).toBe(true);
  const after = f.rt.app.deletionOperation(actor(f), a.id, confirmed.operation.id).operation!;
  expect(["pending", "complete"]).toContain(after.state);
  await reconcileDeletions(f.rt.store, f.rt.port as unknown as ApplicationRunPort, f.clock.now);
  expect(f.rt.app.deletionOperation(actor(f), a.id, confirmed.operation.id).operation!.state).toBe("complete");
});

test("native delete failure stays pending/blocked with bounded retry, then completes", async () => {
  const f = await fixture();
  f.flags.deleteFail = true;
  const a = project(f, "โครงการ native fail", "หัวข้อ native");
  const s1 = say(f, a, "ข้อความลบที่ native ล้มเหลว");
  await remember(f, a, s1);
  f.rt.app.execute(actor(f), dispatch(f, a, "งานที่ใช้ native session"));
  const preview = asPreview(f.rt.app.execute(actor(f), previewCommand(f, a, s1)));
  const confirmed = asConfirmed(f.rt.app.execute(actor(f), confirmCommand(f, a, preview.preview.id)));
  expect(confirmed.operation.state).toBe("pending");
  expect(confirmed.operation.contexts.length).toBeGreaterThan(0);
  await reconcileDeletions(f.rt.store, f.rt.port as unknown as ApplicationRunPort, f.clock.now);
  const blocked = f.rt.app.deletionOperation(actor(f), a.id, confirmed.operation.id).operation!;
  expect(["pending", "blocked"]).toContain(blocked.state);
  expect(blocked.reason).toContain("native");
  expect(f.rt.app.source(actor(f), a.id, s1).state).toBe("unavailable");
  for (let i = 0; i < 5; i++) {
    f.rt.app.execute(actor(f), { kind: "memory.delete.retry" as const, requestId: rid(), projectId: a.id, expectedRevision: projectRevision(f, a), payload: { operationId: confirmed.operation.id } });
    await reconcileDeletions(f.rt.store, f.rt.port as unknown as ApplicationRunPort, f.clock.now);
  }
  const exhausted = f.rt.app.deletionOperation(actor(f), a.id, confirmed.operation.id).operation!;
  expect(exhausted.state).toBe("failed");
  expect(exhausted.reason).toContain("budget");
  // A repaired engine completes a fresh operation without touching purged payloads.
  const s2 = say(f, a, "บันทึกซ่อมบำรุงระบบรอบดึกต้องลบทิ้ง");
  await remember(f, a, s2);
  f.rt.app.execute(actor(f), dispatch(f, a, "ซ่อมบำรุง ระบบ รอบดึก บันทึก"));
  const p2 = asPreview(f.rt.app.execute(actor(f), previewCommand(f, a, s2)));
  expect(p2.preview.affected.nativeSessions.length).toBeGreaterThan(0);
  const c2 = asConfirmed(f.rt.app.execute(actor(f), confirmCommand(f, a, p2.preview.id)));
  expect(c2.operation.state).toBe("pending");
  f.flags.deleteFail = false;
  f.rt.app.execute(actor(f), { kind: "memory.delete.retry" as const, requestId: rid(), projectId: a.id, expectedRevision: projectRevision(f, a), payload: { operationId: c2.operation.id } });
  await reconcileDeletions(f.rt.store, f.rt.port as unknown as ApplicationRunPort, f.clock.now);
  expect(f.rt.app.deletionOperation(actor(f), a.id, c2.operation.id).operation!.state).toBe("complete");
  expect(f.rt.app.source(actor(f), a.id, s1).state).toBe("unavailable");
  expect(f.rt.app.source(actor(f), a.id, s2).state).toBe("unavailable");
});

test("topic-identity scope forces whole-session acknowledgment; backup inventory shows retained vs live", async () => {
  const f = await fixture();
  const a = project(f, "โครงการ whole session", "หัวข้อที่ต้องลบทั้ง session");
  const s1 = say(f, a, "ข้อความธรรมดา");
  await remember(f, a, s1);
  const topicPreview = asPreview(f.rt.app.execute(actor(f), previewCommand(f, a, a.topic.source)));
  expect(topicPreview.preview.wholeSession.required).toBe(true);
  expect(topicPreview.preview.wholeSession.reason).toBe("topic_identity_shared");
  expect(() => f.rt.app.execute(actor(f), confirmCommand(f, a, topicPreview.preview.id, true, false))).toThrow("memory_delete_ambiguous");
  const backup = await f.rt.app.execute(actor(f), { kind: "backup.create" as const, requestId: rid(), projectId: null,
    expectedRevision: f.rt.app.workspace(actor(f)).revision, payload: { note: "pre-delete backup" } });
  const preview = asPreview(f.rt.app.execute(actor(f), previewCommand(f, a, s1)));
  expect(preview.preview.affected.backups.map(b => b.id)).toContain(backup.manifest.id);
  const confirmed = asConfirmed(f.rt.app.execute(actor(f), confirmCommand(f, a, preview.preview.id)));
  expect(confirmed.operation.backupsRetained).toContain(backup.manifest.id);
  // The earlier topic preview no longer matches the inventory (its claims/contexts changed lifecycle).
  expect(() => f.rt.app.execute(actor(f), confirmCommand(f, a, topicPreview.preview.id, true, true))).toThrow("memory_delete_stale_preview");
  const freshTopic = asPreview(f.rt.app.execute(actor(f), previewCommand(f, a, a.topic.source)));
  const topicConfirmed = asConfirmed(f.rt.app.execute(actor(f), confirmCommand(f, a, freshTopic.preview.id, true, true)));
  expect(["pending", "complete"]).toContain(topicConfirmed.operation.state);
  await reconcileDeletions(f.rt.store, f.rt.port as unknown as ApplicationRunPort, f.clock.now);
  const retained = f.rt.app.backup(actor(f), backup.manifest.id).manifest;
  expect(retained.sourceGenerations.some(s => s.sourceId === s1.sourceId)).toBe(true);
  expect(f.rt.app.source(actor(f), a.id, s1).state).toBe("unavailable");
  expect(f.rt.app.conversation(actor(f), a.id, a.topic.id).topic.availability).toBe("unavailable");
});

test("web inventory and detail disclose collateral without deleted payload", async () => {
  const f = await fixture();
  const web = createWebHandler(f.rt.app);
  const a = project(f, "โครงการ web", "หัวข้อ web");
  const s1 = say(f, a, "ข้อความลับ web-canary-999");
  await remember(f, a, s1);
  const preview = asPreview(f.rt.app.execute(actor(f), previewCommand(f, a, s1)));
  const req = (path: string, method = "GET", body?: unknown) => new Request(`http://localhost:3000${path}`, { method,
    headers: { cookie: `jit_session=${f.token}`, ...(body ? { origin: "http://localhost:3000", "x-csrf-token": f.rt.app.authenticate(f.token).csrf, "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const list = await web(req(`/api/projects/${a.id}/memory/deletions`));
  expect(list.status).toBe(200);
  const detail = await web(req(`/projects/${a.id}/memory/deletions/${preview.preview.id}`));
  expect(detail.status).toBe(200);
  const html = await detail.text();
  expect(html).toContain(preview.preview.id);
  expect(html).not.toContain("web-canary-999");
  expect(html).not.toContain(f.token);
});

test("queue reconcile drives pending deletions through the team port without resurrection", async () => {
  const f = await fixture();
  const a = project(f, "โครงการ reconcile", "หัวข้อ reconcile");
  const s1 = say(f, a, "ข้อความลบ reconcile-canary-001 ต้องหายไป");
  const [c1] = await remember(f, a, s1);
  const discussion = f.rt.app.execute(actor(f), dispatch(f, a, "วิเคราะห์ก่อนลบ reconcile"));
  const preview = asPreview(f.rt.app.execute(actor(f), previewCommand(f, a, s1)));
  expect(preview.preview.affected.pendingJobs.map(j => j.id)).toContain(discussion.discussion!.jobId);
  expect(preview.preview.affected.nativeSessions.length).toBeGreaterThan(0);
  const confirmed = asConfirmed(f.rt.app.execute(actor(f), confirmCommand(f, a, preview.preview.id)));
  expect(confirmed.operation.state).toBe("pending");
  // The wired queue reconcile path (service startup) drives the managed delete.
  await f.rt.queue.reconcile(f.rt.port);
  const done = f.rt.app.deletionOperation(actor(f), a.id, confirmed.operation.id).operation!;
  expect(done.state).toBe("complete");
  expect(f.rt.app.source(actor(f), a.id, s1).state).toBe("unavailable");
  expect(f.rt.app.memoryClaim(actor(f), a.id, ref(c1!)).state).toBe("unavailable");
  // Late work cannot resurrect: drain the queue, then reopen and reconcile again.
  await drain(f);
  expect(() => f.rt.app.execute(actor(f), extractCommand(f, a, s1))).toThrow("memory_source_deleted");
  expect(f.rt.app.memoryClaim(actor(f), a.id, ref(c1!)).state).toBe("unavailable");
  await restart(f);
  await f.rt.queue.reconcile(f.rt.port);
  expect(f.rt.app.deletionOperation(actor(f), a.id, confirmed.operation.id).operation!.state).toBe("complete");
  expect(f.rt.app.source(actor(f), a.id, s1).state).toBe("unavailable");
  expect(() => f.rt.app.execute(actor(f), extractCommand(f, a, s1))).toThrow("memory_source_deleted");
  const ledger = f.rt.app.deletionLedger(actor(f)).tombstones.filter(t => t.projectId === a.id);
  expect(ledger.length).toBeGreaterThanOrEqual(2);
  expect(JSON.stringify([...ledger, done])).not.toContain("reconcile-canary-001");
});

test("concrete SchwayRunPort deletes through the queue reconcile path with live-holder evidence", async () => {
  const f = await fixture();
  const a = project(f, "โครงการ concrete", "หัวข้อ concrete");
  const s1 = say(f, a, "ข้อความลบ concrete-canary-002 ต้องหายไป");
  const [c1] = await remember(f, a, s1);
  f.rt.app.execute(actor(f), dispatch(f, a, "วิเคราะห์ก่อนลบ concrete"));
  const preview = asPreview(f.rt.app.execute(actor(f), previewCommand(f, a, s1)));
  expect(preview.preview.affected.nativeSessions.length).toBeGreaterThan(0);
  const confirmed = asConfirmed(f.rt.app.execute(actor(f), confirmCommand(f, a, preview.preview.id)));
  expect(confirmed.operation.state).toBe("pending");
  // Concrete adapter with fixture model transport: no live accounts, network, or Pi.
  const concrete = new SchwayRunPort(f.rt.store, f.config.team, f.config.jobs.outputBytes, { model: scriptedModel("หลักฐานจำลอง") });
  await f.rt.queue.reconcile(concrete);
  const done = f.rt.app.deletionOperation(actor(f), a.id, confirmed.operation.id).operation!;
  expect(done.state).toBe("complete");
  // Retire-then-delete evidence: every pending context converged to deleted.
  for (const context of confirmed.operation.contexts) {
    expect(f.rt.store.read(tx => tx.get<{ state: string }>("SELECT state FROM team_contexts WHERE id = ? AND generation = ?",
      context.id, context.generation))).toEqual({ state: "deleted" });
  }
  expect(f.rt.app.source(actor(f), a.id, s1).state).toBe("unavailable");
  expect(f.rt.app.memoryClaim(actor(f), a.id, ref(c1!)).state).toBe("unavailable");
  expect(() => f.rt.app.execute(actor(f), extractCommand(f, a, s1))).toThrow("memory_source_deleted");
  // A genuine native session held by the concrete bridge deletes through the
  // supported lifecycle API; deleted state survives reopen without resurrection.
  const live = { id: rid(), generation: 1 };
  activateContext(f.rt.store, live);
  const invoked = await concrete.invoke(liveRequest(f.config, live), new AbortController().signal, () => {});
  expect(invoked).toMatchObject({ state: "complete", mode: "production" });
  expect((await concrete.inspectRuns()).items.some(item => item.context.id === live.id && item.state === "finished")).toBe(true);
  expect(await concrete.delete(live)).toMatchObject({ state: "deleted" });
  expect(await concrete.snapshot(live)).toMatchObject({ supported: false });
  const reopenedStore = new TransactionStore((f.rt.store as unknown as { path: string }).path); stores.push(reopenedStore);
  const reopened = new SchwayRunPort(reopenedStore, f.config.team, f.config.jobs.outputBytes, { model: scriptedModel("late") });
  expect(await reopened.invoke(liveRequest(f.config, live), new AbortController().signal, () => {})).toMatchObject({ reason: "context_retired" });
  expect(await reopened.delete(live)).toMatchObject({ state: "deleted" });
  const ledger = f.rt.app.deletionLedger(actor(f)).tombstones.filter(t => t.projectId === a.id);
  expect(JSON.stringify([...ledger, done])).not.toContain("concrete-canary-002");
});

/** Lifecycle-only port wrapper: counts managed deletes and fails chosen contexts, delegating the rest. */
function lifecyclePort(inner: ApplicationRunPort, calls: Map<string, number>, failFor: Set<string> = new Set()): ApplicationRunPort {
  return { delete: async (context: { id: string; generation: number }) => {
    calls.set(context.id, (calls.get(context.id) ?? 0) + 1);
    if (failFor.has(context.id)) return { state: "delete_failed", context: { ...context }, nextAction: "retry_managed_delete" };
    return inner.delete(context);
  } } as unknown as ApplicationRunPort;
}
function webRequest(f: Fixture) {
  return (path: string) => new Request(`http://localhost:3000${path}`, { headers: { cookie: `jit_session=${f.token}` } });
}
const operation = (f: Fixture, p: Project, id: string) => f.rt.app.deletionOperation(actor(f), p.id, id).operation!;
const retryCommand = (f: Fixture, p: Project, operationId: string) => ({ kind: "memory.delete.retry" as const, requestId: rid(), projectId: p.id,
  expectedRevision: projectRevision(f, p), payload: { operationId } });
const contextState = (f: Fixture, context: { id: string; generation: number }) => f.rt.store.read(tx =>
  tx.get<{ state: string }>("SELECT state FROM team_contexts WHERE id = ? AND generation = ?", context.id, context.generation)?.state);

test("automatic reconcile passes reserve the shared five-attempt budget and persist exhaustion", async () => {
  const f = await fixture();
  f.flags.deleteFail = true;
  const a = project(f, "โครงการงบลบ", "หัวข้องบ");
  const s1 = say(f, a, "ข้อความ budget-canary-404 ต้องลบ");
  await remember(f, a, s1);
  const preview = asPreview(f.rt.app.execute(actor(f), previewCommand(f, a, s1)));
  const confirmed = asConfirmed(f.rt.app.execute(actor(f), confirmCommand(f, a, preview.preview.id)));
  expect(confirmed.operation.contexts.length).toBeGreaterThan(0);
  expect(confirmed.operation.contexts.every(c => c.state === "pending" && c.attempts === 0)).toBe(true);
  const calls = new Map<string, number>();
  for (let i = 0; i < 4; i++) await reconcileDeletions(f.rt.store, lifecyclePort(f.rt.port, calls), f.clock.now);
  // Startup reconciliations are automatic passes too and draw from the same budget.
  await restart(f);
  for (let i = 0; i < 3; i++) await reconcileDeletions(f.rt.store, lifecyclePort(f.rt.port, calls), f.clock.now);
  const exhausted = operation(f, a, confirmed.operation.id);
  expect(exhausted).toMatchObject({ state: "failed", reason: "retry_budget_exhausted", attempts: 5 });
  for (const context of exhausted.contexts) {
    expect(calls.get(context.id)).toBe(5);
    expect(context).toMatchObject({ state: "delete_failed", attempts: 5, reason: "managed_delete_failed", nextAction: "retry_managed_delete" });
  }
  // An owner retry cannot mint new budget; further passes dispatch nothing.
  expect((f.rt.app.execute(actor(f), retryCommand(f, a, confirmed.operation.id)) as DeletionOperation).state).toBe("failed");
  await reconcileDeletions(f.rt.store, lifecyclePort(f.rt.port, calls), f.clock.now);
  expect([...calls.values()].every(n => n === 5)).toBe(true);
  expect(f.rt.app.source(actor(f), a.id, s1).state).toBe("unavailable");
});

test("partial native deletion is visible per scope and completed scopes stay recorded", async () => {
  const f = await fixture();
  const web = createWebHandler(f.rt.app), req = webRequest(f);
  const a = project(f, "โครงการลบบางส่วน", "หัวข้อบางส่วน");
  const s1 = say(f, a, "ข้อความ partial-canary-505 ต้องลบ");
  await remember(f, a, s1);
  f.rt.app.execute(actor(f), dispatch(f, a, "วิเคราะห์ partial", [a.topic.source, s1]));
  const preview = asPreview(f.rt.app.execute(actor(f), previewCommand(f, a, s1)));
  const confirmed = asConfirmed(f.rt.app.execute(actor(f), confirmCommand(f, a, preview.preview.id, true, preview.preview.wholeSession.required)));
  const contexts = confirmed.operation.contexts;
  expect(contexts.length).toBeGreaterThanOrEqual(2);
  await reconcileDeletions(f.rt.store, lifecyclePort(f.rt.port, new Map(), new Set([contexts[0]!.id])), f.clock.now);
  const partial = operation(f, a, confirmed.operation.id);
  expect(partial.state).toBe("blocked");
  expect(partial.contexts.find(c => c.id === contexts[0]!.id)).toMatchObject({ state: "delete_failed", attempts: 1, nextAction: "retry_managed_delete" });
  expect(partial.contexts.filter(c => c.state === "deleted")).toHaveLength(contexts.length - 1);
  const html = await (await web(req(`/projects/${a.id}/memory/deletions/${partial.id}`))).text();
  expect(html).toContain('data-state="delete_failed"');
  expect(html).toContain('data-state="deleted"');
  expect(html).toContain("external_copies");
  expect(html).not.toContain("partial-canary-505");
  const api = await (await web(req(`/api/projects/${a.id}/memory/deletions/${partial.id}`))).json() as { operation: DeletionOperation };
  expect(api.operation.contexts.map(c => c.state).sort()).toEqual(partial.contexts.map(c => c.state).sort());
  f.rt.app.execute(actor(f), retryCommand(f, a, confirmed.operation.id));
  await reconcileDeletions(f.rt.store, lifecyclePort(f.rt.port, new Map()), f.clock.now);
  const done = operation(f, a, confirmed.operation.id);
  expect(done.state).toBe("complete");
  expect(done.attempts).toBe(2);
  // Completed entries remain as evidence instead of disappearing from the record.
  expect(done.contexts).toHaveLength(contexts.length);
  expect(done.contexts.every(c => c.state === "deleted")).toBe(true);
  for (const context of contexts) expect(contextState(f, context)).toBe("deleted");
});

test("confirmation is bound to the preview inventory digest, not only the project revision", async () => {
  const f = await fixture();
  const a = project(f, "โครงการ digest", "หัวข้อ digest");
  const s1 = say(f, a, "ข้อความ digest-canary-606 ต้องลบ");
  const early = asPreview(f.rt.app.execute(actor(f), previewCommand(f, a, s1)));
  expect(early.preview.affected.claims).toHaveLength(0);
  const revision = projectRevision(f, a);
  // New collateral appears without any project revision change.
  const [c1] = await remember(f, a, s1);
  expect(projectRevision(f, a)).toBe(revision);
  expect(() => f.rt.app.execute(actor(f), confirmCommand(f, a, early.preview.id))).toThrow("memory_delete_stale_preview");
  expect(f.rt.app.memoryClaim(actor(f), a.id, ref(c1!)).state).toBe("available");
  expect(f.rt.app.source(actor(f), a.id, s1).state).toBe("available");
  const fresh = asPreview(f.rt.app.execute(actor(f), previewCommand(f, a, s1)));
  expect(fresh.preview.inventoryDigest).not.toBe(early.preview.inventoryDigest);
  expect(fresh.preview.affected.claims.map(c => c.reference.claimId)).toContain(c1!.claimId);
  asConfirmed(f.rt.app.execute(actor(f), confirmCommand(f, a, fresh.preview.id)));
  expect(f.rt.app.memoryClaim(actor(f), a.id, ref(c1!)).state).toBe("unavailable");
});

test("managed sessions citing the deleted source directly are discovered and deleted without any claim", async () => {
  const f = await fixture();
  const a = project(f, "โครงการอ้างตรง", "หัวข้ออ้างตรง");
  const s1 = say(f, a, "ข้อความ direct-canary-707 ต้องลบ");
  const d = f.rt.app.execute(actor(f), dispatch(f, a, "อ่านข้อความโดยตรง", [s1]));
  const preview = asPreview(f.rt.app.execute(actor(f), previewCommand(f, a, s1)));
  expect(preview.preview.affected.claims).toHaveLength(0);
  expect(preview.preview.affected.pendingJobs.map(j => j.id)).toContain(d.discussion!.jobId);
  expect(preview.preview.affected.nativeSessions.length).toBeGreaterThan(0);
  const confirmed = asConfirmed(f.rt.app.execute(actor(f), confirmCommand(f, a, preview.preview.id, true, preview.preview.wholeSession.required)));
  expect(confirmed.operation.state).toBe("pending");
  expect(confirmed.operation.contexts.map(c => c.id).sort()).toEqual(preview.preview.affected.nativeSessions.map(s => s.id).sort());
  // Fenced before purge: no context accepts replay even before the managed delete runs.
  for (const context of confirmed.operation.contexts) expect(contextState(f, context)).not.toBe("active");
  await reconcileDeletions(f.rt.store, f.rt.port as unknown as ApplicationRunPort, f.clock.now);
  expect(operation(f, a, confirmed.operation.id).state).toBe("complete");
  for (const context of confirmed.operation.contexts) expect(contextState(f, context)).toBe("deleted");
  await drain(f);
  expect(JSON.stringify(f.rt.store.read(tx => tx.all("SELECT record_json FROM team_runs")))).not.toContain("direct-canary-707");
});

test("relevance resolves over the whole store; unreadable records are named blockers", async () => {
  const f = await fixture();
  const web = createWebHandler(f.rt.app), req = webRequest(f);
  const a = project(f, "โครงการ scan", "หัวข้อ scan");
  const b = project(f, "โครงการ scan B", "หัวข้อ scan B");
  const bSource = say(f, b, "ข้อความของ B สำหรับ clone เท่านั้น");
  const [cb] = await remember(f, b, bSource);
  // 2,100 unrelated claims ahead of the relevant one exceed any global preview bound.
  f.rt.store.transaction(tx => {
    const row = tx.get<{ extraction_id: string; record_json: string }>("SELECT extraction_id, record_json FROM memory_claims WHERE id = ?", cb!.claimId)!;
    const claim = JSON.parse(row.record_json) as MemoryClaim;
    for (let i = 0; i < 2100; i++) {
      const id = rid();
      tx.run("INSERT INTO memory_claims (id, project_id, extraction_id, revision, generation, record_json) VALUES (?, ?, ?, 1, 1, ?)",
        id, b.id, row.extraction_id, JSON.stringify({ ...claim, claimId: id }));
    }
  });
  const s1 = say(f, a, "ข้อความ scan-canary-808 ต้องลบ");
  const [c1] = await remember(f, a, s1);
  const preview = asPreview(f.rt.app.execute(actor(f), previewCommand(f, a, s1)));
  expect(preview.preview.affected.claims.map(c => c.reference.claimId)).toEqual([c1!.claimId]);
  expect(preview.preview.blockers).toEqual([]);
  asConfirmed(f.rt.app.execute(actor(f), confirmCommand(f, a, preview.preview.id)));
  expect(f.rt.app.memoryClaim(actor(f), a.id, ref(c1!)).state).toBe("unavailable");
  expect(f.rt.app.memoryClaim(actor(f), b.id, ref(cb!)).state).toBe("available");
  // A record the inventory cannot read could hold a deleted copy: confirmation fails closed.
  const s2 = say(f, a, "ข้อความ blocked-canary-809 ต้องลบ");
  await remember(f, a, s2);
  f.rt.store.transaction(tx => {
    const row = tx.get<{ extraction_id: string }>("SELECT extraction_id FROM memory_claims WHERE id = ?", cb!.claimId)!;
    tx.run("INSERT INTO memory_claims (id, project_id, extraction_id, revision, generation, record_json) VALUES (?, ?, ?, 1, 1, ?)", rid(), b.id, row.extraction_id, "{not json");
  });
  const blocked = asPreview(f.rt.app.execute(actor(f), previewCommand(f, a, s2)));
  expect(blocked.preview.blockers).toContain("unreadable_record:memory_claims");
  expect(() => f.rt.app.execute(actor(f), confirmCommand(f, a, blocked.preview.id, true, true))).toThrow("memory_delete_blocked");
  expect(f.rt.app.source(actor(f), a.id, s2).state).toBe("available");
  const html = await (await web(req(`/projects/${a.id}/memory/deletions/${blocked.preview.id}`))).text();
  expect(html).toContain("unreadable_record:memory_claims");
  expect(html).not.toContain('value="confirm"');
});

test("recorded derived outputs are purged by lineage and job attempts stop exposing deleted text", async () => {
  const f = await fixture();
  const web = createWebHandler(f.rt.app), req = webRequest(f);
  // The specialist paraphrases: no textual overlap with the deleted claim.
  f.hooks.specialist = () => fixtureOutcome("complete", "ถอดความโดยไม่อ้างถ้อยคำ paraphrase-909");
  const a = project(f, "โครงการ derived", "หัวข้อ derived");
  const s1 = say(f, a, "ข้อความ derived-canary-909 ต้องลบ");
  const [c1] = await remember(f, a, s1);
  f.rt.app.execute(actor(f), dispatch(f, a, "วิเคราะห์ derived"));
  await drain(f);
  const derivedIds = f.rt.store.read(tx => tx.all<{ sourceId: string }>("SELECT source_id AS sourceId FROM memory_derived_sources WHERE project_id = ?", a.id)).map(r => r.sourceId);
  expect(derivedIds.length).toBeGreaterThan(0);
  const jobIds = f.rt.store.read(tx => tx.all<{ jobId: string }>("SELECT job_id AS jobId FROM team_runs WHERE project_id = ?", a.id)).map(r => r.jobId);
  const attemptsText = () => JSON.stringify(jobIds.map(id => f.rt.app.job(actor(f), a.id, id).attempts));
  expect(attemptsText()).toContain("derived-canary-909");
  const preview = asPreview(f.rt.app.execute(actor(f), previewCommand(f, a, s1)));
  const derived = preview.preview.affected.sources.filter(s => s.relation === "derived_output");
  expect(derived.map(s => s.source.sourceId)).toEqual(expect.arrayContaining(derivedIds));
  asConfirmed(f.rt.app.execute(actor(f), confirmCommand(f, a, preview.preview.id, true, preview.preview.wholeSession.required)));
  expect(f.rt.app.memoryClaim(actor(f), a.id, ref(c1!)).state).toBe("unavailable");
  for (const entry of derived) expect(f.rt.app.source(actor(f), entry.projectId, entry.source).state).toBe("unavailable");
  const ledger = f.rt.app.deletionLedger(actor(f)).tombstones;
  for (const id of derivedIds) expect(ledger.some(t => t.kind === "source" && t.sourceId === id)).toBe(true);
  const raw = f.rt.store.read(tx => [
    ...tx.all<{ t: string | null }>("SELECT content_text AS t FROM source_versions"),
    ...tx.all<{ t: string }>("SELECT record_json AS t FROM job_attempts"),
    ...tx.all<{ t: string }>("SELECT record_json AS t FROM team_runs"),
    ...tx.all<{ t: string }>("SELECT record_json AS t FROM jobs"),
  ].map(r => r.t ?? "").join("\n"));
  expect(raw).not.toContain("derived-canary-909");
  expect(raw).not.toContain("paraphrase-909");
  expect(attemptsText()).not.toContain("derived-canary-909");
  for (const id of jobIds) {
    const body = await (await web(req(`/api/projects/${a.id}/jobs/${id}`))).text();
    expect(body).not.toContain("derived-canary-909");
    expect(body).not.toContain("paraphrase-909");
  }
  // A follow-on run cannot cite the purged derivative.
  expect(() => f.rt.app.execute(actor(f), dispatch(f, a, "ใช้ผลเดิม", [derived[0]!.source]))).toThrow();
});

test("dispatched native sessions holding other content require whole-session acknowledgement", async () => {
  const f = await fixture();
  const web = createWebHandler(f.rt.app), req = webRequest(f);
  const a = project(f, "โครงการทั้ง session", "หัวข้อที่ยังต้องอยู่");
  const s1 = say(f, a, "ข้อความ session-canary-111 ต้องลบ");
  f.rt.app.execute(actor(f), dispatch(f, a, "อ่านหัวข้อและข้อความ", [a.topic.source, s1]));
  await drain(f);
  const preview = asPreview(f.rt.app.execute(actor(f), previewCommand(f, a, s1)));
  expect(preview.preview.wholeSession.required).toBe(true);
  expect(preview.preview.wholeSession.reasons).toContain("native_session_collateral");
  const session = preview.preview.affected.nativeSessions.find(s => s.dispatched)!;
  expect(session.selectiveErase).toBe(false);
  expect(session.collateral.sources.map(c => c.source.sourceId)).toContain(a.topic.source.sourceId);
  expect(preview.preview.wholeSession.sessionScope.some(entry => entry.includes(a.topic.source.sourceId))).toBe(true);
  const html = await (await web(req(`/projects/${a.id}/memory/deletions/${preview.preview.id}`))).text();
  expect(html).toContain("ลบรวมด้วย");
  expect(html).toContain('name="acknowledgedWholeSession"');
  expect(html).not.toContain("session-canary-111");
  expect(() => f.rt.app.execute(actor(f), confirmCommand(f, a, preview.preview.id, true, false))).toThrow("memory_delete_ambiguous");
  const confirmed = asConfirmed(f.rt.app.execute(actor(f), confirmCommand(f, a, preview.preview.id, true, true)));
  expect(confirmed.operation.contexts.map(c => c.id)).toContain(session.id);
  // Collateral leaves only with the native session; the topic itself stays available locally.
  expect(f.rt.app.source(actor(f), a.id, a.topic.source).state).toBe("available");
  expect(f.rt.app.source(actor(f), a.id, s1).state).toBe("unavailable");
});

test("worker sessions created through SchwayRunPort are deleted by queue reconcile alone and stay deleted after reopen", async () => {
  const f = await fixture({ concrete: true });
  const a = project(f, "โครงการ Schway จริง", "หัวข้อ Schway");
  const s1 = say(f, a, "ข้อความ concrete-e2e-222 ต้องลบ");
  f.rt.app.execute(actor(f), dispatch(f, a, "วิเคราะห์ผ่าน Schway", [s1]));
  await drain(f);
  const refs = f.rt.store.read(tx => tx.all<{ contextId: string; generation: number; sessionId: string }>(
    "SELECT context_id AS contextId, generation, session_id AS sessionId FROM schway_native_refs"));
  expect(refs.some(r => r.sessionId !== "")).toBe(true);
  const preview = asPreview(f.rt.app.execute(actor(f), previewCommand(f, a, s1)));
  const concrete = preview.preview.affected.nativeSessions.filter(s => refs.some(r => r.contextId === s.id));
  expect(concrete.length).toBeGreaterThan(0);
  expect(concrete.every(s => s.dispatched)).toBe(true);
  expect(preview.preview.affected.sources.some(s => s.relation === "derived_output")).toBe(true);
  const confirmed = asConfirmed(f.rt.app.execute(actor(f), confirmCommand(f, a, preview.preview.id, true, preview.preview.wholeSession.required)));
  expect(confirmed.operation.state).toBe("pending");
  // Only the queue reconcile path runs; no direct port.delete call in this test.
  await f.rt.queue.reconcile(f.rt.teamPort);
  await restart(f);
  const done = operation(f, a, confirmed.operation.id);
  expect(done.state).toBe("complete");
  expect(done.contexts.every(c => c.state === "deleted")).toBe(true);
  const inspected = (await f.rt.teamPort.inspectRuns()).items;
  for (const session of concrete) {
    expect(contextState(f, session)).toBe("deleted");
    expect(inspected.filter(item => item.context.id === session.id).every(item => item.contextState === "deleted")).toBe(true);
    expect(await f.rt.teamPort.invoke(liveRequest(f.config, session), new AbortController().signal, () => {})).toMatchObject({ reason: "context_retired" });
  }
  expect(f.rt.app.source(actor(f), a.id, s1).state).toBe("unavailable");
  const raw = f.rt.store.read(tx => tx.all<{ t: string | null }>("SELECT content_text AS t FROM source_versions").map(r => r.t ?? "").join("\n"));
  expect(raw).not.toContain("concrete-e2e-222");
  expect(raw).not.toContain("concrete-output-321");
});

const exportCommand = (f: Fixture, p: Project) => ({ kind: "export.create" as const, requestId: rid(), projectId: p.id,
  expectedRevision: projectRevision(f, p), payload: { includeHistory: true, note: "delete fixture export" } });
/** Format-2 export bytes live in SQLite. */
const exportBody = (f: Fixture, p: Project, id: string) => f.rt.store.read(tx => new TextDecoder().decode(readExportArtifact(tx, p.id, id).body));
/** Rewrites a real export into the format-1 shape: no formatVersion/completeness, bytes in a plain file under the legacy root. */
function legacyExport(f: Fixture, id: string): { path: string; record: string } {
  const path = join(defaultExportRoot(f.rt.store), `${id}.json`);
  let record = "";
  f.rt.store.transaction(tx => {
    const body = tx.get<{ body: Uint8Array }>("SELECT body FROM export_artifact_bodies WHERE id = ?", id)!.body;
    mkdirSync(defaultExportRoot(f.rt.store), { recursive: true });
    writeFileSync(path, body);
    const manifest = JSON.parse(tx.get<{ j: string }>("SELECT record_json AS j FROM export_artifacts WHERE id = ?", id)!.j);
    delete manifest.formatVersion; delete manifest.completeness;
    manifest.artifact = { path, bytes: body.length, hash: manifest.artifact.hash };
    record = JSON.stringify(manifest);
    tx.run("UPDATE export_artifacts SET record_json = ? WHERE id = ?", record, id);
    tx.run("DELETE FROM export_artifact_bodies WHERE id = ?", id);
  });
  return { path, record };
}
/** Full run port whose managed delete is replaced by a counting (optionally failing) stub. */
function countingPort(inner: ApplicationRunPort, calls: { n: number }, fail: () => boolean): ApplicationRunPort {
  return new Proxy(inner, { get(target, key) {
    if (key === "delete") return async (context: { id: string; generation: number }) => {
      calls.n++;
      return fail() ? { state: "delete_failed", context: { ...context }, nextAction: "retry_managed_delete" } : target.delete(context);
    };
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

test("receipt replays and duplicate confirmations queue no managed-delete pass; only new or re-armed work does", async () => {
  const f = await fixture();
  const a = project(f, "โครงการ replay", "หัวข้อ replay");
  const s1 = say(f, a, "ข้อความ replay-canary-121 ต้องลบ");
  await remember(f, a, s1);
  const calls = { n: 0 };
  await f.rt.queue.reconcile(countingPort(f.rt.port, calls, () => true));
  const preview = asPreview(f.rt.app.execute(actor(f), previewCommand(f, a, s1)));
  const confirm = confirmCommand(f, a, preview.preview.id);
  const first = asConfirmed(f.rt.app.execute(actor(f), confirm));
  await f.rt.queue.idle();
  const perPass = calls.n;
  expect(perPass).toBe(first.operation.contexts.length);
  expect(operation(f, a, first.operation.id).attempts).toBe(1);
  // Same request ID replays the stored receipt (still duplicate:false) without new work.
  expect(asConfirmed(f.rt.app.execute(actor(f), confirm)).duplicate).toBe(false);
  await f.rt.queue.idle();
  // A new request ID for the same preview is a duplicate confirmation without new work.
  expect(asConfirmed(f.rt.app.execute(actor(f), { ...confirmCommand(f, a, preview.preview.id) })).duplicate).toBe(true);
  await f.rt.queue.idle();
  expect(calls.n).toBe(perPass);
  expect(operation(f, a, first.operation.id).attempts).toBe(1);
  // An explicit owner retry re-arms once; replaying that retry does nothing more.
  const retry = retryCommand(f, a, first.operation.id);
  f.rt.app.execute(actor(f), retry); await f.rt.queue.idle();
  f.rt.app.execute(actor(f), retry); await f.rt.queue.idle();
  expect(calls.n).toBe(perPass * 2);
  expect(operation(f, a, first.operation.id).attempts).toBe(2);
});

test("obligations are discovered over every active task and truncation blocks confirmation", async () => {
  const f = await fixture();
  const a = project(f, "โครงการภาระ", "หัวข้อภาระ");
  const s1 = say(f, a, "alpha bravo charlie delta echo obligation-canary-131");
  const propose = (title: string) => f.rt.app.execute(actor(f), { kind: "task.propose", requestId: rid(), projectId: a.id, expectedRevision: topicRevision(f, a),
    payload: { topicId: a.topic.id, title, summary: "งานทั่วไป" } }).task.id as string;
  for (let i = 0; i < 205; i++) propose(`unrelated chore ${i}`);
  const late = propose("alpha bravo charlie delta follow-up");
  const preview = asPreview(f.rt.app.execute(actor(f), previewCommand(f, a, s1)));
  expect(preview.preview.affected.obligations.find(o => o.id === late)).toMatchObject({ kind: "task", effect: "retained_unchanged" });
  expect(preview.preview.blockers).toEqual([]);
  for (let i = 0; i < 100; i++) propose(`alpha bravo charlie delta item ${i}`);
  const crowded = asPreview(f.rt.app.execute(actor(f), previewCommand(f, a, s1)));
  expect(crowded.preview.truncated.obligations).toBe(true);
  expect(crowded.preview.blockers).toContain("inventory_truncated:obligations");
  expect(() => f.rt.app.execute(actor(f), confirmCommand(f, a, crowded.preview.id))).toThrow("memory_delete_blocked");
  expect(f.rt.app.task(actor(f), a.id, late).task.state).toBe("proposed");
});

test("retained backups and exports are found despite truncated or unknown coverage; unreadable manifests block", async () => {
  const f = await fixture();
  const a = project(f, "โครงการ coverage", "หัวข้อ coverage");
  const s1 = say(f, a, "ข้อความ coverage-canary-141 ต้องลบ");
  await remember(f, a, s1);
  const backup = await f.rt.app.execute(actor(f), { kind: "backup.create" as const, requestId: rid(), projectId: null,
    expectedRevision: f.rt.app.workspace(actor(f)).revision, payload: { note: "coverage backup" } });
  const exported = f.rt.app.execute(actor(f), exportCommand(f, a));
  // Simulate bounded/older manifests: the lineage is absent from coverage and completeness is unknown.
  f.rt.store.transaction(tx => {
    const b = JSON.parse(tx.get<{ j: string }>("SELECT record_json AS j FROM ops_backups WHERE id = ?", backup.manifest.id)!.j);
    tx.run("UPDATE ops_backups SET record_json = ? WHERE id = ?", JSON.stringify({ ...b, sourceGenerations: [] }), backup.manifest.id);
    const e = JSON.parse(tx.get<{ j: string }>("SELECT record_json AS j FROM export_artifacts WHERE id = ?", exported.manifest.id)!.j);
    delete e.completeness;
    tx.run("UPDATE export_artifacts SET record_json = ? WHERE id = ?", JSON.stringify({ ...e, coverage: { sources: [], claims: [] } }), exported.manifest.id);
  });
  const preview = asPreview(f.rt.app.execute(actor(f), previewCommand(f, a, s1)));
  expect(preview.preview.affected.backups).toContainEqual(expect.objectContaining({ id: backup.manifest.id, evidence: "whole_store_snapshot" }));
  expect(preview.preview.affected.exports).toContainEqual(expect.objectContaining({ id: exported.manifest.id, evidence: "affected_project" }));
  expect(preview.preview.blockers).toEqual([]);
  // Complete per-collection completeness without a coverage match is not proof of absence: still listed.
  f.rt.store.transaction(tx => {
    const e = JSON.parse(tx.get<{ j: string }>("SELECT record_json AS j FROM export_artifacts WHERE id = ?", exported.manifest.id)!.j);
    tx.run("UPDATE export_artifacts SET record_json = ? WHERE id = ?", JSON.stringify({ ...e, coverage: { sources: [], claims: [], truncated: false },
      completeness: { complete: true, collections: { sources: { included: 0, total: 0, truncated: false } } } }), exported.manifest.id);
  });
  const complete = asPreview(f.rt.app.execute(actor(f), previewCommand(f, a, s1)));
  expect(complete.preview.affected.exports).toContainEqual(expect.objectContaining({ id: exported.manifest.id, evidence: "affected_project" }));
  f.rt.store.transaction(tx => { tx.run("UPDATE ops_backups SET record_json = '{broken' WHERE id = ?", backup.manifest.id); });
  const blocked = asPreview(f.rt.app.execute(actor(f), previewCommand(f, a, s1)));
  expect(blocked.preview.blockers).toContain("unreadable_record:ops_backups");
  expect(() => f.rt.app.execute(actor(f), confirmCommand(f, a, blocked.preview.id))).toThrow("memory_delete_blocked");
});

test("app-owned exports holding deleted payload are purged as rows; legacy files gate completion", async () => {
  const f = await fixture();
  const a = project(f, "โครงการ export purge", "หัวข้อ export purge");
  const s1 = say(f, a, "ข้อความ export-canary-151 ต้องลบ");
  await remember(f, a, s1);
  const kept = f.rt.app.execute(actor(f), exportCommand(f, a));
  const stuck = f.rt.app.execute(actor(f), exportCommand(f, a));
  expect(exportBody(f, a, kept.manifest.id)).toContain("export-canary-151");
  const legacy = legacyExport(f, stuck.manifest.id);
  expect(readFileSync(legacy.path, "utf8")).toContain("export-canary-151");
  const preview = asPreview(f.rt.app.execute(actor(f), previewCommand(f, a, s1)));
  expect(preview.preview.affected.exports.map(e => e.id).sort()).toEqual([kept.manifest.id, stuck.manifest.id].sort());
  // The legacy file cannot be removed (a directory sits at its path): its scope stays pending, never complete.
  rmSync(legacy.path); mkdirSync(legacy.path);
  const confirmed = asConfirmed(f.rt.app.execute(actor(f), confirmCommand(f, a, preview.preview.id)));
  // The SQLite artifact (registry + body) is gone in the confirm transaction itself.
  expect(confirmed.operation.exports.find(e => e.id === kept.manifest.id)).toMatchObject({ storage: "sqlite", state: "purged" });
  expect(f.rt.store.read(tx => tx.all("SELECT id FROM export_artifacts WHERE project_id = ?", a.id))).toHaveLength(0);
  expect(f.rt.store.read(tx => tx.all("SELECT id FROM export_artifact_bodies WHERE id = ?", kept.manifest.id))).toHaveLength(0);
  expect(() => exportBody(f, a, kept.manifest.id)).toThrow("export_not_found");
  await reconcileDeletions(f.rt.store, f.rt.port as unknown as ApplicationRunPort, f.clock.now);
  const partial = operation(f, a, confirmed.operation.id);
  expect(partial.exports.find(e => e.id === stuck.manifest.id)).toMatchObject({ storage: "legacy_file", state: "pending", reason: "export_path_untrusted" });
  expect(partial.contexts.every(c => c.state === "deleted")).toBe(true);
  expect(partial.state).not.toBe("complete");
  expect(partial.scopes.find(s => s.scope === "local_exports")!.state).toBe("pending");
  rmSync(legacy.path, { recursive: true });
  await reconcileDeletions(f.rt.store, f.rt.port as unknown as ApplicationRunPort, f.clock.now);
  const done = operation(f, a, confirmed.operation.id);
  expect(done.state).toBe("complete");
  expect(done.exports.every(e => e.state === "purged")).toBe(true);
});

test("the deletion ledger fails closed on storage errors except the explicit pre-migration path", async () => {
  const f = await fixture();
  const a = project(f, "โครงการ ledger", "หัวข้อ ledger");
  const s1 = say(f, a, "ข้อความ ledger-canary-161");
  f.rt.store.transaction(tx => { tx.run("DROP TABLE deletion_ledger"); });
  expect(() => f.rt.app.deletionLedger(actor(f))).toThrow("deletion_ledger_unavailable");
  expect(() => f.rt.app.execute(actor(f), extractCommand(f, a, s1))).toThrow("deletion_ledger_unavailable");
  // Export fails closed (recorded as a failed export with no artifact) rather than publishing without the ledger.
  expect(() => f.rt.app.execute(actor(f), exportCommand(f, a))).toThrow("export_failed");
  expect(f.rt.store.read(tx => tx.all("SELECT id FROM export_artifacts WHERE project_id = ? AND record_json LIKE '%\"state\":\"valid\"%'", a.id))).toHaveLength(0);
  const preMigration = (version: number) => ({
    get: (sql: string) => { if (sql.startsWith("PRAGMA")) return { user_version: version }; throw new Error("no such table: deletion_ledger"); },
    all: () => { throw new Error("no such table: deletion_ledger"); }, run: () => {},
  }) as unknown as AppTransaction;
  expect(deletedSource(preMigration(16), s1)).toBe(false);
  expect(readDeletionLedger(preMigration(16))).toEqual([]);
  expect(() => deletedSource(preMigration(21), s1)).toThrow("deletion_ledger_unavailable");
  expect(() => readDeletionLedger(preMigration(21))).toThrow("deletion_ledger_unavailable");
});

test("legacy export purge only removes <legacy root>/<id>.json regular files, never a forged or symlinked path", async () => {
  const f = await fixture();
  const a = project(f, "โครงการ export root", "หัวข้อ export root");
  const s1 = say(f, a, "ข้อความ root-canary-171 ต้องลบ");
  await remember(f, a, s1);
  const forged = f.rt.app.execute(actor(f), exportCommand(f, a));
  const linked = f.rt.app.execute(actor(f), exportCommand(f, a));
  const forgedLegacy = legacyExport(f, forged.manifest.id), linkedLegacy = legacyExport(f, linked.manifest.id);
  const outside = join(f.root, "outside"); mkdirSync(outside);
  const victim = join(outside, `${forged.manifest.id}.json`); writeFileSync(victim, "unrelated owner file");
  const linkVictim = join(outside, "link-target.json"); writeFileSync(linkVictim, "symlink target must survive");
  // Persisted JSON is mutable: point one registration outside the root, and swap the other file for a symlink.
  f.rt.store.transaction(tx => {
    const row = JSON.parse(forgedLegacy.record);
    tx.run("UPDATE export_artifacts SET record_json = ? WHERE id = ?", JSON.stringify({ ...row, artifact: { ...row.artifact, path: victim } }), forged.manifest.id);
  });
  rmSync(linkedLegacy.path); symlinkSync(linkVictim, linkedLegacy.path);
  const preview = asPreview(f.rt.app.execute(actor(f), previewCommand(f, a, s1)));
  const confirmed = asConfirmed(f.rt.app.execute(actor(f), confirmCommand(f, a, preview.preview.id)));
  await reconcileDeletions(f.rt.store, f.rt.port as unknown as ApplicationRunPort, f.clock.now);
  const op = operation(f, a, confirmed.operation.id);
  expect(readFileSync(victim, "utf8")).toBe("unrelated owner file");
  expect(readFileSync(linkVictim, "utf8")).toBe("symlink target must survive");
  expect(op.exports.find(e => e.id === forged.manifest.id)).toMatchObject({ state: "pending", reason: "export_outside_authorized_root" });
  expect(op.exports.find(e => e.id === linked.manifest.id)).toMatchObject({ state: "pending", reason: "export_path_untrusted" });
  expect(existsSync(forgedLegacy.path)).toBe(true);
  expect(op.state).not.toBe("complete");
});

test("historical task proposals citing the deleted generation are disclosed and redacted; active current proposals block", async () => {
  const f = await fixture();
  const a = project(f, "โครงการประวัติงาน", "หัวข้อประวัติงาน");
  const proposed = f.rt.app.execute(actor(f), { kind: "task.propose", requestId: rid(), projectId: a.id, expectedRevision: topicRevision(f, a),
    payload: { topicId: a.topic.id, title: "งานเดิม history-canary-191", summary: "สรุปเดิม history-canary-191 ละเอียด" } });
  const edited = f.rt.app.execute(actor(f), { kind: "task.edit", requestId: rid(), projectId: a.id, expectedRevision: proposed.task.revision,
    payload: { taskId: proposed.task.id, title: "งานฉบับแก้", summary: "สรุปฉบับแก้" } });
  expect(edited.proposal.revision).toBe(2);
  const current = asPreview(f.rt.app.execute(actor(f), previewCommand(f, a, edited.proposal.source)));
  expect(current.preview.blockers).toContain(`active_task_current_proposal:${proposed.task.id}`);
  const preview = asPreview(f.rt.app.execute(actor(f), previewCommand(f, a, proposed.proposal.source)));
  expect(preview.preview.affected.taskProposals).toEqual([{ taskId: proposed.task.id, taskState: "proposed", proposalId: proposed.proposal.id,
    revision: 1, current: false, evidence: "provenance", effect: "redacted" }]);
  expect(preview.preview.blockers).toEqual([]);
  asConfirmed(f.rt.app.execute(actor(f), confirmCommand(f, a, preview.preview.id, true, preview.preview.wholeSession.required)));
  const task = f.rt.app.task(actor(f), a.id, proposed.task.id);
  expect(task.task.state).toBe("proposed");
  expect(task.task.title).toBe("งานฉบับแก้");
  const exported = f.rt.app.execute(actor(f), exportCommand(f, a));
  expect(exportBody(f, a, exported.manifest.id)).not.toContain("history-canary-191");
  const raw = f.rt.store.read(tx => [...tx.all<{ t: string }>("SELECT title || summary AS t FROM task_proposals"),
    ...tx.all<{ t: string }>("SELECT result_json AS t FROM command_receipts")].map(r => r.t).join("\n"));
  expect(raw).not.toContain("history-canary-191");
});

test("deleting the evidence an active ready-for-review task depends on is a named blocker, not a silent downgrade", async () => {
  const f = await fixture();
  const a = project(f, "โครงการหลักฐาน", "หัวข้อหลักฐาน");
  const proposed = f.rt.app.execute(actor(f), { kind: "task.propose", requestId: rid(), projectId: a.id, expectedRevision: topicRevision(f, a),
    payload: { topicId: a.topic.id, title: "ตรวจงานด้วยหลักฐาน", summary: "รอผลตรวจที่ครบ" } });
  const taskId = proposed.task.id as string;
  const accepted = f.rt.app.execute(actor(f), { kind: "task.accept", requestId: rid(), projectId: a.id, expectedRevision: proposed.task.revision,
    payload: { taskId, proposalId: proposed.proposal.id } });
  const evidence = f.rt.store.transaction(tx => {
    const source = commitOutputSource(tx, { projectId: a.id, participantId: "review", runId: rid(), text: "รายงานหลักฐาน evidence-canary-331 ครบถ้วน", committedAt: f.clock.now });
    return registerTaskEvidenceArtifact(tx, { projectId: a.id, taskId, source, outcome: "complete", workType: "review", deliveryState: null, now: f.clock.now });
  });
  f.rt.app.execute(actor(f), { kind: "task.set_policy", requestId: rid(), projectId: a.id, expectedRevision: f.rt.app.task(actor(f), a.id, taskId).task.revision,
    payload: { taskId, policyKind: "evidence_satisfied" } });
  void accepted;
  const ready = f.rt.app.task(actor(f), a.id, taskId).task;
  expect(ready.state).toBe("ready_for_review");
  const preview = asPreview(f.rt.app.execute(actor(f), previewCommand(f, a, evidence.source)));
  expect(preview.preview.affected.taskEvidence).toEqual([{ taskId, taskState: "ready_for_review", taskRevision: ready.revision,
    artifactId: evidence.id, revision: 1, latest: true, effect: "blocked_active_task" }]);
  expect(preview.preview.blockers).toContain(`active_task_evidence:${taskId}`);
  expect(() => f.rt.app.execute(actor(f), confirmCommand(f, a, preview.preview.id))).toThrow("memory_delete_blocked");
  expect(f.rt.app.source(actor(f), a.id, evidence.source).state).toBe("available");
  expect(f.rt.app.task(actor(f), a.id, taskId).task.state).toBe("ready_for_review");
  // The owner-visible remedy: complete the task on that evidence. A closed task's artifact keeps its identity and reads unavailable.
  f.rt.app.execute(actor(f), { kind: "task.complete", requestId: rid(), projectId: a.id, expectedRevision: f.rt.app.task(actor(f), a.id, taskId).task.revision,
    payload: { taskId } });
  const after = asPreview(f.rt.app.execute(actor(f), previewCommand(f, a, evidence.source)));
  expect(after.preview.affected.taskEvidence).toEqual([expect.objectContaining({ artifactId: evidence.id, taskState: "completed", effect: "reference_unavailable" })]);
  expect(after.preview.blockers).toEqual([]);
  asConfirmed(f.rt.app.execute(actor(f), confirmCommand(f, a, after.preview.id, true, after.preview.wholeSession.required)));
  expect(f.rt.app.task(actor(f), a.id, taskId).task.state).toBe("completed");
});

test("an active task quoting the deleted payload blocks until the owner edits it; previews never persist its title", async () => {
  const f = await fixture();
  const a = project(f, "โครงการสำเนาเจ้าของ", "หัวข้อสำเนาเจ้าของ");
  const text = "ข้อความ owner-copy-canary-341 ลับเฉพาะ";
  const m = say(f, a, text);
  const proposed = f.rt.app.execute(actor(f), { kind: "task.propose", requestId: rid(), projectId: a.id, expectedRevision: topicRevision(f, a),
    payload: { topicId: a.topic.id, title: `งาน ${text}`, summary: "ติดตามต่อ" } });
  const taskId = proposed.task.id as string;
  const blocked = asPreview(f.rt.app.execute(actor(f), previewCommand(f, a, m)));
  expect(blocked.preview.blockers).toContain(`active_task_current_proposal:${taskId}`);
  expect(blocked.preview.affected.obligations).toContainEqual({ kind: "task", id: taskId, revision: proposed.task.revision, evidence: "quoted_copy", effect: "blocked_owner_copy" });
  expect(blocked.preview.affected.obligations.every(o => !("title" in o))).toBe(true);
  const persisted = f.rt.store.read(tx => tx.get<{ j: string }>("SELECT record_json AS j FROM deletion_previews WHERE id = ?", blocked.preview.id)!.j);
  expect(persisted).not.toContain("owner-copy-canary-341");
  expect(() => f.rt.app.execute(actor(f), confirmCommand(f, a, blocked.preview.id))).toThrow("memory_delete_blocked");
  // The owner edits the copy away; the historical revision and its text source are then redacted/deleted with M.
  f.rt.app.execute(actor(f), { kind: "task.edit", requestId: rid(), projectId: a.id, expectedRevision: proposed.task.revision,
    payload: { taskId, title: "งานฉบับแก้ไม่มีสำเนา", summary: "ติดตามต่อ" } });
  const preview = asPreview(f.rt.app.execute(actor(f), previewCommand(f, a, m)));
  expect(preview.preview.blockers).toEqual([]);
  expect(preview.preview.affected.taskProposals).toEqual([expect.objectContaining({ proposalId: proposed.proposal.id, current: false, effect: "redacted" })]);
  asConfirmed(f.rt.app.execute(actor(f), confirmCommand(f, a, preview.preview.id, true, preview.preview.wholeSession.required)));
  const task = f.rt.app.task(actor(f), a.id, taskId).task;
  expect(task).toMatchObject({ state: "proposed", title: "งานฉบับแก้ไม่มีสำเนา" });
  const raw = f.rt.store.read(tx => [
    ...tx.all<{ t: string }>("SELECT title || summary AS t FROM task_proposals"), ...tx.all<{ t: string }>("SELECT title || summary AS t FROM tasks"),
    ...tx.all<{ t: string }>("SELECT result_json AS t FROM command_receipts"), ...tx.all<{ t: string | null }>("SELECT content_text AS t FROM source_versions"),
    ...tx.all<{ t: string }>("SELECT record_json AS t FROM deletion_previews")].map(r => r.t ?? "").join("\n"));
  expect(raw).not.toContain("owner-copy-canary-341");
});

test("a current owner decision quoting the deleted payload blocks until superseded; the superseded copy is redacted", async () => {
  const f = await fixture();
  const a = project(f, "โครงการมติสำเนา", "หัวข้อมติสำเนา");
  const text = "ข้อความ decision-copy-canary-351 ลับเฉพาะ";
  const m = say(f, a, text);
  f.rt.app.execute(actor(f), dispatch(f, a, "เตรียมข้อเสนอให้เจ้าของตัดสิน"));
  await drain(f);
  const discussion = f.rt.app.discussions(actor(f), a.id, a.topic.id)[0]!;
  f.rt.app.execute(actor(f), { kind: "decision.synthesize", requestId: rid(), projectId: a.id, expectedRevision: discussion.revision,
    payload: { discussionId: discussion.id, limits: { ...f.config.jobs.maximum } } });
  await drain(f);
  const proposal = f.rt.app.decision(actor(f), a.id, a.topic.id).proposal!;
  const decided = f.rt.app.execute(actor(f), { kind: "decision.accept", requestId: rid(), projectId: a.id, expectedRevision: proposal.revision,
    payload: { proposalId: proposal.id, optionId: null, conclusion: `ตัดสินตาม ${text}`, rationale: "เจ้าของตัดสินเอง" } }).decision!;
  const blocked = asPreview(f.rt.app.execute(actor(f), previewCommand(f, a, m)));
  expect(blocked.preview.blockers).toContain(`owner_decision_copy:${decided.id}`);
  expect(blocked.preview.affected.obligations).toContainEqual(expect.objectContaining({ kind: "decision", id: decided.id, evidence: "quoted_copy", effect: "blocked_owner_copy" }));
  expect(() => f.rt.app.execute(actor(f), confirmCommand(f, a, blocked.preview.id, true, blocked.preview.wholeSession.required))).toThrow("memory_delete_blocked");
  const current = f.rt.app.decision(actor(f), a.id, a.topic.id).proposal!;
  f.rt.app.execute(actor(f), { kind: "decision.supersede", requestId: rid(), projectId: a.id, expectedRevision: current.revision,
    payload: { decisionId: decided.id, proposalId: current.id, optionId: null, conclusion: "มติใหม่ไม่มีสำเนา", rationale: "เจ้าของเปลี่ยนมติ" } });
  const preview = asPreview(f.rt.app.execute(actor(f), previewCommand(f, a, m)));
  expect(preview.preview.blockers).toEqual([]);
  expect(preview.preview.affected.obligations).toContainEqual(expect.objectContaining({ kind: "decision", id: decided.id, effect: "redacted" }));
  asConfirmed(f.rt.app.execute(actor(f), confirmCommand(f, a, preview.preview.id, true, preview.preview.wholeSession.required)));
  const raw = f.rt.store.read(tx => [...tx.all<{ t: string }>("SELECT conclusion || rationale AS t FROM owner_decisions"),
    ...tx.all<{ t: string }>("SELECT result_json AS t FROM command_receipts")].map(r => r.t).join("\n"));
  expect(raw).not.toContain("decision-copy-canary-351");
  expect(raw).toContain("มติใหม่ไม่มีสำเนา");
  // The decision's own memory source (committed from the same wording, fenced on supersession) is a copy deleted with M.
  const decisionSource = f.rt.store.read(tx => tx.get<{ sourceId: string; revision: number; generation: number }>(
    "SELECT source_id AS sourceId, source_revision AS revision, source_generation AS generation FROM memory_decision_sources WHERE decision_id = ?", decided.id)!);
  expect(preview.preview.affected.sources).toContainEqual({ projectId: a.id, source: decisionSource, relation: "quoted_copy" });
  expect(f.rt.store.read(tx => tx.get<{ t: string | null }>("SELECT content_text AS t FROM source_versions WHERE source_id = ? AND revision = ? AND generation = ?",
    decisionSource.sourceId, decisionSource.revision, decisionSource.generation)!.t)).toBeNull();
  expect(f.rt.app.deletionLedger(actor(f)).tombstones).toContainEqual(expect.objectContaining({ kind: "source", ...decisionSource }));
  const allText = f.rt.store.read(tx => tx.all<{ t: string | null }>("SELECT content_text AS t FROM source_versions").map(r => r.t ?? "").join("\n"));
  expect(allText).not.toContain("decision-copy-canary-351");
  const backup = await f.rt.app.execute(actor(f), { kind: "backup.create" as const, requestId: rid(), projectId: null,
    expectedRevision: f.rt.app.workspace(actor(f)).revision, payload: { note: "after decision copy delete" } });
  expect(Buffer.from(readFileSync(backup.manifest.artifact.path)).includes(Buffer.from("decision-copy-canary-351"))).toBe(false);
});

test("backups and incomplete-coverage exports are listed without trusting wall-clock order", async () => {
  const f = await fixture();
  const a = project(f, "โครงการนาฬิกา", "หัวข้อนาฬิกา");
  const backup = await f.rt.app.execute(actor(f), { kind: "backup.create" as const, requestId: rid(), projectId: null,
    expectedRevision: f.rt.app.workspace(actor(f)).revision, payload: { note: "clock backup" } });
  const exported = f.rt.app.execute(actor(f), exportCommand(f, a));
  f.rt.store.transaction(tx => {
    const e = JSON.parse(tx.get<{ j: string }>("SELECT record_json AS j FROM export_artifacts WHERE id = ?", exported.manifest.id)!.j);
    delete e.completeness;
    tx.run("UPDATE export_artifacts SET record_json = ? WHERE id = ?", JSON.stringify({ ...e, coverage: { sources: [], claims: [], truncated: true } }), exported.manifest.id);
  });
  // The clock moves backwards: the source commits "before" artifacts that were made earlier.
  f.clock.now -= 3_600_000;
  const s1 = say(f, a, "ข้อความ clock-canary-201 ต้องลบ");
  const preview = asPreview(f.rt.app.execute(actor(f), previewCommand(f, a, s1)));
  expect(preview.preview.affected.backups).toContainEqual(expect.objectContaining({ id: backup.manifest.id, evidence: "whole_store_snapshot" }));
  expect(preview.preview.affected.exports).toContainEqual(expect.objectContaining({ id: exported.manifest.id, evidence: "affected_project" }));
});

test("a complete no-history export holding a task copy of the deleted message is purged with it", async () => {
  const f = await fixture();
  const a = project(f, "โครงการสำเนางาน", "หัวข้อสำเนางาน");
  const other = project(f, "โครงการอื่น", "หัวข้ออื่น");
  const text = "ข้อความ task-copy-canary-321 ต้องลบ";
  const m = say(f, a, text);
  // A dismissed (inactive) task quoting M verbatim: the export serializes its raw text without covering M.
  const proposed = f.rt.app.execute(actor(f), { kind: "task.propose", requestId: rid(), projectId: a.id, expectedRevision: topicRevision(f, a),
    payload: { topicId: a.topic.id, title: "สำเนางาน", summary: `คัดลอก: ${text}` } });
  f.rt.app.execute(actor(f), { kind: "task.dismiss", requestId: rid(), projectId: a.id, expectedRevision: proposed.task.revision,
    payload: { taskId: proposed.task.id, proposalId: proposed.proposal.id, reason: "ไม่ทำ" } });
  const exported = f.rt.app.execute(actor(f), { ...exportCommand(f, a), payload: { includeHistory: false, note: "no history" } });
  const unrelated = f.rt.app.execute(actor(f), exportCommand(f, other));
  expect(exportBody(f, a, exported.manifest.id)).toContain("task-copy-canary-321");
  const stored = f.rt.store.read(tx => JSON.parse(tx.get<{ j: string }>("SELECT record_json AS j FROM export_artifacts WHERE id = ?", exported.manifest.id)!.j));
  expect(stored.completeness.complete).toBe(true);
  expect(JSON.stringify(stored.coverage)).not.toContain(m.sourceId);
  const preview = asPreview(f.rt.app.execute(actor(f), previewCommand(f, a, m)));
  expect(preview.preview.affected.exports.map(e => e.id)).toEqual([exported.manifest.id]);
  // The task's own text source quotes M verbatim: it is a copy deleted with M, and the inactive task's text is redacted.
  expect(preview.preview.affected.sources).toContainEqual({ projectId: a.id, source: proposed.proposal.source, relation: "quoted_copy" });
  expect(preview.preview.affected.taskProposals).toEqual([expect.objectContaining({ proposalId: proposed.proposal.id, evidence: "provenance", effect: "redacted" })]);
  expect(preview.preview.blockers).toEqual([]);
  const confirmed = asConfirmed(f.rt.app.execute(actor(f), confirmCommand(f, a, preview.preview.id, true, preview.preview.wholeSession.required)));
  expect(confirmed.operation.exports).toEqual([expect.objectContaining({ id: exported.manifest.id, storage: "sqlite", state: "purged" })]);
  expect(() => exportBody(f, a, exported.manifest.id)).toThrow("export_not_found");
  expect(exportBody(f, other, unrelated.manifest.id).length).toBeGreaterThan(0);
  expect(f.rt.app.source(actor(f), a.id, proposed.proposal.source).state).toBe("unavailable");
  const fresh = f.rt.app.execute(actor(f), { ...exportCommand(f, a), payload: { includeHistory: true, note: "after delete" } });
  expect(exportBody(f, a, fresh.manifest.id)).not.toContain("task-copy-canary-321");
});

test("legacy operations without export scopes are reconstructed and downgraded until exports are purged", async () => {
  const f = await fixture();
  const a = project(f, "โครงการ legacy", "หัวข้อ legacy");
  const s1 = say(f, a, "ข้อความ legacy-canary-211 ต้องลบ");
  await remember(f, a, s1);
  const exported = f.rt.app.execute(actor(f), exportCommand(f, a));
  const legacy = legacyExport(f, exported.manifest.id);
  const preview = asPreview(f.rt.app.execute(actor(f), previewCommand(f, a, s1)));
  const confirmed = asConfirmed(f.rt.app.execute(actor(f), confirmCommand(f, a, preview.preview.id)));
  await reconcileDeletions(f.rt.store, f.rt.port as unknown as ApplicationRunPort, f.clock.now);
  expect(existsSync(legacy.path)).toBe(false);
  // Simulate an operation persisted before export scopes: complete, no scopes, registration and file still present.
  writeFileSync(legacy.path, "legacy-canary-211 retained");
  f.rt.store.transaction(tx => {
    tx.run("INSERT INTO export_artifacts (id, project_id, created_at, record_json) VALUES (?, ?, ?, ?)", exported.manifest.id, a.id, exported.manifest.createdAt, legacy.record);
    const op = JSON.parse(tx.get<{ j: string }>("SELECT record_json AS j FROM deletion_operations WHERE id = ?", confirmed.operation.id)!.j);
    delete op.exports; delete op.scopes;
    tx.run("UPDATE deletion_operations SET state = 'complete', record_json = ? WHERE id = ?", JSON.stringify({ ...op, state: "complete" }), confirmed.operation.id);
  });
  expect(reconstructLegacyExportScopes(f.rt.store, f.clock.now)).toBe(1);
  expect(reconstructLegacyExportScopes(f.rt.store, f.clock.now)).toBe(0);
  const rebuilt = operation(f, a, confirmed.operation.id);
  expect(rebuilt.state).toBe("pending");
  expect(rebuilt.exports).toMatchObject([{ id: exported.manifest.id, storage: "legacy_file", state: "pending" }]);
  await reconcileDeletions(f.rt.store, f.rt.port as unknown as ApplicationRunPort, f.clock.now);
  expect(existsSync(legacy.path)).toBe(false);
  expect(operation(f, a, confirmed.operation.id).state).toBe("complete");
});

const commitDelivery = (f: Fixture, p: Project, text: string) => f.rt.app.execute(actor(f), { kind: "delivery.commit" as const, requestId: rid(), projectId: p.id,
  expectedRevision: projectRevision(f, p), payload: { kind: "report" as const, text, dedupeKey: `delete-${rid()}` } });

test("local delivery copies linked by provenance or quoting the payload are cancelled and redacted", async () => {
  const f = await fixture();
  const web = createWebHandler(f.rt.app), req = webRequest(f);
  const a = project(f, "โครงการส่งต่อ", "หัวข้อส่งต่อ");
  // Provenance: the owner deletes the delivery report's own source generation.
  const own = commitDelivery(f, a, "รายงานลับ delivery-canary-221 ห้ามส่ง");
  const ownPreview = asPreview(f.rt.app.execute(actor(f), previewCommand(f, a, { sourceId: own.report.sourceId, revision: own.report.sourceRevision, generation: own.report.sourceGeneration })));
  expect(ownPreview.preview.affected.deliveries).toEqual([{ intentId: own.intent.id, reportId: own.report.id, projectId: a.id,
    status: own.intent.status, evidence: "provenance", effect: "cancel_and_redact" }]);
  asConfirmed(f.rt.app.execute(actor(f), confirmCommand(f, a, ownPreview.preview.id)));
  // Quoted copy: a delivery repeats a message the owner later deletes.
  const s1 = say(f, a, "ข้อความ quoted-delivery-231 ต้องลบ");
  const quoted = commitDelivery(f, a, "สรุปส่งต่อ: ข้อความ quoted-delivery-231 ต้องลบ");
  const preview = asPreview(f.rt.app.execute(actor(f), previewCommand(f, a, s1)));
  expect(preview.preview.affected.deliveries).toContainEqual(expect.objectContaining({ intentId: quoted.intent.id, evidence: "quoted_text" }));
  asConfirmed(f.rt.app.execute(actor(f), confirmCommand(f, a, preview.preview.id)));
  for (const intent of [own.intent, quoted.intent]) {
    const detail = f.rt.app.delivery(actor(f), a.id, intent.id) as { intent: { status: string; failureReason: string | null } };
    expect(detail.intent.status).toBe("cancelled");
    expect(detail.intent.failureReason).toBe("source_deleted");
    const body = await (await web(req(`/api/projects/${a.id}/delivery/${intent.id}`))).text();
    expect(body).not.toContain("delivery-canary-221");
    expect(body).not.toContain("quoted-delivery-231");
  }
  const list = JSON.stringify(f.rt.app.deliveries(actor(f), a.id));
  expect(list).not.toContain("delivery-canary-221");
  expect(list).not.toContain("quoted-delivery-231");
  const exported = f.rt.app.execute(actor(f), exportCommand(f, a));
  const artifact = exportBody(f, a, exported.manifest.id);
  expect(artifact).not.toContain("delivery-canary-221");
  expect(artifact).not.toContain("quoted-delivery-231");
  const raw = f.rt.store.read(tx => [...tx.all<{ t: string }>("SELECT record_json AS t FROM delivery_intents"),
    ...tx.all<{ t: string }>("SELECT record_json AS t FROM delivery_reports")].map(r => r.t).join("\n"));
  expect(raw).not.toContain("delivery-canary-221");
  expect(raw).not.toContain("quoted-delivery-231");
});

test("a definitively failed delivery previews redact_keep_state and confirm keeps that state while redacting", async () => {
  const f = await fixture();
  const a = project(f, "โครงการส่งล้มเหลว", "หัวข้อส่งล้มเหลว");
  const own = commitDelivery(f, a, "รายงานลับ failed-canary-251 ห้ามส่ง");
  // A definitive provider rejection: the outbox treats this as terminal and never cancels it.
  f.rt.store.transaction(tx => {
    const row = JSON.parse(tx.get<{ j: string }>("SELECT record_json AS j FROM delivery_intents WHERE id = ?", own.intent.id)!.j);
    Object.assign(row, { status: "failed", remote: "rejected", failureReason: "provider_rejected", nextAction: "inspect_failure", revision: row.revision + 1 });
    tx.run("UPDATE delivery_intents SET record_json = ? WHERE id = ?", JSON.stringify(row), own.intent.id);
  });
  const preview = asPreview(f.rt.app.execute(actor(f), previewCommand(f, a, { sourceId: own.report.sourceId, revision: own.report.sourceRevision, generation: own.report.sourceGeneration })));
  expect(preview.preview.affected.deliveries).toEqual([{ intentId: own.intent.id, reportId: own.report.id, projectId: a.id,
    status: "failed", evidence: "provenance", effect: "redact_keep_state" }]);
  asConfirmed(f.rt.app.execute(actor(f), confirmCommand(f, a, preview.preview.id)));
  const detail = f.rt.app.delivery(actor(f), a.id, own.intent.id) as { intent: { status: string; failureReason: string | null } };
  // The advertised effect matches the final state: status and failure reason kept, text redacted.
  expect(detail.intent).toMatchObject({ status: "failed", failureReason: "provider_rejected" });
  const raw = f.rt.store.read(tx => [...tx.all<{ t: string }>("SELECT record_json AS t FROM delivery_intents"),
    ...tx.all<{ t: string }>("SELECT record_json AS t FROM delivery_reports")].map(r => r.t).join("\n"));
  expect(raw).not.toContain("failed-canary-251");
});

test("quoted-copy cleanup covers the whole payload set and names unsafe short or oversized sets", async () => {
  const f = await fixture();
  const a = project(f, "โครงการ scrub", "หัวข้อ scrub");
  const s1 = say(f, a, "ข้อความ scrub-canary-241 ต้องลบ");
  const [c1] = await remember(f, a, s1);
  // 600 distinct affected payloads; an unlinked output quotes the last one in sort order.
  const last = "zz-scrub-payload-599";
  f.rt.store.transaction(tx => {
    const row = tx.get<{ extraction_id: string; record_json: string }>("SELECT extraction_id, record_json FROM memory_claims WHERE id = ?", c1!.claimId)!;
    const claim = JSON.parse(row.record_json) as MemoryClaim;
    for (let i = 0; i < 600; i++) {
      const id = rid(), text = i === 599 ? last : `aa-scrub-payload-${String(i).padStart(3, "0")}`;
      tx.run("INSERT INTO memory_claims (id, project_id, extraction_id, revision, generation, record_json) VALUES (?, ?, ?, 1, 1, ?)",
        id, a.id, row.extraction_id, JSON.stringify({ ...claim, claimId: id, text, quote: text }));
    }
    commitOutputSource(tx, { projectId: a.id, participantId: "fixture", runId: rid(), text: `unlinked note quoting ${last}`, committedAt: f.clock.now });
  });
  const preview = asPreview(f.rt.app.execute(actor(f), previewCommand(f, a, s1)));
  expect(preview.preview.blockers).toEqual([]);
  asConfirmed(f.rt.app.execute(actor(f), confirmCommand(f, a, preview.preview.id)));
  const outputs = f.rt.store.read(tx => tx.all<{ t: string | null }>("SELECT content_text AS t FROM source_versions").map(r => r.t ?? "").join("\n"));
  expect(outputs).not.toContain(last);
  expect(outputs).toContain("unlinked note quoting");
  // A short payload with an unlinked copy cannot be scrubbed safely: named blocker.
  const short = say(f, a, "ลับมาก");
  commitDelivery(f, a, "แจ้งเตือน ลับมาก วันนี้");
  const blocked = asPreview(f.rt.app.execute(actor(f), previewCommand(f, a, short)));
  expect(blocked.preview.blockers).toContain("short_payload_unlinked_copy");
  expect(() => f.rt.app.execute(actor(f), confirmCommand(f, a, blocked.preview.id))).toThrow("memory_delete_blocked");
  // A short payload with no unlinked copy deletes normally.
  const alone = say(f, a, "เฉพาะ");
  const clean = asPreview(f.rt.app.execute(actor(f), previewCommand(f, a, alone)));
  expect(clean.preview.blockers).toEqual([]);
  // More distinct payloads than the scrub bound is a named blocker, never a silent partial scrub.
  const s2 = say(f, a, "ข้อความ bound-canary-251 ต้องลบ");
  f.rt.store.transaction(tx => {
    const row = tx.get<{ extraction_id: string; record_json: string }>("SELECT extraction_id, record_json FROM memory_claims WHERE id = ?", c1!.claimId)!;
    const claim = JSON.parse(row.record_json) as MemoryClaim;
    for (let i = 0; i < 2001; i++) {
      const id = rid();
      tx.run("INSERT INTO memory_claims (id, project_id, extraction_id, revision, generation, record_json) VALUES (?, ?, ?, 1, 1, ?)",
        id, a.id, row.extraction_id, JSON.stringify({ ...claim, claimId: id, status: "active", source: { ...s2 }, text: `bound-text-${i}-xxxxxxxx`, quote: `bound-quote-${i}-xxxxxxxx` }));
    }
  });
  const oversized = asPreview(f.rt.app.execute(actor(f), previewCommand(f, a, s2)));
  expect(oversized.preview.blockers).toContain("scrub_set_exceeds_bound");
});

test("deletion previews report verified backup integrity, never the persisted manifest state", async () => {
  const f = await fixture();
  const a = project(f, "โครงการ integrity", "หัวข้อ integrity");
  const s1 = say(f, a, "ข้อความ integrity-canary-261 ต้องลบ");
  const backup = () => f.rt.app.execute(actor(f), { kind: "backup.create" as const, requestId: rid(), projectId: null,
    expectedRevision: f.rt.app.workspace(actor(f)).revision, payload: { note: "integrity backup" } });
  const good = await backup(), gone = await backup();
  rmSync(gone.manifest.artifact.path);
  expect(f.rt.app.backup(actor(f), gone.manifest.id).integrity.state).toBe("invalid");
  const stored = f.rt.store.read(tx => JSON.parse(tx.get<{ j: string }>("SELECT record_json AS j FROM ops_backups WHERE id = ?", gone.manifest.id)!.j).state);
  const preview = asPreview(f.rt.app.execute(actor(f), previewCommand(f, a, s1)));
  const listed = (id: string) => preview.preview.affected.backups.find(b => b.id === id)!;
  expect(listed(good.manifest.id)).toMatchObject({ state: "verified", reason: null });
  expect(listed(gone.manifest.id)).toMatchObject({ state: "incomplete", reason: "image_missing" });
  expect(listed(gone.manifest.id).state).not.toBe(stored);
  // Without a trusted backup directory nothing is verified: entries read as unchecked.
  const unverified = f.rt.store.transaction(tx => prepareDeletionPreview(tx, previewCommand(f, a, s1), projectRevision(f, a), f.clock.now));
  expect(unverified.affected.backups.every(b => b.state === "unchecked")).toBe(true);
});
