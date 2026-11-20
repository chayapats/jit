# s16-installation-lease/v1

Status: selected protected OPS16-01 writer exclusion primitive. It does not
settle native/VM effects or implement the full aggregate restore protocol.

The explicit S15 CLI holds a shared SQLite read lease in the private retained
`s16-operations.lock.sqlite` at the installation root before opening owner
state, the vault, recipients, websites or runtime services. Local owner-link
and credential commands use the same shared lease, so they may coexist with a
running service. They release it only after their owned handles are closed.
Service lifetime retains it through shutdown. The separate existing CHAT
exclusive lease still excludes two composed services and offline runtime
access; neither lease substitutes for the other.

Protected installation maintenance opens the existing installation lease with
an exclusive transaction. Any running selected service/local command refuses
maintenance, and maintenance refuses new selected commands before owner/vault
state opens. Shared/exclusive contention is finite and never steals a lock.
Exclusive maintenance requires owner-write permission and a zero-row write
probe on the actual lease singleton. Accepting `BEGIN EXCLUSIVE` on a silently
read-only connection is not proof of exclusive writer exclusion.
SQLite releases OS locks on process death; that does not certify application,
parser, native-provider, notification or computer settlement.

Shared references within one process reuse the original SQLite connection and
transaction, releasing it only after the last reference closes. Conflicting
local openers refuse before opening any ordinary header descriptor. Closing an
ordinary descriptor on a POSIX lock inode can release that process's record
locks; local references therefore never repeat header reads or create another
connection. Operator/capture code must not read/copy the retained lease inode
as an ordinary file while held. Its private metadata/receipt checks use stat
and the separate receipt, not another descriptor on the lock.

First adoption by the selected CLI exclusively creates and durably initializes
the private lease with application ID `0x4a4f3136`, reader 1 and one singleton.
Initialization has no policy/credential/authority row. Only that fresh creator
may initialize; an existing empty, malformed, unsupported or linked file is
never repaired/replaced. An exclusively created private
`s16-operations.lease.json` binds the retained device/inode independently; a
missing lock or missing/changed receipt refuses later boots, including CLI
adoption. Interruption before both are durable refuses rather than resuming
initialization. Maintenance never creates either file. Supported images
must use rollback journaling; a WAL-mode or future reader refuses before a
writable open. The inode is retained across upgrades, backup, activation and
uninstall, with the receipt excluded from archive contents, and never unlinked to release a
lock. Current guards check retained inode/ownership/permissions and transaction
ownership. A failed close is explicit unknown release, not success.

The supported selected CLI and operations entry points must participate.
Earlier builds/standalone library users lacking this installation lease are
not thereby excluded. Before aggregate maintenance, the coordinator must also
hold CHAT exclusion and publish the existing outer S14-compatible durable
maintenance fence; the bridge-build/admission compatibility checks must prove
older entry points refuse before writes. Adopting an unsupported old build or
copying a lease file cannot grant maintenance/admission. Installer integration,
durable aggregate intent, independent current continuity, native custody and
the complete quarantine/activation protocol remain required before aggregate
success is exposed.
