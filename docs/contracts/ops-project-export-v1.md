# Project export, v1

Owner: Jit #31 (OPS03). Contract: `ops.project_export/v1`, artifact/manifest `formatVersion` 2. Implementation: `src/ops/export.ts`, `src/application.ts`, `src/memory/delete.ts` (retained-export tracking), `src/web.ts`, `src/web-layout.ts`. Uses `app.project_commands/v1` (receipts, expected revision), `app.data_lifecycle/v1` (deletion ledger, operations, suppression), `ops.backup_manifest/v1` (residual backups) and `jobs.attempt_fence/v1` (job evidence references only). FR-04, FR-05, FR-16, FR-18, NFR-07, NFR-09, NFR-10, NFR-11, NFR-12.

An ordinary export is an inspectable, portable JSON copy of one project. It is **not** a restorable backup, it never deletes external copies (Telegram, provider sessions, older backups), and it never contains secrets or native session data. Import or synchronization across installations is out of scope.

## Exact public surface

```ts
exportIdentity(command: CreateExportCommand): string
exportPreview(tx, projectId, scope: ExportScope, projectRevision): ExportPreview
assembleExport(tx, projectId, scope): Assembled
stageExport(tx, input): StagedExport                 // txn 1: full temp write + `staged` registration
commitExport(tx, staged): ValidExportManifest        // txn 2: lifecycle fence, registration becomes `valid`
publishExport(staged, ops?): void                    // after txn 2 commits: size check, rename, directory fsync
discardExport({ tempPath, finalPath }): void
reconcileExports(tx, dir, ops?): void                // crash recovery for staged/unpublished registrations
recordFailedExport(tx, input): { manifest: FailedExportManifest; prunedFiles: string[] }
removeRetiredExportFiles(paths): void
exportRegistration(tx, id): "staged" | "valid" | "failed" | null
exportFailureReason(error): ExportFailureReason
exportLifecycleMark(tx, projectId): string
exportPaths(dir, id): { finalPath; tempPath }
ensureExportDir(dir): void
sanitizeExportStrings<T>(value: T): T
readExportManifest(tx, projectId, id): ExportManifest        // valid or failed only
listExportArtifacts(tx, projectId, limit?): ExportManifest[] // valid or failed only
nodeExportFileOps: ExportFileOps                              // write / fsync / rename / fsyncDir seam

Application.execute(actor, CreateExportCommand): ExportReceipt      // { manifest: ValidExportManifest; duplicate }
Application.exportPreview(actor, projectId, includeHistory): { project; preview }
Application.exports(actor, projectId): { project; manifests: ExportManifest[] }
Application.export(actor, projectId, id): { project; manifest: ExportManifest }
ApplicationOptions.exportFileOps?: Partial<ExportFileOps>          // fault injection
ApplicationOptions.exportLimits?: Partial<{ maxExports; maxBytes }> // may only tighten the defaults
```

`CreateExportCommand` is `{ kind: "export.create", requestId, projectId, expectedRevision, payload: { includeHistory: boolean, note: string ≤ 500 bytes } }`; extra keys are rejected.

## Request lifecycle (commit-gated publication)

