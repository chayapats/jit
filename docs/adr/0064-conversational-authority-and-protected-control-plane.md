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
2. **Working plane:** the dedicated working VM and work-scoped inputs/files. By the owner's 2026-11-03 decision this is, by default, a nested KVM guest that Jit creates and manages on the controller host; owner-supplied VMs remain optional for extra compute. Jit performs approved computer administration and ordinary tools here. Team members may share its approved resources, while workspace/browser concurrency is coordinated.

Protected website-session material and financial/communication capabilities must not become raw credentials or reusable unrestricted session handles available to the working VM. Team access to an account is a mediated capability, not permission to copy cookies into a shell. Required network/effect enforcement must survive guest root; a guest firewall, local Unix permissions or a sibling process alone cannot establish that property.

The [s15-runtime-feasibility/v1 contract](../contracts/s15-runtime-feasibility-v1.md), revision 1, records the bounded ARCH15-01 audit at main `64f3a94726fdbce2283aec0944884ca7406d9934`, the exact Schway artifact, operation/attack matrix and RF15-G01–G08 proof gates. Its candidate keeps Jit/Schway authority, native state, credentials and VM management outside the administrable guest, with a separately protected browser/effect domain. VM backend, transport protocol, privileged-operation support, browser workflows and egress mechanism still need reviewed implementation contracts and real evidence. Deploying two containers or machines alone proves none of those properties.

## Feasibility choices and limits (ARCH15-01)

The confirmed S15 decisions above remain unchanged. The following are reviewable engineering choices, not accepted host placement, installed policy or completed enforcement:

- **Proposed integration:** keep Schway in the protected service and compose its public `coreToolDefinitions(ExecutionBackend)` with Jit-owned VM transport and guarded `ToolDefinition.execute` callbacks. Direct core-tool paths remain bounded; shell administration needs a real guest boundary. The public backend is trusted host code, not a sandbox. No protected-host `localExecutionBackend` fallback is permitted.
- **Proposed placement:** keep owner ingress, policy/effect/current continuity/command receipts, credentials, original checkpoints and native correlation workspaces outside guest control. Use host-initiated bounded VM access with management authority retained outside the guest; freeze the actual protocol before implementation admission. Sensitive website sessions also remain outside guest-root reach. A guest-local sibling process, Unix permissions or firewall is rejected as isolation from root.
- **Proposed support boundary:** deny unknown browser/effect/MCP/egress paths before dispatch. Known preparable actions lacking authority can be held; approving an incomplete card cannot make an unsupported workflow safe. Arbitrary authenticated clicks/JS/CDP, encrypted host allowlists, GET/read-only labels and model classification are rejected as universal effect/disclosure enforcement. Public navigation and approved dependency acquisition still need actual destination/payload policy and bypass evidence.
- **Confirmed owner tradeoff RT15-01 (2026-11-03):** option B is accepted: unrestricted root/sudo inside an expendable guest, valuable originals/credentials/publication/external effects outside it, and protected snapshot restore as recovery rather than prevention. Do not re-ask this decision or claim guest destruction is prevented. Shared guest units provide guest-reported/cooperative settlement; an externally observed hypervisor stop provides strong settlement. Before Jit-initiated system-wide administration, take an exclusive VM lease and protected snapshot; hold it if recovery is unavailable. Restore remains owner-required absent a separately captured standing rule. [ADR 0067](0067-s15-working-vm-operation-and-settlement.md) records implementation and residuals. The single-host topology below is the default; the arm64 Lima reference on the owner’s Mac remains evidence for the optional owner-supplied path. Actual host adoption and external-effect enforcement remain separate.
- **No demonstrated upstream blocker:** the pinned public host exports suffice for the proposed execution/custom-tool composition. VM management, protected browser semantics and external egress remain Jit integration/proof gaps. Create a Schway proposal only when an exact required host behavior cannot be expressed through the public seam and a bounded public-only fixture demonstrates it. Do not infer an engine blocker from the absence of a built-in browser or VM manager.

