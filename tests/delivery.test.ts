import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Application, type OwnerActor } from "../src/application";
import { readConfig } from "../src/config";
import { commitDeliveryIntent, listDeliveryAttempts, readDeliveryIntent, retireDeliveryIntent, type DeliveryIntent } from "../src/delivery";
import { schemaVersion, TransactionStore } from "../src/store";
import { createWebHandler } from "../src/web";

const password = "fixture-owner-password";
const epoch = 1_700_000_000_000;
const roots: string[] = [];
const stores: TransactionStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function rid(): string { return crypto.randomUUID(); }

async function fixture(options: { beforeCommit?: (stage: "project" | "topic" | "message" | "job" | "team" | "decision" | "delivery" | "task" | "memory" | "receipt" | "schedule") => void } = {}) {
  const root = mkdtempSync(join(tmpdir(), "jit-tg03-")); roots.push(root);
  const path = join(root, "app.sqlite");
  const config = readConfig({ JIT_DATABASE: path });
  const store = new TransactionStore(path); stores.push(store);
  const clock = { now: epoch };
  const app = new Application(store, config, { now: () => clock.now, ...(options.beforeCommit ? { beforeCommit: options.beforeCommit } : {}) });
  await app.setupOwner(password);
  const token = await app.login(password);
  const auth = app.authenticate(token);
  const project = app.execute(auth.actor, { kind: "project.create", requestId: rid(), projectId: null, expectedRevision: 0, payload: { name: "โครงการแจ้งเตือน" } }).project;
  return { root, path, config, store, clock, app, token, auth, project, web: createWebHandler(app) };
}

function commit(f: Awaited<ReturnType<typeof fixture>>, dedupeKey = "report:demo:0001", text = "รายงานที่บันทึกแล้ว", kind: "report" | "reminder" = "report", requestId = rid()) {
  const project = f.app.project(f.auth.actor, f.project.id);
  return f.app.execute(f.auth.actor, {
    kind: "delivery.commit", requestId, projectId: project.id, expectedRevision: project.revision,
    payload: { kind, text, dedupeKey },
  });
}

function webRequest(path: string, options: { method?: string; token?: string; body?: unknown; origin?: string; csrf?: string } = {}): Request {
  const headers: Record<string, string> = {};
  if (options.token) headers.cookie = `jit_session=${options.token}`;
  if (options.csrf) headers["x-csrf-token"] = options.csrf;
  if (options.body !== undefined) { headers["content-type"] = "application/json"; headers.origin = options.origin ?? "http://localhost:3000"; }
  return new Request(`http://localhost:3000${path}`, { method: options.method ?? "GET", headers, ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}) });
}

