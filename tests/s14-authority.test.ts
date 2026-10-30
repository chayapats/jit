import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { S14Application, type S14Options } from "../src/s14/application";
import { S14Store } from "../src/s14/store";
import { createS14Handler } from "../src/s14/web";
import type { Admission, AuthorityOptions, Effect, EffectAction, ScopePolicy, ScopeRef, StartWorkCommand, Work } from "../src/s14/authority-types";
import type { Bot, Policy } from "../src/s14/types";
import { canonical, canonicalByteLimit } from "../src/s14/validation";
import { renderS14 } from "../src/s14/web-pages";
import { createS14Product } from "../src/s14/web-product";
import { acquireS14RuntimeLock } from "../src/s14/runtime-lock";
import type { ReportProposal } from "../src/s14/report-types";
import { artifactHash } from "../src/s14/artifacts";

const rid = () => crypto.randomUUID().replaceAll("-", "");
const roots: string[] = [], stores = new Set<S14Store>();
const epoch = 1800000000000, password = "fixture-authority-owner-password";
const policy: Policy = { routes: [{ id: "selected", provider: "codex", model: "scripted" }], tools: ["public_read", "effect_send", "effect_push"], resources: ["resource1", "share1", "other"] };
afterEach(() => { for (const store of stores) store.close(); stores.clear(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture(authority: AuthorityOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "jit-s14-auth-")); roots.push(root);
  const path = join(root, "s14.sqlite"), store = new S14Store(path); stores.add(store);
  const clock = { now: epoch }; const scopes = new Map<string, ScopePolicy>();
  const options: S14Options = { policy, now: () => clock.now, chat: { async reply() { return { text: "Suggestion only", task: { title: "Research", purpose: "Compare public facts", completionRule: "Evidence for owner review" } }; } }, authority: { scopes: { current: (_tx, ref) => scopes.get(ref.id) ?? null }, ...authority } };
  const app = new S14Application(store, options); await app.provisionOwner(password); const token = await app.login(password), auth = app.authenticate(token);
  const setup = app.execute(auth.actor, { kind: "setup", requestId: rid(), expectedRevision: 0, payload: { ownerName: "Owner", language: "en", routeId: "selected", capabilities: { tools: policy.tools, resources: policy.resources } } });
  return { root, path, store, clock, app, options, scopes, token, auth, conversationId: setup.conversation!.id, bot: setup.bot! };
}
type F = Awaited<ReturnType<typeof fixture>>;
function start(f: F, changes: Partial<StartWorkCommand["payload"]> = {}): StartWorkCommand {
  return { kind: "work.start", requestId: rid(), expectedRevision: f.app.conversation(f.auth.actor, f.conversationId).conversation.revision,
    payload: { conversationId: f.conversationId, task: null, title: "Research", purpose: "Compare public facts", completionRule: "Evidence for owner review", bots: [{ id: "jit", revision: 1 }], tools: [], scopes: [], limits: { attempts: 4, steps: 4, calls: 8, outputBytes: 8192, wallMs: 60000, concurrency: 2, reads: 40 }, expiresAt: f.clock.now + 60000, ...changes } };
}
function admission(changes: Partial<Admission> = {}): Admission { return { botId: "jit", tools: [], scopes: [], input: "Compare public facts", calls: 6, outputBytes: 1024, ...changes }; }
function scope(f: F, kind: "resource" | "share" = "resource", changes: Partial<ScopePolicy> = {}): ScopeRef {
  const ref: ScopeRef = { kind, id: kind === "share" ? "share1" : "resource1", revision: 1 };
  f.scopes.set(ref.id, { ref, active: true, ownerBotId: kind === "share" ? "otherBot" : "jit", receiverBotId: kind === "share" ? "jit" : null, workId: null, tools: policy.tools, snapshot: { id: "snapshot1", revision: 1, hash: "a".repeat(64) }, ...changes }); return ref;
}
function stop(f: F, work: Work) { return f.app.execute(f.auth.actor, { kind: "work.stop", requestId: rid(), expectedRevision: work.revision, payload: { workId: work.id } }); }
const send: EffectAction = { kind: "send", destination: "https://recipient.invalid/exact", content: "Exact visible content" };

test.each(["resource", "share"] as const)("%s revocation reaches uncited source copies, reports, downloads, staging and late publication", async kind => {
  const f = await fixture(), ref = scope(f, kind);
  const work = f.app.execute(f.auth.actor, start(f, { scopes: [ref], limits: { ...start(f).payload.limits, outputBytes: 131072 } })).work!;
  const producer = f.app.authority.admit(work.id, rid(), admission({ scopes: [ref], outputBytes: 32768 }));
  f.app.authority.commit(producer.id, { state: "waiting", text: "Scoped source text" });
  const report: ReportProposal = { title: "Scoped report", claims: [{ id: "claim", kind: "inference", text: "Uncited scoped derivative", citations: [], covers: [], conflicts: [] }], missing: [], limitations: [], artifactIds: [] };
  const derived = () => {
    const a = f.app.authority.admit(work.id, rid(), admission({ outputBytes: 32768 }));
    f.store.transaction(tx => f.app.memory.appendSource(tx, a.id, { id: `result_${producer.id}`, revision: 1, generation: 1 }));
    return a;
  };
  const committed = derived();
  f.app.authority.commit(committed.id, { state: "waiting", text: "Available derivative", report });
  const view = f.app.reports.list(f.auth.actor, work.id)[0]!;
  if (view.state !== "available") throw Error("report unavailable before revocation");
  const late = derived(), bytes = new TextEncoder().encode("Scoped staged bytes");
  const staged = f.store.transaction(tx => f.app.artifacts.stage(tx, late, { name: "scoped.txt", mediaType: "text/plain", size: bytes.length, sha256: artifactHash(bytes) }, bytes));
  f.scopes.delete(ref.id);
  // Currentness must return unavailable rather than throw and roll back an unrelated owner memory command.
  f.app.execute(f.auth.actor, { kind: "memory.remember", requestId: rid(), expectedRevision: f.app.conversation(f.auth.actor, f.conversationId).conversation.revision, payload: { conversationId: f.conversationId, text: "Independent owner fact" } });
  expect(f.app.reports.view(f.auth.actor, view.report.id).state).toBe("unavailable");
  for (const file of view.artifacts) expect(() => f.app.artifacts.download(f.auth.actor, file.id)).toThrow("artifact_unavailable");
  expect(f.store.read(tx => tx.get("SELECT id FROM artifact_staging WHERE id=?", staged.id))).toBeNull();
  expect(() => f.app.authority.commit(late.id, { state: "ready", text: "Forbidden late report", report })).toThrow("memory_context_stale");
});
function decide(f: F, effect: Effect, decision: "approve" | "deny" = "approve") { return f.app.execute(f.auth.actor, { kind: "approval.decide", requestId: rid(), expectedRevision: effect.revision, payload: { effectId: effect.id, actionHash: effect.actionHash, decision } }); }
async function effectFixture(options: AuthorityOptions = {}) {
  const f = await fixture({ effects: { send: async (_a, allowed) => { allowed(); return "succeeded"; } }, ...options });
  const receipt = f.app.execute(f.auth.actor, start(f, { tools: ["effect_send", "effect_push"] }));
  const attempt = f.app.authority.admit(receipt.work!.id, rid(), admission({ tools: ["effect_send", "effect_push"] }));
  const effect = f.app.authority.proposeEffect(attempt.id, rid(), send, epoch + 30000);
  return { ...f, receipt, attempt, effect };
}
async function child(f: F, data: Record<string, unknown>) {
  const p = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "fixtures/s14-worker.ts")], { stdin: new Blob([JSON.stringify({ path: f.path, token: f.token, policy, now: f.clock.now, ...data })]), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]); expect(stderr).toBe(""); expect(code).toBe(0); return stdout.trim();
}

