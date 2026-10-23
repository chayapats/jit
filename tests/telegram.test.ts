import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Application, type ApplicationOptions } from "../src/application";
import { readConfig } from "../src/config";
import { DeliveryWorker, ScriptedTelegramSender } from "../src/delivery";
import { JobQueue } from "../src/jobs/queue";
import { TransactionStore } from "../src/store";
import { discussionPlanWork, specialistAnalysisWork } from "../src/team/dispatch";
import { ScriptedRunPort, fixtureOutcome } from "../src/team/scripted-port";
import { scriptedPreviewWork } from "../src/team/preview";
import { coordinatorSynthesisWork } from "../src/team/decisions";
import {
  TelegramChannel, TelegramProjectCommands, decodeCallbackData, type TelegramUpdate, type TelegramUpdateTransport,
} from "../src/telegram";

const password = "fixture-telegram-owner-password";
const epoch = 1_700_000_000_000;
const roots: string[] = [];
const stores: TransactionStore[] = [];
const queues: JobQueue[] = [];
afterEach(async () => {
  for (const queue of queues.splice(0)) { queue.close(); await queue.idle(); }
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

class Clock { now = epoch; }

function tokenFile(root: string, value = "123456:FIXTURE-BOT-TOKEN-NOT-LIVE"): string {
  const path = join(root, "bot.token");
  writeFileSync(path, value, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

async function fixture(options: {
  now?: () => number; beforeCommit?: ConstructorParameters<typeof TelegramChannel>[2] extends infer O
    ? O extends { beforeCommit?: infer B } ? B : never : never;
  transport?: TelegramUpdateTransport; env?: Record<string, string>;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "jit-tg01-")); roots.push(root);
  const path = join(root, "app.sqlite");
  const botTokenPath = tokenFile(root);
  const config = readConfig({ JIT_DATABASE: path, JIT_TELEGRAM_BOT_TOKEN_PATH: botTokenPath, ...options.env });
  const store = new TransactionStore(path); stores.push(store);
  const clock = new Clock();
  const app = new Application(store, config, { now: options.now ?? (() => clock.now) });
  await app.setupOwner(password);
  const session = await app.login(password);
  const telegram = new TelegramChannel(store, config, {
    now: options.now ?? (() => clock.now),
    ...(options.beforeCommit ? { beforeCommit: options.beforeCommit } : {}),
    ...(options.transport ? { transport: options.transport } : {}),
  });
  const actor = telegram.authenticate(session);
  return { root, path, config, store, clock, app, session, telegram, actor };
}

function message(updateId: number, userId: number, chatId: number, text: string, extra: Partial<TelegramUpdate["message"]> = {}): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId * 10, text, from: { id: userId, is_bot: false, username: "renamed_later" },
      chat: { id: chatId, type: "private" }, ...extra,
    },
  };
}

test("owner binds numeric IDs with revisioned challenge; username and forged actors never establish identity", async () => {
  const f = await fixture();
  expect(f.telegram.status(f.actor)).toMatchObject({ binding: { state: "unbound", revision: 1 }, botCredentialConfigured: true, nextAction: "bind_numeric_owner" });
  const bind = f.telegram.execute(f.actor, {
    kind: "telegram.bind", requestId: "tg-bind-01", expectedRevision: 1,
    payload: { telegramUserId: 42, telegramChatId: 42, usernameHint: "old_name" },
  });
  expect(bind.binding).toMatchObject({ state: "pending", revision: 2, telegramUserId: 42, telegramChatId: 42, usernameHint: "old_name" });
  expect(bind.binding.challengeNonce).toMatch(/^[a-f0-9]{32}$/);
  expect(f.telegram.execute(f.actor, {
    kind: "telegram.bind", requestId: "tg-bind-01", expectedRevision: 1,
    payload: { telegramUserId: 42, telegramChatId: 42, usernameHint: "old_name" },
  })).toEqual(bind);
  expect(() => f.telegram.execute(f.actor, {
    kind: "telegram.bind", requestId: "tg-bind-01", expectedRevision: 1,
    payload: { telegramUserId: 99, telegramChatId: 42 },
  })).toThrow("request_id_conflict");
  expect(() => f.telegram.execute({ ownerId: "owner", channel: "web" }, {
    kind: "telegram.confirm", requestId: "tg-confirm-x", expectedRevision: 2,
    payload: { telegramUserId: 42, telegramChatId: 42, challengeNonce: bind.binding.challengeNonce! },
  })).toThrow("authentication_required");
  const confirmed = f.telegram.execute(f.actor, {
    kind: "telegram.confirm", requestId: "tg-confirm-01", expectedRevision: 2,
    payload: { telegramUserId: 42, telegramChatId: 42, challengeNonce: bind.binding.challengeNonce! },
  });
  expect(confirmed.binding).toMatchObject({ state: "bound", revision: 3, telegramUserId: 42, proof: { confirmedBy: "owner_web" } });
  const html = f.telegram.renderStatusHtml(f.actor);
  expect(html).toContain("State: bound");
  expect(html).toContain("user 42 / chat 42");
  expect(html).not.toContain(f.session);
  expect(html).not.toContain("FIXTURE-BOT-TOKEN");
});

