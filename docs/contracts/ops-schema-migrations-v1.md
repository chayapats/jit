# ops.schema_migrations/v1

Owner-authorized installation upgrade through staged schema migration with a
recoverable prior version (OPS06, issue #32; ADR 0026). Implementation:
`src/ops/upgrade.ts` (engine), `src/ops/upgrade-fence.ts` (fence),
`src/ops/upgrade-service.ts` (service lifecycle), `Application`
`upgrade.*` commands, `bun src/main.ts upgrade`, Web `/upgrades`.

Consumed contracts: `ops.backup_manifest/v1` (recovery point),
`jobs.attempt_fence/v1` and `jobs.session_reconcile/v1` (quiesce and
reconciliation), `delivery.outbox/v1` (unknown outcomes stay unknown),
`app.deletion_ledger/v1` (ledger sidecar), `schway.host.session-snapshot/v1`
(native capture and validation).

## Versions

- Target: exactly the schema this build migrates to
  (`currentSupportedSchema` = `schemaVersion`, 31 at this revision; 23 adds
  the installation lifecycle ledger of app.deletion_ledger/v1, backfilled from
  existing tombstones and suppressions; 24 adds the empty `owner_preferences`
  table of ui.preferences/v1; 25 adds the empty `persona_revisions` and
  `jit_replies` tables of app.persona/v1 and app.jit_reply/v1; 26 adds the
  empty `setup_state` and `general_space` tables of app.setup/v1 and
  app.general_space/v1, so an upgraded installation goes through setup once; 27 adds the empty
  `dispatch_allowance_revisions` and `dispatch_proposals` tables of
  app.dispatch_allowance/v1; 28 adds the empty `topic_promotions` and `chat_title_sources` tables of
  app.topic_promotion/v1 and the triggers that keep the General space from
  being deleted or re-pointed; 29 adds the empty `local_api_settings` table of
  app.local_api/v1, so an upgraded installation keeps the loopback API off; 30 adds the installation-scoped `schedule_feed`
  table of app.schedule_feed/v1; 31 adds the empty `project_access_revisions`,
  `role_access_overrides` and `execution_halts` tables of app.access_level/v1,
  so every upgraded project reads `read`, revision 0, not halted).
- Sources: `minUpgradeSourceSchema` (17) through the target. A recovery point
  needs the managed backup registry (schema 16) and the deletion ledger
  (schema 17); older installations are `manual_recovery_required`.
  `minSupportedSchema` (15) remains the oldest image the staged migration chain
  (and OPS02 quarantine) accepts.
- Engine: the port must be available and declare snapshot contract
  `schway.host.session-snapshot/v1` with native format version
  `SNAPSHOT_NATIVE_FORMAT_VERSION` (4) exactly. Anything else is
  `engine_unavailable` or `unsupported_engine`. The scripted default has no
  native port, so it cannot upgrade (fail closed, like backups).
- Tested from/to: fixture installations at 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29 and 30 → 31, and
  31 → 31 (no schema change; recovery point, validation and reconciliation
  still run). No production historical release exists yet; fixtures are the
  evidence.

## Boot

An existing installation is never migrated in place at boot. `serve`,
`startFullApp`, `preflight`, `status` and `diagnose` open the store with
`migrateExisting: false`; `serve` exits with `Upgrade required` and preflight
reports gate `schema` blocked with `run-owner-upgrade`. New empty databases
are still initialized. `inspectStoreSchema(path)` reads `user_version` without
touching content. Newer-than-supported databases are refused at open.

## Commands

All commands: `{ kind, requestId, projectId: null, expectedRevision, payload }`.
`upgrade.prepare` payload `{ targetSchema, note }`; `upgrade.migrate`,
`upgrade.validate`, `upgrade.activate`, `upgrade.rollback` payload
`{ upgradeId }`. `execute` returns `Promise<UpgradeReceipt>`
(`{ journal: UpgradeEvidence, duplicate }`).

Order of checks: shape (`invalid_upgrade_command`), owner session
(`authentication_required`), request identity (`request_id_conflict`), revision
(`stale_revision`), then the command. None of these write evidence. A replayed
request id with the same payload returns the current journal with
`duplicate: true`.

Offline: `bun src/main.ts upgrade [--target <schema>] [--password-stdin]`
authenticates the owner password, refuses while another live instance owns
admission or delivery, runs prepare → migrate → validate → activate through
the same commands and prints sanitized evidence. Reconciliation then happens at
the next `serve` boot.

## Phases and journal

| State | Fence | Meaning | Actions |
| --- | --- | --- | --- |
| `preparing` | held | fence, quiesce, recovery point in progress | — (reopen → `failed`, `prepare_interrupted`) |
| `prepared` | held | recovery point and ledger sidecar committed | migrate, rollback |
| `staged` | held | staged copy migrated | validate, rollback |
| `ready` | held | staged copy validated | activate, rollback |
| `blocked` | held | migration/validation failed or live changed | migrate (when a recovery point exists), rollback |
| `activating` | held | activation intent persisted | activate (resolves intent) |
| `activated` | released | staged copy is live; reconciliation pending | activate (retry reconcile) |
| `complete` | released | reconciled; staged copy removed | — |
| `failed` | released | preflight/engine/quiesce/snapshot failure | — |
| `rolled_back` | released | abandoned before activation | — |

Journal fields: `fromSchema`, `targetSchema`, `preflight` (`currentSchema`,
`targetSchema`, `jitVersion`, `supported`, `migrations`, `engine`
{`engine`, `contract`, `formatVersion`, `compatible`, `reason`}, `compatible`,
`reason`, `plannedSteps`), `steps`, `quiesce` (`settled`, `fencedJobs`,
`detail`, `disabled`), `snapshotBackupId`, `checkpoint` (manifest summary),
`ledger` (sidecar path, hash, checkpoint and counts), `stagedPath`,
`stagedSchema`, `liveDigest`, `stagedDigest`, `validation`, `reconcile`,
`reason`, `nextAction`, `requests` (accepted request receipts), timestamps.
Evidence adds `actions`, derived from state and artifact availability.

The journal is control-plane state at `<upgradeDir>/<id>/journal.json`
(default `<db>.upgrades`), written atomically (temp, fsync, rename, directory
fsync). It is outside the swapped database, so activation never discards it.
The journal is untrusted input on every read (`readUpgrade`): it must match
the exact schema (no missing or extra fields, known state, typed values) and
the state's invariants (for example `ready` carries a recovery point, ledger,
staged path and both digests). `stagedPath` and `ledger.path` must equal the
paths derived from the trusted upgrade directory and id
(`upgradeStagedPath`, `upgradeLedgerPath`); file operations always use the
derived paths and require a real attempt directory and regular, non-symlink
files that are neither the live database nor inside the backup directory. A
journal failing these checks is shown as a durable `blocked`
`upgrade_corrupt` view (`corruptUpgrade`) with no actions; every step on it
fails with `upgrade_corrupt`, and it keeps the installation fenced until a
human inspects it. An unsafe attempt file found during a step moves the
journal to `blocked` `upgrade_corrupt`. Rollback removes the staged copy
strictly: an unsafe or undeletable artifact blocks the journal as
`upgrade_corrupt` with the fence held; only cleanup of already-ended attempts
is best effort, and it never touches anything but a regular file at the
derived path.
When an attempt ends (`complete`, `failed` after the fence, `rolled_back`) its
requests are mirrored into `command_receipts` and `audit`. Preflight and
engine rejections write only the journal file, never the installation
database. At most 50 terminal journals are retained.

