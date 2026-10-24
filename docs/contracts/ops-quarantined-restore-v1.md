# ops.quarantined_restore/v1

Owner-authorized restore of a managed backup through quarantine (OPS02, issue
#33; ADR 0027). Implementation: `src/ops/restore.ts` (engine),
`src/ops/lifecycle-ledger.ts` (latest trusted ledger), `Application`
`restore.*` commands, Web `/restores`. FR-15, FR-16, FR-18, NFR-05, NFR-08,
NFR-10, NFR-12.

Consumed contracts: `ops.backup_manifest/v1` (manifest, integrity gate),
`ops.schema_migrations/v1` (staged migration, admission fence,
`ManagedService` quiesce/resume, managed-state digest, atomic `swapFrom`),
`app.data_lifecycle/v1` and `app.deletion_ledger/v1` (tombstones, deletion
operations, installation lifecycle ledger), `jobs.attempt_fence/v1` and
`jobs.session_reconcile/v1` (attempt fencing, native reconciliation),
`delivery.outbox/v1` (unknown outcomes stay unknown),
`schway.host.session-snapshot/v1` (engine compatibility only, metadata).

## Commands

All commands: `{ kind, requestId, projectId: null, expectedRevision, payload }`
with `expectedRevision` the installation (`app_state`) revision.
`restore.prepare` payload `{ backupId, note }` (note ≤ 500 bytes);
`restore.migrate`, `restore.apply_ledger`, `restore.validate`,
`restore.activate`, `restore.discard` payload `{ quarantineId }` only.
`execute` returns `Promise<RestoreReceipt>` (`{ quarantine: RestoreEvidence,
duplicate }`). Ledger content is never accepted from a command (an extra
payload key is `invalid_restore_command`); no acknowledgment field exists.

Order of checks: shape (`invalid_restore_command`), owner session, request
identity (`request_id_conflict`), revision (`stale_revision`), busy/fence
(`restore_in_progress`, `upgrade_in_progress`), then the command. None of
these write evidence. A replayed request id with the same payload returns the
current journal with `duplicate: true`.

## Phases

| State | Fence | Meaning | Actions |
| --- | --- | --- | --- |
| `preparing` | held | fence, quiesce, quarantine copy in progress | — (reopen → `failed`, `prepare_interrupted`) |
| `quarantined` | held | verified copy of the image in quarantine | migrate, discard |
| `migrated` | held | quarantine at the current schema, rows preserved | apply_ledger, discard |
| `ledger_applied` | held | latest trusted ledger replayed | validate, apply_ledger, discard |
| `validated` | held | every check passed; report final | activate, apply_ledger, discard |
| `blocked` | held | a step failed (ledger, migration, validation, live/ledger moved) | per progress: migrate/apply_ledger/validate, discard; none for `activation_state_unknown` |
| `activating` | held | activation intent persisted | activate (resolves intent) |
| `activated` | held until native reconciliation | quarantine is live; sessions revoked; native deletes or service resume pending | activate (retry) |
| `complete` | released | reconciled; quarantine copy removed | — |
| `failed` | released | refused at preflight or failed before activation | — |
| `discarded` | released | abandoned before activation | — |

## Prepare

Checks, all before any fence or copy, each refusal writing a `failed` journal
with `reason` and `nextAction` and leaving the backup untouched in the
registry:

1. The backup is in this installation's registry (`backup_not_found` 404, no
   journal) and its record validates (`backup_corrupt`).
2. Schema (`restoreCompat`): equal to this build → `direct`; between
   `minSupportedSchema` (15) and the build → `migrate`; newer →
   `newer_backup_unsupported`; older than 15 → `backup_unrestorable`
   (`manual_recovery_required`).
3. Application build (`restoreAppCompat`): the producing `jitVersion` must be
   this build or an older build of the same major version; a newer build is
   `newer_app_unsupported` (even at an equal schema number), another major
   line or an unparseable identity `unsupported_app_version`.
4. Manifest and integrity (`assertRestorableBackup`): `valid` state,
   available lifecycle checkpoint, native `valid`, complete inventory and
   every managed file verified (`backup_incomplete`, `backup_integrity_failed`,
   `backup_artifact_missing`).
