import { currentLocale, tr, trMaybe, withLocale, type Locale, type MessageKey } from "../i18n";
import { colorTokens } from "../web-design";
import { logoLockup, logoMark } from "../web-logo";
import type { ThemePreference } from "../web-layout";
import type { Attempt, Effect, Work, WorkView } from "./authority-types";
import type { BotComputer, ComputerActivity, ComputerView } from "./computer-types";
import type { Bot, BotProposal, Conversation, Message, Reply, Route } from "./types";
import { s14AssetUrl } from "./web-assets";
import type { S14Page, S14WebCommand } from "./web";
import { defaultWorkLimits, workLimitBounds, type S14Chat, type S14ComputerSurface, type S14Draft, type S14View, type S14WorkTab } from "./web-product";
import type { S14WorkResearch } from "./web-product-memory";
import { providerSettingsPage, setupPage } from "./web-first-run";
import { renderMemorySurface } from "./web-memory";
import { recoveryNotice, recoveryPanel } from "./web-recovery";
import { evidenceTab, researchNotice, webSettingsPage } from "./web-research";

export const e = (value: unknown) => String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
export const k = (key: string) => key as MessageKey;
const paths = {
  chat: '<path d="M20 11.5a8 8 0 0 1-8 8H5l-3 2 1.5-5A8 8 0 1 1 20 11.5Z"/>', arrow: '<path d="M12 19V5m-6 6 6-6 6 6"/>', back: '<path d="M15 6l-6 6 6 6"/>',
  work: '<path d="M4 6h1.5M4 12h1.5M4 18h1.5M9 6h11M9 12h11M9 18h11"/>', team: '<circle cx="9" cy="9" r="3"/><path d="M3 20v-1a6 6 0 0 1 12 0v1"/><path d="M16 6.5a3 3 0 0 1 0 5.5M18 20v-1a6 6 0 0 0-2.5-4.9"/>',
  more: '<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>', home: '<path d="M4 11l8-7 8 7v9H4Z"/>',
  memory: '<path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3Z"/><path d="M9 9h6M9 13h4"/>', lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>', info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v1"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', alert: '<path d="M12 4 2.5 20h19Z"/><path d="M12 10v5m0 2.5v.5"/>', check: '<path d="m5 12 4 4L19 6"/>', close: '<path d="M6 6l12 12M18 6 6 18"/>', stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
};
export const icon = (name: keyof typeof paths) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
export const rid = () => crypto.randomUUID().replaceAll("-", "");

