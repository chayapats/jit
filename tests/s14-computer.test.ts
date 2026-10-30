import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { S14Application, type S14Options } from "../src/s14/application";
import { S14Store } from "../src/s14/store";
import { createS14Handler } from "../src/s14/web";
import type { Bot, OwnerActor, Policy } from "../src/s14/types";
import type { BotComputer, ComputerCommand, ComputerView, OwnerInput, OwnerInputCommand } from "../src/s14/computer-types";
import { barrier, FakeComputerRuntime, fixturePng } from "./fixtures/s14-computer";
import { runComputerWork } from "../src/s14/computer-work";

const rid = () => crypto.randomUUID().replaceAll("-", "");
const password = "s14-computer-fixture-owner-password";
const roots: string[] = [], stores = new Set<S14Store>();
const policy: Policy = { routes: [{ id: "selected", provider: "codex", model: "scripted" }], tools: ["computer", "effect_send"], resources: [] };
afterEach(() => { for (const store of stores) store.close(); stores.clear(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture(runtime: FakeComputerRuntime | null = new FakeComputerRuntime(), authority: S14Options["authority"] = {}) {
  const root = mkdtempSync(join(tmpdir(), "s14-computer-")); roots.push(root);
  const path = join(root, "s14.sqlite"), store = new S14Store(path); stores.add(store);
  const clock = { now: 1800000000000 };
  const options: S14Options = { policy, authority, now: () => clock.now, computers: runtime ? { runtime } : {}, chat: { async reply() { return { text: "No computer authority from text" }; } } };
  const app = new S14Application(store, options);
  await app.provisionOwner(password);
  const token = await app.login(password), auth = app.authenticate(token);
  const setup = app.execute(auth.actor, { kind: "setup", requestId: rid(), expectedRevision: 0,
    payload: { ownerName: "Owner", language: "th", routeId: "selected", capabilities: { tools: policy.tools, resources: [] } } });
  return { app, store, path, root, clock, options, token, auth, bot: setup.bot!, conversationId: setup.conversation!.id, runtime };
}
type F = Awaited<ReturnType<typeof fixture>>;
function start(f: F, botId = "jit", tools = ["computer", "effect_send"]) {
  return f.app.execute(f.auth.actor, { kind: "work.start", requestId: rid(), expectedRevision: f.app.conversation(f.auth.actor, f.conversationId).conversation.revision,
    payload: { conversationId: f.conversationId, task: null, title: "Report", purpose: "Local report", completionRule: "Owner review", bots: [{ id: botId, revision: 1 }], tools, scopes: [],
      limits: { attempts: 4, steps: 4, calls: 64, outputBytes: 8192, wallMs: 3600000 }, expiresAt: f.clock.now + 3600000 } });
}
async function running(f: F, botId = "jit") {
  const work = start(f, botId).work!;
  const command: ComputerCommand = { kind: "computer.open", requestId: rid(), expectedRevision: f.app.computers.view(f.auth.actor, botId).computer?.revision ?? 0, payload: { botId, workId: work.id } };
  const receipt = f.app.execute(f.auth.actor, command);
  await f.app.computers.drain();
  return { work, command, receipt, c: f.app.computers.view(f.auth.actor, botId).computer! };
}
function lifecycle(f: F, kind: "computer.stop" | "computer.reset" | "computer.delete", c: BotComputer) {
  return f.app.execute(f.auth.actor, { kind, requestId: rid(), expectedRevision: c.revision, payload: { botId: c.botId, computerId: c.id, generation: c.generation } });
}
function takeover(f: F, kind: "takeover.start" | "takeover.end", botId = "jit") {
  const { computer: c, lease } = f.app.computers.view(f.auth.actor, botId);
  return f.app.execute(f.auth.actor, { kind, requestId: rid(), expectedRevision: c!.revision,
    payload: { botId, computerId: c!.id, generation: c!.generation, leaseRevision: lease!.revision } });
}
function attempt(f: F, workId: string, botId = "jit") {
  return f.app.authority.admit(workId, rid(), { botId, tools: ["computer", "effect_send"], scopes: [], input: "Write a local report", calls: 48, outputBytes: 1024 });
}
function ownerCommand(view: ComputerView, input: OwnerInput = { kind: "text", text: "เจ้าของ / Owner" }): OwnerInputCommand {
  return { kind: "takeover.input", requestId: rid(), expectedRevision: view.computer!.revision,
    payload: { botId: view.computer!.botId, computerId: view.computer!.id, generation: view.computer!.generation, leaseRevision: view.lease!.revision, input } };
}
const reopened = (f: F) => { const app = new S14Application(f.store, f.options); return { app, actor: app.authenticate(f.token).actor }; };

test("computers are lazy and Jit has exactly the same work/Bot ceiling as any other Bot", async () => {
  const f = await fixture();
  expect(f.app.computers.view(f.auth.actor, "jit")).toEqual({ computer: null, lease: null });
  expect(f.runtime!.starts).toHaveLength(0);
  const work = start(f, "jit", []).work!;
  expect(() => f.app.execute(f.auth.actor, { kind: "computer.open", requestId: rid(), expectedRevision: 0, payload: { botId: "jit", workId: work.id } })).toThrow("computer_outside_grant");
  expect(() => f.app.computers.view({ ownerId: "owner" }, "jit")).toThrow("authentication_required");
  const other: Bot = { ...f.bot, id: "reader" };
  f.store.transaction(tx => tx.run("INSERT INTO bots VALUES (?,?)", other.id, JSON.stringify(other)));
  const own = start(f, "reader").work!;
  expect(() => f.app.execute(f.auth.actor, { kind: "computer.open", requestId: rid(), expectedRevision: 0, payload: { botId: "jit", workId: own.id } })).toThrow("bot_authority_changed");
  const c = (await running(f)).c;
  expect(c.limits).toMatchObject({ startupMs: 30000, cpuMillis: 500, pids: 128, diskBytes: 1073741824, idleMs: 300000 });
  expect(f.app.execute(f.auth.actor, { kind: "computer.open", requestId: rid(), expectedRevision: 0, payload: { botId: "reader", workId: own.id } }).computer?.botId).toBe("reader");
});

test("idle stop preserves named workspace/profile; exact reset/delete affects only the selected Bot", async () => {
  const f = await fixture(), a = await running(f);
  const other: Bot = { ...f.bot, id: "reader" };
  f.store.transaction(tx => tx.run("INSERT INTO bots VALUES (?,?)", other.id, JSON.stringify(other)));
  const b = await running(f, "reader");
  f.runtime!.volumes.get(a.c.id)!.workspace.set("report", "A report");
  f.runtime!.volumes.get(a.c.id)!.profile.set("cookie", "A private session");
  f.runtime!.volumes.get(b.c.id)!.workspace.set("report", "B report");
  f.clock.now += 300001;
  f.app.computers.sweep();
  await f.app.computers.drain();
  const stopped = f.app.computers.view(f.auth.actor, "jit").computer!;
  expect(stopped.state).toBe("stopped");
  expect(stopped.workspaceId).toBe(a.c.workspaceId);
  expect(stopped.profileId).toBe(a.c.profileId);
  const opened = f.app.execute(f.auth.actor, { kind: "computer.open", requestId: rid(), expectedRevision: stopped.revision, payload: { botId: "jit", workId: a.work.id } });
  await f.app.computers.drain();
  expect(f.runtime!.volumes.get(a.c.id)!.profile.get("cookie")).toBe("A private session");
  const current = f.app.computers.view(f.auth.actor, "jit").computer!;
  expect(() => lifecycle(f, "computer.reset", a.c)).toThrow("computer_scope_changed");
  expect(() => f.app.execute(f.auth.actor, { kind: "computer.reset", requestId: rid(), expectedRevision: current.revision, payload: { botId: "reader", computerId: current.id, generation: current.generation } })).toThrow("computer_scope_changed");
  const reset = lifecycle(f, "computer.reset", current);
  expect(f.runtime!.destroyed).toHaveLength(0);
  expect(f.app.execute(f.auth.actor, { kind: "computer.reset", requestId: reset.requestId, expectedRevision: current.revision, payload: { botId: current.botId, computerId: current.id, generation: current.generation } })).toEqual(reset);
  await f.app.computers.drain();
  const clean = f.app.computers.view(f.auth.actor, "jit").computer!;
  expect(clean.workspaceId).not.toBe(current.workspaceId);
  expect(f.runtime!.volumes.has(a.c.id)).toBe(false);
  expect(f.runtime!.volumes.get(b.c.id)!.workspace.get("report")).toBe("B report");
  lifecycle(f, "computer.delete", clean);
  await f.app.computers.drain();
  expect(f.app.computers.view(f.auth.actor, "jit").computer?.state).toBe("deleted");
  expect(opened.computer?.id).toBe(a.c.id);
});

test.each(["stop", "revoke", "startup-timeout"] as const)("late startup completion after %s never publishes a running handle", async change => {
  const runtime = new FakeComputerRuntime(), gate = barrier(); runtime.beforeStart = gate;
  const f = await fixture(runtime), work = start(f).work!;
  const receipt = f.app.execute(f.auth.actor, { kind: "computer.open", requestId: rid(), expectedRevision: 0, payload: { botId: "jit", workId: work.id } });
  const draining = f.app.computers.drain();
  await gate.reached;
  if (change === "stop") lifecycle(f, "computer.stop", receipt.computer!);
  if (change === "revoke") f.app.execute(f.auth.actor, { kind: "work.stop", requestId: rid(), expectedRevision: work.revision, payload: { workId: work.id } });
  if (change === "startup-timeout") f.clock.now += 30001;
  gate.release();
  await draining;
  expect(f.app.computers.view(f.auth.actor, "jit").computer?.state).not.toBe("running");
  expect(runtime.stops.length).toBeGreaterThan(0);
});

test("missing runtime fails closed and no host/backend fallback is available", async () => {
  const f = await fixture(null), { c, work } = await running(f);
  expect(c).toMatchObject({ state: "unavailable", reason: "computer_runtime_not_configured" });
  const a = attempt(f, work.id);
  expect(() => f.app.computers.open(a.id)).toThrow("computer_not_running");
});

test("lazy preparation drains an intent committed while an earlier empty drainer is settling", async () => {
  const f = await fixture(), idle = f.app.computers.drain();
  const a = attempt(f, start(f).work!.id);
  await f.app.computers.prepare(a.id);
  await idle;
  expect(f.app.computers.view(f.auth.actor, "jit").computer?.state).toBe("running");
  expect(f.runtime!.starts).toHaveLength(1);
});

test.each(["running", "stopping"])("two queued jobs for one Bot wait for its %s computer to stop before rebinding", async state => {
  const runtime = new FakeComputerRuntime(), gate = barrier();
  let runs = 0;
  const f = await fixture(runtime, { executor: { async run(a) {
    if (++runs === 2 && state === "stopping") f.app.computers.sweep();
    await f.app.computers.prepare(a.id);
    const session = f.app.computers.open(a.id);
    runtime.volumes.get(session.lease.computerId)!.workspace.set(a.workId, "persisted report");
    session.release();
    runtime.beforeStop = gate;
    return { state: "ready", text: "Report ready" };
  } } });
  const first = start(f).work!, second = start(f).work!;
  const draining = f.app.authority.drain();
  await gate.reached;
  const stopping = f.app.computers.view(f.auth.actor, "jit");
  expect(stopping.computer).toMatchObject({ state: "stopping", workId: first.id });
  expect(stopping.lease?.actor).toBeNull();
  expect(runtime.starts).toHaveLength(1);
  gate.release();
  await draining;
  expect(f.app.authority.view(f.auth.actor, first.id).work.state).toBe("ready");
  expect(f.app.authority.view(f.auth.actor, second.id).work.state).toBe("ready");
  const c = f.app.computers.view(f.auth.actor, "jit").computer!;
  expect(c).toMatchObject({ id: runtime.starts[0]!.id, state: "running", workId: second.id, workspaceId: runtime.starts[0]!.workspaceId, profileId: runtime.starts[0]!.profileId });
  expect(runtime.starts).toHaveLength(2);
  expect(c.generation).toBeGreaterThan(runtime.starts[0]!.generation);
  expect([...runtime.volumes.get(c.id)!.workspace.keys()]).toEqual([first.id, second.id]);
  const bindings = f.store.read(tx => tx.all<{ generation: number }>("SELECT generation FROM computer_attempts ORDER BY rowid"));
  expect(bindings.map(row => row.generation)).toEqual(runtime.starts.map(c => c.generation));
});

test.each(["unconfirmed-stop", "revoked", "expired"])("a queued computer handoff fails closed when %s while stop is settling", async change => {
  const runtime = new FakeComputerRuntime(), gate = barrier();
  const f = await fixture(runtime), first = await running(f), a = attempt(f, first.work.id);
  const session = f.app.computers.open(a.id); session.release();
  f.app.authority.commit(a.id, { state: "ready", text: "First report" });
  const second = start(f).work!, next = attempt(f, second.id);
  runtime.beforeStop = gate;
  const preparing = f.app.computers.prepare(next.id).then(() => null, error => error);
  await gate.reached;
  if (change === "unconfirmed-stop") runtime.stopFailure = true;
  if (change === "revoked") f.app.execute(f.auth.actor, { kind: "work.stop", requestId: rid(), expectedRevision: f.app.authority.view(f.auth.actor, second.id).work.revision, payload: { workId: second.id } });
  if (change === "expired") f.clock.now += 3600000;
  gate.release();
  expect(await preparing).toMatchObject({ code: { "unconfirmed-stop": "fixture_stop_unconfirmed", revoked: "grant_revoked", expired: "grant_expired" }[change] });
  expect(runtime.starts).toHaveLength(1);
  expect(f.app.computers.view(f.auth.actor, "jit").computer?.workId).toBe(first.work.id);
  expect(f.app.computers.view(f.auth.actor, "jit").lease?.actor).toBeNull();
});

test("a takeover fences queued agent input at the final runtime barrier and never approves a held effect", async () => {
  const f = await fixture(), { work } = await running(f), a = attempt(f, work.id);
  const session = f.app.computers.open(a.id), gate = barrier(); f.runtime!.beforeInput = gate;
  expect(() => f.store.transaction(tx => tx.run("UPDATE computer_attempts SET generation=generation+1 WHERE attempt_id=?", a.id))).toThrow("immutable_computer_attempt");
  expect(() => f.app.computers.open(a.id)).toThrow("input_lease_busy");
  const held = f.app.authority.proposeEffect(a.id, rid(), { kind: "send", destination: "https://recipient.invalid", content: "Exact content" }, f.clock.now + 60000);
  const input = f.app.computers.agentInput(a.id, session.lease, { kind: "scroll", deltaY: 200 });
  const refused = input.then(() => null, error => error);
  await gate.reached;
  takeover(f, "takeover.start");
  gate.release();
  expect(await refused).toMatchObject({ code: "input_lease_fenced" });
  expect(f.runtime!.inputs).toHaveLength(0);
  expect(() => f.app.computers.open(a.id)).toThrow("takeover_active");
  takeover(f, "takeover.end");
  expect(f.app.authority.effect(f.auth.actor, held.id).effect.state).toBe("pending");
  await expect(f.app.computers.agentInput(a.id, session.lease, { kind: "scroll", deltaY: 20 })).rejects.toThrow("input_lease_fenced");
  session.release();
  const next = f.app.computers.open(a.id);
  expect(next.lease.revision).toBeGreaterThan(session.lease.revision);
});

test("owner input waits for already dispatched agent input; no two actors send concurrently", async () => {
  const f = await fixture(), { work } = await running(f), a = attempt(f, work.id), session = f.app.computers.open(a.id);
  const gate = barrier(); f.runtime!.afterInput = gate;
  const agent = f.app.computers.agentInput(a.id, session.lease, { kind: "scroll", deltaY: 100 });
  const denied = agent.then(() => null, error => error);
  await gate.reached;
  takeover(f, "takeover.start");
  const owner = f.app.computers.ownerInput(f.auth.actor, ownerCommand(f.app.computers.view(f.auth.actor, "jit")));
  expect(f.runtime!.inputs).toHaveLength(1);
  f.runtime!.afterInput = null;
  gate.release();
  expect(await denied).toMatchObject({ code: "input_lease_fenced" });
  expect(await owner).toMatchObject({ state: "succeeded" });
  expect(f.runtime!.maxActive).toBe(1);
  expect(f.runtime!.inputs.map(i => i.input.kind)).toEqual(["scroll", "text"]);
});

test.each(["stop", "reset", "delete", "revoke", "bot", "owner", "expiry"] as const)("%s fences runner, input and late result publication", async change => {
  const f = await fixture(), { work, c } = await running(f), a = attempt(f, work.id), session = f.app.computers.open(a.id);
  const gate = barrier(); f.runtime!.beforeExec = gate;
  const pending = session.backend.spawn({ command: "local report", cwd: "/workspace", timeoutMs: 1000 });
  const refused = pending.then(() => null, error => error);
  await gate.reached;
  if (change === "stop" || change === "reset" || change === "delete") lifecycle(f, `computer.${change}`, c);
  if (change === "revoke") f.app.execute(f.auth.actor, { kind: "work.stop", requestId: rid(), expectedRevision: f.app.authority.view(f.auth.actor, work.id).work.revision, payload: { workId: work.id } });
  if (change === "bot") f.store.transaction(tx => tx.run("UPDATE bots SET record_json=? WHERE id='jit'", JSON.stringify({ ...f.bot, generation: 2 })));
  if (change === "owner") f.store.transaction(tx => tx.run("UPDATE owner SET generation=generation+1"));
  if (change === "expiry") f.clock.now += 3600000;
  gate.release();
  expect(await refused).toBeInstanceOf(Error);
  await expect(f.app.computers.agentInput(a.id, session.lease, { kind: "scroll", deltaY: 10 })).rejects.toThrow();
  expect(() => f.app.authority.commit(a.id, { state: "ready", text: "late report" })).toThrow();
  expect(f.runtime!.requests).toHaveLength(0);
});

test("owner text is transient; retries are single-use, changed requests conflict and restart never resends", async () => {
  const f = await fixture(); await running(f); takeover(f, "takeover.start");
  const secret = "private-session-password-not-for-prompts";
  const command = ownerCommand(f.app.computers.view(f.auth.actor, "jit"), { kind: "text", text: secret });
  expect(await f.app.computers.ownerInput(f.auth.actor, command)).toMatchObject({ state: "succeeded" });
  await f.app.computers.ownerInput(f.auth.actor, command);
  expect(f.runtime!.inputs).toHaveLength(1);
  await expect(f.app.computers.ownerInput(f.auth.actor, { ...command, payload: { ...command.payload, input: { kind: "text", text: "different" } } })).rejects.toThrow("request_id_conflict");
  expect(() => f.app.execute(f.auth.actor, { kind: "computer.stop", requestId: command.requestId, expectedRevision: command.expectedRevision,
    payload: { botId: "jit", computerId: command.payload.computerId, generation: command.payload.generation } })).toThrow("request_id_conflict");
  const rows = f.store.read(tx => tx.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'").flatMap(row => tx.all(`SELECT * FROM ${row.name}`)));
  expect(JSON.stringify(rows)).not.toContain(secret);
  expect(readFileSync(f.path).includes(Buffer.from(secret))).toBe(false);
  const next = reopened(f);
  expect(await next.app.computers.ownerInput(next.actor, command)).toMatchObject({ state: "unknown" });
  next.app.computers.recover(); await next.app.computers.drain();
  expect(next.app.computers.view(next.actor, "jit").computer?.state).toBe("stopped");
  expect(f.runtime!.inputs).toHaveLength(1);
});

test("a failed/late owner input is unknown and cannot be retried or leak its raw runtime error", async () => {
  const f = await fixture(); await running(f); takeover(f, "takeover.start");
  const command = ownerCommand(f.app.computers.view(f.auth.actor, "jit")), gate = barrier(); f.runtime!.afterInput = gate;
  const pending = f.app.computers.ownerInput(f.auth.actor, command);
  await gate.reached;
  takeover(f, "takeover.end");
  gate.release();
  expect(await pending).toMatchObject({ state: "unknown" });
  expect(await f.app.computers.ownerInput(f.auth.actor, command)).toMatchObject({ state: "unknown" });
  expect(f.runtime!.inputs).toHaveLength(1);
});

test("boot fences and stops without replaying a pending destructive operation", async () => {
  const f = await fixture(), { c } = await running(f);
  lifecycle(f, "computer.reset", c);
  const next = reopened(f); next.app.computers.recover(); await next.app.computers.drain();
  expect(f.runtime!.destroyed).toHaveLength(0);
  expect(next.app.computers.view(next.actor, "jit").computer?.workspaceId).toBe(c.workspaceId);
});

test("reset rechecks owner generation after an asynchronous runtime wait before wiping data", async () => {
  const f = await fixture(), { c } = await running(f), gate = barrier();
  f.runtime!.beforeDestroy = gate;
  lifecycle(f, "computer.reset", c);
  const draining = f.app.computers.drain();
  await gate.reached;
  f.store.transaction(tx => tx.run("UPDATE owner SET generation=generation+1"));
  gate.release();
  await draining;
  expect(f.runtime!.destroyed).toHaveLength(0);
  expect(f.runtime!.volumes.has(c.id)).toBe(true);
});

test("computer command rollback commits no operation and cannot fence a live lease", async () => {
  const f = await fixture(), { c } = await running(f);
  const fault = new S14Application(f.store, { ...f.options, beforeCommit() { throw Error("fixture_rollback"); } });
  const before = f.app.computers.view(f.auth.actor, "jit");
  expect(() => fault.execute(fault.authenticate(f.token).actor, { kind: "computer.reset", requestId: rid(), expectedRevision: c.revision,
    payload: { botId: "jit", computerId: c.id, generation: c.generation } })).toThrow("fixture_rollback");
  expect(f.app.computers.view(f.auth.actor, "jit")).toEqual(before);
  await fault.computers.drain();
  expect(f.runtime!.destroyed).toHaveLength(0);
});

test("transient input rollback sends nothing and creates no consumed input or audit receipt", async () => {
  const f = await fixture(); await running(f); takeover(f, "takeover.start");
  const fault = new S14Application(f.store, { ...f.options, beforeCommit() { throw Error("fixture_rollback"); } });
  const command = ownerCommand(f.app.computers.view(f.auth.actor, "jit"));
  await expect(fault.computers.ownerInput(fault.authenticate(f.token).actor, command)).rejects.toThrow("fixture_rollback");
  expect(f.runtime!.inputs).toHaveLength(0);
  expect(f.store.read(tx => tx.get("SELECT request_id FROM computer_inputs WHERE request_id=?", command.requestId))).toBe(null);
  expect(f.store.read(tx => tx.get("SELECT request_id FROM audit WHERE request_id=?", command.requestId))).toBe(null);
});

test("agent unknown click/submit/CDP/JavaScript/MCP cannot cross the input gateway", async () => {
  const f = await fixture(), { work } = await running(f), a = attempt(f, work.id), session = f.app.computers.open(a.id);
  for (const data of [{ kind: "click", x: 1, y: 1 }, { kind: "submit" }, { kind: "Runtime.evaluate", expression: "document.cookie" }, { kind: "mcp", tool: "write" }]) {
    await expect(f.app.computers.agentInput(a.id, session.lease, data as never)).rejects.toThrow("unsupported_browser_action");
  }
  expect(f.runtime!.inputs).toHaveLength(0);
  expect(() => f.app.authority.reserveTool(a.id, "mcp_write")).toThrow("tool_outside_grant");
});

test("lease expiry and a stale release cannot clear takeover ownership or send input", async () => {
  const f = await fixture(), { work } = await running(f), a = attempt(f, work.id), session = f.app.computers.open(a.id);
  takeover(f, "takeover.start");
  session.release();
  expect(f.app.computers.view(f.auth.actor, "jit").lease?.actor).toBe("owner");
  const command = ownerCommand(f.app.computers.view(f.auth.actor, "jit"));
  f.clock.now += 300000;
  await expect(f.app.computers.ownerInput(f.auth.actor, command)).rejects.toThrow("input_lease_fenced");
  expect(f.runtime!.inputs).toHaveLength(0);
});

test("finite computer capacity refuses a third computer until a stopped slot is available", async () => {
  const f = await fixture(); await running(f);
  for (const name of ["reader", "third"]) f.store.transaction(tx => tx.run("INSERT INTO bots VALUES (?,?)", name, JSON.stringify({ ...f.bot, id: name })));
  await running(f, "reader");
  const work = start(f, "third").work!;
  const command: ComputerCommand = { kind: "computer.open", requestId: rid(), expectedRevision: 0, payload: { botId: "third", workId: work.id } };
  expect(() => f.app.execute(f.auth.actor, command)).toThrow("computer_capacity");
  lifecycle(f, "computer.stop", f.app.computers.view(f.auth.actor, "jit").computer!);
  await f.app.computers.drain();
  expect(f.app.execute(f.auth.actor, command).computer?.botId).toBe("third");
});

test("the per-computer input/image queue stays finite while a physical input is settling", async () => {
  const f = await fixture(); await running(f); takeover(f, "takeover.start");
  const gate = barrier(); f.runtime!.afterInput = gate;
  const pending = f.app.computers.ownerInput(f.auth.actor, ownerCommand(f.app.computers.view(f.auth.actor, "jit")));
  await gate.reached;
  const images = Array.from({ length: 15 }, () => f.app.computers.screenshot(f.auth.actor, "jit"));
  await expect(f.app.computers.screenshot(f.auth.actor, "jit")).rejects.toThrow("computer_input_capacity");
  gate.release();
  expect(await pending).toMatchObject({ state: "succeeded" });
  expect(await Promise.all(images)).toHaveLength(15);
});

test("an unconfirmed runtime stop retains capacity until a later exact stop proves settlement", async () => {
  const f = await fixture(), a = await running(f);
  for (const name of ["reader", "third"]) f.store.transaction(tx => tx.run("INSERT INTO bots VALUES (?,?)", name, JSON.stringify({ ...f.bot, id: name })));
  await running(f, "reader");
  f.runtime!.stopFailure = true;
  lifecycle(f, "computer.stop", a.c);
  await f.app.computers.drain();
  const unavailable = f.app.computers.view(f.auth.actor, "jit").computer!;
  expect(unavailable.state).toBe("unavailable");
  const work = start(f, "third").work!;
  const command: ComputerCommand = { kind: "computer.open", requestId: rid(), expectedRevision: 0, payload: { botId: "third", workId: work.id } };
  expect(() => f.app.execute(f.auth.actor, command)).toThrow("computer_capacity");
  f.runtime!.stopFailure = false;
  lifecycle(f, "computer.stop", unavailable);
  await f.app.computers.drain();
  expect(f.app.execute(f.auth.actor, command).computer?.botId).toBe("third");
});

test("transport cancellation reaches only this Bot's runner and discards its late output", async () => {
  const f = await fixture(), { work } = await running(f), a = attempt(f, work.id), session = f.app.computers.open(a.id);
  const gate = barrier(); f.runtime!.beforeExec = gate;
  const abort = new AbortController();
  const pending = session.backend.spawn({ command: "local report", cwd: "/workspace", signal: abort.signal, timeoutMs: 1000 }).then(() => null, error => error);
  await gate.reached;
  abort.abort();
  gate.release();
  expect(await pending).toMatchObject({ name: "AbortError" });
  expect(f.runtime!.requests.some(r => (r as { op: string }).op === "kill")).toBe(true);
});

test("owner image/state/SSE and no-script coordinate/text/key commands retain same-origin, CSRF and finite bounds", async () => {
  const f = await fixture(); await running(f); takeover(f, "takeover.start");
  const origin = "http://localhost:3001", handler = createS14Handler(f.app, origin);
  const headers = { Cookie: `jit_s14=${f.token}`, Origin: origin, "Content-Type": "application/x-www-form-urlencoded" };
  const view = f.app.computers.view(f.auth.actor, "jit");
  for (const fields of [{ kind: "click", "point.x": "1279", "point.y": "799" }, { kind: "text", text: "ข้อความ" }, { kind: "key", key: "Enter" }]) {
    const form = new URLSearchParams({ csrf: f.auth.csrf, requestId: rid(), expectedRevision: String(view.computer!.revision), computerId: view.computer!.id,
      generation: String(view.computer!.generation), leaseRevision: String(view.lease!.revision), ...fields });
    const response = await handler(new Request(`${origin}/s14/bots/jit/computer/input`, { method: "POST", headers, body: form }));
    expect(response.status).toBe(303);
    const receipt = await handler(new Request(`${origin}${response.headers.get("Location")}`, { headers: { Cookie: `jit_s14=${f.token}` } }));
    expect(await receipt.json()).toEqual({ requestId: form.get("requestId"), computerId: view.computer!.id, state: "succeeded" });
  }
  expect(f.runtime!.inputs.map(i => i.input.kind)).toEqual(["click", "text", "key"]);
  const get = (suffix: string, actor = f.token) => handler(new Request(`${origin}/api/s14/bots/jit/computer${suffix}`, { headers: { Cookie: `jit_s14=${actor}` } }));
  const image = await get("/image");
  expect(image.headers.get("Content-Type")).toBe("image/png");
  expect(image.headers.get("Cache-Control")).toContain("no-store");
  expect(image.headers.get("Content-Security-Policy")).not.toContain("unsafe-inline");
  expect(new Uint8Array(await image.arrayBuffer())).toEqual(fixturePng);
  expect((await get("/events")).headers.get("Content-Type")).toContain("text/event-stream");
  expect(await (await get("")).json()).toEqual(view);
  expect((await get("/image", "bad")).status).toBe(401);
  const command = ownerCommand(view, { kind: "click", x: 1280, y: 0 });
  const post = (changes: Record<string, string> = {}, data = command) => handler(new Request(`${origin}/api/s14/bots/jit/computer/input`, { method: "POST",
    headers: { Cookie: `jit_s14=${f.token}`, Origin: origin, "Content-Type": "application/json", "X-CSRF-Token": f.auth.csrf, ...changes }, body: JSON.stringify(data) }));
  expect((await post()).status).toBe(403);
  expect((await post({ Origin: "http://evil.invalid" })).status).toBe(403);
  expect((await post({ "X-CSRF-Token": "bad" })).status).toBe(403);
  expect((await post({}, { ...command, payload: { ...command.payload, botId: "other" } })).status).toBe(403);
  f.runtime!.image = new Uint8Array(2097153);
  expect((await get("/image")).status).toBe(422);
  expect(f.runtime!.requests).toHaveLength(0);
});

test("schema 7 reopens with result and computer tables and original receipts intact", async () => {
  const f = await fixture();
  const original = f.store.read(tx => tx.all("SELECT * FROM command_receipts"));
  f.store.close(); stores.delete(f.store);
  const store = new S14Store(f.path); stores.add(store);
  expect(store.read(tx => tx.all("SELECT * FROM command_receipts"))).toEqual(original);
  expect(store.read(tx => tx.get<{ user_version: number }>("PRAGMA user_version")!.user_version)).toBe(7);
  for (const table of ["work_results", "bot_computers", "input_leases", "computer_operations", "computer_inputs", "computer_attempts"]) {
    expect(store.read(tx => tx.get("SELECT name FROM sqlite_master WHERE type='table' AND name=?", table))).not.toBeNull();
  }
});

test("pinned schway/host core-tools/v1 executes a scripted report through this Bot's runner and exposes no browser/MCP tools", async () => {
  const f = await fixture(), work = start(f).work!, a = attempt(f, work.id);
  let turns = 0;
  const result = await runComputerWork(f.app, join(f.root, "native"), a, new AbortController().signal, {
    provider: "scripted", id: "s14-box-conformance", async *stream(request) {
      expect(request.tools?.map(t => t.name)).toEqual(["read", "write", "edit", "bash", "grep", "find", "ls"]);
      expect(JSON.stringify(request)).not.toMatch(/private-session|profile1|podman.sock/);
      turns++;
      yield { type: "message_complete", message: { type: "assistant", id: rid(), content: turns === 1
        ? [{ type: "tool_call", id: rid(), name: "bash", arguments: { command: "printf report" } }]
        : [{ type: "text", text: "Bounded local report; public network evidence is unavailable." }] } };
    },
  });
  expect(result.state).toBe("ready");
  f.app.authority.commit(a.id, result);
  const view = f.app.authority.view(f.auth.actor, work.id);
  expect(view.work.result).toBe(a.id);
  expect(view.work.state).toBe("ready");
  expect(view.results).toEqual([expect.objectContaining({ attemptId: a.id, text: result.text, state: "ready" })]);
  expect(f.store.read(tx => tx.get<{ record_json: string }>("SELECT record_json FROM work_items WHERE id=?", work.id)!.record_json)).not.toContain(result.text);
  expect(f.runtime!.starts).toHaveLength(1);
  expect(f.runtime!.requests.some(r => (r as { op: string }).op === "spawn")).toBe(true);
  expect(f.app.computers.view(f.auth.actor, "jit").lease?.actor).toBe(null);
  expect(f.store.read(tx => tx.get<{ calls: number }>("SELECT calls FROM attempt_usage WHERE attempt_id=?", a.id)!.calls)).toBe(3);
});
