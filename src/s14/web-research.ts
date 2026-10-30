import { tr } from "../i18n";
import type { WorkView } from "./authority-types";
import type { ExternalEvidence, WebOutcome, WebRead } from "./parallel-types";
import { banner, botName, commandForm, e, flat, hidden, k, notice, ownerStrip, pill, shell, short, size, untrusted, when } from "./web-pages";
import type { S14Page } from "./web";
import type { S14WebSettings, S14WorkResearch } from "./web-product-memory";

type Outcome = WebOutcome | "running";
/** Word, tone and glyph per outcome: the pill states the fact and colour only repeats it. */
const outcomeTone: Record<Outcome, [string, string]> = { running: ["strong", ""], success: ["ok", "✓"], partial: ["warn", "!"], quota: ["warn", "!"], schema_changed: ["danger", "×"], service_error: ["danger", "×"], blocked: ["warn", "!"], private_context: ["warn", "!"], credential_refused: ["warn", "!"], cancelled: ["", ""], deadline: ["warn", "!"], oversize: ["warn", "!"], authority_changed: ["warn", "!"], key_unavailable: ["danger", "×"] };
export const outcomePill = (outcome: Outcome) => pill(tr(k(`s14.web_outcome.${outcome}`)), ...outcomeTone[outcome]);
const failed = (read: WebRead) => read.outcome !== "success" && read.outcome !== "running";
const webTools = ["web_search", "web_fetch"];
const placeholders: Record<string, string> = { "[refused input]": "s14.evidence.subject_refused", "[outbound blocked]": "s14.evidence.subject_blocked", "[withdrawn context]": "s14.evidence.subject_withdrawn" };

