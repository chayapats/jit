---
status: accepted
scope: S10 context engineering choices; extends ADR 0020
---

# A self-contained context packet with pinned owner decisions

FR-31 requires that the owner's live decisions survive long conversations, compaction, reopening and provider changes. ADR 0020 already assembles constraints and claims inside the owner transaction. This ADR fixes the packet layout and the order in which content is dropped. The idea comes from openbot's self-contained channel context packets ([nightly-labs/openbot](https://github.com/nightly-labs/openbot)). No code is reused.

## Selected implementation

- **Layout.** `app.context_packet/v1` is a labelled layout on the existing `manifest.context`. Its sections always come in this order:
  1. Purpose.
  2. Responsibilities, taken from the role text.
  3. The current request.
  4. **Pinned decisions**: every committed `owner_decisions` row that is still live in scope (the topic's live decision, then the project's), with ids and revisions. This section has no count cap.
  5. Constraints, as defined in ADR 0020.
  6. Recent messages.
  7. A versioned summary that records `summaryRevision` and the source ids it covers.
  8. Memory claims.
- **Budget priority.** When the packet exceeds the run's context bytes, sections are dropped from the bottom up. Pinned decisions are dropped last.
  - If the pinned decisions alone exceed the budget, the run is not admitted. It fails with `context_too_large` and the owner gets a next action.
  - Every omission is recorded on the context record, as ADR 0020 already requires.
- **Stale-proofing.** If a decision is accepted or superseded after the packet was assembled, pending runs that pinned the old revision become stale through the existing `isCurrent` fence.
- **Provider independence.** Schway compaction summaries are native data and are never the only place a decision is recorded. Every run rebuilds its packet from committed tables, so reopening or changing provider changes nothing.

## Alternatives and consequences

- Relying on native session history or compaction would lose decisions without any warning.
- Pinning everything would overflow the budget.
- Packets grow by the number of live decision rows. Pinned decisions have **no count cap**: every live decision in scope is pinned, because FR-31 forbids dropping one. The existing 12-item ceiling of ADR 0020 applies to constraints only. Growth is bounded by the run's context byte budget; when the pinned decisions alone do not fit, the run is refused with `context_too_large` and a next action (supersede or close stale decisions, or raise the budget), and nothing is silently cut.

## CTX01 refinement: first-attempt assembly for Jit replies

Engineering decisions for S12-D07 (#183/#186), NFR-05 and FR-31; the confirmed product/authority decisions do not change:

- Jit reply admission owns receipt, job/order and trusted configuration; the first fenced attempt claim owns context assembly. Capture an identity-only plan in the existing reply JSON, without a schema migration. Retain an admission-time pinned-size feasibility check for the existing refusal/next action.
- Reuse the existing packet packing/omission policy. Order recent conversation by request/answer relationship so an earlier answer committed after a queued owner's message is visible, while later questions stay outside that run. A team reply keeps its original question boundary.
- Persist packet, exact lineage and first attempt snapshot atomically. Before assembly, owner state changes are reflected; after assembly they fence as before. Native history and memory-only deltas are never assembly inputs.
- Retries and explicit interrupted-read resumes keep the first assembled packet with fresh native identities. Recheck references on every attempt, reservation, preview and commit; a retired source blocks as `source_retired`, without rebuilding or resurrecting it. Legacy frozen requests remain valid.
- Provide a bounded attachment-reference liveness hook now, including exact source revision/generation and deletion/suppression ledgers. ATT04 supplies collection and bounded frame/tool materialization at that hook; ATT06 supplies file cleanup. Neither this timing change nor retrieved content grants tools or authority.

The immutable message sequence/pagination contract stays append-only. COMM03 pairs each on-page committed answer with its anchor for display, and leaves existing cross-page answer links intact. Queue ordering, priorities and concurrency remain unchanged; native steering still requires a future supported Schway contract.