## Fence and quiesce

`writeUpgradeFence` acquires the fence exclusively (claim hard-linked into
place; a fence held by another id is never overwritten and raises
`upgrade_in_progress`/`restore_in_progress`; re-acquiring one's own claim is
a no-op) and `clearUpgradeFence(path, ownerId)` removes only that owner's
claim. The fence is shared with `ops.quarantined_restore/v1`: a restore writes it
with `holder: "restore"` (and its restore id as `upgradeId`). Upgrade prepare
refuses while any fence or active restore exists, upgrade steps refuse a fence
held by another id, and upgrade recovery never releases a restore's fence, so
the two operations exclude each other.

`<db>.upgrade-fence` is created after preflight passes and held through
activation or rollback; an unreadable fence still fences. While present:
`Application.execute` refuses every non-upgrade command with
`upgrade_in_progress` (after authenticating), `JobQueue.available` is false and
`pump` admits nothing (automatic contexts, memory extraction, PR monitoring
and schedule-produced work never start), `tickSchedules` returns `[]`, and
`DeliveryWorker.claimNext`/`sendClaimed` never claim or invoke a sender.

Quiesce goes through the service lifecycle (`UpgradeServiceControl`):
`ManagedService.quiesce` calls `JobQueue.close` (admitted attempts are fenced
as interrupted and aborted, ownership retained until adapters settle) and
waits up to 30 s for nothing to occupy admission. Unsettled work fails prepare
with `upgrade_quiesce_incomplete`. Activation quiesces again before the swap.

Activation is additionally bound to an epoch: `managedStateDigest` hashes
`user_version`, every managed table's definition and every row (all tables
except installation-scoped ones, scheduler/delivery claims and the legacy
in-database `upgrade_journal`). The digest captured at migrate must be
unchanged at validation and immediately before the swap, so a writer that
ignored the fence makes activation fail (`upgrade_stale_live`, `blocked`)
instead of losing its write.

## Recovery point and ledger

