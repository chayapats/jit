import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Application } from "../src/application";
import { readConfig } from "../src/config";
import type { DeliveryIntent } from "../src/delivery";
import { JobQueue } from "../src/jobs/queue";
import { TransactionStore } from "../src/store";
import { discussionPlanWork, specialistAnalysisWork } from "../src/team/dispatch";
import { jitReplyMarker, teamReplyMarker, type JitReplyView } from "../src/team/jit-reply";
import { ScriptedRunPort, fixtureOutcome } from "../src/team/scripted-port";
import type { ApplicationRunOutcome, ApplicationRunRequest, RoleRoute } from "../src/team/types";
import { tickWorkGroups } from "../src/team/work-group";
import { createWebHandler } from "../src/web";

const roots: string[] = [], stores: TransactionStore[] = [], queues: JobQueue[] = [];
afterEach(async () => {
  for (const q of queues.splice(0)) { q.close(); await q.idle(); }
  for (const s of stores.splice(0)) s.close();
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});
const password = "fixture-rel04-stopall-owner", epoch = 1_800_000_000_000, origin = "http://localhost:3000";
const grok: RoleRoute = { provider: "grok", model: "fixture-grok-exact", authRoute: "owner-grok" };
const rid = () => crypto.randomUUID();
const answer = (request: ApplicationRunRequest, output: string): ApplicationRunOutcome => ({
  ...fixtureOutcome("complete", output), usage: { calls: 1, rounds: 1, hops: 1, contextTokens: 0, outputTokens: 0, retries: 0, wallMs: 0, tokensUnknown: false },
  session: { adapter: "scripted", id: request.runId, context: request.context },
});
const done = (request: ApplicationRunRequest, text: string) => answer(request, JSON.stringify({ status: "done", result: text, evidence: "none", unblock: null }));
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
const dispatching = (roles: string[]) => JSON.stringify({ reply: "ขอถามทีมก่อนนะครับ", proposals: [{ kind: "dispatch", roles }] });

