# `pr.private_alerts/v1`

Owner: Jit #24 (PR03). Parent spec #1, blocks on #19 (PR02 report) and #13 (TG03 outbox).

A committed report creates a private alert only for findings that pass the visible evidence policy, with duplicate/stale suppression and delivery linkage.

## Policy

- `DEFAULT_ALERT_POLICY` v1: allowed categories `correctness,security,behavior`; `requireEvidence:true`; `requireActionable:true`. Severity never substitutes for evidence.
- `evaluateReport`: pure pass over `report.findings`; qualifying vs held with reason (`not_actionable`, `category_not_notifiable`, `evidence_required`, `payload_hygiene`, ...). Uncertainties and style/design stay in the report.

## Keys and admission

- `alertKey`: `pr-alert/<reportId>/<findingId>/v<policy>/<head12>/<policyVersion>` (hashed fallback when long). One policy evaluation admits at most one logical intent per qualifying finding; `commitDeliveryIntent` replay dedupe returns the existing intent.
- `admitReportAlerts(tx, {projectId, reportId}, now)`: inside the caller transaction,
  1. re-read report + candidate + monitor;
  2. suppress when report stale/failed/incomplete/running, monitor not active, candidate closed/superseded/cancelled/stale, or base/head/policy drift;
  3. hold policy-excluded findings;
  4. hygiene-recheck each qualifying finding (secret-like or `t.me/telegram/chat_id/sendMessage` content held);
  5. build payload + `commitDeliveryIntent(kind:report)`.
- Payload: repo `owner/name#number`, base/head short, policy, finding id/category/severity/title, location, condition, impact, evidence type/ref, report id, plus `คำเตือน: ตรวจไม่ครบ…` when coverage not complete. No credentials, token values or PR-supplied destinations.

## Read model

- `Application.prReport` returns `{report, annotations, evaluation, alerts}` where `alerts` are `delivery_intents` with `dedupe_key LIKE pr-alert/<reportId>/%`.
- `Application.admitPrAlerts` runs the transactional admission above.
- Web `prReportsPage` / `prReportPage` show no-findings, not-reviewed, partial, stale, failed and per-intent queued/sent/failed/unknown separately; `unknown` never reads as delivered and the report stays readable on Telegram outage.
- Owner dismissal is a revisioned `pr_report_annotations` row; it never rewrites findings and never converts rejected findings into learned facts.

## Evidence

`tests/pr-alerts.test.ts`: policy gating (evidence required), logical alert keys (replay dedup), recheck-before-send (base/head close/revoke/retire/owner-rotation → suppressed/stale), payload hygiene (no secrets/PR destinations), read-model states incl unknown delivery never delivered on outage, revisioned dismissal never rewriting history.
