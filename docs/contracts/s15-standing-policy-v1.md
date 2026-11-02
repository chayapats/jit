# s15-standing-policy/v1

Status: **proposed, pre-admission contract**, revision **1**, 2026-11-02. Bounded preparation for step 1 of [POLICY15-01 #320](https://github.com/chayapats/jit/issues/320), not its implementation or completed contract freeze. [ADR 0066](../adr/0066-s15-standing-policy-and-prepared-actions.md) records proposed choices. Requirements: **FR-06/13/14/15/17/18/35/37/38; NFR-05/06/07/14; S15-AC07/08/09**. Related constraints: S15-AC01/02/04/10/11/12/14/15/16. No FR/NFR or confirmed S15 decision changes.

This document specifies proposed record schemas and trusted ports, not executable APIs, DDL, installed grants or a host acceptance. S14 remains the implemented default; `message.post`, `task.accept`, `work.start`, exact-effect approval and Bot-private resource semantics retain their current meaning. No UI/UX is authored. Full domain storage, conversational parsing, real effect brokers, VM/browser/session transports and activation belong to their delivery slices.

## Inspected evidence and admission boundary

| Input | Inspected revision and meaning |
| --- | --- |
| Integration main / implementation source | `64f3a94726fdbce2283aec0944884ca7406d9934`; #317 / PR #343 and #319 / PR #344 are merged |
| State contract on main | [s15-state-transition/v1](s15-state-transition-v1.md), blob `5e6ba001820e1f41728c8a124ed361414187e4fb`; [ADR 0065](../adr/0065-s15-state-preservation-and-policy-adoption.md), blob `fb451e10fdb67064f484d02029a18cc18672c62b`: proposed audit contracts, not implemented S15 |
| ADR 0064 on main | Blob `03593d4622f55aa220b62718fd0da18cb64d8154`; proposed protected-authority boundaries |
| Unmerged #318 evidence | [PR #345](https://github.com/chayapats/jit/pull/345), head `c79aab9d098c902db0cdff7f3d649ca389fff08c`; [feasibility contract](https://github.com/chayapats/jit/blob/c79aab9d098c902db0cdff7f3d649ca389fff08c/docs/contracts/s15-runtime-feasibility-v1.md) blob `f7237a3aa7843da00d55493a127a7107263b0824`; [proposed ADR 0064 revision](https://github.com/chayapats/jit/blob/c79aab9d098c902db0cdff7f3d649ca389fff08c/docs/adr/0064-conversational-authority-and-protected-control-plane.md) blob `08099feea574c717684099b1070a2d5fe13e1a18` |
| #318 status at preparation | OPEN; PR #345 OPEN, Greptile 5/5 APPROVED / check SUCCESS at that head; no merge authorization. Evidence is remote proposal input, absent from main. No branch from, cherry-pick or whole-file copy of #345. |
| Admission and delivery record | [Preparation evidence](../evidence/s15-policy-contract-preparation.md); #320 remains OPEN / needs-triage, native blockers #318 OPEN / #319 CLOSED. All assumptions below require reconciliation with the actual merged reviewed #318 revision. |

RF15-G01–G08 and RT15-01 in that remote proposal remain **unproven**. Policy-only logic can be specified separately; this does not prove real enforcement, select an administration tradeoff, supply all #320 acceptance evidence or make #320 ready-for-agent. No missing Schway contract is inferred.

## Trust, custody and authority

The protected service owns authentication, policy/catalog revisions, work admission, budgets, immutable payloads, claims, receipts, current continuity and publication. Working VM root, models, utility MCP, repository text, websites, channel payloads, memory and native history are untrusted. No Jit/provider/channel/vault credential, sensitive website session, protected state or unrestricted control handle enters their boundary, prompts or ordinary exports. Sensitive browser custody is separately protected, not a sibling service inside the guest.

Three authorities have different lifetimes:

1. **Owner ingress:** a live authenticated session at the protected ingress yields an opaque owner actor. A typed command must correspond to the actual current owner request, not quoted instructions. Authentication alone does not turn inspect-only text into execution or approval. HTTP/local/channel ingress must preserve its own Host/Origin/CSRF or verified binding controls; channel identity/forwarding alone is insufficient. Exact conversational interpretation and channel transport are CHAT15/UX/adapter freeze obligations, not supplied here.
2. **Work authority:** a trusted admission binds an authenticated execute request to a purpose and current standing ceilings. An obligation acceptance or selected issue without a start instruction creates no execution. Selection and start can be one owner request. A durable work authority remains live after that owner's transport session ends until its own expiry/revocation/stop or owner-generation change. A service-issued opaque work actor allows only the admitted attempt/handler's narrowing. It never has the owner mutation port.
3. **Action authority:** a current ordinary/standing rule match or exact single-use approval can authorize one prepared action inside live work ceilings. Approval cannot extend a purpose, enable a route/account, lift a restriction or make an unsupported adapter safe. A held action may outlive model-run settlement while its bounded originating authority remains live; it cannot reopen inference/tools. Approval authentication is rechecked at decision commit; dispatch checks the durable decision and current owner generation, not the expired login session that created it.

Both actors below are process-local identities registered by the owning service (for example, a private WeakMap). A TypeScript brand, frozen object, JSON `ownerId`, copied actor, valid hash, stored receipt or session-history role is **not** authentication. Revalidate the registry entry and current verifier/generation inside every writer transaction after lock acquisition. Reopening a process requires fresh actor issuance; work recovery requires reconciled current durable authority, never deserialization of an actor. Actor/transaction/permit constructors are private to trusted composition, unavailable to models and guest tooling.

## Closed schema and canonical bytes

The TypeScript notation below is a **documentation schema** for proposed files. Every field is required; `null` is explicit and is never an implicit default. Unions are closed and additional keys refuse, including authority-bearing keys nested in proposals. Alias comments are validation rules, not executable brands.

| Primitive / collection | Exact validation |
| --- | --- |
| `Id` | ASCII `[A-Za-z0-9_-]{1,128}`; no paths, aliases or credential-shaped values |
| `Hash` | Exactly 64 lowercase hexadecimal characters |
| `Nat`, `Pos`, `Time` | Safe integer 0..9007199254740991, positive integer 1..9007199254740991, epoch milliseconds in that same nonnegative range. Reject `-0`, fractional/nonfinite values and overflowing arithmetic. |
| `Minor` | Canonical nonnegative decimal string, `0` or `[1-9][0-9]{0,29}`; exact integer arithmetic; no float, negative, exponent or implicit currency conversion |
| Strings | Well-formed Unicode; no NUL/control characters except TAB/LF/CR in content. No trimming, Unicode normalization, newline rewriting or credential redaction after hashing. Reject prohibited credential content before preparation; protected credentials use separate write-only services. |
| Records | Plain own enumerable data properties; reject accessors, cycles, sparse arrays, symbols, exotic prototypes and duplicate JSON object keys before parsing destroys that evidence |
| Bounds | Canonical record/command <=131072 UTF-8 bytes, depth <=16, <=256 array items / object properties. Each named reference set below <=64 items; no wildcard or empty-means-all. Blob bytes <=1048576 each and <=8388608 total per action; these are proposed parser ceilings, not spend/resource allowances. Larger input refuses. |
| Sets / sequences | Reference sets sorted by UTF-8 bytes of canonical ref, unique `(id)` within each catalog kind; class/operation sets sorted ASCII and unique. Attachment/payload sequence order is significant. Reject noncanonical set ordering rather than silently deduplicating. |

`C(x)` is compact JSON with object keys sorted lexicographically by UTF-16 code units (as [S14 canonical](../../src/s14/validation.ts)), arrays in declared order, JSON string escaping and finite integer JSON spelling; no trailing LF/BOM. Keys in this schema are ASCII. Define `H(domain,x) = SHA256(UTF8(domain + "\n" + C(x)))`, lowercase hex. Blob SHA-256 hashes raw bytes without a domain prefix. Hash after full validation and before persistence; verify again on read/use. The existing `canonical`/`digest` algorithm can inform implementation within its bounds; `text()` trims/redacts and is unsuitable for exact final-action bytes. Existing S14 hashes do not acquire this domain separator retroactively.

Hash domains are exactly `s15.policy.v1`, `s15.rule.v1`, `s15.command.v1`, `s15.action.v1`, `s15.authority.v1`, `s15.approval.v1`, `s15.claim.v1`, `s15.receipt.v1`. Exclude only a record's own digest field: `actionHash` for PreparedActionV1, `hash` for WorkAuthorityV1/ApprovalV1/ClaimV1/ReceiptV1. All other hash fields, including a receipt's `payloadHash`, remain included. A command has no own digest field; hash its complete envelope and store the result as the receipt's `payloadHash`. Policy/rule hashes include all fields; their hashes reside in trusted catalog entries, not inside those records. Hashes prove byte equality, never actor identity, owner intent or actual remote occurrence.

```ts
type Id = string; type Hash = string; type Nat = number;
type Pos = number; type Time = number; type Minor = string;
interface RefV1 { id: Id; revision: Pos; generation: Pos }
interface BlobV1 { id: Id; sha256: Hash; bytes: Nat; mediaType: string }
interface AdapterV1 { id: Id; version: Pos; schemaHash: Hash }
interface SelectionV1 { route: RefV1; model: RefV1; effort: Id }
interface VectorV1 {
  attempts: Nat; steps: Nat; calls: Nat; reads: Nat;
  outputBytes: Nat; activeMs: Nat; spendMinor: Minor;
}
interface UsageV1 {
  attempts: Nat | null; steps: Nat | null; calls: Nat | null;
  reads: Nat | null; outputBytes: Nat | null;
  activeMs: Nat | null; spendMinor: Minor | null;
}
type EffectClassV1 = 'ordinary_edit' | 'communication' | 'financial'
  | 'github_publish' | 'github_merge' | 'production' | 'disclosure'
  | 'major_change';
interface BudgetV1 {
  ref: RefV1; continuityId: Id; currency: string;
  startsAt: Time; expiresAt: Time; ceiling: VectorV1; concurrency: Pos;
}
interface RuleV1 {
  ref: RefV1;
  mode: 'ordinary' | 'communication' | 'recurring_payment'
    | 'personal_github_publish' | 'personal_github_merge' | 'deny';
  purposes: RefV1[]; resources: RefV1[]; bots: RefV1[];
  selections: SelectionV1[]; recipients: RefV1[];
  adapter: AdapterV1; operations: Id[]; classes: EffectClassV1[];
  budget: RefV1; maxPerAction: VectorV1;
  recurrence: { payee: RefV1; account: RefV1; currency: string;
    amountCeilingMinor: Minor; frequency: RefV1 } | null;
  github: { repository: RefV1; targetRef: string;
    requiredEvidence: RefV1 } | null;
  expiresAt: Time;
}
interface StandingPolicyV1 {
  contract: 's15-standing-policy/v1'; ref: RefV1;
  installationId: Id; ownerGeneration: Pos;
  purposes: RefV1[]; resources: RefV1[]; bots: RefV1[];
  selections: SelectionV1[]; recipients: RefV1[];
  budgets: RefV1[]; rules: RefV1[];
  githubPublicationRule: RefV1 | null;
  githubMergeRule: RefV1 | null; expiresAt: Time;
}
interface RequestV1 {
  ingressId: Id; conversation: RefV1;
  intent: 'accept_obligation' | 'inspect' | 'execute';
  purpose: RefV1;
  subject: { resource: RefV1; key: string } | null;
}
interface WorkAuthorityV1 {
  contract: 's15-work-authority/v1'; ref: RefV1;
  installationId: Id; ownerGeneration: Pos; ingressReceipt: Hash;
  request: RequestV1; policy: RefV1; policyHash: Hash;
  bots: RefV1[]; resources: RefV1[]; selections: SelectionV1[];
  selectionPin: SelectionV1 | null; recipients: RefV1[];
  budget: RefV1; ceiling: VectorV1; expiresAt: Time; hash: Hash;
}
interface AttachmentV1 { name: string; payload: BlobV1 }
interface GithubV1 {
  repository: RefV1; selectedIssue: Pos; targetRef: string;
  baseOid: string; headOid: string; evidence: BlobV1;
  production: 'none' | 'protected_gate' | 'would_deploy' | 'unknown';
  deploymentGate: RefV1 | null;
}
interface DetailsV1 {
  operation: Id; classes: EffectClassV1[];
  target: RefV1; targetVersion: string;
  recipients: RefV1[]; payload: BlobV1; attachments: AttachmentV1[];
  transaction: { payee: RefV1; account: RefV1; currency: string;
    amountMinor: Minor; frequency: RefV1 | null } | null;
  github: GithubV1 | null;
  disclosure: { recipients: RefV1[]; payloads: BlobV1[] } | null;
  impact: 'reversible' | 'major' | 'unknown';
  directionDecision: RefV1 | null;
}
interface PreparedActionV1 {
  contract: 's15-prepared-action/v1'; id: Id; revision: Pos;
  installationId: Id; effectKey: Id; work: RefV1; attempt: RefV1;
  ownerGeneration: Pos; policy: RefV1; policyHash: Hash;
  purpose: RefV1; bot: RefV1; selection: SelectionV1;
  resources: RefV1[]; lineage: RefV1[]; budget: RefV1;
  adapter: AdapterV1; details: DetailsV1;
  vm: RefV1 | null; inputLease: RefV1 | null;
  upperBound: VectorV1; costBasis: BlobV1;
  createdAt: Time; expiresAt: Time; actionHash: Hash;
}
interface ApprovalV1 {
  contract: 's15-action-approval/v1'; id: Id; ownerGeneration: Pos;
  ingressReceipt: Hash; effectKey: Id; actionId: Id;
  actionRevision: Pos; actionHash: Hash; policy: RefV1;
  policyHash: Hash; decision: 'approve' | 'deny';
  decidedAt: Time; expiresAt: Time; hash: Hash;
}
interface ReservationV1 {
  id: Id; budget: RefV1; continuityId: Id; work: RefV1;
  actionHash: Hash | null; charged: VectorV1; actual: UsageV1;
  transport: 'not_started' | 'unsettled' | 'settled';
}
interface ClaimV1 {
  contract: 's15-action-claim/v1'; id: Id; installationId: Id; effectKey: Id;
  actionId: Id; actionRevision: Pos; actionHash: Hash;
  policy: RefV1; policyHash: Hash; matchedRules: RefV1[];
  approval: Hash | null; reservationId: Id;
  continuityGeneration: Pos; claimedAt: Time; hash: Hash;
}
type OutcomeV1 = 'not_dispatched' | 'succeeded' | 'failed' | 'unknown';
interface ObservationV1 {
  outcome: OutcomeV1;
  basis: 'local_guard' | 'remote_verified' | 'owner_statement' | 'uncertain';
  proof: BlobV1 | null; actual: UsageV1; transportSettled: boolean;
}
type DecisionV1 =
  | { state: 'allow'; matchedRules: RefV1[]; approval: Hash | null }
  | { state: 'hold' | 'deny' | 'unsupported'; code: Id };
```

`RefV1` is namespaced by its field/catalog kind; a resource ref cannot stand in for a Bot/recipient. Every referenced current record must exist, be installed/accepted and unrevoked at that exact revision/generation. Catalogs carry immutable validated content/hash plus current status and monotonic revocation high-water marks. They are read from protected services, never accepted as client `current` objects. Purpose text, resource/consent/data-access scope, enabled Bot ceiling, provider/account route and model/effort pins, exact recipient endpoint/account identity and budget period are separate catalog facts. Their full storage schemas are deferred; this contract requires owning-service resolution and blocks admission without a frozen resolver/version. Display labels/URLs are not identities. No inherited account, model availability or allowance is implied.

Additional invariants:

- All policy/work/rule sets are explicit ceilings. An action's sets must be subsets at identical refs of both policy and work and of the enabled Bot/resource restrictions, subject only to the exact owner-release exception below for a new recipient. New team access does not promote S14-private data/accounts. Missing receiver authorization refuses before relevance/context/payload construction. `selectionPin`, when present, must exactly equal actual selection. Route account/recipient permission and live availability are independent checks. An acceptance-only request cannot produce WorkAuthorityV1; an inspect authority permits reads only and denies every mutating prepared action with `outside_scope`.
- `BudgetV1.currency` and transaction/recurrence currency use uppercase `[A-Z]{3}`; fixture `USD` does not authorize that currency or an amount. Finite ceiling fields are explicit, including zero; zero permits no consumption of that dimension. Counts and spend sum without overflow. `startsAt <= now < expiresAt`; no automatic reset or period renewal.
- A rule's purposes/Bots/selections/operations/classes are nonempty. Resources/recipients may be empty only for actions needing none. `recurrence` is nonnull only for `recurring_payment`; `github` only for the two personal GitHub modes. Personal pointers must refer to an included rule of that exact mode. `deny` rules never grant power. Rules cannot widen policy/work or override another restriction.
- `DetailsV1.classes` is a nonempty **trusted adapter-derived set**, not an agent choice. Include every applicable class: a GitHub comment is publication plus communication; an upload may also disclose private data. A transaction requires `financial` and nonnull exact transaction; GitHub operations require their matching class and nonnull `github`; disclosure requires nonnull disclosure. Inconsistent or unknown semantics are unsupported, not ordinary edits. Payloads bind all final headers/recipients/content, account, attachments, transaction or patch/commit/evidence bytes under the adapter's exact schema. No credential is in a payload.
- `details.target`, transaction account and GitHub repository must be included in action resources at the same refs. Transaction payee must be an exact action recipient. Disclosure recipients must equal the actual disclosed recipient set, and every payload/attachment recipient must be accounted for in details.recipients. Current owning-service lineage checks cover all referenced payloads, evidence, target and attachments, not only cited sources. Adapter-derived fields must agree with the immutable payload; caller assertions cannot supply missing provenance.
- `targetVersion` is a nonempty, bounded (<=4096 UTF-8 bytes) adapter-validated actual etag/version/ref precondition, not a caller assurance. Git OIDs are full lowercase 40-hex at this contract version, exact refs <=1024 bytes without controls; real validation and protocol are GIT15 obligations. Unknown production impact cannot become `none`; a deployment gate must be current and externally effective, not merely a ref-shaped value.
- `impact:'major'` includes `major_change`; `impact:'unknown'` cannot auto-allow. A current owner direction decision resolves only its exact impact/purpose/target, not publication/production/new-recipient gates. Changes require reclassification. No permanent-Bot creation/change rule or Jod integration is introduced.
- `effectKey` comes from a protected work/handler invocation slot, not model IDs or an arbitrary retry request. Exactly one current unclaimed revision exists per key. Revision of an unclaimed action supersedes old approvals; any claim closes the key to all further mutation dispatch, even under a new action ID/revision. Unknown outcomes cannot be cloned into new keys to retry the same intent.
- Action expiry is after creation and no later than policy/work/budget/support expiry; approval expiry is no later than action expiry. Equality with expiry is expired. Every boundary ref and source/lineage generation is in the action hash. Null VM/lease means the adapter requires neither, never a missing fence for an operation that does require it.

## Trusted mutation ports and effect adapter

Proposed locations: `src/s15/policy-types.ts` (records/opaque types), `policy-validation.ts` (closed validators/canonical domains), `policy.ts` (matching/current guards), `policy-ports.ts` (mutation contracts), `effects.ts` (prepare/claim/settle), `effect-adapter.ts` (adapter registry), `policy-continuity.ts` (current journal integration); tests in `tests/s15-policy.test.ts`, `s15-effects.test.ts`, `s15-policy-recovery.test.ts`. **None is added or promised to exist by this PR.** Freeze final exported TSDoc/paths before implementation. No i18n keys or UI paths are delivered; UX15 owns that handoff.

```ts
// Private symbols and issuance live only in the protected composition root.
declare const ownerBrand: unique symbol, workBrand: unique symbol;
declare const txBrand: unique symbol, permitBrand: unique symbol;
interface OwnerActorV1 { readonly [ownerBrand]: true }
interface WorkActorV1 { readonly [workBrand]: true }
interface PolicyTransactionV1 { readonly [txBrand]: true }
interface DispatchPermitV1 { readonly [permitBrand]: true }
interface CommandV1<T> {
  contract: 's15-policy-command/v1'; requestId: Id;
  expectedRevision: Nat; body: T;
}
type OwnerBodyV1 =
  | { kind: 'policy.install'; proposalHash: Hash }
  | { kind: 'work.request'; request: RequestV1 }
  | { kind: 'action.decide'; actionId: Id; actionRevision: Pos;
      actionHash: Hash; decision: 'approve' | 'deny'; expiresAt: Time }
  | { kind: 'authority.revoke'; scope: 'policy' | 'work' | 'rule'; ref: RefV1 };
type ResultRefV1 =
  | { kind: 'policy' | 'work' | 'rule'; ref: RefV1 }
  | { kind: 'action'; id: Id; revision: Pos; actionHash: Hash };
interface ReceiptV1 {
  contract: 's15-policy-receipt/v1'; installationId: Id;
  requestId: Id; payloadHash: Hash; ownerGeneration: Pos;
  kind: OwnerBodyV1['kind']; committedAt: Time;
  result: { state: 'recorded' | 'held' | 'denied';
    ref: ResultRefV1 | null; code: Id | null }; hash: Hash;
}
interface PreparedInputV1 {
  requestId: Id; slotId: Id; adapter: AdapterV1; proposal: BlobV1;
}
interface PreparedResultV1 {
  action: PreparedActionV1 | null; decision: DecisionV1;
}
interface FinalDispatchV1 {
  details: DetailsV1; payloadBytes: Uint8Array;
  attachmentBytes: readonly Uint8Array[];
}
interface PolicyMutationPortV1 {
  /** Authenticates again under the writer lock; commits request continuity,
   * authority/approval/revocation and any local queue intent atomically. */
  executeOwner(actor: OwnerActorV1, command: CommandV1<OwnerBodyV1>): ReceiptV1;
  /** A registered work actor may prepare only its assigned invocation slot.
   * Resolves trusted catalogs/adapter; a proposal grants no authority. */
  prepare(actor: WorkActorV1, input: PreparedInputV1): Promise<PreparedResultV1>;
  /** Rechecks current facts, reserves finite upper bounds and claims once.
   * Returns no reusable permit or credential to the caller. */
  dispatch(actor: WorkActorV1, actionId: Id, revision: Pos,
    actionHash: Hash): Promise<ObservationV1>;
}
interface AdapterContextV1 {
  /** Called by trusted adapter code immediately at the actual I/O boundary,
   * after waits/serialization; validates final argument bytes and refs. */
  authorizeDispatch(action: PreparedActionV1,
    final: FinalDispatchV1): DispatchPermitV1;
}
interface EffectAdapterV1 {
  identity: AdapterV1;
  /** No mutation; construct validated semantics and immutable final payload.
   * Reads, if needed, require independent current scope/budget reservations. */
  prepare(tx: PolicyTransactionV1, actor: WorkActorV1,
    input: PreparedInputV1): PreparedResultV1;
  /** Trusted registry only; credentials resolved inside protected broker.
   * Permit is identity-checked and consumed at the final dispatch boundary. */
  perform(action: PreparedActionV1, context: AdapterContextV1): Promise<ObservationV1>;
  /** Read-only, separately authorized/budgeted reconciliation; never re-send. */
  reconcile(action: PreparedActionV1, claim: ClaimV1,
    actor: WorkActorV1): Promise<ObservationV1>;
}
```

`PolicyTransactionV1` is an opaque writer/read-view capability, not an SQL handle exposed to agents. Adapter preparation is synchronous within a trusted transaction over pre-acquired immutable evidence; the outer async `prepare` can acquire authorized reads first, then must revalidate all observations in that transaction. No transaction remains open across network I/O. Commands change only the records specified below; duplicate commands return their original receipt without another revision advance or decision append.

| Command / operation | Expected revision | Exact revision changes on a new accepted command |
| --- | --- | --- |
| `policy.install` | Current policy revision; 0 only for first install | Install the exact proposed policy at revision/generation 1/1 initially, otherwise current revision+1/generation+1. Changed rules use the exact separately versioned rule records bound by the proposal. Existing work/actions remain immutable and become stale against changed policy; no automatic rebinding. |
| `work.request` | Current conversation revision | Increment that conversation revision once. Create the new obligation/work identity at revision/generation 1/1; any admitted WorkAuthorityV1 is its immutable authority snapshot. Change no policy, existing work or prepared-action revision. Acceptance-only never creates execution authority. |
| `action.decide` | Prepared action revision, equal to `body.actionRevision` | Append a separate immutable ApprovalV1 and command receipt/audit/decision-journal entry. **Do not change PreparedActionV1.revision, actionHash or any policy/work ref.** The approval binds the same still-current action revision/hash. A denial vetoes that exact revision; another approval cannot erase it. No decision may modify an already claimed action. |
| `authority.revoke` | Referenced current policy/work/rule revision | Advance only the named current authority revision and generation by one and append its revocation high-water mark. Retain prior immutable records, action hashes and approval decisions as history. |
| Action `revise` (trusted preparation operation) | Current unclaimed prepared-action revision | Supersede that version and create revision+1 with a recomputed actionHash, even if payload bytes are unchanged. This is the only operation that advances an existing prepared action's revision; old approvals no longer match. Claiming, deciding and recording observations do not advance it. |

The protected decision journal orders decisions independently of action revisions. A claim pins the latest eligible exact approval hash and checks every denial for that revision; a stale/expired decision cannot become eligible through a later receipt. Receipt/journal sequence advancement is not a prepared-action revision change.

Installing a policy requires an existing exact protected owner proposal with all resolved catalog hashes and complete finite budget/consent/personal-rule choices. The mutation port cannot resolve `proposalHash` from model-authored text into an installed policy. It is not a new Bot, connection, migration, host activation or maintenance worker-release port. MIG15 must separately freeze `transition.activate`/`transition.rollback`/worker-release command and receipt signatures using this actor boundary; none is supplied by a structural `ValidationV1` or a policy receipt.

Only service code calls the adapter registry. `input.adapter` must equal the slot's pinned trusted entry and schema hash; no dynamic module/MCP discovery from input. No live adapters are supplied here; [documentation fixture adapters](fixtures/s15-standing-policy-v1.json) are no-send semantics only. Real adapters must freeze their payload schema, final wire serialization/target preconditions, support evidence, credential custody, error classification and read-back contract in GIT15/SEND15/PAY15/EDIT15/DATA15 or VM15/BROW15. Composite operations need separate prepared subactions/claims and durable partial progress; a push+PR is not permission to retry a completed push. Redirects, hidden submits, automatic retries, provider SDK behavior and deployment consequences are part of that proof.

`authorizeDispatch` is a synchronous protected check/one-use permit consumption at the irreversible I/O boundary, not an exported JSON bearer token. `FinalDispatchV1` is private in-process input: compare details exactly, raw payload/attachment sizes/hashes and sequence against the action, including actual recipients and target/version. Its bytes are the final credential-free adapter payload, never an unverified model reconstruction; credentials are injected only inside the independently scoped broker. The adapter must own all subsequent bytes and path so no untrusted mutation can intervene. A callback alone cannot prevent a remote race: conditional remote writes, protected broker serialization and an externally enforced fence must establish the linearization point. Revocation ordered before that point prevents dispatch; after it, stop blocks future dispatch/publication but cannot recall a remote action. An adapter unable to establish that ordering is **unsupported**. Do not claim a universal guarantee from the TypeScript signature. The VM/browser alternate-path proof remains separate under RF15-G01–G08.

AdapterContextV1 is privately registered to the **original live dispatch**, exact claim/action/reservation and current process fence. Its final guard can continue that claimed invocation while its mutation permit remains unconsumed; a caller supplying the same IDs or a serialized claim cannot obtain that context. After the I/O boundary consumes the permit, neither that context nor another call may dispatch again. Process loss/recovery discards the context and cannot reconstruct it for mutation, even if the durable claim says dispatch may not have started. Recovered claims remain reconcile-only.

## Matching and disposition

At prepare, decision, claim, final dispatch and result publication, resolve the **current** owner/policy/work/Bot/route/model/resource/recipient/consent/VM/input/lineage facts required by that stage. Never trust a cached model snapshot or a caller's policy match. A rule decision is protected policy evaluation, not self-approval. Use the following precedence with the stage rules below; a manual approval satisfies only eligible holds after the hard checks:

| Order | Condition | Result |
| --- | --- | --- |
| 1 | Invalid actor/command/schema, duplicate JSON keys, credentials or hash mismatch | Reject (`authentication_required`, `invalid_shape`, `invalid_data`, `credential_content_refused`, `hash_mismatch`); no mutation/remote call |
| 2 | An owner command's request key is already committed | Same payload hash returns historical receipt; different hash `request_id_conflict`. No fresh authority/queue/claim; current authentication still required to read it. Withdrawn results return a safe historical projection. This is not a final-dispatch/publication dedupe check. |
| 3 | A new mutation admission, re-preparation or decision attempts to reuse a claimed effectKey, including unknown/recovered/terminal | `deny:already_claimed`. The original registered in-flight dispatch continues only through its exact context/final guards; existing claims do not themselves deny authorized query/reconciliation or result publication. Owner statements never clear a claim. |
| 4 | Missing/unproven adapter, unknown effect semantics or unbindable final I/O | `unsupported:adapter_unproven`; no dispatch, even with approval |
| 5 | Revoked/disabled, stale ref/hash/generation, expired, stopped, withdrawn lineage, scope/pin mismatch, exact owner denial or current explicit deny rule | `deny` with `authority_revoked`, `stale_authority`, `expired`, `lineage_withdrawn`, `outside_scope`, `selection_pinned`, `action_denied` or `rule_denied` |
| 6 | New admission lacks a finite budget/cost bound/approved route availability or exceeds remaining budget/capacity | `hold:finite_budget_required`, `hold:cost_unknown`, `hold:route_unavailable`, `deny:budget_exhausted` or `hold:capacity_busy`; reserve nothing until admission can succeed. Original final dispatch verifies its existing exact reservation and owned capacity, without charging or requiring that same allowance a second time. |
| 7 | Known supported action with uncertain policy match or impact | `hold:policy_match_required` or `hold:owner_direction_required`; no permissive default |
| 8 | Applicable human-required class lacks exact decision/eligible standing exception | `hold:approval_required`, `hold:recipient_approval_required`, `hold:merge_authority_required` or `hold:production_approval_required` |
| 9 | All current ceilings, effect gates, conditions and finite reservations satisfy | `allow`, with exact matched-rule refs and/or current approval hash; not proof of dispatch or success |

After authentication/shape validation, missing or conflicting current continuity rejects with `continuity_unavailable` before receipt/admission/claim lookup; do not construct an empty ledger. Within row 5 use the deterministic order: revocation/disable/stop, stale refs/hashes/generations, expiry, lineage, explicit selection pin, other scope restrictions, exact owner denial, matching deny rule. Multiple failures cannot turn into an allow. This order makes fixture refusal codes repeatable without weakening any barrier.

Stage-specific use of the table is mandatory:

| Stage | Claim, budget and approval handling |
| --- | --- |
| Prepare / owner decision | Require an unclaimed current action; check hard scope/support. Preparation may return an eligible human hold for an exact owner decision. Recording that decision changes its separate journal only. |
| New claim / outer `dispatch` call | Reject any existing claim, including one owned by an earlier call in this process. Check all gates and remaining incremental budget/capacity before atomically reserving/claiming. |
| Original final dispatch | Require the registered original unconsumed dispatch context, exact durable claim/reservation and pinned current approval/rules. Recheck current authority/expiry/lineage/support and final bytes; verify the reservation still covers this operation and capacity is still owned. Remaining allowance may be zero because this reservation already charged it; do not reserve again. Lost context, recovery or consumed permit cannot enter this path. |
| Observation recording | Append sanitized remote/local facts under trusted claim continuity even when publication is fenced. No new mutation, claim or reauthorization of the remote action; unknown remains reconcile-only. |
| Result/artifact/owner delivery publication | Verify committed producing evidence, current publication authority, access/lineage/generations and delivery dedupe. The producing claim is expected, not a rejection. Do not demand a new effect approval, unclaimed key or replacement of already charged budget/capacity; any additional actual delivery/read work needs its own scoped authorization/reservation. Publication never reenters effect dispatch. |

The allow outcome at original final dispatch means permission to continue that single claim only. The allow outcome at publication means permission to publish the eligible result only. Neither permits a fresh mutation or makes a recovered claim dispatchable.

Multiple matching rules are conjunctive restrictions; any matching deny wins. No first-match ordering, priority-based widening or union of partial allows. At least one eligible granting rule must cover the entire action's ordinary/standing dimensions. An ordinary-mode rule may include human-required classes in its hard scope but **never** satisfies their human gates. Independent required gates can be satisfied by an exact approval; partial rule matches cannot fill missing purpose/resource ceilings or arbitrary recipient restrictions. Sort matched rule refs canonically in the claim. Denied/stale action needs new preparation/current authority; approving it cannot repair it. Approval `deny` prevents that revision's dispatch even if a standing rule could otherwise allow it.

| Class | Required authority beyond current work ceilings |
| --- | --- |
| Ordinary reversible personal/business edit | Current ordinary rule and trusted impact/evidence/preconditions; invitation, new terms or commitment adds its applicable class/gate |
| Communication to others | Exact recipients/content/attachments approval, or an explicit matching communication rule. Authenticated-owner result delivery is a distinct protected output port with lineage/current-recipient checks, not a blanket outbound exception. |
| Financial | Exact final payee/account/amount/currency approval; recurring rule must also verify frequency/cumulative use in the same claim transaction. Deviations hold. Operating spend reservation is never transaction permission. |
| GitHub publication/replies | Product default holds. Only the separately installed `githubPublicationRule` can supply a personal exception for selected-and-started work, exact repository/target/head and required evidence. It may satisfy communication for its technical GitHub actions only. |
| GitHub merge | Separate merge authority: exact merge approval or separately installed `githubMergeRule`, with current target/head, acceptance evidence, required checks/reviews and production checks. Implementation/publication approval grants no merge. |
| Production | Exact owner approval. If merge would deploy without an effective separately protected gate, hold **before merge**. Unknown consequences hold; green CI is not production authority. |
| New private-data recipient | Exact owner disclosure approval before bytes leave; a current approved recipient remains usable inside its data/purpose/account scope. A new approval creates at most an exact action-bound release, not a permanent broad recipient. Do not disguise uploads in public URL/query/DNS/browser/model paths. |
| Major/unresolved change | Exact current owner direction bound to impact/purpose/target; investigate inside existing authority. No inference from line count or a model's reversible label. Guest destructive root remains RT15-01, unresolved. |

An approval for a new recipient can satisfy the action-bound recipient gate only when protected resource-release policy permits owner release of those exact data revisions. This is a narrow exception to policy/work/rule recipient-set membership for that exact action, not a change to their stored ceilings or a broader standing recipient. Resolve this eligibility before row 5's generic recipient-scope check; without final approval it yields row 8's recipient hold. It cannot override withdrawn/nonreleasable restrictions or create a new account/provider/billing route. All other recipient/scope mismatches are hard denials. Exact approvals bind the full multi-class action; no separate confirmation is needed for each field of the same prepared action.

## Atomicity, claims, budgets and recovery

The following records are logical schemas, not a complete target database or SQL migration. Protected mutation ports must provide the named uniqueness/order across the current continuity authority and application projection. An attached database transaction alone is not a claimed cross-store/power-loss proof; durable-journal/fence implementation must prove the required recovery ordering.

| Record / unique key | Commit ordering and contents |
| --- | --- |
| Request continuity `(installationId, ownerId, requestId)` | Authenticate under lock, validate command, compare `H(s15.command.v1, command)`, commit receipt/audit plus authority/approval/revocation and local queue intent before acknowledgement. Scope is installation-wide, never session-local. Preserve historical IDs/hashes after payload withdrawal. |
| Policy/rule revisions `(kind,id,revision,generation)` | Immutable content/hash; current pointer and revocation high-water marks advance monotonically on every mutation. Same ID never reuses an old revision/generation. Restoring a snapshot cannot move the pointer backwards. |
| Work intent `(installationId, ingressReceipt)` | At most one local execution intent per authenticated request; acceptance-only creates no queue. Service derivation/delegation narrows the existing purpose and shares its budget continuity. No model-selected unrelated issue or new permanent Bot. |
| Preparation `(workId, slotId, requestId)` | Same proposal/hash dedupes to original preparation; different payload conflicts. Slot identity/current revision and exact action hash persist. Evidence reads can charge their own budget; preparing never implies external mutation. |
| Action claim `(installationId, effectKey)` | Claim, exact authorization/rule refs, reservation/frequency counters and dispatch uncertainty become durable before any external mutation. Single winner across processes; never acknowledge a claim without current continuity. No mutation if any component cannot commit. |
| Reservation `(continuityId,reservationId)` | All relevant work/installation/route/rule ceilings and capacity checked under one serialization boundary. Reuse a reservation only for its exact attempt/subaction; no double charging at guard callbacks. Reconciliation reads/new inference calls need their own charges. |
| Observation `(claimId, observationSequence)` | Append sanitized evidence with basis and actual/unknown usage. Verify current fences again before publishing result/artifact/owner delivery. Remote outcome evidence remains retained under protected lifecycle scope even when public/work publication is fenced. |

Before admission, reserve a conservative enforceable finite upper bound for **every** vector dimension, using exact currency and a frozen cost basis. Missing/unknown pricing without such a bound holds; `null` actual usage is not a zero charge. This proposal conservatively never refunds charged upper bounds, even when measured usage is smaller or a pre-dispatch guard prevents I/O. Actual measured/partial/unknown values remain separate. This costs capacity but avoids making refund correctness an implicit dependency. A future release/refund policy requires a revised reviewed contract and implementation proof.

Continuity stores cumulative charged vectors, claims, frequency use and revocations outside ordinary images/guest snapshots. Restore/rollback reconciles componentwise maxima plus append-only reservation identities; missing/conflicting identity/prefix blocks all admission. New policy/work IDs, reauthentication or a new period cannot erase old charges or confer a fresh allowance. A separately owner-approved new finite allocation is explicit and retains prior consumption. Concurrent open capacity is released only after actual transport settlement, independently of the nonrefundable charged vector. Timeout, abort, model completion, disconnect and a returned permit do not prove settlement. Retain unknown actual fields and unsettled capacity on crash.

Dispatch sequence:

1. Reconcile current continuity; validate immutable payload hashes/target preconditions and current work/adapter support. Reserve/claim durably with all generation, approval, rule/frequency and cost facts. Set dispatch uncertainty before external I/O; a crash after claim is reconcile-only even if no remote call actually happened.
2. Immediately before actual dispatch, reconstruct final bytes only from pinned immutable payloads, verify them against actionHash and resolve current authority again through `authorizeDispatch`. After any wait, repeat the final check. No automatic SDK/transport retries of mutation. A known local guard refusal records `not_dispatched` but retains the consumed claim and conservative charge.
3. Execute one conditional/broker-serialized mutation under the adapter's proven dispatch fence. Missing response, cancellation after dispatch, ambiguous read-back, protocol exception or invalid outcome becomes `unknown`, never `failed` or successful by inference. `failed` requires conclusive rejection/no successful effect, preserving any known partial result under distinct subactions.
4. Append observation and actual usage; separately recheck publication/source/access/current generations. A revocation after dispatch does not erase a real remote fact or publish stale output. Reconciliation is read-only, authorized separately at current scope/budget (including narrowly permitted owner inspection after original work expiry); it cannot resubmit an unknown effect. Owner statements retain `basis:'owner_statement'`, never remote verification and never retry authority.

Adoption and rollback retain [ADR 0065](../adr/0065-s15-state-preservation-and-policy-adoption.md)'s single current continuity ledger, request identity, usage/withdrawals/policy revocations, claims and source privacy. Imported S14 grants/approvals/routines/queues do not dispatch. No raw session/profile transfer or private-to-team promotion. Preserve original histories/bytes; pending unclaimed approvals expire, claimed/unknown effects remain reconcile-only. A prior executable unable to enforce current facts stays fenced; unsupported reverse projection refuses. Policy adoption is separate from host selection and worker release; no command here activates S15 or rewrites a native session.

## Documentation fixtures and implementation proof

[Complete synthetic fixture inputs and expected outcomes](fixtures/s15-standing-policy-v1.json) use a complete base world, full proposed records, exact payload/hash bytes and specified ordered scenario operations. The [fixture interpretation](fixtures/s15-standing-policy-v1.md) defines deterministic copy/replace/setup semantics; this is documentation data, not an installed schema, runtime fixture builder or executed test. No pass count is claimed. Synthetic identities/limits prove no live account, provider or budget readiness.

The eventual tests must cover every scenario plus two-process reservation/claim races, fake-clock expiry at each guard, rollback at every local commit boundary, current-ledger replay/conflict, every changed final field/attachment/order, multi-class gates and payload substitutions between validation and I/O. Use scripted models, fake clocks and protocol barriers; real VM/browser bypass resistance is separate. Documentation-only validation here checks links, schema/type/fixture/hash consistency, unchanged requirement IDs and `git diff --check`; runtime tests/typecheck/live calls are not run.

Existing inspected S14 seams and limits:

| Source / tests | Reusable contract idea; unchanged limitation |
| --- | --- |
| [application.ts](../../src/s14/application.ts), [authority-types.ts](../../src/s14/authority-types.ts), [authority tests](../../tests/s14-authority.test.ts) | Private actor registry, writer-locked auth, command hash/receipt/queue atomicity; forged actors refuse. `message.post` remains tool-free chat; `task.accept` creates an obligation; explicit `work.start` grants/queues. No standing policy from chat is implemented. |
| [authority.ts](../../src/s14/authority.ts), [validation.ts](../../src/s14/validation.ts) | Exact bounded shapes, immutable snapshots, current tool/resource/Bot guards, finite reservations, final action rehash, effect_claim before performer and late publication fences. Current `EffectAction {kind,destination,content}` is not a complete S15 multi-class/standing-rule schema. |
| [policy.ts](../../src/s14/policy.ts), [personal effects tests](../../tests/s14-personal-effects.test.ts), [Git tests](../../tests/s14-coding-git.test.ts) | S14 configured ceilings are not S15 grants; typed drafts bind recipient/body/event etag and Git verifies actual objects/head/diff before broker dispatch. No immediate-edit/personal-auto-merge rule is silently inherited. |
| [recovery.ts](../../src/s14/recovery.ts), [recovery tests](../../tests/s14-recovery.test.ts), [ops tests](../../tests/s14-ops.test.ts) | Independent effect claims, reservation maxima, owner statement versus read-back, unresolved native capacity and stale-image refusal. No S15 continuity/old-build fence or real external enforcement is proven by reading these tests. None was rerun for this PR. |

## Freeze and proof obligations (not ready)

| Gate | Required before the corresponding implementation/activation claim |
| --- | --- |
| PC15-FZ01 — prerequisite reconciliation | Merge-reviewed #318 contract/ADR exact blobs must be in the integration base; compare this proposal with any changed placement/support/continuity decisions. Verify #319 blobs and source drift. No audit closure substitutes. |
| PC15-FZ02 — policy-only implementation admission | Review/freeze this schema, actor issuance/current-catalog resolver and trusted mutation/adapter signatures, journal uniqueness/failure ordering, finite policy configuration and complete deterministic fixture builder. This PR supplies a proposal, not that final freeze or #320 implementation readiness. |
| PC15-FZ03 — adapters and real boundaries | Respective VM/browser/effect/model/disclosure slices freeze actual payload/target/transport and prove final dispatch serialization/conditional writes and all alternate routes. RF15-G01–G06 / RT15-01 remain unproven; no universal browser/admin gate is claimed. |
| PC15-FZ04 — storage/adoption/rollback | TEAM15/MEM15/MIG15 freeze full target schema/materializers, protected current-ledger/request custody, maintenance ports and prior-build boot fence/reverse compatibility; keep RF15-G07 unproven until implementation evidence. |
| PC15-FZ05 — release/owner adoption | Exact build/artifact/policy/host/account evidence and explicit adoption under EVID15/CUT15; RF15-G08 remains unproven. S14 default and opt-in personal GitHub distinction persist. |

Required Claude-authored UX remains blocked separately in #337; no retry, alternate UX author or completed handoff is implied. This bounded preparation leaves #320 open, all its implementation acceptance checkboxes unchecked and dependency edges intact. Its PR uses **Refs #320**, never a closing keyword.
