# S14 phased delivery and ticket preparation

Parent: [#244](https://github.com/chayapats/jit/issues/244). Documentation/design: [#245](https://github.com/chayapats/jit/issues/245). [Spec](../specs/S14-bot-first-local-assistant.md).

Current closeout checkpoint, 2026-11-01: 22 runtime/evidence/follow-up tickets are indexed in `s14.json`. Implementation tickets #246–#255, #257–#260, #262–#263, #265–#266, #268 and #279 are CLOSED. EVID14-01 (#256) is CLOSED after PR #304; CUT14-01 (#267) and parent #244 remain OPEN pending reviewed closeout, and documentation #245 is CLOSED. Closed implementation work does not certify live acceptance. See the [consolidated evidence](../evidence/s14-mvp-evidence.md) for per-build/per-architecture limits. Original preparation mirrors remain historical issue bodies, not current readiness claims.

Current evidence disposition, 2026-11-01: #256 closed after reviewed PR #304 merged at `143ca06`; its native x64 AC12 and earlier named-build evidence retain their declared limits. PR #305 merged the S14 default at `5eec7aa`. The [owner-Pi cutover record](../evidence/s14-owner-pi-cutover.md) records actual first reply, complete legacy-byte windows and prior-release rollback. Post-reply R4 equality also passed. Reviewed #267/#244 closeout remains pending. No whole-product or later-head recertification is implied; historical checkpoints below retain their original observations.

## Phase A — research MVP (required)

| Key | Observable vertical slice | Genuine prerequisites | Evidence |
| --- | --- | --- | --- |
| [BOT14-01](https://github.com/chayapats/jit/issues/246) | Fresh owner starts a project-free conversation with Jit; permanent Bot proposal can be accepted/rejected at exact revision. | S14 docs/design baseline; new store/command contract specified in ticket | duplicate setup/chat/proposal; no project identity; legacy store unchanged |
| [AUTH14-01](https://github.com/chayapats/jit/issues/247) | Owner direct work command admits internal work once; proposed-task acceptance alone does not; exact external effect waits on owner approval. | BOT14-01 contracts | authority/receipt/stale input, unknown-effect and injection fixtures |
| [BOX14-01](https://github.com/chayapats/jit/issues/248) | An authorized Bot opens its private persistent computer, sees its browser, can be stopped/taken over and retains files after idle stop. | AUTH14-01, supported core-tools backend; Linux runtime checks for live activation | fake runtime/lease tests; separate opt-in persistence/resource proof |
| [SHARE14-01](https://github.com/chayapats/jit/issues/253) | Owner shares one named file/source snapshot with another Bot and revokes future use without exposing a whole workspace/account. | REPORT14-01 artifact gateway and originating grants | path/profile isolation, share/revoke/late-result and bounded import tests |
| [MEM14-01](https://github.com/chayapats/jit/issues/249) | Owner/Bot memory recalls sourced context across restart; correction/forget/delete suppresses descendants and native replay. | BOT14-01, AUTH14-01 scopes | Thai/English, source conflict, private/global and lifecycle fixtures |
| [WEB14-01](https://github.com/chayapats/jit/issues/250) | Owner asks a public question; Bot searches and reads with free-first Parallel and reports source/limit/failure honestly. | AUTH14-01; supported tool registry/web contract | MCP protocol, outbound guard, schema change, quota/cancel/bounds/no fallback |
| [TEAM14-01](https://github.com/chayapats/jit/issues/251) | Two independent Bots genuinely research concurrently and Jit synthesizes committed evidence with gaps. | MEM14-01, WEB14-01; supported cross-host credential lifecycle for live route concurrency | overlap barriers, finite budgets, siblings, independent contexts, renewal conformance |
| [REPORT14-01](https://github.com/chayapats/jit/issues/252) | Research work delivers a persisted cited report and authorized downloadable artifact revision; partial evidence stays partial. | TEAM14-01, BOX14-01 | citation binding, hash/type/path/size checks, lifecycle and restart |
| [REC14-01](https://github.com/chayapats/jit/issues/254) | Restart reconciles native work and resumes only authorized replay-safe steps; uncertain effects remain waiting. | AUTH14-01, TEAM14-01, REPORT14-01; supported Schway #414 behavior | crash-window, lease, budget, revocation and unknown-effect fixtures |
| [ROUT14-01](https://github.com/chayapats/jit/issues/255) | Owner-authorized routine produces a brief/report on schedule, stays quiet for no_update and asks on out-of-scope findings. | REPORT14-01, REC14-01 | timezone/misfire, quiet/failure, scope and notification dedupe |
| [BOT14-02](https://github.com/chayapats/jit/issues/262) | Owner revises capabilities, retires or deletes an existing Bot with exact preview/revision and immediate generation fencing. | SHARE14-01 lineage/revocation; REC14-01 native retirement | stale/duplicate commands, admission/input/publication races, lifecycle and no-resurrection fixtures |
| [OPS14-01](https://github.com/chayapats/jit/issues/263) | Owner backs up and restores the fresh S14 store, artifacts and opaque native snapshots through quarantine and current-ledger reconciliation before workers start. | BOT14-02 and its artifact/share/native recovery prerequisites | consistent manifest, corrupt/incompatible/crash cutover, credential exclusion, lifecycle anti-resurrection and opt-in Linux round trip |
| [EVID14-01](https://github.com/chayapats/jit/issues/256) | Owner runs the research journey on supported Linux x64/arm64 with recorded limits, actual Parallel sources and restart evidence. | All Phase A slices including BOT14-02 and OPS14-01; real route and host configured by owner | ready-for-human opt-in corpus/host evidence, not paid CI |

BOT14-02 owns existing-Bot capability edits, retirement and deletion; BOX14-01 computer reset does not cover them. OPS14-01 owns the usable backup/restore/upgrade path for the new store; fresh state waives legacy conversion, not NFR-08. OPS14-01 and BOT14-02 are closed implementation prerequisites. EVID14-01's required scoped evidence is now met, with unrun permutations labelled as limits in the canonical record.

BOT14-01 and AUTH14-01 are independently useful new-store paths; they must not wait on an unrelated live subscription smoke. Engine prerequisites block activation of the dependent capability, not deterministic fixture work. A placeholder or missing upstream contract is never marked verified.

## Phase B — coding (required)

- [CODE14-01](https://github.com/chayapats/jit/issues/257): grant a repository/workspace, isolate a branch/worktree, inspect/edit/install/test inside the Bot boundary and produce a reviewable immutable diff with actual test results. Depends on Phase A authority/computer/artifact/recovery contracts.
- [CODE14-02](https://github.com/chayapats/jit/issues/258): approve exact commits/destination to push and create a PR through a trusted effect broker; credentials never enter the workspace. Reconcile uncertain push/PR results; no automatic merge. Depends on CODE14-01 and supported effect adapters.

## Phase C — personal assistance (required)

- [LIFE14-01](https://github.com/chayapats/jit/issues/259): connect owner-scoped email/calendar read access, triage and produce a sourced morning brief under an explicit routine. Inaccessible sources and stale calendar data remain visible.
- [LIFE14-02](https://github.com/chayapats/jit/issues/260): draft a message/event and approve exact recipient/content/timezone/change before send or calendar mutation. Record unknown delivery separately, revoke connections promptly and never treat email content as authority.

B/C remain required deliverables even though Phase A gates the first usable release. Provider-specific OAuth scope and connector feasibility are ticket decisions, not assumptions that Gmail/Calendar or Telegram transport already works.

## Publication and ownership

Use docs/agents/workflow.md: spec parents are not implementation tickets; each ticket needs its own deliverable, contracts, implementation steps, observable ACs, tests, FR/NFR mapping, verified blockers, out-of-scope and definition of done. Titles use [Frontier]/[Standard]. Security/authority/concurrency/contract slices are Frontier.

The owner disabled implement-parallel and its coordinator/claim workflow for this repository. Work uses the issue-specific branch/worktree, checks current ownership/PRs and respects ongoing changes. This does not disable the explicitly requested Opus UI/UX delegate.

Schway briefs: [shared lifecycle](../proposals/schway/SCH14-01-shared-credential-lifecycle.md), [#414 recovery](../proposals/schway/SCH14-02-session-recovery-414.md). Publish or refine upstream work through its owner; do not invent a contract/version or duplicate #414.

## Later tickets and current gate

| Ticket | GitHub state checked 2026-11-01 for closeout | Scope/status distinction |
| --- | --- | --- |
| [UX14-01 #265](https://github.com/chayapats/jit/issues/265) | CLOSED | First-owner Web setup and conversation commands; device acceptance remains separate. |
| [OPS14-01 #263](https://github.com/chayapats/jit/issues/263) | CLOSED | Backup/restore implementation and recorded round trips; remaining lifecycle permutations stay in evidence. |
| [OPS14-02 #266](https://github.com/chayapats/jit/issues/266) | CLOSED | Nested subordinate-ID diagnosis; no host-configuration change implied. |
| [CUT14-01 #267](https://github.com/chayapats/jit/issues/267) | OPEN | Default merged in #305; actual owner-Pi host criteria recorded. Post-reply R4 passed; reviewed closeout pending. |
| [TEST14-01 #268](https://github.com/chayapats/jit/issues/268) | CLOSED | Deterministic probe uncertainty test. |
| [UX14-02 #279](https://github.com/chayapats/jit/issues/279) | CLOSED | Routine and attention controls; actual AC13 keyboard/render samples and deferred/unrun coverage limits are recorded separately. |

New ticket mirrors are in `s14/`. Their issue bodies describe scope at publication and are not rewritten to imply human acceptance. `s14.json` records the separately verified current GitHub states. No ticket is newly marked ready-for-agent by this consolidation.

ADR status review: ADRs 0045–0048 are original proposed architecture, refined by accepted opt-in implementation ADRs 0049–0056 and 0057 offline activation/scoped registry, 0058–0060. CODE14/LIFE14 implementation ADRs 0057 are accepted for opt-in implementation, with live limitations retained in the evidence record. Accepted engineering does not mean that all proposed architecture or release evidence is accepted.

## Completed-evidence checkpoint — 2026-11-01

Historical pre-N checkpoint; the final parent-reviewed checkpoint below supersedes its pending x64 gate conclusion.

#256, #267 and parent #244 were rechecked OPEN; the earlier table is a historical state checkpoint. The [canonical evidence](../evidence/s14-mvp-evidence.md) records completed physical/Mac observations and #297/#299/#300/#301 fix/check provenance against `ae417f0e83c72d6d0b1576a16d9862cf28be1a48`:

- Physical helper at `4e719fc`: arm64 4/4 within installed synthetic-authority/controlled-real-transport scope; x64 successful startup followed by case-1 failure, cases 2–4 unrun and cleanup confirmed. x64 AC12 remains required. D later refused preflight, then one setup-corrected invocation reached startup but timed out at the reply gate; cases 2–4 remain unrun. Cleanup and later independent process absence/graceful stop are recorded separately.
- Actual Mac Firefox at `417ee00` read five retained reports, produced one real reply and downloaded one hash-matching Markdown artifact; delegated usefulness is distinct from direct owner acceptance. Original clipping remains failed history.
- Supported installed `529cc39`, tree-equal to CI head `08a6178`: actual Firefox 24 focus/four copy passes and native Safari four-capture sample. VoiceOver speech was observer-blocked, real iPhone unrun; these are disclosed limits without an invented owner-only or exhaustive device/AT gate.
- #300 protects known intervals going forward, without repairing older overwritten times. A completed 53-input audit and independent arithmetic check verify overlapping dispatched terminal-read invocations for all ten final cases, with identity/context/grant/queue/synthesis checks. Invalid later DB ends stay unusable; native lifetime is not continuous CPU time and per-work peak does not certify service-wide peak.

This documentation checkpoint changes no source/design, default, readiness label or issue state. The original ticket mirrors remain historical; new scope-specific facts are appended to EVID14-01. Required behavior and the remaining gate are distinguished from bounded coverage limits in the canonical record.

## Final parent-reviewed evidence checkpoint — 2026-11-01

Build N at `c051d06d1bc663cbe6d8a785212a70514197b7b3` passed four actual installed native x64 AC12 cases and five controlled assertions in 83.758 s, with one helper, no cleanup-only and null reason/transportFailure. #303's unchanged 4,500 ms latch now starts at the exact future matching pipe/id-bound dispatch and includes acquisition plus hold; normal CDP/startup/admission/total/idle bounds and all guards remain unchanged. Its deterministic checks and identical tested-head tree are recorded separately from actual N proof.

Parent independently verified 101 indexed hashes/45 trace rows. Helper cleanup and later complete host settlement are separate: all 44 residual monitors settled naturally before the parent probe, with zero residual processes/containers/claims/transports and no signal, API/manager stop, helper replay, prune, wipe or VM shutdown. Only the verified own custody lock was released. S14 is stopped with normal descriptor; legacy remains healthy with the same process and the VM remains running/retained. Sensitive original/current recovery archives and recoverable quarantine remain private; no new VM/OS/legacy reset occurred, and the existing Ubuntu 26.04 AppArmor/pasta prerequisite remains explicit.

Earlier native/emulated failures and scratch setup failures remain unchanged. A separate single getTargets response in 5,840.669 ms under the normal 15 s supports helper phase selection, not old causation or installed AC12 acceptance. N supplies installed-kernel/synthetic-authority/controlled-real-transport proof only. Earlier arm64, kernel/route/research/rubric/overlap/lifecycle/Mac evidence stays pinned to its own builds, without later-head recertification or a newly run model/website/owner UI/effect/reboot/idle journey.

The required #256 release evidence is met within the declared scope and may close after reviewed documentation merge. Owner-deferred VoiceOver and unrun iPhone/Safari permutations remain disclosed limits. The corpus is explicitly owner-unread; original delegated rubric/usefulness authority does not require direct owner report acceptance. #267 implementation/default flip and parent #244 remain open. This documentation PR changes no product code, UX, feature, default or GitHub issue state; parent owns immutable review/merge and issue-state verification.

## Owner-host cutover checkpoint — 2026-11-01

The [separate owner-Pi record](../evidence/s14-owner-pi-cutover.md) supersedes earlier default/cutover-pending conclusions for its exact `5eec7aa` arm64 installation. It records fresh separate S14 state, one native-approved tool-free Codex reply, full R0/R1 and R2/R3 preservation with independent recoveries, actual retained prior legacy-release health, and same-owned S14 reactivation. Failed helper invocations remain failed and are distinguished from independent successful observations. Post-reply R4 equality also passed. Reviewed #267/#244 closeout remains pending; neither issue is claimed closed here. Owner-unread reports, owner-deferred VoiceOver, unrun real iPhone and all earlier named-build limits remain unchanged.

## Plain follow-up tracker — 2026-11-02

The preceding checkpoints retain their historical issue states. The original S14 parent [#244](https://github.com/chayapats/jit/issues/244) is now CLOSED; the owner-approved Plain replacement is separate scope under [parent #307](https://github.com/chayapats/jit/issues/307), with native sub-issues:

| Ticket | Verified state at publication | Scope/status distinction |
| --- | --- | --- |
| [PLAIN14-01 #308](https://github.com/chayapats/jit/issues/308) | OPEN, needs-triage | Whole S14 presentation/IA and safe browser-local navigation/drafts delivered at `388c119773bcb1244912fa70ec3ec67b5cd0544d` on `t3/plain-handoff-scope-review`; PR/CI/review/merge and owner acceptance remain pending. |
| [PLAIN14-02 #309](https://github.com/chayapats/jit/issues/309) | OPEN, needs-triage | Remaining device/AT coverage triage. Prior VoiceOver deferral and unrun cases remain explicit; no new release gate or live/deployment authority is implied. |

The issues were published after the implementation push; they do not imply that tracked-issue prerequisites were checked before that commit. No competing Plain issue or PR existed at publication. Keep the existing task-owned branch rather than starting a duplicate implementation. No new ready-for-agent/human or native blocking relation is asserted. The owner approved a task-specific UI/UX author exception and replacement without an old renderer or UI compatibility layer; repository-wide policy otherwise remains unchanged.

Current scope: [Plain design](../design/S14-plain-experience.md). Tested revision and limits: [Plain evidence](../evidence/s14-plain-ui.md). Local issue mirrors: [PLAIN14-01](s14/PLAIN14-01.md) and [PLAIN14-02](s14/PLAIN14-02.md). The earlier `s14.json` snapshot and original ticket mirrors remain historical records rather than being rewritten as new-scope acceptance.

### Bounded Plain coverage checkpoint — 2026-11-02

Current machine-readable tracking is [plain14.json](plain14.json); the preceding publication table is historical. PR [#310](https://github.com/chayapats/jit/pull/310) is OPEN against main at `1844be4309c3f5670ffa2c217350682c892823a3`, above runtime implementation `388c119773bcb1244912fa70ec3ec67b5cd0544d`. #309's issue branch is stacked on that implementation branch; it does not alter #310.

Evidence [PR #312](https://github.com/chayapats/jit/pull/312) is OPEN against `t3/plain-handoff-scope-review`, with `Closes #309` only. No issue was closed and no merge/deployment was performed by this work.

[PLAIN14-02 #309](https://github.com/chayapats/jit/issues/309) now records selected authenticated local Chrome observations and limited actual Safari native AX navigation/mode observations on the exact source/assets. The Safari driver/input/layout and preview-snapshot observer failures remain labelled. The owner confirmed no physical-iPhone route/observer this round: iPhone/touch/OSK remain NOT RUN, as does owner-deferred VoiceOver speech. Other unrun permutations remain limits, not new release gates. No product suite rerun, live effect, deployment or cutover is claimed by this evidence update.

The Chrome history case failed: after Work → detail → Back, Work remained selected while the send accessible label remained Send message; three of three re-check traversals confirmed it with no automatic command. The separate scoped [PLAIN14-03 #311](https://github.com/chayapats/jit/issues/311) and [mirror](s14/PLAIN14-03.md) record reproduction/criteria. Fix implementation needs separate authorization; no product change is included in #309. Evidence review, #310 review/merge and owner acceptance remain open. #307/#308/#309/#311 remain OPEN; no ready-for-agent/human label or invented device gate is added.

### Reconciled Plain output scope — 2026-11-02

[#313 PLAIN14-04](https://github.com/chayapats/jit/issues/313) tracks the cross-work Reports/Artifacts Library. [#314 PLAIN14-05](https://github.com/chayapats/jit/issues/314) tracks inline Work results/provenance/decisions. Both restore explicit tracking of outcomes recorded in the earlier 2026-11-01 handoff, under #307 and the latest owner-approved navigation/authority decisions. The owner authorized completion and merge after successful current-head CI/Greptile review. They do not imply deployment or broaden device/AT gates. [#311](https://github.com/chayapats/jit/issues/311) is corrected in PR #310 pending review/merge; historical #309 failures remain attributed to their original build.
