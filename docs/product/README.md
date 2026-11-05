# Jit product baseline

Current owner-confirmed direction: [S16 — Rakazo-style persistent teammates](../specs/S16-rakazo-experience.md), 2026-11-05. Keep Jit + Schway, reuse useful Rakazo concepts/code, and propose stack changes that make the product simpler or better. [S15](../specs/S15-conversational-autonomy.md) retains the confirmed authority baseline and its opt-in implementation. S14 remains the default runtime; explicit legacy selection and existing legacy service configs retain S09–S13. No S16 parity or new host acceptance is implied.

## Read order

1. [Domain/current runtime](../../CONTEXT.md), [S16 decisions/acceptance](../specs/S16-rakazo-experience.md), the retained [S15 baseline](../specs/S15-conversational-autonomy.md) and [PRD](02-prd.md), preserving FR-01–FR-42 and NFR-01–NFR-14.
2. [ADR 0074](../adr/0074-rakazo-reuse-and-product-convergence.md) for stack/reuse alternatives and [ADR 0064](../adr/0064-conversational-authority-and-protected-control-plane.md) for retained proof obligations; [ADR index](04-architecture-decisions.md) for history.
3. Earlier [vision](01-product-vision.md), [architecture](03-architecture.md), [trust](05-security-and-trust.md) and [MVP](06-mvp.md), only where consistent with the current target.
4. [S16 parent #392](https://github.com/chayapats/jit/issues/392), [S16 delivery graph](../tickets/S16-rakazo-experience-roadmap.md) and [issue workflow](../agents/workflow.md). S15 [#316](https://github.com/chayapats/jit/issues/316), its [graph](../tickets/S15-conversational-autonomy-roadmap.md), and #340/#341 retain implementation/evidence scope. Earlier [roadmap](07-roadmap.md), [validation](08-validation-and-open-questions.md) and [S14 ticket preparation](../tickets/S14-bot-first-roadmap.md) retain historical scope.
5. [S15 experience](../design/S15-conversational-experience.md) and [premium Web follow-up](../design/S15-premium-web.md) describe existing presentation. S16's required authoring handoff is a separate delivery; earlier designs are reference, not mandatory new-client constraints.
6. [Decision history](decision-record.md) and [sources](sources.md).

## Meaning of status

Confirmed describes the owner's chosen product direction. Required describes observable behavior/test gates. Proposed describes engineering/designer choices, not an owner answer or supported API. Implemented requires code/evidence at a stated revision. Open/blocked feasibility is reported honestly.

S15 supersedes conflicting S14 choices: mandatory Work-mode intake, repeated per-work grants, private resources per Bot as the default, manual memory publication and an individual approval for every remote write. It retains real human-required gates, bounded authority, evidence, credential protection and the Jit/Schway boundary. Historical documents below this index retain their prior meaning; conflicting text is not a simultaneous target requirement.

No state deletion, automatic private-data promotion, live cutover or metered amount is authorized by the interview. S15 transition/rollback and enforcement need explicit engineering/evidence. The owner disabled implement-parallel for this repository; explicitly requested Opus UI/UX delegation remains required.
