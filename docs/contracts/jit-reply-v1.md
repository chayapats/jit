# BOT01 Jit reply and persona contracts, v1

Owner: Jit #92 (S09 BOT01). Status: implemented on the issue branch. Spec: [S09](../specs/S09-main-bot-and-chat-first-ui.md) (S09-D01, D02, D07, S09-AC01). Decisions: [ADR 0029](../adr/0029-jit-conversation-and-role-proposals.md) for replies, persona and structured output, and [ADR 0028](../adr/0028-progressive-enhancement-browser-assets.md) for the script, SSE and CSP. Requirements: FR-10, FR-13, FR-15, FR-17, FR-19, NFR-05, NFR-07, NFR-10.

Uses `app.conversation/v1`, `jobs.queue_admission/v1`, `jobs.attempt_fence/v1` and `app.run_port/v1` without changing them.

| Contract | Public entry and behavior |
| --- | --- |
| `app.jit_reply/v1` | `src/team/jit-reply.ts`. Inside the owner's `message.send` transaction, `admitJitReply` writes exactly one `jit_replies` row per owner message (`message_id` is unique). It either admits one `team.jit-reply` interactive job through the queue, or records why not: `no_route`, `scheduler_unavailable`, `queue_full` or `context_too_large`. The message commits in both cases. A replayed request id returns the original receipt and never reaches admission, so a duplicate request, a refresh or a stream reconnect cannot admit another reply. The run gets trusted operator lines (product policy plus the persona), the Jit role's responsibility, and an untrusted manifest of recent topic messages that ends with the owner's message. It gets no tools. A result commits only through the attempt fence: one output source attributed to the coordinator role and run, plus one topic message. A stopped, superseded or expired attempt cannot commit. Read models: `Application.replies(actor, projectId, topicId, messageIds)` returns replies that answer, or were committed as, any of the given messages, keyed by owner message id. `Application.replyStream(actor, projectId, topicId, cursor)` returns the replies of the topic whose persisted state changed after `cursor`, in cursor order. Command: `{ kind: "jit.reply.stop", requestId, projectId, expectedRevision, payload: { replyId } }` returns `{ reply }`. |
| `app.persona/v1` | `src/persona.ts`, schema 25 `persona_revisions`. `Application.persona(actor)` returns `{ addressAs, language: "th" \| "en", selfReference, particle: "khrap" \| "kha" \| "none", personality: "calm" \| "direct" \| "friendly", aboutMe, revision, updatedAt }`. The defaults are revision 0. `{ kind: "persona.set", requestId, projectId: null, expectedRevision, payload }` appends one immutable revision and returns `{ persona }`. It is revisioned (`stale_revision`), idempotent by request id (`request_id_conflict`), validated (`invalid_persona`: exact keys, enums, length bounds, and single-line `addressAs`/`selfReference`), audited and refused during upgrade or restore fences. HTTP: `GET /settings` (section `#persona`), `POST /settings/persona` (form → 303 `/settings#persona`), and `GET`/`POST /api/settings/persona` (JSON, CSRF header). No work definition, adapter or result path writes the persona. |

## Reply states

`JitReplyView.state` is derived from the persisted record and its job, never from adapter memory.

| State | Meaning | `nextAction` |
| --- | --- | --- |
| `thinking` | The job is queued or running. `progress` is the latest provisional adapter text, labelled unsaved. | — |
| `answered` | The fenced result committed. `replyMessageId` and `source` name the reply. | — |
| `blocked` | The job waits on the same route (`quota`, `needs_login`, `route_unavailable`) or was interrupted. The route, budget and billing stay the same. | `wait_for_quota_then_resume`, `sign_in_to_route_then_resume`, `check_route_then_resume`, `resume_or_send_again` |
| `stopped` | The owner stopped it. A late result is rejected. | `send_again` |
| `failed` | The output was malformed or empty, or the adapter failed. No reply message exists. | `send_again` |
| `not_admitted` | No job was admitted, for the recorded reason. | `configure_jit_route`, `start_service_then_send_again`, `wait_then_send_again`, `send_a_shorter_message` |

Stop expects the reply `revision`: 1 from admission until a result commits, then 2. Only `thinking` and `blocked` replies can be stopped (`reply_not_stoppable`). Stop runs the job's own `job.stop`, so authority is fenced before cancellation is requested.

Resuming a blocked reply uses the existing `job.resume` from the job page. It follows the shared contract: the waiting attempt's managed context must be reconciled first. It gets a fresh run id and context on the same route. Reply limits cover the first attempt and two retries; every attempt reserves its own token share.

## Structured output

`normalizeJitReply` applies these rules to untrusted model text:

- A JSON object, optionally inside one fenced json block, must carry a non-empty string `reply`.
- Every other field, and every entry of `proposals`, is discarded. BOT01 supports no proposal kinds. Each discarded item is recorded as evidence, `field:<name>` or `proposal:<kind>`. Names are reduced to safe identifiers, so model text is never copied, and at most 8 are kept, with the total counted.
- Text that does not start with `{` or `[` is prose.
- Anything else is `malformed` or `empty` and produces no message.

The discarded list appears in the job evidence and in the reply's message details. Job evidence is a language-neutral code line, for example `jit-reply · fixture · answered · discarded 2 (field:persona, proposal:role) · tools none · reply <id>`. The stored job purpose matches `system.jit_reply_purpose`, so job pages translate it. The worker is internal and is never offered as a generic start form.

## Topic history and trust

