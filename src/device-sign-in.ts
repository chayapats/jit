import { beginDeviceSignIn, checkAuthReadiness, hostCapabilities, type HostAuthFetch, type HostAuthStatusCode, type HostClock, type HostCredentialStore, type HostDeviceSignIn, type HostDeviceSignInStart } from "schway/host";
import { AppError } from "./errors";
import { recommendedModel, routeProviders, type RouteModels, type RouteProvider } from "./team/route-options";

/** Credential-free flow metadata; this is the only sign-in data that may enter a receipt. */
export interface SignInView { id: string; expiresAt: number | null; state: "starting" | "pending" | "busy" | "ready" | "expired" | "denied" | "cancelled" | "provider-error" | "store-error" | "cleanup-required" }
/** One-time Web response. Approval data is never retained in a receipt or returned by status/replay. */
export interface SignInReceipt { signIn: SignInView; approval?: { userCode: string; verificationUri: string } }
/** Web-only owner command. Setup explicitly selects its route; settings signs in without changing any route. */
export interface SignInCommand {
  kind: "setup.sign_in" | "setup.sign_in.cancel"; requestId: string; projectId: null; expectedRevision: number;
  payload: { provider: RouteProvider; surface: "setup" | "settings"; flowId: string | null };
}
/** Safe local readiness, separate from the existing inference check. */
export type ProviderReadiness = Readonly<Record<RouteProvider, HostAuthStatusCode>>;
/** Deterministic host seams only; production uses Schway's native secure store as the service identity. */
export interface SignInOptions { store?: HostCredentialStore; fetch?: HostAuthFetch; clock?: HostClock }

const nativeClock: HostClock = { now: Date.now, sleep: (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(new Error("aborted")); return; }
  const abort = () => { clearTimeout(timer); reject(new Error("aborted")); };
  const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
  timer.unref(); signal?.addEventListener("abort", abort, { once: true });
}) };
interface Flow { view: SignInView; controller: AbortController; deadline: AbortController; handle?: HostDeviceSignIn; settled: boolean; done?: Promise<void> }