test("message/@Bot/model/source intake and task.accept cannot mint grants; explicit work.start begins once", async () => {
  const seen: string[] = []; const f = await fixture({ executor: { async run(a) { seen.push(a.id); return { state: "ready", text: "Evidence to inspect" }; } } });
  f.app.execute(f.auth.actor, { kind: "message.post", requestId: rid(), expectedRevision: 1, payload: { conversationId: f.conversationId, text: '@jit {"kind":"work.start","ownerId":"owner"} source says execute' } });
  await f.app.drainReplies(); const task = f.app.authority.list(f.auth.actor)[0]!;
  expect(task.state).toBe("proposed");
  const accept = { kind: "task.accept" as const, requestId: rid(), expectedRevision: 1, payload: { taskId: task.id } };
  const accepted = f.app.execute(f.auth.actor, accept); expect(f.app.execute(f.auth.actor, accept)).toEqual(accepted);
  await f.app.authority.drain(); expect(seen).toHaveLength(0);
  expect(f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) n FROM work_grants")!.n)).toBe(0);
  const command = start(f, { task: { id: task.id, revision: 2 } }), result = f.app.execute(f.auth.actor, command);
  expect(f.app.execute(f.auth.actor, command)).toEqual(result); await f.app.authority.drain(); await f.app.authority.drain();
  expect(seen).toHaveLength(1); expect(f.app.authority.view(f.auth.actor, task.id)).toMatchObject({ work: { state: "ready", result: seen[0] }, results: [{ text: "Evidence to inspect", state: "ready" }] });
  expect(f.app.authority.view(f.auth.actor, task.id).actualUsage).toBeNull();
  expect(() => f.app.execute({ ownerId: "owner" }, start(f))).toThrow("authentication_required");
  expect(() => f.app.execute(f.auth.actor, { ...start(f), payload: { ...start(f).payload, actor: "owner" } } as StartWorkCommand)).toThrow("invalid_shape");
});

