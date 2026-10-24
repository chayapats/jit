# OPS backup manifest contract, v1

Owner: Jit #18 (OPS01). `ops.backup_manifest/v1` is implemented on the
`jit/18-backup-concrete` branch. It consumes `app.transaction_store/v1`,
`app.owner_identity/v1`, `jit.schway.bridge/v1` and
`schway.host.session-snapshot/v1` (pinned `schway/host` 1.0.0-rc.2). Live
restore, worker activation, remote providers and any credential export are out
of scope; OPS02 (`ops.quarantined_restore/v1`) consumes this contract.

## Managed backup

A managed backup is one committed row in the installation-scoped `ops_backups`
table plus the files its manifest names inside the trusted backup directory:

| File | Content |
| --- | --- |
| `<id>.sqlite` | Credential-free SQLite application image (mode 0600). |
| `<id>.native-<n>.json` | One opaque `HostSessionSnapshot` per `snapshotSessions` call (mode 0600). Jit hashes and stores it; it never parses native session bytes. |

The backup directory is `service.backupDirectory` under `startFullApp`, or
`<database>.backups` for plain `serve`. Files without a committed manifest are
orphans.

## Commands and reads

| Public entry | Behavior |
| --- | --- |
| `Application.execute(actor, backup.create)` → `Promise<BackupReceipt>` | Staged creation (below). Duplicate `requestId` returns the committed receipt; a different payload is `request_id_conflict`; a stale workspace revision is `stale_revision`. |
| `Application.execute(actor, backup.prune)` → `BackupReceipt` | Keeps the newest `keep` (1–10) backups. Rows are removed in one transaction; files are deleted only after it commits. |
| `Application.backups(actor)` / `Application.backup(actor, id)` | Bounded inventory (≤ 100, oldest first) and one validated manifest. Neither parses backup bytes. Web: `GET /backups`, `GET /backups/:id`, `GET /api/backups`, `POST /api/backups`. |
| `backupNativePortFor(config, store)` | The single selection rule for `serve` and `startFullApp`: `SchwayBackupNativePort` only when `JIT_RUN_PORT=schway`; otherwise no port. |

### Staged creation

1. One immediate transaction authorizes the owner, checks dedup and revision,
   reconciles orphans, and captures from the same committed view: the
   credential-free image, reference inventory, lifecycle checkpoint and the
   native port's exact reference plan (`resolve(tx)`).
2. The native port captures exactly that plan (asynchronous engine I/O).
3. A backup whose app image plus native artifacts exceed the 64 MiB ceiling
   fails `backup_too_large` before anything is deleted or written. Files are
   then staged; any write failure is `backup_storage_unavailable` with no
   inventory entry and no staged file left behind.
4. One immediate transaction re-authorizes, re-checks dedup, compares the
   native plan fingerprint (a moved set becomes `native_changed_during_backup`
   and its artifacts are discarded), removes retention victims' rows and
   inserts manifest, receipt and audit.
5. Only after commit are victims' files deleted. A failure before commit
   removes only this attempt's staged files.

### Native port (`BackupNativePort`)

`available()`, optional `resolve(tx) → { refs, fingerprint, detail }`,
`snapshot(plan) → BackupNativeSnapshot | Promise<…>`, optional `engine` and
`staged`. The snapshot returns `refs`, `engine`, `contract`, `formatVersion`
and opaque `artifacts: { name, bytes, sha256 }[]`. The core validates refs,
recomputes every artifact hash (`native_artifact_hash_mismatch`), requires an
artifact for any non-empty ref set (`native_artifacts_missing`) and never
inspects artifact content.

