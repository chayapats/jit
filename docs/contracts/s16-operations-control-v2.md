# s16-operations-control/v2

Status: selected OPS16-01 current-journal write/admission contract. Aggregate
point creation now uses the [protected producer](s16-point-capture-v1.md); forward
recovery remains required. Physical retention is implemented by the
[point-files layer](s16-point-files-v1.md) under this journal.
The v2 writer and maintenance gate implement the protocol below; source/test
presence is not aggregate acceptance.

V1 adoption remains readable. Its supported writer produced only revision-zero
metadata with empty requests/points. The first real journal write promotes that
empty current state atomically to v2. A nonempty v1 prototype stays readable and
fenced; unsupported historical conversion is never guessed or initialized empty.
Every subsequent write retains v2. Older v1-only readers refuse before owner/
vault access, including builds that understood the v2 *lease receipt* but not
current pending-operation enforcement.

The top-level shape stays as v1. Each v2 request additionally requires immutable
`configurationSha256` and `admittedRevision` (the original first revision).
`revision` remains the last update. Action state adds `not_applied`: an owning
observation matched the original prior state and settled that attempt without
effect. Original prior/target hashes and action IDs never change. `confirmed`
matches the target observation; unknown cannot be silently rearmed or discarded.
Each v2 action also requires `observedSha256`, initially null. Confirmed capture
with no pre-known target records its owning readback here, preserving the null
original target and exact deduplication tuple. Known refusal remains in history if a separately identified allowed attempt is
later needed. Neither metadata state is evidence the physical observation
actually occurred; the owning coordinator must obtain it independently.

Normal selected shared execution refuses any nonterminal current request.
An explicitly observational shared capability may read status, but cannot pass
writable-owner admission. Both kinds retain the same actual process read lease;
an observer does not authorize journal mutation, application boot or effects.

Before a request is written, retain an exclusive private
`s16-operations-maintenance/v1` fence at the existing owner admission path.
Its exact fields are `contract`, current operations `id`, `installationId`,
`ownerIdentity`, `operationId`, `requestId`, `kind`, `hash`, `pointId`,
`configurationSha256`, `priorRevision` and `createdAt`. The current journal and
actual configuration/owner must match. A crash before the request write resumes
only this original fence at its exact prior revision. A lost fence may be
retained again from the existing current request's immutable original fields;
this only restores exclusion, never permission to repeat an unknown effect.

Writes require the genuine exclusive installation lease, current owning-control
guards and an expected journal revision. Changed payload/kind/point reuse
refuses. Identical recorded retries return original data without allocating
another ID, clock time, request or action. Only one nonterminal request exists.
Admission reserves its 128 KiB future settlement slot, remaining bounded point
metadata and journal overhead before starting work. Capacity never evicts an
unknown/current receipt. Failed or unknown writes keep the gate and report
uncertainty; they do not claim completion.

Phases follow v1's forward profiles. Blocked/unknown holds the current phase.
An owning reconciliation must settle unknown actions before explicit resume;
resume retains original IDs. Cohort/target bindings are write-once and must
match on retries. Complete/discarded requests contain no unsettled actions.
The exact current fence clears only after a terminal request is durably
verified; response loss retries only that original clearance.

The aggregate encoder preserves each receipt's existing 128 KiB canonical
bound while independently enforcing the 4 MiB control bound. It never widens
the shared application's per-command JSON limit. A large retained history can
still admit and settle a bounded request when its reserved slot fits.

Retained point rows bind the original verified backup receipt/manifest. At most
ten exist, including removal in progress. Mark a point removing and retain its
original remove intent before touching its bytes; reject another unfinished
request's reference. Remove the row only after the owning deletion observation
confirms absence. Keep completed request receipts after historical bytes retire.
An owning prior-state readback for a known refused removal returns the point
to retained custody. Its settled action stays immutable; another allowed
attempt needs a distinct action ID. Discard cannot strand removing custody.
This ledger protocol does not itself delete directories or certify a point's
physical inventory; that requires the aggregate verifier/retention coordinator.

Only backup.verifying accepts the replace intent `point_publish_<targetSHA>` with
null prior and the request's same non-null target. Record it after confirmed
preparation and before atomic publication. Other replace intents still require
prepared/activating. This is not a generic phase or unknown-effect bypass.
