import { tr } from "../i18n";
import type { MessageKey } from "../i18n";
import type { MemoryLookup, MemoryRef, MemorySource } from "./memory-types";
import type { Bot } from "./types";
import { banner, botName, e, flat, hidden, k, notice, ownerStrip, pill, rid, shell, short, untrusted, when } from "./web-pages";
import type { S14Page } from "./web";
import { memoryShareHours, type S14MemoryAction, type S14MemoryBrowse, type S14MemoryClaimView, type S14MemoryGone, type S14MemoryRow, type S14MemorySource, type S14MemorySourceView } from "./web-product-memory";

const claimHref = (botId: string, ref: MemoryRef, action?: S14MemoryAction) => `/memory/${e(botId)}/claims/${e(ref.id)}?revision=${ref.revision}&amp;generation=${ref.generation}${action ? `&amp;action=${action}#slip` : ""}`;
const sourceHref = (botId: string, id: string) => `/memory/${e(botId)}/sources/${e(id)}`;
const refText = (ref: MemoryRef) => `<span class="s-mono s-meta">${e(short(ref.id))} r${ref.revision} g${ref.generation}</span>`;
const nameOf = (page: S14Page, id: string) => botName(page.state.bots.find(b => b.id === id) ?? { id, name: id });
const kindPill = (kind: "fact" | "inference") => pill(tr(k(`s14.memory.kind.${kind}`)), kind === "fact" ? "strong" : "");
const scopePill = (page: S14Page, row: S14MemoryRow) => row.access.shared ? pill(tr("s14.memory.scope.shared"), "strong") : pill(`${tr("s14.memory.scope.private")} ${nameOf(page, row.claim.botId)}`);
const memoryFrame = (text: string) => untrusted(`<p>${e(text)}</p>`, tr("s14.untrusted.memory"));
const sourceLabel = (source: MemorySource) => tr(k(`s14.untrusted.source_${source.attribution}`));
const list = (keys: MessageKey[]) => `<ul class="s-reach-list">${keys.map(key => `<li>${tr(key)}</li>`).join("")}</ul>`;

