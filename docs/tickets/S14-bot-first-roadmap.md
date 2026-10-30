# S14 phased delivery and ticket preparation

Parent: [#244](https://github.com/chayapats/jit/issues/244). Documentation/design: [#245](https://github.com/chayapats/jit/issues/245). [Spec](../specs/S14-bot-first-local-assistant.md).

Status: 17 scoped runtime/evidence tickets are published as needs-triage after the Opus handoff. None is ready-for-agent. Exact issue bodies are mirrored under s14/ and indexed in s14.json. No implementation dates are implied.

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

BOT14-02 owns existing-Bot capability edits, retirement and deletion; BOX14-01 computer reset does not cover them. OPS14-01 owns the usable backup/restore/upgrade path for the new store; fresh state waives legacy conversion, not NFR-08. EVID14-01 is blocked on OPS14-01 and its lifecycle prerequisites.

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
