---
status: selected for API16-01 implementation; integration and live acceptance remain separate
date: 2026-11-05
scope: API16-01; FR-04/06/10/14/15/17/19/24/31/32/35/37/38; NFR-02/05/06/07/10/11/12
---

# Shared protected client without a second backend

## Context and selected approach

The [S16 handoff](../design/S16-rakazo-experience.md) recommends a React Web client and shared client contracts for later native surfaces. Existing S15 JSON APIs expose a raw request projection for diagnostics and lack shared bootstrap/navigation and typed decision routes. Reusing the old HTML form adapter directly would couple client state to server-rendered fragments. Importing Rakazo's oRPC/auth/database runtime would introduce a second authority stack before any file workflow worked.

API16-01 therefore adds a small browser/native-safe Fetch client and a protected JSON adapter over existing S15 service operations. [s16-client/v1](../contracts/s16-client-v1.md) freezes the exact seam. Current stores, session authentication, standing policy, Schway engine, receipts, event metadata, guarded owner projections and exact action execution remain the owners. A React renderer can consume this seam without loading server code or choosing a second API framework. This does not make the old frontend or storage permanent constraints.

## Authority and continuity

Bootstrap reveals a current CSRF value only to the authenticated same-origin client; the transport keeps it out of returned UI state. Requests refuse redirects, use no-store and do not auto-retry. Every command revalidates current owner/CSRF after body streaming. Snapshot and request recovery reacquire the original owning service's publication/lineage guards. Progress events contain control metadata, never unguarded model deltas or a reconstructed success.

Typed decision retries originally deduplicated after adapting the command to text, which did not preserve the posted revision/hash in the command fingerprint. Store the full typed-command digest in the same existing CHAT transaction. A changed revision/hash under an old request identity now conflicts. Successful historical decisions remain replayable only against their retained exact action; unprovable retries refuse. This is additive JSON metadata, not a new ledger or schema conversion.

The client state reducer advances an ephemeral generation on target/session/revalidation changes and discards private content before replacement. Late responses from an older generation/target and older cursor are ignored. Authentication/revalidation failure withholds content and advances the fence. The renderer remains responsible for beginning each revalidation and discarding projections on sign-out; no client cache is authority.

## Deliberate limits and evidence

The first seam is headless: actual text/tool work, current progress, original-send recovery, stop and exact decisions. Capabilities explicitly withhold uploads, immutable artifacts and live steering. Queue acceptance while another run is active is not concurrent scheduling or a live interruption contract. File-bearing messages and artifact delivery belong to FILE16-01; React rendering follows the authored experience.

Deterministic composition tests use the real protected services and registered VM/effect tools with scripted transports. They prove bounded client contracts, actual tool evidence, one effect across response loss/restart/retry, held exact decisions, private-source withdrawal, stop and browser-consumer isolation. They do not prove new live subscription/host/device behavior. Runtime selection and existing S14/legacy/private state remain unchanged.
