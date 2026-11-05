# S16 complete-product experience and first file workflow

UX16-01 [#394](https://github.com/chayapats/jit/issues/394). Design handoff, 2026-11-05. Baseline inspected: `80cc1c80e2e534c4a5940abecca2c993248bb596`; #394 open, unassigned, no comments at inspection. Parent #392; baseline #393 / draft PR #398 on `jit/393-s16-rakazo-adoption`. This handoff changes no executable capability or runtime default. S14 remains default; S15 remains opt-in. [S16](../specs/S16-rakazo-experience.md), [S15](../specs/S15-conversational-autonomy.md), ADRs [0074](../adr/0074-rakazo-reuse-and-product-convergence.md) and [0064](../adr/0064-conversational-authority-and-protected-control-plane.md) govern. FR-01–FR-42 and NFR-01–NFR-14 retain their IDs and meanings.

[Mobbin research](S16-mobbin-research.md) preceded this design: twenty inspected screen images and six flow previews, with explicit relevance gaps. R references below link to that canonical source inventory. Product interactions here are design decisions for implementation; architecture and proposed contract shapes require the parent's implementation/authority review. They are not newly installed standing policy.

## Experience structure

Jit opens on the last Bot conversation, with Jit as the first-use coordinator. No Project creation, Work mode or per-task machine setup is required. Desktop layout: 240px navigation rail, fluid main conversation (reading measure 760px), optional 360–480px inspector. Header contains Bot identity, responsibility, actual activity and computer entry. Rail: Search, Needs you with count, Bots, Work, Artifacts; secondary navigation: Routines, Memory, Connections, Settings. Bots expand into recent continuous conversations, with unread and working indicators separately labelled. Search spans authorized history, work, routines, memory and artifacts; result chips identify type, Bot and source. Labels/folders organize, never grant access. Spaces wait for explicit isolation semantics.

Conversation is the default working surface; an inspector opens Computer, Artifact, Work details or Sources without replacing the thread. Only one inspector is active; switching preserves scroll and draft. Deep links retain installation/Bot/conversation/object/revision identity. Back closes the inspector before leaving the conversation. Needs you is a normal page, not a mandatory modal.

Visual direction: calm neutral surfaces, strong text hierarchy, compact outlined status chips, restrained Jit accent for primary actions. Use 4/8/12/16/24/32 spacing; 16px body, 14px metadata, 24px page title; text line-height at least 1.5. Cards have 12px corners, composer 16px; no pervasive glass, gradients or animated avatars. Status always includes text/icon. Light, dark and system themes use semantic surface/text/border/focus/success/warning/error tokens. Preserve Jit identity; do not copy upstream logo, illustrations or exact palette. These tokens/layouts replace old presentation constraints where useful.

## Conversation

R01/R02/R04 support this structure. An owner message appears locally as Sending, becomes Received only with a durable receipt, then carries server state. Service activity is a collapsible group: current operation, elapsed time, completed tool observations and evidence. A provisional stream is explicitly “Working draft”; only guarded publication creates “Result.” Tool failure cannot be cosmetically converted to success. Unknown remote outcome is “Outcome unknown,” with investigate/reconcile, never a generic retry-effect button.

Composer stays enabled while work runs or approval waits. Its default sends a new message. A visible “Steer this work” chip targets an exact active request; without it, the new request is independent. On send, show “Steering received” then “Applied” only after the service acknowledges an execution boundary. Current S15 continuation is a held-request clarification, not proven live steering; API16 must add explicit steering admission or truthfully say “Queued for the next step.” A message cannot retroactively change a dispatched effect. Multiple active requests get separate progress/stop controls, never one ambiguous global Stop. Stop acknowledgement reads “Stopping”; settled cancellation reads “Stopped”; unresolved external effects remain visible.

Keep text drafts per installation/session/Bot/conversation in memory; persist only when local private-storage policy permits. Never store protected input as a draft. Scroll follows output only while already at the bottom; otherwise show “New activity” without stealing position. New messages and needs-you cards remain independently navigable. Switching model affects the next admitted attempt; existing work retains pins and reports actual route/usage.

## Approvals

Needs you groups exact actions, missing information, login, resource holds and stalled responsibilities. Deduplicate an action referenced by multiple requests. Each row shows Bot, purpose, reason, age, and origin link. A pending approval blocks only its dependent action; unrelated authorized work remains available.

Review displays actual operation, destination/account, recipients, content/attachment names and hashes, costs/limits, source privacy, action revision and expiry. Actions: Approve this action, Deny, Ask for changes. These bind the reviewed action reference/hash and authenticated owner. A changed payload invalidates the old button and links to the new revision. Unsupported/classification-unknown actions offer explanation and supported alternatives, not an Approve bypass. Approving resource access and approving publication are distinct. Approval state is not completion state. Never-ask mode is rejected; product-default GitHub publication remains protected, with the explicit personal-policy exception shown only when installed.

## First file workflow

Initial acceptance task: attach `notes.txt` and ask “Summarize these notes and create a downloadable Markdown brief.” The actual tool reads bounded input and writes `brief.md`; Jit collects the bytes and commits the answer plus artifact references. The final card must download the exact produced bytes after refresh/restart. The same pipeline must later demonstrate a supported document and image; text alone does not close AC03 or #396's complete scope.

### Capability and input contract (PROPOSED)

A protected `s16-client-capabilities/v1` projection exposes contract version, revision, supported upload MIME/extension pairs, per-file/count/aggregate bytes, parser limits (pages/pixels/expanded bytes/time), available text/image/VM paths, artifact preview kinds, retention/expiry and concrete unavailable reasons. Values come from the server; no hard-coded upstream 10MiB/four-file defaults. Until this exists, Attach is disabled with “File uploads are not available on this installation.” Do not fall back to legacy topic/project uploads.

Recommended initial admission policy, subject to parser audit: UTF-8 text/Markdown/CSV, PDF only with an isolated bounded extractor, PNG/JPEG only with bounded decode and an audited Schway image seam or authorized VM path. ZIP, executable, active HTML input and encrypted documents remain unsupported initially. Advertise only tested formats. Large images may be transformed only with explicit display of original and derived dimensions/hash; keep lineage to original. A supported image must affect the result through actual processing, not filename-only context.

1. Pick/paste/drop files. Show filename, type, bytes and Remove for each; multi-file errors are per-file. Picker filters are convenience, not validation. A chip moves `selected → uploading → validating → ready` or `rejected/cancelled/expired`. Only ready receipts can be submitted. Send remains disabled while selected inputs are unsettled; “Send without this file” is an explicit removal, never silent omission.
2. Create upload with owner-session/CSRF protection, conversation ID, client upload ID, capability revision and declared metadata. Stream bytes to quarantine under hard server bounds and finite capacity; declared size/MIME are untrusted. Return upload identity and status, not an executable path. Finish verifies bytes/hash, signature, decode/extraction limits and sanitized result outside protected authority. Receipt contains immutable ID/hash, safe filename, detected MIME, size, scoped lineage, validation version and expiry. No reusable credential or server filesystem path reaches the agent.
3. Submitting an input-only message is valid when at least one ready receipt exists. It commits “Files received. What would you like me to do with them?” and does not infer execution from attachment contents. Text plus files freezes the original owner instruction independently from untrusted contents. Attachment reuse in another conversation requires fresh authorization, not moving a chip across drafts.
4. Atomic message admission binds receipt IDs/hashes to an immutable request ID and command fingerprint. The service rechecks owner, conversation, current limits, withdrawal and expiry. Reusing the same request ID/body returns the same receipt; conflicting body is rejected. Upload acceptance is not work authorization. New provider recipient, unavailable resources, finite-budget exhaustion or unsupported execution path yields a durable hold with explanation and a specific next action.
5. For admitted work, supply bounded sanitized untrusted text/image through supported Schway public seams, or stage content to a work-scoped VM directory under a lease. No shell command contains a user-controlled path; no host mount or authority is derived from file text. Tool evidence records actual read/processing/write observations. The UI can show “Reading notes.txt,” “Creating brief.md,” then “Saving result”; these labels require corresponding service events.
6. The artifact collector accepts a candidate only from an authorized work output location, refuses traversal/symlink escapes and over-limit output, copies bytes into immutable storage, computes hash/type/size, and records producer/request/evidence plus all private/source ancestry. A model-generated Markdown link to a path is not collection.
7. Commit result text and immutable artifact references under a fresh publication/lineage guard. Use one durable publication transaction or a staged-object/outbox protocol with an idempotent commit marker; unreferenced candidates never appear in the library. If collection fails, show “Work finished; file delivery failed” and preserve recoverable evidence. Do not claim the requested deliverable is complete.
8. Show the committed answer and file card: `brief.md`, Markdown, exact size, revision, Preview, Download, Sources. Download requires current authorization; fresh response bytes match the stored hash. “Revise this file” starts a new authorized request referencing the prior artifact; new revision has a new immutable identity. Editing never mutates the old object.

### Failure and continuity

| Condition | Required visible and durable behavior |
| --- | --- |
| Invalid type, mismatch, oversized body, parser timeout, encrypted/corrupt PDF | Specific chip error and Remove/Choose another. No runnable request, leaked quarantine file or model parsing fallback. Server bounds apply even if client validation is bypassed. |
| Cancel upload | Cancel its upload identity; stop receiving where possible, retire quarantine asynchronously, suppress late success by generation. Other files remain intact. |
| Retry upload | Re-query upload status first. Resume only if server advertises a verified chunk protocol; initial implementation may restart transfer with a new ID and retire the old one. No fabricated resumability. |
| Lost send response | Query request identity or retry identical command ID; never generate a new ID automatically. Received is not Completed. |
| Stop work during read/write/collection | Fence further dispatch/publication; reconcile any committed result before marking stopped. A result committed before stop remains a result with an accurate ordering. Cancel does not erase input history or refund unknown usage. |
| Switch conversation while upload finishes | Upload is pinned to original conversation and draft generation; toast links back. Never insert its receipt into the newly visible composer. |
| Reconnect or server restart | Reload authoritative snapshot then events after cursor; deduplicate by event/request identity. Unsent local File bytes may be lost: show Reselect file. Ready server receipts can be recovered only while valid. Claimed interrupted execution is reconcile-only unless replay safety is demonstrated. |
| Authentication expires | Stop protected reads and mutations, hide private cached previews, preserve only permitted draft metadata, reauthenticate and revalidate. Never silently resend an approval. |
| Resource busy or recipient hold | Keep accepted inputs and purpose, show which resource/recipient needs attention and expiry. Continue unrelated work. Recheck lineage/receipt lifetime when resuming; approval never extends expired content automatically. |
| Withdrawal after processing or preview | Invalidate publication/preview/download and derived retrieval, show Unavailable with safe reason. Previously downloaded bytes cannot be remotely recalled; say so when reviewing withdrawal impact. |

## Artifacts

R03 provides organization cues, not storage semantics. Default library list columns: name/type, producing Bot, source conversation, updated/revision, availability. Search/filter by Bot/type/date and current visibility. Preview opens inspector with source chain and revision history; Download is separate from Preview. Empty state explains that produced files appear here. Existing conversation-result library remains labelled Results until immutable artifact service lands; never mint fake file IDs from text rows.

Text is escaped; Markdown disables active HTML and automatic remote loads. PDF/image preview uses bounded sanitization/rasterization where possible. HTML/active documents require a separate credential-free origin or opaque sandbox, no service cookies, scripts, forms, network, top-navigation, downloads or untrusted parent messaging by default. Interactive output requires a separately reviewed execution capability. Revoke blob URLs and clear viewers on navigation/logout/withdrawal; never grant authority via preview links. Preview unavailable still permits an authorized attachment download when policy allows it.

## Computer

R08/R11 did not supply takeover evidence. This design follows `BrowserOwner` generation checks and S15 custody rules. Inspector header states computer/backend, Shared team or Private, operator, and supported capabilities. Body shows live screen with timestamp or explicit Stale/Disconnected cover; toolbar has Take control, Return to Bot and Stop work. Before exclusive takeover settles, display “Taking control” and disable input. Accepted takeover fences agent input, invalidates old frame/element handles and gives an owner generation. Hand-back rotates generation again and enters Checking session; signed-in status is a verified fact, not granted action authority.

Login/2FA opens a protected browser surface, never chat/composer or guest terminal. Owner input goes only to the protected ingress; no credential echoes in tool results, screenshots available to the agent, ordinary history or exports. Guest desktop and protected website session are visibly distinct views. Disconnect during takeover preserves a protected hold; it does not silently return agent control. Resume requires fresh owner state and frames.

Modern public browsing must support meaningful page interaction, not merely static approved-origin GET. Recommend a protected browser worker with mediated actual requests and explicit supported workflow capabilities, separate from root-admin guest compute. Unsupported effect classification holds before dispatch. Shell/raw protocol routes must not bypass it. Generic clicks, HTTP methods or model judgments alone are not enforcement. If mediation cannot support a site, offer owner completion or a reviewed connector and record the precise gap for #397; do not claim general-browser completion. Shared account sessions need resource/input leases; private computers preserve existing S14-private ancestry. Idle release retains durable working state. Backend stop/update/restore displays proven settlement and remaining uncertainty; recovery snapshot is not prevention of guest damage.

## Bots, delegation and routines

Bot profile: name, responsibility, model/effort, enabled capabilities, default shared resources and explicit exclusions, memory and computer. “Create Bot” reviews an exact proposal before acceptance. Archive hides from active roster and requires an explicit disposition for active work/routines; restore does not revive revoked resources. Duplicate/export copies configuration only, with unresolved account/resource references clearly listed, never credentials/history/private data by default. These lifecycle commands need versioned contracts where absent.

Delegation appears as child work cards within the parent responsibility: peer/temporary identity, bounded assignment, source scope, progress, result/evidence, stop. Parent remains accountable. A temporary worker cannot become a persistent Bot without owner acceptance. Stop one child preserves sibling outputs; Stop all enumerates affected running work and retains unknown effects. Detail view explains which context/resources were shared.

Routines use R07's conversational entry and a review sheet: instruction, Bot, timezone, next three occurrences, schedule/event trigger, signed source, finite limits, misfire/coalescing rule, notification destination, effective tools and approval boundaries. Save is configuration acceptance; Run now is explicit execution. Default missed runs coalesce to one pending occurrence; show DST interpretation and next run before save. States: active, paused, waiting for you, blocked, running, stopped. History retains every occurrence and result/unknown state. Quiet successful runs can stay in history; needs-you/failure notifications remain visible. Incoming files/webhooks cannot install or widen routines.

## Memory

R06 supports separating history from retained knowledge. Memory list is searchable by fact/inference, source, Bot and scope. Detail shows original source, derivation and last use. Correct creates a superseding record; Forget previews affected derived contexts/artifacts/work and then withdraws retrieval. It does not pretend to delete unrelated original conversations. Private scope is checked before relevance or ranking. Model/computer switching keeps product memory and retire/rebuild semantics for stale contexts. Never promise that deleting a UI row purges already downloaded content.

## Connections and routing

R05/R12 support contextual connection with return-to-work. Connections tabs: Apps, Tool sources, Skills/plugins. A source row shows connected/needs login/unavailable/revoked, approved account/recipient, shared/private scope, effective tools and last verification. Add from catalog or direct configuration; no mandatory hosted catalog. “Connected” is separate from “Available to this Bot,” “Allowed for this purpose,” and “Allowed to send these data.” Reconnect returns to originating task but does not auto-approve its pending action.

HTTPS MCP, OpenAPI/GraphQL and gateway setup reviews endpoint, auth method, schema/version, discovered operations, effects/recipients and availability. Tool discovery is data. Unsupported actions remain unavailable; remote uncertainty reconciles within run-scoped sessions. OAuth/secret entry is a protected surface. Skill/plugin import reviews pinned origin/version/license and instruction versus executable parts; unsupported parts are named. Enabling instructions does not connect apps or authorize protected-host code execution.

Model settings show configured Schway routes, actual model/effort support, account/billing recipient, finite limits and pins. Unavailable routes give a concrete reason. Automatic fallback can use only already approved recipients/routes and must report the actual selection. New account/disclosure obligations use their own review. Do not import upstream provider loops.

## Voice and clients

R09/R10 inform controls. Dictation starts only after an intentional mic action and permission; show Recording, elapsed time, Stop, Cancel. Transcript is editable before sending. Listening to a reply is separate from work cancellation. Continuous call shows Listening/Thinking/Speaking/Muted/Reconnecting, transcript, interrupt and End call; interruption immediately stops playback, fences pending voice turn dispatch and reports whether underlying work continues. Limits and provider/local route are visible before starting; no background metered capture. Spoken approval is not an exact protected decision: present review on the authenticated surface.

Web and desktop share the same client contracts. Desktop first launch connects to an existing installation; installing the app does not enroll the owner's machine. Explicit optional host enrollment lists native privileges and withdrawal. Update/recovery never silently adopts another runtime/store. Mobile uses the same durable object IDs, files, needs-you and artifacts, secure credential storage and foreground resync. Bottom navigation: Chats, Needs you, Work, More. Push notifications carry minimal private content and authenticated deep links; opening a push re-fetches current action revision. Messaging channels advertise attachment/result capabilities and link to authenticated exact review if full details cannot be rendered. Delivery retries reuse durable delivery IDs and never impersonate a new owner.

## Binding table

E = inspected existing operation, not proof of every composed client path. P = PROPOSED missing or expanded contract; operation names below are design names, not implemented endpoints. Parent must finalize exact signatures before runtime tickets claim availability.

| Action/state | Binding and implementation status |
| --- | --- |
| Read conversation / receipt / progress | E: `createConversationHandler`, GET `/api/s15/conversations/:id`, GET `.../:id/events?after=`, GET `/api/s15/requests/:id`; `conversationOwnerView`, `app.events`, `app.view`. Control events contain no result payload; fetch freshly guarded projection. P: shared paginated snapshot/version contract and reconnect reducer for all clients. |
| Send ordinary text / retry same send | E: POST `/api/s15/conversations/:id/messages`, `app.submit`, `s15-conversation/v1`, durable receipt and drain. P: file-bearing version with immutable input references, input-only semantics and conflict fingerprints. Do not silently extend v1. |
| Stop | E: POST `/api/s15/requests/:id/stop`, `app.stop`; acknowledgement is `stop_requested`. P: client settlement projection must distinguish transport stop from external settlement. |
| Busy steering / independent task | E: further `submit` and existing continuation field for held clarification. P: targeted live steering with accepted/applied cursor, ordering, scope and cancellation semantics; never relabel continuation as live interruption. |
| Needs-you / exact approve/deny | E: `conversationPendingNeeds`, `conversationAction`, `app.decide`, `s15-conversation-decision/v1`, exposed through `s15ConversationPort` in `web/handler.ts`. P: shared protected JSON owner adapter for decisions; current messages handler is not a generic decision endpoint. |
| Capability discovery / file pick | P: `s16-client-capabilities/v1`; server-derived limits and composed availability. No upload exists in current CHAT. |
| Upload / validate / cancel / recover receipt | P: `upload.create`, `upload.write`, `upload.finish`, `upload.status`, `upload.cancel`; quarantine, bounded validation, scoped immutable receipt and expiry cleanup. |
| File context / VM staging | E: `ConversationToolPort.open`, guarded tools; TEAM `capture`, `source`, leases; memory lineage/guard seams. P: trusted receipt-to-context/staging adapter, bounded extractor/image seam verification; legacy upload authority excluded. |
| Tool execution / resource hold | E: CHAT admission/guards, Schway public `schway/host`, TEAM `resource/acquire/dispatch`, disclosure/effect guards. P: attachment ancestry integrated before any model recipient or VM release. |
| Save result / preview / download / revise | E: guarded CHAT result publication and `web/library.ts` result projection only. P: `artifact.collect/commit/read/download/revisions`, immutable bytes, atomic result association, revocation and isolated preview. |
| Computer watch/takeover/login/hand-back | E: `BrowserOwner.takeover/frame/input/handBack/checkSession/reconcile` in `browser/types.ts`, guarded gateway; `BrowserWork.execute/resume`. P: general modern browser capability + transport proof, graphical guest desktop contract. Current provisioned static policy is insufficient. |
| Shared/private resources | E: TEAM `resources/register/registerReviewed/resource/handoff/acquire/guardLease`; existing scopes and withdrawals. P: composed shared-computer/client lifecycle and explicit migration of any private data. |
| Memory view/correct/forget | E: GET `/api/s15/memory`, POST `/api/s15/memory/commands`, `MemoryService.view/command/prepare/guard/derive`. Adapt actual command schemas; do not invent a second memory authority. |
| Durable work / routine / delegation | E: `ResponsibilityPort` and GET `/s15/responsibilities/:id` read-only projection, TEAM handoff/leases. P: complete client schedule/event configuration, worker lifecycle and cross-client notifications; projection read must never start work. |
| Connections / model selection | E: resources projection and S15 model/effects services, `web/types.ts` ports, mail/Google effect adapters. P: general connection catalog/auth lifecycle, MCP/API schema review, skill import and expanded supported route clients. Existing adapters do not prove universal connectors. |
| Bots / search / archive/export | E: current conversation/resource/memory projections. P: full Bot lifecycle, authorized cross-object search and immutable-artifact index; no hidden project authority. |
| Voice / native clients / messaging files | E: existing Web/Telegram and durable work concepts. P: voice lifecycle/usage, packaged desktop/mobile sessions and capability-aware attachment delivery. No native availability claimed here. |

## Architecture recommendation and actual reuse

Prefer a small React + TypeScript client, Bun-built and served by Jit, with a shared typed client/reducer package and Jit-owned protected API adapters. This is simpler for continuously updating transcript, independent uploads, inspectors, native reuse and reconnect than growing `src/s15/web/enhance.js` around server-rendered fragments. Costs: JS build/dependency lifecycle, larger client, accessibility/focus responsibility and schema versioning. Extending SSR remains cheaper for a single isolated form but duplicates live state across Web/mobile/desktop. Do not indefinitely maintain two feature-complete interfaces.

Start behind explicit S16 client selection on opt-in S15, sharing the existing service authority and state. Old routes remain during migration; a capability-complete replacement can retire them after compatibility/rollback evidence. No-script fallback is not a new-client requirement. Keep current durable stores for the first slice; a PostgreSQL consolidation is worth proposing only if cross-store atomic publication/recovery demonstrably becomes simpler. It adds deployment/backup/migration costs and is not required to render React. Store implementation may change; revocations, usage, private ancestry and unknown effects cannot be reset. Do not import a second authority/scheduler/runtime.

All upstream paths below were inspected at immutable Rakazo commit `abf3c08145a05cba92a912d6c24fdfb5f569d0e0`, [source tree](https://github.com/elie222/rakazo/tree/abf3c08145a05cba92a912d6c24fdfb5f569d0e0). These are candidates, not imports or dependency selections:

| Actual module | Useful seam and required adaptation |
| --- | --- |
| `packages/contracts/src/attachments.ts` | MIME/preview classification and nonempty text-or-artifact validation helpers. Separate classification from server acceptance; do not copy static upload defaults or assume upstream MIME support. |
| `apps/web/src/lib/pending-attachments.ts` | File-paste detection and object-URL cleanup; adapt with conversation/generation-scoped upload state. Avoid its base64 whole-file read for bounded streaming upload. |
| `apps/web/src/lib/thread-events.ts` | Durable send-receipt and snapshot/event merge concepts. Imports many `@rakazo/core` helpers and upstream ProductEvent types; port reducer behavior against Jit events rather than importing the whole module unchanged. |
| `apps/web/src/components/ArtifactFileCard.tsx` | Separate preview/download controls and error/focus handling. Coupled to Lingui, contracts, icons, local viewer/RPC helpers; replace data/auth/i18n and prove preview isolation independently. |
| `packages/chat-ui/src/markdown.web.tsx`, `markdown.native.tsx`, table/mermaid helpers | Rich text foundations and tests. Package depends on contracts/core/ui-web/ui-tokens, React 19.2.3, react-markdown, remark-gfm, unified, Prism, linkify-it, Mermaid and native markdown renderer. Extract a narrow Web renderer first; defer Mermaid/native dependencies unless needed and audited. |
| `packages/ui-web`, `packages/ui-tokens/src/index.ts` | Semantic token structure and accessible primitive candidates. UI package brings Base UI, cmdk, lucide, sonner, Tailwind utilities and core/contracts dependencies. Select components; rename storage keys and apply Jit tokens. |
| `apps/web/package.json` | React/Vite shell uses React Router, TanStack Query, oRPC, Lingui, Better Auth and Sentry. Do not inherit upstream auth, hosted assumptions or telemetry. A typed fetch adapter over Jit is sufficient initially; oRPC is optional. |
| `apps/desktop/src/window-options.ts`, desktop package | Existing-instance window/packaging concepts; Electron 45.2.2, electron-updater, native `koffi`, logging/Sentry dependencies in reference. Audit privilege/preload/update boundaries; no implicit host-computer enrollment. |
| `apps/mobile/lib/thread-sync.ts`, mobile package | Session-generation/target guards prevent old responses appearing under a new Bot. Expo 57, React Native 0.86.3, secure store, pickers, notifications/audio/WebView and native dependencies imply real device work. Share contracts/reducers, not assumptions that DOM components run natively. |

No code or proprietary image is copied in this handoff. Before actual adaptation record upstream path/commit/original hash/destination/license/modifications, retain Apache-2.0 and applicable notices with prominent modified-file notices; audit nested assets/dependencies separately. Jit-origin MIT code remains distinct. No upstream branding, Sentry requirement, SaaS billing or provider engine is imported. Verify chosen dependency versions in the implementation environment rather than treating reference versions as approved.

## Copy, accessibility and responsive behavior

Every key below is required in both `src/i18n/en.ts` and `src/i18n/th.ts` during implementation. This document supplies English source copy only; actual Thai strings belong only in `src/i18n/th.ts`. Use existing equivalent keys when exact semantics match; otherwise use the proposed `s16.*` namespace. No concatenated translated fragments; placeholders are named and escaped, counts use locale-aware formatting.

| Key suffix under `s16.` | English source copy |
| --- | --- |
| `nav.needsYou`, `nav.artifacts`, `nav.connections` | Needs you / Artifacts / Connections |
| `chat.placeholder`, `chat.steer`, `chat.queued`, `chat.applied` | Message {bot} / Steer this work / Queued for the next step / Steering applied |
| `chat.sending`, `chat.received`, `chat.draft`, `chat.result` | Sending / Received / Working draft / Result |
| `chat.stopping`, `chat.stopped`, `chat.unknown`, `chat.reconnecting` | Stopping / Stopped / Outcome unknown / Reconnecting — checking saved work |
| `files.attach`, `files.unavailable`, `files.limits` | Attach files / File uploads are not available on this installation. / Up to {count} files, {fileSize} each, {totalSize} total. |
| `files.uploading`, `files.validating`, `files.ready`, `files.remove` | Uploading {name}: {percent}% / Checking {name} / Ready / Remove {name} |
| `files.unsupported`, `files.tooLarge`, `files.invalid`, `files.expired` | This file type is not supported. / {name} exceeds the {limit} limit. / This file could not be read safely. / This upload expired. Select the file again. |
| `files.inputOnly`, `files.reselect`, `files.cancel`, `files.retry` | Files received. What would you like me to do with them? / Reselect {name} / Cancel upload / Retry upload |
| `artifact.preview`, `artifact.download`, `artifact.sources`, `artifact.revise` | Preview {name} / Download {name} / Sources / Revise this file |
| `artifact.deliveryFailed`, `artifact.unavailable` | Work finished; file delivery failed. / This file is no longer available. |
| `approval.approve`, `approval.deny`, `approval.changed`, `approval.review` | Approve this action / Deny / This action changed. Review the new version. / Review action |
| `hold.recipient`, `hold.resource` | Review access for {recipient} / Waiting for {resource} |
| `computer.take`, `computer.taking`, `computer.owner`, `computer.return`, `computer.checking`, `computer.stale` | Take control / Taking control / You are in control / Return to Bot / Checking session / Screen disconnected |
| `scope.shared`, `scope.private`, `connection.unavailable` | Shared with approved team work / Private / Unavailable: {reason} |
| `voice.recording`, `voice.muted`, `voice.end`, `voice.review` | Recording / Microphone muted / End call / Review this action on screen |
| `routine.next`, `routine.pause`, `memory.correct`, `memory.forget` | Next run: {time} ({timezone}) / Pause routine / Correct memory / Forget memory |

Also provide labelled keys for all Bot lifecycle actions, schedule fields/DST/misfire choices, source types, tool availability reasons, route/effort/pin/usage, library filters, navigation, empty/loading/error states and native permissions as those slices land. No raw server error used as sole user copy; retain a copyable safe diagnostic code in Details.

At ≥1200px use rail/chat/inspector; 768–1199px use collapsed rail and inspector overlay with focus restoration; below 768px use one pane, full-height detail routes and mobile bottom navigation. At 320px no page-level horizontal scrolling; tables/code scroll in labelled regions. Composer follows safe area and virtual keyboard without covering final messages. Touch targets ≥44px, text zoom 200%, contrast WCAG AA, visible focus in both themes. No hover-only controls.

Keyboard: Tab reaches attach, chips, editor, send and active-work actions in visual order; Enter sends unless IME composition is active, Shift+Enter newline, configurable Enter behavior; Escape closes menu/inspector and restores trigger focus, never approves or cancels work. Command/Ctrl+K opens search; shortcuts are discoverable. Dialogs trap focus; sheets have titles; progress uses throttled polite live announcements, errors assertive only when actionable. Do not announce every token. Reduced motion removes streaming typewriter, pulses, waveform motion and smooth scrolling; status text remains complete. Approval details remain readable at mobile zoom before any action button. Charts/images have accessible summaries; computer control offers labelled keys and disconnect state without relying on pointer color.

## Acceptance and delivery map

These are scenarios to implement and run, not tests claimed passed by documentation. Use scripted models, protocol fixtures, barriers and fake clocks; live provider/device evidence is separately opt-in at exact builds.

| S16 acceptance | Required observable scenario / owning slices |
| --- | --- |
| AC01 | Create accepted Bot, configure, restart, archive/restore/duplicate/export without credentials or widened resources — BOT16/TEAM16. |
| AC02 | Submit second request during work and during pending approval; targeted steering acknowledgement, independent stop, cursor replay and no duplicate effects — API16 #395. |
| AC03 | TXT plus supported PDF/image each drive real bounded tool work; invalid/cancelled input produces no runnable work — FILE16 #396. |
| AC04 | Download hash equals collected bytes after restart; revise creates new identity; withdrawal blocks preview/download — FILE16/ART16. |
| AC05 | Two Bots share approved resources with exclusive input leases; private source never crosses scope; idle/restart retains state — TEAM16. |
| AC06 | Modern public-site interaction with actual mediated requests, supported login and held effect/disclosure; static GET fixture alone fails — BROW16 #397. |
| AC07 | Takeover waits for fencing; old input/frame generations fail; protected login excluded from agent history; hand-back checks session — DESK16. |
| AC08 | Peer and temporary children run bounded assignments; cancel/fail one preserves sibling evidence across restart — DELEG16. |
| AC09 | Fake-clock DST/misfire/coalescing, signed event duplicate and restart while awaiting owner preserve exactly one responsibility — ROUT16. |
| AC10 | Correct/forget sourced fact/inference, rebuild stale context, private retrieval filters precede ranking — MEM16. |
| AC11 | Connect/reconnect/revoke a real app in client; return to work with no implicit action approval — CONN16. |
| AC12 | Versioned MCP and API source discovery, run-scoped session, recipient hold and unknown remote reconciliation — MCP16/OPEN16. |
| AC13 | Pinned skill/plugin review shows unsupported parts; instructions cannot execute on protected host or grant authority — SKILL16. |
| AC14 | Route/effort change respects pins, reports actual use, holds new recipient and preserves conversation — MODEL16. |
| AC15 | Permission denial, dictation edit/cancel, playback interruption and continuous call reconnect respect finite budget; speech cannot approve — VOICE16/CALL16. |
| AC16 | Packaged desktop connects/updates/recovers; installation alone never enrolls host computer — DESKTOP16. |
| AC17 | Mobile file send, foreground reconnect, exact review, preview and needs-you push on actual devices — MOBILE16. |
| AC18 | Bound messaging retries reuse delivery identity; unsupported attachment/approval capabilities link to authenticated client — CHANNEL16. |
| AC19 | Second backend advertises truthful capabilities; stop/recovery and state portability tested with settlement evidence — COMPUTER16. |
| AC20 | Cross-object search filters withdrawn/private data, library revision navigation, labels do not widen authorization — ART16/SPACE16. |
| AC21 | Upgrade/backup/export/restore preserve policies/withdrawals/usage/unknowns; rollback cannot rewind authority; third-party notices ship — OPS16/BASE16. |
| AC22 | Exact-build composed file, website/login, delegated routine across restart, held connected action and voice/mobile tasks, with explicit live gaps — EVID16/CUT16. |

First-slice deterministic checks must additionally inject failure immediately before/after upload receipt, message commit, tool dispatch, object collection and result publication. Replay duplicated/out-of-order events; same request ID with changed payload must fail. Race stop against commit, withdrawal against preview/download, expired receipt against resumption, late upload against conversation switch, stale approval against revised artifact hash. Enforce aggregate/decompression/time bounds and test hostile filename/path/MIME/polyglot inputs. Result assertions require actual tool evidence and downloadable bytes, never only model prose.

Client/browser acceptance: keyboard-only attach/remove/send/preview/download; IME Enter; mobile keyboard resize; back restores draft/scroll; two tabs cannot apply stale approvals; lost response does not duplicate work; refresh during validating/working/needs-you/unknown restores truthful state. Verify sandbox cannot read cookies, fetch network, navigate parent or send trusted commands. Screen-reader/reduced-motion and Thai/English long labels must pass without clipped actions. These browser checks belong to implementation; no prototype or preview was produced here.

## Parent implementation order and blockers

Proceed with #395 shared protected client contracts and real tool-backed conversation, then #396 upload/receipt/context/collection/publication as one observable path. #397 can independently resolve modern browser mediation and graphical transport against this experience. Each must inspect its current issue/ownership/prerequisites before coding. Remaining graph in [the roadmap](../tickets/S16-rakazo-experience-roadmap.md) remains required.

Missing contracts blocking claimed first-file completion: capability discovery, bounded upload and receipt lifecycle, file-bearing command version/input-only semantics, receipt-to-Schway/VM adapter, immutable collection and atomic publication, authorized download/preview revocation, and honest client reconnect/steering semantics. No missing live credential blocks deterministic implementation. Modern-browser feasibility, native packaging/device tests, voice providers and full connection/routine/Bot lifecycle are separate remaining delivery work. An exact missing Schway public host capability requires a bounded public-only reproduction and upstream proposal; no engine blocker is inferred merely from missing Jit UI.

The parent should review these proposed shapes and implement the initial slices; it must not mark S16 complete from this handoff, a mock, or the first successful file.
