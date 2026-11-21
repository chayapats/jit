# s16-native-root/v2

Status: protected native custody under [ADR 0105](../adr/0105-s16-native-set-and-management-custody.md).
The [v1 physical/public-native contract](s16-native-root-v1.md) still applies,
except for the explicit owning-custody selection below. V1 readers refuse v2.

An existing uniquely owned CHAT/MODEL/GitHub root can contain native identities
created before a saved execution correlation committed. Missing saved identities
still refuse. Additional identities remain management custody under the original
owning intent; inventory does not become an execution correlation or grant.

The closed envelope adds `referenceKind: current_custody`, `savedReferences`
and `custody` to the v1 fields. `custody` contains `kind`, original `ownerId`,
CHAT `phase` (otherwise null), and original GitHub `vm` custody (otherwise null).
VM custody contains `sessionId`, `vmId`, `workId`, `attemptId`, `state` and
`generation`. Stable owning identities must match the trusted current root;
historical VM state/generation remain inert and are never applied to current SQL.

`savedReferences` preserves the exact saved subset. `references` covers the
complete public inventory: saved identities retain their exact branch, other
identities use management `main`. Nondeleted references are copied through the
supported public snapshot API, including retired identities. Deleted identities
stay explicit without fabricated snapshots. Empty discovery is an observation,
not proof that an original unknown task completed or never ran. Successful
GitHub evidence requires an actual discovered native identity at the set layer.

Hash/public-shape checks and deep fresh quarantine remain distinct. No ordinary
export, live restore, session creation/open, task retry, model, native schema
parser or credential/profile copying is exposed. All v1 bounds, current guards
and conclusive asynchronous resource-release requirements remain unchanged.

The [native-set coordinator](s16-native-set-v1.md) uses v2 for protected custody.
Complete forward activation still requires the current complete cohort under
ADR 0104, current native tombstones and separate backend/helper/client custody.
