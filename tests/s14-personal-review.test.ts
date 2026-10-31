import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { schwayResearch } from "../src/s14/research";
import { schwayRecovery } from "../src/s14/native-recovery";
import type { PersonalEventDraft, PersonalMailDraft } from "../src/s14/personal-effect-types";
import { personalEventBody, personalMailRaw } from "../src/s14/personal-effect-validation";
import google from "./fixtures/google-personal.json";
import { retryId, routineCommand, workCommand } from "./fixtures/s14-domain";
import { connect, grant, personalAttempt, personalFixture, readInput, type PersonalFixture } from "./fixtures/s14-personal";

const fixtures: PersonalFixture[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.dispose(); });
async function fixture(options: Parameters<typeof personalFixture>[0] = {}) {
  const f = await personalFixture(options); fixtures.push(f); return f;
}
const limits = { attempts: 4, steps: 4, calls: 64, outputBytes: 131072, wallMs: 60000, concurrency: 2, reads: 20 };
const mail = (): PersonalMailDraft => ({ kind: "mail", to: ["owner@example.test"], cc: [], bcc: [], subject: "Reviewed subject", body: "Reviewed body" });
const privateText = 'Budget <alpha> & <beta> due "Friday"\n\\ notes';
const mutations = (f: PersonalFixture) => f.google.calls.filter(c => ["POST", "PATCH", "DELETE"].includes(c.init.method ?? "") && !c.url.endsWith("/token"));

test.each(["mail", "subject", "attachment", "filename", "event", "location", "summary"] as const)("raw private %s fields cannot escape JSON/HTML framing into a public query or URL", async field => {
  let outbound = 0;
  const f = await fixture({ policy: { routes: [{ id: "selected", provider: "codex", model: "fixture" }], tools: ["personal_read", "web_search", "web_fetch"], resources: ["mail", "calendar"] },
    parallel: { transport: async () => { outbound++; throw Error("Scripted public control"); } } });
  const calendar = ["event", "location", "summary"].includes(field), slot = calendar ? "calendar" : "mail";
  const c = await connect(f, calendar ? "calendar" : "gmail"); grant(f, c.id, slot);
  f.google.hook = async (url, init) => {
    if (url.includes("/attachments/")) return f.google.response({ data: Buffer.from(privateText).toString("base64url") });
    if (/\/messages\/mail[12]/.test(url)) {
      const value = structuredClone(google.message);
      value.id = url.includes("mail1") ? "mail1" : "mail2";
      if (field === "subject") value.payload.headers[0]!.value = privateText;
      if (field === "filename") value.payload.parts[1]!.filename = privateText;
      if (field === "mail") value.payload.parts[0]!.body.data = Buffer.from(privateText).toString("base64url");
      return f.google.response(value);
    }
    if (url.includes("/events?")) return f.google.response({ items: [{ ...google.events.items[0],
      [field === "event" ? "description" : field]: privateText }] });
    return f.google.normal(url, init);
  };
  const a = personalAttempt(f, slot, ["personal_read", "web_search", "web_fetch"]);
  const read = await f.app.personal.reads.read(a.id, readInput(f, slot));
  expect(read.outcome).toBe("success");
  expect((await f.app.parallel.read(a.id, "web_search", { query: privateText.replaceAll("\n", " ") })).outcome).toBe("private_context");
  expect((await f.app.parallel.read(a.id, "web_fetch", { url: `https://example.com/?q=${encodeURIComponent(encodeURIComponent(privateText))}`, fullContent: false })).outcome).toBe("private_context");
  expect(outbound).toBe(0);
  expect((await f.app.parallel.read(a.id, "web_search", { query: "public astronomy facts" })).outcome).toBe("service_error");
  expect(outbound).toBeGreaterThan(0);
  expect((await f.app.parallel.read(a.id, "web_search", { query: "fixture-google-access-value-259" })).outcome).toBe("credential_refused");
});

