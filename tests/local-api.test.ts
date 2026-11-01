import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Application } from "../src/application";
import { readConfig } from "../src/config";
import { JobQueue } from "../src/jobs/queue";
import { cliExit, parseDuration, runLocalApiCli } from "../src/local-api/cli";
import { LocalApiListener, createLocalApiHandler, localApiDirectory, localApiFiles, localApiLimits, localApiRoutes, tokenCheck } from "../src/local-api/server";
import { backupImageTables } from "../src/ops/backup";
import { TransactionStore } from "../src/store";
import { discussionPlanWork, specialistAnalysisWork } from "../src/team/dispatch";
import { jitReplyMarker, jitReplyWork } from "../src/team/jit-reply";
import { ScriptedRunPort, fixtureOutcome } from "../src/team/scripted-port";
import type { ApplicationRunOutcome, ApplicationRunRequest, RoleRoute } from "../src/team/types";
import { createWebHandler } from "../src/web";

const roots: string[] = [], stores: TransactionStore[] = [], queues: JobQueue[] = [], listeners: LocalApiListener[] = [], timers: ReturnType<typeof setInterval>[] = [];
afterEach(async () => {
  for (const timer of timers.splice(0)) clearInterval(timer);
  for (const listener of listeners.splice(0)) await listener.stop();
  for (const q of queues.splice(0)) { q.close(); await q.idle(); }
  for (const s of stores.splice(0)) s.close();
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});
const password = "fixture-rel06-owner-password", epoch = 1_800_000_000_000, origin = "http://localhost:3000";
const grok: RoleRoute = { provider: "grok", model: "fixture-grok-exact", authRoute: "owner-grok" };
const rid = () => crypto.randomUUID();
const answer = (request: ApplicationRunRequest, output: string): ApplicationRunOutcome => ({
  ...fixtureOutcome("complete", output), usage: { calls: 1, rounds: 1, hops: 1, contextTokens: 0, outputTokens: 0, retries: 0, wallMs: 0, tokensUnknown: false },
  session: { adapter: "scripted", id: request.runId, context: request.context },
});

/** Jit's scripted reply: a plain answer, or one naming specialists so a dispatch proposal waits for the owner. */
type Mode = "answer" | "dispatch";

