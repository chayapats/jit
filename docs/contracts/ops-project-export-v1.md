# Project export, v1

Owner: Jit #31 (OPS03). Contract: `ops.project_export/v1`, artifact/manifest `formatVersion` 2. Implementation: `src/ops/export.ts`, `src/application.ts`, `src/memory/delete.ts` (retained-export tracking), `src/web.ts`, `src/web-layout.ts`. Uses `app.project_commands/v1` (receipts, expected revision), `app.data_lifecycle/v1` (deletion ledger, operations, suppression), `ops.backup_manifest/v1` (residual backups) and `jobs.attempt_fence/v1` (job evidence references only). FR-04, FR-05, FR-16, FR-18, NFR-07, NFR-09, NFR-10, NFR-11, NFR-12.

An ordinary export is an inspectable, portable JSON copy of one project. It is **not** a restorable backup, it never deletes external copies (Telegram, provider sessions, older backups), and it never contains secrets or native session data. Import or synchronization across installations is out of scope.

## Exact public surface

```ts
exportIdentity(command: CreateExportCommand): string
exportPreview(tx, projectId, scope: ExportScope, projectRevision): ExportPreview
assembleExport(tx, projectId, scope): Assembled
stageExport(tx, input): StagedExport          // temp file + registration, same transaction
publishExport(tx, staged): void               // lifecycle fence, then atomic rename
discardExport(staged): void                   // rollback path
finalizeExport(staged): void                  // after commit: remove retention-retired files
recordFailedExport(tx, input): { manifest: FailedExportManifest; prunedFiles: string[] }
exportFailureReason(error): ExportFailureReason
exportLifecycleMark(tx, projectId): string
ensureExportDir(dir): void
readExportManifest(tx, projectId, id): ExportManifest
listExportArtifacts(tx, projectId, limit?): ExportManifest[]

Application.execute(actor, CreateExportCommand): ExportReceipt      // { manifest: ValidExportManifest; duplicate }
Application.exportPreview(actor, projectId, includeHistory): { project; preview }
Application.exports(actor, projectId): { project; manifests: ExportManifest[] }
Application.export(actor, projectId, id): { project; manifest: ExportManifest }
```

`CreateExportCommand` is `{ kind: "export.create", requestId, projectId, expectedRevision, payload: { includeHistory: boolean, note: string ≤ 500 bytes } }`; extra keys are rejected.

## Request lifecycle

1. Owner-only. The preview (`exportPreview`) reports the selected scope, the current project revision, counts, exclusions and missing references without writing anything.
2. Rejections before staging (`authentication_required`, `invalid_export_command`, `request_id_conflict`, `stale_revision`, `project_not_found`) are plain rejections and record nothing.
3. One immediate SQLite transaction then: verifies the export directory (`ensureExportDir`), sweeps unregistered `<uuid>.json` artifacts and `.<uuid>.json.tmp-<pid>` temp files left by a crash, takes the project lifecycle mark, assembles the data, writes it to an exclusive (`O_CREAT|O_EXCL`, 0600, fsynced) temp file, applies retention and registers the manifest.
4. `publishExport` re-takes the lifecycle mark (project revision, deletion ledger, deletion operations, suppressed sources, source availability/generations, claim revisions/statuses). Any change throws `export_fenced_by_lifecycle`. Otherwise the temp file is renamed into place (`rename(2)` replaces, never follows, a planted final-path entry) and the directory is fsynced.
5. The receipt and audit row commit with the registration. Retention-retired files are removed only after commit.
6. If anything from step 3 on fails, the temp/published file is removed and a separate transaction records a **failed export** (`state: "failed"`, `artifact: null`, empty coverage, `failure: { reason, stage }`) and binds the request ID to it. The command throws `AppError(reason)` with `detail: { projectId, exportId, path }`. Replaying the same request ID re-throws the same failure. A new request ID is a new logical export.

Failure reasons are a closed set: `export_storage_unavailable` (503), `unsafe_export_destination` (409: symlink, non-directory, group/world-accessible or foreign-owned directory), `export_fenced_by_lifecycle` (409), `export_failed` (500, any other error; its text is never stored). Stages: `stage`, `publish`, `commit`.

Exports are synchronous inside one transaction, so a deletion cannot interleave; the lifecycle fence still guards the publish step, and confirmed-but-unreconciled deletions are already excluded and listed in `pendingDeletions`. Exports are not jobs and have no cancel generation.

## Manifest (`ExportManifest`)

`contract`, `formatVersion` (2; records written before format 2 read back as 1), `id`, `projectId`, `createdAt`, `appSchema` (SQLite `user_version`), `scope: { includeHistory }`, `projectRevision`, `coverage: { sources, claims, truncated }` (exact source/claim generations whose payload is in the artifact, bounded to 500 each; `truncated` only when that bound cut the list), `counts` (`topics`, `messages`, `tasks`, `decisions`, `claims`, `jobs`, `deliveries`, `prReports`), `exclusions[] { kind, id, reason }`, `missingRefs[]`, `pendingDeletions[]`, `residuals: { backups[], external[] }`, `lifecycle: { tombstonesApplied, note }`, `disclosure`, `retention: { maxExports: 20, maxBytes: 32 MiB, pruned[] }`, `state`, `failure`, `artifact: { path, bytes, sha256 hash } | null`.

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
- `deliveries` and `reports` (delivery outbox): text only while the delivery's own committed source is still available. Otherwise `text: null` and an exclusion.
- `pr`: monitors (`id`, `repository`, `state`, `revision`) and candidates (`id`, `monitorId`, `pullNumber`, base/head SHA, `status`, `generation`).
- `prReports` (`pr.private_report/v1`): `id`, `monitorId`, `candidateId`, `repository`, `pullNumber`, base/head SHA, policy and review-policy versions, `revision`, `status`, computed `stale`/`staleReason`, `scope` (`requiredRoles`, `analyzedRoles`, `skippedScope`, `coverageOverall`, `enumerationComplete`), validated `findings`, `specialistRuns`, `synthesis`, `disagreements`, `evidence` (`snapshotId`, `jobId`, `attemptId`), owner `annotations`, timestamps. Finding text flagged `payload_hygiene_secret` or matching auth-header/bot-token shapes is replaced with `(redacted: payload_hygiene_secret)`. Snapshot blobs, `apiBase` and authority generations are never exported.

## Lifecycle policy

- Deleted sources and claims (deletion ledger) are absent and listed in `exclusions` with reason `deleted`.
- Forgotten and corrected claims are never active memory: `claim_forgotten`/`forgotten_inactive` and `claim_corrected`/`corrected_superseded`.
- Raw history kept by forget (suppressed sources) is included only when `includeHistory` is true. Otherwise it is excluded as `forgotten_raw_history_excluded`. Message sources without history scope export identity only (`raw_history_not_selected`).
- Every valid export stays registered in `export_artifacts`. A later delete preview (`affected.exports`) lists this project's exports whose coverage contains the doomed source generation or a derived claim, and also any export with truncated coverage. Deletion never edits a stored export. Failed exports published nothing and are never listed.

## Never exported

Owner password hash, session tokens, CSRF secrets, model/provider credentials (route labels such as `authRoute` names are not credentials), auth headers, Telegram bot tokens and chat bindings, PR `apiBase` and private service addresses, raw process environments, native session data, snapshot file patches.
