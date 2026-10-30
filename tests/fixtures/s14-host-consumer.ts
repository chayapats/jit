import { createHost, createHostCredentialLifecycle, credentialReferenceForRoute, hostCapabilities, type HostOptions } from "schway/host";

const { root } = await Bun.stdin.json() as { root: string };
const assert = (ok: unknown, label: string) => { if (!ok) throw new Error(label); };
const barrier = () => Promise.withResolvers<void>();
const values = new Map<string, string>();
const store = {
  async get(ref: { account: string }) { return values.get(ref.account) ?? null; },
  async set(ref: { account: string }, value: string) { values.set(ref.account, value); },
  async delete(ref: { account: string }) { return values.delete(ref.account); },
};
const caps = hostCapabilities();
assert(caps.releaseContract === "schway.host.release/v2", "release");
assert(caps.credentialLifecycleContract === "schway.host.credential-lifecycle/v1", "lifecycle capability");
assert(caps.sessionInventoryContract === "schway.host.session-inventory/v1", "inventory capability");
const account = credentialReferenceForRoute("grok"), other = credentialReferenceForRoute("codex");
await store.set(account, JSON.stringify({ accessToken: "fixture-stale", refreshToken: "fixture-refresh", obtainedAt: 1, expiresAt: 1 }));
await store.set(other, "fixture-other-route-untouched");
const renewing = barrier(), renew = barrier(), joined = barrier();
let secondEntered = false, refreshes = 0, calls = 0;
const lifecycle = createHostCredentialLifecycle({ store: { ...store, async get(ref) {
  if (secondEntered && refreshes > 0) joined.resolve();
  return store.get(ref);
} } });
function response(): Response {
  const events = [
    { type: "response.created", response: { id: "resp", status: "in_progress" } },
    { type: "response.output_item.added", output_index: 0, item: { id: "msg", type: "message", role: "assistant", status: "in_progress", content: [] } },
    { type: "response.output_text.delta", output_index: 0, delta: "fixture-evidence" },
    { type: "response.output_item.done", output_index: 0, item: { id: "msg", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "fixture-evidence" }] } },
    { type: "response.completed", response: { id: "resp", status: "completed", usage: { input_tokens: 3, output_tokens: 2 } } },
  ];
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
}
const fetch: NonNullable<NonNullable<HostOptions["auth"]>["fetch"]> = async url => {
  if (String(url).includes("auth.x.ai")) {
    refreshes++;
    renewing.resolve();
    await renew.promise;
    return Response.json({ access_token: "fixture-fresh", refresh_token: "fixture-rotated", expires_in: 3600 });
  }
  calls++;
  return response();
};
for (const part of ["workspace", "home", "sessions"]) await Bun.write(`${root}/${part}/.fixture`, "fixture");
const config: HostOptions = {
  workspaceRoot: `${root}/workspace`, homeDirectory: `${root}/home`, sessionDirectory: `${root}/sessions`,
  context: { policy: "strict", systemPrompt: "First independent context", sections: [] },
  tools: { policy: "exact", hostedLookup: "off", definitions: [] },
  limits: { maxTurns: 1, maxConcurrentTools: 1, maxAttempts: 1, contextWindow: 1024, maxInputChars: 128 },
  auth: { route: "grok", model: "grok-4.7", lifecycle, fetch },
};
const first = await createHost(config);
const second = await createHost({ ...config, context: { ...config.context, systemPrompt: "Second independent context" },
  auth: { ...config.auth!, credentialWriteGuard: () => { secondEntered = true; } } });
const one = await first.createSession(), two = await second.createSession();
const a = one.submitWithRoute({ text: "First" });
await renewing.promise;
const b = two.submitWithRoute({ text: "Second" });
await joined.promise;
let busy = false;
try { await lifecycle.close(); } catch { busy = true; }
assert(busy, "close must refuse active renewal");
renew.resolve();
const results = await Promise.all([a, b]);
assert(results.every(result => result.outcome === "completed"), "both overlapping renewal runs complete");
assert(refreshes === 1 && calls === 2, "renewal single flight");
await one.retire(); await one.close(); await first.close();
assert((await store.get(account))?.includes("fixture-fresh"), "host close must not logout");

// One cancelled native run and closed host cannot abort its valid sibling.
const entered = barrier(), finish = barrier();
const peer = await createHost(config), cancelledSession = await peer.createSession();
const abort = new AbortController();
const cancelled = cancelledSession.submit({ text: "Cancel only me" }, { provider: "scripted", id: "cancel", async *stream(request) {
  entered.resolve();
  await new Promise<void>((resolve) => {
    if (request.signal?.aborted) resolve();
    else request.signal?.addEventListener("abort", () => resolve(), { once: true });
  });
  yield { type: "message_complete", message: { type: "assistant", id: crypto.randomUUID(), content: [{ type: "text", text: "late" }] } };
} }, abort.signal);
await entered.promise;
const siblingEntered = barrier();
const sibling = two.submit({ text: "Keep valid sibling" }, { provider: "scripted", id: "sibling", async *stream() {
  siblingEntered.resolve(); await finish.promise;
  yield { type: "message_complete", message: { type: "assistant", id: crypto.randomUUID(), content: [{ type: "text", text: "retained" }] } };
} });
await siblingEntered.promise;
abort.abort();
assert((await cancelled).outcome === "cancelled", "cancelled outcome");
await cancelledSession.retire(); await cancelledSession.close(); await peer.close();
finish.resolve();
assert((await sibling).outcome === "completed", "sibling remains valid after cancellation and host close");
await two.retire(); await two.close(); await second.close();
// Logout during rotating renewal fences both participants and a late successful response cannot resurrect credentials.
await store.set(account, JSON.stringify({ accessToken: "fixture-expired-again", refreshToken: "fixture-refresh-again", obtainedAt: 1, expiresAt: 1 }));
const logoutRefresh = barrier(), logoutRelease = barrier(), logoutPeer = barrier();
const lateConfig: HostOptions = { ...config, auth: { ...config.auth!, fetch: async url => {
  if (String(url).includes("auth.x.ai")) {
    logoutRefresh.resolve(); await logoutRelease.promise;
    return Response.json({ access_token: "fixture-must-not-resurrect", refresh_token: "fixture-late-refresh", expires_in: 3600 });
  }
  return response();
} } };
const left = await createHost(lateConfig), right = await createHost({ ...lateConfig, auth: { ...lateConfig.auth!, credentialWriteGuard: () => { logoutPeer.resolve(); } } });
const leftSession = await left.createSession(), rightSession = await right.createSession();
const leftPending = leftSession.submitWithRoute({ text: "Logout race left" });
await logoutRefresh.promise;
const rightPending = rightSession.submitWithRoute({ text: "Logout race right" });
await logoutPeer.promise;
const logout = lifecycle.logout("grok");
logoutRelease.resolve();
await logout;
const late = await Promise.all([leftPending, rightPending]);
assert(late.every(result => result.outcome !== "completed"), "logout fences every route participant");
assert(await store.get(account) === null, "late renewal must not resurrect logout");
assert(await store.get(other) === "fixture-other-route-untouched", "sibling route preserved");
await leftSession.close(); await rightSession.close(); await left.close(); await right.close();
await lifecycle.close();
console.log(JSON.stringify({ refreshes, calls, sibling: "completed", cancelled: "cancelled", close: "safe", logout: "route_scoped" }));
