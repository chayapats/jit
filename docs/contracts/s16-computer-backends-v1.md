# s16-computer-backend/v1 and s16-working-state/v1

COMPUTER16-01 (#427), [ADR 0102](../adr/0102-s16-computer-backends-and-portable-state.md).
Selected implementation contract; no current service capability is advertised
until the owning integration and its conformance are implemented.

## Descriptor and ownership

`s16-computer-backend/v1` identifies one registered provider (`qemu` or
`firecracker`), immutable implementation/API version, stable computer identity,
current generation and platform. It has an explicit capability set (shell,
filesystem, sudo, external network, browser/desktop, cold recovery and strong
stop), finite CPU/memory/disk/session/command/file ceilings and evidence basis
(`configured`, `protocol_fixture`, or `host_verified`). No display label grants
a capability. The owner sees unavailable capabilities before selection.

QEMU retains current enrollment/NIC/SSH binding. The selected Firecracker profile
is `firecracker-offline-vsock/v1`, API v1.18.0 at immutable upstream commit
`eaf83bb718a559d324613d566eaf776b31a62340`: Linux x86_64/aarch64 with KVM,
no NIC/MMDS/extra/shared devices and a protected host-initiated SSH/vsock lane.
No new cloud account, mandatory hosted vendor, default selection, policy rule
or production host is implied.

Each operation retains owner, policy, computer/generation, work/attempt,
workspace lease, original operation ID, charged claim, deadline and output
limits. Every actual dispatch and publication rechecks those owning fences.
Enrollment revocation, boot drift, restore and source withdrawal reject late
output. Existing private-computer assignment never becomes shared by export.

## Bounded vsock lane

The trusted host selects an absolute Unix socket and one configured guest SSH
port. No model/guest input chooses either. It checks protected socket custody
and the exact hypervisor binding before connection and revalidates after the
handshake. The only negotiation sent is `CONNECT <guest port>\n`.
Accept one bounded `OK <assigned host port>\n` line, then preserve every trailing
byte exactly for SSH. The acknowledged host port is not the requested guest
port; equality is not a valid check. The assigned port is a positive uint32.
Reject malformed, oversized, non-ASCII, multi-line or incomplete negotiation.

Default handshake deadline is five seconds, independently shortened by the
owning operation deadline/abort signal; the complete acknowledgement line is
at most 32 bytes. Abort, EOF, error or failed final guard closes the original
socket once and returns no usable channel. No negotiation retry, host network
fallback, unbounded buffering or listener for guest-initiated host connections
exists. Subsequent bytes are opaque SSH traffic, governed by its existing
pinned-host-key, authentication, transport capacity and operation bounds.

## Lifecycle and evidence

Management accepts only closed inspect/start/stop/checkpoint/restore/retire
operations on one protected computer. It never accepts arbitrary API paths,
argv, host files or a model-selected binary. Host prerequisites and immutable
binary/kernel/root-disk pins are explicit. A configured API, successful guest
probe or cooperative unit response cannot assert strong stop/isolation.

Keep transport closure, cooperative `guest_scope_empty`, strong `vm_stopped`
and unknown outcomes distinct. Scope cancellation cannot stop siblings or
silently escalate to a whole-machine stop. A hypervisor stop requires independent
termination/access-settlement evidence for the exact process identity. Old
generations and lost mutation claims remain fenced after restart.

## Reviewed portable state

`s16-working-state/v1` is a same-installation immutable manifest of selected
ordinary work files, independent of hypervisor/OS disk formats. It retains
owner/generation, source computer/work/task identity, source private/resource/
file/DATA15 ancestry, capture identity/time, format/platform compatibility and
every relative path/size/SHA-256. It contains no permission, recipient consent,
policy, command to execute, native/provider session or controller credential.

Selected bounds: at most **64 ordinary files**, **1 MiB per file**, **16 MiB
total**, **16 path components**, **240 UTF-8 bytes per relative path**, no empty,
dot, traversal, absolute, encoded alternate path, symlink, hard link, device,
socket or named pipe. Export/import never follows a link or copies an entire
home/browser/credential/cache/control-state directory. Existing credential
screening supplements these source/path/byte boundaries; it is not a universal
secret detector against guest root. Selected bytes remain private source data.

Export stages captured bytes privately and publishes only a complete immutable
manifest/package. Import uses a fresh source-compatible destination workspace
and one atomic subtree publication after all bounded parts/hashes are checked.
Existing source work affinity is not rewritten. Destination authority must
admit every original source and private scope before selection; destination
VM ancestry is durably stamped before its first guest write. Subsequent work,
artifact/memory publication and export continue through that ancestry.

Owner preparation/review and mutation are distinct. An exact command pins the
reviewed source manifest, destination identity/generation/authority and request
ID. Current source or destination drift refuses. Response loss/restart uses
the original command receipt; it cannot create a replacement import or replay
work. Interruption leaves no completed export/import, never clears ancestry,
and preserves unknown capacity until original cleanup/settlement is proven.

The independent current source/policy/withdrawal ledger is never in the archive.
Compatibility is explicit same-installation working files, not general host,
RAM/disk, browser login, legacy/S14 or provider-session relocation. First
adopted portable ancestry stamps a monotonic reader format before guest writes;
older code refuses even after manifest rollback. Exact migration/reader and
transport commands are added alongside their owning implementation and tests.

## Required conformance

Use real protected service/session/client composition, actual bounded bytes and
protocol fixtures/fake clocks/barriers. Prove the same filesystem/shell task on
both adapters, truthful capabilities, exact original read-back, current private
and source fences, revoked/stale late output, distinct stop evidence, complete
Unix handshake bounds/cancellation, atomic capture/import interruption and
ancestry retained on every unknown path. Test authored English/Thai loading,
unavailable/error/reconnect/review states and packaged artifacts. Host/KVM,
physical device/account and owner-cutover receipts remain separately labelled
#431/#432. A source file, HTTP success or model completion alone closes nothing.
