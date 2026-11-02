<!-- jit-ticket:PLAIN14-03:v1 -->

## Parent

https://github.com/chayapats/jit/issues/307

Discovered by evidence ticket https://github.com/chayapats/jit/issues/309 on the unmerged Plain implementation in PR #310. This ticket records additional implementation scope; #309 does not authorize its fix.

## Model tier

Frontier: browser history restoration crosses the Chat/Work presentation and explicit-start boundary. The fix must preserve current command authority, text-only drafts, receipt handling and no-script behavior.

## Status

OPEN, needs-triage; implementation authorization and ownership are not assigned by this report. No new device/AT release gate is created.

## Context to read

`AGENTS.md`, `CONTEXT.md`, `docs/agents/workflow.md`, `docs/specs/S14-bot-first-local-assistant.md` (AC03/09/12/13), `docs/design/S14-plain-experience.md`, ADR 0062, `docs/contracts/s14-foundation-http.md`, `docs/contracts/app.work-grants-v1.md`, `docs/evidence/s14-plain-ui.md`, `src/s14/web-enhance.js`, `tests/s14-browser-drafts.test.ts` and `tests/s14-browser-navigation.test.ts`.

## Deliverable

Reset history-restored composers to Chat consistently and synchronize visible/send accessible labels with the actual mode. Preserve the draft's approved text and current authenticated service form; never replay a command.

## Observed reproduction

Tested checkout `1844be4309c3f5670ffa2c217350682c892823a3`; runtime source `388c119773bcb1244912fa70ec3ec67b5cd0544d`. macOS 27.2 (26B123), arm64; actual headless Chrome/156.0.8078.74, fresh isolated profile, CSS viewport 390 × 844, EN/light. Real S14 handler/store, scripted local ports; CDP mouse/keyboard, no physical device or screen-reader speech.

1. Authenticate to a disposable loopback fixture. Open conversation C with an ordinary composer, type a non-sensitive draft and select Work.
2. Navigate to an existing retained work detail at `/work/W`.
3. Use the browser's history Back entry to return to C; do not reload or submit. The runner used CDP `Page.navigateToHistoryEntry`.
4. After page load plus 400 ms, inspect the composer.

Observed on three independent Back traversals in the second fresh profile, in addition to the first run's failure:

- `input[name=work].checked === true`; visible mode is Work and the Work budget is displayed.
- The send button's `aria-label` is `Send message`, rather than `Start bounded work`.
- The restored-draft notice says to choose Work again.
- Navigation timing reports `back_forward`.
- Draft text remains intact. No automatic POST, new work grant or execution was observed.

Expected: Chat mode, matching send label, retained approved text, fresh non-restored authority fields and no automatic command. This is a confirmed presentation/mode-reset defect; it is not a demonstrated service authorization bypass or an executed external effect. Browser event ordering is not yet proven. The current asset's history handlers act only when `pageshow.persisted` is true, which is a code-based lead for investigation, not a complete causal finding.

## Implementation steps

1. Reconfirm ownership, current PR/base and the reproduction on the revision selected for the fix.
2. Investigate native form-history restoration, initialization and pageshow ordering in `src/s14/web-enhance.js`. Cover both page-cache and ordinary back/forward paths.
3. Apply the narrow mode/label reset at the existing enhancement seam, without restoring any stored grant controls or submitting forms. Retain intentional live page-memory choices during Bot lifecycle replacement.
4. Add meaningful regression coverage for the real failure and preserve existing text-only draft, receipt, refused-post and no-script contracts.
5. Record the new tested source/assets, failures and remaining actual-device/AT limits separately from the #309 build.

## Acceptance criteria

- [ ] Native back/forward return resets the composer to Chat for ordinary form-history and cached-page restoration.
- [ ] Visible mode, send text/title/aria-label and actual submitted command selection agree.
- [ ] Approved draft text remains; mode, tools/resources, limits, retry keys, revisions and approvals are never restored from local drafts.
- [ ] Browsing/history sends no command and creates no work or grant; a fresh explicit Work selection still starts only through the existing typed boundary.
- [ ] Successful receipts, stale/refused submissions, conversation isolation, lifecycle page-memory behavior and native no-script forms retain their contracts.
- [ ] Tests and revision-labelled browser evidence reproduce and verify the reported path; no unrun Safari/device/AT result is claimed.

## Tests and evidence

1. Reproduce the four steps above with actual browser history. Record checked state, accessible label, visible mode, retained text, navigation type and network/service counters.
2. Exercise cached pages and ordinary back/forward form restoration, plus reload, detail-close, conversation change and successful/refused submit.
3. Run `bun test tests/s14-browser-drafts.test.ts tests/s14-browser-navigation.test.ts tests/s14-web-enhance.test.ts tests/s14-web-ui.test.ts tests/s14-authority.test.ts`, `bun run typecheck` and `git diff --check`.
4. Keep local fixture scripts/captures/manifests private under ignored `.local/plain14-02/`; publish only safe attributable summaries. No real provider, account, browser website session or external effect is needed.

## Requirements

Existing S14-AC03/13; FR-06/24/25; NFR-07/11/13; ADR 0062 and the approved Plain mode-reset decision. No new FR/NFR or device gate.

## Blocked by

No code dependency prevents triage. Fix implementation requires separate owner authorization, an issue-specific branch/base selected against the then-current Plain work, and ownership checks. Do not change PR #310 or its branch from the #309 evidence branch.

## Contracts used/delivered

Existing authenticated `message.post` versus `work.start`, text-only local draft storage and committed receipts. Delivers a narrow correction, not new execution or effect authority.

## Out of scope

Redesign, schema/runtime/provider changes, deployment/cutover, live effects, physical-device/AT certification and changing VoiceOver deferral.

## Do not

Do not interpret restored browser state as execution authority, replay a command, widen policy, add demo timers/input locks, alter the repository-wide UI/UX author policy, use implement-parallel, or merge as the implementer. The #309 author exception does not automatically authorize this fix or its UI design.

## Definition of done

The targeted checks and actual history reproduction pass on a named new source/asset revision, evidence states remaining limits, and review is complete. An eventual fix PR body must contain `Closes #311`; it must not close #309/#308/#307. No merge by the implementer.
