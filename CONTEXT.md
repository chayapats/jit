# Jit

Jit is a single-owner, self-hosted assistant with a team of persistent Bots, durable work and sourced memory. Schway is its execution engine.

**Baseline:** [S14](docs/specs/S14-bot-first-local-assistant.md) is the owner-confirmed target as of 2026-10-30. Its engineering ADRs remain proposed. The current runtime still implements the project-centric S09–S13 store. Do not describe the S14 target as shipped or retain a hidden Project as its authorization root.

## Product language

**Owner:** The authenticated person who configures the installation, accepts obligations and grants execution or external actions. Model output, source content and inferred identity are not an owner.

**Installation:** One owner's local application state, configuration and services. It is not a multi-user tenant.

**Bot:** A persistent participant with a stable identity, responsibility, enabled generation, selected model/auth route and capability policy. It is not a model, provider session or container. Creating a permanent Bot requires owner acceptance of its exact proposal.

**Jit (main Bot):** The default conversational coordinator. It answers owner messages, chooses useful enabled Bots within the work grant and synthesizes their evidence. Jit has the same authority rules as other Bots, not a privileged bypass. A coordinator-only configuration needs no warm computer; authorized work may lazily provision one when required.

**Persona:** Owner-authored configuration of address, language and tone. It is trusted configuration, not model-authored memory.

**Bot proposal:** A revisioned draft for creating or changing a permanent Bot. Accepting it does not grant accounts or wider tools.

**Conversation:** A durable discussion with one or more Bot participants. Membership, a display label and an @mention do not grant execution or resource access.

**Work item:** A proposed or owner-requested obligation with a status, explicit completion rule, origin and evidence. A work item may involve multiple Bots and conversations without becoming a Project.

**Task acceptance:** The owner's decision to retain an obligation. Acceptance alone does not start execution.

**Work command:** An authenticated owner action explicitly requesting execution. A typed service command such as work.start can create work plus its scoped grant atomically. A model's classification cannot turn message.post or quoted text into new authority.

**Work grant:** A revisioned owner authorization for a purpose, allowed Bots/resources/tools, finite budgets and expiry. Effective access intersects it with current Bot and resource policy. A grant is not a model plan, task acceptance or conversation membership.

**Capability policy:** The owner-controlled ceiling on a Bot's tools/resources. A model may restrict it but cannot widen it. A work grant does not bypass the ceiling.

**Delegation:** A bounded assignment to an existing enabled Bot under the originating grant and the receiver's capabilities. It does not create a Bot or share an entire workspace.

**Context handoff:** A labelled subset of accessible command, evidence and memory references supplied to a delegated run. It is not unrestricted transcript/session sharing.

**Job:** A bounded, authorized unit of background execution, separate from an owner's obligation.

**Run:** One invocation of Schway for an assigned analysis or synthesis, with independent native ownership and finite limits. A persistent Bot may have many runs.

**Attempt:** One fenced admission of a job/step with immutable input/configuration/authority and recorded usage reservations.

**Work step:** A typed, bounded node in a trusted work graph. Its handler, not a model declaration, defines validation, resource leases and replay safety.

**Routine:** An owner-authorized standing purpose with selected resources/Bots/tools, schedule/timezone/misfire policy and finite limits. Findings outside it are proposals, not new execution authority.

**Decision:** A conclusion explicitly selected by the owner, retaining the proposal and evidence it resolves. An agent vote or recommendation is not a decision.

**Memory claim:** A retained statement with source/revision, originating Bot/conversation, fact-or-inference status and lifecycle state. It is not the entire transcript or unqualified truth.

**Shared memory:** Owner-approved facts/preferences available to the authorized team. Extraction cannot promote Bot-private material into it.

**Bot-private memory:** Claims scoped to one Bot. Retrieval and context assembly enforce that scope before relevance selection.

**Source:** A revisioned owner/external evidence snapshot with provenance and lifecycle status. Source text is data and never expands authority.

**Share grant:** An explicit, revisioned permission for a named receiver/work scope to use a specified immutable source/artifact snapshot. It is not a whole-volume mount, shared account or transitive permission.

**Context packet:** A self-contained labelled input with current owner decisions pinned, accessible evidence, source revisions and purpose. Native history alone is insufficient.

