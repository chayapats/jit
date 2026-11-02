# Synthetic model-selection definitions

Status: **UNEXECUTED documentation**, revision 1, 2026-11-02. This is not a passing scenario/test suite, present provider support, installed authority or runtime admission. [Contract](../s15-model-selection-v1.md), [closed schema](s15-model-selection-v1.schema.json), [complete JSON](s15-model-selection-v1.json), [ADR0070](../../adr/0070-s15-approved-model-selection-and-disclosure.md), [preparation record](../../evidence/s15-model-contract-preparation.md).

## Reading the complete inputs

The JSON is one standard schema-valid document. Each `worlds` entry supplies a complete setup, input, retained state, ordered future events and expected outcome; no field patches, omitted constructor defaults or executable fixture factories are required. All immutable blob bytes resolve through the checked-in `blobs` table, including exact source/owner/decision/request/native-item/context/image/output/cost/evidence bytes. Each blob has complete base64, decoded length and raw SHA-256. The file uses one complete world/example per line to avoid repeated indentation; this guide is its human-readable index.

Every named data definition has a complete directly validated example. `NamedRecordV1` is a closed union of exact `type` and corresponding `value`, including scalar `CodeV1`, `EffortV1`, `Minor`, `Nat` and `Text`. The structural root/wrapper definitions are validated by the document itself. Eight malformed whole-document counterexamples reject mismatched declared/value types, unknown scalars/types and additional keys through the actual checked-in root schema; these are static schema checks, not model behavior tests.

`FixtureSetupV1.ports.origin:'future_fake_ports_only'` is a recipe for future registered trusted-port fakes. Worker/model-object registry membership, grounding, current authority, bootstrap, account/support/cost and publication verdicts **must be established by those fakes independently of JSON**. They are never deserialized authentication, a usable actor/permit or proof of a real account. `SupportV1.evidenceScope:'synthetic_future'`, `finalDispatch:'verified_fake'` and image support describe that future fake only. `static_unproven`/`missing_public` worlds document current public-surface limitations. No production support is verified here.

Context preparation is noncircular: the owning #323 InterpretationV1 binds the original receipt/current bootstrap scope and finite exact read slots before context I/O. Only after its guarded context read returns does the adapter hash the packet and pass complete `InputsV1.packet` to model `prepare`. The model-selection plan/hash never authorizes the read that creates its own context. Execution context changes require equivalent already admitted owning work/read authority; actual materializers remain freeze gates.

Setup sources are already-held immutable synthetic bytes injected into the future fake; setup catalog/readiness values are prescribed fake resolver results, not an uncharged live lookup or prior observed provider call. The baseline has no prior operational charges. Any real additional source/image/catalog/readiness/reconciliation/delivery I/O must first obtain its own current scope and finite exact child reservation. `retained` alone declares facts/charges/results already present at scenario start; `steps.scriptedResult` is a future response, visible only at its causal capture step. An expected result is not copied into retained facts before creation.

The synthetic request is an inspection, not implementation admission. Its full command and original #323 receipt bytes are supplied and hashed with the pinned external contract domains. Bootstrap M15-D025 has only `interpret_current_request` purpose and null execution authority. M15-D027's acceptance-only grounding cannot authorize execution. None of the synthetic values chooses a real budget/profile, amount/currency period, account, model availability or runtime default.

## Identity, accounting and time

A selection plan/receipt precedes its children. Plan `upperBound` is a ceiling, not a paid child. Each `CallV1` binds plan/receipt/slot, stream, physical ordinal, exact request projection, sources, recipient, route, cost basis and finite upper bound. Ordinals are monotonic within the plan; stream IDs group native invocations without resetting that identity. Each immutable `ChargeV1` precedes its `ClaimV1`; each `DispatchFactV1{callHash,dispatchedAt}` follows its exact claim. `FactsV1.recordedAt` dates the complete known snapshot. A new native retry/compaction or adapter-internal physical resend has a separate child identity/debit. No model retry loop is executed by this document builder or checker.

