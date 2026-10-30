# app.input-lease/v1

BOX14-01 (#248), S14-AC12, FR-35/40; NFR-07/14. Exported shapes: `src/s14/computer-types.ts`; implementation: `S14Computers` in `src/s14/computer.ts`.

`InputLease` is `{computerId,generation,revision,actor:'owner'|'agent'|null,attemptId:string|null,expiresAt:number}`. It is durable ownership metadata, never an authentication credential. The service rechecks the current lease rather than trusting a caller's copied value. One per-computer mutex spans dispatch through actual settlement, with at most 16 queued/running operations; owner takeover can fence an agent immediately, but waits for an already-dispatched physical input to settle before sending owner input. A queued old agent input fails at the runtime's final guard. All multi-message CDP input events are enqueued synchronously immediately after that guard; no await separates authority checking from dispatch.

Both commands use the shared authenticated foundation envelope:

| Kind | Exact payload | expectedRevision |
| --- | --- | --- |
| `takeover.start` | `{botId,computerId,generation,leaseRevision}` | current computer revision |
| `takeover.end` | `{botId,computerId,generation,leaseRevision}` | current computer revision |

Start requires a running computer under live owner/Bot/work authority. It increments the lease revision and replaces agent ownership with owner ownership, expiring after the finite idle period. End increments the revision and clears ownership. It never restores an old agent lease or approves an effect. A fresh admitted attempt must acquire a fresh agent lease through `open(attemptId)`. Releasing a stale agent session cannot clear the owner's/new actor's lease. Stop/reset/delete/revocation/restart increment generation/revision and fence pending input and associated late results. Reads/screenshots do not acquire or renew input ownership. Lease expiry refuses input even before the periodic sweep.

`agentInput(attemptId,lease,input:AgentInput):Promise<void>` supports only `{kind:'scroll',deltaY:integer[-800,800] excluding 0}` on the network-free read surface. Click/type/key/submit/navigation/JS/raw-CDP/MCP are refused with `unsupported_browser_action`; model intent or `readOnlyHint` cannot downgrade them. Each accepted agent operation reserves its finite call budget and rechecks the attempt, work, Bot and computer before dispatch and after settlement.

`ownerInput(actor,command:OwnerInputCommand):Promise<{requestId,state:'succeeded'|'unknown'}>` is a **transient Web input seam**, separate from durable lifecycle commands. Exact envelope:

```ts
{
  kind: 'takeover.input', requestId: string, expectedRevision: number,
  payload: { botId: string, computerId: string, generation: number,
    leaseRevision: number, input: OwnerInput }
}
```

`OwnerInput` is `{kind:'click',x,y}` within 1280×800; `{kind:'text',text}` with 1–2000 UTF-16 units, well-formed Unicode and no NUL; or `{kind:'key',key}` from `Enter`, `Tab`, `Escape`, `Backspace`, `ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight`. The typed authenticated owner action authorizes only that exact input. It cannot grant future agent actions. Current session/CSRF/Origin/Host, computer/revision/generation and owner lease are all required.

Input is validated and consumed before dispatch. Retry keys share the lifecycle-command namespace. Only IDs, a per-process keyed HMAC and safe outcome enter `computer_inputs`; no raw text, unkeyed password digest, screenshot or CDP error is stored, audited, prompted or exported. The HMAC key stays in memory. Same-process identical retries return the old outcome; changed input conflicts. After restart the same request is unknown and never resent, even if dispatch might not have happened. A runtime failure, takeover end or revocation racing an already-consumed input produces unknown without automatic retry. The protected pipe receives typed owner text directly, never through runner/shell/MCP. Screenshots remain bounded owner-only memory responses and cannot be fetched through a model tool.

`inputReceipt(actor,requestId):ComputerInputReceipt` returns only request/computer IDs and succeeded/unknown for no-script redirects. A safe `takeover.input` audit event stores no payload. HTTP JSON/form fields, image/state/SSE endpoints and redirects are in [s14-foundation-http.md](s14-foundation-http.md). Product forms, accessible state language and keyboard controls are in design section 17; real device and assistive-technology acceptance remain open. No new CSP exception or WebSocket is introduced.

UX14-01 adds `takeover.renew` with the same payload/revision requirements as start/end. A running live computer with owner lease metadata may renew or restart that owner lease in one action, including after lease expiry before computer stop. It increments both revisions, fences old inputs, updates activity time and caps expiry by idleMs and the original grant expiry. Stopped computers still require a current scoped computer open; no old agent lease or effect approval is restored.
