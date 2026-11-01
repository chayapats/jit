import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CdpClient } from "../src/exec/cdp-stream";
import type { CommandRunner } from "../src/exec/podman-runtime";
import { S14Store } from "../src/s14/store";
import { InputEvidenceTransport, inputEvidenceBounds, type EvidenceTimer } from "../ops/box/input-evidence-transport";
import { InputEvidenceProcesses, inputEvidenceOverride, requireUnusedInputEvidencePool } from "../ops/box/input-evidence-host";
import { prepareInputEvidenceState, writeInputEvidencePrivate } from "../ops/box/input-evidence-state";
import { cleanupInputEvidence, inputEvidenceApplication, runInputEvidenceCases, type InputEvidenceResults } from "../ops/box/input-evidence-cases";
import { cdpFrame, inputEvidencePipe, inputEvidenceRuntime } from "./fixtures/s14-input-evidence";

const roots: string[] = [];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true }); });
const root = () => { const value = realpathSync(mkdtempSync(join(tmpdir(), "s14-input-evidence-"))); roots.push(value); return value; };
const argv = ["exec", "-i", `jit-s14-${"a".repeat(32)}-browser`, "/opt/jit/cdp-relay"];
function clock() {
  let now = 0;
  const pending = new Map<() => void, number>();
  const timer: EvidenceTimer = (callback, ms) => { pending.set(callback, now + ms); return () => { pending.delete(callback); }; };
  return { timer, advance(ms: number) { now += ms; for (const [callback, due] of [...pending]) if (due <= now) { pending.delete(callback); callback(); } }, pending };
}
function protocol(auto = false) {
  const time = clock(), transport = new InputEvidenceTransport(time.timer), pipe = inputEvidencePipe(auto);
  const stream = transport.streams(() => pipe.stream)(argv, {}), client = new CdpClient(stream);
  cleanups.push(async () => { transport.close(); await transport.join(); });
  return { time, transport, pipe, stream, client };
}

test("pass-through writes synchronously forward the identical bytes, with bounded fragmented NUL framing", async () => {
  const f = protocol(), bytes = cdpFrame({ id: 1, method: "Input.dispatchKeyEvent", params: { type: "keyDown", key: "Tab" } });
  const first = bytes.subarray(0, 9), second = bytes.subarray(9);
  f.stream.write(first); expect(f.pipe.writes[0]).toBe(first);
  f.stream.write(second); expect(f.pipe.writes[1]).toBe(second);
  expect(f.transport.trace).toEqual([{ order: 1, pipe: 1, stage: "write", id: 1, method: "Input.dispatchKeyEvent" }]);
  // A fixture response, never physical evidence.
  f.pipe.emit(cdpFrame({ id: 1, result: {} }));
});

test("only an actually received reply reaches a latch; coalesced replies preserve exact bytes and order", async () => {
  const f = protocol(), gate = f.transport.arm("Input.dispatchMouseEvent");
  let settled = false;
  const first = f.client.send("Input.dispatchMouseEvent", { type: "mouseWheel" }).then(() => { settled = true; });
  expect(gate.state).toBe("armed"); expect(() => gate.release()).toThrow("input_evidence_reply_not_received");
  const second = f.client.send("Input.dispatchKeyEvent", { type: "keyDown" });
  const bytes = Buffer.concat([cdpFrame({ id: 1, result: {} }), cdpFrame({ id: 2, result: {} })]);
  f.pipe.emit(bytes.subarray(0, 7)); f.pipe.emit(bytes.subarray(7));
  await gate.reached;
  expect(settled).toBe(false); expect(f.transport.trace.filter(t => t.stage === "delivered")).toHaveLength(0);
  gate.release(); await Promise.all([first, second]);
  expect(f.transport.trace.filter(t => t.stage === "delivered").map(t => t.id)).toEqual([1, 2]);
  const before = f.transport.trace.length; gate.release(); expect(f.transport.trace.length).toBe(before);
  expect(JSON.stringify(f.transport.trace)).not.toContain("mouseWheel");
});