function claimRow(page: S14Page, row: S14MemoryRow, viewer: Bot | null): string {
  const { claim, access } = row, own = !viewer || viewer.id === claim.botId, href = (action?: S14MemoryAction) => claimHref(claim.botId, claim, action);
  const conflicts = claim.conflicts.length ? pill(`${tr("s14.memory.conflicts")} ${claim.conflicts.length}`, "warn", "!") : "";
  const received = own ? "" : `<p class="s-meta">${tr("s14.memory.from_shared")} ${e(nameOf(page, claim.botId))}</p>`;
  const quote = claim.quote !== claim.text ? `<div><p class="s-exact-label">${tr("s14.memory.quote")}</p><pre class="s-exact">${e(claim.quote)}</pre></div>` : "";
  const actions = [`<a class="s-link-text" href="${href()}">${tr("s14.memory.open")}</a>`, ...(own ? [`<a class="s-link-text" href="${href("correct")}">${tr("s14.memory.action.correct")}</a>`, `<a class="s-link-text" href="${href("forget")}">${tr("s14.memory.action.forget")}</a>`, `<a class="s-link-text" href="${href("delete")}">${tr("s14.memory.action.delete")}</a>`, `<a class="s-link-text" href="${href(access.shared ? "revoke" : "publish")}">${tr(access.shared ? "s14.memory.action.revoke" : "s14.memory.action.publish")}</a>`] : [])];
  return `<article class="s-mem" aria-label="${tr("s14.memory.claim")} r${claim.revision}"><div class="s-mem-hd">${kindPill(claim.kind)}${scopePill(page, row)}${conflicts}<span class="s-grow"></span><span class="s-meta">${when(claim.createdAt)}</span></div>${memoryFrame(claim.text)}${quote}${received}<p class="s-meta">${tr("s14.memory.source")}: <a class="s-link-text" href="${sourceHref(claim.botId, claim.source.id)}">${refText(claim.source)}</a> · ${tr("s14.memory.revision")} r${claim.revision}${access.shared ? ` · ${tr("s14.memory.publication")} r${access.revision}` : ""}</p><div class="s-mem-acts">${actions.join("")}</div></article>`;
}
const goneWords = (gone: Pick<S14MemoryGone, "modes" | "reason">) => gone.modes.includes("deleted") ? "deleted" : gone.modes.includes("forgotten") ? "forgotten" : gone.modes.includes("corrected") ? "corrected" : gone.reason === "memory_withdrawn" ? "withdrawn" : "unavailable";
function goneRow(botId: string, gone: S14MemoryGone): string {
  const word = goneWords(gone);
  return `<li><p>${pill(tr(k(`s14.memory.gone.${word}`)))} <a class="s-link-text" href="${claimHref(botId, gone.reference)}">${refText(gone.reference)}</a></p><p class="s-sub">${tr(k(`s14.memory.gone.${word}_detail`))}</p></li>`;
}
function sourceStatus(item: S14MemorySource): string {
  if (item.source.text === null) return pill(tr("s14.memory.gone.deleted"));
  if (item.modes.includes("forgotten")) return pill(tr("s14.memory.gone.forgotten"));
  return item.modes.length ? pill(tr("s14.memory.gone.corrected")) : "";
}
function sourceRow(botId: string, item: S14MemorySource): string {
  const { source } = item, text = source.text;
  return `<li><p><a class="s-link-text" href="${sourceHref(botId, source.id)}">${refText(source)}</a> ${pill(tr(k(`s14.memory.attribution.${source.attribution}`)))} ${sourceStatus(item)}</p><p class="s-meta">${when(source.createdAt)}</p>${text === null ? `<p class="s-sub">${tr("s14.memory.source_gone")}</p>` : `<p class="s-meta">${text.length > 200 ? tr("s14.memory.source_long") : tr("s14.memory.source_open")}</p>`}</li>`;
}
function scopeTabs(page: S14Page, view: S14MemoryBrowse): string {
  const link = (scope: string, label: string) => `<a href="/memory?scope=${e(scope)}"${view.scope === scope ? ' aria-current="page"' : ""}>${e(label)}</a>`;
  return `<nav class="s-worktabs s-memtabs" aria-label="${tr("s14.memory.tabs")}">${page.state.bots.map(bot => link(bot.id, botName(bot))).join("")}${link("shared", tr("s14.memory.shared"))}</nav>`;
}
function receiptBanner(view: S14MemoryBrowse): string {
  const receipt = view.receipt; if (!receipt) return "";
  const word = receipt.kind.slice("memory.".length).replace(".", "_");
  return banner("ok", tr(k(`s14.memory.done.${word}`)), `${tr(k(`s14.memory.done.${word}_detail`))}${receipt.withdrawn ? ` ${tr("s14.memory.done.withdrawn")} ${receipt.withdrawn}` : ""}`);
}
function rememberForm(page: S14Page, view: S14MemoryBrowse, bot: Bot): string {
  if (!view.conversation) return "";
  return `<section class="s-card s-stack" aria-labelledby="s14-remember"><h2 id="s14-remember">${tr("s14.memory.remember")}</h2><form class="s-stack" method="post" action="/s14/forms/memory-remember">${flat(page.csrf, view.conversation.revision)}${hidden("botId", bot.id)}${hidden("conversationId", view.conversation.id)}<label class="s-field"><span>${tr("s14.memory.remember_label")}</span><textarea name="text" required maxlength="2048">${view.draftForm === "memory-remember" ? e(view.draft) : ""}</textarea></label><p class="s-note">${tr("s14.memory.remember_note")}</p><div><button class="s-btn">${tr("s14.memory.remember_submit")}</button></div></form></section>`;
}
function decisionForm(page: S14Page, botId: string, conversationId: string, key: string, revision: number, text: string, label: string, fieldLabel: string): string {
  return `<form class="s-stack" method="post" action="/s14/forms/memory-decision">${flat(page.csrf, revision)}${hidden("botId", botId)}${hidden("conversationId", conversationId)}${hidden("key", key)}<label class="s-field"><span>${e(fieldLabel)}</span><textarea name="text" required maxlength="4000">${e(text)}</textarea></label><div><button class="s-btn">${e(label)}</button></div></form>`;
}
function decisions(page: S14Page, view: S14MemoryBrowse, bot: Bot): string {
  const rows = view.decisions.map(({ decision, sourceGone }) => `<li class="s-stack"><div class="s-mem-hd">${pill(tr("s14.memory.pinned"), "strong")}${refText(decision)}</div>${memoryFrame(decision.text)}${sourceGone ? `<p class="s-sub">${tr("s14.memory.source_gone")}</p>` : ""}<details class="s-more"><summary>${tr("s14.memory.decision_edit")} (r${decision.revision + 1})</summary><div>${decisionForm(page, bot.id, decision.conversationId, decision.key, decision.revision, decision.text, `${tr("s14.memory.decision_save")} r${decision.revision + 1}`, tr("s14.memory.decision_text"))}</div></details></li>`).join("");
  const draft = view.draftForm === "memory-decision" ? view.draft : "";
  const add = view.conversation ? `<details class="s-more"${draft ? " open" : ""}><summary>${tr("s14.memory.decision_new")}</summary><div>${decisionForm(page, bot.id, view.conversation.id, rid(), 0, draft, tr("s14.memory.decision_pin"), tr("s14.memory.decision_text"))}</div></details>` : "";
  return `<section class="s-card s-stack" aria-labelledby="s14-decisions"><h2 id="s14-decisions">${tr("s14.memory.decisions")}</h2><p class="s-sub">${tr("s14.memory.decisions_note")}</p>${rows ? `<ul class="s-history">${rows}</ul>` : `<p class="s-note">${tr("s14.memory.decisions_empty")}</p>`}${add}<p class="s-note">${tr("s14.memory.decisions_limit")}</p></section>`;
}
function searchForm(view: S14MemoryBrowse): string {
  return `<form class="s-memsearch" method="get" action="/memory" role="search">${hidden("scope", view.scope)}<label class="s-field"><span class="sr-only">${tr("s14.memory.search")}</span><input type="search" name="q" maxlength="200" value="${e(view.query)}" placeholder="${tr("s14.memory.search")}" autocomplete="off"></label><button class="s-btn">${tr("s14.memory.search_submit")}</button></form>`;
}

