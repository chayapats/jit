# S14 Plain UI implementation evidence

Status: source PRs #310/#315 are merged; final documentation-only #312 review remains open, 2026-11-02. The evidence below retains its named historical source/build checkpoints. The #311 history-return failure was subsequently corrected by reviewed #310; its original failed observation is preserved. No deployment, later-build device/AT or owner-host cutover is certified by this record.

Original publication checkpoint (historical): [`388c119773bcb1244912fa70ec3ec67b5cd0544d`](https://github.com/chayapats/jit/commit/388c119773bcb1244912fa70ec3ec67b5cd0544d), on `t3/plain-handoff-scope-review`; [PR #310](https://github.com/chayapats/jit/pull/310) is OPEN against `main`, with tracking-only head `1844be4309c3f5670ffa2c217350682c892823a3`. Tracking was published after the implementation push: [parent #307](https://github.com/chayapats/jit/issues/307), [implementation #308](https://github.com/chayapats/jit/issues/308) and [coverage #309](https://github.com/chayapats/jit/issues/309). These links do not change the tested source, evidence scope or prior owner deferrals.

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

## Original implementation browser observations

Chrome/156.0.8078.74 on macOS, headless, fresh temporary profile and a real authenticated local S14 handler/store with scripted Chat/Work/Parallel ports. No real provider, private website, account connection or external send was used.

- **460 page loads**: 23 current surfaces, Thai/English, Light/Dark, widths 320/390/430/820/1280 px. No document/checked-region horizontal overflow, missing labelled-by target, console error or runtime exception was observed in this matrix.
- Local draft survived a full-page details return, restored Chat, and cleared only after the service's committed message receipt. No Work was started by browsing or restoring.
- Native no-script input plus one explicit Work submit created exactly one work item under the normal typed boundary.
- Mobile navigation opened within the viewport; Escape closed it and returned focus to the disclosure. With 105 additional conversations, desktop management remained reachable and the older Jit conversation remained selectable.
- A 390 by 320 viewport with emulated reduced motion and forced colours retained the thread/composer without horizontal overflow.
- Additional generic exact-approval and unknown-effect pages used a separately authenticated fixture with a fake performer and two finite capacity slots. Unknown offered no execution/retry control. This is presentation evidence, not a live send or concrete Google/Git adapter certification.
- PNG samples and JSON observations are retained locally. The browser process, fixture server, profile and temporary application state were cleaned up.

## Open evidence and practical limits

At the original implementation checkpoint, physical iPhone/Android, actual Safari, on-screen keyboards, touch, screen-reader speech, production providers/effects and owner-host deployment were not tested. The #309 observations below add a limited actual Safari AX sample, with its input/layout blocks retained. Viewport emulation and fixture success do not establish physical-device or speech cases. Prior evidence remains attributed to its original builds. These are disclosed coverage limits, not invented passes or additional implicit release gates.

Browser data may be cleared by the browser or explicit logout. Public credential-pattern screening is not a detector for every arbitrary unlabelled secret. Connection/password/OAuth/computer-input and approval forms never autosave; server credential validation and all current authority barriers remain unchanged. No application schema, supported Schway pin or execution/network policy changed.

## PLAIN14-02 bounded local coverage — 2026-11-02

### Decision, ownership and tested build

**Confirmed:** the owner authorized bounded local evidence for #309, a task-specific UI/UX author exception, commit/push and a stacked evidence PR. The launch-bound branch is `t3/plain14-02-device-coverage`, initially clean at `1844be4309c3f5670ffa2c217350682c892823a3`, directly above implementation `388c119773bcb1244912fa70ec3ec67b5cd0544d`. Before edits, #309 had no assignee/comments, no competing #309 PR/branch was found, and PR #310 remained OPEN on the separate implementation branch. This work changes documentation only and does not take over #310.

Evidence review is [PR #312](https://github.com/chayapats/jit/pull/312), OPEN against `t3/plain-handoff-scope-review` while #310 remains unmerged. Its body contains `Closes #309` only; actual closure remains pending reviewed integration into the default branch. No issue was closed by fixture success.

The tested runtime is exactly `388c119` at checkout `1844be4`. All **22 per-file source/test hashes** in the original fingerprint manifest matched the current files; `git diff 388c119..1844be4 -- src tests` is empty. The original source/test fingerprint remains `f29f7b047d6b56bd38a9d0929b41ca674f50c8a1ad06372efb4af0c0bdb93fb4`. Served S14 assets were `/assets/s14.fa3b0cd6f2eb420a.css` and `/assets/s14.b4a7196b19fe1f3b.js`. This record does not certify a later source or asset revision.

The owner subsequently confirmed that no safe physical-iPhone route/observer is available **this round**: physical iPhone/touch/on-screen keyboard remain **NOT RUN**, with no network/origin expansion. The earlier owner-deferred VoiceOver decision remains in force. No exhaustive device/AT permutation is selected or introduced as a release gate.

### Capability inventory and selected route

| Capability | Actual inventory / observer | Selected scope and limit |
| --- | --- | --- |
| Host | macOS 27.2 (26B123), arm64; Bun 1.4.2 | Local fixture only; no owner-host cutover/deployment |
| T3 incognito preview | Chromium 152.0.7977.169 / Electron 44.10.0; `maxTouchPoints=0` | Login/root/deep-link observed. Two snapshots timed out; selected CSS size later verified as 390 × 844 by DOM. Closed before fallback. Not Safari/device evidence. |
| Standalone Chrome | Chrome/156.0.8078.74, headless, isolated fresh profiles | CDP mouse/keyboard/text injection and DOM/PNG/service observations; desktop CSS 1280 × 800 and narrow CSS 390 × 844, plus one 390 × 320 sample. `mobile:false`; no touch, physical keyboard, OSK or real IME claim. |
| Actual Safari | Safari 27.2 (22625.2.8.11.9), new native Private Browsing window; macOS CUA AX observer | Limited authenticated EN/light root/Work/More and empty-chat Back sample after observer recovery. Native geometry and layout not verified. AX is not screen-reader speech. |
| Safari WebDriver | Driver status ready, session creation refused | **BLOCKED** by disabled Allow remote automation; no setting changed. Native AX observations do not count as a driver run. |
| Physical iPhone | A paired physical iPhone 17 was discoverable; no booted iOS simulator | **NOT RUN**, owner-confirmed for this round. Pairing does not establish a fixture route or capable touch/OSK observer. Device identifiers are not published. |
| Android / AT | No selected Android route or speech observer; VoiceOver owner-deferred | **NOT RUN**; no NVDA/VoiceOver speech, new-reply/error announcement or full pixel-desktop AT claim |

The route was one ephemeral **loopback-only authenticated S14 fixture**, with its installation-specific origin/IDs kept in ignored `.local/plain14-02/manifest.json`. It used the shipped `S14Application`, `S14Store`, `createS14Handler`, `renderS14` and `createS14Product`; it was not a static demo or production composition root. The store lived only in this worktree's ignored `.local/plain14-02/state/`. Chat and Work ports were scripted, service time was fixed, and no worker pump ran without explicit fixture control. A fake generic send performer called its guard and returned unknown without network I/O. No concrete Google/Git provider, computer, private website/account or external send/push/calendar action was used.

Fixture identities below are symbolic: C is the original Jit conversation, C2 a second Jit conversation, Scout a separate Bot conversation, W a retained result, T a proposed task, E an exact pending card, U a seeded unknown card, A the named held Stop target and B unrelated held work. Navigation reads and mode changes are distinct from deliberately seeded fixture state and explicit owner-form submissions.

### Selected observations

Chrome's first run was EN/system-dark with one TH/dark sample; its second fresh profile used EN/light. This is selected coverage, not a complete locale/theme matrix. Browser observations ran at 00:58–01:00 UTC; native Safari AX recovery/sample followed at 01:02–01:05 UTC on the same source/assets. The original 438-test and 460-load results above are retained historical evidence, not reruns in #309.

| Case | Route / action | Result and evidence boundary |
| --- | --- | --- |
| P01 navigation | `/`, `/chats/C`, `/chats/C2`, `/chats/Scout` | **OBSERVED:** root first selected latest Jit C2, remembered an explicit visit to C, and did not replace the Jit preference after visiting Scout. No conversation/grant was created by these reads. |
| P02 navigation/focus | `/more`; narrow navigation disclosure | **OBSERVED:** grouped secondary destinations remained exposed. At 390 × 844 the open panel occupied x=12..378; Escape closed it and focus returned to its disclosure after Tab entered the menu. Automated desktop input, not touch. |
| P03 composer/reload | C; injected Thai/English text, completion/evidence text, Work/Scout/tool/limit changes; reload | **OBSERVED:** selected scope/send wording followed actual controls; selection started no work. Reload retained all three approved text fields, restored Chat/default current controls, and issued no POST. Numeric input caveat below. |
| P04 details/return | C → `/chats/C?work=W` → close link | **OBSERVED after re-check:** 390 px details replaced the conversation; the icon link had `aria-label="Close the work pane"` and returned directly to C. Draft remained, Chat/default limits returned. W was ordinary retained result text, explicitly not a committed report. |
| P05 focus/input | C textarea → Tab → Bot link → Shift+Tab | **OBSERVED:** focus returned to the textarea within the viewport; its focused composer border/shadow was visible in the EN/light PNG/computed styles. The textarea itself has no outline. Not an exhaustive keyboard walk, IME or AT speech result. |
| P06 draft/history | C → W → browser Back; C → C2 | **FAILED history mode reset:** text survived, but Chrome restored Work and left send accessible wording stale; see #311 below. Separate C2 remained empty. No automatic POST/new grant occurred. |
| P07 submission | C Chat submit, then stale-revision Chat submit | **OBSERVED:** matching committed Chat receipt cleared the pending draft and returned Chat. Deliberately stale submit returned HTTP 409 and retained the typed/local draft. Neither created a work grant. |
| P08 acceptance | `/work/T`, Accept as a task | **OBSERVED:** UI said Accepted, not started; T had `grantId:null`, five seeded grants remained five, and executor count remained one before the separately controlled drain. No execution followed acceptance. |
| P09 authority states | `/effects/E`, `/effects/U` | **OBSERVED:** destination/content/revision/hash/expiry were readable; both decision envelopes matched E's current revision/hash. U exposed only the labelled owner-statement reconciliation form and no approve/retry/resend control. No card decision, resend or reconciliation was submitted in these observations. Fake-send count stayed one from U's seeding. Not a concrete adapter or live single-use-send certification. |
| P10 Stop/settlement | `/work/A`; explicit Stop; manually release A's held scripted transport | **OBSERVED:** A became Stopping with revoked authority and explicit open-call settlement wording; B remained running/unrevoked. Only after A's transport resolved did A become Stopped; its late result was absent, while B remained running. B settled separately during fixture cleanup. |
| P11 constrained height | C, TH/dark, 390 × 320 with textarea focused | **OBSERVED:** document width 390, dock y≈172.4..320, height≈147.6. This is CSS viewport constraint only; no physical OSK/visualViewport or touch result. |
| R05 browser restart | Same isolated Chrome profile, complete browser process exit/relaunch, reauthenticate, `/` | **OBSERVED:** retained the selected Jit conversation and local draft, restored Chat, and did not submit automatically. This is a controlled normal restart, not crash/disk-loss/30-day elapsed-time proof. |
| S01–S04 actual Safari | Authenticated `/`, Work checkbox, `/work`, native toolbar Back, `/more` | **OBSERVED AX only:** checkbox 0/Send message → checkbox 1/Start bounded work with limits 2/30/40; Work exposed pending/unknown, accepted-not-started, ready/stopped rows. One Back to the same empty C2 restored checkbox 0/Send message. More exposed the grouped destinations. No submit/new grant/execution. This does not reproduce or clear Chrome's drafted-history defect. |
| S05 actual Safari input/layout | Composer click/type/Tab, paste and AX value attempts | **OBSERVER-INCONCLUSIVE:** intended text/focus movement could not be confirmed; AX retained placeholder/generic text-entry values and the screenshot was unusable. No Safari draft persistence, detailed focus walk, geometry/layout pass or product-input failure is inferred. |

### Confirmed defect and preserved failed attempts

[PLAIN14-03 #311](https://github.com/chayapats/jit/issues/311) records the concrete history defect separately, under #307. On the exact build above, in fresh headless Chrome EN/light at 390 × 844: type a harmless draft in C, select Work, navigate to `/work/W`, and use browser Back without reload/submission. The runner used `Page.navigateToHistoryEntry`. After load plus 400 ms, **three of three re-check traversals** retained `input[name=work].checked === true`, visible Work/budget and a visible Start bounded work control, while its `aria-label` remained `Send message` and the restored-draft notice told the user to choose Work again. Navigation timing was `back_forward`. Text remained; no POST, grant or execution followed Back. The first runner independently recorded the same mismatch.

This contradicts the approved Plain Chat reset and ADR 0062's history boundary (S14-AC03/13, FR-06/24/25, NFR-07/11/13). It is a confirmed mode/accessible-label defect, not demonstrated service authorization bypass or remote execution. The asset's `pageshow.persisted` guards are an investigation lead; browser event ordering/cache causation was not established. #311 is needs-triage, separately awaiting implementation authorization; no product fix is included here. The original implementation's narrower successful history check remains historical and cannot negate this reproduction.

The first runner also had two **harness** failures, retained in its raw record: select-all did not replace numeric 30 (the observed value was 370, not expected 7), and a text-only Back-link selector missed the correctly labelled icon close link. The re-check used an explicitly set fixture value 7 and the observed `.s-pane-hdr a[aria-label]`; detail return reset it to 30 and preserved text. These re-checks do not certify physical numeric keyboard input. No product defect is inferred from those two runner mistakes.

### Blocks, deferrals and remaining limits

| Target / action | Status / reason | Precise missing input for further evidence |
| --- | --- | --- |
| T3 preview snapshots | **BLOCKED observer:** two `Preview automation snapshot timed out after 15000ms.` errors; initial invalid `about:blank` open was a runner URL mistake, corrected by a blank-tab open | Working snapshot path if this observer is selected again; standalone Chrome records do not repair the failures |
| Actual Safari WebDriver | **BLOCKED:** `session not created`; driver required enabling Allow remote automation | A separately selected, available automation route; no permission/setting change was made |
| Native Safari input/focus/layout | **PARTIAL / observer-inconclusive:** initial `-10005` / ScreenCaptureKit `Code=-3812` invalid-parameter errors; CUA reset restored AX navigation but not verified composer input or a usable capture | Observer that can verify actual entered text/focus and native geometry; no invented Safari pass or product failure |
| Physical iPhone/touch/OSK | **NOT RUN**, owner confirmed unavailable this round | Named safe existing route and capable physical observer if later selected; pairing alone is insufficient |
| VoiceOver speech/new-reply/error | **NOT RUN / owner-deferred** | Explicit owner change to the deferral before selection, plus a capable speech observer; no mandatory observation is pending |
| Other permutations | **UNRUN:** Android, Safari narrow/TH/dark/draft/restart, real IME, physical keyboard, reduced-motion/forced-colours OS settings, long transcript/full focus walk, concrete Git/Google effects, providers, deployment/cutover | A separately bounded authorized observation, not an exhaustive new gate |

**Recommendation:** review the bounded evidence and triage #311 before describing history reset as verified. Any implementation fix needs its own authorization/current branch review; this evidence ticket is not redesign permission. **Open:** #310 implementation review/merge and owner acceptance remain separate; #309 remains open pending evidence review. Required behavior, proposed causal explanations and coverage deferrals are distinct.

### Local reproducibility and custody

The ignored fixture and observer scripts are `fixture.ts` and `observe.ts` under this worktree's `.local/plain14-02/`; they are not product assets. To reconstruct safely, use a new disposable store and authenticated loopback handler on the exact source above. Seed the symbolic C/C2/Scout/W/T/E/U/A/B states through the existing fixture/service seams described above, with scripted ports, finite grants, a fixed clock and manually released transport barriers. Use real login/session/Origin/CSRF/form handling. Record current source/assets and actual browser before the selected route/input sequence in the table. Never substitute a real performer/provider or expose the origin to a device to fill a gap.

The original run wrote `observations.json` (26 labelled records, including its three failed assertions); the second fresh profile wrote `followup-observations.json` (13 records, including three **observed failing** history states, which are not encoded as passing assertions). `safari-observer-notes.json` records only the bounded native AX observations and observer failures, not a portable capture. Service snapshots, PNGs, the run manifest and artifact hashes remain ignored/local; only safe summaries and digests are published. Retained SHA-256 identifiers:

| Local artifact | SHA-256 |
| --- | --- |
| `fixture.ts` | `ad54eefedd19447ffe4584d682d79382ad180c189aa330782fcb1e4e724420bb` |
| `observe.ts` (final script, including re-check branch) | `bf7041f3145db6b8b8f9be30a8483f6dd355cd869d98426074ab62357775bd1b` |
| `observations.json` | `74427d4cf27715d01ea853e560ffe671cf7fe9339b94f8b6fb2d3bf22221ad33` |
| `followup-observations.json` | `e321cb36feeca3ceba2bc21b53e0da94a8aa7eb5c2220a5ac50ecf6e3701d49b` |
| `history-followup-1.png` (same bytes for traversals 2/3) | `00b5cd5859a81e49d5b25fc6f9e6e0895ee465ee5afa9205e7f3773b4287a297` |

Cleanup verified: both standalone Chrome profiles/processes were removed/closed, the T3 preview tab and task-owned Safari Private Browsing window were closed, the fixture server stopped and its disposable state directory was removed. Safari itself and unrelated windows were retained; no installation/legacy state was touched. Service counters were unchanged by the Safari navigation sample (five seeded grants, two scripted chat replies, five explicitly drained executions, one fake unknown effect). Documentation validation is `git diff --check`, local link/digest checks and exact issue-mirror checks; no new product suite/full-matrix run is claimed.

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


PR #315 review corrections: a new accepted-report UI assertion failed in both locales before correcting the shared status renderer to reuse the existing exact-revision acceptance copy. Library provenance now uses one owner-checked projection of only work ID/title/conversation, rather than loading unused attempt/effect/result histories; a regression refuses full-history reads from that projection and checks authentication. After these corrections, **29 focused tests/243 assertions**, typecheck and diff check pass. Corrected source/test fingerprint: `87156a46f39ec2d48a411a6c8550292f9cc7e1d37dd42158681d91a8882bf47f`. The earlier browser matrices and frozen fingerprint remain attributed to their earlier checkpoint; no later-head device/AT result is inferred. Current-head full CI and Greptile review were required and subsequently passed on `0db140af444e0a8dd960da1746d3d6206089eee0`: typecheck, all six test shards, deterministic aggregate and Greptile 5/5 APPROVED; no unresolved review threads remained before merge.


## Evidence integration checkpoint — 2026-11-02

Source PR #310 merged at `b6982767d15fc7bdec68a526b88156405bd3a57a`, after all CI checks and Greptile 5/5 APPROVED on `9171a7b`, closing #308/#311. Output-flow PR #315 merged at `c1a96edebba4025e1ebcd09a8e133dacda0c9887` after all CI checks and Greptile 5/5 APPROVED on `0db140af444e0a8dd960da1746d3d6206089eee0`, closing #313/#314. PR #312 now targets main for documentation/evidence integration only; its source/test tree is identical to merged #315. Its closing references cover bounded evidence #309 and parent #307 after final reviewed merge.

The recorded #309 observations still belong to checkout `1844be4` and runtime `388c119`, with all original failures, partial Safari observations and deferrals intact. No history failure is rewritten as a pass, and no source update implies deployment or later-build device/AT certification. The workflow intentionally skips docs-only changes; this integration validates diff whitespace, JSON, local links, ticket-mirror parity, revision identities and source/test tree equality rather than claiming a runtime-suite rerun.
