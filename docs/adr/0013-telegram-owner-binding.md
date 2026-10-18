---
status: accepted for TG01 engineering choices (Jit #12)
scope: Telegram owner binding and durable long-poll inbox
---

# Bind numeric Telegram identity and persist updates before offset advance

## Confirmed decisions and required behavior

FR-10/11/15/17 and NFR-05/07/10 require an owner-only Telegram companion: trusted Web setup binds stable numeric user and private chat IDs; usernames, forwards, group chats, bots and stale setup never establish authority. Long polling must persist update identity and classification before advancing getUpdates offset. Telegram retains updates for at most 24 hours; downtime beyond that is a visible possible-missing-inputs gap, never reconstructed history. Inbound text stays untrusted until a later application command boundary (TG02). Bot credentials stay in the secret-file boundary.

## Selected implementation

Schema v6 adds `telegram_binding`, `telegram_poll` and `telegram_inbox` inside `app.transaction_store/v1`. `TelegramChannel` authenticates the Web owner through the existing sessions table, then exposes bind/confirm/revoke/ack_gap commands under `app.command_receipts/v1`, plus status/event inspection and an HTML fragment for a future Web surface. HTTP route wiring in `application.ts`/`web.ts` is intentionally deferred (out of this issue's reservation).

Binding is revisioned. `telegram.bind` stores intended numeric IDs and a challenge nonce; confirmation is either an exact Web confirm or a matching private message carrying that nonce. Username hints are display-only. Classification rejects group chats, forwards, bot senders, wrong numeric IDs and callbacks when unbound.

Ingestion persists classified inbox rows, then advances `next_offset` to `max(update_id)+1` in a separate commit so a crash before persistence does not acknowledge the update, while a crash after persistence still deduplicates on reopen. Processing is bounded and does not mutate projects. Poll backoff is finite. Scripted transports cover protocol fixtures; no live bot token is required for CI.

## Alternatives and consequences

Public webhooks would force ingress and TLS terminating exposure; long polling matches the architecture preference. Inferring owner identity from usernames or forward attribution fails FR-11/NFR-07. Advancing Telegram's offset before local commit can drop updates across a crash. Claiming to rebuild updates after the 24-hour retention window would invent evidence.

Exact public surfaces for this slice:

| Contract | Entry |
| --- | --- |
| `telegram.owner_binding/v1` | `TelegramChannel.authenticate`, `execute` (`telegram.bind` / `confirm` / `revoke` / `ack_gap`), `status`, `events`, `renderStatusHtml` |
| `telegram.durable_inbox/v1` | `ingest`, `pollOnce`, `nextOffset`, `process`, durable `telegram_poll.next_offset` |

Evidence: `tests/telegram.test.ts` with protocol fixtures and fake clocks. Full browser Web routes and live Bot API remain later wiring/ops work.
