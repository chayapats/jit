import { hostCapabilities, listRouteModels, type HostAuthFetch, type HostAuthStatusCode, type HostCredentialStore, type HostClock, type HostModelChoice } from "schway/host";
import { routeProviders, type RouteProvider } from "./route-options";

/** Safe catalog data only; unavailable catalogs retain their status and phase-one defaults. */
export interface RouteCatalogResult { models: readonly HostModelChoice[] | null; status: HostAuthStatusCode | null }
/** One optional catalog result per provider, shared by all route forms. */
export type RouteCatalogs = Partial<Record<RouteProvider, RouteCatalogResult>>;
/** Fixture-only transport/store and capability seams; production uses the public host defaults. */
export interface RouteCatalogOptions { fetch?: HostAuthFetch; store?: HostCredentialStore; capability?: () => string | undefined; clock?: HostClock }

/** Process-owned, ten-minute per-provider cache, including failures and concurrent reads. */
export class RouteCatalog {
  #cache = new Map<RouteProvider, { expires: number; result: Promise<RouteCatalogResult> }>();
  constructor(private options: RouteCatalogOptions = {}) {}
  /** Invalidate on credential changes or explicit route checks; an old read cannot repopulate the cache. */
  invalidate(provider: RouteProvider): void { this.#cache.delete(provider); }
  /** Read catalog metadata only, bounded to five seconds even when the store/transport ignores cancellation. Never throws. */
  async readRouteModels(provider: RouteProvider, { signal, now = this.options.clock?.now ?? Date.now }: { signal?: AbortSignal; now?: () => number } = {}): Promise<RouteCatalogResult> {
    try {
      if ((this.options.capability ?? (() => hostCapabilities().modelCatalog))() !== "schway.host.model-catalog/v1") return { models: null, status: null };
      if (signal?.aborted) return { models: null, status: "integration-unavailable" };
      const cached = this.#cache.get(provider);
      if (cached && cached.expires > now()) return await cached.result;
      const result = this.#read(provider, signal);
      this.#cache.set(provider, { expires: now() + 600_000, result });
      return await result;
    } catch { return { models: null, status: "integration-unavailable" }; }
  }
  async #read(provider: RouteProvider, signal?: AbortSignal): Promise<RouteCatalogResult> {
    const controller = new AbortController();
    let stop!: () => void;
    const stopped = new Promise<RouteCatalogResult>(resolve => { stop = () => { controller.abort(); resolve({ models: null, status: "integration-unavailable" }); }; });
    const timer = this.options.clock ? undefined : setTimeout(stop, 5000);
    if (this.options.clock) void this.options.clock.sleep(5000, controller.signal).then(stop, () => {});
    signal?.addEventListener("abort", stop, { once: true });
    try {
      return await Promise.race([stopped, listRouteModels({ route: provider,
        ...(this.options.store ? { store: this.options.store } : {}),
        fetch: (input, init) => (this.options.fetch ?? fetch)(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal }),
      }).then(result => result.status === "listed" ? { models: result.models, status: null } : { models: null, status: result.status })]);
    } catch { return { models: null, status: "integration-unavailable" }; }
    finally { if (timer !== undefined) clearTimeout(timer); controller.abort(); signal?.removeEventListener("abort", stop); }
  }
  /** Read both providers concurrently; no inference or quota-consuming probe is used. */
  async readAll(): Promise<RouteCatalogs> {
    return Object.fromEntries(await Promise.all(routeProviders.map(async provider => [provider, await this.readRouteModels(provider)])));
  }
}
