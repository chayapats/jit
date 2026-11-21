# s16-recovery-staging-retirement/v1

Status: implemented protected extension under
[ADR 0120](../adr/0120-s16-completed-recovery-staging-retirement.md).
Complete compatible release/service/client lifecycle remains separate.

The current protected `retire-staging` command selects a source request ID.
A completed restore's current original receipt and independently confirmed
`s16-recovery-staging/v1` root/role inode ownership are mandatory. Partial,
discarded, unknown or unowned sources refuse. Current process exclusion and
original resource release guards are the same as backup staging retirement.

A v2 staging-retirement command/plan binds the source request's full immutable
receipt digest and original scope/action/root/role identities. The separate
retirement request prepares its plan hash and records its original remove intent
before deleting anything. The immutable plan is stored outside recovery staging
under the existing protected staging-retention metadata namespace. Original v1
backup command/plan/result bytes and semantics remain unchanged.

Only implemented recovery metadata/current SQL/native/quarantine roles below
the independently owned fixed root can be inventoried. Every known file has a
private single-link inode, complete bounded hash/length and pinned attributes;
every directory has an original private identity. Existing 16 MiB plan, 20 GiB
selected bytes, 100,000 nodes, depth 32 and 1 GiB member bounds still apply.
Changed/extra/linked/special/substituted custody refuses. Each original unlink/
rmdir is independently checked and parent-fsynced. Retry uses the same request,
source digest and independent plan; no new owner or deletion authority is inferred
from an absent member. A completed retry refuses a reappeared root untouched.

Only original private staging is removed. Canonical repaired payloads, all current
SQL/native/helper/client/credential/disk state, retained points and original
operation/removal receipts survive. Completed forward repair retry returns its
prior receipt before staging reads, including after a later withdrawal. No live
work/effect reconciliation, refund, history activation or automatic eviction runs.

`tests/s16-ops-recovery-retention.test.ts` exercises original ownership/removal
against explicit inert protocol child bytes and terminal phases. Actual copied
package cases in `tests/s16-ops-candidate-quarantine.test.ts` instead produce a
real retained point and complete repair, retire empty/populated public-native
staging, SIGKILL after actual file/directory removal and resume through the
shipped CLI. Current SQL/canonical bytes/native source/retained point and original
receipts survive; a later owning withdrawal stays absent on complete repair retry.
These are deterministic scripted proofs, not physical VM/device/account evidence.