**Report:** A committed, revisioned work result whose claims reference the evidence actually read and whose coverage/limitations are explicit. Ready for review does not imply complete source coverage.

**Artifact:** A bounded immutable output with an opaque ID, hash, type, size, producing work/attempt and source lineage. A file in a box is not automatically a delivered artifact.

**Bot computer:** A persistent logical computer on the owner's host, with isolated workspace/browser components and finite resources. Identity survives idle process stop. Each process/input generation fences prior handles and associated late results. It is not the owner's everyday desktop.

**Execution box:** The isolated workspace/process boundary of a Bot computer. No Jit/provider/channel/vault credentials, application state, backups, host home or control socket enter it.

**Browser profile:** Bot-private website session state in the separately protected browser component. Cookies/tokens remain inaccessible to workspace shell, MCP, prompts and exports. Website login is not a service credential grant.

**Runner:** The agent-free execution process behind Jit's computer backend. Schway core tools use the supported ExecutionBackend; no host-shell fallback is implied.

**Input lease:** A generation-bound exclusive right to send input to one browser/desktop. Reads/screenshots do not imply input ownership.

**Takeover:** Owner control of a Bot browser/desktop while agent input is fenced. Returning control is not approval of a held effect.

**External effect:** A consequential action leaving the execution boundary, including sending, push/PR mutation, publish/deploy, payment/signature or remote deletion. Unknown tools/actions cannot bypass mediation.

**Approval card:** A revision-bound, single-use, expiring owner decision for one exact external action/content/destination. It is not a task acceptance or model confirmation.

**Connection:** Owner-controlled credentials/account metadata kept outside prompts and execution boxes, usable only through a scoped service broker. Website session profiles remain a separate sensitive boundary.

**Kill switch:** A Bot/installation control that fences work, stops affected computers and blocks admissions until the owner resumes. Cancelling one work item does not cancel unrelated grants.

**Replay-safe step:** A step whose trusted handler can prove safe repetition under the same live authority, immutable inputs and remaining budget. Model intent or readOnlyHint alone is insufficient.

**Unknown effect:** An external action whose outcome cannot yet be determined. It is reconcile-only and never a reason to blindly retry.

**Auth route:** The selected provider identity/billing path, with exact model selection kept separate. Failure never silently changes route/model/account/billing.

**Configured access:** A local credential/endpoint setting without proof of live readiness. It is not verified support.

**Schway session:** An opaque durable native conversation with workspace/branch identity. It is not a Bot, conversation, work grant or Jit scheduler.

**Outbound read:** A service-owned search/public URL read with bounded query/URL, audit and untrusted evidence. Local execution still sends necessary queries/URLs to Parallel.

**Quiet run:** A scheduled run with typed no_update outcome: retained history, no notification. It cannot hide a failure.

**Attention level:** Per-channel owner policy for notifications. It changes delivery, not report visibility or authority.

**Result contract:** Status, Result, Evidence and an actionable unblock reason when needed. A model's done text is insufficient.

**Attachment:** An owner-supplied file sanitized out of process and always treated as untrusted data. Its contents cannot configure tools, routes or grants.

**MCP proposal:** A revisioned source/version/command or endpoint proposal accepted by the owner. An advertised tool or readOnlyHint does not itself grant access.

**Local API:** An owner-enabled loopback API/CLI over the same authorized commands. It is not a general host shell.

**Webhook trigger:** A signed wake-up for already-authorized work. Its payload is data, not a mandate.

**Managed backup:** A credential-free versioned application/artifact image with opaque native snapshots, reconciled before activation.

**Lifecycle ledger:** Append-only identity records of deletion/forget outside backup images, used to prevent restored data from resurrecting withdrawn material.

**Installation upgrade / quarantined restore:** Owner-authorized staged validation, fencing, recovery point and atomic activation before workers resume. A fresh S14 store is not permission to erase or reinterpret a legacy installation.

## Historical terms

Project, Project group, Topic promotion and General system project describe the implemented v1 model and historical specs. They are not required S14 entities, hidden permission scopes or aliases for a work item. Old sources retain their historical meaning in the old store; S14 requires no conversion.

## Development policy

