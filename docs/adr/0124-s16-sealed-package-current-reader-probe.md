---
status: implemented read-only probe; aggregate release lifecycle acceptance pending
date: 2026-11-21
scope: OPS16-01; S16-AC21; FR-04/15/18/23/35/38; NFR-02/04/05/08/09/12
---

# Probe the actual sealed package against current owning readers

The installer currently health-checks a login page and retains a historical
composition manifest for legacy fallback. Neither proves that a selected S16
package understands all current authority, usage, withdrawals, unknown effects,
disabled retained stores or the operations admission gate. Restoring an old
manifest to hide newly adopted stores cannot establish compatible S16 fallback.

Select a protected read-only package-reader probe as the first release-selection
primitive under [s16-package-current-readers/v1](../contracts/s16-package-current-readers-v1.md).
It does not change the executable selector, complete an operation,
clear a gate, initialize missing state, migrate a format, reconcile an effect or
certify a service/client lifecycle. It returns bounded digests of actual current
reader observations, separately from target package metadata.

Before loading target code, verify the complete root-owned immutable release
tree, runtime/dependency seal and independently supplied expected content hash.
Disposable fixtures may explicitly use the existing trusted-path test policy;
the command-line operator never accepts a weaker ownership policy. Reject
unsealed, changed, linked or writable trees before dynamic module loading.

Load the target package's actual configuration parser, control-maintenance
constructor, current fence reader and executing-package inspector. Do not infer
reader support from a caller-supplied list, source search or another package's
parser. Match the exact parsed configuration hash and require existing adopted
operations metadata. The target constructor must open every selected/retained
current store under its own genuine installation/CHAT/controller exclusion and
original pending operation fence, without application boot or credential reads.
An unavailable module, unsupported current format/configuration or invalid
current owner/binding refuses. The probe grants no compatibility exception.

Capture complete current SQL logical hashes and actual formats while holding the
target's genuine complete writer cut. Observe current FILE/GitHub payload and
external/native-namespace/helper custody through owning read-only methods. Hash
private inventories; do not export paths, credentials, messages or payloads.
Asynchronous helper checks run outside the SQL writer cut. Revalidate original
source/custody/package identities after observation. Native namespace metadata
is labelled metadata: it is not a deep native ancestry or physical VM proof.

Return a capability before opening current sources. Retain the exact original
target context/cut after any unknown release. The operator accepts an observation
only after conclusive same-capability disposal. Closing the reader process never
clears an original durable operations fence. Another package cannot structurally
forge its WeakMap capabilities or inherit the reader's process lease.

The simpler alternative of comparing declared schema arrays misses owning
feature/configuration/outer-store constraints. Loading an unverified source tree
would also detach the result from the release the installer intends to select.
Reuse the existing sealed artifacts, trusted paths and owning maintenance APIs;
do not introduce a parallel storage reader or native runtime.

## Remaining release-selection protocol

This primitive is necessary but insufficient for upgrade/fallback. A subsequent
coordinator must durably bind the exact original command, config, source/target
packages, current cohort and selector before any root-only atomic selector
effect. The original operations gate must hold ordinary writers between short
maintenance processes. Completion requires exact selector readback, current
reader/custody verification and conclusive release; an interrupted selection
resumes its original identity and plan.

A bounded first compatible path can require unchanged engine/dependency/native
contracts and actual current formats/configuration. Format or engine transitions
need their own forward migration contract. Failed service health can fall back
only after the previous package proves it reads **all current state**, including
legitimate facts written by the trial service. Preserve those facts in place;
never restore old SQL, manifests, native state or disks. Actual copied-package
service/client journeys and installer/supervisor interruption cases remain
required. Real Linux isolation and owner-host acceptance stay separately owned.
