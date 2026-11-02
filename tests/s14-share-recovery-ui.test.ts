import { afterEach, expect, test, setDefaultTimeout } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostError, type HostSessionReference } from "schway/host";
import { dictionaries } from "../src/i18n";
import { record, save, S14Application, type S14Options } from "../src/s14/application";
import { artifactHash } from "../src/s14/artifacts";
import type { Attempt, Effect, ScopeRef, StartPayload } from "../src/s14/authority-types";
import type { WorkGraph } from "../src/s14/graph-types";
import type { NativeIntent, NativeRecoveryPort } from "../src/s14/recovery-types";
import { S14Store } from "../src/s14/store";
import type { Bot } from "../src/s14/types";
import { canonical } from "../src/s14/validation";
import { createS14Handler } from "../src/s14/web";
import { renderS14 } from "../src/s14/web-pages";
import { createS14Product } from "../src/s14/web-product";
import { accessibilityProblems } from "./fixtures/a11y";

// Every case renders real pages through the whole product; a loaded CI runner exceeds the default 5 s.
setDefaultTimeout(30_000);

/**
 * SHARE14-01 and REC14-01 product surfaces over the real application, boot reconciliation and handler. Forms are posted the
 * way a browser without script posts them: fields are read out of the rendered HTML. Native sessions use a scripted port.
 */
