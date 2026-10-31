import { afterEach, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutionBackend } from "schway/host";
import { S14Application } from "../src/s14/application";
import { S14Store } from "../src/s14/store";
import { artifactHash } from "../src/s14/artifacts";
import { createS14Handler } from "../src/s14/web";
import type { ArtifactRequest, EvidenceRequirement, Report, ReportCommand, ReportProposal, ReportView } from "../src/s14/report-types";
import type { Attempt, StartPayload } from "../src/s14/authority-types";
import type { StepProposal } from "../src/s14/graph-types";
import type { Bot } from "../src/s14/types";
import { FakeComputerRuntime } from "./fixtures/s14-computer";
import { canonical } from "../src/s14/validation";
import anonymous from "./fixtures/parallel/tools-anonymous.json";
import search from "./fixtures/parallel/search.json";
import fetchFixture from "./fixtures/parallel/fetch.json";

const roots: string[] = [], stores = new Set<S14Store>();
const rid = () => crypto.randomUUID().replaceAll("-", "");
const epoch = 1800000000000;
const barrier = () => Promise.withResolvers<void>();
afterEach(() => { for (const store of stores) store.close(); stores.clear(); for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true }); });
async function fixture(resources: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), "jit-s14-report-")); roots.push(root);
  const path = join(root, "state.sqlite"), store = new S14Store(path); stores.add(store);
  const options = { policy: { routes: [{ id: "selected", provider: "codex" as const, model: "fixture" }], tools: ["web_search", "web_fetch", "computer"], resources },
    now: () => epoch, chat: { async reply() { return { text: "Chat" }; } }, parallel: { transport: async (_url: string, init: RequestInit) => {
      const wire = JSON.parse(init.body as string);
      const rpc = (result: unknown) => Response.json({ jsonrpc: "2.0", id: wire.id, result });
      if (wire.method === "initialize") return rpc({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } });
      if (wire.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (wire.method === "tools/list") return Response.json(anonymous);
      if (wire.method === "tools/call") return Response.json(wire.params.name === "web_search" ? search : fetchFixture);
      throw Error("unexpected wire method");
    } } };
  const app = new S14Application(store, options);
  await app.provisionOwner("fixture-report-owner-password"); const token = await app.login("fixture-report-owner-password"), auth = app.authenticate(token);
  const setup = app.execute(auth.actor, { kind: "setup", requestId: rid(), expectedRevision: 0, payload: { ownerName: "Owner", language: "en", routeId: "selected", capabilities: { tools: options.policy.tools, resources: [] } } });
  const conversationId = setup.conversation!.id;
  const target: EvidenceRequirement = { id: "page", label: "Read the required page", url: "https://example.com/article", coverage: "full_content_returned", freshness: "any" };
  const start = (changes: Partial<StartPayload> = {}) => app.execute(auth.actor, { kind: "work.start", requestId: rid(), expectedRevision: app.conversation(auth.actor, conversationId).conversation.revision,
    payload: { conversationId, task: null, title: "Research", purpose: "Compare public evidence", completionRule: "Owner reviews sourced report", bots: [{ id: "jit", revision: 1 }],
      tools: ["web_search", "web_fetch", "computer"], scopes: [], limits: { attempts: 8, steps: 8, calls: 40, reads: 40, concurrency: 2, outputBytes: 262144, wallMs: 1800000 }, expiresAt: epoch + 1800000, requiredEvidence: [target], ...changes } });
  const started = start();
  const admit = (workId = started.work!.id) => app.authority.admit(workId, rid(), { botId: "jit", tools: ["web_search", "web_fetch", "computer"], scopes: [], input: "Research public material", calls: 8, outputBytes: 32768 });
  const attempt = admit();
  const read = async (type: "web_search" | "web_fetch" = "web_fetch", fullContent = true) => {
    const row = await app.parallel.read(attempt.id, type, type === "web_fetch" ? { url: "https://example.com/article", fullContent } : { query: "public material" });
    expect(row.evidence.length).toBeGreaterThan(0);
    return row.evidence[0]!;
  };
  const proposal = (source: import("../src/s14/report-types").ReportEvidence, changes: Partial<ReportProposal> = {}): ReportProposal => ({ title: "Cited report", claims: [{ id: "claim", text: source.content, kind: "quote",
    citations: [{ attemptId: attempt.id, id: source.id, revision: source.revision, quote: source.content, scope: source.coverage === "snippet" ? "snippet" : source.coverage === "excerpt" ? "excerpt" : "page" }], covers: ["page"], conflicts: [] }], missing: [], limitations: [], artifactIds: [], ...changes });
  return { root, path, store, app, options, auth, token, conversationId, target, start, started, attempt, admit, read, proposal };
}
type F = Awaited<ReturnType<typeof fixture>>;
function available(view: ReportView) { expect(view.state).toBe("available"); if (view.state !== "available") throw Error("report unavailable"); return view; }
function publish(f: F, report: ReportProposal) { f.app.authority.commit(f.attempt.id, { state: "ready", text: "Committed review evidence", report }); return available(f.app.reports.list(f.auth.actor, f.started.work!.id)[0]!); }
function acceptance(f: F, report: Report): ReportCommand {
  return { kind: "report.review.accept", requestId: rid(), expectedRevision: f.app.reports.review(f.auth.actor, report.workId).revision,
    payload: { reportId: report.id, reportRevision: report.revision } };
}
const bytes = new TextEncoder().encode("# Workspace report\n");
const request: ArtifactRequest = { path: "report.md", name: "report.md", mediaType: "text/markdown", size: bytes.length, sha256: artifactHash(bytes) };
function backend(changes: Partial<ExecutionBackend> = {}): ExecutionBackend {
  const unused = async (): Promise<never> => { throw Error("unused backend operation"); };
  return { workspaceRoot: "/workspace", temporaryDirectory: "/tmp", realpath: async path => path, stat: async () => ({ type: "file" }),
    list: async () => [{ name: "report.md", type: "file" }], observeFile: async () => ({ targetExists: true, bytes }),
    async *readFile() { yield bytes; }, writeFileAtomically: unused, writePrivateFile: unused, async *glob() {}, search: unused, spawn: unused, ...changes };
}

