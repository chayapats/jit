---
status: selected for BASE16-01; review and stack integration pending
date: 2026-11-05
scope: S16-AC21/22; NFR-07/10/14; ADR 0074 reuse procedure
---

# Checked upstream reuse and release notices

Extend the existing two Rakazo adaptations rather than introduce a source-fetching build, monorepo vendor or parallel approval system. `jit.upstream-provenance/v2` records immutable upstream commit/tree/archive identity, original source hashes, adapted destination hashes, exact runtime imports, reviewed dependency/lock identities, source/asset review and notice/license hashes. Keep only the two unmodified original files as inert audit data under the pinned commit, together with the existing license. Builds never fetch/execute upstream scripts.

The source/release validator checks closed bounded metadata, regular in-tree files, original/destination/license bytes, prominent modified-file notices, exact adapted imports, the package dependency/lock review and unlisted adaptation markers. A new dependency, source/pin, modified adaptation or notice needs an explicit inventory update in the same reviewed PR. These checks detect incomplete/drifted changes; they do not authenticate a malicious maintainer who edits code and review metadata consistently or detect unmarked plagiarism.

Run validation before package output creation and again on the copied release. Existing artifact content/dependency seals bind all inventory/source/notice files. Validation of v2 artifacts repeats the checks; historical v1/pre-S16 artifacts retain their prior content-seal behavior for rollback compatibility. New builds require v2. No runtime/store migration or installed release is changed.

The browser bundle also distributes the complete Jit/Rakazo/React notices and applicable license texts in a preserved comment. Its actual Bun build-input graph may contain only Jit source and reviewed React/React DOM/Scheduler packages, never the inert reference sources or a competing upstream runtime. This extends source/release attribution to the actual client bytes without adding a product control or another asset service.

The current adaptations import no nested Rakazo package, telemetry, asset, runtime or execution engine. Their UI/contract logic stays bound to Jit services and the authored S16 design. The current React runtime dependency/notice review is recorded; root Jit code remains MIT and Apache adaptations retain their terms. Source identity and license review are separate from authority, product parity and live acceptance. [The worked update/rollback contract](../contracts/s16-upstream-reuse-v2.md) specifies repeatable evidence and conformance.
