# BOT03 role proposals contract, v1

Owner: Jit #94 (S09 BOT03). Status: implemented on the issue branch. Spec: [S09](../specs/S09-main-bot-and-chat-first-ui.md) (S09-D02, D03, S09-AC02). Decisions: [ADR 0029](../adr/0029-jit-conversation-and-role-proposals.md) (role proposals) and [ADR 0011](../adr/0011-role-configuration-and-run-port.md) (model output has no configuration authority). Requirements: FR-02, FR-17, FR-19, FR-20, NFR-05, NFR-07, NFR-10.

Uses `app.jit_reply/v1` and `app.role_configuration/v1` without changing their public behavior. The reply parser gains a per-kind proposal handler, and `role.save` is called from the accept command.

| Contract | Public entry and behavior |
| --- | --- |
| `app.role_proposals/v1` | `src/team/role-proposals.ts`. A Jit reply may carry at most 2 role proposals. Each one is a list of immutable revisions with states `proposed`, `accepted`, `rejected` or `superseded`. Revision 1 is Jit's. An owner edit appends an owner-authored revision and supersedes the one before it. Only `role.proposal.accept` of the current open revision creates a role. It writes through `role.save` (`mutateTeamConfiguration`) in the same transaction, receipt and audit entry. Read model: `JitReplyView.roleProposals` (`RoleProposalView[]`) from `Application.replies`. Commands: `role.proposal.accept`, `role.proposal.revise` and `role.proposal.reject`. |

## Proposal shape

Jit is told the shape and the configured routes in two trusted operator lines:

```json
{"reply": "...", "proposals": [{"kind": "role", "name": "...", "responsibility": "...", "route": {"provider": "grok", "model": "...", "authRoute": "..."}}]}
```

`normalizeJitReply` offers each `proposals` entry to the handler registered for its `kind`. A declined or unhandled entry is discarded as `proposal:<kind>`, as in BOT01. The `role` handler applies these rules to untrusted model output:

- `name` must be one line of at most 80 characters and 200 UTF-8 bytes (the `role.save` bound), and `responsibility` must be plain text within `TeamPolicy.responsibilityBytes`. Both are trimmed and must not be empty. Otherwise the whole entry is discarded (`proposal:role`). So are entries after the second, and entries with no content, such as one that only names an existing card's id and a state.
- `route` is optional. It is kept only when it equals, field for field, a route the owner has configured: the owner default, a role's own route, the project default or a project override. A well-formed route that is not configured is dropped as `route:unconfigured`. A malformed one, for example with extra keys, is dropped as `route:invalid`. In both cases the proposal inherits the default route.
- Every other key is dropped as `field:<safe identifier>`. Examples are `tools`, `budgets`, `state`, `approvedBy`, `author` and `revision`. At most 8 codes are kept, and the total is counted. Key names are reduced to safe identifiers, so model text is never copied into the list.
- The service sets the author (`jit`), the revision (1), the state (`proposed`) and the id. Nothing in the output can set them.

Job evidence adds `· proposals role:<n>` when an answered reply carries proposals.

## Commands

All three use the shared receipt boundary: owner actor, global request-id receipts (`request_id_conflict`), one audit row, and refusal during upgrade and restore fences. `expectedRevision` is the proposal revision on the card the owner saw.

| Command | Payload | Effect |
| --- | --- | --- |
| `role.proposal.accept` | `{ topicId, replyId, proposalId }` | Re-checks that the route is still configured (`route_not_configured`). A revision without its own route needs a project or owner default at that moment (`role_proposal_route_missing`), so the new role can always join a discussion. Saves `{ roleId: null, kind: "specialist", enabled: true, name, responsibility, route }` through `role.save` under the owner team revision read in the same transaction. Marks the revision `accepted` with the new `roleId`. Receipt: `{ proposal, role, teamRevision }`. |
| `role.proposal.revise` | `{ topicId, replyId, proposalId, name, responsibility, route }` | Validates like the parser, but rejects the command instead of dropping: `invalid_role_proposal_command` or `route_not_configured`. Marks the current revision `superseded` and appends an `owner` revision. |
| `role.proposal.reject` | `{ topicId, replyId, proposalId }` | Marks the current revision `rejected`. No role is created. |

Rejections:

- `role_proposal_not_found` (404): an unknown id, or a reply in another topic.
- `role_proposal_closed` (409): the current revision is accepted or rejected. Accepting again therefore never creates a second role.
- `role_proposal_route_missing` (409): no own route and no default route to inherit.
- `role_proposal_stale` (409): `expectedRevision` is not the current revision, for example a card rendered before an edit.

