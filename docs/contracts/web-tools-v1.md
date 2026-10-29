# Jit web reads (WEB01, #173)

S12-D03/D04/D09/D13, S13-D07 and ADRs 0019, 0037 and 0040 govern this service-owned outbound-read boundary. Schway owns search/fetch implementation, address-pinned SSRF protection, redirects, timeouts and escaped `untrusted_data` framing. Jit imports only `schway/host`, requires `schway.host.web-tools/v1` at boot and preflight, and keeps hosted lookup off. Missing capability has next action `install-supported-schway-web-tools`.

## Selection and provider registry

`ApplicationRunRequest.tools` retains its empty-list contract. Reply and specialist admission separately freezes `web`, selected by the revisioned project switch (default on). Web reads are offered at Read, Workspace and Full without opening a box. Invocation and every call check current project settings; a later switch-off, halt, fenced attempt, retired context, owner-generation change or withdrawn context refuses calls and late results. Old requests without `web` select no web tools.

CTX01 reply admission captures that selection and its limits in the request stub. The first fenced attempt atomically assembles the packet, lineage and attempt snapshot; web tools and their private-context corpus use that exact frozen packet. Retries and explicit resumes reuse it with fresh attempt identities.

`web.settings.set` and `web.provider.set` are Web owner commands with revision checks, receipt replay and audit. `web_provider` stores only an installation provider id and optional `web_search_key` connection id. Trusted service code registers factories in `WebProviderRegistry`; only a selected factory receives its scoped vault value through an audited `web:<providerId>` release. Tool input cannot select providers. No model route/billing change is allowed. WEB03 permits only a visible Built-in fallback when an owner removes or empties a selected search key.

WEB02 #178 registers managed keyless SearXNG as the default (including legacy null selections). Both web tools remain offered when Podman is missing; search returns a clear unavailable result with a path to `/settings/web-search`. WEB03 #184 supplies provider selection/configuration UI. Neither a live provider call nor a key is required by deterministic tests. See [ops.searxng/v1](searxng-v1.md) and [ADR 0044](../adr/0044-managed-web-search.md).

## Guard, budgets and owner visibility

`src/security/outbound-guard.ts` compares 24 contiguous normalized Unicode code points from each private entry. Both sides are percent-decoded, NFC normalized, case folded, stripped of format characters and whitespace collapsed. The run corpus conservatively covers supplied source text, memory claims, constraints, pinned owner decisions and purpose. ATT04 #193 appends full sanitized attachment text through `WebToolsOptions.privateContext`.

Initial queries/URLs are checked before resolving a provider or reaching fetch DNS/transport. Fetch redirect URLs are checked by the tightening-only Schway `urlGuard`. The first match of a run creates one `outbound_release` card; a unique index prevents duplicate cards. Later matches return tool errors. The card shows the exact held query/URL and matched span, is Web-only, never auto-approved, expiring and single-use. The existing effect executor claims it once, checks the pinned context, owner and provider revision, executes that held call and posts escaped untrusted evidence to the topic. It never resumes the model run. Further private redirect destinations remain guarded.

Web calls consume a finite allowance reserved alongside model turns. The usage total counts web calls; rounds and retries continue to count model attempts. Schway still bounds every result; a run with less than the host's 1 KiB minimum output budget admits no web tool. Audit rows contain run/job/tool, exact bounded query/URL, status and output bytes, never page text. Redirects have metadata rows and do not consume another tool-call allowance. The owner's Details disclosure includes reply and specialist web calls. Temporary tool progress travels through the existing attempt-fenced preview mailbox.

Reservations separate model rounds from web calls and bound model turns by both budgets. With one retry, web-enabled specialist admission requires at least three calls and two rounds; two calls/two rounds is refused before any job is admitted. Approved releases record redirect destinations through the same audit path. Specialist Details bind every attempt's audit to the logical run through its job id.

## Evidence lifecycle and limits

Successful tool evidence is an `external` source linked to its run and job. Jit replies and specialist lineage include it even though it was acquired after the original manifest. Forget follows that lineage; delete reaches external evidence and descendants, retires affected contexts, clears web audit subjects and held-card copies, and clears web URL descriptors. Restore ledger replay applies the same cleanup. Provider copies remain outside Jit's reach under the existing lifecycle residuals.

Deletion and suppression cleanup collect all attempt run ids of every job that referenced the source, even when a retry only created a blocked release card and never produced successful web evidence. Restore replay applies the same card, receipt and audit redaction without requiring live context ids.

The guard is verbatim only: encoding outside its normalization, paraphrases, split spans below 24 characters, images and execution-box network channels retain ADR 0040's stated residuals. WEB01 does not expand the guard to browser, computer or MCP channels; ATT04 owns those integrations. Fetched evidence grants no roles, tasks, decisions, access or approvals.

Schema 42 adds settings, metadata audit and identity-only run-source links, rebuilds the connection/card kind CHECKs and classifies all new tables for credential-free backup. Deterministic tests use scripted models, providers and numeric-address fixture transports; no live web or provider calls are required.

Provider protocol references: [Tavily Search](https://docs.tavily.com/documentation/api-reference/endpoint/search) and [Exa Search](https://exa.ai/docs/reference/search). Adapters pin HTTPS endpoints, refuse redirects, send keys only in auth headers, cap response bodies at 256 KiB and honor cancellation within a 15-second deadline. No provider is selected or tested live implicitly. WEB03 should reuse WEB01's `web.provider.set`, `web_provider` and `web_search_key` rather than introducing duplicate settings or credential kinds.
