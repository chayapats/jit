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
async function fixture() { const f = await personalFixture(); fixtures.push(f); return f; }
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
