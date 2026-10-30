---
status: accepted for opt-in implementation
scope: SHARE14-01; refines ADR 0046
---

# Bounded revision-bound snapshot copies

Keep the existing resource ceiling and ScopePolicy intersection. Non-secret configured slots become live policies only through an authenticated owner command selecting one receiver, immutable source/artifact, optional work and expiry. This slice does not add Bot capability editing or derive authority from a model. Production unions non-secret JIT_S14_RESOURCES slots with existing durable Bot resource ceilings. An empty union denies sharing; a slot alone grants neither source access nor a wider Bot ceiling.

Copy bounded bytes into SQLite through the common artifact validator rather than mount another Bot's workspace. Bound each copy to 32 KiB and aggregate native context to 64 KiB. Received copies retain original share lineage and cannot be forwarded. Revocation persists an independent identity tombstone before fencing contexts/results, including stale-image restores. Knowledge already disclosed cannot be recalled. These are implementation choices within S14-D03/06, not a new account, browser or external-effect capability.