test.each(["send", "calendar"] as const)("write-only %s cannot disclose provider read-back content or create personal read sources", async service => {
  const f = await fixture(), isMail = service === "send", slot = isMail ? "mail" : "calendar";
  const c = await connect(f, isMail ? "gmail" : "calendar", [isMail ? "gmail.send" : "calendar.events"]); grant(f, c.id, slot);
  const a = personalAttempt(f, slot, ["personal_read", isMail ? "effect_send" : "effect_calendar"]);
  await expect(f.app.personal.reads.read(a.id, readInput(f, slot))).rejects.toThrow("personal_consent_required");
  const content: PersonalMailDraft | PersonalEventDraft = isMail ? mail() : { kind: "event", operation: "create", eventId: null, etag: null, timezone: "Asia/Bangkok", sendUpdates: "none",
    event: { summary: "Reviewed event", description: "", location: "", start: "2026-11-01T09:00:00+07:00", end: "2026-11-01T10:00:00+07:00", recurrence: [], attendees: [] } };
  const view = f.app.personal.effects.propose(a.id, retryId(), readInput(f, slot).scope, content, f.clock.now + 50000);
  f.google.hook = async () => f.google.response({ id: "sent1", summary: privateText, description: privateText, raw: privateText, etag: "fixture-google-access-value-259" });
  f.app.execute(f.auth.actor, { kind: "approval.decide", requestId: retryId(), expectedRevision: 1, payload: { effectId: view.effect.id, actionHash: view.draft.hash, decision: "approve" } });
  await f.app.personal.effects.drain();
  expect(JSON.stringify(f.app.personal.effects.view(f.auth.actor, view.draft.id))).not.toContain(privateText);
  expect(f.store.read(tx => tx.all("SELECT * FROM personal_sources"))).toEqual([]);
  if (isMail) expect(f.google.calls.some(c => c.url.includes("format=raw"))).toBe(false);
});

