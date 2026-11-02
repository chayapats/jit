## Parent
https://github.com/chayapats/jit/issues/307

## Model tier
Frontier: this presentation reads retained private evidence through live lineage/authority boundaries and needs bounded-query and interaction judgment.

## Context to read
AGENTS.md, CONTEXT.md, docs/agents/workflow.md, docs/specs/S14-bot-first-local-assistant.md, docs/design/S14-plain-experience.md, ADRs 0052 and 0062, docs/contracts/app.report-artifacts-v1.md, docs/contracts/app.artifact-gateway-v1.md, docs/contracts/s14-foundation-http.md, and the actual S14 renderer/query tests.

## Status and provenance
CLOSED by [PR #315](https://github.com/chayapats/jit/pull/315), merged into main at `c1a96edebba4025e1ebcd09a8e133dacda0c9887` on 2026-11-02. Reviewed head `0db140af444e0a8dd960da1746d3d6206089eee0` passed typecheck, all six test shards, the deterministic aggregate and Greptile 5/5 APPROVED, with no unresolved review threads. The accepted-report localization and bounded provenance-query findings were corrected before merge. Labelled Chrome fixture observations retain their original source attribution and device/AT limits; this is not deployment or owner-host acceptance.

The 2026-11-01 Plain handoff recorded this whole-app outcome, and the owner authorized completion/babysitting/remediation and merge after successful CI/Greptile review on 2026-11-02. This tracks an omitted approved flow, not a new style exploration. The task-specific UI/UX author exception remains authorized; repository-wide policy is unchanged. No matching Library/inline ticket or competing PR was found. The existing primary owner will use an issue-specific stacked branch from the corrected Plain implementation in PR #310; do not duplicate that implementation or modify its branch from another worktree.

## Deliverable
A discoverable Library at /library with Reports and Artifacts views across work, while keeping Memory/Sources/Shares and all existing deep links reachable. Keep the latest approved Bots/conversations/Work primary navigation; Library belongs in the grouped knowledge destinations. Each output shows its actual work/Bot provenance, revision, coverage/review facts and authenticated detail/download links. Withdrawn outputs retain only safe identity/status.

## Implementation steps
1. Add an authenticated bounded ReportView catalog to S14Reports in src/s14/reports.ts and report-types.ts. Use stable cursor pagination (default 20, hard maximum 50) over existing committed report rows; re-use reconciliation/read gateways. Return no artifact bytes or raw content for unavailable lineage. Add no schema/table or write command.
2. Add src/s14/web-library.ts and /library routing in web-product.ts, plus a typed view/render dispatch in web-pages.ts. Preserve report/artifact gateway behavior; link exact report revisions back to their Work/conversation.
3. Render quiet rows using current tokens, with Reports/Artifacts navigation, safe empty/unavailable states and bounded next-page links. Add Library to More/knowledge; keep Memory and Shares reachable.
4. Add only needed dictionary keys in both locales and document the additive query/UI contract, approved provenance and implementation evidence.
5. Verify current authorization, source/access withdrawal, report revisions, review facts, pagination and native no-script links. Open a stacked PR and babysit it with the other Plain PRs.

## Acceptance criteria
- [x] Owner can find Reports/Artifacts across work and Bots from Library without opening each work first.
- [x] Exact revision, original work/Bot, coverage, owner review and available file metadata remain distinct and linked.
- [x] Current source/access/lifecycle withdrawal prevents old payloads or usable downloads from resurfacing; no page grants execution or acceptance.
- [x] Pagination is stable and bounded; invalid cursors/limits are refused. Empty and unavailable rows are honest.
- [x] Both locales/themes, narrow layouts, no-script navigation and all existing destinations retain their contracts.

## Tests and evidence
1. New tests/s14-library.test.ts: two works/Bots and multiple report revisions -> cross-work index; reports/artifacts views -> exact detail/download links; empty -> explicit empty state.
2. Catalog cursor/limit boundary and malformed parameters -> bounded correct pages/refusal; source withdrawal -> unavailable identity without title/claims/files; unauthenticated/foreign actor -> refusal.
3. Existing report/artifact/lineage tests plus affected UI/token checks. Run bun test tests/s14-library.test.ts tests/s14-team-ui.test.ts tests/s14-web-ui.test.ts tests/s14-authority.test.ts tests/web-token-lint.test.ts, bun run typecheck and git diff --check.
4. Label any additional local browser observations by source/assets. Preserve prior actual-device/AT limits.

## Requirements
S14-AC06/08/13; FR-07/16/18/24/25/29/42; NFR-07/08/11/13. The owner-recorded 2026-11-01 cross-work Library decision supplies the product outcome; the latest primary-navigation decision is retained.

## Blocked by
The supported schema-17 report/artifact/authority seams are implemented. Use the corrected PR #310 branch as a verified stacked base while it is unmerged; integration into main follows that parent. No device/AT permutation or live account/effect is invented as a new gate.

## Contracts used/delivered
Current S14 typed owner commands, ReportView and immutable artifacts retain their authentication, live lineage, revision, acceptance and download checks. No schema, Schway surface/pin, execution/network scope or external adapter change. Document any additive bounded read seam explicitly; model/source content grants nothing.

## Out of scope
New execution/effect authority, live provider/account tests, deployment/cutover, cross-device drafts, schema migration, legacy redesign and changes to the prior VoiceOver/iPhone deferrals.

## Do not
Do not infer completion from tests or a closed old ticket; show withdrawn payloads; conflate readiness, coverage and owner acceptance; retry unknown effects; remove capabilities absent from the reference; import demo timers/cursor/playback/input locks; weaken CSP/session/Host/Origin/CSRF/escaping/secrets; use implement-parallel; or add AI attribution.

## Definition of done
The named tests, bun run typecheck and git diff --check pass on the actual source. The PR body includes `Closes #313`, names validation/remaining limits, and receives current-head CI/Greptile review with all real findings addressed. The owner explicitly authorized merge after those checks/reviews pass; no deployment is authorized. Keep parent/evidence/issue mirrors synchronized and do not claim unrun device/AT evidence.
