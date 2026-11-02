import { currentLocale, tr, trMaybe, type MessageKey } from "../../i18n";
import { banner, e, icon, pill } from "../../s14/web-pages";
import { s14AssetUrl } from "../../s14/web-assets";
import { logoLockup } from "../../web-logo";
import type { ConversationListEntry } from "../conversation";
import { s15AssetUrl } from "./assets";

export { banner, e, icon, pill };
/** Typed key lookup for computed `s15.*` names; unknown names fall back through {@link trMaybe}. */
export const key = (name: string) => name as MessageKey;

/** Fills `{name}` placeholders with trusted typed values (time, revision, counts, resolved names). The result is escaped. */
export function fill(name: MessageKey, values: Record<string, string | number> = {}): string {
  return e(tr(name).replace(/\{([a-z_]+)\}/g, (all, slot: string) => Object.hasOwn(values, slot) ? String(values[slot]) : all));
}

/** One plain sentence per refusal code: S15 web copy first, then the owning module's existing dictionary entry. */
export function codeText(code: string | null): string {
  if (!code) return tr("s15.code.generic");
  for (const prefix of ["s15.code.", "s15.conversation.", "s15.policy."]) { const text = trMaybe(`${prefix}${code}`); if (text) return text; }
  return tr("s15.code.generic");
}

/** §6 vocabulary: one word per state, with tone and glyph supplementary to the word. */
export type S15State = "received" | "understanding" | "inspecting" | "working" | "waiting_ci" | "waiting_review" | "waiting_schedule" | "waiting_login" | "needs_you" | "question" | "stalled" | "budget_hold" | "partial" | "blocked" | "unsupported" | "unknown" | "failed" | "stopping" | "stopped" | "done" | "changed" | "expired" | "denied";
const tones: Record<S15State, [string, string]> = {
  received: ["", ""], understanding: ["", ""], inspecting: ["strong", ""], working: ["strong", ""], waiting_ci: ["", "◷"], waiting_review: ["", "◷"], waiting_schedule: ["", "◷"],
  waiting_login: ["warn", "!"], needs_you: ["warn", "!"], question: ["warn", "!"], stalled: ["warn", "!"], budget_hold: ["warn", "!"], partial: ["warn", "!"], blocked: ["warn", "!"],
  unsupported: ["", "×"], unknown: ["danger", "?"], failed: ["danger", "×"], stopping: ["", ""], stopped: ["", ""], done: ["ok", "✓"], changed: ["warn", "!"], expired: ["", ""], denied: ["", ""],
};
export const statePill = (state: S15State, id = "") => pill(tr(key(`s15.state.${state}`)), ...tones[state], id);

