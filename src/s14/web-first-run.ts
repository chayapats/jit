import { tr, withLocale, type Locale } from "../i18n";
import { logoLockup, logoMark } from "../web-logo";
import type { S14Application } from "./application";
import type { S14SignInReceipt } from "./sign-in";
import type { S14AuthRenderer, S14Page } from "./web";
import { banner, commandForm, e, flat, hidden, k, notice, pill, remaining, shell, standalone, when, withTheme } from "./web-pages";
import { ownerTheme, type S14View } from "./web-product";
import { signedIn, type S14Provider, type S14ProviderSettings } from "./web-product-first-run";

type Name = S14Provider["provider"];
type Step = "wake" | "connect" | "know" | "set";
const stepOrder: Step[] = ["wake", "connect", "know", "set"];
/** Which device-flow states leave the owner with no signed-in credential and a way to begin again. */
const retryAction: Partial<Record<S14SignInReceipt["signIn"]["state"], string>> = { expired: "s14.signin.new_code", denied: "s14.signin.try_again", cancelled: "s14.signin.try_again", "provider-error": "s14.signin.try_again", "store-error": "s14.signin.try_again", "cleanup-required": "s14.signin.try_again" };
const providerName = (name: Name) => tr(k(`s14.provider.${name}`));
const filled = (key: string, name: Name) => tr(k(key)).replace("{provider}", () => providerName(name));
/** A provider whose sign-in cannot help offers no button: only its word. */
const noSignIn: S14Provider["readiness"][] = ["model-unavailable", "integration-unavailable"];

function steps(current: Step): string {
  const index = stepOrder.indexOf(current);
  return `<ol class="s-setup-steps">${stepOrder.map((step, i) => `<li${i < index ? ' data-step="done"' : i === index ? ' data-step="current" aria-current="step"' : ""}>${tr(k(`s14.setup.step_${step}`))}</li>`).join("")}</ol>`;
}
/** A password field and a repeat are the whole step; the capability stays in its cookie and is never rendered. */
export function renderOwnerSetup(csrf: string, locale: Locale, code: string | null = null): string {
  return withLocale(locale, () => standalone(tr("s14.first.password_title"), `${steps("wake")}<div class="s-setup-card"><span class="brand">${logoLockup({ height: 44, label: "Jit" })}</span><h1>${tr("s14.first.password_title")}</h1><p class="s-sub">${tr("s14.first.password_lead")}</p>${code ? `<div role="alert">${notice(code)}</div>` : ""}
    <form class="s-stack" method="post" action="/owner/setup">${hidden("csrf", csrf)}<div class="s-field"><label for="s14-owner-password">${tr("s14.first.password")}</label><input id="s14-owner-password" name="password" type="password" minlength="12" maxlength="256" required autocomplete="new-password" aria-describedby="s14-owner-note"></div><div class="s-field"><label for="s14-owner-confirm">${tr("s14.first.confirm")}</label><input id="s14-owner-confirm" name="confirm" type="password" minlength="12" maxlength="256" required autocomplete="new-password"></div><p class="s-note" id="s14-owner-note">${tr("s14.first.password_note")}</p><div><button class="s-btn primary">${tr("s14.first.password_submit")}</button></div></form><p class="s-note">${tr("s14.first.link_note")}</p></div>`));
}
/** Refused setup link or post. It reveals only whether an owner exists, which `/s14/login` already shows, and offers one way forward. */
export function renderOwnerSetupRefused(code: string, locale: Locale, ownerExists: boolean, theme: Parameters<typeof withTheme>[0] = "system"): string {
  const link = code === "owner_setup_link_invalid";
  return withTheme(theme, () => withLocale(locale, () => standalone(tr(link ? "s14.first.refused_title" : "s14.first.refused_post_title"), `<div class="s-notice-card"><span class="brand">${logoLockup({ height: 44, label: "Jit" })}</span><h1>${tr(link ? "s14.first.refused_title" : "s14.first.refused_post_title")}</h1><p>${tr(link ? "s14.first.refused_detail" : "s14.first.refused_post_detail")}</p><p class="s-mono s-meta">${e(code)}</p>
    ${ownerExists ? `<p>${tr("s14.first.refused_owner")}</p><p><a class="s-btn primary" href="/s14/login">${tr("s14.login.submit")}</a></p>` : `<p>${tr("s14.login.unprovisioned_note")}</p>`}</div>`)));
}

