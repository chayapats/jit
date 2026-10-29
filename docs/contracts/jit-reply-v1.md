# Jit reply v2 and persona v1 contracts

Owner: Jit #92 (S09 BOT01). Status: implemented on the issue branch. Spec: [S09](../specs/S09-main-bot-and-chat-first-ui.md) (S09-D01, D02, D07, S09-AC01). Decisions: [ADR 0029](../adr/0029-jit-conversation-and-role-proposals.md) for replies, persona and structured output, and [ADR 0028](../adr/0028-progressive-enhancement-browser-assets.md) for the script, SSE and CSP. Requirements: FR-10, FR-13, FR-15, FR-17, FR-19, NFR-05, NFR-07, NFR-10.

STR01 #174 upgrades `app.jit_reply/v1` to `app.jit_reply/v2` and delivers [web.reply_stream/v2](web-reply-stream-v2.md) under confirmed S12-D02 (NFR-05, NFR-10, NFR-11). The filename stays stable for downstream links. Persona, command receipts, sources, job admission and attempt fencing are unchanged. No schema migration.

Uses `app.conversation/v1`, `jobs.queue_admission/v1`, `jobs.attempt_fence/v1` and `app.run_port/v1` without changing them.

| Contract | Public entry and behavior |
| --- | --- |
| `app.jit_reply/v2` | `src/team/jit-reply.ts`. Inside the owner's `message.send` transaction, `admitJitReply` writes exactly one `jit_replies` row per owner message (`message_id` is unique). It either admits one `team.jit-reply` interactive job through the queue, or records why not: `no_route`, `scheduler_unavailable`, `queue_full` or `context_too_large`. The message commits in both cases. A replayed request id returns the original receipt and never reaches admission, so a duplicate request, a refresh or a stream reconnect cannot admit another reply. The run gets trusted operator lines (product policy plus the persona), the Jit role's responsibility, and an untrusted manifest of recent topic messages that ends with the owner's message. It gets no tools. A result commits only through the attempt fence: one output source attributed to the coordinator role and run, plus one topic message. A stopped, superseded or expired attempt cannot commit. Read models: `Application.replies(actor, projectId, topicId, messageIds)` returns replies that answer, or were committed as, any of the given messages, keyed by owner message id. `Application.replyStream(actor, projectId, topicId, cursor, limit?)` returns the replies of the topic whose persisted state changed after `cursor`, in cursor order. The optional positive integer limit may narrow the configured page size; SSE requests one row per transport demand. Command: `{ kind: "jit.reply.stop", requestId, projectId, expectedRevision, payload: { replyId } }` returns `{ reply }`. |
| `app.persona/v1` | `src/persona.ts`, schema 25 `persona_revisions`. `Application.persona(actor)` returns `{ addressAs, language: "th" \| "en", selfReference, particle: "khrap" \| "kha" \| "none", personality: "calm" \| "direct" \| "friendly", aboutMe, revision, updatedAt }`. The defaults are revision 0. `{ kind: "persona.set", requestId, projectId: null, expectedRevision, payload }` appends one immutable revision and returns `{ persona }`. It is revisioned (`stale_revision`), idempotent by request id (`request_id_conflict`), validated (`invalid_persona`: exact keys, enums, length bounds, and single-line `addressAs`/`selfReference`), audited and refused during upgrade or restore fences. HTTP: `GET /settings` (section `#persona`), `POST /settings/persona` (form → 303 `/settings#persona`), and `GET`/`POST /api/settings/persona` (JSON, CSRF header). No work definition, adapter or result path writes the persona. |

## Reply states

`JitReplyView.state` is derived from the persisted record and its job, never from adapter memory.

