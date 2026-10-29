import { tr } from "./i18n";
import { escape } from "./web-layout";
import { providerLabel, recommendedModel, routeProviders, type RouteModels } from "./team/route-options";
import type { RoleRoute } from "./team/types";

/**
 * Shared route picker for every owner route form (#167): the owner chooses a provider, sees the model Jit will use,
 * and only opens "use another model" to type an exact ID. There is no auth route field; the form parser fills it
 * with the provider (`completeRoute`). Plain form controls, so it works without script.
 */
export function routePicker(options: { route: RoleRoute | null; models: RouteModels; legend: string; layout: "cards" | "select"; inheritLabel?: string }): string {
  const { route, models } = options;
  const custom = route && route.model !== recommendedModel(route.provider, models) ? route.model : "";
  const providers = options.layout === "cards"
    ? `<fieldset class="choice-group route-choices"><legend>${escape(options.legend)}</legend>${routeProviders.map((provider, index) =>
      `<label class="choice route-choice"><input type="radio" name="provider" value="${provider}"${route?.provider === provider ? " checked" : ""}${index === 0 ? " required" : ""}><span class="route-choice-text"><span>${escape(providerLabel(provider))}</span><small>${tr("route.recommended_model")} ${escape(recommendedModel(provider, models))}</small></span></label>`).join("")}</fieldset>`
    : `<label>${escape(options.legend)}<select name="provider">${options.inheritLabel !== undefined ? `<option value="">${escape(options.inheritLabel)}</option>` : ""}${routeProviders.map(provider =>
      `<option value="${provider}"${route?.provider === provider ? " selected" : ""}>${escape(`${providerLabel(provider)} · ${recommendedModel(provider, models)}`)}</option>`).join("")}</select></label>`;
  return `${providers}<details class="route-model"${custom ? " open" : ""}><summary>${tr("route.other_model")}</summary><label>${tr("route.model_id")}<input name="model" maxlength="120" autocomplete="off" spellcheck="false" value="${escape(custom)}" placeholder="${tr("route.model_placeholder")}"><small>${tr("route.model_note")}</small></label></details>`;
}
