/** Immutable owning-service identity. Revisions and generations must both match current protected state. */
export interface Ref { id: string; revision: number; generation: number }
/** An approved provider identity/model/effort; changing any field requires a fresh policy match. */
export interface Selection { route: Ref; model: Ref; effort: string }
/** Explicit finite upper bounds, charged before I/O without automatic refunds. Spend is operating cost only. */
export interface BudgetVector { attempts: number; steps: number; calls: number; reads: number; outputBytes: number; activeMs: number; spendMinor: string }
/** Measured usage is separate from charged bounds. Null means unknown, including after a crash. */
export type Usage = { [K in keyof BudgetVector]: BudgetVector[K] | null };
/** No numeric allowance, currency or renewal is inferred from an omitted budget. */
export interface OperatingBudget { currency: string; startsAt: number; expiresAt: number; ceiling: BudgetVector; concurrency: number }
/** Trusted adapters derive every applicable class, including overlapping human gates. */
export type ActionClass = 'ordinary_edit' | 'guest_local_admin' | 'guest_system_admin' | 'new_egress' | 'communication' | 'financial' | 'github_publish' | 'github_merge' | 'production' | 'disclosure' | 'major_change';
/** A separately owner-approved finite recurring obligation. Frequency is minimum elapsed milliseconds between claims. */
export interface RecurringPaymentRule { payee: Ref; account: Ref; currency: string; minorUnit: number; amountCeilingMinor: string; minIntervalMs: number; maxPayments: number; totalCeilingMinor: string; startsAt: number }
/** Entire-action scope; rules never union partial permissions. Ordinary rules cannot satisfy human gates. */
export interface Rule { id: string; mode: 'ordinary' | 'communication' | 'personal_github_publish' | 'personal_github_merge' | 'recurring_payment' | 'deny'; purposes: Ref[]; bots: Ref[]; resources: Ref[]; recipients: Ref[]; selections: Selection[]; adapters: string[]; operations: string[]; classes: ActionClass[]; expiresAt: number; recurrence: RecurringPaymentRule | null; github?: { repository: Ref; target: string } | null }
/** Owner-installed ceilings. Personal GitHub rules and recurring payments are absent unless explicitly approved. */
export interface StandingPolicy { contract: 's15-standing-policy/v1'; revision: number; ownerGeneration: number; purposes: Ref[]; bots: Ref[]; resources: Ref[]; recipients: Ref[]; selections: Selection[]; budget: OperatingBudget | null; rules: Rule[]; expiresAt: number; interpretationPurpose?: Ref | null }
/** Protected owner configuration, never a model-provided current-policy object. Recurring rules use their separate approval command. */
export type PolicyInput = Omit<StandingPolicy, 'contract' | 'revision' | 'ownerGeneration'>;
/** Actual authenticated ingress interpretation. Acceptance retains an obligation but creates no execution authority. */
export interface WorkRequest { requestId: string; intent: 'inspect' | 'execute' | 'accept_obligation'; access?: 'read' | 'reversible_write' | 'effect'; purpose: Ref; bot: Ref; resources: Ref[]; recipients: Ref[]; selection: Selection; selectionPin: Selection | null; expiresAt: number; readLimit?: number; fences?: Fence[]; subject?: { resource: Ref; issue: number } | null }
/** Durable narrowed authority; a transport logout does not revoke this independently bounded work. */
export interface WorkAuthority { id: string; mode: 'interpretation' | 'work'; readLimit: number; ownerGeneration: number; policyRevision: number; policyHash: string; request: WorkRequest; createdAt: number; expiresAt: number }
/** Deduplicated authenticated ingress result. No actor or capability is serialized in a receipt. */
export interface WorkReceipt { work: WorkAuthority | null; receiptId: string }
declare const ownerBrand: unique symbol, workBrand: unique symbol;
/** Private registry identity, not a JSON bearer token. Reauthenticated under every owner writer lock. */
export interface OwnerActor { readonly [ownerBrand]: true }
/** Private registry identity for one durable work authority, issued only by protected composition. */
export interface WorkActor { readonly [workBrand]: true }
/** Exact current generation resolved outside the working VM; absence or inactive state fails closed. */
export type CatalogKind = 'purpose' | 'bot' | 'resource' | 'recipient' | 'route' | 'model' | 'lineage' | 'vm' | 'input';
/** Protected owning-service resolver. allows must enforce current Bot/resource/consent/privacy ceilings, including eligibility for an exact owner release to any new disclosure/egress recipient; no model input is authoritative. */
export interface CatalogPort { current(kind: CatalogKind, id: string): { ref: Ref; active: boolean } | null; allows(work: WorkAuthority, action: ActionDraft | null): boolean }
/** Explicit generation fence for source lineage, VM or browser input, rechecked at final dispatch/publication. */
export interface Fence { kind: CatalogKind; ref: Ref }
/** Credential-free exact structured payload. Strings are preserved without trimming or normalization. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
/** Exact final financial fields; monetary amounts use canonical integer minor units, never binary floats. */
export interface Transaction { payee: Ref; account: Ref; currency: string; minorUnit: number; amountMinor: string; quoteId: string; quoteVersion: string; quoteExpiresAt: number }
/** Trusted GitHub evidence must describe the exact selected issue/head and actual protected production consequences. */
export interface GithubConditions { repository: Ref; issue: number; target: string; head: string; evidenceHash: string; checksPassed: boolean; reviewsPassed: boolean; acceptancePassed: boolean; production: 'none' | 'protected_gate' | 'would_deploy' | 'unknown'; deploymentFence: Fence | null }
/** Adapter-produced immutable final semantics. A null cost is held, never interpreted as free. */
export interface ActionDraft { operation: string; classes: ActionClass[]; resources: Ref[]; recipients: Ref[]; payload: JsonValue; fences: Fence[]; upperBound: BudgetVector | null; expiresAt: number; transaction: Transaction | null; github: GithubConditions | null; impact: 'reversible' | 'major' | 'unknown'; snapshot?: Fence | null }
/** Immutable prepared revision. Approval and observations do not mutate this record or its hashes. */
export interface PreparedAction extends ActionDraft { id: string; revision: number; effectKey: string; adapter: string; adapterVersion: number; workId: string; ownerGeneration: number; policyRevision: number; policyHash: string; createdAt: number; contentHash: string; recipientHash: string; transactionHash: string | null; actionHash: string }
/** Exact immutable revision reference required by decisions, dispatch and publication. */
export interface ActionRef { id: string; revision: number; actionHash: string }
/** Stable fail-closed policy disposition; allow is a current evaluation, never an exported dispatch permit. */
export type Decision = { state: 'allow'; rules: string[]; approval: string | null } | { state: 'hold' | 'deny' | 'unsupported'; code: string };
/** One protected preparation slot per logical effect. Only trusted handlers choose slot IDs, never a model retry identifier. */
export interface PrepareInput { slot: string; adapter: string; proposal: unknown }
/** Exact held action and current disposition. Preparation performs no external mutation or budget charge. */
export interface PreparedResult { action: PreparedAction; decision: Decision }
/** Exact owner decision. Denial vetoes this revision even if a standing rule otherwise matches. */
export interface ApprovalInput { requestId: string; action: ActionRef; decision: 'approve' | 'deny'; expiresAt: number }
/** Independently deduplicated model reservation; the selected call must remain inside the current work policy/pin. */
export interface ModelCallInput { requestId: string; selection: Selection; upperBound: BudgetVector }
/** Durable charge and transport capacity, not a dispatch token. guardReservation consumes model send permission once for its original live actor; recovery/rebinding cannot adopt it. Unknown usage/capacity remains charged. */
export interface Reservation { id: string; workId: string; requestId: string; upperBound: BudgetVector; actual: Usage; transportSettled: boolean; createdAt: number; selection?: Selection }
/** Safe observation, never provider errors or credentials. Unknown is permanently reconcile-only. */
export interface Observation { outcome: 'not_dispatched' | 'succeeded' | 'failed' | 'unknown'; basis: 'local_guard' | 'remote_verified' | 'uncertain' | 'owner_statement'; code: string | null; actual: Usage; transportSettled: boolean }
/** Trusted adapter result: failed requires conclusive remote rejection; exceptions/malformed replies become unknown. */
export interface AdapterResult { outcome: 'succeeded' | 'failed' | 'unknown'; actual: Usage; transportSettled: boolean }
/** One live invocation, retained only by the protected adapter. send is called synchronously under the final writer fence after a durable claim. No retries/redirects are allowed. */
export interface DispatchContext { commit(finalPayload: JsonValue, send: () => Promise<AdapterResult>): Promise<AdapterResult> }
/** Registered protected code only. prepare is synchronous/no I/O; perform owns final bytes, conditional preconditions and single-send behavior. Real adapters require their own boundary proof. */
export interface ActionAdapter {
  id: string; version: number;
  prepare(proposal: unknown, context: { work: WorkAuthority; now: number }): ActionDraft;
  perform(action: PreparedAction, context: DispatchContext): Promise<AdapterResult>;
  /** Read-only: fulfillment certifies that this read's transport ended; the returned result describes the original effect, whose outcome/transport may remain unknown. A rejection supplies no read-transport settlement proof. The service charges one call/read in its single durable recovery lane, separate from ordinary concurrency. */
  reconcile?(action: PreparedAction): Promise<AdapterResult>;
}
/** Protected authenticated principal; verifyOwner must check current live session/CSRF/channel binding itself. */
export interface AuthenticatedOwner { id: string; generation: number; expiresAt: number }
/** Explicit opt-in construction only. The path is the current protected ledger, never a VM disk or ordinary backup projection. create is allowed only for a new installation, never recovery. */
export interface PolicyOptions { runtime: 's15'; path: string; create: boolean; installationId: string; ownerGeneration: () => number; verifyOwner: (proof: unknown) => AuthenticatedOwner | null; catalogs: CatalogPort; adapters: readonly ActionAdapter[]; reads?: readonly ReadHandler[]; now?: () => number }


