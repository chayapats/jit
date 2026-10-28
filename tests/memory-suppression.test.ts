import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Application } from "../src/application";
import { readConfig } from "../src/config";
import { JobQueue } from "../src/jobs/queue";
import { memoryExtractionMarker, memoryExtractionWork, scriptedMemoryResult } from "../src/memory/extract";
import type { ClaimReference, ForgetMemoryCommand, MemoryClaim } from "../src/memory/types";
import type { SourceReference } from "../src/sources";
import { ScriptedRunPort, fixtureOutcome, specialistFixtureResult } from "../src/team/scripted-port";
import type { ApplicationRunRequest, RoleRoute, TeamCommand } from "../src/team/types";
import type { ApplicationRunPort } from "../src/team/run-port";
import { coordinatorSynthesisMarker, coordinatorSynthesisWork } from "../src/team/decisions";
import { discussionPlanWork, specialistAnalysisWork } from "../src/team/dispatch";
import { scriptedPreviewWork } from "../src/team/preview";
import { TransactionStore } from "../src/store";
import { createWebHandler } from "../src/web";

const roots: string[] = [], stores: TransactionStore[] = [], live: JobQueue[] = [];
afterEach(async () => {
  for (const q of live.splice(0)) { q.close(); await q.idle(); }
  for (const s of stores.splice(0)) s.close();
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});
const rid = () => crypto.randomUUID(), epoch = 1800000000000, day = 86400000, password = "memory-suppression-owner-password";
const grok: RoleRoute = { provider: "grok", model: "fixture-grok-exact", authRoute: "owner-grok" };
type Script = (request: ApplicationRunRequest, signal: AbortSignal) => unknown | Promise<unknown>;
type Config = ReturnType<typeof readConfig>;