async function fixture(path?: string) {
  const root = path ? join(path, "..") : mkdtempSync(join(tmpdir(), "jit-rel06-"));
  if (!path) roots.push(root);
  const database = path ?? join(root, "state.sqlite");
  const config = readConfig({ JIT_DATABASE: database, JIT_JOB_CONCURRENCY: "4", JIT_JOB_ROUTE_CONCURRENCY: "4" });
  const store = new TransactionStore(database); stores.push(store);
  const clock = { now: epoch };
  const state = { mode: "answer" as Mode };
  const scripted = new ScriptedRunPort(store, config.team, config.jobs.outputBytes, request => {
    if (request.instructions.operator[0] === jitReplyMarker) {
      return answer(request, state.mode === "dispatch"
        ? JSON.stringify({ reply: "ขอถามทีมก่อนนะครับ", proposals: [{ kind: "dispatch", roles: ["เทคโนโลยี"] }] })
        : JSON.stringify({ reply: "สวัสดีครับ จิตตอบจาก local API" }));
    }
    return answer(request, "ความเห็นของทีม");
  });
  let queueRef: JobQueue | undefined;
  const now = () => clock.now, current = () => queueRef;
  const queue = new JobQueue(store, config.jobs, [discussionPlanWork(), specialistAnalysisWork(store, config, scripted, now, current), jitReplyWork(store, config, scripted, now, current)], { now });
  queueRef = queue; queues.push(queue);
  const app = new Application(store, config, { now, jobs: queue });
  if (path) {
    const auth = app.authenticate(await app.login(password));
    return { root, path: database, config, store, app, queue, auth, clock, state, project: null as never, topic: null as never };
  }
  await app.setupOwner(password);
  const token = await app.login(password), auth = app.authenticate(token);
  const project = app.execute(auth.actor, { kind: "project.create", projectId: null, requestId: rid(), expectedRevision: 0, payload: { name: "สคริปต์บน Pi" } }).project;
  const topic = app.execute(auth.actor, { kind: "topic.create", projectId: project.id, requestId: rid(), expectedRevision: project.revision, payload: { title: "งานจาก terminal" } }).topic;
  const role = (name: string, kind: "coordinator" | "specialist", responsibility: string) =>
    app.execute(auth.actor, { kind: "role.save", projectId: null, requestId: rid(), expectedRevision: app.team(auth.actor).ownerRevision,
      payload: { roleId: null, name, kind, responsibility, enabled: true, route: grok } }).role!.id;
  role("จิต", "coordinator", "ตอบเจ้าของและประสานทีม");
  role("เทคโนโลยี", "specialist", "วิเคราะห์ด้าน software architecture");
  // Two specialists, so app.routing_selection/v1 rule `single` does not dispatch every message: a plain answer stays
  // plain and only Jit's model proposal asks for the team.
  role("ออกแบบ", "specialist", "วิเคราะห์ด้าน UX");
  // A disabled allowance keeps every dispatch proposal waiting for the owner.
  app.execute(auth.actor, { kind: "dispatch.allowance.set", requestId: rid(), projectId: project.id, expectedRevision: 0, payload: { enabled: false, maxRoles: 3 } });
  return { root, path: database, config, store, app, queue, auth, clock, state, project, topic };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

function setLocalApi(f: Fixture, enabled: boolean, requestId = rid()) {
  return f.app.execute(f.auth.actor, { kind: "local_api.set", requestId, projectId: null, expectedRevision: f.app.localApi(f.auth.actor).revision, payload: { enabled } });
}
function listen(f: Fixture, limits = localApiLimits) {
  const listener = new LocalApiListener({ app: f.app, directory: localApiDirectory(f.path), limits, now: () => f.clock.now, intervalMs: 20 });
  listeners.push(listener);
  return listener;
}
const dir = (f: Fixture) => localApiDirectory(f.path);
const files = (f: Fixture) => ({ url: readFileSync(join(dir(f), "url"), "utf8").trim(), token: readFileSync(join(dir(f), "token"), "utf8").trim() });
function api(f: Fixture, method: "GET" | "POST", path: string, body?: unknown, headers: Record<string, string> = {}) {
  const { url, token } = files(f);
  return fetch(`${url}${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
}
const ownerSql = "SELECT count(*) AS n FROM messages WHERE topic_id = ? AND json_extract(attribution_json, '$.kind') = 'owner'";
const ownerMessages = (f: Fixture) => f.store.read(tx => tx.get<{ n: number }>(ownerSql, f.topic.id)!.n);
async function drain(f: Fixture) { for (let i = 0; i < 6; i++) { f.queue.pump(); await f.queue.idle(); } }

test("local_api.set is a revisioned owner command; the listener and its 0700/0600 files exist only while it is on", async () => {
  const f = await fixture();
  expect(f.app.localApi(f.auth.actor)).toEqual({ enabled: false, revision: 0, updatedAt: null });
  const listener = listen(f);
  listener.reconcile();
  expect(listener.url).toBeNull();
  expect(existsSync(dir(f))).toBe(false);

  const requestId = rid();
  const on = setLocalApi(f, true, requestId);
  expect(on.localApi).toEqual({ enabled: true, revision: 1, updatedAt: epoch });
  // Replay returns the committed receipt; a stale revision or a different payload is refused.
  expect(f.app.execute(f.auth.actor, { kind: "local_api.set", requestId, projectId: null, expectedRevision: 0, payload: { enabled: true } })).toEqual(on);
  expect(() => f.app.execute(f.auth.actor, { kind: "local_api.set", requestId, projectId: null, expectedRevision: 0, payload: { enabled: false } })).toThrow("request_id_conflict");
  expect(() => f.app.execute(f.auth.actor, { kind: "local_api.set", requestId: rid(), projectId: null, expectedRevision: 0, payload: { enabled: false } })).toThrow("stale_revision");
  expect(() => f.app.execute(f.auth.actor, { kind: "local_api.set", requestId: rid(), projectId: null, expectedRevision: 1, payload: { enabled: "yes" } } as never)).toThrow("invalid_local_api");
  expect(f.store.read(tx => tx.get("SELECT count(*) AS n FROM audit WHERE command_kind = 'local_api.set'"))).toEqual({ n: 1 });

  listener.reconcile();
  expect(listener.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  expect(statSync(dir(f)).mode & 0o777).toBe(0o700);
  for (const name of localApiFiles) expect(statSync(join(dir(f), name)).mode & 0o777).toBe(0o600);
  const first = files(f);
  expect(first.url).toBe(listener.url!);
  expect(JSON.parse(readFileSync(join(dir(f), "headers"), "utf8"))).toEqual({ Authorization: `Bearer ${first.token}` });
  expect((await api(f, "GET", "/v1/pending")).status).toBe(200);

  // Turning it off revokes the listener's actor at once, then the next reconcile removes the listener and the files.
  setLocalApi(f, false);
  expect(await (await api(f, "GET", "/v1/pending")).json()).toEqual({ error: "authentication_required" });
  listener.reconcile();
  expect(listener.url).toBeNull();
  expect(existsSync(dir(f))).toBe(false);
  await expect(fetch(`${first.url}/v1/pending`, { headers: { Authorization: `Bearer ${first.token}` } })).rejects.toThrow();

  // On again: a new token; stopping the service removes the files.
  setLocalApi(f, true);
  listener.start();
  const second = files(f);
  expect(second.token).not.toBe(first.token);
  await listener.stop();
  expect(existsSync(dir(f))).toBe(false);
  // A new start rotates the token again.
  const restarted = listen(f);
  restarted.start();
  expect(files(f).token).not.toBe(second.token);
});

test("an Origin or a foreign Host is refused before the token is read; body and rate caps hold", async () => {
  const f = await fixture();
  setLocalApi(f, true);
  const listener = listen(f);
  listener.reconcile();
  const verify = spyOn(tokenCheck, "verify");
  try {
    const evil = await api(f, "POST", `/v1/topics/${f.topic.id}/messages`, { text: "จาก browser" }, { Origin: "http://evil" });
    expect(evil.status).toBe(403);
    expect(await evil.json()).toEqual({ error: "origin_rejected" });
    const fetchSite = await api(f, "GET", "/v1/pending", undefined, { "Sec-Fetch-Site": "cross-site" });
    expect(fetchSite.status).toBe(403);
    const host = await api(f, "GET", "/v1/pending", undefined, { Host: "example.com" });
    expect(host.status).toBe(403);
    expect(verify).not.toHaveBeenCalled();
    expect(ownerMessages(f)).toBe(0);
  } finally { verify.mockRestore(); }

  // The same pipeline in-process: a rebinding Host and a foreign Origin never reach the token check.
  const issued = f.app.issueLocalApiActor()!;
  const handler = createLocalApiHandler({ app: f.app, actor: issued.actor, token: "fixture-token", port: 4242, now: () => f.clock.now });
  const spy = spyOn(tokenCheck, "verify");
  try {
    expect((await handler(new Request("http://127.0.0.1:4242/v1/pending", { headers: { host: "attacker.example:4242", authorization: "Bearer fixture-token" } }))).status).toBe(403);
    expect((await handler(new Request("http://127.0.0.1:4242/v1/pending", { headers: { host: "127.0.0.1:4243", authorization: "Bearer fixture-token" } }))).status).toBe(403);
    expect(spy).not.toHaveBeenCalled();
    expect((await handler(new Request("http://127.0.0.1:4242/v1/pending", { headers: { host: "localhost:4242", authorization: "Bearer wrong" } }))).status).toBe(401);
    expect(spy).toHaveBeenCalledTimes(1);
  } finally { spy.mockRestore(); }

  const big = await api(f, "POST", `/v1/topics/${f.topic.id}/messages`, JSON.stringify({ text: "ก".repeat(localApiLimits.bodyBytes) }));
  expect(big.status).toBe(413);
  expect(ownerMessages(f)).toBe(0);
  const noToken = await fetch(`${files(f).url}/v1/pending`);
  expect(noToken.status).toBe(401);
  expect(await noToken.text()).not.toContain(files(f).token);

  // Requests admitted so far in this window: the 401 above, the oversize one is refused before the rate cap.
  for (let i = 1; i < localApiLimits.requests; i++) expect((await api(f, "GET", "/v1/pending")).status).toBe(200);
  const limited = await api(f, "GET", "/v1/pending");
  expect(limited.status).toBe(429);
  expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  f.clock.now += localApiLimits.windowMs;
  expect((await api(f, "GET", "/v1/pending")).status).toBe(200);
});

test("the same retry key within 24 hours returns the same receipt and one message, even after a restart", async () => {
  const f = await fixture();
  setLocalApi(f, true);
  let listener = listen(f);
  listener.reconcile();
  const send = (text = "สรุปงานวันนี้ให้หน่อย", key = "nightly-2026-10-28") => api(f, "POST", `/v1/topics/${f.topic.id}/messages`, { text, clientRequestId: key });
  const first = await send();
  expect(first.status).toBe(202);
  const receipt = await first.json() as { receiptId: string; replayed: boolean; messageId: string };
  expect(receipt.replayed).toBe(false);
  expect(receipt.receiptId).toMatch(/^lapi_[a-f0-9]{48}$/);
  // An owner message in the Web moves the topic revision; the retry still replays instead of sending again.
  f.app.execute(f.auth.actor, { kind: "message.send", projectId: f.project.id, requestId: rid(),
    expectedRevision: f.app.conversation(f.auth.actor, f.project.id, f.topic.id).topic.revision, payload: { topicId: f.topic.id, text: "จาก Web" } });
  const again = await (await send()).json() as typeof receipt;
  expect(again).toEqual({ ...receipt, replayed: true, projectId: f.project.id, topicId: f.topic.id } as never);
  expect(ownerMessages(f)).toBe(2);
  // The same key with different text is a conflict, not a second message.
  expect(await (await send("ข้อความอื่น")).json()).toEqual({ error: "request_id_conflict" });

  // Service restart: a new store, Application and listener on the same database.
  await listener.stop();
  for (const q of queues.splice(0)) { q.close(); await q.idle(); }
  for (const s of stores.splice(0)) s.close();
  const g = await fixture(f.path);
  listener = listen(g);
  listener.reconcile();
  const afterRestart = await (await api(g, "POST", `/v1/topics/${f.topic.id}/messages`, { text: "สรุปงานวันนี้ให้หน่อย", clientRequestId: "nightly-2026-10-28" })).json() as typeof receipt;
  expect(afterRestart.receiptId).toBe(receipt.receiptId);
  expect(afterRestart.messageId).toBe(receipt.messageId);
  expect(afterRestart.replayed).toBe(true);
  expect(g.store.read(tx => tx.get<{ n: number }>(ownerSql, f.topic.id)!.n)).toBe(2);
  expect(g.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM jit_replies")!.n)).toBe(2);

  // After 24 hours the key no longer replays, and it never sends a duplicate.
  g.clock.now += localApiLimits.retryKeyMs;
  expect(await (await api(g, "POST", `/v1/topics/${f.topic.id}/messages`, { text: "สรุปงานวันนี้ให้หน่อย", clientRequestId: "nightly-2026-10-28" })).json()).toEqual({ error: "retry_key_expired" });
});

test("route table: every route is an existing owner command or read; nothing reaches roles, routes, access, tools or a shell", async () => {
  const commandKinds = new Set(["message.send", "dispatch.proposal.accept", "dispatch.proposal.dismiss"]);
  for (const route of localApiRoutes) {
    if (route.maps.startsWith("Application.")) expect(typeof (Application.prototype as unknown as Record<string, unknown>)[route.maps.slice("Application.".length)]).toBe("function");
    else expect(commandKinds.has(route.maps)).toBe(true);
    expect(route.write).toBe(route.method === "POST");
    expect(route.path).not.toMatch(/role|route|access|tool|shell|exec|config|setting|team|persona|backup|upgrade|restore|delete|export|memory|task|decision/i);
  }
  expect(localApiRoutes.map(route => `${route.method} ${route.path}`)).toEqual([
    "POST /v1/topics/:topic/messages", "GET /v1/replies/:receipt", "GET /v1/pending", "POST /v1/proposals/:proposal/accept", "POST /v1/proposals/:proposal/dismiss",
  ]);

  const f = await fixture();
  setLocalApi(f, true);
  listen(f).reconcile();
  for (const [method, path] of [["POST", "/v1/roles"], ["POST", "/v1/routes"], ["POST", "/v1/shell"], ["POST", "/v1/tools/run"], ["POST", "/v1/access"],
    ["GET", "/v1/settings"], ["POST", `/v1/projects/${f.project.id}/team`], ["GET", "/settings"], ["POST", "/api/settings/local-api"]] as const) {
    expect((await api(f, method, path, method === "POST" ? {} : undefined)).status).toBe(404);
  }
  expect((await api(f, "GET", `/v1/topics/${f.topic.id}/messages`)).status).toBe(405);
  // Extra fields cannot widen a command: no actor, project or kind override.
  expect(await (await api(f, "POST", `/v1/topics/${f.topic.id}/messages`, { text: "x", projectId: f.project.id })).json()).toEqual({ error: "invalid_body" });
  expect(await (await api(f, "POST", `/v1/topics/${f.topic.id}/messages`, { text: "x", kind: "role.save" })).json()).toEqual({ error: "invalid_body" });
  expect(ownerMessages(f)).toBe(0);
  // Before setup creates it, the General space refuses like the Web.
  expect(await (await api(f, "POST", "/v1/topics/general/messages", { text: "x" })).json()).toEqual({ error: "setup_incomplete" });
});

test("replies, pending items and dispatch proposals map onto the Web owner commands at an exact revision", async () => {
  const f = await fixture();
  setLocalApi(f, true);
  listen(f).reconcile();
  const sent = await (await api(f, "POST", `/v1/topics/${f.topic.id}/messages`, { text: "ช่วยตอบหน่อย" })).json() as { receiptId: string };
  expect(await (await api(f, "GET", `/v1/replies/${sent.receiptId}`)).json()).toMatchObject({ outcome: "running", reply: { state: "thinking" }, answer: null });
  const queued = await (await api(f, "POST", `/v1/topics/${f.topic.id}/messages`, { text: "อีกข้อความ" })).json() as { receiptId: string };
  expect(await (await api(f, "GET", `/v1/replies/${queued.receiptId}`)).json()).toMatchObject({ outcome: "running", reply: { state: "queued" }, answer: null });
  await drain(f);
  expect(await (await api(f, "GET", `/v1/replies/${sent.receiptId}?wait=1`)).json()).toMatchObject({ outcome: "done", answer: "สวัสดีครับ จิตตอบจาก local API", pending: [] });
  expect((await api(f, "GET", "/v1/replies/lapi_unknownreceipt")).status).toBe(404);

  f.state.mode = "dispatch";
  const asked = await (await api(f, "POST", `/v1/topics/${f.topic.id}/messages`, { text: "ถามทีมให้หน่อย" })).json() as { receiptId: string };
  await drain(f);
  const waiting = await (await api(f, "GET", `/v1/replies/${asked.receiptId}`)).json() as { outcome: string; pending: { kind: string; id: string; revision: number }[] };
  expect(waiting.outcome).toBe("waiting_on_owner");
  expect(waiting.pending).toEqual([{ kind: "dispatch", id: expect.any(String), revision: 1 }]);
  const proposalId = waiting.pending[0]!.id;
  const pending = await (await api(f, "GET", "/v1/pending")).json() as { proposals: { id: string; reason: string; revision: number; roles: { roleName: string }[] }[] };
  expect(pending.proposals).toMatchObject([{ id: proposalId, reason: "allowance_disabled", revision: 1, roles: [{ roleName: "เทคโนโลยี" }] }]);

  // A stale revision is refused; the exact revision dismisses through dispatch.proposal.dismiss.
  expect(await (await api(f, "POST", `/v1/proposals/${proposalId}/dismiss`, { revision: 2 })).json()).toEqual({ error: "stale_revision" });
  const dismissed = await api(f, "POST", `/v1/proposals/${proposalId}/dismiss`, { revision: 1, clientRequestId: "dismiss-1" });
  expect(dismissed.status).toBe(202);
  expect(await dismissed.json()).toMatchObject({ receiptId: expect.stringMatching(/^lapi_/), proposal: { id: proposalId, state: "dismissed", revision: 2 } });
  expect(f.store.read(tx => tx.get("SELECT command_kind FROM audit ORDER BY rowid DESC LIMIT 1"))).toEqual({ command_kind: "dispatch.proposal.dismiss" });
  expect((await (await api(f, "GET", "/v1/pending")).json() as { proposals: unknown[] }).proposals).toEqual([]);

  // Accept starts the read-only specialist analysis the owner chose, the same command as the card's form.
  const again = await (await api(f, "POST", `/v1/topics/${f.topic.id}/messages`, { text: "ถามทีมอีกรอบ" })).json() as { receiptId: string };
  await drain(f);
  const next = (await (await api(f, "GET", `/v1/replies/${again.receiptId}`)).json() as typeof waiting).pending[0]!;
  const accepted = await (await api(f, "POST", `/v1/proposals/${next.id}/accept`, { revision: next.revision })).json();
  expect(accepted).toMatchObject({ proposal: { id: next.id, state: "accepted", revision: 2 } });
  expect(await (await api(f, "POST", `/v1/proposals/${next.id}/accept`, { revision: 2 })).json()).toEqual({ error: "dispatch_proposal_closed" });
  expect(await (await api(f, "POST", `/v1/proposals/${rid()}/dismiss`, { revision: 1 })).json()).toEqual({ error: "dispatch_proposal_not_found" });
});

test("the Web settings form turns the API on and off with session, Origin and CSRF like every owner form", async () => {
  const f = await fixture();
  const token = await f.app.login(password), auth = f.app.authenticate(token);
  const web = createWebHandler(f.app);
  const html = await (await web(new Request(`${origin}/settings`, { headers: { cookie: `jit_session=${token}`, "accept-language": "en" } }))).text();
  expect(html).toContain('id="local-api"');
  expect(html).toContain('action="/settings/local-api"');
  const post = (fields: Record<string, string>, headers: Record<string, string> = { origin }) => web(new Request(`${origin}/settings/local-api`, { method: "POST",
    body: new URLSearchParams(fields).toString(), headers: { "content-type": "application/x-www-form-urlencoded", cookie: `jit_session=${token}`, ...headers } }));
  expect((await post({ csrf: auth.csrf, requestId: rid(), expectedRevision: "0", enabled: "on" }, { origin: "http://evil" })).status).toBe(403);
  expect((await post({ csrf: "0".repeat(64), requestId: rid(), expectedRevision: "0", enabled: "on" })).status).toBe(403);
  const on = await post({ csrf: auth.csrf, requestId: rid(), expectedRevision: "0", enabled: "on" });
  expect(on.status).toBe(303);
  expect(on.headers.get("location")).toBe("/settings#local-api");
  expect(f.app.localApi(f.auth.actor).enabled).toBe(true);
  // An unchecked box is absent from the form post and turns it off.
  expect((await post({ csrf: auth.csrf, requestId: rid(), expectedRevision: "1" })).status).toBe(303);
  expect(f.app.localApi(f.auth.actor)).toMatchObject({ enabled: false, revision: 2 });
  expect(backupImageTables.local_api_settings).toBe("include");
});

/** Runs the real CLI in a subprocess against the in-process listener. */
async function cli(f: Fixture, args: string[]) {
  const child = Bun.spawn(["bun", "src/main.ts", args[0]!, "--legacy", ...args.slice(1)], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe", stdin: "ignore",
    env: { ...process.env, JIT_DATABASE: f.path, LANG: "en_US.UTF-8", LC_ALL: "", LC_MESSAGES: "" } });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
}

test("jit CLI preserves literal runtime and config flags after -- in the committed owner message", async () => {
  const f = await fixture();
  setLocalApi(f, true);
  listen(f).start();
  for (const literal of [["--s14"], ["--legacy"], ["--service-config"], ["--s14", "--legacy", "--service-config", "/not-a-config.json"]]) {
    const sent = await cli(f, ["ask", f.topic.id, "--json", "--", ...literal]);
    expect(sent.code).toBe(cliExit.done);
    expect(JSON.parse(sent.stdout).outcome).toBe("accepted");
    const stored = f.store.read(tx => tx.get<{ text: string }>(`SELECT v.content_text AS text FROM messages m JOIN source_versions v
      ON v.source_id = m.source_id AND v.revision = m.source_revision AND v.generation = m.source_generation
      WHERE m.topic_id = ? AND json_extract(m.attribution_json, '$.kind') = 'owner' ORDER BY m.sequence DESC LIMIT 1`, f.topic.id));
    expect(stored?.text).toBe(literal.join(" "));
    expect(sent.stdout + sent.stderr).not.toContain(files(f).token);
  }
});

test("jit CLI: ask --wait, a pending owner question, timeout, a disabled API and bad flags use the ADR exit codes", async () => {
  const f = await fixture();
  // Real clocks: the subprocess waits on wall time.
  f.clock.now = Date.now();
  const tick = setInterval(() => { f.clock.now = Date.now(); }, 5); timers.push(tick);
  let pumping = true;
  const pump = setInterval(() => { if (pumping) f.queue.pump(); }, 10); timers.push(pump);
  setLocalApi(f, true);
  let listener = listen(f);
  listener.start();

  const done = await cli(f, ["ask", f.topic.id, "สรุปให้หน่อย", "--wait", "--timeout", "20s"]);
  expect(done).toMatchObject({ code: cliExit.done, stdout: "สวัสดีครับ จิตตอบจาก local API\n" });
  expect(done.stdout + done.stderr).not.toContain(files(f).token);

  const asJson = await cli(f, ["ask", f.topic.id, "ขอแบบ JSON", "--wait", "--timeout", "20s", "--json", "--id", "json-run-1"]);
  expect(asJson.code).toBe(cliExit.done);
  const parsed = JSON.parse(asJson.stdout) as { outcome: string; receiptId: string; answer: string };
  expect(parsed).toMatchObject({ outcome: "done", answer: "สวัสดีครับ จิตตอบจาก local API" });
  const status = await cli(f, ["status", parsed.receiptId, "--json"]);
  expect(status.code).toBe(cliExit.done);
  expect(JSON.parse(status.stdout)).toMatchObject({ outcome: "done", receiptId: parsed.receiptId });
  // The same --id replays the same receipt.
  const replay = await cli(f, ["ask", f.topic.id, "ขอแบบ JSON", "--json", "--id", "json-run-1"]);
  expect(JSON.parse(replay.stdout)).toMatchObject({ outcome: "accepted", receiptId: parsed.receiptId, replayed: true });

  f.state.mode = "dispatch";
  const waiting = await cli(f, ["ask", f.topic.id, "ถามทีมให้หน่อย", "--wait", "--timeout", "20s"]);
  expect(waiting.code).toBe(cliExit.waitingOnOwner);
  expect(waiting.stdout).toBe("ขอถามทีมก่อนนะครับ\n");
  expect(waiting.stderr).toContain("Waiting on you: dispatch:");
  const pending = await cli(f, ["pending", "--json"]);
  expect(pending.code).toBe(cliExit.done);
  expect(JSON.parse(pending.stdout)).toMatchObject({ outcome: "done", proposals: [expect.any(Object)] });
  f.state.mode = "answer";

  pumping = false;
  const timedOut = await cli(f, ["ask", f.topic.id, "ยังไม่มีใครตอบ", "--wait", "--timeout", "1s"]);
  expect(timedOut.code).toBe(cliExit.timedOut);
  expect(timedOut.stderr).toContain("the work continues");
  pumping = true;

  // --wait keeps working across a service restart: the listener stops mid-wait and a new one starts with a new token.
  pumping = false;
  const surviving = cli(f, ["ask", f.topic.id, "รอข้ามการรีสตาร์ต", "--wait", "--timeout", "20s"]);
  await Bun.sleep(700);
  const oldToken = files(f).token;
  await listener.stop();
  await Bun.sleep(300);
  listener = listen(f);
  listener.start();
  expect(files(f).token).not.toBe(oldToken);
  pumping = true;
  expect(await surviving).toMatchObject({ code: cliExit.done, stdout: "สวัสดีครับ จิตตอบจาก local API\n" });

  expect((await cli(f, ["ask", f.topic.id, "x", "--bogus"])).code).toBe(cliExit.usage);
  expect((await cli(f, ["ask", "not-a-topic", "x"])).code).toBe(cliExit.usage);
  expect((await cli(f, ["ask", f.topic.id, "x", "--timeout", "1s"])).code).toBe(cliExit.usage);
  expect((await cli(f, ["ask", f.topic.id, "x", "--wait", "--timeout", "soon"])).code).toBe(cliExit.usage);
  expect((await cli(f, ["status", "bad id!"])).code).toBe(cliExit.usage);
  expect((await cli(f, ["status", "lapi_unknownreceipt"])).code).toBe(cliExit.failed);

  setLocalApi(f, false);
  listener.reconcile();
  const off = await cli(f, ["ask", f.topic.id, "ปิดอยู่", "--wait"]);
  expect(off.code).toBe(cliExit.unavailable);
  expect(off.stderr).toContain("local API is off");
  expect((await cli(f, ["pending"])).code).toBe(cliExit.unavailable);
}, 60_000);

test("a symlinked local-api folder is never cleaned through or written through", async () => {
  const f = await fixture();
  const elsewhere = join(f.root, "elsewhere");
  mkdirSync(elsewhere);
  for (const name of localApiFiles) writeFileSync(join(elsewhere, name), "keep\n");
  symlinkSync(elsewhere, dir(f));
  const listener = listen(f);
  // Off: the start-up cleanup leaves the files behind the symlink alone.
  listener.reconcile();
  for (const name of localApiFiles) expect(readFileSync(join(elsewhere, name), "utf8")).toBe("keep\n");
  // On: the listener refuses the folder instead of writing the token through the symlink.
  setLocalApi(f, true);
  expect(() => listener.reconcile()).toThrow("local_api_directory_invalid");
  expect(listener.url).toBeNull();
  for (const name of localApiFiles) expect(readFileSync(join(elsewhere, name), "utf8")).toBe("keep\n");
  await listener.stop();
  for (const name of localApiFiles) expect(readFileSync(join(elsewhere, name), "utf8")).toBe("keep\n");
});

test("the CLI waits for Retry-After on 429 instead of failing", async () => {
  const f = await fixture();
  setLocalApi(f, true);
  listen(f, { ...localApiLimits, requests: 1 }).reconcile();
  const out: string[] = [], slept: number[] = [];
  const io = { directory: dir(f), locale: "en" as const, out: (text: string) => { out.push(text); }, err: () => {}, stdin: async () => null,
    now: () => f.clock.now, sleep: async (ms: number) => { slept.push(ms); f.clock.now += ms; } };
  expect(await runLocalApiCli("pending", ["--json"], io)).toBe(cliExit.done);
  expect(slept).toEqual([]);
  // The window is used up: the next call waits Retry-After on the fake clock, then succeeds.
  expect(await runLocalApiCli("pending", ["--json"], io)).toBe(cliExit.done);
  expect(slept).toEqual([60_000]);
  expect(out.map(line => JSON.parse(line).outcome)).toEqual(["done", "done"]);
  // A send without --wait retries too, and the retry key keeps it to one message.
  expect(await runLocalApiCli("ask", [f.topic.id, "หลังรอ quota", "--json", "--id", "after-429"], io)).toBe(cliExit.done);
  expect(slept).toEqual([60_000, 60_000]);
  expect(ownerMessages(f)).toBe(1);
});

test("CLI durations are bounded", () => {
  expect(parseDuration("30m")).toBe(1_800_000);
  expect(parseDuration("1s")).toBe(1000);
  expect(() => parseDuration("25h")).toThrow();
  expect(() => parseDuration("0s")).toThrow();
  expect(() => parseDuration("1d")).toThrow();
});
