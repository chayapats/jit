# Project continuity query, v1

Owner: Jit #20 (TASK02). Contract: `app.project_continuity/v1`. Requires `app.task_read_model/v1`, `app.decision_read_model/v1`, and `app.source_records/v1`. Schema user_version 10.

Continuity answers what the owner still owes and what they already decided from committed application state. It does not call Schway, Telegram, or a live model.

## Exact public surface

```ts
export interface ProjectContinuity {
  projectId: string;
  obligations: TaskList;
  activeObligations: TaskRecord[];
  decisions: Array<{ topicId: string; model: DecisionReadModel }>;
  queriedAt: number;
}

export function readProjectContinuity(tx: AppTransaction, projectId: string, limit: number, now: number): ProjectContinuity;

Application.continuity(actor: OwnerActor, projectId: string): { project: Project } & ProjectContinuity;
```

`activeObligations` includes only `proposed`, `accepted`, and `ready_for_review` rows. Cancelled, dismissed, and superseded tasks stay in `obligations.inactive` and are excluded from active work.

## Behavior

The query reads current task lists and, for every topic in the project, including topics without tasks, the decision read model. Decisions retain proposal revision, owner conclusion, rationale, and source links. Unavailable sources stay unavailable; the query does not delete or infer replacements.

After process restart or while the execution host is unavailable, reopening the store and calling `continuity` returns the same committed obligations and decisions. Task history is not tied to native session or process lifetime.

GET `/api/projects/:id/continuity` requires the owner session and returns JSON only. It never mutates tasks, decisions, or receipts.

## Testing

Deterministic tests reopen SQLite after accept, complete, and cancel flows and assert active versus inactive obligation membership plus decision presence. See `tests/tasks.test.ts` and [ADR 0017](../adr/0017-task-completion-and-continuity.md).
