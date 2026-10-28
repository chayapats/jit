# Task acceptance without execution, v1

Owner: Jit #16 (TASK01). Contracts: `app.task_commands/v1`, `app.task_proposals/v1`, `app.task_read_model/v1`. Implementation: `src/tasks.ts`, `Application`, topic, decision, and task HTML. Requires `app.coordinator_synthesis/v1`, `app.source_records/v1`, `app.owner_identity/v1`, `app.command_receipts/v1`, and `app.project_commands/v1`. Schema user_version 9.

Acceptance records an owner obligation. It does not start a shell, an edit, a test, a build, or a coding run. Model text is not a task command.

## Exact public surface

```ts
export type TaskChannel = "web" | "telegram";
export type TaskCommand =
  | { kind: "task.propose"; requestId: string; projectId: string; expectedRevision: number;
      payload: { topicId: string; title: string; summary: string; source?: SourceReference } }
  | { kind: "task.edit"; requestId: string; projectId: string; expectedRevision: number;
      payload: { taskId: string; title: string; summary: string; source?: SourceReference } }
  | { kind: "task.dismiss"; requestId: string; projectId: string; expectedRevision: number;
      payload: { taskId: string; proposalId: string; reason: string } }
  | { kind: "task.accept"; requestId: string; projectId: string; expectedRevision: number;
      payload: { taskId: string; proposalId: string } }
  | { kind: "task.cancel"; requestId: string; projectId: string; expectedRevision: number;
      payload: { taskId: string; reason: string } }
  | { kind: "task.start"; requestId: string; projectId: string; expectedRevision: number;
      payload: { taskId: string } };

export function isTaskCommand(command: { kind?: unknown } | null | undefined): command is TaskCommand;
export function taskIdentity(command: TaskCommand, maximumBytes: number): string;
export function readTaskList(tx: AppTransaction, projectId: string, limit: number): TaskList;
export function readTaskModel(tx: AppTransaction, projectId: string, taskId: string): TaskReadModel;
export function applyTask(tx: AppTransaction, command: TaskCommand, channel: TaskChannel, now: number, maximumBytes: number): TaskReceipt;

Application.issueAdapterActor(sessionToken: string, channel: TaskChannel): OwnerActor;
Application.execute(actor: OwnerActor, command: TaskCommand): TaskReceipt;
Application.tasks(actor: OwnerActor, projectId: string): { project: Project; topics: Topic[] } & TaskList;
Application.task(actor: OwnerActor, projectId: string, taskId: string): { project: Project; topic: Topic } & TaskReadModel;
```

`TaskReceipt` is `{ task, proposal, event }`, returned only after commit. Replay returns that same JSON. `TaskList` keeps `proposed`, `accepted`, and `closed` (dismissed or cancelled) separate. `app.task_proposals/v1` is the immutable `task_proposals` revision row, not a second module.

`expectedRevision` for `task.propose` is the topic revision. For every other task command it is the current proposal revision. `task.dismiss` and `task.accept` must also name the current proposal id. The accepted actor is the authenticated owner. A payload cannot name a different actor.

## Behavior

`task.propose` creates one proposed task and proposal revision 1. Wording is bounded: title at most 200 characters, summary at most the message byte limit, and title plus summary at most 65536 bytes. No source cites a new owner topic source whose text is the title, a newline, and the summary. A named source must be available in this project, attributed to a participant, described as output, and matched by a `decision_proposals` row for this project and topic or by a participant message in this topic. A source owned by another project is `project_mismatch` and does not point at that project's tasks. Owner chat is `source_not_validated`.

`task.edit` is allowed only while the task is proposed. It appends a proposal revision. `task.dismiss` closes a proposal as `dismissed` and keeps the reason. `task.accept` moves that exact revision to `accepted` and does not enqueue a job. A second accept is `task_already_accepted`. Edit or dismiss after acceptance is `task_not_proposed`. Accept, edit, or dismiss after dismiss or cancel is `task_already_closed`. `task.cancel` is allowed only from `accepted`; every other state is `task_not_accepted`. Cancel keeps the reason and the acceptance record. Closed tasks are not reopened.

`task.start` is refused with `coding_execution_unsupported` after the task and revision checks. A stale revision is `stale_revision` first. A missing task in that project is `task_not_found`. The refusal writes no event, receipt, or job.

The same request id and payload hash replays the receipt. A different payload under that request id is `request_id_conflict` and is not stored as an edit. Stale task errors carry `{ projectId, taskId, proposalId, revision, path }`. A stale topic on propose carries `{ projectId, path }` for the topic and no task id.

Web task commands allow channel `web`. `issueAdapterActor` checks the live session and may label the same commands `telegram`. It does not read Telegram updates. Forged `{ ownerId, channel }` objects have no authority. Project creation and owner decisions stay on channel `web`; a telegram actor receives `channel_not_authorized`.

PR monitor enablement and a `project.status` job do not insert a task. Ordinary chat, including the words "accept and execute", does not insert a task.

The read model lists and opens tasks without creating receipts. An unavailable source stays unavailable. The row is not deleted.

## HTTP

| Route | Behavior |
| --- | --- |
| `GET /projects/PROJECT/tasks` | Separate proposed, accepted, and closed lists; optional `topic` selects the propose form |
| `GET /api/projects/PROJECT/tasks` | The same read model as JSON |
| `POST /[api/]projects/PROJECT/tasks` | `task.propose`; form `source` is a JSON source reference |
| `GET /projects/PROJECT/tasks/TASK` | One task, proposal history, events, and the actions that match its state |
| `GET /api/projects/PROJECT/tasks/TASK` | The same read model as JSON |
| `POST /[api/]projects/PROJECT/tasks/TASK` | `mode` is `edit`, `dismiss`, `accept`, `cancel`, or `start` |
| Topic HTML | "เสนอเป็นข้อผูกพัน" posts a proposal and states that chat is not an accepted task |
| Decision HTML | The validated-output propose form is rendered only when a proposal exists and the topic revision was passed |

POST requires the owner session, `Origin`, and CSRF. GET never proposes, accepts, or starts. Unknown body keys are rejected. Invalid source JSON is `invalid_body`. A stale or refused command can include a recovery link to `detail.path`. Titles, summaries, and reasons are escaped.

## Schema

user_version 9 adds `tasks`, `task_proposals`, and `task_events`. States are `proposed`, `accepted`, `dismissed`, and `cancelled`. Origins are `owner` and `validated_output`. Event kinds are `proposed`, `edited`, `dismissed`, `accepted`, and `cancelled`. Channels are `web` and `telegram`. `actor_id` is `owner`. Source foreign keys reference `sources(id)`. Topic foreign keys reference `topics(project_id, id)`. Migration snapshots the previous file before DDL and rejects a newer schema.

Deterministic evidence: `tests/tasks.test.ts` with a fake clock, local SQLite, and no live model calls. See [ADR 0016](../adr/0016-task-acceptance-without-execution.md).
