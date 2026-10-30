# S14 foundation HTTP handoff

Current combined logic schema: **12**; earlier unreleased 1–11 refuse with `s14_fresh_state_required` before workers. Earlier slice schema numbers below describe their introduction. All commands remain opt-in behind `--s14`.

## BOX14-01 computer/input seam

Contracts: [app.bot-computer/v1](app.bot-computer-v1.md), [app.input-lease/v1](app.input-lease-v1.md); schema 6 combines result-state evidence, computer storage, memory and Parallel; earlier unreleased schemas 1–7 refuse with fresh-state. Existing setup/chat/work/approval transport remains intact. All additions stay behind `--s14`. Computer product layout and forms are in design section 18.

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

If `serve` is running, stop it before setup; setup and serve take the same exclusive runtime lock. Run `bun src/main.ts setup --s14 --password-stdin` for local owner provisioning, then `bun src/main.ts serve --s14`. The default is a fresh `.local/s14/application.sqlite`, loopback `http://localhost:3001`; overrides are `JIT_S14_DATABASE`, `JIT_S14_ORIGIN` and exact non-secret route metadata `JIT_S14_ROUTES`. Configure a supported exact model route explicitly; credentials remain in Schway's protected owner store. There is no live readiness/sign-in/host-capacity claim from this environment setting. Without `--s14` the previous runtime remains unchanged. An incompatible selected store refuses with `s14_fresh_state_required` and a fresh separate-path next action before writing or workers.

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
| `GET /chats/:id` | Conversation. `?work=:id&tab=progress\|evidence\|grant` opens the work pane; `?start=:messageId` prefills the composer. |
| `GET /work`, `/work/:id?tab=`, `/team`, `/team/:id`, `/proposals/:id`, `/effects/:id`, `/more` | Work list, work, team, Bot, exact proposal, exact approval card, account |
| `GET /memory?scope=<botId>\|shared&q=` | Memory browse: one tab per Bot plus owner-published claims. `?receipt=` rereads a committed receipt for the landing banner. |
| `GET /memory/:botId/claims/:id?revision=&generation=&action=correct\|forget\|delete\|publish\|revoke\|share` | Exact claim page. `action` opens a read-only preview; the command after it holds the authority. |
| `GET /memory/:botId/sources/:id` | One retained source, or the explanation that its text is gone |
| `GET /settings/web` | Optional Parallel settings; public research never needs this page |
| `GET /team/:id?tab=computer` | Bot computer. `&confirm=reset\|delete` opens the consequence card; `&input=:requestId` shows one input outcome. `/work/:id?tab=computer` lists the grant's Bots and links here. |
| `GET /assets/*` | Public hashed static assets |

Fixed-content decisions (`task.accept`, `work.stop`, `approval.decide`, `bot.proposal.reject`) post the seam's `POST /s14/commands` with the exact envelope in a hidden field; `GET /s14/receipts/:id` then redirects to the surface instead of returning JSON. Computer lifecycle and lease commands use this same path and return to the Bot computer tab. Owner-typed forms post flat fields to `POST /s14/forms/{setup,compose,task-start,proposal-accept,proposal-revise}`, which build the same typed command and call the same `S14Application.execute`. The translator decides nothing: unknown fields are refused, `work=on` is the only thing that selects `work.start`, and revisions come from the rendered form. Each capability, tool and Bot is its own field (`tool:<id>`, `resource:<id>`, `bot:<id>=<revision>`) so the handler's duplicate-key refusal stands. A retried `work.start` form reuses its committed `expiresAt`, so the same retry key stays the same command.

Memory and Parallel forms follow the same rule through `POST /s14/forms/{memory-remember,memory-correct,memory-forget,memory-delete,memory-publish,memory-revoke,memory-share,memory-decision,parallel-key,parallel-enable}`. `src/s14/web-product-memory.ts` translates them and refuses unknown fields. Every memory form carries `botId` only to choose the landing page; authority comes from the typed command. `memory-share` takes `target=<botId>:<scopeId>` and `hours` from 1 to 24; a retried form reuses the committed expiry. `parallel-key` carries the write-only secret, and a refused post rerenders settings without it. `web.parallel.key.remove` and the explicit return to anonymous mode are fixed envelopes through `POST /s14/commands`. `S14Product.surface` now also receives the form fields.

Work detail and chat-pane navigation show Computer only when the grant contains `computer`. An old `?tab=computer` link for other work selects and renders Progress. Conversation messages retain revoked reply text with `contextState:'withdrawn'` and the existing withdrawn label; those messages are excluded from automatic context. Web settings show each enabled Bot's actual public-read tool subset, including a single selected web tool.

