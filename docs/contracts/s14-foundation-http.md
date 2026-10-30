# S14 foundation HTTP handoff

## BOX14-01 computer/input seam

Contracts: [app.bot-computer/v1](app.bot-computer-v1.md), [app.input-lease/v1](app.input-lease-v1.md); schema 11 combines result-state evidence, computer storage/activity, memory, Parallel, graphs, reports and owner review; earlier unreleased schemas 1–10 refuse with fresh-state. Existing setup/chat/work/approval transport remains intact. All additions stay behind `--s14`. Computer product layout and forms are in design section 18.

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

Combined contract refinement (schema **6**, retained in final schema **11**): `Work.result` retains a bounded latest-attempt ID; `WorkView.results` supplies separately stored result bodies and original ready/waiting state. JSON detail queries and existing Web result rendering retain full granted output through 1 MiB; command receipts never copy that body. Earlier unreleased schemas 1–10 refuse rather than auto-migrate. The visible work badges refresh with their result regions, retaining the existing design.

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

Final store is schema **11**, combining the reviewed foundation result table with computer, memory and Parallel tables; earlier unreleased schemas 1–10 require a fresh separate path, preserving original data. The current independent lifecycle ledger must accompany this installation and remain current across application-image restore. MEM14-01/WEB14-01 UI evidence is recorded in section 17 of the experience document and `tests/s14-web-memory.test.ts`. Protocol fixtures are documentation-derived (2026-10-30), with live exact serialization/conformance and live quality explicitly pending.

## TEAM14-01 logic seam

Schema **11** refuses earlier unreleased schemas 1–10 with fresh-state. `app.work-graph/v1` adds `concurrency` and `reads` as required explicit `WorkLimits` fields. Defaults are owner-confirmed **2 / 1800000 ms / 40 reads**; query current defaults rather than assuming fixture counts. Call reservations include inference as well as tools; actual usage remains null.

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

The final combined store is schema **11**; unreleased schemas 1–10 refuse with the same fresh separate-path action. Contracts: `app.report-artifacts/v1`, `app.artifact-gateway/v1`. There is no report-publish owner endpoint: reports/files are outputs of an already-authorized live attempt, validated and committed by its trusted result handler.

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

Every command uses `{kind,requestId,expectedRevision,payload}` and the same `/api/s14/commands` or no-script `/s14/commands` `{csrf,command}` ingress. Device commands call async `app.signIns.execute` only from that validated Web boundary; all others call `app.execute`. Keep the same retry key for transport retries. New keys with stale revisions refuse. Changed envelopes under an existing key conflict. Device receipts can advance only their safe flow state; approval never becomes durable. Other receipts retain their original snapshot.

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

Production restores the union of existing enabled Bots' explicit resource ceilings using `existingResourceCeilings(tx)` plus configured `JIT_S14_RESOURCES` slots, and preserves current memory-share queries through `scopeOptions`. These ceilings create no source access or share grant. SHARE14-01 below supplies the separate revision-bound source/artifact snapshot gateway and current share policy; its explicit commands and queries coexist with first-run commands. A fresh installation has no resource options until the corresponding owner-granted source exists.

Combined schema **11** retains bounded `computer_activity` and its index together with all team graph, report and review tables; first-run commands otherwise use existing revisioned JSON/receipt records. Schemas 1–10 remain unreleased and refuse before writable open, with original database/WAL/SHM/ledger/profile/backup bytes untouched. `serve --s14` now serves the read-only refusal page by default with no store, runtime lock or workers; `--no-refusal-page` retains CLI refuse-and-exit. `--refusal-page` remains a compatibility spelling. No default legacy-runtime cutover or migration is performed.

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

`app.snapshot-sharing/v1`, introduced in schema **9**, retained in current combined schema **11** (unreleased 1–10 refuse). Commands through the existing JSON/form ingress are `snapshot.share` with `{scopeId,target:{kind:'source'|'artifact',id,revision,generation},receiverBotId,workId:string|null,expiresAt}` (expectedRevision = receiver Bot revision) and `snapshot.revoke` with `{shareId}` (expectedRevision = share revision). Both return `SharingReceipt {kind,requestId,share}`. `GET /api/s14/shares` / `app.sharing.list(actor)` returns `ShareView[]` with active/revoked/expired/unavailable and `disclosedKnowledge:'cannot_recall'`.

