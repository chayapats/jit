import { tr, withLocale, type Locale } from "../i18n";
import { logoLockup } from "../web-logo";
import { googleScope } from "./personal-protocol";
import type { PersonalClient, PersonalConnection, PersonalReceipt, PersonalScope } from "./personal-types";
import type { S14Page } from "./web";
import { reach } from "./web-memory";
import { announced, banner, botName, commandForm, e, flat, hidden, k, notice, ownerStrip, pill, remaining, shell, standalone, tile, when, withTheme } from "./web-pages";
import { canRead, canWrite, type S14AccountBot, type S14GoogleConnection, type S14GoogleGuide, type S14GoogleHome, type S14GoogleNew, type S14GoogleRedirect, type S14PersonalSurface } from "./web-product-personal";
import { draftEditPage } from "./web-personal-effect";
import type { ThemePreference } from "../web-layout";

/* Google account setup (LIFE14-01). Every installation owns its Google client, so setup is a guide in numbered pages rather than a button. The client secret is write-only: no renderer here receives it. Account and calendar text is escaped data, and no button label carries it. */
const pages = "s14.google.nav.subtitle" as const;
const console_ = {
  project: "https://console.cloud.google.com/projectcreate",
  gmail: "https://console.cloud.google.com/apis/library/gmail.googleapis.com",
  calendar: "https://console.cloud.google.com/apis/library/calendar-json.googleapis.com",
  auth: "https://console.cloud.google.com/auth/overview",
  scopes: "https://console.cloud.google.com/auth/scopes",
  audience: "https://console.cloud.google.com/auth/audience",
  clients: "https://console.cloud.google.com/auth/clients",
  account: "https://myaccount.google.com/connections",
} as const;
const scopesAll: PersonalScope[] = ["gmail.readonly", "gmail.send", "calendar.readonly", "calendar.events"];
const steps = ["start", "project", "apis", "consent", "client", "paste"] as const;
const outside = (href: string, label: string, cls = "s-btn") => `<a class="${cls}" href="${e(href)}" target="_blank" rel="noopener noreferrer">${e(label)} <span class="sr-only">${tr("s14.google.new_tab")}</span></a>`;
/** A value the owner copies into Google. It is selectable text without script, and the button appears only when the clipboard works. */
const copyRow = (id: string, label: string, value: string) => `<div class="s-copy"><p class="s-exact-label" id="${id}-label">${e(label)}</p><div class="s-copy-row"><code class="s-exact" id="${id}">${e(value)}</code><button type="button" class="s-btn" hidden data-copy data-copy-target="${id}" data-copied="${tr("s14.google.copied")}" aria-describedby="${id}-label">${tr("s14.google.copy")}</button></div></div>`;
const words = (keys: string[]) => `<ol class="s-guide-do">${keys.map(key => `<li>${tr(k(key))}</li>`).join("")}</ol>`;

/** The word for a connection, the same on every surface. */
function statePill(connection: PersonalConnection): string {
  const tone: Record<PersonalConnection["state"], [string, string]> = { configured: ["", ""], authorizing: ["strong", ""], connected: ["strong", "✓"], reauth_required: ["warn", "!"], revoked: ["", ""] };
  return pill(tr(k(`s14.google.state.${connection.state}`)), ...tone[connection.state]);
}
const serviceWord = (service: PersonalConnection["service"]) => tr(k(`s14.google.service.${service}`));
/** Account identity in words: a typed name never reads as checked. */
export function accountFact(connection: Pick<PersonalConnection, "account" | "accountVerification">, verifiedAt: number | null = null): string {
  const checked = connection.accountVerification === "gmail_profile";
  return `<span class="s-mono">${e(connection.account)}</span> ${pill(tr(checked ? "s14.google.account.checked" : "s14.google.account.typed"), checked ? "strong" : "warn", checked ? "✓" : "!")}${checked && verifiedAt ? `<br><span class="s-note">${tr("s14.google.account.checked_at")} ${when(verifiedAt)}</span>` : ""}`;
}
function scopeRows(connection: PersonalConnection): string {
  const row = (scope: PersonalScope) => `<li><span>${tr(k(`s14.google.scope.${scope}`))}</span><span class="s-mono s-meta">${e(scope)}</span></li>`;
  const absent = canWrite(connection) ? "" : `<li class="s-google-no">${tr(k(`s14.google.no_write.${connection.service}`))}</li>`;
  return `<ul class="s-google-scopes">${connection.scopes.map(row).join("")}${absent}</ul>`;
}
const addressBanner = (redirect: S14GoogleRedirect) => redirect.address === "https" ? "" : banner("warn", tr(k(`s14.google.address.${redirect.address}`)), tr(k(`s14.google.address.${redirect.address}_detail`)));
/** A saved client whose address differs from this installation's cannot complete a sign-in, so it is said before anyone tries. */
const driftBanner = (client: PersonalClient | null, redirect: S14GoogleRedirect) => client && client.redirectUri !== redirect.uri ? banner("warn", tr("s14.google.address.changed"), tr("s14.google.address.changed_detail"), `<pre class="s-exact">${e(client.redirectUri)}</pre>`) : "";

