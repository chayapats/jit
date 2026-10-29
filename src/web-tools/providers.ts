import { createTavilyProvider, createExaProvider, type WebSearchTransport } from "./adapters";
import type { SearchProvider } from "schway/host";
import { AppError } from "../errors";
import { releaseConnection, type ConnectionVault } from "../exec/connections";
import type { TransactionStore } from "../store";
import { readWebProvider, type WebProviderSetting } from "./settings";

/** Owner-visible provider metadata; a missing-key fallback preserves the revisioned selection and is explicit. */
export interface WebProviderSelection extends WebProviderSetting { effectiveId: string | null; fallback: "key_missing" | null }

/** Factory is trusted installation code; secrets stay in its closure, outside settings, prompts and results. */
export type SearchProviderFactory = (secret: string | null) => SearchProvider;
/** Installation registry. WEB02 can register a managed, keyless backend; WEB03 selects its id through web.provider.set. */
export class WebProviderRegistry {
  readonly #factories = new Map<string, SearchProviderFactory>();
  /** Registers trusted service code only; tool input never selects a factory. */
  register(id: string, factory: SearchProviderFactory): this { this.#factories.set(id, factory); return this; }
  /** Metadata-only selection. Only missing/removed/empty keys fall back, never unsafe vault files or provider errors. */
  selection(store: TransactionStore, vault?: ConnectionVault): WebProviderSelection {
    const setting = store.read(readWebProvider);
    if (setting.id === "tavily" || setting.id === "exa") {
      const connection = setting.connectionId ? store.read(tx => tx.get<{ kind: string; secret: string; removed: number | null }>(
        "SELECT kind, secret_state AS secret, removed_at AS removed FROM connections WHERE id = ?", setting.connectionId!)) : null;
      if (!connection || connection.kind !== "web_search_key" || connection.secret !== "set" || connection.removed !== null || (vault && vault.inspect(setting.connectionId!) === "missing"))
        return { ...setting, effectiveId: "searxng", fallback: "key_missing" };
    }
    return { ...setting, effectiveId: setting.id, fallback: null };
  }
  /** Resolves the selected provider at use time; values are released only into the selected trusted adapter. */
  resolve(store: TransactionStore, projectId?: string, vault?: ConnectionVault, onFallback?: () => void): SearchProvider | null {
    const selected = this.selection(store, vault);
    if (selected.effectiveId === null) return null;
    const factory = this.#factories.get(selected.effectiveId);
    if (!factory) throw new AppError("web_provider_unavailable", 503);
    if (selected.fallback) onFallback?.();
    let secret: string | null = null;
    if (selected.connectionId && !selected.fallback) {
      if (!vault) throw new AppError("connection_vault_not_configured", 503);
      secret = store.transaction(tx => {
        const released = releaseConnection(tx, selected.connectionId!, `web:${selected.effectiveId}`, vault, projectId ? { projectId } : {});
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

/** Explicit owner connectivity check: one fixed public query, one result and a ten-second abort deadline. */
export async function testWebSearch(provider: SearchProvider, signal = AbortSignal.timeout(10_000)): Promise<"ok" | "failed"> {
  let abort: (() => void) | undefined;
  try {
    signal.throwIfAborted();
    const deadline = new Promise<never>((_, reject) => { abort = () => reject(new AppError("web_provider_unavailable", 503)); signal.addEventListener("abort", abort, { once: true }); });
    const result = await Promise.race([provider.search("jit connectivity check", { limit: 1, signal }), deadline]);
    return result.length > 0 && !signal.aborted ? "ok" : "failed";
  } catch { return "failed"; }
  finally { if (abort) signal.removeEventListener("abort", abort); }
}
