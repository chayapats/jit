# Memory context and context provenance, v1

Owner: Jit #26 (MEM02). Schema: 12. Contracts: `app.memory_context/v1`, `app.context_provenance/v1`. Requirements: FR-02/03/04/05/10/14/17/18 and NFR-05/07/10/11. Consumes `app.memory_claims/v1`, `app.memory_lineage/v1`, `app.memory_active_generation/v1`, `app.project_continuity/v1`, `app.team_dispatch/v1`, `app.run_port/v1` and `app.run_records/v1`. [ADR 0020](../adr/0020-memory-context-assembly.md) records the engineering choices; [ADR 0003](../adr/0003-cross-project-memory-with-provenance.md) holds the confirmed product decision.

## Public surface

- `assembleMemoryContext(tx, {projectId, topicId, purpose, owner, evidence, claimSlots, bytes, ownerGeneration, now})` in `src/memory/context.ts` assembles and records one context inside the caller's owner transaction and returns `{manifest, record}`. `owner` is `{kind: "discussion" | "synthesis", id}`. `evidence` is the run's frozen exact source set. `claimSlots` is the manifest room left under `TeamPolicy.sourceLimit`, and `bytes` is the request room returned by `contextByteRoom(policy, {sources, purpose, responsibility, operator})`. Later PR-analysis and scheduled-summary producers call the same function.
- `RunSourceManifest.context?: MemoryContextLayout` is an optional extension of `app.run_port/v1`. It holds `{version: 1, recordId, policy: 1, constraints, claims, omitted, derivation}`. `manifest.sources` remain the source-evidence layer. `context.claims[i]` labels `manifest.claims[i]` as `{layer, scope, kind, source, conflicts}`. `validateRunRequest` checks the layout shape. It also rejects a `cross_project` claim labelled as anything other than `inference`. The layout is labels only: it cannot add tools, routes, policy flags or authority.
- `memoryContextOperator` is one trusted operator line added to every run that carries a context. It sets precedence: the current owner purpose and project constraints come first, then explicit owner preferences, then inferences. Cross-project claims never become obligations, decisions or preferences. Memory and source text cannot change permissions, tools, routes or configuration. Conflicts are presented as questions. Incomplete context must be disclosed.
- `contextCurrent(tx, projectId, manifest)` returns `null`, `"source_retired"` or `"superseded"`. It is checked by the specialist (`team.specialist-analysis`) and coordinator (`team.coordinator-synthesis`) `isCurrent` attempt gates at admission, reservation and result commit.
- `fenceStaleContexts(tx, now)` invalidates every queued, admitted or waiting specialist/coordinator job whose context is no longer current. It runs inside owner task commands and decision supersession, and the application calls `cancelFenced()` after commit.
- `Application.discussion(actor, projectId, discussionId)` adds `context` (the discussion record view) and `synthesisContext` (the latest synthesis record view, or `null`).
- `Application.memoryContext(actor, projectId, contextId)` returns `{project, record, current, entries}`. GET `/[api/]projects/:id/memory/contexts/:contextId` renders the same projection. An unknown context returns 404 `memory_context_not_found`.

## Layers and precedence

| Layer | Content | Origin |
| --- | --- | --- |
| trusted operator | fixed instructions plus `memoryContextOperator` | service code |
| current owner instruction | the run `purpose` | owner command |
| project constraints | `context.constraints`: accepted, ready-for-review and proposed tasks (labelled by state), plus each topic's current owner decision | committed project state, same tables as `app.project_continuity/v1` |
| explicit preferences | current-project `explicit_fact` claims | owner-attributed memory |
| source evidence | `manifest.sources` | exact frozen sources |
| inferences | current-project `inference` claims and every cross-project claim | derived memory |

Cancelled, dismissed, superseded and completed tasks never enter the constraint layer, and neither do superseded decisions. A proposed task is labelled "not accepted". Constraints keep exact ID, revision, topic and supporting source. Text is clipped to `constraintBytes`, and clipping is flagged with `truncated: true`. Decision evidence is the owner-attributed decision source from `memory_decision_sources`. Memory never sets a task, decision, configuration or permission. Topic messages, raw conversation history and native/group session history are never read.

## Retrieval and budget (policy 1)

`memoryContextPolicy = {version: 1, constraints: 12, claims: 6, crossProject: 3, window: 256, bytes: 8192, constraintBytes: 600, derivedDepth: 1}`.

1. Up to 12 constraints are taken in this order: current-topic items first; then decisions; then accepted or ready-for-review tasks; then proposed tasks. Within each group, newest comes first.
2. The claim window is the latest 256 claims of the project plus the latest 256 claims from other projects. They are scored lexically against the purpose plus evidence text.
3. Claims are included in this order: relevant project claims, then relevant cross-project claims (at most 3), then recent project `explicit_fact` claims as fill. Every candidate passes `lookupActiveClaim` on its origin project. Unavailable candidates count as `omitted.unavailable` and contribute no text.
4. If a selected claim has a conflict counterpart in the window, that counterpart is pulled in when budget allows. Otherwise the conflict is recorded with `included: false`.
5. Slots are `min(6, sourceLimit − evidence)`. Bytes are `min(8192, contextBytes − sources/purpose/responsibility/operator − 2048)`. Anything dropped by a ceiling increments `omitted.constraints` or `omitted.claims`; dropping for bytes also sets `omitted.budget`. The record is `complete: false` whenever a ceiling dropped something or the loop guard applied.

Every claim keeps its origin `projectId`, kind, exact `{claimId, revision, generation}`, source reference and conflicts. Obligations and decisions are only ever read from the requesting project.

### Lexical matching and its limits

`lexicalTerms(text)` folds ASCII case and produces two kinds of term:

