import { afterEach, expect, test } from "bun:test";
import type { Model, ModelRequest } from "schway/host";
import { composedFixture } from "./fixtures/s15-composition";
import type { S15CompositionOptions } from "../src/s15/composition";
import { JitClient, JitClientError } from "../src/s16/client";
import type { ClientMemoryDetail, ClientMemoryList, ClientMemoryQuery } from "../src/s16/client";
import { memoryDetail, parseMemoryQuery, searchMemory } from "../src/s16/memory";
import type { MemoryClaimView, MemoryOwnerIndex } from "../src/s15/memory/types";

const all: Awaited<ReturnType<typeof composedFixture>>[] = [];
afterEach(async () => { for (const f of all.splice(0)) await f.close(); });
const query = (patch: Partial<ClientMemoryQuery> = {}): ClientMemoryQuery => ({ q: "", kind: "all", category: "all", state: "active", bot: null, offset: 0, ...patch });

/** Production composition with a scripted work model that reports which retained preference reached it. */
async function world(tune?: (options: S15CompositionOptions) => S15CompositionOptions) {
  const captures: ModelRequest[] = [];
  let wait: { entered: ReturnType<typeof Promise.withResolvers<void>>; release: ReturnType<typeof Promise.withResolvers<void>> } | null = null;
  const model: Model = { provider: "codex-subscription", id: "fixture-model", async *stream(request) {
    captures.push(request); const body = JSON.stringify(request);
    if (wait) { const held = wait; wait = null; held.entered.resolve(); await held.release.promise; }
    const text = body.includes("I prefer detailed replies.") ? "Detailed reply." : body.includes("I prefer concise replies.") ? "Concise reply." : "Ordinary reply.";
    yield { type: "message_complete", message: { type: "assistant", id: "m" + captures.length, content: [{ type: "text", text }] } };
  } };
  const f = await composedFixture("default", false, undefined, options => { const configured = { ...options, model: { ...options.model, scripted: () => model } }; return tune ? tune(configured) : configured; }); all.push(f);
  f.interpretation = { intent: "answer", purposeId: "purpose", resourceIds: ["computer"], access: "read", subject: null };
  async function say(requestId: string, text: string, conversationId = requestId) {
    const response = await f.request(`/api/s16/client/conversations/${conversationId}/messages`, "POST", { contract: "s15-conversation/v1", requestId, conversationId, text, continuation: null });
    expect(response.status).toBe(202); await f.service.conversation.drain(); return f.service.conversation.view(f.owner, requestId);
  }
  const search = async (patch: Partial<ClientMemoryQuery> = {}) => {
    const params = new URLSearchParams(Object.entries({ ...query(patch) }).flatMap(([key, value]) => value === null || value === "" || key === "offset" && value === 0 || ["kind", "category"].includes(key) && value === "all" || key === "state" && value === "active" ? [] : [[key, String(value)]]));
    const response = await f.request(`/api/s16/client/memory${params.size ? "?" + params : ""}`); expect(response.status).toBe(200); return await response.json() as ClientMemoryList;
  };
  const detail = async (id: string) => { const response = await f.request(`/api/s16/client/memory/${id}`); expect(response.status).toBe(200); return await response.json() as ClientMemoryDetail; };
  const command = (body: unknown, headers?: Record<string, string>) => f.request("/api/s16/client/memory/commands", "POST", body, headers);
  const hold = () => { const held = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() }; wait = held; return held; };
  return { f, captures, say, search, detail, command, hold, lastInput: () => JSON.stringify(captures.at(-1)) };
}

