import { afterEach, expect, test } from "bun:test";
import { JitClient, JitClientError, beginConversation, emptyConversationState, receiveConversation, withholdConversation } from "../src/s16/client";
import { createS16ClientHandler } from "../src/s16/http";
import { composedFixture } from "./fixtures/s15-composition";
import { webFixture, origin as webOrigin } from "./fixtures/s15-web";
import { mail } from "./fixtures/s15-effects";

type Fixture = Awaited<ReturnType<typeof composedFixture>>;
const fixtures: Fixture[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close(); });
const fixture = async (...args: Parameters<typeof composedFixture>) => { const f = await composedFixture(...args); fixtures.push(f); return f; };
const origin = "http://localhost:3099";
const transport = (f: Fixture) => async (request: Request) => {
  const url = new URL(request.url);
  return f.request(url.pathname + url.search, request.method, request.method === "POST" ? await request.json() : undefined, Object.fromEntries(request.headers));
};
const client = (f: Fixture, fetch = transport(f)) => new JitClient({ origin, fetch });

test("the shared client performs a real composed VM call and returns only guarded owner evidence", async () => {
  const f = await fixture(), c = client(f), boot = await c.bootstrap();
  expect(boot).not.toHaveProperty("csrf");
  expect(boot.capabilities).toMatchObject({ textMessages: true, progress: "control_events", exactDecisions: true, liveSteering: false, uploads: { available: false }, artifacts: { available: false } });
  const command = c.prepareMessage("conversation", "Run the requested command in the working computer");
  const receipt = await c.send(command); expect(receipt.requestId).toBe(command.requestId);
  await f.service.conversation.drain();
  const snapshot = await c.snapshot("conversation"), row = snapshot.conversation.rows[0]!;
  expect(row.result?.text).toContain("observed tool evidence"); expect(row.evidence[0]?.tool).toBe("bash"); expect(row.evidence[0]?.content).toContain("composed");
  expect(row).not.toHaveProperty("interpretation"); expect(row).not.toHaveProperty("authority");
  expect(f.vmCalls.filter(op => op === "spawn")).toHaveLength(1);
  const events = await c.events("conversation", 0);
  expect(events.cursor).toBe(snapshot.conversation.cursor); expect(events.events.some(e => e.kind === "result")).toBe(true);
  expect(events.events.some(e => "result" in e || "text" in e)).toBe(false);
  await c.events("conversation", events.cursor); await c.snapshot("conversation");
  expect(f.vmCalls.filter(op => op === "spawn")).toHaveLength(1);
});

test("a lost send response is recovered by the original identity without a second effect", async () => {
  const f = await fixture(), send = transport(f); let lose = true, posts = 0;
  const c = client(f, async request => {
    const response = await send(request);
    if (request.method === "POST") { posts++; if (lose) { lose = false; throw Error("response lost after committed receipt"); } }
    return response;
  });
  await c.bootstrap(); const command = c.prepareMessage("conversation", "Run the requested command");
  await expect(c.send(command)).rejects.toMatchObject({ code: "connection_lost", outcome: "unknown", requestId: command.requestId });
  await f.service.conversation.drain();
  expect((await c.request(command.requestId)).row.result).not.toBeNull(); expect(posts).toBe(1);
  const replay = await c.send(command); await f.service.conversation.drain();
  expect(replay.requestId).toBe(command.requestId); expect(f.vmCalls.filter(op => op === "spawn")).toHaveLength(1);
  await expect(c.send({ ...command, text: "Run different work" })).rejects.toMatchObject({ code: "request_id_conflict", status: 409 });
  expect(f.vmCalls.filter(op => op === "spawn")).toHaveLength(1);
  await f.reopen();
  expect((await c.request(command.requestId)).row.evidence[0]?.tool).toBe("bash");
  await c.snapshot("conversation"); expect(f.vmCalls.filter(op => op === "spawn")).toHaveLength(1);
});

test("request recovery remains available beyond the recent transcript window without replay", async () => {
  const f = await fixture(), c = client(f); await c.bootstrap();
  const first = c.prepareMessage("conversation", "Run the first command"); await c.send(first); await f.service.conversation.drain();
  for (let i = 0; i < 33; i++) f.service.conversation.submit(f.owner, { contract: "s15-conversation/v1", requestId: `accepted_${i}`, conversationId: "conversation", text: `Accept issue #${i + 1}`, continuation: null });
  expect((await c.snapshot("conversation")).conversation.rows.some(row => row.requestId === first.requestId)).toBe(false);
  expect((await c.request(first.requestId)).row.result).not.toBeNull();
  expect(f.vmCalls.filter(op => op === "spawn")).toHaveLength(1);
});

