---
status: implemented protected verification extension; package coordinator conformance pending
date: 2026-11-21
scope: OPS16-01; S16-AC21; FR-04/15/18/23/35/38; NFR-02/04/05/08/09/12
---

# Recheck current public native state against the original completed backup capture

Package selection needs current native proof after short maintenance processes
release their leases. [ADR 0124](0124-s16-sealed-package-current-reader-probe.md)
only observes native namespace metadata. Creating a second native staging family
for upgrade would duplicate the existing backup ownership, quarantine, bounds
and disposal protocols and change older-reader compatibility.

Select an explicit current-verification mode over the independently owned native
capture of an existing **complete, retained backup**. Require both protected
`verifyCurrent: true` and `ownedStaging: true`, the original confirmed capture and
ownership actions, retained point binding, original options/plan/receipt/files,
and an exact current namespace match. Ordinary terminal capture remains refused.
No new original intent, plan, member, manifest, receipt or ownership may be
created. Missing or retired capture/scratch evidence refuses before recreation.

Reuse actual public native capture and deep quarantine validation. Only original
owned scratch may be cleaned/refreshed for validation; it remains temporary and
cannot replace current native state. Current authority/native/VM facts, original
backup metadata and another operation's admission fence remain in place.
Confirmed-action readback is idempotent and grants no work or activation.

Retain the original native capabilities and process exclusion after unknown
disposal until same-capability close succeeds. A package coordinator still owes
its exact owner/config/package/cohort checks, selector intent/readback and owning
service/client lifecycle. This extension proves current native equivalence to
the original capture; it neither rewinds history nor settles unknown effects.

Also apply existing-evidence-only checks to the original verifying phase. A
missing owned quarantine/marker must refuse before creating a replacement.
Retain existing control/native-set formats; no v4 authority journal or new
ordinary client operation is introduced.

Conformance uses an actual copied sealed operator with empty native state and
real public Schway sessions plus an explicit MODEL protocol correlation. It
checks unchanged current SQL/control/fence/component bytes, repeat verification,
missing/changed evidence, later native identity, retired staging and removed
point refusal. Native-set regressions also check missing original scratch in
backup.verifying. These cases do not certify service-dispatched model work,
installed upgrade/fallback, native device UI or Linux adoption.
