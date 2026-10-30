<!-- jit-ticket:SHARE14-01:v1 -->

## Parent
https://github.com/chayapats/jit/issues/244

## Model tier
Frontier: this slice changes domain, authority, isolation, lifecycle, cross-repository integration or evidence semantics and requires engineering judgment.

## Status
Prepared scoped ticket, needs triage. Phase A (research MVP). Not ready-for-agent: required contract/schema choices and blockers must be verified in the pinned base first.

## Context to read
AGENTS.md, CONTEXT.md, docs/agents/workflow.md, docs/specs/S14-bot-first-local-assistant.md, docs/product/02-prd.md, docs/adr/0046-bot-computers-and-explicit-sharing.md, docs/contracts/s14-authority-and-design-resolutions.md and docs/design/S14-bot-first-experience.md.
Design coverage: F10/F11 sharing; share, revoke and memory source scope.
Inspect relevant existing src/application.ts, src/store.ts, src/team, src/jobs, src/memory, src/exec, src/web.ts and tests before choosing a new-store implementation. The legacy Project API is evidence, not a required compatibility layer.

## Deliverable
Owner grants another Bot access to one named source/artifact snapshot without sharing an entire workspace, profile or account.

## Implementation steps
1. Implement revisioned explicit share commands with receiver/work/expiry and named immutable source/artifact identity.
2. Import only validated bounded snapshots through the artifact gateway; no cross-Bot volume mounts or profile/account transfer.
3. Recheck at read/context/publication and retire affected contexts on revoke; wire Opus share/revoke states.
4. Record exact exported signatures/data shapes/schema and supported contract versions in the implementation PR before dependent slices use them. Add one-line exported TSDoc contracts, deterministic fixtures and matching Opus-authored UI states.
5. Recheck current ownership/branches/PRs/prerequisites, use an issue-specific branch/worktree, and keep authority decisions out of model-generated text.

## Acceptance criteria
- [ ] Guessing a path/ID or forwarding a share does not grant access; no transitive capability expansion.
- [ ] Owner-approved receiver sees exactly the pinned revision; source changes require a new explicit share.
- [ ] Revocation fences future calls and late results; already-disclosed knowledge is not falsely described as erased.
- [ ] Sharing a file or memory does not expose browser sessions, vault secrets or another Bot's workspace.
- [ ] Product UI states use the existing Opus handoff; any new UI/UX is delegated to Claude Opus 5.5 at effort high.
- [ ] Actual build/revision, checks, unrun evidence and remaining blockers are recorded.

## Tests and evidence
1. Cross-Bot denial, immutable revision, receiver/work scope and duplicate/stale commands.
2. Type/path/hash/size enforcement through the common artifact gateway.
3. Revoke during read/context/commit and delete/restore lineage cases.

## Requirements
FR-05/16/17/35/38/42; NFR-07/08/14. Preserve requirement IDs and distinguish confirmed product behavior from proposed engineering.

## Blocked by
- https://github.com/chayapats/jit/issues/245 — reviewed S14 docs/design baseline must land; current artifact is the documentation branch, not main.
- https://github.com/chayapats/jit/issues/252 — REPORT14-01 supported contracts must be present in the integration base.

## Contracts used/delivered
Deliver app.snapshot-sharing/v1 consuming the grant scope and report artifact gateway; share ID pins source/artifact revision, receiver and work scope.
A closed issue alone is insufficient; record exact supported artifact/capability and deterministic conformance. No private Schway imports or assumed new APIs.

## Out of scope
Whole workspace/account sharing, multi-user tenants and retroactive erasure of disclosed knowledge.

## Do not
Do not widen scope/tools/accounts from model/source output, introduce silent provider/model/billing fallback, expose credentials, delete an existing installation, run live paid tests by default, or merge. Do not use implement-parallel/coordinator/claim workflow; the owner disabled it for Jit. Do not invent UI/UX in the primary implementation agent.

## Definition of done
Run focused behavior tests, bun run typecheck and the full bun test suite on the final HEAD; git diff --check passes. No paid/live call is part of deterministic CI.
PR includes Closes #253, tested SHA, contract versions, evidence and limitations. No merge by the implementer.
