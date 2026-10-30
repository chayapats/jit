import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { S14Application, type S14Options } from "../../src/s14/application";
import type { Attempt, StartPayload, WorkOutput } from "../../src/s14/authority-types";
import type { SchedulerLimits } from "../../src/s14/graph-types";
import type { ExternalEvidence } from "../../src/s14/parallel-types";
import type { ReportClaimProposal, ReportProposal } from "../../src/s14/report-types";
import { S14Store } from "../../src/s14/store";
import type { Bot } from "../../src/s14/types";
import { canonical } from "../../src/s14/validation";
import { createS14Handler } from "../../src/s14/web";
import { renderS14 } from "../../src/s14/web-pages";
import { createS14Product } from "../../src/s14/web-product";
import anonymous from "./parallel/tools-anonymous.json";

export const origin = "http://localhost:3001";
export const rid = () => crypto.randomUUID().replaceAll("-", "");
const password = "fixture-s14-team-ui-owner";
/** Scripted run of one lane, so a test decides when it enters, settles and what it returns. */
export type LaneScript = (attempt: Attempt, signal: AbortSignal) => Promise<WorkOutput>;
/** Bot id, or `<bot>:<handler>` when one Bot has two lanes. */
export type LaneScripts = Record<string, LaneScript>;
/** A lane that holds its transport open until released; `entered` proves it really started. */
export function gate() {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  return { entered: entered.promise, release: release.resolve, run: (result: () => Promise<WorkOutput> | WorkOutput): LaneScript => async () => { entered.resolve(); await release.promise; return result(); } };
}

/** Real application, store, scheduler and handler with two extra Bots, a scripted executor and fixture Parallel reads. */
export async function teamFixture(options: { language?: "th" | "en"; scheduler?: SchedulerLimits; fullContent?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "jit-s14-team-ui-")), store = new S14Store(join(root, "s14.sqlite"));
  const clock = { now: 1800000000000 }, scripts: { lanes: LaneScripts } = { lanes: {} }, source = { fullContent: options.fullContent ?? "Returned full markdown from the requested page." };
  const tools = ["web_search", "web_fetch", "computer"];
  const transport = async (_url: string, init: RequestInit) => {
    const wire = JSON.parse(init.body as string), rpc = (result: unknown) => Response.json({ jsonrpc: "2.0", id: wire.id, result });
    if (wire.method === "initialize") return rpc({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } });
    if (wire.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (wire.method === "tools/list") return Response.json(anonymous);
    if (wire.method === "tools/call") return rpc({ structuredContent: { extract_id: "fixture_extract", results: [{ url: wire.params.arguments.urls?.[0] ?? "https://example.com/article", title: "Public article", excerpts: ["Relevant excerpt"], full_content: source.fullContent, cache_status: "cached", cached_at: "2026-10-01T00:00:00Z" }], errors: [], session_id: "parallel_fixture_conversation" } });
    throw Error("unexpected wire method");
  };
  const app = new S14Application(store, { policy: { routes: [{ id: "selected", provider: "codex", model: "scripted-model" }], tools, resources: [] }, chat: { async reply() { return { text: "ok" }; } }, now: () => clock.now, parallel: { transport },
    authority: { scheduler: options.scheduler ?? { global: 4, route: 4, bot: 2, computer: 2 }, executor: { run(attempt, signal) {
      const script = scripts.lanes[`${attempt.snapshot.bot.id}:${attempt.step?.handler}`] ?? scripts.lanes[attempt.snapshot.bot.id];
      return script ? script(attempt, signal) : Promise.resolve({ state: "ready", text: `Evidence from ${attempt.snapshot.bot.id}` });
    } } } } as S14Options);
  await app.provisionOwner(password);
  const token = await app.login(password), auth = app.authenticate(token), handler = createS14Handler(app, origin, renderS14, createS14Product(app));
  const setup = app.execute(auth.actor, { kind: "setup", requestId: rid(), expectedRevision: 0, payload: { ownerName: "Owner", language: options.language ?? "en", routeId: "selected", capabilities: { tools, resources: [] } } });
  const conversationId = setup.conversation!.id;
  store.transaction(tx => {
    for (const [id, name] of [["scout", options.language === "th" ? "นักค้น" : "Scout"], ["analyst", options.language === "th" ? "นักเทียบ" : "Analyst"]] as const) {
      const peer: Bot = { ...setup.bot!, id, name, responsibility: `${name} duty`, capabilities: { tools, resources: [] } };
      tx.run("INSERT INTO bots VALUES (?,?)", peer.id, canonical(peer));
      tx.run("INSERT INTO conversations VALUES (?,?,1)", `${id}chat`, peer.id);
    }
  });
  const get = (path: string) => handler(new Request(`${origin}${path}`, { headers: { cookie: `jit_s14=${token}` } }));
  const page = async (path: string) => { const response = await get(path); if (response.status !== 200) throw new Error(`${path}: ${response.status}`); return response.text(); };
  const post = (path: string, fields: Record<string, string>) => handler(new Request(`${origin}${path}`, { method: "POST", headers: { cookie: `jit_s14=${token}`, origin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() }));
  const start = (changes: Partial<StartPayload> = {}) => {
    const payload: StartPayload = { conversationId, task: null, title: "Compare hosts", purpose: "Compare public hosts", completionRule: "Owner reviews a sourced report", bots: [{ id: "jit", revision: 1 }, { id: "scout", revision: 1 }, { id: "analyst", revision: 1 }], tools: ["web_search", "web_fetch"], scopes: [], limits: { attempts: 8, steps: 8, calls: 64, reads: 40, concurrency: 2, outputBytes: 262144, wallMs: 1800000 }, expiresAt: clock.now + 1800000, ...changes };
    return app.execute(auth.actor, { kind: "work.start", requestId: rid(), expectedRevision: app.conversation(auth.actor, conversationId).conversation.revision, payload }).work!;
  };
  const steps = (workId: string) => app.graph.view(auth.actor, workId).steps;
  const read = async (attempt: Attempt, url = "https://example.com/article") => (await app.parallel.read(attempt.id, "web_fetch", { url, fullContent: true })).evidence[0]!;
  const close = () => { store.close(); rmSync(root, { recursive: true, force: true }); };
  return { app, store, clock, source, scripts, auth, token, handler, conversationId, get, page, post, start, steps, read, close };
}
export type TeamFixture = Awaited<ReturnType<typeof teamFixture>>;

/** Cited claim bound to evidence this run really read; `quote` must stay inside that evidence. */
export const claim = (attempt: Attempt, source: ExternalEvidence, changes: Partial<ReportClaimProposal> = {}): ReportClaimProposal => ({ id: "claim_a", text: source.content, kind: "quote", citations: [{ attemptId: attempt.id, id: source.id, revision: source.revision, quote: source.content, scope: "page" }], covers: [], conflicts: [], ...changes });
export const report = (claims: ReportClaimProposal[], changes: Partial<ReportProposal> = {}): ReportProposal => ({ title: "Host comparison", claims, missing: [], limitations: [], artifactIds: [], ...changes });
