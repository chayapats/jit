# Project export, v1

Owner: Jit #31 (OPS03). Contract: `ops.project_export/v1`, artifact/manifest `formatVersion` 2. Implementation: `src/ops/export.ts`, `src/application.ts`, `src/memory/delete.ts` (retained-export tracking), `src/web.ts`, `src/web-layout.ts`, `src/ops/upgrade.ts` (recovery backup strip). Uses `app.project_commands/v1` (receipts, expected revision), `app.data_lifecycle/v1` (deletion ledger, operations, suppression), `ops.backup_manifest/v1` (residual backups) and `jobs.attempt_fence/v1` (job evidence references only). FR-04, FR-05, FR-16, FR-18, NFR-07, NFR-09, NFR-10, NFR-11, NFR-12.

An ordinary export is an inspectable, portable JSON copy of one project. It is **not** a restorable backup, it never deletes external copies (Telegram, provider sessions, older backups), and it never contains secrets or native session data. Import or synchronization across installations is out of scope.

## Exact public surface

```ts
exportIdentity(command: CreateExportCommand): string
exportPreview(tx, projectId, scope: ExportScope, projectRevision): ExportPreview
assembleExport(tx, projectId, scope): Assembled
buildExport(tx, input): BuiltExport                      // assemble + size ceiling; writes nothing
registerExport(tx, built): ValidExportManifest           // lifecycle fence, valid row + bytes, retention
recordFailedExport(tx, input): FailedExportManifest
readExportManifest(tx, projectId, id): ExportManifest
listExportArtifacts(tx, projectId, limit?): ExportManifest[]
readExportArtifact(tx, projectId, id): { manifest: ValidExportManifest; body: Uint8Array }  // sha256-verified
exportRegistration(tx, id): ExportManifest | null
exportLifecycleMark(tx, projectId): string
exportFailureReason(error): ExportFailureReason
ensureExportBodies(tx): void
stripExportsFromSnapshot(bytes): Uint8Array               // used by backup.create and the upgrade recovery backup
sanitizeExportStrings<T>(value: T): T
downloadPath(projectId, id): string

Application.execute(actor, CreateExportCommand): ExportReceipt      // { manifest: ValidExportManifest; duplicate }
Application.exportPreview(actor, projectId, includeHistory): { project; preview }
Application.exports(actor, projectId): { project; manifests: ExportManifest[] }
Application.export(actor, projectId, id): { project; manifest: ExportManifest }
Application.exportArtifact(actor, projectId, id): { manifest; body }
GET /projects/:projectId/exports/:id/artifact  (and /api/...)       // owner session only; attachment, no-store, nosniff
ApplicationOptions.exportLimits?: Partial<{ maxExports; maxBytes }> // may only tighten the defaults
ApplicationOptions.exportDir?: string                               // deprecated, ignored
```

`CreateExportCommand` is `{ kind: "export.create", requestId, projectId, expectedRevision, payload: { includeHistory: boolean, note: string ≤ 500 bytes } }`; extra keys are rejected.

## Storage and request lifecycle

Format-2 artifact bytes are stored in SQLite (`export_artifact_bodies`, keyed by the registration id with `ON DELETE CASCADE`). They are registered beside their manifest in `export_artifacts`. **An artifact exists iff its committed registration row is `valid`.** There are no temp files, renames, directory fsyncs, orphan sweeps or caller-chosen destinations. Bytes are served only to the authenticated owner. On read they are hash-verified, and a mismatch is `export_corrupt`.

1. Owner-only. The preview (`exportPreview`) reports the selected scope, the current project revision, counts, completeness, exclusions and missing references without writing anything.
2. Rejections before building (`authentication_required`, `invalid_export_command`, `request_id_conflict`, `stale_revision`, `project_not_found`) are plain rejections and record nothing.
3. **One immediate transaction** does all of the following in order:
   1. Takes the project lifecycle mark.
   2. Assembles the artifact. An artifact above `maxBytes` is rejected as `export_too_large` before anything is written.
   3. Re-checks the mark immediately before publication: project revision, deletion ledger and operations, suppressed sources, source availability and generations, claim revisions and statuses. Any change throws `export_fenced_by_lifecycle`.
   4. Inserts the `valid` registration and its bytes.
   5. Applies retention computed from that final outcome: the oldest valid exports beyond `maxExports` or `maxBytes`, never the new one. Their bytes are removed in the same transaction.
   6. Binds the receipt and audit row.
4. Any failure rolls back everything, including retention, so a failed or fenced export never retires an older valid export. A separate transaction then records a **failed export** (`state: "failed"`, `artifact: null`, empty coverage, `failure: { reason, stage }`) and binds the request ID to it. Failed records are bounded among themselves (`maxExports`) and never retire valid ones. The command throws `AppError(reason)` with `detail: { projectId, exportId, path }`.
5. **Replays** follow the registration's current state:
   - valid returns the current manifest;
   - failed re-throws the recorded failure;
   - a registration pruned by retention or removed by deletion throws `export_expired` (410, `detail.exportId`). A replay never returns a cached valid result for an artifact that no longer exists.