HTML responses use `Referrer-Policy: same-origin`. With `no-referrer` a browser sends `Origin: null` on the page's own form posts, which the exact Origin check refuses.

`serve --s14 --refusal-page` adds a read-only explanation page after the refusal. The refusal, its stderr JSON and exit status are unchanged, and no store, lock or worker opens. Plain `serve --s14` still exits.

Typed states to map onto the existing Opus design:

- Bot proposal: proposed/accepted/rejected; old content revisions are stale; author bot/owner and proposerBotId are service-derived; rejected route is null, capability extras have safe dropped codes.
- Chat: queued/running/succeeded/blocked, plus safe reason. Replies increment conversation revision, so refresh before another mutation.
- Work: proposed/accepted/queued/running/waiting/ready/blocked/stopping/stopped. Ready is owner review, not a complete-report assertion. Start receipt pins exact command/grant. Stop remains stopping while real calls are open.
- Approval: pending/approved/denied/expired/executing/succeeded/failed/unknown; changed is retained in revision history. Show exact action, destination/content/hash/revision/expiry/requester, `supported` and reason. Unknown never offers a retry through this seam.
- Usage: reservations are finite, actual usage is unknown; no invented zero, concurrency measurement, provider readiness, research coverage or delivered effect.

All core types have one-line TSDoc in `src/s14/types.ts`, `authority-types.ts`, `application.ts` and `web.ts`. Product rendering, Thai/English copy and form contracts are covered by `tests/s14-web-ui.test.ts`; real device and assistive-technology evidence remains open. Follow existing external hashed assets and tokens when wiring the Opus design; the unstyled baseline is not a styling precedent.

Combined contract refinement (schema **6**): `Work.result` retains a bounded latest-attempt ID; `WorkView.results` supplies separately stored result bodies and original ready/waiting state. JSON detail queries and existing Web result rendering retain full granted output through 1 MiB; command receipts never copy that body. Schemas 1–5 are unreleased and refuse rather than auto-migrate. The visible work badges refresh with their result regions, retaining the existing design.

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

Final store is schema **8**, combining the reviewed foundation result table with computer, memory and Parallel tables; earlier unreleased schemas 1–7 require a fresh separate path, preserving original data. The current independent lifecycle ledger must accompany this installation and remain current across application-image restore. MEM14-01/WEB14-01 UI evidence is recorded in section 17 of the experience document and `tests/s14-web-memory.test.ts`. Protocol fixtures are documentation-derived (2026-10-30), with live exact serialization/conformance and live quality explicitly pending.

## TEAM14-01 logic seam

Schema **7** refuses earlier unreleased schemas 1–6 with fresh-state. `app.work-graph/v1` adds `concurrency` and `reads` as required explicit `WorkLimits` fields. Defaults are owner-confirmed **2 / 1800000 ms / 40 reads**; query current defaults rather than assuming fixture counts. Call reservations include inference as well as tools; actual usage remains null.

| Command | Exact payload | expectedRevision |
| --- | --- | --- |
| `work.step.stop` | `{workId,stepId}` | current lane revision |
| `work.defaults.set` | `{concurrency,wallMs,reads}` | defaults revision |

Both use the existing authenticated JSON/form command envelope and receipts. Work stop remains `work.stop`; stopping one lane grants no replacement execution. Future default edits do not mutate current grants.

| Query | Result |
| --- | --- |
| `GET /api/s14/work/:id/graph` | `GraphView {graph,steps,active,concurrency,limits,actualUsage:null}` |
| `GET /api/s14/work-defaults` | `WorkDefaults {id:'work',revision,concurrency,wallMs,reads}` |

Lane states are queued, waiting_evidence, running, stopping, committed, failed, cancelled, blocked. `startedAt`/`settledAt` are actual service observations; null means no observed interval. Render timeline only from these observations. `dependency_uncommitted`, `partial_graph_evidence`, `handoff_not_accessible`, `native_reconciliation_required` and safe handler failures stay explicit. Ready means review evidence; report coverage remains a separate field in REPORT14-01. Core query/command types are `graph-types.ts`. Opus owns pages, form controls, state copy and new UI/UX acceptance; this logic pass adds no product layout.

## REPORT14-01 logic seam

The final combined store is schema **8**; unreleased schemas 1–7 refuse with the same fresh separate-path action. Contracts: `app.report-artifacts/v1`, `app.artifact-gateway/v1`. There is no report-publish owner endpoint: reports/files are outputs of an already-authorized live attempt, validated and committed by its trusted result handler.

