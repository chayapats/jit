# S14 foundation HTTP handoff

## Current Plain presentation refinement (2026-11-02)

The owner-approved Plain replacement supersedes the historical Home dashboard and primary-navigation layout below. After setup, `/` renders a Jit conversation; a validated browser preference selects the last visited Jit conversation. `/work` is the cross-Bot attention/progress/results destination, while `/more` groups knowledge, team/work and installation management. All existing feature routes and typed commands remain available. The old S14 renderer and a UI feature flag are not retained. The default-runtime selection is governed by ADR 0061, superseding older opt-in language in this document.

Authenticated message/work-start landings include `receipt=<requestId>`. A chat query re-reads that exact durable receipt and checks its command kind and conversation before exposing `data-committed` for local-draft cleanup; URL text alone cannot acknowledge a submission. The browser stores only composer text locally for 30 days, never authority selections or revisions. See [ADR 0062](../adr/0062-s14-browser-navigation-and-drafts.md) and the [Plain experience](../design/S14-plain-experience.md). No schema, command envelope, CSP or external-effect contract changes participate.

Current combined logic schema: **17**; earlier unreleased 1–16 refuse with `s14_fresh_state_required` before workers. Earlier slice schema numbers below describe their introduction. All commands remain opt-in behind `--s14`.

## BOX14-01 computer/input seam

Contracts: [app.bot-computer/v1](app.bot-computer-v1.md), [app.input-lease/v1](app.input-lease-v1.md); schema 17 combines result-state evidence, computer storage/activity, memory, Parallel, graphs, reports and owner review; earlier unreleased schemas 1–16 refuse with fresh-state. Existing setup/chat/work/approval transport remains intact. All additions stay behind `--s14`. Computer product layout and forms are in design section 18.

Durable `computer.open`, `computer.stop`, `computer.reset`, `computer.delete`, `takeover.start`, `takeover.end` use the existing JSON/form `/commands` endpoints and exact typed payloads in those contracts. Receipts describe committed intent, while queries describe settled runtime state. UI must fetch current computer and lease revisions before each command. Reset/delete scope is both named workspace and protected profile; exact IDs/generation/revision are mandatory. Do not add a second work-start approval.

| Endpoint | Result / use |
| --- | --- |
| `GET /api/s14/bots/:botId/computer` | `{computer,lease}`; both null before lazy provisioning; no runtime start on reads |
| `GET /api/s14/bots/:botId/computer/image` | owner-only PNG, <=2 MiB, private/no-store; no image bytes enter ordinary state/prompts |
| `GET /api/s14/bots/:botId/computer/events` | one bounded same-origin SSE `event: state` with the query JSON, then close; client may reconnect |
| `POST /api/s14/bots/:botId/computer/input` | transient `OwnerInputCommand` JSON, normal session/Origin/Host/`X-CSRF-Token`; returns `{requestId,state:'succeeded'|'unknown'}` |
| `POST /s14/bots/:botId/computer/input` | URL-encoded no-script fields below; 303 to the safe input outcome query, or to `/team/:botId?tab=computer&input=:requestId#screen` when the product handler is wired |
| `GET /api/s14/computer-inputs/:requestId` | `{requestId,computerId,state}` only; no text/HMAC or re-dispatch |

No-script common fields are exactly `csrf,requestId,expectedRevision,computerId,generation,leaseRevision,kind`. Numbers are unsigned decimal strings; `botId` comes from the route. For `kind=click`, `<input type="image" name="point">` adds `point.x,point.y` (0–1279/0–799). `kind=text` adds only `text`; `kind=key` adds only `key`. Text/key bounds and the supported key list are in app.input-lease/v1. Duplicate/extra fields refuse. The UI agent may add its own authenticated product redirect under `src/s14/` without weakening the handler. Input goes directly to the protected browser, never to `/commands`, messages, durable forms/receipts, runner or prompts. An unknown outcome must never trigger auto-resubmit; use a fresh conscious owner action. Stale revisions require a fresh query, not automatic overwrite.

States for Opus mapping: absent (null), starting/running/stopping/stopped/resetting/deleting/deleted/unavailable; lease actor null/agent/owner, finite expiry, revision/generation. Startup/revoke/reset/idle/restart fence input. Agent calls already dispatched must settle before owner input; takeover end never approves a held effect. Reasons include `computer_runtime_not_configured`, `computer_capacity`, `computer_startup_timeout`, `computer_idle`, `computer_authority_revoked`, `restart_fenced_no_replay`, `stale_revision`, `stale_lease`, `input_lease_fenced`, `computer_scope_changed`, and diagnostic codes in the runbook. Display honest unavailable/unknown states and safe repair guidance.

Runtime configuration adds non-secret `JIT_S14_COMPUTER_ROOT`, pinned `JIT_BOX_IMAGE_BASE`/`JIT_BOX_IMAGE_BROWSER`; rootless local Podman and dedicated bounded filesystems are required. No configuration proves live readiness. The root advertises installation tools `computer`, `web_search` and `web_fetch`, but Bot/work ceilings must still explicitly select them. Setup visibly pre-ticks only `web_search` and `web_fetch`; its authenticated owner submission grants only those selected public reads, with no computer, resource or external-effect capability added. The backend supports local report work, owner view/takeover and agent scroll only. Both computer components have no direct internet. Public reads use only separately granted service-owned Parallel tools. There is no private website login, agent browser text/image/session extraction, generic browser submit, arbitrary JS/CDP or MCP. Do not render those as working actions. See the [opt-in Linux runbook](../runbooks/s14-bot-computer.md); both host evidences and all UI acceptance remain pending.

UI integration: use `app.computers.view/screenshot/ownerInput/inputReceipt` and the routes above; extend `S14Page`/authenticated routing/renderer under `src/s14/` as needed. Keep legacy UI/runtime, current CSP and same-origin authentication intact. Public runtime/lease data types are all in `src/s14/computer-types.ts`; do not infer authority from display text, a model reply, lease metadata or a screenshot.

Logic-only foundation for #246/#247. UI authoring stays with Claude Opus 5.5 at high effort and `docs/design/S14-bot-first-experience.md`. Import `createS14Handler` from `src/s14/web.ts`; inject `S14Renderer(page:S14Page):string` or extend its authenticated page routing under `src/s14/`. `S14Page` includes `state:Home`, `work:Work[]`, `csrf` and locale. `src/s14/main.ts` owns the opt-in composition. Keep `src/web.ts`/legacy runtime intact. The no-style JSON/form page remains the default contract exerciser; the product UI is wired in `src/s14/main.ts`. No framework, CSP exception or inline script is needed.

If `serve` is running, stop it before setup; setup and serve take the same exclusive runtime lock. The trusted installer issues the one-time S14 owner capability; password entry then happens on `/owner/setup`. Local `setup --s14 --password-stdin` remains an optional development path. Run `bun src/main.ts serve --s14` for the opt-in runtime. The default is a fresh `.local/s14/application.sqlite`, loopback `http://localhost:3001`; overrides are `JIT_S14_DATABASE`, `JIT_S14_ORIGIN` and optional exact non-secret route override `JIT_S14_ROUTES`. Default route metadata comes from supported providers and recommended models; credentials remain in Schway's protected owner store. There is no live readiness/sign-in/host-capacity claim from this environment setting. Without `--s14` the previous runtime remains unchanged. An incompatible selected store refuses with `s14_fresh_state_required` and a fresh separate-path next action before writing or workers.

HTTP commands share one endpoint. First sign in through `GET/POST /s14/login` with a URL-encoded password; session cookies are HttpOnly/SameSite=Strict (`jit_s14` on HTTP, `__Host-jit_s14` on HTTPS handler deployments). Read `GET /api/s14/home` for `{state,csrf}`. Send command JSON to `POST /api/s14/commands` with exact same Origin, cookie and `X-CSRF-Token: csrf`. The body is always `{kind,requestId,expectedRevision,payload}`; **never send an actor/ownerId**. Generate one opaque retry key per logical action and retain it across transport retries. Reusing it for changed input fails. On stale revision, refresh the relevant query before owner review of new data.

No-script: `POST /s14/commands` with URL-encoded `csrf` and `command=JSON.stringify(theSameCommand)`. It redirects 303 to `/s14/receipts/:requestId`. All commands below use the same form path, with exact revision fields carried inside command JSON. UI can translate its own normal fields into these typed payloads on the server rather than ask owners to write JSON. Duplicate form keys/extra body keys refuse. No state-changing GET exists; all authenticated data is private/no-store and HTML must escape untrusted content. Authority controls must come from typed cards, never rendered model/source markup.

| Command kind | Payload | Revision source |
| --- | --- | --- |
| `setup` | `{ownerName,language:'th'\|'en',routeId,capabilities:{tools:[],resources:[]}}` | `state.revision` before setup |
| `message.post` | `{conversationId,text}` | conversation.revision |
| `bot.proposal.accept` | `{proposalId,capabilities:{tools:string[],resources:string[]}}` | current proposal.revision |
| `bot.proposal.reject` | `{proposalId}` | current proposal.revision |
| `bot.proposal.revise` | `{proposalId,name,responsibility,routeId}` | current proposal.revision |
| `task.accept` | `{taskId}` | proposed Work.revision |
| `work.start` | `StartPayload` in [work contract](app.work-grants-v1.md) | conversation.revision plus task revision when starting a retained task |
| `approval.decide` | `{effectId,actionHash,decision:'approve'\|'deny'}` | effect.revision |
| `work.stop` | `{workId}` | Work.revision |

Example direct internal start (all IDs/revisions/budgets are owner selections, not production defaults):

```json
{
  "kind": "work.start", "requestId": "unique_owner_retry_key", "expectedRevision": 1,
  "payload": {
    "conversationId": "from_query", "task": null,
    "title": "Compare facts", "purpose": "Compare the supplied public facts", "completionRule": "Evidence for owner review",
    "bots": [{"id":"jit","revision":1}], "tools": [], "scopes": [],
    "limits": {"attempts":1,"steps":1,"calls":1,"outputBytes":8192,"wallMs":60000},
    "expiresAt": 1800000060000
  }
}
```

The example timestamp must be replaced with a future timestamp within wallMs. This example grants tool-free analysis. Explicit `computer` grants can now perform bounded local report work through BOX14-01; resource/share policies, public research/site adapters, routines, production effects and native safe replay remain later slices. A task proposal accepted alone never starts; the work-mode composer directly sends `work.start` without another confirmation. Plain `message.post` and @Bot addressing never grant execution.

| Query | Result |
| --- | --- |
| `GET /api/s14/home` | `{state:Home,csrf}`: owner/language, configured routes, Bots, conversations, typed Bot proposals and chat replies |
| `GET /api/s14/conversations/:id` | conversation/messages/proposals/replies |
| `GET /api/s14/bot-proposals/:id` | current proposal and content/author revision history |
| `GET /api/s14/work` | `{items:Work[]}` including proposed/accepted obligations |
| `GET /api/s14/work/:id` | WorkView: work, immutable grant/exact command, revocation, reservations, `actualUsage:null`, attempts, effects, `results` |
| `GET /api/s14/effects/:id` | current exact effect card and action revision history |
| `GET /api/s14/receipts/:requestId` | original committed receipt; no execution/replay |

## Product Web routes

`src/s14/main.ts` wires `createS14Handler(app, origin, renderS14, createS14Product(app))`. Without the fourth argument the handler stays the no-style contract exerciser and every API above is unchanged. All surfaces are server-rendered, `private, no-store`, CSP-strict and work without script.

