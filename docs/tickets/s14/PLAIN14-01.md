<!-- jit-ticket:PLAIN14-01:v1 -->

## Parent

https://github.com/chayapats/jit/issues/307

## Model tier

Frontier: replacing presentation across authority-sensitive forms and introducing untrusted browser state requires contract and security judgment.

## Status and ownership

Implemented on the existing task-owned branch [`t3/plain-handoff-scope-review`](https://github.com/chayapats/jit/tree/t3/plain-handoff-scope-review), commit [`388c119773bcb1244912fa70ec3ec67b5cd0544d`](https://github.com/chayapats/jit/commit/388c119773bcb1244912fa70ec3ec67b5cd0544d). Published retrospectively on 2026-11-02 after that commit was pushed. No PR existed at publication; `main` was still `88b7f0775c8537b9dee55b71884790a818a3cbe0`. No competing Plain issue, open issue assignment or PR was found. Do not start a duplicate implementation or rename/recreate the existing branch merely for this tracker. Review/merge and owner acceptance remain pending; this is not ready-for-agent work.

## Context to read

At the implementation revision above: `AGENTS.md`, `CONTEXT.md`, `docs/agents/workflow.md`, `docs/specs/S14-bot-first-local-assistant.md`, `docs/design/S14-plain-experience.md`, `docs/contracts/s14-authority-and-design-resolutions.md`, `docs/contracts/s14-foundation-http.md`, ADRs 0045–0048 and the applicable accepted S14 refinements, especially `docs/adr/0062-s14-browser-navigation-and-drafts.md`. The owner approved the task-specific UI/UX author exception; the repository-wide policy is otherwise unchanged.

## Deliverable

A conversation-first Plain S14 experience using the approved references, preserving current capabilities and authority contracts, with per-browser last-Jit navigation and 30-day text-only draft recovery. Direct replacement is owner-approved; no old renderer/feature flag/UI compatibility layer is required.

## Implementation steps

1. Preserve actual route/command/feature parity from Jit, using demos only for the approved visual/flow direction.
2. Apply S14-specific tokens and responsive layouts in `src/s14/web-design.ts`, `web-style.ts`, the shared S14 style modules and `web-pages.ts`; preserve shared legacy tokens. Keep Bots/conversations and Work primary and management discoverable.
3. In `src/s14/web-product.ts` and `web.ts`, validate the non-authorizing last-Jit preference against authenticated current conversations. Keep creation explicit and deep links direct. Expose successful submission receipts only after durable kind/conversation verification.
4. In `src/s14/web-enhance.js` and `web-assets.ts`, persist only approved composer text, last-edit time and matching pending receipt ID. Enforce 30-day expiry, namespace isolation, validation, public credential-pattern screening, visible storage failure and committed-receipt cleanup. Restore no grants, revisions, modes or approvals; replay no command.
5. Retain script-free command forms, current scope summaries, exact approval/unknown/Stop states and labelled Thai/English accessible controls. Add matching keys in `src/i18n/en.ts` and `src/i18n/th.ts`.
6. Keep deterministic tests and the revision-labelled evidence record synchronized; review the existing implementation before proposing any additional changes.
7. Prepare a PR only when requested, run its applicable checks, obtain review and merge through the normal owner process. This issue does not itself authorize merge/deployment.

Steps 1–5 are delivered in the linked commit. Step 6's recorded checks are complete within their stated scope; step 7 is pending.

## Acceptance criteria

- [x] Root uses the validated last Jit conversation per browser; explicit conversation creation and deep links retain their behavior.
- [x] Bots/conversations and cross-Bot Work are primary. Memory, Routines, sharing, recovery, lifecycle/computers, coding/Git, personal accounts, backups and settings remain reachable.
- [x] Successful submission/room/Bot changes reset the mode to Chat. Mode selection/restoration starts nothing; mobile details have a direct return path.
- [x] Drafts retain approved text for 30 days after last edit, without cross-device sync or silent eviction of unexpired drafts; storage failure is visible. Credential/approval/computer-input forms never autosave.
- [x] Untrusted cookie/storage/URL state cannot restore authority, assert a committed outcome or automatically resubmit. Only a matching durable committed receipt clears a pending draft.
- [x] Chat versus Work, task acceptance versus execution, exact external approval, scoped Stop/settlement and reconcile-only unknown outcomes remain covered by deterministic checks.
- [x] Native no-script forms, CSP/session/Host/Origin/CSRF barriers, escaping, Thai/English, light/dark and responsive states remain covered by the recorded checks.
- [ ] Proposed PR receives applicable CI and code/contract review; any findings are resolved within the approved scope.
- [ ] Reviewed change is merged, with owner acceptance recorded separately from tests and merge.

## Tests and evidence

1. [Canonical evidence](https://github.com/chayapats/jit/blob/388c119773bcb1244912fa70ec3ec67b5cd0544d/docs/evidence/s14-plain-ui.md): source/test fingerprint `f29f7b047d6b56bd38a9d0929b41ca674f50c8a1ad06372efb4af0c0bdb93fb4`.
2. Full integration checkpoint: `bun test --timeout 30000` → 3190 pass, 6 skip, 0 fail across 151 files. This preceded the final presentation/draft refinements; do not report it as a full-suite rerun after those refinements.
3. Final affected suite: `bun test tests/s14-*ui.test.ts tests/s14-web-memory.test.ts tests/s14-web-enhance.test.ts tests/s14-browser-drafts.test.ts tests/s14-browser-navigation.test.ts tests/s14-authority.test.ts tests/web-token-lint.test.ts` → 438 pass, 0 fail across 18 files. Final `bun run typecheck` and `git diff --check` passed.
4. Browser-state cases: malformed/duplicate/other-Bot cookie → safe fallback; explicit deep link → named conversation; malformed/future/expired/oversized/credential-shaped draft → discard; storage denial → visible failure without disabled submit; stale/forged receipt → retain draft; matching committed receipt → clear; history return → current read-only GET with no command replay.
5. Authority cases: Chat/task acceptance → no execution; explicit Work submit → once under current finite grant; stale/denied approval → no effect; unknown → reconciliation only; scoped Stop → existing fencing/settlement semantics.
6. Chrome 156 authenticated local scripted fixture: 460 page loads (23 surfaces × two languages × two themes × five widths), no tested overflow/missing labelled-by target/console/runtime errors. Native no-script Work submission created exactly one item. This used no real provider/account/external send.
7. Physical devices, actual Safari, touch/on-screen keyboard and screen-reader speech were not run for this replacement. Prior-build evidence stays attributed to its build; [coverage ticket #309](https://github.com/chayapats/jit/issues/309) records these limits without inventing a release gate.

## Requirements

S14-AC13; FR-10/23/24/25; NFR-07/11/13. Preserve S14-D04/06/11/16 and AC03/05/09/11/12, including their existing FR/NFR mappings.

## Blocked by

No unresolved implementation prerequisite was found for the delivered scope. The closed baseline #244 is a reference, not a new blocker. Review/CI/merge are outstanding completion steps. Remaining device/AT coverage is separately labelled and is not silently promoted to a merge/release prerequisite.

## Contracts used/delivered

Uses current S14 typed HTTP/service commands, authority boundaries, durable receipts and supported public Schway surface. ADR 0062 adds only non-authorizing browser navigation and local text storage. No schema, Schway pin, external adapter, execution/network policy or owner-host cutover contract changes.

## Out of scope

Deployment, live provider/account/effect certification, old UI compatibility, legacy runtime redesign, cross-device draft sync, new product capabilities and unapproved scope expansion.

## Do not

Do not remove capabilities missing from a demo; import synthetic state/timers/cursors/playback/input-lock policy; treat task acceptance as execution; infer approval from model/source text; restore authority controls from storage; retry unknown effects; persist credentials; use implement-parallel; merge as the implementer; or add AI attribution to repository/GitHub text. Ask only about genuinely additional scope before expanding it.

## Definition of done

The applicable final-source typecheck, affected test command above and `git diff --check` pass; CI/review findings are resolved and evidence names the actual tested revision. The eventual PR body must contain `Closes #308`. No merge by the implementer. Record merge and owner acceptance accurately; do not close based solely on a passing test response or a pushed branch.
