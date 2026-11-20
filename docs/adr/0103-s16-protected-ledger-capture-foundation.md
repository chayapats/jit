---
status: selected OPS16-01 foundation; aggregate operations and acceptance incomplete
date: 2026-11-20
scope: OPS16-01; S16-AC21; FR-04/15/18/23/35/38; NFR-02/04/05/08/09/12
---

# Capture owning ledger state without making an archive authoritative

## Required outcome and existing implementation

[OPS16-01](https://github.com/chayapats/jit/issues/429) requires installation,
upgrade, backup, ordinary export, recovery and uninstall of the selected S16
service/clients, with current policy, withdrawals, private scope, usage and
unknown-effect continuity preserved. It remains open until the full aggregate
and actual owning-client acceptance work. Source presence or a valid component
manifest does not satisfy that outcome.

The [inventory](../operations/s16-recovery-inventory.md) at main
`95a958e99d5903c4804bba79b92e3cfa940e77d2` identifies seventeen possible
composed runtime ledgers, conditional reader formats, immutable byte stores,
outer owner/recipient/site state, native contexts and separate computer-helper
custody. S14/legacy managed backup and S14-to-S15 adoption retain their own
contracts; they do not already implement this aggregate.

## Alternatives and selected foundation

Reusing S14's complete application image as an S16 archive would import a
different authority/store root. A recursive directory copy would include live
WAL/lock/private session state without proving a coherent cut or preserving
current non-image continuity. Importing Rakazo's server/database/backup stack
would introduce a second authority and execution system. None is selected.
A unified database could simplify future coordination, but needs an explicit
conversion/recovery comparison and proof for every current owner; the existing
SQLite split is not declared a permanent product constraint.

Select explicit protected host maintenance access to each owning connection,
an exhaustive selected-runtime binding and a simultaneous SQLite writer cut.
The accessors are functions on protected service/control ports, never model
tools, JSON-supplied connections or ordinary exports. `composeS15` authenticates
the owner and refuses closing state before supplying the selected set. An
absent accessor, unknown reader or missing/extra live source refuses instead of
silently creating a smaller backup. The reviewed binary reader catalog does
not enable feature dependencies absent from the actual owning composition.

The internal contracts are:

- [`s16-ledger-image/v1`](../contracts/s16-ledger-image-v1.md): bounded streamed
  header/hash observation without opening SQLite, returning rows or inferring
  installation identity/authority.
- [`s16-ledger-set/v1`](../contracts/s16-ledger-set-v1.md): synchronous selected
  SQLite capture plus independent receipt-bound verification. It acquires all
  writer reservations, checks reader/page bounds and SQLite/foreign-key
  integrity, writes private images, releases every reservation and rechecks the
  current outer guard before publishing the manifest.
- [`s16-runtime-maintenance/v1`](../contracts/s16-runtime-maintenance-v1.md):
  existing-state operator access behind the same retained process lease as the
  service, with selected plus retained ledgers, exact reader/identity checks
  and no application boot/replay or missing-state initialization.
- [`s16-payload-set/v1`](../contracts/s16-payload-set-v1.md): streamed exact
  immutable bytes with independent receipts, plus an owning FILE resolver
  that reports pending/untracked custody instead of promoting or deleting it.
- [`s16-installation-lease/v1`](../contracts/s16-installation-lease-v1.md):
  retained shared leases over explicit selected CLI/service lifetime and
  exclusive maintenance exclusion before owner/vault access. An independent
  inode receipt prevents silent lock recreation; CHAT exclusion and older
  bridge-build durable fences remain separately required.
- [`s16-control-maintenance/v1`](../contracts/s16-control-maintenance-v1.md):
  current outer owner/lifecycle/recipient/site inspection combined with both
  process leases. Current outer custody is distinct from historical archives.
- [`s16-operations-control/v1`](../contracts/s16-operations-control-v1.md) and
  [`s16-installation-lease/v2`](../contracts/s16-installation-lease-v2.md):
  bounded current metadata, explicit crash-resumable adoption and independent
  missing-journal refusal before selected owner/vault access. Operator
  adopt/status works; request transitions/retention/aggregate actions remain.

A serialized WAL image is converted to rollback journal mode only in the new
image's documented journal-mode header bytes. The source and reader version
are unchanged. Actual staged images are opened read-only and checked, rather
than assuming a matching hash proves usability. Partial points have no
published manifest, are not resumed automatically and cannot overwrite an old
ID. A failed reservation release stays explicitly unknown.

Verification requires a manifest hash from independent protected receipts,
the exact installation/point and reviewed readers. Candidate metadata cannot
provide its own provenance or reader capability. Extra/missing files, changed
hashes, future formats, untrusted links/permissions and malformed SQLite refuse.
Even a hash-matching historical point is checked for real image integrity.
Images contain raw protected control state and never enter ordinary download,
artifact, model or execution-plane paths.

## Remaining aggregate protocol

[ADR 0104](0104-s16-forward-recovery-and-retained-admission.md) now selects
the source aggregate contract and forward-recovery tradeoff. Its implementation
and actual aggregate acceptance remain incomplete.

The selected-runtime SQL and immutable-byte sets are components. They do not claim
the outer owner/vault/site/recipient state, retained disabled stores, native
contexts, complete input/artifact/skill custody, client secure storage or
separate root helper are covered. Their exact owning roots, point identities,
consistency and recovery constraints must join the aggregate inventory before
any complete-backup capability is advertised.

The coordinator still needs a durable maintenance/admission protocol across
asynchronous native/backend capture; ordinary secret-free export; complete
private point retention; source/byte/schema/identity verification; and
quarantine/activation/interruption handling. A valid archive cannot roll back
current withdrawals, private scope, charges or original effect/request state.
Missing/corrupt current continuity must refuse rather than become an empty
ledger. Restore reconciliation and compatible release selection need actual
owning-service/client tests, including newer facts after the point was taken.

Upgrade fallback must respect adopted CHAT/FILE/TEAM/MEM/VM/helper reader
fences. Restoring an earlier composition manifest is not a reverse migration.
The full protocol must retain a compatible forward recovery path, integrate
verified service/native packages and uninstall retention, and exclude workers
until original uncertainty and current source restrictions are reconciled.
Do not expose placeholder controls or an aggregate success marker while these
parts are absent.

## Evidence and retained boundaries

`tests/s16-ops-ledger-image.test.ts`, `s16-ops-ledger-set.test.ts` and
`s16-ops-verify-ledger-set.test.ts` exercise actual owning SQLite classes,
writer conflicts, unknown/private/usage records, monotonic VM readers,
interruption, release uncertainty, missing/corrupt/hash-substituted images and
independent expected receipts. `s16-ops-composed-ledgers.test.ts` selects all
seventeen real composed services with scripted guest/speech/network seams and
drives current owner/client data before capture. This is deterministic
component/composition proof, not a completed restore or native-host dossier.

No new runtime/provider, dependency, hosted service, telemetry, source asset or
upstream runtime is imported. Existing mixed licenses/notices/provenance stay
with the service/native packages. S14 defaults, explicit S15 selection,
installed policy, historical private scope and owner-host configuration retain
their meaning. Native Linux/account/device evidence and owner-host adoption
remain separately owned by #431/#432; no actual host, account, credential,
policy or production change is performed by this source work.
