# s16-operations-control/v3

Status: protected staging ownership/disposition under
[ADR 0113](../adr/0113-s16-owned-staging-and-backup-disposition.md).
V1/v2 remain readable. Existing writes stay v2 until ownership, retirement or abort
requires v3; v3 is never downgraded. Promotion adds `abort: null` to old requests
without changing their command, identity, timestamps or original actions. Earlier
readers refuse this format before normal writable admission.

V3 adds `own_staging`, `quarantine_point` and `remove_staging` actions and a `retire`
operation with pending/prepared/activating/complete phases. Original requests and
all finite v2 limits remain. Ownership intent hashes the original operation/
capture/configuration and actual private root/data directory identities before
children are written. `priorSha256` binds the root identity and `targetSha256`
binds the data identity, each with the original scope. Separate hashes permit
retirement of the remaining original root after published data was removed. No stage path is supplied by an archive or ordinary actor.

Only a backup may receive a terminal abort receipt. The owning current context
requires released native/point/helper resources, original owner/config binding,
no retained point and actual canonical point absence. Original unknown local
capture/publication facts are retained, not relabelled not applied. An abort
receipt binds original scope/prior phase/action digest and observation time.
It cannot settle application VM/provider effects or discard restore/upgrade.

A retained or unowned point cannot be moved by abort. Owned unregistered data
may be quarantined back into the original stage under its original explicit
quarantine action and fixed directory identities. Confirm that movement and
canonical absence before aborting; unknown movement keeps the original gate.

Retirement is a separate current operation, never a mutation of a terminal backup
receipt. It targets only that backup's independently owned temporary namespaces.
An external hash-bound plan records current bounded known-role files/directories,
hashes and identities before deletion. Retry recognizes original missing members
but refuses substitutions, new members, links or special nodes. Only explicit
unlink/rmdir with parent fsync is allowed. Current application/native roots,
credentials, disks, historical points and original ownership/abort/removal receipts
are outside deletion targets. Unknown or legacy unowned corrupt stages refuse.


`abort` is null on every non-aborted request. A backup abort has the closed fields
`contract`, `priorPhase`, `scopeSha256`, `actionsSha256`, `observedAt`, `point` and
`captureResources`; its contract is `s16-backup-abort/v1`, point is `absent` and
capture resources are `released`. Scope binds the original operations/installation/
owner/request/command/configuration/admission/time/point and pending/capturing/
verifying phase. The exact unchanged action array supplies its independent digest.
Only local capture/ownership uncertainty and the original exact publication intent
may remain terminal. Quarantine must be confirmed. Other operation/effect kinds
cannot use this exception. The owning hook independently rechecks actual lease,
configuration, released capabilities, retained-point absence and canonical-path
absence both before disposition and before clearing its original gate.

Ownership intent uses `stage_own_<role>_<SHA256(captureActionId)>`. Both directory
hashes bind the original scope, fixed role/capture ID, dev/inode/uid/mode and the
root/data part; mutable directory membership is excluded. No child write precedes
confirmation. A lost response to that metadata intent can confirm only the same
empty pair, including during explicit abort, without changing capture outcomes.
Capture refuses a missing owned data directory rather than recreating it. Legacy
unowned nonempty staging never gains guessed ownership.

Retirement binds a terminal original backup (complete, or discarded with this
abort receipt) and its complete current request digest (normalizing an absent v2 `abort` to
null for the original v3 promotion). It advances through
pending/prepared/activating/complete and records `remove_staging` only in
activating, with ID `staging_remove_<planSHA>`, prior equal to that plan SHA and
null target/confirmed observation. The request target is the immutable plan SHA.
Plans live under the fixed `operations/staging-retention` namespace. They contain
only fixed stage roles, original ownership hashes and relative known-role member
names, plus original file hashes/attributes and directory identities. No supplied
path can select current data or a historical point.

A plan is bounded at 16 MiB, selected temporary bytes at 20 GiB/100,000 nodes and
32 directory levels, with 1 GiB per file. Persistent retirement metadata has its
own 8 GiB/100,000-node bound. Point staging permits only its original metadata and
fixed ledger/payload layout. Native staging permits original plan/receipt/scratch,
opaque public root copies and isolated same-owner SDK quarantine beneath fixed
root IDs; it never parses private SDK internals. Links, special nodes, unknown
roles, substitutions and new members refuse. A hash-bound durable plan is read
back before any unlink; original attributes/ancestor directories and bytes are
rechecked before each deletion, with parent fsync. Missing original members can
be prior completed unlinks. Original receipts/plan and current sources survive.


An original capture intent interrupted before staging ownership can have no tree.
Retirement rechecks that fixed unowned namespace's absence throughout the operation
and never makes it a deletion target. A present or later reappeared unowned tree
refuses; original capture uncertainty and its lack of ownership remain unchanged.