test.each(["ready", "waiting", "restart", "stop", "revoke", "scope", "bot", "owner", "expiry", "approved-revoke", "approved-bot", "approved-expiry"] as const)("a personal_draft survives native round completion with %s authority", async mode => {
  const f = await fixture(), c = await connect(f, "gmail", ["gmail.readonly", "gmail.send"]); grant(f, c.id);
  let turns = 0;
  f.app.authority.options.executor = { run(a, signal) {
    if (mode === "waiting") {
      f.app.personal.effects.propose(a.id, retryId(), readInput(f).scope, mail(), f.clock.now + 50000);
      return Promise.resolve({ state: "waiting" as const, text: "Waiting for owner" });
    }
    return schwayResearch(join(f.root, "native"), f.app, { provider: "scripted", id: "draft-then-return", async *stream() {
      const content = turns++ === 0 ? [{ type: "tool_call" as const, id: retryId(), name: "personal_draft", arguments: { requestId: retryId(), scope: readInput(f).scope, content: mail(), expiresAt: f.clock.now + 50000 } }]
        : [{ type: "text" as const, text: "Draft ready for the owner" }];
      yield { type: "message_complete", message: { type: "assistant", id: retryId(), content } };
    } }).run(a, signal);
  } };
  const work = f.app.execute(f.auth.actor, workCommand(f, { tools: ["effect_send"], scopes: [readInput(f).scope], limits })).work!;
  await f.app.authority.drain();
  let view = f.app.personal.effects.list(f.auth.actor, work.id)[0]!;
  expect(view.effect.state).toBe("pending"); expect(mutations(f)).toEqual([]);
  expect(f.app.authority.view(f.auth.actor, work.id).work.state).toBe("waiting");
  expect(() => f.store.read(tx => f.app.authority.guard(tx, view.draft.attemptId))).toThrow("step_fenced");
  if (mode === "restart") {
    const before = turns;
    f.reopen(); await f.app.recovery.boot(schwayRecovery(join(f.root, "native")));
    await f.app.authority.drain();
    expect(turns).toBe(before);
    expect(f.app.authority.view(f.auth.actor, work.id).work.state).toBe("waiting");
  }
  const revise = () => f.app.execute(f.auth.actor, { kind: "personal.draft.revise", requestId: retryId(), expectedRevision: view.draft.revision,
    payload: { draftId: view.draft.id, draftHash: view.draft.hash, content: { ...mail(), body: "Edited after native retirement" }, expiresAt: view.draft.expiresAt } });
  const decide = (hash = view.draft.hash) => f.app.execute(f.auth.actor, { kind: "approval.decide", requestId: retryId(), expectedRevision: view.effect.revision, payload: { effectId: view.effect.id, actionHash: hash, decision: "approve" } });
  if (["ready", "waiting", "restart"].includes(mode)) {
    const original = view; revise(); view = f.app.personal.effects.view(f.auth.actor, view.draft.id);
    expect(() => decide(original.draft.hash)).toThrow("stale_approval");
    expect(view.effect.state).toBe("pending");
    let raw = "";
    f.google.hook = async (url, init) => {
      if (url.endsWith("/send")) { raw = JSON.parse(init.body as string).raw; return f.google.response({ id: "sent1" }); }
      return f.google.response({ id: "sent1", raw });
    };
    decide(); await f.app.personal.effects.drain(); await f.app.personal.effects.drain();
    expect(f.app.personal.effects.view(f.auth.actor, view.draft.id).effect.state).toBe("succeeded");
    expect(mutations(f)).toHaveLength(1); expect(raw).toBe(personalMailRaw(view.draft));
    expect(f.app.authority.view(f.auth.actor, work.id).work.state).toBe(mode === "waiting" ? "waiting" : "ready");
  } else {
    const approved = mode.startsWith("approved-"), fence = mode.replace("approved-", "");
    if (approved) decide();
    if (fence === "stop") f.app.execute(f.auth.actor, { kind: "work.stop", requestId: retryId(), expectedRevision: f.app.authority.view(f.auth.actor, work.id).work.revision, payload: { workId: work.id } });
    if (fence === "revoke") f.app.execute(f.auth.actor, { kind: "personal.connection.revoke", requestId: retryId(), expectedRevision: c.revision, payload: { connectionId: c.id } });
    if (fence === "scope") f.app.execute(f.auth.actor, { kind: "personal.grant.set", requestId: retryId(), expectedRevision: 1, payload: { scopeId: "mail", connectionId: c.id, botId: "jit", active: false } });
    if (fence === "bot") {
      const p = f.app.execute(f.auth.actor, { kind: "bot.capabilities.propose", requestId: retryId(), expectedRevision: f.bot.revision, payload: { botId: "jit", capabilities: { tools: [], resources: [] } } }).proposal!;
      f.app.execute(f.auth.actor, { kind: "bot.capabilities.accept", requestId: retryId(), expectedRevision: p.revision, payload: { proposalId: p.id, proposalHash: p.hash } });
    }
    if (fence === "owner") f.store.transaction(tx => tx.run("UPDATE owner SET generation=generation+1"));
    if (fence === "expiry") f.clock.now += 60001;
    expect(revise).toThrow(); expect(() => decide()).toThrow();
    if (approved) await expect(f.app.authority.runEffect(view.effect.id, view.effect.revision, view.draft.hash)).rejects.toThrow();
    await f.app.personal.effects.drain(); expect(mutations(f)).toEqual([]);
  }
});

