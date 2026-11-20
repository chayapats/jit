# Protected S16 point capture

Status: source producer under [ADR 0112](../adr/0112-s16-receipted-point-publication.md),
[recovery-point](s16-recovery-point-v1.md) and [point-files](s16-point-files-v1.md).
Forward restore, ordinary export and full upgrade/client lifecycle remain incomplete.

`backup --s15 --config <current-config> --request-id <original-id>` runs only from
its actual verified copied artifact with sealed locked dependencies. Code derives
its own artifact root. No caller selects a package, destination, reader, credential
or expected hash. S14 defaults and legacy operations retain their contracts.

`s16-point-capture-command/v1` hashes configuration/package. The original request
supplies operation/point IDs, admission revision/time. Selected features require
existing owning stores. Current owner/native/VM/helper/FILE/GitHub and separately
retained external/client custody remain original.

The owned session retains native disposal and installation/CHAT exclusion. Busy/
unknown close cannot release it. Close it conclusively before current control.
Async helper revalidation runs at boundaries, never inside synchronous guards.

The original `point_capture_<attempt>_<planSHA>` capture_backend action binds
`s16-point-capture-plan/v1` outside the point at
`operations/point-staging/<operation>/<action>/plan.json`. It pins owner/install/
config/package/admission/time and original component cut hashes. Complete FILE/
GitHub catalogs are staged alongside it and copied as `file_cohort.json` and
`github_cohort.json`, retaining roles, pending/parser facts and older references.

SQL uses a simultaneous actual writer cut and integrity checks. Unpublished
partial staging reuses only matching private images/payloads after fresh complete
current-source comparison. `verifyOnly` refuses every missing member and cannot
repair a prepared/published point. Unknown names/links/formats or changed bytes
refuse. Native readback rechecks current public content and fresh deep quarantine
even with a producer receipt. Verifying requires its original confirmed action/
plan/manifest/receipt and cannot start another capture.

The cohort binds plan, SQL and payload hashes. Capture metadata and the manifest
are written last. Recheck all files/semantics/current cuts/package, confirm capture,
then advance to verifying with immutable cohort/target. Only
`point_publish_<manifestSHA>` with null prior and that target is a permitted
backup.verifying replace intent. Rename the complete directory atomically into
`operations/points/<pointId>` without overwrite, flush both parents, independently
verify, confirm publication, retain its receipt, then complete/clear the gate.

Fifteen fault boundaries: admitted, capturing, native, intent, plan, SQL, payload,
manifest, observed, verifying, publish_intent, published, publication_observed,
receipt and complete. Process-death recovery keeps original IDs/time/actions.
Completed retries verify the retained point and return its original receipt
revision. Retired points refuse and are never recreated.

Incomplete staging with no prepared manifest/final publication may be observed
not applied after conclusive source release. The same attempt refuses; explicit
distinct `--attempt` may capture locally under the same request. Old partials/
receipts remain. Unknown publication/release cannot be bypassed or converted into
a fresh VM/provider attempt.

Limits: SQL 2 GiB/256 images, payload 4 GiB/20,000 files, point 6 GiB, all point
metadata 4 MiB, ten retained points. Point staging is bounded to 12 GiB/250,000
nodes/depth eight with conservative whole-attempt reservations. Native staging
retains its separate 8 GiB limit. Exhaustion refuses without evicting unknown
partials, receipts or current continuity. Explicit staging retirement is required
separate work.

`s16-point-capture-result/v1` returns retained state, original operation/request/
point IDs, manifest hash, bytes and terminal receipt revision. It returns no host
path, credential or restore admission. Backend physical state stays unobserved/
independently retained. This is not disk/device recovery or complete cross-client
upgrade/restore/uninstall acceptance.
