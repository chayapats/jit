import { currentLocale, tr, trMaybe } from "../../i18n";
import { loginCard, type S15BrowserInfo, type S15BrowserProgress } from "./browser";
import { banner, codeText, e, fill, form, hidden, key, notYet, pill, refusal } from "./render";
import type { S15ApprovedWebsite, S15WebsiteEngine } from "./types";

/** A confirmed change, shown only when the current list agrees with it (a crafted link cannot fake one). */
export type S15WebsitesSaved = { kind: "added" | "removed"; origin: string } | { kind: "retried" } | null;
const engineSteps = ["verify", "download", "checksum", "extract", "libraries"] as const;

/** Date of an approval in the owner's language (Thai uses its own calendar); UTC keeps renders identical. */
function day(value: number): string {
  const date = new Date(value); if (!Number.isFinite(date.valueOf())) return "";
  const text = new Intl.DateTimeFormat(currentLocale() === "en" ? "en-GB" : "th-TH", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(date);
  return `<time datetime="${date.toISOString()}">${e(text)}</time>`;
}
const stepText = (step: string, version: string | null) => tr(key(`s15.websites.step.${step}`)).replace("{version}", version ?? "");
const stepName = (step: string, version: string | null) => e(stepText(step, version));
/** Next step for one engine refusal; every failure names one. */
const nextStep = (code: string) => e(trMaybe(`s15.websites.next.${code}`) ?? tr("s15.websites.next.generic"));

/** Ordered preparation steps; the current one is marked for assistive technology and carries its own word. */
function steps(current: string, mode: "now" | "failed", version: string | null): string {
  const at = engineSteps.indexOf(current as typeof engineSteps[number]);
  return `<ol class="s15-provision-steps" aria-label="${tr("s15.websites.steps_label")}">${engineSteps.map((step, index) => {
    const state = index < at ? "done" : index === at ? mode : null;
    const mark = state === "done" ? pill(tr("s15.provision.state.done"), "ok", "✓") : state === "now" ? pill(tr("s15.provision.state.now"), "strong", "") : state === "failed" ? pill(tr("s15.provision.state.failed"), "danger", "×") : "";
    return `<li${index === at ? ' aria-current="step"' : ""} data-state="${state ?? "todo"}"><span class="s-grow">${stepName(step, version)}</span>${mark}</li>`;
  }).join("")}</ol>`;
}

/**
 * Protected browser status from the pinned Chromium's own provisioning: ready with its verified version,
 * preparing with the current step (the page refreshes itself, never while the owner types), or failed with
 * the step, the reason, a missing library by name, the next step and Try again. Nothing is inferred.
 */
function engineCard(engine: S15WebsiteEngine, csrf: string, retried: boolean): string {
  let body: string;
  if (engine.state === "ready") {
    body = `<p class="s-row">${pill(tr("s15.websites.engine_ready"), "ok", "✓")}<span class="s-meta">${fill("s15.websites.engine_version", { version: engine.version })}</span></p>`;
  } else if (engine.state === "provisioning") {
    body = `<div role="status" data-s15-refresh="5">${retried ? banner("ok", tr("s15.websites.retry_started")) : ""}<p class="s-row"><b class="s-grow">${tr("s15.websites.engine_preparing")}</b>${pill(tr("s15.provision.state.now"), "strong", "")}</p>
      <p class="s-sub">${tr("s15.websites.engine_preparing_lead")}</p>${steps(engine.step, "now", engine.version)}<p><a class="s-link-text" href="/resources/websites#s15-web-engine">${tr("s15.provision.refresh")}</a></p></div>`;
  } else {
    const library = engine.library ? `<p class="s-mono">${fill("s15.websites.missing_library", { library: engine.library })}</p>` : "";
    const retry = engine.code === "browser_host_unsupported" ? "" : form("/s15/forms/websites/retry", csrf, `<div class="s-row"><button class="s-btn primary" aria-describedby="s15-web-retry-note">${tr("s15.websites.retry")}</button></div><p class="s-note" id="s15-web-retry-note">${tr("s15.websites.retry_note")}</p>`);
    body = `<div role="alert">${banner("danger", tr("s15.websites.engine_failed"), codeText(engine.code), `${library}${engine.step ? `<p class="s-meta">${fill("s15.websites.failed_at", { step: stepText(engine.step, engine.version) })}</p>` : ""}<p>${nextStep(engine.code)}</p><p class="s-mono s-meta">${e(engine.code)}</p>`)}</div>
      ${engine.step ? steps(engine.step, "failed", engine.version) : ""}${retry}`;
  }
  return `<section class="s-card" id="s15-web-engine" aria-labelledby="s15-web-engine-title"><h2 id="s15-web-engine-title">${tr("s15.websites.engine_title")}</h2>${body}<p class="s-note">${tr("s15.websites.engine_where")}</p></section>`;
}

/**
 * `/resources/websites` (BROW15-02, F6/F12): the protected browser's status, the websites Jit may read with
 * add and remove, what an approval does and does not allow, and the sign-in handoff for configured sites.
 * Every control is an authenticated no-script form post. A refused entry stays in its field with the reason.
 */
export function websitesBody(input: { engine: S15WebsiteEngine | null; sites: S15ApprovedWebsite[] | null; browsers: { browser: S15BrowserInfo; state: S15BrowserProgress | undefined }[]; csrf: string; saved: S15WebsitesSaved; refused: { code: string; at: "add" | "list" } | null; entry: string }): string {
  const lead = `<p class="s-sub">${tr("s15.websites.lead")}</p>`;
  if (!input.sites || !input.engine) return `<div class="s-col">${lead}${notYet("s15.websites.not_composed")}${signIn(input)}</div>`;
  const saved = input.saved?.kind === "added" ? fill("s15.websites.saved_added", { origin: input.saved.origin }) : input.saved?.kind === "removed" ? fill("s15.websites.saved_removed", { origin: input.saved.origin }) : "";
  const rows = input.sites.length ? `<ul class="s15-accounts" aria-label="${tr("s15.websites.list_title")}">${input.sites.map(site => `<li><div class="s-grow"><p><b class="s-mono s15-break">${e(site.origin)}</b></p><p class="s-meta">${tr("s15.websites.added_on")} ${day(site.addedAt)} · ${tr(site.tier === "trusted" ? "s15.websites.tier_trusted" : "s15.websites.tier_sensitive")}</p></div>
    ${form("/s15/forms/websites/tier", input.csrf, `${hidden("origin", site.origin)}${hidden("revision", site.revision)}${hidden("tier", site.tier === "trusted" ? "sensitive" : "trusted")}<button class="s-btn" aria-label="${fill(site.tier === "trusted" ? "s15.websites.make_sensitive_label" : "s15.websites.make_trusted_label", { origin: site.origin })}">${tr(site.tier === "trusted" ? "s15.websites.make_sensitive" : "s15.websites.make_trusted")}</button>`, ' class="s15-strip-form"')}
    ${form("/s15/forms/websites/remove", input.csrf, `${hidden("origin", site.origin)}${hidden("revision", site.revision)}<button class="s-btn" aria-label="${fill("s15.websites.remove_label", { origin: site.origin })}">${tr("s15.websites.remove")}</button>`, ' class="s15-strip-form"')}</li>`).join("")}</ul>`
    : `<p class="s-sub">${tr("s15.websites.none")}</p>`;
  const add = form("/s15/forms/websites/add", input.csrf, `<label class="s-field"><span>${tr("s15.websites.add_label")}</span><input name="website" type="text" inputmode="url" autocomplete="url" autocapitalize="off" spellcheck="false" required maxlength="2048" value="${e(input.entry)}" placeholder="${tr("s15.websites.add_placeholder")}" aria-describedby="s15-web-add-hint"${input.refused?.at === "add" ? ' aria-invalid="true"' : ""}></label>
    <p class="s-note" id="s15-web-add-hint">${tr("s15.websites.add_hint")}</p><div class="s-row"><button class="s-btn primary">${tr("s15.websites.add")}</button></div>`, ' class="s-stack"');
  const limits = (["read", "no_forms", "private", "public", "trusted"] as const).map(name => `<li>${tr(key(`s15.websites.limit.${name}`))}</li>`).join("");
  return `<div class="s-col">${lead}${engineCard(input.engine, input.csrf, input.saved?.kind === "retried")}
    <section class="s-card" id="s15-web-list" aria-labelledby="s15-web-list-title"><h2 id="s15-web-list-title">${tr("s15.websites.list_title")}</h2>${saved ? `<div role="status">${banner("ok", saved)}</div>` : ""}${input.refused?.at === "list" ? refusal(input.refused.code) : ""}${rows}
      <h3 class="s-section-t" id="s15-web-add">${tr("s15.websites.add_title")}</h3>${input.refused?.at === "add" ? refusal(input.refused.code) : ""}${add}
      <details class="s-more"><summary>${tr("s15.websites.limits_title")}</summary><ul class="s15-list">${limits}</ul></details></section>${signIn(input)}</div>`;
}

/** Sign-in handoff entry point: configured sign-in sites only; nothing here asks for a password. */
function signIn(input: { browsers: { browser: S15BrowserInfo; state: S15BrowserProgress | undefined }[]; csrf: string }): string {
  const sites = input.browsers.length ? input.browsers.map(({ browser, state }) => loginCard(browser, state, input.csrf)).join("") : `<p class="s-sub">${tr("s15.websites.signin_none")}</p>`;
  return `<section class="s-card" aria-labelledby="s15-web-signin"><h2 id="s15-web-signin">${tr("s15.resources.sites_title")}</h2>${sites}<p class="s-note">${tr("s15.resources.sign_in_note")}</p></section>`;
}
