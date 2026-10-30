# Spec S14 — Bot-first local assistant

Tracker: https://github.com/chayapats/jit/issues/244
Documentation delivery: https://github.com/chayapats/jit/issues/245

Status: owner-confirmed product direction, 2026-10-30. Engineering choices below are proposed, not implemented. The running build still implements the project-centric S09–S13 model. This document is the authority for the new direction where earlier specs conflict. Existing FR/NFR identifiers are retained in the [PRD](../product/02-prd.md).

## Problem and intended outcome

Jit currently makes Project the root of conversations, roles, permissions, memory and computers. The owner wants a personal team of persistent Bots that can take work to completion on the owner's computer, without creating or selecting a Project. CopilotKit/OpenBot and OpenDuet are references for behavior; Jit remains its own application over Schway.

The research MVP must accept one authenticated request, use multiple enabled Bots concurrently when useful, search and read through Parallel, produce a persisted report with citations and downloadable artifacts, and remain inspectable across interruption. Coding to a reviewable PR and email/calendar assistance are required subsequent phases.

## Confirmed owner decisions

| ID | Decision | Source |
| --- | --- | --- |
| S14-D01 | Persistent Bots, with Jit as the main coordinator. Project is not a required domain or authorization scope. | Q1 A; original request |
| S14-D02 | Persistent computer environments on the owner's host, using containers/VMs rather than direct control of the owner's everyday desktop. | Q2 A |
| S14-D03 | Bot computers, files and browser logins are separate by default; sharing requires explicit authorization. | Q3 A |
| S14-D04 | A clear authenticated work command can start authorized internal work immediately. External effects require exact-action approval. A Bot's unsolicited proposal does not authorize execution. | Q4 A |
| S14-D05 | Jit may call existing enabled Bots within finite budgets. Creating a permanent Bot requires owner acceptance of the exact proposal. | Q5 A |
| S14-D06 | Shared owner-approved memory and Bot-private memory, with provenance and explicit fact/inference status. Handoffs carry only context the receiver may access. | Q6 A |
| S14-D07 | Parallel search/fetch is the default, anonymous/free first; authenticated use is an explicit owner option. Limits and failures are visible. | Q7 A |
| S14-D08 | Proactive execution is limited to owner-authorized routines. New work outside their scope is proposed for the owner to start. | Q8 A |
| S14-D09 | Research/report delivery is MVP. Coding to a PR and email/calendar assistance remain required later phases. | Q9 A plus explicit B/C requirement |
| S14-D10 | Real bounded multi-Bot concurrency is an MVP requirement. Conflicting input to a browser/desktop is serialized. | Q10 A |
| S14-D11 | Resume automatically only for system-classified replay-safe steps, with current authority and remaining budgets. Unknown external effects require reconciliation. | Q11 A |
| S14-D12 | Fresh application state/domain/schema is allowed. No legacy-data conversion is required. This does not authorize erasing an existing installation. | Q12 correction |
| S14-D13 | MVP production target is Linux x64 and arm64. Web remains reachable from other devices. | Q13 A |
| S14-D14 | All UI/UX design is authored by Claude Opus 5.5 with effort high; the primary agent owns logic/code and integration. | Original request; final confirmation |
| S14-D15 | Combine useful ideas from OpenBot, OpenDuet and Grok Bot while building Jit itself. | Original request; reference clarification |
| S14-D16 | Jit owns product state/orchestration; Schway owns execution loops, providers, sessions, compaction and model retries. Use supported public contracts. | Existing boundary; final confirmation |

The owner confirmed this combined baseline and authorized specification, ADR, design and issue preparation. The later instruction disabling `implement-parallel` for this repository supersedes earlier workflow requirements; it does not cancel the explicitly requested Opus design delegation.

## Product boundaries

- One owner per installation; no multi-user tenancy, cloud-computer dependency or native desktop runner in this MVP.
- Bot identity is durable product identity. A Schway session, model route, repository checkout and conversation are different identities.
- Conversations organize messages without granting access. Repository/workspace references are resources, not replacement Projects.
- A work item has a completion rule and a scoped, revisioned execution grant. Merely accepting an obligation is not that grant.
- A direct owner work command may atomically create the work item and its grant; no second confirmation is required for already-authorized internal work.
- Existing enabled Bots may receive work only within their own capabilities and the originating grant. Delegation never widens either.
- File edits, shell work and artifact processing stay inside an authorized Bot execution boundary. There is no host-shell fallback.
- Work from a website, email, attachment, repository file, memory or model output is data. It cannot create grants, Bots, routines, connections or approvals.

## Required behavior and acceptance

