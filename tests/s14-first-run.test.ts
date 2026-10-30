import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { HostAuthFetch, HostClock, HostCredentialStore } from "schway/host";
import { issueOwnerSetupLink, ownerSetupCsrf } from "../src/ops/owner-setup";
import { S14Application, record, save } from "../src/s14/application";
import { S14Store } from "../src/s14/store";
import { supportedS14Routes, type S14SignInCommand } from "../src/s14/sign-in";
import { S14SignIns } from "../src/s14/sign-in";
import { existingResourceCeilings, scopeOptions } from "../src/s14/scope-options";
import type { Bot } from "../src/s14/types";
import { createS14Product } from "../src/s14/web-product";
import { createS14Handler } from "../src/s14/web";
import type { BotCommand, ChatInput } from "../src/s14/types";
import type { Attempt, AuthorityCommand, Work } from "../src/s14/authority-types";
import type { MemoryCommand } from "../src/s14/memory-types";
import { FakeComputerRuntime } from "./fixtures/s14-computer";
import type { ComputerCommand } from "../src/s14/computer-types";

const origin = "http://localhost:3001";
const password = "fixture-owner-password-265";
const code = "ONCE-265";
const providerSecret = "fixture-provider-token-265";
const roots: string[] = [];
const apps: S14Application[] = [];
const rid = () => crypto.randomUUID().replaceAll("-", "");
afterEach(async () => {
  for (const app of apps.splice(0)) { await app.signIns.close(); app.store.close(); }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function flush() { for (let i = 0; i < 100; i++) await Promise.resolve(); }
class Clock implements HostClock {
  time = 1_900_000_000_000;
  waits = new Set<{ at: number; resolve(): void }>();
  now = () => this.time;
  sleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
    const finish = (aborted: boolean) => {
      this.waits.delete(wait);
      signal?.removeEventListener("abort", abort);
      aborted ? reject(Error("aborted")) : resolve();
    };
    const wait = { at: this.time + ms, resolve: () => finish(false) };
    const abort = () => finish(true);
    if (signal?.aborted) { reject(Error("aborted")); return; }
    this.waits.add(wait);
    signal?.addEventListener("abort", abort, { once: true });
  });
  async advance(ms: number) {
    this.time += ms;
    for (const wait of [...this.waits]) if (wait.at <= this.time) wait.resolve();
    await flush();
  }
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "jit-s14-first-run-")); roots.push(root);
  const store = new S14Store(join(root, "application.sqlite"));
  const clock = new Clock();
  const credentials = new Map<string, string>();
  const nativeStore: HostCredentialStore = {
    get: async identity => credentials.get(identity.account) ?? null,
    set: async (identity, value) => { credentials.set(identity.account, value); },
    delete: async identity => credentials.delete(identity.account),
  };
  let starts = 0, success = false;
  const fetch: HostAuthFetch = async input => {
    const url = String(input);
    if (/usercode|device\/code|device_authorization|device\/authorization/.test(url)) {
      starts++;
      return Response.json({ user_code: code, device_auth_id: "device-private", verification_uri: "https://auth.example.test/device", interval: 1, expires_in: 60 });
    }
    if (url.endsWith("/oauth/token")) return Response.json({ access_token: providerSecret, refresh_token: "refresh-private-265", expires_in: 3600 });
    if (success) return Response.json({ authorization_code: "auth-private-265", code_verifier: "verifier-private-265" });
    return Response.json({ error: "authorization_pending" }, { status: 400 });
  };
  const inputs: ChatInput[] = [], attempts: Attempt[] = [];
  const runtime = new FakeComputerRuntime();
  const app = new S14Application(store, {
    policy: { routes: supportedS14Routes(), tools: ["web_search", "computer"], resources: [] }, now: clock.now,
    signIn: { clock, store: nativeStore, fetch }, computers: { runtime },
    chat: { async reply(input) { inputs.push(input); return { text: "สวัสดี / Hello", task: { title: "Suggested", purpose: "Read facts", completionRule: "Evidence" } }; } },
    authority: { executor: { async run(attempt) { attempts.push(attempt); return { state: "ready", text: "Evidence retained" }; } } },
  });
  apps.push(app);
  const web = createS14Handler(app, origin);
  const request = (path: string, fields?: Record<string, string>, cookie = "", headers: Record<string, string> = {}) => web(new Request(origin + path, {
    ...(fields ? { method: "POST", body: new URLSearchParams(fields) } : {}),
    headers: { cookie, ...(fields ? { origin, "content-type": "application/x-www-form-urlencoded" } : {}), ...headers },
  }));
  const link = () => issueOwnerSetupLink(store, origin, clock.now())!;
  return { root, store, clock, app, runtime, inputs, attempts, web, request, link, credentials, starts: () => starts, succeed: () => { success = true; } };
}
async function configured() {
  const f = await fixture();
  await f.app.provisionOwner(password);
  const token = await f.app.login(password), auth = f.app.authenticate(token);
  const setup = f.app.execute(auth.actor, { kind: "setup", requestId: rid(), expectedRevision: 0,
    payload: { ownerName: "Owner", language: "th", routeId: "codex", capabilities: { tools: ["web_search", "computer"], resources: [] } } });
  return { ...f, auth, token, conversationId: setup.conversation!.id };
}
function start(f: Awaited<ReturnType<typeof configured>>, tools: string[] = []) {
  const command: AuthorityCommand = { kind: "work.start", requestId: rid(), expectedRevision: f.app.conversation(f.auth.actor, f.conversationId).conversation.revision,
    payload: { conversationId: f.conversationId, task: null, title: "Named work", purpose: "Compare facts", completionRule: "Evidence for review",
      bots: [{ id: "jit", revision: 1 }], tools, scopes: [], limits: { attempts: 4, steps: 4, calls: 20, outputBytes: 32768, wallMs: 900000 }, expiresAt: f.clock.now() + 900000 } };
  return f.app.execute(f.auth.actor, command).work!;
}
function replayAndStale(f: Awaited<ReturnType<typeof configured>>, command: BotCommand | AuthorityCommand | MemoryCommand | ComputerCommand) {
  const result = f.app.execute(f.auth.actor, command);
  expect(f.app.execute(f.auth.actor, command)).toEqual(result);
  expect(() => f.app.execute(f.auth.actor, { ...command, requestId: rid(), expectedRevision: 0 })).toThrow();
  expect(() => f.app.execute(f.auth.actor, { ...command, expectedRevision: command.expectedRevision + 1 })).toThrow("request_id_conflict");
  return result;
}

