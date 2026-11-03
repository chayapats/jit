import { tr } from "../../i18n";
import type { LoginState } from "../browser";
import { banner, codeText, e, fill, form, hidden, icon, pill, statePill } from "./render";
import type { S15WebBrowser } from "./types";

/** Trusted registration facts a page may show; never the owner port itself. */
export type S15BrowserInfo = Pick<S15WebBrowser<never>, "id" | "site" | "twoFactor" | "fields">;

/**
 * UX15-03 protected browser handoff (handoff F6, §9 takeover). Sign-in state comes only from the protected browser's
 * own observations (hand-back result, session check), never from a button press or page text. The owner's input
 * goes to the protected browser and is never rendered, stored or echoed by these pages.
 */
/** `handBack` is the browser generation returned by the hand-back that produced this state; a later check may only update that same hand-back. */
export interface S15BrowserProgress { generation: number | null; login: LoginState | null; at: number; handBack?: number }
/** Sites that wait on the owner: in owner control, checking, or observed as not (or not provably) signed in after a handoff. */
export const browserNeedsYou = (state: S15BrowserProgress | undefined) => !!state?.login && ["owner_control", "checking", "not_signed_in", "unknown"].includes(state.login);

const loginLine = (login: LoginState | null): string => {
  switch (login) {
    case "checking": return tr("s15.browser.checking");
    case "signed_in": return tr("s15.browser.login_no_power");
    case "not_signed_in": return tr("s15.browser.not_signed_in");
    case "cancelled": return tr("s15.browser.cancelled_continue");
    case "unknown": return tr("s15.browser.login_unknown");
    case "owner_control": return tr("s15.browser.driving");
    default: return "";
  }
};

/** LoginHandoffCard: opens the protected view in takeover. No text field lives inside Jit's own conversation page. */
export function loginCard(browser: S15BrowserInfo, state: S15BrowserProgress | undefined, csrf: string, conversationId: string | null = null): string {
  const login = state?.login ?? null, site = browser.site;
  const heading = fill(browser.twoFactor ? "s15.browser.two_factor" : "s15.browser.login", { site });
  const open = form("/s15/forms/browser/takeover", csrf, `${hidden("site", browser.id)}<button class="s-btn primary">${tr(login === "not_signed_in" || login === "unknown" ? "s15.browser.try_again" : "s15.browser.open_login")}</button>`);
  const skip = conversationId ? `<a class="s-btn" href="/chats/${e(conversationId)}?skip=${e(browser.id)}#s15-text">${tr("s15.browser.skip_site")}</a>` : "";
  const resume = login === "owner_control" && state?.generation !== null ? `<a class="s-btn primary" href="/browser/${e(browser.id)}">${tr("s15.browser.back_to_view")}</a>` : "";
  const actions = login === "checking" ? "" : login === "signed_in" || login === "cancelled" ? "" : resume || `${open}${skip}`;
  const tone = login === "signed_in" ? "ok" : login === "not_signed_in" || login === "unknown" ? "warn" : "";
  return `<section class="s15-login" aria-labelledby="s15-login-${e(browser.id)}"><p class="s-row"><b class="s-grow" id="s15-login-${e(browser.id)}">${e(heading)}</b>${statePill(login === "signed_in" ? "done" : login === "cancelled" ? "stopped" : login === "unknown" ? "unknown" : "waiting_login")}</p>
    ${login ? `<div role="status">${banner(tone, loginLine(login))}</div>` : `<p class="s-sub">${tr("s15.browser.login_lead")}</p>`}${login === "checking" ? `<p class="s-note">${tr("s15.browser.checking_note")}</p>` : ""}${actions ? `<div class="s-strip-acts">${actions}</div>` : ""}<p class="s-note">${tr("s15.browser.waiting_not_stalled")}</p></section>`;
}

