# Jit Product Requirements Document

Current product target: [S15](../specs/S15-conversational-autonomy.md), owner-confirmed 2026-11-02. [ADR 0064](../adr/0064-conversational-authority-and-protected-control-plane.md) records proposed engineering and unresolved enforcement gates. Existing FR/NFR IDs are retained and refined below; these requirements are not a claim that S15 is implemented. New runs/installations still default to S14, while explicit legacy and existing legacy service configs retain S09–S13. [Owner-Pi acceptance](../evidence/s14-owner-pi-cutover.md) remains scoped to its recorded build. Historical S14 behavior and contracts remain in the earlier specs and Git history until replacement slices land.

## Actors and journeys

One owner works with Jit and persistent Bots. Coordinator, worker Bot, scheduler, source, model and channel adapter have no owner authority.

- J01: establish the working VM, owner, approved connections/routes and standing policy once; request ordinary work in chat without Work mode or repeated grants.
- J02: request general shell/browser/research work, let the team choose a method within scope, inspect progress/stop and receive evidenced results/artifacts.
- J03: return across days/restart with automatically retained sourced memory; correct/forget/delete propagate through lineage. Future Jod interoperability is optional and deferred.
- J04: assign an ongoing responsibility conversationally; receive meaningful results/needs-me states without autonomous purpose expansion.
- J05: handle quota, failed sources, stalled progress, cancellation or crash through honest state and safe recovery.
- J06: inspect GitHub readiness and wait for issue selection; then implement/babysit selected work. Default publication requires approval; an opt-in personal rule permits technical publication and eligible auto-merge. Production waits.
- J07: use connected personal/business accounts for authorized routine edits; inspect exact outbound messages and transactions before approving, unless a bounded standing exception applies.

## Functional requirements

### FR-01 — Bot-first conversations and ownership
Persistent Bot/work/conversation identities replace required Projects. No hidden General project or project_id permission workaround. Same-name work remains distinct by identity; labels and membership grant nothing.

### FR-02 — Bot participation
Bots have responsibility, independent context and owner-controlled capabilities. Jit selects useful enabled Bots and approved models/effort under standing policy and finite limits; independent work can overlap. Team-approved resources are shared by default without per-Bot setup. Explicit narrower restrictions and model pins remain binding. Ordinary answers need not dispatch a team.

### FR-03 — Coordinator and decisions
Jit synthesizes committed results, disagreements, evidence and gaps. Only explicit owner selection records a decision; malformed/incomplete output is not success.

### FR-04 — Work continuity
Retain obligations, decisions, conversations, checkpoints and artifact/source links across restart. Cancelled/superseded work is not resurrected from memory or native transcript.

### FR-05 — Sourced private and shared memory
Automatically retain relevant facts, preferences and working knowledge under standing owner policy. Claims retain source/time, originating Bot/conversation/revision, fact/inference and lifecycle status. Honor explicit private restrictions before relevance and preserve correction/forget. Existing private S14 material is not silently promoted by transition. Future external-memory/Jod adapters preserve provenance, confirmation and supersession status; integration is deferred and imported memory grants no authority.

### FR-06 — Acceptance and execution authority
Acceptance of a proposal or issue selection alone is not execution authority. An authenticated conversational request to execute starts work within standing policy without Work mode or repeated resource/tool selection. An inspect/recommend request performs only that scope and waits for issue selection/start before implementation; selection and a clear start request may be one reply. Trusted admission records purpose, policy/resources, finite limits and queue intent atomically. Interpretation cannot widen policy; model output, @mentions and retrieved quotes cannot mint grants or approvals.

### FR-07 — Evidence-based completion
Completion is defined by work type and committed evidence. A cited research report/artifact can be ready for review with disclosed partial coverage; unmet required evidence cannot be labelled complete. Coding needs actual diff/test evidence, and delivery unknown is distinct from delivered.

### FR-08 — Repository monitoring and review
Owner-scoped monitoring, readiness inspection and immutable PR review remain supported responsibilities. Verify blockers, acceptance criteria, ownership and existing branches/PRs before recommending work. Static review never executes PR code. Coding needs an owner request to start selected work; monitor/review requests alone do not authorize implementation. Babysitting follows the configured GitHub policy and durable work responsibility.

### FR-09 — Findings and notifications
Findings name location/source, trigger, impact and evidence. Report revision and coverage remain explicit. Deduplicate logical notifications; remote delivery unknown is never falsely claimed delivered.