5. Engine (`restoreEngineCompat`, metadata only, never snapshots): a backup
   without native references does not depend on the engine; otherwise its
   native capture must declare `schway.host.session-snapshot/v1` with the
   pinned format and the current port must be available and declare the same
   (`unsupported_engine`, `engine_unavailable`).

Then: the shared fence `<db>.upgrade-fence` is acquired exclusively (the
claim is hard-linked into place, failing if any fence exists; it is cleared
only by the id it names) with `holder: "restore"` (`upgradeId` = restore id);
losing the race fails the attempt (`restore_in_progress`/`upgrade_in_progress`). the service is quiesced
(`job_admission`, `model_runs`, `memory_extraction`, `context_assembly`,
`pr_monitoring`, `schedules`, `delivery` disabled; unsettled work fails with
`restore_quiesce_incomplete` and releases the fence), the fenced live revision
and managed-state digest are recorded, and the image is copied to
`<restoreDir>/<id>/quarantine.sqlite` and hash-verified. No worker ever opens
the quarantine copy. While the fence is held every other application command
is refused with `restore_in_progress`, job admission and pumping, schedule
ticks and delivery claims stop (the ops.schema_migrations/v1 fence rules), and
`upgrade.prepare` is refused; an active upgrade likewise refuses
`restore.prepare`.

## Migrate

`restore.migrate` digests every managed table of the quarantine copy, opens it
with the migrating `TransactionStore` (OPS06 versioned migrations, applied to
the copy only), and requires schema = this build, every pre-migration table,
column and row preserved on the old columns, and no foreign-key violation;
otherwise `blocked` with `quarantine_migration_failed`. A current-schema copy
is verified without migration (`not_required_schema_current`).

## Latest trusted ledger

The authority is the installation lifecycle ledger (`app.deletion_ledger/v1`,
data-lifecycle-v1): the installation-scoped `lifecycle_ledger` table, never
part of any image, plus its checkpoint file. `syncLedgerCheckpoint` returns
`trusted` only when the table is readable and the checkpoint is a verified
prefix of it; otherwise the restore is `blocked` with the reason:
`ledger_unreadable`, `ledger_bound_exceeded` (200 000 entries),
`ledger_checkpoint_missing` (missing after establishment at that location),
`ledger_checkpoint_relocation_unverified` (the configured location changed:
the checkpoint at the previously established location must be readable and
consistent with the table, and the new file must equal or extend it — copy
the verified checkpoint file; the marker moves only after that proof;
database contents never re-establish authority once a checkpoint exists),
`ledger_checkpoint_unverifiable` (corrupt, self-inconsistent, or a seed
placeholder over an established checkpoint), `ledger_checkpoint_incompatible`
(other format), `ledger_checkpoint_mismatch` (the installation table lost or
changed entries its checkpoint holds, e.g. the database was replaced outside
this flow, or an older checkpoint copy was put back) or `ledger_checkpoint_unavailable` (cannot write). There is no
override; the owner remedy is to put back a verified checkpoint, never to
assert that nothing was deleted.

## Apply ledger (replay)

One transaction on the quarantine copy, identity-only (payloads come from the
image and are purged; the ledger has none), with `secure_delete` on:

- every trusted entry is copied into the quarantine's `lifecycle_ledger` so
  every deny check inside quarantine sees the latest ledger;
- deletion tombstones (projects absent from the image are counted
  `notInImage`): source versions purged and marked unavailable, claims marked
  deleted and redacted, the tombstone inserted with its live id, and the same
  lineage-bound copy redaction as a confirm (`redactReplayedLineage`:
  producing-run outputs, stored manifests, receipts), task proposals of the
  generation redacted, and exact quoted copies scrubbed from runs, syntheses,
  jobs, attempts, proposals, outputs and local delivery copies;
- suppressions: claims marked forgotten; the suppression and its claim/source
  lineage rows inserted when the image holds the claim; otherwise the
  installation ledger alone enforces it (`ledgerOnlySuppressions`), because
  `deletedSource`, `deletedClaim`, `suppressedSource` and `suppressedClaim`
  consult the installation ledger;