function browsePage(page: S14Page, view: S14MemoryBrowse): string {
  const bot = view.bot, lead = bot ? `${tr("s14.memory.lead_bot")} ${botName(bot)} ${tr("s14.memory.lead_bot_tail")}` : tr("s14.memory.lead_shared");
  const empty = view.query ? tr("s14.memory.no_match") : bot ? tr("s14.memory.empty_bot") : tr("s14.memory.empty_shared");
  const claims = `<section class="s-stack" aria-labelledby="s14-claims"><h2 class="s-section-t" id="s14-claims">${tr("s14.memory.claims")}</h2>${view.rows.map(row => claimRow(page, row, bot)).join("") || `<p class="s-sub">${e(empty)}</p>`}${view.rows.length >= 200 ? `<p class="s-note">${tr("s14.memory.limit_note")}</p>` : ""}</section>`;
  const gone = bot && view.gone.length ? `<section class="s-card s-stack" aria-labelledby="s14-gone"><h2 id="s14-gone">${tr("s14.memory.withdrawn")}</h2><ul class="s-history">${view.gone.map(item => goneRow(bot.id, item)).join("")}</ul></section>` : "";
  const sources = bot && !view.query && view.sources.length ? `<details class="s-card s-more"><summary>${tr("s14.memory.sources")} (${view.sources.length})</summary><div><p class="s-note">${tr("s14.memory.sources_note")}</p><ul class="s-history">${view.sources.map(item => sourceRow(bot.id, item)).join("")}</ul></div></details>` : "";
  return shell(page, tr("s14.memory.title"), `<div class="s-col">${scopeTabs(page, view)}${receiptBanner(view)}${notice(view.notice)}<p class="s-sub">${e(lead)}</p><p class="s-note">${tr("s14.memory.fact_note")}</p>${searchForm(view)}${claims}${bot && !view.query ? rememberForm(page, view, bot) : ""}${bot && !view.query ? decisions(page, view, bot) : ""}${gone}${sources}</div>`, { current: "memory", subtitle: tr("s14.memory.subtitle") });
}

