import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Model, ModelRequest, ToolResult } from "schway/host";
import { Application } from "../src/application";
import { readConfig } from "../src/config";
import { accessConfirmToken, type AccessCommand, type AccessLevel, type AccessReceipt } from "../src/exec/access";
import { BoxManager } from "../src/exec/box-manager";
import type { BoxExecRequest, BoxExecResult } from "../src/exec/box-runtime";
import { FakeBoxRuntime } from "../src/exec/fake-box-runtime";
import { executionInstruction, runMaxTurns, toolCallRetention, toolCallSubjectBytes } from "../src/exec/run-tools";
import { invalidateJob } from "../src/jobs/attempts";
import { JobQueue } from "../src/jobs/queue";
import { backupImageTables } from "../src/ops/backup";
import { registerSecretFingerprint } from "../src/security/secret-fingerprints";
import { TransactionStore } from "../src/store";
import { discussionPlanWork, specialistAnalysisWork } from "../src/team/dispatch";
import { jitReplyMarker, jitReplyWork, type JitReplyView } from "../src/team/jit-reply";
import { SchwayRunPort, describeEffectiveRun, schwayMaxCalls } from "../src/team/schway-port";
import { ScriptedRunPort, fixtureOutcome, type RunScript, type ScriptedTools } from "../src/team/scripted-port";
import type { ApplicationRunOutcome, ApplicationRunRequest, RoleRoute } from "../src/team/types";
import { localBox, localExec, type LocalBox } from "./fixtures/box-local-runner";

const roots: string[] = [], stores: TransactionStore[] = [], queues: JobQueue[] = [];
afterEach(async () => {
  for (const q of queues.splice(0)) { q.close(); await q.idle(); }
  for (const s of stores.splice(0)) s.close();
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});
const password = "fixture-exe05-owner-password", epoch = 1_800_000_000_000;
const grok: RoleRoute = { provider: "grok", model: "fixture-grok-exact", authRoute: "owner-grok" };
const rid = () => crypto.randomUUID();
const coreTools = ["read", "write", "edit", "bash", "grep", "find", "ls"];
const answer = (request: ApplicationRunRequest, output: string): ApplicationRunOutcome => ({
  ...fixtureOutcome("complete", output), usage: { calls: 1, rounds: 1, hops: 1, contextTokens: 0, outputTokens: 0, retries: 0, wallMs: 0, tokensUnknown: false },
  session: { adapter: "scripted", id: request.runId, context: request.context },
});
const deferred = <T = void,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
async function until(check: () => boolean, ms = 5_000) {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw new Error("timed out"); await Bun.sleep(5); }
}

