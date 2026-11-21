# s16-installation-lease/v2

Status: protected current operations binding, extending
[`s16-installation-lease/v1`](s16-installation-lease-v1.md).
The SQLite lease application/reader remain `0x4a4f3136`/1 on the original inode;
v2 versions the separate admission receipt envelope, not an authority migration.

V1 remains supported before operations adoption. V2 has exactly `contract`,
`dev`, `ino` and `operations`, encoded canonically in the private retained
`s16-operations.lease.json`. `contract` is `s16-installation-lease/v2`;
device/inode decimal strings match the original lock. `operations` has exactly
`id`, `installationId` and `ownerIdentity`, as defined by
[`s16-operations-control/v1`](s16-operations-control-v1.md).

After acquiring its actual SQLite process lease, the opener must read and
validate the existing fixed private `operations/control.json` and all three
identities. Missing, corrupt, future, linked, noncanonical or substituted control
refuses before selected CLI writable owner/vault access. No v1 fallback or missing-journal
initialization is allowed. Selected CLI additionally checks the configured
installation and actual current owner/lifecycle identities through read-only
SQLite connections before any owning constructor can mutate headers/schema or
open vault/application state. It never uses an ordinary descriptor on those
SQLite inodes. Protected control maintenance independently checks the full
outer pair. An identity mismatch must leave actual owner bytes unchanged.

Shared references retain the observed current control inode/attributes; changes
invalidate admission. Exclusive maintenance revalidates current control while
allowing its own serialized atomic journal updates. Neither form accepts an
archive-selected control path or expected identity.

Only a genuine live exclusive capability may publish the v2 binding. It checks
the current original adoption fence and initialized journal's exact identities,
request/configuration/time, atomically writes and durably verifies the new
receipt, then refreshes its own expected receipt metadata. The SQLite process
transaction remains held continuously, and its lock inode is never replaced.
Structural lookalike objects cannot mint this protected capability.

Normal admission in a v1-only build compares the exact v1 envelope and rejects
v2 before opening owner state. This is a deliberate forward recovery fence;
removing fields to start an old build is not compatible fallback. Existing
outer durable fences also exclude earlier supported owner entry points during
initial adoption. Actual compatible package/reader fallback remains part of
the aggregate operations contract, not a claim made by this receipt alone.

An interrupted original adoption may resume its fixed journal initialization
only while the v1 binding and exact bootstrap fence remain. Once v2 is durable,
an absent journal is missing current continuity, never an empty initializer.
Response loss after fence clearance returns the existing original adoption.
Faults retain the original fence/identity; they cannot create another request
or refund/replay application effects. The receipt/control/leases remain outside
historical points, activation targets and uninstall deletion.
