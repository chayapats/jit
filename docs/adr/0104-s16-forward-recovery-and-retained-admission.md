---
status: selected source contract; aggregate implementation and acceptance incomplete
date: 2026-11-20
scope: OPS16-01; S16-AC21; FR-04/15/18/23/35/38; NFR-02/04/05/08/09/12
---

# Recover forward while retaining current control and admission custody

## Required behavior

[#429](https://github.com/chayapats/jit/issues/429) requires operations across
the selected service/clients, including recovery after newer withdrawals,
private-computer retirement, usage and original uncertain effects. An old
archive cannot replace those facts. Missing/corrupt required state refuses;
initializing an empty store or retrying an original uncertain effect is not
recovery. This decision selects source engineering for that outcome; it does
not adopt a release, change an installed policy or perform owner-host cutover.

## Comparison and choice

Rolling every ledger and directory back to one old timestamp would be simple
but would revive withdrawn sources, refund usage and lose original request
identities. Row-by-row merges of unrelated owning schemas would require a new
authority mapper, with especially difficult choices for commands, transitive
file lineage, recipients, approvals and physical VM generations. Importing an
upstream application/database would also add a competing authority stack.

Select **forward recovery with a retained current control cohort**. Verify the
historical point in quarantine; preserve the complete current owning ledgers
and their original identities rather than semantically merging arbitrary
rows. Current metadata selects any immutable bytes recovered from the old
point by exact identity/hash. Historical material not referenced by current
metadata remains quarantined. Existing current native/device/helper/VM
custody remains current; its own supported recovery protocols are required
before any separately requested replacement. This is control-plane recovery,
not an unadvertised time-travel or working-disk rollback command.

This deliberately trades availability for authority preservation. Without
independent, readable current continuity, recovery blocks with an explicit
continuity requirement. A candidate archive, its self-hash, an old operations
journal or an empty fresh installation cannot supply that missing authority.
A separate durable current continuity cohort can supply it only under the
same exact installation/identity/generation and independently retained
current receipt. A historical backup cannot declare itself current.

## Retained admission and interruption

The versioned [aggregate protocol](../contracts/s16-recovery-point-v1.md)
combines the installation shared/exclusive lease, existing CHAT exclusion and
the outer owner-store's existing durable maintenance-fence compatibility.
The operations journal and lease/inode receipt remain outside archive and
activation targets. Earlier executables/installers must be proved compatible
with these fences and actual adopted readers before fallback; a previous
composition manifest alone proves neither.

Activation never replaces a directory containing the retained process lock.
Close/checkpoint owning database handles while retaining process exclusion,
then replace individually enumerated data components under a durable original
intent. Record source, prior and target hashes before every replacement.
Recovery recognizes already-completed replacements by the same identities;
it neither starts a new request nor guesses from a filename. A torn/unknown
boundary keeps admission fenced. Native/helper/physical uncertainty is not
settled by process death, SQLite close or a successful file copy.

Every target control ledger comes from the verified current cohort. Its
current withdrawals/private scope/charges/commands and unknown identities
remain byte-for-byte present; no historical decision becomes a fresh grant.
Current owning reconciliation can retain blocked original operations while
unrelated work later becomes admissible. It must not claim every unknown
effect disappeared. Revalidate the exact current cohort before activation;
new current facts invalidate an older prepared action.

## Custody and product boundaries

Ordinary export uses explicitly allowed owning projections: configuration,
user-visible content and already-authorized immutable deliverables, with
current scope/withdrawal rechecks. It never exports raw ledgers, owner auth,
vaults, provider credentials, native session stores or protected-site profiles.
Protected recovery points are private operator custody with independent
receipts and finite retention, outside ordinary download/artifact/model paths.

Credentials, browser login sessions, native device secure storage and current
provider/VM/helper ownership are retained separately or require reconnection
through their existing owner path. Reinstalling a verified client package does
not replace its service binding or silently copy another device's credentials.
Uninstall retains protected state, operations receipts, releases and disks.
No hosted backup service, telemetry or paid vendor becomes required.

## Implementation and acceptance status

ADR 0103 supplies bounded SQL/byte capture, receipt verification, runtime
inspection and selected-CLI lease participation. Those components do not
implement this aggregate. Outer current-state inspection and the
[current v2 journal/gate](../contracts/s16-operations-control-v2.md) are implemented
as components. [Physical point retention](../contracts/s16-point-files-v1.md)
now uses authenticated file inventory and original durable plans. The
[current producer](../contracts/s16-point-capture-v1.md) binds complete control
cuts and separate external/client references before receipted publication.
The separate [ordinary owner export](../contracts/s16-owner-export-v1.md) uses
current owning projections. [Current payload references](../contracts/s16-current-payload-references-v1.md)
can now read current metadata before missing immutable bytes are repaired; the
catalog is not full-cohort or activation authority. Durable forward activation,
compatible forward release selection and actual operator/client flows remain
required. The protocol must refuse unsupported custody instead of silently
shrinking the selected installation.

Required deterministic evidence includes actual owner/client state before and
after recovery, post-point withdrawal/private retirement/charges, original
unknown-effect dedupe, a missing/corrupt partition for every required
component, interruption at each durable boundary and older-build negative
boot after adopted reader fences. Schway sessions use only its public
`schway.host.session-snapshot/v1` and management APIs, including retired/deleted
continuity. Source presence, validator tests and transport success cannot close
#429. Native host/account/device acceptance and owner cutover remain #431/#432.
