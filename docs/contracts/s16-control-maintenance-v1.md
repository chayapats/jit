# s16-control-maintenance/v1

Status: protected OPS16-01 current-control inspection component, not a complete
point, historical backup, restore command or worker-admission certificate.

`openS16ControlMaintenance(config)` receives the trusted parsed explicit S15
configuration. It acquires the existing installation exclusive lease before
opening any owner/runtime connection, then the existing runtime CHAT lease.
Both must remain held while current control is inspected or captured.

The capability includes the actual runtime maintenance set plus separately
classified `outer` current connections: owner state, its linked independent
lifecycle ledger, recipient continuity and selected/retained website continuity.
These are protected current continuity under `s16-recovery-point/v1`; especially
owner auth/lifecycle state must never be included in ordinary exports or
silently promoted from a historical archive. Raw connections/identities never
enter HTTP, tools, prompts, artifacts or execution-plane state.

The opener never uses application constructors, initializes missing ledgers,
repairs permissions, boots workers or invokes providers/parsers/VMs. Private
paths, bounded main headers and logical WAL formats are checked before use;
exact owner memory/lifecycle identity, configured recipient/site installation,
meta epoch, JSON syntax and actual SQLite/FK integrity are required. Current
owner identity is distinct from the configured S15 identity. Known retained
website state is included even when a later config disables that browser.
Unknown outer SQLite files, missing mandatory state and any existing
outer maintenance/capture fence refuse.

`assertCurrent` rechecks both retained leases, runtime/current configuration
binding, outer inventory and observed owner/ledger inodes/permissions/attributes.
Closing first releases only the raw outer handles, then runtime handles/CHAT
exclusion, then installation exclusion. Unknown close keeps the remaining
process exclusion held; no file is unlinked to force release. Failure during
open cannot release installation exclusion after an unknown runtime release.

Byte/native/profile/vault/helper/device/package custody and durable aggregate
fence/intent/activation are still separately required. This component does not
certify physical/native settlement, independent receipt provenance, historical
reconciliation or full installation completeness.