- derived invalidation: pending work citing deleted or suppressed material is
  fenced (`source_retired`), stale contexts and extractions are fenced;
- native contexts: classified with the deletion inventory's own job evidence
  (`contextCitations` in src/memory/delete.ts: team runs, coordinator
  syntheses, memory extractions and job attempts). A context whose work cited
  deleted data — or whose records are unreadable or carry no structurally
  valid manifest (`unknown`, fail closed) — is retired and, unless a pending
  or blocked deletion operation covers it, gets a restore deletion operation
  (managed delete through the run port at activation); a context citing
  suppressed data, or retired/delete_failed in live, is retired; a context
  deleted in live is marked deleted; an inventory blocker fails the replay
  (`restore_context_inventory_blocked`);
- jobs: every non-terminal job loses commit authority (`invalidateJob`
  `interrupted`, attempts interrupted, occupancy cleared) and waits with
  `inspect_restored_job_then_resume_explicitly`; read work restarts only by an
  explicit owner `job.resume`, which applies the existing authority, budget,
  deadline and replay rules (non-read work requires manual reconciliation);
- outbox: every restored unsent intent (`waiting`, `queued`, `claimed`,
  retryable `failed`) becomes `unknown` (`restored_outcome_unknown`,
  `inspect_restored_intent_then_resend_explicitly`) and active delivery
  attempts are interrupted, because it may have been sent after the backup;
  only an explicit owner resend sends it;
- external integrations: the live Telegram binding is adopted when it
  differs, and PR monitors active in the image but paused, revoked or absent
  in live take the live state (or `paused`): a restore never re-enables an
  integration;
- generation fence: `app_state.revision` = max(live revision at prepare,
  image revision) + 1; scheduler/delivery claims are cleared.

## Validate

Checks (each `{ name, pass, detail }`): `fence`,
`live_unchanged_since_prepare`, `backup_integrity`, `engine_compat`,
`ledger_trusted`, `ledger_unchanged_since_replay`, `schema`, `integrity`
(`quick_check`), `foreign_keys`, `ledger_covers_backup` (the backup's own
tombstone and suppression ids and its recorded position are covered by the
latest ledger — the backup's own ledger never proves that no later deletion
occurred), `ledger_applied` (every entry in quarantine, payloads purged, no
withdrawn claim active), `jobs_fenced`, `outbox_held`, `native_sessions` (no
context citing deleted/suppressed data active, every one citing deleted data
deleted or scheduled), `generation_fence`, `quarantine_digest`. Any failure →
`blocked`. Validation records `pendingJobs`, `unknownOutbox`, `nativePending`
and live-only counts (projects, sources, contexts written after the backup and
discarded by activation).

## Activate

Requires `validated`: quiesce again; the trusted ledger, the fenced live
digest and the validated quarantine digest must all be unchanged
(`restore_ledger_moved`, `restore_stale_live`, `restore_quarantine_changed` →
`blocked`). Persist `activating`, `TransactionStore.swapFrom` (installation
tables — credentials, backup registry, lifecycle ledger and checkpoint — come
from live), then the live digest must equal the quarantine digest. Completion
(`completeRestoreActivation`, idempotent):

1. revoke every session (pre-restore browsers, adapters and stale commands
   are fenced; the owner signs in again; the Web redirects to `/login`);
2. with the fence still held, `ManagedService.fencedLifecycle` composes the
   team port (no admission possible) and runs session reconciliation and
   `reconcileDeletions`; a budget-exhausted (`failed`) operation still holding
   native data gets a fresh restore deletion operation on each owner retry;
   any operation (pending, blocked or failed) with a `pending`,
   `delete_failed` or `retire_failed` context keeps the journal `activated`
   with `native_delete_pending` and the fence held (`missing` means the engine
   reported the context absent);
3. release the fence and `ManagedService.resume` (rebuild scheduler and ports,
   reconcile jobs and native sessions, report unknown deliveries); failure
   re-acquires the fence → `activated`, `reconcile_pending`. Reopen re-fences
   every unfinished restore, so a crash between release and resume is fenced
   again.