/** A fake clock whose queue timers fire only when the test advances it. */
class Clock {
  now = epoch; #id = 0; #timers = new Map<number, { at: number; callback: () => void }>();
  timers = { set: (callback: () => void, ms: number) => { const id = ++this.#id; this.#timers.set(id, { at: this.now + ms, callback }); return id; }, clear: (id: unknown) => { this.#timers.delete(id as number); } };
}

type Exec = (box: LocalBox) => (handle: unknown, request: BoxExecRequest) => Promise<BoxExecResult>;
interface Options { script?: RunScript; model?: Model; env?: Record<string, string>; exec?: Exec }
/**
 * One installation with a Jit coordinator and a specialist, whose team port executes through a `BoxManager` over a
 * `FakeBoxRuntime`. The fake box runs the real `ops/box/runner` against a local directory, so tools really edit files
 * and run commands — without Podman.
 */
async function fixture(options: Options = {}) {
  const box = localBox("jit-exe05-"); roots.push(dirname(box.root));
  const path = join(dirname(box.root), "state.sqlite");
  const config = readConfig({ JIT_DATABASE: path, JIT_JOB_CONCURRENCY: "4", JIT_JOB_ROUTE_CONCURRENCY: "4", JIT_EXECUTION_FULL_ALLOWED: "1", ...options.env });
  const store = new TransactionStore(path); stores.push(store);
  const clock = new Clock(), now = () => clock.now;
  const runtime = new FakeBoxRuntime({ exec: options.exec ? options.exec(box) as never : localExec(box), workspaceRoot: box.root, temporaryDirectory: box.tmp });
  let queueRef: JobQueue | undefined;
  const boxes = new BoxManager(store, config, runtime, { now, onCapacity: () => { try { queueRef?.pump(); } catch { /* Closed. */ } } });
  const execution = { boxes, now };
  const seen: ApplicationRunRequest[] = [];
  const script: RunScript = options.script ?? ((request, _signal, _observe, tools) => answer(request, JSON.stringify({ reply: `tools:${tools.names.join(",") || "none"}` })));
  const port = options.model
    ? new SchwayRunPort(store, config.team, config.jobs.outputBytes, { model: options.model, execution, now })
    : new ScriptedRunPort(store, config.team, config.jobs.outputBytes, (request, signal, observe, tools) => { seen.push(request); return script(request, signal, observe, tools); },
      undefined, undefined, { execution });
  const current = () => queueRef;
  const queue = new JobQueue(store, config.jobs, [discussionPlanWork(), specialistAnalysisWork(store, config, port, now, current), jitReplyWork(store, config, port, now, current)],
    { now, timers: clock.timers, boxes }); queueRef = queue; queues.push(queue);
  const app = new Application(store, config, { now, jobs: queue, boxes });
  await app.setupOwner(password); const token = await app.login(password), auth = app.authenticate(token);
  const telegram = app.issueAdapterActor(token, "telegram");
  const project = app.execute(auth.actor, { kind: "project.create", projectId: null, requestId: rid(), expectedRevision: 0, payload: { name: "โครงการลงมือทำ" } }).project;
  const topic = app.execute(auth.actor, { kind: "topic.create", projectId: project.id, requestId: rid(), expectedRevision: project.revision, payload: { title: "แก้โค้ด" } }).topic;
  const role = (name: string, kind: "coordinator" | "specialist") => app.execute(auth.actor, { kind: "role.save", projectId: null, requestId: rid(),
    expectedRevision: app.team(auth.actor).ownerRevision, payload: { roleId: null, name, kind, responsibility: `${name} ทำงานในโครงการ`, enabled: true, route: grok } }).role!.id;
  const jitId = role("จิต", "coordinator"), techId = role("เทคโนโลยี", "specialist");
  return { box, config, store, clock, runtime, boxes, port, queue, app, auth, telegram, project, topic, jitId, techId, seen };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const access = (f: Fixture) => f.app.projectAccess(f.auth.actor, f.project.id);
function setLevel(f: Fixture, level: AccessLevel): AccessReceipt {
  const state = access(f);
  const payload = level === "read" || (level === "workspace" && state.level === "full") ? { level } : { level, confirmToken: accessConfirmToken(f.project.id, state.level, level, state.revision) };
  return f.app.execute(f.auth.actor, { kind: "access.level.set", requestId: rid(), projectId: f.project.id, expectedRevision: state.revision, payload } as AccessCommand);
}
function restrict(f: Fixture, roleId: string, level: AccessLevel | null): AccessReceipt {
  const revision = f.app.roleAccess(f.auth.actor, f.project.id).find(item => item.roleId === roleId)?.revision ?? 0;
  return f.app.execute(f.auth.actor, { kind: "access.role.restrict", requestId: rid(), projectId: f.project.id, expectedRevision: revision, payload: { roleId, level } });
}
function halt(f: Fixture): AccessReceipt {
  return f.app.execute(f.telegram, { kind: "execution.halt", requestId: rid(), projectId: f.project.id, expectedRevision: access(f).haltRevision, payload: { reason: "หยุดก่อน" } });
}
function send(f: Fixture, text: string) {
  const topic = f.app.conversation(f.auth.actor, f.project.id, f.topic.id).topic;
  return f.app.execute(f.auth.actor, { kind: "message.send", projectId: f.project.id, requestId: rid(), expectedRevision: topic.revision, payload: { topicId: f.topic.id, text } });
}
const replyFor = (f: Fixture, messageId: string): JitReplyView => f.app.replies(f.auth.actor, f.project.id, f.topic.id, [messageId]).get(messageId)!;
const messages = (f: Fixture) => f.app.conversation(f.auth.actor, f.project.id, f.topic.id).items;
const texts = (f: Fixture) => messages(f).map(item => (item as { text?: string }).text ?? "");
async function settle(f: Fixture) { f.queue.pump(); await f.queue.idle(); }
const boxOps = (f: Fixture) => f.runtime.calls.filter(call => call.op !== "status" && call.op !== "list");
const replyRequest = (f: Fixture, replyId: string) => f.store.read(tx => (JSON.parse(tx.get<{ record_json: string }>("SELECT record_json FROM team_runs WHERE id = ?", replyId)!.record_json) as { request: ApplicationRunRequest }).request);

test("WEB01-F granted execution loops finish with one reserved tool-free answer", async () => {
  const captured: ModelRequest[] = [];
  const model: Model = { provider: "scripted", id: "execution-final-turn", async *stream(request) {
    captured.push(request);
    yield { type: "message_complete", message: { type: "assistant", id: rid(), content: request.tools?.length
      ? [{ type: "tool_call", id: rid(), name: "ls", arguments: { path: "." } }]
      : [{ type: "text", text: "I listed the workspace. That evidence is insufficient to verify the requested change." }] } };
  } };
  const f = await fixture({ model, env: { JIT_JOB_RETRIES: "1", JIT_JOB_CALLS: "8", JIT_JOB_ROUNDS: "8" } });
  f.app.execute(f.auth.actor, { kind: "web.settings.set", requestId: rid(), projectId: f.project.id, expectedRevision: 0, payload: { enabled: false } });
  setLevel(f, "workspace");
  const { message } = send(f, "Inspect the workspace."); await settle(f);
  const reply = replyFor(f, message.id), request = replyRequest(f, reply.id);
  expect(reply.state).toBe("answered"); expect(runMaxTurns(request)).toBe(2);
  expect(captured).toHaveLength(2); expect(captured[0]!.tools!.map(tool => tool.name)).toEqual(coreTools);
  expect(captured[1]!.tools ?? []).toEqual([]); expect(captured[1]!.items.filter(item => item.type === "tool_result")).toHaveLength(1);
  expect(f.app.toolCalls(f.auth.actor, f.project.id)).toMatchObject([{ tool: "ls", status: "success", level: "workspace" }]);
  expect(texts(f).at(-1)).toContain("insufficient");
  expect(f.boxes.busy(f.project.id)).toBe(false);
  expect(f.app.job(f.auth.actor, f.project.id, reply.jobId!).remaining).toMatchObject({ calls: 4, rounds: 4 });
});

test("a read run admits zero execution tools: bash is an unknown tool, and nothing reaches a box", async () => {
  let called: Awaited<ReturnType<ScriptedTools["call"]>> | null = null;
  const f = await fixture({ script: async (request, _s, _o, tools) => {
    called = await tools.call("bash", { command: "cat /etc/passwd" });
    return answer(request, JSON.stringify({ reply: `tools:${tools.names.length}` }));
  } });
  expect(access(f).level).toBe("read");
  const { message } = send(f, "รันคำสั่งให้หน่อย");
  await settle(f);
  expect(called as unknown).toEqual({ content: "Unknown tool: bash", isError: true });
  expect(replyFor(f, message.id).state).toBe("answered");
  expect(texts(f)).toContain("tools:0");
  // The frozen grant is null; the trusted execution statement says read; no box was ensured or called.
  const request = f.seen[0]!;
  expect(request.execution).toBeNull();
  expect(runMaxTurns({ ...request, web: false })).toBe(1);
  expect(describeEffectiveRun(request).sections.find(section => section.name === "execution")!.content).toContain("read. This run has no execution tools");
  expect(boxOps(f)).toEqual([]);
  expect(f.app.toolCalls(f.auth.actor, f.project.id)).toEqual([]);
  // A read reply is not execution work: the kill switch has nothing of it to fence.
  expect(f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM jobs WHERE json_extract(record_json, '$.execution') = 1")!.n)).toBe(0);
});

test("a workspace run edits files and runs commands in the box, and the results appear in the conversation", async () => {
  const f = await fixture({ script: async (request, _s, _o, tools) => {
    const write = await tools.call("write", { path: "notes.txt", content: "สวัสดีจาก box\n" });
    const bash = await tools.call("bash", { command: "cat notes.txt && echo done" });
    return answer(request, JSON.stringify({ reply: `${tools.names.join(",")}|${write.isError ? "write-failed" : "written"}|${bash.content}` }));
  } });
  setLevel(f, "workspace");
  const { message } = send(f, "สร้างไฟล์ notes แล้วอ่านให้ดู");
  await settle(f);
  const reply = replyFor(f, message.id);
  expect(reply.state).toBe("answered");
  const text = texts(f).find(item => item.startsWith("read,"))!;
  expect(text.split("|")[0]).toBe(coreTools.join(","));
  expect(text).toContain("written");
  expect(text).toContain("Exit code: 0");
  expect(text).toContain("สวัสดีจาก box\ndone");
  // The file exists in the box workspace (here the local stand-in), not in the Jit process directory.
  expect(readFileSync(join(f.box.root, "notes.txt"), "utf8")).toBe("สวัสดีจาก box\n");
  // The grant was frozen at admission with Jit's effective level and the project's own box.
  const request = replyRequest(f, reply.id);
  expect(request.execution).toEqual({ level: "workspace", boxProjectId: f.project.id });
  expect(describeEffectiveRun(request).sections.find(section => section.name === "execution")!.content).toContain("workspace. The core tools");
  expect(f.runtime.calls.filter(call => call.op === "ensure")).toEqual([{ op: "ensure", projectId: f.project.id, mode: "workspace", profile: false, outcome: "created" }]);
  // Every call is audited, newest first, with bounded subjects and no file content.
  const calls = f.app.toolCalls(f.auth.actor, f.project.id);
  expect(calls.map(call => [call.tool, call.status, call.subject, call.exitCode])).toEqual([
    ["bash", "success", "cat notes.txt && echo done", 0], ["write", "success", "notes.txt", null],
  ]);
  for (const call of calls) {
    expect(call).toMatchObject({ projectId: f.project.id, runId: request.runId, jobId: reply.jobId, roleId: f.jitId, box: `jit-box-${f.project.id}`, level: "workspace" });
    expect(call.durationMs).toBeGreaterThanOrEqual(0);
  }
  expect(JSON.stringify(calls)).not.toContain("สวัสดีจาก box");
  expect(f.app.toolCalls(f.auth.actor, f.project.id, { runId: request.runId, limit: 1 })).toHaveLength(1);
  expect(f.app.toolCalls(f.telegram, f.project.id)).toHaveLength(2);
  expect(backupImageTables.execution_tool_calls).toBe("include");
  // The box session was released: the box stays only until the idle sweep.
  expect(f.boxes.busy(f.project.id)).toBe(false);
});

test("the concrete Schway port admits the core tools over the box at workspace and none at read", async () => {
  const requests: ModelRequest[] = [];
  const model: Model = {
    provider: "scripted", id: "exe05-fixture",
    async *stream(request: ModelRequest) {
      requests.push(request);
      const result = [...request.items].reverse().find((item): item is ToolResult => item.type === "tool_result");
      yield { type: "message_complete", message: result
        ? { type: "assistant", id: rid(), content: [{ type: "text", text: JSON.stringify({ reply: `box said: ${result.content}` }) }] }
        : { type: "assistant", id: rid(), content: [{ type: "tool_call", id: rid(), name: "bash", arguments: { command: "printf 'from-box' > out.txt && cat out.txt" } }] } };
    },
  };
  const f = await fixture({ model });
  f.app.execute(f.auth.actor, { kind: "web.settings.set", requestId: rid(), projectId: f.project.id, expectedRevision: 0, payload: { enabled: false } });
  // Read: the model is offered no tool; its bash call executes nothing and the single-turn run ends without a reply.
  const first = send(f, "ลองรันดู").message;
  await settle(f);
  expect(requests[0]!.tools ?? []).toEqual([]);
  expect(requests[0]!.context.find(section => section.name === "execution")!.content).toContain("read. This run has no execution tools");
  expect(replyFor(f, first.id).state).not.toBe("answered");
  expect(boxOps(f)).toEqual([]);
  expect(existsSync(join(f.box.root, "out.txt"))).toBe(false);
  // Workspace: the exact core tools are admitted, bash runs in the box, and the reply carries its result.
  setLevel(f, "workspace");
  requests.length = 0;
  const second = send(f, "ลองรันอีกครั้ง").message;
  await settle(f);
  expect(requests[0]!.tools!.map(tool => tool.name)).toEqual(coreTools);
  expect(requests[0]!.context.find(section => section.name === "execution")!.content).toContain("workspace.");
  const reply = replyFor(f, second.id);
  expect(reply.state).toBe("answered");
  expect(texts(f).some(text => text.startsWith("box said: Exit code: 0") && text.includes("from-box"))).toBe(true);
  expect(readFileSync(join(f.box.root, "out.txt"), "utf8")).toBe("from-box");
  const request = replyRequest(f, reply.id);
  expect(runMaxTurns(request)).toBeGreaterThan(1);
  expect(f.app.job(f.auth.actor, f.project.id, reply.jobId!).limits.calls).toBeGreaterThanOrEqual(1 + schwayMaxCalls(request) - 1);
  expect(f.app.toolCalls(f.auth.actor, f.project.id).map(call => [call.tool, call.status, call.level])).toEqual([["bash", "success", "workspace"]]);
});

test("a role restricted below the project gets its own lower level; a specialist runs at the project level", async () => {
  const levels: Record<string, string> = {};
  const f = await fixture({ script: (request, _s, _o, tools) => {
    levels[request.instructions.operator[0] === jitReplyMarker ? "jit" : "specialist"] = `${request.execution?.level ?? "read"}:${tools.names.length}`;
    return request.instructions.operator[0] === jitReplyMarker
      ? answer(request, JSON.stringify({ reply: "ok" }))
      : answer(request, JSON.stringify({ status: "done", result: "วิเคราะห์แล้ว", evidence: "none" }));
  } });
  setLevel(f, "full");
  restrict(f, f.jitId, "workspace");
  send(f, "เริ่มเลย");
  await settle(f);
  expect(levels.jit).toBe("workspace:7");
  f.app.execute(f.auth.actor, { kind: "team.dispatch", requestId: rid(), projectId: f.project.id, expectedRevision: f.app.project(f.auth.actor, f.project.id).revision,
    payload: { topicId: f.topic.id, purpose: "ตรวจโค้ด", sources: [], include: [f.techId], exclude: [], limits: { roles: 2, calls: 64, rounds: 64, hops: 4, contextTokens: 64_000, outputTokens: 4_000, retries: 1, wallMs: 60_000 } } });
  await settle(f);
  expect(levels.specialist).toBe("full:7");
  // The role override of `read` grants nothing, even while the project is at full.
  restrict(f, f.jitId, "read");
  send(f, "อีกรอบ");
  await settle(f);
  expect(levels.jit).toBe("read:0");
});

test("lowering the level mid-run fences the run: later calls are refused and no late result is published", async () => {
  const gate = deferred(), started = deferred();
  let second: Awaited<ReturnType<ScriptedTools["call"]>> | null = null, aborted = false;
  const f = await fixture({ script: async (request, signal, _o, tools) => {
    await tools.call("bash", { command: "echo first > first.txt" });
    started.resolve();
    await gate.promise;
    aborted = signal.aborted;
    second = await tools.call("bash", { command: "echo late > late.txt" });
    return answer(request, JSON.stringify({ reply: "ผลที่มาช้า" }));
  } });
  setLevel(f, "workspace");
  const { message } = send(f, "ทำงานยาว");
  f.queue.pump();
  await started.promise;
  const receipt = setLevel(f, "read");
  const reply = replyFor(f, message.id);
  expect(receipt.narrowed).toEqual({ fencedJobIds: [reply.jobId!] });
  gate.resolve();
  await f.queue.idle();
  expect(aborted).toBe(true);
  expect(second as unknown).toEqual({ content: "Execution access changed: this run can no longer use tools.", isError: true });
  expect(existsSync(join(f.box.root, "late.txt"))).toBe(false);
  expect(texts(f)).not.toContain("ผลที่มาช้า");
  const after = replyFor(f, message.id);
  expect(after.state).not.toBe("answered");
  expect(f.app.job(f.auth.actor, f.project.id, reply.jobId!)).toMatchObject({ state: "blocked", reason: "authorization_changed" });
  expect(f.app.toolCalls(f.auth.actor, f.project.id).map(call => [call.subject, call.status])).toEqual([["echo late > late.txt", "refused"], ["echo first > first.txt", "success"]]);
  // The narrower level stops the box running at workspace.
  await until(() => f.runtime.calls.some(call => call.op === "stop"));
});

test("a halt cancels an in-flight command in the box, stops the box and publishes nothing", async () => {
  let result: Awaited<ReturnType<ScriptedTools["call"]>> | null = null;
  const f = await fixture({ script: async (request, _s, _o, tools) => {
    result = await tools.call("bash", { command: "sleep 3; echo never > never.txt" });
    return answer(request, JSON.stringify({ reply: "ไม่ควรเห็น" }));
  } });
  setLevel(f, "workspace");
  const { message } = send(f, "รันนาน");
  f.queue.pump();
  await until(() => f.app.toolCalls(f.auth.actor, f.project.id).some(call => call.status === "running"));
  const receipt = halt(f);
  expect(receipt.halt!.fencedJobIds).toEqual([replyFor(f, message.id).jobId!]);
  await f.queue.idle();
  expect(result!.isError).toBe(true);
  expect(texts(f)).not.toContain("ไม่ควรเห็น");
  expect(replyFor(f, message.id).state).toBe("stopped");
  expect(f.app.toolCalls(f.auth.actor, f.project.id).map(call => call.status)).toEqual(["cancelled"]);
  await until(() => f.runtime.calls.some(call => call.op === "stop"));
  await Bun.sleep(3_200);
  expect(existsSync(join(f.box.root, "never.txt"))).toBe(false);
  // While halted the next reply runs with no grant at all.
  send(f, "ยังอยู่ไหม");
  await settle(f);
  expect(f.seen.at(-1)!.execution).toBeNull();
}, 15_000);

test("an owner stop cancels the run's tool call; a result arriving after a fence is never published", async () => {
  const release = deferred();
  let readResult: Awaited<ReturnType<ScriptedTools["call"]>> | null = null;
  // The runner answers `read` only when the test releases it, and ignores cancellation: a truly late callback.
  const exec: Exec = box => async (handle, request) => {
    const op = (JSON.parse(new TextDecoder().decode(request.input)) as { op: string }).op;
    if (op === "read") { await release.promise; return localExec(box)(handle as never, { input: request.input, timeoutMs: request.timeoutMs }); }
    return localExec(box)(handle as never, request);
  };
  const f = await fixture({ exec, script: async (request, _s, _o, tools) => {
    await tools.call("write", { path: "secret-plan.txt", content: "แผนลับ\n" });
    readResult = await tools.call("read", { path: "secret-plan.txt" });
    return answer(request, JSON.stringify({ reply: `อ่านได้: ${readResult.content}` }));
  } });
  setLevel(f, "workspace");
  const { message } = send(f, "อ่านไฟล์");
  f.queue.pump();
  await until(() => f.app.toolCalls(f.auth.actor, f.project.id).some(call => call.tool === "read" && call.status === "running"));
  const reply = replyFor(f, message.id);
  // Another process fenced the attempt (no local cancellation reaches this run): only the fence check stops the result.
  f.store.transaction(tx => invalidateJob(tx, reply.jobId!, "cancelled", epoch, true));
  release.resolve();
  await f.queue.idle();
  expect(readResult!.isError).toBe(true);
  expect(readResult!.content).not.toContain("แผนลับ");
  expect(texts(f).some(text => text.includes("แผนลับ"))).toBe(false);
  expect(f.app.toolCalls(f.auth.actor, f.project.id).map(call => [call.tool, call.status])).toEqual([["read", "cancelled"], ["write", "success"]]);
  expect(replyFor(f, message.id).state).not.toBe("answered");
});

test("an owner reply stop aborts the in-flight command through the run signal", async () => {
  const f = await fixture({ script: async (request, _s, _o, tools) => {
    const result = await tools.call("bash", { command: "sleep 3" });
    return answer(request, JSON.stringify({ reply: result.content }));
  } });
  setLevel(f, "workspace");
  const { message } = send(f, "หยุดได้ไหม");
  f.queue.pump();
  await until(() => f.app.toolCalls(f.auth.actor, f.project.id).some(call => call.status === "running"));
  const reply = replyFor(f, message.id);
  f.app.execute(f.auth.actor, { kind: "jit.reply.stop", requestId: rid(), projectId: f.project.id, expectedRevision: reply.revision, payload: { replyId: reply.id } });
  f.queue.cancelFenced();
  await f.queue.idle();
  expect(replyFor(f, message.id).state).toBe("stopped");
  expect(f.app.toolCalls(f.auth.actor, f.project.id).map(call => call.status)).toEqual(["cancelled"]);
  const kills = f.runtime.calls.filter(call => call.op === "exec" && (call.request as { op: string }).op === "kill");
  expect(kills).toHaveLength(1);
}, 10_000);

test("a level lowered between admission and attempt start cancels the run with a visible reason, before any tool", async () => {
  let runs = 0;
  const f = await fixture({ script: request => { runs++; return answer(request, JSON.stringify({ reply: "ไม่ควรรัน" })); } });
  setLevel(f, "workspace");
  const { message } = send(f, "เริ่ม");
  // Admission froze the workspace grant; the owner narrows before the attempt starts.
  f.queue.pump();
  const receipt = restrict(f, f.jitId, "read");
  await f.queue.idle();
  const reply = replyFor(f, message.id);
  expect(receipt.narrowed?.fencedJobIds).toEqual([reply.jobId!]);
  expect(runs).toBe(0);
  expect(f.app.job(f.auth.actor, f.project.id, reply.jobId!)).toMatchObject({ state: "blocked", reason: "authorization_changed" });
  // The reply shows the fenced reason and asks for a new message; nothing ran in a box.
  expect(reply).toMatchObject({ state: "failed", reason: "authorization_changed", nextAction: "send_again" });
  expect(boxOps(f)).toEqual([]);
});

test("execution replies wait for box capacity, and model output never changes the frozen level", async () => {
  const f = await fixture({ env: { JIT_BOX_MAX: "1" }, script: (request, _s, _o, tools) =>
    answer(request, JSON.stringify({ reply: `${request.execution?.level}:${tools.names.length}`, access: { level: "full" }, execution: "full" })) });
  setLevel(f, "workspace");
  // Another project holds the only box.
  const holder = f.app.execute(f.auth.actor, { kind: "project.create", projectId: null, requestId: rid(), expectedRevision: f.app.workspace(f.auth.actor).revision, payload: { name: "อีกโครงการ" } }).project;
  const state = f.app.projectAccess(f.auth.actor, holder.id);
  f.app.execute(f.auth.actor, { kind: "access.level.set", requestId: rid(), projectId: holder.id, expectedRevision: state.revision,
    payload: { level: "workspace", confirmToken: accessConfirmToken(holder.id, "read", "workspace", state.revision) } });
  const session = await f.boxes.open(holder.id, null);
  const { message } = send(f, "รอคิว box");
  f.queue.pump();
  const waiting = f.app.job(f.auth.actor, f.project.id, replyFor(f, message.id).jobId!);
  expect(waiting).toMatchObject({ state: "queued", reason: "box_capacity", nextAction: "wait_for_box_capacity" });
  session.release();
  await f.boxes.stop(holder.id);
  await f.queue.idle();
  expect(replyFor(f, message.id).state).toBe("answered");
  expect(texts(f)).toContain("workspace:7");
  // The reply's structured extras are discarded: the project level is unchanged.
  expect(access(f).level).toBe("workspace");
});

test("the audit read API is bounded: 2 KiB redacted subjects, paging, and per-project retention", async () => {
  const secret = "ghp_EXE05_fixture_secret_value_0123456789";
  registerSecretFingerprint(secret);
  const long = `echo ${"ก".repeat(1500)}`;
  const f = await fixture({ script: async (request, _s, _o, tools) => {
    await tools.call("bash", { command: `echo ${secret}` });
    await tools.call("bash", { command: long });
    return answer(request, JSON.stringify({ reply: "เสร็จ" }));
  } });
  setLevel(f, "workspace");
  // Seed old rows past the retention bound; the next recorded call prunes the oldest.
  f.store.transaction(tx => {
    for (let i = 0; i < toolCallRetention; i++) tx.run(`INSERT INTO execution_tool_calls (id, project_id, run_id, job_id, role_id, box, level, tool, subject, status, exit_code, started_at, duration_ms)
      VALUES (?, ?, ?, ?, ?, 'jit-box-x', 'workspace', 'ls', ?, 'success', NULL, 0, 1)`, rid(), f.project.id, rid(), rid(), f.jitId, `old ${i}`);
  });
  send(f, "รันสองคำสั่ง");
  await settle(f);
  const count = f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM execution_tool_calls WHERE project_id = ?", f.project.id)!.n);
  expect(count).toBe(toolCallRetention);
  const [newest, redacted] = f.app.toolCalls(f.auth.actor, f.project.id, { limit: 2 });
  expect(Buffer.byteLength(newest!.subject)).toBeLessThanOrEqual(toolCallSubjectBytes);
  expect(newest!.subject.startsWith("echo กก")).toBe(true);
  expect(newest!.subject).not.toContain("�");
  expect(redacted!.subject).not.toContain(secret);
  expect(redacted!.subject).toContain("[credential-redacted]");
  const page = f.app.toolCalls(f.auth.actor, f.project.id, { before: redacted!.sequence, limit: 100 });
  expect(page).toHaveLength(100);
  expect(page.every(call => call.sequence < redacted!.sequence)).toBe(true);
  expect(() => f.app.toolCalls(f.auth.actor, f.project.id, { limit: 101 })).toThrow("invalid_cursor");
  expect(() => f.app.toolCalls(f.auth.actor, f.project.id, { before: 0 })).toThrow("invalid_cursor");
  expect(() => f.app.toolCalls(f.auth.actor, rid())).toThrow();
});

test("the trusted execution statement depends only on the frozen grant", () => {
  expect(executionInstruction(null)).toContain("read. This run has no execution tools");
  expect(executionInstruction({ level: "workspace", boxProjectId: rid() })).toContain("owner-allowed package registries");
  const full = executionInstruction({ level: "full", boxProjectId: rid() });
  expect(full).toContain("full. The core tools");
  expect(full).toContain("only through Jit effect tools");
  expect(full).toContain("approval card");
});

test("a box session is bound to the container it opened: a wider reopen for another role refuses the older session", async () => {
  const f = await fixture();
  setLevel(f, "full");
  restrict(f, f.techId, "workspace");
  // The workspace-limited role opens the box first, in workspace mode (no network beyond the registry proxy).
  const limited = await f.boxes.open(f.project.id, f.techId);
  expect(limited.handle.mode).toBe("workspace");
  expect((await limited.backend.stat(f.box.root)).type).toBe("directory");
  // Another run opens it at full: the container is recreated in full mode under the same name.
  const wide = await f.boxes.open(f.project.id, f.jitId);
  expect(wide.handle.mode).toBe("full");
  expect(f.runtime.calls.filter(call => call.op === "ensure").map(call => (call as { outcome: string; mode: string }).mode)).toEqual(["workspace", "full"]);
  const before = f.runtime.calls.filter(call => call.op === "exec").length;
  // The older session would now reach a full-network box: every further command is refused before the runtime.
  await expect(limited.backend.stat(f.box.root)).rejects.toMatchObject({ code: "EIO" });
  await expect(limited.backend.spawn({ command: "curl https://example.com", cwd: f.box.root })).rejects.toMatchObject({ code: "EIO" });
  expect(f.runtime.calls.filter(call => call.op === "exec").length).toBe(before);
  // The session that opened the current container keeps working.
  expect((await wide.backend.stat(f.box.root)).type).toBe("directory");
  limited.release(); wide.release();
});