Prepare creates one `ops.backup_manifest/v1` backup through
`stageManagedBackup`, the same staged creation as `backup.create` (the native
port's `snapshot` runs exactly once, inside it). It must be `valid` and
`verifyBackupArtifacts`-verified, otherwise prepare fails with
`recovery_point_<reason>`. The trusted lifecycle ledger is captured separately
into `ledger.json`: every deletion tombstone, suppression, suppressed claim and
source, and every source's revision/generation/availability. Its checkpoint
must equal the manifest's lifecycle checkpoint.

## Migration and validation

Migrate copies the fenced live image (`snapshotBytes`) to `staged.sqlite`,
proves the raw copy has the live digest, then opens it with the migrating
`TransactionStore`; the live database is never migrated. Native session
storage is never migrated or parsed; compatibility is exact-match.

Validate examines every row of every managed table, bounded at 200 000 rows
per table (and per ledger table); exceeding a bound fails closed with
`upgrade_validation_bound_exceeded`. Checks: `live_unchanged_since_migrate`,
`engine_compat` (recorded and current), `recovery_point` (still verified),
`quiesce`, `staged_schema`, `foreign_keys`, `preservation` (every live table
and column exists in the staged copy and every row is identical on the live
columns — covers receipts, revisions, jobs, attempts, outbox and native
references), `receipts_and_revisions`, `task_provenance`,
`decision_provenance`, `source_lineage`, `jobs`, `outbox`,
`native_opaque_refs` (bridge rows: shape and context ownership; every job
attempt: exact JobAttempt schema (generation, scheduler, lease, complete
admission snapshot of the owning job, reason and native/context/transport
states) bound to its row and owning job; a non-null native identity
`{adapter, runId, sessionId, context}` whose context exists in
`team_contexts`, with `data` the exact admitted ApplicationRunRequest for that
`runId`, context, job and attempt generation (fence), and
for Schway attempts that engaged transport an exact `schway_native_refs`
row for that run with the same context and generation and a resolved session
when finished; the staged non-deleted bridge set equals the recovery point's
native refs),
`ledger_preservation` (row-for-row against the sidecar), `staged_digest`.
`validation.unknownOutbox` and `nativeRefs` are reported counts.

## Activation and reconciliation

Activation re-checks both digests, persists `activating` (intent), then calls
`TransactionStore.swapFrom`, which builds the complete replacement image first
(installation-scoped rows from live, scheduler/delivery claims cleared), writes
and fsyncs a sibling file, removes WAL siblings and renames it over the live
path. The live digest must then equal the validated staged digest
(`activated`). The fence is released, `ManagedService.resume` rebuilds the
scheduler and ports through `composeJobQueue` and reconciles native sessions;
only then is the journal `complete`. Without a managed service in process
(offline CLI, bare Application) the journal stays `activated` with
`start_service_to_reconcile_jobs_sessions`, and `Application.boot()` (called by
`serve` and `startFullApp`) completes it after the boot reconciliation, which
is skipped while a fence holds. A failed reconciliation stays `activated`
(`reconcile_pending`); success is never claimed early.

Reopen (`recoverUpgradesOnOpen`, run by the Application constructor):
`preparing` → `failed`; `activating` resolves by live identity — staged digest
→ `activated`, pre-activation digest → `ready` (`activation_interrupted`),
anything else → `blocked` (`activation_state_unknown`, no actions). Fences of
fenced journals are re-established; fences of activated/ended journals are
released; a fence of unknown origin is never released automatically.

## Rollback

`upgrade.rollback` is accepted only before activation. It discards the staged
copy, releases the fence and resumes the service; the live installation was
never migrated or swapped, so no tombstone, suppression, source generation,
job settlement or outbox result can be erased and no external effect becomes
replayable. After activation it fails with `upgrade_rollback_requires_restore`:
returning to the prior version means restoring the recovery-point backup
through OPS02 quarantine and current-ledger replay. Unknown deliveries remain
unknown and are never resent by migration, rollback or reconciliation.

## Owner view

`/upgrades` shows current and supported schema, minimum source, build
identity, declared engine compatibility (never snapshotting), fence state and
the prepare form targeting `status.target`; `/upgrades/<id>` shows preflight,
steps, validation, recovery point, ledger counts, reconciliation, and buttons
only for `actions`; activated/complete journals point to OPS02 restore.

## Evidence

`tests/ops-upgrade.test.ts`: preflight matrix, metadata-only engine checks,
schema/engine rejection through `Application.execute` with zero engine calls,
authorization before evidence, full flow with preserved state and receipts,
fence over admission/schedules/delivery/commands across reboot, bypassing
writer → `upgrade_stale_live`, quiesce timeout, tampering anywhere → blocked,
row bound, rollback at each pre-activation phase and refusal after
activation, crash at every journal boundary, native/disk/staged-copy errors,
unknown live identity, historical fixtures 17–21, `serve` refusal and offline
CLI, `startFullApp` schema gate, Web, malformed snapshot metadata, real
migration activation intent, and `startFullApp` in schway mode over real
native sessions. `tests/ops-backup.test.ts`: recovery point through the
concrete `SchwayBackupNativePort`.