test("output events and replies pass through byte-for-byte without copying bodies into the trace", async () => {
  const time = clock(), transport = new InputEvidenceTransport(time.timer), pipe = inputEvidencePipe();
  const stream = transport.streams(() => pipe.stream)(argv, {}), iterator = stream.stdout[Symbol.asyncIterator]();
  cleanups.push(async () => { transport.close(); await iterator.return?.(); await transport.join(); });
  stream.write(cdpFrame({ id: 7, method: "Target.getTargets" }));
  const event = cdpFrame({ method: "Target.fixtureEvent", params: { secret: "never-retain-this" } }), reply = cdpFrame({ id: 7, result: { private: "opaque-body" } });
  pipe.emit(Buffer.concat([event, reply]));
  expect((await iterator.next()).value).toEqual(event); expect((await iterator.next()).value).toEqual(reply);
  expect(JSON.stringify(transport.trace)).not.toMatch(/never-retain|opaque-body|fixtureEvent/);
});

test.each([false, true])("fake-clock gate timeout before/after receipt (%s) closes the actual pipe and settles the client", async received => {
  const f = protocol(), gate = f.transport.arm("Target.attachToTarget");
  const result = f.client.send("Target.attachToTarget").catch(error => error);
  if (received) { f.pipe.emit(cdpFrame({ id: 1, result: { sessionId: "fixture" } })); await gate.reached; }
  f.time.advance(inputEvidenceBounds.gateMs);
  expect(f.pipe.closed).toBe(true); expect(f.transport.failure).toBe("input_evidence_gate_timeout");
  expect((await result).code).toBe("cdp_closed"); expect(f.time.pending.size).toBe(0);
  gate.release(); expect(gate.state).toBe("closed");
  await f.transport.join();
});

test("peer close of an actually held reply closes the latch immediately and a stale release cannot replay it", async () => {
  const f = protocol(), gate = f.transport.arm("Input.dispatchMouseEvent");
  const result = f.client.send("Input.dispatchMouseEvent").catch(error => error);
  f.pipe.emit(cdpFrame({ id: 1, result: {} })); await gate.reached;
  f.pipe.stream.close(); await result; await f.transport.join();
  expect(gate.state).toBe("closed"); expect(f.time.pending.size).toBe(0);
  gate.release(); expect(f.transport.trace.filter(t => t.stage === "delivered")).toHaveLength(0);
});

test.each(["timeout", "pipe", "success"])("saved result and actual console output retain distinct diagnostics without private bodies (%s)", async kind => {
  const directory = root();
  const child = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "fixtures/s14-input-evidence-outcome.ts"), kind, directory],
    { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(exitCode, stderr).toBe(0); expect(stderr).toBe("");
  const summary = JSON.parse(stdout), savedBytes = readFileSync(join(directory, "result.json"), "utf8"), saved = JSON.parse(savedBytes);
  const reason = kind === "success" ? null : "input_evidence_gate_closed";
  const failure = kind === "timeout" ? "input_evidence_gate_timeout" : kind === "pipe" ? "input_evidence_pipe_closed" : null;
  for (const output of [saved, summary]) {
    expect(output).toHaveProperty("reason", reason); expect(output).toHaveProperty("transportFailure", failure);
    expect(output.outcome).toBe(kind === "success" ? "integration_cases_completed" : "failed");
    expect(output.cleanupConfirmed).toBe(true);
  }
  expect(Object.keys(summary).sort()).toEqual(["cleanupConfirmed", "contract", "label", "outcome", "reason", "transportFailure"]);
  expect(saved.trace[0]).toEqual({ order: 1, pipe: 1, stage: "write", id: 1, method: "Target.getTargets" });
  expect(stdout + savedBytes).not.toMatch(/fixture-private-protocol-body|bbbbbbbbbbbbbbbb|password|sessionId/);
  const state = JSON.parse(readFileSync(join(directory, "private.json"), "utf8"));
  expect(state.password).toBe(kind === "success" ? null : "b".repeat(64));
  for (const file of ["result.json", "private.json"]) expect(lstatSync(join(directory, file)).mode & 0o077).toBe(0);
});

