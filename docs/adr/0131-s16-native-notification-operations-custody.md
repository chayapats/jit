---
status: implemented scoped reader/inventory integration; aggregate acceptance pending
date: 2026-11-21
scope: OPS16-01; EVID16-01; S16-AC17/18/21/22; FR-04/11/15/18/28/35/38; NFR-05/07/08/09/12
---

# Retain native notification custody in selected operations

The #426 delivery adds `native-notifications.sqlite` to the owning composition.
The previous operations reader inventory names seventeen runtime formats and
cannot accept this eighteenth selected/retained journal. Omitting it would lose
current subscription, cursor and uncertain delivery custody; silently ignoring
an unknown ledger or initializing another one is not an alternative.

Register its actual DurableJournal application ID `0x4e503136`, format 1, and
installation identity contract. Bind the existing owning live database in
`maintenanceSources`. Offline maintenance includes it when selected or retained
after disabling the feature. Bound manifest membership by the reviewed reader
inventory rather than a stale seventeen-store constant. Unknown formats and
unregistered ledgers still refuse. Earlier points remain readable; an earlier
package without this reader cannot qualify for current native-selected state.

Probe the same four native tables/columns as the owning constructor, without
constructing that service. Maintenance never performs its restart transition
from sending to pending, observes a notice or invokes APNs/FCM. Capture copies
the current journal, including current device custody and uncertain attempt/
collapse identities, only into protected recovery storage. Ordinary exports
remain independent and contain no device token or signing credential.

Explicit native provider configuration also selects guarded first setup/
upgrade/uninstall routing. It cannot enter the baseline composition fallback.
Signing files remain protected external credentials: retain current custody or
reconnect through the owning contract; no historical point grants a provider
account, restores an old token or authorizes a new external recipient.

Conformance captures all eighteen real owning journals, preserves a sending
attempt and subscriptions, retains a disabled journal, and refuses missing,
foreign, future-format or incomplete native state without reconstruction.
APNs availability/transport is scripted and no provider dispatch occurs. This
does not establish physical push delivery, native UI or live-account acceptance.
