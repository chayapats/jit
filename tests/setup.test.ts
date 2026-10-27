import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Application } from "../src/application";
import { readConfig } from "../src/config";
import { dictionaries } from "../src/i18n";
import { JobQueue } from "../src/jobs/queue";
import { backupImageTables } from "../src/ops/backup";
import { setupCheckMarker, setupCheckWork, setupCheckWorkId, setupGreeting, type SetupCommand } from "../src/setup";
import { TransactionStore } from "../src/store";
import { jitReplyWork } from "../src/team/jit-reply";
import type { ApplicationRunPort } from "../src/team/run-port";
import { ScriptedRunPort, fixtureOutcome } from "../src/team/scripted-port";
import type { ApplicationRunOutcome, ApplicationRunRequest, RoleRoute } from "../src/team/types";
import { createWebHandler } from "../src/web";
import { assetUrl, lookupAsset } from "../src/web-assets";

const roots: string[] = [], stores: TransactionStore[] = [], queues: JobQueue[] = [];
afterEach(async () => {
  for (const q of queues.splice(0)) { q.close(); await q.idle(); }
  for (const s of stores.splice(0)) s.close();
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});
const password = "fixture-bot02-owner-password", epoch = 1_800_000_000_000, origin = "http://localhost:3000";
const grok: RoleRoute = { provider: "grok", model: "fixture-grok-exact", authRoute: "owner-grok" };
const codex: RoleRoute = { provider: "codex", model: "fixture-codex-exact", authRoute: "owner-codex" };
const rid = () => crypto.randomUUID();
type Script = (request: ApplicationRunRequest) => unknown;
const usage = { calls: 1, rounds: 1, hops: 1, contextTokens: 0, outputTokens: 0, retries: 0, wallMs: 0, tokensUnknown: false };
const answer = (request: ApplicationRunRequest, output: string): ApplicationRunOutcome => ({
  ...fixtureOutcome("complete", output), usage, session: { adapter: "scripted", id: request.runId, context: request.context } });
/** A live-host stand-in: the scripted fixture ledger, but outcomes in production mode (app.run_port/v1 `schway`). */
function productionPort(scripted: ScriptedRunPort, outcome: (request: ApplicationRunRequest) => ApplicationRunOutcome): ApplicationRunPort {
  return {
    adapter: "schway",
    invoke: async request => outcome(request),
    inspectRuns: after => scripted.inspectRuns(after), retire: context => scripted.retire(context), delete: context => scripted.delete(context),
  };
}
const production = (output: string | null, reason: ApplicationRunOutcome["reason"] = "complete"): ApplicationRunOutcome => ({
  state: reason === "complete" ? "complete" : "blocked", reason, mode: "production", output,
  usage: reason === "complete" ? { calls: 1, rounds: 1, hops: 0, contextTokens: 12, outputTokens: 1, retries: 0, wallMs: 5, tokensUnknown: false }
    : { calls: 0, rounds: 0, hops: 0, contextTokens: 0, outputTokens: 0, retries: 0, wallMs: 0, tokensUnknown: false },
  session: null,
});

