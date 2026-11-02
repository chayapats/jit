import type { HostClock, Model, ModelUsage, ThinkingLevel, ToolDefinition } from 'schway/host';
import type { BudgetVector, Ref, Selection, S15PolicyService, Usage, WorkActor } from '../policy';

/** Protected approved route binding. Account/billing/recipient identities are exact refs, never labels
 * from model metadata. Upper bounds and ordering are configured, not owner budget defaults. */
export interface ApprovedModelRoute {
  selection: Selection; provider: 'codex' | 'grok'; modelId: string;
  account: Ref; billing: Ref; recipient: Ref; charge: 'subscription' | 'metered';
  availability: 'available' | 'unavailable' | 'quota';
  efforts: ThinkingLevel[]; effortEvidence: 'requested_only' | 'adapter_mapped';
  upperBound: BudgetVector | null; rank: { ordinary: number; difficult: number };
}
/** Owner pins resolved from current protected owner decisions; omitted fields do not widen policy. */
export interface ModelPins { route: Ref | null; model: Ref | null; effort: ThinkingLevel | null }
/** Protected registry only. A catalog, URL, source document or model cannot register its own account. */
export interface ApprovedModelRegistry { list(): readonly ApprovedModelRoute[]; current(selection: Selection): ApprovedModelRoute | null; pins(workId: string): ModelPins }
/** Configured finite native loop bounds, independent of any monetary operating allowance. */
export interface ModelRunLimits { turns: number; attempts: number; activeMs: number; outputBytes: number; contextWindow: number; inputChars: number }
/** Each step preserves original decisions and source labels in strict context. Tools are trusted scoped
 * closures whose owning services guard actual effects; selection confers no tool/effect permission. */
export interface ModelStepInput { stepId: string; difficulty: 'ordinary' | 'difficult'; text: string; ownerDecisions: string[]; sources: { ref: Ref; label: string; text: string }[]; tools?: readonly ToolDefinition[] }
/** Durable disclosure and actual observations. Requested/mapped effort is never proof of computation. */
export interface ModelSelectionRecord {
  contract: 's15-model-selection/v1'; id: string; workId: string; stepId: string; inputHash: string;
  route: ApprovedModelRoute; pins: ModelPins; reason: 'owner_pin' | 'ordinary' | 'difficult' | 'approved_alternative';
  state: 'selected' | 'running' | 'completed' | 'held' | 'failed' | 'reconcile_only'; code: string | null;
  createdAt: number; reservations: string[]; usage: Usage; tokens: ModelUsage | null;
  tokenSamples: { reservationId: string; usage: ModelUsage | null }[];
  effort: { requested: string; evidence: ApprovedModelRoute['effortEvidence']; providerConfirmed: false };
  /** The supported seam observes streams; it cannot count provider-internal authentication resends. */
  physicalDispatches: null;
  output: string | null; session: { id: string; branchId: string } | null;
}
/** Explicit opt-in composition, outside working VM/native snapshots. Scripted injection is a no-network
 * deterministic test seam; production obtains the exact model through host.auth.createModel(). */
export interface ModelOptions {
  runtime: 's15'; path: string; create: boolean; installationId: string; nativeDirectory: string;
  policy: S15PolicyService; registry: ApprovedModelRegistry; limits: ModelRunLimits; clock?: HostClock;
  scripted?: (route: ApprovedModelRoute) => Model;
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
/** Host-only step execution; Schway owns the loop/retries/compaction and Jit never refreshes credentials. */
export interface ModelService {
  runStep(actor: WorkActor, input: ModelStepInput, signal?: AbortSignal): Promise<ModelSelectionRecord>;
  /** Read-only reconciliation from already recorded POLICY transport facts. It never recreates a native
   * invocation or result. Unknown effect outcomes remain the responsibility/owning adapter's concern. */
  reconcile(owner: import('../policy').OwnerActor, recordId: string): ModelSelectionRecord;
  publish(actor: WorkActor, stepId: string, consume: (text: string) => void): void;
  project(owner: import('../policy').OwnerActor, workId?: string): ModelBudgetView;
  close(): void;
}
