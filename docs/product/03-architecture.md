# Jit Architecture Proposal

Current direction: [S14](../specs/S14-bot-first-local-assistant.md), owner-confirmed 2026-10-30. This is an engineering proposal; the current runtime remains S09–S13. [CONTEXT.md](../../CONTEXT.md) defines domain terms.

## Boundaries

Jit owns authenticated commands, permanent Bots, work grants, conversations, sourced memory, computers, artifacts, approvals, routines, durable jobs and delivery. Schway owns provider protocols/auth renewal, native sessions, execution loops, tool scheduling, compaction and model retries. Use supported schway/host exports only.

No Project or hidden General project remains as the new store's authority root. Conversations organize discussion; repository/workspace references are resources. Product identities and native sessions stay distinct.

## Proposed components

- Command boundary: authenticate owner, validate typed command/revision/retry key, commit receipt/state/grant/queue intent atomically.
- Bot/work registry: permanent Bot proposals, capability ceilings, finite delegation graph and resource scopes.
- Context/memory: filter private/shared/share-granted sources before relevance, pin current owner decisions and retain correction/forget lineage.
- Scheduler: bounded typed steps, dependencies, priority, attempts/reservations, input/workspace leases and replay-safe checkpoint recovery.
- Schway bridge: independent per-run host/context/tool policy and opaque native references, with exact routes and supported cross-host credential lifecycle.
- Computer manager: private persistent Bot workspace/browser components, lazy startup and finite Linux resource bounds; no service credentials/state/socket in execution.
- Tool/effect gateway: service-owned allowlisted tools, outbound guard, untrusted evidence framing and exact-action approval/effect reconciliation.
- Research/artifact service: Parallel free-first reads, evidence snapshots, citation binding, report revisions and bounded immutable downloads.
- Channel/ops adapters: same command authority for enabled channels; durable outbox, routines, backup/lifecycle and staged activation.

## Authority flow

An explicit authenticated work.start may create work plus its finite grant in one transaction. Ordinary message.post may use already-authorized bounded conversational read tools but cannot mint execution authority through model classification. A task.accept command retains an obligation without queuing execution.

Effective execution is the intersection of installation policy, originating grant, current Bot capabilities, resource/share grants and attempt generations. A plan or delegation may narrow that set. An @mention only selects a recipient.

## Data and isolation

Proposed new SQLite format separates owner/Bot/conversation/work/grant/job/attempt/source/claim/artifact/share/connection/effect/routine records. Fresh initialization uses a distinct store path and refuses legacy input before workers start. Existing installation data is not deleted or reinterpreted.

Bot private memory, filesystem and browser sessions require actual enforcement, not labels/folders alone. Sharing publishes a named immutable snapshot through a bounded gateway. Browser-session material is isolated from shell/MCP; owner/provider/channel/vault credentials remain service-owned.

Artifacts carry type/size/hash, producer and source lineage. Render untrusted content through a safe renderer, never executable raw HTML. Downloads use opaque IDs and current authorization.

## Concurrency and recovery

Independent Bots truly overlap under global/route/Bot/computer ceilings. Browser/desktop input is exclusive; owner takeover fences agent input. A pending cancellation keeps its slot until settlement/proof of stop.

Checkpoint immutable inputs, authority/config/route, native correlation, evidence and reservations. After restart discover/fence/reconcile native orphans first. Only system-classified replay-safe steps may resume within unchanged scope and remaining budgets. Unknown effects are never blindly replayed.

## Engine gaps

[SCH14-01](../proposals/schway/SCH14-01-shared-credential-lifecycle.md) proposes process-stable opaque credential lifecycle ownership across distinct per-run hosts. Existing [Schway #414](https://github.com/chayapats/schway/issues/414) covers native correlation/enumeration. Required supported capability/version and conformance must land before dependent live activation. #413 account aliases are not an assumed MVP requirement.

Parallel search can use the existing SearchProvider. Vendor Extract may use a trusted Jit ToolDefinition; it must not impersonate Schway's direct address-pinned transport or claim to enforce the vendor's DNS.

## Decisions and integration

[ADRs 0045–0048](04-architecture-decisions.md) record proposed choices. [Authority/design resolutions](../contracts/s14-authority-and-design-resolutions.md) address the Opus handoff without turning a prototype into a public API. Existing receipt/fencing/outbox/sanitizer/lifecycle algorithms are reuse candidates. Bun/TypeScript and deterministic fixtures remain required.