`work.start` optionally accepts `requiredEvidence:EvidenceRequirement[]` (`report-types.ts`). Targets are exactly `{id,label,url:string|null,coverage:'snippet'|'excerpt'|'full_content_returned',freshness:'any'|'live_reported'}`. They are captured owner requirements, not model-created authority. An omitted/empty list leaves completion-rule coverage machine-unverified. Existing typed starts remain valid.

| Query | Result |
| --- | --- |
| `GET /api/s14/work/:id/reports` | `ReportView[]`, immutable revision order; no query/fetch/execution |
| `GET /api/s14/reports/:id` | `{state:'available',report,artifacts}` or `{state:'unavailable',id,workId,revision,reason:'lineage_withdrawn'}` |
| `GET /[api/]s14/artifacts/:id/download` | Authenticated private no-store attachment bytes; opaque ID only |
| Existing `GET /api/s14/memory-impact/:id?...` | Now also `reports:{id,workId,revision}[]` and `artifacts:string[]` for exact descendant preview |

Render `Report.state:'ready_for_review'`, `coverage:'partial'|'covered'` and `completion:'owner_review_required'` separately. An empty report history means no committed report, even if ordinary WorkResult text says done. Coverage, `covered`, `missing` and `limitations` stay prominent. Claim `support:'supported'|'unsupported'`, kind quote/inference and flags snippet/excerpt/cached_reported/freshness_unknown/conflicting/unsupported are trusted projections, not badges inferred from prose. Citation `id/revision/attemptId/quote/scope` binds to the exact evidence in the projection. Failed sibling, partial read, missing target and bounded-handoff omissions remain explicit.

File metadata includes opaque ID/name/mediaType/size/sha256/producer/source/time. Use the supplied download route; never construct host or Bot paths. Show unavailable revisions without payload. Treat every report/claim/source string as escaped data; no raw HTML/Markdown execution in the app origin. The logic pass provides no product report layout, new tab, copy or interaction design. Opus owns F3/F4/F7/F8 progress/report/revisions/evidence/files/settings and both-language/no-script/responsive/accessibility acceptance on this branch.

Exact integration files: `graph-types.ts`, `report-types.ts`, `graph.ts`, `reports.ts`, `artifacts.ts`, `authority-types.ts`; shared JSON and fixed-envelope form commands continue through `S14Application.execute` with session/Origin/CSRF/revision/retry checks. UI tests must not treat a file's existence, model prose, a ready WorkResult, unknown usage, unknown freshness or covered evidence targets as owner completion.

## SHARE14-01 logic seam

`app.snapshot-sharing/v1`, schema **9** (unreleased 1–8 refuse). Commands through the existing JSON/form ingress are `snapshot.share` with `{scopeId,target:{kind:'source'|'artifact',id,revision,generation},receiverBotId,workId:string|null,expiresAt}` (expectedRevision = receiver Bot revision) and `snapshot.revoke` with `{shareId}` (expectedRevision = share revision). Both return `SharingReceipt {kind,requestId,share}`. `GET /api/s14/shares` / `app.sharing.list(actor)` returns `ShareView[]` with active/revoked/expired/unavailable and `disclosedKnowledge:'cannot_recall'`.

Use exact source or delivered artifact metadata, never a path. Artifact content identity is revision/generation 1/1; source uses its MemoryRef. Receiver must have a preconfigured `JIT_S14_RESOURCES` slot in its explicit Bot ceiling; share creates no new capability or execution. Pin the current accepted work ID when appropriate before work.start, then include `{kind:'share',id:scopeId,revision:1}` in that start. Null workId explicitly permits subsequent granted work for this receiver. No retarget or slot reuse; source changes need a new explicit share. Copies are at most 32 KiB each/64 KiB aggregate context. Read-only owner metadata queries cannot start a model.

Map existing Opus sharing/revoke states and immutable file metadata. `snapshot_scope_denied`, `scope_revoked_or_stale`, `snapshot_unavailable`, `snapshot_forward_refused`, `snapshot_context_budget_exhausted` and common artifact-validator errors are safe reason codes. A revoked share fences future calls and late results; displayed disclosure must remain honest. UI layout, copy, forms, Thai/English, no-script, accessibility and responsive acceptance are left to the UI agent; no UI box is completed by this logic slice.

## REC14-01 logic seam (current combined schema 10)

The current combined schema is **10**; all unreleased 1–9 refuse with fresh-state before writable open. Contracts: `app.work-checkpoints/v1`, `app.replay-policy/v1`; sharing remains `app.snapshot-sharing/v1`. No legacy default runtime change.

