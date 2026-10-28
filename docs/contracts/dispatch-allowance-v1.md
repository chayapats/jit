# BOT04 dispatch allowance and team card contract, v1

Owner: Jit #95 (S09 BOT04). Status: implemented on the issue branch. Spec: [S09](../specs/S09-main-bot-and-chat-first-ui.md) (S09-D02, D04, D08, S09-AC03, S09-AC04). Decisions: [ADR 0030](../adr/0030-owner-dispatch-allowance.md) for the allowance, [ADR 0029](../adr/0029-jit-conversation-and-role-proposals.md) for structured output, [ADR 0015](../adr/0015-coordinator-synthesis-and-owner-decisions.md) for decisions, [ADR 0010](../adr/0010-durable-job-admission.md) and [ADR 0012](../adr/0012-attempt-fencing-and-reconciliation.md) for admission and fencing. Requirements: FR-02, FR-03, FR-14, FR-15, FR-19, FR-21, NFR-05, NFR-06, NFR-10.

Uses `app.jit_reply/v1`, `app.team_dispatch/v1`, `app.specialist_results/v1`, `app.decision_commands/v1`, `jobs.queue_admission/v1` and `jobs.attempt_fence/v1`. It adds `team.stop_all` and the discussion `origin` to `app.team_dispatch/v1` and one dispatch proposal kind to the Jit reply's structured output. Nothing else in those contracts changes.

## `app.dispatch_allowance/v1`

`src/team/allowance.ts`, schema 27 `dispatch_allowance_revisions`.

```ts
interface DispatchAllowance {
  projectId: string; revision: number; enabled: boolean;
  maxRoles: number;          // what the owner set
  effectiveMaxRoles: number; // maxRoles capped by the current operator ceiling
  ceiling: number;           // min(JIT_JOB_ROLES, JIT_ROLE_LIMIT, 100)
  updatedAt: number | null;
}
Application.dispatchAllowance(actor, projectId): DispatchAllowance;
Application.execute(actor, { kind: "dispatch.allowance.set"; requestId; projectId; expectedRevision; payload: { enabled: boolean; maxRoles: number } }): { allowance };
```

- One allowance per project. With no row, the product default applies: revision 0, enabled, 3 roles per owner message (S09-D04).
- `dispatch.allowance.set` is the only writer. It appends one immutable revision, expects the current allowance revision (`stale_revision`), is idempotent by request id (`request_id_conflict`) and is audited. `maxRoles` must be a whole number from 1 to the ceiling at the time of the command (`invalid_dispatch_allowance`, `allowance_above_ceiling`). A disabled allowance keeps its number.
- If the operator later lowers the ceiling, `effectiveMaxRoles` follows it without rewriting the owner's revision.
- No work definition, adapter or result path writes the allowance. Model output and topic text cannot change it.

HTTP: `GET /settings/dispatch` (one form per project, paged like Project data), `POST /settings/dispatch/:project` (form; an unchecked box means off; `303` back to `#allowance-:project`), and `GET`/`POST /api/projects/:project/dispatch-allowance` (JSON, CSRF header).

## Dispatch proposals

`src/team/jit-dispatch.ts`, schema 27 `dispatch_proposals`.

A Jit reply to an owner message may return one `{"kind": "dispatch", "roles": [names]}` entry (see [jit-reply-v1](jit-reply-v1.md)). When that reply's result commits through the attempt fence, `admitJitDispatch` runs in the same transaction:

