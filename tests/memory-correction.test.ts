import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Application } from "../src/application";
import { readConfig } from "../src/config";
import { JobQueue } from "../src/jobs/queue";
import { memoryExtractionMarker, memoryExtractionWork, scriptedMemoryResult } from "../src/memory/extract";
import { capped, impactPreviewBounds } from "../src/memory/correct";
import type { ClaimReference, CorrectMemoryCommand, MemoryClaim } from "../src/memory/types";
import type { SourceReference } from "../src/sources";
import { TransactionStore } from "../src/store";
import { coordinatorSynthesisMarker, coordinatorSynthesisWork } from "../src/team/decisions";
import { discussionPlanWork, specialistAnalysisWork } from "../src/team/dispatch";
import { ScriptedRunPort, fixtureOutcome, specialistFixtureResult } from "../src/team/scripted-port";
import type { ApplicationRunRequest, RoleRoute, TeamCommand } from "../src/team/types";
import { createWebHandler } from "../src/web";

const roots: string[] = [], stores: TransactionStore[] = [], live: JobQueue[] = [];
afterEach(async () => {
  for (const q of live.splice(0)) { q.close(); await q.idle(); }
  for (const s of stores.splice(0)) s.close();
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});
const rid = () => crypto.randomUUID(), epoch = 1800000000000, day = 86400000, password = "memory-correction-owner-password";
const grok: RoleRoute = { provider: "grok", model: "fixture-grok-exact", authRoute: "owner-grok" };
type Script = (request: ApplicationRunRequest, signal: AbortSignal) => unknown | Promise<unknown>;
type Config = ReturnType<typeof readConfig>;

function boot(config: Config, hooks: { extract: Script; specialist: Script }, clock: { now: number }) {
  const store = new TransactionStore(config.databasePath); stores.push(store);
  const port = new ScriptedRunPort(store, config.team, config.jobs.outputBytes, (request, signal) =>
    request.instructions.operator.includes(memoryExtractionMarker) ? hooks.extract(request, signal)
      : request.instructions.operator.includes(coordinatorSynthesisMarker) ? fixtureOutcome("complete", JSON.stringify(synthesisJson(request)))
      : hooks.specialist(request, signal));
  const now = () => clock.now;
  const queue = new JobQueue(store, config.jobs, [memoryExtractionWork(store, config, port, now), discussionPlanWork(),
    specialistAnalysisWork(store, config, port, now), coordinatorSynthesisWork(store, config, port, now)], { now }); live.push(queue);
  const app = new Application(store, config, { jobs: queue, now });
  return { store, port, queue, app };
}

function synthesisJson(request: ApplicationRunRequest) {
  const citations = request.manifest.sources.map(source => ({ ...source.reference }));
  return { question: "เจ้าของจะเลือกทางใด", disagreement: false, consensus: true, options: [
    { id: "first", label: "ทางแรก", rationale: "ตามผลวิเคราะห์", citations },
    { id: "second", label: "ทางที่สอง", rationale: "ทางเลือกสำรอง", citations },
  ] };
}

async function fixture(env: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "jit-mem03-")); roots.push(root);
  const config = readConfig({ JIT_DATABASE: join(root, "state.sqlite"), ...env }), clock = { now: epoch };
  const defaults = {
    extract: ((request: ApplicationRunRequest) => scriptedMemoryResult(request, true)) as Script,
    specialist: ((request: ApplicationRunRequest) => fixtureOutcome("complete", specialistFixtureResult("ตอบจำลอง", request, config.jobs.outputBytes))) as Script,
  };
  const hooks = { ...defaults };
  const rt = boot(config, hooks, clock);
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
async function restart(f: Fixture) {
  f.rt.queue.close(); await f.rt.queue.idle(); live.splice(live.indexOf(f.rt.queue), 1);
  f.rt.store.close(); stores.splice(stores.indexOf(f.rt.store), 1);
  f.rt = boot(f.config, f.hooks, f.clock);
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
  const topic = f.rt.app.execute(actor(f), { kind: "topic.create", projectId: created.id, requestId: rid(), expectedRevision: created.revision, payload: { title } }).topic;
  return { id: created.id, topic };
}
type Project = ReturnType<typeof project>;
const topicRevision = (f: Fixture, p: Project) => f.rt.app.conversation(actor(f), p.id, p.topic.id).topic.revision;
function say(f: Fixture, p: Project, text: string): SourceReference {
  return f.rt.app.execute(actor(f), { kind: "message.send", requestId: rid(), projectId: p.id, expectedRevision: topicRevision(f, p), payload: { topicId: p.topic.id, text } }).message.source;
}
const claims = (f: Fixture, p: Project): MemoryClaim[] => f.rt.app.memory(actor(f), p.id).items.flatMap(item => item.state === "available" ? [item.claim] : []);
const ref = (claim: ClaimReference): ClaimReference => ({ claimId: claim.claimId, revision: claim.revision, generation: claim.generation });
function extractCommand(f: Fixture, p: Project, source: SourceReference, dependencies: ClaimReference[] = []) {
  return { kind: "memory.extract" as const, requestId: rid(), projectId: p.id, expectedRevision: f.rt.app.project(actor(f), p.id).revision,
    payload: { topicId: p.topic.id, roleId: f.roles.tech, source, dependencies, limits: { ...f.config.jobs.maximum } } };
}
async function remember(f: Fixture, p: Project, source: SourceReference, options: { dependencies?: ClaimReference[]; output?: Script } = {}): Promise<MemoryClaim> {
  const before = new Set(claims(f, p).map(claim => claim.claimId));
  if (options.output) f.hooks.extract = options.output;
  try { f.rt.app.execute(actor(f), extractCommand(f, p, source, options.dependencies)); await drain(f); } finally { f.hooks.extract = f.defaults.extract; }
  const added = claims(f, p).filter(claim => !before.has(claim.claimId));
  expect(added).toHaveLength(1);
  return added[0]!;
}
function correctCommand(f: Fixture, p: Project, claim: ClaimReference, text: string, quote: string, source: SourceReference, reason = "เจ้าของแจ้งข้อมูลใหม่"): CorrectMemoryCommand {
  return { kind: "memory.correct", requestId: rid(), projectId: p.id, expectedRevision: f.rt.app.project(actor(f), p.id).revision,
    payload: { claim: ref(claim), text, quote, source, reason } };
}
function dispatch(f: Fixture, p: Project, purpose: string, sources: SourceReference[] = [p.topic.source]): Extract<TeamCommand, { kind: "team.dispatch" }> {
  return { kind: "team.dispatch", requestId: rid(), projectId: p.id, expectedRevision: f.rt.app.project(actor(f), p.id).revision,
    payload: { topicId: p.topic.id, purpose, sources, include: [f.roles.tech], exclude: [], limits: { ...f.config.jobs.maximum } } };
}
const jobState = (f: Fixture, jobId: string) => f.rt.store.read(tx => {
  const row = tx.get<{ record_json: string }>("SELECT record_json FROM jobs WHERE id = ?", jobId)!;
  const job = JSON.parse(row.record_json) as { state: string; reason: string | null };
  return { state: job.state, reason: job.reason };
});

