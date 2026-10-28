import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Application } from "../src/application";
import { readConfig } from "../src/config";
import { AppError } from "../src/errors";
import { dictionaries } from "../src/i18n";
import { JobQueue } from "../src/jobs/queue";
import { memoryExtractionMarker, memoryExtractionWork, scriptedMemoryResult } from "../src/memory/extract";
import type { ClaimReference, MemoryClaim } from "../src/memory/types";
import { backupImageTables } from "../src/ops/backup";
import { promotionInstruction, type PromotionCommand, type PromotionProposalView } from "../src/promotion";
import { setupCheckWork, type SetupCommand } from "../src/setup";
import type { SourceReference } from "../src/sources";
import { TransactionStore } from "../src/store";
import { discussionPlanWork, specialistAnalysisWork } from "../src/team/dispatch";
import { jitReplyWork, type JitReplyView } from "../src/team/jit-reply";
import { ScriptedRunPort, fixtureOutcome, specialistFixtureResult } from "../src/team/scripted-port";
import type { ApplicationRunOutcome, ApplicationRunRequest, RoleRoute, TeamCommand } from "../src/team/types";
import { createWebHandler } from "../src/web";
import { assetUrl } from "../src/web-assets";

/**
 * app.topic_promotion/v1 and the chat-first home (BOT05, S09-AC05, ADR 0031) through the public command and query
 * boundary, with a scripted host and a fake clock: home → General topic → promotion, stale/forged/injected proposals,
 * provenance, and deletion/forget of the origin after promotion. No paid inference and no network.
 */
const roots: string[] = [], stores: TransactionStore[] = [], queues: JobQueue[] = [];
afterEach(async () => {
  for (const q of queues.splice(0)) { q.close(); await q.idle(); }
  for (const s of stores.splice(0)) s.close();
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});
const password = "fixture-bot05-owner-password", epoch = 1_800_000_000_000, origin = "http://localhost:3000";
const grok: RoleRoute = { provider: "grok", model: "fixture-grok-exact", authRoute: "owner-grok" };
const rid = () => crypto.randomUUID();
const jitPurpose = "Jit reply to the owner's newest message";
const answer = (request: ApplicationRunRequest, output: string): ApplicationRunOutcome => ({
  ...fixtureOutcome("complete", output), usage: { calls: 1, rounds: 1, hops: 1, contextTokens: 0, outputTokens: 0, retries: 0, wallMs: 0, tokensUnknown: false },
  session: { adapter: "scripted", id: request.runId, context: request.context },
});

