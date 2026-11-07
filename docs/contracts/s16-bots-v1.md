# s16-bots/v1

BOT16-01 (#412) and DELEG16-01 (#413). Decision record: [ADR 0088](../adr/0088-s16-persistent-bots-and-delegation.md). Exported TSDoc in `src/s16/bots/` (`types.ts`, `service.ts`, `delegation.ts`), `src/s15/conversation/application.ts` (`submitDelegation`), `src/s15/conversation/policy-port.ts` (`bots`) and `src/s15/policy/service.ts` (membership-only revisions) is the executable contract; this page summarizes it.

## Selection

- Runtime config `s15-runtime/v1` field `bots: boolean` (absent: off). The generated S15 installer config sets `true`.
- Composition option `bots: {}` adds the additive store `bots.sqlite` (an older manifest gains it once, like the other S16 stores).
- Off means: every conversation talks to `conversation.bot` with `conversation.selection`, no `delegate`/`propose_bot` tools, and `capabilities.bots = { available: false, code: "bots_unavailable" }`.

## Protected state (`bots.sqlite`, application id `0x4a494236`)

| Table | Meaning |
| --- | --- |
| `bots(id PK, record_json)` | `s16-bot/v1` profile. `ref` is the POLICY catalog identity for created Bots (and for a configured Bot once archived). |
| `proposals(id PK, record_json)` | `s16-bot-proposal/v1`, states `pending`, `accepted`, `dismissed`. At most 64 pending. |
| `bindings(conversation_id PK, bot_id)` | Conversation's Bot. Update/delete triggers refuse (`binding_immutable`). Unbound: the main Bot. |
| `commands(id PK, payload_hash, result_json)` | Owner command idempotency (`request_id_conflict` on a changed body). |

Bounds: name 1–60 characters, responsibility up to 2000, at most 32 created Bots, 32 exclusions, exports up to 16 KiB.

## POLICY

- `bot.accept` installs `revision + 1` of the current standing policy with the new `Ref` appended to `bots` and to every rule naming the main Bot whose mode is not `personal_github_publish`, `personal_github_merge` or `recurring_payment`. POLICY receipt id: `bot_` + 40 hex of SHA-256 of the command `requestId`.
- A work admitted under revision *r* stays current under revision *s > r* when the two revisions are not canonically identical (ignoring `revision`) and are identical after removing every Bot other than the work's own from `bots` and from each rule's `bots`.
- The composed catalog answers `bot` from the directory first. Archived: `{ ref, active: false }`. Catalog `allows` refuses any resource in the work Bot's `excluded`.
- The default-policy proposal (`s15DefaultPolicy`) takes `extraBots`: the created Bots' refs in creation order, given every default rule.

## Conversations

- `ConversationPolicy` (`createConversationPolicy({ bots })`) resolves `{ bot, selection, excluded }` per `conversationId`. `selection` is the Bot's choice when it is still in the policy's selections, else `conversation.selection`. Work `selectionPin` is that selection; physical reservations use the work's own selection.
- `ConversationOptions.admitConversation(conversationId)` runs for every new request (message, clarification, routine occurrence, assignment) and refuses `bot_archived` / `bot_unavailable`.
- Owner decisions for a work include `{"bot":{"name","responsibility"}}` when the profile has either, and `{"assignment":{…}}` for a child.

## Delegation

| Field | Value |
| --- | --- |
| Pin | `s16-delegation-run/v1`: `parentRequestId`, `parentConversationId`, `ordinal`, `kind` (`peer`/`temporary`), `botId`, `fromBotId`, `purposeId`, `resourceIds`, `access`, `limits {modelCalls, toolCalls}`, `sourceId` |
| Child ids | `dl_` / `dc_` + 40 hex of SHA-256 of `s16.delegation.child.v1\n<parent>\n<ordinal>` |
| Bounds | 6 children per request, 3 unfinished per request, 3 per tool call, task up to 4000 characters, installation pool `clamp(1, 3, default member maxSessions − 1)` |
| Slice | modelCalls `max(2, ⌊L.modelCalls/3⌋)`, toolCalls `max(1, ⌊L.toolCalls/3⌋)`, charged to the parent; refused `budget_exhausted` unless the parent keeps one model call |
| Refusals | `delegation_unavailable` (parent not running in its work phase, a child, or settled), `capacity_busy`, `budget_exhausted`, `bot_unavailable` (peer not active or not accepting), `private_context` (Bot-private ancestry to a peer) |
| Tool output | `{"assignments":[{"to","state","code","result"}]}`; `state` is the child request state, `not_started`, or `withheld` when its publication guard refused |

Child requests have `phase: "work"` from the start, no interpretation, no memory, and are admitted with `ownerMessage: false` and `delegation` limits. After a restart a queued child is `blocked/context_lost`.

Owner projections: `ConversationOwnerRow.children` (`requestId`, `conversationId`, `kind`, `botId`, `task`, `state`, `code`) on the parent and `ConversationOwnerRow.delegation` on the child. `conversationList` omits child conversations. Result notifications are not sent for children; their Needs-you notices are.

## Owner API

All routes are under `/api/s16/client`, authenticated, no-store, with CSRF rechecked after the body.

| Route | Body / result |
| --- | --- |
| `GET /bots` | `s16-client-bots/v1`: `bots`, pending `proposals`, `selections`, `resources`, `creation` |
| `GET /bots/:id` | `s16-client-bot/v1`: `bot`, recent `conversations`, archive `impact` (`running`, `routines`) |
| `GET /bots/:id/export` | `s16-bot-export/v1`: `name`, `responsibility`, `model {provider, modelId, effort} \| null`, `excluded [{id,label}]`, `assignments`, `exportedAt` |
| `POST /bots/proposals` | `{ draft: s16-bot-draft/v1 }` → proposal (201) |
| `POST /bots/imports` | `{ export: s16-bot-export/v1 }` → proposal with `missing` (201) |
| `POST /bots/:id/duplicate` | `{ name }` → proposal (201) |
| `POST /bots/commands` | `s16-bot-command/v1` → `s16-bot-receipt/v1` (`bot`, `proposal`, `stopped`, `paused`) |

Commands: `bot.accept {proposalId, proposalHash}`, `bot.dismiss {proposalId}`, `bot.update {botId, expectedRevision, name, responsibility, selection, assignments}`, `bot.archive {botId, expectedRevision}` (`bot_main_required` for the main Bot), `bot.restore {botId, expectedRevision}`, `conversation.bind {conversationId, botId}` (`conversation_bot_fixed` once started or bound elsewhere).

Bootstrap adds `bots [{id, name, main, state}]` and `conversations[].botId`; the conversation snapshot adds `botId`.
