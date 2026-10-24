import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Application } from "../src/application";
import { readConfig } from "../src/config";
import {
  reconcileDeletions,
  type DeleteCommand, type DeletionConfirmReceipt, type DeletionReceipt,
} from "../src/memory/delete";
import { scanExportSecrets } from "../src/ops/export";
import { memoryExtractionMarker, memoryExtractionWork, scriptedMemoryResult } from "../src/memory/extract";
import type { ClaimReference, MemoryClaim } from "../src/memory/types";
import type { SourceReference } from "../src/sources";
import { JobQueue } from "../src/jobs/queue";
import { ScriptedRunPort, fixtureOutcome, withContextAnswer } from "../src/team/scripted-port";
import type { ApplicationRunPort } from "../src/team/run-port";
import type { ApplicationRunRequest, RoleRoute } from "../src/team/types";
import { coordinatorSynthesisMarker, coordinatorSynthesisWork } from "../src/team/decisions";
import { discussionPlanWork, specialistAnalysisWork } from "../src/team/dispatch";
import {
  FakeGitHubFixture, TrustedGitHubConnector, ensurePrSchema, fixturePull,
  mutateMonitor, pollMonitorCatchUp, prMonitorIdentity, TRIGGER_POLICY_VERSION,
  type EnableMonitorCommand,
} from "../src/pr";
import { TransactionStore } from "../src/store";
import { createWebHandler } from "../src/web";

const roots: string[] = [], stores: TransactionStore[] = [], live: JobQueue[] = [];
afterEach(async () => {
  for (const q of live.splice(0)) { q.close(); await q.idle(); }
  for (const s of stores.splice(0)) s.close();
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});
const rid = () => crypto.randomUUID(), epoch = 1800000000000, password = "ops-export-owner-password-1";
const grok: RoleRoute = { provider: "grok", model: "fixture-grok-exact", authRoute: "owner-grok" };
type Script = (request: ApplicationRunRequest, signal: AbortSignal) => unknown | Promise<unknown>;
type Config = ReturnType<typeof readConfig>;
const sha = (n: number) => n.toString(16).padStart(40, "0");

function boot(config: Config, hooks: { extract: Script; specialist: Script }, clock: { now: number }, backupDir: string, exportDir: string) {
  const store = new TransactionStore(config.databasePath); stores.push(store);
  const script = (request: ApplicationRunRequest, signal: AbortSignal, observe: (event: never) => void) =>
    request.instructions.operator.includes(memoryExtractionMarker) ? hooks.extract(request, signal)
      : request.instructions.operator.includes(coordinatorSynthesisMarker) ? fixtureOutcome("complete", JSON.stringify(synthesisJson(request)))
      : hooks.specialist(request, signal);
  const port = new ScriptedRunPort(store, config.team, config.jobs.outputBytes, script, () => false, () => false);
  const now = () => clock.now;
  const queue = new JobQueue(store, config.jobs, [memoryExtractionWork(store, config, port, now), discussionPlanWork(),
    specialistAnalysisWork(store, config, port, now), coordinatorSynthesisWork(store, config, port, now)], { now }); live.push(queue);
  const nativeSnapshot = { available: () => true, snapshot: () => ({ refs: [] as { id: string; generation: number }[], bytes: 128, engine: "scripted-fixture-v1" }) };
  const app = new Application(store, config, { jobs: queue, now, backupDir, exportDir, nativeSnapshot });
  return { store, port, queue, app };
}

