# S14 foundation HTTP handoff

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

The example timestamp must be replaced with a future timestamp within wallMs. In this root only tool-free internal analysis is active. Resource/share policies, public research, computer tools, standing routines, production effects and native safe replay are later slices. A task proposal accepted alone never starts; the work-mode composer directly sends `work.start` without another confirmation. Plain `message.post` and @Bot addressing never grant execution.

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
| `GET /assets/*` | Public hashed static assets |

Fixed-content decisions (`task.accept`, `work.stop`, `approval.decide`, `bot.proposal.reject`) post the seam's `POST /s14/commands` with the exact envelope in a hidden field; `GET /s14/receipts/:id` then redirects to the surface instead of returning JSON. Owner-typed forms post flat fields to `POST /s14/forms/{setup,compose,task-start,proposal-accept,proposal-revise}`, which build the same typed command and call the same `S14Application.execute`. The translator decides nothing: unknown fields are refused, `work=on` is the only thing that selects `work.start`, and revisions come from the rendered form. Each capability, tool and Bot is its own field (`tool:<id>`, `resource:<id>`, `bot:<id>=<revision>`) so the handler's duplicate-key refusal stands. A retried `work.start` form reuses its committed `expiresAt`, so the same retry key stays the same command.

Memory and Parallel forms follow the same rule through `POST /s14/forms/{memory-remember,memory-correct,memory-forget,memory-delete,memory-publish,memory-revoke,memory-share,memory-decision,parallel-key,parallel-enable}`. `src/s14/web-product-memory.ts` translates them and refuses unknown fields. Every memory form carries `botId` only to choose the landing page; authority comes from the typed command. `memory-share` takes `target=<botId>:<scopeId>` and `hours` from 1 to 24; a retried form reuses the committed expiry. `parallel-key` carries the write-only secret, and a refused post rerenders settings without it. `web.parallel.key.remove` and the explicit return to anonymous mode are fixed envelopes through `POST /s14/commands`. `S14Product.surface` now also receives the form fields.

HTML responses use `Referrer-Policy: same-origin`. With `no-referrer` a browser sends `Origin: null` on the page's own form posts, which the exact Origin check refuses.

`serve --s14 --refusal-page` adds a read-only explanation page after the refusal. The refusal, its stderr JSON and exit status are unchanged, and no store, lock or worker opens. Plain `serve --s14` still exits.

Typed states to map onto the existing Opus design:

- Bot proposal: proposed/accepted/rejected; old content revisions are stale; author bot/owner and proposerBotId are service-derived; rejected route is null, capability extras have safe dropped codes.
- Chat: queued/running/succeeded/blocked, plus safe reason. Replies increment conversation revision, so refresh before another mutation.
- Work: proposed/accepted/queued/running/waiting/ready/blocked/stopping/stopped. Ready is owner review, not a complete-report assertion. Start receipt pins exact command/grant. Stop remains stopping while real calls are open.
- Approval: pending/approved/denied/expired/executing/succeeded/failed/unknown; changed is retained in revision history. Show exact action, destination/content/hash/revision/expiry/requester, `supported` and reason. Unknown never offers a retry through this seam.
- Usage: reservations are finite, actual usage is unknown; no invented zero, concurrency measurement, provider readiness, research coverage or delivered effect.

All core types have one-line TSDoc in `src/s14/types.ts`, `authority-types.ts`, `application.ts` and `web.ts`. Product rendering, Thai/English copy and form contracts are covered by `tests/s14-web-ui.test.ts`; real device and assistive-technology evidence remains open. Follow existing external hashed assets and tokens when wiring the Opus design; the unstyled baseline is not a styling precedent.

Combined contract refinement (schema **5**): `Work.result` retains a bounded latest-attempt ID; `WorkView.results` supplies separately stored result bodies and original ready/waiting state. JSON detail queries and existing Web result rendering retain full granted output through 1 MiB; command receipts never copy that body. Schemas 1–4 are unreleased and refuse rather than auto-migrate. The visible work badges refresh with their result regions, retaining the existing design.

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

`app.parallel-web/v1` and `app.external-evidence/v2` use the same `POST /api/s14/commands` and `POST /s14/commands` session/Origin/CSRF boundary. Actor never comes from the client. Native public research is available only in explicit bounded `work.start` with tools selected from `web_search`, `web_fetch` and the Bot ceiling. Tool-free message.post still grants no research execution. Keep the existing finite limits explicit; max call budget includes initial/later inference and tools. Concurrency is still held by the existing foundation guard.

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

Final store is schema **5**, combining the reviewed foundation result table with memory and Parallel tables; earlier unreleased schemas 1–4 require a fresh separate path, preserving original data. The current independent lifecycle ledger must accompany this installation and remain current across application-image restore. MEM14-01/WEB14-01 UI evidence is recorded in section 17 of the experience document and `tests/s14-web-memory.test.ts`. Protocol fixtures are documentation-derived (2026-10-30), with live exact serialization/conformance and live quality explicitly pending.
