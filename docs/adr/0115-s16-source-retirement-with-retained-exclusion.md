---
status: implemented source-retirement seam; forward activation remains incomplete
date: 2026-11-21
scope: OPS16-01; S16-AC21; FR-04/15/18/23/35/38; NFR-02/04/05/08/09/12
---

# Retire data handles without releasing maintenance exclusion

[ADR 0104](0104-s16-forward-recovery-and-retained-admission.md) requires current
control, never historical authority, as the forward recovery target. Activation
must close/checkpoint owning SQLite handles before replacing a data component,
while keeping the actual installation, CHAT and auxiliary controller process
locks. The existing all-at-once maintenance close cannot supply that boundary.
Releasing and reacquiring locks would allow a service/command to write between
validation and activation; retaining a lock filename alone is not exclusion.

Select an irreversible source-retirement phase on the existing genuine
maintenance contexts. `retireSources()` closes only original data connections;
`assertExclusion()` then verifies their original live process transactions and
private retained lock/root identities. The aggregate control context checks the
current configuration and original maintenance fence too. The old content,
capture and journal methods refuse after retirement begins. This capability
reports exclusion only: it does not assert that closed data is unchanged or that
a prepared target is current, compatible, verified or safe to activate.

Retirement is synchronous. Before starting, aggregate current guards and native/
helper resource release must pass. An open source transaction refuses before
retirement, preserving all original data handles and work already in progress.
Every data close must complete before any
process lease is released. An unknown close retains all original handles and
process exclusions; retrying the same retirement can finish their disposal.
Successful retirement is idempotent. Final `close()` releases the original
process leases without unlinking/recreating locks. Changed/missing lock identity,
configuration, manifest or original fence refuses; no replacement is guessed.

This is a protected internal lifecycle seam, with no client/model/CLI operation.
A forward activation coordinator must separately bind a durable original intent,
exact current SQL/native/byte cohort and hashes, compatible package, staged target
and per-component prior/target readback before replacement. Ordinary application
writes do not advance the operations revision, so revision equality cannot prove
current-cohort freshness. Missing current continuity cannot be replaced by older
archive grants, withdrawals, usage or unknown-effect rows.

Deterministic evidence must use actual composed/CLI state and independent
process attempts against the retained installation, CHAT and controller locks;
verify closed data handles, unchanged rows/bytes, no work/provider/helper calls,
unknown-close retry and lock/config/fence substitution refusal. Process death
releases OS locks, but the original durable operation fence remains the future
coordinator's recovery responsibility. This seam alone does not certify restore,
compatible upgrade/client lifecycle or owner-host acceptance.
