---
status: selected source contract; aggregate lifecycle acceptance incomplete
date: 2026-11-21
scope: OPS16-01; S16-AC21; FR-04/15/18/23/35/38; NFR-02/04/05/08/09/12
---

# Own temporary capture namespaces before bytes and preserve abort uncertainty

An interrupted exclusive file write can leave present but incomplete metadata.
Requiring that metadata to authenticate its own retirement makes recovery depend
on the write that failed. Deleting arbitrary directories by suffix/path would
instead risk application data or another owner's files.

Select an independently journaled inode identity for each private capture-stage
root/data pair before any child file is written. The fixed namespace is temporary
backup custody only, not live application state. It contains closed point roles
or isolated native snapshot/quarantine roles. An explicit retirement may inventory
corrupt/partial bytes in that owned namespace without treating them as authority.
It pins every current file hash/identity in a separate durable removal plan before
unlinking. Extra/changed members after preparation refuse; no recursive deletion,
symlink following, arbitrary path or automatic quota eviction is introduced.

Select control v3 for staging ownership, explicit retirement and backup abort.
V1/v2 remain readable; existing ordinary writes stay v2 until a v3 feature is used.
Promotion preserves original identities/actions and adds nullable abort receipts.
Earlier readers refuse v3 before writable owner/vault admission. No lease inode,
application schema, installed policy or current authority is replaced.

Abort is a logical disposition of the original backup, not a claim that every
capture failed or every external effect settled. Preserve original confirmed and
unknown capture/publication actions. Require actual exclusion, conclusively
released capture/helper resources and absence of the canonical point. An owned
unregistered published directory may first be moved back to its original private
stage under a separate original quarantine intent; do not overwrite a destination
or touch a retained point. Unknown quarantine remains fenced.

A v3 abort receipt binds the original scope, prior phase, unchanged action facts
and current point-absence observation. It permits terminal discarded backup while
retaining only known local capture uncertainty. It never abandons restore,
upgrade, VM/provider work or another operation. Retiring staging is a separate
current operation with original receipts retained. Legacy unowned corrupt trees
remain inaccessible to deletion rather than gaining guessed provenance.

This is source lifecycle work under ADR 0104. Actual owner/client export, forward
activation and compatible upgrade/uninstall acceptance remain required.