test("a delayed timer callback cannot allow an overdue authority commit to release a reply as success", async () => {
  let now = 0;
  const transport = new InputEvidenceTransport(() => () => {}, () => now), pipe = inputEvidencePipe();
  const client = new CdpClient(transport.streams(() => pipe.stream)(argv, {}));
  cleanups.push(async () => { transport.close(); await transport.join(); });
  const gate = transport.arm("Input.dispatchMouseEvent"), result = client.send("Input.dispatchMouseEvent").catch(error => error);
  pipe.emit(cdpFrame({ id: 1, result: {} })); await gate.reached;
  now = 5001;
  expect(() => gate.release()).toThrow("input_evidence_gate_timeout");
  expect((await result).code).toBe("cdp_closed"); expect(transport.trace.filter(t => t.stage === "delivered")).toHaveLength(0);
});

test("unterminated input and outstanding command limits refuse before additional dispatch", () => {
  const f = protocol();
  for (let id = 1; id <= inputEvidenceBounds.pending; id++) f.stream.write(cdpFrame({ id, method: "Target.getTargets" }));
  expect(() => f.stream.write(cdpFrame({ id: 17, method: "Target.getTargets" }))).toThrow("input_evidence_dispatch_refused");
  expect(f.pipe.writes).toHaveLength(inputEvidenceBounds.pending);
  const g = protocol();
  g.stream.write(new Uint8Array(inputEvidenceBounds.frameBytes).fill(1));
  expect(() => g.stream.write(new Uint8Array([1, 1]))).toThrow("input_evidence_frame_bound");
  expect(g.pipe.writes).toHaveLength(1);
});

test("aggregate byte and trace limits close the fixture pipe without retaining large bodies", async () => {
  const f = protocol(true), body = "x".repeat(60000);
  for (let i = 0; i < 36 && !f.transport.failure; i++) await f.client.send("Target.getTargets", { body }).catch(() => {});
  expect(f.transport.failure).not.toBeNull(); expect(f.pipe.writes.length).toBeLessThan(36);
  expect(JSON.stringify(f.transport.trace)).not.toContain(body);
  const g = protocol(true);
  for (let i = 0; i < 90 && !g.transport.failure; i++) await g.client.send("Target.getTargets").catch(() => {});
  expect(g.transport.trace.length).toBeLessThanOrEqual(inputEvidenceBounds.traceEntries);
  expect(g.transport.failure).not.toBeNull();
});

test.each(["error", "unmatched", "malformed", "truncated", "oversize"])("failed %s response closes transport without fabricating success", async kind => {
  const f = protocol(), result = f.client.send("Target.attachToTarget").catch(error => error);
  if (kind === "error") f.pipe.emit(cdpFrame({ id: 1, error: { code: -1, message: "private error" } }));
  if (kind === "unmatched") f.pipe.emit(cdpFrame({ id: 99, result: {} }));
  if (kind === "malformed") f.pipe.emit(new TextEncoder().encode("bad\0"));
  if (kind === "truncated") { f.pipe.emit(new TextEncoder().encode('{"id":')); f.pipe.stream.close(); }
  if (kind === "oversize") f.pipe.emit(new Uint8Array(inputEvidenceBounds.frameBytes + 1).fill(1));
  expect((await result).code).toBe("cdp_closed"); await f.transport.join();
  expect(f.transport.trace.filter(t => t.stage === "delivered")).toHaveLength(0);
});

test("forbidden dispatch never reaches the underlying writer or opens extra raw-CDP/control streams", async () => {
  const f = protocol();
  expect(() => f.stream.write(cdpFrame({ id: 1, method: "Runtime.evaluate", params: { expression: "secret" } }))).toThrow("input_evidence_dispatch_refused");
  expect(f.pipe.writes).toHaveLength(0);
  const transport = new InputEvidenceTransport(); let calls = 0;
  const streams = transport.streams(() => { calls++; return inputEvidencePipe().stream; });
  expect(() => streams([...argv, "extra"], {})).toThrow("input_evidence_stream_refused");
  expect(() => streams(argv, { TOKEN: "secret" })).toThrow("input_evidence_stream_refused"); expect(calls).toBe(0);
});

