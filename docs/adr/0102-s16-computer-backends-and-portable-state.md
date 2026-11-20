---
status: selected for COMPUTER16-01 implementation; conformance and acceptance pending
date: 2026-11-20
scope: COMPUTER16-01 (#427); S16-AC19; FR-14/15/18/23/35/36/40; NFR-01/04/06/08/14
---

# Additional microVM backend and bounded working-state recovery

## Baseline and alternatives

Dispatch baseline is main `0b1e69b9a015413e15f2aa35dbb35e9bf59c5745`.
#410 and #411 are closed. The current public Schway `ExecutionBackend`, protected
VM policy/session service, SSH runner, enrollment, pool affinity and DATA15/
TEAM/file ancestry remain owners. Local QEMU, Lima/QEMU, Proxmox/QEMU and a
management relay already exist. Adding another name over those adapters would
not satisfy the additional-backend outcome.

The retained Rakazo reference is
`abf3c08145a05cba92a912d6c24fdfb5f569d0e0`. Its product-level computer choice
does not supply Jit's root-resistant control-plane, current policy or source
lineage contracts. Importing another runtime/hosted sandbox would duplicate
those owners. No Rakazo source or assets are imported by this slice.

Considered alternatives:

- Another QEMU manager: inexpensive integration, no genuinely new backend.
- A rootless container: useful for restricted processes but shares its host
  kernel and does not fulfill the retained dedicated-VM/root-admin boundary.
- Apple Virtualization: useful native Mac support, but adds a different native
  boot/management/distribution stack and platform-specific proof obligations.
- Firecracker: a genuinely separate Linux/KVM microVM implementation, usable
  without a hosted vendor. It needs an explicitly prepared Linux/KVM host and
  compatible guest image. This is the selected engineering choice.

Pin the initial public API/protocol reference to Firecracker **v1.18.0**,
commit `eaf83bb718a559d324613d566eaf776b31a62340` (annotated tag object
`07a7c2e20a8f4f661702551d02fc3eca679842a5`), checked against the official
release published 2026-11-09. See its
[getting-started requirements](https://github.com/firecracker-microvm/firecracker/blob/eaf83bb718a559d324613d566eaf776b31a62340/docs/getting-started.md),
[vsock protocol](https://github.com/firecracker-microvm/firecracker/blob/eaf83bb718a559d324613d566eaf776b31a62340/docs/vsock.md)
and [API schema](https://github.com/firecracker-microvm/firecracker/blob/eaf83bb718a559d324613d566eaf776b31a62340/src/firecracker/swagger/firecracker.yaml).
The [jailer contract](https://github.com/firecracker-microvm/firecracker/blob/eaf83bb718a559d324613d566eaf776b31a62340/docs/jailer.md)
requires the matching static musl Firecracker/jailer version. Jailer configuration
must be interpreted in the jail's path namespace. The pinned getting-started
contract states that `--config-file` also starts the microVM: that launch is a
mutation and cannot precede its durable intent/current guard or be followed by
an automatic duplicate `InstanceStart`.
The upstream binary/image is not copied into Jit or fetched at model-selected
URLs. Any selected host binary, kernel and disk require immutable hashes and
their applicable licenses; no MIT-only redistribution claim is made.

## Selected backend boundary

The initial Firecracker profile is deliberately **NIC-free**: offline Linux
shell, filesystem, sudo and the guest software actually present. A protected
controller initiates SSH over the particular microVM's Unix/vsock channel.
There is no listening guest-to-controller vsock service, host mount, host disk
device, shared filesystem, arbitrary API route or raw management handle in the
guest/model. Existing local QEMU remains independently useful with its current
network/browser/desktop contract. The additional backend's unavailable network,
GUI and acquisition capabilities must be visible before task placement; it
must not pretend to complete a task requiring them.

A backend descriptor records provider/version, platform, capabilities, resource
ceilings, enrollment identity/generation and evidence basis. A configured
descriptor is not an isolation/stop certification. The actual process/image,
closed device configuration, protected sockets and SSH channel must be bound
before enrollment is ready. A guest echo, hostname or boot ID is insufficient.
Unknown devices, MMDS, network interfaces, shared host resources, missing pins
or drift refuse. SSH retains generated VM-only keys, a pinned host key, finite
one-shot calls and the existing policy/claim/publication path.

Enrollment, pool placement and lifecycle use a discriminated protected physical
binding instead of requiring a dummy MAC for a NIC-free computer. Existing NIC
rows remain compatible. Adopting a new physical binding explicitly stamps VM
store format 2 into its checkpointed database header before saving that row;
ordinary reads never upgrade or downgrade the format. A blocked checkpoint
refuses adoption rather than relying on a WAL-only marker that old readers
would miss. Portable ancestry still needs its separate reader transition.

Cooperative guest unit cleanup remains `guest_scope_empty`, not hypervisor
settlement. Strong stop requires independent confirmation that the exact VMM
instance terminated and retained disk access settled; uncertainty keeps the
generation fenced and capacity held. Cold disk checkpoints contain guest
working state only, never controller authority, native sessions or credentials.
Portable state is separate from a hypervisor/RAM snapshot.

Use a retained host pidfd rather than a later numeric-PID kill to avoid PID reuse
redirecting a whole-machine stop. See Linux's [pidfd semantics](https://man7.org/linux/man-pages/man2/pidfd_open.2.html)
and [signal identity contract](https://man7.org/linux/man-pages/man2/pidfd_send_signal.2.html).
The native binding uses the selected system libc's public API, confirmed in
[glibc 2.39 declarations](https://github.com/bminor/glibc/blob/glibc-2.39/sysdeps/unix/sysv/linux/sys/pidfd.h).
No libc, Firecracker, jailer or kernel source/binary is imported or redistributed
by this primitive. Its `process_exited` result is not complete VM settlement;
approved executable/jail/device/socket binding and disk settlement must still be
combined by the owning manager. Protocol fixtures and Mac refusals cannot stand
in for the separate Linux/KVM receipt.

Cold recovery uses bounded raw-file copies while the original computer is
independently settled. A complete hash-bound snapshot and an exact prepared
replacement are published through same-filesystem atomic renames with fsync.
Private original context precedes each effect; read-back observes the original
manifest/inode without completing a partial rename or retrying deletion.
Retirement keeps an immutable tombstone and never recycles the original tag.
This deliberately trades temporary disk space and copy time for simple cold
recovery independent of hypervisor RAM/snapshot formats. The concrete helper
must compose these disk primitives with original process/UID settlement and
durable jobs before offering the backend; real-file Mac tests do not prove KVM.

Durable protected-helper jobs retain exact original requests, a monotonically
advanced computer fence and private recovery context before host effects.
Restart distinguishes undispatched refusal from unknown dispatch; neither
response loss nor a late timed-out driver permits replay. Root systemd retains
the fixed foreground launch across helper restarts. Unit metadata is weaker
than the independent process/jail/API/disk checks and never certifies readiness
or settlement. The selected unit gives the unmodified jailer a private empty
read-only `/proc/misc` view, preventing optional userfaultfd/Nitro imports
without changing global host devices. This avoids excluding otherwise suitable
Linux hosts merely because those optional kernel minors exist. It requires a
root-owned immutable empty file and systemd mount support; missing preparation
refuses. Native helper preparation/installation and Linux conformance remain
required; the Mac command fixtures do not establish them.

The protected-host composition now binds the original process/jail/executable,
immutable kernel/config, dedicated UID, per-thread seccomp/capabilities, bounded
no-swap cgroup and original disk descriptor before joining the closed API profile
and guarded SSH/vsock lane. Process exit remains distinct from independently
flushed disk settlement. Original cleanup authority survives work revocation;
unknown stops reconcile the original lease rather than signaling again. Native
observation is restricted to the installed privileged helper and injected ports
stay protocol fixtures. These primitives alone are not a registered manager;
the concrete runtime/client/helper composition below owns durable launch and
cold/restart recovery. Real installation/custody acceptance remains separate.
The host record's seed hash is not a hash
claim about the mutable guest disk, and no observation supplies source ancestry.

## Protected manager composition

The additional manager composes the existing bounded host primitives in one
separately installed root helper, not in Jit's nonroot controller or Schway's
execution loop. The helper retains original unit/invocation/process and current
disk custody in its private journal before publishing a usable endpoint.
Adopting these instance records explicitly checkpoints helper reader format 2
before a VM mutation; format-1 helpers refuse the actual database header.
Native startup holds the singleton before recovery. Original cleanup authority
closes transports and stops only the recorded process; cold restart removes
only its two verified stale sockets after independent settlement.

Use a versioned, one-computer loopback RPC (`s16-firecracker-management/v1`)
with the existing protected-relay credential approach. A root daemon keeps the
fixed SSH/vsock forwarder alive across controller connections. Compared with
per-command sudo, this avoids losing the SSH endpoint when a command exits.
It accepts current-state reads, exact closed original commands, receipt reads
and original read-back, never a host path, binary, argv, credential read or
arbitrary VM selector. Requests are capped at 4 KiB, responses at 16 KiB and
concurrency at four; mutations retain their durable per-computer reservation.
Only loopback is supported initially; remote exposure/TLS/tunneling is not
inferred. The daemon credential stays in protected host/controller storage and
never in the working VM or VMM environment. Source implementation does not
install an account, sudoers rule, credential or production service. Such host
setup and native Linux/KVM evidence remain #431/#432.

The authenticated helper state also reports its selected controller UID/GID.
The native same-host client must match them to its actual nonroot OS identity
before accepting host facts. Declaring a different controller identity in a
configuration file cannot make a reused VMM/controller UID safe. Fixture clients
remain explicitly labelled and cannot supply native evidence.

## Portable working state

Existing work affinity never changes silently. Export captures an owner's exact
reviewed regular files from a particular work root under current authority.
Import targets a fresh destination workspace/attempt with its own current
authority and placement; the originating task/responsibility/source lineage is
retained. It does not move a running work, replay a command, restore a grant,
overwrite an existing workspace or copy native sessions/provider history.

Only ordinary selected work files are portable. No whole disk/home, browser
profile, keys, environment, sockets, devices, links, dependency cache, controller
state or installed credential directory enters the archive. Exact paths,
sizes, hashes and source ceilings are reviewed. Credential screening is defense
in depth, not proof that a malicious guest cannot copy a trusted-site secret
into an ordinary file; S16-D09's guest-root residual remains explicit. Protected
Jit/provider/vault credentials never enter that guest in the first place.

Capture into a private staged immutable package; publish only a complete
hash-bound manifest. Import into an exclusive staging subtree and commit the
complete tree at one rename. Independent protected source ancestry is stamped
before any destination guest write and never cleared by a failed/unknown
transfer. Missing bytes, changed inputs, interruptions and uncertain cleanup
cannot publish a completed package/import or regain execution authority.
Original command identities recover by read-back; unknown mutations never
become automatic replacement attempts.

New imported ancestry needs an explicit compatible reader and a monotonic
format fence before any guest receives bytes. An earlier binary must refuse
adopted state even if an old composition manifest is restored. No historical
S14/private/legacy conversion, policy widening or owner-host activation occurs.

## Delivery and evidence

The [backend/working-state contract](../contracts/s16-computer-backends-v1.md)
freezes the supported profiles, versioned shapes and finite transport/transfer
bounds. Implementation proceeds through actual protected enrollment, sessions,
owner client and supported public Schway tools. Both backends must perform the
same bounded filesystem/shell task with truthful capabilities. Tests must cover
the real Unix/vsock framing, wrong identity/generation, unknown stop, interrupted
capture/import, current source withdrawal and no-credential/control-state
export; English/Thai rendered states and distributed package checks follow.

This selection is not implementation acceptance. Native Linux/KVM host,
hypervisor-root isolation and real image/device receipts remain explicit
LIVE16-01 (#431) evidence, distinct from protocol fixtures. No test on this Mac
can certify Firecracker/KVM execution. The full #427 deliverable remains open
until owning-service/client conformance passes; #392 remains open. QEMU defaults,
S15 selection, installed policy and original authority/private scopes retain
their existing meaning. No Schway internal import or replacement loop is needed.