| Case | Observable result | Requirements |
| --- | --- | --- |
| S14-AC01 | Fresh setup creates the owner and main Jit identity without a Project or hidden General project. Chat, work, memory and resource authorization operate without project_id. Old state is refused with a fresh-state next action rather than silently upgraded or deleted. | FR-01, FR-19, FR-22, FR-23; NFR-12 |
| S14-AC02 | An owner accepts a Bot proposal at its exact revision; only then does the permanent Bot exist. Injected or stale proposals do not create it. A normal answer need not dispatch a team. | FR-02, FR-20, FR-21, FR-27 |
| S14-AC03 | An explicit work command starts internal work once under a finite grant. Duplicate ingress returns the same receipt. Accepting a proposed task alone starts no run; sources quoting an owner command grant nothing. | FR-06, FR-14, FR-17 |
| S14-AC04 | Two independent research Bots have genuinely overlapping run intervals under the configured ceiling, then Jit synthesizes committed evidence. A dependency waits, excess work queues, and a failed sibling cannot discard successful evidence or publish a false complete result. | FR-02, FR-03, FR-14; NFR-02 |
| S14-AC05 | Bot A cannot read Bot B's filesystem, browser profile or private memory by guessing an ID/path or using shell/MCP/network shortcuts. An explicit, revision-bound share exposes only the named snapshot to the receiver. Revocation fences new calls and late results; it does not pretend to erase knowledge already disclosed. | FR-05, FR-16, FR-35, FR-36, FR-38; NFR-14 |
| S14-AC06 | Shared owner facts/preferences and relevant Bot-private claims enter context with source/revision/status labels. Private data is not promoted to shared memory by extraction. Correction/forget/delete reaches derived context, artifacts and native replay according to lineage. | FR-04, FR-05, FR-16, FR-31; NFR-08 |
| S14-AC07 | A public-web request uses Parallel web_search/web_fetch without a key. Queries/URLs, source timestamps and actual retrieval outcome are inspectable. Rate limits, blocked pages, stale cache, missing sources and service errors remain visible. No automatic provider, key, model or billing switch occurs. | FR-13, FR-17, FR-18, FR-41 |
| S14-AC08 | Research commits an immutable report revision and bounded downloadable artifact with checksum, media type and source links. Unsupported claims, conflicting sources and missing evidence are disclosed. A model saying done or a file existing in a box is insufficient. | FR-07, FR-18, FR-29, FR-42 |
| S14-AC09 | A proposed external effect waits on a single-use approval bound to exact content/destination and revision. Stale/expired/denied cards do not execute. Unknown outcome is recorded and never blindly retried. Unsupported effects are refused rather than rerouted through shell/browser. | FR-06, FR-37, FR-38; NFR-05 |
| S14-AC10 | Authorized routines run only their captured purpose/resources/budgets/timezone policy. Quiet no_update creates no notification; failures or owner decisions remain visible. Out-of-scope findings create proposals, not new work authority. | FR-12, FR-26, FR-28 |
| S14-AC11 | Restart first fences/reconciles attempts and native sessions. Only trusted replay-safe handlers may resume automatically. Changed authority, source/config revision, exhausted budget, an unsettled old transport or an unknown effect prevents automatic resubmission. | FR-14, FR-15, FR-18; NFR-05, NFR-08 |
| S14-AC12 | At most one agent input lease controls a Bot browser/desktop. Owner takeover refuses agent input; ending takeover does not implicitly approve a pending effect. Stop/revoke fences all later writes and publication. | FR-35, FR-40 |
| S14-AC13 | The Opus-authored experience covers setup, Bot creation/grants, work in progress, partial reports, artifacts, approvals, takeover, memory/sharing, quota and recovery in Thai/English and accessible responsive dark/light states. Concrete design is the delegate's responsibility. | FR-10, FR-23–FR-25; NFR-11, NFR-13 |
| S14-AC14 | Supported Linux x64/arm64 installations prove bounded computer startup/idle stop, persistence, restart and selected-route readiness with labelled opt-in evidence. Configuration or scripted success alone never claims live support. | FR-13, FR-36; NFR-04, NFR-06, NFR-10 |

S14-AC02/05/06/11 also require revision-bound capability edits and Bot retirement/deletion with lifecycle preview/fencing ([BOT14-02](../tickets/s14/BOT14-02.md)). NFR-08 remains an MVP gate for the fresh store: versioned state/artifact/opaque-native backup, staged upgrade and quarantined restore reconcile the current independent lifecycle ledger before any worker starts ([OPS14-01](../tickets/s14/OPS14-01.md)); [EVID14-01](../tickets/s14/EVID14-01.md) records actual Linux round-trip evidence. Fresh state waives legacy conversion only.

## Failure, authority and recovery rules

Grant, owner, Bot, connection, share, source and attempt generations are checked at admission, before each tool/effect and at publication. The effective permission is an intersection of owner policy, originating work grant, receiver Bot capability and current resource grant. Models may narrow but never widen it.

A timeout requests cancellation; it does not prove the old call stopped. Unsettled calls retain capacity. Reservations for uncertain usage are not refunded. Missing provider usage is unknown, not measured zero.

Start authority comes from a typed authenticated owner action such as work.start (or an owner-configured standing scope), not a model intent classifier. message.post and @mentions cannot mint a new grant. This preserves immediate start without an extra confirmation for an already-explicit work command. See the [contract/design resolutions](../contracts/s14-authority-and-design-resolutions.md).

