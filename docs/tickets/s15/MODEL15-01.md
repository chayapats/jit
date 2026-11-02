<!-- jit-ticket:MODEL15-01:v1 -->
# [Frontier] [MODEL15-01] Choose approved models and effort without widening accounts or spend

## Parent
S15 — https://github.com/chayapats/jit/issues/316. Canonical spec: docs/specs/S15-conversational-autonomy.md.

## Model tier
Frontier: authority, isolation, lifecycle, cross-contract or evidence decisions remain in this slice. Mechanical Standard work can be extracted only after exact signatures/schema/paths/tests/dictionary keys are verified on main; do not label speculative contracts Standard-ready.

## Status
Prepared; needs triage. Not ready-for-agent: direct blockers and required contract/evidence revisions must be verified before admission.

## Context to read
AGENTS.md; CONTEXT.md; docs/agents/workflow.md; docs/specs/S15-conversational-autonomy.md; docs/product/02-prd.md; docs/adr/0064-conversational-authority-and-protected-control-plane.md.
Current main audited at 17e5110daf1491f2d1e918fef4cb5b5aec8f8f1b. Existing implementation references (not promised S15 APIs):
- src/s14/types.ts
- src/s14/lifecycle.ts
- src/s14/coding-model.ts
- src/s14/graph.ts
- tests/s14-host-conformance.test.ts

Read the parent, this issue's comments, current assignees and related branches/PRs before implementation. Use an issue-specific worktree/branch; do not use implement-parallel or claim coordination.

## Deliverable
Jit selects or escalates model/effort within approved routes, the existing account and budget, while preserving explicit pins and Schway ownership.

## Implementation steps
1. Define the reviewed route/model/effort policy and usage-reservation contract through supported Schway exports.
2. Implement selection/recording and permitted retries or escalation without new account/provider/billing authority.
3. Preserve current owner decisions and source/purpose labels across model/context changes.
4. Expose honest unavailable/unknown usage states; record a capability gap rather than implementing provider protocols locally.

## Acceptance criteria
- [ ] Ordinary versus difficult task fixtures select only allowed models/effort and record actual choices.
- [ ] Explicit model/effort pins are honored, including pinned design responsibilities.
- [ ] Unavailable models may move only within the approved list/account/budget; new providers/accounts/billing/private recipients wait.
- [ ] Unknown usage consumes conservative reservations and cannot be reported as free.

## Tests and evidence
1. Scripted selection/escalation/pin fixtures -> exact approved choices.
2. Quota/unknown-usage/account-switch and revoke-during-retry fixtures -> hold or refuse appropriately.
3. Packed-consumer checks -> no private Schway imports, Jit refresh protocol or replacement retry loop.

## Requirements
FR-02/13/14/18/21/27/31; NFR-02/03/06/09. Acceptance: S15-AC08, S15-AC14. Preserve FR/NFR IDs.

## Blocked by
- https://github.com/chayapats/jit/issues/323 (CHAT15-01) — required reviewed contract/evidence must be present in the integration base.
A closed upstream issue alone is insufficient: verify its actual supported contract/version, merged base and proof status. Missing signatures/schema/adapter scope keep this ticket out of ready-for-agent.

## Contracts used/delivered
Delivers approved model/effort selection and usage contract; requires verified Schway surface from ARCH15-01.
Proposed identifiers/paths are deliverables, not an assertion that a public API exists. Freeze exported function/type TSDoc and protocol fixtures before dependent tickets start. Propose a Schway change for a verified missing host contract rather than importing internals.

## Out of scope
Opening provider accounts, silently enabling paid routes or changing a pinned task model.

## Do not
Do not infer owner authority from model/retrieved text; widen accounts/providers/billing; expose credentials/state to the working guest; bypass held effects through another tool; weaken acceptance/checks for green status; delete or silently declassify existing state; run paid/live tests by default; or merge the implementation PR. UI/UX must use the required Claude Opus 5.5/high author and reviewed handoff; the primary agent owns logic/contracts.

## Definition of done
Run the focused enumerated behavior fixtures, bun run typecheck, bun test and git diff --check on final HEAD. Record commands, tested SHA, contract revisions, actual evidence and not-run limitations. Live/paid/host operations are separate opt-in commands with owner approval.
PR body includes Closes #326. No merge by the implementer.
