# s16-recovery-point/v1

Status: selected OPS16-01 aggregate source contract under
[ADR 0104](../adr/0104-s16-forward-recovery-and-retained-admission.md).
The [protected producer](s16-point-capture-v1.md) implements current control-plane
backup and receipted publication. The separate [ordinary owner export](s16-owner-export-v1.md)
uses current owning projections. Forward restore and full
upgrade/client lifecycle acceptance remain incomplete. Component manifests alone
are not aggregate points under this contract.
The fixed [point file inventory and explicit retention](s16-point-files-v1.md)
are implemented components. Their disposable format fixtures and successful
physical removal do not certify an aggregate producer, forward restore or
compatible release/client lifecycle.

## Inputs and independent current custody

Only a protected operator entry with explicit `--s15 --config` resolves the
existing installation and current package. No model/tool, guest, archive,
page content or notification chooses a host path, credential or authority.
Default S14 and explicit legacy installations retain their own operations.

An operation binds a fresh 32-lowercase-hex ID, bounded original request ID,
request hash, exact installation ID, current config/package identities and
current control revision. Identical retries return/reconcile that original
receipt; changed payloads for an existing request refuse. Operation metadata
contains hashes/outcomes/opaque IDs, not secrets, native payloads or host paths.
Installation-specific private custody details stay in the private journal.

The current cohort is independently retained protected state, not a component
of the candidate historical point. It includes all selected and retained
runtime ledgers; outer owner/auth plus its separately bound lifecycle ledger;
recipient and retained website continuity; operations receipts; and current
native/helper/VM/device deletion, withdrawal, scope, generation, usage and
original-request facts. None may be inferred empty because its file is absent.
Owning format/installation/resource identities must be checked as well as
SQLite integrity and hashes. The outer owner's random memory/lifecycle
identity is distinct from the configured S15 installation ID; both bindings
must be preserved, not forced into one invented identity column.

An independent current receipt binds the exact cohort and revision. A point
cannot provide its own trusted expected hash/current receipt. Missing,
corrupt, future, foreign or substituted current state refuses before any
activation or authority reconstruction. Reading current restrictions is not
permission to import another installation's auth or account state.

## Point inventory and receipt

The point has one canonical bounded manifest with these exact top-level fields:

| Field | Required meaning |
| --- | --- |
| `contract` | Literal `s16-recovery-point/v1`. |
| `id`, `installationId`, `capturedAt` | Exact point/installation and nonnegative safe-integer capture time. |
| `scope` | Literal `selected_control_plane`; never a claim of guest-disk or device-secret backup. |
| `package` | Verified service package hash, reviewed reader/Schway/native contract identities and shipped provenance/notices identity. |
| `configuration` | Credential-free exact selected config identity and selected/retained feature inventory. |
| `components` | Exact uniquely named closed roles, custody class, contract, bytes and SHA-256. Required roles cannot be omitted or duplicated. |
| `reconnection` | Exact excluded credential/session/device custody and existing owning reconnect requirements. |

The protected current outer receipt binds manifest hash, actual component
inventory, original request, control revision and final result. Writing a
manifest alone does not publish completion. All point files are private,
same-owner, single-link regular files under an exclusive fresh ID. Names are
opaque aliases; archive paths never choose a destination. Existing point IDs
are not overwritten/resumed. Partial points remain unpublished and bounded.

SQLite components use `s16-ledger-set/v1`; exact immutable originals,
representations/artifacts use `s16-payload-set/v1` selected by owning metadata.
Skill package bytes/pins remain with their owning immutable packages, including
licenses/notices. Schway native contexts use only supported public snapshots,
inventory, validation and restore, preserving retirement/deletion semantics;
Jit never parses or rewrites their schema. Leases, native credential stores,
unowned files and sensitive browser profiles are excluded from native copying.
Uncorrelated/pending native/parser/helper custody must be reported/reconciled,
not silently dropped or declared settled.

Working disks/cold snapshots retain separate current backend custody and exact
generation/hash references. They are not control ledgers. A requested backend
state recovery must use that backend's reviewed portable-state capability and
current-scope/settlement checks; control-plane restore cannot initiate it by
copying a historical VM row. Current physical and root-helper original intent
identities remain authoritative. Unsupported custody blocks aggregate success.

The component bounds apply before allocation/copy. Aggregate control metadata
is at most 4 MiB, 256 components and 10 retained historical points. SQL is at
most 2 GiB; selected immutable bytes at most 4 GiB. Each public native snapshot
also obeys its binary's published session/artifact/total bounds; overflow
refuses, never truncates. Native snapshots count toward aggregate bytes.
Current continuity and unfinished original operation receipts are never
evicted to satisfy historical-point retention. Cleanup itself is journaled
and must not remove a point still referenced by an unfinished operation.

