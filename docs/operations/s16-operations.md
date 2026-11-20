# Selected S16 operations

Status: OPS16-01 implementation in progress in
[#429](https://github.com/chayapats/jit/issues/429). The available operator
commands below adopt/inspect protected operations metadata. Aggregate
backup/export/restore/upgrade/uninstall is not yet available through this entry.
Existing S14/legacy commands and S15 installation paths keep their contracts.

Run from the verified selected source package, with its pinned Bun and explicit
credential-free S15 configuration:

```sh
bun run s16:ops status --s15 --config /absolute/s15-runtime.json
bun run s16:ops adopt --s15 --config /absolute/s15-runtime.json --request-id original_adoption_id
```

`status` is read-only and may share an installation lease with the running
selected service. It reports `not_adopted`, `adoption_pending`, `maintenance_pending` or `adopted`,
current revision/retained point count and bounded active-operation metadata.
It does not report application/VM health, native settlement or backup coverage.
Its observation-only lease cannot pass writable-owner admission. Nonterminal
current operations refuse normal selected execution even if their physical
maintenance fence is lost. Never remove a gate or edit current metadata to
force admission; owning reconciliation must retain the original request.

`adopt` requires the selected service/local commands to release their shared
installation leases. It then validates all existing selected/retained runtime
and outer current-control state, holds installation/CHAT exclusion, retains an
original durable owner admission fence, creates the current metadata journal,
publishes its independently bound v2 receipt and clears only the verified
original initialization fence. It does not initialize missing application
state, change installed policy, replace credentials or operate a computer.

Retry an interrupted adoption with the same configuration and request ID.
The original operations identity/time is retained, including response loss
after successful clearance. A conflicting request/configuration refuses.
Missing/corrupt adopted control refuses before normal owner/vault access;
re-running adoption does not reconstruct it empty. Keep the current journal,
receipt, retained lease and original fence together for protected recovery.
They are excluded from historical points and ordinary exports.

Contracts: [aggregate forward recovery](../contracts/s16-recovery-point-v1.md),
[initial operations control](../contracts/s16-operations-control-v1.md),
[current journal writes](../contracts/s16-operations-control-v2.md),
[v2 installation binding](../contracts/s16-installation-lease-v2.md) and
[current-control maintenance](../contracts/s16-control-maintenance-v1.md).
These metadata operations do not complete aggregate acceptance or owner-host
cutover; the remaining coordinator must cover full owning custody, ordinary
export, retention, quarantine/activation and compatible release selection.

## Copied-package adoption drill

The [deterministic package drill](../../ops/evidence/s16-operations-adoption.ts)
builds/seals the actual copied-source package, installs its locked production
dependencies without install scripts, checks package/dependency pins and runs
the shipped `s16:ops` command against disposable state. It checks an exact
v1-aware source build before/after adoption, unchanged current owner/vault
bytes on refusal, continued new-CLI operation and retained shipped notices.
The old Git object must be available locally; the drill does not fetch it.
Dependency installation needs registry access or the installer's cache.

```sh
bun ops/evidence/s16-operations-adoption.ts --old-commit d0c4c39f581994d5c10253110b6f5083c7777991 --receipt /absolute/private/fresh-receipt.json
bun ops/evidence/s16-operations-adoption.ts --old-commit 1229c3c77c65fac900fb974dbfef4660541d00d9 --receipt /absolute/private/fresh-journal-receipt.json --profile journal
bun ops/evidence/s16-operations-adoption.ts --old-commit 1229c3c77c65fac900fb974dbfef4660541d00d9 --receipt /absolute/private/fresh-native-receipt.json --profile native
```

The journal profile uses a v2-lease-aware, v1-control-only source as its
positive control. It works after adoption, then refuses after the first v2
journal write even with a simulated lost fence. The current package refuses
pending execution, reads bounded status, restores only the original gate and
settles the same disposable request without replay. Owner/lifecycle/vault bytes
stay unchanged across refused commands and journal operations. This is a
protected library drill; no incomplete backup/export command is exposed.

The native profile also exercises the packaged
[`s16-native-root/v1`](../contracts/s16-native-root-v1.md) component through the
pinned public host. Disposable active/retired/deleted sessions, an actual busy
owner, opaque data larger than command JSON limits and independent hash refusal
are checked. The actual owning capability also checks explicitly empty native
namespace without initialization. Fresh public native quarantine validates
actual ancestry/retirement and preserves original native bytes. The only model
is scripted locally; no provider/account call runs. It certifies components on
the reported platform, not populated aggregate recovery, native clients or
owner-host acceptance. Populated namespace tests use actual composed CHAT/MODEL
work; GitHub VM fixtures retain discovery requirements and original uncertainty.

This checks metadata adoption/admission on the reported platform/architecture.
The old revision is a v1-aware admission profile, not a certificate that all
earlier packages support fallback. Actual aggregate recovery, native/account/
device acceptance and compatible package selection remain separate evidence.
