/**
 * Fixture-backed private send. Implementations must not receive a bot token or request headers.
 * A scripted result is not proof of production Telegram access.
 */
export interface DeliverySendInput {
  chatId: number;
  text: string;
  dedupeKey: string;
}

/** Known remote results. Exceptions after the call begins are unknown, not a definitive rejection. */
export type DeliverySendResult =
  | { outcome: "sent"; messageId: number }
  | { outcome: "failed"; reason: "telegram_rejected" | "telegram_unavailable"; retryable: boolean }
  | { outcome: "unknown" };

/** Transport used by the delivery worker. Live Bot API clients are out of scope. */
export interface DeliverySender {
  send(input: DeliverySendInput): DeliverySendResult;
}

export type SenderScript = "accept" | "reject" | "timeout_after_accept" | "safe_failure" | "throw_secret";

/**
 * Deterministic Telegram stand-in for `delivery.outbox/v1` tests.
 * `external` can contain a message even when the local outcome is unknown, so exactly-once delivery is not claimed.
 */
export class ScriptedTelegramSender implements DeliverySender {
  readonly external: { messageId: number; text: string; dedupeKey: string }[] = [];
  calls = 0;
  scripts: SenderScript[] = ["accept"];
  /** Present only so a test can prove the value is dropped. It is never written to the store. */
  secret = "";
  /** Runs after the worker has invoked send and before the scripted result, so revocation can race an in-flight call. */
  hook?: () => void;

  send(input: DeliverySendInput): DeliverySendResult {
    this.calls += 1;
    const mode = this.scripts[Math.min(this.calls - 1, Math.max(0, this.scripts.length - 1))] ?? "accept";
    this.hook?.();
    if (mode === "throw_secret") throw new Error(`Authorization: Bearer ${this.secret}`);
    if (mode === "reject") return { outcome: "failed", reason: "telegram_rejected", retryable: false };
    if (mode === "safe_failure") return { outcome: "failed", reason: "telegram_unavailable", retryable: true };
    const messageId = this.external.length + 1;
    this.external.push({ messageId, text: input.text, dedupeKey: input.dedupeKey });
    if (mode === "timeout_after_accept") return { outcome: "unknown" };
    return { outcome: "sent", messageId };
  }
}