test("two received latches maximum; interruption releases them, joins actual runner/stream promises and allows named cleanup", async () => {
  const f = protocol(), input = f.transport.arm("Input.dispatchMouseEvent"), runner = f.transport.arm("runner.spawn");
  expect(() => f.transport.arm("Target.attachToTarget")).toThrow("input_evidence_gate_capacity");
  const result = f.client.send("Input.dispatchMouseEvent").catch(error => error);
  f.pipe.emit(cdpFrame({ id: 1, result: {} })); await input.reached;
  let actual = 0;
  const run: CommandRunner = async () => { actual++; return { exitCode: 0, stdout: new TextEncoder().encode('{"v":1,"ok":true,"result":{"exitCode":0,"timedOut":false,"stdout":"eA=="}}'), stderr: new Uint8Array() }; };
  const wrapped = f.transport.commands(run);
  const returned = wrapped(["exec", "-i", "fixture", "/opt/jit/runner"], { stdin: new TextEncoder().encode('{"op":"spawn"}'), timeoutMs: 1000 }).catch(error => error);
  await runner.reached; expect(actual).toBe(1); expect(f.transport.held).toBe(2);
  f.transport.abort(); await result; expect((await returned).code).toBe("input_evidence_interrupted");
  await f.transport.join(); expect(f.transport.held).toBe(0); expect(f.time.pending.size).toBe(0);
  await wrapped(["rm", "--force", "--ignore", "exact-fixture-name"], { timeoutMs: 1000 }); expect(actual).toBe(2);
  expect(() => wrapped(["exec", "fixture", "/opt/jit/runner"], { timeoutMs: 1000 })).toThrow("input_evidence_interrupted");
});

test("four synthetic cases exercise real application and BotPodmanRuntime guards over scripted protocols only", async () => {
  const directory = root(), transport = new InputEvidenceTransport(), f = inputEvidenceRuntime(join(directory, "pool"), transport);
  const store = new S14Store(join(directory, "state/application.sqlite"));
  cleanups.push(async () => { transport.close(); await transport.join(); store.close(); });
  const app = inputEvidenceApplication(store, f.runtime);
  await app.provisionOwner("fixture-password-not-live"); const actor = app.authenticate(await app.login("fixture-password-not-live")).actor;
  await app.recovery.boot({ async open() { throw new Error("native forbidden"); } });
  const setup = app.execute(actor, { kind: "setup", requestId: "fixture_setup", expectedRevision: 0, payload: { ownerName: "Fixture", language: "th", routeId: "evidence", capabilities: { tools: ["computer", "effect_publish"], resources: [] } } });
  const results: InputEvidenceResults = { transportKernelFacts: [], controlledAssertions: [], unrun: ["all_physical_transport"] };
  await runInputEvidenceCases(app, actor, setup.conversation!.id, transport, {
    async remember() { expect(f.infos.size).toBe(2); }, async absent() { expect(f.infos.size).toBe(0); },
  }, results);
  expect(results.controlledAssertions).toHaveLength(5); expect(results.unrun).toEqual(["all_physical_transport"]);
  expect(app.authority.list(actor)).toHaveLength(4); expect(app.authority.list(actor).every(w => w.state === "stopped")).toBe(true);
  expect(f.runnerOps).toEqual(["spawn", "spawn"]); expect(f.pipes.every(p => p.closed)).toBe(true);
  expect(transport.trace.filter(t => t.method === "Input.dispatchMouseEvent" && t.stage === "write")).toHaveLength(3);
  expect(transport.trace.filter(t => t.method === "Input.dispatchKeyEvent" && t.stage === "write")).toHaveLength(2);
  expect(() => app.options.chat.reply({} as never, new AbortController().signal)).toThrow("input_evidence_forbidden_port");
  expect(() => app.options.authority!.executor!.run({} as never, new AbortController().signal)).toThrow("input_evidence_forbidden_port");
  expect(() => app.options.parallel!.transport!("https://fixture.invalid", {})).toThrow("input_evidence_forbidden_port");
  expect(() => app.options.personal!.transport!("https://fixture.invalid", {})).toThrow("input_evidence_forbidden_port");
  expect(() => app.options.git!.remote!.push("", {} as never, "", () => { throw Error("must not reach guard"); })).toThrow("input_evidence_forbidden_port");
  expect(app.options.authority!.effects).toEqual({});
  const computer = app.computers.view(actor, "jit").computer!;
  for (const role of ["workspace", "profile"]) writeFileSync(join(directory, "pool/slots", computer.diskSlot!.id, role, "synthetic-marker"), "fixture-private-data");
  transport.close(); await transport.join();
  f.failStop(true);
  await expect(cleanupInputEvidence(app, actor, join(directory, "pool"), async () => { expect(f.infos.size).toBe(0); })).rejects.toThrow("input_evidence_cleanup_stop_unconfirmed");
  expect(app.computers.view(actor, "jit").computer!.diskSlot!.id).toBe(computer.diskSlot!.id);
  expect(existsSync(join(directory, "pool/slots", computer.diskSlot!.id, "workspace/synthetic-marker"))).toBe(true);
  f.failStop(false);
  await cleanupInputEvidence(app, actor, join(directory, "pool"), async () => { expect(f.infos.size).toBe(0); });
  expect(app.computers.view(actor, "jit").computer).toMatchObject({ state: "deleted", diskSlot: null });
  expect(existsSync(join(directory, "pool/slots", computer.diskSlot!.id, "workspace/synthetic-marker"))).toBe(false);
  expect(existsSync(join(directory, "pool/slots", computer.diskSlot!.id, "profile/synthetic-marker"))).toBe(false);
});

