# s15-conversation/v1 synthetic documentation

Status: **UNEXECUTED**. This guide, the [complete serialized inputs/outcomes](s15-conversation-v1.json) and [closed schema](s15-conversation-v1.schema.json) accompany the [proposed contract](../s15-conversation-v1.md), [ADR0069](../../adr/0069-s15-conversational-admission-and-result-continuity.md) and [preparation record](../../evidence/s15-chat-contract-preparation.md). They are not a runnable fixture builder, passing tests, runtime APIs, owner authentication, a live budget or implementation admission. Refs #323; native #321 and every original criterion remain unchanged.

## Interpretation and complete inputs

Each world is independent and fully materialized. There are no inherited base-world patches, ellipses, placeholder hashes, implicit prior charges or unspecified fake responses. IDs and numeric ceilings are synthetic; repeated IDs across independent worlds are intentional. The top-level blob registry provides complete raw bytes for every BlobV1 reference, with exact byte count/SHA-256. ActionBindingV1 identifies the fake owning policy service's exact prepared action projection; it is not the complete upstream PreparedActionV1 schema or authentication. Its actionHash is an opaque value returned by that declared fake service. This document does not claim to recompute an upstream action hash from the smaller projection.

- `input` is the primary complete command. `steps` are the ordered actual method inputs, including a deliberately changed duplicate where stated. A method request is distinct from actual I/O: a refused `tool_call` sends nothing. `expected.counts` counts total retained plus new recorded identities and actual model/tool/mutation/delivery I/O observations; it is not an executed test tally. A charged upper bound alone does not prove a physical call occurred.
- `setup` is a **recipe for a future fake trusted-port harness**, unavailable to production callers. Actor/transport/context/evidence tags tell that harness which private instance registrations/verifier returns to install. No JSON actor/role/tag/verdict/brand/hash authenticates. A forged copy is deliberately unregistered. The harness must obtain a real private test actor from its owning fake ingress, never deserialize setup into an actor.
- `setup.current`, `provenance`, `plan`, `grounding`, `policyDecision` and current-change snapshots are explicit fake owning-service inputs/returns. They supply no real installed catalogs or proof. A future test must inject those trusted ports and verify the actual implementation independently rechecks them; it must not accept serialized allow verdicts on an endpoint. Missing underlying resolver/adapter implementations remain freeze gates. A `current_change` includes the complete changed resolver snapshot and its declared safe verdict, not just a role assertion.
- `setup.sources` contains exact original owner bytes, current owner-decision bytes and explicitly untrusted quote/attachment/tool/model/memory bytes. `packet` contains the complete labelled canonical source text supplied to the scripted interpretation. Source labels never confer authority. `spans` use UTF-8 byte offsets, half-open, against the exact referenced source revision/generation; neither offsets nor the word owner authenticate it. The fake grounding verdict is declared separately from the model proposal, including disagreeing inspect/execute cases.
- `scriptedProposal`, `scriptedCapture` and `scriptedReply` are **possible future port responses**, not already retained facts. They have no effect unless the ordered step requests that response and passes its current guards. A blocked/bootstrap-failure world may list these future responses while expecting zero model/tool calls and no capture. Actual completion needs the fake owning evidence service's explicitly registered committed tool evidence, not an invented model reference.
- `retained` is the complete starting continuity set relevant to the world: ingress/receipts/admissions/holds/replies/events, independent facts, immutable charges, action binding/approval and delivery observations. Prior charges are explicit complete records. `expected.facts.charges` must preserve each prior record byte-for-byte; subsequent usage is a separate observation and does not rewrite/refund a charge. A new child charge is distinct from a parent's reservation.
- `expected` is the full final observable outcome: safe code/disposition, counts, complete monotonic facts, exact receipt/admission/hold/reply/event page where applicable, prepared action/decision, ordered durable events and retained evidence. Null means explicitly absent, not omitted default. Existing facts survive a denial. A receipt means committed request/queue identity, not model execution, task success or actual transport settlement.

