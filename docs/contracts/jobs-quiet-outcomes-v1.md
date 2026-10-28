# Quiet summary outcomes, v1

Owner: Jit #113 (REL01). Contract: `jobs.quiet_outcomes/v1`. Implementation: `src/jobs/schedules.ts` (`SummaryOutcome`, `normalizeSummaryOutcome`, `scheduleSummaryWork`), `src/web-layout.ts` (`scheduleDetailPage`), `src/i18n/th.ts`, `src/i18n/en.ts`. Requires `jobs.configured_schedules/v1`, `delivery.outbox/v1` (`commitDeliveryIntent`), `jobs.attempt_fence/v1` and `src/security/credentials.ts` (`containsCredential`). FR-26, FR-12, FR-15, FR-17, NFR-05, NFR-10. Read alongside [ADR 0032](../adr/0032-quiet-outcomes-and-attention-levels.md).

## Exact public surface

```ts
type SummaryOutcome = { kind: "report"; text: string } | { kind: "no_update" } | { kind: "failed"; reason: string };
const summaryReasonChars = 200;
function normalizeSummaryOutcome(output: string): SummaryOutcome;
```

`ScheduleOccurrence.outcome?: { kind: "report" | "no_update" | "failed"; reason: string | null }` lives inside `record_json`, so no schema migration. `JobSchedule.lastResult.reason` carries `"no_update"` or the failure reason.

## Parsing table

`raw = output`, `trimmed = output.trim()`. Rules in order:

| # | Input | Result |
| --- | --- | --- |
| 1 | `JSON.parse(trimmed)` throws, or the value is not a plain object, or it has no own key `outcome` | `{ kind: "report", text: raw }` (prose is always a report) |
| 2 | `outcome` is not a string | `{ kind: "failed", reason: "invalid_outcome" }` |
| 3 | `outcome === "no_update"` | `{ kind: "no_update" }` (other keys ignored) |
| 4 | `outcome === "report"` | `{ kind: "report", text }` when `text` is a string with non-empty `trim()`; else `{ kind: "failed", reason: "invalid_outcome" }` |
| 5 | `outcome === "failed"` | `r = reason.trim()`; `reason` must be a string, `r` non-empty and at most `summaryReasonChars` (200) characters, else `invalid_outcome`; `containsCredential(r)` gives `reason_redacted`; else `{ kind: "failed", reason: r }` |
| 6 | Any other string value | `{ kind: "report", text: raw }` (an unknown value counts as report) |

Quietness is decided only by this typed field. Prose has no effect: prose that says nothing changed is still a report. Malformed input becomes `failed(invalid_outcome)`, never quiet.

## Per-outcome commit effects

All branches run inside the job `commit(result, mutate)` fence; a late result from a fenced generation throws `invalid_job_input` and changes nothing, and a restart never resends (dedupe key `schedule/<scheduleId>/<revision>/<instant>`).

| Typed outcome | Job commit | Intent | Output source | Occurrence | `lastResult` |
| --- | --- | --- | --- | --- | --- |
| `report` | `succeeded`, evidence `summary <scheduleId> @ <ISO instant>\n<text>` | one `report` intent with clipped `text` | committed | `complete`, `outcome { report, null }` | `succeeded` / `complete`, intent id + source |
| `no_update` | `succeeded`, evidence `summary <scheduleId> @ <ISO instant> no_update` | none (never calls `commitDeliveryIntent`) | none (never calls `commitOutputSource`) | `complete`, `outcome { no_update, null }`, intent/source stay null | `succeeded` / `no_update`, null intent/source |
| `failed(reason)` | `partial` (because `#finish` drops `mutate` for `failed`), evidence `summary <scheduleId> @ <ISO instant> failed: <reason>` | exactly one `report` intent with clipped `สรุปตามกำหนดการ "<purpose>" ไม่สำเร็จ · เหตุผล: <reason>` | none directly (the intent carries its own delivery report) | `failed`, `outcome { failed, reason }` | `failed` / `reason`, intent id |
| Run not `complete` or empty output (other than quota/login/route waits) | `partial` via `commitFailure(outcome.reason ?? "worker_failed")` | exactly one `report` intent naming the reason | as `failed` | `failed` with that reason | `failed` / reason |

Clipping everywhere reuses the report rule: `Buffer.byteLength(text) <= config.messageBytes` else the first 512 code points plus `…(ตัดให้พอขนาดแจ้งเตือน)`. The failure notification carries only the bounded reason, never the raw model output. Quota / `needs_login` / `route_unavailable` keep the unchanged `waiting` path with no commit.

## Never-quiet rule

The only code path that can produce `no_update` is the typed branch of a `complete` run. Reminders (`scheduleReminderWork`) are untouched. Occurrences fenced or stopped by a schedule edit or revoke, or that never reach `run`, keep their current visible job state on the detail page and never get `outcome.kind = "no_update"`. `tickSchedules`, `dedupeKey` and the delivery outbox are unchanged. Owner-run or test summaries do not exist on `main` (schedule jobs cannot be started manually).

## Web labels

`scheduleDetailPage` renders, inside each occurrence `<article>` after the first `<p>` and only when `item.outcome` is set:

```html
<p><span class="job-status" data-state="${state}">${tr(key)}</span>${reason}</p>
```

`report` → `data-state="succeeded"`, key `schedules.outcome_report`; `no_update` → `data-state="waiting"`, key `schedules.outcome_no_update`; `failed` → `data-state="failed"`, key `schedules.outcome_failed`, with `reason = " " + tr("schedules.outcome_reason") + " " + escape(item.outcome.reason)`. Dictionary (th/en): `ส่งสรุปแล้ว` / `Summary sent`; `ไม่มีอะไรใหม่ ไม่แจ้งเตือน` / `Nothing new, no notification`; `ล้มเหลว แจ้งเตือนแล้ว` / `Failed, notified`; `เหตุผล:` / `Reason:`.

## Deterministic evidence

`tests/schedule-quiet-outcomes.test.ts` covers the parsing table, quiet commit (0 intents, null intent/source, `no_update` label in both languages), typed failure (exactly one intent naming the reason), provider errors (`invalid_result`, `max_rounds`), quota waiting, the unchanged report path, fencing of a late `no_update`, restart idempotence, coalesced-misfire quiet/failure counts, and reminders never going quiet. No live provider and no network.
