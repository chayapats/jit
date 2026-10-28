# Context packet, v1

Owner: Jit #117 (REL05). Contract: `app.context_packet/v1`. Requirements: FR-31, FR-04, FR-05, FR-14, NFR-05 and NFR-10. Extends `app.memory_context/v1` ([memory-context-v1](memory-context-v1.md)) and consumes `app.decision_read_model/v1` (`owner_decisions`) and `app.run_port/v1`. [ADR 0034](../adr/0034-context-packet-with-pinned-decisions.md) records the decision; it extends [ADR 0020](../adr/0020-memory-context-assembly.md). No schema change.

## Layout

`manifest.context.packet` is a labelled layout on the existing `manifest.context` (`MemoryContextLayout`, `src/team/types.ts`). It holds:

- `contract: "app.context_packet/v1"`, `version: 1`;
- `sections`: exactly eight `{order, name, state, items, bytes}` entries, always in this order:
  1. `purpose`: the run purpose (`request.purpose`).
  2. `responsibilities`: the role responsibility text (`request.instructions.responsibility`).
  3. `current_request`: the frozen evidence of a discussion, synthesis or summary, or the owner's message (plus the specialist results of a team reply) for a Jit reply.
  4. `pinned_decisions`: every live owner decision in scope (below).
  5. `constraints`: the current tasks of ADR 0020, under its 12-item ceiling.
  6. `recent_messages`: older topic messages of a Jit reply.
  7. `summary`: the versioned summary (below).
  8. `memory_claims`: the claims of ADR 0020.
- `pinned`: the pinned decisions, each `{id, revision, topicId, scope: "topic" | "project", conclusion, rationale, source}`;
- `summary`: `{summaryRevision, index, source, sourceIds, depth}` or `null`;
- `sourceIndexes: {currentRequest, recentMessages}`: indexes into `manifest.sources`;
- `omissions`: one `{section, reason, items}` record per trim;
- `budget: {bytes, pinned, used}`: the request bytes sections 4–8 could use, the pinned decision bytes, and the bytes they used.

Section `state` is `included` (every candidate), `trimmed` (some dropped), `dropped` (none fit), `empty` (nothing to add) or `withheld` (not given to this run type). Omission `reason` is `budget`, `ceiling`, `loop_guard`, `unavailable` or `run_policy`. A pinned decision never appears in `omissions`.

The packet is labels and copied committed state only. `validateRunRequest` checks the shape (fixed section order, indexes inside `manifest.sources`, the summary index naming the summary source). It cannot add tools, routes, policy flags or authority, and model output cannot change it.

## Pinned decisions

`pinnedDecisions(tx, projectId, topicId)` in `src/memory/packet.ts` reads every `owner_decisions` row of the project with `superseded_by IS NULL`: the run topic's live decision first (`scope: "topic"`), then the other topics' live decisions newest first (`scope: "project"`). Each keeps its exact id and revision, its full conclusion and rationale (never clipped), and its owner-attributed evidence source.

- **No count cap.** Every live decision in scope is pinned. The 12-item ceiling of ADR 0020 applies to section 5 only. Live decisions are not repeated in section 5.
- **Charged first, trimmed last.** Pinned decisions are charged against the run's context bytes before sections 5–8. They are never trimmed.
- **Refusal.** When the pinned decisions alone exceed the run's context bytes, the run is not admitted and nothing is enqueued:
  - an owner command (`team.dispatch`, `decision.synthesize`) fails with 409 `context_too_large` and `detail: {nextAction: "supersede_or_close_stale_decisions_or_raise_context_budget", pinnedBytes, budgetBytes}`; a Jit dispatch proposal that cannot start its discussion for this reason records `not_admitted` and waits for the owner, as for any other start failure;
  - a Jit reply records the not-admitted reason `context_too_large`; while the project has live decisions its next action is `review_pinned_decisions` (send a shorter message, supersede or close stale decisions, or raise the context budget);
  - a scheduled summary attempt is blocked with job reason `context_too_large`.

## Trim order

Sections 1–3 are the run's fixed input and are already charged by `contextByteRoom` (or the reply overhead). The remaining room, after the pinned decisions and within `memoryContextPolicy.bytes`, is filled from section 5 down. `trimBottomUp` keeps candidates in order and, at the first candidate that does not fit, drops it and everything below it. The result equals removing candidates from section 8 upward until the rest fit. Section 8 receives bytes only when sections 5–7 were kept whole; inside section 8 the claim rules of ADR 0020 apply unchanged. A Jit reply fills section 5 before section 6, so older messages go before any task.

