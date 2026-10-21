---
status: accepted for TG02 engineering choices (Jit #21)
scope: Telegram project follow-up and task acceptance through Application
---

# Map authorized Telegram input to shared Application commands

## Confirmed decisions and required behavior

FR-01/06/07/10/11/15/17 and NFR-07/10/11 require a bound owner to issue project-scoped follow-ups and task accept/edit commands from Telegram without a parallel task store, without implicit project selection by name, and without model text granting authority. Callbacks carry bounded server-side references; stale references surface the current proposal revision. Committed replies use `delivery.outbox/v1`.

## Selected implementation

TG02 adds `ensureTelegramProjectSchema` tables (`telegram_project_context`, `telegram_callback_refs`, `telegram_message_commands`) via `CREATE IF NOT EXISTS` inside transactions, deferring formal `user_version` migration to store ownership (same pattern as PR01).

`TelegramProjectCommands` holds a live Web session token, issues `issueAdapterActor(..., "telegram")` for `app.task_commands/v1`, and uses the authenticated Web actor for `team.dispatch` and `delivery.commit` until Application expands telegram channel authorization for TEAM02 (follow-up receipts remain owner-authorized and deduped).

Explicit `/bind <projectId> <topicId>` sets revisioned chat context verified against `topics(project_id, id)`. `/projects` lists immutable IDs; `/tasks` renders accept callback refs; `/follow` dispatches team analysis; `/task edit` edits proposed tasks. Callback data uses `tg/1/<8-hex>` keys into `telegram_callback_refs`. Edited messages after accept produce conflict text, not silent mutation.

`TelegramChannel.processProjectCommands` reads persisted `raw_json`, calls the processor, and commits outbox replies with per-inbox dedupe keys.

## Alternatives and consequences

Parsing natural-language acceptances would violate FR-11. A separate Telegram task store would diverge from Web. Advancing team dispatch without Application.execute would bypass receipts and revision checks.

Exact surfaces are in [telegram-project-commands-v1](../contracts/telegram-project-commands-v1.md). Evidence is `tests/telegram.test.ts` TG02 cases with scripted Application adapters and `ScriptedTelegramSender`.