const uncitedReport = (): ReportProposal => ({ title: "Uncited handoff report", claims: [{ id: "handoff", text: "Derived from the computer result", kind: "inference", citations: [], covers: [], conflicts: [] }], missing: [], limitations: [], artifactIds: [] });
async function uncitedChain(f: F, final?: (a: Attempt) => Promise<void>) {
  f.app.authority.settle(f.attempt.id);
  f.app.computers.options.runtime = new FakeComputerRuntime();
  f.store.transaction(tx => {
    const bot = JSON.parse(tx.get<{ record_json: string }>("SELECT record_json FROM bots WHERE id='jit'")!.record_json) as Bot;
    for (const id of ["origin", "bridge"]) tx.run("INSERT INTO bots VALUES (?,?)", id, canonical({ ...bot, id, name: id }));
  });
  const work = f.start({ bots: ["jit", "origin", "bridge"].map(id => ({ id, revision: 1 })), tools: ["computer"], requiredEvidence: [] }).work!;
  const base = { scopes: [], calls: 1, outputBytes: 32768, input: "Bounded handoff" };
  const nodes: StepProposal[] = [
    { ...base, id: "origin", botId: "origin", handler: "research", tools: ["computer"], dependsOn: [] },
    { ...base, id: "bridge", botId: "bridge", handler: "synthesis", tools: [], dependsOn: ["origin"] },
    { ...base, id: "final", botId: "jit", handler: "synthesis", tools: [], dependsOn: ["bridge"] },
  ];
  f.app.graph.propose(work.id, 1, nodes);
  f.app.authority.options.executor = { async run(a) {
    if (a.snapshot.bot.id === "origin") {
      await f.app.computers.prepare(a.id);
      const computer = f.app.computers.open(a.id); computer.release();
      return { state: "ready", text: "Uncited computer result" };
    }
    expect(a.step!.inputs).toHaveLength(1);
    expect(a.step!.inputs[0]!.evidence).toEqual([]);
    if (a.snapshot.bot.id === "bridge") return { state: "ready", text: `Bridge: ${a.step!.inputs[0]!.text}` };
    const staged = f.store.transaction(tx => f.app.artifacts.stage(tx, a, request, bytes));
    await final?.(a);
    return { state: "waiting", text: "Final uncited report", report: { ...uncitedReport(), artifactIds: [staged.id] } };
  } };
  return { work, draining: f.app.authority.drain() };
}
function withdrawComputer(f: F, kind: "computer.reset" | "computer.delete") {
  const c = f.app.computers.view(f.auth.actor, "origin").computer!;
  f.app.execute(f.auth.actor, { kind, requestId: rid(), expectedRevision: c.revision, payload: { botId: "origin", computerId: c.id, generation: c.generation } });
}

test.each(["computer.reset", "computer.delete"] as const)("%s withdraws shared report artifacts through uncited producer lineage, including stale restores", async kind => {
  const f = await fixture(["share1", "share2"]), chain = await uncitedChain(f); await chain.draining;
  const report = available(f.app.reports.list(f.auth.actor, chain.work.id)[0]!);
  f.app.execute(f.auth.actor, acceptance(f, report.report));
  f.store.transaction(tx => {
    const bot = JSON.parse(tx.get<{ record_json: string }>("SELECT record_json FROM bots WHERE id='jit'")!.record_json) as Bot;
    tx.run("INSERT INTO bots VALUES (?,?)", "receiver", canonical({ ...bot, id: "receiver", capabilities: { tools: [], resources: ["share1", "share2"] } }));
  });
  const target = { kind: "artifact" as const, id: report.artifacts[0]!.id, revision: 1, generation: 1 };
  const share = (scopeId: string) => ({ kind: "snapshot.share" as const, requestId: rid(), expectedRevision: 1,
    payload: { scopeId, target, receiverBotId: "receiver", workId: null, expiresAt: epoch + 60000 } });
  f.app.execute(f.auth.actor, share("share1"));
  const receiving = f.start({ bots: [{ id: "receiver", revision: 1 }], tools: [], scopes: [{ kind: "share", id: "share1", revision: 1 }] }).work!;
  const attempt = f.app.authority.admit(receiving.id, rid(), { botId: "receiver", tools: [], scopes: [{ kind: "share", id: "share1", revision: 1 }], input: "Read exact report snapshot", calls: 1, outputBytes: 4096 });
  expect(f.store.read(tx => f.app.sharing.context(tx, attempt))).toHaveLength(1);
  f.app.authority.commit(attempt.id, { state: "ready", text: "Descendant of shared report", report: uncitedReport() });
  const descendant = available(f.app.reports.list(f.auth.actor, receiving.id)[0]!);
  // Retain the fallback producer lookup from main as well as the additive pin.
  f.store.transaction(tx => tx.run("UPDATE memory_sources SET record_json=json_remove(record_json,'$.producerAttemptId')"));
  const backup = join(f.root, "before-shared-producer-withdrawal.sqlite"); copyFileSync(f.path, backup);
  withdrawComputer(f, kind);
  expect(() => f.app.execute(f.auth.actor, share("share2"))).toThrow("snapshot_unavailable");
  expect(f.app.sharing.list(f.auth.actor)[0]!.state).toBe("unavailable");
  expect(f.app.reports.review(f.auth.actor, chain.work.id).acceptance).toBeNull();
  expect(f.app.reports.list(f.auth.actor, receiving.id)[0]!.state).toBe("unavailable");
  expect(() => f.app.artifacts.download(f.auth.actor, descendant.artifacts[0]!.id)).toThrow("artifact_unavailable");
  expect(f.app.authority.view(f.auth.actor, receiving.id).results).toEqual([]);
  expect(f.store.read(tx => tx.get<{ content: unknown }>("SELECT content FROM snapshot_shares WHERE id='share1'")!.content)).toBeNull();
  f.store.close(); stores.delete(f.store); copyFileSync(backup, f.path);
  const store = new S14Store(f.path); stores.add(store); const app = new S14Application(store, f.options), actor = app.authenticate(f.token).actor;
  expect(app.sharing.list(actor)[0]!.state).toBe("unavailable");
  expect(app.reports.list(actor, receiving.id)[0]!.state).toBe("unavailable");
  expect(() => app.artifacts.download(actor, target.id)).toThrow("artifact_unavailable");
  expect(store.read(tx => tx.get<{ content: unknown }>("SELECT content FROM snapshot_shares WHERE id='share1'")!.content)).toBeNull();
});

test.each(["computer.reset", "computer.delete"] as const)("%s withdraws transitive uncited handoffs, report revisions, workspace files and restored pre-pin outputs", async kind => {
  const f = await fixture(), chain = await uncitedChain(f); await chain.draining;
  const first = available(f.app.reports.list(f.auth.actor, chain.work.id)[0]!);
  expect(first.artifacts).toHaveLength(3);
  const next = f.app.authority.admit(chain.work.id, rid(), { botId: "jit", tools: [], scopes: [], input: "Revise retained report", calls: 1, outputBytes: 32768 });
  f.store.transaction(tx => f.app.memory.appendSource(tx, next.id, first.report.source));
  f.app.authority.commit(next.id, { state: "ready", text: "Second report", report: uncitedReport() });
  const history = f.app.reports.list(f.auth.actor, chain.work.id).map(available);
  expect(history.map(view => view.report.revision)).toEqual([1, 2]);
  f.app.execute(f.auth.actor, acceptance(f, history[1]!.report));
  for (const view of history) for (const artifact of view.artifacts) expect(f.app.artifacts.download(f.auth.actor, artifact.id).bytes.length).toBeGreaterThan(0);
  // Simulate existing schema-10 data from before producer pins; the durable origin records must still fence it.
  f.store.transaction(tx => tx.run("UPDATE memory_sources SET record_json=json_remove(record_json,'$.producerAttemptId')"));
  const backup = join(f.root, "before-uncited-withdrawal.sqlite"); copyFileSync(f.path, backup);
  withdrawComputer(f, kind);
  expect(f.app.reports.list(f.auth.actor, chain.work.id).every(view => view.state === "unavailable")).toBe(true);
  expect(f.app.reports.review(f.auth.actor, chain.work.id).acceptance).toBeNull();
  for (const view of history) for (const artifact of view.artifacts) expect(() => f.app.artifacts.download(f.auth.actor, artifact.id)).toThrow("artifact_unavailable");
  f.store.close(); stores.delete(f.store); copyFileSync(backup, f.path);
  const store = new S14Store(f.path); stores.add(store); const app = new S14Application(store, f.options), actor = app.authenticate(f.token).actor;
  expect(app.reports.list(actor, chain.work.id).every(view => view.state === "unavailable")).toBe(true);
  for (const view of history) for (const artifact of view.artifacts) expect(() => app.artifacts.download(actor, artifact.id)).toThrow("artifact_unavailable");
  expect(store.read(tx => tx.get<{ n: number }>("SELECT count(*) n FROM artifacts WHERE content IS NOT NULL")!.n)).toBe(0);
});

