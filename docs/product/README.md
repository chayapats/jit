# Jit product baseline

Current owner-confirmed direction: [S14 — Bot-first local assistant](../specs/S14-bot-first-local-assistant.md), [parent #244](https://github.com/chayapats/jit/issues/244), 2026-10-30. Documentation/design delivery is [#245](https://github.com/chayapats/jit/issues/245). The current application runtime is still the implemented S09–S13 project-centric version.

## Read order

1. [Vision](01-product-vision.md) and [MVP](06-mvp.md).
2. [PRD](02-prd.md), preserving FR-01–FR-40 and NFR-01–NFR-14 while adding FR-41/42.
3. [Architecture](03-architecture.md), [trust](05-security-and-trust.md) and [ADRs](04-architecture-decisions.md).
4. [Roadmap](07-roadmap.md), [validation](08-validation-and-open-questions.md), [S14 ticket preparation](../tickets/S14-bot-first-roadmap.md).
5. [Opus design](../design/S14-bot-first-experience.md), [prototype](../design/s14-bot-first-prototype.html) and [contract resolutions](../contracts/s14-authority-and-design-resolutions.md).
6. [Decision history](decision-record.md) and [sources](sources.md).

## Meaning of status

Confirmed describes the owner's chosen product direction. Required describes observable behavior/test gates. Proposed describes engineering/designer choices, not an owner answer or supported API. Implemented requires code/evidence at a stated revision. Open/blocked feasibility is reported honestly.

S14 replaces required Projects, the hidden General project, per-project computer/permissions/memory scope and the default SearXNG choice for the new store. Unchanged boundaries/invariants remain. Historical specs and Git history preserve earlier decisions; they are not simultaneous contradictory target requirements.

The owner permits fresh state without legacy migration. This does not authorize deleting an installation. The owner disabled implement-parallel for this repository; explicitly requested Opus UI/UX delegation remains required.
