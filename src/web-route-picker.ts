import type { RouteCatalogs } from "./team/route-catalog";
import type { ProviderReadiness } from "./device-sign-in";
import { readinessLabel, signInButton } from "./web-sign-in";
import { tr } from "./i18n";
import { escape } from "./web-layout";
import { providerLabel, recommendedModel, routeProviders, type RouteModels, type RouteProvider } from "./team/route-options";
import type { RoleRoute } from "./team/types";

/**
 * Shared route picker for every owner route form (#167): the owner chooses a provider, sees the model Jit will use,
 * and only opens "use another model" to type an exact ID. There is no auth route field; the form parser fills it
 * with the provider (`completeRoute`). Plain form controls, so it works without script.
 */
export function routePicker(options: { route: RoleRoute | null; models: RouteModels; legend: string; layout: "cards" | "select"; inheritLabel?: string; readiness?: ProviderReadiness; catalogs?: RouteCatalogs }): string {
  const { route, models } = options;
  const recommendation = (provider: RouteProvider) => options.catalogs?.[provider]?.models?.find(model => model.recommended)?.id ?? recommendedModel(provider, models);
  const custom = route && !options.catalogs?.[route.provider]?.models && route.model !== recommendedModel(route.provider, models) ? route.model : "";
  const catalogs = routeProviders.map(provider => {
    const catalog = options.catalogs?.[provider];
    if (!catalog) return "";
    if (!catalog.models?.length) return catalog.status ? `<p>${escape(providerLabel(provider))} · ${escape(readinessLabel(catalog.status))}</p>` : "";
    const choices = [...catalog.models].sort((a, b) => Number(b.recommended) - Number(a.recommended));
    const saved = route?.provider === provider ? route.model : null;
    if (saved && !choices.some(choice => choice.id === saved)) choices.push({ id: saved, recommended: false });
    const selected = saved ?? choices[0]!.id;
    return `<label>${escape(providerLabel(provider))} · ${tr("route.model_id")}<select name="model_${provider}">${choices.map(choice => `<option value="${escape(choice.id)}"${choice.id === selected ? " selected" : ""}>${escape(choice.id)}${choice.recommended ? ` · ${tr("route.recommended")}` : ""}</option>`).join("")}</select></label>`;
  }).join("");
  const providers = options.layout === "cards"
    ? `<fieldset class="choice-group route-choices"><legend>${escape(options.legend)}</legend>${routeProviders.map((provider, index) =>
      `<div class="route-choice"><label class="choice"><input type="radio" name="provider" value="${provider}"${route?.provider === provider ? " checked" : ""}${index === 0 ? " required" : ""}><span class="route-choice-text"><span>${escape(providerLabel(provider))}</span><small>${tr("route.recommended_model")} ${escape(recommendation(provider))}</small>${options.readiness ? `<small>${escape(readinessLabel(options.readiness[provider]))}</small>` : ""}</span></label>${options.readiness ? signInButton(provider) : ""}</div>`).join("")}</fieldset>`
    : `<label>${escape(options.legend)}<select name="provider">${options.inheritLabel !== undefined ? `<option value="">${escape(options.inheritLabel)}</option>` : ""}${routeProviders.map(provider =>
      `<option value="${provider}"${route?.provider === provider ? " selected" : ""}>${escape(`${providerLabel(provider)} · ${recommendation(provider)}`)}</option>`).join("")}</select></label>`;
  const catalogNote = routeProviders.some(provider => options.catalogs?.[provider]?.models?.length) ? `<p>${tr("route.catalog_note")}</p>` : "";
  return `${providers}${catalogNote}${catalogs}<details class="route-model"${custom ? " open" : ""}><summary>${tr("route.other_model")}</summary><label>${tr("route.model_id")}<input name="model" maxlength="120" autocomplete="off" spellcheck="false" value="${escape(custom)}" placeholder="${tr("route.model_placeholder")}"><small>${tr("route.model_note")}</small></label></details>`;
}
