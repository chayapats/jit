# s16-candidate-quarantine/v1

Status: protected historical-custody component under
[ADR 0117](../adr/0117-s16-forward-payload-recovery-with-current-control.md).
It authenticates a retained point and verifies native ancestry in quarantine.
It is not a complete current cohort, repair plan, release eligibility, live
native restore or worker-admission certificate. Forward payload activation and
actual complete service/client lifecycle remain required by OPS16-01.

`S16ControlMaintenance.candidateQuarantine(requestId)` owns one original restore
verification session. Actual current control supplies its owner/install/config,
retained exclusive lease and original request. A current retained-point row and
its completed original backup bind point/manifest bytes, old capture cohort,
configuration and request/time. Only their fixed point ID selects the path;
candidate self-hashes and archive paths never supply provenance or destinations.

Verification first checks the actual executing sealed service/dependencies,
readers and shipped notices. It authenticates the complete fixed point inventory
and every byte against those independent receipts and requires complete catalogs.
Actual SQLite images must pass integrity and supported reviewed readers; unknown
required formats refuse. The old producer/package pins remain authenticated data,
not executable selection. No historical SQL, code, dependency or credential is
activated. Current live SQL, private scope, withdrawals, charges and original
effects remain in place.

Native plan IDs map only to canonical **current** protected roots with the same
kind/owner/phase. Missing required current native continuity refuses without
recreating a root or trusting older lifecycle state. Bounded Jit-owned envelopes
must match their original saved refs and current trusted workspace binding.
Schway snapshot artifacts remain opaque. Only supported public validation,
restore and inventory APIs inspect their actual saved ancestry. Strict context,
no tools/lookup and no model invocation prevent verification from becoming work.

Before any opaque write, the original
[recovery stage](s16-recovery-staging-v1.md) pins private root/role identities.
Verification creates only fixed native-ID scratch roots with empty `home` and
`sessions` directories. One current `capture_native` intent independently binds
`candidate.json` by SHA-256, including original operation/point/scope, current
native namespace digest and all scratch root/home/session inode identities.
The immutable plan is durably written and independently read back before use.
Child metadata cannot authenticate itself. An unowned nonempty/extra/linked tree
refuses. Missing plan reconstruction is allowed only before preparation, while
all original scratch directories remain empty and the computed plan matches the
already recorded original target hash. Missing prepared plans and partial opaque
trees without their plan refuse.

The public restore uses the same original scratch paths and snapshot on retry.
An identical partial target resumes through Schway's supported idempotent restore;
mismatched native bytes refuse. Exact returned references and active/retired
inventory must match the authenticated historical snapshot. Deleted identities
stay metadata-only. Historical active state in scratch never changes a newer
current retirement/deletion. Source home files, credentials and live native
state are not copied into scratch. No session is run or reopened for work.

Only after all original public resources conclusively close, current namespace
and executing package revalidate and the original action is observed may the
component return `s16-verified-candidate/v1`. The frozen host-only observation
contains point ID/manifest hash, authenticated inventory and native root count.
`payload(name)` resolves only an exact member of that inventory and rechecks
current receipt scope plus its original file identity. Consumers must verify its
expected bytes/hash during copying and select targets solely from current pins.
It is deliberately not an ordinary download or permission to release an old
withdrawn/unreferenced member. Full `assertCurrent()` reauthenticates the complete
inventory, original identities, native namespace and actual package at aggregate
boundaries. Closing the session invalidates its observations.

The parent registers disposal before any verification. Unknown public host/root
close retains the original handle and both installation/CHAT exclusions; source
retirement and new cuts refuse while resources remain owned. Only retrying that
same disposal releases them. Close during active verification refuses. Failed
verification blocks its original request/action under the retained gate when
current guards still permit metadata; a lost guard cannot authorize another
write. No unknown provider/VM effect is settled or retried by these local facts.

Finite point/native component bounds apply before reads. Plan metadata is <=4 MiB;
original recovery staging is bounded to 12 GiB, 250,000 nodes, depth 32 and 1 GiB
per file. A public native restore additionally reserves its published artifact
sizes plus conservative per-session metadata/node allowance before ingestion;
actual private usage revalidates afterward. Quota failure refuses the whole
operation without truncation, deletion or eviction. The later forward coordinator
must also account for all current SQL and target staging before activation.

`tests/s16-ops-candidate-quarantine.test.ts` builds the actual copied package,
initializes and captures real receipted points, and verifies current withdrawal
and missing payload behavior without rewriting SQL. Populated native cases use
real public sessions/retirement/deletion with explicitly seeded MODEL protocol
correlations; they do not claim service-dispatched work. Tests cover corrupt
points/plans, missing prepared plans/current SQL/native continuity, unowned
scratch, actual SIGKILL at seven boundaries (including a real partial public
restore), original request/action/plan preservation, and injected unknown close
with independent process lock probes. Live accounts, physical devices/hosts,
payload activation and complete OPS16-01 acceptance are not inferred.
