# APP02 conversation and source contracts, v1

Owner: Jit #4. Status: implemented on this issue branch; downstream eligibility requires the reviewed artifact in its integration base. Extends APP01 at merge commit `25c5778fb68c0c99827bf7753c0a3c267931ce43`. No Schway, provider, Telegram, memory or live-host capability is claimed.

| Contract | Entry and behavior |
| --- | --- |
| `app.topic_commands/v1` | `Application.execute(actor, CreateTopicCommand)` → `TopicReceipt`; `topic.create` includes `requestId`, explicit `projectId`, current project `expectedRevision`, `payload: {title}`. Atomically creates a stable topic/source under the project's existing group and advances project revision. Same names are allowed and never resolve identity. |
| `app.conversation/v1` | `Application.execute(actor, SendMessageCommand)` → `MessageReceipt`; `message.send` includes `requestId`, explicit `projectId`, current topic `expectedRevision`, `payload: {topicId,text}` (REL03 adds an optional `replyTo: {discussionId, roleId}` naming the participation the owner answers; it is part of the receipt identity only when present, see [app.routing_selection/v1](routing-selection-v1.md)). Atomically appends literal owner text with UUID, project/topic IDs, owner attribution, commit time, monotonic topic sequence and exact source reference. Advances topic revision. `topics(actor, projectId, after?)` and `conversation(actor, projectId, topicId, after?)` return bounded committed pages plus current aggregate/revision. |
| `app.source_records/v1` | `Application.source(actor, projectId, SourceReference)` → `SourceLookup`. Reference is `{sourceId,revision,generation}`; result carries explicit project, exact reference, current pointer/availability and either exact immutable content/provenance or an unavailable reason. The low-level trusted transaction ports `commitOutputSource` and `registerExternalSource` in `src/sources.ts` store participant/run-attributed immutable output or an external descriptor. Their caller must already authorize the producer and scope; no HTTP write route exposes them. |

`Topic`, `CommittedMessage`, command/receipt types and `CursorPage<T>` are exported from `src/conversation.ts`; `Attribution`, `SourceDescriptor`, `SourceReference`, `SourceCurrent`, `SourceLookup` are exported from `src/sources.ts`. Canonical records contain app identities and text, never provider wire/session objects. Human attribution is fixed by verified ingress. Output producers use `{kind:"participant",participantId,runId}`; external descriptors use service attribution. Text cannot grant permission, accept a task, configure a model or start execution.

`app.command_receipts/v1` now accepts the three application command kinds in the same `(ownerId,requestId)` namespace. Conversation identity hashes kind, explicit scope, expected revision and exact payload. Exact replay returns the original committed receipt before current-revision checks; conflicting reuse fails with `request_id_conflict`. Topic/message/source/receipt/audit changes share one `app.transaction_store/v1` commit. Actor capabilities are revalidated against current sessions inside every read or writer transaction. Malformed scope, cross-project topics, stale revisions and forged identity fields fail before mutations.

## HTTP and presentation

All routes require the APP01 owner session. POST requires exact configured Origin and session-bound CSRF (form `csrf` or JSON `X-CSRF-Token`). Only the named fields are accepted; scope comes from route identities.

| Route, with optional `/api` prefix | Behavior |
| --- | --- |
| `POST /projects/<project>/topics` | `{requestId,expectedRevision,title}` creates a topic. JSON returns receipt; form redirects to the topic. |
| `GET /projects/<project>/topics?after=0` | Bounded topic page; Web project page uses the same read. Existing `GET /api/projects/<project>` retains APP01's project response. |
| `GET /projects/<project>/topics/<topic>?after=0` | Topic and bounded ordered committed message page, including provenance/source links. |
| `POST /projects/<project>/topics/<topic>/messages` | `{requestId,expectedRevision,text}` commits one owner message. JSON returns receipt; form redirects to its bounded history page. |
| `GET /projects/<project>/sources/<source>?revision=1&generation=1` | Exact source reference; both positive integer query fields required once. No generic filesystem/URL reader or automatic fetch. |

HTML, script, Markdown links and URLs remain escaped literal data; only fenced code receives code-block presentation. CSP prohibits scripts. Canonical messages have `status:"committed"`; provisional/team progress is not stored or rendered by this slice. GET history/source operations do not create receipts, runs or memory.

The owner UI uses a neutral dark conversation layout: bounded project/topic navigation in a desktop sidebar, native expandable navigation on mobile, a central committed transcript, and a persistent bottom composer. Message provenance is available through native details/source links; exact source metadata remains inspectable on the source page. All controls use existing forms/links, including keyboard-accessible labels and a skip link. There are no placeholder model/attachment controls or browser scripts. `src/web-layout.ts` owns escaped presentation and `src/web-style.ts` supplies the local stylesheet; HTTP command/auth/CSRF contracts remain unchanged.

## Limits, availability and storage

`JIT_MESSAGE_BYTES` defaults to 4096 UTF-8 bytes, minimum 1024 (`MIN_MESSAGE_BYTES`; the same ceiling bounds PR alert payloads, whose mandatory skeleton must fit, so smaller values are rejected at config load), maximum 65536; existing body limit applies independently (default 16384). Topic titles allow 200 UTF-16 units and 800 UTF-8 bytes. Text must be well-formed Unicode and nonblank; message whitespace is preserved, title edges trimmed. Existing bounded `JIT_PAGE_SIZE` governs topics/history; queries read at most page size + 1 identities. Nonnegative safe-integer `after` is an exclusive serialized sequence cursor; response includes `hasMore` and `nextAfter`. Timestamps do not determine ordering. Configured query/body limits also cover new routes.

Source references do not retarget. Wrong project/unknown ID → `source_not_found`; generation mismatch → `generation_unavailable`; absent exact version → `revision_unavailable`; unavailable app content → `source_unavailable`; descriptor-only external source → `external_not_imported`. Unavailable results disclose no app text; external descriptor availability is not evidence of access. Registry current pointers are separate from requested versions. APP02 exposes no correction/delete/import operation; later lifecycle slices must also fence content in saved receipts and exports.

Schema v2 preserves APP01 project/owner/session/receipt state, adds sources/versions/topics/messages and enforces project/group/topic/source scope with foreign keys. Existing v0/v1 databases get a mode-0600 `.pre-v<version>-<id>.sqlite` snapshot before migration; snapshot failure rolls back migration. A frozen v1 fixture comes from the merged APP01 artifact. Migration snapshots contain private state and follow APP01's protection limitations; managed backup/restore remains OPS01/02.

Deterministic evidence in `tests/conversation.test.ts`: authenticated two-project Unicode/code/injection journey and reopen; independent-process duplicate/stale commands; scoped references and rejected identity injection; bounded cursors/limits; exact output/external/unavailable lookups without network; process death at topic/message/receipt stages; frozen-v1 upgrade. Run `bun test` and `bun run typecheck`. Actual browser evidence and reviewed/tested revision belong in the PR.