test("exact JSON approval presents current content and dispatches the prepared action only once", async () => {
  const f = await fixture(), c = client(f); await c.bootstrap();
  f.interpretation = { intent: "execute", purposeId: "purpose", resourceIds: ["account"], access: "effect", subject: null };
  f.script = [{ type: "tool_call", id: "email", name: "gmail_prepare_send", arguments: { ...mail() } }];
  const command = c.prepareMessage("conversation", "Send the prepared email to the recipient"); await c.send(command); await f.service.conversation.drain();
  const snapshot = await c.snapshot("conversation"), slip = snapshot.conversation.rows[0]!.slips[0]!;
  expect(slip).toMatchObject({ state: "pending", canApprove: true }); expect(f.google.sent.size).toBe(0);
  const action = { id: slip.action.id, revision: slip.action.revision, actionHash: slip.action.actionHash };
  const decision = { contract: "s15-conversation-decision/v1" as const, requestId: "approve_once", conversationId: "conversation", action, decision: "approve" as const };
  await expect(c.decide({ ...decision, action: { ...action, actionHash: "0".repeat(64) } })).rejects.toMatchObject({ code: "stale_action", status: 409 });
  await c.decide(decision); await f.service.conversation.drain(); expect(f.google.sent.size).toBe(1);
  await c.decide(decision); await f.service.conversation.drain(); expect(f.google.sent.size).toBe(1);
  await expect(c.decide({ ...decision, action: { ...action, revision: action.revision + 1 } })).rejects.toMatchObject({ code: "request_id_conflict", status: 409 });
  await expect(c.decide({ ...decision, decision: "deny" })).rejects.toMatchObject({ code: "request_id_conflict", status: 409 });
  await expect(c.decide({ ...decision, requestId: "another_approval" })).rejects.toMatchObject({ code: "stale_action", status: 409 });
});

test("fresh snapshot and request reads withhold withdrawn private result/evidence", async () => {
  const f = await fixture(), c = client(f); await c.bootstrap();
  const command = c.prepareMessage("conversation", "Run a private diagnostic"); await c.send(command); await f.service.conversation.drain();
  expect((await c.request(command.requestId)).row.result).not.toBeNull();
  f.dataSources[0]!.active = false;
  expect((await c.request(command.requestId)).row).toMatchObject({ result: null, evidence: [] });
  expect((await c.snapshot("conversation")).conversation.rows[0]).toMatchObject({ result: null, evidence: [] });
  expect(f.vmCalls.filter(op => op === "spawn")).toHaveLength(1);
});

test("new ingress during a running request is retained, and stop targets only the named request", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let first = true;
  const f = await fixture("default", false, undefined, options => {
    const interpreter = options.interpreter!;
    return { ...options, interpreter: { ...interpreter, async *stream(request) { if (first) { first = false; entered.resolve(); await release.promise; } yield* interpreter.stream(request); } } };
  });
  const c = client(f); await c.bootstrap();
  const a = c.prepareMessage("conversation", "Run the first command"), b = c.prepareMessage("conversation", "Run the second command");
  await c.send(a); await entered.promise; await c.send(b);
  expect((await c.snapshot("conversation")).conversation.rows).toHaveLength(2);
  await c.stop(a.requestId); release.resolve(); await f.service.conversation.drain();
  expect((await c.request(a.requestId)).row).toMatchObject({ state: "stopped", result: null });
  expect((await c.request(b.requestId)).row.result).not.toBeNull();
  expect(f.vmCalls.filter(op => op === "spawn")).toHaveLength(1);
});

test("all protected client reads/commands reject forged sessions, origins, CSRF and cursor scopes", async () => {
  const f = await fixture();
  const path = "/api/s16/client/bootstrap";
  for (const supplied of [{ cookie: "" }, { host: "evil.invalid" }, { "sec-fetch-site": "cross-site" }]) expect((await f.request(path, "GET", undefined, supplied)).status).toBeGreaterThanOrEqual(400);
  const command = { contract: "s15-conversation/v1" as const, requestId: "forged", conversationId: "conversation", text: "Run a command", continuation: null };
  for (const supplied of [{ "x-csrf-token": "" }, { origin: "https://evil.invalid" }, { cookie: "" }]) expect((await f.request("/api/s16/client/conversations/conversation/messages", "POST", command, supplied)).status).toBeGreaterThanOrEqual(400);
  expect((await f.request("/api/s16/client/conversations/other/messages", "POST", command)).status).toBe(403);
  const c = client(f); await c.bootstrap(); await c.send({ ...command, requestId: "real" }); await f.service.conversation.drain();
  const cursor = (await c.events("conversation", 0)).cursor;
  await expect(c.events("other", cursor)).rejects.toMatchObject({ code: "cursor_invalid" });
  expect((await f.request(`/api/s16/client/conversations/conversation/events?after=0&after=${cursor}`)).status).toBe(409);
  expect((await f.request(`/api/s16/client/bootstrap?csrf=leak`)).status).toBe(400);
  const response = await f.request(path); expect(response.headers.get("cache-control")).toBe("private, no-store"); expect(response.headers.get("access-control-allow-origin")).toBeNull();
  expect(f.vmCalls.filter(op => op === "spawn")).toHaveLength(1);
});

