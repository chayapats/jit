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

Existence alone never makes the directory trusted (`backupDirectoryProblem`).
Service preflight blocks the `config` gate (`restrict-backup-directory`) when the
backup directory is a symlink, does not resolve to the same inode through its
canonical path, is owned by another uid, or grants any group/other access. Before
each write the writer opens the directory without following symlinks, rejects a
foreign owner and removes group/other bits through that descriptor. Managed files
are created exclusively (`O_CREAT|O_EXCL|O_NOFOLLOW`, 0600). An existing file or
planted link at the name fails with `backup_storage_unavailable`. It is never
overwritten or followed.

## Commands and reads

| Public entry | Behavior |
| --- | --- |
| `Application.execute(actor, backup.create)` → `Promise<BackupReceipt>` | Staged creation (below). Duplicate `requestId` returns the committed receipt; a different payload is `request_id_conflict`; a stale workspace revision is `stale_revision`. |
| `Application.execute(actor, backup.prune)` → `BackupReceipt` | Keeps the newest `keep` (1–10) backups. Rows are removed in one transaction; files are deleted only after it commits. |
| `Application.backups(actor)` / `Application.backup(actor, id)` | Bounded inventory (≤ 100, oldest first; retention keeps it installation-bounded) with `integrity` per id, and one validated manifest with `integrity`, both from `verifyBackupArtifacts`; every listed entry is verified and an `invalid` verdict presents the manifest as `incomplete` with the integrity reason. Neither parses backup bytes. Web: `GET /backups`, `GET /backups/:id`, `GET /api/backups`, `POST /api/backups`. |
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
`snapshot(plan, { maxBytes }) → BackupNativeSnapshot | Promise<…>`, optional
`engine`, `staged`, and the supported `contract`/`formatVersion`. The snapshot
returns `refs`, `engine`, `contract`, `formatVersion` and opaque
`artifacts: { name, bytes, sha256 }[]`. The core validates refs, recomputes
every artifact hash (`native_artifact_hash_mismatch`), requires an artifact for
any non-empty ref set (`native_artifacts_missing`), requires every non-empty
capture to declare exactly the port's supported contract and positive format
version (`native_snapshot_incompatible`), and never inspects artifact content.
`maxBytes` is the remaining 64 MiB budget after the app image; exceeding it is
`backup_too_large`.

`SchwayBackupNativePort` resolves `schway_native_refs` joined with
`team_contexts` on id and generation. Only contexts explicitly `deleted` are
excluded; refs with a missing, generation-mismatched or unknown context fail
`native_ref_orphaned`; every row enters the fingerprint; reserved intents
without a native id fail `native_ref_unresolved`; running sessions fail
`native_sessions_busy`; more than 1024 sessions fail
`native_snapshot_over_limit`. Capture opens the pinned lifecycle host, checks
`capabilities.snapshotContract`, calls `snapshotSessions` one session per call
by default (at most `MAX_SNAPSHOT_SESSIONS`), checks the cumulative serialized
size against `maxBytes` after every call and stops before requesting more, and
maps host errors: `busy` →
`native_sessions_busy`, `conflict` → `native_snapshot_conflict`,
`storage`/`invalid-reference` → `native_artifact_missing`,
`workspace-mismatch` → `native_snapshot_incompatible`. Each snapshot must pass
`validateSessionSnapshot`, match `schway.host.session-snapshot/v1` and
`SNAPSHOT_NATIVE_FORMAT_VERSION`, and cover exactly the requested references.
Synchronous callers never invoke a staged port; they fail closed with
`native_snapshot_requires_staged_backup`. Upgrade prepare
(ops.schema_migrations/v1) creates its recovery point through the same staged
creation (`stageManagedBackup`), so the concrete port works there too.

## Manifest fields

`contract`, `id`, `createdAt`, `appSchema` (`user_version`), `jitVersion`
(`jit/<package.json version>`, injectable as `ApplicationOptions.jitVersion`,
validated as `jit/<semver>` on read and restore), `appRevision`, `projects`,
`sourceGenerations`, `inventory` (`complete` plus `total`/`recorded` for
projects ≤ 1000 and sources ≤ 4000), `lifecycle` (`available`, `checkpoint`
`ledger:<sha256>` over the ordered deletion-ledger and suppression ids,
`position` counts, `reason`; an empty readable ledger is position zero, an
unreadable or malformed ledger is `ledger_unverifiable` and never inferred as
"no deletions"), `native`
(`state`, `refs` as app run ids + generations, measured `bytes`, `engine`,
`reason`, `contract`, `formatVersion`, `artifacts[{name, path, bytes, hash}]`),
`content` (image bytes/hash and counts), `retention` (`maxBackups` 10,
`maxBytes` 64 MiB, `pruned`), `credentials`, `state`, `reason`, `artifact`
(image path/bytes/hash).

A port result is `native_snapshot_invalid` unless its declared `bytes` is a
non-negative safe integer and every ref is exactly `{ id, generation }` with a
valid id, a positive safe-integer generation and no duplicate id; the manifest
records measured bytes, never the declaration.

`state` is `valid` only when native capture, lifecycle checkpoint and inventory
are all complete; otherwise `incomplete` with the first failing reason. Opaque
native session/branch ids never appear in a manifest.