function modeWord(mode: WebRead["mode"]): string { return tr(mode === "anonymous" ? "s14.web.mode_anonymous" : "s14.web.mode_authenticated"); }
function outcomeBanner(read: WebRead): string {
  if (read.outcome === "running") return "";
  const withdrawn = read.subject === "[withdrawn context]", key = withdrawn ? "withdrawn" : read.outcome === "quota" && read.mode === "authenticated" ? "quota_account" : read.outcome;
  if (read.outcome === "success") return "";
  const tone = outcomeTone[read.outcome][0] === "danger" ? "danger" : "warn", title = tr(k(`s14.web_outcome.${key}_title`)), left = read.dispatched ? tr("s14.evidence.was_sent") : tr("s14.evidence.not_sent");
  const action = read.outcome === "quota" || read.outcome === "key_unavailable" ? `<p><a class="s-link-text" href="/settings/web">${tr("s14.evidence.open_web_settings")}</a></p>` : "";
  return banner(tone as "warn" | "danger", title, `${tr(k(`s14.web_outcome.${key}_detail`))} ${left}`, action);
}
function usageRows(read: WebRead): string {
  if (read.usage === null) return `<span>${tr("s14.unknown")}</span>`;
  if (!read.usage.length) return `<span>${tr("s14.evidence.usage_empty")}</span>`;
  return `${read.usage.map(item => `<span class="s-mono">${e(item.name)} × ${item.count} · US$${e(item.costUsd)}</span>`).join("<br>")}<br><span class="s-note">${tr("s14.evidence.usage_reported")}</span>`;
}
const coverageTone: Record<ExternalEvidence["coverage"], string> = { snippet: "warn", excerpt: "warn", full_content_returned: "strong" };
function sourceRow(item: ExternalEvidence, index: number): string {
  const requested = item.requestedUrl && item.requestedUrl !== item.url ? `<dt>${tr("s14.evidence.requested")}</dt><dd class="s-mono">${e(item.requestedUrl)}</dd>` : "";
  const final = item.finalUrl && item.finalUrl !== item.url ? `<dt>${tr("s14.evidence.final")}</dt><dd class="s-mono">${e(item.finalUrl)}</dd>` : "";
  const cache = item.cache ? `<dt>${tr("s14.evidence.cache")}</dt><dd class="s-mono">${e(JSON.stringify(item.cache))}</dd>` : "";
  const content = item.content ? `<details class="s-more"><summary>${tr("s14.evidence.show_text")} (${size(Buffer.byteLength(item.content))})</summary><div><p>${e(item.content)}</p></div></details>` : `<p class="s-sub">${tr("s14.evidence.no_text")}</p>`;
  return `<article class="s-source" id="source-${e(item.id)}" aria-label="${tr("s14.evidence.source")} ${index + 1}"><span class="s-source-n" aria-hidden="true">${index + 1}</span><div class="s-stack"><div class="s-mem-hd">${pill(tr(k(`s14.coverage.${item.coverage}`)), coverageTone[item.coverage])}${pill(tr(k(`s14.freshness.${item.freshness}`)), item.freshness === "unknown" ? "" : "strong", item.freshness === "unknown" ? "?" : "")}${item.truncated ? pill(tr("s14.coverage.truncated"), "warn", "!") : ""}</div>
    <p class="s-mono">${e(item.url)}</p><dl class="s-kv">${requested}${final}<dt>${tr("s14.evidence.received")}</dt><dd>${when(item.retrievedAt)}</dd><dt>${tr("s14.evidence.published")}</dt><dd>${item.publishedAt ? `<span class="s-mono">${e(item.publishedAt)}</span>` : tr("s14.unknown")}</dd><dt>${tr("s14.evidence.reported_at")}</dt><dd>${item.reportedRetrievedAt ? `<span class="s-mono">${e(item.reportedRetrievedAt)}</span>` : tr("s14.unknown")}</dd>${cache}</dl>${untrusted(`<p><b>${e(item.title)}</b></p>${content}`, tr("s14.untrusted.source"))}</div></article>`;
}
function missingRows(read: WebRead): string {
  const failures = read.failures.map(item => `<li><span class="s-mono">${e(item.url)}</span> · <span class="s-mono">${e(item.kind)}${item.status === null ? "" : ` ${item.status}`}</span></li>`);
  const missing = read.missing.map(url => `<li><span class="s-mono">${e(url)}</span> · ${tr("s14.evidence.not_returned")}</li>`);
  return failures.length || missing.length ? `<div><p class="s-exact-label">${tr("s14.evidence.unread")}</p><ul class="s-history">${[...failures, ...missing].join("")}</ul></div>` : "";
}
function readCard(page: S14Page, read: WebRead): string {
  const bot = page.state.bots.find(b => b.id === read.botId), key = placeholders[read.subject];
  const subject = key ? `<p class="s-sub">${tr(k(key))}</p>` : `<pre class="s-exact">${e(read.subject)}</pre>`;
  const finished = read.finishedAt === null ? tr("s14.evidence.not_finished") : when(read.finishedAt);
  return `<article class="s-read" aria-label="${tr(k(`s14.evidence.tool.${read.tool}`))}"><div class="s-mem-hd"><b>${tr(k(`s14.evidence.tool.${read.tool}`))}</b><span class="s-grow"></span>${outcomePill(read.outcome)}</div>${subject}${outcomeBanner(read)}
    <p class="s-meta">${e(botName(bot ?? { id: read.botId, name: read.botId }))} · ${modeWord(read.mode)} <span class="s-mono">r${read.settingRevision}</span> · ${tr("s14.evidence.left_machine")}: ${tr(read.dispatched ? "s14.evidence.yes" : "s14.evidence.no")} · ${tr("s14.evidence.requests")}: ${read.remoteRequests}<br>${when(read.requestedAt)} → ${finished}</p><p class="s-meta">${tr("s14.evidence.usage")}: ${usageRows(read)}</p>
    ${missingRows(read)}${read.omittedResults ? `<p class="s-note">${tr("s14.evidence.omitted")} ${read.omittedResults}</p>` : ""}${read.evidence.length ? `<div class="s-stack">${read.evidence.map(sourceRow).join("")}</div>` : ""}</article>`;
}
function contextRows(page: S14Page, research: S14WorkResearch): string {
  if (!research.contexts.length) return "";
  const row = (packet: S14WorkResearch["contexts"][number]) => {
    const retired = packet.state === "retired", claims = packet.claims.map(claim => untrusted(`<p>${e(claim.text)}</p>`, tr("s14.untrusted.memory"))).join(""), decisions = packet.decisions.map(item => untrusted(`<p>${e(item.text)}</p>`, tr("s14.untrusted.memory"))).join("");
    return `<li class="s-stack"><div class="s-mem-hd">${pill(tr(retired ? "s14.evidence.context_retired" : "s14.evidence.context_current"), retired ? "" : "strong")}<span class="s-mono s-meta">${e(short(packet.id))}</span></div>${retired ? `<p class="s-sub">${tr("s14.evidence.context_retired_detail")}</p>` : `${claims}${decisions}${claims || decisions ? "" : `<p class="s-note">${tr("s14.evidence.context_empty")}</p>`}`}${packet.omitted ? `<p class="s-note">${tr("s14.evidence.context_omitted")} ${packet.omitted}</p>` : ""}</li>`;
  };
  return `<section class="s-card s-stack" aria-labelledby="s14-contexts"><h3 id="s14-contexts">${tr("s14.evidence.contexts")}</h3><p class="s-note">${tr("s14.evidence.contexts_note")}</p><ul class="s-history">${research.contexts.map(row).join("")}</ul></section>`;
}
function rollup(reads: WebRead[]): string {
  const counts = new Map<Outcome, number>();
  for (const read of reads) counts.set(read.outcome, (counts.get(read.outcome) ?? 0) + 1);
  return `<div class="s-mem-hd" role="group" aria-label="${tr("s14.evidence.rollup")}">${[...counts].map(([outcome, count]) => pill(`${tr(k(`s14.web_outcome.${outcome}`))} ${count}`, ...outcomeTone[outcome])).join("")}</div>`;
}
function reportedUsage(reads: WebRead[]): string {
  const finished = reads.filter(read => read.outcome !== "running"), unknown = finished.filter(read => read.usage === null).length, cost = finished.flatMap(read => read.usage ?? []).reduce((sum, item) => sum + item.costUsd, 0);
  const known = finished.length - unknown;
  return `<dt>${tr("s14.evidence.usage")}</dt><dd>${known ? `<span class="s-mono">US$${e(Number(cost.toFixed(6)))}</span> · ${tr("s14.evidence.usage_from")} ${known} · ` : ""}${tr("s14.evidence.usage_unknown")} ${unknown}</dd>`;
}
/** Evidence tab: what left the machine first, then every read with its honest outcome and every source with its coverage. */
export function evidenceTab(page: S14Page, view: WorkView, research: S14WorkResearch | null): string {
  const reads = research?.reads ?? [], hasTools = view.grant?.tools.some(tool => webTools.includes(tool)) ?? false;
  if (!research || !reads.length) return `${banner("", tr(hasTools ? "s14.evidence.none_yet" : "s14.evidence.none_granted"), tr(hasTools ? "s14.evidence.none_yet_detail" : "s14.evidence.none_granted_detail"))}${research ? contextRows(page, research) : ""}`;
  const sent = reads.filter(read => read.dispatched), queries = sent.filter(read => read.tool === "web_search").length, urls = sent.length - queries, refused = reads.filter(read => !read.dispatched && read.outcome !== "running").length;
  const modes = [...new Set(sent.map(read => read.mode))], gaps = reads.some(failed);
  const exact = sent.filter(read => !placeholders[read.subject]).map(read => `<li class="s-mono">${e(read.subject)}</li>`).join("");
  return `${banner("", `${tr("s14.evidence.left")}: ${queries} ${tr("s14.evidence.queries")} · ${urls} ${tr("s14.evidence.urls")}`, `${modes.length ? `${tr("s14.evidence.sent_to")} ${modes.map(modeWord).join(" · ")}. ` : ""}${tr("s14.evidence.guard_note")}`)}
    ${rollup(reads)}${banner(gaps ? "warn" : "", tr(gaps ? "s14.evidence.gaps" : "s14.evidence.no_gaps"), tr(gaps ? "s14.evidence.gaps_detail" : "s14.evidence.no_gaps_detail"))}
    <dl class="s-kv"><dt>${tr("s14.evidence.refused")}</dt><dd>${refused}</dd>${reportedUsage(reads)}</dl>${exact ? `<section class="s-stack" aria-labelledby="s14-sent"><h3 class="s-section-t" id="s14-sent">${tr("s14.evidence.exact_sent")}</h3><ul class="s-stack">${exact}</ul></section>` : ""}
    <section class="s-stack" aria-labelledby="s14-reads"><h3 class="s-section-t" id="s14-reads">${tr("s14.evidence.reads")}</h3>${reads.map(read => readCard(page, read)).join("")}${reads.length >= 256 ? `<p class="s-note">${tr("s14.evidence.limit_note")}</p>` : ""}</section>${contextRows(page, research)}`;
}
/** One Progress line per failed read kind, so a limit is visible without opening Evidence. */
export function researchNotice(research: S14WorkResearch | null, href: string): string {
  const reads = research?.reads ?? [], limited = reads.filter(failed); if (!limited.length) return "";
  const latest = limited.at(-1)!;
  return banner("warn", `${tr("s14.evidence.progress_title")} ${limited.length}`, tr(k(`s14.web_outcome.${latest.outcome}_title`)), `<p><a class="s-link-text" href="${href}">${tr("s14.evidence.open")}</a></p>`);
}

