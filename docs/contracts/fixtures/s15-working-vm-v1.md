# s15-working-vm/v1 documentation fixtures

Status: **complete synthetic input → expected-outcome definitions, unexecuted documentation** for [#321](https://github.com/chayapats/jit/issues/321). No scenario was run against a VM, runner, runtime, database, provider, account or policy implementation. Static JSON/schema/ref/hash/byte consistency checks are distinct from scenario execution and passing tests. Synthetic verdicts/proofs do not establish support or authorize a live allocation.

The [contract](../s15-working-vm-v1.md) supplies semantic rules; the [JSON Schema](s15-working-vm-v1.schema.json) supplies exact closed data shapes; [JSON data](s15-working-vm-v1.json) supplies every record, full world, input event and full expected state. [ADR 0067](../../adr/0067-s15-working-vm-operation-and-settlement.md) and the [admission record](../../evidence/s15-vm-contract-preparation.md) retain RT15-01/RF15-G01–G08 and native #320 as open obligations.

## Exact interpretation

No runtime fixture builder is delivered. A future **trusted scripted harness** will implement these rules after contract freeze:

1. Resolve `case.operation` in `records.operations`. Resolve every `step.world` in the `worlds` dictionary to its **complete** `WorldV1`, not an overlay, patch, inherited value or production default. `priorState` is the complete state before that step. Later steps are ordered barriers; each still carries its own complete explicit world. Altered world facts model protected-port changes at that barrier. Never merge missing fields or derive authority from case titles.
2. Every serialized record has all required fields, explicit nulls, real synthetic hashes and exact bytes. References name complete synthetic dependency outputs in the fixture dictionaries or declared `WorldV1` fake-port facts. There are no `<hash>`/ellipsis/omitted-record placeholders. `priorRequest` names exact protected request continuity input; the `spawn_changed` operation has the same request/operation/slot IDs but changed canonical command/hash. It is an invalid reuse input, not another allowed revision.
3. `actor`, `handle`, `ownedContext`, `observationOwner`, `managementActor` and `evidenceIssuer` are **harness setup labels** instructing trusted fake ports to register or refuse process-local identities. They are never production JSON authentication, serialized handles, owner claims, cryptographic attestations or values that a model/guest can set on a live port. Fake issuance occurs outside the payload under test. Copying the labels/valid hashes does not issue authority.
4. `support:'synthetic_only'` supplies only a declared fake-port support verdict so logic can be specified. It is not real adapter proof. `support:'unproven'` refuses before dispatch. `policyDecision` is the fake protected policy-port verdict after its hard current-scope checks; mutations still require their exact `PolicyBindingV1.action` output. Those refs/hashes are **synthetic policy-port outputs**, not incomplete PreparedAction/Approval records or fabricated full policy catalogs. The complete #320 data/fixtures remain separately pinned unmerged inputs; composing/finalizing the actual adapter/catalog schema remains VM15-FZ01–FZ03. No schema is silently imported as live.
5. `authority`, `continuity`, full current binding, manager/endpoint, reservation status, exact remaining vector, service allocation and prior request/claim model the named current resolver facts. Catalog resolution has no other implicit authority outcome in this fixture scope. `filesystem` is a scripted guest filesystem observation/conflict condition, never proof guest root is constrained. `expectedEnvironment` is the complete environment the transport should receive, rather than an overlay. `credentialsDetected` is a deterministic fake content guard; no real secret is present or scanned.
6. A step's `record` is explicitly null or a dictionary key with the stage-specific meaning below. The top-level operation remains immutable; an error/cancel/truncation response may have a differently named key while echoing the correct operation correlation. Input response bytes/hash/counters are validated, not trusted as real process facts. Each `expected` is a full `StateV1`; null usage is unknown. No omitted default means success.

| Stage | `record` dictionary / precise event |
| --- | --- |
| `accept` | `records.receipts` when present, otherwise the case operation itself; authenticate/current-check and commit a deduplicated intent only. Refusal changes no charge/dispatch. |
| `claim` | `records.claims`; bind one protected operation/action claim/reservation before I/O. |
| `dispatch` / `continue_original` | `records.requests`; new claim path versus the original privately registered unconsumed context. A new call with an existing claim refuses; continuation verifies its already charged reservation and may have zero remaining incremental allowance. |
| `cancel` | `records.requests.cancel`; one cooperative cleanup request for the original scope, within its finite reserved cleanup budget. It cannot prove stop. |
| `receive` | `records.responses`, or null for transport loss; append captured guest facts and host channel closure only. A cancel response can be recorded alongside the original operation without becoming its command result. |
| `settle` | `records.evidence`, or null for an unsupported owner statement; validate registered external issuer/VM/boot/execution/epoch and resource ownership. Proof-shaped JSON alone has no effect. |
| `publish` | `records.responses`; current producing/access/lineage/generation guards only. A producing claim/charged budget is expected. This never dispatches a mutation. |
| `recover` | `records.claims`; lose process-local context, retain unknown outcome/charges/capacity, reconcile only. |
| `query` | `records.receipts`; return exact historical request outcome, no new intent/claim/charge/send. |
| `management` | `records.management`; independently authenticate registered manager actor/current lifecycle authority, then apply the scripted management outcome/evidence. Attach/status observe without provisioning/start. Unknown mutation remains reconcile-only. No real lifecycle adapter is supplied. |
| `decode_request` / `decode_response` | `frames`; validate only the complete framing/schema/byte/hash example. These parser-only cases do not imply a dispatched operation or a management proof. |

Disposition precedence: actor/shape/credential/hash → current continuity → request identity → existing new-dispatch claim → support/registered endpoint/handle → current revoked/stopped/stale/expiry/lineage → finite bound/incremental capacity → policy human hold → final I/O. A cleanup/observation path has its own registered narrow authority; it does not require reviving revoked work. Original continuation checks owned reservation, never incremental budget a second time. Publication uses current output authority, not new-claim admission. Same-operation charge/approval is not repeated.

`dispatchCount` counts runner mutation/read invocation of the **original operation** only; `cancelCount` counts its separate cooperative control invocation. Management observations are carried in the exact `managementObservation` field and do not increment runner counters or change the original runner accepted/claimed flags. `managementReservation`/`managementClaimHash` supply the complete synthetic protected policy-port reservation/claim facts for an observed/unknown management call; they are not guest issuable. The charged vector includes that admitted management/read bound and never treats unknown management usage as a free call. Management mutation claim persistence remains the pinned #320 contract, not a second VM runner claim. Parser-only scenarios count neither. Accepted does not mean claimed or dispatched. `outcome:'guest_reported'` means captured guest response, never verified success. Known guest errno/nonzero exit remains untrusted response evidence; the safe `code` can express ECHANGED/EFBIG/partial/error disposition. Protocol/transport/cancel uncertainty stays unknown. `actual` is entirely null unless independently reported; this proposal never infers actual zero from a missing response.

VM capacity is already held in the base world because the synthetic VM is running. A claim holds transport and execution independently. Host channel closure releases transport only. Exact external `scope_empty` releases execution only. Exact `vm_stopped` releases that boot's VM and execution scope without proving historical non-occurrence. `service_transferred` moves execution accounting to the already admitted VM/service allocation; VM capacity remains held and charges are not refunded. A guest/copy/owner statement cannot release these capacities.

The JSON's `worlds` are deduplicated complete records solely to reduce repeated documentation bytes. They do not hide a partial fixture builder or unresolved default. Positive synthetic support/management outcomes specify logic for a future fake; they cannot resolve RT15-01, choose option B, accept guest data loss, authorize provisioning or satisfy real sudo/Docker/browser proof.

## Schema/type and byte obligations

The schema is Draft 2020-12 with local `$defs` only. Its `$id` is an identifier, not a published endpoint. Every record and port-observation type is closed; dictionary keys index fixtures and have no authority. The schema cannot express all semantic constraints: enforce UTF-8 byte counts, safe integer/no-negative-zero, canonical base64, payload/record/frame hashes, current catalog refs, cross-field request/result kind/identity, env name/autoload restrictions, paths, observation ownership, counter consistency and final-I/O guards from the contract. Validate those explicitly before declaring implementation conformance.

Frame bytes are base64 of `[uint32-be length][canonical JSON bytes]`. The frame SHA-256 covers header and body. Positive frames name their complete source request/response; malformed examples contain the exact bad bytes and expected parser code. The oversized-prefix example deliberately has no large allocated body; reject its length before allocation. Bad output data hash is a structurally valid response with a mandatory semantic failure. Never “repair” malformed canonical bytes and execute them.

All operation/registration/claim/receipt/management record hashes use the exact domain and exclude only their own `hash` field. `BytesV1` hashes raw decoded content. `EvidenceV1.proofHash`, policy/action/cost/inventory refs are synthetic owning-port facts, not an assertion that arbitrary supplied bytes authenticate a manager/owner. Record and byte hashing checks do not execute a fixture.

The fixture CPU/memory/disk/time/output/usage vectors are illustrative finite parser/resource profiles. USD/account/route/model allowance is not installed here. No amount, subscription, numeric S15 allowance, selected live VM or inherited S14 resource permission is implied. Old S14/legacy queues/grants/approvals/routines remain nondispatchable under the separate state-transition contract.

## Scenario index

Every row below refers to complete inputs and expected states in the JSON. It is a definition count, **not** a test pass count.

| ID | Input / expected focus |
| --- | --- |
| VM15-D01 | Acceptance is a committed intent, without dispatch or usage charge. |
| VM15-D02 | Original claim charges once; guest output is untrusted; external scope proof settles; publication is separate. |
| VM15-D03 | Structural/copy actor does not authenticate. |
| VM15-D04 | Structural/copy actor does not authenticate. |
| VM15-D05 | Missing/conflicting current continuity does not create a ledger. |
| VM15-D06 | Missing/conflicting current continuity does not create a ledger. |
| VM15-D07 | No reviewed adapter/enforcement proof cannot be repaired by an approval. |
| VM15-D08 | Current authority guard refuses before claim/dispatch. |
| VM15-D09 | Current authority guard refuses before claim/dispatch. |
| VM15-D10 | Current authority guard refuses before claim/dispatch. |
| VM15-D11 | Current authority guard refuses before claim/dispatch. |
| VM15-D12 | Changed vm fences old operation and handle. |
| VM15-D13 | Changed bootGeneration fences old operation and handle. |
| VM15-D14 | Changed work fences old operation and handle. |
| VM15-D15 | Changed attempt fences old operation and handle. |
| VM15-D16 | Changed lease fences old operation and handle. |
| VM15-D17 | Changed controllerEpoch fences old operation and handle. |
| VM15-D18 | Changed executorEpoch fences old operation and handle. |
| VM15-D19 | Serialized/lost runtime handle has no process-local authority. |
| VM15-D20 | Serialized/lost runtime handle has no process-local authority. |
| VM15-D21 | Guest-suggested or mismatched endpoint never selects management target. |
| VM15-D22 | No finite enforceable cost bound holds without charging. |
| VM15-D23 | Incremental claim refuses exhausted budget. |
| VM15-D24 | Original registered unconsumed context uses its exact charged reservation, even if remaining allowance is exhausted. |
| VM15-D25 | A new dispatch call cannot reuse an existing operation/policy claim. |
| VM15-D26 | Recovered claim loses its mutation context, even with no dispatch proof; unknown and reconcile-only. |
| VM15-D27 | Exact repeated request returns original receipt; no claim, revision advance or new dispatch. |
| VM15-D28 | Reusing request/slot identity for changed operation bytes conflicts. |
| VM15-D29 | Cooperative cancel acknowledgement is not a process-stop proof. |
| VM15-D30 | Runner timeout/exit null cannot release execution capacity. |
| VM15-D31 | A closed transport alone does not prove guest processes stopped. |
| VM15-D32 | Revocation after dispatch retains facts/charge but fences late publication. |
| VM15-D33 | Proof-shaped JSON/guest runner root cannot attest protected stop. |
| VM15-D34 | Proof-shaped JSON/guest runner root cannot attest protected stop. |
| VM15-D35 | Authenticated exact old boot VM-stop evidence settles that VM scopes; it does not establish shell outcome. |
| VM15-D36 | Conflicting observation/parent identity prevents atomic replacement. |
| VM15-D37 | Conflicting observation/parent identity prevents atomic replacement. |
| VM15-D38 | Observation is backend-instance/path/binding bound, not a JSON token. |
| VM15-D39 | Observation is backend-instance/path/binding bound, not a JSON token. |
| VM15-D40 | Canonical guest path refuses traversal before transport. |
| VM15-D41 | Read refuses symlink escape and sockets/devices/special files. |
| VM15-D42 | Read refuses symlink escape and sockets/devices/special files. |
| VM15-D43 | Atomic write replaces the final symlink itself, never its target. |
| VM15-D44 | Absent observation succeeds only while the exact entry remains absent. |
| VM15-D45 | Exact realpath request/result maps to public ExecutionBackend semantics; only captured guest evidence. |
| VM15-D46 | Exact stat request/result maps to public ExecutionBackend semantics; only captured guest evidence. |
| VM15-D47 | Exact read request/result maps to public ExecutionBackend semantics; only captured guest evidence. |
| VM15-D48 | Exact observe request/result maps to public ExecutionBackend semantics; only captured guest evidence. |
| VM15-D49 | Exact list request/result maps to public ExecutionBackend semantics; only captured guest evidence. |
| VM15-D50 | Exact glob request/result maps to public ExecutionBackend semantics; only captured guest evidence. |
| VM15-D51 | Exact search request/result maps to public ExecutionBackend semantics; only captured guest evidence. |
| VM15-D52 | Exact write_private request/result maps to public ExecutionBackend semantics; only captured guest evidence. |
| VM15-D53 | Incomplete list refuses complete-looking results. |
| VM15-D54 | Incomplete glob refuses complete-looking results. |
| VM15-D55 | Search truncation is explicitly partial; no completeness attestation. |
| VM15-D56 | Nonzero command exit is untrusted command-result data, not transport error/verified failure. |
| VM15-D57 | Output cap retains prefix/hash/count with truncation; unknown totals remain null. |
| VM15-D58 | Wrong response invocation/nonce cannot settle or publish the operation. |
| VM15-D59 | Framing Exact canonical frame. |
| VM15-D60 | Framing Exact canonical frame. |
| VM15-D61 | Framing Duplicate keys refuse before object construction. |
| VM15-D62 | Framing Unknown version has no downgrade. |
| VM15-D63 | Framing Unknown authority-shaped field refuses. |
| VM15-D64 | Framing Strict UTF-8 failure. |
| VM15-D65 | Framing Zero length |
| VM15-D66 | Framing Reject before allocating request body |
| VM15-D67 | Framing Trailing bytes |
| VM15-D68 | Framing Incomplete frame at EOF |
| VM15-D69 | Proposed admin_install uses guest-only shell; synthetic support is not actual sudo/Docker/service proof. |
| VM15-D70 | Proposed admin_docker uses guest-only shell; synthetic support is not actual sudo/Docker/service proof. |
| VM15-D71 | Proposed admin_env uses guest-only shell; synthetic support is not actual sudo/Docker/service proof. |
| VM15-D72 | Proposed admin_service uses guest-only shell; synthetic support is not actual sudo/Docker/service proof. |
| VM15-D73 | Externally verified service transfer releases only per-operation execution capacity; VM/service allocation remains held. |
| VM15-D74 | Guest destructive administration cannot be proven prevented by this protocol; RT15-01 is unresolved. |
| VM15-D75 | Exact proposed management attach data grants no authenticated management actor or real support. |
| VM15-D76 | Exact proposed management status data grants no authenticated management actor or real support. |
| VM15-D77 | Exact proposed management start data grants no authenticated management actor or real support. |
| VM15-D78 | Exact proposed management stop data grants no authenticated management actor or real support. |
| VM15-D79 | Exact proposed management reboot data grants no authenticated management actor or real support. |
| VM15-D80 | Exact proposed management snapshot data grants no authenticated management actor or real support. |
| VM15-D81 | Exact proposed management restore data grants no authenticated management actor or real support. |
| VM15-D82 | Exact proposed management reset data grants no authenticated management actor or real support. |
| VM15-D83 | Exact proposed management delete data grants no authenticated management actor or real support. |
| VM15-D84 | An owner statement cannot become manager stop evidence or retry authority. |
| VM15-D85 | Policy-only approval_required prevents a mutation claim and sends nothing. |
| VM15-D86 | Policy-only owner_direction_required prevents a mutation claim and sends nothing. |
| VM15-D87 | Credential-shaped input is refused rather than entering guest environment/payload. |
| VM15-D88 | Explicit env is exactly ONLY=synthetic; the service/default environment is absent. |
| VM15-D89 | Hash mismatch in response bytes cannot be silently normalized. |
| VM15-D90 | Synthetic external attach observes the registered existing VM without provisioning/start or worker release. |
| VM15-D91 | Synthetic external status observes the registered existing VM without provisioning/start or worker release. |
| VM15-D92 | Structural management actor does not authenticate lifecycle authority. |
| VM15-D93 | Structural management actor does not authenticate lifecycle authority. |
| VM15-D94 | Lost reboot response stays unknown; no runner replay, replacement handle or worker release. |
| VM15-D95 | Lost restore response stays unknown; no runner replay, replacement handle or worker release. |
| VM15-D96 | Lost reset response stays unknown; no runner replay, replacement handle or worker release. |
| VM15-D97 | Lost delete response stays unknown; no runner replay, replacement handle or worker release. |
| VM15-D98 | Lost start response stays unknown; no runner replay, replacement handle or worker release. |
| VM15-D99 | Whole shared-VM stop without authority for sibling impact holds; a single-scope cleanup cannot escalate. |
| VM15-D100 | An old snapshot/receipt cannot replace missing current request/claim/usage continuity. |
| VM15-D101 | An externally observed new boot fences old operation output and requires fresh reconciliation, never resend. |
