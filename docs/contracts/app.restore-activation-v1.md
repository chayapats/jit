# app.restore-activation/v1

OPS14-01 #263, schema **14**, behind `--s14`. Consumes [app.managed-backup/v1](app.managed-backup-v1.md), app.memory-scope/v2, app.context-provenance/v2, app.snapshot-sharing/v1, app.bot-lifecycle/v1, app.work-checkpoints/v1, app.replay-policy/v1, app.routine-grants/v1 and the independent S14 lifecycle database. ADRs 0025–0027 retain the legacy invariants; ADR 0057 records this separate S14 implementation. FR-15/16/18/31/35/36/38; NFR-05/07/08/10/12/14; S14-AC01/05/06/11/14.

## Commands and states

Offline owner ingress is `bun src/main.ts ops --s14 [--command <JSON-file>] [--password-stdin]`; without `--command` it returns sanitized maintenance status. stdout is the JSON result; a credential-free next step for the owner goes to stderr and is guidance only. Password is hidden terminal input or explicit stdin, never a command argument or command JSON field. The CLI takes the exclusive runtime lock, authenticates the current installation owner, and invokes `S14Maintenance.execute(actor,OpsCommand)`. Keep current routes/resources configured when validating retained evidence; missing/changed route evidence does not fall back. The running service accepts only routine `backup.create` through `app.backups`; every restore/upgrade mutation stays offline and returns `s14_ops_offline_required` on the Web command route. No shutdown endpoint is added. `GET /api/s14/ops` includes authenticated online backup progress/retention metadata; see the HTTP handoff.

All commands use maintenance `revision`, exact payload keys and durable request identity. Queries grant no cutover. The command file is data submitted by the authenticated owner, never a model-created authority channel.

| Kind | Payload | Result |
| --- | --- | --- |
| `backup.create` | `{}` | Complete registered credential-free backup |
| `restore.prepare` | `{backupId}` | Preflight, recovery point, quarantine import, lifecycle/native validation; validated, partial or blocked |
| `upgrade.prepare` | `{targetSchema:14}` | Same staging path with a new managed recovery point |
| `restore.validate` | `{stageId}` | Rebuild candidate from its immutable image, retry reconciliation and issue a new exact action hash |
| `restore.activate` | `{stageId,actionHash}` | Exact owner-authorized cutover or resolution of its persisted intent |
| `restore.discard` | `{stageId}` | Before activation, discard candidate and retain live; also resolves an interrupted capture identified by offline `pendingBackupId` |
| `upgrade.rollback` | `{stageId}` | Before activation only, discard the staged upgrade |

`OpsReceipt` contains request/revision/state/reason, optional backup ID and sanitized stage, workers `fenced|stopped`, and `reconnectionRequired:true`. Stage states: preparing, validated, activating, complete, partial, blocked, discarded. Preparing/validated/activating/partial/blocked keep the durable fence and prevent all normal readers/workers. Complete means installation restore finished, not that unknown effects succeeded or work completed. Workers remain stopped until the operator explicitly starts normal service. Partial native import stays partial and fenced; retry never claims all bytes restored from a subset. Underlying transport exception text is discarded.

Offline status returns revision, backup IDs, `pendingBackupId`, sanitized stage/actionHash/recovery point and worker gate. Internal stage directories are never a caller-selectable command field and are not returned to owners. A complete/discarded receipt whose final fence removal crashed can be retried to remove only its own fence. Other operation IDs cannot clear it.

## Compatibility matrix

| Input/build | Behavior |
| --- | --- |
| Fresh S14 schema 14, `jit/0.1.0`, managed-backup/v1, native snapshot/v1 format 4 | Supported 14→14 staged validation and activation |
| S14 schemas 1–13 | Unreleased formats refuse with fresh-state; no migration chain invented |
| Future schema/build, mismatching native version/capability | Refuse before fence/candidate write |
| Legacy application or legacy ops manifest | Refuse before writes; never convert, erase or reinterpret |
| Other installation, host or native workspace path | Unsupported; no ledger bootstrap or opaque-native relocation |

The framework stages copies instead of migrating at boot; no released older S14 schema exists yet. A future real schema needs an explicit reviewed migration, preserving row contracts and recovery evidence, plus an expanded matrix. This slice makes no claim that arbitrary future schemas already upgrade. Upgrade rollback after activation is a **new quarantined restore** of `recoveryBackupId`, with the latest independent ledger; the raw prior database is never used to bypass reconciliation.

## Quarantine, reconciliation and validation

