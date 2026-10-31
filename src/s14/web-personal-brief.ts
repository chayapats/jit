import { currentLocale, tr, trMaybe } from "../i18n";
import type { PersonalConnection, PersonalEvidence, PersonalRead } from "./personal-types";
import type { S14Page } from "./web";
import { banner, botName, e, k, pill, untrusted } from "./web-pages";
import type { S14Brief } from "./web-product-personal";

/* Morning brief and triage inputs (LIFE14-01). The page answers what was read, when, from which clock, and what was not. An input that was never read is a row, so silence never reads as "nothing to report". All mail and event text is escaped data in the untrusted frame, and nothing from it is ever a link. */
/** One instant in a named zone, with the weekday, because a calendar reader needs it. An unusable zone reads as Unknown instead of breaking the page. */
export function zoned(value: number, timezone: string): string {
  const date = new Date(value); if (!Number.isFinite(date.valueOf())) return tr("s14.unknown");
  try {
    const format = new Intl.DateTimeFormat(currentLocale() === "en" ? "en-GB" : "th-TH", { weekday: "short", year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: timezone });
    return `<time datetime="${date.toISOString()}">${e(format.format(date))}</time>`;
  } catch { return tr("s14.unknown"); }
}
const outcomeTone: Record<PersonalRead["outcome"], [string, string]> = { running: ["strong", ""], success: ["strong", "✓"], partial: ["warn", "!"], failed: ["danger", "×"], withdrawn: ["warn", "!"] };
const outcomePill = (read: PersonalRead) => pill(tr(k(`s14.brief.outcome.${read.outcome}`)), ...outcomeTone[read.outcome]);
/** Every code has words, and an unknown code still appears with its literal value: a gap must never vanish for lack of a translation. */
const gapWord = (code: string) => trMaybe(`s14.brief.gap.${code}`) ?? tr("s14.brief.gap.other");
function gapList(codes: string[]): string {
  const counts = new Map<string, number>(); for (const code of codes) counts.set(code, (counts.get(code) ?? 0) + 1);
  return `<ul class="s-reach-list">${[...counts].map(([code, count]) => `<li>${e(gapWord(code))}${count > 1 ? ` · ${count}` : ""} <span class="s-mono s-meta">${e(code)}</span></li>`).join("")}</ul>`;
}
const accountOf = (connection: PersonalConnection | undefined) => connection ? `${tr(k(`s14.google.service.${connection.service}`))} · <span class="s-mono">${e(connection.account)}</span>` : tr("s14.brief.account_gone");
/** Event text is JSON the broker built from provider fields. It is read for layout only, and anything unexpected falls back to the literal text. */
function eventText(item: PersonalEvidence): string {
  let data: { start?: Record<string, string>; end?: Record<string, string>; recurrence?: string[]; location?: string; description?: string };
  try { data = JSON.parse(item.text); } catch { return `<p>${e(item.text)}</p>`; }
  const point = (value: Record<string, string> | undefined) => e([value?.dateTime ?? value?.date, value?.timeZone].filter(Boolean).join(" · ") || tr("s14.unknown"));
  const line = (label: string, value: string | undefined) => value ? `<p><span class="s-meta">${e(label)}</span><br>${e(value)}</p>` : "";
  return `<p><span class="s-meta">${tr("s14.google.card.starts")}</span><br>${point(data.start)}</p><p><span class="s-meta">${tr("s14.google.card.ends")}</span><br>${point(data.end)}</p>${line(tr("s14.google.card.location"), data.location)}${line(tr("s14.google.card.repeats"), data.recurrence?.join("\n"))}${line(tr("s14.google.card.description"), data.description)}`;
}
function sourceRow(item: PersonalEvidence, read: PersonalRead): string {
  const stamp = item.sourceTimestamp === null ? `<b>${tr("s14.brief.time_unknown")}</b>` : zoned(item.sourceTimestamp, read.window.timezone);
  const body = item.kind === "event" ? eventText(item) : `<p>${e(item.text)}</p>`;
  return `<article class="s-source-row" id="source-${e(item.source.id)}" aria-label="${tr(k(`s14.brief.kind.${item.kind}`))}"><div class="s-mem-hd">${pill(tr(k(`s14.brief.kind.${item.kind}`)))}</div>${untrusted(`<p><b>${e(item.title)}</b></p>`, tr("s14.brief.source_tag"))}<dl class="s-kv"><dt>${tr(k(`s14.brief.stamp.${item.kind}`))}</dt><dd>${stamp}</dd>${item.timezone ? `<dt>${tr("s14.brief.event_zone")}</dt><dd class="s-mono">${e(item.timezone)}</dd>` : ""}<dt>${tr("s14.brief.retrieved")}</dt><dd>${zoned(item.retrievedAt, read.window.timezone)}</dd></dl><details class="s-more"><summary>${tr("s14.brief.show_text")}</summary><div>${untrusted(body, tr("s14.brief.source_tag"))}<p class="s-meta">${tr("s14.brief.provider_id")} <span class="s-mono">${e(item.providerId)}</span></p></div></details></article>`;
}
/** The line for an empty read. Only a clean read of a known window may say it found nothing, and it says what that covers. */
function emptyLine(read: PersonalRead, connection: PersonalConnection | undefined): string {
  if (read.evidence.length) return "";
  if (read.outcome === "success" && !read.stale && !read.missing.length) return `<p class="s-sub">${tr(connection?.service === "calendar" ? "s14.brief.empty_calendar" : "s14.brief.empty_mail")}</p>`;
  return read.outcome === "running" ? "" : `<p class="s-sub">${tr(read.outcome === "withdrawn" ? "s14.brief.withdrawn" : "s14.brief.not_read")}</p>`;
}
function section(page: S14Page, read: PersonalRead, brief: S14Brief): string {
  const connection = brief.connections[read.connectionId], zone = read.window.timezone, bot = page.state.bots.find(item => item.id === read.botId) ?? { id: read.botId, name: read.botId };
  const calendar = connection?.service === "calendar" ? `<dt>${tr("s14.brief.calendar_zone")}</dt><dd>${read.calendarTimezone ? `<span class="s-mono">${e(read.calendarTimezone)}</span>` : `<b>${tr("s14.brief.zone_unknown")}</b>`}</dd>` : "";
  const stale = read.stale ? banner("warn", tr("s14.brief.stale_title"), tr("s14.brief.stale_detail")) : "";
  const gaps = read.missing.length ? `<div class="s-stack"><p class="s-exact-label">${tr("s14.brief.missing_here")}</p>${gapList(read.missing)}</div>` : "";
  return `<article class="s-card s-stack" aria-label="${tr("s14.brief.section")}"><div class="s-between"><h4 class="s-brief-t">${accountOf(connection)}</h4><span class="s-row-pills">${read.stale ? pill(tr("s14.brief.stale"), "warn", "!") : ""}${outcomePill(read)}</span></div>${stale}<dl class="s-kv"><dt>${tr("s14.brief.window")}</dt><dd>${zoned(read.window.from, zone)} → ${zoned(read.window.to, zone)}</dd><dt>${tr("s14.brief.brief_zone")}</dt><dd class="s-mono">${e(zone)}</dd>${calendar}<dt>${tr("s14.brief.read_at")}</dt><dd>${read.finishedAt === null ? tr("s14.brief.not_finished") : zoned(read.finishedAt, zone)}</dd><dt>${tr("s14.brief.read_by")}</dt><dd>${e(botName(bot))}</dd></dl>${gaps}${emptyLine(read, connection)}${read.evidence.map(item => sourceRow(item, read)).join("")}</article>`;
}
/** The fixed head. "All read" never claims the brief is complete or that nothing needs the owner. */
function statusBanner(brief: S14Brief): string {
  if (brief.status === "complete") return banner("", tr("s14.brief.status.complete"), tr("s14.brief.status.complete_detail"));
  return banner("warn", tr(k(`s14.brief.status.${brief.status}`)), tr(k(`s14.brief.status.${brief.status}_detail`)));
}
/** Inputs the grant named that were never read, with the account each one would have read. */
function unreadBlock(brief: S14Brief): string {
  const unread = brief.gaps.filter(gap => gap.personal?.missing.includes("required_input_missing")); if (!unread.length) return "";
  const row = (scopeId: string) => { const connection = brief.slots[scopeId]; return `<li>${scopeId === "unconfigured" ? tr("s14.brief.unconfigured") : accountOf(connection)} · ${tr("s14.brief.gap.required_input_missing")}</li>`; };
  return `<section class="s-card s-stack" aria-labelledby="s14-brief-unread"><h4 class="s-brief-t" id="s14-brief-unread">${tr("s14.brief.unread")}</h4><ul class="s-reach-list">${unread.map(gap => row(gap.personal!.scopeId)).join("")}</ul></section>`;
}
/** Brief tab of one work item. The Bot's written brief lives in Report; this tab is what it was given. */
export function briefTab(page: S14Page, brief: S14Brief | null | undefined, reportHref: string): string {
  if (!brief) return banner("", tr("s14.brief.none"), tr("s14.brief.none_detail"));
  const fact = (name: string, value: string) => `<div><dt>${tr(k(`s14.brief.fact.${name}`))}</dt><dd>${value}</dd></div>`, zones = [...new Set(brief.sections.map(read => read.window.timezone))], unread = brief.gaps.filter(gap => gap.personal?.missing.includes("required_input_missing")).length;
  const facts = `<dl class="s-facts" aria-label="${tr("s14.brief.facts")}">${fact("read", `<b>${brief.sections.filter(read => read.outcome === "success" || read.outcome === "partial").length}</b>`)}${fact("unread", `<b>${unread + brief.sections.filter(read => read.outcome === "failed" || read.outcome === "withdrawn").length}</b>`)}${fact("stale", `<b>${brief.sections.filter(read => read.stale).length}</b>`)}${fact("zone", zones.length ? zones.map(zone => `<span class="s-mono">${e(zone)}</span>`).join(" · ") : tr("s14.unknown"))}</dl>`;
  return `${statusBanner(brief)}${facts}${unreadBlock(brief)}${brief.sections.map(read => section(page, read, brief)).join("")}<p class="s-note">${tr("s14.brief.note")} <a class="s-link-text" href="${reportHref}">${tr("s14.brief.open_report")}</a></p>`;
}
/** One line for a report's missing list, in the same words as the Brief tab. */
export function briefGapRow(scopeId: string, stale: boolean, missing: string[], href: string): string {
  const words = [...new Set(missing)].map(gapWord);
  return `<li><a class="s-link-text" href="${href}">${tr("s14.brief.report_gap")}</a>${words.length ? ` · ${words.map(e).join(" · ")}` : ""}${stale ? ` · ${tr("s14.brief.stale")}` : ""} <span class="s-mono s-meta">${e(scopeId)}</span></li>`;
}