| Route | Surface |
| --- | --- |
| `GET /s14/login`, `POST /s14/login`, `POST /s14/logout` | Sign-in, session end. An unauthenticated page GET redirects to sign-in; an API GET stays 401 JSON. |
| `GET /` | Setup until an owner profile exists, then Home |
| `GET /chats/:id` | Conversation. `?work=:id&tab=progress\|report\|evidence\|grant` opens the work pane, and `&report=:id` selects a report revision; `?start=:messageId` prefills the composer. |
| `GET /work`, `/work/:id?tab=`, `/team`, `/team/:id`, `/proposals/:id`, `/effects/:id`, `/more` | Work list, work, team, Bot, exact proposal, exact approval card, account |
| `GET /memory?scope=<botId>\|shared&q=` | Memory browse: one tab per Bot plus owner-published claims. `?receipt=` rereads a committed receipt for the landing banner. |
| `GET /memory/:botId/claims/:id?revision=&generation=&action=correct\|forget\|delete\|publish\|revoke\|share` | Exact claim page. `action` opens a read-only preview; the command after it holds the authority. |
| `GET /memory/:botId/sources/:id` | One retained source, or the explanation that its text is gone |
| `GET /settings/web` | Optional Parallel settings; public research never needs this page |
| `GET /settings/work` | Future-work defaults and read-only installation ceilings. `?receipt=` rereads a committed defaults receipt for the landing banner. |
| `GET /team/:id?tab=computer` | Bot computer. `&confirm=reset\|delete` opens the consequence card; `&input=:requestId` shows one input outcome. `/work/:id?tab=computer` lists the grant's Bots and links here. |
| `GET /work/:id?tab=report&report=:id` | Report tab: the selected revision, or the latest. An unknown `report` opens the latest. |
| `GET /s14/artifacts/:id/download` | Authenticated attachment link used by the file rows |
| `GET /assets/*` | Public hashed static assets |

Fixed-content decisions (`task.accept`, `work.stop`, `approval.decide`, `bot.proposal.reject`) post the seam's `POST /s14/commands` with the exact envelope in a hidden field; `GET /s14/receipts/:id` then redirects to the surface instead of returning JSON. Computer lifecycle and lease commands use this same path and return to the Bot computer tab. Owner-typed forms post flat fields to `POST /s14/forms/{setup,compose,task-start,proposal-accept,proposal-revise}`, which build the same typed command and call the same `S14Application.execute`. The translator decides nothing: unknown fields are refused, `work=on` is the only thing that selects `work.start`, and revisions come from the rendered form. Each capability, tool and Bot is its own field (`tool:<id>`, `resource:<id>`, `bot:<id>=<revision>`) so the handler's duplicate-key refusal stands. A retried `work.start` form reuses its committed `expiresAt`, so the same retry key stays the same command.

Memory and Parallel forms follow the same rule through `POST /s14/forms/{memory-remember,memory-correct,memory-forget,memory-delete,memory-publish,memory-revoke,memory-share,memory-decision,parallel-key,parallel-enable}`. `src/s14/web-product-memory.ts` translates them and refuses unknown fields. Every memory form carries `botId` only to choose the landing page; authority comes from the typed command. `memory-share` takes `target=<botId>:<scopeId>` and `hours` from 1 to 24; a retried form reuses the committed expiry. `parallel-key` carries the write-only secret, and a refused post rerenders settings without it. `web.parallel.key.remove` and the explicit return to anonymous mode are fixed envelopes through `POST /s14/commands`. `S14Product.surface` now also receives the form fields.

Team forms follow the same rule. `POST /s14/forms/work-defaults` takes `concurrent,minutes,reads` and builds `work.defaults.set`; `src/s14/web-product-team.ts` refuses unknown fields. `work.step.stop` is a fixed envelope through `POST /s14/commands` and lands on `/work/:id`. `compose` and `task-start` also accept an optional `evidence` textarea, one target per line, which becomes `requiredEvidence`; an empty box omits the field. A blank limit field takes the stored defaults. `S14Overview` now carries `defaults`, per-work `lanes` and latest-report `reports` hints; none of them prove authority. See section 19 of the experience document.

Work detail and chat-pane navigation show Computer only when the grant contains `computer`. An old `?tab=computer` link for other work selects and renders Progress. Conversation messages retain revoked reply text with `contextState:'withdrawn'` and the existing withdrawn label; those messages are excluded from automatic context. Web settings show each enabled Bot's actual public-read tool subset, including a single selected web tool.

HTML responses use `Referrer-Policy: same-origin`. With `no-referrer` a browser sends `Origin: null` on the page's own form posts, which the exact Origin check refuses.

`serve --s14` serves a read-only explanation page after the refusal by default (`--refusal-page` remains accepted). The refusal, its stderr JSON and exit status are unchanged, and no store, lock or worker opens. `serve --s14 --no-refusal-page` retains CLI refuse-and-exit.

Typed states to map onto the existing Opus design:

- Bot proposal: proposed/accepted/rejected; old content revisions are stale; author bot/owner and proposerBotId are service-derived; rejected route is null, capability extras have safe dropped codes.
- Chat: queued/running/succeeded/blocked, plus safe reason. Replies increment conversation revision, so refresh before another mutation.
- Work: proposed/accepted/queued/running/waiting/ready/blocked/stopping/stopped. Ready is owner review, not a complete-report assertion. Start receipt pins exact command/grant. Stop remains stopping while real calls are open.
- Approval: pending/approved/denied/expired/executing/succeeded/failed/unknown; changed is retained in revision history. Show exact action, destination/content/hash/revision/expiry/requester, `supported` and reason. Unknown never offers a retry through this seam.
- Usage: reservations are finite, actual usage is unknown; no invented zero, concurrency measurement, provider readiness, research coverage or delivered effect.

All core types have one-line TSDoc in `src/s14/types.ts`, `authority-types.ts`, `application.ts` and `web.ts`. Product rendering, Thai/English copy and form contracts are covered by `tests/s14-web-ui.test.ts`; real device and assistive-technology evidence remains open. Follow existing external hashed assets and tokens when wiring the Opus design; the unstyled baseline is not a styling precedent.

Combined contract refinement (schema **6**, retained in final schema **17**): `Work.result` retains a bounded latest-attempt ID; `WorkView.results` supplies separately stored result bodies and original ready/waiting state. JSON detail queries and existing Web result rendering retain full granted output through 1 MiB; command receipts never copy that body. Earlier unreleased schemas 1–16 refuse rather than auto-migrate. The visible work badges refresh with their result regions, retaining the existing design.

## MEM14-01 logic seam

`app.memory-scope/v2` and `app.context-provenance/v2` add the following commands to the **same** authenticated JSON/form ingress. `MemoryRef` is exactly `{id,revision,generation}`. Mutations return `MemoryReceipt` with references, access/share revisions and withdrawn count; they do not echo forgotten payload.

| Kind | Payload | expectedRevision |
| --- | --- | --- |
| `memory.remember` | `{conversationId,text}` | conversation.revision |
| `memory.correct` | `{claim:MemoryRef,text}` | claim.revision |
| `memory.forget`, `memory.delete` | `{claim:MemoryRef}` | claim.revision |
| `memory.publish`, `memory.revoke` | `{claim:MemoryRef}` | MemoryAccess.revision |
| `memory.share` | `{claim:MemoryRef,scopeId,receiverBotId,expiresAt}` | MemoryAccess.revision |
| `memory.decision.set` | `{conversationId,key,text}` | current decision.revision, or 0 for new key |

| Query | Result |
| --- | --- |
| `GET /api/s14/memory/:botId?q=...` | `{claims:MemoryLookup[],decisions:MemoryDecision[],sources:MemorySource[],withdrawals:MemoryWithdrawal[]}`; no inference or outbound call. `withdrawals` labels only the returned identities and carries no payload |
| `GET /api/s14/memory/:botId/claims/:id?revision=1&generation=1` | `{claim:MemoryLookup,history:MemoryAccess[],shares:MemoryShare[]}`; history and shares are empty for an unavailable claim |
| `GET /api/s14/memory-impact/:id?revision=1&generation=1` | `MemoryImpact`: exact affected claims/sources/context IDs and native policy |
| `GET /api/s14/memory-contexts/:id` | `MemoryPacket`; retired state withholds claim/decision text |

Existing Opus memory/share flows consume these projections. States: available/unavailable with safe reason; fact/inference; private/shared with owner publication revision/history; current/retired packet; source text null after deletion. Forget preserves the owner-readable original but prevents automatic use. Correct creates a new private claim. Preview is read-only; the subsequent command is exact-revision authenticated owner authority. The Opus UI pass delivers these flows in `src/s14/web-memory.ts`; see section 17 of the experience document. Native policy is `fresh_sessions_retire_on_close`, not a claim of external erasure. Schema3 requires a fresh separate application path plus its independent current lifecycle ledger; see the memory contract.

## WEB14-01 logic seam

`app.parallel-web/v1` and `app.external-evidence/v2` use the same `POST /api/s14/commands` and `POST /s14/commands` session/Origin/CSRF boundary. Actor never comes from the client. Native public research is available only in explicit bounded `work.start` with tools selected from `web_search`, `web_fetch` and the Bot ceiling. Tool-free message.post still grants no research execution. Keep the existing finite limits explicit; max call budget includes initial/later inference and tools. Concurrency now uses app.work-graph/v1 with the pinned, conformance-tested shared host lifecycle.

| Kind | Payload | expectedRevision |
| --- | --- | --- |
| `web.parallel.key.set` | `{secret}`; write-only, optional | 0 for a new connection; receipt returns metadata only |
| `web.parallel.configure` | `{mode:'anonymous',connectionId:null,billingAcknowledged:false}` or `{mode:'authenticated',connectionId,billingAcknowledged:true}` | current setting.revision |
| `web.parallel.key.remove` | `{connectionId}` | connection.revision |

Key storage alone does not enable billing. Key removal never switches an authenticated setting to anonymous. Retain requestId across retries; a key command retry returns the original receipt and never exports/hashes its secret. The anonymous default works without visiting key configuration. Settings/query state is configured_unverified, not live readiness. Optional vault default is a sibling s14-vault outside the application directory; `JIT_S14_VAULT_DIRECTORY` overrides it under collision/permission checks.

| Query | Result |
| --- | --- |
| `GET /api/s14/parallel` | `{setting:ParallelSetting,connections:ParallelConnection[],readiness:'configured_unverified',keyState:'not_required'|'present'|'missing'|'unsafe'}` |
| `GET /api/s14/work/:id/evidence` | `{reads:WebRead[],evidence:ExternalEvidence[]}`; bounded queries/URLs with dispatched flag, outcome, reported usage or null, source timestamps and coverage |

Map existing Opus web/evidence/rate/quota/settings states from `WebOutcome`: running/success/partial/quota/schema_changed/service_error/blocked/private_context/credential_refused/cancelled/deadline/oversize/authority_changed/key_unavailable. Never present missing usage as zero, unknown freshness as fresh, a snippet/excerpt as a whole-page read or a missing page as success. Reported cached timestamps remain visible. Key fields are optional, write-only, never prefilled or included in exports. No automatic fallback/retry action is implied by a failure. Malicious source text is escaped data and cannot produce authority controls.

`ExternalEvidence` source IDs/revisions are the citation seam; `app.parallel.citation(tx,attemptId,id,revision)` is the trusted later report handler's validation port. Free-form foundation work output is ready for owner review, not a certified complete report/artifact. Packet source references append evidence actually read, and lifecycle changes fence subsequent tools and final output. Native executor is `schwayResearch` in src/s14/research.ts; UI agent owns rendering/routes/assets and can use the existing renderer/service projections. Do not replace the command/authority boundary.

Final store is schema **17**, combining the reviewed foundation result table with computer, memory and Parallel tables; earlier unreleased schemas 1–16 require a fresh separate path, preserving original data. The current independent lifecycle ledger must accompany this installation and remain current across application-image restore. MEM14-01/WEB14-01 UI evidence is recorded in section 17 of the experience document and `tests/s14-web-memory.test.ts`. Protocol fixtures are documentation-derived (2026-10-30), with live exact serialization/conformance and live quality explicitly pending.

## TEAM14-01 logic seam

Schema **17** refuses earlier unreleased schemas 1–16 with fresh-state. `app.work-graph/v1` adds `concurrency` and `reads` as required explicit `WorkLimits` fields. Defaults are owner-confirmed **2 / 1800000 ms / 40 reads**; query current defaults rather than assuming fixture counts. Call reservations include inference as well as tools; actual usage remains null.

