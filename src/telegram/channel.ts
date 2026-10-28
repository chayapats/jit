import { createHash } from "node:crypto";
import { AppError } from "../errors";
import type { AppConfig } from "../config";
import { TransactionStore, type AppTransaction } from "../store";
import { bindingIdentity, mutateBinding, readBinding, readPoll } from "./binding";
import { advanceOffset, inboxCounts, noticeRetentionGap, persistUpdates, processPersisted, readEvents } from "./inbox";
import type { TelegramProjectCommands } from "./project-commands";
import type { TelegramUpdate } from "./types";
import { botCredentialConfigured } from "./secrets";
import type {
  TelegramBindingCommand, TelegramBindingReceipt, TelegramEventPage, TelegramInboxEvent,
  TelegramStatus, TelegramUpdateTransport,
} from "./types";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const validToken = (value: string) => /^[a-f0-9]{64}$/.test(value);

/** Owner-facing binding/inbox status and its next action; a read with no side effects (callers check the owner). */
export function readTelegramStatus(tx: AppTransaction, config: AppConfig): TelegramStatus {
  const binding = readBinding(tx), poll = readPoll(tx, config.telegram.retentionHours);
  const counts = inboxCounts(tx);
  const configured = botCredentialConfigured(config.telegram.botTokenPath);
  let nextAction = "inspect_binding";
  if (!configured) nextAction = "configure_bot_token_secret";
  else if (poll.gapState === "possible_missing_inputs") nextAction = "inspect_possible_missing_inputs";
  else if (binding.state === "unbound") nextAction = "bind_numeric_owner";
  else if (binding.state === "pending") nextAction = "confirm_challenge_or_wait";
  else if (counts.failedCount > 0) nextAction = "inspect_failed_inbox";
  else if (counts.unauthorizedCount > 0) nextAction = "inspect_unauthorized_events";
  else nextAction = "poll_and_inspect";
  return { binding, poll, ...counts, botCredentialConfigured: configured, nextAction };
}

/** Opaque session-backed capability for Telegram owner setup; model payloads cannot mint it. */
export interface TelegramOwnerActor {
  readonly ownerId: "owner";
  readonly channel: "web";
}

export interface TelegramChannelOptions {
  now?: () => number;
  beforeCommit?: (stage: "inbox" | "offset" | "binding" | "receipt") => void;
  transport?: TelegramUpdateTransport;
}

/**
 * telegram.owner_binding/v1 and telegram.durable_inbox/v1.
 * Web HTTP routes are deferred; this channel is the owner-authenticated contract they will call.
 */
export class TelegramChannel {
  #actors = new WeakMap<TelegramOwnerActor, string>();
  #now: () => number;
  #beforeCommit: TelegramChannelOptions["beforeCommit"];
  #transport: TelegramUpdateTransport | undefined;
  #backoffMs: number;

  constructor(readonly store: TransactionStore, readonly config: AppConfig, options: TelegramChannelOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#beforeCommit = options.beforeCommit;
    this.#transport = options.transport;
    this.#backoffMs = config.telegram.pollBackoffMs;
  }