Read gate: `<db>.restore-pending` is the one durable "restore complete"
predicate. It is written before the activation intent and removed only at
`complete` (or when the intent resolves to not swapped). While it exists every
`Application` read model and command (login sessions included) is refused
with `restore_incomplete` (423) except restore status, the restore console
(`restoreConsole`: revision and gate holder), the backup inventory, restore
commands and logout; the Web redirects ordinary pages to `/restores`, renders
the console without project data, and `serve` logs that only restore
remediation is served.

Without a managed service in process the journal stays `activated` with the
fence held, and `Application.boot()` (serve, `startFullApp`) completes it
before normal boot. Receipts and audit are mirrored into the installation
after the attempt ends; at most 50 terminal journals are kept.

Reopen (`recoverRestoresOnOpen`, Application constructor): `preparing` →
`failed` (fence released, copy removed); `activating` resolves by identity —
quarantine digest → `activated`, fenced live digest → `validated`
(`activation_interrupted`), else `blocked` (`activation_state_unknown`, no
actions, human inspection). A fenced journal whose fence vanished is
re-fenced; a restore fence of an ended journal is released.

## Control state

`<restoreDir>/<id>/journal.json` (default `<db>.restores`), atomically
replaced, outside the swapped database; the quarantine copy lives beside it
and is removed at `complete`, `failed` and `discarded`. The legacy
`restore_quarantines` table (schema 20) is no longer written.

## Owner report (`RestoreEvidence.report`)

`versions` (backup/current build and schema, quarantine schema, engine
verdict), `ledger` (source, head, counts, backup checkpoint/position),
`invalidated` (sources purged, claims purged/forgotten, suppressions applied
and ledger-only, contexts retired/already deleted/scheduled, jobs and
attempts fenced, deliveries held, Telegram binding, PR monitors), `pending`
(jobs awaiting owner resume, unknown deliveries, native deletes pending),
`discarded` (live-only counts), `retention` (retained backups still hold
deleted data until pruned; live writes discarded; native sessions are not
restored from snapshots; Telegram/provider copies are outside Jit),
`generation` (live and restored revision, sessions revoked) and `activation`
(`allowed`, `blockers`). Evidence carries identities and counts only.

## Residuals and follow-ups

- Declared residual (fence release): `clearUpgradeFence(path, ownerId)` reads
  the claim and then unlinks it. If two clearers of the same stale owner run
  concurrently and a new acquirer creates its claim between one clearer's
  read and unlink, that new fence could be removed. It requires two
  concurrent clearers of the same stale owner plus an interleaving new
  acquisition; same class as schway#428. A proper fix needs an OS-released
  lock primitive (no such primitive is used here).

- Before activation (quarantine) the live installation is untouched current
  data, so reads stay available; only writes are fenced.

- Native sessions are not restored from the backup's opaque snapshots
  (Schway `restoreSessionSnapshot` is not used); restored references resolve
  against the live engine and are reconciled by `jobs.session_reconcile/v1`.
  Post-backup native sessions stay with the engine and are reported as
  live-only contexts.
- Restoring into a different installation (a backup outside this registry,
  or a lost database without its ledger checkpoint) is not supported; it
  needs an import path and an owner procedure for ledger authority.

## Evidence

`tests/ops-restore.test.ts`: compatibility matrix; restore after delete and
forget proving no removed payload reaches extraction, context assembly,
memory reads, notifications or database bytes (including a forget known only
to the installation ledger); missing/corrupt/tampered/incompatible/seed/
mismatched ledgers and an owner tombstone payload refused; a re-established
empty ledger not covering the backup; failed native delete keeping the
installation fenced across restart, then completing; crash at every boundary;
in-flight attempt, queued jobs and unknown outbox fenced and never replayed,
failed reconciliation staying fenced until boot; supported (21 → 23),
newer, too-old, failed-migration and unsupported-engine images; integration
revocation preserved; restore/upgrade exclusion; ledger triggers, checkpoint
establishment and the service `ledgerPath`; Web. `tests/ops-backup.test.ts`:
restore gate refusals and registry preservation with boot completion.