The ordinary timeline uses epoch `1800000000000`: original ingress receipt at +0, context +5, plan +6, selection receipt +10, call +11, charge +12, claim +13, dispatch +14, retained result/capture +20 and eligible final publication +21. Alternatives/second children have explicit later times in their complete records. Retained receipts/charges/results are no later than setup time; events never precede them. Expiry refusal uses the actual advanced setup time. Hashes include every corrected timestamp. An event with equal time denotes one ordered synchronous boundary; array order still matters.

`ExpectedV1.calls` lists call descriptors emitted in this scenario; a charged child refused at final dispatch remains fully present in its charge/claim event and final facts. `counts` counts new plans/debits/physical model calls/reads/result reads/publications/cancellations during the scenario, separately from prior retained history. Repeated original guards do not repeat a debit or send. Actual per-call usage and aggregate facts remain distinct from conservative charged vectors; cumulative sample duplicates do not sum, cached/reasoning counters remain subsets, and unknown fields remain unknown. Unknown cost/usage is never zero. Every original charge's full identity/vector/time remains unchanged through stop/recovery/publication.

M15-D037/D091/D099 allow only an original registered unconsumed already charged child at zero remaining allowance. D038–D041/D092/D096 refuse consumed/lost/recovered/duplicate contexts. D052 refuses a new browser read funded only by a retained parent model charge; its parent charge/result are prior retained facts, not future calls performed at zero allowance. D093/D094 retain both charges after a final revoke while recording only the first physical dispatch. D103 pays image resolution and model disclosure separately; D104 revokes after paid resolution and creates no model child. No raw image decoder, browser capture or probe ran.

M15-D090 retains two complete canonical scenario projections from the exact reviewed #322 fixture blob: BROW15-D100 and BROW15-D103. `ExternalRecordV1` records exact source head/blob/scenario plus complete snapshot bytes. All contained original records, hashes, times, child charge histories and expectations are unchanged. They remain independent browser facts, outside the model context and never promoted into dispatch authority. Their older synthetic clock is preserved rather than retimed. Keeping these bytes is not executing either browser scenario, authenticating its actor or adopting the unmerged contract. The model stop cannot erase the original paid-child continuation/new-child refusal distinction.

## Input → expected outcome index

The full bytes and precise stages are in the JSON. Every row below has status **UNEXECUTED**. An allow/recorded outcome is a prescribed result of future fake trusted ports, not a claim that the pinned production host supplies the missing final fence. For malformed input worlds, `input.untrusted` contains the exact raw bytes to reject; the rest of the world remains complete valid documentation data.

