# s16-firecracker-controller-custody/v1

Status: protected current-controller inspection under
[ADR 0106](../adr/0106-s16-auxiliary-journal-custody.md). This is not root-helper,
working-disk or native-host settlement, nor complete aggregate recovery.

`S16ControlMaintenance.firecracker` binds actual current VM manager rows to all
existing `runtime/vm-firecracker/<managerId>.sqlite` journals. These journals
are outside `composition.json` but contain original mutation intents/receipts.
The ordinary adapter constructor can convert accepted/dispatched states;
maintenance instead reads the owning format without application recovery,
credential access, helper RPC, guest commands or mutation replay.

Require exact main VM path/reader, current unique manager/computer/selection,
canonical private same-owner journal/directory/process-lease paths, installation
identity and controller application ID `0x4a46434a`, format 1. Validate the closed
binding and active pointer, every original command/receipt and settlement/active
consistency. An unknown or dispatched intent stays unchanged. A descriptor's
pending command identity/hash/revision is metadata, never physical proof.
The original `protected_host`/`protocol_fixture` basis remains explicit.

Reserve canonical journal paths inside the process before any journal/header/
lock descriptor is opened. Ordinary DurableJournal uses the same registry,
including the original inode (fresh journals bind it before SQLite opens), so
case/hardlink aliases cannot close a descriptor and weaken the original POSIX
locks. Retain each existing `.process-lock` SQLite exclusive transaction;
missing files refuse and are never created. SQLite may create its own transient
rollback journal while holding that lease. No process-lock inode, sidecar or
historical file is copied, replaced or unlinked to manufacture exclusion.

Bound manager rows to 64, JSON records to 128 KiB before loading, each journal
to 256 records/64 MiB JSON and its physical SQLite image to 1 GiB. Only the exact
owning `identity`, `records` and empty `commands` tables are supported. Each
source receives a stable opaque `fc_<managerIdSHA-prefix>.sqlite` alias for the
existing ledger-set capturer, which supplies the aggregate 2 GiB SQL bound.
All original records remain in that copied owning SQL image; the descriptor
does not substitute for them.

Missing registered state, future/foreign readers, conflicting/ambiguous binding,
invalid receipts, unowned retained journals or unexpected files refuse. An
absent namespace with no registered controller remains absent. Existing empty
directories and exact file/sidecar inventories remain guarded. WAL is read by
SQLite as committed current state; no sidecar is deleted by suffix. Full current
guards check original attributes, namespace and retained lease transactions.
After a dead writer, SQLite may undo uncommitted hot pages under the original
process lease. Keep the original inode/owner/mode, validate committed logical
identity/rows and then retain full image attributes. This is SQLite recovery,
not permission to run the adapter's accepted/dispatched-state conversion.

Close data handles conclusively before process leases, then release local path
reservations. Unknown close retains remaining handles and parent installation/
CHAT exclusion for original disposal retry. Failed open also retains its owned
disposal capability before resources are acquired. No unknown command is
reclassified from a successful file read or process-lease acquisition.

Root helper journals/physical state remain current in their separate protected
installation. Historical controller images cannot replace their commands,
launch IDs, generations or unknown effects. Full aggregate coordination must
retain current helper custody and use its authenticated owning recovery path
for any separately requested physical action. Parser/backend/client custody,
physical point retention and lifecycle acceptance remain required by #429.