function synthesisJson(request: ApplicationRunRequest) {
  const citations = request.manifest.sources.map(source => ({ ...source.reference }));
  return { question: "เจ้าของจะเลือกทางใด", disagreement: false, consensus: true, options: [
    { id: "first", label: "ทางแรก ไทย", rationale: "ตามผลวิเคราะห์", citations },
    { id: "second", label: "second English", rationale: "alternative", citations },
  ] };
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "jit-ops-export-")); roots.push(root);
  const config = readConfig({ JIT_DATABASE: join(root, "state.sqlite") }), clock = { now: epoch };
  const defaults = {
    extract: ((request: ApplicationRunRequest) => scriptedMemoryResult(request, true)) as Script,
    specialist: ((request: ApplicationRunRequest) => fixtureOutcome("complete", withContextAnswer("ตอบจำลอง", request, config.jobs.outputBytes))) as Script,
  };
  const hooks = { ...defaults };
  const rt = boot(config, hooks, clock, join(root, "backups"), join(root, "exports"));
  await rt.app.setupOwner(password);
  const f = { root, config, clock, hooks, defaults, rt, token: await rt.app.login(password), roles: { tech: "", coordinator: "" } };
  const owner = rt.app.authenticate(f.token).actor;
  f.roles.tech = rt.app.execute(owner, { kind: "role.save", projectId: null, requestId: rid(), expectedRevision: rt.app.team(owner).ownerRevision,
    payload: { roleId: null, name: "เทคโนโลยี", kind: "specialist", responsibility: "วิเคราะห์ฐานข้อมูลและโครงสร้างซอฟต์แวร์", enabled: true, route: grok } }).role!.id;
  f.roles.coordinator = rt.app.execute(owner, { kind: "role.save", projectId: null, requestId: rid(), expectedRevision: rt.app.team(owner).ownerRevision,
    payload: { roleId: null, name: "ผู้ประสานงาน", kind: "coordinator", responsibility: "สรุปความเห็นต่างให้เจ้าของตัดสิน", enabled: true, route: grok } }).role!.id;
  return f;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const actor = (f: Fixture) => f.rt.app.authenticate(f.token).actor;
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
const asDeletePreview = (value: unknown): DeletionReceipt => value as DeletionReceipt;
const asDeleteConfirmed = (value: unknown): DeletionConfirmReceipt => value as DeletionConfirmReceipt;
function extractCommand(f: Fixture, p: Project, source: SourceReference) {
  return { kind: "memory.extract" as const, requestId: rid(), projectId: p.id, expectedRevision: projectRevision(f, p),
    payload: { topicId: p.topic.id, roleId: f.roles.tech, source, dependencies: [] as ClaimReference[], limits: { ...f.config.jobs.maximum } } };
}
async function remember(f: Fixture, p: Project, source: SourceReference): Promise<MemoryClaim[]> {
  const before = new Set(f.rt.app.memory(actor(f), p.id).items.flatMap(item => item.state === "available" ? [item.claim.claimId] : []));
  f.rt.app.execute(actor(f), extractCommand(f, p, source)); await drain(f);
  return f.rt.app.memory(actor(f), p.id).items.flatMap(item => item.state === "available" && !before.has(item.claim.claimId) ? [item.claim] : []);
}
const exportCommand = (f: Fixture, p: Project, includeHistory: boolean, requestId = rid()) => ({
  kind: "export.create" as const, requestId, projectId: p.id, expectedRevision: projectRevision(f, p),
  payload: { includeHistory, note: "test export" },
});
function enableMonitor(f: Fixture, p: Project, github: FakeGitHubFixture) {
  const command: EnableMonitorCommand = { kind: "pr.monitor.enable", requestId: rid(), projectId: p.id, expectedRevision: projectRevision(f, p),
    payload: { repository: { host: "github.com", owner: "acme", name: "widgets" }, apiBase: "https://api.github.com",
      allowed: { issues: true, specs: true, ci: true }, acceptPolicyVersion: TRIGGER_POLICY_VERSION } };
  return f.rt.store.transaction(tx => {
    ensurePrSchema(tx); prMonitorIdentity(command);
    const monitor = mutateMonitor(tx, command, f.clock.now).monitor;
    const conn = new TrustedGitHubConnector(github, monitor, join(f.root, "cache"));
    return { monitor, conn };
  });
}