| ID | Complete input case | Expected disposition / exact code | New plans / charges / model calls / reads / publication |
| --- | --- | --- | --- |
| `M15-D001` | Ordinary work selects the first current approved ordinary choice | allow | 1 / 0 / 0 / 0 / 0 |
| `M15-D002` | Difficult work selects the approved difficult model and high effort | allow | 1 / 0 / 0 / 0 / 0 |
| `M15-D003` | Explicit route pin intersects the same approved route | allow | 1 / 0 / 0 / 0 / 0 |
| `M15-D004` | Explicit model pin selects the difficult model within current budget | allow | 1 / 0 / 0 / 0 / 0 |
| `M15-D005` | Explicit effort pin is recorded as high and never downgraded | allow | 1 / 0 / 0 / 0 / 0 |
| `M15-D006` | Conflicting owner route pin refuses before model creation | hold / `pin_conflict` | 0 / 0 / 0 / 0 / 0 |
| `M15-D007` | Conflicting model pin cannot be replaced by an ordinary choice | hold / `pin_conflict` | 0 / 0 / 0 / 0 / 0 |
| `M15-D008` | Unsupported explicit effort is held without a default | hold / `effort_unsupported` | 0 / 0 / 0 / 0 / 0 |
| `M15-D009` | Ignored explicit effort cannot satisfy its current pin | hold / `effort_ignored` | 0 / 0 / 0 / 0 / 0 |
| `M15-D010` | Unknown effort support is not inferred from readiness | hold / `effort_unproven` | 0 / 0 / 0 / 0 / 0 |
| `M15-D011` | Unavailable required Claude author is preserved without retry or substitute | hold / `required_author_unavailable` | 0 / 0 / 0 / 0 / 0 |
| `M15-D012` | Known selected model unavailable and pinned means no fallback | hold / `route_unavailable` | 0 / 0 / 0 / 0 / 0 |
| `M15-D013` | Quota failure never enables API key billing | hold / `quota_exceeded` | 0 / 0 / 0 / 0 / 0 |
| `M15-D014` | Provider refusal is not authorization to change purpose | hold / `model_refused` | 0 / 0 / 0 / 0 / 0 |
| `M15-D015` | Unknown selected account binding holds even with matching route strings | hold / `account_changed` | 0 / 0 / 0 / 0 / 0 |
| `M15-D016` | Changed billed account refuses under the original policy | hold / `account_changed` | 0 / 0 / 0 / 0 / 0 |
| `M15-D017` | Unapproved private inference recipient refuses before context assembly | hold / `recipient_unapproved` | 0 / 0 / 0 / 0 / 0 |
| `M15-D018` | New provider in an untrusted proposal cannot widen approved selections | deny / `invalid_shape` | 0 / 0 / 0 / 0 / 0 |
| `M15-D019` | Model output cannot authenticate the owner or approve itself | deny / `invalid_shape` | 0 / 0 / 0 / 0 / 0 |
| `M15-D020` | Copied worker object cannot call protected selection ports | deny / `actor_unregistered` | 0 / 0 / 0 / 0 / 0 |
| `M15-D021` | Absent registered worker refuses before source reads | deny / `actor_unregistered` | 0 / 0 / 0 / 0 / 0 |
| `M15-D022` | Missing current continuity cannot bootstrap an empty ledger | deny / `continuity_unavailable` | 0 / 0 / 0 / 0 / 0 |
| `M15-D023` | Conflicting continuity refuses all admission | deny / `continuity_unavailable` | 0 / 0 / 0 / 0 / 0 |
| `M15-D024` | Untrusted classification cannot establish a bootstrap scope | hold / `bootstrap_required` | 0 / 0 / 0 / 0 / 0 |
| `M15-D025` | Approved bootstrap selects only interpretation with finite scope | allow | 1 / 0 / 0 / 0 / 0 |
| `M15-D026` | Report-only request remains inspection after difficult selection | allow | 1 / 0 / 0 / 0 / 0 |
| `M15-D027` | Acceptance-only obligation cannot supply an execution selection | deny / `outside_purpose` | 0 / 0 / 0 / 0 / 0 |
| `M15-D028` | Material unresolved purpose or pin cannot be guessed by classification | hold / `outside_purpose` | 0 / 0 / 0 / 0 / 0 |
| `M15-D029` | Withdrawn original source refuses before retrieval or model I/O | deny / `source_withdrawn` | 0 / 0 / 0 / 0 / 0 |
| `M15-D030` | Changed source revision invalidates a previously constructed packet | deny / `scope_stale` | 0 / 0 / 0 / 0 / 0 |
| `M15-D031` | Pinned owner decisions larger than context hold without dropping them | hold / `context_too_large` | 0 / 0 / 0 / 0 / 0 |
| `M15-D032` | Missing current image source prevents admission before resolver I/O | hold / `image_unavailable` | 0 / 0 / 0 / 0 / 0 |
| `M15-D033` | S14-private source does not become team model context | deny / `recipient_unapproved` | 0 / 0 / 0 / 0 / 0 |
| `M15-D034` | Unknown cost stays unknown on a subscription | hold / `cost_bound_unknown` | 0 / 0 / 0 / 0 / 0 |
| `M15-D035` | Zero remaining allowance refuses a new model child | deny / `budget_exhausted` | 0 / 0 / 0 / 0 / 0 |
| `M15-D036` | Unsettled prior transport retains route capacity | hold / `capacity_busy` | 0 / 0 / 0 / 0 / 0 |
| `M15-D037` | Paid original call continues at zero remaining allowance without recharge | allow | 0 / 0 / 1 / 0 / 1 |
| `M15-D038` | Consumed original context cannot redispatch even with its exact charge | deny / `context_consumed` | 0 / 0 / 0 / 0 / 0 |
| `M15-D039` | Lost context cannot reconstruct dispatch from claim JSON | reconcile_only / `context_lost` | 0 / 0 / 0 / 0 / 0 |
| `M15-D040` | Recovered paid claim is reconcile-only rather than replayable | reconcile_only / `reconcile_only` | 0 / 0 / 0 / 0 / 0 |
| `M15-D041` | New dispatch rejects an already claimed physical slot | deny / `claim_exists` | 0 / 0 / 0 / 0 / 0 |
| `M15-D042` | Successful guarded result retains native identity and publishes once | allow | 0 / 1 / 1 / 0 / 1 |
| `M15-D043` | Wrong terminal native model is retained as protocol evidence but withheld | withheld / `wrong_model` | 0 / 1 / 1 / 0 / 0 |
| `M15-D044` | Unknown token and cost telemetry retains the entire conservative charge | allow | 0 / 1 / 1 / 0 / 1 |
| `M15-D045` | Cache input and reasoning output remain subsets without double charging | recorded | 0 / 1 / 1 / 0 / 0 |
| `M15-D046` | Duplicate cumulative usage observations do not sum into extra consumption | recorded | 0 / 1 / 1 / 0 / 0 |
| `M15-D047` | Reasoning count larger than output tokens is invalid usage | deny / `usage_invalid` | 0 / 0 / 0 / 0 / 0 |
| `M15-D048` | Missing token counter does not become reported zero | deny / `usage_invalid` | 0 / 0 / 0 / 0 / 0 |
| `M15-D049` | Schway transient retry has its own current charged physical child | recorded | 0 / 2 / 2 / 0 / 0 |
| `M15-D050` | Native compaction is separately charged and retains owner decisions | recorded | 0 / 2 / 2 / 0 / 0 |
| `M15-D051` | Fresh image read has a separate original child charge | recorded | 0 / 2 / 1 / 1 / 0 |
| `M15-D052` | New browser child read at zero cannot use the paid parent model call | deny / `budget_exhausted` | 0 / 0 / 0 / 0 / 0 |
| `M15-D053` | Stop before dispatch creates no claim or charge | deny / `stopped` | 0 / 0 / 0 / 0 / 0 |
| `M15-D054` | Already aborted signal refuses before claim | deny / `cancelled` | 0 / 0 / 0 / 0 / 0 |
| `M15-D055` | Abort after claim requests one original cancellation and withholds result | withheld / `cancelled` | 0 / 1 / 1 / 0 / 0 |
| `M15-D056` | Explicit stop and signal share one memoized cancellation | withheld / `stopped` | 0 / 1 / 1 / 0 / 0 |
| `M15-D057` | Policy revoke between capture and publication keeps the capture and charge | withheld / `publication_withheld` | 0 / 1 / 1 / 0 / 0 |
| `M15-D058` | Changed owner output endpoint is not an approved new private recipient | withheld / `recipient_unapproved` | 0 / 1 / 1 / 0 / 0 |
| `M15-D059` | Reconnect returns the original receipt and no inference or delivery | allow | 0 / 0 / 0 / 0 / 0 |
| `M15-D060` | Restart after a claimed call preserves unknown usage without resend | reconcile_only / `reconcile_only` | 0 / 0 / 0 / 0 / 0 |
| `M15-D061` | Changed request payload under an existing selection slot conflicts | deny / `request_conflict` | 0 / 0 / 0 / 0 / 0 |
| `M15-D062` | Unclaimed selection receipt survives restart but does not dispatch itself | recorded | 0 / 0 / 0 / 0 / 0 |
| `M15-D063` | Publication reads retained result through guarded synchronous handoff | allow | 0 / 0 / 0 / 0 / 1 |
| `M15-D064` | Already published retained result never triggers a second owner delivery | allow | 0 / 0 / 0 / 0 / 0 |
| `M15-D065` | Rejected stop proof preserves capture and known channel closure | deny / `protocol_error` | 0 / 0 / 0 / 0 / 0 |
| `M15-D066` | Owner statement does not settle an unknown remote historical outcome | reconcile_only / `reconcile_only` | 0 / 0 / 0 / 0 / 0 |
| `M15-D067` | Current owner generation change fences future inference | deny / `owner_changed` | 0 / 0 / 0 / 0 / 0 |
| `M15-D068` | Revoked standing policy cannot be repaired by model escalation | deny / `policy_revoked` | 0 / 0 / 0 / 0 / 0 |
| `M15-D069` | Expired current plan never gets a new wall clock deadline | deny / `expired` | 0 / 0 / 0 / 0 / 0 |
| `M15-D070` | Different account route revision refuses even if the alias matches | deny / `route_changed` | 0 / 0 / 0 / 0 / 0 |
| `M15-D071` | Different resource generation refuses before context assembly | deny / `resource_stale` | 0 / 0 / 0 / 0 / 0 |
| `M15-D072` | Disabled Bot refuses selection despite approved model IDs | deny / `bot_disabled` | 0 / 0 / 0 / 0 / 0 |
| `M15-D073` | A settled unavailable choice permits a separately admitted approved alternative | recorded | 1 / 1 / 1 / 0 / 0 |
| `M15-D074` | An unknown physical call cannot be rekeyed as an alternative | reconcile_only / `reconcile_only` | 0 / 1 / 1 / 0 / 0 |
| `M15-D075` | A pinned terminal model failure keeps the pin and refuses fallback | deny / `pin_conflict` | 0 / 1 / 1 / 0 / 0 |
| `M15-D076` | An alternative in a different billing account is not same-policy recovery | deny / `account_changed` | 0 / 0 / 0 / 0 / 0 |
| `M15-D077` | Public outer Model stream guard is not a post-credential final dispatch hook | hold / `public_dispatch_guard_missing` | 0 / 0 / 0 / 0 / 0 |
| `M15-D078` | Grok 401 renewal resend inside one stream needs a separate final physical fence | hold / `public_dispatch_guard_missing` | 0 / 0 / 0 / 0 / 0 |
| `M15-D079` | Public onProgress is an observer and cannot authorize a physical resend | hold / `public_dispatch_guard_missing` | 0 / 0 / 0 / 0 / 0 |
| `M15-D080` | Public thinking field without exact adapter capability cannot prove an effort pin | hold / `effort_unproven` | 0 / 0 / 0 / 0 / 0 |
| `M15-D081` | Codex unsupported output-token cap cannot establish a monetary bound | hold / `cost_bound_unknown` | 0 / 0 / 0 / 0 / 0 |
| `M15-D082` | Unknown keys and forged allow verdict in model proposal are rejected | deny / `invalid_shape` | 0 / 0 / 0 / 0 / 0 |
| `M15-D083` | Duplicate JSON keys are rejected before a parser loses their evidence | deny / `invalid_shape` | 0 / 0 / 0 / 0 / 0 |
| `M15-D084` | Invalid UTF-8 model proposal refuses without replacement decoding | deny / `invalid_bytes` | 0 / 0 / 0 / 0 / 0 |
| `M15-D085` | Source instructions cannot change the selected model or grant account access | deny / `invalid_shape` | 0 / 0 / 0 / 0 / 0 |
| `M15-D086` | A hash-shaped actor does not authenticate any protected port | deny / `actor_unregistered` | 0 / 0 / 0 / 0 / 0 |
| `M15-D087` | Measured spend above the reserved upper bound is preserved and stops admission | withheld / `usage_bound_exceeded` | 0 / 1 / 1 / 0 / 0 |
| `M15-D088` | Cancellation with lost physical settlement keeps actual capacity | withheld / `cancelled` | 0 / 1 / 1 / 0 / 0 |
| `M15-D089` | Restored historical charges never become a fresh policy allowance | reconcile_only / `reconcile_only` | 0 / 0 / 0 / 0 / 0 |
| `M15-D090` | Stop preserves complete independent browser worlds and exact child charge history | recorded | 0 / 0 / 0 / 0 / 0 |
| `M15-D091` | Exact previously charged child read continues at zero without a second debit | allow | 0 / 0 / 0 / 1 / 0 |
| `M15-D092` | A recovered child read keeps its charge but cannot resend | reconcile_only / `reconcile_only` | 0 / 0 / 0 / 0 / 0 |
| `M15-D093` | Revoke after retry child charge blocks send while retaining both charges | deny / `policy_revoked` | 0 / 2 / 1 / 0 / 0 |
| `M15-D094` | Revoke after compaction child charge cannot disclose old context | deny / `policy_revoked` | 0 / 2 / 1 / 0 / 0 |
| `M15-D095` | Future final host fence separately charges an internal 401 resend in one stream | recorded | 0 / 2 / 2 / 0 / 0 |
| `M15-D096` | Consumed image read context cannot resolve the same bytes again | deny / `context_consumed` | 0 / 0 / 0 / 0 / 0 |
| `M15-D097` | Compaction projection dropping an owner decision refuses before a new child | deny / `scope_stale` | 0 / 1 / 1 / 0 / 0 |
| `M15-D098` | A copied Model object with matching provider and id is not the bound adapter | deny / `wrong_model` | 0 / 0 / 0 / 0 / 0 |
| `M15-D099` | Repeated guards use one original child charge and only one physical dispatch | allow | 0 / 0 / 1 / 0 / 1 |
| `M15-D100` | Concurrent second claim loses without a second debit or model call | deny / `claim_exists` | 0 / 0 / 0 / 0 / 0 |
| `M15-D101` | Reconciliation is a new read and refuses zero allowance without rewriting history | deny / `budget_exhausted` | 0 / 0 / 0 / 0 / 0 |
| `M15-D102` | Quota on a pinned choice cannot authorize the approved difficult alternative | deny / `pin_conflict` | 0 / 1 / 1 / 0 / 0 |
| `M15-D103` | Image resolution and subsequent model disclosure use two explicit child charges | allow | 0 / 2 / 1 / 1 / 1 |
| `M15-D104` | Source revoke after paid image resolution blocks model disclosure without refund | deny / `source_withdrawn` | 0 / 1 / 0 / 1 / 0 |
| `M15-D105` | Negative zero in an untrusted proposal refuses strict integer validation | deny / `invalid_shape` | 0 / 0 / 0 / 0 / 0 |
| `M15-D106` | A changed exact request projection cannot use a stale plan hash | deny / `hash_mismatch` | 0 / 0 / 0 / 0 / 0 |