test.each(["computer.reset", "computer.delete"] as const)("%s during uncited synthesis removes private staging and rejects late report/result publication", async kind => {
  const f = await fixture(), entered = barrier(), release = barrier();
  const chain = await uncitedChain(f, async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  expect(f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) n FROM artifact_staging")!.n)).toBe(1);
  withdrawComputer(f, kind);
  expect(f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) n FROM artifact_staging")!.n)).toBe(0);
  release.resolve(); await chain.draining;
  expect(f.app.reports.list(f.auth.actor, chain.work.id)).toEqual([]);
  expect(f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) n FROM artifacts")!.n)).toBe(0);
  expect(f.app.authority.view(f.auth.actor, chain.work.id).results.some(result => result.text === "Final uncited report")).toBe(false);
});

test("a Bot revision on an uncited transitive producer withdraws its descendants without affecting unrelated reports", async () => {
  const f = await fixture(), source = await f.read(), unrelated = publish(f, f.proposal(source));
  const chain = await uncitedChain(f); await chain.draining;
  const committed = available(f.app.reports.list(f.auth.actor, chain.work.id)[0]!);
  f.store.transaction(tx => tx.run("UPDATE bots SET record_json=json_set(record_json,'$.revision',2) WHERE id='origin'"));
  expect(f.app.reports.view(f.auth.actor, committed.report.id).state).toBe("unavailable");
  expect(f.app.reports.view(f.auth.actor, unrelated.report.id).state).toBe("available");
});

test("default graph output leaves conservative room for owner evidence-only synthesis after a failed read attempt", async () => {
  const f = await fixture(); f.app.authority.settle(f.attempt.id);
  const work = f.start({ tools: ["web_fetch"] }).work!;
  let runs = 0;
  f.app.authority.options.executor = { async run(a) {
    if (runs++ === 0) {
      await f.app.parallel.read(a.id, "web_fetch", { url: "https://example.com/article", fullContent: true });
      throw Error("fixture failure after committed evidence");
    }
    expect(a.snapshot.tools).toEqual([]);
    expect(a.snapshot.input).toContain("Returned full markdown");
    return { state: "ready", text: "Evidence-only synthesis" };
  } };
  await f.app.authority.drain();
  const before = f.app.authority.view(f.auth.actor, work.id), slice = Math.floor(before.grant!.limits.outputBytes / before.grant!.limits.attempts);
  expect(before.work.state).toBe("blocked"); expect(before.reservations!.outputBytes).toBe(slice);
  f.app.execute(f.auth.actor, { kind: "work.summarize", requestId: rid(), expectedRevision: before.work.revision, payload: { workId: work.id } });
  await f.app.authority.drain();
  const after = f.app.authority.view(f.auth.actor, work.id);
  expect(after.results.map(result => result.text)).toEqual(["Evidence-only synthesis"]);
  expect(after.reservations).toMatchObject({ outputBytes: 2 * slice, attempts: 2, reads: 1 });
});

test("a delegated uncited source retains its parent's computer fence at publication and download", async () => {
  const f = await fixture(); f.app.authority.settle(f.attempt.id);
  f.app.computers.options.runtime = new FakeComputerRuntime();
  f.store.transaction(tx => {
    const bot = JSON.parse(tx.get<{ record_json: string }>("SELECT record_json FROM bots WHERE id='jit'")!.record_json) as Bot;
    tx.run("INSERT INTO bots VALUES (?,?)", "receiver", canonical({ ...bot, id: "receiver" }));
  });
  const work = f.start({ bots: [{ id: "jit", revision: 1 }, { id: "receiver", revision: 1 }], tools: ["computer"] }).work!;
  const parent = f.app.authority.admit(work.id, rid(), { botId: "jit", tools: ["computer"], scopes: [], input: "Parent computer work", calls: 1, outputBytes: 32768 });
  await f.app.computers.prepare(parent.id); const computer = f.app.computers.open(parent.id); computer.release();
  const child = f.app.authority.delegate(parent.id, rid(), { botId: "receiver", tools: [], scopes: [], input: "Uncited parent handoff", calls: 1, outputBytes: 32768 });
  f.app.authority.commit(child.id, { state: "ready", text: "Delegated report", report: uncitedReport() });
  const committed = available(f.app.reports.list(f.auth.actor, work.id)[0]!);
  const c = f.app.computers.view(f.auth.actor, "jit").computer!;
  f.app.execute(f.auth.actor, { kind: "computer.reset", requestId: rid(), expectedRevision: c.revision, payload: { botId: "jit", computerId: c.id, generation: c.generation } });
  expect(f.app.reports.view(f.auth.actor, committed.report.id).state).toBe("unavailable");
  for (const artifact of committed.artifacts) expect(() => f.app.artifacts.download(f.auth.actor, artifact.id)).toThrow("artifact_unavailable");
});

test("evidence filling one handoff cannot let subsequent text-only dependencies exceed the aggregate ceiling", async () => {
  const f = await fixture(); f.app.authority.settle(f.attempt.id);
  const transport = f.app.parallel.options.transport!;
  f.app.parallel.options.transport = async (url, init) => {
    const wire = JSON.parse(init.body as string);
    if (wire.method !== "tools/call") return transport(url, init);
    const changed = structuredClone(fetchFixture);
    changed.result.structuredContent.results[0]!.full_content = "E".repeat(14000);
    return Response.json(changed);
  };
  const work = f.start({ tools: ["web_fetch"] }).work!, base = f.app.graph.view(f.auth.actor, work.id).graph.nodes[0]!;
  const nodes: StepProposal[] = Array.from({ length: 6 }, (_, i) => ({ ...base, id: `read_${i}`, calls: 3 }));
  nodes.push({ ...base, id: "synthesis", handler: "synthesis", tools: [], dependsOn: nodes.map(n => n.id), calls: 1 });
  f.app.graph.propose(work.id, 1, nodes);
  let synthesis: Attempt | undefined;
  f.app.authority.options.executor = { async run(a) {
    if (a.step!.handler === "synthesis") { synthesis = a; return { state: "ready", text: "Bounded mixed handoff" }; }
    if (a.step!.id.endsWith("read_0")) {
      expect((await f.app.parallel.read(a.id, "web_fetch", { url: "https://example.com/article", fullContent: true })).evidence).toHaveLength(1);
    }
    return { state: "ready", text: "T".repeat(8192) };
  } };
  await f.app.authority.drain();
  expect(synthesis).toBeDefined();
  expect(synthesis!.step!.inputs[0]!.evidence).toHaveLength(1);
  expect(Buffer.byteLength(JSON.stringify(synthesis!.step!.inputs))).toBeLessThanOrEqual(49152);
  expect(synthesis!.step!.gaps.filter(gap => gap.reason === "handoff_result_omitted")).toHaveLength(2);
});

test("done text and a staged workspace file do not create a report; valid commit creates immutable report plus two inspectable files", async () => {
  const f = await fixture(), source = await f.read();
  const stage = await f.app.artifacts.stageWorkspace(f.attempt.id, backend(), request);
  expect(f.app.reports.list(f.auth.actor, f.started.work!.id)).toEqual([]);
  expect(f.app.reports.review(f.auth.actor, f.started.work!.id)).toMatchObject({ revision: 0, reportId: null, reportRevision: null, acceptance: null });
  expect(() => f.app.artifacts.download(f.auth.actor, stage.id)).toThrow("artifact_unavailable");
  const view = publish(f, f.proposal(source, { artifactIds: [stage.id] }));
  expect(view.report).toMatchObject({ state: "ready_for_review", coverage: "covered", revision: 1 });
  expect(view.completion).toBe("owner_review_required");
  expect(view.artifacts).toHaveLength(3);
  expect(view.artifacts.some(file => file.id === stage.id)).toBe(true);
  for (const file of view.artifacts) {
    const snapshot = f.app.artifacts.download(f.auth.actor, file.id);
    expect(snapshot.bytes.length).toBe(file.size); expect(artifactHash(snapshot.bytes)).toBe(file.sha256);
  }
  expect(() => f.store.transaction(tx => tx.run("UPDATE reports SET content_json='{}' WHERE id=?", view.report.id))).toThrow("immutable_report");
  expect(() => f.store.transaction(tx => tx.run("UPDATE artifacts SET content=? WHERE id=?", new Uint8Array([1]), view.artifacts[0]!.id))).toThrow("immutable_artifact");
  const plain = f.start(), a = f.admit(plain.work!.id); f.app.authority.commit(a.id, { state: "ready", text: "Done, report in /workspace/report.md" });
  expect(f.app.reports.list(f.auth.actor, plain.work!.id)).toEqual([]);
});

test.each(["invented", "wrong_revision", "wrong_quote", "unread_attempt"])("citation %s is refused atomically without a report or delivered file", async kind => {
  const f = await fixture(), source = await f.read(), report = f.proposal(source), citation = report.claims[0]!.citations[0]!;
  if (kind === "invented") citation.id = rid();
  if (kind === "wrong_revision") citation.revision++;
  if (kind === "wrong_quote") citation.quote = "Invented quotation";
  if (kind === "unread_attempt") citation.attemptId = rid();
  expect(() => publish(f, report)).toThrow();
  expect(f.app.authority.view(f.auth.actor, f.started.work!.id).results).toEqual([]);
  expect(f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) n FROM artifacts")!.n)).toBe(0);
});

test.each(["snippet_as_page", "excerpt_as_page", "stale_cache", "no_requirements", "missing_claim_evidence"])("coverage corpus: %s stays partial with honest labels", async kind => {
  const f = await fixture();
  let source = await f.read(kind === "snippet_as_page" ? "web_search" : "web_fetch", kind !== "excerpt_as_page");
  const report = f.proposal(source);
  if (kind === "snippet_as_page" || kind === "excerpt_as_page") report.claims[0]!.citations[0]!.scope = "page";
  if (kind === "stale_cache") {
    // Freshness is an owner requirement captured before the evidence-producing attempt.
    f.app.authority.settle(f.attempt.id);
    const started = f.start({ requiredEvidence: [{ ...f.target, freshness: "live_reported" }] }), attempt = f.admit(started.work!.id);
    const read = await f.app.parallel.read(attempt.id, "web_fetch", { url: "https://example.com/article", fullContent: true });
    source = read.evidence[0]!;
    const proposal = f.proposal(source); proposal.claims[0]!.citations[0]!.attemptId = attempt.id;
    f.app.authority.commit(attempt.id, { state: "ready", text: "Cached evidence", report: proposal });
    const view = available(f.app.reports.list(f.auth.actor, started.work!.id)[0]!);
    expect(view.report.coverage).toBe("partial"); expect(view.report.claims[0]!.flags).toContain("cached_reported"); return;
  }
  if (kind === "no_requirements") {
    f.app.authority.settle(f.attempt.id);
    const started = f.start({ requiredEvidence: [] }), attempt = f.admit(started.work!.id);
    const read = await f.app.parallel.read(attempt.id, "web_fetch", { url: "https://example.com/article", fullContent: true });
    const proposal = f.proposal(read.evidence[0]!); proposal.claims[0]!.citations[0]!.attemptId = attempt.id; proposal.claims[0]!.covers = [];
    f.app.authority.commit(attempt.id, { state: "ready", text: "Review", report: proposal });
    expect(available(f.app.reports.list(f.auth.actor, started.work!.id)[0]!).report.missing).toContainEqual({ kind: "completion_rule_not_machine_verified" }); return;
  }
  if (kind === "missing_claim_evidence") report.claims[0]!.citations = [];
  const view = publish(f, report);
  expect(view.report.coverage).toBe("partial"); expect(view.report.missing).toContainEqual({ kind: "required_evidence", targetId: "page" });
  expect(view.report.claims[0]!.support).toBe("unsupported");
});

test("conflicting claims retain both sources and never silently become complete coverage", async () => {
  const f = await fixture(), source = await f.read(), report = f.proposal(source);
  const second = structuredClone(report.claims[0]!); second.id = "other"; second.kind = "inference"; second.text = "A conflicting interpretation"; second.conflicts = ["claim"];
  report.claims[0]!.conflicts = ["other"]; report.claims.push(second);
  const view = publish(f, report);
  expect(view.report.coverage).toBe("partial"); expect(view.report.claims).toHaveLength(2);
  expect(view.report.claims.every(c => c.flags.includes("conflicting"))).toBe(true);
  expect(view.report.claims[1]!.flags).toContain("inference");
});

test.each(["../secret", "/etc/passwd", "other/../../secret", "a\\b", "%2e%2e/secret", "a//b"])("workspace path %s cannot become an export", async path => {
  const f = await fixture();
  expect(f.app.artifacts.stageWorkspace(f.attempt.id, backend(), { ...request, path })).rejects.toThrow("artifact_path_refused");
});

test("artifact gateway refuses symlinks, directories, active types, oversize, bad size/hash, invalid JSON and credentials", async () => {
  const f = await fixture();
  await expect(f.app.artifacts.stageWorkspace(f.attempt.id, backend({ list: async () => [{ name: "report.md", type: "symlink" }] }), request)).rejects.toThrow("artifact_symlink_refused");
  await expect(f.app.artifacts.stageWorkspace(f.attempt.id, backend({ realpath: async () => "/workspace/other.md" }), request)).rejects.toThrow("artifact_symlink_refused");
  await expect(f.app.artifacts.stageWorkspace(f.attempt.id, backend({ stat: async () => ({ type: "directory" }) }), request)).rejects.toThrow("artifact_type_refused");
  for (const change of [{ mediaType: "text/html", name: "page.html" }, { size: 10000000 }, { size: bytes.length + 1 }, { sha256: "f".repeat(64) }, { name: "payload.json", mediaType: "application/json" }]) {
    await expect(f.app.artifacts.stageWorkspace(f.attempt.id, backend(), { ...request, ...change } as ArtifactRequest)).rejects.toThrow();
  }
  const secret = new TextEncoder().encode("Bearer sk-proj-" + "a".repeat(48));
  await expect(f.app.artifacts.stageWorkspace(f.attempt.id, backend({ observeFile: async () => ({ targetExists: true, bytes: secret }) }), { ...request, size: secret.length, sha256: artifactHash(secret) })).rejects.toThrow("artifact_content_refused");
  expect(f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) n FROM artifact_staging")!.n)).toBe(0);
});

test("authorized downloads are opaque, private no-store attachments; untrusted markup cannot execute in the app origin", async () => {
  const f = await fixture(), source = await f.read(), report = f.proposal(source);
  report.claims[0]!.kind = "inference"; report.claims[0]!.text = '<script>fetch("/api/s14/commands")</script>';
  const view = publish(f, report), file = view.artifacts.find(a => a.mediaType === "text/markdown")!;
  const handler = createS14Handler(f.app, "http://localhost:3001"), url = `http://localhost:3001/api/s14/artifacts/${file.id}/download`;
  expect((await handler(new Request(url))).status).toBe(401);
  const response = await handler(new Request(url, { headers: { cookie: `jit_s14=${f.token}` } }));
  expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("content-disposition")).toBe(`attachment; filename="${file.name}"`);
  expect(response.headers.get("content-type")).toBe("text/markdown"); expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("content-security-policy")).toContain("sandbox; default-src 'none'");
  expect(artifactHash(new Uint8Array(await response.arrayBuffer()))).toBe(file.sha256);
  for (const path of ["../../application.sqlite", "%2e%2e%2fapplication.sqlite", "guess", `${file.id}/extra`]) {
    expect((await handler(new Request(`http://localhost:3001/api/s14/artifacts/${path}/download`, { headers: { cookie: `jit_s14=${f.token}` } }))).status).toBe(404);
  }
});

