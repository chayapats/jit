import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Application, type OwnerActor } from "../src/application";
import { readConfig } from "../src/config";
import {
  DeliveryWorker, ScriptedTelegramSender, commitDeliveryIntent, recordDeliveryResult, type DeliveryCrashPhase,
} from "../src/delivery";
import { schemaVersion, TransactionStore } from "../src/store";
import { TelegramChannel } from "../src/telegram";
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

async function fixture(options: { beforeCommit?: (stage: "project" | "topic" | "message" | "job" | "team" | "decision" | "delivery" | "task" | "memory" | "receipt" | "schedule") => void; crash?: (phase: DeliveryCrashPhase) => void } = {}) {
  const root = mkdtempSync(join(tmpdir(), "jit-tg03-")); roots.push(root);
  const path = join(root, "app.sqlite");
  const config = readConfig({ JIT_DATABASE: path, JIT_TELEGRAM_BOT_TOKEN_PATH: join(root, "missing-bot.token") });
  const store = new TransactionStore(path); stores.push(store);
  const clock = { now: epoch };
  const sender = new ScriptedTelegramSender();
  const app = new Application(store, config, { now: () => clock.now, ...(options.beforeCommit ? { beforeCommit: options.beforeCommit } : {}) });
  await app.setupOwner(password);
  const token = await app.login(password);
  const auth = app.authenticate(token);
  const project = app.execute(auth.actor, { kind: "project.create", requestId: rid(), projectId: null, expectedRevision: 0, payload: { name: "โครงการแจ้งเตือน" } }).project;
  const telegram = new TelegramChannel(store, config, { now: () => clock.now });
  const channel = telegram.authenticate(token);
  let worker: DeliveryWorker | null = null;
  const openWorker = (crash = options.crash) => {
    worker?.close();
    worker = new DeliveryWorker(store, { sender, now: () => clock.now, ...(crash ? { crash } : {}) });
    return worker;
  };
  return { root, path, config, store, clock, app, token, auth, project, telegram, channel, sender, openWorker, web: createWebHandler(app) };
}