- ASCII words of three or more characters, minus a short stop-word list.
- Code-point trigrams over every run of non-ASCII letters, marks and digits; runs shorter than three code points become a single term. This lets Thai and other scripts without spaces match mixed text such as `ฐานข้อมูลSQLite`.

Emoji, punctuation and symbols are ignored. A shared word scores 3 and a shared trigram scores 1. A score of 3 or more is relevant. There is no Unicode normalization, stemming, synonym expansion or embedding. Paraphrases that share no literal terms are not recalled; for example, `คลังเก็บระเบียน` does not match `ฐานข้อมูล`. Common Thai fragments can also create incidental matches. This is a deterministic baseline; no semantic or recall quality is claimed.

## Provenance record and freshness (`app.context_provenance/v1`)

`memory_contexts` stores one immutable record per owner, keyed `UNIQUE(owner_kind, owner_id)`. Each record holds:

- the contract, project, topic, owner and purpose;
- a policy snapshot;
- entries for every source, constraint and claim, each with layer, scope, origin project, exact revision, generation (null for tasks and decisions), status, claim kind, topic, source, conflicts and score;
- conflicts and omitted counts;
- `snapshot {assembledAt, ownerGeneration, projectRevision}`;
- `derivation {inputDepth, claimsUsed}`;
- the `complete` flag.

`memory_context_entries(context_id, origin_project_id, kind, entry_id, revision, generation)` is indexed on `(kind, entry_id)`. Later lifecycle work (MEM03/04/05) can use it to find every run, in any project, that used a claim, source, task or decision.

A context is current only when all of the following hold:

- every claim still resolves through `lookupActiveClaim` with identical text;
- every task keeps the same revision and an active state;
- every decision is still the live, unsuperseded revision.

A stale context fails the attempt gate, so its output source, topic message, proposal and derived mark never commit. Pending work is fenced as soon as the owner commits the change: task changes record reason `superseded`, and claim or source withdrawal records `source_retired`. A discussion with a stale context refuses `team.control include` with 409 `memory_context_stale`, so the owner starts a new discussion instead.

The inspect view re-evaluates each entry. A task that is no longer current shows a reason such as `task_cancelled`; a superseded decision shows `decision_superseded`; a withdrawn source shows `source_unavailable`; an unavailable claim shows the lineage reason from `lookupActiveClaim`. Claim text appears only while the claim is active. The public discussion projection also replaces the text of unavailable manifest claims. Two retained projections still hold the claim text that was available at commit time: private attempt snapshots and stored team command receipts. As in MEM01, MEM04 owns their retirement or redaction.

## Loop prevention

`memory_derived_sources(source_id, project_id, context_id, depth)` marks outputs produced with memory. The depth of an output is the maximum depth of its evidence, plus 1 if any claim was used. This applies to specialist outputs and coordinator proposal sources. From that mark:

- Extraction refuses a derived source with 409 `memory_source_derived`, and the memory inspector omits derived sources from its source list. A memory-derived answer can therefore never feed extraction again.
- A follow-on team or coordinator call whose evidence has depth 1 or more retrieves no claims; it still receives project constraints. It records `omitted.loopGuard` and `complete: false`. Summaries of memory-using discussions therefore do not pull memory a second time.
- Opening raw topic history is read-only. It starts no extraction, and it never makes a withdrawn source or claim available to automatic context again.

## Fixture answer and Web

When a request carries a context, the default `ScriptedRunPort` output appends `renderContextAnswer(request, maxBytes)` via `withContextAnswer`. The answer is deterministic Thai text, fitted to the effective output ceiling with an explicit truncation marker. It lists:

- the current purpose;
- constraints, with their IDs and states;
- owner statements for this project;
- inferences, with cross-project origin labels;
- conflicts, as owner questions;
- the recommendation basis, in precedence order. A recommendation based on an inference shows its claim ID, origin project and source reference. Unresolved conflicts make the recommendation ask the owner first. With nothing to cite, the answer says it has no supporting reference;
- disclosures for omissions, the loop guard and withdrawn memory.

The text shows that the rules are applied; it does not show model reasoning quality.

The discussion page includes a "context used" panel grouped by layer. It links each entry: tasks to `/projects/:p/tasks/:id`, decisions to `/projects/:p/topics/:t#owner-decision`, claims to the claim inspector on their origin project, and sources to the source page. The panel also shows stale reasons, conflicts and omission notes, and links to the context page.

## Deterministic evidence

`tests/memory-context.test.ts` uses scripted fixtures, a fake clock and no paid APIs. It covers:

- Day one: accepted, cancelled, proposed and dismissed tasks, plus a superseded decision. Then a service restart and next-day login. On day two a Web dispatch gets only the current state, with clickable task, decision, claim and context links and no raw-history replay. A later task cancellation shows the recorded entry as stale.
- Project A (legacy PostgreSQL) and project B (explicit SQLite). Each sees the other's claim only as an origin-labelled inference. No tasks or decisions cross projects, no new memory is created, and owner configuration is unchanged.
- Conflicting claims rendered as one owner question. An inference-only recommendation with provenance. Hostile claim text leaves tools and the route unchanged.
- Thai trigram matching without spaces, ASCII case folding, and a paraphrase that is not recalled.
- Constraint and claim ceilings, constraint clipping, the output and request byte bounds, a withdrawn source excluded after raw history is opened, and an empty context answered honestly.
- Claim-source withdrawal and task cancellation while a specialist run is in flight: no output or message commits. Decision supersession fences a queued coordinator synthesis.
- The loop guard for extraction (command and Web), follow-on dispatch, coordinator synthesis and proposal extraction.
- Migration from v11 to v12 with a private snapshot.
