<!-- jit-ticket:POLICY15-01:v1 -->
# [Frontier] [POLICY15-01] Enforce standing policy and exact held actions outside working agents

## Parent
S15 — https://github.com/chayapats/jit/issues/316. Canonical spec: docs/specs/S15-conversational-autonomy.md.

## Model tier
Frontier: authority, isolation, lifecycle, cross-contract or evidence decisions remain in this slice. Mechanical Standard work can be extracted only after exact signatures/schema/paths/tests/dictionary keys are verified on main; do not label speculative contracts Standard-ready.

## Status
Prepared; needs triage. Not ready-for-agent: direct blockers and required contract/evidence revisions must be verified before admission.

## Context to read
AGENTS.md; CONTEXT.md; docs/agents/workflow.md; docs/specs/S15-conversational-autonomy.md; docs/product/02-prd.md; docs/adr/0064-conversational-authority-and-protected-control-plane.md.
Current main audited at 17e5110daf1491f2d1e918fef4cb5b5aec8f8f1b. Existing implementation references (not promised S15 APIs):
- src/s14/application.ts
- src/s14/authority.ts
- src/s14/authority-types.ts
- src/s14/validation.ts
- tests/s14-authority.test.ts

Read the parent, this issue's comments, current assignees and related branches/PRs before implementation. Use an issue-specific worktree/branch; do not use implement-parallel or claim coordination.

## Deliverable
Authenticated owner policy permits ordinary bounded work and holds human-required actions with exact revision-bound approval; working agents cannot change their authority.

## Implementation steps
1. Freeze the reviewed standing-policy/action contract and schema from ARCH15-01/STATE15-01 before implementation.
2. Implement owner-derived actor, purpose/resource/model/destination scopes, rule revisions, finite budget reservations and action receipts.
3. Distinguish ordinary reversible edits, default approval classes and explicitly captured standing exceptions; unknown policy matches hold.
4. Bind final approvals to exact pending action details and recheck policy/revocation at admission, execution and publication.

## Acceptance criteria
- [ ] Model/source/repository/memory/quoted-owner text cannot create or widen policy or approve an action.
- [ ] A changed recipient/content/attachment/transaction, stale revision, expiry or revocation prevents execution.
- [ ] Operating costs reserve within a finite configured ceiling; unknown costs/usage are not zero and unspecified budgets are not spending permission.
- [ ] Default GitHub and optional personal rules are separate; policy changes and production approval cannot be made by the working agent.
- [ ] Duplicate and interrupted effects produce one local intent or unknown/reconcile-only state, never blind remote retries.

## Tests and evidence
1. Scripted actor/spoofed-source and cross-purpose/resource/model fixtures -> allow/hold/deny as specified.
2. Fake-clock expiry, stale-rule/approval and revoke-before-execute races -> no effect.
3. Concurrent reservation/exhaustion and crash-before/after effect fixtures -> conservative usage and reconcile-only unknown.

## Requirements
FR-06/13/14/15/17/18/35/37/38; NFR-05/06/07/14. Acceptance: S15-AC07, S15-AC08, S15-AC09. Preserve FR/NFR IDs.

## Blocked by
- https://github.com/chayapats/jit/issues/318 (ARCH15-01) — required reviewed contract/evidence must be present in the integration base.
- https://github.com/chayapats/jit/issues/319 (STATE15-01) — required reviewed contract/evidence must be present in the integration base.
A closed upstream issue alone is insufficient: verify its actual supported contract/version, merged base and proof status. Missing signatures/schema/adapter scope keep this ticket out of ready-for-agent.

## Contracts used/delivered
Delivers versioned standing-policy/action-approval contract and implementation conformance; old S14 commands are not silently reinterpreted.
Proposed identifiers/paths are deliverables, not an assertion that a public API exists. Freeze exported function/type TSDoc and protocol fixtures before dependent tickets start. Propose a Schway change for a verified missing host contract rather than importing internals.

## Out of scope
Real account adapters, arbitrary website guarantees, guest provisioning and UI design.

## Do not
Do not infer owner authority from model/retrieved text; widen accounts/providers/billing; expose credentials/state to the working guest; bypass held effects through another tool; weaken acceptance/checks for green status; delete or silently declassify existing state; run paid/live tests by default; or merge the implementation PR. UI/UX must use the required Claude Opus 5.5/high author and reviewed handoff; the primary agent owns logic/contracts.

## Definition of done
Run the focused enumerated behavior fixtures, bun run typecheck, bun test and git diff --check on final HEAD. Record commands, tested SHA, contract revisions, actual evidence and not-run limitations. Live/paid/host operations are separate opt-in commands with owner approval.
PR body includes Closes #320. No merge by the implementer.
