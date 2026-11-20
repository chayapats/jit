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
const identifier = (id: string) => typeof id === "string" && id.length >= 1 && id.length <= 128 && !/[^A-Za-z0-9_-]/.test(id);
const code = (error: unknown): string => error instanceof JitClientError || error instanceof MobileClientError || error instanceof MobileProjectionError ? error.code : "mobile_request_failed";

/**
 * Native lifecycle/target fence over the shared protected client. Callbacks are trusted authored code, never an
 * IPC surface for HTML, notifications, model text or deep links. All actual commands retain their owning contracts.
 */
export class MobileSession {
  readonly transport: MobileTransport;
  readonly #client: JitClient;
  readonly #reader: JitClient;
  readonly #listeners = new Set<() => void>();
  #generation = 0;
  #target: string | null = null;
  #selectionRevision = 0;
  #stop = new AbortController();
  #frame: MobileProjection;
  #poll: Promise<void> | null = null;
  constructor(transport: MobileTransport) {
    this.transport = transport; this.#client = new JitClient({ origin: transport.origin, fetch: request => transport.fetch(request), fetchBytes: (request, bytes) => transport.fetchBytes(request, bytes) });
    this.#reader = new JitClient({ origin: transport.origin, fetch: request => transport.fetch(request) });
    this.#frame = this.#empty("locked");
  }
  /** Stable immutable frame reference for native useSyncExternalStore; publishes no historical fallback. */
  get projection(): MobileProjection { return this.#frame; }
  /** Target/service-login selection continuity for an owner OS sheet; background alone does not change it. */
  get selectionRevision(): number { return this.#selectionRevision; }
  /** Subscribe to projection changes only. The returned function releases this renderer's listener. */
  subscribe(listener: () => void): () => void { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; }
  #empty(phase: MobileProjection["phase"], error: string | null = null): MobileProjection { return Object.freeze({ generation: this.#generation, phase, conversationId: null, bootstrap: null, snapshot: null, code: error, authenticationRevision: this.#client.authenticationRevision }); }
  #publish(frame: MobileProjection): void { this.#frame = Object.freeze(frame); for (const listener of this.#listeners) listener(); }
  #fence(phase: MobileProjection["phase"], error: string | null = null): number {
    this.#generation++; this.#stop.abort(); this.#stop = new AbortController(); this.#client.clear(); this.#reader.clear(); this.transport.pause(); this.#publish(this.#empty(phase, error)); return this.#generation;
  }
  #current(generation: number): void { if (generation !== this.#generation) throw new MobileProjectionError("mobile_response_stale"); }
  /** Inactive/background clears private views synchronously, independently of any outstanding provider response. */
  background(): void { this.#fence("background"); }
  /** Discard client-local credential/state only. Does not revoke an account, policy or remote work. */
  async signOut(): Promise<void> { this.#selectionRevision++; const generation = this.#fence("locked"); this.#target = null; try { await this.transport.forget(); } catch (error) { if (generation === this.#generation) this.#publish(this.#empty("locked", code(error))); throw error; } }
  /** Restore native credentials, then reacquire bootstrap and the current target before private publication. */
  async restore(): Promise<void> {
    const generation = this.#fence("loading"); this.transport.resume();
    try { if (!await this.transport.restore()) { this.#current(generation); this.#publish(this.#empty("locked")); return; } this.#current(generation); await this.#load(generation); }
    catch (error) { this.#failed(generation, error); throw error; }
  }
  /** One visible owner's password entry, through the existing service ingress; no stored password or retry. */
  async signIn(password: string): Promise<void> {
    this.#selectionRevision++;
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
    this.#selectionRevision++; this.#target = conversationId; await this.foreground();
  }
  async #load(generation: number): Promise<void> {
    const signal = this.#stop.signal, target = this.#target, bootstrap = await this.#client.bootstrap(signal); this.#current(generation);
    const snapshot = target ? await this.#client.snapshot(target, signal) : null; this.#current(generation);
    this.#publish({ generation, phase: "ready", conversationId: target, bootstrap, snapshot, code: null, authenticationRevision: this.#client.authenticationRevision });
  }
  /** Read-only active refresh; never rotates the command client's binding or starts/replays work. */
  poll(): Promise<void> {
    if (this.#poll) return this.#poll;
    if (this.#frame.phase !== "ready") return Promise.resolve();
    const generation = this.#generation, target = this.#target, scope = this.#frame.bootstrap?.sessionScope;
    const pending = (async () => {
      try {
        const signal = this.#stop.signal, bootstrap = await this.#reader.bootstrap(signal); this.#current(generation);
        if (!scope || bootstrap.sessionScope !== scope) throw new MobileProjectionError("mobile_response_stale");
        const snapshot = target ? await this.#reader.snapshot(target, signal) : null; this.#current(generation);
        this.#publish({ generation, phase: "ready", conversationId: target, bootstrap, snapshot, code: null, authenticationRevision: this.#client.authenticationRevision });
      } catch (error) { this.#failed(generation, error); throw error; }
    })();
    this.#poll = pending;
    void pending.finally(() => { if (this.#poll === pending) this.#poll = null; }).catch(() => {});
    return pending;
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
    catch (error) {
      this.#current(generation);
      // A protected lookup can truthfully report an absent original receipt without losing authentication.
      if (!(error instanceof JitClientError && error.status === 404 && error.outcome === "response")) this.#failed(generation, error);
      throw error;
    }
  }
  /**
   * One read-only Work snapshot. A renderer's local cancellation aborts its actual request without fencing
   * an otherwise current authenticated session. Parent lifecycle/authentication failures retain normal fences.
   * No command client or mutation callback is exposed through this cancellation exception.
   */
  async readSnapshot(conversationId: string, local?: AbortSignal): Promise<ClientSnapshot> {
    if (this.#frame.phase !== "ready") throw new MobileProjectionError("mobile_not_ready");
    if (!identifier(conversationId)) throw new MobileProjectionError("mobile_target_invalid");
    if (local?.aborted) throw new MobileProjectionError("mobile_response_stale");
    const generation = this.#generation, parent = this.#stop.signal, stop = new AbortController(), cancel = () => stop.abort();
    parent.addEventListener("abort", cancel, { once: true }); local?.addEventListener("abort", cancel, { once: true });
    if (parent.aborted || local?.aborted) stop.abort();
    try {
      const result = await this.#client.snapshot(conversationId, stop.signal); this.#current(generation);
      if (local?.aborted) throw new MobileProjectionError("mobile_response_stale");
      return result;
    } catch (error) {
      this.#current(generation);
      const authenticationFailed = !this.transport.authenticated || error instanceof JitClientError && [401, 403].includes(error.status ?? 0);
      if (!local?.aborted || authenticationFailed) this.#failed(generation, error);
      throw error;
    } finally { parent.removeEventListener("abort", cancel); local?.removeEventListener("abort", cancel); }
  }
}
