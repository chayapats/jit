import { afterEach, expect, test } from "bun:test";
import { copyFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { schwayResearch } from "../src/s14/research";
import { schwayRecovery } from "../src/s14/native-recovery";
import { replayPolicy } from "../src/s14/replay-policy";
import type { Attempt } from "../src/s14/authority-types";
import type { ReportEvidence, ReportProposal } from "../src/s14/report-types";
import { retryId, routineCommand, secondBot, workCommand } from "./fixtures/s14-domain";
import { connect, grant, personalAttempt, personalFixture, readInput, type PersonalFixture } from "./fixtures/s14-personal";

const fixtures: PersonalFixture[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.dispose(); });
async function fixture(options: Parameters<typeof personalFixture>[0] = {}) { const f = await personalFixture(options); fixtures.push(f); return f; }
const limits = { attempts: 4, steps: 4, calls: 64, outputBytes: 131072, wallMs: 1800000, concurrency: 2, reads: 20 };
function proposal(source: ReportEvidence): ReportProposal {
  return { title: "Sourced personal brief", claims: [{ id: "personal_fact", text: source.content, kind: "quote",
    citations: [{ attemptId: source.attemptId, id: source.id, revision: source.revision, quote: source.content, scope: "excerpt" }],
    covers: [], conflicts: [] }], missing: [], limitations: [], artifactIds: [] };
}
function available(f: PersonalFixture, workId: string) {
  const view = f.app.reports.list(f.auth.actor, workId)[0]!;
  expect(view?.state).toBe("available");
  if (view?.state !== "available") throw Error("Missing personal report");
  return view;
}

test.each(["gmail", "calendar"] as const)("default resource policy needs no environment configuration for an owner-accepted %s slot, work read and routine brief", async service => {
  const f = await fixture({ policy: { routes: [{ id: "selected", provider: "codex", model: "fixture" }],
    tools: ["personal_read", "effect_send", "effect_calendar"], resources: [] } });
  const c = await connect(f, service), scopeId = "share_slot_01";
  expect(f.app.policy.resources).toEqual([]);
  expect(f.app.home(f.auth.actor).bots[0]!.capabilities.resources).toEqual([]);
  expect(() => grant(f, c.id, scopeId)).toThrow("personal_bot_scope_refused");
  const capability = f.app.execute(f.auth.actor, { kind: "bot.capabilities.propose", requestId: retryId(), expectedRevision: f.bot.revision,
    payload: { botId: "jit", capabilities: { tools: [...f.app.policy.tools], resources: [scopeId] } } }).proposal!;
  expect(() => grant(f, c.id, scopeId)).toThrow("personal_bot_scope_refused");
  const accept = { kind: "bot.capabilities.accept" as const, requestId: retryId(), expectedRevision: capability.revision,
    payload: { proposalId: capability.id, proposalHash: capability.hash } };
  expect(() => f.app.execute(f.auth.actor, { ...accept, payload: { ...accept.payload, proposalHash: "forged" } })).toThrow("stale_capability_proposal");
  f.app.execute(f.auth.actor, accept);
  expect(() => grant(f, c.id, scopeId)).toThrow("personal_bot_scope_refused");
  await f.app.botLifecycle.drain({ async open() { throw new Error("No native session exists before first work"); } });
  expect(() => grant(f, c.id, "share_slot_02")).toThrow("personal_bot_scope_refused");
  expect(() => grant(f, c.id, "share_slot_65")).toThrow("personal_bot_scope_refused");
  grant(f, c.id, scopeId);
  expect(f.app.authority.list(f.auth.actor)).toEqual([]);
  expect(f.app.sharing.freeSlots(f.auth.actor).some(slot => slot.scopeId === scopeId)).toBe(false);
  const attempt = personalAttempt(f, scopeId);
  expect((await f.app.personal.reads.read(attempt.id, readInput(f, scopeId))).outcome).toBe("success");
  expect(f.app.personal.reads.brief(f.auth.actor, attempt.workId).status).toBe("complete");
  const evidence = f.store.read(tx => f.app.personal.reads.evidence(tx, attempt.id)[0]!);
  const target = { kind: "source" as const, id: evidence.id, revision: evidence.revision, generation: evidence.generation };
  const currentBot = f.app.home(f.auth.actor).bots.find(bot => bot.id === "jit")!;
  expect(() => f.app.execute(f.auth.actor, { kind: "snapshot.share", requestId: retryId(), expectedRevision: currentBot.revision,
    payload: { scopeId, target, receiverBotId: "jit", workId: null, expiresAt: f.clock.now + 60000 } })).toThrow("snapshot_share_exists");
  f.app.authority.commit(attempt.id, { state: "ready", text: "Sourced brief", report: proposal(evidence) });
  f.app.authority.settle(attempt.id);
  f.app.authority.options.executor = { async run(a, signal) {
    await f.app.personal.reads.read(a.id, readInput(f, scopeId), signal);
    return { state: "ready", text: '{"outcome":"report","text":"Sourced routine brief"}', report: proposal(f.store.read(tx => f.app.personal.reads.evidence(tx, a.id)[0]!)) };
  } };
  const routine = f.app.execute(f.auth.actor, routineCommand(f, { tools: ["personal_read"], scopes: [readInput(f, scopeId).scope], limits })).routine;
  f.clock.now += 60000; f.app.routines.tick(); await f.app.authority.drain();
  const occurrence = f.app.routines.view(f.auth.actor, routine.id).history[0]!;
  expect(occurrence).toMatchObject({ state: "complete", outcome: "report" });
  expect(f.app.personal.reads.brief(f.auth.actor, occurrence.workId!).status).toBe("complete");
  expect(available(f, occurrence.workId!).report.missing.filter(gap => gap.kind === "read" && gap.personal)).toEqual([]);
  expect(f.app.policy.resources).toEqual([]);
});