test("fresh capability -> password -> fake native sign-in -> provider-only setup -> first reply, with no route environment or shell step", async () => {
  const f = await fixture();
  const url = new URL(f.link()), capability = url.searchParams.get("token")!;
  const initial = await f.request(url.pathname + url.search);
  expect(initial.status).toBe(303);
  expect(initial.headers.get("referrer-policy")).toBe("no-referrer");
  expect(initial.headers.get("location")).toBe("/owner/setup");
  const setupCookie = initial.headers.get("set-cookie")!.split(";")[0]!;
  const clean = await f.request("/owner/setup", undefined, setupCookie);
  expect(clean.headers.get("referrer-policy")).toBe("same-origin");
  expect(await clean.text()).not.toContain(capability);
  const created = await f.request("/owner/setup", { csrf: ownerSetupCsrf(capability), password, confirm: password }, setupCookie);
  expect(created.status).toBe(303);
  const cookie = created.headers.getSetCookie().find(v => v.startsWith("jit_s14="))!.split(";")[0]!;
  const token = cookie.slice("jit_s14=".length), auth = f.app.authenticate(token);
  const providers = await (await f.request("/api/s14/providers", undefined, cookie)).json();
  expect(providers.providers.find((r: { provider: string }) => r.provider === "codex")).toMatchObject({ id: "codex", model: "gpt-6.1-sol", readiness: "needs-login" });
  const command: S14SignInCommand = { kind: "setup.sign_in", requestId: rid(), expectedRevision: 0, payload: { provider: "codex", flowId: null } };
  const form = { csrf: auth.csrf, command: JSON.stringify(command) };
  const once = await (await f.request("/s14/commands", form, cookie)).json();
  expect(once.approval.userCode).toBe(code);
  const replay = await (await f.request("/s14/commands", form, cookie)).json();
  expect(replay.approval).toBeUndefined(); expect(f.starts()).toBe(1);
  const stale = await f.app.signIns.execute(auth.actor, { ...command, requestId: rid() }).catch(e => e.code);
  expect(stale).toBe("stale_revision");
  f.succeed(); await f.clock.advance(1000); await flush();
  expect(f.app.signIns.status(auth.actor, "codex", command.requestId).state).toBe("ready");
  expect(f.credentials.size).toBeGreaterThan(0);
  expect((await f.app.signIns.providers(auth.actor)).find(r => r.provider === "codex")!.readiness).toBe("configured-unverified");
  const setup = f.app.execute(auth.actor, { kind: "setup", requestId: rid(), expectedRevision: f.app.home(auth.actor).revision,
    payload: { ownerName: "Owner", language: "th", routeId: "codex", capabilities: { tools: [], resources: [] } } });
  f.app.execute(auth.actor, { kind: "message.post", requestId: rid(), expectedRevision: 1, payload: { conversationId: setup.conversation!.id, text: "Hello" } });
  await f.app.drainReplies();
  expect(f.inputs).toHaveLength(1);
  expect(f.inputs[0]!.route).toEqual({ id: "codex", provider: "codex", model: "gpt-6.1-sol" });
  expect(f.app.conversation(auth.actor, setup.conversation!.id).messages.at(-1)!.role).toBe("bot");
  const retained = JSON.stringify(f.store.read(tx => tx.all("SELECT * FROM command_receipts")));
  for (const secret of [capability, password, code, providerSecret, "https://auth.example.test/device"]) expect(retained).not.toContain(secret);
  expect(issueOwnerSetupLink(f.store, origin, f.clock.now())).toBeNull();
  expect(() => f.app.checkOwnerSetup(capability)).toThrow("owner_setup_link_invalid");
});