test("owner searches, inspects, corrects and forgets sourced memory, and later model input follows", async () => {
  const w = await world();
  expect((await (await w.f.request("/api/s16/client/bootstrap")).json()).capabilities.memory).toEqual({ available: true, contract: "s16-client-memory/v1" });
  await w.say("pref", "I prefer concise replies."); await w.say("zone", "My timezone is Asia/Bangkok.");
  let list = await w.search({ q: "concise" });
  expect(list.items).toHaveLength(1);
  const original = list.items[0]!;
  expect(original).toMatchObject({ kind: "fact", category: "preference", confirmation: "owner_stated", state: "active", snippet: "I prefer concise replies.", scope: { kind: "team" }, source: { kind: "owner_message", conversationId: "pref", files: 0 } });
  expect((await w.search()).total).toBe(2);

  expect((await w.say("ask1", "How should replies look?")).result).toBe("Concise reply.");
  const used = await w.detail(original.id);
  expect(used.item).toMatchObject({ text: "I prefer concise replies.", quote: "I prefer concise replies." });
  expect(used.uses.contexts).toBeGreaterThanOrEqual(1); expect(used.item.lastUsedAt).toEqual(expect.any(Number));

  const impact = await (await w.command({ contract: "s15-memory-command/v1", requestId: "impact1", kind: "memory.impact", claim: { id: original.id, revision: original.revision } })).json();
  expect(impact).toMatchObject({ contract: "s15-memory-impact/v1", impact: { claims: 1, sources: 1 } }); expect(impact.impact.contexts).toBeGreaterThanOrEqual(1);
  // Impact preview changes nothing.
  expect((await w.search({ q: "concise" })).items[0]!.revision).toBe(original.revision);

  const correction = { contract: "s15-memory-command/v1", requestId: "correct1", kind: "memory.correct", claim: { id: original.id, revision: original.revision }, text: "I prefer detailed replies." };
  expect((await w.command(correction, { "x-csrf-token": "wrong" })).status).toBe(403);
  const receipt = await (await w.command(correction)).json();
  expect(receipt).toMatchObject({ contract: "s15-memory-receipt/v1", requestId: "correct1", kind: "memory.correct", claim: { revision: 1 } });
  // The same retained command is a safe recheck after a lost response; a changed body under that ID refuses.
  expect(await (await w.command(correction)).json()).toEqual(receipt);
  const conflict = await w.command({ ...correction, text: "I prefer long replies." }); expect(conflict.status).toBe(409); expect(await conflict.json()).toEqual({ error: "request_id_conflict" });
  const stale = await w.command({ ...correction, requestId: "correct2" }); expect(stale.status).toBe(409); expect(await stale.json()).toEqual({ error: "stale_revision" });

  expect((await w.search({ q: "concise" })).items).toHaveLength(0);
  const inactive = await w.search({ state: "inactive" });
  expect(inactive.items).toEqual([expect.objectContaining({ id: original.id, state: "superseded", snippet: "", correction: receipt.claim.id })]);
  const replacement = await w.detail(receipt.claim.id);
  expect(replacement.item).toMatchObject({ text: "I prefer detailed replies.", confirmation: "owner_stated", supersedes: original.id, state: "active" });
  expect(replacement.chain.map(entry => [entry.id, entry.state, entry.snippet])).toEqual([[original.id, "superseded", ""]]);
  expect((await w.detail(original.id)).item).toMatchObject({ text: "", quote: "", state: "superseded" });

  expect((await w.say("ask2", "How should replies look?")).result).toBe("Detailed reply.");
  expect(w.lastInput()).toContain("I prefer detailed replies."); expect(w.lastInput()).not.toContain("I prefer concise replies.");

  const forget = await (await w.command({ contract: "s15-memory-command/v1", requestId: "forget1", kind: "memory.forget", claim: { id: replacement.item.id, revision: replacement.item.revision } })).json();
  expect(forget).toMatchObject({ contract: "s15-memory-receipt/v1", kind: "memory.forget", claim: null });
  expect((await w.say("ask3", "How should replies look?")).result).toBe("Ordinary reply.");
  expect(w.lastInput()).not.toContain("I prefer detailed replies."); expect(w.lastInput()).not.toContain("I prefer concise replies.");

  // Restart: descendants stay retired, the forgotten item stays erased, unrelated memory and originals remain.
  await w.f.reopen();
  expect((await w.say("ask4", "How should replies look? Also what is my timezone?")).result).toBe("Ordinary reply.");
  expect(w.lastInput()).toContain("My timezone is Asia/Bangkok."); expect(w.lastInput()).not.toContain("replies.\"");
  list = await w.search({ state: "all" });
  expect(list.items.map(entry => [entry.snippet, entry.state]).sort()).toEqual([["", "forgotten"], ["", "superseded"], ["My timezone is Asia/Bangkok.", "active"]]);
  expect((await w.search({ q: "detailed", state: "all" })).items).toHaveLength(0);
  const unrelated = await (await w.f.request("/api/s16/client/conversations/zone")).json();
  expect(unrelated.conversation.rows[0].ownerMessage).toBe("My timezone is Asia/Bangkok.");
});

