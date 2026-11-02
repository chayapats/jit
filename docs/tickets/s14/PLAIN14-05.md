## Parent
https://github.com/chayapats/jit/issues/307

## Model tier
Frontier: this presentation reads retained private evidence through live lineage/authority boundaries and needs bounded-query and interaction judgment.

## Context to read
AGENTS.md, CONTEXT.md, docs/agents/workflow.md, docs/specs/S14-bot-first-local-assistant.md, docs/design/S14-plain-experience.md, ADRs 0052 and 0062, docs/contracts/app.report-artifacts-v1.md, docs/contracts/app.artifact-gateway-v1.md, docs/contracts/s14-foundation-http.md, and the actual S14 renderer/query tests.

## Status and provenance
Implemented on `jit/313-314-plain-flows`; pending current-head CI/Greptile review and merge. Local feature/regression checks and labelled Chrome fixture observations passed; remaining device/AT limits are retained.

The 2026-11-01 Plain handoff recorded this whole-app outcome, and the owner authorized completion/babysitting/remediation and merge after successful CI/Greptile review on 2026-11-02. This tracks an omitted approved flow, not a new style exploration. The task-specific UI/UX author exception remains authorized; repository-wide policy is unchanged. No matching Library/inline ticket or competing PR was found. The existing primary owner will use an issue-specific stacked branch from the corrected Plain implementation in PR #310; do not duplicate that implementation or modify its branch from another worktree.

## Deliverable
A conversation can show its Work result, report/source/file provenance, current owner decisions and scoped Stop inline. Details remain available on desktop/mobile, but the ordinary result/decision flow does not require navigating away. Preserve the existing exact Git review page when its contract requires immutable diff/check review before approval.

## Implementation steps
1. Re-use the authenticated current WorkView and report projections already read by web-product-team.ts; retain current source withdrawal and owner-only boundaries. Add only a bounded explicit projection where necessary, without new authority or schema.
2. Extend the typed work card in web-pages.ts with readable results, report revision/coverage/review facts, sources/files and the current exact effect components. Keep model/source text escaped and structurally separate from owner controls.
3. Preserve actual pending/changed/stale/expired/unknown states, scoped Stop/settlement and task acceptance versus start. Avoid duplicate DOM IDs or conflicting controls when a detail pane shows the same work.
4. Keep refresh regions/focus safe for multiple inline cards; reuse current exact-command forms and native no-script behavior. Add matching locale keys only when needed.
5. Add meaningful regressions for inline outcomes, source withdrawal, approvals/unknown, task/start, multiple work cards and pane interaction; record the actual tested source and remaining limits.

## Acceptance criteria
- [x] Ordinary retained Work results and available report/source/artifact facts can be read within their conversation; exact revision/provenance and limitations remain visible.
- [x] Generic/personal exact decisions use current typed components/commands; the required Git diff/check approval page remains authoritative.
- [x] Chat/task acceptance starts nothing; scoped Stop and unknown reconciliation retain their actual semantics. Stale/expired/denied states grant nothing.
- [x] Source/access withdrawal withholds inline payloads exactly as it does in details/downloads.
- [x] Multiple work cards and an open pane have unique IDs/valid labels; refresh preserves focused controls/drafts and does not replay commands.
- [x] Thai/English, narrow/desktop, no-script and existing routes remain usable.

## Tests and evidence
1. New tests/s14-inline-work.test.ts: produced result/report -> inline text, exact revision/coverage/provenance and files; no report -> honest result-only state; withdrawn lineage -> withheld payload/downloads.
2. Pending generic/personal effect -> exact current fields/commands; unknown -> reconciliation and no retry; Git effect -> its exact review link, no inline approval shortcut.
3. Two works plus selected pane -> no duplicate IDs or broken label targets; current typed task accept/start/Stop paths retain regression coverage.
4. Run bun test tests/s14-inline-work.test.ts tests/s14-team-ui.test.ts tests/s14-personal-ui.test.ts tests/s14-computer-ui.test.ts tests/s14-authority.test.ts tests/s14-web-enhance.test.ts tests/web-token-lint.test.ts, bun run typecheck and git diff --check. Use scripted ports; no real external effect.

## Requirements
S14-AC03/06/08/09/12/13; FR-06/07/16/18/24/25/29/42; NFR-07/08/11/13. Implements the owner-recorded 2026-11-01 seamless inline Work outcome within current contracts, not a new conversational execution policy.

## Blocked by
The supported schema-17 report/artifact/authority seams are implemented. Use the corrected PR #310 branch as a verified stacked base while it is unmerged; integration into main follows that parent. No device/AT permutation or live account/effect is invented as a new gate.

## Contracts used/delivered
Current S14 typed owner commands, ReportView and immutable artifacts retain their authentication, live lineage, revision, acceptance and download checks. No schema, Schway surface/pin, execution/network scope or external adapter change. Document any additive bounded read seam explicitly; model/source content grants nothing.

## Out of scope
New execution/effect authority, live provider/account tests, deployment/cutover, cross-device drafts, schema migration, legacy redesign and changes to the prior VoiceOver/iPhone deferrals.

## Do not
Do not infer completion from tests or a closed old ticket; show withdrawn payloads; conflate readiness, coverage and owner acceptance; retry unknown effects; remove capabilities absent from the reference; import demo timers/cursor/playback/input locks; weaken CSP/session/Host/Origin/CSRF/escaping/secrets; use implement-parallel; or add AI attribution.

## Definition of done
The named tests, bun run typecheck and git diff --check pass on the actual source. The PR body includes `Closes #314`, names validation/remaining limits, and receives current-head CI/Greptile review with all real findings addressed. The owner explicitly authorized merge after those checks/reviews pass; no deployment is authorized. Keep parent/evidence/issue mirrors synchronized and do not claim unrun device/AT evidence.
