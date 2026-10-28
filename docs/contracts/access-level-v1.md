# EXE01 access levels, restrict-only overrides and the kill switch, v1

Owner: Jit #125 (S11 EXE01). Status: implemented on the issue branch. Spec: [S11](../specs/S11-execution-access-and-tools.md) (S11-D02, D08, D09, S11-AC03, S11-AC04, S11-AC10). Decision: [ADR 0037](../adr/0037-access-levels-approvals-and-connections.md) § Access levels and the kill switch. Requirements: FR-35, FR-17, FR-15, NFR-05, NFR-07, NFR-10.

Uses `app.command_receipts/v1`, `jobs.attempt_fence/v1`, `app.jit_reply/v1` and `app.team_dispatch/v1`. This slice is the authority model only: no box, no execution and no tool is added to any run.

## `app.access_level/v1`

`src/exec/access.ts`, schema 31 `project_access_revisions`, `role_access_overrides`, `execution_halts` (all append-only).

```ts
type AccessLevel = "read" | "workspace" | "full";          // levelRank: 0, 1, 2
interface ProjectAccess { projectId; level; revision; halted; haltRevision; fullAllowed; updatedAt: number | null }
interface RoleAccess { projectId; roleId; level: AccessLevel | null; revision; updatedAt; effective: EffectiveAccess }
interface EffectiveAccess { level; halted; projectLevel; roleLevel: AccessLevel | null }
Application.projectAccess(actor, projectId): ProjectAccess;  // web or telegram actor
Application.roleAccess(actor, projectId): RoleAccess[];
assertExecutionAllowed(tx, projectId, roleId | null, needed: AccessLevel): AccessLevel;
accessConfirmToken(projectId, from, to, expectedRevision): string; // sha256 hex of JSON.stringify([projectId, from, to, expectedRevision])
```

- A project with no row reads `read`, revision 0, halt revision 0, not halted.
- The effective level is the minimum of the project level and the role override. While halted it is `read` with `halted: true`.
- `assertExecutionAllowed` is the guard every execution path calls in its own transaction. It throws `execution_halted` (409) or `access_level_insufficient` (409, detail `{ effective, needed }`).
- `config.execution.fullAllowed` comes from `JIT_EXECUTION_FULL_ALLOWED` (`1` or `0`, default `0`; anything else fails config load).

## Commands

Every command is `{ kind, requestId, projectId, expectedRevision, payload }`, validated with exact keys (`invalid_access_command`), committed through `Application.execute` with an owner receipt and one audit row. Replaying a request id returns the first receipt; another payload under that id is `request_id_conflict`. The receipt is `{ access, roles, halt? }`.

| Command | `expectedRevision` | Rules |
| --- | --- | --- |
| `access.level.set { level, confirmToken? }` | level revision | Widening (rank increases) needs `channel: web` (`access_widen_requires_web`, 403), then the current revision (`stale_revision`), then `fullAllowed` for `full` (`access_full_not_allowed`, 409), then the exact confirm token for `[projectId, current, requested, expectedRevision]` (`access_confirm_required`, 409). Narrowing or re-setting the same level needs no token, from any authorized channel. |
| `access.role.restrict { roleId, level \| null }` | that role's override revision | The role must exist (`role_not_found`). A level above the current project level is `access_role_above_project` (409). Raising the stored cap — a higher override, or clearing an override with `null` — is widening and needs `channel: web`, even while a lower project level hides the difference. |
| `execution.halt { reason? }` | halt revision | The kill switch, from any authorized channel. In the same transaction it records the halt, fences every queued, admitted or waiting execution-capable job of the project like `job.stop` (works without a running scheduler), and — with a live scheduler — stops every active team discussion (`team.stop_all` path), Jit reply (`jit.reply.stop` path) and coordinator synthesis (its job's `job.stop`) of the project. Transports are asked to abort after commit. The receipt's `halt` lists `fencedJobIds`, `stoppedReplyIds`, `stoppedDiscussionIds` and `stoppedSynthesisIds`. |
| `execution.resume {}` | halt revision | Web only (`access_widen_requires_web`, 403). Needs a halted project (`execution_not_halted`). |

Owner actors from Web, Telegram and the S10 REL06 local API (app.local_api/v1) are accepted. The local API listener's actor carries `channel: "web"` for ordinary commands, but access commands attribute it to `local-api` (recorded in the revision rows), so it may narrow and halt but never widen or resume. Widening checks `channel === "web"`, so every other channel is refused.

## Execution-capable jobs

`WorkDefinition.execution: true` marks execution-capable work; the job record carries `execution: true`. No current definition sets it (EXE05 is the first). For such work, `job.enqueue` and `job.resume` call `assertExecutionAllowed(…, "workspace")`, the pump blocks queued work as `authorization_changed` when the guard fails, and each attempt's freshness check (dispatch, reservation and result commit) applies the same guard.

## HTTP (JSON only; the Web pages are EXE04)

Same session, Origin and CSRF (`x-csrf-token` header or `csrf` field) rules as `/api/projects/:project/dispatch-allowance`.

- `GET /api/projects/:project/access` → `{ access, roles, effective }`
- `POST /api/projects/:project/access` `{ requestId, expectedRevision, level, confirmToken? }`
- `POST /api/projects/:project/access/roles` `{ requestId, expectedRevision, roleId, level }` (`level` may be `null`)
- `POST /api/projects/:project/execution/halt` `{ requestId, expectedRevision, reason? }`
- `POST /api/projects/:project/execution/resume` `{ requestId, expectedRevision }`

## Telegram

`/halt [reason]` in the bound owner chat issues `execution.halt` for the chat's bound project with the `telegram` channel. No Telegram text or callback widens anything; a forged callback ref with an access action is refused as unsupported.

## Not in v1

- An operator who clears `JIT_EXECUTION_FULL_ALLOWED` after a project was set to `full` does not lower that project; `fullAllowed` gates setting `full` only.
- Stopping the box on halt arrives with the box (EXE03).