/** Time of a committed record in the owner's language. UTC keeps no-script and enhanced renders identical. */
export function clock(value: number): string {
  const date = new Date(value); if (!Number.isFinite(date.valueOf())) return "";
  const format = new Intl.DateTimeFormat(currentLocale() === "en" ? "en-GB" : "th-TH", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
  return `<time datetime="${date.toISOString()}">${e(format.format(date))} UTC</time>`;
}
export const clockText = (value: number) => new Intl.DateTimeFormat(currentLocale() === "en" ? "en-GB" : "th-TH", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" }).format(new Date(value));

/** Visual clipping by grapheme, never mid-character; used only for navigation labels, never for exact content. */
export function clip(text: string, graphemes = 40): string {
  const parts = [...new Intl.Segmenter(currentLocale(), { granularity: "grapheme" }).segment(text.replace(/\s+/g, " ").trim())].map(part => part.segment);
  return parts.length > graphemes ? `${parts.slice(0, graphemes).join("")}…` : parts.join("");
}
export const hidden = (name: string, value: string | number) => `<input type="hidden" name="${e(name)}" value="${e(value)}">`;
export const rid = () => crypto.randomUUID().replaceAll("-", "");
/** Same-origin form; every post carries the session CSRF token and a fresh request id. */
export const form = (action: string, csrf: string, body: string, extra = "") => `<form method="post" action="${e(action)}"${extra}>${hidden("csrf", csrf)}${hidden("requestId", rid())}${body}</form>`;
/** A refused post, announced as an alert, with its stable code beneath the sentence. */
export const refusal = (code: string | null, lead = "") => code ? `<div role="alert">${banner("warn", lead || codeText(code), lead ? codeText(code) : "", `<p class="s-mono s-meta">${e(code)}</p>`)}</div>` : "";
/** Feature-detected slice that is not composed in this installation. */
export const notYet = (what: MessageKey) => banner("", tr(what), tr("s15.common.not_available_detail"));

function documentPage(title: string, body: string): string {
  return `<!doctype html><html lang="${currentLocale()}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="dark light"><title>${e(title)} · Jit</title>
    <link rel="stylesheet" href="${s14AssetUrl("app.css")}"><link rel="stylesheet" href="${s14AssetUrl("s14.css")}"><link rel="stylesheet" href="${s15AssetUrl("s15.css")}"><link rel="icon" type="image/svg+xml" href="${s14AssetUrl("favicon.svg")}">
    <link rel="preload" href="${s14AssetUrl("inter.woff2")}" as="font" type="font/woff2" crossorigin><link rel="preload" href="${s14AssetUrl("noto-sans-thai.woff2")}" as="font" type="font/woff2" crossorigin>
    <script type="module" src="${s15AssetUrl("s15.js")}"></script></head><body><a class="skip" href="#main-content">${tr("common.skip_to_main_content")}</a>${body}</body></html>`;
}
/** Stateless page for refusals before a session exists. It carries no authority control. */
export const standalonePage = (title: string, content: string) => documentPage(title, `<main class="s-page" id="main-content">${content}</main>`);

/** Navigation data only; links grant nothing and every page re-reads current state. */
export interface S15Nav { conversations: ConversationListEntry[]; needs: number; current: string }
export interface S15ShellOptions { subtitle?: string; dock?: string; live?: boolean; conversationId?: string; cursor?: number; banner?: string }

/** S15 Plain shell: the S14 sidebar layout without Work mode, grants or per-Bot computers. */
export function shell(nav: S15Nav, title: string, content: string, options: S15ShellOptions = {}): string {
  const here = (path: string) => nav.current === path ? ' aria-current="page"' : "";
  const needs = `<a class="s-link" href="/needs"${here("/needs")}>${icon(nav.needs ? "alert" : "check")}<span class="s-label">${tr("s15.nav.needs")}</span><span class="s15-needs-count" data-needs-count>${nav.needs ? `<span class="s-nav-number">${nav.needs}</span>` : ""}</span></a>`;
  const chats = nav.conversations.map(item => `<li><a class="s-link s-chat-link" href="/chats/${e(item.conversationId)}#latest"${here(`/chats/${item.conversationId}`)}><span class="s-label">${e(clip(item.firstMessage))}</span></a></li>`).join("");
  const manage = ([["/memory", "s15.nav.memory"], ["/resources/computer", "s15.nav.computer"], ["/models", "s15.nav.models"], ["/setup", "s15.nav.setup"]] as const)
    .map(([path, label]) => `<li><a class="s-link" href="${path}"${here(path)}><span class="s-label">${tr(label)}</span></a></li>`).join("");
  const navigation = (mobile: boolean) => `<nav aria-label="${tr("s15.nav.label")}${mobile ? ` · ${tr("s14.plain.mobile")}` : ""}"><a class="s-link s-new-chat" href="/chats/new">${icon("plus")}<span class="s-label">${tr("s15.nav.new")}</span></a>
    <ul><li>${needs}</li></ul><p class="s-nav-sec">${tr("s15.nav.conversations")}</p><ul class="s-chat-list">${chats || `<li><p class="s-nav-note">${tr("s15.nav.no_conversations")}</p></li>`}</ul>
    <p class="s-nav-sec">${tr("s15.nav.manage")}</p><ul>${manage}</ul></nav>`;
  const side = `<aside class="s-nav" aria-label="${tr("s15.nav.label")}"><a class="s-lockup" href="/" aria-label="${tr("s14.jit")}">${logoLockup({ height: 36, label: "Jit" })}</a>${navigation(false)}</aside>`;
  const mobile = `<details class="s-mobile-nav"><summary aria-label="${tr("s14.plain.navigation")}">${icon("more")}</summary><div class="s-mobile-panel">${navigation(true)}</div></details>`;
  const count = `<a class="s-needs" href="/needs">${icon(nav.needs ? "alert" : "check")}<span>${tr("s15.nav.needs")}${nav.needs ? ` ${nav.needs}` : ""}</span></a>`;
  return documentPage(title, `<div class="s-app s15-app"${options.conversationId ? ` data-conversation="${e(options.conversationId)}" data-cursor="${options.cursor ?? 0}"` : ""}>${side}<main class="s-main" id="main-content"><div class="s-chatcol"><header class="s-hdr">${mobile}<div class="s-hdr-t"><h1>${e(title)}</h1>${options.subtitle ? `<small>${e(options.subtitle)}</small>` : ""}</div>${count}</header>
    <div id="s15-banner" data-region>${options.banner ?? ""}</div><div class="s-scroll"${options.live ? ' data-live="true"' : ""}>${content}</div>${options.dock ?? ""}</div></main>
    <p class="sr-only" role="status" aria-live="polite" id="s15-phase" data-working="${tr("s15.live.working")}" data-needs="${tr("s15.live.needs_one")}" data-done="${tr("s15.live.done")}" data-reconnected="${tr("s15.recovery.reconnected")}" data-reset="${tr("s15.recovery.reset")}"></p><p class="sr-only" aria-live="polite" id="s15-needs-live">${nav.needs ? fill("s15.live.needs", { n: nav.needs }) : ""}</p></div>`);
}
