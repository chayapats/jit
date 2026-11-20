# s16-native-set/v1

Status: protected OPS16-01 subcomponent. It does not complete aggregate recovery,
ordinary export, physical retention or installed-host/client acceptance.

`S16ControlMaintenance.nativeSet(requestId, {attempt, maxBytes})` owns a single
native-set session under genuine current installation and CHAT exclusion. Only
an existing backup/restore/upgrade request in `capturing` may use it. Ordinary
export cannot acquire this capability. Close the session before closing the
control context; unknown/busy native release retains the remaining exclusions.
One context may own one active native-set session at a time.
The root opener registers its disposal capability with the coordinator before
its final guard can fail, so even an unknown close during open retains the
original handle and both exclusions for later disposal retry.

The complete current namespace supplies trusted paths and owning rows. Missing
required roots, partial roots, untracked entries, ambiguous/unavailable owners
and empty unresolved CHAT parents refuse. Known current owning intents may
retain uncorrelated identities through [native root v2](s16-native-root-v2.md).
Saved references must exist. Successful GitHub evidence requires discovered
native identity. Original unsettled VM/work facts and pending correlations stay
in the plan; capturing them never settles or retries the original work.

One `capture_native` journal action represents the entire set, allowing more
than 256 roots without one journal action/component per root. Its immutable ID
is `native_set_<attempt>_<planSha256>`. The original request/operation ID, command
hash, configuration hash, admission revision, creation time, installation/owner,
budget, exact root roles/saved refs/original custody and pending facts form the
private `s16-native-set-plan/v1`. Intent precedes staged writes. An existing
attempt cannot silently change its plan, budget or timestamp.

Fixed paths derive from current configuration and original operation/action:
`operations/native-staging/<operationId>/<actionId>/`. No archive/model/client
supplies a host path. Private `plan.json`, producer `receipt.json` and quarantine
ownership marker remain outside `data/`. Only `data/` is the protected component:
an exact plan copy, flat `<rootId>.json` files and manifest published last.
All reads/writes require canonical private same-owner regular single-link files;
no existing file is overwritten. Data inventory must match exactly.

The closed manifest contains `contract`, `installationId`, `operationId`,
`requestId`, `actionId`, original `capturedAt`, `planSha256`, root-body `bytes`
and `roots`. Each root row contains stable `id`, flat `name`, exact `bytes`,
`sha256`, public `identities` count and `uncorrelated` count. The plan supplies
owning provenance; counts are observations, not execution grants. The returned
component byte total includes root files, manifest and plan copy.

Plan/manifest metadata each has a separate 4 MiB bound, independent of shared
command JSON limits. Preflight conservative manifest overhead before copying.
The caller's remaining payload budget is at most 4 GiB, including component
metadata. Existing native staging, partial attempts and quarantine are accounted
through bounded no-follow metadata traversal (100,000 nodes, depth 32, 8 GiB).
Refuse overflow; never discard old attempts to make room. Physical retention is
separate. Per-root public limits still apply; roots are processed sequentially
without accumulating gigabytes of snapshot buffers.

Every newly published root requires public deep restore in fresh quarantine,
actual file readback/hash validation and conclusive native resource disposal.
Quarantine has separate home/sessions and the same bound workspace; it is never
live activation. A fixed private marker binds scratch to the original action,
plan and directory inode. Only this owning coordinator may remove verified
same-owner scratch children after all its native handles close conclusively.
Failed scratch remains until a later owning reconciliation; source native roots,
original unknown work and retained installation/CHAT lease inodes are untouched.

Per-root guards check only original root/ancestor identities and root inventory.
Full namespace guards bracket publication, avoiding an all-roots rescan at each
public async boundary. The set manifest is written only after all roots pass
deep verification and all native handles close. A separate protected current
`s16-native-set-receipt/v1` then binds the exact manifest hash; only owning
readback records the original action as confirmed. The aggregate request remains
in `capturing`, and its complete-cohort/target hashes remain unset by this layer.

After process death, retry uses original IDs/time/plan. A confirmed journal
hash or independent private producer receipt permits exact bounded file/hash/
public-shape readback. An unreceipted manifest additionally requires the current
namespace to equal the original plan, a fresh public snapshot matching every
custody/native byte/header (only the public copy timestamp may differ), and
fresh deep quarantine. Candidate self-hashes alone never establish provenance.
Missing current continuity refuses rather than initializing empty roots.

A known failure before any manifest publication can settle only this capture
action as `not_applied`, then block the original request. Partial files remain
private; explicit owning resume and a distinct attempt are required. Unknown
publication/release/journal boundaries stay fenced and unsettled. Closing retries
resource disposal only, never capture or original native/VM effects.
