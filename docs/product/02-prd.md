# Jit Product Requirements Document

Current target: [S14](../specs/S14-bot-first-local-assistant.md), owner-confirmed 2026-10-30. Engineering ADRs 0045–0048 retain their proposed broad architecture status; accepted implementation refinements culminate in ADR 0061 default selection. New runs/installations default to S14, while explicit legacy and existing legacy service configs retain S09–S13. [Owner-Pi acceptance](../evidence/s14-owner-pi-cutover.md) is separately recorded, including complete post-reply R4 equality. Existing FR/NFR IDs are retained and refined below. Historical behavior is preserved in the earlier specs and Git history, not presented as the new product.

## Actors and journeys

One owner works with Jit and persistent Bots. Coordinator, worker Bot, scheduler, source, model and channel adapter have no owner authority.

- J01: fresh setup without a Project, talk to Jit, accept a permanent Bot proposal if needed.
- J02: explicitly request research, admit bounded independent work, inspect progress/stop and receive a cited report/artifact.
- J03: return across days/restart with sourced owner/Bot memory; correct/forget/delete propagate through lineage.
- J04: enable a scoped routine; receive meaningful results/needs-me states without autonomous scope expansion.
- J05: handle quota, failed source, cancelled work or crash through honest state and safe recovery.
- J06 (required phase B): authorize repository work, inspect diff/tests and approve exact push/PR effects.
- J07 (required phase C): connect email/calendar, review triage/briefs and approve exact sends/changes.

## Functional requirements

### FR-01 — Bot-first conversations and ownership
Persistent Bot/work/conversation identities replace required Projects. No hidden General project or project_id permission workaround. Same-name work remains distinct by identity; labels and membership grant nothing.

### FR-02 — Bot participation
Bots have responsibility, configured route, independent context and capabilities. Jit selects useful enabled Bots under finite owner-set work limits; independent steps can overlap. Ordinary answers need not dispatch a team.

### FR-03 — Coordinator and decisions
Jit synthesizes committed results, disagreements, evidence and gaps. Only explicit owner selection records a decision; malformed/incomplete output is not success.

### FR-04 — Work continuity
Retain obligations, decisions, conversations, checkpoints and artifact/source links across restart. Cancelled/superseded work is not resurrected from memory or native transcript.

### FR-05 — Sourced private and shared memory
Claims retain origin Bot/conversation/source revision, explicit fact/inference and lifecycle status. Filter Bot-private/explicit-share scope before relevance. Owner-approved shared memory does not acquire private data through extraction.

### FR-06 — Acceptance and execution authority
Proposed work becomes an obligation only through owner acceptance. Acceptance alone starts nothing. An authenticated explicit work command may atomically create work, a bounded grant and queue intent. A model classifier, @mention or retrieved quote cannot mint a grant.

### FR-07 — Evidence-based completion
Completion is defined by work type and committed evidence. A cited research report/artifact can be ready for review with disclosed partial coverage; unmet required evidence cannot be labelled complete. Coding needs actual diff/test evidence, and delivery unknown is distinct from delivered.

### FR-08 — Repository monitoring and review
Owner-scoped monitoring and immutable PR inputs remain supported responsibilities. Static review never executes PR code. Phase B coding uses a separate explicit work grant and isolated executor; neither monitoring nor review authorizes mutation.

### FR-09 — Findings and notifications
Findings name location/source, trigger, impact and evidence. Report revision and coverage remain explicit. Deduplicate logical notifications; remote delivery unknown is never falsely claimed delivered.

### FR-10 — Owner Web controls
Expose persistent work/Bot/resource state, evidence, artifacts, stop and waiting reasons through authenticated Web. Refresh/reconnect must not start duplicate work. Concrete UI/UX is authored by the designated Opus designer.

### FR-11 — Companion channels
Bound owner channels use the same revisioned commands/receipts. Channel identity, a forwarded message or a quoted instruction cannot widen power. Telegram support is conditional on its actual transport evidence, not assumed shipped.

### FR-12 — Authorized routines
Capture purpose, Bots/tools/resources, finite budgets, schedule/timezone/misfire and owner authority. Out-of-scope findings are proposed work. Routine creation/acceptance is not arbitrary future coding authority.

### FR-13 — Explicit route and billing selection
Use owner-selected exact model/auth routes through Schway. No silent provider/model/account/billing fallback. Readiness is configured/unverified/blocked/verified according to evidence; Schway owns credential renewal.

