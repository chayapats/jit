import type { AppConfig } from "../config";
import { DeliveryWorker, type DeliverySender } from "../delivery";
import { AppError } from "../errors";
import type { TransactionStore } from "../store";
import { TelegramChannel } from "../telegram/channel";
import { TelegramControlOutbox } from "../telegram/control-outbox";
import { readBotToken } from "../telegram/secrets";
import type { TelegramUpdateTransport } from "../telegram/types";
import { upgradeFenced } from "./upgrade-fence";

/**
 * Transports one Telegram channel instance uses: the delivery.outbox/v1
 * sender (reports, reminders, PR alerts and control replies) and the
 * telegram.durable_inbox/v1 getUpdates poller. Implementations receive the
 * bot token only through this factory call; it is never stored, logged or
 * placed in a request record.
 */
export interface ChannelTransports {
  sender: DeliverySender;
  updates: TelegramUpdateTransport;
}

/** Builds transports for a verified bot token. Tests inject fixtures; no live Bot API client ships in this build. */
export type ChannelTransportFactory = (input: { botToken: string; config: AppConfig }) => ChannelTransports;

/** Channel activation verdict, shared by preflight (gate `channels`) and boot. */
export type ChannelReadiness =
  | { state: "disabled"; detail: string }
  | { state: "ready"; detail: string }
  | { state: "blocked"; nextAction: string; detail: string };

/**
 * Checks whether the opt-in Telegram channel can start: it must be enabled,
 * its bot-token credential file readable with owner-only mode, and a
 * supported transport registered. Never reads the token into a result.
 */
export function channelReadiness(input: { enabled: boolean; botTokenPath: string; transports: ChannelTransportFactory | undefined }): ChannelReadiness {
  if (!input.enabled) return { state: "disabled", detail: "telegram channel not enabled; no delivery worker or poller starts" };
  try {
    if (readBotToken(input.botTokenPath) === null) return { state: "blocked", nextAction: "configure-telegram-bot-token-reference", detail: "telegram bot token reference missing" };
  } catch (error) {
    const code = error instanceof AppError ? error.code : "telegram_token_unreadable";
    return { state: "blocked", nextAction: code === "telegram_token_permissions" ? "restrict-telegram-token-file" : "verify-telegram-token-file", detail: `telegram secret blocked: ${code}` };
  }
  if (!input.transports) return { state: "blocked", nextAction: "install-supported-telegram-transport", detail: "telegram transport unavailable in this build" };
  return { state: "ready", detail: "telegram token reference readable; transport registered" };
}

/** Outcome of one pump tick; counts only, never payload text. */
export interface ChannelTick { sent: number; pollStarted: boolean; fenced: boolean }

/**
 * The service's channel runtime: one delivery worker (claims
 * delivery_worker ownership, so a second instance cannot send) and one
 * Telegram channel that persists inbound updates before acknowledging them.
 *
 * Inbound project commands are not executed here: telegram.project_commands/v1
 * requires an owner session, and the service never mints owner authority
 * from process identity, network address or a health request. Authorized
 * inbox rows stay persisted for an owner-authenticated adapter.
 */
export class ServiceChannels {
  #worker: DeliveryWorker;
  #channel: TelegramChannel;
  #control: TelegramControlOutbox;
  #sender: DeliverySender;
  #now: () => number;
  #nextPoll = 0;
  #polling: Promise<void> | null = null;
  #closed = false;

  private constructor(store: TransactionStore, config: AppConfig, transports: ChannelTransports, now: () => number) {
    this.#now = now;
    this.#sender = transports.sender;
    // Constructing the worker reconciles interrupted attempts: an invoked send becomes `unknown`, never `sent`.
    this.#worker = new DeliveryWorker(store, { sender: transports.sender, now });
    try {
      this.#channel = new TelegramChannel(store, config, { now, transport: transports.updates });
      this.#control = new TelegramControlOutbox(store, now);
    } catch (error) { this.#worker.close(); throw error; }
  }

  /** Starts channels after preflight; throws when readiness is blocked (fail closed). */
  static start(store: TransactionStore, config: AppConfig, factory: ChannelTransportFactory, now: () => number = Date.now): ServiceChannels {
    const token = readBotToken(config.telegram.botTokenPath);
    if (token === null) throw new AppError("telegram_token_missing", 503);
    const transports = factory({ botToken: token, config });
    if (typeof transports?.sender?.send !== "function" || typeof transports?.updates?.getUpdates !== "function") {
      throw new AppError("telegram_transport_unavailable", 503);
    }
    return new ServiceChannels(store, config, transports, now);
  }

  get telegram(): TelegramChannel { return this.#channel; }

  /**
   * One bounded tick: sends ready intents and control replies, then starts
   * at most one getUpdates poll when its backoff elapsed. Under an upgrade
   * or restore fence nothing sends or polls.
   */
  tick(): ChannelTick {
    if (this.#closed) return { sent: 0, pollStarted: false, fenced: false };
    if (upgradeFenced(this.#worker.store.path)) return { sent: 0, pollStarted: false, fenced: true };
    let sent = 0;
    try { sent = this.#worker.pump().length; } catch { /* Ownership/storage failure: the next tick or restart reconciles. */ }
    try { this.#control.pump(this.#sender); } catch { /* Same fencing as the outbox. */ }
    const now = this.#now();
    const pollStarted = !this.#polling && now >= this.#nextPoll;
    if (pollStarted) {
      this.#polling = this.#channel.pollOnce()
        .then(() => { this.#nextPoll = this.#now() + this.#channel.pollBackoffMs(); })
        .catch(() => { this.#nextPoll = this.#now() + this.#channel.pollBackoffMs(); })
        .finally(() => { this.#polling = null; });
    }
    return { sent, pollStarted, fenced: false };
  }

  /** Waits for an in-flight poll (tests and drain). */
  async settled(): Promise<void> { await this.#polling; }

  /** Stops sending and polling and releases delivery_worker ownership. */
  async close(): Promise<void> {
    this.#closed = true;
    try { await this.#polling; } catch { /* Poll errors are already recorded as backoff. */ }
    this.#worker.close();
  }
}