Failure reasons are a closed set:
- `export_too_large` (413)
- `export_fenced_by_lifecycle` (409)
- `export_storage_unavailable` (503; `SQLITE_FULL`/`SQLITE_IOERR`)
- `export_failed` (500; any other error, whose text is never stored)

Stages are `stage` (build), `publish` (fence, registration and bytes) and `commit` (receipt and commit).

Assembly, the fence and publication share one SQLite write transaction, so a deletion cannot interleave. A deletion committed afterwards sees a normal retained export in its delete preview. Confirmed-but-unreconciled deletions are already excluded and listed in `pendingDeletions`. Exports are not jobs and have no cancel generation.

**Backups.** `backup.create` and the upgrade recovery backup strip `export_artifacts` and `export_artifact_bodies` from the database image and `VACUUM` it, so freed pages carry no artifact text. A restore therefore cannot resurrect exported content, and replays of restored receipts answer `export_expired`. In the live database, freed pages after retention or deletion follow the application-wide SQLite setting; `secure_delete` is not enabled for any table.

**Legacy format-1 records.** These were written to `<db>.exports/<id>.json` by the pre-format-2 writer, without fsync. They read back with `artifact: { storage: "legacy_file", path, bytes, hash, directorySync: "legacy_unverified" }` and `completeness.complete: false`. Their file is served hash-verified with `O_NOFOLLOW`. Retention unlinks the file before deleting its row in the same transaction, so a data file never outlives its registration.

## Manifest (`ExportManifest`)

Fields:
- `contract`; `formatVersion` (2; records written before format 2 read back as 1); `id`; `projectId`; `createdAt`; `appSchema` (SQLite `user_version`); `scope: { includeHistory }`; `projectRevision`.
- `coverage: { sources, claims, truncated }`: exact source/claim generations whose payload text is in the artifact. That includes topic titles, messages, sources, and delivery outbox/report text. Each list is bounded to 500 and `truncated` is set only when that bound cut it, in which case delete previews list the export conservatively.
- `counts`: rows **included** per kind (`topics`, `messages`, `tasks`, `decisions`, `claims`, `jobs`, `deliveries`, `prReports`).
- `completeness: { complete, collections: { <name>: { included, total, truncated } } }` for every bounded collection. Bounds are in `exportCollectionBounds`: jobs, deliveries and reports at 1000; sources and claims at 2000; messages at 5000; and so on. Without history scope, `messages` reports `included: 0`, the real `total` and `truncated: false`. The rows are excluded by scope, not by a bound. `data.messageCount` is that total.
- `exclusions[] { kind, id, reason }`, `missingRefs[]`, `pendingDeletions[]`, `residuals: { backups[], external[] }`, `lifecycle: { tombstonesApplied, note }`, `disclosure`.
- `retention: { maxExports: 20, maxBytes: 32 MiB, pruned[] }`. `maxBytes` caps the bytes of a project's valid exports and is also the ceiling for any single artifact. `pruned` lists the registrations this outcome retired.
- `state` (`valid` | `failed`), `failure`, `artifact: { storage: "sqlite", bytes, hash (sha256), downloadPath } | { storage: "legacy_file", path, bytes, hash, directorySync: "legacy_unverified" } | null`.

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
- Every valid export stays registered in `export_artifacts` with its bytes. A later delete preview (`affected.exports`) lists every non-failed export of a project the deletion affects, because coverage does not describe raw task/proposal/decision text, plus any other export whose coverage contains the doomed source generation or a derived claim. Deletion never edits a stored export. Purging one is row deletion: `DELETE FROM export_artifacts WHERE id = ?` cascades to `export_artifact_bodies`. Only legacy format-1 rows also have a file to unlink. Failed exports hold no artifact and are never listed.

## Never exported

Owner password hash, session tokens, CSRF secrets, model/provider credentials (route labels such as `authRoute` names are not credentials), auth headers, Telegram bot tokens and chat bindings, PR `apiBase` and private service addresses, raw process environments, native session data, snapshot file patches.

## Declared residuals

- **Legacy format-1 retention.** Format-1 artifacts (`legacy_file`) are still files on disk. Their retention unlinks the file inside the SQLite transaction, so a rollback after the unlink cannot restore it, and a failed unlink still lets the row deletion commit. No installation holds format-1 exports: the pilot has not started, and every export created from this change on is format 2 in SQLite. If one appears, migrate it into SQLite (hash-verified) before retention runs.
- **Freed pages.** The live database does not enable `secure_delete`, so freed SQLite pages can hold pruned or deleted export bytes until SQLite reuses them. This applies to all application data, not only exports.