test("bootstrap preserves legacy expiry, rotation, modes, exact Origin/CSRF, password policy and single-use races", async () => {
  const f = await fixture();
  let capability = new URL(f.link()).searchParams.get("token")!;
  const old = capability; capability = new URL(f.link()).searchParams.get("token")!;
  expect(() => f.app.checkOwnerSetup(old)).toThrow("owner_setup_link_invalid");
  const cookie = `jit_setup=${capability}`, fields = { csrf: ownerSetupCsrf(capability), password, confirm: password };
  expect((await f.request("/owner/setup", fields, cookie, { origin: "null" })).status).toBe(403);
  expect((await f.request("/owner/setup", { ...fields, csrf: "0".repeat(64) }, cookie)).status).toBe(403);
  expect((await f.request("/owner/setup", { ...fields, password: "short", confirm: "short" }, cookie)).status).toBe(400);
  chmodSync(`${f.store.path}.owner-setup.json`, 0o644);
  expect(() => f.app.checkOwnerSetup(capability)).toThrow("owner_setup_link_invalid");
  chmodSync(`${f.store.path}.owner-setup.json`, 0o600);
  await f.clock.advance(900000);
  expect(() => f.app.checkOwnerSetup(capability)).toThrow("owner_setup_link_invalid");
  capability = new URL(f.link()).searchParams.get("token")!;
  expect(readFileSync(`${f.store.path}.owner-setup.json`, "utf8")).not.toContain(capability);
  const results = await Promise.allSettled([f.app.completeOwnerSetup(capability, password), f.app.completeOwnerSetup(capability, password)]);
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect(f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM owner")!.n)).toBe(1);
});

test("sign-in cancel has replay, stale, logout and restart fences; codes never reappear", async () => {
  const f = await configured();
  const command: S14SignInCommand = { kind: "setup.sign_in", requestId: rid(), expectedRevision: f.app.home(f.auth.actor).revision, payload: { provider: "codex", flowId: null } };
  await f.app.signIns.execute(f.auth.actor, command);
  const cancel: S14SignInCommand = { kind: "setup.sign_in.cancel", requestId: rid(), expectedRevision: f.app.home(f.auth.actor).revision, payload: { provider: "codex", flowId: command.requestId } };
  const result = await f.app.signIns.execute(f.auth.actor, cancel);
  expect((await f.app.signIns.execute(f.auth.actor, cancel)).signIn).toEqual(result.signIn);
  expect(await f.app.signIns.execute(f.auth.actor, { ...cancel, requestId: rid(), expectedRevision: 0 }).catch(e => e.code)).toBe("stale_revision");
  const other = { ...command, requestId: rid(), expectedRevision: f.app.home(f.auth.actor).revision };
  await flush(); await f.app.signIns.execute(f.auth.actor, other);
  expect(new S14SignIns(f.app).status(f.auth.actor, "codex", other.requestId).state).toBe("cancelled");
  f.app.logout(f.auth.actor); f.succeed(); await f.clock.advance(1000); await flush();
  expect(f.credentials.size).toBe(0);
  expect(await f.app.signIns.execute(f.auth.actor, command).catch(e => e.code)).toBe("authentication_required");
});

test("task rejection, conversation creation, preferences and decision unpin replay once and reject stale envelopes", async () => {
  const f = await configured();
  const conversation = replayAndStale(f, { kind: "conversation.create", requestId: rid(), expectedRevision: 1, payload: { botId: "jit" } });
  expect("conversation" in conversation).toBe(true);
  replayAndStale(f, { kind: "owner.preferences.set", requestId: rid(), expectedRevision: f.app.home(f.auth.actor).revision, payload: { language: "en", theme: "dark" } });
  expect(f.app.home(f.auth.actor).owner).toMatchObject({ language: "en", theme: "dark" });
  f.app.execute(f.auth.actor, { kind: "message.post", requestId: rid(), expectedRevision: 1, payload: { conversationId: f.conversationId, text: "Suggest a task" } });
  await f.app.drainReplies();
  const task = f.app.authority.list(f.auth.actor)[0]!;
  const rejected = replayAndStale(f, { kind: "task.reject", requestId: rid(), expectedRevision: task.revision, payload: { taskId: task.id } });
  expect("work" in rejected && rejected.work?.state).toBe("rejected");
  expect(f.store.read(tx => tx.get("SELECT id FROM work_grants"))).toBeNull();
  expect(f.store.read(tx => tx.get("SELECT work_id FROM work_queue"))).toBeNull();
  const set = f.app.execute(f.auth.actor, { kind: "memory.decision.set", requestId: rid(), expectedRevision: 0, payload: { conversationId: f.conversationId, key: "decision", text: "Choose A" } });
  replayAndStale(f, { kind: "memory.decision.unpin", requestId: rid(), expectedRevision: 1, payload: { decision: set.decision! } });
  expect(f.app.memory.inspect(f.auth.actor, "jit").decisions).toHaveLength(0);
  expect(() => f.app.execute(f.auth.actor, { kind: "memory.decision.set", requestId: rid(), expectedRevision: 0, payload: { conversationId: f.conversationId, key: "decision", text: "stale" } })).toThrow("stale_revision");
});

test("computer eligibility, one-action lease renewal/restart, bounded observed activity and secret-free page metadata", async () => {
  const f = await configured(), work = start(f, ["computer"]);
  expect(f.app.computers.eligibleWork(f.auth.actor, "jit")).toEqual([{ id: work.id, title: work.title, revision: work.revision, expiresAt: f.clock.now() + 900000 }]);
  f.app.execute(f.auth.actor, { kind: "computer.open", requestId: rid(), expectedRevision: 0, payload: { botId: "jit", workId: work.id } });
  await f.app.computers.drain();
  let view = f.app.computers.view(f.auth.actor, "jit");
  const lease = (kind: "takeover.start" | "takeover.renew"): ComputerCommand => ({ kind, requestId: rid(), expectedRevision: view.computer!.revision,
    payload: { botId: "jit", computerId: view.computer!.id, generation: view.computer!.generation, leaseRevision: view.lease!.revision } });
  f.app.execute(f.auth.actor, lease("takeover.start"));
  await f.clock.advance(290000);
  view = f.app.computers.view(f.auth.actor, "jit");
  const renew = lease("takeover.renew");
  replayAndStale(f, renew);
  expect(f.app.computers.view(f.auth.actor, "jit").lease!.expiresAt).toBe(f.clock.now() + 300000);
  await f.clock.advance(300000); // Expired lease, before sweep; renew restarts it in one exact command.
  view = f.app.computers.view(f.auth.actor, "jit");
  f.app.execute(f.auth.actor, lease("takeover.renew"));
  Object.assign(f.runtime, { pageInfo: async () => ({ url: "https://private.test/typed-secret?token=secret", title: "typed-secret" }) });
  await f.app.computers.screenshot(f.auth.actor, "jit");
  expect(f.app.computers.view(f.auth.actor, "jit").page).toBeNull();
  Object.assign(f.runtime, { pageInfo: async () => ({ url: "about:blank", title: "typed-secret" }) });
  await f.app.computers.screenshot(f.auth.actor, "jit");
  expect(f.app.computers.view(f.auth.actor, "jit").page).toEqual({ url: "about:blank", title: null, untrusted: true });
  const attempt = f.app.authority.admit(work.id, rid(), { botId: "jit", tools: ["computer"], scopes: [], input: "Read", calls: 5, outputBytes: 1024 });
  view = f.app.computers.view(f.auth.actor, "jit");
  f.app.execute(f.auth.actor, { kind: "takeover.end", requestId: rid(), expectedRevision: view.computer!.revision,
    payload: { botId: "jit", computerId: view.computer!.id, generation: view.computer!.generation, leaseRevision: view.lease!.revision } });
  const session = f.app.computers.open(attempt.id);
  await f.app.computers.agentInput(attempt.id, session.lease, { kind: "scroll", deltaY: 80 });
  session.release();
  const activity = f.app.computers.activity(f.auth.actor, "jit");
  expect(activity.map(a => a.kind)).toEqual(expect.arrayContaining(["page.opened", "screenshot", "agent.scroll"]));
  expect(JSON.stringify(activity)).not.toContain("typed-secret");
  await f.clock.advance(300000); f.app.computers.sweep();
  expect(f.app.computers.activity(f.auth.actor, "jit")[0]!.kind).toBe("system.stop");
  f.app.execute(f.auth.actor, { kind: "work.stop", requestId: rid(), expectedRevision: f.app.authority.view(f.auth.actor, work.id).work.revision, payload: { workId: work.id } });
  expect(f.app.computers.eligibleWork(f.auth.actor, "jit")).toHaveLength(0);
});

test.each(["work.retry", "work.summarize"] as const)("%s uses one original grant, spent budget, source lineage and replay/stale fences", async kind => {
  const f = await configured(), work = start(f, ["web_search"]);
  const first = f.app.authority.admit(work.id, rid(), { botId: "jit", tools: ["web_search"], scopes: [], input: "Research", calls: 5, outputBytes: 8192 });
  f.store.transaction(tx => {
    const source = f.app.memory.source(tx, { id: rid(), botId: "jit", conversationId: f.conversationId, attribution: "external", text: "Collected public evidence", derived: [] });
    tx.run("INSERT INTO external_evidence VALUES (?,?,?)", source.id, first.id, JSON.stringify({ ...source, workId: work.id, attemptId: first.id }));
  });
  f.app.authority.settle(first.id, "quota");
  const blocked = f.app.authority.view(f.auth.actor, work.id).work;
  replayAndStale(f, { kind, requestId: rid(), expectedRevision: blocked.revision, payload: { workId: work.id } });
  await f.app.authority.drain(); await f.app.authority.drain();
  expect(f.attempts).toHaveLength(1);
  expect(f.attempts[0]!.snapshot.grant.id).toBe(work.grantId!);
  expect(f.app.authority.view(f.auth.actor, work.id).reservations!.attempts).toBe(2);
  expect(f.attempts[0]!.snapshot.tools).toEqual(kind === "work.summarize" ? [] : ["web_search"]);
  if (kind === "work.summarize") {
    expect(f.attempts[0]!.snapshot.input).toContain("Collected public evidence");
    expect(f.store.read(tx => f.app.memory.attemptPacket(tx, f.attempts[0]!.id)).sources).toHaveLength(1);
  }
});

test("recovery refuses missing evidence, exhausted/revoked/expired grant and uncertain transport without creating authority", async () => {
  const f = await configured(), work = start(f);
  const first = f.app.authority.admit(work.id, rid(), { botId: "jit", tools: [], scopes: [], input: "Read", calls: 5, outputBytes: 8192 });
  f.app.authority.settle(first.id, "quota");
  const command = (kind: "work.retry" | "work.summarize"): AuthorityCommand => ({ kind, requestId: rid(), expectedRevision: f.app.authority.view(f.auth.actor, work.id).work.revision, payload: { workId: work.id } });
  expect(() => f.app.execute(f.auth.actor, command("work.summarize"))).toThrow("evidence_unavailable");
  f.store.transaction(tx => { const a = record<Attempt>(tx, "work_attempts", first.id); a.state = "interrupted"; save(tx, "work_attempts", a); });
  expect(() => f.app.execute(f.auth.actor, command("work.retry"))).toThrow("reconciliation_required");
  f.store.transaction(tx => { const a = record<Attempt>(tx, "work_attempts", first.id); a.state = "settled"; save(tx, "work_attempts", a); tx.run("UPDATE grant_usage SET attempts=4"); });
  expect(() => f.app.execute(f.auth.actor, command("work.retry"))).toThrow("budget_exhausted");
  f.store.transaction(tx => tx.run("UPDATE grant_usage SET attempts=1"));
  await f.clock.advance(900000);
  expect(() => f.app.execute(f.auth.actor, command("work.retry"))).toThrow("grant_expired");
  expect(f.app.authority.list(f.auth.actor)[0]!.state).toBe("blocked");
});

test("legacy browser refusal is the default composition and preserves every database/sidecar byte", async () => {
  const { Database } = await import("bun:sqlite");
  const { readdirSync } = await import("node:fs");
  const root = mkdtempSync(join(tmpdir(), "jit-s14-refusal-default-")); roots.push(root);
  const path = join(root, "legacy.sqlite"), db = new Database(path);
  db.exec("CREATE TABLE projects(id TEXT); PRAGMA user_version=45; PRAGMA journal_mode=WAL; INSERT INTO projects VALUES ('legacy')");
  const snapshot = () => Object.fromEntries(readdirSync(root).map(name => [name, readFileSync(join(root, name)).toString("hex")]));
  const before = snapshot();
  const child = Bun.spawn([process.execPath, "tests/fixtures/s14-refusal.ts"], { env: { ...process.env, JIT_S14_DATABASE: path }, stdout: "pipe", stderr: "pipe" });
  const output = JSON.parse(await new Response(child.stdout).text());
  expect(output.status).toBe(409);
  expect(output.body).toContain("legacy.sqlite");
  expect(output.body).not.toContain(path);
  expect(await child.exited).toBe(1);
  expect(await new Response(child.stderr).text()).toContain("s14_fresh_state_required");
  expect(snapshot()).toEqual(before);
  db.close();
});

test("MemoryImpact resolves bounded Bot and work names beyond the old 64-context UI window", async () => {
  const f = await configured();
  const memory = f.app.execute(f.auth.actor, { kind: "memory.remember", requestId: rid(), expectedRevision: 1, payload: { conversationId: f.conversationId, text: "Retained fact" } });
  f.store.transaction(tx => {
    for (let i = 0; i < 110; i++) {
      const work: Work = { id: rid(), revision: 1, conversationId: f.conversationId, sourceMessageId: null, title: `Work ${i}`, purpose: "Read", completionRule: "Review",
        state: "accepted", reason: null, grantId: null, result: null, createdAt: f.clock.now() };
      tx.run("INSERT INTO work_items VALUES (?,?,?)", work.id, f.conversationId, JSON.stringify(work));
      const packet = f.app.memory.assemble(tx, { botId: "jit", conversationId: f.conversationId, purpose: "Retained fact", sources: [] });
      packet.workId = work.id;
      save(tx, "memory_contexts", packet);
    }
  });
  const impact = f.app.memory.preview(f.auth.actor, memory.claim!);
  expect(impact.contexts).toHaveLength(110);
  expect(impact.names.work).toHaveLength(100);
  expect(impact.names.omittedWork).toBe(10);
  expect(impact.names.work[90]!.title).toBe("Work 90");
  expect(impact.names.bots).toEqual([{ id: "jit", name: "Jit" }]);
});

test("summary refuses tool widening and queued evidence withdrawal before any inference", async () => {
  const f = await configured(), work = start(f, ["web_search"]);
  const first = f.app.authority.admit(work.id, rid(), { botId: "jit", tools: ["web_search"], scopes: [], input: "Research", calls: 5, outputBytes: 8192 });
  const source = f.store.transaction(tx => {
    const value = f.app.memory.source(tx, { id: rid(), botId: "jit", conversationId: f.conversationId, attribution: "external", text: "Existing evidence", derived: [] });
    tx.run("INSERT INTO external_evidence VALUES (?,?,?)", value.id, first.id, JSON.stringify({ ...value, workId: work.id, attemptId: first.id }));
    return value;
  });
  f.app.authority.settle(first.id, "quota");
  f.app.execute(f.auth.actor, { kind: "work.summarize", requestId: rid(), expectedRevision: f.app.authority.view(f.auth.actor, work.id).work.revision, payload: { workId: work.id } });
  expect(() => f.app.authority.admit(work.id, rid(), { botId: "jit", tools: ["web_search"], scopes: [], input: "Widen", calls: 5, outputBytes: 8192 })).toThrow("tool_outside_grant");
  f.store.transaction(tx => tx.run("INSERT INTO lifecycle.withdrawals VALUES ('source',?,'forgotten')", source.id));
  await f.app.authority.drain();
  expect(f.attempts).toHaveLength(0);
  expect(f.app.authority.view(f.auth.actor, work.id).work.reason).toBe("evidence_unavailable");
});

test("production scope source lists only existing owner-granted memory scopes and current receiver ceilings", async () => {
  const f = await configured();
  f.app.policy.resources = ["existing_scope"];
  f.store.transaction(tx => {
    const bot = record<Bot>(tx, "bots", "jit");
    bot.capabilities.resources = ["existing_scope"];
    save(tx, "bots", bot);
    const receiver = { ...bot, id: "receiver", name: "Research Bot" };
    tx.run("INSERT INTO bots VALUES (?,?)", receiver.id, JSON.stringify(receiver));
  });
  const memory = f.app.execute(f.auth.actor, { kind: "memory.remember", requestId: rid(), expectedRevision: 1, payload: { conversationId: f.conversationId, text: "Named claim" } });
  expect(scopeOptions(f.app, f.auth.actor, "receiver")).toHaveLength(0);
  expect(f.store.read(existingResourceCeilings)).toEqual(["existing_scope"]);
  f.app.execute(f.auth.actor, { kind: "memory.share", requestId: rid(), expectedRevision: 1, payload: { claim: memory.claim!, scopeId: "existing_scope", receiverBotId: "receiver", expiresAt: f.clock.now() + 60000 } });
  expect(scopeOptions(f.app, f.auth.actor, "receiver")).toMatchObject([{ label: "Jit", scope: { ref: { kind: "share", id: "existing_scope", revision: 1 }, receiverBotId: "receiver" } }]);
  expect(scopeOptions(f.app, f.auth.actor, "jit")).toHaveLength(0);
  expect(() => scopeOptions(f.app, { ownerId: "owner" }, "receiver")).toThrow("authentication_required");
  f.app.execute(f.auth.actor, { kind: "memory.revoke", requestId: rid(), expectedRevision: 1, payload: { claim: memory.claim! } });
  expect(scopeOptions(f.app, f.auth.actor, "receiver")).toHaveLength(0);
});

test("unknown effects and revoked grants cannot be retried or summarized", async () => {
  const f = await configured();
  f.app.policy.tools.push("effect_send");
  f.store.transaction(tx => {
    const bot = record<Bot>(tx, "bots", "jit");
    bot.capabilities.tools.push("effect_send");
    save(tx, "bots", bot);
  });
  const work = start(f, ["effect_send"]);
  const attempt = f.app.authority.admit(work.id, rid(), { botId: "jit", tools: ["effect_send"], scopes: [], input: "Review", calls: 5, outputBytes: 8192 });
  const effect = f.app.authority.proposeEffect(attempt.id, rid(), { kind: "send", destination: "fixture destination", content: "Fixture content" }, f.clock.now() + 60000);
  const unknown = { ...effect, state: "unknown" as const };
  f.store.transaction(tx => save(tx, "effects", unknown));
  f.app.authority.settle(attempt.id, "unknown");
  const command = (kind: "work.retry" | "work.summarize"): AuthorityCommand => ({ kind, requestId: rid(), expectedRevision: f.app.authority.view(f.auth.actor, work.id).work.revision, payload: { workId: work.id } });
  for (const kind of ["work.retry", "work.summarize"] as const) expect(() => f.app.execute(f.auth.actor, command(kind))).toThrow("reconciliation_required");
  f.store.transaction(tx => {
    const denied = { ...effect, state: "denied" as const };
    save(tx, "effects", denied);
    tx.run("UPDATE grant_state SET revoked=1 WHERE grant_id=?", work.grantId!);
  });
  expect(() => f.app.execute(f.auth.actor, command("work.retry"))).toThrow("grant_revoked");
  expect(f.attempts).toHaveLength(0);
});

test("no-script auth renderer gets approval once; refresh and product receipt redirects use safe current data", async () => {
  const f = await configured();
  const web = createS14Handler(f.app, origin, undefined, undefined, {
    signIn: receipt => JSON.stringify(receipt),
  });
  const command: S14SignInCommand = { kind: "setup.sign_in", requestId: rid(), expectedRevision: f.app.home(f.auth.actor).revision, payload: { provider: "codex", flowId: null } };
  const post = await web(new Request(origin + "/s14/commands", {
    method: "POST", headers: { origin, cookie: `jit_s14=${f.token}`, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf: f.auth.csrf, command: JSON.stringify(command) }),
  }));
  expect(post.headers.get("content-type")).toContain("text/html");
  expect(await post.text()).toContain(code);
  const refresh = await web(new Request(origin + `/s14/sign-in/codex/${command.requestId}`, { headers: { cookie: `jit_s14=${f.token}` } }));
  expect(await refresh.text()).not.toContain(code);
  const product = createS14Product(f.app);
  const receipt = f.app.execute(f.auth.actor, { kind: "conversation.create", requestId: rid(), expectedRevision: 1, payload: { botId: "jit" } });
  expect(product.surface(receipt)).toBe(`/chats/${receipt.conversation!.id}`);
  const preference = f.app.execute(f.auth.actor, { kind: "owner.preferences.set", requestId: rid(), expectedRevision: f.app.home(f.auth.actor).revision, payload: { language: "th", theme: "light" } });
  expect(product.surface(preference)).toBe("/more");
});