### FR-10 — Owner Web controls
Expose persistent work/Bot/resource state, evidence, artifacts, stop and waiting reasons through authenticated Web. Refresh/reconnect must not start duplicate work. Concrete UI/UX is authored by the designated Opus designer.

### FR-11 — Companion channels
Bound owner channels use the same revisioned commands/receipts. Channel identity, a forwarded message or a quoted instruction cannot widen power. Telegram support is conditional on its actual transport evidence, not assumed shipped.

### FR-12 — Authorized routines
Capture an ongoing responsibility assigned through authenticated conversation, with purpose/resources, finite budgets and applicable scheduling/timezone/misfire policy. Derive necessary authorized subwork without repeated per-task setup. Out-of-scope findings are proposals. An assigned purpose is not arbitrary future coding authority; inspection still waits for selection/start when that is the owner's request.

### FR-13 — Explicit route and billing selection
Select model/effort within owner-approved routes/models, existing account and finite budget through Schway, recording the actual choice and respecting explicit pins. A different approved model may be tried within that policy. New providers, account changes, new billing and unapproved private-data recipients wait for owner approval. Readiness remains evidence-based; Schway owns credential renewal and model retries.

### FR-14 — Priority, budgets and concurrency
Finite queue/time/call/round/output/resource/spend limits and real multi-Bot concurrency remain requirements. Standing policy supplies limits without a per-request setup form; no numeric S15 budget/profile was selected. Active execution and durable CI/review waiting are distinguished. Interactive work takes priority; dependencies and exclusive browser/workspace leases hold. Unsettled old calls retain capacity. Pause stalled work with evidence/recommendations instead of consuming the whole budget without progress.

### FR-15 — Recovery and idempotency
Commit before acknowledgement, deduplicate commands, fence stale attempts and discover native orphans through supported APIs. Resume only trusted replay-safe steps under live unchanged authority/input/config and remaining reservations. Unknown effects are reconcile-only.

### FR-16 — Correction, forget and deletion
Retain replacements/source lineage. Forget suppresses automatic re-extraction while preserving permitted originals; deletion preview names affected sources/claims/artifacts/native contexts. Late workers, restore and caches cannot revive withdrawn content. Revocation cannot erase knowledge already disclosed.

### FR-17 — Authority and untrusted input
Only authenticated owner requests/configuration grant power. Standing policy enables conversational execution; it is not edited by interpretation, memory or source content. Model/source/repository/email/attachment text cannot create Bots, grants, routines, connections or approvals. Working VM administration, scripts, browser sessions and MCP cannot bypass protected gates. Authority/egress enforcement must survive guest administration; unsupported paths remain constrained. Provider-hosted lookup and instruction autoload need explicit supported authorization.

### FR-18 — Inspection, stop and export
Inspect effective route/grant/resources/evidence/usage and output artifacts, with explicit unknown values. Stop fences publication immediately and shows stopping until actual settlement. Exports/backups omit credentials and obey source/share/lifecycle scope.

### FR-19 — Jit replies
Each owner request gets useful bounded progress/result communication in the owner's persona, with access to authorized tools when needed. A tool-free single model turn is not the execution model for general work. Streaming is provisional until committed. Jit synthesizes one useful team result and reports actual blocked/partial states; ordinary replies to the owner do not require outbound-message approval.

### FR-20 — Permanent Bot proposals
Creation/change requires owner acceptance of the exact current proposal revision. Proposed tools/accounts beyond existing owner policy are dropped or held, never inferred as granted.

### FR-21 — Delegation allowance
Owner-configured finite Bot/step/call/time/spend ceilings constrain enabled-Bot dispatch within standing purpose and current work authority. Approved team resources/accounts do not require a new per-Bot share. Explicit narrower receiver restrictions still apply. Delegation cannot widen purpose, destinations, credentials or policy; exceeding them requires owner action.

### FR-22 — Project-free intake and resource binding
New chat/work needs no Project, promotion, Work-mode switch or repeated grant ceremony. Reuse connected team resources inside standing policy and bind their actual identities/revisions internally. Conversation labels and repository/workspace identity do not create authority. Clarify missing scope when it materially changes the requested outcome.