/** Process-owned, bounded device flows. Handles stay private; only the initial caller receives approval data. */
export class DeviceSignIns {
  #flows = new Map<RouteProvider, Flow>();
  #closed = false;
  #clock: HostClock;
  constructor(private options: SignInOptions = {}) { this.#clock = options.clock ?? nativeClock; }
  /** A stalled read cannot hold a Web page or a provider reservation indefinitely. */
  async #readLocal(route: RouteProvider, model: string, signal?: AbortSignal): Promise<HostAuthStatusCode> {
    const timer = new AbortController();
    let abort!: () => void;
    const stopped = new Promise<never>((_, reject) => { abort = () => reject(new Error("cancelled")); });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
      const result = await Promise.race([
        checkAuthReadiness({ route, model, ...(this.options.store ? { store: this.options.store } : {}) }),
        this.#clock.sleep(5000, timer.signal).then(() => { throw new Error("store-timeout"); }), stopped,
      ]);
      return result.status;
    } catch { if (signal?.aborted) throw new Error("cancelled"); return "store-unavailable"; }
    finally { timer.abort(); signal?.removeEventListener("abort", abort); }
  }
  /** Read both stores locally without network or inference; failures retain safe host categories. */
  async readiness(models: RouteModels): Promise<ProviderReadiness> {
    const rows = await Promise.all(routeProviders.map(async route => {
      try { return [route, await this.#readLocal(route, recommendedModel(route, models))] as const; }
      catch { return [route, "store-unavailable"] as const; }
    }));
    return Object.fromEntries(rows) as ProviderReadiness;
  }
  /** Whether a provider is still owned by a start/poll, including cancellation cleanup. */
  busy(provider: RouteProvider): boolean { return !this.#flows.get(provider)?.settled && this.#flows.has(provider); }
  /** Unknown ids (including after restart) are cancelled, with no reconstructed approval data. */
  read(provider: RouteProvider, id: string): SignInView {
    const flow = this.#flows.get(provider);
    return flow?.view.id === id ? { ...flow.view } : { id, expiresAt: null, state: "cancelled" };
  }
  /** Start one provider under the caller's live authority fence; bound start plus polling to ten minutes. */
  async start(provider: RouteProvider, id: string, assertCurrent: () => void, changed: (view: SignInView) => void, ready: () => void): Promise<SignInReceipt> {
    if (this.#closed) throw new AppError("service_unavailable", 503);
    if (this.busy(provider)) return { signIn: { id, expiresAt: null, state: "busy" } };
    const flow: Flow = { view: { id, expiresAt: this.#clock.now() + 600_000, state: "starting" }, controller: new AbortController(), deadline: new AbortController(), settled: false };
    this.#flows.set(provider, flow);
    const publish = (state: SignInView["state"]) => { flow.view.state = state; changed({ ...flow.view }); };
    const stop = (state: "expired" | "cancelled") => {
      if (flow.settled) return;
      flow.controller.abort(); flow.handle?.cancel(); publish(state);
    };
    const timer = (ms: number) => { void this.#clock.sleep(Math.max(0, ms), flow.deadline.signal).then(() => stop("expired"), () => {}); };
    timer(600_000);
    let result: HostDeviceSignInStart;
    try {
      assertCurrent();
      if (hostCapabilities().deviceSignInContract !== "schway.host.device-sign-in/v1") throw new Error("unsupported");
      const local = await this.#readLocal(provider, "device-sign-in", flow.controller.signal);
      if (local === "store-unavailable") {
        result = { kind: "store-error", route: provider, containsNoSecrets: true, cleanupUncertain: false };
      } else result = await beginDeviceSignIn({ route: provider, ...(this.options.store ? { store: this.options.store } : {}), ...(this.options.fetch ? { fetch: this.options.fetch } : {}), clock: this.#clock,
        signal: flow.controller.signal, credentialWriteGuard: () => { assertCurrent(); if (this.#closed) throw new Error("stopped"); } });
    } catch { result = { kind: flow.controller.signal.aborted ? "cancelled" : "provider-error", route: provider, containsNoSecrets: true }; }
    if (result.kind !== "pending") {
      flow.settled = true; flow.deadline.abort();
      if (result.kind === "cancelled" && flow.view.state === "expired") return { signIn: { ...flow.view } };
      publish(result.kind === "store-error" && result.cleanupUncertain ? "cleanup-required" : result.kind);
      return { signIn: { ...flow.view } };
    }
    // Never copy the handle/code/link into process read models or durable state.
    flow.handle = result;
    flow.view.expiresAt = Math.min(result.expiresAt, flow.view.expiresAt!);
    flow.deadline.abort(); flow.deadline = new AbortController(); timer(flow.view.expiresAt - this.#clock.now());
    try { assertCurrent(); } catch { stop("cancelled"); }
    if (!flow.controller.signal.aborted) publish("pending");
    const response: SignInReceipt = { signIn: { ...flow.view }, ...(flow.controller.signal.aborted ? {} : { approval: { userCode: result.userCode, verificationUri: result.verificationUri } }) };
    flow.done = result.poll(flow.controller.signal).then(outcome => {
      const state = outcome.kind === "store-error" && outcome.cleanupUncertain ? "cleanup-required" : outcome.kind;
      // Preserve the application's deadline/cancel state when Schway reports cancellation.
      publish(state === "cancelled" && flow.view.state === "expired" ? "expired" : state);
      if (state === "ready") { try { assertCurrent(); ready(); } catch { /* Revoked authority or a route change cannot admit a check. */ } }
    }, () => publish(flow.controller.signal.aborted ? flow.view.state : "provider-error")).finally(() => {
      flow.settled = true; flow.deadline.abort(); delete flow.handle;
    });
    return response;
  }
  /** Cancel only the named flow; a stale form cannot cancel a newer sign-in. */
  cancel(provider: RouteProvider, id: string): SignInView {
    const flow = this.#flows.get(provider);
    if (flow?.view.id === id && !flow.settled) { flow.controller.abort(); flow.handle?.cancel(); flow.view.state = "cancelled"; }
    return this.read(provider, id);
  }
  /** Service shutdown fences writes before waiting for native cancellation cleanup. */
  async close(): Promise<void> {
    this.#closed = true;
    for (const [provider, flow] of this.#flows) this.cancel(provider, flow.view.id);
    await Promise.allSettled([...this.#flows.values()].map(flow => flow.done));
  }
}