test("failed report insert rolls back result/source/files together and a restart sees only committed revisions", async () => {
  const f = await fixture(), source = await f.read(), report = f.proposal(source);
  f.store.transaction(tx => tx.run("CREATE TRIGGER publication_fault BEFORE INSERT ON reports BEGIN SELECT RAISE(ABORT,'fixture_atomic_failure'); END"));
  expect(() => publish(f, report)).toThrow("fixture_atomic_failure");
  expect(f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) n FROM artifacts")!.n)).toBe(0);
  expect(f.app.authority.view(f.auth.actor, f.started.work!.id).results).toEqual([]);
  f.store.transaction(tx => tx.run("DROP TRIGGER publication_fault"));
  const committed = publish(f, report);
  f.store.close(); stores.delete(f.store);
  const store = new S14Store(f.path); stores.add(store); const app = new S14Application(store, f.options), actor = app.authenticate(f.token).actor;
  app.authority.recover();
  expect(available(app.reports.view(actor, committed.report.id)).report).toEqual(committed.report);
  expect(app.artifacts.download(actor, committed.artifacts[0]!.id).bytes.length).toBeGreaterThan(0);
});

test.each(["memory.correct", "memory.forget", "memory.delete", "memory.revoke"] as const)("%s reaches report/artifact descendants and a restored image cannot resurrect them", async kind => {
  const f = await fixture();
  // Re-admit after the owner memory was available; its original access revision is captured.
  f.app.authority.settle(f.attempt.id);
  const remembered = f.app.execute(f.auth.actor, { kind: "memory.remember", requestId: rid(), expectedRevision: f.app.conversation(f.auth.actor, f.conversationId).conversation.revision, payload: { conversationId: f.conversationId, text: "Owner report preference" } });
  const work = f.start(), attempt = f.admit(work.work!.id);
  const read = await f.app.parallel.read(attempt.id, "web_fetch", { url: "https://example.com/article", fullContent: true });
  const proposal = f.proposal(read.evidence[0]!); proposal.claims[0]!.citations[0]!.attemptId = attempt.id;
  f.app.authority.commit(attempt.id, { state: "ready", text: "Memory-derived report", report: proposal });
  const committed = available(f.app.reports.list(f.auth.actor, work.work!.id)[0]!);
  f.app.execute(f.auth.actor, acceptance(f, committed.report));
  expect(f.app.reports.review(f.auth.actor, work.work!.id).completion).toBe("owner_accepted");
  const backup = join(f.root, "image.sqlite"); copyFileSync(f.path, backup);
  f.app.execute(f.auth.actor, kind === "memory.correct"
    ? { kind, requestId: rid(), expectedRevision: 1, payload: { claim: remembered.claim!, text: "Corrected report preference" } }
    : { kind, requestId: rid(), expectedRevision: 1, payload: { claim: remembered.claim! } });
  expect(f.app.reports.view(f.auth.actor, committed.report.id).state).toBe("unavailable");
  expect(f.app.reports.review(f.auth.actor, work.work!.id)).toMatchObject({ completion: "owner_review_required", acceptance: null, revision: 3 });
  expect(() => f.app.execute(f.auth.actor, acceptance(f, committed.report))).toThrow("report_unavailable");
  expect(() => f.app.artifacts.download(f.auth.actor, committed.artifacts[0]!.id)).toThrow("artifact_unavailable");
  f.store.close(); stores.delete(f.store); copyFileSync(backup, f.path);
  const store = new S14Store(f.path); stores.add(store); const app = new S14Application(store, f.options), actor = app.authenticate(f.token).actor;
  expect(app.reports.view(actor, committed.report.id).state).toBe("unavailable");
  expect(app.reports.review(actor, work.work!.id)).toMatchObject({ completion: "owner_review_required", acceptance: null });
  expect(() => app.artifacts.download(actor, committed.artifacts[0]!.id)).toThrow("artifact_unavailable");
  expect(store.read(tx => tx.get<{ n: number }>("SELECT count(*) n FROM artifacts WHERE content IS NOT NULL")!.n)).toBe(0);
});