## Maintenance and capture ordering

1. Acquire the existing installation exclusive lease, then existing CHAT
   exclusion. Participating selected CLI/service instances hold shared
   installation leases. Verify the exact retained inodes and configuration.
2. Publish an original durable outer maintenance intent/fence, using the
   existing S14-compatible fence refusal surface. Prove older entry points and
   installer/fallback builds refuse before writes. Unknown/torn/foreign fences
   never grant maintenance. Lock files and the operations journal are outside
   archive, activation and uninstall deletion targets.
3. Enumerate all selected and retained owning state; acquire simultaneous
   SQLite cuts and current semantic/identity checks. Capture current native
   state only through supported quiescent APIs. Pending file/parser/helper or
   physical effects keep their exact original uncertainty and custody.
4. Capture exact immutable bytes from current owning metadata. Recheck current
   authority/configuration/cohort and every component before publication.
   Release database reservations/handles conclusively; retain process fences
   across asynchronous/native operations and any unknown release.
5. Publish the complete manifest, then its independent current receipt, then
   report completion. A response loss reconciles the same original operation.
   A timeout does not release a fence while native work remains unsettled.

## Quarantine and forward activation

Verify a historical point against independent receipts before parsing opaque
contents. Validate exact required inventory, bytes, readers, owning identities,
native public contracts and package provenance in private quarantine, with no
application boot, inference, guest command, network effect or automatic retry.
Hash-matching SQLite/native bytes still require actual owning-format integrity.
Native public shape validation alone can accept a nonexistent saved branch;
verify actual native ancestry through public restore in a separate fresh
quarantine before accepting that component. Preserve exact refs/retirement and
current tombstones; quarantine verification never activates historical state.
An unknown format or missing component does not produce an empty replacement.

Build target control state from the **current cohort**, preserving its exact
original commands, withdrawals, approvals, usage, private/retired scope and
unknown effects. Recover immutable bytes only when exact current metadata
references the candidate identity/hash. Historical rows/decisions never become
new grants, recipients, sessions or effect requests. Current deleted/retired
native/device/helper identities cannot be resurrected. Unreferenced historical
content remains quarantined; importing it is a separate owning operation.

Bind preparation to current cohort revision/hash, candidate hash, exact target
hashes and a compatible package. Revalidate them immediately before activation;
new facts invalidate the prepared result. Record an original durable intent
before any replacement, including exact prior/target hashes and per-component
progress. Close/checkpoint owning handles without releasing process exclusion.
Never replace a directory containing a retained lock or delete sidecars by
suffix to make validation pass. Each data-component replacement is atomic and
durable. Restart reconciles only the same original prior/target identities;
anything else retains the fence and explicit unknown/blocked result.

After every target matches, run current owning reconciliation while admission
is still fenced. Original unknown effects remain blocked/deduplicated under
their original IDs; no usage is refunded and no mutation/speech/notification/
schedule is replayed solely because the archive predates a receipt. Record the
validated activation receipt before releasing the durable admission fence.
Only then may a compatible selected service boot/admit current work.

## Upgrade, clients, ordinary export and uninstall

Package selection checks actual adopted CHAT/FILE/TEAM/MEM/VM/helper and native
readers. Compatible fallback changes executable selection while retaining
current authority. If the previous package cannot read an adopted format,
retain the fence and select a verified compatible forward package; never
lower a reader or restore an older manifest as a reverse migration.
Actual installer interruption boundaries and negative older-build boot tests
are required. Rebuilding/reinstalling native packages retains current device
secure storage and service binding or requires the existing owner reconnect;
it cannot copy credentials or turn a stale notice into approval.

The implemented [ordinary export](s16-owner-export-v1.md) is a distinct bounded owning projection, not this manifest or
raw ledgers. Export only configuration/user content/deliverables currently
allowed to that owner, rechecking withdrawal/private scope at release. Exclude
auth, credentials, protected native/profile state and authority-bearing rows.
Core operations require no hosted vendor, telemetry or billing service, and
verified service/native packages ship their mixed provenance/licenses/notices.
Uninstall stops and proves owned process/VM lifecycle outcomes before removing
units; data, receipts, leases, releases, credentials and working disks remain.

## Required conformance

Drive actual operator/client install, upload/work, backup, ordinary export,
post-point withdrawal/private retirement/charges, quarantine restore,
compatible upgrade fallback and uninstall on disposable state. Assert actual
bytes, current ledgers and no repeated physical/provider effects. Inject each
missing/corrupt ledger/byte/receipt, current-cohort change and every durable
interruption boundary. Use scripted models, protocol fixtures and fake clocks;
label real native/account/device/host evidence separately. No component-only
success closes OPS16-01 or accepts owner-host cutover.