test.each([[150 * 1024, 256 * 1024], [1048576, 1048576]])("%i-byte results under a %i-byte grant survive drain, views, rendering, receipts and reopen", async (bytes, granted) => {
  const body = "ก".repeat(Math.floor(bytes / 3)) + "x".repeat(bytes % 3);
  const f = await fixture({ executor: { async run() { return { state: "ready", text: body }; } } });
  const command = start(f, { limits: { attempts: 1, steps: 1, calls: 1, outputBytes: granted, wallMs: 60000, concurrency: 2, reads: 40 } }), receipt = f.app.execute(f.auth.actor, command);
  await f.app.authority.drain();
  const view = f.app.authority.view(f.auth.actor, receipt.work!.id);
  expect(view.work).toMatchObject({ state: "ready", result: view.attempts[0]!.id });
  expect(view.results).toEqual([{ attemptId: view.attempts[0]!.id, workId: view.work.id, text: body, state: "ready", committedAt: epoch }]);
  const stored = f.store.read(tx => tx.get<{ record_json: string }>("SELECT record_json FROM work_items WHERE id=?", view.work.id)!.record_json);
  expect(Buffer.byteLength(stored)).toBeLessThan(canonicalByteLimit); expect(stored).not.toContain(body);
  const web = createS14Handler(f.app, "http://localhost:3001", renderS14, createS14Product(f.app));
  const request = (path: string) => new Request(`http://localhost:3001${path}`, { headers: { cookie: `jit_s14=${f.token}` } });
  expect((await (await web(request(`/api/s14/work/${view.work.id}`))).json()).results[0].text).toBe(body);
  expect(await (await web(request(`/work/${view.work.id}`))).text()).toContain(body);
  const stopped = stop(f, view.work);
  expect(Buffer.byteLength(canonical(stopped))).toBeLessThan(canonicalByteLimit);
  expect(stopped.work!.result).toBe(view.attempts[0]!.id);
  expect(f.app.execute(f.auth.actor, command)).toEqual(receipt);
  f.store.close(); stores.delete(f.store);
  const store = new S14Store(f.path); stores.add(store);
  const app = new S14Application(store, f.options), actor = app.authenticate(f.token).actor;
  expect(app.authority.view(actor, view.work.id).results).toEqual(view.results);
});

test.each(["deny", "succeeded", "failed", "unknown", "expired-pending", "expired-approved", "stop"] as const)("a committed ready result re-evaluates after effect %s without releasing unknown outcomes", async outcome => {
  const f = await effectFixture({ effects: { send: async (_a, allowed) => { allowed(); return outcome === "unknown" || outcome === "failed" ? outcome : "succeeded"; } } });
  f.app.authority.commit(f.attempt.id, { state: "ready", text: "Committed evidence" });
  const waiting = f.app.authority.view(f.auth.actor, f.receipt.work!.id);
  expect(waiting.work.state).toBe("waiting"); expect(waiting.attempts[0]!.state).toBe("waiting");
  if (outcome === "deny") decide(f, f.effect, "deny");
  else if (outcome === "stop") stop(f, waiting.work);
  else if (outcome.startsWith("expired")) {
    if (outcome === "expired-approved") decide(f, f.effect);
    f.clock.now += 30000; await f.app.authority.drain();
  } else { decide(f, f.effect); await f.app.authority.runEffect(f.effect.id, 1, f.effect.actionHash); }
  const view = f.app.authority.view(f.auth.actor, waiting.work.id);
  expect(view.work.state).toBe(outcome === "unknown" ? "waiting" : outcome === "stop" ? "stopped" : "ready");
  expect(view.attempts[0]!.state).toBe(outcome === "unknown" ? "waiting" : outcome === "stop" ? "settled" : "committed");
  expect(view.results[0]!.text).toBe("Committed evidence");
  if (outcome === "unknown") {
    f.clock.now += 60000; await f.app.authority.drain();
    expect(f.app.authority.view(f.auth.actor, view.work.id)).toMatchObject({ work: { state: "waiting" }, effects: [{ state: "unknown" }], attempts: [{ state: "waiting" }] });
    await expect(f.app.authority.runEffect(f.effect.id, 1, f.effect.actionHash)).rejects.toThrow("stale_approval");
  }
});

test.each(["deny", "succeeded", "expired"] as const)("a deliberately waiting result stays waiting after effect %s", async outcome => {
  const f = await effectFixture(); f.app.authority.commit(f.attempt.id, { state: "waiting", text: "Still waiting for other input" });
  if (outcome === "deny") decide(f, f.effect, "deny");
  else if (outcome === "expired") { f.clock.now += 30000; await f.app.authority.drain(); }
  else { decide(f, f.effect); await f.app.authority.runEffect(f.effect.id, 1, f.effect.actionHash); }
  expect(f.app.authority.view(f.auth.actor, f.receipt.work!.id)).toMatchObject({ work: { state: "waiting" }, attempts: [{ state: "waiting" }], results: [{ state: "waiting" }] });
});