Preflight verifies the registered manifest, bounded type/path/hash/schema/build/native compatibility and the latest independent ledger before any candidate write. The active application remains byte-for-byte unchanged by prepare/validate (ordinary offline authentication affects only login/session records). A recovery backup of current application/artifacts/native state is committed before staging. Each stage has a private candidate and separate native session directory. It attaches a private quarantine copy of the actual current lifecycle database, never a ledger from the archive. Candidate-derived withdrawals and reservations stay in that copy until exact owner activation; validation, failure and discard cannot write the installation’s ledger. An image alone cannot make a fresh unrelated installation authoritative.

Validation checks schema objects against the active known format in memory before opening writable quarantine, verifies exact artifact inventory, imports every required native snapshot using public `restoreSessionSnapshot`, and runs existing memory/share/Bot/report/routine/REC14 reconciliation. Hash-only append-ledger prefix positions must still match the independent ledger. No deletion/forget/access/share/Bot/computer retirement or usage high-water mark is rolled back. If an archived computer generation was destructively withdrawn, staging preserves the matching installation’s later stopped/deleted generation and workspace/profile identities from live state. Missing or unsettled current cleanup evidence blocks with `s14_ops_computer_cleanup_evidence_required`; the image cannot invent replacement volumes or make a deleted computer usable. Native contexts withdrawn after capture are deleted through public lifecycle APIs inside quarantine before any reader or worker can see them. Current catalog identities absent from the image are discovered as orphan scopes, never invented as new work.

Every old execution grant is revoked, queued work is parked, pending/approved effects expire, executing/claimed effects remain unknown/reconcile-only, proposed capability changes supersede, routines become blocked pending a new owner enable, queued chat blocks and unsent attention becomes unknown with no retries. Input leases/staging/transient connection metadata do not return. Retained valid reports/artifacts remain evidence rather than execution authority. Current owner generation is preserved for retained-evidence contracts while all old session tokens are removed; grants remain independently revoked. Production composition holds the initial worker gate even before the first REC14 call; an exception keeps it closed. Normal REC14 may reconcile the restored installation again at boot but cannot replay these revoked grants or blocked routines.

Native unresolved/partial/close failures and unresolved computer/Bot cleanup keep the stage fenced. This CLI does not construct a computer runtime: installations retaining computers require their trusted runtime supplied through the maintenance service seam; missing stop/destructive-cleanup evidence blocks activation. Browser profile/workspace volumes are not restored by this contract. Service-account connections must be explicitly reconnected where absent; Parallel restores anonymous. No fallback account/model/billing is selected.

## Exact activation and crash recovery

Validation produces `actionHash` bound to contract, stage, candidate and quarantine-ledger digests, live managed-state digest, current ledger head and source backup. Login/throttle/session changes do not stale the managed digest; other managed mutations or ledger drift refuse activation and require revalidation. Files and hashes are checked again, including a public native inventory/opaque-byte digest recomputed immediately before cutover and on an interrupted activation retry. Changed native bytes remain fenced. The existing owner verifier is copied from live into the activation image locally and all sessions are removed. It never enters an ordinary archive.

Before rename, an external journal records activation intent, old and target managed-state digests, exact activation-file hash, and a durable local `prior.sqlite`. That prior file is private installation recovery state containing live credentials, explicitly **not** a managed backup/export. It is never served or packaged. After that durable exact-owner intent, one transaction publishes only the validated quarantine ledger’s append-only facts and monotonic usage maxima into the current independent ledger; it never replaces the ledger. The transaction verifies the exact target ledger digest, and an interrupted retry accepts only the recorded prior or target ledger. The candidate is then renamed atomically over the closed main application file on the same filesystem, then the stable native-workspace/session-directory pointer is durably switched. The external fence covers the two-file switch and survives process death. Native workspace IDs remain stable; only session storage changes.

After a crash the owner reauthenticates offline and retries the same exact activate command. Managed-state digests distinguish prior from target despite a new login; prior permits one verified rename, target permits completion of the native pointer switch, neither remains `s14_ops_activation_state_unknown`. No worker can observe a mixed generation. The journal/receipt commits before fence removal; failure keeps the fence. A pre-activation discard never touches live state or current ledger. A post-activation rollback uses quarantine/current tombstones again.

Tests: `tests/s14-ops.test.ts` covers state/artifact/native round trip with real public local Schway storage, credential sentinels, source deletion/forget, share revoke, Bot retire/delete, reservation/effect anti-resurrection, incompatible input, traversal/symlink/bounds, capture/import/reconciliation/cutover fault windows, exact-owner/revision/lock barriers and rollback. Fixtures do not certify Linux host isolation, power-loss durability, live subscriptions or product UI. Those evidence boxes stay pending.