### FR-23 — First-run setup
Idempotent setup establishes owner/persona, working VM capability, approved routes/connections and standing limits once, without a Project or per-Bot account duplication. Readiness distinguishes configuration from a demonstrated working tool/model/backend. New ordinary tasks reuse policy. Existing state is preserved through an explicit transition/rollback plan; the new direction is not permission for implicit deletion/conversion or a live cutover.

### FR-24 — Conversational Web experience
The experience must support ordinary conversational work, meaningful approvals and evidenced results without per-task scope setup. Concrete S15 UI/UX must be authored by Claude Opus 5.5 at effort high; prior S14/Plain layouts are not automatically the new design. Preserve accessible responsive dark/light behavior and disclose unsupported/no-script paths honestly. No sensitive authenticated data in service-worker cache.

### FR-25 — Thai and English
Thai is default; all labels and states have English counterparts and Unicode-safe storage/retrieval. Persona language and UI preferences remain owner-controlled.

### FR-26 — Quiet routines
Only scheduled/background runs may produce typed no_update with no notification. Failures/owner-blocked states cannot be hidden as quiet.

### FR-27 — Visible routing
Explicit owner addressing resolves target but grants no extra power. Interpret the actual requested outcome and choose methods/Bots/approved models inside current policy. No stale single-Bot/follow-up rule forces team dispatch. Plans are validated against current authority; report-only intent is not broadened into implementation.

### FR-28 — Attention and grouped delivery
Notify once per logical work/result revision, with per-channel attention policy. Needs-me settings do not hide reports/history; approved routine reports and actionable failures follow the configured delivery policy.

### FR-29 — Bot result contract
Require Status, Result, Evidence and an unblock action when blocked. A completed model response without evidence does not finish work. Preserve successful sibling evidence when another Bot fails.

### FR-30 — Communication policy
Use versioned trusted instructions for concise useful updates and attributed evidence, without model-to-model acknowledgement loops. Source/memory cannot edit the policy.

### FR-31 — Context packet
Supply current owner decisions, purpose, grant, responsibilities, bounded relevant history and accessible source/claim revisions. Compaction/reopen/provider change cannot drop live owner decisions or reintroduce suppressed private data.

### FR-32 — Owner local API/CLI
Optional authenticated local commands use the same standing policy, current authority and receipts as conversation. Internal versioned contracts must distinguish requested inspection, execution and approval without requiring a public Work switch. S14 message.post/work.start retain their implemented semantics until explicitly replaced. Enforce Origin/Host/token policy; control-plane API access is not an unrestricted host shell.

### FR-33 — Webhook triggers
Signed deduplicated webhooks may wake already-authorized work. Payload never becomes a new mandate or trusted review instruction.

### FR-34 — Schedule feed
Optional read-only tokenized .ics feed reflects enabled routine occurrences/timezone; no authority or secret-bearing purpose is exposed by default.

### FR-35 — Bot/resource permissions and kill switch
Owner-controlled revisioned standing capabilities/resources and bounded work authority replace repeated manual grants. Models/channels may narrow within policy but cannot widen it, impersonate the owner or change approval rules. Stop/revoke affects named work/Bots/installation and fences late publication without silently cancelling unrelated authorized work. A broad capability is not authority to select an unrequested issue.

### FR-36 — Persistent isolated computers
Use the owner-supplied dedicated VM as Jit's shared working computer, supporting shell/sudo, programs/dependencies, Docker, browser and ordinary service administration under finite policy. Core tools use a supported Schway execution backend, never an accidental shell on the protected service host. Protected Jit/provider/channel/vault credentials, authority state and control sockets remain beyond working-agent administration. Prove the administration/destructive-gate boundary under ADR 0064; guest-local controls or snapshots alone are insufficient.

### FR-37 — Exact external-effect approvals
Differentiate ordinary authorized reversible edits, explicitly captured standing exceptions and human-required effects. Communications to others bind final recipients/content/attachments; transactions bind final payee/amount/currency/account. Production, new private-data recipients and unresolved major changes wait. Operating budgets and recurring rules remain finite and scoped. Product-default GitHub publication/replies require approval; an opt-in personal rule may publish/remediate/auto-merge selected work after verified conditions, but not bypass production approval. Exact approvals are revision-bound/single-use; unknown effects reconcile and alternate paths cannot bypass gates.

