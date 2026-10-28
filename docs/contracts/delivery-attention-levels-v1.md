# Attention levels and notify-once, v1

Owner: Jit #116 (REL04). Contract: `delivery.attention_levels/v1`. Implementation: `src/delivery/attention.ts`, `src/delivery/outbox.ts` (`resolveDeliveryIntent`), `src/team/work-group.ts`, hooks in `src/team/jit-reply.ts`, `src/team/jit-dispatch.ts`, `src/team/dispatch.ts`, `src/jobs/schedules.ts`, `src/pr/alerts.ts`, `src/application.ts`, `src/ops/lifecycle.ts`, Web in `src/web.ts` and `settingsPage` (`src/web-layout.ts`). Requires `delivery.outbox/v1`, `app.jit_reply/v1`, `app.team_dispatch/v1`, `app.dispatch_allowance/v1`, `jobs.quiet_outcomes/v1` and `jobs.attempt_fence/v1`. FR-28, FR-09, FR-11, FR-15, NFR-05, NFR-10. Read alongside [ADR 0032](../adr/0032-quiet-outcomes-and-attention-levels.md) ("Attention levels", "Notify once") and [ADR 0014](../adr/0014-delivery-outbox.md).

The level decides only which delivery intents are *created*. It never hides, deletes or rewrites a report, decision, reply, specialist result or history row, and a level change never cancels an intent that already exists. ADR 0014 is unchanged: one logical intent per notice, remote outcomes stay separate, `unknown` is never retried blindly.

## Exact public surface

```ts
type AttentionChannel = "telegram" | "web";
type AttentionLevel = "all" | "needs-me";
type AttentionClass = "needs_owner" | "informational";
interface AttentionSetting { channel; level; revision: number; updatedAt: number | null }
interface SetAttentionCommand { kind: "attention.set"; requestId; projectId: null; expectedRevision: number;
  payload: { channel: AttentionChannel; level: AttentionLevel } }

readAttentionLevel(tx, channel): AttentionSetting          // default { level: "all", revision: 0, updatedAt: null }
readAttentionLevels(tx): Record<AttentionChannel, AttentionSetting>
attentionIdentity(command): string                         // invalid_attention
writeAttentionLevel(tx, command, now): AttentionSetting    // stale_revision (per channel)
attentionAdmits(tx, channel, cls): boolean                 // needs_owner always; informational only under "all"
commitAttentionIntent(tx, input & { attention: DeliveryAttention }, now): DeliveryReceipt | null
resolveDeliveryIntent(tx, projectId, intentId, reason: "owner_answered" | "no_longer_waiting", now): "cancelled" | "resolved" | "unchanged"

openWorkGroup(tx, { projectId, topicId, replyId, now }): string
evaluateWorkGroup(tx, groupId, now, reason): void          // contained in a savepoint; never rolls back its caller
tickWorkGroups(store, now, limit = 200): number             // service start and every tick; rotating keyset pages; nothing under a fence

Application.attentionLevels(actor): Record<AttentionChannel, AttentionSetting>
Application.execute(actor, SetAttentionCommand): { attention: AttentionSetting }
```

`DeliveryIntent` gains two optional fields (absent on intents written before REL04): `attention: { class, item: string | null, workGroupId: string | null }` (identities only) and `resolution: { reason, at } | null`. `commitDeliveryIntent` accepts the same `attention` input and validates its exact shape.

## Command and storage

Schema 30 adds `attention_levels(channel PRIMARY KEY CHECK IN ('telegram','web'), level CHECK IN ('all','needs-me'), revision > 0, updated_at)` and `work_groups(id, project_id, topic_id, reply_id UNIQUE, state CHECK IN ('open','closed'), record_json, created_at, updated_at)`, both empty after migration (snapshot-before-DDL) and both classified `include` for backups. An upgraded installation therefore keeps `all` and opens no group for earlier replies.