### FR-14 — Priority, budgets and concurrency
Finite queue/time/call/round/output/resource limits and real multi-Bot concurrency are MVP requirements. Interactive queued work takes priority. Dependencies and exclusive computer/workspace leases are respected; unsettled old calls retain capacity.

### FR-15 — Recovery and idempotency
Commit before acknowledgement, deduplicate commands, fence stale attempts and discover native orphans through supported APIs. Resume only trusted replay-safe steps under live unchanged authority/input/config and remaining reservations. Unknown effects are reconcile-only.

### FR-16 — Correction, forget and deletion
Retain replacements/source lineage. Forget suppresses automatic re-extraction while preserving permitted originals; deletion preview names affected sources/claims/artifacts/native contexts. Late workers, restore and caches cannot revive withdrawn content. Revocation cannot erase knowledge already disclosed.

### FR-17 — Authority and untrusted input
Only authenticated owner commands/configuration grant power. Model/source/repository/email/attachment text cannot create Bots, grants, routines, connections or approvals. Gateway-mediated tools/egress prevent alternate execution paths; provider-hosted lookup and instruction autoload remain disabled unless explicitly supported/authorized.

### FR-18 — Inspection, stop and export
Inspect effective route/grant/resources/evidence/usage and output artifacts, with explicit unknown values. Stop fences publication immediately and shows stopping until actual settlement. Exports/backups omit credentials and obey source/share/lifecycle scope.

### FR-19 — Jit replies
Each owner message gets one bounded reply in the owner's persona. Streaming is provisional until committed. Jit synthesizes a useful team result in one voice and reports actual blocked/partial states.

### FR-20 — Permanent Bot proposals
Creation/change requires owner acceptance of the exact current proposal revision. Proposed tools/accounts beyond existing owner policy are dropped or held, never inferred as granted.

### FR-21 — Delegation allowance
Owner-configured finite Bot/step/call/time ceilings constrain existing-Bot dispatch per work grant. Delegation intersects origin authority with receiver capabilities; exceeding it requires owner action, not model permission.

### FR-22 — Project-free intake and resource binding
New chat/work needs no Project or promotion ceremony. Bind named work/resources explicitly. Conversation labels and repository/workspace identity do not become a new authorization root.

### FR-23 — First-run setup
Idempotent owner/persona/route/readiness setup works across refresh/restart. Establish main Jit identity without a Project. Legacy stores receive a fresh-state next action with no implicit deletion/conversion.

### FR-24 — Conversational Web experience
Use the Opus-authored S14 design for the new experience. Preserve accessible responsive dark/light behavior, progressive-enhancement forms and static-only PWA caching unless an explicit subsequent design/ADR refines them. No sensitive authenticated data in service-worker cache.

### FR-25 — Thai and English
Thai is default; all labels and states have English counterparts and Unicode-safe storage/retrieval. Persona language and UI preferences remain owner-controlled.

### FR-26 — Quiet routines
Only scheduled/background runs may produce typed no_update with no notification. Failures/owner-blocked states cannot be hidden as quiet.

### FR-27 — Visible routing
Explicit owner addressing resolves target but grants no extra power. Deterministic routing is used where valid; no stale single-Bot/follow-up rule forces a dispatch on every message. Model proposals are validated against the current grant.

### FR-28 — Attention and grouped delivery
Notify once per logical work/result revision, with per-channel attention policy. Needs-me settings do not hide reports/history; approved routine reports and actionable failures follow the configured delivery policy.

### FR-29 — Bot result contract
Require Status, Result, Evidence and an unblock action when blocked. A completed model response without evidence does not finish work. Preserve successful sibling evidence when another Bot fails.

### FR-30 — Communication policy
Use versioned trusted instructions for concise useful updates and attributed evidence, without model-to-model acknowledgement loops. Source/memory cannot edit the policy.

### FR-31 — Context packet
Supply current owner decisions, purpose, grant, responsibilities, bounded relevant history and accessible source/claim revisions. Compaction/reopen/provider change cannot drop live owner decisions or reintroduce suppressed private data.

### FR-32 — Owner local API/CLI
Optional loopback-only authenticated commands use the same grants/receipts. Distinguish message.post from explicit work.start. Enforce Origin/Host and token policy; the API is not host-shell access.

### FR-33 — Webhook triggers
Signed deduplicated webhooks may wake already-authorized work. Payload never becomes a new mandate or trusted review instruction.

### FR-34 — Schedule feed
Optional read-only tokenized .ics feed reflects enabled routine occurrences/timezone; no authority or secret-bearing purpose is exposed by default.

