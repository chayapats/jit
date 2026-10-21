# ADR 0017: Task completion and project continuity

Status: accepted for TASK02 engineering choices (Jit #20). Requirements: FR-04, FR-07, FR-10, FR-18, NFR-05, NFR-10, NFR-11.

## Confirmed decisions and required behavior

Accepted user tasks remain obligations until the owner completes them under a registered completion policy. Default MVP user tasks use owner-confirmed completion. Analysis, review, and reminder outputs are evidence artifacts with immutable revisions; job success alone does not close a user task. Model finished text, chat “done”, and unsupported auto-completion rules cannot grant completion authority.

Cancelled, dismissed, and superseded tasks are inactive and must not appear as current work in continuity answers. Owner reopen, edit, cancel, and supersede transitions stay finite, audited, and revision-checked.

## Selected implementation

Schema v10 extends task rows with completion policy, owner completion, pending reason, and superseded-by metadata. `task_evidence_artifacts` stores deterministic fixture artifacts keyed by task and revision. `readTaskList` groups obligations for Web and JSON consumers. `readProjectContinuity` composes obligation lists with per-topic decision read models without provider inference.

Owner commands `task.set_policy`, `task.complete`, `task.reopen`, and `task.supersede` share the existing receipt and stale-revision gates from TASK01. `task.complete` validates cited evidence against stored artifacts and availability before recording completion. `Application.continuity` exposes the query on the authenticated application boundary; GET never mutates state.

Web task pages render status, policy, and pending action text in Thai and English-safe escaped form alongside state labels, not color alone.

## Alternatives and consequences

Auto-closing accepted tasks when a background job succeeds would treat PR monitors and reminders as owner obligations. Letting models set completion policy from transcript text would move authority off the owner. Omitting a dedicated continuity query would push Telegram and memory adapters toward inference over committed state.

The exact surfaces are recorded in [task-completion-v1](../contracts/task-completion-v1.md) and [project-continuity-v1](../contracts/project-continuity-v1.md).
