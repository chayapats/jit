import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Application, type RenameProjectCommand } from "../src/application";
import { readConfig } from "../src/config";
import { TransactionStore } from "../src/store";
import { createWebHandler } from "../src/web";
import { markSetupComplete } from "./fixtures/setup";

const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach(fn => fn()));
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "jit-rename-")), store = new TransactionStore(join(dir, "app.sqlite"));
  cleanup.push(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const app = new Application(store, readConfig({ JIT_DATABASE: store.path }));
  await app.setupOwner("fixture-owner-password");
  const token = await app.login("fixture-owner-password"), auth = app.authenticate(token);
  const project = app.execute(auth.actor, { kind: "project.create", requestId: crypto.randomUUID(), projectId: null, expectedRevision: 0, payload: { name: "A" } }).project;
  markSetupComplete(store);
  const command = (name: string, expectedRevision = project.revision): RenameProjectCommand => ({ kind: "project.rename", requestId: crypto.randomUUID(), projectId: project.id, expectedRevision, payload: { name } });
  const web = createWebHandler(app);
  const request = (path: string, body?: Record<string, string>, csrf = auth.csrf) => web(new Request(`http://localhost:3000${path}`, { method: body ? "POST" : "GET", headers: { cookie: `jit_session=${token}`, origin: "http://localhost:3000", ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}) }, ...(body ? { body: new URLSearchParams({ ...body, ...(csrf ? { csrf } : {}) }) } : {}) }));
  return { store, app, auth, project, command, request };
}

test("rename preserves identity, receipt replay, no-op revisions and stale/conflicting validation", async () => {
  const f = await fixture(), c = f.command(" B ");
  const result = f.app.execute(f.auth.actor, c);
  expect(result.project).toEqual({ ...f.project, name: "B", revision: 2 });
  expect(f.app.project(f.auth.actor, f.project.id)).toEqual(result.project);
  expect(f.app.execute(f.auth.actor, c)).toEqual(result);
  expect(f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM audit WHERE command_kind = 'project.rename'")!.n)).toBe(1);
  expect(() => f.app.execute(f.auth.actor, { ...c, payload: { name: "C" } })).toThrow("request_id_conflict");
  expect(() => f.app.execute(f.auth.actor, f.command("C"))).toThrow("stale_revision");
  for (const name of ["  ", "x".repeat(201)]) expect(() => f.app.execute(f.auth.actor, f.command(name, 2))).toThrow("invalid_project_command");
  const noop = f.command("B", 2), same = f.app.execute(f.auth.actor, noop);
  expect(same).toEqual(result);
  expect(f.app.execute(f.auth.actor, noop)).toEqual(same);
});

test("rename forms escape names, reject unknown fields/CSRF, and redirect stale revisions", async () => {
  const f = await fixture(), body = { name: "<b>B</b>", requestId: crypto.randomUUID(), expectedRevision: "1" };
  const response = await f.request(`/projects/${f.project.id}/rename`, body);
  expect(response.status).toBe(303); expect(response.headers.get("location")).toBe(`/projects/${f.project.id}`);
  expect(await (await f.request(`/projects/${f.project.id}`)).text()).toContain("&lt;b&gt;B&lt;/b&gt;");
  const stale = await f.request(`/projects/${f.project.id}/rename`, { ...body, requestId: crypto.randomUUID() });
  expect(stale.headers.get("location")).toBe(`/projects/${f.project.id}#rename`);
  expect((await f.request(`/projects/${f.project.id}/rename`, { ...body, extra: "x" })).status).toBe(400);
  expect((await f.request(`/projects/${f.project.id}/rename`, body, "")).status).toBe(403);
});

test("General space cannot be renamed and never offers the form", async () => {
  const f = await fixture();
  const topic = f.app.execute(f.auth.actor, { kind: "topic.create", requestId: crypto.randomUUID(), projectId: f.project.id, expectedRevision: 1, payload: { title: "general" } }).topic;
  f.store.transaction(tx => tx.run("INSERT INTO general_space VALUES (1, ?, ?, NULL, 1)", f.project.id, topic.id));
  expect(() => f.app.execute(f.auth.actor, f.command("renamed", 2))).toThrow("general_space_rename_refused");
  expect(await (await f.request(`/projects/${f.project.id}`)).text()).not.toContain(`action="/projects/${f.project.id}/rename"`);
});