function memoryForm(page: S14Page, form: string, view: S14MemoryClaimView, revision: number, label: string, cls: string, fields = ""): string {
  return `<form class="s-stack" method="post" action="/s14/forms/${form}">${flat(page.csrf, revision)}${hidden("botId", view.bot.id)}${hidden("claimId", view.ref.id)}${hidden("revision", view.ref.revision)}${hidden("generation", view.ref.generation)}${fields}<div><button class="${cls}">${e(label)}</button></div></form>`;
}
function reach(does: MessageKey[], cannot: MessageKey[]): string {
  return `<div class="s-reach"><div><h3 class="s-section-t">${tr("s14.memory.reach.does")}</h3>${list(does)}</div><div><h3 class="s-section-t">${tr("s14.memory.reach.cannot")}</h3>${list(cannot)}</div></div>`;
}
function impactBlock(view: S14MemoryClaimView): string {
  const data = view.impact; if (!data) return "";
  const { impact, texts, work, contextsChecked } = data, others = impact.claims.filter(item => item.id !== view.ref.id);
  const named = others.filter(item => texts[item.id]), unnamed = others.length - named.length;
  const row = (label: string, value: string) => `<dt>${e(label)}</dt><dd>${value}</dd>`;
  const items = named.map(item => memoryFrame(texts[item.id]!)).join("");
  const unknownWork = impact.contexts.length > contextsChecked ? `<p class="s-note">${tr("s14.memory.impact.work_more")} ${impact.contexts.length - contextsChecked}</p>` : "";
  return `<section class="s-stack" aria-labelledby="s14-impact"><h3 class="s-section-t" id="s14-impact">${tr("s14.memory.impact.title")}</h3><dl class="s-kv">${row(tr("s14.memory.impact.claims"), `${impact.claims.length}`)}${row(tr("s14.memory.impact.sources"), `${impact.sources.length}`)}${row(tr("s14.memory.impact.contexts"), `${impact.contexts.length}`)}${row(tr("s14.memory.impact.work"), `${work.length}`)}${row(tr("s14.memory.impact.reports"), `${impact.reports.length}`)}${row(tr("s14.memory.impact.files"), `${impact.artifacts.length}`)}${row(tr("s14.memory.impact.sessions"), tr("s14.memory.impact.native"))}</dl>
    ${items ? `<div class="s-stack"><p class="s-exact-label">${tr("s14.memory.impact.dependents")}</p>${items}</div>` : ""}${unnamed ? `<p class="s-note">${tr("s14.memory.impact.unnamed")} ${unnamed}</p>` : ""}${work.length ? `<div><p class="s-exact-label">${tr("s14.memory.impact.work_detail")}</p><ul class="s-history">${work.map(item => `<li><a class="s-link-text" href="/work/${e(item.id)}">${e(item.title)}</a></li>`).join("")}</ul></div>` : ""}${unknownWork}${impact.reports.length ? `<div><p class="s-exact-label">${tr("s14.memory.impact.reports_detail")}</p><ul class="s-history">${impact.reports.map(item => `<li><a class="s-link-text" href="/work/${e(item.workId)}?tab=report&amp;report=${e(item.id)}">${tr("s14.tab.report")} r${item.revision}</a></li>`).join("")}</ul></div>` : ""}</section>`;
}
function shareTargets(page: S14Page, view: S14MemoryClaimView): { bot: Bot; scope: string }[] {
  return page.state.bots.filter(bot => bot.enabled && bot.id !== view.bot.id).flatMap(bot => bot.capabilities.resources.filter(scope => page.policy.resources.includes(scope)).map(scope => ({ bot, scope })));
}
function shareFields(page: S14Page, view: S14MemoryClaimView): string {
  const targets = shareTargets(page, view), options = targets.map(({ bot, scope }, index) => `<label class="s-check"><input type="radio" name="target" value="${e(bot.id)}:${e(scope)}" required${index === 0 ? " checked" : ""}><span>${e(botName(bot))} · <span class="s-mono">${e(scope)}</span></span></label>`).join("");
  return `<fieldset class="s-field"><legend>${tr("s14.memory.share.target")}</legend>${options}</fieldset><label class="s-field"><span>${tr("s14.memory.share.hours")}</span><input type="number" name="hours" min="${memoryShareHours.min}" max="${memoryShareHours.max}" value="1" required inputmode="numeric"></label>`;
}
/** The preview page's slip: what the command reaches, what it cannot reach, then the one exact-revision control. */
function actionPanel(page: S14Page, view: S14MemoryClaimView): string {
  const action = view.action; if (!action) return "";
  const available = view.lookup.state === "available" ? view.lookup : null, access = available?.access, slip = (body: string, strip: string) => `<article class="s-slip" aria-label="${tr(k(`s14.memory.action.${action}`))}"><div class="s-slip-hd"><div><h2 id="slip" tabindex="-1" data-focus-on-load>${tr(k(`s14.memory.confirm.${action}`))}</h2><p class="s-meta">${tr("s14.memory.confirm.exact")} ${refText(view.ref)}</p></div></div><div class="s-slip-body">${body}</div>${strip}</article>`;
  if (action === "correct") {
    if (!available) return "";
    const field = `<label class="s-field"><span>${tr("s14.memory.correct.text")}</span><textarea name="text" required maxlength="2048">${e(view.draft || available.claim.text)}</textarea></label>`;
    return slip(`${reach(["s14.memory.correct.does_1", "s14.memory.correct.does_2", "s14.memory.correct.does_3"], ["s14.memory.correct.not_1", "s14.memory.reach.external", "s14.memory.reach.native"])}${impactBlock(view)}`, ownerStrip(memoryForm(page, "memory-correct", view, view.ref.revision, tr("s14.memory.action.correct"), "s-btn primary", field), tr("s14.memory.correct.note")));
  }
  if (action === "forget") {
    if (!available) return "";
    return slip(`${reach(["s14.memory.forget.does_1", "s14.memory.forget.does_2", "s14.memory.forget.does_3"], ["s14.memory.forget.not_1", "s14.memory.reach.external", "s14.memory.reach.native", "s14.memory.forget.not_2"])}${impactBlock(view)}`, ownerStrip(memoryForm(page, "memory-forget", view, view.ref.revision, tr("s14.memory.action.forget"), "s-btn danger"), tr("s14.memory.forget.note")));
  }
  if (action === "delete") {
    if (!view.impact || view.gone?.modes.includes("deleted")) return "";
    return slip(`${reach(["s14.memory.delete.does_1", "s14.memory.delete.does_2", "s14.memory.delete.does_3"], ["s14.memory.reach.external", "s14.memory.reach.native", "s14.memory.delete.not_1", "s14.memory.delete.not_2"])}${impactBlock(view)}`, ownerStrip(memoryForm(page, "memory-delete", view, view.ref.revision, tr("s14.memory.action.delete"), "s-btn danger"), tr("s14.memory.delete.note")));
  }
  if (!available || !access) return "";
  if (action === "publish") {
    const dependencies = view.privateDependencies ? banner("warn", tr("s14.memory.publish.private_deps"), `${tr("s14.memory.publish.private_deps_detail")} ${view.privateDependencies}`) : "";
    return access.shared ? "" : slip(`${dependencies}${reach(["s14.memory.publish.does_1", "s14.memory.publish.does_2"], ["s14.memory.publish.not_1", "s14.memory.publish.not_2"])}`, ownerStrip(memoryForm(page, "memory-publish", view, access.revision, `${tr("s14.memory.action.publish")} r${access.revision + 1}`, "s-btn primary"), tr("s14.memory.publish.note")));
  }
  if (action === "revoke") {
    const live = view.shares.filter(share => share.active).length;
    return !access.shared && !live ? "" : slip(reach(["s14.memory.revoke.does_1", "s14.memory.revoke.does_2"], ["s14.memory.revoke.not_1"]), ownerStrip(memoryForm(page, "memory-revoke", view, access.revision, `${tr("s14.memory.action.revoke")} r${access.revision + 1}`, "s-btn danger"), tr("s14.memory.revoke.note")));
  }
  const body = reach(["s14.memory.share.does_1", "s14.memory.share.does_2"], ["s14.memory.share.not_1", "s14.memory.share.not_2", "s14.memory.share.not_3"]);
  if (!shareTargets(page, view).length) return slip(`${banner("", tr("s14.memory.share.none"), tr("s14.memory.share.none_detail"))}${body}`, "");
  return slip(body, ownerStrip(memoryForm(page, "memory-share", view, access.revision, tr("s14.memory.share.submit"), "s-btn primary", shareFields(page, view)), tr("s14.memory.share.note")));
}
function relatedRows(page: S14Page, view: S14MemoryClaimView, refs: MemoryRef[], title: string, note: string): string {
  if (!refs.length) return "";
  const row = (ref: MemoryRef) => { const item: MemoryLookup | undefined = view.related[ref.id]; return `<li class="s-stack"><a class="s-link-text" href="${claimHref(view.bot.id, ref)}">${refText(ref)}</a>${item?.state === "available" ? memoryFrame(item.claim.text) : `<p class="s-sub">${tr("s14.memory.gone.unavailable_detail")}</p>`}</li>`; };
  return `<section class="s-card s-stack"><h2>${e(title)}</h2><p class="s-sub">${e(note)}</p><ul class="s-history">${refs.map(row).join("")}</ul></section>`;
}
function historyRows(view: S14MemoryClaimView): string {
  if (!view.history.length) return "";
  return `<section class="s-card s-stack"><h2>${tr("s14.memory.history")}</h2><ul class="s-history">${view.history.map(item => `<li><p>r${item.revision} · ${tr(item.shared ? "s14.memory.scope.shared" : "s14.memory.scope.private_plain")}${item.publishedBy ? ` · ${tr("s14.memory.history.owner")}` : ` · ${tr("s14.memory.history.created")}`}</p><p class="s-meta">${when(item.changedAt)}</p></li>`).join("")}</ul></section>`;
}
function shareRows(page: S14Page, view: S14MemoryClaimView): string {
  if (!view.shares.length) return "";
  return `<section class="s-card s-stack"><h2>${tr("s14.memory.shares")}</h2><ul class="s-history">${view.shares.map(share => `<li><p>${e(nameOf(page, share.receiverBotId))} · <span class="s-mono">${e(share.id)}</span> · ${pill(tr(share.active && share.expiresAt > page.now ? "s14.memory.share.active" : "s14.memory.share.closed"))}</p><p class="s-meta">${tr("s14.memory.share.until")} ${when(share.expiresAt)}</p></li>`).join("")}</ul><p class="s-note">${tr("s14.memory.share.recall")}</p></section>`;
}
function sourceBlock(view: S14MemoryClaimView): string {
  const item = view.source;
  if (!item) return `<section class="s-stack"><p class="s-exact-label">${tr("s14.memory.source")}</p><p class="s-sub">${tr("s14.memory.source_old")}</p></section>`;
  return `<section class="s-stack"><p class="s-exact-label">${tr("s14.memory.source")} · ${tr(k(`s14.memory.attribution.${item.source.attribution}`))} · ${refText(item.source)}</p>${item.source.text === null ? banner("", tr("s14.memory.source_gone_title"), tr("s14.memory.source_gone")) : untrusted(`<p>${e(item.source.text)}</p>`, sourceLabel(item.source))}</section>`;
}
function claimPage(page: S14Page, view: S14MemoryClaimView): string {
  const back = `<p><a class="s-link-text" href="/memory?scope=${e(view.bot.id)}">${tr("s14.memory.back")}</a></p>`, panel = actionPanel(page, view);
  if (view.lookup.state !== "available") {
    const word = view.gone ? goneWords(view.gone) : "unavailable", deletable = view.lookup.reason === "memory_withdrawn" && !view.gone?.modes.includes("deleted");
    const link = deletable && !panel ? `<div class="s-slip" data-state="closed">${ownerStrip(`<a class="s-btn danger" href="${claimHref(view.bot.id, view.ref, "delete")}">${tr("s14.memory.action.delete")}</a>`, tr("s14.memory.gone.delete_note"))}</div>` : "";
    return shell(page, tr("s14.memory.claim_title"), `<div class="s-col">${notice(view.notice)}<article class="s-card s-stack"><div class="s-mem-hd">${pill(tr(k(`s14.memory.gone.${word}`)))}${refText(view.ref)}</div><p class="s-sub">${tr(k(`s14.memory.gone.${word}_detail`))}</p>${view.gone?.source ? sourceBlock(view) : ""}</article>${panel}${link}${back}</div>`, { current: "memory" });
  }
  const { claim, access } = view.lookup, row = { claim, access }, href = (action: S14MemoryAction) => claimHref(claim.botId, claim, action);
  const actions = `<a class="s-btn" href="${href("correct")}">${tr("s14.memory.action.correct")}</a><a class="s-btn" href="${href("forget")}">${tr("s14.memory.action.forget")}</a><a class="s-btn danger" href="${href("delete")}">${tr("s14.memory.action.delete")}</a><a class="s-btn" href="${href(access.shared ? "revoke" : "publish")}">${tr(access.shared ? "s14.memory.action.revoke" : "s14.memory.action.publish")}</a><a class="s-btn" href="${href("share")}">${tr("s14.memory.action.share")}</a>`;
  const quote = claim.quote !== claim.text ? `<div><p class="s-exact-label">${tr("s14.memory.quote")}</p><pre class="s-exact">${e(claim.quote)}</pre></div>` : "";
  const summary = `<article class="s-slip" data-state="closed" aria-label="${tr("s14.memory.claim")} r${claim.revision}"><div class="s-slip-hd"><div class="s-mem-hd">${kindPill(claim.kind)}${scopePill(page, row)}</div></div><div class="s-slip-body">${memoryFrame(claim.text)}${quote}<dl class="s-kv"><dt>${tr("s14.memory.origin")}</dt><dd>${e(nameOf(page, claim.botId))}</dd><dt>${tr("s14.memory.revision")}</dt><dd>${refText(claim)}</dd><dt>${tr("s14.memory.saved")}</dt><dd>${when(claim.createdAt)}</dd><dt>${tr("s14.memory.lineage")}</dt><dd>${claim.dependencies.length}</dd></dl>${sourceBlock(view)}</div>${view.action ? "" : ownerStrip(actions, tr("s14.memory.actions_note"))}</article>`;
  const dependencies = relatedRows(page, view, claim.dependencies, tr("s14.memory.dependencies"), tr("s14.memory.dependencies_note"));
  const conflicts = relatedRows(page, view, claim.conflicts, tr("s14.memory.conflicts_title"), tr("s14.memory.conflicts_note"));
  return shell(page, tr("s14.memory.claim_title"), `<div class="s-col">${notice(view.notice)}${panel}${summary}${conflicts}${dependencies}${historyRows(view)}${shareRows(page, view)}${back}</div>`, { current: "memory" });
}
function sourcePage(page: S14Page, view: S14MemorySourceView): string {
  const { source, modes } = view.source, status = sourceStatus(view.source);
  const body = source.text === null ? banner("", tr("s14.memory.source_gone_title"), tr("s14.memory.source_gone")) : untrusted(`<p>${e(source.text)}</p>`, sourceLabel(source));
  const forgotten = source.text !== null && modes.includes("forgotten") ? banner("", tr("s14.memory.gone.forgotten"), tr("s14.memory.source_forgotten")) : "";
  return shell(page, tr("s14.memory.source_title"), `<div class="s-col">${forgotten}<article class="s-card s-stack"><div class="s-mem-hd">${pill(tr(k(`s14.memory.attribution.${source.attribution}`)))}${status}${refText(source)}</div>${body}<dl class="s-kv"><dt>${tr("s14.memory.origin")}</dt><dd>${e(botName(view.bot))}</dd><dt>${tr("s14.memory.saved")}</dt><dd>${when(source.createdAt)}</dd><dt>${tr("s14.memory.lineage")}</dt><dd>${source.derived.length}</dd></dl></article>${view.rows.length ? `<section class="s-stack"><h2 class="s-section-t">${tr("s14.memory.from_source")}</h2>${view.rows.map(row => claimRow(page, row, view.bot)).join("")}</section>` : ""}<p><a class="s-link-text" href="/memory?scope=${e(view.bot.id)}">${tr("s14.memory.back")}</a></p></div>`, { current: "memory" });
}
/** Renders the memory surfaces; all memory and source text sits in a labelled frame and no text reaches a control. */
export function renderMemorySurface(page: S14Page, view: S14MemoryBrowse | S14MemoryClaimView | S14MemorySourceView): string {
  return view.kind === "memory" ? browsePage(page, view) : view.kind === "memory-claim" ? claimPage(page, view) : sourcePage(page, view);
}
