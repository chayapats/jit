# S14 Plain UI implementation evidence

Status: local implementation ready for owner review, 2026-11-02. No deployment or owner-host cutover is certified by this record.

Published implementation: [`388c119773bcb1244912fa70ec3ec67b5cd0544d`](https://github.com/chayapats/jit/commit/388c119773bcb1244912fa70ec3ec67b5cd0544d), on `t3/plain-handoff-scope-review`, pending PR/review/merge. Tracking was published after that push: [parent #307](https://github.com/chayapats/jit/issues/307), [implementation #308](https://github.com/chayapats/jit/issues/308) and [coverage triage #309](https://github.com/chayapats/jit/issues/309). These links do not change the tested source, evidence scope or prior owner deferrals.

Base commit: `88b7f0775c8537b9dee55b71884790a818a3cbe0`. Validation was performed on the working tree based on this commit; the source/test fingerprint identifies the tested implementation independently of its eventual commit. Final source/test fingerprint: `f29f7b047d6b56bd38a9d0929b41ca674f50c8a1ad06372efb4af0c0bdb93fb4`. Per-file hashes, browser asset hashes and captures are retained in the ignored `.local/plain-qa/` record on the validation machine; this is not a hosted or portable device-evidence package.

## Delivered scope

The owner approved replacement of the whole S14 UI, a task-specific author exception, Study02 visuals with the broader Plain flow reference, and no old renderer or UI compatibility layer. The implementation preserves the current service authority contracts and feature routes. Bots/conversations and cross-Bot Work are primary; grouped secondary navigation retains memory, routines, sharing, recovery, Bot lifecycle/computers, coding/Git, personal accounts, backups and settings.

The root opens the browser's last Jit conversation. Explicit conversation creation and deep links remain explicit. Chat starts no work; Work submission is visibly named and its scope summary follows actual selected controls. Native no-script forms show the full scope. Draft text persists per browser for 30 days after last edit, with visible storage failure and no silent eviction of unexpired drafts. It cannot restore mode, tools/resources, limits, revisions or approvals. Exact committed receipts clear successfully submitted drafts. Cached-page history refreshes current authority through GET without replaying a command.

See [the approved design](../design/S14-plain-experience.md) and [ADR 0062](../adr/0062-s14-browser-navigation-and-drafts.md).

## Deterministic checks

- `bun run typecheck`: PASS on the final source.
- Full repository integration checkpoint, `bun test --timeout 30000`: **3190 PASS, 6 SKIP, 0 FAIL**, 3196 tests across 151 files, one snapshot and 242108 assertions. This preceded the final presentation/draft refinements below; it is not represented as a rerun of every test after those refinements.
- Final affected UI/authority check: **438 PASS, 0 FAIL**, 18 files and 9610 assertions. Command:

```text
bun test tests/s14-*ui.test.ts tests/s14-web-memory.test.ts tests/s14-web-enhance.test.ts tests/s14-browser-drafts.test.ts tests/s14-browser-navigation.test.ts tests/s14-authority.test.ts tests/web-token-lint.test.ts
```

- `git diff --check`: PASS.
- Tests cover Chat versus Work, task acceptance, exact hash/revision-bound approval, unknown outcomes, scoped Stop and settlement, stale/refused forms, lifecycle withdrawal, no-script commands, current resource selection, local-draft expiry/isolation/poisoning/storage denial/credential-pattern screening/receipt cleanup/history return, navigation-cookie validation and palette contrast.
- Home attention assertions were moved to the chosen Work hub, with root links/counts still checked. A deleted Bot's accepted historical proposal no longer links back to the deleted Bot.

## Browser observations

Chrome/156.0.8078.74 on macOS, headless, fresh temporary profile and a real authenticated local S14 handler/store with scripted Chat/Work/Parallel ports. No real provider, private website, account connection or external send was used.

- **460 page loads**: 23 current surfaces, Thai/English, Light/Dark, widths 320/390/430/820/1280 px. No document/checked-region horizontal overflow, missing labelled-by target, console error or runtime exception was observed in this matrix.
- Local draft survived a full-page details return, restored Chat, and cleared only after the service's committed message receipt. No Work was started by browsing or restoring.
- Native no-script input plus one explicit Work submit created exactly one work item under the normal typed boundary.
- Mobile navigation opened within the viewport; Escape closed it and returned focus to the disclosure. With 105 additional conversations, desktop management remained reachable and the older Jit conversation remained selectable.
- A 390 by 320 viewport with emulated reduced motion and forced colours retained the thread/composer without horizontal overflow.
- Additional generic exact-approval and unknown-effect pages used a separately authenticated fixture with a fake performer and two finite capacity slots. Unknown offered no execution/retry control. This is presentation evidence, not a live send or concrete Google/Git adapter certification.
- PNG samples and JSON observations are retained locally. The browser process, fixture server, profile and temporary application state were cleaned up.

## Open evidence and practical limits

Physical iPhone/Android, actual Safari, on-screen keyboards, touch, screen-reader speech, production providers/effects and owner-host deployment were not tested in this change. Viewport emulation and fixture success do not establish those cases. Prior evidence remains attributed to its original builds. These are disclosed coverage limits, not invented passes or additional implicit release gates.

Browser data may be cleared by the browser or explicit logout. Public credential-pattern screening is not a detector for every arbitrary unlabelled secret. Connection/password/OAuth/computer-input and approval forms never autosave; server credential validation and all current authority barriers remain unchanged. No application schema, supported Schway pin or execution/network policy changed.


## Plain review corrections — 2026-11-02

The owner authorized fixes, CI/Greptile babysitting and merge after successful review. PR #310 also resolves PLAIN14-03 #311. Historical failures and their tested revisions remain unchanged.

- Root live reads are pinned to the displayed conversation's explicit route, and a response for a different conversation is rejected before any message/form/revision update. Shared last-room preference cookies cannot retarget an existing tab.
- Progress has independent primary and detail refresh regions. Opening or focusing its disclosure does not freeze results, approvals or status, and the disclosure/summary node is retained.
- Lifecycle page-memory draft restoration recalculates send labels and the selected scope after restoring current fields, without copying hidden revisions/retry IDs.
- Native ordinary back/forward restoration resets Work after the browser restores form controls; cached pages retain the read-only reload boundary. Approved text remains and no command is replayed.

Validation on the corrected working tree: `bun run typecheck`, `git diff --check` and the affected command above passed: **443 tests, 0 failures**, 18 files and 9642 assertions. Headless Chrome/156.0.8078.74 against an isolated authenticated local handler/store passed five observations: shared-cookie root pinning, three native history Back traversals (retained text, Chat mode and matching accessible send label), and completion/result updates with Progress open and its summary still focused. The runner used scripted ports and no real provider/effect; this is not physical-device, Safari, touch/OSK or AT-speech proof. Runner, safe summaries and served asset identifiers are retained in ignored `.local/plain-review/`; the fixture, browser and profile were cleaned up. The original source fingerprint above identifies the earlier build, not these corrections.


## Plain Library and inline Work — 2026-11-02

Owner-authorized PLAIN14-04 #313 and PLAIN14-05 #314 restore explicit delivery of the cross-work Library and inline Work flows recorded in the earlier handoff. Library is a grouped knowledge destination; Bots/conversations and Work remain primary. Reports/Files preserve exact revisions, producing Bots/Work, independent coverage/review facts and the existing authenticated download gateway. The catalog is cursor-paginated (20 by default, maximum 50); inline report projection covers the newest 24 granted work items, with up to eight source identities previewed and full detail links retained.

Conversation cards now expose current results, report/source/file facts, limitations and existing exact generic/personal decisions. Git still requires the immutable diff/check page. The selected Progress pane owns its exact controls. Each inline work has a primary refresh region outside its receipt disclosure; focused controls retain their state. Real source withdrawal was exercised and withheld both inline/catalog payloads and usable downloads.

Validation source is frozen at `3808c09882a070d5f19c792d42cde2aa0dd89cf6`, including the parent spacing correction `9171a7b`. Source/test SHA-256 fingerprint: `e41dedf4b42d3dae8d0cc01f2bf0fc7c1f375223e788e0b5ab1baab21fd4325c` (canonical sorted JSON map of SHA-256 per file for the 29 changed source/test files relative to `88b7f07`). The per-file manifest and ignored runners/captures remain local under `.local/plain14-frozen/`.

An affected integration checkpoint passed **516 tests, 0 failures**, 21 files/10267 assertions, including existing report/lineage/authority/UI checks. Subsequent focused cases cover catalog bounds/authentication/cursor insertion stability, cross-Bot output provenance, real source withdrawal, inline generic/unknown effects, multiple cards plus a report pane, live-region focus retention, and exact Git/personal control boundaries. Final frozen-source checks and browser observations are recorded below; the earlier 516 count is not a claimed rerun of every check after the final small query/localized-label/layout refinements.

Browser checkpoint: **520 page loads** over 26 surfaces, Thai/English, light/dark and widths 320/390/430/820/1280, using headless Chrome/156.0.8078.74 and an isolated authenticated scripted local handler/store. No tested overflow, missing labelled-by target, console error or runtime exception was observed. A smaller frozen-source follow-up checks Library/report/file pages and the conversation in both languages/themes at 390/1280. This is desktop automation/viewport evidence, not physical-device/touch/OSK, Safari or screen-reader speech proof. Prior failures and deferrals remain attributed to their original builds, and no provider/effect/deployment/cutover was performed.


Frozen-source result: **28 focused feature/live-region tests passed** (three files, 232 assertions), plus **3 exact Git/personal control cases passed** (two files, 119 assertions); `bun run typecheck` and `git diff --check` passed. The focused command was `bun test tests/s14-library.test.ts tests/s14-inline-work.test.ts tests/s14-web-enhance.test.ts`; exact-control cases used `bun test tests/s14-coding-ui.test.ts tests/s14-personal-ui.test.ts -t 'the exact card binds|unknown delivery is reconcile-only'`. Final Chrome follow-up passed **32 page loads with zero checked errors** on the frozen source, with all 29 source/test hashes verified unchanged afterward. Local PNG inspection included the Thai mobile Library and desktop dark Files views. Fixture, browser, server and temporary profile were cleaned up. No later-head/device/AT certification is inferred.
