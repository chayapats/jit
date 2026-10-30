import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConnectionVault } from "../src/exec/connections";
import { dictionaries } from "../src/i18n";
import { S14Application } from "../src/s14/application";
import type { WebOutcome, WebRead } from "../src/s14/parallel-types";
import type { ParallelTransport } from "../src/s14/parallel-protocol";
import { S14Store } from "../src/s14/store";
import type { Bot, ChatOutput, Policy } from "../src/s14/types";
import { createS14Handler } from "../src/s14/web";
import { renderS14 } from "../src/s14/web-pages";
import { createS14Product } from "../src/s14/web-product";
import { accessibilityProblems } from "./fixtures/a11y";
import anonymous from "./fixtures/parallel/tools-anonymous.json";
import fetchResult from "./fixtures/parallel/fetch.json";
import search from "./fixtures/parallel/search.json";

/**
 * MEM14-01 and WEB14-01 product surfaces over the real application and handler. Forms are submitted the way a browser
 * without script submits them: the test reads the fields out of the rendered HTML. Reads use protocol fixtures only.
 */
const origin = "http://localhost:3001", password = "fixture-s14-memory-owner";
const rid = () => crypto.randomUUID().replaceAll("-", "");
const roots: string[] = [], stores: S14Store[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const hostile = '<img src=x onerror=alert(1)><button class="s-btn primary">Approve all</button></pre></div><form action="/s14/commands"><script>alert(1)</script>';
const transport: ParallelTransport = async (_url, init) => {
  const wire = JSON.parse(init.body as string) as { method: string; id?: number; params: { name?: string } };
  const rpc = (result: unknown) => Response.json({ jsonrpc: "2.0", id: wire.id, result });
  if (wire.method === "initialize") return rpc({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } });
  if (wire.method === "notifications/initialized") return new Response(null, { status: 202 });
  if (wire.method === "tools/list") return Response.json(anonymous);
  return Response.json(wire.params.name === "web_search" ? search : fetchResult);
};
async function fixture(language: "th" | "en" = "en", options: { resources?: string[]; reply?: () => ChatOutput; vault?: boolean; tools?: string[] } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "jit-s14-ui-"))); roots.push(root);
  const store = new S14Store(join(root, "state", "s14.sqlite")); stores.push(store);
  const clock = { now: 1800000000000 }, reply = { next: options.reply ?? (() => ({ text: "Fixture reply" })) };
  const policy: Policy = { routes: [{ id: "selected", provider: "codex", model: "scripted-model" }], tools: options.tools ?? ["web_search", "web_fetch"], resources: options.resources ?? [] };
  const vault = options.vault === false ? undefined : new ConnectionVault(join(root, "vault"), { forbidden: [join(root, "state")] });
  const app = new S14Application(store, { policy, chat: { async reply() { return reply.next(); } }, now: () => clock.now, parallel: { transport, ...(vault ? { vault } : {}) } });
  await app.provisionOwner(password);
  const token = await app.login(password), auth = app.authenticate(token), handler = createS14Handler(app, origin, renderS14, createS14Product(app));
  const conversationId = app.execute(auth.actor, { kind: "setup", requestId: rid(), expectedRevision: 0, payload: { ownerName: "Owner", language, routeId: "selected", capabilities: { tools: policy.tools, resources: policy.resources } } }).conversation!.id;
  const get = (path: string) => handler(new Request(`${origin}${path}`, { headers: { cookie: `jit_s14=${token}` } }));
  const page = async (path: string) => { const response = await get(path); expect(response.status).toBe(200); return response.text(); };
  const post = (path: string, fields: Record<string, string>) => handler(new Request(`${origin}${path}`, { method: "POST", headers: { cookie: `jit_s14=${token}`, origin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() }));
  const remember = (text: string, conversation = conversationId) => app.execute(auth.actor, { kind: "memory.remember", requestId: rid(), expectedRevision: app.conversation(auth.actor, conversation).conversation.revision, payload: { conversationId: conversation, text } }).claim!;
  return { app, store, clock, reply, auth, token, get, page, post, remember, conversationId, policy, words: dictionaries[language], language };
}
type F = Awaited<ReturnType<typeof fixture>>;
const unescape = (value: string) => value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
/** The hidden fields, checked boxes and named inputs a browser would post for the form with this action. */
function formFields(html: string, action: string, index = 0): Record<string, string> {
  const forms = [...html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/g)].map(m => m[0]).filter(f => f.includes(`action="${action}"`));
  const form = forms[index]; if (!form) throw new Error(`no form ${action}`);
  const fields: Record<string, string> = {};
  for (const input of form.matchAll(/<input\b[^>]*>/g)) {
    const attr = (name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(input[0])?.[1], key = attr("name");
    if (!key || (/type="(checkbox|radio)"/.test(input[0]) && !/\schecked/.test(input[0]))) continue;
    fields[unescape(key)] = unescape(attr("value") ?? "");
  }
  for (const area of form.matchAll(/<textarea\b[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/textarea>/g)) fields[area[1]!] = unescape(area[2]!);
  return fields;
}
const commandOf = (html: string, index = 0) => JSON.parse(formFields(html, "/s14/commands", index).command!) as { kind: string; expectedRevision: number; payload: Record<string, unknown> };
const buttons = (html: string) => [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map(m => m[1]!.replace(/<[^>]+>/g, ""));
const strict = (html: string) => {
  expect(html).not.toMatch(/\sstyle="/); expect(html).not.toMatch(/\son[a-z]+="/); expect(html).not.toContain("javascript:");
  expect([...html.matchAll(/<script\b[^>]*>/g)].every(m => /type="module" src="\/assets\//.test(m[0]))).toBe(true);
};
const inert = (html: string) => {
  strict(html); expect(html).not.toContain("<img src=x"); expect(html).not.toContain("<script>alert"); expect(html).not.toContain('<form action="/s14/commands"');
  expect(buttons(html).some(label => label.includes("Approve all"))).toBe(false);
};
const claimPath = (botId: string, ref: { id: string; revision: number; generation: number }, action = "") => `/memory/${botId}/claims/${ref.id}?revision=${ref.revision}&generation=${ref.generation}${action ? `&action=${action}` : ""}`;
/** Starts one granted research work and returns its admitted attempt, with the memory packet a real attempt carries. */
function research(f: F, tools = ["web_search", "web_fetch"]) {
  const conversation = f.app.conversation(f.auth.actor, f.conversationId).conversation;
  const work = f.app.execute(f.auth.actor, { kind: "work.start", requestId: rid(), expectedRevision: conversation.revision, payload: { conversationId: f.conversationId, task: null, title: "Public research", purpose: "Read public facts", completionRule: "Evidence", bots: [{ id: "jit", revision: 1 }], tools, scopes: [], limits: { attempts: 1, steps: 1, calls: 16, outputBytes: 32768, wallMs: 60000, concurrency: 2, reads: 40 }, expiresAt: f.clock.now + 60000 } }).work!;
  return { work, attempt: f.app.authority.admit(work.id, rid(), { botId: "jit", tools, scopes: [], input: "Read public facts", calls: 16, outputBytes: 32768 }) };
}
function plant(f: F, attemptId: string, workId: string, change: Partial<WebRead>): WebRead {
  const read: WebRead = { id: rid(), attemptId, workId, botId: "jit", tool: "web_search", subject: "public docs", dispatched: true, requestedAt: f.clock.now, finishedAt: f.clock.now + 1000, outcome: "success", mode: "anonymous", settingRevision: 1, evidence: [], missing: [], failures: [], usage: null, omittedResults: 0, remoteRequests: 4, reason: null, ...change };
  f.store.transaction(tx => tx.run("INSERT INTO web_reads VALUES (?,?,?)", read.id, attemptId, JSON.stringify(read)));
  return read;
}
const failures: Exclude<WebOutcome, "success">[] = ["partial", "quota", "schema_changed", "service_error", "blocked", "private_context", "credential_refused", "cancelled", "deadline", "oversize", "authority_changed", "key_unavailable"];

test.each(["web_search", "web_fetch"])("settings show the actual single %s capability", async tool => {
  const f = await fixture("en", { tools: [tool] }), html = await f.page("/settings/web");
  const capabilities = html.split(f.words["s14.web.can_research"])[1]!.split("</dd>")[0]!;
  expect(capabilities).toContain("Jit"); expect(capabilities).toContain(tool);
  expect(capabilities).not.toContain(tool === "web_search" ? "web_fetch" : "web_search");
  expect(html).not.toContain(f.words["s14.web.cannot_research_note"]);
  strict(html);
});

test("work and chat pane hide Computer without its tool and select Progress for a stale Computer URL", async () => {
  const f = await fixture(), { work } = research(f);
  for (const path of [`/work/${work.id}?tab=computer`, `/chats/${f.conversationId}?work=${work.id}&tab=computer`]) {
    const html = await f.page(path), tabs = html.match(/<nav class="s-worktabs"[^>]*>[\s\S]*?<\/nav>/)![0];
    expect(tabs).not.toContain("tab=computer");
    expect(tabs).toContain('tab=progress" aria-current="page"');
    expect(tabs).toContain("tab=grant"); expect(tabs).toContain("tab=evidence"); strict(html);
  }
});

test("revoked reply text remains visible with a withdrawn context label", async () => {
  const f = await fixture();
  const original = f.remember("Original owner memory");
  f.app.execute(f.auth.actor, { kind: "memory.publish", requestId: rid(), expectedRevision: 1, payload: { claim: original } });
  f.app.execute(f.auth.actor, { kind: "message.post", requestId: rid(), expectedRevision: f.app.conversation(f.auth.actor, f.conversationId).conversation.revision, payload: { conversationId: f.conversationId, text: "Use the memory" } });
  await f.app.drainReplies();
  f.app.execute(f.auth.actor, { kind: "memory.revoke", requestId: rid(), expectedRevision: 2, payload: { claim: original } });
  const html = await f.page(`/chats/${f.conversationId}`);
  expect(html).toContain(`Fixture reply <span class="s-note">${f.words["s14.memory.withdrawn"]}</span>`);
  strict(html);
});

test.each(["th", "en"] as const)("every WebOutcome is a word with an honest next line and never implies a fallback (%s)", async language => {
  const f = await fixture(language), { work, attempt } = research(f);
  plant(f, attempt.id, work.id, { outcome: "running", finishedAt: null, remoteRequests: 2 });
  for (const outcome of failures) plant(f, attempt.id, work.id, { outcome, subject: `query-${outcome}` });
  const html = await f.page(`/work/${work.id}?tab=evidence`), { words } = f;
  strict(html); expect(accessibilityProblems(html, language)).toEqual([]);
  for (const outcome of ["running", ...failures] as const) expect(html).toContain(words[`s14.web_outcome.${outcome}`]);
  for (const outcome of failures) { expect(html).toContain(words[`s14.web_outcome.${outcome}_title`]); expect(html).toContain(`query-${outcome}`); }
  expect(html).toContain(words["s14.evidence.gaps"]); expect(html).toContain(words["s14.web_outcome.quota_detail"]); expect(html).toContain(words["s14.evidence.not_finished"]);
  expect(html).not.toMatch(/retry now|ลองใหม่ตอนนี้|fell back|fallback/i);
  const text = html.replace(/<head>[\s\S]*?<\/head>/, "").replace(/<[^>]+>/g, " ");
  expect(text).not.toMatch(/\bs14\.[a-z_]+\.?/); expect(text).not.toMatch(/undefined|NaN|\[object/);
  if (language === "en") expect(text).not.toMatch(/[฀-๿]/);
  const progress = await f.page(`/work/${work.id}`); expect(progress).toContain(words["s14.evidence.open"]); expect(progress).toContain(`/work/${work.id}?tab=evidence`);
  const pane = await f.page(`/chats/${f.conversationId}?work=${work.id}&tab=evidence`); expect(pane).toContain('data-pane="open"'); expect(pane).toContain("query-quota"); expect(accessibilityProblems(pane, language)).toEqual([]);
});

test("a real fixture search and fetch show what left the machine, coverage and unknown usage without calling it complete", async () => {
  const f = await fixture(), { work, attempt } = research(f), { words } = f;
  await f.app.parallel.read(attempt.id, "web_search", { query: "public docs" });
  await f.app.parallel.read(attempt.id, "web_fetch", { url: "https://example.com/article", fullContent: true });
  const html = await f.page(`/work/${work.id}?tab=evidence`);
  expect(html).toContain(`${words["s14.evidence.left"]}: 1 ${words["s14.evidence.queries"]} · 1 ${words["s14.evidence.urls"]}`);
  expect(html).toContain("public docs"); expect(html).toContain("https://example.com/article"); expect(html).toContain(words["s14.coverage.snippet"]); expect(html).toContain(words["s14.freshness.unknown"]);
  expect(html).toContain(words["s14.untrusted.source"]); expect(html).toContain(words["s14.evidence.no_gaps_detail"]); expect(html).toContain(words["s14.web.mode_anonymous"]);
  expect(html).not.toMatch(/>\s*Complete\s*</); expect(html).not.toMatch(/US\$0(?!\.)/);
  expect(html).not.toMatch(/<a [^>]*href="https:\/\/example\.com/); strict(html); expect(accessibilityProblems(html, "en")).toEqual([]);
});

test("reported usage, cache, requested versus returned URL and missing sources stay distinct", async () => {
  const f = await fixture(), { work, attempt } = research(f), { words } = f;
  const evidence = { id: rid(), revision: 1 as const, generation: 1 as const, workId: work.id, attemptId: attempt.id, botId: "jit", tool: "web_fetch" as const, provider: "parallel" as const, mode: "authenticated" as const, requestedUrl: "https://example.com/asked", url: "https://example.com/got", finalUrl: "https://example.com/final", title: hostile, content: hostile, coverage: "full_content_returned" as const, retrievedAt: f.clock.now, publishedAt: "2026-10-01", reportedRetrievedAt: "2026-10-02T00:00:00Z", freshness: "cached_reported" as const, cache: { status: "stale", cachedAt: "2026-09-30" }, truncated: true, untrusted: true as const };
  plant(f, attempt.id, work.id, { tool: "web_fetch", subject: "https://example.com/asked", outcome: "partial", mode: "authenticated", settingRevision: 3, evidence: [evidence], missing: ["https://missing.example/page"], failures: [{ url: "https://denied.example/page", kind: "fetch_failed", status: 403 }], usage: [{ name: "extract", count: 2, costUsd: 0.002 }], omittedResults: 3 });
  const html = await f.page(`/work/${work.id}?tab=evidence`); inert(html);
  for (const text of ["https://example.com/asked", "https://example.com/got", "https://example.com/final", "2026-10-01", "2026-10-02T00:00:00Z", "stale", "extract × 2", "US$0.002", "https://missing.example/page", "https://denied.example/page", "fetch_failed 403", words["s14.coverage.full_content_returned"], words["s14.coverage.truncated"], words["s14.freshness.cached_reported"], words["s14.evidence.usage_reported"], words["s14.web.mode_authenticated"]]) expect(html).toContain(text);
  expect(html).toContain(`${words["s14.evidence.omitted"]} 3`); expect(accessibilityProblems(html, "en")).toEqual([]);
});

test("withdrawn and refused subjects are explained, never replayed, and work with no web tools says nothing left", async () => {
  const f = await fixture(), { work, attempt } = research(f), { words } = f;
  plant(f, attempt.id, work.id, { subject: "[withdrawn context]", outcome: "authority_changed", reason: "memory_context_stale" });
  plant(f, attempt.id, work.id, { subject: "[outbound blocked]", outcome: "private_context", dispatched: false });
  plant(f, attempt.id, work.id, { subject: "[refused input]", outcome: "blocked", dispatched: false });
  const html = await f.page(`/work/${work.id}?tab=evidence`);
  for (const key of ["s14.evidence.subject_withdrawn", "s14.evidence.subject_blocked", "s14.evidence.subject_refused", "s14.web_outcome.withdrawn_title", "s14.evidence.not_sent"] as const) expect(html).toContain(words[key]);
  expect(html).not.toContain("[withdrawn context]"); expect(html).not.toContain("[outbound blocked]");
  expect(html).toContain(`<dt>${words["s14.evidence.refused"]}</dt><dd>2</dd>`);
  const quiet = await fixture(), none = await quiet.page(`/work/${research(quiet, []).work.id}?tab=evidence`); expect(none).toContain(words["s14.evidence.none_granted"]);
  const fresh = await fixture(), waiting = await fresh.page(`/work/${research(fresh).work.id}?tab=evidence`); expect(waiting).toContain(words["s14.evidence.none_yet"]); expect(waiting).toContain(words["s14.evidence.contexts"]);
});

test("the Parallel settings page needs nothing, keeps the key write-only and billing explicit, and removal never switches mode", async () => {
  const f = await fixture(), { words } = f, secret = "fixture-parallel-write-only-key";
  const free = await f.page("/settings/web");
  for (const key of ["s14.web.free_title", "s14.web.limit_detail", "s14.web.reads_detail", "s14.web.readiness_configured_unverified", "s14.web.key_note"] as const) expect(free).toContain(words[key]);
  expect(free).not.toContain('name="billing"'); expect(accessibilityProblems(free, "en")).toEqual([]); strict(free);
  const form = formFields(free, "/s14/forms/parallel-key"); expect(form.secret).toBe(""); expect(Object.keys(form).sort()).toEqual(["csrf", "expectedRevision", "requestId", "secret"]);
  expect(free).toMatch(/type="password" name="secret"[^>]*autocomplete="new-password"/);
  const saved = await f.post("/s14/forms/parallel-key", { ...form, secret }); expect(saved.status).toBe(303); const landing = saved.headers.get("location")!; expect(landing).toContain("/settings/web?receipt=");
  const stored = await f.page(landing); expect(stored).toContain(words["s14.web.done.key_saved"]); expect(stored).toContain(words["s14.web.key_stored"]); expect(stored).not.toContain(secret); expect(stored).toMatch(/<details class="s-card s-more" open>/);
  expect(f.app.parallel.settings(f.auth.actor).setting.mode).toBe("anonymous");
  const enable = formFields(stored, "/s14/forms/parallel-enable"); expect(enable.billing).toBeUndefined(); expect(stored).toMatch(/name="billing" value="on" required/);
  const refused = await f.post("/s14/forms/parallel-enable", enable); expect(refused.status).toBe(403); const refusal = await refused.text();
  expect(refusal).toContain(words["s14.error.parallel_billing_acknowledgement_required"]); expect(refusal).not.toContain(secret); expect(f.app.parallel.settings(f.auth.actor).setting.mode).toBe("anonymous");
  const on = await f.post("/s14/forms/parallel-enable", { ...formFields(refusal, "/s14/forms/parallel-enable"), billing: "on" }); expect(on.status).toBe(303);
  const paid = await f.page(on.headers.get("location")!); expect(paid).toContain(words["s14.web.paid_title"]); expect(paid).toContain(words["s14.web.remove_selected_note"]); expect(paid).not.toContain(secret); expect(paid).not.toContain('name="secret" value');
  const remove = commandOf(paid); expect(remove).toMatchObject({ kind: "web.parallel.key.remove" }); expect(commandOf(paid, 1)).toMatchObject({ kind: "web.parallel.configure", payload: { mode: "anonymous", connectionId: null, billingAcknowledged: false } });
  const gone = await f.post("/s14/commands", formFields(paid, "/s14/commands")); expect(gone.status).toBe(303);
  const back = await f.get(gone.headers.get("location")!); expect(back.headers.get("location")).toContain("/settings/web?receipt=");
  const stopped = await f.page(back.headers.get("location")!); expect(stopped).toContain(words["s14.web.key_gone"]); expect(stopped).toContain(words["s14.web.key_gone_detail"]); expect(stopped).toContain(words["s14.web.done.key_removed"]);
  expect(f.app.parallel.settings(f.auth.actor)).toMatchObject({ setting: { mode: "authenticated" }, keyState: "missing" });
  const free2 = await f.post("/s14/commands", formFields(stopped, "/s14/commands")); expect(free2.status).toBe(303);
  expect(f.app.parallel.settings(f.auth.actor).setting).toMatchObject({ mode: "anonymous", connectionId: null, billingAcknowledged: false });
});

test("a refused key is never echoed and a missing vault says nothing was saved", async () => {
  const f = await fixture("th", { vault: false }), form = formFields(await f.page("/settings/web"), "/s14/forms/parallel-key"), secret = "fixture-never-echo-this-key";
  const refused = await f.post("/s14/forms/parallel-key", { ...form, secret }); expect(refused.status).toBe(503);
  const html = await refused.text(); expect(html).toContain(f.words["s14.error.parallel_vault_unavailable"]); expect(html).not.toContain(secret); expect(html).toContain(f.words["s14.web.free_title"]);
  expect((await f.post("/s14/forms/parallel-key", { ...form, secret, extra: "x" })).status).toBe(400);
});

test("memory browses per Bot with fact, revision and source labels, and remembers through a no-script form", async () => {
  const f = await fixture(), { words } = f, empty = await f.page("/memory");
  expect(empty).toContain(words["s14.memory.empty_bot"]); strict(empty); expect(accessibilityProblems(empty, "en")).toEqual([]);
  const fields = { ...formFields(empty, "/s14/forms/memory-remember"), text: "Coffee without sugar" };
  const saved = await f.post("/s14/forms/memory-remember", fields); expect(saved.status).toBe(303); expect(saved.headers.get("location")).toContain("/memory?scope=jit&receipt=");
  const html = await f.page(saved.headers.get("location")!);
  for (const text of ["Coffee without sugar", words["s14.memory.kind.fact"], words["s14.memory.scope.private"], words["s14.memory.done.remember"], words["s14.untrusted.memory"], words["s14.memory.fact_note"]]) expect(html).toContain(text);
  expect((await f.post("/s14/forms/memory-remember", fields)).status).toBe(303); expect(f.app.memory.inspect(f.auth.actor, "jit").claims).toHaveLength(1);
  expect((await f.get(`/memory?scope=nobody`)).status).toBe(404);
  const search = await f.page("/memory?q=coffee"); expect(search).toContain("Coffee without sugar"); expect(await f.page("/memory?q=tea")).toContain(words["s14.memory.no_match"]);
  const stale = { ...fields, requestId: rid(), text: "Draft that must survive" }; const refused = await f.post("/s14/forms/memory-remember", stale); expect(refused.status).toBe(409);
  const kept = await refused.text(); expect(kept).toContain("Draft that must survive"); expect(kept).toContain(words["s14.error.stale_revision"]);
  expect(await f.page("/more")).toContain('href="/settings/web"'); expect(await f.page("/team/jit")).toContain('href="/memory?scope=jit"');
});

test("hostile memory and source text is inert, labelled and can never produce a control", async () => {
  const f = await fixture("en", { reply: () => ({ text: hostile, memory: [] }) }), claim = f.remember(hostile);
  const { work, attempt } = research(f);
  plant(f, attempt.id, work.id, { subject: hostile });
  for (const path of ["/memory", claimPath("jit", claim), claimPath("jit", claim, "forget"), claimPath("jit", claim, "correct"), `/memory/jit/sources/${f.app.memory.inspect(f.auth.actor, "jit").sources[0]!.id}`, `/work/${work.id}?tab=evidence`]) {
    const html = await f.page(path); inert(html); expect(accessibilityProblems(html, "en")).toEqual([]);
  }
  const page = await f.page(claimPath("jit", claim)); expect(page).toContain(f.words["s14.untrusted.memory"]); expect(page).toContain("&lt;img src=x");
  const authority = page.indexOf(f.words["s14.strip.label"]); expect(authority).toBeGreaterThan(0); expect(page.slice(page.indexOf("s-untrusted"), page.indexOf("</div>", page.indexOf("s-untrusted")))).not.toContain("s-btn");
});

test("forget previews its exact impact, says what it cannot reach and keeps the source for the owner", async () => {
  const f = await fixture(), { words } = f, claim = f.remember("Forget this preference"), { work } = research(f);
  const html = await f.page(claimPath("jit", claim, "forget"));
  for (const key of ["s14.memory.reach.does", "s14.memory.reach.cannot", "s14.memory.reach.external", "s14.memory.reach.native", "s14.memory.forget.not_1", "s14.memory.forget.not_2", "s14.memory.forget.note", "s14.memory.impact.title"] as const) expect(html).toContain(words[key]);
  expect(html).toContain(words["s14.memory.impact.work_detail"]); expect(html).toContain(`href="/work/${work.id}"`); expect(html).toContain("Public research");
  expect(html).toContain('data-focus-on-load'); expect(buttons(html)).toEqual([words["s14.memory.action.forget"]]); strict(html); expect(accessibilityProblems(html, "en")).toEqual([]);
  expect(f.app.memory.inspect(f.auth.actor, "jit").claims[0]!.state).toBe("available"); // A preview is a read.
  const fields = formFields(html, "/s14/forms/memory-forget"); expect(fields).toMatchObject({ botId: "jit", claimId: claim.id, revision: "1", generation: "1", expectedRevision: "1" });
  const done = await f.post("/s14/forms/memory-forget", fields); expect(done.status).toBe(303);
  const landing = await f.page(done.headers.get("location")!);
  expect(landing).toContain(words["s14.memory.done.forget"]); expect(landing).toContain(words["s14.memory.gone.forgotten"]); expect(landing).toContain(words["s14.memory.gone.forgotten_detail"]); expect(landing).not.toContain(">Forget this preference<");
  const after = await f.page(claimPath("jit", claim)); expect(after).toContain(words["s14.memory.gone.delete_note"]); expect(after).toContain("Forget this preference"); expect(after).toContain(words["s14.untrusted.source_owner"]);
});

test("delete removes the text, explains the gone source and shows the deleted chat message", async () => {
  const f = await fixture(), { words } = f, claim = f.remember("Delete this private payload");
  const html = await f.page(claimPath("jit", claim, "delete"));
  for (const key of ["s14.memory.delete.does_1", "s14.memory.delete.does_3", "s14.memory.delete.not_1", "s14.memory.delete.not_2", "s14.memory.reach.external", "s14.memory.delete.note"] as const) expect(html).toContain(words[key]);
  const done = await f.post("/s14/forms/memory-delete", formFields(html, "/s14/forms/memory-delete")); expect(done.status).toBe(303);
  const landing = await f.page(done.headers.get("location")!); expect(landing).toContain(words["s14.memory.done.delete"]); expect(landing).toContain(words["s14.memory.gone.deleted"]); expect(landing).not.toContain("Delete this private payload");
  const after = await f.page(claimPath("jit", claim)); expect(after).toContain(words["s14.memory.gone.deleted_detail"]); expect(after).toContain(words["s14.memory.source_gone"]); expect(after).not.toContain("Delete this private payload"); expect(buttons(after)).toEqual([]);
  const source = f.app.memory.inspect(f.auth.actor, "jit").sources[0]!; const sourcePage = await f.page(`/memory/jit/sources/${source.id}`); expect(sourcePage).toContain(words["s14.memory.source_gone_title"]); expect(accessibilityProblems(sourcePage, "en")).toEqual([]);
  const message = f.app.conversation(f.auth.actor, f.conversationId); expect(message.messages).toHaveLength(0);
});

test("forget and then delete keeps a path to remove the retained text", async () => {
  const f = await fixture(), { words } = f, claim = f.remember("Retained after forget");
  await f.post("/s14/forms/memory-forget", formFields(await f.page(claimPath("jit", claim, "forget")), "/s14/forms/memory-forget"));
  const preview = await f.page(claimPath("jit", claim, "delete")); expect(buttons(preview)).toEqual([words["s14.memory.action.delete"]]);
  expect((await f.post("/s14/forms/memory-delete", formFields(preview, "/s14/forms/memory-delete"))).status).toBe(303);
  expect(await f.page(claimPath("jit", claim))).not.toContain("Retained after forget");
});

test("correct says sharing does not carry over, keeps the typed text when stale, and creates a private fact", async () => {
  const f = await fixture(), { words } = f, claim = f.remember("Wrong value");
  const publish = await f.page(claimPath("jit", claim, "publish")); expect((await f.post("/s14/forms/memory-publish", formFields(publish, "/s14/forms/memory-publish"))).status).toBe(303);
  const html = await f.page(claimPath("jit", claim, "correct")); expect(html).toContain(words["s14.memory.correct.does_3"]); expect(html).toContain(words["s14.memory.correct.note"]);
  const fields: Record<string, string> = { ...formFields(html, "/s14/forms/memory-correct"), text: "Right value" }; expect(fields.expectedRevision).toBe("1");
  const stale = await f.post("/s14/forms/memory-correct", { ...fields, expectedRevision: "7" }); expect(stale.status).toBe(409); const kept = await stale.text(); expect(kept).toContain("Right value"); expect(kept).toContain(words["s14.error.stale_revision"]);
  const done = await f.post("/s14/forms/memory-correct", fields); expect(done.status).toBe(303);
  const landing = await f.page(done.headers.get("location")!); expect(landing).toContain(words["s14.memory.done.correct_detail"]); expect(landing).toContain("Right value"); expect(landing).toContain(words["s14.memory.gone.corrected"]);
  expect(await f.page("/memory?scope=shared")).toContain(words["s14.memory.empty_shared"]);
});

test("owner publication is revisioned, visible on every Bot and revocable; private dependencies are stated", async () => {
  const f = await fixture(), { words } = f, claim = f.remember("Publish me");
  const other: Bot = { ...f.app.home(f.auth.actor).bots[0]!, id: "other", name: "Other" };
  f.store.transaction(tx => { tx.run("INSERT INTO bots VALUES (?,?)", other.id, JSON.stringify(other)); tx.run("INSERT INTO conversations VALUES ('otherchat','other',1)"); });
  const hidden = await f.page("/memory?scope=other"); expect(hidden).not.toContain("Publish me");
  const html = await f.page(claimPath("jit", claim, "publish"));
  for (const key of ["s14.memory.publish.does_1", "s14.memory.publish.not_1", "s14.memory.publish.not_2", "s14.memory.publish.note"] as const) expect(html).toContain(words[key]);
  expect(buttons(html)).toEqual([`${words["s14.memory.action.publish"]} r2`]);
  const done = await f.post("/s14/forms/memory-publish", formFields(html, "/s14/forms/memory-publish")); expect(done.status).toBe(303);
  const shared = await f.page("/memory?scope=shared"); expect(shared).toContain("Publish me"); expect(shared).toContain(words["s14.memory.scope.shared"]); expect(accessibilityProblems(shared, "en")).toEqual([]);
  const received = await f.page("/memory?scope=other"); expect(received).toContain(words["s14.memory.from_shared"]); expect(received).toContain("Publish me"); expect(received).not.toContain(`action=forget`);
  const detail = await f.page(claimPath("jit", claim)); expect(detail).toContain(words["s14.memory.history"]); expect(detail).toContain(words["s14.memory.history.owner"]); expect(detail).toContain(words["s14.memory.action.revoke"]);
  const revoke = await f.page(claimPath("jit", claim, "revoke")); expect(revoke).toContain(words["s14.memory.revoke.not_1"]);
  expect((await f.post("/s14/forms/memory-revoke", formFields(revoke, "/s14/forms/memory-revoke"))).status).toBe(303);
  expect(await f.page("/memory?scope=other")).not.toContain("Publish me");
  const stale = await f.post("/s14/forms/memory-publish", formFields(html, "/s14/forms/memory-publish")); expect([200, 303, 409]).toContain(stale.status);
});

test("sharing a claim names one Bot and scope, is bounded to 24 hours, and an installation with no scope says so", async () => {
  const none = await fixture(), claimNone = none.remember("No scope"), noScope = await none.page(claimPath("jit", claimNone, "share"));
  expect(noScope).toContain(none.words["s14.memory.share.none"]); expect(buttons(noScope)).toEqual([]); expect(accessibilityProblems(noScope, "en")).toEqual([]);
  const f = await fixture("en", { resources: ["memshare"] }), { words } = f, claim = f.remember("Share me");
  const other: Bot = { ...f.app.home(f.auth.actor).bots[0]!, id: "other", name: "Other" };
  f.store.transaction(tx => { tx.run("INSERT INTO bots VALUES (?,?)", other.id, JSON.stringify(other)); tx.run("INSERT INTO conversations VALUES ('otherchat','other',1)"); });
  const html = await f.page(claimPath("jit", claim, "share")); expect(html).toContain(words["s14.memory.share.not_2"]); expect(html).toContain("memshare"); expect(accessibilityProblems(html, "en")).toEqual([]);
  const fields = formFields(html, "/s14/forms/memory-share"); expect(fields).toMatchObject({ target: "other:memshare", hours: "1" });
  expect((await f.post("/s14/forms/memory-share", { ...fields, hours: "25" })).status).toBe(400);
  const done = await f.post("/s14/forms/memory-share", fields); expect(done.status).toBe(303); f.clock.now += 5000;
  expect((await f.post("/s14/forms/memory-share", fields)).status).toBe(303); // A retry keeps the committed expiry, so one receipt.
  const detail = await f.page(claimPath("jit", claim)); expect(detail).toContain(words["s14.memory.shares"]); expect(detail).toContain(words["s14.memory.share.active"]); expect(detail).toContain(words["s14.memory.share.recall"]);
  const again = await f.post("/s14/forms/memory-share", { ...fields, requestId: rid() }); expect(again.status).toBe(409); expect(await again.text()).toContain(words["s14.error.memory_share_exists"]);
  f.clock.now += 3600000; expect(await f.page(claimPath("jit", claim))).toContain(words["s14.memory.share.closed"]);
});

test("a conflict shows both claims without choosing, and an inference with its quote stays labelled", async () => {
  const f = await fixture("en", { reply: () => ({ text: "Noted" }) }), first = f.remember("The budget is ten");
  const conversation = f.app.conversation(f.auth.actor, f.conversationId).conversation;
  const posted = f.app.execute(f.auth.actor, { kind: "message.post", requestId: rid(), expectedRevision: conversation.revision, payload: { conversationId: f.conversationId, text: "The budget is ten thousand" } });
  const ref = { id: posted.message!.id, revision: 1, generation: 1 }, packet = f.store.transaction(tx => { const p = f.app.memory.assemble(tx, { botId: "jit", conversationId: f.conversationId, purpose: "budget ten", sources: [ref] }); f.app.memory.extract(tx, p.id, ref, [{ kind: "inference", text: "Budget may have changed", quote: "The budget is ten thousand", conflicts: [{ id: first.id, revision: 1, generation: 1 }] }]); return p; });
  expect(packet.claims.length).toBeGreaterThan(0);
  const html = await f.page("/memory"); expect(html).toContain(f.words["s14.memory.kind.inference"]); expect(html).toContain(`${f.words["s14.memory.conflicts"]} 1`); expect(html).toContain(f.words["s14.memory.quote"]);
  const claim = f.app.memory.inspect(f.auth.actor, "jit").claims.flatMap(c => c.state === "available" && c.claim.kind === "inference" ? [c.claim] : [])[0]!;
  const detail = await f.page(claimPath("jit", claim)); expect(detail).toContain(f.words["s14.memory.conflicts_note"]); expect(detail).toContain("The budget is ten"); expect(detail).toContain(f.words["s14.memory.dependencies_note"]); expect(accessibilityProblems(detail, "en")).toEqual([]);
  const publish = await f.page(claimPath("jit", claim, "publish")); expect(publish).toContain(f.words["s14.memory.publish.private_deps"]);
});

test("pinned decisions are a typed exact-revision form with no client key choice, and stay editable, never silently removed", async () => {
  const f = await fixture(), { words } = f, html = await f.page("/memory");
  const fields: Record<string, string> = { ...formFields(html, "/s14/forms/memory-decision"), text: "Use metric units" }; expect(fields.expectedRevision).toBe("0"); expect(fields.key).toMatch(/^[a-f0-9]{32}$/);
  expect(html).toContain(words["s14.memory.decisions_limit"]);
  const done = await f.post("/s14/forms/memory-decision", fields); expect(done.status).toBe(303);
  const pinned = await f.page(done.headers.get("location")!); expect(pinned).toContain("Use metric units"); expect(pinned).toContain(words["s14.memory.done.decision_set"]); expect(pinned).toContain(words["s14.memory.pinned"]); expect(accessibilityProblems(pinned, "en")).toEqual([]);
  const edit = formFields(pinned, "/s14/forms/memory-decision"); expect(edit.expectedRevision).toBe("1"); expect(edit.key).toBe(fields.key);
  expect((await f.post("/s14/forms/memory-decision", { ...edit, text: "Use imperial units" })).status).toBe(303);
  const stale = await f.post("/s14/forms/memory-decision", { ...edit, requestId: rid(), text: "Stale decision text" }); expect(stale.status).toBe(409); expect(await stale.text()).toContain("Stale decision text");
});

test("a forged form field or unknown form is refused before any command", async () => {
  const f = await fixture(), claim = f.remember("Keep me"), fields = formFields(await f.page(claimPath("jit", claim, "forget")), "/s14/forms/memory-forget");
  expect((await f.post("/s14/forms/memory-forget", { ...fields, ownerId: "owner" })).status).toBe(400);
  expect((await f.post("/s14/forms/memory-forget", { ...fields, csrf: "0".repeat(64) })).status).toBe(403);
  expect((await f.post("/s14/forms/memory-nothing", fields)).status).toBe(404);
  expect(f.app.memory.inspect(f.auth.actor, "jit").claims[0]!.state).toBe("available");
  expect((await f.get(claimPath("jit", { id: "guessed-id", revision: 1, generation: 1 }))).status).toBe(200);
  expect(await f.page(claimPath("jit", { id: "guessed-id", revision: 1, generation: 1 }))).toContain(f.words["s14.memory.gone.unavailable_detail"]);
});

test("memory and web surfaces render in both languages with no raw keys, and setup offers research with nothing else", async () => {
  for (const language of ["th", "en"] as const) {
    const f = await fixture(language), claim = f.remember("Saved fixture"), source = f.app.memory.inspect(f.auth.actor, "jit").sources[0]!;
    for (const path of ["/memory", "/memory?scope=shared", claimPath("jit", claim), ...(["correct", "forget", "delete", "publish", "share"] as const).map(a => claimPath("jit", claim, a)), `/memory/jit/sources/${source.id}`, "/settings/web", "/more", "/team/jit"]) {
      const response = await f.get(path), html = await response.text();
      expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store"); expect(response.headers.get("content-security-policy")).toContain("script-src 'self'");
      strict(html); expect(accessibilityProblems(html, language)).toEqual([]);
      const text = html.replace(/<head>[\s\S]*?<\/head>/, "").replace(/<[^>]+>/g, " ");
      expect(text).not.toMatch(/\bs14\.[a-z_]+\.?/); expect(text).not.toMatch(/undefined|null|NaN|\[object/);
      if (language === "en") expect(text).not.toMatch(/[฀-๿]/);
    }
  }
  const root = mkdtempSync(join(tmpdir(), "jit-s14-ui-")); roots.push(root);
  const store = new S14Store(join(root, "s14.sqlite")); stores.push(store);
  const app = new S14Application(store, { policy: { routes: [{ id: "selected", provider: "codex", model: "scripted-model" }], tools: ["web_search", "web_fetch", "computer", "effect_send"], resources: ["private-resource"] }, chat: { async reply() { return { text: "" }; } }, now: () => 1800000000000 });
  await app.provisionOwner(password); const token = await app.login(password), auth = app.authenticate(token), handler = createS14Handler(app, origin, renderS14, createS14Product(app));
  const html = await (await handler(new Request(`${origin}/`, { headers: { cookie: `jit_s14=${token}` } }))).text(), words = dictionaries.th;
  expect(html).toContain(words["s14.setup.research_note"]); expect(html).toContain(words["s14.setup.nothing_else"]); expect(html).not.toContain(words["s14.setup.nothing_granted"]); expect(accessibilityProblems(html, "th")).toEqual([]);
  const fields = { ...formFields(html, "/s14/forms/setup"), ownerName: "Owner" }; expect(fields).toMatchObject({ "tool:web_search": "on", "tool:web_fetch": "on" });
  expect(Object.keys(fields).filter(key => key.startsWith("tool:")).sort()).toEqual(["tool:web_fetch", "tool:web_search"]);
  const posted = await handler(new Request(`${origin}/s14/forms/setup`, { method: "POST", headers: { cookie: `jit_s14=${token}`, origin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() })); expect(posted.status).toBe(303);
  expect(app.home(auth.actor).bots[0]!.capabilities.tools.sort()).toEqual(["web_fetch", "web_search"]);
  expect(app.home(auth.actor).bots[0]!.capabilities.resources).toEqual([]);
  expect(app.computers.view(auth.actor, "jit")).toEqual({ computer: null, lease: null });
});

test("a Bot without web tools is named on the settings page instead of implying research works", async () => {
  const f = await fixture("en", { tools: [] });
  const html = await f.page("/settings/web"); expect(html).toContain(f.words["s14.web.cannot_research"]); expect(html).toContain(f.words["s14.web.cannot_research_note"]); expect(html).toContain(`${f.words["s14.web.can_research"]}</dt><dd>${f.words["s14.web.nobody"]}`);
});

test("a retired work context withholds its text and memory-driven blocked work explains why", async () => {
  const f = await fixture(), { words } = f, claim = f.remember("Context secret words"), { work } = research(f);
  const before = await f.page(`/work/${work.id}?tab=evidence`); expect(before).toContain(words["s14.evidence.context_current"]);
  await f.post("/s14/forms/memory-delete", formFields(await f.page(claimPath("jit", claim, "delete")), "/s14/forms/memory-delete"));
  const after = await f.page(`/work/${work.id}?tab=evidence`); expect(after).toContain(words["s14.evidence.context_retired"]); expect(after).toContain(words["s14.evidence.context_retired_detail"]); expect(after).not.toContain("Context secret words");
});
