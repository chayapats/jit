# Jit product baseline

Current owner-confirmed direction: [S15 — Conversational autonomy with protected approvals](../specs/S15-conversational-autonomy.md), 2026-11-02. S15 records the accepted 23-question interview and final combined confirmation. S14 remains the implemented default runtime; explicit legacy selection and existing legacy service configs retain S09–S13. No S15 implementation or new host acceptance is implied.

## Read order

1. [Domain/current runtime](../../CONTEXT.md), [S15 decisions/acceptance](../specs/S15-conversational-autonomy.md) and [PRD](02-prd.md), preserving FR-01–FR-42 and NFR-01–NFR-14.
2. [ADR 0064](../adr/0064-conversational-authority-and-protected-control-plane.md) for proposed engineering and unresolved proof gates; [ADR index](04-architecture-decisions.md) for history.
3. Earlier [vision](01-product-vision.md), [architecture](03-architecture.md), [trust](05-security-and-trust.md) and [MVP](06-mvp.md), only where consistent with S15.
4. [S15 parent #316](https://github.com/chayapats/jit/issues/316), [S15 delivery graph](../tickets/S15-conversational-autonomy-roadmap.md) and [issue workflow](../agents/workflow.md). Earlier [roadmap](07-roadmap.md), [validation](08-validation-and-open-questions.md) and [S14 ticket preparation](../tickets/S14-bot-first-roadmap.md) retain historical scope.
5. Historical [S14 Opus design](../design/S14-bot-first-experience.md), [prototype](../design/s14-bot-first-prototype.html) and [contract resolutions](../contracts/s14-authority-and-design-resolutions.md). S15 concrete UI/UX still needs the required Opus author.
6. [Decision history](decision-record.md) and [sources](sources.md).

## Meaning of status

Confirmed describes the owner's chosen product direction. Required describes observable behavior/test gates. Proposed describes engineering/designer choices, not an owner answer or supported API. Implemented requires code/evidence at a stated revision. Open/blocked feasibility is reported honestly.

S15 supersedes conflicting S14 choices: mandatory Work-mode intake, repeated per-work grants, private resources per Bot as the default, manual memory publication and an individual approval for every remote write. It retains real human-required gates, bounded authority, evidence, credential protection and the Jit/Schway boundary. Historical documents below this index retain their prior meaning; conflicting text is not a simultaneous target requirement.

No state deletion, automatic private-data promotion, live cutover or metered amount is authorized by the interview. S15 transition/rollback and enforcement need explicit engineering/evidence. The owner disabled implement-parallel for this repository; explicitly requested Opus UI/UX delegation remains required.
