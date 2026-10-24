import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Application } from "../src/application";
import { readConfig } from "../src/config";
import {
  reconcileDeletions,
  type DeleteCommand, type DeletionConfirmReceipt, type DeletionReceipt,
} from "../src/memory/delete";
import { scanExportSecrets, type FailedExportManifest, type ValidExportManifest } from "../src/ops/export";
import { Database } from "bun:sqlite";
import { AppError } from "../src/errors";
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
  annotateReport, captureSnapshot, normalizeReviewOutput, persistReport, readCandidates, readSnapshot, DEFAULT_REVIEW_POLICY,
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

function boot(config: Config, hooks: { extract: Script; specialist: Script }, clock: { now: number }, backupDir: string) {
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
  const app = new Application(store, config, { jobs: queue, now, backupDir, nativeSnapshot });
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
  const rt = boot(config, hooks, clock, join(root, "backups"));
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
/** Downloads one committed artifact through the owner API and decodes it independently. */
const artifactText = (f: Fixture, manifest: { projectId: string; id: string }) =>
  new TextDecoder().decode(f.rt.app.exportArtifact(actor(f), manifest.projectId, manifest.id).body);
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
  // A private report for the ready revision; the rebase below makes it stale.
  github.files.set(github.key(9, base, head), [{ filename: "a.ts", status: "modified", patch: "@@\n+a" }]);
  github.checks.set(head, []);
  const prReport = f.rt.store.transaction(tx => {
    const candidate = readCandidates(tx, a.id, monitor.id)[0]!;
    const snapshot = captureSnapshot(tx, a.id, candidate.id, conn, f.clock.now)!;
    const review = JSON.stringify({ analyzedRoles: ["correctness", "security"], skippedScope: [], disagreements: ["ความเห็นต่าง review 🧪"], findings: [
      { id: "finding-1", title: "อ่านค่าว่างผิด empty read ⚠️", category: "correctness", severity: "high", location: { path: "a.ts", line: 3 },
        condition: "เมื่อ input ว่าง", impact: "crash", reasoning: "trace shows unchecked access", evidenceType: "diff", evidenceRef: "a.ts" },
      { id: "finding-2", title: "leaks header", category: "security", severity: "high", location: { path: "a.ts", line: 4 },
        condition: "Authorization: Bearer pr-canary-token-011", impact: "leak", reasoning: "header copied", evidenceType: "diff", evidenceRef: "a.ts" },
    ] });
    return persistReport(tx, { projectId: a.id, monitorId: monitor.id, candidateId: candidate.id, snapshot,
      normalized: normalizeReviewOutput(review, snapshot, DEFAULT_REVIEW_POLICY.requiredRoles), requiredRoles: [...DEFAULT_REVIEW_POLICY.requiredRoles],
      specialistRuns: [{ role: "correctness", state: "complete", reason: null }, { role: "security", state: "complete", reason: null }],
      synthesis: { state: "complete", reason: null }, jobId: null, attemptId: null, now: f.clock.now });
  });
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
  return { a, b, sKeep: sKeep!, keep: keep!, wrong: wrong!, corrected, forgotten: forgotten!, sDel: sDel!, doomed: doomed!, sFix: sFix!, github, monitor, prReport };
}

