---
status: accepted for TG02 engineering choices (Jit #21)
scope: Telegram project follow-up and task acceptance through Application
---

# Map authorized Telegram input to shared Application commands

## Confirmed decisions and required behavior

FR-01/06/07/10/11/15/17 and NFR-07/10/11 require a bound owner to issue project-scoped follow-ups and task accept/edit commands from Telegram without a parallel task store, without implicit project selection by name, and without model text granting authority. Callbacks carry bounded server-side references; stale references surface the current proposal revision. Committed replies use `delivery.outbox/v1`.

## Selected implementation

TG02 adds `ensureTelegramProjectSchema` tables (`telegram_project_context`, `telegram_callback_refs`, `telegram_message_commands`) via `CREATE IF NOT EXISTS` inside transactions, deferring formal `user_version` migration to store ownership (same pattern as PR01).

`TelegramProjectCommands` holds a live installation session and issues a registered `telegram` actor for all supported Application reads, task edits/acceptance, `team.dispatch`, and `delivery.commit`. The shared Application extension is supplied by TASK02; no Web actor impersonation remains. Configuration, owner decisions, project creation, job administration and delivery resend/retire remain Web-only.

Every processed event is read from the persisted inbox and reclassified against the current numeric owner binding. A changed binding fences already-ingested commands. Explicit `/bind <projectId> <topicId> [contextRevision]` sets chat context; replacing an existing context requires its revision. Idempotently binding the same identities leaves that revision unchanged. Callbacks include the binding and context revisions, project, topic, exact task/proposal and expected task revision. Opaque references use 32 random hexadecimal characters beneath `tg/1/`, expire after 24 hours, never overwrite another reference, and are capped at 4096 unexpired records.

`/tasks` emits bounded acceptance references usable by callback fixtures or `/accept <reference>`. `/follow` admits team work through Application. `/task edit <taskId> <revision> | <title> | <summary>` requires the owner's explicit revision and a proposed task in the bound topic. Edited input never changes an already committed command; it returns an explicit conflict and current task state.

`TelegramChannel.processProjectCommands` uses a per-event transaction/savepoint so application command and outbox reply roll back together on storage failure. Queue pumping and fixture sends happen only after the surrounding inbox transaction commits. Project replies use the existing delivery outbox and canonical project/topic/task/proposal references. Help and project-selection replies cannot invent a project context: `TelegramControlOutbox` is a project-free channel-control extension using the same `DeliverySender` contract. It records the invocation before send, owner generation and binding revision, a 24-hour deadline, at most three safe transport attempts, and visible sent/failed/unknown/cancelled state. Interrupted or uncertain sends are never automatically resent. Its finite inventory limit is 1024 replies; reaching it reports a processing failure rather than deleting history silently.

All transport verification remains fixture-backed. This slice does not introduce a production bot client, paid inference, account setup, or a live polling loop.

## Alternatives and consequences

Parsing natural-language acceptances would violate FR-11. A separate Telegram task store would diverge from Web. Advancing team dispatch without Application.execute would bypass receipts and revision checks.

Exact surfaces are in [telegram-project-commands-v1](../contracts/telegram-project-commands-v1.md). Evidence is `tests/telegram.test.ts` TG02 cases with scripted Application adapters and `ScriptedTelegramSender`.