test("separate sibling results retain their bodies and a ready child cannot release its parent's held effect", async () => {
  const f = await fixture(), started = f.app.execute(f.auth.actor, start(f, { tools: ["effect_send"], limits: { attempts: 2, steps: 2, calls: 8, outputBytes: 524288, wallMs: 60000, concurrency: 2, reads: 40 } }));
  const parent = f.app.authority.admit(started.work!.id, rid(), admission({ tools: ["effect_send"], outputBytes: 262144 }));
  const effect = f.app.authority.proposeEffect(parent.id, rid(), send, epoch + 30000);
  const first = "first".repeat(40000), second = "second".repeat(40000);
  f.app.authority.commit(parent.id, { state: "ready", text: first });
  const child = f.app.authority.delegate(parent.id, rid(), admission({ outputBytes: 262144 }));
  f.app.authority.commit(child.id, { state: "ready", text: second });
  const held = f.app.authority.view(f.auth.actor, started.work!.id);
  expect(held.work).toMatchObject({ state: "waiting", result: child.id });
  expect(held.attempts.map(a => a.state)).toEqual(["waiting", "committed"]);
  expect(held.results.map(r => r.text)).toEqual([first, second]);
  decide(f, effect, "deny");
  const ready = f.app.authority.view(f.auth.actor, started.work!.id);
  expect(ready.work.state).toBe("ready"); expect(ready.attempts.map(a => a.state)).toEqual(["committed", "committed"]);
});

test("stop during an effect with a committed ready result settles work without resolving its unknown outcome", async () => {
  let finish!: () => void; const gate = new Promise<void>(resolve => { finish = resolve; });
  const f = await effectFixture({ effects: { send: async () => { await gate; return "succeeded"; } } });
  f.app.authority.commit(f.attempt.id, { state: "ready", text: "Retained result" }); decide(f, f.effect);
  const running = f.app.authority.runEffect(f.effect.id, 1, f.effect.actionHash);
  expect(stop(f, f.app.authority.view(f.auth.actor, f.receipt.work!.id).work).work!.state).toBe("stopping");
  finish(); expect((await running).state).toBe("unknown");
  await f.app.authority.drain();
  expect(f.app.authority.view(f.auth.actor, f.receipt.work!.id)).toMatchObject({ work: { state: "stopped" }, attempts: [{ state: "settled" }], effects: [{ state: "unknown" }], results: [{ state: "ready", text: "Retained result" }] });
});

test("a competing composition root refuses the held runtime lock before recovering live attempts", async () => {
  const f = await fixture(), started = f.app.execute(f.auth.actor, start(f));
  f.app.authority.admit(started.work!.id, rid(), admission());
  const release = acquireS14RuntimeLock(f.path);
  try {
    const process = Bun.spawn([Bun.which("bun")!, "--no-env-file", "src/main.ts", "serve", "--s14"], { env: { ...globalThis.process.env, JIT_S14_DATABASE: f.path }, stdout: "pipe", stderr: "pipe" });
    expect(await process.exited).toBe(1);
    expect(await new Response(process.stderr).text()).toContain("s14_runtime_already_open");
    expect(f.app.authority.view(f.auth.actor, started.work!.id)).toMatchObject({ work: { state: "running" }, attempts: [{ state: "running" }] });
  } finally { release(); }
});

test("work/grant/queue/receipt transaction rolls back as one; two processes and restart deduplicate one start", async () => {
  const f = await fixture(); let fail = true;
  const fault = new S14Application(f.store, { ...f.options, beforeCommit: () => { if (fail) throw Error("fixture_fault"); } }), actor = fault.authenticate(f.token).actor;
  const command = start(f); expect(() => fault.execute(actor, command)).toThrow("fixture_fault");
  for (const table of ["work_items", "work_grants", "grant_state", "grant_usage", "work_queue"]) expect(f.store.read(tx => tx.get<{ n: number }>(`SELECT count(*) n FROM ${table}`)!.n)).toBe(0);
  fail = false; const [a, b] = await Promise.all([child(f, { mode: "command", command }), child(f, { mode: "command", command })]); expect(JSON.parse(a)).toEqual(JSON.parse(b));
  const original = f.app.execute(f.auth.actor, command); expect(JSON.parse(a)).toEqual(original);
  f.store.close(); stores.delete(f.store); const reopened = new S14Store(f.path); stores.add(reopened);
  const app = new S14Application(reopened, f.options); app.authority.recover(); expect(app.execute(app.authenticate(f.token).actor, command)).toEqual(original);
  expect(reopened.read(tx => tx.get<{ n: number }>("SELECT count(*) n FROM work_queue")!.n)).toBe(1);
  expect(() => app.execute(app.authenticate(f.token).actor, { ...command, payload: { ...command.payload, title: "changed" } })).toThrow("request_id_conflict");
});