/** Builds the rich two-project fixture: tasks, decision, corrected/forgotten/deleted memory, delivery, stale PR. */
async function rich(f: Fixture) {
  const a = project(f, "โครงการส่งออก ไทย/English 🧠", "หัวข้อหลัก ไทย");
  const b = project(f, "Second project English", "B topic");
  // Memory fixtures in A.
  const sKeep = say(f, a, "ความรู้ที่เก็บไว้ hello world 🌏");
  const [keep] = await remember(f, a, sKeep);
  const sWrong = say(f, a, "ข้อความที่ผิด quoted-passage-007!");
  const [wrong] = await remember(f, a, sWrong);
  const sFix = say(f, a, "ข้อความที่ถูก quoted-passage-007! จบ");
  const corrected = f.rt.app.execute(actor(f), { kind: "memory.correct" as const, requestId: rid(), projectId: a.id, expectedRevision: projectRevision(f, a),
    payload: { claim: ref(wrong!), text: "ข้อความที่แก้แล้ว (corrected) ✓", quote: "quoted-passage-007!", source: { ...sFix }, reason: "แก้ให้ถูก" } });
  const sForget = say(f, a, "เรื่องลืม forget-me-008 ไม่ใช้แล้ว");
  const [forgotten] = await remember(f, a, sForget);
  f.rt.app.execute(actor(f), { kind: "memory.forget" as const, requestId: rid(), projectId: a.id, expectedRevision: projectRevision(f, a),
    payload: { claim: ref(forgotten!), reason: "เจ้าของขอให้ลืม", acknowledged: true } });
  const sDel = say(f, a, "ลบออก delete-me-009 ทิ้ง");
  const [doomed] = await remember(f, a, sDel);
  // Tasks: one proposed, one accepted.
  const proposed = f.rt.app.execute(actor(f), { kind: "task.propose", requestId: rid(), projectId: a.id, expectedRevision: topicRevision(f, a),
    payload: { topicId: a.topic.id, title: "งานค้าง proposed task", summary: "summary with Unicode ไทย" } });
  const toAccept = f.rt.app.execute(actor(f), { kind: "task.propose", requestId: rid(), projectId: a.id, expectedRevision: topicRevision(f, a),
    payload: { topicId: a.topic.id, title: "งานรับรอง accepted", summary: "accepted summary" } });
  f.rt.app.execute(actor(f), { kind: "task.accept", requestId: rid(), projectId: a.id, expectedRevision: toAccept.task.revision,
    payload: { taskId: toAccept.task.id, proposalId: toAccept.proposal.id } });
  // Decision through the full coordinator flow.
  f.rt.app.execute(actor(f), { kind: "team.dispatch", requestId: rid(), projectId: a.id, expectedRevision: projectRevision(f, a),
    payload: { topicId: a.topic.id, purpose: "ตัดสินใจเรื่องสำคัญ", sources: [a.topic.source], include: [f.roles.tech], exclude: [], limits: { ...f.config.jobs.maximum } } });
  await drain(f);
  const discussion = f.rt.app.discussions(actor(f), a.id, a.topic.id)[0]!;
  const synthesis = f.rt.app.execute(actor(f), { kind: "decision.synthesize", requestId: rid(), projectId: a.id, expectedRevision: discussion.revision,
    payload: { discussionId: discussion.id, limits: { ...f.config.jobs.maximum } } });
  void synthesis;
  await drain(f);
  const proposal = f.rt.app.decision(actor(f), a.id, a.topic.id).proposal!;
  f.rt.app.execute(actor(f), { kind: "decision.accept", requestId: rid(), projectId: a.id, expectedRevision: proposal.revision,
    payload: { proposalId: proposal.id, optionId: proposal.artifact.options[0]!.id, conclusion: "เลือกทางแรก", rationale: "เจ้าของเห็นด้วย" } });
  // Delivery report.
  f.rt.app.execute(actor(f), { kind: "delivery.commit", requestId: rid(), projectId: a.id, expectedRevision: projectRevision(f, a),
    payload: { kind: "report", text: "รายงานสรุป delivery ฉบับที่ 1", dedupeKey: "report-1" } });
  // Stale PR: ready candidate then a rebase supersedes it.
  const github = new FakeGitHubFixture();
  const { monitor, conn } = enableMonitor(f, a, github);
  const base = sha(1), head = sha(2), head2 = sha(3);
  github.pulls = [fixturePull({ number: 9, draft: false, base: { sha: base, ref: "main" }, head: { sha: head, ref: "feat" }, title: "ready PR" })];
  f.rt.store.transaction(tx => pollMonitorCatchUp(tx, a.id, monitor.id, conn, f.clock.now));
  github.pulls = [fixturePull({ number: 9, draft: false, base: { sha: base, ref: "main" }, head: { sha: head2, ref: "feat" }, title: "ready PR" })];
  f.rt.store.transaction(tx => {
    tx.run("UPDATE pr_poll_checkpoints SET record_json = ? WHERE monitor_id = ?",
      JSON.stringify({ monitorId: monitor.id, updatedAt: f.clock.now, complete: false, nextPage: 1, etag: null, lastSeenUpdatedAt: null, reason: null }), monitor.id);
    pollMonitorCatchUp(tx, a.id, monitor.id, conn, f.clock.now);
  });
  // Project B stays small and isolated.
  const bSource = say(f, b, "B only content");
  await remember(f, b, bSource);
  f.rt.app.execute(actor(f), { kind: "task.propose", requestId: rid(), projectId: b.id, expectedRevision: topicRevision(f, b),
    payload: { topicId: b.topic.id, title: "B task", summary: "B summary" } });
  return { a, b, sKeep: sKeep!, keep: keep!, wrong: wrong!, corrected, forgotten: forgotten!, sDel: sDel!, doomed: doomed!, sFix: sFix!, github, monitor };
}

