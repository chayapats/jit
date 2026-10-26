---
status: accepted
scope: S09 main-bot engineering choices; extends ADRs 0011 and 0015
---

# Jit conversational replies, owner-configured persona and role proposals

FR-19 and FR-20 make the coordinator answer every owner message as "Jit", and let it propose new specialists. ADR 0011 still holds: provider/model output has no configuration authority. ADR 0015 still holds: coordinator output is recommendation-only.

## Selected implementation

- An owner `message.send` in a topic admits one `team.jit-reply` interactive job through `jobs.queue_admission`. Its result is published through `jobs.attempt_fence` as an attributed Jit message source. Duplicate request IDs, refreshes and reconnects do not admit another reply. A late result from a stopped or superseded generation is discarded.
- The run receives trusted operator instructions (product policy plus the owner's persona) and an untrusted manifest (topic history, sources, memory context and specialist results). It receives no tools in this slice. Its structured output may contain prose plus at most a finite number of typed proposals: `role`, `dispatch` (see ADR 0030) and `promotion` (see ADR 0031). Unknown fields are discarded.
- **Persona** is owner configuration, stored with revisions and written only by owner commands from setup or settings. It covers how Jit addresses the owner, the language for UI and replies, self-reference, politeness particle, a personality preset (calm, direct, friendly) and free-text "about me". The persona is trusted instruction text. The model cannot rewrite it.
- **Role proposal** is an immutable revision containing name, responsibility, and a route reference chosen only from routes the owner has already configured. It can be in one of four states: proposed, accepted, rejected or superseded. `role.proposal.accept` requires the current proposal id and revision, and writes through the existing `role.save` path in the same transaction and receipt. Editing before acceptance creates an owner-authored revision. A proposal never names tools, budgets or new routes. Text that asks for them is ignored, and the card shows what was dropped.
- When specialists took part, the reply cites the committed specialist result revisions and records the coverage gap. This is the same rule as ADR 0015.

## Alternatives and consequences

Letting the model create roles directly was rejected by the owner (S09-D03) and conflicts with FR-17. Free-form intent parsing on the owner's own message was rejected because the model would still be the interpreter. Schema changes add persona, proposal and reply records behind the existing snapshot-before-DDL migration.
