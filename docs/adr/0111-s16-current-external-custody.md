---
status: selected source contract; aggregate acceptance incomplete
date: 2026-11-21
scope: OPS16-01; S16-AC21; FR-04/15/18/23/35/38; NFR-02/04/05/08/09/12
---

# Retain external custody without historical credential or disk activation

ADR 0104 selects forward recovery from independently retained current authority.
A control-plane point therefore needs actual current backend/client references,
not a recursive disk/profile copy or an empty placeholder. Ordinary VM, browser
and notification constructors are unsuitable observers: some initialize state,
reconcile operations, change preferences or generate credentials.

Select a protected, bounded read-only external-custody observation under current
installation/CHAT exclusion. Hash all original VM manager/registration/snapshot
references. For known local QEMU managers, read bounded owning state JSON directly
and bind controller/physical directory and disk identities. Missing required
provisioned state/disks, unknown managers/names, unsafe paths and changed cuts
refuse. Never interpret missing/corrupt state through QEMU's ordinary stopped
fallback. Pending incomplete provisioning remains explicitly unobserved.

Live working-disk content is mutable and is not copied or hashed. Its stable
inode/owner/mode identity is current metadata, not a portable snapshot, physical
settlement or disk-content receipt. External Lima/Proxmox/remote and root-helper
custody stays independently retained; their original source hashes/generations
cannot certify physical state. A separately requested backend action still
requires that backend's owning protocol and current authorization.

Retain vault, SSH-key, notification-key and browser-profile custody separately.
Observe only bounded filesystem metadata, never secret bytes or profile contents;
missing credential custody requires the existing owner reconnect path. Bind client
continuity to the actual current owner/provisioning generation, installation,
service-origin digest and supported bootstrap contract. A remote device's secure
storage/profile is not controller-owned and is never claimed backed up.

The immutable observation can re-read the exact original cut. It never silently
replaces its expected hash after a change. Paths stay in trusted host composition;
serialized references contain opaque identities and digests. This observation
does not activate state, grant admission or settle pending effects. Aggregate
publication, forward activation and complete client lifecycle evidence remain
required under #429.