test.each(["resource", "share"] as const)("%s revocation/stale snapshot refuses admission, tool and publication barriers", async kind => {
  for (const barrier of ["admission", "tool", "publication"] as const) {
    const f = await fixture(), ref = scope(f, kind), command = start(f, { tools: ["public_read"], scopes: [ref] });
    const started = f.app.execute(f.auth.actor, command), spec = admission({ tools: ["public_read"], scopes: [ref] });
    if (barrier === "admission") { f.scopes.get(ref.id)!.active = false; expect(() => f.app.authority.admit(started.work!.id, rid(), spec)).toThrow("scope_revoked_or_stale"); }
    else {
      const attempt = f.app.authority.admit(started.work!.id, rid(), spec); f.scopes.get(ref.id)!.active = false;
      expect(() => barrier === "tool" ? f.app.authority.reserveTool(attempt.id, "public_read", ref) : f.app.authority.commit(attempt.id, { state: "ready", text: "Late evidence" })).toThrow("scope_revoked_or_stale");
      expect(f.app.authority.view(f.auth.actor, started.work!.id).work.result).toBeNull();
    }
  }
});

test("grant/expiry/owner and Bot revision fences refuse admission, calls and late commits", async () => {
  for (const change of ["stop", "expiry", "owner", "bot", "resource-revision", "share-snapshot"] as const) {
    const f = await fixture(), ref = scope(f, change === "share-snapshot" ? "share" : "resource"), started = f.app.execute(f.auth.actor, start(f, { tools: ["public_read"], scopes: [ref] }));
    const attempt = f.app.authority.admit(started.work!.id, rid(), admission({ tools: ["public_read"], scopes: [ref] }));
    if (change === "stop") stop(f, f.app.authority.view(f.auth.actor, started.work!.id).work);
    if (change === "expiry") f.clock.now += 60000;
    if (change === "owner") f.store.transaction(tx => tx.run("UPDATE owner SET generation=generation+1"));
    if (change === "bot") f.store.transaction(tx => { const b = { ...f.bot, generation: 2, revision: 2 }; tx.run("UPDATE bots SET record_json=? WHERE id='jit'", JSON.stringify(b)); });
    if (change === "resource-revision") f.scopes.get(ref.id)!.ref = { ...ref, revision: 2 };
    if (change === "share-snapshot") f.scopes.get(ref.id)!.snapshot.hash = "b".repeat(64);
    expect(() => f.app.authority.admit(started.work!.id, rid(), admission({ tools: ["public_read"], scopes: [ref] }))).toThrow();
    expect(() => f.app.authority.reserveTool(attempt.id, "public_read", ref)).toThrow();
    expect(() => f.app.authority.commit(attempt.id, { state: "ready", text: "Late" })).toThrow();
  }
});

test("delegation intersects parent narrowing, origin Bot list, receiver ceiling and scoped identities", async () => {
  const f = await fixture(); const receiver: Bot = { ...f.bot, id: "receiver", capabilities: { tools: ["public_read"], resources: [] } };
  f.store.transaction(tx => tx.run("INSERT INTO bots VALUES (?,?)", receiver.id, JSON.stringify(receiver)));
  const started = f.app.execute(f.auth.actor, start(f, { bots: [{ id: "jit", revision: 1 }, { id: "receiver", revision: 1 }], tools: ["public_read", "effect_send"] }));
  const parent = f.app.authority.admit(started.work!.id, rid(), admission({ tools: ["public_read"] }));
  f.app.authority.commit(parent.id, { state: "waiting", text: "Delegating bounded work" });
  expect(() => f.app.authority.delegate(parent.id, rid(), admission({ botId: "unselected" }))).toThrow("bot_outside_grant");
  expect(() => f.app.authority.delegate(parent.id, rid(), admission({ botId: "receiver", tools: ["effect_send"] }))).toThrow("tool_outside_grant");
  expect(() => f.app.authority.delegate(parent.id, rid(), admission({ botId: "receiver", scopes: [{ kind: "resource", id: "other", revision: 1 }] }))).toThrow("scope_outside_grant");
  const key = rid(), spec = admission({ botId: "receiver", tools: ["public_read"] });
  const childAttempt = f.app.authority.delegate(parent.id, key, spec); expect(f.app.authority.delegate(parent.id, key, spec)).toEqual(childAttempt);
  expect(() => f.app.authority.delegate(parent.id, key, { ...spec, input: "changed" })).toThrow("request_id_conflict");
  expect(childAttempt.snapshot.bot.id).toBe("receiver"); expect(childAttempt.snapshot.grant.id).toBe(started.grant!.id);
  expect(() => f.app.authority.reserveTool(childAttempt.id, "shell")).toThrow("tool_outside_grant");
  expect(() => f.app.authority.reserveTool(childAttempt.id, "public_read", { kind: "resource", id: "other", revision: 1 })).toThrow("scope_outside_grant");
  expect(() => f.store.transaction(tx => tx.run("UPDATE work_grants SET record_json='{}'"))).toThrow("immutable_grant");
  expect(() => f.store.transaction(tx => tx.run("UPDATE work_attempts SET record_json=json_set(record_json,'$.snapshot.calls',999) WHERE id=?", childAttempt.id))).toThrow("immutable_attempt");
});

