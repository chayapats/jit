# REL03 routing selection contract, v1

Owner: Jit #115 (S10 REL03). Status: implemented on the issue branch. Spec: [S10](../specs/S10-reliability-and-owner-integrations.md) (S10-AC02). Decision: [ADR 0033](../adr/0033-deterministic-routing-and-result-contract.md) "Deterministic rules first", "Model selection otherwise" and "Visible reason". Requirements: FR-27, FR-02, FR-21, FR-17, NFR-07, NFR-10.

Uses `app.team_dispatch/v1`, `app.dispatch_allowance/v1` and `app.jit_reply/v1`. It adds an optional reply target to `message.send` (`app.conversation/v1`), a `why` to the dispatch proposal, two hold reasons and a `selection` on dispatch proposals and on the discussions they start. The allowance numbers, the operator ceiling, admission and attempt fencing do not change.

## `app.routing_selection/v1`

`src/team/routing.ts`.

```ts
type SelectionRule = "named" | "reply" | "follow_up" | "single" | "model";
interface RoutingSelection { rule: SelectionRule; roleIds: string[]; why: string | null }
interface ParticipationReference { discussionId: string; roleId: string }
selectRoles(tx, { message: { id; sequence; text; replyTo? }, topic: { id }, project: { id }, config }):
  { selection: RoutingSelection; continues: string | null } | null;
```

`selectRoles` runs inside the owner's `message.send` (or `chat.start`) transaction, before the Jit reply is admitted. It applies the fixed rules below in order and makes no model call. It returns null when no rule applies. Since #169 only explicit owner intent selects without Jit: rules 3 and 4 no longer select (see "Answer first").

