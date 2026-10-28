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
