import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { ConnectionVault } from "../src/exec/connections";
import { S14Application } from "../src/s14/application";
import { S14Store } from "../src/s14/store";
import { keenableFetchEndpoint, keenableSearchEndpoint, keenableTitle } from "../src/s14/keenable-protocol";
import type { ParallelTransport } from "../src/s14/parallel-protocol";
import type { ParallelWebOptions } from "../src/s14/parallel";
import type { Policy } from "../src/s14/types";
import type { AuthorityOptions } from "../src/s14/authority-types";

const rid = () => crypto.randomUUID().replaceAll("-", "");
const roots: string[] = [], stores = new Set<S14Store>();
const epoch = 1800000000000, password = "fixture-keenable-owner-password";
const policy: Policy = { routes: [{ id: "selected", provider: "codex", model: "scripted" }], tools: ["web_search", "web_fetch"], resources: [] };
afterEach(() => { for (const store of stores) store.close(); stores.clear(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

type Seen = { url: string; init: RequestInit; body: unknown };
function keenableWire(change?: (event: Seen) => Response | undefined | Promise<Response | undefined>) {
  const seen: Seen[] = [];
  const transport: ParallelTransport = async (url, init) => {
    const event = { url, init, body: init.body ? JSON.parse(init.body as string) : null };
    seen.push(event);
    const changed = await change?.(event);
    if (changed) return changed;
    if (url === keenableSearchEndpoint) {
      return Response.json({ query: "q", mode: "pro", results: [
        { title: "First hit", url: "https://example.com/first", description: "First description", snippet: "First snippet", acquired_at: "2026-11-07T20:10:12Z" },
        { title: "Second hit", url: "https://example.com/second", description: "", snippet: "Second snippet", acquired_at: "2026-11-07T21:00:00Z" },
      ] });
    }
    if (url.startsWith(keenableFetchEndpoint)) {
      return Response.json({ url: "https://example.com/article", title: "Example article", content: "Fetched body text", description: "" });
    }
    throw Error(`Unexpected keenable url ${url}`);
  };
  return { transport, seen };
}
async function fixture(wire = keenableWire(), extra: Omit<ParallelWebOptions, "transport" | "vault"> = {}, runtime: { effects?: AuthorityOptions["effects"]; outputBytes?: number; calls?: number } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "jit-s14-keenable-")));
  roots.push(root);
  const path = join(root, "state", "app.sqlite"), store = new S14Store(path);
  stores.add(store);
  const vault = new ConnectionVault(join(root, "vault"), { forbidden: [join(root, "state"), join(root, "native")] });
  const clock = { now: epoch };
  const outputBytes = runtime.outputBytes ?? 32768, calls = runtime.calls ?? 16;
  const options = { policy, authority: { ...(runtime.effects ? { effects: runtime.effects } : {}) }, chat: { async reply() { return { text: "Fixture reply" }; } }, parallel: { transport: wire.transport, vault, ...extra }, now: () => clock.now };
  const app = new S14Application(store, options);
  await app.provisionOwner(password);
  const token = await app.login(password), auth = app.authenticate(token);
  const setup = app.execute(auth.actor, { kind: "setup", requestId: rid(), expectedRevision: 0, payload: { ownerName: "Owner", language: "en", routeId: "selected", capabilities: { tools: policy.tools, resources: [] } } });
  const started = app.execute(auth.actor, { kind: "work.start", requestId: rid(), expectedRevision: app.conversation(auth.actor, setup.conversation!.id).conversation.revision,
    payload: { conversationId: setup.conversation!.id, task: null, title: "Public research", purpose: "Read public facts", completionRule: "Evidence for review", bots: [{ id: "jit", revision: 1 }], tools: policy.tools, scopes: [], limits: { attempts: 1, steps: 1, calls, outputBytes, wallMs: 60000, concurrency: 2, reads: 40 }, expiresAt: clock.now + 60000 } });
  const attempt = app.authority.admit(started.work!.id, rid(), { botId: "jit", tools: policy.tools, scopes: [], input: "Read public facts", calls, outputBytes });
  return { root, path, store, vault, app, options, clock, auth, token, attempt, work: started.work!, conversationId: setup.conversation!.id, ...wire };
}
type F = Awaited<ReturnType<typeof fixture>>;
function useKeenable(f: F) {
  const revision = f.app.parallel.settings(f.auth.actor).setting.revision;
  f.app.execute(f.auth.actor, { kind: "web.parallel.configure", requestId: rid(), expectedRevision: revision, payload: { mode: "anonymous", connectionId: null, billingAcknowledged: false, provider: "keenable" } });
}
function headersOf(event: Seen): Headers { return new Headers(event.init.headers); }

