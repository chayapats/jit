# OPS load drill contract, v1

Owner: Jit #34 (OPS04). Contract: `ops.load_drill/v1`, record schemas `jit.ops.diagnostics/v1` and `jit.ops.drill/v1`. Implementation: `src/ops/diagnostics.ts`, `src/ops/drill.ts`, `src/ops/revisions.ts`, `src/ops/contracts.ts`, `src/ops/records.ts`, `src/ops-cli.ts`. Consumes `jobs.queue_admission/v1`, `jobs.configured_schedules/v1`, `pr.private_report/v1`, `pr.private_alerts/v1`, `delivery.outbox/v1`, `ops.project_export/v1`, `ops.backup_manifest/v1`, `ops.schema_migrations/v1` (preflight and fence only) and `ops.quarantined_restore/v1` (quarantine steps and discard, never activation). FR-10, FR-14, FR-15, FR-18, NFR-04, NFR-05, NFR-06, NFR-07, NFR-09, NFR-10. It makes no Pi, capacity or readiness claim.

Run from the installation root:

```sh
bun run ops:drill diagnose
bun run ops:drill drill --config .local/ops-drill.json [--label drill-fixture]
bun run ops:drill report --id <drill-uuid> --checklist .local/release-checklist.json
```

The drill config has exactly these fields (only `diskWatermarkBytes` and `deadlineMs` fall back to installation `ops` knobs; workload sizes are always required):

```json
{
  "groups": 2,
  "prSnapshots": 3,
  "memoryQueries": 4,
  "deliveries": 4,
  "schedules": 1,
  "diskWatermarkBytes": 16777216,
  "deadlineMs": 60000
}
```

Bounds: `groups` 1–8, `prSnapshots` 1–64, `memoryQueries` 1–256, `deliveries` 1–32, `schedules` 0–16, `diskWatermarkBytes` 4096–1073741824, `deadlineMs` 1000–300000. Missing, non-integer or unbounded values fail preflight with `invalid_drill_config`; there are no unlimited defaults. Inside the drill, admission runs in waves of 8 jobs and each wave drains in at most 16 pump rounds, so the default `JIT_JOB_QUEUE_LIMIT` is never raised to make a drill pass.

## Public entries

| Public entry | Behavior |
| --- | --- |
| `parseDrillConfig(raw, fallback)` in `src/ops/config.ts` | Strict finite workload config. Unknown keys fail. Installation fallbacks are validated too. |
| `inspectDiagnostics(input)` in `src/ops/diagnostics.ts` | Pure read-only snapshot (below). Every input field is required and bounded; unknown keys fail `invalid_diagnostics`. No I/O, no telemetry. |
| `gatherDiagnostics(root, config, now?)` in `src/ops/diagnostics.ts` | Read-only gather: store reads (`migrateExisting: false`), `lstat` of host directories, fence/journal file reads. No scheduler claim, no pump, no timers, no engine probe, no network, no writes. `providers.observedRoutes` is always 0 because this path never collects live evidence. |
| `runLoadDrill(config, ports?)` in `src/ops/drill.ts` | Bounded fixture workload in disposable state (below). |
| `testedRevisions(stateSchema)`, `gitRevision(root)`, `contentHash(root)` in `src/ops/revisions.ts` | Tested revisions for the record. `git` resolves HEAD (worktree `commondir`, loose and packed refs) without spawning git; `contentHash` is sha256 over relative path + bytes of `src/**`, `package.json`, `bun.lock` (≤ 4000 files, ≤ 64 MiB, no symlinks). Either is null when unreadable or over the bound. |
| `writeOpsRecord` / `readOpsRecord` in `src/ops/records.ts` | Private `.local/ops-evidence/<id>.json`, exclusive mode-0600 creation, file/directory sync, bounded reads, no overwrite or symlink traversal. Records over 32768 bytes are rejected. |
| `runOpsCommand(args, root, ports?)` in `src/ops-cli.ts` | Returns `{exitCode,output}`. Prints safe JSON only. Invalid/config/storage failures exit 2 with fixed codes. Stored records exit 0 even when the honest outcome is `blocked`. |

`bun src/main.ts diagnose` prints the same read-only snapshot for a live installation without starting background work.

