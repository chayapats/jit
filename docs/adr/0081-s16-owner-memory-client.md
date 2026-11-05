---
status: selected for MEM16-01 implementation; deterministic composition and browser evidence; live acceptance separate
date: 2026-11-05
scope: MEM16-01 (#416); S16-AC10; FR-04/05/16/17/31; NFR-07/08/09/12
---

# Owner memory search and lifecycle through the shared client

## Context

S15 MEM already owns sourced claims, exact-revision correction/forget, impact counts and conservative derivative retirement, and ADR 0078 carries file ancestry through it. The S16 client could only link to the server-rendered S15 page. #416 needs search/filter, inspection, correction and forget in the shared client, with private scope applied before ranking, and evidence that later work follows the owner's change.

## Options

1. Port Rakazo's memory UI and store. Rejected: it would add a second memory authority and a competing retention model.
2. Add a dedicated search index to MEM. Not needed at current bounds: the owner view is already loaded per request and lexical scoring is cheap; an index adds another withdrawal path to keep consistent.
3. Project the existing MEM owner view through the S16 client and reuse MEM commands unchanged. Selected.

## Decision

- `MemoryService.ownerIndex` returns the existing owner view plus per-claim usage counts and file-pin state. The S16 adapter (`src/s16/memory.ts`) filters, ranks and pages it. Commands go to `MemoryService.command` unchanged.
- Filtering order is fixed: state/kind/category, then the optional Bot scope check over the item and every transitive dependency, then relevance, then snippets. Without a Bot filter the owner sees all scopes, as on the S15 page.
- Erased text is never matched or excerpted. Non-active rows keep labels only.
- New derivatives record an optional creation time so "last used" is real; older rows report unknown. This is a JSON field inside the existing record, not a schema or format change; old readers ignore it.
- The capability field is additive and optional; the capability revision does not change.
- The client never retries a memory command; an unknown outcome is rechecked with the same identity, relying on MEM's command dedupe.
- The UI is the primary agent's authored design (the owner withdrew the design-subagent requirement on 2026-11-05), recorded in `docs/design/S16-memory-client.md`.

## Consequences

Search cost is linear in retained claims per request. That is acceptable for single-installation memory; a bounded index can replace it behind the same contract if measured load requires it. Usage counts include retired lineage and cannot claim recall of content already disclosed. No S14 default, S15 opt-in, policy, private-scope history or owner-host configuration changes. Model-route switching is not exercised here (MODEL16-01 owns it); memory does not depend on the route, and each request already uses fresh native sessions.