/** Receipt words are chosen from the stored kind, and the words never claim working consent. */
function landing(receipt: PersonalReceipt | null): string {
  if (!receipt) return "";
  if (receipt.kind === "personal.oauth.begin") return "";
  if (receipt.kind === "personal.grant.set") return announced(banner("", tr(receipt.grant?.active ? "s14.google.done.grant" : "s14.google.done.grant_off"), tr(receipt.grant?.active ? "s14.google.done.grant_detail" : "s14.google.done.grant_off_detail")));
  const name = receipt.kind.slice("personal.".length).replaceAll(".", "_");
  return announced(banner("", tr(k(`s14.google.done.${name}`)), tr(k(`s14.google.done.${name}_detail`))));
}

function connectionRow(connection: PersonalConnection): string {
  const reach = connection.scopes.map(scope => tr(k(`s14.google.scope_short.${scope}`))).join(" · ");
  return `<a class="s-work-row" href="/settings/google/connections/${e(connection.id)}"><span><span>${e(serviceWord(connection.service))} · <span class="s-mono">${e(connection.account)}</span></span><small>${e(reach)}</small></span>${statePill(connection)}</a>`;
}
const addLinks = (primary: boolean) => `<p class="s-row"><a class="s-btn${primary ? " primary" : ""}" href="/settings/google/new?service=gmail">${tr("s14.google.add_gmail")}</a><a class="s-btn" href="/settings/google/new?service=calendar">${tr("s14.google.add_calendar")}</a></p>`;
function briefLink(view: S14GoogleHome): string {
  const ready = view.read.grants.some(grant => grant.active && view.read.connections.some(item => item.id === grant.connectionId && item.state === "connected" && canRead(item)));
  return ready ? `<section class="s-card s-stack" aria-labelledby="s14-google-brief"><h2 id="s14-google-brief">${tr("s14.google.brief.title")}</h2><p class="s-sub">${tr("s14.google.brief.lead")}</p><p><a class="s-btn" href="/routines/new?brief=1">${tr("s14.google.brief.open")}</a></p></section>` : "";
}
function clientCard(view: S14GoogleHome): string {
  const client = view.read.client!;
  return `<details class="s-card s-more"><summary>${tr("s14.google.client.title")}</summary><div><dl class="s-kv"><dt>${tr("s14.google.client.id")}</dt><dd class="s-mono">${e(client.clientId)}</dd><dt>${tr("s14.google.client.secret")}</dt><dd>${tr("s14.google.client.secret_stored")}</dd><dt>${tr("s14.google.client.redirect")}</dt><dd class="s-mono">${e(client.redirectUri)}</dd><dt>${tr("s14.google.client.state")}</dt><dd>${tr("s14.google.client.unverified")}</dd><dt>${tr("s14.bot.revision")}</dt><dd class="s-mono">r${client.revision}</dd></dl><p><a class="s-link-text" href="/settings/google/guide?step=1">${tr("s14.google.client.guide_again")}</a></p></div></details>`;
}
function homePage(page: S14Page, view: S14GoogleHome): string {
  const { client, connections } = view.read, open = connections.filter(item => item.state !== "revoked"), ended = connections.filter(item => item.state === "revoked");
  const needs = page.overview.personal?.needs ?? [], first = needs[0], hero = !client
    ? `<section class="s-card s-stack" aria-labelledby="s14-google-start"><h2 id="s14-google-start">${tr("s14.google.home.start_title")}</h2><p class="s-sub">${tr("s14.google.home.start_lead")}</p><p class="s-note">${tr("s14.google.honest.why")}</p><p><a class="s-btn primary" href="/settings/google/guide?step=1">${tr("s14.google.home.start")}</a></p></section>`
    : first ? `<section class="s-card s-stack" aria-labelledby="s14-google-next"><h2 id="s14-google-next">${tr(k(`s14.google.need.${first.need}`))}</h2><p class="s-sub">${e(serviceWord(first.service))} · <span class="s-mono">${e(first.account)}</span></p><p><a class="s-btn primary" href="/settings/google/connections/${e(first.connectionId)}#next">${tr("s14.google.need.open")}</a></p></section>`
    : !open.length ? `<section class="s-card s-stack" aria-labelledby="s14-google-next"><h2 id="s14-google-next">${tr("s14.google.home.connect_title")}</h2><p class="s-sub">${tr("s14.google.home.connect_lead")}</p>${addLinks(true)}</section>` : "";
  const list = open.length ? `<section class="s-stack" aria-labelledby="s14-google-list"><h2 class="s-section-t" id="s14-google-list">${tr("s14.google.list")}</h2><div>${open.map(connectionRow).join("")}</div>${addLinks(false)}</section>` : "";
  const closed = ended.length ? `<details class="s-card s-more"><summary>${tr("s14.google.revoked_list")}: ${ended.length}</summary><div>${ended.map(connectionRow).join("")}</div></details>` : "";
  return shell(page, tr("s14.google.title"), `<div class="s-col">${landing(view.receipt)}${notice(view.notice)}${driftBanner(client, view.redirect)}${hero}${list}${briefLink(view)}${closed}${client ? clientCard(view) : ""}<p><a class="s-link-text" href="/more">${tr("s14.web.back")}</a></p></div>`, { current: "more", subtitle: tr(pages) });
}

