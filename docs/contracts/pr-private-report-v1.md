# `pr.private_report/v1`

Owner: Jit #19 (PR02). Parent spec #1, blocks on #15 (JBR01 bridge), #10 (PR01), #14 (TEAM03).

Static snapshot produces a private inspectable report from independent bounded analyses and synthesis. Scripted fixture is the default; concrete production runs go through the supported bridge (`jit.schway.bridge/v1`, JBR01 #15) when `JIT_RUN_PORT=schway`. Scripted fixtures do not certify live readiness.

## Actors and scope

- Owner authorizes monitoring (`pr.monitoring_authority/v1`) and explicitly enqueues `pr.review` for one candidate; specialists analyze via `ApplicationRunPort`; coordinator synthesizes; owner dismisses via `pr.report.dismiss`.
- Fixed tuple: repository / PR number / base SHA / head SHA / trigger policy version / review policy version.
- Tools exposed to runs: none. Reads: committed snapshot manifest only. Writes: service-owned `pr_reports` + `pr_report_annotations` + job evidence.
- Out of scope: semantic accuracy guarantees, test execution, notifications, GitHub mutations, coding fixes.

## Route and admission (authorization boundary)

- `prepare` (attempt admission) captures `PrReviewCapture`: the owner-configured project default route, then the owner default route (`route.save`, `roleId: null`; `resolvePrReviewRoute`), its layer, owner/project configuration revisions (`roleRevision` = review policy version) and the review policy (`version`, `requiredRoles`).
- Concrete (`schway`) admission without a configured route is blocked (`pr_review_route_missing`) before any dispatch. `PR_REVIEW_SCRIPTED_ROUTE` is only the scripted-port default (`layer: scripted_fixture`) and never a concrete fallback.
- Retries reuse the first capture exactly; a changed review policy or adapter blocks the job (`pr_review_policy_changed`).
- PR/issue/spec/CI text is untrusted manifest evidence; it cannot select a route, tools, lookup, task acceptance or GitHub mutation.
- `serve` and `startFullApp` register `pr.snapshot`/`pr.review` through the shared `composeJobQueue` with the same port policy.

## Transmission

- Specialist requests: ordered items (PR header, every CI check, every changed-file diff, issues, specs) packed into at most `sourceLimit` sources within `contextBytes` (port team policy); items may continue across sources.
- Synthesis request: PR header plus one slot per required specialist result (or its no-result marker).
- `TransmittedManifest { version, sourceLimit, contextBytes, specialist[], synthesis[] }`; each `TransmittedEntry { kind, ref, required, state: sent|truncated|omitted|unavailable, bytes, sentBytes, chunk }`. Every specialist receives the identical specialist manifest.

## Behavior

- `validateFinding(input, snapshot, transmitted?)`: actionable requires a location in a changed snapshot file (a given line must fall inside a parsed `@@ -a,b +c,d @@` hunk; no parseable hunk ⇒ `location_unverifiable`), condition, impact, reasoning and a declared evidence type with an accessible citation: diff `evidenceRef` equal to the located file with a readable patch (`diff_ref_mismatch` otherwise), issue `#n` in snapshot issues, spec path in snapshot specs, CI check present and `available`. With a transmitted manifest, cited evidence that never reached the specialists is `evidence_not_transmitted`. Missing/invalid citations, `evidenceType none`, style/uncertain categories and secret-like content stay suspected with `validationErrors`.
- `normalizeReviewOutput`: parses untrusted model JSON `{findings, analyzedRoles, skippedScope, disagreements}`; unknown fields ignored; unparsable output is `valid:false` (failed). Missing required roles are added to `skippedScope`, never silently complete.
- `persistReport`: atomic commit only when monitor active, candidate current, base/head/policy match the snapshot, snapshot row exists and the captured review policy equals the current one. Model-declared roles count only when the specialist result completed and was delivered to synthesis; undelivered claims are recorded as disagreements. Status:
  - `failed` when synthesis invalid/error, a specialist errored, or output invalid;
  - `incomplete` when a required role is missing or undelivered, a run blocked/incomplete (including `budget_exhausted`), enumeration incomplete, no transmitted manifest, or a required diff/CI/specialist item was omitted;
  - `partial` when snapshot coverage is partial or any required transmitted item is truncated/unavailable (or an issue/spec omitted);
  - `complete_findings` / `complete_clean` only with complete enumeration, every required role delivered and analyzed, and every required item sent whole.
- `PrivateReport` embeds `sourceManifest` (immutable snapshot coverage), `transmitted`, `capture`, `mode`, `specialistRuns[].mode`, `synthesis`, analyzed/skipped scope and disagreements.
- Reads `readReport` / `listReports` (`ReportReadOptions.reviewPolicyVersion`, default `REVIEW_POLICY_VERSION`) compute `stale` when owner generation changes, monitor not active, candidate superseded/cancelled/stale/closed, base/head/trigger policy drift, or review policy changed (`review_policy_changed`); historic rows are never mutated by reads.
- `listReviewStates` (`Application.prReports().reviews`): per candidate `not_reviewed` (no review job), `running` (queued/admitted/waiting review job, no report), the committed status, `failed` (review job ended without a report), `stale` (stale report, or fenced work on a non-current candidate), with job state/reason.
- `reportRunEvidence` (`Application.prReport().evidence`): source manifest, transmitted manifest, job summary and up to 16 attempt summaries. Web renders both.
- `annotateReport` / `pr.report.dismiss`: revisioned annotation (`pr_report_annotations`) bumps `report.revision`; findings immutable; `stale_revision` on mismatch; secret-like reasons rejected.

## Fencing and budgets

- `pr.review` `isCurrent` gates on active monitor, non-terminal candidate and a current capture (review policy + adapter); `commit` rechecks inside the transaction. New revision, trigger/review policy change, cancel/stop, retire and revoke fence late publication; `fencePrReviewJobs` + `queue.cancelFenced()` invalidate.
- Each call reserves `{calls, rounds} = maxAttempts` (schway: `retries + 1`, scripted: 1), one hop, its measured context tokens and `floor(outputTokens / (roles + 1))` output tokens. The worker pre-checks the worst case for all calls; an insufficient budget commits an `incomplete` report (`budget_exhausted`) without any adapter invocation.
- Strict port: review imports only `ApplicationRunPort`; separate `team_contexts` per specialist/synthesis; `mutateCalls===0` always. Fixture and production outcomes normalize through `normalizePortResult`; production failures never wear fixture claims.

## Storage

No SQL schema change: new report fields live in `pr_reports.record_json` (additive); the read model queries existing `pr_candidates`, `pr_reports`, `jobs` and `job_attempts`.

## State matrix (observable)

`not_reviewed` · `running` · `complete_clean` · `complete_findings` · `partial` · `incomplete` · `failed` · `stale` (computed overlay).

## Evidence

`tests/pr-report.test.ts`: strict port/separate contexts/budgets, untrusted-input neutrality (AGENTS, PR body, issue, spec, CI), finding validation (patch ranges, diff refs, CI availability, transmission), atomic fenced commit + crash matrix, state matrix and read model, revision/policy/review-policy/cancel/stop/revoke fencing, transmitted-manifest completeness (seven files + CI delivered; oversized diffs omitted ⇒ incomplete; truncated ⇒ partial), synthesis slots, retry capture reuse, concrete route capture/rejection and worst-case retry pre-reservation. `tests/composition.test.ts`: both `JIT_RUN_PORT` modes through `composeJobQueue`, concrete route capture/rejection, and `serve`/`startFullApp` parity.