/** Closed operations with no domain write, system administration or outbound-destination authority. workspace_setup is trusted isolated workspace/unit initialization only. */
export type ReadOperation = 'read' | 'grep' | 'find' | 'ls' | 'workspace_setup';
/** Protected handler registration, never a model read-only hint. validate must bind a supported exact resource/path/query without I/O or effects. The VM/broker owns actual implementation and bypass proof. */
export interface ReadHandler { operation: ReadOperation; validate(payload: JsonValue, context: { work: WorkAuthority; resource: Ref }): void }
/** One handler-owned read invocation. Existing approved resources only; fences bind source/VM/input generations and exactPayload contains all final read arguments. */
export interface ReadInput { requestId: string; resource: Ref; operation: ReadOperation; exactPayload: JsonValue; upperBound: BudgetVector; fences: Fence[] }
/** Durable single-use read claim. guardRead consumes dispatch once; reopen cannot recreate a consumed invocation. Read data remains in the protected owning service, bound by resultHash at settlement. */
export interface ReadClaim { id: string; workId: string; input: ReadInput; payloadHash: string; policyHash: string; ownerGeneration: number; reservationId: string; expiresAt: number; createdAt: number; claimHash: string }
/** Current read admission, not a model-visible permit. Neither a denial nor a duplicate charges again. */
export type ReadDecision = { state: 'allow'; claim: ReadClaim } | { state: 'hold' | 'deny'; code: string };