/* The guide. Each step is one page with one thing to do, so a phone can follow it beside the console and Back always works. Jit cannot see Google Cloud, so only the last step records anything. */
const stepList = (current: number) => `<ol class="s-guide-steps" aria-label="${tr("s14.google.guide.steps")}">${steps.map((name, index) => { const number = index + 1, here = number === current; return `<li${here ? ' data-step="current"' : number < current ? ' data-step="past"' : ""}><a href="/settings/google/guide?step=${number}"${here ? ' aria-current="step"' : ""}><span class="s-guide-n">${number}</span><span class="s-guide-name">${tr(k(`s14.google.guide.${name}.short`))}</span></a></li>`; }).join("")}</ol>`;
const startStep = () => `<p>${tr("s14.google.guide.start.lead")}</p>${banner("", tr("s14.google.honest.title"), tr("s14.google.honest.why"))}<div><p class="s-exact-label">${tr("s14.google.guide.start.need_title")}</p>${words(["s14.google.guide.start.need_1", "s14.google.guide.start.need_2", "s14.google.guide.start.need_3"])}</div><p class="s-note">${tr("s14.google.guide.start.after")}</p>`;
const projectStep = () => `${words(["s14.google.guide.project.do_1", "s14.google.guide.project.do_2", "s14.google.guide.project.do_3"])}<p>${outside(console_.project, tr("s14.google.guide.project.open"))}</p><p class="s-note">${tr("s14.google.guide.project.note")}</p>`;
const apisStep = () => `${words(["s14.google.guide.apis.do_1", "s14.google.guide.apis.do_2", "s14.google.guide.apis.do_3"])}<p class="s-row">${outside(console_.gmail, tr("s14.google.guide.apis.gmail"))}${outside(console_.calendar, tr("s14.google.guide.apis.calendar"))}</p><p class="s-note">${tr("s14.google.guide.apis.note")}</p>`;
function warningBlock(): string {
  return `<section class="s-google-warning" aria-labelledby="s14-google-warning"><h3 id="s14-google-warning">${tr("s14.google.warning.title")}</h3><p>${tr("s14.google.warning.what")}</p><p>${tr("s14.google.warning.why")}</p>${words(["s14.google.warning.do_1", "s14.google.warning.do_2", "s14.google.warning.do_3"])}<p class="s-note">${tr("s14.google.warning.stop")}</p></section>`;
}
const consentStep = () => `<section class="s-stack" aria-labelledby="s14-consent-a"><h3 id="s14-consent-a">${tr("s14.google.guide.consent.a_title")}</h3>${words(["s14.google.guide.consent.a_1", "s14.google.guide.consent.a_2", "s14.google.guide.consent.a_3", "s14.google.guide.consent.a_4"])}${copyRow("s14-copy-name", tr("s14.google.guide.consent.app_name"), "Jit")}<p>${outside(console_.auth, tr("s14.google.guide.consent.a_open"))}</p></section>
  <section class="s-stack" aria-labelledby="s14-consent-b"><h3 id="s14-consent-b">${tr("s14.google.guide.consent.b_title")}</h3><p>${tr("s14.google.guide.consent.b_lead")}</p>${scopesAll.map((scope, index) => copyRow(`s14-copy-scope-${index}`, tr(k(`s14.google.scope.${scope}`)), googleScope(scope))).join("")}<p class="s-note">${tr("s14.google.guide.consent.b_note")}</p><p>${outside(console_.scopes, tr("s14.google.guide.consent.b_open"))}</p></section>
  <section class="s-stack" aria-labelledby="s14-consent-c"><h3 id="s14-consent-c">${tr("s14.google.guide.consent.c_title")}</h3><p>${tr("s14.google.guide.consent.c_lead")}</p><p class="s-sub">${tr("s14.google.guide.consent.c_why")}</p><p>${outside(console_.audience, tr("s14.google.guide.consent.c_open"))}</p></section>${warningBlock()}<p class="s-note">${tr("s14.google.guide.consent.workspace")}</p>`;