test("MEM03 correct claim -> replacement readable, old fenced, derived unavailable, next context uses replacement", async () => {
  const f = await fixture();
  const p = project(f, "Jit MVP", "ฐานข้อมูลสำหรับ MVP");
  const stale = await remember(f, p, say(f, p, "ใช้ PostgreSQL สำหรับทุกโครงการ"));
  const planSource = say(f, p, "ต้องทบทวนแผน PostgreSQL เดิมก่อนตัดสินใจ");
  const derivedOutput: Script = request => fixtureOutcome("complete", JSON.stringify({ version: 1, complete: true,
    claims: [{ kind: "inference" as const, text: `ดังนั้นทุกโครงการต้องตั้งค่า PostgreSQL`, quote: request.manifest.sources[0]!.text, source: request.manifest.sources[0]!.reference, dependencies: [], conflicts: [] }] }));
  const derived = await remember(f, p, planSource, { dependencies: [ref(stale)], output: derivedOutput });
  expect(derived.dependencies).toEqual([ref(stale)]);

  const impact = f.rt.app.correctionImpact(actor(f), p.id, ref(stale));
  expect(impact.claim.state).toBe("available");
  expect(impact.correction).toBeNull();
  expect(impact.dependents.map(item => item.reference.claimId)).toEqual([derived.claimId]);
  expect(impact.note.length).toBeGreaterThan(0);

  const evidence = say(f, p, "เปลี่ยนมาใช้ SQLite สำหรับ MVP แทน PostgreSQL เดิม");
  const fixed = f.rt.app.execute(actor(f), correctCommand(f, p, stale, "ใช้ SQLite สำหรับ MVP", "เปลี่ยนมาใช้ SQLite สำหรับ MVP แทน PostgreSQL เดิม", evidence));
  expect(fixed.replacement.revision).toBe(1);

  expect(f.rt.app.memoryClaim(actor(f), p.id, ref(stale))).toMatchObject({ state: "unavailable", reason: "claim_corrected" });
  expect(f.rt.app.memoryClaim(actor(f), p.id, ref(derived))).toMatchObject({ state: "unavailable", reason: "dependency_unavailable" });
  const replacement = f.rt.app.memoryClaim(actor(f), p.id, fixed.replacement);
  expect(replacement.state).toBe("available");
  if (replacement.state === "available") expect(replacement.claim.text).toBe("ใช้ SQLite สำหรับ MVP");
  expect(f.rt.app.memoryCorrection(actor(f), p.id, stale.claimId)).toMatchObject({ claimId: stale.claimId, replacement: fixed.replacement, reason: "เจ้าของแจ้งข้อมูลใหม่" });

  await restart(f);
  f.clock.now += day;
  f.token = await f.rt.app.login(password);
  expect(f.rt.app.memoryClaim(actor(f), p.id, ref(stale))).toMatchObject({ state: "unavailable", reason: "claim_corrected" });
  expect(f.rt.app.memoryClaim(actor(f), p.id, fixed.replacement).state).toBe("available");

  const started = f.rt.app.execute(actor(f), dispatch(f, p, "สรุปว่า MVP ใช้ฐานข้อมูลอะไร")).discussion!;
  await drain(f);
  const state = f.rt.app.discussion(actor(f), p.id, started.id);
  const used = state.discussion.manifest.claims.map(claim => claim.claimId);
  expect(used).toContain(fixed.replacement.claimId);
  expect(used).not.toContain(stale.claimId);
});

