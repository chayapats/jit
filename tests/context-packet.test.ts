import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Application } from "../src/application";
import { readConfig } from "../src/config";
import { AppError } from "../src/errors";
import { JobQueue } from "../src/jobs/queue";
import { scheduleRunRoleId, scheduleSummaryWork, tickSchedules } from "../src/jobs/schedules";
import { memoryContextPolicy } from "../src/memory/context";
import { memoryExtractionMarker, memoryExtractionWork, scriptedMemoryResult } from "../src/memory/extract";
import { contextTooLargeNextAction, packetSections, trimBottomUp } from "../src/memory/packet";
import type { MemoryClaim } from "../src/memory/types";
import type { SourceReference } from "../src/sources";
import { TransactionStore } from "../src/store";
import { coordinatorSynthesisMarker, coordinatorSynthesisWork } from "../src/team/decisions";
import { discussionPlanWork, specialistAnalysisWork } from "../src/team/dispatch";
import { jitReplyMarker, jitReplyWork } from "../src/team/jit-reply";
import { describeEffectiveRun } from "../src/team/schway-port";
import { ScriptedRunPort, fixtureOutcome, withContextAnswer } from "../src/team/scripted-port";
import { contextPacketSections, type ApplicationRunRequest, type ContextPacket, type Discussion, type RoleRoute } from "../src/team/types";

const roots: string[] = [], stores: TransactionStore[] = [], queues: JobQueue[] = [], releases: (() => void)[] = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const q of queues.splice(0)) { q.close(); await q.idle(); }
  for (const s of stores.splice(0)) s.close();
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});
const rid = () => crypto.randomUUID(), epoch = 1800000000000, password = "context-packet-owner-password";
const grok: RoleRoute = { provider: "grok", model: "fixture-grok-exact", authRoute: "owner-grok" };
type Script = (request: ApplicationRunRequest) => unknown | Promise<unknown>;
type Config = ReturnType<typeof readConfig>;