test("scope IDs cannot grant another Bot's private resource, transitive share or raw path", async () => {
  const f = await fixture(), ref = scope(f, "resource", { ownerBotId: "otherBot" });
  expect(() => f.app.execute(f.auth.actor, start(f, { scopes: [ref] }))).toThrow("scope_not_allowed");
  const shared = scope(f, "share", { receiverBotId: "otherBot" });
  expect(() => f.app.execute(f.auth.actor, start(f, { scopes: [shared] }))).toThrow("scope_not_allowed");
  expect(() => f.app.execute(f.auth.actor, start(f, { scopes: [{ kind: "resource", id: "/home/private", revision: 1 }] }))).toThrow("invalid_identity");
  expect(() => f.app.execute(f.auth.actor, start(f, { scopes: [{ kind: "resource", id: "missing", revision: 1 }] }))).toThrow("scope_revoked_or_stale");
  expect(() => f.app.execute(f.auth.actor, start(f, { tools: ["shell"] }))).toThrow("tool_not_allowed");
  expect(() => f.app.execute(f.auth.actor, start(f, { bots: [{ id: "jit", revision: 2 }] }))).toThrow("bot_authority_changed");
});

test("finite call/step/attempt/output/expiry budgets reserve durably and never refund uncertainty", async () => {
  const f = await fixture(), started = f.app.execute(f.auth.actor, start(f, { tools: ["public_read"], limits: { attempts: 1, steps: 1, calls: 2, outputBytes: 100, wallMs: 60000, concurrency: 2, reads: 40 } }));
  const attempt = f.app.authority.admit(started.work!.id, rid(), admission({ tools: ["public_read"], calls: 2, outputBytes: 100 }));
  f.app.authority.reserveTool(attempt.id, "public_read"); expect(() => f.app.authority.reserveTool(attempt.id, "public_read")).toThrow("budget_exhausted");
  expect(() => f.app.authority.commit(attempt.id, { state: "ready", text: "x".repeat(101) })).toThrow("invalid_text");
  f.app.authority.settle(attempt.id); const view = f.app.authority.view(f.auth.actor, started.work!.id);
  expect(view.reservations).toEqual({ attempts: 1, steps: 1, calls: 2, outputBytes: 100, reads: 0 }); expect(view.actualUsage).toBeNull();
  for (const key of ["attempts", "steps", "calls", "outputBytes", "wallMs"] as const) expect(() => f.app.execute(f.auth.actor, start(f, { limits: { ...start(f).payload.limits, [key]: Infinity } }))).toThrow();
  const other = await fixture(), one = other.app.execute(other.auth.actor, start(other, { limits: { attempts: 1, steps: 1, calls: 8, outputBytes: 8192, wallMs: 60000, concurrency: 2, reads: 40 } }));
  const parent = other.app.authority.admit(one.work!.id, rid(), admission()); other.app.authority.commit(parent.id, { state: "waiting", text: "Wait" });
  expect(() => other.app.authority.delegate(parent.id, rid(), admission())).toThrow("budget_exhausted");
});

test("stop cancels only named work, fences late output and retains stopping until actual transport settles", async () => {
  let release!: () => void, signal!: AbortSignal; const gate = new Promise<void>(r => { release = r; });
  const f = await fixture({ executor: { async run(_a, s) { signal = s; await gate; return { state: "ready", text: "Late output" }; } } });
  const first = f.app.execute(f.auth.actor, start(f)), unrelated = f.app.execute(f.auth.actor, start(f));
  const draining = f.app.authority.drain(); expect(f.app.authority.view(f.auth.actor, first.work!.id).work.state).toBe("running");
  const stoppedWork = stop(f, f.app.authority.view(f.auth.actor, first.work!.id).work).work!;
  expect(stoppedWork.state).toBe("stopping"); expect(signal.aborted).toBe(true);
  expect(f.app.authority.view(f.auth.actor, unrelated.work!.id).authority?.revoked).toBe(false);
  expect(f.app.authority.view(f.auth.actor, unrelated.work!.id).work.state).toBe("queued");
  release(); await draining;
  const view = f.app.authority.view(f.auth.actor, first.work!.id); expect(view.work.state).toBe("stopped"); expect(view.work.result).toBeNull();
  expect(f.app.authority.view(f.auth.actor, unrelated.work!.id).work.state).toBe("ready");
});

test("exact approval is single-use, immutable-content bound and holds unsupported adapters without a send", async () => {
  let sends = 0;
  const f = await effectFixture({ effects: { send: async (a, allowed) => { allowed(); expect(a).toEqual(send); sends++; return "succeeded"; } } });
  expect(sends).toBe(0); const approved = decide(f, f.effect).effect!;
  expect(approved.state).toBe("approved"); const done = await f.app.authority.runEffect(approved.id, approved.revision, approved.actionHash);
  expect(done.state).toBe("succeeded"); expect(sends).toBe(1);
  await expect(f.app.authority.runEffect(approved.id, approved.revision, approved.actionHash)).rejects.toThrow("stale_approval");
  expect(() => f.app.authority.proposeEffect(f.attempt.id, rid(), { ...send, kind: "shell" } as unknown as EffectAction, epoch + 30000)).toThrow("unsupported_effect");
  const held = f.app.authority.proposeEffect(f.attempt.id, rid(), { kind: "push", destination: "https://git.invalid/repo", content: "Exact SHA and ref" }, epoch + 30000); decide(f, held);
  await expect(f.app.authority.runEffect(held.id, held.revision, held.actionHash)).rejects.toThrow("effect_adapter_unavailable"); expect(sends).toBe(1);
  expect(() => f.app.authority.proposeEffect(f.attempt.id, rid(), { ...send, content: "sk-proj-" + "x".repeat(32) }, epoch + 30000)).toThrow("credential_content_refused");
});