test("MEM03 correction fences queued extraction and running discussion; late results cannot commit stale facts", async () => {
  const f = await fixture();
  const p = project(f, "Jit MVP", "ฐานข้อมูลสำหรับ MVP");
  const stale = await remember(f, p, say(f, p, "ใช้ PostgreSQL สำหรับทุกโครงการ"));
  const queued = f.rt.app.execute(actor(f), extractCommand(f, p, say(f, p, "ข้อความประกอบการสกัด"), [ref(stale)]));
  const discussion = f.rt.app.execute(actor(f), dispatch(f, p, "ใช้ PostgreSQL สำหรับทุกโครงการจริงหรือ")).discussion!;
  const evidence = say(f, p, "เปลี่ยนมาใช้ SQLite สำหรับ MVP");
  f.rt.app.execute(actor(f), correctCommand(f, p, stale, "ใช้ SQLite สำหรับ MVP", "เปลี่ยนมาใช้ SQLite สำหรับ MVP", evidence));
  expect(jobState(f, queued.extraction.jobId)).toMatchObject({ state: "blocked" });
  expect(jobState(f, discussion.jobId)).toMatchObject({ state: "blocked" });
  await drain(f);
  const state = f.rt.app.discussion(actor(f), p.id, discussion.id);
  // The stored manifest is immutable history, but it is no longer usable: the recorded
  // context is stale and no completed answer was committed from the corrected claim.
  expect(state.context!.current).toBe(false);
  expect(state.context!.entries.find(entry => entry.kind === "claim" && entry.id === stale.claimId)).toMatchObject({ current: false });
  expect(state.discussion.participations.every(item => item.state !== "completed" || !JSON.stringify(item).includes("PostgreSQL สำหรับทุกโครงการ"))).toBe(true);
});

test("MEM03 stale, duplicate, conflicting and unusable-evidence corrections fail without state change", async () => {
  const f = await fixture();
  const p = project(f, "Jit MVP", "ฐานข้อมูลสำหรับ MVP");
  const stale = await remember(f, p, say(f, p, "ใช้ PostgreSQL สำหรับทุกโครงการ"));
  const revision = f.rt.app.project(actor(f), p.id).revision;
  const evidence = say(f, p, "เปลี่ยนมาใช้ SQLite สำหรับ MVP");
  const base = correctCommand(f, p, stale, "ใช้ SQLite สำหรับ MVP", "เปลี่ยนมาใช้ SQLite สำหรับ MVP", evidence);

  expect(() => f.rt.app.execute(actor(f), { ...base, requestId: rid(), expectedRevision: revision - 1 })).toThrow("stale_revision");
  expect(() => f.rt.app.execute(actor(f), { ...base, requestId: rid(), payload: { ...base.payload, claim: { claimId: rid(), revision: 1, generation: 1 } } })).toThrow("memory_correction_unavailable");
  expect(() => f.rt.app.execute(actor(f), { ...base, requestId: rid(), payload: { ...base.payload, quote: "ข้อความที่ไม่มีในต้นฉบับ" } })).toThrow("memory_correction_unavailable");
  expect(f.rt.app.memoryClaim(actor(f), p.id, ref(stale)).state).toBe("available");

  const done = f.rt.app.execute(actor(f), base);
  expect(done.replacement.claimId).not.toBe(stale.claimId);
  expect(() => f.rt.app.execute(actor(f), { ...base, payload: { ...base.payload, text: "ข้อความอื่น" } })).toThrow("request_id_conflict");
  expect(() => f.rt.app.execute(actor(f), { ...base, requestId: rid(), expectedRevision: f.rt.app.project(actor(f), p.id).revision })).toThrow("memory_already_corrected");
});

test("MEM03 cross-project pending discussion is fenced and reported in impact", async () => {
  const f = await fixture();
  const first = project(f, "โครงการแรก", "ใช้ PostgreSQL สำหรับทุกโครงการ");
  const second = project(f, "โครงการที่สอง", "หัวข้อข้ามโครงการ");
  const stale = await remember(f, first, say(f, first, "ใช้ PostgreSQL สำหรับทุกโครงการ"));
  const discussion = f.rt.app.execute(actor(f), dispatch(f, second, "ใช้ PostgreSQL สำหรับทุกโครงการ ตามโครงการแรก", [second.topic.source])).discussion!;
  await f.rt.queue.idle();
  const impact = f.rt.app.correctionImpact(actor(f), first.id, ref(stale));
  expect(impact.pendingJobs.map(job => job.id)).toContain(discussion.jobId);
  expect(impact.pendingJobs.find(job => job.id === discussion.jobId)).toMatchObject({ projectId: second.id });
  expect(impact.contexts.map(entry => entry.id)).toContain(impact.contexts[0]!.id);
  expect(impact.truncated).toEqual({ dependents: false, contexts: false, pendingJobs: false });

  const evidence = say(f, first, "โครงการแรกเปลี่ยนมาใช้ SQLite สำหรับ MVP");
  f.rt.app.execute(actor(f), correctCommand(f, first, stale, "โครงการแรกใช้ SQLite", "โครงการแรกเปลี่ยนมาใช้ SQLite สำหรับ MVP", evidence));
  expect(jobState(f, discussion.jobId)).toMatchObject({ state: "blocked", reason: "source_retired" });
  await drain(f);
  expect(f.rt.app.discussion(actor(f), second.id, discussion.id).context!.current).toBe(false);
});

