# Settings > Web search — app.web_search_settings/v1 (WEB03 #184)

This page reuses WEB01's schema 42 `web_provider`, `web.provider.set` and
`web_search_key`. It does not add `web_search.set`, `web_search_settings` or
another connection kind. Schema 43 adds only nullable `web_tool_calls.fallback`
(`key_missing`), preserving every connection and existing settings revision.

`Application.webSearch(actor)` returns the WEB01 setting (`id`, `connectionId`,
`revision`) plus metadata-only `effectiveId` and `fallback`. No row/legacy null
means Built-in (`searxng`, null, revision 0). The original selected vendor and
revision are retained when a key disappears. Selection of Tavily/Exa requires a
live `web_search_key` with `secret: set`. Built-in cannot reference a key.
`web.provider.set` remains the revisioned, receipted, audited Web-only command;
Telegram/local API return `web_settings_requires_web`. Unknown trusted registered
provider ids remain supported by WEB01, but the settings form permits only the
three product providers. No model-facing settings writer is introduced.

## Web and JSON

- `GET /settings/web-search` renders status without starting a container, pulling
  an image or querying an engine. `tested=ok|failed` is the only query field.
  Both dictionaries state that SearXNG sends queries to outside engines from this
  machine's IP, without an account/key. HTML works without JavaScript.
- `POST /settings/web-search` accepts only `csrf`, `requestId`,
  `expectedRevision`, `provider`, optional `apiKey`. One form creates a global
  labelled Tavily/Exa connection, stores the key and selects its reference using
  derived receipt ids (`-create`, `-secret`, original selection id). Secrets
  never enter the setting, identity, receipt, audit or response. Request ids are
  limited to 110 characters to leave room for connection receipt suffixes.
  An empty key reuses the newest active global labelled key for that vendor.
  Built-in ignores the key field and preserves any previous connections.
- `POST /settings/web-search/test` checks `expectedRevision`, then uses the
  selected adapter for one `jit connectivity check` query, limit 1, with a
  ten-second abort deadline. Only this explicit action contacts the provider.
  Result redirects to `?tested=ok|failed`.
- Replace/Remove reuse `/settings/connections/:id/{secret|remove}`. The fixed
  `returnTo=web-search` field redirects back; arbitrary return targets are refused.
- `GET/POST /api/settings/web-search` use the same authority and form fields
  (POST also accepts JSON). Both return `{ webSearch: ... }` metadata; POST returns
  the receipt setting and GET adds effective selection/fallback. Keys are write-only.

All writes require an authenticated owner session, same Origin and CSRF. Extra
fields are `invalid_body`; malformed test queries `invalid_query`; missing key
`web_search_key_missing` (409); malformed key `invalid_connection_secret` (400);
malformed setting `invalid_web_search` (400). Inline failures never echo a key.
Stale form revisions redirect to the current page, JSON refuses with 409.
A failed multi-step save can leave an unused connection visible in Connections.

## Resolution and fallback

Credentials are released at call time through `releaseConnection(..., web:<id>)`.
Removed, empty or missing files select **only Built-in** and set
`fallback: key_missing` on each actual run read, including approved releases.
The page and chat Details disclose this fallback. Unsafe permissions, scope
refusals, vault failures or provider failures refuse; they never select another
vendor. The ten-second explicit Test query is public fixed text and has no run
or private context; it does not consume a run's web allowance.

Fresh installer homes prepare `state.connections` (0700) beside `state`, outside
state/backup/box paths. Without execution config, the supervised unit supplies
that path through the existing `JIT_EXECUTION_SECRETS_DIR` and writable-path list;
startup opens the same existing vault class. Explicit execution vault config
continues to take precedence. A development service defaults to the sibling
`<database parent>.connections`. Existing custom operator layouts must allow the
service identity to create that private directory before enabling a key provider.
No owner key is put in a box or SearXNG.
