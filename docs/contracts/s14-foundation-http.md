# S14 foundation HTTP handoff

Logic-only foundation for #246/#247. UI authoring stays with Claude Opus 5.5 at high effort and `docs/design/S14-bot-first-experience.md`. Import `createS14Handler` from `src/s14/web.ts`; inject `S14Renderer(page:S14Page):string` or extend its authenticated page routing under `src/s14/`. `S14Page` includes `state:Home`, `work:Work[]`, `csrf` and locale. `src/s14/main.ts` owns the opt-in composition. Keep `src/web.ts`/legacy runtime intact. The current no-style JSON/form page is only a contract exerciser, not the finished product UI. No framework, CSP exception or inline script is needed.

Run `bun src/main.ts setup --s14 --password-stdin` for local owner provisioning, then `bun src/main.ts serve --s14`. The default is a fresh `.local/s14/application.sqlite`, loopback `http://localhost:3001`; overrides are `JIT_S14_DATABASE`, `JIT_S14_ORIGIN` and exact non-secret route metadata `JIT_S14_ROUTES`. Configure a supported exact model route explicitly; credentials remain in Schway's protected owner store. There is no live readiness/sign-in/host-capacity claim from this environment setting. Without `--s14` the previous runtime remains unchanged. An incompatible selected store refuses with `s14_fresh_state_required` and a fresh separate-path next action before writing or workers.

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
| `GET /api/s14/work/:id` | WorkView: work, immutable grant/exact command, revocation, reservations, `actualUsage:null`, attempts, effects |
| `GET /api/s14/effects/:id` | current exact effect card and action revision history |
| `GET /api/s14/receipts/:requestId` | original committed receipt; no execution/replay |

Typed states to map onto the existing Opus design:

- Bot proposal: proposed/accepted/rejected; old content revisions are stale; author bot/owner and proposerBotId are service-derived; rejected route is null, capability extras have safe dropped codes.
- Chat: queued/running/succeeded/blocked, plus safe reason. Replies increment conversation revision, so refresh before another mutation.
- Work: proposed/accepted/queued/running/waiting/ready/blocked/stopping/stopped. Ready is owner review, not a complete-report assertion. Start receipt pins exact command/grant. Stop remains stopping while real calls are open.
- Approval: pending/approved/denied/expired/executing/succeeded/failed/unknown; changed is retained in revision history. Show exact action, destination/content/hash/revision/expiry/requester, `supported` and reason. Unknown never offers a retry through this seam.
- Usage: reservations are finite, actual usage is unknown; no invented zero, concurrency measurement, provider readiness, research coverage or delivered effect.

All core types have one-line TSDoc in `src/s14/types.ts`, `authority-types.ts`, `application.ts` and `web.ts`. Full product render/a11y/responsive/Thai-English copy checks and all UI acceptance boxes remain for the UI agent. Follow existing external hashed assets and tokens when wiring the Opus design; the unstyled baseline is not a styling precedent.

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
| `GET /api/s14/memory/:botId?q=...` | `{claims:MemoryLookup[],decisions:MemoryDecision[],sources:MemorySource[]}`; no inference or outbound call |
| `GET /api/s14/memory/:botId/claims/:id?revision=1&generation=1` | `{claim:MemoryLookup,history:MemoryAccess[]}` |
| `GET /api/s14/memory-impact/:id?revision=1&generation=1` | `MemoryImpact`: exact affected claims/sources/context IDs and native policy |
| `GET /api/s14/memory-contexts/:id` | `MemoryPacket`; retired state withholds claim/decision text |

Existing Opus memory/share flows consume these projections. States: available/unavailable with safe reason; fact/inference; private/shared with owner publication revision/history; current/retired packet; source text null after deletion. Forget preserves the owner-readable original but prevents automatic use. Correct creates a new private claim. Preview is read-only; the subsequent command is exact-revision authenticated owner authority. No new UI/UX is authored in this slice. Keep UI acceptance unchecked. Native policy is `fresh_sessions_retire_on_close`, not a claim of external erasure. Schema3 requires a fresh separate application path plus its independent current lifecycle ledger; see the memory contract.