test("protocol fixtures reject wrong sender/chat, username-only claims, forwards, bots, groups and stale callbacks", async () => {
  const f = await fixture();
  const bind = f.telegram.execute(f.actor, {
    kind: "telegram.bind", requestId: "tg-bind-02", expectedRevision: 1,
    payload: { telegramUserId: 7, telegramChatId: 7 },
  });
  f.telegram.execute(f.actor, {
    kind: "telegram.confirm", requestId: "tg-confirm-02", expectedRevision: 2,
    payload: { telegramUserId: 7, telegramChatId: 7, challengeNonce: bind.binding.challengeNonce! },
  });
  const events = f.telegram.ingest([
    message(1, 7, 7, "hello from renamed_username"),
    message(2, 8, 7, "wrong sender"),
    message(3, 7, 9, "wrong chat"),
    message(4, 7, 7, "forwarded", { forward_date: 1, forward_from: { id: 1 } }),
    message(5, 7, 7, "from bot", { from: { id: 7, is_bot: true } }),
    { update_id: 6, message: { message_id: 60, text: "group", from: { id: 7 }, chat: { id: -100, type: "group" } } },
    { update_id: 7, callback_query: { id: "cb-old", from: { id: 7 }, data: "ok", message: { message_id: 1, chat: { id: 7, type: "private" } } } },
  ]);
  expect(events.map(e => e.classification)).toEqual([
    "authorized", "unauthorized_sender", "unauthorized_chat", "forward_rejected", "bot_origin_rejected", "group_rejected", "authorized",
  ]);
  f.telegram.execute(f.actor, { kind: "telegram.revoke", requestId: "tg-revoke-01", expectedRevision: 3, payload: {} });
  const stale = f.telegram.ingest([
    { update_id: 8, callback_query: { id: "cb-stale", from: { id: 7 }, data: "ok", message: { message_id: 2, chat: { id: 7, type: "private" } } } },
  ]);
  expect(stale[0]!.classification).toBe("stale_binding");
  const page = f.telegram.events(f.actor, 0, "unauthorized_sender");
  expect(page.items).toHaveLength(1);
  expect(page.items[0]!.textContent).toBe("wrong sender");
  expect(f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM projects")!.n)).toBe(0);
});

test("challenge message from exact numeric pair binds; expired or mismatched challenge does not", async () => {
  const f = await fixture();
  const bind = f.telegram.execute(f.actor, {
    kind: "telegram.bind", requestId: "tg-bind-03", expectedRevision: 1,
    payload: { telegramUserId: 11, telegramChatId: 11 },
  });
  const mismatch = f.telegram.ingest([message(10, 11, 11, "not-the-nonce")]);
  expect(mismatch[0]!.classification).toBe("challenge_mismatch");
  expect(f.telegram.status(f.actor).binding.state).toBe("pending");
  const match = f.telegram.ingest([message(11, 11, 11, `/start ${bind.binding.challengeNonce}`)]);
  expect(match[0]!.classification).toBe("challenge_match");
  expect(f.telegram.status(f.actor).binding).toMatchObject({ state: "bound", revision: 3, proof: { confirmedBy: "challenge_match" } });

  const g = await fixture();
  const pending = g.telegram.execute(g.actor, {
    kind: "telegram.bind", requestId: "tg-bind-04", expectedRevision: 1,
    payload: { telegramUserId: 12, telegramChatId: 12 },
  });
  g.clock.now += g.config.telegram.challengeSeconds * 1000 + 1;
  expect(() => g.telegram.execute(g.actor, {
    kind: "telegram.confirm", requestId: "tg-confirm-expired", expectedRevision: 2,
    payload: { telegramUserId: 12, telegramChatId: 12, challengeNonce: pending.binding.challengeNonce! },
  })).toThrow("telegram_challenge_expired");
  const late = g.telegram.ingest([message(20, 12, 12, pending.binding.challengeNonce!)]);
  expect(late[0]!.classification).toBe("challenge_mismatch");
});

test("crash before inbox commit does not advance offset; after inbox before offset still dedupes; after offset is stable", async () => {
  const f = await fixture({ beforeCommit: stage => { if (stage === "inbox") throw new Error("crash-before-inbox"); } });
  const bind = f.telegram.execute(f.actor, {
    kind: "telegram.bind", requestId: "tg-bind-crash", expectedRevision: 1,
    payload: { telegramUserId: 1, telegramChatId: 1 },
  });
  f.telegram.execute(f.actor, {
    kind: "telegram.confirm", requestId: "tg-confirm-crash", expectedRevision: 2,
    payload: { telegramUserId: 1, telegramChatId: 1, challengeNonce: bind.binding.challengeNonce! },
  });
  expect(() => f.telegram.ingest([message(100, 1, 1, "lost")])).toThrow("crash-before-inbox");
  expect(f.telegram.nextOffset()).toBe(0);
  expect(f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM telegram_inbox")!.n)).toBe(0);

  let crashOffset = false;
  const g = await fixture({ beforeCommit: stage => { if (stage === "offset" && crashOffset) throw new Error("crash-before-offset"); } });
  const b = g.telegram.execute(g.actor, {
    kind: "telegram.bind", requestId: "tg-bind-c2", expectedRevision: 1,
    payload: { telegramUserId: 2, telegramChatId: 2 },
  });
  g.telegram.execute(g.actor, {
    kind: "telegram.confirm", requestId: "tg-confirm-c2", expectedRevision: 2,
    payload: { telegramUserId: 2, telegramChatId: 2, challengeNonce: b.binding.challengeNonce! },
  });
  crashOffset = true;
  expect(() => g.telegram.ingest([message(200, 2, 2, "saved"), message(200, 2, 2, "dup-in-batch")])).toThrow("crash-before-offset");
  expect(g.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM telegram_inbox")!.n)).toBe(1);
  expect(g.telegram.nextOffset()).toBe(0);
  crashOffset = false;
  const replay = g.telegram.ingest([message(200, 2, 2, "saved-again"), message(201, 2, 2, "next")]);
  expect(replay).toHaveLength(2);
  expect(replay[0]!.sequence).toBe(g.store.read(tx => tx.get<{ sequence: number }>("SELECT sequence FROM telegram_inbox WHERE update_id = 200")!.sequence));
  expect(g.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM telegram_inbox")!.n)).toBe(2);
  expect(g.telegram.nextOffset()).toBe(202);

  g.store.close();
  const store = new TransactionStore(g.path); stores.push(store);
  const reopened = new TelegramChannel(store, g.config, { now: () => g.clock.now });
  expect(reopened.nextOffset()).toBe(202);
  const actor = reopened.authenticate(g.session);
  expect(reopened.events(actor).items).toHaveLength(2);
  expect(reopened.ingest([message(200, 2, 2, "dup-after-restart")])).toHaveLength(1);
  expect(store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM telegram_inbox")!.n)).toBe(2);
});

test("processing failure is visible with bounded replay; authorized text does not mutate projects", async () => {
  const f = await fixture({ env: { JIT_TELEGRAM_PROCESS_ATTEMPTS: "2" } });
  const bind = f.telegram.execute(f.actor, {
    kind: "telegram.bind", requestId: "tg-bind-proc", expectedRevision: 1,
    payload: { telegramUserId: 3, telegramChatId: 3 },
  });
  f.telegram.execute(f.actor, {
    kind: "telegram.confirm", requestId: "tg-confirm-proc", expectedRevision: 2,
    payload: { telegramUserId: 3, telegramChatId: 3, challengeNonce: bind.binding.challengeNonce! },
  });
  f.telegram.ingest([message(300, 3, 3, "untrusted command text")]);
  let blows = 0;
  const first = f.telegram.process(() => { blows++; throw new Error("boom"); });
  expect(first[0]).toMatchObject({ status: "persisted", processAttempts: 1, classification: "authorized" });
  const second = f.telegram.process(() => { blows++; throw new Error("boom"); });
  expect(second[0]).toMatchObject({ status: "failed", processAttempts: 2, failureReason: "telegram_process_failed" });
  expect(f.telegram.process()).toEqual([]);
  expect(blows).toBe(2);
  expect(f.telegram.status(f.actor).failedCount).toBe(1);
  expect(f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM projects")!.n)).toBe(0);
  expect(f.telegram.process()).toEqual([]);
});

test("fake-clock downtime beyond retention marks possible missing inputs; service never reconstructs", async () => {
  const f = await fixture();
  f.telegram.ingest([]);
  expect(f.telegram.status(f.actor).poll.gapState).toBe("none");
  f.clock.now += f.config.telegram.retentionHours * 3_600_000 + 1;
  f.telegram.ingest([]);
  // Session TTL is shorter than Telegram retention; owner re-authenticates to inspect the gap.
  const actor = f.telegram.authenticate(await f.app.login(password));
  const status = f.telegram.status(actor);
  expect(status.poll.gapState).toBe("possible_missing_inputs");
  expect(status.poll.gapReason).toBe("poll_interval_exceeded_telegram_retention");
  expect(status.nextAction).toBe("inspect_possible_missing_inputs");
  const ack = f.telegram.execute(actor, {
    kind: "telegram.ack_gap", requestId: "tg-ack-gap", expectedRevision: status.binding.revision, payload: {},
  });
  expect(ack.poll.gapState).toBe("none");
  expect(ack.binding.revision).toBe(status.binding.revision + 1);
});

test("scripted transport pollOnce advances offset and applies bounded backoff on failure", async () => {
  let calls = 0;
  const transport: TelegramUpdateTransport = {
    async getUpdates(offset) {
      calls++;
      if (calls === 1) throw new Error("network");
      expect(offset).toBe(0);
      return [message(400, 5, 5, "via transport")];
    },
  };
  const f = await fixture({ transport });
  const bind = f.telegram.execute(f.actor, {
    kind: "telegram.bind", requestId: "tg-bind-poll", expectedRevision: 1,
    payload: { telegramUserId: 5, telegramChatId: 5 },
  });
  f.telegram.execute(f.actor, {
    kind: "telegram.confirm", requestId: "tg-confirm-poll", expectedRevision: 2,
    payload: { telegramUserId: 5, telegramChatId: 5, challengeNonce: bind.binding.challengeNonce! },
  });
  await expect(f.telegram.pollOnce()).rejects.toThrow("telegram_poll_failed");
  expect(f.telegram.pollBackoffMs()).toBe(Math.min(f.config.telegram.pollBackoffMs * 2, f.config.telegram.maxPollBackoffMs));
  const events = await f.telegram.pollOnce();
  expect(events[0]!.classification).toBe("authorized");
  expect(f.telegram.nextOffset()).toBe(401);
  expect(f.telegram.pollBackoffMs()).toBe(f.config.telegram.pollBackoffMs);
});

test("schema v6 migrates from published v5 without fabricating telegram history and snapshots privately", async () => {
  const root = mkdtempSync(join(tmpdir(), "jit-tg01-mig-")); roots.push(root);
  const path = join(root, "old.sqlite");
  const old = new Database(path);
  old.exec(`
    CREATE TABLE owner (id TEXT PRIMARY KEY CHECK (id = 'owner'), password_hash TEXT NOT NULL, generation INTEGER NOT NULL);
    INSERT INTO owner VALUES ('owner', 'x', 1);
    CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, owner_id TEXT NOT NULL, generation INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE login_throttle (id INTEGER PRIMARY KEY CHECK (id = 1), window_start INTEGER NOT NULL, attempts INTEGER NOT NULL);
    CREATE TABLE app_state (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL);
    INSERT INTO app_state VALUES (1, 0);
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, revision INTEGER NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE project_groups (id TEXT PRIMARY KEY, project_id TEXT NOT NULL UNIQUE REFERENCES projects(id));
    CREATE TABLE command_receipts (actor_id TEXT NOT NULL, request_id TEXT NOT NULL, payload_hash TEXT NOT NULL, result_json TEXT NOT NULL, committed_at INTEGER NOT NULL, PRIMARY KEY (actor_id, request_id));
    CREATE TABLE audit (id INTEGER PRIMARY KEY, actor_id TEXT NOT NULL, command_kind TEXT NOT NULL, request_id TEXT NOT NULL, project_id TEXT NOT NULL, committed_at INTEGER NOT NULL, UNIQUE (actor_id, request_id));
    CREATE UNIQUE INDEX project_group_identity ON project_groups(project_id, id);
    CREATE TABLE sources (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL, current_revision INTEGER NOT NULL, generation INTEGER NOT NULL, availability TEXT NOT NULL);
    CREATE TABLE source_versions (source_id TEXT NOT NULL, revision INTEGER NOT NULL, generation INTEGER NOT NULL, descriptor_json TEXT NOT NULL, attribution_json TEXT NOT NULL, content_text TEXT, committed_at INTEGER NOT NULL, PRIMARY KEY (source_id, revision, generation));
    CREATE TABLE topics (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, group_id TEXT NOT NULL, revision INTEGER NOT NULL, sequence INTEGER NOT NULL, message_sequence INTEGER NOT NULL, created_at INTEGER NOT NULL, attribution_json TEXT NOT NULL, source_id TEXT NOT NULL UNIQUE, source_revision INTEGER NOT NULL, source_generation INTEGER NOT NULL);
    CREATE TABLE messages (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, topic_id TEXT NOT NULL, sequence INTEGER NOT NULL, committed_at INTEGER NOT NULL, attribution_json TEXT NOT NULL, source_id TEXT NOT NULL UNIQUE, source_revision INTEGER NOT NULL, source_generation INTEGER NOT NULL);
    CREATE TABLE job_scheduler (id INTEGER PRIMARY KEY CHECK (id = 1), token TEXT NOT NULL, pid INTEGER NOT NULL);
    CREATE TABLE jobs (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL, queue_order INTEGER NOT NULL, priority INTEGER NOT NULL, state TEXT NOT NULL, occupies INTEGER NOT NULL, route_key TEXT NOT NULL, record_json TEXT NOT NULL);
    CREATE TABLE team_state (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL, route_json TEXT);
    INSERT INTO team_state VALUES (1, 0, NULL);
    CREATE TABLE roles (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, record_json TEXT NOT NULL);
    CREATE TABLE project_team (project_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, route_json TEXT, overrides_json TEXT NOT NULL);
    CREATE TABLE team_contexts (id TEXT PRIMARY KEY, generation INTEGER NOT NULL, state TEXT NOT NULL);
    CREATE TABLE team_runs (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL, job_id TEXT NOT NULL UNIQUE, context_id TEXT NOT NULL UNIQUE, record_json TEXT NOT NULL);
    CREATE TABLE job_authority (job_id TEXT PRIMARY KEY, generation INTEGER NOT NULL, reason TEXT, stop_json TEXT);
    CREATE TABLE job_attempts (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, job_id TEXT NOT NULL, record_json TEXT NOT NULL);
    CREATE TABLE job_reconciliation (id TEXT PRIMARY KEY, record_json TEXT NOT NULL);
    PRAGMA user_version = 5;
  `);
  old.close();
  const store = new TransactionStore(path); stores.push(store);
  expect(store.read(tx => tx.get("PRAGMA user_version"))).toEqual({ user_version: 12 });
  expect(store.read(tx => tx.get("SELECT state FROM telegram_binding WHERE id = 1"))).toEqual({ state: "unbound" });
  expect(store.read(tx => tx.get("SELECT next_offset FROM telegram_poll WHERE id = 1"))).toEqual({ next_offset: 0 });
  expect(store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM telegram_inbox")!.n)).toBe(0);
  const snapshot = readdirSync(root).find(name => name.includes(".pre-v5-"))!;
  expect(snapshot).toBeString();
  const snap = new Database(join(root, snapshot), { readonly: true });
  expect(snap.query("PRAGMA user_version").get()).toEqual({ user_version: 5 });
  snap.close();
});

test("config rejects unbounded telegram limits; token file contents never appear in status", async () => {
  expect(() => readConfig({ JIT_TELEGRAM_RETENTION_HOURS: "25" })).toThrow();
  expect(() => readConfig({ JIT_TELEGRAM_MAX_POLL_BACKOFF_MS: "100", JIT_TELEGRAM_POLL_BACKOFF_MS: "1000" })).toThrow();
  const f = await fixture();
  const status = f.telegram.status(f.actor);
  expect(JSON.stringify(status)).not.toContain("FIXTURE-BOT-TOKEN");
  expect(f.telegram.renderStatusHtml(f.actor)).not.toContain("123456:");
});

const rid = () => crypto.randomUUID();

async function tg02Fixture(options: { beforeCommit?: ApplicationOptions["beforeCommit"]; script?: ConstructorParameters<typeof ScriptedRunPort>[3] } = {}) {
  const f = await fixture();
  const port = new ScriptedRunPort(f.store, f.config.team, f.config.jobs.outputBytes, options.script);
  const queue = new JobQueue(f.store, f.config.jobs, [
    scriptedPreviewWork(f.store, f.config, port, () => f.clock.now), discussionPlanWork(), specialistAnalysisWork(f.store, f.config, port, () => f.clock.now),
    coordinatorSynthesisWork(f.store, f.config, port, () => f.clock.now),
  ], { now: () => f.clock.now });
  queues.push(queue);
  const app = new Application(f.store, f.config, { now: () => f.clock.now, jobs: queue, ...(options.beforeCommit ? { beforeCommit: options.beforeCommit } : {}) });
  const bind = f.telegram.execute(f.actor, {
    kind: "telegram.bind", requestId: "tg-tg02-bind", expectedRevision: 1,
    payload: { telegramUserId: 99, telegramChatId: 99 },
  });
  f.telegram.execute(f.actor, {
    kind: "telegram.confirm", requestId: "tg-tg02-confirm", expectedRevision: 2,
    payload: { telegramUserId: 99, telegramChatId: 99, challengeNonce: bind.binding.challengeNonce! },
  });
  const auth = app.authenticate(f.session);
  const project = app.execute(auth.actor, { kind: "project.create", projectId: null, requestId: rid(), expectedRevision: 0, payload: { name: "โครงการ Telegram 🧪" } }).project;
  const topic = app.execute(auth.actor, { kind: "topic.create", projectId: project.id, requestId: rid(), expectedRevision: project.revision, payload: { title: "หัวข้อ TG02" } }).topic;
  app.execute(auth.actor, {
    kind: "role.save", projectId: null, requestId: rid(), expectedRevision: app.team(auth.actor).ownerRevision,
    payload: {
      roleId: null, name: "ผู้ประสาน", kind: "coordinator", responsibility: "สรุปงาน", enabled: true,
      route: { provider: "grok", model: "fixture-grok-exact", authRoute: "owner-grok" },
    },
  });
  const commands = new TelegramProjectCommands(f.store, { app, sessionToken: f.session, config: f.config, now: () => f.clock.now, jobs: queue });
  const sender = new ScriptedTelegramSender();
  const worker = new DeliveryWorker(f.store, { sender, now: () => f.clock.now });
  return { ...f, app, port, queue, auth, project, topic, commands, sender, worker, userId: 99, chatId: 99 };
}

function bindContext(f: Awaited<ReturnType<typeof tg02Fixture>>) {
  f.telegram.ingest([message(500, f.userId, f.chatId, `/bind ${f.project.id} ${f.topic.id}`)]);
  f.telegram.processProjectCommands(f.commands);
  f.project = f.app.project(f.auth.actor, f.project.id);
}

test("TG02: bind uses immutable project/topic IDs; same task title in two projects stays separate", async () => {
  const f = await tg02Fixture();
  const other = f.app.execute(f.auth.actor, { kind: "project.create", projectId: null, requestId: rid(), expectedRevision: 1, payload: { name: "โครงการ Telegram 🧪" } }).project;
  const otherTopic = f.app.execute(f.auth.actor, { kind: "topic.create", projectId: other.id, requestId: rid(), expectedRevision: other.revision, payload: { title: "หัวข้อสอง" } }).topic;
  const title = "ชื่องานเดียวกัน";
  const first = f.app.execute(f.auth.actor, {
    kind: "task.propose", requestId: rid(), projectId: f.project.id, expectedRevision: f.topic.revision,
    payload: { topicId: f.topic.id, title, summary: "ในโครงการแรก" },
  }).task;
  const second = f.app.execute(f.auth.actor, {
    kind: "task.propose", requestId: rid(), projectId: other.id, expectedRevision: otherTopic.revision,
    payload: { topicId: otherTopic.id, title, summary: "ในโครงการสอง" },
  }).task;
  bindContext(f);
  f.telegram.ingest([message(501, f.userId, f.chatId, "/tasks")]);
  f.telegram.processProjectCommands(f.commands);
  expect(f.app.tasks(f.auth.actor, f.project.id).proposed.map(t => t.id)).toEqual([first.id]);
  expect(f.app.tasks(f.auth.actor, other.id).proposed.map(t => t.id)).toEqual([second.id]);
  f.telegram.ingest([message(502, f.userId, f.chatId, `/bind ${other.id} ${otherTopic.id} 1`)]);
  f.telegram.processProjectCommands(f.commands);
  f.telegram.ingest([message(503, f.userId, f.chatId, "/tasks")]);
  f.telegram.processProjectCommands(f.commands);
  const intents = f.store.read(tx => tx.all<{ record_json: string }>("SELECT record_json FROM delivery_intents"));
  expect(intents.some(i => i.record_json.includes(first.id))).toBe(true);
  expect(intents.some(i => i.record_json.includes(second.id))).toBe(true);
});

test("TG02: callback accept commits task via telegram actor and outbox reply; Web read model matches", async () => {
  const f = await tg02Fixture();
  const proposed = f.app.execute(f.auth.actor, {
    kind: "task.propose", requestId: rid(), projectId: f.project.id, expectedRevision: f.topic.revision,
    payload: { topicId: f.topic.id, title: "งานรับจาก Telegram", summary: "สรุปข้อเสนอ" },
  });
  bindContext(f);
  f.telegram.ingest([message(600, f.userId, f.chatId, "/tasks")]);
  f.telegram.processProjectCommands(f.commands);
  const reply = f.store.read(tx => tx.get<{ record_json: string }>("SELECT record_json FROM delivery_intents ORDER BY sequence DESC LIMIT 1"))!;
  const cbMatch = reply.record_json.match(/tg\/1\/[a-f0-9]{32}/);
  expect(cbMatch).toBeTruthy();
  const cbData = cbMatch![0]!;
  f.telegram.ingest([{ update_id: 601, callback_query: {
    id: "cb-accept-1", from: { id: f.userId, is_bot: false }, data: cbData,
    message: { message_id: 6010, chat: { id: f.chatId, type: "private" } },
  } }]);
  f.telegram.processProjectCommands(f.commands);
  const model = f.app.task(f.auth.actor, f.project.id, proposed.task.id);
  expect(model.task.state).toBe("accepted");
  expect(model.task.acceptance?.channel).toBe("telegram");
  f.worker.pump();
  expect(f.sender.external.at(-1)?.text).toContain(proposed.task.id);
});

test("TG02: duplicate callback replays one acceptance; stale proposal revision refreshes callback", async () => {
  const f = await tg02Fixture();
  const proposed = f.app.execute(f.auth.actor, {
    kind: "task.propose", requestId: rid(), projectId: f.project.id, expectedRevision: f.topic.revision,
    payload: { topicId: f.topic.id, title: "งาน revision", summary: "v1" },
  });
  bindContext(f);
  f.telegram.ingest([message(700, f.userId, f.chatId, "/tasks")]);
  f.telegram.processProjectCommands(f.commands);
  const listing = f.store.read(tx => tx.get<{ record_json: string }>("SELECT record_json FROM delivery_intents ORDER BY sequence DESC LIMIT 1"))!;
  const cbData = listing.record_json.match(/tg\/1\/[a-f0-9]{32}/)![0]!;
  const cb = (updateId: number) => ({ update_id: updateId, callback_query: {
    id: `cb-${updateId}`, from: { id: f.userId }, data: cbData,
    message: { message_id: 7000 + updateId, chat: { id: f.chatId, type: "private" } },
  } });
  f.telegram.ingest([cb(701)]);
  f.telegram.processProjectCommands(f.commands);
  f.telegram.ingest([cb(702)]);
  f.telegram.processProjectCommands(f.commands);
  expect(f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM task_events WHERE kind = 'accepted'")!.n)).toBe(1);

  const proposed2 = f.app.execute(f.auth.actor, {
    kind: "task.propose", requestId: rid(), projectId: f.project.id, expectedRevision: f.topic.revision,
    payload: { topicId: f.topic.id, title: "งาน revision 2", summary: "fresh proposal" },
  });
  f.telegram.ingest([message(703, f.userId, f.chatId, "/tasks")]);
  f.telegram.processProjectCommands(f.commands);
  const listing2 = f.store.read(tx => tx.get<{ record_json: string }>("SELECT record_json FROM delivery_intents ORDER BY sequence DESC LIMIT 1"))!;
  const staleCb = listing2.record_json.match(/tg\/1\/[a-f0-9]{32}/)![0]!;
  f.app.execute(f.auth.actor, {
    kind: "task.edit", requestId: rid(), projectId: f.project.id, expectedRevision: proposed2.task.revision,
    payload: { taskId: proposed2.task.id, title: "งาน revision 2", summary: "v2 edited" },
  });
  f.telegram.ingest([{ update_id: 704, callback_query: {
    id: "cb-stale", from: { id: f.userId }, data: staleCb,
    message: { message_id: 7040, chat: { id: f.chatId, type: "private" } },
  } }]);
  f.telegram.processProjectCommands(f.commands);
  const staleReply = f.store.read(tx => tx.get<{ record_json: string }>("SELECT record_json FROM delivery_intents ORDER BY sequence DESC LIMIT 1"))!;
  expect(staleReply.record_json).toContain("Proposal");
  expect(decodeCallbackData(staleCb)).toHaveLength(32);
  expect(proposed.task.id).not.toBe(proposed2.task.id);
});

test("TG02: edited accepted message conflicts; Thai follow-up uses team dispatch and outbox survives outage", async () => {
  const f = await tg02Fixture();
  const proposed = f.app.execute(f.auth.actor, {
    kind: "task.propose", requestId: rid(), projectId: f.project.id, expectedRevision: f.topic.revision,
    payload: { topicId: f.topic.id, title: "งานแก้ไม่ได้", summary: "accept แล้ว" },
  });
  bindContext(f);
  f.telegram.ingest([message(800, f.userId, f.chatId, "/tasks")]);
  f.telegram.processProjectCommands(f.commands);
  const cbData = f.store.read(tx => tx.get<{ record_json: string }>("SELECT record_json FROM delivery_intents ORDER BY sequence DESC LIMIT 1"))!.record_json.match(/tg\/1\/[a-f0-9]{32}/)![0]!;
  f.telegram.ingest([{ update_id: 801, callback_query: {
    id: "cb-edit-test", from: { id: f.userId }, data: cbData,
    message: { message_id: 8010, chat: { id: f.chatId, type: "private" } },
  } }]);
  f.telegram.processProjectCommands(f.commands);
  f.telegram.ingest([{ update_id: 802, edited_message: {
    message_id: 8010, text: "forge accept", from: { id: f.userId, is_bot: false }, chat: { id: f.chatId, type: "private" },
  } }]);
  f.telegram.processProjectCommands(f.commands);
  const conflict = f.store.read(tx => tx.get<{ record_json: string }>("SELECT record_json FROM delivery_intents ORDER BY sequence DESC LIMIT 1"))!;
  expect(conflict.record_json).toContain("accept");
  expect(f.app.task(f.auth.actor, f.project.id, proposed.task.id).task.state).toBe("accepted");

  f.telegram.ingest([message(803, f.userId, f.chatId, "/follow ช่วยสรุปภาษาไทยและ Unicode 🧪 <safe>")]);
  f.telegram.processProjectCommands(f.commands);
  expect(f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM team_runs")!.n)).toBeGreaterThan(0);

  f.worker.close();
  const offline = new ScriptedTelegramSender();
  offline.scripts = ["safe_failure"];
  const offlineWorker = new DeliveryWorker(f.store, { sender: offline, now: () => f.clock.now });
  offlineWorker.pump();
  offlineWorker.close();
  const lastIntent = f.store.read(tx => tx.get<{ record_json: string }>("SELECT record_json FROM delivery_intents ORDER BY sequence DESC LIMIT 1"))!.record_json;
  expect(lastIntent).toMatch(/"(waiting|failed)"/);
  expect(lastIntent).toContain("telegram_unavailable");
  expect(f.app.task(f.auth.actor, f.project.id, proposed.task.id).task.state).toBe("accepted");
});

test("TG02: restart preserves accepted task and inbox processing remains idempotent", async () => {
  const f = await tg02Fixture();
  const proposed = f.app.execute(f.auth.actor, {
    kind: "task.propose", requestId: rid(), projectId: f.project.id, expectedRevision: f.topic.revision,
    payload: { topicId: f.topic.id, title: "restart", summary: "persist" },
  });
  bindContext(f);
  f.telegram.ingest([message(900, f.userId, f.chatId, "/tasks")]);
  f.telegram.processProjectCommands(f.commands);
  const cbData = f.store.read(tx => tx.get<{ record_json: string }>("SELECT record_json FROM delivery_intents ORDER BY sequence DESC LIMIT 1"))!.record_json.match(/tg\/1\/[a-f0-9]{32}/)![0]!;
  f.telegram.ingest([{ update_id: 901, callback_query: {
    id: "cb-restart", from: { id: f.userId }, data: cbData,
    message: { message_id: 9010, chat: { id: f.chatId, type: "private" } },
  } }]);
  f.telegram.processProjectCommands(f.commands);
  const path = f.path;
  f.worker.close();
  f.queue.close();
  await f.queue.idle();
  queues.splice(queues.indexOf(f.queue), 1);
  stores.splice(stores.indexOf(f.store), 1);
  f.store.close();
  const store = new TransactionStore(path); stores.push(store);
  const reopenedApp = new Application(store, f.config, { now: () => f.clock.now });
  const telegram = new TelegramChannel(store, f.config, { now: () => f.clock.now });
  const commands = new TelegramProjectCommands(store, { app: reopenedApp, sessionToken: f.session, config: f.config, now: () => f.clock.now });
  expect(reopenedApp.task(reopenedApp.authenticate(f.session).actor, f.project.id, proposed.task.id).task.state).toBe("accepted");
  telegram.ingest([message(902, f.userId, f.chatId, "/projects")]);
  telegram.processProjectCommands(commands);
  expect(store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM delivery_intents")!.n)).toBeGreaterThan(0);
});

function proposeTg(f: Awaited<ReturnType<typeof tg02Fixture>>, topic = f.topic) {
  return f.app.execute(f.auth.actor, { kind: "task.propose", requestId: rid(), projectId: topic.projectId,
    expectedRevision: topic.revision, payload: { topicId: topic.id, title: "งานตาม revision", summary: "fixture ไทย 🧪" } });
}
function lastCallback(f: Awaited<ReturnType<typeof tg02Fixture>>) {
  return f.store.read(tx => tx.get<{ record_json: string }>("SELECT record_json FROM delivery_intents ORDER BY sequence DESC LIMIT 1"))!.record_json.match(/tg\/1\/[a-f0-9]{32}/)![0]!;
}
function callbackTg(f: Awaited<ReturnType<typeof tg02Fixture>>, id: number, data: string) {
  return { update_id: id, callback_query: { id: `cb-${id}`, from: { id: f.userId }, data,
    message: { message_id: id * 10, chat: { id: f.chatId, type: "private" } } } };
}

test("TG02: revoked and rebound identity fences previously authorized inbox commands", async () => {
  const f = await tg02Fixture(), proposed = proposeTg(f);
  bindContext(f);
  f.telegram.ingest([message(1001, f.userId, f.chatId, "/tasks")]);
  f.telegram.processProjectCommands(f.commands);
  const data = lastCallback(f);
  f.telegram.ingest([callbackTg(f, 1002, data)]);
  const binding = f.telegram.status(f.actor).binding;
  f.telegram.execute(f.actor, { kind: "telegram.revoke", requestId: rid(), expectedRevision: binding.revision, payload: {} });
  const events = f.telegram.processProjectCommands(f.commands);
  expect(events.find(e => e.updateId === 1002)?.classification).toBe("stale_binding");
  expect(f.app.task(f.auth.actor, f.project.id, proposed.task.id).task.state).toBe("proposed");
  expect(f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM task_events WHERE kind = 'accepted'")!.n)).toBe(0);
});

test("TG02: switching context invalidates an old callback even when the owner binding stays the same", async () => {
  const f = await tg02Fixture(), proposed = proposeTg(f);
  bindContext(f);
  f.telegram.ingest([message(1101, f.userId, f.chatId, "/tasks")]);
  f.telegram.processProjectCommands(f.commands);
  const data = lastCallback(f);
  const other = f.app.execute(f.auth.actor, { kind: "topic.create", requestId: rid(), projectId: f.project.id,
    expectedRevision: f.app.project(f.auth.actor, f.project.id).revision, payload: { title: "หัวข้อใหม่" } }).topic;
  f.telegram.ingest([message(1102, f.userId, f.chatId, `/bind ${f.project.id} ${other.id} 1`)]);
  f.telegram.processProjectCommands(f.commands);
  f.telegram.ingest([callbackTg(f, 1103, data)]);
  f.telegram.processProjectCommands(f.commands);
  expect(f.app.task(f.auth.actor, f.project.id, proposed.task.id).task.state).toBe("proposed");
  expect(f.commands.controlReplies().at(-1)?.text).toContain("บริบท");
});

test("TG02: stale callback refresh can be accepted, duplicates replay the receipt after task revision changes", async () => {
  const f = await tg02Fixture(), proposed = proposeTg(f);
  bindContext(f);
  f.telegram.ingest([message(1201, f.userId, f.chatId, "/tasks")]);
  f.telegram.processProjectCommands(f.commands);
  const stale = lastCallback(f);
  const edited = f.app.execute(f.auth.actor, { kind: "task.edit", requestId: rid(), projectId: f.project.id,
    expectedRevision: proposed.task.revision, payload: { taskId: proposed.task.id, title: "ข้อเสนอใหม่", summary: "v2" } });
  f.telegram.ingest([callbackTg(f, 1202, stale)]);
  f.telegram.processProjectCommands(f.commands);
  const fresh = lastCallback(f);
  expect(fresh).not.toBe(stale);
  f.telegram.ingest([message(1203, f.userId, f.chatId, `/accept ${fresh}`)]);
  f.telegram.processProjectCommands(f.commands);
  expect(f.app.task(f.auth.actor, f.project.id, proposed.task.id).task.acceptance?.proposalId).toBe(edited.proposal.id);
  f.telegram.ingest([callbackTg(f, 1204, fresh)]);
  f.telegram.processProjectCommands(f.commands);
  expect(f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM task_events WHERE kind = 'accepted'")!.n)).toBe(1);
});

test("TG02: task edits require the owner's explicit revision and the currently bound topic", async () => {
  const f = await tg02Fixture(), proposed = proposeTg(f);
  bindContext(f);
  const update = f.app.execute(f.auth.actor, { kind: "task.edit", requestId: rid(), projectId: f.project.id,
    expectedRevision: proposed.task.revision, payload: { taskId: proposed.task.id, title: "Web changed", summary: "v2" } });
  f.telegram.ingest([message(1301, f.userId, f.chatId, `/task edit ${proposed.task.id} ${proposed.task.revision} | stale | stale text`)]);
  f.telegram.processProjectCommands(f.commands);
  expect(f.app.task(f.auth.actor, f.project.id, proposed.task.id).task.title).toBe("Web changed");
  f.telegram.ingest([message(1302, f.userId, f.chatId, `/task edit ${proposed.task.id} ${update.task.revision} | Telegram changed 🧪 | ข้อความใหม่`)]);
  f.telegram.processProjectCommands(f.commands);
  expect(f.app.task(f.auth.actor, f.project.id, proposed.task.id).task.title).toBe("Telegram changed 🧪");
  const otherTopic = f.app.execute(f.auth.actor, { kind: "topic.create", requestId: rid(), projectId: f.project.id,
    expectedRevision: f.app.project(f.auth.actor, f.project.id).revision, payload: { title: "different" } }).topic;
  const other = proposeTg(f, otherTopic);
  f.telegram.ingest([message(1303, f.userId, f.chatId, `/task edit ${other.task.id} ${other.task.revision} | forged | wrong topic`)]);
  f.telegram.processProjectCommands(f.commands);
  expect(f.app.task(f.auth.actor, f.project.id, other.task.id).task.title).toBe(other.task.title);
});

test("TG02: project selection replies are durable without choosing an implicit project, and unknown delivery is not resent", async () => {
  const f = await tg02Fixture();
  f.telegram.ingest([message(1401, f.userId, f.chatId, "/projects"), message(1402, f.userId, f.chatId, "/tasks")]);
  f.telegram.processProjectCommands(f.commands);
  expect(f.commands.contextForChat(f.chatId)).toBeNull();
  expect(f.commands.controlReplies().map(reply => reply.status)).toEqual(["queued", "queued"]);
  expect(f.commands.controlReplies()[0]!.text).toContain(f.project.id);
  const sender = new ScriptedTelegramSender(); sender.scripts = ["timeout_after_accept", "accept"];
  const commands = new TelegramProjectCommands(f.store, { app: f.app, sessionToken: f.session, config: f.config, now: () => f.clock.now, controlSender: sender });
  commands.pump();
  expect(commands.controlReplies().map(reply => reply.status)).toEqual(["unknown", "sent"]);
  commands.pump();
  expect(sender.calls).toBe(2);
  expect(f.app.tasks(f.auth.actor, f.project.id).proposed).toEqual([]);
  expect(f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM delivery_intents")!.n)).toBe(0);
});

test("TG02: expired callbacks and stale context changes ask for a fresh selection", async () => {
  const f = await tg02Fixture(); proposeTg(f); bindContext(f);
  f.telegram.ingest([message(1501, f.userId, f.chatId, "/tasks")]);
  f.telegram.processProjectCommands(f.commands);
  const data = lastCallback(f);
  f.clock.now += 86_400_000;
  f.session = await f.app.login(password);
  f.auth = f.app.authenticate(f.session);
  f.commands = new TelegramProjectCommands(f.store, { app: f.app, sessionToken: f.session, config: f.config, now: () => f.clock.now, jobs: f.queue });
  f.telegram.ingest([callbackTg(f, 1502, data)]);
  f.telegram.processProjectCommands(f.commands);
  expect(f.commands.controlReplies().at(-1)?.text).toContain("หมดอายุ");
  const other = f.app.execute(f.auth.actor, { kind: "topic.create", requestId: rid(), projectId: f.project.id,
    expectedRevision: f.app.project(f.auth.actor, f.project.id).revision, payload: { title: "new" } }).topic;
  f.telegram.ingest([message(1503, f.userId, f.chatId, `/bind ${f.project.id} ${other.id}`)]);
  f.telegram.processProjectCommands(f.commands);
  expect(f.commands.contextForChat(f.chatId)?.topicId).toBe(f.topic.id);
});

test("TG02: control reply safe retries are finite and revocation cancels queued replies", async () => {
  const f = await tg02Fixture();
  f.telegram.ingest([message(1601, f.userId, f.chatId, "/projects")]);
  f.telegram.processProjectCommands(f.commands);
  const sender = new ScriptedTelegramSender(); sender.scripts = ["safe_failure"];
  const commands = new TelegramProjectCommands(f.store, { app: f.app, sessionToken: f.session, config: f.config, now: () => f.clock.now, controlSender: sender });
  for (let i = 0; i < 5; i++) commands.pump();
  expect(sender.calls).toBe(3);
  expect(commands.controlReplies()[0]!.status).toBe("failed");
  f.telegram.ingest([message(1602, f.userId, f.chatId, "/projects")]); f.telegram.processProjectCommands(f.commands);
  const binding = f.telegram.status(f.actor).binding;
  f.telegram.execute(f.actor, { kind: "telegram.revoke", requestId: rid(), expectedRevision: binding.revision, payload: {} });
  commands.pump();
  expect(sender.calls).toBe(3);
  expect(commands.controlReplies()[1]!.status).toBe("cancelled");
});

test("TG02: a reply commit failure rolls back admission before any specialist starts", async () => {
  let fail = false;
  const f = await tg02Fixture({ beforeCommit: stage => { if (fail && stage === "delivery") throw new Error("injected reply commit failure"); } });
  bindContext(f);
  fail = true;
  f.telegram.ingest([message(1701, f.userId, f.chatId, "/follow ทดสอบ atomic command")]);
  const result = f.telegram.processProjectCommands(f.commands);
  expect(result.find(event => event.updateId === 1701)?.failureReason).toBe("telegram_process_failed");
  expect(f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM team_runs")!.n)).toBe(0);
  fail = false;
  f.telegram.processProjectCommands(f.commands);
  expect(f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM team_runs")!.n)).toBeGreaterThan(0);
});

test("TG02: direct forged event text and forwarded accept commands cannot grant authority", async () => {
  const f = await tg02Fixture(), proposed = proposeTg(f); bindContext(f);
  f.telegram.ingest([message(1801, f.userId, f.chatId, "/tasks")]); f.telegram.processProjectCommands(f.commands);
  const data = lastCallback(f), raw = message(1802, f.userId, f.chatId, "/projects");
  const event = f.telegram.ingest([raw])[0]!;
  expect(f.commands.handle({ ...event, textContent: `/accept ${data}` }, raw).kind).toBe("reject");
  f.telegram.ingest([message(1803, f.userId, f.chatId, `/accept ${data}`, { forward_origin: { type: "user" } })]);
  f.telegram.processProjectCommands(f.commands);
  expect(f.app.task(f.auth.actor, f.project.id, proposed.task.id).task.state).toBe("proposed");
});

test("TG02: provider outage keeps follow-up waiting and the selected route without completing owner tasks", async () => {
  const f = await tg02Fixture({ script: () => fixtureOutcome("route_unavailable") }), proposed = proposeTg(f);
  f.app.execute(f.auth.actor, { kind: "role.save", projectId: null, requestId: rid(), expectedRevision: f.app.team(f.auth.actor).ownerRevision,
    payload: { roleId: null, name: "Tech", kind: "specialist", responsibility: "review code", enabled: true,
      route: { provider: "grok", model: "fixture-grok-exact", authRoute: "owner-grok" } } });
  bindContext(f);
  f.telegram.ingest([message(1901, f.userId, f.chatId, "/follow code สรุปต่อเมื่อ provider กลับมา")]);
  f.telegram.processProjectCommands(f.commands);
  for (let tick = 0; tick < 3; tick++) { await f.queue.idle(); f.queue.pump(); }
  await f.queue.idle();
  expect(f.port.requests.length).toBeGreaterThan(0);
  expect(f.port.requests.every(request => request.route.provider === "grok" && request.route.model === "fixture-grok-exact")).toBe(true);
  expect(f.store.read(tx => tx.all<{ state: string }>("SELECT state FROM jobs")).some(job => job.state === "waiting")).toBe(true);
  expect(f.app.task(f.auth.actor, f.project.id, proposed.task.id).task.state).toBe("proposed");
});

test("TG02: reopening an interrupted control send preserves unknown instead of resending", async () => {
  const f = await tg02Fixture();
  f.telegram.ingest([message(2001, f.userId, f.chatId, "/projects")]); f.telegram.processProjectCommands(f.commands);
  // Persist the send-invoked checkpoint that a process crash can leave behind.
  f.store.transaction(tx => tx.run("UPDATE telegram_control_replies SET status = 'sending', attempts = 1"));
  const store = new TransactionStore(f.path); stores.push(store);
  const app = new Application(store, f.config, { now: () => f.clock.now });
  const sender = new ScriptedTelegramSender();
  const commands = new TelegramProjectCommands(store, { app, sessionToken: f.session, config: f.config, now: () => f.clock.now, controlSender: sender });
  commands.pump();
  expect(commands.controlReplies()[0]!.status).toBe("unknown");
  expect(commands.controlReplies()[0]!.reason).toBe("interrupted_send");
  expect(sender.calls).toBe(0);
});
