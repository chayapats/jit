# s15-conversation/v1

## Executable CHAT15-01 slice (2026-11-03)

The opt-in implementation is in `src/s15/conversation/`; exported TSDoc there defines its actual API. `ConversationApplication.submit` records authenticated original text and a conservative English/Thai grammar ceiling. One isolated, preapproved, tool-free model call interprets natural requests using only original owner text and owner/assistant conversation without retrieved/tool content. Its closed purpose/resource/access proposal is intersected with the narrower grammar/current-policy ceiling and frozen before work tools. Clear execution/selection-start starts automatically; inspection exposes only trusted reads; acceptance retains an obligation; material ambiguity holds once. Exact issue clarification narrows the original request. No model-generated policy installation or approval endpoint exists.

The implementation uses one protected fresh-format SQLite journal for ingress receipts, queues, run/tool claims, observed evidence, native-session correlation and bounded events. A process lock makes restart recovery exclusive. Unclaimed queues retain current-policy guards; interrupted claimed runs are reconcile-only. Per-stream guards/charges wrap the public Schway model, while trusted VM/broker tools enforce their own final-I/O/action gates. Retained results and evidence require a fresh publication guard. S14 command/store/runtime defaults remain unchanged; protected composition must explicitly mount `createConversationHandler` with current owner authentication and installed policy/VM ports. No live activation or S14 migration is supplied.

This smaller slice supersedes the proposed 58-type runtime design below: there is no independently serialized grounding verdict, synthetic world materializer or multi-stage approval parser. The policy service owns exact action approval; conversation exposes its holds. `s15.owner-view/v1` exposes the CHAT projection requested by the Opus handoff (receipt, intent/scope lines, separate provisional progress/evidence/result and Needs-you entries); exact action slip payloads remain POLICY-owned. Channels, attachment acquisition, async artifact delivery, general browser enforcement, migration/rollback and durable CI scheduling remain their respective slices. The documentation fixtures below remain unexecuted design references; executable protocol/behavior tests are `tests/s15-conversation.test.ts` and `tests/fixtures/s15-conversation-intents.json`. They do not prove a live VM, account or universal effect boundary.

The POLICY #353 integration uses the real `src/s15/policy` owner/work/control ports and types. Reads use registered `reserveRead`/`guardRead` claims with final-payload binding and separate settlement/publication; writes use prepared actions and protected dispatch. Owner projections include complete `ActionSlip` payload bytes. Exact original-owner approval text resolves a previously presented revision: a bare affirmative calls `decidePending` over the complete conversation work set, multiple pending items ask which one, and an explicit presented action ID selects only that revision. The decision queues only the exact approved action, never another model/tool loop. Claims/unknown outcomes and presentation refs survive restart; a changed revision cannot consume the old decision. Current owner generation comes from the protected authentication source, independently of an older installed policy. `tests/s15-conversation-policy.test.ts` exercises the real module with scripted models and no-network fixture handlers. VM remains behind its consumer adapter until #321 merges; there is no live host activation.