function boot(config: Config, hooks: { extract: Script; specialist: Script }, clock: { now: number }, flags: { retire: boolean }) {
  const store = new TransactionStore(config.databasePath); stores.push(store);
  const script = (request: ApplicationRunRequest, signal: AbortSignal, observe: (event: never) => void) =>
    request.instructions.operator.includes(memoryExtractionMarker) ? hooks.extract(request, signal)
      : request.instructions.operator.includes(coordinatorSynthesisMarker) ? fixtureOutcome("complete", JSON.stringify(synthesisJson(request)))
      : hooks.specialist(request, signal);
  const port = new ScriptedRunPort(store, config.team, config.jobs.outputBytes, script, undefined, () => flags.retire);
  const now = () => clock.now;
  const queue = new JobQueue(store, config.jobs, [memoryExtractionWork(store, config, port, now), discussionPlanWork(),
    specialistAnalysisWork(store, config, port, now), coordinatorSynthesisWork(store, config, port, now), scriptedPreviewWork(store, config, port, now)], { now }); live.push(queue);
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

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "jit-mem04-")); roots.push(root);
  const config = readConfig({ JIT_DATABASE: join(root, "state.sqlite") }), clock = { now: epoch }, flags = { retire: false };
  const defaults = {
    extract: ((request: ApplicationRunRequest) => scriptedMemoryResult(request, true)) as Script,
    specialist: ((request: ApplicationRunRequest) => fixtureOutcome("complete", specialistFixtureResult("ตอบจำลอง", request, config.jobs.outputBytes))) as Script,
  };
  const hooks = { ...defaults };
  const rt = boot(config, hooks, clock, flags);
  await rt.app.setupOwner(password);
  const f = { root, config, clock, flags, hooks, defaults, rt, token: await rt.app.login(password), roles: { tech: "", coordinator: "" } };
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
  f.rt = boot(f.config, f.hooks, f.clock, f.flags);
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
async function remember(f: Fixture, p: Project, source: SourceReference, options: { dependencies?: ClaimReference[]; output?: Script } = {}): Promise<MemoryClaim[]> {
  const before = new Set(claims(f, p).map(claim => claim.claimId));
  if (options.output) f.hooks.extract = options.output;
  try { f.rt.app.execute(actor(f), extractCommand(f, p, source, options.dependencies)); await drain(f); } finally { f.hooks.extract = f.defaults.extract; }
  return claims(f, p).filter(claim => !before.has(claim.claimId));
}
function forgetCommand(f: Fixture, p: Project, claim: ClaimReference, reason = "เจ้าของขอให้ลืมเรื่องนี้", acknowledged = true): ForgetMemoryCommand {
  return { kind: "memory.forget", requestId: rid(), projectId: p.id, expectedRevision: f.rt.app.project(actor(f), p.id).revision,
    payload: { claim: ref(claim), reason, acknowledged } };
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

test("MEM04 forget withdraws claim, dependents and same-source siblings; replay, retrieval and restart stay fenced", async () => {
  const f = await fixture();
  const first = project(f, "โครงการแรก", "ใช้ PostgreSQL สำหรับทุกโครงการ");
  const second = project(f, "โครงการที่สอง", "หัวข้อข้ามโครงการ");
  const origin = say(f, first, "ใช้ PostgreSQL สำหรับทุกโครงการ");
  const pair: Script = request => fixtureOutcome("complete", JSON.stringify({ version: 1, complete: true, claims: [
    { kind: "inference" as const, text: "ใช้ PostgreSQL สำหรับโครงการแรก", quote: request.manifest.sources[0]!.text, source: request.manifest.sources[0]!.reference, dependencies: [], conflicts: [] },
    { kind: "inference" as const, text: "ต้องสำรองฐานข้อมูล PostgreSQL ทุกคืน", quote: request.manifest.sources[0]!.text, source: request.manifest.sources[0]!.reference, dependencies: [], conflicts: [] },
  ] }));
  const [target, sibling] = await remember(f, first, origin, { output: pair });
  const derivedOutput: Script = request => fixtureOutcome("complete", JSON.stringify({ version: 1, complete: true,
    claims: [{ kind: "inference" as const, text: "ดังนั้นทุกโครงการต้องตั้งค่า PostgreSQL", quote: request.manifest.sources[0]!.text, source: request.manifest.sources[0]!.reference, dependencies: [], conflicts: [] }] }));
  const [derived] = await remember(f, first, say(f, first, "ต้องทบทวนแผน PostgreSQL เดิมก่อนตัดสินใจ"), { dependencies: [ref(target!)], output: derivedOutput });
  const started = f.rt.app.execute(actor(f), dispatch(f, second, "ใช้ PostgreSQL สำหรับทุกโครงการ ตามโครงการแรก", [second.topic.source])).discussion!;
  await drain(f);
  const before = f.rt.app.discussion(actor(f), second.id, started.id);
  expect(before.discussion.manifest.claims.map(claim => claim.claimId)).toContain(target!.claimId);

  const impact = f.rt.app.suppressionImpact(actor(f), first.id, ref(target!));
  expect(impact.claim.state).toBe("available");
  expect(impact.suppression).toBeNull();
  expect(impact.dependents.map(item => item.reference.claimId)).toContain(derived!.claimId);
  expect(impact.siblings.map(item => item.reference.claimId)).toEqual([sibling!.claimId]);
  expect(impact.contexts.length).toBeGreaterThan(0);
  expect(impact.note.length).toBeGreaterThan(0);

  const receipt = f.rt.app.execute(actor(f), forgetCommand(f, first, target!));
  expect(receipt.withdrawn.map(item => item.claimId).sort()).toEqual([target!.claimId, sibling!.claimId, derived!.claimId].sort());
  expect(f.rt.app.memoryClaim(actor(f), first.id, ref(target!))).toMatchObject({ state: "unavailable", reason: "claim_forgotten" });
  expect(f.rt.app.memoryClaim(actor(f), first.id, ref(sibling!))).toMatchObject({ state: "unavailable", reason: "claim_forgotten" });
  expect(f.rt.app.memoryClaim(actor(f), first.id, ref(derived!))).toMatchObject({ state: "unavailable", reason: "claim_forgotten" });

  expect(() => f.rt.app.execute(actor(f), extractCommand(f, first, origin))).toThrow("memory_source_suppressed");
  expect(claims(f, first)).toHaveLength(0);

  await restart(f);
  f.clock.now += day;
  f.token = await f.rt.app.login(password);
  expect(f.rt.app.memoryClaim(actor(f), first.id, ref(target!))).toMatchObject({ state: "unavailable", reason: "claim_forgotten" });
  expect(f.rt.app.memorySuppression(actor(f), first.id, target!.claimId)).toMatchObject({ claimId: target!.claimId });
  expect(f.rt.app.suppressionLedger(actor(f), first.id, target!.claimId)).toMatchObject({ retire: { state: "complete" } });

  const again = f.rt.app.execute(actor(f), dispatch(f, second, "ใช้ PostgreSQL สำหรับทุกโครงการ ตามโครงการแรก", [second.topic.source])).discussion!;
  await drain(f);
  const used = f.rt.app.discussion(actor(f), second.id, again.id).discussion.manifest.claims.map(claim => claim.claimId);
  expect(used).not.toContain(target!.claimId);
  expect(used).not.toContain(sibling!.claimId);
  // Raw history stays manually viewable but is never silently replayed into prompts.
  expect(f.rt.app.conversation(actor(f), first.id, first.topic.id).items.length).toBeGreaterThan(0);
  expect(f.rt.app.source(actor(f), first.id, origin)).toMatchObject({ state: "available" });
  expect(f.rt.app.sourceSuppressed(actor(f), first.id, origin)).toBe(true);
});

test("MEM04 forget fences queued extraction and running discussion; late results cannot commit stale facts", async () => {
  const f = await fixture();
  const p = project(f, "Jit MVP", "ฐานข้อมูลสำหรับ MVP");
  const target = (await remember(f, p, say(f, p, "ใช้ PostgreSQL สำหรับทุกโครงการ")))[0]!;
  const queued = f.rt.app.execute(actor(f), extractCommand(f, p, say(f, p, "ข้อความประกอบการสกัด"), [ref(target)]));
  const discussion = f.rt.app.execute(actor(f), dispatch(f, p, "ใช้ PostgreSQL สำหรับทุกโครงการจริงหรือ")).discussion!;
  f.rt.app.execute(actor(f), forgetCommand(f, p, target));
  expect(jobState(f, queued.extraction.jobId)).toMatchObject({ state: "blocked" });
  expect(jobState(f, discussion.jobId)).toMatchObject({ state: "blocked" });
  await drain(f);
  const state = f.rt.app.discussion(actor(f), p.id, discussion.id);
  expect(state.context!.current).toBe(false);
  expect(state.discussion.participations.every(item => item.state !== "completed" || !JSON.stringify(item).includes("PostgreSQL สำหรับทุกโครงการ"))).toBe(true);
  expect(f.rt.app.memory(actor(f), p.id).extractions.find(e => e.id === queued.extraction.id)?.claimIds ?? []).toHaveLength(0);
});

test("MEM04 ambiguous forget overlapping an active task mutates nothing; acknowledged forget keeps obligations", async () => {
  const f = await fixture();
  const p = project(f, "Jit MVP", "ฐานข้อมูลสำหรับ MVP");
  const target = (await remember(f, p, say(f, p, "ใช้ PostgreSQL สำหรับทุกโครงการ")))[0]!;
  const proposed = f.rt.app.execute(actor(f), { kind: "task.propose", requestId: rid(), projectId: p.id, expectedRevision: topicRevision(f, p),
    payload: { topicId: p.topic.id, title: "ย้าย PostgreSQL ไปฐานข้อมูลใหม่", summary: "วางแผนย้าย PostgreSQL" } });
  const taskBefore = f.rt.app.task(actor(f), p.id, proposed.task.id).task;
  const teamBefore = f.rt.app.team(actor(f)).ownerRevision;

  const impact = f.rt.app.suppressionImpact(actor(f), p.id, ref(target));
  expect(impact.overlaps.map(item => item.id)).toContain(proposed.task.id);

  expect(() => f.rt.app.execute(actor(f), forgetCommand(f, p, target, "เจ้าของขอให้ลืมเรื่องนี้", false))).toThrow("memory_forget_ambiguous");
  expect(() => f.rt.app.execute(actor(f), { ...forgetCommand(f, p, target), requestId: rid(),
    payload: { claim: ref(target), reason: "x" } } as unknown as ForgetMemoryCommand)).toThrow("invalid_memory_forget");
  expect(f.rt.app.memoryClaim(actor(f), p.id, ref(target)).state).toBe("available");
  expect(f.rt.app.task(actor(f), p.id, proposed.task.id).task).toEqual(taskBefore);

  f.rt.app.execute(actor(f), forgetCommand(f, p, target));
  expect(f.rt.app.memoryClaim(actor(f), p.id, ref(target))).toMatchObject({ state: "unavailable", reason: "claim_forgotten" });
  expect(f.rt.app.task(actor(f), p.id, proposed.task.id).task).toEqual(taskBefore);
  expect(f.rt.app.team(actor(f)).ownerRevision).toBe(teamBefore);
});

test("MEM04 fake retire-failure keeps routes blocked and reports incomplete; retry completes the ledger", async () => {
  const f = await fixture();
  f.flags.retire = true;
  const p = project(f, "Jit MVP", "ฐานข้อมูลสำหรับ MVP");
  const target = (await remember(f, p, say(f, p, "ใช้ PostgreSQL สำหรับทุกโครงการ")))[0]!;
  const discussion = f.rt.app.execute(actor(f), dispatch(f, p, "ใช้ PostgreSQL สำหรับทุกโครงการจริงหรือ")).discussion!;
  const receipt = f.rt.app.execute(actor(f), forgetCommand(f, p, target));
  expect(receipt.suppression.contexts.length).toBeGreaterThan(0);
  expect(jobState(f, discussion.jobId)).toMatchObject({ state: "blocked", reason: "source_retired" });
  expect(f.rt.app.suppressionLedger(actor(f), p.id, target.claimId)).toMatchObject({ retire: { state: "incomplete" } });

  const records = await f.rt.queue.reconcile(f.rt.port);
  expect(records.some(r => r.lifecycle === "retire_failed")).toBe(true);
  const incomplete = f.rt.app.suppressionLedger(actor(f), p.id, target.claimId)!;
  expect(incomplete.retire.state).toBe("incomplete");
  expect(jobState(f, discussion.jobId)).toMatchObject({ state: "blocked" });
  expect(JSON.stringify(incomplete)).not.toContain("PostgreSQL");

  f.flags.retire = false;
  await f.rt.queue.reconcile(f.rt.port);
  expect(f.rt.app.suppressionLedger(actor(f), p.id, target.claimId)).toMatchObject({ retire: { state: "complete" } });
  expect(jobState(f, discussion.jobId)).toMatchObject({ state: "blocked" });
});

test("MEM04 explicit new owner remember works while forged and background remember fail", async () => {
  const f = await fixture();
  const p = project(f, "Jit MVP", "ฐานข้อมูลสำหรับ MVP");
  const target = (await remember(f, p, say(f, p, "ใช้ PostgreSQL สำหรับทุกโครงการ")))[0]!;
  const origin = target.source;
  f.rt.app.execute(actor(f), forgetCommand(f, p, target));

  const fresh = say(f, p, "ใช้ PostgreSQL สำหรับทุกโครงการ");
  expect(fresh.sourceId).not.toBe(origin.sourceId);
  const [reborn] = await remember(f, p, fresh);
  expect(reborn!.source).toEqual(fresh);
  expect(f.rt.app.memoryClaim(actor(f), p.id, ref(reborn!)).state).toBe("available");

  const forged = Object.freeze({ ownerId: "owner", channel: "web" }) as unknown as Parameters<Application["execute"]>[0];
  expect(() => f.rt.app.execute(forged, extractCommand(f, p, fresh))).toThrow("authentication_required");
  expect(() => f.rt.app.execute(actor(f), extractCommand(f, p, say(f, p, "ข้อความอ้างอิงเดิม"), [ref(target)]))).toThrow("memory_dependency_unavailable");
  expect(() => f.rt.app.execute(actor(f), extractCommand(f, p, origin))).toThrow("memory_source_suppressed");
});

test("MEM04 forget over HTTP: API commits, claim page links the ledger and hides forgotten content", async () => {
  const f = await fixture();
  const p = project(f, "Jit MVP", "ฐานข้อมูลสำหรับ MVP");
  const target = (await remember(f, p, say(f, p, "ใช้ PostgreSQL สำหรับทุกโครงการ")))[0]!;
  const auth = f.rt.app.authenticate(f.token);
  const handler = createWebHandler(f.rt.app);
  const call = (path: string, body?: Record<string, unknown>) => handler(new Request(`${f.config.origin}${path}`, { method: body ? "POST" : "GET",
    headers: { cookie: `jit_session=${f.token}`, ...(body ? { origin: f.config.origin, "x-csrf-token": auth.csrf, "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) }));
  const revision = f.rt.app.project(actor(f), p.id).revision;

  const ambiguous = await call(`/api/projects/${p.id}/memory/claims/${target.claimId}`,
    { requestId: rid(), expectedRevision: revision, mode: "forget", revision: target.revision, generation: target.generation, reason: "ลืม", acknowledged: false });
  expect(ambiguous.status).toBe(409);
  expect(f.rt.app.memoryClaim(actor(f), p.id, ref(target)).state).toBe("available");

  const posted = await call(`/api/projects/${p.id}/memory/claims/${target.claimId}`,
    { requestId: rid(), expectedRevision: revision, mode: "forget", revision: target.revision, generation: target.generation, reason: "เจ้าของขอให้ลืม", acknowledged: true });
  expect(posted.status).toBe(200);
  const page = await call(`/projects/${p.id}/memory/claims/${target.claimId}?revision=${target.revision}&generation=${target.generation}`);
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain("Memory นี้ถูกลืมแล้ว");
  expect(html).toContain("การลืมไม่ใช่การลบ");
  expect(html).not.toContain("ใช้ PostgreSQL สำหรับทุกโครงการ");
  const ledger = f.rt.app.suppressionLedger(actor(f), p.id, target.claimId)!;
  expect(ledger.suppression.reason).toBe("เจ้าของขอให้ลืม");
});

/** The committed output source of a specialist/preview team run, or of the coordinator synthesis's decision proposal. */
const runOutput = (f: Fixture, runId: string): SourceReference => f.rt.store.read(tx =>
  (JSON.parse(tx.get<{ json: string }>("SELECT record_json AS json FROM team_runs WHERE id = ?", runId)!.json) as { source: SourceReference }).source);
const proposalOutput = (f: Fixture, discussionId: string): SourceReference => f.rt.store.read(tx => {
  const row = tx.get<{ sourceId: string; revision: number; generation: number }>(
    "SELECT source_id AS sourceId, source_revision AS revision, source_generation AS generation FROM decision_proposals WHERE discussion_id = ?", discussionId)!;
  return { sourceId: row.sourceId, revision: row.revision, generation: row.generation };
});

test("#110 forget suppresses specialist, role-preview and coordinator outputs of the forgotten message", async () => {
  const f = await fixture();
  const p = project(f, "โครงการลับ", "หัวข้อรหัส");
  const origin = say(f, p, "รหัสลับคือ ม่วง-42");
  const claim = (await remember(f, p, origin))[0]!;
  // The specialist copies its evidence into its result; the coordinator then cites that result.
  f.hooks.specialist = request => fixtureOutcome("complete", specialistFixtureResult(`ทวน ${request.manifest.sources.map(s => s.text).join(" | ")}`, request, f.config.jobs.outputBytes));
  const started = f.rt.app.execute(actor(f), dispatch(f, p, "ทวนรหัสลับ", [origin])).discussion!;
  await drain(f);
  const discussion = f.rt.app.discussion(actor(f), p.id, started.id).discussion;
  expect(discussion.participations[0]!.state).toBe("completed");
  f.rt.app.execute(actor(f), { kind: "decision.synthesize", requestId: rid(), projectId: p.id, expectedRevision: discussion.revision,
    payload: { discussionId: discussion.id, limits: { ...f.config.jobs.maximum } } });
  const preview = f.rt.app.execute(actor(f), { kind: "role.preview", requestId: rid(), projectId: p.id, expectedRevision: f.rt.app.project(actor(f), p.id).revision,
    payload: { roleId: f.roles.tech, topicId: p.topic.id, purpose: "ทวนรหัสลับ", sources: [origin], limits: { ...f.config.jobs.maximum } } }).preview!;
  await drain(f);
  const specialist = runOutput(f, discussion.participations[0]!.runId), previewed = runOutput(f, preview.id), synthesized = proposalOutput(f, discussion.id);
  for (const output of [specialist, previewed, synthesized]) expect(f.rt.app.sourceSuppressed(actor(f), p.id, output)).toBe(false);

  const receipt = f.rt.app.execute(actor(f), forgetCommand(f, p, claim));
  const bound = receipt.suppression.sources.map(entry => entry.source.sourceId);
  expect(bound).toEqual(expect.arrayContaining([origin.sourceId, specialist.sourceId, previewed.sourceId, synthesized.sourceId]));
  for (const output of [specialist, previewed, synthesized]) {
    expect(f.rt.app.sourceSuppressed(actor(f), p.id, output)).toBe(true);
    // Neither extraction nor a later run's evidence can bring the copied text back.
    expect(() => f.rt.app.execute(actor(f), extractCommand(f, p, output))).toThrow("memory_source_suppressed");
    expect(f.rt.app.source(actor(f), p.id, output)).toMatchObject({ state: "available" });
  }
  f.hooks.specialist = f.defaults.specialist;
  const later = f.rt.app.execute(actor(f), dispatch(f, p, "ทวนรหัสลับอีกครั้ง")).discussion!;
  await drain(f);
  const evidence = f.rt.app.discussion(actor(f), p.id, later.id).discussion.manifest;
  expect(JSON.stringify(evidence).includes("ม่วง-42")).toBe(false);
});

test("#110 forget fences a running extraction of an output it newly suppresses and lists its context", async () => {
  const f = await fixture();
  const p = project(f, "โครงการลับ", "หัวข้อรหัส");
  const origin = say(f, p, "เลขบัญชี 123-456");
  const claim = (await remember(f, p, origin))[0]!;
  // A role preview carries no memory context, so its output is an ordinary extractable source.
  const preview = f.rt.app.execute(actor(f), { kind: "role.preview", requestId: rid(), projectId: p.id, expectedRevision: f.rt.app.project(actor(f), p.id).revision,
    payload: { roleId: f.roles.tech, topicId: p.topic.id, purpose: "ทวนเลขบัญชี", sources: [origin], limits: { ...f.config.jobs.maximum } } }).preview!;
  await drain(f);
  const output = runOutput(f, preview.id);
  // Extraction of the preview output is running when the owner forgets the original message.
  let release!: () => void, started = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.hooks.extract = async request => { started = true; await gate; return scriptedMemoryResult(request, true); };
  const running = f.rt.app.execute(actor(f), extractCommand(f, p, output));
  f.rt.queue.pump();
  for (let i = 0; i < 100 && !started; i++) await new Promise(resolve => setTimeout(resolve, 2));
  expect(started).toBe(true);
  const receipt = f.rt.app.execute(actor(f), forgetCommand(f, p, claim));
  expect(receipt.suppression.sources.map(entry => entry.source.sourceId)).toContain(output.sourceId);
  expect(jobState(f, running.extraction.jobId)).toMatchObject({ state: "blocked" });
  const attempt = f.rt.store.read(tx => JSON.parse(tx.get<{ json: string }>("SELECT record_json AS json FROM job_attempts WHERE job_id = ? ORDER BY sequence DESC LIMIT 1", running.extraction.jobId)!.json) as { native: { context: { id: string; generation: number } } });
  expect(receipt.suppression.contexts).toContainEqual(attempt.native.context);
  release(); f.hooks.extract = f.defaults.extract;
  await drain(f);
  expect(f.rt.app.memory(actor(f), p.id).extractions.find(e => e.id === running.extraction.id)?.claimIds ?? []).toHaveLength(0);
  expect(claims(f, p).some(item => item.source.sourceId === output.sourceId)).toBe(false);
});