test("report and outbox intent commit or roll back together", async () => {
  let fail = false;
  const f = await fixture({ beforeCommit: stage => { if (fail && stage === "delivery") throw new Error("delivery rollback"); } });
  fail = true;
  expect(() => commit(f, "report:rollback:01")).toThrow("delivery rollback");
  expect(f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM delivery_intents")!.n)).toBe(0);
  expect(f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM delivery_reports")!.n)).toBe(0);
  expect(f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM sources")!.n)).toBe(0);
  expect(f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM command_receipts WHERE request_id LIKE '%'")!.n)).toBe(1);
  fail = false;
  expect(() => f.store.transaction(tx => {
    commitDeliveryIntent(tx, { projectId: f.project.id, kind: "reminder", text: "ต้องไม่เหลือ", dedupeKey: "reminder:rollback:01", maxBytes: 4000 }, f.clock.now);
    throw new Error("direct rollback");
  })).toThrow("direct rollback");
  expect(f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM delivery_intents")!.n)).toBe(0);
  const saved = commit(f, "report:kept:0001");
  expect(saved.created).toBe(true);
  expect(f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM delivery_intents")!.n)).toBe(1);
});

test("the same dedupe key is one logical intent and never an exactly-once claim", async () => {
  const f = await fixture();
  const first = commit(f, "report:same:0001", "ข้อความเดิม");
  const replay = f.app.execute(f.auth.actor, {
    kind: "delivery.commit", requestId: first.intent.provenance.reportId.slice(0, 8) + "-replay", projectId: f.project.id,
    expectedRevision: f.project.revision, payload: { kind: "report", text: "ข้อความเดิม", dedupeKey: "report:same:0001" },
  });
  expect(replay.created).toBe(false);
  expect(replay.intent.id).toBe(first.intent.id);
  expect(f.app.execute(f.auth.actor, {
    kind: "delivery.commit", requestId: replay.intent.provenance.reportId.slice(0, 8) + "-replay", projectId: f.project.id,
    expectedRevision: f.project.revision, payload: { kind: "report", text: "ข้อความเดิม", dedupeKey: "report:same:0001" },
  }).intent.id).toBe(first.intent.id);
  expect(() => commit(f, "report:same:0001", "ข้อความคนละฉบับ")).toThrow("delivery_dedupe_conflict");
  expect(f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM delivery_intents")!.n)).toBe(1);
  f.store.transaction(tx => {
    const again = commitDeliveryIntent(tx, { projectId: f.project.id, kind: "report", text: "ข้อความเดิม", dedupeKey: "report:same:0001", maxBytes: 4000 }, f.clock.now);
    expect(again.created).toBe(false);
    expect(again.intent.id).toBe(first.intent.id);
  });
  expect(first.intent.guarantee).toBe("local_dedupe_only");
  expect(JSON.stringify(first.intent).toLowerCase()).not.toContain("exactly");
  expect(JSON.stringify(first.report)).not.toContain("delivered");
});

test("ADR 0085: an intent is an in-app notice that nothing sends; retirement still cancels it", async () => {
  const f = await fixture();
  const saved = commit(f, "report:inapp:0001");
  expect(saved.intent).toMatchObject({ status: "waiting", remote: "none", nextAction: "in_app_only", messageRef: null, guarantee: "local_dedupe_only" });
  expect(Object.keys(saved.intent)).not.toContain("channel");
  expect(Object.keys(saved.intent)).not.toContain("bindingRevision");
  // No worker, sender or attempt exists: the intent stays visible in the app and is never claimed.
  expect(f.store.read(tx => listDeliveryAttempts(tx, saved.intent.id))).toEqual([]);
  expect(f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM delivery_worker")!.n)).toBe(0);
  const retired = f.app.execute(f.auth.actor, { kind: "delivery.retire", requestId: rid(), projectId: f.project.id, expectedRevision: saved.report.revision,
    payload: { reportId: saved.report.id, action: "supersede" } });
  expect(retired.cancelledIntentIds).toEqual([saved.intent.id]);
  expect(f.app.delivery(f.auth.actor, f.project.id, saved.intent.id).intent).toMatchObject({ status: "cancelled", failureReason: "source_superseded" });
});

test("intents stored by the removed push transport stay readable and keep their recorded outcome", async () => {
  const f = await fixture();
  const saved = commit(f, "report:legacy:0001");
  // A row written before ADR 0085: extra transport fields in the JSON record are kept and never read.
  const legacy = { ...saved.intent, status: "sent", remote: "accepted", nextAction: "inspect_sent_message", messageRef: { chatId: 77, messageId: 9 },
    bindingRevision: 3, attemptGeneration: 1, settledGeneration: 1, safeRetriesRemaining: 2, retryable: false } as DeliveryIntent;
  f.store.transaction(tx => tx.run("UPDATE delivery_intents SET record_json = ? WHERE id = ?", JSON.stringify(legacy), saved.intent.id));
  expect(f.store.read(tx => readDeliveryIntent(tx, f.project.id, saved.intent.id))).toMatchObject({ status: "sent", remote: "accepted", messageRef: { chatId: 77, messageId: 9 } });
  const html = await (await f.web(webRequest(`/projects/${f.project.id}/delivery/${saved.intent.id}`, { token: f.token }))).text();
  expect(html).toContain("77 / 9");
  expect(html).not.toContain("/resend");
  // Retirement never rewrites a recorded remote outcome; it only marks it stale.
  expect(f.store.transaction(tx => retireDeliveryIntent(tx, f.project.id, saved.intent.id, "source_superseded", f.clock.now, { markSettledStale: true }))).toBe("marked_stale");
  expect(f.store.read(tx => readDeliveryIntent(tx, f.project.id, saved.intent.id))).toMatchObject({ status: "sent", remote: "accepted", stale: true });
});

test("owner inspection shows provenance and never sends; there is no resend command", async () => {
  const f = await fixture();
  const body = { requestId: "web-delivery-01", expectedRevision: f.project.revision, kind: "reminder", text: "เตือน <script>alert(1)</script>", dedupeKey: "reminder:web:0001" };
  expect((await f.web(webRequest(`/api/projects/${f.project.id}/delivery`, { method: "POST", token: f.token, body }))).status).toBe(403);
  expect((await f.web(webRequest(`/api/projects/${f.project.id}/delivery`, { method: "POST", token: f.token, csrf: f.auth.csrf, origin: "https://evil.example", body }))).status).toBe(403);
  const created = await f.web(webRequest(`/api/projects/${f.project.id}/delivery`, { method: "POST", token: f.token, csrf: f.auth.csrf, body }));
  expect(created.status).toBe(200);
  const receipt = await created.json() as { intent: { id: string; status: string; revision: number }; report: { sourceId: string } };
  expect(receipt.intent.status).toBe("waiting");
  const page = await f.web(webRequest(`/projects/${f.project.id}/delivery/${receipt.intent.id}`, { token: f.token }));
  const html = await page.text();
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>");
  expect(html).toContain("ไม่มีช่องทาง push");
  expect(html).toContain(receipt.report.sourceId);
  expect(html).not.toContain("/resend");
  expect(f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM delivery_attempts")!.n)).toBe(0);
  expect(f.app.delivery(f.auth.actor, f.project.id, receipt.intent.id).intent.status).toBe("waiting");
  const listed = await (await f.web(webRequest(`/api/projects/${f.project.id}/delivery`, { token: f.token }))).json() as { items: { status: string }[] };
  expect(listed.items).toHaveLength(1);
  expect(listed.items[0]!.status).toBe("waiting");
  const resend = await f.web(webRequest(`/api/projects/${f.project.id}/delivery/${receipt.intent.id}/resend`, {
    method: "POST", token: f.token, csrf: f.auth.csrf, body: { requestId: "web-resend-01", expectedRevision: receipt.intent.revision },
  }));
  expect(resend.status).toBe(404);
  expect(() => f.app.execute(f.auth.actor, { kind: "delivery.resend", requestId: rid(), projectId: f.project.id, expectedRevision: receipt.intent.revision,
    payload: { intentId: receipt.intent.id } } as never)).toThrow();
  expect(() => f.app.execute({ ownerId: "owner", channel: "web" } as OwnerActor, {
    kind: "delivery.commit", requestId: rid(), projectId: f.project.id, expectedRevision: f.project.revision,
    payload: { kind: "report", text: "ไม่ควรผ่าน", dedupeKey: "report:forged:0001" },
  })).toThrow("authentication_required");
});

test("schema v6 migrates to v9 with a private snapshot and leaves the previous project row", async () => {
  const root = mkdtempSync(join(tmpdir(), "jit-tg03-mig-")); roots.push(root);
  const path = join(root, "old.sqlite");
  const projectId = "11111111-1111-4111-8111-111111111111";
  const old = new Database(path);
  old.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, revision INTEGER NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE sources (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL, current_revision INTEGER NOT NULL, generation INTEGER NOT NULL, availability TEXT NOT NULL, UNIQUE (project_id, id));
    CREATE TABLE topics (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, UNIQUE (project_id, id));
    CREATE TABLE messages (id TEXT PRIMARY KEY);
    INSERT INTO projects VALUES ('${projectId}', 'kept', 1, 1);
    PRAGMA user_version = 6;`);
  old.close();
  const store = new TransactionStore(path); stores.push(store);
  expect(store.read(tx => tx.get("PRAGMA user_version"))).toEqual({ user_version: schemaVersion });
  expect(store.read(tx => tx.get("SELECT name FROM projects WHERE id = ?", projectId))).toEqual({ name: "kept" });
  expect(store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM delivery_intents")!.n)).toBe(0);
  const snapshot = new Database(join(root, readdirSync(root).find(name => name.includes(".pre-v6-"))!), { readonly: true });
  expect(snapshot.query("PRAGMA user_version").get()).toEqual({ user_version: 6 });
  expect(snapshot.query("SELECT name FROM projects").get()).toEqual({ name: "kept" });
  snapshot.close();
  expect(statSync(join(root, readdirSync(root).find(name => name.includes(".pre-v6-"))!)).mode & 0o777).toBe(0o600);
});
