---
status: selected current-custody component; aggregate activation and acceptance pending
date: 2026-11-21
scope: OPS16-01; S16-AC21; FR-04/15/18/23/35/38; NFR-02/04/05/08/09/12
---

# Observe present current bytes and exact missing pins

[ADR 0116](0116-s16-current-payload-references-for-forward-recovery.md) reads current metadata even when
bytes are absent. It does not preserve all present unreferenced, pending, parser
or withdrawn custody. [ADR 0117](0117-s16-forward-payload-recovery-with-current-control.md)
requires that full current custody before exact immutable-byte repair. Using the
strict complete-backup collector alone would refuse before recording missing
members; ignoring a collector error would lose current custody.

Select separate protected current FILE and GitHub custody observations, sharing
the complete-backup collectors and owning bounded SQL parsers. Their distinct
versioned values contain every present verified member plus exact missing current
pins. Default complete backup retains its original strict missing-byte refusal.
Present corrupt or unsafe bytes refuse the whole observation; an old point never
authorizes overwriting them. Only a separately receipted candidate and original
current repair plan can supply a missing immutable member.

FILE originals/representations/artifacts keep exact current names, sizes and
hashes. Withdrawn/terminal leftovers, upload fragments and parser inputs/outputs
remain present untrusted custody. Pending state is never completed from history.
Missing validating originals or required parser continuity refuse; neither is a
recoverable immutable pin. An absent byte directory is an observed absence,
never initialization permission. GitHub retains all present hash-addressed
bundles, including unreferenced bytes, and every exact current GitHub/DATA15
correlation. Missing bundle lengths remain unknown until candidate verification.

Each original observation includes separate host-only physical identities for
its files, directories and absences. Path-free values never expose these paths.
Strict revalidation pins the original complete namespace, attributes and current
metadata; it refuses even an otherwise matching repaired member. The later
activation coordinator must independently bind the original identities and
explicit planned transitions before writing. A directory identity excludes child
membership timestamps only in the host identity record; strict revalidation
still checks the complete original attributes and namespace. These identities
alone are not an activation or admission capability.

Actual current sources, genuine installation/CHAT exclusion and optional complete
writer-cut authentication precede observation. Unrelated source transactions,
closed/retired parents, malformed/foreign SQL and unsafe or over-budget paths
refuse. No owning store/parser constructor, cleanup, credentials, Git command,
provider, native activation or effect settlement runs. Finite existing component
bounds apply without truncation or eviction. The
[contract](../contracts/s16-current-byte-custody-v1.md) is a component, not complete
SQL/native/helper/external custody, forward activation or #429 acceptance.
