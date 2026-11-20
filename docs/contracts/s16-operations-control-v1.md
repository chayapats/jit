# s16-operations-control/v1

Status: selected protected OPS16-01 operations metadata/adoption contract.
Aggregate backup/export/restore/upgrade/uninstall implementation and acceptance
remain incomplete under `s16-recovery-point/v1`.
The current source implements strict read-only metadata validation, explicit
adoption, v2 admission binding and operator adopt/status. Request transitions,
point retention and aggregate action execution remain to be implemented.

## Current identity and adoption

The fixed private `operations/control.json` is current continuity, never an
archive component or activation target. A bounded canonical JSON journal uses
the existing atomic-file/fsync primitive while the genuine installation
exclusive lease excludes participating writers. This is simpler than another
SQLite owner/process-lock layer for at most 4 MiB of operation metadata; the
application's existing SQLite ledgers retain their owning contracts.

Normal operations only open existing control. First adoption is an explicit
protected operator operation after existing owner/lifecycle/runtime inspection.
It binds a fresh 32-hex operations identity, the exact configured installation,
the distinct current owner memory/lifecycle identity, original adoption request
and configuration SHA-256. It never initializes a missing application ledger.

An `s16-installation-lease/v2` receipt extends the retained device/inode binding
with `{ id, installationId, ownerIdentity }` for this journal. Receipt v1 remains
valid for installations that have not adopted operations. A v2 binding requires
the existing canonical, structurally valid journal and matching identities
before normal selected CLI owner/vault access. Missing/corrupt/foreign/future
control refuses; it cannot be reconstructed as an empty v1 journal. V1-only
lease admission rejects the v2 envelope before opening owner state.

Before adoption creates current operation state, publish an exclusive durable
`s16-operations-adoption/v1` fence at the existing owner maintenance-fence path,
bound to the original request/operations/config/owner identities. Existing S14
normal and foreign-maintenance admission refuses it. Keep installation/CHAT
exclusion through creation/verification, then atomically publish the v2 receipt
without replacing the lock inode. Recheck the exact durable artifacts before
removing only that original fence. A crash/response loss resumes the original
adoption, not a new identity. An unrecognized/conflicting/torn fence refuses.

The known receipt transition refreshes only its owning exclusive capability's
expected receipt metadata after durable verification. It does not commit/release
the SQLite process transaction. A failed/unknown boundary leaves the durable
fence in place. The target journal is independently bound current custody;
neither candidate contents nor a candidate self-hash supplies this binding.

## Exact journal shape and bounds

The exact top-level fields are `contract`, `id`, `installationId`,
`ownerIdentity`, `revision`, `adoption`, `requests` and `points`.
`adoption` has `requestId`, `configurationSha256` and `createdAt`.
Identities/aliases are bounded opaque identifiers; hashes are lowercase SHA-256;
revisions/times/bytes are nonnegative safe integers. Unknown fields/contracts,
noncanonical JSON, duplicate identities and invalid phase/status combinations
refuse before use. Metadata contains no command, URL, host path, secret, native
payload or inferred owner approval.

Each request has `id`, `requestId`, `kind`, `hash`, `phase`, `status`, `pointId`,
`cohortSha256`, `targetSha256`, `createdAt`, `updatedAt`, `revision`, `reason`
and `actions`. Kinds are `backup`, `export`, `restore`, `upgrade`, `cleanup` or
`uninstall`. Phase profiles are:

- Backup/export: pending → capturing → verifying → complete.
- Restore/upgrade: pending → capturing → verifying → prepared → activating → complete.
- Cleanup/uninstall: pending → prepared → activating → complete.

`discarded` is terminal only without unsettled actions. Status is `running`,
`blocked`, `unknown`, `complete` or `discarded`; blocked/unknown retains the
original phase/identity. Only one nonterminal request may own maintenance.
Completed original receipts remain deduplicated even after point retention
removes their old historical bytes. A repeated request with a different kind
or payload hash refuses; metadata never authorizes retrying an unknown effect.

Each action has an opaque `id`, `kind`, `priorSha256`, `targetSha256` and
`state`. Kinds are `replace`, `remove_point`, `select_package`, `capture_native`
or `capture_backend`; states are `intent`, `confirmed` or `unknown`. Persist
original intent before the physical boundary. A metadata transition alone is
not evidence the action happened; the coordinator must observe its exact
owning result before confirmation/admission. Complete/discarded receipts cannot
contain unsettled actions. Unknown actions keep the request blocked/unknown.

Each retained point has `id`, `sha256`, `bytes`, `createdAt`, `operationId`
and `state` (`retained` or `removing`), bound to its original backup request
and manifest hash. Mark removal durably before deleting exact owned point
bytes; do not remove points referenced by another unfinished operation. Confirm
removal only after actual durable cleanup, retaining original request receipts.

Limits are 256 request receipts, 128 KiB per request, 256 actions per request,
10 point rows and 4 MiB total canonical metadata. Admission reserves the active
request's future bounded settlement space and remaining point metadata before
starting work. Capacity refuses new work; it never evicts current continuity,
original uncertainty or unknown receipts. Every mutation rechecks the genuine
exclusive lease and exact control revision, then atomically writes and verifies
the new canonical state. No historical point can replace this journal.