test("a stopped/fenced attempt cannot publish a report after asynchronous workspace snapshot settlement", async () => {
  const f = await fixture(), source = await f.read(), entered = barrier(), release = barrier();
  const snapshot = f.app.artifacts.stageWorkspace(f.attempt.id, backend({ async observeFile() { entered.resolve(); await release.promise; return { targetExists: true, bytes }; } }), request);
  await entered.promise;
  const work = f.app.authority.view(f.auth.actor, f.started.work!.id).work;
  f.app.execute(f.auth.actor, { kind: "work.stop", requestId: rid(), expectedRevision: work.revision, payload: { workId: work.id } });
  release.resolve(); await expect(snapshot).rejects.toThrow("grant_revoked");
  expect(() => publish(f, f.proposal(source))).toThrow("grant_revoked");
  expect(f.app.reports.list(f.auth.actor, work.id)).toEqual([]);
});

test("the production native executor returns validated structured report data and commits real source-bound downloads", async () => {
  const f = await fixture(); f.app.authority.settle(f.attempt.id);
  const work = f.start({ tools: ["web_fetch"] }); let turns = 0;
  const { schwayResearch } = await import("../src/s14/research");
  f.app.authority.options.executor = { run: (a, signal) => schwayResearch(join(f.root, "native"), f.app, { provider: "scripted", id: "report-protocol", async *stream() {
    let content;
    if (turns++ === 0) content = [{ type: "tool_call" as const, id: rid(), name: "web_fetch", arguments: { url: "https://example.com/article", fullContent: true } }];
    else {
      const source = f.app.parallel.inspect(f.auth.actor, work.work!.id).evidence[0]!, report = f.proposal(source);
      report.claims[0]!.citations[0]!.attemptId = a.id;
      content = [{ type: "text" as const, text: JSON.stringify({ text: "Sourced summary", report }) }];
    }
    yield { type: "message_complete", message: { type: "assistant", id: rid(), content } };
  } }).run(a, signal) };
  await f.app.authority.drain();
  const report = available(f.app.reports.list(f.auth.actor, work.work!.id)[0]!);
  expect(report.report.coverage).toBe("covered"); expect(report.artifacts).toHaveLength(2);
  expect(f.app.authority.view(f.auth.actor, work.work!.id).results[0]!.text).toBe("Sourced summary");
});

