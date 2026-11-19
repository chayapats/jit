import { JitClient, JitClientError } from "../client";
import type { ClientBootstrap, ClientSnapshot } from "../client/contracts";
import { MobileClientError, MobileTransport } from "./transport";

/** Ephemeral native projection. No credential, persisted private thread, automatic queue or execution authority. */
export interface MobileProjection {
  readonly generation: number;
  readonly phase: "locked" | "background" | "loading" | "ready" | "unavailable";
  readonly conversationId: string | null;
  readonly bootstrap: Omit<ClientBootstrap, "csrf"> | null;
  readonly snapshot: ClientSnapshot | null;
  readonly code: string | null;
  /** Local continuity only. A change requires the renderer to discard same-session RAM drafts/handles. */
  readonly authenticationRevision: number;
}
/** Current native-client operation has no usable target/session; it never manufactures a new command identity. */
export class MobileProjectionError extends Error {
  constructor(readonly code: "mobile_not_ready" | "mobile_target_invalid" | "mobile_response_stale") { super(code); this.name = "MobileProjectionError"; }
}
const identifier = (id: string) => /^[A-Za-z0-9_-]{1,128}$/.test(id);
const code = (error: unknown): string => error instanceof JitClientError || error instanceof MobileClientError || error instanceof MobileProjectionError ? error.code : "mobile_request_failed";

/**
 * Native lifecycle/target fence over the shared protected client. Callbacks are trusted authored code, never an
 * IPC surface for HTML, notifications, model text or deep links. All actual commands retain their owning contracts.
 */
export class MobileSession {
  readonly transport: MobileTransport;
  readonly #client: JitClient;
  readonly #listeners = new Set<() => void>();
  #generation = 0;
  #target: string | null = null;
  #stop = new AbortController();
  #frame: MobileProjection;
  constructor(transport: MobileTransport) {
    this.transport = transport; this.#client = new JitClient({ origin: transport.origin, fetch: request => transport.fetch(request), fetchBytes: (request, bytes) => transport.fetchBytes(request, bytes) });
    this.#frame = this.#empty("locked");
  }
  /** Stable immutable frame reference for native useSyncExternalStore; publishes no historical fallback. */
  get projection(): MobileProjection { return this.#frame; }
  /** Subscribe to projection changes only. The returned function releases this renderer's listener. */
  subscribe(listener: () => void): () => void { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; }
  #empty(phase: MobileProjection["phase"], error: string | null = null): MobileProjection { return Object.freeze({ generation: this.#generation, phase, conversationId: null, bootstrap: null, snapshot: null, code: error, authenticationRevision: this.#client.authenticationRevision }); }
  #publish(frame: MobileProjection): void { this.#frame = Object.freeze(frame); for (const listener of this.#listeners) listener(); }
  #fence(phase: MobileProjection["phase"], error: string | null = null): number {
    this.#generation++; this.#stop.abort(); this.#stop = new AbortController(); this.#client.clear(); this.transport.pause(); this.#publish(this.#empty(phase, error)); return this.#generation;
  }
  #current(generation: number): void { if (generation !== this.#generation) throw new MobileProjectionError("mobile_response_stale"); }
  /** Inactive/background clears private views synchronously, independently of any outstanding provider response. */
  background(): void { this.#fence("background"); }
  /** Discard client-local credential/state only. Does not revoke an account, policy or remote work. */
  async signOut(): Promise<void> { const generation = this.#fence("locked"); this.#target = null; try { await this.transport.forget(); } catch (error) { if (generation === this.#generation) this.#publish(this.#empty("locked", code(error))); throw error; } }
  /** Restore native credentials, then reacquire bootstrap and the current target before private publication. */
  async restore(): Promise<void> {
    const generation = this.#fence("loading"); this.transport.resume();
    try { if (!await this.transport.restore()) { this.#current(generation); this.#publish(this.#empty("locked")); return; } this.#current(generation); await this.#load(generation); }
    catch (error) { this.#failed(generation, error); throw error; }
  }
  /** One visible owner's password entry, through the existing service ingress; no stored password or retry. */
  async signIn(password: string): Promise<void> {
    const generation = this.#fence("loading"); this.#target = null; this.transport.resume();
    try { await this.transport.signIn(password); this.#current(generation); await this.#load(generation); }
    catch (error) { this.#failed(generation, error); throw error; }
  }
  /** Foreground/reconnect always withholds old views before I/O; this method submits no work/decision. */
  async foreground(): Promise<void> {
    const generation = this.#fence("loading"); this.transport.resume();
    if (!this.transport.authenticated) { this.#publish(this.#empty("locked")); return; }
    try { await this.#load(generation); } catch (error) { this.#failed(generation, error); throw error; }
  }
  /** Select only an opaque document identity. Old target responses cannot appear under the next target. */
  async selectConversation(conversationId: string | null): Promise<void> {
    if (conversationId !== null && !identifier(conversationId)) throw new MobileProjectionError("mobile_target_invalid");
    this.#target = conversationId; await this.foreground();
  }
  async #load(generation: number): Promise<void> {
    const signal = this.#stop.signal, target = this.#target, bootstrap = await this.#client.bootstrap(signal); this.#current(generation);
    const snapshot = target ? await this.#client.snapshot(target, signal) : null; this.#current(generation);
    this.#publish({ generation, phase: "ready", conversationId: target, bootstrap, snapshot, code: null, authenticationRevision: this.#client.authenticationRevision });
  }
  #failed(generation: number, error: unknown): void {
    if (generation !== this.#generation) return;
    const failure = code(error), locked = !this.transport.authenticated || error instanceof JitClientError && [401, 403].includes(error.status ?? 0);
    this.#fence(locked ? "locked" : "unavailable", failure);
  }
  /**
   * One explicit authored read/command using the current target/session and cancellation signal. The caller prepares
   * immutable mutation identities once and owns exact receipt recovery; this method never retries or reconstructs one.
   */
  async perform<T>(operation: (client: JitClient, signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.#frame.phase !== "ready") throw new MobileProjectionError("mobile_not_ready");
    const generation = this.#generation;
    try { const result = await operation(this.#client, this.#stop.signal); this.#current(generation); return result; }
    catch (error) { this.#failed(generation, error); throw error; }
  }
}
