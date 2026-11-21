# s16-runtime-maintenance/v1

Status: internal OPS16-01 operator/host capability for the composed runtime
subset. It is not an ordinary client/tool, complete installation backup,
restore command, owner approval or proof of physical computer settlement.

`openS16RuntimeMaintenance({ directory, installationId, browserResourceId? })`
uses explicit trusted protected installation/configuration input. No archive,
model or guest chooses these paths/identities. The current OS identity must own
the private directory/files. Source code calling this function still requires
its applicable operator/owner maintenance authorization; possession of a
candidate manifest is never authority.

The opener bounds and validates the existing `s15-composition/v1` manifest,
exact installation, mandatory seven core stores and known optional inventory.
It includes recognized retained optional ledgers even when an earlier manifest
omits them. Unknown SQLite files, missing declared state and untrusted
links/ownership/permissions refuse. It never creates an empty ledger, repairs
permissions, initializes another runtime or rewrites the composition manifest.

Before opening source connections, it acquires the existing
`conversation.sqlite.runtime-lock.sqlite` exclusive process lease used by
`ConversationStore`. A live service refuses maintenance; maintenance excludes
a fresh composed service until close. The inode is retained and never unlinked
or replaced. Source files are opened only with `create:false`; no owning
application constructor, boot recovery, model, provider, parser, speech or guest
operation runs. SQLite may perform ordinary transactional page recovery, which
does not create or replay application authority.

For each source, both main-header and logical WAL reader/application versions
must match the reviewed binary profile, without downgrade. Installation rows
must match exactly once where the owning format has them; POLICY installation
and charged-vector metadata are checked. Historical browser continuity instead
requires the exact configured resource, singleton and finite generation.
VM state remains bound to the protected composition root; its physical
identity/current-scope checks are not replaced by a nonexistent installation
column. Bounded JSON-metadata syntax checks supplement identity checks, while
the capture/verification contracts perform actual SQLite/FK integrity checks.
This is not a substitute for all owning semantic/current-authority validation.

The returned protected capability contains `sources`, `selected`, `retained`,
`assertCurrent()`, `retireSources()`, `assertExclusion()` and `close()`. Its handles never enter JSON, ordinary exports,
artifacts, prompts or the execution plane. Use `assertCurrent` as the outer
guard of `captureS16LedgerSet`: it rechecks the retained process lease,
composition bytes, source inventory/inodes/permissions and observed main-file
attributes. Changed paths/manifests/new ledgers or closed context fence capture.

`close` closes only connections created by this capability, then releases the
process lease. It is idempotent after success. If a connection cannot close
conclusively, the lease remains held and release is explicitly unknown; an
original close may be retried. Neither close nor process death certifies a VM,
parser, native effect or backend driver as settled.

[ADR 0115](../adr/0115-s16-source-retirement-with-retained-exclusion.md) adds
irreversible data retirement without releasing the original live CHAT process
transaction. `retireSources()` refuses an open source transaction, closes only
data handles and can retry original unknown disposal. Full current-content
methods then refuse. `assertExclusion()` checks the retained private runtime/
CHAT-lock identities, unchanged composition and actual live transaction after
retirement. Directory identity excludes incidental link counts that SQLite's
WAL/SHM creation can change on macOS; lock files remain exact single-link inodes.
This is exclusion only, never evidence of current SQL hashes, a prepared target,
physical settlement or activation. Final `close()` releases the original lease;
neither method unlinks or recreates a lock.

Outer owner/auth/vault/recipient/site state, disabled native components,
immutable file/skill payloads, client secure storage and separate backend/helper
custody must still join the full aggregate coordinator. Current restrictions,
usage and original unknown effects remain authoritative during any later
quarantine/activation. This component supplies no archive-to-authority mapper.
