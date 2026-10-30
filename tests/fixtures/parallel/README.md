# Parallel MCP fixtures — 2026-10-30

Documentation-only verification, no endpoint invocation or paid/live search. Primary sources:

- https://docs.parallel.ai/integrations/mcp/quickstart — unified endpoint, anonymous/default tools, authenticated tools, arguments, provider-issued session correlation and `_meta["parallel/usage"]`.
- https://docs.parallel.ai/integrations/mcp/programmatic-use — endpoint/auth distinction and anonymous versus authenticated discovery.
- https://docs.parallel.ai/api-reference/extract/extract — `results`, `excerpts`, `full_content`, errors/http status and response `session_id`.

Pinned document-derived input schemas: `src/s14/protocol/parallel-mcp.json`. `tools-anonymous.json` and `tools-authenticated.json` are scripted discovery fixtures. They are **not live captures**. Schema titles/descriptions are non-executable and ignored; structural changes fail closed. Exact live discovery serialization/conformance remains pending explicit opt-in evidence; a difference is reported as schema_changed rather than dynamically trusted.

The current unified docs list web_decisions for anonymous connections and add web_research with authentication. ADR 0047's two-tool selection is preserved by Jit's trusted allowlist, not by assuming the server advertises only two tools. Neither extra tool enters the model registry. The older Search MCP docs describe search.parallel.ai with model_name and caller-generated 100-character session_id; unified docs describe client_model and provider-returned session_id (1000 characters). This implementation follows the unified docs, omits session_id initially, then reuses the returned value for that conversation. No installation/native session identifier is sent or rotated to evade limits.

Search/fetch result fixtures are minimal protocol examples with invented public evidence. Cache timestamps are explicit fixture-only vendor reports; missing freshness and usage stay unknown. They prove deterministic protocol behavior, not service availability, retrieval quality, free-tier policy or current billing cost.
