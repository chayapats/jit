# ADR 0016: Task acceptance without execution

Status: accepted for TASK01 engineering choices (Jit #16). Requirements: FR-04, FR-06, FR-10, FR-11, FR-15, FR-17, NFR-01, NFR-05, NFR-07, NFR-10.

## Confirmed decisions and required behavior

ADR 0004 keeps a proposal, an accepted obligation, and a later start command as different states. Model text, a coordinator recommendation, a specialist majority, the words "approved" or "accept and execute", a reminder, and a PR monitoring job do not create or accept a user task. Acceptance records the owner, the channel, the time, and one proposal revision. It does not open a shell, edit files, run tests, build, or enqueue a coding job.

Telegram may label an owner task command after the installation session is checked. This slice does not read Telegram updates, bind a chat, or let that channel accept an owner decision or create a project.

## Selected implementation

Store task rows, immutable proposal revisions, and owner events in schema v9. `task.propose` inserts the task row before its first proposal so the proposal foreign key has a parent. Later edits append a revision. They do not rewrite the previous proposal. The current proposal id is not itself a foreign key, which avoids a circular insert.

`task.accept` is the only transition into `accepted`. It stores `acceptance_json` with actor `owner`, the authenticated channel, the proposal id and revision, and the time. `task.dismiss` closes a proposal. `task.cancel` closes an accepted obligation and keeps the acceptance record. Neither closed state can be reopened. A new proposal is a new task id. `task.start` checks the task and the expected revision, then throws `coding_execution_unsupported` and commits nothing: no event, no receipt, and no job.

Commands use `app.command_receipts`. The same request id and payload replays the original receipt. A different payload under that request id conflicts. A stale proposal revision returns the current proposal identity and does not write. Two channels can race one acceptance; one commit wins and the other sees `task_already_accepted`.

A proposal with no source cites a new owner topic source. A proposal that names a source must resolve that source inside the same project, as an available participant output, and as either a decision proposal for that topic or a participant message in that topic. Owner chat and a source from another project are rejected. Unavailable content stays unavailable. The task row remains.

The topic page, the decision panel when a validated proposal and the topic revision are both present, and `/projects/:id/tasks` project `app.task_read_model/v1`. GET does not insert a task or a receipt. Web and the adapter actor share one command union. Forged actor objects are not registered.

## Alternatives and consequences

Putting accepted tasks into `jobs` would make a standing PR monitor or a project inspection look like an owner obligation. Mutable proposal JSON would let a stale page accept different wording under the old revision. Automatic acceptance when a model says the work is approved would move authority off the owner. Recording `task.start` as a `start_refused` event would leave a receipt for a command that must not commit.

Schema v9 follows the snapshot-before-DDL migration. A database already at v8 gains the task tables and keeps its previous rows. This slice does not add completion policy, live engine execution, or Telegram transport. Those stay with later tickets.

The exact surfaces are recorded in [task-acceptance-v1](../contracts/task-acceptance-v1.md).
