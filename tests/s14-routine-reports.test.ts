import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { artifactHash } from "../src/s14/artifacts";
import type { ReportProposal } from "../src/s14/report-types";
import { schwayResearch } from "../src/s14/research";
import { domainFixture, retryId, routineCommand, type DomainFixture } from "./fixtures/s14-domain";
import anonymous from "./fixtures/parallel/tools-anonymous.json";
import fetchFixture from "./fixtures/parallel/fetch.json";

const fixtures: DomainFixture[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.dispose(); });
async function fixture() {
  const f = await domainFixture({ parallel: { transport: async (_url, init) => {
    const wire = JSON.parse(init.body as string);
    if (wire.method === "initialize") return Response.json({ jsonrpc: "2.0", id: wire.id, result: {
      protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" },
    } });
    if (wire.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (wire.method === "tools/list") return Response.json(anonymous);
    if (wire.method === "tools/call") return Response.json(fetchFixture);
    throw Error("unexpected fixture protocol");
  } } });
  fixtures.push(f);
  const routine = f.app.execute(f.auth.actor, routineCommand(f, { tools: ["web_fetch"],
    limits: { attempts: 2, steps: 2, calls: 8, reads: 4, outputBytes: 131072, wallMs: 60000, concurrency: 1 },
    requiredEvidence: [{ id: "page", label: "Read the page", url: "https://example.com/article", coverage: "full_content_returned", freshness: "any" }],
  })).routine;
  f.clock.now += 60000;
  return { f, routine };
}

test.each(["routine", "ordinary"] as const)("native routine %s envelope commits a cited report and staged download through the ordinary validator", async envelope => {
  const { f, routine } = await fixture();
  f.app.execute(f.auth.actor, { kind: "attention.set", requestId: retryId(), expectedRevision: 0, payload: { level: "all" } });
  const bytes = new TextEncoder().encode("# Captured routine file\n");
  f.app.authority.options.executor = { run(a, signal) {
    let turns = 0;
    return schwayResearch(join(f.root, "native"), f.app, { provider: "scripted", id: "routine-report", async *stream() {
      let content;
      if (turns++ === 0) content = [{ type: "tool_call" as const, id: retryId(), name: "web_fetch", arguments: { url: "https://example.com/article", fullContent: true } }];
      else {
        const source = f.app.parallel.inspect(f.auth.actor, a.workId).evidence[0]!;
        const staged = f.store.transaction(tx => f.app.artifacts.stage(tx, a, {
          name: "routine.md", mediaType: "text/markdown", size: bytes.length, sha256: artifactHash(bytes),
        }, bytes));
        const report: ReportProposal = { title: "Routine cited report", claims: [{ id: "page_claim", text: source.content, kind: "quote",
          citations: [{ attemptId: a.id, id: source.id, revision: source.revision, quote: source.content, scope: "page" }], covers: ["page"], conflicts: [] }],
          missing: [], limitations: [], artifactIds: [staged.id] };
        content = [{ type: "text" as const, text: JSON.stringify({ ...(envelope === "routine" ? { outcome: "report", proposals: [] } : {}), text: "Sourced routine summary", report }) }];
      }
      yield { type: "message_complete", message: { type: "assistant", id: retryId(), content } };
    } }).run(a, signal);
  } };
  f.app.routines.tick(); await f.app.authority.drain();
  const occurrence = f.app.routines.view(f.auth.actor, routine.id).history[0]!;
  expect(occurrence).toMatchObject({ state: "complete", outcome: "report" });
  const view = f.app.reports.list(f.auth.actor, occurrence.workId!)[0]!;
  if (view.state !== "available") throw Error("routine report missing");
  expect(view.report.coverage).toBe("covered");
  expect(view.report.claims[0]!.support).toBe("supported");
  expect(view.completion).toBe("owner_review_required");
  expect(view.artifacts).toHaveLength(3);
  const download = f.app.artifacts.download(f.auth.actor, view.artifacts.find(file => file.name === "routine.md")!.id);
  expect(download.bytes).toEqual(bytes);
  expect(f.app.attention.view(f.auth.actor).items[0]!.reason).toBe("routine_report");
});

test("routine report rejects an invented citation atomically, including proposals and staged files", async () => {
  const { f, routine } = await fixture();
  f.app.authority.options.executor = { run(a, signal) {
    return schwayResearch(join(f.root, "native"), f.app, { provider: "scripted", id: "routine-invalid-citation", async *stream() {
      const bytes = new TextEncoder().encode("# Unpublished staged routine file\n");
      const staged = f.store.transaction(tx => f.app.artifacts.stage(tx, a, {
        name: "unpublished.md", mediaType: "text/markdown", size: bytes.length, sha256: artifactHash(bytes),
      }, bytes));
      const report: ReportProposal = { title: "Fabricated routine report", claims: [{ id: "fake", text: "Invented evidence", kind: "quote",
        citations: [{ attemptId: a.id, id: "unread_evidence", revision: 1, quote: "Invented evidence", scope: "page" }], covers: ["page"], conflicts: [] }],
        missing: [], limitations: [], artifactIds: [staged.id] };
      yield { type: "message_complete", message: { type: "assistant", id: retryId(), content: [{ type: "text", text: JSON.stringify({
        outcome: "report", text: "Done", report, proposals: [{ title: "Must roll back", purpose: "No authority", completionRule: "Review" }],
      }) }] } };
    } }).run(a, signal);
  } };
  f.app.routines.tick(); await f.app.authority.drain();
  const occurrence = f.app.routines.view(f.auth.actor, routine.id).history[0]!;
  expect(occurrence).toMatchObject({ state: "failed", outcome: "failed", proposals: [] });
  expect(f.app.reports.list(f.auth.actor, occurrence.workId!)).toEqual([]);
  expect(f.app.authority.view(f.auth.actor, occurrence.workId!).results).toEqual([]);
  expect(f.app.authority.list(f.auth.actor).some(work => work.title === "Must roll back")).toBe(false);
  expect(f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM artifacts")!.n)).toBe(0);
  expect(f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM artifact_staging")!.n)).toBe(0);
  expect(f.app.attention.view(f.auth.actor).items[0]!.reason).toBe("routine_failed");
});

test.each(["{}", '{"outcome":"report","text":"Done"}', "The report is complete"])("native routine model claim %s cannot complete without a committed report", async text => {
  const { f, routine } = await fixture();
  f.app.authority.options.executor = schwayResearch(join(f.root, "native"), f.app, { provider: "scripted", id: "routine-claim", async *stream() {
    yield { type: "message_complete", message: { type: "assistant", id: retryId(), content: [{ type: "text", text }] } };
  } });
  f.app.routines.tick(); await f.app.authority.drain();
  const occurrence = f.app.routines.view(f.auth.actor, routine.id).history[0]!;
  expect(occurrence).toMatchObject({ state: "failed", outcome: "failed", reason: "routine_report_missing" });
  expect(f.app.reports.list(f.auth.actor, occurrence.workId!)).toEqual([]);
  expect(f.app.attention.view(f.auth.actor).items[0]!.reason).toBe("routine_failed");
});
