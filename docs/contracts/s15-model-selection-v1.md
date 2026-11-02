# s15-model-selection/v1

## Executable MODEL15-01 refinement (2026-11-03)

The opt-in implementation is `src/s15/model/`; exported TSDoc defines the executable API. This smaller implementation supersedes the proposed record/port materializer below. A protected registry binds approved selections to exact account, billing and recipient refs and ranks ordinary/difficult choices. Current POLICY intersections and every owner pin still apply. Alternatives stay inside the original account/provider/billing/recipient binding, including across later steps; account changes require new owner authority. Every step records the selection, reason, requested effort, adapter evidence, per-stream usage samples and native correlation. Requested or adapter-mapped effort is not provider confirmation.

`runStep` composes public `createHost`, `auth.createModel`, a forwarding `Model` and `session.submit/readResult`; Schway owns loops, retries, compaction and credentials. Each stream reserves, consumes one `guardReservation` and settles through POLICY. Context retains owner decisions and labelled source refs, whose lineage must be part of the current authority. Effect tools additionally require a responsibility guard and their owning adapter's final I/O gate. Unknown earlier calls cannot be bypassed with a new step ID. Restart is reconcile-only; `reconcile` reads existing POLICY settlement facts and never recreates a native call or result. Publication requires fresh current authority, account/availability and pins.

No monetary amount is supplied by this implementation. Metered calls without an installed budget hold with `finite_budget_required`. The owner-authorized subscription exception uses only a protected `PolicyOptions.subscriptionModels` registry, explicit finite concurrency and finite per-work calls/steps/active-time limits. It funds inference only; actions and reads retain their prior budget requirements. Subscription spend remains unknown, and an absent monetary ceiling/charge is projected as null. Usage samples deduplicate cumulative counters within each stream; a later known sample cannot erase a different unknown stream. Conservative charges never refund on settlement.

`createModelProjectionHandler` mounts authenticated read-only `GET /s15/models?workId=...` (`s15-model-budget/v1`): installation charged/measured/unknown values per ceiling, configured subscription technical limits, route availability, pins and per-work model disclosure. Filtering the selected work never hides sibling usage against an installation ceiling. No account/billing/budget mutation or visual UI is added. `src/s15/work/` supplies the [responsibility contract](s15-responsibility-v1.md). Deterministic executable evidence is in `tests/s15-model*.test.ts` and `tests/s15-model-work-*.test.ts`, including real public-host scripted execution and SIGKILL/reopen.

MG15-P01/P02/P03 below remain limits on stronger physical-dispatch, effort and cost claims: the public stream wrapper does not attest adapter-internal auth resends, enforce a provider monetary cap or prove internal computation. Production cost bounds/registry bindings must come from protected approved configuration; local fixtures prove no live account, host, VM or universal effect enforcement. S14 remains default; no installation is activated or migrated.

## Historical revision-1 proposal