function synthesisJson(request: ApplicationRunRequest) {
  const citations = request.manifest.sources.map(source => ({ ...source.reference }));
  return { question: "เจ้าของจะเลือกทางใด", disagreement: false, consensus: true, options: [
    { id: "first", label: "ทางแรก", rationale: "ตามผลวิเคราะห์", citations },
  ] };
}
function boot(config: Config, hooks: { reply: Script }, clock: { now: number }) {
  const store = new TransactionStore(config.databasePath); stores.push(store);
  const port = new ScriptedRunPort(store, config.team, config.jobs.outputBytes, request =>
    request.instructions.operator.includes(memoryExtractionMarker) ? scriptedMemoryResult(request, true)
      : request.instructions.operator.includes(coordinatorSynthesisMarker) ? fixtureOutcome("complete", JSON.stringify(synthesisJson(request)))
      : request.instructions.operator[0]?.startsWith("You are Jit") ? hooks.reply(request)
      : request.roleId === scheduleRunRoleId ? fixtureOutcome("complete", "สรุปตามกำหนด: งานหลักยังค้าง")
      : fixtureOutcome("complete", withContextAnswer("ตอบจำลอง", request, config.jobs.outputBytes)));
  const now = () => clock.now;
  let queue: JobQueue | undefined;
  queue = new JobQueue(store, config.jobs, [memoryExtractionWork(store, config, port, now), discussionPlanWork(),
    specialistAnalysisWork(store, config, port, now), coordinatorSynthesisWork(store, config, port, now),
    jitReplyWork(store, config, port, now, () => queue), scheduleSummaryWork(store, config, port, now)], { now }); queues.push(queue);
  const app = new Application(store, config, { jobs: queue, now });
  return { store, port, queue, app };
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "jit-rel05-")); roots.push(root);
  const config = readConfig({ JIT_DATABASE: join(root, "state.sqlite") }), clock = { now: epoch };
  const defaults = { reply: ((() => fixtureOutcome("complete", JSON.stringify({ reply: "รับทราบ" }))) as Script) };
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
async function reopen(f: Fixture) {
  f.rt.queue.close(); await f.rt.queue.idle(); queues.splice(queues.indexOf(f.rt.queue), 1);
  f.rt.store.close(); stores.splice(stores.indexOf(f.rt.store), 1);
  // The scripted native sidecar stands in for native session history: the packet must not need it.
  rmSync(`${f.config.databasePath}.scripted-native.sqlite`, { force: true });
  f.rt = boot(f.config, f.hooks, f.clock);
  f.token = await f.rt.app.login(password);
}
async function drain(f: Fixture) {
  for (let i = 0; i < 400; i++) {
    f.rt.queue.pump(); tickSchedules(f.rt.store, f.rt.queue, f.config, f.clock.now);
    const pending = f.rt.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM jobs WHERE state IN ('queued', 'admitted')")!.n);
    if (pending === 0) { await f.rt.queue.idle(); return; }
    await f.rt.queue.idle(); await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error("queue did not drain");
}
function project(f: Fixture, name: string) {
  const created = f.rt.app.execute(actor(f), { kind: "project.create", projectId: null, requestId: rid(), expectedRevision: f.rt.app.workspace(actor(f)).revision, payload: { name } }).project;
  return { id: created.id, topic: topic(f, created.id, "หัวข้อหลัก") };
}
function topic(f: Fixture, projectId: string, title: string) {
  return f.rt.app.execute(actor(f), { kind: "topic.create", projectId, requestId: rid(), expectedRevision: f.rt.app.project(actor(f), projectId).revision, payload: { title } }).topic;
}
type Project = ReturnType<typeof project>;
const topicRevision = (f: Fixture, p: Project) => f.rt.app.conversation(actor(f), p.id, p.topic.id).topic.revision;
function say(f: Fixture, p: Project, text: string) {
  return f.rt.app.execute(actor(f), { kind: "message.send", requestId: rid(), projectId: p.id, expectedRevision: topicRevision(f, p), payload: { topicId: p.topic.id, text } }).message;
}
function dispatch(f: Fixture, p: Project, purpose: string, topicId = p.topic.id, sources: SourceReference[] = [p.topic.source]) {
  return f.rt.app.execute(actor(f), { kind: "team.dispatch", requestId: rid(), projectId: p.id, expectedRevision: f.rt.app.project(actor(f), p.id).revision,
    payload: { topicId, purpose, sources, include: [f.roles.tech], exclude: [], limits: { ...f.config.jobs.maximum } } }).discussion!;
}
/** A coordinator proposal for `topicId` that the owner has not decided yet. */
async function proposal(f: Fixture, p: Project, topicId = p.topic.id) {
  const started = dispatch(f, p, "เตรียมข้อเสนอให้เจ้าของตัดสิน", topicId);
  await drain(f);
  const discussion = f.rt.app.discussion(actor(f), p.id, started.id).discussion;
  f.rt.app.execute(actor(f), { kind: "decision.synthesize", requestId: rid(), projectId: p.id, expectedRevision: discussion.revision, payload: { discussionId: discussion.id, limits: { ...f.config.jobs.maximum } } });
  await drain(f);
  return f.rt.app.decision(actor(f), p.id, topicId).proposal!;
}
function accept(f: Fixture, p: Project, open: Awaited<ReturnType<typeof proposal>>, conclusion: string) {
  return f.rt.app.execute(actor(f), { kind: "decision.accept", requestId: rid(), projectId: p.id, expectedRevision: open.revision,
    payload: { proposalId: open.id, optionId: null, conclusion, rationale: "เจ้าของตัดสินเอง" } }).decision!;
}
/**
 * Commits `count` more live owner decisions, each on its own new topic, reusing one existing coordinator proposal as
 * provenance. This seeds committed rows only; it is the same table shape decision.accept writes.
 */
function seedDecisions(f: Fixture, p: Project, proposalId: string, count: number, text: (index: number) => string) {
  const ids: string[] = [];
  for (let index = 0; index < count; index++) {
    const extra = topic(f, p.id, `หัวข้อมติ ${index + 1}`);
    const id = rid();
    f.clock.now += 1;
    f.rt.store.transaction(tx => tx.run(`INSERT INTO owner_decisions (id, project_id, topic_id, proposal_id, proposal_revision, revision, actor_id, channel, option_id,
      conclusion, rationale, source_links_json, superseded_by, created_at) VALUES (?, ?, ?, ?, 1, 1, 'owner', 'web', NULL, ?, ?, '[]', NULL, ?)`,
      id, p.id, extra.id, proposalId, text(index), `เหตุผลของมติ ${index + 1}`, f.clock.now));
    ids.push(id);
  }
  return ids;
}
function propose(f: Fixture, p: Project, title: string, summary: string) {
  return f.rt.app.execute(actor(f), { kind: "task.propose", requestId: rid(), projectId: p.id, expectedRevision: topicRevision(f, p), payload: { topicId: p.topic.id, title, summary } });
}
async function remember(f: Fixture, p: Project, text: string): Promise<MemoryClaim> {
  const source = say(f, p, text).source;
  await drain(f);
  f.rt.app.execute(actor(f), { kind: "memory.extract", requestId: rid(), projectId: p.id, expectedRevision: f.rt.app.project(actor(f), p.id).revision,
    payload: { topicId: p.topic.id, roleId: f.roles.tech, source, dependencies: [], limits: { ...f.config.jobs.maximum } } });
  await drain(f);
  return f.rt.app.memory(actor(f), p.id).items.flatMap(item => item.state === "available" ? [item.claim] : []).at(-1)!;
}
async function scheduledSummary(f: Fixture, p: Project) {
  const created = f.rt.app.execute(actor(f), { kind: "schedule.create", requestId: rid(), projectId: p.id, expectedRevision: f.rt.app.project(actor(f), p.id).revision,
    payload: { topicId: p.topic.id, kind: "summary", purpose: "สรุปงานประจำวัน", timezone: "Asia/Bangkok", recurrence: { kind: "once", at: f.clock.now + 60_000 },
      enabled: true, route: structuredClone(grok), limits: { ...f.config.jobs.maximum, contextTokens: 64000, outputTokens: 4000 }, occurrenceBudget: 1, misfire: "coalesce",
      text: "สรุปงานที่ค้างให้เจ้าของ" } }).schedule;
  f.clock.now += 60_000;
  await drain(f);
  return f.rt.app.schedule(actor(f), p.id, created.id);
}
async function ask(f: Fixture, p: Project, purpose: string) {
  const started = dispatch(f, p, purpose);
  await drain(f);
  const discussion = f.rt.app.discussion(actor(f), p.id, started.id);
  return { ...discussion, packet: discussion.discussion.manifest.context!.packet! };
}
const replyRequest = (f: Fixture, messageId: string) => f.rt.store.read(tx => {
  const row = tx.get<{ json: string }>("SELECT r.record_json AS json FROM team_runs r JOIN jit_replies j ON j.run_id = r.id WHERE j.message_id = ?", messageId)!;
  return (JSON.parse(row.json) as { request: ApplicationRunRequest }).request;
});
const replyOf = (f: Fixture, p: Project, messageId: string) => f.rt.app.replies(actor(f), p.id, p.topic.id, [messageId]).get(messageId)!;
const assistantMessages = (f: Fixture, p: Project) => f.rt.store.read(tx => tx.get<{ n: number }>(
  "SELECT count(*) AS n FROM messages WHERE project_id = ? AND json_extract(attribution_json, '$.kind') = 'participant'", p.id)!.n);
const sectionOf = (packet: ContextPacket, name: ContextPacket["sections"][number]["name"]) => packet.sections.find(section => section.name === name)!;

test("REL05 trim order: sections are dropped from 8 upward, pinned decisions are kept and every omission is recorded", async () => {
  // Budget fixture over sections 4–8 (sections 1–3 are already charged by the caller's context room).
  const costs = { pinned: [40, 40], constraints: [30, 30, 30], recent: [20, 20], summary: [25], claims: [10, 10] };
  const kept = (budget: number) => {
    const room = budget - costs.pinned.reduce((a, b) => a + b, 0);
    return trimBottomUp(room, [costs.constraints, costs.recent, costs.summary, costs.claims]).kept;
  };
  expect(kept(255)).toEqual([3, 2, 1, 2]); // everything fits exactly
  expect(kept(240)).toEqual([3, 2, 1, 0]); // 8 goes first
  expect(kept(230)).toEqual([3, 2, 0, 0]); // then 7
  expect(kept(200)).toEqual([3, 1, 0, 0]); // then 6, oldest message first
  expect(kept(150)).toEqual([2, 0, 0, 0]); // then 5
  expect(kept(80)).toEqual([0, 0, 0, 0]);  // the pinned decisions remain
  // A small later candidate never jumps over a dropped higher one.
  expect(trimBottomUp(35, [[30, 30], [1], [1]]).kept).toEqual([1, 0, 0]);
  const states = packetSections({
    purpose: { candidates: 1, kept: 1, bytes: 10 }, responsibilities: { candidates: 1, kept: 1, bytes: 10 }, current_request: { candidates: 1, kept: 1, bytes: 10 },
    pinned_decisions: { candidates: 2, kept: 2, bytes: 80 }, constraints: { candidates: 3, kept: 2, bytes: 60 }, recent_messages: { candidates: 2, kept: 0, bytes: 0 },
    summary: { candidates: 0, kept: 0, bytes: 0 }, memory_claims: { candidates: 0, kept: 0, bytes: 0, withheld: true },
  });
  expect(states.map(section => [section.order, section.name, section.state])).toEqual([
    [1, "purpose", "included"], [2, "responsibilities", "included"], [3, "current_request", "included"], [4, "pinned_decisions", "included"],
    [5, "constraints", "trimmed"], [6, "recent_messages", "dropped"], [7, "summary", "empty"], [8, "memory_claims", "withheld"],
  ]);

  // The same order on a live discussion: a decision, a committed summary and a claim, then pressure from long tasks.
  const f = await fixture();
  const p = project(f, "Packet");
  const claim = await remember(f, p, "โครงการนี้ใช้ SQLite เป็นฐานข้อมูลหลัก");
  const decision = accept(f, p, await proposal(f, p), "ใช้ SQLite สำหรับ MVP");
  const schedule = await scheduledSummary(f, p);
  const summarySource = schedule.occurrences[0]!.outputSource!;
  const roomy = await ask(f, p, "ฐานข้อมูล SQLite ของโครงการควรตั้งค่าอย่างไร");
  expect(roomy.packet.sections.map(section => section.name)).toEqual([...contextPacketSections]);
  expect(roomy.packet.pinned.map(item => [item.id, item.scope])).toEqual([[decision.id, "topic"]]);
  expect(roomy.packet.summary).toMatchObject({ summaryRevision: 1, index: 1, source: summarySource, sourceIds: [p.topic.source.sourceId] });
  expect(roomy.discussion.manifest.sources.map(source => source.reference)).toEqual([p.topic.source, summarySource]);
  expect(roomy.discussion.manifest.claims.map(item => item.claimId)).toEqual([claim.claimId]);
  expect(roomy.packet.omissions).toEqual([]);
  expect(Object.fromEntries(roomy.packet.sections.map(section => [section.name, section.state]))).toMatchObject({
    pinned_decisions: "included", constraints: "empty", recent_messages: "withheld", summary: "included", memory_claims: "included",
  });
  expect(roomy.context!.record.complete).toBe(true);
  expect(roomy.context!.entries.filter(entry => entry.layer === "pinned_decision").map(entry => entry.id)).toEqual([decision.id]);

  for (let index = 0; index <= memoryContextPolicy.constraints; index++) propose(f, p, `งานยาว ${index + 1}`, `รายละเอียด ${index + 1} `.padEnd(560, "x"));
  const tight = await ask(f, p, "ฐานข้อมูล SQLite ของโครงการควรตั้งค่าอย่างไร");
  expect(tight.packet.pinned.map(item => item.id)).toEqual([decision.id]);
  expect(tight.packet.summary).toBeNull();
  expect(tight.discussion.manifest.sources.map(source => source.reference)).toEqual([p.topic.source]);
  expect(tight.discussion.manifest.claims).toEqual([]);
  const constraints = sectionOf(tight.packet, "constraints");
  expect(constraints.state).toBe("trimmed");
  expect(constraints.items).toBeGreaterThan(0);
  expect(constraints.items).toBeLessThan(memoryContextPolicy.constraints);
  expect(Object.fromEntries(tight.packet.sections.map(section => [section.name, section.state]))).toMatchObject({
    pinned_decisions: "included", constraints: "trimmed", summary: "dropped", memory_claims: "dropped",
  });
  expect(tight.packet.omissions).toEqual([
    { section: "constraints", reason: "ceiling", items: 1 },
    { section: "constraints", reason: "budget", items: memoryContextPolicy.constraints - constraints.items },
    { section: "summary", reason: "budget", items: 1 },
    { section: "memory_claims", reason: "budget", items: 1 },
  ]);
  expect(tight.packet.budget.used).toBeLessThanOrEqual(tight.packet.budget.bytes);
  const record = tight.context!.record;
  expect(record.complete).toBe(false);
  expect(record.packet!.omissions).toEqual(tight.packet.omissions);
  const answer = f.rt.app.source(actor(f), p.id, tight.discussion.participations[0]!.output!);
  expect(answer.state === "available" && answer.text).toContain(`decision ${decision.id} r1 (ปักไว้)`);
});

test("REL05 thirteen live decisions of the topic and the project are all pinned in every related run (no count cap)", async () => {
  const f = await fixture();
  const p = project(f, "Many decisions");
  const open = await proposal(f, p);
  const own = accept(f, p, open, "มติของหัวข้อหลัก");
  const others = seedDecisions(f, p, open.id, 12, index => `มติของหัวข้อที่ ${index + 1}`);
  const elsewhere = project(f, "Other project");
  accept(f, elsewhere, await proposal(f, elsewhere), "มติของโครงการอื่น");

  const discussion = await ask(f, p, "สรุปสิ่งที่ตกลงแล้วทั้งหมด");
  expect(discussion.packet.pinned).toHaveLength(13);
  expect(discussion.packet.pinned[0]).toMatchObject({ id: own.id, scope: "topic", conclusion: "มติของหัวข้อหลัก" });
  expect(discussion.packet.pinned.slice(1).map(item => item.id)).toEqual([...others].reverse());
  expect(discussion.packet.pinned.slice(1).every(item => item.scope === "project")).toBe(true);
  expect(discussion.discussion.manifest.context!.constraints.some(item => item.kind === "decision")).toBe(false);
  expect(sectionOf(discussion.packet, "pinned_decisions")).toMatchObject({ state: "included", items: 13 });
  expect(discussion.packet.omissions.some(item => (item.section as string) === "pinned_decisions")).toBe(false);

  const message = say(f, p, "เราตกลงอะไรกันไว้บ้าง");
  const request = replyRequest(f, message.id);
  expect(request.manifest.context!.packet!.pinned.map(item => item.id)).toEqual(discussion.packet.pinned.map(item => item.id));
  expect(request.manifest.context!.packet!.sourceIndexes.currentRequest).toEqual([request.manifest.sources.length - 1]);
  expect(Object.fromEntries(request.manifest.context!.packet!.sections.map(section => [section.name, section.state]))).toMatchObject({
    pinned_decisions: "included", summary: "withheld", memory_claims: "withheld",
  });
  expect(request.manifest.claims).toEqual([]);
  // The model receives every pinned decision as its own document in every run.
  const documents = describeEffectiveRun(request).sources.filter(source => source.id.startsWith("decision/"));
  expect(documents.map(source => source.id)).toEqual(discussion.packet.pinned.map(item => `decision/${p.id}/${item.id}`));
  expect(documents[0]!.content).toContain("มติของหัวข้อหลัก");
  await drain(f);
  expect(replyOf(f, p, message.id).state).toBe("answered");
});

test("REL05 pinned decisions alone larger than the budget refuse admission with context_too_large and a next action", async () => {
  const f = await fixture();
  const p = project(f, "Too many decisions");
  const open = await proposal(f, p);
  seedDecisions(f, p, open.id, 6, index => `มติยาวมาก ${index + 1} `.padEnd(2000, "ก"));
  const jobs = () => f.rt.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM jobs")!.n);
  const before = jobs();
  let refused: unknown;
  try { dispatch(f, p, "วิเคราะห์ต่อ"); } catch (error) { refused = error; }
  expect(refused).toBeInstanceOf(AppError);
  expect((refused as AppError).code).toBe("context_too_large");
  expect((refused as AppError).status).toBe(409);
  expect((refused as AppError).detail).toMatchObject({ nextAction: contextTooLargeNextAction });
  expect(Number((refused as AppError).detail!.pinnedBytes)).toBeGreaterThan(Number((refused as AppError).detail!.budgetBytes));
  expect(jobs()).toBe(before);

  const message = say(f, p, "สวัสดี");
  expect(replyOf(f, p, message.id)).toMatchObject({ state: "not_admitted", reason: "context_too_large", nextAction: "review_pinned_decisions" });
  expect(jobs()).toBe(before);

  const schedule = await scheduledSummary(f, p);
  expect(schedule.occurrences[0]).toMatchObject({ jobState: "blocked" });
  expect(f.rt.store.read(tx => JSON.parse(tx.get<{ json: string }>("SELECT record_json AS json FROM jobs WHERE id = ?", schedule.occurrences[0]!.jobId)!.json).reason)).toBe("context_too_large");
});

test("REL05 a decision accepted or superseded while a reply run is pending fences the reply as stale", async () => {
  const f = await fixture();
  const p = project(f, "Fence");
  const first = await proposal(f, p);
  const decided = accept(f, p, first, "ใช้ SQLite");

  // Superseded while the reply is queued.
  const queued = say(f, p, "ช่วยสรุปมติล่าสุด");
  expect(replyRequest(f, queued.id).manifest.context!.packet!.pinned.map(item => [item.id, item.revision])).toEqual([[decided.id, decided.revision]]);
  const messagesBefore = assistantMessages(f, p);
  const superseded = f.rt.app.execute(actor(f), { kind: "decision.supersede", requestId: rid(), projectId: p.id, expectedRevision: first.revision,
    payload: { decisionId: decided.id, proposalId: first.id, optionId: null, conclusion: "ใช้ PostgreSQL แทน", rationale: "เจ้าของเปลี่ยนมติ" } }).decision!;
  await drain(f);
  expect(replyOf(f, p, queued.id).state).not.toBe("answered");
  expect(f.rt.store.read(tx => JSON.parse(tx.get<{ json: string }>("SELECT record_json AS json FROM jobs WHERE id = ?", replyOf(f, p, queued.id).jobId)!.json).reason)).toBe("superseded");
  expect(assistantMessages(f, p)).toBe(messagesBefore);

  // Accepted (a decision on another topic of the project) while the reply is running.
  const second = topic(f, p.id, "หัวข้อที่สอง");
  const open = await proposal(f, p, second.id);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; }); releases.push(release);
  f.hooks.reply = async () => { entered(); await gate; return fixtureOutcome("complete", JSON.stringify({ reply: "ตอบช้า" })); };
  const running = say(f, p, "มีมติอะไรบ้าง");
  expect(replyRequest(f, running.id).manifest.context!.packet!.pinned.map(item => item.id)).toEqual([superseded.id]);
  const timer = setInterval(() => f.rt.queue.pump(), 5); releases.push(() => clearInterval(timer));
  f.rt.queue.pump(); await started;
  const before = assistantMessages(f, p);
  f.rt.app.execute(actor(f), { kind: "decision.accept", requestId: rid(), projectId: p.id, expectedRevision: open.revision,
    payload: { proposalId: open.id, optionId: null, conclusion: "หัวข้อที่สองตกลงแล้ว", rationale: "เจ้าของตัดสินเอง" } });
  release(); await f.rt.queue.idle(); clearInterval(timer);
  f.hooks.reply = f.defaults.reply;
  await drain(f);
  expect(replyOf(f, p, running.id).state).not.toBe("answered");
  expect(assistantMessages(f, p)).toBe(before);

  // A reply admitted after the change pins the new set and answers.
  const fresh = say(f, p, "ตอนนี้มีมติอะไรบ้าง");
  expect(replyRequest(f, fresh.id).manifest.context!.packet!.pinned.map(item => item.scope)).toEqual(["topic", "project"]);
  await drain(f);
  expect(replyOf(f, p, fresh.id).state).toBe("answered");
});