test("MEM03 transitive-only discussion is fenced and reported through the affected closure", async () => {
  const f = await fixture();
  const p = project(f, "Jit MVP", "ฐานข้อมูลสำหรับ MVP");
  const rootOutput: Script = request => fixtureOutcome("complete", JSON.stringify({ version: 1, complete: true,
    claims: [{ kind: "inference" as const, text: "DB หลักคือ PostgreSQL ทุกโครงการ", quote: request.manifest.sources[0]!.text, source: request.manifest.sources[0]!.reference, dependencies: [], conflicts: [] }] }));
  const root = await remember(f, p, say(f, p, "ใช้ PostgreSQL สำหรับทุกโครงการ"), { output: rootOutput });
  const midOutput: Script = request => fixtureOutcome("complete", JSON.stringify({ version: 1, complete: true,
    claims: [{ kind: "inference" as const, text: "ดังนั้นทุกโครงการต้องตั้งค่า PostgreSQL", quote: request.manifest.sources[0]!.text, source: request.manifest.sources[0]!.reference, dependencies: [], conflicts: [] }] }));
  const mid = await remember(f, p, say(f, p, "ต้องทบทวนแผน PostgreSQL เดิมก่อนตัดสินใจ"), { dependencies: [ref(root)], output: midOutput });
  const leafOutput: Script = request => fixtureOutcome("complete", JSON.stringify({ version: 1, complete: true,
    claims: [{ kind: "inference" as const, text: "สรุปแผนฐานข้อมูลไตรมาสนี้", quote: request.manifest.sources[0]!.text, source: request.manifest.sources[0]!.reference, dependencies: [], conflicts: [] }] }));
  const leaf = await remember(f, p, say(f, p, "สรุปแผนฐานข้อมูลไตรมาสนี้"), { dependencies: [ref(mid)], output: leafOutput });
  const discussion = f.rt.app.execute(actor(f), dispatch(f, p, "สรุปแผนฐานข้อมูลไตรมาสนี้")).discussion!;
  await f.rt.queue.idle();
  const manifestIds = discussion.manifest.claims.map(claim => claim.claimId);
  expect(manifestIds).toContain(leaf.claimId);
  expect(manifestIds).not.toContain(root.claimId);

  const impact = f.rt.app.correctionImpact(actor(f), p.id, ref(root));
  expect(impact.pendingJobs.map(job => job.id)).toContain(discussion.jobId);
  expect(impact.contexts.length).toBeGreaterThan(0);

  const evidence = say(f, p, "เปลี่ยนมาใช้ SQLite สำหรับ MVP");
  f.rt.app.execute(actor(f), correctCommand(f, p, root, "ใช้ SQLite สำหรับ MVP", "เปลี่ยนมาใช้ SQLite สำหรับ MVP", evidence));
  expect(jobState(f, discussion.jobId)).toMatchObject({ state: "blocked", reason: "source_retired" });
  await drain(f);
  expect(f.rt.app.discussion(actor(f), p.id, discussion.id).context!.current).toBe(false);
});

for (const shape of ['{"kind":"discussion"}', '{"kind":"specialist"}', '{}', '{"kind":"discussion","manifest":{}}', '{"kind":"discussion","manifest":{"claims":{}}}']) test(`MEM03 corrupt pending discussion fails closed for shape ${shape}`, async () => {
  const f = await fixture();
  const p = project(f, "Jit MVP", "ฐานข้อมูลสำหรับ MVP");
  const stale = await remember(f, p, say(f, p, "ใช้ PostgreSQL สำหรับทุกโครงการ"));
  const discussion = f.rt.app.execute(actor(f), dispatch(f, p, "ใช้ PostgreSQL สำหรับทุกโครงการจริงหรือ")).discussion!;
  await f.rt.queue.idle();
  f.rt.store.transaction(tx => tx.run("UPDATE team_runs SET record_json = ? WHERE id = ?", shape, discussion.id));
  const evidence = say(f, p, "เปลี่ยนมาใช้ SQLite สำหรับ MVP");
  const done = f.rt.app.execute(actor(f), correctCommand(f, p, stale, "ใช้ SQLite สำหรับ MVP", "เปลี่ยนมาใช้ SQLite สำหรับ MVP", evidence));
  expect(done.replacement.revision).toBe(1);
  expect(jobState(f, discussion.jobId)).toMatchObject({ state: "blocked", reason: "source_retired" });
});

