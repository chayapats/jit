import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Application } from "../src/application";
import { readConfig } from "../src/config";
import { TransactionStore } from "../src/store";
import { TelegramChannel, type TelegramUpdate, type TelegramUpdateTransport } from "../src/telegram";

const password = "fixture-telegram-owner-password";
const epoch = 1_700_000_000_000;
const roots: string[] = [];
const stores: TransactionStore[] = [];
afterEach(() => {
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
  expect(store.read(tx => tx.get("PRAGMA user_version"))).toEqual({ user_version: 8 });
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