test("personal grants still refuse an accepted custom resource removed from live installation policy", async () => {
  const f = await fixture(), c = await connect(f);
  f.app.policy.resources.splice(f.app.policy.resources.indexOf("mail"), 1);
  expect(() => grant(f, c.id)).toThrow("personal_bot_scope_refused");
  expect(f.app.personal.settings(f.auth.actor).grants).toEqual([]);
});

test.each(["report", "no_update"] as const)("an unread requested account makes the service brief partial and prevents routine %s success", async outcome => {
  const f = await fixture(), mail = await connect(f), calendar = await connect(f, "calendar");
  grant(f, mail.id); grant(f, calendar.id, "calendar");
  const scopes = [readInput(f).scope, readInput(f, "calendar").scope];
  f.app.authority.options.executor = { async run(a, signal) {
    await f.app.personal.reads.read(a.id, readInput(f), signal);
    return { state: "ready", text: JSON.stringify({ outcome, text: "Sourced routine brief" }), ...(outcome === "report" ? {
      report: proposal(f.store.read(tx => f.app.personal.reads.evidence(tx, a.id)[0]!)),
    } : {}) };
  } };
  const routine = f.app.execute(f.auth.actor, routineCommand(f, { tools: ["personal_read"], scopes, limits })).routine;
  f.clock.now += 60000; f.app.routines.tick(); await f.app.authority.drain();
  const occurrence = f.app.routines.view(f.auth.actor, routine.id).history[0]!;
  expect(occurrence.outcome).toBe("failed");
  expect(f.app.personal.reads.brief(f.auth.actor, occurrence.workId!)).toMatchObject({ status: "partial", sections: [{ outcome: "success" }] });
  expect(f.store.read(tx => f.app.personal.reads.gaps(tx, occurrence.workId!))).toEqual([
    { kind: "read", readId: "personal_input_calendar", outcome: "blocked", personal: { scopeId: "calendar", stale: false, missing: ["required_input_missing"] } },
  ]);
  if (outcome === "report") expect(available(f, occurrence.workId!).report.coverage).toBe("partial");
});