test("export with history preserves all kinds, honors corrected/forgotten/deleted and stays parseable", async () => {
  const f = await fixture();
  const { a, b, keep, wrong, corrected, forgotten, sDel, doomed } = await rich(f);
  // Delete one lineage, then export.
  const delPreview = asDeletePreview(f.rt.app.execute(actor(f), { kind: "memory.delete.preview" as const, requestId: rid(), projectId: a.id,
    expectedRevision: projectRevision(f, a), payload: { scope: { kind: "source", projectId: a.id, source: { ...sDel } } } }));
  const opId = asDeleteConfirmed(f.rt.app.execute(actor(f), { kind: "memory.delete.confirm" as const, requestId: rid(), projectId: a.id,
    expectedRevision: projectRevision(f, a), payload: { previewId: delPreview.preview.id, acknowledged: true, acknowledgedWholeSession: delPreview.preview.wholeSession.required } })).operation.id;
  await reconcileDeletions(f.rt.store, f.rt.port as unknown as ApplicationRunPort, f.clock.now);
  expect(f.rt.app.deletionOperation(actor(f), a.id, opId).operation!.state).toBe("complete");
  const receipt = f.rt.app.execute(actor(f), exportCommand(f, a, true));
  expect(receipt.manifest.contract).toBe("ops.project_export/v1");
  expect(receipt.manifest.state).toBe("valid");
  expect(receipt.manifest.projectRevision).toBe(projectRevision(f, a));
  expect(receipt.manifest.artifact.bytes).toBeGreaterThan(0);
  expect(receipt.manifest.artifact.hash).toHaveLength(64);
  expect(receipt.duplicate).toBe(false);
  // Independent parse: Thai/English/Unicode survive verbatim.
  const { readFileSync } = await import("node:fs");
  const artifact = JSON.parse(readFileSync(receipt.manifest.artifact.path, "utf8")) as { data: Record<string, unknown[] | unknown> };
  const text = JSON.stringify(artifact);
  expect(text).toContain("โครงการส่งออก ไทย/English 🧠");
  expect(text).toContain("hello world 🌏");
  expect(text).toContain("ข้อความที่แก้แล้ว (corrected) ✓");
  // Deleted content is absent; forgotten is inactive; corrected old revision is excluded.
  expect(text).not.toContain("delete-me-009");
  // Derived outputs are purged by lineage (unavailable) or keep only the redaction marker.
  expect(text.includes("(memory ไม่พร้อมใช้งาน)") || text.includes("source_unavailable")).toBe(true);
  const data = artifact.data as { claims: { state: string; claim?: MemoryClaim; reference?: ClaimReference; reason?: string }[]; sources: unknown[] };
  const activeTexts = data.claims.flatMap(c => c.state === "available" ? [c.claim!.text] : []);
  expect(activeTexts).toContain(keep.text);
  expect(activeTexts).toContain(corrected.replacement ? "ข้อความที่แก้แล้ว (corrected) ✓" : "ข้อความที่แก้แล้ว (corrected) ✓");
  expect(activeTexts.some(t => t.includes("forget-me-008"))).toBe(false);
  const reasons = data.claims.flatMap(c => c.state === "unavailable" ? [`${c.reference!.claimId}:${c.reason}`] : []);
  expect(reasons.some(r => r.endsWith("claim_deleted"))).toBe(true);
  expect(reasons.some(r => r.endsWith("claim_forgotten"))).toBe(true);
  expect(reasons.some(r => r.endsWith("claim_corrected"))).toBe(true);
  expect(data.claims.some(c => c.state === "available" && c.claim!.claimId === wrong.claimId)).toBe(false);
  // Tasks, decision, delivery and PR candidates export with revision/scope.
  const tasks = (artifact.data as { tasks: { task: { state: string; title: string } }[] }).tasks;
  expect(tasks.map(t => t.task.state).sort()).toEqual(["accepted", "proposed"]);
  const decisions = (artifact.data as { ownerDecisions: { conclusion: string }[] }).ownerDecisions;
  expect(decisions.map(d => d.conclusion)).toContain("เลือกทางแรก");
  const pr = (artifact.data as { pr: { monitors: unknown[]; candidates: { status: string; headSha: string }[] } }).pr;
  expect(pr.monitors).toHaveLength(1);
  expect(pr.candidates.map(c => c.status).sort()).toEqual(["ready", "superseded"]);
  expect(receipt.manifest.exclusions.some(e => e.reason === "superseded_stale")).toBe(true);
  // Exclusions name every lifecycle boundary; missing refs stay an explicit list.
  expect(receipt.manifest.exclusions.some(e => e.kind === "claim" && e.reason === "deleted")).toBe(true);
  expect(receipt.manifest.lifecycle.tombstonesApplied).toBeGreaterThanOrEqual(1);
  expect(Array.isArray(receipt.manifest.missingRefs)).toBe(true);
  // Project B isolation: no A payload crosses projects.
  const bExport = f.rt.app.execute(actor(f), exportCommand(f, b, true));
  const bText = readFileSync(bExport.manifest.artifact.path, "utf8");
  expect(bText).toContain("B only content");
  expect(bText).not.toContain("hello world");
  // Coverage is bounded and disclosed.
  expect(typeof receipt.manifest.coverage.truncated).toBe("boolean");
});