test("keyless search sends one titled request without key, session or model", async () => {
  const f = await fixture();
  useKeenable(f);
  const read = await f.app.parallel.read(f.attempt.id, "web_search", { query: "melbourne cafes" });
  expect(read).toMatchObject({ outcome: "success", dispatched: true, remoteRequests: 1, provider: "keenable", subject: "melbourne cafes" });
  expect(read.evidence).toHaveLength(2);
  expect(read.evidence[0]).toMatchObject({ coverage: "snippet", freshness: "unknown", provider: "keenable", mode: "anonymous", requestedUrl: null, title: "First hit", reportedRetrievedAt: "2026-11-07T20:10:12Z", untrusted: true });
  expect(read.evidence[0]!.content).toContain("First snippet");
  expect(f.seen).toHaveLength(1);
  const event = f.seen[0]!;
  expect(event.url).toBe(keenableSearchEndpoint);
  expect(headersOf(event).get("X-Keenable-Title")).toBe(keenableTitle);
  expect(headersOf(event).has("authorization")).toBe(false);
  expect(event.body).toEqual({ query: "melbourne cafes" });
  expect(JSON.stringify(event.body)).not.toContain("scripted");
});

test("keyless fetch labels excerpt without full content and full content when asked", async () => {
  const f = await fixture();
  useKeenable(f);
  const excerpt = await f.app.parallel.read(f.attempt.id, "web_fetch", { url: "https://example.com/article", fullContent: false });
  expect(excerpt).toMatchObject({ outcome: "success", provider: "keenable" });
  expect(excerpt.evidence[0]).toMatchObject({ coverage: "excerpt", provider: "keenable", requestedUrl: "https://example.com/article" });
  const fetchEvent = f.seen[0]!;
  expect(fetchEvent.url.startsWith(keenableFetchEndpoint)).toBe(true);
  expect(fetchEvent.url).toContain(encodeURIComponent("https://example.com/article"));
  expect(headersOf(fetchEvent).get("X-Keenable-Title")).toBe(keenableTitle);
  expect(headersOf(fetchEvent).has("authorization")).toBe(false);
  const full = await f.app.parallel.read(f.attempt.id, "web_fetch", { url: "https://example.com/article", fullContent: true });
  expect(full.evidence[0]).toMatchObject({ coverage: "full_content_returned" });
});

test("fetch 404 becomes partial with missing url and not_found failure", async () => {
  const f = await fixture(keenableWire(event => {
    if (event.url.startsWith(keenableFetchEndpoint)) return Response.json({ error: "Not found", message: "The page does not exist at this URL." }, { status: 404 });
    return undefined;
  }));
  useKeenable(f);
  const read = await f.app.parallel.read(f.attempt.id, "web_fetch", { url: "https://example.com/gone", fullContent: false });
  expect(read).toMatchObject({ outcome: "partial", dispatched: true, provider: "keenable", evidence: [], missing: ["https://example.com/gone"] });
  expect(read.failures).toEqual([{ url: "https://example.com/gone", kind: "not_found", status: 404 }]);
});

test("429 quota carries the retry deadline and fences later keenable reads without dispatch", async () => {
  const f = await fixture(keenableWire(() => new Response(null, { status: 429, headers: { "Retry-After": "3" } })));
  useKeenable(f);
  const first = await f.app.parallel.read(f.attempt.id, "web_search", { query: "quota probe" });
  expect(first).toMatchObject({ outcome: "quota", provider: "keenable", remoteRequests: 1, dispatched: true, retryAt: epoch + 3000 });
  const second = await f.app.parallel.read(f.attempt.id, "web_search", { query: "quota probe again" });
  expect(second).toMatchObject({ outcome: "quota", remoteRequests: 0, dispatched: false, retryAt: epoch + 3000 });
});

