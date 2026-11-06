import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Application } from "../src/application";
import { readConfig } from "../src/config";
import { captureBackupImage } from "../src/ops/backup";
import { TransactionStore, schemaVersion } from "../src/store";
import { createWebHandler } from "../src/web";
import { parseServiceConfig, serviceEnvironment, type ServiceConfig } from "../ops/package/service-config";
import { composedFixture } from "./fixtures/s15-composition";

// ADR 0085 / NOTIFY16-01: Telegram is gone, but installed stores keep its tables and rows. They stay inert: nothing reads,
// migrates or drops them, and opening, backup and restore keep working without any Telegram transport.

const roots: string[] = [], stores: TransactionStore[] = [];
const s15: Awaited<ReturnType<typeof composedFixture>>[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const f of s15.splice(0)) await f.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const epoch = 1_800_000_000_000, origin = "http://localhost:3000", password = "fixture-notify16-owner-password";
const nonce = "inert-challenge-nonce-0001";
const rid = () => crypto.randomUUID();

/** A schema 32 installation whose Telegram channel was bound and used before the removal. */
function legacyInstallation(): string {
  const root = mkdtempSync(join(tmpdir(), "jit-notify16-")); roots.push(root);
  const path = join(root, "state.sqlite");
  const old = new Database(path);
  old.exec(readFileSync(new URL("./fixtures/foundation-v32.sql", import.meta.url), "utf8"));
  old.exec(`UPDATE telegram_binding SET revision = 3, state = 'pending', telegram_user_id = 42, telegram_chat_id = 77, challenge_nonce = '${nonce}', challenge_expires_at = ${epoch + 900_000} WHERE id = 1;
    UPDATE telegram_poll SET next_offset = 12, last_poll_at = ${epoch} WHERE id = 1;
    INSERT INTO telegram_inbox (update_id, telegram_user_id, telegram_chat_id, message_id, callback_id, content_kind, classification, binding_revision, text_content, raw_json, status, failure_reason, process_attempts, committed_at, processed_at)
      VALUES (11, 42, 77, 5, NULL, 'text', 'authorized_owner', 3, 'สวัสดี', '{}', 'processed', NULL, 1, ${epoch}, ${epoch});
    CREATE TABLE telegram_control_replies (sequence INTEGER PRIMARY KEY REFERENCES telegram_inbox(sequence), text TEXT NOT NULL, status TEXT NOT NULL,
      binding_revision INTEGER NOT NULL, owner_generation INTEGER NOT NULL, chat_id INTEGER NOT NULL, attempts INTEGER NOT NULL, deadline INTEGER NOT NULL, message_id INTEGER, reason TEXT);
    INSERT INTO telegram_control_replies VALUES (1, 'ok', 'sent', 3, 1, 77, 1, ${epoch}, 6, NULL);
    CREATE TABLE telegram_project_context (telegram_chat_id INTEGER PRIMARY KEY, revision INTEGER NOT NULL, binding_revision INTEGER NOT NULL, project_id TEXT NOT NULL, topic_id TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE telegram_callback_refs (id TEXT PRIMARY KEY, telegram_chat_id INTEGER NOT NULL, binding_revision INTEGER NOT NULL, record_json TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    INSERT INTO telegram_callback_refs VALUES ('callback-ref-0001', 77, 3, '{}', ${epoch}, ${epoch + 60_000});
    CREATE TABLE telegram_message_commands (telegram_chat_id INTEGER NOT NULL, message_id INTEGER NOT NULL, record_json TEXT NOT NULL, committed_at INTEGER NOT NULL, PRIMARY KEY (telegram_chat_id, message_id));`);
  old.close();
  return path;
}

const inert = (db: Database) => ({
  binding: db.query("SELECT state, telegram_chat_id AS chat, challenge_nonce AS nonce FROM telegram_binding WHERE id = 1").get(),
  inbox: (db.query("SELECT count(*) AS n FROM telegram_inbox").get() as { n: number }).n,
  callbacks: (db.query("SELECT count(*) AS n FROM telegram_callback_refs").get() as { n: number }).n,
});

