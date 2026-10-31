---
status: proposed
scope: S14-D07/D09; replaces ADR 0044's default-provider choice for the S14 store
---

# Parallel research with committed evidence and artifacts

## Confirmed direction

Parallel is the default search/fetch provider, free without a key first, with optional owner-enabled authenticated use. Research/report delivery is MVP. No paid escalation, provider fallback or quality claim is inferred from the selection.

## Proposed choice

Use a service-owned adapter to the current unified Parallel MCP endpoint, selecting only web_search and web_fetch. The documented endpoint is https://mcp.parallel.ai/mcp; older search.parallel.ai endpoints are legacy. The exact protocol/schema snapshot is a fixture dependency of the implementation, not dynamically trusted executable configuration.

The gateway holds endpoint policy, tool allowlist, outbound-context guard, cancellation/deadline, call/output limits, audit and optional connection release. No raw vendor MCP server is injected into the model registry. Anonymous mode is explicit. OAuth/API-key enablement and billing acknowledgement are revisioned owner configuration, with secrets kept in the service vault.

A remote server changing its advertised tools never grants them. Unknown schemas/capabilities fail closed. Tool results are bounded untrusted evidence; URLs, titles and excerpts do not become instructions or verified facts merely because the provider returned them.

Schway's supported SearchProvider can implement search. If MCP semantics need a richer adapter, Jit may register its trusted application tool through tools.definitions. Parallel Extract is not disguised as Schway's numeric-address-pinned HTTP transport: the vendor performs retrieval, so describe that distinct trust boundary accurately. Keep the existing direct fetch guard when a direct-fetch tool is explicitly selected; never claim it validates the vendor's remote DNS or private-network access.

Send only necessary public-search objectives/queries and public URLs, not the full conversation, private memory or attachments. Apply secret and outbound-release guards before dispatch. Credentials/internal addresses are refused. Use provider session correlation exactly as documented; never rotate identifiers to evade rate limits. Never expose a Schway session ID or installation identity.

Capture evidence with requested/final URL when reported, title, retrieval time, provider/mode, excerpts/content bounds, reported cache/freshness metadata and failure/coverage information. Missing metadata stays unknown. Citations bind to evidence revisions actually read; a search snippet is not labelled a full-page inspection.

A report revision records work/attempt, producing Bots, claims-to-source references, limitations and immutable artifact metadata (opaque ID, size, media type, hash, provenance). A bounded service artifact gateway accepts a snapshot from the Bot workspace and publishes only after validation and commit. Proposed initial export is Markdown plus a structured evidence manifest; safe HTML rendering is an implementation choice, not a requirement to execute untrusted HTML. Download authorization never accepts arbitrary host paths.

Failed/blocked/partial retrieval produces honest coverage and a next action. Rate limits do not trigger another vendor, browser workaround or paid identity automatically. A report may be partial; it cannot call missing evidence complete. Actual paid cost is shown only when supplied, otherwise usage is unknown.

## Alternatives and consequences

Keeping SearXNG as an automatic fallback would send queries through an unselected path and conceal the selected provider's failure. Optional future providers require explicit selection and the same gateway contract. Deep-research/decisions products are not enabled merely because the MCP server advertises them.

Parallel remains an external recipient even though execution and persistent state are local. Anonymous free service availability/limits are vendor policy, not an SLA. Compare real owner tasks before asserting better quality than existing providers.

## Evidence required

Anonymous and authenticated MCP fixtures; tool-list/schema changes; quota/network/cancel/output caps; unsafe/private outbound inputs; no hidden fallback; citation/evidence mismatch; artifact path/type/hash/size rejection; partial and stale-cache reports; source deletion cleanup; separate opt-in live usefulness. Requirements: FR-07/13/17/18/29/41/42; NFR-09/10.

## EVID14-01 quota refusal refinement

Persist only a validated Retry-After deadline with the read outcome. Stop the affected work's public reads after the first quota and fence pre-existing queued read lanes before spending a model admission; permit tool-free partial synthesis with the failed-read gap. Apply a known retry deadline to later work on the same configured identity. An unknown reset time stays unknown and requires a later explicit new-work probe, never identifier rotation or fallback. Installation-wide anonymous fencing is conservative and does not establish the vendor's actual quota scope/window.

Keep exact quote and source-identity validation strict. Better initial report instructions and the existing one charged tool-free correction can address malformed candidates; they cannot repair absent evidence or certify usefulness.