test("keenable quota does not fence parallel reads; providers are fenced separately", async () => {
  const f = await fixture(keenableWire(() => new Response(null, { status: 429 })));
  useKeenable(f);
  expect((await f.app.parallel.read(f.attempt.id, "web_search", { query: "quota probe" })).outcome).toBe("quota");
  const revision = f.app.parallel.settings(f.auth.actor).setting.revision;
  f.app.execute(f.auth.actor, { kind: "web.parallel.configure", requestId: rid(), expectedRevision: revision, payload: { mode: "anonymous", connectionId: null, billingAcknowledged: false, provider: "parallel" } });
  expect(f.store.read(tx => f.app.parallel.quota(tx, f.work.id))).toBeNull();
});

test("keyed keenable mode is refused and a saved Parallel key never reaches Keenable", async () => {
  const f = await fixture();
  const connection = f.app.execute(f.auth.actor, { kind: "web.parallel.key.set", requestId: rid(), expectedRevision: 0, payload: { secret: "fixture-parallel-never-to-keenable" } }).connection!;
  expect(() => f.app.execute(f.auth.actor, { kind: "web.parallel.configure", requestId: rid(), expectedRevision: 1, payload: { mode: "authenticated", connectionId: connection.id, billingAcknowledged: true, provider: "keenable" } })).toThrow("invalid_parallel_provider");
  useKeenable(f);
  const read = await f.app.parallel.read(f.attempt.id, "web_search", { query: "public docs" });
  expect(read.outcome).toBe("success");
  expect(f.seen.every(event => !headersOf(event).has("authorization"))).toBe(true);
  expect(JSON.stringify(f.seen)).not.toContain("fixture-parallel-never-to-keenable");
});

test("oversize page content fails closed instead of being cut silently", async () => {
  const f = await fixture(keenableWire(event => {
    if (event.url.startsWith(keenableFetchEndpoint)) return Response.json({ url: "https://example.com/article", title: "Long", content: "x".repeat(3000), description: "" });
    return undefined;
  }), { responseBytes: 1024 });
  useKeenable(f);
  const read = await f.app.parallel.read(f.attempt.id, "web_fetch", { url: "https://example.com/article", fullContent: true });
  expect(read.outcome).toBe("oversize");
  expect(read.evidence).toEqual([]);
});

test("a description-only answer to a full-content request stays an excerpt and the read is partial", async () => {
  const f = await fixture(keenableWire(event => {
    if (event.url.startsWith(keenableFetchEndpoint)) return Response.json({ url: "https://example.com/article", title: "Example article", content: "", description: "Short summary only" });
    return undefined;
  }));
  useKeenable(f);
  const read = await f.app.parallel.read(f.attempt.id, "web_fetch", { url: "https://example.com/article", fullContent: true });
  expect(read).toMatchObject({ outcome: "partial", provider: "keenable" });
  expect(read.evidence[0]).toMatchObject({ coverage: "excerpt", requestedUrl: "https://example.com/article", content: "Short summary only" });
  expect(read.evidence.some(item => item.coverage === "full_content_returned")).toBe(false);
});

test("a page returned for a different url keeps the requested url missing and the read partial", async () => {
  const f = await fixture(keenableWire(event => {
    if (event.url.startsWith(keenableFetchEndpoint)) return Response.json({ url: "https://example.com/elsewhere", title: "Elsewhere", content: "Some other page", description: "" });
    return undefined;
  }));
  useKeenable(f);
  const read = await f.app.parallel.read(f.attempt.id, "web_fetch", { url: "https://example.com/article", fullContent: false });
  expect(read).toMatchObject({ outcome: "partial", provider: "keenable", missing: ["https://example.com/article"] });
  expect(read.evidence[0]).toMatchObject({ requestedUrl: null, url: "https://example.com/elsewhere" });
});

test("a streamed body past the byte cap stops reading and cancels the stream", async () => {
  let pulls = 0, cancelled = false;
  const f = await fixture(keenableWire(event => {
    if (!event.url.startsWith(keenableFetchEndpoint)) return undefined;
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) { pulls++; controller.enqueue(new Uint8Array(512).fill(120)); },
      cancel() { cancelled = true; },
    }), { headers: { "content-type": "application/json" } });
  }), { responseBytes: 1024 });
  useKeenable(f);
  const read = await f.app.parallel.read(f.attempt.id, "web_fetch", { url: "https://example.com/article", fullContent: true });
  expect(read.outcome).toBe("oversize");
  expect(read.evidence).toEqual([]);
  expect(pulls).toBeLessThanOrEqual(5);
  expect(cancelled).toBe(true);
});