test.each(["update", "delete"] as const)("Calendar %s uses its actually-read service etag and refuses a concurrent change or forged replacement", async operation => {
  const f = await fixture(), c = await connect(f, "calendar", ["calendar.readonly", "calendar.events"]); grant(f, c.id, "calendar");
  const a = personalAttempt(f, "calendar", ["personal_read", "effect_calendar"]);
  const content: PersonalEventDraft = { kind: "event", operation, eventId: "event1", etag: null, timezone: "America/New_York", sendUpdates: "none",
    event: operation === "delete" ? null : { summary: "Changed title", description: "", location: "", start: "2026-11-01T01:30:00-04:00", end: "2026-11-01T02:30:00-05:00", recurrence: [], attendees: [] } };
  const propose = (value = content) => f.app.personal.effects.propose(a.id, retryId(), readInput(f, "calendar").scope, value, f.clock.now + 50000);
  expect(propose).toThrow("personal_event_revision_required");
  const read = await f.app.personal.reads.read(a.id, readInput(f, "calendar"));
  const source = read.evidence[0]!;
  expect(() => propose({ ...content, etag: '"forged-current-version"' })).toThrow("personal_event_revision_changed");
  const view = propose();
  expect(view.draft.eventSource).toEqual(source.source);
  expect((view.draft.content as PersonalEventDraft).etag).toBe(source.eventEtag!);
  expect(view.effect.action.content).toContain(source.source.id);
  expect(view.effect.action.content).toContain(JSON.stringify(source.eventEtag));
  f.google.hook = async () => f.google.response({ id: source.providerId, etag: '"changed-concurrently"', start: { timeZone: "America/New_York" } });
  f.app.execute(f.auth.actor, { kind: "approval.decide", requestId: retryId(), expectedRevision: 1, payload: { effectId: view.effect.id, actionHash: view.draft.hash, decision: "approve" } });
  expect((await f.app.authority.runEffect(view.effect.id, 1, view.draft.hash)).state).toBe("failed");
  expect(mutations(f)).toEqual([]);
  const current = propose();
  let changed = false;
  f.google.hook = async (_url, init) => {
    if (init.method === "PATCH" || init.method === "DELETE") {
      expect((init.headers as Record<string, string>)["If-Match"]).toBe(source.eventEtag!);
      changed = true; return f.google.response({});
    }
    return f.google.response(changed ? operation === "delete" ? { id: source.providerId, status: "cancelled" } : { ...personalEventBody(current.draft.content as PersonalEventDraft), id: source.providerId, etag: '"new-etag"' }
      : { id: source.providerId, etag: source.eventEtag, start: { timeZone: "America/New_York" } });
  };
  f.app.execute(f.auth.actor, { kind: "approval.decide", requestId: retryId(), expectedRevision: 1, payload: { effectId: current.effect.id, actionHash: current.draft.hash, decision: "approve" } });
  expect((await f.app.authority.runEffect(current.effect.id, 1, current.draft.hash)).state).toBe("succeeded");
  expect(mutations(f)).toHaveLength(1);
});

test.each(["parts", "combined", "body", "header", "description", "location", "title", "recurrence"] as const)("%s truncation is a visible service gap and cannot be quiet no_update", async mode => {
  const f = await fixture(), calendar = ["description", "location", "title", "recurrence"].includes(mode), slot = calendar ? "calendar" : "mail";
  const c = await connect(f, calendar ? "calendar" : "gmail"); grant(f, c.id, slot);
  f.google.hook = async (url, init) => {
    if (/\/messages\/mail[12]/.test(url)) {
      const value = structuredClone(google.message);
      value.id = url.includes("mail1") ? "mail1" : "mail2";
      if (mode === "header") value.payload.headers[0]!.value = "s".repeat(513);
      else value.payload.parts = Array.from({ length: mode === "parts" ? 9 : mode === "combined" ? 2 : 1 }, () => ({ mimeType: "text/plain", body: { size: 3000, data: Buffer.from("x".repeat(mode === "body" ? 4097 : mode === "parts" ? 8 : 3000)).toString("base64url") } }));
      return f.google.response(value);
    }
    if (url.includes("/events?")) return f.google.response({ items: [{ ...google.events.items[0],
      [mode === "title" ? "summary" : mode]: mode === "recurrence" ? ["RRULE:" + "X".repeat(513)] : "x".repeat(mode === "description" ? 4097 : 513) }] });
    return f.google.normal(url, init);
  };
  f.app.authority.options.executor = { async run(a) {
    const read = await f.app.personal.reads.read(a.id, readInput(f, slot));
    expect(read.outcome).toBe("partial"); expect(read.missing.length).toBeGreaterThan(0);
    return { state: "ready", text: '{"outcome":"no_update","proposals":[]}' };
  } };
  const routine = f.app.execute(f.auth.actor, routineCommand(f, { tools: ["personal_read"], scopes: [readInput(f, slot).scope], limits })).routine;
  f.clock.now += 60000; f.app.routines.tick(); await f.app.authority.drain();
  const occurrence = f.app.routines.view(f.auth.actor, routine.id).history[0]!;
  expect(occurrence.outcome).toBe("failed");
  expect(f.app.personal.reads.brief(f.auth.actor, occurrence.workId!).status).toBe("partial");
  expect(f.app.attention.view(f.auth.actor).items).toHaveLength(1);
});
