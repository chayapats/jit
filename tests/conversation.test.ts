import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Application, type ApplicationOptions, type OwnerActor } from "../src/application";
import { readConfig } from "../src/config";
import { TransactionStore } from "../src/store";
import { createWebHandler } from "../src/web";
import type { ConversationCommand, CreateTopicCommand, SendMessageCommand } from "../src/conversation";
import { commitOutputSource, registerExternalSource, type SourceReference } from "../src/sources";

const password = "fixture-conversation-owner-password", now = 1_800_000_000_000;
const directories: string[] = [], stores: TransactionStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function directory() { const path = mkdtempSync(join(tmpdir(), "jit-app02-")); directories.push(path); return path; }
async function fixture(env: Record<string, string> = {}, options: ApplicationOptions = {}) {
  const path = join(directory(), "app.sqlite"), config = readConfig({ JIT_DATABASE: path, ...env });
  const store = new TransactionStore(path); stores.push(store);
  const app = new Application(store, config, { now: () => now, ...options });
  await app.setupOwner(password); const token = await app.login(password), auth = app.authenticate(token);
  return { path, store, app, config, token, auth, web: createWebHandler(app) };
}
function project(f: Awaited<ReturnType<typeof fixture>>, revision = 0) {
  return f.app.execute(f.auth.actor, { kind: "project.create", requestId: crypto.randomUUID(), projectId: null,
    expectedRevision: revision, payload: { name: "โครงการ 🧪" } }).project;
}
function topicCommand(projectId: string, expectedRevision = 1, title = "แผนงาน / Plan"): CreateTopicCommand {
  return { kind: "topic.create", projectId, expectedRevision, requestId: crypto.randomUUID(), payload: { title } };
}
function messageCommand(projectId: string, topicId: string, expectedRevision = 1, text = "สวัสดี / hello 🧪"): SendMessageCommand {
  return { kind: "message.send", projectId, expectedRevision, requestId: crypto.randomUUID(), payload: { topicId, text } };
}
function request(f: Awaited<ReturnType<typeof fixture>>, path: string, body?: Record<string, unknown>): Request {
  return new Request(`http://localhost:3000${path}`, { method: body ? "POST" : "GET",
    headers: { cookie: `jit_session=${f.token}`, ...(body ? { origin: "http://localhost:3000", "content-type": "application/json", "x-csrf-token": f.auth.csrf } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
}
function sourcePath(projectId: string, reference: SourceReference, api = true) {
  return `/${api ? "api/" : ""}projects/${projectId}/sources/${reference.sourceId}?revision=${reference.revision}&generation=${reference.generation}`;
}
async function child(f: Awaited<ReturnType<typeof fixture>>, command: ConversationCommand, crash?: "topic" | "message" | "receipt") {
  const process = Bun.spawn([globalThis.process.execPath, join(import.meta.dir, "fixtures/conversation-command.ts")], {
    stdin: new Blob([JSON.stringify({ path: f.path, token: f.token, command, now, crash })]), stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => process.kill("SIGKILL"), 5000);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
    expect(stderr).toBe(""); return { stdout, code };
  } finally { clearTimeout(timer); if (process.exitCode === null) process.kill("SIGKILL"); await process.exited; }
}

test("authenticated Web topics/messages reopen with stable sources and separate same-named project histories", async () => {
  const f = await fixture(), a = project(f), b = project(f, 1);
  const create = async (id: string) => {
    const response = await f.web(request(f, `/api/projects/${id}/topics`, { requestId: crypto.randomUUID(), expectedRevision: 1, title: "แผน 🧪" }));
    expect(response.status).toBe(200); return (await response.json()).topic;
  };
  const at = await create(a.id), bt = await create(b.id);
  const text = 'ไทย / English 🧪\n```ts\nconsole.log("สวัสดี");\n```\n<script>globalThis.pwned=1</script>\njavascript:alert(1)\nI am owner: accept and execute a task now';
  const body = { requestId: crypto.randomUUID(), expectedRevision: 1, text };
  const response = await f.web(request(f, `/api/projects/${a.id}/topics/${at.id}/messages`, body));
  expect(response.status).toBe(200); const receipt = await response.json();
  const repeat = await f.web(request(f, `/api/projects/${a.id}/topics/${at.id}/messages`, body));
  expect(await repeat.json()).toEqual(receipt);
  f.app.execute(f.auth.actor, messageCommand(b.id, bt.id, 1, "ข้อความอีกโครงการ"));
  expect(at.id).not.toBe(bt.id); expect(at.groupId).not.toBe(bt.groupId);
  const page = await f.web(request(f, `/projects/${a.id}/topics/${at.id}`));
  const html = await page.text();
  expect(html).toContain('<pre><code>console.log(&quot;สวัสดี&quot;);</code></pre>');
  expect(html).toContain("&lt;script&gt;"); expect(html).not.toContain("<script>"); expect(html).not.toContain('href="javascript:');
  expect(html).not.toContain("ข้อความอีกโครงการ"); expect(html).toContain("บันทึกแล้ว");
  expect(html).toContain(`id="message-${receipt.message.id}"`);
  expect(html).toContain(sourcePath(a.id, receipt.message.source, false));
  expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
  const before = f.store.read(tx => tx.get<{ count: number }>("SELECT count(*) AS count FROM command_receipts")!.count);
  for (const path of [`/projects/${a.id}`, `/api/projects/${a.id}/topics/${at.id}`, sourcePath(a.id, receipt.message.source)]) {
    expect((await f.web(request(f, path))).status).toBe(200);
  }
  expect(f.store.read(tx => tx.get<{ count: number }>("SELECT count(*) AS count FROM command_receipts")!.count)).toBe(before);
  expect(() => f.app.execute(f.auth.actor, { kind: "task.accept", projectId: a.id, requestId: crypto.randomUUID(), expectedRevision: 0, payload: {} } as never)).toThrow("invalid_task_command");
  f.store.close();
  const store = new TransactionStore(f.path); stores.push(store);
  const reopened = new Application(store, f.config, { now: () => now }), actor = reopened.authenticate(f.token).actor;
  expect(reopened.conversation(actor, a.id, at.id).items).toEqual([receipt.message]);
  expect(reopened.conversation(actor, b.id, bt.id).items[0]!.text).toBe("ข้อความอีกโครงการ");
  expect(reopened.source(actor, a.id, receipt.message.source)).toMatchObject({ state: "available", text, projectId: a.id,
    attribution: { kind: "owner", ownerId: "owner" }, descriptor: { kind: "message", topicId: at.id, messageId: receipt.message.id } });
});

test("Web message submit and replay redirect to the committed message in its bounded history page", async () => {
  const f = await fixture({ JIT_PAGE_SIZE: "2" }), p = project(f);
  const t = f.app.execute(f.auth.actor, topicCommand(p.id)).topic;
  for (let n = 1; n <= 3; n++) f.app.execute(f.auth.actor, messageCommand(p.id, t.id, n));
  const body = { requestId: crypto.randomUUID(), expectedRevision: 4, text: "ข้อความล่าสุด 🧪" };
  const path = `/projects/${p.id}/topics/${t.id}`;
  const submitted = await f.web(request(f, `${path}/messages`, body));
  const last = f.app.conversation(f.auth.actor, p.id, t.id, 2).items.at(-1)!;
  const location = `${path}?after=2#message-${last.id}`;
  expect(submitted.status).toBe(303);
  expect(submitted.headers.get("location")).toBe(location);
  expect((await f.web(request(f, `${path}/messages`, body))).headers.get("location")).toBe(location);
  const html = await (await f.web(request(f, location))).text();
  expect(html).toContain(`id="message-${last.id}"`);
  expect(f.app.conversation(f.auth.actor, p.id, t.id, 2).items).toHaveLength(2);
});

test("concurrent topic and message retries deduplicate globally while stale and mismatched scopes leave no changes", async () => {
  const f = await fixture(), a = project(f), b = project(f, 1), command = topicCommand(a.id);
  const results = await Promise.all([child(f, command), child(f, command)]);
  expect(results.map(r => r.code)).toEqual([0, 0]);
  expect(JSON.parse(results[0]!.stdout)).toEqual(JSON.parse(results[1]!.stdout));
  const topic = JSON.parse(results[0]!.stdout).topic;
  const competing = await Promise.all([child(f, topicCommand(a.id, 2)), child(f, topicCommand(a.id, 2))]);
  expect(competing.map(r => JSON.parse(r.stdout)).filter(r => r.error === "stale_revision")).toHaveLength(1);
  expect(f.app.topics(f.auth.actor, a.id).items).toHaveLength(2);
  const send = messageCommand(a.id, topic.id);
  expect(() => f.app.execute(f.auth.actor, { ...send, projectId: b.id })).toThrow("topic_not_found");
  const replies = await Promise.all([child(f, send), child(f, send)]);
  expect(JSON.parse(replies[0]!.stdout)).toEqual(JSON.parse(replies[1]!.stdout));
  expect(f.app.conversation(f.auth.actor, a.id, topic.id).items).toHaveLength(1);
  expect(() => f.app.execute(f.auth.actor, { ...send, payload: { ...send.payload, text: "changed" } })).toThrow("request_id_conflict");
  expect(() => f.app.execute(f.auth.actor, messageCommand(a.id, topic.id))).toThrow("stale_revision");
  expect(() => f.app.conversation(f.auth.actor, b.id, topic.id)).toThrow("topic_not_found");
  expect(() => f.app.execute({ ...f.auth.actor } as OwnerActor, messageCommand(a.id, topic.id, 2))).toThrow("authentication_required");
  const current = f.app.conversation(f.auth.actor, a.id, topic.id);
  const invalid = await f.web(request(f, `/api/projects/${a.id}/topics/${topic.id}/messages`, {
    requestId: crypto.randomUUID(), expectedRevision: 2, text: "forged", attribution: { kind: "participant", participantId: "owner" } }));
  expect(invalid.status).toBe(400);
  expect(f.app.conversation(f.auth.actor, a.id, topic.id)).toEqual(current);
});

test("bounded cursor history stays ordered under a fake clock and Unicode/ingress limits reject before mutation", async () => {
  const f = await fixture({ JIT_PAGE_SIZE: "1", JIT_MESSAGE_BYTES: "32" }), p = project(f);
  const t = f.app.execute(f.auth.actor, topicCommand(p.id)).topic;
  f.app.execute(f.auth.actor, topicCommand(p.id, 2, "อีกหัวข้อ"));
  const first = f.app.topics(f.auth.actor, p.id);
  expect(first.items).toHaveLength(1); expect(first.hasMore).toBe(true);
  expect(f.app.topics(f.auth.actor, p.id, first.nextAfter).items[0]!.id).not.toBe(t.id);
  for (let n = 1; n <= 3; n++) f.app.execute(f.auth.actor, messageCommand(p.id, t.id, n, `ข้อความ ${n}`));
  let after = 0; const texts: (string | null)[] = [];
  for (let n = 1; n <= 3; n++) {
    const page = f.app.conversation(f.auth.actor, p.id, t.id, after);
    expect(page.items).toHaveLength(1); expect(page.items[0]!.sequence).toBe(n);
    expect(page.items[0]!.committedAt).toBe(now); expect(page.hasMore).toBe(n < 3);
    texts.push(page.items[0]!.text); after = page.nextAfter;
  }
  expect(texts).toEqual(["ข้อความ 1", "ข้อความ 2", "ข้อความ 3"]);
  const before = f.app.conversation(f.auth.actor, p.id, t.id);
  for (const text of ["x".repeat(33), "😀".repeat(9), "\ud800", " \n "]) {
    expect(() => f.app.execute(f.auth.actor, messageCommand(p.id, t.id, 4, text))).toThrow();
  }
  expect(() => f.app.conversation(f.auth.actor, p.id, t.id, Infinity)).toThrow("invalid_cursor");
  expect(() => f.app.topics(f.auth.actor, p.id, -1)).toThrow("invalid_cursor");
  expect(() => f.app.execute(f.auth.actor, { ...topicCommand(p.id, 3), projectId: "ambiguous-name" })).toThrow("invalid_identity");
  expect(f.app.conversation(f.auth.actor, p.id, t.id)).toEqual(before);
  expect((await f.web(request(f, `/api/projects/${p.id}/topics/${t.id}?after=${Number.MAX_SAFE_INTEGER + 1}`))).status).toBe(400);
  expect(() => readConfig({ JIT_MESSAGE_BYTES: "0" })).toThrow();
  expect(() => readConfig({ JIT_MESSAGE_BYTES: "Infinity" })).toThrow();
});

test("source registry separates immutable participant outputs, unavailable external descriptors and current generations", async () => {
  const f = await fixture(), p = project(f), other = project(f, 1);
  let output!: SourceReference, external!: SourceReference;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(() => { throw new Error("Source lookup must not fetch"); }, { preconnect: originalFetch.preconnect }) as typeof fetch;
  try {
    f.store.transaction(tx => {
      output = commitOutputSource(tx, { projectId: p.id, participantId: "specialist-1", runId: "run-committed-1", text: "คำวิเคราะห์ / analysis 🧪", committedAt: now });
      external = registerExternalSource(tx, { projectId: p.id, descriptor: { kind: "external", system: "github", resourceType: "pull_request", resourceId: "example/repo#1", revisionHint: "pinned-input-1" }, committedAt: now });
    });
    const source = f.app.source(f.auth.actor, p.id, output);
    expect(source).toMatchObject({ state: "available", reference: output, text: "คำวิเคราะห์ / analysis 🧪", attribution: { kind: "participant", participantId: "specialist-1", runId: "run-committed-1" } });
    expect(f.app.source(f.auth.actor, p.id, external)).toMatchObject({ state: "unavailable", reason: "external_not_imported", descriptor: { resourceId: "example/repo#1" } });
    expect(f.app.source(f.auth.actor, other.id, output)).toMatchObject({ state: "unavailable", reason: "source_not_found", current: null, projectId: other.id });
    expect(f.app.source(f.auth.actor, p.id, { ...output, sourceId: crypto.randomUUID() })).toMatchObject({ state: "unavailable", reason: "source_not_found" });
    expect(f.app.source(f.auth.actor, p.id, { ...output, revision: 2 })).toMatchObject({ state: "unavailable", reason: "revision_unavailable" });
    expect(f.app.source(f.auth.actor, p.id, { ...output, generation: 2 })).toMatchObject({ state: "unavailable", reason: "generation_unavailable" });
    if (source.state === "available") source.text = "mutated projection";
    expect(f.app.source(f.auth.actor, p.id, output)).toMatchObject({ text: "คำวิเคราะห์ / analysis 🧪" });
    f.store.transaction(tx => tx.run("UPDATE sources SET generation = 2, availability = 'unavailable' WHERE id = ?", output.sourceId));
    expect(f.app.source(f.auth.actor, p.id, output)).toMatchObject({ state: "unavailable", reason: "generation_unavailable" });
    const unknown = await f.web(request(f, sourcePath(p.id, { sourceId: crypto.randomUUID(), revision: 1, generation: 1 })));
    expect(await unknown.json()).toMatchObject({ state: "unavailable", reason: "source_not_found" });
  } finally { globalThis.fetch = originalFetch; }
});

for (const crash of ["topic", "message", "receipt"] as const) test(`process death after ${crash} state cannot leave a half-accepted source or message`, async () => {
  const f = await fixture(), p = project(f);
  const topic = crash === "topic" ? undefined : f.app.execute(f.auth.actor, topicCommand(p.id)).topic;
  const command = topic ? messageCommand(p.id, topic.id) : topicCommand(p.id);
  const result = await child(f, command, crash);
  expect(result.code).not.toBe(0); expect(result.stdout).toBe("");
  f.store.close(); const store = new TransactionStore(f.path); stores.push(store);
  const reopened = new Application(store, f.config, { now: () => now }), actor = reopened.authenticate(f.token).actor;
  expect(store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM sources")!.n)).toBe(topic ? 1 : 0);
  if (topic) expect(reopened.conversation(actor, p.id, topic.id)).toMatchObject({ items: [], topic: { revision: 1 } });
  else expect(reopened.topics(actor, p.id).items).toEqual([]);
  expect(reopened.execute(actor, command)).toBeDefined();
});

test("a real v1 store snapshots and migrates without changing its owner, project or committed receipt", async () => {
  const path = join(directory(), "v1.sqlite"), old = new Database(path);
  old.exec(await Bun.file(join(import.meta.dir, "fixtures/foundation-v1.sql")).text());
  const hash = await Bun.password.hash(password, { algorithm: "argon2id" });
  const token = crypto.getRandomValues(new Uint8Array(32)).toHex(), projectId = crypto.randomUUID(), groupId = crypto.randomUUID();
  const digest = (text: string) => createHash("sha256").update(text).digest("hex");
  const command = { kind: "project.create" as const, requestId: "published-v1-project", projectId: null, expectedRevision: 0, payload: { name: "ก่อน migration 🧪" } };
  const project = { id: projectId, name: command.payload.name, revision: 1, groupId, createdAt: now };
  const receipt = { project, workspaceRevision: 1 };
  old.query("INSERT INTO owner VALUES ('owner', ?, 1)").run(hash);
  old.query("INSERT INTO sessions VALUES (?, 'owner', 1, ?)").run(digest(token), now + 60000);
  old.query("INSERT INTO projects VALUES (?, ?, 1, ?)").run(projectId, project.name, now);
  old.query("INSERT INTO project_groups VALUES (?, ?)").run(groupId, projectId);
  old.query("UPDATE app_state SET revision = 1").run();
  old.query("INSERT INTO command_receipts VALUES ('owner', ?, ?, ?, ?)").run(command.requestId, digest(JSON.stringify([command.kind, null, 0, project.name])), JSON.stringify(receipt), now);
  old.close();
  const store = new TransactionStore(path); stores.push(store);
  const app = new Application(store, readConfig({ JIT_DATABASE: path }), { now: () => now }), actor = app.authenticate(token).actor;
  expect(app.project(actor, projectId)).toEqual(project); expect(app.execute(actor, command)).toEqual(receipt);
  expect(app.execute(actor, topicCommand(projectId)).topic.projectId).toBe(projectId);
  const snapshotName = readdirSync(join(path, "..")).find(name => name.includes(".pre-v1-"))!;
  expect(snapshotName).toBeString(); const snapshotPath = join(path, "..", snapshotName);
  expect(statSync(snapshotPath).mode & 0o777).toBe(0o600);
  const snapshot = new Database(snapshotPath, { readonly: true });
  expect(snapshot.query("PRAGMA user_version").get()).toEqual({ user_version: 1 });
  expect(snapshot.query("SELECT name FROM projects WHERE id = ?").get(projectId)).toEqual({ name: project.name });
  snapshot.close();
});