  /** Issues a Telegram setup actor from a live Web session token without accepting forged objects. */
  authenticate(sessionToken: string): TelegramOwnerActor {
    if (!validToken(sessionToken)) throw new AppError("authentication_required", 401);
    const key = digest(sessionToken);
    this.store.read(tx => this.#session(tx, key));
    const actor: TelegramOwnerActor = Object.freeze({ ownerId: "owner", channel: "web" });
    this.#actors.set(actor, key);
    return actor;
  }

  /** Owner binding/status projection for Web inspection, revoke/rebind and gap acknowledgement. */
  status(actor: TelegramOwnerActor): TelegramStatus {
    return this.store.read(tx => {
      this.#requireOwner(tx, actor);
      return readTelegramStatus(tx, this.config);
    });
  }

  /** Bounded unauthorized/mismatched event inspection; these events never mutate project state. */
  events(actor: TelegramOwnerActor, after = 0, classification?: string): TelegramEventPage {
    return this.store.read(tx => {
      this.#requireOwner(tx, actor);
      return readEvents(tx, after, this.config.pageSize, classification);
    });
  }

  /** Commits bind/confirm/revoke/ack_gap with command receipts under the owner receipt namespace. */
  execute(actor: TelegramOwnerActor, command: TelegramBindingCommand): TelegramBindingReceipt {
    const payloadHash = bindingIdentity(command);
    return this.store.transaction(tx => {
      this.#requireOwner(tx, actor);
      const prior = tx.get<{ payload_hash: string; result_json: string }>(
        "SELECT payload_hash, result_json FROM command_receipts WHERE actor_id = 'owner' AND request_id = ?", command.requestId);
      if (prior) {
        if (prior.payload_hash !== payloadHash) throw new AppError("request_id_conflict", 409);
        return JSON.parse(prior.result_json) as TelegramBindingReceipt;
      }
      const result = mutateBinding(tx, command, this.config.telegram, this.#now());
      this.#beforeCommit?.("binding");
      tx.run("INSERT INTO command_receipts VALUES ('owner', ?, ?, ?, ?)", command.requestId, payloadHash, JSON.stringify(result), this.#now());
      tx.run("INSERT INTO audit (actor_id, command_kind, request_id, project_id, committed_at) VALUES ('owner', ?, ?, 'telegram', ?)",
        command.kind, command.requestId, this.#now());
      this.#beforeCommit?.("receipt");
      return result;
    });
  }

  /**
   * Ingests one scripted getUpdates batch: persist inbox rows, then advance offset.
   * A crash before persistence does not acknowledge; duplicates remain one logical event.
   */
  ingest(updates: unknown[]): TelegramInboxEvent[] {
    const now = this.#now();
    const persisted = this.store.transaction(tx => {
      noticeRetentionGap(tx, this.config.telegram, now);
      const { events, maxUpdateId } = persistUpdates(tx, updates, this.config.telegram, now);
      this.#beforeCommit?.("inbox");
      return { events, maxUpdateId };
    });
    if (persisted.maxUpdateId != null) {
      this.store.transaction(tx => {
        // Hook fires before the cursor write so a crash leaves inbox rows without acknowledgment.
        this.#beforeCommit?.("offset");
        advanceOffset(tx, persisted.maxUpdateId!, now);
      });
    } else {
      this.store.transaction(tx => { tx.run("UPDATE telegram_poll SET last_poll_at = ? WHERE id = 1", now); });
    }
    this.#backoffMs = this.config.telegram.pollBackoffMs;
    return persisted.events;
  }

  /** Durable cursor used by the next getUpdates call. */
  nextOffset(): number {
    return this.store.read(tx => readPoll(tx, this.config.telegram.retentionHours).nextOffset);
  }

  /** Runs one transport poll when a scripted transport is configured; never opens a live bot by default. */
  async pollOnce(): Promise<TelegramInboxEvent[]> {
    if (!this.#transport) throw new AppError("telegram_transport_unavailable", 503);
    const offset = this.nextOffset();
    try {
      const updates = await this.#transport.getUpdates(offset);
      return this.ingest(updates);
    } catch (error) {
      this.#backoffMs = Math.min(this.#backoffMs * 2, this.config.telegram.maxPollBackoffMs);
      throw error instanceof AppError ? error : new AppError("telegram_poll_failed", 503);
    }
  }

  /** Current bounded backoff after transport failures. */
  pollBackoffMs(): number { return this.#backoffMs; }

  /** Processes persisted authorized/failed events with a bounded attempt budget. */
  process(onAuthorized?: (event: TelegramInboxEvent) => void): TelegramInboxEvent[] {
    return this.store.transaction(tx => processPersisted(tx, this.config.telegram, this.#now(), onAuthorized));
  }

  /**
   * Runs telegram.project_commands/v1 for authorized inbox rows, then commits outbox replies.
   * Inbound content stays untrusted until this boundary maps it to Application.execute.
   */
  processProjectCommands(commands: TelegramProjectCommands): TelegramInboxEvent[] {
    const events = this.process(event => {
      if (event.classification !== "authorized") return;
      // One savepoint rolls back both the command and its reply if either cannot commit.
      this.store.transaction(tx => {
        const raw = tx.get<{ raw_json: string }>("SELECT raw_json FROM telegram_inbox WHERE sequence = ?", event.sequence);
        if (!raw) throw new AppError("telegram_event_missing");
        const outcome = commands.handle(event, JSON.parse(raw.raw_json) as TelegramUpdate);
        commands.commitReply(outcome, event);
      });
    });
    // Native/model/transport work starts only after inbox + command + reply commit.
    commands.pump();
    return events;
  }

  /** Escape-safe HTML fragment for a future Web status page; no secrets or raw tokens. */
  renderStatusHtml(actor: TelegramOwnerActor): string {
    const status = this.status(actor);
    const esc = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const binding = status.binding;
    const ids = binding.state === "unbound" ? "none" :
      `user ${binding.telegramUserId ?? "?"} / chat ${binding.telegramChatId ?? "?"}`;
    return `<section data-telegram-status="1">
<h2>Telegram companion</h2>
<p>State: ${esc(binding.state)} (revision ${binding.revision})</p>
<p>Bound IDs: ${esc(ids)}</p>
<p>Gap: ${esc(status.poll.gapState)}</p>
<p>Unauthorized events: ${status.unauthorizedCount}; failed: ${status.failedCount}; pending authorized: ${status.pendingAuthorizedCount}</p>
<p>Bot credential configured: ${status.botCredentialConfigured ? "yes" : "no"}</p>
<p>Next action: ${esc(status.nextAction)}</p>
</section>`;
  }

  #session(tx: AppTransaction, key: string): void {
    const row = tx.get<{ token_hash: string }>(`SELECT s.token_hash FROM sessions s JOIN owner o ON o.id = s.owner_id
      WHERE s.token_hash = ? AND s.expires_at > ? AND s.generation = o.generation`, key, this.#now());
    if (!row) throw new AppError("authentication_required", 401);
  }

  #requireOwner(tx: AppTransaction, actor: TelegramOwnerActor): string {
    const key = actor && this.#actors.get(actor);
    if (!key) throw new AppError("authentication_required", 401);
    this.#session(tx, key);
    return key;
  }
}
