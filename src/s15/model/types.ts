import type { HostAttemptEffort, HostAuthFetch, HostAuthStatusCode, HostClock, HostCredentialLifecycle, HostCredentialStore, HostProviderRequests, HostRouteRenewal, Model, ModelUsage, ThinkingLevel, ToolDefinition } from 'schway/host';
import type { BudgetVector, Ref, Selection, S15PolicyService, Usage, WorkActor } from '../policy';

/** Protected approved route binding. Account/billing/recipient identities are exact refs, never labels
 * from model metadata. Upper bounds and ordering are configured, not owner budget defaults. */
export interface ApprovedModelRoute {
  selection: Selection; provider: 'codex' | 'grok'; modelId: string;
  account: Ref; billing: Ref; recipient: Ref; charge: 'subscription' | 'metered';
  availability: 'available' | 'unavailable' | 'quota';
  efforts: ThinkingLevel[]; effortEvidence: 'requested_only' | 'adapter_mapped';
  upperBound: BudgetVector | null; rank: { ordinary: number; difficult: number };
  /** Output-token cap that a metered route's per-send `upperBound` was priced for. Jit sends it exactly and
   * requires Schway to enforce it, never above the listed route maximum (a larger value narrows to it); absent
   * uses the listed route default. It bounds output tokens, never money. Subscription routes send no Jit cap. */
  maxOutputTokens?: number;
}
/** Owner pins resolved from current protected owner decisions; omitted fields do not widen policy. */
export interface ModelPins { route: Ref | null; model: Ref | null; effort: ThinkingLevel | null }
/** Protected registry only. A catalog, URL, source document or model cannot register its own account. */
export interface ApprovedModelRegistry { list(): readonly ApprovedModelRoute[]; current(selection: Selection): ApprovedModelRoute | null; pins(workId: string): ModelPins }
/** Configured finite native loop bounds, independent of any monetary operating allowance. */
export interface ModelRunLimits { turns: number; attempts: number; activeMs: number; outputBytes: number; contextWindow: number; inputChars: number }
/** Each step preserves original decisions and source labels in strict context. Tools are trusted scoped
 * closures whose owning services guard actual effects; selection confers no tool/effect permission. */
export interface ModelStepInput { stepId: string; difficulty: 'ordinary' | 'difficult'; text: string; ownerDecisions: string[]; sources: { ref: Ref; label: string; text: string }[]; tools?: readonly ToolDefinition[]; /** Host-assembled labelled memory data, guarded by the owning memory service. */ memorySection?: string }
/** One physical provider send that Schway presented to Jit's synchronous `authorizeDispatch`. An authorized
 * send holds its own nonrefundable POLICY reservation; a refused one carries `refusal` (Jit's code), never left
 * the process and holds no reservation unless it was refused after reserving. Credential-free: the body hash
 * and length prove which bytes were presented, not that the provider received or billed them. */
export interface ModelDispatchRecord {
  reservationId: string | null; kind: 'initial' | 'auth-retry'; sequence: number; bodySha256: string; bodyBytes: number;
  /** Requested level after the pin and the exact `reasoning.effort` wire value the body carries. */
  effort: { requested: ThinkingLevel | null; sent: string | null };
  /** Exact `max_output_tokens` the body carries; null when it carries none (Codex). */
  outputCap: { sent: number | null };
  /** Time Jit decided (authorized or refused) this send. */
  authorizedAt: number;
  /** Jit refusal code when the send was refused; absent when authorized. */
  refusal?: string;
}
/** Exact Schway route-model controls pinned for one step from a choice listed in the same process for the
 * same credential owner. Schway refuses before I/O any send whose body cannot carry them. */
export interface ModelRouteControls {
  /** Exact effort pin (`mode: 'exact'`) and the wire value every body must carry. */
  effort: { level: ThinkingLevel; sent: string; evidence: 'account-catalog' };
  /** Provider-enforced output-token cap pinned and required on every send, or null when none is pinned
   * (Codex subscription endpoints accept no cap). A token cap is never a monetary bound. */
  maxOutputTokens: number | null;
  /** `configured_upper_bound`: a metered send is charged at the protected configured POLICY upper bound,
   * whose output assumption the enforced cap pins; provider pricing is not verified by Jit or Schway.
   * `cost_bound_unknown`: subscription spend is unknown; no cap or token count bounds it. */
  cost: 'configured_upper_bound' | 'cost_bound_unknown';
}
/** Durable disclosure and actual observations. Requested/mapped effort is never proof of computation. */
export interface ModelSelectionRecord {
  contract: 's15-model-selection/v1'; id: string; workId: string; stepId: string; inputHash: string;
  route: ApprovedModelRoute; pins: ModelPins; reason: 'owner_pin' | 'ordinary' | 'difficult' | 'approved_alternative';
  state: 'selected' | 'running' | 'completed' | 'held' | 'failed' | 'reconcile_only'; code: string | null;
  createdAt: number; reservations: string[]; usage: Usage; tokens: ModelUsage | null;
  tokenSamples: { reservationId: string; usage: ModelUsage | null }[];
  /** `attempts` holds Schway's per-attempt requested/sent/reported effort (null when an attempt sent nothing
   * observable); `reported` is provider metadata, never proof of internal computation. Absent before MODEL15-02. */
  effort: { requested: string; evidence: ApprovedModelRoute['effortEvidence']; providerConfirmed: false; attempts?: (HostAttemptEffort | null)[] };
  /** Every physical send of a route model presented to the authorizer, including adapter auth-retry resends and
   * refused sends (marked `refusal`), in decision order. null: a scripted host-supplied model whose sends Schway
   * cannot observe or authorize. */
  physicalDispatches: ModelDispatchRecord[] | null;
  /** Exact provider requests this step started: the run's Schway counts plus any pre-listing renewal; null when the
   * run was unobservable (scripted model or a
   * refused call). When exact, initial plus auth-retry sends equal the sends Jit admitted and reserved, otherwise
   * the output is withheld (`usage_invalid`). Absent before MODEL15-02. */
  providerRequests?: HostProviderRequests | null;
  /** The renewal that preceded an uncached catalog listing (`renewalRequests` is also counted in `providerRequests`);
   * null when the step used cached choices or a scripted model. Absent before MODEL15-03. */
  catalogRenewal?: { outcome: HostRouteRenewal['outcome']; renewalRequests: 0 | 1; status: HostAuthStatusCode } | null;
  /** Pinned route controls; null for a scripted model. Absent before MODEL15-02. */
  controls?: ModelRouteControls | null;
  output: string | null; session: { id: string; branchId: string } | null;
}
/** Protected credential owner for a route's catalog listing and route model. Both must use the same owner,
 * because Schway binds a listed choice to the owner that listed it. Production omits it (OS secure store);
 * `fetch` is the deterministic protocol-fixture seam. No credential value passes through Jit. */