The current audit reproduced 60 deterministic tests across the packed S14 public consumer, Schway bridge and core-tool backend suites (0 failures). That audit ran at pin `schway@1.0.0-rc.2`, upstream `697bf406a84c8d1deb8d4a6d71876ea1003be5b3`, tarball SHA-256 `1c9d83de46edddff58a0163452e7f5ec8357e656c90093990fa28fa606a0f41b`. MODEL15-02 (#372) re-vendored the pin to upstream `0a10abedcd72aae7c92371fee277af7d90d4e52c` (Schway main `4163e60dc4efab01c82bb4828af8965b7b95dd51`, tree `260631a932c7de8825b8800cdfb69964912f9a38`), tarball SHA-256 `fe219842340f850015dda54ffebd989b52ef4bf3a9da6badfba48dc6a4efbf94`; it retains those capabilities and adds dispatch-authorization/v1, provider-requests/v1, effort/v1 and output-cap/v1. MODEL15-03 (#381) re-vendored it to Schway main `aac2fc0afdfe53f0a5076cb9d3edfaf33d280581` (tree `b63729cd5bc0a55b1fa9364ec57d28dec21a65d2`), tarball SHA-256 `2801a5a4a322faabba276a0f607f39027784e2e1e73b720937c77b0f4f0027ae`, which adds route-renewal/v1. No live VM/root/browser/account enforcement or adoption was tested. The contract separates these local results from unproven activation gates; closing the audit does not certify S15-AC03 or downstream readiness.

## Single-host topology (owner decision, 2026-11-03)

The owner retired the Pi and chose **topology option A as the default**: one host runs the S15 controller, and the working VM is a nested KVM guest that Jit itself creates and manages on that host. The protected control plane (owner ingress, policy, ledgers, credentials, native sessions, browser profiles, VM management) stays in the controller; the guest receives only a generated SSH client key's public half, its own pre-generated host key and a cloud-init seed. Owner-supplied SSH VMs with Lima/Proxmox management remain optional for extra compute (POOL15-01); a host without KVM falls back to that enrollment.

Properties the implementation must keep (VM15-02, [ADR 0067](0067-s15-working-vm-operation-and-settlement.md)):

- **No guest route to the controller.** One NIC on QEMU user networking with `restrict=on` and IPv6 off: no default route, DNS, gateway or host service is reachable. The only paths are a loopback-only SSH host-forward (controller to guest) and one guest-forward to the protected registry proxy's controller-only Unix socket, which requires a per-session lease. Guest firewall changes do not matter; isolation is enforced by the QEMU network backend outside the guest.
- **No shared host resources.** No shared directory (9p/virtiofs), monitor, guest agent, vsock, SMB/TFTP or extra NIC; the base image is read-only and each VM has its own qcow2 overlay. Hypervisor facts (state, MAC, SSH forward, network profile, CPU/RAM/disk) are read from the controller (`/proc/<pid>/cmdline`, QMP, `qemu-img`), never from guest output.
- **Non-root, outside the controller cgroup.** QEMU runs as the non-root service user in a transient unit of its lingering systemd user manager, survives controller restarts and is re-attached and re-verified at controller start.
- **Strong settlement.** Stop is proven by QMP `quit`/unit stop and an independent read-back (unit inactive, QEMU PID gone, image write lock released). Snapshots are exact-tag qcow2 internal snapshots; restore leaves the VM stopped. Protected Jit state is outside the guest and never part of a snapshot.

Residuals, stated honestly rather than claimed away:

- **Hypervisor escape.** A QEMU/KVM or slirp vulnerability exploited by guest root would run with the service user's identity on the controller host, i.e. with access to protected Jit state and credentials. A separate host does not have this property. Mitigations are partial: non-root QEMU, a seccomp subset (`-sandbox on,obsolete=deny,resourcecontrol=deny`; `elevateprivileges=deny` breaks the guest-forward helper), no shared devices and distribution security updates for QEMU. Running QEMU under a separate unprivileged user is proposed hardening for the installer (CUT15-01), not implemented here.
- **Shared host resources.** CPU, memory, disk I/O and fsync latency are shared with the controller and protected Chromium. Default sizing keeps at least 2 vCPU and 6 GiB for them; the reference nested benchmark measured about 93% of host CPU and fsync of 11–15 ms. This is capacity, not isolation.
- **Proxy attribution** remains cooperative against guest root, and allowed registries may receive workspace content (destination control, not content-level disclosure prevention), as before.

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

- **Root administration and option B recovery:** the owner accepted guest-local destruction/disruption, protected external custody and recovery in RT15-01. Prove full administration and real protected snapshot/restore. Guest cgroups remain cooperative; do not describe them as root-resistant external proof.
- **Generic browser versus effect gates:** unrestricted authenticated website control can submit effects through multiple paths. Neither a model classification nor a generic click/read label proves harmlessness. Demonstrate supported workflows and their bypass resistance; identify constrained/unsupported websites honestly.
- **New private-data recipients:** enforce disclosure policy across browser uploads, shell/MCP network use and service/model calls. Reusing a public-browsing path must not bypass an upload hold.
- **Operating budgets:** define reservations, measured/unknown usage, settlement and finite limits before admitting metered work. The interview did not select an amount, currency period or resource profile.
- **Durable waiting and progress:** distinguish active attempts from CI/review waiting, preserve responsibility across restart, and define measured stall criteria. Cancellation retains capacity until settlement; arbitrary effects do not become replay-safe because a model says so.
- **State transition:** do not infer permission to erase S14/legacy, promote its private data to team scope, widen installed policy or accept a new host from this product decision. Proposed [ADR 0065](0065-s15-state-preservation-and-policy-adoption.md) and [s15-state-transition/v1](../contracts/s15-state-transition-v1.md) require preserved source bytes/private scopes, independent current withdrawals/usage/effect/request continuity, explicit policy adoption and a protected old/new runtime fence. VM/native snapshots cannot rewind authority. Post-activity rollback refuses without a tested reverse projection that preserves newer facts; native relocation is not inferred.

These are engineering gates, not additional product decisions or already verified blockers on published implementation tickets.

## Runtime ownership and design

Schway continues to own loops, providers, native sessions, compaction and model retries. Use supported public host/tool/backend/session contracts and verify the exact supported artifact. A missing host contract requires a Schway proposal, not an internal import, host-shell escape or Jit-owned replacement loop.

Preserve useful receipt, attempt-fencing, source-lineage, artifact, reconciliation and backup mechanisms where their contracts remain valid. Do not preserve a per-Bot ceremony solely because the old schema has it, and do not rewrite working durability mechanisms solely to change presentation.

UI/UX implementation needs the required Claude Opus 5.5/high author. No concrete UI/UX is authored here. Future Jod interoperability should preserve provenance/status through an adapter; transport/storage/synchronization remain deferred.

## Evidence

DATA15-01 implements protected monotonic work/derived/shared-VM ancestry and exact new-recipient gates through the [private-data contract](../contracts/s15-private-data-v1.md). Reuse POLICY's immutable ActionSlip/approval/claim path and add owning BROW/MODEL/VM/adapter hooks; do not create a second approval authority or classify private data by patterns. Private host composition must install these catalogs/hooks before releasing data. The real registry proxy checks protected recipient scope but remains destination control only; allowed-destination covert channels are explicitly outside its prevention guarantee. Shared guest-root ancestry is installation continuity and cannot be cleared by a fresh work/session/reboot. Deterministic fixtures do not provide new real-host bypass or adoption evidence.

Evaluate S15-AC01–AC16 with deterministic owner-ingress/policy/effect fixtures and independent real VM/browser enforcement evidence. Include guest-admin bypass attempts, stale generations, cross-profile authorization, new-recipient uploads, production-triggering merges, duplicate/unknown effects, wait recovery and stalled progress. Report actual limitations before claiming a supported release.
