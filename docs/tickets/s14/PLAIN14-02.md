<!-- jit-ticket:PLAIN14-02:v1 -->

## Parent

https://github.com/chayapats/jit/issues/307

## Model tier

Frontier: distinguishing actual device/accessibility observations from fixture proof and preserving approval/Stop/unknown semantics requires judgment about evidence and authority boundaries.

Implementation review is tracked separately in https://github.com/chayapats/jit/issues/308.

## Status

Bounded local evidence recorded on 2026-11-02; OPEN, needs-triage, pending evidence review. Owner-authorized work is on `t3/plain14-02-device-coverage`, stacked from `1844be4309c3f5670ffa2c217350682c892823a3` above runtime implementation `388c119773bcb1244912fa70ec3ec67b5cd0544d`. PR #310 remains OPEN against main on the separate #308 branch; it was not changed or taken over. This ticket creates no new release gate, deployment permission or live-provider/account/effect authorization. The prior owner-deferred VoiceOver decision remains in force. The owner confirmed no safe physical-iPhone route/observer is available this round; physical iPhone/touch/on-screen keyboard remain NOT RUN.

## Current evidence result

Canonical record: [docs/evidence/s14-plain-ui.md](https://github.com/chayapats/jit/blob/t3/plain14-02-device-coverage/docs/evidence/s14-plain-ui.md), section PLAIN14-02 bounded local coverage. Tested source/assets are labelled there; all 22 historical per-file source/test hashes matched, with fingerprint `f29f7b047d6b56bd38a9d0929b41ca674f50c8a1ad06372efb4af0c0bdb93fb4` unchanged. The original 438 deterministic passes/460 Chrome loads and earlier full-suite checkpoint were not rerun or promoted to device proof.

- **Confirmed:** macOS 27.2 (26B123), arm64, headless Chrome/156.0.8078.74, isolated profiles, scripted authenticated local handler/store. Selected navigation, text-only reload/detail/restart drafts, conversation isolation, committed/refused Chat submission, keyboard focus sample, acceptance without execution, exact-card envelope, reconcile-only unknown and scoped Stop through actual scripted-transport settlement were observed. CSS viewport checks are not physical touch/OSK or real IME evidence.
- **Failed:** browser history Back restored Work while the send accessible label stayed Send message. The second fresh EN/light Chrome profile reproduced it on three of three traversals; text remained and no automatic POST/grant/execution occurred. Concrete additional implementation scope is tracked separately as [PLAIN14-03 #311](https://github.com/chayapats/jit/issues/311), under #307. No product fix or redesign is included here.
- **Partial actual Safari:** Safari 27.2 native AX observed authenticated root/Work/More, Work selection/wording and one Back to Chat in an empty conversation. This was not the drafted Chrome reproduction. Native draft/focus input and geometry/layout could not be verified; no Safari draft or visual pass is claimed, and AX is not speech.
- **Blocked observers:** Safari WebDriver refused disabled Allow remote automation; native CUA initially returned ScreenCaptureKit -3812 and later recovered only the stated AX sample. Two T3 preview snapshots timed out. Exact target/action/reason/status and missing inputs are in the evidence record. No security setting changed.
- **Deferrals/limits:** physical iPhone/touch/OSK NOT RUN by this round's explicit owner decision; VoiceOver NOT RUN/owner-deferred. Android, other Safari/device/AT permutations, live effects/providers and deployment/cutover remain unrun. No exhaustive gate is inferred.
- **Recommendation/Open:** review this bounded record and triage #311 before claiming history reset is verified. #311 implementation authorization, #310 review/merge and owner acceptance remain separate. This evidence record can be reviewed without requiring every device/AT permutation.

Local fixture/server/profiles/state and the task-owned Safari/preview windows were cleaned up. Private origins, IDs, credentials and raw evidence remain in ignored `.local` records; only safe summaries/digests are tracked. Repository evidence, this issue mirror, [the Plain tracker](https://github.com/chayapats/jit/blob/t3/plain14-02-device-coverage/docs/tickets/plain14.json) and the #311 mirror agree on the tested revision, outcomes and deferrals.

## Context to read

`AGENTS.md`, `CONTEXT.md`, `docs/agents/workflow.md`, `docs/specs/S14-bot-first-local-assistant.md` (AC03/09/12/13), `docs/design/S14-plain-experience.md`, `docs/adr/0062-s14-browser-navigation-and-drafts.md`, `docs/evidence/s14-plain-ui.md`, `docs/contracts/s14-authority-and-design-resolutions.md` and `docs/contracts/s14-foundation-http.md`. Historical `docs/evidence/s14-mvp-evidence.md` and closed #244 retain their exact builds, limits and VoiceOver deferral; they do not certify the replacement.

## Deliverable

A revision-labelled coverage record separating observed replacement-build behavior, failed cases, unrun cases and explicitly deferred cases. If additional observations are chosen, define the exact authorized build/device/browser/route/observer before execution, preserve prior deferrals, and file concrete observed defects separately. No source redesign is pre-authorized by this evidence ticket.

## Implementation steps

1. Reconcile the existing Plain evidence with the implementation revision and retain the exact deterministic versus browser-fixture boundary.
2. Triage available authorized observations and explicit deferrals with the owner. Name the build/asset revision, OS, browser/device, input method, accessibility technology and observer for any chosen cases. Do not silently turn this list into an exhaustive gate.
3. On a named authorized route with safe fixtures, inspect primary/secondary navigation, conversation/detail return, keyboard focus, touch/on-screen-keyboard composer visibility and local draft recovery across the selected reload/restart/history cases. A fixture or emulation result remains labelled as such.
4. Where included in the authorized observation scope, inspect that Chat versus Work, task acceptance, exact approval, scoped Stop and unknown outcome controls are understandable and offer no accidental authority/retry path. Use controlled fixtures; do not send a real email, push code, alter a calendar or access a private session for this ticket.
5. Preserve failed/unrun/deferred observations. Record reproducible defects as scoped linked follow-ups before changing code; keep product/device coverage distinct from deployment/cutover acceptance.
6. Update the evidence document and ticket with the actual tested revision, outcomes and remaining limits. Do not certify a later build by inference.

## Acceptance criteria

- [x] A bounded coverage/deferral decision is recorded, naming any selected build/device/browser/route/observer. VoiceOver remains deferred unless the owner explicitly changes that decision.
- [x] Each selected case has an attributable observation or an explicit failed/blocked/unrun result; no emulation is described as a physical-device or speech result.
- [x] Navigation/detail return, composer/draft/history and focus/input cases are recorded for the selected coverage; omitted cases remain explicit.
- [x] Any observed authority/approval/Stop/unknown problem is reported with reproduction and current contract references; no live external effect is performed to fill an evidence gap.
- [x] Repository evidence and tracker agree on revision, outcomes, deferrals and limits. Concrete defects have separate scoped follow-ups.

## Tests and evidence

1. Baseline: [Plain evidence at implementation commit](https://github.com/chayapats/jit/blob/388c119773bcb1244912fa70ec3ec67b5cd0544d/docs/evidence/s14-plain-ui.md), source/test fingerprint `f29f7b047d6b56bd38a9d0929b41ca674f50c8a1ad06372efb4af0c0bdb93fb4`: 438 final affected deterministic passes and 460 Chrome-fixture page loads, plus the separately timed full-suite checkpoint.
2. Selected navigation/input cases → labelled actual observations, with viewport emulation distinct from physical keyboard/touch/on-screen keyboard behavior.
3. Selected reload/restart/back/detail cases → approved text retained within its lifetime, Chat restored, no authority controls restored or automatic submission; do not claim these on untested devices.
4. Selected approval/unknown/Stop fixtures → current exact payload and status readable, unknown has no blind retry, Stop retains named scope and actual settlement meaning.
5. Selected AT observations → actual observer/tool/browser/build and result. DOM labels or keyboard checks alone do not establish screen-reader speech. Deferred VoiceOver remains NOT RUN.
6. Keep installation-specific addresses, private screenshots, credentials and raw sensitive evidence in ignored `.local` records; publish only safe attributable summaries.

## Requirements

S14-AC13; FR-24/25; NFR-11/13. AC03/09/12 supply unchanged authority semantics for any selected fixture cases. This ticket does not add a new FR/NFR or acceptance requirement.

## Blocked by

No code dependency blocks documenting current limits. New actual-device/AT observations require a named available device/build, an authorized route and a capable observer; this ticket does not assert that those inputs are available or selected. Triage these practical prerequisites before applying an executable readiness label. There is no native blocking relation to implementation review/merge because testing a named branch build need not wait for merge, and this coverage is not an invented merge gate.

## Contracts used/delivered

Uses the current Plain design, ADR 0062 and existing S14 command/authority contracts. Delivers labelled evidence and coverage decisions, not execution authority, product contract changes or deployment certification.

## Out of scope

Mandatory exhaustive device/AT certification, changing prior owner deferrals, production deployment, provider subscriptions/accounts, real external effects, host cutover/reboot, new execution/network scope and unapproved UI changes.

## Do not

Do not infer actual-device success from screenshots or fixtures; reuse prior-build evidence as replacement-build proof; invent a gate; open private sessions; broaden network/origin scope; silently change an owner deferral; retry unknown effects; expose secrets/private addresses; use implement-parallel; or merge as the implementer. Any new implementation scope needs its own approved issue/criteria.

## Definition of done

The selected observations or explicit coverage deferrals are accurately recorded and reviewed, with the remaining unrun limits intact. For a documentation-only evidence update, `git diff --check` passes and links/revision identifiers are verified. If code changes are needed, use a separately scoped defect ticket and its required checks. An eventual evidence PR body must contain `Closes #309`; no merge by the implementer. Closing this ticket does not certify all devices, live effects, deployment or owner acceptance.
