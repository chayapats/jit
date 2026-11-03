import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createHost, credentialReferenceForRoute, describeAuthRoute, HostError, hostCapabilities, isDispatchRefused, listRouteModels, type HostDispatch, type HostOptions, type Model } from "schway/host";

// Packed public consumer for MODEL15-02: only `schway/host` (and Node built-ins) from the installed tarball.
const { root } = await Bun.stdin.json() as { root: string };
const assert = (ok: unknown, label: string) => { if (!ok) throw new Error(label); };
const caps = hostCapabilities();
assert(caps.releaseContract === "schway.host.release/v2", "release");
assert(caps.dispatchAuthorizationContract === "schway.host.dispatch-authorization/v1", "dispatch capability");
assert(caps.providerRequestsContract === "schway.host.provider-requests/v1", "provider requests capability");
assert(caps.effortContract === "schway.host.effort/v1" && caps.outputCapContract === "schway.host.output-cap/v1", "effort and cap capabilities");

const values = new Map<string, string>(), bodies: string[] = [];
let renewals = 0, rejectNext = true;
const store = {
  async get(ref: { account: string }) { return values.get(ref.account) ?? null; },
  async set(ref: { account: string }, value: string) { values.set(ref.account, value); },
  async delete(ref: { account: string }) { return values.delete(ref.account); },
};
values.set(credentialReferenceForRoute("grok").account, JSON.stringify({ accessToken: "fixture-access", refreshToken: "fixture-refresh", obtainedAt: 1, expiresAt: 9_000_000_000_000 }));
function completed(): Response {
  const events = [
    { type: "response.created", response: { id: "resp", status: "in_progress" } },
    { type: "response.output_item.added", output_index: 0, item: { id: "msg", type: "message", role: "assistant", status: "in_progress", content: [] } },
    { type: "response.output_text.delta", output_index: 0, delta: "fixture" },
    { type: "response.output_item.done", output_index: 0, item: { id: "msg", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "fixture" }] } },
    { type: "response.completed", response: { id: "resp", status: "completed", usage: { input_tokens: 3, output_tokens: 2 } } },
  ];
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
}
const fetch: NonNullable<NonNullable<HostOptions["auth"]>["fetch"]> = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url.startsWith("https://api.x.ai/v1/models")) return Response.json({ data: [{ id: "grok-4.7", supported_reasoning_levels: ["low", "high"] }] });
  if (url.startsWith("https://auth.x.ai/")) { renewals++; return Response.json({ access_token: "fixture-renewed", refresh_token: "fixture-rotated", expires_in: 3600 }); }
  if (url === "https://api.x.ai/v1/responses") {
    bodies.push(String(init?.body));
    if (rejectNext) { rejectNext = false; return Response.json({ error: { message: "fixture expired" } }, { status: 401 }); }
    return completed();
  }
  throw new Error("unexpected request");
};

const listing = await listRouteModels({ route: "grok", store, fetch });
assert(listing.status === "listed", "listing");
const choice = listing.status === "listed" ? listing.models.find(model => model.id === "grok-4.7")! : undefined!;
const host = async (name: string) => {
  for (const part of ["workspace", "home", "sessions"]) mkdirSync(`${root}/${name}/${part}`, { recursive: true });
  return createHost({ workspaceRoot: `${root}/${name}/workspace`, homeDirectory: `${root}/${name}/home`, sessionDirectory: `${root}/${name}/sessions`,
    context: { policy: "strict", systemPrompt: "fixture", sections: [] }, tools: { policy: "exact", hostedLookup: "off", definitions: [] },
    limits: { maxTurns: 1, maxConcurrentTools: 1, maxAttempts: 2, contextWindow: 4096, maxInputChars: 1024 }, auth: { route: "grok", model: "grok-4.7", store, fetch } });
};

// Every physical send, the auth-retry resend included, is authorized with exact credential-free evidence.
const runtime = await host("authorized"), dispatches: HostDispatch[] = [];
const route = await runtime.auth!.createModel({ authorizeDispatch: dispatch => { dispatches.push(dispatch); }, catalogModel: choice, effort: { level: "low", mode: "exact" }, maxOutputTokens: 2048, requireOutputCap: true });
const forwarding: Model = { provider: route.provider, id: route.id, stream: (request, call) => route.stream(request, call) };
const session = await runtime.createSession();
const result = await session.submit({ text: "hi" }, forwarding);
await session.close(); await runtime.close();
assert(result.outcome === "completed", "authorized run completes");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

// A throwing authorizer refuses before I/O; the refusal is recognized by identity with the original error as cause.
const refusedRuntime = await host("refused"), own = new Error("fixture refusal"), before = bodies.length;
const refusing = await refusedRuntime.auth!.createModel({ authorizeDispatch: () => { throw own; } });
let refusal: unknown;
try { for await (const _event of refusing.stream({ systemPrompt: "fixture", context: [], items: [{ type: "user", id: "u", content: [{ type: "text", text: "hi" }] }] })) { /* drain */ } }
catch (error) { refusal = error; }
await refusedRuntime.close();

// Codex declares no enforced cap, so requiring one is refused before any request.
let codexCapRefused = false;
const codexRuntime = await createHost({ workspaceRoot: `${root}/authorized/workspace`, homeDirectory: `${root}/authorized/home`, sessionDirectory: `${root}/codex`,
  context: { policy: "strict", systemPrompt: "fixture", sections: [] }, tools: { policy: "exact", hostedLookup: "off", definitions: [] },
  limits: { maxTurns: 1, maxConcurrentTools: 1, maxAttempts: 1, contextWindow: 4096, maxInputChars: 1024 }, auth: { route: "codex", model: "gpt-6-luna", store, fetch } });
try { await codexRuntime.auth!.createModel({ requireOutputCap: true }); } catch (error) { codexCapRefused = error instanceof HostError && error.code === "invalid-input"; }
await codexRuntime.close();

console.log(JSON.stringify({
  dispatches: dispatches.map((dispatch, index) => ({ route: dispatch.route, provider: dispatch.provider, model: dispatch.model, kind: dispatch.kind, sequence: dispatch.sequence,
    hashMatches: dispatch.bodySha256 === sha(bodies[index]!) && dispatch.bodyBytes === Buffer.byteLength(bodies[index]!), effort: dispatch.effort, outputCap: dispatch.outputCap })),
  providerRequests: result.usage.providerRequests, attempt: { effort: result.usage.attempts[0]?.effort, outputCap: result.usage.attempts[0]?.outputCap }, renewals,
  choice: { effort: choice.effort, outputCap: choice.outputCap }, codexCap: describeAuthRoute({ route: "codex", model: "gpt-6-luna" }).outputCap, codexCapRefused,
  refusal: { identity: isDispatchRefused(refusal), cause: (refusal as Error | undefined)?.cause === own, copiedWording: isDispatchRefused(new Error((refusal as Error | undefined)?.message)), sent: bodies.length - before },
}));
