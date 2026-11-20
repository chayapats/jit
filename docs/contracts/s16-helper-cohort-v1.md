# s16-helper-cohort/v1

Status: protected current metadata component of OPS16-01, not complete backup,
physical settlement, root journal export or authority to recreate a missing VM.
Selected by [ADR 0107](../adr/0107-s16-read-only-helper-cohort.md).

`openS16ControlMaintenance(config).helperCustody()` binds every current
[controller](s16-firecracker-controller-custody-v1.md) to its original loopback
relay, installation, computer, selection and basis under the genuine exclusive
installation/CHAT leases. Endpoint and original pending request come from the
current owning controller inventory, never an archive. Existing-only vault reads
require the canonical private current directory and unchanged single-link file;
missing storage refuses without initialization, repair or network access.

The authenticated management protocol adds `operation: "custody"` with required
`requestId: null | originalRequestId`. The owning helper returns
`s16-firecracker-custody/v1`: current computer, reader identity, complete journal
digest/counts and original active/requested receipts. The read transaction checks
SQLite integrity, closed owning tables/rows, dense original request revisions,
command hashes, launch continuity, selected-driver private context shapes, snapshot provenance
and retained retirement tombstones. Contexts and instance selectors participate
in the digest but never leave the helper. No inspect, observe, recover,
reconcile, submit, process probe or disk read runs. Current root metadata remains
independently retained; a digest cannot reconstruct it or certify physical facts.

Root journal cuts bound the database and canonical streamed metadata to 1 GiB,
64 computers/instances, 4096 original jobs and 4096 snapshot rows. Text fields
are bounded before loading (64 KiB JSON, 128 bytes other text); malformed UTF-8,
unknown tables/readers, missing original history or tombstones refuse. Runtime
schema fields are bounded before loading (32 objects, 8 KiB SQL per object).
The selected instance decoder runs inside that same bounded read transaction;
no preliminary unbounded instance projection occurs. Runtime
RPC requires owning format 2 and the selected native controller identity.
The protected cohort has at most 64 helpers and 4 MiB metadata. Each authenticated
request has a 10-second deadline, 4 KiB request and 16 KiB response bound; the
cohort refuses after 60 seconds. Older/missing helpers refuse without falling
back to a mutating operation or reporting a smaller successful cohort.

An original controller accepted/dispatched/unknown intent stays unchanged even
when the helper already has a committed receipt, or has no matching receipt.
Returned original commands must match the controller's pinned command digest;
the helper revision cannot precede its expected revision. This is read-only
custody evidence, not permission to settle or retry that original operation.

The immutable observation includes a complete cohort SHA-256 and live
`assertCurrent()` capability. Revalidation rereads every original helper and
must match the original digest; a changed cut refuses instead of replacing it.
It rechecks current leases at every async boundary. Context close retains all
exclusion while an original read is in flight; closed contexts cannot reuse old
observations. Aggregate publication/activation must retain and revalidate this
capability alongside the other current components. No archive manufactures it.

The deterministic transport seam requires an explicit `protocol_fixture` basis;
it cannot claim native host identity or enter the production helper reader.
Owning runtime/relay and packaged fixture evidence do not certify Linux/KVM,
installed account/policy changes, physical disk recovery or complete #429
acceptance. No new command or deployed root-helper service is installed here.
