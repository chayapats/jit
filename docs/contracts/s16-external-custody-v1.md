# s16-external-custody/v1

Status: protected current-reference component under [ADR 0111](../adr/0111-s16-current-external-custody.md).
It is neither an ordinary export nor a credential, working-disk or remote-device backup.

Current owning composition supplies the genuine exclusive installation lease, CHAT
exclusion, exact current configuration, owner identity and existing SQL handles.
The observer never constructs a store/adapter, starts a browser, calls a provider
or reads secret bytes. Canonical SHA-256 binds the complete immutable observation;
revalidation re-reads that original cut and refuses changes.

The component includes the installation/configuration digest, current service and
owner/client binding, separately retained credential/profile directory identities,
notification-key presence and subscriptions, and all original VM manager,
registration and snapshot reference hashes. Current SQL copies retain the full
owning records; hashes do not turn historical rows into authority.

VM manager metadata is bounded to 64 rows/8 MiB, registrations to 256 rows/16 MiB,
and snapshot references to 4,096 rows. Each JSON row is at most 128 KiB and is
bounded in SQL before decoding. Known manager kinds are QEMU, Lima, Proxmox and
Firecracker; configuration can additionally retain the original remote manager.
Unknown kinds, foreign keys or unowned local machine names refuse.

QEMU uses the current config's fixed controller and optional separate-VMM roots.
State JSON is at most 4 KiB, with explicit owning fields and original hash/identity.
The historical ordinary missing-state fallback is never used. Registered local
managers without physical directories remain explicitly pending; an enrolled or
provisioned manager needs its current state and disk. Physical roots may have the
configured separate VMM UID and reviewed group-readable modes. No account change,
launcher, QMP, hypervisor inspection or guest command runs.

Live disk identities exclude mutable byte length/timestamps/content. A matching
identity is only current metadata custody and does not settle a physical action.
Cold snapshot IDs/generations are retained as original references without inventing
disk-content hashes. Separate backend/root-helper continuity is still required
before any activation that depends on it.

Vault, SSH credentials, VAPID key and profiles stay independently retained. Only
metadata is inspected; key/profile contents never enter the component. Missing
credential custody records an owner-reconnect requirement. A nonempty notification
subscription set without its original 32-byte key refuses instead of creating one.
The protected browser profile and provisioned engine roots are not traversed.

Client references bind the actual current installation, owner identity, nullable
provisioned-owner generation, service-origin digest and `s16-client-bootstrap/v1`.
Device secure storage remains outside controller custody and requires retaining
the same device binding/storage or its existing owner reconnect flow. A reference
does not certify a native UI, package upgrade or remote-device recovery.

Serialized metadata is at most 4 MiB, contains no absolute host paths, and is
deeply immutable. Full current file/SQL guards and exact reference re-reads remain
required at aggregate capture/publication and forward activation boundaries.
