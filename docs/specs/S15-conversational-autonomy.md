# Spec S15 — Conversational autonomy with protected approvals

Status: owner-confirmed product direction, 2026-11-02. The owner accepted the combined baseline after a 23-question interview and a consolidated read-back. This document records requirements, not implemented capabilities or an execution grant.

This is the current product target where it conflicts with [S14](S14-bot-first-local-assistant.md). S14 remains the implemented default runtime; its contracts, schema, release evidence and legacy compatibility retain their existing meaning. Tracker: [S15 #316](https://github.com/chayapats/jit/issues/316); [delivery graph](../tickets/S15-conversational-autonomy-roadmap.md) and [ticket manifest](../tickets/s15/manifest.json). S14 [#244](https://github.com/chayapats/jit/issues/244) is the historical parent, not an S15 implementation ticket.

Domain definitions live in [CONTEXT.md](../../CONTEXT.md). Existing FR-01–FR-42 and NFR-01–NFR-14 retain their identifiers in the [PRD](../product/02-prd.md). [ADR 0064](../adr/0064-conversational-authority-and-protected-control-plane.md) separates confirmed boundaries from proposed engineering and unresolved proof obligations.

## Problem and outcome

At the 2026-11-02 interview, enabling a tool on a Bot did not make it available to normal conversation: the S14 [chat port](../../src/s14/chat.ts) explicitly supplies no tools and permits one model turn, while separate work intake supplies execution authority and resources. Its Work switch, per-work selections and per-Bot sharing expose that separation to the owner.

Jit must become a general computer assistant: understand an authenticated owner's request, choose a method, use shell/browser/tools, retain useful memory and take authorized work to an evidenced result. Ordinary execution uses standing owner policy established once. Owners do not select Work mode or reconstruct tool, Bot and resource grants for each request.

Understanding intent remains essential. A request to inspect and recommend issues authorizes inspection and recommendations. It does not authorize implementation. A subsequent instruction to implement a selected issue starts that work directly. Selection and a clear execution request may be one conversational reply; no second message or confirmation is required merely to satisfy an internal state machine. Broad capabilities and accepting an obligation are not permission to invent a different task.

The reference to Grok Bot describes the owner's desired conversational autonomy. It does not establish a verified feature comparison, dependency or compatibility requirement.

## Confirmed decisions

| ID | Owner decision | Interview source |
| --- | --- | --- |
| S15-D01 | Normal chat is the execution entry point. Clear work requests start within standing policy without a Work switch or repeated grant setup. | Q1 |
| S15-D02 | The owner supplies a dedicated VM; that VM is Jit's working computer. Direct access to the owner's everyday desktop is not the chosen boundary. | Q2 |
| S15-D03 | Jit can administer its working VM, including shell/sudo, dependencies, programs, Docker, environment and ordinary services. Major destructive or disruptive changes need an owner decision. | Q3 |
| S15-D04 | Requested reversible personal edits, including documents, tasks and calendar blocks without other participants, can execute immediately. | Q4 |
| S15-D05 | Email waits for review of the final recipients, content and attachments, even when the initial request says to send it. One approval of that exact prepared action is sufficient. | Q5 A |
| S15-D06 | The same default applies to messages to other people across channels, including GitHub comments and public posts. Explicit standing communication rules may authorize a bounded class. Replies and reports to the authenticated owner are ordinary assistant output. | Q6 |
| S15-D07 | API, compute and tool usage may consume a preapproved operating budget. Jit cannot increase it or open a new subscription autonomously. No numeric budget was chosen. | Q7 A |
| S15-D08 | Purchases, transfers and bill payments need final transaction approval. Recurring payments may use a separately approved payee, amount ceiling and frequency rule; deviations wait. | Q8 |
| S15-D09 | Business operations may update real records using evidence and existing policy. New prices, discounts, contractual terms, business policies or commitments remain owner decisions. | Q9 A |
| S15-D10 | Browser operation is a core general capability, including sites without a bespoke API/integration. The owner assists at login/2FA boundaries. Existing approval rules still apply. | Q10 |
| S15-D11 | The team shares connected resources and accounts for authorized work without repeated per-Bot setup. Explicit narrower restrictions remain possible. | Q11 A |
| S15-D12 | Human-required actions must be blocked by the system until authorized. Prompt instructions alone are insufficient. The owner accepts additional protected boundaries and limitations on sites whose effects cannot be safely mediated. | Q12 A |
| S15-D13 | Jit may initiate ongoing work within a responsibility assigned through conversation. New purposes outside that responsibility are proposals. | Q13 A |
| S15-D14 | Jit automatically retains relevant facts, preferences and working knowledge with provenance and fact/inference distinctions; the owner can inspect, correct and forget. Allow future interoperability with Jod; implementation is deferred. | Q14 A and clarification |
| S15-D15 | The primary acceptance scenario is checking outstanding GitHub issues, reporting which are ready and babysitting subsequently authorized work until it passes without unnecessary owner intervention. | Q15 |
| S15-D16 | Issue discovery reports readiness and reasons, then waits for the owner to choose. It must not independently select an issue to implement. | Q16 B |
| S15-D17 | Product default requires approval before push, PR publication/update and review replies. The reference personal installation may have a standing exception for those technical actions in approved repositories after the owner selects and starts an issue. | Q17: default B, personal A |
| S15-D18 | That personal workflow may auto-merge to approved targets after acceptance criteria, evidence and required checks/reviews are satisfied. | Q18 A |
| S15-D19 | Production deployment always waits for owner approval in the confirmed workflow. A merge that triggers production must wait before merge or encounter an enforceable deployment gate. | Q19 B |
| S15-D20 | A new external recipient of private/personal/business data requires approval. Existing approved services/providers remain usable within their policies. Ordinary public browsing is not a request to approve every page. | Q20 A |
| S15-D21 | Major changes are defined by impact: destructive/bulk or hard-to-reverse data changes; authority/authentication/credentials/approval changes; breaking dependent APIs/behavior; important service restructuring; or new business obligations. Unresolved direction waits for the owner; isolated investigation can proceed. | Q21 |
| S15-D22 | Try technical recovery autonomously, but pause a stalled work item before exhausting the budget when several approaches yield no progress. Report attempts, evidence and a recommended next step. Normal CI/review waits remain durable background responsibility; other already-authorized work may continue. | Q22 A |
| S15-D23 | Select model/effort within approved routes/models and budget, recording the selection and honoring explicit pins. New providers, account changes and new billing require approval. | Q23 A |

The final owner confirmation accepts this combined set. It does not convert repository text, imported memory or this document into a live authority credential.

## Product policy and installation overrides

The conversational entry point, capable working computer and standing scope replace repeated setup. Human approval depends on the action and policy, not simply on whether a tool writes remotely.

| Action | Product default | Reference personal workflow |
| --- | --- | --- |
| Inspect issues and report readiness | Execute requested inspection; wait for issue selection | Same |
| Start implementing a selected issue | Start when the owner instructs execution | Same |
| Local edits, tests and evidence | Execute within authorized scope and budgets | Same |
| Push, publish/update a PR, reply to technical reviews | Final action approval | May execute under a standing repository/workflow rule |
| Merge | Requires separately established merge authority; implementation approval alone is insufficient | May auto-merge to approved targets after required evidence/checks/reviews |
| Production deploy, including an automatic consequence of merge | Owner approval | Owner approval |
| Other outbound communication | Final action approval unless an explicit standing rule applies | Same; the GitHub exception is not a blanket messaging exception |

The personal column is a product requirement for a configurable policy, not a shipped preset, installed configuration or permission to mutate any repository. Trusted owner configuration must capture the actual repositories, targets, limits and rule revisions before the runtime can use it. New installations and upgrades must not silently acquire the personal exception.

## Required acceptance cases

| Case | Observable behavior | Requirements |
| --- | --- | --- |
| S15-AC01 | An authenticated conversational request that needs a tool performs a real authorized tool call and returns evidence without Work mode or per-request scope forms. A request only to inspect/report performs no unrequested implementation. Quoted instructions, attachments, email and tool output cannot start unrelated work or approve an action. | FR-06/17/19/22/23/27/32; NFR-07 |
| S15-AC02 | GitHub readiness checks verify scope, acceptance criteria, blockers, ownership and existing branches/PRs. The result names ready/blocked work and reasons. No implementation starts before owner selection and a start instruction. Duplicate ingress starts at most one local work intent. | FR-06/08/09/14/15/29 |
| S15-AC03 | Authorized work actually uses the dedicated working VM for shell, dependency/program installation, environment, Docker and ordinary service tasks. It cannot read or alter the protected authority service, approval records or service credentials. Unsupported privileged operations identify the precise boundary rather than claiming success. | FR-17/18/35/36/38; NFR-01/04/07/14 |
| S15-AC04 | Authorized team members use connected work resources without a second per-Bot sharing ceremony. Explicit restrictions, mutable-workspace coordination and exclusive browser input still hold. Existing private S14 sources are not silently declassified by upgrade. | FR-02/05/16/21/35/38/40; NFR-07/08/14 |
| S15-AC05 | A representative website without a custom business integration can be navigated and read to produce a result, including bounded file processing where needed. Login/2FA is an actionable owner handoff. Protected sends/payments do not become available merely because a session is logged in. Unsupported effect classes remain visibly held or unavailable. | FR-07/18/29/36/37/38/40; NFR-04/10/14 |
| S15-AC06 | Requested reversible personal document/task edits and solo calendar blocks execute without individual approval. Routine business edits follow evidence and existing policy. Recipient invitations, new business terms and newly created commitments encounter their applicable approval boundary. | FR-03/06/12/35/37/38 |
| S15-AC07 | A message to another person waits on the exact recipients/content/attachments unless a current standing rule authorizes its class. Owner approval executes the prepared action once. Stale/changed content, expired approval and alternate shell/browser/MCP/network routes cannot bypass the gate. Unknown outcomes reconcile before any retry. | FR-11/15/17/30/35/37/38/39/40; NFR-05/07/14 |
| S15-AC08 | Metered operating costs reserve and consume only the approved finite budget; unknown usage is visible. No amount was authorized by the interview. New subscriptions/budget increases wait. Purchases/transfers/payments bind the final transaction, while recurring exceptions verify payee, ceiling and frequency before execution. | FR-13/14/18/35/37/38; NFR-05/06/09 |
| S15-AC09 | New business commitments and unapproved major changes wait with options, evidence and a recommendation. Isolated research/prototypes may continue within existing scope. File count alone does not decide impact. A previously approved direction is retained instead of repeatedly requesting the same decision. | FR-03/07/16/17/29/31/35/37 |
| S15-AC10 | Default GitHub policy holds publication and replies. Under an owner-configured exception, a selected issue proceeds through implementation, real tests, push, PR/review/CI remediation and eligible auto-merge. The gate checks current target/head, rule and required evidence/checks/reviews; untrusted review text cannot widen scope or disable checks. If merge triggers production, approval is required before merge unless an effective production gate holds deployment. | FR-06/07/08/09/14/15/18/21/29/35/37; NFR-05/07/10/14 |
| S15-AC11 | A new external recipient of private data is held before upload/disclosure. Existing approved inference/services continue within scope. Public browsing cannot be used to disguise a private upload or authorize another data recipient. | FR-17/18/35/37/38/39/41; NFR-07/09/14 |
| S15-AC12 | An assigned ongoing responsibility creates durable bounded work without repeated task/schedule setup. Findings within purpose can be processed; findings outside it are proposed. Stop/revoke blocks future admissions and late publication without cancelling unrelated authorized work. | FR-04/12/14/15/18/26/28/33/35 |
| S15-AC13 | Relevant memory is retained automatically with source/time, fact/inference and lifecycle status. Owner corrections take precedence; forget reaches retrieval/derived context according to lineage. Credentials never become memory. Future external-memory imports must preserve confirmation/supersession status and cannot become grants. Jod integration is not a current delivery gate. | FR-04/05/16/17/31/38; NFR-07/08/09 |
| S15-AC14 | Model/effort selection remains inside the approved route/model policy and budget, honors explicit pins and records actual selection. New providers/accounts/billing or new private-data recipients wait. Schway continues to own provider protocols, refresh and model retries. | FR-02/13/14/18/21/27/31; NFR-02/03/06/09 |
| S15-AC15 | CI/review waiting survives disconnect/restart as responsibility, without claiming an unsettled call has stopped. Technical failures are investigated without per-error owner questions. Lack of progress yields an honest paused/blocked result with attempts/evidence/recommendation before budget exhaustion. Unknown effects are not blindly repeated; unselected issues do not start as replacement work. | FR-04/07/14/15/18/26/28/29; NFR-05/06/08/10 |
| S15-AC16 | Adoption names the exact tested build, policy and host. Existing S14/legacy data, private scopes and rollback are preserved under an explicit transition plan. Documentation, configuration or scripted fixtures alone do not certify VM/browser/effect enforcement or authorize a live installation change. | FR-16/18/23/35; NFR-04/08/10/12/14 |

## Owner-confirmed working-VM resolution (2026-11-03)

**RT15-01 option B is accepted.** The working VM is expendable and provides full guest root/sudo. Valuable originals, credentials, publication and real external effects remain outside it under protected policy/effect gates. Root can destroy guest files, OS, Docker volumes and services; a protected snapshot provides **recovery, not prevention**. Guest-local administration is not held merely because it changes the expendable guest. Jit-initiated system-wide administration takes an exclusive VM lease and an automatic protected snapshot first; without snapshot management those operations are held. Restore itself waits for the owner unless a separately captured standing rule authorizes it.

One owner VM supports shared team work, initially two concurrent active sessions, with separate work/attempt workspaces and transient systemd units. The owner can edit the session ceiling. CI/review waiting holds no active VM session. Host-initiated unit stop/cgroup read-back is **guest-reported/cooperative settlement**: root can escape or forge it. Lima/Proxmox hypervisor stop with protected read-back is **strong settlement**. Failed or inconsistent cleanup fences the shared VM as uncertain and retains capacity pending protected reconciliation; cancellation cannot silently stop unrelated work. This accepted limitation replaces the earlier demand for root-proof per-command guest cessation, not the protected-host/authority/credential boundary.

The protected host runs an approved-registry HTTP/CONNECT proxy; the guest's direct internet and control/metadata routes are denied outside the guest. Approved registries see request metadata and may receive workspace content: this is **destination control, not content-level disclosure prevention**. A per-session proxy lease supplies cooperative attribution and finite byte/time bounds without injecting upstream credentials. It cannot prove sibling identity against guest root or make an allowed registry universally read-only. New destinations require protected policy; default publication/payment/communication/production gates remain separate. A bounded exact-URL/SHA-256 artifact route supplements the registry route.

The arm64 reference is a new Lima/QEMU VM, `jit-work-arm`; existing `jit-arm` and `jit-ac12-*` VMs must remain untouched. The owner supplies a separate Ubuntu x64 Proxmox VM `jit-work`, controlled by protected `jit-vm` with a VM-scoped management token. Until that VM exists, x64 live evidence is **pending, not failed**. These installation choices do not activate S15 on any existing Jit state. See [ADR 0067](../adr/0067-s15-working-vm-operation-and-settlement.md) and the [implemented VM contract](../contracts/s15-working-vm-v1.md#implemented-server-contract-2026-11-03).

## Engineering work and proof obligations

The following are proposals or unresolved engineering, not additional owner decisions or supported API claims:

1. **Conversational authority:** establish authenticated standing policy outside model control, then bind each actual owner request and execution receipt to current scope, limits and generations. Interpretation can select work inside that policy; it cannot grant new permissions. Approval parsing must bind an authenticated owner response to the exact pending action, not treat any occurrence of an affirmative word as approval.
2. **Working VM and protected control plane:** validate where Jit state, credentials, native sessions, policy, approval execution, browser profiles and network controls reside. A guest with root can modify guest-local controls; placing a second process/user in that guest does not protect it from guest root. Do not silently substitute a read-only computer for the agreed administration capability.
3. **Destructive administration:** RT15-01 option B is confirmed above. Prove protected custody and real snapshot/restore without claiming prevention inside the guest. Preserve current authority/claims/usage outside guest snapshots and keep real external effects gated.
4. **Browser/effect mediation:** prove supported action classes across browser, shell, scripts, MCP and egress. A prompt, screenshot, HTTP method or model effect label is insufficient. Generic website support does not imply that every authenticated site can be safely automated. Keep unsupported flows constrained and show the precise limitation.
5. **Policy profiles:** version finite standing rules, exact held actions, resource/destination scope, current checks/reviews and revocation. Auto-authorization needs a trusted policy match and an action receipt; it is not an agent approving itself. Define the default and opt-in personal GitHub profile separately.
6. **Durable work:** reuse justified receipt, fencing, reconciliation, evidence and lifecycle mechanisms. Waiting responsibility and active execution budgets are distinct. Numeric spend/resource/retry/stall thresholds remain to be selected and measured; no prototype number or fixed deadline was confirmed.
7. **Schway:** use supported public host/core-tool/backend/session contracts. Verify the exact pinned artifact. Propose a Schway change if VM, protected-browser or policy integration needs a missing host contract; Jit must not implement provider protocols or a competing agent loop.
8. **Memory interoperability:** preserve a future adapter/import/retrieval seam for Jod, including provenance and historical/superseded decisions. Transport, schema, storage ownership, sync direction and conflict handling are deferred; Jod is not the mandatory memory backend.
9. **Transition and design:** prepare explicit schema/policy/data/rollback and host acceptance plans. UI/UX authoring remains Claude Opus 5.5 with effort high; this document supplies behavior, not a new visual/interaction design or a renewed Plain-task exception.

The [delivery graph](../tickets/S15-conversational-autonomy-roadmap.md) follows [the workflow](../agents/workflow.md), with a design parent, scoped child tickets and direct blockers. Existing main/issues/PRs were inspected before preparation; recheck them before implementation. Each ticket must demonstrate a narrow observable outcome with verified contract prerequisites. Feasibility research is not a claim that dependent implementation is ready-for-agent. Required UX authoring remains an explicit blocked prerequisite; no completed handoff is claimed. This interview does not authorize deployment, deletion of existing state, spending an unspecified amount or starting an arbitrary GitHub issue.

## Validation

Use Bun/TypeScript, scripted models, protocol fixtures, fake clocks and externally observed VM/browser/effect tests. Cover intent versus report-only requests, untrusted instructions, profile isolation, stale policy/approval generations, bypass attempts, budget reservations, production-triggering merges, interrupted effects, durable waits, stalled progress and memory correction. Do not weaken checks or completion criteria to manufacture success.

Real provider/website/host tests remain opt-in and attributed to the actual build, route, policy, scope and host. No delivery date, cost amount, performance target, complete website coverage or bypass-proof implementation was certified by the interview.