test.each(["gmail", "calendar"] as const)("a readonly account plus a write-only %s account has no unread gap and can produce a brief or quiet routine", async service => {
  const f = await fixture(), reader = await connect(f, service === "gmail" ? "calendar" : "gmail");
  const writer = await connect(f, service, [service === "gmail" ? "gmail.send" : "calendar.events"]);
  grant(f, reader.id, "mail"); grant(f, writer.id, "calendar");
  const scopes = [readInput(f).scope, readInput(f, "calendar").scope];
  let outcome: "report" | "no_update" = "report";
  f.app.authority.options.executor = { async run(a, signal) {
    await expect(f.app.personal.reads.read(a.id, readInput(f, "calendar"), signal)).rejects.toThrow("personal_consent_required");
    await f.app.personal.reads.read(a.id, readInput(f), signal);
    return { state: "ready", text: JSON.stringify({ outcome, text: "Sourced routine brief" }), ...(outcome === "report" ? {
      report: proposal(f.store.read(tx => f.app.personal.reads.evidence(tx, a.id)[0]!)),
    } : {}) };
  } };
  const routine = f.app.execute(f.auth.actor, routineCommand(f, { tools: ["personal_read"], scopes, limits })).routine;
  for (const expected of ["report", "no_update"] as const) {
    outcome = expected;
    f.clock.now += 60000; f.app.routines.tick(); await f.app.authority.drain();
    const occurrence = f.app.routines.view(f.auth.actor, routine.id).history[0]!;
    expect(occurrence).toMatchObject({ state: "complete", outcome: expected });
    expect(f.app.personal.reads.brief(f.auth.actor, occurrence.workId!).status).toBe("complete");
    expect(f.store.read(tx => f.app.personal.reads.gaps(tx, occurrence.workId!))).toEqual([]);
    if (expected === "report") expect(available(f, occurrence.workId!).report.missing.filter(gap => gap.kind === "read" && gap.personal)).toEqual([]);
  }
});

test.each(["gmail", "calendar"] as const)("native %s routine commits an actually-read cited brief through the ordinary report validator and credential-free artifacts", async service => {
  const f = await fixture(), c = await connect(f, service), scopeId = service === "gmail" ? "mail" : "calendar";
  grant(f, c.id, scopeId);
  f.app.authority.options.executor = { run(a, signal) {
    let turn = 0;
    return schwayResearch(join(f.root, "native"), f.app, { provider: "scripted", id: "personal-routine", async *stream() {
      const content = turn++ === 0 ? [{ type: "tool_call" as const, id: retryId(), name: "personal_read", arguments: readInput(f, scopeId) }]
        : [{ type: "text" as const, text: JSON.stringify({ outcome: "report", text: "Personal brief for owner review",
          report: proposal(f.store.read(tx => f.app.personal.reads.evidence(tx, a.id)[0]!)), proposals: [] }) }];
      yield { type: "message_complete", message: { type: "assistant", id: retryId(), content } };
    } }).run(a, signal);
  } };
  const routine = f.app.execute(f.auth.actor, routineCommand(f, { tools: ["personal_read"], scopes: [readInput(f, scopeId).scope], limits })).routine;
  f.clock.now += 60000; f.app.routines.tick(); await f.app.authority.drain();
  const occurrence = f.app.routines.view(f.auth.actor, routine.id).history[0]!;
  expect(occurrence).toMatchObject({ state: "complete", outcome: "report" });
  const view = available(f, occurrence.workId!);
  expect(view.report.claims[0]).toMatchObject({ support: "supported", evidence: [{ provider: "google", tool: "personal_read", mode: "oauth", coverage: "excerpt", connectionId: c.id }] });
  expect(view.report.claims[0]!.evidence[0]!.retrievedAt).toBe(f.clock.now);
  if (service === "calendar") expect(view.report.claims[0]!.evidence[0]).toMatchObject({ timezone: "America/New_York", calendarTimezone: "America/New_York", window: { timezone: "Asia/Bangkok" } });
  const review = f.app.reports.review(f.auth.actor, occurrence.workId!);
  f.app.execute(f.auth.actor, { kind: "report.review.accept", requestId: retryId(), expectedRevision: review.revision,
    payload: { reportId: view.report.id, reportRevision: view.report.revision } });
  expect(available(f, occurrence.workId!).completion).toBe("owner_accepted");
  const files = view.artifacts.map(file => Buffer.from(f.app.artifacts.download(f.auth.actor, file.id).bytes).toString());
  const snapshot = join(f.root, "credential-free-image.sqlite"); copyFileSync(f.path, snapshot);
  const exported = [readFileSync(snapshot).toString("latin1"), readFileSync(`${f.path}.lifecycle.sqlite`).toString("latin1"), ...files].join("\n");
  for (const secret of ["fixture-google-client-secret-259", "fixture-google-access-value-259", "fixture-google-refresh-value-259", "fixture-authorization-code-259"]) expect(exported).not.toContain(secret);
  expect(files.join("\n")).toContain('"provider": "google"');
  f.clock.now += 1800001;
  expect(available(f, occurrence.workId!).report.id).toBe(view.report.id);
  f.app.execute(f.auth.actor, { kind: "personal.connection.revoke", requestId: retryId(), expectedRevision: c.revision, payload: { connectionId: c.id } });
  expect(f.app.reports.view(f.auth.actor, view.report.id).state).toBe("unavailable");
  expect(() => f.app.artifacts.download(f.auth.actor, view.artifacts[0]!.id)).toThrow();
  f.store.close(); copyFileSync(snapshot, f.path); f.reopen();
  expect(f.app.reports.view(f.auth.actor, view.report.id).state).toBe("unavailable");
  expect(f.app.reports.review(f.auth.actor, occurrence.workId!).acceptance).toBeNull();
});

