# `pr.private_report/v1`

Owner: Jit #19 (PR02). Parent spec #1, blocks on #15 (JBR01 bridge), #10 (PR01), #14 (TEAM03).

Static snapshot produces a private inspectable report from independent bounded analyses and synthesis. Scripted fixture is the default; concrete production runs go through the supported bridge (`jit.schway.bridge/v1`, JBR01 #15).

## Actors and scope

- Owner authorizes monitoring; specialists analyze via `ApplicationRunPort`; coordinator synthesizes; owner dismisses via `pr.report.dismiss`.
- Fixed tuple: repository / PR number / base SHA / head SHA / trigger policy version / review policy version.
- Tools exposed to runs: none. Reads: committed snapshot manifest only. Writes: service-owned `pr_reports` + `pr_report_annotations` + job evidence.
- Out of scope: semantic accuracy guarantees, test execution, notifications, GitHub mutations, coding fixes.

## Behavior

- `validateFinding`: actionable requires location, condition, impact, reasoning, declared evidence type and a valid snapshot citation (diff path in snapshot files, issue `#n` in snapshot issues, spec path in snapshot specs, CI name in snapshot checks). Missing/invalid citations, `evidenceType none`, style/uncertain categories and secret-like content stay suspected with `validationErrors`.
- `normalizeReviewOutput`: parses untrusted model JSON `{findings, analyzedRoles, skippedScope, disagreements}`; unknown fields ignored; unparsable output is `valid:false` (failed). Missing required roles are added to `skippedScope`, never silently complete.
- `persistReport`: atomic commit only when monitor active, candidate in captured/partial, base/head/policy match the snapshot and snapshot row exists. Status:
  - `failed` when synthesis invalid, specialist failed, or output invalid;
  - `incomplete` when a required role is missing, enumeration incomplete, or a run blocked;
  - `partial` when enumeration complete but overall truncated;
  - `complete_findings` / `complete_clean` only with complete enumeration, all required roles and no truncation.
- Reads `readReport` / `listReports` compute `stale` when monitor not active, candidate superseded/cancelled/stale/closed, or base/head/policy drift; historic rows show stale and are never mistaken for current. Absence means not-reviewed; an admitted review job without a report reads as running.
- `annotateReport` / `pr.report.dismiss`: revisioned annotation (`pr_report_annotations`) bumps `report.revision`; findings immutable; `stale_revision` on mismatch; secret-like reasons rejected.

## Fencing

- `pr.review` work `isCurrent` gates on active monitor and non-terminal candidate; `commit` rechecks inside the transaction. New revision, policy bump, cancel, retire and revoke fence late publication; `fencePrReviewJobs` + `queue.cancelFenced()` invalidate.
- Strict port: review imports only `ApplicationRunPort`; separate `team_contexts` per specialist/synthesis; finite `reserve` per invoke (worst-case retry calls pre-reserved on the schway adapter); snapshot bytes travel as manifest sources, never as instructions; `mutateCalls===0` always (no GitHub mutation surface). Both fixture and production outcomes normalize through `normalizePortResult`; production failures never wear fixture claims. The run route is explicit config (`PrReviewWorkOptions.route`, scripted fixture default); committed evidence records the outcome mode.

## State matrix (observable)

`not-reviewed` (no row) · `running` (admitted job, no row) · `complete_clean` · `complete_findings` · `partial` · `incomplete` · `failed` · `stale` (computed overlay on any stored status).

## Evidence

`tests/pr-report.test.ts`: strict port/separate contexts/budgets (worst-case retry pre-reserve on schway), untrusted-input neutrality, finding validation (suspected vs actionable), atomic fenced commit + crash matrix, 7-state matrix, new-revision/policy-bump/cancel/retire/revoke fencing to stale, scope-policy partial completeness. Concrete coverage through deterministic `SchwayRunPort` fixture stores/transports: production complete with mode evidence, classifier states across diff/issue/spec/ci/none evidence, blank-output failure, auth-failure waiting without fallback, explicit route override.
