# Owner role configuration, v1

Owner: Jit #8 (TEAM01). `app.role_configuration/v1` implements FR-02/10/13/14/17 and NFR-01/02/03/07/10. Downstream eligibility requires this tested artifact in the integration base. See ADR0011; TEAM01 does not establish live provider support.

`src/team/types.ts`, `configuration.ts` and `Application` define the supported application boundary. `Role` has a stable UUID, ordered identity, revision, specialist/coordinator kind, name, responsibility, enabled flag and optional atomic route. Disabling keeps identity/history; saving creates no run/task and grants no tools. Optional tech/design/marketing presets only prefill a new form, never save or invoke automatically.

`RoleRoute` contains exactly `provider: grok | codex`, exact `model` ID and an opaque `authRoute` alias. These are references, never credentials. No real model or account is selected by default. Model IDs and aliases are bounded; aliases accept lowercase letters/digits/dot/underscore/hyphen and must begin with a letter. Credentials belong to the later supported host adapter, outside prompts/app settings/logs/exports.

Precedence selects one complete route: project-role override > project default > owner-role route > owner default. Fields are never mixed. Clearing a layer explicitly inherits the next layer. `Application.team(actor, projectId?)` returns effective values, their layer, owner/project/role revisions and next action. Missing/disabled is blocked; configured is unverified with `connect_and_verify_public_host_adapter`, regardless of whether any token exists. Queries are offline and bounded by the role ceiling; they never probe a provider.

Owner mutations use `Application.execute(actor, TeamCommand)` and the same opaque actor validation, single SQLite writer, global request-ID receipts and audit as APP01/02. Replay returns the original acknowledgment before checking now-stale config revisions; a changed payload with the same request ID conflicts. State + receipt + audit roll back together. A model-produced object is ordinary text, with no command authority.

| Command | Scope and revision |
| --- | --- |
| role.save | Null project, expected owner team revision. Payload: roleId null to create or existing UUID to edit, name, kind, responsibility, enabled, route (or null). Increments owner and role revisions. |
| route.save | Null project + null role updates owner default under expected owner revision. Project + null role updates project default; project + role updates its override under expected project team revision. Null route clears this layer. |
| role.preview | Exact project, expected project aggregate revision, role/topic UUIDs, purpose, source-reference array and positive finite JobLimits. This separate command explicitly authorizes a single fixture invocation; no live route call. |

The preview transaction captures route/responsibility, all setting revisions, exact sources, authorization generation, independent managed context, job and run before acknowledgment. Later setting edits cannot redirect it. Source/current generation, owner generation, job attempt/deadline, cancellation and context retirement are checked before invocation and before attributed publication. The trusted producer commits output source + participant message + retained outcome in one app transaction, independently of the subsequent queue terminal acknowledgment. A crash after app publication cannot duplicate it on recovery; JOB02 owns general native reconciliation. No cross-store or exactly-once provider claim is made.

`Application.preview(actor, projectId, runId)` returns the retained immutable request/outcome/source and current projected job. A complete fixture is marked in output/history and has a participant role/run identity. An unsuccessful scripted model outcome remains blocked/incomplete/error, produces no successful history message and never changes route. A succeeded queue step means it recorded a fixture outcome, including a blocked outcome; the result page discloses that distinction. Admission failures/deadlines may leave no model outcome; the projected job reason remains visible. No automatic fallback or retry exists.

| HTTP | Behavior |
| --- | --- |
| GET /[api/]team | Owner role/default configuration; optional HTML preset only prefills. |
| GET /[api/]projects/PROJECT/team | Scoped effective settings, bounded topics and explicit fixture start forms. |
| POST /[api/]team/roles | Role save fields above plus requestId, expectedRevision. |
| POST /[api/]team/routes, /[api/]projects/PROJECT/team/routes | Nullable roleId and whole route, receipt/revision fields. |
| POST /[api/]projects/PROJECT/team/previews | Role/topic/purpose/sources/limits + receipt/revision fields. |
| GET /[api/]projects/PROJECT/team/previews/RUN | Retained fixture evidence and exact captured route/config/context. |

JSON uses a route object; HTML forms use provider/model/authRoute. Route picker (#167): the forms offer a provider choice, show the recommended model, and render no alias field. `completeRoute` (`src/team/route-options.ts`) fills an empty or absent `model` with the operator's service-config model for that provider (`AppConfig.routeModels`), or else the built-in default (`builtInModels`, restating Schway's documented route fallbacks). It fills an empty or absent `authRoute` with the provider, because Schway binds one credential per route. Stored routes and the JSON shape are unchanged; a legacy alias is shown and kept until the owner saves the form again. A future account model list depends on schway#432. Empty provider explicitly clears the whole route; empty role ID means null. HTML encodes sources/limits as JSON strings. All POSTs require owner session, exact Origin and CSRF, reject unknown fields and return JSON receipts or stable303 redirects. HTML escapes every user/model value. Role preview is omitted from generic job choices; its dedicated command creates the matching run/context.

Finite development defaults:24 retained roles,2048 responsibility bytes,8 source/claim entries,32768 total request bytes. JIT_ROLE_LIMIT, JIT_ROLE_BYTES, JIT_PREVIEW_SOURCES, JIT_PREVIEW_CONTEXT_BYTES configure them under hard ceilings; these are not measured pilot capacity. JOB01 additionally bounds queues, concurrency, calls/rounds/hops/retries, output and wall time. Scripted invocation reserves a finite context text estimate and maximum output before starting; no real model token accuracy is claimed. Admission uses jit-fixture/scripted/internal, distinct from the requested production route. Generic shell/write/edit/network, hosted lookup and repository discovery remain disabled.

Schema4 snapshots older stores privately before migration and retains owner/project/conversation/source/job/receipt identities. It adds team settings, roles, managed fixture contexts and retained runs. Tests cover frozen published v3 migration, Web/reload, exact routes, rollback, untrusted sources, normalized failures, late publication and managed lifecycle without paid inference/network credentials.