/** One pre-retrieval model call, with no resources, recipients, tools or effect authority. */
export interface InterpretationInput { requestId: string; selection: Selection; expiresAt: number }
/** Owner-only exact read model; payloadBytesBase64 encodes the complete canonical UTF-8 payload without truncation. */
export interface ActionSlip { contract: 's15-action-slip/v1'; action: PreparedAction; payloadBytesBase64: string; state: 'pending' | 'approved' | 'executing' | 'succeeded' | 'failed' | 'unknown' | 'changed' | 'expired' | 'denied' | 'unsupported' | 'stale_rules'; expiresAt: number; reasonCode: string | null; canApprove: boolean; replacement: ActionRef | null; observation: Observation | null; recurring: { rule: Rule; deviations: string[] }[]; statements: { outcome: 'occurred' | 'did_not_occur' }[] }
/** Protected first-run rule summary. An incomplete proposal contains null fields and cannot install; it invents no budget/profile. */
export interface PolicyProposal { contract: 's15-policy-proposal/v1'; ownerGeneration: number; expectedRevision: number; policy: PolicyInput | null; rows: { id: string; text: string; mode: 'ordinary' | 'approval_required' | 'off' }[]; fields: { path: string; value: JsonValue; status: 'owner_required' | 'profile_required' | 'provided' }[]; installable: boolean; proposalHash: string }
/** Typed conversational decision only. The host supplies the complete conversation's work IDs and the exact last-presented revision; quotes/model text must never call this API. */
export interface PendingDecisionInput { requestId: string; workIds: string[]; seen: ActionRef; decision: 'approve' | 'deny'; expiresAt: number }

