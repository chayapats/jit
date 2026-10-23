import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { Application, type ApplicationOptions, type OwnerActor } from "../src/application";
import { readConfig } from "../src/config";
import { AppError } from "../src/errors";
import { JobQueue } from "../src/jobs/queue";
import { projectStateWork } from "../src/jobs/project-state";
import { ensurePrSchema } from "../src/pr/schema";
import { mutateMonitor } from "../src/pr/authority";
import { TRIGGER_POLICY_VERSION } from "../src/pr/types";
import { commitOutputSource, type SourceReference } from "../src/sources";
import { TransactionStore } from "../src/store";
import { registerTaskEvidenceArtifact, type TaskCommand } from "../src/tasks";
import { createWebHandler } from "../src/web";

const roots: string[] = [], stores: TransactionStore[] = [], queues: JobQueue[] = [];
afterEach(async () => {
  for (const queue of queues.splice(0)) { queue.close(); await queue.idle(); }
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

const password = "fixture-task-owner-password", epoch = 1800000000000;
const rid = () => crypto.randomUUID();
async function fixture(options: { beforeCommit?: ApplicationOptions["beforeCommit"]; jobs?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "jit-task01-")); roots.push(root);
  const path = join(root, "state.sqlite"), config = readConfig({ JIT_DATABASE: path }), store = new TransactionStore(path); stores.push(store);
  let now = epoch;
  const queue = options.jobs ? new JobQueue(store, config.jobs, [projectStateWork(store)], { now: () => now }) : undefined;
  if (queue) queues.push(queue);
  const app = new Application(store, config, { now: () => now, ...(queue ? { jobs: queue } : {}), ...(options.beforeCommit ? { beforeCommit: options.beforeCommit } : {}) });
  await app.setupOwner(password);
  const token = await app.login(password), auth = app.authenticate(token);
  const project = app.execute(auth.actor, { kind: "project.create", projectId: null, requestId: rid(), expectedRevision: 0, payload: { name: "โครงการงาน 🧪" } }).project;
  const topic = app.execute(auth.actor, { kind: "topic.create", projectId: project.id, requestId: rid(), expectedRevision: project.revision, payload: { title: "หัวข้อข้อผูกพัน" } }).topic;
  return { root, path, config, store, app, token, auth, project, topic, web: createWebHandler(app), advance: (ms: number) => { now += ms; } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function rejection(run: () => unknown): AppError {
  try { run(); } catch (error) { if (error instanceof AppError) return error; throw error; }
  throw new Error("expected an application rejection");
}
function count(store: TransactionStore, table: string): number {
  return store.read(tx => tx.get<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)!.n);
}
function propose(f: Fixture, topic = f.topic, extra: { title?: string; summary?: string; source?: SourceReference; requestId?: string; expectedRevision?: number } = {}): Extract<TaskCommand, { kind: "task.propose" }> {
  return { kind: "task.propose", requestId: extra.requestId ?? rid(), projectId: topic.projectId, expectedRevision: extra.expectedRevision ?? topic.revision,
    payload: { topicId: topic.id, title: extra.title ?? "ตรวจสัญญา", summary: extra.summary ?? "สรุปจากหัวข้อนี้", ...(extra.source ? { source: extra.source } : {}) } };
}
function request(f: Fixture, path: string, body?: Record<string, unknown>, form = false) {
  const encoded = body ? (form ? new URLSearchParams(body as Record<string, string>) : JSON.stringify(body)) : undefined;
  return new Request(`http://localhost:3000${path}`, { method: body ? "POST" : "GET", headers: { cookie: `jit_session=${f.token}`, ...(body ? { origin: "http://localhost:3000", "x-csrf-token": f.auth.csrf, "content-type": form ? "application/x-www-form-urlencoded" : "application/json" } : {}) }, ...(encoded ? { body: encoded } : {}) });
}

test("proposing, editing, and accepting keep one obligation; chat and a conflicting request do not", async () => {
  let fail = false;
  const f = await fixture({ beforeCommit: stage => { if (fail && stage === "task") throw new Error("task rollback"); } });
  const chat = f.app.execute(f.auth.actor, { kind: "message.send", projectId: f.project.id, requestId: rid(), expectedRevision: f.topic.revision, payload: { topicId: f.topic.id, text: "accept and execute" } });
  expect(count(f.store, "tasks")).toBe(0);
  const command = propose(f, f.topic, { expectedRevision: chat.topicRevision, title: "<script>alert(1)</script>" });
  const proposed = f.app.execute(f.auth.actor, command);
  expect(f.app.execute(f.auth.actor, command)).toEqual(proposed);
  expect(() => f.app.execute(f.auth.actor, { ...command, payload: { ...command.payload, summary: "คนละข้อความ" } })).toThrow("request_id_conflict");
  expect(count(f.store, "tasks")).toBe(1);
  expect(proposed.task).toMatchObject({ state: "proposed", origin: "owner", revision: 1, title: "<script>alert(1)</script>" });
  expect(proposed.event).toMatchObject({ kind: "proposed", actorId: "owner", channel: "web" });
  const edited = f.app.execute(f.auth.actor, { kind: "task.edit", requestId: rid(), projectId: f.project.id, expectedRevision: proposed.task.revision,
    payload: { taskId: proposed.task.id, title: "ชื่องานที่แก้", summary: "สรุปใหม่" } });
  expect(edited.proposal.revision).toBe(2);
  const stale = rejection(() => f.app.execute(f.auth.actor, { kind: "task.accept", requestId: rid(), projectId: f.project.id, expectedRevision: 1,
    payload: { taskId: proposed.task.id, proposalId: proposed.proposal.id } }));
  expect(stale).toMatchObject({ code: "stale_revision", status: 409, detail: { projectId: f.project.id, taskId: proposed.task.id, proposalId: edited.proposal.id, revision: 2, path: `/projects/${f.project.id}/tasks/${proposed.task.id}` } });
  fail = true;
  const rolled = { kind: "task.accept", requestId: rid(), projectId: f.project.id, expectedRevision: 2, payload: { taskId: proposed.task.id, proposalId: edited.proposal.id } } as const;
  expect(() => f.app.execute(f.auth.actor, rolled)).toThrow("task rollback");
  expect(f.store.read(tx => tx.get("SELECT * FROM command_receipts WHERE request_id = ?", rolled.requestId))).toBeNull();
  expect(f.app.task(f.auth.actor, f.project.id, proposed.task.id).task.state).toBe("proposed");
  fail = false;
  const accepted = f.app.execute(f.auth.actor, rolled);
  expect(f.app.execute(f.auth.actor, rolled)).toEqual(accepted);
  expect(() => f.app.execute(f.auth.actor, { ...rolled, expectedRevision: 1 })).toThrow("request_id_conflict");
  expect(accepted.task.acceptance).toEqual({ actorId: "owner", channel: "web", proposalId: edited.proposal.id, proposalRevision: 2, acceptedAt: epoch });
  expect(count(f.store, "jobs")).toBe(0);
  const visible = f.app.execute(f.auth.actor, propose(f, f.topic, { expectedRevision: chat.topicRevision, title: "<script>alert(1)</script>", summary: "ยังเป็นข้อเสนอ" }));
  const page = await (await f.web(request(f, `/projects/${f.project.id}/tasks/${visible.task.id}`))).text();
  expect(page).toContain("ข้อเสนอ");
  expect(page).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  expect(page).not.toContain("<script");
  const list = await (await f.web(request(f, `/projects/${f.project.id}/tasks`))).text();
  expect(list).toContain("ข้อเสนอที่ยังไม่รับรอง");
  expect(list).toContain("ข้อผูกพันที่รับรองแล้ว");
  expect(list).toContain("ชื่องานที่แก้");
  expect(list).toContain("&lt;script&gt;");
  expect(list).not.toContain("<script");
  const reopenedStore = new TransactionStore(f.path); stores.push(reopenedStore);
  const reopened = new Application(reopenedStore, f.config, { now: () => epoch }), actor = reopened.authenticate(f.token).actor;
  const model = reopened.task(actor, f.project.id, proposed.task.id);
  expect(reopened.tasks(actor, f.project.id).accepted.map(task => task.id)).toEqual([proposed.task.id]);
  expect(reopened.tasks(actor, f.project.id).proposed.map(task => task.id)).toEqual([visible.task.id]);
  expect(model.task.state).toBe("accepted");
  expect(model.source.state).toBe("available");
  expect(model.proposals.map(item => item.revision)).toEqual([1, 2]);
  expect(model.events.map(item => item.kind)).toEqual(["proposed", "edited", "accepted"]);
});

test("projects stay separate, forged actors have no authority, and telegram can accept only a task", async () => {
  const f = await fixture();
  const other = f.app.execute(f.auth.actor, { kind: "project.create", projectId: null, requestId: rid(), expectedRevision: 1, payload: { name: "โครงการงาน 🧪" } }).project;
  const otherTopic = f.app.execute(f.auth.actor, { kind: "topic.create", projectId: other.id, requestId: rid(), expectedRevision: other.revision, payload: { title: "หัวข้ออีกโครงการ" } }).topic;
  const title = "ชื่องานเดียวกัน";
  const first = f.app.execute(f.auth.actor, propose(f, f.topic, { title })).task;
  const second = f.app.execute(f.auth.actor, propose(f, otherTopic, { title })).task;
  expect(first.id).not.toBe(second.id);
  expect(f.app.tasks(f.auth.actor, f.project.id).proposed.map(task => task.id)).toEqual([first.id]);
  expect(f.app.tasks(f.auth.actor, other.id).proposed.map(task => task.id)).toEqual([second.id]);
  const missingTopic = propose(f);
  (missingTopic.payload as { topicId: string }).topicId = crypto.randomUUID();
  expect(rejection(() => f.app.execute(f.auth.actor, missingTopic)).code).toBe("topic_not_found");
  expect(rejection(() => f.app.execute(f.auth.actor, { kind: "task.accept", requestId: rid(), projectId: other.id, expectedRevision: first.revision, payload: { taskId: first.id, proposalId: crypto.randomUUID() } })).code).toBe("task_not_found");
  const forged = { ownerId: "owner", channel: "web" } as OwnerActor;
  const forgedTelegram = { ownerId: "owner", channel: "telegram" } as OwnerActor;
  expect(() => f.app.execute(forged, propose(f, otherTopic))).toThrow("authentication_required");
  expect(() => f.app.execute(forgedTelegram, propose(f, otherTopic))).toThrow("authentication_required");
  const telegram = f.app.issueAdapterActor(f.token, "telegram");
  const open = f.app.task(f.auth.actor, other.id, second.id);
  const accepted = f.app.execute(telegram, { kind: "task.accept", requestId: rid(), projectId: other.id, expectedRevision: open.task.revision, payload: { taskId: second.id, proposalId: open.proposals.at(-1)!.id } });
  expect(accepted.task.acceptance?.channel).toBe("telegram");
  expect(rejection(() => f.app.execute(telegram, { kind: "project.create", projectId: null, requestId: rid(), expectedRevision: 2, payload: { name: "ไม่ควรสร้าง" } })).code).toBe("channel_not_authorized");
  expect(rejection(() => f.app.execute(telegram, { kind: "decision.accept", requestId: rid(), projectId: other.id, expectedRevision: 1,
    payload: { proposalId: crypto.randomUUID(), optionId: null, conclusion: "ไม่รับจากช่องนี้", rationale: "การตัดสินยังอยู่บนเว็บ" } })).code).toBe("channel_not_authorized");
  expect(f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM owner_decisions")!.n)).toBe(0);
});

test("one acceptance wins a two-channel race, and start writes nothing", async () => {
  const f = await fixture();
  const proposed = f.app.execute(f.auth.actor, propose(f));
  const jobsBefore = count(f.store, "jobs");
  const commands = (["web", "telegram"] as const).map(channel => ({ channel, command: {
    kind: "task.accept" as const, requestId: rid(), projectId: f.project.id, expectedRevision: proposed.task.revision,
    payload: { taskId: proposed.task.id, proposalId: proposed.proposal.id },
  } }));
  const workers = commands.map(item => new Worker(new URL("./task-race-worker.ts", import.meta.url), { workerData: { path: f.path, token: f.token, now: epoch, channel: item.channel, command: item.command } }));
  const messages: { ready?: boolean; ok?: boolean; message?: string; state?: string }[] = [];
  await new Promise<void>((resolve, reject) => {
    let ready = 0;
    for (const worker of workers) {
      worker.on("message", message => {
        if (message.ready) { if (++ready === workers.length) for (const item of workers) item.postMessage("go"); return; }
        messages.push(message);
        if (messages.length === workers.length) resolve();
      });
      worker.on("error", reject);
    }
  });
  for (const worker of workers) worker.terminate();
  expect(messages.filter(item => item.ok)).toHaveLength(1);
  expect(messages.find(item => !item.ok)!.message).toBe("stale_revision");
  expect(f.app.task(f.auth.actor, f.project.id, proposed.task.id).task.state).toBe("accepted");
  expect(count(f.store, "jobs")).toBe(jobsBefore);
  const receipts = count(f.store, "command_receipts");
  const started = { kind: "task.start" as const, requestId: rid(), projectId: f.project.id, expectedRevision: f.app.task(f.auth.actor, f.project.id, proposed.task.id).task.revision, payload: { taskId: proposed.task.id } };
  expect(rejection(() => f.app.execute(f.auth.actor, started))).toMatchObject({ code: "coding_execution_unsupported", detail: { taskId: proposed.task.id, path: `/projects/${f.project.id}/tasks/${proposed.task.id}` } });
  expect(rejection(() => f.app.execute(f.auth.actor, { ...started, requestId: rid(), expectedRevision: 0 })).code).toBe("stale_revision");
  expect(rejection(() => f.app.execute(f.auth.actor, { ...started, requestId: rid(), payload: { taskId: crypto.randomUUID() } })).code).toBe("task_not_found");
  expect(f.app.task(f.auth.actor, f.project.id, proposed.task.id).task.state).toBe("accepted");
  expect(count(f.store, "jobs")).toBe(jobsBefore);
  expect(count(f.store, "command_receipts")).toBe(receipts);
  expect(f.store.read(tx => tx.get("SELECT kind FROM task_events WHERE kind = 'start_refused'"))).toBeNull();
});

test("a project inspection and a PR monitor do not create tasks, and task pages do not write receipts", async () => {
  const f = await fixture({ jobs: true });
  const project = f.app.project(f.auth.actor, f.project.id);
  f.app.execute(f.auth.actor, { kind: "job.enqueue", requestId: rid(), projectId: project.id, expectedRevision: project.revision,
    payload: { type: "project.status", configurationRevision: 1, policyRevision: f.config.jobs.revision, purpose: "ตรวจสถานะโครงการ", inputRevision: project.revision, input: {}, priority: "background", limits: structuredClone(f.config.jobs.maximum) } });
  f.store.transaction(tx => {
    ensurePrSchema(tx);
    mutateMonitor(tx, { kind: "pr.monitor.enable", requestId: rid(), projectId: project.id, expectedRevision: project.revision,
      payload: { repository: { host: "github.com", owner: "acme", name: "widgets" }, apiBase: "https://api.github.com", allowed: { issues: true, specs: true, ci: true }, acceptPolicyVersion: TRIGGER_POLICY_VERSION } }, epoch);
  });
  expect(count(f.store, "tasks")).toBe(0);
  expect(f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM jobs WHERE record_json LIKE '%project.status%'")!.n)).toBe(1);
  const receipts = count(f.store, "command_receipts");
  expect((await f.web(request(f, `/projects/${f.project.id}/tasks`))).status).toBe(200);
  expect((await f.web(request(f, `/api/projects/${f.project.id}/tasks`))).status).toBe(200);
  const topicPage = await (await f.web(request(f, `/projects/${f.project.id}/topics/${f.topic.id}`))).text();
  expect(topicPage).toContain("เสนอเป็นข้อผูกพัน");
  expect(topicPage).toContain("ข้อความในบทสนทนายังไม่ใช่งานที่รับรอง");
  expect(topicPage).toContain("การรับรองไม่เริ่มแก้โค้ด");
  expect(count(f.store, "tasks")).toBe(0);
  expect(count(f.store, "command_receipts")).toBe(receipts);
});

test("dismiss and cancel keep their reasons, and a later proposal is a new task", async () => {
  const f = await fixture();
  const proposed = f.app.execute(f.auth.actor, propose(f));
  expect(rejection(() => f.app.execute(f.auth.actor, { kind: "task.cancel", requestId: rid(), projectId: f.project.id, expectedRevision: proposed.task.revision, payload: { taskId: proposed.task.id, reason: "ยังไม่ได้รับรอง" } })).code).toBe("task_not_accepted");
  const dismissed = f.app.execute(f.auth.actor, { kind: "task.dismiss", requestId: rid(), projectId: f.project.id, expectedRevision: proposed.task.revision,
    payload: { taskId: proposed.task.id, proposalId: proposed.proposal.id, reason: "ยังไม่ใช่งานนี้" } });
  expect(dismissed.task).toMatchObject({ state: "dismissed", closedReason: "ยังไม่ใช่งานนี้" });
  expect(rejection(() => f.app.execute(f.auth.actor, { kind: "task.accept", requestId: rid(), projectId: f.project.id, expectedRevision: proposed.task.revision, payload: { taskId: proposed.task.id, proposalId: proposed.proposal.id } })).code).toBe("stale_revision");
  expect(rejection(() => f.app.execute(f.auth.actor, { kind: "task.edit", requestId: rid(), projectId: f.project.id, expectedRevision: proposed.task.revision, payload: { taskId: proposed.task.id, title: "เปิดใหม่", summary: "ไม่ควรได้" } })).code).toBe("stale_revision");
  const again = f.app.execute(f.auth.actor, propose(f, f.topic, { title: "ข้อเสนอใหม่" }));
  expect(again.task.id).not.toBe(proposed.task.id);
  const accepted = f.app.execute(f.auth.actor, { kind: "task.accept", requestId: rid(), projectId: f.project.id, expectedRevision: again.task.revision, payload: { taskId: again.task.id, proposalId: again.proposal.id } });
  const cancelled = f.app.execute(f.auth.actor, { kind: "task.cancel", requestId: rid(), projectId: f.project.id, expectedRevision: accepted.task.revision, payload: { taskId: again.task.id, reason: "ยกเลิกหลังตรวจ" } });
  expect(cancelled.task).toMatchObject({ state: "cancelled", closedReason: "ยกเลิกหลังตรวจ" });
  expect(cancelled.task.acceptance?.proposalId).toBe(again.proposal.id);
  expect(rejection(() => f.app.execute(f.auth.actor, { kind: "task.accept", requestId: rid(), projectId: f.project.id, expectedRevision: accepted.task.revision, payload: { taskId: again.task.id, proposalId: again.proposal.id } })).code).toBe("stale_revision");
  f.store.transaction(tx => tx.run("UPDATE sources SET availability = 'unavailable' WHERE id = ?", again.task.source.sourceId));
  const model = f.app.task(f.auth.actor, f.project.id, again.task.id);
  expect(model.source).toMatchObject({ state: "unavailable" });
  expect(count(f.store, "tasks")).toBe(2);
  const html = await (await f.web(request(f, `/projects/${f.project.id}/tasks/${again.task.id}`))).text();
  expect(html).toContain("ต้นฉบับไม่พร้อมใช้งาน");
  expect(html).toContain("ยกเลิกหลังตรวจ");
  const inactive = f.app.tasks(f.auth.actor, f.project.id).inactive.map(task => task.id);
  expect(inactive).toContain(proposed.task.id);
  expect(inactive).toContain(again.task.id);
});

test("schema v8 migrates to v9, keeps the previous project, and snapshots the old file", () => {
  const root = mkdtempSync(join(tmpdir(), "jit-task01-mig-")); roots.push(root);
  const path = join(root, "old.sqlite");
  const projectId = "22222222-2222-4222-8222-222222222222";
  const old = new Database(path);
  old.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, revision INTEGER NOT NULL, created_at INTEGER NOT NULL);
    INSERT INTO projects VALUES ('${projectId}', 'kept-task', 4, 4);
    PRAGMA user_version = 8;`);
  old.close();
  const store = new TransactionStore(path); stores.push(store);
  expect(store.read(tx => tx.get("PRAGMA user_version"))).toEqual({ user_version: 11 });
  expect(store.read(tx => tx.get("SELECT name, revision FROM projects WHERE id = ?", projectId))).toEqual({ name: "kept-task", revision: 4 });
  expect(store.read(tx => tx.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tasks'"))).toEqual({ name: "tasks" });
  const snapshotName = readdirSync(root).find(name => name.includes(".pre-v8-"))!;
  const snapshot = new Database(join(root, snapshotName), { readonly: true });
  expect(snapshot.query("PRAGMA user_version").get()).toEqual({ user_version: 8 });
  expect(snapshot.query("SELECT name FROM sqlite_master WHERE name = 'tasks'").get()).toBeNull();
  expect(snapshot.query("SELECT name FROM projects").get()).toEqual({ name: "kept-task" });
  snapshot.close();
  expect(statSync(join(root, snapshotName)).mode & 0o777).toBe(0o600);
});

test("a validated participant or decision source can be proposed; owner chat and another project cannot", async () => {
  const f = await fixture();
  const ownerMessage = f.app.execute(f.auth.actor, { kind: "message.send", projectId: f.project.id, requestId: rid(), expectedRevision: f.topic.revision, payload: { topicId: f.topic.id, text: "ข้อความของเจ้าของ" } });
  expect(rejection(() => f.app.execute(f.auth.actor, propose(f, f.topic, { expectedRevision: ownerMessage.topicRevision, source: ownerMessage.message.source }))).code).toBe("source_not_validated");
  const participant = f.store.transaction(tx => {
    const source = commitOutputSource(tx, { projectId: f.project.id, participantId: "role-1", runId: "run-1", text: "ผล specialist ที่บันทึกแล้ว", committedAt: epoch });
    tx.run(`INSERT INTO messages (id, project_id, topic_id, sequence, committed_at, attribution_json, source_id, source_revision, source_generation)
      VALUES (?, ?, ?, 9, ?, ?, ?, 1, 1)`, crypto.randomUUID(), f.project.id, f.topic.id, epoch, JSON.stringify({ kind: "participant", participantId: "role-1", runId: "run-1" }), source.sourceId);
    return source;
  });
  const fromMessage = f.app.execute(f.auth.actor, propose(f, f.topic, { expectedRevision: ownerMessage.topicRevision, title: "งานจากผลในหัวข้อ", source: participant }));
  expect(fromMessage.task.origin).toBe("validated_output");
  const decisionSource = f.store.transaction(tx => {
    const source = commitOutputSource(tx, { projectId: f.project.id, participantId: "coordinator", runId: "run-2", text: "ผลผู้ประสานงานที่อ้างอิงแล้ว", committedAt: epoch });
    const jobId = crypto.randomUUID(), contextId = crypto.randomUUID(), synthesisId = crypto.randomUUID(), discussionId = crypto.randomUUID();
    tx.run("INSERT INTO team_contexts (id, generation, state) VALUES (?, 1, 'retired')", contextId);
    tx.run("INSERT INTO jobs (id, project_id, queue_order, priority, state, occupies, route_key, record_json) VALUES (?, ?, 7, 0, 'failed', 0, 'fixture', '{}')", jobId, f.project.id);
    tx.run(`INSERT INTO coordinator_syntheses (id, project_id, topic_id, discussion_id, job_id, context_id, base_revision, state, reason, record_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, 'cancelled', 'fixture', '{}', ?, ?)`, synthesisId, f.project.id, f.topic.id, discussionId, jobId, contextId, epoch, epoch);
    tx.run(`INSERT INTO decision_proposals (id, project_id, topic_id, discussion_id, revision, synthesis_id, record_json, source_id, source_revision, source_generation, created_at)
      VALUES (?, ?, ?, ?, 1, ?, '{}', ?, 1, 1, ?)`, crypto.randomUUID(), f.project.id, f.topic.id, discussionId, synthesisId, source.sourceId, epoch);
    return source;
  });
  const topic = f.app.conversation(f.auth.actor, f.project.id, f.topic.id).topic;
  const fromDecision = f.app.execute(f.auth.actor, propose(f, topic, { title: "งานจากข้อเสนอที่ตรวจแล้ว", source: decisionSource }));
  expect(fromDecision.task.origin).toBe("validated_output");
  const other = f.app.execute(f.auth.actor, { kind: "project.create", projectId: null, requestId: rid(), expectedRevision: 1, payload: { name: "โครงการคนละที่" } }).project;
  const foreign = f.store.transaction(tx => commitOutputSource(tx, { projectId: other.id, participantId: "role-9", runId: "run-9", text: "ผลของอีกโครงการ", committedAt: epoch }));
  const mismatch = rejection(() => f.app.execute(f.auth.actor, propose(f, topic, { title: "ชี้ข้ามโครงการ", source: foreign })));
  expect(mismatch.code).toBe("project_mismatch");
  expect(mismatch.detail).toEqual({ projectId: f.project.id, path: `/projects/${f.project.id}/tasks` });
  expect(JSON.stringify(mismatch.detail)).not.toContain(other.id);
  expect(f.app.tasks(f.auth.actor, other.id).proposed).toHaveLength(0);
  const posted = await f.web(request(f, `/api/projects/${f.project.id}/tasks`, { requestId: rid(), expectedRevision: topic.revision, topicId: f.topic.id, title: "จากฟอร์ม", summary: "บันทึกข้อเสนอ", source: "{not-json" }));
  expect(posted.status).toBe(400);
  expect(await posted.json()).toEqual({ error: "invalid_body" });
});

test("owner-confirmed completion, restart, and continuity keep inactive obligations out of active work", async () => {
  const f = await fixture();
  const proposed = f.app.execute(f.auth.actor, propose(f, f.topic, { title: "งานที่จะปิด" }));
  const open = f.app.execute(f.auth.actor, { kind: "task.accept", requestId: rid(), projectId: f.project.id, expectedRevision: proposed.task.revision,
    payload: { taskId: proposed.task.id, proposalId: proposed.proposal.id } });
  const cancelled = f.app.execute(f.auth.actor, propose(f, f.topic, { title: "จะยกเลิก" }));
  const cancelledAccepted = f.app.execute(f.auth.actor, { kind: "task.accept", requestId: rid(), projectId: f.project.id, expectedRevision: cancelled.task.revision,
    payload: { taskId: cancelled.task.id, proposalId: cancelled.proposal.id } });
  f.app.execute(f.auth.actor, { kind: "task.cancel", requestId: rid(), projectId: f.project.id, expectedRevision: cancelledAccepted.task.revision,
    payload: { taskId: cancelled.task.id, reason: "ไม่ทำแล้ว" } });
  const completed = f.app.execute(f.auth.actor, { kind: "task.complete", requestId: rid(), projectId: f.project.id, expectedRevision: open.task.revision,
    payload: { taskId: open.task.id, note: "ตรวจแล้วเรียบร้อย" } });
  expect(completed.task.state).toBe("completed");
  expect(completed.task.completion?.note).toBe("ตรวจแล้วเรียบร้อย");
  const reopenedStore = new TransactionStore(f.path); stores.push(reopenedStore);
  const reopened = new Application(reopenedStore, f.config, { now: () => epoch + 1 }), actor = reopened.authenticate(f.token).actor;
  const continuity = reopened.continuity(actor, f.project.id);
  expect(continuity.activeObligations.map(task => task.id)).not.toContain(cancelled.task.id);
  expect(continuity.obligations.inactive.map(task => task.id)).toContain(cancelled.task.id);
  expect(continuity.obligations.completed.map(task => task.id)).toContain(open.task.id);
  expect(continuity.activeObligations.map(task => task.id)).not.toContain(open.task.id);
  const list = await (await f.web(request(f, `/api/projects/${f.project.id}/continuity`))).json() as typeof continuity;
  expect(list.activeObligations.map(task => task.id)).toEqual(continuity.activeObligations.map(task => task.id));
});

test("partial, failed, unknown, and stale evidence do not close a user task; owner confirmation still can", async () => {
  const f = await fixture();
  const proposed = f.app.execute(f.auth.actor, propose(f, f.topic, { title: "ปิดด้วยหลักฐาน" }));
  const accepted = f.app.execute(f.auth.actor, { kind: "task.accept", requestId: rid(), projectId: f.project.id, expectedRevision: proposed.task.revision,
    payload: { taskId: proposed.task.id, proposalId: proposed.proposal.id } });
  const taskId = accepted.task.id;
  const evidenceSource = f.store.transaction(tx => commitOutputSource(tx, { projectId: f.project.id, participantId: "review", runId: "run-review", text: "รายงาน fixture", committedAt: epoch }));
  f.store.transaction(tx => registerTaskEvidenceArtifact(tx, { taskId, projectId: f.project.id, workType: "review", outcome: "partial", source: evidenceSource, now: epoch }));
  expect(rejection(() => f.app.execute(f.auth.actor, { kind: "task.complete", requestId: rid(), projectId: f.project.id, expectedRevision: f.app.task(f.auth.actor, f.project.id, taskId).task.revision,
    payload: { taskId, evidence: [evidenceSource] } })).code).toBe("completion_evidence_partial");
  f.store.transaction(tx => registerTaskEvidenceArtifact(tx, { taskId, projectId: f.project.id, workType: "review", outcome: "failed", source: evidenceSource, now: epoch + 1 }));
  expect(f.app.task(f.auth.actor, f.project.id, taskId).task.state).toBe("accepted");
  const done = f.app.execute(f.auth.actor, { kind: "task.complete", requestId: rid(), projectId: f.project.id, expectedRevision: f.app.task(f.auth.actor, f.project.id, taskId).task.revision,
    payload: { taskId, note: "ปิดด้วยคำยืนยันของเจ้าของ" } });
  expect(done.task.state).toBe("completed");
});

test("two competing completion commands and duplicate owner confirmation share one receipt", async () => {
  const f = await fixture();
  const proposed = f.app.execute(f.auth.actor, propose(f, f.topic, { title: "แข่งปิด" }));
  const accepted = f.app.execute(f.auth.actor, { kind: "task.accept", requestId: rid(), projectId: f.project.id, expectedRevision: proposed.task.revision,
    payload: { taskId: proposed.task.id, proposalId: proposed.proposal.id } });
  const complete = { kind: "task.complete" as const, requestId: rid(), projectId: f.project.id, expectedRevision: accepted.task.revision, payload: { taskId: accepted.task.id, note: "ปิดครั้งเดียว" } };
  const first = f.app.execute(f.auth.actor, complete);
  expect(f.app.execute(f.auth.actor, complete)).toEqual(first);
  expect(rejection(() => f.app.execute(f.auth.actor, { ...complete, requestId: rid() })).code).toBe("stale_revision");
  const reopened = f.app.execute(f.auth.actor, { kind: "task.reopen", requestId: rid(), projectId: f.project.id, expectedRevision: first.task.revision,
    payload: { taskId: accepted.task.id, reason: "ต้องตรวจอีกครั้ง" } });
  expect(reopened.task.state).toBe("accepted");
  const workers = ["web", "telegram"].map(channel => new Worker(new URL("./task-race-worker.ts", import.meta.url), { workerData: { path: f.path, token: f.token, now: epoch, channel, command: {
    kind: "task.complete", requestId: rid(), projectId: f.project.id, expectedRevision: reopened.task.revision, payload: { taskId: accepted.task.id, note: "ชนะครั้งเดียว" },
  } } }));
  const messages: { ready?: boolean; ok?: boolean; message?: string }[] = [];
  await new Promise<void>((resolve, reject) => {
    let ready = 0;
    for (const worker of workers) {
      worker.on("message", message => {
        if (message.ready) { if (++ready === workers.length) for (const item of workers) item.postMessage("go"); return; }
        messages.push(message);
        if (messages.length === workers.length) resolve();
      });
      worker.on("error", reject);
    }
  });
  for (const worker of workers) worker.terminate();
  expect(messages.filter(item => item.ok)).toHaveLength(1);
  expect(messages.find(item => !item.ok)!.message).toMatch(/task_already_completed|stale_revision/);
});

async function acceptedTask(f: Fixture) {
  const p = f.app.execute(f.auth.actor, propose(f));
  return f.app.execute(f.auth.actor, { kind: "task.accept", requestId: rid(), projectId: f.project.id,
    expectedRevision: p.task.revision, payload: { taskId: p.task.id, proposalId: p.proposal.id } });
}
function taskCommand(f: Fixture, taskId: string, kind: "task.complete" | "task.set_policy" | "task.reopen", payload: object = {}): TaskCommand {
  return { kind, requestId: rid(), projectId: f.project.id, expectedRevision: f.app.task(f.auth.actor, f.project.id, taskId).task.revision,
    payload: { taskId, ...payload } } as TaskCommand;
}
function evidence(f: Fixture, taskId: string, outcome: "complete" | "partial" | "failed" | "unknown" = "complete", deliveryState?: "sent" | "failed" | "unknown", workType: "analysis" | "review" | "reminder" = "review") {
  return f.store.transaction(tx => {
    const source = commitOutputSource(tx, { projectId: f.project.id, participantId: "review", runId: rid(), text: "หลักฐาน fixture", committedAt: epoch });
    return registerTaskEvidenceArtifact(tx, { projectId: f.project.id, taskId, source, outcome, workType, deliveryState: deliveryState ?? null, now: epoch });
  });
}

test("completion and reopen fence old commands, including a stale policy change", async () => {
  const f = await fixture(), accepted = await acceptedTask(f), id = accepted.task.id;
  const oldComplete = taskCommand(f, id, "task.complete"), oldPolicy = taskCommand(f, id, "task.set_policy", { policyKind: "owner_confirmed" });
  const complete = f.app.execute(f.auth.actor, oldComplete);
  const reopened = f.app.execute(f.auth.actor, taskCommand(f, id, "task.reopen", { reason: "ตรวจอีกรอบ" }));
  expect(reopened.task.revision).toBeGreaterThan(complete.task.revision);
  expect(reopened.proposal.revision).toBe(accepted.proposal.revision);
  expect(() => f.app.execute(f.auth.actor, { ...oldComplete, requestId: rid() })).toThrow("stale_revision");
  expect(() => f.app.execute(f.auth.actor, oldPolicy)).toThrow("stale_revision");
  expect(f.app.execute(f.auth.actor, oldComplete)).toEqual(complete);
  expect(f.app.task(f.auth.actor, f.project.id, id).task.state).toBe("accepted");
});

test("evidence policy records the actual current artifact and rejects failed, unknown, superseded and stale evidence", async () => {
  const f = await fixture(), accepted = await acceptedTask(f), id = accepted.task.id;
  const artifact = evidence(f, id);
  const policy = f.app.execute(f.auth.actor, taskCommand(f, id, "task.set_policy", { policyKind: "evidence_satisfied" }));
  expect(policy.task.state).toBe("ready_for_review");
  const done = f.app.execute(f.auth.actor, taskCommand(f, id, "task.complete"));
  expect(done.task.completion?.evidence).toEqual([artifact.source]);
  f.app.execute(f.auth.actor, taskCommand(f, id, "task.reopen", { reason: "ตรวจต่อ" }));
  for (const [outcome, deliveryState, code] of [
    ["partial", undefined, "completion_evidence_partial"], ["failed", undefined, "completion_evidence_failed"],
    ["unknown", undefined, "completion_evidence_unknown"], ["complete", "failed", "completion_evidence_failed"],
    ["complete", "unknown", "completion_evidence_unknown"],
  ] as const) {
    const bad = evidence(f, id, outcome, deliveryState);
    expect(f.app.task(f.auth.actor, f.project.id, id).task.state).toBe("accepted");
    expect(() => f.app.execute(f.auth.actor, taskCommand(f, id, "task.complete", { evidence: [bad.source] }))).toThrow(code);
    expect(() => f.app.execute(f.auth.actor, taskCommand(f, id, "task.complete"))).toThrow(code);
  }
  const fresh = evidence(f, id);
  f.store.transaction(tx => tx.run("UPDATE sources SET availability = 'unavailable' WHERE id = ?", fresh.source.sourceId));
  expect(f.app.task(f.auth.actor, f.project.id, id).task.pendingReason?.kind).toBe("evidence_stale");
  expect(() => f.app.execute(f.auth.actor, taskCommand(f, id, "task.complete"))).toThrow("completion_evidence_stale");
  evidence(f, id);
  const edit = f.app.execute(f.auth.actor, { kind: "task.edit", requestId: rid(), projectId: f.project.id,
    expectedRevision: f.app.task(f.auth.actor, f.project.id, id).task.revision, payload: { taskId: id, title: "ขอบเขตใหม่", summary: "ต้องการหลักฐานใหม่" } });
  expect(edit.task.pendingReason?.kind).toBe("evidence_stale");
  expect(() => f.app.execute(f.auth.actor, taskCommand(f, id, "task.complete"))).toThrow("completion_evidence_stale");
});

test("a reminder without confirmed delivery is not complete evidence", async () => {
  const f = await fixture(), accepted = await acceptedTask(f), id = accepted.task.id;
  const artifact = evidence(f, id, "complete", undefined, "reminder");
  expect(() => f.app.execute(f.auth.actor, taskCommand(f, id, "task.complete", { evidence: [artifact.source] }))).toThrow("completion_evidence_unknown");
  expect(f.app.task(f.auth.actor, f.project.id, id).task.state).toBe("accepted");
});

test("supersession validates the successor and continuity includes topics without tasks", async () => {
  const f = await fixture(), accepted = await acceptedTask(f), successor = await acceptedTask(f);
  const topic = f.app.execute(f.auth.actor, { kind: "topic.create", requestId: rid(), projectId: f.project.id,
    expectedRevision: f.app.project(f.auth.actor, f.project.id).revision, payload: { title: "ไม่มี task แต่มีบริบท" } }).topic;
  const base = { kind: "task.supersede" as const, requestId: rid(), projectId: f.project.id, expectedRevision: accepted.task.revision,
    payload: { taskId: accepted.task.id, reason: "แทนที่แล้ว", successorTaskId: accepted.task.id } };
  expect(() => f.app.execute(f.auth.actor, base)).toThrow("invalid_task_command");
  const receipt = f.app.execute(f.auth.actor, { ...base, requestId: rid(), payload: { ...base.payload, successorTaskId: successor.task.id } });
  expect(receipt.task.supersededBy).toBe(successor.task.id);
  const continuity = f.app.continuity(f.auth.actor, f.project.id);
  expect(continuity.activeObligations.map(task => task.id)).not.toContain(accepted.task.id);
  expect(continuity.decisions.map(item => item.topicId)).toContain(topic.id);
});

test("a populated v9 store migrates without dropping proposals, events, owner receipts or foreign keys", async () => {
  const f = await fixture(), accepted = await acceptedTask(f);
  const oldPath = join(f.root, "populated-v9.sqlite"), old = new Database(oldPath);
  old.exec(readFileSync(new URL("./fixtures/foundation-v9.sql", import.meta.url), "utf8"));
  for (const table of ["owner", "sessions", "projects", "project_groups", "sources", "source_versions", "topics", "tasks", "task_proposals", "task_events", "command_receipts", "audit"]) {
    const columns = old.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
    for (const row of f.store.read(tx => tx.all<Record<string, string | number | null>>(`SELECT ${columns.map(c => c.name).join(",")} FROM ${table}`))) {
      old.query(`INSERT INTO ${table} (${columns.map(c => c.name).join(",")}) VALUES (${columns.map(() => "?").join(",")})`).run(...columns.map(c => row[c.name]!));
    }
  }
  old.close();
  const migrated = new TransactionStore(oldPath); stores.push(migrated);
  const app = new Application(migrated, { ...f.config, databasePath: oldPath }, { now: () => epoch });
  const model = app.task(app.authenticate(f.token).actor, f.project.id, accepted.task.id);
  expect(model.task.state).toBe("accepted");
  expect(model.proposals).toHaveLength(1);
  expect(model.events.map(e => e.kind)).toEqual(["proposed", "accepted"]);
  expect(migrated.read(tx => tx.all("PRAGMA foreign_key_check"))).toEqual([]);
  expect(() => migrated.transaction(tx => tx.run("DELETE FROM tasks WHERE id = ?", accepted.task.id))).toThrow();
  const snapshotPath = readdirSync(f.root).find(name => name.startsWith("populated-v9.sqlite.pre-v9-"))!;
  const snapshot = new Database(join(f.root, snapshotPath), { readonly: true });
  expect(snapshot.query("PRAGMA user_version").get()).toEqual({ user_version: 9 });
  expect(snapshot.query("SELECT state FROM tasks WHERE id = ?").get(accepted.task.id)).toEqual({ state: "accepted" });
  snapshot.close();
});

test("Web forms complete and reopen using the committed revision and text policy", async () => {
  const f = await fixture(), accepted = await acceptedTask(f), id = accepted.task.id;
  const completed = await f.web(request(f, `/projects/${f.project.id}/tasks/${id}`, { csrf: f.auth.csrf, requestId: rid(), expectedRevision: String(accepted.task.revision), mode: "complete", note: "ตรวจผ่าน" }, true));
  expect(completed.status).toBe(303);
  const model = f.app.task(f.auth.actor, f.project.id, id);
  const page = await (await f.web(request(f, `/projects/${f.project.id}/tasks/${id}`))).text();
  expect(page).toContain("ปิดเรียบร้อยแล้ว");
  expect(page).toContain("ตรวจผ่าน");
  expect(page).toContain('value="reopen"');
  const reopened = await f.web(request(f, `/projects/${f.project.id}/tasks/${id}`, { csrf: f.auth.csrf, requestId: rid(), expectedRevision: String(model.task.revision), mode: "reopen", reason: "ตรวจเพิ่ม" }, true));
  expect(reopened.status).toBe(303);
  expect(f.app.task(f.auth.actor, f.project.id, id).task.state).toBe("accepted");
});