A model-produced object is never a command. Topic or source text that claims owner approval is untrusted manifest data (BOT01) and cannot reach these commands.

## Storage

Proposals are stored in the reply's own `team_runs` record (`kind: "jit_reply"`, field `roleProposals`). No schema change is needed. Each change moves the reply's stream cursor. Backups and restores carry them with the record. Routes are stored in canonical key order and compared field by field.

Data deletion follows one typed rule, `redactRoleProposals`, which is shared by every path:

- **Lineage.** The reply output is purged in any relation: the owner deleted the reply itself, or deleted a message the reply copied.
- **Quoted-copy scrub.** The generic string scrub skips `roleProposals` and applies this rule instead.
- **Restore ledger replay.**

The rule rewrites only Jit-authored revisions: their name, their responsibility, and any dropped code named after a model field. Such a code becomes `field:redacted`; the fixed dictionary codes and the count stay. The same rule (`redactRoleProposalView`) applies to the `proposal` snapshot in `role.proposal.*` receipts, so a replayed receipt always shows the owner's exact revision and never presents redacted Jit text as acceptable. If the rewritten revision was still open, it is closed (`superseded`, `closedBy: "deletion"`), so a card rendered before the deletion cannot create a role from text the owner never saw. Owner-authored revisions are owner configuration and are kept. Routes are opaque configured references and are never rewritten. A role created by an accept is owner configuration in `roles`, like any `role.save`.

## Web

- **Card.** The card follows the committed Jit reply that carries it (`#proposal-<id>`). `src/web-proposal-card.ts` holds `proposalCard`, the generic proposal card of the design system, and `roleProposalCard`. The card shows:
  - the kind line and the name;
  - a status pill in words;
  - the revision and its author, plus earlier revisions;
  - the responsibility and the route ("default route" when inherited);
  - what was dropped from Jit's revision, in dictionary words (tools, budget, unconfigured or invalid route, unsupported field `<id>`);
  - a note that no role exists until the owner presses Create.

  When the route is inherited, the card names the default it would use. Without any default, the card hides Create and asks the owner to pick a route in Edit. A card closed by a deletion says so.

  While the proposal is open, it offers Create, Dismiss and an Edit form. The Edit form's route list holds only configured routes.
- **Without script.** Every action is a form post to `POST /projects/:p/topics/:t/replies/:r/proposals/:id/(accept|revise|reject)`. Each returns 303 to `?after=<reply sequence − 1>#proposal-<id>`. The JSON variant under `/api/` takes the same fields (the route as an object or null), requires the CSRF header and rejects unknown fields. The form sends the route as `""` (default) or as one configured route in JSON. Textarea CRLF becomes LF.
- **Stream.** Reply events carry `proposals` (a count). `app.js` shows the card's "Jit made a proposal — open it to review" link only when an answered reply carries one. The cards themselves are server-rendered.
- **After acceptance.** The card links to `/settings/team#role-<id>`. The role is listed there at once and can be included in `team.dispatch`.

All labels are dictionary keys (`proposal.*` and the new `error.*` codes) in Thai and English.

## Evidence

`tests/role-proposals.test.ts` uses a scripted host and a fake clock. It covers:

- Operator lines with the shape and the configured routes. One accept creates one role through `role.save`, with one receipt and audit entry. Replay, a second accept and request-id conflicts. The stream count. The role in team settings and in a dispatched discussion.
- An owner edit as an owner-authored revision. Stale cards before and after the edit. Unconfigured routes in an edit.
- Dismiss, closed proposals, and unknown or cross-topic targets.
- Injection: forged owner approval in the owner message and in output fields, a shell tool and budget request, an unconfigured and a malformed route, a third proposal, and a forged state on an existing card id. None changes configuration, and the card lists what was dropped without echoing the route values.
- A no-script form flow (edit, stale re-post, create) in Thai and English, and the JSON path with CSRF and unknown-field rejection.
- The `app.js` link contract.
- Deletion lineage that redacts Jit's proposal text, closes the open card (an accept captured before the deletion is refused) and keeps the owner's edit.
- Direct deletion of the reply.
- A quoted-copy scrub whose term matches the owner's text and a configured model id; both are kept.
- A missing, added and withdrawn default route.
- A 67-character Thai name (201 bytes).
- Reordered route keys in an API edit, then the form.

`tests/jit-reply.test.ts` (BOT01) still passes unchanged. Role entries without a responsibility are discarded as `proposal:role` there.