const clientStep = (redirect: S14GoogleRedirect) => `${addressBanner(redirect)}${words(["s14.google.guide.client.do_1", "s14.google.guide.client.do_2", "s14.google.guide.client.do_3", "s14.google.guide.client.do_4"])}${copyRow("s14-copy-redirect", tr("s14.google.guide.client.redirect"), redirect.uri)}<p class="s-note">${tr("s14.google.guide.client.redirect_note")}</p><p>${outside(console_.clients, tr("s14.google.guide.client.open"))}</p><dl class="s-kv"><dt>${tr("s14.google.client.id")}</dt><dd>${tr("s14.google.guide.client.id_where")}</dd><dt>${tr("s14.google.client.secret")}</dt><dd>${tr("s14.google.guide.client.secret_where")}</dd></dl>`;
function pasteStep(page: S14Page, view: S14GoogleGuide): string {
  if (view.client && view.open) return `${banner("", tr("s14.google.guide.paste.locked"), tr("s14.google.guide.paste.locked_detail"))}<p><a class="s-btn" href="/settings/google">${tr("s14.google.guide.paste.back")}</a></p>`;
  const replace = view.client ? `<p class="s-note">${tr("s14.google.guide.paste.replace")}</p>` : "";
  const form = `<form class="s-stack" method="post" action="/s14/forms/google-client" autocomplete="off">${flat(page.csrf, view.client?.revision ?? 0)}${hidden("redirectUri", view.redirect.uri)}<div class="s-field"><label for="s14-google-id">${tr("s14.google.client.id")}</label><input class="s-mono" id="s14-google-id" name="clientId" required maxlength="260" value="${e(view.clientId)}" autocomplete="off" autocapitalize="off" spellcheck="false" aria-describedby="s14-google-id-note"><span class="s-note" id="s14-google-id-note">${tr("s14.google.guide.paste.id_note")}</span></div><div class="s-field"><label for="s14-google-secret">${tr("s14.google.client.secret")}</label><input id="s14-google-secret" type="password" name="clientSecret" required minlength="8" maxlength="1024" autocomplete="new-password" spellcheck="false" aria-describedby="s14-google-secret-note"><span class="s-note" id="s14-google-secret-note">${tr("s14.google.guide.paste.secret_note")}</span></div><dl class="s-kv"><dt>${tr("s14.google.client.redirect")}</dt><dd class="s-mono">${e(view.redirect.uri)}</dd></dl><div><button class="s-btn primary">${tr("s14.google.guide.paste.save")}</button></div></form>`;
  return `${addressBanner(view.redirect)}${replace}${form}<p class="s-note">${tr("s14.google.guide.paste.after")}</p>`;
}
function guidePage(page: S14Page, view: S14GoogleGuide): string {
  const name = steps[view.step - 1]!, body = name === "start" ? startStep() : name === "project" ? projectStep() : name === "apis" ? apisStep() : name === "consent" ? consentStep() : name === "client" ? clientStep(view.redirect) : pasteStep(page, view);
  const back = view.step > 1 ? `<a class="s-btn" href="/settings/google/guide?step=${view.step - 1}">${tr("s14.google.guide.back")}</a>` : `<a class="s-btn" href="/settings/google">${tr("s14.google.guide.leave")}</a>`;
  const forward = view.step < steps.length ? `<a class="s-btn primary" href="/settings/google/guide?step=${view.step + 1}">${tr(k(`s14.google.guide.${name}.next`))}</a>` : "";
  return shell(page, tr("s14.google.guide.title"), `<div class="s-col">${stepList(view.step)}${notice(view.notice)}<section class="s-card s-stack s-guide" aria-labelledby="slip"><p class="s-meta">${tr("s14.google.guide.step")} ${view.step} / ${steps.length}</p><h2 id="slip" tabindex="-1" data-focus-on-load>${tr(k(`s14.google.guide.${name}.title`))}</h2>${body}</section><div class="s-between">${back}${forward}</div></div>`, { current: "more", subtitle: tr(pages) });
}

