# Selected S16 operations

Status: OPS16-01 implementation in progress in
[#429](https://github.com/chayapats/jit/issues/429). The available operator
commands adopt/inspect protected operations metadata, capture a current protected
control-plane point, abort an interrupted backup and explicitly retire receipted
historical points or independently owned temporary staging. The authenticated
client additionally exports ordinary current content/settings. Protected forward
repair restores only exact missing current immutable bytes. Complete selected
service/client upgrade/fallback/uninstall acceptance remains in progress.
Existing S14/legacy commands and S15 installation paths keep their contracts.

Run from the verified selected source package, with its pinned Bun and explicit
credential-free S15 configuration:

```sh
bun run s16:ops status --s15 --config /absolute/s15-runtime.json
bun run s16:ops adopt --s15 --config /absolute/s15-runtime.json --request-id original_adoption_id
bun run s16:ops backup --s15 --config /absolute/s15-runtime.json --request-id original_backup_id
```

`status` is read-only and may share an installation lease with the running
selected service. It reports `not_adopted`, `adoption_pending`, `maintenance_pending` or `adopted`,
current revision/retained point count and bounded active-operation metadata.
It does not report application/VM health, native settlement or backup coverage.
Its observation-only lease cannot pass writable-owner admission. Nonterminal
current operations refuse normal selected execution even if their physical
maintenance fence is lost. Never remove a gate or edit current metadata to
force admission; owning reconciliation must retain the original request.

`adopt` requires the selected service/local commands to release their shared
installation leases. It then validates all existing selected/retained runtime
and outer current-control state, holds installation/CHAT exclusion, retains an
original durable owner admission fence, creates the current metadata journal,
publishes its independently bound v2 receipt and clears only the verified
original initialization fence. It does not initialize missing application
state, change installed policy, replace credentials or operate a computer.

Retry an interrupted adoption with the same configuration and request ID.
The original operations identity/time is retained, including response loss
after successful clearance. A conflicting request/configuration refuses.
Missing/corrupt adopted control refuses before normal owner/vault access;
re-running adoption does not reconstruct it empty. Keep the current journal,
receipt, retained lease and original fence together for protected recovery.
They are excluded from historical points and ordinary exports.

Contracts: [aggregate forward recovery](../contracts/s16-recovery-point-v1.md),
[initial operations control](../contracts/s16-operations-control-v1.md),
[v2 journal writes](../contracts/s16-operations-control-v2.md),
[v3 staging/disposition](../contracts/s16-operations-control-v3.md),
[v2 installation binding](../contracts/s16-installation-lease-v2.md) and
[current-control maintenance](../contracts/s16-control-maintenance-v1.md).
These metadata operations do not complete aggregate acceptance or owner-host
cutover; compatible release/client lifecycle acceptance remains separate.

## Guarded release coordinator

The [guarded selection protocol](../contracts/s16-guarded-release-selection-v1.md)
and [ADR 0127](../adr/0127-s16-guarded-release-selection-protocol.md) implement the
protected service/root component. The installer/supervisor adapter and actual
installed lifecycle remain in progress; there is no new standalone public
upgrade command in this component. The [scoped service/client proof](../evidence/s16-service-release-proof.md)
exercises actual copied earlier/current service processes and the same sealed
shared client with persistent scripted external ports, including fresh work
after a policy-preserving fallback.

The trusted root coordinator keeps a retained sealed operator, original private
job plans and root process exclusion. It stops the controller conclusively,
completes a protected **current** backup, records original upgrade/selector intent,
and executes both actual packages' current readers and completed-backup response
paths before selecting code. Source/target/operator use compatible pinned Bun,
engine, lock and dependencies. Current SQL/payload/helper/external/native proof
remains separate from root path-value readback. Missing original evidence refuses;
never delete a gate or recreate staging to get an upgrade through.

A failed trial requires another conclusive stop and a new reverse selection
over a fresh current backup. Trial policies, withdrawals, charges, private scope
and unknown receipts stay current. The coordinator never restores an old
composition or authority snapshot. If fallback readership is unsupported, only
an original **unarmed** plan may be discarded after fresh actual current-source
proof. The failed job then requires a distinct verified forward operation. Any
selector intent/uncertain physical boundary remains fenced for original owning
reconciliation. Keep all retained packages, private root plans and current state.

Completed root jobs return historical receipts without stopping a later service
or changing its selector/state. That result does not assert current health.
Root plans are private metadata, not ordinary exports or execution grants.
Disposable UID/supervisor ports in conformance do not certify Linux adoption.

## Ordinary owner export

The available **Export your data** entry in the S16 rail opens a current-scope
dialog. Choose sections, optionally a conversation/creation dates, then download
`jit-export.json`. English/Thai copy, keyboard focus and narrow-screen navigation
use the same shared client. The server rechecks current ownership, publication,
memory/resource/private scope and withdrawals before releasing the download.
No operator filesystem credential or archive can produce this ordinary download.

The [export contract](../contracts/s16-owner-export-v1.md) defines full current
conversation/memory/work text, committed deliverables, sent text/sanitized image
copies and inert Bot/routine/connection/skill settings. Unsent/untrusted uploads,
raw binary originals, private skill bodies, credentials, grants and protected
recovery state are outside this ordinary format. Connections require reconnect;
settings do not install policies or enable execution.

Select fewer sections or a narrower scope after capacity refusal (4,096 records,
16 MiB complete JSON, 8 MiB encoded member). Changed sources require a fresh
explicit download. Empty scopes show no available content; expired authentication
clears the private UI. There is no automatic retry or private export cache.
An already downloaded copy belongs to the owner; later withdrawal cannot recall it.

The copied-package drill below requires a clean selected source checkout and a
local Chrome executable (override with `JIT_BROWSER_EXECUTABLE`). It seals the
package and dependencies, runs owning service/client conformance plus the actual
English/Thai browser download at widths 1440/390, then verifies unchanged package
bytes and writes a private fresh receipt. Fixtures and screenshots remain outside
the immutable artifact; no live account/provider or native device is exercised.

```sh
bun ops/evidence/s16-owner-export.ts --receipt /absolute/private/fresh-export-receipt.json
```

## Protected current control-plane backup

`backup` requires the actual verified copied artifact, locked sealed dependencies
and release notices. An unsealed checkout refuses before staging. Release selected
service/local shared leases first. Code derives the executing package root; no
input chooses a destination, reader or expected hash.

The [producer](../contracts/s16-point-capture-v1.md) retains current SQL/native/
FILE/GitHub/helper/external custody under original operation/action identities.
Complete FILE/GitHub catalogs retain withdrawals, untrusted/pending bytes and
older references without granting execution/publication rights. Journal intent
precedes atomic publication, independent readback and the final current receipt.
Retry the same request/config/package after interruption. Prepared/published
points refuse missing or changed bytes instead of repairing them. A retired
point is never recreated.

Only conclusive no-publication readback permits a distinct local `--attempt` under
the same request. Unknown publication/source release retains its gate. Staging
quotas refuse without evicting unknown partials or receipts. Credentials, profiles,
mutable disks, root-helper state and device secure storage stay separate; physical
settlement remains unobserved. This command does not implement disk/device restore,
forward activation or full lifecycle acceptance. No ordinary download or model tool
exposes the protected point.

## Explicit historical-point retention

After the selected service and local commands release their shared leases,
remove one independently receipted historical point with:

```sh
bun run s16:ops cleanup --s15 --config /absolute/s15-runtime.json --request-id original_cleanup_id --point-id receipted_point_id
```

The [point file contract](../contracts/s16-point-files-v1.md) authenticates the
complete fixed inventory, journals the original remove intent and persists its
hash-bound plan outside the point before unlinking. After interruption, repeat
the same request/point/configuration. Already absent members can be original
completed unlinks; substituted, extra or changed members refuse and retain the
gate. Do not edit a plan, delete a gate or switch request IDs to force progress.
An optional `--attempt` applies only after independent original not-applied
readback; it cannot bypass unknown custody. This CLI never infers that outcome.

Removal retains current application data/credentials, native stores, disks,
process leases and original backup/cleanup/plan receipts. A repeated completed
request returns its original result; a reappeared directory is refused and
untouched. There is no automatic age/count eviction. Tests cover both disposable point-format fixtures and the actual copied-package
producer. Format-fixture metadata alone is not an operator recovery point.

## Interrupted backup disposition and staging retirement

New aggregate captures promote the current journal to v3 and journal the private
root/data inode identities before child writes. Original identities, actions and
finite history limits remain. Earlier v1/v2 readers refuse v3 before writable
owner/vault admission. The separate installation lease format is unchanged.

If the original backup cannot continue because its partial metadata or bytes are
corrupt, explicitly dispose of that backup under the same current configuration:

```sh
bun run s16:ops abort-backup --s15 --config /absolute/s15-runtime.json --request-id original_backup_id
bun run s16:ops retire-staging --s15 --config /absolute/s15-runtime.json --request-id original_staging_retirement_id --source-request-id original_backup_id
```

Abort requires all original native/point/helper resources to be conclusively
released. It preserves confirmed and unknown capture/publication facts. It does
not call them failed, settle VM/provider work or retry execution. A separately
bound receipt records logical disposition and absence of the canonical point.
An unregistered published point can move back only to its original private stage,
using its original journaled data inode and an explicit quarantine intent.
A retained point, substituted inode or occupied destination refuses. An unknown
quarantine remains fenced; retry the same request to read back that movement.

Retirement is a separate original operation. Its immutable removal plan lives
outside the deleted namespace, pins every current known-role file hash/inode and
directory identity, and precedes every unlink/rmdir. Partial/corrupt capture
metadata is inert local backup custody, not deletion authority. Missing members
may be original completed unlinks; changed/extra members, links and special nodes
refuse. Retry the same retirement/source/configuration after interruption. The
original backup/ownership/abort/removal receipts survive, as do retained points,
current SQL/native roots, credentials, disks and process leases. A completed retry
refuses reappeared directories untouched. No automatic eviction is introduced.

Successful backups may also explicitly retire their temporary staging without
removing their retained point. Legacy unowned corrupt staging refuses retirement;
a path or self-hashed failed metadata cannot supply provenance. Logical abort of
an absent point can retain such legacy bytes without inventing ownership.

## Forward repair of missing current immutable bytes

Stop the selected service and let its original resources/shared installation
leases close conclusively. Keep the current installation, operations journal,
independent receipts, configuration, credentials and native/working state in
place. Run the verified compatible package against an already retained point:

```sh
bun run s16:ops restore --s15 --config /absolute/s15-runtime.json --request-id original_restore_id --point-id retained_point_id
```

The operator supplies opaque request/point IDs, never archive, live or scratch
paths. It authenticates the complete retained point and completed backup, deeply
verifies public native ancestry in private quarantine, and independently receipts
complete current SQL/native/FILE/GitHub/helper/external/package custody before
preparation. Current SQL chooses the missing immutable members; historical SQL
never chooses current authority. Required missing/corrupt current ledgers, native
or parser state refuse without initializing or copying them from the point.

Only an absent current FILE/GitHub pin with exact candidate bytes can be repaired.
One missing pin without exact candidate bytes refuses the whole operation before
publication. Present corrupt/unsafe bytes refuse untouched. Intact newer bytes
remain, and withdrawn/unreferenced historical members stay quarantined. A missing
registered byte parent requires independently journalled original empty ownership.
The immutable original plan pins every target's prior absence, expected hash/size,
verified source and private same-parent temp inode before the first byte write.

Retry an interrupted command with the same config/request/point. Owned partial
temps resume only after their whole existing prefix matches the original source.
Atomic hard-link publication refuses an occupied target; only the original temp
name is unlinked after parent fsync. Both-name and target-only readback retain the
same inode/hash and exact link counts. Missing/substituted owned paths, unknown
aliases, changed current facts or unsupported publication refuse without replacement.
Complete current writer cuts protect publication and final observation; asynchronous
native/helper validation runs only after conclusive cut release. Unknown native/SQL
close retains the exact original resource capability and installation/CHAT exclusion.

A complete response contains only original operation/request/point IDs, cohort/
plan hashes and receipt revision. It clears admission only after current readback
and original resource disposal. Repeating a completed request returns that stored
receipt before reading old staging: even a later withdrawal cannot be resurrected.
After compatible repackaging, the same complete backup/restore request can use
its original stored command binding to read that receipt. The executing package,
owner, exact configuration and current stores must still validate. Backup also
rechecks the original retained point's full inventory. Unfinished work remains
bound to its original package; a different point, kind or configuration refuses.
Another operation's admission fence is never cleared by terminal readback. See
[ADR 0123](../adr/0123-completed-operations-survive-compatible-repackaging.md).
Current CHAT/artifact/lineage/expiry/recipient/private guards still decide release.
No work, unknown effect, charge, speech, notification or native session is replayed
or refunded by copying bytes. Credentials, client sessions and working disks are
retained, never imported from history.

This is not bare recovery after losing current authority or a disk/device rollback.
Combined recovery staging is bounded and is retained after completion; it is not
automatically evicted. Explicitly retire only a completed restore's original
private staging with a separate original retirement request:

```sh
bun run s16:ops retire-staging --s15 --config /absolute/s15-runtime.json --request-id original_recovery_retirement_id --source-request-id original_restore_id
```

Its v2 command/plan authenticates original independently receipted root/role
inodes and the complete source receipt. The immutable removal plan lives outside
deletion; every file hash/inode and directory identity must match before explicit
unlink/rmdir plus parent fsync. Retry uses the same retirement/source/configuration
after interruption, and refuses changed/extra/linked/substituted custody or a
reappeared root. Partial/discarded/unknown or unowned restores cannot be retired.
Only staging is removed: current SQL/native/helper/client/credentials/disks,
canonical repaired bytes, retained points and all original operation/removal
receipts survive. Complete restore retry still returns its old receipt without
recreating staging or later-withdrawn bytes. Existing retirement quotas refuse
oversized custody without automatic eviction or deleting unknown files.
Compatible aggregate service/client release lifecycle remains pending. See
[`s16-recovery-staging-retirement/v1`](../contracts/s16-recovery-staging-retirement-v1.md) and
[`s16-forward-payload-repair/v1`](../contracts/s16-forward-payload-repair-v1.md).

## Copied-package adoption drill

The [deterministic package drill](../../ops/evidence/s16-operations-adoption.ts)
builds/seals the actual copied-source package, installs its locked production
dependencies without install scripts, checks package/dependency pins and runs
the shipped `s16:ops` command against disposable state. It checks an exact
v1-aware source build before/after adoption, unchanged current owner/vault
bytes on refusal, continued new-CLI operation and retained shipped notices.
The old Git object must be available locally; the drill does not fetch it.
Dependency installation needs registry access or the installer's cache.

```sh
bun ops/evidence/s16-operations-adoption.ts --old-commit d0c4c39f581994d5c10253110b6f5083c7777991 --receipt /absolute/private/fresh-receipt.json
bun ops/evidence/s16-operations-adoption.ts --old-commit 1229c3c77c65fac900fb974dbfef4660541d00d9 --receipt /absolute/private/fresh-journal-receipt.json --profile journal
bun ops/evidence/s16-operations-adoption.ts --old-commit 1229c3c77c65fac900fb974dbfef4660541d00d9 --receipt /absolute/private/fresh-native-receipt.json --profile native
```

The journal profile uses a v2-lease-aware, v1-control-only source as its
positive control. It works after adoption, then refuses after the first v2
journal write even with a simulated lost fence. The current package refuses
pending execution, reads bounded status, restores only the original gate and
settles the same disposable request without replay. Owner/lifecycle/vault bytes
stay unchanged across refused commands and journal operations. This is a
protected library drill; no incomplete backup/export command is exposed.

The native profile also exercises the packaged
[`s16-native-root/v1`](../contracts/s16-native-root-v1.md) component through the
pinned public host. Disposable active/retired/deleted sessions, an actual busy
owner, opaque data larger than command JSON limits and independent hash refusal
are checked. The actual owning capability also checks explicitly empty native
namespace without initialization. Fresh public native quarantine validates
actual ancestry/retirement and preserves original native bytes. The only model
is scripted locally; no provider/account call runs. It certifies components on
the reported platform, not populated aggregate recovery, native clients or
owner-host acceptance. Populated namespace tests use actual composed CHAT/MODEL
work; GitHub VM fixtures retain discovery requirements and original uncertainty.
The same profile now exercises actual copied-package SQL/FILE/native point-format
files, SIGKILL after an unlink, original-plan recovery, the shipped cleanup CLI
and refusal of a reappeared directory. Its package/external references are
explicit format fixtures, so this proves retention without aggregate acceptance.
Its controller probe also retires every original data handle while retaining
actual installation/CHAT/controller exclusion, verifies both SQL process locks
from an independent process, then reopens unchanged current SQL/original pending
intent. This [source-retirement seam](../adr/0115-s16-source-retirement-with-retained-exclusion.md)
is not current-cohort activation or a restore command.

Protected forward preparation now combines
[current byte custody](../contracts/s16-current-byte-custody-v1.md),
[actual current native custody](../contracts/s16-current-native-custody-v1.md) and
[complete current SQL/helper/external preparation](../contracts/s16-forward-current-cohort-v1.md).
The original restore owns these host-only capabilities and immutable stage plans;
the current journal independently pins their hashes and physical identities.
Actual SQL writer reservations remain held through the final current receipt,
after asynchronous public-native/helper verification has completed. Missing or
changed prepared state refuses; an unknown close retains the exact original
resources and installation/CHAT leases. Current SQL/native state stays in place.
These preparation components do not activate bytes on their own. The protected
coordinator below adds no-replace publication and original admission clearance;
complete service/client release lifecycle acceptance remains separate.

This checks metadata adoption/admission on the reported platform/architecture.
The old revision is a v1-aware admission profile, not a certificate that all
earlier packages support fallback. Actual aggregate recovery, native/account/
device acceptance and compatible package selection remain separate evidence.


The [v3 staging drill](../../ops/evidence/s16-staging-lifecycle.ts) uses the actual
copied package and an exact v2-aware preceding source build. The old command first
works against v2, then refuses v3 with no physical gate and unchanged owner/vault
bytes. Actual SIGKILL during capture and after a staging unlink exercises original
abort/retirement receipts and immutable plan recovery on disposable data:

```sh
bun ops/evidence/s16-staging-lifecycle.ts --old-commit fe48fe6caf2d6f7b9e48f58cb5d18cceb69d1a27 --receipt /absolute/private/fresh-staging-receipt.json
```

This proves the reported platform's source/package lifecycle component, not
forward restoration, populated native clients, physical settlement or cutover.