The proposed contract's canonical/hash rules apply to every record. Each containing `hash` excludes only itself; nested hashes remain included. Byte wrappers are strict padded base64 plus exact decoded count/raw SHA-256. Receipt hashes precede admission hashes; no admission/action/approval/payload depends on its own future hash. The current owner's source and every BlobV1 byte pair are serialized synthetic data only, with no credentials or installation addresses.

Named examples use a closed 49-arm `NamedRecordV1` union: each literal `type` selects its exact `$defs` value schema, with no extra wrapper keys. The checked-in root schema itself rejects an empty AdmissionV1, ReceiptV1 or ReplyV1, mismatched/unknown types and invalid scalar values. CodeV1 and MeaningV1 examples are strings and are validated as such; they are not forced into an object wrapper. The 17 named examples include both scalar forms. Independent static checks are additional consistency checks, not a replacement for this schema binding.

## Ordered operations and expected facts

`submit` authenticates/validates/commits once; `interpret` invokes only the declared preauthorized bounded interpretation path; `admit` grounds original bytes and atomically binds current scope. `dispatch` requests the exact existing work queue. `model_call` and `tool_call` identify separate actual invocation slots and require their own current original charge/context before I/O. Native retry/compaction is still Schway-owned; the guard can refuse a new physical call. These step names are documentation notation, not new public production methods.

`capture` supplies only that complete scripted observation. It does not automatically commit evidence or publish it. `settle` explicitly names channel/operation/process and a fake independent verifier verdict; a rejected proof preserves prior response/input/network/channel/usage facts. `cancel` requests the original scope once and cannot certify stop. `publish` is the separate final current guard. `progress` remains provisional. `reconnect` reads bounded event state; `restart` changes process epoch and destroys old dispatch contexts. `reconcile` never resends unknown work/effects. `fault` names the exact atomic boundary under hypothetical failure.

The material ambiguity worlds retain the original request/hold and append a distinct authenticated clarification source/receipt. A duplicate returns its receipt without another interpretation/admission; the losing stale continuation produces no new work. Exact action approval creates a new authenticated approval request/receipt linked to the old prepared action, appends a separate decision and leaves its revision/hash unchanged. Changed final recipient/content rejects an old binding. Reconnect is never approval.

The synthetic clock is causal as well as bounded. Charges follow their own ingress receipt; admissions follow that receipt and the interpretation charge. A received event is no earlier than the receipt commit, an admitted event no earlier than admission, and evidence/result events no earlier than their retained reply. Durable event timestamps are nondecreasing in sequence order. An event committed atomically with its cause may have the same millisecond timestamp; final publication is a separate later fact.

| Related worlds | Ordered clock values (epoch milliseconds) |
| --- | --- |
| CHAT15-D085/D086/D087 clarification | Clarification receipt `1800000000010`, charge `1800000000011`; eligible admission and its event `1800000000012`. The stale case has no new admission. Original ambiguity history stays at its original times. |
| CHAT15-D072/D075 approval | Existing reply/evidence at `1800000000020`; approval ingress receipt `1800000000025`, interpretation charge `1800000000026`; eligible approval admission/event `1800000000027`. Changed-action refusal creates no new admission or approval. |
| Captured-evidence/publication worlds | Evidence event is no earlier than reply creation `1800000000020`; separately published result is no earlier than `1800000000021`. Sequence identity, captured bytes, action binding and prior charges remain intact. |

The original charged continuation worlds retain nonrefundable upper bounds even when remaining allowance is zero. The browser child case has an explicit prior read charge and its original unconsumed context; the parent-only case lacks that charge and must refuse before a new child dispatch. Captured response/channel and explicit input/network facts survive rejected stop evidence. Verified stop changes only proved resource facts. Unknown usage remains null throughout; known zero would require an actual reported sample.