function newPage(page: S14Page, view: S14GoogleNew): string {
  const { service, draft } = view, read = service === "gmail" ? "gmail.readonly" : "calendar.readonly", write = service === "gmail" ? "gmail.send" : "calendar.events";
  if (!view.client) return shell(page, tr(k(`s14.google.new.title_${service}`)), `<div class="s-col">${banner("", tr("s14.google.new.no_client"), tr("s14.google.new.no_client_detail"))}<p><a class="s-btn primary" href="/settings/google/guide?step=1">${tr("s14.google.home.start")}</a></p></div>`, { current: "more", subtitle: tr(pages) });
  const consent = (name: string, scope: string, checked: boolean, kind: "read" | "write") => `<label class="s-choice s-google-consent" data-consent="${kind}"><input type="checkbox" name="${name}" value="on"${checked ? " checked" : ""}><span><b>${tr(k(`s14.google.scope.${scope}`))}</b><small>${tr(k(`s14.google.scope_note.${scope}`))}</small><small class="s-mono">${e(scope)}</small></span></label>`;
  const calendar = service === "calendar" ? `<div class="s-field"><label for="s14-google-calendar">${tr("s14.google.new.calendar")}</label><input class="s-mono" id="s14-google-calendar" name="calendarId" required maxlength="256" value="${e(draft.calendarId)}" autocomplete="off" autocapitalize="off" spellcheck="false" aria-describedby="s14-google-calendar-note"><span class="s-note" id="s14-google-calendar-note">${tr("s14.google.new.calendar_note")}</span></div>` : "";
  const form = `<form class="s-stack" method="post" action="/s14/forms/google-connection" novalidate>${flat(page.csrf, 0)}${hidden("service", service)}<div class="s-field"><label for="s14-google-account">${tr("s14.google.new.account")}</label><input class="s-mono" id="s14-google-account" name="account" type="email" required maxlength="254" value="${e(draft.account)}" autocomplete="email" autocapitalize="off" spellcheck="false" aria-describedby="s14-google-account-note"><span class="s-note" id="s14-google-account-note">${tr(k(`s14.google.new.account_note_${service}`))}</span></div>${calendar}<fieldset class="s-field"><legend>${tr("s14.google.new.read_legend")}</legend>${consent("consent_read", read, draft.read, "read")}</fieldset><fieldset class="s-field"><legend>${tr("s14.google.new.write_legend")}</legend>${consent("consent_write", write, draft.write, "write")}<p class="s-note">${tr(k(`s14.google.new.write_note_${service}`))}</p></fieldset><div><button class="s-btn primary">${tr("s14.google.new.save")}</button></div></form>`;
  return shell(page, tr(k(`s14.google.new.title_${service}`)), `<div class="s-col">${notice(view.notice)}${banner("", tr("s14.google.new.separate"), tr("s14.google.new.separate_detail"))}<section class="s-card s-stack" aria-label="${tr(k(`s14.google.new.title_${service}`))}">${form}</section><p><a class="s-link-text" href="/settings/google">${tr("s14.google.back")}</a></p></div>`, { current: "more", subtitle: tr(pages) });
}