test("candidate validation rolls back all publication rows and final commit rechecks live authority", async () => {
  const f = await fixture(), source = await f.read(), output = { state: "ready" as const, text: "Sourced summary", report: f.proposal(source) };
  const counts = () => f.store.read(tx => ["memory_sources", "reports", "artifacts", "work_results"].map(table => tx.get<{ n: number }>(`SELECT count(*) n FROM ${table}`)!.n));
  const before = counts();
  f.app.reports.validateCandidate(f.attempt.id, output);
  expect(counts()).toEqual(before);
  expect(f.app.reports.list(f.auth.actor, f.started.work!.id)).toEqual([]);
  f.app.execute(f.auth.actor, { kind: "work.stop", requestId: rid(), expectedRevision: f.app.authority.view(f.auth.actor, f.started.work!.id).work.revision, payload: { workId: f.started.work!.id } });
  expect(() => f.app.authority.commit(f.attempt.id, output)).toThrow("grant_revoked");
  expect(f.app.reports.list(f.auth.actor, f.started.work!.id)).toEqual([]);
});

test.each(["quote", "size", "unknown_attempt", "unknown_evidence", "still_invalid"] as const)("native report %s rejection gets one charged tool-free correction without weakening publication", async mutation => {
  const f = await fixture(); f.app.authority.settle(f.attempt.id);
  const work = f.start({ tools: ["web_fetch"] }).work!;
  const { schwayResearch } = await import("../src/s14/research");
  let turns = 0;
  f.app.authority.options.executor = { run: (a, signal) => schwayResearch(join(f.root, "native"), f.app, { provider: "scripted", id: "report-repair", async *stream(request) {
    let content;
    if (turns++ === 0) content = [{ type: "tool_call" as const, id: rid(), name: "web_fetch", arguments: { url: "https://example.com/article", fullContent: true } }];
    else {
      const source = f.app.parallel.inspect(f.auth.actor, work.id).evidence[0]!, report = f.proposal(source);
      report.claims[0]!.citations[0]!.attemptId = a.id;
      if (turns === 2 || mutation === "still_invalid") {
        if (mutation === "unknown_attempt") report.claims[0]!.citations[0]!.attemptId = "invented_attempt";
        else if (mutation === "unknown_evidence") report.claims[0]!.citations[0]!.id = "invented_evidence";
        else if (mutation === "size") report.claims = Array.from({ length: 24 }, (_, index) => ({ ...report.claims[0]!, id: `claim_${index}`, kind: "inference" as const, text: "Evidence discussion ".repeat(80) }));
        else report.claims[0]!.citations[0]!.quote = "This quotation was not returned by the source";
      }
      if (turns === 3) {
        expect(request.tools).toEqual([]);
        expect(f.app.reports.list(f.auth.actor, work.id)).toEqual([]);
        expect(f.app.authority.view(f.auth.actor, work.id).results).toEqual([]);
      }
      content = [{ type: "text" as const, text: JSON.stringify({ text: "Sourced summary", report }) }];
    }
    yield { type: "message_complete", message: { type: "assistant", id: rid(), content } };
  } }).run(a, signal) };
  await f.app.authority.drain();
  expect(turns).toBe(3);
  expect(f.app.authority.view(f.auth.actor, work.id).reservations!.calls).toBe(4);
  if (mutation === "still_invalid") {
    expect(f.app.reports.list(f.auth.actor, work.id)).toEqual([]);
    expect(f.app.authority.view(f.auth.actor, work.id).results).toEqual([]);
    expect(f.app.graph.view(f.auth.actor, work.id).steps[0]).toMatchObject({ state: "failed", reason: "citation_quote_mismatch" });
  } else {
    const view = available(f.app.reports.list(f.auth.actor, work.id)[0]!);
    expect(view.report.claims[0]!.citations[0]!.quote).toBe(view.report.claims[0]!.evidence[0]!.content);
    expect(view.artifacts).toHaveLength(2);
  }
});

test("synthesis cites only actual accessible committed handoff evidence and a failed sibling forces a partial report", async () => {
  const f = await fixture(); f.app.authority.settle(f.attempt.id);
  f.store.transaction(tx => {
    const bot = JSON.parse(tx.get<{ record_json: string }>("SELECT record_json FROM bots WHERE id='jit'")!.record_json);
    bot.id = "second"; bot.name = "Second";
    tx.run("INSERT INTO bots VALUES (?,?)", bot.id, canonical(bot));
  });
  const work = f.start({ bots: [{ id: "jit", revision: 1 }, { id: "second", revision: 1 }], tools: ["web_fetch"] });
  f.app.authority.options.executor = { async run(a) {
    if (a.step!.handler === "research") {
      if (a.snapshot.bot.id === "second") throw Error("quota fixture");
      await f.app.parallel.read(a.id, "web_fetch", { url: "https://example.com/article", fullContent: true });
      return { state: "ready", text: "Committed specialist evidence" };
    }
    const source = a.step!.inputs[0]!.evidence[0]!, report = f.proposal(source);
    report.claims[0]!.citations[0]!.attemptId = a.step!.inputs[0]!.attemptId;
    expect(a.step!.gaps).toHaveLength(1);
    return { state: "ready", text: "Partial team report", report };
  } };
  await f.app.authority.drain();
  const view = available(f.app.reports.list(f.auth.actor, work.work!.id)[0]!);
  expect(view.report.coverage).toBe("partial"); expect(view.report.claims[0]!.support).toBe("supported");
  expect(view.report.missing.some(item => item.kind === "handoff" && item.reason === "handler_unavailable")).toBe(true);
  expect(f.app.authority.view(f.auth.actor, work.work!.id).results[0]!.text).toBe("Committed specialist evidence");
});