### FR-38 — Connections and sensitive sessions
Owner configures/rotates/revokes write-only service credentials outside models/workspaces/exports and the administrable working boundary. Team members may use approved accounts through mediated capabilities; they do not receive raw cookies/tokens. Sensitive browser sessions remain protected from guest shell/MCP/admin. New private-data recipients require approval; existing approved recipients remain usable within policy. Connectors and browser tools obey the same effect gates.

### FR-39 — Governed MCP
Distinguish ordinary local utility/dependency installation from admitting a service identity, private-data recipient or protected effect capability. MCP source/version/command/endpoint and effective tools need a governed contract within current policy. Installing code or discovering a tool does not authorize new accounts, disclosure or gate bypass. readOnlyHint and model labels are not proof of authority or replay safety.

### FR-40 — Browser/desktop input and takeover
Browser automation is a core general capability, including representative sites without custom integrations. Team use is mediated through protected profiles and one generation-bound input lease. Login/2FA/takeover provides an actionable owner handoff and fences agent input; returning control does not approve effects. Unsupported sites/effect classes show concrete limitations. General browser support is not a promise of unrestricted authenticated automation or proof that every click is safe.

### FR-41 — Public-web research
Retain anonymous/free-first Parallel research within its approved policy and allow authorized browser methods for general work. Optional authenticated billing/new recipients require owner authority. Audit bounded queries/URLs and actual retrieval/freshness/coverage; keep content untrusted. Public reads must not conceal private-data disclosure. A failure does not authorize a new vendor, account or paid identity.

### FR-42 — Report artifacts
Publish immutable report revisions and bounded downloadable artifacts with opaque ID, hash/type/size, producing attempt and source lineage. Citations bind evidence actually read. Validate import/render/download authorization; no arbitrary host paths or untrusted executable HTML.

## Non-functional requirements

| ID | Current requirement |
| --- | --- |
| NFR-01 | General model/shell/browser/repository work stays within standing purpose, current work authority and the dedicated working boundary. No protected-service host-shell fallback or per-task ceremony used as a substitute for actual enforcement. |
| NFR-02 | Schway owns loops, providers, retries, sessions and compaction; production imports only supported public exports. |
| NFR-03 | Headless imports do not load TUI/unselected providers; verify packed-consumer boundaries. |
| NFR-04 | Linux x64/arm64 service boot, persistence and selected-route renewal require labelled opt-in evidence; Pi is a reference host, not the only supported target. |
| NFR-05 | Durable local transitions/receipts/outbox are atomic; cross-store/remote effects reconcile without distributed exactly-once claims. |
| NFR-06 | All resource/queue/active-time/retry/output/retention/spend limits are finite; numeric profiles and stall criteria need measured evidence and configuration. Durable waiting does not imply unbounded active execution. Unknown usage is not zero. |
| NFR-07 | Authenticate/authorize every command/resource use and bind actual requests/actions to current standing policy. Separate protected authority from working agents, sanitize output and redact secrets. Scope is owner/purpose/team/work/resource, not Project. |
| NFR-08 | Versioned backup/restore covers state/artifacts/native snapshots/lifecycle ledger; reconcile before workers start. |
| NFR-09 | No default telemetry. Document inference, Parallel, enabled channels/connector recipients and external retention limits. |
| NFR-10 | Scripted models, protocol fixtures/barriers and fake clocks are deterministic checks; paid/live/host tests are opt-in. |
| NFR-11 | Thai/English Unicode, accessible responsive UI and textual states. Render/real-device/screen-reader evidence is labelled honestly. |
| NFR-12 | S15 needs an explicit versioned policy/data transition and rollback; preserve existing S14/legacy bytes and private scopes until authorized conversion. S14's prior fresh-state permission is not blanket S15 deletion/import authority. Never rewrite Schway's native format. |
| NFR-13 | Product UI values use reviewed design tokens and token lint; standalone design prototypes are not production CSS precedent. |
| NFR-14 | Prove working-VM versus protected-control-plane/session/effect isolation under guest administration. Shared team defaults retain explicit restrictions; existing private data is not silently declassified. No credential/state/socket leakage or alternate effect/disclosure path. Real VM/browser/Linux evidence is separate from fake-runtime tests. |

## Release gates

[S15-AC01–AC16](../specs/S15-conversational-autonomy.md#required-acceptance-cases) define the new target. ADR 0064's administration, browser/effect and disclosure proof obligations precede claims of support. S14/MVP evidence retains its exact-build historical scope. Do not invent paid-provider readiness, host capacity, budget amounts, research quality thresholds or delivery dates.