test("forget racing in-flight work withholds publication and later retrieval, including after restart", async () => {
  const w = await world(); await w.say("pref", "I prefer concise replies."); await w.say("zone", "My timezone is Asia/Bangkok.");
  const item = (await w.search({ q: "concise" })).items[0]!;
  const held = w.hold();
  expect((await w.f.request("/api/s16/client/conversations/race/messages", "POST", { contract: "s15-conversation/v1", requestId: "race", conversationId: "race", text: "How should replies look?", continuation: null })).status).toBe(202);
  const draining = w.f.service.conversation.drain(); await held.entered.promise;
  expect(w.lastInput()).toContain("I prefer concise replies.");
  const forgot = await w.command({ contract: "s15-memory-command/v1", requestId: "race_forget", kind: "memory.forget", claim: { id: item.id, revision: item.revision } }); expect(forgot.status).toBe(200);
  held.release.resolve(); await draining;
  const raced = w.f.service.conversation.view(w.f.owner, "race");
  expect({ result: raced.result, state: raced.state, code: raced.code }).toEqual({ result: null, state: "held", code: "memory_context_stale" });
  const snapshot = JSON.stringify(await (await w.f.request("/api/s16/client/conversations/race")).json()); expect(snapshot).not.toContain("Concise reply.");
  await w.f.reopen();
  expect(JSON.stringify(await (await w.f.request("/api/s16/client/conversations/race")).json())).not.toContain("Concise reply.");
  expect((await w.say("after", "How should replies look?")).result).toBe("Ordinary reply."); expect(w.lastInput()).not.toContain("I prefer concise replies.");
  expect((await w.search({ state: "all" })).items.filter(entry => entry.state === "active").map(entry => entry.snippet)).toEqual(["My timezone is Asia/Bangkok."]);
});

test("memory routes keep the protected client boundary", async () => {
  const w = await world(); await w.say("pref", "I prefer concise replies.");
  const item = (await w.search()).items[0]!;
  for (const path of ["?kind=claim", "?q=a&q=b", "?scope=team", "?offset=-1", "?bot=..%2F"]) { const response = await w.f.request("/api/s16/client/memory" + path); expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: "invalid_memory_query" }); }
  expect((await w.f.request(`/api/s16/client/memory/${item.id}?x=1`)).status).toBe(400);
  expect((await w.f.request("/api/s16/client/memory/missing")).status).toBe(404);
  expect((await w.f.request("/api/s16/client/memory", "GET", undefined, { cookie: "" })).status).toBe(401);
  expect((await w.f.request("/api/s16/client/memory", "GET", undefined, { "sec-fetch-site": "cross-site" })).status).toBe(403);
  const body = { contract: "s15-memory-command/v1", requestId: "f1", kind: "memory.forget", claim: { id: item.id, revision: item.revision } };
  expect((await w.command(body, { origin: "http://evil.invalid" })).status).toBe(403);
  expect((await w.command({ ...body, authority: "owner" })).status).toBe(400);
  expect((await w.f.request("/api/s16/client/memory/commands", "PUT", body)).status).toBe(405);
  expect((await w.search()).items[0]!.state).toBe("active");
});

test("the shared client recovers an unknown memory command with the same identity", async () => {
  const w = await world(); await w.say("pref", "I prefer concise replies.");
  let drop = false;
  const client = new JitClient({ origin: "http://localhost:3099", async fetch(request) {
    const url = new URL(request.url), text = request.method === "POST" ? await request.text() : "";
    const response = await w.f.request(url.pathname + url.search, request.method, text ? JSON.parse(text) : undefined, { accept: "application/json", ...(request.headers.get("x-csrf-token") ? { "x-csrf-token": request.headers.get("x-csrf-token")! } : {}) });
    if (drop) { drop = false; throw new TypeError("connection reset"); }
    return response;
  } });
  await client.bootstrap();
  const page = await client.memory(query({ q: "concise" })); expect(page.items).toHaveLength(1);
  const item = page.items[0]!, detail = await client.memoryDetail(item.id); expect(detail.item.text).toBe("I prefer concise replies.");
  const command = { contract: "s15-memory-command/v1" as const, requestId: "client_forget", kind: "memory.forget" as const, claim: { id: item.id, revision: item.revision } };
  drop = true;
  const lost = await client.memoryCommand(command).catch(error => error as JitClientError);
  expect(lost).toBeInstanceOf(JitClientError); expect((lost as JitClientError).outcome).toBe("unknown"); expect((lost as JitClientError).requestId).toBe("client_forget");
  // The server applied it once; rechecking with the same retained command returns the original receipt.
  const recovered = await client.memoryCommand(command); expect(recovered).toMatchObject({ contract: "s15-memory-receipt/v1", requestId: "client_forget", kind: "memory.forget" });
  expect((await client.memory(query({ state: "inactive" }))).items.map(entry => entry.state)).toEqual(["forgotten"]);
  await expect(client.memoryCommand({ ...command, kind: "memory.correct", text: " " } as never)).rejects.toMatchObject({ code: "invalid_memory_command", outcome: "not_sent" });
});