test.each(["id", "quote"] as const)("personal report rejects invented %s atomically through the routine publication path", async changed => {
  const f = await fixture(), c = await connect(f); grant(f, c.id);
  f.app.authority.options.executor = { async run(a) {
    await f.app.personal.reads.read(a.id, readInput(f));
    const report = proposal(f.store.read(tx => f.app.personal.reads.evidence(tx, a.id)[0]!));
    if (changed === "id") report.claims[0]!.citations[0]!.id = "unread_personal_source";
    else report.claims[0]!.citations[0]!.quote = "Invented mail";
    return { state: "ready", text: '{"outcome":"report"}', report,
      proposals: [{ title: "Must roll back", purpose: "No authority", completionRule: "Review" }] };
  } };
  const routine = f.app.execute(f.auth.actor, routineCommand(f, { tools: ["personal_read"], scopes: [readInput(f).scope], limits })).routine;
  f.clock.now += 60000; f.app.routines.tick(); await f.app.authority.drain();
  const occurrence = f.app.routines.view(f.auth.actor, routine.id).history[0]!;
  expect(occurrence).toMatchObject({ outcome: "failed", proposals: [] });
  expect(f.app.reports.list(f.auth.actor, occurrence.workId!)).toEqual([]);
  expect(f.app.authority.list(f.auth.actor).some(w => w.title === "Must roll back")).toBe(false);
});

test("a successful personal read plus a model report claim cannot bypass committed report validation", async () => {
  const f = await fixture(), c = await connect(f); grant(f, c.id);
  f.app.authority.options.executor = { async run(a) {
    await f.app.personal.reads.read(a.id, readInput(f));
    return { state: "ready", text: '{"outcome":"report","text":"Done"}' };
  } };
  const routine = f.app.execute(f.auth.actor, routineCommand(f, { tools: ["personal_read"], scopes: [readInput(f).scope], limits })).routine;
  f.clock.now += 60000; f.app.routines.tick(); await f.app.authority.drain();
  expect(f.app.routines.view(f.auth.actor, routine.id).history[0]).toMatchObject({ outcome: "failed", reason: "routine_report_missing" });
});

test("personal input gaps remain service facts and a failed brief never hides an open owner decision", async () => {
  const f = await fixture(), c = await connect(f); grant(f, c.id);
  f.google.hook = async (url, init) => url.includes("/messages/mail2") ? f.google.response({}, 503) : f.google.normal(url, init);
  f.app.authority.options.executor = { async run(a) {
    await f.app.personal.reads.read(a.id, readInput(f));
    return { state: "ready", text: '{"outcome":"report"}', report: proposal(f.store.read(tx => f.app.personal.reads.evidence(tx, a.id)[0]!)),
      proposals: [{ title: "Owner choice", purpose: "Outside routine", completionRule: "Review" }] };
  } };
  const routine = f.app.execute(f.auth.actor, routineCommand(f, { tools: ["personal_read"], scopes: [readInput(f).scope], limits, occurrenceBudget: 1 })).routine;
  f.clock.now += 60000; f.app.routines.tick(); await f.app.authority.drain();
  const occurrence = f.app.routines.view(f.auth.actor, routine.id).history[0]!;
  expect(occurrence.outcome).toBe("failed");
  const report = available(f, occurrence.workId!).report;
  expect(report.coverage).toBe("partial");
  expect(report.missing).toContainEqual(expect.objectContaining({ kind: "read", outcome: "partial", personal: { scopeId: "mail", stale: false, missing: ["mail_message_or_attachment_failed"] } }));
  expect(f.app.routines.attention(f.auth.actor).find(r => r.routine.id === routine.id)?.decisions.count).toBe(1);
  expect(f.app.attention.view(f.auth.actor).items[0]).toMatchObject({ reason: "routine_failed", proposalIds: occurrence.proposals });
  expect(f.app.authority.view(f.auth.actor, occurrence.proposals[0]!).work).toMatchObject({ state: "proposed", grantId: null });
});

