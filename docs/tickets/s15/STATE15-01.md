<!-- jit-ticket:STATE15-01:v1 -->
# [Frontier] [STATE15-01] Specify a non-destructive S14-to-S15 state and policy transition

## Parent
S15 — https://github.com/chayapats/jit/issues/316. Canonical spec: docs/specs/S15-conversational-autonomy.md.

## Model tier
Frontier: authority, isolation, lifecycle, cross-contract or evidence decisions remain in this slice. Mechanical Standard work can be extracted only after exact signatures/schema/paths/tests/dictionary keys are verified on main; do not label speculative contracts Standard-ready.

## Status
Prepared; needs triage. Not ready-for-agent: direct blockers and required contract/evidence revisions must be verified before admission.

## Context to read
AGENTS.md; CONTEXT.md; docs/agents/workflow.md; docs/specs/S15-conversational-autonomy.md; docs/product/02-prd.md; docs/adr/0064-conversational-authority-and-protected-control-plane.md.
Current main audited at 17e5110daf1491f2d1e918fef4cb5b5aec8f8f1b. Existing implementation references (not promised S15 APIs):
- src/s14/store.ts
- src/s14/ops.ts
- src/s14/ops-state.ts
- src/s14/ops-ledger.ts
- src/s14/memory-types.ts
- src/s14/authority-types.ts
- tests/s14-ops.test.ts

Read the parent, this issue's comments, current assignees and related branches/PRs before implementation. Use an issue-specific worktree/branch; do not use implement-parallel or claim coordination.

## Deliverable
A versioned transition inventory and recovery plan preserve S14/legacy data, private scopes and approvals while defining explicit S15 policy adoption.

## Implementation steps
1. Inventory current schema/application identifiers, stores, policy generations, effect states, memory/privacy lineage and opaque native references.
2. Define compatible transitions and refusals for each record class, including stopped/cancelled/unknown work and lifecycle tombstones.
3. Specify explicit owner adoption of team scope and the personal GitHub exception; upgrades must not infer either from this spec.
4. Deliver docs/contracts/s15-state-transition-v1.md with schema/version plan, fixture input/output examples and rollback/backup checkpoints.

## Acceptance criteria
- [ ] The exact main/schema is recorded; no old fresh-state permission is treated as S15 erase/import authority.
- [ ] Existing private claims/files/accounts remain restricted until an authorized conversion; personal GitHub permissions are never an upgrade default.
- [ ] Unknown effects, consumed budget and lifecycle withdrawals cannot reset through backup/restore or transition.
- [ ] The plan identifies exact migration signatures/record shapes and refusal cases before the implementing ticket is ready.

## Tests and evidence
1. Map fixtures for current S14 state, legacy service-config omission, withdrawn private sources and unknown effects to preserved/refused outcomes.
2. Document byte-preservation and prior-build rollback evidence required from the eventual implementation.
3. Read-only inventory only: do not open a live store writable, inspect secrets or run an installation migration.

## Requirements
FR-04/05/15/16/18/23/35; NFR-05/07/08/12. Acceptance: S15-AC16. Preserve FR/NFR IDs.

## Blocked by
- https://github.com/chayapats/jit/issues/317 (DOC15-01) — required reviewed contract/evidence must be present in the integration base.
- After DOC15-01 merges, this read-only audit needs no live host/account. It may report gaps; closing an audit does not certify downstream runtime readiness.
A closed upstream issue alone is insufficient: verify its actual supported contract/version, merged base and proof status. Missing signatures/schema/adapter scope keep this ticket out of ready-for-agent.

## Contracts used/delivered
Delivers proposed s15-state-transition/v1, including schema and policy-version adoption; no schema is changed in this audit.
Proposed identifiers/paths are deliverables, not an assertion that a public API exists. Freeze exported function/type TSDoc and protocol fixtures before dependent tickets start. Propose a Schway change for a verified missing host contract rather than importing internals.

## Out of scope
Applying migrations, choosing a live host or changing legacy/S14 activation.

## Do not
Do not infer owner authority from model/retrieved text; widen accounts/providers/billing; expose credentials/state to the working guest; bypass held effects through another tool; weaken acceptance/checks for green status; delete or silently declassify existing state; run paid/live tests by default; or merge the implementation PR. UI/UX must use the required Claude Opus 5.5/high author and reviewed handoff; the primary agent owns logic/contracts.

## Definition of done
Run git diff --check and validate all artifact links/requirements and exact inspected paths. Documentation-only changes do not require runtime tests. If the audit adds executable probes, run their focused tests, bun run typecheck and bun test on final HEAD. Record exact main/artifact SHA and distinguish not-run host evidence.
PR body includes Closes #319. No merge by the implementer.
