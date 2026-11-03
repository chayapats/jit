# S15 Telegram owner channel

This runbook covers the opt-in S15 runtime only (CHAN15-01 #368, WORK15-02 #367). For the decisions, see [ADR 0072](../adr/0072-s15-telegram-owner-channel.md). The legacy project runtime keeps its own Telegram binding (ADR 0013/0018/0037) and is not changed. Do not reuse the Pi's legacy bot for an S15 installation.

## What it does

- The owner talks to Jit from a private Telegram chat. Each message becomes an ordinary S15 conversation request, with the same standing policy and checks as the Web composer.
- Jit sends back:
  - final replies;
  - one progress note for long work;
  - status lines (question, needs you, stopped);
  - paused-responsibility reports;
  - held-action notices that link to the exact Web slip.
- Approvals happen only on the Web page. Typing `approve`/`อนุมัติ` in Telegram approves nothing; Jit replies with a link instead.
- Replying to a paused report resumes that responsibility only through the durable WORK15-02 binding and WORK's own checks.
- Text only: photos, files, voice and edits are not taken as instructions.

## Owner setup (Web UI only)

1. Create a new bot in Telegram with `@BotFather` (`/newbot`). This is an owner step; nothing in Jit creates bots.
2. In the S15 Web UI, open **Manage → Telegram** (`/resources/telegram`). Paste the token into the write-only field and press **Check and save**. Jit calls `getMe` first and stores the token only after Telegram accepts it. The token goes to the S15 connection vault (`<config directory>/vault`) and nowhere else. It never goes into `s15-runtime/v1` configuration, an environment variable, logs, exports, prompts or the working VM.
3. Press **Create a binding code**. Use **Open chat with @bot** and press Start, or send the code yourself, from your own account in a private chat. The code is single-use, expires after 10 minutes and is withdrawn after 5 wrong codes.
4. Reload the page: it shows the bound account (numeric Telegram ID; the username is display-only), and Telegram receives a confirmation message.

Revoke unbinds the account immediately. **Stop using this bot** removes the token from the vault, unbinds the account and stops polling. Conversation history stays. Replacing the token with a different bot requires binding again. After an owner password reset or a new owner generation, the binding shows **Bind your account again**, and Telegram messages are refused until the owner rebinds.

## Operation

- `s15 serve` starts a long-poll loop (25 s wait, finite backoff from 1 s to 60 s) and a send loop. No webhook, public port or TLS endpoint is needed. If the bot has a webhook set elsewhere, the page shows `telegram_webhook_active`; remove the webhook in BotFather or with `deleteWebhook`.
- Each update is recorded with its classification before the poll offset advances. A crash between the two re-delivers the update, and it is deduplicated. A message submits at most once because its request ID is derived from the bot and update IDs.
- If Jit did not poll for longer than Telegram's 24-hour retention, the page shows **Some messages may be missing**. Jit does not guess what was lost. Ask the owner to resend anything important, then acknowledge the gap.
- An outbound send with an unknown outcome (network failure, 5xx, restart mid-send) is counted on the page and never resent automatically. Its content is still in the Web thread. A 429 is retried after Telegram's `retry_after`.
- Refused senders (groups, forwards, bots, other users, stale codes) get no reply. They are counted on the page for 7 days.

## Evidence and limits

Deterministic tests use a scripted transport and a fake clock: `tests/s15-telegram.test.ts`, `tests/s15-web-telegram.test.ts` and `tests/s15-work-resume.test.ts`. CI never calls the real Bot API. The live check is an owner step recorded on #341: the owner's new bot, bound on `jit-vm`, completes one ordinary conversation. Record installation-specific bot names and IDs in an ignored `.local` record, never in tracked files.
