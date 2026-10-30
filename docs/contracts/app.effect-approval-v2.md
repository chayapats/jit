# app.effect-approval/v2

Implemented AUTH14-01 exact-action ledger, S14-AC09; FR-06/17/35/37/38, NFR-05/07. Types/implementation: `src/s14/authority-types.ts`, `src/s14/authority.ts`. This foundation installs **no production send/push/payment/publish/delete adapter**; no fixture success claims real remote delivery.

`proposeEffect(attemptId,requestId,action,expiresAt):Effect` is a trusted worker entry point, not owner authorization. It requires a live attempt and the explicit `effect_<kind>` tool in its owner grant/Bot ceiling. An action is exactly `{kind:'send'|'publish'|'push'|'payment'|'delete',destination:string,content:string}`. Destination and content are exact bounded plain text; credentials are refused. Unknown classes fail `unsupported_effect`; no shell/browser/MCP fallback is available. Concrete future adapters must define and verify complete content semantics (e.g. exact commits/refs or calendar fields) before activation; a generic string is not permission to invent an adapter.

The card captures work/attempt/requester Bot, revision, exact action, SHA-256 of canonical action JSON, absolute expiry (no later than grant expiry), state and safe reason. A repeated proposal key with changed action/expiry fails; an identical key refers to the same logical card. Proposal count and action revision count are bounded by the captured attempt call ceiling. SQL prevents changing action/hash/expiry at the same revision. `reviseEffect(attemptId,effectId,expectedRevision,action,expiresAt)` closes the old revision as changed and creates an unapproved revision. Old approvals cannot follow that change.

The owner alone sends:

```ts
{
  kind: 'approval.decide', requestId: string, expectedRevision: number,
  payload: { effectId: string, actionHash: string, decision: 'approve' | 'deny' }
}
```

`S14Application.execute` derives the actor from the session, rechecks the exact revision/hash/pending state, expiry and live originating authority, and commits decision/audit/receipt together. There is no always-allow rule. Retrying the same owner command returns its old receipt; querying current state is distinct. A changed/expired/denied/stopped card cannot execute. An unavailable adapter stays held with `supported:false`; attempted dispatch fails `effect_adapter_unavailable`, without another route or action.

`runEffect(effectId,expectedRevision,actionHash):Promise<Effect>` is a trusted dispatch entry point. It rechecks all authority, exact hash/action/revision/expiry and adapter availability, reserves a call, then atomically consumes approval as executing before invoking the performer. Duplicate claims cannot send twice. The `EffectPerformer(action,allowed)` must call `allowed()` immediately before the actual effect. It rechecks current grant/owner/Bot/resource authority, current ledger state/revision/hash/expiry and that the selected action object itself still hashes to the approved value. Mutating the performer's argument cannot pass this guard. No await may intervene between its final guard and actual dispatch without another guard. Real adapters remain out of scope and must supply their own reviewed protocol/race evidence.

Success/failure/unknown are distinct ledger outcomes. Exceptions, expiry/revocation during an uncertain call and process death after executing produce **unknown**, never an automatic retry. Exclusive-boot `recover()` marks every executing effect `unknown` with `interrupted_reconcile_only_no_retry`; its attempt is fenced and uncertain reservations stay spent. There is no exactly-once remote claim, speculative resend or invented read-back; reconciliation adapters/owner resolution are later slices. Known late internal work output is discarded after stop, while uncertain external outcomes remain visible.

Queries: `authority.effect(actor,id):{effect,history}` and `authority.view(actor,workId).effects`; HTTP `GET /api/s14/effects/:id` and `GET /api/s14/work/:id`. Expired pending/approved cards project expired at read time without mutating receipts. States: pending, approved, denied, expired, changed (retained history), executing, succeeded, failed, unknown. `supported` means a trusted performer is configured, not proof of live remote support. Current root configures none. `actualUsage:null` is not zero.

Store schema 2 adds effects (work/attempt FKs, unique attempt/request key, payload digest, JSON) and effect_versions (effect/revision key); the immutable-action trigger enforces revision boundaries. All are credential-free application ledger state. Export/backup integration is still #263; no raw credential or browser-session column exists here.

Deterministic tests include wrong hash, destination/content/kind revision changes, expiry at decision/claim/pre-send, denial, unconfigured/unknown actions, mutated performer arguments, exact single-use dispatch, stop/revocation, immutable snapshots, and a separate process dying after the durable claim without any external send. UI approval/unknown design acceptance remains unticked for Opus.