| State | Meaning | `nextAction` |
| --- | --- | --- |
| `thinking` | The job is queued or running. `progress` is null. Active attempts may publish a separate memory-only SSE snapshot, labelled unsaved. | — |
| `answered` | The fenced result committed. `replyMessageId` and `source` name the reply. | — |
| `blocked` | The job waits on the same route (`quota`, `needs_login`, `route_unavailable`) or was interrupted. The route, budget and billing stay the same. | `wait_for_quota_then_resume`, `sign_in_to_route_then_resume`, `check_route_then_resume`, `resume_or_send_again` |
| `stopped` | The owner stopped it. A late result is rejected. | `send_again` |
| `failed` | The output was malformed or empty, or the adapter failed. No reply message exists. | `send_again` |
| `not_admitted` | No job was admitted, for the recorded reason. | `configure_jit_route`, `start_service_then_send_again`, `wait_then_send_again`, `send_a_shorter_message` |

Stop expects the reply `revision`: 1 from admission until a result commits, then 2. Only `thinking` and `blocked` replies can be stopped (`reply_not_stoppable`). Stop runs the job's own `job.stop`, so authority is fenced before cancellation is requested.

Resuming a blocked reply uses the existing `job.resume` from the job page. It follows the shared contract: the waiting attempt's managed context must be reconciled first. It gets a fresh run id and context on the same route. Reply limits cover the first attempt and two retries; every attempt reserves its own token share.

## Structured output

`normalizeJitReply` (implemented by `parseReply`, `src/team/reply-format.ts`) accepts this bounded UTF-8 grammar:

~~~~text
<non-empty reply prose>
```jit-proposals
{"version":2,"proposals":[<existing typed proposal entries>]}
```
~~~~