function stateBanner(view: S14WebSettings): string {
  const { setting, keyState } = view.read;
  if (setting.mode === "anonymous") return banner("ok", tr("s14.web.free_title"), tr("s14.web.free_detail"));
  if (keyState === "present") return banner("warn", tr("s14.web.paid_title"), tr("s14.web.paid_detail"));
  return banner("danger", tr(keyState === "unsafe" ? "s14.web.key_unsafe" : "s14.web.key_gone"), tr("s14.web.key_gone_detail"));
}
function capabilityRow(page: S14Page): string {
  const bots = page.state.bots.filter(bot => bot.enabled), allowed = bots.filter(bot => webTools.some(tool => bot.capabilities.tools.includes(tool))), other = bots.filter(bot => !allowed.includes(bot));
  const names = (items: typeof bots) => items.map(bot => `${e(botName(bot))}${allowed.includes(bot) ? ` <span class="s-note">${webTools.filter(tool => bot.capabilities.tools.includes(tool)).map(e).join(" · ")}</span>` : ""}`).join(" · ");
  return `<dt>${tr("s14.web.can_research")}</dt><dd>${allowed.length ? names(allowed) : tr("s14.web.nobody")}</dd>${other.length ? `<dt>${tr("s14.web.cannot_research")}</dt><dd>${names(other)}<br><span class="s-note">${tr("s14.web.cannot_research_note")}</span></dd>` : ""}`;
}
function receiptBanner(view: S14WebSettings): string {
  const receipt = view.receipt; if (!receipt) return "";
  const word = receipt.kind === "web.parallel.key.set" ? "key_saved" : receipt.kind === "web.parallel.key.remove" ? "key_removed" : receipt.setting?.mode === "anonymous" ? "free" : "paid";
  return banner("ok", tr(k(`s14.web.done.${word}`)), tr(k(`s14.web.done.${word}_detail`)));
}
function keyRows(page: S14Page, view: S14WebSettings): string {
  const { setting, connections } = view.read, live = connections.filter(item => item.state === "set");
  const row = (item: typeof live[number]) => {
    const selected = setting.mode === "authenticated" && setting.connectionId === item.id;
    const enable = selected ? "" : `<form class="s-stack" method="post" action="/s14/forms/parallel-enable">${flat(page.csrf, setting.revision)}${hidden("connectionId", item.id)}<label class="s-check"><input type="checkbox" name="billing" value="on" required><span>${tr("s14.web.billing_ack")}</span></label><div><button class="s-btn primary">${tr("s14.web.enable")}</button></div></form>`;
    return `<article class="s-slip" data-state="closed" aria-label="${tr("s14.web.key_label")}"><div class="s-slip-hd"><div><h3>${tr("s14.web.key_label")} <span class="s-mono s-meta">${e(short(item.id))} r${item.revision}</span></h3><p class="s-meta">${tr(selected ? "s14.web.key_in_use" : "s14.web.key_stored")}</p></div>${pill(tr(selected ? "s14.web.mode_authenticated" : "s14.web.key_off"), selected ? "warn" : "")}</div>${ownerStrip(commandForm(page.csrf, "web.parallel.key.remove", item.revision, { connectionId: item.id }, tr("s14.web.remove"), "s-btn danger"), tr(selected ? "s14.web.remove_selected_note" : "s14.web.remove_note"), enable)}</article>`;
  };
  return live.map(row).join("");
}
function accountSection(page: S14Page, view: S14WebSettings): string {
  const { setting } = view.read, back = setting.mode === "authenticated" ? `<div class="s-slip" data-state="closed">${ownerStrip(commandForm(page.csrf, "web.parallel.configure", setting.revision, { mode: "anonymous", connectionId: null, billingAcknowledged: false }, tr("s14.web.back_free")), tr("s14.web.back_free_note"))}</div>` : "";
  const form = `<form class="s-stack" method="post" action="/s14/forms/parallel-key" autocomplete="off">${flat(page.csrf, 0)}<label class="s-field"><span>${tr("s14.web.key_field")}</span><input type="password" name="secret" required minlength="8" autocomplete="new-password" spellcheck="false"></label><p class="s-note">${tr("s14.web.key_note")}</p><div><button class="s-btn">${tr("s14.web.key_save")}</button></div></form>`;
  const body = `<div class="s-stack">${setting.mode === "anonymous" ? `<p class="s-sub">${tr("s14.web.account_lead")}</p>` : ""}${keyRows(page, view)}${form}${back}</div>`;
  const open = view.read.connections.some(item => item.state === "set");
  return setting.mode === "anonymous" ? `<details class="s-card s-more"${open ? " open" : ""}><summary>${tr("s14.web.account")}</summary><div>${body}</div></details>` : `<section class="s-card s-stack" aria-labelledby="s14-account"><h2 id="s14-account">${tr("s14.web.account")}</h2>${body}</section>`;
}
/** Parallel settings: free mode needs nothing here, and a key is write-only, opt-in and never switches mode by itself. */
export function webSettingsPage(page: S14Page, view: S14WebSettings): string {
  const { setting, readiness } = view.read, paid = setting.mode === "authenticated";
  const card = `<section class="s-card s-stack" aria-labelledby="s14-parallel"><div class="s-between"><div><h2 id="s14-parallel">Parallel</h2><p class="s-sub">${tr(paid ? "s14.web.mode_authenticated_detail" : "s14.web.mode_anonymous_detail")}</p></div>${pill(tr(paid ? "s14.web.mode_authenticated" : "s14.web.mode_anonymous"), paid ? "warn" : "strong")}</div>
    <dl class="s-kv"><dt>${tr("s14.web.sends")}</dt><dd>${tr("s14.web.sends_detail")}</dd><dt>${tr("s14.web.reads")}</dt><dd>${tr("s14.web.reads_detail")}</dd><dt>${tr("s14.web.limit")}</dt><dd>${tr("s14.web.limit_detail")}</dd><dt>${tr("s14.web.bounds")}</dt><dd>${tr("s14.web.bounds_detail")}</dd><dt>${tr("s14.web.unavailable")}</dt><dd>${tr("s14.web.unavailable_detail")}</dd><dt>${tr("s14.web.readiness")}</dt><dd>${tr(k(`s14.web.readiness_${readiness}`))}</dd>${capabilityRow(page)}<dt>${tr("s14.web.revision")}</dt><dd class="s-mono">r${setting.revision}</dd></dl></section>`;
  return shell(page, tr("s14.web.title"), `<div class="s-col">${receiptBanner(view)}${notice(view.notice)}${stateBanner(view)}${card}${accountSection(page, view)}<p><a class="s-link-text" href="/more">${tr("s14.web.back")}</a></p></div>`, { current: "more", subtitle: tr("s14.web.subtitle") });
}