test("REL05 reopening the store in a new process rebuilds an identical packet from committed tables only", async () => {
  const f = await fixture();
  const p = project(f, "Reopen");
  await remember(f, p, "โครงการนี้ใช้ SQLite เป็นฐานข้อมูลหลัก");
  const open = await proposal(f, p);
  accept(f, p, open, "ใช้ SQLite สำหรับ MVP");
  seedDecisions(f, p, open.id, 2, index => `มติเพิ่ม ${index + 1}`);
  propose(f, p, "ย้าย schema", "ทำ migration ให้ครบ");
  await scheduledSummary(f, p);
  const before = await ask(f, p, "ฐานข้อมูล SQLite ของโครงการควรตั้งค่าอย่างไร");

  await reopen(f);
  const after = await ask(f, p, "ฐานข้อมูล SQLite ของโครงการควรตั้งค่าอย่างไร");
  expect(after.packet).toEqual(before.packet);
  expect(after.discussion.manifest.sources).toEqual(before.discussion.manifest.sources);
  expect(after.discussion.manifest.claims).toEqual(before.discussion.manifest.claims);
  expect(after.packet.pinned).toHaveLength(3);
  expect(after.packet.summary).not.toBeNull();
  // The packet carries no native session identity: a provider change cannot alter it.
  const raw = JSON.stringify(after.packet);
  for (const native of [before.discussion.participations[0]!.runId, "scripted", "schway"]) expect(raw).not.toContain(native);
});