async function fixture(language: "th" | "en" = "th") {
  const root = mkdtempSync(join(tmpdir(), "jit-bot05-")); roots.push(root);
  const path = join(root, "state.sqlite"), config = readConfig({ JIT_DATABASE: path }), store = new TransactionStore(path); stores.push(store);
  let now = epoch;
  /** Scripted Jit outputs, consumed one per Jit reply; a plain acknowledgement when empty. */
  const outputs: unknown[] = [];
  let answered = 0;
  const port = new ScriptedRunPort(store, config.team, config.jobs.outputBytes, request => {
    if (request.instructions.operator.includes(memoryExtractionMarker)) return scriptedMemoryResult(request, true);
    if (request.purpose === jitPurpose) {
      // Each default answer is distinct, so deleting one never meets an unlinked copy of a short payload.
      const next = outputs.shift() ?? { reply: `รับทราบข้อความที่ ${++answered}` };
      return answer(request, typeof next === "string" ? next : JSON.stringify(next));
    }
    if (request.purpose.startsWith("Jit")) return answer(request, JSON.stringify({ reply: "รับทราบ" }));
    if (request.instructions.operator.some(line => line.startsWith("Jit setup connection check"))) return answer(request, "OK");
    return fixtureOutcome("complete", specialistFixtureResult("วิเคราะห์แล้ว", request, config.jobs.outputBytes));
  });
  const queue = new JobQueue(store, config.jobs, [setupCheckWork(store, config, port, () => now), jitReplyWork(store, config, port, () => now),
    memoryExtractionWork(store, config, port, () => now), discussionPlanWork(), specialistAnalysisWork(store, config, port, () => now)], { now: () => now });
  queues.push(queue);
  const app = new Application(store, config, { now: () => now, jobs: queue });
  const web = createWebHandler(app, { stream: { intervalMs: 1, polls: 2 } });
  await app.setupOwner(password);
  const token = await app.login(password), auth = app.authenticate(token);
  const f = { root, config, store, app, queue, port, token, auth, web, outputs, tech: "", advance: (ms: number) => { now += ms; } };
  const setup = (kind: SetupCommand["kind"], payload: unknown) =>
    app.execute(auth.actor, { kind, requestId: rid(), projectId: null, expectedRevision: app.setup(auth.actor).revision, payload } as SetupCommand);
  setup("setup.wake", { language });
  setup("setup.connect", { route: grok });
  await settle(f);
  setup("setup.connect.continue", {});
  setup("setup.know", { addressAs: language === "th" ? "พี่บอส" : "Boss", selfReference: "", language, particle: language === "th" ? "khrap" : "none" });
  setup("setup.personality.skip", {});
  setup("setup.complete", {});
  f.tech = app.execute(auth.actor, { kind: "role.save", projectId: null, requestId: rid(), expectedRevision: app.team(auth.actor).ownerRevision,
    payload: { roleId: null, name: "เทคโนโลยี", kind: "specialist", responsibility: "วิเคราะห์ฐานข้อมูลและโครงสร้างซอฟต์แวร์", enabled: true, route: grok } }).role!.id;
  return f;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function settle(f: Pick<Fixture, "queue" | "store">) {
  for (let i = 0; i < 400; i++) {
    f.queue.pump();
    const pending = f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM jobs WHERE state IN ('queued', 'admitted')")!.n);
    await f.queue.idle();
    if (pending === 0) return;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  throw new Error("queue did not drain");
}
const general = (f: Fixture) => f.app.generalSpace(f.auth.actor)!;
const workspaceRevision = (f: Fixture) => f.app.workspace(f.auth.actor).revision;
const projectIds = (f: Fixture) => f.app.workspace(f.auth.actor).projects.map(p => p.id);
const reply = (f: Fixture, projectId: string, topicId: string, messageId: string) => f.app.replies(f.auth.actor, projectId, topicId, [messageId]).get(messageId)!;
/** Starts a chat from the home composer through the public command, then lets Jit answer. */
async function chat(f: Fixture, text: string, projectId = general(f).projectId) {
  const receipt = f.app.execute(f.auth.actor, { kind: "chat.start", requestId: rid(), projectId, expectedRevision: workspaceRevision(f), payload: { text } });
  await settle(f);
  return { topic: receipt.topic, message: receipt.message, reply: reply(f, projectId, receipt.topic.id, receipt.message.id) };
}
async function say(f: Fixture, projectId: string, topicId: string, text: string, wait = true) {
  const topic = f.app.conversation(f.auth.actor, projectId, topicId).topic;
  const sent = f.app.execute(f.auth.actor, { kind: "message.send", projectId, requestId: rid(), expectedRevision: topic.revision, payload: { topicId, text } });
  if (wait) await settle(f);
  return { message: sent.message, reply: reply(f, projectId, topicId, sent.message.id) };
}
const promote = (f: Fixture, kind: "accept" | "dismiss", view: PromotionProposalView, overrides: Partial<PromotionCommand> = {}): PromotionCommand =>
  ({ kind: `topic.promote.${kind}`, requestId: rid(), projectId: view.projectId, expectedRevision: view.revision,
    payload: { topicId: view.topicId, replyId: view.replyId, proposalId: view.id }, ...overrides } as PromotionCommand);
const card = (f: Fixture, view: PromotionProposalView) => reply(f, view.projectId, view.topicId,
  f.store.read(tx => tx.get<{ id: string }>("SELECT message_id AS id FROM jit_replies WHERE id = ?", view.replyId)!.id)).promotionProposals[0]!;
const proposal = (name: string, extra: Record<string, unknown> = {}) => ({ reply: "เรื่องนี้ควรเป็นโครงการของตัวเองแล้วครับ", proposals: [{ kind: "promotion", name, ...extra }] });
function rejects(run: () => unknown, code: string) {
  try { run(); } catch (error) { expect(error).toBeInstanceOf(AppError); expect((error as AppError).code).toBe(code); return; }
  throw new Error(`expected ${code}`);
}
const count = (f: Fixture, table: string) => f.store.read(tx => tx.get<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)!.n);

function get(f: Fixture, path: string) {
  return f.web(new Request(`${origin}${path}`, { headers: { cookie: `jit_session=${f.token}` } }));
}
function postForm(f: Fixture, path: string, fields: Record<string, string>) {
  return f.web(new Request(`${origin}${path}`, { method: "POST", body: new URLSearchParams(fields).toString(),
    headers: { "content-type": "application/x-www-form-urlencoded", origin, cookie: `jit_session=${f.token}` } }));
}
function postJson(f: Fixture, path: string, body: unknown, csrf: string | null = f.auth.csrf) {
  return f.web(new Request(`${origin}${path}`, { method: "POST", body: JSON.stringify(body),
    headers: { "content-type": "application/json", origin, cookie: `jit_session=${f.token}`, ...(csrf ? { "x-csrf-token": csrf } : {}) } }));
}
/** What a browser without script submits for the form whose action matches: hidden fields and selected options. */
function form(html: string, action: string) {
  for (const match of html.matchAll(/<form\b[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/g)) {
    if (match[1] !== action) continue;
    const fields: Record<string, string> = {};
    for (const input of match[2]!.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) fields[input[1]!] = input[2]!;
    for (const select of match[2]!.matchAll(/<select name="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
      fields[select[1]!] = (/<option value="([^"]*)" selected>/.exec(select[2]!) ?? /<option value="([^"]*)"/.exec(select[2]!))![1]!;
    }
    return fields;
  }
  throw new Error(`no form for ${action}`);
}
function expectNoInlineScript(html: string) {
  for (const [tag, body] of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
    expect(body).toBe("");
    expect(tag).toBe(`<script type="module" src="${assetUrl("app.js")}"></script>`);
  }
  expect(html).not.toMatch(/\son[a-z]+\s*=/i);
}
const topicPath = (projectId: string, topicId: string) => `/projects/${projectId}/topics/${topicId}`;
const promotionPath = (view: PromotionProposalView, verb: string) => `${topicPath(view.projectId, view.topicId)}/replies/${view.replyId}/promotions/${view.id}/${verb}`;

test("home is a chat composer: without choosing a project the chat lands in the General space and Jit answers; the chip picks another project", async () => {
  const f = await fixture();
  const g = general(f);
  let html = await (await get(f, "/")).text();
  const d = dictionaries.th;
  expect(html).toContain(`${d["home.greeting"]} พี่บอส`);
  expect(html).toContain('<form class="composer home-composer" id="new-chat" method="post" action="/chats">');
  // The chip defaults to the General space, named in the owner's language, and the form needs no script.
  expect(html).toContain(`<option value="${g.projectId}" selected>${d["setup.general_name"]}</option>`);
  expect(html).toContain(d["home.nothing_waiting"]);
  expect(html).toContain('id="new-project"');
  expectNoInlineScript(html);
  const first = form(html, "/chats");
  expect(first.projectId).toBe(g.projectId);
  let response = await postForm(f, "/chats", { ...first, text: "อยากทำแอปจดรายจ่าย\nเริ่มยังไงดี" });
  expect(response.status).toBe(303);
  const location = response.headers.get("location")!;
  const [, projectId, topicId] = /^\/projects\/([a-f0-9-]{36})\/topics\/([a-f0-9-]{36})#message-[a-f0-9-]{36}$/.exec(location)!;
  expect(projectId).toBe(g.projectId);
  await settle(f);
  const state = f.app.conversation(f.auth.actor, g.projectId, topicId!);
  expect(state.topic.title).toBe("อยากทำแอปจดรายจ่าย");
  expect(state.items.map(m => m.text)).toEqual(["อยากทำแอปจดรายจ่าย\nเริ่มยังไงดี", "รับทราบข้อความที่ 1"]);
  expect(reply(f, g.projectId, topicId!, state.items[0]!.id).state).toBe("answered");
  // A double submit replays the receipt: one topic, one message, one reply.
  const replay = await postForm(f, "/chats", { ...first, text: "อยากทำแอปจดรายจ่าย\nเริ่มยังไงดี" });
  expect(replay.headers.get("location")).toBe(location);
  expect(f.app.topics(f.auth.actor, g.projectId).items).toHaveLength(2);
  expect(count(f, "jit_replies")).toBe(1);

  // Another project from the chip; `?project=` preselects it.
  const other = f.app.execute(f.auth.actor, { kind: "project.create", projectId: null, requestId: rid(), expectedRevision: workspaceRevision(f), payload: { name: "งานบ้าน" } }).project;
  html = await (await get(f, `/?project=${other.id}`)).text();
  expect(html).toContain(`<option value="${other.id}" selected>งานบ้าน</option>`);
  response = await postForm(f, "/chats", { ...form(html, "/chats"), text: "ซ่อมก๊อกน้ำ" });
  const otherTopic = /topics\/([a-f0-9-]{36})/.exec(response.headers.get("location")!)![1]!;
  expect(response.headers.get("location")!.startsWith(`/projects/${other.id}/`)).toBe(true);
  await settle(f);
  expect(f.app.conversation(f.auth.actor, other.id, otherTopic).items.map(m => m.text)).toEqual(["ซ่อมก๊อกน้ำ", "รับทราบข้อความที่ 2"]);
  // A home page rendered before the project list changed is stale, and the JSON path needs CSRF.
  response = await postForm(f, "/chats", { ...first, requestId: rid(), text: "ข้อความจากหน้าเก่า" });
  expect(response.status).toBe(409);
  rejects(() => f.app.execute(f.auth.actor, { kind: "chat.start", requestId: rid(), projectId: g.projectId, expectedRevision: 0, payload: { text: "x" } }), "stale_revision");
  expect((await postJson(f, "/api/chats", { requestId: rid(), expectedRevision: workspaceRevision(f), projectId: g.projectId, text: "no csrf" }, null)).status).toBe(403);
  const json = await (await postJson(f, "/api/chats", { requestId: rid(), expectedRevision: workspaceRevision(f), projectId: g.projectId, text: "ผ่าน JSON" })).json();
  expect(json.topic).toMatchObject({ projectId: g.projectId, title: "ผ่าน JSON" });
  rejects(() => f.app.execute(f.auth.actor, { kind: "chat.start", requestId: rid(), projectId: g.projectId, expectedRevision: workspaceRevision(f), payload: { text: "   " } }), "empty_text");

  // The waiting strip names projects with items waiting on the owner, in words and a number.
  const topic = f.app.conversation(f.auth.actor, g.projectId, topicId!).topic;
  f.app.execute(f.auth.actor, { kind: "task.propose", requestId: rid(), projectId: g.projectId, expectedRevision: topic.revision, payload: { topicId: topicId!, title: "ร่างหน้าจอ", summary: "หน้าบันทึกรายจ่าย" } });
  html = await (await get(f, "/")).text();
  const strip = html.slice(html.indexOf('class="waiting-strip"'), html.indexOf("</section>", html.indexOf('class="waiting-strip"')));
  expect(strip).toContain(`href="/projects/${g.projectId}/tasks"`);
  expect(strip).toContain(`${d["shell.badge_waiting"]} 1`);
  expect(strip).not.toContain("งานบ้าน");
});

test("accepting the current promotion revision creates one project and topic linked at the exact revision; the origin becomes read-only", async () => {
  const f = await fixture();
  const g = general(f);
  f.outputs.push(proposal("แอปจดรายจ่าย", { move: true, tasks: ["ย้ายงานทั้งหมด"] }));
  const started = await chat(f, "อยากทำแอปจดรายจ่ายบน Pi");
  // The run was told the promotion shape as a trusted operator line; a card is not a project.
  const request = f.port.requests.filter(item => item.purpose === jitPurpose).at(-1)!;
  expect(request.instructions.operator.some(line => line.includes(promotionInstruction))).toBe(true);
  expect(request.instructions.operator.length).toBeLessThanOrEqual(8);
  const view = started.reply.promotionProposals[0]!;
  expect(started.reply.promotionProposals).toHaveLength(1);
  expect(view).toMatchObject({ kind: "promotion", revision: 1, state: "proposed", author: "jit", name: "แอปจดรายจ่าย",
    dropped: ["field:move", "field:tasks"], droppedTotal: 2, promotion: null, history: [{ revision: 1, author: "jit", state: "proposed" }] });
  expect(f.app.job(f.auth.actor, g.projectId, started.reply.jobId!).evidence).toContain("proposals promotion:1");
  expect(projectIds(f)).toEqual([g.projectId]);
  const before = f.app.conversation(f.auth.actor, g.projectId, started.topic.id);
  const messageForm = form(await (await get(f, topicPath(g.projectId, started.topic.id))).text(), `${topicPath(g.projectId, started.topic.id)}/messages`);

  // Accept by plain form post, exactly as the card renders it.
  let html = await (await get(f, topicPath(g.projectId, started.topic.id))).text();
  expect(html).toContain(dictionaries.th["promotion.eyebrow"]);
  expect(html).toContain(dictionaries.th["promotion.what_happens_text"]);
  const acceptForm = form(html, promotionPath(view, "accept"));
  const response = await postForm(f, promotionPath(view, "accept"), acceptForm);
  expect(response.status).toBe(303);
  const promoted = f.app.promotion(f.auth.actor, g.projectId, started.topic.id).promotedTo!;
  expect(response.headers.get("location")).toBe(`${topicPath(promoted.target.projectId, promoted.target.topicId)}#message-${promoted.link.messageId}`);
  expect(promoted.origin).toEqual({ projectId: g.projectId, topicId: started.topic.id, topicRevision: before.topic.revision, messageSequence: before.items.at(-1)!.sequence });
  expect(promoted).toMatchObject({ replyId: view.replyId, proposalId: view.id, proposalRevision: 1, project: { name: "แอปจดรายจ่าย" }, topicTitle: "แอปจดรายจ่าย" });
  expect(projectIds(f).sort()).toEqual([g.projectId, promoted.target.projectId].sort());
  // The continuation's first record names the origin at that revision, by identity only.
  const continuation = f.app.conversation(f.auth.actor, promoted.target.projectId, promoted.target.topicId);
  expect(continuation.items).toHaveLength(1);
  expect(continuation.items[0]).toMatchObject({ id: promoted.link.messageId, sequence: 1, attribution: { kind: "service", service: "jit-promotion" }, text: null });
  const link = f.app.source(f.auth.actor, promoted.target.projectId, promoted.link.source);
  expect(link).toMatchObject({ state: "unavailable", reason: "external_not_imported",
    descriptor: { kind: "external", system: "jit", resourceType: "topic", resourceId: `${g.projectId}/${started.topic.id}`, revisionHint: `revision ${before.topic.revision} message ${before.items.at(-1)!.sequence}` } });
  const into = f.app.promotion(f.auth.actor, promoted.target.projectId, promoted.target.topicId);
  expect(into.promotedTo).toBeNull();
  expect(into.continuedFrom!.id).toBe(promoted.id);
  expect(into.continuedFrom!.origin.messages.map(m => [m.text, m.jit])).toEqual([["อยากทำแอปจดรายจ่ายบน Pi", false], ["เรื่องนี้ควรเป็นโครงการของตัวเองแล้วครับ", true]]);
  // The new topic shows the prior conversation as a "continued from General" block.
  html = await (await get(f, topicPath(promoted.target.projectId, promoted.target.topicId))).text();
  expect(html).toContain(`ต่อจาก${dictionaries.th["setup.general_name"]}`);
  expect(html).toContain("อยากทำแอปจดรายจ่ายบน Pi");
  expect(html).toContain(`href="${topicPath(g.projectId, started.topic.id)}"`);
  expectNoInlineScript(html);
  const api = await (await get(f, `/api${topicPath(promoted.target.projectId, promoted.target.topicId)}`)).json();
  expect(api.promotion.continuedFrom.origin).toMatchObject({ projectId: g.projectId, topicId: started.topic.id, topicRevision: before.topic.revision });

  // The origin is read-only, marked promoted, and links to the continuation.
  html = await (await get(f, topicPath(g.projectId, started.topic.id))).text();
  expect(html).toContain(dictionaries.th["promotion.promoted_title"]);
  expect(html).toContain(dictionaries.th["promotion.read_only"]);
  expect(html).not.toContain(`action="${topicPath(g.projectId, started.topic.id)}/messages"`);
  expect(html).not.toContain('id="team-dispatch"');
  expect(html).toContain(`href="${topicPath(promoted.target.projectId, promoted.target.topicId)}"`);
  expect(card(f, view)).toMatchObject({ state: "accepted", promotion: { id: promoted.id, projectId: promoted.target.projectId, topicId: promoted.target.topicId } });
  rejects(() => f.app.execute(f.auth.actor, { kind: "message.send", projectId: g.projectId, requestId: rid(), expectedRevision: before.topic.revision, payload: { topicId: started.topic.id, text: "ต่ออีกนิด" } }), "topic_promoted");
  const stale = await postForm(f, `${topicPath(g.projectId, started.topic.id)}/messages`, { ...messageForm, text: "จากฟอร์มเก่า" });
  expect(stale.status).toBe(409);
  const page = await stale.text();
  expect(page).toContain(dictionaries.th["error.topic_promoted"]);
  expect(page).toContain(dictionaries.th["error.recovery_open_topic"]);
  const dispatch: Extract<TeamCommand, { kind: "team.dispatch" }> = { kind: "team.dispatch", requestId: rid(), projectId: g.projectId, expectedRevision: f.app.project(f.auth.actor, g.projectId).revision,
    payload: { topicId: started.topic.id, purpose: "วิเคราะห์ต่อ", sources: [started.topic.source], include: [f.tech], exclude: [], limits: { ...f.config.jobs.maximum } } };
  rejects(() => f.app.execute(f.auth.actor, dispatch), "topic_promoted");
  expect(f.app.conversation(f.auth.actor, g.projectId, started.topic.id).items).toHaveLength(2);

  // Accepting again never creates a second project: a replay returns the receipt, a new request is refused.
  const again = await postForm(f, promotionPath(view, "accept"), acceptForm);
  expect(again.headers.get("location")).toBe(response.headers.get("location"));
  rejects(() => f.app.execute(f.auth.actor, promote(f, "accept", view)), "promotion_proposal_closed");
  expect(projectIds(f)).toHaveLength(2);
  expect(count(f, "topic_promotions")).toBe(1);

  // The conversation continues in the new project; that project is not the General space, so Jit offers no promotion there.
  const next = await say(f, promoted.target.projectId, promoted.target.topicId, "เริ่มจากหน้าจอไหนดี");
  expect(next.reply.state).toBe("answered");
  const continued = f.port.requests.filter(item => item.purpose === jitPurpose).at(-1)!;
  expect(continued.projectId).toBe(promoted.target.projectId);
  expect(continued.instructions.operator.some(line => line.includes("\"kind\":\"promotion\""))).toBe(false);
});

test("stale, forged and injected promotions change nothing", async () => {
  const f = await fixture();
  const g = general(f);
  f.outputs.push(proposal("ชื่อเดิม"));
  const first = await chat(f, "คุยเรื่องแอป");
  const view = first.reply.promotionProposals[0]!;

  // An owner edit is revision 2; a card showing revision 1 is stale.
  let html = await (await get(f, topicPath(g.projectId, first.topic.id))).text();
  let response = await postForm(f, promotionPath(view, "revise"), { ...form(html, promotionPath(view, "revise")), name: "ชื่อที่เจ้าของแก้" });
  expect(response.headers.get("location")).toContain(`#proposal-${view.id}`);
  const edited = card(f, view);
  expect(edited).toMatchObject({ revision: 2, author: "owner", state: "proposed", name: "ชื่อที่เจ้าของแก้",
    history: [{ revision: 1, author: "jit", state: "superseded" }, { revision: 2, author: "owner", state: "proposed" }] });
  rejects(() => f.app.execute(f.auth.actor, promote(f, "accept", view)), "promotion_proposal_stale");
  response = await postForm(f, promotionPath(view, "accept"), form(html, promotionPath(view, "accept")));
  expect(response.status).toBe(409);
  expect(projectIds(f)).toEqual([g.projectId]);

  // Forged identities and shapes are refused before anything is written.
  const other = f.app.execute(f.auth.actor, { kind: "project.create", projectId: null, requestId: rid(), expectedRevision: workspaceRevision(f), payload: { name: "อื่น" } }).project;
  rejects(() => f.app.execute(f.auth.actor, promote(f, "accept", edited, { payload: { topicId: first.topic.id, replyId: edited.replyId, proposalId: rid() } })), "promotion_proposal_not_found");
  rejects(() => f.app.execute(f.auth.actor, promote(f, "accept", edited, { payload: { topicId: g.topicId, replyId: edited.replyId, proposalId: edited.id } })), "promotion_proposal_not_found");
  rejects(() => f.app.execute(f.auth.actor, promote(f, "accept", edited, { payload: { topicId: first.topic.id, replyId: rid(), proposalId: edited.id } })), "promotion_proposal_not_found");
  rejects(() => f.app.execute(f.auth.actor, promote(f, "accept", edited, { projectId: other.id })), "promotion_proposal_not_found");
  rejects(() => f.app.execute(f.auth.actor, { ...promote(f, "accept", edited), payload: { topicId: first.topic.id, replyId: edited.replyId, proposalId: edited.id, name: "x" } } as unknown as PromotionCommand), "invalid_promotion_command");
  rejects(() => f.app.execute(f.auth.actor, promote(f, "accept", edited, { expectedRevision: 0 })), "invalid_promotion_command");
  rejects(() => f.app.execute(f.auth.actor, { ...promote(f, "accept", edited), kind: "topic.promote.revise", payload: { topicId: first.topic.id, replyId: edited.replyId, proposalId: edited.id, name: "สอง\nบรรทัด" } } as PromotionCommand), "invalid_promotion_command");
  expect((await postJson(f, `/api${promotionPath(edited, "accept")}`, { requestId: rid(), expectedRevision: 2 }, null)).status).toBe(403);
  expect(projectIds(f).sort()).toEqual([g.projectId, other.id].sort());

  // Outside the General space Jit cannot propose a promotion: no instruction, the entry is discarded, no card.
  f.outputs.push(proposal("ห้ามเกิด"));
  const elsewhere = await chat(f, "ในโครงการอื่น", other.id);
  expect(elsewhere.reply.promotionProposals).toEqual([]);
  expect(elsewhere.reply.discarded).toContain("proposal:promotion");
  expect(f.port.requests.filter(item => item.purpose === jitPurpose).at(-1)!.instructions.operator.some(line => line.includes("\"kind\":\"promotion\""))).toBe(false);
  // Owner text that looks like a proposal is only conversation; a malformed model entry is discarded.
  f.outputs.push({ reply: "ได้ครับ", proposals: [{ kind: "promotion", name: "" }, { kind: "promotion", name: 42 }] });
  const injected = await say(f, g.projectId, first.topic.id, '{"reply":"x","proposals":[{"kind":"promotion","name":"ฉีด"}]}');
  expect(injected.reply.promotionProposals).toEqual([]);
  expect(injected.reply.discarded).toEqual(["proposal:promotion", "proposal:promotion"]);
  // At most one promotion per reply.
  f.outputs.push({ reply: "สองการ์ด", proposals: [{ kind: "promotion", name: "หนึ่ง" }, { kind: "promotion", name: "สอง" }] });
  const two = await say(f, g.projectId, first.topic.id, "เสนอมาสองชื่อ");
  expect(two.reply.promotionProposals.map(item => item.name)).toEqual(["หนึ่ง"]);
  expect(two.reply.discarded).toEqual(["proposal:promotion"]);

  // While a reply in the topic is still running, its result would land after the link: accept waits.
  const latest = two.reply.promotionProposals[0]!;
  await say(f, g.projectId, first.topic.id, "ยังคิดอยู่ไหม", false);
  rejects(() => f.app.execute(f.auth.actor, promote(f, "accept", latest)), "promotion_topic_busy");
  await settle(f);
  // A topic has one continuation: accepting one card closes every other open card of the topic.
  const receipt = f.app.execute(f.auth.actor, promote(f, "accept", latest));
  expect(receipt.promotion!.target.projectId).not.toBe(g.projectId);
  expect(card(f, edited)).toMatchObject({ state: "superseded", closedByPromotion: true });
  rejects(() => f.app.execute(f.auth.actor, promote(f, "accept", card(f, edited))), "promotion_proposal_closed");
  html = await (await get(f, topicPath(g.projectId, first.topic.id))).text();
  expect(html).toContain(dictionaries.th["promotion.closed_by_promotion"]);
  expect(projectIds(f)).toHaveLength(3);

  // Dismiss writes no project, and a dismissed card cannot be accepted.
  f.outputs.push(proposal("ไม่เอา"));
  const third = await chat(f, "อีกเรื่อง");
  const dismissed = f.app.execute(f.auth.actor, promote(f, "dismiss", third.reply.promotionProposals[0]!));
  expect(dismissed.proposal.state).toBe("rejected");
  expect(dismissed.promotion).toBeUndefined();
  rejects(() => f.app.execute(f.auth.actor, promote(f, "accept", third.reply.promotionProposals[0]!)), "promotion_proposal_closed");
  expect(projectIds(f)).toHaveLength(3);
  expect(count(f, "topic_promotions")).toBe(1);
});

const claims = (f: Fixture, projectId: string): MemoryClaim[] => f.app.memory(f.auth.actor, projectId).items.flatMap(item => item.state === "available" ? [item.claim] : []);
const ref = (claim: ClaimReference): ClaimReference => ({ claimId: claim.claimId, revision: claim.revision, generation: claim.generation });

test("sources, memory claims and tasks keep their project; the new project reaches General memory only through cross-project provenance", async () => {
  const f = await fixture();
  const g = general(f);
  f.outputs.push(proposal("ระบบบัญชีบ้าน"));
  const started = await chat(f, "ใช้ PostgreSQL สำหรับระบบบัญชีบ้าน");
  const ownerSource = started.message.source;
  // A claim and a task proposal in the General topic before promotion.
  f.app.execute(f.auth.actor, { kind: "memory.extract", requestId: rid(), projectId: g.projectId, expectedRevision: f.app.project(f.auth.actor, g.projectId).revision,
    payload: { topicId: started.topic.id, roleId: f.tech, source: ownerSource, dependencies: [], limits: { ...f.config.jobs.maximum } } });
  await settle(f);
  const [claim] = claims(f, g.projectId);
  expect(claim).toMatchObject({ projectId: g.projectId, source: ownerSource });
  const topic = f.app.conversation(f.auth.actor, g.projectId, started.topic.id).topic;
  const task = f.app.execute(f.auth.actor, { kind: "task.propose", requestId: rid(), projectId: g.projectId, expectedRevision: topic.revision,
    payload: { topicId: started.topic.id, title: "ตั้งฐานข้อมูล", summary: "ติดตั้ง PostgreSQL" } }).task;
  const view = reply(f, g.projectId, started.topic.id, started.message.id).promotionProposals[0]!;
  const { promotion } = f.app.execute(f.auth.actor, promote(f, "accept", view));
  const target = promotion!.target;

  // Nothing moved: the claim, its source and the task keep the General project; the new project holds no origin text.
  expect(claims(f, g.projectId).map(item => [item.claimId, item.projectId, item.source])).toEqual([[claim!.claimId, g.projectId, ownerSource]]);
  expect(claims(f, target.projectId)).toEqual([]);
  expect(f.app.source(f.auth.actor, g.projectId, ownerSource)).toMatchObject({ state: "available", text: "ใช้ PostgreSQL สำหรับระบบบัญชีบ้าน" });
  expect(f.app.source(f.auth.actor, target.projectId, ownerSource)).toMatchObject({ state: "unavailable", reason: "source_not_found" });
  expect(f.app.memory(f.auth.actor, target.projectId).sources.map(item => item.source.state === "available" ? item.source.text : null)).toEqual(["ระบบบัญชีบ้าน"]);
  const generalTasks = f.app.tasks(f.auth.actor, g.projectId);
  expect(generalTasks.proposed.map(item => [item.id, item.projectId, item.topicId])).toEqual([[task.id, g.projectId, started.topic.id]]);
  const newTasks = f.app.tasks(f.auth.actor, target.projectId);
  expect([...newTasks.proposed, ...newTasks.accepted, ...newTasks.readyForReview]).toEqual([]);
  expect(f.app.project(f.auth.actor, g.projectId).name).toBe(dictionaries.th["setup.general_name"]);

  // Cross-project memory: the new project's analysis may cite the General claim, labelled with its original project.
  const dispatch = (purpose: string): Extract<TeamCommand, { kind: "team.dispatch" }> => ({ kind: "team.dispatch", requestId: rid(), projectId: target.projectId,
    expectedRevision: f.app.project(f.auth.actor, target.projectId).revision, payload: { topicId: target.topicId, purpose,
      sources: [f.app.topics(f.auth.actor, target.projectId).items[0]!.source], include: [f.tech], exclude: [], limits: { ...f.config.jobs.maximum } } });
  const cited = f.app.execute(f.auth.actor, dispatch("ใช้ PostgreSQL สำหรับระบบบัญชีบ้าน")).discussion!;
  await settle(f);
  const manifest = f.app.discussion(f.auth.actor, target.projectId, cited.id).discussion.manifest;
  expect(manifest.claims.map(item => [item.claimId, item.projectId])).toContainEqual([claim!.claimId, g.projectId]);
  // Forgetting the claim in its own project withdraws it from the new project's later analysis too.
  f.app.execute(f.auth.actor, { kind: "memory.forget", requestId: rid(), projectId: g.projectId, expectedRevision: f.app.project(f.auth.actor, g.projectId).revision,
    payload: { claim: ref(claim!), reason: "เจ้าของขอให้ลืม", acknowledged: true } });
  const after = f.app.execute(f.auth.actor, dispatch("ใช้ PostgreSQL สำหรับระบบบัญชีบ้าน อีกครั้ง")).discussion!;
  await settle(f);
  expect(f.app.discussion(f.auth.actor, target.projectId, after.id).discussion.manifest.claims.map(item => item.claimId)).not.toContain(claim!.claimId);
  // The promotion link itself is unchanged by the forget.
  expect(f.app.promotion(f.auth.actor, target.projectId, target.topicId).continuedFrom!.id).toBe(promotion!.id);
});

function deleteSource(f: Fixture, projectId: string, source: SourceReference) {
  const revision = () => f.app.project(f.auth.actor, projectId).revision;
  const preview = f.app.execute(f.auth.actor, { kind: "memory.delete.preview", requestId: rid(), projectId, expectedRevision: revision(),
    payload: { scope: { kind: "source", projectId, source: { ...source } } } }) as { preview: { id: string; blockers?: string[] } };
  expect(preview.preview.blockers ?? []).toEqual([]);
  f.app.execute(f.auth.actor, { kind: "memory.delete.confirm", requestId: rid(), projectId, expectedRevision: revision(),
    payload: { previewId: preview.preview.id, acknowledged: true, acknowledgedWholeSession: true } });
}

test("deleting origin content after promotion is honoured in the continuation; deleting Jit's text closes an open card", async () => {
  const f = await fixture();
  const g = general(f);
  const started = await chat(f, "จดรายจ่ายรายวัน");
  const secret = await say(f, g.projectId, started.topic.id, "รหัสบัญชีคือ ZX-4417");
  f.outputs.push(proposal("สมุดรายจ่าย"));
  const proposing = await say(f, g.projectId, started.topic.id, "ยกเป็นโครงการได้ไหม");
  const view = proposing.reply.promotionProposals[0]!;
  const { promotion } = f.app.execute(f.auth.actor, promote(f, "accept", view));
  const target = promotion!.target;
  let continued = f.app.promotion(f.auth.actor, target.projectId, target.topicId).continuedFrom!;
  expect(continued.origin.messages.map(m => m.text)).toContain("รหัสบัญชีคือ ZX-4417");

  // Delete the origin message in its own project: the continuation reads the origin live, so the text is gone there too.
  deleteSource(f, g.projectId, secret.message.source);
  continued = f.app.promotion(f.auth.actor, target.projectId, target.topicId).continuedFrom!;
  const deleted = continued.origin.messages.find(m => m.id === secret.message.id)!;
  expect(deleted).toMatchObject({ text: null, availability: "unavailable" });
  expect(continued).toMatchObject({ id: promotion!.id, origin: promotion!.origin, link: promotion!.link });
  const html = await (await get(f, topicPath(target.projectId, target.topicId))).text();
  expect(html).not.toContain("ZX-4417");
  expect(html).toContain(dictionaries.th["common.source_unavailable"]);
  const leaked = f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM source_versions WHERE content_text LIKE '%ZX-4417%'")!.n);
  expect(leaked).toBe(0);
  // Jit's later reply read that message as history, so the deletion purged it too (its lineage). The card it carried was
  // already accepted: the owner-accepted project and the link stay.
  expect(f.app.source(f.auth.actor, g.projectId, proposing.reply.source!)).toMatchObject({ state: "unavailable" });
  expect(card(f, view)).toMatchObject({ state: "accepted", promotion: { id: promotion!.id } });
  expect(f.app.project(f.auth.actor, target.projectId).name).toBe("สมุดรายจ่าย");
  expect(f.app.promotion(f.auth.actor, g.projectId, started.topic.id).promotedTo!.id).toBe(promotion!.id);

  // An open card whose Jit text is deleted closes, so a page rendered before the deletion cannot promote.
  f.outputs.push(proposal("ชื่อที่จะถูกลบ"));
  const other = await chat(f, "อีกหัวข้อ");
  const open = other.reply.promotionProposals[0]!;
  deleteSource(f, g.projectId, other.reply.source!);
  expect(card(f, open)).toMatchObject({ state: "superseded", closedByDeletion: true });
  expect(card(f, open).name).not.toContain("ชื่อที่จะถูกลบ");
  rejects(() => f.app.execute(f.auth.actor, promote(f, "accept", open)), "promotion_proposal_closed");
  expect(projectIds(f)).toHaveLength(2);
});

test("the General space cannot be deleted or change kind, and promotion never touches it", async () => {
  const f = await fixture();
  const g = general(f);
  // Promote a chat in the General space's own first topic: General stays exactly as it was.
  f.outputs.push(proposal("โครงการแรก"));
  const first = await say(f, g.projectId, g.topicId, "เริ่มคุยในหัวข้อแรก");
  const before = { space: general(f), project: f.app.project(f.auth.actor, g.projectId) };
  const { promotion } = f.app.execute(f.auth.actor, promote(f, "accept", first.reply.promotionProposals[0]!));
  expect(promotion!.target.projectId).not.toBe(g.projectId);
  expect(general(f)).toEqual(before.space);
  expect(f.app.project(f.auth.actor, g.projectId)).toMatchObject({ id: before.project.id, name: before.project.name, groupId: before.project.groupId });
  // Whatever path writes, the General space row and its project cannot be removed or re-pointed.
  for (const sql of ["DELETE FROM general_space", `DELETE FROM projects WHERE id = '${g.projectId}'`,
    `UPDATE general_space SET project_id = '${promotion!.target.projectId}'`, `UPDATE general_space SET topic_id = '${promotion!.target.topicId}'`]) {
    expect(() => f.store.transaction(tx => tx.run(sql))).toThrow("general_space_protected");
  }
  expect(general(f)).toEqual(before.space);
  // A promotion never targets its own project.
  expect(() => f.store.transaction(tx => tx.run("UPDATE topic_promotions SET project_id = origin_project_id"))).toThrow();
  // New chats from the home composer still land in the General space by default.
  const html = await (await get(f, "/")).text();
  expect(form(html, "/chats").projectId).toBe(g.projectId);
  // The new table is owner data in backups.
  expect(backupImageTables.topic_promotions).toBe("include");
});

test("home, card, read-only origin and continuation render in Thai and English with no raw keys and no script", async () => {
  for (const language of ["th", "en"] as const) {
    const f = await fixture(language);
    const g = general(f), d = dictionaries[language];
    f.outputs.push(proposal(language === "th" ? "โครงการใหม่" : "New project"));
    const started = await chat(f, language === "th" ? "เริ่มคุย" : "Let's talk");
    const view = started.reply.promotionProposals[0]!;
    const pages: string[] = [await (await get(f, "/")).text(), await (await get(f, topicPath(g.projectId, started.topic.id))).text()];
    expect(pages[0]).toContain(d["home.composer_note"]);
    expect(pages[1]).toContain(d["promotion.accept"]);
    const response = await postForm(f, promotionPath(view, "accept"), form(pages[1]!, promotionPath(view, "accept")));
    pages.push(await (await get(f, response.headers.get("location")!.split("#")[0]!)).text(), await (await get(f, topicPath(g.projectId, started.topic.id))).text());
    expect(pages[2]).toContain(d["promotion.continued_from"].replace("{project}", d["setup.general_name"]));
    expect(pages[3]).toContain(d["promotion.read_only"]);
    for (const html of pages) {
      expectNoInlineScript(html);
      expect(html).not.toMatch(/\b(?:home|promotion)\.[a-z_]+\b/);
      expect(html).not.toMatch(/\{(?:project|revision|count)\}/);
    }
    for (const q of queues.splice(0)) { q.close(); await q.idle(); }
    for (const s of stores.splice(0)) s.close();
  }
});

test("a discussion started before promotion cannot bring a specialist back into the read-only origin", async () => {
  const f = await fixture();
  const g = general(f);
  f.outputs.push(proposal("ทีมวิเคราะห์"));
  const started = await chat(f, "วิเคราะห์ฐานข้อมูลของแอปจดรายจ่าย");
  const discussion = f.app.execute(f.auth.actor, { kind: "team.dispatch", requestId: rid(), projectId: g.projectId, expectedRevision: f.app.project(f.auth.actor, g.projectId).revision,
    payload: { topicId: started.topic.id, purpose: "วิเคราะห์ฐานข้อมูล", sources: [started.topic.source], include: [f.tech], exclude: [], limits: { ...f.config.jobs.maximum } } }).discussion!;
  await settle(f);
  const view = reply(f, g.projectId, started.topic.id, started.message.id).promotionProposals[0]!;
  f.app.execute(f.auth.actor, promote(f, "accept", view));
  const before = f.app.conversation(f.auth.actor, g.projectId, started.topic.id).items.length;
  const control = (action: "exclude" | "include") => ({ kind: "team.control" as const, requestId: rid(), projectId: g.projectId,
    expectedRevision: f.app.discussion(f.auth.actor, g.projectId, discussion.id).discussion.revision, payload: { discussionId: discussion.id, action, roleId: f.tech } });
  // Controls that stop work stay available; starting a specialist again does not.
  f.app.execute(f.auth.actor, control("exclude"));
  rejects(() => f.app.execute(f.auth.actor, control("include")), "topic_promoted");
  await settle(f);
  expect(f.app.conversation(f.auth.actor, g.projectId, started.topic.id).items).toHaveLength(before);
});

test("deleting a chat's first message also deletes the topic title derived from it, in the origin and the continuation", async () => {
  const f = await fixture();
  const g = general(f);
  f.outputs.push(proposal("บัญชีบ้าน"));
  const started = await chat(f, "เลขบัญชีลับ ZX-4417 ใช้จ่ายค่าไฟ\nช่วยวางแผนหน่อย");
  expect(started.topic.title).toBe("เลขบัญชีลับ ZX-4417 ใช้จ่ายค่าไฟ");
  const view = reply(f, g.projectId, started.topic.id, started.message.id).promotionProposals[0]!;
  const { promotion } = f.app.execute(f.auth.actor, promote(f, "accept", view));
  expect(f.app.promotion(f.auth.actor, promotion!.target.projectId, promotion!.target.topicId).continuedFrom!.origin.topicTitle).toBe(started.topic.title);
  deleteSource(f, g.projectId, started.message.source);
  expect(f.app.source(f.auth.actor, g.projectId, started.topic.source)).toMatchObject({ state: "unavailable" });
  expect(f.app.topic(f.auth.actor, g.projectId, started.topic.id).topic.title).toBeNull();
  const origin = f.app.promotion(f.auth.actor, promotion!.target.projectId, promotion!.target.topicId).continuedFrom!.origin;
  expect(origin.topicTitle).toBeNull();
  expect(origin.messages[0]!.text).toBeNull();
  for (const path of ["/", topicPath(g.projectId, started.topic.id), topicPath(promotion!.target.projectId, promotion!.target.topicId)]) {
    expect(await (await get(f, path)).text()).not.toContain("ZX-4417");
  }
  const copies = f.store.read(tx => tx.get<{ n: number }>(`SELECT (SELECT count(*) FROM source_versions WHERE content_text LIKE '%ZX-4417%') +
    (SELECT count(*) FROM command_receipts WHERE result_json LIKE '%ZX-4417%') AS n`)!.n);
  expect(copies).toBe(0);
  // A title the owner typed in the project form is owner text with no such lineage.
  expect(f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM chat_title_sources WHERE topic_id = ?", g.topicId)!.n)).toBe(0);
});

for (const when of ["before", "after"] as const) test(`forgetting a chat's first message also suppresses its derived title (title extracted ${when} the forget)`, async () => {
  const f = await fixture();
  const g = general(f);
  f.outputs.push(proposal("New project"));
  const started = await chat(f, "ใช้ PostgreSQL สำหรับระบบบัญชีบ้าน\nโปรดจำไว้");
  const extract = (source: SourceReference) => f.app.execute(f.auth.actor, { kind: "memory.extract", requestId: rid(), projectId: g.projectId,
    expectedRevision: f.app.project(f.auth.actor, g.projectId).revision, payload: { topicId: started.topic.id, roleId: f.tech, source, dependencies: [], limits: { ...f.config.jobs.maximum } } });
  extract(started.message.source);
  await settle(f);
  const activeClaims = () => f.app.memory(f.auth.actor, g.projectId).items.flatMap(item => item.state === "available" ? [item.claim] : []);
  const claim = activeClaims().find(c => c.source.sourceId === started.message.source.sourceId)!;
  if (when === "before") { extract(started.topic.source); await settle(f); }
  const promotion = f.app.execute(f.auth.actor, promote(f, "accept", reply(f, g.projectId, started.topic.id, started.message.id).promotionProposals[0]!)).promotion!;
  f.app.execute(f.auth.actor, { kind: "memory.forget", requestId: rid(), projectId: g.projectId, expectedRevision: f.app.project(f.auth.actor, g.projectId).revision,
    payload: { claim: { claimId: claim.claimId, revision: claim.revision, generation: claim.generation }, reason: "Please forget", acknowledged: true } });
  rejects(() => extract(started.message.source), "memory_source_suppressed");
  // The derived title shares the forgotten lineage, so it cannot be extracted again either.
  if (when === "after") rejects(() => extract(started.topic.source), "memory_source_suppressed");
  expect(activeClaims()).toEqual([]);
  const discussion = f.app.execute(f.auth.actor, { kind: "team.dispatch", requestId: rid(), projectId: promotion.target.projectId,
    expectedRevision: f.app.project(f.auth.actor, promotion.target.projectId).revision, payload: { topicId: promotion.target.topicId, purpose: "ใช้ PostgreSQL สำหรับระบบบัญชีบ้าน",
      sources: [f.app.topic(f.auth.actor, promotion.target.projectId, promotion.target.topicId).topic.source], include: [f.tech], exclude: [], limits: { ...f.config.jobs.maximum } } }).discussion!;
  expect(discussion.manifest.claims).toHaveLength(0);
});

test("stopping, skipping or excluding a role on a promoted topic never admits the held team reply", async () => {
  const f = await fixture(), g = general(f);
  const second = f.app.execute(f.auth.actor, { kind: "role.save", requestId: rid(), projectId: null,
    expectedRevision: f.app.team(f.auth.actor).ownerRevision, payload: { roleId: null, name: "Second", kind: "specialist", responsibility: "Analyze", enabled: true, route: grok } }).role!.id;
  f.outputs.push({ reply: "Promote and review", proposals: [{kind: "promotion", name: "New project"}, {kind: "dispatch", roles: ["เทคโนโลยี", "Second"]}] });
  const started = await chat(f, "วิเคราะห์ฐานข้อมูล");
  const dispatch = [...f.app.dispatchCards(f.auth.actor, g.projectId, started.topic.id, [started.reply.replyMessageId!]).values()][0]!;
  const accepted = f.app.execute(f.auth.actor, { kind: "dispatch.proposal.accept", requestId: rid(), projectId: g.projectId, expectedRevision: dispatch.revision,
    payload: { proposalId: dispatch.id, roleIds: [f.tech, second] } });
  await settle(f);
  const discussionId = accepted.proposal.discussion!.id;
  const held = f.app.dispatchCard(f.auth.actor, g.projectId, dispatch.id);
  expect(held.teamReply).toBeNull();
  f.app.execute(f.auth.actor, promote(f, "accept", started.reply.promotionProposals[0]!));
  const before = count(f, "jit_replies");
  for (const action of ["exclude", "skip", "stop"] as const) {
    const revision = f.app.discussion(f.auth.actor, g.projectId, discussionId).discussion.revision;
    f.app.execute(f.auth.actor, { kind: "team.control", requestId: rid(), projectId: g.projectId, expectedRevision: revision, payload: { discussionId, action, roleId: second } });
  }
  await settle(f);
  expect(count(f, "jit_replies")).toBe(before);
});

test("promoting a topic resolves its dispatch card notice and closes the work group (REL04)", async () => {
  const f = await fixture();
  const projectId = general(f).projectId;
  f.app.execute(f.auth.actor, { kind: "dispatch.allowance.set", requestId: rid(), projectId,
    expectedRevision: f.app.dispatchAllowance(f.auth.actor, projectId).revision, payload: { enabled: false, maxRoles: 1 } });
  // One reply both asks to call a specialist (waiting on the owner's card) and suggests a promotion.
  f.outputs.push({ reply: "ขอเรียกทีมก่อนครับ", proposals: [{ kind: "dispatch", roles: ["เทคโนโลยี"] }, { kind: "promotion", name: "ฐานข้อมูลใหม่" }] });
  const started = await chat(f, "ช่วยวางแผนฐานข้อมูล");
  const dispatchCard = f.app.dispatchCards(f.auth.actor, projectId, started.topic.id, [started.reply.replyMessageId!]).get(started.reply.replyMessageId!)!;
  expect(dispatchCard).toMatchObject({ state: "proposed", reason: "allowance_disabled" });
  const notices = () => f.store.read(tx => tx.all<{ record_json: string }>("SELECT record_json FROM delivery_intents ORDER BY sequence"))
    .map(row => JSON.parse(row.record_json) as { status: string; failureReason: string | null; attention?: { item: string | null } });
  expect(notices()).toMatchObject([{ status: "waiting", attention: { item: `proposal:${dispatchCard.id}` } }]);
  f.app.execute(f.auth.actor, promote(f, "accept", started.reply.promotionProposals[0]!));
  expect(notices()).toMatchObject([{ status: "cancelled", failureReason: "owner_answered" }]);
  expect(f.store.read(tx => tx.get<{ state: string; record_json: string }>("SELECT state, record_json FROM work_groups"))).toMatchObject({ state: "closed" });
  expect(JSON.parse(f.store.read(tx => tx.get<{ record_json: string }>("SELECT record_json FROM work_groups")!.record_json)).closed).toBe("promoted");
});