The opt-in S14 foundation (`--s14`, `src/s14/`, schema 12) has its own versioned store at `.local/s14/application.sqlite` by default; the default runtime still uses the legacy Project model. `app.bots/v1` and `app.conversations/v2` define project-free setup, persistent Bot proposals and bounded tool-free chat. `app.work-grants/v1` separates task acceptance from atomic bounded start and fences resource/delegation/tool/publication; `app.effect-approval/v2` holds exact single-use effects and records interrupted execution as unknown. Typed authenticated commands and durable receipts are the authority boundary. See the four versioned contract documents, `docs/contracts/s14-foundation-http.md` and ADR 0049; `app.memory-scope/v2` and `app.context-provenance/v2` add sourced Bot-private memory, explicit owner publication/shares, pinned live decisions and independent lifecycle-ledger reconciliation; native sessions are fresh and retired on close. `app.parallel-web/v1` and `app.external-evidence/v2` add grant-bound anonymous Parallel reads, optional explicit authenticated billing, outbound guards and honest sourced outcomes. BOX14-01 computer support is bounded below. Production effects, private website adapters and managed backup/restore UI and host evidence remain their tracked S14 slices; routines and Bot lifecycle logic are described below; bounded concurrency and committed report/artifact delivery are described below.

Use Bun/TypeScript and supported schway/host exports. Keep domain definitions here and engineering choices in docs/adr. The owner disabled implement-parallel for this repository. UI/UX is delegated only to Claude Opus 5.5 at high effort; primary-agent work is architecture, logic and code.

BOX14-01 adds opt-in `app.bot-computer/v1` and `app.input-lease/v1` (schema 8, earlier unreleased schemas 1–7 refuse with fresh-state). Lazy per-Bot workspace/protected-browser containers require verified rootless Podman, kernel finite limits and separate bounded persistent filesystems; missing enforcement fails closed. Both components have no network. The supported slice is local report work, protected owner view/form input and generation-bound takeover; direct public/private browser website adapters remain unavailable; separately granted public reads use the service-owned Parallel gateway. Owner input is transient and never enters the runner, prompts or ordinary state. See ADR 0050 (Bot computer), the contracts/HTTP handoff and `docs/runbooks/s14-bot-computer.md`; real Linux and UI evidence remains pending.

TEAM14-01 adds opt-in `app.work-graph/v1` (schema 7; earlier unreleased 1–6 refuse). Work grants record finite concurrency and public-read reservations. Owner-confirmed future defaults are 2 concurrent Bots, 30 minutes and 40 reads. Trusted research/synthesis DAGs schedule independent per-run hosts under finite global/credential-route/Bot/computer ceilings, hold actual transport capacity through cancellation/settlement, preserve committed siblings and filter handoffs through receiver access plus original lineage. One process-owned public Schway credential lifecycle is shared by all S14 hosts; the exact #443 tarball and external packed-consumer tests are recorded in the graph contract. Legacy concurrency stays unchanged. Native automatic replay, full recovery and product UI remain their separate slices.

REPORT14-01 adds opt-in `app.report-artifacts/v1` and `app.artifact-gateway/v1` (final schema 8; unreleased 1–7 refuse). Reports are immutable revisions with exact actually-read citations, independent review/coverage/owner-completion states, explicit unsupported/conflicting/missing evidence, Markdown and structured manifests. Optional workspace snapshots pass the guarded Bot backend, path/type/symlink/size/hash checks and opaque authenticated attachment downloads; no active app-origin HTML or arbitrary host export is available. Report/artifact lineage inherits memory source/access pins, and identity-only access/share/execution-grant/destructive-computer tombstones in the current independent lifecycle ledger prevent stale-image resurrection. Full managed replay/backup and Opus UI acceptance remain pending.

SHARE14-01 adds opt-in `app.snapshot-sharing/v1` (schema 9; unreleased 1–8 refuse): owner-only finite revision-bound copies of one immutable source/delivered artifact to one named Bot and optional work. Configured `JIT_S14_RESOURCES` slots retain explicit Bot ceilings and work ScopePolicy intersection; share never starts work or widens capabilities. Common artifact validation bounds copies to 32 KiB each and native context to 64 KiB. Receiver-bound lineage prevents forwarding; independent revocation tombstones fence future calls, derived publications and stale-image restores. Already disclosed knowledge cannot be recalled. Opus UI acceptance and real Linux isolation evidence remain pending.