test("container absence alone cannot clear an observed kernel process; PID reuse is distinguished by start time", async () => {
  let exists = true;
  const starts = new Map([[101, "original-1"], [102, "original-2"]]);
  const run: CommandRunner = async argv => ({ exitCode: argv[0] === "container" ? exists ? 0 : 1 : 0,
    stdout: new TextEncoder().encode(argv[0] === "inspect" ? `${argv.at(-1)!.endsWith("workspace") ? 101 : 102} true` : ""), stderr: new Uint8Array() });
  const processes = new InputEvidenceProcesses(run, pid => starts.get(pid) ?? null), id = "a".repeat(32);
  await processes.remember(id); exists = false;
  await expect(processes.absent(id)).rejects.toThrow("input_evidence_kernel_process_still_present");
  starts.delete(101); starts.set(102, "different-start-time"); await processes.absent(id);
  await expect(processes.remember(id)).rejects.toThrow("input_evidence_process_unobserved");
  await expect(processes.absent("not-an-id")).rejects.toThrow("input_evidence_process_scope_refused");
});

test("partial process observation retains every witness and refuses cleanup until inspection is confirmed", async () => {
  let containersExist = true;
  const starts = new Map([[101, "original-workspace"]]);
  const run: CommandRunner = async argv => {
    const workspace = argv.at(-1)!.endsWith("workspace");
    return { exitCode: argv[0] === "container" ? containersExist ? 0 : 1 : workspace ? 0 : 125,
      stdout: new TextEncoder().encode(argv[0] === "inspect" && workspace ? "101 true" : ""), stderr: new Uint8Array() };
  };
  const processes = new InputEvidenceProcesses(run, pid => starts.get(pid) ?? null), id = "b".repeat(32);
  await expect(processes.remember(id)).rejects.toThrow("input_evidence_process_unobserved");
  containersExist = false;
  await expect(processes.absent(id)).rejects.toThrow("input_evidence_kernel_process_still_present");
  starts.delete(101);
  await expect(processes.absent(id)).rejects.toThrow("input_evidence_process_observation_unconfirmed");
  // A cleanup inspection may confirm missing containers, but must retain the earlier process witness.
  starts.set(101, "original-workspace");
  await processes.remember(id, false);
  await expect(processes.absent(id)).rejects.toThrow("input_evidence_kernel_process_still_present");
  starts.delete(101); await processes.absent(id);
});