async function fixture(options: { jit?: (r: ApplicationRunRequest, signal: AbortSignal) => unknown; specialist?: (r: ApplicationRunRequest, signal: AbortSignal) => unknown; team?: (r: ApplicationRunRequest, signal: AbortSignal) => unknown } = {}) {
  const root = mkdtempSync(join(tmpdir(), "jit-rel04-stopall-")); roots.push(root);
  const path = join(root, "state.sqlite");
  const clock = { now: epoch };
  const handlers = {
    jit: options.jit ?? ((r: ApplicationRunRequest) => answer(r, dispatching(["เทคโนโลยี", "ออกแบบ", "การตลาด"]))),
    specialist: options.specialist ?? ((r: ApplicationRunRequest) => done(r, "ความเห็น")),
    team: options.team ?? ((r: ApplicationRunRequest) => answer(r, JSON.stringify({ reply: "สรุป" }))),
  };
  const config = readConfig({ JIT_DATABASE: path, JIT_JOB_CONCURRENCY: "4", JIT_JOB_ROUTE_CONCURRENCY: "4" });
  const store = new TransactionStore(path); stores.push(store);
  const port = new ScriptedRunPort(store, config.team, config.jobs.outputBytes, (request, signal) => {
    if (request.instructions.operator[0] === jitReplyMarker) return handlers.jit(request, signal);
    if (request.instructions.operator[0] === teamReplyMarker) return handlers.team(request, signal);
    return handlers.specialist(request, signal);
  });
  let queueRef: JobQueue | undefined;
  const now = () => clock.now, current = () => queueRef;
  const queue = new JobQueue(store, config.jobs, [
    discussionPlanWork(), specialistAnalysisWork(store, config, port, now, current), (await import("../src/team/jit-reply")).jitReplyWork(store, config, port, now, current),
  ], { now });
  queueRef = queue; queues.push(queue);
  const app = new Application(store, config, { now, jobs: queue });
  await app.setupOwner(password);
  const token = await app.login(password), auth = app.authenticate(token);
  const project = app.execute(auth.actor, { kind: "project.create", projectId: null, requestId: rid(), expectedRevision: 0, payload: { name: "โครงการ stop-all เงียบ" } }).project;
  const topic = app.execute(auth.actor, { kind: "topic.create", projectId: project.id, requestId: rid(), expectedRevision: project.revision, payload: { title: "หยุดทั้งทีม" } }).topic;
  const role = (name: string, kind: "coordinator" | "specialist", responsibility: string) =>
    app.execute(auth.actor, { kind: "role.save", projectId: null, requestId: rid(), expectedRevision: app.team(auth.actor).ownerRevision,
      payload: { roleId: null, name, kind, responsibility, enabled: true, route: grok } }).role!.id;
  role("จิต", "coordinator", "ตอบเจ้าของและประสานทีม");
  const techId = role("เทคโนโลยี", "specialist", "software");
  const designId = role("ออกแบบ", "specialist", "ux");
  const marketingId = role("การตลาด", "specialist", "marketing");
  return { root, path, clock, token, auth, project, topic, techId, designId, marketingId, store, config, port, queue, app, web: createWebHandler(app) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const send = (f: Fixture, text: string) => {
  const topic = f.app.conversation(f.auth.actor, f.project.id, f.topic.id).topic;
  return f.app.execute(f.auth.actor, { kind: "message.send", projectId: f.project.id, requestId: rid(), expectedRevision: topic.revision, payload: { topicId: f.topic.id, text } });
};
async function ticks(n = 20) { for (let i = 0; i < n; i++) await Bun.sleep(0); }
async function drain(f: Fixture) { for (let i = 0; i < 8; i++) { f.queue.pump(); await f.queue.idle(); tickWorkGroups(f.store, f.config.team, f.clock.now); } }
const replyFor = (f: Fixture, messageId: string): JitReplyView => f.app.replies(f.auth.actor, f.project.id, f.topic.id, [messageId]).get(messageId)!;
const cardFor = (f: Fixture, messageId: string) => f.app.dispatchCards(f.auth.actor, f.project.id, f.topic.id, [messageId]).get(messageId)!;
const intents = (f: Fixture): DeliveryIntent[] =>
  f.store.read(tx => tx.all<{ record_json: string }>("SELECT record_json FROM delivery_intents ORDER BY sequence").map(row => JSON.parse(row.record_json) as DeliveryIntent));
const groups = (f: Fixture) => f.store.read(tx => tx.all<{ id: string; state: string; record_json: string }>("SELECT id, state, record_json FROM work_groups ORDER BY created_at"))
  .map(row => ({ id: row.id, state: row.state, record: JSON.parse(row.record_json) as { closed: string | null } }));

test("#157: stop-all after a re-included role and an answered reply closes silently with no final:group", async () => {
  const first = deferred<ApplicationRunOutcome>(), again = deferred<ApplicationRunOutcome>(), team = deferred<ApplicationRunOutcome>();
  let included = false, ref!: Fixture;
  const f = ref = await fixture({
    jit: r => answer(r, dispatching(["เทคโนโลยี", "การตลาด"])),
    specialist: r => r.roleId === ref.marketingId ? (included ? again.promise : first.promise) : done(r, "ความเห็น"),
    team: () => team.promise,
  });
  try {
    const sent = send(f, "ช่วยดูสองด้าน");
    f.queue.pump(); await ticks(); f.queue.pump(); await ticks();
    let card = cardFor(f, replyFor(f, sent.message.id).replyMessageId!);
    const control = (action: "skip" | "include", roleId: string) => f.app.execute(f.auth.actor, { kind: "team.control", requestId: rid(), projectId: f.project.id,
      expectedRevision: f.app.discussion(f.auth.actor, f.project.id, card.discussion!.id).discussion.revision, payload: { discussionId: card.discussion!.id, action, roleId } });
    control("skip", f.marketingId);
    included = true;
    control("include", f.marketingId);
    f.queue.pump(); await ticks();
    team.resolve(answer(f.port.requests.find(r => r.instructions.operator[0] === teamReplyMarker)!, JSON.stringify({ reply: "ทีมตอบก่อน" })));
    await ticks(); tickWorkGroups(f.store, f.config.team, f.clock.now);
    card = cardFor(f, replyFor(f, sent.message.id).replyMessageId!);
    expect(card.teamReply).toMatchObject({ state: "answered" });
    expect(card.discussion!.roles.some(role => role.roleId === f.marketingId && role.activity !== "settled")).toBe(true);
    expect(intents(f)).toHaveLength(0);
    f.app.execute(f.auth.actor, { kind: "team.stop_all", requestId: rid(), projectId: f.project.id,
      expectedRevision: f.app.discussion(f.auth.actor, f.project.id, card.discussion!.id).discussion.revision, payload: { discussionId: card.discussion!.id } });
    again.resolve(done(f.port.requests.filter(r => r.roleId === f.marketingId).at(-1)!, "ความเห็นที่เพิ่มมา"));
    first.resolve(fixtureOutcome("complete", "ผลเก่า"));
    await drain(f);
    expect(intents(f).filter(intent => intent.attention?.item === "final:group")).toHaveLength(0);
    expect(groups(f)[0]).toMatchObject({ state: "closed", record: { closed: "stopped" } });
  } finally { first.resolve(fixtureOutcome("complete", "x")); again.resolve(fixtureOutcome("complete", "x")); team.resolve(fixtureOutcome("complete", "x")); }
});
