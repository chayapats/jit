# Parallel MCP fixtures — 2026-10-30

Original documentation sources (live structural discovery provenance is recorded below):

- https://docs.parallel.ai/integrations/mcp/quickstart — unified endpoint, anonymous/default tools, authenticated tools, arguments, provider-issued session correlation and `_meta["parallel/usage"]`.
- https://docs.parallel.ai/integrations/mcp/programmatic-use — endpoint/auth distinction and anonymous versus authenticated discovery.
- https://docs.parallel.ai/api-reference/extract/extract — `results`, `excerpts`, `full_content`, errors/http status and response `session_id`.

Pinned structural input schemas: `src/s14/protocol/parallel-mcp.json`. Anonymous read schemas were captured live on 2026-10-31. Authenticated read schemas were separately captured on 2026-10-31 after an owner-enabled key reached discovery but the documentation-derived pin refused before dispatch. Authenticated discovery requires `additionalProperties: false`, includes nullable `objective`/`search_queries` defaults of `null`, and does not advertise `urls.maxItems`. These structures are pinned independently; neither mode dynamically trusts discovery. Titles/descriptions are ignored, structural drift and unknown tool names still fail closed. The two other known tool names are catalog-only placeholders and never registered for execution.

Discovery captures prove schema conformance only. Search/fetch result fixtures below remain invented deterministic examples; successful authenticated live reads and account billing availability require separate opt-in evidence. No credentials or raw Authorization headers are retained here.

The current unified docs list web_decisions for anonymous connections and add web_research with authentication. ADR 0047's two-tool selection is preserved by Jit's trusted allowlist, not by assuming the server advertises only two tools. Neither extra tool enters the model registry. The older Search MCP docs describe search.parallel.ai with model_name and caller-generated 100-character session_id; unified docs describe client_model and provider-returned session_id (1000 characters). This implementation follows the unified docs, omits session_id initially, then reuses the returned value for that conversation. No installation/native session identifier is sent or rotated to evade limits.

Search/fetch result fixtures are minimal protocol examples with invented public evidence. Cache timestamps are explicit fixture-only vendor reports; missing freshness and usage stay unknown. They prove deterministic protocol behavior, not service availability, retrieval quality, free-tier policy or current billing cost.