/** Words for a provider's local readiness. Signed in stays "not tested", because it proves credentials rather than a working subscription. */
function providerRow(page: Pick<S14Page, "csrf" | "state">, item: S14Provider, ready: string): string {
  const name = item.provider, usable = signedIn(item), label = tr(k(`s14.provider.state.${item.readiness}`));
  const sign = noSignIn.includes(item.readiness) ? "" : commandForm(page.csrf, "setup.sign_in", page.state.revision, { provider: name, flowId: null }, `${tr(usable || item.readiness !== "needs-login" ? "s14.provider.sign_in_again" : "s14.provider.sign_in")} ${providerName(name)}`, usable || ready ? "s-btn" : "s-btn primary");
  return `<li class="s-provider"${usable ? " data-ready" : ""}><div><b>${e(providerName(name))}</b><span class="s-meta">${tr(k(`s14.provider.${name}_detail`))}</span><span class="s-provider-state">${pill(label, usable ? "ok" : item.readiness === "needs-login" ? "" : "warn", usable ? "✓" : item.readiness === "needs-login" ? "" : "!")}</span></div>${ready}${sign}</li>`;
}
function connectStep(page: S14Page, view: Extract<S14View, { kind: "setup" }>): string {
  const { items } = view.providers;
  const rows = items.map(item => providerRow(page, item, signedIn(item) ? `<a class="s-btn primary" href="/?provider=${e(item.provider)}">${tr("s14.provider.use")} ${e(providerName(item.provider))}</a>` : "")).join("");
  const body = items.length ? `<ul class="s-providers" aria-label="${tr("s14.provider.list")}">${rows}</ul><p class="s-note">${tr("s14.provider.choose_note")}</p>` : banner("danger", tr("s14.setup.route_missing"), tr("s14.setup.route_missing_detail"));
  return standalone(tr("s14.provider.choose_title"), `${steps("connect")}<div class="s-setup-card"><h1>${tr("s14.provider.choose_title")}</h1><p class="s-sub">${tr("s14.provider.choose_lead")}</p>${notice(view.notice)}${body}</div>`);
}
const researchTools = (page: S14Page) => (["web_search", "web_fetch"] as const).filter(tool => page.policy.tools.includes(tool));
/** Public research works from the first message: both tools are ticked, named in words and the owner can untick them. */
function researchChoice(page: S14Page): string {
  const tools = researchTools(page); if (!tools.length) return "";
  return `<fieldset class="s-field"><legend>${tr("s14.setup.research")}</legend>${tools.map(tool => `<label class="s-check"><input type="checkbox" name="tool:${tool}" value="on" checked><span>${tr(k(`s14.setup.research_${tool}`))}</span></label>`).join("")}<p class="s-note">${tr("s14.setup.research_note")}</p><p class="s-note">${tr("s14.setup.nothing_else")}</p></fieldset>`;
}
/** The provider choice carries only a route ID the owner never sees; several signed-in providers become a choice of names. */
function providerChoice(view: Extract<S14View, { kind: "setup" }>, routes: number): string {
  const ready = view.providers.items.filter(signedIn), chosen = view.providers.selected;
  if (chosen || ready.length === 1) {
    const item = ready.find(entry => entry.id === chosen) ?? ready[0]!;
    return `${routes > 1 ? hidden("routeId", item.id) : ""}<p class="s-between"><span>${tr("s14.provider.using")} ${e(providerName(item.provider))}</span><a class="s-link-text" href="/?change">${tr("s14.provider.change")}</a></p><p class="s-note">${tr("s14.setup.route_configured_detail")}</p>`;
  }
  return `<fieldset class="s-field"><legend>${tr("s14.provider.pick")}</legend>${ready.map((item, i) => `<label class="s-check"><input type="radio" name="routeId" value="${e(item.id)}"${i === 0 ? " checked" : ""}><span>${e(providerName(item.provider))}</span></label>`).join("")}<p class="s-note">${tr("s14.setup.route_configured_detail")}</p></fieldset>`;
}
function knowStep(page: S14Page, view: Extract<S14View, { kind: "setup" }>): string {
  const language = view.draft?.language ?? page.locale;
  const nothing = researchTools(page).length ? "" : `<p class="s-note">${tr("s14.setup.nothing_granted_detail")}</p>`;
  return standalone(tr("s14.setup.title"), `${steps("know")}<div class="s-setup-card"><div class="s-ceremony ceremony" data-ceremony="idle">${logoMark({ size: 96 })}</div><h1>${tr("s14.setup.title")}</h1><p class="s-sub">${tr("s14.setup.lead")}</p>${notice(view.notice)}
    <form class="s-stack" data-ceremony-form method="post" action="/s14/forms/setup">${flat(page.csrf, page.state.revision)}<div class="s-field"><label for="s14-name">${tr("s14.setup.name")}</label><input id="s14-name" name="ownerName" required maxlength="60" autocomplete="name" value="${e(view.draft?.ownerName ?? "")}"></div>
    <fieldset class="s-field"><legend>${tr("s14.setup.language")}</legend><label class="s-check"><input type="radio" name="language" value="th"${language === "th" ? " checked" : ""}><span lang="th">ไทย</span></label><label class="s-check"><input type="radio" name="language" value="en"${language === "en" ? " checked" : ""}><span lang="en">English</span></label></fieldset>
    <div class="s-stack">${providerChoice(view, page.state.routes.length)}</div>${researchChoice(page)}${nothing}<div><button class="s-btn primary">${tr("s14.setup.submit")}</button></div></form></div>`);
}
/** Setup after the password: a provider first, because Jit cannot answer without one, then the one form it cannot infer. */
export function setupPage(page: S14Page, view: Extract<S14View, { kind: "setup" }>): string {
  return view.providers.choosing || !view.providers.items.some(signedIn) ? connectStep(page, view) : knowStep(page, view);
}
/** Signed-in provider page: readiness in words and one way to sign in again. It has no route or model control. */
export function providerSettingsPage(page: S14Page, view: S14ProviderSettings): string {
  const usedBy = (item: S14Provider) => { const bots = page.state.bots.filter(bot => bot.routeId === item.id); return bots.length ? `<span class="s-meta">${tr("s14.provider.in_use")}: ${bots.map(bot => e(bot.id === "jit" ? tr("s14.jit") : bot.name)).join(" · ")}</span>` : `<span class="s-meta">${tr("s14.provider.in_use_none")}</span>`; };
  const rows = view.providers.map(item => providerRow(page, item, "").replace("</span></div>", `</span>${usedBy(item)}</div>`)).join("");
  return shell(page, tr("s14.provider.settings_title"), `<div class="s-col"><p class="s-sub">${tr("s14.provider.settings_lead")}</p><ul class="s-providers" aria-label="${tr("s14.provider.list")}">${rows}</ul><p class="s-note">${tr("s14.provider.settings_note")}</p><p class="s-note">${tr("s14.provider.choose_note")}</p><p><a class="s-link-text" href="/more">${tr("s14.web.back")}</a></p></div>`, { current: "more" });
}

