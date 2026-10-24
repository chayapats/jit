# Delivery outbox, v1

Owner: Jit #13 (TG03). Contract: `delivery.outbox/v1`. Implementation: `src/delivery/outbox.ts`, `src/delivery/sender.ts`, `src/application.ts`, `src/web.ts`. Requires schema v7, `app.transaction_store/v1`, `app.owner_identity/v1`, `jobs.attempt_fence/v1` (`fenceDenied`) and `telegram.owner_binding/v1` as the channel gate. FR-07/09/11/15/18, NFR-05/07/10. Read alongside [ADR 0014](../adr/0014-delivery-outbox.md).

Local dedupe is the only guarantee. The contract has no exactly-once state. A persisted intent or a started transport request does not mark the report or reminder delivered.

## Exact public surface

```ts
commitDeliveryIntent(tx, input, now): DeliveryReceipt
readDeliveryIntent(tx, projectId, intentId): DeliveryIntent
readDeliveryReport(tx, projectId, reportId): DeliveryReport
listDeliveryIntents(tx, projectId, after, limit): DeliveryPage
listDeliveryAttempts(tx, intentId): DeliveryAttempt[]
resendDeliveryIntent(tx, projectId, intentId, expectedRevision, now): DeliveryResendReceipt
retireDeliveryReport(tx, projectId, reportId, action, expectedRevision, now): DeliveryRetireReceipt
retireDeliveryIntent(tx, projectId, intentId, reason, now, { markSettledStale }): "cancelled" | "marked_stale" | "unchanged"
registerDeliveryGuard(name, check: DeliveryGuard): void
recordDeliveryResult(tx, attemptId, result, now): DeliveryIntent
deliveryCommandIdentity(command, maxBytes): string

class DeliveryWorker {
  constructor(store, options: { sender: DeliverySender; now?; leaseMs?; pid?; isAlive?; crash? })
  claimNext(): DeliveryAttempt | null
  sendClaimed(attemptId): DeliveryIntent
  pump(): DeliveryIntent[]
  close(): void
}

interface DeliverySender { send(input: { chatId: number; text: string; dedupeKey: string }): DeliverySendResult }
class ScriptedTelegramSender implements DeliverySender

Application.execute(actor, CommitDeliveryCommand): DeliveryReceipt
Application.execute(actor, ResendDeliveryCommand): DeliveryResendReceipt
Application.execute(actor, RetireDeliveryCommand): DeliveryRetireReceipt
Application.deliveries(actor, projectId, after?): { project } & DeliveryPage
Application.delivery(actor, projectId, intentId): { project; intent; report; attempts; sourceAvailable }
```

`commitDeliveryIntent` input may carry `guard` (a registered guard name, for example `pr-alert` from `pr.private_alerts/v1`), stored as `DeliveryIntent.guard` (absent/null on unguarded and legacy intents). `DeliveryGuard = (tx, intent) => DeliveryCurrentness` runs in the claim and send transactions after the owner/source checks and before the channel check, and again in `recordDeliveryResult`. `{ current: false, hold: true }` keeps the intent `waiting` with `nextAction` `wait_for_current_source`; any other non-current verdict cancels unsent work with `stale: true` and the verdict reason; a result landing after drift is kept and marked stale. An unregistered guard or a throwing check holds the intent (`currentness_unavailable`) instead of sending. `retireDeliveryIntent` lets a domain cancel one unsent intent (stale + reason) or, with `markSettledStale`, mark an already sent/unknown/failed intent stale without claiming withdrawal.

`DeliveryIntent.guarantee` is `"local_dedupe_only"`. `remote` is `none`, `accepted`, `rejected` or `uncertain`, separate from `status` (`waiting`, `queued`, `claimed`, `sent`, `failed`, `unknown`, `cancelled`). `DeliveryReport` has no delivered flag. `DeliveryResendReceipt.warning` is `"duplicates_possible"`.

`DeliverySendResult` is `sent` with a message id, `failed` with `telegram_rejected` or `telegram_unavailable`, or `unknown`. Exceptions after `senderInvoked` are stored as `unknown` and the thrown text is discarded. Safe automatic retries apply only to `telegram_unavailable` while `safeRetriesRemaining` stays above zero (initial budget 2).

## HTTP

`GET /projects/:projectId/delivery` and `GET /projects/:projectId/delivery/:intentId` (and the `/api` twins) require the owner session and do not send. `POST` the same paths, and `POST .../resend`, require the session cookie, configured `Origin`, and CSRF. JSON fields for commit are `requestId`, `expectedRevision` (project revision), `kind`, `text`, `dedupeKey`. Resend fields are `requestId` and `expectedRevision` (intent revision).

## Deterministic evidence

`tests/delivery.test.ts` covers atomic rollback, reopen before send, after claim, after remote acceptance and before the local response commit, timeout-after-accept, definitive rejection, duplicate lease, revoked binding, superseded report, the safe retry limit, explicit resend, and a scripted sender whose external log can contain a duplicate the local intent does not call exactly-once. No live bot and no network.