| Command / query | Exact data / state |
| --- | --- |
| `effect.reconcile` through existing JSON/form commands | `{effectId,actionHash,outcome:'occurred'|'did_not_occur',note}`; expectedRevision = current unknown effect revision |
| `GET /api/s14/recovery` / `app.recovery.view(actor)` | `{checkpoints:WorkCheckpoint[],native:NativeIntent[],actualUsage:null}` |
| Existing effect/work queries | `Effect.resolution?:{basis:'owner_statement',outcome,note,recordedAt}`, new revision and `reason:'owner_statement_not_verified'`; observed effect.state remains unknown |

The owner resolution command returns `RecoveryReceipt {kind:'effect.reconcile',requestId,effect}`. It works after originating work stop/expiry, checks current owner session and exact action hash/revision, and records only the stated outcome. It never retries or verifies delivery. Duplicate keys retain original receipts; changed keys/revisions/extra fields reject. No verified remote read-back adapter is configured. Keep the statement visibly distinct from adapter-confirmed success/failure; its UI wording/layout is for Opus.

Recovery checkpoint states are prepared/dispatched/committed/waiting/queued/resumed/finished. `queued` is eligible requeue; `resumed` has a real replacementAttemptId. Native states are creating/correlated/retired/deleted/not_created/unresolved; mode retire/delete and discovered metadata/reason remain explicit. Saved execution branches remain separate from inventory main references. Read-only queries never trigger native cleanup, inference or tools; native reconciliation retries on an exclusive service boot.

Map per-checkpoint reason codes from app.work-checkpoints/v1. Stopped/revoked/expired/changed/exhausted/unknown-effect work stays waiting/blocked with its concrete reason. An unsettled old transport or orphan retains capacity. Unknown actual usage stays null and charged reservations stay retained. Boot discovery fences old results before workers start; a queued/resumed replacement never reuses native history. Existing committed reports/siblings remain inspectable with explicit partial evidence.

Exact UI integration: `sharing-types.ts`, `recovery-types.ts`, `authority-types.ts`; `app.sharing.list(actor)`, `app.recovery.view(actor)`, `app.authority.effect/view`, existing report/artifact queries and `app.execute`. Opus owns F10/F11/F12, recovery/stopping/unknown presentation, forms and both-language/no-script/responsive/accessibility acceptance. All UI acceptance boxes remain unticked in this logic delivery. Do not add inferred retries, provider fallback, new authority, arbitrary paths or active artifact HTML.

## ROUT14-01 logic seam (UI pending)

Contracts: `app.routine-grants/v1`, `app.attention-outbox/v1`; introduced schema 11, current combined schema 12 (unreleased 1–11 refuse fresh-state). No product UI was authored in this slice. All new commands work through the existing JSON and URL-encoded `/commands` endpoints and receipt queries, with the same session/Origin/Host/CSRF/exact-key rules.

| Command | Exact payload | expectedRevision |
| --- | --- | --- |
| `routine.enable` | `RoutinePurpose` in `src/s14/routine-types.ts`: StartPayload minus task/expiresAt, plus timezone, recurrence, misfire:'coalesce', occurrenceBudget, endsAt | conversation.revision |
| `routine.pause`, `routine.resume`, `routine.revoke` | `{routineId}` | routine.revision |
| `attention.set` | `{level:'all'|'needs-me'}` | attention setting.revision (initial 0) |

Queries: `GET /api/s14/routines` → `{items:RoutineView[]}`, `GET /api/s14/routines/:id` → RoutineView, `GET /api/s14/attention` → `{setting,items:AttentionNotice[]}`. Service equivalents: `app.routines.list/view`, `app.attention.view`. Reads never tick or send. The opt-in service pump ticks captured work and drains local attention after recovery.

Map Routine states active/paused/revoked/exhausted/blocked and occurrence states running/complete/failed/stopped; outcome report/no_update/failed/needs_owner/null. History exposes quiet runs; quiet has no notice. Scope-changing findings are Work proposals (`reason:'routine_out_of_scope'`), with task.accept separate from work.start. Failed admission/read/transport/sibling and owner decisions stay visible. Resume preserves the capture/budget and discards paused backlog; changed Bot/resource authority needs a newly reviewed routine. The UI must not infer start or modify scope from source/model text.

In-app attention carries local_dedupe_only and distinct state/remote/resolvedAt. Unknown remains unknown without auto-resubmit. Retrying an owner command keeps its requestId; stale revision requires a fresh owner review. Thai/English forms, routine/history/needs-me layout and accessibility remain the later Opus-authored work; keep those acceptance boxes unticked.

## BOT14-02 logic seam (UI pending)

Contract `app.bot-lifecycle/v1` extends `app.bots/v1`; combined schema **12**. Types are in `src/s14/bot-lifecycle-types.ts`, service `app.botLifecycle`. The existing JSON and no-script `/commands` endpoints and receipt queries handle every new command with the same auth/CSRF/retry rules.

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