Status: **proposed pre-admission contract**, revision **1**, 2026-11-02. Bounded DOCUMENTATION-ONLY preparation of [CHAT15-01 #323](https://github.com/chayapats/jit/issues/323) implementation step 1. Requirements: **FR-06/07/17/19/22/23/27/29/32; NFR-02/05/07/10; S15-AC01**. Related constraints: FR-04/08/11/13/14/15/16/18/21/28/30/31/35/36/37/38/40/42; NFR-01/06/08/09/12/14; S15-AC02–AC16. No requirement or confirmed product decision changes.

The [closed documentation schema](fixtures/s15-conversation-v1.schema.json), [complete synthetic definitions](fixtures/s15-conversation-v1.json), [fixture guide](fixtures/s15-conversation-v1.md), [ADR 0069](../adr/0069-s15-conversational-admission-and-result-continuity.md) and [preparation record](../evidence/s15-chat-contract-preparation.md) are review inputs, not runtime APIs, a final contract freeze, DDL, live authority or passing tests. Every scenario is **UNEXECUTED documentation**. S14 remains the implemented default. `message.post`, `task.accept`, `work.start`, private Bot resources and exact-effect approvals retain their current meanings.

## Exact inputs and admission boundary

Inspected main: `64f3a94726fdbce2283aec0944884ca7406d9934`. #317 / PR #343 and #319 / PR #344 are merged. Main's [state-transition contract](s15-state-transition-v1.md), blob `5e6ba001820e1f41728c8a124ed361414187e4fb`, and [ADR 0065](../adr/0065-s15-state-preservation-and-policy-adoption.md), blob `fb451e10fdb67064f484d02029a18cc18672c62b`, are proposed audit contracts, not implemented S15. Main [ADR 0064](../adr/0064-conversational-authority-and-protected-control-plane.md) is blob `03593d4622f55aa220b62718fd0da18cb64d8154`.

| Exact remote proposal, all OPEN / unmerged | Head; principal contract blob |
| --- | --- |
| #318 / [PR #345](https://github.com/chayapats/jit/pull/345), owned by chayapats | `c79aab9d098c902db0cdff7f3d649ca389fff08c`; [feasibility](https://github.com/chayapats/jit/blob/c79aab9d098c902db0cdff7f3d649ca389fff08c/docs/contracts/s15-runtime-feasibility-v1.md) `f7237a3aa7843da00d55493a127a7107263b0824`; proposed ADR0064 `08099feea574c717684099b1070a2d5fe13e1a18` |
| #320 / [PR #346](https://github.com/chayapats/jit/pull/346) | `de2a4b08f9653d01dc0766e5cefa65ac6e2b9919`; [policy](https://github.com/chayapats/jit/blob/de2a4b08f9653d01dc0766e5cefa65ac6e2b9919/docs/contracts/s15-standing-policy-v1.md) `3c1d5596cc3433eca4aaa5507a02256d3d196462`; ADR0066 `ca62a24e81f7601a9b6778997f7cb6b55b24b4a8` |
| #321 / [PR #347](https://github.com/chayapats/jit/pull/347) | `f6cb307b9ee56f5090960a9b737b20be6957baa6`; [VM](https://github.com/chayapats/jit/blob/f6cb307b9ee56f5090960a9b737b20be6957baa6/docs/contracts/s15-working-vm-v1.md) `6922f2ff77661ddbe64a34d0c8b5c0a33e04db35`; ADR0067 `7aab500ef07780a35c1b089694b9ef17ebc0cc60` |
| #322 / [PR #348](https://github.com/chayapats/jit/pull/348) | `7c16b7b6b08005715cacb147e0382f824674ccce`; [browser](https://github.com/chayapats/jit/blob/7c16b7b6b08005715cacb147e0382f824674ccce/docs/contracts/s15-protected-browser-v1.md) `11fc079342c7baa49ea6532bd23a37f533030819`; ADR0068 `4d98bcbf1dbd11d8a76e78c10eaa9feed44fa49d` |

Each head has exact-head Greptile approval/check success; that is review evidence only. Full fixture/schema/guide/evidence blobs are recorded in the preparation record. Read these exact revisions without branching from, merging, cherry-picking or copying their whole files. Every actor/transport/action/schema/adapter assumption requires reconciliation with the **actual merged reviewed prerequisite revisions and implementation evidence**. #323's actual native blocker remains #321 OPEN. #322 supplies an integration proposal, not an invented native blocker. Main and all four active PR trees were collision-checked: 0066/0067/0068 are occupied; 0069 is proposed here subject to integration recheck.

RT15-01 and RF15-G01–G08 remain **unproven**. Required general browser work and an administrable VM remain confirmed targets. No read-only-only completion, option B, guest-loss acceptance, weaker prevention guarantee or Schway blocker is inferred. Required Claude-authored experience is separately unavailable under [#337's recorded limit](https://github.com/chayapats/jit/issues/337#issuecomment-6572828439); no retry or substitute author. This document supplies protocol events, no screens, copy, forms, layout or human interaction design.

## Static implementation and public-surface audit

| Inspected source / contract | Existing behavior and reusable seam |
| --- | --- |
| [chat.ts](../../src/s14/chat.ts), [types.ts](../../src/s14/types.ts) | `schwayChat` supplies exact empty definitions, hosted lookup off, strict context and `maxTurns:1`; `ChatPort.reply(input,signal)` returns untrusted text/proposals. Tools enabled on a Bot do not change this chat path. Native intent/correlation precedes inference; retirement/close are distinct. |
| [application.ts](../../src/s14/application.ts) | A private WeakMap registers owner actors; writer-locked `requireOwner` rechecks session/generation. `message.post` atomically records message, memory input, reply queue, receipt and audit; it does not start work. Reply transport occupancy and current memory publication are guarded separately. Interrupted chat is blocked without automatic replay. |
| [authority.ts](../../src/s14/authority.ts), [authority-types.ts](../../src/s14/authority-types.ts) | `task.accept` retains an obligation. `work.start` atomically creates work/grant/graph/queue, validates finite limits/current Bot/resource/route refs and stores the exact command. Tool, inference, claim and publication guards re-read current facts; stop retains actual unsettled capacity. Existing S14 grants are not standing S15 policy. |
| [validation.ts](../../src/s14/validation.ts) | Exact own-key shapes, bounded canonical bytes and retry hashes. `text()` trims/redacts and must not be used to alter an already hashed exact request/action. Hash equality authenticates nobody. |
| [graph.ts](../../src/s14/graph.ts), [main.ts](../../src/s14/main.ts), [pump.ts](../../src/s14/pump.ts) | Trusted bounded DAG validation, current resource intersections, committed sibling handoffs, shared capacity, wake after committed ingress and complete boot barrier. The application scheduler coordinates durable jobs; Schway owns each native execution loop. No second Jit agent loop. |
| [recovery.ts](../../src/s14/recovery.ts), [native-recovery.ts](../../src/s14/native-recovery.ts) | Independent reservation maxima, claim/owner-statement facts, intent before native creation, metadata-only inventory/retirement/deletion and unresolved orphan capacity. Native paths remain fixed and opaque. A returned response/abort/close does not certify VM/browser/effect cessation. |
| [web.ts](../../src/s14/web.ts), [HTTP contract](s14-foundation-http.md), [web-product.ts](../../src/s14/web-product.ts) | Actual Host/Origin/session/CSRF boundary, capped body, durable receipt read and typed command wiring. The last file was read only for wiring/logic. No current endpoint is silently reinterpreted. |
| [channel protocol](../../src/telegram/protocol.ts), [binding](../../src/telegram/binding.ts), [channel tests](../../tests/telegram.test.ts), [approval tests](../../tests/telegram-approvals.test.ts) | Legacy binding checks actual private sender/chat, rejects bots/forwards and binds callbacks; this is not a shipped S15 channel transport. A role string, username hint, forwarded text or webhook is not owner ingress. |
| [Bot tests](../../tests/s14-bots.test.ts), [authority tests](../../tests/s14-authority.test.ts), [memory tests](../../tests/s14-memory.test.ts), [recovery tests](../../tests/s14-recovery.test.ts), [report tests](../../tests/s14-reports.test.ts), [reply stream tests](../../tests/web-reply-stream.test.ts) | Source-only inspection of forged actors, retry conflicts, bounded context, intent/acceptance separation, current lineage, late replies, usage maxima, stop settlement, committed evidence and cursor/reconnect seams. None was run or establishes fresh S15 evidence. Legacy reply protocols retain legacy scope. |

Schway pin: [tarball](../../vendor/schway-1.0.0-rc.2-697bf40.tgz), version `1.0.0-rc.2`, upstream `697bf406a84c8d1deb8d4a6d71876ea1003be5b3`, recomputed SHA-256 `1c9d83de46edddff58a0163452e7f5ec8357e656c90093990fa28fa606a0f41b`. Public package declarations were inspected statically, without importing/invoking them:

- `createHost(HostOptions):Promise<HostRuntime>`; exact `tools:{policy:'exact',definitions:readonly ToolDefinition[],hostedLookup:'off'}`; `HostLimits` bounds turns/concurrent tools/context/input and optional deadline/attempts. Production supplies every applicable bound explicitly. Strict context disables discovery; controlled discovery must explicitly close every `ContextSourcePolicy` field. Repository/home instructions, skills/packages/extensions and provider-hosted lookup cannot autoload as authority.
- `HostSession.submit(input:HostInput,model:Model,signalOrOptions?:AbortSignal|HostRunOptions)` and `submitWithRoute` retain Schway's loop/retries/compaction. `HostRunOptions` exposes signal, clock and transient `onProgress`; `HostRunResult` distinguishes durable completed result refs from error/cancel/max-turn/limit outcomes. `readResult` reads an exact native ancestry; it is not Jit's publication guard. `cancel():void`, busy-refusing `close/retire` and actual external settlement remain separate.
- Public `Model.stream(request:ModelRequest,call?:ModelCallOptions):AsyncIterable<ModelStreamEvent>` permits a protected forwarding wrapper to validate current selection/data recipients and reserve a bounded physical model-call slot before each stream, including retry/compaction calls. It forwards normalized requests/options/events and errors; it does not implement provider protocols, renewal, retries or a second loop. Requested thinking is public `ModelRequest.thinking`; the adapter may ignore it. Do not claim enforced effort without exact adapter evidence.
- `HostRunUsage` contains per-attempt samples and completeness; token fields may be null. Unknown cost/usage is never zero. `HostAuthSelection`, public lifecycle and `credentialWriteGuard` keep credentials in the protected host. The write guard guards credential writes, **not** every model disclosure. A protected model stream guard is still necessary. Configuration/catalog/readiness is not observed inference.
- Public `ToolDefinition.execute(input,ctx)` / `ToolContext.signal,onOutput`, `coreToolDefinitions(ExecutionBackend)` and exact selected custom definitions support VM/browser composition. Tool effect/read labels and native sibling exclusivity do not establish Jit authority, shared-workspace leases or bypass resistance. No protected-host `localExecutionBackend` fallback.
- Public image input is reference-only: `HostInput.images`, `HostImageOptions{probes,resolve}`, `HostImageResolver(image,signal):Promise<Uint8Array|null>`. Image resolution needs fresh source/recipient/publication authorization and byte limits; it does not sanitize a capture. No visual route readiness is inferred. Public inventory/snapshot/lifecycle does not permit native parsing, raw relocation or profile promotion.

Only `schway/host` production imports are proposed. Reading a declaration reachable through a public re-export is not permission to import its internal path. No demonstrated missing host behavior was found; actual transport/enforcement obligations stay with Jit's adapters. A verified missing public behavior needs its own smallest public-only evidence and Schway proposal.

For the proposed guarded model path, obtain the selected public `Model` through `HostRuntime.auth.createModel()`, wrap it through `guardModel`, then pass that wrapper to `session.submit`. `submitWithRoute` has no caller-model parameter; do not pretend it accepts this wrapper or an invented before-request hook. Use it for governed work only if an equivalent supported current dispatch guard is separately verified. Public model forwarding is the available composition candidate; no new Schway blocker is inferred.

## Closed data and immutable identities

The JSON Schema `$defs` are the exact named data shapes for this contract. All fields are required, nullable fields use explicit null, all unions are closed, additional keys refuse. Proposed source locations, **not added here**: `src/s15/conversation-{types,validation,ingress,interpretation,admission,events,replies,recovery}.ts`, `conversation-schway.ts`, `conversation-policy-port.ts`. Eventual tests: `tests/s15-conversation-{ingress,intent,admission,events,replies,recovery}.test.ts`. Freeze exported TSDoc and actual paths before implementation.

`Id`, `Hash`, `RefV1`, `BlobV1`, `SelectionV1`, `VectorV1`, `UsageV1` use #320's exact primitive semantics. Catalog namespaces remain distinct. Reject unsafe integers, negative zero, overflow, invalid Unicode/NUL/control characters, duplicate JSON keys before parsing loses them, exotic objects/accessors, cycles and sparse arrays. Strings are exact bytes, without trimming/normalization/newline rewriting or post-hash redaction. Credential content refuses/quarantines before ordinary persistence/model input; no raw protected credentials enter these records. `BytesV1` is canonical padded RFC4648 base64 plus exact decoded byte count/raw SHA-256. Schema character bounds are supplemented by mandatory UTF-8 byte bounds below.

`C(x)` is compact JSON, ASCII keys sorted by UTF-16 code units, declared array order, standard JSON escaping/integer spelling, no BOM or trailing LF. `H(d,x)=SHA256(UTF8(d+'\n'+C(x)))`. Domains are `s15.chat.command.v1`, `s15.chat.ingress.v1`, `s15.chat.receipt.v1`, `s15.chat.interpretation.v1`, `s15.chat.proposal.v1`, `s15.chat.admission.v1`, `s15.chat.hold.v1`, `s15.chat.reply.v1`, `s15.chat.event.v1`, `s15.chat.charge.v1`, `s15.chat.facts.v1`. Omit only a containing record's own `hash`; nested hashes remain included. Command has no own hash field; hash the complete command. Raw blobs hash raw bytes. Reference sets are sorted by canonical UTF-8 and unique by catalog ID, never empty-means-all. Source blocks, text segments and event sequences remain ordered. Hashes bind bytes, not actor identity, semantics or remote occurrence.

| Record | Meaning and separation |
| --- | --- |
| `CommandV1` / `SubmitBodyV1` | Client carries exact text, attachment/source refs and optional continuation ref; no role, actor, route, budget, policy or allow verdict. Stop is a separate typed body. Labels/refs do not authorize guessed objects. |
| `IngressV1` / `ProvenanceV1` | Protected ingress binds installation/request/conversation/current owner generation, actual authenticated transport/binding/recipient/source-event identity and exact command/source bytes. Provenance data is not a reusable authentication token. |
| `ReceiptV1` | Immutable acknowledgement of committed ingress and its interpretation queue, or stop intent. It contains no eventual admission hash, avoiding a circular dependency. Admission later refers to this receipt, never vice versa. Historical receipts do not imply current authority. |
| `InterpretationV1` | Trusted bootstrap plan over current policy/purpose/Bot/selection/recipient/source/budget refs and finite bounds. It authorizes only necessary interpretation reads/model calls, never execution/mutation or policy editing. |
| `ProposalV1` | Untrusted candidate intent/subject/outcome/completion/owner-byte spans and narrowing selections/resources. It cannot authenticate, approve itself, install a policy, create a permanent Bot or choose a new account. |
| `AdmissionV1` | Committed grounded intent, exact original request/receipt/proposal, current policy/hash/purpose/resources/Bot/route/model/recipients/sources and finite ceilings; optional owning #320 WorkAuthority ref/hash and exactly one work queue identity. |
| `HoldV1` | Material missing datum, exact request/proposal/current refs and eligible held-action binding. One unresolved hold identity per material question; query/reconnect never creates another question or work slot. No interaction design is specified. |
| `ReplyV1` | Status/result/evidence/gaps/unblock and producing work/attempt/lineage, exact immutable content and authenticated-owner recipient. Model done text is not evidence. |
| `EventV1` / `ProgressV1` | Durable receipt/admission/state/needs-me/evidence/settlement/result references versus bounded provisional progress. Progress is not durable evidence, a commit acknowledgement, settlement or final publication. |
| `FactsV1` / `ChargeV1` | Independent durable claim/capture/transport/operation/process/network/publication/usage facts and exact prior charges. Current continuity, not cached view or a fixture role label, establishes them. |

The schema also closes `CurrentV1`, `ActionBindingV1`, `RunPlanV1`, `RunCaptureV1`, `ReplyReadV1`, `EventPageV1`, `CancelObservationV1`, `DeliveryObservationV1` and every fixture input/outcome. `CurrentV1` is a narrow data snapshot returned by trusted resolvers, not a complete standing-policy catalog or serialized authorization. `ActionBindingV1` is an exact reference/projection for conversational resolution, **not a substitute PreparedActionV1**. The owning #320 service must resolve and validate the complete action/payload/approval. Full target storage/catalog/materializers remain their slices.

## Interpretation without circular authority

1. The real ingress authenticates before command processing. HTTP requires configured exact URL origin/Host, current secure session and POST CSRF/Origin controls; local API requires its verified owner credential; a channel needs verified transport, current exact owner sender/chat/binding, non-forwarded source event and its dedupe. Role/username/JSON/hashes or an authenticated quote do not supply these facts. No model call, retrieval, attachment decoding or remote route selection occurs merely to decide whether those checks passed.
2. Under one current-continuity writer boundary, revalidate that actor after lock acquisition, validate exact command/source refs and bounded bytes, reserve request/queue **capacity**, and atomically commit ingress/source identity, shared request key/hash, immutable receipt, interpretation intent and received event. Capacity is not a metered model charge. Same request/hash returns the original receipt; changed payload/kind conflicts. No acknowledgement precedes this commit. A fault rolls the whole transition back.
3. Protected `prepareInterpretation` resolves a bootstrap purpose already permitted by current standing policy for interpreting this owner's request. It chooses an already approved route/model/effort and actual inference recipient, honors pins and narrower data restrictions, and bounds necessary source reads before content assembly. No model must run to grant this bootstrap scope. Missing approved route, recipient, source access, finite bound or current continuity holds **before** reading/disclosing/calling. Current owner decisions and required request bytes must fit; never silently drop them to fit context. Optional history omissions are explicit. Later owner messages are not instructions for an earlier request.
4. Each actual acquisition/model call has a separate protected invocation slot, finite conservative charge/cost basis and original registered context before I/O. A model wrapper rechecks the actual normalized recipient/route/model/context/images immediately at each public `Model.stream`, including Schway retries and compaction. Image resolution and retrieval recheck after waits and before byte release. Any transform/new context is a new current validated disclosure, not permission from the previous prompt. No provider protocol or Jit retry loop is introduced. Max-call and byte ceilings stop extra calls even if a native run asks for more. Unknown usage retains the bound.
5. Model output is only `ProposalV1`. Strict validators reject extra keys/invalid refs, unsafe byte spans, fabricated source revisions, widened purpose/resources/recipient/selection/ceiling and a claim that quoted/source/tool/attachment/model text is a direct instruction. Trusted grounding resolves the actual request's meaning and subject against **original authenticated owner-authored bytes**, current owner decisions, exact source boundaries and current catalogs. A JSON intent label or valid hash is insufficient. A trusted resolver cannot merely echo a model verdict/confidence or treat all owner-message bytes as imperative. Quotation, negation, conditionals, selection-only and accepted-only content must be evaluated. The real grounding algorithm/language coverage and its negative fixtures are CHAT15-FZ02 implementation admission obligations; fake grounding verdicts are explicitly fixture setup, not a solved or universally proven classifier.
6. A grounded clear request commits admission synchronously under current authority. Selection and start in one message maps to #320 `request.intent:'execute'`; inspect maps to `inspect`; acceptance maps to `accept_obligation` with **no WorkAuthority**. Bind actual outcome/completion/subject as a narrowing of an existing approved purpose; never fabricate a new granting purpose from interpretation. Atomically commit admission, obligation/work/owning policy authority as applicable, unique execution queue and admitted event. Use one internal admission slot under the original ingress identity; do not issue a synthetic owner command, deserialize an owner actor, or call a second public `work.request` with a conflicting retry key. The exact transaction mapping to #320 remains CHAT15-FZ03.
7. Current owner authentication is rechecked for admission/approval after any interpretation wait. An expired/revoked session cannot be deserialized into an owner actor. Retain the request and bounded hold; a later genuinely authenticated continuation can resolve it without repeating already established scope. This is authentication continuity, not an extra Work confirmation. Durable admitted work subsequently uses its own #320 authority lifetime/owner-generation fences, independently of that login session.

| Grounded meaning | Required disposition |
| --- | --- |
| Ordinary answer / explanation | Bounded authorized interpretation/reply only; no tool-backed execution queue unless a requested inspection needs it. |
| Accept an obligation / select only | Retain obligation/selection; no execution queue or work authority. |
| Inspect / recommend / report readiness | May perform authorized reads and evidence assembly; **no mutating work**, including implementation/local edits, even if tools or a suggested plan could do it. Necessary service-owned receipt/evidence bookkeeping does not grant domain mutation. |
| Clear requested execution | Record and start inside current standing policy. No Work switch, repeated resource selection, per-task grant ceremony or second confirmation. Method may be selected inside the existing ceiling. |
| One-message select-and-start | Resolve exact current selected subject plus clear start intent atomically; do not require an earlier accepted task or a second message. |
| Material ambiguity | Commit one bounded hold identifying only the unresolved outcome/subject/data recipient/major direction. Continue independent already authorized inspection where permitted; do not start the materially ambiguous mutation. Repeated queries/delivery do not append duplicate holds. A genuinely new unresolved ambiguity may create a new revision. |
| Exact held-action approval | Resolve authenticated affirmative/denial to exactly one current eligible prepared action and its original final content/recipients/attachments/transaction. #320 appends ApprovalV1; **PreparedAction revision/hash stay unchanged**. Ambiguous/stale/quoted approval never executes. |
| Normal result to authenticated owner | Guarded ordinary assistant output; no outbound-to-others approval ceremony. It still needs current source/access/recipient and delivery identity. |

A continuation is a **new authenticated command** referencing the exact current hold/request revision and its own request key. Preserve original request bytes/receipt, link new bytes as a distinct source, and resolve only the missing datum. It cannot silently replace purpose/ceilings or approve itself. Explicitly changed purpose is a new obligation/request with its own admission, not a hidden continuation. All continuations share the original logical work slot; concurrent answers cannot create two starts. Reconnect/restart is never an answer or approval.

## Proposed trusted ports and real output paths

The following documentation signatures use exact schema data names and qualified `Policy.*` types from the pinned #320 proposal. Private symbols illustrate opacity; actual private instance registries/current authentication enforce it. Constructors and catalogs stay in protected composition; no port/actor/context is a model tool or serialized bearer capability.

```ts
import type { Model, HostProgressEvent } from 'schway/host';
declare const workerBrand: unique symbol, requestBrand: unique symbol;
declare const interpretationBrand: unique symbol, dispatchBrand: unique symbol;
declare const cleanupBrand: unique symbol, deliveryBrand: unique symbol;
declare const groundingBrand: unique symbol;
interface RequestWorkerV1 { readonly [workerBrand]: true }
interface RequestContextV1 { readonly [requestBrand]: true }
interface InterpretationContextV1 { readonly [interpretationBrand]: true }
interface RunContextV1 { readonly [dispatchBrand]: true }
interface CleanupContextV1 { readonly [cleanupBrand]: true }
interface DeliveryContextV1 { readonly [deliveryBrand]: true }
interface GroundingV1 { readonly [groundingBrand]: true }
interface ConversationPortV1 {
  /** Reauthenticate under lock; atomically commit ingress/receipt/queue/event.
   * Stop fences named work immediately, without claiming actual settlement. */
  execute(actor: Policy.OwnerActorV1, command: CommandV1): ReceiptV1;
  /** Registered worker is bound to the exact committed request/queue slot. */
  interpret(worker: RequestWorkerV1, ingress: RefV1,
    signal?: AbortSignal): Promise<ProposalV1>;
  /** Current authenticated actor, trusted original-byte grounding and current
   * policy resolution; atomically commit one admission/work/queue or hold. */
  admit(actor: Policy.OwnerActorV1, ingress: RefV1,
    proposal: ProposalV1): AdmissionV1;
  dispatch(worker: RequestWorkerV1, queueId: Id,
    signal?: AbortSignal): Promise<FactsV1>;
  /** Read retained eligible reply only; no model/tool/transport resend. */
  readReply(actor: Policy.OwnerActorV1, reply: RefV1): Promise<ReplyReadV1>;
  /** Final synchronous guard/use of this exact retained content. */
  publishReply(actor: Policy.OwnerActorV1, reply: RefV1, hash: Hash,
    consume: (reply: ReplyV1, content: Uint8Array) => void): void;
  events(actor: Policy.OwnerActorV1, query: EventQueryV1): EventPageV1;
  /** Resolve only original registered cleanup; memoized, scoped and bounded. */
  cancel(worker: RequestWorkerV1, attempt: RefV1): Promise<CancelObservationV1>;
  /** Metadata/fact reconciliation; no reconstruction of mutation contexts. */
  recover(worker: RequestWorkerV1, ingress: RefV1): Promise<FactsV1>;
}
interface InterpretationPortV1 {
  prepare(context: RequestContextV1): InterpretationV1;
  /** Scope/access first, separately charged read, then post-wait validation. */
  context(context: InterpretationContextV1,
    plan: InterpretationV1): Promise<ContextPacketV1>;
  interpret(context: InterpretationContextV1, plan: InterpretationV1,
    packet: ContextPacketV1, signal?: AbortSignal): Promise<ProposalV1>;
  /** Private grounding result is never accepted from serialized input. */
  ground(context: RequestContextV1, proposal: ProposalV1): GroundingV1;
}
interface ConversationPolicyPortV1 {
  current(context: RequestContextV1): CurrentV1;
  /** One physical model-call slot; wrapper forwards public stream unchanged.
   * No retries/providers/credential access are implemented by the wrapper. */
  guardModel(context: InterpretationContextV1 | RunContextV1,
    selection: SelectionV1, model: Model): Model;
  admit(context: RequestContextV1, grounded: GroundingV1,
    proposal: ProposalV1): AdmissionV1;
  /** Original registered unconsumed invocation/charge, no second charge. */
  continueOriginal(context: RunContextV1, plan: RunPlanV1): void;
  decide(actor: Policy.OwnerActorV1, context: RequestContextV1,
    binding: ActionBindingV1,
    decision: 'approve' | 'deny'): Policy.ReceiptV1;
}
interface ConversationSchwayPortV1 {
  invoke(context: RunContextV1, plan: RunPlanV1, signal: AbortSignal,
    progress: (event: HostProgressEvent) => void): Promise<RunCaptureV1>;
  cancel(context: CleanupContextV1): Promise<CancelObservationV1>;
}
interface OwnerDeliveryPortV1 {
  /** Current bound owner endpoint, exact retained reply/event/hash; credentials
   * resolved only by the protected adapter, no arbitrary recipient argument. */
  deliver(context: DeliveryContextV1, reply: RefV1,
    replyHash: Hash, signal?: AbortSignal): Promise<DeliveryObservationV1>;
}
```

`GroundingV1` is an opaque privately registered verdict tied to original request/proposal hashes and the exact current resolver snapshot, not a schema data record. A fixture `GroundingSetupV1` is **only a recipe for a future fake trusted port**, not that verdict. `admit` does not accept a serialized grounding result. Revalidate all refs after every wait and at the synchronous admission commit; a stale grounding result is invalid. Interpretation contexts never have the owner decision port. Owner approval resolution calls the owning #320 service inside the same authenticated decision/continuity boundary; it cannot alter prepared content or use a model-issued approval. No raw secret crosses any of these signatures.

The execution path is registered worker → `dispatch` → current plan/finite claim → `invoke` using Schway public host/session and exact admitted tools → retained `RunCaptureV1` → validated committed Reply/evidence → `readReply` → **synchronous `publishReply`**. Every tool output, VM/browser retained response, model image resolution and `onOutput` path retains its own final current publication guard. Raw native model deltas never become a delivered result through another callback. `RunCaptureV1` carries sanitized immutable output/evidence refs and usage/settlement facts, not a native store or provider wire payload. Validated owning services supply actual tool evidence; arbitrary model refs cannot satisfy completion.

`readReply` returns payload-free pending/withheld until appropriate evidence/current guards pass. `publishReply` re-resolves current content hash/lineage/recipient/withdrawal and latched cancellation, then invokes only a trusted synchronous consumer with exact validated bytes and no wait before use. Async download/image/channel handoff rechecks at its actual final byte boundary. A copied actor, callback from model code or raw-response map cannot bypass this path. Historical committed evidence can remain owner-inspectable under current access after execution expiry/stop; it is not permission to deliver a previously unpublished late result. Control/status/needs-me events use their own authenticated safe projection, not stopped execution authority.

`RunContextV1` is privately registered to one original claim/reservation/process fence and unconsumed run invocation. New dispatch rejects an existing claim. Its final guard continues only that original invocation and already charged upper bound, even at zero remaining allowance; recovery/serialized IDs cannot recreate it. A native run may contain separately admitted model/tool child slots; each physical I/O needs its own exact committed charge/context. In particular #322 public requests require its closed **action-or-read authority through the same protected emitter**, original registered child read context and **already committed exact child charge history**. A parent's charge does not fund a new child at zero allowance. Preserve its directional complete-frame bounds including the header, separate from image/output BytesV1. No wrapper silently creates a second request emitter.

VM adaptation preserves #321 actor-bound prepare/accept, signal-aware dispatch, guarded readResult, synchronous publishResult and original-scope memoized cancel. Browser adaptation preserves independent input/network/capture/channel/scope/process facts. Neither cancel nor the outer Schway result can overwrite those services' observations or mark them settled. Full schemas and actual adapter bindings remain their named implementation gates.

## Atomicity, bounds and events

| Identity / transaction | Required semantics |
| --- | --- |
| Installation request `(installationId,ownerId,requestId)` | Shared namespace across conversation/policy/VM/browser/local/channel commands and transient-input tombstones. Bind contract/kind/full payload hash. Same hash returns original committed receipt before stale revision evaluation; changed payload/domain conflicts. Current authentication and current continuity are required even for duplicates. No new queue/charge/event on retry. |
| Channel source `(installationId,bindingRef,sourceEventId)` | Uniquely maps actual verified source event to one request/hash. A caller's fresh requestId cannot replay an old channel event. Changed payload under that event conflicts. A different channel cannot claim equivalent Web text is the same action without a trusted common request key. |
| Ingress interpretation queue `(ingressId,'interpret')` | Commit source/message, queue identity, receipt and received event together. Only metadata/source access and capacity checks occur before metered interpretation admission. |
| Grounded admission `(rootIngressId,'admit')` | At most one live obligation/work slot; unique across continuations and competing workers. Commit original receipt linkage, current scope/outcome/ceiling, owning policy authority, execution queue and event together. Partial cross-store authority/queue binding refuses dispatch. |
| Run/child invocation `(admissionId,slotId)` | Claim and exact conservative reservation/current continuity before I/O. No new caller context for an existing claim; recovered claims reconcile only. New inference/read/tool/delivery slots charge separately. No blind mutation SDK retry. |
| Hold / decision | One exact current hold/revision and action binding. Duplicate response returns its receipt. Concurrent conflicting clarification loses with stale revision; no second work. Action decision appends a separate #320 approval without changing action revision/hash. |
| Reply / event / logical delivery | Commit evidence/reply and durable evidence event atomically. Actual transport/process settlement is a separate fact. Final result event/delivery records the publication boundary separately. One logical `(eventId,recipientRef)` delivery; remote exactly-once is not claimed. |

These are requirements for a future protected transaction coordinator, **not supplied DDL**. A current receipt/tombstone/prefix cannot be evicted to allow a key to run again. Missing/conflicting continuity or exhausted finite identity capacity refuses new admission; there is no empty-ledger bootstrap. Do not hold a database transaction open across network/model I/O.

Reserve finite cleanup/control/fact-capture headroom before admitting work, including the records needed to stop/revoke and settle its original scopes. Ordinary work cannot consume that protected headroom. A profile unable to retain its required cancellation/uncertainty facts must refuse admission; full payload custody is not a reason to erase claims or skip a stop fence. Exact storage allocation and emergency-fence proof remain CHAT15-FZ03/05.

| Hard protocol ceiling | Proposed bound, configurable only downward; no operating allowance selected |
| --- | --- |
| Command / ordinary canonical record / complete context packet | 131072 / 131072 / 262144 UTF-8 bytes; ContextPacketV1 uses the explicit larger record bound; depth <=16; <=128 properties/object; <=256 entries/array; referenced sets <=64 |
| Owner text / proposal / reply body | 16384 / 16384 / 32768 UTF-8 bytes, exact Unicode; complete command/context cap includes escaping/metadata and pinned decisions |
| Attachments / context sources | <=8 attachment refs; each sanitized immutable input <=1 MiB, combined <=4 MiB in protected custody; no implicit model disclosure or inline embedding. <=64 source refs; actual supplied context must fit its stricter cap. |
| Interpretation / native run | <=30000 / 3600000 ms absolute monotonic deadline including queues/waits; interpretation <=4 physical model calls, execution <=64 physical model calls and <=64 tool slots per run; each uses current finite policy limits if lower. No unspecified cost bound admits a call. |
| Active concurrency / queued ingress | <=8 active runs/installation, <=16 queued ingress/conversation and <=256/installation; shared route/Bot/VM/input ceilings can be stricter; unsettled scopes retain capacity. |
| Progress | <=1024 UTF-8 bytes/event, <=10 events/second/run and <=64 KiB retained ephemeral buffer/run; coalesce/drop excess. Detached progress is lost; it never produces work or success. |
| Event page / connection | <=64 durable events/page, <=131072 canonical page bytes, <=30000 ms connection, <=2 live event readers/owner endpoint; no unbounded SSE stream or server task. Poll/reconnect is read-only. |
| Retained journal / payload | <=4096 hot events/conversation, <=100000 protected request/claim identity entries/installation, <=64 MiB protected conversation payload custody/profile. Exact retention/safe archival/storage accounting must be frozen; on exhaustion refuse new work rather than forget dedupe/claims/withdrawals. |
| Cancellation / reconciliation observation | <=5000 / 30000 ms per authorized operation; timeout records unknown and retained capacity. Cleanup overhead is included in the original conservative bound, not free new work. |

Each configured profile also has finite spend/call/read/output/active time/source/storage/transport budgets and a current cost basis. Numeric examples are synthetic, not owner-approved S15 amounts, currency periods, resource sizing or readiness. `VectorV1` charged upper bounds are nonrefundable as in #320. Actual measured/partial/unknown usage is separate; null is not zero. Settlement releases actual concurrency only. Incremental reads/delivery/reconciliation must obtain their own finite authority; checking a guard is not an additional charge.

The complete ContextPacketV1 canonical size includes source records, labelled payload, base64 expansion and metadata. Its `bytes` is the decoded labelled payload length, separately <=262144; it is not the complete packet size. Both limits apply. Attachment custody limits do not authorize inlining a 1 MiB source into a smaller record/context: acquire only separately authorized bounded excerpts/references or report the required input cannot fit. Byte wrappers, raw content and transport/record bounds are distinct.

Durable `EventV1.sequence` is monotonic per conversation with opaque event ref/hash and a stable root ingress. A cursor is bound to that installation/conversation; malformed/cross-conversation/future cursors refuse. `EventQueryV1.after` is exclusive. Expired hot cursor returns `state:'reset'`, a bounded **current authorized snapshot reference**, and a safe current cursor; it does not replay work, source text or remote delivery. Retention of content can expire while identity tombstones/charges remain. Withheld/withdrawn references use a payload-free projection without exposing hashes of deleted sensitive bytes through an ordinary export. Reconnect authenticates again and rechecks access per page/final emission. Page byte limit can end a page before its count limit; cursor advances only through committed emitted events, never drops an oversized required event silently.

Progress/status/result are separate protocol facts. Provisional progress passes current recipient/lineage/byte sanitization before handoff; raw provider errors/thinking/credentials are not events. `evidence_committed` means immutable retained evidence exists. `settlement` records only scopes actually proved. `result` records eligible final publication, not all transports stopped. A channel timeout after possible send remains `unknown` and reconcile-only; reconnect/cursor replay never resends that channel message. Normal owner delivery needs no send-to-others approval, but a new endpoint or private-data recipient cannot be inferred from a channel label. No real transport is implemented here.

## Error order, stop and recovery

Exact safe errors are closed in `CodeV1`. Evaluate in this order: (1) actual authentication/Host/Origin/CSRF/channel identity; (2) strict shape/bytes/credentials/hash; (3) current continuity; (4) same-key receipt/conflict; (5) current revision, stop/revoke/disabled/stale/expiry/lineage/pin/scope; (6) missing supported grounding/adapter/current approved route/recipient and finite cost/budget/capacity; (7) material ambiguity or applicable exact human gate. No failure widens another constraint. Existing original-context guards skip new-claim/incremental-allowance tests only for their exact already charged invocation; publication has its own current checks and expects producing claims.

Stop/revoke commits immediate admission/dispatch/late-content-publication fences, then requests bounded original-scope cleanup. Register abort before the first wait; already-aborted dispatch refuses before claim. Abort after claim latches publication denial and calls the **same memoized cancel** as explicit stop, once per original scope. A fresh cancellation request/timeout cannot change recipients, restart work or stop unrelated shared VM/browser scopes. Whole-resource stop needs authority for its full impact. Signal/abort/native completion/channel closure is not proof of process/network/effect settlement.

Capture and retain sanitized observations, actual/unknown usage, claims, explicit child charges and independently verified settlement under their trusted original continuity even after stop/revoke. Rejecting stop evidence preserves previously captured response, input/network dispatch, known channel closure, usage and settled facts. Valid proof changes only the exact scopes it establishes. Unknown remote historical outcome remains unknown even after every process stops. A separate current-access historical query can inspect retained committed evidence; no late result delivery or renewed execution is implied.

| Restart boundary | Required outcome |
| --- | --- |
| Before ingress commit | No receipt/queue; a genuine authenticated retry can commit once. |
| After ingress receipt, interpretation not started | Preserve receipt/queue/root identity. Revalidate current authentication/scope before any new processing; reconnect alone starts nothing. |
| Interpretation/model claim may have dispatched | Preserve charge/unknown usage; no blind inference resend. Reconcile native metadata through public APIs; a new explicitly admitted safe interpretation attempt needs current authority/remaining budget and no mutation context reconstruction. |
| Admission/queue committed, execution unclaimed | Preserve exact one intent. A registered current scheduler may claim only under reviewed replay/admission rules and current authority; documentation does not admit boot replay of VM/browser/input work. |
| Execution/tool/effect claim exists | Reconcile-only for unknown work/effects. No new key, model proposal or restored queue can re-send it. Trusted replay-safe later steps require proven handler-specific current evidence/settlement and a distinct bounded attempt, never a model readOnly label. |
| Evidence committed, publication not committed | Keep evidence and current charges. Recheck current access/stop/recipient before publication, no rerun to reconstruct the answer. |
| Publication/channel outcome uncertain | Preserve logical delivery/unknown outcome; read-only reconciliation only, no reconnect resend. |

Adoption/rollback preserve ADR0065's **one current continuity authority**, request/claim identities, all charges/usage/withdrawals/policy revocations, old/new boot fences and original S14/legacy bytes/private account/data restrictions. Old grants/approvals/routines/queues remain nondispatchable. No native/profile relocation/copy/promotion or inherited numeric allowance/account/budget/model readiness. Fixed opaque native workspaces use only Schway public lifecycle/snapshot APIs. Unsupported reverse projection keeps both runtimes fenced. Full runtime/DDL/materializers, maintenance/worker-release ports, real transports/brokers/platform proof remain their slices. No permanent-Bot policy or Jod integration is introduced.

Human-required communication/payment/production/new-recipient/major-change gates remain outside model/guest authority and alternate shell/browser/script/MCP routes. Inspect cannot implement; an exact held-action decision cannot widen hard work ceilings. Product-default GitHub publication/replies require approval; a separately installed bounded personal exception may authorize technical publication, while merge requires separate authority/current target/head/evidence/checks/reviews and production still holds, including before a production-triggering merge without an effective protected deployment gate.

An eligible new-recipient release follows #320's explicit exact authenticated owner-release semantics and current consent/catalog mapping. It cannot become a model-selected recipient, a blanket scope expansion or an edit to the already prepared action. No additional recipient permission is inferred from a conversation, channel label or successful prior disclosure.

## Freeze and proof obligations

| Gate, all OPEN | Required before corresponding implementation/support claim |
| --- | --- |
| CHAT15-FZ01 prerequisite reconciliation | Actual merged reviewed #318/#320/#321 inputs, #322 integration inputs if used, main/source drift and #319 continuity checked. Native #321 remains intact. Review/closure is not admission. |
| CHAT15-FZ02 ingress/grounding/schema | Freeze actual authenticated HTTP/local/channel verifier, original-byte/source boundary representation, semantic resolver/language coverage/negative fixtures, strict validators and exported signatures. Demonstrate no classifier/quote/role/hash can mint power; no unnecessary second confirmation for a clear start. |
| CHAT15-FZ03 atomic policy/admission identity | Freeze one installation request namespace, receipt/source/interpretation/work queue transactions, #320 work/approval mapping, current catalogs, continuation concurrency, noncircular hashes and current authentication after waits. No complete target DDL supplied here. |
| CHAT15-FZ04 Schway/ports/bounds | Freeze exact guarded public Model/host/session/context/image/tool binding, every physical call/read charge and finite cost basis, final recipient/disclosure guards, cancellation/result paths and measured profiles. No new provider loop or private imports. |
| CHAT15-FZ05 events/delivery/recovery | Freeze current event/cursor/snapshot retention, actual owner transport and delivery dedupe/unknown states, independent monotonic facts, stop/settlement and handler-specific replay evidence. Preserve #320/#321/#322 original contexts/child charges; prove two-process/crash boundaries. |
| CHAT15-FZ06 state/adoption/experience | Respective TEAM/MEM/MIG slices freeze full data/materializers/maintenance/current-ledger/old-build compatibility. Required UX author/handoff remains separate and blocked; protocol events are not UI design. |
| CHAT15-FZ07 real acceptance | Convert these complete definitions into deterministic Bun/TypeScript tests after admission. Separately prove actual tool-backed normal conversation, general browser/admin/alternate-route enforcement, exact-build Linux/host/policy evidence and explicit owner adoption under EVID15/CUT15. RT15-01/RF15-G01–G08 remain unproven. |

Local document/link/schema/type/fixture/hash/requirement/monotonic-fact checks and `git diff --check` validate documentation only. No runtime tests/typecheck, executable/live probes, ingress/backend implementation, browser/CDP/VM/account/profile/session/provider/subscription access, provisioning, policy activation, spending/account/settings change, rollout or merge. The preparation PR uses **Refs #323**; #323 stays OPEN / blocked / needs-triage with every original implementation acceptance criterion outstanding.