test("MEM03 valid-JSON wrong-shape pending rows mark preview incomplete", async () => {
  const f = await fixture();
  const p = project(f, "Jit MVP", "ฐานข้อมูลสำหรับ MVP");
  const stale = await remember(f, p, say(f, p, "ใช้ PostgreSQL สำหรับทุกโครงการ"));
  const discussion = f.rt.app.execute(actor(f), dispatch(f, p, "ใช้ PostgreSQL สำหรับทุกโครงการจริงหรือ")).discussion!;
  await f.rt.queue.idle();
  const before = f.rt.app.correctionImpact(actor(f), p.id, ref(stale));
  expect(before.truncated.pendingJobs).toBe(false);
  for (const shape of ["{}", '{"kind":"discussion","manifest":{"claims":[{}]}}', '{"kind":"discussion","manifest":{"claims":["x"]}}']) {
    f.rt.store.transaction(tx => tx.run("UPDATE team_runs SET record_json = ? WHERE id = ?", shape, discussion.id));
    const impact = f.rt.app.correctionImpact(actor(f), p.id, ref(stale));
    expect(impact.truncated.pendingJobs).toBe(true);
  }
});

test("MEM03 spoofed discussion kind on a specialist run is fenced by job type", async () => {
  const f = await fixture();
  const p = project(f, "Jit MVP", "ฐานข้อมูลสำหรับ MVP");
  const stale = await remember(f, p, say(f, p, "ใช้ PostgreSQL สำหรับทุกโครงการ"));
  const discussion = f.rt.app.execute(actor(f), dispatch(f, p, "ใช้ PostgreSQL สำหรับทุกโครงการจริงหรือ")).discussion!;
  await f.rt.queue.idle();
  const runId = discussion.participations[0]!.runId;
  f.rt.store.transaction(tx => {
    const row = tx.get<{ record_json: string }>("SELECT record_json FROM team_runs WHERE id = ?", runId)!;
    const parsed = JSON.parse(row.record_json) as { kind?: string };
    parsed.kind = "discussion";
    tx.run("UPDATE team_runs SET record_json = ? WHERE id = ?", JSON.stringify(parsed), runId);
  });
  const evidence = say(f, p, "เปลี่ยนมาใช้ SQLite สำหรับ MVP");
  f.rt.app.execute(actor(f), correctCommand(f, p, stale, "ใช้ SQLite สำหรับ MVP", "เปลี่ยนมาใช้ SQLite สำหรับ MVP", evidence));
  expect(jobState(f, discussion.participations[0]!.jobId)).toMatchObject({ state: "blocked", reason: "source_retired" });
  expect(jobState(f, discussion.jobId)).toMatchObject({ state: "blocked", reason: "source_retired" });
});

test("MEM03 valid context-less pending specialist is not fenced as corrupt", async () => {
  const f = await fixture();
  const p = project(f, "Jit MVP", "ฐานข้อมูลสำหรับ MVP");
  const stale = await remember(f, p, say(f, p, "ใช้ PostgreSQL สำหรับทุกโครงการ"));
  const jobId = rid(), runId = rid(), contextId = rid();
  f.rt.store.transaction(tx => {
    tx.run("INSERT INTO jobs (id, project_id, queue_order, priority, state, occupies, route_key, record_json) VALUES (?, ?, 0, 0, 'queued', 0, 'fixture', ?)",
      jobId, p.id, JSON.stringify({ id: jobId, projectId: p.id, state: "queued", reason: null }));
    tx.run("INSERT INTO team_contexts VALUES (?, 1, 'active')", contextId);
    tx.run("INSERT INTO team_runs (id, project_id, job_id, context_id, record_json) VALUES (?, ?, ?, ?, ?)",
      runId, p.id, jobId, contextId, JSON.stringify({ kind: "specialist", request: { manifest: { sources: [], claims: [] } } }));
  });
  const evidence = say(f, p, "เปลี่ยนมาใช้ SQLite สำหรับ MVP");
  f.rt.app.execute(actor(f), correctCommand(f, p, stale, "ใช้ SQLite สำหรับ MVP", "เปลี่ยนมาใช้ SQLite สำหรับ MVP", evidence));
  expect(jobState(f, jobId)).toMatchObject({ state: "queued" });
});