/** Only an https sign-in page becomes a link; anything else stays plain text, so a bad value cannot start a navigation. */
function approvalLink(uri: string): { href: string | null } {
  try { const url = new URL(uri); return { href: url.protocol === "https:" ? url.href : null }; } catch { return { href: null }; }
}
function approvalBlock(receipt: S14SignInReceipt, now: number): string {
  const { approval, signIn, provider } = receipt, link = approvalLink(approval!.verificationUri);
  const expires = signIn.expiresAt ? `<p class="s-meta">${tr("s14.signin.expires")} ${when(signIn.expiresAt)} · ${remaining(signIn.expiresAt, now)}</p>` : "";
  return `<ol class="s-signin-steps"><li><p>${e(filled("s14.signin.step_open", provider))}</p>${link.href ? `<p><a class="s-btn primary" href="${e(link.href)}" target="_blank" rel="noopener noreferrer">${tr("s14.signin.open")}</a></p>` : ""}<p class="s-signin-uri">${e(approval!.verificationUri)}</p></li><li><p>${tr("s14.signin.step_code")}</p><div class="s-signin-code"><code class="s-code" aria-label="${tr("s14.signin.code")}" data-copy-source>${e(approval!.userCode)}</code><button type="button" class="s-btn" data-copy data-copied="${tr("s14.signin.copied")}" hidden>${tr("s14.signin.copy")}</button></div>${expires}<p class="s-note">${tr("s14.signin.once")}</p></li></ol>`;
}
const waitLine = (provider: Name) => `<div class="s-signin-wait" role="status"><span aria-hidden="true"></span><div><p><b>${e(filled("s14.signin.waiting", provider))}</b></p><p class="s-sub s-js">${tr("s14.signin.waiting_auto")}</p><p class="s-sub s-nojs">${tr("s14.signin.waiting_manual")}</p></div></div>`;
/** Device sign-in page. Approval data exists only on the first POST response, so every other visit shows the safe state alone. */
export function renderSignIn(receipt: S14SignInReceipt, csrf: string, revision: number, locale: Locale, context: { now: number; setup: boolean; theme: Parameters<typeof withTheme>[0] }): string {
  const { signIn, provider } = receipt, state = signIn.state, back = context.setup ? "/" : "/settings/provider";
  return withTheme(context.theme, () => withLocale(locale, () => {
    const title = filled("s14.signin.title", provider), self = `/s14/sign-in/${e(provider)}/${e(signIn.id)}`;
    const cancel = commandForm(csrf, "setup.sign_in.cancel", revision, { provider, flowId: signIn.currentFlowId ?? signIn.id }, tr("s14.signin.cancel"));
    const again = (label: string, cls: string) => commandForm(csrf, "setup.sign_in", revision, { provider, flowId: null }, tr(k(label)), cls);
    const other = `<a class="s-btn" href="${context.setup ? "/?change" : "/settings/provider"}">${tr("s14.signin.other")}</a>`;
    let body: string;
    if (state === "pending" && receipt.approval) body = `${approvalBlock(receipt, context.now)}${waitLine(provider)}<div class="s-signin-acts"><a class="s-btn s-nojs" href="${self}">${tr("s14.signin.approved")}</a>${cancel}</div><p class="s-note s-nojs">${tr("s14.signin.approved_note")}</p>`;
    else if (state === "pending" || state === "starting") body = `${banner("", tr(k(`s14.signin.${state}_title`)), tr(k(`s14.signin.${state}_detail`)))}<div class="s-signin-acts"><a class="s-btn primary s-nojs" href="${self}">${tr("s14.signin.check")}</a>${cancel}</div>`;
    else if (state === "ready") body = `${banner("ok", filled("s14.signin.ready_title", provider), tr("s14.signin.ready_detail"))}<div class="s-signin-acts"><a class="s-btn primary" href="${context.setup ? `/?provider=${e(provider)}` : back}">${tr("s14.signin.continue")}</a></div>`;
    else if (state === "busy") body = `${banner("warn", filled("s14.signin.busy_title", provider), tr("s14.signin.busy_detail"))}<div class="s-signin-acts"><a class="s-btn primary" href="${back}">${tr("s14.signin.continue")}</a>${signIn.currentFlowId ? cancel : ""}</div>`;
    else body = `${banner(state === "expired" || state === "cancelled" ? "" : "warn", filled(`s14.signin.${state}_title`, provider), tr(k(`s14.signin.${state}_detail`)))}<div class="s-signin-acts">${again(retryAction[state]!, "s-btn primary")}${other}</div>`;
    const live = state === "pending" || state === "starting" ? ` data-sign-in="${e(`/api/s14/sign-in/${provider}/${signIn.id}`)}" data-sign-in-page="${self}"` : "";
    return standalone(title, `${context.setup ? steps("connect") : ""}<div class="s-setup-card"${live}><h1>${e(title)}</h1>${body}</div>`);
  }));
}
/** Binds the Opus-authored auth pages to one application. Reads are display data; the handler keeps every capability, session and CSRF check. */
export function createS14Auth(app: S14Application): S14AuthRenderer {
  const ownerExists = () => !!app.store.read(tx => tx.get("SELECT id FROM owner"));
  const inSetup = () => !app.store.read(tx => tx.get<{ profile_json: string | null }>("SELECT profile_json FROM installation"))?.profile_json;
  return {
    ownerSetup: (csrf, locale, code = null) => renderOwnerSetup(csrf, locale, code),
    ownerSetupRefused: (code, locale) => renderOwnerSetupRefused(code, locale, ownerExists(), ownerTheme(app)),
    signIn: (receipt, csrf, revision, locale) => renderSignIn(receipt, csrf, revision, locale, { now: app.now(), setup: inSetup(), theme: ownerTheme(app) }),
  };
}
