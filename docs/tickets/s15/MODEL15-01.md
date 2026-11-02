<!-- jit-ticket:MODEL15-01:v1 -->
# [Frontier] [MODEL15-01] Choose approved models and effort without widening accounts or spend

## Parent
S15 — https://github.com/chayapats/jit/issues/316. Canonical spec: docs/specs/S15-conversational-autonomy.md.

## Model tier
Frontier: authority, isolation, lifecycle, cross-contract or evidence decisions remain in this slice. Mechanical Standard work can be extracted only after exact signatures/schema/paths/tests/dictionary keys are verified on main; do not label speculative contracts Standard-ready.

## Status
Implemented as an explicit opt-in host service on the #326/#327 integration branch: `src/s15/model/`, protected POLICY subscription-reservation additions, read-only JSON projections and deterministic public-host/restart tests. Exported TSDoc and the executable contract refinement supersede the historical preparation design. Review/merge, real provider/host enforcement and installation adoption remain separate; no monetary allowance or live account readiness is inferred.

Historical preparation status:
Blocked / needs triage. Owner-authorized bounded DOCUMENTATION-ONLY step 1 preparation proposes [s15-model-selection/v1](../../contracts/s15-model-selection-v1.md), [ADR0070](../../adr/0070-s15-approved-model-selection-and-disclosure.md), complete synthetic documentation and a [preparation record](../../evidence/s15-model-contract-preparation.md). This is not runtime admission, final freeze, ready/complete status or acceptance evidence. Native #323 remains OPEN and all four original implementation criteria remain outstanding. Exact reviewed #318/#320/#321/#322/#323 inputs are unmerged proposals pending reconciliation with actual merged reviewed revisions and implementation evidence. S14 remains default; RT15-01/RF15-G01–G08 remain unproven.

## Context to read
AGENTS.md; CONTEXT.md; docs/agents/workflow.md; docs/specs/S15-conversational-autonomy.md; docs/product/02-prd.md; docs/adr/0064-conversational-authority-and-protected-control-plane.md.
Initial planning main was `17e5110daf1491f2d1e918fef4cb5b5aec8f8f1b`; bounded preparation rechecked `64f3a94726fdbce2283aec0944884ca7406d9934`. Existing implementation references (not promised S15 APIs):
- src/s14/types.ts
- src/s14/lifecycle.ts
- src/s14/coding-model.ts
- src/s14/graph.ts
- tests/s14-host-conformance.test.ts

Read the parent, this issue's comments, current assignees and related branches/PRs before implementation. Use an issue-specific worktree/branch; do not use implement-parallel or claim coordination.

## Deliverable
Jit selects or escalates model/effort within approved routes, the existing account and budget, while preserving explicit pins and Schway ownership.

## Implementation steps
1. Define the reviewed route/model/effort policy and usage-reservation contract through supported Schway exports. The bounded proposal prepares review only; MODEL15-FZ01–FZ07 and demonstrated public-dispatch/effort/cost requirements remain open, without bypassing native #323.
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
The full implementation PR body includes Closes #326. A bounded documentation-only preparation PR uses Refs #326, preserves all original criteria/native prerequisites/labels/ownership and leaves the issue open. It runs static document/link/schema/type/fixture/hash/requirement/monotonic-fact/causal-time checks and git diff --check only. All scenarios are UNEXECUTED documentation, not passing tests; runtime tests/typecheck, executable/live probes and model/provider/account/catalog/readiness/session/VM/browser operations are not required or claimed. No merge by the implementer.