test("history scope excludes raw messages and forgotten raw history but keeps structure", async () => {
  const f = await fixture();
  const { a } = await rich(f);
  const full = f.rt.app.execute(actor(f), exportCommand(f, a, true));
  const slim = f.rt.app.execute(actor(f), exportCommand(f, a, false));
  expect(slim.manifest.scope.includeHistory).toBe(false);
  const { readFileSync } = await import("node:fs");
  const fullJson = readFileSync(full.manifest.artifact.path, "utf8");
  const slimJson = JSON.parse(readFileSync(slim.manifest.artifact.path, "utf8")) as { data: { messages: unknown[]; messageCount: number } };
  expect(fullJson).toContain("เรื่องลืม forget-me-008 ไม่ใช้แล้ว");
  expect(slimJson.data.messages).toEqual([]);
  expect(slimJson.data.messageCount).toBeGreaterThan(0);
  expect(slim.manifest.exclusions.some(e => e.reason === "forgotten_raw_history_excluded")).toBe(true);
  // Structure (topics, tasks, decisions) still exports.
  expect(slim.manifest.counts.topics).toBeGreaterThan(0);
  expect(slim.manifest.counts.tasks).toBeGreaterThan(0);
});

test("revision conflicts, duplicate receipts and forged actors are rejected", async () => {
  const f = await fixture();
  const { a } = await rich(f);
  const cmd = exportCommand(f, a, true);
  const first = f.rt.app.execute(actor(f), cmd);
  expect(f.rt.app.execute(actor(f), cmd)).toEqual(first);
  expect(() => f.rt.app.execute(actor(f), { ...cmd, payload: { ...cmd.payload, note: "different" } })).toThrow("request_id_conflict");
  expect(() => f.rt.app.execute(actor(f), { ...exportCommand(f, a, true), expectedRevision: 1 })).toThrow("stale_revision");
  expect(() => f.rt.app.export({ ownerId: "owner", channel: "web" } as never, a.id, first.manifest.id)).toThrow("authentication_required");
  expect(() => f.rt.app.export(actor(f), a.id, crypto.randomUUID())).toThrow("export_not_found");
});

test("deletion during build is fenced by the lifecycle check; pending deletions are disclosed", async () => {
  const f = await fixture();
  const a = project(f, "โครงการแข่ง", "หัวข้อแข่ง");
  const s1 = say(f, a, "ข้อความ race-one-010");
  const [c1] = await remember(f, a, s1);
  void c1;
  f.rt.app.execute(actor(f), { kind: "team.dispatch" as const, requestId: rid(), projectId: a.id, expectedRevision: projectRevision(f, a),
    payload: { topicId: a.topic.id, purpose: "วิเคราะห์ race-one", sources: [a.topic.source], include: [f.roles.tech], exclude: [], limits: { ...f.config.jobs.maximum } } });
  const preview = asDeletePreview(f.rt.app.execute(actor(f), { kind: "memory.delete.preview" as const, requestId: rid(), projectId: a.id,
    expectedRevision: projectRevision(f, a), payload: { scope: { kind: "source", projectId: a.id, source: { ...s1 } } } }));
  const read = f.rt.app.exportPreview(actor(f), a.id, true);
  expect(read.preview.counts.claims).toBeGreaterThan(0);
  const confirmed = asDeleteConfirmed(f.rt.app.execute(actor(f), { kind: "memory.delete.confirm" as const, requestId: rid(), projectId: a.id,
    expectedRevision: projectRevision(f, a), payload: { previewId: preview.preview.id, acknowledged: true, acknowledgedWholeSession: false } }));
  // In-flight managed deletion is disclosed, and the deleted payload is already excluded.
  const receipt = f.rt.app.execute(actor(f), exportCommand(f, a, true));
  expect(receipt.manifest.pendingDeletions).toContain(confirmed.operation.id);
  const { readFileSync } = await import("node:fs");
  expect(readFileSync(receipt.manifest.artifact.path, "utf8")).not.toContain("race-one-010");
  await reconcileDeletions(f.rt.store, f.rt.port as unknown as ApplicationRunPort, f.clock.now);
  expect(f.rt.app.deletionOperation(actor(f), a.id, confirmed.operation.id).operation!.state).toBe("complete");
});

