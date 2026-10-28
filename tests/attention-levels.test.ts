import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Application } from "../src/application";
import { readConfig } from "../src/config";
import { DeliveryWorker, ScriptedTelegramSender, commitAttentionIntent, resolveDeliveryIntent, type DeliveryIntent, type DeliverySender } from "../src/delivery";
import { JobQueue } from "../src/jobs/queue";
import { backupImageTables } from "../src/ops/backup";
import { TransactionStore } from "../src/store";
import { discussionPlanWork, readDiscussion, specialistAnalysisWork } from "../src/team/dispatch";
import { jitReplyMarker, jitReplyWork, readReplyRecord, teamReplyMarker, type JitReplyView } from "../src/team/jit-reply";
import { ScriptedRunPort, fixtureOutcome } from "../src/team/scripted-port";
import type { ApplicationRunOutcome, ApplicationRunRequest, RoleRoute } from "../src/team/types";
import { tickWorkGroups } from "../src/team/work-group";
import { TelegramChannel } from "../src/telegram/channel";
import { createWebHandler } from "../src/web";

const roots: string[] = [], stores: TransactionStore[] = [], queues: JobQueue[] = [];
afterEach(async () => {
  for (const q of queues.splice(0)) { q.close(); await q.idle(); }
  for (const s of stores.splice(0)) s.close();
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});
const password = "fixture-rel04-owner-password", epoch = 1_800_000_000_000, origin = "http://localhost:3000";
const grok: RoleRoute = { provider: "grok", model: "fixture-grok-exact", authRoute: "owner-grok" };
const rid = () => crypto.randomUUID();
const answer = (request: ApplicationRunRequest, output: string): ApplicationRunOutcome => ({
  ...fixtureOutcome("complete", output), usage: { calls: 1, rounds: 1, hops: 1, contextTokens: 0, outputTokens: 0, retries: 0, wallMs: 0, tokensUnknown: false },
  session: { adapter: "scripted", id: request.runId, context: request.context },
});
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
type Handler = (request: ApplicationRunRequest, signal: AbortSignal) => unknown | Promise<unknown>;
const dispatching = (roles: string[]) => JSON.stringify({ reply: "ขอถามทีมก่อนนะครับ", proposals: [{ kind: "dispatch", roles }] });
const three = ["เทคโนโลยี", "ออกแบบ", "การตลาด"];

interface Options { jit?: Handler; specialist?: Handler; team?: Handler; path?: string }
interface Handlers { jit: Handler; specialist: Handler; team: Handler }

/** Composes queue, app and web over one database path; `reopen` builds a fresh process over the same file. */
function compose(path: string, handlers: Handlers, clock: { now: number }, crashed = false) {
  const config = readConfig({ JIT_DATABASE: path, JIT_JOB_CONCURRENCY: "4", JIT_JOB_ROUTE_CONCURRENCY: "4", JIT_TELEGRAM_BOT_TOKEN_PATH: join(path, "..", "missing.token") });
  const store = new TransactionStore(path); stores.push(store);
  const port = new ScriptedRunPort(store, config.team, config.jobs.outputBytes, (request, signal) => {
    if (request.instructions.operator[0] === jitReplyMarker) return handlers.jit(request, signal);
    if (request.instructions.operator[0] === teamReplyMarker) return handlers.team(request, signal);
    return handlers.specialist(request, signal);
  });
  let queueRef: JobQueue | undefined;
  const now = () => clock.now, current = () => queueRef;
  const queue = new JobQueue(store, config.jobs, [
    discussionPlanWork(), specialistAnalysisWork(store, config, port, now, current), jitReplyWork(store, config, port, now, current),
  ], { now, ...(crashed ? { isAlive: () => false } : {}) });
  queueRef = queue; queues.push(queue);
  const app = new Application(store, config, { now, jobs: queue });
  return { config, store, port, queue, app, web: createWebHandler(app) };
}

