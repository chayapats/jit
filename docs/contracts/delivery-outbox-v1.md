# Delivery outbox, v1

Owner: Jit #13 (TG03). Contract: `delivery.outbox/v1`. Implementation: `src/delivery/outbox.ts`, `src/application.ts`, `src/web.ts`. Requires schema v7, `app.transaction_store/v1`, `app.owner_identity/v1` and `jobs.attempt_fence/v1` (`fenceDenied`). FR-07/09/11/15/18, NFR-05/07/10. Read alongside [ADR 0014](../adr/0014-delivery-outbox.md) and [ADR 0085](../adr/0085-remove-telegram-web-push-notifications.md).

**No push transport (2026-11-06, ADR 0085, NOTIFY16-01).** Telegram was removed. The outbox now records durable in-app attention only: a committed report or reminder still creates one intent that stays visible on the project's delivery pages, but no worker, sender or channel exists, no attempt is created and nothing is ever sent. The `DeliveryWorker`, `DeliverySender`, `ScriptedTelegramSender`, `delivery.resend` (`POST .../resend`, the Send again button) and the Telegram owner binding gate are removed. Intents and attempts stored before the removal (`sent`, `failed`, `unknown`) stay readable as history; nothing reads or migrates the inert Telegram tables. The rest of this contract describes the surviving surface; transport-outcome fields remain only to read that history.

Local dedupe is the only guarantee. The contract has no exactly-once state. A persisted intent does not mark the report or reminder delivered.

## Exact public surface

```ts
commitDeliveryIntent(tx, input, now): DeliveryReceipt
readDeliveryIntent(tx, projectId, intentId): DeliveryIntent
readDeliveryReport(tx, projectId, reportId): DeliveryReport
listDeliveryIntents(tx, projectId, after, limit): DeliveryPage
listDeliveryAttempts(tx, intentId): DeliveryAttempt[]   // history only; no new attempts
retireDeliveryReport(tx, projectId, reportId, action, expectedRevision, now): DeliveryRetireReceipt
retireDeliveryIntent(tx, projectId, intentId, reason, now, { markSettledStale }): "cancelled" | "marked_stale" | "unchanged"
resolveDeliveryIntent(tx, projectId, intentId, reason, now): "cancelled" | "resolved" | "unchanged"   // REL04
deliveryCommandIdentity(command, maxBytes): string

Application.execute(actor, CommitDeliveryCommand): DeliveryReceipt
Application.execute(actor, RetireDeliveryCommand): DeliveryRetireReceipt
Application.deliveries(actor, projectId, after?): { project } & DeliveryPage
Application.delivery(actor, projectId, intentId): { project; intent; report; attempts; sourceAvailable }
```

`commitDeliveryIntent` input may carry `guard` (a domain name, for example `pr-alert` from `pr.private_alerts/v1`), stored as `DeliveryIntent.guard` (absent/null on unguarded and legacy intents). There is no send-time currentness check any more (`registerDeliveryGuard` and `DeliveryGuard` were removed with the transport): the owning domain retires stale intents through `retireDeliveryIntent`. Dedupe namespace `pr-alert/` is statically reserved for guard `pr-alert`: commits in it without that guard are rejected. New intents are `waiting` with `nextAction` `in_app_only`. Credential screening of text and dedupe keys uses the shared `containsCredential` (`src/security/credentials.ts`). `cancelUnsent` never rewrites a `sent`, `unknown` or terminal `failed` intent. `scrubDeliveryIntentText(tx, intent, scrub)` rewrites only the stored text of one intent, its delivery report and the report's source version (outcome fields untouched). `retireDeliveryIntent` lets a domain cancel one unsent intent (stale + reason) or, with `markSettledStale`, mark an already sent/unknown/failed intent stale without claiming withdrawal.

Since REL04 ([delivery.attention_levels/v1](delivery-attention-levels-v1.md)), `commitDeliveryIntent` input may carry `attention: { class, item, workGroupId }` (identities only, exact shape), stored as `DeliveryIntent.attention`, and intents may carry `resolution: { reason, at } | null`. `resolveDeliveryIntent` cancels an in-app intent with the reason (`owner_answered` or `no_longer_waiting`) or, for a historical intent that already reached the removed transport, keeps the outcome and sets `resolution`; it never claims withdrawal. Producers classify their intents and the owner's level filters only creation (`commitAttentionIntent`).

`DeliveryIntent.guarantee` is `"local_dedupe_only"`. `remote` is `none`, `accepted`, `rejected` or `uncertain`, separate from `status` (`waiting`, `queued`, `claimed`, `sent`, `failed`, `unknown`, `cancelled`). `DeliveryReport` has no delivered flag. `sent`, `failed` and `unknown` (and `remote` other than `none`) appear only on intents stored before ADR 0085; new intents never reach them, and no retry or resend exists.

## HTTP

`GET /projects/:projectId/delivery` and `GET /projects/:projectId/delivery/:intentId` (and the `/api` twins) require the owner session and show the in-app notification history. `POST` the same paths require the session cookie, configured `Origin`, and CSRF. JSON fields for commit are `requestId`, `expectedRevision` (project revision), `kind`, `text`, `dedupeKey`. There is no resend route.

## Deterministic evidence

`tests/delivery.test.ts` covers atomic rollback, dedupe replay, superseded and stale reports, retire and resolve, in-app-only intents that are never sent, and historical `sent`/`failed`/`unknown` intents that stay readable. No network.
