# Task completion and obligations, v1

Owner: Jit #20 (TASK02). Contract: `app.task_completion/v1`. Requires `app.task_commands/v1`, `app.task_read_model/v1`, `app.source_records/v1`, and `app.command_receipts/v1`. Schema user_version 10.

User tasks default to owner-confirmed completion. Job success, model finished text, and partial or unknown evidence artifacts do not close an accepted obligation.

## Exact public surface

```ts
export type CompletionPolicyKind = "owner_confirmed" | "evidence_satisfied";
export const REGISTERED_COMPLETION_POLICIES: readonly CompletionPolicyKind[];
export const DEFAULT_USER_TASK_POLICY: CompletionPolicy;

export type TaskCommand =
  | /* task.propose … task.start from app.task_commands/v1 */
  | { kind: "task.set_policy"; requestId: string; projectId: string; expectedRevision: number;
      payload: { taskId: string; policyKind: CompletionPolicyKind } }
  | { kind: "task.complete"; requestId: string; projectId: string; expectedRevision: number;
      payload: { taskId: string; note?: string; evidence?: SourceReference[] } }
  | { kind: "task.reopen"; requestId: string; projectId: string; expectedRevision: number;
      payload: { taskId: string; reason: string } }
  | { kind: "task.supersede"; requestId: string; projectId: string; expectedRevision: number;
      payload: { taskId: string; reason: string; successorTaskId?: string } };

export function readTaskList(tx: AppTransaction, projectId: string, limit: number): TaskList;
export function readTaskModel(tx: AppTransaction, projectId: string, taskId: string): TaskReadModel;
export function readTaskCompletionPolicy(tx: AppTransaction, projectId: string, taskId: string): CompletionPolicy;
export function registerTaskEvidenceArtifact(tx: AppTransaction, input: RegisterEvidenceInput): TaskEvidenceArtifact;
export function applyTask(tx: AppTransaction, command: TaskCommand, channel: TaskChannel, now: number, maximumBytes: number): TaskReceipt;

Application.continuity(actor: OwnerActor, projectId: string): { project: Project } & ProjectContinuity;
Application.taskCompletionPolicy(actor: OwnerActor, projectId: string, taskId: string): { project: Project; policy: CompletionPolicy };
Application.execute(actor: OwnerActor, command: TaskCommand): TaskReceipt;
```

`TaskList` lists `proposed`, `accepted`, `readyForReview`, `completed`, and `inactive` (dismissed, cancelled, superseded). `TaskRecord.revision` advances for every task mutation, including evidence arrival, policy, complete, and reopen. `proposalRevision` identifies the independent wording revision; existing proposal IDs do not change on status updates. `TaskList.closed` retains the prior closed projection and `hasMore` reports truncated groups. `TaskRecord` carries `completionPolicy`, `completion`, `pendingReason`, and `supersededBy`. `TaskReadModel` includes immutable `evidenceArtifacts` with revision, work type, outcome, and optional delivery state.

## Behavior

`task.accept` stores `owner_confirmed` as the default policy and a pending reason until the owner completes or cancels. The owner may switch to `evidence_satisfied` only when the latest artifact is complete, current, available, and satisfies delivery requirements; unsupported policy kinds are rejected.

`registerTaskEvidenceArtifact` appends one immutable analysis, review, or reminder artifact. Partial, failed, or unknown outcomes update `pendingReason` but never complete the task. Artifacts bind the exact task proposal ID. Failed/unknown deliveries and reminders without confirmed delivery cannot serve as complete evidence. When the effective policy is `evidence_satisfied` and the latest artifact is valid, the task moves to `ready_for_review` and waits for owner confirmation.

`task.complete` records owner actor, channel, time, optional note, and cited evidence. Evidence-required completion records the current artifact automatically when no explicit citation is supplied. Cited evidence must match a stored artifact and the current proposal/source revision and be available; partial, failed, unknown, or stale references reject with explicit codes. Duplicate completion or a stale task revision does not overwrite the latest row.

`task.reopen` moves a completed task back to `accepted`, clears completion, and preserves history. `task.edit` remains allowed on accepted and ready-for-review obligations and appends a proposal revision. `task.cancel` closes accepted or ready-for-review obligations. `task.supersede` marks an obligation superseded without treating it as active work.

`task.start` still refuses and commits nothing. Model text is not a task command and cannot change completion policy or authority.

## HTTP

| Route | Behavior |
| --- | --- |
| `GET /api/projects/PROJECT/continuity` | `ProjectContinuity` JSON: active obligations, grouped lists, and topic decision read models |
| `GET /projects/PROJECT/tasks` | Obligation groups include policy and pending text, not color alone |
| `POST /[api/]projects/PROJECT/tasks/TASK` | `mode` adds `complete`, `reopen`, `set_policy`, and `supersede` |

## Schema

user_version 10 extends `tasks` with completion policy, completion, pending reason, and superseded-by columns; expands task states and event kinds; adds `task_evidence_artifacts`. Migration snapshots the previous file before DDL, rebuilds referenced tables with foreign key enforcement temporarily disabled outside the transaction, verifies all foreign keys before commit, restores enforcement, and rejects a newer schema. Populated v9 fixtures preserve proposals, events and owner receipts.

Deterministic evidence: `tests/tasks.test.ts` with fake clock, local SQLite, fixture evidence artifacts, and race workers. See [ADR 0017](../adr/0017-task-completion-and-continuity.md).