export function when(value: number): string {
  const date = new Date(value); if (!Number.isFinite(date.valueOf())) return tr("s14.unknown");
  const format = new Intl.DateTimeFormat(currentLocale() === "en" ? "en-GB" : "th-TH", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
  return `<time datetime="${date.toISOString()}">${e(format.format(date))} UTC</time>`;
}
export function remaining(until: number, now: number): string {
  if (until <= now) return tr("s14.time.passed");
  const minutes = Math.ceil((until - now) / 60000);
  return `${tr("s14.time.in")} ${minutes} ${tr("s14.time.minutes")}`;
}
export const size = (bytes: number) => bytes >= 1024 ? `${Math.floor(bytes / 1024)} KiB` : `${bytes} B`;
export const short = (id: string) => id.slice(0, 8);

let activeTheme: ThemePreference = "system";
/** Renders synchronously with the owner's appearance, the same scope rule as `withLocale`. */
export function withTheme<T>(theme: ThemePreference, render: () => T): T {
  const previous = activeTheme;
  activeTheme = theme;
  try { return render(); } finally { activeTheme = previous; }
}
function documentPage(title: string, body: string): string {
  const meta = (theme: "dark" | "light", media: boolean) => `<meta name="theme-color" content="${colorTokens[theme].bg}"${media ? ` media="(prefers-color-scheme: ${theme})"` : ""}>`;
  const colors = activeTheme === "system" ? `${meta("dark", true)}${meta("light", true)}` : meta(activeTheme, false);
  return `<!doctype html><html lang="${currentLocale()}"${activeTheme === "system" ? "" : ` data-theme="${activeTheme}"`}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="${activeTheme === "system" ? "dark light" : activeTheme}">${colors}<title>${e(title)} · Jit</title>
    <link rel="stylesheet" href="${s14AssetUrl("app.css")}"><link rel="stylesheet" href="${s14AssetUrl("s14.css")}"><link rel="icon" type="image/svg+xml" href="${s14AssetUrl("favicon.svg")}">
    <link rel="preload" href="${s14AssetUrl("inter.woff2")}" as="font" type="font/woff2" crossorigin><link rel="preload" href="${s14AssetUrl("noto-sans-thai.woff2")}" as="font" type="font/woff2" crossorigin>
    <script type="module" src="${s14AssetUrl("s14.js")}"></script></head><body><a class="skip" href="#main-content">${tr("common.skip_to_main_content")}</a>${body}</body></html>`;
}

/** Plain stateless page used before a session exists or when a post is refused. */
export const standalone = (title: string, content: string) => documentPage(title, `<main class="s-page" id="main-content">${content}</main>`);
export const banner = (tone: "" | "warn" | "danger" | "ok", title: string, detail = "", extra = "") => `<div class="s-banner ${tone}">${icon(tone === "ok" ? "check" : tone ? "alert" : "info")}<div><p><b>${e(title)}</b></p>${detail ? `<p class="s-sub">${e(detail)}</p>` : ""}${extra}</div></div>`;
export const noticeText = (code: string) => trMaybe(`s14.error.${code}`) ?? tr("s14.error.generic");
export const notice = (code: string | null) => code ? banner("warn", noticeText(code), trMaybe(`s14.next.${code}`) ?? "") : "";

/** The developer path for an installation with no installer link. Collapsed, because it is not the first-run journey. */
export const sourcePath = () => `<details class="s-more"><summary>${tr("s14.login.source_title")}</summary><div><p class="s-note">${tr("s14.login.source_note")}</p><pre class="s-exact">bun src/main.ts setup --s14</pre></div></details>`;
/** Sign-in page; before an owner exists it points at the one-time link instead of a dead form. */
export function renderLogin(locale: Locale, code: string | null, provisioned: boolean, theme: ThemePreference = "system"): string {
  return withTheme(theme, () => withLocale(locale, () => standalone(tr("s14.login.title"), `<div class="auth-card"><span class="brand">${logoLockup({ height: 44, label: "Jit" })}</span><h1>${tr("s14.login.title")}</h1>${provisioned ? `<p>${tr("s14.login.prompt")}</p>
    ${code ? `<div role="alert">${banner("warn", noticeText(code), trMaybe(`s14.next.${code}`) ?? "")}</div>` : ""}<form method="post" action="/s14/login"><label for="s14-password">${tr("s14.login.password")}</label><input id="s14-password" type="password" name="password" required autocomplete="current-password"><button class="primary">${tr("s14.login.submit")}</button></form>`
    : `<p>${tr("s14.login.unprovisioned")}</p><p class="s-note">${tr("s14.login.unprovisioned_note")}</p>${sourcePath()}`}</div>`)));
}
/** Refused post or missing page: the cause in words, then one way forward. No authority control is rendered here. */
export function renderFailure(locale: Locale, code: string, next: string, theme: ThemePreference = "system"): string {
  // Typed computer input is never echoed into a page, so the composer's "your text is kept" must not appear here.
  const forward = () => (next.includes("tab=computer") ? trMaybe(`s14.next.computer.${code}`) : null) ?? trMaybe(`s14.next.${code}`) ?? tr("s14.next.generic");
  return withTheme(theme, () => withLocale(locale, () => standalone(tr("s14.error.title"), `<div class="s-notice-card"><h1>${e(noticeText(code))}</h1><p>${e(forward())}</p><p class="s-mono s-meta">${e(code)}</p><p><a class="s-btn primary" href="${e(next)}">${tr(next === "/s14/login" ? "s14.login.submit" : next === "/" ? "s14.error.home" : "s14.error.open_latest")}</a></p></div>`)));
}
/** S14-AC01 refusal, served with no store, lock or worker open. It cannot change anything, so it has no form. */
export function renderRefusal(locale: Locale, store: string): string {
  return withLocale(locale, () => standalone(tr("s14.legacy.title"), `<div class="s-notice-card"><span class="brand">${logoLockup({ height: 44, label: "Jit" })}</span><h1>${tr("s14.legacy.title")}</h1><p>${tr("s14.legacy.lead")}</p>
    ${banner("ok", tr("s14.legacy.untouched"), tr("s14.legacy.untouched_detail"))}<dl class="s-kv"><dt>${tr("s14.legacy.selected")}</dt><dd class="s-mono">${e(store)}</dd><dt>${tr("s14.legacy.reason")}</dt><dd>${tr("s14.legacy.reason_detail")}</dd></dl>
    <section class="s-stack" aria-labelledby="s14-fresh"><h2 id="s14-fresh">${tr("s14.legacy.fresh_title")}</h2><p class="s-sub">${tr("s14.legacy.fresh_detail")}</p><pre class="s-exact">JIT_S14_DATABASE=.local/s14-fresh/application.sqlite bun src/main.ts setup --s14
JIT_S14_DATABASE=.local/s14-fresh/application.sqlite bun src/main.ts serve --s14</pre></section>
    <section class="s-stack" aria-labelledby="s14-back"><h2 id="s14-back">${tr("s14.legacy.back_title")}</h2><p class="s-sub">${tr("s14.legacy.back_detail")}</p><pre class="s-exact">bun src/main.ts serve</pre></section></div>`));
}

export const hidden = (name: string, value: string | number) => `<input type="hidden" name="${name}" value="${e(value)}">`;
export const flat = (csrf: string, revision: number) => `${hidden("csrf", csrf)}${hidden("requestId", rid())}${hidden("expectedRevision", revision)}`;
/** Fixed-content decision: the exact typed envelope is carried by the seam's no-script path. */
export const commandForm = (csrf: string, kind: S14WebCommand["kind"], expectedRevision: number, payload: object, label: string, cls = "s-btn", extra = "") => `<form method="post" action="/s14/commands"${extra}>${hidden("csrf", csrf)}${hidden("command", JSON.stringify({ kind, requestId: rid(), expectedRevision, payload }))}<button class="${cls}">${e(label)}</button></form>`;
/** The only host for authority buttons. Labels come from the dictionary and typed revisions, never from model text. */
export const ownerStrip = (actions: string, note = "", before = "", after = "") => `<div class="s-strip"><div class="s-strip-label">${icon("lock")}${tr("s14.strip.label")}</div>${before}<div class="s-strip-acts">${actions}</div>${note ? `<p class="s-note">${e(note)}</p>` : ""}${after}</div>`;
/** Plain text only: no links, no Markdown and no controls can come out of this frame. */
export const untrusted = (body: string, label = tr("s14.untrusted.bot")) => `<div class="s-untrusted"><div class="s-untrusted-tag">${e(label)}</div>${body}</div>`;
export const pill = (label: string, tone = "", glyph = "", id = "") => `<span${id ? ` id="${id}"` : ""} class="s-pill ${tone}">${glyph ? `<span aria-hidden="true">${glyph}</span>` : ""}${e(label)}</span>`;

const workTone: Record<Work["state"], [string, string]> = { proposed: ["strong", ""], rejected: ["", ""], accepted: ["", ""], queued: ["", ""], running: ["strong", ""], waiting: ["warn", "!"], ready: ["ok", "✓"], blocked: ["warn", "!"], stopping: ["", ""], stopped: ["", ""] };
const workPill = (state: Work["state"], id = "") => pill(tr(k(`s14.work_state.${state}`)), ...workTone[state], id);
const effectTone: Record<Effect["state"], [string, string]> = { pending: ["warn", "!"], approved: ["strong", ""], denied: ["", ""], expired: ["", ""], executing: ["strong", ""], succeeded: ["ok", "✓"], failed: ["danger", "×"], unknown: ["danger", "?"], changed: ["warn", "!"] };
const effectPill = (state: Effect["state"]) => pill(tr(k(`s14.effect_state.${state}`)), ...effectTone[state]);
const workDot: Partial<Record<Work["state"], string>> = { queued: "hollow", running: "working", waiting: "waiting", ready: "ready", blocked: "waiting", stopping: "hollow" };
const attemptDot: Partial<Record<Attempt["state"], string>> = { running: "working", waiting: "waiting", committed: "ready", interrupted: "failed" };

export const botName = (bot: Pick<Bot, "id" | "name">) => bot.id === "jit" ? tr("s14.jit") : bot.name;
const botDuty = (bot: Pick<Bot, "id" | "responsibility">) => bot.id === "jit" ? tr("s14.jit_duty") : bot.responsibility;
function initial(name: string): string { return [...new Intl.Segmenter(currentLocale(), { granularity: "grapheme" }).segment(name)][0]?.segment ?? "?"; }
/** Tile plus dot. Decorative: the state always appears as a word beside it. */
export function tile(bot: Pick<Bot, "id" | "name">, dot = "", scale = ""): string {
  if (bot.id === "jit") return `<span class="s-tile jit ${scale}" aria-hidden="true"${dot ? ` data-dot="${dot}"` : ""}>${logoMark({ size: scale === "large" ? 56 : 32 })}</span>`;
  return `<span class="s-tile ${scale}" aria-hidden="true"${dot ? ` data-dot="${dot}"` : ""}><i></i>${e(initial(bot.name))}</span>`;
}
const routeText = (route: Route | undefined) => route ? `<span class="s-mono">${e(route.provider)} · ${e(route.model)}</span>` : tr("s14.proposal.no_route");

const needsOwner = (effect: Effect) => effect.state === "pending" || effect.state === "unknown";
/** Everything that needs the owner, counted once for the nav badge and listed on Home and Work. */
function attention(page: S14Page) {
  return { effects: page.overview.effects.filter(needsOwner), proposals: page.state.proposals.filter(p => p.state === "proposed"), tasks: page.work.filter(w => w.state === "proposed") };
}
const attentionCount = (page: S14Page) => { const a = attention(page); return a.effects.length + a.proposals.length + a.tasks.length; };
function attentionList(page: S14Page): string {
  const a = attention(page), botOf = (id: string) => page.state.bots.find(b => b.id === id);
  const items = [
    ...a.effects.map(effect => `<li><a href="/effects/${e(effect.id)}#slip"><span>${e(botName(botOf(effect.botId) ?? { id: effect.botId, name: effect.botId }))} ${tr("s14.effect.asks")} ${e(tr(k(`s14.effect_kind.${effect.action.kind}`)))}</span>${effectPill(effect.state)}</a></li>`),
    ...a.proposals.map(proposal => `<li><a href="/proposals/${e(proposal.id)}"><span>${tr("s14.proposal.attention")} · r${proposal.revision}</span>${pill(tr("s14.work_state.proposed"), "strong")}</a></li>`),
    ...a.tasks.map(task => `<li><a href="/work/${e(task.id)}"><span>${tr("s14.task.attention")} · r${task.revision}</span>${pill(tr("s14.work_state.proposed"), "strong")}</a></li>`),
  ];
  return items.length ? `<ul class="s-attention">${items.join("")}</ul>` : `<p class="s-sub">${tr("s14.attention.none")}</p>`;
}

/** Owner-facing label: the Seam has no chat title, so a Bot's later chats carry their order of creation. Newest comes first in Home. */
export function chatLabel(page: S14Page, conversation: Conversation): string {
  const same = page.state.conversations.filter(item => item.botId === conversation.botId), order = same.length - same.findIndex(item => item.id === conversation.id);
  const bot = page.state.bots.find(item => item.id === conversation.botId), name = botName(bot ?? { id: conversation.botId, name: conversation.botId });
  return same.length > 1 && order > 1 ? `${name} · ${tr("s14.chat.number")} ${order}` : name;
}
/** Starts an empty chat. It is not an authority control: conversation membership grants nothing. */
function newChat(page: S14Page, bot: Bot, cls = "s-btn", extra = ""): string {
  return bot.enabled ? `<form method="post" action="/s14/forms/new-chat"${extra}>${flat(page.csrf, bot.revision)}${hidden("botId", bot.id)}<button class="${cls}">${icon("plus")}<span class="s-label">${tr("s14.chat.new")}</span></button></form>` : "";
}
interface ShellOptions { current?: "home" | "work" | "team" | "memory" | "more" | `chat:${string}`; subtitle?: string; dock?: string; pane?: string; inChat?: boolean; live?: boolean; bot?: Bot; action?: string }
export function shell(page: S14Page, title: string, content: string, options: ShellOptions = {}): string {
  const here = (name: string) => options.current === name ? ' aria-current="page"' : "", count = attentionCount(page);
  const badge = count ? `<span class="s-count">${pill(`${tr("s14.nav.waiting")} ${count}`, "warn")}</span>` : "";
  const chats = page.state.conversations.map(conversation => { const bot = page.state.bots.find(b => b.id === conversation.botId); return bot ? `<li><a class="s-link" href="/chats/${e(conversation.id)}#latest"${here(`chat:${conversation.id}`)}>${tile(bot, "", "small")}<span class="s-label">${e(chatLabel(page, conversation))}</span></a></li>` : ""; }).join("");
  const jit = page.state.bots.find(bot => bot.id === "jit"), start = jit ? newChat(page, jit, "s-link", ' class="s-nav-new"') : "";
  const nav = `<aside class="s-nav" aria-label="${tr("s14.nav.label")}"><a class="s-lockup" href="/" aria-label="${tr("s14.nav.home")}">${logoLockup({ height: 36, label: "Jit" })}<span class="s-rail-mark">${logoMark({ size: 32 })}</span></a>
    <ul><li><a class="s-link" href="/"${here("home")}>${icon("home")}<span class="s-label">${tr("s14.nav.home")}</span></a></li><li><a class="s-link" href="/work"${here("work")}>${icon("work")}<span class="s-label">${tr("s14.nav.work")}</span>${badge}</a></li><li><a class="s-link" href="/team"${here("team")}>${icon("team")}<span class="s-label">${tr("s14.nav.team")}</span></a></li><li><a class="s-link" href="/memory"${here("memory")}>${icon("memory")}<span class="s-label">${tr("s14.nav.memory")}</span></a></li></ul>
    <p class="s-nav-sec">${tr("s14.nav.chats")}</p><ul>${chats}</ul>${start}<div class="s-nav-foot"><a class="s-link" href="/more"${here("more")}>${icon("more")}<span class="s-label">${tr("s14.nav.more")}</span></a></div></aside>`;
  const tabs = `<nav class="s-tabs" aria-label="${tr("s14.nav.tabs")}"><a href="/"${here("home")}>${icon("chat")}<span>${tr("s14.nav.chat_tab")}</span></a><a href="/work"${here("work")}>${icon("work")}<span>${tr("s14.nav.work")}</span>${count ? `<span class="s-pill warn"><span class="sr-only">${tr("s14.nav.waiting")} </span>${count}</span>` : ""}</a><a href="/team"${here("team")}>${icon("team")}<span>${tr("s14.nav.team")}</span></a><a href="/more"${options.current === "more" || options.current === "memory" ? ' aria-current="page"' : ""}>${icon("more")}<span>${tr("s14.nav.more")}</span></a></nav>`;
  const back = options.inChat ? `<a class="s-btn s-back" href="/" aria-label="${tr("s14.nav.home")}">${icon("back")}</a>` : "";
  return documentPage(title, `<div class="s-app">${nav}<main class="s-main" id="main-content"${options.pane ? ' data-pane="open"' : ""}${options.inChat ? " data-in-chat" : ""}><div class="s-chatcol"><header class="s-hdr">${back}${options.bot ? tile(options.bot, "") : ""}<div class="s-hdr-t"><h1>${e(title)}</h1>${options.subtitle ? `<small>${e(options.subtitle)}</small>` : ""}</div>${options.action ?? ""}</header>
    <div class="s-scroll"${options.live ? ' data-live="true"' : ""}>${content}</div>${options.dock ?? ""}</div>${options.pane ?? ""}</main>${tabs}<p class="sr-only" role="status" id="s-phase" data-reply="${tr("s14.live.reply")}"></p></div>`);
}

function limitFields(values: { concurrent: number; minutes: number; reads: number }): string {
  const field = (name: "concurrent" | "minutes" | "reads", label: string) => `<label class="s-limit"><input type="number" name="${name}" min="${workLimitBounds[name][0]}" max="${workLimitBounds[name][1]}" value="${values[name]}" inputmode="numeric"><span>${e(label)}</span></label>`;
  return `<fieldset class="s-limits"><legend>${tr("s14.limits.title")}</legend>${field("concurrent", tr("s14.limits.concurrent"))}${field("minutes", tr("s14.limits.minutes"))}${field("reads", tr("s14.limits.reads"))}</fieldset>`;
}
const toolOptions = (page: S14Page, bots: Bot[]) => page.policy.tools.filter(tool => bots.some(bot => bot.capabilities.tools.includes(tool)));
/** Bots and tools the grant may name. The conversation's Bot is fixed; everything else is visible and optional. */
function grantChoices(page: S14Page, lead: Bot, draft: S14Draft | null): string {
  const others = page.state.bots.filter(bot => bot.id !== lead.id && bot.enabled);
  const tools = toolOptions(page, [lead, ...others]);
  return `${hidden(`bot:${lead.id}`, lead.revision)}${others.map(bot => `<label class="s-check"><input type="checkbox" name="bot:${e(bot.id)}" value="${bot.revision}"${draft?.bots.includes(bot.id) ? " checked" : ""}><span>${e(botName(bot))}</span></label>`).join("")}
    ${tools.map(tool => `<label class="s-check"><input type="checkbox" name="tool:${e(tool)}" value="on"${tool.startsWith("effect_") ? "" : " checked"}><span class="s-mono">${e(tool)}${tool.startsWith("effect_") ? `<small>${tr("s14.grant.effect_tool")}</small>` : ""}</span></label>`).join("")}`;
}
function composer(page: S14Page, conversation: Conversation, bot: Bot, from: "home" | "chat", draft: S14Draft | null): string {
  const limits = draft ?? defaultWorkLimits, placeholder = bot.id === "jit" ? tr("s14.composer.placeholder") : `${tr("s14.composer.placeholder_to")} ${botName(bot)}…`;
  return `<form class="s-composer${from === "home" ? " big" : ""}" data-composer method="post" action="/s14/forms/compose" novalidate>${flat(page.csrf, conversation.revision)}${hidden("conversationId", conversation.id)}${hidden("from", from)}
    <label class="sr-only" for="s14-text">${tr("s14.composer.label")}</label><textarea id="s14-text" name="text" rows="${from === "home" ? 3 : 1}" maxlength="16384" placeholder="${e(placeholder)}">${e(draft?.text ?? "")}</textarea>
    <div class="s-bar"><a class="s-chip" href="/team"><span class="sr-only">${tr("s14.composer.to")} </span><span aria-hidden="true">${tr("s14.composer.to")}</span> ${e(botName(bot))}</a><label class="s-chip s-mode"><input type="checkbox" name="work" value="on"${draft?.work ? " checked" : ""}><span>${tr("s14.composer.mode")}</span></label><span class="s-grow"></span><button class="s-send" aria-label="${tr("s14.composer.send")}" title="${tr("s14.composer.send")}">${icon("arrow")}</button></div>
    <div class="s-budget"><p>${tr("s14.composer.starts_now")}</p>${limitFields(limits)}<details class="s-more"><summary>${tr("s14.composer.more")}</summary><div><label class="s-field"><span>${tr("s14.composer.completion")}</span><input name="completion" maxlength="1000" value="${e(draft?.completion ?? "")}" placeholder="${tr("s14.work.default_completion")}"></label>${grantChoices(page, bot, draft)}</div></details><p class="s-note">${tr(page.policy.tools.length ? "s14.composer.tools_note" : "s14.composer.no_tools_note")} ${tr("s14.composer.serial_note")}</p></div></form>`;
}

function taskSlip(page: S14Page, task: Work, conversation: Conversation, bot: Bot): string {
  const body = untrusted(`<p><b>${e(task.title)}</b></p><p>${e(task.purpose)}</p><p class="s-meta">${tr("s14.task.completion")}: ${e(task.completionRule)}</p>`);
  if (task.state === "rejected") return `<article class="s-slip" data-state="closed" aria-label="${tr("s14.task.title")}"><div class="s-slip-hd"><div><h3>${tr("s14.task.title")} r${task.revision}</h3></div>${workPill("rejected")}</div><div class="s-slip-body">${banner("", tr("s14.task.rejected_title"), tr("s14.task.rejected_detail"))}${body}</div></article>`;
  if (task.state === "proposed") return `<article class="s-slip" aria-label="${tr("s14.task.title")}"><div class="s-slip-hd"><div><h3>${tr("s14.task.title")} r${task.revision}</h3><p class="s-meta">${tr("s14.task.no_effect")}</p></div>${workPill("proposed")}</div><div class="s-slip-body">${body}</div>
    ${ownerStrip(`${commandForm(page.csrf, "task.accept", task.revision, { taskId: task.id }, tr("s14.task.accept"))}${commandForm(page.csrf, "task.reject", task.revision, { taskId: task.id }, tr("s14.task.reject"))}`, tr("s14.task.accept_note"), "", `<p class="s-note">${tr("s14.task.reject_note")}</p>`)}</article>`;
  return `<article class="s-slip" data-state="closed" aria-label="${tr("s14.task.title")}"><div class="s-slip-hd"><div><h3>${tr("s14.task.title")} r${task.revision}</h3></div>${workPill("accepted")}</div><div class="s-slip-body">${banner("", tr("s14.task.not_running_title"), tr("s14.task.not_running"))}${body}</div>
    ${ownerStrip(`<form class="s-stack" method="post" action="/s14/forms/task-start">${flat(page.csrf, conversation.revision)}${hidden("taskId", task.id)}${hidden("taskRevision", task.revision)}${limitFields(defaultWorkLimits)}<details class="s-more"><summary>${tr("s14.composer.more")}</summary><div>${grantChoices(page, bot, null)}</div></details><div><button class="s-btn primary">${tr("s14.task.start")}</button></div></form>`, tr("s14.task.start_note"))}</article>`;
}
function receiptLine(work: Work, view?: WorkView): string {
  if (!work.grantId) return "";
  return `<p class="s-receipt"><span>${tr("s14.work.receipt")}</span><span class="s-mono s-meta">${e(short(work.id))}</span><span>${tr("s14.work.grant")} g${view?.grant?.revision ?? 1}</span></p>`;
}
function stopForm(page: S14Page, work: Work): string {
  return commandForm(page.csrf, "work.stop", work.revision, { workId: work.id }, tr("s14.work.stop"), "s-btn danger");
}
/** A suggestion that never started: it renders as its slip, with no work pane parts it cannot have. */
const isTask = (work: Work) => work.state === "proposed" || work.state === "accepted" || work.state === "rejected";
const stoppable = (work: Work) => ["queued", "running", "waiting", "blocked"].includes(work.state);
function workCard(page: S14Page, work: Work, conversation: Conversation, bot: Bot): string {
  if (isTask(work)) return taskSlip(page, work, conversation, bot);
  const open = `/chats/${e(conversation.id)}?work=${e(work.id)}`;
  return `<article class="s-workcard" aria-label="${e(work.title)}"><div class="s-workcard-hd"><div><h3>${e(work.title)}</h3></div>${workPill(work.state)}</div>${receiptLine(work)}<div class="s-lane-mini">${tile(bot, workDot[work.state] ?? "", "small")}<span class="s-grow">${e(botName(bot))}</span><span>${tr(k(`s14.work_state.${work.state}`))}</span></div>
    <div class="s-workcard-ft"><a class="s-btn" href="${open}">${tr("s14.work.open_progress")}</a><a class="s-btn" href="${open}&amp;tab=grant">${tr("s14.work.open_grant")}</a></div>${stoppable(work) ? ownerStrip(stopForm(page, work), tr("s14.work.stop_note")) : ""}</article>`;
}

function proposalFacts(page: S14Page, proposal: BotProposal): string {
  const proposer = page.state.bots.find(b => b.id === proposal.proposerBotId), route = page.state.routes.find(r => r.id === proposal.routeId);
  return `<dl class="s-kv"><dt>${tr("s14.proposal.author")}</dt><dd>${proposal.author === "owner" ? tr("s14.proposal.author_owner") : e(botName(proposer ?? { id: proposal.proposerBotId, name: proposal.proposerBotId }))}</dd><dt>${tr("s14.proposal.route")}</dt><dd>${routeText(route)}</dd><dt>${tr("s14.proposal.logins")}</dt><dd>${tr("s14.proposal.none_granted")}</dd><dt>${tr("s14.proposal.computer")}</dt><dd>${tr("s14.proposal.no_computer")}</dd></dl>`;
}
function capabilityChoices(page: S14Page): string {
  const items = [...page.policy.tools.map(id => `<label class="s-check"><input type="checkbox" name="tool:${e(id)}" value="on"><span class="s-mono">${e(id)}</span></label>`), ...page.policy.resources.map(id => `<label class="s-check"><input type="checkbox" name="resource:${e(id)}" value="on"><span class="s-mono">${e(id)}</span></label>`)];
  return `<fieldset class="s-field"><legend>${tr("s14.proposal.capabilities")}</legend>${items.join("") || `<p class="s-note">${tr("s14.proposal.no_capabilities")}</p>`}<p class="s-note">${tr("s14.proposal.capabilities_note")}</p></fieldset>`;
}
function routeChoice(routes: Route[], selected: string | null): string {
  if (routes.length < 2) return "";
  return `<fieldset class="s-field"><legend>${tr("s14.proposal.route")}</legend>${routes.map((route, i) => `<label class="s-check"><input type="radio" name="routeId" value="${e(route.id)}"${route.id === selected || (!selected && i === 0) ? " checked" : ""}>${routeText(route)}</label>`).join("")}</fieldset>`;
}
/** Exact-revision contract card. Name and duty sit in the untrusted frame while a Bot authored them. */
function proposalCard(page: S14Page, proposal: BotProposal, history: BotProposal[], level: "h2" | "h3"): string {
  const closed = proposal.state !== "proposed", previous = history.find(item => item.revision === proposal.revision - 1);
  const content = `<p><b>${e(proposal.name)}</b></p><p>${e(proposal.responsibility)}</p>`;
  const changes = previous && (previous.name !== proposal.name || previous.responsibility !== proposal.responsibility || previous.routeId !== proposal.routeId) ? `<div><p class="s-exact-label">${tr("s14.proposal.changed_from")} r${previous.revision}</p>${previous.name !== proposal.name ? `<p class="s-exact s-diff-old">${e(previous.name)}</p><p class="s-exact s-diff-new">${e(proposal.name)}</p>` : ""}${previous.responsibility !== proposal.responsibility ? `<p class="s-exact s-diff-old">${e(previous.responsibility)}</p><p class="s-exact s-diff-new">${e(proposal.responsibility)}</p>` : ""}</div>` : "";
  const dropped = proposal.dropped.length ? `<p class="s-note">${tr("s14.proposal.dropped")} ${proposal.dropped.map(code => `<span class="s-mono">${e(code)}</span>`).join(" ")}</p>` : "";
  const noRoute = !proposal.routeId || !page.state.routes.some(r => r.id === proposal.routeId);
  const revise = `<details class="s-more"><summary>${tr("s14.proposal.edit")} (r${proposal.revision + 1})</summary><div><form class="s-stack" method="post" action="/s14/forms/proposal-revise">${flat(page.csrf, proposal.revision)}${hidden("proposalId", proposal.id)}<label class="s-field"><span>${tr("s14.proposal.name")}</span><input name="name" required maxlength="200" value="${e(proposal.name)}"></label><label class="s-field"><span>${tr("s14.proposal.duty")}</span><textarea name="responsibility" required maxlength="4000">${e(proposal.responsibility)}</textarea></label>${routeChoice(page.state.routes, proposal.routeId)}<div><button class="s-btn">${tr("s14.proposal.save_revision")} r${proposal.revision + 1}</button></div></form></div></details>`;
  const formId = `s14-accept-${e(proposal.id)}`, grant = noRoute ? "" : `<form class="s-strip-grant" id="${formId}" method="post" action="/s14/forms/proposal-accept">${flat(page.csrf, proposal.revision)}${hidden("proposalId", proposal.id)}${capabilityChoices(page)}</form>`;
  const strip = proposal.state === "proposed" ? ownerStrip(`${noRoute ? "" : `<button class="s-btn primary" form="${formId}">${tr("s14.proposal.accept")} r${proposal.revision}</button>`}${commandForm(page.csrf, "bot.proposal.reject", proposal.revision, { proposalId: proposal.id }, tr("s14.proposal.reject"))}`, tr(noRoute ? "s14.proposal.needs_route" : "s14.proposal.accept_note"), grant, revise) : "";
  const closure = proposal.state === "accepted" ? banner("ok", tr("s14.proposal.accepted"), tr("s14.proposal.accepted_note"), proposal.botId ? `<p><a class="s-link-text" href="/team/${e(proposal.botId)}">${tr("s14.proposal.open_bot")}</a></p>` : "") : proposal.state === "rejected" ? banner("", tr("s14.proposal.rejected"), tr("s14.proposal.rejected_note")) : "";
  const state = proposal.state === "proposed" ? pill(tr("s14.work_state.proposed"), "strong") : proposal.state === "accepted" ? pill(tr("s14.proposal.state_accepted"), "ok", "✓") : pill(tr("s14.proposal.state_rejected"));
  return `<article class="s-slip"${closed ? ' data-state="closed"' : ""} aria-label="${tr("s14.proposal.title")} r${proposal.revision}"><div class="s-slip-hd"><div><${level}>${tr("s14.proposal.title")} r${proposal.revision}</${level}><p class="s-meta">${tr(closed ? "s14.proposal.closed" : "s14.proposal.no_effect")}</p></div>${state}</div>
    <div class="s-slip-body">${closure}${proposal.author === "bot" ? untrusted(content) : untrusted(content, tr("s14.untrusted.owner_edit"))}${changes}${proposalFacts(page, proposal)}${dropped}</div>${strip}</article>`;
}
function proposalHistory(history: BotProposal[], current: BotProposal): string {
  const old = history.filter(item => item.revision < current.revision);
  return old.length ? `<section class="s-card" aria-labelledby="s14-history"><h2 id="s14-history">${tr("s14.proposal.history")}</h2><ul class="s-history">${old.map(item => `<li><p>r${item.revision} · ${pill(tr("s14.proposal.stale"))} · ${tr(item.author === "owner" ? "s14.proposal.author_owner" : "s14.proposal.author_bot")}</p><p class="s-sub">${e(item.name)}</p></li>`).join("")}</ul></section>` : "";
}

const replyLine = (reply: Reply, bot: Bot) => reply.state === "succeeded" ? "" : `<div class="s-bot-msg">${tile(bot, reply.state === "blocked" ? "failed" : reply.state === "running" ? "working" : "hollow")}<div>${reply.state === "blocked" ? banner("warn", tr("s14.reply.blocked"), `${trMaybe(`s14.reason.${reply.reason}`) ?? ""} ${tr("s14.reply.blocked_next")}`.trim(), reply.reason === "reply_unavailable" ? `<p><a class="s-link-text" href="/settings/provider">${tr("s14.reply.check_provider")}</a></p>` : "") : `<p class="s-who">${e(botName(bot))} · ${tr(k(`s14.reply.${reply.state}`))}</p>`}</div></div>`;
const messageText = (item: Message) => item.text === "[deleted]" ? tr("s14.memory.message_deleted") : `${e(item.text)}${item.contextState === "withdrawn" ? ` <span class="s-note">${tr("s14.memory.withdrawn")}</span>` : ""}`;
const message = (item: Message, bot: Bot, extra: string) => item.role === "owner" ? `<div class="s-owner-msg">${messageText(item)}</div>` : `<div class="s-bot-msg">${tile(bot)}<div><p class="s-who">${e(botName(bot))}</p><p class="s-bot-text">${messageText(item)}</p>${extra}</div></div>`;
/** Messages, typed cards and work in commit order. Cards are built from typed records, never parsed from message text. */
function thread(page: S14Page, chat: S14Chat, bot: Bot): string {
  const work = page.work.filter(item => item.conversationId === chat.conversation.id).sort((a, b) => a.createdAt - b.createdAt), direct = work.filter(item => !item.sourceMessageId);
  const open = chat.proposals.some(p => p.state === "proposed") || work.some(w => w.state === "proposed" || w.state === "accepted");
  const lastBot = [...chat.messages].reverse().find(item => item.role === "bot"), lastOwner = [...chat.messages].reverse().find(item => item.role === "owner"), rows: string[] = [];
  let next = 0;
  const flushDirect = (until: number) => { while (next < direct.length && direct[next]!.createdAt <= until) rows.push(workCard(page, direct[next++]!, chat.conversation, bot)); };
  chat.messages.forEach((item, index) => {
    const cards = [...chat.proposals.filter(p => p.messageId === item.id).map(p => proposalCard(page, p, chat.history[p.id] ?? [], "h3")), ...work.filter(w => w.sourceMessageId === item.id).map(w => workCard(page, w, chat.conversation, bot))];
    const ask = item === lastBot && !open && !work.length && lastOwner ? `<a class="s-chip" href="/chats/${e(chat.conversation.id)}?start=${e(lastOwner.id)}#s14-text">${tr("s14.ask.start")}</a>` : "";
    rows.push(message(item, bot, `${cards.join("")}${ask}`));
    const after = chat.replies.find(reply => reply.messageId === item.id); if (after) rows.push(replyLine(after, bot));
    flushDirect(chat.messages[index + 1]?.createdAt ?? Number.MAX_SAFE_INTEGER);
  });
  flushDirect(Number.MAX_SAFE_INTEGER);
  return rows.join("");
}
const emptyThread = (bot: Bot) => `<p class="s-sub">${bot.id === "jit" ? tr("s14.chat.empty_jit") : tr("s14.chat.empty_bot")}</p>`;
const liveWork = (work: Work) => ["queued", "running", "stopping"].includes(work.state);

function meter(label: string, used: number, limit: number, text: string): string {
  return `<div class="s-meter"><span>${e(label)}</span><small>${e(text)}</small><meter min="0" max="${limit}" value="${Math.min(used, limit)}" aria-label="${e(label)}">${e(text)}</meter></div>`;
}
function usage(view: WorkView): string {
  const { grant, reservations } = view; if (!grant || !reservations) return "";
  return `<section class="s-stack" aria-labelledby="s14-usage"><h3 class="s-section-t" id="s14-usage">${tr("s14.usage.title")}</h3>
    ${meter(tr("s14.usage.reads"), reservations.calls, grant.limits.calls, `${tr("s14.usage.reserved")} ${reservations.calls} ${tr("s14.usage.of")} ${grant.limits.calls}`)}
    ${meter(tr("s14.usage.output"), reservations.outputBytes, grant.limits.outputBytes, `${tr("s14.usage.reserved")} ${size(reservations.outputBytes)} ${tr("s14.usage.of")} ${size(grant.limits.outputBytes)}`)}
    <div class="s-meter"><span>${tr("s14.usage.actual")}</span><small>${tr("s14.unknown")}</small><span class="s-unknown-bar" aria-hidden="true"></span></div><p class="s-note">${tr("s14.usage.note")}</p></section>`;
}
function workStateBanner(view: WorkView): string {
  const { work } = view, reason = work.reason ? trMaybe(`s14.reason.${work.reason}`) : null;
  if (work.state === "queued") return banner("", tr("s14.work_state.queued"), tr("s14.work.queued_detail"));
  if (work.state === "running") return banner("", tr("s14.work_state.running"), tr("s14.work.running_detail"));
  if (work.state === "waiting") return banner("warn", tr("s14.work_state.waiting"), tr("s14.work.waiting_detail"));
  if (work.state === "ready") return banner("ok", tr("s14.work_state.ready"), tr("s14.work.ready_detail"));
  if (work.state === "blocked") return banner("warn", tr("s14.work_state.blocked"), `${reason ?? tr("s14.reason.generic")} ${tr("s14.work.blocked_next")}`, work.reason ? `<p class="s-mono s-meta">${e(work.reason)}</p>` : "");
  if (work.state === "stopping") return banner("", tr("s14.work_state.stopping"), tr("s14.work.stopping_detail"));
  if (work.state === "stopped") return banner("", tr("s14.work_state.stopped"), tr("s14.work.stopped_detail"));
  return "";
}
function attemptLane(page: S14Page, attempt: Attempt): string {
  const bot = page.state.bots.find(b => b.id === attempt.snapshot.bot.id) ?? attempt.snapshot.bot;
  return `<div class="s-lane">${tile(bot, attemptDot[attempt.state] ?? "")}<div><p><b>${e(botName(bot))}</b> · ${tr(k(`s14.attempt_state.${attempt.state}`))}</p>${attempt.reason ? `<p class="s-meta">${e(trMaybe(`s14.reason.${attempt.reason}`) ?? attempt.reason)}</p>` : ""}<p class="s-meta">${when(attempt.createdAt)}</p>${attempt.snapshot.tools.includes("computer") ? `<p><a class="s-link-text" href="${computerPath(bot)}">${tr("s14.work.view_computer")}</a></p>` : ""}</div></div>`;
}
function progressTab(page: S14Page, view: WorkView, conversation: Conversation, bot: Bot, research: S14WorkResearch | null, base: string): string {
  const { work } = view;
  if (isTask(work)) return taskSlip(page, work, conversation, bot);
  const resultText = view.results.map(result => result.text).join("\n\n");
  const result = resultText ? `<section class="s-stack" aria-labelledby="s14-result"><h3 class="s-section-t" id="s14-result">${tr("s14.work.result")}</h3>${untrusted(`<p>${e(resultText)}</p>`, tr("s14.untrusted.result"))}<p class="s-note">${tr("s14.work.completion_rule")}: ${e(work.completionRule)}</p></section>` : "";
  const evidenceHref = `${base}${base.includes("?") ? "&amp;" : "?"}tab=evidence`;
  return `${workStateBanner(view)}${recoveryNotice(view)}${researchNotice(research, evidenceHref)}${view.effects.map(effect => effectSlip(page, effect, [], "h3")).join("")}${recoveryPanel(page, view, research)}${view.attempts.length ? `<section class="s-stack" aria-labelledby="s14-lanes"><h3 class="s-section-t" id="s14-lanes">${tr("s14.work.lanes")}</h3>${view.attempts.map(a => attemptLane(page, a)).join("")}</section>` : ""}${result}${usage(view)}${stoppable(work) ? `<div class="s-slip" data-state="closed">${ownerStrip(stopForm(page, work), tr("s14.work.stop_note"))}</div>` : ""}`;
}
function grantTab(page: S14Page, view: WorkView): string {
  const { grant, authority, work } = view;
  if (!grant) return banner("", tr("s14.grant.none"), tr("s14.grant.none_detail"));
  const payload = grant.command.payload, effects = grant.tools.filter(tool => tool.startsWith("effect_")), reads = grant.tools.filter(tool => !tool.startsWith("effect_"));
  const list = (items: string[], empty: string) => items.length ? items.map(item => `<span class="s-mono">${e(item)}</span>`).join(" · ") : e(empty);
  const revoked = authority?.revoked ? banner("", tr("s14.grant.revoked"), tr("s14.grant.revoked_detail")) : page.now >= grant.expiresAt ? banner("", tr("s14.grant.expired"), tr("s14.grant.expired_detail")) : "";
  return `${revoked}<section class="s-stack" aria-labelledby="s14-command"><h3 class="s-section-t" id="s14-command">${tr("s14.grant.command")}</h3><pre class="s-exact">${e(payload.purpose)}</pre><p class="s-note">${tr("s14.work.completion_rule")}: ${e(payload.completionRule)}</p></section>
    <dl class="s-kv"><dt>${tr("s14.grant.revision")}</dt><dd><span class="s-mono">g${grant.revision} · ${e(grant.id)}</span></dd><dt>${tr("s14.grant.started")}</dt><dd>${when(grant.createdAt)}</dd><dt>${tr("s14.grant.expires")}</dt><dd>${when(grant.expiresAt)} · ${remaining(grant.expiresAt, page.now)}</dd>
    <dt>${tr("s14.grant.bots")}</dt><dd>${grant.bots.map(bot => `${e(botName(bot))} <span class="s-mono s-meta">r${bot.revision}</span>`).join(" · ")}</dd><dt>${tr("s14.grant.route")}</dt><dd>${grant.routes.map(route => routeText(route)).join(" · ")}</dd><dt>${tr("s14.grant.tools")}</dt><dd>${list(reads, tr("s14.grant.no_tools"))}</dd>
    <dt>${tr("s14.grant.outbound")}</dt><dd>${tr(reads.length ? "s14.grant.outbound_tools" : "s14.grant.outbound_none")}</dd><dt>${tr("s14.grant.external")}</dt><dd>${list(effects, tr("s14.grant.no_external"))}${effects.length ? `<br><span class="s-note">${tr("s14.grant.effect_tool")}</span>` : ""}</dd><dt>${tr("s14.grant.scopes")}</dt><dd>${list(grant.scopes.map(scope => `${scope.ref.kind}:${scope.ref.id} r${scope.ref.revision}`), tr("s14.grant.no_scopes"))}</dd>
    <dt>${tr("s14.grant.time")}</dt><dd>${Math.round(grant.limits.wallMs / 60000)} ${tr("s14.time.minutes")}</dd><dt>${tr("s14.grant.reads")}</dt><dd>${grant.limits.calls}</dd><dt>${tr("s14.grant.concurrency")}</dt><dd>${tr("s14.grant.concurrency_detail")}</dd><dt>${tr("s14.grant.output")}</dt><dd>${size(grant.limits.outputBytes)}</dd></dl>
    <p class="s-note">${tr("s14.grant.enforced_note")}</p>${stoppable(work) ? `<div class="s-slip" data-state="closed">${ownerStrip(stopForm(page, work), tr("s14.work.stop_note"))}</div>` : ""}`;
}
function workBody(page: S14Page, view: WorkView, tab: S14WorkTab, conversation: Conversation, bot: Bot, research: S14WorkResearch | null, base: string): string {
  if (tab === "computer" && usesComputer(view)) return computerTab(page, view);
  return tab === "grant" ? grantTab(page, view) : tab === "evidence" ? evidenceTab(page, view, research) : progressTab(page, view, conversation, bot, research, base);
}
function workTabs(view: WorkView, tab: S14WorkTab, base: string): string {
  if (tab === "computer" && !usesComputer(view)) tab = "progress";
  const sep = base.includes("?") ? "&amp;" : "?", link = (name: S14WorkTab) => `<a href="${base}${sep}tab=${name}"${tab === name ? ' aria-current="page"' : ""}>${tr(k(`s14.tab.${name}`))}</a>`;
  return view.work.grantId ? `<nav class="s-worktabs" aria-label="${tr("s14.tab.label")}">${link("progress")}${link("grant")}${usesComputer(view) ? link("computer") : ""}${link("evidence")}</nav>` : "";
}
function workPane(page: S14Page, view: WorkView, tab: S14WorkTab, conversation: Conversation, bot: Bot, research: S14WorkResearch | null): string {
  const base = `/chats/${e(conversation.id)}?work=${e(view.work.id)}`;
  return `<section class="s-pane" aria-labelledby="s14-pane-title"><div class="s-pane-hdr"><div><h2 id="s14-pane-title">${e(view.work.title)}</h2>${receiptLine(view.work, view)}</div>${workPill(view.work.state, "s14-pane-status")}<a class="s-btn" href="/chats/${e(conversation.id)}" aria-label="${tr("s14.pane.close")}">${icon("close")}</a></div>${workTabs(view, tab, base)}<div class="s-pane-body" id="s14-pane-live">${workBody(page, view, tab, conversation, bot, research, base)}</div></section>`;
}

const reasonOf = (effect: Effect) => effect.reason ? trMaybe(`s14.reason.${effect.reason}`) ?? "" : "";
const approveLabel = (effect: Effect) => tr(k(`s14.effect_approve.${effect.action.kind}`));
function effectBanner(effect: Effect, history: Effect[]): string {
  const changedFrom = history.filter(item => item.state === "changed").at(-1);
  if (effect.state === "unknown") return banner("danger", tr("s14.effect_state.unknown"), tr("s14.effect.unknown_detail"), `<p class="s-sub">${tr("s14.effect.unknown_next")}</p>`);
  if (effect.state === "expired") return banner("", tr("s14.effect_state.expired"), tr("s14.effect.expired_detail"));
  if (effect.state === "denied") return banner("", tr("s14.effect_state.denied"), reasonOf(effect) || tr("s14.effect.denied_detail"));
  if (effect.state === "approved") return banner("", tr("s14.effect_state.approved"), tr("s14.effect.approved_detail"));
  if (effect.state === "executing") return banner("", tr("s14.effect_state.executing"), tr("s14.effect.executing_detail"));
  if (effect.state === "succeeded") return banner("ok", tr("s14.effect_state.succeeded"), tr("s14.effect.succeeded_detail"));
  if (effect.state === "failed") return banner("danger", tr("s14.effect_state.failed"), tr("s14.effect.failed_detail"));
  if (changedFrom) return banner("warn", `${tr("s14.effect.changed")} r${changedFrom.revision}`, tr("s14.effect.changed_detail"));
  return "";
}
function effectDiff(effect: Effect, history: Effect[]): string {
  const old = history.filter(item => item.state === "changed").at(-1); if (!old) return "";
  const field = (label: string, before: string, after: string) => before === after ? "" : `<div><p class="s-exact-label">${tr("s14.effect.what_changed")}: ${e(label)}</p><pre class="s-exact s-diff-old">${e(before)}</pre><pre class="s-exact s-diff-new">${e(after)}</pre></div>`;
  return `${field(tr("s14.effect.destination"), old.action.destination, effect.action.destination)}${field(tr("s14.effect.content"), old.action.content, effect.action.content)}`;
}
/** Exact-action card: content precedes decisions so it cannot be skipped, and the labels never carry model text. */
function effectSlip(page: S14Page, effect: Effect, history: Effect[], level: "h2" | "h3"): string {
  const bot = page.state.bots.find(b => b.id === effect.botId), name = botName(bot ?? { id: effect.botId, name: effect.botId }), pending = effect.state === "pending";
  const state = effect.state === "unknown" ? "unknown" : pending ? "pending" : "closed", heading = `${e(name)} ${tr("s14.effect.asks")} ${e(tr(k(`s14.effect_kind.${effect.action.kind}`)))}`;
  const decide = (decision: "approve" | "deny", label: string, cls: string) => commandForm(page.csrf, "approval.decide", effect.revision, { effectId: effect.id, actionHash: effect.actionHash, decision }, label, cls);
  const strip = pending ? ownerStrip(`${effect.supported ? decide("approve", approveLabel(effect), "s-btn primary") : ""}${decide("deny", tr("s14.effect.deny"), "s-btn")}`, tr(effect.supported ? "s14.effect.single_use" : "s14.effect.unsupported")) : "";
  const anchor = level === "h2" ? ' id="slip" tabindex="-1" data-focus-on-load' : "";
  return `<article class="s-slip" data-state="${state}" aria-label="${tr("s14.effect.card")}"><div class="s-slip-hd"><div><${level}${anchor}>${heading}</${level}><p class="s-meta">${tr("s14.effect.irreversible")}</p></div>${effectPill(effect.state)}</div>
    <div class="s-slip-body">${effectBanner(effect, history)}${level === "h2" ? effectDiff(effect, history) : ""}<div><p class="s-exact-label">${tr("s14.effect.destination")}</p><pre class="s-exact">${e(effect.action.destination)}</pre></div><div><p class="s-exact-label">${tr("s14.effect.content")}</p><pre class="s-exact">${e(effect.action.content)}</pre></div>
    <dl class="s-kv"><dt>${tr("s14.effect.revision")}</dt><dd><span class="s-mono">r${effect.revision}</span></dd><dt>${tr("s14.effect.hash")}</dt><dd class="s-mono">${e(effect.actionHash)}</dd><dt>${tr("s14.effect.expires")}</dt><dd>${when(effect.expiresAt)}${pending ? ` · ${remaining(effect.expiresAt, page.now)}` : ""}</dd></dl>${level === "h3" && effect.revision > 1 ? `<p><a class="s-link-text" href="/effects/${e(effect.id)}#slip">${tr("s14.effect.open_history")}</a></p>` : ""}</div>${strip}</article>`;
}
function effectHistory(history: Effect[], current: Effect): string {
  const old = history.filter(item => item.revision < current.revision);
  return old.length ? `<section class="s-card" aria-labelledby="s14-effect-history"><h2 id="s14-effect-history">${tr("s14.effect.history")}</h2><ul class="s-history">${old.map(item => `<li><p>r${item.revision} · ${effectPill(item.state)}</p><p class="s-mono s-meta">${e(item.actionHash)}</p></li>`).join("")}</ul></section>` : "";
}

/* Bot computer (BOX14-01, F11). The lease bar reads the lease, never local state, and every word here comes from typed query data. */
const computerPath = (bot: Pick<Bot, "id">, suffix = "") => `/team/${e(bot.id)}?tab=computer${suffix}`;
const usesComputer = (view: WorkView) => !!view.grant?.tools.includes("computer");
/** Raw dictionary text with the Bot's name filled in; callers escape it like any other query value. */
const named = (key: string, bot: Pick<Bot, "id" | "name">) => tr(k(key)).replace("{bot}", () => botName(bot));
const reasonText = (code: string) => trMaybe(`s14.reason.${code}`) ?? tr("s14.reason.computer_generic");
const computerTone: Record<BotComputer["state"], [string, string]> = { starting: ["", ""], running: ["strong", ""], stopping: ["", ""], stopped: ["", ""], resetting: ["warn", "!"], deleting: ["warn", "!"], deleted: ["", ""], unavailable: ["danger", "!"] };
const computerWord = (view: ComputerView) => tr(k(`s14.computer_state.${view.computer?.state ?? "absent"}`));
const computerPill = (view: ComputerView, id = "") => pill(computerWord(view), ...(view.computer ? computerTone[view.computer.state] : ["", ""] as const), id);
type Driver = "owner" | "expired" | "agent" | "none";
/** Who can send input right now. An expired lease refuses input before the sweep clears it, so it never reads as driving. */
function driverOf({ computer, lease }: ComputerView, now: number): Driver {
  if (computer?.state !== "running" || !lease?.actor) return "none";
  if (lease.expiresAt <= now) return lease.actor === "owner" ? "expired" : "none";
  return lease.actor;
}
const leaseWord = (view: ComputerView, bot: Pick<Bot, "id" | "name">, now: number) => view.computer?.state === "running" ? named(`s14.lease.${driverOf(view, now)}`, bot) : tr("s14.lease.off");
/** Host repair for an isolation or runtime reason. It names the safe code and the credential-free probe, never a workaround. */
const repairHint = (code: string) => `<p class="s-mono s-meta">${e(code)}</p><p class="s-sub">${tr("s14.computer.repair")}</p><pre class="s-exact">bun --no-env-file ops/box/s14-probe.ts --diagnostics</pre>`;
function computerBanner(bot: Bot, view: ComputerView, surface: S14ComputerSurface): string {
  const c = view.computer;
  if (!c) {
    if (!bot.capabilities.tools.includes("computer")) return banner("", tr("s14.computer.no_ceiling"), tr("s14.computer.no_ceiling_detail"));
    if (!surface.runtime) return banner("warn", reasonText("computer_runtime_not_configured"), tr("s14.computer.no_fallback"), repairHint("computer_runtime_not_configured"));
    return banner("", tr("s14.computer.absent"), tr("s14.computer.absent_detail"));
  }
  const why = c.reason ? reasonText(c.reason) : "", word = computerWord(view);
  if (c.state === "starting") return banner("", word, tr("s14.computer.starting_detail").replace("{seconds}", String(Math.ceil(c.limits.startupMs / 1000))));
  if (c.state === "stopping") return banner("", why || word, tr("s14.computer.stopping_detail"));
  if (c.state === "stopped") return banner("", why || word, tr("s14.computer.stopped_detail"));
  if (c.state === "resetting") return banner("warn", word, tr("s14.computer.resetting_detail"));
  if (c.state === "deleting") return banner("warn", word, tr("s14.computer.deleting_detail"));
  if (c.state === "deleted") return banner("", word, tr("s14.computer.deleted_detail"));
  if (c.state === "unavailable") return banner("danger", why || word, tr("s14.computer.no_fallback"), `<p class="s-sub">${tr("s14.computer.slot_held")}</p>${repairHint(c.reason ?? "computer_runtime_unavailable")}`);
  return "";
}
/** Pending external actions stay on their own cards. The link is the only way to them from here, so a press here never decides one. */
function heldNotice(held: Effect[]): string {
  if (!held.length) return "";
  return banner("warn", tr("s14.computer.held"), tr("s14.computer.held_detail"), held.map(effect => `<p><a class="s-link-text" href="/effects/${e(effect.id)}#slip">${tr("s14.computer.held_open")} · ${e(tr(k(`s14.effect_kind.${effect.action.kind}`)))}</a></p>`).join(""));
}
/** Always answers who is driving. Its only buttons are the two typed lease commands, pinned to the rendered revisions. */
function leaseBar(page: S14Page, bot: Bot, view: ComputerView): string {
  const { computer: c, lease } = view, driver = driverOf(view, page.now), running = c?.state === "running" && !!lease;
  const detail = !running ? tr("s14.lease.off_detail") : driver === "owner" ? `${named("s14.lease.owner_detail", bot)} · ${tr("s14.lease.ends_in")} ${Math.ceil((lease!.expiresAt - page.now) / 60000)} ${tr("s14.time.minutes")}` : named(`s14.lease.${driver}_detail`, bot);
  const scope = running ? { botId: c!.botId, computerId: c!.id, generation: c!.generation, leaseRevision: lease!.revision } : null;
  const ending = driver === "owner" || driver === "expired";
  const renew = () => commandForm(page.csrf, "takeover.renew", c!.revision, scope!, tr(driver === "owner" ? "s14.lease.renew" : "s14.lease.resume"), driver === "owner" ? "s-btn" : "s-btn primary");
  const end = () => commandForm(page.csrf, "takeover.end", c!.revision, scope!, tr(driver === "owner" ? "s14.lease.hand_back" : "s14.lease.close_expired"), driver === "owner" ? "s-btn primary" : "s-btn");
  const strip = scope ? ownerStrip(ending ? (driver === "owner" ? `${end()}${renew()}` : `${renew()}${end()}`) : commandForm(page.csrf, "takeover.start", c!.revision, scope, tr("s14.lease.take_over")), tr(ending ? "s14.lease.hand_back_note" : "s14.lease.take_over_note"), "", ending ? `<p class="s-note">${e(tr("s14.lease.renew_note").replace("{minutes}", String(Math.ceil(c!.limits.idleMs / 60000))))}</p>` : "") : "";
  return `<section class="s-slip s-lease" data-state="closed" data-driver="${driver}" aria-labelledby="s14-lease"><div class="s-slip-hd"><div><h2 id="s14-lease">${e(leaseWord(view, bot, page.now))}</h2><p class="s-meta">${e(detail)}</p></div></div>${strip}</section>`;
}
const inputFields = (page: S14Page, c: BotComputer, leaseRevision: number, kind: string) => `${hidden("csrf", page.csrf)}${hidden("requestId", rid())}${hidden("expectedRevision", c.revision)}${hidden("computerId", c.id)}${hidden("generation", c.generation)}${hidden("leaseRevision", leaseRevision)}${hidden("kind", kind)}`;
const screenKeys = [["Enter", "live.key_enter"], ["Tab", "live.key_tab"], ["Escape", "live.key_escape"], ["Backspace", "live.key_backspace"], ["ArrowUp", "live.key_up"], ["ArrowDown", "live.key_down"], ["ArrowLeft", "live.key_left"], ["ArrowRight", "live.key_right"]] as const;
/** What the computer reports about its page is data from the Bot's side: plain text in the untrusted frame, never a link. */
function pageIdentity(view: ComputerView): string {
  if (!view.page) return `<p class="s-note s-page-id">${tr("s14.screen.page_unknown")}</p>`;
  return `<div class="s-page-id">${untrusted(`<p class="s-mono">${e(view.page.url)}</p>${view.page.title ? `<p>${e(view.page.title)}</p>` : ""}`, tr("s14.screen.page_label"))}</div>`;
}
/** The pixels are the Bot's page, so they frame as untrusted. Taking over swaps the picture for the coordinate control; it stays 1280 by 800 without script because a scaled image would post scaled coordinates. */
function screenView(page: S14Page, bot: Bot, view: ComputerView, surface: S14ComputerSurface, driver: Driver): string {
  const c = view.computer, src = `/api/s14/bots/${e(bot.id)}/computer/image`, action = `/s14/bots/${e(bot.id)}/computer/input`;
  const alt = e(view.page ? named("s14.screen.alt_page", bot).replace("{page}", () => view.page!.url) : named("s14.screen.alt", bot));
  const picture = c?.state !== "running" ? `<div class="s-screen-empty"><p>${tr("s14.screen.off")}</p></div>`
    : driver === "owner" ? `<form method="post" action="${action}" data-computer-input>${inputFields(page, c, view.lease!.revision, "click")}<input type="image" name="point" src="${src}" alt="${alt}" width="1280" height="800" tabindex="-1" data-screen></form>`
    : `<img src="${src}" alt="${alt}" width="1280" height="800" data-screen>`;
  const outcome = surface.input ? (surface.input.state === "succeeded" ? banner("ok", tr("s14.input.succeeded"), tr("s14.input.succeeded_detail")) : banner("danger", tr("s14.input.unknown"), tr("s14.input.unknown_detail"))) : "";
  return `<section class="s-screen" id="screen" data-driver="${driver}" aria-labelledby="s14-screen"><div class="s-screen-bar">${icon("lock")}<h2 id="s14-screen">${tr("s14.screen.title")}</h2>${c?.state === "running" ? `<a class="s-link-text" href="${computerPath(bot, "#screen")}">${tr("s14.screen.refresh")}</a>` : ""}</div><div class="s-screen-view"${driver === "owner" ? ` tabindex="0" role="group" aria-label="${e(tr("s14.screen.pan"))}"` : ""}>${picture}</div>${c?.state === "running" ? pageIdentity(view) : ""}<p class="s-note s-screen-note">${tr(driver === "owner" ? "s14.screen.note_owner" : "s14.screen.note")}</p></section>
    <div class="s-input-status" role="status">${outcome}</div>`;
}
/** Script-free controls for the single owner lease: exact typed text, one fixed key per button, and typed coordinates for keyboard users. */
function inputControls(page: S14Page, bot: Bot, view: ComputerView): string {
  const c = view.computer!, revision = view.lease!.revision, action = `/s14/bots/${e(bot.id)}/computer/input`;
  const text = `<form class="s-stack" method="post" action="${action}" data-computer-input>${inputFields(page, c, revision, "text")}<div class="s-field"><label for="s14-computer-text">${tr("s14.input.text")}</label><input id="s14-computer-text" name="text" required maxlength="2000" autocomplete="off" autocapitalize="off" spellcheck="false"></div><p class="s-note">${tr("s14.input.text_note")}</p><div><button class="s-btn">${tr("s14.input.send")}</button></div></form>`;
  const keys = `<form method="post" action="${action}" data-computer-input>${inputFields(page, c, revision, "key")}<fieldset class="s-field"><legend>${tr("s14.input.keys")}</legend><div class="s-keys">${screenKeys.map(([value, label]) => `<button class="s-btn" name="key" value="${value}">${tr(label)}</button>`).join("")}</div></fieldset></form>`;
  const coordinates = `<details class="s-more"><summary>${tr("s14.input.coordinates")}</summary><div><form class="s-stack" method="post" action="${action}" data-computer-input>${inputFields(page, c, revision, "click")}<div class="s-row"><label class="s-limit"><span>X</span><input type="number" name="point.x" required min="0" max="1279" step="1" inputmode="numeric"></label><label class="s-limit"><span>Y</span><input type="number" name="point.y" required min="0" max="799" step="1" inputmode="numeric"></label><button class="s-btn">${tr("s14.input.click")}</button></div><p class="s-note">${tr("s14.input.coordinates_note")}</p></form></div></details>`;
  return `<section class="s-card s-stack" aria-labelledby="s14-input"><h2 id="s14-input">${tr("s14.input.title")}</h2>${text}${keys}${coordinates}</section>`;
}
function computerFacts(page: S14Page, c: BotComputer): string {
  const l = c.limits, mib = (bytes: number) => `${Math.floor(bytes / 1048576)} MiB`;
  return `<section class="s-card s-stack" aria-labelledby="s14-facts"><h2 id="s14-facts">${tr("s14.computer.facts")}</h2><dl class="s-kv"><dt>${tr("s14.computer.network")}</dt><dd>${tr("s14.computer.network_none")}</dd><dt>${tr("s14.computer.can_do")}</dt><dd>${tr("s14.computer.can_do_detail")}</dd><dt>${tr("s14.computer.last_work")}</dt><dd><a class="s-link-text" href="/work/${e(c.workId)}">${tr("s14.computer.open_work")}</a></dd><dt>${tr("s14.computer.last_used")}</dt><dd>${when(c.lastUsedAt)}</dd></dl>
    <details class="s-more"><summary>${tr("s14.computer.limits")}</summary><div><dl class="s-kv"><dt>CPU</dt><dd>${l.cpuMillis} millicores</dd><dt>RAM</dt><dd>${mib(l.memoryBytes)}</dd><dt>${tr("s14.computer.processes")}</dt><dd>${l.pids}</dd><dt>${tr("s14.computer.disk")}</dt><dd>${mib(l.diskBytes)}</dd><dt>${tr("s14.computer.idle")}</dt><dd>${Math.ceil(l.idleMs / 60000)} ${tr("s14.time.minutes")}</dd><dt>${tr("s14.computer.generation")}</dt><dd class="s-mono">g${c.generation} · r${c.revision}</dd></dl><p class="s-note">${tr("s14.computer.limits_note")}</p></div></details></section>`;
}
/** Opening needs a named work grant, so its title sits in the untrusted frame above a strip that never carries it. The list is advisory: `computer.open` rechecks everything. */
function openCards(page: S14Page, bot: Bot, view: ComputerView, surface: S14ComputerSurface): string {
  const c = view.computer;
  if (!surface.runtime || !bot.capabilities.tools.includes("computer") || (c && !["stopped", "deleted", "unavailable"].includes(c.state))) return "";
  if (!surface.eligible.length) return banner("", tr("s14.computer.no_eligible"), tr("s14.computer.no_eligible_detail"));
  const card = (item: S14ComputerSurface["eligible"][number]) => `<article class="s-slip" data-state="closed" aria-label="${tr("s14.computer.open_card")}"><div class="s-slip-body s-slip-top">${untrusted(`<p>${e(item.title)}</p>`, tr("s14.computer.open_for"))}<p class="s-meta">${tr("s14.grant.expires")} ${when(item.expiresAt)}</p></div>${ownerStrip(commandForm(page.csrf, "computer.open", c?.revision ?? 0, { botId: bot.id, workId: item.id }, tr("s14.computer.open")), tr("s14.computer.open_note"))}</article>`;
  const more = surface.eligible.length > 3 ? `<p class="s-note">${tr("s14.computer.more_eligible")} ${surface.eligible.length - 3}</p>` : "";
  return `${surface.eligible.slice(0, 3).map(card).join("")}${more}`;
}
const lifecycle = (c: BotComputer) => ["running", "stopped", "unavailable"].includes(c.state);
/** Stop keeps data and posts directly. Reset and delete destroy it, so each one is a link to its own exact consequence card. */
function lifecycleStrip(page: S14Page, bot: Bot, c: BotComputer): string {
  const stop = ["running", "starting", "unavailable"].includes(c.state) ? commandForm(page.csrf, "computer.stop", c.revision, { botId: c.botId, computerId: c.id, generation: c.generation }, tr("s14.computer.stop")) : "";
  const destroy = lifecycle(c) ? `<a class="s-btn danger" href="${computerPath(bot, "&amp;confirm=reset#slip")}">${tr("s14.computer.reset")}</a><a class="s-btn danger" href="${computerPath(bot, "&amp;confirm=delete#slip")}">${tr("s14.computer.delete")}</a>` : "";
  return stop || destroy ? `<div class="s-slip" data-state="closed">${ownerStrip(`${stop}${destroy}`, stop ? tr("s14.computer.stop_note") : tr("s14.computer.destroy_note"))}</div>` : "";
}
const activityText = (item: ComputerActivity) => `${tr(k(`s14.activity.${item.kind}`))}${item.state ? ` · ${tr(k(`s14.input.${item.state}`))}` : ""}`;
function activityLog(items: ComputerActivity[]): string {
  return `<section aria-labelledby="s14-activity"><h2 class="s-section-t" id="s14-activity">${tr("s14.activity.title")}</h2>${items.length ? `<ol class="s-log">${items.map(item => `<li>${when(item.at)}<span>${activityText(item)}</span></li>`).join("")}</ol>` : `<p class="s-sub">${tr("s14.activity.none")}</p>`}<p class="s-note">${tr("s14.activity.note")}</p></section>`;
}
/** Exact consequence card for reset or delete: both scopes by ID, what stays, then the single typed command. Focus lands on the heading, never on the button. */
function destroyCard(page: S14Page, bot: Bot, c: BotComputer, mode: "reset" | "delete"): string {
  const scope = (label: string, what: string, id: string) => `<div><p class="s-exact-label">${label}</p><pre class="s-exact">${what}\n${e(id)}</pre></div>`;
  return `<article class="s-slip" data-state="unknown" aria-label="${tr(k(`s14.destroy.${mode}_card`))}"><div class="s-slip-hd"><div><h2 id="slip" tabindex="-1" data-focus-on-load>${e(named(`s14.destroy.${mode}_title`, bot))}</h2><p class="s-meta">${tr("s14.destroy.irreversible")}</p></div>${computerPill({ computer: c, lease: null })}</div><div class="s-slip-body">${banner("danger", tr("s14.destroy.lost_title"), tr("s14.destroy.lost_detail"))}${scope(tr("s14.destroy.workspace"), tr("s14.destroy.workspace_detail"), c.workspaceId)}${scope(tr("s14.destroy.profile"), tr("s14.destroy.profile_detail"), c.profileId)}
    <div><p class="s-exact-label">${tr("s14.destroy.kept")}</p><p>${tr("s14.destroy.kept_detail")}</p></div><div><p class="s-exact-label">${tr("s14.destroy.effect")}</p><p>${tr("s14.destroy.effect_detail")}</p></div><div><p class="s-exact-label">${tr("s14.destroy.after")}</p><p>${tr(k(`s14.destroy.${mode}_after`))}</p></div><dl class="s-kv"><dt>${tr("s14.proposal.computer")}</dt><dd class="s-mono">${e(c.id)}</dd><dt>${tr("s14.computer.generation")}</dt><dd class="s-mono">g${c.generation} · r${c.revision}</dd></dl></div>
    ${ownerStrip(`${commandForm(page.csrf, mode === "reset" ? "computer.reset" : "computer.delete", c.revision, { botId: c.botId, computerId: c.id, generation: c.generation }, tr(k(`s14.destroy.${mode}_confirm`)), "s-btn danger")}<a class="s-btn" href="${computerPath(bot)}">${tr("s14.destroy.cancel")}</a>`, tr("s14.destroy.scope_note"))}</article>`;
}
/** Bot computer tab. Form regions refresh by signature; the visible status has its own refresh target. */
function computerPanel(page: S14Page, bot: Bot, surface: S14ComputerSurface): string {
  const view = page.overview.computers[bot.id] ?? { computer: null, lease: null }, c = view.computer, driver = driverOf(view, page.now);
  if (c && surface.confirm && lifecycle(c)) return destroyCard(page, bot, c, surface.confirm);
  const held = page.overview.effects.filter(effect => effect.botId === bot.id && effect.state === "pending");
  const minutes = driver === "owner" ? Math.ceil((view.lease!.expiresAt - page.now) / 60000) : 0;
  const workKey = JSON.stringify(surface.eligible.slice(0, 3).map(item => [item.id, item.revision]));
  const key = `${c?.revision ?? 0}.${c?.generation ?? 0}.${view.lease?.revision ?? 0}`, region = (id: string, html: string) => `<div class="s-stack" id="${id}" data-sig="${e(`${key}.${driver}.${held.length}.${minutes}${id === "s14-computer-more" ? `.${workKey}` : ""}`)}">${html}</div>`;
  const phase = c ? `${computerWord(view)} · ${leaseWord(view, bot, page.now)}` : computerWord(view);
  return `<div class="s-stack" data-computer="${e(bot.id)}" data-key="${e(key)}"><div class="s-between"><p class="s-sub">${tr("s14.computer.lead")}</p>${computerPill(view, "s14-computer-status")}</div>
    ${region("s14-live", `<span hidden data-phase="${e(phase)}"></span>${heldNotice(held)}${computerBanner(bot, view, surface)}${c ? leaseBar(page, bot, view) : ""}`)}
    ${region("s14-computer-screen", `${c ? screenView(page, bot, view, surface, driver) : ""}${driver === "owner" ? inputControls(page, bot, view) : ""}`)}
    ${region("s14-computer-more", `${openCards(page, bot, view, surface)}${c ? `${computerFacts(page, c)}${lifecycleStrip(page, bot, c)}${activityLog(surface.activity)}` : ""}`)}</div>`;
}
/** Work's view of the computers it may use. Takeover lives on the Bot page, where the 1280 px surface has room and one no-script path. */
function computerTab(page: S14Page, view: WorkView): string {
  const rows = (view.grant?.bots ?? []).map(item => { const bot = page.state.bots.find(b => b.id === item.id) ?? item, current = page.overview.computers[bot.id] ?? { computer: null, lease: null };
    return `<a class="s-work-row" href="${computerPath(bot)}"><span><span>${e(botName(bot))}</span><small>${e(leaseWord(current, bot, page.now))}</small></span>${computerPill(current)}</a>`; }).join("");
  return `<p class="s-sub">${tr("s14.work.computer_lead")}</p><div>${rows}</div>`;
}

function homePage(page: S14Page, view: Extract<S14View, { kind: "home" }>): string {
  const first = !page.state.replies.length && !page.work.length, name = page.state.owner?.name ?? "";
  const starters = first ? `<ul class="s-starters" aria-label="${tr("s14.home.examples")}"><li><a href="/?example=1#s14-text">${tr("s14.home.example_1")}</a></li><li><a href="/?example=2#s14-text">${tr("s14.home.example_2")}</a></li></ul><p class="s-note">${tr("s14.home.example_note")}</p>` : "";
  const team = page.state.bots.map(bot => `<a class="s-bot-mini" href="/team/${e(bot.id)}">${tile(bot, ({ working: "working", queued: "hollow", waiting: "waiting", idle: "" })[page.overview.botStates[bot.id] ?? "idle"], "small")}<span><b>${e(botName(bot))}</b><small>${tr(k(`s14.bot_state.${page.overview.botStates[bot.id] ?? "idle"}`))}</small></span></a>`).join("");
  const jit = page.state.bots.find(bot => bot.id === "jit");
  const chats = `<section class="s-home-chats" aria-labelledby="s14-home-chats"><h2 class="s-section-t" id="s14-home-chats">${tr("s14.nav.chats")}</h2><ul>${page.state.conversations.map(item => `<li><a href="/chats/${e(item.id)}#latest">${e(chatLabel(page, item))}</a></li>`).join("")}</ul>${jit ? newChat(page, jit) : ""}</section>`;
  return shell(page, tr("s14.nav.home"), `<div class="s-home"><section class="s-hello"><span>${logoMark({ size: 48 })}</span><h2>${tr("s14.home.greeting")} ${e(name)}</h2><p class="s-sub">${tr("s14.home.prompt")}</p></section>${notice(view.notice)}${composer(page, view.conversation, view.bot, "home", view.draft)}${starters}
    <section aria-labelledby="s14-waiting"><h2 class="s-section-t" id="s14-waiting">${tr("s14.attention.title")}</h2>${attentionList(page)}</section><section aria-labelledby="s14-team-now"><h2 class="s-section-t" id="s14-team-now">${tr("s14.home.team_now")}</h2><div class="s-team-now">${team}</div></section>${chats}</div>`, { current: "home" });
}
function chatPage(page: S14Page, view: Extract<S14View, { kind: "chat" }>): string {
  const { chat, bot } = view, work = page.work.filter(item => item.conversationId === chat.conversation.id);
  const live = chat.replies.some(reply => reply.state === "queued" || reply.state === "running") || work.some(liveWork);
  const body = chat.messages.length || work.length ? thread(page, chat, bot) : emptyThread(bot);
  const content = `<div class="s-col"><div id="s14-live" class="s-thread" data-revision="${chat.conversation.revision}">${bot.id === "jit" ? "" : banner("", tr("s14.chat.direct"), tr("s14.chat.direct_detail"))}${body}</div><span id="latest"></span>${live ? `<p class="s-note"><a class="s-link-text" href="/chats/${e(chat.conversation.id)}#latest">${tr("s14.refresh")}</a></p>` : ""}</div>`;
  return shell(page, chatLabel(page, chat.conversation), content, { current: `chat:${chat.conversation.id}`, subtitle: tr("s14.chat.subtitle"), inChat: true, live, bot, action: newChat(page, bot, "s-btn", ' class="s-hdr-act"'), dock: `<div class="s-dock">${notice(view.notice)}${composer(page, chat.conversation, bot, "chat", view.draft)}</div>`, ...(view.pane ? { pane: workPane(page, view.pane.view, view.pane.tab, chat.conversation, bot, view.pane.research) } : {}) });
}
function workListPage(page: S14Page): string {
  const group = (title: string, items: Work[], id: string) => items.length ? `<section aria-labelledby="${id}"><h2 class="s-section-t" id="${id}">${title}</h2>${items.map(item => `<a class="s-work-row" href="/work/${e(item.id)}"><span><span>${e(item.title)}</span><small>${when(item.createdAt)}</small></span>${workPill(item.state)}</a>`).join("")}</section>` : "";
  const by = (...states: Work["state"][]) => page.work.filter(item => states.includes(item.state));
  return shell(page, tr("s14.nav.work"), `<div class="s-col s-col-wide"><section aria-labelledby="s14-work-waiting"><h2 class="s-section-t" id="s14-work-waiting">${tr("s14.attention.title")}</h2>${attentionList(page)}</section>${group(tr("s14.work_list.needs_you"), by("waiting", "blocked"), "s14-group-you")}${group(tr("s14.work_list.progress"), by("queued", "running", "stopping"), "s14-group-progress")}${group(tr("s14.work_list.unstarted"), by("proposed", "accepted"), "s14-group-unstarted")}${group(tr("s14.work_list.finished"), by("ready", "stopped"), "s14-group-finished")}${group(tr("s14.work_list.rejected"), by("rejected"), "s14-group-rejected")}${page.work.length ? "" : `<p class="s-sub">${tr("s14.work_list.empty")}</p>`}</div>`, { current: "work" });
}
function workPage(page: S14Page, view: Extract<S14View, { kind: "work" }>): string {
  const work = view.view.work;
  return shell(page, work.title, `<div class="s-col"><div class="s-between">${receiptLine(work, view.view) || "<span></span>"}${workPill(work.state, "s14-work-status")}</div>${workTabs(view.view, view.tab, `/work/${e(work.id)}`)}<div class="s-stack" id="s14-pane-live">${workBody(page, view.view, view.tab, view.conversation, view.bot, view.research, `/work/${e(work.id)}`)}</div>${liveWork(work) ? `<p class="s-note"><a class="s-link-text" href="/work/${e(work.id)}">${tr("s14.refresh")}</a></p>` : ""}<p><a class="s-link-text" href="/chats/${e(view.conversation.id)}">${tr("s14.work.back_to_chat")}</a></p></div>`, { current: "work", live: liveWork(work) });
}
function teamPage(page: S14Page): string {
  const row = (bot: Bot) => `<a class="s-work-row" href="/team/${e(bot.id)}"><span class="s-row">${tile(bot, ({ working: "working", queued: "hollow", waiting: "waiting", idle: "" })[page.overview.botStates[bot.id] ?? "idle"])}<span><b>${e(botName(bot))}</b><small>${e(botDuty(bot))}</small>${page.overview.computers[bot.id]?.computer ? `<small>${tr("s14.proposal.computer")} · ${computerWord(page.overview.computers[bot.id]!)}</small>` : ""}</span></span>${pill(tr(k(`s14.bot_state.${page.overview.botStates[bot.id] ?? "idle"}`)))}</a>`;
  return shell(page, tr("s14.nav.team"), `<div class="s-col"><p class="s-sub">${tr("s14.team.lead")}</p>${page.state.bots.map(row).join("")}<p class="s-note">${tr("s14.team.proposal_note")}</p></div>`, { current: "team" });
}
function botPage(page: S14Page, view: Extract<S14View, { kind: "bot" }>): string {
  const { bot, conversation, computer } = view, route = page.state.routes.find(r => r.id === bot.routeId), current = page.overview.computers[bot.id] ?? { computer: null, lease: null };
  const list = (items: string[]) => items.length ? items.map(item => `<span class="s-mono">${e(item)}</span>`).join(" · ") : tr("s14.bot.none");
  const tabs = `<nav class="s-worktabs" aria-label="${tr("s14.bot.tab_label")}"><a href="/team/${e(bot.id)}"${computer ? "" : ' aria-current="page"'}>${tr("s14.bot.tab_overview")}</a><a href="${computerPath(bot)}"${computer ? ' aria-current="page"' : ""}>${tr("s14.tab.computer")}</a></nav>`;
  const overview = () => `<div class="s-row">${tile(bot, "", "large")}<p class="s-sub">${e(botDuty(bot))}</p></div><dl class="s-kv"><dt>${tr("s14.bot.state")}</dt><dd>${tr(k(`s14.bot_state.${page.overview.botStates[bot.id] ?? "idle"}`))}</dd><dt>${tr("s14.proposal.route")}</dt><dd>${routeText(route)}</dd><dt>${tr("s14.bot.tools")}</dt><dd>${list(bot.capabilities.tools)}</dd><dt>${tr("s14.bot.resources")}</dt><dd>${list(bot.capabilities.resources)}</dd><dt>${tr("s14.proposal.logins")}</dt><dd>${tr("s14.proposal.none_granted")}</dd><dt>${tr("s14.proposal.computer")}</dt><dd><a class="s-link-text" href="${computerPath(bot)}">${computerWord(current)}</a></dd><dt>${tr("s14.bot.revision")}</dt><dd class="s-mono">r${bot.revision}</dd></dl><p class="s-note">${tr("s14.bot.ceiling_note")}</p><p class="s-row">${conversation ? `<a class="s-btn primary" href="/chats/${e(conversation.id)}">${tr("s14.bot.direct")}</a>` : ""}${newChat(page, bot)}<a class="s-btn" href="/memory?scope=${e(bot.id)}">${tr("s14.bot.memory")}</a></p>`;
  return shell(page, botName(bot), `<div class="s-col${computer ? " s-col-wide" : ""}">${tabs}${computer ? computerPanel(page, bot, computer) : overview()}</div>`, { current: "team", bot, ...(computer ? { subtitle: tr("s14.computer.title") } : {}) });
}
function preferences(page: S14Page): string {
  const owner = page.state.owner, theme = owner?.theme ?? "system", radio = (name: string, value: string, label: string, checked: boolean, lang = "") => `<label class="s-check"><input type="radio" name="${name}" value="${value}"${checked ? " checked" : ""}><span${lang ? ` lang="${lang}"` : ""}>${e(label)}</span></label>`;
  return `<section class="s-card s-stack" aria-labelledby="s14-prefs"><h2 id="s14-prefs">${tr("s14.more.preferences")}</h2><form class="s-stack" method="post" action="/s14/forms/preferences">${flat(page.csrf, page.state.revision)}<div class="s-prefs-grid"><fieldset class="s-field s-prefs"><legend>${tr("s14.setup.language")}</legend>${radio("language", "th", "ไทย", owner?.language === "th", "th")}${radio("language", "en", "English", owner?.language === "en", "en")}</fieldset><fieldset class="s-field s-prefs"><legend>${tr("s14.more.theme")}</legend>${(["system", "light", "dark"] as const).map(value => radio("theme", value, tr(`s14.more.theme_${value}`), theme === value)).join("")}</fieldset></div><div><button class="s-btn">${tr("s14.more.save")}</button></div></form></section>`;
}
function morePage(page: S14Page, saved: boolean): string {
  const planned = (["report", "routine"] as const).map(item => `<li>${tr(k(`s14.more.${item}`))} · ${pill(tr("s14.more.not_ready"))}</li>`).join("");
  return shell(page, tr("s14.nav.more"), `<div class="s-col">${saved ? banner("ok", tr("s14.more.saved"), tr("s14.more.saved_detail")) : ""}<section class="s-card" aria-labelledby="s14-account"><h2 id="s14-account">${tr("s14.more.account")}</h2><dl class="s-kv"><dt>${tr("s14.setup.name")}</dt><dd>${e(page.state.owner?.name ?? "")}</dd><dt>${tr("s14.proposal.route")}</dt><dd>${page.state.routes.map(route => routeText(route)).join(" · ") || tr("s14.proposal.no_route")}<br><span class="s-note">${tr("s14.setup.route_configured_detail")}</span></dd></dl></section>${preferences(page)}
    <nav class="s-card" aria-label="${tr("s14.more.places")}"><ul class="s-history"><li><a class="s-link-text" href="/memory">${tr("s14.more.memory")}</a></li><li><a class="s-link-text" href="/settings/provider">${tr("s14.more.provider")}</a></li>${page.state.bots.map(bot => `<li><a class="s-link-text" href="${computerPath(bot)}">${tr("s14.tab.computer")} · ${e(botName(bot))}</a></li>`).join("")}<li><a class="s-link-text" href="/settings/web">${tr("s14.more.web")}</a></li></ul></nav>
    <section class="s-card" aria-labelledby="s14-planned"><h2 id="s14-planned">${tr("s14.more.planned")}</h2><ul class="s-history">${planned}</ul></section><form method="post" action="/s14/logout">${hidden("csrf", page.csrf)}<button class="s-btn">${tr("s14.more.sign_out")}</button></form></div>`, { current: "more" });
}

/** Renders one signed-in surface in the owner's language. Every value from a query is escaped here. */
export function renderS14(page: S14Page): string {
  return withTheme(page.state.owner?.theme ?? "system", () => withLocale(page.locale, () => {
    const view = page.view;
    switch (view.kind) {
      case "setup": return setupPage(page, view);
      case "home": return homePage(page, view);
      case "chat": return chatPage(page, view);
      case "work-list": return workListPage(page);
      case "work": return workPage(page, view);
      case "team": return teamPage(page);
      case "bot": return botPage(page, view);
      case "proposal": return shell(page, `${tr("s14.proposal.title")} r${view.proposal.revision}`, `<div class="s-col">${proposalCard(page, view.proposal, view.history, "h2")}${proposalHistory(view.history, view.proposal)}<p><a class="s-link-text" href="/chats/${e(page.state.conversations.find(c => c.id === view.proposal.conversationId)?.id ?? "")}">${tr("s14.work.back_to_chat")}</a></p></div>`, { current: "team" });
      case "effect": return shell(page, tr("s14.effect.card"), `<div class="s-col">${effectSlip(page, view.effect, view.history, "h2")}${effectHistory(view.history, view.effect)}<p><a class="s-link-text" href="/work/${e(view.effect.workId)}">${tr("s14.effect.back_to_work")}</a></p></div>`, { current: "work" });
      case "more": return morePage(page, view.saved);
      case "settings-web": return webSettingsPage(page, view);
      case "settings-provider": return providerSettingsPage(page, view);
      default: return renderMemorySurface(page, view);
    }
  }));
}