## Diagnostics snapshot (`jit.ops.diagnostics/v1`)

| Field | Meaning |
| --- | --- |
| `queue` | `available` (no scheduler owner), `queued`, `admitted`, `waiting` counts. |
| `routes[]` | Up to 8 `{ reference: "route-N", model: "redacted"/"unselected", state, attempts }`; raw route/model aliases never leave. |
| `budgets` | `exhausted` (blocked `budget_exhausted`) and `deadlineFailed` (failed `deadline`). |
| `waits` | `quota`, `needsLogin`, `routeUnavailable` (waiting on the exact route) and `authorizationChanged` (blocked because owner authority expired, e.g. credential rotation). |
| `disk` | Managed `.local` bytes vs `JIT_OPS_DISK_WATERMARK_BYTES`, `pressure`. |
| `connections` | Telegram `configured`/`unconfigured` (file check only), `binding` (`unbound`/`pending`/`bound`), pending intents, unknown deliveries. |
| `engine` | `mode` (`scripted`/`schway`), `state` (`scripted`; `declared` when the pinned `schway.host.release/v1` contract matches and existing host directories are private; `unavailable` otherwise), `observed: "not-observed"` always. |
| `providers` | Distinct configured routes (owner default, project defaults, enabled roles), `observedRoutes`, `readiness` in the host-evidence vocabulary: `not-configured`, `configured-unverified`, `observed-ready` (only with observed evidence supplied by a caller; never from `gatherDiagnostics`). |
| `schemaVersion` | `current` (`user_version`), `supported`, `state` (`current`/`upgrade-required`/`newer-unsupported`). |
| `upgrade` | `fence` (`none`/`upgrade`/`restore`/`unreadable`, from `<db>.upgrade-fence`) and the active journal `activeState`. |
| `restore` | Non-terminal OPS02 journals under `<db>.restores` (`open`, `blocked`; an unreadable journal counts as blocked), the `<db>.restore-pending` read `gate` (`none`/`pending`/`unreadable`) and `state` (`none`/`quarantine-open`/`quarantine-blocked`/`activation-pending`). File reads only. The shared fence's `restore` holder appears as `upgrade.fence: "restore"`. |
| `artifacts` | Up to 32 sanitized ops-evidence record IDs. |
| `nextAction`, `nextActions[]` | Highest-priority action and every applicable action, in priority order. |

Next actions, in priority order (all fixed vocabulary; none is authorized by diagnostics): `complete-restore-activation` (read gate present: the application serves only restore remediation), `finish-or-rollback-upgrade`, `resolve-restore-quarantine`, `run-owner-upgrade`, `use-compatible-app-artifact`, `relieve-disk-pressure`, `restore-engine`, `inspect-sanitized-diagnostics` (another instance owns admission), `configure-provider-route` (schway mode, no configured route), `reconnect-provider-login`, `reauthorize-owner-work`, `wait-for-quota-then-resume`, `resolve-unknown-delivery`, `resolve-blocked-work`, `drain-queue`, `configure-telegram`, `bind-telegram`, else `none`. Each maps to a runbook section in `docs/runbooks/ops-load-drill.md`.


## Drill legs (`jit.ops.drill/v1`)

All adapters are scripted. Global fetch is a throwing stub for the duration; the record carries `fetchCalls`. Every leg state is derived from what executed (`passed`, `failed`, `blocked`, `not-run`, or `scripted` for a real code path driven by a fixture engine). A leg that throws is `failed` with a fixed detail; a leg whose detail fails `safeNote` is `failed`. Owner cancellation (`ports.signal`) or the drill deadline turns every not-yet-started leg into `not-run` with a `skipped:` detail.

