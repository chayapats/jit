---
status: proposed
date: 2026-11-02
scope: S15-D01–D23; FR-01–FR-42; NFR-01/02/05/06/07/08/09/10/12/14
---

# Conversational authority and a protected control plane

## Status and confirmed inputs

[S15](../specs/S15-conversational-autonomy.md) is the owner-confirmed product target. This ADR proposes an implementation direction and records proof obligations; its proposed status does not make the accepted product decisions provisional. S14 remains the implemented default runtime, with its existing versioned contracts and evidence.

The owner selected ordinary conversational work intake, a dedicated administrable VM, shared team resources, browser-first work, automatic sourced memory and bounded model selection. Ordinary reversible work may execute under standing policy. Communications, payments, production, new private-data recipients and major unapproved changes encounter their applicable human boundary. Those boundaries must be enforced by the system.

For GitHub, inspection waits for the owner to select and start an issue. Default publication/replies need approval. A separately configured personal exception may perform technical publication, review remediation and eligible auto-merge. Production still waits, including when deployment is an automatic consequence of merge.

## Supersession scope

For the S15 target, this refines the intake/authority design in ADRs [0004](0004-task-authority-and-staged-execution.md), [0016](0016-task-acceptance-without-execution.md), [0037](0037-access-levels-approvals-and-connections.md), [0045](0045-bot-first-domain-and-fresh-state.md), [0046](0046-bot-computers-and-explicit-sharing.md), [0048](0048-concurrent-work-and-replay-safe-recovery.md) and [0049](0049-s14-opt-in-foundation.md). They remain accurate history and, where implemented, contracts for S14/legacy. In particular:

- A public Work-mode ceremony and per-task manual grants cease to be product requirements. Internal typed commands, receipts and authorization remain necessary.
- Private computers/accounts for every Bot cease to be the team default. The protected control-plane boundary and explicit narrower data restrictions remain necessary.
- Every external write no longer requires a separate exact approval: ordinary authorized reversible edits and explicitly captured standing exceptions may proceed. Human-required classes retain exact or narrowly bounded standing authority.
- A research-only workflow is no longer the target's capability ceiling. A broad browser/shell capability must still satisfy the protected-effect boundary.

## Proposed architecture

Separate two trust domains:

1. **Protected control plane:** authenticated owner ingress, standing policy and its revisions, current scopes/budgets, work/effect ledgers, service credentials, approval execution, lifecycle state, evidence publication and recovery controls. The working agent cannot modify this domain or impersonate the owner.
2. **Working plane:** the owner-supplied dedicated VM and work-scoped inputs/files. Jit performs approved computer administration and ordinary tools here. Team members may share its approved resources, while workspace/browser concurrency is coordinated.

Protected website-session material and financial/communication capabilities must not become raw credentials or reusable unrestricted session handles available to the working VM. Team access to an account is a mediated capability, not permission to copy cookies into a shell. Required network/effect enforcement must survive guest root; a guest firewall, local Unix permissions or a sibling process alone cannot establish that property.

The physical placement, VM transport, privileged-operation design, protected browser backend and egress mechanism are unresolved. This is a trust-boundary requirement, not a claim that deploying two containers or machines automatically proves it.

## Conversational admission

The protected service authenticates actual owner ingress and retains a standing policy. It records the requested purpose and admits bounded execution only inside that policy. Interpretation may choose an appropriate method, enabled team member and approved route. It cannot mint an approval, change the purpose to a different obligation or widen policy.

An inspect/recommend request yields inspection/recommendations. An accepted suggestion or selected issue without a request to execute is insufficient. A direct instruction to execute can atomically record purpose, policy/resource references, limits and a deduplicated work intent, without another Work-mode confirmation. Selection and execution intent may be expressed in the same conversational reply; internal obligation/grant records do not require two owner messages.

Natural approval responses must resolve to an exact pending proposal/action and authenticated actor. Ambiguous references wait for clarification. Repository documents, copied owner text, memory, website content, review comments and model output never carry owner authority.

No new public command/schema/API is specified by this ADR. Existing S14 message.post/work.start signatures are not silently reinterpreted by documentation; a versioned implementation contract is required.

## Standing rules and action execution

A proposed rule captures owner/configuration provenance, revision, permitted purpose/action classes, resources/destinations, finite limits, applicable conditions and revocation. A concrete action is checked against the current rule and recorded with its actual content/target. Manual approval additionally binds the exact recipients/content/attachments or transaction details and current revision.

The personal GitHub exception must be explicitly installed through trusted configuration. Verify selected issue/start authority, current repository/target/head, acceptance evidence, required checks/reviews and production consequences before an allowed merge. A repository instruction or green status cannot create that exception. Product upgrades do not enable it by default.

An uncertain policy match holds the action. Unsupported tools cannot route the action through another shell, browser or MCP path. Unknown remote outcomes reconcile; an expiring or lost local receipt is not proof of no remote effect.

## Required feasibility findings before activation

- **Root administration versus destructive gates:** root can erase its own mutable guest files and change guest-local services. Recovery snapshots are useful but do not prevent a prohibited action. Specify protected data and the administration boundary, then demonstrate both required capability and actual enforcement. If that requires changing the agreed scope or guarantee, return the tradeoff to the owner.
- **Generic browser versus effect gates:** unrestricted authenticated website control can submit effects through multiple paths. Neither a model classification nor a generic click/read label proves harmlessness. Demonstrate supported workflows and their bypass resistance; identify constrained/unsupported websites honestly.
- **New private-data recipients:** enforce disclosure policy across browser uploads, shell/MCP network use and service/model calls. Reusing a public-browsing path must not bypass an upload hold.
- **Operating budgets:** define reservations, measured/unknown usage, settlement and finite limits before admitting metered work. The interview did not select an amount, currency period or resource profile.
- **Durable waiting and progress:** distinguish active attempts from CI/review waiting, preserve responsibility across restart, and define measured stall criteria. Cancellation retains capacity until settlement; arbitrary effects do not become replay-safe because a model says so.
- **State transition:** do not infer permission to erase S14/legacy, promote its private data to team scope, widen installed policy or accept a new host from this product decision. Prepare a versioned transition and rollback plan.

These are engineering gates, not additional product decisions or already verified blockers on published implementation tickets.

## Runtime ownership and design

Schway continues to own loops, providers, native sessions, compaction and model retries. Use supported public host/tool/backend/session contracts and verify the exact supported artifact. A missing host contract requires a Schway proposal, not an internal import, host-shell escape or Jit-owned replacement loop.

Preserve useful receipt, attempt-fencing, source-lineage, artifact, reconciliation and backup mechanisms where their contracts remain valid. Do not preserve a per-Bot ceremony solely because the old schema has it, and do not rewrite working durability mechanisms solely to change presentation.

UI/UX implementation needs the required Claude Opus 5.5/high author. No concrete UI/UX is authored here. Future Jod interoperability should preserve provenance/status through an adapter; transport/storage/synchronization remain deferred.

## Evidence

Evaluate S15-AC01–AC16 with deterministic owner-ingress/policy/effect fixtures and independent real VM/browser enforcement evidence. Include guest-admin bypass attempts, stale generations, cross-profile authorization, new-recipient uploads, production-triggering merges, duplicate/unknown effects, wait recovery and stalled progress. Report actual limitations before claiming a supported release.
