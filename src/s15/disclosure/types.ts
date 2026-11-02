import type { ActionAdapter, ActionDraft, ActionRef, AdapterResult, BudgetVector, CatalogPort, DisclosureDetails, JsonValue, PreparedResult, Ref, S15PolicyService, WorkActor, WorkAuthority } from '../policy';
import type { BrowserRequest } from '../browser';
import type { ApprovedModelRoute } from '../model';

/** Source classification is owning-service state, never a model label or text-pattern inference. */
export type DataClass = 'public' | 'private' | 'personal' | 'business';
/** Immutable source scope. Unknown, withdrawn or changed revisions fail closed. */
export interface DisclosureSource { ref: Ref; resource: Ref; classification: DataClass; active: boolean; ownerReleasable: boolean }
/** Explicit protected approval for a recipient, purpose, resources and classes. Null sources means
 * all current revisions inside that resource/class scope, not every resource or a new purpose. */
export interface RecipientApproval { recipient: Ref; purpose: Ref; resources: Ref[]; dataClasses: DataClass[]; sources: Ref[] | null; expiresAt: number }
/** Protected owning catalogs, with no permissive default or model-controlled registration. */
export interface DisclosureCatalog {
  source(ref: Ref): DisclosureSource | null;
  recipient(ref: Ref): { ref: Ref; active: boolean } | null;
  approvals(): readonly RecipientApproval[];
}
/** Fixed protected emitter. resolve binds recipients from the actual complete payload, including URL,
 * query, form/body/upload and adapter targets. Null means unknown and denies before DNS or send.
 * perform must send these bytes once, with no redirects, alternate endpoint or retry. */
export interface DisclosureRoute {
  id: string; kind: 'browser' | 'adapter' | 'artifact' | 'model';
  resolve(work: WorkAuthority, payload: JsonValue): readonly Ref[] | null;
  send?: (payload: JsonValue) => Promise<AdapterResult>;
  /** Required for a standalone emitter. Include every original effect gate; disclosure approval must
   * never turn an unknown upload/send/payment into an ordinary edit. Null refuses support. */
  classify?: (work: WorkAuthority, payload: JsonValue) => Pick<ActionDraft, 'classes' | 'transaction' | 'github' | 'impact'> | null;
}
/** Explicit S15 protected composition. Only descriptors/refs enter this ledger; credentials and source
 * contents do not. Browser source resolution must identify the actual observed revision before release. */
export interface DisclosureOptions {
  runtime: 's15'; path: string; create: boolean; installationId: string;
  catalogs: DisclosureCatalog; routes: readonly DisclosureRoute[]; now?: () => number;
  browserSource?: (work: WorkAuthority, url: string, format: 'response' | 'text' | 'image') => Ref | null;
  /** Exact protected VM registry host mapping, never guest-supplied recipient metadata. */
  registryRecipient?: (destination: string) => Ref | null;
}
/** Additive protected browser hook. inspect must precede every broker release; guard rechecks final
 * bytes/current lineage after waits. Private observations are recorded before publication. */
export interface BrowserDisclosurePort {
  inspect(work: WorkAuthority, request: BrowserRequest): Pick<ActionDraft, 'classes' | 'recipients' | 'fences' | 'disclosure'>;
  guard(work: WorkAuthority, request: BrowserRequest, expected?: DisclosureDetails): void;
  record(work: WorkAuthority, url: string, format: 'response' | 'text' | 'image'): void;
}
/** MODEL excludes candidates unapproved for any accumulated private lineage. The final public stream
 * guard also screens complete context bytes and source scope; it cannot fence provider-internal retries. */
export interface ModelDisclosurePort {
  allows(work: WorkAuthority, route: ApprovedModelRoute): boolean;
  guard(work: WorkAuthority, route: ApprovedModelRoute, request: unknown): void;
}
/** Host-only service. No tool receives these mutation/catalog/adapter registration ports. */
export interface DisclosureService {
  adapter: ActionAdapter;
  attach(policy: S15PolicyService): void;
  /** Stamp before releasing an actual read. All subsequent output, including uncited derived text,
   * inherits the work's monotonic accumulated restrictions. */
  read(actor: WorkActor, source: Ref): void;
  /** Register text/image/artifact descendants with every source already read by this work. */
  derive(actor: WorkActor, derived: Ref, kind: 'text' | 'screenshot' | 'artifact'): void;
  /** Import only a protected descendant's recorded ancestors, rechecking current source access. */
  inherit(actor: WorkActor, derived: Ref): void;
  /** Exact descriptor and one registered emitter; preparation has no outbound I/O. */
  prepare(actor: WorkActor, input: { slot: string; route: string; payload: JsonValue; upperBound: BudgetVector; expiresAt: number }): PreparedResult;
  dispatch(actor: WorkActor, action: ActionRef): ReturnType<S15PolicyService['work']['dispatch']>;
  /** Decorate a real adapter without dropping its other human-required classes or preconditions. */
  protectAdapter(adapter: ActionAdapter, route: string): ActionAdapter;
  /** Actual VM acquisition adapter hooks; local VM operations keep their existing policy path. */
  acquisition(route: string): { prepare(work: WorkAuthority, draft: ActionDraft): ActionDraft; guard(work: WorkAuthority, action: import('../policy').PreparedAction): void };
  /** Protected VM lease binding. Callbacks never enter guest JSON or proxy logs. */
  registryLease(actor: object, destination: string, vmId?: string): void;
  /** Stamp all work ancestry before guest input. Shared guest root can read sibling work files, so
   * registry checks inherit the VM's accumulated releases across work/session/reboot boundaries. */
  vmInput(actor: object, vmId: string): void;
  /** Import shared-guest ancestry before any output is returned to a work/model/tool. Without this,
   * a sibling could move stolen guest bytes through a protected browser/model/acquisition route. */
  vmOutput(actor: object, vmId: string): void;
  /** Compose with mandatory POLICY owning-service consent/privacy ceilings. */
  catalogs(base: CatalogPort): CatalogPort;
  browser(route: string): BrowserDisclosurePort;
  model(route: (candidate: ApprovedModelRoute) => string): ModelDisclosurePort;
  /** Narrow VM registry proxy seam: exact approved destination only. Opaque CONNECT bytes cannot
   * obtain an exact-disclosure approval. Content/covert-channel prevention is not claimed. */
  registryDestination(actor: WorkActor, recipient: Ref, destination: string): void;
  close(): void;
}
