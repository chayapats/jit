# PR monitoring contracts, v1

Owner: Jit #10 (PR01). Implemented under `src/pr/` with deterministic fake GitHub fixtures in `tests/pr.test.ts`. Requires `app.transaction_store/v1`, `app.project_commands/v1`, `jobs.queue_admission/v1`, and `jobs.attempt_fence/v1` in the integration base. Formal `user_version` migration for PR tables is deferred (store ownership); callers invoke `ensurePrSchema` inside application transactions. Application/Web wiring is out of this reservation.

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

## Exact public TypeScript surface

See exported declarations in `src/pr/index.ts` and the interfaces in `src/pr/types.ts`. Artifact version: `pr.monitoring_authority/v1` + `pr.immutable_snapshot/v1` on branch `jit/10-pr-monitor`.
