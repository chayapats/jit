# S14 offline backup, upgrade and quarantined restore

OPS14-01 #263. Opt-in fresh S14 only; legacy commands/state are unchanged. Contracts: app.managed-backup/v1 and app.restore-activation/v1, application schema 14, Schway snapshot/v1 format 4. See [compatibility and activation](../contracts/app.restore-activation-v1.md) before operating. All product UI acceptance remains pending.

## Routine backup from the running service

Read authenticated `GET /api/s14/ops`, then submit `backup.create` with `{}` to `POST /api/s14/commands`, using session/CSRF and `backup.revision`. The existing no-script `/s14/commands` envelope also accepts it. Retain the request ID and read `/api/s14/backup-receipts/:requestId` until complete/blocked; duplicate requests do not recapture. No terminal or password argument is required. The UI agent consumes this typed seam; product presentation remains pending.

Busy work, active device sign-in or non-stopped computers refuse with `s14_ops_quiesce_required`; settle them with the existing owner controls and submit a new owner request. Capture pauses managed writers/workers while authenticated progress remains readable. It has a 60-second deadline; an unsettled native call stays visibly fenced until it actually closes. Restart reconciles interrupted capture before workers, without auto-retrying it.

Online retention rotates only oldest online-created images after a successful replacement, preserves offline/stage recovery points and leaves one of ten slots for offline recovery. No arbitrary path/archive/credential is accepted or returned. The 100-request retry journal is a finite research-MVP bound and requires a future reviewed archival policy when full.

## Offline maintenance on an existing installation

1. Stop `serve --s14` through its normal service manager and wait for actual shutdown. Do not force-clear transport occupancy. If recovery is unresolved, run normal exclusive service boot/REC14 reconciliation, inspect it, then stop cleanly. Computers must be stopped; this CLI supplies no computer runtime. A remaining computer cleanup requirement blocks activation until the trusted service seam supplies its actual runtime.
2. Use the same `JIT_S14_DATABASE`, exact `JIT_S14_ROUTES` and `JIT_S14_RESOURCES` configuration as the installation. Leave its current independent `<database>.lifecycle.sqlite` in place. Never copy a backup ledger over it, clear an ops fence or overwrite an installation file manually.
3. Run `bun src/main.ts ops --s14` for owner-authenticated status. It prints maintenance revision/backup IDs/pending capture/stage metadata; password is hidden terminal input. For automation, `--password-stdin` explicitly accepts the password from a protected secret-delivery file/pipe. Do not put passwords in arguments, JSON commands, shell history, tracked files or ordinary evidence.
4. Write an exact credential-free command JSON in an ignored local record, mode 0600. For example, using the current status revision:

```json
{"kind":"backup.create","requestId":"owner_unique_retry_identity","expectedRevision":0,"payload":{}}
```

Run `bun src/main.ts ops --s14 --command .local/ops-command.json` and retain its receipt/request ID. `complete` means every component and manifest is durable/registered. The archive is `<database>.ops/backups/<backupId>/`; it contains only application image, opaque native snapshots and manifest. It deliberately excludes owner authentication, all service credentials, profile/workspace volumes and the current independent lifecycle database. Native envelope workspace identity binds this host/path. There is no cross-installation import or relocation command.

5. To restore, submit a fresh exact command `restore.prepare` with `{backupId}` and the current **maintenance** revision. This creates a recovery point of current state, validates/imports a separate candidate, reconciles current tombstones/native state and returns validated, partial or blocked. All keep service boot fenced. `restore.validate` with `{stageId}` rebuilds from the immutable backup and retries; native partial is never success. `restore.discard` drops only an unactivated candidate. An interrupted capture appears as `pendingBackupId`; `restore.discard` with that ID removes only unregistered capture files and releases its own fence.
6. Review the returned current stage/actionHash, recovery point and reason. Only a deliberate owner `restore.activate` with `{stageId,actionHash}` authorizes cutover. Submit a fresh request ID at current maintenance revision; retain that exact command across crashes. Stale hashes or live/ledger changes require current validation/review. Login/session rotation alone does not stale the action.
7. If cutover crashes, run offline status and reauthenticate, then retry the same exact activate request. Do not rename images/pointers or delete fences. Prior/target managed digests resolve one active generation; an unrecognized state remains blocked for investigation. A completed receipt retry can finish its own interrupted fence removal.
8. After complete, reconnect absent service connections explicitly (Parallel starts anonymous), then explicitly start `serve --s14`. All old sessions/grants/approvals/routines/chat/sends remain fenced/expired/blocked/unknown as described by the contract. The restored report history does not authorize execution. Inspect `/api/s14/recovery`, work/effect/routine history and the normal account/resource controls before starting new work.