Status: **proposed pre-admission contract**, revision **1**, 2026-11-02. Bounded DOCUMENTATION-ONLY preparation of [MODEL15-01 #326](https://github.com/chayapats/jit/issues/326) implementation step 1. Requirements: **FR-02/13/14/18/21/27/31; NFR-02/03/06/09; S15-AC08/S15-AC14**. Related constraints: FR-04/05/06/15/16/17/19/23/35/37/38/39/40; NFR-05/07/08/10/12/14. No FR/NFR identifier or confirmed product decision changes.

The [closed schema](fixtures/s15-model-selection-v1.schema.json), [complete synthetic inputs/outcomes](fixtures/s15-model-selection-v1.json), [fixture guide](fixtures/s15-model-selection-v1.md), [ADR 0070](../adr/0070-s15-approved-model-selection-and-disclosure.md) and [preparation record](../evidence/s15-model-contract-preparation.md) are review inputs. They deliver no executable API, final freeze, runtime/DDL, test result, installed policy, account readiness or activation. Every scenario is **UNEXECUTED documentation**. S14 remains default; `schwayChat` remains exact empty tools and `maxTurns:1`; `message.post`, `task.accept` and `work.start` retain their S14 meanings.

## Exact inputs and status

Inspected main: `64f3a94726fdbce2283aec0944884ca7406d9934`. Merged #317/#319 supplied proposed audit documents: [state transition](s15-state-transition-v1.md), blob `5e6ba001820e1f41728c8a124ed361414187e4fb`; [ADR0065](../adr/0065-s15-state-preservation-and-policy-adoption.md), blob `fb451e10fdb67064f484d02029a18cc18672c62b`. Main [ADR0064](../adr/0064-conversational-authority-and-protected-control-plane.md) is `03593d4622f55aa220b62718fd0da18cb64d8154`.

| Exact remote proposal, all OPEN/unmerged | Head and principal blob |
| --- | --- |
| #318 / [PR #345](https://github.com/chayapats/jit/pull/345), owned by chayapats | `c79aab9d098c902db0cdff7f3d649ca389fff08c`; [feasibility](https://github.com/chayapats/jit/blob/c79aab9d098c902db0cdff7f3d649ca389fff08c/docs/contracts/s15-runtime-feasibility-v1.md) `f7237a3aa7843da00d55493a127a7107263b0824`; proposed ADR0064 `08099feea574c717684099b1070a2d5fe13e1a18` |
| #320 / [PR #346](https://github.com/chayapats/jit/pull/346) | `de2a4b08f9653d01dc0766e5cefa65ac6e2b9919`; [policy](https://github.com/chayapats/jit/blob/de2a4b08f9653d01dc0766e5cefa65ac6e2b9919/docs/contracts/s15-standing-policy-v1.md) `3c1d5596cc3433eca4aaa5507a02256d3d196462` |
| #321 / [PR #347](https://github.com/chayapats/jit/pull/347) | `f6cb307b9ee56f5090960a9b737b20be6957baa6`; [VM](https://github.com/chayapats/jit/blob/f6cb307b9ee56f5090960a9b737b20be6957baa6/docs/contracts/s15-working-vm-v1.md) `6922f2ff77661ddbe64a34d0c8b5c0a33e04db35` |
| #322 / [PR #348](https://github.com/chayapats/jit/pull/348) | `7c16b7b6b08005715cacb147e0382f824674ccce`; [browser](https://github.com/chayapats/jit/blob/7c16b7b6b08005715cacb147e0382f824674ccce/docs/contracts/s15-protected-browser-v1.md) `11fc079342c7baa49ea6532bd23a37f533030819` |
| #323 / [PR #349](https://github.com/chayapats/jit/pull/349) | `c5d281b5825432a1a2dbf451233cc64f749f195b`; [conversation](https://github.com/chayapats/jit/blob/c5d281b5825432a1a2dbf451233cc64f749f195b/docs/contracts/s15-conversation-v1.md) `ad23421bbca55edd40a4602de09c47eb957c49bf` |

Full input blobs are in the preparation record. Read exact revisions as proposals, without branching from, merging, cherry-picking or copying whole prerequisite files. Reconcile **every** actor/transport/action/schema/adapter/model/cost assumption with the actual merged reviewed prerequisite revision and implementation evidence. Review or issue closure is not implementation admission. #326's native blocker remains **#323 OPEN**; #324 is not an added prerequisite. All four original criteria, labels and ownership remain intact. Main and all five active PR trees were checked; 0066–0069 are occupied, and 0070 is proposed here subject to integration recheck.

RT15-01/RF15-G01–G08 remain unproven. This proposal selects no option B, loss acceptance, reduced administration guarantee, numerical operating amount/currency period/profile or general-browser limitation replacing the confirmed target. Required Claude UX author remains unavailable under [#337's recorded limit](https://github.com/chayapats/jit/issues/337#issuecomment-6572828439); no retry, substitute, subagent or UI/UX is included.

## Static source and supported public surface

| Inspected source | Existing fact; proposed reuse boundary |
| --- | --- |
| [types.ts](../../src/s14/types.ts), [policy.ts](../../src/s14/policy.ts), [lifecycle.ts](../../src/s14/lifecycle.ts) | S14 `Route{id,provider:'codex'|'grok',model}` is exact configuration, not an authenticated account or demonstrated inference. One protected process lifecycle is shared. Environment policy is a ceiling, not standing S15 authority. |
| [chat.ts](../../src/s14/chat.ts) | Strict context, empty tools/hosted lookup off, one turn, selected public auth model, forwarding guard, native intent/correlation/retire/close. Readiness `configured-unverified` is not observed inference. No conversational tool work is implemented here. |
| [coding-model.ts](../../src/s14/coding-model.ts), [research.ts](../../src/s14/research.ts) | Current authority before streams, later inference reservations, exact selected route and public core/custom tools. They do not implement this S15 selection/account/effort/cost protocol. Research's bounded report correction is existing behavior, not authority for an S15 selection loop. |
| [authority.ts](../../src/s14/authority.ts), [authority-types.ts](../../src/s14/authority-types.ts), [graph.ts](../../src/s14/graph.ts) | Exact immutable grant intersection, current Bot/resource/route/source fences, separate inference/tool/read charges, attempt/claim identity, transport capacity and committed sibling evidence. Actual usage remains unknown where unreported. |
| [memory.ts](../../src/s14/memory.ts), [recovery.ts](../../src/s14/recovery.ts), [native-recovery.ts](../../src/s14/native-recovery.ts) | Filter before relevance, pin live decisions, retain transitive lineage, independent reservation maxima and fixed opaque correlation workspaces; boot cleanup precedes work. No provider/native reconstruction from saved text. |
| [packed consumer](../../tests/fixtures/s14-host-consumer.ts), [conformance](../../tests/s14-host-conformance.test.ts), [bridge](../../tests/schway-bridge.test.ts), [authority](../../tests/s14-authority.test.ts), [recovery](../../tests/s14-recovery.test.ts), [Bot](../../tests/s14-bots.test.ts), [context](../../tests/context-packet.test.ts), [catalog](../../tests/route-catalog.test.ts), [route options](../../tests/route-options.test.ts) | Source-only inspection of public pin/imports, exact routes, retry/compaction/usage, private/current context, finite reservations and unknown recovery. Legacy tests retain legacy scope. None was run for this preparation. Web references were read only for wiring/logic, without design. |

Schway pin: [tarball](../../vendor/schway-1.0.0-rc.2-697bf40.tgz), `1.0.0-rc.2`, upstream `697bf406a84c8d1deb8d4a6d71876ea1003be5b3`, recomputed SHA-256 `1c9d83de46edddff58a0163452e7f5ec8357e656c90093990fa28fa606a0f41b`. Package `exports` supports `schway/host`; reading a re-exported declaration's file never permits a private production import. Declarations and narrowly relevant packaged adapter source were read as inert bytes; no module was imported or invoked.

| Public declaration | Exact supported meaning and limit |
| --- | --- |
| `HostOptions` / `HostLimits` | Explicit strict context, exact tool definitions, hosted lookup off; finite turns/concurrent tools/context/input and explicit deadline/attempts. No universal output-token/cost limit or Jit authorization hook. Controlled discovery requires every `workspaceAgents/homeAgents/skills/skillActivation/packages/extensions` field; this proposal uses strict/all-off. |
| `Model.stream(request:ModelRequest,call?:ModelCallOptions)` | Provider-neutral stream composition. Request contains systemPrompt/context/items, optional freshly resolved imageData/tools/hostedTools/signal/thinking. Call options contain optional opaque promptCacheKey, not authority. The wrapper must forward options, cancellation, normalized events/errors and pinned choice; it implements no protocol/retry/compaction. |
| `HostRuntime.auth.createModel():Promise<Model>` → guarded `Model` → `HostSession.submit(input,model,options)` | Available composition candidate from #323. `submitWithRoute(input,options)` has **no caller-model parameter**. No invented before-request hook. Models are obtained through protected route binding, not constructed from serialized provider/id labels. |
| `HostAuthSelection`, lifecycle, readiness/catalog | Public routes are codex/grok. The route's credential address is not verified billed-account identity. `credentialWriteGuard` fences writes, not every read/disclosure. `checkReadiness` checks local selected store; catalog lists at most 64 choices. Neither is inference, permission, effort enforcement or a budget. Catalog/readiness operations still need bounded current authority; none was called. |
| `HostRunOptions`, usage/progress/clock | signal, fake clock and transient observer; per-attempt turn/compaction samples, completeness and duration. Null/absent counters mean unknown; zero means reported none. cached input is a subset of input, reasoning is a subset of output. Progress is neither authorization nor a final I/O hook. |
| Images/context/discovery | Public probes/resolver and reference-only images; resolver is called freshly before forwarding the request. Jit must independently guard source/access/recipient/charge before each resolution and after waits. Probes are embedder evidence, not authenticated support or sanitizer output. Native compaction must retain current owner decisions/source lineage. |
| Session/inventory | submit/compact/readResult/cancel/retire/close plus workspace-scoped metadata inventory and opaque snapshot APIs. Cancel is cooperative; busy close/retire refuse. Inventory/readResult do not dispatch or prove external settlement. No native/profile relocation/copy/promotion. |

Actual adapter identity labels differ from route names: the pinned codex route constructs provider label `codex-subscription`; grok constructs `xai`. Resolve exact trusted adapter mapping, then verify object provenance and `id`; neither matching nor mismatching labels authenticate an account. The forwarding guard refuses a wrong object/model before use and validates terminal native model identity again before reading/committing output.

### Demonstrated limits and proposed Schway requirements

These refine #323's necessary stream guard; they do not claim its candidate is an end-to-end physical-dispatch proof. There is no new native issue edge or upstream issue created here. The smallest public-only **unexecuted** counterexamples are M15-D077–D081 in the fixture guide.

1. **MG15-P01: final physical-disclosure fence.** `Model.stream` can await credentials after Jit's outer guard. Packaged `codex-subscription.ts` resolves credentials before sending; `xai.ts` can renew after 401 and send again inside the same stream. Public `HostAuthSelection`/`HostRunOptions` offer no normalized current-authority callback at each actual provider dispatch. The test-only `HostAuthFetch` exposes protocol/credential-bearing requests and is not adopted as a production policy boundary. A stream counter cannot prove one physical request, final post-renewal source authority or an individual charge for that resend. Proposed Schway requirement: a supported credential-free normalized dispatch identity/projection and protected synchronous final authorize-and-consume boundary for **each** physical attempt, including adapter-owned auth retry, after waits. Schway retains credential/protocol/retry ownership. Until a reviewed supported revision and public-only fixture prove it, governed physical-dispatch support is `public_dispatch_guard_missing`; no Jit transport interception or substitute loop.
2. **MG15-P02: exact effort evidence.** `ModelRequest.thinking` can request effort. Static codex/xai adapters map supported values and reject unsupported ones; xAI `off` without disabling support can send no control. The host's `createModel` signature does not accept account-scoped effort capability, and its route construction supplies no such capability. No public host result proves transmitted or honored effort. Proposed requirement where a pin needs it: public exact route/model effort-support and normalized sent-control observation tied to the actual dispatch. Distinguish requested, adapter-mapped and provider-reported values; provider metadata cannot prove internal computation. Unsupported/ignored/unproved pins refuse before I/O, never silently drop/downgrade. No private thinking/catalog API import.
3. **MG15-P03: enforceable cost bound.** Host limits and reported tokens do not establish a monetary upper bound. Packaged codex adapter explicitly documents that its endpoint rejects output-token caps; `maxTokens` is accepted but not enforced there. An abort at a retained-byte limit cannot undo provider computation. Admission needs independently verified finite provider/account terms or an enforceable protected quota/bound that covers all possible sends/output and cost. Missing bound yields `cost_bound_unknown`, including subscriptions. If the needed selected-route bound cannot be supplied by current provider terms/public contracts, propose the smallest supported Schway capability/refusal change; do not manufacture a token cap or free route.

This is a documentation proposal with exact artifact evidence, not an executed failing probe or a claim that a generic hook alone establishes distributed race-free authorization. The actual final ownership/linearization, account binding and enforceable bound remain MODEL15-FZ03/04. Already emitted bytes cannot be recalled. No production support record in this preparation is marked verified.

## Closed data, identity and hashing

The checked-in `$defs` are the normative exact shapes, including every fixture input/output and scalar. All properties are required, nullable values explicit, unions closed and extra keys refused. `NamedRecordV1` is a closed **type/value pair union**; a declared type must validate its actual value, including scalar types. It is not a string enum beside an unconstrained value. No implementation files are created. Proposed locations after admission: `src/s15/model-{types,validation,selection,context,reservations,schway,recovery,ports}.ts`; eventual tests `tests/s15-model-{selection,pins,disclosure,usage,recovery}.test.ts`. Freeze exported TSDoc/paths first.

Primitive semantics match the pinned #320 proposal: IDs `[A-Za-z0-9_-]{1,128}`, SHA-256 lowercase 64-hex, safe nonnegative/positive integers, epoch milliseconds, canonical nonnegative decimal minor units of at most 30 digits. Exact Unicode/content bytes; no trimming, normalization, newline rewriting or redaction after hashing. Reject negative zero, overflow, fractions/nonfinite numbers, invalid Unicode, prohibited controls, duplicate JSON keys before parse loses them, accessors/prototypes/cycles/sparse arrays and credential content before ordinary persistence. Credential detection is not proof all arbitrary secrets are recognized. Protected secrets/state never enter guest/models/prompts/logs/ordinary exports.

`C(x)` is compact JSON with ASCII keys sorted by UTF-16 code units, arrays in declared order, standard JSON escaping and integer spelling, no BOM/trailing LF. `H(d,x)=SHA256(UTF8(d+'\n'+C(x)))`; omit only that containing record's own `hash`, retaining nested hashes. Domain suffixes are exactly `route.v1`, `cost.v1`, `support.v1`, `policy.v1`, `scope.v1`, `context.v1`, `proposal.v1`, `plan.v1`, `receipt.v1`, `call.v1`, `charge.v1`, `claim.v1`, `result.v1`, `facts.v1`, each after the common `s15.model.` prefix. Raw blobs/BytesV1 hash raw bytes. Canonical padded RFC4648 base64, decoded length and raw hash must agree. Hashes prove bytes, never actors, account identity, policy matching or remote occurrence. Reference sets sort by canonical UTF-8, are unique by ID within their field's catalog, and never mean wildcard when empty.

| Named record | Exact responsibility |
| --- | --- |
| `AccountRouteV1`, `ModelIdentityV1`, `SupportV1` | Current route/account/billing/credential-owner epoch/recipient binding; exact adapter model mapping; separately versioned capability/evidence facts. Catalog data cannot register those bindings or prove live availability. |
| `CostBasisV1` | Exact route/account/billing/budget/currency, finite per-I/O upper bound, maximum physical sends per stream, cleanup inclusion, enforcement basis/evidence and validity. `PlanV1.costBasis` resolves the complete immutable canonical bytes of this closed type, not arbitrary pricing prose. Synthetic enforcement is never production proof. |
| `SelectionPolicyV1`, `PinsV1`, `AuthorPinV1` | Exact approved selections and deterministic ordinary/difficult/alternative orders; approved bootstrap choice and finite ceilings. Each explicit route/model/effort/author pin intersects, never relaxes, standing ceilings. Author responsibility is distinct from Schway's supported route list. |
| `ScopeV1` | Installation/current continuity, actual owner/request/original receipt, authenticated purpose, current policy/hash/Bot/resources/recipients/budget, and optional existing work authority/hash. It is a resolver projection, not a serialized actor. Bootstrap may lack execution authority; execution cannot. |
| `SourceV1`, `ContextV1`, `RequestProjectionV1` | Immutable original source/decision/lineage/access references, exact labelled bytes and full public request projections including system/sections/items/images/tools/hosted lookup/thinking/cache affinity. Derived summaries retain all ancestor restrictions. A source/metadata field cannot choose a route. |
| `ChoiceProposalV1`, `PlanV1` | Untrusted narrowing suggestion versus protected grounded selection and rationale/evidence. The plan binds scope/selection/account-route/support/context/pins/finite bounds/cost basis before I/O. No self-approval or inferred difficulty allowance. |
| `SelectionReceiptV1` | Dedupe acknowledgement of the exact committed plan/slot. It precedes all child charges/claims/results and never hashes future facts. Existing #323 ingress receipt precedes the plan. |
| `CallV1`, `ChargeV1`, `ClaimV1` | Exact request/plan/stream/physical ordinal/phase/projection/source/recipient and original finite reservation identity, nonrefundable charged vector and claim. A parent/run charge is not a new child charge. Call hash precedes charge; charge precedes claim; claim precedes dispatch. |
| `UsageSampleV1`, `EffortObservationV1`, `ResultV1` | Actual/partial/unknown samples and effort evidence, exact native result identity and sanitized retained output/lineage. Samples are not additional charges. A model completion is not product completion. |
| `DispatchFactV1`, `FactsV1`, `ReadResultV1`, `CancelObservationV1` | Explicit physical dispatch time and complete recorded snapshot time; independent claim/dispatch/capture/channel/process/input/network/publication/cancel and usage facts; current guarded read/publication; original-scope cleanup. Rejected proof never erases retained facts. |
| `ExternalRecordV1` | Complete canonical projection of an exact reviewed prerequisite scenario, including original child charge history. It retains independent owning-service facts without becoming model context, a serialized actor or dispatch authority. |

`RequestProjectionV1` uses complete immutable byte blobs for public system/section/item records and exact registered tool schema refs, plus ordered image refs and safe call options; the blob table supplies every byte. Before forwarding, the trusted adapter must compare **all** actual ModelRequest fields to that projection, account for imageData by exact hash/length, reject unknown fields/hosted lookup and verify the exact registered tools. The projection is not a provider-wire serializer or a substitute native format. Input source refs include every uncited/transitive source and metadata-bearing content; matching selected quotes is insufficient. Complete normalized request byte accounting includes escaping, tool schemas, source labels and base64 expansion wherever actually serialized.

## Bootstrap and selection without circular authority

1. The real owner ingress authenticates and commits original request/source/receipt under #323 before model interpretation. Role labels, forwarded/quoted text, provider IDs, hashes, memory, source/model output or catalogs authenticate nobody. The owner mutation port and policy installer are unavailable to model/work code.
2. Protected resolution establishes the current **bootstrap purpose**, permitted source/recipient/Bot/account-route, applicable original-byte pins and finite budget/cost basis **before** retrieval, decoding, catalog/readiness or inference. Bootstrap is only interpretation of this actual request, never permission to implement a merely inspected/accepted task. Missing bootstrap authority/recipient/bound holds without a model call. Undecidable material pin/scope cannot be resolved by disclosing private data to a guessed model.
3. Build the context after access filtering and separately charged necessary reads. The owning #323 `InterpretationPortV1.context(context, interpretationPlan)` uses its **already admitted InterpretationV1**, which binds original receipt/current bootstrap selection/source scope/recipient/budget but has no future context hash. Its exact read query/slot is charged before I/O through #323's original charge domain. Only after that read returns and current guards pass is the complete packet hashed and passed to model-selection preparation. Do not require a Model PlanV1/context hash to authorize the read that creates it. For execution/context changes, the owning current work/read service must supply the equivalent already admitted noncircular read slot; its exact materializer remains a prerequisite freeze gate. Already-held injected bytes need no invented new I/O. Include original owner request and every applicable current owner decision; retain exact source revisions, privacy/recipient restrictions, contradictions and omissions. If pinned decisions alone cannot fit, hold `context_too_large`; never drop them, invent a summary authority or expand recipient/context silently. Every subsequent image resolution has its own source/current publication guard and exact original child reservation before read, then guard again after the wait and at model disclosure.
4. Protected selection intersects current standing policy, actual authenticated purpose/work, Bot/resource/data restrictions, account/billing route, recipient, explicit pins, current support and remaining finite budget. Ordinary/difficult ordering ranks only that intersection. A difficult-task recommendation and its evidence can change rank within the approved list, not authorize a new method/purpose/account. Record classification, ordered eligible choices, selected actual choice and rationale/evidence. Untrusted proposed choices can only narrow; malformed/authority-bearing proposals refuse.
5. Commit one plan/selection receipt under a protected logical request/selection slot. No model I/O is implied by this receipt. Before each physical call/read/image/catalog operation, commit its exact finite child charge and claim against current continuity. Current authority/expiry/pins/source/recipient/account route/support/final bytes are rechecked after waits and at actual dispatch. Lost/consumed/recovered contexts cannot continue original dispatch.
6. A permitted product-level alternative is a **new admitted plan**, with new slot/receipt/current context and explicit failed/settled prior selection evidence, charged through the same original work/budget continuity. It is not a Schway transient retry. Require approved alternative order, unchanged account/provider/billing/recipient and compatible pins/data scope; a route alias is insufficient. Unknown calls/effects remain reconcile-only and cannot be rekeyed as alternatives. Preserve prior results/charges; no wrong-model result or stale native context reuse.

Required `claudeAgent / claude-opus-5-5 / high` authorship is an exact responsibility pin. With that author unavailable, return `required_author_unavailable`; do not map it to codex/grok, retry Claude, substitute a model, author design or infer readiness from a catalog. This preparation itself uses inherited Codex settings only.

## Trusted ports and concrete result paths

These are **proposed documentation signatures**, not exports. Opaque handles are privately issued and identity-registered at protected composition; TypeScript brands/frozen objects/JSON do not authenticate. Revalidate registry/current generation after lock acquisition and every wait. Qualified `Policy.*` and `Chat.*` types refer to the pinned unmerged proposals and remain subject to reconciliation.

```ts
import type { Model, HostProgressEvent, HostImageResolver } from 'schway/host';
declare const workerBrand: unique symbol, selectionBrand: unique symbol;
declare const callBrand: unique symbol, cleanupBrand: unique symbol;
interface ModelWorkerV1 { readonly [workerBrand]: true }
interface SelectionContextV1 { readonly [selectionBrand]: true }
interface CallContextV1 { readonly [callBrand]: true }
interface CleanupContextV1 { readonly [cleanupBrand]: true }
interface ModelSelectionPortV1 {
  /** Resolve exact committed request/current policy; no model/read side effect. */
  prepare(worker: ModelWorkerV1, request: RefV1,
    proposal: ChoiceProposalV1, packet: ContextV1): PlanV1;
  /** Current writer guard, shared request key and one logical selection slot. */
  accept(worker: ModelWorkerV1, plan: PlanV1): SelectionReceiptV1;
  /** New admission rejects any existing call claim. Already aborted refuses. */
  dispatch(worker: ModelWorkerV1, receipt: RefV1,
    signal?: AbortSignal): Promise<FactsV1>;
  /** Exact retained native result only; no invocation or fallback. */
  readResult(worker: ModelWorkerV1, result: RefV1): Promise<ReadResultV1>;
  /** Recheck current lineage/recipient/hash/stop, then trusted synchronous use. */
  publishResult(worker: ModelWorkerV1, result: RefV1, resultHash: Hash,
    consume: (result: ResultV1, output: Uint8Array) => void): void;
  cancel(worker: ModelWorkerV1, receipt: RefV1): Promise<CancelObservationV1>;
  /** Metadata/fact reconciliation with its own finite read charge; no resend. */
  reconcile(worker: ModelWorkerV1, claim: RefV1): Promise<FactsV1>;
}
interface ModelPolicyPortV1 {
  current(context: SelectionContextV1): ScopeV1;
  /** Pure current access/projection validation; no read authorized by a future
   * context hash or an uncommitted model-selection plan. */
  validateContext(context: SelectionContextV1, scope: ScopeV1,
    selection: SelectionV1, packet: ContextV1): void;
  /** Exact physical child reservation/claim; never funded only by a parent. */
  claim(context: SelectionContextV1, call: CallV1): ClaimV1;
  /** Registered original unconsumed context and exact committed charge;
   * current final check/use, no incremental allowance or second charge. */
  continueOriginal(context: CallContextV1, call: CallV1,
    projection: RequestProjectionV1): void;
}
interface ModelContextPortV1 {
  /** Calls the owning #323 context port using its already admitted bootstrap
   * plan/read slots; validates its complete current packet before mapping.
   * Chat.* are exact proposed #323 types, not current Schway exports. */
  fromInterpretation(context: Chat.InterpretationContextV1,
    interpretation: Chat.InterpretationV1, scope: ScopeV1): Promise<ContextV1>;
}
interface ModelSchwayPortV1 {
  /** Uses auth.createModel -> guardModel -> session.submit, with explicit
   * imageRoute for images and a verified final physical fence. No retry loop. */
  invoke(context: SelectionContextV1, plan: PlanV1,
    signal: AbortSignal, progress: (event: HostProgressEvent) => void):
    Promise<ResultV1>;
  guardModel(context: SelectionContextV1, plan: PlanV1, model: Model): Model;
  imageResolver(context: SelectionContextV1, plan: PlanV1): HostImageResolver;
  /** Resolve only original retained cleanup; memoized once per native scope. */
  cancel(context: CleanupContextV1): Promise<CancelObservationV1>;
}
```

No signature above invents a currently available Schway final-dispatch callback. MG15-P01 specifies the missing upstream requirement. `guardModel` is necessary public forwarding; actual governed invocation remains unavailable until final physical-dispatch support is proved. A future supported public callback would call the protected `claim/continueOriginal` ports for each exact physical slot; its public name/shape/version is **not frozen here**. Do not turn this sentence into an undocumented callback/side channel. The context adapter accepts no model-provided reader or endpoint; its owning private #323 port/registered interpretation context supplies the original read authority. It rechecks the actual interpretation/receipt/purpose/selection/source/recipient/budget and complete packet after waits. A model plan or packet hash never retroactively funds a preparation read.

Real result path: registered worker → prepare/accept → finite claim → public guarded Schway invocation → exact native terminal identity → guarded `session.readResult` → sanitized immutable ResultV1/usage/evidence retention → `readResult` → **synchronous `publishResult`** → #323 committed reply/owner delivery. Provisional model deltas/thinking/raw errors never bypass that path or become evidence. The trusted synchronous consumer gets exact validated bytes without a wait; asynchronous image/file/channel handoff reacquires its current final byte guard. Actual extra read/delivery has a separate charge. Ordinary output to the authenticated owner needs no send-to-others approval; another endpoint/private recipient remains a separate gate.

VM tools preserve #321 actor-bound prepare/accept, signal-aware dispatch, guarded readResult, synchronous publishResult and original-scope memoized cancellation. Browser tools preserve #322 independent input/network/capture/channel/scope/process facts and the same protected **action-or-read emitter**. An original child read at zero remaining allowance needs its **already committed exact child charge/history**, not just a charged parent. Directional complete frame bytes include headers; they are distinct from decoded image/output BytesV1. Model output/stop cannot rewrite these owning-service facts or confer alternative VM/browser/script/MCP effect authority.

## Accounting, bounds and lifecycle

`PlanV1.upperBound` is a ceiling, not a paid child reservation. `ChargeV1` is an immutable, nonrefundable exact debit in current continuity. `ClaimV1` binds that charge/call before I/O; receipt/charge/claim identities are never reconstructed from labels. Physical calls, image/additional source reads, reconciliation, catalog/network discovery and actual delivery use their own slots. A current original unconsumed call context may continue its exact already charged reservation at zero remaining allowance. A new call/child without its charge must satisfy incremental allowance; zero refuses without I/O or a new charge. Repeated guards do not debit twice. Cleanup/fact capture headroom is reserved before ordinary work and cannot be exhausted by it.

All applicable installation/work/policy/rule/account-route/resource ceilings and actual unsettled capacity are checked atomically, without a database transaction held over external I/O. Reserve conservative **enforceable** finite upper bounds including adapter physical sends, retry/compaction, images, output, cleanup and record retention, with exact currency/cost basis. Unknown/unbounded cost holds. A subscription or missing token telemetry never means zero/free/infinite. No automatic refund, new period/account/work ID reset, rekeying or hidden fresh allowance. Settlement releases actual concurrency only.

Usage is a separate observation: one sample per physical identity, or explicitly uncorrelated/incomplete when public evidence cannot identify it. Deduplicate repeated cumulative samples from the same call; do not sum an interim and final total or count HostRunUsage and observer events twice. Cache counters are subsets of input; reasoning counters are subsets of output. Unknown samples contaminate completeness; a later known sample cannot erase an earlier different unknown physical call. Report known components and unknown cost explicitly. Retained output-byte truncation, provider refusal, quota, cancellation and unsuccessful calls retain their charges. A cost observation above the reserved bound is an integrity/support incident: stop future admission, retain full actual/unknown facts and capacity; never cap the observation to hide the overrun or infer permission to spend more.

| Hard protocol ceiling, configurable only downward | Bound; no operating allowance selected |
| --- | --- |
| Ordinary canonical record / context / depth | 131072 / 262144 UTF-8 bytes; depth <=16, <=128 properties/object, <=256 entries/array, reference sets <=64. A complete ContextV1 includes base64/labels/metadata, separately from decoded labelled text. |
| Labelled text / output / source | <=131072 context text, <=32768 retained output, <=1048576 immutable source/image bytes each; <=4 images and <=4 MiB combined decoded image data. Smaller complete request/record/policy bounds also apply. No automatic inline promotion of a large source. |
| Selection / interpretation / run | <=30000 / 30000 / 3600000 ms absolute deadline including queues/waits; monotonic time plus wall-clock policy expiry, never extended by reconnect/clock rollback. <=4 interpretation physical calls, <=64 run physical calls, <=64 reads, <=32 native turns, <=8 Schway attempts/turn. Product policy is usually stricter. |
| Queue / active / cleanup / reconciliation | <=16 pending selections/work; <=8 active native runs/installation, narrower route/Bot/resource ceilings; <=5000 ms cleanup and <=30000 ms observation. Unsettled calls keep capacity. No deadline reset on alternative/restart. |
| Resources / identity retention | Explicit finite CPU ms, memory bytes, PIDs, storage bytes, record count and cost bound in every registered profile. <=100000 protected identity entries/installation; finite custody is checked before admission. Exhaustion refuses new work instead of evicting request/claim/withdrawal/charge identity. No profile sizing is selected here. |

Every additional native stream for a Schway retry/compaction uses the same live plan/choice/pins and a separately charged exact physical child. Forwarding checks the complete current request; compaction must retain all live owner decisions/ancestor restrictions. Provider cache affinity/native summaries are data, not replacement context authority. New selection/context changes retire incompatible native contexts after actual settlement and create fresh authorized contexts; never reopen stale context to recover an answer or silently move fixed workspaces. Cached images must not bypass fresh resolver access/current disclosure checks.

Stop/revoke immediately fences new claims/dispatch/late content publication. Register abort before the first wait; an already-aborted signal refuses before claim. Abort after claim latches denial and invokes the **same memoized original-scope cancellation** as explicit stop. Cleanup uses retained registered authority only for that exact native/transport scope, never a new model call, account switch or whole shared VM stop. `session.cancel()` is synchronous cooperative request; await actual invocation/transport settlement before close/retire. Rejected stop/owner-statement evidence cannot erase captures, input/network facts, known channel closure, charges, usage or prior settlement. Valid proof settles only its exact scope; historical remote outcome may remain unknown.

| Boundary | Required finite outcome |
| --- | --- |
| Same request/slot/hash reconnect | Reauthenticate, return original receipt/current authorized projection; zero new plan/charge/call/delivery. Changed payload/domain conflicts. Query does not retry a model. |
| Restart before receipt | No plan/claim acknowledgement; genuine authenticated retry may commit once under current authority. |
| Receipt committed, no claim | Current scheduler may create a new bounded call only under reviewed current admission rules. A receipt alone grants nothing. |
| Claimed or possibly sent | Preserve exact claim/charge and actual/unknown usage/capacity; reconcile-only. No blind retry/alternative/rekey, even for an allegedly read-only model. |
| Lost/consumed original context | Cannot reconstruct final dispatch from durable JSON. An original exact charge does not make a recovered claim dispatchable. |
| Result retained / publication pending | Recheck native identity, current source/recipient/access/stop and immutable result bytes, no rerun. Historical authorized owner inspection is distinct from late result delivery. |
| Quota/unavailable/refusal | Record safe category and actual choice/usage. A known settled terminal failure may support a new approved alternative under current authority; unknown outcome cannot. Refusal is no permission to evade content/purpose restrictions. Pinned choice never silently falls back. |
| Expiry/capacity/unknown budget | Hold/refuse with safe reason and preserved known facts. Further independent authorized work may continue only within its own existing scope/budget. No budget increase or new account. |

## Error order and exact refusal vocabulary

`CodeV1` is closed in the schema. Evaluate: actual actor/ingress authentication → strict shape/byte/hash/credential validation → current continuity → same-key receipt/conflict → current owner/policy/work/Bot/resource/route/account/recipient/source/pins/stop/expiry → supported adapter/effort/final-dispatch/cost bound → finite incremental budget/capacity → classification/alternative/product result conditions. Existing original-context continuation skips only new-claim/remaining-incremental tests for its exact paid call. Publication checks its own current authority and expects the producing claim.

| Codes | Meaning |
| --- | --- |
| `actor_unregistered`, `invalid_shape`, `invalid_bytes`, `hash_mismatch`, `credential_boundary`, `continuity_unavailable`, `request_conflict` | Refuse before any protected dispatch; no raw diagnostic payload. |
| `scope_stale`, `outside_purpose`, `policy_revoked`, `owner_changed`, `bot_disabled`, `resource_stale`, `route_changed`, `account_changed`, `recipient_unapproved`, `source_withdrawn`, `pin_conflict`, `expired`, `stopped` | Current authority/context or pin failed. No alternate route repairs authority. |
| `bootstrap_required`, `context_too_large`, `image_unavailable`, `effort_unsupported`, `effort_ignored`, `effort_unproven`, `required_author_unavailable`, `route_unavailable`, `quota_exceeded`, `model_refused` | Honest scope/support/terminal state; only independently authorized eligible alternatives may proceed. |
| `public_dispatch_guard_missing`, `cost_bound_unknown`, `budget_exhausted`, `capacity_busy`, `claim_exists`, `context_lost`, `context_consumed`, `reconcile_only` | Missing public/enforceable admission requirement, finite budget/capacity or original-context identity. No automatic retry. |
| `wrong_model`, `result_unavailable`, `publication_withheld`, `cancelled`, `usage_invalid`, `usage_bound_exceeded`, `protocol_error` | Preserve actual/unknown usage, claims and independent facts; no false completion/refund. |

## Continuity, human gates and freeze obligations

Preserve ADR0065's **one current continuity authority**, original request/receipt/claim/charge identities, all usage/withdrawals/policy revocations and source bytes across adoption/rollback. Old grants/approvals/routines/queues stay nondispatchable; no inherited numeric allowance/account/budget/model readiness. S14-private accounts/data and receiver restrictions remain before team relevance. Keep fixed opaque native workspaces; no raw native/profile relocation/copy/promotion. Full runtime/DDL/storage materializers/real transports/brokers/platform/build proof, permanent-Bot policy and Jod integration remain their slices. Unsupported reverse projection keeps both runtimes fenced.

Normal authenticated-owner output is distinct from communications to others. Human-required communication/payment/production/new-recipient/major-change gates remain outside working-agent authority across model, shell, VM, browser, script and MCP paths. Product-default GitHub publication/replies require approval; bounded installed personal exception, separate merge authority and production holds persist. Selection receipts/cost budgets cannot approve any of those effects.

| Gate, all OPEN | Required evidence before corresponding admission/support claim |
| --- | --- |
| MODEL15-FZ01 | Actual merged reviewed #318/#320/#321/#322/#323 revisions, unchanged S14/source audit, current native #323 prerequisite and no competing work; reconcile all proposal assumptions. |
| MODEL15-FZ02 | Frozen actor/worker issuance, original-owner-byte pin/purpose grounding, route/account/billing/recipient/resource/model/effort catalogs and exact selection/alternative ranking; opaque private registries and complete typed resolver schemas. |
| MODEL15-FZ03 | Public Schway final physical-dispatch support for MG15-P01, exact adapter mapping/effort evidence for MG15-P02, public-only deterministic barriers and no private imports/protocol/loop. Synthetic future-port setup proves none of these. |
| MODEL15-FZ04 | Enforceable per-route/account cost basis/physical-call/output/resource bounds for MG15-P03, actual current finite allocation and atomic nonrefundable child charges/claims/cleanup headroom. No amount/profile was chosen. |
| MODEL15-FZ05 | Full request/context/image/compaction/source lineage and original-decision preservation, guarded retained result/read/synchronous publication, signal-aware memoized cancellation and independent VM/browser facts; actual adapters/linearization. |
| MODEL15-FZ06 | Complete storage/continuity/materializer/crash/reconnect/restart/adoption/rollback mapping, identity/capacity retention, current-ledger/old-build enforcement and reconcile-only unknown claims. |
| MODEL15-FZ07 | Convert every UNEXECUTED definition to admitted Bun/TypeScript scripted-model/fake-clock/protocol fixtures; separately prove exact-build provider/VM/browser/platform behavior through explicit opt-in work, required UX author/handoff, EVID15/CUT15 and unresolved RT15/RF15 gates. |

Static document/schema/type/fixture/hash/link/requirement/monotonic-fact/causal-time checks and `git diff --check` validate only these artifacts. Runtime tests/typecheck, executable probes and live model/provider/account/catalog/readiness/session/VM/browser operations are neither required nor claimed. The proposed PR uses **Refs #326**, leaves #326 OPEN and authorizes no merge.
