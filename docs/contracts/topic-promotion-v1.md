# BOT05 chat-first home and topic promotion contract, v1

Owner: Jit #96 (S09 BOT05). Status: implemented on the issue branch. Spec: [S09](../specs/S09-main-bot-and-chat-first-ui.md) (S09-D05, D09, S09-AC05). Decisions: [ADR 0031](../adr/0031-general-space-and-topic-promotion.md) (General space and promotion without moving identity), [ADR 0029](../adr/0029-jit-conversation-and-role-proposals.md) (structured output carries no authority) and [ADR 0028](../adr/0028-progressive-enhancement-browser-assets.md) (every flow works without script). Requirements: FR-01, FR-05, FR-17, FR-22, FR-24, NFR-05, NFR-10.

Uses `app.general_space/v1`, `app.jit_reply/v1` and `app.memory_context/v1`. It adds a reply proposal kind and two command families. Their public behavior is otherwise unchanged.

| Contract | Public entry and behavior |
| --- | --- |
| `app.topic_promotion/v1` | `src/promotion.ts`, schema 28 `topic_promotions`. A Jit reply to an owner message in an open General space topic may carry one promotion proposal. A proposal is a list of immutable revisions with the same states and rules as a role proposal. Only `topic.promote.accept` of the current open revision promotes. Read models: `JitReplyView.promotionProposals` (`PromotionProposalView[]`, at most one) from `Application.replies`, and `Application.promotion(actor, projectId, topicId)` → `{ promotedTo, continuedFrom }`. Commands: `topic.promote.accept`, `topic.promote.revise` and `topic.promote.dismiss`. |
| Chat-first home | `chat.start` in `src/conversation.ts`, `GET /` and `POST /chats` in `src/web.ts`. A chat started from the home composer is one topic plus its first owner message, in one commit, and Jit answers it like any message. |

## Home

`GET /`, after setup is complete, renders:

- a greeting that uses the persona's `addressAs`;
- a large composer (`form#new-chat`, `POST /chats`) with a project chip, which is an ordinary `<select name="projectId">`. The chip lists the General space first and then the projects on the current workspace page. It defaults to the General space. `/?project=<id>` preselects another listed project;
- a quiet "waiting on you" strip. It lists each project that has task proposals, close reviews or resumable jobs waiting (web.settings_ia/v1 attention), in words and a number;
- the existing project list and the create-project form (`#new-project`).

`chat.start` command: `{ kind: "chat.start", requestId, projectId, expectedRevision, payload: { text } }`.

- `expectedRevision` is the workspace revision the chip was rendered from. A home page from before a project was created is `stale_revision`.
- The topic title is the text's first non-empty line, with whitespace collapsed, at most 60 characters (`…` when cut). It is a copy of owner text, so `chat_title_sources` (schema 28) records its lineage to the first message's source. Deleting that message (app.data_lifecycle/v1) treats the title as a derived copy: the title source and its receipt copies are purged with it. An owner forget (app.memory_suppression/v1) treats the message and its title as one lineage in either direction: claims from either are withdrawn as siblings, and both sources are suppressed, so neither can be extracted again. Forget's existing reach is unchanged (claims, dependents, same-source siblings and Jit-reply lineage). Specialist, role-preview and coordinator outputs that cited the raw message or title are not suppressed by a forget, and pending work on them is not fenced by it. That is true of every forgotten source today, and is left to a follow-up on app.memory_suppression/v1 (#110).
- The topic, the message, Jit's reply admission (`app.jit_reply/v1`), the receipt and the audit row commit together. A replay returns the original receipt `{ topic, message, projectRevision, topicRevision }`.
- Commands to the General space are still refused with `setup_incomplete` until setup is done (app.setup/v1).

The form path redirects (303) to the new topic at the owner's message. `POST /api/chats` takes the same fields as JSON and requires the CSRF header. The composer has the existing enhancement (Enter sends, Shift+Enter makes a new line, the field grows), but none of it is needed.

## Proposal shape

For a reply to an owner message in a General space topic that is not promoted yet, the trusted policy line adds this sentence:

```json
{"reply": "...", "proposals": [{"kind": "promotion", "name": "..."}]}
```

It is appended to the fixed policy line rather than added as a new line, because a run request holds at most 8 operator lines. Other projects, promoted topics and team replies never see the sentence and register no `promotion` handler. Their entries are discarded as `proposal:promotion`.