## Integrity and restore gate

`verifyBackupArtifacts(manifest, backupDir)` requires the image at exactly
`<backupDir>/<id>.sqlite` and native artifacts at exactly
`<backupDir>/<id>.native-<n>.json` in order, each a regular non-symlink file
with the recorded size and SHA-256; native artifacts need a declared
contract/format and a valid non-empty native set needs artifacts. Restore
preparation (`assertRestorableBackup`, before any quarantine copy) requires
`state: "valid"`, an available lifecycle checkpoint, native `valid`, a complete
inventory (`backup_incomplete`) and verified files (`backup_artifact_missing`
for a missing image, otherwise `backup_integrity_failed`). No owner
acknowledgment, including an empty external ledger, overrides it.

## Upstream residual

`snapshotSessions` has no caller byte ceiling or streaming form, so one call
may read and return up to the host's own bounds (`MAX_SNAPSHOT_ARTIFACT_BYTES`
32 MiB per artifact, 256 MiB decoded per snapshot) before Jit can reject it.
Single-session calls keep that to one session's capture. A strict
pre-allocation bound needs a Schway host contract extension (a caller byte
ceiling or streamed snapshot).

## Credential exclusion

Every table is classified in `backupImageTables`; an unclassified table fails
creation with `backup_schema_unclassified`. The image empties `owner`,
`sessions`, `login_throttle`, `ops_backups`, `lifecycle_ledger`,
`lifecycle_checkpoint`, `job_scheduler` and `delivery_worker`, nulls
pending Telegram challenge nonces, nulls secret-bearing keys inside
`command_receipts.result_json`, zeroes freed pages (`secure_delete`) and
vacuums. The manifest records `credentials: { included: false, excludedTables,
scrubbed, restore: "owner_credential_setup_required" }`. There is no secret
backup procedure in v1.

The managed backup registry (`ops_backups`) and the installation lifecycle
ledger (`lifecycle_ledger`, `lifecycle_checkpoint`; schema 23,
app.deletion_ledger/v1) are installation state, likewise excluded from images
(`installationScopedTables` in `src/store.ts`).
Owner interface preferences (`owner_preferences`; schema 24, ui.preferences/v1)
hold no credentials and are included in images like other owner configuration.
Owner persona revisions (`persona_revisions`; schema 25, app.persona/v1) and the
identity-only Jit reply index (`jit_replies`; schema 25, app.jit_reply/v1) are
included likewise; reply records themselves live in `team_runs`.
Setup progress (`setup_state`; schema 26, app.setup/v1) and the General space
identity (`general_space`; schema 26, app.general_space/v1) are owner
configuration without credentials and are included likewise.
Dispatch allowance revisions (`dispatch_allowance_revisions`; schema 27,
app.dispatch_allowance/v1) and the identity-only dispatch proposals
(`dispatch_proposals`) are included likewise.
Topic promotion links (`topic_promotions`; schema 28, app.topic_promotion/v1)
and chat title lineage (`chat_title_sources`) hold identities only and are
included likewise.
The loopback API setting (`local_api_settings`; schema 29, app.local_api/v1)
records only whether the owner turned the API on; it is included likewise. The
API token lives in `<data>/local-api/` files, never in the database or an image.
Access level revisions, restrict-only role overrides and kill switch revisions
(`project_access_revisions`, `role_access_overrides`, `execution_halts`; schema
31, app.access_level/v1) are owner configuration without credentials and are
included likewise.
Webhook triggers (`webhook_triggers`; schema 32, app.webhook_triggers/v1) are
classified `scrub`: identities and revisions are kept and `sealed_secret` is
nulled in every image (`webhook_triggers.sealed_secret` in `scrubbed`), so a
restored trigger reports `secretAvailable: false` until the owner rotates it.
The sealing key lives in `<data>/webhooks/seal.key`, never in the database or
an image. Delivery receipts (`webhook_receipts`, delivery ids only) and the
service-owned poll schedule (`pr_poll_due`) are included.
Owner box reset revisions (`execution_box_resets`; schema 33, exec.box_runtime/v1)
are included likewise. A box, its workspace and its output live under
`execution.directory` and never enter the database or an image.
Activation (`TransactionStore.swapFrom`, used by OPS02 restore and upgrade
activation) builds the complete replacement image before an atomic rename and
always keeps the live installation's owner verifier, sessions,
throttle, backup registry and lifecycle ledger, so restoring a backup can never
roll back current tombstones or suppressions, and restoring one backup never forgets the others
or orphans their files; listing re-verifies every preserved row against its
managed files and orphan reconciliation only removes files with no live row.
`export_artifact_bodies` is pre-classified `exclude` for #31. Restoring into an installation without an owner therefore requires
owner credential setup (`bun src/main.ts setup`). Restored images never start
workers: scheduler and delivery claims are absent and OPS02 quarantine plus
replay of the latest installation ledger gate activation
([ops-quarantined-restore-v1](ops-quarantined-restore-v1.md)).

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
changes during capture, over-limit sets, upgrade recovery points through the
concrete staged port.
`tests/ops-backup-service.test.ts`: `startFullApp` in schway and scripted
modes writing under `service.backupDirectory`, gate failure, and a `serve`
subprocess creating a backup over HTTP plus fail-closed startup.
