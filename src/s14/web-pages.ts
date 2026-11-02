import { currentLocale, tr, trMaybe, withLocale, type Locale, type MessageKey } from "../i18n";
import { s14Colors as colorTokens } from "./web-design";
import { logoLockup, logoMark } from "../web-logo";
import type { ThemePreference } from "../web-layout";
import type { Attempt, Effect, Work, WorkView } from "./authority-types";
import type { BotComputer, ComputerActivity, ComputerView } from "./computer-types";
import type { Bot, BotProposal, Conversation, Message, Reply, Route } from "./types";
import type { AttentionSetting } from "./routine-types";
import { s14AssetUrl } from "./web-assets";
import type { S14Page, S14WebCommand } from "./web";
import { workLimitBounds, type S14Chat, type S14ComputerSurface, type S14Draft, type S14View, type S14WorkTab } from "./web-product";
import type { S14WorkResearch } from "./web-product-memory";
import type { S14NoticeRef, S14RoutineNeed } from "./web-product-routines";
import type { S14ScopeChoice } from "./web-product-sharing";
import { providerSettingsPage, setupPage } from "./web-first-run";
import { renderMemorySurface } from "./web-memory";
import { recoveryNotice, recoveryPanel } from "./web-recovery";
import { recoveryPage } from "./web-recovery-page";
import { renderBackupSurface } from "./web-backup";
import { lifecycleLanding, lifecycleLive, lifecyclePill, lifecycleStatus, renderLifecycleSurface } from "./web-lifecycle";
import type { BotLifecycle } from "./bot-lifecycle-types";
import { codingTab, renderCodingSurface } from "./web-coding";
import { gitEffectPage, gitSummarySlip } from "./web-coding-effect";
import { generalTool, gitAction, type S14WorkCoding } from "./web-product-coding";
import { briefTab } from "./web-personal-brief";
import { renderPersonalSurface } from "./web-personal";
import { personalSlip } from "./web-personal-effect";
import { renderRoutineSurface, routineFindingNote } from "./web-routines";
import { renderSharingSurface } from "./web-sharing";
import { statementBanner, statementBlock, statementStrip, type S14StatementDraft } from "./web-statement";
import { recoveryReason } from "./web-product-recovery";
import { evidenceTab, researchNotice, webSettingsPage } from "./web-research";
import { limitValues, partialWork, type S14WorkTeam } from "./web-product-team";
import { reportHintPill, reportTab } from "./web-report";
import { miniLanes, teamProgress, usageBlock, workSettingsPage } from "./web-team";

