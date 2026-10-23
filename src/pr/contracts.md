# PR monitoring contracts, v1 + private report/alerts v1

Owner: Jit #10 (PR01), #19 (PR02), #24 (PR03). Implemented under `src/pr/` with deterministic fake GitHub fixtures in `tests/pr.test.ts`, `tests/pr-report.test.ts`, `tests/pr-alerts.test.ts`. Requires `app.transaction_store/v1`, `app.project_commands/v1`, `jobs.queue_admission/v1`, and `jobs.attempt_fence/v1` in the integration base. Formal `user_version` migration for PR tables is deferred (store ownership); callers invoke `ensurePrSchema` inside application transactions. Bridge integration uses the scripted run port only (`jit.schway.bridge/v1` interface, JBR01 #15 remains the live-readiness blocker).

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
| `pr.snapshot` work | Fenced read work (`prSnapshotWork`) that commits snapshot persistence through `WorkContext.commit`. Revoke/supersede invalidates via `fencePrCandidateJobs` before `cancelFenced`. |

## `app.project_commands/v1` extension (this issue)

Adds project-scoped kinds `pr.monitor.enable|pause|resume|revoke` with the same requestId/expectedRevision/receipt rules as other project commands. HTTP/Application dispatch is not wired in this reservation.

## `pr.private_report/v1`

Private static review bound to one immutable snapshot and revision tuple. No GitHub writes, no public review.

| Entry | Behavior |
| --- | --- |
| `DEFAULT_REVIEW_POLICY` / `REVIEW_POLICY_VERSION` | Visible defaults: required roles `correctness,security`, complete enumeration required. A complete result needs complete enumeration plus every required analysis; subsets stay partial/incomplete. |
| `validateFinding` | Each actionable finding needs location, condition, impact, reasoning and declared evidence type with a valid snapshot citation. Missing/invalid citations stay suspected. Severity never substitutes for evidence. |
| `normalizeReviewOutput` | Parses untrusted model JSON into validated findings + analyzed/skipped scope + disagreements. Unknown route/task/mutation fields are ignored, never acted on. |
| `persistReport` / `readReport` / `listReports` | Atomic fenced commit under current attempt/input/authorization generation; report pins repository/PR/base/head/policy/review-policy, source manifest, analyzed/skipped scope, attempts and disagreements. Reads compute a stale overlay for revision/policy/cancel/retire/revoke; history rows are never mutated by reads. |
| `annotateReport` / `pr.report.dismiss` | Revisioned owner dismissal/feedback as `pr_report_annotations`; findings history immutable, report revision advances, stale replay rejected. |
| `pr.review` work | N bounded specialist invokes + 1 synthesis through `ApplicationRunPort` only, separate contexts and finite budgets. Snapshot capture stays on `TrustedGitHubConnector` + `fixtureFor`, never through the run port. Revoke/supersede fences via `isCurrent` + commit gate before `cancelFenced`. |

## `pr.private_alerts/v1`

Private notification for evidence-backed findings only, linked back to the report.

| Entry | Behavior |
| --- | --- |
| `DEFAULT_ALERT_POLICY` / `ALERT_POLICY_VERSION` | Allowed categories `correctness,security,behavior`, evidence required, actionable only. Uncertainties and style stay in the report. |
| `evaluateReport` | Pure policy pass returning qualifying vs held with reasons; owner can inspect why each finding was notified or held. |
| `alertKey` | Logical dedupe `pr-alert/<reportId>/<findingId>/v<policy>/<head12>/<policyVersion>`; replay returns the existing intent. |
| `admitReportAlerts` | Rechecks current base/head/policy, report validity, enabled monitoring and owner generation immediately before `commitDeliveryIntent`; old revisions suppress, never label latest. Payload holds repo/PR/revision/location/condition/impact/evidence type/report link plus a partial-scope warning; secrets and PR-supplied destinations never enter. |
| Read model | `Application.prReport` shows evaluation + linked `delivery_intents`; Web shows no-findings/not-reviewed/partial/stale/failed and queued/sent/failed/unknown separately. Unknown never reads as delivered. |

## Exact public TypeScript surface

See exported declarations in `src/pr/index.ts` and the interfaces in `src/pr/types.ts`. Artifact version: `pr.monitoring_authority/v1` + `pr.immutable_snapshot/v1` + `pr.private_report/v1` + `pr.private_alerts/v1` on branch `jit/19-pr-reports` (stacked `jit/24-pr-alerts`, batched PR2).