test("MEM03 malformed specialist and coordinator rows are fenced, not skipped or fatal", async () => {
  const f = await fixture();
  const p = project(f, "Jit MVP", "ฐานข้อมูลสำหรับ MVP");
  const stale = await remember(f, p, say(f, p, "ใช้ PostgreSQL สำหรับทุกโครงการ"));
  const discussion = f.rt.app.execute(actor(f), dispatch(f, p, "ใช้ PostgreSQL สำหรับทุกโครงการจริงหรือ")).discussion!;
  await f.rt.queue.idle();
  const runId = discussion.participations[0]!.runId;
  f.rt.store.transaction(tx => tx.run("UPDATE team_runs SET record_json = ? WHERE id = ?", "{}", runId));
  const evidence = say(f, p, "เปลี่ยนมาใช้ SQLite สำหรับ MVP");
  f.rt.app.execute(actor(f), correctCommand(f, p, stale, "ใช้ SQLite สำหรับ MVP", "เปลี่ยนมาใช้ SQLite สำหรับ MVP", evidence));
  expect(jobState(f, discussion.jobId)).toMatchObject({ state: "blocked", reason: "source_retired" });
  expect(jobState(f, discussion.participations[0]!.jobId)).toMatchObject({ state: "blocked" });

  const q = project(f, "Jit MVP 2", "หัวข้อที่สอง");
  const stale2 = await remember(f, q, say(f, q, "ใช้ PostgreSQL สำหรับทุกโครงการ"));
  const second = f.rt.app.execute(actor(f), dispatch(f, q, "เตรียมข้อเสนอให้เจ้าของตัดสิน")).discussion!;
  await drain(f);
  f.rt.app.execute(actor(f), { kind: "decision.synthesize", requestId: rid(), projectId: q.id, expectedRevision: second.revision, payload: { discussionId: second.id, limits: { ...f.config.jobs.maximum } } });
  const synthesis = f.rt.store.read(tx => tx.get<{ job_id: string }>("SELECT job_id FROM coordinator_syntheses WHERE project_id = ?", q.id)!);
  f.rt.store.transaction(tx => tx.run("UPDATE coordinator_syntheses SET record_json = ? WHERE job_id = ?", '{"kind":"synthesis"}', synthesis.job_id));
  const evidence2 = say(f, q, "เปลี่ยนมาใช้ SQLite สำหรับ MVP");
  f.rt.app.execute(actor(f), correctCommand(f, q, stale2, "ใช้ SQLite สำหรับ MVP", "เปลี่ยนมาใช้ SQLite สำหรับ MVP", evidence2));
  expect(jobState(f, synthesis.job_id)).toMatchObject({ state: "blocked", reason: "source_retired" });
});

test("MEM03 invalid pending JSON marks preview incomplete and still fences on correct", async () => {
  const f = await fixture();
  const p = project(f, "Jit MVP", "ฐานข้อมูลสำหรับ MVP");
  const stale = await remember(f, p, say(f, p, "ใช้ PostgreSQL สำหรับทุกโครงการ"));
  const discussion = f.rt.app.execute(actor(f), dispatch(f, p, "ใช้ PostgreSQL สำหรับทุกโครงการจริงหรือ")).discussion!;
  await f.rt.queue.idle();
  f.rt.store.transaction(tx => tx.run("UPDATE team_runs SET record_json = ? WHERE id = ?", "not-json{{{", discussion.id));
  const impact = f.rt.app.correctionImpact(actor(f), p.id, ref(stale));
  expect(impact.truncated.pendingJobs).toBe(true);
  const evidence = say(f, p, "เปลี่ยนมาใช้ SQLite สำหรับ MVP");
  f.rt.app.execute(actor(f), correctCommand(f, p, stale, "ใช้ SQLite สำหรับ MVP", "เปลี่ยนมาใช้ SQLite สำหรับ MVP", evidence));
  expect(jobState(f, discussion.jobId)).toMatchObject({ state: "blocked", reason: "source_retired" });
});

test("MEM03 admitted extraction adapter is aborted by correction and its late result publishes nothing", async () => {
  const f = await fixture();
  const p = project(f, "Jit MVP", "ฐานข้อมูลสำหรับ MVP");
  const stale = await remember(f, p, say(f, p, "ใช้ PostgreSQL สำหรับทุกโครงการ"));
  let release!: () => void, entered!: () => void, aborted = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  f.hooks.extract = (request, signal) => {
    signal.addEventListener("abort", () => { aborted = true; });
    entered();
    return gate.then(() => scriptedMemoryResult(request, true));
  };
  const queued = f.rt.app.execute(actor(f), extractCommand(f, p, say(f, p, "another statement"), [ref(stale)]));
  f.rt.queue.pump(); await started;
  const evidence = say(f, p, "เปลี่ยนมาใช้ SQLite สำหรับ MVP");
  f.rt.app.execute(actor(f), correctCommand(f, p, stale, "ใช้ SQLite สำหรับ MVP", "เปลี่ยนมาใช้ SQLite สำหรับ MVP", evidence));
  expect(aborted).toBe(true);
  release(); await f.rt.queue.idle();
  const extraction = f.rt.store.read(tx => tx.get<{ record_json: string }>("SELECT record_json FROM memory_extractions WHERE id = ?", queued.extraction.id)!);
  expect(JSON.parse(extraction.record_json).state).not.toBe("complete");
  expect(claims(f, p).map(claim => claim.text)).toEqual(["ใช้ SQLite สำหรับ MVP"]);
  expect(f.rt.app.memoryClaim(actor(f), p.id, ref(stale))).toMatchObject({ state: "unavailable", reason: "claim_corrected" });
});