export const e = (value: unknown) => String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
export const k = (key: string) => key as MessageKey;
const paths = {
  chat: '<path d="M20 11.5a8 8 0 0 1-8 8H5l-3 2 1.5-5A8 8 0 1 1 20 11.5Z"/>', arrow: '<path d="M12 19V5m-6 6 6-6 6 6"/>', back: '<path d="M15 6l-6 6 6 6"/>',
  work: '<path d="M4 6h1.5M4 12h1.5M4 18h1.5M9 6h11M9 12h11M9 18h11"/>', team: '<circle cx="9" cy="9" r="3"/><path d="M3 20v-1a6 6 0 0 1 12 0v1"/><path d="M16 6.5a3 3 0 0 1 0 5.5M18 20v-1a6 6 0 0 0-2.5-4.9"/>',
  more: '<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>', home: '<path d="M4 11l8-7 8 7v9H4Z"/>',
  memory: '<path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3Z"/><path d="M9 9h6M9 13h4"/>', lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>', info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v1"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', alert: '<path d="M12 4 2.5 20h19Z"/><path d="M12 10v5m0 2.5v.5"/>', check: '<path d="m5 12 4 4L19 6"/>', clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', close: '<path d="M6 6l12 12M18 6 6 18"/>', stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
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
/** A refused post, in the accessibility tree as an alert. */
export const notice = (code: string | null) => code ? `<div role="alert">${banner("warn", noticeText(code), trMaybe(`s14.next.${code}`) ?? "")}</div>` : "";
/** A landing line after a command, in the accessibility tree as a status. It wraps a banner that says what was saved or changed. */
export const announced = (html: string) => html ? `<div role="status">${html}</div>` : "";

/** Sign-in page; before an owner exists it points at the one-time link instead of a dead form. */
export function renderLogin(locale: Locale, code: string | null, provisioned: boolean, theme: ThemePreference = "system"): string {
  return withTheme(theme, () => withLocale(locale, () => standalone(tr("s14.login.title"), `<div class="auth-card"><span class="brand">${logoLockup({ height: 44, label: "Jit" })}</span><h1>${tr("s14.login.title")}</h1>${provisioned ? `<p>${tr("s14.login.prompt")}</p>
    ${code ? `<div role="alert">${banner("warn", noticeText(code), trMaybe(`s14.next.${code}`) ?? "")}</div>` : ""}<form method="post" action="/s14/login"><label for="s14-password">${tr("s14.login.password")}</label><input id="s14-password" type="password" name="password" required autocomplete="current-password"><button class="primary">${tr("s14.login.submit")}</button></form>`
    : `<p>${tr("s14.login.unprovisioned")}</p><p class="s-note">${tr("s14.login.unprovisioned_note")}</p>`}</div>`)));
}
/** Refused post or missing page: the cause in words, then one way forward. No authority control is rendered here. */
export function renderFailure(locale: Locale, code: string, next: string, theme: ThemePreference = "system"): string {
  // Typed computer input is never echoed into a page, so the composer's "your text is kept" must not appear here.
  const forward = () => (next.includes("tab=computer") ? trMaybe(`s14.next.computer.${code}`) : null) ?? trMaybe(`s14.next.${code}`) ?? tr("s14.next.generic");
  return withTheme(theme, () => withLocale(locale, () => standalone(tr("s14.error.title"), `<div class="s-notice-card" role="alert"><h1>${e(noticeText(code))}</h1><p>${e(forward())}</p><p class="s-mono s-meta">${e(code)}</p><p><a class="s-btn primary" href="${e(next)}">${tr(next === "/s14/login" ? "s14.login.submit" : next === "/" ? "s14.error.home" : "s14.error.open_latest")}</a></p></div>`)));
}
/** S14-AC01 refusal, served with no store, lock or worker open. It cannot change anything, so it has no form. */
export function renderRefusal(locale: Locale, store: string): string {
  return withLocale(locale, () => standalone(tr("s14.legacy.title"), `<div class="s-notice-card"><span class="brand">${logoLockup({ height: 44, label: "Jit" })}</span><h1>${tr("s14.legacy.title")}</h1><p>${tr("s14.legacy.lead")}</p>
    ${banner("ok", tr("s14.legacy.untouched"), tr("s14.legacy.untouched_detail"))}<dl class="s-kv"><dt>${tr("s14.legacy.selected")}</dt><dd class="s-mono">${e(store)}</dd><dt>${tr("s14.legacy.reason")}</dt><dd>${tr("s14.legacy.reason_detail")}</dd></dl>
    <section class="s-stack" aria-labelledby="s14-fresh"><h2 id="s14-fresh">${tr("s14.legacy.fresh_title")}</h2><p class="s-sub">${tr("s14.legacy.fresh_detail")}</p><pre class="s-exact">JIT_S14_DATABASE=.local/s14-fresh/application.sqlite bun src/main.ts serve --s14</pre></section>
    <section class="s-stack" aria-labelledby="s14-back"><h2 id="s14-back">${tr("s14.legacy.back_title")}</h2><p class="s-sub">${tr("s14.legacy.back_detail")}</p><pre class="s-exact">bun src/main.ts serve --legacy</pre></section></div>`));
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
export const workPill = (state: Work["state"], id = "") => pill(tr(k(`s14.work_state.${state}`)), ...workTone[state], id);
const effectTone: Record<Effect["state"], [string, string]> = { pending: ["warn", "!"], approved: ["strong", ""], denied: ["", ""], expired: ["", ""], executing: ["strong", ""], succeeded: ["ok", "✓"], failed: ["danger", "×"], unknown: ["danger", "?"], changed: ["warn", "!"] };
export const effectPill = (state: Effect["state"]) => pill(tr(k(`s14.effect_state.${state}`)), ...effectTone[state]);
const workDot: Partial<Record<Work["state"], string>> = { queued: "hollow", running: "working", waiting: "waiting", ready: "ready", blocked: "waiting", stopping: "hollow" };
const attemptDot: Partial<Record<Attempt["state"], string>> = { running: "working", waiting: "waiting", committed: "ready", interrupted: "failed" };

/** Deletion leaves a placeholder identity, so a deleted Bot reads as deleted rather than as the placeholder. */
export const botGone = (bot: Pick<Bot, "name">) => bot.name === "[deleted]";
export const botName = (bot: Pick<Bot, "id" | "name">) => bot.id === "jit" ? tr("s14.jit") : botGone(bot) ? tr("s14.bot.deleted_name") : bot.name;
const botDuty = (bot: Pick<Bot, "id" | "name" | "responsibility">) => bot.id === "jit" ? tr("s14.jit_duty") : botGone(bot) ? tr("s14.life.state.deleted") : bot.responsibility;
function initial(name: string): string { return [...new Intl.Segmenter(currentLocale(), { granularity: "grapheme" }).segment(name)][0]?.segment ?? "?"; }
/** Tile plus dot. Decorative: the state always appears as a word beside it. */
export function tile(bot: Pick<Bot, "id" | "name">, dot = "", scale = ""): string {
  if (bot.id === "jit") return `<span class="s-tile jit ${scale}" aria-hidden="true"${dot ? ` data-dot="${dot}"` : ""}>${logoMark({ size: scale === "large" ? 56 : 32 })}</span>`;
  return `<span class="s-tile ${scale}" aria-hidden="true"${dot ? ` data-dot="${dot}"` : ""}><i></i>${e(botGone(bot) ? "·" : initial(bot.name))}</span>`;
}
export const routeText = (route: Route | undefined) => route ? `<span class="s-mono">${e(route.provider)} · ${e(route.model)}</span>` : tr("s14.proposal.no_route");

const needsOwner = (effect: Effect) => effect.state === "pending" || (effect.state === "unknown" && !effect.resolution);
/** Everything that needs the owner, counted once for the nav badge and listed on Home and Work. */
function attention(page: S14Page) {
  const routines = page.overview.routines, found = new Set(routines?.findings ?? []);
  return { effects: page.overview.effects.filter(needsOwner), proposals: page.state.proposals.filter(p => p.state === "proposed"), tasks: page.work.filter(w => w.state === "proposed" && !found.has(w.id)), recovery: page.overview.recovery?.open ?? 0, routines: routines?.needs ?? [], updates: routines?.updates ?? [], accounts: page.overview.personal?.needs ?? [] };
}
const attentionCount = (page: S14Page) => { const a = attention(page); return a.effects.length + a.proposals.length + a.tasks.length + a.routines.length + a.accounts.length + (a.recovery ? 1 : 0); };
/** Clears one notice at its revision. The label is fixed, and it answers nothing: `described` names the row for a screen reader, as a description only. */
export function dismissForm(page: S14Page, notice: NonNullable<S14NoticeRef>, from: "home" | "work" | "routine", described = "", routineId = ""): string {
  return `<form method="post" action="/s14/forms/attention-dismiss">${flat(page.csrf, notice.revision)}${hidden("noticeId", notice.id)}${hidden("from", from)}${routineId ? hidden("routineId", routineId) : ""}<button class="s-btn"${described ? ` aria-describedby="${described}"` : ""}>${tr("s14.attention.dismiss")}</button></form>`;
}
/** A row with its Dismiss beside the link, never inside it. A row with no notice to clear is the plain row. */
function noticeRow(page: S14Page, from: "home" | "work", notice: S14NoticeRef, link: (described: string) => string): string {
  if (!notice) return `<li>${link("")}</li>`;
  const described = `s14-notice-${e(notice.id)}`;
  return `<li class="s-attention-row">${link(described)}${dismissForm(page, notice, from, described)}</li>`;
}
/** Routine rows carry a fixed heading, with the title as escaped small text beneath. At most one row per routine and kind. */
function routineRow(page: S14Page, from: "home" | "work", item: S14RoutineNeed): string {
  const tone: Record<S14RoutineNeed["need"], [string, string, string]> = { decision: ["warn", "!", "#findings"], failed: ["danger", "×", ""], blocked: ["warn", "!", ""] };
  const [cls, glyph, anchor] = tone[item.need], label = tr(k(`s14.attention.routine.${item.need}`));
  return noticeRow(page, from, item.notice, id => `<a href="/routines/${e(item.routineId)}${anchor}"><span${id ? ` id="${id}"` : ""}><span>${label}${item.count > 1 ? ` · ${item.count}` : ""}</span><small>${e(item.title)}</small>${item.delivery ? `<small>${tr(k(`s14.routine.delivery.${item.delivery}`))}</small>` : ""}</span>${pill(tr(k(`s14.attention.routine_word.${item.need}`)), cls, glyph)}</a>`);
}
/** Grouped "needs me": one heading per kind of decision, in the order a mistake would cost most. Only groups with rows appear. */
function attentionList(page: S14Page, from: "home" | "work"): string {
  const a = attention(page), botOf = (id: string) => page.state.bots.find(b => b.id === id);
  const group = (name: string, rows: string[]) => rows.length ? `<section class="s-attention-group" aria-label="${tr(k(`s14.attention.group.${name}`))}"><h3>${tr(k(`s14.attention.group.${name}`))}</h3><ul class="s-attention">${rows.join("")}</ul></section>` : "";
  const groups = [
    group("effects", a.effects.map(effect => `<li><a href="/effects/${e(effect.id)}#slip"><span>${e(botName(botOf(effect.botId) ?? { id: effect.botId, name: effect.botId }))} ${tr("s14.effect.asks")} ${e(tr(k(`s14.effect_kind.${effect.action.kind}`)))}</span>${effectPill(effect.state)}</a></li>`)),
    group("routines", a.routines.map(item => routineRow(page, from, item))),
    group("accounts", a.accounts.map(item => `<li><a href="/settings/google/connections/${e(item.connectionId)}#next"><span><span>${tr(k(`s14.google.need.${item.need}`))}</span><small>${tr(k(`s14.google.service.${item.service}`))} · ${e(item.account)}</small></span>${pill(tr(k(`s14.google.need_word.${item.need}`)), "warn", "!")}</a></li>`)),
    group("proposals", [...a.proposals.map(proposal => `<li><a href="/proposals/${e(proposal.id)}"><span>${tr("s14.proposal.attention")} · r${proposal.revision}</span>${pill(tr("s14.work_state.proposed"), "strong")}</a></li>`),
    ...a.tasks.map(task => `<li><a href="/work/${e(task.id)}"><span>${tr("s14.task.attention")} · r${task.revision}</span>${pill(tr("s14.work_state.proposed"), "strong")}</a></li>`)]),
    group("recovery", a.recovery ? [`<li><a href="/recovery"><span>${tr("s14.recovery.attention")}</span>${pill(`${a.recovery}`, "warn", "!")}</a></li>`] : []),
    group("updates", a.updates.map(item => noticeRow(page, from, item.notice, id => `<a href="/routines/${e(item.routineId)}"><span${id ? ` id="${id}"` : ""}><span>${tr("s14.attention.routine.report")}</span><small>${e(item.title)}</small></span><span class="s-meta">${when(item.at)}</span></a>`))),
  ].join("");
  const dismissable = a.routines.some(item => item.notice) || a.updates.some(item => item.notice);
  return groups ? `<div class="s-attention-groups">${groups}${dismissable ? `<p class="s-note">${tr("s14.attention.dismiss_note")}</p>` : ""}</div>` : `<p class="s-sub">${tr("s14.attention.none")}</p>`;
}

/** Owner-facing label: the Seam has no chat title, so a Bot's later chats carry their order of creation. Newest comes first in Home. */
export function chatLabel(page: S14Page, conversation: Conversation): string {
  const same = page.state.conversations.filter(item => item.botId === conversation.botId), order = same.length - same.findIndex(item => item.id === conversation.id);
  const bot = page.state.bots.find(item => item.id === conversation.botId), name = botName(bot ?? { id: conversation.botId, name: conversation.botId });
  return same.some(item => item.id === conversation.id) && same.length > 1 && order > 1 ? `${name} · ${tr("s14.chat.number")} ${order}` : name;
}
/** Starts an empty chat. It is not an authority control: conversation membership grants nothing. */
function newChat(page: S14Page, bot: Bot, cls = "s-btn", extra = ""): string {
  return bot.enabled ? `<form method="post" action="/s14/forms/new-chat"${extra}>${flat(page.csrf, bot.revision)}${hidden("botId", bot.id)}<button class="${cls}">${icon("plus")}<span class="s-label">${tr("s14.chat.new")}</span></button></form>` : "";
}
interface ShellOptions { current?: "home" | "work" | "team" | "memory" | "routines" | "more" | `chat:${string}`; subtitle?: string; dock?: string; pane?: string; inChat?: boolean; live?: boolean; bot?: Bot; action?: string }
/** Shared Plain shell. Navigation and attention links are read-only; typed forms retain their own authority. */
export function shell(page: S14Page, title: string, content: string, options: ShellOptions = {}): string {
  const here = (name: string) => options.current === name ? ' aria-current="page"' : "", count = attentionCount(page);
  const jit = page.state.bots.find(bot => bot.id === "jit");
  const botLinks = page.state.bots.filter(bot => !botGone(bot)).sort((a, b) => Number(b.id === "jit") - Number(a.id === "jit")).map(bot => {
    const conversation = page.state.conversations.find(item => item.botId === bot.id);
    const current = options.bot?.id === bot.id && options.inChat ? ' aria-current="page"' : "";
    return `<li><a class="s-link" href="${bot.id === "jit" ? "/" : conversation ? `/chats/${e(conversation.id)}` : `/team/${e(bot.id)}`}"${current}>${tile(bot, page.overview.botStates[bot.id] === "working" ? "working" : "", "small")}<span class="s-label">${e(botName(bot))}</span></a></li>`;
  }).join("");
  const chats = page.state.conversations.map(conversation => {
    const bot = page.state.bots.find(item => item.id === conversation.botId);
    return bot && !botGone(bot) ? `<li><a class="s-link s-chat-link" href="/chats/${e(conversation.id)}#latest"${here(`chat:${conversation.id}`)}><span class="s-label">${e(chatLabel(page, conversation))}</span></a></li>` : "";
  }).join("");
  const badge = count ? `<span class="s-nav-number">${count}</span>` : "";
  const navigation = (mobile: boolean) => `<nav aria-label="${tr("s14.nav.label")} · ${tr(mobile ? "s14.plain.mobile" : "s14.plain.desktop")}">
    ${jit ? newChat(page, options.bot ?? jit, "s-link s-new-chat") : ""}
    <ul><li><a class="s-link" id="${mobile ? "s14-mobile-work" : "s14-nav-work"}" href="/work"${here("work")}>${icon("work")}<span class="s-label">${tr("s14.nav.work")}</span>${badge}</a></li>${mobile ? `<li><a class="s-link" href="/more">${icon("more")}<span>${tr("s14.plain.manage")}</span></a></li>` : ""}</ul>
    <p class="s-nav-sec">${tr("s14.plain.bots")}</p><ul class="s-bot-list">${botLinks}</ul>
    <p class="s-nav-sec">${tr("s14.nav.chats")}</p><ul class="s-chat-list">${chats}</ul>
    <div class="s-nav-foot"><a class="s-link" href="/more"${here("more")}>${icon("more")}<span class="s-label">${tr("s14.plain.manage")}</span></a>${mobile ? "" : `<p class="s-nav-note">${tr("s14.plain.sidebar_note")}</p>`}</div></nav>`;
  const nav = `<aside class="s-nav" aria-label="${tr("s14.plain.bots")}"><a class="s-lockup" href="/" aria-label="${tr("s14.jit")}">${logoLockup({ height: 36, label: "Jit" })}</a>${navigation(false)}</aside>`;
  const mobile = `<details class="s-mobile-nav"><summary aria-label="${tr("s14.plain.navigation")}">${icon("more")}</summary><div class="s-mobile-panel">${navigation(true)}</div></details>`;
  const needs = `<a class="s-needs" id="s14-attention-badge" href="/work#s14-work-waiting">${icon(count ? "alert" : "work")}<span>${tr(count ? "s14.nav.waiting" : "s14.nav.work")}${count ? ` ${count}` : ""}</span></a>`;
  const sent = page.view.kind === "chat" ? page.view.sent ?? "" : "";
  return documentPage(title, `<div class="s-app" data-browser-key="${e(page.browserKey ?? "")}" data-committed="${e(sent)}" data-conversation="${e(page.view.kind === "chat" ? page.view.chat.conversation.id : "")}">${nav}<main class="s-main" id="main-content"${options.pane ? ' data-pane="open"' : ""}${options.inChat ? " data-in-chat" : ""}><div class="s-chatcol"><header class="s-hdr">${mobile}${options.bot ? tile(options.bot, "") : ""}<div class="s-hdr-t"><h1>${e(title)}</h1>${options.subtitle ? `<small>${e(options.subtitle)}</small>` : ""}</div>${needs}${options.action ?? ""}</header>
    <div class="s-scroll"${options.live || page.work.some(liveWork) || page.state.replies.some(reply => reply.state === "running" || reply.state === "queued") ? ' data-live="true"' : ""}>${content}</div>${options.dock ?? ""}</div>${options.pane ?? ""}</main><p class="sr-only" role="status" id="s-phase" data-reply="${tr("s14.live.reply")}"></p></div>`);
}

export function limitFields(values: { concurrent: number; minutes: number; reads: number }, title: MessageKey = "s14.limits.title"): string {
  const field = (name: "concurrent" | "minutes" | "reads", label: string) => `<label class="s-limit"><input type="number" name="${name}" min="${workLimitBounds[name][0]}" max="${workLimitBounds[name][1]}" value="${values[name]}" inputmode="numeric"><span>${e(label)}</span></label>`;
  return `<fieldset class="s-limits"><legend>${tr(title)}</legend>${field("concurrent", tr("s14.limits.concurrent"))}${field("minutes", tr("s14.limits.minutes"))}${field("reads", tr("s14.limits.reads"))}</fieldset>`;
}
/** `personal_read` never appears here: ticking an account names it, so ordinary work cannot gain an account gap by default. */
const toolOptions = (page: S14Page, bots: Bot[]) => page.policy.tools.filter(tool => generalTool(tool) && tool !== "personal_read" && bots.some(bot => bot.capabilities.tools.includes(tool)));
/** Bots and tools the grant may name. The conversation's Bot is fixed; everything else is visible and optional. */
function grantChoices(page: S14Page, lead: Bot, draft: S14Draft | null, workId: string | null = null): string {
  const others = page.state.bots.filter(bot => bot.id !== lead.id && bot.enabled);
  const tools = toolOptions(page, [lead, ...others]);
  const selected = [lead, ...others.filter(bot => draft?.bots.includes(bot.id))];
  const fixed = `<p class="s-check s-check-fixed"><span>${e(botName(lead))}<small>${tr("s14.grant.lead_fixed")}</small></span></p>`;
  const toolRows = tools.map(tool => `<label class="s-check"><input type="checkbox" name="tool:${e(tool)}" data-grant-label="${e(trMaybe(k(`s14.plain.tool.${tool}`)) ?? tool)}" value="on"${!tool.startsWith("effect_") && selected.some(bot => bot.capabilities.tools.includes(tool)) ? " checked" : ""}><span class="s-mono">${e(tool)}${tool.startsWith("effect_") ? `<small>${tr("s14.grant.effect_tool")}</small>` : ""}</span></label>`).join("");
  return `${hidden(`bot:${lead.id}`, lead.revision)}<fieldset class="s-field"><legend>${tr("s14.grant.bots_legend")}</legend>${fixed}${others.map(bot => `<label class="s-check"><input type="checkbox" name="bot:${e(bot.id)}" data-grant-label="${e(botName(bot))}" value="${bot.revision}"${draft?.bots.includes(bot.id) ? " checked" : ""}><span>${e(botName(bot))}</span></label>`).join("")}<p class="s-note">${e(named("s14.grant.places_note", lead))}</p></fieldset>
    ${toolRows ? `<fieldset class="s-field"><legend>${tr("s14.grant.tools")}</legend>${toolRows}</fieldset>` : ""}${shareChoices(page, [lead, ...others], draft, workId)}${accountChoices(page, [lead, ...others], draft)}`;
}
/** Accounts this start may read, unticked by default. One tick names the slot and the read tool together; the service rechecks Bot, revision and consent. */
export function accountChoices(page: S14Page, bots: Bot[], draft: Pick<S14Draft, "accounts"> | null, readable = false): string {
  const items = (page.overview.personal?.accounts ?? []).filter(item => bots.some(bot => bot.id === item.botId) && (item.read || !readable));
  const row = (item: typeof items[number]) => { const bot = bots.find(entry => entry.id === item.botId)!; return `<label class="s-check"><input type="checkbox" data-grant-label="${e(`${item.service} · ${item.account} · ${botName(bot)}`)}" name="${item.read ? "account" : "account-write"}:${e(item.scopeId)}" value="${item.revision}"${draft?.accounts?.includes(item.scopeId) ? " checked" : ""}><span>${tr(k(`s14.google.service.${item.service}`))} · <span class="s-mono">${e(item.account)}</span><small>${tr("s14.google.start_for")} ${e(botName(bot))}${item.read ? "" : ` · ${tr("s14.google.start_write_only")}`}</small></span></label>`; };
  return items.length ? `<fieldset class="s-field"><legend>${tr("s14.google.start_legend")}</legend>${items.map(row).join("")}<p class="s-note">${tr("s14.google.start_note")}</p></fieldset>` : "";
}
/** Shares this start may name, unticked by default. The service rechecks the receiver, work and revision, so a label here grants nothing. */
export function shareChoices(page: S14Page, bots: Bot[], draft: Pick<S14Draft, "scopes"> | null, workId: string | null): string {
  const items = (page.overview.scopes ?? []).filter(item => bots.some(bot => bot.id === item.receiverBotId) && (item.workId === null || item.workId === workId));
  const row = (item: S14ScopeChoice) => { const receiver = bots.find(bot => bot.id === item.receiverBotId)!; return `<label class="s-check"><input type="checkbox" name="scope:${e(item.id)}" data-grant-label="${e(item.label)}" value="${item.revision}"${draft?.scopes?.includes(item.id) ? " checked" : ""}><span>${item.kind === "memory" ? `${tr("s14.share.memory_label")} ${e(item.label)}` : `<span class="s-mono">${e(item.label)}</span>`}<small>${tr("s14.share.for")} ${e(botName(receiver))}</small></span></label>`; };
  return items.length ? `<fieldset class="s-field"><legend>${tr("s14.share.start_legend")}</legend>${items.map(row).join("")}<p class="s-note">${tr("s14.share.start_note")}</p></fieldset>` : "";
}
/** Owner-written evidence targets: the one way `covered` becomes reachable, since a model cannot set its own. */
const evidenceField = (value: string) => `<label class="s-field"><span>${tr("s14.composer.evidence")}</span><textarea name="evidence" rows="2" maxlength="8000" placeholder="${tr("s14.composer.evidence_placeholder")}">${e(value)}</textarea><span class="s-note">${tr("s14.composer.evidence_note")}</span></label>`;
function composer(page: S14Page, conversation: Conversation, bot: Bot, from: "home" | "chat", draft: S14Draft | null): string {
  const limits = draft ?? limitValues(page.overview.defaults), placeholder = bot.id === "jit" ? tr("s14.composer.placeholder") : `${tr("s14.composer.placeholder_to")} ${botName(bot)}…`;
  return `<form class="s-composer${from === "home" ? " big" : ""}" data-composer data-bot="${e(bot.id)}" data-lead-name="${e(botName(bot))}" data-refused="${draft ? "true" : "false"}" data-send-chat="${tr("s14.plain.send_chat")}" data-send-work="${tr("s14.plain.send_work")}" method="post" action="/s14/forms/compose" novalidate>${flat(page.csrf, conversation.revision)}${hidden("conversationId", conversation.id)}${hidden("from", from)}
    <label class="sr-only" for="s14-text">${tr("s14.composer.label")}</label><textarea id="s14-text" name="text" rows="${from === "home" ? 3 : 1}" maxlength="16384" placeholder="${e(placeholder)}">${e(draft?.text ?? "")}</textarea>
    <div class="s-bar"><a class="s-chip" href="/team"><span class="sr-only">${tr("s14.composer.to")} </span><span aria-hidden="true">${tr("s14.composer.to")}</span> ${e(botName(bot))}</a><label class="s-chip s-mode"><input type="checkbox" name="work" value="on"${draft?.work ? " checked" : ""} aria-label="${tr("s14.composer.mode")}"><span aria-hidden="true"><span class="s-mode-chat">${tr("s14.plain.mode_chat")}</span><span class="s-mode-work">${tr("s14.plain.mode_work")}</span></span></label><span class="s-grow"></span><button class="s-send"><span class="s-chat-send-label sr-only">${tr("s14.plain.send_chat")}</span><span class="s-work-send-label">${tr("s14.plain.send_work")}</span>${icon("arrow")}</button></div>
    <div class="s-budget"><p>${tr("s14.composer.starts_now")}</p>${limitFields(limits)}<p class="s-scope-summary" data-scope-summary hidden></p><details class="s-more" data-grant-options open><summary>${tr("s14.composer.more")}</summary><div><label class="s-field"><span>${tr("s14.composer.completion")}</span><input name="completion" maxlength="1000" value="${e(draft?.completion ?? "")}" placeholder="${tr("s14.work.default_completion")}"></label>${evidenceField(draft?.evidence ?? "")}${grantChoices(page, bot, draft)}</div></details><p class="s-note">${tr(page.policy.tools.length ? "s14.composer.tools_note" : "s14.composer.no_tools_note")} ${tr("s14.composer.serial_note")}</p></div><div class="s-draft-bar" data-draft-bar hidden><span data-draft-status role="status" data-saved="${tr("s14.plain.draft_saved")}" data-restored="${tr("s14.plain.draft_restored")}" data-unavailable="${tr("s14.plain.draft_unavailable")}" data-sensitive="${tr("s14.plain.draft_sensitive")}"></span><button class="s-link-text" type="button" data-draft-clear>${tr("s14.plain.draft_clear")}</button></div></form>`;
}

function taskSlip(page: S14Page, task: Work, conversation: Conversation, bot: Bot): string {
  const body = untrusted(`<p><b>${e(task.title)}</b></p><p>${e(task.purpose)}</p><p class="s-meta">${tr("s14.task.completion")}: ${e(task.completionRule)}</p>`);
  if (task.state === "rejected") return `<article class="s-slip" data-state="closed" aria-label="${tr("s14.task.title")}"><div class="s-slip-hd"><div><h3>${tr("s14.task.title")} r${task.revision}</h3></div>${workPill("rejected")}</div><div class="s-slip-body">${banner("", tr("s14.task.rejected_title"), tr("s14.task.rejected_detail"))}${body}</div></article>`;
  if (task.state === "proposed") return `<article class="s-slip" aria-label="${tr("s14.task.title")}"><div class="s-slip-hd"><div><h3>${tr("s14.task.title")} r${task.revision}</h3><p class="s-meta">${tr("s14.task.no_effect")}</p></div>${workPill("proposed")}</div><div class="s-slip-body">${body}${routineFindingNote(task.reason)}</div>
    ${ownerStrip(`${commandForm(page.csrf, "task.accept", task.revision, { taskId: task.id }, tr("s14.task.accept"))}${commandForm(page.csrf, "task.reject", task.revision, { taskId: task.id }, tr("s14.task.reject"))}`, tr("s14.task.accept_note"), "", `<p class="s-note">${tr("s14.task.reject_note")}</p>`)}</article>`;
  return `<article class="s-slip" data-state="closed" aria-label="${tr("s14.task.title")}"><div class="s-slip-hd"><div><h3>${tr("s14.task.title")} r${task.revision}</h3></div>${workPill("accepted")}</div><div class="s-slip-body">${banner("", tr("s14.task.not_running_title"), tr("s14.task.not_running"))}${body}</div>
    ${ownerStrip(`<form class="s-stack" method="post" action="/s14/forms/task-start">${flat(page.csrf, conversation.revision)}${hidden("taskId", task.id)}${hidden("taskRevision", task.revision)}${limitFields(limitValues(page.overview.defaults))}<p class="s-note">${tr("s14.composer.serial_note")}</p><details class="s-more"><summary>${tr("s14.composer.more")}</summary><div>${evidenceField("")}${grantChoices(page, bot, null, task.id)}</div></details><div><button class="s-btn primary">${tr("s14.task.start")}</button></div></form>`, tr("s14.task.start_note"))}</article>`;
}
function receiptLine(work: Work, view?: WorkView): string {
  if (!work.grantId) return "";
  return `<details class="s-receipt"><summary>${tr("s14.work.receipt")}</summary><p><span class="s-mono s-meta">${e(short(work.id))}</span> · ${tr("s14.work.grant")} g${view?.grant?.revision ?? 1}</p></details>`;
}
const partialPill = (work: Work) => partialWork(work) ? pill(tr("s14.report.coverage.partial"), "warn", "!") : "";
function stopForm(page: S14Page, work: Work): string {
  return commandForm(page.csrf, "work.stop", work.revision, { workId: work.id }, tr("s14.work.stop"), "s-btn danger");
}
/** A suggestion that never started: it renders as its slip, with no work pane parts it cannot have. */
const isTask = (work: Work) => work.state === "proposed" || work.state === "accepted" || work.state === "rejected";
const stoppable = (work: Work) => ["queued", "running", "waiting", "blocked"].includes(work.state);
function workCard(page: S14Page, work: Work, conversation: Conversation, bot: Bot): string {
  if (isTask(work)) return taskSlip(page, work, conversation, bot);
  const open = `/chats/${e(conversation.id)}?work=${e(work.id)}`;
  return `<article class="s-workcard" aria-label="${e(work.title)}"><div class="s-workcard-hd"><div><h3>${e(work.title)}</h3></div>${partialPill(work)}${workPill(work.state)}</div>${receiptLine(work)}${miniLanes(page, work) || `<div class="s-lane-mini">${tile(bot, workDot[work.state] ?? "", "small")}<span class="s-grow">${e(botName(bot))}</span><span>${tr(k(`s14.work_state.${work.state}`))}</span></div>`}
    <div class="s-workcard-ft"><a class="s-btn" href="${open}">${tr("s14.work.open_progress")}</a>${page.overview.reports[work.id] ? `<a class="s-btn" href="${open}&amp;tab=report">${tr("s14.work.open_report")} r${page.overview.reports[work.id]!.revision}</a>` : ""}<a class="s-btn" href="${open}&amp;tab=grant">${tr("s14.work.open_grant")}</a></div>${stoppable(work) ? ownerStrip(stopForm(page, work), tr("s14.work.stop_note")) : ""}</article>`;
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
  const closure = proposal.state === "accepted" ? banner("ok", tr("s14.proposal.accepted"), tr("s14.proposal.accepted_note"), proposal.botId && page.state.bots.some(bot => bot.id === proposal.botId && !botGone(bot)) ? `<p><a class="s-link-text" href="/team/${e(proposal.botId)}">${tr("s14.proposal.open_bot")}</a></p>` : "") : proposal.state === "rejected" ? banner("", tr("s14.proposal.rejected"), tr("s14.proposal.rejected_note")) : "";
  const state = proposal.state === "proposed" ? pill(tr("s14.work_state.proposed"), "strong") : proposal.state === "accepted" ? pill(tr("s14.proposal.state_accepted"), "ok", "✓") : pill(tr("s14.proposal.state_rejected"));
  return `<article class="s-slip"${closed ? ' data-state="closed"' : ""} aria-label="${tr("s14.proposal.title")} r${proposal.revision}"><div class="s-slip-hd"><div><${level}>${tr("s14.proposal.title")} r${proposal.revision}</${level}><p class="s-meta">${tr(closed ? "s14.proposal.closed" : "s14.proposal.no_effect")}</p></div>${state}</div>
    <div class="s-slip-body">${closure}${proposal.author === "bot" ? untrusted(content) : untrusted(content, tr("s14.untrusted.owner_edit"))}${changes}${proposalFacts(page, proposal)}${dropped}</div>${strip}</article>`;
}
function proposalHistory(history: BotProposal[], current: BotProposal): string {
  const old = history.filter(item => item.revision < current.revision);
  return old.length ? `<section class="s-card" aria-labelledby="s14-history"><h2 id="s14-history">${tr("s14.proposal.history")}</h2><ul class="s-history">${old.map(item => `<li><p>r${item.revision} · ${pill(tr("s14.proposal.stale"))} · ${tr(item.author === "owner" ? "s14.proposal.author_owner" : "s14.proposal.author_bot")}</p><p class="s-sub">${e(item.name)}</p></li>`).join("")}</ul></section>` : "";
}

const unavailableDetail = (reply: Reply) => {
  const key = { "sign-in": "s14.provider.state.needs-login", quota: "s14.provider.state.quota-exceeded", provider: "s14.web_outcome.service_error_title", timeout: "s14.reason.deadline_exceeded", unknown: "s14.reason.reply_unavailable" } as const;
  return reply.reason === "reply_unavailable" ? tr(key[reply.unavailableReason ?? "unknown"]) : "";
};
const replyLine = (reply: Reply, bot: Bot) => reply.state === "succeeded" ? "" : `<div class="s-bot-msg">${tile(bot, reply.state === "blocked" ? "failed" : reply.state === "running" ? "working" : "hollow")}<div>${reply.state === "blocked" ? banner("warn", tr("s14.reply.blocked"), `${unavailableDetail(reply) || trMaybe(`s14.reason.${reply.reason}`) || ""} ${tr("s14.reply.blocked_next")}`.trim(), reply.reason === "reply_unavailable" && reply.unavailableReason === "sign-in" ? `<p><a class="s-link-text" href="/settings/provider">${tr("s14.reply.check_provider")}</a></p>` : "") : `<p class="s-who">${e(botName(bot))} · ${tr(k(`s14.reply.${reply.state}`))}</p>`}</div></div>`;
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
const emptyThread = (bot: Bot) => `<section class="s-empty-thread"><p class="s-who">${e(botName(bot))}</p><h2>${bot.id === "jit" ? tr("s14.chat.empty_jit") : tr("s14.chat.empty_bot")}</h2>${bot.id === "jit" ? `<ul class="s-starters"><li><a href="/?example=1#s14-text">${tr("s14.home.example_1")}</a></li><li><a href="/?example=2#s14-text">${tr("s14.home.example_2")}</a></li></ul><p class="s-note">${tr("s14.home.example_note")}</p>` : ""}</section>`;
const liveWork = (work: Work) => ["queued", "running", "stopping"].includes(work.state);

/** True when every open effect is one the owner has already stated. It stays open, because a statement is not a verified outcome. */
const stated = (view: WorkView) => { const open = view.effects.filter(effect => ["pending", "approved", "executing", "unknown"].includes(effect.state)); return open.length > 0 && open.every(effect => effect.state === "unknown" && effect.resolution); };
function workStateBanner(view: WorkView): string {
  const { work } = view, reason = work.reason ? trMaybe(`s14.reason.${work.reason}`) : null;
  if (work.state === "queued") return banner("", tr("s14.work_state.queued"), tr("s14.work.queued_detail"));
  if (work.state === "running") return banner("", tr("s14.work_state.running"), tr("s14.work.running_detail"));
  if (work.state === "waiting") return banner("warn", tr("s14.work_state.waiting"), tr(stated(view) ? "s14.work.waiting_stated" : "s14.work.waiting_detail"));
  if (partialWork(work)) return banner("warn", `${tr("s14.work_state.ready")} · ${tr("s14.report.coverage.partial")}`, tr("s14.work.ready_partial_detail"));
  if (work.state === "ready") return banner("ok", tr("s14.work_state.ready"), tr("s14.work.ready_detail"));
  if (work.state === "blocked") return banner("warn", tr("s14.work_state.blocked"), `${reason ?? tr("s14.reason.generic")} ${tr("s14.work.blocked_next")}`, `${work.reason ? `<p class="s-mono s-meta">${e(work.reason)}</p>` : ""}${recoveryReason(work.reason) ? `<p><a class="s-link-text" href="/recovery">${tr("s14.work.after_restart")}</a></p>` : ""}`);
  if (work.state === "stopping") return banner("", tr("s14.work_state.stopping"), tr("s14.work.stopping_detail"));
  if (work.state === "stopped") return banner("", tr("s14.work_state.stopped"), `${tr("s14.work.stopped_detail")}. ${tr("s14.work.stopped_kept")}`);
  return "";
}
function attemptLane(page: S14Page, attempt: Attempt): string {
  const bot = page.state.bots.find(b => b.id === attempt.snapshot.bot.id) ?? attempt.snapshot.bot;
  return `<div class="s-lane">${tile(bot, attemptDot[attempt.state] ?? "")}<div><p><b>${e(botName(bot))}</b> · ${tr(k(`s14.attempt_state.${attempt.state}`))}</p>${attempt.reason ? `<p class="s-meta">${e(trMaybe(`s14.reason.${attempt.reason}`) ?? attempt.reason)}</p>` : ""}<p class="s-meta">${when(attempt.createdAt)}</p>${attempt.snapshot.tools.includes("computer") ? `<p><a class="s-link-text" href="${computerPath(bot)}">${tr("s14.work.view_computer")}</a></p>` : ""}</div></div>`;
}
/** The one Progress line about reports: it links out when one exists and says plainly when a result is not one. */
function reportLine(view: WorkView, team: S14WorkTeam, reportHref: string): string {
  const latest = team.reports.at(-1);
  if (latest) return `<p class="s-row"><a class="s-link-text" href="${reportHref}">${tr("s14.work.open_report")} r${latest.state === "available" ? latest.report.revision : latest.revision}</a>${latest.state === "available" && latest.report.coverage === "partial" ? pill(tr("s14.report.coverage.partial"), "warn", "!") : ""}</p>`;
  return view.results.length ? `<p class="s-note">${tr("s14.work.no_report_yet")}</p>` : "";
}
function progressTab(page: S14Page, view: WorkView, conversation: Conversation, bot: Bot, research: S14WorkResearch | null, team: S14WorkTeam, base: string): string {
  const { work } = view;
  if (isTask(work)) return taskSlip(page, work, conversation, bot);
  const resultText = view.results.map(result => result.text).join("\n\n");
  const result = resultText ? `<section class="s-stack" aria-labelledby="s14-result"><h3 class="s-section-t" id="s14-result">${tr("s14.work.result")}</h3>${untrusted(`<p>${e(resultText)}</p>`, tr("s14.untrusted.result"))}<p class="s-note">${tr("s14.work.completion_rule")}: ${e(work.completionRule)}</p></section>` : "";
  const sep = base.includes("?") ? "&amp;" : "?", evidenceHref = `${base}${sep}tab=evidence`, direct = view.attempts.filter(attempt => !attempt.step);
  return `<div id="s14-progress-primary">${workStateBanner(view)}${recoveryNotice(view)}${reportLine(view, team, `${base}${sep}tab=report`)}${researchNotice(research, evidenceHref)}${view.effects.map(effect => effectSlip(page, effect, [], "h3")).join("")}${result}${recoveryPanel(page, view, research)}${stoppable(work) ? `<div class="s-slip" data-state="closed">${ownerStrip(stopForm(page, work), tr("s14.work.stop_note"))}</div>` : ""}</div><details class="s-more"><summary>${tr("s14.plain.progress")}</summary><div id="s14-progress-details">${teamProgress(page, view, team, research)}${direct.length ? `<section class="s-stack" aria-labelledby="s14-attempts"><h3 class="s-section-t" id="s14-attempts">${tr("s14.work.attempts")}</h3>${direct.map(a => attemptLane(page, a)).join("")}</section>` : ""}${usageBlock(page, view, team)}</div></details>`;
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
    <dt>${tr("s14.grant.time")}</dt><dd>${Math.round(grant.limits.wallMs / 60000)} ${tr("s14.time.minutes")}</dd><dt>${tr("s14.grant.reads")}</dt><dd>${grant.limits.reads}</dd><dt>${tr("s14.grant.calls")}</dt><dd>${grant.limits.calls}</dd><dt>${tr("s14.grant.concurrency")}</dt><dd>${grant.limits.concurrency}</dd><dt>${tr("s14.grant.output")}</dt><dd>${size(grant.limits.outputBytes)}</dd><dt>${tr("s14.grant.evidence")}</dt><dd>${payload.requiredEvidence?.length ? payload.requiredEvidence.map(target => e(target.label)).join("<br>") : tr("s14.grant.no_evidence_targets")}</dd></dl>
    <p class="s-note">${tr("s14.grant.enforced_note")}</p>${stoppable(work) ? `<div class="s-slip" data-state="closed">${ownerStrip(stopForm(page, work), tr("s14.work.stop_note"))}</div>` : ""}`;
}
function workBody(page: S14Page, view: WorkView, tab: S14WorkTab, conversation: Conversation, bot: Bot, research: S14WorkResearch | null, team: S14WorkTeam, base: string, coding: S14WorkCoding | null = null): string {
  if (tab === "computer" && usesComputer(view)) return computerTab(page, view);
  if (tab === "coding" && usesCoding(view)) return codingTab(page, view, coding);
  if (tab === "report" && view.work.grantId) return reportTab(page, view, team, research, base);
  if (tab === "brief") { const sep = base.includes("?") ? "&amp;" : "?"; return briefTab(page, team.brief, `${base}${sep}tab=report`); }
  return tab === "grant" ? grantTab(page, view) : tab === "evidence" ? evidenceTab(page, view, research) : progressTab(page, view, conversation, bot, research, team, base);
}
function workTabs(view: WorkView, tab: S14WorkTab, base: string): string {
  if ((tab === "computer" && !usesComputer(view)) || (tab === "coding" && !usesCoding(view))) tab = "progress";
  const sep = base.includes("?") ? "&amp;" : "?", link = (name: S14WorkTab) => `<a href="${base}${sep}tab=${name}"${tab === name ? ' aria-current="page"' : ""}>${tr(k(`s14.tab.${name}`))}</a>`;
  return view.work.grantId ? `<nav class="s-worktabs" aria-label="${tr("s14.tab.label")}">${link("progress")}${usesCoding(view) ? link("coding") : ""}${link("report")}${view.grant?.tools.includes("personal_read") ? link("brief") : ""}${link("evidence")}${link("grant")}${usesComputer(view) ? link("computer") : ""}</nav>` : "";
}
function workPane(page: S14Page, view: WorkView, tab: S14WorkTab, conversation: Conversation, bot: Bot, research: S14WorkResearch | null, team: S14WorkTeam, coding: S14WorkCoding | null = null): string {
  const base = `/chats/${e(conversation.id)}?work=${e(view.work.id)}`;
  return `<section class="s-pane" aria-labelledby="s14-pane-title"><div class="s-pane-hdr"><div><h2 id="s14-pane-title">${e(view.work.title)}</h2>${receiptLine(view.work, view)}</div>${workPill(view.work.state, "s14-pane-status")}<a class="s-btn s-pane-work-link" href="/work#s14-work-waiting">${tr(attentionCount(page) ? "s14.nav.waiting" : "s14.nav.work")}${attentionCount(page) ? ` ${attentionCount(page)}` : ""}</a><a class="s-btn" href="/chats/${e(conversation.id)}" aria-label="${tr("s14.pane.close")}">${icon("close")}</a></div>${workTabs(view, tab, base)}<div class="s-pane-body" id="s14-pane-live">${workBody(page, view, tab, conversation, bot, research, team, base, coding)}</div></section>`;
}

const reasonOf = (effect: Effect) => effect.reason ? trMaybe(`s14.reason.${effect.reason}`) ?? "" : "";
const approveLabel = (effect: Effect) => tr(k(`s14.effect_approve.${effect.action.kind}`));
export function effectBanner(effect: Effect, history: Effect[]): string {
  const changedFrom = history.filter(item => item.state === "changed").at(-1);
  if (effect.state === "unknown") return statementBanner(effect);
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
function effectSlip(page: S14Page, effect: Effect, history: Effect[], level: "h2" | "h3", draft: S14StatementDraft | null = null): string {
  // A push is decided only on its own page, under its diff and checks.
  if (level === "h3" && gitAction(effect)) return gitSummarySlip(page, effect);
  const personal = page.overview.personal?.drafts[effect.id];
  if (personal) return personalSlip(page, personal, history, level, draft);
  const bot = page.state.bots.find(b => b.id === effect.botId), name = botName(bot ?? { id: effect.botId, name: effect.botId }), pending = effect.state === "pending";
  const state = effect.state === "unknown" ? "unknown" : pending ? "pending" : "closed", heading = `${e(name)} ${tr("s14.effect.asks")} ${e(tr(k(`s14.effect_kind.${effect.action.kind}`)))}`;
  const decide = (decision: "approve" | "deny", label: string, cls: string) => commandForm(page.csrf, "approval.decide", effect.revision, { effectId: effect.id, actionHash: effect.actionHash, decision }, label, cls);
  const strip = pending ? ownerStrip(`${effect.supported ? decide("approve", approveLabel(effect), "s-btn primary") : ""}${decide("deny", tr("s14.effect.deny"), "s-btn")}`, tr(effect.supported ? "s14.effect.single_use" : "s14.effect.unsupported")) : statementStrip(page, effect, level === "h2", draft);
  const anchor = level === "h2" ? ' id="slip" tabindex="-1" data-focus-on-load' : "";
  return `<article class="s-slip" data-state="${state}" aria-label="${tr("s14.effect.card")}"><div class="s-slip-hd"><div><${level}${anchor}>${heading}</${level}><p class="s-meta">${tr("s14.effect.irreversible")}</p></div>${effectPill(effect.state)}</div>
    <div class="s-slip-body">${effectBanner(effect, history)}${level === "h2" ? effectDiff(effect, history) : ""}<div><p class="s-exact-label">${tr("s14.effect.destination")}</p><pre class="s-exact">${e(effect.action.destination)}</pre></div><div><p class="s-exact-label">${tr("s14.effect.content")}</p><pre class="s-exact">${e(effect.action.content)}</pre></div>
    <dl class="s-kv"><dt>${tr("s14.effect.revision")}</dt><dd><span class="s-mono">r${effect.revision}</span></dd><dt>${tr("s14.effect.hash")}</dt><dd class="s-mono">${e(effect.actionHash)}</dd><dt>${tr("s14.effect.expires")}</dt><dd>${when(effect.expiresAt)}${pending ? ` · ${remaining(effect.expiresAt, page.now)}` : ""}</dd></dl>${statementBlock(effect)}${level === "h3" && effect.revision > 1 ? `<p><a class="s-link-text" href="/effects/${e(effect.id)}#slip">${tr("s14.effect.open_history")}</a></p>` : ""}</div>${strip}</article>`;
}
export function effectHistory(history: Effect[], current: Effect): string {
  const old = history.filter(item => item.revision < current.revision);
  return old.length ? `<section class="s-card" aria-labelledby="s14-effect-history"><h2 id="s14-effect-history">${tr("s14.effect.history")}</h2><ul class="s-history">${old.map(item => `<li><p>r${item.revision} · ${effectPill(item.state)}</p><p class="s-mono s-meta">${e(item.actionHash)}</p></li>`).join("")}</ul></section>` : "";
}

/* Bot computer (BOX14-01, F11). The lease bar reads the lease, never local state, and every word here comes from typed query data. */
export const computerPath = (bot: Pick<Bot, "id">, suffix = "") => `/team/${e(bot.id)}?tab=computer${suffix}`;
const usesComputer = (view: WorkView) => !!view.grant?.tools.includes("computer");
const usesCoding = (view: WorkView) => !!view.grant?.tools.includes("coding");
/** Raw dictionary text with the Bot's name filled in; callers escape it like any other query value. */
const named = (key: string, bot: Pick<Bot, "id" | "name">) => tr(k(key)).replaceAll("{bot}", () => botName(bot));
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

/** A closed Bot retains readable history while its current lifecycle fences new messages. */
function chatClosed(bot: Bot, lifecycle: BotLifecycle | undefined): string {
  const returning = lifecycle?.target === "active" && lifecycleLive(lifecycle);
  return banner("", returning ? named("s14.life.chat_returning", bot) : tr("s14.life.chat_closed"), tr(returning ? "s14.life.chat_returning_detail" : "s14.life.chat_closed_detail"), `<p><a class="s-link-text" href="/team/${e(bot.id)}">${tr("s14.life.chat_open_bot")}</a></p>`);
}
/** Empty until script fills it from page memory, so a draft held across a closing chat stays readable. The server never sees that text. */
const heldDraftBlock = (returning: boolean) => `<div data-draft-held hidden><div class="s-stack"><p class="s-exact-label">${tr("s14.life.draft_held")}</p><pre class="s-exact" data-draft-text tabindex="0" role="group" aria-label="${tr("s14.life.draft_held")}"></pre><p class="s-note">${tr(returning ? "s14.life.draft_held_returning" : "s14.life.draft_held_closed")}</p></div></div>`;
/** The foot of a chat. `data-sig` changes only when the Bot's ability to take a message does; a live read moves any unsent text across that change. */
function chatDock(page: S14Page, view: Extract<S14View, { kind: "chat" }>): string {
  const { chat, bot } = view, lifecycle = page.overview.lifecycles?.[bot.id];
  const returning = lifecycle?.target === "active" && lifecycleLive(lifecycle);
  const words = bot.enabled ? tr("s14.life.chat_open") : returning ? named("s14.life.chat_returning", bot) : tr("s14.life.chat_closed");
  // Refused text stays in its box, because the page promised to keep it. The service still refuses the send.
  return `<div class="s-dock" id="s14-dock" data-sig="${bot.enabled ? "open" : `closed.${lifecycle?.state ?? ""}.${lifecycle?.target ?? ""}`}" data-announce="${e(words)}" data-kept="${e(tr(bot.enabled ? "s14.life.chat_open_kept" : "s14.life.chat_closed_kept"))}">${notice(view.notice)}${bot.enabled ? "" : chatClosed(bot, lifecycle)}${bot.enabled || view.draft ? composer(page, chat.conversation, bot, "chat", view.draft) : heldDraftBlock(returning)}</div>`;
}
function chatPage(page: S14Page, view: Extract<S14View, { kind: "chat" }>): string {
  const { chat, bot } = view, work = page.work.filter(item => item.conversationId === chat.conversation.id);
  const live = chat.replies.some(reply => reply.state === "queued" || reply.state === "running") || work.some(liveWork) || lifecycleLive(page.overview.lifecycles?.[bot.id]);
  const body = chat.messages.length || work.length ? thread(page, chat, bot) : emptyThread(bot);
  const content = `<div class="s-col"><div id="s14-live" class="s-thread" data-revision="${chat.conversation.revision}">${bot.id === "jit" ? "" : banner("", tr("s14.chat.direct"), tr("s14.chat.direct_detail"))}${body}</div><span id="latest"></span>${live ? `<p class="s-note"><a class="s-link-text" href="/chats/${e(chat.conversation.id)}#latest">${tr("s14.refresh")}</a></p>` : ""}</div>`;
  return shell(page, chatLabel(page, chat.conversation), content, { current: `chat:${chat.conversation.id}`, subtitle: tr("s14.chat.subtitle"), inChat: true, live, bot, action: newChat(page, bot, "s-btn", ' class="s-hdr-act"'), dock: chatDock(page, view), ...(view.pane ? { pane: workPane(page, view.pane.view, view.pane.tab, chat.conversation, bot, view.pane.research, view.pane.team, view.pane.coding ?? null) } : {}) });
}
function workListPage(page: S14Page): string {
  const group = (title: string, items: Work[], id: string) => items.length ? `<section aria-labelledby="${id}"><h2 class="s-section-t" id="${id}">${title}</h2>${items.map(item => `<a class="s-work-row" href="/work/${e(item.id)}"><span><span>${e(item.title)}</span><small>${when(item.createdAt)}</small></span><span class="s-row-pills">${reportHintPill(page.overview.reports[item.id])}${workPill(item.state)}</span></a>`).join("")}</section>` : "";
  const by = (...states: Work["state"][]) => page.work.filter(item => states.includes(item.state));
  return shell(page, tr("s14.nav.work"), `<div class="s-col s-col-wide" id="s14-work-list"><section id="s14-work-waiting" aria-labelledby="s14-work-waiting-title"><h2 class="s-section-t" id="s14-work-waiting-title">${tr("s14.attention.title")}</h2>${attentionList(page, "work")}</section>${group(tr("s14.work_list.needs_you"), by("waiting", "blocked"), "s14-group-you")}${group(tr("s14.work_list.progress"), by("queued", "running", "stopping"), "s14-group-progress")}${group(tr("s14.work_list.unstarted"), by("proposed", "accepted"), "s14-group-unstarted")}${group(tr("s14.work_list.finished"), by("ready", "stopped"), "s14-group-finished")}${group(tr("s14.work_list.rejected"), by("rejected"), "s14-group-rejected")}${page.work.length ? "" : `<p class="s-sub">${tr("s14.work_list.empty")}</p>`}</div>`, { current: "work" });
}
function workPage(page: S14Page, view: Extract<S14View, { kind: "work" }>): string {
  const work = view.view.work;
  return shell(page, work.title, `<div class="s-col"><div class="s-between">${receiptLine(work, view.view) || "<span></span>"}${workPill(work.state, "s14-work-status")}</div>${workTabs(view.view, view.tab, `/work/${e(work.id)}`)}<div class="s-stack" id="s14-pane-live">${workBody(page, view.view, view.tab, view.conversation, view.bot, view.research, view.team, `/work/${e(work.id)}`, view.coding ?? null)}</div>${liveWork(work) ? `<p class="s-note"><a class="s-link-text" href="/work/${e(work.id)}">${tr("s14.refresh")}</a></p>` : ""}<p><a class="s-link-text" href="/chats/${e(view.conversation.id)}">${tr("s14.work.back_to_chat")}</a></p></div>`, { current: "work", live: liveWork(work) });
}
/** One state word for a Bot: its lifecycle when it is not plainly active, otherwise what it is doing now. */
const botWord = (page: S14Page, bot: Bot) => { const lifecycle = page.overview.lifecycles?.[bot.id]; return tr(k(lifecycle && lifecycle.state !== "active" ? `s14.life.state.${lifecycle.state}` : `s14.bot_state.${page.overview.botStates[bot.id] ?? "idle"}`)); };
function teamPage(page: S14Page): string {
  const row = (bot: Bot) => { const lifecycle = page.overview.lifecycles?.[bot.id]; return `<a class="s-work-row" href="/team/${e(bot.id)}"><span class="s-row">${tile(bot, ({ working: "working", queued: "hollow", waiting: "waiting", idle: "" })[page.overview.botStates[bot.id] ?? "idle"])}<span><b>${e(botName(bot))}</b><small>${e(botDuty(bot))}</small>${page.overview.computers[bot.id]?.computer ? `<small>${tr("s14.proposal.computer")} · ${computerWord(page.overview.computers[bot.id]!)}</small>` : ""}</span></span>${lifecycle && lifecycle.state !== "active" ? lifecyclePill(lifecycle) : pill(tr(k(`s14.bot_state.${page.overview.botStates[bot.id] ?? "idle"}`)))}</a>`; };
  const state = (bot: Bot) => page.overview.lifecycles?.[bot.id]?.state ?? "active", working = page.state.bots.filter(bot => ["active", "stopping"].includes(state(bot))), ended = page.state.bots.filter(bot => state(bot) === "retired"), gone = page.state.bots.filter(bot => ["deleting", "deleted"].includes(state(bot)));
  const section = (name: "retired" | "deleted", items: Bot[]) => items.length ? `<section class="s-stack" aria-labelledby="s14-team-${name}"><h2 class="s-section-t" id="s14-team-${name}">${tr(k(`s14.life.team.${name}`))}</h2>${items.map(row).join("")}</section>` : "";
  return shell(page, tr("s14.nav.team"), `<div class="s-col"><p class="s-sub">${tr("s14.team.lead")}</p>${working.map(row).join("")}<p class="s-note">${tr("s14.team.proposal_note")}</p>${section("retired", ended)}${section("deleted", gone)}</div>`, { current: "team", live: page.state.bots.some(bot => lifecycleLive(page.overview.lifecycles?.[bot.id])) });
}
function botPage(page: S14Page, view: Extract<S14View, { kind: "bot" }>): string {
  const { bot, conversation, computer } = view, route = page.state.routes.find(r => r.id === bot.routeId), current = page.overview.computers[bot.id] ?? { computer: null, lease: null }, lifecycle = page.overview.lifecycles?.[bot.id], gone = botGone(bot);
  const list = (items: string[]) => items.length ? items.map(item => `<span class="s-mono">${e(item)}</span>`).join(" · ") : tr("s14.bot.none");
  const tabs = `<nav class="s-worktabs" aria-label="${tr("s14.bot.tab_label")}"><a href="/team/${e(bot.id)}"${computer ? "" : ' aria-current="page"'}>${tr("s14.bot.tab_overview")}</a><a href="${computerPath(bot)}"${computer ? ' aria-current="page"' : ""}>${tr("s14.tab.computer")}</a><a href="/team/${e(bot.id)}/capabilities">${tr("s14.bot.tab_capabilities")}</a></nav>`;
  const overview = () => `<div class="s-stack" id="s14-bot-overview"><div class="s-row">${tile(bot, "", "large")}<p class="s-sub">${e(botDuty(bot))}</p></div><dl class="s-kv"><dt>${tr("s14.bot.state")}</dt><dd>${botWord(page, bot)}</dd><dt>${tr("s14.proposal.route")}</dt><dd>${routeText(route)}</dd><dt>${tr("s14.bot.tools")}</dt><dd>${list(bot.capabilities.tools)}</dd><dt>${tr("s14.bot.resources")}</dt><dd>${list(bot.capabilities.resources)}</dd><dt>${tr("s14.proposal.logins")}</dt><dd>${tr("s14.proposal.none_granted")}</dd><dt>${tr("s14.proposal.computer")}</dt><dd><a class="s-link-text" href="${computerPath(bot)}">${computerWord(current)}</a></dd><dt>${tr("s14.bot.revision")}</dt><dd class="s-mono">r${bot.revision} · g${bot.generation}</dd></dl><p class="s-note">${tr("s14.bot.ceiling_note")} <a class="s-link-text" href="/team/${e(bot.id)}/capabilities">${tr("s14.bot.change_ceiling")}</a></p><p class="s-row">${conversation ? `<a class="s-btn${bot.enabled ? " primary" : ""}" href="/chats/${e(conversation.id)}">${tr(bot.enabled ? "s14.bot.direct" : "s14.bot.read_chat")}</a>` : ""}${newChat(page, bot)}<a class="s-btn" href="/memory?scope=${e(bot.id)}">${tr("s14.bot.memory")}</a>${bot.capabilities.tools.includes("coding") ? `<a class="s-btn" href="/coding">${tr("s14.more.coding")}</a>` : ""}</p></div>`;
  const status = lifecycle ? `<div class="s-stack" id="s14-live"><span hidden data-phase="${e(tr(k(`s14.life.state.${lifecycle.state}`)))}"></span>${lifecycleStatus(bot, lifecycle)}${lifecycleLanding(bot, lifecycle, view.landing ?? null)}</div>` : "";
  return shell(page, botName(bot), `<div class="s-col${computer ? " s-col-wide" : ""}">${gone ? "" : tabs}${computer ? "" : status}${gone ? "" : computer ? computerPanel(page, bot, computer) : overview()}</div>`, { current: "team", bot, ...(computer ? { subtitle: tr("s14.computer.title") } : {}), live: !computer && lifecycleLive(lifecycle) });
}
function preferences(page: S14Page): string {
  const owner = page.state.owner, theme = owner?.theme ?? "system", radio = (name: string, value: string, label: string, checked: boolean, lang = "") => `<label class="s-check"><input type="radio" name="${name}" value="${value}"${checked ? " checked" : ""}><span${lang ? ` lang="${lang}"` : ""}>${e(label)}</span></label>`;
  return `<section class="s-card s-stack" aria-labelledby="s14-prefs"><h2 id="s14-prefs">${tr("s14.more.preferences")}</h2><form class="s-stack" method="post" action="/s14/forms/preferences">${flat(page.csrf, page.state.revision)}<div class="s-prefs-grid"><fieldset class="s-field s-prefs"><legend>${tr("s14.setup.language")}</legend>${radio("language", "th", "ไทย", owner?.language === "th", "th")}${radio("language", "en", "English", owner?.language === "en", "en")}</fieldset><fieldset class="s-field s-prefs"><legend>${tr("s14.more.theme")}</legend>${(["system", "light", "dark"] as const).map(value => radio("theme", value, tr(`s14.more.theme_${value}`), theme === value)).join("")}</fieldset></div><div><button class="s-btn">${tr("s14.more.save")}</button></div></form></section>`;
}
/** What may enter "needs me". Two fixed words, and a note that it reaches forward only: nothing already here moves. */
function attentionLevel(page: S14Page, setting: AttentionSetting): string {
  const row = (level: AttentionSetting["level"]) => `<label class="s-check"><input type="radio" name="level" value="${level}"${setting.level === level ? " checked" : ""}><span>${tr(k(`s14.attention.level.${level}`))}<small>${tr(k(`s14.attention.level.${level}_note`))}</small></span></label>`;
  return `<section class="s-card s-stack" id="s14-attention-level" aria-labelledby="s14-attention-level-t"><h2 id="s14-attention-level-t">${tr("s14.attention.level.title")}</h2><p class="s-sub">${tr("s14.attention.level.lead")}</p><form class="s-stack" method="post" action="/s14/forms/attention-level">${flat(page.csrf, setting.revision)}<fieldset class="s-field"><legend class="sr-only">${tr("s14.attention.level.title")}</legend>${row("needs-me")}${row("all")}</fieldset><p class="s-note">${tr("s14.attention.level.note")}</p><div><button class="s-btn">${tr("s14.more.save")}</button></div></form></section>`;
}
function morePage(page: S14Page, view: Extract<S14View, { kind: "more" }>): string {
  const { saved, attention: setting, attentionSaved } = view;
  return shell(page, tr("s14.nav.more"), `<div class="s-col">${saved ? announced(banner("ok", tr("s14.more.saved"), tr("s14.more.saved_detail"))) : ""}${attentionSaved ? announced(banner("ok", tr("s14.attention.level.saved"), tr("s14.attention.level.saved_detail"))) : ""}    <nav class="s-management" aria-label="${tr("s14.more.places")}">
      <section><h2>${tr("s14.plain.knowledge")}</h2><ul class="s-history">${[["/memory", "s14.more.memory"], ["/shares", "s14.more.shares"]].map(([path, label]) => `<li><a class="s-link" href="${path}">${tr(k(label!))}</a></li>`).join("")}</ul></section>
      <section><h2>${tr("s14.plain.team_work")}</h2><ul class="s-history">${[["/team", "s14.nav.team"], ["/routines", "s14.more.routine"], ["/coding", "s14.more.coding"], ["/recovery", "s14.more.recovery"]].map(([path, label]) => `<li><a class="s-link" href="${path}">${tr(k(label!))}</a></li>`).join("")}${page.state.bots.filter(bot => !botGone(bot)).map(bot => `<li><a class="s-link" href="${computerPath(bot)}">${tr("s14.tab.computer")} · ${e(botName(bot))}</a></li>`).join("")}</ul></section>
      <section><h2>${tr("s14.plain.installation")}</h2><ul class="s-history">${[["/settings/provider", "s14.more.provider"], ["/settings/google", "s14.more.google"], ["/settings/work", "s14.more.work"], ["/settings/web", "s14.more.web"], ["/settings/backup", "s14.more.backup"]].map(([path, label]) => `<li><a class="s-link" href="${path}">${tr(k(label!))}</a></li>`).join("")}</ul></section>
    </nav><details class="s-more"><summary>${tr("s14.more.account")}</summary><div><section class="s-card" aria-labelledby="s14-account"><h2 id="s14-account">${tr("s14.more.account")}</h2><dl class="s-kv"><dt>${tr("s14.setup.name")}</dt><dd>${e(page.state.owner?.name ?? "")}</dd><dt>${tr("s14.proposal.route")}</dt><dd>${page.state.routes.map(route => routeText(route)).join(" · ") || tr("s14.proposal.no_route")}<br><span class="s-note">${tr("s14.setup.route_configured_detail")}</span></dd></dl></section></div></details><details class="s-more"><summary>${tr("s14.more.preferences")}</summary><div>${preferences(page)}</div></details><section class="s-card s-stack"><h2>${tr("s14.plain.drafts_title")}</h2><p class="s-sub">${tr("s14.plain.drafts_policy")}</p></section>${setting ? attentionLevel(page, setting) : ""}

    <form method="post" action="/s14/logout">${hidden("csrf", page.csrf)}<button class="s-btn">${tr("s14.more.sign_out")}</button></form></div>`, { current: "more" });
}

/** Renders one signed-in surface in the owner's language. Every value from a query is escaped here. */
export function renderS14(page: S14Page): string {
  return withTheme(page.state.owner?.theme ?? "system", () => withLocale(page.locale, () => {
    const view = page.view;
    switch (view.kind) {
      case "setup": return setupPage(page, view);
      case "chat": return chatPage(page, view);
      case "work-list": return workListPage(page);
      case "work": return workPage(page, view);
      case "team": return teamPage(page);
      case "bot": return botPage(page, view);
      case "proposal": return shell(page, `${tr("s14.proposal.title")} r${view.proposal.revision}`, `<div class="s-col">${proposalCard(page, view.proposal, view.history, "h2")}${proposalHistory(view.history, view.proposal)}<p><a class="s-link-text" href="/chats/${e(page.state.conversations.find(c => c.id === view.proposal.conversationId)?.id ?? "")}">${tr("s14.work.back_to_chat")}</a></p></div>`, { current: "team" });
      case "effect": return view.git ? gitEffectPage(page, view, view.git) : shell(page, tr("s14.effect.card"), `<div class="s-col">${view.saved ? announced(banner("", tr("s14.statement.saved"), tr("s14.statement.saved_detail"))) : ""}${notice(view.notice ?? null)}${effectSlip(page, view.effect, view.history, "h2", view.draft ?? null)}${effectHistory(view.history, view.effect)}<p><a class="s-link-text" href="/work/${e(view.effect.workId)}">${tr("s14.effect.back_to_work")}</a></p></div>`, { current: "work" });
      case "more": return morePage(page, view);
      case "settings-web": return webSettingsPage(page, view);
      case "settings-work": return workSettingsPage(page, view);
      case "settings-provider": return providerSettingsPage(page, view);
      case "recovery": return recoveryPage(page, view);
      case "settings-backup": return renderBackupSurface(page, view);
      case "shares": case "share-new": case "share": return renderSharingSurface(page, view);
      case "routines": case "routine-new": case "routine": return renderRoutineSurface(page, view);
      case "bot-policy": case "bot-end": return renderLifecycleSurface(page, view);
      case "coding": case "coding-new": case "coding-connect": case "coding-repository": case "coding-start": return renderCodingSurface(page, view);
      case "google": case "google-guide": case "google-new": case "google-connection": case "google-draft-edit": return renderPersonalSurface(page, view);
      default: return renderMemorySurface(page, view);
    }
  }));
}
