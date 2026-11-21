# s16-recovery-staging/v1

Status: original private namespace component under
[ADR 0117](../adr/0117-s16-forward-payload-recovery-with-current-control.md).
No candidate, current cohort, repair plan, payload activation or admission is
certified by this component.

The actual current-control capability exposes `recoveryStage(requestId)` only
for an existing nonterminal restore in capturing/verifying/prepared/activating.
The original current journal, retained installation lease, configuration and
owner binding supply its operation/point identity. Neither an archive nor an
ordinary actor supplies a filesystem destination or ownership hash.

Its fixed private root is `operations/forward-recovery/<operationId>` with
exact child directories `ledgers`, `payloads` and `quarantine`. Before the first
child file write, the current journal independently pins the empty root and
all three child inode identities. Scope includes current operations/install/
owner identity, original request/command/configuration/admission/time and point.
One original `capture_backend` action records the root scope digest as prior,
the child-set digest as target, then confirms independent live readback. This
uses the existing restore capture phase and local capture intent semantics;
it neither uses backup-only abort/ownership exceptions nor changes old formats.

Creation may resume only the exact fixed empty directories before the original
ownership intent was recorded. An unowned nonempty tree refuses. An intent or
unknown ownership action can confirm only its original exact still-empty
namespace; it does not allocate another request/action or resume other effects.
After confirmation, child metadata can be incomplete/corrupt without becoming
its own ownership proof. Missing/substituted owned directories refuse before
recreation or writes. No cleanup, deletion or historical state activation runs.

The frozen host-only capability provides fixed-role paths and a live guard.
Original journal observations and all directory identities must remain pinned.
Only the four bounded top-level metadata names `candidate.json`, `current.json`,
`plan.json` and `progress.json` are allowed in addition to the three role
directories. They must be private same-owner single-link regular files; their
semantic/hash validation remains with the owning future coordinator. Role paths
cannot contain caller-selected segments. A private registry rejects fabricated
capabilities or copied methods. Closing/retiring the original control capability
invalidates the stage. Directory membership/nlink changes from legitimate child
writes are not substituted directory identity.

The stage constructor creates only the finite empty directory set; the current
journal's existing request/action bounds still apply. Before any later SQL,
payload or opaque native ingestion, the forward coordinator must enforce full
per-file/aggregate byte and node quotas, bind its independent immutable plan and
revalidate original paths. Namespace ownership alone grants no byte selection,
publication, deletion or execution permission.

`tests/s16-ops-recovery-staging.test.ts` uses an actual current restore operation
over disposable point-format fixtures. It asserts current SQL/point preservation,
unknown ownership readback, forged/substituted/missing/linked/extra refusal and
actual SIGKILL after directory creation, original intent and observation. These
fixtures deliberately contain synthetic package/external point metadata and do
not establish aggregate candidate verification or forward restore acceptance.
