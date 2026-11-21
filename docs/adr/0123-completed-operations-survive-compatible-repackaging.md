---
status: implemented terminal response binding; aggregate lifecycle acceptance pending
date: 2026-11-21
scope: OPS16-01; S16-AC21; FR-04/15/18/23/35/38; NFR-02/04/05/08/09/12
---

# Retain completed operation identity across compatible repackaging

Backup and forward repair bind their original command to the executing sealed
package, current owner and exact configuration. Repackaging identical compatible
source changes the package content hash. A completed response retry currently
recomputes the command hash and conflicts before returning its original receipt.
This prevents response recovery after even a compatible package replacement.

Select original terminal receipt lookup, not a weaker generic command hash.
Continue validating the actual executing sealed package, current owning stores,
installation exclusion, owner and exact configuration. For a complete backup or
restore only, match the original kind/request/configuration and (for restore)
point identity, then use its independently stored original command binding for
terminal journal readback. The journal still clears only that original completed
operation's stale fence; another operation's fence remains untouched.
Command-conflict error handling cannot mark the mismatched original request
blocked or rewrite its revision/reason: failure recording requires the exact
original command binding, including after an interrupted journal admission.

The completed restore returns metadata without reopening old staging or repairing
bytes again. Later withdrawal remains current. Completed backup still checks its
retained point and full inventory; removed or corrupt retained bytes refuse and
are never recreated. An unfinished operation remains bound to its original
package. A new compatible package cannot silently continue its activation or
replace its original plan. Changed configuration, kind or point still conflicts.

The alternative, accepting a different package hash for every retry or weakening
the generic journal's dedupe check, would change nonterminal activation authority.
It is unnecessary for a terminal response and is rejected.

Two independently sealed packages from the same source establish this narrow
repackaging behavior. They do not establish upgrade/fallback across changed
formats, service health, client update or physical-host lifecycle acceptance.
