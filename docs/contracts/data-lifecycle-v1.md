# Owner data deletion lifecycle and deletion ledger, v1

Owner: Jit #30 (MEM05). Schema: 17 (`deletion_previews`, `deletion_ledger`, `deletion_operations`); later shape changes live in `record_json` and need no migration. Contracts delivered: `app.data_lifecycle/v1` (preview `app.data_deletion_preview/v1`, operation `app.data_deletion_operation/v1`) and `app.deletion_ledger/v1`. Consumed: `app.memory_lineage/v1`, `app.source_records/v1`, `app.run_port/v1`, `jobs.attempt_fence/v1`, `jobs.session_reconcile/v1`, `ops.backup_manifest/v1`, `app.command_receipts/v1`.

## Public application surface

- `Application.execute(actor, DeleteCommand)` accepts `memory.delete.preview`, `memory.delete.confirm` and `memory.delete.retry` from the authenticated Web owner only, through the shared receipt path (replayed request ID returns the original result; changed payload is `request_id_conflict`). Model output and retrieved content cannot issue or confirm these commands.
- `Application.deletionPreview / deletionOperation / deletionOperations / deletionLedger` read previews, per-scope operations and the identity-only ledger. Web: GET/POST `/[api/]projects/:id/memory/deletions[/:previewOrOperationId]`.
- `JobQueue.reconcile(port)` (startup, in `serve` and `startFullApp`) runs session reconciliation, then one budgeted managed-delete pass, and retains `port`. `JobQueue.reconcilePendingDeletions()` requests one further serialized pass through that port; the application calls it after a committed confirm/retry. Without a reconciled port nothing is dispatched and operations stay pending until the next startup.
- `startFullApp(input)` is async and awaits `queue.reconcile(teamPort)` before returning an active handle.

## Preview (`DeletionPreview`)

Scope is one exact committed lineage `{projectId, source:{sourceId, revision, generation}}` that is current and available. The preview is bound to the project revision, expires after 15 minutes and lists the complete affected inventory:

- `affected.sources`: the scope (`relation: "scope"`) and every descendant output (`"derived_output"`), resolved by lineage, not text: outputs recorded in `memory_derived_sources` for affected memory contexts, and outputs attributed (`attribution.runId`) to runs whose manifests cite an affected source/claim. Resolution is transitive and may cross projects.
- `affected.claims`: claims from any affected source plus dependency/conflict closure, any project.
- `affected.contexts`, `affected.pendingJobs`, `affected.nativeSessions` (`DeletionNativeSession`: `jobIds`, `dispatched`, `selectiveErase: false`, `collateral` = manifest sources/claims outside the scope).
- `affected.backups` / `affected.exports`: retained `ops_backups` / export artifacts covering an affected lineage; `affected.obligations`: tasks/decisions linked by source lineage or lexical overlap, each `effect: "retained_unchanged"`.
- `wholeSession {required, reason, reasons[], sessionScope[]}`: required for a shared topic identity (`topic_identity_shared`), an unresolvable orphan (`native_orphan_unresolvable`) or a dispatched native session holding collateral (`native_session_collateral`). The run port has no selective erase, so `sessionScope` enumerates each such `context:`, `source:` and `claim:` identity the whole-session delete removes.
- `blockers[]`: `unreadable_record:<table>`, `inventory_scan_ceiling:<table>` (200,000 rows per table), `inventory_truncated:<list>` (display bounds on sources/claims/contexts/pendingJobs/nativeSessions) and `inventory_closure_ceiling`. Any blocker disables confirmation. Backups/exports/obligations are disclosure lists; their truncation is flagged only.
- `inventoryDigest`: SHA-256 over canonical affected identities, revisions and lifecycle states (source availability, claim status, job state, native app state/dispatch/collateral, obligation revision, backup/export IDs, blockers, whole-session scope).

Inventory scans page through whole tables by rowid; relevance is decided before any bound applies.

## Confirm

`confirmDeletion` rejects an expired/unknown preview, a project revision change, a changed scope or a recomputed `inventoryDigest` that differs (`memory_delete_stale_preview`; re-preview). Blockers reject with `memory_delete_blocked`. `acknowledged` is required, and `acknowledgedWholeSession` whenever `wholeSession.required` (`memory_delete_ambiguous`). A duplicate confirm of the same preview returns the existing operation (`duplicate: true`) and deletes no new scope.

In one transaction it fences first (pending/in-flight citing jobs invalidated with `source_retired`; affected `team_contexts` moved from `active` to `retired`), then purges `content_text` and marks every affected source generation unavailable, marks claims deleted with the redaction marker, redacts cited text in `memory_extractions`, `team_runs`, `coordinator_syntheses` and `job_attempts` manifests and in command receipts, redacts producing-run outcomes and proposal artifacts of derived outputs, scrubs exact quoted copies (≥ 8 characters) in model outputs/job records/proposals, re-fences stale contexts/extractions, writes identity-only tombstones and opens the operation. Owner-authored tasks, decisions and deliveries are never rewritten, completed or cancelled. Identity rows (sources, messages, lineage) remain so references resolve as unavailable.

## Operation (`DeletionOperation`) and reconciliation

`contexts[]` holds one `DeletionContextScope` per native session: `state` (`pending | deleted | delete_failed | retire_failed | missing`), `attempts`, `reason`, `nextAction`, `updatedAt`; completed entries are kept. `scopes[]` separates `app_store` (`purged`), `retained_backups` / `retained_exports` (`retained` or `none`) and `external_copies` (`not_attempted`: Telegram/provider copies). `state` is `complete` only when every context is `deleted`; otherwise `pending`, `blocked` (some scope failed/missing) or `failed` (`retry_budget_exhausted`). Completion covers active-local serving and managed native sessions only; it is not forensic erasure.

`reconcileDeletions(store, port, now)` atomically reserves one pass per pending/blocked operation (operation and per-context `attempts` incremented before dispatch, never refunded), refuses at `maxAttempts = 5` and persists `retry_budget_exhausted`, then calls `port.delete(context)` per remaining context (the adapter's supported retire-then-delete lifecycle; Jit never edits native bytes) and settles each outcome. Startup passes and owner retries share the budget. `memory.delete.retry` only re-arms a pending/blocked operation; it never adds budget and leaves an exhausted operation failed.

## Ledger and lifecycle consumers (`app.deletion_ledger/v1`)

`readDeletionLedger(tx)` returns `{operationId, projectId, kind: "source"|"claim", sourceId, claimId, revision, generation, deletedAt}` ordered by deletion time, with no payload, actor secret or duplicated text. `deletedSource`/`deletedClaim` deny extraction, context assembly, notification and late writers; exporters apply tombstones; restore replays the ledger into the quarantine before workers are enabled. `lifecycleSafeManifests(tx, value)` projects persisted manifests for owner APIs (the job API uses it for attempts): unavailable source/claim text is replaced by the marker.

## Deterministic evidence

`tests/memory-delete.test.ts` covers cross-project collateral, stale/duplicate/forged commands, digest-bound confirmation, crash/reopen at preview and confirm, budget exhaustion across restarts, per-scope partial failure in API/UI, direct-source sessions, whole-store relevance and unreadable-record blockers, lineage purge of paraphrased derived outputs and job-attempt redaction, whole-session acknowledgement and an end-to-end Schway worker session deleted by `queue.reconcile` alone and still deleted after reopen. `tests/ops-service.test.ts` proves `startFullApp` completes a pending deletion before returning. Fixtures use scripted models and in-process Schway hosts; real native erasure on a host still needs JBR01 evidence.