interface Options { script?: Script; live?: (request: ApplicationRunRequest) => ApplicationRunOutcome; queue?: boolean; path?: string }
async function fixture(options: Options = {}) {
  const root = options.path ? join(options.path, "..") : mkdtempSync(join(tmpdir(), "jit-bot02-"));
  if (!options.path) roots.push(root);
  const path = options.path ?? join(root, "state.sqlite"), config = readConfig({ JIT_DATABASE: path }), store = new TransactionStore(path); stores.push(store);
  let now = epoch;
  const requests: ApplicationRunRequest[] = [];
  const scripted = new ScriptedRunPort(store, config.team, config.jobs.outputBytes, request => {
    requests.push(request);
    return options.script ? options.script(request) : answer(request, request.instructions.operator.includes(setupCheckMarker) ? "OK" : JSON.stringify({ reply: "สวัสดีครับ" }));
  });
  const port = options.live ? productionPort(scripted, request => { requests.push(request); return options.live!(request); }) : scripted;
  const queue = options.queue === false ? undefined : new JobQueue(store, config.jobs, [setupCheckWork(store, config, port, () => now), jitReplyWork(store, config, scripted, () => now)], { now: () => now });
  if (queue) queues.push(queue);
  const app = new Application(store, config, { now: () => now, ...(queue ? { jobs: queue } : {}) });
  const web = createWebHandler(app);
  if (!options.path) await app.setupOwner(password);
  const token = await app.login(password), auth = app.authenticate(token);
  return { root, path, config, store, app, queue, token, auth, web, requests, advance: (ms: number) => { now += ms; } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function settle(f: Fixture) { f.queue?.pump(); await f.queue?.idle(); }
async function reopen(f: Fixture, options: Omit<Options, "path"> = {}) {
  if (f.queue) { f.queue.close(); await f.queue.idle(); queues.splice(queues.indexOf(f.queue), 1); }
  f.store.close(); stores.splice(stores.indexOf(f.store), 1);
  return fixture({ ...options, path: f.path });
}

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
/** Hidden fields of the first form whose action matches. */
function form(html: string, action: string) {
  for (const match of html.matchAll(/<form\b[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/g)) {
    if (match[1] !== action) continue;
    const fields: Record<string, string> = {};
    for (const input of match[2]!.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) fields[input[1]!] = input[2]!;
    return fields;
  }
  throw new Error(`no form for ${action}`);
}
/** Submits one setup step exactly as a browser without script would: read the page, post its form. */
async function step(f: Fixture, action: string, fields: Record<string, string> = {}, page = "/setup") {
  const html = await (await get(f, page)).text();
  return postForm(f, `/setup/${action}`, { ...form(html, `/setup/${action}`), ...fields });
}
const routeFields = (route: RoleRoute) => ({ provider: route.provider, model: route.model, authRoute: route.authRoute });
const count = (f: Fixture, table: string) => f.store.read(tx => tx.get<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)!.n);
const command = (f: Fixture, kind: SetupCommand["kind"], payload: unknown, requestId = rid()) =>
  f.app.execute(f.auth.actor, { kind, requestId, projectId: null, expectedRevision: f.app.setup(f.auth.actor).revision, payload } as SetupCommand);
function expectNoInlineScript(html: string) {
  for (const [tag, body] of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
    expect(body).toBe("");
    expect(tag).toBe(`<script type="module" src="${assetUrl("app.js")}"></script>`);
  }
  expect(html).not.toMatch(/\son[a-z]+\s*=/i);
}
/** Runs the whole setup through public commands (no web), with the route check settled. */
async function completeSetup(f: Fixture, route: RoleRoute = grok) {
  command(f, "setup.wake", { language: "th" });
  command(f, "setup.connect", { route });
  await settle(f);
  command(f, "setup.connect.continue", {});
  command(f, "setup.know", { addressAs: "พี่บอส", selfReference: "จิต", language: "th", particle: "khrap" });
  command(f, "setup.personality.skip", {});
  return command(f, "setup.complete", {}).setup;
}

test("a new installation starts at setup, and a finished one never shows setup again", async () => {
  const f = await fixture();
  const home = await get(f, "/");
  expect(home.status).toBe(303);
  expect(home.headers.get("location")).toBe("/setup");
  // The JSON project list stays an API, not a redirect.
  expect((await get(f, "/api/projects")).status).toBe(200);
  const page = await get(f, "/setup");
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain('data-step="wake"');
  expect(html).toContain(dictionaries.th["setup.wake_title"]);
  expectNoInlineScript(html);
  expect(f.app.setup(f.auth.actor)).toMatchObject({ revision: 0, complete: false, step: "wake", general: null, connection: { status: "missing" } });

  await completeSetup(f);
  const after = await get(f, "/setup");
  expect(after.status).toBe(303);
  expect(after.headers.get("location")).toBe("/");
  expect((await get(f, "/")).status).toBe(200);
  // Every step refuses once setup is done; settings is where these values change.
  expect(() => command(f, "setup.wake", { language: "en" })).toThrow("setup_complete");
  const late = await postForm(f, "/setup/wake", { csrf: f.auth.csrf, requestId: rid(), expectedRevision: String(f.app.setup(f.auth.actor).revision), language: "en" });
  expect(late.headers.get("location")).toBe("/");
  const settings = await (await get(f, "/settings")).text();
  expect(settings).toContain('action="/settings/persona"');
  expect(settings).toContain('action="/settings/preferences"');
  expect((await (await get(f, "/settings/team")).text())).toContain(grok.model);
});

test("the whole setup works as plain form posts, ends in the General space and Jit greets first", async () => {
  const f = await fixture();
  // ตื่น: the toggle previews English without saving; the form saves the language shown.
  const preview = await get(f, "/setup?lang=en");
  expect(preview.headers.get("content-language")).toBe("en");
  expect(await preview.text()).toContain(dictionaries.en["setup.wake_title"]);
  expect(f.app.preferences(f.auth.actor).revision).toBe(0);
  let response = await step(f, "wake", {}, "/setup?lang=en");
  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe("/setup");
  expect(f.app.preferences(f.auth.actor).language).toBe("en");
  // เชื่อมจิต: save the route and start one check through the job queue.
  let html = await (await get(f, "/setup")).text();
  expect(html).toContain('data-step="connect"');
  expect(html).toContain(dictionaries.en["setup.connect_title"]);
  response = await step(f, "connect", routeFields(grok));
  expect(response.headers.get("location")).toBe("/setup?step=connect#connection");
  html = await (await get(f, "/setup?step=connect")).text();
  expect(html).toContain(dictionaries.en["setup.status.checking"]);
  await settle(f);
  html = await (await get(f, "/setup?step=connect")).text();
  // A scripted host answered: that is fixture evidence, never "verified".
  expect(html).toContain(dictionaries.en["setup.status.unverified"]);
  expect(html).toContain(dictionaries.en["setup.next.connect_live_host_then_check"]);
  expect(html).not.toContain(dictionaries.en["setup.status.verified"]);
  response = await step(f, "connect-continue", {}, "/setup?step=connect");
  expect(response.headers.get("location")).toBe("/setup");
  // รู้จักกัน: Jit's language defaults to the interface language chosen at wake.
  html = await (await get(f, "/setup")).text();
  expect(html).toContain('data-step="know"');
  expect(html).toMatch(/name="language" value="en" checked/);
  await step(f, "know", { addressAs: "Ton", selfReference: "", language: "en", particle: "none" });
  // นิสัยของจิต
  html = await (await get(f, "/setup")).text();
  expect(html).toContain('data-step="personality"');
  await step(f, "personality", { personality: "friendly", aboutMe: "Builds a personal app\r\non a Pi" });
  // ตั้งจิต
  html = await (await get(f, "/setup")).text();
  expect(html).toContain('data-step="ceremony"');
  expect(html).toContain("data-ceremony-form");
  expect(html).toContain(`data-ceremony-ms="1600"`);
  expectNoInlineScript(html);
  response = await step(f, "complete");
  const setup = f.app.setup(f.auth.actor);
  expect(setup.complete).toBe(true);
  const general = setup.general!;
  expect(response.headers.get("location")).toBe(`/projects/${general.projectId}/topics/${general.topicId}#message-${general.greetingMessageId}`);

  expect(f.app.persona(f.auth.actor)).toMatchObject({ addressAs: "Ton", language: "en", personality: "friendly", aboutMe: "Builds a personal app\non a Pi", revision: 2 });
  // One General space, and nothing else: no specialists, no other projects.
  expect(count(f, "general_space")).toBe(1);
  expect(f.app.workspace(f.auth.actor).projects.map(p => p.id)).toEqual([general.projectId]);
  expect(f.app.project(f.auth.actor, general.projectId).name).toBe("General");
  const roles = f.app.team(f.auth.actor).roles;
  expect(roles.map(role => [role.kind, role.name, role.route])).toEqual([["coordinator", "Jit", null]]);
  expect(f.app.team(f.auth.actor).ownerDefault).toEqual(grok);
  expect(f.app.generalSpace(f.auth.actor)).toEqual(general);
  // Jit's greeting is the first message of the General topic, in the persona's voice and language.
  const conversation = f.app.conversation(f.auth.actor, general.projectId, general.topicId);
  expect(conversation.topic.title).toBe("First chat with Jit");
  expect(conversation.items.map(m => [m.id, m.attribution, m.text])).toEqual([[general.greetingMessageId, { kind: "service", service: "jit-setup" },
    "Hi Ton, Jit is ready. Anything that does not belong to a project yet can start right here in General."]]);
  html = await (await get(f, `/projects/${general.projectId}/topics/${general.topicId}`)).text();
  expect(html).toMatch(new RegExp(`id="message-${general.greetingMessageId}" class="message message--jit"`));
  expect(html).toContain(dictionaries.en["setup.greeting_label"]);
  // Jit answers the owner in the General space with the coordinator setup created.
  const topic = f.app.conversation(f.auth.actor, general.projectId, general.topicId).topic;
  const sent = f.app.execute(f.auth.actor, { kind: "message.send", projectId: general.projectId, requestId: rid(), expectedRevision: topic.revision, payload: { topicId: general.topicId, text: "hello" } });
  await settle(f);
  expect(f.app.replies(f.auth.actor, general.projectId, general.topicId, [sent.message.id]).get(sent.message.id)!.state).toBe("answered");
});

test("Thai greeting uses the address, self-reference and polite particle the owner chose", () => {
  const base = { addressAs: "พี่บอส", language: "th" as const, selfReference: "", particle: "khrap" as const, personality: "calm" as const, aboutMe: "", revision: 1, updatedAt: 1 };
  expect(setupGreeting(base)).toBe("สวัสดีครับ พี่บอส จิตพร้อมแล้ว เรื่องที่ยังไม่อยู่ในโครงการไหน คุยกันตรงนี้ในพื้นที่ทั่วไปได้เลยครับ");
  expect(setupGreeting({ ...base, addressAs: "", selfReference: "น้องจิต", particle: "none" })).toBe("สวัสดี น้องจิตพร้อมแล้ว เรื่องที่ยังไม่อยู่ในโครงการไหน คุยกันตรงนี้ในพื้นที่ทั่วไปได้เลย");
  expect(setupGreeting({ ...base, language: "en", addressAs: "", particle: "kha" })).toBe("Hi, Jit is ready. Anything that does not belong to a project yet can start right here in General.");
});

test("restart in the middle of every step resumes without a second persona, route, coordinator or General space", async () => {
  let f = await fixture();
  command(f, "setup.wake", { language: "th" });
  command(f, "setup.connect", { route: grok });
  // Restart before the check ran: the check job is still queued and resumes on the next service start.
  f = await reopen(f);
  expect(f.app.setup(f.auth.actor)).toMatchObject({ step: "connect", connection: { status: "checking" } });
  // Submitting the same route again does not add a route revision, a coordinator or a second check job.
  const ownerRevision = f.app.team(f.auth.actor).ownerRevision;
  command(f, "setup.connect", { route: grok });
  expect(f.app.team(f.auth.actor).ownerRevision).toBe(ownerRevision);
  expect(count(f, "jobs")).toBe(1);
  await settle(f);
  expect(f.app.setup(f.auth.actor).connection.status).toBe("unverified");
  command(f, "setup.connect.continue", {});
  command(f, "setup.know", { addressAs: "พี่บอส", selfReference: "จิต", language: "th", particle: "khrap" });
  f = await reopen(f);
  // The same answers again (a refresh resubmitting with a new request id) write no new persona revision.
  command(f, "setup.know", { addressAs: "พี่บอส ", selfReference: "จิต", language: "th", particle: "khrap" });
  expect(f.app.persona(f.auth.actor).revision).toBe(1);
  command(f, "setup.personality", { personality: "direct", aboutMe: "" });
  expect(f.app.persona(f.auth.actor).revision).toBe(2);

  // A crash inside the ceremony transaction leaves nothing behind.
  const crash = { fail: true };
  const crashing = new Application(f.store, f.config, { jobs: f.queue!, beforeCommit: stage => { if (stage === "setup" && crash.fail) throw new Error("crash"); } });
  const actor = crashing.authenticate(f.token).actor;
  const revision = crashing.setup(actor).revision, requestId = rid();
  expect(() => crashing.execute(actor, { kind: "setup.complete", requestId, projectId: null, expectedRevision: revision, payload: {} })).toThrow("crash");
  f = await reopen(f);
  expect(f.app.setup(f.auth.actor)).toMatchObject({ complete: false, step: "ceremony", revision });
  expect(count(f, "messages")).toBe(0);
  // The same form submitted again after the restart completes once; a duplicate replays the receipt.
  const done = f.app.execute(f.auth.actor, { kind: "setup.complete", requestId, projectId: null, expectedRevision: revision, payload: {} });
  const replay = f.app.execute(f.auth.actor, { kind: "setup.complete", requestId, projectId: null, expectedRevision: revision, payload: {} });
  expect(replay).toEqual(done);
  f = await reopen(f);
  expect(f.app.setup(f.auth.actor)).toMatchObject({ complete: true, general: done.setup.general });
  for (const [table, n] of [["general_space", 1], ["projects", 1], ["topics", 1], ["messages", 1], ["roles", 1], ["persona_revisions", 2], ["setup_state", 1], ["jobs", 1]] as const) {
    expect([table, count(f, table)]).toEqual([table, n]);
  }
  expect(f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM team_state WHERE route_json IS NOT NULL")!.n)).toBe(1);
});

test("a stale or replayed setup form resumes at the current step instead of failing", async () => {
  const f = await fixture();
  const html = await (await get(f, "/setup")).text();
  const fields = { ...form(html, "/setup/wake"), language: "th" };
  expect((await postForm(f, "/setup/wake", fields)).headers.get("location")).toBe("/setup");
  // The same form again (double click, refresh after post) replays its receipt.
  expect((await postForm(f, "/setup/wake", fields)).headers.get("location")).toBe("/setup");
  // An older tab with a new request id but the old revision goes back to the current step.
  const stale = await postForm(f, "/setup/wake", { ...fields, requestId: rid() });
  expect(stale.status).toBe(303);
  expect(stale.headers.get("location")).toBe("/setup");
  expect(f.app.setup(f.auth.actor)).toMatchObject({ revision: 1, step: "connect" });
  // The JSON boundary reports the same conflict as a code.
  const conflict = await postJson(f, "/api/setup/wake", { requestId: rid(), expectedRevision: 0, language: "th" });
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toEqual({ error: "stale_revision" });
});

test("steps keep their order, reject malformed input, and the JSON boundary needs CSRF", async () => {
  const f = await fixture();
  expect(() => command(f, "setup.know", { addressAs: "", selfReference: "", language: "th", particle: "none" })).toThrow("setup_step_unavailable");
  expect(() => command(f, "setup.connect", { route: grok })).toThrow("setup_step_unavailable");
  expect(() => command(f, "setup.wake", { language: "fr" })).toThrow("invalid_setup_command");
  expect(() => command(f, "setup.wake", { language: "th", extra: true })).toThrow("invalid_setup_command");
  command(f, "setup.wake", { language: "th" });
  expect(() => command(f, "setup.connect.continue", {})).toThrow("setup_route_required");
  expect(() => command(f, "setup.connect", { route: { ...grok, authRoute: "Bad Route" } })).toThrow("invalid_setup_command");
  expect(() => command(f, "setup.connect", { route: null })).toThrow("invalid_setup_command");
  expect(() => command(f, "setup.complete", {})).toThrow("setup_step_unavailable");
  // Persona fields use the app.persona/v1 rules: one line, bounded.
  command(f, "setup.connect", { route: grok }); command(f, "setup.connect.continue", {});
  expect(() => command(f, "setup.know", { addressAs: "a\nb", selfReference: "", language: "th", particle: "none" })).toThrow("invalid_persona");
  expect(() => command(f, "setup.know", { addressAs: "x".repeat(61), selfReference: "", language: "th", particle: "none" })).toThrow("invalid_persona");
  expect(() => command(f, "setup.personality", { personality: "calm", aboutMe: "" })).toThrow("setup_step_unavailable");
  const requestId = rid();
  command(f, "setup.know", { addressAs: "", selfReference: "", language: "th", particle: "none" }, requestId);
  // A reused request id with a different payload conflicts.
  expect(() => command(f, "setup.personality.skip", {}, requestId)).toThrow("request_id_conflict");
  // JSON: CSRF header, origin and exact fields.
  const revision = f.app.setup(f.auth.actor).revision;
  expect((await postJson(f, "/api/setup/personality-skip", { requestId: rid(), expectedRevision: revision }, null)).status).toBe(403);
  expect((await postJson(f, "/api/setup/personality-skip", { requestId: rid(), expectedRevision: revision, skip: true })).status).toBe(400);
  const skipped = await postJson(f, "/api/setup/personality-skip", { requestId: rid(), expectedRevision: revision });
  expect(await skipped.json()).toMatchObject({ setup: { step: "ceremony", personalitySkipped: true, done: { personality: true } } });
  expect(await (await get(f, "/api/setup")).json()).toMatchObject({ step: "ceremony", complete: false });
  const crossSite = await f.web(new Request(`${origin}/setup/complete`, { method: "POST", body: "", headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example", cookie: `jit_session=${f.token}` } }));
  expect(crossSite.status).toBe(403);
  expect(f.app.setup(f.auth.actor).complete).toBe(false);
});

test("the connect step reports configured, unverified and blocked from the scripted host's real outcome", async () => {
  const outcomes: RunReasonScript[] = [];
  type RunReasonScript = ApplicationRunOutcome["reason"];
  const f = await fixture({ script: request => {
    const reason = outcomes.shift() ?? "complete";
    return reason === "complete" ? answer(request, "OK") : fixtureOutcome(reason);
  } });
  command(f, "setup.wake", { language: "th" });
  for (const [reason, next] of [["needs_login", "sign_in_then_check"], ["quota", "wait_for_quota_then_check"], ["route_unavailable", "check_route_then_check"], ["unknown_model", "fix_model_then_check"]] as const) {
    outcomes.push(reason);
    command(f, f.app.setup(f.auth.actor).connection.route ? "setup.check" : "setup.connect", f.app.setup(f.auth.actor).connection.route ? {} : { route: grok });
    await settle(f);
    expect(f.app.setup(f.auth.actor).connection).toMatchObject({ status: "blocked", reason, nextAction: next, mode: "fixture", route: grok });
    const html = await (await get(f, "/setup?step=connect")).text();
    expect(html).toContain(dictionaries.th["setup.status.blocked"]);
    expect(html).toContain(dictionaries.th[`setup.next.${next}`]);
    // Blocked is a result, not a wait: the check job ends and never retries on its own.
    const job = f.app.job(f.auth.actor, f.app.setup(f.auth.actor).connection.check!.projectId!, f.app.setup(f.auth.actor).connection.check!.jobId!);
    expect(job.state).toBe("partial");
  }
  // An inconclusive outcome stays unverified with a plain "check again".
  outcomes.push("invalid_result");
  command(f, "setup.check", {});
  await settle(f);
  expect(f.app.setup(f.auth.actor).connection).toMatchObject({ status: "unverified", nextAction: "check_again" });
  // A route changed elsewhere (settings) is only configured until it is checked again.
  const team = f.app.team(f.auth.actor);
  f.app.execute(f.auth.actor, { kind: "route.save", requestId: rid(), projectId: null, expectedRevision: team.ownerRevision, payload: { roleId: null, route: codex } });
  expect(f.app.setup(f.auth.actor).connection).toMatchObject({ status: "configured", route: codex, nextAction: "check_route", check: null });
  const html = await (await get(f, "/setup?step=connect")).text();
  expect(html).toContain(dictionaries.th["setup.status.configured"]);
  // Every check used the exact route, the fixed prompt, an empty manifest and no tools.
  const checks = f.requests.filter(request => request.instructions.operator.includes(setupCheckMarker));
  expect(checks).toHaveLength(5);
  for (const request of checks) {
    expect(request).toMatchObject({ route: grok, tools: [], manifest: { sources: [], claims: [] }, instructions: { operator: [setupCheckMarker] } });
    expect(request.limits.retries).toBe(1);
  }
});

test("only a completed production call verifies the route; finding configuration is never evidence", async () => {
  const live: ApplicationRunOutcome[] = [production(null, "needs_login"), production("OK")];
  const f = await fixture({ live: () => live.shift()! });
  command(f, "setup.wake", { language: "en" });
  command(f, "setup.connect", { route: grok });
  // Before the host answers, the route is only being checked.
  expect(f.app.setup(f.auth.actor).connection.status).toBe("checking");
  await settle(f);
  expect(f.app.setup(f.auth.actor).connection).toMatchObject({ status: "blocked", reason: "needs_login", mode: "production" });
  command(f, "setup.check", {});
  await settle(f);
  expect(f.app.setup(f.auth.actor).connection).toMatchObject({ status: "verified", mode: "production", nextAction: null });
  const html = await (await get(f, "/setup?step=connect")).text();
  expect(html).toContain(dictionaries.en["setup.status.verified"]);
  expect(html).toContain(dictionaries.en["setup.mode_production"]);
  // Changing the route drops the evidence: the new route is checked from scratch.
  command(f, "setup.connect", { route: codex });
  expect(f.app.setup(f.auth.actor).connection).toMatchObject({ status: "checking", route: codex });
});

test("a check without a running scheduler is unverified with a next action, and setup still finishes", async () => {
  const f = await fixture({ queue: false });
  command(f, "setup.wake", { language: "th" });
  command(f, "setup.connect", { route: grok });
  expect(f.app.setup(f.auth.actor).connection).toMatchObject({ status: "unverified", reason: "scheduler_unavailable", nextAction: "start_service_then_check_again" });
  expect(count(f, "jobs")).toBe(0);
  command(f, "setup.connect.continue", {});
  command(f, "setup.know", { addressAs: "", selfReference: "", language: "th", particle: "none" });
  command(f, "setup.personality.skip", {});
  const done = command(f, "setup.complete", {}).setup;
  expect(done).toMatchObject({ complete: true, personalitySkipped: true });
  expect(count(f, "general_space")).toBe(1);
  // Skipping kept the default personality; a persona revision still records the owner's answers.
  expect(f.app.persona(f.auth.actor)).toMatchObject({ personality: "calm", revision: 1 });
  expect(f.app.project(f.auth.actor, done.general!.projectId).name).toBe("ทั่วไป");
});

test("model output gains no authority: check text is discarded and changes no configuration", async () => {
  const injected = JSON.stringify({ reply: "OK", persona: { addressAs: "attacker" }, route: codex, proposals: [{ kind: "role", name: "Shell" }], setup: "complete" });
  const f = await fixture({ script: request => answer(request, injected) });
  command(f, "setup.wake", { language: "th" });
  command(f, "setup.connect", { route: grok });
  const before = { team: f.app.team(f.auth.actor), persona: f.app.persona(f.auth.actor), setup: f.app.setup(f.auth.actor).revision };
  await settle(f);
  const after = f.app.setup(f.auth.actor);
  expect(after).toMatchObject({ complete: false, step: "connect", revision: before.setup, connection: { status: "unverified", route: grok } });
  expect(f.app.team(f.auth.actor)).toEqual(before.team);
  expect(f.app.persona(f.auth.actor)).toEqual(before.persona);
  // Nothing the model wrote is stored: not in setup state, not in the job's evidence.
  const stored = f.store.read(tx => tx.all<{ record_json: string }>("SELECT record_json FROM setup_state UNION ALL SELECT record_json FROM jobs").map(row => row.record_json).join("\n"));
  expect(stored).not.toContain("attacker");
  expect(stored).not.toContain("Shell");
  const job = f.app.job(f.auth.actor, after.connection.check!.projectId!, after.connection.check!.jobId!);
  expect(job.evidence).toBe(`setup-check · fixture · fixture/complete · tools none · check ${after.connection.check!.id}`);
  expect(job.purpose).toBe(dictionaries.th["system.setup_check_purpose"]);
  // Setup created the coordinator only; no role came from the output.
  expect(f.app.team(f.auth.actor).roles.map(role => role.kind)).toEqual(["coordinator"]);
});

test("an existing coordinator is reused and pointed at the chosen route; an older check is fenced", async () => {
  const gate = Promise.withResolvers<void>();
  let first = true;
  const f = await fixture({ script: async request => { if (first) { first = false; await gate.promise; } return answer(request, "OK"); } });
  const coordinator = f.app.execute(f.auth.actor, { kind: "role.save", projectId: null, requestId: rid(), expectedRevision: 0,
    payload: { roleId: null, name: "ผู้ประสาน", kind: "coordinator", responsibility: "ประสานทีม", enabled: true, route: codex } }).role!;
  command(f, "setup.wake", { language: "th" });
  command(f, "setup.connect", { route: codex });
  f.queue!.pump(); await Bun.sleep(5);
  const old = f.app.setup(f.auth.actor).connection.check!;
  // A different route while the first check is still running: Jit's own route follows, the first job is stopped.
  command(f, "setup.connect", { route: grok });
  gate.resolve();
  // The stopped job holds admission until its adapter settles; the newer check is admitted after it.
  await settle(f); await settle(f);
  const roles = f.app.team(f.auth.actor).roles;
  expect(roles.map(role => [role.id, role.name, role.route])).toEqual([[coordinator.id, "ผู้ประสาน", grok]]);
  // Only Jit's own role changed: the owner default other roles inherit is untouched.
  expect(f.app.team(f.auth.actor).ownerDefault).toBeNull();
  const now = f.app.setup(f.auth.actor).connection;
  expect(now).toMatchObject({ status: "unverified", route: grok, roleId: coordinator.id });
  expect(now.check!.id).not.toBe(old.id);
  expect(f.app.job(f.auth.actor, old.projectId!, old.jobId!)).toMatchObject({ state: "blocked", reason: "cancelled" });
});

test("ceremony runs only with script, respects reduced motion, and never needs script to submit", async () => {
  const f = await fixture();
  command(f, "setup.wake", { language: "th" }); command(f, "setup.connect", { route: grok }); await settle(f);
  command(f, "setup.connect.continue", {}); command(f, "setup.know", { addressAs: "", selfReference: "", language: "th", particle: "none" }); command(f, "setup.personality.skip", {});
  const html = await (await get(f, "/setup")).text();
  expect(html).toMatch(/<div class="setup-hero ceremony" data-ceremony="ready" data-ceremony-ms="1600">/);
  expect(html).toContain('class="jit-halo"');
  expect(html).toMatch(/<form method="post" action="\/setup\/complete" data-ceremony-form>/);
  const css = new TextDecoder().decode(lookupAsset(assetUrl("app.css"))!.body);
  expect(css).toContain("--motion-ceremony: 1600ms");
  expect(css).toContain('.ceremony[data-ceremony="playing"] .jit-halo { animation: ceremony-halo');
  expect(css).toMatch(/prefers-reduced-motion: reduce[\s\S]*animation: none !important/);

  // Script contract: a fake DOM, a fake timer and the reduced-motion preference.
  const run = async (reduced: boolean) => {
    let submitted = 0, prevented = false, handler: ((event: { preventDefault(): void }) => void) | null = null;
    const timers: { fn: () => void; ms: number }[] = [];
    const button = { attributes: {} as Record<string, string>, setAttribute(name: string, value: string) { this.attributes[name] = value; } };
    const ceremony = { dataset: { ceremony: "ready", ceremonyMs: "1600" } as Record<string, string> };
    const formNode = { addEventListener: (type: string, fn: typeof handler) => { if (type === "submit") handler = fn; }, submit: () => { submitted++; }, querySelector: () => button };
    const globals: Record<string, unknown> = {
      document: { documentElement: { dataset: {} }, querySelector: (s: string) => s === "[data-ceremony]" ? ceremony : s === "form[data-ceremony-form]" ? formNode : null,
        querySelectorAll: () => [], getElementById: () => null, addEventListener: () => {} },
      window: { addEventListener: () => {}, matchMedia: (query: string) => ({ matches: reduced && query === "(prefers-reduced-motion: reduce)" }), setTimeout: (fn: () => void, ms: number) => { timers.push({ fn, ms }); return 1; } },
      location: { hash: "", pathname: "/setup", search: "" }, history: { replaceState: () => {} }, CSS: { supports: () => true },
    };
    const saved = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    try {
      await import(`../src/web-assets/app.js?case=${crypto.randomUUID()}`);
      handler!({ preventDefault: () => { prevented = true; } });
      return { prevented, state: ceremony.dataset.ceremony, timers, submitted: () => submitted, button };
    } finally {
      for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as Record<string, unknown>)[key]; }
    }
  };
  const animated = await run(false);
  expect(animated).toMatchObject({ prevented: true, state: "playing" });
  expect(animated.timers.map(t => t.ms)).toEqual([1600]);
  expect(animated.submitted()).toBe(0);
  animated.timers[0]!.fn();
  expect(animated.submitted()).toBe(1);
  expect(animated.button.attributes["aria-disabled"]).toBe("true");
  const reduced = await run(true);
  expect(reduced).toMatchObject({ prevented: false, state: "ready", timers: [] });

  // Without script the same form posts directly and setup completes.
  const response = await step(f, "complete");
  expect(response.status).toBe(303);
  expect(f.app.setup(f.auth.actor).complete).toBe(true);
});

test("every setup step renders in Thai and English, dark and light, with no raw keys and without the word อธิษฐาน", async () => {
  const f = await fixture();
  const pages = async () => {
    const out: string[] = [];
    for (const language of ["th", "en"] as const) {
      for (const theme of ["dark", "light"] as const) {
        f.app.execute(f.auth.actor, { kind: "ui.preferences.set", requestId: rid(), projectId: null, expectedRevision: f.app.preferences(f.auth.actor).revision, payload: { theme, language } });
        const html = await (await get(f, "/setup?step=" + f.app.setup(f.auth.actor).step)).text();
        expect(html).toContain(`<html lang="${language}" data-theme="${theme}">`);
        expect(html).not.toMatch(/\bsetup\.[a-z_.]+\b/);
        expectNoInlineScript(html);
        out.push(html);
      }
    }
    return out;
  };
  const all: string[] = [];
  all.push(...await pages());
  command(f, "setup.wake", { language: "th" }); all.push(...await pages());
  command(f, "setup.connect", { route: grok }); all.push(...await pages());
  await settle(f); command(f, "setup.connect.continue", {}); all.push(...await pages());
  command(f, "setup.know", { addressAs: "", selfReference: "", language: "th", particle: "none" }); all.push(...await pages());
  command(f, "setup.personality.skip", {}); all.push(...await pages());
  expect(all).toHaveLength(24);
  for (const html of all) expect(html).not.toContain("อธิษฐาน");
  for (const dictionary of Object.values(dictionaries)) expect(Object.values(dictionary).join("\n")).not.toContain("อธิษฐาน");
  // Both languages define every setup key, including each route state and next action.
  const keys = Object.keys(dictionaries.th).filter(key => key.startsWith("setup."));
  expect(keys.length).toBeGreaterThan(60);
  for (const key of keys) expect(dictionaries.en[key as keyof typeof dictionaries.en]).toBeTruthy();
});

test("setup tables are owner configuration in backups and the check worker is registered with the team port", async () => {
  expect(backupImageTables.setup_state).toBe("include");
  expect(backupImageTables.general_space).toBe("include");
  const { composeJobQueue } = await import("../src/composition");
  const root = mkdtempSync(join(tmpdir(), "jit-bot02-compose-")); roots.push(root);
  const path = join(root, "state.sqlite"), config = readConfig({ JIT_DATABASE: path }), store = new TransactionStore(path); stores.push(store);
  const { queue } = composeJobQueue(store, config); queues.push(queue);
  expect(queue.registered(setupCheckWorkId)).toBe(true);
});

test("the General space takes no project command from any ingress until the ceremony, so the greeting is always first", async () => {
  const f = await fixture();
  command(f, "setup.wake", { language: "th" });
  command(f, "setup.connect", { route: grok });
  await settle(f);
  const general = f.app.generalSpace(f.auth.actor)!;
  const topic = f.app.conversation(f.auth.actor, general.projectId, general.topicId).topic;
  // Reachable from the check-job link, but every write is refused until setup is complete.
  expect(() => f.app.execute(f.auth.actor, { kind: "message.send", projectId: general.projectId, requestId: rid(), expectedRevision: topic.revision, payload: { topicId: general.topicId, text: "ก่อนตั้งจิต" } })).toThrow("setup_incomplete");
  expect(() => f.app.execute(f.auth.actor, { kind: "topic.create", projectId: general.projectId, requestId: rid(), expectedRevision: f.app.project(f.auth.actor, general.projectId).revision, payload: { title: "อีกหัวข้อ" } })).toThrow("setup_incomplete");
  const web = await postForm(f, `/projects/${general.projectId}/topics/${general.topicId}/messages`, { csrf: f.auth.csrf, requestId: rid(), expectedRevision: String(topic.revision), text: "จากฟอร์ม" });
  expect(web.status).toBe(409);
  expect(await web.text()).toContain(dictionaries.th["error.setup_incomplete"]);
  const api = await postJson(f, "/api/projects", { requestId: rid(), expectedRevision: f.app.workspace(f.auth.actor).revision, name: "อื่น" });
  // Other projects are unaffected.
  expect(api.status).toBe(200);
  expect(count(f, "messages")).toBe(0);
  command(f, "setup.connect.continue", {}); command(f, "setup.know", { addressAs: "", selfReference: "", language: "th", particle: "none" }); command(f, "setup.personality.skip", {});
  command(f, "setup.complete", {});
  f.app.execute(f.auth.actor, { kind: "message.send", projectId: general.projectId, requestId: rid(), expectedRevision: topic.revision, payload: { topicId: general.topicId, text: "หลังตั้งจิต" } });
  const items = f.app.conversation(f.auth.actor, general.projectId, general.topicId).items;
  expect(items.map(m => [m.sequence, m.attribution.kind])).toEqual([[1, "service"], [2, "owner"]]);
});

test("setup resolves Jit exactly as replies do: no coordinator, a disabled one, or an unrouted first coordinator", async () => {
  // An owner default without any coordinator cannot answer, so it is not a connection.
  const f = await fixture();
  f.app.execute(f.auth.actor, { kind: "route.save", requestId: rid(), projectId: null, expectedRevision: 0, payload: { roleId: null, route: grok } });
  const disabled = f.app.execute(f.auth.actor, { kind: "role.save", projectId: null, requestId: rid(), expectedRevision: f.app.team(f.auth.actor).ownerRevision,
    payload: { roleId: null, name: "ปิดอยู่", kind: "coordinator", responsibility: "ไม่ใช้", enabled: false, route: codex } }).role!;
  command(f, "setup.wake", { language: "th" });
  expect(f.app.setup(f.auth.actor).connection).toMatchObject({ status: "missing", route: null, roleId: null });
  expect(() => command(f, "setup.connect.continue", {})).toThrow("setup_route_required");
  command(f, "setup.connect", { route: grok });
  const roles = f.app.team(f.auth.actor).roles;
  expect(roles.map(role => [role.id === disabled.id, role.kind, role.enabled])).toEqual([[true, "coordinator", false], [false, "coordinator", true]]);
  expect(f.app.setup(f.auth.actor).connection).toMatchObject({ status: "checking", route: grok, roleId: roles[1]!.id });

  // The first enabled coordinator has no route and the second does: Jit (and setup) is the second one.
  const g = await fixture();
  const first = g.app.execute(g.auth.actor, { kind: "role.save", projectId: null, requestId: rid(), expectedRevision: 0,
    payload: { roleId: null, name: "First without route", kind: "coordinator", responsibility: "a", enabled: true, route: null } }).role!;
  const second = g.app.execute(g.auth.actor, { kind: "role.save", projectId: null, requestId: rid(), expectedRevision: 1,
    payload: { roleId: null, name: "Second with route", kind: "coordinator", responsibility: "b", enabled: true, route: codex } }).role!;
  command(g, "setup.wake", { language: "en" });
  expect(g.app.setup(g.auth.actor).connection).toMatchObject({ status: "configured", route: codex, roleId: second.id });
  command(g, "setup.connect", { route: grok });
  await settle(g);
  expect(g.app.team(g.auth.actor).roles.map(role => [role.id, role.route])).toEqual([[first.id, null], [second.id, grok]]);
  expect(g.app.setup(g.auth.actor).connection).toMatchObject({ status: "unverified", route: grok, roleId: second.id });
  expect(g.requests.filter(r => r.instructions.operator.includes(setupCheckMarker)).map(r => [r.roleId, r.route])).toEqual([[second.id, grok]]);
});

test("connect writes the layer that wins for Jit in the General space, so the check tests the submitted route", async () => {
  for (const layer of ["project_default", "project_role"] as const) {
    const f = await fixture();
    command(f, "setup.wake", { language: "th" });
    command(f, "setup.connect", { route: grok });
    await settle(f);
    const general = f.app.generalSpace(f.auth.actor)!, jitId = f.app.setup(f.auth.actor).connection.roleId!;
    // Settings cannot set a General-only route while setup is open (the General space takes no project command yet)…
    expect(() => f.app.execute(f.auth.actor, { kind: "route.save", requestId: rid(), projectId: general.projectId, expectedRevision: f.app.team(f.auth.actor, general.projectId).projectRevision,
      payload: { roleId: layer === "project_role" ? jitId : null, route: codex } })).toThrow("setup_incomplete");
    // …but a restored image can carry one; setup still writes the layer that wins.
    f.store.transaction(tx => tx.run("INSERT OR REPLACE INTO project_team VALUES (?, 1, ?, ?)", general.projectId,
      layer === "project_default" ? JSON.stringify(codex) : null, JSON.stringify(layer === "project_role" ? { [jitId]: codex } : {})));
    expect(f.app.setup(f.auth.actor).connection).toMatchObject({ status: "configured", route: codex });
    command(f, "setup.connect", { route: { ...grok, model: "fixture-grok-next" } });
    await settle(f);
    const team = f.app.team(f.auth.actor, general.projectId);
    expect([layer, team.roles.find(role => role.id === jitId)!.effective]).toMatchObject([layer, { layer, route: { ...grok, model: "fixture-grok-next" } }]);
    expect(f.app.setup(f.auth.actor).connection).toMatchObject({ status: "unverified", route: { ...grok, model: "fixture-grok-next" } });
    expect(f.requests.filter(r => r.instructions.operator.includes(setupCheckMarker)).at(-1)!.route).toEqual({ ...grok, model: "fixture-grok-next" });
  }
});

test("a check left waiting after a restart is unverified, and checking again replaces it at once", async () => {
  const f = await fixture();
  command(f, "setup.wake", { language: "th" });
  command(f, "setup.connect", { route: grok });
  const old = f.app.setup(f.auth.actor).connection.check!;
  // What restart reconciliation leaves for a call that was in flight: the job waits, interrupted, and is never resumed alone.
  f.store.transaction(tx => {
    const row = tx.get<{ record_json: string }>("SELECT record_json FROM jobs WHERE id = ?", old.jobId!)!;
    tx.run("UPDATE jobs SET state = 'waiting', record_json = ? WHERE id = ?", JSON.stringify({ ...JSON.parse(row.record_json), state: "waiting", reason: "interrupted" }), old.jobId!);
  });
  expect(f.app.setup(f.auth.actor).connection).toMatchObject({ status: "unverified", reason: "interrupted", nextAction: "check_again" });
  command(f, "setup.check", {});
  const fresh = f.app.setup(f.auth.actor).connection;
  expect(fresh.status).toBe("checking");
  expect(fresh.check!.jobId).not.toBe(old.jobId);
  expect(f.app.job(f.auth.actor, old.projectId!, old.jobId!)).toMatchObject({ state: "blocked", reason: "cancelled" });
  await settle(f);
  expect(f.app.setup(f.auth.actor).connection).toMatchObject({ status: "unverified", nextAction: "connect_live_host_then_check" });
});

test("the greeting inserts owner text literally: no replacement sequences or nested placeholders", () => {
  const base = { addressAs: "", language: "en" as const, selfReference: "", particle: "none" as const, personality: "calm" as const, aboutMe: "", revision: 1, updatedAt: 1 };
  const rest = "is ready. Anything that does not belong to a project yet can start right here in General.";
  for (const [addressAs, selfReference, expected] of [
    ["Bill $& Ted", "", `Hi Bill $& Ted, Jit ${rest}`],
    ["$` $' $$ $1", "", `Hi $\` $' $$ $1, Jit ${rest}`],
    ["Owner {self}", "Self {p}", `Hi Owner {self}, Self {p} ${rest}`],
    ["{hello}", "{hello}", `Hi {hello}, {hello} ${rest}`],
  ] as const) expect(setupGreeting({ ...base, addressAs, selfReference })).toBe(expected);
  expect(setupGreeting({ ...base, language: "th", particle: "khrap", addressAs: "พี่ {p} $&" })).toBe("สวัสดีครับ พี่ {p} $& จิตพร้อมแล้ว เรื่องที่ยังไม่อยู่ในโครงการไหน คุยกันตรงนี้ในพื้นที่ทั่วไปได้เลยครับ");
});