test.each(["missing", "stale"] as const)("personal %s input cannot be omitted from a committed report's service gaps", async mode => {
  const f = await fixture(), c = await connect(f); grant(f, c.id);
  f.app.authority.options.executor = { async run(a) {
    if (mode === "stale") { await f.app.personal.reads.read(a.id, readInput(f)); f.clock.now += 900001; }
    return { state: "ready", text: '{"outcome":"report"}', report: { title: "Omitted input",
      claims: [{ id: "claim", text: "Model did not mention the missing input", kind: "inference", citations: [], covers: [], conflicts: [] }], missing: [], limitations: [], artifactIds: [] } };
  } };
  const routine = f.app.execute(f.auth.actor, routineCommand(f, { tools: ["personal_read"], scopes: [readInput(f).scope], limits })).routine;
  f.clock.now += 60000; f.app.routines.tick(); await f.app.authority.drain();
  const occurrence = f.app.routines.view(f.auth.actor, routine.id).history[0]!;
  expect(occurrence.outcome).toBe("failed");
  const gap = available(f, occurrence.workId!).report.missing.find(g => g.kind === "read");
  expect(gap).toMatchObject({ kind: "read", personal: { scopeId: "mail", stale: mode === "stale", missing: mode === "missing" ? ["required_input_missing"] : [] } });
});

test("personal captured routines wait for native close at boot and reject a changed account resource capture", async () => {
  const f = await fixture(), c = await connect(f); grant(f, c.id);
  const old = personalAttempt(f);
  f.app.recovery.intent(old.id, old.memoryId!, old.snapshot.route);
  const routine = f.app.execute(f.auth.actor, routineCommand(f, { tools: ["personal_read"], scopes: [readInput(f).scope], limits })).routine;
  f.reopen(); f.clock.now += 60000;
  const closing = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const native = schwayRecovery(join(f.root, "native"));
  const boot = f.app.recovery.boot({ async open(intent) {
    const host = await native.open(intent);
    return { ...host, async close() { closing.resolve(); await release.promise; await host.close(); } };
  } });
  await closing.promise;
  const before = f.google.calls.length;
  f.app.authority.options.executor = { async run(a) {
    expect(f.app.recovery.booting).toBe(false);
    await f.app.personal.reads.read(a.id, readInput(f));
    return { state: "ready", text: '{"outcome":"no_update"}' };
  } };
  f.app.routines.tick(); await f.app.authority.drain();
  expect(f.app.routines.view(f.auth.actor, routine.id).history).toEqual([]);
  expect(f.google.calls.length).toBe(before);
  release.resolve(); await boot;
  f.app.routines.tick(); await f.app.authority.drain();
  expect(f.app.routines.view(f.auth.actor, routine.id).history[0]!.outcome).toBe("no_update");
  const replacement = await connect(f);
  f.app.execute(f.auth.actor, { kind: "personal.grant.set", requestId: retryId(), expectedRevision: 1,
    payload: { scopeId: "mail", connectionId: replacement.id, botId: "jit", active: true } });
  f.clock.now += 60000;
  const changedAt = f.google.calls.length;
  f.app.routines.tick(); await f.app.authority.drain();
  expect(f.app.routines.view(f.auth.actor, routine.id).routine.state).toBe("blocked");
  expect(f.google.calls.length).toBe(changedAt);
});

