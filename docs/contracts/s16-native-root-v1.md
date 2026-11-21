# s16-native-root/v1

Status: protected OPS16-01 native custody component under ADR 0104. It is not
aggregate completeness, ordinary export or permission to resume a session.
Explicit current-intent management custody uses the distinct [v2 envelope](s16-native-root-v2.md);
v1 behavior and reader refusal remain unchanged.

The owning coordinator supplies one existing current native root, installation
and opaque component ID, exact saved session/branch references, and its current
maintenance guard. Roots must come from actual CHAT/MODEL/GitHub/VM custody;
candidate archives and client input never choose a host path. The [complete
namespace resolver](s16-native-namespace-v1.md) is separate; this component cannot certify
that a caller selected every native root.

The root and existing `workspace`, `home` and `sessions` directories must be
canonical, private and same-owner. Missing roots are not initialized. A
metadata-only host uses only `schway/host`, strict context, no tools, hosted
lookup or auth selection. No model, session creation/open, credential lifecycle
renewal, native schema parser or live-restore method is exposed.

Inspection repeats complete public `listSessions` observations while the owning
Jit creation fence is held. It preserves active, retired and deleted entries;
management `main` references do not replace saved execution branches. Missing
correlations and extra service-owned identities remain explicit and block
capture until owning reconciliation supplies current correlations. Neither
discovery nor absence authorizes recreation or execution. A root is bounded by
the pinned public snapshot limit (64 identities); no truncation/chunking silently
weakens one coherent snapshot. Other roots remain a separate bounded inventory.

Capture uses public `snapshotSessions` on the exact saved nondeleted references,
including retired sessions, then public validation and a repeated inventory
check. Busy native owners, changed inventory, missing correlations or unsupported
formats refuse. Deleted entries remain in the envelope without fabricated
native artifacts. Empty known inventory is explicit, not inferred from missing
storage. The actual public snapshot bounds also apply (32 MiB per opaque artifact,
256 MiB decoded total at this pin). The JSON envelope has a separate finite
encoded bound; ordinary command JSON limits are unchanged.

The private envelope contains `contract`, component `id`, `installationId`,
`capturedAt`, exact `workspaceRoot`, saved `references`, complete `inventory` and
the opaque public `snapshot` (null only when no nondeleted reference exists).
Its actual bytes and SHA-256 belong in an independent protected current receipt.
Verification requires that expected hash, exact installation/component/workspace
binding and public native-format validation. It never restores/opens sessions,
copies leases/home/credentials or grants authority from historical bytes.
Current native tombstones/custody remain authoritative during forward recovery;
this envelope is not a portable substitute for missing current deletion state.

Shape/hash validation does not prove native branch ancestry. Before aggregate
acceptance, `verifyQuarantine` uses public `restoreSessionSnapshot` in a fresh
private child of the owning coordinator's separate staging directory, with the
same bound workspace but separate home/session storage. Only `restored` passes;
partial/quarantined native state refuses. This invokes no model, session open,
tool, credential selection or live activation. It never overwrites/reuses a
quarantine child or deletes failed material. The coordinator supplies the stage
path from current configuration, never archive contents. All owning native
handles must close conclusively; unknown quarantine close remains retained by
this capability for a later close retry. The aggregate must perform this check;
the synchronous `verify` method remains only envelope/public-shape verification.

Current guards run around every asynchronous boundary. Unknown host close stays
explicit; an owning coordinator must retain remaining exclusion rather than
declare native release. Closing with an outstanding inventory/copy promise
refuses busy, stops new observations and requires that original promise to
settle before close is retried; host disposal alone cannot certify release.
An owning `retain` hook can register the disposal capability before the final
opener guard. The native-set coordinator uses it so even an unknown close while
opening remains reachable for later disposal without releasing outer exclusion.
Root inspection/capture and source presence do not
complete aggregate backup/recovery or native host/account/device acceptance.