const origin = "http://localhost:3001", password = "fixture-s14-share-recovery-owner";
const rid = () => crypto.randomUUID().replaceAll("-", "");
const hostile = '<img src=x onerror=alert(1)><button class="s-btn primary">Approve all</button></pre></div><form action="/s14/commands"><script>alert(1)</script>';
const roots: string[] = [], stores = new Set<S14Store>();
afterEach(() => { for (const store of stores) store.close(); stores.clear(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function nativeFixture() {
  const ledger = new Map<string, NativeIntent["discovered"]>(), controls = { busy: false, corrupt: false, partial: false };
  const port: NativeRecoveryPort = { async open(intent) {
    return {
      async listSessions() { if (controls.corrupt) throw new HostError("storage"); return { sessions: structuredClone(ledger.get(intent.id) ?? []) }; },
      async retireSession(ref) { if (controls.busy) throw new HostError("busy"); ledger.get(intent.id)!.find(row => row.reference.id === ref.id)!.state = "retired"; },
      async deleteSession(ref) { if (controls.partial) return { status: "partial", session: ref, removed: [], remaining: ["conversation"], nextAction: "reconcile" }; ledger.get(intent.id)!.find(row => row.reference.id === ref.id)!.state = "deleted"; return { status: "deleted", session: ref, removed: ["conversation"], nextAction: "none" }; },
      async close() {},
    };
  } };
  return { port, ledger, controls };
}

async function fixture(language: "th" | "en" = "en", options: { slots?: string[]; analyst?: string; ceiling?: string[] } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "jit-s14-share-ui-"))); roots.push(root);
  const path = join(root, "app.sqlite"), store = new S14Store(path); stores.add(store);
  const clock = { now: 1800000000000 }, tools = ["web_fetch", "effect_send"], slots = options.slots ?? ["slot1", "slot2", "slot3"];
  const app0: S14Options = { policy: { routes: [{ id: "selected", provider: "codex", model: "scripted" }], tools, resources: slots }, now: () => clock.now, chat: { async reply() { return { text: "Fixture reply" }; } } };
  const app = new S14Application(store, app0); await app.provisionOwner(password);
  const token = await app.login(password), actor = app.authenticate(token).actor;
  const conversationId = app.execute(actor, { kind: "setup", requestId: rid(), expectedRevision: 0, payload: { ownerName: "Owner", language, routeId: "selected", capabilities: { tools, resources: [] } } }).conversation!.id;
  store.transaction(tx => {
    const bot = record<Bot>(tx, "bots", "jit"), analyst = { ...structuredClone(bot), id: "analyst", name: options.analyst ?? "Analyst", capabilities: { tools: bot.capabilities.tools, resources: options.ceiling ?? slots.slice(0, 2) } };
    tx.run("INSERT INTO bots VALUES (?,?)", analyst.id, canonical(analyst));
    tx.run("INSERT INTO bots VALUES (?,?)", "third", canonical({ ...analyst, id: "third", name: "Third", capabilities: { tools: bot.capabilities.tools, resources: [] } }));
  });
  const handler = () => createS14Handler(app, origin, renderS14, createS14Product(app));
  const get = (route: string) => handler()(new Request(`${origin}${route}`, { headers: { cookie: `jit_s14=${token}` } }));
  const page = async (route: string) => { const response = await get(route); expect(response.status).toBe(200); return response.text(); };
  const post = (route: string, fields: Record<string, string>) => handler()(new Request(`${origin}${route}`, { method: "POST", headers: { cookie: `jit_s14=${token}`, origin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() }));
  const start = (botId = "jit", scopes: ScopeRef[] = [], changes: Partial<StartPayload> = {}) => app.execute(actor, { kind: "work.start", requestId: rid(), expectedRevision: app.conversation(actor, conversationId).conversation.revision,
    payload: { conversationId, task: null, title: "Compare phones", purpose: "Compare phones", completionRule: "Review", bots: [{ id: botId, revision: 1 }], tools: [], scopes, limits: { attempts: 8, steps: 8, calls: 16, outputBytes: 131072, concurrency: 2, reads: 40, wallMs: 3600000 }, expiresAt: clock.now + 3600000, ...changes } }).work!;
  const report = (name = "report-1.md", body = "Exact report bytes", title = "Report") => {
    const work = start(), attempt = app.authority.admit(work.id, rid(), { botId: "jit", scopes: [], tools: [], input: "Report", calls: 2, outputBytes: 65536 });
    const bytes = new TextEncoder().encode(body), stage = store.transaction(tx => app.artifacts.stage(tx, attempt, { name, mediaType: "text/markdown", size: bytes.length, sha256: artifactHash(bytes) }, bytes));
    app.authority.commit(attempt.id, { state: "ready", text: "Review", report: { title, claims: [{ id: "claim", text: "Unverified", kind: "inference", citations: [], covers: [], conflicts: [] }], missing: [], limitations: ["Unverified"], artifactIds: [stage.id] } });
    return { work, artifactId: stage.id, sha256: artifactHash(bytes), size: bytes.length };
  };
  const sheet = (artifactId: string) => `/shares/new?kind=artifact&id=${artifactId}&revision=1&generation=1`;
  const shareFile = async (artifactId: string, hours = "2") => { const fields = formFields(await page(sheet(artifactId)), "/s14/forms/snapshot-share"); return post("/s14/forms/snapshot-share", { ...fields, hours }); };
  /** A running admitted step with a dispatched transport, the state a crash leaves behind. */
  const running = (changes: Partial<StartPayload> = {}) => {
    const work = start("jit", [], { tools: ["web_fetch"], ...changes }), graph = store.read(tx => record<WorkGraph>(tx, "work_graphs", work.id)), node = graph.nodes[0]!;
    node.calls = 4; node.outputBytes = 4096; app.graph.propose(work.id, graph.revision, [node]);
    const { id: _id, handler: _handler, dependsOn: _dependsOn, ...input } = node, attempt = app.authority.admit(work.id, rid(), input);
    store.transaction(tx => {
      const step = app.graph.steps(tx, work.id)[0]!;
      attempt.step = { id: step.id, handler: node.handler, inputs: [], gaps: [] }; step.attemptId = attempt.id; step.state = "running"; step.startedAt = clock.now;
      save(tx, "work_attempts", attempt); save(tx, "work_steps", step); app.recovery.prepare(tx, attempt); app.recovery.dispatch(tx, attempt.id);
      tx.run("INSERT INTO attempt_transports VALUES (?,1)", attempt.id);
    });
    return { work, attempt, intent: () => app.recovery.intent(attempt.id, attempt.memoryId!, attempt.snapshot.route) };
  };
  const unknownEffect = async (content = "Exact content", destination = "https://fixture.invalid/receiver", existing?: ReturnType<typeof running>) => {
    const run = existing ?? running({ tools: ["effect_send"] }); let sends = 0;
    app.authority.options.effects = { send: async () => { sends++; return "unknown"; } };
    const effect = app.authority.proposeEffect(run.attempt.id, rid(), { kind: "send", destination, content }, clock.now + 30000);
    app.execute(actor, { kind: "approval.decide", requestId: rid(), expectedRevision: effect.revision, payload: { effectId: effect.id, actionHash: effect.actionHash, decision: "approve" } });
    await app.authority.runEffect(effect.id, effect.revision, effect.actionHash);
    return { ...run, effect: app.authority.effect(actor, effect.id).effect as Effect, sends: () => sends };
  };
  return { app, store, clock, actor, conversationId, get, page, post, start, report, sheet, shareFile, running, unknownEffect, words: dictionaries[language], language };
}
type F = Awaited<ReturnType<typeof fixture>>;

const unescape = (value: string) => value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
/** The hidden fields, checked choices and named inputs a browser would post for the form with this action. */
function formFields(html: string, action: string, index = 0): Record<string, string> {
  const form = [...html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/g)].map(m => m[0]).filter(f => f.includes(`action="${action}"`))[index]; if (!form) throw new Error(`no form ${action}`);
  const fields: Record<string, string> = {};
  for (const input of form.matchAll(/<input\b[^>]*>/g)) {
    const attr = (name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(input[0])?.[1], key = attr("name");
    if (!key || (/type="(checkbox|radio)"/.test(input[0]) && !/\schecked/.test(input[0]))) continue;
    fields[unescape(key)] = unescape(attr("value") ?? "");
  }
  for (const area of form.matchAll(/<textarea\b[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/textarea>/g)) fields[area[1]!] = unescape(area[2]!);
  return fields;
}
const commandOf = (html: string, kind: string) => { const found = [...html.matchAll(/name="command" value="([^"]*)"/g)].map(m => JSON.parse(unescape(m[1]!)) as { kind: string; expectedRevision: number; payload: Record<string, unknown> }).find(item => item.kind === kind); if (!found) throw new Error(`no ${kind}`); return found; };
const buttons = (html: string) => [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map(m => m[1]!.replace(/<[^>]+>/g, "")).filter(label => label !== dictionaries.th["s14.chat.new"] && label !== dictionaries.en["s14.chat.new"]);
const strict = (html: string) => { expect(html).not.toMatch(/\sstyle="/); expect(html).not.toMatch(/\son[a-z]+="/); expect(html).not.toContain("javascript:"); expect([...html.matchAll(/<script\b[^>]*>/g)].every(m => /type="module" src="\/assets\//.test(m[0]))).toBe(true); };
const safe = (html: string, language: "th" | "en") => { strict(html); expect(accessibilityProblems(html, language)).toEqual([]); expect(html).not.toContain("<img src=x"); expect(html).not.toContain("<script>alert"); expect(buttons(html).some(label => label.includes("Approve all"))).toBe(false); };
const landing = (response: Response) => { expect(response.status).toBe(303); return response.headers.get("location")!; };
const reference = (): HostSessionReference => ({ id: crypto.randomUUID(), branchId: "main" });
const shareRows = (f: F) => f.app.sharing.list(f.actor);

test.each(["th", "en"] as const)("%s share sheet pins one exact snapshot, says what is not shared and works as a plain form post", async language => {
  const f = await fixture(language), { words } = f, file = f.report(), html = await f.page(f.sheet(file.artifactId));
  for (const text of [words["s14.share.sheet_meta"], words["s14.share.pinned_note"], words["s14.share.not_1"], words["s14.share.not_2"], words["s14.share.not_3"], words["s14.share.not_4"], words["s14.share.not_5"], words["s14.share.does_4"], words["s14.share.work_any"], "report-1.md", file.sha256, `${file.size} ${words["s14.report.bytes"]}`, "r1 · g1"]) expect(html).toContain(text);
  safe(html, language); expect(html).toContain("data-focus-on-load"); expect(html).toContain("Analyst"); expect(html).toContain(`${words["s14.share.others"]}:`);
  const fields = formFields(html, "/s14/forms/snapshot-share");
  expect(Object.keys(fields).sort()).toEqual(["csrf", "hours", "receiver", "requestId", "targetGeneration", "targetId", "targetKind", "targetRevision", "workId"]);
  expect(fields).toMatchObject({ targetKind: "artifact", targetId: file.artifactId, targetRevision: "1", targetGeneration: "1", receiver: "analyst:1:slot1", workId: "", hours: "1" });
  expect(html).not.toContain('value="third'); expect(html).not.toContain('value="jit:');
  const location = landing(await f.post("/s14/forms/snapshot-share", { ...fields, hours: "3" }));
  expect(location).toBe(`/shares/slot1?receipt=${fields.requestId}`);
  expect(shareRows(f)[0]!.share).toMatchObject({ id: "slot1", receiverBotId: "analyst", target: { kind: "artifact", id: file.artifactId, revision: 1, generation: 1 }, workId: null, expiresAt: f.clock.now + 3 * 3600000, sha256: file.sha256 });
  expect(landing(await f.post("/s14/forms/snapshot-share", { ...fields, hours: "3" }))).toBe(location);
  expect(shareRows(f)).toHaveLength(1);
  const done = await f.page(location);
  for (const text of [words["s14.share.done.share"], words["s14.share.done.share_detail"], words["s14.share.state.active"], file.sha256, words["s14.share.using_empty"], words["s14.memory.share.recall"]]) expect(done).toContain(text);
  safe(done, language);
  const forged = await f.page(`/shares/slot1?receipt=${rid()}`); expect(forged).not.toContain(words["s14.share.done.share_detail"]);
});

test("the sheet shows the exact bytes as data, and a task limit stays out of the owner strip", async () => {
  const f = await fixture(), file = f.report("notes.md", hostile), task = f.app.authority.list(f.actor)[0]!;
  const accepted = f.store.transaction(tx => { const work = { ...task, id: rid(), title: hostile, purpose: "Later", state: "accepted" as const, grantId: null, revision: 1 }; tx.run("INSERT INTO work_items VALUES (?,?,?)", work.id, work.conversationId, canonical(work)); return work; });
  const html = await f.page(f.sheet(file.artifactId)), strip = html.slice(html.indexOf('class="s-strip"'));
  safe(html, "en"); expect(html).toContain("&lt;img src=x"); expect(strip).not.toContain("&lt;img");
  expect(html).toContain(f.words["s14.share.work_limit"]);
  const pinned = await f.page(`${f.sheet(file.artifactId)}&work=${accepted.id}`), fields = formFields(pinned, "/s14/forms/snapshot-share");
  expect(fields.workId).toBe(accepted.id); expect(pinned).toContain(f.words["s14.share.work_only"]); expect(pinned).toContain(f.words["s14.share.work_clear"]); safe(pinned, "en");
  expect(pinned.slice(pinned.indexOf('class="s-strip"'))).not.toContain("&lt;img");
  landing(await f.post("/s14/forms/snapshot-share", fields));
  expect(shareRows(f)[0]!.share.workId).toBe(accepted.id);
});

test.each(["th", "en"] as const)("%s with no free slot the sheet explains why and offers no control, and a used slot is never offered again", async language => {
  const f = await fixture(language, { ceiling: [] }), file = f.report(), html = await f.page(f.sheet(file.artifactId));
  expect(html).toContain(f.words["s14.share.none_title"]); expect(html).toContain(f.words["s14.share.none_detail"]); expect(html).toContain(f.words["s14.share.blocked.no_slot"]);
  expect(html).not.toContain("/s14/forms/snapshot-share"); expect(html).not.toContain(f.words["s14.memory.share.submit"] + "</button>"); safe(html, language);
  const g = await fixture(language, { ceiling: ["slot1"], slots: ["slot1"] }), other = g.report();
  landing(await g.shareFile(other.artifactId));
  const again = await g.page(g.sheet(other.artifactId)); expect(again).toContain(g.words["s14.share.none_title"]);
  g.app.execute(g.actor, { kind: "snapshot.revoke", requestId: rid(), expectedRevision: 1, payload: { shareId: "slot1" } });
  expect(await g.page(g.sheet(other.artifactId))).toContain(g.words["s14.share.none_title"]);
});

test("oversized, unknown and forwarded snapshots are refused in words before any control appears", async () => {
  const f = await fixture(), big = f.report("big.md", "x".repeat(40000));
  expect(await f.page(`/work/${big.work.id}?tab=report`)).toContain(f.words["s14.share.too_large"]);
  const list = await f.page("/shares"); expect(list).toContain(f.words["s14.share.too_large"]); expect(list).not.toContain(`id=${big.artifactId}`);
  const refused = await f.page(f.sheet(big.artifactId)); expect(refused).toContain(f.words["s14.error.snapshot_too_large"]); expect(refused).not.toContain("/s14/forms/snapshot-share"); safe(refused, "en");
  const missing = await f.page(f.sheet(rid())); expect(missing).toContain(f.words["s14.error.snapshot_unavailable"]); expect(missing).not.toContain("/s14/forms/snapshot-share");
  expect((await f.get("/shares/new?kind=profile&id=x&revision=1&generation=1")).status).toBe(404);
  expect((await f.get("/shares/new?kind=artifact&id=../../cookies&revision=1&generation=1")).status).toBe(404);
  expect((await f.get("/shares/nothing")).status).toBe(404);
});

test("report file rows and memory originals link to the sheet, and the sheet is the only place that creates a share", async () => {
  const f = await fixture(), file = f.report(), html = await f.page(`/work/${file.work.id}?tab=report`);
  expect(html).toContain(`/shares/new?kind=artifact&amp;id=${file.artifactId}&amp;revision=1&amp;generation=1#slip`);
  const remembered = f.app.execute(f.actor, { kind: "memory.remember", requestId: rid(), expectedRevision: f.app.conversation(f.actor, f.conversationId).conversation.revision, payload: { conversationId: f.conversationId, text: "Prefers short reports" } });
  const claim = f.app.memory.claim(f.actor, "jit", remembered.claim!).claim; if (claim.state !== "available") throw Error("fixture claim unavailable");
  const source = await f.page(`/memory/jit/sources/${claim.claim.source.id}`), link = `/shares/new?kind=source&amp;id=${claim.claim.source.id}&amp;revision=1&amp;generation=1#slip`;
  expect(source).toContain(link); expect(source).toContain(f.words["s14.share.this_source"]);
  const sheet = await f.page(unescape(link).replace("#slip", "")); expect(sheet).toContain("source.txt"); expect(sheet).toContain(f.words["s14.share.kind.source"]); expect(sheet).toContain("Prefers short reports"); safe(sheet, "en");
  expect(shareRows(f)).toEqual([]);
  expect(await f.page("/more")).toContain('href="/shares"');
});

test("a stale receiver, a bad time and unknown fields are refused without a share, and the sheet keeps the choice", async () => {
  const f = await fixture(), file = f.report(), fields = formFields(await f.page(f.sheet(file.artifactId)), "/s14/forms/snapshot-share");
  const stale = await f.post("/s14/forms/snapshot-share", { ...fields, receiver: "analyst:9:slot1", hours: "2" });
  expect(stale.status).toBe(409); const html = await stale.text(); expect(html).toContain(f.words["s14.error.stale_revision"]); expect(html).toContain('value="2"');
  const late = await f.post("/s14/forms/snapshot-share", { ...fields, requestId: rid(), hours: "25" });
  expect(late.status).toBe(400); expect(await late.text()).toContain(f.words["s14.error.snapshot_share_invalid"]);
  expect((await f.post("/s14/forms/snapshot-share", { ...fields, requestId: rid(), receiver: "analyst:1:slot1:extra" })).status).toBe(400);
  expect((await f.post("/s14/forms/snapshot-share", { ...fields, requestId: rid(), path: "/etc/passwd" })).status).toBe(400);
  const denied = await f.post("/s14/forms/snapshot-share", { ...fields, requestId: rid(), receiver: "third:1:slot1" });
  expect(denied.status).toBe(403); expect(await denied.text()).toContain(f.words["s14.next.snapshot_scope_denied"]);
  expect(shareRows(f)).toEqual([]);
});

test.each(["th", "en"] as const)("%s stale task limits refuse GET and POST without rendering a wider share form", async language => {
  const f = await fixture(language), file = f.report();
  const task = f.store.transaction(tx => {
    const work = { ...file.work, id: rid(), state: "accepted" as const, grantId: null, revision: 1 };
    tx.run("INSERT INTO work_items VALUES (?,?,?)", work.id, work.conversationId, canonical(work));
    return work;
  });
  const route = `${f.sheet(file.artifactId)}&work=${task.id}`;
  const fields = formFields(await f.page(route), "/s14/forms/snapshot-share");
  expect(fields.workId).toBe(task.id);
  f.start("jit", [], { task: { id: task.id, revision: task.revision } });
  const stale = await f.page(route);
  expect(stale).toContain(f.words["s14.error.stale_revision"]);
  expect(stale).not.toContain("/s14/forms/snapshot-share");
  const response = await f.post("/s14/forms/snapshot-share", fields);
  expect(response.status).toBe(409);
  const refused = await response.text();
  expect(refused).toContain(f.words["s14.error.stale_revision"]);
  expect(refused).not.toContain("/s14/forms/snapshot-share");
  expect(shareRows(f)).toEqual([]);
  safe(refused, language);
});

test("a start form can name a share, leaves it unticked, and the service still decides", async () => {
  const f = await fixture(), file = f.report(); landing(await f.shareFile(file.artifactId));
  const chat = await f.page(`/chats/${f.conversationId}`); expect(chat).toContain(f.words["s14.share.start_legend"]); expect(chat).toContain("report-1.md");
  const base = formFields(chat, "/s14/forms/compose"); expect(base["scope:slot1"]).toBeUndefined();
  const compose = { ...base, text: "Read the shared file", work: "on", "bot:analyst": "1", "scope:slot1": "1" };
  const refused = await f.post("/s14/forms/compose", { ...base, text: "Keep my words", work: "on", "scope:slot1": "1" });
  expect(refused.status).toBe(403); const again = await refused.text(); expect(again).toContain(f.words["s14.next.scope_not_allowed"]); expect(again).toContain("Keep my words"); expect(formFields(again, "/s14/forms/compose")["scope:slot1"]).toBe("1");
  landing(await f.post("/s14/forms/compose", { ...compose, requestId: rid(), expectedRevision: String(f.app.conversation(f.actor, f.conversationId).conversation.revision) }));
  const started = f.app.authority.list(f.actor).find(item => item.title === "Read the shared file")!, view = f.app.authority.view(f.actor, started.id);
  expect(view.grant!.scopes.map(scope => scope.ref)).toEqual([{ kind: "share", id: "slot1", revision: 1 }]);
  expect(await f.page(`/shares/slot1`)).toContain("Read the shared file");
  expect(await f.page(`/work/${started.id}?tab=grant`)).toContain("share:slot1 r1");
});

test("a share pinned to one accepted task is offered only on that task's start form", async () => {
  const f = await fixture(), file = f.report(), source = f.app.authority.list(f.actor)[0]!;
  const task = f.store.transaction(tx => { const work = { ...source, id: rid(), title: "Later task", purpose: "Later", state: "accepted" as const, grantId: null, revision: 1, result: null, reason: null }; tx.run("INSERT INTO work_items VALUES (?,?,?)", work.id, work.conversationId, canonical(work)); return work; });
  landing(await f.post("/s14/forms/snapshot-share", { ...formFields(await f.page(`${f.sheet(file.artifactId)}&work=${task.id}`), "/s14/forms/snapshot-share") }));
  const composer = /<form class="s-composer[\s\S]*?<\/form>/.exec(await f.page(`/chats/${f.conversationId}`))![0]; expect(composer).not.toContain("scope:slot1");
  const html = await f.page(`/work/${task.id}`); expect(html).toContain('name="scope:slot1"');
  landing(await f.post("/s14/forms/task-start", { ...formFields(html, "/s14/forms/task-start"), "bot:analyst": "1", "scope:slot1": "1" }));
  expect(f.app.authority.view(f.actor, task.id).grant!.scopes.map(scope => scope.ref.id)).toEqual(["slot1"]);
});

test.each(["th", "en"] as const)("%s revoke is honest: it blocks future use and late results and never claims erasure", async language => {
  const f = await fixture(language, { analyst: hostile }), file = f.report(); safe(await f.page(f.sheet(file.artifactId)), language); landing(await f.shareFile(file.artifactId));
  const { words } = f, html = await f.page("/shares/slot1");
  for (const text of [words["s14.share.revoke.does_1"], words["s14.share.revoke.does_2"], words["s14.share.revoke.does_3"], words["s14.share.revoke_meta"], words["s14.memory.reach.external"], words["s14.memory.reach.native"], words["s14.share.revoke.not_2"]]) expect(html).toContain(text);
  safe(html, language); expect(html).not.toMatch(/erased from|was erased|ลบออกจากผู้รับ/);
  const command = commandOf(html, "snapshot.revoke"); expect(command).toMatchObject({ expectedRevision: 1, payload: { shareId: "slot1" } });
  const fields = formFields(html, "/s14/commands", [...html.matchAll(/<form\b[^>]*action="\/s14\/commands"[^>]*>[\s\S]*?<\/form>/g)].findIndex(m => m[0].includes("snapshot.revoke")));
  const receipt = landing(await f.post("/s14/commands", fields)); expect(receipt).toMatch(/^\/s14\/receipts\//);
  const location = landing(await f.get(receipt)), done = await f.page(location);
  expect(location).toStartWith("/shares/slot1?receipt="); expect(done).toContain(words["s14.share.done.revoke"]); expect(done).toContain(words["s14.share.state.revoked"]);
  safe(done, language); expect(done).not.toContain("snapshot.revoke");
  expect(shareRows(f)[0]).toMatchObject({ state: "revoked", disclosedKnowledge: "cannot_recall" });
  const list = await f.page("/shares"); expect(list).toContain(words["s14.share.closed_title"]); expect(list).toContain(words["s14.memory.share.recall"]); safe(list, language);
  const stale = await f.post("/s14/commands", { csrf: fields.csrf!, command: JSON.stringify({ ...command, requestId: rid() }) });
  expect(stale.status).toBe(409); expect(await stale.text()).toContain('href="/shares/slot1"');
});

test("expired and unavailable shares read their own state and offer no revoke", async () => {
  const f = await fixture(), file = f.report(); landing(await f.shareFile(file.artifactId, "1"));
  f.clock.now += 3600001; const expired = await f.page("/shares/slot1");
  expect(expired).toContain(f.words["s14.share.state.expired"]); expect(expired).not.toContain("snapshot.revoke"); safe(expired, "en");
  const g = await fixture();
  const remembered = g.app.execute(g.actor, { kind: "memory.remember", requestId: rid(), expectedRevision: g.app.conversation(g.actor, g.conversationId).conversation.revision, payload: { conversationId: g.conversationId, text: "Delete this source" } });
  const claim = g.app.memory.claim(g.actor, "jit", remembered.claim!).claim; if (claim.state !== "available") throw Error("fixture claim unavailable");
  g.app.execute(g.actor, { kind: "snapshot.share", requestId: rid(), expectedRevision: 1, payload: { scopeId: "slot1", target: { kind: "source", ...claim.claim.source }, receiverBotId: "analyst", workId: null, expiresAt: g.clock.now + 60000 } });
  g.app.execute(g.actor, { kind: "memory.delete", requestId: rid(), expectedRevision: 1, payload: { claim: remembered.claim! } });
  const gone = await g.page("/shares/slot1"); expect(gone).toContain(g.words["s14.share.state.unavailable"]); expect(gone).toContain(g.words["s14.share.detail.unavailable"].replace("{bot}", "Analyst")); expect(gone).not.toContain("snapshot.revoke"); safe(gone, "en");
});

test.each(["th", "en"] as const)("%s recovery page with nothing open says so without claiming when Jit restarted", async language => {
  const f = await fixture(language), html = await f.page("/recovery");
  expect(html).toContain(f.words["s14.recovery.empty_title"]); expect(html).toContain(f.words["s14.recovery.empty_detail"]); expect(html).toContain(f.words["s14.recovery.usage"]); safe(html, language);
  expect(html).not.toContain("/s14/commands"); expect(await f.page("/")).not.toContain('href="/recovery"');
});

test.each(["th", "en"] as const)("%s a replay-safe step reads Will resume, and only a real replacement reads Resumed", async language => {
  const f = await fixture(language), n = nativeFixture(), run = f.running(), intent = run.intent(); n.ledger.set(intent.id, [{ reference: reference(), state: "active" }]);
  await f.app.recovery.boot(n.port);
  const html = await f.page("/recovery"), { words } = f;
  for (const text of [words["s14.recovery.phase.queued"], words["s14.recovery.reason.queued"], words["s14.recovery.next.queued"], "Compare phones", words["s14.recovery.settled_retired"]]) expect(html).toContain(text);
  expect(html).not.toContain(`s-pill strong">${words["s14.recovery.phase.resumed"]}`); expect(html).toContain('data-live="true"'); safe(html, language);
  f.app.authority.options.executor = { async run() { return { state: "ready", text: "Fresh safe result" }; } };
  await f.app.authority.drain();
  const later = await f.page("/recovery"); expect(later).toContain(`s-pill strong">${words["s14.recovery.phase.resumed"]}`); expect(later).toContain(words["s14.recovery.reason.resumed"]); expect(later).not.toContain('data-live="true"'); safe(later, language);
});

test("a claimed resume on a step that is not replay safe never reads Resumed", async () => {
  const f = await fixture(), n = nativeFixture(); f.running(); await f.app.recovery.boot(n.port);
  f.store.transaction(tx => { const row = tx.get<{ id: string; record_json: string }>("SELECT id,record_json FROM work_checkpoints")!; tx.run("UPDATE work_checkpoints SET record_json=? WHERE id=?", canonical({ ...JSON.parse(row.record_json), state: "resumed", replay: "never_auto", replacementAttemptId: rid() }), row.id); });
  const html = await f.page("/recovery"); expect(html).not.toContain(`s-pill strong">${f.words["s14.recovery.phase.resumed"]}`); expect(html).toContain(f.words["s14.reason.handler_requires_reconciliation"]); expect(html).toContain(f.words["s14.recovery.group.needs"]);
});

test.each(["th", "en"] as const)("%s unresolved sessions stay unconfirmed: never stopped, never deleted, capacity held", async language => {
  const f = await fixture(language), n = nativeFixture(), run = f.running(), intent = run.intent(); n.ledger.set(intent.id, [{ reference: reference(), state: "active" }]); n.controls.busy = true;
  await f.app.recovery.boot(n.port);
  const html = await f.page("/recovery"), { words } = f;
  expect(f.app.recovery.view(f.actor).native[0]).toMatchObject({ state: "unresolved", reason: "native_busy" });
  for (const text of [words["s14.recovery.session.title"], words["s14.recovery.session.pill"], words["s14.recovery.session.detail"], words["s14.recovery.session.next"], words["s14.reason.native_busy"], words["s14.recovery.session.plan_retire"], words["s14.recovery.session.seen_active"], words["s14.reason.old_transport_unsettled"], words["s14.recovery.next.old_transport_unsettled"], "native_busy", "old_transport_unsettled"]) expect(html).toContain(text);
  expect(html).not.toContain(words["s14.recovery.settled"]); safe(html, language);
  expect(html).not.toContain(words["s14.recovery.phase.queued"]); expect(html).not.toContain("/s14/commands");
  const home = await f.page("/work"); expect(home).toContain('href="/recovery"'); expect(home).toContain(words["s14.recovery.attention"]);
  expect(await f.page("/more")).toContain('href="/recovery"');
  const work = await f.page(`/work/${run.work.id}`); expect(work).toContain(words["s14.reason.old_transport_unsettled"]); expect(work).toContain('href="/recovery"');
});

test("a missing saved session, a partial delete and a storage failure each keep their own honest words", async () => {
  const f = await fixture(), n = nativeFixture(), run = f.running(), intent = run.intent(), saved = reference();
  f.app.recovery.correlate(intent.id, saved); await f.app.recovery.boot(n.port);
  const missing = await f.page("/recovery"); expect(missing).toContain(f.words["s14.reason.native_reference_missing"]); expect(missing).toContain(f.words["s14.recovery.session.seen_none"]); expect(missing).toContain(f.words["s14.recovery.session.detail"]);
  const g = await fixture(), m = nativeFixture(), other = g.running(), second = other.intent(); m.ledger.set(second.id, [{ reference: reference(), state: "active" }]); m.controls.partial = true;
  g.store.transaction(tx => { const row = tx.get<{ record_json: string }>("SELECT record_json FROM native_intents WHERE id=?", second.id)!; tx.run("UPDATE native_intents SET record_json=? WHERE id=?", canonical({ ...JSON.parse(row.record_json), contextId: "withdrawn" }), second.id); });
  await g.app.recovery.boot(m.port);
  const partial = await g.page("/recovery"); expect(partial).toContain(g.words["s14.reason.native_delete_partial"]); expect(partial).toContain(g.words["s14.recovery.session.plan_delete"]); expect(partial).not.toContain(`>${g.words["s14.recovery.settled_deleted"]}<`);
  const h = await fixture(), s = nativeFixture(), third = h.running(); third.intent(); s.controls.corrupt = true; await h.app.recovery.boot(s.port);
  const storage = await h.page("/recovery"); expect(storage).toContain(h.words["s14.reason.native_storage"]); safe(storage, "en");
});

test("stopped, revoked and exhausted work each name their own reason and next step, and never read as resumed", async () => {
  const f = await fixture(), n = nativeFixture(), stopped = f.running();
  f.app.execute(f.actor, { kind: "work.stop", requestId: rid(), expectedRevision: f.app.authority.view(f.actor, stopped.work.id).work.revision, payload: { workId: stopped.work.id } });
  await f.app.recovery.boot(n.port);
  const html = await f.page("/recovery");
  for (const text of [f.words["s14.reason.owner_stopped"], f.words["s14.recovery.next.owner_stopped"], f.words["s14.recovery.group.closed"], f.words["s14.recover.start_new"]]) expect(html).toContain(text);
  expect(html).not.toContain(`s-pill strong">${f.words["s14.recovery.phase.resumed"]}`); safe(html, "en");
  const g = await fixture(), m = nativeFixture(), used = g.running({ limits: { attempts: 1, steps: 1, calls: 4, outputBytes: 131072, concurrency: 2, reads: 40, wallMs: 3600000 } });
  g.store.transaction(tx => { const grant = g.app.authority.view(g.actor, used.work.id).work.grantId!; tx.run("UPDATE grant_usage SET attempts=1,steps=1,calls=4 WHERE grant_id=?", grant); });
  m.ledger.set(used.intent().id, [{ reference: reference(), state: "active" }]); await g.app.recovery.boot(m.port);
  const spent = await g.page("/recovery");
  for (const text of [g.words["s14.reason.budget_exhausted"], g.words["s14.recovery.next.budget_exhausted"], g.words["s14.recovery.group.needs"]]) expect(spent).toContain(text);
  expect(spent).toContain(`/chats/${g.conversationId}?redo=${used.work.id}#s14-text`); safe(spent, "en");
  const blank = await fixture(), o = nativeFixture(), late = blank.running({ expiresAt: blank.clock.now + 1000 }); blank.clock.now += 2000; await blank.app.recovery.boot(o.port);
  expect(blank.app.authority.view(blank.actor, late.work.id).work.reason).toBe("grant_expired");
  const expired = await blank.page("/recovery"); expect(expired).toContain(blank.words["s14.reason.grant_expired"]); expect(expired).toContain(blank.words["s14.recovery.next.grant_expired"]);
});

test.each(["th", "en"] as const)("%s reconcile records the owner's statement apart from the observed state and retries nothing", async language => {
  const f = await fixture(language), n = nativeFixture(), run = await f.unknownEffect(hostile, `https://fixture.invalid/${hostile}`); await f.app.recovery.boot(n.port);
  const { words } = f, list = await f.page("/recovery");
  for (const text of [words["s14.recovery.effect_title"], words["s14.recovery.effect_next"], `/effects/${run.effect.id}#slip`]) expect(list).toContain(text); safe(list, language);
  expect(list).not.toContain("/s14/forms/effect-reconcile");
  const card = await f.page(`/effects/${run.effect.id}`);
  for (const text of [words["s14.statement.lead"], words["s14.statement.legend"], words["s14.statement.occurred"], words["s14.statement.did_not_occur"], words["s14.statement.leave"], words["s14.effect.unknown_next"]]) expect(card).toContain(text);
  safe(card, language); expect(buttons(card)).toEqual([words["s14.statement.submit"]]);
  const fields = formFields(card, "/s14/forms/effect-reconcile");
  expect(Object.keys(fields).sort()).toEqual(["actionHash", "csrf", "effectId", "expectedRevision", "note", "requestId"]);
  expect(fields).toMatchObject({ effectId: run.effect.id, actionHash: run.effect.actionHash, expectedRevision: String(run.effect.revision), note: "" });
  const location = landing(await f.post("/s14/forms/effect-reconcile", { ...fields, outcome: "occurred", note: `Checked the inbox ${hostile}` }));
  expect(location).toBe(`/effects/${run.effect.id}?receipt=${fields.requestId}#slip`);
  const after = await f.page(location.replace("#slip", "")), effect = f.app.authority.effect(f.actor, run.effect.id).effect;
  expect(effect).toMatchObject({ state: "unknown", reason: "owner_statement_not_verified", resolution: { basis: "owner_statement", outcome: "occurred" } });
  for (const text of [words["s14.statement.saved"], words["s14.statement.saved_detail"], words["s14.statement.banner_title"], words["s14.statement.banner_detail"], words["s14.statement.observed"], words["s14.statement.stated"], words["s14.statement.checked"], words["s14.statement.not_checked"], words["s14.effect_state.unknown"], words["s14.statement.occurred"], words["s14.statement.note_tag"], "Checked the inbox &lt;img src=x"]) expect(after).toContain(text);
  safe(after, language); expect(after).toContain('data-state="unknown"'); expect(buttons(after)).toEqual([]);
  expect(after.slice(after.indexOf("s-statement-facts"))).not.toContain('class="s-pill ok"');
  expect(after).not.toContain(words["s14.effect_state.succeeded"]);
  expect(run.sends()).toBe(1);
  expect(landing(await f.post("/s14/forms/effect-reconcile", { ...fields, outcome: "occurred", note: `Checked the inbox ${hostile}` }))).toBe(location);
  const stale = await f.post("/s14/forms/effect-reconcile", { ...fields, requestId: rid(), outcome: "did_not_occur", note: "Changed my mind" });
  expect(stale.status).toBe(409); expect(await stale.text()).toContain(words["s14.error.stale_effect_resolution"]);
  expect(f.app.authority.effect(f.actor, run.effect.id).effect.resolution!.outcome).toBe("occurred"); expect(run.sends()).toBe(1);
  const home = await f.page("/work"); expect(home).not.toContain(`/effects/${run.effect.id}#slip`);
  const pane = await f.page(`/work/${run.work.id}`); expect(pane).toContain(words["s14.work.waiting_stated"]); expect(pane).toContain(words["s14.recover.block.stated_title"]); expect(pane).toContain(words["s14.recover.start_new"]); expect(pane).not.toContain("work.retry"); safe(pane, language);
  const later = await f.page("/recovery"); expect(later).toContain(words["s14.recovery.effect_stated"]); expect(later).toContain(words["s14.recovery.group.closed"]); safe(later, language);
});

test("a saved banner cannot be forged, and the form stays only on the card's own page", async () => {
  const f = await fixture(), run = await f.unknownEffect();
  const pane = await f.page(`/work/${run.work.id}`); expect(pane).toContain(`/effects/${run.effect.id}#slip`); expect(pane).toContain(f.words["s14.statement.open"]); expect(pane).not.toContain("/s14/forms/effect-reconcile");
  expect(await f.page(`/effects/${run.effect.id}?receipt=${rid()}`)).not.toContain(f.words["s14.statement.saved"]);
  const other = await f.unknownEffect("Other", "https://fixture.invalid/other", run); const fields = formFields(await f.page(`/effects/${other.effect.id}`), "/s14/forms/effect-reconcile");
  landing(await f.post("/s14/forms/effect-reconcile", { ...fields, outcome: "did_not_occur", note: "Not there" }));
  expect(await f.page(`/effects/${run.effect.id}?receipt=${fields.requestId}`)).not.toContain(f.words["s14.statement.saved"]);
});

test("a refused statement keeps the typed note unless it looks like a credential, which is never echoed", async () => {
  const f = await fixture(), run = await f.unknownEffect(), fields = formFields(await f.page(`/effects/${run.effect.id}`), "/s14/forms/effect-reconcile");
  const missing = await f.post("/s14/forms/effect-reconcile", { ...fields, note: "I checked the inbox" });
  expect(missing.status).toBe(400); const kept = await missing.text(); expect(kept).toContain(f.words["s14.error.invalid_effect_resolution"]); expect(kept).toContain("I checked the inbox");
  const key = "sk-" + "a".repeat(40), secret = await f.post("/s14/forms/effect-reconcile", { ...fields, requestId: rid(), outcome: "occurred", note: `Used ${key}` });
  expect(secret.status).toBe(400); const refused = await secret.text(); expect(refused).not.toContain(key); expect(formFields(refused, "/s14/forms/effect-reconcile").outcome).toBe("occurred");
  const blank = await f.post("/s14/forms/effect-reconcile", { ...fields, requestId: rid(), outcome: "occurred", note: "   " }); expect(blank.status).toBe(400); expect(await blank.text()).toContain(f.words["s14.error.invalid_text"]);
  expect((await f.post("/s14/forms/effect-reconcile", { ...fields, requestId: rid(), outcome: "occurred", note: "x", retry: "on" })).status).toBe(400);
  expect(f.app.authority.effect(f.actor, run.effect.id).effect.resolution).toBeUndefined(); expect(run.sends()).toBe(1);
});

test("a statement restored from the ledger says its note was lost rather than showing a placeholder", async () => {
  const f = await fixture(), run = await f.unknownEffect();
  f.store.transaction(tx => { const effect = record<Effect>(tx, "effects", run.effect.id); const restored: Effect = { ...effect, revision: effect.revision + 1, resolution: { basis: "owner_statement", outcome: "did_not_occur", note: "[restored owner statement]", recordedAt: f.clock.now } }; save(tx, "effects", restored); });
  const html = await f.page(`/effects/${run.effect.id}`); expect(html).toContain(f.words["s14.statement.note_lost"]); expect(html).not.toContain("[restored owner statement]"); expect(html).toContain(f.words["s14.statement.did_not_occur"]);
});

test("reads are reads: sharing and recovery pages change nothing and accept no state-changing GET", async () => {
  const f = await fixture(), file = f.report(), run = await f.unknownEffect();
  const before = f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) n FROM command_receipts")!.n);
  for (const route of ["/shares", f.sheet(file.artifactId), "/recovery", `/effects/${run.effect.id}`]) await f.page(route);
  expect(f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) n FROM command_receipts")!.n)).toBe(before);
  expect(f.app.sharing.list(f.actor)).toEqual([]); expect(run.sends()).toBe(1);
  expect((await f.get("/s14/forms/snapshot-share")).status).toBe(404);
  const attempt: Attempt = f.app.authority.view(f.actor, run.work.id).attempts[0]!; expect(attempt.workId).toBe(run.work.id);
});