| Command | Exact payload | expectedRevision |
| --- | --- | --- |
| `work.step.stop` | `{workId,stepId}` | current lane revision |
| `work.defaults.set` | `{concurrency,wallMs,reads}` | defaults revision |

Both use the existing authenticated JSON/form command envelope and receipts. `work.step.stop` returns `{kind,requestId,step,conversationId}` with the originating conversation resolved by the service; the receipt landing route returns to its work pane. Work stop remains `work.stop`; stopping one lane grants no replacement execution. Future default edits do not mutate current grants.

| Query | Result |
| --- | --- |
| `GET /api/s14/work/:id/graph` | `GraphView {graph,steps,active,concurrency,limits,actualUsage:null}` |
| `GET /api/s14/work-defaults` | `WorkDefaults {id:'work',revision,concurrency,wallMs,reads}` |

Lane states are queued, waiting_evidence, running, stopping, committed, failed, cancelled, blocked. `queuedAt` records when independent work is committed or a dependent lane becomes runnable; `waitingAt` records entry into the dependency wait. Both are retained on later states. `startedAt`/`settledAt` are actual transport observations; null means no observed interval. Queued `queueCeiling:'global'|'work'|'route'|'bot'|'computer'|null` is the current first held ceiling in that order, using the same reservations/leases as admission. Work is the grant concurrency ceiling. Committed owner ingress wakes one existing drain, so free capacity is used before unrelated transports settle. Render timeline only from these observations. `dependency_uncommitted`, `partial_graph_evidence`, `handoff_not_accessible`, `native_reconciliation_required` and safe handler failures stay explicit. Ready means review evidence; report coverage remains a separate field in REPORT14-01. Core query/command types are `graph-types.ts`. Pages, form controls and state copy are in `src/s14/web-team.ts`.

## REPORT14-01 logic seam

The final combined store is schema **17**; unreleased schemas 1–16 refuse with the same fresh separate-path action. Contracts: `app.report-artifacts/v1`, `app.artifact-gateway/v1`. There is no report-publish owner endpoint: reports/files are outputs of an already-authorized live attempt, validated and committed by its trusted result handler.

`work.start` optionally accepts `requiredEvidence:EvidenceRequirement[]` (`report-types.ts`). Targets are exactly `{id,label,url:string|null,coverage:'snippet'|'excerpt'|'full_content_returned',freshness:'any'|'live_reported'}`. They are captured owner requirements, not model-created authority. An omitted/empty list leaves completion-rule coverage machine-unverified. Existing typed starts remain valid.

| Query | Result |
| --- | --- |
| `GET /api/s14/work/:id/report-review` | `ReportReview {workId,revision,reportId,reportRevision,completion,acceptance}`; latest target and exact review revision |
| `GET /api/s14/work/:id/reports` | `ReportView[]`, immutable revision order; no query/fetch/execution |
| `GET /api/s14/reports/:id` | `{state:'available',report,artifacts,completion,acceptance}` or `{state:'unavailable',id,workId,revision,reason:'lineage_withdrawn'}` |
| `GET /[api/]s14/artifacts/:id/download` | Authenticated private no-store attachment bytes; opaque ID only |
| Existing `GET /api/s14/memory-impact/:id?...` | Now also `reports:{id,workId,revision}[]` and `artifacts:string[]` for exact descendant preview |

Render immutable `Report.state:'ready_for_review'` and `Report.coverage:'partial'|'covered'` separately from live `ReportView.completion:'owner_review_required'|'owner_accepted'` and `ReportView.acceptance`. Completion is no longer a property of immutable Report. An empty report history means no committed report, even if ordinary WorkResult text says done. Coverage, `covered`, typed service `missing:ReportGap[]`, untrusted `modelMissing:string[]` and `limitations` stay prominent. Only the typed discriminants select service wording. A model string resembling a real code/target/read/claim ID remains untrusted model text in the existing frame. Markdown/JSON exports also separate the fields. Claim `support:'supported'|'unsupported'`, kind quote/inference and flags snippet/excerpt/cached_reported/freshness_unknown/conflicting/unsupported are trusted projections, not badges inferred from prose. Citation `id/revision/attemptId/quote/scope` binds to the exact evidence in the projection. Failed sibling, partial read, missing target and bounded-handoff omissions remain explicit.

Owner review command:

| Command | Exact payload | expectedRevision |
| --- | --- | --- |
| `report.review.accept` | `{reportId,reportRevision}` | `ReportReview.revision` from the work's report-review query |

The common authenticated JSON/form boundary returns `{kind,requestId,conversationId,review}` and a durable audit/receipt. A retry returns the same historical receipt; changed input with that key refuses. Refresh the query after `stale_revision`; only the latest available exact report can be accepted. `report_unavailable` refuses withdrawn lineage and `report_already_accepted` refuses a second fresh acceptance. Acceptance is a separate owner fact and never changes partial coverage, immutable report/file bytes, Work state or execution grants. Any new report revision, forgotten/deleted/corrected/revoked lineage or owner-generation change invalidates acceptance and increments the review revision. Valid acceptance survives restart; current-ledger reconciliation prevents withdrawn acceptance after stale-image restore. The Report tab renders this control in `src/s14/web-report.ts` as a fixed `command,csrf` envelope through `POST /s14/commands`, only for the current review target, using the server's `app.reports.review` projection (the same read as the query above) for `expectedRevision`. A refused post returns to `/work/:id?tab=report`. See section 19 of the experience document.

File metadata includes opaque ID/name/mediaType/size/sha256/producer/source/time. Use the supplied download route; never construct host or Bot paths. Show unavailable revisions without payload. Treat every report/claim/source string as escaped data; no raw HTML/Markdown execution in the app origin. The Opus UI pass delivers these flows in `src/s14/web-team.ts` and `web-report.ts`; see section 19 of the experience document for what was and was not tested.

Exact integration files: `graph-types.ts`, `report-types.ts`, `graph.ts`, `reports.ts`, `artifacts.ts`, `authority-types.ts`; shared JSON and fixed-envelope form commands continue through `S14Application.execute` with session/Origin/CSRF/revision/retry checks. UI tests must not treat a file's existence, model prose, a ready WorkResult, unknown usage, unknown freshness or covered evidence targets as owner completion.

## UX14-01 logic handoff (#265)

Requirements remain FR-01/19/22/23/25, NFR-11/12, S14-AC01/13; this section supersedes earlier setup, schema, refusal and missing-command descriptions. UI/UX and UI acceptance belong to the subsequent Claude Opus 5.5 high-effort pass. No UI acceptance box is completed by logic tests.

First-owner bootstrap reuses `issueOwnerSetupLink(store,origin,now?)` from `src/ops/owner-setup.ts`, now accepting the minimal `OwnerSetupStore` interface implemented by `S14Store` as well as the legacy store. The trusted installer issues this link against the **selected S14 store**, privately captures it and displays it once; it must not issue it against a legacy store or put it in ordinary logs. Password entry thereafter is entirely Web-based. The opt-in S14 runtime remains separate from the legacy installer/service default; default service cutover is not part of this PR. No public unauthenticated endpoint issues a capability.

`GET /owner/setup?token=…` checks the unchanged 256-bit/15-minute/0600 hash-file capability, moves it into the HttpOnly/SameSite=Strict setup cookie, and redirects to clean `/owner/setup`. Redirects/errors use no-referrer; the clean page uses same-origin. `POST /owner/setup` has exactly URL-encoded `{csrf,password,confirm}`, exact Origin/Host and capability-bound CSRF, matching 12–256-character passwords. `completeOwnerSetup` rechecks under the final writer lock, creates one Argon2id owner, clears old sessions/throttle, removes the hash file best-effort and logs in normally. Owner existence is the single-use fence; the capability is never an owner session. GET, invalid/rotated/expired/replayed links, bad Origin/CSRF and concurrent password hashes grant nothing.

`createS14Handler` adds optional fifth argument `S14AuthRenderer` in `src/s14/web.ts`: `ownerSetup?(csrf,locale):string` and `signIn?(receipt,csrf,revision,locale):string`. The first defaults to the existing legacy password form. The second receives ephemeral approval data only on the first POST; without it the contract handler returns JSON. The UI agent supplies the Opus-authored setup/sign-in pages and safe no-script refresh/cancel links, using the seams below. It must not put approval data into redirect URLs, GET pages, receipts, drafts, logs or model context.

`S14SignIns` in `src/s14/sign-in.ts` wraps the existing `DeviceSignIns`/`beginDeviceSignIn` flow. All start/cancel ingress is Web-only through the existing session/Origin/Host/CSRF handler. Durable reservation, revision increment, audit and safe receipt commit **before** protocol dispatch. Every credential commit checks the live initiating session. The manager's 5-second local reads, 30-second host start, earlier provider/10-minute flow expiry, cancellation/cleanup and shutdown guards are unchanged. Unknown pending flows after restart project cancelled; terminal receipts survive. Only `{kind,requestId,provider,signIn:{id,expiresAt,state}}` is durable. Initial response may additionally contain `approval:{userCode,verificationUri}` once. GET/replay never contains it. States are starting/pending/busy/ready/expired/denied/cancelled/provider-error/store-error/cleanup-required; readiness configured-unverified means credentials, not a verified inference call.

| Command | Exact payload | expectedRevision |
| --- | --- | --- |
| `setup.sign_in` | `{provider:'codex'\|'grok',flowId:null}` | home.revision |
| `setup.sign_in.cancel` | `{provider,flowId}` | home.revision; flow must belong to that provider's start receipt |
| `task.reject` | `{taskId}` | proposed Work.revision |
| `conversation.create` | `{botId}` | current enabled Bot.revision |
| `owner.preferences.set` | `{language:'th'\|'en',theme:'system'\|'light'\|'dark'}` | home.revision |
| `memory.decision.unpin` | `{decision:MemoryRef}` | current pinned decision.revision; full ref must match |
| `work.retry`, `work.summarize` | `{workId}` | current Work.revision |
| `takeover.renew` | `{botId,computerId,generation,leaseRevision}` | current computer.revision and exact leaseRevision |

Every command uses `{kind,requestId,expectedRevision,payload}` and the same `/api/s14/commands` or no-script `/s14/commands` `{csrf,command}` ingress. Device commands call async `app.signIns.execute` only from that validated Web boundary; coding repository grants call async `app.coding.execute`, and other commands call `app.execute`. Keep the same retry key for transport retries. New keys with stale revisions refuse. Changed envelopes under an existing key conflict. Device receipts can advance only their safe flow state; approval never becomes durable. Other receipts retain their original snapshot.

Default exact provider routes come from `supportedS14Routes()` over public `schway/host.authRoutes`, with the existing recommended-model logic (`codex` → `gpt-6.1-sol`). IDs equal provider names. The owner chooses a provider; no model ID/auth alias is required. `setup` still carries internal `routeId`; the UI translator uses the chosen provider's returned route ID. `JIT_S14_ROUTES` is an optional explicit deployment override, never required and never selected after a failure. Local readiness is queried separately and does not change route/model/account/billing or make inference calls.

| Query | Result / use |
| --- | --- |
| `GET /api/s14/providers` | `{providers:[{id,provider,model,readiness}],revision}`; local protected-store readiness only |
| `GET /[api/]s14/sign-in/:provider/:flowId` | safe `SignInView`, cancelled after restart if a pending flow has no live handle; non-API path invokes `S14AuthRenderer.signIn` with no approval |
| `GET /api/s14/decisions/:id` | exact retained `MemoryDecision`, including `pinned:false` tombstone/revision after unpin |
| `GET /api/s14/scopes?botId=` | `{items:[{label,scope:ScopePolicy}]}`; at most 64 existing live memory shares already in that receiver Bot's ceiling |
| `GET /api/s14/bots/:botId/computer-work` | `{items:[{id,title,revision,expiresAt}]}`; at most 100 work grants currently allowing that Bot/computer; no runtime start |
| `GET /api/s14/bots/:botId/computer/activity` | `{items:ComputerActivity[]}`; newest 20 events by default |
| Existing computer state/SSE query | optional `page:{url:'about:blank',title:null,untrusted:true}\|null`; only observed safe offline identity, unavailable until observed |
| Existing memory impact query | adds `names:{bots:[{id,name}],work:[{id,title}],omittedBots,omittedWork}`; at most 100 names of each kind, resolved by the service independently of the UI's context window |