Upgrade uses `upgrade.prepare` with `{targetSchema:14}`, then the same validate/exact activate seam. This build supports only 14→14 staging; it refuses all unreleased 1–13, legacy and future schemas/builds rather than invent a conversion. Pre-cutover `upgrade.rollback` discards the candidate. Post-cutover rollback is a new `restore.prepare` of `recoveryBackupId`, followed by current-ledger validation and new exact activation. Never activate private `prior.sqlite` directly. That file and prior native stores contain installation-local recovery state and are not ordinary backup/export artifacts.

Bounds refuse clearly: 10 backups, 100 durable commands, 64 MiB image+serialized native bytes, 2 MiB manifest/control, 1024 native intents, 200000 rows/ledger entries. Offline capture does not prune; limited online rotation is described above. Journal archival is not implemented. Do not remove registry/control records to bypass these bounds. Schway can allocate one host-bounded capture before Jit enforces its serialized byte limit; caller streaming/budget support is absent upstream.

## Opt-in Linux x64 and arm64 round-trip evidence

**Pending: the implementation agent has not run these on either real Linux host.** The orchestrator runs this procedure later on both supported architectures. Deterministic macOS/local public-host fixtures do not certify Linux filesystem durability, rootless isolation, reboot, power loss or live subscriptions.

Use the final merged stack revision, Bun matching the lockfile and the pinned vendor artifact. Do not point the drill at a real owner installation or supply provider credentials. The script creates a unique fresh ignored `.local/evidence/s14-ops-<arch>-*/` fixture, provisions a random local-only owner verifier and makes **zero** network/model/paid calls. It retains its private fixture and sanitized `roundtrip-evidence.json` for local review.

```sh
bun install --frozen-lockfile
JIT_S14_OPS_ROUNDTRIP=1 bun src/s14/ops-roundtrip.ts
```

The entry point refuses without explicit opt-in, Linux and `x64|arm64`. It creates a committed application report and artifact BLOBs, a real retired public Schway native session, captures a managed backup, deletes a source after capture, restores the older image in quarantine, checks latest lifecycle deletion including native deletion, activates exactly, verifies independent report/artifact hashes remain readable and old grants cannot acquire execution authority. Sanitized evidence includes build SHA, OS/architecture, actual application/native deletion and per-artifact results. No credential, token, host address or filesystem path is printed/exported.

For each architecture, retain installation-specific commands/results/filesystem/kernel/service-manager facts only in ignored `.local` records. Check the actual archive against the manifest, verify no credential/profile/connection material appears, inspect current ledger continuity and confirm the service cannot start while a candidate is fenced. Run a separate owner-controlled stop/restart/reboot and filesystem durability exercise; ordinary process fault injection is not power-loss proof. Record any unsupported filesystem fsync, native conflict/partial, cleanup or architecture issue as blocked/partial rather than complete.

- [ ] Real Linux x64 application/artifact/native round trip and latest-ledger anti-resurrection
- [ ] Real Linux arm64 application/artifact/native round trip and latest-ledger anti-resurrection
- [ ] Real restart/reboot and filesystem/power-loss durability observations
- [ ] Opus-authored Thai/English preview/recovery UI
- [ ] Keyboard/no-script/accessibility/device UI acceptance

Only the orchestrator can attach the real-host evidence later for EVID14-01. This ticket does not flip the default, migrate legacy data, run live subscriptions or install on the owner's existing host.