### FR-35 — Bot/resource permissions and kill switch
Owner-controlled revisioned capabilities and per-work grants replace project access levels. Widen only through authenticated owner configuration; models/channels may narrow within policy. Stop/revoke affects named work/Bots/installation without widening or silently cancelling unrelated grants.

### FR-36 — Persistent isolated computers
Each authorized working Bot has a private persistent local computer with finite resources and lazy startup/idle stop. ExecutionBackend runs core tools only inside its boundary. No Jit/provider/channel/vault secrets, host home/control socket, database or backups enter the execution workspace.

### FR-37 — Exact external-effect approvals
Bind approval to action/content/destination/hash/revision/expiry; use once. MVP defaults require approval, with no implied always-allow from a work request. Unknown result is reconcile-only. Unsupported or alternate shell/browser/MCP effects are refused.

### FR-38 — Connections and sensitive sessions
Owner configures/rotates/revokes write-only service credentials outside every model/workspace/export. Browser website-session bytes stay in a separate protected Bot-private component; file sharing does not share a login. Phase C connectors use owner-scoped accounts and exact effect brokers.

### FR-39 — Governed MCP
Owner approval binds server source/version/command or trusted endpoint and explicit tool grants. Unknown/changed tools are not admitted automatically. readOnlyHint is a hint, not proof of authority or replay safety.

### FR-40 — Browser/desktop input and takeover
Private Bot browser profiles and virtual desktops use one generation-bound input lease. Owner takeover fences agent input; returning control does not approve held actions. No-script form controls remain a supported baseline; enhanced transport requires evidence.

### FR-41 — Public-web research
Default to Parallel anonymous/free web_search/web_fetch. Optional OAuth/API-key billing is explicitly enabled by the owner. Audit exact bounded queries/URLs and actual retrieval/freshness/coverage; keep content untrusted. Rate limit/failure does not silently select another vendor or paid identity.

### FR-42 — Report artifacts
Publish immutable report revisions and bounded downloadable artifacts with opaque ID, hash/type/size, producing attempt and source lineage. Citations bind evidence actually read. Validate import/render/download authorization; no arbitrary host paths or untrusted executable HTML.

## Non-functional requirements

| ID | Current requirement |
| --- | --- |
| NFR-01 | Model/shell/repository work stays within explicit grants and isolated computers. Research MVP opens only required capabilities; phase B is separately gated. No service/host-shell fallback. |
| NFR-02 | Schway owns loops, providers, retries, sessions and compaction; production imports only supported public exports. |
| NFR-03 | Headless imports do not load TUI/unselected providers; verify packed-consumer boundaries. |
| NFR-04 | Linux x64/arm64 service boot, persistence and selected-route renewal require labelled opt-in evidence; Pi is a reference host, not the only supported target. |
| NFR-05 | Durable local transitions/receipts/outbox are atomic; cross-store/remote effects reconcile without distributed exactly-once claims. |
| NFR-06 | All resource/queue/time/retry/output/retention limits are finite; numeric operating profiles need measured host evidence. Unknown usage is not zero. |
| NFR-07 | Authenticate/authorize every command and resource use; sanitize untrusted output and redact secrets. Scope is owner/Bot/work/resource, not Project. |
| NFR-08 | Versioned backup/restore covers state/artifacts/native snapshots/lifecycle ledger; reconcile before workers start. |
| NFR-09 | No default telemetry. Document inference, Parallel, enabled channels/connector recipients and external retention limits. |
| NFR-10 | Scripted models, protocol fixtures/barriers and fake clocks are deterministic checks; paid/live/host tests are opt-in. |
| NFR-11 | Thai/English Unicode, accessible responsive UI and textual states. Render/real-device/screen-reader evidence is labelled honestly. |
| NFR-12 | Fresh S14 state may refuse legacy data without conversion/deletion. Future upgrades still need staged compatibility/recovery; never rewrite Schway's native format. |
| NFR-13 | Product UI values use reviewed design tokens and token lint; standalone design prototypes are not production CSS precedent. |
| NFR-14 | Enforce execution/profile/private-memory isolation and gateway-only effects; no credential/state/socket leakage. Real Linux enforcement is separate from fake-runtime tests. |

## Release gates

[S14-AC01–AC14](../specs/S14-bot-first-local-assistant.md#required-behavior-and-acceptance) and the [MVP gates](06-mvp.md) apply. Do not invent paid-provider readiness, host capacity, research quality thresholds or delivery dates.
