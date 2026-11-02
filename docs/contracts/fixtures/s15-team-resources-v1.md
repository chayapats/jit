# s15-team-resources/v1 synthetic definitions

Status: **UNEXECUTED documentation**, revision 1, 2026-11-02, Refs [#324](https://github.com/chayapats/jit/issues/324). These bytes specify future scripted-port/fake-clock/barrier inputs and expected outcomes. No scenario, runtime test, typecheck, executable/live probe, model/provider/account/catalog/readiness/session/VM/browser call or actual transport was run. The [contract](../s15-team-resources-v1.md), [schema](s15-team-resources-v1.schema.json), [serialized data](s15-team-resources-v1.json), [ADR0071](../../adr/0071-s15-mediated-team-resources-and-fenced-handoffs.md) and [preparation record](../../evidence/s15-team-contract-preparation.md) are review inputs, not implementation admission or passing tests.

## Representation and future harness

The root is the closed `DocumentV1`. Each `worlds[]` entry is one complete `ScenarioV1`: full `input:WorldV1`, ordered explicit-time `steps`, **separate future `scriptedResponses`**, and complete `expected:OutcomeV1`. There is no base-world expansion, patch overlay, implicit retained future response, filesystem read or hidden default. Original and final receipts/operations/preparations/reservations/charges/claims/contexts/leases/facts/results are serialized where applicable. All material exact bytes resolve from that world's `blobs[]` with both BlobV1 metadata and canonical BytesV1. Each complete world is stored on one JSON line for bounded `jq` inspection; whitespace is not a new record hash.

`records[]` is a closed exact named **type/value pair** union. Every named data/scalar arm has a directly schema-valid example, including Nat/Pos/Time/Minor, bytes, every operation union and result/receipt/history record. A type label beside an arbitrary value is forbidden. `counterexamples[]` carries raw serialized malformed document bytes and the expected `schema_reject`; its untrusted bytes do not become permissive schema fields.

The future harness must allocate real private fake worker/context/verifier identities according to `FakePortSetupV1` / `ContextSetupV1`. `FUTURE_FAKE_TRUSTED_PORT_SETUP_NOT_AUTHENTICATION`, `issue_registered_workers`, an original-context recipe, fake support/grounding setup and labels are **instructions to that future fake harness**, not serialized principals, bearer capabilities or production support. Copied worker/verifier/model-role recipes must produce the declared refusal. No model can install the mock verdict. This proposal proves neither the real actor verifier nor the owning policy/VM/browser/model adapter.

`AdmissionBasisV1` is a fixture-only complete antecedent projection: exact synthetic original owner bytes, request/receipt/admission identities and original received/receipt/charge/claim/dispatch/capture/settlement/admission times. It is not a replacement #323 record/schema or proof those bytes were authenticated. `PriorChargeV1.budget` explicitly distinguishes the interpretation allocation from the later synthetic team allocation. Actual owning #323 bytes/ports must be reconciled before implementation.

Retained input facts exist at `input.now`; future observations remain only in `scriptedResponses`. A script arrival at one time can carry an exact later external settlement observation; no capture/settlement fact is committed before its own declared time. `steps` names the trusted-port/barrier event being exercised, not provider instructions. `continue_original` represents final guard invocations on the same unconsumed registered context; several guards before one emitter handoff are not several physical calls. `dispatch` is a new outer claim attempt and rejects an existing claim. `capture/settle/withdraw/correct/revoke/stop/takeover/restart` events are future fixture inputs through the owning fake services. No elapsed wall-clock waiting, runtime import or executable probe is part of interpreting this document.

`expected` contains every retained receipt/operation/reservation/charge/claim/preparation/context/fact/result plus exact new-record/I/O counts, final current fences/remaining allocation, payloads, valid evidence and gaps. An unchanged paid charge remains byte-identical. `newIoCount` counts newly appended physical dispatch facts, not pure guards, receipt queries, synchronous publication or source-metadata offers. Actual asynchronous transport/image/file delivery would need its own exact child charge; no transport is implemented here. Charges are immutable and nonrefundable; actual usage is independent/null where unknown. An expected support/allow verdict is conditional on the declared **future fake** support recipe, never current production readiness.

## Causal and lineage interpretation

Synthetic admission chronology is original request at 100, receipt at 200, interpretation charge/claim/dispatch/capture/settlement at 300/310/320/330/340, admitted scope at 900 and team plan at 1000. Team receipt at 1100 precedes preparation at 1105, exact immutable context-snapshot operation at 1106, reservation at 1110, charge at 1120, claim at 1130, actual read at 1140, capture at 1150, settlement at 1160 and independent packet at 1180. Preexisting bounded context snapshots include the **exact current owner-decision bytes and source bytes**, full original/curated source closure and access refs. No future packet/model-plan hash authorizes those reads.

Ordinary operations are prepared at 1300, reserved at 1390, charged at 1400 and claimed at 1410. The baseline retains all four original context/read charges; the later team ceiling is synthetic 16 units with 12 remaining. This is no approved S15 amount, currency period, resource profile or free subscription. In the overlap world both operations are in flight at 1800/1805, captured at 2000/2005 and settled at 2100/2105. Complete result evidence cannot precede those captures. The second serialized writer/input uses a new lease generation at 2250, operation at 2251, reservation at 2251, charge at 2261, claim at 2271 and dispatch at 2400, after the first scope settled. None of these times is a later recovery timestamp substituting for an original fact.

A handoff producer has the exact sender work/attempt/Bot/resource/context hash and source/access closure, including uncited input. Offer/accept do no read. The positive actual read has a separate reservation/charge/claim at 2140/2150/2160, dispatch/capture/settlement/publication at 2170/2180/2190/2195 and fresh receiver context at 2200. Required owner decision bytes are carried unchanged; original B bytes remain independently sourced. The complete prepared child and expected committed funding are explicit. Further I/O cannot be funded by this child merely because it is a handoff.

Independent `FactsV1` arrays preserve every original dispatch/capture/settlement/publication. Channel, exact operation scope, process, browser input, network, cancellation and actual usage are separate. A captured response may coexist with a running process and unknown remote outcome. Bad/foreign/copied/owner-statement stop evidence cannot erase known facts or refund charges. A whole shared-resource stop has a separate full-impact hold. Result evidence is actually captured in the declared world; missing/stopped/failed sibling evidence yields explicit gaps and partial output. Guarded owner output is distinct from a send-to-others action.

## Exact external owning projections

`externalRecords` / `externalBytes` retain complete canonical scenarios **BROW15-D100** and **BROW15-D103** from the exact #322 fixture blob `7e9e9019fdac0c771873306db8e911fc37dc6848`, head `7c16b7b6b08005715cacb147e0382f824674ccce`. Their original child read charges, parent facts, request/action-or-read bindings, directional frames and causal times are unchanged. The first permits exact original paid child continuation at zero; the second refuses a new uncharged child at zero despite paid parent facts. These are complete owning scenario byte projections, not retimed team records, authentication or executed tests. Validate decoded bytes against that exact owning schema/fixture and compare the complete canonical value; the entire prerequisite file is not copied into this repository.

The source `FrameV1` remains a directional request/response union with **complete header-inclusive** byte wrappers. Do not parse it through the smaller decoded image/output BytesV1 bounds. The source schema/fixture hash records the exact distinction; no frame is reframed, decoded image substituted or earlier charge reclassified.

## Scenario index

Every row is UNEXECUTED. Read its complete input/steps/responses/expected records before converting it into a test. The listed code is conditional on the supplied future fake ports and all declared earlier guards; it is not an allow oracle or new action authority.

| Scenario | Input/trigger and expected behavior | State / exact code |
| --- | --- | --- |
| TEAM15-D001 | Two enabled Bots read the same approved team resource family independently without a second share ceremony; intervals genuinely overlap. | `allowed` / `null` |
| TEAM15-D002 | Conflicting file_write waits for the first exact scope to settle; the queued Bot has no second lease, charge or dispatch. | `pending` / `lease_busy` |
| TEAM15-D003 | After file_write settlement, a fresh current lease generation and observed target admit the second Bot with its own already charged slot. | `allowed` / `null` |
| TEAM15-D004 | Conflicting browser_input waits for the first exact scope to settle; the queued Bot has no second lease, charge or dispatch. | `pending` / `lease_busy` |
| TEAM15-D005 | After browser_input settlement, a fresh current lease generation and observed target admit the second Bot with its own already charged slot. | `allowed` / `null` |
| TEAM15-D006 | A Bot-specific source restriction filters before relevance and context read. | `denied` / `source_restricted` |
| TEAM15-D007 | A sender share cannot override an explicit receiver restriction. | `denied` / `receiver_restricted` |
| TEAM15-D008 | An approved resource does not permit a different account route. | `denied` / `account_changed` |
| TEAM15-D009 | A derived source cannot be disclosed to an unapproved inference recipient. | `denied` / `recipient_unapproved` |
| TEAM15-D010 | Team access stays inside the actual authenticated purpose. | `denied` / `outside_purpose` |
| TEAM15-D011 | Resource/model restrictions intersect before model context assembly. | `denied` / `pin_conflict` |
| TEAM15-D012 | Existing s14_private sources remain restricted; approved team defaults cannot promote or forward them. | `denied` / `adoption_required` |
| TEAM15-D013 | Existing explicit_receiver sources remain restricted; approved team defaults cannot promote or forward them. | `denied` / `receiver_restricted` |
| TEAM15-D014 | Serialized pass_copied_worker and exact JSON/hashes cannot authenticate an actor. | `denied` / `actor_unregistered` |
| TEAM15-D015 | Serialized pass_model_role_text and exact JSON/hashes cannot authenticate an actor. | `denied` / `actor_unregistered` |
| TEAM15-D016 | withdraw before final I/O refuses stale context/dispatch and retains every original charge and claim. | `denied` / `source_withdrawn` |
| TEAM15-D017 | correct before final I/O refuses stale context/dispatch and retains every original charge and claim. | `denied` / `context_stale` |
| TEAM15-D018 | revoke before final I/O refuses stale context/dispatch and retains every original charge and claim. | `denied` / `policy_revoked` |
| TEAM15-D019 | stop before final I/O refuses stale context/dispatch and retains every original charge and claim. | `denied` / `stopped` |
| TEAM15-D020 | change_account before final I/O refuses stale context/dispatch and retains every original charge and claim. | `denied` / `account_changed` |
| TEAM15-D021 | change_route before final I/O refuses stale context/dispatch and retains every original charge and claim. | `denied` / `route_changed` |
| TEAM15-D022 | change_recipient before final I/O refuses stale context/dispatch and retains every original charge and claim. | `denied` / `recipient_unapproved` |
| TEAM15-D023 | change_model before final I/O refuses stale context/dispatch and retains every original charge and claim. | `denied` / `context_stale` |
| TEAM15-D024 | expire before final I/O refuses stale context/dispatch and retains every original charge and claim. | `denied` / `expired` |
| TEAM15-D025 | Original exact charged unconsumed child continues at zero remaining allowance; repeated guard callbacks add no charge. | `allowed` / `null` |
| TEAM15-D026 | Existing charged operations do not fund a new uncharged child at zero allowance; no I/O or charge occurs. | `denied` / `budget_exhausted` |
| TEAM15-D027 | Exact paid child JSON with discard_on_restart cannot reconstruct an original dispatch context. | `reconcile_only` / `context_lost` |
| TEAM15-D028 | Exact paid child JSON with issue_consumed cannot reconstruct an original dispatch context. | `denied` / `context_consumed` |
| TEAM15-D029 | Exact paid child JSON with omit cannot reconstruct an original dispatch context. | `denied` / `context_lost` |
| TEAM15-D030 | A new outer dispatch call rejects the existing claim; only its original private continuation may use it. | `denied` / `claim_exists` |
| TEAM15-D031 | Owner takeover fences agent input; physical owner input waits for old sent input to settle. | `denied` / `takeover_active` |
| TEAM15-D032 | Manager/controller restart invalidates lease handles and keeps unsettled old scope capacity. | `denied` / `lease_stale` |
| TEAM15-D033 | Concurrent target replacement refuses the stale observation; no overwrite from path equality. | `denied` / `target_changed` |
| TEAM15-D034 | Lease expiry before final dispatch prevents input even without a sweep. | `denied` / `lease_stale` |
| TEAM15-D035 | A stale lease release cannot clear a newer owner or Bot lease generation. | `denied` / `lease_stale` |
| TEAM15-D036 | A guest-local lock, hash, path or observation cannot prove malicious-root CAS or evidence integrity. | `denied` / `cas_unproven` |
| TEAM15-D037 | Hardlink/symlink/rename aliases share the exact externally resolved conflict identity; a second spelling cannot evade serialization. | `pending` / `lease_busy` |
| TEAM15-D038 | Repeated abort/explicit cancel uses one memoized original-scope cleanup, preserves capture/settlement/usage and withholds late publication. | `withheld` / `cancelled` |
| TEAM15-D039 | owner_statement cannot erase recorded captures, network/input/channel/process facts, prior settlements or charges. | `denied` / `settlement_unproven` |
| TEAM15-D040 | rejected_evidence cannot erase recorded captures, network/input/channel/process facts, prior settlements or charges. | `denied` / `settlement_unproven` |
| TEAM15-D041 | Closed channel and quiescent exact operation permit current result use while the separately protected browser process remains running. | `allowed` / `null` |
| TEAM15-D042 | Captured bytes alone cannot release capacity or deliver a complete result while channel/operation scope is unsettled. | `pending` / `settlement_unproven` |
| TEAM15-D043 | An assignment cancel cannot silently stop the whole shared VM/profile or unrelated sibling. | `denied` / `impact_authority_required` |
| TEAM15-D044 | One sibling fails without discarding independently committed valid evidence; final completion is honestly partial. | `partial` / `sibling_failed` |
| TEAM15-D045 | Stopping only Bot B fences its late bytes and leaves Bot A evidence eligible for separately authorized partial synthesis. | `partial` / `sibling_failed` |
| TEAM15-D046 | Authenticated duplicate accept/reconnect returns the exact original receipt; no new receipt, queue, charge, claim or I/O. | `allowed` / `null` |
| TEAM15-D047 | Changed payload under the shared request key conflicts before any new plan or I/O. | `denied` / `request_conflict` |
| TEAM15-D048 | Restart fences old handles and preserves exact original charge, dispatch, capture and causal times; unknown calls remain reconcile-only. | `reconcile_only` / `reconcile_only` |
| TEAM15-D049 | Missing/conflicting current continuity refuses even duplicate queries; no empty ledger or stale budget bootstrap. | `denied` / `continuity_unavailable` |
| TEAM15-D050 | Missing withhold_cost evidence refuses support before new preparation reads/model/provider I/O. | `denied` / `cost_bound_unknown` |
| TEAM15-D051 | Missing withhold_dispatch evidence refuses support before new preparation reads/model/provider I/O. | `denied` / `public_dispatch_guard_missing` |
| TEAM15-D052 | Missing withhold_effort evidence refuses support before new preparation reads/model/provider I/O. | `denied` / `effort_unproven` |
| TEAM15-D053 | Missing withhold_support evidence refuses support before new preparation reads/model/provider I/O. | `denied` / `support_unproven` |
| TEAM15-D054 | Unavailable exact Claude author pin remains unavailable; no retry, provider/model/effort substitution or primary-authored UI. | `denied` / `required_author_unavailable` |
| TEAM15-D055 | A guarded synchronous authenticated-owner result handoff needs no send-to-others approval and creates no replacement effect claim. | `allowed` / `null` |
| TEAM15-D056 | withdraw between guarded read and final byte handoff withholds result without erasing retained evidence or prior charge. | `withheld` / `source_withdrawn` |
| TEAM15-D057 | stop between guarded read and final byte handoff withholds result without erasing retained evidence or prior charge. | `withheld` / `publication_withheld` |
| TEAM15-D058 | change_recipient between guarded read and final byte handoff withholds result without erasing retained evidence or prior charge. | `withheld` / `recipient_unapproved` |
| TEAM15-D059 | correct between guarded read and final byte handoff withholds result without erasing retained evidence or prior charge. | `withheld` / `context_stale` |
| TEAM15-D060 | A team-approved immutable sourced subset is offered/accepted without a second per-Bot grant; acceptance alone reads no bytes. | `allowed` / `null` |
| TEAM15-D061 | Withdrawal/correction of source_a including uncited lineage fences handoff before receiver bytes. | `withheld` / `source_withdrawn` |
| TEAM15-D062 | Withdrawal/correction of source_decision including uncited lineage fences handoff before receiver bytes. | `withheld` / `context_stale` |
| TEAM15-D063 | Withdrawal/correction of derived_source including uncited lineage fences handoff before receiver bytes. | `withheld` / `source_withdrawn` |
| TEAM15-D064 | A summary omitting uncited transitive source/access/producer ancestry refuses rather than laundering private content. | `denied` / `lineage_incomplete` |
| TEAM15-D065 | A handoff cannot add a receiver, permanent Bot, provider/account/billing route or purpose. | `denied` / `receiver_restricted` |
| TEAM15-D066 | Cached snapshot or native history never bypasses current source/access guards. | `withheld` / `source_withdrawn` |
| TEAM15-D067 | Full transcript/session/profile/volume copy is outside immutable subset sharing. | `denied` / `credential_boundary` |
| TEAM15-D068 | Raw native relocation/promotion remains unsupported at fixed opaque workspaces. | `denied` / `native_relocation_refused` |
| TEAM15-D069 | A prior S14 grant/approval/routine cannot dispatch after adoption or rollback. | `denied` / `adoption_required` |
| TEAM15-D070 | Whole shared service/VM teardown requires authority for all affected siblings. | `denied` / `impact_authority_required` |
| TEAM15-D071 | Default GitHub publication/replies still require an exact gate; team access is no personal exception. | `held` / `approval_required` |
| TEAM15-D072 | Publication permission and green review do not grant merge authority. | `held` / `merge_authority_required` |
| TEAM15-D073 | Production-triggering merges remain held before deployment without effective protected approval. | `held` / `production_approval_required` |
| TEAM15-D074 | Already admitted chat scope and committed team receipt authorize two exact finite preparation reads before packet hashes exist; all current owner decision bytes are included. | `allowed` / `null` |
| TEAM15-D075 | Accepted handoff gets its own exact child charge before read and synchronous final byte publication; the receiver builds fresh independent context retaining original B, decision and uncited A lineage. | `allowed` / `null` |
| TEAM15-D076 | Withdrawal after handoff capture and before final receiver bytes withholds publication, retaining the exact child charge/capture and independent settlement. | `withheld` / `source_withdrawn` |
| TEAM15-D077 | An already-aborted signal refuses a new outer dispatch before claim, charge, read or cleanup signal; original context-read charges remain intact. | `denied` / `cancelled` |

## Static checks and future executable evidence

Static validation parses the closed root through JSON Schema Draft 2020-12, validates each named type/value directly including scalars, rejects every malformed root counterexample, checks canonical record domains/raw byte hashes/BlobV1 catalogs, exact reservation/charge/claim linkage, original receipt/admission/dispatch/capture/publication causality, current owner-decision byte inclusion, independent monotonic facts, complete source/producer/access ancestry, unchanged external owning bytes, local links and requirement IDs. It checks that five implementation criteria/actual native #323/ownership/labels and other manifest tickets did not change. `git diff --check` covers the final documentation diff.

For inspection only:

```sh
jq '.worlds[] | select(.id == "TEAM15-D001")' docs/contracts/fixtures/s15-team-resources-v1.json
jq '.records[] | select(.type == "ChargeV1")' docs/contracts/fixtures/s15-team-resources-v1.json
jq '.counterexamples[] | {id,case,expected}' docs/contracts/fixtures/s15-team-resources-v1.json
```

An independent schema validator can use the root schema and each `#/$defs/<type>` with the same `$defs` resolver. Decode each counterexample, require root rejection, then compare external scenario canonical bytes against the pinned original. These are document checks; do not import/run repository models, stores, host/runtime/session constructors or fixture executors to validate prose.

After explicit implementation admission, convert definitions into Bun/TypeScript scripted models, finite fake trusted ports, fake clocks and two-process barriers at every writer/claim/lease/final-I/O/publication boundary. Add independent disjoint-file overlap, read/write/alias/namespace conflicts, exact observation object custody, all aborted/expiry/takeover/reconnect/crash windows, current-continuity restore, truthful unknown/partial usage, hostile-root CAS/alternate-route negative cases and actual child charge dedupe. Prove real VM/browser/platform/cost/physical-dispatch boundaries separately under opt-in exact-build evidence; fake ports and this static consistency cannot supply those proofs.

S14 remains default. #324 actual implementation step 1, all five original criteria and native #323 remain outstanding. No runtime/DDL, real adapter/transport/materializer, UI/UX/Claude retry/delegation/substitution, new account/spending/provider/model/settings, provisioning/activation/rollout or merge is admitted. TEAM15-FZ01–FZ07, RT15-01/RF15-G01–G08 and MG15-P01–P03 remain OPEN/unproven.
