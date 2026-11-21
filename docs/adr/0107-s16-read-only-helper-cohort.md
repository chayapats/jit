---
status: selected source contract; aggregate acceptance incomplete
date: 2026-11-20
scope: OPS16-01; S16-AC21; FR-04/15/18/23/35/38; NFR-02/04/05/08/09/12
---

# Bind current root-helper metadata without inspecting or reconciling a VM

ADR 0104 retains current helper authority separately from historical points.
ADR 0106 captures controller intent journals. The existing helper `state` RPC
can call `inspect`, which writes an observation; `reconcile` can settle an
original job. Neither is a read-only current-cohort cut.

Select an authenticated `custody` operation on the existing one-computer relay.
The owning helper reads one consistent bounded SQLite snapshot, validates its
reader/record graph and fingerprints all current metadata, including private
contexts and retired snapshot tombstones. It returns only the digest/counts,
current computer and original active/requested receipts. Private contexts,
paths, process selectors, credentials and disk contents never leave the helper.
No inspect, recover, reconcile, dispatch or physical observation runs.

Returning a raw root journal would disclose private recovery details and tempt
historical replacement. Returning only the current running/stopped state would
omit unknown effects and tombstones. A bounded digest plus exact original
receipts retains current continuity while leaving the root helper authoritative.
It certifies metadata custody, not physical settlement or reconstructability
of a missing helper. Missing current helper continuity still blocks recovery.

The protected operator binds every selected controller to this existing relay
using current manager/installation/selection and native controller identity.
It reads an existing vault value without creating missing storage, requests
only custody, retains original controller uncertainty and compares immutable
current cuts before publication/activation. No archive chooses the endpoint,
credential or original request. A missing/older relay refuses; there is no
fallback to a mutating RPC or a smaller successful cohort.

This adds no deployed service, credential, account or policy change. Native
Linux/root-helper acceptance remains separately required. Parser/backend/client
custody, point retention and the complete aggregate lifecycle remain #429 work.