test("report revisions retain immutable older history while each revision binds its own read evidence", async () => {
  const f = await fixture(), source = await f.read();
  f.app.authority.commit(f.attempt.id, { state: "waiting", text: "Early report", report: f.proposal(source) });
  const first = available(f.app.reports.list(f.auth.actor, f.started.work!.id)[0]!);
  const attempt = f.admit(), read = await f.app.parallel.read(attempt.id, "web_fetch", { url: "https://example.com/article", fullContent: true });
  const report = f.proposal(read.evidence[0]!); report.claims[0]!.citations[0]!.attemptId = attempt.id;
  f.app.authority.commit(attempt.id, { state: "ready", text: "Later report", report });
  const history = f.app.reports.list(f.auth.actor, f.started.work!.id).map(available);
  expect(history.map(h => h.report.revision)).toEqual([1, 2]);
  expect(history[0]!.report).toEqual(first.report);
});

test("stopped grants survive stale-image restore, fence execution and retain already committed owner evidence", async () => {
  const f = await fixture(), source = await f.read(), committed = publish(f, f.proposal(source));
  const backup = join(f.root, "before-stop.sqlite"); copyFileSync(f.path, backup);
  const work = f.app.authority.view(f.auth.actor, f.started.work!.id).work;
  f.app.execute(f.auth.actor, { kind: "work.stop", requestId: rid(), expectedRevision: work.revision, payload: { workId: work.id } });
  f.store.close(); stores.delete(f.store); copyFileSync(backup, f.path);
  const store = new S14Store(f.path); stores.add(store); const app = new S14Application(store, f.options), actor = app.authenticate(f.token).actor;
  expect(app.reports.view(actor, committed.report.id).state).toBe("available");
  expect(() => app.authority.admit(work.id, rid(), { botId: "jit", tools: [], scopes: [], input: "Replay", calls: 1, outputBytes: 100 })).toThrow("grant_revoked");
});

test("lifecycle preview names report revisions and artifact descendants before deleting their source", async () => {
  const f = await fixture(); f.app.authority.settle(f.attempt.id);
  const remembered = f.app.execute(f.auth.actor, { kind: "memory.remember", requestId: rid(), expectedRevision: f.app.conversation(f.auth.actor, f.conversationId).conversation.revision,
    payload: { conversationId: f.conversationId, text: "Report style memory" } });
  const work = f.start(), attempt = f.admit(work.work!.id), read = await f.app.parallel.read(attempt.id, "web_fetch", { url: "https://example.com/article", fullContent: true });
  const proposal = f.proposal(read.evidence[0]!); proposal.claims[0]!.citations[0]!.attemptId = attempt.id;
  f.app.authority.commit(attempt.id, { state: "ready", text: "Review", report: proposal });
  const report = available(f.app.reports.list(f.auth.actor, work.work!.id)[0]!);
  const impact = f.app.memory.preview(f.auth.actor, remembered.claim!);
  expect(impact.reports).toEqual([{ id: report.report.id, workId: work.work!.id, revision: 1 }]);
  expect(impact.artifacts.sort()).toEqual(report.artifacts.map(a => a.id).sort());
});

test("real but unread peer evidence cannot be cited outside a committed accessible graph handoff", async () => {
  const f = await fixture(), source = await f.read();
  f.app.authority.commit(f.attempt.id, { state: "waiting", text: "Committed source result" });
  const other = f.admit(), proposal = f.proposal(source);
  expect(() => f.app.authority.commit(other.id, { state: "ready", text: "Guessed peer reference", report: proposal })).toThrow("citation_not_read");
  expect(f.app.reports.list(f.auth.actor, f.started.work!.id)).toEqual([]);
});

test("a wrong returned URL and an omitted missing read stay visible even when the proposed report claims coverage", async () => {
  const f = await fixture(), transport = f.app.parallel.options.transport!;
  f.app.parallel.options.transport = async (url, init) => {
    const wire = JSON.parse(init.body as string);
    if (wire.method !== "tools/call") return transport(url, init);
    const changed = structuredClone(fetchFixture);
    changed.result.structuredContent.results[0]!.url = "https://example.com/different";
    return Response.json(changed);
  };
  const source = await f.read(), view = publish(f, f.proposal(source));
  expect(view.report.coverage).toBe("partial"); expect(view.report.missing).toContainEqual({ kind: "required_evidence", targetId: "page" });
  expect(view.report.missing).toContainEqual({ kind: "missing_url", url: "https://example.com/article" });
  expect(view.report.claims[0]!.evidence[0]!.url).toBe("https://example.com/different");
});

test("aggregate report output is reserved and oversized publication rolls back without orphan files", async () => {
  const f = await fixture(), source = await f.read(), proposal = f.proposal(source);
  proposal.claims = Array.from({ length: 12 }, (_value, index) => ({ ...structuredClone(proposal.claims[0]!), id: `claim_${index}`, kind: "inference", text: "x".repeat(4000) }));
  expect(() => publish(f, proposal)).toThrow("report_output_budget_exhausted");
  expect(f.app.reports.list(f.auth.actor, f.started.work!.id)).toEqual([]);
  expect(f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) n FROM artifacts")!.n)).toBe(0);
});

test("committed computer snapshots survive process restart, while later computer deletion reaches older generations across restore", async () => {
  const f = await fixture(), runtime = new FakeComputerRuntime(), source = await f.read();
  f.app.computers.options.runtime = runtime;
  await f.app.computers.prepare(f.attempt.id);
  const computer = f.app.computers.open(f.attempt.id);
  const committed = publish(f, f.proposal(source)); computer.release();
  f.store.close(); stores.delete(f.store);
  let store = new S14Store(f.path); stores.add(store);
  let app = new S14Application(store, { ...f.options, computers: { runtime } }), actor = app.authenticate(f.token).actor;
  app.computers.recover(); await app.computers.drain();
  expect(app.reports.view(actor, committed.report.id).state).toBe("available");
  const beforeDelete = join(f.root, "before-computer-delete.sqlite"); copyFileSync(f.path, beforeDelete);
  const c = app.computers.view(actor, "jit").computer!;
  app.execute(actor, { kind: "computer.delete", requestId: rid(), expectedRevision: c.revision, payload: { botId: "jit", computerId: c.id, generation: c.generation } });
  expect(app.reports.view(actor, committed.report.id).state).toBe("unavailable");
  store.close(); stores.delete(store); copyFileSync(beforeDelete, f.path);
  store = new S14Store(f.path); stores.add(store); app = new S14Application(store, { ...f.options, computers: { runtime } }); actor = app.authenticate(f.token).actor;
  expect(app.reports.view(actor, committed.report.id).state).toBe("unavailable");
});