The `promotion` handler applies these rules to untrusted model output:

- `name` must be one line of 1–120 characters after trimming, with no control or line-separator characters. Otherwise the entry is discarded (`proposal:promotion`). So is every entry after the first.
- Every other key is dropped as `field:<safe identifier>`, for example `move`, `tasks`, `state` or `approvedBy`. At most 8 codes are kept, and the total is counted.
- The service sets the author (`jit`), the revision (1), the state (`proposed`) and the id.

Job evidence adds `· proposals promotion:1`.

## Commands

All three use the shared receipt boundary: owner actor, global request-id receipts (`request_id_conflict`), one audit row, and refusal during upgrade and restore fences. `projectId` is the General space. `expectedRevision` is the proposal revision on the card.

| Command | Payload | Effect |
| --- | --- | --- |
| `topic.promote.accept` | `{ topicId, replyId, proposalId }` | Commits, in one transaction:<br>• a new project and group, exactly as `project.create` writes one (the workspace revision moves);<br>• a new topic in that project, titled with the accepted name;<br>• the topic's first record: an identity-only external source (`system: "jit"`, `resourceType: "topic"`, `resourceId: "<originProject>/<originTopic>"`, `revisionHint: "revision <r> message <n>"`) and its message, attributed to the service `jit-promotion`;<br>• one `topic_promotions` row with the origin's exact topic revision and message sequence.<br>The proposal becomes `accepted` and records the promotion. Every other open promotion card of the same topic is closed (`superseded`, `closedBy: "promotion"`). Receipt: `{ proposal, promotion, workspaceRevision }`. |
| `topic.promote.revise` | `{ topicId, replyId, proposalId, name }` | Validates the name as the parser does but rejects instead of dropping (`invalid_promotion_command`). Marks the current revision `superseded` and appends an `owner` revision. |
| `topic.promote.dismiss` | `{ topicId, replyId, proposalId }` | Marks the current revision `rejected`. No project is created. |

Rejections:

- `promotion_proposal_not_found` (404): an unknown proposal, reply or topic, a reply in another topic, a reply that never committed, or a `projectId` that is not the General space.
- `promotion_proposal_closed` (409): the current revision is accepted, rejected or closed. Accepting again therefore never creates a second project.
- `promotion_proposal_stale` (409): `expectedRevision` is not the current revision.
- `topic_already_promoted` (409): the topic already has a continuation. `topic_promotions.origin_topic_id` is unique, so this also holds under a race.
- `promotion_topic_busy` (409): a Jit reply or a team discussion of the topic is queued, running or waiting. Its result would land after the linked revision. The owner waits or stops it first.
- `invalid_promotion_command` (400): wrong shape, extra fields, a non-positive revision or an invalid name.

A model-produced object is never a command, and topic text that looks like a proposal is only conversation.

## Read-only origin and the continuation

A promoted origin is read-only. These commands are refused with `topic_promoted` (409):

- `message.send` (from every ingress);
- `team.dispatch` and `role.preview` for that topic;
- `team.control` `include` on a discussion of that topic (exclude, skip and stop still work). A discussion of a promoted topic that settles never admits a team reply;
- `dispatch.proposal.accept` and `dispatch.answer` on its dispatch cards.

The error carries the continuation's path, and the error page links to it as "open the new topic". Dismissing a dispatch card, role proposal commands, task commands and reads stay available.

`Application.promotion(actor, projectId, topicId)` returns:

- `promotedTo`: the `TopicPromotion` (`origin { projectId, topicId, topicRevision, messageSequence }`, `target { projectId, topicId }`, `link { messageId, source }`, `replyId`, `proposalId`, `proposalRevision`, `createdAt`) plus the continuation's project name and topic title; or `null`.
- `continuedFrom`: the same promotion with the origin's project name, topic title and messages up to the linked sequence (at most 50, with `hasMore`). The messages are read live through the origin's own project. Each one is marked `jit` when it is a committed Jit reply or the setup greeting.

The topic page renders a promoted origin with a banner, a closed composer and a link to the continuation, and it hides the team dispatch form. The continuation renders its first record as a "Continued from General" (`ต่อจากทั่วไป`) block. The block is expandable and shows the linked revision, the origin messages and a link back to the origin. `GET /api/projects/:p/topics/:t` includes `promotion`.