test("legacy runtime: a store with Telegram tables and rows migrates, serves, backs up and restores; the rows stay inert", async () => {
  const path = legacyInstallation();
  const store = new TransactionStore(path); stores.push(store);
  expect(store.read(tx => tx.get("PRAGMA user_version"))).toEqual({ user_version: schemaVersion });
  // A saved Telegram notification level from before the removal is kept and never read.
  store.transaction(tx => tx.run("INSERT INTO attention_levels (channel, level, revision, updated_at) VALUES ('telegram', 'all', 1, ?)", epoch));
  const app = new Application(store, readConfig({ JIT_DATABASE: path }), { now: () => epoch });
  await app.setupOwner(password);
  const token = await app.login(password), auth = app.authenticate(token);
  expect(app.attentionLevels(auth.actor)).toEqual({ web: { channel: "web", level: "needs-me", revision: 0, updatedAt: null } });
  // Delivery is in-app only: no worker, attempt or binding is involved.
  const project = app.execute(auth.actor, { kind: "project.create", requestId: rid(), projectId: null, expectedRevision: app.workspace(auth.actor).revision, payload: { name: "โครงการเดิม" } }).project;
  const saved = app.execute(auth.actor, { kind: "delivery.commit", requestId: rid(), projectId: project.id, expectedRevision: project.revision,
    payload: { kind: "report", text: "รายงานหลังเลิกใช้ช่องทางเดิม", dedupeKey: "report:notify16:0001" } });
  expect(saved.intent).toMatchObject({ status: "waiting", nextAction: "in_app_only", remote: "none" });
  expect(store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM delivery_attempts")!.n)).toBe(0);
  // The settings page for the removed channel is gone; notifications live in the app.
  const web = createWebHandler(app);
  const get = (url: string) => web(new Request(`${origin}${url}`, { headers: { cookie: `jit_session=${token}` } }));
  expect((await get("/settings/telegram")).status).toBe(404);
  expect((await get("/settings/notifications")).status).toBe(200);
  // Nothing touched the inert rows.
  const live = new Database(path, { readonly: true });
  try {
    expect(inert(live)).toEqual({ binding: { state: "pending", chat: 77, nonce }, inbox: 1, callbacks: 1 });
    expect(live.query("SELECT channel, level FROM attention_levels").all()).toEqual([{ channel: "telegram", level: "all" }]);
  } finally { live.close(); }
  // Backup: every inert table is classified, the pending nonce is scrubbed and per-chat references never enter the image.
  const image = store.read(tx => captureBackupImage(tx, store));
  expect(image.scrubbed).toContain("telegram_binding.challenge_nonce");
  expect(image.excludedTables).toEqual(expect.arrayContaining(["telegram_callback_refs", "telegram_control_replies", "telegram_message_commands", "telegram_project_context"]));
  expect(Buffer.from(image.bytes).includes(Buffer.from(nonce))).toBe(false);
  // Restore: the image opens with the current runtime and the app serves from it.
  const restoredPath = join(roots.at(-1)!, "restored.sqlite");
  writeFileSync(restoredPath, image.bytes, { mode: 0o600 });
  const restored = new TransactionStore(restoredPath); stores.push(restored);
  expect(restored.read(tx => tx.get("PRAGMA user_version"))).toEqual({ user_version: schemaVersion });
  expect(restored.read(tx => tx.get("SELECT name FROM projects WHERE id = ?", project.id))).toEqual({ name: "โครงการเดิม" });
  expect(restored.read(tx => tx.get("SELECT state, challenge_nonce AS nonce FROM telegram_binding WHERE id = 1"))).toEqual({ state: "pending", nonce: null });
  const restoredApp = new Application(restored, readConfig({ JIT_DATABASE: restoredPath }), { now: () => epoch });
  await restoredApp.setupOwner(password);
  const restoredAuth = restoredApp.authenticate(await restoredApp.login(password));
  expect(restoredApp.delivery(restoredAuth.actor, project.id, saved.intent.id).intent).toMatchObject({ status: "waiting", nextAction: "in_app_only" });
});

test("service package: an installed config that still names the Telegram channel is accepted and ignored", () => {
  const root = mkdtempSync(join(tmpdir(), "jit-notify16-config-")); roots.push(root);
  const service = { serviceUser: "jit-service", executablePath: join(root, "opt", "current"), workingDirectory: join(root, "work"),
    stateDirectory: join(root, "state"), ledgerPath: join(root, "state", "ledger.json"), backupDirectory: join(root, "backup"),
    routes: [{ route: "codex-subscription", model: "gpt-fixture", configured: true }],
    secretRefs: [{ name: "telegram-bot-token", store: "credential-file", key: join(root, "telegram-bot.token") }],
    network: { bindHost: "127.0.0.1", port: 3443, vpnInterface: null },
    resources: { memoryMaxBytes: 536870912, maxRestarts: 3, restartWindowSeconds: 300, logBytes: 1048576, retentionDays: 30 },
    channels: { telegram: "enabled" } } as unknown as ServiceConfig;
  const parsed = parseServiceConfig(service);
  expect(Object.keys(parsed)).not.toContain("channels");
  // The stored token reference is left as it is, but nothing exports it to the process any more.
  expect(parsed.secretRefs).toHaveLength(1);
  expect(serviceEnvironment(parsed).map(([name]) => name).filter(name => name.includes("TELEGRAM"))).toEqual([]);
  expect(() => parseServiceConfig({ ...service, channels: { telegram: "on" } })).toThrow("invalid_service_config");
});

test("S15: a protected store with Telegram tables and rows reopens and serves; nothing reads or drops them", async () => {
  const f = await composedFixture(); s15.push(f);
  const conversation = join(f.directory, "conversation.sqlite");
  const db = new Database(conversation);
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS telegram_state_v1 (id INTEGER PRIMARY KEY CHECK (id=1), json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS telegram_inbox_v1 (sequence INTEGER PRIMARY KEY AUTOINCREMENT, bot_id INTEGER NOT NULL, update_id INTEGER NOT NULL, kind TEXT NOT NULL, classification TEXT NOT NULL,
        user_id INTEGER, chat_id INTEGER, message_id INTEGER, reply_to INTEGER, text TEXT, binding_revision INTEGER NOT NULL, received_at INTEGER NOT NULL,
        status TEXT NOT NULL, request_id TEXT, duty_id TEXT, outbound TEXT NOT NULL DEFAULT 'none', code TEXT, processed_at INTEGER, UNIQUE(bot_id, update_id));
      CREATE TABLE IF NOT EXISTS telegram_outbox_v1 (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, event_id TEXT NOT NULL, chat_id INTEGER NOT NULL, duty_id TEXT, reply_to INTEGER, text TEXT NOT NULL,
        state TEXT NOT NULL, attempts INTEGER NOT NULL, next_at INTEGER NOT NULL, message_id INTEGER, code TEXT, created_at INTEGER NOT NULL, settled_at INTEGER);
      CREATE TABLE IF NOT EXISTS telegram_events_v1 (event_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
      INSERT INTO telegram_state_v1 VALUES (1, '{"contract":"s15-telegram-state/v1","bot":{"id":1,"username":"old_bot"},"binding":{"state":"bound","revision":2}}');
      INSERT INTO telegram_inbox_v1 (bot_id, update_id, kind, classification, user_id, chat_id, message_id, binding_revision, received_at, status) VALUES (1, 7, 'text', 'owner', 42, 77, 3, 2, ${epoch}, 'persisted');
      INSERT INTO telegram_outbox_v1 (id, event_id, chat_id, text, state, attempts, next_at, created_at) VALUES ('out-1', 'event-1', 77, 'queued notice', 'pending', 0, 0, ${epoch});`);
  } finally { db.close(); }
  await f.reopen();
  expect(Object.keys(f.service)).not.toContain("telegram");
  // The protected Web no longer has a Telegram page, and ordinary chat still runs.
  expect((await f.request("/resources/telegram")).status).toBe(404);
  const row = await f.chat("Run the requested command in the working computer");
  expect(row.state).toBe("completed");
  await f.service.drain();
  const after = new Database(conversation, { readonly: true });
  try {
    expect(after.query("SELECT count(*) AS n FROM telegram_inbox_v1 WHERE status = 'persisted'").get()).toEqual({ n: 1 });
    expect(after.query("SELECT state FROM telegram_outbox_v1").all()).toEqual([{ state: "pending" }]);
  } finally { after.close(); }
});