test.each(["covered", "partial"] as const)("owner accepts an exact %s report once without changing evidence, files, work or grants", async coverage => {
  const f = await fixture(), source = await f.read(coverage === "partial" ? "web_search" : "web_fetch");
  const committed = publish(f, f.proposal(source)), beforeWork = f.app.authority.view(f.auth.actor, f.started.work!.id);
  const command = acceptance(f, committed.report), receipt = f.app.execute(f.auth.actor, command);
  expect(receipt).toMatchObject({ kind: "report.review.accept", conversationId: f.conversationId, review: { revision: 2, completion: "owner_accepted",
    acceptance: { reportId: committed.report.id, reportRevision: 1, requestId: command.requestId, acceptedAt: epoch, ownerGeneration: 1 } } });
  expect(f.app.execute(f.auth.actor, command)).toEqual(receipt);
  expect(() => f.app.execute(f.auth.actor, { ...command, requestId: rid() })).toThrow("stale_revision");
  expect(() => f.app.execute(f.auth.actor, { ...command, payload: { ...command.payload, reportRevision: 2 } })).toThrow("request_id_conflict");
  expect(() => f.app.execute(f.auth.actor, acceptance(f, committed.report))).toThrow("report_already_accepted");
  const after = available(f.app.reports.view(f.auth.actor, committed.report.id));
  expect(after).toMatchObject({ completion: "owner_accepted", acceptance: receipt.review.acceptance });
  expect(after.report).toEqual(committed.report); expect(after.report.coverage).toBe(coverage);
  expect(after.artifacts).toEqual(committed.artifacts);
  expect(f.app.authority.view(f.auth.actor, f.started.work!.id)).toEqual(beforeWork);
  expect(f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) n FROM audit WHERE kind='report.review.accept'")!.n)).toBe(1);
  f.store.close(); stores.delete(f.store);
  const store = new S14Store(f.path); stores.add(store); const app = new S14Application(store, f.options), actor = app.authenticate(f.token).actor;
  expect(app.reports.review(actor, f.started.work!.id)).toEqual(receipt.review);
  expect(available(app.reports.view(actor, committed.report.id)).completion).toBe("owner_accepted");
});

test("a newer report revision invalidates acceptance and stale reviews cannot accept either revision", async () => {
  const f = await fixture(), source = await f.read();
  f.app.authority.commit(f.attempt.id, { state: "waiting", text: "First report", report: f.proposal(source) });
  const first = available(f.app.reports.list(f.auth.actor, f.started.work!.id)[0]!), command = acceptance(f, first.report);
  const receipt = f.app.execute(f.auth.actor, command);
  const next = f.admit(), read = await f.app.parallel.read(next.id, "web_fetch", { url: "https://example.com/article", fullContent: true });
  const proposal = f.proposal(read.evidence[0]!); proposal.claims[0]!.citations[0]!.attemptId = next.id;
  f.app.authority.commit(next.id, { state: "ready", text: "Newer report", report: proposal });
  const history = f.app.reports.list(f.auth.actor, first.report.workId).map(available), latest = history[1]!;
  expect(f.app.reports.review(f.auth.actor, first.report.workId)).toMatchObject({ revision: 3, reportId: latest.report.id, reportRevision: 2, completion: "owner_review_required", acceptance: null });
  expect(history.every(item => item.completion === "owner_review_required" && item.acceptance === null)).toBe(true);
  expect(history[0]!.report).toEqual(first.report);
  expect(() => f.app.execute(f.auth.actor, { ...command, requestId: rid(), expectedRevision: 3 })).toThrow("stale_revision");
  expect(() => f.app.execute(f.auth.actor, { ...acceptance(f, latest.report), expectedRevision: receipt.review.revision })).toThrow("stale_revision");
  expect(() => f.app.execute(f.auth.actor, { ...acceptance(f, latest.report), payload: { reportId: latest.report.id, reportRevision: 1 } })).toThrow("stale_revision");
  // An ingress retry returns its historical receipt without reviving current acceptance.
  expect(f.app.execute(f.auth.actor, command)).toEqual(receipt);
  expect(f.app.reports.review(f.auth.actor, first.report.workId).acceptance).toBeNull();
  expect(f.app.execute(f.auth.actor, acceptance(f, latest.report)).review.completion).toBe("owner_accepted");
});

test("report review uses authenticated HTTP, CSRF, exact revisions and rollback-safe receipts", async () => {
  const f = await fixture(), source = await f.read(), committed = publish(f, f.proposal(source)), command = acceptance(f, committed.report);
  const origin = "http://localhost:3001", handler = createS14Handler(f.app, origin), query = `${origin}/api/s14/work/${f.started.work!.id}/report-review`;
  expect((await handler(new Request(query))).status).toBe(401);
  const response = await handler(new Request(query, { headers: { cookie: `jit_s14=${f.token}` } }));
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await response.json()).toMatchObject({ revision: 1, reportId: committed.report.id, reportRevision: 1, completion: "owner_review_required" });
  const request = (csrf: string) => new Request(`${origin}/api/s14/commands`, { method: "POST", headers: { cookie: `jit_s14=${f.token}`, origin, "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify(command) });
  expect((await handler(request("wrong"))).status).toBe(403);
  const fault = new S14Application(f.store, { ...f.options, beforeCommit() { throw Error("fixture_review_rollback"); } });
  expect(() => fault.execute(fault.authenticate(f.token).actor, command)).toThrow("fixture_review_rollback");
  expect(f.app.reports.review(f.auth.actor, f.started.work!.id)).toMatchObject({ revision: 1, acceptance: null });
  const posted = await handler(request(f.auth.csrf)); expect(posted.status).toBe(200);
  const receipt = await posted.json();
  expect(receipt.review.completion).toBe("owner_accepted");
  const form = await handler(new Request(`${origin}/s14/commands`, { method: "POST", headers: { cookie: `jit_s14=${f.token}`, origin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf: f.auth.csrf, command: JSON.stringify(command) }).toString() }));
  expect(form.status).toBe(303);
  const replay = await handler(new Request(`${origin}${form.headers.get("location")}`, { headers: { cookie: `jit_s14=${f.token}` } }));
  expect(await replay.json()).toEqual(receipt);
});

test("model gaps impersonating genuine service codes stay untrusted in reports and downloadable manifests", async () => {
  const f = await fixture(), source = await f.read();
  const spoofed = ["required_evidence:page", "unsupported_claim:claim", "conflicting_claim:claim", "completion_rule_not_machine_verified", `missing_url:${source.url}`];
  const committed = publish(f, f.proposal(source, { missing: spoofed }));
  expect(committed.report.coverage).toBe("partial");
  expect(committed.report.missing).toEqual([]);
  expect(committed.report.modelMissing).toEqual(spoofed);
  const file = committed.artifacts.find(a => a.mediaType === "application/json")!, snapshot = f.app.artifacts.download(f.auth.actor, file.id);
  expect(JSON.parse(new TextDecoder().decode(snapshot.bytes))).toMatchObject({ missing: [], modelMissing: spoofed });
});
