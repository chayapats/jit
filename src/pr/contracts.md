# PR monitoring contracts, v1 + private report/alerts v1

Owner: Jit #10 (PR01), #19 (PR02), #24 (PR03). Implemented under `src/pr/` with deterministic fake GitHub fixtures in `tests/pr.test.ts`, `tests/pr-report.test.ts`, `tests/pr-alerts.test.ts`. Requires `app.transaction_store/v1`, `app.project_commands/v1`, `jobs.queue_admission/v1`, and `jobs.attempt_fence/v1` in the integration base. PR tables are created by `ensurePrSchema` inside application transactions; store schema v22 migrates an existing `pr_reports` to report history. PR review runs through the composed team port: scripted by default, the concrete `jit.schway.bridge/v1` port with `JIT_RUN_PORT=schway` (see ADR 0023 for the PR-review authorization boundary and route policy). Scripted fixtures do not certify live readiness.

## `pr.monitoring_authority/v1`

Standing owner authorization for read-only polling of one allowlisted repository.

| Entry | Behavior |
| --- | --- |
| `DEFAULT_TRIGGER_POLICY` / `TRIGGER_POLICY_VERSION` | Visible defaults: skip draft until ready, reconsider changed base/head, close cancels pending, reopen reevaluates. Enabling accepts this exact version. |
| `DEFAULT_PR_LIMITS` | Finite poll interval, page size, max pages, payload/file/diff/evidence byte ceilings. |
| `pr.monitor.enable` | Project-scoped command; records canonical repository identity, trusted `apiBase`, allowed issue/spec/CI reads, limits, and accepted policy version. Rejects duplicate active/paused monitors for the same repo. |
| `pr.monitor.pause` / `resume` / `revoke` | Owner can pause, resume, or revoke. Revoke cancels non-terminal candidates and may fence jobs via `onRevoke` in the same transaction. |
| `prMonitorIdentity` / `mutateMonitor` | Receipt identity and transactional mutate for `app.project_commands/v1` composition. |
| `pollMonitorPage` / `pollMonitorCatchUp` | Persist checkpoint + candidates; dedupe by repository/PR/base/head/policy; incomplete pagination does not claim catch-up complete or advance past unrecorded work. |

## `pr.immutable_snapshot/v1`

Revision-bound static review inputs with an honest coverage manifest. No repository code execution.

| Entry | Behavior |
| --- | --- |
| `TrustedGitHubConnector` | Resolves only the monitor's configured endpoint and exact immutable SHAs. Rejects model URLs, auth headers, redirects, unconfigured hosts, mutable refs, and symlink-like / traversal paths. |
| `FakeGitHubFixture` | Protocol fixture for new/draft/ready/update/rebase/base-only/closed/reopened, truncation, denial, rate limits, and partial pages. |
| `collectSnapshotMaterials` / `persistSnapshot` / `captureSnapshot` | Bounded diff/files plus permitted issue/spec/CI evidence. Snapshots are untrusted data in service-owned cache destinations; AGENTS/skills/config are never autoloaded as authority. |
| `CoverageManifest` | Records requested/read/unavailable/truncated sources with immutable refs, limits and reasons. `enumerationComplete` is independent of whether selected files were read. Missing denominator ⇒ partial/incomplete. |
| `pr.snapshot` work | Fenced read work (`prSnapshotWork`) that commits snapshot persistence through `WorkContext.commit`. Revoke/supersede invalidate its active jobs in the same transaction (`fencePrCandidateWork`) before `cancelFenced`. |

## `app.project_commands/v1` extension (this issue)

Adds project-scoped kinds `pr.monitor.enable|pause|resume|revoke` with the same requestId/expectedRevision/receipt rules as other project commands. HTTP/Application dispatch is not wired in this reservation.

## `pr.private_report/v1`

Private static review bound to one immutable snapshot and revision tuple. No GitHub writes, no public review.