async function fixture(options: Options = {}) {
  const root = mkdtempSync(join(tmpdir(), "jit-rel04-")); roots.push(root);
  const path = join(root, "state.sqlite");
  const clock = { now: epoch };
  const handlers: Handlers = {
    jit: options.jit ?? (r => answer(r, dispatching(three))),
    specialist: options.specialist ?? (r => answer(r, "ความเห็นของผู้เชี่ยวชาญ")),
    team: options.team ?? (r => answer(r, JSON.stringify({ reply: "สรุปจากทีม: ทำแบบเรียบง่ายก่อน" }))),
  };
  const parts = compose(path, handlers, clock);
  await parts.app.setupOwner(password);
  const token = await parts.app.login(password), auth = parts.app.authenticate(token);
  const project = parts.app.execute(auth.actor, { kind: "project.create", projectId: null, requestId: rid(), expectedRevision: 0, payload: { name: "โครงการแจ้งครั้งเดียว" } }).project;
  const topic = parts.app.execute(auth.actor, { kind: "topic.create", projectId: project.id, requestId: rid(), expectedRevision: project.revision, payload: { title: "เลือกแนวทาง" } }).topic;
  const role = (name: string, kind: "coordinator" | "specialist", responsibility: string) =>
    parts.app.execute(auth.actor, { kind: "role.save", projectId: null, requestId: rid(), expectedRevision: parts.app.team(auth.actor).ownerRevision,
      payload: { roleId: null, name, kind, responsibility, enabled: true, route: grok } }).role!.id;
  role("จิต", "coordinator", "ตอบเจ้าของและประสานทีม");
  const techId = role("เทคโนโลยี", "specialist", "วิเคราะห์ด้าน software architecture");
  const designId = role("ออกแบบ", "specialist", "วิเคราะห์ด้าน UX");
  const marketingId = role("การตลาด", "specialist", "วิเคราะห์ด้าน marketing");
  return { root, path, clock, handlers, token, auth, project, topic, techId, designId, marketingId, ...parts };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/**
 * Opens a new process over the same database after a crash: the old queue keeps its in-flight worker (closed in
 * afterEach) and the new scheduler takes over because the old pid counts as dead.
 */
async function crashReopen(f: Fixture): Promise<Fixture> {
  const parts = compose(f.path, f.handlers, f.clock, true);
  const token = await parts.app.login(password);
  return { ...f, ...parts, token, auth: parts.app.authenticate(token) };
}

/** Closes the queue and store like a process exit and opens a new process over the same database. */
async function reopen(f: Fixture): Promise<Fixture> {
  f.queue.close(); await f.queue.idle(); queues.splice(queues.indexOf(f.queue), 1);
  f.store.close(); stores.splice(stores.indexOf(f.store), 1);
  const parts = compose(f.path, f.handlers, f.clock);
  const token = await parts.app.login(password);
  return { ...f, ...parts, token, auth: parts.app.authenticate(token) };
}

function send(f: Fixture, text: string) {
  const topic = f.app.conversation(f.auth.actor, f.project.id, f.topic.id).topic;
  return f.app.execute(f.auth.actor, { kind: "message.send", projectId: f.project.id, requestId: rid(), expectedRevision: topic.revision, payload: { topicId: f.topic.id, text } });
}
/** Pumps until no admitted work remains and runs the service's work group sweep after each round. */
async function drain(f: Fixture) { for (let i = 0; i < 8; i++) { f.queue.pump(); await f.queue.idle(); tickWorkGroups(f.store, f.clock.now); } }
async function ticks(n = 20) { for (let i = 0; i < n; i++) await Bun.sleep(0); }
const replyFor = (f: Fixture, messageId: string): JitReplyView => f.app.replies(f.auth.actor, f.project.id, f.topic.id, [messageId]).get(messageId)!;
const cardFor = (f: Fixture, messageId: string) => f.app.dispatchCards(f.auth.actor, f.project.id, f.topic.id, [messageId]).get(messageId)!;
const intents = (f: Fixture): DeliveryIntent[] =>
  f.store.read(tx => tx.all<{ record_json: string }>("SELECT record_json FROM delivery_intents ORDER BY sequence").map(row => JSON.parse(row.record_json) as DeliveryIntent));
const groups = (f: Fixture) => f.store.read(tx => tx.all<{ id: string; state: string; record_json: string }>("SELECT id, state, record_json FROM work_groups ORDER BY created_at"))
  .map(row => ({ id: row.id, state: row.state, record: JSON.parse(row.record_json) as { items: Record<string, { class: string; decision: string; intentId: string | null; resolved: boolean }>; closed: string | null } }));
const setLevel = (f: Fixture, channel: "telegram" | "web", level: "all" | "needs-me") => f.app.execute(f.auth.actor, { kind: "attention.set", requestId: rid(), projectId: null,
  expectedRevision: f.app.attentionLevels(f.auth.actor)[channel].revision, payload: { channel, level } }).attention;
const setAllowance = (f: Fixture, enabled: boolean, maxRoles: number) => f.app.execute(f.auth.actor, { kind: "dispatch.allowance.set", requestId: rid(), projectId: f.project.id,
  expectedRevision: f.app.dispatchAllowance(f.auth.actor, f.project.id).revision, payload: { enabled, maxRoles } }).allowance;
function get(f: Fixture, path: string, headers: Record<string, string> = {}) {
  return f.web(new Request(`${origin}${path}`, { headers: { cookie: `jit_session=${f.token}`, ...headers } }));
}
function postForm(f: Fixture, path: string, fields: Record<string, string>) {
  return f.web(new Request(`${origin}${path}`, { method: "POST", body: new URLSearchParams(fields).toString(),
    headers: { "content-type": "application/x-www-form-urlencoded", origin, cookie: `jit_session=${f.token}` } }));
}
function postJson(f: Fixture, path: string, body: unknown, csrf: string | null = f.auth.csrf) {
  return f.web(new Request(`${origin}${path}`, { method: "POST", body: JSON.stringify(body),
    headers: { "content-type": "application/json", origin, cookie: `jit_session=${f.token}`, ...(csrf ? { "x-csrf-token": csrf } : {}) } }));
}
/** Binds Telegram through the owner binding contract so queued intents can be sent by a fixture sender. */
function bindTelegram(f: Fixture) {
  const telegram = new TelegramChannel(f.store, f.config, { now: () => f.clock.now });
  const channel = telegram.authenticate(f.token);
  const pending = telegram.execute(channel, { kind: "telegram.bind", requestId: rid(), expectedRevision: telegram.status(channel).binding.revision, payload: { telegramUserId: 42, telegramChatId: 77 } });
  telegram.execute(channel, { kind: "telegram.confirm", requestId: rid(), expectedRevision: pending.binding.revision,
    payload: { telegramUserId: 42, telegramChatId: 77, challengeNonce: pending.binding.challengeNonce! } });
}

test("a Jit reply that calls 3 specialists creates no intent until all settle, then exactly one after the team reply commits", async () => {
  const gates = new Map<string, ReturnType<typeof deferred<ApplicationRunOutcome>>>();
  const f = await fixture({ specialist: request => { const gate = deferred<ApplicationRunOutcome>(); gates.set(request.roleId, gate); return gate.promise; } });
  const sent = send(f, "ควรใช้ SQLite หรือ Postgres ดี");
  f.queue.pump(); await ticks(); f.queue.pump(); await ticks();
  const reply = replyFor(f, sent.message.id);
  const card = cardFor(f, reply.replyMessageId!);
  expect(card).toMatchObject({ state: "admitted" });
  expect(card.discussion!.roles.map(role => role.state)).toEqual(["running", "running", "running"]);
  // One work group carried from the reply to the discussion.
  const [group] = groups(f);
  expect(group).toMatchObject({ state: "open", record: { items: {}, closed: null } });
  expect(f.store.read(tx => readReplyRecord(tx, f.project.id, reply.id)).workGroupId).toBe(group!.id);
  expect(f.store.read(tx => readDiscussion(tx, f.project.id, card.discussion!.id)).workGroupId).toBe(group!.id);
  expect(intents(f)).toHaveLength(0);
  // Each intermediate result commits without an intent, also across sweeps.
  for (const roleId of [f.techId, f.designId]) {
    gates.get(roleId)!.resolve(answer(f.port.requests.find(r => r.roleId === roleId)!, "ความเห็นระหว่างทาง"));
    await ticks(); tickWorkGroups(f.store, f.clock.now);
    expect(intents(f)).toHaveLength(0);
  }
  gates.get(f.marketingId)!.resolve(answer(f.port.requests.find(r => r.roleId === f.marketingId)!, "ความเห็นสุดท้าย"));
  await ticks(); tickWorkGroups(f.store, f.clock.now);
  // Settled, but the team reply is still thinking: still nothing.
  expect(cardFor(f, reply.replyMessageId!).teamReply).toMatchObject({ state: "thinking" });
  expect(intents(f)).toHaveLength(0);
  await drain(f);
  const settled = cardFor(f, reply.replyMessageId!);
  expect(settled.teamReply).toMatchObject({ state: "answered" });
  expect(f.store.read(tx => readReplyRecord(tx, f.project.id, settled.teamReply!.id)).workGroupId).toBe(group!.id);
  const [only, ...rest] = intents(f);
  expect(rest).toHaveLength(0);
  expect(only).toMatchObject({ dedupeKey: `attention/${group!.id}/final:group`, status: "waiting", channel: "telegram",
    attention: { class: "informational", item: "final:group", workGroupId: group!.id }, resolution: null });
  // Fixed notice text: a dictionary sentence and the page path; never model or owner text.
  expect(only!.payload.text).toBe(`จิตตอบในนามทีมแล้ว (3 คน)\nเปิดดู: /projects/${f.project.id}/topics/${f.topic.id}#dispatch-${settled.id}`);
  expect(only!.payload.text).not.toContain("สรุปจากทีม");
  expect(groups(f)[0]).toMatchObject({ state: "closed", record: { closed: "final" } });
  // Later sweeps and a reopen add nothing.
  tickWorkGroups(f.store, f.clock.now); tickWorkGroups(f.store, f.clock.now);
  const g = await reopen(f);
  tickWorkGroups(g.store, g.clock.now);
  expect(intents(g)).toHaveLength(1);
});

test("one specialist stopped and one skipped still notify once, and a late callback after settlement adds none", async () => {
  const gates = new Map<string, ReturnType<typeof deferred<ApplicationRunOutcome>>>();
  let techId = "";
  const f = await fixture({ specialist: request => {
    if (request.roleId === techId) return answer(request, "ความเห็นด้านเทคนิค");
    const gate = deferred<ApplicationRunOutcome>(); gates.set(request.roleId, gate); return gate.promise;
  } });
  techId = f.techId;
  const release = () => { for (const gate of gates.values()) gate.resolve(fixtureOutcome("complete", "ผลที่มาช้า")); };
  try {
  const sent = send(f, "ช่วยดูหลายด้าน");
  f.queue.pump(); await ticks(); f.queue.pump(); await ticks();
  const reply = replyFor(f, sent.message.id);
  let card = cardFor(f, reply.replyMessageId!);
  expect(card.discussion!.roles.map(role => [role.roleId, role.state])).toEqual([[f.techId, "completed"], [f.designId, "running"], [f.marketingId, "running"]]);
  const control = (action: "stop" | "skip", roleId: string) => f.app.execute(f.auth.actor, { kind: "team.control", requestId: rid(), projectId: f.project.id,
    expectedRevision: f.app.discussion(f.auth.actor, f.project.id, card.discussion!.id).discussion.revision, payload: { discussionId: card.discussion!.id, action, roleId } });
  control("stop", f.designId);
  expect(intents(f)).toHaveLength(0);
  control("skip", f.marketingId);
  card = cardFor(f, reply.replyMessageId!);
  expect(card.discussion!.roles.map(role => role.state)).toEqual(["completed", "stopped", "skipped"]);
  expect(card.teamReply).toMatchObject({ state: "thinking" });
  expect(intents(f)).toHaveLength(0);
  // The fenced workers are still waiting on their adapters, so run the team reply without awaiting them.
  f.queue.pump(); await ticks(); tickWorkGroups(f.store, f.clock.now);
  expect(cardFor(f, reply.replyMessageId!).teamReply).toMatchObject({ state: "answered" });
  expect(intents(f)).toHaveLength(1);
  expect(intents(f)[0]!.payload.text).toStartWith("จิตตอบในนามทีมแล้ว (1 คน)");
  // Late results from the stopped and skipped roles are fenced and change nothing.
  for (const roleId of [f.designId, f.marketingId]) gates.get(roleId)!.resolve(answer(f.port.requests.find(r => r.roleId === roleId)!, "ผลที่มาช้า"));
  await drain(f);
  expect(intents(f)).toHaveLength(1);
  expect(f.app.conversation(f.auth.actor, f.project.id, f.topic.id).items.some(m => m.text?.includes("ผลที่มาช้า"))).toBe(false);
  } finally { release(); }
});

test("needs-me: a plain team report creates no intent; a proposal card creates one; a failure creates one; history stays", async () => {
  const f = await fixture();
  expect(setLevel(f, "telegram", "needs-me")).toMatchObject({ channel: "telegram", level: "needs-me", revision: 1 });
  // A plain team report (the group's final reply) is informational.
  const first = send(f, "เรื่องแรก");
  await drain(f);
  const card = cardFor(f, replyFor(f, first.message.id).replyMessageId!);
  expect(card.teamReply).toMatchObject({ state: "answered" });
  expect(intents(f)).toHaveLength(0);
  // The level never hides the report: the reply and every specialist message are in the topic.
  expect(f.app.conversation(f.auth.actor, f.project.id, f.topic.id).items.map(m => m.text)).toContain("สรุปจากทีม: ทำแบบเรียบง่ายก่อน");
  expect(groups(f)[0]).toMatchObject({ state: "closed", record: { items: { "final:group": { class: "informational", decision: "filtered", intentId: null } } } });
  // A proposal card waits on the owner.
  setAllowance(f, true, 1);
  const second = send(f, "เรื่องที่สอง");
  await drain(f);
  expect(cardFor(f, replyFor(f, second.message.id).replyMessageId!)).toMatchObject({ state: "proposed", reason: "over_allowance" });
  expect(intents(f)).toHaveLength(1);
  expect(intents(f)[0]).toMatchObject({ attention: { class: "needs_owner", item: expect.stringMatching(/^proposal:/) } });
  expect(intents(f)[0]!.payload.text).toStartWith("จิตขอเรียกผู้เชี่ยวชาญ 3 คน รอคุณยืนยัน");
  // A failed team reply is a failure, so it notifies under needs-me too.
  setAllowance(f, true, 3);
  f.handlers.team = () => fixtureOutcome("invalid_result");
  const third = send(f, "เรื่องที่สาม");
  await drain(f);
  expect(cardFor(f, replyFor(f, third.message.id).replyMessageId!).teamReply).toMatchObject({ state: "failed" });
  expect(intents(f)).toHaveLength(2);
  expect(intents(f)[1]).toMatchObject({ attention: { class: "needs_owner", item: "final:group" } });
  expect(intents(f)[1]!.payload.text).toStartWith("งานของทีมไม่สำเร็จ (invalid_result)");
  // Classification table: informational is filtered, needs_owner never is.
  f.store.transaction(tx => {
    expect(commitAttentionIntent(tx, { projectId: f.project.id, kind: "report", text: "ข่าวสาร", dedupeKey: "fixture/informational-1", maxBytes: 4000,
      attention: { class: "informational", item: null, workGroupId: null } }, f.clock.now)).toBeNull();
    expect(commitAttentionIntent(tx, { projectId: f.project.id, kind: "report", text: "รอคุณ", dedupeKey: "fixture/needs-owner-1", maxBytes: 4000,
      attention: { class: "needs_owner", item: null, workGroupId: null } }, f.clock.now)).not.toBeNull();
  });
  // A route wait is a blocked result: it notifies immediately, even while the group is still open.
  f.handlers.team = r => answer(r, JSON.stringify({ reply: "ทีมตอบ" }));
  f.handlers.specialist = r => r.roleId === f.designId ? fixtureOutcome("quota") : answer(r, "ความเห็น");
  const fourth = send(f, "เรื่องที่สี่");
  await drain(f);
  const blocked = cardFor(f, replyFor(f, fourth.message.id).replyMessageId!);
  expect(blocked.discussion!.roles.find(role => role.roleId === f.designId)).toMatchObject({ activity: "waiting" });
  const stall = intents(f).at(-1)!;
  expect(stall).toMatchObject({ attention: { class: "needs_owner", item: expect.stringMatching(/^job:/) } });
  expect(stall.payload.text).toStartWith("งานของทีมติดอยู่ (quota) รอคุณดำเนินการต่อ");
});

test("switching all to needs-me mid-group never cancels an existing intent and filters only what comes next", async () => {
  const gate = deferred<ApplicationRunOutcome>();
  let gated = true;
  const f = await fixture({ specialist: request => gated && request.roleId === f.marketingId ? gate.promise : answer(request, "ความเห็น") });
  // Group A completes under `all`: one informational intent.
  const a = send(f, "งานชุดแรก");
  gated = false;
  await drain(f);
  expect(intents(f)).toHaveLength(1);
  const existing = intents(f)[0]!;
  // Group B is open when the owner switches to needs-me.
  gated = true;
  const b = send(f, "งานชุดที่สอง");
  f.queue.pump(); await ticks(); f.queue.pump(); await ticks();
  expect(cardFor(f, replyFor(f, b.message.id).replyMessageId!).discussion!.roles.some(role => role.state === "running")).toBe(true);
  setLevel(f, "telegram", "needs-me");
  expect(intents(f)[0]).toEqual(existing);
  gate.resolve(answer(f.port.requests.find(r => r.roleId === f.marketingId && r.manifest.sources[0]!.reference.sourceId === b.message.source.sourceId)!, "ความเห็นช้า"));
  await drain(f);
  expect(cardFor(f, replyFor(f, b.message.id).replyMessageId!).teamReply).toMatchObject({ state: "answered" });
  // B's final was filtered; A's intent is untouched (not cancelled, same revision).
  expect(intents(f)).toEqual([existing]);
  expect(cardFor(f, replyFor(f, a.message.id).replyMessageId!).teamReply).toMatchObject({ state: "answered" });
  // Back to `all` does not create B's final late.
  setLevel(f, "telegram", "all");
  tickWorkGroups(f.store, f.clock.now);
  expect(intents(f)).toEqual([existing]);
});

test("accepting a proposal on Web cancels its unsent Telegram intent; once sent, it is marked resolved", async () => {
  const f = await fixture();
  setAllowance(f, true, 1);
  // Unsent (Telegram not bound, so the intent waits): accepting cancels it in the same transaction.
  const first = send(f, "ช่วยดูหลายด้าน");
  await drain(f);
  let card = cardFor(f, replyFor(f, first.message.id).replyMessageId!);
  expect(card.state).toBe("proposed");
  const unsent = intents(f)[0]!;
  expect(unsent).toMatchObject({ status: "waiting", attention: { item: `proposal:${card.id}` } });
  const accepted = await postForm(f, `/projects/${f.project.id}/dispatch/${card.id}/accept`, {
    csrf: f.auth.csrf, requestId: rid(), expectedRevision: String(card.revision), [`role-${f.techId}`]: "on" });
  expect(accepted.status).toBe(303);
  expect(intents(f)[0]).toMatchObject({ id: unsent.id, status: "cancelled", failureReason: "owner_answered", resolution: null });
  // The accepted team continues the same group and notifies its final once.
  await drain(f);
  card = cardFor(f, replyFor(f, first.message.id).replyMessageId!);
  expect(card).toMatchObject({ state: "accepted", teamReply: { state: "answered" } });
  expect(intents(f).map(intent => [intent.attention?.item, intent.status])).toEqual([[`proposal:${card.id}`, "cancelled"], ["final:group", "waiting"]]);

  // Sent: bind Telegram, deliver the proposal notice, then accept from Web.
  bindTelegram(f);
  const sender = new ScriptedTelegramSender();
  const worker = new DeliveryWorker(f.store, { sender, now: () => f.clock.now });
  try {
    worker.pump();
    const second = send(f, "อีกเรื่องหนึ่ง");
    await drain(f);
    const pending = cardFor(f, replyFor(f, second.message.id).replyMessageId!);
    expect(pending.state).toBe("proposed");
    worker.pump();
    const sent = intents(f).find(intent => intent.attention?.item === `proposal:${pending.id}`)!;
    expect(sent).toMatchObject({ status: "sent", remote: "accepted", resolution: null });
    expect(f.app.execute(f.auth.actor, { kind: "dispatch.proposal.accept", requestId: rid(), projectId: f.project.id, expectedRevision: pending.revision,
      payload: { proposalId: pending.id, roleIds: [f.designId] } }).proposal.state).toBe("accepted");
    const resolved = intents(f).find(intent => intent.id === sent.id)!;
    expect(resolved).toMatchObject({ status: "sent", remote: "accepted", messageRef: sent.messageRef, resolution: { reason: "owner_answered", at: f.clock.now } });
    expect(resolved.revision).toBe(sent.revision + 1);
    const html = await (await get(f, `/projects/${f.project.id}/delivery/${sent.id}`)).text();
    expect(html).toContain('data-resolution="owner_answered"');
    expect(html).toContain("เรื่องนี้ไม่รอคุณแล้ว: คุณตอบจากอีกช่องทาง ข้อความที่ส่งไปแล้วไม่ได้ถูกถอนคืน");
    // A resolved intent is never sent again by the worker.
    const before = sender.external.length;
    worker.pump();
    expect(sender.external.slice(before).some(entry => entry.dedupeKey === sent.dedupeKey)).toBe(false);
  } finally { worker.close(); }
});

test("dismissing the card, resuming a waiting role and stopping the team resolve their notices", async () => {
  const f = await fixture();
  setAllowance(f, true, 1);
  const first = send(f, "เรื่องที่ปัดตก");
  await drain(f);
  const proposal = cardFor(f, replyFor(f, first.message.id).replyMessageId!);
  f.app.execute(f.auth.actor, { kind: "dispatch.proposal.dismiss", requestId: rid(), projectId: f.project.id, expectedRevision: proposal.revision, payload: { proposalId: proposal.id } });
  expect(intents(f)[0]).toMatchObject({ status: "cancelled", failureReason: "owner_answered" });
  expect(groups(f)[0]).toMatchObject({ state: "closed", record: { closed: "dismissed" } });
  // A role waiting on its route: resuming it answers the blocked notice.
  setAllowance(f, true, 3);
  let quota = true;
  f.handlers.specialist = r => quota && r.roleId === f.designId ? fixtureOutcome("quota") : answer(r, "ความเห็น");
  const second = send(f, "เรื่องที่ติด quota");
  await drain(f);
  const card = cardFor(f, replyFor(f, second.message.id).replyMessageId!);
  const waiting = card.discussion!.roles.find(role => role.roleId === f.designId)!;
  const stall = intents(f).find(intent => intent.attention?.item?.startsWith(`job:${waiting.jobId}:`))!;
  expect(stall.status).toBe("waiting");
  quota = false;
  // Resume follows the shared contract: the waiting attempt's managed context is reconciled first.
  await f.queue.reconcile(f.port);
  const job = f.app.job(f.auth.actor, f.project.id, waiting.jobId);
  f.app.execute(f.auth.actor, { kind: "job.resume", requestId: rid(), projectId: f.project.id, expectedRevision: job.revision, payload: { jobId: job.id } });
  expect(intents(f).find(intent => intent.id === stall.id)).toMatchObject({ status: "cancelled", failureReason: "owner_answered" });
  await drain(f);
  expect(cardFor(f, replyFor(f, second.message.id).replyMessageId!).teamReply).toMatchObject({ state: "answered" });
  expect(intents(f).filter(intent => intent.attention?.workGroupId === groups(f)[1]!.id).map(intent => intent.attention!.item!.split(":")[0]))
    .toEqual(["job", "final"]);
  // Stop-all on a waiting team: the blocked notice is answered and no final follows.
  quota = true;
  const third = send(f, "เรื่องที่หยุดทั้งทีม");
  await drain(f);
  const stopped = cardFor(f, replyFor(f, third.message.id).replyMessageId!);
  const blockedIntent = intents(f).at(-1)!;
  expect(blockedIntent).toMatchObject({ status: "waiting", attention: { item: expect.stringMatching(/^job:/) } });
  f.app.execute(f.auth.actor, { kind: "team.stop_all", requestId: rid(), projectId: f.project.id, expectedRevision: stopped.discussion!.revision, payload: { discussionId: stopped.discussion!.id } });
  expect(intents(f).at(-1)).toMatchObject({ id: blockedIntent.id, status: "cancelled", failureReason: "owner_answered" });
  await drain(f);
  expect(intents(f).at(-1)!.id).toBe(blockedIntent.id);
  expect(groups(f)[2]).toMatchObject({ state: "closed", record: { closed: "stopped" } });
});

test("restart while a group is open: after reopen and settlement there is exactly one intent", async () => {
  const f = await fixture();
  const sent = send(f, "งานก่อนรีสตาร์ต");
  // Only the Jit reply runs; its commit queues the specialists, which never start before the restart.
  f.queue.pump(); await f.queue.idle();
  const card = cardFor(f, replyFor(f, sent.message.id).replyMessageId!);
  expect(card.discussion!.roles.map(role => role.state)).toEqual(["queued", "queued", "queued"]);
  expect(groups(f)[0]!.state).toBe("open");
  const g = await reopen(f);
  // Startup recompute from committed state: the group is still open and nothing is due.
  tickWorkGroups(g.store, g.clock.now);
  expect(intents(g)).toHaveLength(0);
  await drain(g);
  expect(cardFor(g, replyFor(g, sent.message.id).replyMessageId!).teamReply).toMatchObject({ state: "answered" });
  expect(intents(g)).toHaveLength(1);
  // A second restart after settlement adds nothing.
  const h = await reopen(g);
  tickWorkGroups(h.store, h.clock.now); await drain(h);
  expect(intents(h)).toHaveLength(1);
  expect(groups(h)[0]).toMatchObject({ state: "closed", record: { closed: "final" } });
});

test("restart with an admitted specialist: the interrupted role notifies as blocked once, stopping it settles and the final follows once", async () => {
  const gate = deferred<ApplicationRunOutcome>();
  let hold = true;
  const f = await fixture({ specialist: request => hold && request.roleId === f.designId ? gate.promise : answer(request, "ความเห็น") });
  try {
    const sent = send(f, "งานที่ถูกตัดกลางทาง");
    f.queue.pump(); await ticks(); f.queue.pump(); await ticks();
    expect(cardFor(f, replyFor(f, sent.message.id).replyMessageId!).discussion!.roles.find(role => role.roleId === f.designId)!.state).toBe("running");
    hold = false;
    const g = await crashReopen(f);
    tickWorkGroups(g.store, g.clock.now); tickWorkGroups(g.store, g.clock.now);
    const card = cardFor(g, replyFor(g, sent.message.id).replyMessageId!);
    const interrupted = card.discussion!.roles.find(role => role.roleId === g.designId)!;
    expect(interrupted.activity).toBe("waiting");
    expect(intents(g).map(intent => intent.attention!.item)).toEqual([expect.stringMatching(new RegExp(`^job:${interrupted.jobId}:`))]);
    // The owner answers by stopping the interrupted role; the rest of the team lets Jit answer once.
    g.app.execute(g.auth.actor, { kind: "team.control", requestId: rid(), projectId: g.project.id, expectedRevision: card.discussion!.revision,
      payload: { discussionId: card.discussion!.id, action: "stop", roleId: g.designId } });
    await drain(g);
    expect(cardFor(g, replyFor(g, sent.message.id).replyMessageId!).teamReply).toMatchObject({ state: "answered" });
    expect(intents(g).map(intent => [intent.attention!.item!.split(":")[0], intent.status])).toEqual([["job", "cancelled"], ["final", "waiting"]]);
  } finally { gate.resolve(fixtureOutcome("complete", "ผลเก่า")); }
});

test("attention.set: revisioned per channel, idempotent, validated, audited; settings form and JSON with CSRF; th/en labels", async () => {
  const f = await fixture();
  expect(f.app.attentionLevels(f.auth.actor)).toEqual({
    telegram: { channel: "telegram", level: "all", revision: 0, updatedAt: null }, web: { channel: "web", level: "all", revision: 0, updatedAt: null } });
  const command = { kind: "attention.set" as const, requestId: rid(), projectId: null, expectedRevision: 0, payload: { channel: "web" as const, level: "needs-me" as const } };
  const receipt = f.app.execute(f.auth.actor, command);
  expect(receipt).toEqual({ attention: { channel: "web", level: "needs-me", revision: 1, updatedAt: f.clock.now } });
  expect(f.app.execute(f.auth.actor, command)).toEqual(receipt);
  expect(() => f.app.execute(f.auth.actor, { ...command, payload: { channel: "web", level: "all" } })).toThrow("request_id_conflict");
  expect(() => f.app.execute(f.auth.actor, { ...command, requestId: rid() })).toThrow("stale_revision");
  // Channels are revisioned independently.
  expect(setLevel(f, "telegram", "needs-me")).toMatchObject({ channel: "telegram", revision: 1 });
  for (const payload of [{ channel: "email", level: "all" }, { channel: "web", level: "none" }, { channel: "web", level: "all", extra: 1 }]) {
    expect(() => f.app.execute(f.auth.actor, { ...command, requestId: rid(), expectedRevision: 1, payload } as never)).toThrow("invalid_attention");
  }
  expect(f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM audit WHERE command_kind = 'attention.set'")!.n)).toBe(2);
  // No-script form: one per channel with its own revision.
  const th = await (await get(f, "/settings")).text();
  expect(th).toContain('id="attention"');
  expect(th).toContain("ระดับการแจ้งเตือน");
  expect(th).toContain("เฉพาะเรื่องที่รอคุณ");
  expect(th).toContain("Web/PWA ยังไม่มีการแจ้งเตือนแบบ push ในรุ่นนี้");
  expect(th.match(/<form class="team-form" method="post" action="\/settings\/attention">/g)?.length).toBe(2);
  const posted = await postForm(f, "/settings/attention", { csrf: f.auth.csrf, requestId: rid(), expectedRevision: "1", channel: "telegram", level: "all" });
  expect(posted.status).toBe(303);
  expect(posted.headers.get("location")).toBe("/settings#attention");
  expect(f.app.attentionLevels(f.auth.actor).telegram).toMatchObject({ level: "all", revision: 2 });
  // JSON requires CSRF.
  expect((await postJson(f, "/api/settings/attention", { requestId: rid(), expectedRevision: 2, channel: "telegram", level: "needs-me" }, null)).status).toBe(403);
  const json = await postJson(f, "/api/settings/attention", { requestId: rid(), expectedRevision: 2, channel: "telegram", level: "needs-me" });
  expect(json.status).toBe(200);
  expect((await json.json()).attention).toMatchObject({ channel: "telegram", level: "needs-me", revision: 3 });
  expect(await (await get(f, "/api/settings/attention")).json()).toMatchObject({ telegram: { level: "needs-me", revision: 3 }, web: { level: "needs-me", revision: 1 } });
  expect((await postJson(f, "/api/settings/attention", { requestId: rid(), expectedRevision: 3, channel: "telegram", level: "needs-me", extra: 1 })).status).toBe(400);
  await postJson(f, "/api/settings/preferences", { requestId: rid(), expectedRevision: f.app.preferences(f.auth.actor).revision, theme: "light", language: "en" });
  const en = await (await get(f, "/settings")).text();
  expect(en).toContain("Notification level");
  expect(en).toContain("Only what needs me");
  expect(en).toContain("Web/PWA has no push notifications in this build.");
  // The level and the group notices are classified for backups.
  expect(backupImageTables.attention_levels).toBe("include");
  expect(backupImageTables.work_groups).toBe("include");
});

test("an owner answer during an in-flight send that comes back retryable never re-sends the resolved notice", async () => {
  const f = await fixture();
  bindTelegram(f);
  setAllowance(f, true, 1);
  const sent = send(f, "ตอบระหว่างส่ง");
  await drain(f);
  const card = cardFor(f, replyFor(f, sent.message.id).replyMessageId!);
  const notice = intents(f)[0]!;
  expect(notice).toMatchObject({ status: "queued", attention: { item: `proposal:${card.id}` } });
  let calls = 0;
  // The owner answers on Web while the transport call is in flight; Telegram then reports a safe failure.
  const sender: DeliverySender = { send: () => {
    calls += 1;
    f.store.transaction(tx => expect(resolveDeliveryIntent(tx, f.project.id, notice.id, "owner_answered", f.clock.now)).toBe("resolved"));
    return { outcome: "failed", reason: "telegram_unavailable", retryable: true };
  } };
  const worker = new DeliveryWorker(f.store, { sender, now: () => f.clock.now });
  try {
    worker.pump(); worker.pump();
    expect(calls).toBe(1);
    expect(intents(f)[0]).toMatchObject({ status: "failed", retryable: false, resolution: { reason: "owner_answered" } });
  } finally { worker.close(); }
});

test("a role included again after the team reply keeps the group open; the final waits until it settles", async () => {
  const first = deferred<ApplicationRunOutcome>(), again = deferred<ApplicationRunOutcome>(), team = deferred<ApplicationRunOutcome>();
  let included = false;
  const f = await fixture({
    jit: r => answer(r, dispatching(["เทคโนโลยี", "การตลาด"])),
    specialist: r => r.roleId === f.marketingId ? (included ? again.promise : first.promise) : answer(r, "ความเห็น"),
    team: () => team.promise,
  });
  try {
    const sent = send(f, "ช่วยดูสองด้าน");
    f.queue.pump(); await ticks(); f.queue.pump(); await ticks();
    let card = cardFor(f, replyFor(f, sent.message.id).replyMessageId!);
    const control = (action: "skip" | "include", roleId: string) => f.app.execute(f.auth.actor, { kind: "team.control", requestId: rid(), projectId: f.project.id,
      expectedRevision: f.app.discussion(f.auth.actor, f.project.id, card.discussion!.id).discussion.revision, payload: { discussionId: card.discussion!.id, action, roleId } });
    control("skip", f.marketingId);
    expect(cardFor(f, replyFor(f, sent.message.id).replyMessageId!).teamReply).toMatchObject({ state: "thinking" });
    // While Jit answers, the owner brings the skipped role back; the team reply then commits first.
    included = true;
    control("include", f.marketingId);
    f.queue.pump(); await ticks();
    team.resolve(answer(f.port.requests.find(r => r.instructions.operator[0] === teamReplyMarker)!, JSON.stringify({ reply: "ทีมตอบก่อน" })));
    await ticks(); tickWorkGroups(f.store, f.clock.now);
    card = cardFor(f, replyFor(f, sent.message.id).replyMessageId!);
    expect(card.teamReply).toMatchObject({ state: "answered" });
    expect(card.discussion!.roles.some(role => role.roleId === f.marketingId && role.activity === "live")).toBe(true);
    expect(intents(f)).toHaveLength(0);
    expect(groups(f)[0]!.state).toBe("open");
    again.resolve(answer(f.port.requests.filter(r => r.roleId === f.marketingId).at(-1)!, "ความเห็นที่เพิ่มมา"));
    first.resolve(fixtureOutcome("complete", "ผลเก่า"));
    await drain(f);
    expect(intents(f).map(intent => intent.attention!.item)).toEqual(["final:group"]);
    expect(groups(f)[0]).toMatchObject({ state: "closed", record: { closed: "final" } });
  } finally { first.resolve(fixtureOutcome("complete", "x")); again.resolve(fixtureOutcome("complete", "x")); team.resolve(fixtureOutcome("complete", "x")); }
});

test("the sweep rotates through every open group instead of re-reading the oldest page", async () => {
  const f = await fixture();
  setAllowance(f, true, 1);
  for (const text of ["หนึ่ง", "สอง", "สาม"]) { send(f, text); f.queue.pump(); await f.queue.idle(); f.clock.now += 1; }
  // Remove the notices so only the sweep can recreate them, one group per tick.
  f.store.transaction(tx => { tx.run("DELETE FROM delivery_intents"); tx.run("UPDATE work_groups SET record_json = '{\"items\":{},\"closed\":null}'"); });
  const seen: number[] = [];
  for (let i = 0; i < 3; i++) { tickWorkGroups(f.store, f.clock.now, 1); seen.push(intents(f).length); }
  expect(seen).toEqual([1, 2, 3]);
  expect(new Set(intents(f).map(intent => intent.attention!.workGroupId)).size).toBe(3);
});