/** The single next action for this connection. Anything after Google stays one form press, because exchange needs the owner's session. */
function nextCard(page: S14Page, view: S14GoogleConnection): string {
  const { connection: c, step } = view, begin = (label: string) => commandForm(page.csrf, "personal.oauth.begin", c.revision, { connectionId: c.id }, label, "s-btn primary");
  const card = (title: string, body: string, strip = "", tone = "closed") => `<article class="s-slip" id="next" data-state="${tone}" aria-labelledby="slip"><div class="s-slip-hd"><div><h2 id="slip" tabindex="-1" data-focus-on-load>${title}</h2></div>${statePill(c)}</div><div class="s-slip-body">${body}</div>${strip}</article>`;
  const prepare = `${words(["s14.google.signin.do_1", "s14.google.signin.do_2", "s14.google.signin.do_3"])}${warningBlock()}`;
  if (c.state === "configured") return card(tr("s14.google.signin.title"), `<p class="s-sub">${tr("s14.google.signin.lead")}</p>${prepare}`, ownerStrip(begin(tr("s14.google.signin.begin")), tr("s14.google.signin.begin_note")), "pending");
  if (c.state === "reauth_required") return card(tr("s14.google.again.title"), `${banner("warn", tr("s14.google.again.lead"), tr("s14.google.again.detail"))}<div><p class="s-exact-label">${tr("s14.google.again.causes")}</p><ul class="s-reach-list"><li>${tr("s14.google.again.cause_1")}</li><li>${tr("s14.google.again.cause_2")}</li><li>${tr("s14.google.again.cause_3")}</li><li>${tr("s14.google.again.cause_4")}</li></ul></div>${prepare}`, ownerStrip(begin(tr("s14.google.again.begin")), tr("s14.google.signin.begin_note")), "pending");
  if (c.state !== "authorizing") return "";
  if (step.step === "open") return card(tr("s14.google.open.title"), `<p class="s-sub">${tr("s14.google.open.lead")}</p><p class="s-note">${tr("s14.google.open.ends")} ${remaining(step.expiresAt, page.now)}</p>`, ownerStrip(`<a class="s-btn primary" href="${e(step.url)}" rel="noreferrer">${tr("s14.google.open.go")}</a>`, tr("s14.google.open.note")), "pending");
  if (step.step === "finish") return card(tr("s14.google.finish.title"), `<p class="s-sub">${tr("s14.google.finish.lead")}</p><p class="s-note">${tr("s14.google.open.ends")} ${remaining(step.expiresAt, page.now)}</p>`, ownerStrip(`<form method="post" action="/s14/personal/oauth/complete">${hidden("csrf", page.csrf)}${hidden("flowId", step.flowId)}<button class="s-btn primary">${tr("s14.google.finish.go")}</button></form>`, tr("s14.google.finish.note")), "pending");
  if (step.step === "exchanging") return card(tr("s14.google.exchanging.title"), `<p class="s-sub">${tr("s14.google.exchanging.lead")}</p>`);
  return card(tr("s14.google.expired.title"), `<p class="s-sub">${tr("s14.google.expired.lead")}</p>`, ownerStrip(begin(tr("s14.google.again.begin")), tr("s14.google.signin.begin_note")), "pending");
}
function revocationBlock(c: PersonalConnection): string {
  if (c.state !== "revoked") return "";
  return banner(c.revocation === "unknown" ? "warn" : "", tr("s14.google.revoked.title"), `${tr("s14.google.revoked.local")} ${tr(k(`s14.google.revoked.remote_${c.revocation}`))}`, c.revocation === "confirmed" ? "" : `<p>${outside(console_.account, tr("s14.google.revoked.check"), "s-link-text")}</p>`);
}
/** Link that opens a Bot's ceiling with the slot and tools ticked, and comes back here afterwards. It accepts nothing: the owner reads the exact proposal. */
const ceilingHref = (c: PersonalConnection, row: S14AccountBot) => `/team/${e(row.bot.id)}/capabilities?edit=1&amp;account=${e(c.id)}${row.slot ? `&amp;slot=${e(row.slot)}` : ""}${row.tools.length ? `&amp;tools=${e(row.tools.join(","))}` : ""}`;
function botRow(page: S14Page, c: PersonalConnection, row: S14AccountBot): string {
  const set = (active: boolean, label: string, cls: string, scopeId = row.slot!) => commandForm(page.csrf, "personal.grant.set", row.expected, { scopeId, connectionId: c.id, botId: row.bot.id, active }, label, cls);
  const word: Record<S14AccountBot["state"], [string, string, string]> = { granted: ["s14.google.bot.granted", "strong", "✓"], ready: ["s14.google.bot.ready", "", ""], stale: ["s14.google.bot.stale", "warn", "!"], needs_ceiling: ["s14.google.bot.needs_ceiling", "", ""], no_slot: ["s14.google.bot.no_slot", "warn", "!"] };
  const [label, tone, glyph] = word[row.state], addTools = row.tools.length ? `<p class="s-note">${tr("s14.google.bot.tools_missing")} ${row.tools.map(tool => `<span class="s-mono">${e(tool)}</span>`).join(" · ")}</p>` : "";
  const facts = row.slot && row.state !== "needs_ceiling" ? `<p class="s-meta">${tr("s14.google.bot.slot")} <span class="s-mono">${e(row.slot)}</span>${row.grant ? ` · r${row.grant.revision}` : ""}</p>` : "";
  const strip = row.state === "granted" ? ownerStrip(`${set(false, tr("s14.google.bot.stop"), "s-btn")}${row.tools.length ? `<a class="s-btn" href="${ceilingHref(c, row)}">${tr("s14.google.bot.add_ceiling")}</a>` : ""}`, tr(row.tools.length ? "s14.google.bot.ceiling_ends" : "s14.google.bot.stop_note"))
    : row.state === "ready" || row.state === "stale" ? ownerStrip(set(true, tr(row.state === "stale" ? "s14.google.bot.grant_again" : "s14.google.bot.grant"), "s-btn primary"), tr("s14.google.bot.grant_note"))
    : row.state === "needs_ceiling" ? ownerStrip(`<a class="s-btn" href="${ceilingHref(c, row)}">${tr("s14.google.bot.add_ceiling")}</a>`, tr("s14.google.bot.ceiling_note")) : "";
  return `<article class="s-slip" data-state="closed" aria-label="${e(botName(row.bot))}"><div class="s-slip-hd s-google-bot">${tile(row.bot, "", "small")}<div><h3>${e(botName(row.bot))}</h3>${facts}${addTools}</div>${pill(tr(k(label)), tone, glyph)}</div>${row.state === "no_slot" ? `<div class="s-slip-body"><p class="s-note">${tr("s14.google.bot.no_slot_detail")}</p></div>` : ""}${strip}</article>`;
}
function revokeCard(page: S14Page, c: PersonalConnection): string {
  return `<article class="s-slip" data-state="unknown" aria-labelledby="slip"><div class="s-slip-hd"><div><h2 id="slip" tabindex="-1" data-focus-on-load>${tr("s14.google.revoke.title")}</h2><p class="s-meta">${tr("s14.google.revoke.meta")}</p></div>${statePill(c)}</div><div class="s-slip-body"><p><span class="s-mono">${e(c.account)}</span></p>${reach(["s14.google.revoke.does_1", "s14.google.revoke.does_2", "s14.google.revoke.does_3", "s14.google.revoke.does_4"], ["s14.google.revoke.not_1", "s14.google.revoke.not_2", "s14.google.revoke.not_3"])}<p class="s-note">${tr("s14.google.revoke.sibling")}</p></div>${ownerStrip(`${commandForm(page.csrf, "personal.connection.revoke", c.revision, { connectionId: c.id }, tr("s14.google.revoke.confirm"), "s-btn danger")}<a class="s-btn" href="/settings/google/connections/${e(c.id)}">${tr("s14.google.revoke.cancel")}</a>`, tr("s14.google.revoke.note"))}</article>`;
}
function connectionPage(page: S14Page, view: S14GoogleConnection): string {
  const { connection: c } = view, title = `${serviceWord(c.service)}`, back = `<p><a class="s-link-text" href="/settings/google">${tr("s14.google.back")}</a></p>`, options = { current: "more" as const, subtitle: tr(pages), live: view.step.step === "exchanging" };
  if (view.revoke) return shell(page, title, `<div class="s-col">${revokeCard(page, c)}${back}</div>`, options);
  const facts = `<section class="s-card s-stack" aria-labelledby="s14-google-facts"><div class="s-between"><h2 id="s14-google-facts">${tr("s14.google.facts")}</h2>${statePill(c)}</div><dl class="s-kv"><dt>${tr("s14.google.fact.account")}</dt><dd>${accountFact(c, c.verifiedAt)}</dd>${c.calendarId ? `<dt>${tr("s14.google.fact.calendar")}</dt><dd class="s-mono">${e(c.calendarId)}</dd>` : ""}<dt>${tr("s14.google.fact.may")}</dt><dd>${scopeRows(c)}</dd><dt>${tr("s14.bot.revision")}</dt><dd class="s-mono">r${c.revision}</dd></dl>${c.accountVerification === "owner_label" && c.state === "connected" ? `<p class="s-note">${tr(k(`s14.google.account.typed_note_${c.service}`))}</p>` : ""}</section>`;
  const bots = c.state === "connected" ? `<section class="s-stack" aria-labelledby="s14-google-bots"><h2 class="s-section-t" id="s14-google-bots">${tr("s14.google.bots")}</h2><p class="s-sub">${tr("s14.google.bots_lead")}</p>${view.bots.map(row => botRow(page, c, row)).join("")}</section>` : "";
  const end = c.state === "revoked" ? "" : `<p><a class="s-btn danger" href="/settings/google/connections/${e(c.id)}?action=revoke#slip">${tr("s14.google.revoke.open")}</a></p>`;
  return shell(page, title, `<div class="s-col">${landing(view.receipt)}${notice(view.notice)}<div class="s-stack" id="s14-live">${revocationBlock(c)}${nextCard(page, view)}</div>${facts}${bots}${end}${back}</div>`, options);
}
/** Renders the Google settings surfaces. No form here reflects a secret, and every account and Bot name is escaped data. */
export function renderPersonalSurface(page: S14Page, view: S14PersonalSurface): string {
  if (view.kind === "google") return homePage(page, view);
  if (view.kind === "google-guide") return guidePage(page, view);
  if (view.kind === "google-new") return newPage(page, view);
  return view.kind === "google-connection" ? connectionPage(page, view) : draftEditPage(page, view);
}

/** Page after Google, reached without a session. Its address holds no code, and the next navigation starts here, so the same-site session cookie is sent. */
export function renderGoogleReturn(locale: Locale, failed: boolean, theme: ThemePreference): string {
  return withTheme(theme, () => withLocale(locale, () => standalone(tr("s14.google.return.title"), `<div class="s-notice-card"><span class="brand">${logoLockup({ height: 44, label: "Jit" })}</span><h1>${tr(failed ? "s14.google.return.failed" : "s14.google.return.title")}</h1><p>${tr(failed ? "s14.google.return.failed_detail" : "s14.google.return.detail")}</p><p><a class="s-btn primary" href="/settings/google"${failed ? "" : " data-go"}>${tr("s14.google.return.go")}</a></p></div>`)));
}