test("export with history preserves all kinds, honors corrected/forgotten/deleted and stays parseable", async () => {
  const f = await fixture();
  const { a, b, keep, wrong, corrected, forgotten, sDel, doomed } = await rich(f);
  // Delete one lineage, then export.
  const delPreview = asDeletePreview(f.rt.app.execute(actor(f), { kind: "memory.delete.preview" as const, requestId: rid(), projectId: a.id,
    expectedRevision: projectRevision(f, a), payload: { scope: { kind: "source", projectId: a.id, source: { ...sDel } } } }));
  const opId = asDeleteConfirmed(f.rt.app.execute(actor(f), { kind: "memory.delete.confirm" as const, requestId: rid(), projectId: a.id,
    expectedRevision: projectRevision(f, a), payload: { previewId: delPreview.preview.id, acknowledged: true, acknowledgedWholeSession: false } })).operation.id;
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
  const artifact = JSON.parse(artifactText(f, receipt.manifest)) as { data: Record<string, unknown[] | unknown> };
  const text = JSON.stringify(artifact);
  expect(text).toContain("โครงการส่งออก ไทย/English 🧠");
  expect(text).toContain("hello world 🌏");
  expect(text).toContain("ข้อความที่แก้แล้ว (corrected) ✓");
  // Deleted content is absent; forgotten is inactive; corrected old revision is excluded.
  expect(text).not.toContain("delete-me-009");
  expect(text).toContain("(memory ไม่พร้อมใช้งาน)");
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
  const bText = artifactText(f, bExport.manifest);
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
  const fullJson = artifactText(f, full.manifest);
  const slimJson = JSON.parse(artifactText(f, slim.manifest)) as { data: { messages: unknown[]; messageCount: number } };
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
  expect(artifactText(f, receipt.manifest)).not.toContain("race-one-010");
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

test("no caller-chosen destination exists: artifacts are owner-only downloads; secrets never enter ordinary exports", async () => {
  const f = await fixture();
  const { a } = await rich(f);
  const receipt = f.rt.app.execute(actor(f), exportCommand(f, a, true));
  const artifactJson = artifactText(f, receipt.manifest);
  expect(scanExportSecrets(artifactJson, [password, f.token, "sk-secret-test"])).toEqual([]);
  for (const key of ["password_hash", "token_hash", "sessions", "botToken", "process.env", "apiBase"]) {
    expect(artifactJson.includes(`"${key}"`)).toBe(false);
  }
  expect(JSON.stringify(receipt.manifest).includes(f.token)).toBe(false);
  // The artifact is served only to the authenticated owner, from the committed row.
  const web = createWebHandler(f.rt.app);
  const path = receipt.manifest.artifact.storage === "sqlite" ? receipt.manifest.artifact.downloadPath : "";
  const anonymous = await web(new Request(`http://localhost:3000${path}`));
  expect(anonymous.status).toBe(303);
  const owned = await web(new Request(`http://localhost:3000${path}`, { headers: { cookie: `jit_session=${f.token}` } }));
  expect(owned.status).toBe(200);
  expect(owned.headers.get("cache-control")).toBe("no-store");
  expect(owned.headers.get("content-disposition")).toContain("attachment");
  expect(await owned.text()).toBe(artifactJson);
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

function hookedApp(f: Fixture, beforeCommit: (stage: string) => void, extra: { exportLimits?: { maxBytes?: number; maxExports?: number } } = {}) {
  return new Application(f.rt.store, f.config, { jobs: f.rt.queue, now: () => f.clock.now, backupDir: join(f.root, "backups"), beforeCommit, ...extra });
}
function rejection(run: () => unknown): AppError {
  try { run(); } catch (error) { if (error instanceof AppError) return error; throw error; }
  throw new Error("expected an AppError rejection");
}

test("stale PR reports export revision, scope, stale flag and findings with Unicode; secret-like text is redacted", async () => {
  const f = await fixture();
  const { a, b, prReport } = await rich(f);
  const receipt = f.rt.app.execute(actor(f), exportCommand(f, a, false));
  const text = artifactText(f, receipt.manifest);
  const artifact = JSON.parse(text) as { formatVersion: number; exportId: string; disclosure: { restorableBackup: boolean }; data: {
    prReports: { id: string; revision: number; status: string; stale: boolean; staleReason: string | null; headSha: string;
      scope: { requiredRoles: string[]; analyzedRoles: string[]; skippedScope: string[]; coverageOverall: string };
      findings: { id: string; title: string; condition: string; status: string }[]; disagreements: string[];
      evidence: { snapshotId: string; jobId: string | null } }[];
    decisions: { id: string; revision: number; status: string; ownerDecisionId: string | null; sourceAvailability: string }[];
    ownerDecisions: { id: string }[];
  } };
  expect(artifact.formatVersion).toBe(2);
  expect(artifact.exportId).toBe(receipt.manifest.id);
  expect(artifact.disclosure.restorableBackup).toBe(false);
  expect(receipt.manifest.counts.prReports).toBe(1);
  const [report] = artifact.data.prReports;
  expect(report!.id).toBe(prReport.id);
  expect(report!.revision).toBe(1);
  expect(report!.headSha).toBe(prReport.headSha);
  expect(report!.stale).toBe(true);
  expect(report!.staleReason).toBe("candidate_superseded");
  expect(report!.scope.requiredRoles).toEqual(["correctness", "security"]);
  expect(report!.scope.analyzedRoles).toEqual(["correctness", "security"]);
  expect(report!.evidence.snapshotId).toBe(prReport.snapshotId);
  expect(report!.findings.map(finding => finding.title)).toContain("อ่านค่าว่างผิด empty read ⚠️");
  expect(report!.disagreements).toEqual(["ความเห็นต่าง review 🧪"]);
  // A suspected finding that quoted an auth header never carries the header into the export.
  expect(scanExportSecrets(text, ["pr-canary-token-011", "Bearer pr-canary"])).toEqual([]);
  for (const key of ["apiBase", "authorityGeneration", "patch"]) expect(text.includes(`"${key}"`)).toBe(false);
  // Decisions carry identity, revision, owner-decision status and provenance availability.
  const decided = artifact.data.decisions.find(d => d.status === "decided")!;
  expect(decided.ownerDecisionId).toBe(artifact.data.ownerDecisions[0]!.id);
  expect(decided.revision).toBeGreaterThan(0);
  expect(decided.sourceAvailability).toBe("available");
  // Project isolation holds for PR reports too.
  const bText = artifactText(f, f.rt.app.execute(actor(f), exportCommand(f, b, false)).manifest);
  expect((JSON.parse(bText) as { data: { prReports: unknown[] } }).data.prReports).toEqual([]);
});

test("without history scope, raw message sources export identity only", async () => {
  const f = await fixture();
  const { a, sKeep } = await rich(f);
  const slim = f.rt.app.execute(actor(f), exportCommand(f, a, false));
  const data = (JSON.parse(artifactText(f, slim.manifest)) as { data: { sources: { state: string; kind?: string; text?: string | null; reference: SourceReference }[] } }).data;
  const messages = data.sources.filter(source => source.kind === "message");
  expect(messages.length).toBeGreaterThan(0);
  expect(messages.every(source => source.state === "metadata_only" && source.text === null)).toBe(true);
  expect(slim.manifest.disclosure.rawHistory).toBe("metadata_only");
  expect(slim.manifest.exclusions.some(e => e.kind === "message" && e.id === sKeep.sourceId && e.reason === "raw_history_not_selected")).toBe(true);
  expect(slim.manifest.coverage.sources.some(s => s.sourceId === sKeep.sourceId)).toBe(false);
  const full = f.rt.app.execute(actor(f), exportCommand(f, a, true));
  expect(full.manifest.disclosure.rawHistory).toBe("included");
  expect(artifactText(f, full.manifest)).toContain("ความรู้ที่เก็บไว้ hello world 🌏");
});

test("a deleted delivery source never resurrects through outbox or report copies", async () => {
  const f = await fixture();
  const a = project(f, "โครงการส่งรายงาน", "หัวข้อรายงาน");
  const delivery = f.rt.app.execute(actor(f), { kind: "delivery.commit", requestId: rid(), projectId: a.id, expectedRevision: projectRevision(f, a),
    payload: { kind: "report", text: "รายงาน delivery-gone-013 ลบแล้ว", dedupeKey: "report-gone" } });
  const source: SourceReference = { sourceId: delivery.report.sourceId, revision: delivery.report.sourceRevision, generation: delivery.report.sourceGeneration };
  const preview = asDeletePreview(f.rt.app.execute(actor(f), { kind: "memory.delete.preview" as const, requestId: rid(), projectId: a.id,
    expectedRevision: projectRevision(f, a), payload: { scope: { kind: "source", projectId: a.id, source } } }));
  f.rt.app.execute(actor(f), { kind: "memory.delete.confirm" as const, requestId: rid(), projectId: a.id,
    expectedRevision: projectRevision(f, a), payload: { previewId: preview.preview.id, acknowledged: true, acknowledgedWholeSession: false } });
  await reconcileDeletions(f.rt.store, f.rt.port as unknown as ApplicationRunPort, f.clock.now);
  const receipt = f.rt.app.execute(actor(f), exportCommand(f, a, true));
  const text = artifactText(f, receipt.manifest);
  expect(text).not.toContain("delivery-gone-013");
  const data = (JSON.parse(text) as { data: { reports: { id: string; text: string | null }[]; deliveries: { id: string; text: string | null; availability: string }[] } }).data;
  expect(data.reports.find(r => r.id === delivery.report.id)!.text).toBeNull();
  expect(data.deliveries.find(d => d.id === delivery.intent.id)!.availability).toBe("unavailable");
  expect(receipt.manifest.exclusions.some(e => e.id === delivery.report.id)).toBe(true);
});

test("a rollback leaves no artifact; the failure is durable and replays as one logical export", async () => {
  const f = await fixture();
  const a = project(f, "โครงการล้มเหลว", "หัวข้อ");
  say(f, a, "ข้อความ rollback-012");
  let armed = true;
  const app = hookedApp(f, stage => { if (armed && stage === "receipt") throw new Error("simulated commit failure /private/secret/path"); });
  const owner = app.authenticate(f.token).actor;
  const cmd = exportCommand(f, a, true);
  const first = rejection(() => app.execute(owner, cmd));
  expect(first.code).toBe("export_failed");
  const exportId = first.detail!.exportId as string;
  const failed = app.export(owner, a.id, exportId).manifest as FailedExportManifest;
  expect(failed.state).toBe("failed");
  expect(failed.failure).toEqual({ reason: "export_failed", stage: "commit" });
  expect(failed.artifact).toBeNull();
  expect(failed.coverage.sources).toEqual([]);
  expect(JSON.stringify(failed)).not.toContain("secret/path");
  // Replaying the request returns the same recorded failure, even once the fault is gone.
  armed = false;
  const replay = rejection(() => app.execute(owner, cmd));
  expect(replay.code).toBe("export_failed");
  expect(replay.detail!.exportId).toBe(exportId);
  expect(app.exports(owner, a.id).manifests.map(m => m.id)).toEqual([exportId]);
  expect(() => app.execute(owner, { ...cmd, payload: { ...cmd.payload, note: "different" } })).toThrow("request_id_conflict");
  // A failed export publishes nothing, so later delete previews never list it.
  const preview = asDeletePreview(f.rt.app.execute(actor(f), { kind: "memory.delete.preview" as const, requestId: rid(), projectId: a.id,
    expectedRevision: projectRevision(f, a), payload: { scope: { kind: "source", projectId: a.id, source: a.topic.source } } }));
  expect(preview.preview.affected.exports).toEqual([]);
  // A fresh request publishes exactly one artifact.
  const ok = app.execute(owner, exportCommand(f, a, true));
  expect(app.exports(owner, a.id).manifests.map(m => m.state).sort()).toEqual(["failed", "valid"]);
  expect(artifactText(f, ok.manifest)).toContain("rollback-012");
  expect(() => app.exportArtifact(owner, a.id, exportId)).toThrow("export_failed_no_artifact");
});

test("a lifecycle change between assembly and publish fences the artifact before it becomes visible", async () => {
  const f = await fixture();
  const a = project(f, "โครงการแข่งลบ", "หัวข้อ");
  const s = say(f, a, "ข้อความ fence-014 ระหว่างส่งออก");
  const app = hookedApp(f, stage => {
    // Simulates a deletion purge landing while the export is in flight.
    if (stage === "ops") f.rt.store.transaction(tx => tx.run("UPDATE sources SET availability = 'unavailable' WHERE id = ?", s.sourceId));
  });
  const owner = app.authenticate(f.token).actor;
  const error = rejection(() => app.execute(owner, exportCommand(f, a, true)));
  expect(error.code).toBe("export_fenced_by_lifecycle");
  const failed = app.export(owner, a.id, error.detail!.exportId as string).manifest;
  expect(failed.state).toBe("failed");
  expect(failed.failure).toEqual({ reason: "export_fenced_by_lifecycle", stage: "publish" });
});

test("delete previews conservatively list exports whose bounded coverage was truncated", async () => {
  const f = await fixture();
  const a = project(f, "โครงการครอบคลุม", "หัวข้อ");
  const s = say(f, a, "ข้อความ coverage-016");
  const receipt = f.rt.app.execute(actor(f), exportCommand(f, a, false));
  expect(receipt.manifest.coverage.truncated).toBe(false);
  // Without history the message text is not in the artifact, so it is not listed.
  const scope = { kind: "source" as const, projectId: a.id, source: { ...s } };
  const before = asDeletePreview(f.rt.app.execute(actor(f), { kind: "memory.delete.preview" as const, requestId: rid(), projectId: a.id,
    expectedRevision: projectRevision(f, a), payload: { scope } }));
  expect(before.preview.affected.exports).toEqual([]);
  f.rt.store.transaction(tx => {
    const manifest = { ...receipt.manifest, coverage: { ...receipt.manifest.coverage, truncated: true } };
    tx.run("UPDATE export_artifacts SET record_json = ? WHERE id = ?", JSON.stringify(manifest), manifest.id);
  });
  const after = asDeletePreview(f.rt.app.execute(actor(f), { kind: "memory.delete.preview" as const, requestId: rid(), projectId: a.id,
    expectedRevision: projectRevision(f, a), payload: { scope } }));
  expect(after.preview.affected.exports.map(e => e.id)).toEqual([receipt.manifest.id]);
});

test("every PR-derived string is sanitized; canaries in each field never reach the artifact", async () => {
  const f = await fixture();
  const a = project(f, "โครงการ PR canary", "หัวข้อ");
  const github = new FakeGitHubFixture();
  const { monitor, conn } = enableMonitor(f, a, github);
  const base = sha(1), head = sha(2);
  github.pulls = [fixturePull({ number: 3, draft: false, base: { sha: base, ref: "main" }, head: { sha: head, ref: "feat" }, title: "PR" })];
  github.files.set(github.key(3, base, head), [{ filename: "a.ts", status: "modified", patch: "@@\n+a" }]);
  github.checks.set(head, []);
  f.rt.store.transaction(tx => pollMonitorCatchUp(tx, a.id, monitor.id, conn, f.clock.now));
  const canaries = ["canary-title-0020", "canary-cond-0020", "canary-evref-0020", "ghp_canaryPATHtoken0123456789", "canary-disagree-0020",
    "sk-canaryskippedscope0123456789", "ghp_canaryROLEtoken0123456789", "github_pat_canaryANNOT_0123456789abcdef"];
  const report = f.rt.store.transaction(tx => {
    const candidate = readCandidates(tx, a.id, monitor.id)[0]!;
    const snapshot = captureSnapshot(tx, a.id, candidate.id, conn, f.clock.now)!;
    const review = JSON.stringify({ analyzedRoles: ["correctness", "security", `role ${canaries[6]}`], skippedScope: [`scope ${canaries[5]}`],
      disagreements: [`x-api-key: ${canaries[4]}`], findings: [
        { id: "finding-1", title: `Bearer ${canaries[0]}`, category: "security", severity: "high", location: { path: "a.ts", line: 1 },
          condition: `Authorization: ${canaries[1]}`, impact: "leak", reasoning: "r", evidenceType: "diff", evidenceRef: "a.ts" },
        { id: "finding-2", title: "clean prose", category: "correctness", severity: "low", location: { path: `src/${canaries[3]}.ts`, line: 2 },
          condition: "c", impact: "i", reasoning: "r", evidenceType: "none", evidenceRef: `Authorization: Bearer ${canaries[2]}` },
      ] });
    return persistReport(tx, { projectId: a.id, monitorId: monitor.id, candidateId: candidate.id, snapshot,
      normalized: normalizeReviewOutput(review, snapshot, DEFAULT_REVIEW_POLICY.requiredRoles), requiredRoles: [...DEFAULT_REVIEW_POLICY.requiredRoles],
      specialistRuns: [], synthesis: { state: "complete", reason: null }, jobId: null, attemptId: null, now: f.clock.now });
  });
  f.rt.store.transaction(tx => annotateReport(tx, { kind: "pr.report.dismiss", requestId: rid(), projectId: a.id, expectedRevision: report.revision,
    payload: { reportId: report.id, reason: `owner note ${canaries[7]}` } }, f.clock.now));
  const receipt = f.rt.app.execute(actor(f), exportCommand(f, a, false));
  const text = artifactText(f, receipt.manifest);
  expect(scanExportSecrets(text, canaries)).toEqual([]);
  const exported = (JSON.parse(text) as { data: { prReports: { revision: number; findings: { id: string; title: string }[] }[] } }).data.prReports[0]!;
  expect(exported.revision).toBe(2);
  expect(exported.findings.map(finding => finding.id)).toEqual(["finding-1", "finding-2"]);
  expect(exported.findings[1]!.title).toBe("clean prose");
});

test("forget suppression gates delivery and report text exactly like raw sources", async () => {
  const f = await fixture();
  const a = project(f, "โครงการลืมรายงาน", "หัวข้อ");
  const delivery = f.rt.app.execute(actor(f), { kind: "delivery.commit", requestId: rid(), projectId: a.id, expectedRevision: projectRevision(f, a),
    payload: { kind: "report", text: "รายงาน forgotten-delivery-021 ที่ถูกลืม", dedupeKey: "forgotten-delivery" } });
  const source: SourceReference = { sourceId: delivery.report.sourceId, revision: delivery.report.sourceRevision, generation: delivery.report.sourceGeneration };
  // A real forget on a message-derived claim; the scripted extractor cannot read output sources,
  // so the same suppression is extended to the delivery source as a forget of a report-derived claim would.
  const [claim] = await remember(f, a, say(f, a, "ข้อความ forget-anchor-021"));
  f.rt.app.execute(actor(f), { kind: "memory.forget" as const, requestId: rid(), projectId: a.id, expectedRevision: projectRevision(f, a),
    payload: { claim: ref(claim!), reason: "ลืมรายงาน", acknowledged: true } });
  f.rt.store.transaction(tx => {
    const suppression = tx.get<{ id: string }>("SELECT suppression_id AS id FROM memory_suppressed_sources WHERE project_id = ? LIMIT 1", a.id)!.id;
    tx.run("INSERT INTO memory_suppressed_sources VALUES (?, ?, ?, ?, ?)", suppression, a.id, source.sourceId, source.revision, source.generation);
  });
  expect(f.rt.store.read(tx => tx.get("SELECT 1 AS ok FROM memory_suppressed_sources WHERE source_id = ?", source.sourceId))).not.toBeNull();
  const slim = f.rt.app.execute(actor(f), exportCommand(f, a, false));
  const slimText = artifactText(f, slim.manifest);
  expect(slimText).not.toContain("forgotten-delivery-021");
  expect(slim.manifest.exclusions.some(e => e.id === delivery.report.id && e.reason === "delivery_report_forgotten_raw_history_excluded")).toBe(true);
  expect(slim.manifest.coverage.sources.some(s => s.sourceId === source.sourceId)).toBe(false);
  // Explicit history scope releases the forget-retained raw text, and coverage then names it.
  const full = f.rt.app.execute(actor(f), exportCommand(f, a, true));
  expect(artifactText(f, full.manifest)).toContain("forgotten-delivery-021");
  expect(full.manifest.coverage.sources.some(s => s.sourceId === source.sourceId)).toBe(true);
});

test("bounded collections report included versus total instead of silently truncating", async () => {
  const f = await fixture();
  const a = project(f, "โครงการงานเยอะ", "หัวข้อ");
  f.rt.store.transaction(tx => {
    for (let i = 0; i < 1001; i++) {
      const id = `job-${String(i).padStart(5, "0")}`;
      tx.run("INSERT INTO jobs (id, project_id, queue_order, priority, state, occupies, route_key, record_json) VALUES (?, ?, ?, 0, 'succeeded', 0, 'fixture/none', ?)",
        id, a.id, 900000 + i, JSON.stringify({ id, type: "fixture", state: "succeeded", reason: "complete", evidence: `evidence-${i}` }));
    }
  });
  const receipt = f.rt.app.execute(actor(f), exportCommand(f, a, false));
  const data = (JSON.parse(artifactText(f, receipt.manifest)) as { data: { jobs: unknown[] } }).data;
  expect(data.jobs).toHaveLength(1000);
  expect(receipt.manifest.counts.jobs).toBe(1000);
  expect(receipt.manifest.completeness.collections.jobs).toEqual({ included: 1000, total: 1001, truncated: true });
  expect(receipt.manifest.completeness.complete).toBe(false);
  expect(receipt.manifest.completeness.collections.messages).toEqual({ included: 0, total: 0, truncated: false });
});

test("an artifact above the byte ceiling is rejected before registration", async () => {
  const f = await fixture();
  const a = project(f, "โครงการใหญ่", "หัวข้อ");
  for (let i = 0; i < 4; i++) say(f, a, `ข้อความยาว ${i} ${"ใหญ่".repeat(120)}`);
  const small = hookedApp(f, () => {}, { exportLimits: { maxBytes: 4096 } });
  const owner = small.authenticate(f.token).actor;
  const error = rejection(() => small.execute(owner, exportCommand(f, a, true)));
  expect(error.code).toBe("export_too_large");
  expect(error.status).toBe(413);
  const failed = small.export(owner, a.id, error.detail!.exportId as string).manifest as FailedExportManifest;
  expect(failed.failure).toEqual({ reason: "export_too_large", stage: "stage" });
  expect(failed.retention.maxBytes).toBe(4096);
  // The metadata-only scope fits under the same ceiling.
  expect(small.execute(owner, exportCommand(f, a, false)).manifest.artifact.bytes).toBeLessThanOrEqual(4096);
});

test("a replay after retention pruned the export returns an explicit expired result, never a valid one", async () => {
  const f = await fixture();
  const a = project(f, "โครงการหมดอายุ", "หัวข้อ");
  say(f, a, "ข้อความ expired-024");
  const app = hookedApp(f, () => {}, { exportLimits: { maxExports: 1 } });
  const owner = app.authenticate(f.token).actor;
  const firstCmd = exportCommand(f, a, true);
  const first = app.execute(owner, firstCmd);
  expect(app.execute(owner, firstCmd)).toEqual(first);
  const second = app.execute(owner, exportCommand(f, a, true));
  expect(second.manifest.retention.pruned).toEqual([first.manifest.id]);
  const expired = rejection(() => app.execute(owner, firstCmd));
  expect(expired.code).toBe("export_expired");
  expect(expired.status).toBe(410);
  expect(expired.detail!.exportId).toBe(first.manifest.id);
  expect(() => app.exportArtifact(owner, a.id, first.manifest.id)).toThrow("export_not_found");
  // Pruning removed the bytes with the registration in the same transaction.
  expect(f.rt.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM export_artifact_bodies")!.n)).toBe(1);
});

test("a failed or fenced export rolls back entirely and never retires older valid artifacts", async () => {
  const f = await fixture();
  const a = project(f, "โครงการรักษาของเก่า", "หัวข้อ");
  const s = say(f, a, "ข้อความ preserve-025");
  let mode: "none" | "fence" | "receipt" = "none";
  const app = hookedApp(f, stage => {
    if (mode === "fence" && stage === "ops") f.rt.store.transaction(tx => tx.run("UPDATE sources SET availability = 'unavailable' WHERE id = ?", s.sourceId));
    if (mode === "receipt" && stage === "receipt") throw new Error("late failure");
  }, { exportLimits: { maxExports: 1 } });
  const owner = app.authenticate(f.token).actor;
  const kept = app.execute(owner, exportCommand(f, a, true)).manifest;
  for (const next of ["fence", "receipt"] as const) {
    mode = next;
    const error = rejection(() => app.execute(owner, exportCommand(f, a, true)));
    expect(error.code).toBe(next === "fence" ? "export_fenced_by_lifecycle" : "export_failed");
    const failed = app.export(owner, a.id, error.detail!.exportId as string).manifest as FailedExportManifest;
    expect(failed.retention.pruned).not.toContain(kept.id);
    expect(artifactText(f, kept)).toContain("preserve-025");
  }
  // The registry write itself failing leaves the old export too.
  mode = "none";
  f.rt.store.transaction(tx => tx.run(`CREATE TEMP TRIGGER block_export_body BEFORE INSERT ON export_artifact_bodies
    BEGIN SELECT RAISE(ABORT, 'registry unavailable'); END`));
  try {
    expect(rejection(() => app.execute(owner, exportCommand(f, a, true))).code).toBe("export_failed");
  } finally {
    f.rt.store.transaction(tx => tx.run("DROP TRIGGER block_export_body"));
  }
  const states = app.exports(owner, a.id).manifests.map(m => `${m.id === kept.id ? "kept" : "other"}:${m.state}`);
  // Failed records are bounded among themselves (maxExports 1) and the valid export survives.
  expect(states.sort()).toEqual(["kept:valid", "other:failed"]);
  expect(artifactText(f, kept)).toContain("preserve-025");
});

test("an artifact exists iff its committed row is valid: other connections never see an uncommitted export", async () => {
  const f = await fixture();
  const a = project(f, "โครงการมองเห็น", "หัวข้อ");
  say(f, a, "ข้อความ visible-017");
  const observer = new TransactionStore(f.config.databasePath); stores.push(observer);
  const seen: number[] = [];
  const app = hookedApp(f, stage => {
    if (stage === "receipt") seen.push(observer.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM export_artifacts")!.n));
  });
  const receipt = app.execute(app.authenticate(f.token).actor, exportCommand(f, a, true));
  expect(seen).toEqual([0]);
  expect(observer.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM export_artifact_bodies WHERE id = ?", receipt.manifest.id)!.n)).toBe(1);
  expect(receipt.manifest.artifact).toEqual({ storage: "sqlite", bytes: receipt.manifest.artifact.bytes, hash: receipt.manifest.artifact.hash,
    downloadPath: `/projects/${a.id}/exports/${receipt.manifest.id}/artifact` });
});

test("format-1 manifests normalize as legacy, unverified files and retire their file with the row", async () => {
  const f = await fixture();
  const a = project(f, "โครงการรุ่นเก่า", "หัวข้อ");
  const id = crypto.randomUUID(), path = join(f.root, `${id}.json`);
  const body = JSON.stringify({ contract: "ops.project_export/v1", projectId: a.id, exportedAt: epoch, scope: { includeHistory: false }, note: "v1", data: { legacy: "ไทย ✓" } });
  writeFileSync(path, body, { mode: 0o600 });
  const legacy = { contract: "ops.project_export/v1", id, projectId: a.id, createdAt: epoch - 1, appSchema: 18, scope: { includeHistory: false }, projectRevision: 1,
    coverage: { sources: [], claims: [], truncated: false }, counts: { topics: 1, messages: 0, tasks: 0, decisions: 0, claims: 0, jobs: 0, deliveries: 0 },
    exclusions: [], missingRefs: [], pendingDeletions: [], residuals: { backups: [], external: [] }, lifecycle: { tombstonesApplied: 0, note: "" },
    retention: { maxExports: 20, maxBytes: 33554432, pruned: [] }, state: "valid",
    artifact: { path, bytes: Buffer.byteLength(body), hash: new Bun.CryptoHasher("sha256").update(body).digest("hex") } };
  f.rt.store.transaction(tx => tx.run("INSERT INTO export_artifacts VALUES (?, ?, ?, ?)", id, a.id, legacy.createdAt, JSON.stringify(legacy)));
  const read = f.rt.app.export(actor(f), a.id, id).manifest as ValidExportManifest;
  expect(read.formatVersion).toBe(1);
  expect(read.artifact).toEqual({ storage: "legacy_file", path, bytes: legacy.artifact.bytes, hash: legacy.artifact.hash, directorySync: "legacy_unverified" });
  expect(read.completeness.complete).toBe(false);
  expect(read.disclosure.rawHistory).toBe("included");
  expect(read.counts.prReports).toBe(0);
  expect(artifactText(f, read)).toBe(body);
  // Retention retires the legacy row and its file together.
  const app = hookedApp(f, () => {}, { exportLimits: { maxExports: 1 } });
  const next = app.execute(app.authenticate(f.token).actor, exportCommand(f, a, false));
  expect(next.manifest.retention.pruned).toEqual([id]);
  expect(() => readFileSync(path)).toThrow();
});

test("backups never carry export artifacts, so a restore cannot resurrect exported content", async () => {
  const f = await fixture();
  const a = project(f, "โครงการสำรอง", "หัวข้อ");
  say(f, a, "ข้อความ backup-strip-026 ไทย");
  f.rt.app.execute(actor(f), exportCommand(f, a, true));
  const backup = f.rt.app.execute(actor(f), { kind: "backup.create" as const, requestId: rid(), projectId: null,
    expectedRevision: f.rt.app.workspace(actor(f)).revision, payload: { note: "strip check" } });
  const bytes = readFileSync(backup.manifest.artifact.path);
  const copyPath = join(f.root, "backup-copy.sqlite");
  writeFileSync(copyPath, bytes);
  const copy = new Database(copyPath);
  try {
    expect(copy.query("SELECT count(*) AS n FROM export_artifacts").get()).toEqual({ n: 0 });
    expect(copy.query("SELECT count(*) AS n FROM export_artifact_bodies").get()).toEqual({ n: 0 });
  } finally { copy.close(); }
  // The artifact framing never appears in the backup's free pages either.
  expect(bytes.includes(Buffer.from('"formatVersion":2,"exportId"'))).toBe(false);
});