function bind(f: Awaited<ReturnType<typeof fixture>>, userId = 42, chatId = 77) {
  const current = f.telegram.status(f.channel).binding;
  const pending = f.telegram.execute(f.channel, {
    kind: "telegram.bind", requestId: rid(), expectedRevision: current.revision,
    payload: { telegramUserId: userId, telegramChatId: chatId },
  });
  f.telegram.execute(f.channel, {
    kind: "telegram.confirm", requestId: rid(), expectedRevision: pending.binding.revision,
    payload: { telegramUserId: userId, telegramChatId: chatId, challengeNonce: pending.binding.challengeNonce! },
  });
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

test("unbound intents wait, then a bound fenced send stores the message reference", async () => {
  const f = await fixture();
  const waiting = commit(f);
  expect(waiting.intent.status).toBe("waiting");
  expect(waiting.intent.remote).toBe("none");
  expect(waiting.intent.nextAction).toBe("wait_for_channel_binding");
  const worker = f.openWorker();
  expect(worker.pump()).toEqual([]);
  expect(f.sender.calls).toBe(0);
  expect(f.app.delivery(f.auth.actor, f.project.id, waiting.intent.id).intent.status).toBe("waiting");
  bind(f);
  expect(worker.pump()[0]?.status).toBe("sent");
  const detail = f.app.delivery(f.auth.actor, f.project.id, waiting.intent.id);
  expect(detail.intent).toMatchObject({ status: "sent", remote: "accepted", messageRef: { chatId: 77, messageId: 1 }, guarantee: "local_dedupe_only" });
  expect(detail.report.availability).toBe("available");
  expect(detail.sourceAvailable).toBe(true);
  expect(f.app.source(f.auth.actor, f.project.id, { sourceId: detail.report.sourceId, revision: 1, generation: 1 })).toMatchObject({ state: "available", text: "รายงานที่บันทึกแล้ว" });
  expect(f.sender.calls).toBe(1);
  expect(worker.pump()).toEqual([]);
  expect(f.sender.calls).toBe(1);
});

test("reopen before send still has one intent and can send", async () => {
  const f = await fixture();
  bind(f);
  const saved = commit(f);
  f.store.close();
  const store = new TransactionStore(f.path); stores.push(store);
  const app = new Application(store, f.config, { now: () => f.clock.now });
  const actor = app.authenticate(f.token).actor;
  expect(app.delivery(actor, f.project.id, saved.intent.id).intent.status).toBe("queued");
  const sender = new ScriptedTelegramSender();
  const worker = new DeliveryWorker(store, { sender, now: () => f.clock.now });
  expect(worker.pump()[0]?.status).toBe("sent");
  expect(sender.calls).toBe(1);
  expect(store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM delivery_intents")!.n)).toBe(1);
  worker.close();
});

test("reopen after claim, after remote acceptance, and before the local response commit", async () => {
  const accepted = await fixture();
  bind(accepted);
  const acceptedIntent = commit(accepted).intent.id;
  const claimed = accepted.openWorker();
  expect(claimed.claimNext()?.senderInvoked).toBe(false);
  expect(accepted.sender.calls).toBe(0);
  claimed.close();
  const claimedStore = new TransactionStore(accepted.path); stores.push(claimedStore);
  const claimedApp = new Application(claimedStore, accepted.config, { now: () => accepted.clock.now });
  const claimedActor = claimedApp.authenticate(accepted.token).actor;
  const recovered = new DeliveryWorker(claimedStore, { sender: accepted.sender, now: () => accepted.clock.now });
  expect(claimedApp.delivery(claimedActor, accepted.project.id, acceptedIntent).intent.status).toBe("queued");
  expect(recovered.pump()[0]?.status).toBe("sent");
  expect(accepted.sender.calls).toBe(1);
  recovered.close();

  for (const phase of ["after_remote_accept", "before_response_commit"] as const) {
    const f = await fixture({ crash: p => { if (p === phase) throw new Error(`crash-${phase}`); } });
    bind(f);
    const id = commit(f, `report:${phase}:0001`).intent.id;
    const worker = f.openWorker();
    expect(() => worker.pump()).toThrow(`crash-${phase}`);
    expect(f.sender.external).toHaveLength(1);
    expect(f.sender.calls).toBe(1);
    worker.close();
    const store = new TransactionStore(f.path); stores.push(store);
    const app = new Application(store, f.config, { now: () => f.clock.now });
    const actor = app.authenticate(f.token).actor;
    const worker2 = new DeliveryWorker(store, { sender: f.sender, now: () => f.clock.now });
    const detail = app.delivery(actor, f.project.id, id);
    expect(detail.intent.status).toBe("unknown");
    expect(detail.intent.remote).toBe("uncertain");
    expect(detail.intent.nextAction).toBe("inspect_unknown_then_explicit_resend");
    expect(detail.sourceAvailable).toBe(true);
    expect(worker2.pump()).toEqual([]);
    expect(f.sender.calls).toBe(1);
    expect(JSON.stringify(detail).toLowerCase()).not.toContain("exactly");
    worker2.close();
  }
});

test("timeout after accept, rejection, duplicate lease, revoke, supersede, retry limit and explicit resend", async () => {
  const timeout = await fixture();
  bind(timeout);
  timeout.sender.scripts = ["timeout_after_accept", "accept"];
  const timeoutId = commit(timeout, "report:timeout:0001", "ข้อความที่อาจซ้ำ").intent.id;
  expect(timeout.openWorker().pump()[0]).toMatchObject({ status: "unknown", remote: "uncertain" });
  expect(timeout.sender.external).toHaveLength(1);
  expect(timeout.openWorker().pump()).toEqual([]);
  expect(timeout.sender.calls).toBe(1);
  const current = timeout.app.delivery(timeout.auth.actor, timeout.project.id, timeoutId);
  const resent = timeout.app.execute(timeout.auth.actor, {
    kind: "delivery.resend", requestId: rid(), projectId: timeout.project.id, expectedRevision: current.intent.revision,
    payload: { intentId: timeoutId },
  });
  expect(resent.warning).toBe("duplicates_possible");
  expect(resent.attempt.linkedFrom).toBe(current.attempts.at(-1)?.id ?? null);
  expect(timeout.openWorker().pump()[0]?.status).toBe("sent");
  expect(timeout.sender.external).toHaveLength(2);
  expect(timeout.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM delivery_intents")!.n)).toBe(1);
  const afterResend = timeout.app.delivery(timeout.auth.actor, timeout.project.id, timeoutId);
  expect(afterResend.intent.guarantee).toBe("local_dedupe_only");
  expect(JSON.stringify(afterResend).toLowerCase()).not.toContain("exactly");
  expect(afterResend.sourceAvailable).toBe(true);

  const rejected = await fixture();
  bind(rejected);
  rejected.sender.scripts = ["reject"];
  const rejectedId = commit(rejected, "report:reject:0001").intent.id;
  expect(rejected.openWorker().pump()[0]).toMatchObject({ status: "failed", remote: "rejected", failureReason: "telegram_rejected", nextAction: "inspect_failure" });
  expect(rejected.openWorker().pump()).toEqual([]);
  expect(rejected.sender.calls).toBe(1);
  const rejectedDetail = rejected.app.delivery(rejected.auth.actor, rejected.project.id, rejectedId);
  expect(rejectedDetail.sourceAvailable).toBe(true);
  expect(JSON.stringify(rejectedDetail.report)).not.toContain("delivered");

  const leased = await fixture();
  bind(leased);
  commit(leased, "report:lease:0001");
  const holder = leased.openWorker();
  expect(() => new DeliveryWorker(leased.store, { sender: leased.sender, now: () => leased.clock.now })).toThrow("delivery_worker_unavailable");
  const first = holder.claimNext();
  const second = holder.claimNext();
  expect(first?.state).toBe("claimed");
  expect(second).toBeNull();
  expect(leased.sender.calls).toBe(0);

  const revoked = await fixture();
  bind(revoked);
  const revokedId = commit(revoked, "report:revoke:0001").intent.id;
  const revision = revoked.telegram.status(revoked.channel).binding.revision;
  revoked.telegram.execute(revoked.channel, { kind: "telegram.revoke", requestId: rid(), expectedRevision: revision, payload: {} });
  expect(revoked.openWorker().pump()).toEqual([]);
  expect(revoked.sender.calls).toBe(0);
  expect(revoked.app.delivery(revoked.auth.actor, revoked.project.id, revokedId).intent).toMatchObject({ status: "cancelled", failureReason: "binding_revoked" });

  const stale = await fixture();
  bind(stale);
  const staleSaved = commit(stale, "report:stale:0001", "รายงานที่ถูกแทนที่ระหว่างส่ง");
  stale.sender.hook = () => {
    stale.app.execute(stale.auth.actor, {
      kind: "delivery.retire", requestId: rid(), projectId: stale.project.id, expectedRevision: staleSaved.report.revision,
      payload: { reportId: staleSaved.report.id, action: "supersede" },
    });
  };
  const staleResult = stale.openWorker().pump()[0]!;
  expect(staleResult.status).toBe("sent");
  expect(staleResult.stale).toBe(true);
  expect(staleResult.staleReason).toBe("source_superseded");
  expect(staleResult.messageRef).toEqual({ chatId: 77, messageId: 1 });
  expect(JSON.stringify(staleResult).toLowerCase()).not.toContain("prevent");
  expect(stale.app.source(stale.auth.actor, stale.project.id, { sourceId: staleSaved.report.sourceId, revision: 1, generation: 1 }).state).toBe("available");

  const limited = await fixture();
  bind(limited);
  limited.sender.scripts = ["safe_failure"];
  const limitedId = commit(limited, "report:retry:0001").intent.id;
  const limitedResults = limited.openWorker().pump();
  expect(limitedResults.at(-1)).toMatchObject({ status: "failed", failureReason: "telegram_unavailable", nextAction: "safe_retry_limit_reached" });
  expect(limitedResults).toHaveLength(2);
  expect(limited.sender.calls).toBe(2);
  expect(limited.openWorker().pump()).toEqual([]);
  expect(limited.sender.calls).toBe(2);
  expect(limited.app.delivery(limited.auth.actor, limited.project.id, limitedId).attempts).toHaveLength(2);

  const late = await fixture();
  bind(late);
  const lateId = commit(late, "report:late:0001").intent.id;
  const lateWorker = late.openWorker();
  const lateAttempt = lateWorker.claimNext()!;
  late.store.transaction(tx => {
    const row = tx.get<{ record_json: string }>("SELECT record_json FROM delivery_intents WHERE id = ?", lateId)!;
    const intent = JSON.parse(row.record_json);
    intent.settledGeneration = lateAttempt.generation + 1;
    intent.status = "sent"; intent.remote = "accepted"; intent.messageRef = { chatId: 77, messageId: 9 };
    tx.run("UPDATE delivery_intents SET record_json = ? WHERE id = ?", JSON.stringify(intent), lateId);
    const kept = recordDeliveryResult(tx, lateAttempt.id, { outcome: "failed", reason: "telegram_rejected", retryable: false }, late.clock.now);
    expect(kept.messageRef).toEqual({ chatId: 77, messageId: 9 });
    expect(kept.status).toBe("sent");
  });
  expect(late.sender.calls).toBe(0);
});

test("revoked binding during an in-flight send keeps the accepted reference and a secret never lands in the store", async () => {
  const f = await fixture();
  bind(f);
  const saved = commit(f, "report:inflight:0001", "ระหว่างส่ง");
  f.sender.hook = () => {
    const revision = f.telegram.status(f.channel).binding.revision;
    f.telegram.execute(f.channel, { kind: "telegram.revoke", requestId: rid(), expectedRevision: revision, payload: {} });
  };
  const sent = f.openWorker().pump()[0]!;
  expect(sent).toMatchObject({ status: "sent", stale: true, staleReason: "binding_revoked", messageRef: { chatId: 77, messageId: 1 } });
  expect(JSON.stringify(sent).toLowerCase()).not.toContain("prevent");

  const secret = "999000:AA-SECRET-TOKEN-VALUE";
  const hidden = await fixture();
  bind(hidden);
  hidden.sender.scripts = ["throw_secret"];
  hidden.sender.secret = secret;
  const hiddenId = commit(hidden, "report:secret:0001", "ไม่มีข้อมูลลับ").intent.id;
  expect(hidden.openWorker().pump()[0]).toMatchObject({ status: "unknown", failureReason: "unknown_transport" });
  expect(hidden.openWorker().pump()).toEqual([]);
  const detail = hidden.app.delivery(hidden.auth.actor, hidden.project.id, hiddenId);
  expect(JSON.stringify(detail)).not.toContain(secret);
  const files = [hidden.path, `${hidden.path}-wal`, `${hidden.path}-shm`].filter(path => { try { return statSync(path).isFile(); } catch { return false; } });
  for (const path of files) expect(Buffer.from(await Bun.file(path).bytes()).toString("utf8")).not.toContain(secret);
  expect(JSON.stringify(saved)).not.toContain(secret);
});

test("owner inspection shows provenance and does not send; resend warns about duplicates", async () => {
  const f = await fixture();
  const body = { requestId: "web-delivery-01", expectedRevision: f.project.revision, kind: "reminder", text: "เตือน <script>alert(1)</script>", dedupeKey: "reminder:web:0001" };
  expect((await f.web(webRequest(`/api/projects/${f.project.id}/delivery`, { method: "POST", token: f.token, body }))).status).toBe(403);
  expect((await f.web(webRequest(`/api/projects/${f.project.id}/delivery`, { method: "POST", token: f.token, csrf: f.auth.csrf, origin: "https://evil.example", body }))).status).toBe(403);
  const created = await f.web(webRequest(`/api/projects/${f.project.id}/delivery`, { method: "POST", token: f.token, csrf: f.auth.csrf, body }));
  expect(created.status).toBe(200);
  const receipt = await created.json() as { intent: { id: string; status: string }; report: { sourceId: string } };
  expect(receipt.intent.status).toBe("waiting");
  const before = f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM delivery_attempts")!.n);
  const page = await f.web(webRequest(`/projects/${f.project.id}/delivery/${receipt.intent.id}`, { token: f.token }));
  const html = await page.text();
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>");
  expect(html).toContain("ไม่รับประกัน");
  expect(html).toContain(receipt.report.sourceId);
  expect(f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM delivery_attempts")!.n)).toBe(before);
  expect(f.app.delivery(f.auth.actor, f.project.id, receipt.intent.id).intent.status).toBe("waiting");
  const listed = await (await f.web(webRequest(`/api/projects/${f.project.id}/delivery`, { token: f.token }))).json() as { items: { status: string }[] };
  expect(listed.items).toHaveLength(1);
  expect(listed.items[0]!.status).toBe("waiting");
  expect(f.sender.calls).toBe(0);
  bind(f);
  f.sender.scripts = ["reject"];
  expect(f.openWorker().pump()[0]?.status).toBe("failed");
  const failed = f.app.delivery(f.auth.actor, f.project.id, receipt.intent.id);
  expect(failed.sourceAvailable).toBe(true);
  const failedHtml = await (await f.web(webRequest(`/projects/${f.project.id}/delivery/${receipt.intent.id}`, { token: f.token }))).text();
  expect(failedHtml).toContain("รายงานต้นทางยังเปิดอ่านได้");
  expect(failedHtml).toContain("การส่งอีกครั้งอาจทำให้ข้อความซ้ำ");
  const resend = await f.web(webRequest(`/api/projects/${f.project.id}/delivery/${receipt.intent.id}/resend`, {
    method: "POST", token: f.token, csrf: f.auth.csrf, body: { requestId: "web-resend-01", expectedRevision: failed.intent.revision },
  }));
  expect(resend.status).toBe(200);
  expect(await resend.json()).toMatchObject({ warning: "duplicates_possible" });
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