The manifest holds up to `TeamPolicy.sourceLimit` recent messages in the topic, oldest first, inside the run's byte budget. Only the owner's own messages and Jit's committed replies are history. The manifest leaves out:
- specialist outputs, which BOT04 cites separately;
- unavailable sources;
- every source whose lineage an owner forget suppressed.

Jit replies never receive memory claims, so their outputs are never memory-derived.

Each reply records the sources its manifest cites (`jit_reply_sources`, identities only) and its output source (`jit_replies.reply_source_id`). When the owner forgets a claim, `app.memory_suppression/v1` follows this lineage forward. Every Jit reply output that was given the forgotten source, directly or through an earlier reply, joins the suppressed lineage (`memory_suppressed_sources`, and through its trigger the lifecycle ledger). Pending replies that cite any of them are fenced in the same transaction, and their contexts are listed for retirement. A walk beyond 20,000 replies fails closed (`memory_forget_too_broad`). A reply's currentness check also rejects suppressed sources, so a result that races a forget cannot commit. One trusted operator line lists the service-recorded speakers (`owner` or `assistant`). Topic text never enters operator lines. A Jit reply is appended with the next message sequence but does not change the topic revision. The topic revision counts owner changes, so a composer rendered while Jit was thinking stays valid.

Records live in `team_runs.record_json` with `kind: "jit_reply"`. Like specialist and synthesis runs, they are therefore covered by data deletion (manifest scrubbing and output redaction), by memory correction and suppression fencing (`request.manifest`), by restore ledger replay and by backups. `jit_replies` holds identities and a reason code only, never text.

## Web

- **Topic page.** Owner messages that have no committed reply are followed by a reply card. Its refresh link and the stop redirect use `?after=<owner sequence − 1>`, so they open the page that holds the card. If the committed answer falls on a later page, the owner message is followed by a link to it (`#message-<id>`). A reply on a page whose owner message is on an earlier page is still labelled as Jit's, resolved through `jit_replies.reply_message_id`. The card has the Jit mark (its dot breathes only under `data-state="thinking"`), a status pill with text, provisional progress labelled unsaved, the next action, a stop form when the reply is stoppable, a job link when blocked, and a refresh link. Committed replies render as `message--jit` with the label "จิต"/"Jit", plus "ตัวอย่างจำลอง"/"Fixture" for scripted runs. The composer sends with the normal form post.
- **Stream.** `GET /projects/:p/topics/:t/events` returns `text/event-stream`, authenticated and project-scoped like every read. The cursor comes from `Last-Event-ID`, or `?cursor`, or 0; the page passes the highest cursor it rendered. Every reply-affecting change moves that reply's cursor to the end of an installation-wide order: admission, a progress or result write, a stop, and every update of the reply's job (the schema 25 `jit_reply_job_change` trigger), so transitions the queue makes alone, such as a stop from the job page, a deadline or a budget rejection, are included. Each tick sends the changed replies in cursor order, at most one page per tick and only when a reply's data changed since the last send. Each event's `id` is the cursor of its own change, so a reconnect resumes right after the last delivered event. Event data holds persisted state, the committed text when answered, and labels already localised by the server. The stream closes after a bounded number of ticks; `EventSource` then reconnects with `Last-Event-ID`. It never admits, resumes or reconnects work. A keep-alive comment covers the 15 s server idle timeout.
- **`app.js`.** The script adds three things:
  - Enter submits the composer through its own form. Shift+Enter inserts a new line, and an IME composition such as Thai input is never interrupted.
  - On a topic with a live reply, it opens the stream and updates the reply card with `textContent` only. It drops the stop form when the reply finishes and closes the stream when no reply is live.
  - Without the script, the card and its refresh link show the same persisted state.
- **Stop.** `POST /projects/:p/topics/:t/replies/:r/stop` (form → 303 back to `#reply-:r`; JSON under `/api/`).
- **Settings.** The persona form is in `/settings#persona`.

All labels are dictionary keys (`jit.*`, `reply.*`, `topic.send_message`, `topic.jit_replies_note`, `topic.composer_keys`, `settings.persona*`, and the new `error.*` codes) in Thai and English.

## Schema

Schema 25 adds the `jit_reply_job_change` trigger on `jobs`, `jit_reply_sources` (reply_id, project_id, source_id, revision, generation; indexed by source), `persona_revisions` (revision, record_json, created_at) and `jit_replies` (id, project_id, topic_id, message_id unique, run_id unique or NULL, reply_message_id and reply_source_id unique or NULL, set when the reply commits, reason, cursor unique, created_at; exactly one of run_id and reason). Both tables are classified `include` for backups. Existing installations need the owner-authorized staged upgrade (`ops.schema_migrations/v1`).

## Evidence

`tests/jit-reply.test.ts` uses a scripted host and a fake clock. No test calls paid inference. It covers:

- **Normal reply.** One message gets one reply, committed as an attributed output source, with the persona in operator lines, history in the manifest only and no tools. A duplicate request, a page refresh and stream reconnects admit nothing new.
- **Stream cut midway.** Progress stays provisional, the failure is shown and no reply is written.
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
- **`app.js` contract.** Fake `EventSource`, `textContent` only, and stream close.

`tests/web-ui.test.ts` checks Enter, Shift+Enter and IME composition.

## Channels

`message.send` is accepted from the Web only, as before. Telegram project commands do not send topic messages, so this slice adds no Telegram admission and delivers no reply to Telegram.