## Public-only gap counterexamples and future proof

M15-D077: use only the public auth-createModel/Model/submit path. The outer guard accepts current source/purpose at stream entry; the adapter then awaits its credential. A current-source revoke during that wait must block final send. The pin provides no normalized final dispatch callback to express that check. The proposed outcome is `public_dispatch_guard_missing`, zero admitted I/O, rather than claiming the outer wrapper supplies the missing guarantee.

M15-D078: one public Model stream can contain the Grok adapter's original send, a 401, renewal and a second send. One outer stream counter cannot attest two independently guarded/debited physical sends. D079 rejects treating transient onProgress as the missing boundary. These are inert declaration/adapter-source counterexamples; no credential, 401 request, transport fixture or provider protocol was executed.

M15-D080: public ModelRequest.thinking alone, without exact route/model adapter capability and sent-control evidence, cannot establish an effort pin. Requested metadata/readiness/catalog text is insufficient. D081 isolates the cost problem even assuming a future fake final fence: the codex adapter documents no output-token cap; retained byte limits/abort/null telemetry cannot establish an enforceable monetary bound. No model maximum or current pricing is invented.

M15-D095 illustrates the required future successful internal-resend semantics through an explicit fake final host fence: one stream group, two protected physical children/debits and retained separate samples. This does not claim that callback exists in the pinned host. The smallest supported public Schway changes and their actual deterministic public-only barrier fixtures remain MODEL15-FZ03/04. No upstream issue/native dependency was invented by this preparation.

Implementation must add meaningful Bun/TypeScript scripted-model/fake-clock fixtures for every case, real actor-registry and two-process claim/reservation barriers, final source/account/pin races, actual request/image/compaction projections, cancellation and partial/unknown usage mapping. Follow current supported Schway exports only; no private provider/renewal protocols, local credential interception or competing agent loop. Required static checks here cover schema/type/hash/bytes/links/requirements, charge identity, monotonic facts and causal order. They do not execute the prescribed state machine or prove enforcement.

No runtime test/typecheck, live provider/account/catalog/readiness/session/VM/browser, executable probe, host/policy activation, provisioning, UI/UX, Claude retry/delegation/substitution, spending/account change, rollout or merge is required or claimed. RT15-01/RF15-G01–G08, full runtime/DDL/materializers/transports and all original #326 criteria/native #323 remain outstanding. S14 remains default; adoption/rollback/private scopes/current continuity and old-authority nondispatchability remain mandatory.