test.each([0, 1, 31])("command settlement at monotonic time %s cannot bypass its 1 ms deadline", async elapsed => {
  // Isolate the fake process/clock from other tests. No Podman or host runtime is invoked.
  const child = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "fixtures/s14-input-evidence-command.ts"), String(elapsed)],
    { env: { PATH: process.env.PATH, LANG: "C", JIT_PODMAN_MODE: "local" }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(exitCode).toBe(0); expect(stderr).toBe("");
  expect(JSON.parse(stdout).code).toBe(elapsed < 1 ? "success" : "input_evidence_command_timeout");
});

test("installed unused-pool refusal includes stopped claims and never edits installed authority", () => {
  const file = join(root(), "application.sqlite"), store = new S14Store(file);
  requireUnusedInputEvidencePool(file);
  // This is guard-fixture data only; the live helper never writes SQL authority.
  store.transaction(tx => { tx.run("INSERT INTO bots VALUES ('fixture','{}')"); tx.run("INSERT INTO bot_computers VALUES ('fixture','fixture',?)", JSON.stringify({ state: "stopped", diskSlot: { id: "slot-0001" } })); });
  const before = readFileSync(file);
  expect(() => requireUnusedInputEvidencePool(file)).toThrow("evidence_requires_unused_disposable_pool");
  expect(readFileSync(file)).toEqual(before); store.close();
});

test("fresh state is unique/private, stale state requires cleanup-only, and password never enters safe diagnostics", () => {
  const path = join(root(), "input-evidence"), fresh = prepareInputEvidenceState(path, false);
  expect(lstatSync(fresh.statePath).mode & 0o777).toBe(0o600);
  expect(() => prepareInputEvidenceState(path, false)).toThrow("input_evidence_unsafe_or_stale_state_cleanup_only");
  expect(prepareInputEvidenceState(path, true).storePath).toBe(fresh.storePath);
  writeInputEvidencePrivate(fresh.resultPath, { outcome: "failed", reason: "safe-code" });
  expect(readFileSync(fresh.resultPath, "utf8")).not.toContain(fresh.state.password!);
  fresh.state.phase = "cleaned"; fresh.state.password = null; writeInputEvidencePrivate(fresh.statePath, fresh.state);
  expect(() => prepareInputEvidenceState(path, true)).toThrow("input_evidence_unsafe_or_stale_state_cleanup_only");
  expect(existsSync(fresh.statePath)).toBe(true);
});

test.each(["symlink", "mode", "foreign-file", "oversize"])("unsafe retained %s state refuses without traversal or cleanup", kind => {
  const directory = root(), path = join(directory, "input-evidence"), f = prepareInputEvidenceState(path, false);
  if (kind === "symlink") { const target = join(directory, "target"); writeFileSync(target, "never-touch"); symlinkSync(target, join(path, f.state.runId, "application.sqlite")); }
  if (kind === "mode") chmodSync(f.statePath, 0o644);
  if (kind === "foreign-file") writeFileSync(join(path, "unexpected"), "untouched");
  if (kind === "oversize") writeFileSync(f.statePath, "x".repeat(4097));
  expect(() => prepareInputEvidenceState(path, true)).toThrow("input_evidence_unsafe_or_stale_state_cleanup_only");
});

test("reviewable unit override changes only entrypoint, explicit opt-in and restart, and imports never execute a host", async () => {
  expect(inputEvidenceOverride("/opt/jit-s14/bin/bun", "/opt/jit-s14/current")).toBe("[Service]\nExecStart=\nExecStart=/opt/jit-s14/bin/bun --no-env-file /opt/jit-s14/current/ops/box/s14-input-evidence.ts\nEnvironment=JIT_S14_INPUT_EVIDENCE=unused-disposable-installation\nRestart=no\n");
  expect(inputEvidenceOverride("/opt/jit-s14/bin/bun", "/opt/jit-s14/current", true)).toContain("--cleanup-only");
  await import("../ops/box/s14-input-evidence");
});