## Identity and provenance

Nothing is moved, copied or rewritten.

- Origin sources, memory claims, tasks, jobs and dispatch records keep the General project.
- The new project holds only its own topic title (the accepted name) and the identity-only link. It holds no origin text.
- Cross-project memory reaches the new project only through the existing rules (ADR 0003, 0019, 0020). For example, a discussion in the new project may cite a General claim, scoped `cross_project` with its original project.
- An owner forget of that claim in General withdraws it from later contexts everywhere.
- Deleting origin content makes it unavailable in the continuation too, because the block reads the origin live. The promotion row itself is identity only and stays.
- Open tasks stay in General, and the owner can propose them again in the new project.

Jit's replies in the continuation read only the continuation's own history. They do not read the origin messages, so no derived copy of General content is created in the new project.

## General space protection

Schema 28 adds these triggers:

- `general_space_keep` refuses `DELETE` on `general_space`;
- `general_space_fixed` refuses a change of `general_space.id`, `project_id` or `topic_id`;
- `general_project_keep` refuses `DELETE` of the General project's `projects` row.

All three abort with `general_space_protected`. No command deletes, renames or re-kinds a project. Promotion always creates a different project: the `CHECK (project_id != origin_project_id)` constraint guarantees it, and General's id, name and group are unchanged. New chats keep landing in General.

## Storage

- Proposals live in the reply's `team_runs` record (`kind: "jit_reply"`, field `promotionProposal`).
- `topic_promotions` holds identities only: origin project, topic, topic revision and message sequence; target project and topic; link message and source; reply, proposal and revision; and the creation time. It is `include` in backup images.
- Data deletion uses the role-proposal rule (`redactPromotionProposal` wraps `redactRoleProposals`) on all three paths: lineage, quoted-copy scrub and restore ledger replay. Jit-authored names are rewritten. An open revision whose text is rewritten is closed by deletion. Owner revisions are owner configuration and stay. An accepted project's name is owner-accepted configuration in `projects`, like a role created from a role proposal.
- `promotion` snapshots in receipts follow `redactRoleProposalView`.

## Web

- **Card.** `promotionProposalCard` in `src/web-proposal-card.ts` reuses `proposalCard`. It shows the kind line, the name, a status pill in words, the revision and author, the origin topic, what accepting does (and that nothing moves), what was dropped, and a note that Jit cannot create a project.
- **Actions.** Accept, Dismiss and an Edit form post to `POST /projects/:p/topics/:t/replies/:r/promotions/:id/(accept|revise|dismiss)`. Accept redirects to the continuation at its link message. The others redirect to `#proposal-<id>`. The JSON variant under `/api/` takes the same fields and requires the CSRF header.
- **Stream.** The reply event's `proposals` count includes the promotion card.

All labels are dictionary keys (`home.*`, `promotion.*` and the new `error.*` codes) in Thai and English.

## Evidence

`tests/topic-promotion.test.ts` uses a scripted host and a fake clock. It covers:

- **Home.** No-script home → General topic → Jit's answer. Receipt replay. The chip choosing another project. A stale home page. CSRF on JSON. The waiting strip.
- **Promotion.** A promotion by form post: the exact origin revision and message sequence, the identity-only link, the continuation block, the read-only origin (message, stale form and dispatch refused), accept replay and a second accept, and no promotion offer in the new project.
- **Stale and forged.** A stale revision after an owner edit, forged ids and shapes, a reply outside General, owner text shaped like a proposal, malformed and second entries, a busy topic, sibling cards closed by promotion, and dismiss.
- **Provenance.** Claim, source and task identity after promotion. Cross-project memory with the original provenance, and a forget in General withdrawing it from the new project.
- **Deletion.** Deleting origin content after promotion: the continuation shows it unavailable, no copy exists anywhere, and the link stays. Deleting Jit's text closes an open card.
- **General space.** It cannot be deleted or re-pointed, promotion leaves it unchanged, and new chats still land there.
- **Self-review fixes.** A discussion started before promotion cannot bring a specialist back into the origin. Deleting a chat's first message also deletes its derived title, in the origin, the continuation, pages and receipts.
- **Rendering.** Thai and English pages with no raw keys and no inline script.
