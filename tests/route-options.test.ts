import { expect, test } from "bun:test";
import { builtInModels, completeRoute, noRouteModels, recommendedModel, routeText } from "../src/team/route-options";
import { serviceRouteModels } from "../src/ops/lifecycle";
import { routePicker } from "../src/web-route-picker";
import { renderWith } from "../src/web-layout";
import type { ServiceConfig } from "../ops/package/service-config";

const piModels = { codex: "gpt-6.1-sol", grok: "grok-4.7" } as const;

test("completeRoute fills the model from the operator config, then the built-in default, and the alias with the provider", () => {
  expect(completeRoute({ provider: "codex" }, piModels)).toEqual({ provider: "codex", model: "gpt-6.1-sol", authRoute: "codex" });
  expect(completeRoute({ provider: "codex", model: "", authRoute: "" }, noRouteModels)).toEqual({ provider: "codex", model: builtInModels.codex, authRoute: "codex" });
  expect(completeRoute({ provider: "grok", model: "grok-5-exact", authRoute: "owner-grok" }, piModels)).toEqual({ provider: "grok", model: "grok-5-exact", authRoute: "owner-grok" });
  // Anything else passes through untouched, so route validation rejects it as before.
  expect(completeRoute({ provider: "openai", model: "" }, piModels)).toEqual({ provider: "openai", model: "", authRoute: undefined });
  expect(recommendedModel("grok", { codex: null, grok: null })).toBe(builtInModels.grok);
});

test("routeText hides an alias equal to the provider and keeps a legacy alias", () => {
  expect(routeText({ provider: "codex", model: "gpt-6.1-sol", authRoute: "codex" })).toBe("ChatGPT (Codex) · gpt-6.1-sol");
  expect(routeText({ provider: "grok", model: "grok-4.7", authRoute: "owner-grok" })).toBe("Grok · grok-4.7 · owner-grok");
});

test("serviceRouteModels reads only configured routes with a model", () => {
  const routes = [{ route: "codex", model: "gpt-6.1-sol", configured: true }, { route: "grok", model: "grok-4.7", configured: false }, { route: "other", model: "x", configured: true }];
  expect(serviceRouteModels({ routes } as unknown as ServiceConfig)).toEqual({ codex: "gpt-6.1-sol", grok: null });
});

test("the route picker offers providers with their recommended model and never asks for an auth route", () => {
  const cards = renderWith({ locale: "th", theme: "dark" }, () => routePicker({ route: null, models: piModels, legend: "บัญชี", layout: "cards" }));
  expect(cards).toContain('name="provider" value="codex"');
  expect(cards).toContain("gpt-6.1-sol");
  expect(cards).not.toContain("authRoute");
  expect(cards).not.toContain(" checked");
  expect(cards).toContain('<details class="route-model">');
  // A custom model is shown in the open fold; the recommended one leaves the field empty.
  const custom = renderWith({ locale: "en", theme: "dark" }, () => routePicker({ route: { provider: "grok", model: "grok-5-exact", authRoute: "grok" }, models: piModels, legend: "Account", layout: "select", inheritLabel: "Use the next level" }));
  expect(custom).toContain('<details class="route-model" open>');
  expect(custom).toContain('value="grok-5-exact"');
  expect(custom).toContain('<option value="">Use the next level</option>');
  expect(custom).toContain('<option value="grok" selected>Grok · grok-4.7</option>');
});

for (const status of ["needs-login", "quota-exceeded", "integration-unavailable"] as const) test(`catalog ${status} retains fallback and safe status text in both layouts`, () => {
  for (const layout of ["cards", "select"] as const) {
    const html = renderWith({ locale: "en", theme: "light" }, () => routePicker({ route: null, models: piModels, legend: "Account", layout, catalogs: { codex: { models: null, status } } }));
    expect(html).toContain("gpt-6.1-sol");
    expect(html).toContain(status === "needs-login" ? "Sign in needed" : status === "quota-exceeded" ? "Quota exhausted" : "Blocked");
    expect(html).toContain('name="model"'); expect(html).not.toContain('name="model_codex"');
  }
});

test("an empty catalog keeps the saved model in the free-text field so a save never changes it (FR-13)", () => {
  for (const layout of ["cards", "select"] as const) {
    const route = { provider: "codex", model: "gpt-saved-custom", authRoute: "codex" } as const;
    const html = renderWith({ locale: "en", theme: "light" }, () => routePicker({ route, models: piModels, legend: "Account", layout, catalogs: { codex: { models: [], status: null } } }));
    expect(html).toContain('value="gpt-saved-custom"');
    expect(html).not.toContain('name="model_codex"');
  }
});