1. Names are matched against the owner's role configuration (NFC, case-insensitive, exact). Names that match nothing are counted. An eligible specialist is never shadowed by a disabled namesake, and a name shared by several enabled specialists is dropped as ambiguous: the service does not guess. Disabled or unrouted roles and the coordinator are dropped by name. Roles past the operator ceiling are counted. The model's own text is never stored or shown. REL03 ([app.routing_selection/v1](routing-selection-v1.md)): any dropped name now makes the selection invalid, so the proposal is held (`invalid_selection`) instead of starting the rest, and a reply run whose roster predates a team configuration change is held as `stale_selection`. The entry may carry a `why` of at most 160 characters, kept on the reply record and shown escaped as Jit's reasoning. A fixed rule's role ids are admitted the same way, without a model choice.
2. One proposal row is written per reply (`reply_id` is unique), holding only validated role ids and names, the drop counts and the allowance revision current at admission.
3. If no role is left, the proposal is `empty`.
4. If the allowance is enabled and the roles fit `effectiveMaxRoles`, the service starts a normal `team.discussion` through `prepareDispatch`: the named roles are the include list, every other eligible specialist is excluded, the frozen source is the owner's message, the purpose is that message cut to 300 UTF-16 units without splitting a character, and the limits are finite (`dispatchLimits`). The discussion records `origin: { kind: "standing-allowance", proposalId, replyId, allowanceRevision }`, the job authorization request id is `allowance-<reply id>`, and the authority generation is that of the owner's message. The proposal is `admitted`.
5. Otherwise the proposal is `proposed` with a reason: `over_allowance`, `allowance_disabled`, `scheduler_unavailable`, `queue_full` or `not_admitted` (REL03 adds `invalid_selection` and `stale_selection`, checked first). Starting runs inside a savepoint, so a failure never rolls back the reply.

The allowance never covers role creation, task acceptance, decisions, topic promotion or anything outside read-only specialist analysis.

Owner commands on a card (`Application.execute`, shared receipts, audit, CSRF over HTTP):

| Command | Behavior |
| --- | --- |
| `dispatch.proposal.accept` `{ proposalId, roleIds }` | Only on `proposed`. `roleIds` must be a non-empty subset of the proposal (`dispatch_role_not_proposed`). Starts the discussion the same way with `origin.kind = "owner-accepted"` and the owner's current generation. The proposal becomes `accepted`. |
| `dispatch.proposal.dismiss` `{ proposalId }` | Only on `proposed`. The proposal becomes `dismissed`. |
| `dispatch.answer` `{ proposalId }` | Asks Jit to answer now from committed results. Allowed when the team was started, no role is queued or running, at least one result exists and there is no team reply yet (`team_reply_not_ready`). |

Each expects the proposal `revision` (`stale_revision`) and bumps it. Closed proposals answer `dispatch_proposal_closed`. HTTP: `POST /[api/]projects/:project/dispatch/:proposal/(accept|dismiss|answer)`. The accept form sends one `role-<id>=on` checkbox per chosen role; JSON sends `roleIds`. No-script posts redirect to the card on its topic page.

## Team reply (one voice)

A team reply is an `app.jit_reply/v1` reply whose anchor is Jit's own dispatching reply message (that message's `jit_replies` row), so its admission, stream events, stop, resume and fencing are the BOT01 ones. Its question is the owner message the team analyzed: the manifest history ends there, so a later owner message never becomes the question, and the question always has room. Its record carries `team: { proposalId, discussionId, citations, gaps }`:

- `citations` are the committed specialist result revisions given to the run, frozen at admission. They are also manifest sources after the topic history and are recorded in `jit_reply_sources`, so forget lineage reaches the team reply.
- `gaps` are selected roles without a usable result, with a reason code. Skipped or excluded roles are the owner's choice and are not gaps (same rule as ADR 0015). The question's room is reserved first. The results-and-gaps line is charged at a fixed upper bound that holds for every split of the results into kept and gaps, in any order, so the budget does not move during packing; each result then adds only its own cost, and results are tried smallest first and kept while they fit, so one large result never crowds out smaller ones. Results that do not fit become gaps with reason `context_limit`; kept results stay in their original order.
- Operator lines that list role names (the roster in a message reply, results and gaps in a team reply) are bounded in bytes and end with `(+N more)`, so owner-configured names cannot push a line past the run-port limit.
- The run gets `teamReplyMarker` and policy lines, the persona, one line naming the results and gaps, and the speakers line. It gets no tools. Its output may not dispatch.
- If a cited result derives from memory context, the team reply's output inherits the deepest derivation in `memory_derived_sources`.

The team reply is admitted automatically when the discussion settles (every role completed, skipped, excluded, stopped or terminally blocked, none waiting on a route) and the team was not stopped. This happens inside the transaction of the last specialist result commit or of the owner's `team.control`. If a specialist's result is fenced (deadline, lease, changed input), the worker settles in its own transaction. Work the queue fails without ever running the worker leaves the card's "answer now". A failed team admission is contained and never rolls back the result or control. If the team reply cannot start (`queue_full`, `scheduler_unavailable`, `no_route`, `context_too_large`), its anchor row is rolled back, the reason is kept on the proposal (`teamHold`, shown on the card with its next action) and the owner can answer again; a later settle retries too.