test.each(["destination", "content", "kind", "hash", "expiry", "denied"] as const)("approval %s mutation/race cannot execute the old action", async mutation => {
  let sends = 0; const f = await effectFixture({ effects: { send: async (_a, allowed) => { allowed(); sends++; return "succeeded"; } } });
  if (mutation === "denied") decide(f, f.effect, "deny");
  else if (mutation === "expiry") { decide(f, f.effect); f.clock.now += 30000; }
  else if (mutation === "hash") {
    expect(() => f.app.execute(f.auth.actor, { kind: "approval.decide", requestId: rid(), expectedRevision: 1, payload: { effectId: f.effect.id, actionHash: "b".repeat(64), decision: "approve" } })).toThrow("stale_approval");
  } else {
    decide(f, f.effect);
    const proposed = { ...send, [mutation]: mutation === "kind" ? "push" : "changed" } as EffectAction;
    const revised = f.app.authority.reviseEffect(f.attempt.id, f.effect.id, 1, proposed, epoch + 30000);
    expect(revised.state).toBe("pending"); expect(revised.revision).toBe(2); expect(() => decide(f, f.effect)).toThrow("stale_approval");
  }
  await expect(f.app.authority.runEffect(f.effect.id, f.effect.revision, f.effect.actionHash)).rejects.toThrow(); expect(sends).toBe(0);
});

test("approval expiry during a paused performer and stop before send fence the actual effect", async () => {
  for (const mode of ["expiry", "stop"] as const) {
    let resume!: () => void, sends = 0; const gate = new Promise<void>(r => { resume = r; });
    const f = await effectFixture({ effects: { send: async (_a, allowed) => { await gate; allowed(); sends++; return "succeeded"; } } });
    decide(f, f.effect); const running = f.app.authority.runEffect(f.effect.id, 1, f.effect.actionHash);
    if (mode === "expiry") f.clock.now += 30000; else stop(f, f.app.authority.view(f.auth.actor, f.receipt.work!.id).work);
    resume(); expect((await running).state).toBe("unknown"); expect(sends).toBe(0);
    await expect(f.app.authority.runEffect(f.effect.id, 1, f.effect.actionHash)).rejects.toThrow("stale_approval");
  }
});

test("process death after effect claim becomes unknown/reconcile-only on restart; reservations remain spent", async () => {
  const f = await effectFixture(); decide(f, f.effect);
  expect(await child(f, { mode: "effect-crash", effectId: f.effect.id, revision: 1, actionHash: f.effect.actionHash })).toBe("claimed_no_send");
  expect(f.app.authority.view(f.auth.actor, f.receipt.work!.id).effects[0]!.state).toBe("executing");
  const restarted = new S14Application(f.store, f.options); restarted.authority.recover(); const actor = restarted.authenticate(f.token).actor;
  const view = restarted.authority.view(actor, f.receipt.work!.id); expect(view.effects[0]).toMatchObject({ state: "unknown", reason: "interrupted_reconcile_only_no_retry" });
  expect(view.attempts[0]!.state).toBe("interrupted"); expect(view.reservations!.calls).toBe(2);
  await expect(restarted.authority.runEffect(f.effect.id, 1, f.effect.actionHash)).rejects.toThrow("stale_approval");
  expect(() => restarted.authority.commit(f.attempt.id, { state: "ready", text: "Late" })).toThrow("attempt_fenced");
});

test("HTTP and no-script authority commands share exact receipts, query states and negative auth barriers", async () => {
  const f = await fixture(), web = createS14Handler(f.app, "http://localhost:3001");
  const request = (path: string, value?: unknown, form = false) => new Request(`http://localhost:3001${path}`, { method: value ? "POST" : "GET", headers: { cookie: `jit_s14=${f.token}`, ...(value ? { origin: "http://localhost:3001", "x-csrf-token": f.auth.csrf, "content-type": form ? "application/x-www-form-urlencoded" : "application/json" } : {}) }, ...(value ? { body: form ? new URLSearchParams({ csrf: f.auth.csrf, command: JSON.stringify(value) }).toString() : JSON.stringify(value) } : {}) });
  const cmd = start(f), response = await web(request("/s14/commands", cmd, true)); expect(response.status).toBe(303);
  const receipt = await (await web(request(response.headers.get("location")!))).json();
  expect(await (await web(request("/api/s14/commands", cmd))).json()).toEqual(receipt);
  expect((await (await web(request(`/api/s14/work/${receipt.work.id}`))).json()).work.state).toBe("queued");
  expect((await (await web(request("/api/s14/work"))).json()).items).toHaveLength(1);
  const stoppedWork = await (await web(request("/api/s14/commands", { kind: "work.stop", requestId: rid(), expectedRevision: 1, payload: { workId: receipt.work.id } }))).json(); expect(stoppedWork.work.state).toBe("stopped");
  expect((await web(new Request("http://localhost:3001/api/s14/work"))).status).toBe(401);
});