const claim = (id: string, text: string, scope: MemoryClaimView["provenance"]["scope"], patch: Partial<MemoryClaimView> = {}): MemoryClaimView => ({
  contract: "s15-memory-claim/v1", id, revision: 1, kind: "fact", category: "fact", text, quote: text, sourceId: "s_" + id,
  provenance: { origin: { kind: "owner_message", id: "o_" + id, conversationId: "c_" + id, at: 5 }, scope, resources: [], teamSourceId: null, sourceHash: "0".repeat(64) },
  createdAt: Number(id.replace(/\D/g, "") || 1), lifecycle: "active", confirmation: "owner_stated", supersedes: null, correction: null, dependencies: [], authority: "none", sourceState: "current", ...patch });
const index = (claims: MemoryClaimView[]): MemoryOwnerIndex => ({ claims, files: {}, usage: Object.fromEntries(claims.map(entry => [entry.id, { contexts: 0, summaries: 0, artifacts: 0, workItems: 0, lastUsedAt: null }])) });

test("a Bot filter removes other Bots' private items, including inherited ones, before ranking and snippets", () => {
  const values = [
    claim("c1", "The launch codename is Falcon.", { kind: "team" }),
    claim("c2", "The launch codename is Falcon in the private plan.", { kind: "bot", botId: "alpha", origin: "s15" }),
    claim("c3", "Falcon launch codename noted for beta.", { kind: "bot", botId: "beta", origin: "s15" }),
    claim("c4", "Launch codename Falcon derived summary.", { kind: "team" }, { dependencies: ["c2"] }),
  ];
  const beta = searchMemory(index(values), query({ q: "launch codename falcon", bot: "beta" }));
  expect(beta.items.map(entry => entry.id).sort()).toEqual(["c1", "c3"]); expect(beta.total).toBe(2);
  expect(JSON.stringify(beta)).not.toContain("private plan"); expect(JSON.stringify(beta)).not.toContain("derived summary");
  expect(beta.bots).toEqual(["alpha", "beta"]);
  expect(searchMemory(index(values), query({ q: "launch codename falcon" })).total).toBe(4);
  expect(searchMemory(index(values), query({ bot: "gamma" })).items.map(entry => entry.id)).toEqual(["c1"]);
});

test("search filters state/kind/category, never matches erased text and bounds snippets and pages", () => {
  const long = "I prefer " + "very ".repeat(100) + "long replies.";
  const values = [
    claim("c1", long, { kind: "team" }, { category: "preference" }),
    claim("c2", "", { kind: "team" }, { lifecycle: "forgotten", revision: 2 }),
    claim("c3", "It appears that the build uses Bun.", { kind: "team" }, { kind: "inference", confirmation: "unconfirmed", category: "working_knowledge" }),
    claim("c4", "Withdrawn source mentions Bun.", { kind: "team" }, { sourceState: "withdrawn" }),
    ...Array.from({ length: 60 }, (_, n) => claim("p" + (n + 10), "Filler note " + n, { kind: "team" })),
  ];
  const result = searchMemory(index(values), query({ q: "long replies" }));
  expect(result.items).toHaveLength(1); expect(Array.from(result.items[0]!.snippet)).toHaveLength(280); expect(result.items[0]!.snippet.endsWith("…")).toBe(true);
  expect(searchMemory(index(values), query({ q: "bun", state: "all" })).items.map(entry => entry.id)).toEqual(["c3"]);
  expect(searchMemory(index(values), query({ state: "inactive" })).items.map(entry => [entry.id, entry.state, entry.snippet])).toEqual([["c4", "withdrawn", ""], ["c2", "forgotten", ""]]);
  expect(searchMemory(index(values), query({ kind: "inference" })).items.map(entry => entry.id)).toEqual(["c3"]);
  expect(searchMemory(index(values), query({ category: "preference" })).items.map(entry => entry.id)).toEqual(["c1"]);
  const first = searchMemory(index(values), query()), second = searchMemory(index(values), query({ offset: 50 }));
  expect(first.total).toBe(62); expect(first.items).toHaveLength(50); expect(second.items).toHaveLength(12);
  expect(new Set([...first.items, ...second.items].map(entry => entry.id)).size).toBe(62);
  expect(() => memoryDetail(index(values), "missing")).toThrow("not_found");
  expect(memoryDetail(index(values), "c4").item).toMatchObject({ text: "", quote: "", state: "withdrawn" });
  expect(parseMemoryQuery(new URLSearchParams("q=x&state=all&bot=beta&offset=50"))).toEqual(query({ q: "x", state: "all", bot: "beta", offset: 50 }));
  for (const bad of ["state=deleted", "offset=1.5", "q=" + "x".repeat(257), "q=%00", "bot=a%20b", "q=a&q=b", "limit=5"]) expect(() => parseMemoryQuery(new URLSearchParams(bad))).toThrow("invalid_memory_query");
});
