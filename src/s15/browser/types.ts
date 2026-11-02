import type { ActionAdapter, ActionClass, ActionRef, BudgetVector, Fence, GithubConditions, JsonValue, OwnerActor, ReadHandler, Ref, S15PolicyService, Transaction, WorkActor } from '../policy';

/** Host-owned browser modes. General mode executes page JavaScript behind the same request broker. */
export type BrowserMode = 'static' | 'general';
/** Safe login facts; hand-back always enters checking before any session observation. */
export type LoginState = 'not_signed_in' | 'owner_control' | 'checking' | 'signed_in' | 'cancelled' | 'unknown';
/** Credential-free actual intercepted bytes. Body uses canonical base64; no cookie, auth or arbitrary headers. */
export interface BrowserRequest { method: string; url: string; contentType: string; bodyBase64: string; navigation: boolean }
/** Trusted semantics installed by protected host composition, never by page/model metadata. Null means unsupported. */
export type RequestMeaning = { kind: 'read'; private: boolean } | { kind: 'login' } | { kind: 'unsupported'; code: string } | { kind: 'effect'; classes: ActionClass[]; recipients: Ref[]; transaction: Transaction | null; impact: 'reversible' | 'major'; github?: GithubConditions | null; verifyResponse?: (response: { status: number; body: Uint8Array }) => 'succeeded' | 'failed' | 'unknown' };
/** Source/observation approval is separate from effect classification. Secret surfaces must return false. */
export interface BrowserSitePolicy {
  classify(request: Readonly<BrowserRequest>, mode: BrowserMode): RequestMeaning | null;
  observable(url: string, mode: BrowserMode): boolean;
  /** Owner-only credential entry is restricted to these exact document URLs. */
  loginDocuments: readonly string[];
  /** A nonredirecting protected HTTP observation, not page text or owner hand-back. */
  session: { url: string; cookie: string; signedInStatus: number; signedOutStatus: number } | null;
}
/** Fixed host registration. It is never constructed from agent JSON or a working-VM path. */
export interface BrowserOptions {
  runtime: 's15'; mode: BrowserMode; resource: Ref; fences: Fence[];
  /** Current protected continuity, never a profile/VM snapshot or ordinary export. */
  continuity: { path: string; create: boolean };
  profilePath: string; executablePath: string; site: BrowserSitePolicy;
  upperBound: BudgetVector; now?: () => number;
}
/** Bounded untrusted observed content. Targets are fresh per observation, never CSS/JS/coordinates. */
export interface BrowserObservation { id: string; generation: number; url: string; text: string; truncated: boolean; elements: { id: string; tag: string; name: string; type: string }[] }
/** Finite agent operations. Upload/download, raw protocols, JS, secrets and arbitrary input are absent. */
export type BrowserOperation = { kind: 'navigate'; url: string; generation: number } | { kind: 'read'; generation: number } | { kind: 'screenshot'; generation: number } | { kind: 'find'; text: string; generation: number } | { kind: 'click' | 'submit'; target: string; generation: number } | { kind: 'type' | 'select'; target: string; value: string; generation: number };
/** Safe JSON result. Screenshot bytes are publishable only through the host's current guarded consumer. */
export type BrowserResult = { state: 'observed'; observation: BrowserObservation } | { state: 'image'; pngBase64: string; generation: number } | { state: 'held'; code: string; action: ActionRef } | { state: 'denied' | 'unsupported' | 'unknown'; code: string } | { state: 'ok'; generation: number };
/** Transient owner input: only authenticated host ingress may call this port; never retain its value. */
export type OwnerBrowserInput = { kind: 'type'; field: string; value: string } | { kind: 'click'; field: string };
/** Protected work closure; cancellation fences all later input/releases/publication. An already released effect remains unknown/reconcile-only. Never expose the service or actor as a tool argument. */
export interface BrowserWork { state(): { generation: number; login: LoginState; reconciliation: ActionRef | null }; execute(operation: BrowserOperation, signal?: AbortSignal): Promise<BrowserResult>; resume(action: ActionRef, signal?: AbortSignal): Promise<BrowserResult>; release(): void }
/** Owner-only live view/input. A takeover generation is checked on each frame/input; no secret bytes enter work results. */
export interface BrowserOwner { takeover(actor: OwnerActor): Promise<{ generation: number }>; frame(actor: OwnerActor, generation: number): Promise<Uint8Array>; input(actor: OwnerActor, generation: number, input: OwnerBrowserInput): Promise<void>; handBack(actor: OwnerActor, generation: number, cancel?: boolean): { generation: number; login: LoginState }; checkSession(actor: OwnerActor): Promise<LoginState> }
/** Explicit host composition hooks for the existing real policy service. Create before opening that service. */
export interface BrowserRegistration { adapter: ActionAdapter; readHandler: ReadHandler; attach(policy: S15PolicyService): void; open(actor: WorkActor): BrowserWork; owner: BrowserOwner; close(): Promise<void> }
/** Internal protected transport. No engine object or raw request resolver is an agent API. */
export interface BrokerResponse { status: number; headers: Record<string, string>; setCookies: string[]; body: Uint8Array }
/** The exact policy projection excludes injected session credentials. */
export const requestPayload = (request: BrowserRequest): JsonValue => ({ contract: 's15-browser-request/v1', ...request });
