---
status: proposed
scope: S14-D01/D04/D05/D06/D12/D15; supersedes project-root choices in ADRs 0003, 0018, 0031 and 0037 for the new store
---

# Bot-first identity and fresh application state

## Confirmed direction

[S14](../specs/S14-bot-first-local-assistant.md) replaces required Projects with persistent Bots and authorizes fresh state without legacy-data conversion. Jit owns the domain; Schway retains runtime ownership. This ADR proposes engineering, not shipped behavior.

## Proposed choice

Use a new versioned SQLite application-store format. Opening a legacy store with the new runtime returns an explicit incompatible/fresh-state next action before workers start. Fresh initialization uses a distinct store path; it never overwrites, imports or deletes a legacy database, box, backup or native session. Existing deployment remains usable on its old build.

Model product identities explicitly:

- Owner and installation: security principal and configuration root.
- Bot: stable identity, responsibility, persona reference, enabled/retired generation, configured route, capability policy and computer reference.
- Conversation: durable messages and Bot participation, with no independent authority. No hidden General project.
- Work item: requested/proposed/accepted/working/waiting/ready/partial/failed/cancelled obligations and completion rule.
- Work grant: owner actor, exact command/proposal revision, purpose, allowed Bots/resources/tools, finite limits, expiry and revocation generation.
- Job/attempt: bounded execution and durable recovery identity, separate from obligations and Bot identity.
- Source/claim/artifact/share: immutable origin/revision and access policy, independent of any Project.
- Connection/effect/approval/routine: owner-controlled resource bindings and exact actions.

A direct authenticated work command may commit work plus its grant and queue intent in one receipt transaction. Accepting a proposal alone commits no start grant. Bot proposals are revision-bound and permanent creation is an owner command. Delegation consumes the existing grant, applies receiver capabilities and records a bounded context handoff.

The context assembler filters accessible Bot-private and explicitly shared sources before relevance selection. Shared owner facts require owner publication/authorization; extraction cannot promote private data. Stable provenance uses originating Bot, conversation and source revision. Source correction/forget/delete and native-context retirement keep the existing lifecycle invariants.

Versioned future contracts are proposed as app.bots/v1, app.work-grants/v1, app.conversations/v2 and app.memory-scope/v2. Names do not imply implemented signatures. Exported code contracts receive TSDoc when implemented.

## Alternatives and consequences

Retaining a hidden system Project would preserve the unwanted ownership/permission root and is rejected for the new store. Rewriting every proven subsystem is unnecessary: receipt, fencing, outbox, sanitization and lifecycle algorithms may be reused behind the new identities.

A fresh format simplifies transition but does not waive future schema-upgrade/recovery requirements. The first store format and every foreign key/backup classification must be specified in its implementation ticket. Old data is left intact rather than silently made available to new Bots.

Delivery ownership: [BOT14-02](../tickets/s14/BOT14-02.md) covers capability edits/retire/delete with generation fencing; [OPS14-01](../tickets/s14/OPS14-01.md) covers consistent new-store backup, staged upgrades and quarantined restore against the current independent lifecycle ledger before workers start. [EVID14-01](../tickets/s14/EVID14-01.md) requires their Linux evidence. Fresh state waives legacy conversion only.

## Evidence required

Fresh setup without any project row; duplicate command receipts; proposal acceptance without execution; private-source lookup denial; explicit share and revoke; lifecycle propagation; legacy-store refusal without byte changes; restore before worker activation. Requirements: FR-01–FR-07, FR-16–FR-23, FR-35; NFR-05/07/08/12.