| Leg | What runs |
| --- | --- |
| `groups` | N `project.create` + `topic.create` through `Application.execute`. |
| `pr-snapshots` | One PR monitor per group (`pr.monitor.enable` via `mutateMonitor`) over an in-memory `FakeGitHubFixture`, durable candidates from `pollMonitorCatchUp`, owner-enqueued `pr.snapshot` jobs. No GitHub writes; `apiBase` is never fetched. |
| `pr-alerts` | Owner-enqueued `pr.review` per candidate through `prReviewWork` with a scripted run port (one evidenced correctness finding, one held style finding); report commit admits the alert intent (`pr.private_alerts/v1`). Passes only when reports, alert links and intents equal the candidate count. Intents wait unbound; nothing is sent. |
| `memory-queries` | Read-only `Application.memory` queries. |
| `deliveries` | `delivery.commit` plus scripted sender classification (sent/unknown/failed). No Bot API. |
| `schedules` | Reminder schedules ticked with an explicit clock. |
| `quota-wait` | A scripted `waiting`/`quota` job stays on its route. |
| `cancel` | Cooperative `job.stop` of a gated job; stop acknowledgment measured. |
| `export` | `export.create` (history included) after seeding a credential-shaped probe message; the artifact must be `valid`, hash-verified on read, `completeness.complete`, disclose `secrets: "excluded"`/`restorableBackup: false`, contain no probe text and no credential match, and carry the redaction marker. |
| `backup` | `backup.create` then `Application.backup` integrity re-verification. Default native port is a fixture declaring `schway.host.session-snapshot/v1` with an empty native set (state `scripted`); an unavailable port gives `blocked` with the manifest reason. |
| `upgrade-preflight` | `Application.upgradeStatus`: schema plan, fence, active journal and declared engine identity. Read-only; nothing is migrated. `scripted` with the fixture engine; `blocked` with the engine/fence/plan reason otherwise. |
| `quarantine` | Default `quarantineRestorePort`: `restore.prepare` → `restore.migrate` → `restore.apply_ledger` (latest trusted installation lifecycle ledger) → `restore.validate` on the verified backup, then always `restore.discard`; never `restore.activate`. A refused step's journal is read back by request id. `passed` only when validation passed every check, the journal was discarded and the shared fence and read gate are released; a blocked/failed journal is `blocked` with its reason; a quarantine left holding the fence is `failed`. `ports.restore` (`DrillRestorePort`, `{ app, actor, backupId, now }`) replaces it in tests. Without a verified backup the leg is `not-run`. |
| `network` | `passed` only when `fetchCalls` is 0. |
| `disk-watermark` | Managed-state growth against `diskWatermarkBytes`; breach is `blocked`. |

Record fields: `versions` (tested revisions: `app`, `bun`, drilled `schema`, `git`, `contentHash`, `engine { package, release, bridge, snapshot, snapshotFormat }`), the exact `config`, `legs`, `measurements` (`peakRssBytes`, state bytes before/after/growth, `diskPressure`, `queueWaitMs`, `stopAckMs`, `fetchCalls`, delivery outcome counts, `succeededJobs` (`pr.snapshot` + `pr.review`), `waitingJobs`, `cancelledJobs`, `prReports`, `alertIntents`, `exportBytes`, `backupBytes`, `commandAckMaxMs`, `requestMaxMs`, `commands`), `fixtureHonesty` notes, `outcome` and `nextAction`.

Outcome: `failed` if any leg failed; `blocked` if any leg is blocked or was skipped; otherwise `passed`. Next action: `relieve-disk-pressure`, `inspect-sanitized-drill`, `restore-engine` (an engine-reason block), `retry-bounded-drill` (cancelled or deadline), `integrate-pending-contract` (only `pending …` contract gates block; none remain), `resolve-blocked-work`, else `none`. A non-fixture desktop timing is never a latency SLO and never Pi evidence.

## Evidence

`tests/ops-drill.test.ts`: redaction and strict input, every failure fixture (missing provider/Telegram configuration, unbound Telegram, unknown delivery, engine unavailable, expired authority, provider login, quota, restored quarantine, upgrade fence/journal, older/newer schema, disk pressure, foreign scheduler) mapped to its next action, observed readiness only with evidence, gather over a real store (restore journal files, unreadable journal, `restore-pending` gate, fence file, unsafe host directory, configured route, v10 fixture never migrated, no files written), expired authority from owner credential rotation, finite-config rejection, the full drill without network, tested revisions and their rejection, engine-unavailable drill, the real quarantine flow passing and discarding, an untrusted ledger checkpoint reported `blocked` with the fence released, restore seam (pass, leaky detail, throw, bogus state), cancellation before and during the drill, watermark breach, symlink/oversize/sentinel storage negatives and the standalone CLI.