test.each(["retire", "capabilities"] as const)("Bot %s retains exact committed personal evidence but fences old reads, contexts and captured routines", async action => {
  const f = await fixture(), c = await connect(f), bot = await secondBot(f); grant(f, c.id, "other", bot.id);
  const scope = readInput(f, "other").scope;
  const routine = f.app.execute(f.auth.actor, routineCommand(f, { bots: [{ id: bot.id, revision: bot.revision }], tools: ["personal_read"], scopes: [scope], limits })).routine;
  const work = f.app.execute(f.auth.actor, workCommand(f, { bots: [{ id: bot.id, revision: bot.revision }], tools: ["personal_read"], scopes: [scope], limits })).work!;
  const a = f.app.authority.admit(work.id, retryId(), { botId: bot.id, tools: ["personal_read"], scopes: [scope], input: "Personal brief", calls: 32, outputBytes: 65536 });
  const read = await f.app.personal.reads.read(a.id, readInput(f, "other"));
  f.app.authority.commit(a.id, { state: "ready", text: "Retained personal brief", report: proposal(f.store.read(tx => f.app.personal.reads.evidence(tx, a.id)[0]!)) });
  f.app.authority.settle(a.id);
  const view = available(f, work.id);
  if (action === "retire") {
    const preview = f.app.botLifecycle.preview(f.auth.actor, bot.id, "retire");
    f.app.execute(f.auth.actor, { kind: "bot.retire", requestId: retryId(), expectedRevision: bot.revision, payload: { botId: bot.id, previewHash: preview.hash, retain: { history: true, evidence: true } } });
  } else {
    const p = f.app.execute(f.auth.actor, { kind: "bot.capabilities.propose", requestId: retryId(), expectedRevision: bot.revision,
      payload: { botId: bot.id, capabilities: { tools: [], resources: [] } } }).proposal!;
    f.app.execute(f.auth.actor, { kind: "bot.capabilities.accept", requestId: retryId(), expectedRevision: p.revision, payload: { proposalId: p.id, proposalHash: p.hash } });
  }
  expect(available(f, work.id).report.id).toBe(view.report.id);
  expect(f.app.personal.reads.brief(f.auth.actor, work.id).sections[0]!.evidence).toEqual(read.evidence);
  await expect(f.app.personal.reads.read(a.id, readInput(f, "other"))).rejects.toThrow();
  expect(f.store.read(tx => f.app.memory.sourceCurrent(tx, read.evidence[0]!.source, bot.id))).toBe(false);
  expect(f.app.routines.view(f.auth.actor, routine.id).routine.state).toBe("blocked");
  f.reopen(); expect(available(f, work.id).report.id).toBe(view.report.id);
  f.app.execute(f.auth.actor, { kind: "personal.connection.revoke", requestId: retryId(), expectedRevision: c.revision, payload: { connectionId: c.id } });
  expect(f.app.reports.view(f.auth.actor, view.report.id).state).toBe("unavailable");
});

test.each(["effect_send", "effect_calendar"])("trusted research with %s stays reconcile-only on boot and never performs a write", async tool => {
  const f = await fixture(), c = await connect(f, tool === "effect_send" ? "gmail" : "calendar", [tool === "effect_send" ? "gmail.send" : "calendar.events"]);
  const scopeId = tool === "effect_send" ? "mail" : "calendar"; grant(f, c.id, scopeId);
  const a = personalAttempt(f, scopeId, [tool]);
  const graphAttempt: Attempt = { ...a, step: { id: "trusted_research", handler: "research", inputs: [], gaps: [] } };
  expect(replayPolicy(graphAttempt).replay).toBe("reconcile_only");
  expect(replayPolicy({ ...graphAttempt, snapshot: { ...graphAttempt.snapshot, tools: [] } }).replay).toBe("replay_safe");
  f.store.transaction(tx => f.app.recovery.dispatch(tx, a.id));
  f.reopen();
  await f.app.recovery.boot(schwayRecovery(join(f.root, "native")));
  await f.app.authority.drain(); await f.app.personal.effects.drain();
  expect(f.app.recovery.view(f.auth.actor).checkpoints.find(cp => cp.id === a.id)?.replay).toBe("reconcile_only");
  expect(f.google.calls.filter(call => call.init.method && call.init.method !== "GET" && !call.url.endsWith("/token"))).toEqual([]);
});