test("retained exports are tracked for subsequent delete previews", async () => {
  const f = await fixture();
  const { a, sDel } = await rich(f);
  const before = f.rt.app.execute(actor(f), exportCommand(f, a, true));
  const preview = asDeletePreview(f.rt.app.execute(actor(f), { kind: "memory.delete.preview" as const, requestId: rid(), projectId: a.id,
    expectedRevision: projectRevision(f, a), payload: { scope: { kind: "source", projectId: a.id, source: { ...sDel } } } }));
  expect(preview.preview.affected.exports.map((e: { id: string }) => e.id)).toContain(before.manifest.id);
});

test("unsafe destinations fail closed; secrets never enter ordinary exports", async () => {
  const f = await fixture();
  const { a } = await rich(f);
  const receipt = f.rt.app.execute(actor(f), exportCommand(f, a, true));
  const { readFileSync } = await import("node:fs");
  const artifactJson = readFileSync(receipt.manifest.artifact.path, "utf8");
  expect(scanExportSecrets(artifactJson, [password, f.token, "sk-secret-test"])).toEqual([]);
  for (const key of ["password_hash", "token_hash", "sessions", "botToken", "process.env", "apiBase"]) {
    expect(artifactJson.includes(`"${key}"`)).toBe(false);
  }
  expect(JSON.stringify(receipt.manifest).includes(f.token)).toBe(false);
  const mode = statSync(receipt.manifest.artifact.path).mode & 0o777;
  expect(mode).toBe(0o600);
  // A file blocking the export directory fails with an explicit storage error.
  const blocker = join(f.root, "blocker");
  writeFileSync(blocker, "x");
  const fragile = new Application(f.rt.store, f.config, { jobs: f.rt.queue, now: () => f.clock.now, backupDir: join(f.root, "backups"), exportDir: blocker });
  expect(() => fragile.execute(fragile.authenticate(f.token).actor, { kind: "export.create" as const, requestId: rid(), projectId: a.id,
    expectedRevision: fragile.project(fragile.authenticate(f.token).actor, a.id).revision, payload: { includeHistory: true, note: "x" } })).toThrow("export_storage_unavailable");
});

test("retention prunes oldest exports and web renders without secrets or worker activation", async () => {
  const f = await fixture();
  const { a } = await rich(f);
  const web = createWebHandler(f.rt.app);
  const ids: string[] = [];
  for (let i = 0; i < 22; i++) ids.push(f.rt.app.execute(actor(f), exportCommand(f, a, i % 2 === 0)).manifest.id);
  const listed = f.rt.app.exports(actor(f), a.id).manifests;
  expect(listed).toHaveLength(20);
  expect(listed.some(m => m.retention.pruned.length > 0)).toBe(true);
  const req = (path: string, token?: string) => new Request(`http://localhost:3000${path}`, { headers: token ? { cookie: `jit_session=${f.token}` } : {} });
  const list = await web(req(`/projects/${a.id}/exports`, f.token));
  expect(list.status).toBe(200);
  const html = await list.text();
  expect(html).toContain(ids.at(-1)!);
  expect(html).not.toContain("delete-me-009");
  expect(html).not.toContain(f.token);
  const detail = await web(req(`/projects/${a.id}/exports/${ids.at(-1)!}`, f.token));
  expect(detail.status).toBe(200);
  expect(await detail.text()).toContain("ops.project_export/v1");
});