1. Owner-only. The preview (`exportPreview`) reports the selected scope, the current project revision, counts, completeness, exclusions and missing references without writing anything.
2. Rejections before staging (`authentication_required`, `invalid_export_command`, `request_id_conflict`, `stale_revision`, `project_not_found`) are plain rejections and record nothing.
3. **Transaction 1 (stage).** Verifies the export directory (`ensureExportDir`) and reconciles crash leftovers (`reconcileExports`). It sweeps `<uuid>.json` and `.<uuid>.json.tmp` files that have no live registration. It then takes the project lifecycle mark and assembles the data. An artifact above `maxBytes` is rejected (`export_too_large`) before anything is written. Otherwise the whole body goes to an exclusive temp file (`O_CREAT|O_EXCL`, 0600): short writes loop, a write making no progress fails, and the file is fsynced and size-verified before the directory is fsynced. Retention runs next, then the manifest is registered as `staged` and the receipt and audit row are bound to the request ID. If anything fails after the temp file exists, it is removed before the error propagates.
4. Retention-retired files are removed after transaction 1 commits.
5. **Transaction 2 (commit).** `commitExport` re-takes the lifecycle mark: project revision, deletion ledger and operations, suppressed sources, source availability and generations, claim revisions and statuses. It also checks that the registration is still `staged`. Any change throws `export_fenced_by_lifecycle`. Otherwise the registration becomes `valid` and the receipt is updated.
6. **Publish, after transaction 2 commits.** The temp file's size is re-checked, then it is renamed into place. `rename(2)` replaces a planted final-path entry rather than following it. The directory is then fsynced. `fsyncDir` tolerates only `EINVAL`, `ENOTSUP` or `EOPNOTSUPP`, in which case `artifact.directorySync` is `"unsupported"`; any other error fails the export.
7. Any failure from step 3 on removes both files. A separate transaction then records a **failed export** (`state: "failed"`, `artifact: null`, empty coverage, `failure: { reason, stage }`), replacing any staged or valid row with the same id and updating the receipt. The command throws `AppError(reason)` with `detail: { projectId, exportId, path }`. A replay of the same request ID follows the registration's current state: valid returns the receipt, failed re-throws, staged is reconciled first. A new request ID is a new logical export.

Visibility: the final path only ever holds an artifact whose `valid` registration committed. Readers never return `staged` rows, while delete previews still list them. Crash recovery runs on the next export or replay. A `staged` row becomes `export_interrupted` and both of its files are removed. A `valid` row whose file is still at the temp path has its rename completed. If publication fails after the valid commit, the record ends `failed`. That is the same logical export, not a second one. The protocol assumes a single writer process per database, as the job scheduler already does.

Failure reasons are a closed set:
- `export_storage_unavailable` (503)
- `unsafe_export_destination` (409): symlink, non-directory, group/world-accessible or foreign-owned directory
- `export_fenced_by_lifecycle` (409)
- `export_too_large` (413)
- `export_interrupted` (409, crash recovery)
- `export_failed` (500): any other error; its text is never stored

Stages are `stage`, `publish` and `commit`.

Assembly happens synchronously inside transaction 1, so a deletion cannot interleave with it. A deletion landing between the two transactions is fenced in transaction 2. A deletion landing after publication sees a normal retained export in its delete preview. Confirmed-but-unreconciled deletions are already excluded and listed in `pendingDeletions`. Exports are not jobs and have no cancel generation.

## Manifest (`ExportManifest`)

Fields:
- `contract`; `formatVersion` (2; records written before format 2 read back as 1); `id`; `projectId`; `createdAt`; `appSchema` (SQLite `user_version`); `scope: { includeHistory }`; `projectRevision`.
- `coverage: { sources, claims, truncated }`: exact source/claim generations whose payload text is in the artifact. That includes topic titles, messages, sources, and delivery outbox/report text. Each list is bounded to 500 and `truncated` is set only when that bound cut it, in which case delete previews list the export conservatively.
- `counts`: rows **included** per kind (`topics`, `messages`, `tasks`, `decisions`, `claims`, `jobs`, `deliveries`, `prReports`).
- `completeness: { complete, collections: { <name>: { included, total, truncated } } }` for every bounded collection. Bounds are in `exportCollectionBounds`: jobs, deliveries and reports at 1000; sources and claims at 2000; messages at 5000; and so on. Without history scope, `messages` reports `included: 0`, the real `total` and `truncated: false`. The rows are excluded by scope, not by a bound. `data.messageCount` is that total.
- `exclusions[] { kind, id, reason }`, `missingRefs[]`, `pendingDeletions[]`, `residuals: { backups[], external[] }`, `lifecycle: { tombstonesApplied, note }`, `disclosure`.
- `retention: { maxExports: 20, maxBytes: 32 MiB, pruned[] }`. `maxBytes` caps the per-project registry and is also the ceiling for any single artifact.
- `state` (`valid` | `failed`), `failure`, `artifact: { path, bytes, hash (sha256), directorySync } | null`.

