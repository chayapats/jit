# s15-protected-browser/v1

Status: **proposed pre-admission contract**, revision **1**, 2026-11-02. Bounded documentation-only preparation for step 1 of [BROW15-01 #322](https://github.com/chayapats/jit/issues/322). Requirements: **FR-07/17/18/29/36/37/38/40; NFR-04/07/10/14; S15-AC05**. Related constraints: FR-15/16/35/39/41/42; NFR-02/05/06/08/09/12; S15-AC03/04/07/08/09/10/11/12/15/16. No requirement or confirmed decision changes.

The [proposed ADR 0068](../adr/0068-s15-protected-browser-operations-and-evidence.md), [closed documentation schema](fixtures/s15-protected-browser-v1.schema.json), [complete synthetic definitions](fixtures/s15-protected-browser-v1.json), [fixture interpretation](fixtures/s15-protected-browser-v1.md) and [preparation record](../evidence/s15-browser-contract-preparation.md) form this proposal. They deliver no runtime, DDL, executable probe, browser/CDP/VM transport, live website/account/profile/session access, provisioning, activation or UI/UX. All scenarios are **UNEXECUTED documentation**, never passing tests. S14 remains the implemented default.

## Inputs and admission

Inspected main is `64f3a94726fdbce2283aec0944884ca7406d9934`. #317 / PR #343 and #319 / PR #344 are merged. Main's [state-transition contract](s15-state-transition-v1.md), blob `5e6ba001820e1f41728c8a124ed361414187e4fb`, and [ADR 0065](../adr/0065-s15-state-preservation-and-policy-adoption.md), blob `fb451e10fdb67064f484d02029a18cc18672c62b`, remain proposed audit contracts, not implemented S15. [ADR 0064](../adr/0064-conversational-authority-and-protected-control-plane.md) on main is blob `03593d4622f55aa220b62718fd0da18cb64d8154`.

| Exact remote proposal input | Inspected head and principal blobs |
| --- | --- |
| #318 / [PR #345](https://github.com/chayapats/jit/pull/345), OPEN, owned by chayapats | Head `c79aab9d098c902db0cdff7f3d649ca389fff08c`; [feasibility](https://github.com/chayapats/jit/blob/c79aab9d098c902db0cdff7f3d649ca389fff08c/docs/contracts/s15-runtime-feasibility-v1.md) `f7237a3aa7843da00d55493a127a7107263b0824`; ADR0064 `08099feea574c717684099b1070a2d5fe13e1a18` |
| #320 / [PR #346](https://github.com/chayapats/jit/pull/346), OPEN | Head `de2a4b08f9653d01dc0766e5cefa65ac6e2b9919`; [policy](https://github.com/chayapats/jit/blob/de2a4b08f9653d01dc0766e5cefa65ac6e2b9919/docs/contracts/s15-standing-policy-v1.md) `3c1d5596cc3433eca4aaa5507a02256d3d196462`; ADR0066 `ca62a24e81f7601a9b6778997f7cb6b55b24b4a8` |
| #321 / [PR #347](https://github.com/chayapats/jit/pull/347), OPEN | Head `f6cb307b9ee56f5090960a9b737b20be6957baa6`; [VM contract](https://github.com/chayapats/jit/blob/f6cb307b9ee56f5090960a9b737b20be6957baa6/docs/contracts/s15-working-vm-v1.md) `6922f2ff77661ddbe64a34d0c8b5c0a33e04db35`; ADR0067 `7aab500ef07780a35c1b089694b9ef17ebc0cc60` |

All three are exact-head Greptile 5/5 APPROVED / check SUCCESS inputs, **unmerged and absent from main**. Their complete fixture/schema/guide/evidence blobs are listed in the preparation record. They were read remotely and Git hashes verified, without branching from, cherry-picking, merging or copying whole files into this worktree. Every new transport/actor/action/schema/adapter assumption remains pending reconciliation with the **actual merged reviewed #318/#320/#321 revisions and implementation evidence**. Green reviews or issue closure do not admit runtime work.

#322 remains OPEN / blocked / needs-triage with native #321 OPEN and every original acceptance criterion outstanding. Main and the three active PR trees were collision-checked: #346 occupies ADR0066, #347 occupies ADR0067; 0068 is proposed here, subject to integration recheck. RT15-01 and RF15-G01–G08 remain unproven. This contract chooses no administration option, guest-loss acceptance, weaker guarantee or speculative Schway blocker.

## Static source and public host audit

| Source / contract inspected | Reusable seam and precise limit |
| --- | --- |
| [computer.ts](../../src/s14/computer.ts), [computer-types.ts](../../src/s14/computer-types.ts), [app.bot-computer/v1](app.bot-computer-v1.md) | Durable intent before mutation, immutable attempt/computer binding, private runtime handles, finite queue, late-publication guards and retained uncertain capacity. Current computers/profiles are **Bot-private**, grant-intersected and network-free; shared S15 access cannot reinterpret them. |
| [computer-podman.ts](../../src/s14/computer-podman.ts) | Instance WeakMap handle validation; separate workspace/profile mounts; guarded typed pipe input; no await between final input guard and enqueueing every message of that input. Rootless/no-network/read-only-root containers do not prove an administrable VM or general browsing. |
| [app.input-lease/v1](app.input-lease-v1.md), [computer tests](../../tests/s14-computer.test.ts) | Takeover fences queued input immediately; physical input already dispatched settles under a mutex before owner input. Release cannot clear a newer lease. Reads do not acquire input. Existing agent input is **scroll only**; owner text is transient, process-keyed HMAC dedupe, restart unknown/no replay. |
| [browser.ts](../../src/exec/browser.ts), [takeover.ts](../../src/exec/takeover.ts), [ADR 0039](../adr/0039-browser-and-computer-use.md), [browser tests](../../tests/browser-use.test.ts) | Legacy project sessions, bounded AX snapshots, screenshot references, page/element freshness and unknown-effect handling inform the audit. Label/form/Enter heuristics, model intent, raw desktop input and URL equality are **not S15 effect enforcement**. No legacy API is promoted into this contract. |
| [cdp-stream.ts](../../src/exec/cdp-stream.ts), [relay](../../ops/box/cdp-relay) | Existing private NUL-framed CDP channel: 1 MiB message, 15 s command deadline, explicit closure. Timeout/close is not independent process/effect-stop proof. New transport below does not expose or reinterpret CDP. |
| [input evidence tests](../../tests/s14-input-evidence.test.ts), [Podman tests](../../tests/s14-computer-podman.test.ts) | Source covers copied handles, secret-free input receipts, final guards, physical-input races, kernel process identity/start-time witnesses, partial inspection and retained cleanup uncertainty. Reading these tests is not execution or new platform evidence. |
| [authority.ts](../../src/s14/authority.ts), [recovery.ts](../../src/s14/recovery.ts), [authority tests](../../tests/s14-authority.test.ts), [recovery tests](../../tests/s14-recovery.test.ts) | Current actor checks, claims/reservations before effects, withdrawals, current usage maxima and owner-statement versus verified fact. Existing exact-effect approvals are not S15 standing grants. |

Pin: [vendor artifact](../../vendor/schway-1.0.0-rc.2-697bf40.tgz), `schway@1.0.0-rc.2`, upstream `697bf406a84c8d1deb8d4a6d71876ea1003be5b3`, SHA-256 `1c9d83de46edddff58a0163452e7f5ec8357e656c90093990fa28fa606a0f41b`. Static declarations and public re-exports were inspected from this exact artifact, without installing or invoking it:

- `createHost(options: HostOptions): Promise<HostRuntime>` accepts exact `tools:{policy:'exact',definitions:readonly ToolDefinition[],hostedLookup:'off'}` and finite `HostLimits`. `ToolDefinition<T>.execute(input:T,ctx:ToolContext):Promise<ToolExecutionResult>` supplies `workspace`, optional `signal` and `onOutput`. `execution:'exclusive'` orders sibling native tools; it does not coordinate a shared browser across runs or enforce effects. `effect:'read-only'|'mutating'` is metadata, not approval.
- `HostInput {text,images?}`, `ImageContent`, `createImageContent` and `HostImageOptions {probes,resolve:HostImageResolver}` support reference-only model images. `HostImageResolver(image:Readonly<ImageContent>,signal?:AbortSignal):Promise<Uint8Array|null>` needs a fresh authorized lookup of sanitized bytes. It neither captures nor redacts a screenshot. Exact route/model probe evidence and approved inference recipient are separate requirements; none is claimed here.
- `HostSession.submit`, `submitWithRoute`, `readResult`, cooperative `cancel`, inventory and opaque snapshots retain native ownership. Native completion/cancel is not browser/process/effect settlement. `ExecutionBackend` is trusted host code, not a browser sandbox. No browser/profile/takeover/dispatch-verifier export exists, and none is needed merely to compose admitted Jit custom tools. Only `schway/host` imports are proposed; no internal imports, provider protocol or competing loop.

## Proposed custody and capability

The protected service owns actors, catalogs, immutable payloads, work/action/request/continuity journals, budgets, current fences, source lineage and publication. A separate protected browser domain owns browser processes, profiles, cookies, passwords, 2FA, credential injection and the **entire dispatch path**. A manager/verifier outside the working guest and page-controlled browser execution authenticates endpoint/profile/session/process identity and settlement. Physical placement, peer authentication and actual interception mechanism are deliberately unfrozen proof obligations.

The guest/model receives only a purpose-scoped proposal interface and authorized sanitized observations/artifact references. It receives no raw profile path, cookie/password/token, browser session handle, owner/manager actor, CDP endpoint, arbitrary JS, network socket, credential resolver, signed broad capability or management port. Opaque refs/hashes below are protected records, not bearer tokens. JSON shape, brands, copied frozen objects, echoed nonce/IDs and hashes cannot authenticate a caller or attest an effect.

Team access is a mediated capability to an approved account/profile under current work and explicit narrower restrictions. The protected scheduler issues one input lease per session; no read acquires or renews it. Profile/account selection resolves from trusted catalog ownership and current consent, never caller URL, display name or an agent-selected profile directory. Cross-profile reads, input, frames, download/import and owner control all revalidate that identity. Shared defaults do not declassify S14-private data/accounts. Query/attach never starts a browser, logs in or provisions a profile.

## Closed data, hashes and proposed paths

The linked JSON Schema `$defs` specify all exact required data fields, closed unions and additional-key refusal. The schema is documentation, not a runtime validator or full target database. `Id` is ASCII `[A-Za-z0-9_-]{1,128}`; `Hash` is lowercase 64-hex SHA-256. `RefV1` is `{id,revision,generation}` with positive safe integers. Catalog kinds are distinct even when their shapes match. Counts/times are nonnegative safe integers. Reject `-0`, overflow, fractions/nonfinite values, malformed Unicode, NUL, duplicate keys, accessors/exotic prototypes, cycles and sparse arrays. Strings reject controls except TAB/LF/CR in content; URLs/headers/IDs reject all controls. No trimming, normalization, newline conversion, percent-decoding/re-encoding or redaction after hashing.

`C(x)` is compact JSON with ASCII object keys sorted by UTF-16 code units, arrays in declared order, standard JSON escaping/integer spelling, no BOM or trailing LF. `H(domain,x)=SHA256(UTF8(domain+'\n'+C(x)))`. Raw blobs/frames hash exact bytes without a domain. `BytesV1` is canonical padded RFC4648 base64 plus exact decoded byte count/SHA-256. Ref sets are sorted by canonical UTF-8 and unique by catalog ID; sequences such as request chains/headers remain ordered. Null is explicit, never empty-means-all. Hashes bind bytes, not truth, authentication or policy.

| Record | Hash domain / exact projection |
| --- | --- |
| `RegistrationV1`, `SupportV1`, `OperationV1`, `ClaimV1`, `ReceiptV1`, `ObservationV1`, `DownloadV1`, `EvidenceV1` | Respectively `s15.browser.registration.v1`, `s15.browser.support.v1`, `s15.browser.operation.v1`, `s15.browser.claim.v1`, `s15.browser.receipt.v1`, `s15.browser.observation.v1`, `s15.browser.download.v1`, `s15.browser.evidence.v1`; omit only that record's own `hash`, retain every nested hash |
| `BindingV1` | `H('s15.browser.binding.v1', complete binding)`; it has no own hash field |
| `TargetV1` | `H('s15.browser.target.v1', target excluding only its own hash)` binds the exact prior observation/binding/frame/document; private registry identity still controls use |
| `ActionPayloadV1` | Copy every operation field except `hash`, change `contract` to `s15-browser-action-payload/v1`, set `policy.action:null`. Canonical raw payload bytes are hashed **before** #320 prepares the action; then attach its action ref/hash and compute OperationV1.hash. No self-reference. |
| `WebActionPayloadV1` | Exact `{contract:'s15-browser-web-action/v1',operationProjectionHash,request}`. `operationProjectionHash=SHA256(C(ActionPayloadV1))`, never the final operation/action hash. The complete credential-free request precedes its own #320 action preparation. Each request/action is a separate protected invocation slot. |
| `WebRequestV1`, `ResponseV1`, wire records | `SHA256(C(complete record))`, no domain/field exclusion. Response hash excludes the 4-byte frame header. Request sequence order and raw body/header/url bytes are significant. |

An operation's optional `policy.action` binds its input/local mutation, not a wildcard permission for all resulting requests. The immutable input payload **does not contain future child action hashes**. The child's prepared request payload references the operation projection, and protected continuity separately binds parent/child claim IDs. Neither payload depends on its own eventual approval/claim hash. #320 `action.decide` appends a decision and leaves the prepared action revision/hash unchanged. Claimed slots cannot be revised/cloned/rekeyed to retry.

Proposed paths, none added as code here: `src/s15/browser-types.ts`, `browser-validation.ts` (schema/serializer/hash); `browser.ts`, `browser-policy-port.ts` (actor/slot/policy/claim); `browser-transport.ts`, `browser-manager.ts` (protected dispatch/observation/stop); `browser-input.ts` (lease/owner transient input); `browser-evidence.ts`, `browser-downloads.ts` (sanitization/lineage/quarantine); `browser-tools.ts` (public Schway adaptation); `browser-recovery.ts` (metadata reconciliation). Eventual tests: `tests/s15-browser-{validation,operations,input,transport,evidence,recovery}.test.ts`. Exported TSDoc and actual schemas/paths require review/freeze before admission. No i18n keys or UI handoff are authored.

## Operation and final-request semantics

`RegistrationV1` binds installation, manager, endpoint, profile, adapter and finite limits under an immutable current ref/hash. `BindingV1` binds registration/profile/session, manager/controller epochs, protected process generation, owner generation, work/attempt, input lease, takeover and observation generations. The manager issues epochs/process generations externally; guest/browser echoes never advance them. Profile/session/restart/owner/takeover changes fence old operations and observation-target handles. Lease expiry refuses at the final guard; release of an old lease cannot clear a newer one. `PolicyBindingV1` narrows #320 authority/resource/lineage/recipient/budget/upper-bound facts; it cannot create an actor or live policy verdict.

`OperationBodyV1` is exactly one of:

- `navigate {url}`: a credential-free exact HTTP(S) URL, <=4096 UTF-8 bytes, no userinfo or fragment. Navigation is potentially effectful/disclosing, including GET, referrers, cookies and redirects. It requires input ownership and separately admitted exact actual requests.
- `read {frame,document,format:'text'|'image'}`: capture only that already loaded current document under its binding. No navigation, eval, DOM mutation or implicit network refresh. Page timers/background requests remain covered by the always-on protected fence. Read authority, source access, inference recipient and finite observation limits apply even though no input lease is acquired.
- `interact {observationHash,document,target,interaction,value,deltaY}`: a current service-issued target from the exact observation/document, never raw CSS/JS/CDP or arbitrary coordinates. `click` has null value/deltaY; `fill`/`select` require nonempty non-secret value <=4096 UTF-8 bytes, null deltaY; `scroll` requires null value and nonzero integer deltaY in [-800,800]. Freshness and target membership are necessary but cannot prove safety. Every input/local-state/network consequence needs the support proof below. Enter/submit is not an implicit part of fill.
- `download {observationHash,request}`: exact known authorized request with source `download`, producing a bounded quarantined immutable file. No browser download directory or host path is exposed. Filename is a safe opaque ID; server Content-Disposition and MIME are untrusted. Download authority grants no execution/import/upload permission.

`SupportV1` pins adapter/schema, browser artifact, semantics/proof hashes, exact operations, coverage and expiry. **Only a protected installed catalog entry plus independently verified proof can supply support**; a client-provided structurally valid record or fixture `supportRegistered:true` cannot enable it. It must bind an actual current workflow/state and every relevant input, local-state, redirect/frame/popup/script/service-worker/download/upload/clipboard/file-chooser/network/credential/alternate-guest route. Uncovered paths are disabled before the initial input/network dispatch. Unknown semantics are `unsupported:effect_semantics_unknown`; a known preparable supported action missing authority is `hold`, with no dispatch. Approval cannot repair missing support.

### Required protected dispatch mechanism

This is a candidate contract for a complete mediator, **not proof an available browser can implement it**:

1. Before any input, verify a current support record establishing the complete reachable effect/disclosure surface for that input in that document/state. It must prove protected local-state mediation as well as network containment. Do not execute an unknown click/type/select merely to learn its effect. Unsupported local-state/implicit-submit semantics refuse before input.
2. The protected component must own all actual network dispatch, including browser-process/subprocess requests, redirects, new frames/popups, scripts/workers/service workers, prefetch, cache revalidation, beacon, WebSocket/WebRTC, DNS/QUIC and credential/referrer injection. Uncovered protocols are physically disabled. Page/guest code cannot select a second route or mutate final bytes after the gate. A CDP request callback, host allowlist, guest proxy or TLS pass-through alone is not this proof.
3. Freeze the actual **final credential-free request** in `WebRequestV1`: source/parent/frame, exact method/URL/ordered headers/body, actual recipient set, all applicable trusted effect classes, target precondition and semantics hash. Prohibit credentials in this record; resolve session credentials solely inside the protected broker for the exact approved account/origin. The protected verifier must prove injection cannot change approved recipients/content or expose secrets, including redirect/referrer/header/cookie scope. If a site encodes reusable auth in URL/body, this payload path is unsupported; use a separately reviewed secret boundary, never persist its hash/text as an ordinary action.
4. Prepare/authorize/claim each actual request and each protected local mutation under #320 with its own immutable slot and finite upper bound. Match every applicable communication/payment/disclosure/production/major-change gate, including GET effects. Redirects/new recipients are **new exact requests**, never inherited permission. Unknown child semantics prevent dispatch; known children may be held. Previously dispatched parent facts remain recorded, and the overall task is partial/held/unknown as appropriate.
5. Under one externally effective current-fence boundary, the mediator checks final bytes, account/recipient/target version, support and claim/reservation, consumes the original one-use context and owns the dispatch. Conditional remote writes or equivalent proven serialization must close relevant target races. Revocation ordered before this point prevents dispatch. After dispatch it fences future activity/publication but cannot recall an effect. No available conditional ordering means unsupported for that action class.
6. Persist captured request/response/outcome and usage under the original claim. Automatic mutation retries, redirect auto-follow, SDK retry, browser resubmit, reconnect resend and fallback shell/MCP/network paths are disabled. Read-only reconciliation has separate current finite authority and never re-sends a mutation. Unknown remote outcome stays reconcile-only even after browser stop.

General navigation/read/necessary ordinary interaction/download **without bespoke business integration remains the confirmed target**. This proposal specifies general protocol operations; it does not substitute a read-only-only final product or claim universal site support. Frozen support entries must ultimately demonstrate representative usable workflows and truthful unsupported limits. No live browser, site or callback signature here proves this mechanism.

## Trusted ports and guarded result path

The following are proposed signatures. Data types are the exact named schema definitions. `OwnerActorV1`, `WorkActorV1`, `PreparedActionV1` and `DispatchPermitV1` refer to the pinned #320 proposal. Brands explain opacity; private instance registries and current authenticated owner/work/manager custody enforce it. No actor/context/handle is serializable or issued by these data schemas.

```ts
import type { ToolDefinition } from 'schway/host';
declare const browserBrand: unique symbol, dispatchBrand: unique symbol;
declare const cleanupBrand: unique symbol, managerBrand: unique symbol;
declare const ownerInputBrand: unique symbol;
interface BrowserHandleV1 { readonly [browserBrand]: true }
interface BrowserDispatchContextV1 { readonly [dispatchBrand]: true }
interface BrowserCleanupContextV1 { readonly [cleanupBrand]: true }
interface BrowserManagerActorV1 { readonly [managerBrand]: true }
interface TransientOwnerInputV1 { readonly [ownerInputBrand]: true }
interface BrowserOperationPortV1 {
  prepare(actor: WorkActorV1, binding: BindingV1,
    body: OperationBodyV1): Promise<OperationV1>;
  accept(actor: WorkActorV1, operation: OperationV1): ReceiptV1;
  dispatch(actor: WorkActorV1, operationId: string, operationHash: string,
    signal?: AbortSignal): Promise<OperationObservationV1>;
  readResult(actor: WorkActorV1, operationId: string,
    operationHash: string): Promise<ResultReadV1>;
  publishResult(actor: WorkActorV1, operationId: string,
    operationHash: string, responseHash: string,
    consume: (response: ResponseV1) => void): void;
  cancel(actor: WorkActorV1, operationId: string,
    operationHash: string): Promise<CancelObservationV1>;
  reconcile(actor: BrowserManagerActorV1,
    claimId: string): Promise<OperationObservationV1>;
}
interface BrowserTransportPortV1 {
  invoke(handle: BrowserHandleV1, context: BrowserDispatchContextV1,
    request: WireRequestV1, signal?: AbortSignal): Promise<ResponseV1>;
  cancel(handle: BrowserHandleV1, context: BrowserCleanupContextV1):
    Promise<CancelObservationV1>;
}
interface BrowserEmitterPortV1 {
  /** Synchronous final handoff; consumes the registered original input context.
   * Every actual input message belongs to this one guarded sequence. */
  dispatchInput(handle: BrowserHandleV1, context: BrowserDispatchContextV1,
    operation: OperationV1, finalBytes: Uint8Array): void;
  /** Synchronous protected request handoff; consumes the exact child permit.
   * Responses return only through invoke's retained ResponseV1 path. */
  dispatchRequest(handle: BrowserHandleV1, permit: DispatchPermitV1,
    request: WebRequestV1, finalBytes: Uint8Array): void;
}
interface BrowserPolicyPortV1 {
  check(operation: OperationV1,
    stage: 'accept' | 'claim' | 'final_input'): BrowserDecisionV1;
  continueOriginal(context: BrowserDispatchContextV1,
    operation: OperationV1, finalBytes: Uint8Array): void;
  authorizeRequest(context: BrowserDispatchContextV1,
    action: PreparedActionV1, request: WebRequestV1,
    finalBytes: Uint8Array): DispatchPermitV1;
  publish(operation: OperationV1, response: ResponseV1,
    observation: OperationObservationV1): void;
}
interface BrowserManagerPortV1 {
  attach(actor: BrowserManagerActorV1,
    registration: RegistrationV1): Promise<BrowserHandleV1>;
  observe(actor: BrowserManagerActorV1, handle: BrowserHandleV1,
    claimId: string): Promise<EvidenceV1>;
  stop(actor: BrowserManagerActorV1, handle: BrowserHandleV1,
    claimId: string): Promise<OperationObservationV1>;
}
interface BrowserOwnerPortV1 {
  takeover(actor: OwnerActorV1, command: OwnerCommandV1): OwnerReceiptV1;
  sendInput(actor: OwnerActorV1, handle: BrowserHandleV1,
    requestId: string, input: TransientOwnerInputV1,
    signal?: AbortSignal): Promise<OwnerReceiptV1>;
}
/** Protected construction pins the current work/slot, never a model actor. */
declare function protectedBrowserTools(actor: WorkActorV1,
  binding: BindingV1, operations: BrowserOperationPortV1):
  readonly ToolDefinition[];
```

`BrowserPolicyPortV1.check` returns `BrowserDecisionV1 {state:'allow'|'hold'|'deny'|'unsupported',code:CodeV1|null}` for that exact stage, not a caller-provided assertion or a committed intent receipt. Only allow has code:null. It causes no dispatch; claim/reservation commit remains the operation port's atomic obligation. `authorizeRequest` resolves a **separately registered original child context** from the parent context and exact action/request; it cannot reuse a consumed parent permit for another request. Its permit is consumed only by the protected final request emitter. Physical binding/linearization remains BROW15-FZ04, not a power conveyed by the signature.

The trusted `invoke` adapter resolves its pinned policy/emitter dependencies from the private context registry. It calls `continueOriginal` immediately before `dispatchInput`; for every child it calls `authorizeRequest` immediately before `dispatchRequest`. No untrusted mutation or wait may intervene. The emitter owns the final bytes through the externally effective dispatch boundary, and records actual sent/unknown facts even if it throws after possible handoff. Incoming observations return through `invoke` and protected retention only. No model-supplied callback, alternate input emitter or undocumented network route is admitted. The synchronous signatures specify an obligation; they do not prove that a physical browser/network adapter satisfies it.

The complete tool path is `prepare(actor,binding,body)` → `accept` → `dispatch(...,ctx.signal)` → `readResult` → **synchronous `publishResult`** → construct bounded `ToolExecutionResult` / approved image/artifact reference from that supplied response. No second invoke, hidden raw-response map, guest fetch, unguarded progress stream or direct CDP channel supplies output. `readResult` returns `pending` without payload while required operation/channel settlement is missing; `withheld` without payload on cancelled/stale/withdrawn/unauthorized output. Producing claims are expected at publication, not treated as duplicate dispatch.

Before returning tool data, emitting `onOutput`, resolving model image bytes, promoting/download-delivering an artifact or adding report/memory lineage, recheck current publication/source/recipient/owner/work/Bot/profile/session/process/attempt/lease/takeover/observation generations. `publishResult` checks the immutable response hash and executes only the trusted synchronous callback with no intervening wait. Async image/file/delivery work reacquires its own current publication guard at its final byte handoff. Callbacks cannot reenter mutation. No effect approval or already charged reservation is requested twice for the same producing operation; actual additional reads/delivery need their own finite authorization.

Register cancellation before the first wait; already-aborted signal refuses before claim. Abort after claim latches a publication fence, invokes the **same memoized original-scope cancel**, and reports cancellation to the caller while protected fact capture/settlement continues. `cancel` resolves retained cleanup authority from registered actor/slot/hash even after work expiry/revocation; it sends at most one bounded cooperative signal and does not acquire new work power or affect sibling sessions. Copied actors refuse. Process loss destroys the context: recovery uses separately authorized manager reconciliation and cannot reconstruct mutation or cleanup handles from JSON.

## Bounds, response validation and evidence

`jit.protected-browser/v1` is a proposed transport-neutral host-initiated **one request / one response** channel. A registered protected adapter authenticates peer/endpoint/profile independently. `WireRequestV1` contains exact operation, service invocation ID and nonce; none is a credential. No page/guest opens this channel, provides an endpoint, injects unsolicited events, multiplexes or negotiates downgrade. Login/2FA notifications are safe results of bounded authorized observation, not arbitrary browser push granting authority.

Frames are exactly 4-byte unsigned big-endian length followed by canonical UTF-8 JSON, no trailing bytes/second frame. Check nonzero directional length before allocation, exact EOF, strict UTF-8, no BOM/duplicate keys, depth <=16, <=128 properties/object, <=256 entries/array, exact schema/hash/correlation. No compression or stderr-as-JSON. Proposed hard ceilings, which registered configuration may lower:

| Resource | Hard ceiling; not an operating allowance or measured sizing |
| --- | --- |
| Request / response payload | 131072 / 4194304 bytes, excluding length header |
| Text observation / image / download | 32768 / 2097152 / 1048576 decoded bytes; one output per response; response frame cap also applies |
| URL / fill/select / all ordered headers | 4096 / 4096 / 16384 UTF-8 bytes; <=32 header entries; no auth/cookie/proxy/control headers in ordinary payload |
| Operation / connect / inter-byte idle / cleanup | 30000 / 10000 / 5000 / 5000 ms; absolute protected monotonic deadline includes queue and all waits, never reset by trickle/reconnect/child request |
| Session idle / queue / active input / processes | <=300000 ms idle; <=16 queued operations/session; exactly one active input sequence/session; <=2 browser processes per registered profile, plus finite installation ceilings |
| Request chain / frame targets | <=32 requests per admitted operation and <=64 frames/targets; each request reserves before dispatch, no unbounded background traffic |
| CPU / memory / PIDs / disk | Positive finite configured ceilings, externally enforced and verified before support; account for browser/subprocesses/cache/download/quarantine/manager overhead. Missing measured/enforceable profile refuses admission. Fixture values are synthetic. |

Scope-specific monotonic expiry is checked after every wait and at actual input/network I/O. Wall-clock `createdAt/expiresAt` additionally bound current policy/support/catalog validity; clock rollback cannot extend a monotonic deadline. A child cannot extend the parent's deadline. A fresh settlement observation has its own finite read window <=30000 ms. Further observation needs new authorization; expiry retains unknown/held capacity.

`ResponseV1` must correlate exact operation hash/invocation/nonce/binding. `captured` requires one observation plus output and no boundary/code; its raw payload hash/length/media type must match observation metadata. A download additionally requires matching DownloadV1, source/request hash/lineage and quarantined artifact bytes; other operations have download:null. `boundary` requires only BoundaryV1 and matching login/2FA code where applicable; no observation/output/download. `refused` requires code and no payload/boundary. Any contradiction is protocol_error; after possible dispatch, outcome is unknown. A valid captured response describes what the browser actually exposed, not proof of a remote business success.

Observation payloads are authorized **sanitized** bytes. Protected capture first withholds login/2FA/password/cookie/token/autofill/secret-bearing material; screenshot masking by field type alone cannot prove secrets absent. Use a proven authorized safe observation surface or refuse `secret_boundary`. Raw secret captures are not ordinary retained evidence, prompt, report, log, memory or export. Where protected quarantine is required, it is separately bounded and inaccessible to work tools. Sanitized versus raw hashes never share an identity. Text/HTML/control sequences render inert; partial/truncated/missing frames and actual capture time/source coverage are explicit. Claims/citations refer only to observations actually read, never model descriptions or a requested URL alone.

Downloads are decoded with size/hash/type checks, sanitized metadata and no automatic renderer/open/execute. Reject executable/active content as a normal report payload; untrusted HTML remains inert and cannot load external resources. Archive expansion, symlinks/path traversal, MIME mismatch and cross-profile access cannot select a host/guest destination. A subsequent workspace import is a separately authorized exact immutable blob/lineage/destination release through the VM's guarded file operation contract; **no import implementation or new import port is supplied here**. Until its serializer/recipient/consent/resource bounds are frozen, `import_unsupported`. No raw profile, browser cache, cookie jar or session export is a download.

## Input, cancellation, settlement and publication facts

| Fact | What it establishes / does not establish |
| --- | --- |
| Accepted intent / claim | One durable deduped local intent; claim/reservation before I/O. Neither means input/network was sent. |
| Input acknowledgement | Exact physical input enqueued/acknowledged. It is not remote effect success or permission for follow-on network. |
| Actually dispatched network/effect | Protected emitter recorded actual request/claim and irreversible boundary. Missing response leaves remote outcome unknown; channel failure cannot turn sent into not_sent. |
| Captured response / observation | Immutable bytes actually captured from the bound browser/source. It can coexist with unknown effects, unsettled scope or withheld publication. |
| Cooperative cancellation | Original bounded cleanup requested; no proof browser/input/network stopped. Native cancellation, abort, timeout and socket close cannot certify it. |
| Transport settlement | Exact channel and bounded transport tasks are closed, verified independently. A recorded response remains recorded. |
| Operation quiescence | Registered verifier proves exact input sequence and all attributed descendant requests/tasks stopped or durably transferred to separately accounted fenced scopes; no unowned deferred input/effect. A browser ack or guest assertion is insufficient. |
| Browser process stop | Independent manager proves exact session/process generation and descendants stopped; this releases that process capacity, not a remote effect claim or historical occurrence. |
| Final publication | Separate current-authority/lineage/recipient/delivery-dedupe check permits only this retained result's handoff; no new browser action. |

`FactsV1` records these independently. After dispatch, channel and input/scope capacity remain held until their respective proof; process capacity remains held while the browser/session runs even after an operation is quiescent. A result may be available with process running when channel closed and exact operation scope quiescent under a proven always-on fence. Without that proof, retain pending/unknown rather than pretend a screenshot or response settled background effects. Process stop can settle old exact operation scopes even after revocation, without changing current publication authority. Whole-profile/browser stop affecting siblings needs current authority for the full impact; one-work cancel cannot silently widen to it.

`EvidenceV1` is only a serialized reference to protected verifier-owned proof. Accept it solely through the registered verifier/actor/handle identity, exact manager/epoch/session/process/invocation and current proof registry; owner statements, page/guest output or copied JSON are not attestation. Reject mismatched evidence **without rewinding responseHash, known channel closure, input/network dispatch, charged/actual usage or any settled resource fact**. Valid process-stop evidence changes only the exact resource scopes it proves. Channel closure cannot be inferred from process stop without independent channel evidence. Unknown historical effect stays unknown; an actually observed response stays observed. Subsequent verified fact correction is append-only with explicit provenance, never erasure of earlier facts.

Owner takeover records current lease/takeover generation synchronously and fences queued agent input/publication; owner input waits for prior physical input to settle. `takeover.end` advances generation, clears owner lease and cannot resurrect an old agent lease or approve a pending action. A fresh admitted attempt acquires a new lease. Reads do not acquire or renew one; observation publication still follows current access/takeover/sensitive-boundary policy. Stale release is a no-op with respect to newer ownership.

Login/2FA requires a payload-free BoundaryV1. Only authenticated protected owner ingress can issue `TransientOwnerInputV1`, registered to one exact handle/binding/lease/request and typed click/text/key constraints no wider than the reviewed S14 input seam (1280x800 coordinates, 1–2000 well-formed UTF-16 text units without NUL, fixed key enum). It carries no serializable text field. Secret text passes directly through the separately protected channel and is destroyed after bounded use; no runner/shell, model, receipt, raw/unkeyed password digest, log, screenshot or export. Dedupe retains only process-keyed HMAC and safe IDs/outcome in protected storage. Cross-process same request is unknown/no resend; changed same-process bytes conflict. Owner direct input is not a general agent bypass: login credential entry is scoped to the approved account/origin, and any resulting send/payment/new-recipient/production/major effect still needs its exact current authority. Login success never installs a rule.

## Policy, continuity and recovery

Accept authenticates the registered work actor and current catalog facts after locks, commits the installation-wide request/hash receipt before acknowledgement and sends nothing. Same request/hash returns the historical receipt without new queue/claim/reservation; different kind/hash conflicts in the shared owner request namespace. A historical receipt is not current dispatch permission. At claim, atomically bind the #320 claim/reservation and browser claim in the **single current continuity authority** before I/O. Mutation requires a supported prepared action; read-only observation has a separately authorized read slot. No partial cross-store claim can emit bytes.

New dispatch rejects existing claimed slots. Only the original privately registered **unconsumed** context may continue that exact claim/reservation, even when its charge exhausted remaining allowance. Recheck current authority/expiry/fences/final bytes after every wait, without reserving the same operation twice. A consumed/recovered/lost context cannot dispatch. #320's conservative finite upper bounds are nonrefundable; unknown actual usage is null, never zero. Settlement releases concurrency only, never charges. Additional actual child requests/reads/reconciliation/delivery have separately bounded slots; a parent allowance is no blanket spending permission. Missing finite cost/resource bound holds before claim.

Hard failures precede approval: authentication/schema/hash/continuity, claimed/lost context, unproven support, revoked/stale/expired/source/recipient/scope restrictions. Then finite reservation/capacity and known policy/human gates apply. Exact denial vetoes that action revision. Product-default GitHub push/PR/update/replies hold; only separately installed bounded personal publication rules can satisfy their technical classes. Merge needs separate authority and verified target/head/evidence/checks; production holds before a production-triggering merge absent an effective protected gate. Communication, payment, new private-data recipient and major-change direction bind actual final semantics; browser/guest/JS/CDP/GET paths cannot remove them. No budget/account/model readiness, permanent-Bot policy or Jod integration is inferred.

On restart: fence leases/epochs/publication, reconcile current continuity and exact external session/process/channel/scopes; do not replay input, accepted queue intents, claimed requests or owner text. Recovered claims remain reconcile-only even if local records say no send. Missing/conflicting continuity blocks all admissions; never bootstrap an empty ledger. Reconciliation preserves actual response/dispatch/channel facts and current charges/withdrawals/policy revocations. Stop proves cessation, not historical non-occurrence or undo of external effects.

Adoption/rollback preserve ADR0065's current ledger/request/claim identity, usage, withdrawals, policy revocations and old/new boot fence. Original S14/legacy bytes and private account/source/profile restrictions remain. Old grants/approvals/routines/queues are nondispatchable. No native/raw profile relocation, copy, merge or team promotion; native workspaces remain fixed/opaque through public Schway APIs. Complete target DDL/materializers, protected maintenance ports and reverse compatibility remain MIG15 obligations. Unsupported rollback fences both runtimes. No inherited allowance, live grant or automatic host activation.

## Candidate support, impact and attack matrix

Every candidate below is **unproven** until the named freeze/proof evidence. Allow/hold/deny describes intended protocol outcomes under explicit fake trusted facts, not live support.

| Surface / impact | Candidate outcome and required proof |
| --- | --- |
| Public navigation/read/pagination/search, no bespoke business API | Allow only current proved input/request semantics and authorized actual recipients/content; bounded actual observation/file evidence. Missing general interaction proof is unsupported, not completed read-only product. |
| Necessary click/fill/select/scroll | Prove target/state freshness, local effects, full reachable dispatch surface and exclusive input. Misleading labels, hidden submits, onchange/keyup/autosave and GET writes cannot downgrade classes. Unknown refuses before input. |
| Redirects/frames/popups/scripts/service workers | Each actual child request gets its own support/current recipient/action claim. Block automatic follow/retry and unseen frames. No inherited parent approval; protect cross-origin credentials/referrer. |
| Sending/payment/business commitment/GitHub/production | Known supported exact semantics hold at applicable #320 human gate; unknown unsupported. Account login, green review or button label cannot authorize. Prove every browser/guest alternate route. |
| Download/content/cache/output | Quarantine exact bounded observed bytes, inert rendering/lineage; no execution, raw profile export or implicit import. New recipient/upload is separately held. |
| Upload/clipboard/file chooser/drag-drop/permission APIs | No generic agent port in v1. Refuse before input/network; an eventual known preparable release requires exact content/recipient/approval and a reviewed new adapter contract. Clipboard and local file reads must not bypass custody. |
| Login/2FA/autofill/session transition | Payload-free event and protected authenticated owner input; suppress secret observation, fence old session/document/lease. Login grants no future effect authority. |
| Guest root/shell/MCP/raw CDP/JS/proxy/network | Deny protected profile/control access; externally block alternate effect/disclosure routes. Guest firewall/sibling container/host allowlist alone is unproven. RT15-01 stays unresolved. |
| Takeover/end/expiry/reset/revoke/restart races | Immediate generation fencing; wait already sent physical input; stale release cannot clear new lease; cancel/close is separate from stop and unknown effects. |
| Copied handle/manager proof/cross-profile read/import | Deny by private registry/current exact scope, not structural IDs/hash; retain previously recorded facts. |
| Shared process stop / profile reset / account deletion | Full impact authority and external exact settlement before reuse; no silent sibling disruption, loss acceptance or profile relocation. Lifecycle provisioning/reset implementation is outside this preparation. |
| Old image/rollback/native snapshot | Current continuity wins; old authority nondispatchable, no refund/withdrawal rewind, fixed opaque native workspace. Unsupported reverse projection refuses. |

## Freeze and proof obligations

| Gate | Required before corresponding implementation/support/activation claim; all OPEN |
| --- | --- |
| BROW15-FZ01 prerequisite reconciliation | Actual merged reviewed #318/#320/#321 contracts/ADRs/fixtures in integration base, source drift and #319 continuity checked. Native #321 remains OPEN; closure/review alone is insufficient. |
| BROW15-FZ02 schema/actors/ports | Review/freeze all closed records, semantic validators, exact hash projections/serializer, private actor/handle/target issuance, trusted catalog resolver and exported TSDoc/paths. Define durable receipt/claim/reservation mapping and crash ordering; no DDL supplied here. |
| BROW15-FZ03 profile/input/observation | Prove endpoint/profile/account/session/process identity and custody outside guest/page authority, exclusive input/takeover/secret boundary, sanitization/source lineage and fresh guarded model/image/artifact publication. |
| BROW15-FZ04 actual dispatch/support | Select and prove the complete protected final-input/local-state/network/credential emitter and remote conditional ordering, every supported workflow/recipient/content/alternate route and truthful unsupported classes. Signature, CDP callback, model label, GET or allowlist is insufficient. Representative general workflow without bespoke business API remains required. |
| BROW15-FZ05 bounds/settlement/recovery | Freeze measured finite profiles/deadlines, strict framing, cancellation/manager verifier proof, operation/channel/process accounting, request replay and monotonic facts through restart/revoke. Preserve upstream original-context continuation and separate publication. |
| BROW15-FZ06 download/import/adoption | Freeze exact quarantined artifact/export/import serializer, media/active-content/data-recipient checks, full target/maintenance/current-ledger/prior-build compatibility in respective slices. Preserve S14-private and fixed opaque native boundaries; no raw profile promotion. |
| BROW15-FZ07 acceptance | Convert complete synthetic definitions into deterministic Bun/TypeScript fixtures after admission; separate opt-in real browser/VM/Linux x64/arm64/bypass/build/policy/host evidence and owner adoption under EVID15/CUT15. RT15-01/RF15-G01–G08 remain unproven. |

Local schema/type/fixture/hash/link/requirement/monotonic-fact checks and `git diff --check` validate documents only. No runtime tests/typecheck, controlled browser execution, executable probe, account/provider/subscription call, transport/platform conformance or enforcement proof was run. Required Claude authoring remains unavailable under [#337's recorded limit](https://github.com/chayapats/jit/issues/337#issuecomment-6572828439); no retry/substitute/UI authorship. This bounded preparation uses **Refs #322**, preserves every original acceptance criterion/native blocker and leaves the issue/PR OPEN with no merge.