test("MEM03 pending preview window is decided by rows examined, not matches", async () => {
  const f = await fixture({ JIT_JOB_QUEUE_LIMIT: "600" });
  const p = project(f, "Jit MVP", "ฐานข้อมูลสำหรับ MVP");
  const stale = await remember(f, p, say(f, p, "ใช้ PostgreSQL สำหรับทุกโครงการ"));
  const total = impactPreviewBounds.pendingJobs + 2;
  for (let i = 0; i < total; i++) {
    const source = say(f, p, `ประกอบการสกัด ${i}`);
    f.rt.app.execute(actor(f), extractCommand(f, p, source, i === total - 1 ? [ref(stale)] : []));
  }
  const impact = f.rt.app.correctionImpact(actor(f), p.id, ref(stale));
  // The only citing job sits past the window: honestly empty AND truncated.
  expect(impact.pendingJobs).toHaveLength(0);
  expect(impact.truncated.pendingJobs).toBe(true);
});

test("MEM03 recorded contexts are deduplicated when one context cites root and dependent", async () => {
  const f = await fixture();
  const p = project(f, "Jit MVP", "ฐานข้อมูลสำหรับ MVP");
  const rootOutput: Script = request => fixtureOutcome("complete", JSON.stringify({ version: 1, complete: true,
    claims: [{ kind: "inference" as const, text: "DB หลักคือ PostgreSQL ทุกโครงการ", quote: request.manifest.sources[0]!.text, source: request.manifest.sources[0]!.reference, dependencies: [], conflicts: [] }] }));
  const root = await remember(f, p, say(f, p, "ใช้ PostgreSQL สำหรับทุกโครงการ"), { output: rootOutput });
  const midOutput: Script = request => fixtureOutcome("complete", JSON.stringify({ version: 1, complete: true,
    claims: [{ kind: "inference" as const, text: "ดังนั้นทุกโครงการต้องตั้งค่า PostgreSQL", quote: request.manifest.sources[0]!.text, source: request.manifest.sources[0]!.reference, dependencies: [], conflicts: [] }] }));
  const mid = await remember(f, p, say(f, p, "ต้องทบทวนแผน PostgreSQL เดิมก่อนตัดสินใจ"), { dependencies: [ref(root)], output: midOutput });
  const discussion = f.rt.app.execute(actor(f), dispatch(f, p, "PostgreSQL ตั้งค่าโครงการอย่างไร")).discussion!;
  await f.rt.queue.idle();
  const manifestIds = discussion.manifest.claims.map(claim => claim.claimId);
  expect(manifestIds).toContain(root.claimId);
  expect(manifestIds).toContain(mid.claimId);
  const impact = f.rt.app.correctionImpact(actor(f), p.id, ref(root));
  expect(impact.contexts.length).toBeGreaterThan(0);
  expect(new Set(impact.contexts.map(entry => entry.id)).size).toBe(impact.contexts.length);
});

test("MEM03 preview caps are honest: capped helper truncates and flags large impact lists", async () => {
  expect(capped([1, 2, 3], 3)).toEqual({ items: [1, 2, 3], truncated: false });
  expect(capped([1, 2, 3, 4], 3)).toEqual({ items: [1, 2, 3], truncated: true });
  const f = await fixture();
  const p = project(f, "Jit MVP", "ฐานข้อมูลสำหรับ MVP");
  const stale = await remember(f, p, say(f, p, "ใช้ PostgreSQL สำหรับทุกโครงการ"));
  const extractionId = f.rt.store.read(tx => tx.get<{ id: string }>("SELECT id FROM memory_extractions LIMIT 1")!.id);
  f.rt.store.transaction(tx => {
    for (let i = 0; i < impactPreviewBounds.dependents + 1; i++) {
      const id = rid();
      tx.run("INSERT INTO memory_claims (id, project_id, extraction_id, revision, generation, record_json) VALUES (?, ?, ?, 1, 1, ?)",
        id, p.id, extractionId, JSON.stringify({ claimId: id, revision: 1, generation: 1, projectId: p.id, extractionId,
          kind: "inference", text: `dependent ${i}`, quote: "q", source: stale.source, dependencies: [ref(stale)], conflicts: [],
          status: "active", createdAt: epoch, decision: null }));
    }
  });
  const impact = f.rt.app.correctionImpact(actor(f), p.id, ref(stale));
  expect(impact.dependents).toHaveLength(impactPreviewBounds.dependents);
  expect(impact.truncated.dependents).toBe(true);
  // A truncated dependent window makes downstream counts incomplete too (propagated).
  expect(impact.truncated.contexts).toBe(true);
  expect(impact.truncated.pendingJobs).toBe(true);
});