`disclosure` is `{ restorableBackup: false, externalCopiesDeleted: false, secrets: "excluded", nativeSessions: "excluded", rawHistory: "included" | "metadata_only" }`. `residuals.external` always names `telegram_delivery_copies_not_exported_or_deleted` and `provider_session_copies_not_exported`. `residuals.backups` lists backup manifests that may still hold this project's data.

## Artifact

`{ contract, formatVersion, exportId, projectId, exportedAt, scope, disclosure, note, data }`. JSON stays UTF-8, so Thai, English and other Unicode text round-trips verbatim. `data` holds:

- `project` (`id`, `name`, `revision`, `createdAt`); `topics` (id, revision, sequence, title or `null` with `availability`, source ref).
- `messages` (only with `includeHistory`), `messageCount`.
- `tasks` (committed task row with state, proposal revision, origin, acceptance, completion and source availability), `proposals`, `events`.
- `decisions`: proposal `id`, `topicId`, `discussionId`, `revision`, `synthesisId`, `status` (`open`, `decided`, `decided_superseded`), `ownerDecisionId`, source ref plus `sourceAvailability`, `createdAt`, committed `artifact`. `ownerDecisions`: owner conclusions with revision and `superseded_by`.
- `claims`: active generations as `{ state: "available", claim }` (fact/inference/status/source provenance from `memory.claims/v1`); anything else is `{ state: "unavailable", reference, reason }` with no payload.
- `sources`: `available` with text, `metadata_only` (message sources without history scope, `text: null`) or `unavailable` (no text).
- `jobs`: `id`, `type`, `state`, `reason`, `evidence` reference.
- `deliveries` and `reports` (delivery outbox): text only when the shared resolver releases the delivery's own committed source. The resolver applies deletion, forget suppression and history scope. Otherwise `text: null` and an exclusion.
- `pr`: monitors (`id`, `repository`, `state`, `revision`) and candidates (`id`, `monitorId`, `pullNumber`, base/head SHA, `status`, `generation`).
- `prReports` (`pr.private_report/v1`): `id`, `monitorId`, `candidateId`, `repository`, `pullNumber`, base/head SHA, policy and review-policy versions, `revision`, `status`, computed `stale`/`staleReason`, `scope` (`requiredRoles`, `analyzedRoles`, `skippedScope`, `coverageOverall`, `enumerationComplete`), validated `findings`, `specialistRuns`, `synthesis`, `disagreements`, `evidence` (`snapshotId`, `jobId`, `attemptId`), owner `annotations`, timestamps. Every field is an explicit allowlist projection. A finding flagged `payload_hygiene_secret` loses all of its free text: title, condition, impact, reasoning, location path and evidenceRef. Every string of the PR projection (monitors, candidates, reports, findings, scope lists, disagreements, annotations) then passes `sanitizeExportStrings`. Any credential shape (`exportSecretLike`: auth headers, `x-api-key`, Telegram, GitHub and `sk-` tokens, private keys) becomes `(redacted: payload_hygiene_secret)`. The serialized projection is re-scanned, and a hit fails the export. Snapshot blobs, `apiBase` and authority generations are never exported.

## Lifecycle policy

- Deleted sources and claims (deletion ledger) are absent and listed in `exclusions` with reason `deleted`.
- Forgotten and corrected claims are never active memory: `claim_forgotten`/`forgotten_inactive` and `claim_corrected`/`corrected_superseded`.
- One scope-aware resolver handles every payload-bearing key: topic titles, messages, sources, and delivery outbox/report text. Raw history kept by forget (suppressed sources) is included only when `includeHistory` is true. Otherwise it is excluded as `forgotten_raw_history_excluded`. Message sources without history scope export identity only (`raw_history_not_selected`).
- Every valid or staged export stays registered in `export_artifacts`. A later delete preview (`affected.exports`) lists this project's exports whose coverage contains the doomed source generation or a derived claim. It also lists any export with truncated coverage. Deletion never edits a stored export. Failed exports published nothing and are never listed.

## Never exported

Owner password hash, session tokens, CSRF secrets, model/provider credentials (route labels such as `authRoute` names are not credentials), auth headers, Telegram bot tokens and chat bindings, PR `apiBase` and private service addresses, raw process environments, native session data, snapshot file patches.