/** Protected takeover view: bar first with hand-back, then the latest frame with a text alternative, then owner input. */
export function takeoverView(browser: S15BrowserInfo, state: S15BrowserProgress, csrf: string, refused: string | null): string {
  const generation = state.generation!;
  const bar = `<div class="s-screen-bar s15-takeover-bar" id="s15-takeover-bar" tabindex="-1" role="region" aria-label="${tr("s15.browser.driving")}">${icon("lock")}<b class="s-grow">${tr("s15.browser.driving")}</b>
    ${form("/s15/forms/browser/handback", csrf, `${hidden("site", browser.id)}${hidden("generation", generation)}<button class="s-btn primary">${tr("s15.browser.hand_back")}</button>`)}
    ${form("/s15/forms/browser/cancel", csrf, `${hidden("site", browser.id)}${hidden("generation", generation)}<button class="s-btn">${tr("s15.browser.cancel_login")}</button>`)}</div>`;
  const alt = fill("s15.browser.frame_alt", { site: browser.site });
  const frame = `<figure class="s15-frame"><img src="/browser/${e(browser.id)}/frame?g=${generation}" alt="${e(alt)}" width="1280" height="800"><figcaption class="s-meta">${tr("s15.untrusted.web")}</figcaption></figure>`;
  const fields = browser.fields.length ? browser.fields.map(field => field.kind === "click"
    ? form("/s15/forms/browser/input", csrf, `${hidden("site", browser.id)}${hidden("generation", generation)}${hidden("field", field.name)}<button class="s-btn">${fill("s15.browser.press", { label: field.label })}</button>`)
    : form("/s15/forms/browser/input", csrf, `${hidden("site", browser.id)}${hidden("generation", generation)}${hidden("field", field.name)}<label class="s-field"><span>${e(field.label)}</span><input name="value" type="${field.secret ? "password" : "text"}" autocomplete="${field.secret ? "current-password" : "username"}" maxlength="2000" required></label><button class="s-btn">${tr("s15.browser.type_here")}</button>`, ' class="s-stack"')).join("")
    : `<p class="s-sub">${tr("s15.browser.no_fields")}</p>`;
  return `<div class="s-col"><div class="s-screen s15-takeover" data-driver="owner">${bar}${refused ? `<div role="alert">${banner("warn", codeText(refused), "", `<p class="s-mono s-meta">${e(refused)}</p>`)}</div>` : ""}${frame}
    <div class="s-slip-body"><p class="s-note">${tr("s15.browser.private_input")}</p>${fields}<p class="s-note">${tr("s15.browser.no_esc")}</p></div></div></div>`;
}

/** LimitNotice: names the boundary and offers the owner's own way forward. Never styled as a slip, never approve-looking. */
export function limitNotice(code: string | null, conversationId: string, requestId: string, browser: S15BrowserInfo | null, csrf: string): string {
  const reason = code === "upload_unsupported" ? tr("s15.browser.no_upload") : codeText(code);
  const takeover = browser ? form("/s15/forms/browser/takeover", csrf, `${hidden("site", browser.id)}<button class="s-btn">${tr("s15.browser.do_it_myself")}</button>`) : "";
  // BROW15-02: an unlisted website is resolved by the owner adding it; an unready browser shows its own status.
  const website = code === "website_not_approved" ? `<a class="s-btn primary" href="/resources/websites#s15-web-add">${tr("s15.websites.add_from_limit")}</a>` : code?.startsWith("browser_") ? `<a class="s-btn" href="/resources/websites#s15-web-engine">${tr("s15.websites.status_from_limit")}</a>` : "";
  return `<div class="s15-limit" role="note">${pill(tr("s15.state.unsupported"), "", "×")}<p class="s15-text">${fill("s15.browser.limit", { reason })}</p><div class="s-strip-acts">${website}${takeover}<a class="s-btn" href="/chats/${e(conversationId)}?skip_step=${e(requestId)}#s15-text">${tr("s15.browser.skip_step")}</a></div>
    <details class="s-more"><summary>${tr("s15.browser.details")}</summary><p class="s-mono s-meta">${e(code ?? "")}</p><p class="s-note">${tr("s15.browser.limit_note")}</p></details></div>`;
}
