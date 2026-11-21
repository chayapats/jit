---
status: implemented current-reference seam; aggregate forward activation remains incomplete
date: 2026-11-21
scope: OPS16-01; S16-AC21; FR-04/15/18/23/35/38; NFR-02/04/05/08/09/12
---

# Read current payload references before recovering missing bytes

[ADR 0104](0104-s16-forward-recovery-and-retained-admission.md) requires forward
recovery from current control, retaining newer withdrawals, private scope, usage
and original unknown effects. The complete backup readers intentionally refuse
missing referenced bytes. Reusing them as the only restore preflight would refuse
before identifying which exact current bytes an authenticated candidate can repair.
Reading references from an old archive instead would reintroduce historical data
as current authority. Neither is the required forward recovery behavior.

Select separate protected current-reference reads over the actual owning FILE,
GitHub and DATA15 SQL readers. Share the existing bounded owning parsers with
complete backup capture. The [versioned projection](../contracts/s16-current-payload-references-v1.md)
reads current metadata without
requiring an intact payload directory or opening payload bytes. Its closed DTO
contains logical names/roles/identity/hash correlations, not paths, credentials,
raw SQL, grants or execution permission. Missing/corrupt required SQL still
refuses; no constructor, ledger initialization, recovery or mutation is invoked.

Current ready FILE receipts supply original/representation names, exact sizes and
hashes. Current artifact rows supply immutable staged payload pins, without
asserting CHAT publication. Withdrawn/cancelled/expired/rejected input does not
become a recovery target. Uploading/validating rows remain pending facts, not a
claim that partial bytes can be replaced by a completed historical file. Current
GitHub and typed DATA15 reference slots supply exact bundle identity/hash and
original row/slot/state correlations; current SQL generally does not supply the
bundle's byte length. A separately verified candidate can supply bounded bytes
matching that digest, never a new reference or permission. Unreferenced historical
members remain quarantined.

A genuine installation/CHAT current-control capability owns the combined read.
Original metadata revalidation must refuse changed current references even when
a WAL write leaves a main-file timestamp and operations revision unchanged. This
reference digest is not the complete current cohort: preparation/activation must
also bind and revalidate every current control/native/helper/external fact and
compatible package. No reference catalog alone permits replacement, admission,
publication, native resurrection or effect replay.

The complete backup/custody paths retain their original stronger byte existence,
private-path, inventory and hash requirements. A metadata-only read must not make
an incomplete point look complete. Explicit finite SQL/reference/encoded-size
bounds refuse the entire catalog without truncation, missing-state repair or
retention eviction. All raw descriptors remain host-only.

Deterministic evidence uses actual owning upload/artifact/withdrawal and GitHub/
DATA15 state, then removes or substitutes disposable payloads. Current references
remain readable while complete capture refuses; current withdrawals remove the
expected input, missing/corrupt owning SQL refuses, stale observations fail and
read-only projection leaves current SQL/usage/unknown effects unchanged. A future
forward coordinator still has to authenticate candidate custody and durably bind
original prior/target identities before actual activation. This component does
not complete restore, service/client lifecycle or #429 acceptance.