Task rejection retains `state:'rejected'` in history with no source-use requirement, grant, queue or run. Conversation creation makes an empty conversation for an enabled Bot; membership grants nothing. Preferences store the owner language and theme (setup defaults to system); the UI must apply them, and subsequent fresh inference reads the selected language. Unpin retains a revisioned `pinned:false` tombstone and original source, excludes it from future pinned context, fences old packets and prevents stale revision-zero recreation. A later explicit set of the same key requires the tombstone's current revision.

F14 recovery accepts only blocked/waiting/ready work with its original live unrevoked grant, unchanged owner/Bots/routes/scopes, settled transports, no pending/approved/executing/unknown effects and remaining attempts/steps/calls/output/time. It never refunds or extends a budget, changes a route or retries an effect. `work.retry` queues the same bounded internal purpose under a new attempt; it does not restart an old native session. `work.summarize` queues a tool-free attempt using at most 16 current external source snapshots owned by the original grant's first Bot (10 KiB selection, at most 16 KiB complete input), retaining exact source refs in the memory packet. It discloses selected/missing coverage; new reads, computer tools and effects are refused at admission. Existing evidence/history stays retained. Withdrawn evidence between command and dispatch blocks the synthesis. Missing evidence, exhausted budget, expired/revoked authority or unknown native/effect outcome requires an unblock action, not automatic retry. Structured cross-Bot report/citation aggregation remains #251/#252; this is a bounded foundation result, not a complete report claim. The scheduler integration seam is `Work.recovery` plus `recoveryInput/recoverySources` in `src/s14/work-recovery.ts`; the default drainer uses a retry-specific request key and the mode's narrower tools.

`takeover.renew` requires running live computer authority and owner lease metadata (including an expired owner lease if the computer has not stopped). It increments both revisions, fences old inputs and renews/restarts owner input in one action for the lesser of idleMs and original grant expiry. It neither resurrects a stopped process nor restores agent ownership or approves an effect. Refresh queries after a stale revision/lease. Computer query eligibility is advisory; `computer.open` repeats all authority checks.

Computer activity adds only observed categories: first safely observed page opened per generation, successful screenshot, completed service-observed agent scroll, and system stops at idle/revocation/restart/work handoff. Existing receipts/input outcomes/attempt bindings remain. New records carry only computer ID/generation/category/time, retain at most 200 per computer and expose no text, coordinates, image or raw runtime errors. Arbitrary browser titles/URLs are withheld because they can contain typed secrets; only an observed `about:blank` is exposed, with no title, as untrusted text. No unobserved Bot screen action is invented.

Production restores the union of existing enabled Bots' explicit resource ceilings using `existingResourceCeilings(tx)` plus configured `JIT_S14_RESOURCES` slots, and preserves current memory-share queries through `scopeOptions`. These ceilings create no source access or share grant. SHARE14-01 below supplies the separate revision-bound source/artifact snapshot gateway and current share policy; its explicit commands and queries coexist with first-run commands. A fresh installation has no source access before owner grant; built-in slot candidates can be selected through the exact capability revision flow below.

Combined schema **17** retains bounded `computer_activity` and its index together with all team graph, report and review tables; first-run commands otherwise use existing revisioned JSON/receipt records. Schemas 1–16 remain unreleased and refuse before writable open, with original database/WAL/SHM/ledger/profile/backup bytes untouched. `serve --s14` now serves the read-only refusal page by default with no store, runtime lock or workers; `--no-refusal-page` retains CLI refuse-and-exit. `--refusal-page` remains a compatibility spelling. No default legacy-runtime cutover or migration is performed.

Evidence: `tests/s14-first-run.test.ts`, existing bootstrap/device/S14 suites, frozen install, typecheck and full suite. No live provider, subscription, paid inference, Linux container or real browser/device acceptance is claimed.

### UX14-01 Web wiring

`src/s14/main.ts` passes `createS14Auth(app)` from `src/s14/web-first-run.ts` as the fifth handler argument. `S14AuthRenderer` gains two optional presentation members: `ownerSetup` takes a safe refusal code for the fixable `owner_setup_password_mismatch` and `password_length_12_to_256` refusals, and `ownerSetupRefused(code, locale)` replaces the JSON refusal with a page that has no form. Capability, CSRF and Origin checks are unchanged, and the handler without these members behaves as before. `S14Product.view` and `recover` may return a promise because provider readiness reads the protected store. They stay local and make no inference.

| Route / form | Use |
| --- | --- |
| `GET /` with no owner profile | Provider step until a provider is signed in, then the name form. `?provider=` selects among signed-in providers; `?change` returns to the list. |
| `POST /s14/commands` with `setup.sign_in` or `setup.sign_in.cancel` | Renders the sign-in page directly. Approval appears only in that first response. |
| `GET /s14/sign-in/:provider/:flowId` | Safe state page. Script reads `/api/s14/sign-in/:provider/:flowId` and posts nothing. |
| `GET /settings/provider` | Readiness and sign-in again. It has no route control. |
| `GET /chats/:id?redo=:workId` | Prefills the composer from that work's purpose with work mode on. It starts nothing. |
| `POST /s14/forms/new-chat` | `{csrf,requestId,expectedRevision,botId}` to `conversation.create`, with expected revision `Bot.revision`. |
| `POST /s14/forms/preferences` | `{csrf,requestId,expectedRevision,language,theme}` to `owner.preferences.set`, landing on `/more?receipt=:id`. |
| `POST /s14/forms/memory-unpin` | `{csrf,requestId,expectedRevision,botId,decisionId,revision,generation}` to `memory.decision.unpin`. |

`task.reject`, `work.retry`, `work.summarize` and `takeover.renew` are fixed envelopes through `POST /s14/commands`. UI evidence and its limits are in section 20 of the experience document and `tests/s14-first-run-ui.test.ts`.

Known gaps for later slices: nothing issues the one-time link for an opt-in `serve --s14` store, so a fresh journey needs the S14 installer cutover or a trusted caller of `issueOwnerSetupLink`; the memory query omits unpinned decisions, so the page cannot list them; chats have no title; a busy sign-in does not reveal the other flow's ID; `reply_unavailable` does not say why a model failed.
### UX14-01 remaining-gap integration (2026-10-31)

**Trusted bootstrap issuer.** On a fresh store, foreground `bun src/main.ts serve --s14` issues the existing 256-bit, 15-minute, single-use setup capability only when both stdin and stdout are interactive TTYs. It writes the link directly to that terminal once after the listener starts, outside the JSON logger. Redirected/non-TTY stdout, service/journald output and non-interactive stdin receive no link and do not rotate/create a capability. An existing owner always prevents issuance. The only durable capability material remains the legacy helper's 0600 SHA-256/expiry sibling file; tokens never enter application records, receipts, ordinary logs or plaintext files.

