---
status: accepted for CHAN15-01 (#368) and WORK15-02 (#367) engineering choices
date: 2026-11-03
scope: CHAN15-01, WORK15-02; FR-04/10/11/14/15/17/18/19/22/23/26/28; NFR-05/07/08/10; S15-AC01/07/15
---

# S15 Telegram owner channel and durable stall-reply resume

## Confirmed decisions and required behavior

- Telegram is a **bound owner conversation and notification channel** for S15. A private message from the bound owner is an ordinary owner conversation request with the same authority and checks as the Web composer, under the same standing policy ([S15](../specs/S15-conversational-autonomy.md), S15-AC01).
- **Approvals stay in the Web UI.** The S15 UX Q4 default, accepted on 2026-11-03, is that companion channels notify and link to the exact Web slip ([S15 experience](../design/S15-conversational-experience.md) §15). Nothing typed in Telegram approves a held action, installs policy, widens scope or resumes work outside WORK's own checks. This narrows ADR 0037's legacy Telegram approval cards; it does not change the legacy `src/telegram` runtime.
- The **ADR 0013 binding rules** apply on the S15 store: only stable numeric user and private chat IDs carry identity. Usernames are display-only. Groups, channels, forwards, bot senders, other users and stale codes never bind or reach the conversation. Updates are persisted with their classification before the `getUpdates` offset advances. Downtime beyond Telegram's 24-hour retention is shown as a visible gap, never reconstructed.
- The owner decided (2026-11-03) that the new production install gets a new bot created in BotFather by the owner. The token is pasted once into protected Web settings. It is never placed in configuration files, environment variables, logs, exports, prompts or the guest.
- An owner's reply to a stall report must resume the responsibility exactly once after that reply completes, including across a restart (S15-D22, S15-AC15).

## Selected implementation

### WORK15-02 resume binding

`openResumeBindings` (`src/s15/work/resume.ts`) adds the versioned `resume_bindings_v1` table to the protected conversation journal. The row references the request it binds and holds the duty ID, conversation ID, owner identity and generation snapshot, creation time, state (`pending`, `resumed` or `refused`) and refusal code. `submit` commits the owner's reply and its binding in one conversation-journal writer transaction. There is no window where the request exists without its binding. It refuses a continuation, an already accepted request ID and a responsibility that is not paused in the same conversation.

`settle` runs in the composed service drain after `conversation.drain()`. The Web handler also calls it after its own wake, but holds no resume state in memory. A binding settles only after its request reaches a terminal state. A request that is not `completed` with authority records `execution_not_authorized`. Otherwise WORK `resume` applies its own checks: after the pause, same scope, completed fresh owner message and current work authority.

**Authority without a live Web session.** The authenticated owner request that created the binding is the authorization. Settlement re-establishes that owner through a process-local, non-serializable composition proof. The proof's check returns the snapshot principal only while the owner generation is unchanged, and POLICY re-verifies it on every call. A changed generation records `owner_changed`, and revoked scope records WORK's or POLICY's own code. Settlement runs inside the conversation writer lock. Before calling `resume`, it reads WORK's projection: if the duty already shows this request as its ready event or an attempt, an earlier pass committed WORK and lost the binding commit, so the binding is marked `resumed` without a second call. Settled rows are retained up to a bound (256 by default), and pending rows are never evicted.

### CHAN15-01 Telegram channel

`openTelegramChannel` (`src/s15/telegram/`) adds versioned tables to the same protected conversation journal: `telegram_state_v1` (bot identity, revisioned binding and poll cursor), `telegram_inbox_v1`, `telegram_outbox_v1` and `telegram_events_v1`. The token is stored only in the S15 `ConnectionVault` under a derived key. Its fingerprint is registered before first use so any echo is redacted. `getMe` verifies the token before storage. Replacing the token with a different bot resets the binding and cursor.

**Binding.** In the Web UI, the owner creates a one-time code (12 characters, about 59 bits, valid for 10 minutes, withdrawn after 5 wrong codes). The page offers a `t.me/<bot>?start=<code>` link. The code binds only from a private, human, non-forwarded chat whose user ID equals the chat ID, and it binds that numeric user and chat. Revoke, token removal and a changed owner generation stop authorization at once, because every channel owner actor is re-verified against the current binding revision and generation.

**Ingestion.** Long polling, with no webhook and no inbound exposure. Commit 1 persists every update's identity and classification. Commit 2 advances the offset past durably recorded updates only. A crash between them makes Telegram re-deliver, and the `(bot_id, update_id)` uniqueness dedupes. Processing submits through the same conversation port as the Web composer, in the same writer transaction that marks the inbox row processed. The request ID is derived from bot and update IDs, so a replay submits at most once. Text only in this slice: media, voice and attachments get a short "not supported here yet" reply, and edits and callbacks are ignored. Credential-shaped text is not stored and gets a refusal notice. Decision-shaped text (`approve`, `อนุมัติ`, `approve <id>`) is never submitted and gets a pointer to the Web page. Composition also refuses `decideAction`/`decidePending` for channel actors as defense in depth. Quotes, entities and reply targets carry no authority.

**Stall replies.** A reply to a delivered stall-report message names that responsibility. If it is still paused, the message is submitted into the responsibility's own conversation through `ResumeBindingPort.submit`, the WORK15-02 path. Any other reply is an ordinary message in the chat's own conversation.

**Outbound.** The drain derives notices from conversation and responsibility state, each keyed by a stable event ID recorded once in `telegram_events_v1`:

- the final reply for a request that came from Telegram, with a link to the exact Web thread;
- one sparse progress notice after two minutes;
- needs-you, question and stopped status lines;
- one stall report per pause, with the recommendation labelled as Jit's suggestion;
- held-action notices that link to `/actions/<id>?r=<revision>`.

Messages are plain text with no parse mode, so no owner or model text can become formatting or a hidden link. Link previews are disabled. Long text is split within 4096 UTF-16 code units at line or word boundaries. Credential-shaped notices are replaced by a pointer to the Web page.

Each part is marked `sending` and committed before the network call. A definite refusal (`ok:false`, for example 429 with `retry_after`) returns the part to `pending` for after that delay. A network failure, 5xx or interrupted send becomes `unknown` and is never repeated automatically; the settings page counts these deliveries. Sends are spaced (one per second by default).

**UI.** `/resources/telegram` holds the token (write-only), bot name, binding code and status, revoke, removal, last poll, gap acknowledgement and counts, in th and en. It is authored per the project's UI rule and follows S15 Web conventions: no-script forms with session, Origin and CSRF checks, and no approve control.

## Alternatives and consequences

- *Separate `telegram.sqlite` store.* Rejected: it would change the composition manifest, which existing installations verify on reopen. It would also lose the single writer transaction that makes inbox processing and conversation submission atomic.
- *Approve inside Telegram (ADR 0037 cards).* Rejected for S15 by the Q4 default: a chat button cannot show the exact final content or carry the Web slip's exact revision and hash.
- *Owner types numeric IDs, as in legacy ADR 0013.* Replaced by a code-only flow (just-works). The code is the proof and the IDs come from Telegram itself.
- *Resend unknown outbound messages.* Rejected: Telegram has no idempotency key, so a blind resend could deliver twice.
- Consequences: a queued request whose process was lost before running stays queued, an existing CHAT limitation, so its binding stays pending until the owner stops it. No live bot exists in CI. The owner's live check on `jit-vm` (#341) remains separate evidence.