- The trailer is optional. Only the unindented line-start opener of exactly three backticks plus `jit-proposals` is reserved (no spaces or other info-string characters). A valid trailer is that opener, LF or CRLF, a JSON object with `version: 2` and array `proposals`, LF or CRLF, then exactly three closing backticks and end of output; trailing whitespace is allowed. An exact opener at EOF is a truncated trailer. Everything from the first exact opener onward is metadata, including any subsequent prose or code. There is at most one trailer. Leading/trailing prose whitespace is trimmed as before. All other fences remain prose verbatim: unlabelled, `js`, `ts`, `json`, tilde, indented, inline and lookalikes such as `jit-proposalsX`. Normal Markdown code fences are fine and use the existing code presentation.
- A malformed, truncated, wrong-version, unrecognised or repeated trailer, non-array `proposals`, or content after the closing fence discards the entire trailer as `field:proposals`. Valid preceding prose can still commit. Empty prose fails as `empty`; malformed legacy JSON, ill-formed Unicode and byte overflow fail as `malformed`. Neither failed output nor metadata becomes message text.
- Version 2 is required on trailers. Unknown keys other than `version` and `proposals` are discarded as `field:<safe identifier>`. Each entry of `proposals` is offered to the handler registered for its `kind`; an entry without a handler, or one its handler declines, is discarded. BOT01 registered no kinds; BOT03 registers `role` ([app.role_proposals/v1](role-proposals-v1.md)). Each discarded item is recorded as evidence, `field:<name>` or `proposal:<kind>`. Names are reduced to safe identifiers, so model text is never copied, and at most 8 are kept, with the total counted. BOT04 registers `dispatch` on replies to owner messages ([app.dispatch_allowance/v1](dispatch-allowance-v1.md)): one well-formed `{"kind": "dispatch", "roles": [names]}` entry whose names are lookup keys only and are never stored; a second dispatch entry is discarded, and a team reply registers no kinds. REL03 ([app.routing_selection/v1](routing-selection-v1.md)) extends the entry to the closed schema `{"kind": "dispatch", "roles": [names], "why"?: string}` (`why` at most 160 characters), and registers no `dispatch` kind on a reply whose specialists a fixed rule already chose at admission; that run gets one operator line naming the rule and the chosen specialists instead of the dispatch offer. BOT05 registers `promotion` only on replies to owner messages in an open General space topic ([app.topic_promotion/v1](topic-promotion-v1.md)): one `{"kind": "promotion", "name": string}` entry; its instruction sentence joins an existing operator line, so the operator line count is unchanged. COMM01 registers `task` on replies to owner messages ([task suggestion](communication-policy-v2.md#task-suggestion-s12-d05)): one `{"kind": "task", "title": string, "summary": string}` entry that only pre-fills the owner's task form. COMM04 registers `suggestions` on replies to owner messages ([reply chips](#s12-comm04-reply-chips)): one `{"kind": "suggestions", "replies": [string]}` entry.
- For one transition release, legacy `{ "reply": string, "proposals"?: [...] }`, optionally wrapped in one whole-output json or unlabelled fence, still uses the v1 parser rules and the same handlers. A whole-output fence is legacy only if its content parses as a non-array object with a string `reply`; otherwise it remains prose, including malformed JSON examples. Raw output beginning with `{` or `[` retains the strict legacy parser. Every legacy field except `reply`/`proposals` is discarded. A possible legacy envelope is withheld while streaming until it can be ruled out; legacy output appears only after successful parsing and fenced commit.
- Output is bounded by the existing attempt output byte ceiling (currently at most 4,096 bytes including metadata). Discard evidence retains at most eight safe codes and counts all dropped entries. Proposals have no authority; accepted handlers still use the existing owner-controlled paths.

The discarded list appears in the job evidence and in the reply's message details. Job evidence is a language-neutral code line, for example `jit-reply · fixture · answered · discarded 2 (field:persona, proposal:role) · tools none · reply <id>`. The stored job purpose matches `system.jit_reply_purpose`, so job pages translate it. The worker is internal and is never offered as a generic start form.

## Topic history and trust

The manifest holds up to `TeamPolicy.sourceLimit` recent messages in the topic, oldest first, inside the run's byte budget. Only the owner's own messages and Jit's committed replies are history. The manifest leaves out:
- specialist outputs, which BOT04 cites separately;
- unavailable sources;
- every source whose lineage an owner forget suppressed.

Jit replies never receive memory claims, so their outputs are never memory-derived. Since REL05 every reply carries `manifest.context` with an `app.context_packet/v1` packet ([context-packet-v1](context-packet-v1.md)): the owner's message (and a team reply's results) as the current request, every live owner decision pinned, current tasks, and older topic messages as recent messages; summary and claims are withheld. Its `recordId` is the reply id, because the reply record holds the request. Pinned decisions that alone exceed the reply's room record `context_too_large`; while the project has live decisions, the next action is `review_pinned_decisions`. A decision accepted or superseded while a reply is pending fences the reply (`superseded`).

Each reply records the sources its manifest cites (`jit_reply_sources`, identities only) and its output source (`jit_replies.reply_source_id`). When the owner forgets a claim, `app.memory_suppression/v1` follows this lineage forward (`forgetLineage`, `src/memory/lineage.ts`), together with the manifests other producers record: specialist results and role previews (`team_runs`, output in the record's `source`), discussions, and coordinator syntheses (`coordinator_syntheses`, output in the decision proposal source). Every output that was given the forgotten source, directly or through an earlier output of any producer, joins the suppressed lineage (`memory_suppressed_sources`, and through its trigger the lifecycle ledger). The forget records that final set first; only then does it fence, in the same transaction, every pending run that cites a suppressed source, every extraction of a suppressed source in each project that owns one, and the work that admitted a withdrawn claim. The native contexts of fenced jobs are listed in `suppression.contexts`, and the ledger stays incomplete until they retire (#110). A walk beyond 20,000 producer runs fails closed (`memory_forget_too_broad`). A reply's currentness check also rejects suppressed sources, so a result that races a forget cannot commit. One trusted operator line lists the service-recorded speakers (`owner` or `assistant`). Topic text never enters operator lines. A Jit reply is appended with the next message sequence but does not change the topic revision. The topic revision counts owner changes, so a composer rendered while Jit was thinking stays valid.

Records live in `team_runs.record_json` with `kind: "jit_reply"`. Like specialist and synthesis runs, they are therefore covered by data deletion (manifest scrubbing and output redaction), by memory correction and suppression fencing (`request.manifest`), by restore ledger replay and by backups. `jit_replies` holds identities and a reason code only, never text.

## Web

- **Topic page.** Owner messages that have no committed reply are followed by a reply card. Its refresh link and the stop redirect use `?after=<owner sequence − 1>`, so they open the page that holds the card. If the committed answer falls on a later page, the owner message is followed by a link to it (`#message-<id>`). A reply on a page whose owner message is on an earlier page is still labelled as Jit's, resolved through `jit_replies.reply_message_id`. The card has the Jit mark (its dot breathes only under `data-state="thinking"`), a status pill with text, provisional progress labelled unsaved, the next action, a stop form when the reply is stoppable, a job link when blocked, and a refresh link. Committed replies render as `message--jit` with the label "จิต"/"Jit", plus "ตัวอย่างจำลอง"/"Fixture" for scripted runs. The composer sends with the normal form post.
- **Stream.** `GET /projects/:p/topics/:t/events` is the authenticated, project/topic-scoped [web.reply_stream/v2](web-reply-stream-v2.md). Successful store commits wake the stream; adapter deltas wake it independently. Durable `reply` events retain numeric `id`/`Last-Event-ID` replay. Memory-only `reply-preview` events have no `id`, carry an attempt id, sequence and replacement prose snapshot, and never advance the durable cursor. Reconnect replays durable changes and replaces any local draft with the current active snapshot; it never admits/resumes work. Slow clients coalesce snapshots and pause durable replay until transport demand returns.
- **`app.js`.** Composer Enter/Shift+Enter/IME behavior is unchanged. A preview is rendered only in a thinking reply placeholder, through `textContent`, with the unsaved label and a breathing dot after the last character. Ten seconds without an active attempt delta changes the label to still-working; the next delta clears it. A retry or a new model turn after a tool starts resets its preview. A committed reply replaces the draft in the same slot, and the unsaved line becomes the saved line. Stop, failure or block clears the draft using the existing state/next action. The view follows the stream only while the owner is at the bottom. One polite status line announces phase changes, never tokens. A routine reconnect keeps the draft. A gap longer than 3 s dims it and shows the localised reconnect hint beside Refresh, and a stream that will not retry points to Refresh. A draft no snapshot confirms after reconnecting is cleared. The script closes the stream when no reply is live. Details: [web.reply_stream/v2](web-reply-stream-v2.md#owner-experience-and-no-script).
- **No script.** Status, Stop and Refresh remain ordinary HTML/forms. Provisional text is absent from page reads and durable read models. Reload after commit renders the same attributed Jit message and existing proposal cards.
- **Stop.** `POST /projects/:p/topics/:t/replies/:r/stop` (form → 303 back to `#reply-:r`; JSON under `/api/`).
- **Settings.** The persona form is in `/settings#persona`.

All labels are dictionary keys (`jit.*`, `reply.*`, `topic.send_message`, `topic.jit_replies_note`, `topic.composer_keys`, `settings.persona*`, and the new `error.*` codes) in Thai and English.

## Schema

Schema 25 adds the `jit_reply_job_change` trigger on `jobs`, `jit_reply_sources` (reply_id, project_id, source_id, revision, generation; indexed by source), `persona_revisions` (revision, record_json, created_at) and `jit_replies` (id, project_id, topic_id, message_id unique, run_id unique or NULL, reply_message_id and reply_source_id unique or NULL, set when the reply commits, reason, cursor unique, created_at; exactly one of run_id and reason). Both tables are classified `include` for backups. Existing installations need the owner-authorized staged upgrade (`ops.schema_migrations/v1`).

## Evidence

`tests/jit-reply.test.ts` uses a scripted host and a fake clock. No test calls paid inference. It covers:

- **Normal reply.** One message gets one reply, committed as an attributed output source, with the persona in operator lines, history in the manifest only and no tools. A duplicate request, a page refresh and stream reconnects admit nothing new.
- **Stream cut midway.** Deltas stay in memory only, the failure is shown and no reply is written.
- **Structured output.** Malformed output, discarded fields and proposals, and nothing reaching configuration.
- **Quota.** A quota block shows the next action on the same route and budget, and resume continues on that route.
- **Stop.** A no-script stop and a late complete result from an adapter that ignores cancellation: the result is fenced.
- **Injection.** Topic history that claims to change the persona or role has no effect.
- **Persona command.** Validation, replay, stale revisions, audit, form and JSON with CSRF, and revision history.
- **No script.** A form-post flow in Thai and English, including a queue that is not available.
- **No coordinator route.**
- **SSE.** Cursor replay, reconnect after the answer, authentication and scope.
- **Reopen.** Reopening the store gives identical reply views and page HTML.
- **Queue-only transitions.** A stop from the job page and a queued deadline reach the stream. Per-change event ids let a resumed stream deliver the rest of a batch. 25 live replies stream with a fixed URL, across several pages of changes.
- **Pagination.** Page-boundary links and Jit labels work without script.
- **Internal worker.** It has no generic start form, and English job pages show an English purpose.
- **Discussion discovery.** Discussions are still found after many reply runs (`listDiscussions` filters kind and topic before its limit).
- **Forget lineage.** A forget suppresses the source, the reply that copied it and a later reply that copied that reply, and keeps all of them out of later history. A forget during a running reply fences it, so its late result never commits. Specialist outputs stay out of history.
- **`app.js` contract.** Fake `EventSource`, `textContent` only, snapshot sequencing, phase announcements, follow-at-bottom, stall, routine/long/closed reconnects, stale-draft clearing, in-place terminal replacement and stream close.
- **STR01.** `tests/reply-format.test.ts` covers the v2/legacy parser matrix, every fence split, Unicode and overflow. `tests/web-reply-stream.test.ts` uses a fake clock for <=100 ms push delivery, the 10 s watchdog, reset, coalescing, replay, connection limits, abort/expiry and rollback-safe notifications. Integration tests cover adapter-to-SSE deltas, unchanged receipts and attribution, ignored cancellation/expired leases and no-script v2 rendering.

`tests/web-ui.test.ts` checks Enter, Shift+Enter and IME composition.

## Channels

`message.send` is accepted from the Web only, as before. Telegram project commands do not send topic messages, so this slice adds no Telegram admission and delivers no reply to Telegram. Since REL04 ([delivery.attention_levels/v1](delivery-attention-levels-v1.md)), a reply that dispatches specialists opens a work group (`workGroupId` on the reply, discussion and team reply records) that notifies once through the delivery outbox; a reply without a dispatch still creates no intent.

## S10 REL02 additions

The product policy line of every Jit reply and team reply ends with the [team communication policy](communication-policy-v2.md) line, and each reply record stores `policyVersion`. A team reply's `gaps` include blocked, failed and incomplete specialist results (`result_<status>`); a blocked gap keeps the specialist `runId`, and the reply view reads its unblock action from that run record ([app.specialist_results/v2](specialist-results-v1.md#v2-appspecialist_resultsv2)). The unblock text never enters an operator line.

## S12 COMM01 additions

[`app.communication_policy/v2`](communication-policy-v2.md) adds Jit's short chat voice, and records store `policyVersion: 2`. A message reply's operator lines are, in order: the marker; the product policy line (untrusted-data rule, output format, communication policy); one proposal-kinds line naming every optional entry the reply may return (role, then promotion in an open General space topic, MCP install at access `workspace` or above, and task); the configured-routes line; the persona line and its optional about-me line; the dispatch or fixed-rule line; and the speakers line. Before COMM01 the promotion and MCP sentences sat on the policy line and the role sentence had its own line; tests match lines by content, so the move changes no behavior. A team reply keeps the marker, its prose-only policy line with the communication policy, the persona, its results line and the speakers line. `JitReplyView` gains `taskSuggestion` (the answered reply's suggestion or null), and data deletion of a reply's output removes it.

## S12 COMM04 reply chips

Jit #185 (S12-D08). Under Jit's newest answer the page shows 2–3 suggested replies as buttons. A tap posts exactly that text as the owner's next message through the existing `message.send` form route, as if the owner had typed it. Additive on `app.jit_reply/v2`; `app.conversation/v1` `message.send` is unchanged.

**Schema.** At most one proposals entry, with exactly the keys `kind` and `replies`:

```json
{"kind": "suggestions", "replies": ["...", "..."]}
```

`replies` has 1 to 3 strings (`suggestionLimit`). Each, after `.trim()`, is non-empty, at most 80 code points (`suggestionChars`, `Array.from(s).length`), well-formed, free of control characters (`U+0000`–`U+001F`, `U+007F`), and distinct from the others. `parseSuggestions` returns the trimmed strings or null. Anything else, and a second entry, is discarded as `proposal:suggestions`; the reply text still commits. Only replies to owner messages register the handler and get `suggestionsInstruction` on their proposal-kinds line; a team reply discards the entry.

**Record and view.** On commit the record stores `suggestions`. `JitReplyView.suggestions` is that list on an `answered` reply and `[]` in every other state, including `not_admitted`. Job evidence appends ` · suggestions <n>`; suggestion text never enters evidence, logs or notifications. Data deletion of the reply's output removes the list.

**Rendering rules.** `replyChips` renders `<div class="reply-chips" role="group" aria-label="ตอบต่อแบบเร็ว" / "Quick replies">` with one form per suggestion: `method="post" action="/projects/:p/topics/:t/messages"`, the same hidden CSRF token, a fresh request id and the topic revision the composer uses, a hidden `text` with the escaped suggestion, and `<button class="chip">` with the escaped suggestion. Chips render only when all of these hold:

- (a) the reply is `answered` and has suggestions;
- (b) it is the newest answer on the last page (`!hasMore`, its `replySequence` is the largest committed reply sequence) and answers the owner's newest message on the page;
- (c) no reply on the page is live (`thinking` or `blocked`; COMM03 will add `queued`);
- (d) the reply carries no `proposed` role or promotion proposal, no task suggestion, no MCP install card and no dispatch card;
- (e) the topic is not a promoted origin;
- (f) the topic has no pending approval card.

`chipsAllowed(view, { dispatchCard, mcpCard, promoted, approvalPending })` implements (a) and (d)–(f) for both the page and the stream. A chip never grants, approves or configures anything: the resulting message is an ordinary owner message, and Jit answers it like any other.

**Stream.** The durable `reply` event gains `suggestions`: the chips that rules (a) and (d)–(f) allow at event time, otherwise `[]`. A thinking or blocked reply to the owner's newest message on the last page (not a team reply, no promotion, no pending approval) is followed by a hidden `data-reply-chips="<reply id>"` slot of three ready chip forms, each with its own request id. When that reply's event answers with suggestions and no reply card is live any more, `app.js` fills the slot through `value` and `textContent`, removes spare forms and unhides it. Without script the slot stays hidden and a reload renders `replyChips`.

**Evidence.** `tests/jit-reply.test.ts`: the schema cases, normalization discards, escaping and evidence, the no-script chip post (303, the owner message, a new answered reply), visibility under newer messages, live replies, role and task cards and invalid entries, `chipsAllowed` for dispatch, MCP, promotion and approval, the stream payload with the `app.js` slot contract, and deletion. `tests/dispatch-allowance.test.ts`: team replies discard the entry and get no instruction, and a dispatching reply shows no chips. `tests/chat-voice.test.ts`: the instruction fits the worst-case operator lines.