test("owner authentication is rechecked after streaming a command body", async () => {
  const f = webFixture();
  try {
    const handler = createS16ClientHandler(f.app, { origin: webOrigin, cookieName: "jit_s15", authentication: f.ports.authentication });
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), encoder = new TextEncoder();
    const command = JSON.stringify({ contract: "s15-conversation/v1", requestId: "expired_stream", conversationId: "conversation", text: "Run a command", continuation: null });
    const bytes = new ReadableStream<Uint8Array>({ async start(controller) { controller.enqueue(encoder.encode(command.slice(0, 20))); entered.resolve(); await release.promise; controller.enqueue(encoder.encode(command.slice(20))); controller.close(); } });
    const response = handler(new Request(webOrigin + "/api/s16/client/conversations/conversation/messages", { method: "POST", headers: { cookie: "jit_s15=owner-token", origin: webOrigin, "x-csrf-token": "csrf-fixture", "content-type": "application/json" }, body: bytes }));
    await entered.promise; f.expire(); release.resolve();
    expect((await response).status).toBe(401); expect(f.store.db.query("SELECT id FROM requests").all()).toHaveLength(0);
  } finally { f.cleanup(); }
});

test("client fails closed on redirects/oversized JSON and never automatically retries a mutation", async () => {
  let calls = 0;
  const c = new JitClient({ origin, async fetch() { calls++; return Response.redirect("https://evil.invalid", 302); } });
  await expect(c.bootstrap()).rejects.toMatchObject({ code: "client_protocol_invalid" }); expect(calls).toBe(1);
  const large = new JitClient({ origin, async fetch() { return new Response('"' + "x".repeat(8 * 1024 * 1024) + '"', { headers: { "content-type": "application/json" } }); } });
  await expect(large.bootstrap()).rejects.toMatchObject({ code: "client_response_limit" });
  expect(() => new JitClient({ origin: "https://jit.test/path" })).toThrow(JitClientError);
  await expect(c.send(c.prepareMessage("conversation", "Run work"))).rejects.toMatchObject({ code: "client_not_initialized", outcome: "not_sent" }); expect(calls).toBe(1);
});

test("client generations fence stale navigation, out-of-order snapshots and withdrawn/auth-failed content", async () => {
  const f = await fixture(), c = client(f); await c.bootstrap();
  let state = beginConversation(emptyConversationState(), "conversation"), first = state.generation;
  const old = await c.snapshot("conversation");
  state = beginConversation(state, "other"); expect(receiveConversation(state, first, old)).toBe(state);
  const other = await c.snapshot("other"); state = receiveConversation(state, state.generation, other); expect(state.state).toBe("ready");
  const hidden = withholdConversation(state); expect(hidden.snapshot).toBeNull(); expect(receiveConversation(hidden, state.generation, other)).toBe(hidden);
  const newer = { ...other, conversation: { ...other.conversation, cursor: other.conversation.cursor + 1 } };
  state = receiveConversation(state, state.generation, newer); expect(receiveConversation(state, state.generation, other)).toBe(state);
});

test("an invalid successful mutation response retains unknown outcome and the original request identity", async () => {
  const f = await fixture(), send = transport(f);
  const c = client(f, async request => {
    const response = await send(request);
    return request.method === "POST" ? Response.json({ contract: "different" }) : response;
  });
  await c.bootstrap(); const command = c.prepareMessage("conversation", "Run the command");
  expect(Object.isFrozen(command)).toBe(true);
  await expect(c.send(command)).rejects.toMatchObject({ code: "client_protocol_invalid", outcome: "unknown", requestId: command.requestId });
  await f.service.conversation.drain(); expect((await c.request(command.requestId)).row.result).not.toBeNull();
  expect(f.vmCalls.filter(op => op === "spawn")).toHaveLength(1);
});

test("the shared client bundles for browsers without importing protected services or Schway", async () => {
  const build = await Bun.build({ entrypoints: [new URL("../src/s16/client/index.ts", import.meta.url).pathname], target: "browser" });
  expect(build.success).toBe(true); expect(build.outputs).toHaveLength(1);
  const source = await build.outputs[0]!.text();
  expect(source).not.toContain("bun:sqlite"); expect(source).not.toContain("schway/host"); expect(source).not.toContain("ConversationStore");
});
