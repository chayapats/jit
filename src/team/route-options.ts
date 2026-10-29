import type { RoleRoute } from "./types";

/**
 * Route picker defaults for owner forms (#167). The owner chooses a provider; the model and the auth route alias are
 * filled in unless the owner opens "use another model". Catalog selections arrive as explicit model IDs.
 * Nothing here probes credentials or switches a route: an explicit provider choice is still required (FR-13).
 */

/** Subscription provider identity accepted by route forms and the host catalog. */
export type RouteProvider = RoleRoute["provider"];

/** Providers offered by every route form, in display order. */
export const routeProviders: readonly RouteProvider[] = Object.freeze(["codex", "grok"]);

/** Display name of a provider. */
export const providerLabel = (provider: string): string => provider === "codex" ? "ChatGPT (Codex)" : provider === "grok" ? "Grok" : provider;

/**
 * Models used when the operator configured none. They restate Schway's documented per-route fallbacks
 * (`ROUTE_FALLBACK_MODELS`), used when the account catalog is unavailable.
 */
export const builtInModels: Readonly<Record<RouteProvider, string>> = Object.freeze({ codex: "gpt-6-astra", grok: "grok-4.7" });

/** Operator-configured model per provider (service config `routes[].model`); null means none was configured. */
export type RouteModels = Readonly<Record<RouteProvider, string | null>>;
/** No operator model overrides; forms retain built-in defaults when the catalog is unavailable. */
export const noRouteModels: RouteModels = Object.freeze({ codex: null, grok: null });

/** The model a form uses when the owner leaves the model empty. */
export function recommendedModel(provider: RouteProvider, models: RouteModels): string {
  return models[provider] ?? builtInModels[provider];
}

/**
 * Schway binds exactly one credential per route, so one installation has one account per provider and the alias
 * only names the job queue's concurrency key. Forms therefore use the provider itself.
 */
export const defaultAuthRoute = (provider: RouteProvider): string => provider;

/**
 * Completes a route posted by a form: an empty or absent model becomes the recommended model and an empty or absent
 * alias becomes the provider. An unknown provider or a non-string value is passed through unchanged so the existing
 * route validation (`requireRoleRoute`) rejects it with its usual error.
 */
export function completeRoute(input: { provider: unknown; model?: unknown; authRoute?: unknown }, models: RouteModels): { provider: unknown; model: unknown; authRoute: unknown } {
  const provider = input.provider;
  if (provider !== "codex" && provider !== "grok") return { provider, model: input.model, authRoute: input.authRoute };
  const model = input.model === undefined || input.model === "" ? recommendedModel(provider, models) : input.model;
  const authRoute = input.authRoute === undefined || input.authRoute === "" ? defaultAuthRoute(provider) : input.authRoute;
  return { provider, model, authRoute };
}

/** One line for a route: provider and model, plus the alias only when it is a custom (legacy) one. */
export function routeText(route: RoleRoute): string {
  const alias = route.authRoute === route.provider ? "" : ` · ${route.authRoute}`;
  return `${providerLabel(route.provider)} · ${route.model}${alias}`;
}