**CUT14-01 (#267) installer call.** After selecting the separate S14 store and verifying service health, execute the following trusted local CLI **as the service identity**, with a dedicated inherited private pipe at fd 3:

```text
<trusted-bun> <trusted-release>/src/main.ts owner-link --s14 --output-fd 3
```

Set the non-secret `JIT_S14_DATABASE` to the exact service S14 database path and `JIT_S14_ORIGIN` to its configured browser origin (HTTP/HTTPS, no credentials/query/fragment/path). The helper uses the store's writer transaction and can run while `serve` owns the runtime lock; it creates no application, inference host, worker, computer, vault or runtime lock. It refuses legacy/unknown formats before writable opens. A missing fresh store may be initialized. The CLI exits 0 with either one newline-terminated URL on the private pipe or zero bytes when an owner already exists. Stdout stays empty; stderr carries only safe failure codes, with exit 1 on failure. Missing/invalid descriptors, fd 0/1/2, aliases of stdout/stderr and regular-file output refuse before creating state. A fresh invocation rotates an unused link; it never resets an owner.

The installer must privately capture that pipe, bound and validate the returned URL against the configured origin and `/owner/setup?token=[a-f0-9]{64}`, then display it once on its interactive operator terminal after health/optional steps. Do not use `3>&1`, a shell trace, argv/environment tokens, temporary plaintext files, journal output, logs or ordinary captured evidence. Unattended/non-TTY installer output must remain capability-free; arrange trusted private operator delivery rather than printing the URL there. This ticket supplies the CLI, not the installer/service default cutover. Do not call the legacy `installerOwnerLink`, which still selects the legacy database.

The unprovisioned/refused pages now point to the trusted one-time link and local operator reissue; the collapsed source-only password command is removed. This reuses the existing pages rather than adding a Web issuer or another screen. Foreground expiry recovery requires the local operator to restart in an interactive terminal or reissue through the private CLI; no unauthenticated HTTP action can mint a link.

**Memory inspector.** `GET /api/s14/memory/:botId` now includes retained unpinned decisions (`pinned:false`, current revision/generation/source) in its owner-only `decisions` list. The existing list uses its Unpinned pill and Pin form, omits Unpin for tombstones and retains exact-revision editing. Context assembly/current-packet validation still includes only pinned decisions; unpin never silently repins a decision or restores a stale revision-zero form.

**Busy sign-in.** The owner-only S14 projection extends the safe flow metadata with optional `currentFlowId` when `state:'busy'`. `id` remains the busy command's request ID; `currentFlowId` identifies the occupied provider's original start receipt and is the exact `flowId` for the existing `setup.sign_in.cancel` command. Initial busy response, authenticated GET and replay contain only safe metadata, never approval code/URI/handle. Session/Origin/CSRF/revision/provider-receipt checks still apply. A stale cancellation cannot cancel a newer flow. The existing busy page reuses its Cancel button; no new device-flow state is introduced.

**Unavailable reply.** A blocked `Reply` with `reason:'reply_unavailable'` carries `unavailableReason:'sign-in'|'quota'|'provider'|'timeout'|'unknown'`. Production maps only the supported Schway safe auth status, or Jit's own elapsed chat deadline; it never persists/parses provider error text. Unclassified errors, empty/invalid output and old records lacking the field mean `unknown`. A trusted adapter supplies a `ReplyUnavailable` category; arbitrary thrown objects/model output cannot set it. The existing warning uses existing localized provider/quota/deadline words. Only a known sign-in category offers the existing sign-in action. No route/account/model/billing fallback occurs.

**F4 stopped-work report remains unavailable.** `work.stop` revokes the original grant and increments its generation immediately, then waits for open transports before `stopped`. There is therefore no still-live inference authority for the existing `work.summarize` command on stopped work. Merely adding `stopped` to the recovery whitelist or unrevoking/rewinding that grant would weaken admission/publication fences and could resume work. This slice deliberately keeps both retry and summarize refused for stopped work, retains committed evidence and refuses late output. A separate explicit owner-authorized report grant/command over exact current evidence would be needed to deliver F4 without reviving the stopped work; no such replacement authority is inferred here. The existing Start as new work path is a separate owner authorization, not resumption. No new stopped-work visible state or control was added.

Regression evidence: `tests/s14-owner-bootstrap.test.ts` exercises real TTY and non-TTY serve, private CLI delivery alongside the runtime lock, log/stdout/stderr exclusion, descriptor/file refusal, legacy byte preservation, rotation/expiry/owner fences and configured HTTPS origin. `tests/s14-first-run.test.ts` and `tests/s14-first-run-ui.test.ts` cover owner-only busy cancellation/replay, retained unpinned decisions and exact repinning, public reply categories/unknown/deadline and stopped-work fences. These deterministic results do not certify the pending #267 installer, live provider/first-reply or assistive-technology acceptance.

### First-run/team integration (#273)

The default provider-derived routes and explicit deployment routes both use the single process-owned public Schway credential lifecycle in chat, research and computer hosts. Shutdown waits for actual work settlement and sign-in cleanup before lifecycle disposal. Recovery commands use the same drain and capacity/transport reservations as graph lanes, keep the original grant/budget/source checks, and cancel only unstarted original lanes while retaining all historical/committed records. A provisional result cannot permit recovery while its transport is still active. The no-script product journey in `tests/s14-first-run-ui.test.ts` covers fresh owner setup, fake-store sign-in, exact Bot acceptance, two overlapping public hosts, a cited report, review acceptance and authenticated artifact downloads with no route or scheduler configuration. Settings retain provider, web and work-default pages; Work retains Progress, Report, Evidence, Grant and the conditional Computer tab. Both original design sections are preserved as sections 19 (team/report) and 20 (first-run/recovery).

## SHARE14-01 logic seam

`app.snapshot-sharing/v1`, introduced in schema **9**, retained in current combined schema **17** (unreleased 1–16 refuse). Commands through the existing JSON/form ingress are `snapshot.share` with `{scopeId,target:{kind:'source'|'artifact',id,revision,generation},receiverBotId,workId:string|null,expiresAt}` (expectedRevision = receiver Bot revision) and `snapshot.revoke` with `{shareId}` (expectedRevision = share revision). Both return `SharingReceipt {kind,requestId,share}`. `GET /api/s14/shares` / `app.sharing.list(actor)` returns `ShareView[]` with active/revoked/expired/unavailable and `disclosedKnowledge:'cannot_recall'`.

Use exact source or delivered artifact metadata, never a path. Artifact content identity is revision/generation 1/1; source uses its MemoryRef. Receiver must have an owner-accepted configured or built-in share slot in its explicit Bot ceiling; share creates no new capability or execution. Pin the current accepted work ID when appropriate before work.start, then include `{kind:'share',id:scopeId,revision:1}` in that start. Null workId explicitly permits subsequent granted work for this receiver. No retarget or slot reuse; source changes need a new explicit share. Copies are at most 32 KiB each/64 KiB aggregate context. Read-only owner metadata queries cannot start a model.

Map existing Opus sharing/revoke states and immutable file metadata. `snapshot_scope_denied`, `scope_revoked_or_stale`, `snapshot_unavailable`, `snapshot_forward_refused`, `snapshot_context_budget_exhausted` and common artifact-validator errors are safe reason codes. A revoked share fences future calls and late results; displayed disclosure must remain honest. UI layout, copy, forms, Thai/English, no-script, accessibility and responsive acceptance are left to the UI agent; no UI box is completed by this logic slice.

## REC14-01 logic seam (current combined schema 17)

The current combined schema is **17**; all unreleased 1–16 refuse with fresh-state before writable open. Contracts: `app.work-checkpoints/v1`, `app.replay-policy/v1`; sharing remains `app.snapshot-sharing/v1`. No legacy default runtime change.

| Command / query | Exact data / state |
| --- | --- |
| `effect.reconcile` through existing JSON/form commands | `{effectId,actionHash,outcome:'occurred'|'did_not_occur',note}`; expectedRevision = current unknown effect revision |
| `GET /api/s14/recovery` / `app.recovery.view(actor)` | `{checkpoints:WorkCheckpoint[],native:NativeIntent[],actualUsage:null}` |
| Existing effect/work queries | `Effect.resolution?:{basis:'owner_statement',outcome,note,recordedAt}`, new revision and `reason:'owner_statement_not_verified'`; observed effect.state remains unknown |

The owner resolution command returns `RecoveryReceipt {kind:'effect.reconcile',requestId,effect}`. It works after originating work stop/expiry, checks current owner session and exact action hash/revision, and records only the stated outcome. It never retries or verifies delivery. Duplicate keys retain original receipts; changed keys/revisions/extra fields reject. No verified remote read-back adapter is configured. Keep the statement visibly distinct from adapter-confirmed success/failure; its UI wording/layout is for Opus.

Recovery checkpoint states are prepared/dispatched/committed/waiting/queued/resumed/finished. `queued` is eligible requeue; `resumed` has a real replacementAttemptId. Native states are creating/correlated/retired/deleted/not_created/unresolved; mode retire/delete and discovered metadata/reason remain explicit. Saved execution branches remain separate from inventory main references. Read-only queries never trigger native cleanup, inference or tools; native reconciliation retries on an exclusive service boot.

Map per-checkpoint reason codes from app.work-checkpoints/v1. Stopped/revoked/expired/changed/exhausted/unknown-effect work stays waiting/blocked with its concrete reason. An unsettled old transport or orphan retains capacity. Unknown actual usage stays null and charged reservations stay retained. Boot discovery fences old results before workers start; a queued/resumed replacement never reuses native history. Existing committed reports/siblings remain inspectable with explicit partial evidence.

Exact UI integration: `sharing-types.ts`, `recovery-types.ts`, `authority-types.ts`; `app.sharing.list(actor)`, `app.recovery.view(actor)`, `app.authority.effect/view`, existing report/artifact queries and `app.execute`. Opus owns F10/F11/F12, recovery/stopping/unknown presentation, forms and both-language/no-script/responsive/accessibility acceptance. All UI acceptance boxes remain unticked in this logic delivery. Do not add inferred retries, provider fallback, new authority, arbitrary paths or active artifact HTML.

## SHARE14-01 and REC14-01 Web wiring

Opus-authored product routes over the seams above. See section 21 of the experience document for design decisions and evidence.

| Route / form | Use |
| --- | --- |
| `GET /shares` | Active shares, shareable report files and ended shares |
| `GET /shares/new?kind=artifact\|source&id=&revision=&generation=&work=` | Share sheet for one exact snapshot. It runs the gateway check and refuses in words with no control. `work` pins an accepted task. |
| `GET /shares/:id` | One share, the work that names it and, while active, the revoke slip. `?receipt=` rereads the landing banner. |
| `POST /s14/forms/snapshot-share` | `{csrf,requestId,targetKind,targetId,targetRevision,targetGeneration,receiver,workId,hours}` to `snapshot.share`. `receiver` is `<botId>:<botRevision>:<scopeId>`; a retried form reuses its committed expiry. |
| `snapshot.revoke` | Fixed envelope through `POST /s14/commands`, landing on `/shares/:id?receipt=`. A refusal returns to that share. |
| `POST /s14/forms/compose`, `task-start` | Also accept `scope:<shareId>=<shareRevision>`, which become `ScopeRef {kind:'share',...}` in `work.start`. An unticked share is not named. |
| `GET /recovery` | Read-only metadata page with links only. `/api/s14/recovery` is unchanged. |
| `POST /s14/forms/effect-reconcile` | `{csrf,requestId,expectedRevision,effectId,actionHash,outcome,note}` to `effect.reconcile`, landing on `/effects/:id?receipt=`. Used only on the card's own page. |

`S14Overview` gains optional `scopes` and `recovery`, both display data read without the writer lock. A default install needs no `JIT_S14_RESOURCES`: BOT14-02 supplies 64 built-in share slot candidates. The share picker reads `app.sharing.freeSlots(actor)`; only Bots whose exact owner-accepted ceiling already includes a free slot are eligible. Capability selection/acceptance remains the lifecycle UI seam below.

## ROUT14-01 logic seam (UI pending)

Contracts: `app.routine-grants/v1`, `app.attention-outbox/v1`; introduced schema 11, current combined schema 17 (unreleased 1–16 refuse fresh-state). No product UI was authored in this slice. All new commands work through the existing JSON and URL-encoded `/commands` endpoints and receipt queries, with the same session/Origin/Host/CSRF/exact-key rules.

| Command | Exact payload | expectedRevision |
| --- | --- | --- |
| `routine.enable` | `RoutinePurpose` in `src/s14/routine-types.ts`: StartPayload minus task/expiresAt, plus timezone, recurrence, misfire:'coalesce', occurrenceBudget, endsAt | conversation.revision |
| `routine.pause`, `routine.resume`, `routine.revoke` | `{routineId}` | routine.revision |
| `attention.set` | `{level:'all'|'needs-me'}` | attention setting.revision (initial 0) |

Queries: `GET /api/s14/routines` → `{items:RoutineView[]}`, `GET /api/s14/routines/:id` → RoutineView, `GET /api/s14/attention` → `{setting,items:AttentionNotice[]}`. Service equivalents: `app.routines.list/view`, `app.attention.view`. Reads never tick or send. The opt-in service pump ticks captured work and drains local attention after recovery.

Map Routine states active/paused/revoked/exhausted/blocked and occurrence states running/complete/failed/stopped; outcome report/no_update/failed/needs_owner/null. History exposes quiet runs; quiet has no notice. Scope-changing findings are Work proposals (`reason:'routine_out_of_scope'`), with task.accept separate from work.start. Failed admission/read/transport/sibling and owner decisions stay visible. Resume preserves the capture/budget and discards paused backlog; changed Bot/resource authority needs a newly reviewed routine. The UI must not infer start or modify scope from source/model text.

In-app attention carries local_dedupe_only and distinct state/remote/resolvedAt. Unknown remains unknown without auto-resubmit. Retrying an owner command keeps its requestId; stale revision requires a fresh owner review. Thai/English forms, routine/history/needs-me layout and accessibility remain the later Opus-authored work; keep those acceptance boxes unticked.

## BOT14-02 logic seam (UI pending)

Contract `app.bot-lifecycle/v1` extends `app.bots/v1`; combined schema **17**. Types are in `src/s14/bot-lifecycle-types.ts`, service `app.botLifecycle`. The existing JSON and no-script `/commands` endpoints and receipt queries handle every new command with the same auth/CSRF/retry rules.

| Command | Exact payload | expectedRevision |
| --- | --- | --- |
| `bot.capabilities.propose` | `{botId,capabilities:{tools:string[],resources:string[]}}` | Bot.revision |
| `bot.reenable.propose` | same explicit shape for a settled retired Bot | Bot.revision |
| `bot.capabilities.accept` | `{proposalId,proposalHash}` | CapabilityProposal.revision |
| `bot.retire` | `{botId,previewHash,retain:{history:true,evidence:true}}` | Bot.revision from exact preview |
| `bot.delete` | `{botId,previewHash}` | Bot.revision from exact preview |

| Query | Result |
| --- | --- |
| `GET /api/s14/bots/:id/lifecycle` | `{bot,lifecycle,proposals}`; direct `app.botLifecycle.view(actor,id)` |
| `GET /api/s14/bots/:id/lifecycle/retire-preview` | BotLifecyclePreview with exact manifest and hash |
| `GET /api/s14/bots/:id/lifecycle/delete-preview` | BotLifecyclePreview with exact manifest and hash |

Preview reads are owner-only/no-store and create no authority or cleanup. `preview(actor,id,'retire'|'delete')` is the service equivalent. Refresh before a new owner decision after stale_capability_proposal/stale_lifecycle_preview/stale_revision; do not auto-accept the refreshed card. Duplicate request IDs return the committed logical receipt, while queries report current settlement. Deletion may redact payload in historical receipts while preserving retry hash/identities.

Policy proposals include exact Bot revision/generation, action capabilities/reenable, selected ceiling/hash, owner generation and proposed/accepted/superseded state. Widening grants no work/resource/account; this includes adding web_search/web_fetch to a tool-less Jit after creation. Accepted policy changes fence all previous captures/grants and temporarily disable the Bot until actual cleanup settles. Main Jit capability repair is allowed; retiring/deleting jit returns main_bot_required. Reenable is available only for a settled retired identity, takes a new exact owner proposal/current selected ceiling, and creates a new generation needing new work/routine grants. Deleted identities cannot reenable.

Transition states: active/stopping/retired/deleting/deleted; target active/retired/deleted; cleanup stage fenced/data/computer/native/complete. Read Bot.enabled and lifecycle together: receipt is intent, not confirmed stop/erasure. Reasons: bot_transports_unsettled, bot_computer_cleanup_unresolved, bot_native_cleanup_unresolved, restored_bot_generation_withdrawn. Old work/chat/input/native calls retain their real occupancy until settlement. No query retries a model, input or unknown delivery.

Retire requires both explicit history/evidence retention flags and preserves volumes; computer-only reset/delete is separate. Delete preview exposes exact owned sources/private claims, forward derivatives, report/artifact IDs, work/conversation/routine revisions, scoped withdrawal facts, dependent shares, workspace/profile/computer revisions and native IDs/states. retainedEffects enumerates exact action IDs/revisions/hashes/outcomes. Deleted effect payloads show payloadState=deleted with the original actionHash/outcome retained and cannot execute. retainedLineage is identity_hashes_and_independent_originals; disclosedKnowledge is cannot_recall. The backend protects these independently of presentation. Local cleanup never promises erasure of provider/recipient knowledge.

UI agent seam: add Opus-authored lifecycle/capability/routine/history/needs-me surfaces and typed server form translators under `src/s14/`; retain existing `createS14Handler`, S14Application.execute and exact preview/query contracts. Use current Bot revision plus proposal hash or lifecycle preview hash in the owner action. Extend the product `surface`/redirect mapping for these new receipts, since this logic slice leaves product navigation unchanged. Keep Thai/English, keyboard, no-script and UI acceptance boxes unticked until that integration is verified. No CSS/layout/interaction design was authored here.

## OPS14-01 managed installation seam

Contracts: [app.managed-backup/v1](app.managed-backup-v1.md), [app.restore-activation/v1](app.restore-activation-v1.md); schema remains **17**. Types are `src/s14/ops-types.ts`; logic is `S14Maintenance` in `src/s14/ops.ts`. The Opus-authored Web surface is `/settings/backup` (design section 23).

`GET /api/s14/ops` uses the authenticated Host/session/private-no-store boundary and returns `{revision,backups:string[],stage:null|{id,mode,state,reason},maintenance:'offline_required',workers:'running'|'paused',backup:{revision,latest:OnlineBackupReceipt|null,retention:{limit:9,count,automatic:'oldest_online_only',protected:string[]}}}`. Querying never captures or starts work. `revision` remains the offline maintenance revision; `backup.revision` is the separate online command revision. A restore stage still prevents service boot and ordinary queries with `s14_ops_reconciliation_required`; no candidate is presented as active data.

Routine backup requires no terminal. Submit `{kind:'backup.create',requestId,expectedRevision:backup.revision,payload:{}}` to `POST /api/s14/commands` with the existing session, exact Origin and `x-csrf-token`. The no-script `POST /s14/commands` envelope `{csrf,command:JSON.stringify(command)}` accepts the same command. With the product it redirects 303 to `/settings/backup?request=:requestId`; a bare handler returns the same credential-free JSON receipt (202). Types: `OnlineBackupCommand`, `OnlineBackupReceipt` in `ops-types.ts`; direct service `app.backups.execute(actor,command)` and `app.backups.receipt(actor,requestId)`. Read `GET /api/s14/backup-receipts/:requestId` for durable progress.

Receipt fields are `{kind,requestId,revision,backupId,state,reason,progress:{phase,completed,total},startedAt,deadlineAt,workers,reconnectionRequired:true}`. States: capturing/complete/blocked; phases: application/native/waiting_native_settlement/complete/blocked. The finite native-intent count is at most 1024. A duplicate request returns its current logical state, even while writers pause; preserve retry identity. Changed payload/envelope conflicts, stale revisions and extra/path fields refuse. Reaching the 100-entry online retry-journal bound refuses until a separately reviewed archival policy exists.

Capture uses the service’s runtime lock and a durable writer fence, preserving owner-only reads while all worker pumps pause. It requires settled work/chat/effects, stopped/deleted computers and computer operations, settled Bot cleanup and no active sign-in; busy refusal is `s14_ops_quiesce_required`. Use the existing owner work/computer/account controls to settle those states, then submit a new explicit request. A 60-second deadline does not claim cancellation of an unsupported native call: waiting_native_settlement keeps the writer fence until actual settlement, then refuses rather than registering a late image. Service boot resolves interrupted capture under the runtime lock before opening the store/workers. Online retention keeps nine images with a tenth recovery slot, rotating only oldest online-created unpinned images after verified replacement; offline points and current stage source/recovery IDs stay protected. Complete historical receipts do not guarantee indefinite image retention; `backups` is the current inventory.

The offline restore backend seam for the Opus UI agent is `S14Maintenance.status(actor)` → `{revision,backups,pendingBackupId,stage,workers:'fenced'|'stopped'}` and `await S14Maintenance.execute(actor,OpsCommand)` → `OpsReceipt`. The constructor owns the OS runtime lock; the caller must not create another online app/worker alongside it. `status` omits internal native-directory paths. Public receipt stages replace those fields with `[service-owned]`. Offline CLI: `bun src/main.ts ops --s14 [--command <JSON-file>] [--password-stdin]`; no command prints status. Authentication is current owner password, never a submitted actor. Every command is `{kind,requestId,expectedRevision,payload}` using **maintenance** revision, not Home/Work revision.

| Command | Exact payload |
| --- | --- |
| `backup.create` | `{}` |
| `restore.prepare` | `{backupId}` |
| `upgrade.prepare` | `{targetSchema:17}` |
| `restore.validate`, `restore.discard`, `upgrade.rollback` | `{stageId}` |
| `restore.activate` | `{stageId,actionHash}` from the current validated stage |

States for Opus mapping: preparing, validated, activating, complete, partial, blocked, discarded. Partial/blocked/validated keep workers fenced; complete/discarded leave workers stopped until explicit service start. Completion is restore completion, not success of unknown work/effects. Exact activation follows review of the current hash-bound stage; a query, model output or preview is never cutover authority. A changed hash/revision requires current review, not silent resubmission. Request retry identity must be retained. Interrupted capture uses `pendingBackupId`; a discard never prunes a committed backup. Pre-cutover rollback discards staging; post-cutover rollback is a new restore of `recoveryBackupId` with current tombstones.

Safe reasons include `s14_ops_version_unsupported`, `s14_ops_native_unsupported`, `s14_ops_quiesce_required`, `s14_ops_credential_excluded`, `s14_ops_integrity_failed`, `s14_ops_path_untrusted`, `s14_ops_bounds_or_type`, `s14_lifecycle_ledger_unavailable`, `s14_ops_current_ledger_incomplete`, `s14_ops_native_partial`, `s14_ops_native_quarantined`, `s14_ops_native_reconciliation_unresolved`, `s14_ops_computer_or_bot_cleanup_unresolved`, `s14_ops_live_or_ledger_changed`, `s14_ops_stale_cutover`, `s14_ops_activation_state_unknown`, `s14_ops_retention_full`, `s14_ops_receipt_bound` and the existing authentication/revision/request-conflict codes. Native exception text, backup contents, internal paths and credentials must never be rendered. Missing computer cleanup capability stays blocked. Connections/profiles are not carried by ordinary archives; show explicit reconnection needs without promising private browser restoration.

Restore/upgrade needs a trusted local maintenance/controller process that first stops the normal service and acquires its runtime lock. This running-service Web API deliberately refuses every `restore.*`/`upgrade.*` command with `s14_ops_offline_required`: cutover replaces the authentication/application database and native-store pointer, so a serving process must not hold mixed-generation handles or start workers. The Web surface has no restore control and no shutdown endpoint. As directed for #277 it shows the exact offline `restore.prepare` command text, whose revision and hash the service rechecks; `ops --s14` then prints the stage details and exact next commands to stderr, with stdout still the JSON result. Page and terminal text are guidance and grant nothing.

The exact restore flow requires current owner authentication in that maintenance process, current maintenance revision and a registered `backupId`; `restore.prepare` creates the recovery point and quarantine, validates integrity/schema/current independent ledger/native snapshots, and returns its actual stage. Display validated/partial/blocked and the precise safe reason. Partial native import, missing current ledger/cleanup evidence and failed native close cannot enable activation. A new `restore.validate` rebuilds the candidate; a query cannot perform it. Show the current stage ID, source/recovery backup IDs and action hash for a deliberate exact `restore.activate` owner decision. Changed hash/revision requires renewed review. Preserve the exact activation request across interruptions; complete/discarded leaves workers stopped until explicit service start. Post-cutover rollback is a new quarantined restore of the recovery backup with current tombstones. Setup links, sign-in approvals, account credentials, website profiles and old session/grant/approval/routine authority do not return; after activation sign in again and reconnect missing connections explicitly.

Additional safe reasons: `s14_backup_in_progress`, `s14_backup_deadline_waiting_for_settlement`, `s14_backup_deadline_exceeded`, `s14_backup_interrupted_no_auto_retry`, `s14_backup_capture_failed`, `s14_ops_native_close_unresolved`, `s14_ops_computer_cleanup_evidence_required`. No native exception text, internal paths or archive bytes may be shown. Thai/English wording, states, keyboard and no-script presentation are in design section 23. Linux x64/arm64 and real device/screen-reader evidence remain pending.

## PR #275/#278 reconciliation and exact #262 UI seam

Current schema is **17**, retaining all tables from main schema 15 and backup/restore schema 14; unreleased 1–16 refuse with fresh-state, preserving original bytes. The main UI, owner bootstrap, report acceptance, graph scheduling and full boot barrier remain intact. Existing route/command names are unchanged for the stacked PRs.

1. Read `GET /api/s14/share-slots` → `{items:Array<{scopeId:string,receiverBotIds:string[]}>}` (`app.sharing.freeSlots(actor)`). The 64 built-in `share_slot_01`…`share_slot_64` candidates require no `JIT_S14_RESOURCES`. Empty receiver lists describe unused candidates that can be selected in a capability proposal, not permission to share. Used snapshot/memory identities and independent revocation tombstones are excluded. The existing share picker already uses this query. No read reserves a slot.
2. At the current Bot revision submit `bot.capabilities.propose` with `{botId,capabilities:{tools:[...exact selected tools],resources:[...exact selected resources,scopeId]}}`. Preserve the owner's full selection explicitly; do not infer additions. Display the exact proposal and accept only the returned `{proposalId,proposalHash}` with `expectedRevision=proposal.revision` via `bot.capabilities.accept`. JSON is `POST /api/s14/commands`; the no-script envelope is `POST /s14/commands` with `{csrf,command:JSON.stringify(envelope)}`. Changed/stale hashes refuse; do not auto-accept a refreshed card. Adding web_search/web_fetch after creation uses this same sequence.
3. Read `GET /api/s14/bots/:id/lifecycle` until actual settlement reports `bot.enabled=true` and lifecycle `active`; the acceptance receipt is committed intent. It fences old grants/routines/contexts, and grants no content access or execution. Fetch the current Bot revision/free-slot query again, then use the existing `snapshot.share` form/command with its separate exact snapshot, receiver, optional work and expiry. A conflicting consumed slot requires a fresh owner choice.
4. `GET /api/s14/recovery` / `app.recovery.view(actor)` adds `bootedAt:number` (epoch milliseconds). `recoveryView` supplies the same `S14RecoverySurface.bootedAt` to `/recovery`. It is stable across queries/reconciliation and changes on application restart. The UI agent owns localized last-restart wording/time rendering; checkpoint timestamps must not substitute for it.

The Opus Web slice now covers lifecycle/capability controls, receipt landing/redirect mapping and localized boot-time display under `src/s14/web-routines.ts`, `web-lifecycle.ts` and their `web-product-*` translators; see section 22 of the experience document. It adds one optional product hook, `S14Product.review`, a read-only form step that commits nothing. This implementation changes service contracts and existing data adapters, with no new UI/UX design. Deterministic coverage includes fresh no-resource configuration via JSON proposal/no-script acceptance → share → explicit work, post-creation web tool reservations, running multi-Bot graph retirement/settlement, both share kinds across stale-image revocation, and routine dispatch after native-close boot reconciliation.

## CODE14-01 logic handoff — app.coding-work/v1

All coding ingress uses POST `/api/s14/commands` or existing no-script POST `/s14/commands` with the existing authenticated envelope/CSRF/Origin/retry rules. No UI design is supplied in this logic slice.

| Command | Exact payload | expectedRevision |
| --- | --- | --- |
| `coding.repository.grant` | `{id,botId,url,baseCommit,registry?:{hosts:string[]}|null}` or `baseBranch` instead of `baseCommit` | 0 |
| `coding.repository.revoke` | `{repositoryId}` | repository revision |
| `coding.start` | `{repository:{id,revision},work:StartPayload,install:CodingCheck|null,tests:CodingCheck[],connection?:{id,revision}|null}` | conversation revision |

`CodingCheck={argv:string[],timeoutMs:number,network:'none'|'registry',coverage:string}`. Select exactly one Bot and repository resource scope; required tools `computer,coding`, optional proposal-only `effect_push`. The trusted service broker fetches the exact grant baseCommit into a <=16 MiB bundle under one 60-second deadline (decoded object stream <=32 MiB, reflected credential bytes refuse), without host checkout/hooks/filters/submodules. An optional explicit current connection selects a repository-scoped write-only credential for that HTTPS read only; omission/null uses public access. No secret/config/remote enters the box. Rotation/removal and resource revoke fence import; no credential fallback. See app.coding-work/v1 for strict protocol/object limits.

Repository queries and grant receipts show normalized `registry:null` (default/off) or `{hosts}`. Allowed hosts are exact subsets of registry.npmjs.org, pypi.org, files.pythonhosted.org, proxy.golang.org and crates.io. This scope is part of the hashed work/resource authority, never derived from repository/model text. `network:'registry'` checks without it remain unrun with coding_registry_scope_required. With it, one ephemeral container uses the existing CONNECT/443 proxy on a verified internal-only DNS-disabled bridge; ordinary commands/model tools/Phase A and protected browsers stay `--network=none`. Missing topology/proxy/limits fail closed without dispatch/direct fallback. Unconfirmed cleanup fences the handle. Explain the residual risk: allowed registries can carry workspace data out through package requests; the proxy cannot inspect TLS content. This is contract data for the future Opus-authored grant experience, not a UI authored in this patch.

GET `/api/s14/coding/repositories` → `{items:CodingRepository[]}`. GET `/api/s14/work/:id/coding` → `CodingView={job,runs,available,checks}`. Exact exported types are in `src/s14/coding-types.ts`. Run states are running/reviewable/partial/interrupted; safe reasons include coding_tests_not_run, coding_check_failed, coding_check_timeout, coding_changed_during_tests, coding_registry_scope_required, coding_registry_proxy_unavailable, coding_registry_boundary_unverified, coding_registry_cleanup_unconfirmed, coding_preload_size_limit, coding_preload_timeout, coding_preload_protocol_refused and coding_interrupted_no_replay. Checks distinguish passed/failed/skipped/unknown and actual exit/timeouts with bounded stdout/stderr excerpts. Declared coverage is not measured coverage. Show tests that were unrun; do not infer success from model text.

`reportId` links to the existing report API/artifact downloads only after immutable publication. Before it exists, diagnostic run metadata is not a delivered artifact. Existing Work stays waiting for review; reviewable evidence alone does not fulfill owner completion or approve any external effect. Existing work.stop fences the run; interrupted coding does not automatically resume. UI acceptance remains unticked for the later Opus high agent.

## CODE14-02 logic handoff — app.git-effects/v2

POST `/api/s14/commands` and no-script `/s14/commands` use the same existing session/CSRF/Origin/receipt rules. Secrets are write-only and omitted from retry digests/receipts. No UI is authored here.

| Command | Exact payload | expectedRevision |
| --- | --- | --- |
| `git.connection.create` | `{repositoryId,label}` | 0 |
| `git.connection.secret.set` / `git.connection.rotate` | `{connectionId,secret}` | connection revision |
| `git.connection.remove` / `git.connection.test` | `{connectionId}` | connection revision |
| `git.propose` | `{attemptId,connection:{id,revision},update:{ref,oldCommit,newCommit},pr:GitPullRequest|null,expiresAt}` | 0 |
| `approval.decide` | existing `{effectId,actionHash,decision}` | effect revision |
| `git.reconcile` | `{effectId,actionHash}` | unknown effect revision |

`GitPullRequest={base,baseCommit,title,body,draft}`. `git.propose` requires an actual committed coding report and explicit proposal-only `effect_push` in the original grant/Bot/resource. Show that report/diff/checks before approval, including failed/skipped coverage. Proposal/acceptance is separate from approval. The generic Effect content is canonical `GitAction` from `src/s14/coding-git-types.ts`, including exact repository/connection revision/full old→new commit/ref/PR fields and diffHash/reportId. Submit the displayed actionHash and revision; do not rebuild an action from model prose. Later content needs a new typed proposal/approval.

GET `/api/s14/git/connections` → `{items:GitConnection[]}` (metadata only). GET `/api/s14/git/effects/:id` → `{effect,progress:GitProgress,reconcileRequested}`; existing `/api/s14/effects/:id` retains action history. Progress stages: prepared/verifying/push_dispatching/pushed/pr_dispatching/complete/failed/unknown. Existing approval states remain authoritative. Safe reasons include git_approved_diff_changed, git_remote_ref_changed, git_push_rejected, git_push_unconfirmed, git_pr_rejected_after_push, git_pr_unconfirmed_after_push, git_dispatch_unconfirmed and git_remote_readback_unconfirmed. A failed PR can coexist with an already pushed branch; show both facts. No merge/deploy follows.

Unknown offers explicit read-back through git.reconcile or the existing separately labelled owner-statement effect.reconcile. Read-back never retries push or PR creation. `verification:'remote_readback'` proves matching observed remote state; duplicate/absent/incomplete matches stay unknown. Ordinary owner statements do not become verified. Connection rotation/removal, revoked resource, changed owner/Bot and deleted payload remain concrete blockers. Current schema **17**, app.coding-work/v1 + app.git-effects/v2; earlier unreleased 1–16 refuse. UI acceptance and live GitHub/Linux evidence remain pending.

## PR #276 reconciliation and coding UI seam

Combined schema **17** retains main schema 13 plus coding schema 15; unreleased 1–16 refuse with fresh-state. Existing first-run, capability/lifecycle, graph, recovery, report acceptance and snapshot-share commands/queries remain available alongside every CODE14 command/query above. `coding_never_replay` refuses generic retry/summarize without changing old evidence or queuing another shell. Git-bearing checkpoints remain reconcile-only.

The future Opus-authored coding UI consumes the existing `CodingView`, `ReportView`, report-review and artifact-download gateways. Render diff/check content only when available, use the exact committed `reportId`/revision for review, and use exact Git action hash/revision for approval. A settled graph lane waiting for coding review can propose/export only under its original live `effect_push` grant; stop/retire/policy change/source withdrawal still fence dispatch. Source/access withdrawal also withholds diagnostic check logs. Registry limitations reflect the captured scope and actual observations. No new UI/UX design is supplied; existing main surfaces are retained, and concrete coding UI acceptance remains pending for Claude Opus 5.5 high.

## CODE14 Web wiring

Opus-authored product routes over the coding and Git seams. See section 25 of the experience document for design decisions and evidence. This section supersedes the UI-pending notes in the CODE14 handoffs above; live GitHub, real Linux, device and assistive-technology evidence stay pending.

| Route / form | Use |
| --- | --- |
| `GET /coding` | Repositories, coding work and revoked repositories |
| `GET /coding/new` | Grant form. It offers each enabled Bot with `computer`, `coding` and a free owner-accepted configured/built-in resource. |
| `GET /coding/repositories/:id` | Exact repository, connections and revoke. `?receipt=` rereads the landing banner. |
| `GET /coding/repositories/:id/start` | Coding start form |
| `GET /work/:id?tab=coding`, `GET /chats/:id?work=:id&tab=coding` | Run, commands, diff and push form, shown when the grant holds `coding` |
| `GET /effects/:id` | For a `git.propose` effect, the exact push card. `?receipt=` rereads a `git.reconcile` receipt. Other effects keep the existing card. |
| `GET /team/:id/capabilities?add=coding&edit=1` | Draft form with `computer`, `coding` and one free configured/built-in resource ticked; accepting its exact proposal grants the slot. It only opens the form. |
| `POST /s14/forms/coding-grant` | `{csrf,requestId,expectedRevision,url,baseCommit,receiver}` plus `registry:<host>=on`, to `coding.repository.grant`. `receiver` is `<botId>:<resourceId>`. No ticked host sends `registry:null`. The existing `baseCommit` field accepts a branch or full commit; branch names preserve case and translate to `baseBranch`. |
| `POST /s14/forms/coding-start` | `{csrf,requestId,expectedRevision,repositoryId,repositoryRevision,botRevision,conversationId,purpose,completion,install,tests,timeout,coverage,minutes,installRegistry,testsRegistry,push,connection}` to `coding.start`. One test per line. `connection` is empty or `<id>:<revision>`. Limits are one attempt, one step, one read and 256 calls; a retried form reuses its committed expiry. |
| `POST /s14/forms/git-connection` | `{csrf,requestId,expectedRevision,repositoryId,label}` to `git.connection.create` |
| `POST /s14/forms/git-secret`, `git-rotate` | `{csrf,requestId,expectedRevision,repositoryId,connectionId,secret}` to `git.connection.secret.set` or `git.connection.rotate`. A refused post never renders the value. |
| `POST /s14/forms/git-propose` | `{csrf,requestId,expectedRevision,workId,attemptId,newCommit,expiresAt,connection,branch,oldCommit,pr,base,baseCommit,title,body,draft}` to `git.propose`. PR fields are ignored unless `pr=on`. `expiresAt` is rendered once, as the earlier of an hour and the grant's end. |
| `coding.repository.revoke`, `git.connection.remove`, `git.connection.test`, `git.reconcile`, `approval.decide` | Fixed envelopes through `POST /s14/commands` |

`app.sharing.freeSlots` now also leaves out IDs bound to a repository, so the share picker cannot offer one. `codingRegistries` is exported from `coding-protocol.ts`, so forms list exactly what the service accepts. The generic `work.retry`, `work.summarize` and redo links are not rendered for coding work. Approve for a Git effect renders only on its card. `coding.repository.grant`, `receivers()` and `suggested()` use `resourceConfigured` plus the owner-accepted Bot ceiling and current unused-slot policy, so no environment resource override is required. Candidate slots and proposal creation grant nothing. Branch grants use `app.coding.execute` before durable command commit; the broker performs one anonymous fixed GitHub read (64 KiB / 15 seconds, no redirects, credentials or repository execution) and pins its full commit. Failures grant nothing; private repositories retain the full-commit/scoped-preload path. Original command receipts preserve the first pin across retries. `CodingView.checks` includes per-command `coding_install_incomplete` skips. `GitProgress.pullUrl` returns a provider URL only after exact HTTPS GitHub origin/repository/PR-number validation; the existing PR number becomes a link when valid. See the coding/Git contracts for refusal codes and exported signatures.
## LIFE14-01 personal connector logic handoff (app.personal-read-connectors/v1)

Types: `src/s14/personal-types.ts`; service: `app.personal`, `app.personal.reads`. Current schema 17 (introduced at 13). No UI layouts/forms/interaction design were authored in this logic slice.

PR #278 retains every main owner command/query and Opus-authored surface. Personal routines now publish through the ordinary validated report path: `ReportEvidence` adds Google/OAuth personal excerpts with opaque source IDs, exact quotes/revisions, source/retrieval timestamps and timezones. Missing/stale/partial account input is a typed service `read` gap with optional `personal:{scopeId,stale,missing}` metadata; the brief query remains its detailed projection. Historical owner-retained evidence is distinct from executable Bot context. See ADR 0057 and `tests/s14-personal-integration.test.ts`; managed backup and new personal UI acceptance remain pending, with broker credentials/key/ciphertext excluded from exports and backup artifacts.

Ordinary `POST /api/s14/commands` JSON and `/s14/commands` no-script JSON envelope retain session/Origin/CSRF/CSP/receipt rules. Exact payloads:

| kind | expectedRevision | payload |
| --- | --- | --- |
| personal.client.set | current client or 0 | `{clientId,clientSecret,redirectUri}`; write-only secret, revoke connections before client replacement |
| personal.connection.create | 0 | `{label,service:'gmail'|'calendar',scopes:PersonalScope[],account,calendarId:string|null}`; account is an owner label until Gmail readonly profile verification |
| personal.oauth.begin | connection | `{connectionId}`; returns flow metadata, not a code/state secret |
| personal.connection.revoke | connection | `{connectionId}`; local fence commits immediately, remote revocation has a separate state |
| personal.grant.set | resource grant or 0 | `{scopeId,connectionId,botId,active:boolean}`; enabled Bot's owner-accepted slot intersected with `resourceConfigured`: configured custom identity or built-in `share_slot_01`…`share_slot_64`; no `JIT_S14_RESOURCES` required |

Queries: `GET /api/s14/personal` returns `{client,connections,grants,flows}`; `GET /api/s14/personal/oauth/:flowId` returns owner-only `{url,expiresAt}`. Open Google's authorization URL by ordinary browser navigation. Callback `GET /s14/personal/oauth/callback?state&code` (or error) is state-authenticated and cookie-independent, consumes the state and redirects; do not display, retain or log the callback URL. It requires exactly one state and exactly one of code or error, refuses duplicate query keys, and validates an optional `iss` as exactly `https://accounts.google.com`. Other unique response metadata is ignored and grants no authority; flow expiry, state and owner-generation binding remain enforced by the broker. The product handler redirects to the session-free `GET /s14/personal/oauth/done`, or `?refused=1` for an unusable callback, because a redirect chain that began on Google's site never carries the `SameSite=Strict` session and `/` would land on sign-in. That page holds no private data, and its link starts a same-site navigation. A handler with no product still redirects to `/`. Then POST `{flowId}` to `/api/s14/personal/oauth/complete` with current session/CSRF, or no-script form `{csrf,flowId}` to `/s14/personal/oauth/complete`. Completed duplicates are metadata-only; uncertain/interrupted exchange requires a new flow. This endpoint is broker authentication completion, never work authorization.

`GET /api/s14/work/:workId/brief` returns sourced sections and complete/partial/missing status. No sections means missing; with sections, any service `reads.gaps` makes status partial, including a requested readonly account never read. Required inputs use the grant's captured account identity and readonly consent; write-only accounts are not unread requirements. The same facts govern report coverage, routine failure and refusal of quiet no_update. `app.personal.reads.definitions(attempt)` supplies only captured `personal_read`; it does not grant it. Ordinary `work.start`/`routine.enable` must explicitly carry resource refs, `personal_read` and finite limits. Preserve routine purpose/timezone/occurrence bounds. Do not build hidden always-read/always-write authority into a setup form.

Connection states: configured → authorizing → connected, or reauth_required; revoked is terminal. Client readiness is configured_unverified. `accountVerification:owner_label|gmail_profile` must remain distinguishable. Revocation states: none/pending/confirmed/unknown. Flow states: pending/received/exchanging/complete/failed. Read outcomes: running/success/partial/failed/withdrawn; `stale`, `missing`, `calendarTimezone`, `window.timezone` and each source's timestamp/retrievedAt/untrusted fields are meaningful. Failed/partial/stale/missing routine inputs create one grouped attention result even if model output says no_update. Safe errors include personal_invalid_consent, personal_invalid_redirect, personal_account_outside_grant, personal_consent_required, personal_oauth_stale, personal_oauth_failed_reauthorize, personal_connection_unavailable and personal_vault_unavailable. Never interpolate provider error bodies into HTML.

The Opus Web slice is in `src/s14/web-personal.ts`, `web-personal-brief.ts`, `web-personal-effect.ts`, `web-product-personal.ts` and `web-style-personal.ts`; see section 24 of the experience document. Routes: `/settings/google`, `/settings/google/guide?step=1..6`, `/settings/google/new?service=`, `/settings/google/connections/:id`, `/work/:id?tab=brief`. Start forms add `account:<slot>=<revision>` (a `{kind:'resource'}` ref plus `personal_read`) and `account-write:<slot>=<revision>` (the ref only). The form `/s14/personal/oauth/complete` lands on the connection page under a product handler. The HTTPS reverse-proxy/remote-device and same-device-only localhost limits are in `app.personal-read-connectors-v1.md`.

## LIFE14-02 personal exact effects handoff (app.personal-effects/v1)

Current combined schema **17**; LIFE14-01 was introduced at 13. Types: `src/s14/personal-effect-types.ts`; `app.personal.effects` owns drafts, broker dispatch and provider observations. Existing `app.effect-approval/v2` retains single-use card/expiry/unknown/owner-statement behavior, adding the reviewed `calendar` effect class. All other classes/adapters remain unchanged.

Trusted worker/tool seam: `propose(attemptId,requestId,scope,content,expiresAt)` returns `{draft,history,effect,observation}`; the `personal_draft` tool is offered only when a captured `effect_send`/`effect_calendar` tool exists. It never executes. The full content union (all recipients, subject/body or operation/eventId/etag/timezone/sendUpdates/start/end/recurrence/attendees) is in `app.personal-effects-v1.md`. Drafts retain exact account/connection revision, configured calendar and hash. A create's generated event ID is part of the displayed approved content. `draft.hash === effect.actionHash`.

Owner commands use ordinary JSON/no-script `/commands` and receipts:

- `personal.draft.revise` at draft revision: `{draftId,draftHash,content,expiresAt}` → new pending card/revision; old approval invalidated.
- Existing `approval.decide` at effect revision: `{effectId,actionHash,decision:'approve'|'deny'}` → approves exactly one displayed card. No automatic consent/start follows from a read connection or task acceptance.
- Existing `effect.reconcile` at current effect revision: `{effectId,actionHash,outcome:'occurred'|'did_not_occur',note}` → labelled owner statement, original state remains unknown, no retry.

Queries: `GET /api/s14/work/:workId/drafts` → `{items:PersonalEffectView[]}`; `GET /api/s14/personal/drafts/:draftId` → current exact draft/history/card/provider observation. Existing `/api/s14/effects/:effectId` and `/api/s14/work/:workId` still expose the generic ledger. Expired cards project expired; revoked scopes prevent execution even if an older receipt said approved. Root pump consumes approved personal cards only once; unknown is never queued for another write.

Optional owner read-back: POST `/api/s14/personal/drafts/:draftId/readback` with `{expectedRevision:<draft revision>,actionHash}` and session/Origin/CSRF. It only issues bounded GETs under current consent and records a provider observation. It cannot resend or turn an owner statement into verification. The no-script twin is form POST `/s14/personal/drafts/:draftId/readback` with `{csrf,expectedRevision,actionHash}`: the same service call under the same session/Origin/CSRF checks, redirecting to the effect page. Query current effect revision separately after owner reconciliation; draft revision remains the original content revision. Safe failures include personal_draft_changed, personal_consent_required, personal_account_changed, personal_invalid_recipients, personal_timezone_offset_mismatch, stale_approval and existing authority errors. Errors never carry provider bodies.

The Opus exact cards are on `/effects/:id`, and `/effects/:id?edit=1` posts `personal.draft.revise` through form `draft-revise`. Exact fields and hashes are preserved, and no always-send control, consent inference or retry button for unknown writes exists. See section 24 of the experience document.

PR #278 review fixes retain contract versions/schema 17 and existing HTTP/UI routes. Completed draft-producing runs keep work waiting on the owner; card revision/approval/dispatch use live held-effect authority without reopening model tools, including after native boot reconciliation. Calendar evidence retains service-verified `eventEtag`; update/delete may submit `etag:null`, and the broker binds the actually-read source plus exact etag into `draft.hash`. Supplied versions cannot replace it. Unread/foreign-account versions and source withdrawal refuse; preflight/If-Match fence concurrent edits. The outbound guard separately compares raw personal fields after reversing service presentation framing. Every ingestion truncation contributes a visible service gap, partial brief and refusal of quiet no_update. See the personal/effect contracts and `tests/s14-personal-review.test.ts`.

## UX14-02 logic handoff (#279)

All additions retain session/Origin/CSRF, exact payload validation, expectedRevision, durable receipt and changed-retry-key conflict rules. Both `/api/s14/commands` and `/s14/commands` support:

| Command | Payload | expectedRevision |
| --- | --- | --- |
| `attention.acknowledge` | `{noticeId}` | notice |
| `attention.set` | `{level:'all'|'needs-me'}` | setting |
| `bot.capabilities.discard` | `{proposalId,proposalHash}` | proposal |
| `routine.run-now`, `routine.delete` | `{routineId}` | routine |
| `coding.repository.resolve` | `{repositoryId,baseBranch,connection:{id,revision}}` | repository |

`routine.enable` also accepts weekly `{kind:'weekly',day:0..6,time:'HH:mm'}` (Sunday=0), using its captured IANA timezone and the existing gap/overlap/coalescing rules. Run-now uses only active captured authority and remaining occurrence/per-run budgets; it advances the cursor to now and consumes exactly one occurrence. Delete requires revoked state. Revoked routines free capacity. Exhausted captures stay exhausted through Bot fencing; reason `bot_authority_changed` survives reconciliation. Read `app.routines.list` retains all non-revoked captures and captures with actual open proposed/waiting work plus at most 128 recent revoked captures, each with newest 50 occurrences; detail has default 50 and service limit 1–1000. Actual pending Work remains visible independently of notice acknowledgement and routine churn. `app.routines.findings` selects open proposed finding Work directly, independently of occurrence/work-list windows. Routine reports are informational, so needs-me suppresses future report notices while keeping ordinary report/history visibility; failures and decisions remain needs_owner.

Private initial grants may include `connection:{id,revision}` with baseBranch or baseCommit (a full commit performs no remote read). `git.connection.create` may include `botId` to prepare a free accepted resource slot before granting its repository; secret setup remains write-only. Existing repositories can use `coding.repository.resolve`. Both gateways await the trusted broker, pin its exact commit and never execute repository code; all `prlimit`, tmpfs, output/time and no-hooks safeguards remain. See app.coding-work/v1 for the exact scope and refusal rules. Current schema remains 17; no tables/classification changes.

Backup decision: backups remain on the host filesystem. No authenticated download endpoint is added. A download would introduce another exit for private application/evidence data, and the owner has not requested that capability. Credential-free does not mean free of private data; host filesystem access, host permissions and any manual copying remain residual disclosure risks. This decision does not claim host compromise protection.

UI seam, delivered in section 26 of the experience document: no-script forms `attention-dismiss`, `attention-level`, `capability-discard`, `git-slot-connection`, `git-slot-remove` and `coding-repin` build these same typed commands under the ordinary session, Origin, CSRF, revision and receipt checks; `routine-preview` and `routine-enable` accept `day` and `weekTime` for weekly; `coding-grant` accepts `connection` for a branch or full commit. New read pages are `/coding/connect` and `/routines/:id?confirm=delete`. `routine.run-now` and `routine.delete` use the existing `/s14/commands` form path. No backup download was added. Deterministic evidence is in `tests/s14-routine-controls.test.ts` and `tests/s14-private-resolve.test.ts`; live GitHub/Linux/device evidence remains unrun.

PR #280 service enforcement: `routine.delete` returns `routine_decision_pending` (409) for any open proposed finding/waiting occurrence Work across retained history. `app.attention.view` directly selects up to 1000 unresolved notices plus 100 recent resolved notices; resolved history cannot displace open controls. New occurrence `trigger?: 'owner'|'schedule'` records trusted admission origin; absence means historical unknown. The existing history row displays known origin. A pending nonremoved Git connection reserves its slot: unselected public grants refuse `coding_slot_reserved` (409), and the public selector uses only unheld slots. `coding-grant` preserves an explicitly selected connection for both branch and full-commit input; full commits perform no credential read.