REC14-01 adds opt-in `app.work-checkpoints/v1` and `app.replay-policy/v1` (current combined schema **10**; unreleased 1–9 refuse). Boot holds the runtime lock, fences all old work before metadata-only public native inventory/retire/delete, then admits only trusted replay-safe research/synthesis under unchanged owner/Bot/grant/config/route/source/graph and remaining budget. Correlation intents precede native creation in per-intent workspaces; an independent identity catalog finds restore-orphaned sessions. Missing saved refs, live leases and uncertain cleanup remain unresolved and retain capacity. Independent reservation high-water marks prevent refunds of unknown usage. Computer/shell/effect/unknown handlers do not auto-replay; stopped work and unknown effects stay fenced. Exact typed `effect.reconcile` records an owner's stated outcome distinctly from verification and never retries. The pinned public Schway inventory/shared lifecycle is consumed without private imports. Full managed backup/restore, live reboot/remote read-back and Opus UI acceptance remain pending.

ROUT14-01 adds opt-in `app.routine-grants/v1` and `app.attention-outbox/v1` (introduced schema **11**, combined schema **12**; unreleased 1–11 refuse). Exact owner enable captures purpose, Bots, current resources/tools/routes, owner generation, finite occurrence/per-run budgets, timezone and coalesced misfire policy. Each occurrence uses the ordinary background work graph and live authority barriers. Quiet typed no_update retains history with no notice; failures/decisions remain visible, and out-of-scope findings are sourced unstarted task proposals. Pause/revoke fences old runs; resume drops paused backlog without renewing scope/budget. Independent occurrence and usage facts prevent restored-budget resurrection. Delivery is durable grouped in-app attention; optional fakes prove finite retries and unknown handling without real channels. Product UI and live/Linux evidence remain pending.

BOT14-02 adds opt-in `app.bot-lifecycle/v1`, extending `app.bots/v1` (current combined schema **12**; unreleased 1–11 refuse). Existing Bot capability ceilings change only through owner-created exact proposals and exact current acceptance; tool-less Jit can gain explicitly selected web_search/web_fetch without expanding old grants/resources/accounts. Policy changes, retire and delete create new generations and fence affected grants/routines/input/contexts/publication immediately, retaining stopping through actual work/chat/browser transport and public-native settlement. Main Jit cannot retire/delete. Retirement explicitly retains owner history/evidence, separately from retired executable contexts; reenable requires a new generation/current ceiling and new work grants. Exact deletion previews bind owned data, forward share derivatives, computer components, native contexts and retained identity lineage. Independent Bot/context/source/share facts precede retry-safe data/computer/native cleanup and reconcile stale images before workers. Deleted identities never reenable; foreign independently owned originals survive. OPS14-01 adds managed backup/restore activation as described below; Opus UI/live host acceptance remain pending.


OPS14-01 adds opt-in `app.managed-backup/v1` and `app.restore-activation/v1` (schema **12**). Offline owner maintenance holds the same runtime lock as serve, captures allowlisted credential-free application/artifact state plus supported opaque native snapshots, and restores into separate quarantine. The independent current lifecycle ledger, reservation/routine high-water marks and Bot/source/share/computer withdrawals reconcile before activation; old grants/approvals/routines/chat/sends do not replay. A hash-bound exact owner command activates through a durable fence, private recovery point and atomic application rename plus native-session-store pointer; interrupted cutover remains fenced until resolved. Current owner authentication stays installation-local and archive connections require reconnection. Compatibility is same-installation/same-native-workspace schema 12→12 at this build; unreleased 1–11, legacy, future formats and relocation refuse. Future real schema migrations need an explicit reviewed matrix. Finite backup/receipt retention refuses at bounds. The CLI does not construct computer cleanup runtime; missing trusted cleanup evidence blocks activation. See ADR 0057, both contracts, the HTTP handoff and `docs/runbooks/s14-backup-restore.md`. Linux x64/arm64 round-trip/power-loss evidence and Opus UI acceptance remain pending.