test("a changed performer argument fails its final exact-action guard and cannot send", async () => {
  let sends = 0;
  const f = await effectFixture({ effects: { send: async (a, allowed) => { a.destination = "https://changed.invalid/"; allowed(); sends++; return "succeeded"; } } });
  decide(f, f.effect); expect((await f.app.authority.runEffect(f.effect.id, 1, f.effect.actionHash)).state).toBe("unknown"); expect(sends).toBe(0);
});

test("no-script proposal/task/approval/stop forms and revision history use the same authenticated boundary", async () => {
  const f = await effectFixture(), web = createS14Handler(f.app, "http://localhost:3001");
  const request = (path: string, command?: unknown) => new Request(`http://localhost:3001${path}`, { method: command ? "POST" : "GET", headers: { cookie: `jit_s14=${f.token}`, ...(command ? { origin: "http://localhost:3001", "content-type": "application/x-www-form-urlencoded" } : {}) }, ...(command ? { body: new URLSearchParams({ csrf: f.auth.csrf, command: JSON.stringify(command) }).toString() } : {}) });
  const command = { kind: "approval.decide", requestId: rid(), expectedRevision: 1, payload: { effectId: f.effect.id, actionHash: f.effect.actionHash, decision: "approve" } };
  expect((await web(request("/s14/commands", command))).status).toBe(303);
  const changed = f.app.authority.reviseEffect(f.attempt.id, f.effect.id, 1, { ...send, content: "A new exact revision" }, epoch + 30000);
  const history = await (await web(request(`/api/s14/effects/${changed.id}`))).json(); expect(history.history.map((e: Effect) => e.state)).toEqual(["changed", "pending"]);
  expect(history.effect.actionHash).toBe(changed.actionHash);
  expect((await web(request("/s14/commands", { ...command, requestId: rid() }))).status).toBe(409);
  expect((await web(request("/s14/commands", { ...command, requestId: rid(), expectedRevision: 2, payload: { ...command.payload, actionHash: changed.actionHash, decision: "deny" } }))).status).toBe(303);
  const current = f.app.authority.view(f.auth.actor, f.receipt.work!.id).work;
  expect((await web(request("/s14/commands", { kind: "work.stop", requestId: rid(), expectedRevision: current.revision, payload: { workId: current.id } }))).status).toBe(303);
});

test("a rolled-back stop never aborts the actual handler or revokes another grant", async () => {
  let finish!: () => void, signal!: AbortSignal; const gate = new Promise<void>(r => { finish = r; }); let fail = false;
  const f = await fixture({ executor: { async run(_a, s) { signal = s; await gate; return { state: "ready", text: "Retained result" }; } } });
  const app = new S14Application(f.store, { ...f.options, beforeCommit: () => { if (fail) throw Error("rollback_stop"); } }), actor = app.authenticate(f.token).actor;
  const started = app.execute(actor, start(f)), running = app.authority.drain(); fail = true;
  expect(() => app.execute(actor, { kind: "work.stop", requestId: rid(), expectedRevision: app.authority.view(actor, started.work!.id).work.revision, payload: { workId: started.work!.id } })).toThrow("rollback_stop");
  expect(signal.aborted).toBe(false); expect(app.authority.view(actor, started.work!.id).authority?.revoked).toBe(false);
  finish(); await running; expect(app.authority.view(actor, started.work!.id).work.state).toBe("ready");
});

test("no-script task.accept stores an obligation without starting work", async () => {
  const f = await fixture(); f.app.execute(f.auth.actor, { kind: "message.post", requestId: rid(), expectedRevision: 1, payload: { conversationId: f.conversationId, text: "Suggest research" } }); await f.app.drainReplies();
  const task = f.app.authority.list(f.auth.actor)[0]!, web = createS14Handler(f.app, "http://localhost:3001");
  const command = { kind: "task.accept", requestId: rid(), expectedRevision: 1, payload: { taskId: task.id } };
  const request = () => new Request("http://localhost:3001/s14/commands", { method: "POST", headers: { cookie: `jit_s14=${f.token}`, origin: "http://localhost:3001", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf: f.auth.csrf, command: JSON.stringify(command) }).toString() });
  expect((await web(request())).status).toBe(303); expect((await web(request())).status).toBe(303);
  expect(f.app.authority.view(f.auth.actor, task.id)).toMatchObject({ work: { state: "accepted", grantId: null }, grant: null, attempts: [] });
});
