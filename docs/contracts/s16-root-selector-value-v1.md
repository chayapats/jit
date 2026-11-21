# s16-root-selector-value/v1

Status: protected root filesystem primitive under
[ADR 0125](../adr/0125-s16-root-selector-current-value-readback.md).
Controller coordination and aggregate service/client lifecycle remain incomplete.

The value contains `contract`, a canonical selected release directory or `null`,
and SHA-256 over the first two fields. The digest means the current selected
path, independently of target package health or historical attempt counts. It
does not prove compatibility, activate work or approve a deployment.

The production prefix is `/opt/jit-s15`. Root-owned protected parents, a normal
single-link root-owned `current` symlink and a direct child of `releases` are
required. An explicit fixture may use another prefix/ownership boundary. A
read-only observer can inspect this public root metadata without controller
state or a root mutation lease; it creates nothing.

The mutation capability returns before resource acquisition. `acquire` obtains
the existing genuine inode-bound exclusive SQLite process lease in the separate
private `.s16-selector` coordination role. This role is not the controller state
directory and has no operations/owner binding. Missing/corrupt retained evidence
refuses. It is never removed, replaced or guessed from a currently absent lock.
Unknown original disposal retains the capability for a later conclusive close.

`select` requires the original expected current-path digest, target directory and
independently expected package content hash. It verifies the full immutable
root-owned target/dependency seal and exact installed release ID. An already
selected verified target returns its existing value without refreshing its
inode. Stale paths, foreign/current regular entries, linked/writable parents or
changed target code refuse.

First selection exclusively creates its symlink. Replacement creates a private
random root temporary symlink, fsyncs its parent, rechecks the original current
value and exact staged inode/owner/link count/target, atomically renames it and
fsyncs/read-backs the desired value/package. Only the live attempt's unchanged
staged inode may be removed. Unknown substituted staging survives. A hard kill
may leave an inert root temporary symlink; retry ignores it and reads current
state. It neither adopts nor executes an unreceipted temporary object.

The trusted coordinator must bind original controller intent/cohort/package
pins and retain the controller gate across root steps. This primitive does not
open current SQL/native/VM disks, start a service, edit config, clear a gate,
settle unknown effects or automatically fall back. A filesystem result needs
the actual target's current-reader proof and an owning service/client journey.
Inert fixture witnesses and fake-root ownership do not certify controller
authority preservation, real Linux isolation or owner-host adoption.