test("REL05 run-port validation rejects a packet whose sections are out of order or whose summary index is wrong", async () => {
  const f = await fixture();
  const p = project(f, "Shape");
  accept(f, p, await proposal(f, p), "มติ");
  await scheduledSummary(f, p);
  const good = (await ask(f, p, "ตรวจรูปแบบ")).discussion as Discussion;
  const request = f.rt.port.requests.find(item => item.runId === good.participations[0]!.runId)!;
  const { validateRunRequest } = await import("../src/team/scripted-port");
  expect(() => validateRunRequest(request, f.config.team)).not.toThrow();
  const swapped = structuredClone(request);
  const sections = swapped.manifest.context!.packet!.sections;
  [sections[3], sections[4]] = [sections[4]!, sections[3]!];
  expect(() => validateRunRequest(swapped, f.config.team)).toThrow("invalid_run_request");
  const wrongIndex = structuredClone(request);
  wrongIndex.manifest.context!.packet!.summary!.index = 0;
  expect(() => validateRunRequest(wrongIndex, f.config.team)).toThrow("invalid_run_request");
  const pinnedOmission = structuredClone(request);
  (pinnedOmission.manifest.context!.packet!.omissions as unknown[]).push({ section: "pinned_decisions", reason: "budget", items: 1 });
  expect(() => validateRunRequest(pinnedOmission, f.config.team)).toThrow("invalid_run_request");
});
