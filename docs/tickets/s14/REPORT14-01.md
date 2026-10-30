<!-- jit-ticket:REPORT14-01:v1 -->

## Parent
https://github.com/chayapats/jit/issues/244

## Model tier
Frontier: this slice changes domain, authority, isolation, lifecycle, cross-repository integration or evidence semantics and requires engineering judgment. 

## Status
Prepared scoped ticket, needs triage. Phase A (research MVP). Not ready-for-agent: required contract/schema choices and blockers must be verified in the pinned base first.

## Context to read
AGENTS.md, CONTEXT.md, docs/agents/workflow.md, docs/specs/S14-bot-first-local-assistant.md, docs/product/02-prd.md, docs/adr/0047-parallel-research-and-report-artifacts.md, docs/contracts/s14-authority-and-design-resolutions.md and docs/design/S14-bot-first-experience.md.
Design coverage: F7; partial, complete and evidence; ready-for-review is independent of coverage.
Inspect relevant existing src/application.ts, src/store.ts, src/team, src/jobs, src/memory, src/exec, src/web.ts and tests before choosing a new-store implementation. The legacy Project API is evidence, not a required compatibility layer.

## Deliverable
Research produces a committed report and downloadable immutable file, with citations bound to evidence actually read and explicit missing coverage.

## Implementation steps
1. Specify report/claim/source links and completion/coverage state separately from ready-for-review.
2. Export bounded snapshots from the Bot workspace through a service gateway; validate path/type/size/hash and safe rendering before publication.
3. Wire Opus report/revisions/evidence/files/download states with private no-store responses and lifecycle cleanup.
4. Record exact exported signatures/data shapes/schema and supported contract versions in the implementation PR before dependent slices use them. Add one-line exported TSDoc contracts, deterministic fixtures and matching Opus-authored UI states.
5. Recheck current ownership/branches/PRs/prerequisites, use an issue-specific branch/worktree, and keep authority decisions out of model-generated text.

## Acceptance criteria
- [ ] A file existing or model done message cannot complete work without validated committed report/evidence.
- [ ] Missing required evidence remains partial even if a report is ready to inspect; invented/unread citations are refused or marked unsupported.
- [ ] Opaque download IDs cannot traverse host/Bot paths; untrusted HTML never executes in the app origin.
- [ ] Restart/delete/forget/revocation reaches artifact/report descendants and prevents stale late publication.
- [ ] Product UI states use the existing Opus handoff; any new UI/UX is delegated to Claude Opus 5.5 at effort high.
- [ ] Actual build/revision, checks, unrun evidence and remaining blockers are recorded.

## Tests and evidence
1. Citation mismatch/snippet-vs-page/partial/conflicting/stale-cache coverage corpus.
2. Artifact type/path/symlink/size/hash failure and authorized no-store download.
3. Atomic publish/restart/fenced attempt and deletion/restore lineage fixtures.

## Requirements
FR-07/16/18/29/42; NFR-05/07/08/10. Preserve requirement IDs and distinguish confirmed product behavior from proposed engineering.

## Blocked by
- https://github.com/chayapats/jit/issues/245 — reviewed S14 docs/design baseline must land; current artifact is the documentation branch, not main.
- https://github.com/chayapats/jit/issues/251 — TEAM14-01 supported contracts must be present in the integration base.
- https://github.com/chayapats/jit/issues/248 — BOX14-01 supported contracts must be present in the integration base.

## Contracts used/delivered
Deliver app.report-artifacts/v1 and app.artifact-gateway/v1: opaque ID, immutable revision/hash/type/size, producer/source lineage and authorized download.
A closed issue alone is insufficient; record exact supported artifact/capability and deterministic conformance. No private Schway imports or assumed new APIs.

## Out of scope
Arbitrary host file export, cloud artifact storage dependency and unverified scientific/product-quality claims.

## Do not
Do not widen scope/tools/accounts from model/source output, introduce silent provider/model/billing fallback, expose credentials, delete an existing installation, run live paid tests by default, or merge. Do not use implement-parallel/coordinator/claim workflow; the owner disabled it for Jit. Do not invent UI/UX in the primary implementation agent.

## Definition of done
Run focused behavior tests, bun run typecheck and the full bun test suite on the final HEAD; git diff --check passes. No paid/live call is part of deterministic CI.
PR includes Closes #252, tested SHA, contract versions, evidence and limitations. No merge by the implementer.