Recovery checkpoints identify work/step/input revision, authority generation, route/config, committed evidence, consumed reservations and replay policy. A trusted handler classifies replay safety; the model cannot label arbitrary shell or website actions safe. Irreversible or uncertain effects remain pending reconciliation.

The browser's website-session material is sensitive. A persistent browser login must not expose cookies/tokens to shell, MCP, prompts or ordinary exports. Proposed component separation is in ADR 0046. Jit/provider/channel/vault credentials never enter an execution container.

Approval mediation must be real. An unrestricted internet shell, arbitrary CDP/JavaScript or unknown MCP tool must not bypass it. MVP execution uses constrained tools and enforced egress; broader coding/browser capabilities require the same invariant and explicit evidence before activation.

## Engineering proposals (not owner-confirmed API shapes)

- [ADR 0045](../adr/0045-bot-first-domain-and-fresh-state.md): Bot/work/grant identity, new application store and retained implementation status.
- [ADR 0046](../adr/0046-bot-computers-and-explicit-sharing.md): per-Bot persistent rootless computers, browser-session separation and explicit snapshot sharing.
- [ADR 0047](../adr/0047-parallel-research-and-report-artifacts.md): service-owned Parallel adapter, gateway, evidence and report artifacts.
- [ADR 0048](../adr/0048-concurrent-work-and-replay-safe-recovery.md): bounded work DAGs, shared credential lifecycle prerequisite and checkpoint reconciliation.

SQLite/Bun/TypeScript and existing receipt/fencing/outbox/lifecycle code are reuse candidates, not a mandate to preserve the Project schema. No CopilotKit Intelligence, AG-UI platform or managed memory service is required by this design. Relevant content may still reach selected inference providers; local execution does not imply local inference.

## Delivery phases

The [Opus experience document](../design/S14-bot-first-experience.md) and [standalone prototype](../design/s14-bot-first-prototype.html) are designer proposals covering these requirements. Orchestrator metadata confirms claude-opus-5-5 with effort high. Engineering/factual annotations are recorded separately in the contract/design resolutions.

1. **A — Research MVP:** project-free state/setup, persistent Bots and isolated computers, grants/approvals, sourced memory, Parallel reads, true bounded concurrency, report/artifact delivery, authorized routines, inspection and safe recovery.
2. **B — Coding (required):** authorized repositories/workspaces; isolated branch/worktree work, edits/dependencies/tests with evidence; exact reviewed diff/commits; approved push/PR creation; cancellation and unknown-effect reconciliation. No code from retrieved repositories runs in Jit's service.
3. **C — Personal assistance (required):** scoped owner connections to email/calendar, read/triage/brief and drafts; exact-recipient/content approval before sending or changing an event; routine bounds, timezone, revocation, partial-source and delivery-unknown handling.

B and C are commitments to capability, not invented delivery dates. Provider-specific connector scopes are refined in their scoped tickets. See the [roadmap and drafts](../tickets/S14-bot-first-roadmap.md).

## Schway prerequisites

- Existing supported release/core-tools/web-tools contracts remain the only integration surface.
- A proposed shared credential lifecycle must work across distinct per-run hosts without Jit implementing refresh/retry protocols. See [SCH14-01 brief](../proposals/schway/SCH14-01-shared-credential-lifecycle.md). It is a true-concurrency release prerequisite, not a justification to remove the current guard before conformance passes.
- Existing [Schway #414](https://github.com/chayapats/schway/issues/414) supplies discoverable native session correlation/enumeration needed for robust crash recovery. The [follow-up brief](../proposals/schway/SCH14-02-session-recovery-414.md) refines acceptance without duplicating it.
- Distinct same-provider account aliases ([#413](https://github.com/chayapats/schway/issues/413)) are optional until the owner requires multiple accounts.
- Search already has SearchProvider. Parallel Extract may use a Jit-owned tool through tools.definitions; a reusable FetchProvider is an optional engine proposal, not an assumed API or automatic MVP blocker.

## Tests and release evidence

Deterministic cases use scripted models, protocol/MCP fixtures, barriers, temporary stores and fake clocks. Include malicious source/attachment/email content, duplicate/stale commands, share revocation, cross-Bot paths, concurrent credential renewal/logout, partial provider results, citation-to-evidence binding, artifact bounds, cancellation races, orphan session discovery and effect-unknown cases.

A scripted multi-Bot barrier proves actual overlap, not only that several jobs are queued. Browser/desktop lease tests prove mutual exclusion and takeover denial. Package-boundary tests use the exact pinned supported Schway artifact.

Live Parallel usefulness, logged-in website support, provider quotas and Linux resource/reboot behavior are opt-in evidence, not deterministic assertions. Define a small owner-approved research corpus, record failures and source coverage, and compare actual results before claiming better quality than SearXNG/Tavily/Exa.

No production runtime changes are part of the documentation ticket. No forecast of launch date or measured performance is implied.