| Entry | Behavior |
| --- | --- |
| `DEFAULT_REVIEW_POLICY` / `REVIEW_POLICY_VERSION` | Visible defaults: required roles `correctness,security`, complete enumeration required. A complete result needs complete enumeration plus every required analysis; subsets stay partial/incomplete. |
| `validateFinding` | Each actionable finding needs a location in a changed snapshot file (line, when given, inside a parsed patch hunk; unparseable hunks are `location_unverifiable`), condition, impact, reasoning and a declared evidence type with an accessible citation: diff `evidenceRef` equal to the located readable file, issue `#n`/spec path in the snapshot, CI check present and `available`; with a transmitted manifest the cited item must also have reached the specialists. Missing/invalid citations stay suspected. Severity never substitutes for evidence. |
| `normalizeReviewOutput` / `canonicalizeFindingIds` | Parses untrusted model JSON into validated findings + analyzed/skipped scope + disagreements. The full envelope with correct member types is required (otherwise invalid ⇒ failed); findings beyond `MAX_REVIEW_FINDINGS` are counted (`findingsOverflow`) and force incomplete. Unknown route/task/mutation fields are ignored, never acted on. Repeated finding IDs are renamed `<id>-dup<n>` and tagged with a shared `duplicateGroup` (each copy keeps its status). Credential screening uses the shared `src/security/credentials.ts`. |
| `persistReport` / `readReport` / `listReports` | Atomic fenced commit under current attempt/input/authorization generation and review policy; report pins repository/PR/base/head/policy/review-policy and embeds the snapshot source manifest (`sourceManifest`), the transmitted manifest, the admission capture (route/layer/configuration revisions), mode, analyzed/skipped scope, specialist/synthesis runs and disagreements. Completion derives from the transmitted manifest and delivered specialist results, never from model-declared roles. Reads compute a stale overlay for revision/trigger policy/review policy/cancel/retire/revoke; history rows are never mutated by reads. |
| Report history / fencing | One report per committing attempt; older reports of a candidate read stale (`superseded_by_newer_review`) and their pending alert intents are retired in the same commit; store schema v22 drops the candidate uniqueness. `fencePrCandidateWork` / `fencePrReviewJobs` find active snapshot/review jobs by input; supersede and revoke call it transactionally; `retirePrSnapshot` records a durable `source_retired` stale reason. |
| `listReviewStates` / `reportRunEvidence` | Per-candidate read model: `not_reviewed` (no review admitted), `running` (admitted nonterminal job, no report), committed status, `failed` (job ended without a report), `stale`. Report evidence resolves the source manifest, transmitted manifest and bounded job/attempt summaries. |
| `annotateReport` / `pr.report.dismiss` | Revisioned owner dismissal/feedback as `pr_report_annotations` (optional `findingId`, linked `decisionId`); findings history immutable, report revision advances, stale replay rejected; dismissal retires pending alert intents and feeds admission/send rechecks; never writes memory claims. |
| `pr.review` work | `prepare` captures the configured route (project default, then owner default) with configuration revisions and review policy; concrete admission without a route is blocked; retries reuse the capture. N bounded specialist invokes + 1 synthesis through `ApplicationRunPort` only, separate contexts, requests packed to the port source/byte limits with every omission/truncation recorded, a synthesis slot per required specialist result, and worst-case retry calls pre-reserved (insufficient budget commits an incomplete report without dispatch). Snapshot capture stays on `TrustedGitHubConnector` + `fixtureFor`, never through the run port. Revoke/supersede/review-policy change fence via `isCurrent` + commit gate before `cancelFenced`. |

## `pr.private_alerts/v1`

Private notification for evidence-backed findings only, linked back to the report.

| Entry | Behavior |
| --- | --- |
| `DEFAULT_ALERT_POLICY` / `ALERT_POLICY_VERSION` / `readAlertPolicy` / `pr.alert_policy.set` | Explicit default v1 (categories `correctness,security,behavior`, evidence + actionable required, no severity threshold, partial notifies with warning) persisted in `pr_alert_policies`; owner writes revisioned versions through the shared command receipt path. Uncertainties and style stay in the report. |
| `evaluateReport` / `readAlertDecisions` | Pure policy pass returning qualifying vs held with reasons; each admission stores an `AlertDecision` so the owner can inspect why each finding was notified, held or suppressed. |
| `alertKey` | Logical dedupe `pr-alert/<reportId>/<findingId>/v<policy>/<head12>/<policyVersion>`; replay returns the existing intent; a notified (pending/sent/unknown, not cancelled/failed) alert under another policy version, or an earlier attempt's alert with an equal `findingFingerprint` (location/evidence/condition, never the raw model ID), reads `already_notified`. |
| `admitReportAlerts` / `admitCommittedReportAlerts` | Runs automatically in the `pr.review` report commit transaction (savepointed; failure never loses the report). Rechecks base/head/policy, report validity, enabled monitoring, owner generation and dismissal before `commitDeliveryIntent(guard:"pr-alert")`; old revisions suppress, never label latest. Payload holds repo/PR/revision/location/condition/impact/evidence type/service report path plus a partial-scope warning; secrets and PR-supplied destinations never enter. |
| `prAlertCurrentness` / `retirePrAlerts` | Outbox send-time guard rechecks the linked report immediately before send; supersede/close/stale/revoke/dismissal/policy change retire pending intents in the same transaction. |
| Read model | `Application.prReports` returns `{project, items, reviews, pending, policy}`: `reviews` is every candidate state, `pending` its not-reviewed/running subset; `Application.prReport` shows evaluation, stored decisions, policy and linked `delivery_intents`; Web shows no-findings/not-reviewed/running/partial/stale/failed and queued/sent/failed/unknown separately. Unknown never reads as delivered. |

## Exact public TypeScript surface

See exported declarations in `src/pr/index.ts` and the interfaces in `src/pr/types.ts`. Artifact version: `pr.monitoring_authority/v1` + `pr.immutable_snapshot/v1` + `pr.private_report/v1` + `pr.private_alerts/v1` on branch `jit/19-pr-reports` (stacked `jit/24-pr-alerts`, batched PR2).