test("personal graph handoff keeps actually-read excerpts for the same Bot and refuses another Bot's account-private text", async () => {
  const f = await fixture(), c = await connect(f); grant(f, c.id);
  const other = await secondBot(f);
  const work = f.app.execute(f.auth.actor, workCommand(f, { bots: [{ id: "jit", revision: f.bot.revision }, { id: other.id, revision: other.revision }], tools: ["personal_read"], scopes: [readInput(f).scope], limits })).work!;
  // Use the trusted graph already captured at work start; only the account-owning lane can read.
  f.app.authority.options.executor = { async run(a) {
    if (a.step!.handler === "research") {
      if (a.snapshot.bot.id !== "jit") return { state: "ready", text: "No private account input" };
      const read = await f.app.personal.reads.read(a.id, readInput(f));
      const receiver = { ...a, snapshot: { ...a.snapshot, bot: other } };
      expect(f.store.read(tx => f.app.memory.handoff(tx, read.evidence[0]!.source, receiver))).toBe(false);
      return { state: "ready", text: "Committed personal evidence" };
    }
    const source = a.step!.inputs.flatMap(input => input.evidence).find(e => e.tool === "personal_read")!;
    expect(source).toBeDefined();
    return { state: "ready", text: "Sourced synthesis", report: proposal(source) };
  } };
  await f.app.authority.drain();
  expect(available(f, work.id).report.claims[0]!.support).toBe("supported");
});

test.each(["snapshot", "memory"] as const)("personal account slots cannot be reinterpreted by %s sharing, including stale-image restoration", async kind => {
  const f = await fixture(), c = await connect(f), other = await secondBot(f);
  const claim = f.app.execute(f.auth.actor, { kind: "memory.remember", requestId: retryId(),
    expectedRevision: f.app.conversation(f.auth.actor, f.conversationId).conversation.revision,
    payload: { conversationId: f.conversationId, text: "Owner-authored snapshot" } }).claim!;
  const found = f.store.read(tx => f.app.memory.lookup(tx, "jit", claim));
  if (found.state !== "available") throw Error("Missing owner source");
  const snapshot = join(f.root, "before-personal-slot.sqlite"); copyFileSync(f.path, snapshot);
  grant(f, c.id);
  const share = () => kind === "snapshot" ? f.app.execute(f.auth.actor, { kind: "snapshot.share", requestId: retryId(), expectedRevision: other.revision,
    payload: { scopeId: "mail", target: { kind: "source", ...found.claim.source }, receiverBotId: other.id, workId: null, expiresAt: f.clock.now + 60000 } })
    : f.app.execute(f.auth.actor, { kind: "memory.share", requestId: retryId(), expectedRevision: 1,
      payload: { scopeId: "mail", claim, receiverBotId: other.id, expiresAt: f.clock.now + 60000 } });
  expect(f.app.sharing.freeSlots(f.auth.actor).some(s => s.scopeId === "mail")).toBe(false);
  expect(share).toThrow(kind === "snapshot" ? "snapshot_share_exists" : "memory_share_exists");
  f.app.execute(f.auth.actor, { kind: "personal.grant.set", requestId: retryId(), expectedRevision: 1,
    payload: { scopeId: "mail", connectionId: c.id, botId: "jit", active: false } });
  f.store.close(); copyFileSync(snapshot, f.path); f.reopen();
  expect(f.app.sharing.freeSlots(f.auth.actor).some(s => s.scopeId === "mail")).toBe(false);
  expect(share).toThrow(kind === "snapshot" ? "snapshot_share_exists" : "memory_share_exists");
});

test.each(["snapshot", "memory"] as const)("an existing %s share slot cannot become a personal account grant", async kind => {
  const f = await fixture(), c = await connect(f), other = await secondBot(f);
  const claim = f.app.execute(f.auth.actor, { kind: "memory.remember", requestId: retryId(),
    expectedRevision: f.app.conversation(f.auth.actor, f.conversationId).conversation.revision,
    payload: { conversationId: f.conversationId, text: "Owner-authored shared fact" } }).claim!;
  const found = f.store.read(tx => f.app.memory.lookup(tx, "jit", claim));
  if (found.state !== "available") throw Error("Missing owner source");
  if (kind === "snapshot") f.app.execute(f.auth.actor, { kind: "snapshot.share", requestId: retryId(), expectedRevision: other.revision,
    payload: { scopeId: "other", target: { kind: "source", ...found.claim.source }, receiverBotId: other.id, workId: null, expiresAt: f.clock.now + 60000 } });
  else f.app.execute(f.auth.actor, { kind: "memory.share", requestId: retryId(), expectedRevision: 1,
    payload: { scopeId: "other", claim, receiverBotId: other.id, expiresAt: f.clock.now + 60000 } });
  expect(() => grant(f, c.id, "other")).toThrow("personal_scope_exists");
});
