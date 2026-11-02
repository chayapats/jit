# s15-team-resources/v1

Status: **proposed pre-admission contract**, revision **1**, 2026-11-02. Bounded DOCUMENTATION-ONLY preparation for [TEAM15-01 #324](https://github.com/chayapats/jit/issues/324). Its actual implementation step 1 says **Implement** the reviewed team/resource scope; that implementation is **not admitted or completed** here. Requirements: **FR-02/03/05/14/16/21/31/35/38/40; NFR-05/07/08/14; S15-AC04**. Related constraints: FR-04/06/07/13/15/17/18/20/23/29/36/37/39/42; NFR-01/02/03/06/09/10/12. No FR/NFR ID or confirmed decision changes.

The [closed schema](fixtures/s15-team-resources-v1.schema.json), [complete serialized synthetic worlds](fixtures/s15-team-resources-v1.json), [fixture guide](fixtures/s15-team-resources-v1.md), [proposed ADR 0071](../adr/0071-s15-mediated-team-resources-and-fenced-handoffs.md) and [preparation record](../evidence/s15-team-contract-preparation.md) prepare review. They supply no executable API, final freeze, runtime, DDL, storage materializer, real transport, installed policy or acceptance evidence. Every scenario is **UNEXECUTED documentation**, not a passing test. S14 remains default. `schwayChat` remains exact empty tools and `maxTurns:1`; `message.post`, `task.accept` and `work.start` keep their implemented S14 meanings.

## Exact inputs and admission

Inspected main: `64f3a94726fdbce2283aec0944884ca7406d9934`. Merged #317/#319 supplied proposed audit documents: [state transition](s15-state-transition-v1.md), blob `5e6ba001820e1f41728c8a124ed361414187e4fb`, and [ADR 0065](../adr/0065-s15-state-preservation-and-policy-adoption.md), blob `fb451e10fdb67064f484d02029a18cc18672c62b`. Main [ADR 0064](../adr/0064-conversational-authority-and-protected-control-plane.md) is `03593d4622f55aa220b62718fd0da18cb64d8154`.

| Exact OPEN/unmerged proposal | Head; principal contract blob |
| --- | --- |
| #318 / [PR #345](https://github.com/chayapats/jit/pull/345), owned by chayapats | `c79aab9d098c902db0cdff7f3d649ca389fff08c`; [feasibility](https://github.com/chayapats/jit/blob/c79aab9d098c902db0cdff7f3d649ca389fff08c/docs/contracts/s15-runtime-feasibility-v1.md) `f7237a3aa7843da00d55493a127a7107263b0824`; proposed ADR0064 `08099feea574c717684099b1070a2d5fe13e1a18` |
| #320 / [PR #346](https://github.com/chayapats/jit/pull/346) | `de2a4b08f9653d01dc0766e5cefa65ac6e2b9919`; [policy](https://github.com/chayapats/jit/blob/de2a4b08f9653d01dc0766e5cefa65ac6e2b9919/docs/contracts/s15-standing-policy-v1.md) `3c1d5596cc3433eca4aaa5507a02256d3d196462` |
| #321 / [PR #347](https://github.com/chayapats/jit/pull/347) | `f6cb307b9ee56f5090960a9b737b20be6957baa6`; [VM](https://github.com/chayapats/jit/blob/f6cb307b9ee56f5090960a9b737b20be6957baa6/docs/contracts/s15-working-vm-v1.md) `6922f2ff77661ddbe64a34d0c8b5c0a33e04db35` |
| #322 / [PR #348](https://github.com/chayapats/jit/pull/348) | `7c16b7b6b08005715cacb147e0382f824674ccce`; [browser](https://github.com/chayapats/jit/blob/7c16b7b6b08005715cacb147e0382f824674ccce/docs/contracts/s15-protected-browser-v1.md) `11fc079342c7baa49ea6532bd23a37f533030819` |
| #323 / [PR #349](https://github.com/chayapats/jit/pull/349) | `c5d281b5825432a1a2dbf451233cc64f749f195b`; [conversation](https://github.com/chayapats/jit/blob/c5d281b5825432a1a2dbf451233cc64f749f195b/docs/contracts/s15-conversation-v1.md) `ad23421bbca55edd40a4602de09c47eb957c49bf` |
| #326 / [PR #350](https://github.com/chayapats/jit/pull/350) | `e0988281cb79bc31c8e373d66a83a61f6cf46030`; [model selection](https://github.com/chayapats/jit/blob/e0988281cb79bc31c8e373d66a83a61f6cf46030/docs/contracts/s15-model-selection-v1.md) `6c45d9d13dc82c83625912079e7afc51d9c98070` |

Full exact fixture/schema/guide/ADR/evidence blobs are in the preparation record. These revisions were read as inert remote bytes, without branching from, merging, cherry-picking or copying whole prerequisite files into this checkout. **Every actor/transport/action/schema/adapter/model/cost/resource/handoff/lease assumption requires reconciliation with actual merged reviewed prerequisite revisions and implementation evidence.** Review or closure is not admission. #324's native blocker remains **#323 OPEN**. #325 actually depends on #324; #324/#326 are independent #323 siblings. No native edge from #326 is invented. All five original criteria, labels and ownership remain unchanged.

Main, all six relevant PR trees, remote heads and all 60 top-level threads were inspected; no competing #324 work was found. ADR0066–0070 are occupied by #346–350; 0071 is proposed here subject to integration recheck. A failed broad search is not readiness evidence: the complete REST PR list and actual native dependency endpoints were checked independently.

RT15-01/RF15-G01–G08 and #326's MG15-P01–P03 remain **unproven**. This proposal chooses no option B, guest-loss acceptance, reduced administration or general-browser substitute, numeric S15 allowance/currency period/profile, new account or billing. Required `claudeAgent / claude-opus-5-5 / high` author remains unavailable under [#337's record](https://github.com/chayapats/jit/issues/337#issuecomment-6572828439). No retry, substitution, subagent or UI/UX authoring is included.

## Static source and public surface

| Inspected source/contract | Existing behavior; proposed reuse boundary |
| --- | --- |
| [graph.ts](../../src/s14/graph.ts), [graph-types.ts](../../src/s14/graph-types.ts), [app.work-graph/v1](app.work-graph-v1.md), [ADR0051](../adr/0051-s14-bounded-team-graphs.md) | Finite trusted research/synthesis DAG, validated narrowing, independent attempts, real unsettled transport capacity, committed settled dependencies and explicit sibling gaps. S14 checks Bot-owned resources/receiver shares; this is not already team-default access. |
| [sharing.ts](../../src/s14/sharing.ts), [sharing-types.ts](../../src/s14/sharing-types.ts), [app.snapshot-sharing/v1](app.snapshot-sharing-v1.md), [ADR0053](../adr/0053-s14-explicit-snapshot-copies.md) | Exact receiver/work/expiry/source-bound immutable copy, 32 KiB snapshot/64 KiB aggregate context, original share ancestry and independent revoke tombstone. No raw profile/volume path; received snapshots cannot be forwarded under S14. New team semantics do not reinterpret those rows. |
| [memory.ts](../../src/s14/memory.ts), [memory-types.ts](../../src/s14/memory-types.ts), [app.memory-scope/v2](app.memory-scope-v2.md) | Access before relevance, live decisions, original access revisions, conservative transitive source/producer lineage including uncited generated text; receiver checks before handoff. Correction/forget and stale native context cannot be bypassed by republication or cache. |
| [authority.ts](../../src/s14/authority.ts), [authority-types.ts](../../src/s14/authority-types.ts), [types.ts](../../src/s14/types.ts) | Actual privately registered owner actor/current generation, immutable grant/Bot/route/scope intersection, separate inference/tool/read charges and publication guards. `task.accept` retains an obligation; only explicit `work.start` creates S14 execution. A model plan or conversation membership grants nothing. |
| [computer.ts](../../src/s14/computer.ts), [computer-types.ts](../../src/s14/computer-types.ts), [app.input-lease/v1](app.input-lease-v1.md), [ADR0046](../adr/0046-bot-computers-and-explicit-sharing.md) | Current private computers, exclusive generation-bound input/takeover, stale-release safety, immediate fences and actual settlement. Reads do not own input. The current agent input is scroll-only, not general-browser support. |
| [research.ts](../../src/s14/research.ts), [research-handoff.ts](../../src/s14/research-handoff.ts), [ADR0048](../adr/0048-concurrent-work-and-replay-safe-recovery.md) | Public Schway model/backend/tool composition; handoff packs accessible committed evidence with fair summaries and explicit omissions. Existing 49,152-byte envelope, 16,384 summary share when evidence exists and 8,192 per text are S14 bounds, not coverage/completion proof or S15 allowance. |
| [lifecycle.ts](../../src/s14/lifecycle.ts), [recovery.ts](../../src/s14/recovery.ts), [native-recovery.ts](../../src/s14/native-recovery.ts) | One process credential lifecycle, independent usage maxima, intent before native creation, fixed opaque correlation workspace, inventory/retirement before admission, no blind unknown-effect replay. Current ledger cannot be replaced by an old application/native image. |
| [team](../../tests/s14-team.test.ts), [sharing](../../tests/s14-sharing.test.ts), [memory](../../tests/s14-memory.test.ts), [authority](../../tests/s14-authority.test.ts), [computer](../../tests/s14-computer.test.ts), [input evidence](../../tests/s14-input-evidence.test.ts), [recovery](../../tests/s14-recovery.test.ts), [context](../../tests/context-packet.test.ts), [sharing/recovery wiring](../../tests/s14-share-recovery-ui.test.ts) | Source inspection of overlap barriers, scope filtering, sibling failure/stop, forged actors, lease/takeover/final guards, retained uncertainty and stale-image/native recovery. Legacy context tests retain legacy scope. Web files are read for wiring/logic only; no UI design or test execution is inferred. |

Schway pin: [tarball](../../vendor/schway-1.0.0-rc.2-697bf40.tgz), version `1.0.0-rc.2`, upstream `697bf406a84c8d1deb8d4a6d71876ea1003be5b3`, recomputed SHA-256 `1c9d83de46edddff58a0163452e7f5ec8357e656c90093990fa28fa606a0f41b`. Package exports and public re-exported declarations were read as inert bytes only; no module, provider, credential, account, readiness, catalog or session API was invoked. Production imports remain `schway/host`; declaration source paths do not become supported private imports.

| Public declaration | Exact meaning and limit |
| --- | --- |
| `createHost(HostOptions):Promise<HostRuntime>` | Exact tools/hosted lookup off, explicit finite `HostLimits`, strict context/all discovery off. Controlled discovery would require every workspace/home/skills/activation/packages/extensions field; no autoload authority. No team scheduler, protected lease or external enforcement is provided. |
| `Model.stream(request:ModelRequest,call?:ModelCallOptions)` | Provider-neutral request/events/options, optional public `thinking`, freshly resolved images and cancellation. Preserve `host.auth.createModel()` → forwarding guard → `session.submit(input,model,options)`. `submitWithRoute(input,options)` has no caller-model parameter or invented before-request hook. |
| `ToolDefinition.execute(input,ctx)` / `ToolContext` | Exact custom tools with signal/onOutput; `parallel/exclusive` schedules native siblings only. `effect`, `readOnlyHint`, names and JSON schemas authenticate no actor and coordinate no cross-run resource. |
| `coreToolDefinitions(ExecutionBackend)` | Direct file observations/object identity, atomic own-entry replacement, `ECHANGED`, list/glob/search/read/spawn and bounded environment/output adaptation. Backend is trusted host code, not a sandbox. No protected-host `localExecutionBackend` fallback. |
| Context/images | Host-supplied sections/source documents are data; image probes/resolver are caller evidence and fresh authorized byte lookup, not sanitizer, resource grant or demonstrated support. Every actual extra source/image read needs its exact current child scope/charge. |
| Session/lifecycle/inventory/snapshot | Public submit/compact/readResult/cancel/close/retire and workspace-scoped metadata/opaque snapshots. A Bot is not a shared native session. Cooperative cancel/native close does not prove external process/network cessation; snapshot/inventory does not permit raw native/profile relocation. |

The #326 artifact demonstrates necessary missing **requirements**, not available hooks: MG15-P01 post-credential/per-physical dispatch fencing, including Grok's internal 401-renewal resend within one public stream; MG15-P02 exact requested/mapped/sent effort evidence; MG15-P03 enforceable finite cost bounds (codex explicitly lacks an output-token cap). An outer forwarding guard, retained-byte cap, subscription or null usage proves none of these. Preserve those proposed supported Schway changes; no private protocol/renewal implementation, `HostAuthFetch` production interception, invented API/upstream issue/native edge or Jit retry/compaction loop. Current governed production support remains unproven.

## Closed records and byte identity

The checked-in `$defs` are the normative exact documentation shapes. All properties are required; null is explicit; unions and `NamedRecordV1` **type/value pairs** are closed, including scalars. Unknown keys/type names or values of the wrong declared type refuse. No schema record, role label, catalog string, memory/source/model output, hash, frozen object or TypeScript brand authenticates an actor/account or grants authority.

Primitives follow #320: ASCII IDs `[A-Za-z0-9_-]{1,128}`, lowercase SHA-256, safe nonnegative/positive integers and epoch milliseconds, canonical nonnegative decimal minor units of at most 30 digits. Reject negative zero, overflow, nonfinite/fractional counters, invalid Unicode, forbidden controls/NUL, duplicate JSON keys before parse loses them, prototypes/accessors/cycles/sparse arrays and credential content. Exact bytes are never trimmed, normalized, newline-rewritten or redacted after hashing. Secret detection does not establish universal secret recognition. Protected credentials/state never enter guest/model/prompt/log/ordinary export.

`C(x)` is compact JSON, ASCII keys sorted by UTF-16 code units, declared array order, standard JSON escaping/integer spelling, no BOM/trailing LF. `H(d,x)=SHA256(UTF8('s15.team.'+d+'.v1\n'+C(x)))`, excluding only that containing record's own `hash`, retaining nested hashes. Domains are exactly `cost`, `route`, `restriction`, `resource`, `source`, `scope`, `plan`, `receipt`, `preparation`, `context`, `snapshot`, `file`, `observation`, `lease-request`, `lease`, `operation`, `reservation`, `charge`, `claim`, `facts`, `handoff`, `handoff-receipt`, `result`. Ref catalogs are namespaced, unique and explicit; empty never means all. Canonical reference-set ordering must be frozen with the owning prerequisite serializers; fixture arrays retain the serialized order used by their hashes. Raw Blob/Bytes hashes cover raw bytes. `BytesV1` requires canonical padded RFC4648 base64, decoded length and raw hash equality. Hashes establish byte equality, not truth, account identity, permission or actual remote occurrence.

| Exact named data | Responsibility |
| --- | --- |
| `ScopeV1`, `BotV1`, `AccountRouteV1`, `RestrictionV1` | Resolve actual installation/current continuity, authenticated request/original ingress receipt/admission/work/purpose/current owner/policy, enabled Bot generation, account/billing/credential epoch, approved model/effort/pins, exact receiver/recipient/resource restrictions. These are narrow resolver projections, not a substitute complete policy/catalog/storage schema or serialized actor. |
| `CostBasisV1` | Exact account-route/account/billing/budget/currency and enforceable per-operation vector/physical-send ceiling, cleanup inclusion, evidence and validity. Every costBasis BlobV1 resolves complete canonical bytes of this closed type. Synthetic-only enforcement is never production support or an approved amount. |
| `PlanProposalV1`, `PlanV1`, `AssignmentV1`, `ReceiptV1` | Untrusted narrowing proposal versus protected accepted bounded assignments/dependencies/completion sources. One original request/plan slot; immutable receipt precedes preparation/claims, never hashes a future packet/charge/result. Permanent Bot creation/change is excluded. |
| `ContextPreparationV1`, `ContextPacketV1`, `DecisionV1` | Already admitted read scope and finite slots precede I/O; fresh complete independent labelled context follows. Include every current owner decision and required original bytes or refuse. Source/selection/recipient changes require fresh authorized context and native retirement. |
| `SourceV1`, `ProducerV1`, `SnapshotV1`, `BlobV1`, `BytesV1` | Original immutable bytes and full transitive source/access/withdrawal/producing work-attempt-Bot-resource lineage, including uncited model/tool text. An immutable curated subset, not a transcript/profile/volume/session copy. |
| `FileIdentityV1`, `FileObservationV1`, `ResourceV1` | Externally resolved exact resource/root/object/alias-group/version and VM/boot/manager/process identity. Strings, equal paths and echoed hashes do not prove that identity, CAS or protected evidence integrity. |
| `LeaseRequestV1`, `LeaseV1` | Exact assignment/Bot/attempt/resource/operation class/conflict key/current generation, externally effective manager/process/takeover fences and finite lifetime. Ownership metadata is not a bearer token. |
| `OperationV1`, `ReservationV1`, `ChargeV1`, `ClaimV1` | Exact body/slot/plan receipt/context/sender/receiver/selection/account/recipient/source/lease and original finite cost basis/bounds. Receipt → operation → reservation/charge → claim → final dispatch; a paid parent cannot fund a new child implicitly. |
| `HandoffOfferV1`, `HandoffReceiptV1`, `HandoffReadV1` | Exact source-bound offered subset and receiver acceptance without byte disclosure, then guarded actual child acquisition/publication. Original restrictions cannot be rewritten as an unrestricted share. |
| `DispatchV1`, `CaptureV1`, `SettlementV1`, `PublicationV1`, `FactsV1` | Independent monotonic owning-service facts with explicit original times. Guest/owner statements and copied verifier JSON are not external proof. Stop/rejected evidence never erases captures, network/input/channel/process/usage facts or charges. |
| `ResultV1`, `ResultReadV1`, `GapV1`, `CancelObservationV1` | Actual observed/committed evidence, honest complete/partial/blocked/stopped state, current guarded output, explicit missing sibling evidence and one bounded original-scope cleanup. Model “done” is insufficient. |
| Fixture-only `AdmissionBasisV1`, `PriorChargeV1`, `FakePortSetupV1`, `ContextSetupV1`, `ScriptedResponseV1`, `RejectedProposalV1`, `WorldV1`, `OutcomeV1`, `ScenarioV1`, `ExternalRecordV1` | Complete synthetic antecedents/setup, future responses and expected records. Setup is a recipe for future fake trusted ports, never serialized authentication. Complete external owning scenarios retain their exact canonical bytes and original facts, without retiming/reclassification. None is a production ingress command or full schema for another service. |

Proposed paths after admission: `src/s15/team-{types,validation,plan,context,resources,handoff,leases,results,recovery,ports}.ts`; eventual tests `tests/s15-team-{scope,context,handoff,leases,concurrency,publication,recovery}.test.ts`. None is added here. Freeze exported function/type TSDoc and actual owning-service adapters/serializers before implementation. No UI paths, dictionary keys or Jod integration are supplied.

## Effective team scope and preparation

1. The protected composition resolves an actual already admitted #323 request/work authority and its current #320 standing policy. A registered worker belongs to that exact work/assignment/purpose, independently of model roles or conversation membership. Reauthenticate actual owner ingress when an owner action is needed; durable admitted work uses its own current generation/expiry rather than reconstructing a login actor.
2. Team-approved **mediated** resources can be selected by enabled assigned Bots without a second per-Bot sharing/account ceremony. Effective authority is the intersection of current owner/policy/work/purpose, enabled Bot ceiling, resource/data restrictions, original source/access/producer lineage, exact sender/receiver, account/billing route, actual destination/inference recipient and route/model/effort/author pins. Any explicit narrower restriction wins. Team membership alone is insufficient. S14-private/receiver-bound material remains restricted until separately authorized adoption/release; a share cannot forward or promote it.
3. `prepare` is pure resolution/validation over already authorized metadata and a narrowing proposal. It does no source/model/network I/O and cannot create a Bot/account/provider/billing recipient/purpose. Unknown semantics, unsupported final fence/CAS/effort/cost bound or unavailable exact author pin refuses before preparation reads. Source payload/relevance scoring follows access filtering, never precedes it. A protected catalog is not a live inference/support proof.
4. `accept` rechecks current registry identity and scope after acquiring the writer boundary, then atomically commits one plan/receipt/assignment queue under the original request's team slot. The installation-wide request namespace remains shared with #320/#321/#322/#323, not a second public owner command with a competing request key. Duplicates reauthenticate and return the original receipt without a new queue/charge/lease; changed payload/domain conflicts. Acceptance sends no bytes and incurs no model/read charge by itself.
5. Each assignment has a separate `ContextPreparationV1`, read slot and current recipient/account/selection. Its already admitted #323 scope and exact finite original reservations authorize preparation I/O **before any future packet or model-selection plan hash exists**. Commit each actual child charge/claim before reading. #326 `ModelSelectionPort.prepare` consumes the complete already authorized packet and does no read I/O; its current-packet validation is pure. A future hash cannot fund the read that constructs it.
6. Recheck source/access/current decisions/recipient/selection after each wait and at final byte release. Keep all live owner decisions and required exact request bytes; oversized required content refuses `context_too_large`. Optional omissions are explicit. A new selection/context is separately admitted; retire incompatible native ancestry after real settlement. Do not reconstruct authority from native history, cache, compaction, copied prompts or prior answers. Pure transforms of already authorized in-memory bytes need current guards; additional storage/network/image/delivery acquisition needs its own finite child scope/charge.

The two-Bot synthetic worlds use distinct attempts/context packets and independently held intervals. Sequential calls labelled “parallel,” shared mutable native history or two queued lanes are not overlap evidence. Future barriers must hold both calls in flight simultaneously under actual aggregate ceilings. Schway owns each native loop, transient retry and compaction; Jit owns the finite assignment/dependency scheduler. A product-level alternative model is a new admitted #326 plan, not a Jit retry loop. Honor every pin; unavailable Claude remains unavailable without substitution/self-approval.

## Handoff, snapshots and working files

A handoff offer binds exact committed producer/source/snapshot/payload/access bytes, original purpose, sender/attempt, receiver assignment/account-route/model/effort, actual recipients and expiry. Resolve the complete conservative lineage closure from protected records, including every uncited input and inherited restriction, not the model's citation list. Missing ancestry refuses `lineage_incomplete`; a model summary cannot launder private input. Source correction/forget/deletion/revocation fences descendants and native contexts; already disclosed knowledge cannot be recalled.

An offer/accept receipt is metadata only. Before receiver relevance/context/tool use or actual byte handoff, independently validate that receiver against **every ancestor** and current account/recipient/pin. A team-approved ancestor requires no new per-Bot ceremony; an explicit narrower ancestor is not overridden by the offer. Source/receiver/model changes invalidate the offer's context binding; prepare a fresh current authorized packet/offer as appropriate. No stale snapshot or warmed model session bypasses that guard.

Assignment source seeds and resource ceilings are resolved from the already admitted work before execution. A later committed derived source is eligible only when the protected resolver proves its complete ancestry stays inside those approved roots plus the current pinned owner decisions; a new source label is no expansion mechanism. The receiver in the positive handoff worlds already has both original source/resource roots in its plan, while its first context reads only its selected B snapshot. Receiving A later narrows existing authority and requires fresh context, without a second owner grant.

The actual `handoff_read` has its own exact reservation/charge/claim and complete payload/lineage bounds. A sender's run/model/read charge or offer receipt does not pay it. Receiver `publishHandoff` repeats current checks synchronously and supplies the exact immutable validated bytes to trusted code. Any later async image/file/channel handoff guards again at actual byte use. Preserve original source bytes separately from excerpts/derived summaries and record coverage/gaps; excerpting cannot silently drop a live decision or claim full source coverage. Snapshot sharing grants no execution/import/upload/profile access.

Working files are mutable execution data, distinct from protected immutable snapshots and delivered artifacts. `FileObservationV1` is immutable at its complete reference: retain each prior observation and original capturedAt/hash while an operation names it. A later file version gets a distinct observation reference; neither its content nor capture time can replace an earlier referenced record. `WorldV1.leaseHistory` similarly retains exact prior issued lease records separately from current `leases`; historical records are not callable ownership. The trusted resolver binds the actual managed resource, VM/boot generation, root/object/own-entry and alias-group/version. A model chooses no arbitrary host/guest destination by supplying a path, token or hash. Hardlink/symlink/rename aliases and parent/child namespace mutations must conflict correctly; unsupported identity/footprint resolution refuses before scheduling them independently.

`OperationBodyV1.file_observe {resource:RefV1}` acquires a fresh bounded observation from the exact protected resource identity, without referring to the observation it will create. It uses its own read lease/operation/reservation/charge/claim before physical I/O. The resulting snapshot/observation has a new exact reference and full producer/source/access lineage. A future writer operation/hash cannot fund this preparation read.

For direct file operations preserve #321's descriptor-relative checked-parent/no-follow own-entry replacement semantics and exact observation object custody. A held observation is not a general root-authorized CAS. Guest root can replace ancestors, alter files outside cooperating tools, forge output and bypass a guest-local lock. `ExecutionBackend.writeFileAtomically`/`ECHANGED` and a local lease alone cannot prove malicious-root race-free CAS or protected evidence integrity. The physical adapter must prove its actual protected compare/version/dispatch fence and post-write observation, or return `cas_unproven`. Never advertise correctness from lexical path/hash equality or use a protected-host shell fallback. Broad shell/admin/service effects require their reviewed larger impact/resource footprint; unknown footprint cannot overlap as if it touched one file. RT15-01 remains unresolved; this is no restricted/read-only substitute for full administration.

## Concurrency and lease ordering

| Operations | Required coordination |
| --- | --- |
| Independent authorized immutable snapshot/context reads | May overlap under finite global/work/account-route/Bot/resource/cost limits. Separate original child reservations and private contexts; no browser input lease. |
| Reads of the same mutable file/version | Shared read leases only if the adapter proves stable bounded observation/capture; otherwise serialize. Capture an immutable snapshot and preserve actual version/coverage before independent downstream use. |
| Write versus read/write of the same alias/object/namespace footprint | Exclusive conflicting lease and current observation/version. Second writer waits for real first-scope settlement, then acquires a new generation and fresh observation; never silently overwrites stale input. |
| Proven independent files/operations | May overlap only with externally established disjoint footprints, independent version checks and relevant current budgets. Broad shell/admin/rename/directory operations cannot claim disjointness from different path strings. |
| Browser reads/captures | Separate current read/disclosure scope and capture bounds; no input ownership or renewal. Current document/profile/session/takeover/source/recipient/publication checks still apply. |
| Browser input | Exactly one effective owner per protected session, across Bots/runs. Lease/takeover/process/observation generations intersect the owning #322 operation. Owner takeover fences queued agent input immediately and waits already sent input before physical owner input. Returning control grants neither an old agent lease nor effect approval. |
| Conflicting multi-resource operations | Resolve full footprint first; atomically claim the finite sorted resource/conflict-key set or acquire none. No hold-and-wait, model-controlled lock ordering or partial claimed footprint. Unknown footprint/support holds. |
| Cancellation/expiry/restart | Fence new claims/final dispatch/late publication immediately; retain each actually unsettled scope's capacity. Expiry is not settlement. A new lease never clears an old physical operation merely by replacing metadata. |

Lease ownership binds exact installation/work/assignment/Bot/attempt/resource/conflict key/mode plus current resource/manager/process/takeover generations. Privately registered handles, not serialized `LeaseV1`, enforce use. Revalidate after queue/lock/wait and at the actual protected operation emitter. The emitter owns final bytes and target across its externally effective linearization point; a callback followed by an unprotected wait is insufficient. Revocation ordered before that point prevents dispatch; later revocation cannot recall bytes already sent.

Release is conditional on the exact lease identity/generation/owner and actual operation settlement. A stale release cannot clear newer Bot/owner ownership. Lease renewal is an explicit current bounded coordinator action, never automatic consequence of reads/reconnect/native progress. Parent deadline/policy expiry cannot be extended. Process/manager restart discards original contexts and advances fences; reconcile old physical input/process/channel/operation scopes before reissuing usable leases. A guest-local token/lock/path check is cooperation only and proves no hostile-root protection.

Capacity is conjunctive across installation/work/account-route/Bot/VM/resource/input/cleanup custody. Count running, stopping, unknown and externally unresolved orphan scopes, including those without a surviving app projection. Waiting on a conflicting lease is a bounded queue; it is not an active model call or free infinite wait. Use finite pending entries/deadlines and deterministic fair ordering, interactive work first where permitted. Prevent starvation with bounded queue/expiry and explicit `capacity_busy`/`lease_busy`, not allowance resets. Actual priority/fairness configuration remains TEAM15-FZ03; no product numeric profile is selected.

## Trusted ports and explicit output paths

These are **proposed signatures**, not exports. `Policy.*`, `Chat.*`, `Vm.*`, `Browser.*`, `ModelSelection.*` denote exact pinned unmerged owning proposals, pending reconciliation. Opaque workers/contexts/handles are privately issued and identity-registered in protected composition; brands explain opacity and do not authenticate. No model-supplied callback, endpoint, actor, allow verdict or raw-response map enters these ports.

```ts
import type { ExecutionBackend, ToolDefinition } from 'schway/host';
declare const workerBrand: unique symbol, contextBrand: unique symbol;
declare const leaseBrand: unique symbol, dispatchBrand: unique symbol;
declare const cleanupBrand: unique symbol, verifierBrand: unique symbol;
interface TeamWorkerV1 { readonly [workerBrand]: true }
interface TeamContextV1 { readonly [contextBrand]: true }
interface TeamLeaseV1 { readonly [leaseBrand]: true }
interface TeamDispatchV1 { readonly [dispatchBrand]: true }
interface TeamCleanupV1 { readonly [cleanupBrand]: true }
interface TeamVerifierV1 { readonly [verifierBrand]: true }
interface TeamPortV1 {
  /** Pure narrowing over already admitted current scope; no source/model I/O. */
  prepare(worker: TeamWorkerV1, admission: RefV1,
    proposal: PlanProposalV1): PlanV1;
  /** Recheck registry/current scope under lock; one original team intent. */
  accept(worker: TeamWorkerV1, plan: PlanV1): ReceiptV1;
  /** Current already admitted read scope/finite slots, before packet hash. */
  prepareContext(worker: TeamWorkerV1, receipt: RefV1,
    assignment: RefV1): ContextPreparationV1;
  context(worker: TeamWorkerV1, preparation: RefV1,
    signal?: AbortSignal): Promise<ContextPacketV1>;
  /** Operation body narrows owning policy/VM/browser/model authority. */
  prepareOperation(worker: TeamWorkerV1, receipt: RefV1,
    assignment: RefV1, body: OperationBodyV1): OperationV1;
  dispatch(worker: TeamWorkerV1, operation: RefV1,
    operationHash: Hash, signal?: AbortSignal): Promise<FactsV1>;
  readResult(worker: TeamWorkerV1, result: RefV1): Promise<ResultReadV1>;
  /** Guard and exact-byte use are synchronous, with no intervening await. */
  publishResult(worker: TeamWorkerV1, result: RefV1, resultHash: Hash,
    consume: (result: ResultV1, bytes: Uint8Array) => void): void;
  cancel(worker: TeamWorkerV1,
    assignment: RefV1): Promise<CancelObservationV1>;
  /** Separately authorized/budgeted facts only, never replay unknown I/O. */
  recover(worker: TeamWorkerV1, claim: RefV1): Promise<FactsV1>;
}
interface TeamContextPortV1 {
  /** Uses owning #323 admitted InterpretationV1/read slots when preparing
   * interpretation context; never a future model plan/context hash. */
  fromInterpretation(context: Chat.InterpretationContextV1,
    plan: Chat.InterpretationV1): Promise<Chat.ContextPacketV1>;
  /** Pure validation over complete authorized packet; no hidden read. */
  validate(context: TeamContextV1, packet: ContextPacketV1): void;
}
interface TeamLeasePortV1 {
  claim(worker: TeamWorkerV1, request: LeaseRequestV1): LeaseV1;
  /** Require original privately registered unconsumed operation/charge;
   * no new charge and no remaining-incremental allowance check. */
  continueOriginal(context: TeamDispatchV1, operation: OperationV1,
    lease: TeamLeaseV1 | null, finalBytes: Uint8Array): void;
  release(worker: TeamWorkerV1, lease: RefV1): void;
  observe(verifier: TeamVerifierV1, proof: SettlementV1): FactsV1;
}
interface TeamHandoffPortV1 {
  /** Source metadata/lineage only, not a transcript/session or payload read. */
  offer(worker: TeamWorkerV1, offer: HandoffOfferV1): HandoffOfferV1;
  accept(worker: TeamWorkerV1, offer: RefV1,
    offerHash: Hash): HandoffReceiptV1;
  read(worker: TeamWorkerV1, offer: RefV1,
    signal?: AbortSignal): Promise<HandoffReadV1>;
  publish(worker: TeamWorkerV1, offer: RefV1, offerHash: Hash,
    payloadHash: Hash,
    consume: (snapshot: SnapshotV1, bytes: Uint8Array) => void): void;
}
interface TeamResourcePortV1 {
  /** Bind only privately registered owning-service actors/handles/ports. */
  vm(context: TeamContextV1, binding: Vm.BindingV1,
    actor: Policy.WorkActorV1): ExecutionBackend;
  browser(context: TeamContextV1,
    actor: Policy.WorkActorV1): readonly ToolDefinition[];
  /** Original exact retained scope only; memoized cleanup cannot widen. */
  cancel(context: TeamCleanupV1): Promise<CancelObservationV1>;
}
```

The interpretation adapter returns the owning `Chat.ContextPacketV1`; it does not require a future team receipt or construct a team packet before conversational admission. Team `ContextPacketV1` applies only after the already admitted work and team receipt exist.

`TeamPort.prepareOperation` resolves the exact private assignment and allocates a protected immutable invocation slot; the model's body is only a narrowing proposal. `OperationV1` is coordination data, **not a substitute PreparedActionV1 or a second effect permission**. Mutations use the owning #320 action/claim and #321/#322 final payload, support and actual dispatch ports. Atomically bind the team slot and that one owning claim/reservation before I/O. Team wrappers must not create an independently reusable claim, charge the same owning operation twice or turn a read body into mutation authority. Freeze the full serializer/actor/catalog/slot mapping before implementation; the synthetic setup supplies only fake owning-port outcomes.

The real output path is registered worker → current accepted plan/preparation → exact finite child charge/claim → owning adapter through admitted public Schway backend/custom tool → protected capture/independent facts → guarded retained result → **synchronous publishResult/publishHandoff** → trusted context/tool/report/artifact/owner output consumer. VM adaptation preserves actor-bound prepare/accept, signal-aware dispatch, guarded readResult, synchronous publishResult and memoized original-scope cancel. No omitted callback or raw native/result map supplies a bypass.

Browser adaptation preserves separate input/network/capture/channel/scope/process/publication facts and its **same protected action-or-read emitter**. Each new browser request gets its own exact action or read reservation/context/charge before actual I/O. Original paid child continuation at zero requires the already committed exact original child charge history; a paid parent alone cannot fund a new child. Directional complete frames include their four-byte header and remain distinct from decoded image/output `BytesV1`; team payload bounds do not replace those larger owning frame bounds. Rejecting evidence/stop cannot refund/erase original captures, requests, charges or usage. Whole-browser/VM stop needs authority for its full sibling/service impact.

Every physical model stream/retry/compaction/image/additional read checks actual current source/recipient/account-route/pins and its finite original reservation at actual I/O. Preserve #326's missing public physical-dispatch/effort/cost requirements. A stream wrapper alone is necessary and insufficient. Native progress/thinking/raw errors never bypass guarded publication or count as completion evidence. A new product-level model choice requires a new admitted plan; Schway owns transient retries/compaction.

## Budgets, time, cancellation and recovery

`BoundsV1.ceiling`/`OperationV1.upperBound` are ceilings, not paid child charges. `ChargeV1` is an immutable nonrefundable debit to an exact original reservation in current continuity. A claim binds the exact operation/hash/charge before I/O. New sibling/subtask/model/source/image/handoff/reconciliation/delivery I/O needs its own bounded exact scope/charge; parent payment or subscription is not a wildcard. Original registered unconsumed continuation may use its exact already paid bound at zero remaining allowance. New claims check remaining incremental allowance; repeated guard callbacks do not charge again. Consumed/lost/recovered contexts cannot dispatch from serialized IDs even with matching bytes/charges.

The owning #320 ledger checks all applicable work/installation/account-route/resource/cost ceilings atomically. No transaction stays open across external I/O. Unknown usage remains null/partial, never free/zero/infinite; cache/reasoning counters remain subsets. No numeric S15 amount/currency period/resource profile was selected. Reserve enforceable finite costs including cleanup/retention and all possible physical attempts before admission. Missing bound holds; retained output bytes, abort or absent telemetry do not bound provider computation. Settlement releases actual concurrency only, never conservative charges. No rekey, new work/account/period or stale restore creates fresh allowance.

| Hard protocol ceiling, configuration may lower | Meaning; no installed operating allowance |
| --- | --- |
| Canonical ordinary record / complete context | 131072 / 262144 UTF-8 bytes; depth <=16; <=128 properties/object; <=256 entries/array except the explicitly bounded document collection. Complete packet includes metadata/base64/labels and all decisions, not just decoded text. |
| Assignments / refs / dependency graph | <=8 assignments/plan; <=64 refs/catalog field and <=64 operation slots/work, acyclic dependencies; no model-installed handler. Full queue/dependency/footprint validator remains a freeze gate. |
| Snapshot/source / handoff / result | <=1 MiB protected immutable source; <=49152 complete canonical handoff bytes and <=32768 output text bytes; smaller source/record/receiver bounds dominate. No automatic 1 MiB inline promotion into a smaller packet. S14's existing 32/64 KiB copy/context limits remain unchanged. |
| Plan/preparation / operation / work deadline | <=30000 / <=3600000 / <=86400000 ms, also no later than parent/policy/resource/budget expiry. Absolute protected monotonic deadline includes queue/waits/children; wall-clock policy expiry applies separately. Clock rollback/reconnect/restart cannot extend it. |
| Active / queued / cleanup / observation | <=8 active assignments/installation and narrower work/account-route/Bot/resource limits; <=16 pending/managed resource; <=5000 ms original cleanup and <=30000 ms separately admitted observation. Unsettled actual scopes keep capacity. |
| CPU/memory/PIDs/disk/custody/cost | Every registered profile supplies positive finite externally enforced values and finite cost/record/retention bounds. Reserve control/fact/cleanup headroom before ordinary work; <=100000 protected request/claim identities/installation. Exhaustion refuses admission rather than evicting dedupe/withdrawal/charge history. No measured profile is selected. |

`FactsV1` records original capture/publication/dispatch/settlement times independently. A later guard/recovery does not retime a prior receipt, charge, claim, input or capture. Future scripted responses are separate from retained input facts. Independent known facts are append-only; a new proof can add provenance/correction, never silently rewind them. Reject bad/foreign/copied/guest/owner-statement evidence while retaining every previously recorded response/channel/usage fact. Channel closure, operation quiescence, input settlement, process stop and unknown remote historical outcome remain distinct. Actual process stop can release only the scope/capacity it externally proves.

Register abort before the first wait. Already-aborted dispatch refuses before new claim/I/O. Abort/stop after claim latches publication denial and invokes the **same memoized original-scope cancellation** as explicit cancel, at most once per original scope. Narrow cleanup can survive execution revocation/expiry, but cannot create new model/read authority, change account/recipient, stop unrelated siblings or tear down a whole shared VM/profile. Process loss discards the callable cleanup/dispatch context; separately admitted management reconciliation supplies current finite observations, never reconstructs mutation rights. A signal/timeout/disconnect/native close is not settlement proof.

| Interrupted boundary | Required behavior |
| --- | --- |
| Before team receipt | No acknowledged plan/queue; a genuine authenticated retry may commit once under current scope. |
| Receipt committed, no child claim | Retain exact intent. A current registered scheduler may claim only after reviewed current admission/replay checks; reconnect alone executes nothing. |
| Child claimed or possibly sent | Preserve exact charge/claim/capacity/actual-or-unknown facts; reconcile-only after process loss. No blind replay of reads, models, input, writes or effects and no fresh slot to hide the old one. |
| Capture/evidence committed | Keep original bytes/lineage/facts. Current access permits historical owner inspection separately from late work publication; no rerun to reconstruct output. |
| One sibling fails/stops | Fence only that assignment's future dispatch/publication, retain valid committed sibling evidence and explicit gap. Synthesis needs its own live authority/current source access/charge; whole-work stop cannot be bypassed by a new synthesis. |
| Publication/delivery uncertain | Preserve logical delivery identity and unknown remote outcome; current bounded read-only reconciliation, no reconnect resend. One local receipt never proves distributed exactly-once delivery. |
| Lease expires/manager restarts | Fence old handles and future byte use. Keep physical input/operation/process/channel capacity until respective proof; new metadata ownership cannot settle old activity. |

Actual completion requires the declared representative task's committed observed source/file/browser evidence, correct resulting file/version where a write occurred, full required coverage/current decisions, no unresolved required sibling gap and successful current publication/delivery as applicable. Model text, a retained path, a claim, accepted snapshot or returned guest exit code cannot alone prove task completion or external business success. Return `partial`, `blocked` or `stopped` with exact evidence/gaps/unblock condition when necessary. Guest-reported output remains labelled; protected capture integrity is not guest truth.

## Refusal order, continuity and protected gates

`CodeV1` is closed in the schema. Evaluate actual actor/ingress authentication → strict shape/bytes/credential/hash validation → current continuity → same-key receipt/conflict → current owner/policy/work/purpose/Bot/resource/source/access/receiver/account-route/recipient/pin/stop/expiry → actual support/final fence/CAS/effort/cost bound → incremental budget/capacity/lease conflict → applicable exact human/action gate → result/completion conditions. A denied constraint never permits fallback through another tool. Stage-specific original continuation skips only new-claim/incremental tests for the exact paid registered invocation; publication expects its producing claim and checks current byte/lineage/recipient authority independently.

Schema errors refuse `invalid_shape/invalid_bytes/hash_mismatch`; copied actors `actor_unregistered`; missing ledger `continuity_unavailable`; changed retry `request_conflict`; narrowed scope `source_restricted/receiver_restricted/account_changed/recipient_unapproved/pin_conflict`; withdrawal/correction `source_withdrawn/context_stale`; stale/contended lease `lease_stale/lease_busy/takeover_active`; unsupported actual fence `cas_unproven/support_unproven/public_dispatch_guard_missing/effort_unproven/cost_bound_unknown`. No new charge/I/O occurs on those pre-admission failures. Post-claim refusal retains the charge/claim and actual independent facts. Unknown usage/effects require `reconcile_only`; publication/settlement failures withhold payload without erasing evidence. The guide specifies each complete input → exact disposition/code/retained facts.

Preserve ADR0065's **one current continuity authority**, original request/receipt/claim/charge identity, all current usage/withdrawals/policy revocations, source bytes and old/new runtime boot fences through adoption/rollback. Old grants/approvals/routines/queues remain nondispatchable. S14-private account/data/receiver restrictions precede team relevance. No raw native/profile relocation/copy/promotion, inherited numeric allowance/account/budget/model readiness, permanent-Bot policy or Jod integration. Full runtime/DDL/materializers/maintenance/real transports/brokers/platform/build proof remain their slices; unsupported reverse projection leaves both runtimes fenced.

Ordinary authenticated-owner output is distinct from sending to others. Communication/payment/production/new-private-recipient/major-change gates remain beyond working VM/browser/scripts/MCP administration. Product-default GitHub publication/replies need approval; only a separately installed bounded personal exception can permit its technical class. Merge needs separate authority/current exact target/head/evidence/checks/reviews; production holds persist, including before a deployment-triggering merge without an effective protected gate. Team access, budgets, source text, model completion and green reviews install no exception and approve no action.

## Freeze and proof obligations

| Gate, all OPEN | Required before corresponding implementation/support claim |
| --- | --- |
| TEAM15-FZ01 prerequisite reconciliation | Actual merged reviewed #323 and applicable #318/#320/#321/#322/#326 contracts/ADRs/fixtures, main/source drift and #319 continuity; preserve native #323 and ownership. This preparation does not complete #324 implementation step 1. |
| TEAM15-FZ02 actor/catalog/schema | Freeze actual registered worker/context/lease/verifier issuance, current authenticated request/purpose/policy/enabled Bot/source/resource/sender/receiver/account-route/recipient resolvers, exact closed shapes/hashes/serializer/byte bounds/exported TSDoc. Structural fixture setup is not authentication. |
| TEAM15-FZ03 plan/identity/concurrency | Freeze one original team slot/shared request namespace, exact owning claim/reservation mapping, atomic multi-resource footprints and conflict identities, alias/namespace ordering, fairness/finite queue/global route/Bot/resource capacity and crash boundaries. No full target DDL/storage materializer supplied. |
| TEAM15-FZ04 context/handoff/publication | Prove noncircular already admitted preparation reads, independent complete current packets/decisions/original bytes/uncited lineage, snapshot subset and receiver restrictions, guarded reads/synchronous final byte handoffs, exact real output/delivery and partial sibling result semantics. |
| TEAM15-FZ05 external resource/dispatch/settlement | Actual protected file observation/CAS/root limitations, browser input/takeover/final action-or-read emitter, exact original child charges/frame bounds and independent facts; #326 MG15-P01–P03 public physical-dispatch/effort/cost requirements; memoized original cleanup and external manager proof. |
| TEAM15-FZ06 recovery/adoption | Full continuity/request/claim/cost/resource/lease/materializer mapping, current-ledger/prefix/identity custody and old-build enforcement, original private data/nondispatchable authority, fixed opaque native workspaces and supported reverse compatibility. |
| TEAM15-FZ07 actual acceptance | Convert every UNEXECUTED definition into admitted Bun/TypeScript scripted-model/fake-clock/barrier/protocol tests and real two-Bot evidence; separately prove exact-build VM/browser/Linux/platform/bypass/cost behavior under explicit opt-in EVID15/CUT15 work and owner adoption. Required Claude UI handoff stays separately blocked; RT15-01/RF15-G01–G08 remain unproven. |

Static document/link/schema/type/fixture/hash/requirement/monotonic-fact/causal-time checks and `git diff --check` validate these artifacts only. No runtime tests/typecheck, executable/live probes, model/provider/subscription/catalog/readiness/account/profile/session/VM/browser access, UI/UX/Claude retry/delegation/substitution, provider/model/settings/account/spending change, activation/provisioning/rollout or merge. The PR uses **Refs #324** and leaves every original implementation criterion/native prerequisite outstanding.