Every loss is recorded twice: in `packet.omissions` on the request, and in `memory_contexts.record_json.packet` (`sections`, `omissions`, `budget`, `summary`) for discussions, syntheses and summaries. A budget or ceiling omission makes the record `complete: false`. The inspect view and the discussion "context used" panel list pinned decisions as their own group and name the trimmed sections; the view reports the context as no longer current once the project's live decisions differ from the pinned set. `memoryContextOperator` ranks the pinned decisions with the current purpose and task constraints, above explicit preferences and inferences.

## Per run type

| Run | Section 3 | Section 6 | Section 7 | Section 8 | Provenance record |
| --- | --- | --- | --- | --- | --- |
| discussion (specialists) | frozen sources | withheld | newest summary | claims, unless the summary or evidence is memory-derived (`loop_guard`) | `memory_contexts` (`discussion`) |
| coordinator synthesis | specialist results | withheld | withheld (`run_policy`) | claims | `memory_contexts` (`synthesis`) |
| scheduled summary | topic source | withheld | withheld (`loop_guard`) | claims | `memory_contexts` (`schedule`) |
| Jit reply / team reply | owner message (+ results) | older topic messages | withheld | withheld | the reply record (`recordId` = reply id) |

Topic messages are never replayed into discussions, syntheses or summaries (ADR 0020). Jit replies never receive memory claims or memory-derived summaries (`app.jit_reply/v1`), so their layout records `derivation.inputDepth: 0` and no `memory_contexts` row.

## Versioned summary

`topicSummary(tx, projectId, topicId)` takes the newest committed scheduled summary of the topic: a complete `summary` occurrence with an output source that is still available, at its current revision and not suppressed. Unavailable newer summaries are skipped and recorded as `unavailable`. `summaryRevision` is the ordinal of that summary among the topic's committed summaries. `sourceIds` are the source entries of that summary run's own context record. The summary text is one more `manifest.sources` entry at `summary.index`, so deletion, suppression and source currentness treat it like any other cited source; it needs a free source slot (`ceiling` otherwise). Summary outputs are memory-derived, so a run that receives the summary counts its depth in `derivation.inputDepth`: the ADR 0020 loop guard then withholds claims (`memory_claims` / `loop_guard`), the output inherits the depth, and a summary run never receives a summary (no recursive summaries). Every committed summary of the topic is walked newest first, so an older available summary is still found when newer ones were withdrawn.

## Staleness

`contextCurrent(tx, projectId, manifest)` also returns `superseded` when the pinned set no longer equals the project's live decisions at the same revisions, and `source_retired` when the packet summary is no longer available. It runs in the existing `isCurrent` gates of specialists, synthesis, Jit replies and scheduled summaries. Owner `decision.accept` and `decision.supersede` call `fenceStaleContexts` in the same transaction, so pending specialist, synthesis and reply runs that pinned the old set are fenced (`superseded`) and cancelled after commit. This replaces ADR 0020's rule that an acceptance does not stale an earlier context: a coordinator synthesis still running when the owner accepts a decision is now fenced instead of finishing as `late_after_decision`.

## Rebuild from committed tables

Every packet is built inside the owner or admission transaction from `owner_decisions`, `memory_decision_sources`, `tasks`, `job_schedule_occurrences`, `memory_contexts`, `sources`, `messages` and `memory_claims`. It never reads Schway native history, native sessions or compaction summaries. Reopening the store in a new process or changing the provider therefore rebuilds the same packet. The Schway port renders each pinned decision as a `decision/<project>/<id>` document with revision `r<revision>`, so the model receives the decisions in every run.

## Deterministic evidence

`tests/context-packet.test.ts` uses scripted fixtures and a fake clock:

1. A budget fixture over all eight sections drops candidates from section 8 upward, keeps the decisions and records each omission; a live discussion shows the same order with tasks, a summary and claims.
2. Thirteen live decisions (topic and project) within budget are all pinned.
3. Decisions alone larger than the budget refuse `team.dispatch` with `context_too_large` and its next action, and refuse a Jit reply with `review_pinned_decisions`.
4. A decision accepted or superseded while a reply run is pending fences the reply as stale; no reply message commits.
5. Reopening the database with a new store handle rebuilds an identical packet.
