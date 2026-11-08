# s16-connections/v1

CONN16-01 (#417), MCP16-01 (#418) and OPEN16-01 (#419). Decision record: [ADR 0089](../adr/0089-s16-connections-and-tool-sources.md). Exported TSDoc in `src/s16/connections/` (`types.ts`, `service.ts`, `runtime.ts`, `mcp.ts`, `oauth.ts`, `openapi.ts`, `graphql.ts`, `catalog.ts`, `schema.ts`, `net.ts`, `disclosure.ts`, `tools.ts`), `src/s15/policy/service.ts` (`sameForWork`, `resourceBoundAdapters`), `src/s15/policy/defaults.ts` (`connected_sources`) and `src/s15/composition.ts` (`connectionMembership`) is the executable contract; this page summarizes it.

## Selection

- Runtime config `s15-runtime/v1` field `connections: boolean` (absent: off; `true` requires `disclosure`). The generated S15 installer config sets `true`.
- Composition option `connections: { vault, network? }` adds the additive store `connections.sqlite`. `network` (`allowHttp`, `resolve`, `connect`) is a deterministic test seam only; the public-address rule is not a seam.
- Off means: no connection routes, no `propose_connection` tool and `capabilities.connections = { available: false, code: "connections_unavailable" }`; GitHub stays on `/resources/github`.

## Protected state (`connections.sqlite`, application id `0x4a494337`)

| Table | Meaning |
| --- | --- |
| `sources(id PK, record_json)` | `s16-source/v1` records. States `authorizing`, `needs_review`, `active`, `reconnect_required`, `unavailable`, `removed` (terminal). |
| `flows(id PK, state_hash UNIQUE, record_json)` | OAuth flows `pending` → `received` → `exchanging` → `complete` / `failed`; only the newest flow of a source can complete. |
| `requests(id PK, record_json)` | Chat connection cards (`open`, `done`, `dismissed`). At most 64 open. |
| `commands(id PK, payload_hash, result_json)` | Owner command idempotency; the hash binds a secret's or document's digest. A stored OAuth receipt omits the sign-in URL. |

Vault keys (installation-scoped aliases): `source_<id>` holds a bearer/header secret or the OAuth token set; `source_flow_<flow>` holds a flow's state, PKCE verifier, client secret and, after the callback, the code.

Bounds: 32 sources, 128 tools per source (16 list pages), documents and responses 1 MiB, results and arguments 64 KiB, schemas 32 KiB and depth 12, descriptions 1024 characters, request 30 s, call 120 s, OAuth flow 10 minutes, GraphQL depth 12 and 256 fields, 512 OpenAPI references.

## Identities

For a source `src_<k>` (24 hex from the adding request): resource `src_<k>`, DATA15 recipient `srcr_<k>`, DATA15 private source `srcs_<k>` (always resolvable, never declassified) and catalog fence `srcc_<k>` (kind `input`, revision = review revision). Resource and recipient are active while the source is reviewed and not removed; the fence is active only while the review covers the current catalog and the source is `active`.

## Owner API

- `GET /api/s16/client/connections` → `s16-client-connections/v1`: `github` (`state`, `login`, expiry, accessible/selected repositories, `policy`), `sources` (`SourceView`: state, code, auth kind/header/issuer, catalog and reviewed hashes, `changed`, tools with `hint`, `suggested`, `allowed`, `decision` and request summary, skipped entries, Bots and whether each may use it, `policy`), open chat `requests`, `limits`, `oauthRedirect`. Never a secret, token, code or session identity.
- `POST /api/s16/client/connections/commands` (`s16-connection-command/v1`) → `s16-connection-receipt/v1` (`source`, `github`, `authorize` for OAuth, `policy`: `installed` / `unchanged` / `review_required`).

| Command | Effect |
| --- | --- |
| `source.add` | `sourceKind`, `label`, `endpoint` (empty for an OpenAPI document's own server), `auth` (`none`, `bearer {secret}`, `header {name, secret}`, `oauth`), `document` (OpenAPI/GraphQL), `origin` (chat card). Stores the secret write-only, then discovers; OAuth returns `authorize`. |
| `source.review` | `catalogHash` and a decision for every tool (`read`, `change`, `approval`, `off`; a mutation never `read`). Installs the membership revision. |
| `source.refresh` / `source.document` | Rediscover / replace the document; a new catalog hash means `needs_review`. |
| `source.reconnect` | New auth; ends the source's sessions; rediscovers or begins OAuth. |
| `source.oauth_begin` / `source.oauth_complete` | New sign-in URL / one-time code exchange, then discovery. |
| `source.remove` | Identities inactive at once, vault value deleted, sessions ended, membership revision. |
| `github.connect` / `github.select` / `github.remove` | GIT15-04 connection; selection and removal install the membership revision. |
| `request.dismiss` | Hide a chat card. |

- `GET /s16/connections/oauth/callback?state&code|error` (no session): single-use state; 303 to `/s16/connections#oauth=<sourceId>` or `#oauth_error=source_oauth_stale`.
- `bot.update` (`s16-bot-command/v1`) may carry `excluded` (exact team resource IDs) — additive.

## Work surface

- Tool names `<label>_<4 hex>__<tool>`; *reads only* tools in every mode, others only in execute mode. Arguments are validated against the reviewed schema subset.
- Reads: `s16-source-read/v1` payload `{ source, tool, catalog, review, arguments }` on the source resource with the catalog fence.
- Calls: adapter `s16_source` v1, operation `source_call`, payload `s16-source-call/v1` `{ source, label, kind, endpoint, tool, title, request, decision, catalog, review, arguments }`; classes `ordinary_edit` (`change`) or `major_change` (`approval`); resources `[resource]`, recipients `[recipient]`, fence `srcc`; slot from source, tool and arguments; held cards approvable for at most one day. Evidence `s16-source-result/v1` (`outcome`, `code`, bounded redacted `content`).
- `propose_connection` `{ kind, endpoint?, label? }` → an inert card; no secrets or query strings.

## Standing rules

- Default proposal: each reviewed, non-removed source is a resource of kind `source` in the rule `connected_sources` (`ordinary`, purposes = work, the policy's Bots and selections, adapter `s16_source`, operation `source_call`, the source recipients). Other rules never name sources.
- Membership revision: installed only when the installed rules equal the default proposal after removing connection membership (`gh_*`, `src*_*`, `github_service`, rules `github_after_checks` and `connected_sources`, adapter `s15_github` and its operations) and ignoring expiry; the installed lifetime and budget are kept. TEAM registers the new resources in team scope for all Bots.
- POLICY keeps a running work current across revisions that differ only in other Bots or in resources/recipients it does not name (rules left without its resources are dropped when all their adapters are resource-bound: `s16_source`).

## Evidence

Deterministic suites `tests/s16-connections-import.test.ts` (importers, schemas, network refusals, MCP client) and `tests/s16-connections.test.ts` (composition: review, sessions, held calls, drift, unknown outcomes, revocation, OAuth, OpenAPI/GraphQL, GitHub, two Bots and exclusions), and the real-bundle `tests/s16-connections.browser.test.ts` (English desktop, Thai mobile; `JIT_S16_BROWSER_TESTS=1`). Live services and accounts: #431.
