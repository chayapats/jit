import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Application } from "../src/application";
import { readConfig } from "../src/config";
import { TransactionStore } from "../src/store";
import { JobQueue } from "../src/jobs/queue";
import { ScriptedRunPort } from "../src/team/scripted-port";
import { scriptedPreviewWork } from "../src/team/preview";
import { discussionPlanWork, specialistAnalysisWork } from "../src/team/dispatch";
import { readRole } from "../src/team/configuration";
import { selectRoles } from "../src/team/routing";
import type { Role, TeamCommand } from "../src/team/types";
import { createWebHandler } from "../src/web";
import { markSetupComplete } from "./fixtures/setup";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0)) await fn(); });
const rid = () => crypto.randomUUID();
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "jit-archive-")), store = new TransactionStore(join(dir, "app.sqlite"));
  const config = readConfig({ JIT_DATABASE: store.path, JIT_ROLE_LIMIT: "2" });
  const port = new ScriptedRunPort(store, config.team, config.jobs.outputBytes);
  const queue = new JobQueue(store, config.jobs, [scriptedPreviewWork(store, config, port), discussionPlanWork(), specialistAnalysisWork(store, config, port)]);
  cleanups.push(async () => { queue.close(); await queue.idle(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const app = new Application(store, config, { jobs: queue });
  await app.setupOwner("fixture-owner-password"); const token = await app.login("fixture-owner-password"), auth = app.authenticate(token);
  const project = app.execute(auth.actor, { kind: "project.create", projectId: null, expectedRevision: 0, requestId: rid(), payload: { name: "Archive" } }).project;
  const topic = app.execute(auth.actor, { kind: "topic.create", projectId: project.id, expectedRevision: 1, requestId: rid(), payload: { title: "History" } }).topic;
  markSetupComplete(store);
  const save = (name: string, kind: Role["kind"] = "specialist", roleId: string | null = null) => app.execute(auth.actor, { kind: "role.save", projectId: null, requestId: rid(), expectedRevision: app.team(auth.actor).ownerRevision,
    payload: { roleId, name, kind, enabled: true, responsibility: "Review software", route: { provider: "grok", model: "fixture", authRoute: "grok" } } }).role!;
  const archive = (roleId: string): Extract<TeamCommand, { kind: "role.archive" }> => ({ kind: "role.archive", requestId: rid(), projectId: null, expectedRevision: app.team(auth.actor).ownerRevision, payload: { roleId } });
  const web = createWebHandler(app);
  const request = (path: string, body?: Record<string, string>, csrf = auth.csrf) => web(new Request(`http://localhost:3000${path}`, { method: body ? "POST" : "GET", headers: { cookie: `jit_session=${token}`, origin: "http://localhost:3000", ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}) }, ...(body ? { body: new URLSearchParams({ ...body, ...(csrf ? { csrf } : {}) }) } : {}) }));
  return { store, config, app, auth, project, topic, save, archive, queue, port, request };
}