Two specialist-worker rules changed with this slice: a committed specialist result advances the topic's message order but not its revision (the revision counts owner changes, as for Jit replies), so a composer opened while the team works still posts; and each specialist attempt reserves `floor(outputTokens / (retries + 1))` output tokens, so a route wait leaves budget for the resumed attempt.

## Stop and skip

- **Skip** is `team.control` `skip` from the card (`back=topic`). It fences that role's job with `job.stop`.
- **Stop all** is `team.stop_all`. It stops every role still queued, running or waiting through the same participation fence, stops a team reply that has not committed through its own job fence, and sets `stoppedAll`. Committed results stay. A stopped team gets no automatic team reply.
- Late results from fenced attempts are rejected by `jobs.attempt_fence/v1` and change no message, participation, citation or proposal.

## Read model and Web

`Application.dispatchCards(actor, projectId, topicId, messageIds)` returns `DispatchCardView`s keyed by the dispatching reply's message id. It includes proposals whose team reply message is among the ids. `Application.dispatchCard(actor, projectId, proposalId)` returns one. Reads never admit work.

- **Proposal card**: the shared `proposalCard` frame from BOT03 (`src/web-proposal-card.ts`, kind `dispatch`) inside a stable `#dispatch-<id>` anchor. It shows the kind, the state pill in words, the reason as its meta line, the proposed roles, what was dropped, the accept form with one checkbox per role, dismiss, and a link to the allowance setting. An empty proposal shows a short note instead.
- **Team card** under the dispatching reply: a `<details>` that is open until the team reply answers. Its summary gives counts in words. It shows who authorized it (allowance revision or owner), each role's state in words, skip for open roles, each committed opinion inside its own `<details>`, a note and job link for roles waiting on their route, stop all, answer now, a refresh link and the discussion page link. The specialist messages of a dispatched discussion are folded into the card instead of the chat column.
- **Under the team reply**: links to each cited result revision, the coverage gap in words, and the existing decision path: "save as a decision" posts `decision.synthesize` for the discussion. While it runs, the card says so. Once a proposal exists, it links to review it on the discussion page, where the owner still accepts the exact proposal revision with `decision.accept`. Nothing here records a decision.
- Everything is a form post, so the cards work without script; with script nothing intercepts them, and the team reply streams like any reply.

All labels are dictionary keys (`dispatch.*`, `team_card.*`, `team_reply.*`, `settings.dispatch*`, new `error.*`) in Thai and English.

## Schema

Schema 27 adds `dispatch_allowance_revisions` (project_id, revision, enabled, max_roles 1–100, created_at) and `dispatch_proposals` (id, project_id, topic_id, reply_id unique, revision, state, admission, allowance_revision, discussion_id unique or NULL, team_reply_id unique or NULL, record_json, timestamps; `discussion_id` is set exactly when `admission` is). Both are classified `include` for backups. Existing installations need the owner-authorized staged upgrade.

## Evidence

`tests/dispatch-allowance.test.ts` uses a scripted host and a fake clock. No test calls paid inference. It covers:

- **Within the allowance**: discussion through the existing path with the standing-allowance origin and revision, interactive jobs, the team reply citing the exact result revisions with no gap, folded specialist messages, readable opinions, Thai and English cards without script, and no decision, task or role written.
- **Over the allowance and allowance off**: the proposal card, accepting a subset (owner origin), replay, stale and closed commands, foreign roles, dismiss, CSRF.
- **Unknown, disabled and coordinator names**, an all-unknown proposal, injected owner text and extra model fields, a second dispatch entry, and a team reply that tries to re-dispatch.
- **Operator ceiling**: effective cap, rejected values and roles beyond the ceiling.
- **Stop all mid-run with late callbacks**, **skip with a late result**, and **stop all on a thinking team reply** with its late result.
- **Fake clock**: a role past its deadline becomes a gap, answer-now cites what exists, the stalled adapter's late result is rejected, and team work is admitted ahead of earlier background work.
- **Decision path**: save as a decision runs the existing synthesis; nothing is decided until `decision.accept`.
- **Settings**: form and JSON, revisions, replay, audit, ceiling, English.
- **Reopen and backups**: identical card after reopening the store, backup classification, dictionary coverage.