`SchwayBackupNativePort` resolves `schway_native_refs` joined with
`team_contexts`. App-deleted contexts are excluded; reserved intents without a
native id fail `native_ref_unresolved`; running sessions fail
`native_sessions_busy`; more than 1024 sessions fail
`native_snapshot_over_limit`. Capture opens the pinned lifecycle host, checks
`capabilities.snapshotContract`, calls `snapshotSessions` in chunks of at most
`MAX_SNAPSHOT_SESSIONS`, and maps host errors: `busy` →
`native_sessions_busy`, `conflict` → `native_snapshot_conflict`,
`storage`/`invalid-reference` → `native_artifact_missing`,
`workspace-mismatch` → `native_snapshot_incompatible`. Each snapshot must pass
`validateSessionSnapshot`, match `schway.host.session-snapshot/v1` and
`SNAPSHOT_NATIVE_FORMAT_VERSION`, and cover exactly the requested references.
Synchronous callers (upgrade prepare) never invoke a staged port; they fail
closed with `native_snapshot_requires_staged_backup`.

## Manifest fields

`contract`, `id`, `createdAt`, `appSchema` (`user_version`), `jitVersion`
(`jit/<package.json version>`, injectable as `ApplicationOptions.jitVersion`,
validated as `jit/<semver>` on read and restore), `appRevision`, `projects`,
`sourceGenerations`, `inventory` (`complete` plus `total`/`recorded` for
projects ≤ 1000 and sources ≤ 4000), `lifecycle` (`available`, `checkpoint`,
`reason` — absence is explicit, never inferred as "no deletions"), `native`
(`state`, `refs` as app run ids + generations, measured `bytes`, `engine`,
`reason`, `contract`, `formatVersion`, `artifacts[{name, path, bytes, hash}]`),
`content` (image bytes/hash and counts), `retention` (`maxBackups` 10,
`maxBytes` 64 MiB, `pruned`), `credentials`, `state`, `reason`, `artifact`
(image path/bytes/hash).

`state` is `valid` only when native capture, lifecycle checkpoint and inventory
are all complete; otherwise `incomplete` with the first failing reason. Opaque
native session/branch ids never appear in a manifest.

## Credential exclusion

Every table is classified in `backupImageTables`; an unclassified table fails
creation with `backup_schema_unclassified`. The image empties `owner`,
`sessions`, `login_throttle`, `job_scheduler` and `delivery_worker`, nulls
pending Telegram challenge nonces, nulls secret-bearing keys inside
`command_receipts.result_json`, zeroes freed pages (`secure_delete`) and
vacuums. The manifest records `credentials: { included: false, excludedTables,
scrubbed, restore: "owner_credential_setup_required" }`. There is no secret
backup procedure in v1.

Activation (`TransactionStore.swapFrom`, used by OPS02 restore and upgrade
rollback) always keeps the live installation's owner verifier, sessions and
throttle. Restoring into an installation without an owner therefore requires
owner credential setup (`bun src/main.ts setup`). Restored images never start
workers: scheduler and delivery claims are absent and OPS02 quarantine plus
external-ledger reconciliation gate activation.

## Evidence

`tests/ops-backup.test.ts`: fail-closed without engine/ledger, valid backup
with independent hash/SQLite validation after reopen, dedup and concurrent
duplicates, interrupted creation, native failure/hash mismatch/missing
artifacts, retention ordering and post-commit deletion, rollback after victim
selection, cumulative retention plan, oversize rejection, disk-full staging,
orphan reconciliation, concurrent writes, credential exclusion over raw image
bytes, table classification, credential carry-over on activation, version
injection/validation, inventory overflow, Web/API; concrete Schway port over
real native sessions (scripted model, no network): gate failure,
`snapshotSessions` capture validated by `validateSessionSnapshot`, chunking,
nonexistent/deleted sessions, unresolved intents, busy rows and host leases,
changes during capture, over-limit sets, upgrade fail-closed on staged ports.
`tests/ops-backup-service.test.ts`: `startFullApp` in schway and scripted
modes writing under `service.backupDirectory`, gate failure, and a `serve`
subprocess creating a backup over HTTP plus fail-closed startup.