Every fixture expectation is a requirement for future deterministic Bun/TypeScript tests with scripted ports, fake clocks and two-process/barrier/crash cases. The definitions do not execute those operations, establish real HTTP/channel authentication, run Schway, access a model, test a VM/browser, prove physical settlement or certify guest-root/alternate-path gates. RT15-01/RF15-G01–G08 remain unproven. No UI/UX, real transport, DDL, activation, spending/account change or merge is supplied.

## Scenario index

All rows are UNEXECUTED. The JSON world is the complete source of inputs and expected data.

| ID | Synthetic input / race | Required disposition / code |
| --- | --- | --- |
| CHAT15-D001 | Bounded ordinary answer creates no tool work | `answer` |
| CHAT15-D002 | Accepting obligation retains it without execution | `accepted` |
| CHAT15-D003 | Inspection admits only reads and readiness evidence | `inspect` |
| CHAT15-D004 | Clear requested implementation admits once without another confirmation | `execute` |
| CHAT15-D005 | One-message selection and start needs no prior accepted task | `execute` |
| CHAT15-D006 | Selection alone is not start authority | `accepted` |
| CHAT15-D007 | Materially ambiguous selected subject holds once | `held` / `material_ambiguity` |
| CHAT15-D008 | Quoted execute text stays data in an inspection | `inspect` |
| CHAT15-D009 | Negated instruction cannot become execute | `inspect` |
| CHAT15-D010 | quote instructions cannot widen authenticated inspect purpose | `inspect` |
| CHAT15-D011 | attachment instructions cannot widen authenticated inspect purpose | `inspect` |
| CHAT15-D012 | tool instructions cannot widen authenticated inspect purpose | `inspect` |
| CHAT15-D013 | model instructions cannot widen authenticated inspect purpose | `inspect` |
| CHAT15-D014 | memory instructions cannot widen authenticated inspect purpose | `inspect` |
| CHAT15-D015 | Untrusted model classification cannot promote inspect to execute | `denied` / `outside_scope` |
| CHAT15-D016 | Forged structural owner actor refuses before persistence | `denied` / `authentication_required` |
| CHAT15-D017 | Expired owner actor refuses under writer lock | `denied` / `authentication_required` |
| CHAT15-D018 | bad_host ingress cannot authenticate a request | `denied` / `host_rejected` |
| CHAT15-D019 | bad_origin ingress cannot authenticate a request | `denied` / `origin_rejected` |
| CHAT15-D020 | bad_csrf ingress cannot authenticate a request | `denied` / `csrf_rejected` |
| CHAT15-D021 | unverified_channel ingress cannot authenticate a request | `denied` / `channel_unverified` |
| CHAT15-D022 | forwarded_channel ingress cannot authenticate a request | `denied` / `channel_forwarded` |
| CHAT15-D023 | Verified current channel binding is actual ingress, not a role string | `execute` |
| CHAT15-D024 | Verified local API uses same admitted purpose and request identity | `execute` |
| CHAT15-D025 | missing protected continuity refuses without empty-ledger bootstrap | `denied` / `continuity_unavailable` |
| CHAT15-D026 | conflicting protected continuity refuses without empty-ledger bootstrap | `denied` / `continuity_unavailable` |
| CHAT15-D027 | full protected continuity refuses without empty-ledger bootstrap | `denied` / `continuity_capacity` |
| CHAT15-D028 | Interpretation route_unavailable refuses before model or context disclosure | `held` / `route_unavailable` |
| CHAT15-D029 | Interpretation recipient_approval_required refuses before model or context disclosure | `held` / `recipient_approval_required` |
| CHAT15-D030 | Interpretation finite_budget_required refuses before model or context disclosure | `held` / `finite_budget_required` |
| CHAT15-D031 | Interpretation cost_unknown refuses before model or context disclosure | `held` / `cost_unknown` |
| CHAT15-D032 | Interpretation budget_exhausted refuses before model or context disclosure | `denied` / `budget_exhausted` |
| CHAT15-D033 | Interpretation capacity_busy refuses before model or context disclosure | `held` / `capacity_busy` |
| CHAT15-D034 | Interpretation lineage_withdrawn refuses before model or context disclosure | `denied` / `lineage_withdrawn` |
| CHAT15-D035 | Unknown interpretation model outcome retains charge and never grants work | `reconcile_only` / `interpretation_unknown` |
| CHAT15-D036 | Required pinned decisions cannot be silently omitted to fit context | `held` / `body_too_large` |
| CHAT15-D037 | Current authority_revoked between interpretation and admission prevents work | `denied` / `authority_revoked` |
| CHAT15-D038 | Current stale_authority between interpretation and admission prevents work | `denied` / `stale_authority` |
| CHAT15-D039 | Current expired between interpretation and admission prevents work | `denied` / `expired` |
| CHAT15-D040 | Current lineage_withdrawn between interpretation and admission prevents work | `denied` / `lineage_withdrawn` |
| CHAT15-D041 | Current selection_pinned between interpretation and admission prevents work | `denied` / `selection_pinned` |
| CHAT15-D042 | Current outside_scope between interpretation and admission prevents work | `denied` / `outside_scope` |
| CHAT15-D043 | Owner session expiry during interpretation holds admission without losing request | `held` / `authentication_required` |
| CHAT15-D044 | Identical retry returns original receipt and creates no new intent | `duplicate` |
| CHAT15-D045 | Changed same request ID conflicts across installation namespace | `conflict` / `request_id_conflict` |
| CHAT15-D046 | Channel source event cannot be replayed using a new caller request ID | `conflict` / `source_event_conflict` |
| CHAT15-D047 | Reconnect after admission reads events and starts no new work | `duplicate` |
| CHAT15-D048 | Restart after unknown run claim cannot reconstruct dispatch context | `reconcile_only` / `context_lost` |
| CHAT15-D049 | Ingress commit fault leaves no receipt source queue or charge | `denied` / `unknown_outcome` |
| CHAT15-D050 | Admission commit fault retains ingress but no partial authority or execution queue | `pending` / `unknown_outcome` |
| CHAT15-D051 | Original registered charged model call continues at zero remaining allowance once | `execute` |
| CHAT15-D052 | New uncharged model call at zero remaining allowance refuses | `denied` / `budget_exhausted` |
| CHAT15-D053 | Consumed run context cannot dispatch twice | `denied` / `already_claimed` |
| CHAT15-D054 | Lost original context cannot use serialized claim as dispatch authority | `reconcile_only` / `context_lost` |
| CHAT15-D055 | Browser child read continuation preserves its exact prior child charge | `execute` |
| CHAT15-D056 | Parent charge alone cannot fund a new browser child at zero allowance | `denied` / `budget_exhausted` |
| CHAT15-D057 | New dispatch with already aborted signal claims and sends nothing | `denied` / `aborted` |
| CHAT15-D058 | Abort after claim requests memoized original cancellation and retains capacity | `stopping` / `aborted` |
| CHAT15-D059 | Stop/revoke after capture withholds late result without erasing evidence | `stopping` / `publication_fenced` |
| CHAT15-D060 | Rejected stop proof preserves response channel charges and prior settled scope | `pending` / `settlement_pending` |
| CHAT15-D061 | Verified exact process stop changes only proved scopes and preserves capture | `stopped` |
| CHAT15-D062 | Captured response while channel or operation unsettled is not publishable | `pending` / `settlement_pending` |
| CHAT15-D063 | Final guarded owner result publishes retained evidence without new effect approval | `published` |
| CHAT15-D064 | Provisional native progress never commits evidence or completion | `pending` |
| CHAT15-D065 | Model done text without actual required tool evidence cannot finish task | `held` / `result_unavailable` |
| CHAT15-D066 | lineage_withdrawn at final reply/image/async-byte publication withholds payload | `denied` / `lineage_withdrawn` |
| CHAT15-D067 | stale_authority at final reply/image/async-byte publication withholds payload | `denied` / `stale_authority` |
| CHAT15-D068 | recipient_approval_required at final reply/image/async-byte publication withholds payload | `denied` / `recipient_approval_required` |
| CHAT15-D069 | Expired event cursor returns bounded authorized reset without work replay | `reset` |
| CHAT15-D070 | Cross-conversation cursor refuses without leaking events | `denied` / `cursor_invalid` |
| CHAT15-D071 | Unknown owner-channel delivery remains reconcile-only across reconnect | `reconcile_only` / `unknown_outcome` |
| CHAT15-D072 | Exact authenticated approval appends decision without revising action/hash | `approval_recorded` |
| CHAT15-D073 | Ambiguous affirmative cannot select among held actions | `held` / `material_ambiguity` |
| CHAT15-D074 | Quoted approval text in source cannot decide action | `inspect` |
| CHAT15-D075 | Changed final recipient/content makes earlier approval binding stale | `denied` / `stale_approval` |
| CHAT15-D076 | Known approval_required effect remains held outside working-agent authority | `held` / `approval_required` |
| CHAT15-D077 | Known merge_authority_required effect remains held outside working-agent authority | `held` / `merge_authority_required` |
| CHAT15-D078 | Known production_approval_required effect remains held outside working-agent authority | `held` / `production_approval_required` |
| CHAT15-D079 | Known recipient_approval_required effect remains held outside working-agent authority | `held` / `recipient_approval_required` |
| CHAT15-D080 | Known owner_direction_required effect remains held outside working-agent authority | `held` / `owner_direction_required` |
| CHAT15-D081 | Default GitHub publication/replies are not enabled by repository instructions | `held` / `approval_required` |
| CHAT15-D082 | Installed bounded personal publication rule does not supply merge authority | `held` / `merge_authority_required` |
| CHAT15-D083 | Stop proof cannot erase actually sent network request or input facts | `pending` / `settlement_pending` |
| CHAT15-D084 | Rollback cannot restore old request allowance claims or withdrawn source | `denied` / `continuity_unavailable` |
| CHAT15-D085 | Authenticated clarification resolves one existing root work slot | `execute` |
| CHAT15-D086 | Duplicate clarification reconnect cannot ask or start again | `duplicate` |
| CHAT15-D087 | Concurrent clarification loses stale revision without another work slot | `denied` / `stale_revision` |
| CHAT15-D088 | Inspect authority refuses a mutating tool even after model plan proposes it | `denied` / `outside_scope` |
| CHAT15-D089 | Known captured failure plus unknown usage cannot be labelled zero cost or success | `reconcile_only` / `unknown_outcome` |
| CHAT15-D090 | Model retry and compaction need their own current guarded finite call slots | `denied` / `budget_exhausted` |
| CHAT15-D091 | Source or attachment cannot change the fixed native workspace | `inspect` |
| CHAT15-D092 | Supported VM/browser logic does not certify actual admin or universal effect prevention | `held` / `adapter_unproven` |

## Local document validation and limits

Static validation covers the Draft 2020-12 schema, every complete world/named record, seven malformed named-example counterexamples through the root schema, strict byte/hash pairs and referenced blobs, original-source spans/packet hashes, exact receipt/admission correlations, ordered unique event sequences, 439 receipt/charge/admission/event causal-time assertions, unchanged prepared action bindings, prior charge identity/vector/count, independent monotonic captured/channel/input/network/usage facts, zero-allowance child continuation and unchanged issue requirements/blockers. Link and diff checks cover this documentation change. The temporary validator reads JSON/Markdown/Git metadata only; it does not simulate scenarios, invoke runtime constructors or call host/provider/browser APIs. Exact counts and artifact blobs are recorded in the preparation record/PR.

No runtime tests, typecheck, executable probes, real ingress/backend/transports/brokers, account/profile/session/provider/subscription, guest root/browser/platform/build enforcement or adoption/rollback operations were run. No documentation scenario is reported as a passing test. Complete upstream actor/policy/action/reservation/adapter contracts remain the exact pinned unmerged proposals pending reconciliation; fake verdicts cannot make them installed or ready.