Use exact source or delivered artifact metadata, never a path. Artifact content identity is revision/generation 1/1; source uses its MemoryRef. Receiver must have a preconfigured `JIT_S14_RESOURCES` slot in its explicit Bot ceiling; share creates no new capability or execution. Pin the current accepted work ID when appropriate before work.start, then include `{kind:'share',id:scopeId,revision:1}` in that start. Null workId explicitly permits subsequent granted work for this receiver. No retarget or slot reuse; source changes need a new explicit share. Copies are at most 32 KiB each/64 KiB aggregate context. Read-only owner metadata queries cannot start a model.

Map existing Opus sharing/revoke states and immutable file metadata. `snapshot_scope_denied`, `scope_revoked_or_stale`, `snapshot_unavailable`, `snapshot_forward_refused`, `snapshot_context_budget_exhausted` and common artifact-validator errors are safe reason codes. A revoked share fences future calls and late results; displayed disclosure must remain honest. UI layout, copy, forms, Thai/English, no-script, accessibility and responsive acceptance are left to the UI agent; no UI box is completed by this logic slice.

## REC14-01 logic seam (current combined schema 11)

The current combined schema is **11**; all unreleased 1–10 refuse with fresh-state before writable open. Contracts: `app.work-checkpoints/v1`, `app.replay-policy/v1`; sharing remains `app.snapshot-sharing/v1`. No legacy default runtime change.

| Command / query | Exact data / state |
| --- | --- |
| `effect.reconcile` through existing JSON/form commands | `{effectId,actionHash,outcome:'occurred'|'did_not_occur',note}`; expectedRevision = current unknown effect revision |
| `GET /api/s14/recovery` / `app.recovery.view(actor)` | `{checkpoints:WorkCheckpoint[],native:NativeIntent[],actualUsage:null}` |
| Existing effect/work queries | `Effect.resolution?:{basis:'owner_statement',outcome,note,recordedAt}`, new revision and `reason:'owner_statement_not_verified'`; observed effect.state remains unknown |

The owner resolution command returns `RecoveryReceipt {kind:'effect.reconcile',requestId,effect}`. It works after originating work stop/expiry, checks current owner session and exact action hash/revision, and records only the stated outcome. It never retries or verifies delivery. Duplicate keys retain original receipts; changed keys/revisions/extra fields reject. No verified remote read-back adapter is configured. Keep the statement visibly distinct from adapter-confirmed success/failure; its UI wording/layout is for Opus.

Recovery checkpoint states are prepared/dispatched/committed/waiting/queued/resumed/finished. `queued` is eligible requeue; `resumed` has a real replacementAttemptId. Native states are creating/correlated/retired/deleted/not_created/unresolved; mode retire/delete and discovered metadata/reason remain explicit. Saved execution branches remain separate from inventory main references. Read-only queries never trigger native cleanup, inference or tools; native reconciliation retries on an exclusive service boot.

Map per-checkpoint reason codes from app.work-checkpoints/v1. Stopped/revoked/expired/changed/exhausted/unknown-effect work stays waiting/blocked with its concrete reason. An unsettled old transport or orphan retains capacity. Unknown actual usage stays null and charged reservations stay retained. Boot discovery fences old results before workers start; a queued/resumed replacement never reuses native history. Existing committed reports/siblings remain inspectable with explicit partial evidence.

Exact UI integration: `sharing-types.ts`, `recovery-types.ts`, `authority-types.ts`; `app.sharing.list(actor)`, `app.recovery.view(actor)`, `app.authority.effect/view`, existing report/artifact queries and `app.execute`. Opus owns F10/F11/F12, recovery/stopping/unknown presentation, forms and both-language/no-script/responsive/accessibility acceptance. All UI acceptance boxes remain unticked in this logic delivery. Do not add inferred retries, provider fallback, new authority, arbitrary paths or active artifact HTML.