test("archive retains identity/history, removes overrides, frees role limit and preserves receipt semantics", async () => {
  const f = await fixture(), role = f.save("Reviewer"), coordinator = f.save("Jit", "coordinator");
  f.app.execute(f.auth.actor, { kind: "route.save", projectId: f.project.id, requestId: rid(), expectedRevision: 0, payload: { roleId: role.id, route: role.route } });
  const c = f.archive(role.id), result = f.app.execute(f.auth.actor, c);
  expect(result.role).toMatchObject({ id: role.id, enabled: false, archivedAt: expect.any(Number), revision: 2 });
  expect(f.store.read(tx => readRole(tx, role.id))).toEqual(result.role!);
  expect(f.app.team(f.auth.actor).roles.map(r => r.id)).toEqual([coordinator.id]);
  expect(f.app.team(f.auth.actor, f.project.id).overrides).toEqual({});
  expect(f.app.team(f.auth.actor, f.project.id).projectRevision).toBe(1);
  expect(f.app.execute(f.auth.actor, c)).toEqual(result);
  expect(() => f.app.execute(f.auth.actor, { ...c, payload: { roleId: coordinator.id } })).toThrow("request_id_conflict");
  expect(() => f.save("Reviewer", "specialist", role.id)).toThrow("role_not_found");
  expect(() => f.app.execute(f.auth.actor, { kind: "route.save", projectId: f.project.id, requestId: rid(), expectedRevision: 1, payload: { roleId: role.id, route: role.route } })).toThrow("role_not_found");
  expect(() => f.app.execute(f.auth.actor, { kind: "access.role.restrict", projectId: f.project.id, requestId: rid(), expectedRevision: 0, payload: { roleId: role.id, level: "read" } })).toThrow("role_not_found");
  expect(() => f.app.execute(f.auth.actor, f.archive(coordinator.id))).toThrow("role_archive_coordinator");
  expect(f.save("Replacement").name).toBe("Replacement");
  expect(() => f.app.execute(f.auth.actor, { ...f.archive(coordinator.id), expectedRevision: 0 })).toThrow("stale_revision");
});

test("archive fences a queued captured preview and removes named routing without removing old discussion names", async () => {
  const f = await fixture(), role = f.save("Reviewer");
  const discussion = f.app.execute(f.auth.actor, { kind: "team.dispatch", projectId: f.project.id, requestId: rid(), expectedRevision: 2,
    payload: { topicId: f.topic.id, purpose: "Review", sources: [f.topic.source], include: [role.id], exclude: [], limits: { ...f.config.jobs.maximum } } }).discussion!;
  for (let i = 0; i < 5; i++) { f.queue.pump(); await f.queue.idle(); }
  const before = f.port.requests.length;
  const preview = f.app.execute(f.auth.actor, { kind: "role.preview", projectId: f.project.id, requestId: rid(), expectedRevision: 2,
    payload: { roleId: role.id, topicId: f.topic.id, purpose: "Captured", sources: [f.topic.source], limits: { ...f.config.jobs.maximum } } }).preview!;
  f.app.execute(f.auth.actor, f.archive(role.id));
  f.queue.pump(); await f.queue.idle(); expect(f.port.requests).toHaveLength(before);
  expect(f.app.job(f.auth.actor, f.project.id, preview.jobId).state).toBe("blocked");
  expect(f.store.read(tx => selectRoles(tx, { message: { id: rid(), sequence: 100, text: "@Reviewer ช่วยดู", replyTo: { discussionId: discussion.id, roleId: role.id } }, project: f.project, topic: f.topic, config: f.config }))).toBeNull();
  expect(await (await f.request(`/projects/${f.project.id}/team/discussions/${discussion.id}`)).text()).toContain("Reviewer");
  for (const path of ["/settings/team", `/projects/${f.project.id}/team`]) expect(await (await f.request(path)).text()).not.toContain(`id="role-${role.id}"`);
});

test("archive Web action is owner-scoped, protected by CSRF and absent for coordinators", async () => {
  const f = await fixture(), role = f.save("Reviewer"), coordinator = f.save("Jit", "coordinator");
  const page = await (await f.request("/settings/team")).text();
  expect(page.match(/action="\/team\/archive"/g)).toHaveLength(1);
  const c = f.archive(role.id), body = { requestId: c.requestId, expectedRevision: String(c.expectedRevision), roleId: role.id };
  expect((await f.request(`/projects/${f.project.id}/team/archive`, body)).status).toBe(404);
  expect((await f.request("/team/archive", body, "")).status).toBe(403);
  const response = await f.request("/team/archive", body); expect(response.status).toBe(303); expect(response.headers.get("location")).toBe("/settings/team");
  const after = await (await f.request("/settings/team")).text();
  expect(after).not.toContain(`id="role-${role.id}"`); expect(after).toContain(`id="role-${coordinator.id}"`); expect(after).not.toContain('action="/team/archive"');
});
