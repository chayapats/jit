import { createTavilyProvider, createExaProvider, type WebSearchTransport } from "./adapters";
import type { SearchProvider } from "schway/host";
import { AppError } from "../errors";
import { releaseConnection, type ConnectionVault } from "../exec/connections";
import type { TransactionStore } from "../store";
import { readWebProvider } from "./settings";

/** Factory is trusted installation code; secrets stay in its closure, outside settings, prompts and results. */
export type SearchProviderFactory = (secret: string | null) => SearchProvider;
/** Installation registry. WEB02 can register a managed, keyless backend; WEB03 selects its id through web.provider.set. */
export class WebProviderRegistry {
  readonly #factories = new Map<string, SearchProviderFactory>();
  /** Registers trusted service code only; tool input never selects a factory. */
  register(id: string, factory: SearchProviderFactory): this { this.#factories.set(id, factory); return this; }
  /** Resolves the current installation provider and scoped vault reference, or returns null when unconfigured. */
  resolve(store: TransactionStore, projectId: string, vault?: ConnectionVault): SearchProvider | null {
    const selected = store.read(readWebProvider);
    if (selected.id === null) return null;
    const factory = this.#factories.get(selected.id);
    if (!factory) throw new AppError("web_provider_unavailable", 503);
    let secret: string | null = null;
    if (selected.connectionId) {
      if (!vault) throw new AppError("connection_vault_not_configured", 503);
      secret = store.transaction(tx => {
        const released = releaseConnection(tx, selected.connectionId!, `web:${selected.id}`, vault, { projectId });
        if (released.kind !== "web_search_key") throw new AppError("web_connection_unavailable", 409);
        return released.secret;
      });
    }
    return factory(secret);
  }
}
/** Explicitly selected key-based adapters; WEB02 registers the managed keyless default. No provider is selected implicitly. */
export function defaultWebProviders(transport?: WebSearchTransport, builtin?: SearchProvider): WebProviderRegistry {
  const registry = new WebProviderRegistry()
    .register("tavily", secret => createTavilyProvider(secret ?? "", transport))
    .register("exa", secret => createExaProvider(secret ?? "", transport));
  if (builtin) registry.register("searxng", () => builtin);
  return registry;
}