export interface ModelRouteAuth { store?: HostCredentialStore; lifecycle?: HostCredentialLifecycle; fetch?: HostAuthFetch }
/** Explicit opt-in composition, outside working VM/native snapshots. Scripted injection is a no-network
 * deterministic test seam that Schway cannot authorize per send; production obtains the exact model through
 * host.auth.createModel({ authorizeDispatch, catalogModel, effort, ... }). */
export interface ModelOptions {
  runtime: 's15'; path: string; create: boolean; installationId: string; nativeDirectory: string;
  policy: S15PolicyService; registry: ApprovedModelRegistry; limits: ModelRunLimits; clock?: HostClock;
  scripted?: (route: ApprovedModelRoute) => Model;
  /** Credential owner and protocol-fixture seam for route models; ignored with `scripted`. */
  routeAuth?: ModelRouteAuth;
  /** Optional responsibility guard, invoked before streams/tools/publication after every wait. */
  guardWork?: (workId: string) => void;
  /** Protected DATA15 recipient/source filter; mandatory in private-lineage host composition. */
  disclosure?: import('../disclosure').ModelDisclosurePort;
}
/** Read-only F10/12.3 projection; absent monetary ceiling/unknown measurements are explicit nulls. */
export interface ModelBudgetView {
  contract: 's15-model-budget/v1'; currency: string | null;
  subscriptionLimits: { concurrency: number; perWork: { calls: number; steps: number; activeMs: number } } | null;
  ceilings: { dimension: keyof BudgetVector; ceiling: number | string | null; charged: number | string | null; measured: number | string | null; unknown: boolean }[];
  routes: { selection: Selection; provider: string; model: string; account: Ref; billing: Ref; charge: ApprovedModelRoute['charge']; availability: ApprovedModelRoute['availability']; holdCode: string | null }[];
  pins: { workId: string; pins: ModelPins }[];
  selections: Omit<ModelSelectionRecord, 'output'>[];
  unsettled: number;
}
/** Trusted caller hooks for one step. They can only refuse a call, never widen MODEL/POLICY limits.
 * `beforeCall` runs synchronously once per physical send (route models: inside Schway's dispatch authorizer,
 * auth-retry resends included), immediately before that send's POLICY reservation. */
export interface ModelStepHooks { beforeCall(): void }
/** Host-only step execution; Schway owns the loop/retries/compaction and Jit never refreshes credentials. */
export interface ModelService {
  /** `hooks.beforeCall` is the caller's own durable per-model-call ceiling (for example CHAT's
   * `limits.modelCalls`), run before every physical send's POLICY reservation; the stricter limit always applies. */
  runStep(actor: WorkActor, input: ModelStepInput, signal?: AbortSignal, hooks?: ModelStepHooks): Promise<ModelSelectionRecord>;
  /** Read-only reconciliation from already recorded POLICY transport facts. It never recreates a native
   * invocation or result. Unknown effect outcomes remain the responsibility/owning adapter's concern. */
  reconcile(owner: import('../policy').OwnerActor, recordId: string): ModelSelectionRecord;
  publish(actor: WorkActor, stepId: string, consume: (text: string) => void): void;
  project(owner: import('../policy').OwnerActor, workId?: string): ModelBudgetView;
  /** Drop cached catalog evidence for one route (or all) after an observed sign-in, logout or account change;
   * the next step renews and lists afresh. No credential is read or written. */
  forgetRouteCatalog(route?: ApprovedModelRoute['provider']): void;
  /** Refuses synchronously while a step runs; otherwise closes the journal and resolves once a service-owned
   * credential lifecycle has closed (retrying `busy` while an abandoned renewal stores its token, bounded). */
  close(): Promise<void>;
}