/** Worker consumer port. Models receive scoped tool closures, never this service's owner/control ports. guardReservation consumes model dispatch once at the final I/O boundary; it is not a reusable preflight check. */
export interface WorkPort { reserveRead(actor: WorkActor, input: ReadInput): ReadDecision; guardRead(actor: WorkActor, claimId: string): ReadClaim; guard(actor: WorkActor): WorkAuthority; reserveModelCall(actor: WorkActor, input: ModelCallInput): Reservation; guardReservation(actor: WorkActor, reservationId: string): Reservation; prepare(actor: WorkActor, input: PrepareInput): PreparedResult; evaluate(actor: WorkActor, action: ActionRef): Decision; guardBeforeDispatch(actor: WorkActor, action: ActionRef): PreparedAction; dispatch(actor: WorkActor, action: ActionRef): Promise<Observation> }
/** Protected owner API, suitable for authenticated HTTP/channel wrappers; no natural-language approval parsing is supplied. */
export interface OwnerPort { authenticate(proof: unknown): OwnerActor; current(actor: OwnerActor): StandingPolicy | null; prepareInterpretation(actor: OwnerActor, input: InterpretationInput): { authority: WorkAuthority; purposes: Ref[] }; proposePolicy(actor: OwnerActor, input: PolicyInput | null): PolicyProposal; installProposal(actor: OwnerActor, requestId: string, proposalHash: string): StandingPolicy; actionSlip(actor: OwnerActor, action: ActionRef): ActionSlip; decidePending(actor: OwnerActor, input: PendingDecisionInput): void; install(actor: OwnerActor, requestId: string, expectedRevision: number, input: PolicyInput): StandingPolicy; admit(actor: OwnerActor, request: WorkRequest): WorkReceipt; decide(actor: OwnerActor, input: ApprovalInput): void; approveRecurringRule(actor: OwnerActor, requestId: string, expectedRevision: number, rule: Rule): StandingPolicy; revoke(actor: OwnerActor, requestId: string, scope: { kind: 'policy' } | { kind: 'work'; id: string }): void; inspect(actor: OwnerActor, action: ActionRef): { action: PreparedAction; observation: Observation | null }; reconcile(actor: OwnerActor, action: ActionRef, requestId: string): Promise<Observation>; recordStatement(actor: OwnerActor, action: ActionRef, requestId: string, outcome: 'occurred' | 'did_not_occur'): void }
/** Host-only control integration. Recording usage never grants publication or dispatch authority. */
export interface ControlPort { settleRead(claimId: string, observation: Observation, resultHash: string | null): void; publishRead(actor: WorkActor, claimId: string): { observation: Observation; resultHash: string | null }; bindWork(workId: string): WorkActor; settleReservation(id: string, usage: Usage, transportSettled: boolean): void; publishable(actor: WorkActor, action: ActionRef): Observation; usage(): { charged: BudgetVector; unsettled: number }; close(): void }
/** Explicit opt-in protected policy service. It does not select a runtime, migrate S14 or expose an unauthenticated network server. */
export interface S15PolicyService { owner: OwnerPort; work: WorkPort; control: ControlPort }