test("MEM03 correction keeps task, decision, role and standing authorization revisions untouched", async () => {
  const f = await fixture();
  const p = project(f, "Jit MVP", "ฐานข้อมูลสำหรับ MVP");
  const stale = await remember(f, p, say(f, p, "ใช้ PostgreSQL สำหรับทุกโครงการ"));
  const proposed = f.rt.app.execute(actor(f), { kind: "task.propose", requestId: rid(), projectId: p.id, expectedRevision: topicRevision(f, p),
    payload: { topicId: p.topic.id, title: "ย้าย schema", summary: "ทำ migration" } });
  const accepted = f.rt.app.execute(actor(f), { kind: "task.accept", requestId: rid(), projectId: p.id, expectedRevision: proposed.task.revision,
    payload: { taskId: proposed.task.id, proposalId: proposed.proposal.id } });
  const started = f.rt.app.execute(actor(f), dispatch(f, p, "เตรียมข้อเสนอให้เจ้าของตัดสิน")).discussion!;
  await drain(f);
  f.rt.app.execute(actor(f), { kind: "decision.synthesize", requestId: rid(), projectId: p.id, expectedRevision: started.revision, payload: { discussionId: started.id, limits: { ...f.config.jobs.maximum } } });
  await drain(f);
  const proposal = f.rt.app.decision(actor(f), p.id, p.topic.id).proposal!;
  const decision = f.rt.app.execute(actor(f), { kind: "decision.accept", requestId: rid(), projectId: p.id, expectedRevision: proposal.revision,
    payload: { proposalId: proposal.id, optionId: null, conclusion: "ใช้ PostgreSQL", rationale: "มติเดิมก่อนแก้ memory" } }).decision!;
  const teamBefore = f.rt.app.team(actor(f)).ownerRevision;
  const taskBefore = f.rt.app.task(actor(f), p.id, accepted.task.id).task;

  const evidence = say(f, p, "เปลี่ยนมาใช้ SQLite สำหรับ MVP");
  f.rt.app.execute(actor(f), correctCommand(f, p, stale, "ใช้ SQLite สำหรับ MVP", "เปลี่ยนมาใช้ SQLite สำหรับ MVP", evidence));

  expect(f.rt.app.task(actor(f), p.id, accepted.task.id).task).toEqual(taskBefore);
  expect(f.rt.app.decision(actor(f), p.id, p.topic.id).currentDecision).toMatchObject({ decision: { id: decision.id, conclusion: "ใช้ PostgreSQL" } });
  expect(f.rt.app.team(actor(f)).ownerRevision).toBe(teamBefore);
  expect(f.rt.app.memoryClaim(actor(f), p.id, ref(stale))).toMatchObject({ state: "unavailable" });
});

test("MEM03 cross-project context that used the old claim is no longer current after correction", async () => {
  const f = await fixture();
  const first = project(f, "โครงการแรก", "ใช้ PostgreSQL สำหรับทุกโครงการ");
  const second = project(f, "โครงการที่สอง", "หัวข้อข้ามโครงการ");
  const stale = await remember(f, first, say(f, first, "ใช้ PostgreSQL สำหรับทุกโครงการ"));
  const started = f.rt.app.execute(actor(f), dispatch(f, second, "ใช้ PostgreSQL สำหรับทุกโครงการ ตามโครงการแรก", [second.topic.source])).discussion!;
  await drain(f);
  const before = f.rt.app.discussion(actor(f), second.id, started.id);
  expect(before.discussion.manifest.claims.map(claim => claim.claimId)).toContain(stale.claimId);
  expect(before.context!.current).toBe(true);

  const evidence = say(f, first, "โครงการแรกเปลี่ยนมาใช้ SQLite สำหรับ MVP");
  f.rt.app.execute(actor(f), correctCommand(f, first, stale, "โครงการแรกใช้ SQLite", "โครงการแรกเปลี่ยนมาใช้ SQLite สำหรับ MVP", evidence));

  const after = f.rt.app.discussion(actor(f), second.id, started.id);
  expect(after.context!.current).toBe(false);
  expect(f.rt.app.memoryClaim(actor(f), second.id, ref(stale)).state).toBe("unavailable");
});

test("MEM03 correction over HTTP: API commits, claim page links the replacement and impact is visible", async () => {
  const f = await fixture();
  const p = project(f, "Jit MVP", "ฐานข้อมูลสำหรับ MVP");
  const stale = await remember(f, p, say(f, p, "ใช้ PostgreSQL สำหรับทุกโครงการ"));
  const auth = f.rt.app.authenticate(f.token);
  const handler = createWebHandler(f.rt.app);
  const call = (path: string, body?: Record<string, unknown>) => handler(new Request(`${f.config.origin}${path}`, { method: body ? "POST" : "GET",
    headers: { cookie: `jit_session=${f.token}`, ...(body ? { origin: f.config.origin, "x-csrf-token": auth.csrf, "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) }));
  const revision = f.rt.app.project(actor(f), p.id).revision;
  const evidence = say(f, p, "เปลี่ยนมาใช้ SQLite สำหรับ MVP");
  const posted = await call(`/api/projects/${p.id}/memory/claims/${stale.claimId}`,
    { requestId: rid(), expectedRevision: revision, revision: stale.revision, generation: stale.generation,
      text: "ใช้ SQLite สำหรับ MVP", quote: "เปลี่ยนมาใช้ SQLite สำหรับ MVP", source: evidence, reason: "ผ่าน API" });
  expect(posted.status).toBe(200);
  const receipt = (await posted.json()) as { replacement: ClaimReference };
  const page = await call(`/projects/${p.id}/memory/claims/${stale.claimId}?revision=${stale.revision}&generation=${stale.generation}`);
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain("Memory นี้ถูกแก้แล้ว");
  expect(html).toContain(receipt.replacement.claimId);
  const available = f.rt.app.memoryClaim(actor(f), p.id, receipt.replacement);
  expect(available.state).toBe("available");
});
