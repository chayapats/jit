import { tr, type MessageKey } from "./i18n";
import { documentPage, escape, hiddenCommand } from "./web-layout";
import { providerLabel, routeProviders, type RouteProvider } from "./team/route-options";
import type { ProviderReadiness, SignInReceipt } from "./device-sign-in";

/** Local readiness labels make no inference claim; unavailable stores remain explicitly blocked. */
export function readinessLabel(status: ProviderReadiness[RouteProvider]): string {
  if (status === "cleanup-required") return `${tr("signin.readiness.blocked")} · ${tr("signin.recover_store")}`;
  const key = status === "configured-unverified" ? "ready" : status === "quota-exceeded" ? "quota" : status === "needs-login" || status === "rejected" ? "needed" : "blocked";
  return tr(`signin.readiness.${key}` as MessageKey);
}
/** Separate forms let provider-card buttons submit sign-in without nesting the route form. */
export function signInForms(csrf: string, revision: number, surface: "setup" | "settings"): string {
  return routeProviders.map(provider => `<form id="sign-in-${provider}" method="post" action="/setup/sign-in">${hiddenCommand(csrf, revision)}<input type="hidden" name="provider" value="${provider}"><input type="hidden" name="surface" value="${surface}"></form>`).join("");
}
/** Provider action shared by setup and Settings › Team; the selected route never changes in settings. */
export function signInButton(provider: RouteProvider): string {
  return `<button type="submit" form="sign-in-${provider}">${tr("signin.start")}</button>`;
}
/** Settings provider cards, with readiness from the same local read as setup. */
export function providerSignInCards(readiness: ProviderReadiness, csrf: string, revision: number): string {
  return `<section class="team-card"><h2>${tr("signin.accounts")}</h2><p>${tr("signin.readiness_note")}</p>${signInForms(csrf, revision, "settings")}${routeProviders.map(provider => `<article><h3>${escape(providerLabel(provider))}</h3><p>${escape(readinessLabel(readiness[provider]))}</p>${signInButton(provider)}</article>`).join("")}</section>`;
}
/** Credential-free status URL; approval codes and links never enter a URL or a GET response. */
export const signInPath = (provider: RouteProvider, id: string, surface: "setup" | "settings") => `/setup/sign-in/${provider}/${id}?surface=${surface}`;

/** Initial approval is shown once; subsequent GETs/replays show only status, cancellation and retry. */
export function signInPage(receipt: SignInReceipt, provider: RouteProvider, surface: "setup" | "settings", csrf: string, revision: number): string {
  const { signIn, approval } = receipt, path = signInPath(provider, signIn.id, surface);
  const pending = signIn.state === "pending" || signIn.state === "starting";
  let link = "";
  try { const uri = new URL(approval?.verificationUri ?? ""); if (uri.protocol === "https:" && !uri.username && !uri.password) link = uri.href; } catch { /* Invalid host data is never made into a link. */ }
  const code = approval && link ? `<p>${tr("signin.instructions")}</p><p><strong>${escape(approval.userCode)}</strong></p><p><a href="${escape(link)}" target="_blank" rel="noopener noreferrer">${tr("signin.open_link")}</a></p><p>${tr("signin.once")}</p>` : "";
  return documentPage(tr("signin.title"), `<main class="setup" id="main-content"><section class="setup-card" data-sign-in${pending ? ` data-ready-page="${surface === "setup" ? "/setup?step=connect#connection" : "/settings/team"}" data-deadline="${signIn.expiresAt ?? 0}" data-status-url="/api${escape(path)}" data-status-page="${escape(path)}"` : ""}>
    <h1>${tr("signin.title")} · ${escape(providerLabel(provider))}</h1><p class="job-status" data-state="${pending ? "running" : signIn.state === "ready" ? "succeeded" : "blocked"}" role="status" data-sign-in-state>${tr(`signin.state.${signIn.state}` as MessageKey)}</p>${code}
    ${signIn.expiresAt ? `<p>${tr("signin.expires")} <time datetime="${new Date(signIn.expiresAt).toISOString()}">${new Date(signIn.expiresAt).toISOString()}</time></p>` : ""}
    ${pending ? `<p data-sign-in-error role="alert" hidden>${tr("signin.status_error")} <a href="${escape(path)}">${tr("setup.refresh")}</a></p><a href="${escape(path)}">${tr("setup.refresh")}</a><form method="post" action="/setup/sign-in/${provider}/${signIn.id}/cancel">${hiddenCommand(csrf, revision)}<input type="hidden" name="surface" value="${surface}"><button>${tr("signin.cancel")}</button></form>` : `${signInForms(csrf, revision, surface)}${signInButton(provider)}`}
    ${signIn.state === "store-error" || signIn.state === "cleanup-required" ? `<p class="setup-next">${tr(signIn.state === "cleanup-required" ? "signin.recover_store" : "signin.unlock_store")}</p>` : ""}
    <p><a href="${surface === "setup" ? "/setup?step=connect" : "/settings/team"}">${tr("signin.back")}</a></p></section></main>`);
}