| Order | Rule | Applies when | Roles |
| --- | --- | --- | --- |
| 1 | `named` | The text has an `@name` that matches exactly one enabled, routed specialist. The match is NFC, case-insensitive and exact; the longest configured name wins, so names may contain spaces. A mention starts at an `@` that is not inside a word or an address (`a@b` is not a mention) and ends at a word boundary. | Every such specialist, in order of mention. A mention shared by several eligible specialists is ambiguous: the service does not guess, so only an explicit `reply` target may still apply and otherwise the model path decides. Mentions of the coordinator, of disabled or unrouted roles, or of no configured role are ignored. |
| 2 | `reply` | `replyTo` names a participation of a discussion in this topic, and that role is still an eligible specialist. | That role. |
| 3 | `follow_up` (context only since #169) | The topic has exactly one open Jit-dispatched discussion, its team reply has committed, and no other owner message came after that team reply. A discussion is open unless it was stopped (`team.stop_all`), the owner has a current decision on it, or a later dispatch continued it (`continues`). Discussions the owner started from the dispatch form have no dispatch card and do not count. | Its participants that the owner did not skip or exclude and that are still eligible. |
| 4 | `single` (removed in #169) | The project had exactly one eligible specialist. | Nobody now. |

An invalid `replyTo` rejects the whole command with `reply_target_not_found` (404) before anything is written: the discussion must exist in this project and topic and the role must take part in it. A malformed one is `invalid_conversation_command`. `replyTo` is owner input; model text never supplies it.

### Answer first (#169)

Rule 4 called the only specialist on every owner message, small talk included, and rule 3 called the previous team again on the next message after any team reply. Neither asked whether the message needed the team. Since #169:

- Only `named` and `reply` select specialists without Jit.
- Rule 3's condition is computed by `followUpCandidate` and stored on the reply record as `followUp: { discussionId, roleIds }`. It calls nobody. The reply run gets one more sentence in its dispatch line naming that discussion's specialists, and says to propose them again only if the owner asks that team to continue. When Jit's model proposal is admitted and every admitted role belongs to `followUp.roleIds`, the proposal records `continues: followUp.discussionId`, so the chain stays one open discussion.
- Rule 4 is gone.
- The dispatch line starts with "Answer the owner yourself by default." It allows a dispatch proposal only when the owner asks for the team or the question clearly needs a specialist's separate analysis, never for greetings, small talk, quick questions or anything Jit can answer well itself.
- Records written before #169 keep `follow_up` and `single`; cards still render them with their dictionary labels.

### With a fixed rule

The Jit reply still answers the owner (ADR 0029). Its record keeps the rule result (`routing`). The run gets one operator line that names the rule and the chosen specialists (owner-configured names, bounded like the roster) and says not to propose a dispatch, and the reply registers no `dispatch` handler. A `dispatch` entry the run returns anyway is discarded as `proposal:dispatch`. No run is asked to select specialists. The job evidence adds `selection <rule> <count>`.

When the reply commits through its attempt fence, `admitJitDispatch` runs with the rule's role ids in the same transaction, exactly as BOT04 does for a model proposal. Each id is checked against the configuration current at the commit. A role that is no longer an eligible specialist makes the selection stale (`stale_selection`): the proposal holds the roles still callable and nothing starts. Otherwise the allowance current at admission decides (`allowance_disabled`, `over_allowance`, `scheduler_unavailable`, `queue_full`, `not_admitted`), as in BOT04.

### Without a fixed rule

The reply run is offered the dispatch proposal, now `{"kind": "dispatch", "roles": [names], "why": string}`, a closed schema:

- `roles` is unchanged from BOT04: 1–16 non-empty, well-formed strings of at most 200 characters.
- `why` is optional. When present it must be a well-formed string that, with whitespace collapsed and trimmed, is non-empty and at most 160 characters (code points). Absent means `why: null`.
- Any other key, a bad `why` or a second dispatch entry discards the entry as `proposal:dispatch`.

At commit the names are matched against configuration as in BOT04 and the proposal records `selection: { rule: "model", roleIds: <validated ids>, why }`. The selection is held for the owner and never broadcasts when:

- any name was dropped (unknown, ambiguous, disabled or unrouted, the coordinator, or beyond the operator ceiling): `invalid_selection`;
- the team configuration revision (`ownerRevision` or `projectRevision`) changed after the reply run was given its roster: `stale_selection`.

If no name is callable the proposal is `empty`. The owner can still accept a subset of the held roles from the card; `why` and model text never widen the allowance, name a role that is not configured or start anything by themselves.

### Records

- `dispatch_proposals.record_json` adds `selection` (ids and the rule only; `why` is stored as null) and, for `follow_up`, `continues` (the discussion it continues). Proposals written before REL03 have neither.
- The discussion a proposal starts (standing allowance or owner-accepted) records the same `selection`. `Discussion.selection` is absent on owner-form and pre-REL03 discussions.
- `why` is model text, so it is stored only on the Jit reply record that produced it (`team_runs`, kind `jit_reply`, field `dispatchWhy`), next to the output it came from. The card's read model fills `selection.why` from there. Data deletion of that reply's output (and the quarantined-restore replay, which reuses the same lineage redaction) clears `dispatchWhy` and the `selection.why` copied into `dispatch.*` command receipts of that reply, so the card and a replayed receipt then show the selection without a reason. Backups classify `team_runs` as before.
- `DispatchCardView` adds `selection`, `addable` (eligible specialists not in the started discussion) and `canInclude` (the discussion is not stopped, has no team reply yet and has room in its role budget).

## Web

The card under the dispatching reply shows one selection line:

- A fixed rule shows only its name (`team.selection_rule_named`, `_reply`, `_follow_up`, `_single`).
- A model selection shows `team.selection_why_label` ("Jit's reasoning, not evidence") followed by `team.selection_why`, "จิตเลือก {names} เพราะ {why}" / "Jit chose {names} because {why}", or `team.selection_model` when there is no `why`. The names come from configuration, and the whole line is HTML-escaped, so `why` renders as text.

From the same team card the owner can correct the selection. Every control is a plain form post that works without script:

- **Skip** a running role: the existing `team.control` `skip`.
- **Call again** a skipped, stopped or excluded role, or **add** an eligible specialist who is not in the discussion: `team.control` `include` with `back=topic`, within the discussion's role budget. These controls appear only until the team reply exists. Jit answers for a team once (`settleDispatch`, `dispatch.answer`), so a later result could never reach that answer. After it, the owner corrects with a reply to an opinion, an `@name` or a follow-up, each of which starts a new dispatch and a new team reply.
- In a promoted (read-only) topic the card offers none of the reply, add or call-again forms (`DispatchCardView.readOnly`), since each would be refused with `topic_promoted`. Skip and stop-all stay.
- The card and `team.control include` read the same projected participation state. A role stopped from its job page (`job.stop`) reads `stopped` even though its stored participation was not rewritten, so it can be included again. Its fenced job still cannot commit a late result.
- **Reply** to one committed opinion: a form under that opinion posts `message.send` with `replyDiscussion` and `replyRole` (both or neither, otherwise `invalid_body`), so rule `reply` calls that role again.

The held proposal card shows the same selection line, its hold reason (`dispatch.reason.invalid_selection`, `dispatch.reason.stale_selection`) and the existing accept-a-subset and dismiss forms.

All labels are dictionary keys in Thai and English.

## Evidence

`tests/dispatch-allowance.test.ts` (REL03 cases) uses a scripted host and a fake clock. No test calls paid inference. It covers:

- `@database` with one role named Database: rule `named`, the reply run is not offered a dispatch, and its proposal is discarded. The card and discussion record the rule; the standing-allowance origin is unchanged. Addresses, in-word `@`, prefixes and unknown names are not mentions.
- `@db` matching two roles: no rule, the model path.
- A reply to a participation: rule `reply`. A role outside the discussion or a discussion in another topic is rejected and writes nothing.
- A follow-up after the only open discussion's team reply: no rule. Jit is told about the open discussion. A proposal for the same roles continues it, and a reply Jit answers itself calls nobody. With two open discussions, or after a second owner message, or after stop-all, Jit is not told (#169).
- One eligible specialist and a message that names nobody: no rule, and nobody is called unless Jit proposes it (#169).
- A model selection naming a disabled role, or made before the team changed: a held proposal with no job admitted. The owner can still accept it, and the discussion keeps Jit's selection.
- `why: "<img src=x onerror=alert(1)>"` rendered escaped and labelled in Thai and English; a `why` over 160 characters, non-string or empty, or an extra key, discards the entry.
- Allowance 1 and a rule selecting 2 roles: `over_allowance`, held per BOT04, then accepted by the owner.
- No script: accept, add, reply and call-again forms by plain POST, before the team reply; once it exists the card offers neither add nor call again.
- A role stopped through `job.stop` shows as stopped, and the card's call-again include is accepted and runs it again.
- Deleting the reply that carried `why` clears it from the card; the proposal and discussion records never held it.

`tests/team.test.ts` covers NFC and case matching, owner-form discussions not counting as open, and the owner router staying unchanged. `tests/jit-reply.test.ts` covers the closed proposal schema.
