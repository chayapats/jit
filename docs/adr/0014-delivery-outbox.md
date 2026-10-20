---
status: accepted for TG03 engineering choices (Jit #13)
scope: private delivery intents and honest send outcomes
---

# Record one logical intent, and keep remote outcomes separate

## Confirmed decisions and required behavior

FR-07, FR-09, FR-11, FR-15 and FR-18 require a private notification for a committed report or reminder. Local dedupe is not exactly-once delivery. A timeout after a call that may have been accepted is `unknown`, stays visible, and is not retried blindly. The owner can inspect provenance and explicitly resend, with duplicates possible. Unsent work stops when authorization, the report, or the channel binding is no longer valid. A send that already reached the transport is not described as prevented.

## Selected implementation

Schema v7 stores `delivery_reports`, `delivery_intents`, `delivery_attempts` and a single `delivery_worker` row inside `app.transaction_store/v1`. `commitDeliveryIntent` writes the report source and the logical intent in the caller's transaction. The same dedupe key returns that intent. Rollback removes both.

Claim and send use `fenceDenied` from `jobs.attempt_fence/v1`. The worker commits `senderInvoked` before calling the fixture sender. A restart before that flag can claim again. A restart after it records `unknown`. Known acceptance stores the Telegram message reference and `sent`. A structured definitive rejection is `failed`. Only `telegram_unavailable` spends a bounded safe-retry budget. Explicit resend inserts a linked authorized attempt and a `duplicates_possible` warning.

Intents committed while Telegram is unbound stay `waiting`. Revoke or a binding revision change cancels unsent work. Supersede or delete does the same. If the sender was already invoked, the later result is kept and marked stale. A newer settled attempt generation is not overwritten.

Web GET reads intents and does not send. The report source stays available when delivery is failed or unknown. Payloads, stored reasons and thrown sender errors cannot carry a bot token or headers. `ScriptedTelegramSender` is a fixture, not production Bot API access.

## Alternatives and consequences

Routing sends through the job queue would reuse admission, but that queue treats a stale fence as "do not publish" and would drop the in-flight transport result. Delivery keeps the job fence predicate and applies the outcome even when the report or binding changed during the call.

Automatic retry of `unknown` could duplicate a message Telegram already accepted. The owner must resend on purpose. Fixture acceptance is not evidence that a live bot token works.

Exact surfaces are in [delivery-outbox-v1](../contracts/delivery-outbox-v1.md). Evidence is `tests/delivery.test.ts`.