`attention.set` is revisioned per channel (the expected revision is that channel's row), idempotent by request id (`request_id_conflict` on a different payload), validated (`invalid_attention`: exact payload keys, known channel and level), audited, and refused during upgrade or restore fences like every owner command. It accepts the Web channel's owner session.

HTTP: `GET /settings` renders section `#attention` with one form per channel (no script needed); `POST /settings/attention` (form → 303 `/settings#attention`); `GET`/`POST /api/settings/attention` (JSON, CSRF header). Labels are `settings.attention*` in Thai and English.

Web/PWA has no push transport (`web.pwa/v1`), and every outbox intent goes to Telegram. The Web level is stored, revisioned and shown, but filters nothing until a Web notification channel exists; the settings page says so (`settings.attention_web_note`).

## Classification of every intent producer

`needs_owner` items wait on the owner: a question, a proposal card, a decision awaiting acceptance, a failure or a blocked result. Every level creates them. `informational` items are created only under `all`.

| Producer | Class | Under `needs-me` |
| --- | --- | --- |
| `delivery.commit` owner command (report or reminder) | `needs_owner` (the owner asked for this notice explicitly; its receipt always carries the intent) | created |
| Schedule reminder (`scheduleReminderWork`) | `needs_owner` (the owner's own text; ADR 0032 lists reminders as always delivered) | created |
| Schedule summary `report` | `informational` | not created; the output source, occurrence (`deliveryIntentId: null`) and `lastResult` are committed as usual, and the detail page says `schedules.outcome_report_unnotified` |
| Schedule summary `failed`, provider error (REL01) | `needs_owner` (failure) | created |
| Schedule summary `no_update` | none (REL01: never an intent) | — |
| PR finding alert (`pr.private_alerts/v1`) | `informational` | not created; the report keeps the finding and the alert decision records `suppressed` / `attention_needs_me` |
| Work group final, team reply answered | `informational` | not created (recorded as `filtered`) |
| Work group final, team reply failed, or no specialist result | `needs_owner` (failure) | created |
| Work group stall: dispatch proposal card waiting on the owner | `needs_owner` (proposal card) | created |
| Work group stall: a role or the team reply waiting on its route or after an interruption | `needs_owner` (blocked result) | created |
| Work group stall: team reply could not start (`teamHold`) or settled work Jit did not answer | `needs_owner` (failure) | created |

Coordinator decision proposals and task proposals create no intent in this build. A future producer of either must classify it as `needs_owner`. A dedupe key that already has an intent always returns it (`commitAttentionIntent` never re-filters a replay).

## Work groups (notify once)

- **Group.** A Jit reply whose dispatch proposal is recorded with at least one role opens one group (`work_groups`, unique per reply) in the reply's fenced commit, whether the discussion starts under the allowance or waits on the owner's card. The id is carried as `workGroupId` in the reply's, the discussion's and the team reply's `record_json`. A reply without a dispatch opens no group and, as before REL04, creates no intent.
- **Evaluation.** `evaluateWorkGroup` reads committed state only, through the dispatch card read model (`readDispatchCard`). It runs inside the Jit reply commit, the specialist result commit (and its fenced fallback), `team.control`, `team.stop_all`, `jit.reply.stop`, `dispatch.proposal.*`, `dispatch.answer`, and `job.resume`/`job.stop` on a group job. The service also runs `tickWorkGroups` once at start and on every tick, which covers transitions the queue makes alone (a route wait, a deadline, a restart's interrupted work). Each notice key is decided once and the decision (`created` with its intent id, or `filtered`) is stored on the group row, so restarts, replayed callbacks and later level changes never add a second intent for a key.
- **Intermediate events create nothing.** A specialist result, a skip, a stop, or a team reply that is thinking.
- **Final (`final:group`).** Created once, when no participation is queued, running or waiting (including a role the owner included again after the team reply started) and the team reply's result is committed: `answered` is informational (`attention.notice_final`), `failed` is a failure (`attention.notice_failed`). A settled team with no result is a failure (`attention.notice_no_result`). The group then closes. A group the owner ended (dismissed card, `team.stop_all`, a stopped team reply) closes without a final notice; a promoted origin closes quietly.
- **Stalls.** `proposal:<proposalId>`, `job:<jobId>:<steps>` (a role or the team reply waiting), `hold:<proposalId>:<revision>` and `answer:<proposalId>` create their `needs_owner` notice immediately, while the group stays open. A job that waits again after a resume is a new key (`steps` advanced).
- **Dedupe key.** `attention/<workGroupId>/<item>`. Payload kind `report`.
- **Text.** A fixed dictionary sentence in the persona's language (`attention.notice_*`) with counts or reason codes, plus `attention.notice_open` with the page path `/projects/<p>/topics/<t>#dispatch-<proposalId>`. No model output, owner text, topic title or project name enters a notice, so data deletion has nothing to scrub there.

## Cross-channel resolution

When a stall stops waiting, the evaluation that observes it resolves its intent in that same transaction with `resolveDeliveryIntent`:

- unsent (`waiting`, `queued`, `claimed` before the sender was invoked) → `cancelled`, `failureReason` = the reason, attempts interrupted;
- already sent, `unknown`, `failed` or in flight → outcome kept, `resolution = { reason, at }`, revision + 1; a `failed` intent loses its safe automatic retry, and an in-flight send that comes back `telegram_unavailable` is not retried (`recordDeliveryResult` checks `resolution`). Nothing claims the remote message was withdrawn, and the delivery detail page says so (`delivery.resolved_*`).

The reason is `owner_answered` when an owner command caused it (accept, dismiss, answer now, resume, stop, skip, stop-all, from any channel) and `no_longer_waiting` when the item closed by itself (for example a deadline). Final notices are never resolved by condition.

## Restart safety

All state is committed: group rows, decided notice keys and intents. The service recomputes open groups at start. Jobs interrupted by a crash become `waiting`/`interrupted`, which is a blocked stall and notifies once. A group that was only queued at restart settles normally and creates exactly one final intent.

## Do not

- Hide or delete reports, decisions or history based on the level.
- Retroactively cancel intents on a level change (a stricter level only stops new informational intents).
- Retry `unknown` deliveries blindly (ADR 0014); resolution never re-sends.

## Deterministic evidence

`tests/attention-levels.test.ts` (scripted run port, fixture Telegram sender, no network): a reply that dispatches 3 specialists has 0 intents until all settle and exactly 1 after the team reply commits, also after sweeps and a reopen; one specialist stopped and one skipped still give 1 intent, and late callbacks add none; `needs-me` filters a plain team report and keeps the history, creates one intent for a proposal card, one for a failed team reply and one for a route wait; switching `all` → `needs-me` mid-group never cancels the existing intent and switching back creates nothing late; accepting a proposal on Web cancels its unsent intent, and once sent marks it resolved (shown on the detail page, never re-sent); dismiss, resume and stop-all resolve their notices; a restart while the group is queued gives exactly 1 intent; a crash with an admitted role notifies it as blocked once; `attention.set` revision, replay, conflict, validation, audit, form and JSON with CSRF, Thai and English labels and backup classification. `tests/schedule-quiet-outcomes.test.ts`: under `needs-me` a plain summary report is saved without an intent (label in both languages) while a failed summary and reminders still notify.
